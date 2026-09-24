# sleep filter

Do you fall asleep to old TV shows?
Do their theme music and end credits wake you up?
Do you have to skip the musical episodes because they're distracting?

Sleep filter is a website that:

- identifies common audio elements among a group of files
- identifies music in files
- cuts the above from audio
- saves the results back to a directory

It works completely in your browser without any server backend.
Nothing is uploaded anywhere.
It's fast and pretty good.

Drop some audio or video files in to the box.

## How it works

```
file ─► demux ─► decode ─┬─► PHASE 1  per episode, in workers
                         │     chroma · landmarks · features
                         │
                         └─► PHASE 2  cross-episode, main thread
                               discovery ─► refine ─► segmentation ─► cut ─► mux
```

Two phases because phase 1 is heavy and embarrassingly parallel — one worker per
file — while phase 2 needs every episode at once and takes seconds. That split is
what lets the page show a moving progress bar instead of freezing.

### 1. Reading the file

Everything is normalised to **8 kHz mono** as it streams in. That is the analysis
rate: chroma lives below 2 kHz, the speech cue below 4 kHz, and 8 kHz keeps a
22-minute episode at ~42 MB instead of the ~500 MB it would occupy as 48 kHz
stereo float. Downmixing and resampling happen here rather than in the decoder,
which stays a dumb container/codec layer.

### 2. Phase 1 — what one episode becomes

Three passes over that mono buffer, each producing something small and
structured-cloneable:

- **Chroma** — 12 pitch classes per frame at ~15.6 fps. Each frame is *centred*
  (the time-mean subtracted) and L2-normalised. Centring is not optional: without
  it every frame correlates with every other at ~0.9 and the similarity measure
  is worthless.
- **Landmarks** — Shazam-style spectral peak pairs, hashed as
  `(freq₁, freq₂, Δt)`. This is what finds audio that repeats.
- **Features** — six numbers per frame: level, bass ratio, spectral flatness,
  spectral flux, 4 Hz modulation energy, and chroma self-similarity.

Together these are ~1 MB per episode. The 42 MB of PCM is released.

### 3. Phase 2 — finding audio that repeats

Landmarks are matched between every pair of episodes, and each match votes for a
time offset. A real recurring asset produces a sharp spike in that offset
histogram; coincidental matches spread out.

The trap here is **dilution**. A 13-second theme inside a 22-minute episode is
about 1% of the signal, so averaging similarity across the whole overlap buries
it completely. Everything in this stage is built around not doing that:

- Each pair contributes only its strongest few offset bins, chosen against an
  **adaptive** threshold (mean + 5σ of its own histogram) — an absolute vote
  count is meaningless across corpora, since with 19 episodes the noise floor
  sits above any fixed number.
- The extent of an occurrence is the **densest window containing 85% of its
  votes**, not the min/max, which a couple of stray votes would stretch across
  the whole episode.
- Episodes whose evidence is far weaker than the median are marked **absent**
  rather than handed a fabricated position.
- An occurrence longer than **90 s** is marked absent outright. This catches the
  case where a small corpus lets generic content clear the peak threshold and the
  votes smear instead of clustering — a failure that produced a "658-second clip"
  before it was bounded.

Fingerprints locate an asset to ~1–2 s. **Refinement** then re-locks the offset
per episode against the chroma profile and reads the extent off it, because that
boundary is a cliff (0.99 inside, 0.07 outside) and the cut point is therefore
well determined.

### 4. Finding music inside one episode

A different problem: no repetition to lean on. Instead it learns what music looks
like *in this show*, using the detected theme as the positive example, and scores
every frame with a linear discriminant.

That is chicken-and-egg, because the theme itself comes from matching episodes
against each other: **common clips need at least two files** by construction,
while this stage is per-episode and must run on any number of them. With no theme
to learn from it picks its own example instead: the 10 seconds that are loudest
and least syllable-modulated, scored `level − 30 · mod4`. That is the audio most
obviously *foreground music*, which is what this stage is after.

