import { makeFFT, realSpectrum } from './fft.mjs';
import { biquadBandpass, applyBiquad, movingAvgAbs, movAvgSq } from './dsp.mjs';

/**
 * Per-episode music segmentation.
 *
 * Different problem from discovery. Discovery asks "what audio repeats across
 * episodes?" and earns confidence from cross-episode consensus. This asks
 * "where is there music in THIS file?" — a classification problem with no
 * corroboration, so it can't tell you when it's wrong. It is the only method
 * that reaches music which does not repeat: credits, one-off interludes, and
 * songs used as part of the episode.
 *
 * Calibration
 * -----------
 * Instead of hand-tuned absolute thresholds (which do not transfer between
 * shows, eras or mixing styles), this calibrates on a music example the rest of
 * the pipeline already identified with high confidence: the title theme. Theme
 * frames become positives, a sample of everything else becomes negatives, and a
 * diagonal Fisher linear discriminant gives the feature weights. The detector
 * therefore adapts per show, per episode, to that show's mixing style.
 *
 * The risk is that the theme is a poor exemplar — loud, full-band, produced —
 * and other music (quiet strings under a scene, a sparse interlude) may not
 * project the same way. `calibrate()` reports its own separation so you can see
 * when it is weak, and callers should treat uncalibrated results as advisory.
 *
 * Pure JS, browser-portable.
 */

import { computeChroma, pitchClassMap, finalizeChroma } from './chroma.mjs';

export const FEATURE_NAMES = ['logRms', 'lowRatio', 'flatness', 'flux', 'mod4', 'chromaSelf'];

const NFEAT = FEATURE_NAMES.length;

/**
 * @returns {{feats: Float32Array, nFrames, frameRate, duration, logRms}}
 *   feats is flat, stride NFEAT.
 */
/** Share of computeFeatures' work spent in its chroma pass (measured, see below). */
const CHROMA_SHARE = 0.4;
/**
 * Within computeFeatures' own work: the STFT loop, then the modulation-energy and
 * chroma-self-similarity passes. That second group is ~30% of the stage and went
 * unmetered, leaving the bar motionless for the last third of a second of every
 * episode.
 */
const LOOP_SHARE = 0.70;
const MOD_SHARE = 0.98;

