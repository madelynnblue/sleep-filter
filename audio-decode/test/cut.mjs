#!/usr/bin/env node
/**
 * Lossless-cut tests.
 *
 * The claim being tested is strong: removing music should not alter the
 * remaining audio AT ALL, because only whole AAC frames are dropped and the
 * bitstream is re-muxed untouched. So this does not just check durations — it
 * decodes the original and the cut file and compares samples directly.
 *
 * Also checks the output is a structurally valid MP4 by demuxing it back.
 *
 * SKIPS cleanly (exit 0) when the corpus or ffmpeg is unavailable.
 *
 *   node test/cut.mjs [corpusDir]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { demuxMp4 } from '../src/mp4.mjs';
import { cutAudio, selectSamples, normalizeRanges, rangesFromSegments } from '../src/cut.mjs';
import { openAudioFile } from '../src/index.mjs';

const DIR = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2]
  : join(homedir(), 'Downloads', 'andy-richter-audio');
const RATE = 16000, CH = 1;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

console.log('audio-decode: lossless cut\n');

if (!existsSync(DIR)) { console.log(`SKIP: corpus not found at ${DIR}`); process.exit(0); }
if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('SKIP: ffmpeg not on PATH'); process.exit(0); }

const file = readdirSync(DIR).filter((f) => extname(f).toLowerCase() === '.m4a').sort()[0];
if (!file) { console.log(`SKIP: no .m4a files in ${DIR}`); process.exit(0); }
const path = join(DIR, file);
const source = new Uint8Array(readFileSync(path));

/* ------------------------------------------------ range helpers -- */

console.log('range helpers:');
{
  ok('normalizeRanges sorts and merges',
     JSON.stringify(normalizeRanges([[10, 20], [5, 8], [18, 25]])) ===
     JSON.stringify([{ start: 5, end: 8 }, { start: 10, end: 25 }]));
  ok('normalizeRanges drops degenerate ranges',
     normalizeRanges([[5, 5], [7, 3], [1, 2]]).length === 1);
  ok('rangesFromSegments maps segments',
     JSON.stringify(rangesFromSegments([{ start: 1, end: 2 }])) === JSON.stringify([[1, 2]]));
  ok('accepts tuple or object ranges',
     normalizeRanges([[1, 2], { start: 3, end: 4 }]).length === 2);
}

/* ------------------------------------------------------ cut: remove -- */

