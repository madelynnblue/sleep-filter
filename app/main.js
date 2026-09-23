/**
 * Web page front end.
 *
 * Same orchestration as the CLI (app/pipeline.mjs) — the only difference is that
 * audio-decode picks the WebCodecs backend instead of ffmpeg, and phase 1 runs
 * across a worker pool so the UI stays responsive.
 *
 * Cutting happens on the main thread: the file is read again from disk (cheap
 * for these sizes) so workers need no cross-phase state.
 */

import { discoverAssets, musicRanges, renderCut } from './pipeline.mjs';

const $ = (id) => document.getElementById(id);
const state = { files: [], analyses: [], assets: [], library: null, outDir: null };

/* -------------------------------------------------------- capability -- */

const hasWebCodecs = typeof globalThis.AudioDecoder === 'function';
const hasFS = typeof window.showDirectoryPicker === 'function';

$('capability').textContent = hasWebCodecs
  ? 'WebCodecs available — MP4/M4A decode without any fallback.'
  : 'WebCodecs is NOT available in this browser: only containers the built-in '
    + 'demuxer handles can be decoded, and there is no fallback here. Try Chrome, Edge or Safari 16.4+.';

/* --------------------------------------------------------- file input -- */

$('pick').onclick = () => $('files').click();
$('files').onchange = (e) => addFiles([...e.target.files]);

const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); };

function addFiles(files) {
  for (const f of files) {
    const id = (f.name.match(/S\d+E\d+/) || [f.name.replace(/\.[^.]+$/, '')])[0];
    if (state.files.some((x) => x.id === id)) continue;
    state.files.push({ id, file: f, status: 'queued', progress: 0 });
  }
  renderFiles();
  $('analyze').disabled = state.files.length === 0;
}

function renderFiles() {
  $('filelist').innerHTML = state.files.map((f) => {
    const label = f.status === 'done' ? 'done'
      : f.status === 'running' ? `${(f.progress * 100).toFixed(0)}%`
      : f.status === 'error' ? `error: ${f.error}`
      : 'queued';
    return `<li><span class="id">${f.id}</span><span class="sz">${(f.file.size / 1e6).toFixed(1)} MB</span>` +
           `<span class="st ${f.status}">${label}</span></li>`;
  }).join('');
}

/* ------------------------------------------------------- worker pool -- */

/**
 * One worker per file, capped at hardwareConcurrency. Each worker analyses a
 * single file and is terminated — no shared state to get wrong.
 */
