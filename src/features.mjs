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

  // --- 4 Hz modulation energy ---
  //
  // The original idea: speech has a strong syllable-rate envelope modulation
  // that music lacks. It has to be computed from envelopes sampled WELL above
  // 4 Hz — deriving it from frame-rate RMS (~15.6 Hz) cannot resolve syllable
  // rate and instead measures musical beat, which inverts the sign. So: per-band
  // envelopes at 100 Hz via biquad bandpass + rectify + smooth, then bandpass
  // the envelope itself in the 3-6 Hz range and compare that energy to the
  // envelope's total AC energy.
  //
  // MEASURED, AND IT DOES NOT HOLD UP. That is the design, not the behaviour:
  //
  //   The DC that gets removed below is the WHOLE EPISODE's mean, so a passage
  //   loud relative to the episode carries a constant into `dc`, which lands in
  //   the denominator and crushes the ratio. On S02E05 a man talking plainly at
  //   8:42 measures 0.294 when the band is analysed directly and 0.066 through
  //   this feature — the arithmetic discards the evidence. The title theme is
  //   crushed the same way, for the same reason: it is loud. Over three episodes
  //   the theme reads 0.072-0.090 against 0.177-0.203 for the rest of the
  //   episode, and that gap is very nearly just level.
  //
  //   Remove the DC level-invariantly — subtract a local mean, or divide by one,
  //   both tried — and the gap closes completely: theme 0.240-0.248 against
  //   0.219-0.243 for everything else. Speech and music carry syllable-rate
  //   modulation about equally on this material.
  //
  // So this is, on this corpus, largely a level proxy, and `logRms` already
  // exists. It is kept because the discriminant is fitted around it and removing
  // it would change every existing result, but it is not the speech detector its
  // name suggests. A 80-300 Hz variant of it was built, measured and removed for
  // the same reason; see the README's "the speech cue does not work".
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
  // `negSample` caps how many negative frames are used; they are taken as a
  // contiguous prefix, so there is no sampling randomness to seed.
  const { negSample = 4000 } = opts;
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
    // How far below the detection threshold a segment edge may reach, as a
    // fraction of the run's prominence (peak - threshold).
    //
    // This decides how much audio beyond the confident core gets cut, and it was
    // set far too generously at 0.35. Measured over the 147 segments the general
    // stage produces, the frames the outward walk added average mod4 0.175 —
    // against 0.123 for the music core and 0.215 for non-theme audio. They are
    // speech-leaning, not music tail: 90.7s of it, and it is why segments were
    // ending with a few words of dialogue attached.
    //
    // At 0.10 the walk gives back 69.5s of that while every episode still gets
    // segments and theme coverage stays at 18/18, so nothing is lost by it. A
    // fade-out that dips just under the threshold is still caught.
    edgeFrac = 0.10,
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

/* ---------------------------------------------------------------- CFA -- */

/**
 * Continuous Frequency Activation, after the DAFx-07 paper
 * (https://dafx.labri.fr/main/papers/p221.pdf).
 *
 * The idea: a sustained musical tone lights up the SAME narrow band for seconds
 * at a time, while speech sweeps its formants around and broadband noise never
 * concentrates. So: take a dB spectrogram, subtract a local mean across
 * frequency to flatten the timbral envelope, binarise what is left, and measure
 * how peaked each frequency band's activation is over a ~2 second window.
 *
 * A peak prominence is `min(leftDrop, rightDrop) / halfWidth`: high when a band
 * sits well above both of its neighbours AND the peak is narrow. Summing the top
 * five prominences gives a per-window score that is level-invariant, since the
 * local-mean subtraction removes the overall gain.
 *
 * Rate
 * ----
 * This runs at 11.025 kHz, NOT at the pipeline's 8 kHz feature rate. Porting it
 * to 8 kHz was tried and measured against the 56 hand-judged rows: it is worse,
 * and no choice of the two free parameters recovers the surveyed behaviour.
 *
 *   CFA config                     CFA alone        OR rule (season+chromaSelf+CFA)
 *   11.025 kHz, 21 bins, 100 fr    13 hit / 0 FA    20 hit / 0 FA / F1 0.80
 *   8 kHz, 21 bins, 100 fr         11 / 0           18 / 0 / 0.75
 *   8 kHz, 21 bins, 72 fr          11 / 0           17 / 0 / 0.72
 *   8 kHz, 29 bins (Hz-matched)    14 / 0           18 / 0 / 0.75
 *   8 kHz, 29 bins, 72 fr          12 / 0           18 / 0 / 0.75
 *
 * The Hz-matched 8 kHz variant is actually BETTER standalone yet still worse in
 * the OR: it fires on different rows, and all four 8 kHz variants miss the same
 * three music rows that only 11 kHz CFA catches. So this is not a tuning
 * problem, and the extra resample stream is worth its cost.
 *
 * @param {Float32Array} samples mono, at `opts.sampleRate`
 * @param {object} opts
 * @param {number} opts.sampleRate  should be CFA_SAMPLE_RATE
 * @param {number} opts.nFrames     output length, on the feature frame grid
 * @param {number} opts.frameRate   feature frame rate, to align block centres
 * @returns {Float32Array} one activation score per feature frame
 */
