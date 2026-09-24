/**
 * Lossless cutting.
 *
 * Because the decode package already parses the full sample table, removing
 * music is just *selecting samples by timestamp and re-muxing* — no decode, no
 * re-encode, no generation loss. The original AAC bitstream is preserved
 * exactly; only whole frames are dropped.
 *
 * Granularity is therefore one AAC frame (1024 samples ≈ 21 ms at 48 kHz). Cuts
 * snap to frame boundaries, and the real removed span is reported so the caller
 * can see the difference from what they asked for.
 *
 * Pure JS, no dependencies, browser-safe.
 */

import { demuxMp4 } from './mp4.mjs';
import { demuxFlac, muxFlac } from './flac.mjs';
import { demuxMp3, muxMp3 } from './mp3.mjs';
import { demuxWav, demuxAiff, selectPcmFrames, muxPcm } from './pcm.mjs';
import { muxAudioMp4 } from './mux.mjs';
import { sniffContainer } from './container.mjs';

/** Sort and merge overlapping [start, end) ranges in seconds. */
export function normalizeRanges(ranges) {
  const list = (ranges ?? [])
    .map((r) => (Array.isArray(r) ? { start: r[0], end: r[1] } : r))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

const overlaps = (a, b, ranges) => {
  for (const r of ranges) if (a < r.end && b > r.start) return true;
  return false;
};

/** Turn analysis segments ({start,end}) into cut ranges. */
export const rangesFromSegments = (segments) =>
  (segments ?? []).map((s) => [s.start, s.end]);

/**
 * Split a demuxed track's samples into kept/removed by time range.
 * @param {object} demuxed  output of demuxMp4
 * @param {Array} ranges    [{start,end}] in seconds
 * @param {{mode?: 'remove'|'keep'}} [opts]
 *        remove = drop samples inside the ranges (strip the music)
 *        keep   = drop samples outside them (extract the music)
 */
export function selectSamples(demuxed, ranges, opts = {}) {
  const { mode = 'remove' } = opts;
  const timescale = demuxed.track.timescale;
  const list = normalizeRanges(ranges);
  const kept = [], removed = [];

  for (const s of demuxed.samples) {
    const t0 = s.timestamp / timescale;
    const t1 = (s.timestamp + s.duration) / timescale;
    const hit = overlaps(t0, t1, list);
    const keep = mode === 'remove' ? !hit : hit;
    (keep ? kept : removed).push(s);
  }

  const durOf = (arr) => arr.reduce((n, s) => n + s.duration, 0) / timescale;
  return {
    kept,
    removed,
    keptSeconds: durOf(kept),
    removedSeconds: durOf(removed),
    requestedSeconds: list.reduce((n, r) => n + (r.end - r.start), 0),
  };
}

/**
 * Cut music out of an encoded audio file, losslessly.
 *
 * @param {Uint8Array} source  the whole encoded file
 * @param {Array} ranges       music ranges, seconds
 * @param {{mode?: 'remove'|'keep'}} [opts]
 * @returns {{bytes: Uint8Array, info: object}}
 */
export function cutAudio(source, ranges, opts = {}) {
  const container = opts.container ?? sniffContainer(source.subarray(0, 16));
  // PCM needs no frames list and no muxer: it is byte-addressable, so the cut is
  // arithmetic on the header and a concatenation of the kept bytes.
  if (container === 'wav' || container === 'aiff') return cutPcm(source, ranges, opts, container);
  const demuxed = container === 'flac' ? demuxFlac(source)
    : container === 'mp3' ? demuxMp3(source)
    : demuxMp4(source);
  if (demuxed.fragmented) {
    throw new Error('cutAudio: fragmented MP4 is not supported (the fallback decoder can re-encode instead)');
  }
  if (!demuxed.samples.length) throw new Error('cutAudio: no audio samples found');

  const sel = selectSamples(demuxed, ranges, opts);
  if (!sel.kept.length) throw new Error('cutAudio: every sample would be removed — refusing to write an empty file');

  let bytes;
  if (container === 'flac') {
    // Frames are independent, so dropping whole ones is lossless.
    bytes = muxFlac(source, demuxed, sel.kept);
  } else if (container === 'mp3') {
    // Frame splicing: the bit reservoir means the first frame after a cut can
    // reference bytes that are no longer there. A few milliseconds, and
    // inherent to cutting MP3 without re-encoding.
    bytes = muxMp3(source, demuxed, sel.kept);
  } else {
    // The priming trim only applies if the original first sample survived. If
    // the cut removed the head, the new first frame carries no encoder delay.
    const keptHead = sel.kept[0] === demuxed.samples[0];
    bytes = muxAudioMp4(source, demuxed.track, sel.kept, {
      ...opts,
      editMediaTime: keptHead ? demuxed.track.editMediaTime : 0,
      // tags travel with the audio: the cut is the same episode, so its title,
      // artist, track number and so on still describe it
      udta: demuxed.udtaRaw,
    });
  }
  const ts = demuxed.track.timescale;
  const frameSec = demuxed.samples[0].duration / ts;

  const sourceSeconds = demuxed.samples.reduce((n, s) => n + s.duration, 0) / ts;
  return {
    bytes,
    info: {
      mode: opts.mode ?? 'remove',
      sourceSeconds,
      outputSeconds: sel.keptSeconds,
      removedSeconds: sel.removedSeconds,
      requestedSeconds: sel.requestedSeconds,
      // how far the frame-boundary snap moved the total removed span
      snapSeconds: sel.removedSeconds - sel.requestedSeconds,
      frameSeconds: frameSec,
      keptSamples: sel.kept.length,
      removedSamples: sel.removed.length,
      sampleRate: demuxed.track.sampleRate,
      channels: demuxed.track.channels,
      codec: demuxed.track.codec,
      // What the output actually is, which is not always what came in: an MP4
      // that held video comes back as an audio-only MP4.
      container,
      outputExtension: outputExtensionFor(source),
    },
  };
}

/** Cut uncompressed PCM. Exact, codec-free, and needs no muxer. */
function cutPcm(source, ranges, opts, container) {
  const demuxed = container === 'wav' ? demuxWav(source) : demuxAiff(source);
  const kept = selectPcmFrames(demuxed.pcm, ranges, opts);
  if (!kept.length) throw new Error('cutAudio: every sample would be removed — refusing to write an empty file');

  const keptFrames = kept.reduce((n, [a, b]) => n + (b - a), 0);
  const total = demuxed.pcm.frameCount;
  return {
    bytes: muxPcm(source, demuxed, kept),
    info: {
      mode: opts.mode ?? 'remove',
      sourceSeconds: total / demuxed.track.sampleRate,
      outputSeconds: keptFrames / demuxed.track.sampleRate,
      removedSeconds: (total - keptFrames) / demuxed.track.sampleRate,
      requestedSeconds: (opts.requestedSeconds ?? 0),
      snapSeconds: 0,                       // PCM snaps to the sample, not to a frame
      frameSeconds: 1 / demuxed.track.sampleRate,
      keptSamples: keptFrames,
      removedSamples: total - keptFrames,
      sampleRate: demuxed.track.sampleRate,
      channels: demuxed.track.channels,
      codec: demuxed.track.codec,
      container,
      outputExtension: outputExtensionFor(source),
    },
  };
}

/**
 * The extension an output will carry, decided by the container that came in.
 *
 * An MP4 output is always audio-only, so it is an m4a whatever the input was
 * called — a `.mp4` that held video, a `.mov`, a `.m4v`. Single source of truth
 * so the page can name a file before cutting it, and the cut agrees.
 */
export function outputExtensionFor(source) {
  const container = sniffContainer(source.subarray(0, 16));
  if (container === 'flac') return 'flac';
  if (container === 'mp3') return 'mp3';
  if (container === 'wav') return 'wav';
  if (container === 'aiff') return 'aiff';
  return 'm4a';                    // MP4 output is always audio-only
}
