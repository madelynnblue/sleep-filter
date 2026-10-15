/**
 * Phase-1 worker: decode + feature extraction for one file.
 *
 * This is the heavy half of the pipeline, so it runs off the main thread. One
 * worker per file keeps it simple — no shared mutable state, no coordination.
 *
 * The result is structured-cloneable (Float32Array + Map), so it goes back with
 * no serialisation step, and could drop straight into IndexedDB as a cache.
 */

import { analyzeOne, throttleProgress } from './pipeline.mjs';

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
    push(analysis.cfa);
    push(analysis.dialog?.mod4);
    push(analysis.dialog?.modSpeech);
    push(analysis.dialog?.bandSync);
    push(analysis.dialog?.periodicity);

    self.postMessage({ id, type: 'done', analysis }, buffers);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message ?? String(err) });
  }
};
