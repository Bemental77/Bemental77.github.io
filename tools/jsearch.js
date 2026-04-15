#!/usr/bin/env node
/**
 * jsearch.js — search minified or any JS file with readable context
 *
 * Usage:
 *   node tools/jsearch.js <file> <pattern> [options]
 *
 * Options:
 *   --context  <n>    chars of context on each side (default: 200)
 *   --max      <n>    max matches to show (default: 10)
 *   --extract  <name> extract a named function/var block by name
 *   --pretty          pretty-print the whole file to /tmp/<basename>.pretty.js then exit
 *   --lines           show line numbers after pretty-printing (requires --pretty first)
 *
 * Examples:
 *   node tools/jsearch.js ps1/ps1Wasm/dist/wasmpsx_worker.js "mainLoop.runner" --context 400
 *   node tools/jsearch.js ps1/ps1Wasm/dist/wasmpsx.min.js "new Worker" --max 5
 *   node tools/jsearch.js ps1/ps1Wasm/dist/wasmpsx_worker.js --pretty
 *   node tools/jsearch.js /tmp/wasmpsx_worker.pretty.js "tickStartTime" --context 300
 *   node tools/jsearch.js ps1/ps1Wasm/dist/wasmpsx_worker.js --extract fakeRequestAnimationFrame
 */

const fs   = require('fs');
const path = require('path');

const args    = process.argv.slice(2);
const file    = args[0];
const pattern = args[1] && !args[1].startsWith('--') ? args[1] : null;

if (!file || file === '--help' || file === '-h') {
  const usage = fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).join('\n');
  console.log(usage);
  process.exit(0);
}

// Parse flags
function flag(name, def) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  return args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : true;
}

const context  = parseInt(flag('--context', 200), 10);
const maxHits  = parseInt(flag('--max', 10), 10);
const extract  = flag('--extract', null);
const doPretty = args.includes('--pretty');

// ── Read file ──────────────────────────────────────────────────────────────
let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.error(`Cannot read: ${file}`);
  process.exit(1);
}

// ── Pretty-print ───────────────────────────────────────────────────────────
function prettify(src) {
  let indent = 0;
  let out    = '';
  let i      = 0;
  let inStr  = false;
  let strCh  = '';

  const pad = () => '  '.repeat(Math.max(0, indent));

  while (i < src.length) {
    const ch   = src[i];
    const next = src[i + 1];

    if (inStr) {
      out += ch;
      if (ch === '\\') { out += src[++i] || ''; }
      else if (ch === strCh) { inStr = false; }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = true; strCh = ch; out += ch; i++; continue;
    }

    // line comments
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const line = end === -1 ? src.slice(i) : src.slice(i, end + 1);
      out += line; i += line.length; continue;
    }
    // block comments
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const block = end === -1 ? src.slice(i) : src.slice(i, end + 2);
      out += block + '\n'; i += block.length; continue;
    }

    if (ch === '{') {
      out += ' {\n' + pad() + '  '; indent++; i++; continue;
    }
    if (ch === '}') {
      indent = Math.max(0, indent - 1);
      out += '\n' + pad() + '}'; i++;
      if (src[i] === ';') { out += ';'; i++; }
      out += '\n' + pad(); continue;
    }
    if (ch === ';') {
      out += ';\n' + pad(); i++; continue;
    }
    if (ch === ',') {
      out += ',\n' + pad(); i++; continue;
    }
    out += ch; i++;
  }
  return out;
}

if (doPretty) {
  const pretty = prettify(src);
  const base   = path.basename(file, '.js');
  const outPath = `/tmp/${base}.pretty.js`;
  fs.writeFileSync(outPath, pretty);
  const lines = pretty.split('\n').length;
  console.log(`Pretty-printed → ${outPath}  (${lines} lines, ${(pretty.length/1024).toFixed(1)}KB)`);
  console.log(`Now search it:  node tools/jsearch.js ${outPath} "<pattern>" --context 300`);
  process.exit(0);
}

// ── Extract named function/var ─────────────────────────────────────────────
if (extract) {
  // Find occurrences of the name followed by = or : or (
  const re = new RegExp(`(function\\s+${extract}|var\\s+${extract}\\s*=|${extract}\\s*[=:(])`, 'g');
  let m;
  let found = 0;
  while ((m = re.exec(src)) !== null && found < maxHits) {
    found++;
    const start = Math.max(0, m.index);
    // walk forward to find matching brace end
    let depth = 0, j = start, started = false;
    while (j < src.length) {
      if (src[j] === '{') { depth++; started = true; }
      if (src[j] === '}') { depth--; }
      if (started && depth === 0) break;
      j++;
    }
    const slice = src.slice(start, Math.min(j + 1, start + 2000));
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Match ${found}] offset ${start}`);
    console.log('='.repeat(60));
    console.log(prettify(slice));
  }
  if (!found) console.log(`No match for: ${extract}`);
  process.exit(0);
}

// ── Pattern search ─────────────────────────────────────────────────────────
if (!pattern) {
  console.error('Provide a search pattern, or use --pretty / --extract <name>');
  process.exit(1);
}

const re = new RegExp(pattern, 'g');
let m;
let count = 0;

while ((m = re.exec(src)) !== null && count < maxHits) {
  count++;
  const lo  = Math.max(0, m.index - context);
  const hi  = Math.min(src.length, m.index + m[0].length + context);
  const pre  = src.slice(lo, m.index);
  const hit  = src.slice(m.index, m.index + m[0].length);
  const post = src.slice(m.index + m[0].length, hi);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[${count}] offset ${m.index}  (showing ±${context} chars)`);
  console.log('─'.repeat(60));
  console.log(pre + `>>>>${hit}<<<<` + post);
}

if (!count) console.log(`No matches for: ${pattern}`);
else        console.log(`\n— ${count} match(es) shown (--max ${maxHits}) —`);
