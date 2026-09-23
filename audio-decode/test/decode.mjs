#!/usr/bin/env node
/**
 * Decode-path tests (Node).
 *
 * Node has no WebCodecs, so this exercises the ffmpeg backend and verifies its
 * output against an independent decode of the same file. It also checks the
 * backend *selection* logic, which is what decides whether a browser would take
 * the dependency-free path.
 *
 * SKIPS cleanly (exit 0) when the corpus or ffmpeg is unavailable.
 *
 *   node test/decode.mjs [corpusDir]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { openAudioFile, sniffContainer, demuxMp4 } from '../src/index.mjs';

const DIR = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2]
  : join(homedir(), 'Downloads', 'andy-richter-audio');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

console.log('audio-decode: decode path\n');

if (!existsSync(DIR)) { console.log(`SKIP: corpus not found at ${DIR}`); process.exit(0); }
if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('SKIP: ffmpeg not on PATH'); process.exit(0); }

const file = readdirSync(DIR).filter((f) => extname(f).toLowerCase() === '.m4a').sort()[0];
if (!file) { console.log(`SKIP: no .m4a files in ${DIR}`); process.exit(0); }
const path = join(DIR, file);

/* ------------------------------------------------- backend selection -- */

console.log('backend selection (browser would take the built-in path):');
{
  const opened = await openAudioFile(path, { backend: 'ffmpeg' });
  ok(`forced ffmpeg backend reports ffmpeg`, opened.backend === 'ffmpeg', opened.backend);
  ok(`info has codec/rate/channels (${opened.info.codec} ${opened.info.sampleRate}Hz ${opened.info.channels}ch)`,
     !!opened.info.codec && opened.info.sampleRate > 0 && opened.info.channels > 0);

  // With no AudioDecoder (as in Node), 'auto' must fall through rather than fail
  const auto = await openAudioFile(path);
  ok(`auto falls through to ffmpeg without WebCodecs`, auto.backend === 'ffmpeg', auto.backend);

  // The built-in path must be *viable* even though Node cannot use it — this is
  // what a browser would take, so it is worth asserting directly.
  const { readFileSync } = await import('node:fs');
  const bytes = new Uint8Array(readFileSync(path));
  const d = demuxMp4(bytes);
  ok(`built-in demuxer viable for this file (codec ${d.track.codec}, ${d.track.sampleCount} samples)`,
     !!d.track.codec && d.track.sampleCount > 0 && !d.fragmented);
}

/* ---------------------------------------------------- decode output -- */

console.log('\ndecoded output vs an independent ffmpeg decode:');
{
  const RATE = 16000, CH = 1;
  const opened = await openAudioFile(path, { backend: 'ffmpeg', sampleRate: RATE, channels: CH, framesPerChunk: RATE });

  let frames = 0, chunks = 0, nonFinite = 0, peak = 0;
  let first = null, last = null, rateOk = true, chOk = true;
  for await (const c of opened.chunks()) {
    chunks++;
    if (first === null) first = c.timestamp;
    last = c.timestamp;
    frames += c.numberOfFrames;
    if (c.sampleRate !== RATE) rateOk = false;
    if (c.numberOfChannels !== CH) chOk = false;
    for (let i = 0; i < c.data.length; i++) {
      const v = c.data[i];
      if (!Number.isFinite(v)) nonFinite++;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }

  ok('chunk sampleRate honoured', rateOk);
  ok('chunk channel count honoured', chOk);

  const durFromChunks = frames / RATE;
  ok(`streamed ${chunks} chunks, ${frames} frames (${durFromChunks.toFixed(1)}s)`,
     chunks > 10 && frames > 0);
  ok(`no non-finite samples`, nonFinite === 0, String(nonFinite));
  ok(`signal is not silent (peak ${peak.toFixed(3)})`, peak > 0.01);
  ok(`first timestamp is 0`, first === 0, String(first));
  ok(`timestamps advance`, last > 0, String(last));

  // independent reference: same ffmpeg invocation, decoded whole
  const ref = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vn',
    '-f', 'f32le', '-ac', String(CH), '-ar', String(RATE), '-'], { maxBuffer: 1 << 30 });
  const refFrames = Math.floor(ref.stdout.length / 4);
  const refDur = refFrames / RATE;
  ok(`duration matches independent decode (${durFromChunks.toFixed(2)}s vs ${refDur.toFixed(2)}s)`,
     Math.abs(durFromChunks - refDur) < 0.1, `diff ${(durFromChunks - refDur).toFixed(3)}s`);

  // and a spot check that the actual samples agree, not just the length
  const refFirst = new Float32Array(ref.stdout.buffer, ref.stdout.byteOffset, Math.min(4096, refFrames));
  const opened2 = await openAudioFile(path, { backend: 'ffmpeg', sampleRate: RATE, channels: CH, framesPerChunk: RATE });
  const it = opened2.chunks();
  const c0 = (await it.next()).value;
  let maxDiff = 0;
  for (let i = 0; i < Math.min(4096, c0.data.length); i++) {
    maxDiff = Math.max(maxDiff, Math.abs(c0.data[i] - refFirst[i]));
  }
  ok(`sample values match independent decode (max diff ${maxDiff.toExponential(1)})`, maxDiff < 1e-6);
  await it.return?.();
}

