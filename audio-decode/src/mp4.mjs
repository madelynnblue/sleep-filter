/**
 * Minimal ISO-BMFF (MP4 / M4A / MOV) demuxer.
 *
 * WebCodecs decodes but deliberately does not demux: it wants
 * `EncodedAudioChunk`s plus a codec description. This module supplies both by
 * reading the sample tables directly, which is what makes the browser path
 * dependency-free instead of pulling in a 30 MB ffmpeg.wasm build for the
 * common case.
 *
 * Scope: non-fragmented MP4 with an audio track. Fragmented MP4 (moof/mvex) and
 * exotic codecs are detected and reported rather than silently mangled — the
 * caller falls back to ffmpeg.
 *
 * Pure JS, no dependencies, browser-safe.
 */

/* ------------------------------------------------------------ primitives -- */

const u32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
const u16 = (b, o) => (b[o] << 8 | b[o + 1]) >>> 0;
const i16 = (b, o) => ((b[o] << 8 | b[o + 1]) << 16) >> 16;
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Iterate sibling boxes in [start, end). */
export function* boxes(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(buf, p);
    const type = fourcc(buf, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = u64(buf, p + 8);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) return;   // malformed / truncated
    yield { type, start: p, payload: p + header, end: p + size };
    p += size;
  }
}

function findBox(buf, start, end, type) {
  for (const b of boxes(buf, start, end)) if (b.type === type) return b;
  return null;
}

function findPath(buf, start, end, path) {
  let s = start, e = end, box = null;
  for (const t of path) {
    box = findBox(buf, s, e, t);
    if (!box) return null;
    s = box.payload; e = box.end;
  }
  return box;
}

/** Big-endian bit reader, for AudioSpecificConfig. */
class Bits {
  constructor(bytes, byteOffset = 0) { this.b = bytes; this.p = byteOffset * 8; }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.p >> 3];
      if (byte === undefined) throw new Error('bit reader overrun');
      v = (v << 1) | ((byte >> (7 - (this.p & 7))) & 1);
      this.p++;
    }
    return v;
  }
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350, 0, 0, 0];

/** AudioSpecificConfig -> { audioObjectType, sampleRate, channels }. */
export function parseAudioSpecificConfig(bytes) {
  const r = new Bits(bytes, 0);
  let aot = r.read(5);
  if (aot === 31) aot = 32 + r.read(6);
  const sfi = r.read(4);
  let sampleRate = sfi === 15 ? r.read(24) : AAC_RATES[sfi];
  const channels = r.read(4);
  return { audioObjectType: aot, sampleRate, channels };
}

const AOT_CODEC = {
  1: 'mp4a.40.1', 2: 'mp4a.40.2', 3: 'mp4a.40.3', 4: 'mp4a.40.4',
  5: 'mp4a.40.5', 6: 'mp4a.40.6', 17: 'mp4a.40.17', 20: 'mp4a.40.20',
  23: 'mp4a.40.23', 29: 'mp4a.40.29', 39: 'mp4a.40.39', 42: 'mp4a.40.42',
};

/** Parse an esds (ES_Descriptor) and pull out the DecoderSpecificInfo. */
function parseEsds(buf, start, end) {
  // FullBox: version/flags, then nested MPEG-4 descriptors.
  //
  // The nesting matters: ES_Descriptor CONTAINS DecoderConfigDescriptor, which
  // in turn CONTAINS DecoderSpecificInfo. Jumping to the end of a descriptor's
  // body after reading its header skips the nested ones — which is exactly the
  // bug that made this return null for every AAC track. Each branch therefore
  // advances only past its own header and lets the loop descend.
  let p = start + 4;
  const readLen = () => {
    let len = 0, b;
    do { b = buf[p++]; len = (len << 7) | (b & 0x7f); } while (b & 0x80);
    return len;
  };
  const result = { objectTypeIndication: null, asc: null };
  while (p < end) {
    const tag = buf[p++];
    const len = readLen();
    const bodyEnd = Math.min(p + len, end);
    if (tag === 0x03) {                      // ES_Descriptor
      p += 2;                                // ES_ID
      const flags = buf[p++];
      if (flags & 0x80) p += 2;              // streamDependenceFlag
      if (flags & 0x40) p += 1 + buf[p];     // URL_Flag
      if (flags & 0x20) p += 2;              // OCRstreamFlag
      // nested DecoderConfigDescriptor follows immediately
    } else if (tag === 0x04) {               // DecoderConfigDescriptor
      result.objectTypeIndication = buf[p];
      p += 13;                               // oti + streamType + bufferSize + bitrates
      // nested DecoderSpecificInfo follows immediately
    } else if (tag === 0x05) {               // DecoderSpecificInfo
      result.asc = buf.slice(p, bodyEnd);
      break;
    } else {
      break;
    }
  }
  return result;
}

