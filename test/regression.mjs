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
  MonoResampler, segmentEpisode, segment, preferredInput,
} from '../src/index.mjs';
import { NFEAT } from '../src/features.mjs';

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
  ok('computeChroma identical', close(a.C, b.C).ok, close(a.C, b.C).detail);

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

  ok(`decode alone reports partial progress (${(a.progress * 100).toFixed(0)}%)`,
     a.progress > 0.1 && a.progress < 0.5);

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

console.log(`\npreferredInput: ${JSON.stringify(preferredInput)}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
