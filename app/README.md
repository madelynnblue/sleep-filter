# app — the web app

A static page over the shared orchestration in `pipeline.mjs`. Everything runs
in the tab; the only backend `audio-decode` reaches for here is WebCodecs.

## Running it

**It must be served over HTTP** — ES modules do not load from `file://`, and the
page uses an import map plus a module worker.

```bash
cd <repo root>
python3 -m http.server 8000
# open http://127.0.0.1:8000/app/
```

There is no backend logic. Any static host works (GitHub Pages, Netlify, an
S3 bucket, a USB stick with a server). Nothing is uploaded: decoding, analysis
and cutting all run in the tab.

Flow: drop episode files → **Analyse** (phase 1 in a worker pool, up to 4 at
once) → pick an asset → **Find all music and export**. Output goes to a folder
you choose (`showDirectoryPicker`, Chromium-only) or to individual downloads.

### Verification status

**Verified end to end in a real browser:** the import map and full module graph
load, WebCodecs decodes MP4/AAC, the phase-1 module worker runs and transfers
feature buffers back, phase 2 discovers and refines, segmentation runs, and the
cut exports output files.

That closes the original loop — the whole chain runs client-side with no backend,
and nothing is uploaded.

**Not yet established:**

- **Cross-browser.** Exercised in one browser only. Safari 16.4+ and Firefox 130+
  should work (WebCodecs), but `showDirectoryPicker` is Chromium-only; elsewhere
  the page falls back to individual downloads.
- **Large batches.** Tried with a few files. A full season is 19 decodes with no
  caching, so re-running re-decodes everything — IndexedDB is the obvious fix and
  the results are already structured-cloneable for it.
- **Containers beyond MP4, FLAC and MP3.** Those three have built-in demuxers;
  Ogg, WMA and WebM do not, and the ffmpeg fallback is Node-only, so they have no
  path in a page. What is missing for them is a demuxer, not a decoder —
  WebCodecs decodes Opus and Vorbis, it just cannot find the frames.
- **Output equivalence with the CLI.** Both go through the same orchestration and
  the same cutter, so they should agree sample-for-sample, but this has not been
  compared directly.
- **The general-music level gate.** Tuned against 11 hand-labelled segments from
  2 episodes, so its 8 dB figure is provisional. It removes 5 of the 6 false
  positives with no loss of confirmed music; the survivor is a loud 4.9s segment
  that only a duration floor would catch.
- **Discovery on a handful of episodes.** The theme stage is validated on 19
  episodes; run over five it is materially weaker. With too few episodes the
  adaptive peak threshold cannot reject generic content, and the landmark votes
  smear instead of clustering — a "clip" can then span minutes. The
  `maxOccurrenceSeconds` guard stops those from being cut, but the asset list is
  still worth reviewing closely on a small run.
