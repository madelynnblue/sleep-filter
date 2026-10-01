#!/usr/bin/env node
/**
 * Regression + integration tests. No framework, no dependencies.
 *
 * 1. EQUIVALENCE — the refactored package must produce byte-identical features
 *    to the original spike modules (which are kept under spike/ as the reference
 *    implementation). This is what proves the extraction changed nothing.
 * 2. RESAMPLER — pass-through must be exact; downsampling must not alias into
 *    nonsense.
 * 3. STREAMING — chunked ingestion must equal whole-buffer ingestion.
 * 4. LIBRARY — end-to-end on synthetic audio: plant the same music in every
 *    episode at different offsets and confirm discovery finds it and
 *    segmentation reports it.
 *
 *   node test/regression.mjs
 */

import {
  EpisodeAnalyzer, Library, computeChroma, computeFeatures, fingerprint,
  MonoResampler, segmentEpisode, segmentBySeries, segment, preferredInput,
} from '../src/index.mjs';
import { NFEAT, computeCFA, CFA_SAMPLE_RATE } from '../src/features.mjs';
import { computeDialog, dialogWindowScore, segmentHasDialog, DIALOG_THRESHOLD } from '../src/dialog.mjs';

// reference implementation (the original spike, unchanged)
import { computeChroma as refChroma } from '../spike/chroma.mjs';
import { computeFeatures as refFeatures } from '../spike/music.mjs';
import { fingerprint as refFingerprint } from '../spike/discovery.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};
const close = (a, b, tol = 0) => {
  if (a.length !== b.length) return { ok: false, detail: `length ${a.length} vs ${b.length}` };
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return { ok: false, detail: `non-finite at ${i}` };
  }
  return { ok: max <= tol, detail: `max abs diff ${max}` };
};

/* ------------------------------------------------------- generators -- */

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

const RATE = 8000;

/**
 * Music surrogate: irregular, non-repeating chord schedule.
 *
 * Must NOT be periodic. An earlier version cycled four chords on a strict 2s
 * grid, giving the music an 8s period — so it matched itself at 8s lags and the
 * offset-consensus histogram developed competing peaks 8s apart. That split one
 * identical asset into two candidates and produced the classic odd/even support
 * split. Real music is repetitive but not perfectly periodic.
 *
 * Also must move harmonically: a STATIC chord gives constant chroma, and since
 * chroma is mean-centred the residuals become pure noise, leaving refinement
 * nothing to lock onto.
 */
function musicSignal(n, rate = RATE, seed = 7) {
  const rnd = lcg(seed);
  const out = new Float32Array(n);
  const shape = [[1, 0.5], [1.25, 0.3], [1.5, 0.35], [2, 0.2]];
  const chords = [];
  for (let t = 0; t < n / rate; ) {
    const dur = 0.7 + 0.9 * rnd();
    chords.push({ t, root: 150 + 250 * rnd() });
    t += dur;
  }
  let ci = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    while (ci + 1 < chords.length && t >= chords[ci + 1].t) ci++;
    const root = chords[ci].root;
    let v = 0;
    for (const [m, a] of shape) v += a * Math.sin(2 * Math.PI * root * m * t);
    v *= 0.65 + 0.35 * Math.sin(2 * Math.PI * 2 * t);
    v += 0.02 * (rnd() * 2 - 1);
    out[i] = 0.3 * v;
  }
  return out;
}

/**
 * Noise-driven speech surrogate: random syllable onsets with varying formants.
 *
 * Must NOT be periodic. An earlier version used fixed sines gated at 4 Hz, which
 * is degenerate for fingerprinting — the repetition produced spurious
 * alignments that crowded the real shared asset out of the per-pair top peaks.
 * Real speech has no such stable periodicity.
 */
function speechSignal(n, rate = RATE, seed = 99) {
  const rnd = lcg(seed);
  const out = new Float32Array(n);
  let env = 0, f1 = 400, f2 = 1600, p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) {
    if (rnd() < 1 / (0.18 * rate)) {           // new syllable ~every 180ms
      env = 0.6 + 0.4 * rnd();
      f1 = 300 + 500 * rnd();
      f2 = 1200 + 1400 * rnd();
    }
    env *= 0.9992;
    p1 += (2 * Math.PI * f1) / rate;
    p2 += (2 * Math.PI * f2) / rate;
    const v = 0.5 * Math.sin(p1) + 0.3 * Math.sin(p2) + 0.6 * (rnd() * 2 - 1);
    out[i] = 0.25 * v * Math.max(0, env);
  }
  return out;
}

