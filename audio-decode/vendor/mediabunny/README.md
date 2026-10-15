# Vendored: mediabunny

A single third-party file, kept here unmodified because the page ships as plain
ES modules with no bundler and no package install. It is the Matroska/WebM
demuxer that `../src/matroska.mjs` drives; nothing else in the repo imports it.

| | |
|---|---|
| package | [`mediabunny`](https://www.npmjs.com/package/mediabunny) 1.61.5 |
| file | `dist/bundles/mediabunny.min.mjs` |
| upstream | <https://github.com/Vanilagy/mediabunny> · <https://mediabunny.dev> |
| license | MPL-2.0 — full text in [`LICENSE`](./LICENSE) |
| sha256 | `5c3514965f106dd165cc6474979ba302ef85d8c84935a0ad3ea5202ccedfe51b` |

## Why this file

Matroska (`.mkv`) and WebM (`.webm`) are EBML, and WebCodecs decodes but does not
demux — the browser has no way to find the frames in an EBML file. Hand-rolling
that demuxer is a much larger job than the ISO-BMFF parser in `../src/mp4.mjs`:
EBML variable-length integers, a nested element tree, lacing, and per-codec
`CodecPrivate` handling. `mediabunny` already does it, including codec delay and
seek pre-roll.

The *bundle* is what is vendored rather than the package's module tree: it is one
self-contained file with **no imports and no `require` calls**, which is the only
shape that works in a page with no bundler. It is fetched lazily — see the
dynamic import in `../src/matroska.mjs` — so a run that never touches an EBML file
never downloads its 692 KB (177 KB gzip).

MPL-2.0 is file-level copyleft: this file stays MPL-2.0 and its notices stay
intact, while the rest of the repo remains MIT. It is vendored unmodified; if it
ever needs patching, the patch belongs in a separate file rather than in this one.

## Updating it

```bash
V=1.61.5   # the version to move to
curl -sL "https://registry.npmjs.org/mediabunny/-/mediabunny-$V.tgz" -o mb.tgz
tar xzf mb.tgz
cp package/dist/bundles/mediabunny.min.mjs mediabunny.min.mjs
cp package/LICENSE LICENSE
sha256sum mediabunny.min.mjs   # update the hash above
```

Then re-run `node audio-decode/test/matroska.mjs`, which decodes a Matroska file
written by the same bundle and compares it against the input samples.
