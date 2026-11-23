// make.fun news-image-20261123 entry: a one-image front page of Monday,
// 23 November 2026's world news. The program draws the page itself - a
// hand-written raster engine, a geometric stroke font and the layout are
// all in this file (Node 22, standard library only) - and writes the PNG
// to /output/entry.png (MAKEFUN_OUTPUT_DIR overrides the directory).
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Raster engine: a small supersampled RGB canvas, drawing primitives and a
// PNG writer (zlib from the Node standard library). Written for this entry.
// ---------------------------------------------------------------------------

const SS = 2;                 // supersampling factor
const W = 1024, H = 1024;     // final image size
const CW = W * SS, CH = H * SS;
const buf = new Uint8Array(CW * CH * 3);

function setPx(x, y, c) {
  if (x < 0 || y < 0 || x >= CW || y >= CH) return;
  const i = (y * CW + x) * 3;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
}
function fillRect(x, y, w, h, c) {
  const x0 = Math.round(x * SS), y0 = Math.round(y * SS);
  const x1 = Math.round((x + w) * SS), y1 = Math.round((y + h) * SS);
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) setPx(xx, yy, c);
}
function fillCircle(cx, cy, r, c) {
  const R = r * SS, CX = cx * SS, CY = cy * SS;
  const x0 = Math.floor(CX - R), x1 = Math.ceil(CX + R);
  const y0 = Math.floor(CY - R), y1 = Math.ceil(CY + R);
  for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
    const dx = xx - CX, dy = yy - CY;
    if (dx * dx + dy * dy <= R * R) setPx(xx, yy, c);
  }
}
// Thick line segment with round caps, coordinates in final-image units.
function line(x0, y0, x1, y1, w, c) {
  const X0 = x0 * SS, Y0 = y0 * SS, X1 = x1 * SS, Y1 = y1 * SS, R = (w * SS) / 2;
  const minx = Math.floor(Math.min(X0, X1) - R - 1), maxx = Math.ceil(Math.max(X0, X1) + R + 1);
  const miny = Math.floor(Math.min(Y0, Y1) - R - 1), maxy = Math.ceil(Math.max(Y0, Y1) + R + 1);
  const dx = X1 - X0, dy = Y1 - Y0, L2 = dx * dx + dy * dy;
  for (let yy = miny; yy <= maxy; yy++) for (let xx = minx; xx <= maxx; xx++) {
    let t = L2 === 0 ? 0 : ((xx - X0) * dx + (yy - Y0) * dy) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = X0 + t * dx - xx, py = Y0 + t * dy - yy;
    if (px * px + py * py <= R * R) setPx(xx, yy, c);
  }
}
function polyline(pts, w, c) {
  for (let i = 0; i + 1 < pts.length; i++) line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, c);
}
function fillPoly(pts, c) {
  const P = pts.map(p => [p[0] * SS, p[1] * SS]);
  let miny = Infinity, maxy = -Infinity;
  for (const p of P) { if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
  const y0 = Math.max(0, Math.floor(miny)), y1 = Math.min(CH - 1, Math.ceil(maxy));
  for (let yy = y0; yy <= y1; yy++) {
    const xs = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      if ((a[1] <= yy && b[1] > yy) || (b[1] <= yy && a[1] > yy)) {
        xs.push(a[0] + ((yy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.round(xs[i]), xb = Math.round(xs[i + 1]);
      for (let xx = xa; xx <= xb; xx++) setPx(xx, yy, c);
    }
  }
}
// Downsample and encode as a PNG (truecolour, per-row best filter).
function toPNG(bg) {
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) {
      const i = ((y * SS + dy) * CW + (x * SS + dx)) * 3;
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
    }
    const n = SS * SS, o = (y * W + x) * 3;
    out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
  }
  const stride = W * 3;
  const raw = Buffer.alloc((stride + 1) * H);
  const filt = new Uint8Array(stride);
  for (let y = 0; y < H; y++) {
    const row = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    let bestType = 0, bestScore = Infinity, best = null;
    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0, b = up ? up[i] : 0, cc = up && i >= 3 ? up[i - 3] : 0;
        let v;
        if (type === 0) v = row[i];
        else if (type === 1) v = row[i] - a;
        else if (type === 2) v = row[i] - b;
        else if (type === 3) v = row[i] - ((a + b) >> 1);
        else {
          const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc);
          v = row[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc);
        }
        filt[i] = v & 255;
        score += Math.abs(v & 128 ? (v & 255) - 256 : v & 255);
      }
      if (score < bestScore) { bestScore = score; bestType = type; best = Buffer.from(filt); }
    }
    raw[y * (stride + 1)] = bestType;
    best.copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let crc = 0xFFFFFFFF;
    for (const byte of td) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    const cb = Buffer.alloc(4); cb.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0);
    return Buffer.concat([len, td, cb]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// A hand-drawn geometric stroke font. Glyphs live in a box 10 units tall
// (cap height), baseline y=0, y pointing UP in the table; the renderer flips
// y when drawing. Each glyph: { w: advance width, s: list of polylines }.
// ---------------------------------------------------------------------------

function arc(cx, cy, rx, ry, a0, a1, n = 14) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}
function sCurve(cx, top, h, rx) {
  // An S: starts upper right, bulges left at upper-middle, right at lower.
  const pts = [[cx + rx * 0.82, top]];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    pts.push([cx - rx * Math.sin(2 * Math.PI * t), top - h * t]);
  }
  pts.push([cx - rx * 0.82, top - h]);
  return pts;
}

