/**
 * Container sniffing.
 *
 * WebCodecs decodes but does not demux, so the decoder package must know what
 * it is looking at before it can choose a path. Magic bytes only — cheap, and
 * enough to decide between the built-in demuxer and the ffmpeg fallback.
 */

const ascii = (b, o, s) => String.fromCharCode(...b.subarray(o, o + s));

/**
 * Read an EBML variable-length integer (the length prefix used throughout
 * Matroska), returning its value and how many bytes it occupied.
 *
 * The first byte's leading zero count gives the width: `0x88` is one byte
 * holding 8, `0x40 0x23` is two bytes holding 0x23. A leading zero byte is
 * reserved and means "unknown size", which no header field uses.
 */
function vint(bytes, at) {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  for (let mask = 0x80; mask && !(first & mask); mask >>= 1) length++;
  if (length > 8 || at + length > bytes.length) return null;
  let value = first & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i];
  return { value, length };
}

/**
 * Matroska and WebM share the EBML magic and are told apart only by the
 * `DocType` string inside the EBML header — the `42 82` element, which lands
 * around offset 24 in practice, past a 16-byte peek.
 *
 * @returns {string|null} lowercased DocType, or null if it is not within reach
 */
function ebmlDocType(bytes) {
  for (let i = 4; i < Math.min(bytes.length, 64) - 2; i++) {
    if (bytes[i] !== 0x42 || bytes[i + 1] !== 0x82) continue;
    const size = vint(bytes, i + 2);
    if (!size || i + 2 + size.length + size.value > bytes.length) return null;
    return ascii(bytes, i + 2 + size.length, size.value).toLowerCase();
  }
  return null;
}

/**
 * @param {Uint8Array} bytes  the first ~64 bytes of the file
 * @returns {'mp4'|'matroska'|'webm'|'wav'|'mp3'|'flac'|'ogg'|'aiff'|'unknown'}
 */
export function sniffContainer(bytes) {
  if (!bytes || bytes.length < 4) return 'unknown';

  // ISO base media (MP4/M4A/MOV): ....ftyp
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') return 'mp4';

  // Matroska / WebM: EBML header. Both are EBML, so the DocType decides which
  // name the rest of the package reports; a header too short to hold it is
  // reported as webm, the more common of the two on the web.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return ebmlDocType(bytes) === 'matroska' ? 'matroska' : 'webm';
  }

  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'wav';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'FORM' &&
      (ascii(bytes, 8, 4) === 'AIFF' || ascii(bytes, 8, 4) === 'AIFC')) return 'aiff';

  if (ascii(bytes, 0, 4) === 'fLaC') return 'flac';
  if (ascii(bytes, 0, 4) === 'OggS') return 'ogg';
  if (ascii(bytes, 0, 3) === 'ID3') return 'mp3';
  // MPEG audio frame sync (no ID3 tag)
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';

  return 'unknown';
}

/** Containers the built-in MP4 demuxer can handle. */
export const DEMUXABLE = new Set(['mp4']);

/** File extensions that usually mean MP4/M4A, for sources without magic bytes yet. */
export const MP4_EXTENSIONS = ['.mp4', '.m4a', '.m4v', '.mov', '.m4b', '.aac'];