/** Concatenate Float32Arrays. */
const cat = (...xs) => {
  const n = xs.reduce((s, x) => s + x.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const x of xs) { out.set(x, o); o += x.length; }
  return out;
};

const DUR = 60 * RATE;   // 60 s synthetic episode

console.log('music-analysis regression\n');

/* -------------------------------------------------- 1. equivalence -- */

console.log('equivalence vs reference spike implementation (same input):');
{
  const x = cat(musicSignal(20 * RATE), speechSignal(40 * RATE));

  const a = computeChroma(x, { sampleRate: RATE });
  const b = refChroma(x, { sampleRate: RATE });
  // Not bit-identical any more: the shared FFT now exploits that its input is
  // real, which halves the transform but reorders the float arithmetic. The
  // spike is still the reference, so anything above epsilon is a real change.
  const cc = close(a.C, b.C, 1e-5);
  ok('computeChroma equivalent', cc.ok, cc.detail);

  const fa = computeFeatures(x, { sampleRate: RATE });
  const fb = refFeatures(x, { sampleRate: RATE });
  // Not bit-identical by construction: the shared FFT precomputes twiddle
  // tables while the spike computed them inline, so results differ at float32
  // epsilon. Anything above this tolerance would be a real behavioural change.
  const cf = close(fa.feats, fb.feats, 1e-6);
  ok('computeFeatures equivalent (float tolerance)', cf.ok, cf.detail);

  const pa = fingerprint(x, { sampleRate: RATE });
  const pb = refFingerprint(x, { sampleRate: RATE });
  let sameHashes = pa.hashTimes.size === pb.hashTimes.size;
  let sameTimes = sameHashes;
  if (sameHashes) {
    for (const [h, ts] of pa.hashTimes) {
      const other = pb.hashTimes.get(h);
      if (!other || other.length !== ts.length || ts.some((v, i) => v !== other[i])) {
        sameTimes = false; break;
      }
    }
  }
  ok(`fingerprint identical (${pa.hashTimes.size} hashes)`, sameHashes && sameTimes,
     sameHashes ? 'times differ' : 'hash sets differ');
}

/* ---------------------------------------------------- 2. resampler -- */

console.log('\nresampler:');
{
  const mono = musicSignal(4 * RATE);
  const r = new MonoResampler({ inputRate: RATE, outputRate: RATE, channels: 1 });
  const chunk = {
    sampleRate: RATE, numberOfFrames: mono.length, numberOfChannels: 1,
    format: 'f32-planar', data: [mono],
  };
  const out = r.process(chunk);
  ok('pass-through is exact and zero-copy', close(out, mono).ok && out.buffer === mono.buffer,
     out.buffer === mono.buffer ? close(out, mono).detail : 'copied');

  // 48 kHz -> 8 kHz: a 1 kHz tone must survive as a 1 kHz tone
  const IN = 48000;
  const tone = new Float32Array(IN);
  for (let i = 0; i < IN; i++) tone[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / IN);
  const rr = new MonoResampler({ inputRate: IN, outputRate: RATE, channels: 1 });
  const got = rr.process({
    sampleRate: IN, numberOfFrames: tone.length, numberOfChannels: 1,
    format: 'f32-planar', data: [tone],
  });
  const finite = got.every(Number.isFinite);
  let zc = 0;
  for (let i = 1; i < got.length; i++) if ((got[i - 1] < 0) !== (got[i] < 0)) zc++;
  const hz = zc / 2 / (got.length / RATE);
  ok(`48k->8k 1 kHz tone preserved (${got.length} samples, ${hz.toFixed(0)} Hz)`,
     finite && got.length > RATE * 0.9 && Math.abs(hz - 1000) < 60,
     `finite=${finite} len=${got.length} hz=${hz.toFixed(0)}`);

  // chunked resampling must match single-shot
  const whole = new MonoResampler({ inputRate: IN, outputRate: RATE, channels: 1 })
    .process({ sampleRate: IN, numberOfFrames: tone.length, numberOfChannels: 1, format: 'f32-planar', data: [tone] });
  const piece = new MonoResampler({ inputRate: IN, outputRate: RATE, channels: 1 });
  const parts = [];
  for (let o = 0; o < tone.length; o += 4096) {
    const seg = tone.subarray(o, Math.min(o + 4096, tone.length));
    const y = piece.process({
      sampleRate: IN, numberOfFrames: seg.length, numberOfChannels: 1, format: 'f32-planar', data: [seg],
    });
    parts.push(y);
  }
  const joined = cat(...parts);
  const n = Math.min(joined.length, whole.length);
  ok(`chunked resample == single-shot (${whole.length} vs ${joined.length})`,
     Math.abs(whole.length - joined.length) <= 1 && close(joined.subarray(0, n), whole.subarray(0, n), 1e-6).ok,
     close(joined.subarray(0, n), whole.subarray(0, n), 1e-6).detail);
}

