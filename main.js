/**
 * Web page front end.
 *
 * Two independent features over the shared orchestration:
 *   common themes   audio that repeats across episodes
 *   general music   music inside a single episode
 *
 * The flow is deliberately gated: analyse, then VERIFY (audition the detected
 * clips), then export. Nothing touches disk before the export button — the page
 * says so explicitly, because "when did this write files?" should never be a
 * question.
 */

import {
  discoverAssets, libraryFor, foregroundMusicExemplar, musicRangesFor, extractClipWav, exampleRegion,
  renderCut, readTitleTag, outputExtensionFor,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  files: [],          // { id, file, status, progress, error }
  analyses: [],
  library: null,
  assets: [],         // all discovered
  shown: [],          // the top N actually displayed
  selected: new Set(),// indices into `shown` that the user wants removed
  previews: new Map(),// play key -> { url } | { loading: true }
  music: [],          // [{ id, segments, enabled:Set<index> }]
  musicSeed: null,    // 'clips' | 'foreground' — what the music stage calibrated on
  shares: null,       // stage weights for the progress meter, learned at runtime
  collapsed: new Set(),
  outDir: null,
};

const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

// Titles are read out of the file itself, so they are untrusted text: without
// this a stray < or & in a tag would break the row it is rendered into.
// The container is whatever came in, so the download needs the matching type.
const AUDIO_MIME = {
  m4a: 'audio/mp4', mp4: 'audio/mp4', flac: 'audio/flac', mp3: 'audio/mpeg',
  wav: 'audio/wav', aiff: 'audio/aiff', aif: 'audio/aiff',
};
const audioMime = (name) =>
  AUDIO_MIME[String(name).split('.').pop().toLowerCase()] ?? 'application/octet-stream';

const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hasWebCodecs = typeof globalThis.AudioDecoder === 'function';
const hasFS = typeof window.showDirectoryPicker === 'function';

// Only speak up when something is actually wrong. If WebCodecs is missing,
// decoding cannot work at all and the user needs to know why.
if (!hasWebCodecs) {
  $('capability').hidden = false;
  $('capability').textContent =
    'WebCodecs is not available here, so decoding will fail. Try Chrome, Edge or Safari 16.4+.';
}

/* --------------------------------------------------------- file input -- */

$('drop').onclick = () => $('files').click();
$('files').onchange = (e) => addFiles([...e.target.files]);

const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); };

function addFiles(files) {
  let added = 0;
  for (const f of files) {
    const id = (f.name.match(/S\d+E\d+/) || [f.name.replace(/\.[^.]+$/, '')])[0];
    if (state.files.some((x) => x.id === id)) continue;
    const entry = { id, file: f, status: 'queued', progress: 0, title: null };
    state.files.push(entry);
    added++;
    loadTitle(entry);
  }
  renderFiles();
  if (added) autoRun();
}

/**
 * Read the file's own title tag, in the background.
 *
 * Only the `moov` box is read — a few hundred KB rather than the whole episode —
 * so this neither blocks analysis nor holds a second copy of the audio. A file
 * with no tags simply keeps showing its id.
 */
async function loadTitle(entry) {
  try {
    const title = await readTitleTag(entry.file);
    if (title && entry.title !== title) {
      entry.title = title;
      renderFiles();
    }
  } catch { /* unreadable tags are not worth surfacing */ }
}

const statusLabel = (f) => (f.status === 'done' ? 'analysed'
  : f.status === 'running' ? `${((f.progress ?? 0) * 100).toFixed(0)}%`
  : f.status === 'error' ? `error: ${f.error}`
  : 'queued');

function fileRow(f) {
  return `<li data-id="${esc(f.id)}" data-tag="${esc(f.title ?? '')}">` +
    `${playButton(`ep:${f.id}`, 'Play this episode')}` +
    `<span class="id">${esc(f.id)}` +
    (f.title ? `<span class="tag">${esc(f.title)}</span>` : '') + `</span>` +
    `<span class="sz">${(f.file.size / 1e6).toFixed(1)} MB</span>` +
    `<span class="st ${f.status}">${esc(statusLabel(f))}</span>` +
    `<button class="x" type="button" data-id="${esc(f.id)}" ` +
    `title="Remove this file" aria-label="Remove ${esc(f.id)}">×</button></li>`;
}

