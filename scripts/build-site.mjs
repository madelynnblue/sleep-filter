#!/usr/bin/env node
/**
 * Assemble the publishable site into `_site/`.
 *
 * GitHub Pages serves whatever `upload-pages-artifact` is handed at the site
 * root: `deploy-pages` takes no path or prefix input. (Branch deploys *do* remap
 * a source folder to the root, but the only folders on offer are `/` and
 * `/docs`.) So the page has to *be* the artifact root — which is why the page
 * files live at the repo root rather than in a subdirectory.
 *
 * That placement is also what lets this stay a straight copy. `pipeline.mjs`
 * imports `./src/index.mjs` and `./audio-decode/src/index.mjs`, and those
 * resolve identically in the repo and in `_site/` only if the page sits one
 * level above both trees. Nothing is rewritten, so every published file is
 * byte-identical to the source file, and serving the repo root exercises exactly
 * what ships.
 *
 * `verifySite()` walks the result afterwards and refuses to publish a module
 * graph that would 404: every relative specifier has to resolve to a file that
 * is actually inside `_site/`.
 *
 *   node scripts/build-site.mjs [outDir]
 */

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, '_site'));

/**
 * The page, named explicitly. An allowlist rather than "whatever is at the root
 * that is not a directory", so a stray file in the repo cannot silently become
 * public — and so renaming one of these fails the build here rather than as a
 * 404 in someone's browser.
 */
const PAGE_FILES = [
  'index.html',
  'main.js',
  'pipeline.mjs',
  'worker.mjs',
  'style.css',
  'favicon.svg',
  'favicon-32.png',
  'apple-touch-icon.png',
];

/**
 * Specifiers that are allowed to point at nothing.
 *
 * `audio-decode`'s `loadFfmpeg()` reaches `ffmpeg.node.mjs` through a *dynamic*
 * import, which this verifier cannot tell apart from a static one — and it
 * returns before that line in a browser, so the file is the one deliberate hole
 * in the graph. Listing it here rather than teaching the verifier to ignore
 * dynamic imports keeps every other missing file a hard failure.
 */
const ABSENT_BY_DESIGN = new Set(['./ffmpeg.node.mjs']);

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

/** Every file under `dir`, as paths relative to it. */
async function walk(dir, prefix = '') {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(join(dir, entry.name), rel));
    else found.push(rel);
  }
  return found;
}

/**
 * The relative specifiers a browser will resolve when it loads this file.
 *
 * Deliberately a regex and not a parser: this is a post-condition, not a
 * compiler. It reads specifiers out of comments too, which is why the JSDoc
 * `import('./src/library.mjs')` in `pipeline.mjs` is checked as well.
 */
function specifiersIn(name, text) {
  const patterns = [];
  if (name.endsWith('.mjs') || name.endsWith('.js')) {
    // import '…' · import('…') · export … from '…'
    patterns.push(/\b(?:from|import)\s*\(?\s*(['"])([^'"]+)\1/g);
    // new Worker(new URL('./worker.mjs', import.meta.url))
    patterns.push(/\bnew\s+URL\s*\(\s*(['"])([^'"]+)\1/g);
  } else if (name.endsWith('.html')) {
    patterns.push(/\b(?:src|href)\s*=\s*(['"])([^'"]+)\1/g);
  } else if (name.endsWith('.css')) {
    patterns.push(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g);
  }
  const found = [];
  for (const re of patterns) {
    // group 1 is the quote, group 2 the path
    for (const m of text.matchAll(re)) found.push(m[2]);
  }
  return found;
}

/**
 * Check that the tree can actually load itself.
 *
 * @returns {Promise<string[]>} one line per problem, empty when the site is sound
 */
async function verifySite(dir) {
  const problems = [];
  const inside = (from, spec) => {
    const target = resolve(dir, dirname(from), spec);
    return { target, rel: relative(dir, target) };
  };

  for (const file of await walk(dir)) {
    if (!/\.(mjs|js|html|css)$/.test(file)) continue;
    const text = await readFile(join(dir, file), 'utf8');
    for (const spec of specifiersIn(file, text)) {
      // a root-absolute path resolves against the domain, which is wrong for a
      // project page at /repo/ — nothing here should be using one
      if (spec.startsWith('/')) {
        problems.push(`${file}: ${spec} is root-absolute; it breaks a project page`);
        continue;
      }
      if (!spec.startsWith('.')) continue; // bare or a scheme: not ours to resolve
      if (ABSENT_BY_DESIGN.has(spec)) continue;
      const { target, rel } = inside(file, spec);
      if (rel.startsWith('..')) {
        problems.push(`${file}: ${spec} escapes the site root`);
        continue;
      }
      try {
        await stat(target);
      } catch {
        problems.push(`${file}: ${spec} → ${rel} is missing`);
      }
    }
  }
  return problems;
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const name of PAGE_FILES) {
  await cp(join(root, name), join(out, name));
}

const src = await copyModules(join(root, 'src'), join(out, 'src'));
const decode = await copyModules(join(root, 'audio-decode', 'src'), join(out, 'audio-decode', 'src'));

// Pages runs Jekyll unless told not to, and Jekyll drops files it does not
// understand
await writeFile(join(out, '.nojekyll'), '');

const problems = await verifySite(out);
if (problems.length) {
  console.error('assembled site would not load:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`assembled ${out}`);
console.log(`  page              ${PAGE_FILES.length} files`);
console.log(`  src               ${src.length} modules`);
console.log(`  audio-decode/src  ${decode.length} modules`);
