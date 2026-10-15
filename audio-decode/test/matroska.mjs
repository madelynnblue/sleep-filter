#!/usr/bin/env node
/**
 * Matroska / WebM path (Node, hermetic).
 *
 * The fixture is *written by the vendored bundle itself* and then read back
 * through `openAudioFile`, so nothing binary is committed and the test needs
 * neither a corpus nor ffmpeg. It is also the only test that can run in CI for
 * this path, which is why the PCM case matters: mediabunny decodes PCM with a
 * built-in decoder, so the demuxer is genuinely exercised where WebCodecs does
 * not exist. A CodecID that Node *cannot* decode (Opus, AC-3) is reachable only
 * in a browser, and is not covered here.
 *
 *   node test/matroska.mjs
 */

import { openAudioFile, sniffContainer, isNativePcm } from '../src/index.mjs';
import { openMatroska, buildAacSpecificConfig, ascObjectType } from '../src/matroska.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

console.log('audio-decode: Matroska / WebM\n');

const { Output, BufferTarget, MkvOutputFormat, AudioSampleSource, AudioSample } =
  await import('../vendor/mediabunny/mediabunny.min.mjs');

const RATE = 48000, CHANNELS = 2, PER_SAMPLE = 4800, SAMPLES = 4;
const FRAMES = PER_SAMPLE * SAMPLES;               // 0.4 s

/** A two-channel fixture: a different tone per channel, so a plane mix-up shows. */
function tone(frames, rate, hz, amp) {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin(2 * Math.PI * hz * i / rate) * amp;
  return out;
}

const source = new Float32Array(FRAMES * CHANNELS);
for (let s = 0; s < SAMPLES; s++) {
  const left = tone(PER_SAMPLE, RATE, 440, 0.5);
  const right = tone(PER_SAMPLE, RATE, 220, 0.25);
  for (let i = 0; i < PER_SAMPLE; i++) {
    source[(s * PER_SAMPLE + i) * CHANNELS] = left[i];
    source[(s * PER_SAMPLE + i) * CHANNELS + 1] = right[i];
  }
}

/* ---------------------------------------------------------- fixture -- */

console.log('fixture (written by the vendored muxer):');
const mkv = await (async () => {
  const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
  const track = new AudioSampleSource({ codec: 'pcm-f32', numberOfChannels: CHANNELS, sampleRate: RATE });
  output.addAudioTrack(track);
  await output.start();
  for (let s = 0; s < SAMPLES; s++) {
    await track.add(new AudioSample({
      data: source.subarray(s * PER_SAMPLE * CHANNELS, (s + 1) * PER_SAMPLE * CHANNELS),
      format: 'f32', numberOfChannels: CHANNELS, sampleRate: RATE,
      timestamp: (s * PER_SAMPLE) / RATE,
    }));
  }
  await output.finalize();
  return new Uint8Array(output.target.buffer);
})();
ok(`wrote a ${mkv.byteLength} byte Matroska file`, mkv.byteLength > 1000);

/* ---------------------------------------------------------- sniffing -- */

console.log('\ncontainer sniffing:');
{
  ok('a real mkv is matroska, not webm', sniffContainer(mkv) === 'matroska', sniffContainer(mkv));

  // The EBML magic alone cannot tell the two apart — DocType lives at the end
  // of the header — and four bytes is all a truncated read would give.
  const magicOnly = mkv.subarray(0, 4);
  ok('magic bytes alone fall back to webm', sniffContainer(magicOnly) === 'webm');

  // Same header, DocType swapped, which is the only difference in the wild.
  const header = (docType) => {
    const dt = [...docType].map((c) => c.charCodeAt(0));
    const body = [0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x80 | dt.length, ...dt];
    return Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length, ...body]);
  };
  ok('DocType "webm" is webm', sniffContainer(header('webm')) === 'webm');
  ok('DocType "matroska" is matroska', sniffContainer(header('matroska')) === 'matroska');
}

/* ------------------------------------------------------------ open -- */

console.log('\nopenAudioFile:');
const file = typeof File === 'function' ? new File([mkv], 'episode.mkv') : mkv;
const opened = await openAudioFile(file);

ok('container reported as matroska', opened.container === 'matroska', opened.container);
ok('backend is pcm (native decoder, no WebCodecs needed)', opened.backend === 'pcm', opened.backend);
ok(`codec/rate/channels (${opened.info.codec} ${opened.info.sampleRate}Hz ${opened.info.channels}ch)`,
  opened.info.codec === 'pcm-f32' && opened.info.sampleRate === RATE && opened.info.channels === CHANNELS);