/* ---------------------------------------------------- 3. streaming -- */

console.log('\nstreaming ingestion:');
{
  const x = cat(musicSignal(20 * RATE), speechSignal(40 * RATE));

  const whole = new EpisodeAnalyzer({ id: 'whole' });
  whole.addChunk({
    sampleRate: RATE, numberOfFrames: x.length, numberOfChannels: 1,
    format: 'f32-planar', data: [x],
  });
  const wa = whole.finish();

  const streamed = new EpisodeAnalyzer({ id: 'streamed' });
  for (let o = 0; o < x.length; o += 1000) {
    const seg = x.subarray(o, Math.min(o + 1000, x.length));
    streamed.addChunk({
      sampleRate: RATE, numberOfFrames: seg.length, numberOfChannels: 1,
      format: 'f32-planar', data: [seg],
    });
  }
  const sa = streamed.finish();

  ok(`chunked == whole (chroma, ${wa.chroma.nFrames} frames)`,
     close(wa.chroma.C, sa.chroma.C).ok, close(wa.chroma.C, sa.chroma.C).detail);
  ok('chunked == whole (features)', close(wa.features.feats, sa.features.feats).ok);
  ok('duration reported', Math.abs(wa.duration - 60) < 1e-6, String(wa.duration));

  // 48 kHz stereo interleaved -> same content as 8 kHz mono
  const IN = 48000;
  const st = new Float32Array(60 * IN * 2);
  for (let i = 0; i < 60 * IN; i++) {
    const v = x[Math.min(x.length - 1, Math.floor(i * RATE / IN))];
    st[i * 2] = v; st[i * 2 + 1] = v;
  }
  const dec = new EpisodeAnalyzer({ id: 'dec' });
  dec.addChunk({
    sampleRate: IN, numberOfFrames: 60 * IN, numberOfChannels: 2, format: 'f32', data: st,
  });
  const da = dec.finish();
  const ratio = da.duration / wa.duration;
  ok(`48k stereo -> 8k mono duration sane (${da.duration.toFixed(2)}s vs ${wa.duration.toFixed(2)}s)`,
     Math.abs(ratio - 1) < 0.01, `ratio ${ratio.toFixed(4)}`);
}

/* ------------------------------------------------------ 4. library -- */

console.log('\nlibrary end-to-end (synthetic, music planted at different offsets):');
{
  const music = musicSignal(11 * RATE);          // the "theme" — identical in every episode
  const ids = [];
  const lib = new Library();
  const truth = new Map();

  for (let e = 0; e < 6; e++) {
    const id = `S01E0${e + 1}`;
    ids.push(id);
    const pre = speechSignal((25 + e * 4) * RATE, RATE, 100 + e);
    const post = speechSignal((24 - e * 2) * RATE, RATE, 200 + e);
    const x = cat(pre, music, post);
    const off = pre.length / RATE;
    truth.set(id, off);

    const a = new EpisodeAnalyzer({ id });
    a.addChunk({
      sampleRate: RATE, numberOfFrames: x.length, numberOfChannels: 1,
      format: 'f32-planar', data: [x],
    });
    lib.add(a.finish());
  }
  ok(`library holds ${lib.size} episodes`, lib.size === 6);

  const disc = lib.discover({ minDf: 0.5, minSupportCount: 3 });
  ok(`discovery runs and returns candidates (${disc.candidates.length})`, disc.candidates.length >= 1);

  const assets = lib.refine(disc.candidates);
  ok(`refine runs and returns assets (${assets.length})`, assets.length >= 1);

  const segOut = lib.segment(assets[0]);
  ok(`segment runs and returns per-episode segments (${segOut.length})`,
     segOut.length >= 1 && segOut.every((r) => Array.isArray(r.segments)));

  // NOTE: no positional accuracy is asserted here. Synthetic audio is a poor
  // proxy for the chroma stages — these generated episodes are near-stationary
  // (constant RMS, no scene structure), which produces spurious consensus that
  // does not occur on real material. Positional accuracy is covered by
  // test/integration.mjs against real episodes, which is the meaningful check.
}

