/**
 * Phase-1 worker: decode + feature extraction for one file.
 *
 * This is the heavy half of the pipeline, so it runs off the main thread. One
 * worker per file keeps it simple — no shared mutable state, no coordination.
 *
 * The result is structured-cloneable (Float32Array + Map), so it goes back with
 * no serialisation step, and could drop straight into IndexedDB as a cache.
 */

import { analyzeOne } from './pipeline.mjs';

/**
 * Rate-limit progress messages.
 *
 * `onProgress` fires per chunk, and in the browser a chunk is a single AAC frame
 * — about 21 ms of audio. A 22-minute episode therefore produces on the order of
 * 60,000 callbacks, and every message rebuilds the file list on the main thread.
 * Report on a 1% change instead, with a 100 ms floor so the meter still moves
 * when progress stalls inside a stage.
 */
function throttleProgress(post) {
  const STEP = 0.01, MIN_MS = 100;
  let lastP = -1, lastT = -Infinity;
  return (p) => {
    if (p === null) return;
    const now = performance.now();
    if (p - lastP < STEP && now - lastT < MIN_MS) return;
    lastP = p; lastT = now;
    post(p);
  };
}

self.onmessage = async (e) => {
  const { id, source, shares } = e.data;
  try {
    const analysis = await analyzeOne(source, id, {
      shares,
      onProgress: throttleProgress((p) => self.postMessage({ id, type: 'progress', progress: p })),
    });

    // Transfer rather than copy the big feature buffers. Deduplicated because
    // transferring the same ArrayBuffer twice throws (it is already detached).
    const seen = new Set();
    const buffers = [];
    const push = (v) => {
      if (!ArrayBuffer.isView(v)) return;
      if (seen.has(v.buffer)) return;
      seen.add(v.buffer);
      buffers.push(v.buffer);
    };
    push(analysis.chroma?.C);
    push(analysis.features?.feats);
    push(analysis.features?.logRms);

    self.postMessage({ id, type: 'done', analysis }, buffers);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message ?? String(err) });
  }
};
