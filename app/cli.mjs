#!/usr/bin/env node
/**
 * Remove music from a folder of episodes.
 *
 * The same orchestration the web page uses, with audio-decode's ffmpeg backend
 * instead of WebCodecs.
 *
 *   node app/cli.mjs <dir> [options]
 *
 * Options
 *   --out <dir>       output directory            (default <dir>/no-music)
 *   --asset <n>       which discovered asset to strip, 0 = top  (default 0)
 *   --mode <m>        remove | keep               (default remove)
 *   --min-df <f>      document-frequency pre-filter            (default 0.2)
 *   --min-support <n> minimum episodes for an asset            (default 3)
 *   --limit <n>       only process the first n files
 *   --dry-run         analyse and report, write nothing
 *   --quiet           only print the final summary
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { analyzeAll, discoverAssets, musicRanges, renderCut } from './pipeline.mjs';
import { formatTime } from '../src/index.mjs';

const MEDIA = ['.m4a', '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.mp3', '.aac', '.flac', '.wav', '.ogg', '.opus'];

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);
const DIR = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

if (!DIR || has('help')) {
  console.log(`usage: node app/cli.mjs <dir> [--out <dir>] [--asset N] [--mode remove|keep]
       [--min-df F] [--min-support N] [--limit N] [--dry-run] [--quiet]`);
  process.exit(DIR ? 0 : 1);
}
if (!existsSync(DIR)) {
  console.error(`no such directory: ${DIR}`);
  process.exit(1);
}

const OUT = flag('out', join(DIR, 'no-music'));
const ASSET = Number(flag('asset', 0));
const MODE = flag('mode', 'remove');
const MIN_DF = Number(flag('min-df', 0.2));
const MIN_SUPPORT = Number(flag('min-support', 3));
const LIMIT = flag('limit', null) ? Number(flag('limit', null)) : null;
const DRY = has('dry-run');
const QUIET = has('quiet');
const say = (...a) => { if (!QUIET) console.log(...a); };

let files = readdirSync(DIR)
  .filter((f) => MEDIA.includes(extname(f).toLowerCase()))
  .sort();
if (LIMIT) files = files.slice(0, LIMIT);
if (!files.length) {
  console.error(`no media files in ${DIR}`);
  process.exit(1);
}

say(`removing music from ${files.length} file(s) in ${DIR}\n`);

/* ------------------------------------------------------------ phase 1 -- */

const t0 = Date.now();
const analyses = await analyzeAll(
  files.map((f) => ({ id: (f.match(/S\d+E\d+/) || [basename(f, extname(f))])[0], source: join(DIR, f) })),
  {
    onFile: (id, i, n) => say(`  [${i + 1}/${n}] ${id}`),
  },
);
say(`\nphase 1 (decode + features): ${((Date.now() - t0) / 1000).toFixed(1)}s`);

/* ------------------------------------------------------------ phase 2 -- */

const t1 = Date.now();
const { library, assets } = discoverAssets(analyses, {
  discover: { minDf: MIN_DF, minSupportCount: MIN_SUPPORT },
});
say(`phase 2 (discovery + refinement): ${((Date.now() - t1) / 1000).toFixed(1)}s\n`);

if (!assets.length) {
  console.log('no recurring assets found — nothing to remove.');
  console.log('(try lowering --min-df / --min-support, or the music may not repeat across episodes)');
  process.exit(0);
}

console.log(`DISCOVERED ASSETS (ranked by prevalence)`);
console.log(`  ${'#'.padEnd(3)} ${'kind'.padEnd(16)} ${'episodes'.padEnd(12)} ${'length'.padEnd(9)} ${'mean start'.padEnd(11)} confidence`);
assets.forEach((a, i) => {
  console.log(`  ${String(i).padEnd(3)} ${a.kind.padEnd(16)} ` +
    `${`${a.support}/${a.totalEpisodes ?? analyses.length}`.padEnd(12)} ` +
    `${(a.span.toFixed(1) + 's').padEnd(9)} ${formatTime(a.meanStart).padEnd(11)} ` +
    `${a.meanSim !== null && a.meanSim !== undefined ? a.meanSim.toFixed(3) : '-'}`);
});

const asset = assets[Math.min(ASSET, assets.length - 1)];
if (!asset) { console.error(`asset ${ASSET} does not exist`); process.exit(1); }
console.log(`\nselected asset #${Math.min(ASSET, assets.length - 1)}: ${asset.kind} ` +
            `(${asset.support}/${asset.totalEpisodes ?? analyses.length} episodes, ${asset.span.toFixed(1)}s)`);
if (asset.absent?.length) console.log(`  absent from: ${asset.absent.join(', ')}`);

/* -------------------------------------------------------------- cut -- */

const t2 = Date.now();
const perEpisode = musicRanges(library, asset, { segment: {} });
say(`phase 3 (segmentation): ${((Date.now() - t2) / 1000).toFixed(1)}s\n`);

if (!DRY) mkdirSync(OUT, { recursive: true });

console.log(`\nPER EPISODE`);
console.log(`  ${'episode'.padEnd(10)} ${'segments'.padEnd(10)} ${'music'.padEnd(10)} ${'output'.padEnd(12)} file`);
let totalRemoved = 0, written = 0, failed = 0;

for (const { id, ranges, segments } of perEpisode) {
  const file = files.find((f) => (f.match(/S\d+E\d+/) || [basename(f, extname(f))])[0] === id);
  if (!file) continue;
  const srcPath = join(DIR, file);
  let line = `  ${id.padEnd(10)} ${String(segments.length).padEnd(10)}`;

  if (!ranges.length) {
    console.log(`${line} ${'-'.padEnd(10)} ${'-'.padEnd(12)} (no music detected)`);
    continue;
  }

  try {
    const source = new Uint8Array(readFileSync(srcPath));
    const { bytes, info } = renderCut(source, ranges, { mode: MODE });
    totalRemoved += info.removedSeconds;

    const stem = basename(file, extname(file));
    const suffix = MODE === 'keep' ? ' (music only)' : ' (no music)';
    const outName = `${stem}${suffix}${extname(file)}`;
    if (!DRY) writeFileSync(join(OUT, outName), bytes);
    written++;
    console.log(`${line} ${(info.removedSeconds.toFixed(0) + 's').padEnd(10)} ` +
      `${(info.outputSeconds.toFixed(0) + 's').padEnd(12)} ${DRY ? '(dry run)' : outName}`);
  } catch (e) {
    failed++;
    console.log(`${line} FAILED — ${e.message}`);
  }
}

console.log(`\n${MODE === 'keep' ? 'extracted' : 'removed'} ${totalRemoved.toFixed(0)}s of music ` +
            `across ${written} file(s)${failed ? `, ${failed} failed` : ''}`);
if (!DRY && written) console.log(`written to ${OUT}`);