ok(`duration is ~${(FRAMES / RATE).toFixed(2)}s (${opened.info.duration.toFixed(3)}s)`,
  Math.abs(opened.info.duration - FRAMES / RATE) < 0.05, String(opened.info.duration));
ok('the source file name is carried through', !file.name || opened.info.name === 'episode.mkv', String(opened.info.name));

/* ---------------------------------------------------------- decode -- */

console.log('\ndecoded output:');
{
  const planes = [[], []];
  let chunks = 0, frames = 0, planarOk = true, timestampOk = true, monotonic = true, last = -1;
  for await (const c of opened.chunks()) {
    chunks++;
    frames += c.numberOfFrames;
    if (c.format !== 'f32-planar' || !Array.isArray(c.data) || c.data.length !== CHANNELS) planarOk = false;
    if (!Number.isInteger(c.timestamp)) timestampOk = false;
    if (c.timestamp < last) monotonic = false;
    last = c.timestamp;
    for (let ch = 0; ch < CHANNELS; ch++) planes[ch].push(c.data[ch]);
  }

  const joined = planes.map((parts) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  });

  ok(`streamed ${chunks} chunks, ${frames} frames`, chunks > 0 && frames === FRAMES, `${frames} of ${FRAMES}`);
  ok('chunks are planar f32, one plane per channel', planarOk);
  ok('timestamps are integer microseconds', timestampOk);
  ok('timestamps advance', monotonic);

  // PCM is lossless, so this is an equality check, not a tolerance.
  let maxDiff = 0;
  const interleaved = new Float32Array(FRAMES * CHANNELS);
  for (let i = 0; i < FRAMES; i++) {
    interleaved[i * CHANNELS] = joined[0][i];
    interleaved[i * CHANNELS + 1] = joined[1][i];
  }
  for (let i = 0; i < interleaved.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(interleaved[i] - source[i]));
  }
  // A swapped channel would still pass a "not silent" check, so compare planes
  // against their own channel and prove the swap would have been caught.
  let swappedDiff = 0;
  for (let i = 0; i < FRAMES; i++) swappedDiff = Math.max(swappedDiff, Math.abs(joined[0][i] - joined[1][i]));
  ok(`decoded samples are bit-identical to the input (max diff ${maxDiff})`, maxDiff === 0, String(maxDiff));
  ok(`the two channels are distinct, so a plane swap would fail (max diff ${swappedDiff.toFixed(3)})`,
    swappedDiff > 0.1);
}

/* ----------------------------------------------------- both ways in -- */

console.log('\nthe two ways in (a Blob is streamed, bytes are already in hand):');
{
  // The File above is peeked at and handed to the demuxer as-is; the same file
  // as a Uint8Array takes the other branch, after readSource has buffered it.
  const fromBytes = await openAudioFile(mkv);
  ok('opened from Uint8Array, container still matroska', fromBytes.container === 'matroska', fromBytes.container);
  ok('opened from Uint8Array, backend still pcm', fromBytes.backend === 'pcm', fromBytes.backend);
  let frames = 0;
  for await (const c of fromBytes.chunks()) frames += c.numberOfFrames;
  ok(`opened from Uint8Array decodes the same ${FRAMES} frames`, frames === FRAMES, String(frames));
}

/* ----------------------------------------------------------- range -- */

console.log('\nrange decoding (what the play buttons use):');
{
  const from = 0.1, to = 0.2;
  const ranged = await openAudioFile(file, { fromSeconds: from, toSeconds: to });
  let frames = 0;
  for await (const c of ranged.chunks()) frames += c.numberOfFrames;
  const span = frames / RATE;
  // The range starts at the sample CONTAINING `from`, so it can reach back by
  // up to one packet. Full file is 0.4s; this must be far short of it.
  ok(`range ${from}-${to}s decoded ${span.toFixed(3)}s, not the whole file`,
    span >= (to - from) - 1e-6 && span < 0.25, `${span}s`);
}

/* ------------------------------------------------------- AAC configs -- */

