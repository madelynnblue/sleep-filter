/**
 * audio-decode — encoded audio -> AudioChunk stream.
 *
 * The other half of the boundary that music-analysis deliberately does not
 * cross. Two backends, chosen automatically:
 *
 *   webcodecs  built-in ISO-BMFF demuxer + WebCodecs AudioDecoder.
 *              No external binary, no WASM payload. Handles non-fragmented
 *              MP4/M4A, which is what the common case actually is.
 *   ffmpeg     child-process fallback (Node). Covers every other container and
 *              codec, plus fragmented MP4.
 *
 *   import { openAudioFile } from 'audio-decode';
 *   const { info, chunks } = await openAudioFile(file);
 *   for await (const chunk of chunks()) analysis.addChunk(chunk);
 */

import { sniffContainer } from './container.mjs';
import { demuxMp4 } from './mp4.mjs';
import { decodeMp4WithWebCodecs } from './webcodecs.mjs';
import { readSource, writeTempFile } from './source.mjs';

export { sniffContainer, MP4_EXTENSIONS } from './container.mjs';
export { demuxMp4, parseAudioSpecificConfig, readTags, readTagsFromMoov } from './mp4.mjs';
export { decodeMp4WithWebCodecs, audioDataToChunk } from './webcodecs.mjs';
export { readSource } from './source.mjs';
export { muxAudioMp4 } from './mux.mjs';
export { cutAudio, selectSamples, normalizeRanges, rangesFromSegments } from './cut.mjs';

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

/** Does the built-in path apply to this buffer? */
function builtInViable(bytes, head, opts) {
  const container = sniffContainer(head);
  if (container !== 'mp4' || opts.forceFfmpeg) return null;
  try {
    const demuxed = demuxMp4(bytes);
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
  const res = await readSource(source, opts);
  const bytes = res.bytes;

  // ---- built-in path ----
  if (wanted !== 'ffmpeg') {
    const viable = builtInViable(bytes, res.head, opts);
    if (viable?.demuxed) {
      const hasWebCodecs = typeof globalThis.AudioDecoder === 'function';
      if (hasWebCodecs) {
        const t = viable.demuxed.track;
        return {
          container: 'mp4',
          backend: 'webcodecs',
          info: {
            name: res.name,
            container: 'mp4',
            codec: t.codec,
            sampleRate: t.sampleRate,
            channels: t.channels,
            duration: viable.demuxed.durationUs / 1e6,
            sampleCount: t.sampleCount,
          },
          chunks: () => decodeMp4WithWebCodecs(bytes, opts),
        };
      }
      if (wanted === 'webcodecs') {
        throw new Error('backend "webcodecs" requested but AudioDecoder is unavailable in this environment');
      }
      // else: fall through to ffmpeg (Node has none of this natively)
    } else if (wanted === 'webcodecs') {
      throw new Error(`backend "webcodecs" cannot handle this input: ${viable?.reason ?? 'not MP4'}`);
    }
  }

  // ---- ffmpeg fallback ----
  const ff = await loadFfmpeg();
  if (!ff) {
    throw new Error(
      'no usable decoder backend: WebCodecs is unavailable and the ffmpeg fallback ' +
      'is not importable (Node-only). In a browser, this container/codec needs a ' +
      'different decoder.'
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
