/**
 * Uncompressed PCM: WAV and AIFF.
 *
 * PCM is the one case where no decoder is involved at all. There is no codec to
 * configure, no AudioDecoder, and no reason to route anything through WebCodecs —
 * the bytes ARE the samples, so "decoding" is a conversion from integer to float
 * and nothing more. That also makes the cut exact: cutting PCM is byte arithmetic
 * at frame granularity, so the output is bit-identical rather than approximately
 * so, and it needs no codec, no muxer and no re-encode.
 *
 * The containers differ only in byte order and header shape. WAV is little-endian
 * with 32-bit sizes in a RIFF chunk list; AIFF is big-endian with 32-bit sizes in
 * an IFF chunk list and an 80-bit extended-float sample rate. Both keep their
 * header, so cutting copies it and patches the three length fields that change.
 *
 * Pure JS, browser-safe.
 */

const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const put32le = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; };
const put32be = (b, o, v) => { b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff; };

/** 80-bit IEEE extended float, which is how AIFF stores its sample rate. */
function extended80(b, o) {
  const exp = ((b[o] & 0x7f) << 8) | b[o + 1];
  const hi = u32be(b, o + 2), lo = u32be(b, o + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  return (hi * 4294967296 + lo) * Math.pow(2, exp - 16383 - 63);
}

/* ------------------------------------------------------------ reading -- */

/**
 * Convert `frames` frames starting at byte `from` into planar Float32.
 *
 * Integer PCM is divided by its full-scale value, a power of two for 8/16/24-bit,
 * so the conversion introduces no rounding in the direction that matters.
 */
function readFrames(bytes, from, frames, pcm, out) {
  const { format, bits, le, channels, blockAlign } = pcm;
  const width = bits >> 3;
  const scale = (format === 'f32' || format === 'f64') ? 1
    : format === 'u8' ? 1 / 128
    : 1 / Math.pow(2, bits - 1);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i < frames; i++) {
    const base = from + i * blockAlign;
    for (let c = 0; c < channels; c++) {
      const o = base + c * width;
      let v;
      if (format === 'f32') v = dv.getFloat32(o, true);
      else if (format === 'f64') v = dv.getFloat64(o, true);
      else if (format === 'u8') v = (bytes[o] - 128) * scale;
      else if (bits === 8) v = ((bytes[o] << 24) >> 24) * scale;
      else if (bits === 16) {
        const raw = le ? (bytes[o] | (bytes[o + 1] << 8)) : ((bytes[o] << 8) | bytes[o + 1]);
        v = ((raw << 16) >> 16) * scale;
      } else if (bits === 24) {
        const raw = le
          ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16))
          : ((bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2]);
        v = ((raw << 8) >> 8) * scale;
      } else if (bits === 32) {
        v = ((le ? u32le(bytes, o) : u32be(bytes, o)) | 0) * scale;
      } else throw new Error(`unsupported PCM width: ${bits} bits`);
      if (v > 1) v = 1; else if (v < -1) v = -1;
      out[c][i] = v;
    }
  }
}

/* ----------------------------------------------------------- demuxing -- */

function describe(container, { sampleRate, channels, bits, format, le, dataOffset, dataSize, lengths }) {
  if (!sampleRate) throw new Error(`${container}: no sample rate in the header`);
  if (!(channels >= 1)) throw new Error(`${container}: no channel count in the header`);
  if (!(bits >= 8)) throw new Error(`${container}: no bit depth in the header`);
  const blockAlign = (bits >> 3) * channels;
  const frameCount = Math.floor(dataSize / blockAlign);
  if (!frameCount) throw new Error(`${container}: no audio frames`);
  return {
    container,
    track: {
      codec: `pcm-${format}${bits}`,
      sampleRate, channels, description: null,
      sampleCount: frameCount, timescale: sampleRate,
    },
    // no `samples` array: PCM is byte-addressable, so a per-frame list would be
    // millions of objects to say something the header already says
    pcm: {
      format, bits, le, channels, blockAlign, sampleRate,
      dataOffset, dataSize, frameCount,
      // where the length fields live, for the cut to patch
      lengths,
      headerBytes: dataOffset,
    },
    durationUs: Math.round((frameCount / sampleRate) * 1e6),
    warnings: [],
  };
}

export function demuxWav(bytes) {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('not a WAV stream (no RIFF/WAVE)');
  }
  let p = 12, fmt = null, data = null;
  while (p + 8 <= bytes.length) {
    const id = ascii(bytes, p, 4);
    const size = u32le(bytes, p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      const tag = u16le(bytes, body);
      const channels = u16le(bytes, body + 2);
      const sampleRate = u32le(bytes, body + 4);
      const bits = u16le(bytes, body + 14);
      // 0xFFFE is WAVE_FORMAT_EXTENSIBLE; the real tag is the first two bytes of
      // the subformat GUID, after the 22-byte extension.
      const real = (tag === 0xfffe && size >= 40) ? u16le(bytes, body + 24) : tag;
      const format = real === 3 ? (bits === 64 ? 'f64' : 'f32') : (bits === 8 ? 'u8' : 'int');
      fmt = { channels, sampleRate, bits, format, le: true };
    } else if (id === 'data') {
      data = {
        offset: body,
        size: Math.min(size || (bytes.length - body), bytes.length - body),
        sizeAt: p + 4,
      };
    }
    p = body + size + (size & 1);              // chunks are word-aligned
  }
  if (!fmt) throw new Error('WAV has no fmt chunk');
  if (!data) throw new Error('WAV has no data chunk');
  return describe('wav', {
    ...fmt, dataOffset: data.offset, dataSize: data.size,
    lengths: { riffSizeAt: 4, dataSizeAt: data.sizeAt },
  });
}

