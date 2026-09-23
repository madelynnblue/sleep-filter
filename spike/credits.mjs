#!/usr/bin/env node
/**
 * Find which episodes share end-credits music, using a known ground-truth
 * anchor: credits start at 21:38 (1298s) in S01E04 ("Grief Counselor").
 *
 * Takes the credits region from S01E04 as a chroma template and slides it over
 * the tail of every episode. Episodes that share the credits music light up at
 * ~0.9+ similarity; episodes without it stay low.
 *
 * Works in "seconds before end" coordinates so episodes of different lengths
 * line up.
 *
 *   node credits.mjs [--anchor S01E04] [--at 1298] [--len 28] [--tail 200]
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { computeChroma } from './chroma.mjs';

const SR = 8000;
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

const DIR = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
  || join(homedir(), 'Downloads', 'andy-richter-audio');
const ANCHOR = flag('anchor', 'S01E04');
const AT = Number(flag('at', 1298));      // credits start in the anchor, seconds
const LEN = Number(flag('len', 28));      // template length used for matching
const TAIL = Number(flag('tail', 200));   // how much of each tail to search

const files = readdirSync(DIR)
  .filter((f) => ['.m4a', '.mp4', '.mkv', '.webm', '.mp3', '.aac', '.flac', '.wav'].includes(extname(f).toLowerCase()))
  .sort()
  .map((f) => ({ path: join(DIR, f), id: (f.match(/S\d+E\d+/) || [f])[0] }));

/** Decode the last `sec` seconds and return chroma, plus total duration. */
function tailChroma(file, sec) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const dur = parseFloat(probe.stdout.trim());
  const r = spawnSync('ffmpeg', ['-v', 'error', '-sseof', `-${sec}`, '-i', file,
    '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { maxBuffer: 512 * 1024 * 1024 });
  const b = r.stdout, n = b.length >> 1;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(i * 2) / 32768;
  return { chroma: computeChroma(s, { sampleRate: SR }), duration: dur, tailLen: s.length / SR };
}

console.log(`anchor ${ANCHOR}, credits at ${AT}s, template ${LEN}s, searching last ${TAIL}s\n`);

const anchors = new Map();
for (const f of files) {
  if (f.id === ANCHOR) anchors.set(f.id, tailChroma(f.path, TAIL));
  else anchors.set(f.id, null);
}
const A = anchors.get(ANCHOR);
if (!A) { console.error(`anchor ${ANCHOR} not found`); process.exit(1); }

// template: frames for [AT, AT+LEN] expressed against the anchor's own tail
const fps = A.chroma.frameRate;
const endOffset = A.duration - AT;                 // seconds before end where credits start
const t0 = Math.round((A.tailLen - endOffset) * fps);
const t1 = Math.round(t0 + LEN * fps);
const nT = t1 - t0;
console.log(`anchor tail ${A.tailLen.toFixed(1)}s, credits start ${endOffset.toFixed(1)}s before end ` +
            `(frames ${t0}..${t1})\n`);

const template = new Float32Array(nT * 12);
template.set(A.chroma.C.subarray(t0 * 12, t1 * 12));

/** best mean cosine similarity of the template anywhere in B */
function bestMatch(B) {
  const hop = 2;
  let best = -Infinity, bestAt = 0;
  const nB = B.nFrames;
  for (let start = 0; start + nT <= nB; start += hop) {
    let s = 0;
    for (let i = 0; i < nT; i++) {
      const ao = i * 12, bo = (start + i) * 12;
      for (let c = 0; c < 12; c++) s += template[ao + c] * B.C[bo + c];
    }
    const m = s / nT;
    if (m > best) { best = m; bestAt = start; }
  }
  return { sim: best, beforeEnd: (B.nFrames - bestAt) / B.frameRate };
}

console.log(`${'episode'.padEnd(10)} ${'duration'.padEnd(10)} ${'similarity'.padEnd(11)} credits start (before end)`);
console.log('-'.repeat(64));
const results = [];
for (const f of files) {
  const B = f.id === ANCHOR ? A.chroma : tailChroma(f.path, TAIL).chroma;
  const { sim, beforeEnd } = bestMatch(B);
  results.push({ id: f.id, sim, beforeEnd });
  const tag = f.id === ANCHOR ? '  [anchor]' : (sim > 0.8 ? '  <== SHARED CREDITS' : '');
  const dur = f.id === ANCHOR ? A.duration : (anchors.get(f.id)?.duration ?? 0);
  console.log(`${f.id.padEnd(10)} ${(dur.toFixed(1) + 's').padEnd(10)} ${sim.toFixed(3).padEnd(11)} ` +
              `${beforeEnd.toFixed(1)}s${tag}`);
}

const shared = results.filter((r) => r.sim > 0.8);
console.log(`\n${shared.length} of ${results.length} episodes share the anchor's credits music:`);
console.log('  ' + shared.map((r) => r.id).join(', '));
