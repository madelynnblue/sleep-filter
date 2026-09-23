# Theme discovery + refinement spike

Zero-input discovery of recurring audio assets (title theme, end-credits music,
recurring stings) across a set of episodes, refined to precise per-episode cut
points — no seed, no template, no manual marking.

This de-risks the highest-value assumption in the web-app plan: that recurring
assets can be found and measured automatically, so the human's job shrinks to
confirming a proposal instead of driving the process.

## Run it

```bash
node run-node.mjs ~/Downloads/andy-richter-audio            # full pipeline
node run-node.mjs <dir> --seconds 300 --limit 6 --debug     # fast slice + internals
node run-node.mjs <dir> --sweep                             # compare boundary strategies
node run-node.mjs <dir> --no-refine                         # stage 1 only
node run-node.mjs <dir> --top 10 --min-df 0.15 --min-support 3   # N most common clips
node run-node.mjs <dir> --mute-theme 5                      # resilience test
node probe.mjs --all S01E01                                 # per-pair signal strength
node credits.mjs                                            # which episodes share credits?
node credits-diag.mjs                                       # theme vs credits, with control
```

ffmpeg must be on PATH. It is used only as the decode step (media → 8 kHz mono),
standing in for what WebCodecs `AudioDecoder` would do in the browser.

## Pipeline

```
pass 1  decode -> fingerprint + chroma      (keep ~1 MB/episode, discard PCM)
pass 2  discover recurring assets           (landmark hashes + offset consensus)
pass 3  refine to per-episode cut points    (chroma similarity profile)
```

Pass 1 is the expensive one (~55s for 19 episodes); passes 2 and 3 are seconds.

## Results — 19 full episodes of *Andy Richter Controls the Universe*

Scored against ground truth from a **completely independent** earlier method
(centred-chroma sliding alignment, where the theme measured 0.98 cosine
similarity against a ~0.0 background):

| | mean start error | max | within 1.0s | span |
|---|---|---|---|---|
| stage 1 only (fingerprints) | 0.95s | 2.30s | 10/18 | 11.33s |
| **stage 1 + 2 (refined)** | **0.86s** | **0.90s** | **18/18** | 11.26s |
| ground truth | — | — | — | 12.67s |

Refinement takes every inlier inside 1 second and cuts the worst case from 2.3s
to 0.9s. Discovery is genuinely zero-input; S02E03 is **flagged as an outlier**
rather than silently accepted, and refinement declines to refine it.

**Corpus size matters, and refinement is tuned for a full season.** On a small
truncated subset (6 episodes × first 300s) refinement is *worse* than discovery
alone — 2.06s vs 0.98s mean error:

| corpus | stage 1 | stage 1 + 2 |
|---|---|---|
| 19 episodes, full length | 0.95s (10/18 within 1s) | **0.86s (18/18 within 1s)** |
| 6 episodes, first 300s | 0.98s (4/6 within 1s) | 2.06s (3/6 within 1s) |

The envelope needs ≥8 pairs before it's stable (below that it falls back to
per-episode extents automatically), and the offset lock benefits from
corroboration across episodes. For small sets, prefer `--no-refine`.

```
#1  TITLE-THEME
    length 11.26s   support 19/19 (100%)   mean similarity 0.989   offset shift 0.96s
      S01E02  1:41.0 - 1:52.3  (sim 0.983)
      S02E04  1:44.4 - 1:55.6  (sim 0.997)
      ...
      S02E03  !! flagged outlier (261s span, unrefined)
```

## Partial support and absence — resilience to missing content

Real seasons are messy: some episodes have no intro theme at all, or a different
one. Two things make the pipeline resilient.

**Lower the document-frequency pre-filter.** `minDf` is a *pre-filter*, and it
was the thing hiding partial-support assets: at 0.6 a clip present in only 8 of
19 episodes is never even considered. The default is now 0.2, with an absolute
floor (`minSupportCount`, default 3) that is easier to reason about than a
fraction.

**Treat absence as a first-class outcome.** An episode that does *not* contain
the asset still gets *some* best-matching peak, so counting it as support
overstates confidence and its bogus span corrupts the asset's statistics
(measured earlier: one such episode reported a 261s span). Episodes whose
evidence is far weaker than the median (`absentVoteFrac`), or whose chroma
similarity inside the asset is low (`minSim`), are marked **ABSENT**, given no
position at all, and excluded from every statistic. Candidates that chroma
cannot confirm in a single episode are dropped as fingerprint artefacts.

