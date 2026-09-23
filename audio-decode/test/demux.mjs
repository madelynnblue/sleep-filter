#!/usr/bin/env node
/**
 * Demuxer correctness, validated against ffprobe as an independent reference.
 *
 * WebCodecs cannot demux, so this parser is the load-bearing part of the
 * browser path — it must agree with a known-good demuxer on codec, rate,
 * channels, duration and sample count. ffprobe is that reference.
 *
 * SKIPS cleanly (exit 0) when the corpus or ffmpeg is unavailable.
 *
 *   node test/demux.mjs [corpusDir] [--all]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { demuxMp4, readTags } from '../src/mp4.mjs';
import { sniffContainer } from '../src/container.mjs';

const DIR = process.argv[2]?.startsWith('--') ? null : process.argv[2]
  || join(homedir(), 'Downloads', 'andy-richter-audio');
const ALL = process.argv.includes('--all');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

console.log('audio-decode: MP4 demuxer vs ffprobe\n');

if (!existsSync(DIR)) {
  console.log(`SKIP: corpus not found at ${DIR}`);
  process.exit(0);
}
if (spawnSync('ffprobe', ['-version']).status !== 0) {
  console.log('SKIP: ffprobe not on PATH');
  process.exit(0);
}

let files = readdirSync(DIR).filter((f) => extname(f).toLowerCase() === '.m4a').sort();
if (!ALL) files = files.slice(0, 3);
if (!files.length) { console.log(`SKIP: no .m4a files in ${DIR}`); process.exit(0); }

const probe = (file, entries, extra = []) => JSON.parse(spawnSync('ffprobe',
  ['-v', 'error', '-select_streams', 'a:0', ...extra, '-show_entries', entries,
    '-of', 'json', join(DIR, file)], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout || '{}');

console.log(`checking ${files.length} file(s) in ${DIR}\n`);

for (const file of files) {
  console.log(`${file}`);
  const buf = new Uint8Array(readFileSync(join(DIR, file)));

  ok(`  sniffed as mp4`, sniffContainer(buf) === 'mp4', sniffContainer(buf));

  let d;
  try {
    d = demuxMp4(buf);
  } catch (e) {
    ok(`  demux succeeds`, false, e.message);
    continue;
  }
  ok(`  demux succeeds (${d.track.sampleCount} samples)`, d.track.sampleCount > 0);

  const st = probe(file, 'stream=codec_name,sample_rate,channels,duration')?.streams?.[0] ?? {};
  const pkt = probe(file, 'stream=nb_read_packets', ['-count_packets'])?.streams?.[0] ?? {};

  // codec: ffprobe says "aac"; ours is an RFC 6381 string like mp4a.40.2
  const codecName = (d.track.codec ?? '').split('.')[0];
  ok(`  codec matches (${d.track.codec} vs ${st.codec_name})`,
     codecName === 'mp4a' ? st.codec_name === 'aac' : codecName === st.codec_name,
     `${d.track.codec} vs ${st.codec_name}`);

  ok(`  sampleRate matches (${d.track.sampleRate} vs ${st.sample_rate})`,
     Number(d.track.sampleRate) === Number(st.sample_rate));

  ok(`  channels match (${d.track.channels} vs ${st.channels})`,
     Number(d.track.channels) === Number(st.channels));

  const durS = d.durationUs / 1e6, refDur = Number(st.duration);
  ok(`  duration matches (${durS.toFixed(3)}s vs ${refDur.toFixed(3)}s)`,
     Math.abs(durS - refDur) < 0.05, `diff ${(durS - refDur).toFixed(3)}s`);

  const nPkt = Number(pkt.nb_read_packets);
  ok(`  sample count matches (${d.track.sampleCount} vs ${nPkt})`,
     d.track.sampleCount === nPkt, `diff ${d.track.sampleCount - nPkt}`);

  // AAC cannot be configured without its AudioSpecificConfig, so an empty
  // description is a hard failure on the WebCodecs path.
  const isAac = codecName === 'mp4a';
  ok(`  AAC decoder description present (${d.track.description?.length ?? 0} bytes)`,
     !isAac || (d.track.description?.length ?? 0) > 0);

  // sample offsets must lie inside the file and not overlap the headers
  const inside = d.samples.every((s) => s.offset >= 0 && s.offset + s.size <= buf.length);
  ok(`  all sample offsets within the file`, inside);

  const monotonic = d.samples.every((s, i) => i === 0 || s.timestampUs >= d.samples[i - 1].timestampUs);
  ok(`  timestamps monotonic`, monotonic);

  const contiguous = d.samples.every((s) => s.durationUs > 0);
  ok(`  every sample has a positive duration`, contiguous);

  // the first sample should start at 0 (AAC priming aside)
  ok(`  first timestamp is 0`, d.samples[0].timestampUs === 0, String(d.samples[0].timestampUs));
  console.log('');
}

/* --------------------------------------------------------------- tags -- */

console.log('tags (udta/meta/ilst):');
{
  // The page shows a file's own title in the list, and the demuxer's udta copy
  // is what the cutter carries through — so the reader has to agree with the
  // atom ffprobe reports.
  const path = join(DIR, files[0]);
  const bytes = new Uint8Array(readFileSync(path));
  const tags = readTags(bytes);

  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=title',
    '-of', 'default=nw=1:nk=1', path], { encoding: 'utf8' });
  const expected = (probe.stdout ?? '').trim();

  ok(`  title parsed (${JSON.stringify(tags['©nam'])})`, typeof tags['©nam'] === 'string' && !!tags['©nam']);
  ok('  agrees with ffprobe', !expected || tags['©nam'] === expected, `ffprobe: ${JSON.stringify(expected)}`);
  ok('  binary atoms are skipped, not misread as text',
     !('trkn' in tags) && !('disk' in tags) && !('covr' in tags));
  ok('  no NUL padding leaks into values',
     Object.values(tags).every((v) => typeof v === 'string' && !v.includes('\u0000')));
  ok('  garbage yields no tags', Object.keys(readTags(new Uint8Array(32))).length === 0);
  console.log('');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
