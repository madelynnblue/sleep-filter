# music-analysis

Find and measure music in audio, entirely client-side. No server, no WASM, no
dependencies.

**Input is raw audio — `Float32Array` — never an encoded file.** Decoding lives
in a separate package. This one has no idea what a container or a codec is,
which is what lets it run unchanged in Node, a Web Worker, or a page.

Two things it does:

1. **Discovery** — find audio that *repeats* across episodes (the title theme,
   recurring stings). Confidence comes from cross-episode consensus.
2. **Segmentation** — find music in a *single* episode without needing it to
   repeat (credits, one-off interludes, diegetic songs). No corroboration, so
   lower confidence by construction.

## The boundary

```
@you/audio-decode          encoded bytes / File  ->  AudioChunk stream
        │                  (containers, codecs; WebCodecs + demuxer, ffmpeg.wasm fallback)
        ▼  AudioChunk
music-analysis             AudioChunk  ->  features, assets, segments
                           (pure; no I/O, no DOM, no Node)
```

Downmix and resampling live **here**, not in the decoder: the decoder stays a
dumb container/codec layer, and WebCodecs cannot resample anyway.

## Input contract

Mirrors `WebCodecs.AudioData`, so a decoder hands chunks over with almost no
transformation:

```ts
interface AudioChunk {
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  format: 'f32-planar' | 'f32';        // planar is the fast path
  data: Float32Array[] | Float32Array; // data[c] for planar
  timestamp?: number;                  // microseconds, from the source
}
```

`Float32Array` rather than `Int16Array` because WebCodecs, Web Audio and WASM all
speak f32. **Chunks rather than one buffer** because a 22-minute stereo file at
48 kHz is ~500 MB of float32, and that must never be materialised.

`preferredInput` advertises what the analysis would like, so an optimising
decoder can skip work — but any sample rate and channel count is accepted:

```js
import { preferredInput } from 'music-analysis';
// { sampleRate: 8000, channels: 1, format: 'f32-planar' }
```

## Usage

```js
import { EpisodeAnalyzer, Library } from 'music-analysis';

// phase 1 — one episode at a time, parallelisable across workers
const a = new EpisodeAnalyzer({ id: 'S01E01' });
for await (const chunk of decode(file)) a.addChunk(chunk);   // your decoder
const ep = a.finish();          // { id, duration, chroma, fingerprints, features }

// phase 2 — cheap, in-memory, cross-episode
const lib = new Library().add(ep);
const { candidates } = lib.discover();        // recurring assets, ranked
const assets = lib.refine(candidates);        // precise per-episode cut points
const music  = lib.segment(assets[0]);        // [{ id, segments: [{start,end,...}] }]
```

Already-decoded data:

```js
const a = EpisodeAnalyzer.fromSamples({ id: 'x', data: mono, sampleRate: 8000 });
const ep = a.finish();
```

Single episode, no library (pass known music regions to calibrate on):

```js
import { segmentEpisode } from 'music-analysis';
const { segments } = segmentEpisode(ep, [[150.7, 163.4]]);
```

### Why two phases

Phase 1 is heavy and embarrassingly parallel — one worker per file. Phase 2 needs
every episode's features at once and is fast (seconds for 19 episodes), so it
runs on the main thread without blocking. That split makes the app feel instant.

### Memory

PCM is reduced to mono at the analysis rate as it arrives, so the 500 MB a
22-minute stereo file would occupy at 48 kHz never materialises. The reduced
mono (~42 MB for 22 minutes at 8 kHz) is retained for the feature pass; retained
**features** — the thing you cache and share — are ~1 MB per episode.

A fully incremental feature pass (STFT on the fly, buffering only chroma) would
cut peak to a few MB. It is deliberately not done yet: it means rewriting three
validated code paths, and this interface would not change if it were.

### Caching

