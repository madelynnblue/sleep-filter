#!/usr/bin/env node
/**
 * Are end-credits music cues shared between episodes?
 *
 * Ground-truth credit starts supplied by the user:
 *   S01E01 (Pilot)          22:02 = 1322s
 *   S01E04 (Grief Counselor) 21:38 = 1298s
 *   S01E05 (Gimme a C)      21:22 = 1282s
 * All three sit ~35-36s before the end of the file.
 *
 * Compares, ACROSS episodes (the previous version compared one episode with
 * itself, which was meaningless):
 *   theme_i   vs theme_j     control: the theme IS shared, so this validates the method
 *   credits_i vs credits_j   the actual question
 *   theme_i   vs credits_i   are credits just the theme song re-used?
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { computeChroma } from './chroma.mjs';

const SR = 8000;
const DIR = process.argv[2] || join(homedir(), 'Downloads', 'andy-richter-audio');
const THEME = {
  S01E01: 150.72, S01E02: 101.88, S01E03: 249.98, S01E04: 189.05, S01E05: 187.71,
  S01E06: 136.32, S01E07: 180.73, S02E01: 214.08, S02E02: 126.52, S02E03: 231.61,
  S02E04: 105.28, S02E05: 178.30, S02E06: 168.89, S02E07: 233.72, S02E08: 147.64,
  S02E09: 144.83, S02E10: 133.76, S02E11: 129.47, S02E12: 186.24,
};
// user-supplied credit starts: S01E01 Pilot, S01E04 Grief Counselor,
// S01E05 Gimme a C, S01E07 Wedding
const CREDIT_AT = { S01E01: 1322, S01E04: 1298, S01E05: 1282, S01E07: 1296 };
const CREDIT_TAIL = 36;   // fallback: credits start this many seconds before end
const LEN = 25;           // comparison window

function decode(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR),
    '-f', 's16le', '-'], { maxBuffer: 512 * 1024 * 1024 });
  const b = r.stdout, n = b.length >> 1;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(i * 2) / 32768;
  return s;
}

const files = readdirSync(DIR)
  .filter((f) => extname(f).toLowerCase() === '.m4a')
  .sort()
  .map((f) => ({ path: join(DIR, f), id: (f.match(/S\d+E\d+/) || [f])[0] }));

const data = new Map();
for (const f of files) {
  if (THEME[f.id] === undefined) continue;
  const samples = decode(f.path);
  const dur = samples.length / SR;
  data.set(f.id, {
    chroma: computeChroma(samples, { sampleRate: SR }),
    dur,
    creditAt: CREDIT_AT[f.id] ?? (dur - CREDIT_TAIL),
  });
}

/** mean cosine similarity of region [a0,a0+len) in A vs [b0,b0+len) in B */
function regionSim(A, a0, B, b0, len, fps) {
  const n = Math.round(len * fps);
  const i0 = Math.round(a0 * fps), j0 = Math.round(b0 * fps);
  if (i0 < 0 || j0 < 0 || i0 + n > A.nFrames || j0 + n > B.nFrames || n <= 0) return null;
  let s = 0;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 12; c++) d += A.C[(i0 + i) * 12 + c] * B.C[(j0 + i) * 12 + c];
    s += d;
  }
  return s / n;
}

const ids = [...data.keys()];
const fps = data.get(ids[0]).chroma.frameRate;
const fmt = (v) => (v === null ? '  n/a' : v.toFixed(3));

console.log('credit start used per episode (user-supplied where known):');
for (const id of ids) {
  const d = data.get(id);
  const known = CREDIT_AT[id] !== undefined ? '  <- user supplied' : '';
  console.log(`  ${id}  dur ${d.dur.toFixed(1)}s  credits ${d.creditAt.toFixed(1)}s ` +
              `(${(d.dur - d.creditAt).toFixed(1)}s before end)${known}`);
}

// ---- control: theme vs theme ----
console.log('\nCONTROL — theme region vs S01E04 theme region (should be high):');
const th = [];
for (const id of ids) {
  if (id === 'S01E04') continue;
  const v = regionSim(data.get(id).chroma, THEME[id], data.get('S01E04').chroma, THEME.S01E04, 12, fps);
  th.push(v);
  console.log(`  ${id}  ${fmt(v)}`);
}
const med = (a) => { const s = a.filter((x) => x !== null).sort((x, y) => x - y); return s[s.length >> 1]; };
console.log(`  median ${fmt(med(th))}`);

// ---- the question: credits vs credits ----
console.log('\nCREDITS — credit region vs S01E04 credit region:');
const cr = [];
for (const id of ids) {
  if (id === 'S01E04') continue;
  const v = regionSim(data.get(id).chroma, data.get(id).creditAt,
                      data.get('S01E04').chroma, data.get('S01E04').creditAt, LEN, fps);
  cr.push(v);
  console.log(`  ${id}  ${fmt(v)}`);
}
console.log(`  median ${fmt(med(cr))}`);

// ---- are credits just the theme? ----
console.log('\nIs the credits region the theme song re-used? (own theme vs own credits)');
const self = [];
for (const id of ids) {
  const v = regionSim(data.get(id).chroma, THEME[id], data.get(id).chroma, data.get(id).creditAt, 12, fps);
  self.push(v);
  console.log(`  ${id}  ${fmt(v)}`);
}
console.log(`  median ${fmt(med(self))}`);

// ---- verdict ----
const control = med(th), credits = med(cr);
console.log('\n' + '='.repeat(64));
console.log('VERDICT');
console.log('='.repeat(64));
console.log(`  theme   vs theme   : median ${fmt(control)}   <- shared asset (control)`);
console.log(`  credits vs credits : median ${fmt(credits)}`);
console.log(`  ratio credits/theme: ${(credits / control).toFixed(2)}`);
console.log(
  credits > 0.8
    ? '  => credits ARE a shared recording; discovery should find them.'
    : '  => credits are NOT a shared recording. Cross-episode discovery cannot\n' +
      '     find them, and correctly reports no such asset rather than inventing\n' +
      '     one. Detecting these needs a PER-EPISODE method (music/speech\n' +
      '     segmentation), not shared-asset discovery.'
);
const positions = ids.map((id) => data.get(id).dur - data.get(id).creditAt).sort((a, b) => a - b);
console.log(`\n  credits sit ${positions[0].toFixed(1)}-${positions[positions.length - 1].toFixed(1)}s ` +
            `before the end (median ${positions[positions.length >> 1].toFixed(1)}s) across ${ids.length} episodes.`);
