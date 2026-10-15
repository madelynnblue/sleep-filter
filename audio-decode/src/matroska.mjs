/**
 * Matroska / WebM (EBML) demuxing and decoding.
 *
 * EBML is the one container family this package does not parse by hand. It is a
 * far bigger job than the ISO-BMFF parser in `mp4.mjs` — variable-length
 * integers, a nested element tree, block lacing, and per-codec `CodecPrivate`,
 * plus the codec delay and seek pre-roll that a naive parser gets subtly wrong
 * on Opus. mediabunny does all of it and hands back decoded samples, so that is
 * what runs here: vendored rather than installed, because the page is plain ES
 * modules with no bundler (see `../vendor/mediabunny/README.md`).
 *
 * The bundle is 692 KB (177 KB gzipped), so it is imported on first use — an
 * MP4/FLAC/MP3/WAV run never fetches it.
 *
 * Decoding itself is still WebCodecs: mediabunny demuxes and drives the
 * decoder, exactly like `webcodecs.mjs` does for MP4. The exception is PCM,
 * for which mediabunny ships its own decoder and therefore needs no WebCodecs
 * at all — which is what lets `test/matroska.mjs` run under Node.
 *
 * AAC needs one extra step, and it is not a demuxing problem. See `rescueConfig`.
 */

import { decodeWithWebCodecs } from './webcodecs.mjs';

/** Self-contained ESM bundle, vendored verbatim. */
const BUNDLE = '../vendor/mediabunny/mediabunny.min.mjs';

/** Codecs mediabunny decodes itself, with no WebCodecs decoder behind them. */
const NATIVE_PCM = /^pcm-|^(ulaw|alaw)$/;

let bundlePromise = null;

/** The bundle is imported once per session, not once per file. */
function loadBundle() {
  bundlePromise ??= import(BUNDLE);
  return bundlePromise;
}

/**
 * Open an EBML source and describe its audio track, without decoding anything.
 *
 * @param {Blob|ArrayBufferView} source  the file itself, passed to the demuxer
 *        as a Blob so it can read ranges instead of being copied into memory
 * @param {{fromSeconds?: number, toSeconds?: number}} [opts]  range for chunks()
 * @returns {Promise<{container, codec, sampleRate, channels, duration, decodable,
 *                    rescued, diagnosis, chunks}>}
 *          `decodable` is false when this environment cannot decode the track's
 *          codec; `codec` and `diagnosis` are then what the caller should name in
 *          its error. `rescued` is set when the decode only works via a restated
 *          decoder config (see `rescueConfig`).
 */
export async function openMatroska(source, opts = {}) {
  const { Input, BlobSource, MATROSKA, WEBM } = await loadBundle();
  const blob = source instanceof Blob ? source : new Blob([source]);

  let input, track;
  try {
    input = new Input({ source: new BlobSource(blob), formats: [MATROSKA, WEBM] });
    track = await input.getPrimaryAudioTrack();
  } catch (e) {
    throw new Error(`cannot read this file as Matroska/WebM: ${e.message}`);
  }
  if (!track) throw new Error('this file has no audio track');

  const codec = track.codec;
  // canDecode() answers for the real configuration, and knows about native PCM:
  // it is true under Node for a PCM file, where AudioDecoder does not exist.
  const decodable = !!codec && await track.canDecode().catch(() => false);

  // When it says no, do not take that as final: for AAC it is usually rejecting
  // the *config*, not the audio. Same verdict goes into the diagnosis either way.
  let config = null;
  let rescue = null;
  if (!decodable && codec) {
    config = await track.getDecoderConfig().catch(() => null);
    rescue = config ? await rescueConfig(config) : null;
  }
  const usable = decodable || !!rescue;

  return {
    container: (await input.getFormat()).name.toLowerCase(),
    codec,
    sampleRate: track.sampleRate,
    channels: track.numberOfChannels,
    duration: await track.computeDuration(),
    decodable: usable,
    rescued: rescue?.why ?? null,
    diagnosis: usable ? null : await diagnose(config),
    chunks: () => (rescue
      ? decodeRescued(track, rescue.config, codec, opts)
      : decodeSamples(track, opts)),
  };
}