function renderFiles() {
  const list = $('filelist');
  // Common clips are cross-episode by definition; with one file there is nothing
  // to match against, so say so rather than offering a control that cannot work.
  const enoughForClips = state.files.length >= 2;
  $('featThemes').disabled = !enoughForClips;
  $('featThemes').title = enoughForClips ? '' : 'Common clips need at least two files';
  // This used to rebuild the whole list on every progress message — roughly a
  // hundred times per episode. That would throw away the player sitting in a
  // row, stopping whatever the user was listening to while the analysis ran. The
  // structure only changes when the set of files does (or a title arrives from
  // the tag); the rest of the time only the status text moves.
  const ids = state.files.map((f) => f.id);
  const shown = [...list.children].map((li) => li.dataset.id);
  const sameSet = ids.length === shown.length && ids.every((id, i) => id === shown[i]);
  const sameTags = state.files.every((f, i) => list.children[i]?.dataset.tag === (f.title ?? ''));

  if (!sameSet || !sameTags) {
    stopPlayersIn(list);
    list.innerHTML = state.files.map(fileRow).join('');
    wirePlayButtons(list);
    for (const el of list.querySelectorAll('button.x')) {
      el.onclick = () => removeFile(el.dataset.id);
    }
  } else {
    state.files.forEach((f, i) => {
      const st = list.children[i].querySelector('.st');
      const label = statusLabel(f);
      if (st.textContent !== label) st.textContent = label;
      st.className = `st ${f.status}`;
    });
  }
  renderProgress();
}

/**
 * Overall analysis progress.
 *
 * Weighted by file SIZE rather than by file count: the work is proportional to
 * duration, and these are same-codec files, so size is a good proxy — a plain
 * mean would let a short file finish and jump the bar by a whole 1/N. Errors
 * count as complete so the bar can still reach the end.
 */
function renderProgress() {
  const files = state.files;
  const el = $('progress');
  el.hidden = !files.some((f) => f.status === 'queued' || f.status === 'running');
  if (el.hidden) return;

  const total = files.reduce((s, f) => s + f.file.size, 0) || 1;
  const done = files.reduce((s, f) =>
    s + f.file.size * ((f.status === 'done' || f.status === 'error') ? 1 : (f.progress ?? 0)), 0);
  $('progressBar').style.width = `${((done / total) * 100).toFixed(1)}%`;
}

/**
 * Drop a file and everything derived from it.
 *
 * Discovery is cross-episode, so removing one file invalidates every result, not
 * just that file's — the theme's support count, its per-episode positions and
 * therefore the music calibration all shift. Re-running is the only honest
 * option, and it costs nothing because phase 1 is already in memory.
 */
function removeFile(id) {
  state.files = state.files.filter((f) => f.id !== id);
  state.analyses = state.analyses.filter((a) => a.id !== id);
  clearPreviews();
  renderFiles();
  if (!state.files.length) { resetResults(); return; }
  autoRun();
}

/** Nothing left to describe: clear the results rather than leave stale ones up. */
function resetResults() {
  state.library = null;
  state.assets = [];
  state.shown = [];
  state.selected = new Set();
  state.music = [];
  setStatus('');
  $('verify').hidden = true;
  $('done').hidden = true;
  // everything is about to be detached, and a detached <audio> keeps sounding
  stopAudition();
  $('clips').innerHTML = '';
  $('matrix').innerHTML = '';
  $('music').innerHTML = '';
  $('results').querySelector('tbody').innerHTML = '';
  $('summary').textContent = '';
}

const pendingFiles = () => state.files.filter((f) => f.status === 'queued' || f.status === 'error');

let running = false;
let rerun = false;

/**
 * Everything happens without a button: adding files analyses them, and changing
 * a setting re-runs detection. Phase 1 is skipped when nothing is pending, so
 * toggling a feature after the fact costs nothing — the analyses are already in
 * memory.
 *
 * Serialised: dropping more files mid-run just sets `rerun`, so two runs can
 * never interleave and corrupt `state.analyses`.
 */
async function autoRun() {
  if (running) { rerun = true; return; }
  running = true;
  try {
    do {
      rerun = false;
      if (pendingFiles().length) {
        setStatus(`Analysing ${pendingFiles().length} file(s)…`);
        await analyzePool();
      }
      if (state.analyses.length) await runDetection();
    } while (rerun);
  } catch (err) {
    setStatus(`Failed: ${err.message}`, true);
  } finally {
    running = false;
  }
}

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text ?? '';
  el.hidden = !text;
  el.classList.toggle('error', isError);
}

/* ------------------------------------------------------- worker pool -- */

/**
 * Learn how the analysis time actually divides, from a file that just finished.
 *
 * The decode share is nothing like the same across backends: WebCodecs hands
 * back one frame at a time on another thread while the ffmpeg fallback spawns a
 * process, and the JS resampling sits in between. Hardcoding the figure measured
 * on one of them made the meter crawl through the first stage on the other. Each
 * finished file reports its own per-stage times; the next workers get weighted by
 * those instead.
 */
