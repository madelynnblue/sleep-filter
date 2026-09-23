#!/usr/bin/env node
/**
 * Node harness for the discovery + refinement spike.
 *
 * Decodes each media file to 8 kHz mono via ffmpeg (standing in for the
 * browser's WebCodecs AudioDecoder + downsample step), then:
 *
 *   pass 1  decode -> fingerprint + chroma   (keep only the ~1 MB of features)
 *   pass 2  discover recurring assets from the fingerprints
 *   pass 3  refine each asset with chroma to precise, per-episode cut points
 *
 * Usage:
 *   node run-node.mjs [dir] [--limit N] [--seconds S] [--peaks N] [--no-refine] [--debug]
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { fingerprint, discover, formatTime } from './discovery.mjs';
import { computeChroma } from './chroma.mjs';
import { refineAsset } from './refine.mjs';

/* ------------------------------------------------------------- options -- */

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const DIR = positional[0] || join(homedir(), 'Downloads', 'andy-richter-audio');
const LIMIT = flag('limit', null) ? Number(flag('limit', null)) : null;
const SECONDS = flag('seconds', null) ? Number(flag('seconds', null)) : null;
const PEAKS = flag('peaks', null) ? Number(flag('peaks', null)) : null;
const DO_REFINE = !argv.includes('--no-refine');
const SR = 8000;

/* ------------------------------------------------------------ decoding -- */