export function computeFeatures(samples, opts = {}) {
  const {
    sampleRate = 8000,
    nfft = 2048,
    hop = 512,
    fLow = 250,     // "bass" band edge
    chroma: providedChroma = null,
    onProgress = null,
    // Accumulate chroma in this function's own STFT pass instead of running a
    // second one. The magnitudes and the window are identical, so this is one
    // pass where there would otherwise be two.
    alsoChroma = false,
    fmin = 55,
    fmax = 4000,
    center = true,
    gateFrac = 0.02,
  } = opts;

  // chromaSelf needs a chroma pass, which is ~40% of this stage. finish()
  // already computes one for the library, so it hands that over rather than
  // paying for an identical second pass — worth about a second per 22-minute
  // episode. When this function runs one itself it reports through it, because
  // leaving that 40% unmetered is what made the bar stall in the middle.
  const half = nfft >> 1;
  const nFrames = Math.max(0, Math.floor((samples.length - nfft) / hop) + 1);
  const fps = sampleRate / hop;

  // Fused chroma accumulation, done inside this function's own STFT pass. The
  // bin order matches computeChroma exactly, so the result is bit-identical.
  const pc = alsoChroma ? pitchClassMap(half + 1, sampleRate, nfft, fmin, fmax) : null;
  const C = alsoChroma ? new Float32Array(nFrames * 12) : null;
  const norms = alsoChroma ? new Float32Array(nFrames) : null;

  // chromaSelf needs chroma. Three ways to get it: handed over, accumulated
  // here, or a pass of its own — and NOT a fourth, which is what an earlier
  // version did by accumulating it here and then also computing it separately.
  let chroma = providedChroma;
  if (chroma) {
    if (chroma.nFrames !== nFrames) {
      throw new Error('computeFeatures: provided chroma was not computed with this nfft/hop');
    }
  } else if (!alsoChroma) {
    chroma = computeChroma(samples, {
      sampleRate, nfft, hop,
      onProgress: onProgress ? (f) => onProgress(f * CHROMA_SHARE) : undefined,
    });
  }
  const base = (providedChroma || alsoChroma) ? 0 : CHROMA_SHARE;
  const report = onProgress ? (f) => onProgress(base + (1 - base) * f) : null;

  // --- one STFT pass for the spectral features ---
  const win = new Float32Array(nfft);
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nfft - 1));
  const re = new Float32Array(nfft);
  const power = new Float32Array(half + 1);
  const scratch = new Float32Array(nfft);
  const FT = makeFFT(nfft);
  const lowBin = Math.round((fLow * nfft) / sampleRate);

  const logRms = new Float32Array(nFrames);
  const lowRatio = new Float32Array(nFrames);
  const flatness = new Float32Array(nFrames);
  const flux = new Float32Array(nFrames);
  // Two magnitude buffers selected by frame parity, so the flux comparison can
  // see the previous frame without allocating. One per frame was ~4 KB x ~21k
  // frames — about 87 MB of garbage for a single 22-minute episode, and the
  // largest source of churn in the pipeline.
  const magBuf = [new Float32Array(half + 1), new Float32Array(half + 1)];

  const tickEvery = Math.max(1, Math.floor(nFrames / 100));

  for (let t = 0; t < nFrames; t++) {
    const off = t * hop;
    let energy = 0;
    for (let i = 0; i < nfft; i++) {
      const v = samples[off + i] * win[i];
      re[i] = v; energy += v * v;
    }
    logRms[t] = 20 * Math.log10(Math.sqrt(energy / nfft) + 1e-12);

    // one real-input transform, which writes both the magnitudes flux needs and
    // the powers the band sums need
    let low = 0, tot = 0, logSum = 0;
    const mag = magBuf[t & 1];
    const prevMag = t > 0 ? magBuf[(t - 1) & 1] : null;
    realSpectrum(re, FT, mag, power, scratch);
    // Two variants rather than one loop with a branch: testing `pc` per bin per
    // frame deoptimised this loop badly enough to cost more than the whole pass
    // it was meant to save.
    if (pc === null) {
      for (let k = 0; k <= half; k++) {
        const p = power[k];
        tot += p;
        if (k <= lowBin) low += p;
        logSum += Math.log(p + 1e-12);
      }
    } else {
      const cbase = t * 12;
      let ce = 0;
      for (let k = 0; k <= half; k++) {
        const p = power[k];
        tot += p;
        if (k <= lowBin) low += p;
        logSum += Math.log(p + 1e-12);
        const c = pc[k];
        if (c >= 0) { C[cbase + c] += mag[k]; ce += mag[k]; }
      }
      norms[t] = ce;
    }
    lowRatio[t] = tot > 0 ? low / tot : 0;
    // spectral flatness: geometric mean / arithmetic mean of power
    const geo = Math.exp(logSum / (half + 1));
    const arith = tot / (half + 1);
    flatness[t] = arith > 0 ? geo / arith : 0;

    if (prevMag) {
      let d = 0, s = 0;
      for (let k = 0; k <= half; k++) { d += Math.max(0, mag[k] - prevMag[k]); s += mag[k]; }
      flux[t] = s > 0 ? d / s : 0;
    }
    if (report && t % tickEvery === 0) report((t / nFrames) * LOOP_SHARE);
  }

  report?.(LOOP_SHARE);

  // --- 4 Hz modulation energy: the speech cue (Scheirer & Slaney) ---
  //
  // Speech has a strong syllable-rate envelope modulation that music lacks. The
  // feature must be computed from envelopes sampled WELL above 4 Hz: deriving it
  // from frame-rate RMS (~15.6 Hz) cannot resolve syllable rate and instead
  // measures musical beat, which inverts the sign. So: per-band envelopes at
  // 100 Hz via biquad bandpass + rectify + smooth, then bandpass the envelope
  // itself in the 3-6 Hz range and compare that energy to the envelope's total
  // AC energy.
  const ENV_HZ = 100;
  const mod4 = new Float32Array(nFrames);
  {
    const bandDefs = [[80, 300], [300, 800], [800, 2000], [2000, 4000]];
    const envs = [];
    const decim = Math.max(1, Math.round(sampleRate / ENV_HZ));
    const smoothN = Math.max(1, Math.round(0.02 * sampleRate));
    // The per-band filter passes are the bulk of this block. Reporting only at
    // its end meant one guessed share covered all of it, which is what made the
    // bar jump from ~90% to 100% in one step.
    const span = MOD_SHARE - LOOP_SHARE;
    for (const [bi, band] of bandDefs.entries()) {
      const [lo, hi] = band;
      const f0 = Math.sqrt(lo * hi);
      const c = biquadBandpass(sampleRate, f0, Math.max(0.5, f0 / (hi - lo)));
      const y = applyBiquad(samples, c);
      const sm = movingAvgAbs(y, smoothN);
      const n = Math.floor(samples.length / decim);
      const e = new Float32Array(n);
      for (let i = 0; i < n; i++) e[i] = sm[i * decim];
      envs.push(e);
      report?.(LOOP_SHARE + span * 0.85 * ((bi + 1) / bandDefs.length));
    }
    const nEnv = envs[0].length;
    const bp = biquadBandpass(ENV_HZ, 4.5, 1.2);   // passband ~3-6 Hz
    const W = Math.max(4, Math.round(1.0 * ENV_HZ));
    const acc = new Float32Array(nEnv);
    for (const e of envs) {
      let mean = 0;
      for (let i = 0; i < nEnv; i++) mean += e[i];
      mean /= Math.max(nEnv, 1);
      const dc = new Float32Array(nEnv);
      for (let i = 0; i < nEnv; i++) dc[i] = e[i] - mean;
      const band = applyBiquad(dc, bp);
      const num = movAvgSq(band, W), den = movAvgSq(dc, W);
      for (let i = 0; i < nEnv; i++) {
        acc[i] += den[i] > 1e-12 ? num[i] / den[i] : 0;
      }
    }
    for (let t = 0; t < nFrames; t++) {
      const idx = Math.min(nEnv - 1, Math.round((t / fps) * ENV_HZ));
      mod4[t] = acc[idx] / envs.length;
    }
  }

  report?.(MOD_SHARE);

  // finalise the fused chroma before anything reads it
  if (alsoChroma) finalizeChroma(C, norms, nFrames, { center, gateFrac });
  const chromaC = alsoChroma ? C : chroma.C;

  // --- chroma self-similarity: music holds harmony and repeats, speech does not ---
  const chromaSelf = new Float32Array(nFrames);
  const lags = [Math.round(0.5 * fps), Math.round(1.0 * fps), Math.round(2.0 * fps)];
  for (let t = 0; t < nFrames; t++) {
    let best = 0;
    for (const L of lags) {
      if (t + L >= nFrames) continue;
      let s = 0;
      for (let c = 0; c < 12; c++) s += chromaC[t * 12 + c] * chromaC[(t + L) * 12 + c];
      if (s > best) best = s;
    }
    chromaSelf[t] = best;
    if (report && t % tickEvery === 0) report(MOD_SHARE + (1 - MOD_SHARE) * (t / nFrames));
  }

  const feats = new Float32Array(nFrames * NFEAT);
  for (let t = 0; t < nFrames; t++) {
    const o = t * NFEAT;
    feats[o + 0] = logRms[t];
    feats[o + 1] = lowRatio[t];
    feats[o + 2] = flatness[t];
    feats[o + 3] = flux[t];
    feats[o + 4] = mod4[t];
    feats[o + 5] = chromaSelf[t];
  }

  report?.(1);
  const out = { feats, nFrames, frameRate: fps, duration: samples.length / sampleRate, logRms };
  if (alsoChroma) {
    out.chroma = { C, nFrames, frameRate: fps, duration: samples.length / sampleRate };
  }
  return out;
}

