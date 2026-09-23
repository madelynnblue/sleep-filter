/**
 * music-analysis — find and measure music in audio, entirely client-side.
 *
 * Input is RAW audio (Float32Array), never an encoded file. Decoding lives in a
 * separate package: this one has no idea what a container or a codec is, which
 * is what lets it run unchanged in Node, a Web Worker, or a page.
 *
 *   import { EpisodeAnalyzer, Library } from 'music-analysis';
 *
 *   // phase 1 — one episode at a time, parallelisable across workers
 *   const a = new EpisodeAnalyzer({ id: 'S01E01' });
 *   for await (const chunk of decode(file)) a.addChunk(chunk);   // your decoder
 *   const ep = a.finish();
 *
 *   // phase 2 — cheap, in-memory, cross-episode
 *   const lib = new Library().add(ep);
 *   const { candidates } = lib.discover();
 *   const assets = lib.refine(candidates);
 *   const music  = lib.segment(assets[0]);   // where the music is, per episode
 */

export { EpisodeAnalyzer, segmentEpisode } from './episode.mjs';
export { Library } from './library.mjs';
export {
  MonoResampler, describeChunk, downmixInto, toMonoAt, DEFAULT_SAMPLE_RATE,
} from './audio.mjs';
export { makeFFT, fftInPlace, fft } from './fft.mjs';
export { computeChroma, profile, smooth, frameSim } from './chroma.mjs';
export { fingerprint, discover, formatTime } from './discovery.mjs';
export {
  computeFeatures, calibrate, scoreFrames, segment, FEATURE_NAMES,
} from './features.mjs';
export { refineAsset } from './refine.mjs';
export {
  biquadBandpass, biquadLowpass, applyBiquad, makeBiquadState,
  butterworthLowpass, applyCascade, movingAvgAbs, movAvgSq,
} from './dsp.mjs';

export const version = '0.1.0';

/** What this package would like its decoder to hand it, if the decoder can. */
export const preferredInput = Object.freeze({
  sampleRate: 8000,
  channels: 1,
  format: 'f32-planar',
});
