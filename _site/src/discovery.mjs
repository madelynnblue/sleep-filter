import { makeFFT, realSpectrum } from './fft.mjs';
export { makeFFT, realSpectrum };

/**
 * Multi-asset discovery by landmark-fingerprint offset consensus.
 *
 * Core idea
 * ---------
 * Build Shazam-style landmark hashes for every episode, then apply TWO filters,
 * because either alone is insufficient:
 *
 *   1. Document frequency. A hash appearing in one episode is dialogue; one
 *      appearing in most episodes is a candidate recurring asset.
 *
 *   2. Offset consensus (the discriminative one). For a reference episode and
 *      each other episode, histogram delta = t_ref - t_other over shared
 *      hashes. A genuine shared asset lands as a tall spike in a single bin;
 *      common musical patterns, room tone and reused stings recur at random
 *      offsets and smear across the histogram instead.
 *
 * Multiple assets fall out for free: each spike is a different asset. That is
 * why multi-asset support is structural rather than bolted on.
 *
 * Reference selection
 * -------------------
 * The consensus test is measured *against a reference episode*, so a single
 * atypical episode as reference breaks everything. Measured: with S01E01 as
 * reference the title theme is the global maximum delta bin in 16 of 18 pairs
 * (109-438 votes against a ~18 noise threshold); with S02E03 -- whose theme was
 * independently found to be atypical -- the theme bin collapses to 3 votes.
 *
 * A medoid over the recurring set does NOT fix this: that set is dominated by
 * common audio, so the medoid can be typical for ambience and atypical for the
 * asset. Instead we try several candidate references and keep the run whose
 * best asset is strongest. Everything after fingerprinting is cheap, so this
 * costs seconds.
 *
 * Pure JS, browser-portable: no Node APIs, no dependencies.
 */

/* --------------------------------------------------------- fingerprint -- */

/**
 * Landmark-fingerprint one episode.
 * @returns {{hashTimes: Map<number, number[]>, frameRate, duration, stats}}
 *   hashTimes maps hash -> array of anchor frame indices.
 */
