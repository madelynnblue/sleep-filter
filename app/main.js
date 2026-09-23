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
  discoverAssets, musicRangesFor, extractClipWav, exampleRegion, renderCut,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  files: [],          // { id, file, status, progress, error }
  analyses: [],
  library: null,
  assets: [],         // all discovered
  shown: [],          // the top N actually displayed
  selected: new Set(),// indices into `shown` that the user wants removed
  previews: new Map(),// clip index -> { url, loading }
  music: [],          // [{ id, segments, enabled:Set<index> }]
  collapsed: new Set(),
  outDir: null,
};

const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const hasWebCodecs = typeof globalThis.AudioDecoder === 'function';
const hasFS = typeof window.showDirectoryPicker === 'function';

$('capability').textContent = hasWebCodecs
  ? 'WebCodecs available — MP4/M4A decode without a fallback.'
  : 'WebCodecs is NOT available here, so decoding will fail. Try Chrome, Edge or Safari 16.4+.';

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
    state.files.push({ id, file: f, status: 'queued', progress: 0 });
    added++;
  }
  renderFiles();
  if (added) autoRun();
}

function renderFiles() {
  $('filelist').innerHTML = state.files.map((f) => {
    const label = f.status === 'done' ? 'analysed'
      : f.status === 'running' ? `${((f.progress ?? 0) * 100).toFixed(0)}%`
      : f.status === 'error' ? `error: ${f.error}`
      : 'queued';
    return `<li><span class="id">${f.id}</span>` +
           `<span class="sz">${(f.file.size / 1e6).toFixed(1)} MB</span>` +
           `<span class="st ${f.status}">${label}</span></li>`;
  }).join('');
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

async function analyzePool() {
  const pending = pendingFiles();
  const limit = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 4, pending.length));
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
      const a = await analyzeInWorker(pending[next++]);
      if (a) results.push(a);
    }
  }));
  state.analyses.push(...results);
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
  state.previews.clear();

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
      <button class="play" data-i="${i}" type="button" title="Play an example">▶</button>
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
  $('clips').querySelectorAll('.play').forEach((el) => {
    el.onclick = () => playClip(Number(el.dataset.i), el);
  });
}

async function playClip(i, button) {
  const cached = state.previews.get(i);
  if (cached?.url) { new Audio(cached.url).play(); return; }
  if (cached?.loading) return;

  const asset = state.shown[i];
  const region = exampleRegion(asset);
  if (!region) { button.textContent = '—'; return; }

  const entry = state.files.find((f) => f.id === region.id);
  if (!entry) { button.textContent = '—'; return; }

  state.previews.set(i, { loading: true });
  const was = button.textContent;
  button.textContent = '…';
  button.disabled = true;
  try {
    const { blob } = await extractClipWav(entry.file, region.start, region.end, { decode: {} });
    const url = URL.createObjectURL(blob);
    state.previews.set(i, { url });
    new Audio(url).play();
  } catch (err) {
    state.previews.delete(i);
    button.textContent = '!';
    button.title = `Could not extract the clip: ${err.message}`;
    setTimeout(() => { button.textContent = was; }, 1500);
  } finally {
    button.disabled = false;
    if (button.textContent === '…') button.textContent = '▶';
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
      return `<td class="yes${off}" title="${fmtTime(e.start)}">✓</td>`;
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
  state.music = musicRangesFor(state.library, ex, {}).map((r) => ({
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
          `<td colspan="3">${fmtTime(s.start)} – ${fmtTime(s.end)}` +
          ` <span class="dim">&middot; ${s.duration.toFixed(1)}s</span></td></tr>`;
      });
    }
  }

  el.innerHTML = head + `<tbody>${rows}</tbody>`;

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

$('export').onclick = async () => {
  const wantThemes = $('featThemes').checked;
  const wantMusic = $('featMusic').checked;
  const clips = [...state.selected].map((i) => state.shown[i]).filter(Boolean);

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
      for (const a of clips) {
        for (const e of a.episodes) {
          if (e.present === false || e.start == null) continue;
          add(e.id, e.start, e.end);
        }
      }
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
      catch { $('export').disabled = false; $('export').textContent = 'Remove music and export…'; return; }
    }

    const tb = $('results').querySelector('tbody');
    tb.innerHTML = '';
    let written = 0, totalRemoved = 0;

    for (const [id, ranges] of perFile) {
      const entry = state.files.find((f) => f.id === id);
      if (!entry || !ranges.length) continue;
      const bytes = new Uint8Array(await entry.file.arrayBuffer());
      const { bytes: out, info } = renderCut(bytes, ranges, { mode: 'remove' });
      totalRemoved += info.removedSeconds;

      const name = entry.file.name.replace(/\.[^.]+$/, '') + ' (no music)' +
        (entry.file.name.match(/\.[^.]+$/) ?? ['.m4a'])[0];

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
        `<tr><td>${id}</td><td>${ranges.length}</td>` +
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
    $('export').textContent = 'Remove music and export…';
  }
};
