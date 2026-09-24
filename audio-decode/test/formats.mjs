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
import { demuxMp4 } from '../src/mp4.mjs';
import { cutAudio, outputExtensionFor } from '../src/cut.mjs';
import { demuxWav, demuxAiff, decodePcm, selectPcmFrames, muxPcm } from '../src/pcm.mjs';

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
for (const [fmt, codec] of [['flac', 'flac'], ['mp3', 'libmp3lame'], ['wav', 'pcm_s16le'], ['aiff', 'pcm_s16be']]) {
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
  ok(`  output would be named .${name.toLowerCase()}`,
     outputExtensionFor(bytes.subarray(0, 16)) === name.toLowerCase());

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

/* -------------------------------------------------------------- video -- */
//
// Dropping a video in is a normal thing to do, and it needs no special path: the
// audio track is an ordinary MP4 audio track and the video track is skipped. The
// two layouts differ though — QuickTime's version-1 sound description puts the
// codec config 16 bytes further into the sample entry than the standard layout,
// and missing it yields no codec string rather than an error. Both are checked.
for (const [label, ext, args] of [
  ['MP4', 'mp4', []],
  ['MOV', 'mov', ['-f', 'mov']],
]) {
  const vid = join(work, `video.${ext}`);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc=size=160x120:rate=10', '-i', join(DIR, source),
    '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'copy', '-shortest',
    ...args, vid], { encoding: 'utf8' });
  if (r.status !== 0) { console.log(`SKIP: could not build a ${label} video fixture`); continue; }

  console.log(`${label} with a video track:`);
  const bytes = new Uint8Array(readFileSync(vid));
  const d = demuxMp4(bytes);
  ok(`  audio track found alongside the video (${d.track.codec})`, !!d.track.codec);
  ok(`  codec config was located despite the ${label} sample-entry layout`, d.track.codec === 'mp4a.40.2');
  ok(`  duration is the full ${(d.durationUs / 1e6).toFixed(1)}s`,
     Math.abs(d.durationUs / 1e6 - 30) < 0.5);
  // the output is audio-only, so it is an m4a however the input was named
  ok('  output would be named .m4a, not .' + ext,
     outputExtensionFor(bytes.subarray(0, 16)) === 'm4a');

  const { bytes: out } = cutAudio(bytes, [[5, 15]], { mode: 'remove' });
  const cutPath = join(work, `video-cut-${ext}.m4a`);
  writeFileSync(cutPath, out);
  const dur = probeDuration(cutPath);
  ok(`  cutting the audio out yields valid audio (${dur}s)`,
     Number.isFinite(dur) && Math.abs(dur - 20) < 0.4);
  console.log('');
}

/* ----------------------------------------------------------------- PCM -- */
//
// PCM is the one case with no decoder in it. The bytes are the samples, so
// "decode" is integer-to-float arithmetic and the cut is byte arithmetic at
// frame granularity — meaning the cut must be bit-identical, not merely close.
{
  console.log('PCM (WAV/AIFF):');
  for (const [name, demux] of [['wav', demuxWav], ['aiff', demuxAiff]]) {
    const bytes = new Uint8Array(readFileSync(join(work, `sample.${name}`)));
    const d = demux(bytes);
    ok(`  ${name}: sniffed as ${name}`, sniffContainer(bytes.subarray(0, 16)) === name);
    ok(`  ${name}: codec names the sample format (${d.track.codec})`, /^pcm-/.test(d.track.codec));
    ok(`  ${name}: duration matches ffprobe (${(d.durationUs / 1e6).toFixed(2)}s)`,
       Math.abs(d.durationUs / 1e6 - 60) < 0.1);
    ok(`  ${name}: no per-frame sample list to build`, d.samples === undefined);

    let frames = 0;
    for await (const c of decodePcm(bytes, d, { fromSeconds: 1, toSeconds: 2 })) frames += c.numberOfFrames;
    ok(`  ${name}: streams 1s as ${frames} frames`, frames === d.track.sampleRate);

    const kept = selectPcmFrames(d.pcm, [[20, 40]], { mode: 'remove' });
    const out = muxPcm(bytes, d, kept);
    const cutPath = join(work, `pcm-cut.${name}`);
    writeFileSync(cutPath, out);
    const dur = probeDuration(cutPath);
    ok(`  ${name}: ffprobe accepts the cut (${dur}s, want 40)`,
       Number.isFinite(dur) && Math.abs(dur - 40) < 0.1);
    ok(`  ${name}: decodes cleanly`, decodesCleanly(cutPath).ok);

    // the surviving audio must be the source's bytes, unchanged
    const buf = (f) => spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-t', '10', '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: 1 << 28 }).stdout;
    const a = buf(join(work, `sample.${name}`)), b = buf(cutPath);
    ok(`  ${name}: audio before the cut is bit-identical (${a.length} bytes)`,
       a.length === b.length && a.equals(b));
  }
  console.log('');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
