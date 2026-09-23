/**
 * Library — cross-episode orchestration.
 *
 * Phase 2 of the pipeline, and the cheap one. Everything here operates on the
 * ~1 MB/episode of retained features, so it runs on the main thread without
 * blocking: discovering assets across a 19-episode season takes seconds.
 *
 * The split matters for a browser app: phase 1 (EpisodeAnalyzer) is heavy and
 * parallelises across workers; phase 2 needs every episode's features at once
 * and is fast. That falls out of the layering rather than being bolted on.
 *
 * Everything returned is plain data — Float32Array, Map, arrays, numbers — all
 * of which are structured-cloneable, so results can be posted to/from a worker
 * or written to IndexedDB with no conversion step.
 */

import { discover as discoverAssets } from './discovery.mjs';
import { refineAsset } from './refine.mjs';
import { segmentEpisode } from './episode.mjs';

export class Library {
  constructor(opts = {}) {
    /** @type {Map<string, object>} episode id -> EpisodeAnalysis from finish() */
    this.episodes = new Map();
    this.options = opts;
  }

  /** Add an EpisodeAnalysis (the object returned by EpisodeAnalyzer.finish()). */
  add(episode) {
    if (!episode || typeof episode.id !== 'string') {
      throw new TypeError('episode must be an EpisodeAnalysis with a string id');
    }
    this.episodes.set(episode.id, episode);
    return this;
  }

  get size() { return this.episodes.size; }
  get ids() { return [...this.episodes.keys()]; }

  _fingerprintList() {
    const out = [];
    for (const ep of this.episodes.values()) {
      if (!ep.fingerprints) throw new Error(`episode "${ep.id}" has no fingerprints (finish() without them?)`);
      out.push({ id: ep.id, ...ep.fingerprints });
    }
    return out;
  }

  _chromaMap() {
    const m = new Map();
    for (const ep of this.episodes.values()) if (ep.chroma) m.set(ep.id, ep.chroma);
    return m;
  }

  /** Discover recurring assets (theme, recurring stings, ...). */
  discover(opts = {}) {
    return discoverAssets(this._fingerprintList(), opts);
  }

  /**
   * Refine assets to precise per-episode cut points using chroma.
   * @param {object[]|{candidates: object[]}} assets
   */
  refine(assets, opts = {}) {
    const chromas = this._chromaMap();
    if (!chromas.size) throw new Error('no chroma available — finish() episodes with chroma: true');
    const list = Array.isArray(assets) ? assets : assets.candidates;
    return list.map((a) => refineAsset(chromas, a, opts)).filter(Boolean);
  }

  /**
   * Per-episode music segments, calibrated on an asset's own detected regions.
   *
   * With a title-theme asset this finds music generally: theme, credits,
   * interludes and diegetic songs. Music *under* dialogue is out of scope by
   * design — it is left in place.
   */
  segment(asset, opts = {}) {
    if (!asset || !Array.isArray(asset.episodes)) {
      throw new TypeError('segment(asset) needs a refined asset with an episodes[] array');
    }
    const out = [];
    for (const e of asset.episodes) {
      if (e.present === false || e.start == null) continue;
      const ep = this.episodes.get(e.id);
      if (!ep) continue;
      if (!ep.features) throw new Error(`episode "${e.id}" has no features (finish() without segments?)`);
      const { segments } = segmentEpisode(ep, [[e.start, e.end]], opts);
      out.push({ id: e.id, segments });
    }
    return out;
  }

  /**
   * Segment every episode using explicit positive ranges, for when no shared
   * asset exists (e.g. a show with different credits music every week).
   * @param {Record<string, [number, number][]>} positiveRanges  episode id -> ranges
   */
  segmentAll(positiveRanges, opts = {}) {
    const out = [];
    for (const [id, ranges] of Object.entries(positiveRanges)) {
      const ep = this.episodes.get(id);
      if (!ep || !ep.features) continue;
      const { segments } = segmentEpisode(ep, ranges, opts);
      out.push({ id, segments });
    }
    return out;
  }
}

export default Library;
