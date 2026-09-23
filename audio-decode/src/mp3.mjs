/**
 * MPEG audio (MP3): demux to frames, and re-mux a subset of them.
 *
 * MP3 frames are self-delimiting — a 4-byte header gives the bitrate, sample
 * rate and padding, which is enough to compute the frame length exactly — so
 * unlike FLAC this needs no scanning for the next sync. Walk one frame, compute
 * its length, repeat.
 *
 * The one caveat on cutting: MP3 has a bit reservoir, so a frame may reference
 * spare bytes carried in a previous frame. Whole-frame cutting can therefore
 * leave the first kept frame after a cut with a fraction of a frame of wrong
 * data. It is a few milliseconds and it is inherent to frame-splicing MP3
 * without re-encoding; it is noted rather than hidden.
 *
 * Pure JS, browser-safe.
 */

const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

const BITRATES = {
  // [version][layer] -> kbps by index 1..14 (0 = free, 15 = invalid)
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const SAMPLES_PER_FRAME = { 1: { 1: 384, 2: 1152, 3: 1152 }, 2: { 1: 384, 2: 1152, 3: 576 }, 0: { 1: 384, 2: 1152, 3: 576 } };

/** Parse a frame header at `pos`. @returns {{size,samples,sampleRate,channels,bitrate}|null} */
function parseFrameHeader(bytes, pos) {
  if (pos + 4 > bytes.length) return null;
  if (bytes[pos] !== 0xff || (bytes[pos + 1] & 0xe0) !== 0xe0) return null;

  const verBits = (bytes[pos + 1] >> 3) & 0x03;     // 0 = 2.5, 2 = 2, 3 = 1
  const layerBits = (bytes[pos + 1] >> 1) & 0x03;   // 1 = III, 2 = II, 3 = I
  if (verBits === 1 || layerBits === 0) return null;
  const version = verBits === 3 ? 1 : verBits === 2 ? 2 : 0;
  const layer = 4 - layerBits;                      // 1, 2 or 3

  const bitrateIndex = (bytes[pos + 2] >> 4) & 0x0f;
  const rateIndex = (bytes[pos + 2] >> 2) & 0x03;
  const padding = (bytes[pos + 2] >> 1) & 0x01;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;

  const table = BITRATES[`${version === 1 ? 1 : 2}-${layer}`];
  const bitrate = table[bitrateIndex] * 1000;
  const sampleRate = RATES[version][rateIndex];
  if (!bitrate || !sampleRate) return null;

  const samples = SAMPLES_PER_FRAME[version][layer];
  // Layer I is counted in 4-byte slots; II and III use the same formula, with the
  // MPEG2/2.5 coefficient halved because their frames carry half the samples.
  const size = layer === 1
    ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
    : Math.floor(((version === 1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  if (size < 4) return null;

  const channels = ((bytes[pos + 3] >> 6) & 0x03) === 3 ? 1 : 2;
  return { size, samples, sampleRate, channels, bitrate };
}

/** Where the audio starts: past any ID3v2 tag, and past leading junk if need be. */
function findFirstFrame(bytes) {
  let p = 0;
  if (bytes.length > 10 && ascii(bytes, 0, 3) === 'ID3') {
    // syncsafe 28-bit size
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
                 ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    p = 10 + size + ((bytes[5] & 0x10) ? 10 : 0);      // + footer when present
  }
  for (let q = p; q + 4 <= bytes.length && q < p + 65536; q++) {
    if (parseFrameHeader(bytes, q)) return q;
  }
  return -1;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{container, track, samples, durationUs, headerEnd, warnings}}
 */
export function demuxMp3(bytes) {
  const warnings = [];
  const start = findFirstFrame(bytes);
  if (start < 0) throw new Error('no MPEG audio frame found (not an MP3?)');

  const samples = [];
  let pos = start;
  let t = 0;
  let sampleRate = 0, channels = 0, freeFrames = 0;

  while (pos + 4 <= bytes.length) {
    // a trailing ID3v1 or APE tag is not audio
    if (ascii(bytes, pos, 3) === 'TAG' && pos + 128 >= bytes.length) break;
    if (ascii(bytes, pos, 8) === 'APETAGEX') break;

    const h = parseFrameHeader(bytes, pos);
    if (!h) {
      // one bad frame is common at a boundary; give up only if it never recovers
      if (++freeFrames > 8) { warnings.push(`stopped at byte ${pos}: no valid frame header`); break; }
      pos += 1;
      continue;
    }
    freeFrames = 0;
    if (pos + h.size > bytes.length) break;             // truncated tail
    if (!sampleRate) { sampleRate = h.sampleRate; channels = h.channels; }

    samples.push({ offset: pos, size: h.size, duration: h.samples, timestamp: t });
    t += h.samples;
    pos += h.size;
  }
  if (!samples.length) throw new Error('MP3 has no usable frames');

  return {
    container: 'mp3',
    track: {
      codec: 'mp3',
      sampleRate,
      channels,
      description: null,                                // MP3 needs none
      sampleCount: samples.length,
      timescale: sampleRate,
    },
    samples,
    durationUs: Math.round((t / sampleRate) * 1e6),
    headerEnd: start,
    warnings,
  };
}

/**
 * Re-mux kept MP3 frames, keeping whatever ID3v2 tag preceded them.
 *
 * The tag's size field is left alone: it describes the tag, not the audio, so
 * it stays correct however many frames follow.
 */
export function muxMp3(bytes, demuxed, kept) {
  const head = bytes.subarray(0, demuxed.headerEnd);
  const total = kept.reduce((n, s) => n + s.size, 0);
  const out = new Uint8Array(head.length + total);
  out.set(head, 0);

  let o = head.length;
  for (const s of kept) { out.set(bytes.subarray(s.offset, s.offset + s.size), o); o += s.size; }

  // LAME puts a Xing/Info header inside the first frame, declaring the frame
  // count, byte count and a 100-byte seek table for the WHOLE original stream.
  // Left alone, players report the uncut duration — a 60s file that claims 90s.
  patchXing(out, head.length, kept.length);
  return out;
}

/**
 * Rewrite the Xing/Info header in the first output frame, if there is one.
 *
 * The seek table is zeroed rather than recomputed: a wrong TOC makes seeking
 * actively wrong, while an absent one makes players fall back to bitrate-based
 * seeking, which is merely approximate.
 */
function patchXing(out, firstFrame, frames) {
  if (firstFrame + 4 >= out.length) return;
  const limit = Math.min(firstFrame + 200, out.length - 4);
  let at = -1;
  for (let i = firstFrame + 4; i <= limit; i++) {
    const m = String.fromCharCode(out[i], out[i + 1], out[i + 2], out[i + 3]);
    if (m === 'Xing' || m === 'Info') { at = i; break; }
  }
  if (at < 0) return;

  const u32 = (o) => (out[o] << 24 | out[o + 1] << 16 | out[o + 2] << 8 | out[o + 3]) >>> 0;
  const put = (o, v) => {
    out[o] = (v >>> 24) & 0xff; out[o + 1] = (v >>> 16) & 0xff;
    out[o + 2] = (v >>> 8) & 0xff; out[o + 3] = v & 0xff;
  };
  const flags = u32(at + 4);
  if (flags & 0x0001) put(at + 8, frames);
  if (flags & 0x0002) put(at + 12, out.length);
  if (flags & 0x0004) for (let i = 0; i < 100; i++) out[at + 16 + i] = 0;
}