### Verified, not asserted

`--mute-theme K` destroys the theme in the first K episodes (using ground-truth
positions) so the behaviour can be tested directly. Destroying it in 5 of 19:

```
--mute-theme 5
#1  TITLE-THEME   support 13/19 (68%)   mean similarity 0.989
      S02E04  1:43.9 - 1:55.6  (sim 0.997)
      ... 13 present episodes, sim 0.964-0.997 ...
      S01E04  ABSENT — no asset in this episode
      S02E03  ABSENT — no asset in this episode
      S01E02  ABSENT — no asset in this episode
      S01E01  ABSENT — no asset in this episode
      S01E05  ABSENT — no asset in this episode
```

The theme is still found, the destroyed episodes are correctly reported as
absent rather than handed fabricated positions, and start accuracy holds
(0.96s mean).

### Finding "the N most common clips"

Ranking is by prevalence (`rankBy: 'support'`), and `maxAssets` / `--top N`
returns the N most common:

```bash
node run-node.mjs <dir> --min-df 0.15 --min-support 3 --top 10
```

The harness prints a prevalence table (kind, episode count, length, mean start,
similarity) before the per-asset detail.

## Stage 1 — discovery

Two filters, and **both are required**:

1. **Document frequency.** A hash appearing in one episode is dialogue; one
   appearing in most episodes is a candidate recurring asset.
2. **Offset consensus** *(the discriminative one)*. Histogram
   `delta = t_ref - t_other` over shared hashes, counting **distinct hashes**. A
   genuine asset lands as a tall spike; common musical patterns, room tone and
   reused stings recur at random offsets and smear.

Multiple assets fall out for free: each spike is a different asset.

## Stage 2 — refinement

Fingerprints localise to ~1-2s; chroma measures. For each episode: re-lock the
offset by maximising chroma similarity near the fingerprint's guess, then read
the extent off the similarity profile, whose boundary on this corpus is a cliff
(0.99 inside, 0.07 outside).

Extents come from a **robust envelope** across all pairs (10th percentile of
per-pair starts, 90th of ends) rather than one reference — see failure mode 7.

## Eight failure modes found while building this

These cost most of the effort and are the real output of the spike.

**1. Hash-space saturation.** First run called 261,116 of ~350k hashes
"recurring" — they came from only ~530k possible values, so collisions made
everything look shared. *Fix:* pack hashes with room (~2.1M space). The harness
prints an occupancy check that warns above 50%; the bug was invisible without it.

**2. Document frequency is not discriminative alone.** Recurring hashes sat at
*random* times, so time-clustering merged each whole file into one segment
(240–297s spans). DF says a hash is common, not that it sits at a consistent
relative position.

**3. `min`/`max` is not a robust extent.** Two stray votes stretched every asset
across the episode. *Fix:* densest window containing 85% of votes — this alone
turned the theme from nonsense into a clean 2:31–2:42.

**4. Single-linkage chaining in aggregation.** Grouping peaks by proximity of
reference start chained 2:31→2:34→2:37 into one giant asset. *Fix:* group by
span overlap plus a minimum vote density.

**5. Reference choice dominates everything.** The consensus test is measured
against a reference, and an absolute `minVotes` threshold is meaningless across
corpora — at 19 episodes the per-bin noise floor (~37) sat above the threshold
(12), so every bin looked like a peak.

`probe.mjs --all S01E01` shows the underlying signal is excellent: the theme is
the **global maximum delta bin in 16 of 18 pairs** (109–438 votes vs ~18 noise).
But a medoid reference doesn't capture this, because the medoid is computed over
the recurring set, which is dominated by common audio — so it can be typical for
*ambience* and atypical for the *theme*. It picked S02E03, whose theme bin
collapses to 3 votes:

```
reference trials: S02E03(score 0), S01E06(426.7), S02E04(512.3), S02E08(591)
```

*Fix:* adaptive threshold from each histogram's own statistics (`mean + 5σ`),
cap peaks per pair, and try several references.