/**
 * Diagonal Fisher linear discriminant between music (positive) and non-music.
 * Returns per-feature weights, a midpoint threshold, and a separation score
 * (how many pooled standard deviations apart the classes are) so the caller can
 * tell whether the calibration is trustworthy.
 */
export function calibrate(feats, nFrames, positiveMask, opts = {}) {
  const { negSample = 4000, rng = () => 0.5 } = opts;
  const pos = [], neg = [];
  for (let t = 0; t < nFrames; t++) {
    if (positiveMask[t]) pos.push(t);
    else if (neg.length < negSample) neg.push(t);
  }
  if (pos.length < 10 || neg.length < 50) return null;

  const mean = (list) => {
    const m = new Float64Array(NFEAT);
    for (const t of list) for (let f = 0; f < NFEAT; f++) m[f] += feats[t * NFEAT + f];
    for (let f = 0; f < NFEAT; f++) m[f] /= list.length;
    return m;
  };
  const m1 = mean(pos), m0 = mean(neg);
  const w = new Float64Array(NFEAT);
  let sep = 0;
  for (let f = 0; f < NFEAT; f++) {
    let v1 = 0, v0 = 0;
    for (const t of pos) { const d = feats[t * NFEAT + f] - m1[f]; v1 += d * d; }
    for (const t of neg) { const d = feats[t * NFEAT + f] - m0[f]; v0 += d * d; }
    v1 /= pos.length; v0 /= neg.length;
    const pooled = Math.sqrt(v1 + v0) || 1e-9;
    w[f] = (m1[f] - m0[f]) / (v1 + v0 + 1e-9);
    sep += ((m1[f] - m0[f]) / pooled) ** 2;
  }
  let s1 = 0, s0 = 0;
  for (const t of pos) { let s = 0; for (let f = 0; f < NFEAT; f++) s += w[f] * feats[t * NFEAT + f]; s1 += s; }
  for (const t of neg) { let s = 0; for (let f = 0; f < NFEAT; f++) s += w[f] * feats[t * NFEAT + f]; s0 += s; }
  s1 /= pos.length; s0 /= neg.length;
  return { w, mid: (s1 + s0) / 2, posMean: s1, negMean: s0, separation: Math.sqrt(sep), posCount: pos.length, negCount: neg.length };
}