function learnShares(timings) {
  if (!timings) return;
  const stages = ['decode', 'chroma', 'fingerprints', 'features'];
  const total = stages.reduce((s, k) => s + (timings[k] > 0 ? timings[k] : 0), 0);
  if (!(total > 0)) return;                 // nothing measured: keep what we have
  const next = {};
  for (const k of stages) next[k] = (timings[k] > 0 ? timings[k] : 0) / total;
  state.shares = next;
}

// How many episodes to analyse at once. Cores bound it because the work is
// CPU-bound; memory bounds it because each worker holds a whole episode — its
// decoded mono PCM (~42 MB for 22 minutes), the source bytes (~16 MB) and the
// feature pass. The previous fixed cap of 4 was unexplained and left half of an
// 8- or 10-core machine idle.
const WORKER_CEILING = 8;      // past this the main thread starts competing
const PER_WORKER_MB = 300;     // working estimate, not the live set

function workerLimit(pending) {
  const cores = navigator.hardwareConcurrency || 4;
  // deviceMemory is coarse, Chrome-only and capped at 8 GiB. Where it is absent
  // the budget is unbounded and cores alone decide.
  const gb = navigator.deviceMemory;
  const byMemory = gb ? Math.max(1, Math.floor((gb * 1024 * 0.4) / PER_WORKER_MB)) : Infinity;
  return Math.max(1, Math.min(cores, byMemory, WORKER_CEILING, pending));
}

async function analyzePool() {
  const pending = pendingFiles();
  const limit = workerLimit(pending.length);
  // stale results for the same ids would corrupt discovery
  state.analyses = state.analyses.filter((a) => !pending.some((f) => f.id === a.id));
  let next = 0;

  function analyzeInWorker(entry) {
    entry.status = 'running';
    renderFiles();
    return new Promise((resolve) => {
      const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
      const finish = (result) => { worker.terminate(); renderFiles(); resolve(result); };
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') { entry.progress = m.progress ?? 0; renderFiles(); }
        else if (m.type === 'done') {
          entry.status = 'done'; entry.progress = 1;
          learnShares(m.analysis?.timings);
          finish(m.analysis);
        }
        else if (m.type === 'error') { entry.status = 'error'; entry.error = m.message; finish(null); }
      };
      worker.onerror = (err) => {
        entry.status = 'error';
        entry.error = err.message ?? 'worker failed';
        finish(null);
      };
      worker.postMessage({ id: entry.id, source: entry.file, shares: state.shares ?? undefined });
    });
  }

  const results = [];
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < pending.length) {
      const p = pending[next++];
      // removed while it sat in the queue: do not spend a decode on it
      if (!state.files.includes(p)) continue;
      const a = await analyzeInWorker(p);
      if (a) results.push(a);
    }
  }));
  // nor let a file removed MID-decode leave its analysis behind, where it would
  // go on contributing to discovery
  state.analyses.push(...results.filter((a) => state.files.some((f) => f.id === a.id)));
  return results.length;
}

/* ------------------------------------------------------------ analyse -- */

async function runDetection() {
  const wantThemes = $('featThemes').checked;
  const topN = Math.max(1, Math.min(20, Number($('topN').value) || 5));

  if (!wantThemes && !$('featMusic').checked) {
    $('verify').hidden = true;
    setStatus('Nothing selected — enable a feature to find music.');
    return;
  }
  setStatus('Finding music…');

  // Common clips are audio that repeats ACROSS episodes, so one file cannot
  // produce any by definition; discovery is skipped rather than run to return
  // nothing. General music is per-episode and runs either way — falling back to
  // the end credits for an exemplar when there is no theme to calibrate on.
  const canDiscover = state.analyses.length >= 2;
  const { library, assets } = canDiscover
    ? discoverAssets(state.analyses, {})
    : { library: libraryFor(state.analyses), assets: [] };
  state.library = library;
  state.assets = assets;
  state.shown = wantThemes ? assets.slice(0, topN) : [];
  state.selected = new Set(state.shown.map((_, i) => i));
  // theme: and music: keys name a *position* in the result, so re-detection can
  // point them at different audio; their previews must not outlive the run that
  // produced them. Episodes are the file itself and stay playable throughout.
  clearPreviews((key) => key.startsWith('ep:'));

  renderClips();
  renderMatrix();
  computeMusic();
  renderMusic();
  $('verify').hidden = false;
  $('done').hidden = true;

  const failed = state.files.filter((f) => f.status === 'error').length;
  const bits = [`${state.analyses.length} file(s) analysed`];
  if (wantThemes && canDiscover) bits.push(`${state.shown.length} clip(s) found`);
  else if (wantThemes) bits.push('common clips need two files or more');
  if (failed) bits.push(`${failed} failed`);
  setStatus(bits.join(' · '));
}

/* --------------------------------------------------------- clip list -- */