console.log('\ncut (remove) — strip a 12s region:');
{
  const demuxed = demuxMp4(source);
  const ts = demuxed.track.timescale;
  const srcSeconds = demuxed.samples.reduce((n, s) => n + s.duration, 0) / ts;

  // a mid-file region, so there is audio on both sides
  const start = 300, end = 312;
  const { bytes, info } = cutAudio(source, [[start, end]], { mode: 'remove' });

  ok(`output produced (${(bytes.length / 1e6).toFixed(1)} MB)`, bytes.length > 0);
  ok(`removed ≈ requested (${info.removedSeconds.toFixed(3)}s vs ${info.requestedSeconds}s)`,
     Math.abs(info.removedSeconds - info.requestedSeconds) <= info.frameSeconds + 1e-6,
     `snap ${info.snapSeconds.toFixed(4)}s, frame ${info.frameSeconds.toFixed(4)}s`);
  ok(`output duration = source - removed`,
     Math.abs(info.outputSeconds - (srcSeconds - info.removedSeconds)) < 1e-3);
  ok(`sample counts add up (${info.keptSamples} + ${info.removedSamples} = ${demuxed.samples.length})`,
     info.keptSamples + info.removedSamples === demuxed.samples.length);

  // structural validity: can our own demuxer read it back?
  let redemuxed = null;
  try { redemuxed = demuxMp4(bytes); } catch (e) { ok('output re-demuxes', false, e.message); }
  if (redemuxed) {
    ok(`output re-demuxes (${redemuxed.track.sampleCount} samples, codec ${redemuxed.track.codec})`,
       redemuxed.track.sampleCount === info.keptSamples);
    ok('output keeps codec config', !!redemuxed.track.description?.length);
    ok('output sample rate/channels preserved',
       redemuxed.track.sampleRate === demuxed.track.sampleRate &&
       redemuxed.track.channels === demuxed.track.channels);
    const outSeconds = redemuxed.samples.reduce((n, s) => n + s.duration, 0) / redemuxed.track.timescale;
    ok(`output duration matches info (${outSeconds.toFixed(3)}s)`,
       Math.abs(outSeconds - info.outputSeconds) < 0.05);
    const mono = redemuxed.samples.every((s, i) => i === 0 || s.timestampUs >= redemuxed.samples[i - 1].timestampUs);
    ok('output timestamps monotonic', mono);
  }

  // ---- the real test: is the kept audio bit-identical? ----
  //
  // Compare at the NATIVE rate. Resampling to a lower rate during the test
  // (as an earlier version did) makes ffmpeg's resampler filter differ across
  // the splice and produces ~0.2 differences that are entirely an artefact of
  // the measurement, not the muxer — the codec-domain content is untouched.
  const nativeRate = demuxed.track.sampleRate;
  const sel = selectSamples(demuxed, [[start, end]], { mode: 'remove' });
  const first = sel.removed[0];
  const lastRemoved = sel.removed[sel.removed.length - 1];
  const cutFrom = first.timestamp / ts;
  const cutTo = (lastRemoved.timestamp + lastRemoved.duration) / ts;

  // exact, from the sample table: media units are samples when the media
  // timescale equals the sample rate (which it does for AAC)
  const shift = sel.removed.reduce((n, s) => n + s.duration, 0);
  const splice = Math.round(cutFrom * nativeRate);
  const guard = Math.round(0.1 * nativeRate);   // covers the MDCT overlap at the seam

  const dir = mkdtempSync(join(tmpdir(), 'cut-test-'));
  const cutPath = join(dir, 'cut.m4a');
  writeFileSync(cutPath, bytes);

  // original, decoded once at native rate into a preallocated buffer.
  // The decoded length excludes the encoder priming, which the edit list trims.
  const expectFrames = demuxed.samples.reduce((n, s) => n + s.duration, 0)
    - (demuxed.track.editMediaTime ?? 0);
  const A = new Float32Array(expectFrames);
  {
    const opened = await openAudioFile(path, {
      backend: 'ffmpeg', sampleRate: nativeRate, channels: 1, framesPerChunk: nativeRate,
    });
    let o = 0;
    for await (const c of opened.chunks()) { A.set(c.data, o); o += c.data.length; }
    ok(`original decoded at native rate (${o} of ${expectFrames} frames)`, o === expectFrames);
  }

  // cut file, streamed — keeps peak memory to a single full-rate buffer
  let maxBefore = 0, maxAfter = 0, beforeChecked = 0, afterChecked = 0, idx = 0;
  {
    const opened = await openAudioFile(cutPath, {
      backend: 'ffmpeg', sampleRate: nativeRate, channels: 1, framesPerChunk: nativeRate,
    });
    for await (const c of opened.chunks()) {
      for (let i = 0; i < c.data.length; i++, idx++) {
        const v = c.data[i];
        if (idx < splice - guard) {
          const d = Math.abs(A[idx] - v);
          if (d > maxBefore) maxBefore = d;
          beforeChecked++;
        } else if (idx >= splice + guard) {
          const q = idx + shift;
          if (q >= A.length) break;
          const d = Math.abs(A[q] - v);
          if (d > maxAfter) maxAfter = d;
          afterChecked++;
        }
      }
    }
  }

  ok(`audio BEFORE the cut is bit-identical (max diff ${maxBefore}, ${beforeChecked} frames)`,
     maxBefore === 0 && beforeChecked > nativeRate * 60);
  ok(`audio AFTER the cut is bit-identical (max diff ${maxAfter}, ${afterChecked} frames)`,
     maxAfter === 0 && afterChecked > nativeRate * 60);

  // spot checks well away from the splice, which would catch a systematic
  // misalignment that a single whole-region max could mask
  {
    const opened = await openAudioFile(cutPath, {
      backend: 'ffmpeg', sampleRate: nativeRate, channels: 1, framesPerChunk: nativeRate,
    });
    const frameCount = sel.kept.reduce((n, s) => n + s.duration, 0);
    const B = new Float32Array(frameCount);
    let o = 0;
    for await (const c of opened.chunks()) { B.set(c.data, o); o += c.data.length; }
    const win = nativeRate * 10;
    for (const at of [5, 30, 120, 600]) {
      const p = splice + nativeRate * at;
      if (p + win >= B.length) continue;
      let d = 0;
      for (let i = 0; i < win; i++) d = Math.max(d, Math.abs(A[p + i + shift] - B[p + i]));
      ok(`  window at +${at}s after the splice is bit-identical (max diff ${d})`, d === 0);
    }
  }
}

