#!/usr/bin/env node
'use strict';
// ロゴの SVG を、依存なしで各大きさの PNG に描き、ICO にまとめる（第0a回 R4。Q6 の答え）。
// node だけで動くので、CI でも「SVG と書き出した PNG が同じか」を毎回確かめられる（test/icons.test.js）。
//
//   node tools/icon-render.js   … 下の TARGETS をすべて書き出す
//     - assets/icon.svg     → assets/icon.png（256）と assets/icon.ico（16〜256）
//     - assets/icon.svg     → src/assets/tray.png（32）と src/assets/tray.ico（16〜64）       … トレイ（待機）
//     - assets/tray-rec.svg → src/assets/tray-rec.png（32）と src/assets/tray-rec.ico（16〜64） … トレイ（録音中）
//
// 描けるのは、ロゴが使うものだけ:
//   - 要素は <svg>（正方形の viewBox）と <path> だけ
//   - path の命令は絶対座標の M / L / H / V / Q / Z だけ
//   - 色は #rrggbb か none。塗りは nonzero
//   - 線は丸い角（stroke-linejoin="round"）だけ。閉じていない線は丸い端（stroke-linecap="round"）だけ
// それ以外は、黙って飛ばすと絵が変わるので投げる。
//
// 描き方: 1画素を 8×8 の小さな点に分け、点の中心が形の中にあるかを数えて、覆う割合を透明度にする。
// 丸い角と丸い端の線は「各線分から太さの半分以内の点」と同じなので、線分ごとに距離で決める。
// 計算は足し引き掛け割りと比べるだけなので、OS が違っても同じ結果になる。

const fs = require('fs');
const path = require('path');
const { encodePng, packIco, parseIco } = require('./ico.js');

const ROOT = path.resolve(__dirname, '..');
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]; // 今の icon.ico と同じ並び（package.json の build.win.icon）
const TRAY_SIZES = [16, 20, 24, 32, 48, 64];       // 今の tray*.ico と同じ並び（main.js の makeTrayIcon）
const SUB = 8;      // 1画素あたりの点の数（縦横それぞれ）
const Q_STEPS = 32; // 2次ベジェを折れ線にするときの分け数

const PATH_ATTRS = new Set(['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']);
const SVG_ATTRS = new Set(['xmlns', 'viewBox', 'width', 'height']);

function attrsOf(src, where) {
  const out = {};
  const rest = src.replace(/([\w:-]+)\s*=\s*"([^"]*)"/g, (_, k, v) => { out[k] = v; return ' '; });
  if (rest.replace(/\/\s*$/, '').trim()) throw new Error(`${where} の属性を読めない: ${rest.trim()}`);
  return out;
}

function color(v, what) {
  if (v === 'none') return null;
  const m = /^#([0-9a-fA-F]{6})$/.exec(v);
  if (!m) throw new Error(`${what} の色は #rrggbb か none だけ（${v}）`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// SVG の文字を読み、viewBox と path の並びを返す。
function parseSvg(text) {
  const body = String(text).replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<\/?\s*([A-Za-z][\w:-]*)/g)) {
    if (m[1] !== 'svg' && m[1] !== 'path') throw new Error(`<${m[1]}> は描けない（<svg> と <path> だけ）`);
  }
  const svgTag = /<svg\b([^>]*)>/.exec(body);
  if (!svgTag) throw new Error('<svg> が無い');
  const sa = attrsOf(svgTag[1], '<svg>');
  for (const k of Object.keys(sa)) if (!SVG_ATTRS.has(k)) throw new Error(`<svg> の ${k} は描けない`);
  const vb = String(sa.viewBox || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !vb.every(Number.isFinite) || !(vb[2] > 0) || vb[2] !== vb[3]) {
    throw new Error(`viewBox は正方形の4つの数だけ（${sa.viewBox}）`);
  }
  const paths = [];
  for (const m of body.matchAll(/<path\b([^>]*)>/g)) {
    const a = attrsOf(m[1], '<path>');
    for (const k of Object.keys(a)) if (!PATH_ATTRS.has(k)) throw new Error(`<path> の ${k} は描けない`);
    const fill = color(a.fill == null ? '#000000' : a.fill, 'fill'); // SVG の既定の塗りは黒
    const stroke = a.stroke == null ? null : color(a.stroke, 'stroke');
    const width = a['stroke-width'] == null ? 1 : Number(a['stroke-width']);
    if (stroke && !(width > 0)) throw new Error(`stroke-width が正しくない（${a['stroke-width']}）`);
    const subs = parseD(a.d || '');
    if (stroke) {
      if (a['stroke-linejoin'] !== 'round') throw new Error('線は丸い角（stroke-linejoin="round"）だけを描く');
      if (subs.some((s) => !s.closed) && a['stroke-linecap'] !== 'round') {
        throw new Error('閉じていない線は丸い端（stroke-linecap="round"）だけを描く');
      }
    }
    paths.push({ fill, stroke, half: width / 2, subs });
  }
  return { vx: vb[0], vy: vb[1], vw: vb[2], paths };
}

