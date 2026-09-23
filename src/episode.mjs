/**
 * EpisodeAnalyzer — one episode, streamed in, features out.
 *
 * Phase 1 of the pipeline. Heavy (decode-adjacent DSP), embarrassingly parallel
 * across episodes, and a natural unit of work for a Web Worker.
 *
 * Memory: raw PCM is reduced to mono at the analysis rate as it arrives, so the
 * ~500 MB a 22-minute stereo file would occupy at 48 kHz never materialises.
 * The reduced mono (~42 MB for 22 minutes at 8 kHz) is retained for the feature
 * pass, which is what lets the existing validated feature code be reused
 * verbatim rather than rewritten incrementally. Retained FEATURES — the thing
 * that gets cached and shared — are ~1 MB per episode.
 *
 * A fully incremental feature pass (STFT on the fly, buffering only chroma) is
 * possible and would cut peak memory to a few MB. It is deliberately not done
 * yet: it means rewriting three validated code paths, and this interface would
 * not change if it were.
 */

import { MonoResampler, DEFAULT_SAMPLE_RATE, toMonoAt } from './audio.mjs';
import { computeChroma } from './chroma.mjs';
import { fingerprint } from './discovery.mjs';
import { computeFeatures, calibrate, scoreFrames, segment, NFEAT } from './features.mjs';

const CHUNK_GROW = 1 << 18;   // 256k samples (~32s at 8 kHz) per growth step

/** Mean frame level, in dB, over [from, to) seconds. Feature 0 is logRms. */
const LOG_RMS = 0;
function meanLevel(F, from, to) {
  const t0 = Math.max(0, Math.round(from * F.frameRate));
  const t1 = Math.min(F.nFrames, Math.round(to * F.frameRate));
  if (t1 <= t0) return NaN;
  let acc = 0;
  for (let t = t0; t < t1; t++) acc += F.feats[t * NFEAT + LOG_RMS];
  return acc / (t1 - t0);
}

/**
 * Drop segments far quieter than the music exemplars.
 *
 * Foreground music is mixed at roughly the level of the music already identified
 * in that episode. Room tone, a low drone, or a scene sitting under a music bed
 * can look just as "musical" to the discriminant — that failure mode is timbre,
 * not loudness — but they sit well below the exemplars, and they are exactly the
 * audio that should be kept.
 *
 * The reference is the exemplar regions themselves, so the gate follows each
 * episode's own mix instead of an absolute dB figure that a differently mastered
 * file would break.
 *
 * Opt-in: 0 disables it. The same function refines theme boundaries, where this
 * gate has not been validated, so callers opt in explicitly.
 */
function gateByLevel(segments, F, positiveRanges, slackDb) {
  if (!(slackDb > 0)) return segments;
  const levels = positiveRanges.map(([a, b]) => meanLevel(F, a, b)).filter(Number.isFinite);
  if (!levels.length) return segments;
  const ref = levels.reduce((x, y) => x + y, 0) / levels.length;
  return segments.filter((s) => meanLevel(F, s.start, s.end) >= ref - slackDb);
}

class SampleBuffer {
  constructor() { this.buf = new Float32Array(CHUNK_GROW); this.length = 0; }
  push(x) {
    if (this.length + x.length > this.buf.length) {
      let cap = Math.max(this.buf.length, 1);
      while (cap < this.length + x.length) cap *= 2;
      const next = new Float32Array(cap);
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
    }
    this.buf.set(x, this.length);
    this.length += x.length;
  }
  view() { return this.buf.subarray(0, this.length); }
}

export class EpisodeAnalyzer {
  /**
   * @param {object} opts
   * @param {string} [opts.id]
   * @param {number} [opts.targetSampleRate=8000]
   * @param {number} [opts.inputSampleRate]  inferred from the first chunk if omitted
   * @param {number} [opts.inputChannels]    inferred from the first chunk if omitted
   */
  constructor(opts = {}) {
    this.id = opts.id ?? 'episode-1';
    this.targetSampleRate = opts.targetSampleRate ?? DEFAULT_SAMPLE_RATE;
    this.inputSampleRate = opts.inputSampleRate ?? null;
    this.inputChannels = opts.inputChannels ?? null;
    this._resampler = null;
    this._samples = new SampleBuffer();
    this._expectedFrames = 0;
    this._receivedFrames = 0;
  }