export const CFA_SAMPLE_RATE = 11025;
const CFA_NFFT = 1024;
const CFA_HOP = 256;
/** Local-mean window across frequency, in bins. 21 bins is ~226 Hz at 11 kHz. */
const CFA_EMPH_BINS = 21;
/** Frames per activation block, 50% overlapped. 100 frames is ~2.3 s at 11 kHz. */
const CFA_BLOCK = 100;
const CFA_STEP = CFA_BLOCK >> 1;
const CFA_TOP = 5;
/** dB above the local mean before a band counts as active. */
const CFA_THRESHOLD_DB = 0.1;

export function computeCFA(samples, opts = {}) {
  const { sampleRate, nFrames, frameRate, onProgress } = opts;
  if (!(sampleRate > 0)) throw new Error('computeCFA needs opts.sampleRate');
  if (!(nFrames > 0)) throw new Error('computeCFA needs opts.nFrames');
  if (!(frameRate > 0)) throw new Error('computeCFA needs opts.frameRate');

  const NB = CFA_NFFT / 2 + 1;
  const fft = makeFFT(CFA_NFFT);
  const win = new Float64Array(CFA_NFFT);
  for (let i = 0; i < CFA_NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / CFA_NFFT);
  const re = new Float64Array(CFA_NFFT);
  const mag = new Float32Array(NB);
  const power = new Float32Array(NB);
  const scratch = new Float64Array(CFA_NFFT);
  const db = new Float32Array(NB);

  const nSTFT = Math.max(0, Math.floor((samples.length - CFA_NFFT) / CFA_HOP) + 1);
  // One byte per time-frequency cell: is this band above its local mean?
  const active = new Uint8Array(nSTFT * NB);
  const half = (CFA_EMPH_BINS - 1) >> 1;
  const report = typeof onProgress === 'function' ? onProgress : null;
  const tickEvery = Math.max(1, Math.floor(nSTFT / 50));

  for (let t = 0; t < nSTFT; t++) {
    const off = t * CFA_HOP;
    for (let i = 0; i < CFA_NFFT; i++) re[i] = samples[off + i] * win[i];
    realSpectrum(re, fft, mag, power, scratch);
    // Floor the dB scale RELATIVE to this frame's own peak, not absolutely.
    //
    // The local-mean subtraction cancels a constant gain exactly, so a fixed
    // absolute floor is the one thing that can break the level invariance the
    // whole feature rests on: with `power + 1e-12` every near-empty bin pins at
    // -120 dB no matter how loud the audio is, so attenuating the signal does not
    // shift the spectrogram rigidly — it clamps MORE bins. Measured on a
    // synthetic tone, attenuating by 40 dB distorted individual bins by up to
    // 71 dB and moved the mean score by 20%.
    //
    // On real material the floor never bites (-120 dB below the frame peak is
    // below any real noise floor), which is why this reproduces the surveyed
    // series bit-exactly; it matters for the quiet clusters the level gate
    // deliberately keeps.
    let peakPower = 0;
    for (let k = 0; k < NB; k++) if (power[k] > peakPower) peakPower = power[k];
    const silence = !(peakPower > 0);
    const floorDb = silence ? -200 : 10 * Math.log10(peakPower) - 120;
    let acc = 0;
    for (let k = 0; k < NB; k++) {
      db[k] = silence || power[k] <= 0 ? floorDb : Math.max(10 * Math.log10(power[k]), floorDb);
      if (k <= half) acc += db[k];
    }
    // Sliding local mean over the whole window, clipped at both ends so the
    // first and last bins are compared against a one-sided mean rather than a
    // mean that wraps or is artificially low.
    for (let k = 0; k < NB; k++) {
      const add = k + half + 1, drop = k - half - 1;
      if (add < NB) acc += db[add];
      if (drop >= 0) acc -= db[drop];
      const lo = k - half > 0 ? k - half : 0;
      const hi = k + half < NB - 1 ? k + half : NB - 1;
      active[t * NB + k] = (db[k] - acc / (hi - lo + 1)) > CFA_THRESHOLD_DB ? 1 : 0;
    }
    if (report && t % tickEvery === 0) report(t / Math.max(1, nSTFT));
  }
  report?.(1);

  // Block activation, one block every CFA_STEP frames.
  const nBlocks = nSTFT >= CFA_BLOCK ? Math.floor((nSTFT - CFA_BLOCK) / CFA_STEP) + 1 : 0;
  const blockAt = new Float64Array(nBlocks);
  const blockScore = new Float32Array(nBlocks);
  const act = new Float32Array(NB);
  const prominence = new Float64Array(NB);
  for (let b = 0; b < nBlocks; b++) {
    const s = b * CFA_STEP;
    act.fill(0);
    for (let j = s; j < s + CFA_BLOCK; j++) {
      const base = j * NB;
      for (let k = 0; k < NB; k++) act[k] += active[base + k];
    }
    for (let k = 0; k < NB; k++) act[k] /= CFA_BLOCK;

    let np = 0;
    for (let p = 1; p < NB - 1; p++) {
      if (!(act[p] > act[p - 1] && act[p] >= act[p + 1])) continue;
      let l = p - 1;
      while (l > 0 && act[l] > act[l - 1]) l--;
      let r = p + 1;
      while (r < NB - 1 && act[r] > act[r + 1]) r++;
      const dl = act[p] - act[l], dr = act[p] - act[r];
      const drop = dl < dr ? dl : dr;
      const width = dl < dr ? p - l : r - p;
      prominence[np++] = drop / (width > 0 ? width : 1);
    }
    // Top CFA_TOP prominences, by selection rather than a full sort.
    let sum = 0;
    for (let i = 0; i < CFA_TOP && i < np; i++) {
      let best = i;
      for (let j = i + 1; j < np; j++) if (prominence[j] > prominence[best]) best = j;
      const tmp = prominence[i]; prominence[i] = prominence[best]; prominence[best] = tmp;
      sum += prominence[i];
    }
    // The centre of the block: the middle STFT frame's window midpoint, so the
    // window's own half-length counts. Omitting it (using s*HOP + BLOCK/2*HOP)
    // shifts every block 46 ms early, which is enough to move the nearest-block
    // choice for ~4% of frames and cost 4% agreement with the surveyed column.
    blockAt[b] = ((s + CFA_BLOCK / 2) * CFA_HOP + CFA_NFFT / 2) / sampleRate;
    blockScore[b] = sum;
  }

  // Resample the block series onto the feature frame grid by nearest block
  // centre. Both sequences ascend, so one forward-only cursor does it in linear
  // time (a scan per frame is 20k x 40k comparisons and was the slowest part).
  const out = new Float32Array(nFrames);
  if (!nBlocks) return out;
  let cur = 0;
  for (let t = 0; t < nFrames; t++) {
    const time = t / frameRate;
    // strict `<`, so a tie keeps the earlier block — matching the exhaustive
    // first-minimum scan this replaced
    while (cur < nBlocks - 1 && Math.abs(blockAt[cur + 1] - time) < Math.abs(blockAt[cur] - time)) cur++;
    out[t] = blockScore[cur];
  }
  return out;
}

export { NFEAT };