function renderClips() {
  const wantThemes = $('featThemes').checked;
  document.querySelector('#verify h2').hidden = !wantThemes;
  $('clips').hidden = !wantThemes;
  document.querySelector('#verify h3').hidden = !wantThemes;
  document.querySelector('.scroll').hidden = !wantThemes;
  if (!wantThemes) return;

  if (!state.shown.length) {
    stopPlayersIn($('clips'));
    $('clips').innerHTML = state.analyses.length < 2
      ? '<li class="empty">Common clips are audio that repeats across episodes, so this needs at ' +
        'least two files. General music still runs, below.</li>'
      : '<li class="empty">No recurring audio found across these files.</li>';
    return;
  }

  stopPlayersIn($('clips'));
  $('clips').innerHTML = state.shown.map((a, i) => {
    const conf = typeof a.meanSim === 'number' ? a.meanSim : null;
    const weak = conf !== null && conf < 0.9;
    const region = exampleRegion(a);
    const example = region ? `${region.id} @ ${fmtTime(region.start)}` : 'no example';
    return `<li>
      <input type="checkbox" class="pick" data-i="${i}" ${state.selected.has(i) ? 'checked' : ''}>
      ${playButton(`theme:${i}`, 'Play an example')}
      <span class="kind">${a.kind}</span>
      <span class="meta">
        ${a.span.toFixed(1)}s &middot;
        in ${a.support}/${a.totalEpisodes ?? state.analyses.length} files &middot;
        ${conf !== null ? `confidence <span class="${weak ? 'weak' : ''}">${conf.toFixed(3)}</span>` : ''}
        &middot; example: ${example}
      </span>
    </li>`;
  }).join('');

  $('clips').querySelectorAll('.pick').forEach((el) => {
    el.onchange = () => {
      const i = Number(el.dataset.i);
      if (el.checked) state.selected.add(i); else state.selected.delete(i);
      renderMatrix();
      // the ticked clips are the calibration exemplars, so the proposed
      // segments change with them
      computeMusic();
      renderMusic();
    };
  });
  wirePlayButtons($('clips'));
}

/* -------------------------------------------------------- auditioning -- */

/*
 * One player for every sound on the page: a recurring clip, a proposed music
 * cut, a whole episode. Each playable thing is named by a string key
 * ("theme:0", "music:S01E01:3", "ep:S01E01") that resolves either to a byte
 * range to decode, or to the original file, which the browser streams itself.
 *
 * Each thing gets its own <audio controls> — the platform's transport, for free.
 * Until something is played it shows a ▶ button instead, and the first click
 * prepares the audio and swaps the real player in where the button was. That
 * matters because preparing means decoding: doing it for every row up front
 * would decode the whole season to WAV before the user hears anything. This way
 * the page only ever holds players for what has actually been auditioned.
 *
 * Which only works because the render functions stopped rebuilding their lists
 * for state that is already represented in the DOM. `renderMusic` used to be
 * called on every segment tick, episode tick and collapse, and `renderFiles` on
 * every progress message; either would have destroyed a player mid-listen. They
 * now update the rows they have.
 */

const PLAY_TITLE = 'Play';
let audition = { key: null };          // the key currently loaded, for highlighting

/** Resolve a play key to the audio it names, or null if that audio is gone. */
function sourceFor(key) {
  const [kind, a, b] = key.split(':');
  const entryFor = (id) => state.files.find((f) => f.id === id);

  if (kind === 'theme') {
    const asset = state.shown[Number(a)];
    const region = asset && exampleRegion(asset);
    const found = region && entryFor(region.id);
    return found ? { file: found.file, start: region.start, end: region.end } : null;
  }

  const entry = entryFor(a);
  if (!entry) return null;

  if (kind === 'ep') {
    // hand the original file straight to the browser: nothing to decode, and no
    // second copy of a 20-minute episode in memory
    return { file: entry.file, direct: true };
  }
  if (kind === 'music') {
    const seg = state.music.find((x) => x.id === a)?.segments[Number(b)];
    return seg ? { file: entry.file, start: seg.start, end: seg.end } : null;
  }
  return null;
}

/** Prepare a key's audio, returning a blob URL — from cache when we have it. */
async function urlFor(key) {
  const cached = state.previews.get(key);
  if (cached?.url) return cached.url;
  const src = sourceFor(key);
  if (!src) throw new Error('that audio is no longer available');

  const url = src.direct
    ? URL.createObjectURL(src.file)
    : URL.createObjectURL((await extractClipWav(src.file, src.start, src.end, { decode: {} })).blob);
  state.previews.set(key, { url });
  return url;
}

/**
 * Markup for one playable thing: the real player if its audio is ready, and a
 * ▶ button to prepare it if not.
 */
