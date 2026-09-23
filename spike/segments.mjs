#!/usr/bin/env node
/**
 * Per-episode music segmentation.
 *
 * Finds ALL music in each episode: theme, credits, interludes/stings and songs
 * used as part of the episode. Unlike shared-asset discovery this needs no
 * repeat across episodes, which is the only way to reach music that differs
 * every week (credits on this show).
 *
 * Calibrated on the title theme — a music exemplar the discovery stages already
 * identified with high confidence — so no hand-tuned absolute thresholds.
 *
 * Validation is built in:
 *   - theme recall      (should be found; it is what we calibrated on)
 *   - credits recall    (user-supplied starts, ~36s before end)
 *   - dialogue false positives (sampled away from theme and credits)
 *
 *   node segments.mjs [dir] [--bias 0] [--detail 2]
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { computeFeatures, calibrate, scoreFrames, segment, FEATURE_NAMES, NFEAT } from './music.mjs';

const SR = 8000;
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const DIR = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
  || join(homedir(), 'Downloads', 'andy-richter-audio');
const BIAS = Number(flag('bias', 0));
const DETAIL = Number(flag('detail', 2));

// theme starts from stages 1+2 (independently verified)
const THEME = {
  S01E01: 150.72, S01E02: 101.88, S01E03: 249.98, S01E04: 189.05, S01E05: 187.71,
  S01E06: 136.32, S01E07: 180.73, S02E01: 214.08, S02E02: 126.52, S02E03: 231.61,
  S02E04: 105.28, S02E05: 178.30, S02E06: 168.89, S02E07: 233.72, S02E08: 147.64,
  S02E09: 144.83, S02E10: 133.76, S02E11: 129.47, S02E12: 186.24,
};
const THEME_LEN = 12.67;
const CREDIT_TAIL = 36;   // credits start this many seconds before the end

// Regions the user has listened to and confirmed contain dialogue and NO music.
// These give a real negative class, turning "non-theme flagged" (an upper bound,
// since it includes genuine interludes) into an actual false-positive rate.
const VERIFIED_DIALOGUE = {
  S01E01: [[188, 218]],   // Pilot            3:08-3:38, immediately after the theme
  S02E01: [[371, 401]],   // Bully the Kid    6:11-6:41
  S02E03: [[308, 338]],   // Duh Dog          5:08-5:38
};

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
  .map((f) => ({ path: join(DIR, f), id: (f.match(/S\d+E\d+/) || [f])[0] }))
  .filter((f) => THEME[f.id] !== undefined);

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

console.log(`per-episode music segmentation — ${files.length} episodes from ${DIR}`);
console.log(`calibrating on the title theme; threshold bias ${BIAS}\n`);

const rows = [];
let detailShown = 0;

for (const f of files) {
  const samples = decode(f.path);
  const F = computeFeatures(samples, { sampleRate: SR });
  const dur = F.duration;
  const fps = F.frameRate;

  // positives: theme frames. negatives: everything else, EXCLUDING the known
  // credits window (also music — including it would corrupt the calibration).
  const mask = new Uint8Array(F.nFrames);
  const ta = Math.round(THEME[f.id] * fps), tb = Math.round((THEME[f.id] + THEME_LEN) * fps);
  for (let t = ta; t < tb && t < F.nFrames; t++) mask[t] = 1;
  const creditA = Math.round((dur - CREDIT_TAIL - 4) * fps);
  const usable = [];
  for (let t = 0; t < F.nFrames; t++) if (!mask[t] && t < creditA) usable.push(t);

  const scores = new Float32Array(F.nFrames);
  const cal = calibrate(F.feats, F.nFrames, mask, {});
  if (cal) {
    const sc = scoreFrames(F.feats, F.nFrames, cal);
    scores.set(sc);
  }
  const mid = cal ? cal.mid : 0;

  // exclude the credits window from segmentation scoring only for calibration;
  // we still want to DETECT music there, so score it normally.
  const segs = segment(scores, fps, { mid, bias: BIAS });

  // ---- validation ----
  // Union coverage: merge overlapping segments first, otherwise overlapping
  // segments double-count and coverage can exceed 100%.
  const unionCov = (list, a, b) => {
    if (b <= a) return 0;
    const ev = [];
    for (const s of list) {
      const lo = Math.max(s.start, a), hi = Math.min(s.end, b);
      if (hi > lo) ev.push([lo, hi]);
    }
    if (!ev.length) return 0;
    ev.sort((x, y) => x[0] - y[0]);
    let cov = 0, curA = ev[0][0], curB = ev[0][1];
    for (let i = 1; i < ev.length; i++) {
      if (ev[i][0] <= curB) curB = Math.max(curB, ev[i][1]);
      else { cov += curB - curA; curA = ev[i][0]; curB = ev[i][1]; }
    }
    cov += curB - curA;
    return cov / (b - a);
  };
  const covers = (a, b) => unionCov(segs, a, b);
  const themeCov = covers(THEME[f.id], THEME[f.id] + THEME_LEN);
  const credStart = dur - CREDIT_TAIL;
  const credCov = covers(credStart, dur - 6);

  // dialogue probe: sample 60 windows outside theme and credits
  let dlgTotal = 0, dlgHit = 0;
  const rng = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  for (let i = 0; i < 60; i++) {
    const a = 30 + rng() * Math.max(1, credStart - 60);
    const b = a + 5;
    if (b > credStart - 10) continue;
    if (a < THEME[f.id] + THEME_LEN + 20 && b > THEME[f.id] - 20) continue;
    dlgTotal += b - a;
    for (const s of segs) dlgHit += Math.max(0, Math.min(s.end, b) - Math.max(s.start, a));
  }
  const dlgFp = dlgTotal ? dlgHit / dlgTotal : 0;

  // True false-positive rate on regions the user verified are music-free.
  const vd = VERIFIED_DIALOGUE[f.id] || [];
  const vdFp = vd.length ? vd.reduce((s, [a, b]) => s + covers(a, b), 0) / vd.length : null;

  const musicTime = segs.reduce((s, x) => s + x.duration, 0);
  rows.push({ id: f.id, dur, sep: cal ? cal.separation : 0, n: segs.length, musicTime,
              themeCov, credCov, dlgFp, vdFp, segs, scores, fps, mid, f });

  if (detailShown < DETAIL) {
    console.log(`${f.id}  ${fmt(dur)}  ${segs.length} segments, ${musicTime.toFixed(0)}s music ` +
                `(${(100 * musicTime / dur).toFixed(1)}% of episode)`);
    for (const s of segs) {
      const tag = (s.start < THEME[f.id] + THEME_LEN + 2 && s.end > THEME[f.id] - 2) ? '  [THEME]'
        : (s.start > credStart - 6 ? '  [CREDITS]' : '');
      console.log(`    ${fmt(s.start)} - ${fmt(s.end)}  (${s.duration.toFixed(1)}s, peak ${s.peak.toFixed(2)})${tag}`);
    }
    console.log('');
    detailShown++;
  }
}

// ---- summary ----
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

console.log('='.repeat(74));
console.log('SUMMARY');
console.log('='.repeat(74));
console.log(`  calibration separation : median ${med(rows.map((r) => r.sep)).toFixed(2)} pooled SD`);
console.log(`  music per episode      : median ${med(rows.map((r) => r.musicTime)).toFixed(0)}s ` +
            `(${med(rows.map((r) => 100 * r.musicTime / r.dur)).toFixed(1)}% of runtime)`);
console.log(`  segments per episode   : median ${med(rows.map((r) => r.n))}`);
console.log(`  theme recall           : ${rows.filter((r) => r.themeCov > 0.7).length}/${rows.length} episodes covered >70%`);
console.log(`  credits recall         : ${rows.filter((r) => r.credCov > 0.5).length}/${rows.length} episodes covered >50%`);
console.log(`  dialogue false positive: median ${med(rows.map((r) => r.dlgFp * 100)).toFixed(1)}% of sampled non-theme/credits audio (UPPER BOUND — includes real interludes)`);
const vrows = rows.filter((r) => r.vdFp !== null);
if (vrows.length) {
  const total = vrows.reduce((s, r) => s + r.vdFp, 0) / vrows.length;
  console.log(`  VERIFIED dialogue FP   : ${(total * 100).toFixed(1)}% on user-confirmed music-free regions ` +
              `(${vrows.map((r) => r.id).join(', ')})`);
}

console.log('\n  per episode:');
console.log(`  ${'ep'.padEnd(9)} ${'music'.padEnd(9)} ${'segs'.padEnd(6)} ${'theme'.padEnd(8)} ${'credits'.padEnd(9)} dialogue-FP`);
for (const r of rows) {
  console.log(`  ${r.id.padEnd(9)} ${(r.musicTime.toFixed(0) + 's').padEnd(9)} ${String(r.n).padEnd(6)} ` +
              `${(r.themeCov * 100).toFixed(0).padStart(4)}%    ${(r.credCov * 100).toFixed(0).padStart(4)}%     ` +
              `${(r.dlgFp * 100).toFixed(1)}%`);
}

// ---- optional: operating-point map across bias and minimum duration ----
if (argv.includes('--sweep')) {
  console.log('\n' + '='.repeat(74));
  console.log('OPERATING-POINT MAP — you pick');
  console.log('='.repeat(74));
  console.log('  "non-theme flagged" samples windows outside theme AND credits. Those');
  console.log('  windows are NOT verified dialogue: they include real interludes and');
  console.log('  songs, which SHOULD be flagged. Treat it as an UPPER BOUND on false');
  console.log('  positives, not a true FP rate.\n');
  const ucov = (segs, a, b) => {
    const ev = [];
    for (const s of segs) {
      const lo = Math.max(s.start, a), hi = Math.min(s.end, b);
      if (hi > lo) ev.push([lo, hi]);
    }
    if (!ev.length) return 0;
    ev.sort((x, y) => x[0] - y[0]);
    let cov = 0, cA = ev[0][0], cB = ev[0][1];
    for (let i = 1; i < ev.length; i++) {
      if (ev[i][0] <= cB) cB = Math.max(cB, ev[i][1]);
      else { cov += cB - cA; cA = ev[i][0]; cB = ev[i][1]; }
    }
    return (cov + cB - cA) / (b - a);
  };
  console.log(`  ${'bias'.padEnd(6)} ${'minDur'.padEnd(8)} ${'music/ep'.padEnd(10)} ${'segs'.padEnd(6)} ${'theme'.padEnd(7)} ${'credits'.padEnd(9)} non-theme flagged`);
  for (const bias of [-0.5, 0, 0.5]) {
    for (const minDur of [2, 4, 6]) {
      const tCov = [], cCov = [], fp = [], mTime = [], nSeg = [];
      for (const r of rows) {
        const segs = segment(r.scores, r.fps, { mid: r.mid, bias, minDuration: minDur });
        tCov.push(ucov(segs, THEME[r.id], THEME[r.id] + THEME_LEN));
        cCov.push(ucov(segs, r.dur - CREDIT_TAIL, r.dur - 6));
        mTime.push(segs.reduce((s, x) => s + x.duration, 0));
        nSeg.push(segs.length);
        let hit = 0, tot = 0;
        const rng = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
        for (let i = 0; i < 60; i++) {
          const a = 30 + rng() * Math.max(1, r.dur - CREDIT_TAIL - 60);
          const b = a + 5;
          if (b > r.dur - CREDIT_TAIL - 10) continue;
          if (a < THEME[r.id] + THEME_LEN + 20 && b > THEME[r.id] - 20) continue;
          tot += b - a;
          hit += ucov(segs, a, b) * (b - a);
        }
        fp.push(tot ? hit / tot : 0);
      }
      console.log(`  ${String(bias).padEnd(6)} ${(minDur + 's').padEnd(8)} ` +
                  `${(med(mTime).toFixed(0) + 's').padEnd(10)} ${String(med(nSeg)).padEnd(6)} ` +
                  `${(100 * tCov.filter((x) => x > 0.7).length / tCov.length).toFixed(0).padStart(4)}%   ` +
                  `${(100 * cCov.filter((x) => x > 0.5).length / cCov.length).toFixed(0).padStart(4)}%     ` +
                  `${(100 * med(fp)).toFixed(1)}%`);
    }
  }
}

// ---- optional: dump every detected segment for manual review ----
if (argv.includes('--dump')) {
  const out = ['# episode\tstart\tend\tduration\tpeak'];
  for (const r of rows) {
    const segs = segment(r.scores, r.fps, { mid: r.mid, bias: BIAS });
    out.push(`# ${r.id}  duration ${fmt(r.dur)}  ${segs.length} segments`);
    for (const s of segs) {
      const tag = (s.start < THEME[r.id] + THEME_LEN + 2 && s.end > THEME[r.id] - 2) ? '\t[THEME]'
        : (s.start > r.dur - CREDIT_TAIL - 6 ? '\t[CREDITS]' : '');
      out.push(`${r.id}\t${s.start.toFixed(2)}\t${s.end.toFixed(2)}\t${s.duration.toFixed(2)}\t${s.peak.toFixed(3)}${tag}`);
    }
  }
  writeFileSync('segments.tsv', out.join('\n') + '\n');
  console.log('\nwrote segments.tsv — every detected music segment, for manual review');
}