The obvious alternative, the end credits, measures much worse, which is worth
recording because it is the first thing one would reach for. On this corpus the
credits' `mod4` (0.240) sits barely above non-music audio (0.195), so calibrating
on them teaches the discriminant that music may be that speech-like — and
dialogue-under-music starts to pass. Over 18 episodes, against what the theme
calibration agrees is music:

| exemplar | separation | music | not music |
|---|---|---|---|
| theme (reference) | 1.63 | 1417 s | 0 s |
| end credits, 45 s | 0.86 | 1176 s | **1930 s** |
| loudest, least speech-like 10 s | **1.81** | 1029 s | **66 s** |

Every window from 10 s to 30 s and every weight from 10 to 60 kept the known
false positive out, so this is a plateau rather than a tuned point. It is still
the fallback rather than the default, and the page says when it is in use.

Measured on real episodes, `logRms` earns almost no weight — its variation
*within* a class (silence through speech) dwarfs the difference between classes.
So the score cannot separate a quiet passage from music, and the false positives
were exactly that: room tone, low drones, scenes under a music bed. Music-like in
timbre, far below it in level.

Hence three guards on top of the score:

- **A peak floor** — a run must reach 70% of the way from the decision threshold to
  the mean score of the theme frames. It is expressed *relative to the
  calibration* because the discriminant score is only defined up to an affine
  transform: an absolute floor that once meant "no floor" ended up sitting above
  the theme's own average score and was quietly deleting real music. It kept the
  stage at 14 of 18 episodes; relative, it reaches 18 of 18.
- **A level gate** — a proposed cue must be within 8 dB of the level of the music
  exemplars, measured against that episode's own mix so it survives differently
  mastered files. This is also what the goal implies: *music under dialogue is
  fine to keep*, and that is the quiet case.
- **A ceiling** — one cue cannot exceed a quarter of the episode.

Where a segment *ends* is a separate tuned decision from whether it is music. A
run is detected on a median-filtered score, which is robust but smears the
boundary; each edge may then reach a fraction of the run's prominence below the
detection threshold. That fraction was 0.35 and is now 0.10, because measurement
said the outward reach was eating speech: across 147 segments the frames it added
averaged `mod4` 0.175, against 0.123 in the music core and 0.215 for non-theme
audio. Tightening it gives back 69.5 s over the corpus with no episode losing its
segments and theme coverage unchanged at 18/18. Auditioned as clips with the cut
boundaries marked, the tightened rule is the one that stopped taking dialogue.

Anything already being cut as a common clip is excluded, so the same seconds are
never proposed twice.

### 5. Cutting

Music spans are removed by **dropping whole frames and re-muxing the rest** —
AAC, FLAC and MP3 frames are independently decodable, so the surviving audio is
bit-identical to the source rather than approximately so. That is a bonus rather
than the point: the goal is that it works at all, and re-encoding would be
acceptable if it bought more coverage. Where a format allows it cheaply, it is
free.

Each container needs its own handling, and each has a trap:

| container | how | trap |
|---|---|---|
| MP4 / M4A / MOV | rebuild `moov`, copy the codec config verbatim | the `edts`/`elst` edit list must be re-emitted, or output is shifted by the AAC priming |
| FLAC | drop frames, rewrite `STREAMINFO` | frames carry no length field — boundaries must be found by parsing headers and checking their CRC-8 |
| MP3 | drop frames | LAME's `Xing`/`Info` header declares the *original* length, so a 60 s cut still reports 90 s until it is rewritten |
| WAV / AIFF | copy the header, patch three length fields | none — PCM is byte-addressable, so the cut is exact arithmetic |

Tags ride along: the source's `udta` box is copied **verbatim** rather than
re-parsed, so every atom survives whether or not the code knows what it means.
Output keeps the input's stem and takes an extension from the container, so a
video file comes back as `.m4a`.

## Supported formats

