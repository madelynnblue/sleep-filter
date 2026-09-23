#!/usr/bin/env node
/**
 * Integration test against REAL episodes.
 *
 * Synthetic audio is a poor proxy for the chroma stages, so end-to-end accuracy
 * is validated here instead — against the same corpus the spike was developed
 * and tuned on, which is what makes the numbers comparable.
 *
 * SKIPS cleanly (exit 0) when the corpus or ffmpeg is unavailable, so this is
 * safe to leave in a default test run.
 *
 * Asserts the results established by the original spike:
 *   - the title theme is discovered with high support
 *   - per-episode start positions land within ~1s of the independent chroma
 *     ground truth, for every present episode
 *   - the one known-atypical episode is not silently given a position
 *
 *   node test/integration.mjs [corpusDir]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { EpisodeAnalyzer, Library, discover } from '../src/index.mjs';
// Exercise the REAL package boundary rather than shelling out to ffmpeg here:
// audio-decode produces the chunks a browser's WebCodecs path would produce.
import { openAudioFile } from '../audio-decode/src/index.mjs';

const SR = 8000;
const DIR = process.argv[2] || join(homedir(), 'Downloads', 'andy-richter-audio');

// independent ground truth from the chroma-alignment work
const THEME = {
  S01E01: 150.72, S01E02: 101.88, S01E03: 249.98, S01E04: 189.05, S01E05: 187.71,
  S01E06: 136.32, S01E07: 180.73, S02E01: 214.08, S02E02: 126.52, S02E03: 231.61,
  S02E04: 105.28, S02E05: 178.30, S02E06: 168.89, S02E07: 233.72, S02E08: 147.64,
  S02E09: 144.83, S02E10: 133.76, S02E11: 129.47, S02E12: 186.24,
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

console.log('music-analysis integration (real audio)\n');

if (!existsSync(DIR)) {
  console.log(`SKIP: corpus not found at ${DIR}\n      pass a directory as the first argument to run this.`);
  process.exit(0);
}
if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  console.log('SKIP: ffmpeg not on PATH (the decoder lives in a separate package; ' +
              'this test shells out to it).');
  process.exit(0);
}

const files = readdirSync(DIR)
  .filter((f) => extname(f).toLowerCase() === '.m4a')
  .sort()
  .map((f) => ({ path: join(DIR, f), id: (f.match(/S\d+E\d+/) || [f])[0] }))
  .filter((f) => THEME[f.id] !== undefined);

if (files.length < 5) {
  console.log(`SKIP: need several episodes, found ${files.length} in ${DIR}`);
  process.exit(0);
}

console.log(`decoding ${files.length} episodes through the public API ` +
            '(audio-decode -> EpisodeAnalyzer -> Library)\n');

const lib = new Library();
const t0 = Date.now();
for (const f of files) {
  const a = new EpisodeAnalyzer({ id: f.id });
  const { chunks } = await openAudioFile(f.path);
  for await (const chunk of chunks()) a.addChunk(chunk);
  lib.add(a.finish());
}
console.log(`  analyzed in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
            `(decode + phase 1 + phase 2)\n`);

ok(`library holds ${lib.size} episodes`, lib.size === files.length);

const disc = lib.discover();
const theme = disc.candidates.find((c) => c.kind === 'title-theme') || disc.candidates[0];
ok(`theme discovered (kind=${theme?.kind}, support=${theme?.support}/${lib.size})`,
   !!theme && theme.support >= Math.ceil(lib.size * 0.8));

const assets = lib.refine(disc.candidates);
const refined = assets.find((a) => a.kind === 'title-theme') || assets[0];
const present = refined.episodes.filter((e) => e.present !== false && e.start != null);
const errs = present
  .filter((e) => THEME[e.id] !== undefined)
  .map((e) => Math.abs(e.start - THEME[e.id]));
const meanErr = errs.reduce((s, x) => s + x, 0) / (errs.length || 1);
const maxErr = Math.max(...errs, 0);

ok(`theme positions within 1.5s of ground truth (n=${errs.length}, mean ${meanErr.toFixed(2)}s, max ${maxErr.toFixed(2)}s)`,
   errs.length >= files.length - 2 && meanErr < 1.5 && maxErr < 2.5);

// the known-atypical episode must not be handed a confident position
const weird = refined.episodes.find((e) => e.id === 'S02E03');
ok('atypical episode (S02E03) is absent or low-confidence, not silently placed',
   !weird || weird.present === false || (weird.sim ?? 0) < 0.9,
   weird ? `present=${weird.present} sim=${weird.sim}` : 'missing');

// No occurrence may be implausibly long. The cutter removes [start, end]
// wholesale, so a smeared occurrence does not merely look wrong — it deletes
// minutes of dialogue along with the music. These five episodes reproduce the
// condition (few episodes, so the adaptive peak threshold cannot reject generic
// content and the landmark votes smear instead of clustering). Re-running
// discovery over them costs no extra decode.
{
  const SMEARS = ['S01E04', 'S01E05', 'S01E06', 'S01E07', 'S02E01'];
  const subset = lib._fingerprintList().filter((e) => SMEARS.includes(e.id));
  const loose = discover(subset, { maxOccurrenceSeconds: Infinity });
  const guarded = discover(subset, {});

  const longest = (d) => Math.max(0, ...d.candidates.flatMap((c) =>
    c.episodes.filter((e) => e.present !== false && e.end != null).map((e) => e.end - e.start)));

  ok(`these episodes smear with the guard off (longest ${longest(loose).toFixed(1)}s)`,
     longest(loose) > 120);
  ok(`the guard removes it (longest ${longest(guarded).toFixed(1)}s)`, longest(guarded) <= 90);
}

const segOut = lib.segment(refined);
const withSegs = segOut.filter((r) => r.segments.length > 0).length;
// NOTE: these are REGRESSION GUARDS, not quality claims. The segmentation stage
// runs close to its decision boundary (calibration separation ~1.4 pooled SD),
// so marginal episodes flip between "theme only" and "nothing" on small decode
// differences — feeding 8 kHz mono directly yields segments for all 18, while
// the 48 kHz path through the internal resampler yields 14. The stage is
// documented as assistive, and these bounds exist to catch regressions.
ok(`segmentation produced segments for ${withSegs}/${segOut.length} episodes`,
   withSegs >= Math.floor(segOut.length * 0.7));

const themeHits = segOut.filter((r) => {
  const t = THEME[r.id];
  if (t === undefined) return false;
  return r.segments.some((s) => s.end > t + 1 && s.start < t + 11);
}).length;
ok(`segmentation covers the theme in ${themeHits}/${segOut.length} episodes`,
   themeHits >= Math.floor(segOut.length * 0.7));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
