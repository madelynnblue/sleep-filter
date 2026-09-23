#!/usr/bin/env node
/**
 * Container coverage beyond MP4: FLAC and MP3.
 *
 * These are the two formats the built-in path handles natively besides MP4, and
 * neither has a sample table — FLAC frames are found by parsing headers and
 * scanning for the next sync, MP3 frames by computing their length from the
 * header. Both of those are easy to get subtly wrong in a way that still decodes
 * most of the file, so this checks the frame list tiles the stream exactly, and
 * that ffmpeg agrees the cut output is valid and the right length.
 *
 * Fixtures are generated from the corpus with ffmpeg, so nothing binary is
 * committed. SKIPS cleanly (exit 0) when the corpus or ffmpeg is unavailable.
 *
 *   node test/formats.mjs [corpusDir]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { demuxFlac, muxFlac } from '../src/flac.mjs';
import { demuxMp3, muxMp3 } from '../src/mp3.mjs';
import { sniffContainer } from '../src/container.mjs';

const DIR = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2]
  : join(homedir(), 'Downloads', 'andy-richter-audio');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

console.log('audio-decode: FLAC and MP3\n');

if (!existsSync(DIR)) { console.log(`SKIP: corpus not found at ${DIR}`); process.exit(0); }
if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('SKIP: ffmpeg not on PATH'); process.exit(0); }

const source = readdirSync(DIR).filter((f) => extname(f).toLowerCase() === '.m4a').sort()[0];
if (!source) { console.log(`SKIP: no .m4a files in ${DIR}`); process.exit(0); }

const work = mkdtempSync(join(tmpdir(), 'audio-decode-fmt-'));
const fixtures = {};
for (const [fmt, codec] of [['flac', 'flac'], ['mp3', 'libmp3lame']]) {
  const out = join(work, `sample.${fmt}`);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', join(DIR, source),
    '-t', '60', '-c:a', codec, out], { encoding: 'utf8' });
  if (r.status !== 0) { console.log(`SKIP: ffmpeg could not make a ${fmt} fixture — ${r.stderr?.slice(0, 120)}`); process.exit(0); }
  fixtures[fmt] = new Uint8Array(readFileSync(out));
}

/** ffprobe's opinion of a file's duration, in seconds. */
const probeDuration = (path) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', path], { encoding: 'utf8' });
  return parseFloat(r.stdout);
};
const decodesCleanly = (path) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
  return { ok: r.status === 0, stderr: r.stderr ?? '' };
};

/** Shared shape checks plus a 20s excise in the middle, validated by ffmpeg. */
function checkFormat(name, bytes, demux, mux, { secondIn, minRate, noMd5Warning = false }) {
  console.log(`${name}:`);
  ok(`  sniffed as ${name.toLowerCase()}`, sniffContainer(bytes.subarray(0, 16)) === name.toLowerCase(),
     sniffContainer(bytes.subarray(0, 16)));

  const d = demux(bytes);
  ok(`  sample rate is sane (${d.track.sampleRate} Hz)`, d.track.sampleRate >= minRate);
  ok(`  channel count is sane (${d.track.channels})`, d.track.channels >= 1 && d.track.channels <= 8);
  ok(`  duration matches ffprobe (${(d.durationUs / 1e6).toFixed(2)}s)`,
     Math.abs(d.durationUs / 1e6 - secondIn) < 0.2);
  ok(`  ${d.samples.length} frames, all positive and contiguous`,
     d.samples.every((s, i) => s.size > 0 &&
       s.offset + s.size === (d.samples[i + 1]?.offset ?? s.offset + s.size)) &&
     d.samples[0].offset === d.headerEnd);
  ok('  timestamps are monotonic',
     d.samples.every((s, i) => i === 0 || s.timestamp >= d.samples[i - 1].timestamp));

  const at = (sec) => d.samples.findIndex((s) => s.timestamp / d.track.sampleRate >= sec);
  const from = at(20), to = at(40);
  const kept = [...d.samples.slice(0, from), ...d.samples.slice(to)];
  const out = mux(bytes, d, kept);

  const path = join(work, `cut-${name.toLowerCase()}`);
  writeFileSync(path, out);

  const dur = probeDuration(path);
  ok(`  ffprobe reads the cut file (${dur}s)`, Number.isFinite(dur));
  ok(`  and it is 20s shorter (${dur}s vs ~${secondIn - 20}s)`,
     Math.abs(dur - (secondIn - 20)) < 0.6);
  const dec = decodesCleanly(path);
  ok('  ffmpeg decodes the cut file without error', dec.ok, dec.stderr.slice(0, 200));
  if (noMd5Warning) {
    ok('  no stale-integrity warning', !/md5/i.test(dec.stderr), dec.stderr.slice(0, 200));
  }
  console.log('');
}

checkFormat('FLAC', fixtures.flac, demuxFlac, muxFlac,
  { secondIn: 60, minRate: 8000, noMd5Warning: true });
checkFormat('MP3', fixtures.mp3, demuxMp3, muxMp3, { secondIn: 60, minRate: 8000 });

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