  /** Feed one AudioChunk (see audio.mjs for the shape). Returns samples added. */
  addChunk(chunk) {
    if (!this._resampler) {
      this.inputSampleRate = this.inputSampleRate ?? chunk.sampleRate;
      this.inputChannels = this.inputChannels ?? chunk.numberOfChannels;
      this._resampler = new MonoResampler({
        inputRate: chunk.sampleRate,
        outputRate: this.targetSampleRate,
        channels: chunk.numberOfChannels,
      });
    } else if (chunk.sampleRate !== this.inputSampleRate) {
      throw new Error(
        `sample rate changed mid-stream (${this.inputSampleRate} -> ${chunk.sampleRate}); ` +
        'feed one episode per analyzer'
      );
    }
    this._receivedFrames += chunk.numberOfFrames;
    const mono = this._resampler.process(chunk);
    if (mono.length) this._samples.push(mono);
    return mono.length;
  }

  /** Convenience for already-decoded data (no streaming). */
  static fromSamples({ id, data, sampleRate, channels = 1, targetSampleRate = DEFAULT_SAMPLE_RATE }) {
    const a = new EpisodeAnalyzer({
      id, targetSampleRate, inputSampleRate: sampleRate, inputChannels: channels,
    });
    const mono = toMonoAt(data, { sampleRate, channels, targetRate: targetSampleRate });
    if (mono.length) a._samples.push(mono);
    a._receivedFrames = channels === 1 ? data.length : Math.floor(data.length / channels);
    return a;
  }

  get duration() { return this._samples.length / this.targetSampleRate; }
  /** 0..1, or null if expectedFrames was never set. */
  get progress() {
    return this._expectedFrames ? Math.min(1, this._receivedFrames / this._expectedFrames) : null;
  }
  set expectedFrames(n) { this._expectedFrames = n; }
  get frames() { return this._samples.length; }

  /**
   * Compute features. Call once, after the last chunk.
   * @param {{chroma?: boolean, fingerprints?: boolean, segments?: boolean}} [opts]
   */
  finish(opts = {}) {
    const { chroma = true, fingerprints = true, segments = true } = opts;
    const samples = this._samples.view();
    const sampleRate = this.targetSampleRate;

    const out = {
      id: this.id,
      sampleRate,
      duration: samples.length / sampleRate,
      frameCount: samples.length,
    };
    if (chroma) out.chroma = computeChroma(samples, { sampleRate });
    if (fingerprints) out.fingerprints = fingerprint(samples, { sampleRate });
    if (segments) out.features = computeFeatures(samples, { sampleRate });
    return out;
  }
}

/**
 * Per-episode music segmentation without a library.
 * `positiveRanges` are known music regions (e.g. the title theme) used to
 * calibrate the discriminant, so no absolute thresholds are needed.
 */
export function segmentEpisode(episode, positiveRanges, opts = {}) {
  const F = episode.features;
  if (!F) throw new Error('episode.features missing — call finish() with segments: true');

  const mask = new Uint8Array(F.nFrames);
  for (const [a, b] of positiveRanges) {
    const i0 = Math.max(0, Math.round(a * F.frameRate));
    const i1 = Math.min(F.nFrames, Math.round(b * F.frameRate));
    for (let t = i0; t < i1; t++) mask[t] = 1;
  }
  const cal = calibrate(F.feats, F.nFrames, mask, {});
  if (!cal) {
    throw new Error('calibration failed — need at least ~10 positive frames and ~50 negatives');
  }
  const scores = scoreFrames(F.feats, F.nFrames, cal);
  const segments = segment(scores, F.frameRate, { mid: cal.mid, ...opts });
  return {
    calibration: cal,
    segments: gateByLevel(segments, F, positiveRanges, opts.levelSlack ?? 0),
  };
}

export { calibrate, scoreFrames, segment };
