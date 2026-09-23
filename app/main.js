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
  discoverAssets, musicRangesFor, extractClipWav, exampleRegion, renderCut, readTitleTag,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  files: [],          // { id, file, status, progress, error }
  analyses: [],
  library: null,
  assets: [],         // all discovered
  shown: [],          // the top N actually displayed
  selected: new Set(),// indices into `shown` that the user wants removed
  previews: new Map(),// play key -> { url, audio } | { loading: true }
  music: [],          // [{ id, segments, enabled:Set<index> }]
  collapsed: new Set(),
  outDir: null,
};

const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

// Titles are read out of the file itself, so they are untrusted text: without
// this a stray < or & in a tag would break the row it is rendered into.
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

function renderFiles() {
  $('filelist').innerHTML = state.files.map((f) => {
    const label = f.status === 'done' ? 'analysed'
      : f.status === 'running' ? `${((f.progress ?? 0) * 100).toFixed(0)}%`
      : f.status === 'error' ? `error: ${f.error}`
      : 'queued';
    return `<li>${playButton(`ep:${f.id}`, 'Play this episode')}` +
           `<span class="id">${esc(f.id)}` +
           (f.title ? `<span class="tag">${esc(f.title)}</span>` : '') + `</span>` +
           `<span class="sz">${(f.file.size / 1e6).toFixed(1)} MB</span>` +
           `<span class="st ${f.status}">${esc(label)}</span>` +
           `<button class="x" type="button" data-id="${esc(f.id)}" ` +
           `title="Remove this file" aria-label="Remove ${esc(f.id)}">×</button></li>`;
  }).join('');
  wirePlayButtons($('filelist'));
  for (const el of $('filelist').querySelectorAll('button.x')) {
    el.onclick = () => removeFile(el.dataset.id);
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
        else if (m.type === 'done') { entry.status = 'done'; entry.progress = 1; finish(m.analysis); }
        else if (m.type === 'error') { entry.status = 'error'; entry.error = m.message; finish(null); }
      };
      worker.onerror = (err) => {
        entry.status = 'error';
        entry.error = err.message ?? 'worker failed';
        finish(null);
      };
      worker.postMessage({ id: entry.id, source: entry.file });
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

  // discovery always runs: even with themes off, general music needs a music
  // exemplar to calibrate its discriminant on.
  const { library, assets } = discoverAssets(state.analyses, {});
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
  if (wantThemes) bits.push(`${state.shown.length} clip(s) found`);
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
    $('clips').innerHTML = '<li class="empty">No recurring audio found across these files.</li>';
    return;
  }

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
 * Only one thing sounds at a time, and every way playback can stop routes
 * through stopAudition(), so no button can be left showing a pause icon for
 * audio that is not playing.
 */

const PLAY_TITLE = 'Play';
let audition = { key: null, audio: null };

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

/** Prepare the audio behind `key`: decode a range, or open the whole file. */
async function loadAudio(key) {
  const src = sourceFor(key);
  if (!src) throw new Error('that audio is no longer available');

  const url = src.direct
    ? URL.createObjectURL(src.file)
    : URL.createObjectURL((await extractClipWav(src.file, src.start, src.end, { decode: {} })).blob);
  return { url, audio: new Audio(url) };
}

/** Markup for a play button. Reads the live player state, so a list re-rendered
 *  part-way through playback still shows the pause icon. */
function playButton(key, title = PLAY_TITLE) {
  const on = audition.key === key;
  return `<button class="play${on ? ' playing' : ''}" type="button" data-key="${key}" ` +
    `data-title="${title}" title="${on ? 'Stop' : title}">${on ? '⏹' : '▶'}</button>`;
}

/** Every play button on the page is wired the same way. */
function wirePlayButtons(root) {
  for (const el of root.querySelectorAll('button.play')) {
    el.onclick = () => playKey(el.dataset.key, el);
  }
}

// Flip every button for `key` to the right icon. Re-queried rather than
// captured, because the render functions rebuild these buttons underneath us.
function setPlayIcon(key, playing) {
  for (const el of document.querySelectorAll('button.play')) {
    if (el.dataset.key !== key) continue;
    el.textContent = playing ? '⏹' : '▶';
    el.title = playing ? 'Stop' : (el.dataset.title || PLAY_TITLE);
    el.classList.toggle('playing', playing);
  }
}

// Stop whatever is sounding. Every stop funnels through here — second click,
// another clip, a re-render, the audio ending — so the pause icon can never be
// stranded on a button.
function stopAudition() {
  if (!audition.key) return;
  const { key, audio } = audition;
  audition = { key: null, audio: null };
  if (audio) {
    audio.pause();
    audio.currentTime = 0;   // so the next click starts it over
  }
  setPlayIcon(key, false);
}

// Drop prepared previews, releasing their blob URLs. `keep` decides which keys
// survive; by default none do.
function clearPreviews(keep = () => false) {
  if (audition.key && !keep(audition.key)) stopAudition();
  for (const [key, entry] of state.previews) {
    if (keep(key)) continue;
    if (entry.url) URL.revokeObjectURL(entry.url);
    state.previews.delete(key);
  }
}