export function fingerprint(samples, opts = {}) {
  const {
    sampleRate = 8000,
    nfft = 1024,
    hop = 512,
    maxFreqHz = 4000,
    peaksPerFrame = 3,
    maxTargets = 4,
    minDt = 1,
    maxDt = 32,
    freqQuant = 2,
    silenceDb = -50,
    maxTimesPerHash = 8,
  } = opts;

  const T = makeFFT(nfft);
  const maxBin = Math.min(T.half, Math.round((maxFreqHz * nfft) / sampleRate));
  const nFrames = Math.max(0, Math.floor((samples.length - nfft) / hop) + 1);
  const win = new Float32Array(nfft);
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nfft - 1));

  const re = new Float32Array(nfft);
  const magAll = new Float32Array(T.half + 1);
  const powerAll = new Float32Array(T.half + 1);
  const scratch = new Float32Array(nfft);

  const frameMag = (t) => {
    const off = t * hop;
    let energy = 0;
    for (let i = 0; i < nfft; i++) {
      const v = samples[off + i] * win[i];
      re[i] = v; energy += v * v;
    }
    if (20 * Math.log10(Math.sqrt(energy / nfft) + 1e-12) < silenceDb) return null;
    realSpectrum(re, T, magAll, powerAll, scratch);
    // the ring keeps three frames alive at once, so this one has to be its own
    // copy rather than a view of the shared scratch
    const m = new Float32Array(maxBin + 1);
    m.set(magAll.subarray(0, maxBin + 1));
    return m;
  };

  const ringSize = maxDt + 1;
  const peaksRing = new Array(ringSize).fill(null);
  const hashTimes = new Map();
  let m2 = null, m1 = null, picked = 0, totalPairs = 0;

  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const tickEvery = Math.max(1, Math.floor(nFrames / 100));

  for (let i = 0; i < nFrames + 1; i++) {
    if (onProgress && i % tickEvery === 0) onProgress(i / (nFrames + 1));
    const m0 = i < nFrames ? frameMag(i) : null;
    const centre = i - 1;

    if (centre >= 0 && m1) {
      const cand = [];
      for (let k = 1; k < m1.length - 1; k++) {
        const v = m1[k];
        if (v <= m1[k - 1] || v < m1[k + 1]) continue;
        if (m2 && k < m2.length && v < m2[k]) continue;
        if (m0 && k < m0.length && v < m0[k]) continue;
        cand.push(k);
      }
      cand.sort((a, b) => m1[b] - m1[a]);
      const kept = cand.slice(0, peaksPerFrame).map((k) => ({ bin: k, mag: m1[k] }));
      picked += kept.length;
      peaksRing[centre % ringSize] = kept;
    }

    const anchor = centre - maxDt;
    if (anchor >= 0) {
      const aPeaks = peaksRing[anchor % ringSize];
      if (aPeaks && aPeaks.length) {
        // One strongest target per dt, then keep the strongest few. Guaranteeing
        // distinct dt values maximises use of the hash space (collapsing dt would
        // shrink the space and manufacture false "recurring" collisions).
        const perDt = [];
        for (let dt = minDt; dt <= maxDt; dt++) {
          const tp = peaksRing[(anchor + dt) % ringSize];
          if (!tp || !tp.length) continue;
          let best = tp[0];
          for (const p of tp) if (p.mag > best.mag) best = p;
          perDt.push({ bin: best.bin, mag: best.mag, dt });
        }
        perDt.sort((a, b) => b.mag - a.mag);
        const targets = perDt.slice(0, maxTargets);
        for (const p1 of aPeaks) {
          const q1 = Math.round(p1.bin / freqQuant);
          for (const p2 of targets) {
            const q2 = Math.round(p2.bin / freqQuant);
            const h = ((q1 * 1024 + q2) * 64 + p2.dt) >>> 0;
            let arr = hashTimes.get(h);
            if (!arr) { arr = []; hashTimes.set(h, arr); }
            if (arr.length < maxTimesPerHash) arr.push(anchor);
            totalPairs++;
          }
        }
      }
    }
    m2 = m1; m1 = m0;
  }

  onProgress?.(1);
  return {
    hashTimes,
    frameRate: sampleRate / hop,
    duration: samples.length / sampleRate,
    stats: { nFrames, peaks: picked, pairs: totalPairs, hashes: hashTimes.size },
  };
}

/* ----------------------------------------------------------- discovery -- */

/**
 * Label an asset by WHERE it sits and how long it is — never by what it sounds
 * like. 'title-theme' means "averages a start in the first third and runs under
 * 90s", which is where a title theme usually is; a recurring cue that happens to
 * land there gets the same label, and a real theme after a long cold open lands
 * in 'other-recurring' instead.
 *
 * These are display names, not assertions. Ranking does not use them by default
 * (rankBy defaults to 'support'), and the UI lets the user audition every clip
 * and decide for themselves.
 */
function classify(meanStart, duration, span) {
  if (meanStart > duration * 0.85) return 'end-credits';
  if (span < 4) return 'sting';
  if (meanStart < duration * 0.35 && span <= 90) return 'title-theme';
  return 'other-recurring';
}

const KIND_PRIORITY = { 'title-theme': 0, 'end-credits': 1, 'other-recurring': 2, sting: 3 };

/**
 * Smallest window containing `frac` of the votes.
 *
 * Taking min/max of the contributing times is not robust: a couple of stray
 * votes (from a common pattern that happens to line up) stretched every extent
 * to cover the whole episode. The densest window is the actual asset.
 */
function robustSpan(times, frac = 0.85) {
  const t = times.slice().sort((a, b) => a - b);
  const n = t.length;
  if (!n) return null;
  if (n < 4) return { start: t[0], end: t[n - 1], span: t[n - 1] - t[0], used: n };
  const k = Math.max(2, Math.floor(frac * n));
  let bestI = 0, bestW = Infinity;
  for (let i = 0; i + k <= n; i++) {
    const w = t[i + k - 1] - t[i];
    if (w < bestW) { bestW = w; bestI = i; }
  }
  return { start: t[bestI], end: t[bestI + k - 1], span: bestW, used: k };
}