async function analyzePool() {
  const pending = state.files.filter((f) => f.status === 'queued' || f.status === 'error');
  const limit = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 4, pending.length));
  // stale results from a previous run for the same ids would confuse discovery
  state.analyses = state.analyses.filter((a) => !pending.some((f) => f.id === a.id));
  let next = 0;

  function analyzeInWorker(entry) {
    entry.status = 'running';
    renderFiles();
    return new Promise((resolve) => {
      const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
      const finish = (result) => {
        worker.terminate();
        renderFiles();
        resolve(result);
      };
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          entry.progress = m.progress ?? 0;
          renderFiles();
        } else if (m.type === 'done') {
          entry.status = 'done';
          entry.progress = 1;
          finish(m.analysis);
        } else if (m.type === 'error') {
          entry.status = 'error';
          entry.error = m.message;
          finish(null);
        }
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
}

/* ------------------------------------------------------------ analyse -- */

$('analyze').onclick = async () => {
  $('analyze').disabled = true;
  $('analyze').textContent = 'Analysing…';
  try {
    await analyzePool();
    if (!state.analyses.length) throw new Error('no episodes could be analysed');

    const { library, assets } = discoverAssets(state.analyses, {});
    state.library = library;
    state.assets = assets;

    if (!assets.length) {
      $('step2').hidden = false;
      $('assets').querySelector('tbody').innerHTML =
        '<tr><td colspan="6">No recurring assets found. Detection needs audio that repeats across episodes.</td></tr>';
      $('cut').disabled = true;
      return;
    }
    renderAssets();
    $('step2').hidden = false;
  } catch (err) {
    alert(`Analysis failed: ${err.message}`);
  } finally {
    $('analyze').disabled = false;
    $('analyze').textContent = 'Analyse';
  }
};

function renderAssets() {
  const tb = $('assets').querySelector('tbody');
  tb.innerHTML = state.assets.map((a, i) => {
    const conf = a.meanSim ?? a.meanVotes ?? null;
    const confTxt = typeof conf === 'number' ? conf.toFixed(3) : '—';
    const weak = typeof a.meanSim === 'number' && a.meanSim < 0.9;
    return `<tr>
      <td><input type="radio" name="asset" value="${i}" ${i === 0 ? 'checked' : ''}></td>
      <td>${a.kind}</td>
      <td>${a.support}/${a.totalEpisodes ?? state.analyses.length}</td>
      <td>${a.span.toFixed(1)}s</td>
      <td>${fmtTime(a.meanStart)}</td>
      <td class="${weak ? 'weak' : ''}">${confTxt}${weak ? ' ⚠' : ''}</td>
    </tr>`;
  }).join('');
  const first = state.assets[0];
  $('absentNote').textContent = first.absent?.length
    ? `Not present in: ${first.absent.join(', ')}`
    : '';
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/* ---------------------------------------------------------------- cut -- */

if (hasFS) {
  $('dirBtn').hidden = false;
  $('dirBtn').onclick = async () => {
    try {
      state.outDir = await window.showDirectoryPicker({ mode: 'readwrite' });
      $('dirBtn').textContent = `Output: ${state.outDir.name}`;
    } catch { /* user cancelled */ }
  };
}

$('cut').onclick = async () => {
  const index = Number(document.querySelector('input[name=asset]:checked')?.value ?? 0);
  const asset = state.assets[index];
  if (!asset) return;
  const mode = $('mode').value;

  $('cut').disabled = true;
  $('cut').textContent = 'Working…';
  $('step3').hidden = false;

  try {
    const perEpisode = musicRanges(state.library, asset, { segment: {} });
    const tb = $('results').querySelector('tbody');
    tb.innerHTML = '';
    let totalRemoved = 0, written = 0;

    for (const { id, ranges, segments } of perEpisode) {
      const entry = state.files.find((f) => f.id === id);
      if (!entry) continue;
      if (!ranges.length) {
        tb.insertAdjacentHTML('beforeend', `<tr><td>${id}</td><td>0</td><td>—</td><td>—</td><td>no music detected</td></tr>`);
        continue;
      }
      const bytes = new Uint8Array(await entry.file.arrayBuffer());
      const { bytes: out, info } = renderCut(bytes, ranges, { mode });
      totalRemoved += info.removedSeconds;

      const suffix = mode === 'keep' ? ' (music only)' : ' (no music)';
      const name = entry.file.name.replace(/\.[^.]+$/, '') + suffix + (entry.file.name.match(/\.[^.]+$/) ?? ['.m4a'])[0];

      let how = '';
      if (state.outDir) {
        const handle = await state.outDir.getFileHandle(name, { create: true });
        const w = await handle.createWritable();
        await w.write(out);
        await w.close();
        how = name;
      } else {
        const url = URL.createObjectURL(new Blob([out], { type: 'audio/mp4' }));
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        how = `downloaded ${name}`;
      }
      written++;
      tb.insertAdjacentHTML('beforeend',
        `<tr><td>${id}</td><td>${segments.length}</td><td>${info.removedSeconds.toFixed(0)}s</td>` +
        `<td>${info.outputSeconds.toFixed(0)}s</td><td>${how}</td></tr>`);
    }

    $('summary').textContent =
      `${mode === 'keep' ? 'Extracted' : 'Removed'} ${totalRemoved.toFixed(0)}s across ${written} file(s). ` +
      (state.outDir ? `Written to ${state.outDir.name}.` : 'Check your downloads.');
  } catch (err) {
    $('summary').textContent = `Failed: ${err.message}`;
  } finally {
    $('cut').disabled = false;
    $('cut').textContent = 'Find all music and export';
  }
};