const GLYPHS = {
  A: { w: 8, s: [[[0, 0], [4, 10], [8, 0]], [[1.7, 3.6], [6.3, 3.6]]] },
  B: { w: 7.6, s: [[[0, 0], [0, 10]], arc(0, 7.5, 4.9, 2.5, 90, -90), arc(0, 2.5, 5.4, 2.5, 90, -90)] },
  C: { w: 8.4, s: [arc(4.2, 5, 4.1, 5, 52, 308, 22)] },
  D: { w: 8.2, s: [[[0, 0], [0, 10]], arc(0, 5, 7.9, 5, 90, -90, 20)] },
  E: { w: 7, s: [[[7, 10], [0, 10], [0, 0], [7, 0]], [[0, 5], [5.8, 5]]] },
  F: { w: 7, s: [[[7, 10], [0, 10], [0, 0]], [[0, 5], [5.8, 5]]] },
  G: { w: 8.6, s: [arc(4.3, 5, 4.2, 5, 52, 305, 22), [[5.1, 4.3], [8.6, 4.3], [8.6, 1.6]]] },
  H: { w: 8, s: [[[0, 0], [0, 10]], [[8, 0], [8, 10]], [[0, 5], [8, 5]]] },
  I: { w: 2.6, s: [[[1.3, 0], [1.3, 10]], [[0, 10], [2.6, 10]], [[0, 0], [2.6, 0]]] },
  J: { w: 6.2, s: [[[6.2, 10], [6.2, 2.8], ...arc(3.1, 2.8, 3.1, 2.8, 0, -160, 12).slice(1), [0.2, 4.2]]] },
  K: { w: 8, s: [[[0, 0], [0, 10]], [[7.7, 10], [0.7, 4.7]], [[2, 5.7], [8, 0]]] },
  L: { w: 7, s: [[[0, 10], [0, 0], [7, 0]]] },
  M: { w: 9.4, s: [[[0, 0], [0, 10], [4.7, 3.6], [9.4, 10], [9.4, 0]]] },
  N: { w: 8, s: [[[0, 0], [0, 10], [8, 0], [8, 10]]] },
  O: { w: 8.8, s: [arc(4.4, 5, 4.3, 5, 0, 360, 26)] },
  P: { w: 7.6, s: [[[0, 0], [0, 10]], arc(0, 7.5, 5, 2.5, 90, -90)] },
  Q: { w: 8.8, s: [arc(4.4, 5, 4.3, 5, 0, 360, 26), [[5.3, 3], [9.2, -0.4]]] },
  R: { w: 7.6, s: [[[0, 0], [0, 10]], arc(0, 7.5, 5, 2.5, 90, -90), [[3.2, 5], [7.8, 0]]] },
  S: { w: 7.6, s: [sCurve(3.8, 10, 10, 3.4)] },
  T: { w: 7.6, s: [[[0, 10], [7.6, 10]], [[3.8, 10], [3.8, 0]]] },
  U: { w: 8.2, s: [[[0, 10], [0, 3.1], ...arc(4.1, 3.1, 4.1, 3.1, 180, 360, 14).slice(1), [8.2, 10]]] },
  V: { w: 8, s: [[[0, 10], [4, 0], [8, 10]]] },
  W: { w: 10.4, s: [[[0, 10], [2.3, 0], [5.2, 7], [8.1, 0], [10.4, 10]]] },
  X: { w: 8, s: [[[0, 0], [8, 10]], [[0, 10], [8, 0]]] },
  Y: { w: 8, s: [[[0, 10], [4, 5.2]], [[8, 10], [4, 5.2], [4, 0]]] },
  Z: { w: 7.6, s: [[[0, 10], [7.6, 10], [0, 0], [7.6, 0]]] },
  "0": { w: 8.2, s: [arc(4.1, 5, 3.9, 5, 0, 360, 26)] },
  "1": { w: 5.2, s: [[[1.1, 7.6], [3.4, 10], [3.4, 0]], [[0.7, 0], [5.9 - 0.7, 0]]] },
  "2": { w: 7.6, s: [[...arc(3.8, 7.3, 3.5, 2.7, 165, 5, 14), [0.4, 0.2], [7.6, 0.2]]] },
  "3": { w: 7.4, s: [arc(2.4, 7.5, 3.9, 2.5, 90, -90), arc(2.4, 2.5, 4.5, 2.5, 90, -90)] },
  "4": { w: 8, s: [[[5.4, 0], [5.4, 10], [0.5, 3.3], [8, 3.3]]] },
  "5": { w: 7.4, s: [[[7.2, 10], [1.3, 10], [1.1, 6.1], ...arc(3.3, 3.3, 4, 3.3, 105, -125, 16).slice(1)]] },
  "6": { w: 7.8, s: [[[6.6, 8.8], [4.8, 9.9], [2.8, 9.4], [1.3, 7.6], [0.6, 5.6], ...arc(3.9, 3.6, 3.6, 3.6, 155, 515, 26).slice(1)]] },
  "7": { w: 7.4, s: [[[0, 10], [7.4, 10], [3.1, 0]]] },
  "8": { w: 7.4, s: [arc(3.7, 7.5, 3, 2.5, 0, 360, 20), arc(3.7, 2.5, 3.6, 2.5, 0, 360, 22)] },
  "9": { w: 7.8, s: [[[1.2, 1.2], [3.2, 0.1], [5.4, 0.5], [6.9, 2.2], [7.5, 4.6], ...arc(3.9, 6.4, 3.6, 3.6, -30, 330, 26).slice(1)]] },
  " ": { w: 4, s: [] },
  ".": { w: 2.4, dot: [1.2, 0.7, 0.75] },
  ",": { w: 2.4, dot: [1.2, 0.7, 0.75], s: [[[1.7, 1.2], [0.9, -1.4]]] },
  "'": { w: 2.4, s: [[[1.5, 10], [0.9, 7.4]]] },
  ":": { w: 2.4, dot2: [[1.2, 2.2], [1.2, 7.8]] },
  ";": { w: 2.4, dot: [1.2, 7.8, 0.75], s: [[[1.7, 3.4], [0.9, 0.8]]] },
  "-": { w: 4.6, s: [[[0.3, 4.6], [4.3, 4.6]]] },
  "!": { w: 2.4, dot: [1.2, 0.7, 0.75], s: [[[1.2, 10], [1.2, 3.1]]] },
  "?": { w: 7, dot: [3.4, 0.7, 0.75], s: [arc(3.4, 7.4, 3.2, 2.6, 170, -95, 14), [[3.4, 4.8], [3.4, 3.1]]] },
  "/": { w: 5.6, s: [[[0.8, -0.4], [4.8, 10.4]]] },
  "(": { w: 4.4, s: [arc(5.2, 5, 3.6, 5.8, 115, 245, 14)] },
  ")": { w: 4.4, s: [arc(-0.8, 5, 3.6, 5.8, 65, -65, 14)] },
  '"': { w: 3.6, s: [[[0.7, 10], [0.4, 7.6]], [[2.9, 10], [2.6, 7.6]]] },
  "%": { w: 9, dot2: null, s: [arc(2.2, 7.6, 2, 2.2, 0, 360, 14), arc(6.8, 2.4, 2, 2.2, 0, 360, 14), [[7.6, 10.2], [1.4, -0.2]]] },
  "$": { w: 7.6, s: [sCurve(3.8, 9.4, 8.8, 3.1), [[3.8, 11], [3.8, -1.2]]] },
  "+": { w: 6.4, s: [[[3.2, 1.6], [3.2, 8.4]], [[0, 5], [6.4, 5]]] },
  "=": { w: 6.4, s: [[[0, 3.4], [6.4, 3.4]], [[0, 6.6], [6.4, 6.6]]] },
  "&": { w: 8.4, s: [arc(3.8, 7.2, 2.5, 2.7, 0, 360, 16), [[5.9, 5.2], [2.2, 0.8], [0.9, 0.2]], [[2.2, 0.8], [8.3, 7.6]]] },
  "•": { w: 3.6, dot: [1.8, 4.6, 1.15] },
  "·": { w: 3, dot: [1.5, 4.6, 0.95] },
};