function playButton(key, title = PLAY_TITLE) {
  const url = state.previews.get(key)?.url;
  if (!url) {
    return `<button class="play" type="button" data-key="${key}" ` +
      `data-title="${title}" title="${title}">▶</button>`;
  }
  return `<audio class="clip" controls preload="metadata" data-key="${key}" ` +
    `src="${esc(url)}" title="${esc(title)}"></audio>`;
}

/** Every play control on the page is wired the same way. */
function wirePlayButtons(root) {
  for (const el of root.querySelectorAll('button.play')) {
    el.onclick = () => playKey(el.dataset.key, el);
  }
}

// Highlight whichever row is loaded. Re-queried rather than captured, because
// the render functions rebuild these rows underneath us.
function setPlayIcon(key, playing) {
  for (const el of document.querySelectorAll('[data-key]')) {
    el.classList.toggle('playing', playing && el.dataset.key === key);
  }
}

// Replace a ▶ button with the player it stands for. Done by hand rather than by
// re-rendering the list, so nothing else in it is touched.
function mountPlayer(button, key, title, url) {
  const audio = document.createElement('audio');
  audio.className = 'clip';
  audio.controls = true;
  audio.preload = 'metadata';
  audio.dataset.key = key;
  audio.title = title;
  audio.src = url;
  button.replaceWith(audio);
  return audio;
}

/**
 * Only one thing sounds at a time.
 *
 * Capture phase because media events do not bubble: this is the one listener
 * that sees every `play` in the document, wherever the player sits.
 */
document.addEventListener('play', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLAudioElement) || !el.classList.contains('clip')) return;
  for (const other of document.querySelectorAll('audio.clip')) {
    if (other !== el && !other.paused) other.pause();
  }
  setPlayIcon(el.dataset.key, true);
  audition = { key: el.dataset.key };
}, true);

document.addEventListener('ended', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLAudioElement) || !el.classList.contains('clip')) return;
  if (audition.key === el.dataset.key) audition = { key: null };
  setPlayIcon(el.dataset.key, false);
}, true);

// Stop everything that is sounding. Anything that invalidates a preview funnels
// through here, so no element is left holding a URL that has been revoked.
function stopAudition() {
  for (const el of document.querySelectorAll('audio.clip')) {
    el.pause();
    el.currentTime = 0;
  }
  audition = { key: null };
  setPlayIcon(null, false);
}

// Drop prepared previews, releasing their blob URLs. `keep` decides which keys
// survive; by default none do.
function clearPreviews(keep = () => false) {
  for (const [key, entry] of state.previews) {
    if (keep(key)) continue;
    if (entry.url) URL.revokeObjectURL(entry.url);
    state.previews.delete(key);
  }
  // A player whose URL was just revoked has to go back to being a button;
  // leaving the dead source in it would look playable and do nothing. Detaching
  // an <audio> does not stop it, so it is silenced first — otherwise it would
  // keep sounding from a buffer whose URL no longer exists.
  for (const el of document.querySelectorAll('audio.clip')) {
    if (state.previews.has(el.dataset.key)) continue;
    el.pause();
    el.removeAttribute('src');
    el.load();
    el.replaceWith(playButtonEl(el.dataset.key, el.title));
  }
}

/** Silence and unload the players inside a subtree that is about to be rebuilt. */
function stopPlayersIn(root) {
  for (const el of root.querySelectorAll('audio.clip')) {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }
}

/** A ▶ button element for `key`, as a node. */
function playButtonEl(key, title = PLAY_TITLE) {
  const b = document.createElement('button');
  b.className = 'play';
  b.type = 'button';
  b.dataset.key = key;
  b.dataset.title = title;
  b.title = title;
  b.textContent = '▶';
  b.onclick = () => playKey(key, b);
  return b;
}

async function playKey(key, button) {
  if (state.previews.get(key)?.loading) return;

  let url = state.previews.get(key)?.url;
  if (!url) {
    state.previews.set(key, { loading: true });
    const title = button.dataset.title || PLAY_TITLE;
    button.textContent = '…';
    button.disabled = true;
    try {
      url = await urlFor(key);
    } catch (err) {
      state.previews.delete(key);
      button.disabled = false;
      button.textContent = '▶';
      button.title = `Could not load: ${err.message}`;
      return;
    }
    // The list may have been rebuilt while that decoded, so re-find the button
    // by key instead of trusting the element that was clicked.
    const target = document.querySelector(`button.play[data-key="${key}"]`) || button;
    const audio = mountPlayer(target, key, title, url);
    try {
      await audio.play();
    } catch (err) {
      audio.title = `Could not play: ${err.message}`;
    }
    return;
  }

  // Defensive: a prepared key renders as a player rather than a button, so this
  // is not normally reachable. It exists so that a stray button for audio we
  // already have still plays instead of doing nothing.
  const cached = document.querySelector(`audio.clip[data-key="${key}"]`);
  if (cached) {
    cached.currentTime = 0;              // replay from the top
    try { await cached.play(); } catch { /* the control reports its own errors */ }
  }
}

