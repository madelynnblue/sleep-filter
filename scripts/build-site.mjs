#!/usr/bin/env node
/**
 * Assemble the publishable site into `_site/`.
 *
 * The page is not self-contained: `app/pipeline.mjs` imports `../src/index.mjs`
 * and `../audio-decode/src/index.mjs`, so the published tree has to keep those
 * at the same relative depth. That is the whole reason this exists rather than
 * pointing Pages straight at `app/`.
 *
 * Everything is served relative to the page, so the site works at any base path
 * — a project page at /repo/, a user page at /, or a local file server — with no
 * configuration.
 *
 *   node scripts/build-site.mjs [outDir]
 */

import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, '_site');

/** Copy every `.mjs` from a directory, so nothing Node-only rides along. */
async function copyModules(from, to) {
  await mkdir(to, { recursive: true });
  const kept = [];
  for (const name of await readdir(from)) {
    if (!name.endsWith('.mjs')) continue;
    // the ffmpeg fallback is Node-only and is never imported in a browser:
    // loadFfmpeg() returns null before the dynamic import is reached
    if (name === 'ffmpeg.node.mjs') continue;
    await cp(join(from, name), join(to, name));
    kept.push(name);
  }
  return kept;
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// the page itself — markdown and tests are not part of it
await mkdir(join(out, 'app'), { recursive: true });
for (const name of await readdir(join(root, 'app'))) {
  if (name.endsWith('.md')) continue;
  await cp(join(root, 'app', name), join(out, 'app', name), { recursive: true });
}

const src = await copyModules(join(root, 'src'), join(out, 'src'));
const decode = await copyModules(join(root, 'audio-decode', 'src'), join(out, 'audio-decode', 'src'));

// a redirect, so the site root is not a directory listing
await writeFile(join(out, 'index.html'), `<!DOCTYPE html>
<meta charset="utf-8">
<title>sleep filter</title>
<link rel="canonical" href="./app/">
<meta http-equiv="refresh" content="0; url=./app/">
<p>Redirecting to <a href="./app/">the app</a>…</p>
`);

// Pages runs Jekyll unless told not to, and Jekyll drops files it does not
// understand
await writeFile(join(out, '.nojekyll'), '');

console.log(`assembled ${out}`);
console.log(`  app       ${(await readdir(join(out, 'app'))).length} entries`);
console.log(`  src       ${src.length} modules`);
console.log(`  audio-decode/src  ${decode.length} modules`);