// path の d を、折れ線（点の並び）の集まりにする。
function parseD(d) {
  const toks = [];
  const re = /\s*,?\s*(?:([A-Za-z])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?))/y;
  let p = 0;
  const s = String(d);
  while (p < s.length) {
    if (/^[\s,]*$/.test(s.slice(p))) break;
    re.lastIndex = p;
    const m = re.exec(s);
    if (!m) throw new Error(`path の d を読めない: ${s.slice(p, p + 20)}`);
    toks.push(m[1] || Number(m[2]));
    p = re.lastIndex;
  }
  const subs = [];
  let cur = null, x = 0, y = 0, cmd = null, i = 0;
  const num = () => {
    if (typeof toks[i] !== 'number') throw new Error(`path の ${cmd} の後に数が足りない`);
    return toks[i++];
  };
  while (i < toks.length) {
    if (typeof toks[i] === 'string') cmd = toks[i++];
    else if (!cmd) throw new Error('path の d が命令で始まっていない');
    if (!'MLHVQZ'.includes(cmd)) throw new Error(`path の命令 ${cmd} は描けない（絶対座標の M L H V Q Z だけ）`);
    if (cmd !== 'M' && !cur) throw new Error('path の d が M で始まっていない');
    if (cmd === 'M') {
      x = num(); y = num();
      cur = { pts: [[x, y]], closed: false }; subs.push(cur);
      cmd = 'L'; // M の後に続く数の組は L
    } else if (cmd === 'L') {
      x = num(); y = num(); cur.pts.push([x, y]);
    } else if (cmd === 'H') {
      x = num(); cur.pts.push([x, y]);
    } else if (cmd === 'V') {
      y = num(); cur.pts.push([x, y]);
    } else if (cmd === 'Q') {
      const cx = num(), cy = num(), ex = num(), ey = num();
      for (let k = 1; k <= Q_STEPS; k++) {
        const t = k / Q_STEPS, u = 1 - t;
        cur.pts.push([u * u * x + 2 * u * t * cx + t * t * ex, u * u * y + 2 * u * t * cy + t * t * ey]);
      }
      x = ex; y = ey;
    } else { // Z
      cur.closed = true;
      [x, y] = cur.pts[0];
      const next = toks[i];
      if (next !== undefined && next !== 'M') throw new Error('Z の後は M で始める');
    }
  }
  return subs;
}

// 線分の並び。closeAll のときは、閉じていない折れ線も閉じる（塗りは必ず閉じた形で数える）。
function segmentsOf(subs, closeAll) {
  const out = [];
  for (const s of subs) {
    const a = s.pts;
    for (let k = 0; k + 1 < a.length; k++) out.push([a[k][0], a[k][1], a[k + 1][0], a[k + 1][1]]);
    if ((s.closed || closeAll) && a.length > 1) out.push([a[a.length - 1][0], a[a.length - 1][1], a[0][0], a[0][1]]);
  }
  return out;
}

// 塗り: 点の行ごとに、辺と交わる位置と向きを数え、巻き数が 0 でない区間の点を立てる。
function markFill(bm, n, vx, vy, k, segs) {
  for (let j = 0; j < n; j++) {
    const y = vy + (j + 0.5) / k;
    const xs = [];
    for (const [ax, ay, bx, by] of segs) {
      if ((ay <= y) !== (by <= y)) xs.push([ax + (y - ay) * (bx - ax) / (by - ay), by > ay ? 1 : -1]);
    }
    xs.sort((p, q) => p[0] - q[0]);
    let wind = 0;
    for (let q = 0; q + 1 < xs.length; q++) {
      wind += xs[q][1];
      if (!wind) continue;
      const x0 = xs[q][0], x1 = xs[q + 1][0];
      for (let i = Math.max(0, Math.ceil((x0 - vx) * k - 0.5)); i < n && vx + (i + 0.5) / k < x1; i++) bm[j * n + i] = 1;
    }
  }
}