const FALLBACK = GLYPHS["?"];
function glyph(ch) {
  return GLYPHS[ch] || FALLBACK;
}
function textWidth(str, size, tracking = 1.7) {
  const sc = size / 10;
  let w = 0;
  for (const ch of sanitize(str).toUpperCase()) w += (glyph(ch).w + tracking) * sc;
  return w - tracking * sc;
}
function sanitize(str) {
  return str
    .replace(/[—–]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/É/g, "E")
    .replace(/…/g, "...");
}
// Draw text with its baseline at (x, y). align: "left" | "center" | "right".
function drawText(str, x, y, size, color, weight = 1.15, align = "left", tracking = 1.7) {
  const s = sanitize(str).toUpperCase();
  const sc = size / 10;
  let cx = x;
  if (align === "center") cx = x - textWidth(s, size, tracking) / 2;
  else if (align === "right") cx = x - textWidth(s, size, tracking);
  const lw = weight * sc;
  for (const ch of s) {
    const g = glyph(ch);
    if (g.s) for (const stroke of g.s) {
      polyline(stroke.map(p => [cx + p[0] * sc, y - p[1] * sc]), lw, color);
    }
    if (g.dot) fillCircle(cx + g.dot[0] * sc, y - g.dot[1] * sc, g.dot[2] * sc + lw * 0.32, color);
    if (g.dot2) for (const d of g.dot2) fillCircle(cx + d[0] * sc, y - d[1] * sc, 0.75 * sc + lw * 0.32, color);
    cx += (g.w + tracking) * sc;
  }
  return cx;
}
// Word-wrap to a max width; returns array of lines.
function wrap(str, size, maxW, tracking = 1.7) {
  const words = str.split(" ");
  const lines = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? cur + " " + word : word;
    if (textWidth(next, size, tracking) <= maxW || !cur) cur = next;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------------------
// The front page: Monday 23 November 2026 in one image.
// ---------------------------------------------------------------------------

const PAPER = [247, 243, 232], INK = [18, 20, 24], RED = [178, 34, 40];
const NAVY = [22, 50, 79], SEA = [30, 84, 102], LAND = [96, 84, 58];
const GREY = [96, 100, 106], WHITE = [250, 248, 242], DARK = [10, 14, 18];
const FLAME = [226, 122, 40], FLAME2 = [198, 52, 40], SMOKE = [120, 118, 112];
const FOLIO = [203, 203, 196]; // pale ink for small print on the date band
const L = 40, R = 984, PW = R - L; // margins and content width

function rule(y, h = 2.5, c = INK) { fillRect(L, y, PW, h, c); }
function headlineFit(lines, want, maxW) {
  let size = want;
  for (const ln of lines) while (textWidth(ln, size, 1.7) > maxW && size > 20) size -= 1;
  return size;
}
function body(text, x, y, size, maxW, step, color = INK, weight = 1.05) {
  const lines = wrap(text, size, maxW);
  lines.forEach((ln, i) => drawText(ln, x, y + i * step, size, color, weight));
  return lines.length;
}

// --- background ------------------------------------------------------------
fillRect(0, 0, 1024, 1024, PAPER);

// --- masthead ---------------------------------------------------------------
drawText("INDEPENDENT · WORLDWIDE", L, 42, 12.5, GREY, 1.1);
drawText("ONE IMAGE · ONE DAY", R, 42, 12.5, GREY, 1.1, "right");
rule(50, 3);
drawText("THE WORLD TODAY", 512, 118, 57, INK, 2.0, "center");
// a thin double rule under the nameplate: one heavier stroke, one hairline
rule(128, 2.2);
rule(133.5, 0.9);

// --- date band ---------------------------------------------------------------
fillRect(L, 140, PW, 47, INK);
drawText("MONDAY · 23 NOVEMBER 2026", 512, 169, 26, WHITE, 1.55, "center");
// the paper's folio line, set small beneath the date inside the band
drawText("VOL. I — NO. 24 · PRICE: ONE GLANCE", 512, 183, 9.5, FOLIO, 1.25, "center");

// --- hero --------------------------------------------------------------------
drawText("IRAN WAR · THE GULF · SHIPPING CRISIS", L, 210, 17, RED, 1.5);
rule(218, 2.5, RED);
const heroLines = [
  "TANKERS ABLAZE IN THE",
  "STRAIT OF HORMUZ AS",
  "THE SEA WAR ESCALATES",
];
const hs = headlineFit(heroLines, 54, PW);
heroLines.forEach((ln, i) => drawText(ln, L, 278 + i * 62, hs, INK, 2.05));

// hero body (left) and graphic (right), y 420..556
body(
  "ATTACKS ON SHIPPING AROUND THE STRAIT HAVE REACHED THEIR HIGHEST LEVEL SINCE THE WAR BEGAN, MARITIME DATA SHOWS. THREE TANKERS WERE STRUCK LEAVING THE GULF; TEHRAN SAYS TWO SUPERTANKERS HIT NAVAL MINES AND CAUGHT FIRE.",
  L, 444, 15.5, 576, 23.5
);
// graphic panel
const GX = 648, GY = 420, GW = 336, GH = 136;
fillRect(GX, GY, GW, GH, NAVY);                       // sky
fillRect(GX, GY + 58, GW, GH - 58, SEA);              // sea
fillPoly([[GX, GY], [GX + 190, GY], [GX + 118, GY + 38], [GX, GY + 44]], LAND); // Iran shore
fillPoly([[GX + GW, GY + 96], [GX + GW, GY + GH], [GX + 230, GY + GH], [GX + 272, GY + 118]], LAND); // Oman shore
drawText("IRAN", GX + 14, GY + 24, 11, WHITE, 1.3);
drawText("OMAN", GX + GW - 10, GY + GH - 22, 11, WHITE, 1.3, "right");
fillCircle(GX + 288, GY + 24, 12, FLAME2);            // low sun
// tanker 1 (burning)
fillPoly([[GX + 42, GY + 100], [GX + 168, GY + 100], [GX + 156, GY + 114], [GX + 56, GY + 114]], DARK);
fillRect(GX + 62, GY + 92, 84, 8, DARK);
fillRect(GX + 126, GY + 80, 16, 14, DARK);
fillPoly([[GX + 80, GY + 80], [GX + 93, GY + 44], [GX + 106, GY + 80]], FLAME);
fillPoly([[GX + 88, GY + 78], [GX + 96, GY + 56], [GX + 104, GY + 78]], FLAME2);
fillPoly([[GX + 116, GY + 82], [GX + 123, GY + 62], [GX + 130, GY + 82]], FLAME);
fillCircle(GX + 100, GY + 32, 6, SMOKE);
fillCircle(GX + 114, GY + 24, 8, SMOKE);
// tanker 2 (smaller, right)
fillPoly([[GX + 192, GY + 106], [GX + 276, GY + 106], [GX + 268, GY + 116], [GX + 200, GY + 116]], DARK);
fillRect(GX + 206, GY + 100, 48, 6, DARK);
fillRect(GX + 246, GY + 92, 10, 10, DARK);
drawText("A FIFTH OF WORLD OIL PASSES HERE", GX + 12, GY + GH - 8, 10.5, WHITE, 1.2);

// pull line
drawText("TEHRAN VOWS 'ALL AVAILABLE MEANS' TO BREAK THE BLOCKADE", L, 590, 15, RED, 1.6);
rule(604, 2.5);

// --- panels ------------------------------------------------------------------
function panel(x, top, tag, head, text) {
  drawText(tag, x, top + 18, 12.5, RED, 1.5);
  wrap(head, 19.5, 452).forEach((ln, i) => drawText(ln, x, top + 44 + i * 24, 19.5, INK, 1.55));
  body(text, x, top + 92, 13, 452, 17);
}
const PX2 = 532;
panel(L, 618,
  "EUROPE · NATO",
  "NATO EMERGENCY TALKS OVER MISSILES IN POLAND",
  "ALLIES MET IN BRUSSELS AFTER 3 RUSSIAN MISSILES CAME DOWN INSIDE POLAND. RUTTE: NATO WILL DEFEND 'EVERY INCH'.");
panel(PX2, 618,
  "CLIMATE · COP31",
  "COP31 COLLAPSES AFTER LONGEST TALKS EVER HELD",
  "THE ANTALYA SUMMIT BROKE UP WITHOUT A DEAL AFTER THE EU REJECTED A TEXT THAT NEVER MENTIONED FOSSIL FUELS.");
line(512, 624, 512, 742, 1.4, GREY);
rule(756, 1.4, GREY);
panel(L, 768,
  "UNITED STATES · POLITICS",
  "DEMOCRATS WIN BIGGEST HOUSE MAJORITY SINCE 1992",
  "DEMOCRATS TOOK AT LEAST 258 SEATS, THEIR BEST RESULT SINCE 1992, AND READY OVERSIGHT PROBES FOR JANUARY.");
panel(PX2, 768,
  "MARKETS · ECONOMY",
  "MARKETS REBOUND AS THE AI ROUT EASES",
  "NVIDIA JUMPED 7% AFTER THE AI SELL-OFF. CROWDSTRIKE TO BUY ZSCALER FOR $43.9BN; BITCOIN BACK OVER $60,000.");
line(512, 774, 512, 892, 1.4, GREY);

// --- ticker ------------------------------------------------------------------
fillRect(L, 908, PW, 94, INK);
const ticker =
  "ALSO MONDAY · UKRAINE SAYS DRONES SANK A RUSSIAN CORVETTE IN LIBYA AND HIT A SHIP IN THE BALTIC · DENMARK SAYS RUSSIA PLOTTED TO KILL A RAPPER IN COPENHAGEN · ZELENSKYY URGES FOUR-WAY TALKS WITH RUSSIA · MEXICO MAKES ARRESTS AFTER CARTEL BOSS CAPTURE";
wrap(ticker, 12.5, PW - 28).forEach((ln, i) =>
  drawText(ln, L + 14, 932 + i * 21, 12.5, WHITE, 1.25));

// --- footer ------------------------------------------------------------------
drawText("THE WORLD TODAY · DRAWN FROM WIRE AND PRESS REPORTS OF THE DAY", 512, 1018, 10, GREY, 1.1, "center");

function renderPNG() { return toPNG(); }

// --- write the entry ---------------------------------------------------------
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "entry.png"), renderPNG());
