/**
 * Shared DSP primitives.
 *
 * Extracted from features.mjs so the resampler and the feature extractor use one
 * implementation. All filters carry explicit state, so they work identically on
 * a whole buffer or streamed chunk-by-chunk — which matters because chunk
 * boundaries must not introduce discontinuities.
 */

/** RBJ-cookbook biquad bandpass (0 dB peak gain), normalised by a0. */
export function biquadBandpass(fs, f0, Q) {
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * Math.max(Q, 0.05));
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * Math.cos(w0)) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ-cookbook biquad lowpass, normalised by a0. */
export function biquadLowpass(fs, f0, Q) {
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * Math.max(Q, 0.05));
  const cw = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cw) / 2) / a0,
    b1: (1 - cw) / a0,
    b2: ((1 - cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Fresh filter state. Pass one in to continue a filter across calls. */
export function makeBiquadState() {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

/**
 * Direct-form-I biquad. `state` is mutated, so passing the same object across
 * successive chunks gives a continuous filter.
 */
export function applyBiquad(x, c, state = makeBiquadState()) {
  const y = new Float32Array(x.length);
  let { x1, x2, y1, y2 } = state;
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    y[i] = v;
    x2 = x1; x1 = x[i];
    y2 = y1; y1 = v;
  }
  state.x1 = x1; state.x2 = x2; state.y1 = y1; state.y2 = y2;
  return y;
}

/**
 * Butterworth lowpass of the given order (2 or 4) as cascaded biquads.
 * Returns { sections, states } to feed applyBiquad repeatedly.
 */
export function butterworthLowpass(fs, f0, order = 4) {
  // Q values for Butterworth poles
  const qs = order >= 4 ? [0.5411961, 1.306563] : [0.70710678];
  return {
    sections: qs.map((q) => biquadLowpass(fs, f0, q)),
    states: qs.map(() => makeBiquadState()),
  };
}

/** Run a signal through a cascaded filter set, carrying state. Mutates `filter`. */
export function applyCascade(x, filter) {
  let y = x;
  for (let i = 0; i < filter.sections.length; i++) {
    y = applyBiquad(y, filter.sections[i], filter.states[i]);
  }
  return y;
}

/** Moving average of |x| (cumsum-based, O(n)). */
export function movingAvgAbs(x, n) {
  const out = new Float32Array(x.length);
  const cs = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cs[i + 1] = cs[i] + Math.abs(x[i]);
  const h = n >> 1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - h), b = Math.min(x.length, i + h + 1);
    out[i] = (cs[b] - cs[a]) / (b - a);
  }
  return out;
}

/** Moving average of x^2 (cumsum-based, O(n)). */
export function movAvgSq(x, n) {
  const out = new Float32Array(x.length);
  const cs = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cs[i + 1] = cs[i] + x[i] * x[i];
  const h = n >> 1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - h), b = Math.min(x.length, i + h + 1);
    out[i] = (cs[b] - cs[a]) / (b - a);
  }
  return out;
}