/* -------------------------------------------------------- cut: keep -- */

console.log('\ncut (keep) — extract only a region:');
{
  const { bytes, info } = cutAudio(source, [[300, 312]], { mode: 'keep' });
  ok(`extracted ≈ 12s (${info.outputSeconds.toFixed(3)}s)`,
     Math.abs(info.outputSeconds - 12) <= info.frameSeconds + 1e-6,
     `snap ${info.snapSeconds.toFixed(4)}s`);
  const re = demuxMp4(bytes);
  ok(`extract re-demuxes (${re.track.sampleCount} samples)`, re.track.sampleCount === info.keptSamples);
}

/* ------------------------------------------------------------ tags -- */

console.log('\ntags survive the cut:');
{
  // The cut is the same episode with music removed, so its title, artist, track
  // number and so on still describe it. udta is copied verbatim rather than
  // re-serialised, so anything the source carries comes back byte for byte.
  const { bytes } = cutAudio(source, [[300, 312]], { mode: 'remove' });
  const before = demuxMp4(source).udtaRaw;
  const after = demuxMp4(bytes).udtaRaw;

  ok(`source carries a udta box (${before ? before.length : 0} bytes)`, !!before);
  ok(`output carries one too (${after ? after.length : 0} bytes)`, !!after);
  ok('udta is byte-identical',
     !!before && !!after && before.length === after.length &&
     before.every((v, i) => v === after[i]));
}

/* ------------------------------------------------------------ edges -- */

console.log('\nedge cases:');
{
  const demuxed = demuxMp4(source);
  const ts = demuxed.track.timescale;
  const total = demuxed.samples.reduce((n, s) => n + s.duration, 0) / ts;

  // empty range list must be a no-op, not a corruption
  const none = cutAudio(source, [], { mode: 'remove' });
  ok(`no ranges -> unchanged length (${none.info.outputSeconds.toFixed(2)}s of ${total.toFixed(2)}s)`,
     Math.abs(none.info.outputSeconds - total) < 0.05);

  // ranges entirely beyond the end are harmless
  const beyond = cutAudio(source, [[total + 100, total + 200]], { mode: 'remove' });
  ok('out-of-range cuts are a no-op', Math.abs(beyond.info.outputSeconds - total) < 0.05);

  // removing everything must refuse rather than write a broken file
  let threw = false;
  try { cutAudio(source, [[0, total + 10]], { mode: 'remove' }); } catch { threw = true; }
  ok('refuses to remove every sample', threw);

  // overlapping ranges must not double-count
  const merged = cutAudio(source, [[300, 310], [305, 315]], { mode: 'remove' });
  ok(`overlapping ranges merged (removed ${merged.info.removedSeconds.toFixed(2)}s ≈ 15s)`,
     Math.abs(merged.info.removedSeconds - 15) <= merged.info.frameSeconds + 1e-6);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
