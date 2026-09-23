/**
 * Stage 2: refine fingerprint-localised assets to precise cut points.
 *
 * Fingerprints give position to ~1-2s. This stage takes those estimates and
 * measures the asset exactly, using the chroma similarity profile:
 *
 *   1. Re-lock the offset per episode by maximising chroma similarity over a
 *      small search window around the fingerprint's estimate.
 *   2. Read the extent off the profile where it crosses a threshold. On this
 *      corpus that boundary is a cliff (0.99 inside, 0.07 outside), so the cut
 *      point is well determined.
 *
 * Extents are measured PER EPISODE rather than copied from the reference. If an
 * asset is trimmed differently in one episode, that episode's profile simply
 * goes quiet earlier, and its own extent reflects that.
 *
 * Pure JS, browser-portable.
 */

import { profile, smooth, meanOf, frameSim } from './chroma.mjs';

/**
 * @param {Map<string, {C, nFrames, frameRate, duration}>} chromas
 * @param {object} asset  a candidate from discover()
 * @returns {object|null} asset with refined per-episode start/end/span
 */
export function refineAsset(chromas, asset, opts = {}) {
  const {
    thr = 0.95,          // similarity threshold defining "inside the asset"
    smoothFrames = 8,    // ~0.5s moving average, suppresses single-frame chatter
    searchSec = 6,       // offset search half-width around the fingerprint guess
    padSec = 5,          // profile context on each side
    shrink = 0.15,       // core used for offset search, shrunk to stay inside
    minSpanSec = 2,
    boundary = 'threshold', // 'threshold' | 'gradient'
    gradSmooth = 4,
    extent = 'envelope',     // 'perEpisode' | 'envelope'
    // The envelope needs enough samples to be robust: with only a handful of
    // pairs the percentiles are noisy and it over-extends (measured: 6 episodes
    // -> span 13.2s and starts 2.8s off, vs 0.86s on 19). Below this many
    // refined pairs we fall back to per-episode extents.
    minPairsForEnvelope = 8,
    padStart = 0,            // safety margin, seconds, for cutting
    padEnd = 0,
    // Confirm presence in stage 2: an episode whose chroma similarity inside the
    // asset is below this is treated as genuinely lacking the asset.
    minSim = 0.5,
  } = opts;

  const refEntry = asset.episodes.find((e) => e.id === asset.referenceId);
  const refCh = chromas.get(asset.referenceId);
  if (!refEntry || !refCh) return null;

  const fps = refCh.frameRate;
  const fpA = refEntry.start, fpB = refEntry.end;
  if (!(fpB > fpA)) return null;

  const coreA = Math.round((fpA + (fpB - fpA) * shrink) * fps);
  const coreB = Math.round((fpB - (fpB - fpA) * shrink) * fps);
  const searchF = Math.round(searchSec * fps);
  const padF = Math.round(padSec * fps);
  const refLo = Math.max(0, Math.round(fpA * fps) - padF);
  const refHi = Math.min(refCh.nFrames, Math.round(fpB * fps) + padF);

  const perEp = [];
  const dumps = [];
  for (const ep of asset.episodes) {
    if (ep.id === asset.referenceId) continue;
    if (ep.present === false) {
      // stage 1 already concluded this episode lacks the asset; don't invent one
      perEp.push({ id: ep.id, present: false, start: null, end: null, span: 0,
                   sim: 0, refined: false });
      continue;
    }
    const ch = chromas.get(ep.id);
    if (!ch) continue;

    // --- 1. re-lock the offset ---
    const dEst = Math.round((ep.start - fpA) * fps);
    let bestD = dEst, bestMean = -Infinity;
    for (let d = dEst - searchF; d <= dEst + searchF; d++) {
      let s = 0, n = 0;
      for (let t = coreA; t < coreB; t++) {
        const j = t + d;
        if (j < 0 || j >= ch.nFrames) continue;
        s += frameSim(refCh.C, t, ch.C, j);
        n++;
      }
      const m = n ? s / n : -Infinity;
      if (m > bestMean) { bestMean = m; bestD = d; }
    }

    // --- 2. read the extent off the profile ---
    const raw = profile(refCh.C, refCh.nFrames, ch.C, ch.nFrames, bestD, refLo, refHi);
    const sm = smooth(raw, smoothFrames);
    if (opts.debugId === ep.id) {
      dumps.push({ id: ep.id, refLo, fps, raw: Array.from(raw), sm: Array.from(sm), d: bestD, fpStart: ep.start });
    }

    // Longest run above threshold, relaxing the threshold if a strict one
    // finds nothing. A fixed high threshold gives crisp boundaries on
    // well-matched pairs but fails outright on pairs whose similarity is a
    // little lower (measured: one episode produced no run at all at 0.90).
    let runBest = 0, runStart = -1;
    const minRun = Math.max(2, Math.round(minSpanSec * fps));
    for (const th of [thr, thr - 0.08, thr - 0.16]) {
      let cur = 0, curStart = -1, rb = 0, rs = -1;
      for (let i = 0; i < sm.length; i++) {
        if (sm[i] > th) {
          if (cur === 0) curStart = i;
          cur++;
          if (cur > rb) { rb = cur; rs = curStart; }
        } else cur = 0;
      }
      if (rb >= minRun) { runBest = rb; runStart = rs; break; }
      if (rb > runBest) { runBest = rb; runStart = rs; }
    }

    // Boundary strategy.
    //  - 'threshold': longest run above a fixed similarity (crisp, but a
    //    partial-similarity lead-in makes it start early, and the threshold
    //    fights itself between a clean start and a full span).
    //  - 'gradient': threshold-free; the steepest rise/drop around the peak
    //    marks the edges, which is what a cliff-like transition actually is.
    let t0, t1;
    if (boundary === 'gradient') {
      const g = new Float32Array(sm.length);
      for (let i = 0; i + 1 < sm.length; i++) g[i] = sm[i + 1] - sm[i];
      const gs = smooth(g, gradSmooth);
      let pk = 0;
      for (let i = 1; i < sm.length; i++) if (sm[i] > sm[pk]) pk = i;
      let si = 0, sBest = -Infinity;
      for (let i = 0; i <= pk; i++) if (gs[i] > sBest) { sBest = gs[i]; si = i; }
      let ei = sm.length - 1, eBest = Infinity;
      for (let i = pk; i < sm.length; i++) if (gs[i] < eBest) { eBest = gs[i]; ei = i; }
      t0 = refLo + si;
      t1 = refLo + ei + 1;
      if (opts.debugId === ep.id) dumps[0].bounds = { si, ei, pk, sBest, eBest };
    } else {
      if (runBest === 0) {
        perEp.push({ id: ep.id, start: ep.start, end: ep.end, span: ep.end - ep.start,
                     sim: 0, refined: false, offsetShift: 0, present: true });
        continue;
      }
      t0 = refLo + runStart;
      t1 = refLo + runStart + runBest - 1;
    }
    if (t1 <= t0) {
      perEp.push({ id: ep.id, start: ep.start, end: ep.end, span: ep.end - ep.start,
                   sim: 0, refined: false, offsetShift: 0 });
      continue;
    }
    const inside = raw.subarray(t0 - refLo, t1 - refLo);
    const s = (t0 + bestD) / fps - padStart;
    const e = (t1 + bestD) / fps + padEnd;
    if (e - s < minSpanSec) {
      perEp.push({ id: ep.id, start: ep.start, end: ep.end, span: ep.end - ep.start,
                   sim: 0, refined: false, offsetShift: 0, present: true });
      continue;
    }
    const sim = meanOf(inside);
    if (sim < minSim) {
      perEp.push({ id: ep.id, present: false, start: null, end: null, span: 0,
                   sim, refined: false });
      continue;
    }
    perEp.push({
      id: ep.id,
      present: true,
      start: s,
      end: e,
      span: e - s,
      sim,
      refined: true,
      refStart: t0 / fps,
      refEnd: t1 / fps,
      refStartF: t0,
      refEndF: t1,
      d: bestD,
      offsetShift: (bestD - dEst) / fps,
    });
  }

  if (!perEp.length) return null;

  // Canonical extent from a robust envelope across all pairs.
  //
  // A single reference under-measures the asset: if that one episode's theme
  // tail or intro differs, its profile goes quiet early and the extent comes up
  // short (measured: end error ~2.7s versus ~0.9s for starts). Taking a high
  // percentile of the per-pair end and a low percentile of the per-pair start
  // recovers the full extent that most pairs agree on.
  const refined = perEp.filter((x) => x.refined && x.present !== false);
  // If chroma cannot confirm a single episode, the candidate was a fingerprint
  // artefact. Drop it rather than reporting an unconfirmed asset.
  if (!refined.length) return null;
  const pct = (arr, q) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  };
  let envStartF = null, envEndF = null;
  if (extent === 'envelope' && refined.length >= minPairsForEnvelope) {
    envStartF = pct(refined.map((x) => x.refStartF), 0.10);
    envEndF = pct(refined.map((x) => x.refEndF), 0.90);
    for (const x of refined) {
      x.start = (envStartF + x.d) / fps;
      x.end = (envEndF + x.d) / fps;
      x.span = x.end - x.start;
    }
  }

  // reference episode: consensus of the extents measured by every other episode
  const rs = refined.map((x) => x.refStart).sort((a, b) => a - b);
  const re = refined.map((x) => x.refEnd).sort((a, b) => a - b);
  // the reference participates in its own envelope rather than getting a
  // separately-derived median, so every episode shares one canonical extent
  const refStart = envStartF !== null ? envStartF / fps : (rs.length ? rs[rs.length >> 1] : fpA);
  const refEnd = envEndF !== null ? envEndF / fps : (re.length ? re[re.length >> 1] : fpB);
  const refSim = refined.map((x) => x.sim).sort((a, b) => a - b);

  const episodes = [
    ...perEp,
    { id: asset.referenceId, present: true, start: refStart, end: refEnd, span: refEnd - refStart,
      sim: refSim.length ? refSim[refSim.length >> 1] : 0, refined: true, isReference: true },
  ];
  // present first, then by position; absent episodes carry no position
  episodes.sort(
    (a, b) =>
      (a.present === false ? 1 : 0) - (b.present === false ? 1 : 0) ||
      (a.start ?? 0) - (b.start ?? 0)
  );

  const present = episodes.filter((e) => e.present !== false);
  const absent = episodes.filter((e) => e.present === false).map((e) => e.id);
  const spans = present.map((e) => e.span).sort((a, b) => a - b);
  const meanStart = present.length
    ? present.reduce((s, e) => s + e.start, 0) / present.length
    : 0;
  const total = asset.totalEpisodes ?? episodes.length;

  return {
    ...asset,
    episodes,
    absent,
    support: present.length,
    supportFraction: present.length / total,
    totalEpisodes: total,
    span: spans.length ? spans[spans.length >> 1] : 0,
    meanStart,
    refinedCount: perEp.filter((x) => x.refined).length,
    unrefinedCount: perEp.filter((x) => !x.refined).length,
    meanSim: refSim.length ? refSim[refSim.length >> 1] : 0,
    medianOffsetShift: (() => {
      const sh = refined.map((x) => Math.abs(x.offsetShift)).sort((a, b) => a - b);
      return sh.length ? sh[sh.length >> 1] : 0;
    })(),
    debugProfiles: dumps,
  };
}
