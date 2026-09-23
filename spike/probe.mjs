#!/usr/bin/env node
/**
 * Diagnostic: for given pairs of episodes, is the theme's delta bin a strong
 * peak? Ground truth theme starts come from the independent chroma method.
 *
 *   node probe.mjs S01E01 S02E02
 *   node probe.mjs --all S01E01          # S01E01 against every other episode
 */
import { spawnSync } from 'node:child_process';
import { fingerprint } from './discovery.mjs';

const SR = 8000;
const TRUTH = {
  S01E01: 150.72, S01E02: 101.88, S01E03: 249.98, S01E04: 189.05, S01E05: 187.71,
  S01E06: 136.32, S01E07: 180.73, S02E01: 214.08, S02E02: 126.52, S02E03: 231.61,
  S02E04: 105.28, S02E05: 178.30, S02E06: 168.89, S02E07: 233.72, S02E08: 147.64,
  S02E09: 144.83, S02E10: 133.76, S02E11: 129.47, S02E12: 186.24,
};
const DIR = process.env.HOME + '/Downloads/andy-richter-audio';
const path = (id) => `${DIR}/Andy Richter Controls the Universe ${id}.m4a`;

function decode(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR),
    '-f', 's16le', '-'], { maxBuffer: 512 * 1024 * 1024 });
  const b = r.stdout, n = b.length >> 1, o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = b.readInt16LE(i * 2) / 32768;
  return o;
}

const fps = SR / 512;
const cache = new Map();
function fp(id) {
  if (!cache.has(id)) cache.set(id, fingerprint(decode(path(id)), { sampleRate: SR, nfft: 1024, hop: 512 }));
  return cache.get(id);
}

function probe(refId, otherId) {
  const fa = fp(refId), fb = fp(otherId);
  const bins = new Map();
  let shared = 0;
  for (const [h, tsA] of fa.hashTimes) {
    const tsB = fb.hashTimes.get(h);
    if (!tsB) continue;
    shared++;
    for (const ta of tsA.slice(0, 3)) {
      for (const tb of tsB.slice(0, 3)) {
        const d = ta - tb;
        let s = bins.get(d);
        if (!s) { s = new Set(); bins.set(d, s); }
        s.add(h);
      }
    }
  }
  const counts = [...bins.values()].map((s) => s.size);
  const nBins = Math.max(...bins.keys()) - Math.min(...bins.keys()) + 1;
  const total = counts.reduce((a, b) => a + b, 0);
  const mean = total / nBins;
  const thr = mean + 5 * Math.sqrt(mean);
  const ranked = [...bins.entries()].sort((a, b) => b[1].size - a[1].size);

  const target = Math.round((TRUTH[refId] - TRUTH[otherId]) * fps);
  let win = 0;
  for (let d = target - 2; d <= target + 2; d++) win = Math.max(win, bins.get(d)?.size ?? 0);
  const best = ranked[0][1].size;
  const rank = ranked.findIndex(([d]) => Math.abs(d - target) <= 2) + 1;

  console.log(
    `  ${otherId}  shared ${String(shared).padStart(6)}  ` +
    `TRUTH bin ${String(win).padStart(5)}  top ${String(best).padStart(5)}  ` +
    `thr ${thr.toFixed(0).padStart(4)}  ratio ${(win / best).toFixed(3).padStart(6)}  ` +
    `${win >= thr && win / best > 0.5 ? 'FOUND' : (win >= thr ? 'weak' : 'MISSED')}`
  );
  return win / best;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (process.argv.includes('--all')) {
  const refId = args[0] || 'S01E01';
  console.log(`reference ${refId} vs each other episode (full length, nfft=1024):`);
  const ratios = [];
  for (const id of Object.keys(TRUTH)) {
    if (id === refId) continue;
    ratios.push(probe(refId, id));
  }
  ratios.sort((a, b) => b - a);
  console.log(`\n  ratio stats: max ${ratios[0].toFixed(3)}  median ${ratios[ratios.length >> 1].toFixed(3)}  min ${ratios[ratios.length - 1].toFixed(3)}`);
} else {
  const [a, b] = args;
  console.log(`pair ${a} (ref) vs ${b}:`);
  probe(a, b);
}