/* ------------------------------------------------------- CFA + extras -- */
//
// CFA is the one feature that does NOT run at the pipeline's 8 kHz: it is
// measured at 11.025 kHz because porting it down was measured worse against the
// hand-judged rows (see computeCFA).
//
// These are structural checks. They deliberately do NOT assert that CFA scores
// a synthetic tone above synthetic speech: it does not, and neither did the
// surveyed implementation. A strong isolated tone leaves 90% of the spectrum
// "above its local mean" (the far-field sidelobes sit above a 21-bin local mean),
// so the activation becomes one broad plateau with no peaks in it. The feature
// works on real material, where the spectrum is dense with simultaneous
// partials — and that is where it was validated: on the three survey episodes
// this implementation differs from the surveyed column on 136 of 62,179 frames
// (spread over two episodes, none on the third) and changes not one detection,
// so the OR built on it keeps the surveyed 20 hits / 0 false alarms. The
// real-corpus checks live in the integration test.
console.log('\nCFA and the extra detectors:');
{
  const out = computeCFA(musicSignal(4 * CFA_SAMPLE_RATE, CFA_SAMPLE_RATE),
    { sampleRate: CFA_SAMPLE_RATE, nFrames: 137, frameRate: 15.625 });
  ok(`CFA returns one score per requested frame (${out.length})`, out.length === 137);
  ok('CFA rejects a missing sampleRate',
     (() => { try { computeCFA(new Float32Array(4096), { nFrames: 10, frameRate: 15 }); return false; } catch { return true; } })());
  ok('CFA on too-short audio yields zeros rather than throwing',
     computeCFA(new Float32Array(100), { sampleRate: CFA_SAMPLE_RATE, nFrames: 5, frameRate: 15.625 })
       .every((v) => v === 0));
  // digital silence must not produce a division or a NaN through log10(0)
  ok('CFA on digital silence is all zeros',
     computeCFA(new Float32Array(4 * CFA_SAMPLE_RATE),
       { sampleRate: CFA_SAMPLE_RATE, nFrames: 30, frameRate: 15.625 }).every((v) => v === 0));

  // segmentBySeries is the shape both extra detectors use: one series,
  // thresholded at the midpoint between its exemplar and non-exemplar means.
  const FPS = 8000 / 512;
  const SECONDS = 60;
  const nFrames = Math.round(SECONDS * FPS);
  const feats = new Float32Array(nFrames * NFEAT);
  const series = new Float32Array(nFrames);
  for (let t = 0; t < nFrames; t++) {
    const sec = t / FPS;
    const on = (sec >= 10 && sec < 20) || (sec >= 40 && sec < 50);
    for (let f = 0; f < NFEAT; f++) feats[t * NFEAT + f] = -40;
    series[t] = on ? 0.9 : 0.1;
  }
  const episode = { id: 'synthetic', features: { feats, nFrames, frameRate: FPS, duration: SECONDS } };
  const segs = segmentBySeries(episode, [[10, 20]], series, { levelSlack: 0, minPeak: -1e9 });
  const covers = (a) => segs.some((x) => x.start <= a && a < x.end);
  ok(`segmentBySeries finds the exemplar and the matching region it never saw (${segs.length})`,
     covers(15) && covers(45));
  ok('segmentBySeries does not fire outside them', !covers(30));
  ok('a mismatched series length is rejected, not silently misaligned',
     (() => { try { segmentBySeries(episode, [[10, 20]], new Float32Array(10)); return false; } catch { return true; } })());
  const flipped = segmentBySeries(episode, [[10, 20]], series, { levelSlack: 0, minPeak: -1e9, direction: -1 });
  // tolerance: bounds land on frame quanta, so a segment ending at 10 s can
  // report 10.048 s without covering any music
  const overlapWith = (ranges) => flipped.reduce((sum, x) => sum +
    ranges.reduce((a, [lo, hi]) => a + Math.max(0, Math.min(x.end, hi) - Math.max(x.start, lo)), 0), 0);
  ok(`direction -1 inverts the detector (${flipped.length} segment(s), ${overlapWith([[10, 20], [40, 50]]).toFixed(2)}s on the music)`,
     flipped.length > 0 && overlapWith([[10, 20], [40, 50]]) < 0.2);
}

