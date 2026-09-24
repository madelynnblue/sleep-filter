/**
 * Native FLAC: demux to frames, and re-mux a subset of them.
 *
 * FLAC is the easy case for lossless cutting. Frames are independent — there is
 * no bit reservoir and no inter-frame prediction — so dropping whole frames and
 * concatenating the rest is genuinely lossless, exactly as dropping whole AAC
 * frames is for MP4.
 *
 * What has to be right is the frame boundaries, and nothing in the stream marks
 * them: unlike MP4 there is no sample table, and a frame header does not carry
 * the frame's length. The only way through is to parse each header and scan for
 * the next valid one, which is what this does. Header candidates are checked
 * structurally AND against the header CRC-8, because a bare sync-word scan finds
 * false positives inside frame data.
 *
 * Pure JS, browser-safe.
 */

const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

/** CRC-8, polynomial x^8 + x^2 + x + 1 — FLAC's header check. */
const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

function crc8(bytes, from, to) {
  let c = 0;
  for (let i = from; i < to; i++) c = CRC8_TABLE[c ^ bytes[i]];
  return c;
}

const BLOCK_SIZES = [0, 192, 576, 1152, 2304, 4608, -1, -2, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const SAMPLE_RATES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000, -1, -2, -3, -4];

/**
 * Parse a FLAC frame header at `pos`.
 * @returns {{samples: number, headerLen: number}|null}
 */
function parseFrameHeader(bytes, pos) {
  if (pos + 5 > bytes.length) return null;
  if (bytes[pos] !== 0xff || (bytes[pos + 1] & 0xfc) !== 0xf8) return null;
  if (bytes[pos + 1] & 0x02) return null;                 // reserved bit must be 0
  const blockCode = (bytes[pos + 2] >> 4) & 0x0f;
  const rateCode = bytes[pos + 2] & 0x0f;
  const chanCode = (bytes[pos + 3] >> 4) & 0x0f;
  const sizeCode = (bytes[pos + 3] >> 1) & 0x07;
  if (bytes[pos + 3] & 0x01) return null;                 // reserved bit
  if (blockCode === 0 || rateCode === 15 || sizeCode === 3) return null;
  if (chanCode > 10) return null;
  if (BLOCK_SIZES[blockCode] === 0 || SAMPLE_RATES[rateCode] === 0) return null;

  let p = pos + 4;
  // UTF-8 coded frame or sample number
  const first = bytes[p];
  let extra = first < 0x80 ? 0 : first < 0xc0 ? -1 : first < 0xe0 ? 1 : first < 0xf0 ? 2 : first < 0xf8 ? 3 : 4;
  if (extra < 0) return null;
  p += 1 + extra;
  if (p > bytes.length) return null;

  let samples = BLOCK_SIZES[blockCode];
  if (blockCode === 6) { samples = bytes[p] + 1; p += 1; }
  else if (blockCode === 7) { samples = ((bytes[p] << 8) | bytes[p + 1]) + 1; p += 2; }
  if (blockCode === 6 || blockCode === 7) { /* read above */ }

  if (rateCode === 12) p += 1;
  else if (rateCode === 13 || rateCode === 14) p += 2;
  if (p >= bytes.length) return null;

  const headerLen = p + 1 - pos;                           // + the CRC-8 byte
  if (pos + headerLen > bytes.length) return null;
  if (crc8(bytes, pos, p) !== bytes[p]) return null;
  return { samples, headerLen };
}

/**
 * @param {Uint8Array} bytes
 * @returns {{container, track, samples, durationUs, headerEnd, streamInfoStart, warnings}}
 */
export function demuxFlac(bytes) {
  const warnings = [];
  if (bytes.length < 8 || ascii(bytes, 0, 4) !== 'fLaC') throw new Error('not a FLAC stream (no fLaC marker)');

  let p = 4;
  let streamInfoStart = -1, streamInfo = null, last = false;
  while (!last) {
    if (p + 4 > bytes.length) throw new Error('FLAC metadata is truncated');
    const b = bytes[p];
    last = (b & 0x80) !== 0;
    const type = b & 0x7f;
    const len = (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    if (type === 0) {
      if (len < 34) throw new Error('FLAC STREAMINFO is too short');
      streamInfoStart = p + 4;
      streamInfo = bytes.subarray(p + 4, p + 4 + len);
    }
    p += 4 + len;
  }
  if (!streamInfo) throw new Error('FLAC has no STREAMINFO block');

  const u16 = (o) => (streamInfo[o] << 8) | streamInfo[o + 1];
  const sampleRate = (streamInfo[10] << 12) | (streamInfo[11] << 4) | (streamInfo[12] >> 4);
  const channels = ((streamInfo[12] >> 1) & 0x07) + 1;
  const totalSamples = ((streamInfo[13] & 0x0f) * 4294967296) +
    (streamInfo[14] << 24) + (streamInfo[15] << 16) + (streamInfo[16] << 8) + streamInfo[17];
  if (!sampleRate) throw new Error('FLAC STREAMINFO has no sample rate');
  void u16;

  const frameStart = p;
  const samples = [];
  let t = 0;
  let pos = frameStart;
  while (pos + 5 <= bytes.length) {
    const h = parseFrameHeader(bytes, pos);
    if (!h) break;
    let next = -1;
    for (let q = pos + h.headerLen; q + 5 <= bytes.length; q++) {
      if (parseFrameHeader(bytes, q)) { next = q; break; }
    }
    const end = next < 0 ? bytes.length : next;
    samples.push({ offset: pos, size: end - pos, duration: h.samples, timestamp: t });
    t += h.samples;
    if (next < 0) break;
    pos = next;
  }
  if (!samples.length) throw new Error('FLAC has no decodable frames');

  if (totalSamples && t !== totalSamples) {
    warnings.push(`FLAC STREAMINFO says ${totalSamples} samples, frames sum to ${t}`);
  }

  return {
    container: 'flac',
    // WebCodecs takes the STREAMINFO block itself as the decoder description.
    track: {
      codec: 'flac',
      sampleRate,
      channels,
      description: streamInfo.slice(),
      sampleCount: samples.length,
      timescale: sampleRate,
    },
    samples,
    durationUs: Math.round((t / sampleRate) * 1e6),
    // everything before the first frame: the marker and all metadata blocks
    headerEnd: frameStart,
    streamInfoStart,
    warnings,
  };
}

/**
 * Re-mux a subset of a FLAC stream's frames.
 *
 * The metadata blocks are copied through unchanged except for STREAMINFO, whose
 * total-sample count is rewritten and whose MD5 is zeroed — the signature of the
 * audio that is no longer there, and a mismatch is worse than an absent one.
 */
export function muxFlac(bytes, demuxed, kept) {
  const head = bytes.subarray(0, demuxed.headerEnd);
  const out = new Uint8Array(head.length + kept.reduce((n, s) => n + s.size, 0));
  out.set(head, 0);

  if (demuxed.streamInfoStart >= 0) {
    const si = demuxed.streamInfoStart;
    const total = kept.reduce((n, s) => n + s.duration, 0);
    out[si + 13] = (out[si + 13] & 0xf0) | ((total / 4294967296) & 0x0f);
    out[si + 14] = (total >>> 24) & 0xff;
    out[si + 15] = (total >>> 16) & 0xff;
    out[si + 16] = (total >>> 8) & 0xff;
    out[si + 17] = total & 0xff;
    for (let i = 18; i < 34; i++) out[si + i] = 0;       // MD5 no longer applies
  }

  let o = head.length;
  for (const s of kept) { out.set(bytes.subarray(s.offset, s.offset + s.size), o); o += s.size; }
  return out;
}
