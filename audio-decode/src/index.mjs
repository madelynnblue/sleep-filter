/**
 * audio-decode — encoded audio -> AudioChunk stream.
 *
 * The other half of the boundary that music-analysis deliberately does not
 * cross. Two backends, chosen automatically:
 *
 *   webcodecs  a built-in demuxer + WebCodecs AudioDecoder. No external binary,
 *              no install. Handles non-fragmented MP4/M4A, which is what the
 *              common case actually is, plus native FLAC, MPEG audio, WAV/AIFF
 *              PCM — and Matroska/WebM, whose demuxer is vendored rather than
 *              written here (see matroska.mjs).
 *   ffmpeg     child-process fallback (Node). Covers every other container and
 *              codec, plus fragmented MP4.
 *
 *   import { openAudioFile } from 'audio-decode';
 *   const { info, chunks } = await openAudioFile(file);
 *   for await (const chunk of chunks()) analysis.addChunk(chunk);
 */

import { sniffContainer } from './container.mjs';
import { demuxMp4 } from './mp4.mjs';
import { demuxFlac, muxFlac } from './flac.mjs';
import { demuxMp3, muxMp3 } from './mp3.mjs';
import { demuxWav, demuxAiff, decodePcm, selectPcmFrames, muxPcm } from './pcm.mjs';
import { decodeWithWebCodecs } from './webcodecs.mjs';
import { openMatroska, isNativePcm } from './matroska.mjs';
import { readSource, writeTempFile, HEAD_BYTES } from './source.mjs';

export { sniffContainer, MP4_EXTENSIONS } from './container.mjs';
export { demuxMp4, parseAudioSpecificConfig, readTags, readTagsFromMoov } from './mp4.mjs';
export { demuxFlac, muxFlac } from './flac.mjs';
export { demuxMp3, muxMp3 } from './mp3.mjs';
export { demuxWav, demuxAiff, decodePcm, selectPcmFrames, muxPcm } from './pcm.mjs';
export { decodeWithWebCodecs, decodeMp4WithWebCodecs, audioDataToChunk } from './webcodecs.mjs';
export { openMatroska, isNativePcm } from './matroska.mjs';
export { readSource } from './source.mjs';
export { muxAudioMp4 } from './mux.mjs';
export {
  cutAudio, selectSamples, normalizeRanges, rangesFromSegments, outputExtensionFor,
} from './cut.mjs';

const isNode = () => typeof process !== 'undefined' && !!process.versions?.node;

/** Node's ffmpeg backend, loaded lazily so browser bundles never see node: imports. */
async function loadFfmpeg() {
  if (!isNode()) return null;
  try {
    return await import('./ffmpeg.node.mjs');
  } catch {
    return null;
  }
}

/** EBML containers: Matroska and WebM, told apart by the header's DocType. */
const EBML = ['matroska', 'webm'];

/**
 * Does the built-in path apply to this buffer?
 *
 * Four containers are handled natively, plus the EBML pair (Matroska/WebM),
 * which has its own demuxer and is opened separately. Everything else — Ogg,
 * WMA, AVI, anything unrecognised — still needs a decoder that is not here, and
 * says so rather than failing obscurely.
 */
function builtInViable(bytes, head, opts) {
  const container = sniffContainer(head);
  if (opts.forceFfmpeg) return null;
  // The EBML path cannot be probed from bytes alone: opening it is asynchronous
  // (the demuxer is a lazily imported bundle) and whether it is *usable* depends
  // on the codec inside, which only it can answer. So record the container and
  // let openAudioFile do the rest.
  if (EBML.includes(container)) return { container, ebml: true };
  const BUILT_IN = ['mp4', 'flac', 'mp3', 'wav', 'aiff'];
  if (!BUILT_IN.includes(container)) return null;
  try {
    const demuxed = container === 'mp4' ? demuxMp4(bytes)
      : container === 'flac' ? demuxFlac(bytes)
      : container === 'mp3' ? demuxMp3(bytes)
      : container === 'wav' ? demuxWav(bytes)
      : demuxAiff(bytes);
    if (demuxed.fragmented || !demuxed.track.codec || !demuxed.track.sampleCount) {
      return { container, reason: demuxed.fragmented ? 'fragmented MP4' : 'no usable audio track' };
    }
    return { container, demuxed };
  } catch (e) {
    return { container, reason: e.message };
  }
}

