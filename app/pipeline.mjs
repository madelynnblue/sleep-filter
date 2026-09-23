/**
 * Shared orchestration for the CLI and the web page.
 *
 * Deliberately free of DOM and Node APIs so both front ends drive the exact
 * same code — the only difference is which decoder backend `audio-decode`
 * selects (WebCodecs in a page, ffmpeg in Node).
 *
 *   analyze      encoded file -> EpisodeAnalysis (features, chroma, fingerprints)
 *   discover     all analyses -> recurring assets (theme, stings)
 *   musicRanges  asset + analyses -> per-episode ranges to strip
 *   renderCut    source + ranges -> a new encoded file
 */

import { EpisodeAnalyzer, Library } from '../src/index.mjs';
import { openAudioFile, cutAudio, rangesFromSegments } from '../audio-decode/src/index.mjs';

/**
 * Decode and analyse one file. Phase 1 — heavy, and the unit of work for a
 * worker in the browser.
 *
 * @param {Blob|File|ArrayBuffer|Uint8Array|string} source
 * @param {string} id
 * @param {{onProgress?: (p: number) => void, decode?: object}} [opts]
 */
export async function analyzeOne(source, id, opts = {}) {
  const analyzer = new EpisodeAnalyzer({ id });
  const { info, chunks, backend } = await openAudioFile(source, opts.decode);
  if (info?.duration) analyzer.expectedFrames = Math.round(info.duration * analyzer.targetSampleRate);

  for await (const chunk of chunks()) {
    analyzer.addChunk(chunk);
    opts.onProgress?.(analyzer.progress);
  }
  const analysis = analyzer.finish();
  analysis.info = info;
  analysis.backend = backend;
  return analysis;
}

/**
 * Analyse a list of sources sequentially, reporting progress.
 * @param {Array<{id: string, source: any}>} items
 */
export async function analyzeAll(items, opts = {}) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    opts.onFile?.(items[i].id, i, items.length);
    out.push(await analyzeOne(items[i].source, items[i].id, opts));
  }
  return out;
}

/**
 * Recurring-asset discovery plus chroma refinement. Phase 2 — cheap, and needs
 * every episode at once.
 */
export function discoverAssets(analyses, opts = {}) {
  const library = new Library();
  for (const a of analyses) library.add(a);
  const discovery = library.discover(opts.discover);
  const assets = library.refine(discovery.candidates, opts.refine);
  return { library, discovery, assets };
}

/**
 * Per-episode music ranges for one asset, calibrated on that asset's own
 * regions. `mode` is passed through to the cutter.
 */
export function musicRanges(library, asset, opts = {}) {
  const perEpisode = library.segment(asset, opts.segment);
  return perEpisode.map((r) => ({
    id: r.id,
    ranges: rangesFromSegments(r.segments),
    segments: r.segments,
  }));
}

/** Cut and re-mux one file. Returns encoded bytes. */
export function renderCut(sourceBytes, ranges, opts = {}) {
  return cutAudio(sourceBytes, ranges, opts);
}

/** Human-readable summary lines for an asset, shared by both front ends. */
export function assetSummary(asset) {
  return {
    kind: asset.kind,
    support: `${asset.support}/${asset.totalEpisodes ?? '?'}`,
    supportFraction: asset.supportFraction,
    span: `${asset.span.toFixed(1)}s`,
    meanStart: asset.meanStart,
    confidence: asset.meanSim ?? null,
    absent: asset.absent ?? [],
  };
}