/* ----------------------------------------------------------- matrix -- */

function renderMatrix() {
  const files = state.analyses.map((a) => a.id);
  const shown = state.shown;
  if (!shown.length) { $('matrix').innerHTML = ''; return; }

  const head = `<thead><tr><th>file</th>${
    shown.map((a, i) => `<th class="${state.selected.has(i) ? '' : 'off'}">clip ${i + 1}<br><small>${a.span.toFixed(0)}s</small></th>`).join('')
  }</tr></thead>`;

  const body = files.map((id) => {
    const cells = shown.map((a, i) => {
      const e = a.episodes.find((x) => x.id === id);
      const present = e && e.present !== false && e.start != null;
      const off = state.selected.has(i) ? '' : ' off';
      if (!present) return `<td class="no${off}">·</td>`;
      // The range, not a tick: presence is what the range means, and where the
      // cut lands is the thing that actually needs checking per episode.
      return `<td class="yes${off}" title="${(e.end - e.start).toFixed(1)}s">` +
             `${fmtTime(e.start)} – ${fmtTime(e.end)}</td>`;
    }).join('');
    return `<tr><th>${id}</th>${cells}</tr>`;
  }).join('');

  $('matrix').innerHTML = head + `<tbody>${body}</tbody>`;
}

/* ------------------------------------------------------ general music -- */

/**
 * Assets used to calibrate general-music detection: the ticked clips if any,
 * otherwise the most prevalent ones found. Without a music exemplar the
 * discriminant has nothing to learn from, so this never returns empty while any
 * asset exists.
 */
function calibrationExemplars() {
  const picked = [...state.selected].map((i) => state.shown[i]).filter(Boolean);
  if (picked.length) return picked;
  return state.assets.slice(0, 3);
}

/**
 * Audio the theme stage will cut, per episode, taken from the clips the user has
 * ticked — the same set the export builds its cut ranges from. Music detection
 * is calibrated on exactly those clips, so it reliably re-finds the theme in
 * every episode; without this the same seconds would be listed and cut twice.
 *
 * Unticked clips are absent by design: nothing is being removed for them, so
 * there is no duplicate to avoid.
 */
function themeRanges() {
  const out = new Map();
  for (const i of state.selected) {
    const asset = state.shown[i];
    if (!asset) continue;
    for (const e of asset.episodes) {
      if (e.present === false || e.start == null) continue;
      if (!out.has(e.id)) out.set(e.id, []);
      out.get(e.id).push([e.start, e.end]);
    }
  }
  return out;
}

// Settings re-run detection. Phase 1 is skipped when nothing is pending, so this
// costs nothing — the analyses are already in memory.
$('featThemes').onchange = () => autoRun();
$('featMusic').onchange = () => autoRun();
$('topN').onchange = () => autoRun();

/**
 * Propose per-episode music segments. Everything is enabled by default — the
 * user unticks what they want to keep, rather than hunting for what to remove.
 */
function computeMusic() {
  if (!$('featMusic').checked) { state.music = []; return; }
  // Calibrate on the clips being removed when there are any; otherwise fall back
  // to the most foreground-music-like passage each episode has, so this stage
  // runs on a single file too.
  const clips = calibrationExemplars();
  const exemplar = clips.length ? clips : foregroundMusicExemplar(state.analyses);
  state.musicSeed = clips.length ? 'clips' : 'foreground';
  if (!exemplar.length) { state.music = []; return; }
  state.music = musicRangesFor(state.library, exemplar, { exclude: themeRanges() }).map((r) => ({
    id: r.id,
    segments: r.segments,
    enabled: new Set(r.segments.map((_, i) => i)),
    error: r.error,
    separation: r.separation,
  }));
}

/** Seconds this episode will actually have removed. */
function episodeSeconds(ep) {
  return ep.segments.reduce((n, s, i) => n + (ep.enabled.has(i) ? s.duration : 0), 0);
}

/**
 * Refresh one episode's summary row in place.
 *
 * Ticking one segment moves only that episode's tick and its seconds, so
 * rebuilding the table for it — which is what used to happen — was both wasteful
 * and destructive: it removed every player in the table, so deciding about a
 * segment stopped the one you were listening to.
 */
function updateEpisodeRow(id) {
  const ep = state.music.find((x) => x.id === id);
  const row = document.querySelector(`#music tr.ep[data-id="${id}"]`);
  if (!ep || !row) return;
  const total = ep.segments.length;
  const pick = row.querySelector('.epPick');
  if (pick) {
    pick.checked = total > 0 && ep.enabled.size === total;
    pick.disabled = total === 0;
  }
  const secs = row.querySelector('.removing');
  if (secs) secs.textContent = total ? `${episodeSeconds(ep).toFixed(0)}s` : '—';
}