Everything returned is plain data — `Float32Array`, `Map`, arrays, numbers — all
structured-cloneable, so results go to/from a worker or straight into IndexedDB
with no conversion step. Caching features makes re-running discovery with
different thresholds, or re-seeding, essentially free.

## Browser notes

- **Pure ESM, zero dependencies, no Node built-ins, no DOM.** Runs in a page, a
  worker, or Node identically — and has been driven end to end from a browser via
  `app/`, including WebCodecs decode and the module worker.
- Run phase 1 in a **Web Worker** so the UI never blocks; the API is
  worker-agnostic.
- **Transfer, don't copy** — `postMessage(chunk, [chunk.data.buffer])`.
- No WASM. This is scalar float DSP over typed arrays and the JIT handles it:
  19 × 22-minute episodes analyse in ~120 s including decode. If profiling ever
  demands it, a WASM backend drops in behind the same pure-function interface.

## API

| export | purpose |
|---|---|
| `EpisodeAnalyzer` | streaming chunk → features (phase 1) |
| `Library` | discover / refine / segment across episodes (phase 2) |
| `segmentEpisode` | per-episode segmentation without a library |
| `MonoResampler`, `describeChunk`, `downmixInto`, `toMonoAt` | raw-audio ingestion |
| `computeChroma`, `profile`, `smooth` | chroma features |
| `fingerprint`, `discover` | landmark hashing and offset consensus |
| `computeFeatures`, `calibrate`, `scoreFrames`, `segment` | music segmentation |
| `refineAsset` | chroma refinement to precise cut points |
| `fft` / `makeFFT` / `fftInPlace`, `dsp.*` | shared DSP primitives |

## Testing

```bash
npm test                 # unit (hermetic) + integration (real audio, skips if absent)
npm run test:unit        # equivalence vs the reference implementation
npm run test:integration # end-to-end on a real corpus
```

`test/regression.mjs` is hermetic and asserts the refactored modules produce the
same output as the original spike implementation (bit-identical for chroma and
fingerprints; within float32 epsilon for features, where the shared FFT
precomputes twiddles the spike computed inline).

`test/integration.mjs` needs a corpus of `.m4a` episodes and `ffmpeg`; it skips
cleanly otherwise. It asserts the numbers established during development:
theme discovered with ≥80% support, per-episode positions within 1.5 s of
independent ground truth, and the known-atypical episode not silently placed.

## Known limitations

- **Segmentation is marginal.** Calibration separation is ~1.4 pooled SD, so it
  runs near its decision boundary and marginal episodes flip between "theme
  only" and "nothing" on small decode differences. Treat it as assistive, not
  automatic. Detection of *music under dialogue* is out of scope by design — it
  is left in place.
- **Extents run ~1.4 s short** vs measured ground truth. The start is reliable;
  the tail is under-measured. Pad the end rather than trusting the raw span.
- **Refinement needs a full season.** The robust envelope wants ≥8 pairs (it
  falls back automatically below that), and small or truncated subsets can
  regress.
- **Thresholds are tuned on one show.** A second corpus would settle how much
  transfers.
- **No formal abstention** at the library level yet.

## Repo layout

```
music-analysis/     this package (repo root)
audio-decode/       encoded audio -> AudioChunk stream, lossless cutting
app/                the web page (not published)
spike/              original research code + CLIs
```

`app/index.html` is the whole front end. See `app/README.md` for what is
verified and what is not.

`audio-decode` is a sibling package rather than a subdirectory of `src/` because
it is independently publishable and has a different runtime profile (it uses
Node's `child_process` for its fallback; this package uses nothing platform
specific). If the repo grows a third package it is worth restructuring into
`packages/*` npm workspaces — not worth the churn at two.

## `spike/`

The original research code and CLIs that produced the validation numbers, kept as
the reference implementation and as the source of the ground truth used by the
integration test. `spike/README.md` documents nine failure modes found while
building this, with measurements — including several that were only visible
because of a control experiment.
