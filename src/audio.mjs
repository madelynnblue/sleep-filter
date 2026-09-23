/**
 * Raw-audio ingestion: AudioChunk -> mono at the analysis rate.
 *
 * This is the ONLY place the package touches the decode boundary. It never sees
 * a container, a codec, or a file — just typed arrays — which is what keeps the
 * analysis runnable unchanged in Node, a worker, or a page.
 *
 * Shape deliberately mirrors `WebCodecs.AudioData`, so a decoder can hand chunks
 * over with almost no transformation:
 *
 *   {
 *     sampleRate, numberOfFrames, numberOfChannels,
 *     format: 'f32-planar' | 'f32',
 *     data: Float32Array[] | Float32Array,
 *     timestamp?: number          // microseconds, from the source
 *   }
 *
 * Downmix and resampling live HERE, not in the decoder, so the decoder stays a
 * dumb container/codec layer and the analysis owns its own DSP assumptions.
 * WebCodecs cannot resample anyway, so internal conversion is not optional.
 *
 * IMPORTANT: the anti-alias filter carries state across chunks. Filtering each
 * chunk independently would put a discontinuity at every boundary.
 */

import { butterworthLowpass, applyCascade } from './dsp.mjs';

export const DEFAULT_SAMPLE_RATE = 8000;

/** Validate and normalise a chunk descriptor. Throws on malformed input. */
export function describeChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') throw new TypeError('AudioChunk must be an object');
  const {
    sampleRate, numberOfFrames, numberOfChannels = 1, format = 'f32-planar', data,
  } = chunk;
  if (!(sampleRate > 0)) throw new TypeError('AudioChunk.sampleRate must be > 0');
  if (!(numberOfFrames >= 0)) throw new TypeError('AudioChunk.numberOfFrames must be >= 0');
  if (!(numberOfChannels >= 1)) throw new TypeError('AudioChunk.numberOfChannels must be >= 1');
  if (format !== 'f32' && format !== 'f32-planar') {
    throw new TypeError(`unsupported AudioChunk.format "${format}" (expected f32 or f32-planar)`);
  }
  if (format === 'f32-planar') {
    if (!Array.isArray(data) || data.length !== numberOfChannels) {
      throw new TypeError('f32-planar data must be an array of one Float32Array per channel');
    }
    for (const c of data) {
      if (!(c instanceof Float32Array)) throw new TypeError('planar channels must be Float32Array');
    }
  } else if (!(data instanceof Float32Array)) {
    throw new TypeError('f32 data must be a Float32Array');
  }
  return { sampleRate, numberOfFrames, numberOfChannels, format, data, timestamp: chunk.timestamp ?? 0 };
}

/** Write the mono downmix of `chunk` into `out` (length >= numberOfFrames). */
export function downmixInto(chunk, out) {
  const { numberOfFrames: n, numberOfChannels: ch, format, data } = chunk;
  if (format === 'f32-planar') {
    if (ch === 1) {
      out.set(data[0].subarray(0, n));
      return out;
    }
    const scale = 1 / ch;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += data[c][i];
      out[i] = s * scale;
    }
    return out;
  }
  if (ch === 1) {
    out.set(data.subarray(0, n));
    return out;
  }
  const scale = 1 / ch;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * ch;
    for (let c = 0; c < ch; c++) s += data[base + c];
    out[i] = s * scale;
  }
  return out;
}

/**
 * Streams arbitrary-rate, arbitrary-channel chunks down to mono at a fixed rate.
 *
 * When the input already matches (mono at the target rate) this is a true
 * zero-copy pass-through — no filtering, no interpolation — so results are
 * exactly what a pre-decoded buffer would give.
 */
export class MonoResampler {
  constructor({ inputRate, outputRate = DEFAULT_SAMPLE_RATE, channels = 1 } = {}) {
    if (!(inputRate > 0)) throw new TypeError('inputRate must be > 0');
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.channels = channels;
    this.ratio = inputRate / outputRate;
    this.passthrough = Math.abs(this.ratio - 1) < 1e-9 && channels === 1;
    this.needsResample = Math.abs(this.ratio - 1) >= 1e-9;

    // Only filter when actually reducing rate; 0.45 * outputRate leaves headroom
    // below the new Nyquist for the transition band.
    this.filter = inputRate > outputRate
      ? butterworthLowpass(inputRate, 0.45 * outputRate, 4)
      : null;

    this.tail = null;   // last input sample, for interpolation across chunks
    this.pos = 0;       // fractional read position, in current-buffer coords
    this._mono = new Float32Array(0);
  }

  /** @returns {Float32Array} mono samples at outputRate */
  process(chunk) {
    const d = describeChunk(chunk);

    if (this.passthrough && d.format === 'f32-planar' && d.numberOfChannels === 1) {
      // zero-copy: hand the caller's own view straight through
      return d.data[0].subarray(0, d.numberOfFrames);
    }

    if (this._mono.length < d.numberOfFrames) this._mono = new Float32Array(d.numberOfFrames);
    const mono = this._mono.subarray(0, d.numberOfFrames);
    downmixInto(d, mono);

    const filtered = this.filter ? applyCascade(mono, this.filter) : mono;
    if (!this.needsResample) return filtered;
    return this._resample(filtered);
  }

  _resample(x) {
    const buf = this.tail ? (() => {
      const b = new Float32Array(x.length + 1);
      b[0] = this.tail[0];
      b.set(x, 1);
      return b;
    })() : x;

    const ratio = this.ratio;
    const count = Math.max(0, Math.ceil((buf.length - 1 - this.pos) / ratio));
    const out = new Float32Array(Math.max(count, 0));
    let i = this.pos, n = 0;
    const last = buf.length - 1;
    while (i < last) {
      const k = i | 0;
      const f = i - k;
      out[n++] = buf[k] * (1 - f) + buf[k + 1] * f;
      i += ratio;
    }
    this.tail = Float32Array.of(buf[last]);
    // carry the deficit; the next buffer starts with this buffer's last sample
    this.pos = i - last;
    return out.subarray(0, n);
  }
}

/** Convenience: resample a whole pre-decoded buffer in one call. */
export function toMonoAt(samples, { sampleRate, channels = 1, targetRate = DEFAULT_SAMPLE_RATE }) {
  if (channels === 1 && sampleRate === targetRate) return samples;
  const r = new MonoResampler({ inputRate: sampleRate, outputRate: targetRate, channels });
  const chunk = channels === 1
    ? { sampleRate, numberOfFrames: samples.length, numberOfChannels: 1, format: 'f32-planar', data: [samples] }
    : { sampleRate, numberOfFrames: samples.length / channels, numberOfChannels: channels, format: 'f32', data: samples };
  return r.process(chunk);
}