**6. A fixed similarity threshold fights itself.** High thresholds give crisp
starts but truncate the tail; low ones capture the tail but trip on a
**partial-similarity lead-in** — several seconds before the theme where raw
similarity is already 0.4–0.8. This is the core difficulty of stage 2: the
transition is a cliff, but only *after* a ramp. Measured tradeoff:

| strategy | span | start mean\|err\| | within 1s | end mean\|err\| |
|---|---|---|---|---|
| threshold 0.85 | 11.33s | 0.98s | 9/18 | 3.03s |
| threshold 0.90 | 11.07s | 0.88s | 15/18 | 2.70s |
| threshold 0.95 | 10.75s | 0.78s | 16/18 | 4.39s |
| threshold 0.95 + envelope | 11.26s | 0.86s | **18/18** | 2.30s |
| gradient (threshold-free) | 12.93s | 2.78s | 1/18 | 3.36s |
| gradient + envelope | 20.10s | 4.90s | 1/18 | 1.68s |

The gradient method gets the *length* right (12.93s vs 12.67s truth) but shifts
the boundaries, because the lead-in's rise is also a gradient. Thresholds pin
the edges; the envelope then recovers the full span.

**7. One reference under-measures the extent.** End error (2.70s) was far worse
than start error (0.88s): if the reference's theme tail differs at all, its
profile goes quiet early and every extent comes up short. *Fix:* robust envelope
across all pairs — end error 2.70s → 2.30s.

**8. A strict threshold fails outright on some pairs.** One episode produced no
run at all at 0.90. *Fix:* progressive fallback (thr, thr−0.08, thr−0.16).

## Per-episode music segmentation

The goal this serves: strip music that plays **on its own** (theme, credits,
interludes, diegetic songs) so the audio is sleep-friendly. Music *under*
dialogue is explicitly out of scope and is left in place — which turns the
problem from "where is there music?" (very hard) into "where is there music with
no speech?" (tractable), because the expensive error — cutting dialogue — is
then governed by speech detection rather than by music classification.

`music.mjs` + `segments.mjs`: six features (log RMS, low-band ratio, spectral
flatness, flux, 4 Hz modulation energy, chroma self-similarity) combined by a
diagonal Fisher discriminant **calibrated on the title theme** — a music exemplar
the earlier stages already identified with high confidence — so there are no
hand-tuned absolute thresholds.

### Current state

| metric | result |
|---|---|
| theme recall | 19/19 (>70% covered) — expected, it is the calibration source |
| credits recall | 12/19 (>50% covered) |
| music per episode | median 193s (**14.3%** of runtime) |
| segments per episode | median 19 |
| calibration separation | 1.39 pooled SD |
| non-theme flagging | **9.4%** (upper bound on FP — see caveat) |

### Two fixes that mattered

**1. The 4 Hz modulation feature was computed wrongly.** The classic
Scheirer–Slaney cue needs band envelopes sampled well above 4 Hz. The first
version derived them from frame-rate log RMS (~15.6 Hz), which cannot resolve
syllable rate and instead measured *musical beat* — giving the feature the
**wrong sign** (+0.75 SD, music > dialogue). Rebuilt with 100 Hz per-band
envelopes (biquad bandpass → rectify → smooth) and a real 3–6 Hz bandpass. Now
correctly signed and the strongest feature by a wide margin:

| feature | separation (music vs dialogue) |
|---|---|
| **`mod4`** | **−0.87 to −1.29 SD** (dialogue > music) |
| `flatness` | 0.28–0.62 SD |
| `lowRatio` | 0.21–0.50 SD |
| `flux`, `chromaSelf`, `logRms` | < 0.35 SD |

**2. Short segments were almost all false positives.** Requiring a minimum
duration was worth more than any threshold tuning — real music cues are rarely
under 4s, while brief music-like moments inside dialogue are common:

| bias | minDur | music/ep | segs | theme | credits | non-theme flagged |
|---|---|---|---|---|---|---|
| −0.5 | 2s | 514s | 80 | 100% | 84% | 33.1% |
| 0 | 2s | 287s | 55 | 100% | 74% | 19.1% |
| **0** | **4s** | **193s** | **19** | **100%** | **63%** | **9.4%** |
| 0 | 6s | 126s | 10 | 100% | 53% | 4.8% |
| +0.5 | 6s | 58s | 5 | 74% | 32% | 1.8% |