| container | codec | status |
|---|---|---|
| MP4 · M4A · MOV | AAC | ✅ tested, including files with a video track |
| FLAC | FLAC | ✅ tested |
| MP3 | MP3 | ✅ tested |
| WAV · AIFF | PCM | ✅ tested, incl. `WAVE_FORMAT_EXTENSIBLE` |
| MKV · WebM · Ogg · WMA · AVI | anything | ❌ no demuxer |

**What's missing for the unsupported formats is a demuxer, not a decoder.**
WebCodecs decodes Opus, Vorbis and AC-3 perfectly well — it simply cannot find
the frames. Those files report an error and are neither converted nor uploaded;
there is no fallback decoder in the page (the ffmpeg path in `audio-decode` is
Node-only and reachable only from tests).

## Running it

```bash
python3 -m http.server 8000        # from the repo root
open http://127.0.0.1:8000/
```

No build step: the page is plain ES modules, and it sits at the repo root so its
imports of `./src` and `./audio-decode/src` resolve as they are. Dropping files
starts analysis immediately — there is no "analyze" button.

GitHub Pages has no way to publish a subdirectory at `/` — `deploy-pages` serves
the artifact it is handed at the site root, verbatim, and the only folder names a
branch deploy accepts are `/` and `/docs`. So `scripts/build-site.mjs` copies the
page and both library trees into `_site/`, which is exactly what the
[Pages workflow](.github/workflows/pages.yml) uploads:

```bash
node scripts/build-site.mjs
python3 -m http.server 8000 --directory _site    # the published build, byte for byte
```

## Verification

Measured on a 19-episode corpus, and asserted by the test suite:

| | |
|---|---|
| theme discovered | **18 of 19** episodes |
| cut positions vs independent ground truth | **mean 0.81 s, max 0.83 s** |
| general-music stage | segments in **18 of 18** episodes |
| level gate (hand-labelled) | **5 of 6** false positives removed, **5 of 5** confirmed cues kept |
| time per 22-minute episode | ~3.5 s under Node (decode 49%, features 37%, fingerprints 14%) |

**The browser splits that time completely differently.** Measured on the same
kind of episode through WebCodecs: **decode 88%**, features 9%, fingerprints 3%.
Decoding dominates in a page in a way it never does through ffmpeg, which is why
the progress meter learns each backend's split at runtime and remembers it — the
figures above would put the bar at 27% when half the wall clock had passed.

The page is verified end to end in a real browser: the module graph loads,
WebCodecs decodes MP4/AAC, the phase-1 worker pool runs and transfers its buffers
back, phase 2 discovers and refines, and the cut writes output files.

```bash
npm test                      # hermetic regression + real-audio integration
cd audio-decode && npm test   # demux / decode / cut / format coverage
```

Counts, all green: regression 40, integration 12, formats 47, cut 29, demux 41,
decode 24. The integration suite **skips cleanly** without a corpus, and asserts
the numbers above rather than asserting "it ran".

Several tests exist because a claim was wrong once. The span cap is tested by
requiring the smear to be *reproducible with the guard off*, since a test that
cannot fail proves nothing. The chroma handoff and the fused spectral pass are
asserted **bit-identical** rather than close, because chroma positions every cut.

## Known limitations

- **Segmentation is marginal.** Calibration separation is ~1.4 pooled SD, so it
  runs near its decision boundary and marginal episodes flip on small decode
  differences. It is assistive, not automatic.
- **The general-music thresholds are tuned on 11 hand-labelled segments from 2
  episodes**, so the 8 dB level gate is provisional.
- **The peak floor's 0.7 rests on one listening pass, and the false-positive rate
  was never counted.** Making it relative roughly doubles what the general stage
  proposes — 729 s to 1417 s across the 18 episodes, about 79 s per episode
  instead of 40 s — and all 146 segments were auditioned as clips. The verdict
  was that most of them are music worth removing, so the floor stands; "most" is
  not "all", and how many are not was not recorded. 0.9 or above loses the cue
  that prompted the change.