console.log('\nAAC decoder configs (what the rescue path restates):');
{
  const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
  ok(`48 kHz stereo AAC-LC is 1190 (${hex(buildAacSpecificConfig(48000, 2))})`,
    hex(buildAacSpecificConfig(48000, 2)) === '1190');
  ok(`44.1 kHz stereo AAC-LC is 1210 (${hex(buildAacSpecificConfig(44100, 2))})`,
    hex(buildAacSpecificConfig(44100, 2)) === '1210');
  ok(`44.1 kHz mono is 1208 (${hex(buildAacSpecificConfig(44100, 1))})`,
    hex(buildAacSpecificConfig(44100, 1)) === '1208');
  ok('an unindexable sample rate yields null', buildAacSpecificConfig(12345, 2) === null);
  ok('more channels than the 3-bit field yields null', buildAacSpecificConfig(48000, 8) === null);

  ok('object type 2 (AAC-LC) is read from the first 5 bits', ascObjectType(new Uint8Array([0x12, 0x10])) === 2);
  ok('object type 5 (SBR / HE-AAC v1) is read', ascObjectType(new Uint8Array([0x2b, 0x92])) === 5);
  ok('object type 29 (PS / HE-AAC v2) is read', ascObjectType(new Uint8Array([0xea, 0x90])) === 29);
  ok('31 is the escape value, not a type', ascObjectType(new Uint8Array([0xf8])) === null);
}

/* --------------------------------------- AAC in Matroska (CodecPrivate) -- */

console.log('\nAAC in Matroska (the profile suffix Chrome refuses):');

/**
 * A Matroska file with one AAC track whose CodecPrivate is `description`.
 *
 * The payload is junk on purpose: no decoder runs under Node, and what is under
 * test is the container's CodecPrivate and the decoder config derived from it.
 */
async function aacMkv(description, codecString, sampleRate, channels) {
  const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
  const stream = new EncodedAudioPacketSource('aac');
  output.addAudioTrack(stream);
  await output.start();
  const frame = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    await stream.add(new EncodedPacket(frame, 'key', i * 0.0213, 0.0213),
      i === 0 ? { decoderConfig: { codec: codecString, sampleRate, numberOfChannels: channels, description } } : undefined);
  }
  await output.finalize();
  return new Uint8Array(output.target.buffer);
}

const { EncodedAudioPacketSource, EncodedPacket } = await import('../vendor/mediabunny/mediabunny.min.mjs');

for (const [name, asc, expected] of [
  ['AAC-LC', new Uint8Array([0x12, 0x10]), 'mp4a.40.2'],
  ['HE-AAC v1 (SBR)', new Uint8Array([0x2b, 0x92]), 'mp4a.40.5'],
]) {
  let bytes;
  try {
    bytes = await aacMkv(asc, expected, 44100, 2);
  } catch (e) {
    console.log(`  SKIP  ${name}: the vendored muxer would not write it — ${e.message}`);
    continue;
  }

  // Node has no WebCodecs, so this is the "no decoder here" branch: the track is
  // still identified, and the diagnosis has to say what the config was.
  const opened = await openMatroska(bytes);
  ok(`${name}: track identified as aac`, opened.codec === 'aac', String(opened.codec));
  ok(`${name}: not decodable without WebCodecs`, opened.decodable === false);
  ok(`${name}: nothing was rescued (there is no decoder to ask)`, opened.rescued === null);
  ok(`${name}: diagnosis names ${expected}`, opened.diagnosis?.includes(expected), opened.diagnosis);
  ok(`${name}: diagnosis reports the AudioSpecificConfig object type`,
    /object type \d/.test(opened.diagnosis ?? ''), opened.diagnosis);
}

// Chromium accepts `mp4a.40.2` and refuses `mp4a.40.5`, which is the whole
// reason the rescue exists. A stub AudioDecoder reproduces exactly that verdict
// without a browser, so the candidate loop is exercised under Node.
{
  const HE_AAC = await aacMkv(new Uint8Array([0x2b, 0x92]), 'mp4a.40.5', 44100, 2).catch(() => null);
  if (!HE_AAC) {
    console.log('  SKIP  rescue path: no HE-AAC fixture');
  } else {
    const real = globalThis.AudioDecoder;
    globalThis.AudioDecoder = class {
      static async isConfigSupported(config) { return { supported: config.codec === 'mp4a.40.2' }; }
    };
    try {
      const opened = await openMatroska(HE_AAC);
      ok('a decoder that refuses mp4a.40.5 but takes mp4a.40.2 is rescued', opened.decodable === true);
      ok(`the rescue says what it restated (${opened.rescued})`,
        /AAC-LC profile/.test(opened.rescued ?? ''), String(opened.rescued));
      ok('nothing is reported as undecodable once rescued', opened.diagnosis === null);
    } finally {
      if (real === undefined) delete globalThis.AudioDecoder;
      else globalThis.AudioDecoder = real;
    }
  }
}

/* --------------------------------------------------------- helpers -- */

console.log('\nbackend classification:');
ok('pcm-f32 is native', isNativePcm('pcm-f32'));
ok('opus is not native (it needs WebCodecs)', !isNativePcm('opus'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