// 線: 各線分から太さの半分以内にある点を立てる（丸い角と丸い端の線はこれと同じ形）。
function markStroke(bm, n, vx, vy, k, segs, half) {
  const r2 = half * half;
  for (const [ax, ay, bx, by] of segs) {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - half - vx) * k));
    const i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx) + half - vx) * k));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - half - vy) * k));
    const j1 = Math.min(n - 1, Math.ceil((Math.max(ay, by) + half - vy) * k));
    for (let j = j0; j <= j1; j++) {
      const py = vy + (j + 0.5) / k;
      for (let i = i0; i <= i1; i++) {
        const o = j * n + i;
        if (bm[o]) continue;
        const px = vx + (i + 0.5) / k;
        let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const ex = ax + t * dx - px, ey = ay + t * dy - py;
        if (ex * ex + ey * ey <= r2) bm[o] = 1;
      }
    }
  }
}

// SVG を size×size の RGBA（8bit、乗算済みでない）に描く。後の path が前の path の上に重なる。
function renderSvg(text, size) {
  if (!Number.isInteger(size) || size < 1 || size > 1024) throw new Error(`描く大きさは 1〜1024 の整数（${size}）`);
  const { vx, vy, vw, paths } = parseSvg(text);
  const n = size * SUB, k = n / vw;
  const acc = new Float64Array(size * size * 4); // 乗算済みの色と透明度
  const bm = new Uint8Array(n * n);
  const layer = (rgb, mark) => {
    bm.fill(0);
    mark();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let hit = 0;
        for (let sy = 0; sy < SUB; sy++) {
          const row = (y * SUB + sy) * n + x * SUB;
          for (let sx = 0; sx < SUB; sx++) hit += bm[row + sx];
        }
        if (!hit) continue;
        const a = hit / (SUB * SUB), o = (y * size + x) * 4;
        for (let c = 0; c < 3; c++) acc[o + c] = rgb[c] * a + acc[o + c] * (1 - a);
        acc[o + 3] = a + acc[o + 3] * (1 - a);
      }
    }
  };
  for (const p of paths) {
    if (p.fill) layer(p.fill, () => markFill(bm, n, vx, vy, k, segmentsOf(p.subs, true)));
    if (p.stroke) layer(p.stroke, () => markStroke(bm, n, vx, vy, k, segmentsOf(p.subs, false), p.half));
  }
  const out = Buffer.alloc(size * size * 4);
  for (let o = 0; o < out.length; o += 4) {
    const a = acc[o + 3];
    if (!a) continue;
    for (let c = 0; c < 3; c++) out[o + c] = Math.min(255, Math.round(acc[o + c] / a));
    out[o + 3] = Math.round(a * 255);
  }
  return out;
}

// 書き出すもの。トレイ（第0a回 R4-3。Q8）は名前と大きさを今のまま、src の下に置く（アプリ内の更新で入れ替わるように）。
const TARGETS = [
  { svg: 'assets/icon.svg', png: { file: 'assets/icon.png', size: 256 }, ico: { file: 'assets/icon.ico', sizes: ICON_SIZES } },
  { svg: 'assets/icon.svg', png: { file: 'src/assets/tray.png', size: 32 }, ico: { file: 'src/assets/tray.ico', sizes: TRAY_SIZES } },
  { svg: 'assets/tray-rec.svg', png: { file: 'src/assets/tray-rec.png', size: 32 }, ico: { file: 'src/assets/tray-rec.ico', sizes: TRAY_SIZES } },
];

function renderTargets(root = ROOT) {
  const written = [];
  for (const t of TARGETS) {
    const svg = fs.readFileSync(path.join(root, t.svg), 'utf8');
    if (t.png) {
      fs.writeFileSync(path.join(root, t.png.file), encodePng(t.png.size, t.png.size, renderSvg(svg, t.png.size)));
      written.push(`${t.png.file}: ${t.png.size} px`);
    }
    if (t.ico) {
      const ico = packIco(t.ico.sizes.map((s) => encodePng(s, s, renderSvg(svg, s))));
      fs.writeFileSync(path.join(root, t.ico.file), ico);
      written.push(`${t.ico.file}: ${parseIco(ico).map((e) => e.width).join(', ')} px`);
    }
  }
  return written;
}

module.exports = { ICON_SIZES, TRAY_SIZES, TARGETS, parseSvg, renderSvg, renderTargets };

if (require.main === module) {
  for (const line of renderTargets()) console.log(line);
}
