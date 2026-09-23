# app — the front door

Two front ends over the same orchestration (`pipeline.mjs`): a static web page
and a Node CLI. The only difference between them is which decoder backend
`audio-decode` selects — WebCodecs in the page, ffmpeg in Node.

## Web page

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
- **Non-MP4 containers in a page.** The ffmpeg fallback is Node-only, so a
  container the built-in demuxer refuses has no path here.
- **Output equivalence with the CLI.** Both go through the same orchestration and
  the same cutter, so they should agree sample-for-sample, but this has not been
  compared directly.

## CLI

Same pipeline, and this one *is* exercised end to end.

```bash
node app/cli.mjs <dir> [--out <dir>] [--asset N] [--mode remove|keep]
                       [--min-df F] [--min-support N] [--limit N]
                       [--dry-run] [--quiet]
```

`--dry-run` analyses and reports without writing. `--asset N` picks which
discovered asset to strip (0 = top); `--mode keep` extracts the music instead of
removing it.

### Observed run on 19 episodes

```
DISCOVERED ASSETS
  #   kind             episodes   length   mean start  confidence
  0   title-theme      18/19      11.2s    2:43.9      0.988
      absent from: S02E03

removed 847s of music across 14 file(s)
written to ~/Downloads/andy-richter-audio/no-music
```

All 14 outputs re-demux cleanly at the original codec/rate/channels, and ffprobe
independently agrees on every duration.

**Two honest caveats from that run:**

- **4 of 18 episodes yielded no segments at all**, and one found 19 segments /
  184s (14% of the runtime) where most found 2–9. That spread is the segmentation
  stage running near its decision boundary — it is assistive, and the per-episode
  counts are printed precisely so outliers are visible rather than trusted.
- **Music under dialogue is untouched by design.** If a music bed sits under
  speech, it stays; removing it would need source separation, not detection.
