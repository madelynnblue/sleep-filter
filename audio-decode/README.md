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
| **`webcodecs`** | `AudioDecoder` exists and the container is MP4, FLAC, MP3, WAV/AIFF, Matroska or WebM | non-fragmented MP4/M4A/MOV, native FLAC, MPEG audio, PCM, and EBML. **No external binary, no install.** |
| **`ffmpeg`** | Node, or anything the built-in path refuses | every other container/codec: Ogg, AVI, fragmented MP4, AC-3, … |

Selection is automatic. `opts.backend` forces one (`'webcodecs'` throws rather
than silently degrading if it cannot work); `opts.forceFfmpeg` skips the built-in
path.

The point of the built-in path is that the common case — an `.m4a`/`.mp4` with
AAC — needs no 30 MB ffmpeg.wasm download and no cross-origin-isolation headers.

## Matroska / WebM

EBML is the one container family not parsed here by hand. Variable-length
integers, a nested element tree, block lacing and per-codec `CodecPrivate`, plus
the codec delay and seek pre-roll that a naive parser gets subtly wrong on Opus,
add up to a much larger job than the ISO-BMFF parser. So
[`mediabunny`](https://mediabunny.dev) does it: one self-contained ESM file
vendored under `vendor/mediabunny/` (692 KB, 177 KB gzipped, MPL-2.0 — see the
README there), imported **lazily** on the first EBML file, so an MP4 run never
fetches it.

Decoding is still WebCodecs, exactly as in `webcodecs.mjs`; the one exception is
PCM, which the bundle decodes itself and which therefore also works under Node
(that is what makes `test/matroska.mjs` hermetic). A native PCM path reports
`backend: 'pcm'`; everything else reports `'webcodecs'`.

### AAC, and why `canDecode()` is not the last word

Matroska stores AAC's `AudioSpecificConfig` in `CodecPrivate`, and the codec
string is derived from it: object type 2 gives `mp4a.40.2`, but 5 (SBR) gives
`mp4a.40.5` and 29 (PS) gives `mp4a.40.29`. Chromium's WebCodecs validation
rejects those two profile strings — and rejects AAC with no `description` at all
— even though its AAC decoder handles SBR and PS. `canDecode()` therefore says
no for a track that would decode perfectly well.

So a refusal is treated as the start of a question, not the end of one. The
config is restated (keep the real `description`, call it `mp4a.40.2`; or
synthesise the two-byte AAC-LC header from the sample rate and channel count when
`CodecPrivate` is missing) and each candidate is put to
`AudioDecoder.isConfigSupported()`. The first accepted one wins, and its packets
are then driven through this package's own WebCodecs path — the same one MP4
uses — because mediabunny's sink declines a config its own check rejected.

Nothing is assumed: if no candidate is accepted, the error says what was refused
rather than blaming the codec:

```
cannot read this file: its matroska track holds "aac", which this browser cannot
decode, and this environment has no fallback decoder (the ffmpeg path is
Node-only). — config mp4a.40.29, 2 ch, 22050 Hz, description 5 bytes;
AudioSpecificConfig object type 29; isConfigSupported false
```

A track whose codec this environment cannot decode — AC-3 in Firefox, say — is
reported by name rather than as an unreadable container:

```
cannot read this file: its matroska track holds "ac-3", which this browser
cannot decode, and this environment has no fallback decoder (the ffmpeg path is
Node-only).
```

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

## Lossless cutting

Because the demuxer already parses the full sample table, removing music is just
*selecting samples by timestamp and re-muxing* — no decode, no re-encode, no
generation loss.

```js
import { cutAudio, rangesFromSegments } from 'audio-decode';

const { bytes, info } = cutAudio(sourceBytes, rangesFromSegments(segments), {
  mode: 'remove',        // 'remove' strips the ranges; 'keep' extracts only them
});
info.removedSeconds;     // 12.011  (asked for 12.000)
info.snapSeconds;        // 0.011   (frame-boundary snap)
info.outputSeconds;      // 1346.288
```

`bytes` is a new MP4 with the same codec, rate and channels. Granularity is one
AAC frame (1024 samples ≈ 21 ms at 48 kHz), and the real removed span is reported
so the snap is visible rather than silent.

The muxer is ~150 lines, and one decision keeps it that small: the source's
`stsd` (SampleDescription) is copied **verbatim**, so the decoder configuration
is preserved byte-for-byte rather than re-serialising `esds`.

### The edit list is not optional

AAC carries encoder priming, and the source MP4 declares how much to trim in an
`edts`/`elst` box (`media_time = 2048` on the reference corpus). Omitting it from
a re-muxed file means the decoder no longer trims, so the output decodes shifted
by the priming delay — measured with the original otherwise-identical audio
differing by up to **0.86** (near full scale). `cutAudio` re-emits it, and drops
it when the cut removed the original first sample (the new head carries no
encoder delay).

### Verified losslessness

`test/cut.mjs` does not stop at durations. It decodes the original and the cut
file and compares samples directly, at the **native** rate:

```
audio BEFORE the cut is bit-identical (max diff 0, 14,394,688 frames)
audio AFTER  the cut is bit-identical (max diff 0, 50,215,488 frames)
  windows at +5s, +30s, +120s, +600s past the splice: max diff 0
```

Only a ~0.1 s guard either side of the splice is excluded, covering the AAC MDCT
overlap at the seam.

Comparing at a *resampled* rate instead produces differences around 0.2 that are
entirely an artefact of ffmpeg's resampler filter differing across the splice —
the codec-domain content is untouched. Worth knowing before trusting that
measurement.

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

- **Cutting covers MP4, FLAC and MP3.** MP4 and FLAC are genuinely lossless —
  whole frames are dropped and the rest re-muxed untouched. MP3 is frame-spliced,
  so the first frame after a cut can reference bit-reservoir bytes that are gone:
  a few milliseconds, and inherent to cutting MP3 without re-encoding.
  Fragmented MP4 is refused.
- **No `elst` precision beyond the initial trim.** Cutting mid-file keeps the
  priming trim; cutting the head drops it. Sub-frame edit lists are not modelled.
- **Non-fragmented MP4 only** for the built-in path; everything else falls back.
- **`udta` is copied verbatim, so a `chpl` chapter list would be wrong.** Tags
  survive a cut intact, but chapter timestamps describe the original timeline and
  are not remapped. No source seen so far carries chapters.
- **The whole file is read into memory** to demux, because `moov` can sit at
  either end. Fine for audio (tens of MB); a large video file would want
  range-based `moov` reading.
- **ffmpeg backend is Node-only.** A browser needing a container the built-in
  path cannot handle would need ffmpeg.wasm wired in as a third backend — the
  selection logic has a place for it, but it is not implemented.
- **Opus/FLAC/ALAC in MP4** are detected and reported, but only AAC has been
  validated end-to-end.
- **An MKV with several audio tracks** takes the primary one (mediabunny's
  `getPrimaryAudioTrack`); there is no track picker.
- **Matroska and WebM cannot be cut**, only read: the muxing half is not
  written. `cutAudio` refuses them by name instead of failing obscurely.