/* ----------------------------------------------------- time ranges -- */

console.log('\ntime-range decoding (what the play buttons use):');
{
  const RATE = 16000, CH = 1, from = 300, to = 312;

  // The browser path selects samples from the table; verify that directly,
  // since it cannot be executed here.
  const { readFileSync } = await import('node:fs');
  const bytes = new Uint8Array(readFileSync(path));
  const d = demuxMp4(bytes);
  const ts = d.track.timescale;
  const sel = d.samples.filter((s) => s.timestamp + s.duration > from * ts && s.timestamp < to * ts);
  const selSec = sel.reduce((n, s) => n + s.duration, 0) / ts;
  ok(`sample selection covers ~${to - from}s (${selSec.toFixed(3)}s, ${sel.length} samples)`,
     Math.abs(selSec - (to - from)) <= (sel[0].duration / ts) + 1e-6);
  ok('selection is far cheaper than a full decode',
     sel.length < d.samples.length / 50, `${sel.length} of ${d.samples.length} samples`);

  // The ffmpeg path is executable here: check it against a full decode.
  const opened = await openAudioFile(path, {
    backend: 'ffmpeg', sampleRate: RATE, channels: CH, framesPerChunk: RATE,
    fromSeconds: from, toSeconds: to,
  });
  const parts = [];
  for await (const c of opened.chunks()) parts.push(c.data);
  const ranged = new Float32Array(parts.reduce((n, x) => n + x.length, 0));
  { let o = 0; for (const x of parts) { ranged.set(x, o); o += x.length; } }

  ok(`ranged decode is ~${to - from}s (${(ranged.length / RATE).toFixed(3)}s)`,
     Math.abs(ranged.length / RATE - (to - from)) < 0.5);

  // and that it matches the full decode at that offset (allowing for seek slop)
  const full = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vn',
    '-f', 'f32le', '-ac', String(CH), '-ar', String(RATE), '-'], { maxBuffer: 1 << 30 });
  const F = new Float32Array(full.stdout.buffer, full.stdout.byteOffset, full.stdout.length / 4);
  const base = from * RATE;
  let best = { d: Infinity, off: 0 };
  for (let off = -RATE / 4; off <= RATE / 4; off += 1) {
    let dd = 0;
    for (let i = 0; i < RATE; i++) {
      const a = F[base + off + i];
      const b = ranged[i];
      if (a === undefined || b === undefined) break;
      dd = Math.max(dd, Math.abs(a - b));
    }
    if (dd < best.d) best = { d: dd, off };
  }
  // Not expected to be bit-exact, and that is fine for auditioning: seeking is
  // not sample-exact and decoding mid-stream AAC has no prior overlap-add
  // context, so the first frame differs slightly. The CUTTING path is the one
  // that must be exact, and is verified separately in test/cut.mjs.
  ok(`ranged decode closely matches the full decode (max diff ${best.d.toFixed(4)} at offset ${best.off})`,
     best.d < 0.05, `best ${best.d}`);
}

/* --------------------------------------------------------- sniffer -- */

console.log('\ncontainer sniffing:');
{
  const { readFileSync } = await import('node:fs');
  const bytes = new Uint8Array(readFileSync(path));
  ok('m4a detected as mp4', sniffContainer(bytes) === 'mp4');

  const fake = (sig) => { const b = new Uint8Array(16); b.set(sig); return b; };
  ok('webm detected', sniffContainer(fake([0x1a, 0x45, 0xdf, 0xa3])) === 'webm');
  ok('flac detected', sniffContainer(fake([0x66, 0x4c, 0x61, 0x43])) === 'flac');
  ok('ogg detected', sniffContainer(fake([0x4f, 0x67, 0x67, 0x53])) === 'ogg');
  ok('mp3 (ID3) detected', sniffContainer(fake([0x49, 0x44, 0x33])) === 'mp3');
  ok('wav detected', sniffContainer(fake([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])) === 'wav');
  ok('garbage is unknown', sniffContainer(fake([1, 2, 3, 4])) === 'unknown');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
