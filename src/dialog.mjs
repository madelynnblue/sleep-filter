/**
 * Dialog-over-music detection.
 *
 * The question is not "is this speech or music" — it is "is someone talking
 * while the music plays". Both are present at once, so a detector has to find
 * speech *inside* a music bed rather than choose between the two.
 *
 * The features come from Karneback's low-frequency-modulation work (Eurospeech
 * 2001, "Discrimination between speech and music based on a low frequency
 * modulation feature") and Scheirer & Slaney's 4 Hz cue. His finding is that the
 * useful information is not how much low-frequency modulation there is — music
 * has plenty, that is the beat — but how it is distributed ACROSS bands:
 *
 *   - In music one source modulates every band together, so the per-band
 *     modulation amplitudes are correlated with each other.
 *   - In speech each band moves on its own, so they are not.
 *
 * Hence `bandSync`, which is 1 minus the mean pairwise correlation of the band
 * modulation amplitudes. On its own it is a weak detector (AUC 0.60 measured
 * over 109 hand-judged windows across 7 episodes); in combination with the
 * modulation magnitudes it is consistently one of the two best members, which is
 * exactly the complementarity he describes.
 *
 * The three series are combined with fixed corpus-wide constants, NOT per
 * episode. Per-episode standardisation was tried and is worse (AUC 0.800 against
 * 0.835) and, more importantly, it centres every episode on its own mean, so a
 * threshold can no longer mean "there is no dialog here" — every episode would
 * flag its own top fraction regardless of its content.
 *
 * Measured on those 109 windows (58 with dialog):
 *
 *   "4 Hz modulation"        AUC 0.783   (the existing production feature)
 *   "4 Hz mod (speech)"      AUC 0.757
 *   "band synchrony"         AUC 0.600
 *   level alone (control)    AUC 0.398   <- dialogue is not simply louder
 *   the three combined       AUC 0.835
 *
 * Pure JS, browser-portable.
 */

import { makeFFT, realSpectrum } from './fft.mjs';
import { butterworthLowpass, applyCascade } from './dsp.mjs';

const SR = 8000;

/** Fine STFT: 64 ms window, 10 ms hop. The 4 Hz cue needs a fast envelope. */
const FNFFT = 512;
const FHOP = 80;
const FPS_FINE = SR / FHOP;   // 100

/** Third-octave band centres, 100 Hz - 4 kHz. */
const BANDS = [100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000];
const SPEECH_BANDS = BANDS.map((c, i) => i).filter((i) => BANDS[i] >= 300 && BANDS[i] <= 3400);

const MOD_WIN = 25;    // 250 ms, Karneback's analysis window
const MOD_HZ = 4;
const CORR_WIN = 200;  // 2 s
const CORR_STEP = 20;  // 200 ms

/**
 * The three detectors the combination uses, in the order they are averaged.
 *
 * `mod4` is the production 4 Hz feature and arrives with the feature matrix
 * rather than from this pass — see EpisodeAnalyzer.finish. It is the single
 * strongest member (AUC 0.783) and the most stable across episodes, which is why
 * the combination is built around it rather than around the new series alone.
 */
export const DIALOG_SERIES = ['mod4', 'modSpeech', 'bandSync'];

/**
 * Fixed standardisation and weights for the combination.
 *
 * Mean and standard deviation of each series' 6 s window score, measured over
 * the survey windows of 8 episodes of the reference corpus, and the threshold
 * that goes with them.
 *
 * The threshold is a precision/recall choice, and the honest numbers at 109
 * judged windows (58 with dialog) are:
 *
 *   threshold   flagged   precision   recall
 *     0.0         49%       0.77       0.71
 *     0.3         28%       0.84       0.45   <- default
 *     0.5         18%       0.90       0.31
 *     1.0          3%       1.00       0.05
 *
 * An earlier 3-episode sample put precision at 1.00 for the 30% budget; at seven
 * episodes it is 0.84. Precision never exceeds ~0.90 anywhere on the curve, so
 * "no false alarms" is not on the table — the default takes the 30%-flagged
 * point and the knob exists to trade recall for precision.
 */
export const DIALOG_CALIBRATION = {
  mod4: { mean: 0.2906, sd: 0.0918 },
  modSpeech: { mean: 1.9010, sd: 0.0368 },
  bandSync: { mean: 0.5730, sd: 0.1600 },
};
export const DIALOG_WEIGHTS = { mod4: 1, modSpeech: 1, bandSync: 1 };
export const DIALOG_THRESHOLD = 0.3;
export const DIALOG_WINDOW = 6.0;

/** Mean of each feature frame's worth of fine samples. */
function toFrameGrid(fine, nFrames, finePerFrame) {
  const out = new Float32Array(nFrames);
  for (let t = 0; t < nFrames; t++) {
    const a = Math.min(fine.length, Math.floor(t * finePerFrame));
    const b = Math.min(fine.length, Math.floor((t + 1) * finePerFrame));
    let s = 0;
    for (let i = a; i < b; i++) s += fine[i];
    out[t] = b > a ? s / (b - a) : 0;
  }
  return out;
}

