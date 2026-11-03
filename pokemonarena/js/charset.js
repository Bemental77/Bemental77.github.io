// pokemonarena/js/charset.js -- the Gen-3 (international) text encoding, both directions.
//
// Pure ES module (browser + Node). Contains NO ROM-derived content: it is the character
// encoding the ROM's strings are written in, hand-written here.
//
// Two tables, kept apart on purpose:
//   CORE      every byte that actually occurs in the SoulGold v1.1.1 text pools we decode
//             (species/move/ability/item/nature/type names, move/ability/item/dex descriptions),
//             each one checked in context against the surrounding words (e.g. 0x1B inside "Pokemon" with an e-acute,
//             0x2D between "Attack" and "Defense", 0x2E before "1 priority"). The pack test fails
//             if the ROM ever uses a byte that is not in CORE.
//   RECALLED  the rest of the standard Gen-3 international table (accented capitals, umlauts,
//             punctuation) taken from memory of the decomp charmap. NOT verified against this
//             ROM because no decoded string uses them. Treat as best-effort.
// Anything in neither table decodes to a `{XX}` token (XX = uppercase hex), and the encoder parses
// `{XX}` back, so decode -> encode is LOSSLESS for ANY byte string. Bytes 0xFA..0xFD (scroll,
// paragraph, extended-control and placeholder prefixes) therefore surface as tokens too; their
// parameter bytes are not interpreted here (names and descriptions never contain them).
//
// Conventions:
//   0xFF terminates a string (never part of the decoded text).
//   0xFE decodes to "\n" (the in-game line break).
//   0x00 decodes to " ".
//   Multi-glyph tiles 0x53..0x59 decode to `{PK}` `{MN}` `{PO}` `{K\u00e9}` `{BL}` `{OC}` `{K}`
//   (PK+MN spell "PKMN"); displayText() rewrites them to plain letters for non-ROM-font UI.
//   0xB4 decodes to an ASCII apostrophe; the encoder also accepts U+2019. 0x2A decodes to U+00BA
//   (it is the degree-like glyph in "3,600 deg F"); the encoder also accepts U+00B0.

export const TERMINATOR = 0xff;
export const NEWLINE = 0xfe;

const CORE = (() => {
  const t = new Array(256).fill(null);
  t[0x00] = ' ';
  for (let i = 0; i < 10; i++) t[0xa1 + i] = String(i);
  for (let i = 0; i < 26; i++) {
    t[0xbb + i] = String.fromCharCode(65 + i);
    t[0xd5 + i] = String.fromCharCode(97 + i);
  }
  Object.assign(t, {
    0x1b: '\u00e9', // e-acute  ("Pok\u00e9mon", "Flab\u00e9b\u00e9")
    0x2a: '\u00ba', // degree-like glyph ("3,600\u00baF")
    0x2d: '&', // "Attack & Defense"
    0x2e: '+', // "+1 priority", "-6 and +6"
    0x36: ';', // "...Berry; always succeeds in sun"
    0x53: '{PK}', 0x54: '{MN}', 0x55: '{PO}', 0x56: '{K\u00e9}', 0x57: '{BL}', 0x58: '{OC}', 0x59: '{K}',
    0x5b: '%', // "80% of its body"
    0x5c: '(', 0x5d: ')', // "(the more the better)"
    0xab: '!', 0xac: '?', 0xad: '.', 0xae: '-',
    0xb0: '\u2026', // ellipsis
    0xb1: '\u201c', 0xb2: '\u201d', // double quotes as used in dex text
    0xb4: "'", // apostrophe ("Farfetch'd", "user's")
    0xb5: '\u2642', 0xb6: '\u2640', // Nidoran male/female
    0xb8: ',', 0xba: '/',
    0xf0: ':',
    0xfe: '\n',
  });
  return t;
})();

const RECALLED = (() => {
  const t = new Array(256).fill(null);
  const put = (start, chars) => { [...chars].forEach((c, i) => { if (c !== '~') t[start + i] = c; }); };
  put(0x01, '\u00c0\u00c1\u00c2\u00c7\u00c8\u00c9\u00ca\u00cb\u00cc'); // A-grave .. I-grave
  put(0x0b, '\u00ce\u00cf\u00d2\u00d3\u00d4\u0152\u00d9\u00da\u00db\u00d1\u00df'); // I-circ .. sharp s
  put(0x16, '\u00e0\u00e1~\u00e7\u00e8'); // a-grave a-acute (0x18 unused) c-cedilla e-grave
  put(0x1c, '\u00ea\u00eb\u00ec'); // e-circ e-diaer i-grave
  put(0x20, '\u00ee\u00ef\u00f2\u00f3\u00f4\u0153\u00f9\u00fa\u00fb\u00f1'); // i-circ .. n-tilde
  t[0x2b] = '\u00aa';
  t[0x35] = '=';
  t[0x51] = '\u00bf'; t[0x52] = '\u00a1';
  t[0x5a] = '\u00cd';
  t[0x68] = '\u00e2';
  t[0x6f] = '\u00ed';
  t[0x79] = '\u2191'; t[0x7a] = '\u2193'; t[0x7b] = '\u2190'; t[0x7c] = '\u2192';
  t[0xaf] = '\u00b7';
  t[0xb3] = '\u2018';
  t[0xb7] = '$';
  t[0xb9] = '\u00d7';
  t[0xef] = '\u25b6';
  put(0xf1, '\u00c4\u00d6\u00dc\u00e4\u00f6\u00fc');
  return t;
})();