/** Score every frame with the calibrated weights. */
export function scoreFrames(feats, nFrames, cal) {
  const out = new Float32Array(nFrames);
  for (let t = 0; t < nFrames; t++) {
    let s = 0;
    for (let f = 0; f < NFEAT; f++) s += cal.w[f] * feats[t * NFEAT + f];
    out[t] = s;
  }
  return out;
}

/** Median filter, then contiguous segments above threshold. */
export function segment(scores, fps, opts = {}) {
  const {
    mid,               // decision threshold (from calibrate)
    bias = 0,          // shift the threshold; negative = more sensitive (catches more music)
    smoothFrames = 6,  // ~0.4s
    // Short runs are overwhelmingly false positives: measured on this corpus,
    // raising this from 1.5s to 4s cut non-theme flagging from 25% to 9.4%
    // while keeping theme recall at 100%. Real music cues are rarely under 4s.
    minDuration = 4.0,
    // Ceiling on one cue, as a fraction of the episode. A single cue cannot be a
    // large part of an episode, and this is the failure mode that produced
    // 658-second 'clips' in the theme stage: the discriminant misfires over a
    // long stretch and the run never closes. Relative rather than absolute so it
    // still means something on a 45-minute episode. On this corpus the longest
    // real segment is 38.7s, about 3% — so this is inert in practice and exists
    // to stop a misfire becoming a ten-minute cut.
    maxFractionOfEpisode = 0.25,
    maxGap = 0.8,      // seconds; bridge gaps up to this
    edgeFrac = 0.35,   // segment edges where the smoothed score crosses this fraction
    // Floor on a run's peak score, as a fraction of the way from the decision
    // threshold (`mid`) to the mean score of the positive exemplars (`posMean`).
    //
    // This used to be an absolute constant, and that cannot work. The score is
    // only defined up to an affine transform — where a genuine cue lands depends
    // on the weights `calibrate()` happened to fit — so a constant that meant
    // "effectively off" on one feature set sat ABOVE the theme's own mean score
    // on the next. At 0, on this corpus (posMean -0.373, mid -2.091), it silently
    // deleted real music: a 6.1s cue at 14:26 in S02E08 that cleared `mid` by
    // 1.53 and sat at the 98.8th percentile of its episode.
    //
    // Relative instead: 1 demands a cue look more musical than the theme does on
    // average, 0 disables the floor. 0.7 keeps that cue with margin while still
    // rejecting runs that barely clear the threshold.
    peakFrac = 0.7,
    posMean = null,    // the positive exemplars' mean score, from calibrate()
    minPeak = null,    // explicit absolute floor; overrides peakFrac. Tests pass -1e9.
  } = opts;

  const n = scores.length;
  const thr = mid + bias;
  // Without a calibration to measure against there is no meaningful floor, so
  // fall back to none rather than to a constant.
  const floor = minPeak != null ? minPeak
    : Number.isFinite(posMean) ? thr + peakFrac * (posMean - mid) : -Infinity;

  // median filter (robust to single-frame chatter)
  const med = new Float32Array(n);
  const k = smoothFrames | 1;
  const halfK = k >> 1;
  const buf = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) buf[j] = scores[Math.min(Math.max(i - halfK + j, 0), n - 1)];
    // TypedArray.sort() is numeric and in-place: no per-frame Array, no
    // comparator. Array.from(buf).sort(compare) allocated and sorted a fresh
    // array for every one of the ~21k frames, and measured 8.8x slower.
    buf.sort();
    med[i] = buf[halfK];
  }
  // then a short moving average
  const sm = new Float32Array(n);
  let acc = 0;
  for (let i = -halfK; i <= halfK; i++) acc += med[Math.min(Math.max(i, 0), n - 1)];
  for (let i = 0; i < n; i++) {
    sm[i] = acc / k;
    const drop = Math.min(Math.max(i - halfK, 0), n - 1);
    const add = Math.min(Math.max(i + halfK + 1, 0), n - 1);
    acc += med[add] - med[drop];
  }

  const runs = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (sm[i] > thr) {
      if (!cur) cur = { a: i, b: i };
      else cur.b = i;
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);

  // bridge short gaps
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && (r.a - last.b) / fps <= maxGap) last.b = r.b;
    else merged.push({ ...r });
  }

  const out = [];
  for (let ri = 0; ri < merged.length; ri++) {
    const r = merged[ri];
    if ((r.b - r.a + 1) / fps < minDuration) continue;
    // refine edges to the crossing points at a fraction of the threshold
    // (a plain loop: spreading a run into Math.max allocates a subarray view and
    // overflows the stack on the long runs a smeared occurrence can produce)
    let peak = -Infinity;
    for (let i = r.a; i <= r.b; i++) if (sm[i] > peak) peak = sm[i];
    if (peak < floor) continue;
    const edge = thr - edgeFrac * (peak - thr);
    // Bound each edge at the midpoint of the gap to its neighbour.
    //
    // `edge` is deliberately BELOW the detection threshold, so when a gap dips
    // under `thr` without dropping under `edge`, BOTH neighbouring runs satisfy
    // the walk condition and grow through each other — measured on this corpus,
    // two S02E01 segments overlapped by 36.4s. The midpoint keeps every run at
    // least its detected extent (the original bounds always sit inside their own
    // half) while making overlap impossible regardless of which runs survive the
    // filters below.
    const prev = merged[ri - 1], next = merged[ri + 1];
    const lo = prev ? ((prev.b + r.a) >> 1) + 1 : 0;
    const hi = next ? ((r.b + next.a) >> 1) : n - 1;
    let a = r.a, b = r.b;
    while (a > lo && sm[a - 1] > edge) a--;
    while (b < hi && sm[b + 1] > edge) b++;
    // Checked after edge refinement, since the refined extent is what gets cut.
    if ((b + 1 - a) / fps > maxFractionOfEpisode * (n / fps)) continue;
    out.push({
      start: a / fps,
      end: (b + 1) / fps,
      duration: (b + 1 - a) / fps,
      peak,
      meanScore: (() => { let s = 0; for (let i = a; i <= b; i++) s += sm[i]; return s / (b + 1 - a); })(),
    });
  }
  return out;
}

export { NFEAT };