/** Pearson correlation of two equal-length slices. */
function corr(a, b, n) {
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    sab += x * y; sa += x * x; sb += y * y;
  }
  const d = Math.sqrt(sa * sb);
  return d > 1e-12 ? sab / d : 0;
}

/**
 * @param {Float32Array} samples mono at `opts.sampleRate` (must be 8 kHz)
 * @param {object} opts
 * @param {number} opts.nFrames    feature frame count, for the output grid
 * @param {number} opts.frameRate  feature frame rate
 * @param {(frac:number)=>void} [opts.onProgress]
 * @returns {{modSpeech: Float32Array, bandSync: Float32Array, periodicity: Float32Array}}
 */
export function computeDialog(samples, opts = {}) {
  const { sampleRate = SR, nFrames, frameRate, onProgress } = opts;
  if (sampleRate !== SR) throw new Error(`computeDialog needs ${SR} Hz samples, got ${sampleRate}`);
  if (!(nFrames > 0)) throw new Error('computeDialog needs opts.nFrames');
  if (!(frameRate > 0)) throw new Error('computeDialog needs opts.frameRate');
  const report = typeof onProgress === 'function' ? onProgress : null;
  const n = samples.length;

  /* ------------------------------------------------ fine band envelopes -- */
  const NB = FNFFT / 2 + 1;
  const fft = makeFFT(FNFFT);
  const win = new Float64Array(FNFFT);
  for (let i = 0; i < FNFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FNFFT);
  const re = new Float64Array(FNFFT), mag = new Float32Array(NB);
  const power = new Float32Array(NB), scratch = new Float64Array(FNFFT);

  const nFine = Math.max(0, Math.floor((n - FNFFT) / FHOP) + 1);
  const nBands = BANDS.length;
  const binHz = SR / FNFFT;
  const bandBins = BANDS.map((c) => {
    const k0 = Math.max(1, Math.floor((c / Math.SQRT2) / binHz));
    const k1 = Math.min(NB - 1, Math.ceil((c * Math.SQRT2) / binHz));
    return { k0, k1: Math.max(k0, k1) };
  });
  const env = new Float32Array(nFine * nBands);
  for (let t = 0; t < nFine; t++) {
    const off = t * FHOP;
    for (let i = 0; i < FNFFT; i++) re[i] = samples[off + i] * win[i];
    realSpectrum(re, fft, mag, power, scratch);
    for (let b = 0; b < nBands; b++) {
      const { k0, k1 } = bandBins[b];
      let s = 0;
      for (let k = k0; k <= k1; k++) s += power[k];
      env[t * nBands + b] = s;
    }
    if (report && t % 4096 === 0) report(0.65 * (t / Math.max(1, nFine)));
  }

  /* ------------------------------------ per-band relative 4 Hz modulation -- */
  // Divided by the band's OWN level over the same window, which makes this a
  // modulation depth and level-invariant. Dividing by an episode-wide average
  // instead leaves the amplitude proportional to local loudness: that version
  // measured r = 0.88 against level and was a level detector with extra steps.
  const hann = new Float64Array(MOD_WIN);
  for (let i = 0; i < MOD_WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / MOD_WIN);
  const kCos = new Float64Array(MOD_WIN), kSin = new Float64Array(MOD_WIN);
  for (let i = 0; i < MOD_WIN; i++) {
    const ph = (2 * Math.PI * MOD_HZ * i) / FPS_FINE;
    kCos[i] = hann[i] * Math.cos(ph);
    kSin[i] = -hann[i] * Math.sin(ph);
  }
  const half = (MOD_WIN - 1) >> 1;
  const modA = new Float32Array(nBands * nFine);
  for (let b = 0; b < nBands; b++) {
    for (let t = 0; t < nFine; t++) {
      let sr = 0, si = 0, mn = 0;
      const base = t - half;
      for (let i = 0; i < MOD_WIN; i++) {
        const j = base + i;
        const v = (j >= 0 && j < nFine) ? env[j * nBands + b] : 0;
        sr += v * kCos[i];
        si += v * kSin[i];
        mn += v;
      }
      mn /= MOD_WIN;
      modA[b * nFine + t] = mn > 1e-20 ? Math.sqrt(sr * sr + si * si) / mn : 0;
    }
    if (report && b % 4 === 0) report(0.65 + 0.15 * (b / nBands));
  }

  const modSpeech = new Float32Array(nFine);
  for (let t = 0; t < nFine; t++) {
    let s = 0;
    for (const b of SPEECH_BANDS) s += modA[b * nFine + t];
    modSpeech[t] = Math.log10(s + 1e-12);
  }
  report?.(0.80);

  /* ------------------------------------- cross-band modulation synchrony -- */
  const subset = SPEECH_BANDS;
  const nSub = subset.length;
  const bandSync = new Float32Array(nFine);
  let last = 0;
  for (let t = 0; t < nFine; t += CORR_STEP) {
    const a0 = t - CORR_WIN + 1;
    let sum = 0, pairs = 0;
    if (a0 >= 0) {
      const slices = subset.map((b) => modA.subarray(b * nFine + a0, b * nFine + a0 + CORR_WIN));
      for (let i = 0; i < nSub; i++) {
        for (let j = i + 1; j < nSub; j++) { sum += corr(slices[i], slices[j], CORR_WIN); pairs++; }
      }
    }
    last = pairs ? 1 - sum / pairs : 0;
    for (let k = t; k < Math.min(nFine, t + CORR_STEP); k++) bandSync[k] = last;
    if (report && t % (CORR_STEP * 200) === 0) report(0.80 + 0.12 * (t / Math.max(1, nFine)));
  }
  report?.(0.92);

  /* -------------------------------------------------- pitch / voicing -- */
  // Autocorrelation over 80-300 Hz on a 4x-decimated lowpassed copy. Kept for
  // reporting and for the reserve combination; it is the least stable member
  // across episodes (AUC 0.37 on one, 1.00 on another), which is why it is not
  // in the shipped combination.
  const periodicity = new Float32Array(nFrames);
  {
    const ds4 = 4, fsr = SR / ds4, pwin = Math.round(0.04 * fsr);
    const lagMin = Math.round(fsr / 300), lagMax = Math.round(fsr / 80);
    const filt = applyCascade(samples, butterworthLowpass(SR, 700, 4));
    const dm = Math.floor(filt.length / ds4);
    const dsig = new Float32Array(dm);
    for (let i = 0; i < dm; i++) dsig[i] = filt[i * ds4];
    const w = new Float64Array(pwin);
    const hop = Math.round(SR / frameRate);
    for (let t = 0; t < nFrames; t++) {
      const start = Math.round((t * hop) / ds4);
      if (start + pwin > dm) break;
      let mean = 0;
      for (let i = 0; i < pwin; i++) mean += dsig[start + i];
      mean /= pwin;
      let r0 = 0;
      for (let i = 0; i < pwin; i++) { const v = dsig[start + i] - mean; w[i] = v; r0 += v * v; }
      if (r0 <= 1e-12) continue;
      let best = 0;
      for (let lag = lagMin; lag <= lagMax; lag++) {
        let r = 0;
        for (let i = 0; i + lag < pwin; i++) r += w[i] * w[i + lag];
        if (r / r0 > best) best = r / r0;
      }
      periodicity[t] = best;
    }
  }
  report?.(1);

  const finePerFrame = SR / frameRate / FHOP;
  return {
    modSpeech: toFrameGrid(modSpeech, nFrames, finePerFrame),
    bandSync: toFrameGrid(bandSync, nFrames, finePerFrame),
    periodicity,
  };
}