async function playKey(key, button) {
  if (audition.key && audition.key !== key) stopAudition();
  const cached = state.previews.get(key);

  // already prepared: this click is a plain play/pause toggle
  if (cached?.audio) {
    if (!cached.audio.paused) { stopAudition(); return; }
    audition = { key, audio: cached.audio };
    setPlayIcon(key, true);
    try {
      await cached.audio.play();
    } catch (err) {
      stopAudition();
      button.title = `Could not play: ${err.message}`;
    }
    return;
  }
  if (cached?.loading) return;

  state.previews.set(key, { loading: true });
  button.textContent = '…';
  button.disabled = true;
  let loaded = null;
  try {
    loaded = await loadAudio(key);
    // reaching the end is the one stop we do not initiate ourselves
    loaded.audio.onended = () => { if (audition.key === key) stopAudition(); };
    state.previews.set(key, loaded);
    audition = { key, audio: loaded.audio };
    setPlayIcon(key, true);
    await loaded.audio.play();
  } catch (err) {
    if (audition.key === key) audition = { key: null, audio: null };
    if (loaded) { loaded.audio.pause(); URL.revokeObjectURL(loaded.url); }
    state.previews.delete(key);
    button.textContent = '!';
    button.title = `Could not play: ${err.message}`;
    setTimeout(() => { if (audition.key !== key) setPlayIcon(key, false); }, 1500);
  } finally {
    button.disabled = false;
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
  const ex = calibrationExemplars();
  if (!ex.length) { state.music = []; return; }
  state.music = musicRangesFor(state.library, ex, { exclude: themeRanges() }).map((r) => ({
    id: r.id,
    segments: r.segments,
    enabled: new Set(r.segments.map((_, i) => i)),
    error: r.error,
  }));
}

function renderMusic() {
  const note = $('musicNote');
  const el = $('music');

  if (!$('featMusic').checked) {
    note.textContent = 'General music removal is off.';
    el.innerHTML = '';
    return;
  }
  const ex = calibrationExemplars();
  const picked = [...state.selected].length > 0;
  note.textContent = ex.length
    ? `Calibrated on ${ex.length} ${picked ? 'selected' : 'detected'} clip${ex.length > 1 ? 's' : ''}. ` +
      'Untick anything you want to keep. This stage is assistive — it runs close to its decision ' +
      'boundary, so some segments may be wrong.'
    : 'General music needs at least one music example to calibrate on, and none was found.';

  if (!state.music.length) { el.innerHTML = ''; return; }

  const head = '<thead><tr><th class="pick"></th><th>episode</th><th>segments</th><th>removing</th></tr></thead>';
  let rows = '';

  for (const ep of state.music) {
    const total = ep.segments.length;
    const on = ep.enabled.size;
    const secs = ep.segments.reduce((n, s, i) => n + (ep.enabled.has(i) ? s.duration : 0), 0);
    const collapsed = state.collapsed.has(ep.id);

    rows += `<tr class="ep${total ? '' : ' empty'}">` +
      `<td class="pick"><input type="checkbox" class="epPick" data-id="${ep.id}" ` +
        `${total && on === total ? 'checked' : ''} ${total ? '' : 'disabled'}></td>` +
      `<td><button class="twisty" data-id="${ep.id}" ${total ? '' : 'disabled'}>` +
        `${total ? (collapsed ? '▸' : '▾') : '·'}</button>${ep.id}</td>` +
      `<td>${total || (ep.error ? 'failed' : 'none')}</td>` +
      `<td>${total ? `${secs.toFixed(0)}s` : '—'}</td></tr>`;

    if (!collapsed && total) {
      ep.segments.forEach((s, i) => {
        rows += `<tr class="seg"><td class="pick">` +
          `<input type="checkbox" class="segPick" data-id="${ep.id}" data-i="${i}" ` +
          `${ep.enabled.has(i) ? 'checked' : ''}></td>` +
          `<td colspan="3"><span class="segno" ` +
          `title="segment ${i + 1} of ${total} in ${ep.id}">#${i + 1}</span> ` +
          `${playButton(`music:${ep.id}:${i}`, 'Play this segment')}` +
          ` ${fmtTime(s.start)} – ${fmtTime(s.end)}` +
          ` <span class="dim">&middot; ${s.duration.toFixed(1)}s</span></td></tr>`;
      });
    }
  }

  el.innerHTML = head + `<tbody>${rows}</tbody>`;
  wirePlayButtons(el);

  el.querySelectorAll('.segPick').forEach((box) => {
    box.onchange = () => {
      const ep = state.music.find((x) => x.id === box.dataset.id);
      const i = Number(box.dataset.i);
      if (box.checked) ep.enabled.add(i); else ep.enabled.delete(i);
      renderMusic();
    };
  });
  el.querySelectorAll('.epPick').forEach((box) => {
    box.onchange = () => {
      const ep = state.music.find((x) => x.id === box.dataset.id);
      ep.enabled = box.checked ? new Set(ep.segments.map((_, i) => i)) : new Set();
      renderMusic();
    };
  });
  el.querySelectorAll('.twisty').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.id;
      if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
      renderMusic();
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
      // Output keeps the input's name: the file the user gets back is the same
      // episode, minus music, and a suffix only makes it harder to line the two
      // up. The folder is what separates them.
      plan.push({ entry, ranges, name: entry.file.name });
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
        const url = URL.createObjectURL(new Blob([out], { type: 'audio/mp4' }));
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