/**
 * Open an encoded file and describe it.
 *
 * @param {Blob|File|ArrayBuffer|Uint8Array|string} source
 * @param {object} [opts]
 * @param {'webcodecs'|'ffmpeg'|'auto'} [opts.backend='auto']
 * @param {boolean} [opts.forceFfmpeg]  skip the built-in demuxer
 * @param {number}  [opts.sampleRate]   requested output rate (ffmpeg backend only)
 * @param {number}  [opts.channels]     requested output channels (ffmpeg backend only)
 * @returns {Promise<{info, container, backend, chunks: () => AsyncGenerator}>}
 */
export async function openAudioFile(source, opts = {}) {
  const wanted = opts.backend ?? 'auto';
  // Set when an EBML track exists but this environment cannot decode it, so the
  // error at the bottom can name the codec instead of calling it an unknown
  // container.
  let undecodable = null;

  // ---- EBML, straight out of the Blob ----
  // A dropped File is peeked at, never read: when it turns out to be EBML, the
  // vendored demuxer pulls the ranges it needs out of the Blob itself, so a
  // multi-gigabyte episode with video in it is never copied into memory. Every
  // other path needs the bytes, which readSource fetches below.
  if (wanted !== 'ffmpeg' && !opts.forceFfmpeg &&
      typeof Blob !== 'undefined' && source instanceof Blob) {
    const head = new Uint8Array(await source.slice(0, HEAD_BYTES).arrayBuffer());
    if (EBML.includes(sniffContainer(head))) {
      const matroska = await openMatroska(source, opts);
      if (matroska.decodable) return matroskaResult(matroska, source.name ?? null);
      if (wanted === 'webcodecs') throw new Error(undecodableMessage(matroska));
      // Only ffmpeg could decode this, and it needs a path or the bytes.
      undecodable = matroska;
    }
  }

  const res = await readSource(source, opts);
  const bytes = res.bytes;

  // ---- built-in path ----
  if (wanted !== 'ffmpeg') {
    const viable = builtInViable(bytes, res.head, opts);
    if (viable?.demuxed) {
      const hasWebCodecs = typeof globalThis.AudioDecoder === 'function';
      // PCM needs no decoder at all, so unlike everything else it does not care
      // whether WebCodecs exists — it takes the built-in path either way.
      const isPcm = !!viable.demuxed.pcm;
      if (hasWebCodecs || isPcm) {
        const t = viable.demuxed.track;
        return {
          container: viable.container,
          backend: isPcm ? 'pcm' : 'webcodecs',
          info: {
            name: res.name,
            container: viable.container,
            codec: t.codec,
            sampleRate: t.sampleRate,
            channels: t.channels,
            duration: viable.demuxed.durationUs / 1e6,
            sampleCount: t.sampleCount,
          },
          // PCM has nothing to decode: the bytes are the samples, so it skips
          // WebCodecs entirely rather than inventing a codec string for it.
          chunks: () => (viable.demuxed.pcm
            ? decodePcm(bytes, viable.demuxed, opts)
            : decodeWithWebCodecs(bytes, viable.demuxed, opts)),
        };
      }
      if (wanted === 'webcodecs') {
        throw new Error('backend "webcodecs" requested but AudioDecoder is unavailable in this environment');
      }
      // else: fall through to ffmpeg (Node has none of this natively)
    } else if (viable?.ebml && !undecodable) {
      // A source that is not a Blob (bytes, a path, a URL) reaches EBML here.
      const matroska = await openMatroska(bytes, opts);
      if (matroska.decodable) return matroskaResult(matroska, res.name);
      if (wanted === 'webcodecs') throw new Error(undecodableMessage(matroska));
      // A codec neither the browser nor WebCodecs can decode: only the ffmpeg
      // backend could, so remember what it was and let the fallback decide.
      undecodable = matroska;
    } else if (wanted === 'webcodecs') {
      throw new Error(`backend "webcodecs" cannot handle this input: ${viable?.reason ?? `no built-in demuxer for ${viable?.container ?? 'this container'}`}`);
    }
  }

  // ---- ffmpeg fallback ----
  const ff = await loadFfmpeg();
  if (!ff) {
    if (undecodable) {
      // There IS a demuxer for this file, and it has already told us what the
      // track holds. Blaming the container would send the reader looking for
      // the wrong thing.
      throw new Error(
        `cannot read this file: its ${undecodable.container} track holds ` +
        `${undecodable.codec ? `"${undecodable.codec}"` : 'an unrecognised codec'}, which this ` +
        'browser cannot decode, and this environment has no fallback decoder ' +
        `(the ffmpeg path is Node-only).${undecodable.diagnosis ? ` — ${undecodable.diagnosis}` : ''}`
      );
    }
    // The old wording blamed WebCodecs, which is usually present and not the
    // problem — the container or codec simply has no demuxer here. Saying so
    // saves the reader from chasing a decoder they already have.
    const container = sniffContainer(res.head);
    throw new Error(
      `cannot read this file: no built-in demuxer handles "${container}", and this ` +
      'environment has no fallback decoder (the ffmpeg path is Node-only). ' +
      'Supported: MP4/M4A/MOV, FLAC, MP3, WAV, AIFF, Matroska (MKV) and WebM.'
    );
  }
  const path = res.path ?? await writeTempFile(bytes, guessExt(res.name));
  const probed = ff.probe(path);
  return {
    container: probed?.format ?? sniffContainer(res.head),
    backend: 'ffmpeg',
    info: {
      name: res.name,
      container: probed?.format ?? null,
      codec: probed?.codec ?? null,
      sampleRate: probed?.sampleRate ?? 0,
      channels: probed?.channels ?? 0,
      duration: probed?.duration ?? 0,
    },
    chunks: () => ff.decodeWithFfmpeg(path, opts),
    _tempPath: res.path ? null : path,
  };
}