/* ----------------------------------------------------------- sample tables -- */

function parseStts(buf, b) {
  if (!b) return [];
  const n = u32(buf, b.payload + 4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = b.payload + 8 + i * 8;
    out.push({ count: u32(buf, o), delta: u32(buf, o + 4) });
  }
  return out;
}

function parseStsc(buf, b) {
  if (!b) return [];
  const n = u32(buf, b.payload + 4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = b.payload + 8 + i * 12;
    out.push({ firstChunk: u32(buf, o), samplesPerChunk: u32(buf, o + 4), sdi: u32(buf, o + 8) });
  }
  return out;
}

function parseStsz(buf, b) {
  if (!b) return { uniform: 0, sizes: [] };
  const uniform = u32(buf, b.payload + 4);
  const count = u32(buf, b.payload + 8);
  const sizes = new Uint32Array(count);
  if (uniform === 0) {
    for (let i = 0; i < count; i++) sizes[i] = u32(buf, b.payload + 12 + i * 4);
  } else {
    sizes.fill(uniform);
  }
  return { uniform, sizes };
}

function parseChunkOffsets(buf, stco, co64) {
  const b = stco || co64;
  if (!b) return new Uint32Array(0);
  const n = u32(buf, b.payload + 4);
  const out = new Float64Array(n);
  const wide = !!co64;
  for (let i = 0; i < n; i++) {
    const o = b.payload + 8 + i * (wide ? 8 : 4);
    out[i] = wide ? u64(buf, o) : u32(buf, o);
  }
  return out;
}

/** Expand stsc/stts/stsz/stco into a flat sample list. */
function buildSamples(buf, stbl, timescale) {
  const b = (t) => findBox(buf, stbl.payload, stbl.end, t);
  const stts = parseStts(buf, b('stts'));
  const stsc = parseStsc(buf, b('stsc'));
  const { sizes } = parseStsz(buf, b('stsz'));
  const offsets = parseChunkOffsets(buf, b('stco'), b('co64'));
  if (!stsc.length || !offsets.length || !sizes.length) return [];

  const samples = new Array(sizes.length);
  let si = 0;
  // stts run cursor
  let run = 0, runLeft = stts.length ? stts[0].count : 0;
  let t = 0;
  const nextDelta = () => {
    if (!stts.length) return 0;
    while (runLeft === 0 && run + 1 < stts.length) { run++; runLeft = stts[run].count; }
    if (runLeft === 0) return stts[stts.length - 1].delta;
    runLeft--;
    return stts[run].delta;
  };

  for (let ci = 0; ci < offsets.length && si < sizes.length; ci++) {
    // samples-per-chunk for chunk number (ci+1)
    let spc = stsc[0].samplesPerChunk;
    for (let k = 0; k < stsc.length; k++) {
      if (ci + 1 >= stsc[k].firstChunk) spc = stsc[k].samplesPerChunk;
      else break;
    }
    let off = offsets[ci];
    for (let k = 0; k < spc && si < sizes.length; k++) {
      const size = sizes[si];
      const delta = nextDelta();
      samples[si] = { offset: off, size, timestamp: t, duration: delta };
      off += size;
      t += delta;
      si++;
    }
  }
  // convert to microseconds
  const us = 1e6 / timescale;
  for (const s of samples) {
    if (!s) continue;
    s.timestampUs = Math.round(s.timestamp * us);
    s.durationUs = Math.round(s.duration * us);
  }
  return samples.filter(Boolean);
}