/**
 * The combination score for one 6 s window starting at `at`.
 *
 * Aggregation is the max of the series smoothed with a 1 s moving average: the
 * question a segment asks is "is there dialog anywhere in here", and the
 * smoothing stops a single stray frame from answering it. The window length is
 * fixed because the calibration constants were measured on fixed 6 s windows —
 * a longer window would raise the max and drift off the threshold.
 */
export function dialogWindowScore(dialog, frameRate, at, dur = DIALOG_WINDOW) {
  let total = 0, weight = 0;
  for (const key of DIALOG_SERIES) {
    const w = DIALOG_WEIGHTS[key];
    if (!w) continue;
    const c = DIALOG_CALIBRATION[key];
    if (!c) continue;
    const raw = seriesMax(dialog[key], frameRate, at, dur);
    total += w * ((raw - c.mean) / c.sd);
    weight += w;
  }
  return weight > 0 ? total / weight : 0;
}

/** Max of a series over [at, at+dur), after a 1 s moving average. */
export function seriesMax(series, frameRate, at, dur) {
  if (!series) return 0;
  const w = Math.max(1, Math.round(frameRate));
  const i0 = Math.max(0, Math.floor(at * frameRate));
  const i1 = Math.min(series.length, Math.ceil((at + dur) * frameRate));
  let best = -Infinity;
  for (let t = i0; t < i1; t++) {
    const a = Math.max(0, t - w + 1);
    let s = 0;
    for (let j = a; j <= t; j++) s += series[j];
    const v = s / (t - a + 1);
    if (v > best) best = v;
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * Whether a music segment contains dialog.
 *
 * A fixed 6 s window slides across the segment — the calibration's own unit —
 * and the segment is flagged when any window scores above the threshold. Without
 * the sliding window a long segment would get one score from its whole extent,
 * and the max over a longer span is biased upward, so the same audio would cross
 * the threshold or not depending on where the segment happened to be cut.
 */
export function segmentHasDialog(dialog, frameRate, start, end, threshold = DIALOG_THRESHOLD) {
  const step = DIALOG_WINDOW / 2;
  let best = -Infinity;
  const span = end - start;
  if (span <= DIALOG_WINDOW) {
    best = dialogWindowScore(dialog, frameRate, start, Math.max(0.5, span));
  } else {
    for (let at = start; at + DIALOG_WINDOW <= end; at += step) {
      best = Math.max(best, dialogWindowScore(dialog, frameRate, at));
    }
    // and the tail window, so the last few seconds are covered too
    best = Math.max(best, dialogWindowScore(dialog, frameRate, end - DIALOG_WINDOW));
  }
  return { hasDialog: best >= threshold, score: best };
}
