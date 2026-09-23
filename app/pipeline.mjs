/**
 * Shared orchestration for the CLI and the web page.
 *
 * Deliberately free of DOM and Node APIs so both front ends drive the exact
 * same code — the only difference is which decoder backend `audio-decode`
 * selects (WebCodecs in a page, ffmpeg in Node).
 *
 * Two independent features sit on top of this:
 *   common themes   audio that repeats across episodes (themes, stings)
 *   general music   music within a single episode (interludes, songs, credits)
 */

import { EpisodeAnalyzer, Library, segmentEpisode } from '../src/index.mjs';
import {
  openAudioFile, cutAudio, rangesFromSegments, readTagsFromMoov,
} from '../audio-decode/src/index.mjs';

/**
 * Find the `moov` box by walking top-level headers only.
 *
 * A Blob is read through `slice`, so this touches a few hundred bytes rather
 * than the whole episode — and it has to walk at all because `moov` sits at the
 * END of these files, behind a 16 MB mdat.
 *
 * @returns {Promise<{start: number, end: number}|null>}
 */
async function findMoovBox(source) {
  let pos = 0;
  while (pos + 8 <= source.size) {
    const head = new Uint8Array(
      await source.slice(pos, Math.min(pos + 16, source.size)).arrayBuffer());
    if (head.length < 8) return null;

    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
    let header = 8;
    if (size === 1) {                       // 64-bit size
      if (head.length < 16) return null;
      size = Number(dv.getBigUint64(8));
      header = 16;
    } else if (size === 0) {                // extends to end of file
      size = source.size - pos;
    }
    if (size < header || pos + size > source.size) return null;
    if (type === 'moov') return { start: pos, end: pos + size };
    pos += size;
  }
  return null;
}

/** The file's own title tag, or null when it carries none. */
export async function readTitleTag(source) {
  const moov = await findMoovBox(source);
  if (!moov) return null;
  const bytes = new Uint8Array(await source.slice(moov.start, moov.end).arrayBuffer());
  return readTagsFromMoov(bytes)['©nam'] ?? null;
}

/**
 * Decode and analyse one file. Phase 1 — heavy, and the unit of work for a
 * worker in the browser.
 */
export async function analyzeOne(source, id, opts = {}) {
  const analyzer = new EpisodeAnalyzer({ id });
  const { info, chunks, backend } = await openAudioFile(source, opts.decode);
  if (info?.duration) analyzer.expectedFrames = Math.round(info.duration * analyzer.targetSampleRate);

  for await (const chunk of chunks()) {
    analyzer.addChunk(chunk);
    opts.onProgress?.(analyzer.progress);
  }
  // finish() must be given onProgress too: decode is only ~30% of the work, so
  // without this the meter stops at 30% and jumps to 100 when the worker's
  // 'done' message lands.
  const analysis = analyzer.finish({ onProgress: opts.onProgress });
  analysis.info = info;
  analysis.backend = backend;
  return analysis;
}

/**
 * Recurring-asset discovery plus chroma refinement. Phase 2 — cheap, and needs
 * every episode at once.
 * @param {number} [opts.topN] keep only the N most prevalent assets
 */
export function discoverAssets(analyses, opts = {}) {
  const library = new Library();
  for (const a of analyses) library.add(a);
  const discovery = library.discover(opts.discover);
  const assets = library.refine(discovery.candidates, opts.refine);
  return { library, discovery, assets, topN: opts.topN ?? assets.length };
}

/** The detected region of an asset's example episode — what a play button plays. */
export function exampleRegion(asset) {
  const ref = asset.episodes.find((e) => e.isReference)
    ?? asset.episodes.find((e) => e.present !== false && e.start != null);
  if (!ref || ref.start == null) return null;
  return { id: ref.id, start: ref.start, end: ref.end };
}

/** Does `seg` share any audio with one of `ranges`? */
const overlapsAny = (seg, ranges) => ranges.some(([a, b]) => seg.start < b && a < seg.end);

/**
 * Per-episode music ranges, calibrated on the detected regions of one or more
 * assets. Using several as positives gives the discriminant more to learn from
 * than a single exemplar.
 *
 * @param {import('../src/library.mjs').Library} library
 * @param {object[]} assets
 * @param {Map<string, Array<[number, number]>>} [opts.exclude]
 *        per episode, audio already being cut for another reason. Segments
 *        overlapping any of it are dropped, so the same seconds are never
 *        proposed twice.
 */
export function musicRangesFor(library, assets, opts = {}) {
  const positives = new Map();
  for (const a of assets) {
    for (const e of a.episodes) {
      if (e.present === false || e.start == null) continue;
      if (!positives.has(e.id)) positives.set(e.id, []);
      positives.get(e.id).push([e.start, e.end]);
    }
  }
  const out = [];
  for (const [id, ranges] of positives) {
    const ep = library.episodes.get(id);
    if (!ep?.features) continue;
    try {
      // levelSlack: proposed music must be within 8 dB of the level of the music
      // exemplars. Music the user wants gone is foreground music; the false
      // positives are quiet passages that merely resemble it in timbre, which is
      // the audio that should stay.
      const { segments } = segmentEpisode(ep, ranges, { levelSlack: 8, ...(opts.segment ?? {}) });
      const taken = opts.exclude?.get(id);
      const kept = taken?.length ? segments.filter((s) => !overlapsAny(s, taken)) : segments;
      out.push({ id, segments: kept, ranges: rangesFromSegments(kept) });
    } catch (err) {
      out.push({ id, segments: [], ranges: [], error: err.message });
    }
  }
  return out;
}

/** Cut and re-mux one file. Returns encoded bytes. */
export function renderCut(sourceBytes, ranges, opts = {}) {
  return cutAudio(sourceBytes, ranges, opts);
}

/* ------------------------------------------------------------- preview -- */

const concat = (arrays) => {
  const n = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
};

/** Minimal RIFF/WAVE writer — 16-bit PCM, interleaved. */
export function encodeWav(planes, sampleRate) {
  const channels = planes.length;
  const frames = Math.min(...planes.map((p) => p.length));
  const bytes = frames * channels * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const dv = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, bytes, true);

  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, planes[c][i]));
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

/**
 * Decode just a time range and return it as a WAV blob URL — what the play
 * buttons use. Cheap because the demuxer hands the decoder only the frames
 * covering that span (12s of decode, not 22 minutes).
 */
export async function extractClipWav(source, startSec, endSec, opts = {}) {
  const { chunks } = await openAudioFile(source, {
    ...(opts.decode ?? {}),
    fromSeconds: startSec,
    toSeconds: endSec,
  });
  const parts = [];
  let sampleRate = 0, channels = 0;
  for await (const c of chunks()) {
    sampleRate = c.sampleRate;
    channels = c.numberOfChannels;
    if (!parts.length) for (let i = 0; i < channels; i++) parts.push([]);
    if (c.format === 'f32-planar') {
      for (let ch = 0; ch < channels; ch++) parts[ch].push(c.data[ch]);
    } else {
      for (let ch = 0; ch < channels; ch++) {
        const n = c.numberOfFrames;
        const arr = new Float32Array(n);
        for (let i = 0; i < n; i++) arr[i] = c.data[i * channels + ch];
        parts[ch].push(arr);
      }
    }
  }
  if (!sampleRate || !parts.length) throw new Error('nothing decoded in that range');
  const planes = parts.map(concat);
  const wav = encodeWav(planes, sampleRate);
  return {
    wav,
    blob: new Blob([wav], { type: 'audio/wav' }),
    sampleRate,
    channels,
    duration: Math.min(...planes.map((p) => p.length)) / sampleRate,
  };
}