Defaults are now `bias 0`, `minDuration 4s`.

### Verified false-positive rate

The "non-theme flagged" figure samples windows outside the theme and credits —
but those windows contain real interludes and songs, which *should* be flagged.
So it is an **upper bound**, not a true FP rate.

The user supplied three regions, in different episodes and both seasons, that
they had listened to and confirmed are dialogue with **no** music:

| episode | region | |
|---|---|---|
| S01E01 Pilot | 3:08–3:38 | 188–218s, immediately after the theme |
| S02E01 Bully the Kid | 6:11–6:41 | 371–401s |
| S02E03 Duh Dog | 5:08–5:38 | 308–338s |

Measured against all three (90s of verified music-free dialogue):

**verified dialogue FP = 2.7%**, with theme recall 19/19 and credits recall 12/19
unchanged.

The entire error is one segment: S02E03 304.2–310.5, which bleeds 2.5s into the
verified window. Its peak score is **1.098**, against 1.9–2.9 for genuine cues.

#### The obvious fix is a bad trade

That suggests a confidence floor, but sweeping it shows the peak distributions of
true and false positives overlap:

| minPeak | music/ep | theme recall | credits recall | verified FP |
|---|---|---|---|---|
| **0** (default) | 183s | **100%** | **58%** | 2.7% |
| 1.0 | 109s | 74% | 47% | 2.7% |
| 1.2 | 87s | 68% | 37% | **0.0%** |
| 1.4 | 61s | 58% | 32% | 0.0% |

Eliminating the false positive costs nearly half the recall, so `minPeak` stays at
0 and the 2.7% is accepted. **2.7% over 90s is a measurement, not an estimate** —
but it rests on three regions, so treat it as indicative rather than a corpus
rate. Each additional confirmed region is one line in `VERIFIED_DIALOGUE`.

`node segments.mjs --dump` writes `segments.tsv` with all detected segments and
timestamps for review.

### What is usable today

- **Theme**: production-ready (validated at 18/18 within 1.0s).
- **Credits on this show**: sit **35.4–36.3s before the end** across all 19
  episodes, confirmed by four hand-checked anchors. Segmentation catches them in
  12/19; a positional prior would be exact here, but it is show-specific.
- **Interludes / diegetic songs**: detected at the settings above, but the
  precision is unverified — review before trusting, and treat this as
  assistive rather than automatic.

### Why — measured, not guessed

Per-feature separation between theme frames and sampled non-theme frames
(`/tmp/featdiag.mjs`-style breakdown, three episodes):

| feature | separation | direction |
|---|---|---|
| `mod4` | 0.59–0.75 SD | **inverted** vs theory |
| `flatness` | 0.28–0.62 SD | music > other |
| `lowRatio`, `flux`, `chromaSelf`, `logRms` | **< 0.5 SD** | no discrimination |

This is a **feature-set failure, not a threshold or bug problem**. With at best
~0.7 SD on one feature, the class distributions overlap almost completely, so
every threshold trades recall for precision along a steep, useless curve.

Two specific causes:

1. **`mod4` is computed wrongly.** The classic Scheirer–Slaney feature needs band
   envelopes sampled well above 4 Hz (100 Hz+) then a proper bandpass. This
   version derives the envelope from log RMS at the frame rate (~15.6 Hz), so it
   cannot resolve syllable rate, and it ends up measuring *musical beat* instead —
   hence the inversion. It is the strongest feature precisely because it is
   accidentally a rhythm detector.
2. **Music under dialogue is inherently ambiguous.** Much TV music is a bed
   beneath speech, which is genuinely both classes at once.

### What would actually fix it

- **Correct the modulation feature** (high-rate band envelopes + real bandpass).
  Cheap, and the one feature that already shows signal — but unlikely to be
  sufficient alone.
