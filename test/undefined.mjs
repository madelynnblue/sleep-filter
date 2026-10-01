/**
 * Report identifiers a module USES but never declares.
 *
 * `node --check` validates syntax only, so a typo'd or renamed-away local parses
 * perfectly and throws only at runtime, on whichever branch happens to reach it.
 * That is how `protectedSuffix` — left behind by renaming a variable in
 * renderMusic — survived a green test run and a push, and broke the page on the
 * single-file path, which no test exercised.
 *
 * This is a small scope check for that class of bug: collect declared names,
 * collect referenced names, subtract, and report what is left after known
 * globals. Deliberately conservative — it would rather miss a use than invent
 * one — so it skips comments, strings, template text, regex literals, property
 * accesses and object-literal keys, and it only treats a parenthesised list as
 * parameters when a definition body actually follows.
 */
import { readFileSync } from 'node:fs';

const GLOBALS = new Set([
  // language
  'this', 'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'yield', 'await',
  'async', 'function', 'class', 'const', 'let', 'var', 'return', 'if', 'else',
  'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'try', 'catch', 'finally', 'throw', 'super', 'extends', 'static', 'get', 'set',
  'export', 'import', 'from', 'as',
  // builtins
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math',
  'JSON', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ArrayBuffer', 'DataView',
  'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent',
  'decodeURIComponent', 'structuredClone', 'queueMicrotask', 'globalThis',
  // browser / platform
  'window', 'document', 'self', 'console', 'performance', 'navigator',
  'localStorage', 'sessionStorage', 'indexedDB', 'location', 'history',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'alert', 'confirm', 'prompt',
  'Blob', 'File', 'FileReader', 'URL', 'URLSearchParams', 'TextDecoder',
  'TextEncoder', 'AbortController', 'fetch', 'Worker', 'Event', 'CustomEvent',
  'addEventListener', 'removeEventListener', 'AudioContext', 'OfflineAudioContext',
  'AudioDecoder', 'VideoDecoder', 'EncodedAudioChunk', 'AudioData',
  'showDirectoryPicker', 'showOpenFilePicker', 'showSaveFilePicker',
  'createImageBitmap', 'ImageData', 'MessageChannel', 'HTMLAudioElement',
  'process', 'Buffer', 'require', 'module', 'exports', '__dirname', '__filename',
  'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'DOMParser',
]);

/**
 * Blank out comments, strings and template text, keeping code that appears
 * inside `${...}`.
 *
 * A context stack rather than a flat scan: this file is full of nested template
 * literals (`${cond ? `x` : ''}`), and a scanner that does not track nesting
 * terminates the outer template at the inner backtick and then reports every
 * word of the surrounding markup as an undeclared identifier.
 */
function strip(src) {
  let out = '';
  let i = 0;
  let mode = 'code';           // code | template | sq | dq | line | block | regex
  const stack = [];            // 'template' or { expr, braces }
  const top = () => stack[stack.length - 1];
  // A `/` is a regex when the previous significant token cannot end an
  // expression. Without this, `/\\.(wav|aiff?|aif)$/i` is read as code and every
  // word inside it is reported.
  const regexAllowed = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    if (j < 0) return true;
    if ('([{,;=:!&|?+-*%^~<>'.includes(out[j])) return true;
    const tail = out.slice(0, j + 1);
    return /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(tail);
  };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
      if (c === '/' && regexAllowed()) { mode = 'regex'; i++; out += ' '; continue; }
      if (c === '"') { mode = 'dq'; i++; out += ' '; continue; }
      if (c === "'") { mode = 'sq'; i++; out += ' '; continue; }
      if (c === '`') { stack.push('template'); mode = 'template'; i++; out += ' '; continue; }
      if (c === '{') { const t = top(); if (t && t !== 'template') t.braces++; out += c; i++; continue; }
      if (c === '}') {
        const t = top();
        if (t && t !== 'template') {
          if (t.braces > 0) { t.braces--; out += c; i++; continue; }
          stack.pop();
          mode = top() === 'template' ? 'template' : 'code';
          out += ' ';   // keep tokens either side of ${...} from gluing together
          i++;
          continue;
        }
      }
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += '\n'; } i++; continue; }
    if (mode === 'block') {
      // keep newlines so reported line numbers stay true
      if (c === '\n') out += '\n';
      if (c === '*' && d === '/') { mode = 'code'; i += 2; } else i++;
      continue;
    }
    if (mode === 'regex') {
      if (c === '\\') { i += 2; continue; }
      if (c === '[') { while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } }
      else if (c === '/') { mode = 'code'; i++; while (i < src.length && /[a-z]/i.test(src[i])) i++; continue; }
      else if (c === '\n') { mode = 'code'; }   // unterminated: it was division
      i++; continue;
    }
    if (mode === 'sq' || mode === 'dq') {
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') out += '\n';
      if (c === (mode === 'sq' ? "'" : '"')) mode = 'code';
      i++; continue;
    }
    // template text
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') out += '\n';
    if (c === '`') { stack.pop(); mode = 'code'; out += ' '; i++; continue; }
    if (c === '$' && d === '{') { stack.push({ expr: true, braces: 0 }); mode = 'code'; i += 2; continue; }
    i++;
  }
  return out;
}

