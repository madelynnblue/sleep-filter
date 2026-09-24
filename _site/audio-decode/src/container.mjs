/**
 * Container sniffing.
 *
 * WebCodecs decodes but does not demux, so the decoder package must know what
 * it is looking at before it can choose a path. Magic bytes only — cheap, and
 * enough to decide between the built-in demuxer and the ffmpeg fallback.
 */

const ascii = (b, o, s) => String.fromCharCode(...b.subarray(o, o + s));

/**
 * @param {Uint8Array} bytes  at least the first ~16 bytes
 * @returns {'mp4'|'webm'|'wav'|'mp3'|'flac'|'ogg'|'aiff'|'unknown'}
 */
export function sniffContainer(bytes) {
  if (!bytes || bytes.length < 4) return 'unknown';

  // ISO base media (MP4/M4A/MOV): ....ftyp
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') return 'mp4';

  // Matroska / WebM: EBML header
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';

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