/* ---------------------------------------------------------------- tracks -- */

const AUDIO_SAMPLE_ENTRIES = new Set(['mp4a', 'Opus', 'fLaC', 'alac', 'ac-3', 'ec-3', 'twos', 'sowt', 'lpcm']);

const ENTRY_CODEC = {
  Opus: 'opus', fLaC: 'flac', alac: 'alac', 'ac-3': 'ac-3', 'ec-3': 'ec-3',
  twos: 'pcm-s16be', sowt: 'pcm-s16le', lpcm: 'pcm',
};

function parseAudioSampleEntry(buf, entry) {
  // AudioSampleEntry: 8 reserved+dri, 8 version/revision/vendor,
  // 2 channelcount, 2 samplesize, 2 predefined, 2 reserved, 4 samplerate(16.16)
  const o = entry.payload;
  const channels = u16(buf, o + 16);
  const sampleSize = u16(buf, o + 18);
  const sampleRate = u32(buf, o + 24) >>> 16;
  const childStart = o + 28;

  let codec = ENTRY_CODEC[entry.type] ?? null;
  let description = null;
  let ascSampleRate = null, ascChannels = null;

  const esds = findBox(buf, childStart, entry.end, 'esds');
  if (esds) {
    const { objectTypeIndication, asc } = parseEsds(buf, esds.payload, esds.end);
    if (asc && asc.length) {
      description = asc;
      try {
        const cfg = parseAudioSpecificConfig(asc);
        ascSampleRate = cfg.sampleRate || null;
        ascChannels = cfg.channels || null;
        codec = AOT_CODEC[cfg.audioObjectType] ?? (objectTypeIndication === 0x40 ? 'mp4a.40.2' : null);
      } catch { /* fall through to the oti default */ }
    }
    if (!codec && objectTypeIndication === 0x40) codec = 'mp4a.40.2';
  }
  // dOps / dfLa also carry config; for now report the codec and let the caller decide
  const dOps = findBox(buf, childStart, entry.end, 'dOps');
  if (dOps && !description) description = buf.slice(dOps.payload + 4, dOps.end);

  return {
    codec,
    sampleEntry: entry.type,
    sampleRate: ascSampleRate || sampleRate,
    channels: ascChannels || channels,
    sampleSize,
    description,
  };
}

function parseTrack(buf, trak) {
  const mdia = findBox(buf, trak.payload, trak.end, 'mdia');
  if (!mdia) return null;
  const hdlr = findBox(buf, mdia.payload, mdia.end, 'hdlr');
  if (!hdlr) return null;
  const handler = fourcc(buf, hdlr.payload + 8);

  const mdhd = findBox(buf, mdia.payload, mdia.end, 'mdhd');
  let timescale = 0, duration = 0, version = 0;
  if (mdhd) {
    version = buf[mdhd.payload];
    if (version === 1) {
      timescale = u32(buf, mdhd.payload + 20);
      duration = u64(buf, mdhd.payload + 24);
    } else {
      timescale = u32(buf, mdhd.payload + 12);
      duration = u32(buf, mdhd.payload + 16);
    }
  }

  const minf = findBox(buf, mdia.payload, mdia.end, 'minf');
  const stbl = minf ? findBox(buf, minf.payload, minf.end, 'stbl') : null;
  if (!stbl) return { handler, timescale, duration };

  const stsd = findBox(buf, stbl.payload, stbl.end, 'stsd');
  let audio = null;
  if (stsd) {
    const count = u32(buf, stsd.payload + 4);
    let p = stsd.payload + 8;
    for (let i = 0; i < count && p + 8 <= stsd.end; i++) {
      const size = u32(buf, p);
      const type = fourcc(buf, p + 4);
      const entry = { type, payload: p + 8, end: p + size };
      if (AUDIO_SAMPLE_ENTRIES.has(type)) { audio = parseAudioSampleEntry(buf, entry); break; }
      p += size;
    }
  }

  // Edit list: the first entry's media_time is the AAC priming trim. Without
  // it a re-muxed file decodes offset by the encoder delay (measured: 2048
  // media units, enough to make otherwise-identical audio differ completely).
  let editMediaTime = 0;
  const edts = findBox(buf, trak.payload, trak.end, 'edts');
  if (edts) {
    const elst = findBox(buf, edts.payload, edts.end, 'elst');
    if (elst && u32(buf, elst.payload + 4) >= 1) {
      const version = buf[elst.payload];
      editMediaTime = version === 1
        ? (u32(buf, elst.payload + 16) | 0)
        : (u32(buf, elst.payload + 12) | 0);
    }
  }

  const samples = audio ? buildSamples(buf, stbl, timescale || 1) : [];
  // Keep the SampleDescription verbatim: re-muxing can then reuse the decoder
  // configuration byte-for-byte instead of re-serialising esds and risking a
  // subtly different config.
  const stsdRaw = stsd ? buf.slice(stsd.start, stsd.end) : null;
  return { handler, timescale, duration, audio, samples, stsdRaw, editMediaTime };
}