function renderMusic() {
  const note = $('musicNote');
  const el = $('music');

  if (!$('featMusic').checked) {
    note.textContent = 'General music removal is off.';
    stopPlayersIn(el);
    el.innerHTML = '';
    return;
  }
  const ex = calibrationExemplars();
  const picked = [...state.selected].length > 0;
  if (state.musicSeed === 'foreground') {
    note.textContent =
      'No common clip to calibrate on, so this is calibrated on the most music-like passage in each ' +
      'episode — the loudest stretch that is not speech-modulated. That is a weaker example than a ' +
      'detected theme, so expect to untick some.';
  } else {
    note.textContent = ex.length
      ? `Calibrated on ${ex.length} ${picked ? 'selected' : 'detected'} clip${ex.length > 1 ? 's' : ''}. ` +
        'Untick anything you want to keep. This stage is assistive — it runs close to its decision ' +
        'boundary, so some segments may be wrong.'
      : 'General music needs at least one music example to calibrate on, and none was found.';
  }

  if (!state.music.length) { stopPlayersIn(el); el.innerHTML = ''; return; }

  const head = '<thead><tr><th class="pick"></th><th>episode</th><th>segments</th><th>removing</th></tr></thead>';
  let rows = '';

  for (const ep of state.music) {
    const total = ep.segments.length;
    const collapsed = state.collapsed.has(ep.id);

    rows += `<tr class="ep${total ? '' : ' empty'}" data-id="${ep.id}">` +
      `<td class="pick"><input type="checkbox" class="epPick" data-id="${ep.id}" ` +
        `${total && ep.enabled.size === total ? 'checked' : ''} ${total ? '' : 'disabled'}></td>` +
      `<td><button class="twisty" data-id="${ep.id}" ${total ? '' : 'disabled'}>` +
        `${total ? (collapsed ? '▸' : '▾') : '·'}</button>${ep.id}</td>` +
      `<td>${total || (ep.error ? 'failed' : 'none')}</td>` +
      `<td class="removing">${total ? `${episodeSeconds(ep).toFixed(0)}s` : '—'}</td></tr>`;

    // Every segment row is always rendered; collapsing hides them with a class
    // rather than dropping them, so a player inside one is never destroyed by
    // the twisty.
    ep.segments.forEach((s, i) => {
      rows += `<tr class="seg${collapsed ? ' hidden' : ''}" data-id="${ep.id}" data-i="${i}"><td class="pick">` +
        `<input type="checkbox" class="segPick" data-id="${ep.id}" data-i="${i}" ` +
        `${ep.enabled.has(i) ? 'checked' : ''}></td>` +
        `<td colspan="3"><span class="segno" ` +
        `title="segment ${i + 1} of ${total} in ${ep.id}">#${i + 1}</span> ` +
        `${playButton(`music:${ep.id}:${i}`, 'Play this segment')}` +
        ` ${fmtTime(s.start)} – ${fmtTime(s.end)}` +
        ` <span class="dim">&middot; ${s.duration.toFixed(1)}s</span></td></tr>`;
    });
  }

  stopPlayersIn(el);
  el.innerHTML = head + `<tbody>${rows}</tbody>`;
  wirePlayButtons(el);

  el.querySelectorAll('.segPick').forEach((box) => {
    box.onchange = () => {
      const ep = state.music.find((x) => x.id === box.dataset.id);
      const i = Number(box.dataset.i);
      if (box.checked) ep.enabled.add(i); else ep.enabled.delete(i);
      updateEpisodeRow(ep.id);
    };
  });
  el.querySelectorAll('.epPick').forEach((box) => {
    box.onchange = () => {
      const ep = state.music.find((x) => x.id === box.dataset.id);
      ep.enabled = box.checked ? new Set(ep.segments.map((_, i) => i)) : new Set();
      for (const seg of el.querySelectorAll(`.segPick[data-id="${box.dataset.id}"]`)) {
        seg.checked = box.checked;
      }
      updateEpisodeRow(ep.id);
    };
  });
  el.querySelectorAll('.twisty').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.id;
      const nowCollapsed = !state.collapsed.has(id);
      if (nowCollapsed) state.collapsed.add(id); else state.collapsed.delete(id);
      b.textContent = nowCollapsed ? '▸' : '▾';
      for (const row of el.querySelectorAll(`tr.seg[data-id="${id}"]`)) {
        row.classList.toggle('hidden', nowCollapsed);
      }
    };
  });
}