/** byte -> string for every byte with a fixed glyph (null elsewhere). */
export const CHARSET = Object.freeze(CORE.map((c, i) => (c !== null ? c : RECALLED[i])));
export const CORE_BYTES = Object.freeze(CORE.map((c, i) => (c !== null ? i : -1)).filter((i) => i >= 0));
export const RECALLED_BYTES = Object.freeze(RECALLED.map((c, i) => (c !== null && CORE[i] === null ? i : -1)).filter((i) => i >= 0));

/** Spellings the encoder accepts in addition to the canonical decode of each byte. */
const ENCODE_ALIASES = { '\u2019': 0xb4, '\u00b0': 0x2a };

const hexTok = (b) => '{' + b.toString(16).toUpperCase().padStart(2, '0') + '}';

/**
 * Build a codec over a 256-entry table (string | null). Exposed so tests can build a mutated
 * codec and prove the round-trip checks notice.
 */
export function createCodec(table) {
  if (!Array.isArray(table) || table.length !== 256) throw new TypeError('charset table must have 256 entries');
  const rev = new Map();
  for (let b = 0; b < 256; b++) {
    const s = table[b];
    if (s === null || s === undefined) continue;
    if (rev.has(s)) throw new Error(`charset table maps two bytes to ${JSON.stringify(s)}`);
    rev.set(s, b);
  }
  const hasBraceTokens = [...rev.keys()].some((k) => k.length > 1);

  /** Decode up to `maxLen` bytes from `bytes[start..]`, stopping at 0xFF (not included). */
  function decode(bytes, start = 0, maxLen = Infinity) {
    let s = '';
    const end = Math.min(bytes.length, start + maxLen);
    for (let i = start; i < end; i++) {
      const b = bytes[i];
      if (b === TERMINATOR) break;
      const c = table[b];
      s += c === null || c === undefined ? hexTok(b) : c;
    }
    return s;
  }
  /** Number of bytes a decode() of the same arguments consumed, including the 0xFF if hit. */
  function span(bytes, start = 0, maxLen = Infinity) {
    const end = Math.min(bytes.length, start + maxLen);
    for (let i = start; i < end; i++) if (bytes[i] === TERMINATOR) return i - start + 1;
    return end - start;
  }
  /** Fixed-width name field: stops at 0xFF, drops trailing spaces (an all-0x00 field -> ''). */
  function decodeField(bytes, start, width) {
    return decode(bytes, start, width).replace(/ +$/, '');
  }

  /** String -> bytes. `terminate` appends 0xFF; `width` pads with 0x00 after it (fixed fields). */
  function encode(str, { terminate = true, width = 0 } = {}) {
    const out = [];
    for (let i = 0; i < str.length; ) {
      const ch = str[i];
      if (ch === '{') {
        const close = str.indexOf('}', i);
        if (close > i) {
          const tok = str.slice(i, close + 1);
          if (hasBraceTokens && rev.has(tok)) { out.push(rev.get(tok)); i = close + 1; continue; }
          const m = /^\{([0-9A-Fa-f]{2})\}$/.exec(tok);
          if (m) { out.push(parseInt(m[1], 16)); i = close + 1; continue; }
        }
        throw new Error(`cannot encode ${JSON.stringify(str.slice(i, i + 8))}: stray "{"`);
      }
      if (rev.has(ch)) out.push(rev.get(ch));
      else if (ENCODE_ALIASES[ch] !== undefined) out.push(ENCODE_ALIASES[ch]);
      else throw new Error(`cannot encode ${JSON.stringify(ch)} (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`);
      i++;
    }
    if (terminate) out.push(TERMINATOR);
    if (width && out.length > width) throw new Error(`encoded text is ${out.length} bytes, field is ${width}`);
    while (width && out.length < width) out.push(0);
    return Uint8Array.from(out);
  }

  return { decode, decodeField, encode, span, table };
}

export const defaultCodec = createCodec([...CHARSET]);
export const decodeText = defaultCodec.decode;
export const decodeField = defaultCodec.decodeField;
export const encodeText = defaultCodec.encode;
export const textSpan = defaultCodec.span;

/** Rewrite multi-glyph tokens for a non-ROM font: `{PK}{MN}` -> "PKMN", `{K\u00e9}` -> "K\u00e9". */
export function displayText(s) {
  return s.replace(/\{(PK|MN|PO|K\u00e9|BL|OC|K)\}/g, '$1');
}

/** True if `s` still contains any `{XX}` token (an undecoded or unknown byte). */
export function hasUnknownTokens(s) {
  return /\{[0-9A-F]{2}\}/.test(s);
}