/**
 * Demux an MP4/M4A buffer.
 * @param {Uint8Array} buf  the whole file
 * @returns {{ container, fragmented, durationUs, track, samples, warnings }}
 */
export function demuxMp4(buf) {
  const warnings = [];
  const moov = findBox(buf, 0, buf.length, 'moov');
  if (!moov) throw new Error('not an MP4: no moov box (fragmented-only or truncated file?)');

  const fragmented = !!findBox(buf, moov.payload, moov.end, 'mvex');
  if (fragmented) warnings.push('fragmented MP4 (mvex present) — sample tables live in moof boxes, not supported');

  let chosen = null;
  const all = [];
  for (const trak of boxes(buf, moov.payload, moov.end)) {
    if (trak.type !== 'trak') continue;
    const t = parseTrack(buf, trak);
    if (!t) continue;
    all.push(t);
    if (!chosen && t.handler === 'soun' && t.samples.length) chosen = t;
  }
  if (!chosen) {
    const handlers = all.map((t) => t.handler).join(', ') || 'none';
    throw new Error(`no decodable audio track found (track handlers: ${handlers})`);
  }
  if (chosen.audio && !chosen.audio.codec) {
    warnings.push(`unrecognised audio sample entry "${chosen.audio.sampleEntry}" — codec string unknown`);
  }

  const durationUs = chosen.timescale
    ? Math.round((chosen.duration / chosen.timescale) * 1e6)
    : (chosen.samples.at(-1)?.timestampUs ?? 0) + (chosen.samples.at(-1)?.durationUs ?? 0);

  const udta = findBox(buf, moov.payload, moov.end, 'udta');

  return {
    container: 'mp4',
    fragmented,
    durationUs,
    // iTunes-style tags, chapters and whatever else the file carries in udta.
    // Handed to the muxer as raw bytes: re-serialising a tag list means
    // understanding every atom type, and anything unrecognised would be silently
    // dropped.
    udtaRaw: udta ? buf.subarray(udta.start, udta.end) : null,
    track: {
      codec: chosen.audio?.codec ?? null,
      sampleRate: chosen.audio?.sampleRate ?? 0,
      channels: chosen.audio?.channels ?? 0,
      description: chosen.audio?.description ?? null,
      sampleCount: chosen.samples.length,
      // enough to re-mux this track without touching the codec config
      timescale: chosen.timescale,
      stsdRaw: chosen.stsdRaw,
      editMediaTime: chosen.editMediaTime ?? 0,
    },
    samples: chosen.samples,
    warnings,
  };
}

/** Is this buffer a complete (non-truncated) MP4? moov may be at either end. */
export function isCompleteMp4(buf) {
  return !!findBox(buf, 0, buf.length, 'moov') || !!findBox(buf, 0, buf.length, 'moof');
}