/**
 * The result shape for the EBML path, shared by the two ways in (a Blob read
 * lazily, or bytes already in hand).
 */
function matroskaResult(matroska, name) {
  return {
    container: matroska.container,
    // Decoding is still WebCodecs; only PCM has a decoder in the bundle, and
    // calling that 'webcodecs' would misreport the progress split.
    backend: isNativePcm(matroska.codec) ? 'pcm' : 'webcodecs',
    info: {
      name,
      container: matroska.container,
      codec: matroska.codec,
      sampleRate: matroska.sampleRate,
      channels: matroska.channels,
      duration: matroska.duration,
    },
    chunks: matroska.chunks,
    // Private, like the ffmpeg path's _tempPath: which restated decoder config
    // was needed, when one was.
    _rescued: matroska.rescued,
  };
}

/** Why an EBML file cannot be decoded, naming the codec and what was refused. */
function undecodableMessage(matroska) {
  const what = matroska.codec ? `"${matroska.codec}" audio` : 'an unrecognised codec';
  const why = matroska.diagnosis ? ` — ${matroska.diagnosis}` : '';
  return `backend "webcodecs" cannot handle this input: its ${matroska.container} ` +
    `track holds ${what}, which this environment cannot decode${why}`;
}

function guessExt(name) {
  if (!name) return '.bin';
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i) : '.bin';
}

/**
 * Convenience: decode straight to an async iterator of AudioChunks.
 * `chunks()` always returns an AsyncGenerator, never a promise.
 */
export async function* decodeFile(source, opts = {}) {
  const opened = await openAudioFile(source, opts);
  yield* opened.chunks();
}