/**
 * Decoded samples -> the AudioChunk contract (planar f32, microseconds).
 *
 * @param {object} track  an InputAudioTrack, already known to be decodable
 * @param {{fromSeconds?: number, toSeconds?: number, signal?: AbortSignal}} [opts]
 *        a range decodes only the samples covering it, which is what the play
 *        buttons use; note that a range starts at the sample CONTAINING
 *        `fromSeconds`, so the first chunk can reach back up to one packet
 *        (~21 ms), the same slop the MP4 path has.
 */
async function* decodeSamples(track, opts = {}) {
  const { AudioSampleSink } = await loadBundle();
  const { fromSeconds, toSeconds, signal } = opts;
  const samples = new AudioSampleSink(track).samples(fromSeconds, toSeconds);
  try {
    for await (const sample of samples) {
      if (signal?.aborted) break;
      try {
        const frames = sample.numberOfFrames;
        const channels = sample.numberOfChannels;
        const planes = new Array(channels);
        for (let c = 0; c < channels; c++) {
          const plane = new Float32Array(frames);
          // planar f32: planeIndex selects the channel
          sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          planes[c] = plane;
        }
        yield {
          sampleRate: sample.sampleRate,
          numberOfFrames: frames,
          numberOfChannels: channels,
          format: 'f32-planar',
          data: planes,
          timestamp: sample.microsecondTimestamp,
        };
      } finally {
        sample.close();
      }
    }
  } finally {
    // Breaking out (an auditioned clip, an abort) leaves the decoder open
    // otherwise, and the iterator is the only handle on it.
    await samples.return?.();
  }
}

/* ------------------------------------------------------- AAC config rescue -- */

/**
 * Restate an AAC decoder config that this browser's WebCodecs refuses.
 *
 * For Matroska, mediabunny derives the codec string from the `AudioSpecificConfig`
 * in `CodecPrivate`: object type 5 (SBR) becomes `mp4a.40.5`, 29 (PS) becomes
 * `mp4a.40.29`. Chromium's WebCodecs validation rejects those profile strings —
 * and rejects AAC with no `description` at all — while the AAC decoder underneath
 * handles SBR/PS perfectly well. Both are packaging problems rather than decoding
 * ones, so the same bitstream often decodes once the config is restated:
 *
 *   - keep the real `description`, call it `mp4a.40.2` (the SBR/PS signalling
 *     lives in the AudioSpecificConfig, where the decoder will find it);
 *   - when there is no `description` at all, synthesise the AAC-LC one from the
 *     sample rate and channel count, which is all a two-byte header needs.
 *
 * Nothing here is guessed at: every candidate goes to
 * `AudioDecoder.isConfigSupported()` and the first accepted one wins. When none
 * is, the caller reports `diagnose()` instead, so the message says what was
 * refused rather than that "aac" is unsupported.
 *
 * @returns {Promise<{why: string, config: object}|null>}
 */
async function rescueConfig(config) {
  // Node, or a browser without WebCodecs: no decoder to ask, nothing to rescue.
  if (typeof globalThis.AudioDecoder !== 'function') return null;
  if (!config?.codec?.startsWith('mp4a.40')) return null;

  const candidates = [{
    why: 'AAC-LC profile (SBR/PS left to the AudioSpecificConfig)',
    config: { ...config, codec: 'mp4a.40.2' },
  }];
  if (!config.description?.byteLength) {
    const asc = buildAacSpecificConfig(config.sampleRate, config.numberOfChannels);
    if (asc) {
      candidates.push({
        why: 'AAC-LC profile with a synthesised AudioSpecificConfig',
        config: { ...config, codec: 'mp4a.40.2', description: asc },
      });
    }
  }

  for (const candidate of candidates) {
    try {
      const support = await globalThis.AudioDecoder.isConfigSupported(candidate.config);
      if (support?.supported) return candidate;
    } catch {
      // A malformed candidate is not a reason to stop: try the next.
    }
  }
  return null;
}

/**
 * The two-byte AAC-LC `AudioSpecificConfig` for a rate and channel count.
 *
 * 5 bits of audio object type (2 = AAC-LC), 4 bits of sampling frequency index,
 * 4 bits of channel configuration, then an empty GASpecificConfig. 48 kHz
 * stereo is the familiar `11 90`, 44.1 kHz stereo `12 10`.
 *
 * @returns {Uint8Array|null} null when the pair has no index to encode
 */