/** Candidate reference indices: medoid, most hashes, plus spread picks. */
function chooseReferences(maps, episodes, k) {
  const n = maps.length;
  const out = [];
  const push = (i) => { if (i >= 0 && i < n && !out.includes(i)) out.push(i); };

  push(episodes.findIndex((e) => e.referenceHint === true)); // explicit hint wins
  let bestMedoid = 0, bestScore = -1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const [small, big] = maps[i].size <= maps[j].size ? [maps[i], maps[j]] : [maps[j], maps[i]];
      for (const h of small.keys()) if (big.has(h)) s++;
    }
    if (s > bestScore) { bestScore = s; bestMedoid = i; }
  }
  push(bestMedoid);
  let mostHashes = 0;
  for (let i = 1; i < n; i++) if (maps[i].size > maps[mostHashes].size) mostHashes = i;
  push(mostHashes);
  for (let t = 1; t < k; t++) push(Math.round((t * n) / k) % n);
  for (let i = 0; i < n && out.length < k; i++) push(i);
  return out.slice(0, k);
}

/** Run the consensus test with a given reference and aggregate into assets. */
function extractForReference(episodes, maps, ref, cfg) {
  const { minVotes, refineFrames, minDensity, minSupport, maxPeaksPerPair, absentVoteFrac,
          maxOccurrenceSeconds } = cfg;
  const N = episodes.length;
  const refEp = episodes[ref];
  const peaks = [];

  for (let j = 0; j < N; j++) {
    if (j === ref) continue;
    const jMap = maps[j];
    // delta bin -> Map(hash -> [tRef, tOther]).
    // Counting DISTINCT hashes matters: one repetitive hash can contribute many
    // (ta,tb) pairs to the same bin and fake a huge peak.
    const bins = new Map();
    for (const [h, tsRef] of maps[ref]) {
      const tsJ = jMap.get(h);
      if (!tsJ) continue;
      for (const ta of tsRef) {
        for (const tb of tsJ) {
          const d = ta - tb;
          let m = bins.get(d);
          if (!m) { m = new Map(); bins.set(d, m); }
          if (!m.has(h)) m.set(h, [ta, tb]);
        }
      }
    }

    // Adaptive threshold. An absolute minVotes is meaningless across corpora:
    // with 19 episodes the per-bin noise floor sat well above it and every bin
    // looked like a peak, so require a bin to stand out from its own histogram.
    let dmin = Infinity, dmax = -Infinity, total = 0;
    for (const [d, m] of bins) {
      if (d < dmin) dmin = d;
      if (d > dmax) dmax = d;
      total += m.size;
    }
    const nBins = Math.max(dmax - dmin + 1, 1);
    const mean = total / nBins;
    const thr = Math.max(minVotes, mean + 5 * Math.sqrt(mean));

    // Only the strongest few bins per pair. Real assets are found by consensus
    // across episodes, so a stray peak from one atypical pair cannot reach the
    // support threshold on its own.
    const ranked = [...bins.entries()]
      .filter(([, m]) => m.size >= thr)
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, maxPeaksPerPair);

    const taken = [];
    for (const [d, m] of ranked) {
      if (taken.some((t) => Math.abs(t - d) <= refineFrames * 2)) continue;
      taken.push(d);
      const members = new Map();
      for (let dd = d - refineFrames; dd <= d + refineFrames; dd++) {
        const m2 = bins.get(dd);
        if (!m2) continue;
        for (const [h, pair] of m2) if (!members.has(h)) members.set(h, pair);
      }
      const tRefs = [], tJs = [];
      for (const [, pair] of members) { tRefs.push(pair[0]); tJs.push(pair[1]); }
      const rs = robustSpan(tRefs);
      const os = robustSpan(tJs);
      if (!rs || !os) continue;
      peaks.push({
        refId: refEp.id,
        otherId: episodes[j].id,
        otherIndex: j,
        delta: d / refEp.frameRate,
        votes: members.size,
        threshold: thr,
        tRefStart: rs.start / refEp.frameRate,
        tRefEnd: rs.end / refEp.frameRate,
        tOtherStart: os.start / episodes[j].frameRate,
        tOtherEnd: os.end / episodes[j].frameRate,
      });
    }
  }

  // ---- aggregate peaks into assets ----
  // Group by OVERLAP of the reference span, not by proximity of the start.
  // Proximity chained: peaks at 2:31, 2:34, 2:37 ... each within tolerance of
  // the running minimum, which merged unrelated cues into one giant asset.
  const sorted = peaks.slice().sort((a, b) => b.votes - a.votes);
  const assets = [];
  for (const p of sorted) {
    const pSpan = p.tRefEnd - p.tRefStart;
    let a = assets.find((x) => {
      const ov = Math.min(x.refEnd, p.tRefEnd) - Math.max(x.refStart, p.tRefStart);
      return ov > 0.5 * Math.min(x.refEnd - x.refStart, pSpan);
    });
    if (!a) {
      a = { refStart: p.tRefStart, refEnd: p.tRefEnd, votes: p.votes, members: new Map() };
      assets.push(a);
    }
    const prev = a.members.get(p.otherId);
    if (!prev || p.votes > prev.votes) {
      a.members.set(p.otherId, {
        id: p.otherId, start: p.tOtherStart, end: p.tOtherEnd,
        votes: p.votes, delta: p.delta,
      });
    }
  }

  const candidates = [];
  for (const a of assets) {
    const density = a.votes / Math.max(a.refEnd - a.refStart, 0.001);
    if (density < minDensity) continue;   // scattered votes are not an asset

    const all = [...a.members.values()];
    all.push({ id: refEp.id, start: a.refStart, end: a.refEnd, votes: a.votes, delta: 0, isReference: true });
    all.sort((x, y) => x.start - y.start);

    // Presence vs absence.
    //
    // An episode that simply does NOT contain the asset still gets *some*
    // best-matching peak, so counting it as support overstates confidence and
    // its bogus span corrupts the asset's statistics. Episodes whose evidence
    // is far weaker than the median are therefore marked ABSENT and excluded
    // from every statistic, rather than handed a fabricated position.
    const vs = all.map((e) => e.votes).sort((x, y) => x - y);
    const medianVotes = vs[vs.length >> 1];
    const cutoff = Math.max(2, absentVoteFrac * medianVotes);
    // An occurrence whose matched extent is far longer than a clip was not
    // located: the votes smeared across the episode rather than clustering on
    // one asset. Marking it absent keeps it out of the asset's statistics AND
    // out of the cut. That asymmetry is the point — an episode wrongly marked
    // present loses minutes of dialogue to the cutter, while one wrongly marked
    // absent merely keeps its music.
    for (const e of all) {
      e.present = (!!e.isReference || e.votes >= cutoff) &&
                  (e.end - e.start) <= maxOccurrenceSeconds;
    }

    const present = all.filter((e) => e.present);
    const absent = all.filter((e) => !e.present);
    if (present.length < minSupport) continue;

    const spans = present.map((e) => e.end - e.start).sort((x, y) => x - y);
    const span = spans[spans.length >> 1];
    const meanStart = present.reduce((s, e) => s + e.start, 0) / present.length;
    const durs = present.map((e) => episodes.find((q) => q.id === e.id).duration).sort((x, y) => x - y);
    const meanVotes = present.reduce((s, e) => s + e.votes, 0) / present.length;

    candidates.push({
      kind: classify(meanStart, durs[durs.length >> 1], span),
      span,
      support: present.length,
      supportFraction: present.length / N,
      totalEpisodes: N,
      meanStart,
      referenceId: refEp.id,
      meanVotes,
      medianVotes,
      absent: absent.map((e) => e.id),
      episodes: all.map((e) => ({
        id: e.id,
        present: e.present,
        start: e.present ? e.start : null,
        end: e.present ? e.end : null,
        span: e.present ? e.end - e.start : 0,
        votes: e.votes,
        isReference: !!e.isReference,
      })),
    });
  }

  candidates.sort(
    (a, b) =>
      KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
      b.supportFraction - a.supportFraction ||
      b.meanVotes - a.meanVotes ||
      a.meanStart - b.meanStart
  );
  const score = candidates.length ? candidates[0].supportFraction * candidates[0].meanVotes : 0;
  return { candidates, peaks, referenceId: refEp.id, score };
}

