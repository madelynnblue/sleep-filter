/**
 * ffmpeg fallback decoder (Node).
 *
 * Exists so the package is testable and usable outside a browser: Node has no
 * WebCodecs, and the built-in demuxer covers only non-fragmented MP4. This path
 * also handles the containers and codecs the built-in one deliberately refuses
 * (Matroska, Ogg, fragmented MP4, AC-3, ...).
 *
 * Node-only: imported dynamically, so a browser bundle never pulls in
 * `node:child_process`.
 */

import { spawn, spawnSync } from 'node:child_process';

/** Probe with ffprobe for the container/codec facts the caller may want. */
export function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels,duration',
    '-show_entries', 'format=duration,format_name',
    '-of', 'json', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const s = j.streams?.[0] ?? {};
    return {
      codec: s.codec_name ?? null,
      sampleRate: Number(s.sample_rate) || 0,
      channels: Number(s.channels) || 0,
      duration: Number(s.duration ?? j.format?.duration) || 0,
      format: j.format?.format_name ?? null,
    };
  } catch { return null; }
}

/**
 * Decode a file to interleaved f32 chunks.
 * @param {string} file  path on disk
 * @param {{sampleRate?, channels?, framesPerChunk?, fromSeconds?, toSeconds?, signal?}} [opts]
 */
export async function* decodeWithFfmpeg(file, opts = {}) {
  const {
    sampleRate = 48000,
    channels = 2,
    framesPerChunk = 48000,     // ~1 s
    fromSeconds,
    toSeconds,
  } = opts;

  const args = ['-v', 'error'];
  // input seeking: fast, and accurate enough for auditioning a clip
  if (fromSeconds !== undefined) args.push('-ss', String(fromSeconds));
  args.push('-i', file);
  if (toSeconds !== undefined) {
    const start = fromSeconds ?? 0;
    args.push('-t', String(Math.max(0, toSeconds - start)));
  }
  args.push('-vn', '-f', 'f32le', '-ac', String(channels), '-ar', String(sampleRate), '-');
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString().slice(0, 4096); });

  const bytesPerFrame = 4 * channels;
  const chunkBytes = framesPerChunk * bytesPerFrame;

  let carry = Buffer.alloc(0);
  let timestamp = 0;   // microseconds

  const parts = [];
  let ended = false;
  let wake = null;
  let exitError = null;
  const notify = () => { if (wake) { const w = wake; wake = null; w(); } };

  proc.stdout.on('data', (d) => { parts.push(d); notify(); });
  proc.on('error', (e) => { exitError = e; ended = true; notify(); });
  proc.on('close', (code) => {
    if (code !== 0 && !exitError) exitError = new Error(`ffmpeg exited ${code}: ${stderr.trim()}`);
    ended = true; notify();
  });

  const take = () => {
    const buf = Buffer.concat(parts.splice(0, parts.length));
    carry = carry.length ? Buffer.concat([carry, buf]) : buf;
  };

  try {
    // Termination must account for a PARTIAL tail: requiring
    // `carry.length >= chunkBytes` to keep looping exits without flushing the
    // final frames, silently truncating the stream by up to one chunk.
    while (!ended || parts.length || carry.length) {
      if (!ended && parts.length === 0 && carry.length < chunkBytes) {
        await new Promise((r) => { wake = r; });
        continue;
      }
      take();
      while (carry.length >= chunkBytes) {
        const slice = carry.subarray(0, chunkBytes);
        carry = carry.subarray(chunkBytes);
        // copy: subarray shares the parent buffer, which the consumer may retain
        const data = new Float32Array(slice.byteLength / 4);
        for (let i = 0; i < data.length; i++) data[i] = slice.readFloatLE(i * 4);
        yield {
          sampleRate, numberOfFrames: framesPerChunk, numberOfChannels: channels,
          format: 'f32', data, timestamp,
        };
        timestamp += Math.round((framesPerChunk / sampleRate) * 1e6);
      }
      if (ended && parts.length === 0) {
        const bytes = carry.length - (carry.length % bytesPerFrame);   // whole frames only
        if (bytes > 0) {
          const slice = carry.subarray(0, bytes);
          carry = carry.subarray(bytes);
          const frames = bytes / bytesPerFrame;
          const data = new Float32Array(slice.byteLength / 4);
          for (let i = 0; i < data.length; i++) data[i] = slice.readFloatLE(i * 4);
          yield {
            sampleRate, numberOfFrames: frames, numberOfChannels: channels,
            format: 'f32', data, timestamp,
          };
          timestamp += Math.round((frames / sampleRate) * 1e6);
        }
        break;
      }
    }
    if (exitError) throw exitError;
  } finally {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
}