export function buildAacSpecificConfig(sampleRate, channels) {
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000, 7350];
  const index = RATES.indexOf(sampleRate);
  if (index < 0 || !(channels >= 1 && channels <= 7)) return null;
  const bits = (2 << 11) | (index << 7) | (channels << 3);
  return new Uint8Array([bits >> 8, bits & 0xff]);
}

/**
 * The audio object type at the head of an `AudioSpecificConfig`.
 *
 * 5-bit field: 2 is AAC-LC, 5 is SBR (HE-AAC v1), 29 is PS (HE-AAC v2). 31 is
 * the escape value for extended types, which nothing here produces.
 */
export function ascObjectType(bytes) {
  if (!bytes?.length) return null;
  const type = bytes[0] >> 3;
  return type === 31 ? null : type;
}

/** Why a track could not be decoded, as facts rather than a shrug. */
async function diagnose(config) {
  if (!config) return 'the file gave no decoder configuration for this track';
  const facts = [
    `config ${config.codec}, ${config.numberOfChannels} ch, ${config.sampleRate} Hz`,
    `description ${config.description?.byteLength ?? 0} bytes`,
  ];
  const type = ascObjectType(config.description);
  if (type !== null) facts.push(`AudioSpecificConfig object type ${type}`);
  if (typeof globalThis.AudioDecoder !== 'function') {
    // Which realm matters: the page can have it while a worker does not, and
    // that is a browser-version problem rather than a file or codec one.
    const realm = typeof window === 'undefined' ? 'worker' : 'page';
    facts.push(`no WebCodecs AudioDecoder in this ${realm}`);
    return facts.join('; ');
  }
  try {
    const support = await globalThis.AudioDecoder.isConfigSupported(config);
    facts.push(`isConfigSupported ${support?.supported}`);
  } catch (e) {
    facts.push(`isConfigSupported threw: ${e.message}`);
  }
  return facts.join('; ');
}

/**
 * Decode packets ourselves, with a restated config, through the same WebCodecs
 * driver the MP4 path uses.
 *
 * The difference from `decodeSamples` is who drives the decoder: mediabunny's
 * sink refuses a config its own `canDecode()` rejected, so here the packets come
 * from `EncodedPacketSink` and the decode is `webcodecs.mjs`'s. That means the
 * packets have to be laid out in memory with byte offsets first — a copy of the
 * selected audio only (tens of MB for a feature-length track, and nothing at all
 * for the range-decoded clips), which is why this path exists only as a rescue.
 */
async function* decodeRescued(track, config, codec, opts = {}) {
  const { EncodedPacketSink } = await loadBundle();
  const { fromSeconds, toSeconds, signal } = opts;
  const sink = new EncodedPacketSink(track);

  let first = null, after = null;
  if (fromSeconds !== undefined) {
    first = await sink.getPacket(fromSeconds) ?? await sink.getFirstPacket();
  }
  if (toSeconds !== undefined) after = await sink.getPacket(toSeconds, { metadataOnly: true });

  const packets = [];
  for await (const packet of sink.packets(first ?? undefined, after ?? undefined)) packets.push(packet);
  if (!packets.length) throw new Error('no audio packets in the requested range');

  let total = 0;
  for (const packet of packets) total += packet.data.byteLength;
  const bytes = new Uint8Array(total);
  const samples = new Array(packets.length);
  let offset = 0;
  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i];
    bytes.set(packet.data, offset);
    samples[i] = {
      offset,
      size: packet.data.byteLength,
      timestampUs: packet.microsecondTimestamp,
      durationUs: packet.microsecondDuration,
    };
    offset += packet.data.byteLength;
  }

  const demuxed = {
    track: {
      codec: config.codec,
      sampleRate: config.sampleRate,
      channels: config.numberOfChannels,
      description: config.description,
      timescale: 1e6,
    },
    samples,   // already the requested range, so no second selection happens
  };
  try {
    yield* decodeWithWebCodecs(bytes, demuxed, { signal });
  } catch (e) {
    // isConfigSupported() accepted it and the decoder still refused the stream.
    // Say so, or the failure reads like any other decode error with no hint that
    // a restated config was in play.
    throw new Error(`decoding the "${codec}" track with a restated config (${config.codec}) failed: ${e.message}`);
  }
}

/** True for codecs whose decoding needs no WebCodecs decoder. */
export function isNativePcm(codec) {
  return !!codec && NATIVE_PCM.test(codec);
}
