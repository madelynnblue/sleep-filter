/**
 * WebCodecs decode driver (browser).
 *
 * WebCodecs gives you a decoder but no demuxer and no chunking policy, so this
 * supplies the missing half: feed demuxed samples in with backpressure, collect
 * AudioData, hand back AudioChunks in the shape music-analysis expects.
 *
 * Browser-only by construction — it never imports anything from Node, and is
 * only reachable when `globalThis.AudioDecoder` exists.
 */

import { demuxMp4 } from './mp4.mjs';

/** AudioData -> the AudioChunk contract (planar f32, one Float32Array per channel). */
export function audioDataToChunk(data) {
  const channels = data.numberOfChannels;
  const frames = data.numberOfFrames;
  const planes = new Array(channels);
  for (let c = 0; c < channels; c++) {
    const plane = new Float32Array(frames);
    // copyTo converts from whatever the decoder emitted into planar f32
    data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
    planes[c] = plane;
  }
  const chunk = {
    sampleRate: data.sampleRate,
    numberOfFrames: frames,
    numberOfChannels: channels,
    format: 'f32-planar',
    data: planes,
    timestamp: data.timestamp,   // microseconds
  };
  data.close();
  return chunk;
}

/**
 * Decode an already-demuxed buffer into AudioChunks.
 *
 * Container-agnostic: all it needs is a track description and a list of samples
 * with byte offsets, which every demuxer here produces.
 *
 * @param {Uint8Array} bytes
 * @param {object} demuxed  output of demuxMp4 / demuxFlac / demuxMp3
 * @param {{maxQueue?: number, signal?: AbortSignal, fromSeconds?: number, toSeconds?: number}} [opts]
 *        fromSeconds/toSeconds decode only the samples covering that span. Frames
 *        are independently decodable and the sample list gives byte offsets, so
 *        auditioning a 12 s clip costs 12 s of decode, not 22 min.
 */
export async function* decodeWithWebCodecs(bytes, demuxed, opts = {}) {
  const { maxQueue = 24, fromSeconds, toSeconds } = opts;
  if (typeof globalThis.AudioDecoder !== 'function') {
    throw new Error('WebCodecs AudioDecoder is not available in this environment');
  }
  const { codec, sampleRate, channels, description } = demuxed.track;
  if (!codec) throw new Error('no usable codec string in the audio track');
  if (demuxed.fragmented) throw new Error('fragmented MP4 is not supported by the built-in demuxer');

  const pending = [];
  let wake = null;
  let finished = false;
  let failure = null;
  const notify = () => { if (wake) { const w = wake; wake = null; w(); } };

  const decoder = new AudioDecoder({
    output: (data) => { pending.push(data); notify(); },
    error: (e) => { failure = e; finished = true; notify(); },
  });

  // range selection straight off the sample table
  const ts = demuxed.track.timescale;
  const fromT = fromSeconds !== undefined ? fromSeconds * ts : -Infinity;
  const toT = toSeconds !== undefined ? toSeconds * ts : Infinity;
  const wanted = (fromSeconds === undefined && toSeconds === undefined)
    ? demuxed.samples
    : demuxed.samples.filter((s) => s.timestamp + s.duration > fromT && s.timestamp < toT);
  if (!wanted.length) throw new Error('no samples in the requested range');

  const config = { codec, sampleRate, numberOfChannels: channels };
  if (description && description.length) config.description = description;
  decoder.configure(config);

  // Producer: feed samples, respecting decodeQueueSize so a long file cannot
  // balloon memory by queueing every sample at once.
  const producer = (async () => {
    try {
      for (const s of wanted) {
        if (failure || opts.signal?.aborted) break;
        decoder.decode(new EncodedAudioChunk({
          type: 'key',                       // every AAC frame is independently decodable
          timestamp: s.timestampUs,
          duration: s.durationUs,
          data: bytes.subarray(s.offset, s.offset + s.size),
        }));
        while (decoder.decodeQueueSize > maxQueue && !failure) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      await decoder.flush();
    } catch (e) {
      failure = failure ?? e;
    } finally {
      finished = true;
      notify();
    }
  })();

  try {
    while (!finished || pending.length) {
      if (!pending.length) {
        await new Promise((r) => { wake = r; });
        if (failure) break;
        continue;
      }
      yield audioDataToChunk(pending.shift());
    }
    await producer;
    if (failure) throw failure;
  } finally {
    try { decoder.close(); } catch { /* already closed */ }
  }
}

/** Convenience wrapper for MP4 input, which is what most callers have. */
export async function* decodeMp4WithWebCodecs(bytes, opts = {}) {
  yield* decodeWithWebCodecs(bytes, demuxMp4(bytes), opts);
}