- **Small corpora are materially weaker.** The theme stage is validated on 19
  episodes; run over five, the adaptive peak threshold cannot reject generic
  content and occurrences smear. Bounded now, but the list deserves a closer look
  on a small run. Concretely: at three files a theme is still located cleanly
  (11.1 s span) but only two episodes carry it, so a majority is accepted there;
  at **two files the votes smear across 100–200 s and nothing is found at all**.
  That is the 90 s guard rejecting a smear rather than a miss, and it is left
  that way on purpose — accepting it would cut minutes of dialogue.
- **The single-file exemplar is a heuristic, not a detector.** With no common
  clip it calibrates on the loudest, least speech-like 10 s it can find. That
  recovers the theme's class separation on this corpus (1.81 against 1.63) and
  keeps the known false positive out. It has been heard once: S01E06 on its own
  proposes 7 segments, and all 7 were music worth removing. That is precision on
  **one episode**, not recall — nothing has checked what it *missed* — and it is
  one listener, so treat it as a spot check rather than a validation. It has also
  never run on material that is not a TV episode: on a podcast or a music track
  it will select something and calibrate on it with no way to know it chose well.
- **Extents run slightly short** against ground truth. The start is reliable; the
  tail is under-measured. Prefer padding the end over trusting the raw span.
- **Music under dialogue is out of scope by design** and is left in place.
- **Detection is tuned on one show.** A second corpus would settle how much
  transfers.
- **No cross-browser testing.** `showDirectoryPicker` is Chromium-only; the page
  falls back to individual downloads elsewhere.
- **Nothing is cached.** Every run re-decodes every file from scratch, so
  re-running a season re-decodes all 19 episodes. The phase-1 results are already
  structured-cloneable, so IndexedDB is the obvious fix.
- **The page and the CLI have not been compared sample for sample.** Both go
  through the same orchestration and the same cutter, so they should agree
  exactly — but that is an argument, not a measurement.

## Repo layout

```
README.md          this file
index.html         the page — at the repo root so that it publishes at /
main.js            page UI: file intake, results, auditions, export
pipeline.mjs       orchestration shared by the worker pool and the tests
worker.mjs         phase-1 worker: decode -> chroma / landmarks / features
style.css          page styles
src/               music-analysis: pure analysis, no I/O, no DOM, no Node
audio-decode/      encoded bytes -> AudioChunk stream, and lossless cutting
spike/             the original research code and CLIs (see spike/README.md)
test/              regression (hermetic) and integration (real audio)
scripts/           build-site.mjs — assembles _site/ for GitHub Pages
```

The project is *sleep filter*; the two packages underneath keep technical names,
because each describes what it does rather than what it is for.

`src/` has no idea what a container or a codec is. **Input is raw audio —
`Float32Array` — never an encoded file**, which is what lets it run unchanged in
Node, a Web Worker, or a page. `audio-decode` is the other half of that boundary.

`spike/` is kept as the reference implementation — the regression suite compares
against it — and as the source of the ground truth. It documents nine failure
modes found while building this, with measurements.

## Using the analysis directly

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

The chunk contract mirrors `WebCodecs.AudioData`, so a decoder hands data over
with almost no transformation:

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

Chunks rather than one buffer, because a 22-minute stereo file at 48 kHz is
~500 MB of float32 and that must never be materialised.

| export | purpose |
|---|---|
| `EpisodeAnalyzer` | streaming chunk → features (phase 1) |
| `Library` | discover / refine / segment across episodes (phase 2) |
| `segmentEpisode` | per-episode segmentation without a library |
| `computeChroma`, `profile`, `smooth` | chroma features |
| `fingerprint`, `discover` | landmark hashing and offset consensus |
| `computeFeatures`, `calibrate`, `scoreFrames`, `segment` | music segmentation |
| `refineAsset` | chroma refinement to precise cut points |
| `MonoResampler`, `toMonoAt`, `describeChunk` | raw-audio ingestion |
| `fft` / `makeFFT` / `realSpectrum` | shared DSP primitives |

Everything returned is plain data — `Float32Array`, `Map`, arrays, numbers — all
structured-cloneable, so results go to and from a worker or straight into
IndexedDB with no conversion step.
