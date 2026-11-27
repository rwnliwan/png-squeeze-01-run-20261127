// png-squeeze-01-run-20261127 — v3: v2 + top-2 finalists (the level-6 screen does
// not perfectly predict the level-9 winner) and brute-force weighing at level 6.
//
// Reads /input/<id>/image.png (stored RGBA PNG), writes a smaller lossless PNG to
// /output/<id>/image.png. Strategy: per-image colour analysis (palette / grey /
// grey+alpha / RGB / RGBA, with a tRNS key when one transparent value fits), per-form
// filter screening (fixed filters, minimum-sum and fewest-pairs heuristics), each
// candidate weighed by a real zlib level-6 deflate, winner re-encoded at level 9 over
// several strategies and the smallest kept. Deterministic: no clock, no randomness,
// all tie-breaks by fixed order.
import { inflateSync, deflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- PNG chunk plumbing (CRC-32, chunk assembly) ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function pngOf(chunks) {
  let size = SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIG, 0);
  let at = SIG.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------- PNG decode to RGBA ----------

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  if (bytes.length < 8 || SIG.some((b, i) => bytes[i] !== b)) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(type + ' CRC');
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], interlace: data[12] };
      if (header.depth !== 8 || header.interlace !== 0) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error('unexpected chunk ' + type);
  }
  if (!header || !ended || idat.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT inflates to wrong size');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error('bad filter ' + ft);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { rgba, width, height };
}

// ---------- Colour analysis ----------

// Distinct RGBA colours, at most 256; null when there are more. Key is endian-safe
// arithmetic (never a Uint32 view of the bytes).
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d], g = rgba[d + 1], b = rgba[d + 2], a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const key = ((r * 256 + g) * 256 + b) * 256 + a;
      const k = counts.get(key);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(key, { key, r, g, b, a, count: 1 });
      } else k.count++;
    }
  }
  return { opaque, grey, colours: many ? null : [...counts.values()] };
}

// The one fully transparent value (grey sample or RGB triple) the image may key by
// tRNS instead of an alpha channel: every non-opaque pixel is that exact value at
// alpha 0, and no opaque pixel uses that value. -1 when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return -1;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return -1;
  }
  if (key === -1) return -1;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return -1;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// Palette form: transparent entries first (short tRNS), then by `order`
// ('count' = most used first, 'luminance' = darkest first), ties by key.
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.key - y.key;
    return y.count - x.count || x.key - y.key;
  });
  const index = new Map(entries.map((c, i) => [c.key, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = index.get(((rgba[d] * 256 + rgba[d + 1]) * 256 + rgba[d + 2]) * 256 + rgba[d + 3]);
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push({ ...paletteForm(rgba, colours, 'count'), filters: [0] });
    forms.push({ ...paletteForm(rgba, colours, 'luminance'), filters: [0, 'minsum', 'brute'] });
    if (!grey) return forms;
  }
  const key = opaque ? -1 : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== -1 ? 0 : 4;
    if (key !== -1) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== -1 ? 2 : 6;
    if (key !== -1) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
  return forms;
}

// ---------- Filtering ----------

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) out.set(cur);
    else for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// Filtered raw data (filter byte + row per row) for `choice`: a fixed type, or
// 'minsum' / 'pairs' per-row heuristic, or 'brute' (each row's five filters weighed
// by a real level-4 deflate against the 32 KiB written before it). Reuses the
// caller's trial buffers.
const BRUTE_CONTEXT = 32768;
/** Brute force weighs a row's trials at level 6 (closer to the final level-9 cost). */
const BRUTE_LEVEL = 6;
function filtered(samples, width, height, bpp, choice, raw, trial, seen) {
  const stride = width * bpp;
  let stamp = 0;
  const trialB = choice === 'brute' ? Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  }) : null;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    if (choice === 'brute') {
      const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
      let type = 0;
      let best = Infinity;
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trialB[t].subarray(1));
        const len = deflateSync(trialB[t], before.length === 0
          ? { level: BRUTE_LEVEL, memLevel: 9 }
          : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
        if (len < best) {
          best = len;
          type = t;
        }
      }
      raw.set(trialB[type], at);
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      const cost = choice === 'minsum' ? signedSum(trial[t]) : pairsOf(trial[t], seen, ++stamp);
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

// ---------- Screen + encode ----------

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

function screen(rgba, width, height) {
  const forms = formsOf(rgba);
  // Keep the top two candidates by level-6 bytes: the level-6 screen does not
  // perfectly predict the level-9 winner, so both get a full level-9 encode.
  const top = [];
  const consider = (cand) => {
    top.push(cand);
    top.sort((a, b) => a.bytes - b.bytes);
    if (top.length > 2) top.length = 2;
  };
  for (const form of forms) {
    const size = height * (width * form.bpp + 1);
    const raw = new Uint8Array(size);
    const trial = Array.from({ length: 5 }, () => new Uint8Array(width * form.bpp));
    const seen = new Uint32Array(65536);
    for (const choice of form.filters) {
      filtered(form.samples, width, height, form.bpp, choice, raw, trial, seen);
      const zlib = deflateSync(raw, SCREEN);
      const bytes = zlib.length + chunkBytes(form);
      consider({ form, data: raw.slice(), bytes, zlib6: zlib });
    }
  }
  return top;
}

// Final encode of the screened finalists: level 9 over several strategies and
// memLevels, keep the smallest complete PNG (level-6 screen stream included).
function encodeBest(top, width, height) {
  let bestPng = null;
  for (const cand of top) {
    const form = cand.form;
    let zlibBest = cand.zlib6;
    let zlibBestLen = cand.zlib6.length;
    for (const strategy of [0, 1, 2, 3, 4]) {
      const z = deflateSync(cand.data, { level: 9, memLevel: 8, strategy });
      if (z.length < zlibBestLen) {
        zlibBestLen = z.length;
        zlibBest = z;
      }
    }
    for (const strategy of [0, 1]) {
      const z = deflateSync(cand.data, { level: 9, memLevel: 9, strategy });
      if (z.length < zlibBestLen) {
        zlibBestLen = z.length;
        zlibBest = z;
      }
    }
    const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
    if (form.plte !== null) chunks.push(['PLTE', form.plte]);
    if (form.trns !== null) chunks.push(['tRNS', form.trns]);
    chunks.push(['IDAT', new Uint8Array(zlibBest)]);
    chunks.push(['IEND', new Uint8Array(0)]);
    const png = pngOf(chunks);
    if (bestPng === null || png.length < bestPng.length) bestPng = png;
  }
  return bestPng;
}

// ---------- Main ----------

for (const id of readdirSync(I).sort()) {
  const { rgba, width, height } = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const top = screen(rgba, width, height);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), encodeBest(top, width, height));
}