function decodeToMono(file, seconds) {
  const args = ['-v', 'error'];
  if (seconds) args.push('-t', String(seconds));
  args.push('-i', file, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-');
  const res = spawnSync('ffmpeg', args, { maxBuffer: 512 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`ffmpeg failed on ${file}: ${res.stderr}`);
  const buf = res.stdout;
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/* -------------------------------------------------- ground truth (known) -- */
// Theme positions from the independent chroma-alignment method. Scoring only;
// discovery never sees these.
const TRUTH = {
  S01E01: 150.72, S01E02: 101.88, S01E03: 249.98, S01E04: 189.05, S01E05: 187.71,
  S01E06: 136.32, S01E07: 180.73, S02E01: 214.08, S02E02: 126.52, S02E03: 231.61,
  S02E04: 105.28, S02E05: 178.30, S02E06: 168.89, S02E07: 233.72, S02E08: 147.64,
  S02E09: 144.83, S02E10: 133.76, S02E11: 129.47, S02E12: 186.24,
};
const TRUTH_SPAN = 12.67;

/* ---------------------------------------------------------------- main -- */

const files = readdirSync(DIR)
  .filter((f) => ['.m4a', '.mp4', '.mkv', '.webm', '.mp3', '.aac', '.flac', '.wav'].includes(extname(f).toLowerCase()))
  .sort()
  .slice(0, LIMIT || undefined)
  .map((f) => ({ name: f, path: join(DIR, f), id: (f.match(/S\d+E\d+/) || [f.replace(extname(f), '')])[0] }));

if (!files.length) { console.error(`no media files in ${DIR}`); process.exit(1); }

console.log(`discovery + refinement spike — ${files.length} episodes from ${DIR}`);
if (SECONDS) console.log(`(analysing first ${SECONDS}s of each)`);
console.log('');

const t0 = Date.now();
const episodes = [];
const chromas = new Map();
const MUTE = flag('mute-theme', null) ? Number(flag('mute-theme', null)) : 0;
let muted = [];
for (const f of files) {
  const ta = Date.now();
  const samples = decodeToMono(f.path, SECONDS);

  // Synthetic resilience test: destroy the theme in the first K episodes so we
  // can verify the pipeline still finds it and reports those episodes ABSENT.
  if (MUTE > 0 && muted.length < MUTE && TRUTH[f.id] !== undefined) {
    const a = Math.max(0, Math.round((TRUTH[f.id] - 1) * SR));
    const b = Math.min(samples.length, Math.round((TRUTH[f.id] + 14) * SR));
    samples.fill(0, a, b);
    muted.push(f.id);
  }

  const fp = fingerprint(samples, { sampleRate: SR });
  episodes.push({ id: f.id, ...fp });
  if (DO_REFINE) chromas.set(f.id, computeChroma(samples, { sampleRate: SR }));
  console.log(
    `  ${f.id}  ${(samples.length / SR).toFixed(0).padStart(5)}s  ` +
    `${String(fp.stats.peaks).padStart(7)} peaks  ${String(fp.stats.hashes).padStart(7)} hashes  ` +
    `${((Date.now() - ta) / 1000).toFixed(1)}s` +
    (muted.includes(f.id) ? '   [THEME DESTROYED]' : '')
  );
}
console.log(`\npass 1 (decode + features): ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const td = Date.now();
const MIN_DF = flag('min-df', null) ? Number(flag('min-df', null)) : null;
const MIN_SUP = flag('min-support', null) ? Number(flag('min-support', null)) : null;
const TOP = flag('top', null) ? Number(flag('top', null)) : null;
const RANK = flag('rank', null) || null;
const dopts = {};
if (PEAKS) dopts.maxPeaksPerPair = PEAKS;
if (MIN_DF !== null) dopts.minDf = MIN_DF;
if (MIN_SUP !== null) dopts.minSupportCount = MIN_SUP;
if (TOP) dopts.maxAssets = TOP;
if (RANK) dopts.rankBy = RANK;
const res = discover(episodes, dopts);
console.log(`pass 2 (discovery): ${((Date.now() - td) / 1000).toFixed(2)}s  — ` +
            `${res.recurringHashes} recurring hashes, ${res.peaks.length} consensus peaks, ` +
            `${res.candidates.length}/${res.totalCandidates ?? res.candidates.length} asset(s) kept ` +
            `(minDf ${MIN_DF ?? 0.2}, min episodes ${res.minSupport})`);
if (res.referenceTrials) {
  console.log(`  reference trials: ${res.referenceTrials.map((t) => `${t.referenceId}(${t.score})`).join(', ')}`);
}

if (!res.candidates.length) {
  console.log('\nNO RECURRING ASSETS FOUND — the app would abstain here.');
  process.exit(0);
}

if (argv.includes('--debug')) {
  console.log('\n--- top offset-consensus peaks ---');
  for (const p of res.peaks.slice().sort((a, b) => b.votes - a.votes).slice(0, 10)) {
    console.log(`  vs ${p.otherId}: ${String(p.votes).padStart(5)} votes  ` +
                `ref ${formatTime(p.tRefStart)}-${formatTime(p.tRefEnd)}  ` +
                `other ${formatTime(p.tOtherStart)}-${formatTime(p.tOtherEnd)}`);
  }
}

/* ------------------------------------------------------------ refine -- */

const THR = flag('thr', null) ? Number(flag('thr', null)) : null;

if (DO_REFINE && argv.includes('--sweep')) {
  console.log('\nboundary strategy comparison (top asset, inliers only):');
  const trials = [
    ['threshold 0.85', { thr: 0.85 }],
    ['threshold 0.90', { thr: 0.90 }],
    ['threshold 0.95', { thr: 0.95 }],
    ['thr 0.90 + envelope', { thr: 0.90, extent: 'envelope' }],
    ['thr 0.95 + envelope', { thr: 0.95, extent: 'envelope' }],
    ['gradient', { boundary: 'gradient' }],
    ['gradient + envelope', { boundary: 'gradient', extent: 'envelope' }],
  ];
  for (const [label, opts] of trials) {
    const r = refineAsset(chromas, res.candidates[0], opts);
    const flagged = new Set(r.outliers || []);
    const rows = r.episodes.filter((e) => TRUTH[e.id] !== undefined && !flagged.has(e.id));
    const errs = rows.map((e) => Math.abs(e.start - TRUTH[e.id]));
    const endErrs = rows.map((e) => Math.abs(e.end - (TRUTH[e.id] + TRUTH_SPAN)));
    const spans = r.episodes.map((e) => e.span).sort((a, b) => a - b);
    const span = spans[spans.length >> 1];
    console.log(
      `  ${label.padEnd(20)} span ${span.toFixed(2)}s (truth ${TRUTH_SPAN})  ` +
      `start mean|err| ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2)}s ` +
      `(within1s ${errs.filter((a) => a <= 1).length}/${errs.length})  ` +
      `end mean|err| ${(endErrs.reduce((a, b) => a + b, 0) / endErrs.length).toFixed(2)}s`
    );
  }
  process.exit(0);
}

if (DO_REFINE) {
  const tr = Date.now();
  res.refined = res.candidates.map((c) => refineAsset(chromas, c, THR ? { thr: THR } : {}));
  const ok = res.refined.filter((r) => r && r.refinedCount > 0).length;
  console.log(`pass 3 (chroma refinement): ${((Date.now() - tr) / 1000).toFixed(2)}s  — ` +
              `${ok}/${res.candidates.length} asset(s) refined`);
}

/* ------------------------------------------------------------ report -- */

console.log('\n' + '='.repeat(78));
console.log('DISCOVERED RECURRING ASSETS');
console.log('='.repeat(78));

const list = (DO_REFINE && res.refined ? res.refined : res.candidates).filter(Boolean);

if (list.length) {
  console.log('\nPREVALENCE (most common first)');
  console.log(`  ${'#'.padEnd(3)} ${'kind'.padEnd(16)} ${'episodes'.padEnd(14)} ${'length'.padEnd(8)} ${'mean start'.padEnd(11)} sim`);
  list.forEach((c, i) => {
    console.log(
      `  ${String(i + 1).padEnd(3)} ${c.kind.padEnd(16)} ` +
      `${(c.support + '/' + episodes.length).padEnd(14)} ` +
      `${(c.span.toFixed(2) + 's').padEnd(8)} ${formatTime(c.meanStart).padEnd(11)} ` +
      `${c.meanSim !== undefined ? c.meanSim.toFixed(3) : '-'}`
    );
  });
}

list.forEach((c, i) => {
  console.log(
    `\n#${i + 1}  ${c.kind.toUpperCase()}\n` +
    `    length ${c.span.toFixed(2)}s   support ${c.support}/${episodes.length} ` +
    `(${(c.supportFraction * 100).toFixed(0)}%)   mean start ${formatTime(c.meanStart)}` +
    (c.meanSim !== undefined ? `   mean similarity ${c.meanSim.toFixed(3)}` : '') +
    (c.medianOffsetShift !== undefined ? `   offset shift ${c.medianOffsetShift.toFixed(2)}s` : '')
  );
  if (c.episodes[0] && c.episodes[0].sim !== undefined) {
    console.log(`    per-episode (present first, then position):`);
    for (const e of c.episodes) {
      if (e.present === false) {
        console.log(`      ${e.id}  ABSENT — no asset in this episode`);
      } else {
        console.log(
          `      ${e.id}  ${formatTime(e.start)} - ${formatTime(e.end)}  ` +
          `(${e.span.toFixed(2)}s, sim ${e.sim.toFixed(3)})${e.isReference ? ' [ref]' : ''}`
        );
      }
    }
  } else {
    const line = c.episodes
      .map((e) => e.present === false
        ? `${e.id.replace(/^S0?/, '')}:ABSENT`
        : `${e.id.replace(/^S0?/, '')}:${formatTime(e.start)}`)
      .join('  ');
    console.log(`    ${line}`);
  }
});