// The export button's ellipsis already implies a picker where one exists. The
// hint is worth showing only when files will download instead, which is worth
// warning about — browsers routinely block a burst of downloads.
if (!hasFS) $('exportHint').textContent = 'Files will download individually.';

/**
 * Ask once, before anything is written, about destination files that already
 * exist. Returns false if the user cancels.
 *
 * One prompt covering every clash rather than one per file: replacing is a
 * single decision about the whole export, and a folder with a full season in it
 * would otherwise mean 19 dialogs.
 *
 * Only meaningful where a real directory was chosen. The download fallback
 * cannot see the destination at all — the browser handles naming there.
 */
async function confirmReplacements(dir, names) {
  const clashes = [];
  for (const name of names) {
    try {
      await dir.getFileHandle(name);
      clashes.push(name);
    } catch (err) {
      if (err.name !== 'NotFoundError') throw err;   // absent is the good case
    }
  }
  if (!clashes.length) return true;

  const shown = clashes.slice(0, 20);
  const more = clashes.length - shown.length;
  return confirm(
    `${clashes.length} file${clashes.length === 1 ? '' : 's'} already in that folder ` +
    `will be replaced:\n\n${shown.join('\n')}${more > 0 ? `\n…and ${more} more` : ''}\n\n` +
    'Replace them?');
}

$('export').onclick = async () => {
  const wantThemes = $('featThemes').checked;
  const wantMusic = $('featMusic').checked;

  $('export').disabled = true;
  $('export').textContent = 'Working…';

  try {
    // gather ranges per file
    const perFile = new Map();
    const add = (id, a, b) => {
      if (!perFile.has(id)) perFile.set(id, []);
      perFile.get(id).push([a, b]);
    };
    if (wantThemes) {
      for (const [id, ranges] of themeRanges()) for (const [a, b] of ranges) add(id, a, b);
    }
    if (wantMusic) {
      // Only ENABLED segments are cut — an unticked segment is kept, even though
      // the calibration may still have used unselected assets as exemplars.
      for (const ep of state.music) {
        for (const i of ep.enabled) {
          const s = ep.segments[i];
          if (s) add(ep.id, s.start, s.end);
        }
      }
    }

    if (!perFile.size) {
      $('summary').textContent = 'Nothing to remove — no clips selected and no general music to cut.';
      $('done').hidden = false;
      return;
    }

    let outDir = null;
    if (hasFS) {
      try { outDir = await window.showDirectoryPicker({ mode: 'readwrite' }); }
      catch { return; }        // cancelled picker; the finally restores the button
    }

    // Plan first. The overwrite check has to run before anything is written, or
    // cancelling would leave a half-exported folder behind.
    const plan = [];
    for (const [id, ranges] of perFile) {
      const entry = state.files.find((f) => f.id === id);
      if (!entry || !ranges.length) continue;
      // Keep the input's stem but not its extension. An MP4 that held video
      // comes back as audio-only, so it is an .m4a now, and a .mov never was
      // right. The stem is what lines input and output up; the extension says
      // what the file actually is.
      const head = new Uint8Array(await entry.file.slice(0, 16).arrayBuffer());
      plan.push({
        entry, ranges,
        name: `${String(entry.file.name).replace(/\.[^./\\]+$/, '')}.${outputExtensionFor(head)}`,
      });
    }

    if (outDir && !await confirmReplacements(outDir, plan.map((p) => p.name))) return;

    const tb = $('results').querySelector('tbody');
    tb.innerHTML = '';
    let written = 0, totalRemoved = 0;

    for (const { entry, ranges, name } of plan) {
      const bytes = new Uint8Array(await entry.file.arrayBuffer());
      const { bytes: out, info } = renderCut(bytes, ranges, { mode: 'remove' });
      totalRemoved += info.removedSeconds;

      let where;
      if (outDir) {
        const h = await outDir.getFileHandle(name, { create: true });
        const w = await h.createWritable();
        await w.write(out);
        await w.close();
        where = name;
      } else {
        const url = URL.createObjectURL(new Blob([out], { type: audioMime(name) }));
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        where = 'downloaded';
      }
      written++;
      tb.insertAdjacentHTML('beforeend',
        `<tr><td>${entry.id}</td><td>${ranges.length}</td>` +
        `<td>${info.removedSeconds.toFixed(0)}s</td>` +
        `<td>${info.outputSeconds.toFixed(0)}s</td><td>${where}</td></tr>`);
    }

    $('summary').textContent =
      `${written} file(s) written, ${totalRemoved.toFixed(0)}s of music removed.`;
    $('done').hidden = false;
    $('done').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    $('summary').textContent = `Export failed: ${err.message}`;
    $('done').hidden = false;
  } finally {
    $('export').disabled = false;
    $('export').textContent = 'Export…';
  }
};
