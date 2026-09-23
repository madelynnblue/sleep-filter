/**
 * Chroma features for fine alignment.
 *
 * Why chroma
 * ----------
 * Landmark fingerprints localise an asset to within ~1-2s using sparse spectral
 * peaks. Chroma -- a 12-dimensional pitch-class profile per frame -- is far more
 * sensitive: measured on this corpus, the title theme sits at ~0.99 cosine
 * similarity between episodes and drops to ~0.07 across the boundary, a cliff
 * sharp enough to place cut points to well under a second. Fingerprints find it;
 * chroma measures it.
 *
 * Two details make or break the discrimination:
 *   - Per-frame L2 normalisation, so loudness differences vanish.
 *   - Subtracting the time-mean chroma ("centering"). Raw chroma vectors are
 *     non-negative and diffuse, so ANY two frames score ~0.9 cosine similarity;
 *     centering drops unrelated frames to ~0.0 and is the difference between a
 *     useless flat baseline and a 0.99-versus-0.0 separation.
 *
 * Features for a 22-minute episode are ~1 MB, which is the point: decode once,
 * reduce, throw the PCM away, and everything downstream is cheap.
 *
 * Pure JS, browser-portable: no Node APIs, no dependencies.
 */

import { makeFFT, fftInPlace } from './fft.mjs';

/**
 * @returns {{C: Float32Array, nFrames: number, frameRate: number, duration: number}}
 *   C is flat, stride 12 (frame-major).
 */
export function computeChroma(samples, opts = {}) {
  const {
    sampleRate = 8000,
    nfft = 2048,
    hop = 512,
    fmin = 55,
    fmax = 4000,
    center = true,
    gateFrac = 0.02, // frames quieter than this fraction of median energy are zeroed
  } = opts;

  const T = makeFFT(nfft);
  const nBins = T.half + 1;

  // map each FFT bin to a pitch class (or -1 outside the band)
  const pc = new Int8Array(nBins).fill(-1);
  for (let k = 0; k < nBins; k++) {
    const f = (k * sampleRate) / nfft;
    if (f >= fmin && f <= fmax) {
      let p = Math.round(12 * Math.log2(f / 440));
      pc[k] = ((p % 12) + 12) % 12;
    }
  }

  const nFrames = Math.max(0, Math.floor((samples.length - nfft) / hop) + 1);
  const win = new Float32Array(nfft);
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nfft - 1));

  const re = new Float32Array(nfft);
  const im = new Float32Array(nfft);
  const C = new Float32Array(nFrames * 12);
  const norms = new Float32Array(nFrames);

  // Report a coarse fraction done. The STFT loop dominates, so the post-passes
  // below are folded in at the end rather than metered separately.
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const tickEvery = Math.max(1, Math.floor(nFrames / 100));

  for (let t = 0; t < nFrames; t++) {
    const off = t * hop;
    for (let i = 0; i < nfft; i++) { re[i] = samples[off + i] * win[i]; im[i] = 0; }
    fftInPlace(re, im, T);
    const base = t * 12;
    let e = 0;
    for (let k = 0; k < nBins; k++) {
      const p = pc[k];
      if (p < 0) continue;
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      C[base + p] += m;
      e += m;
    }
    norms[t] = e;
    if (onProgress && t % tickEvery === 0) onProgress(t / nFrames);
  }

  if (center) {
    const mean = new Float64Array(12);
    for (let t = 0; t < nFrames; t++) for (let c = 0; c < 12; c++) mean[c] += C[t * 12 + c];
    for (let c = 0; c < 12; c++) mean[c] /= Math.max(nFrames, 1);
    for (let t = 0; t < nFrames; t++) for (let c = 0; c < 12; c++) C[t * 12 + c] -= mean[c];
  }

  // gate near-silent frames, then L2 normalise
  const sorted = Float32Array.from(norms).sort();
  const median = nFrames ? sorted[nFrames >> 1] : 0;
  const gate = median * gateFrac;
  for (let t = 0; t < nFrames; t++) {
    const base = t * 12;
    if (norms[t] < gate) { for (let c = 0; c < 12; c++) C[base + c] = 0; continue; }
    let s = 0;
    for (let c = 0; c < 12; c++) s += C[base + c] * C[base + c];
    s = Math.sqrt(s);
    if (s > 0) for (let c = 0; c < 12; c++) C[base + c] /= s;
  }

  onProgress?.(1);
  return { C, nFrames, frameRate: sampleRate / hop, duration: samples.length / sampleRate };
}

/** Cosine similarity between two frames of (already normalised) chroma. */
export function frameSim(A, ai, B, bi) {
  const ao = ai * 12, bo = bi * 12;
  let s = 0;
  for (let c = 0; c < 12; c++) s += A[ao + c] * B[bo + c];
  return s;
}

/**
 * Similarity profile of shifted episode B against reference A.
 * A[t] is compared with B[t + dFrames].
 * @returns {Float32Array} values for t in [t0, t1)
 */
export function profile(A, nA, B, nB, dFrames, t0, t1) {
  const n = Math.max(0, t1 - t0);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = t0 + i;
    const j = t + dFrames;
    out[i] = (t < 0 || t >= nA || j < 0 || j >= nB) ? 0 : frameSim(A, t, B, j);
  }
  return out;
}

/** Centred moving average. */
export function smooth(x, k) {
  const n = x.length;
  const out = new Float32Array(n);
  if (!n) return out;
  const half = k >> 1;
  let acc = 0;
  for (let i = -half; i <= half; i++) acc += x[Math.min(Math.max(i, 0), n - 1)];
  for (let i = 0; i < n; i++) {
    out[i] = acc / (2 * half + 1);
    const drop = Math.min(Math.max(i - half, 0), n - 1);
    const add = Math.min(Math.max(i + half + 1, 0), n - 1);
    acc += x[add] - x[drop];
  }
  return out;
}

export function meanOf(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return x.length ? s / x.length : 0;
}
