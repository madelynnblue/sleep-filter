/**
 * Shared FFT.
 *
 * Extracted so there is exactly ONE implementation in the package. Previously
 * discovery.mjs and music.mjs each carried a copy, which would inevitably
 * diverge.
 *
 * Radix-2 iterative Cooley-Tukey with precomputed bit-reversal and twiddle
 * tables. Pure JS, no dependencies, browser-safe.
 */

/** Precompute tables for a fixed transform size (must be a power of two). */
export function makeFFT(n) {
  const levels = Math.round(Math.log2(n));
  if (1 << levels !== n) throw new Error('nfft must be a power of two');
  const cos = new Float32Array(n >> 1);
  const sin = new Float32Array(n >> 1);
  for (let i = 0; i < (n >> 1); i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) if (i & (1 << b)) r |= 1 << (levels - 1 - b);
    rev[i] = r;
  }
  return { n, half: n >> 1, levels, levelsM: levels - 1, cos, sin, rev };
}

/**
 * In-place complex FFT, forward transform (e^{-2*pi*i*k*n/N}).
 * `re`/`im` are Float32Array of length T.n.
 */
export function fftInPlace(re, im, T) {
  const { n, cos, sin, rev } = T;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const h = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < h; j++, k += step) {
        const c = cos[k], s = sin[k];
        const a = i + j, b = a + h;
        const tr = re[b] * c + im[b] * s;
        const ti = im[b] * c - re[b] * s;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/** Standalone complex FFT for callers without a precomputed table. */
export function fft(re, im, n) {
  fftInPlace(re, im, makeFFT(n));
}

/**
 * Magnitude and power spectra of a REAL signal, via a half-length complex FFT.
 *
 * Every transform here runs on windowed audio, whose imaginary part is zero
 * before the call — so a full complex transform spends half its butterflies on a
 * part that is known in advance. Packing the even samples into the real part and
 * the odd samples into the imaginary part of an N/2 transform, then untangling
 * the result, recovers the N-point spectrum for a bit over half the cost.
 *
 * Writes `mag[k] = |X[k]|` and `power[k] = |X[k]|^2` for k in [0, n/2], both of
 * which callers already needed, so neither has to be re-derived.
 *
 * `scratch` holds the packed N/2 transform; it is reused across frames.
 *
 * @param {Float32Array} x     real input, length n
 * @param {object} T           table for the FULL size n
 * @param {Float32Array} mag   output, length n/2 + 1
 * @param {Float32Array} power output, length n/2 + 1
 * @param {Float32Array} scratch working buffer, length n (first n/2 used)
 */
export function realSpectrum(x, T, mag, power, scratch) {
  const n = T.n, m = n >> 1;
  const zr = scratch, zi = scratch.subarray(m, m + m);
  for (let j = 0; j < m; j++) { zr[j] = x[2 * j]; zi[j] = x[2 * j + 1]; }

  // half-length complex transform, reusing the full table's twiddles: the
  // level-by-level structure is identical, only n and the step change
  {
    const { cos, sin } = T;
    for (let i = 0; i < m; i++) {
      let r = 0;
      for (let b = 0; b < T.levelsM; b++) if (i & (1 << b)) r |= 1 << (T.levelsM - 1 - b);
      if (r > i) {
        let t = zr[i]; zr[i] = zr[r]; zr[r] = t;
        t = zi[i]; zi[i] = zi[r]; zi[r] = t;
      }
    }
    for (let size = 2; size <= m; size <<= 1) {
      const h = size >> 1, step = (n / 2) / size * 2;   // twiddle stride for size m
      for (let i = 0; i < m; i += size) {
        for (let j = 0, k = 0; j < h; j++, k += step) {
          const c = cos[k], s = sin[k];
          const a = i + j, b = a + h;
          const tr = zr[b] * c + zi[b] * s;
          const ti = zi[b] * c - zr[b] * s;
          zr[b] = zr[a] - tr; zi[b] = zi[a] - ti;
          zr[a] += tr; zi[a] += ti;
        }
      }
    }
  }

  // untangle: X[k] = even + W_n^k * odd, with even/odd from the half spectrum
  const a0r = zr[0], a0i = zi[0];
  const half = n >> 1;
  const re0 = a0r + a0i, im0 = 0;
  mag[0] = Math.abs(re0); power[0] = re0 * re0;
  const reN = a0r - a0i;
  mag[half] = Math.abs(reN); power[half] = reN * reN;
  for (let k = 1; k < half; k++) {
    const kr = zr[k], ki = zi[k];
    const mr = zr[m - k], mi = -zi[m - k];
    const er = 0.5 * (kr + mr), ei = 0.5 * (ki + mi);
    const dr = 0.5 * (kr - mr), di = 0.5 * (ki - mi);
    const or_ = di, oi = -dr;                       // (A-B)/(2i)
    const c = T.cos[k], s = T.sin[k];               // W_n^k = cos - i sin
    const tr = or_ * c + oi * s;
    const ti = oi * c - or_ * s;
    const xr = er + tr, xi = ei + ti;
    const p = xr * xr + xi * xi;
    power[k] = p; mag[k] = Math.sqrt(p);
  }
}