export function demuxAiff(bytes) {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'FORM') throw new Error('not an AIFF file (no FORM)');
  const kind = ascii(bytes, 8, 4);
  if (kind !== 'AIFF' && kind !== 'AIFC') throw new Error(`unsupported IFF form "${kind}"`);
  let p = 12, comm = null, ssnd = null;
  while (p + 8 <= bytes.length) {
    const id = ascii(bytes, p, 4);
    const size = u32be(bytes, p + 4);
    const body = p + 8;
    if (id === 'COMM') {
      const compression = kind === 'AIFC' ? ascii(bytes, body + 18, 4) : 'NONE';
      if (compression !== 'NONE' && compression !== 'twos' && compression !== 'sowt') {
        throw new Error(`unsupported AIFF compression "${compression}"`);
      }
      comm = {
        channels: u16be(bytes, body),
        bits: u16be(bytes, body + 6),
        sampleRate: Math.round(extended80(bytes, body + 8)),
        format: u16be(bytes, body + 6) === 8 ? 'u8' : 'int',
        le: compression === 'sowt',
        framesAt: body + 2,
      };
    } else if (id === 'SSND') {
      const offset = u32be(bytes, body);
      ssnd = {
        offset: body + 8 + offset,
        size: size - 8 - offset,
        sizeAt: p + 4,
        offsetField: offset,
      };
    }
    p = body + size + (size & 1);
  }
  if (!comm) throw new Error('AIFF has no COMM chunk');
  if (!ssnd) throw new Error('AIFF has no SSND chunk');
  return describe('aiff', {
    ...comm, dataOffset: ssnd.offset, dataSize: ssnd.size,
    lengths: { formSizeAt: 4, ssndSizeAt: ssnd.sizeAt, framesAt: comm.framesAt, ssndOffset: ssnd.offsetField },
  });
}

/* ----------------------------------------------------------- decoding -- */

/**
 * Yield the PCM as AudioChunks — no decoder, no codec string, just arithmetic.
 * Chunked so nothing downstream has to hold a 250 MB allocation at once.
 */
export async function* decodePcm(bytes, demuxed, opts = {}) {
  const { pcm, track } = demuxed;
  const from = opts.fromSeconds !== undefined ? Math.max(0, Math.floor(opts.fromSeconds * track.sampleRate)) : 0;
  const to = opts.toSeconds !== undefined
    ? Math.min(pcm.frameCount, Math.ceil(opts.toSeconds * track.sampleRate))
    : pcm.frameCount;
  const chunkFrames = opts.framesPerChunk ?? 8192;

  for (let f = from; f < to; f += chunkFrames) {
    const n = Math.min(chunkFrames, to - f);
    const planes = [];
    for (let c = 0; c < pcm.channels; c++) planes.push(new Float32Array(n));
    readFrames(bytes, pcm.dataOffset + f * pcm.blockAlign, n, pcm, planes);
    yield {
      sampleRate: track.sampleRate,
      numberOfFrames: n,
      numberOfChannels: pcm.channels,
      format: 'f32-planar',
      data: planes,
      timestamp: Math.round((f / track.sampleRate) * 1e6),
    };
  }
}

/* ------------------------------------------------------------ cutting -- */

const normalize = (ranges) => (ranges ?? [])
  .map((r) => (Array.isArray(r) ? { start: r[0], end: r[1] } : r))
  .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
  .sort((a, b) => a.start - b.start);

/** Which frames survive, as merged [from, to) frame ranges. */
export function selectPcmFrames(pcm, ranges, { mode = 'remove' } = {}) {
  const span = normalize(ranges)
    .map((r) => [
      Math.max(0, Math.floor(r.start * pcm.sampleRate)),
      Math.min(pcm.frameCount, Math.ceil(r.end * pcm.sampleRate)),
    ])
    .filter(([a, b]) => b > a);

  const merged = [];
  for (const [a, b] of span) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  if (mode === 'keep') return merged;

  const kept = [];
  let cursor = 0;
  for (const [a, b] of merged) {
    if (a > cursor) kept.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < pcm.frameCount) kept.push([cursor, pcm.frameCount]);
  return kept;
}

/**
 * Write a new WAV/AIFF holding the kept frames.
 *
 * The original header is copied and its three length fields patched rather than
 * rebuilt, so any metadata chunks an editor wrote survive the cut — and PCM has
 * no encoder delay or padding to account for, so kept frames map one-to-one.
 */
export function muxPcm(bytes, demuxed, keptFrames) {
  const { pcm, container } = demuxed;
  const head = bytes.subarray(0, pcm.dataOffset);
  const totalFrames = keptFrames.reduce((n, [a, b]) => n + (b - a), 0);
  const dataBytes = totalFrames * pcm.blockAlign;

  const out = new Uint8Array(head.length + dataBytes);
  out.set(head, 0);

  let o = head.length;
  for (const [a, b] of keptFrames) {
    const from = pcm.dataOffset + a * pcm.blockAlign;
    const len = (b - a) * pcm.blockAlign;
    out.set(bytes.subarray(from, from + len), o);
    o += len;
  }

  const L = pcm.lengths;
  if (container === 'wav') {
    put32le(out, L.riffSizeAt, out.length - 8);
    put32le(out, L.dataSizeAt, dataBytes);
  } else {
    put32be(out, L.formSizeAt, out.length - 8);
    put32be(out, L.ssndSizeAt, dataBytes + 8 + (L.ssndOffset ?? 0));
    put32be(out, L.framesAt, totalFrames);
  }
  return out;
}
