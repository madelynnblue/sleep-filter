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
  return { n, half: n >> 1, cos, sin, rev };
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