/**
 * Discover all recurring audio assets across a set of fingerprinted episodes.
 * @param {Array<{id, hashTimes, frameRate, duration}>} episodes
 */
export function discover(episodes, opts = {}) {
  const {
    // Fraction of episodes a hash must appear in before it is even considered.
    // This is a PRE-FILTER, and it is the thing that hides partial-support
    // assets: at 0.6 a clip present in only 8 of 19 episodes is never seen.
    // Lower it to find "the N most common clips" rather than "the one asset
    // that is in everything".
    minDf = 0.2,
    // Absolute floor on how many episodes a candidate asset must appear in.
    // More interpretable than a fraction when you care about partial support.
    minSupportCount = 3,
    rankBy = 'support',   // 'support' (most common first) | 'kind' (theme first)
    maxAssets = null,     // keep only the top N candidates
    minVotes = 12,        // floor for the adaptive peak threshold
    maxOccur = 3,         // occurrences per hash used when voting
    refineFrames = 2,     // frames either side of a peak counted as the same asset
    minDensity = 4,       // votes per second inside the asset span
    // An episode is "absent" if its best evidence is weaker than this fraction
    // of the median. Resilience to a few episodes missing the asset entirely.
    absentVoteFrac = 0.25,
    // Longest a single occurrence can plausibly be. The landmark votes for one
    // occurrence normally cluster tightly — on this corpus every real theme
    // occurrence measures 11.2s — but when a small corpus lets generic content
    // clear the adaptive peak threshold, the votes smear instead and the
    // densest-85% window stretches to minutes.
    maxOccurrenceSeconds = 90,
    maxPeaksPerPair = 5,  // strongest bins considered per episode pair
    referenceTrials = 4,  // candidate references tried; best run wins
    referenceIndex = null,
  } = opts;

  const N = episodes.length;
  const minCount = Math.max(2, Math.ceil(minDf * N));

  // ---- filter 1: document frequency ----
  const df = new Map();
  for (const ep of episodes) for (const h of ep.hashTimes.keys()) df.set(h, (df.get(h) || 0) + 1);
  const recurring = new Set();
  for (const [h, c] of df) if (c >= minCount) recurring.add(h);

  const maps = episodes.map((ep) => {
    const m = new Map();
    for (const [h, ts] of ep.hashTimes) if (recurring.has(h)) m.set(h, ts.slice(0, maxOccur));
    return m;
  });

  const minSupport = Math.max(2, minSupportCount);
  const cfg = { minVotes, refineFrames, minDensity, minSupport, maxPeaksPerPair, absentVoteFrac,
                maxOccurrenceSeconds };

  const refList = referenceIndex !== null
    ? [referenceIndex]
    : chooseReferences(maps, episodes, Math.min(referenceTrials, N));

  let bestRun = null;
  const tried = [];
  for (const r of refList) {
    const run = extractForReference(episodes, maps, r, cfg);
    tried.push({ referenceId: run.referenceId, candidates: run.candidates.length, score: Number(run.score.toFixed(1)) });
    if (!bestRun || run.score > bestRun.score) bestRun = run;
  }

  // Rank. 'support' answers "what are the N most common clips?"; 'kind' biases
  // toward presenting a title theme first.
  const cands = bestRun.candidates.slice();
  if (rankBy === 'kind') {
    cands.sort(
      (a, b) =>
        KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
        b.supportFraction - a.supportFraction ||
        b.meanVotes - a.meanVotes ||
        a.meanStart - b.meanStart
    );
  } else {
    cands.sort(
      (a, b) =>
        b.supportFraction - a.supportFraction ||
        b.meanVotes - a.meanVotes ||
        a.meanStart - b.meanStart
    );
  }

  return {
    ...bestRun,
    candidates: maxAssets ? cands.slice(0, maxAssets) : cands,
    totalCandidates: cands.length,
    minCount,
    minSupport,
    rankBy,
    referenceTrials: tried,
    recurringHashes: recurring.size,
    minVotes,
  };
}

export function formatTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}
