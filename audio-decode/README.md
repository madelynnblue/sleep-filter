# audio-decode

Encoded audio → `AudioChunk` stream. The other half of the boundary
[`music-analysis`](../README.md) deliberately does not cross.

WebCodecs decodes but **does not demux**, so this package supplies the missing
half: a pure-JS ISO-BMFF parser plus a decode driver with backpressure.

```js
import { openAudioFile } from 'audio-decode';

const { info, chunks, backend } = await openAudioFile(file);
console.log(info.codec, info.sampleRate, info.duration);

for await (const chunk of chunks()) analysis.addChunk(chunk);
```

`info` is available before you start streaming, so you can size buffers up front.

## Backends

| | when | what it covers |
|---|---|---|
| **`webcodecs`** | `AudioDecoder` exists and the container is MP4 | non-fragmented MP4/M4A/MOV. **No external binary, no WASM payload.** |
| **`ffmpeg`** | Node, or anything the built-in path refuses | every other container/codec: Matroska, Ogg, fragmented MP4, AC-3, … |

Selection is automatic. `opts.backend` forces one (`'webcodecs'` throws rather
than silently degrading if it cannot work); `opts.forceFfmpeg` skips the built-in
path.

The point of the built-in path is that the common case — an `.m4a`/`.mp4` with
AAC — needs no 30 MB ffmpeg.wasm download and no cross-origin-isolation headers.

## The output contract

Exactly what `music-analysis` consumes, mirroring `WebCodecs.AudioData`:

```ts
interface AudioChunk {
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  format: 'f32-planar' | 'f32';
  data: Float32Array[] | Float32Array;
  timestamp: number;            // microseconds
}
```

Output is at the **source's native rate** unless you request otherwise via
`opts.sampleRate`/`opts.channels` (honoured by the ffmpeg backend, which can
resample; the WebCodecs path cannot, and `music-analysis` resamples internally
anyway).

## What the demuxer parses

`moov` → `trak` → `mdia` → `minfb` → `stbl`, and from there `stsd` (codec +
`esds` → AudioSpecificConfig), `stts`, `stsc`, `stsz`, `stco`/`co64`. It emits
per-sample byte offsets and microsecond timestamps.

`esds` nesting is the subtle part: **ES_Descriptor contains
DecoderConfigDescriptor, which contains DecoderSpecificInfo**. Skipping to the
end of a descriptor's body after reading its header — the obvious way to write
the loop — skips the nested descriptors and yields no codec config at all. AAC
cannot be configured without its AudioSpecificConfig, so that bug is silent
until decode fails.

Fragmented MP4 (`mvex`/`moof`) is detected and reported rather than mangled.

## Testing

```bash
npm test                 # demuxer vs ffprobe + decode-path checks
npm run test:demux       # demuxer over every file in the corpus
```

`test/demux.mjs` validates the parser against **ffprobe as an independent
reference**: codec, sample rate, channels, duration, sample count, offset bounds,
timestamp monotonicity. Sample counts match exactly on the reference corpus
(63,671 vs 63,671).

`test/decode.mjs` checks backend selection, and that streamed output matches an
independent whole-file decode sample-for-sample (max diff 0.0).

Both skip cleanly when the corpus or ffmpeg is absent.

## Limitations

- **Non-fragmented MP4 only** for the built-in path; everything else falls back.
- **The whole file is read into memory** to demux, because `moov` can sit at
  either end. Fine for audio (tens of MB); a large video file would want
  range-based `moov` reading.
- **ffmpeg backend is Node-only.** A browser needing a container the built-in
  path cannot handle would need ffmpeg.wasm wired in as a third backend — the
  selection logic has a place for it, but it is not implemented.
- **Opus/FLAC/ALAC in MP4** are detected and reported, but only AAC has been
  validated end-to-end.