const ID = /[A-Za-z_$][\w$]*/g;

function matchParenDecl(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function declaredNames(src) {
  const names = new Set();
  const add = (n) => { if (n) names.add(n); };
  const addList = (list) => {
    for (const part of list.split(',')) {
      const bits = part.split(':');
      // `{a: b}` binds b; `{a}` binds a; `{a = 1}` binds a
      const target = bits.length > 1 ? bits[1] : bits[0];
      const m = target.match(ID);
      if (m) add(m[0]);
    }
  };

  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // multi-declarator statements, with or without an initialiser:
  // `let a = 0, b = 0;` and `let t0, t1;`
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([^\n;]+)/g)) {
    if (m[1].trimStart().startsWith('{') || m[1].trimStart().startsWith('[')) continue;
    for (const d of m[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?==|,|$)/g)) add(d[1]);
  }
  for (const m of src.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*[\[{]([^\]}]*)[\]}]/g)) addList(m[1]);
  for (const m of src.matchAll(/\bfor\s*\(\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // re-exports bind names the same way imports do
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}\s*from\b/g)) addList(m[1]);
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) addList(m[1]);

  // imports: `import a, {b as c} from` / `import * as d from`
  for (const m of src.matchAll(/\bimport\s+([\s\S]*?)\s+from\s/g)) {
    for (const part of m[1].replace(/[{}*]/g, ',').split(',')) {
      const bits = part.split(/\s+as\s+/);
      const name = (bits[1] ?? bits[0]).match(ID);
      if (name) add(name[0]);
    }
  }
  // Parameters need real paren matching: `function f(keep = () => false)` has a
  // nested group, and a flat `\(([^()]*)\)` silently declares nothing.
  const matchParen = (open) => matchParenDecl(src, open);
  const addSpan = (from, to) => { for (const id of src.slice(from, to).match(ID) ?? []) add(id); };

  // Method / shorthand-function definitions: `name(params) {`. A call is
  // distinguished by what follows the closing paren — a definition has a body.
  // Getting this wrong in the permissive direction would hide the very bug this
  // looks for, so the shape is required to be exact.
  for (const m of src.matchAll(/(?:^|[{,;}\n])\s*(?:static\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (/^(if|for|while|switch|catch|return|function|typeof|new|do|else|await|yield|delete|void|in|of|case)$/.test(m[1])) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParenDecl(src, open);
    if (close < 0 || !/^\s*\{/.test(src.slice(close + 1))) continue;
    add(m[1]);
    addSpan(open + 1, close);
  }

  for (const m of src.matchAll(/\bfunction\b/g)) {
    const open = src.indexOf('(', m.index);
    const close = open < 0 ? -1 : matchParen(open);
    if (close > 0) addSpan(open + 1, close);
  }
  for (const m of src.matchAll(/=>/g)) {
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (src[j] === ')') {
      let depth = 0, k = j;
      for (; k >= 0; k--) {
        if (src[k] === ')') depth++;
        else if (src[k] === '(') { depth--; if (depth === 0) break; }
      }
      if (k >= 0) addSpan(k + 1, j);
    } else {
      const id = src.slice(0, j + 1).match(/([A-Za-z_$][\w$]*)$/);
      if (id) add(id[1]);
    }
  }
  return names;
}

function usedNames(src) {
  const out = [];
  for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)/g)) {
    const before = src.slice(0, m.index + m[1].length);
    const after = src.slice(m.index + m[0].length);
    // object-literal key: preceded by `{` or `,` and followed by `:`
    if (/[{,]\s*$/.test(before) && /^\s*:/.test(after)) continue;
    out.push({ name: m[2], index: m.index });
  }
  return out;
}

/**
 * @returns {Array<{name: string, line: number}>} identifiers used but never
 *   declared, ignoring known globals and any names in `extra`.
 */
export function undeclared(file, extra = []) {
  const extraSet = new Set(extra);
  const src = strip(readFileSync(file, 'utf8'));
  const declared = declaredNames(src);
  const missing = new Map();
  for (const { name, index } of usedNames(src)) {
    if (declared.has(name) || GLOBALS.has(name) || extraSet.has(name)) continue;
    if (!missing.has(name)) missing.set(name, src.slice(0, index).split('\n').length);
  }
  return [...missing].map(([name, line]) => ({ name, line }));
}

// CLI: `node test/undefined.mjs <files...>`
if (process.argv[1] && process.argv[1].endsWith('undefined.mjs')) {
  let bad = 0;
  for (const file of process.argv.slice(2)) {
    const found = undeclared(file);
    for (const { name, line } of found) console.log(`${file}:${line}: uses "${name}" but never declares it`);
    console.log(`${found.length} undeclared identifier(s) in ${file}`);
    bad += found.length;
  }
  process.exit(bad ? 1 : 0);
}
