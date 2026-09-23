/**
 * Source acquisition: File / Blob / ArrayBuffer / Uint8Array / path / URL -> bytes.
 *
 * Runtime-detected rather than build-time-branched, so the same module works in
 * a page and in Node without a bundler alias.
 */

const isNode = () => typeof process !== 'undefined' && !!process.versions?.node;

/**
 * @param {Blob|File|ArrayBuffer|Uint8Array|string} source
 * @returns {Promise<{bytes: Uint8Array, head: Uint8Array, path: string|null, name: string|null}>}
 */
export async function readSource(source, opts = {}) {
  if (source instanceof Uint8Array) {
    return { bytes: source, head: source.subarray(0, 16), path: null, name: null };
  }
  if (source instanceof ArrayBuffer) {
    const bytes = new Uint8Array(source);
    return { bytes, head: bytes.subarray(0, 16), path: null, name: null };
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const bytes = new Uint8Array(await source.arrayBuffer());
    return { bytes, head: bytes.subarray(0, 16), path: null, name: source.name ?? null };
  }
  if (typeof source === 'string') {
    if (isNode()) {
      const { readFileSync } = await import('node:fs');
      const bytes = new Uint8Array(readFileSync(source));
      return { bytes, head: bytes.subarray(0, 16), path: source, name: source.split('/').pop() };
    }
    const res = await fetch(source, opts.fetchInit);
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, head: bytes.subarray(0, 16), path: null, name: source.split('/').pop() };
  }
  throw new TypeError('unsupported source: expected File, Blob, ArrayBuffer, Uint8Array, path or URL');
}

/** Write bytes to a temp file (Node only) so ffmpeg can seek them. */
export async function writeTempFile(bytes, suffix = '.bin') {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'audio-decode-'));
  const path = join(dir, `input${suffix}`);
  writeFileSync(path, bytes);
  return path;
}