/* ---------------------------------------------------------- validation -- */

const pick = (arr) => (arr || []).find((c) => c && c.kind === 'title-theme') || (arr || []).filter(Boolean)[0];
const fpAsset = pick(res.candidates);
const refAsset = DO_REFINE ? pick(res.refined) : null;

console.log('\n' + '='.repeat(78));
console.log('VALIDATION vs independent chroma ground truth');
console.log('='.repeat(78));

function score(asset, label) {
  if (!asset) return;
  const absent = new Set(asset.absent || []);
  const errs = [], out = [];
  for (const e of asset.episodes) {
    if (TRUTH[e.id] === undefined) continue;
    if (absent.has(e.id) || e.present === false) { out.push({ id: e.id }); continue; }
    const rec = { id: e.id, err: e.start - TRUTH[e.id] };
    errs.push(rec);
  }
  const abs = errs.map((e) => Math.abs(e.err));
  const mean = abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : NaN;
  const spans = asset.episodes.map((e) => e.span).sort((a, b) => a - b);
  const span = spans[spans.length >> 1];
  console.log(`\n  ${label}`);
  console.log(`    span ${span.toFixed(2)}s (truth ${TRUTH_SPAN}s, diff ${(span - TRUTH_SPAN).toFixed(2)}s)`);
  console.log(`    inliers n=${abs.length}  mean |err| ${mean.toFixed(2)}s  max ${Math.max(...abs).toFixed(2)}s  ` +
              `within 1.0s ${abs.filter((a) => a <= 1.0).length}/${abs.length}`);
  if (out.length) console.log(`    flagged outliers: ${out.map((o) => o.id).join(', ')}`);
}

score(fpAsset, 'STAGE 1 ONLY (fingerprint discovery)');
if (refAsset && refAsset !== fpAsset) score(refAsset, 'STAGE 1 + 2 (after chroma refinement)');

console.log(`\ntotal wall time ${((Date.now() - t0) / 1000).toFixed(1)}s`);
