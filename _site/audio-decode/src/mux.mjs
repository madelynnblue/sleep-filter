/**
 * Minimal audio-only MP4 muxer.
 *
 * Deliberately small. Because the source and destination use the same codec, the
 * SampleDescription is copied **verbatim** — there is no esds re-serialisation
 * and therefore no chance of producing a subtly different decoder config. That
 * one decision removes most of a general muxer's complexity.
 *
 * Layout: [ftyp][moov][mdat]. moov first so the result is fast-start (playable
 * while downloading). All samples go in a single chunk, which keeps stco to one
 * entry and is valid for audio — seeking granularity is not worth the extra
 * machinery here.
 *
 * edts/elst is written when the original first sample survived, so AAC priming
 * is trimmed exactly as the source trimmed it.
 *
 * Tags are not parsed here: the caller passes the source's whole `udta` box and
 * it is embedded verbatim, so every atom type survives whether or not this code
 * knows what it means. One caveat that comes with copying it whole — a `chpl`
 * chapter list, if a source ever has one, describes the ORIGINAL timeline and
 * would need remapping.
 *
 * Pure JS, no dependencies, browser-safe.
 */

const MATRIX = new Uint8Array([
  0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
]);

const ascii = (s) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
};

const u16 = (n) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
const i32 = (n) => u32(n >>> 0);
const u64 = (n) => {
  const hi = Math.floor(n / 4294967296), lo = n >>> 0;
  return cat([u32(hi), u32(lo)]);
};
const u32 = (n) => new Uint8Array([
  (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff,
]);

function cat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Pack a large array of u32 without spreading it as arguments (62k samples
 *  overflows the stack). */
function u32blob(values) {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) dv.setUint32(i * 4, values[i]);
  return out;
}

function box(type, ...parts) {
  const body = cat(parts);
  return cat([u32(body.length + 8), ascii(type), body]);
}

function fullBox(type, version, flags, ...parts) {
  return box(type, new Uint8Array([
    version & 0xff, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff,
  ]), ...parts);
}

/** Collapse per-sample durations into stts runs. */
function stts(durations) {
  const runs = [];
  for (const d of durations) {
    const last = runs[runs.length - 1];
    if (last && last.delta === d) last.count++;
    else runs.push({ count: 1, delta: d });
  }
  const flat = new Array(runs.length * 2);
  for (let i = 0; i < runs.length; i++) { flat[i * 2] = runs[i].count; flat[i * 2 + 1] = runs[i].delta; }
  return fullBox('stts', 0, 0, u32(runs.length), u32blob(flat));
}

/**
 * Mux already-selected samples into an audio-only MP4.
 *
 * @param {Uint8Array} source      the original file (samples reference into it)
 * @param {object} track           { timescale, stsdRaw, sampleRate, channels }
 * @param {Array<{offset:number,size:number,duration:number}>} samples
 *        in presentation order; `duration` is in media-timescale units
 * @param {{movieTimescale?: number, editMediaTime?: number, udta?: Uint8Array}} [opts]
 *        editMediaTime: media-unit offset to skip at the start (AAC priming).
 *        Pass 0 when the original first sample was dropped.
 *        udta: the source's whole `udta` box, embedded verbatim so the output
 *        keeps the input's tags.
 * @returns {Uint8Array}
 */
export function muxAudioMp4(source, track, samples, opts = {}) {
  // Default the movie timescale to the MEDIA timescale: the edit list's
  // segment_duration is expressed in movie units, and this keeps it in the same
  // units as the sample durations it describes.
  const { movieTimescale = track.timescale, editMediaTime = 0, udta = null } = opts;
  if (!track?.stsdRaw?.length) throw new Error('muxAudioMp4: track.stsdRaw is required');
  if (!track?.timescale) throw new Error('muxAudioMp4: track.timescale is required');
  const mediaTimescale = track.timescale;

  const mediaDuration = samples.reduce((s, x) => s + x.duration, 0);
  const movieDuration = Math.round((mediaDuration / mediaTimescale) * movieTimescale);
  const sampleBytes = samples.reduce((s, x) => s + x.size, 0);

  const ftyp = box('ftyp', ascii('M4A '), u32(512), ascii('M4A '), ascii('isom'), ascii('mp42'));

  const buildMoov = (chunkOffset) => {
    // elst: skip the encoder priming, and declare the new (shorter) duration.
    const edts = editMediaTime > 0
      ? box('edts', fullBox('elst', 0, 0, u32(1),
          u32(mediaDuration), i32(editMediaTime), u16(1), u16(0)))
      : null;

    const trak = box('trak',
      fullBox('tkhd', 0, 7,
        u32(0), u32(0),                 // creation, modification
        u32(1),                         // track_ID
        u32(0),                         // reserved
        u32(movieDuration),
        u32(0), u32(0),                 // reserved
        u16(0), u16(0),                 // layer, alternate_group
        u16(0x0100),                    // volume
        u16(0),                         // reserved
        MATRIX,
        u32(0), u32(0)),                // width, height
      ...(edts ? [edts] : []),
      box('mdia',
        fullBox('mdhd', 0, 0,
          u32(0), u32(0),
          u32(mediaTimescale),
          u32(mediaDuration),
          u16(0x55c4),                  // 'und'
          u16(0)),
        fullBox('hdlr', 0, 0, u32(0), ascii('soun'), new Uint8Array(12), ascii('SoundHandler\0')),
        box('minf',
          fullBox('smhd', 0, 0, u16(0), u16(0)),
          box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
          box('stbl',
            // verbatim from the source: preserves the decoder configuration
            track.stsdRaw,
            stts(samples.map((s) => s.duration)),
            fullBox('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
            fullBox('stsz', 0, 0, u32(0), u32(samples.length), u32blob(samples.map((s) => s.size))),
            fullBox('stco', 0, 0, u32(1), u32(chunkOffset))))));

    return box('moov',
      fullBox('mvhd', 0, 0,
        u32(0), u32(0),
        u32(movieTimescale),
        u32(movieDuration),
        u32(0x00010000),                // rate 1.0
        u16(0x0100),                    // volume 1.0
        u16(0),
        u32(0), u32(0),
        MATRIX,
        new Uint8Array(24),
        u32(2)),                        // next_track_ID
      trak,
      // after trak, where Apple puts it
      ...(udta ? [udta] : []));
  };

  // Two passes: box sizes do not depend on the offset value, so measuring with a
  // placeholder gives the real offset without a fixpoint search.
  const moovSized = buildMoov(0);
  const chunkOffset = ftyp.length + moovSized.length + 8;   // + mdat header
  const moov = buildMoov(chunkOffset);
  if (moov.length !== moovSized.length) {
    throw new Error('muxAudioMp4: moov size changed between passes — offset would be wrong');
  }

  const out = new Uint8Array(ftyp.length + moov.length + 8 + sampleBytes);
  let o = 0;
  out.set(ftyp, o); o += ftyp.length;
  out.set(moov, o); o += moov.length;
  out.set(u32(sampleBytes + 8), o); o += 4;
  out.set(ascii('mdat'), o); o += 4;
  for (const s of samples) {
    out.set(source.subarray(s.offset, s.offset + s.size), o);
    o += s.size;
  }
  return out;
}