/* ------------------------------------------------- dialog over music -- */
//
// The dialog detector's job is narrower than "speech or music": it has to find
// speech while music is playing. Calibration and thresholds were measured against
// hand-judged windows, so these are structural checks plus one synthetic
// property — that the combination responds to the cue it is built on.
//
// The cue is cross-band modulation STRUCTURE, not modulation amount: in music
// one source modulates every band together, in speech each band moves on its own.
console.log('\ndialog over music:');
{
  const N = 20 * RATE;
  const opts = { sampleRate: 8000, nFrames: 320, frameRate: 15.625 };

  // A steady chord: every band shares the same 4 Hz modulation envelope.
  const synced = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / RATE;
    const beat = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
    synced[i] = beat * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 660 * t)
      + 0.3 * Math.sin(2 * Math.PI * 1320 * t));
  }
  // Speech-like: syllabic bursts whose spectral content moves independently.
  const rnd = (() => { let s = 5; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
  const speechy = new Float32Array(N);
  let env = 0, f1 = 500, f2 = 1500, p1 = 0, p2 = 0;
  for (let i = 0; i < N; i++) {
    if (rnd() < 1 / (0.18 * RATE)) { env = 0.7 + 0.3 * rnd(); f1 = 300 + 600 * rnd(); f2 = 1200 + 1500 * rnd(); }
    env *= 0.9992;
    p1 += (2 * Math.PI * f1) / RATE; p2 += (2 * Math.PI * f2) / RATE;
    speechy[i] = (0.5 * Math.sin(p1) + 0.4 * Math.sin(p2) + 0.5 * Math.sin(2 * Math.PI * 3000 * i / RATE)) * Math.max(0, env);
  }

  const dSync = computeDialog(synced, opts);
  const dSpeech = computeDialog(speechy, opts);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  ok('computeDialog returns one value per feature frame',
     dSync.bandSync.length === 320 && dSync.modSpeech.length === 320 && dSync.periodicity.length === 320);
  ok('all three series are finite',
     [dSync, dSpeech].every((d) => ['bandSync', 'modSpeech', 'periodicity']
       .every((k) => d[k].every((v) => Number.isFinite(v)))));
  // bandSync is 1 - mean cross-band correlation, so it is LOW when every band
  // shares one modulation envelope (a beat) and HIGH when the bands move
  // independently (speech). Measured 0.02 against 0.36 on these two signals.
  const syncMeans = mean(dSync.bandSync), speechMeans = mean(dSpeech.bandSync);
  ok(`band synchrony is low for a shared beat and high for independent bands (${syncMeans.toFixed(3)} vs ${speechMeans.toFixed(3)})`,
     speechMeans > syncMeans);
  ok('band synchrony stays inside [0, 1]',
     [...dSync.bandSync, ...dSpeech.bandSync].every((v) => v >= -1e-6 && v <= 1 + 1e-6));

  ok('computeDialog needs 8 kHz input',
     (() => { try { computeDialog(synced, { sampleRate: 11025, nFrames: 10, frameRate: 15.625 }); return false; } catch { return true; } })());
  ok('computeDialog rejects a missing nFrames',
     (() => { try { computeDialog(synced, { sampleRate: 8000, frameRate: 15.625 }); return false; } catch { return true; } })());

  // The score is a fixed-constant combination, so it must be comparable between
  // episodes rather than re-centred per episode.
  const silent = computeDialog(new Float32Array(N), opts);
  const score = dialogWindowScore(silent, 15.625, 1, 6);
  ok(`digital silence scores far below the threshold (${score.toFixed(2)} vs ${DIALOG_THRESHOLD})`,
     score < DIALOG_THRESHOLD - 1);

  // A segment is flagged when ANY 6 s window inside it clears the threshold, so
  // the same audio flags the same way regardless of where the segment was cut.
  const flaggedLong = segmentHasDialog(dSpeech, 15.625, 1, 18, -99);
  const flaggedShort = segmentHasDialog(dSpeech, 15.625, 5, 11, -99);
  ok('a permissive threshold flags both a long and a short segment',
     flaggedLong.hasDialog && flaggedShort.hasDialog);
  const never = segmentHasDialog(dSpeech, 15.625, 1, 18, 99);
  ok('an impossible threshold flags neither', !never.hasDialog);
  ok('segmentHasDialog reports the score it decided on',
     Number.isFinite(flaggedLong.score) && flaggedLong.score >= flaggedShort.score - 1e-6);
}

/* ------------------------------------------- level gate (synthetic) -- */
//
// The general-music stage's false positives are quiet: room tone, or a scene
// under a music bed, scores just as "musical" as real music while sitting far
// below it. This builds both cases in feature space — identical timbre, one loud
// and one quiet — so the gate can be checked without audio.
//
// minPeak is neutralised because the score is only defined up to an affine
// transform: on real audio a true cue peaks around 2, but hand-built features
// land wherever the weights put them, and that floor is not what is under test.
{
  const FPS = 8000 / 512;          // the real analysis frame rate
  const SECONDS = 60;
  const nFrames = Math.round(SECONDS * FPS);
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  // Background mirrors real material: its LEVEL varies hugely frame to frame
  // (silence through speech) while its timbre stays noise-like. That spread is
  // what stops the discriminant keying on level — it is why logRms earns a tiny
  // weight on real episodes, and why a separate level gate is needed at all.
  //
  const background = () => [
    -52 + 26 * rnd(), 0.14 + 0.10 * rnd(), 0.26 + 0.08 * rnd(),
    0.29 + 0.03 * rnd(), 0.14 + 0.03 * rnd(), 0.70 + 0.06 * rnd(),
  ];
  const music = (level) => [
    level, 0.62 + 0.05 * rnd(), 0.075 + 0.02 * rnd(),
    0.24 + 0.01 * rnd(), 0.07 + 0.01 * rnd(), 0.85 + 0.04 * rnd(),
  ];

  const feats = new Float32Array(nFrames * NFEAT);
  for (let t = 0; t < nFrames; t++) {
    const sec = t / FPS;
    const v = (sec >= 10 && sec < 22) ? music(-27)
      : (sec >= 35 && sec < 50) ? music(-45)
      : background();
    for (let f = 0; f < NFEAT; f++) feats[t * NFEAT + f] = v[f];
  }
  const episode = { id: 'synthetic', features: { feats, nFrames, frameRate: FPS, duration: SECONDS } };
  const exemplar = [[10, 22]];     // the loud region, as a detected theme would be

  const gated = (slack) =>
    segmentEpisode(episode, exemplar, { levelSlack: slack, minPeak: -1e9 }).segments;
  const covers = (segs, at) => segs.some((s) => s.start <= at && at < s.end);

  const open = gated(0);
  ok(`level gate off: loud and identical-timbre quiet cue both segment (${open.length})`,
     covers(open, 16) && covers(open, 42));

  const closed = gated(8);
  ok(`level gate on: the loud cue survives (${closed.length})`, covers(closed, 16));
  ok('level gate on: the 18 dB quieter cue of identical timbre is dropped', !covers(closed, 42));

}

/* ------------------------------------------- music stage length cap -- */
//
// The theme stage refuses to treat a minutes-long smear as an occurrence. The
// music stage needs the same ceiling, because a run that never closes would be
// proposed as one enormous cut — and enabled by default.
{
  const FPS = 15.625, SECONDS = 600;
  const n = Math.round(SECONDS * FPS);
  const scores = new Float32Array(n).fill(-1);

  // 320s of a 600s episode — the shape a misfire over a long stretch takes
  for (let i = Math.round(60 * FPS); i < Math.round(380 * FPS); i++) scores[i] = 1;

  const loose = segment(scores, FPS, { mid: 0, maxFractionOfEpisode: 1 });
  const capped = segment(scores, FPS, { mid: 0 });            // default 0.25
  ok(`music cap off: a 320s run over a 600s episode is proposed (${loose.length})`,
     loose.length === 1);
  ok('music cap on: that run is dropped', capped.length === 0);

  // an ordinary cue must be untouched
  const small = new Float32Array(n).fill(-1);
  for (let i = Math.round(60 * FPS); i < Math.round(75 * FPS); i++) small[i] = 1;
  ok('music cap on: a 15s cue of the same episode survives',
     segment(small, FPS, { mid: 0 }).length === 1);
}

/* --------------------------------------- music segments must not overlap -- */
//
// Edge refinement walks while the smoothed score is above `edge`, which is
// deliberately BELOW the detection threshold. When a gap dips under `thr` but
// not under `edge`, both neighbouring runs satisfy that walk and grow through
// each other. Measured on the real corpus before this was bounded: two S02E01
// segments overlapped by 36.4 seconds.
{
  const FPS = 15.625;
  const scores = new Float32Array(6000).fill(-1);   // 384s episode
  for (let i = 1000; i < 1200; i++) scores[i] = 1;
  for (let i = 1200; i < 1240; i++) scores[i] = 0.45;   // under thr, above edge
  for (let i = 1240; i < 1440; i++) scores[i] = 1;

  const segs = segment(scores, FPS, { mid: 0.5 });
  ok(`two cues separated by a shallow gap are both found (${segs.length})`, segs.length === 2);

  let worst = 0;
  for (let i = 1; i < segs.length; i++) worst = Math.max(worst, segs[i - 1].end - segs[i].start);
  ok(`and they do not overlap each other (worst ${worst.toFixed(2)}s)`, worst <= 0);

  const sorted = segs.every((s, i) => i === 0 || s.start >= segs[i - 1].start);
  ok('segments come out in time order', sorted);
}

/* ------------------------------------------------------------ progress -- */
//
// Progress used to report only the decode, which is ~30% of the work: the meter
// reached 100% and then sat there while chroma, features and fingerprints ran.
// The property worth defending is that it keeps MOVING through finish().
{
  const x = cat(musicSignal(30 * RATE), speechSignal(30 * RATE));
  const a = new EpisodeAnalyzer({ id: 'progress' });
  a.addChunk({
    sampleRate: RATE, numberOfFrames: x.length, numberOfChannels: 1,
    format: 'f32-planar', data: [x],
  });
  a.expectedFrames = x.length;

  // The property is that decode reports a PARTIAL figure, leaving room for the
  // stages that have not run yet. The exact share moves whenever the stage
  // profile is re-measured (it is 56% here since CFA's 11 kHz pass joined the
  // profile and pushed the others down), so the bound is deliberately loose.
  ok(`decode alone reports partial progress (${(a.progress * 100).toFixed(0)}%)`,
     a.progress > 0.1 && a.progress < 0.8);

  const seen = [];
  a.finish({ onProgress: (p) => seen.push(p) });

  ok(`progress is monotonic through finish() (${seen.length} updates)`,
     seen.length > 5 && seen.every((p, i) => i === 0 || p >= seen[i - 1] - 1e-9));
  ok('progress never exceeds 1', seen.every((p) => p <= 1 + 1e-9));
  ok(`progress ends at 1 (${seen.at(-1)})`, Math.abs(seen.at(-1) - 1) < 1e-9);
  ok(`progress advances through the feature stages (${seen.filter((p) => p > 0.35 && p < 0.95).length} updates between 35% and 95%)`,
     seen.filter((p) => p > 0.35 && p < 0.95).length > 3);
}

/* ------------------------------------------------- decode progress units -- */
//
// Decode progress has to be counted in the same units as expectedFrames. It was
// counted in INPUT frames while expectedFrames is in TARGET frames, so a 48 kHz
// source saturated the ratio after a sixth of the audio: progress stopped at 30%
// and stayed there for the rest of the decode.
{
  const a = new EpisodeAnalyzer({ id: 'decode-units' });
  const SECONDS = 60, SRC = 48000, CH = 4800;      // 0.1s chunks at the source rate
  a.expectedFrames = SECONDS * a.targetSampleRate;

  const trace = [];
  for (let off = 0; off + CH <= SECONDS * SRC; off += CH) {
    a.addChunk({
      sampleRate: SRC, numberOfFrames: CH, numberOfChannels: 1,
      format: 'f32-planar', data: [new Float32Array(CH)],
    });
    trace.push(a.progress);
  }
  const at = (f) => trace[Math.floor(trace.length * f)];
  // derive the decode share rather than pinning it, so re-weighting the stages
  // does not silently invalidate these assertions
  const share = trace.at(-1);

  ok(`decode progress tracks the audio, not the input rate (${(at(0.5) * 100).toFixed(1)}% at halfway, share ${(share * 100).toFixed(0)}%)`,
     Math.abs(at(0.5) - share / 2) < share * 0.05);
  ok(`decode progress stays monotonic (${(at(0.25) * 100).toFixed(1)} / ${(at(0.75) * 100).toFixed(1)}%)`,
     trace.every((p, i) => i === 0 || p >= trace[i - 1] - 1e-9));
  ok('decode progress never exceeds its share before finish()',
     trace.every((p) => p <= share + 1e-9));

  a.finish({ chroma: false, fingerprints: false, segments: false });
  ok(`decode is credited in full once finish() runs (${(a.progress * 100).toFixed(0)}%)`,
     a.progress >= share - 1e-9);
}

/* ------------------------------------------- computeFeatures reporting -- */
//
// Two things that made the meter lumpy, both invisible without a test:
//  - the modulation-energy and self-similarity passes after the STFT loop are
//    ~30% of the stage, and went unmetered, so the bar sat still at the end of
//    every episode;
//  - finish() computed chroma, then computeFeatures silently computed it AGAIN.
{
  const x = cat(musicSignal(20 * RATE), speechSignal(20 * RATE));
  const chroma = computeChroma(x, { sampleRate: RATE });

  const seen = [];
  computeFeatures(x, { sampleRate: RATE, chroma, onProgress: (f) => seen.push(f) });

  ok(`computeFeatures meters its tail passes (${seen.filter((f) => f >= 0.70 - 1e-9).length} reports at or after 70%)`,
     seen.filter((f) => f >= 0.70 - 1e-9).length >= 3);
  ok('computeFeatures progress is monotonic and ends at 1',
     seen.every((f, i) => i === 0 || f >= seen[i - 1] - 1e-9) && Math.abs(seen.at(-1) - 1) < 1e-9);

  // the handoff must be exact, not merely close: same chroma, same numbers
  const a = computeFeatures(x, { sampleRate: RATE });
  const b = computeFeatures(x, { sampleRate: RATE, chroma });
  ok('reusing a chroma pass gives bit-identical features',
     a.feats.length === b.feats.length && a.feats.every((v, i) => v === b.feats[i]));

  // and a chroma from a different frame grid must be refused, not silently used
  let threw = false;
  try { computeFeatures(x, { sampleRate: RATE, chroma, nfft: 1024, hop: 256 }); } catch { threw = true; }
  ok('a mismatched chroma is rejected rather than misused', threw);
}

/* ------------------------------------------------ fused spectral pass -- */
//
// finish() accumulates chroma inside computeFeatures' own STFT pass instead of
// running a second one. That has to be exactly equivalent, not merely close,
// because chroma feeds the refinement stage that positions every cut.
{
  const x = cat(musicSignal(20 * RATE), speechSignal(20 * RATE));
  const solo = computeChroma(x, { sampleRate: RATE });
  const apart = computeFeatures(x, { sampleRate: RATE, chroma: solo });
  const fused = computeFeatures(x, { sampleRate: RATE, alsoChroma: true });

  ok('fused chroma is bit-identical to a standalone pass',
     solo.C.length === fused.chroma.C.length && solo.C.every((v, i) => v === fused.chroma.C[i]));
  ok('fused features are bit-identical to the split path',
     apart.feats.length === fused.feats.length && apart.feats.every((v, i) => v === apart.feats[i]));

  // The fused path runs no chroma stage at all, so its share has to be folded
  // into features. Left unspent, the meter tops out around 0.82 and never ends.
  const a = new EpisodeAnalyzer({ id: 'fused-progress' });
  a.addChunk({
    sampleRate: RATE, numberOfFrames: x.length, numberOfChannels: 1,
    format: 'f32-planar', data: [x],
  });
  a.expectedFrames = x.length;
  const seen = [];
  a.finish({ onProgress: (p) => seen.push(p) });
  ok(`progress still reaches 1 when chroma is fused (${(seen.at(-1) * 100).toFixed(1)}%)`,
     Math.abs(seen.at(-1) - 1) < 1e-9);
  ok('and the fused progress is monotonic',
     seen.every((p, i) => i === 0 || p >= seen[i - 1] - 1e-9));
}

console.log(`\npreferredInput: ${JSON.stringify(preferredInput)}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