- **Use a trained model.** [`inaSpeechSegmenter`](https://repos.data.code.gouv.fr/hosts/GitHub/repositories/ina-foss%2FinaSpeechSegmenter/readme?sha=v0.7.4)
  (a CNN for speech/music/noise segmentation) is the established tool. It is
  Python, so it breaks the browser-only plan unless ported to ONNX/WASM — or run
  as an optional local preprocessing step.
- **Source separation, if the target is music *under* dialogue.** Detection alone
  cannot remove a music bed without the speech; that needs separation (Demucs,
  MDX-Net). Different technology, heavier, imperfect — but it is the only thing
  that addresses that case.

### What is usable today

- **Theme**: production-ready (validated at 18/18 within 1.0s).
- **Credits on this show**: sit at **35.4–36.3s before the end** across all 19
  episodes, confirmed by four hand-checked anchors. A positional prior is exact
  here — but it is show-specific and must be verified per show, not assumed.
- **Interludes / diegetic songs**: not solved. Needs a real classifier or manual
  marking.

The honest summary: this stage converts a "provably right or abstains" pipeline
into a "probably right, please check" one — and at 13.8% dialogue false
positives it is not yet even reliably "probably right". It should not be wired
into automatic cutting as-is.

## End credits on this show are NOT a shared asset — confirmed

Credit starts supplied by ear for four episodes (Pilot 22:02, Grief Counselor
21:38, Gimme a C 21:22, Wedding 21:36) all sit **35–36s before the end**, which
is how they were located for comparison.

Measured across all 19 episodes (`node credits-diag.mjs`):

| comparison | median chroma similarity |
|---|---|
| theme vs theme (**control** — the theme *is* shared) | **0.873** |
| credits vs credits | 0.529 |
| own theme vs own credits | 0.350 |

**The control is what makes this conclusive.** The same method recovers the
theme at 0.873, so if credits were a shared recording they would light up the
same way. At 0.529, with individual episodes ranging −0.53 to +0.76, they are
stylistically similar music but not the same recording.

This matches listening: **this show does not use identical credits music across
episodes.** It also fits the documented music-replacement on the show's DVD.

The pipeline's behaviour here is correct: it reports no such asset rather than
inventing one. That is the abstention the plan called for, and it is why
`--min-df 0.15 --top N` returned only the theme.

**Two different problems, two different methods.** Shared-asset discovery (what
this spike implements) requires the audio to genuinely repeat across episodes.
Credits music that differs per episode is invisible to it *by construction* and
needs a **per-episode** method instead — music/speech segmentation to find
"there is a music bed here" without any cross-episode corroboration. That is a
different algorithm with a different failure mode: no consensus check, so lower
confidence and more need for review. The 36s-before-end regularity would make a
positional prior useful, but that is show-specific and would need to be learned
or supplied.

## Browser portability

`discovery.mjs` and `chroma.mjs`/`refine.mjs` have **no Node APIs and no
dependencies** — they take mono `Float32Array` samples and run anywhere. The FFT
is hand-rolled (radix-2, precomputed twiddles).

| Stage | Node (this spike) | Browser |
|---|---|---|
| decode | ffmpeg → 8 kHz mono | `AudioDecoder` (WebCodecs) + MP4 demux, downsample in the callback |
| features | `discovery.mjs`, `chroma.mjs` | identical |
| discover / refine | identical | identical |
| cut | — | `mp4-muxer` `addAudioChunkRaw` over original AAC chunks (lossless) |

## Limitations

- **Extent is ~1.4s short** (11.26s vs 12.67s truth). The start is now reliable
  (18/18 within 1s) but the tail is still under-measured; for cutting, pad the
  end rather than trusting the raw span. `padStart`/`padEnd` options exist.
- **Refinement needs a full season to pay off** (see the table above). It is
  validated at 19 episodes and can regress on small or truncated subsets; the
  envelope guard and the offset lock both want more corroborating pairs.
- **Envelope gives every episode the same length.** Correct if the asset is the
  same cut everywhere, wrong if it's trimmed per episode — `extent: 'perEpisode'`
  preserves variation but costs start accuracy (0.88s, 15/18 within 1s).
- **Outlier/absence detection is vote-count based**, which caught the atypical
  episode here and correctly handled 5 synthetically-destroyed ones, but the
  `absentVoteFrac` / `minSim` cutoffs are not guaranteed to generalise.
- **Thresholds are tuned on one show** and need a second corpus.
- **No formal abstention**: a weak result still returns candidates.
- **Untested on non-tonal assets** (percussion stings, spoken catchphrases) —
  chroma assumes harmonic content.
