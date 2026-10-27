#!/usr/bin/env node
'use strict';
// help-appshots.js — ヘルプの記事の画面の写真を、アプリのテストの基準の写真から作る（計画 docs/plans/2026-10-27-help-overview.md の HO-1）
//
//   node tools/help-appshots.js   … help/shots-from-app.json の表のとおりに help/assets/shots/ を作り直し、表の元の指紋を今の基準に書き直す
//
// 写真の元は、アプリの画像の比べ（G2）の基準の写真 test/shots/win32/ の明るい版だけ（作り物の会議のデータ。持ち主や利用者の PC で
// 撮った写真は使わない: HO2）。表の1行は { name, from（基準の写真）, fromSha256（その指紋）, crop（[x, y, 幅, 高さ] か null） }。
// 指紋は SHA-256 の base64url（64 字の16進はゲートが AUD の見かけとして止めるので使わない）。
// アプリの画面が変わって基準を撮り直すと、指紋が合わなくなり test/help-content.test.js の HO-1 が赤になる（ヘルプの写真の撮り直しを忘れない）。
// 作り直したら、写真の変わった記事を読み直してから commit する。
//
// HO-2（HO3）: 「ここを押す」は、写真に番号の丸と細い枠を重ねた1枚の SVG（help/assets/shots/<名前>.svg）で示す。表の figures の1行は
// { name, shot（写真の名前）, pad（[上, 右, 下, 左] の余白）, r（丸の半径。既定 14）, marks: [{ at: [x, y]（丸の中心）, box?: [x, y, 幅, 高さ], to?: [x, y] }] }。
// 座標は写真（切り抜いた後）の画素。番号は marks の順に 1 から。<img> で出す SVG は外の写真を読まない（Chromium で確かめた）ので、
// 写真の PNG を data: でそのまま埋め込む（CSP の img-src 'self' は <img> の SVG を通し、SVG の中の data: は SVG の中の決まりで描く）。
// 数字は文字（<text>）でなく線で描く（SVG の中に書体を持たない。説明の文は記事の図の下の番号の説明に書く）。
//
// checkShots(root) → [{ code, file, msg }]（空なら全部よい）。code:
//   bad-table（表の形）・not-light（明るい版の基準でない）・no-from（基準の写真が無い）・from-changed（基準の指紋が違う）・
//   no-file（作った写真が無い）・pixels-differ（作った写真が元の切り抜きと画素で違う）・not-in-table（表に無いファイル）・too-big（100KB を越える）・
//   figure-differs（写真の図が figureSvg で作ったものと違う。手で直した・写真を作り直したのに図を作り直していない）

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { crc32, decodePng } = require('./png');

const ROOT = path.resolve(__dirname, '..');
const TABLE = 'help/shots-from-app.json';
const SHOTS_DIR = 'help/assets/shots';
const MAX_IMAGE_BYTES = 100000;   // 1枚 100KB まで（スマホでも重くしない。Review Focus 3）
const NAME = /^[a-z0-9-]{1,40}$/;
const FROM = /^test\/shots\/win32\/[a-z0-9-]+\.png$/;
const isLight = (from) => /(?:^|-)light(?:-|$)/.test(path.basename(from, '.png')) && !/dark/.test(from);

const fingerprint = (buf) => crypto.createHash('sha256').update(buf).digest('base64url');

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA → PNG。全部の画素が不透明なら RGB（色の型 2）で書く（記事の写真を軽くする。画素は変えない）。
 *  行のフィルタは 0（なし）: 画面の写真（平らな地と細い文字）では、ほかのフィルタより小さくなった（2026-10-27 に測った） */
function encodeSmall({ width, height, data }) {
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);   // 各行の先頭1バイトはフィルタの種類（0 = なし）
  for (let y = 0, o = 1; y < height; y++, o++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[o++] = data[i];
      raw[o++] = data[i + 1];
      raw[o++] = data[i + 2];
      if (bpp === 4) raw[o++] = data[i + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** 画像（RGBA）から [x, y, 幅, 高さ] を切り抜く。crop が null ならそのまま */
function cropImage(img, crop) {
  if (!crop) return img;
  const [x, y, w, h] = crop;
  const data = Buffer.alloc(w * h * 4);
  for (let r = 0; r < h; r++) img.data.copy(data, r * w * 4, ((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4);
  return { width: w, height: h, data };
}

const validCrop = (c, img) => c === null || (Array.isArray(c) && c.length === 4 && c.every((n) => Number.isInteger(n) && n >= 0)
  && c[2] > 0 && c[3] > 0 && (!img || (c[0] + c[2] <= img.width && c[1] + c[3] <= img.height)));

// ================= 写真の図（HO-2） =================

/** 線で描く数字（10 × 14 の枠の中。数字は文字でなく線で描く） */
const DIGITS = {
  1: 'M3 3.2L5.6 1V13',
  2: 'M1.6 4.2C1.6 1.8 3.3 1 5 1C6.9 1 8.4 2.2 8.4 4.1C8.4 6.9 1.6 9.6 1.6 13H8.6',
  3: 'M1.8 1.3H8.2L4.6 5.8C7 5.6 8.6 7.1 8.6 9.3C8.6 11.6 7 13 4.8 13C3.4 13 2.2 12.5 1.4 11.5',
  4: 'M6.8 13V1L1.2 9.6H9',
  5: 'M8.1 1.3H2.6L2.1 6.6C2.9 5.9 3.9 5.6 4.9 5.6C7.2 5.6 8.7 7.1 8.7 9.3C8.7 11.6 7.1 13 4.9 13C3.4 13 2.2 12.4 1.4 11.4',
  6: 'M7.6 1.3C4.2 1.6 1.6 4.4 1.6 8.7C1.6 11.4 3 13 5.1 13C7.2 13 8.6 11.5 8.6 9.4C8.6 7.3 7.2 5.9 5.2 5.9C3.6 5.9 2.3 6.8 1.7 8.2',
  7: 'M1.4 1.3H8.6L4 13',
  8: 'M5 6.6C2.9 6.6 1.9 5.4 1.9 3.9C1.9 2.2 3.2 1 5 1C6.8 1 8.1 2.2 8.1 3.9C8.1 5.4 7.1 6.6 5 6.6C2.6 6.6 1.4 8 1.4 9.8C1.4 11.7 2.9 13 5 13C7.1 13 8.6 11.7 8.6 9.8C8.6 8 7.4 6.6 5 6.6Z',
  9: 'M2.4 12.7C5.8 12.4 8.4 9.6 8.4 5.3C8.4 2.6 7 1 4.9 1C2.8 1 1.4 2.5 1.4 4.6C1.4 6.7 2.8 8.1 4.8 8.1C6.4 8.1 7.7 7.2 8.3 5.8',
};

/** PNG の幅と高さ（IHDR） */
function pngSize(png) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const num = (n) => String(Math.round(n * 100) / 100);

/** 写真の図の SVG（表の figures の1行と、写真の PNG の Buffer から。同じ入力なら同じ文字） */
function figureSvg(fig, png) {
  const { width: w, height: h } = pngSize(png);
  const [pt, pr, pb, pl] = fig.pad || [0, 0, 0, 0];
  const W = w + pl + pr;
  const H = h + pt + pb;
  const r = fig.r || 14;
  const s = (r * 1.1) / 14;   // 数字の高さは丸の半径の 1.1 倍
  const X = (x) => num(x + pl);
  const Y = (y) => num(y + pt);
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<image x="${pl}" y="${pt}" width="${w}" height="${h}" href="data:image/png;base64,${png.toString('base64')}"/>`,
    `<rect x="${num(pl + 0.5)}" y="${num(pt + 0.5)}" width="${w - 1}" height="${h - 1}" fill="none" stroke="#cccccc"/>`,
  ];
  fig.marks.forEach((m, i) => {
    const parts = ['<g class="mark">'];
    if (m.box) {
      const [bx, by, bw, bh] = m.box;
      for (const [c, sw] of [['#ffffff', 5], ['#000000', 3]]) parts.push(`<rect x="${X(bx)}" y="${Y(by)}" width="${bw}" height="${bh}" fill="none" stroke="${c}" stroke-width="${sw}"/>`);
    }
    const [cx, cy] = m.at;
    if (m.to) {
      const [tx, ty] = m.to;
      for (const [c, sw] of [['#ffffff', 4], ['#000000', 2]]) parts.push(`<line x1="${X(cx)}" y1="${Y(cy)}" x2="${X(tx)}" y2="${Y(ty)}" stroke="${c}" stroke-width="${sw}"/>`);
    }
    parts.push(`<circle cx="${X(cx)}" cy="${Y(cy)}" r="${r}" fill="#ffd43d" stroke="#000000" stroke-width="2"/>`);
    parts.push(`<path transform="translate(${num(cx + pl - 5 * s)} ${num(cy + pt - 7 * s)}) scale(${num(s)})" d="${DIGITS[i + 1]}" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
    parts.push('</g>');
    out.push(parts.join(''));
  });
  out.push('</svg>');
  return out.join('\n') + '\n';
}

const validFigure = (g, names) => g && NAME.test(g.name) && names.has(g.shot) && Array.isArray(g.marks) && g.marks.length >= 1 && g.marks.length <= 9
  && (g.pad === undefined || (Array.isArray(g.pad) && g.pad.length === 4 && g.pad.every((n) => Number.isInteger(n) && n >= 0)))
  && (g.r === undefined || (Number.isInteger(g.r) && g.r >= 8 && g.r <= 40))
  && g.marks.every((m) => m && Array.isArray(m.at) && m.at.length === 2 && m.at.every(Number.isFinite)
    && (m.box === undefined || (Array.isArray(m.box) && m.box.length === 4 && m.box.every(Number.isFinite)))
    && (m.to === undefined || (Array.isArray(m.to) && m.to.length === 2 && m.to.every(Number.isFinite))));

function readTable(root) {
  return JSON.parse(fs.readFileSync(path.join(root, TABLE), 'utf8'));
}

/** 表の1行の写真を作る → PNG の Buffer */
function deriveShot(root, s) {
  const img = decodePng(fs.readFileSync(path.join(root, s.from)));
  return encodeSmall(cropImage(img, s.crop));
}

function checkShots(root = ROOT) {
  const out = [];
  const bad = (code, file, msg) => out.push({ code, file, msg });
  let table;
  try { table = readTable(root); } catch (e) { bad('bad-table', TABLE, `読めない: ${e.message}`); return out; }
  if (!table || !Array.isArray(table.shots)) { bad('bad-table', TABLE, 'shots の配列が無い'); return out; }
  const names = new Set();
  const listed = new Set();
  for (const s of table.shots) {
    if (!s || !NAME.test(s.name) || names.has(s.name) || typeof s.from !== 'string' || !FROM.test(s.from) || !validCrop(s.crop)) {
      bad('bad-table', TABLE, `形の違う行: ${JSON.stringify(s)}`);
      continue;
    }
    names.add(s.name);
    const file = `${SHOTS_DIR}/${s.name}.png`;
    listed.add(file);
    if (!isLight(s.from)) bad('not-light', TABLE, `${s.name}: 明るい版の基準だけを使う（${s.from}）`);
    const fromPath = path.join(root, s.from);
    if (!fs.existsSync(fromPath)) { bad('no-from', s.from, `${s.name}: 元の基準の写真が無い`); continue; }
    const base = fs.readFileSync(fromPath);
    if (fingerprint(base) !== s.fromSha256) bad('from-changed', s.from, `${s.name}: アプリの基準の写真が変わった。node tools/help-appshots.js で作り直し、この写真を使う記事を読み直す`);
    const p = path.join(root, file);
    if (!fs.existsSync(p)) { bad('no-file', file, `${s.name}: 写真が無い（node tools/help-appshots.js）`); continue; }
    const baseImg = decodePng(base);
    if (!validCrop(s.crop, baseImg)) { bad('bad-table', TABLE, `${s.name}: 切り抜きが元の写真の外に出る`); continue; }
    const want = cropImage(baseImg, s.crop);
    let got;
    try { got = decodePng(fs.readFileSync(p)); } catch (e) { got = null; }
    if (!got || got.width !== want.width || got.height !== want.height || !got.data.equals(want.data)) bad('pixels-differ', file, `${s.name}: 元の写真の切り抜きと画素が違う`);
  }
  for (const g of table.figures || []) {
    if (!validFigure(g, names) || listed.has(`${SHOTS_DIR}/${g.name}.svg`)) { bad('bad-table', TABLE, `形の違う図: ${JSON.stringify(g).slice(0, 120)}`); continue; }
    const file = `${SHOTS_DIR}/${g.name}.svg`;
    listed.add(file);
    const p = path.join(root, file);
    const pngPath = path.join(root, SHOTS_DIR, `${g.shot}.png`);
    if (!fs.existsSync(p) || !fs.existsSync(pngPath)) { bad('no-file', file, `${g.name}: 図が無い（node tools/help-appshots.js）`); continue; }
    if (fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n') !== figureSvg(g, fs.readFileSync(pngPath))) bad('figure-differs', file, `${g.name}: node tools/help-appshots.js で作り直す（手で直さない）`);
  }
  const dir = path.join(root, SHOTS_DIR);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      const rel = `${SHOTS_DIR}/${f}`;
      if (!listed.has(rel)) bad('not-in-table', rel, `${TABLE} に無いファイル（写真はアプリのテストの基準からだけ作る）`);
      if (fs.statSync(path.join(dir, f)).size > MAX_IMAGE_BYTES) bad('too-big', rel, `1枚 ${MAX_IMAGE_BYTES} バイトまで`);
    }
  }
  return out;
}

/** 表を書く（数の配列は1行に） */
function writeTable(root, table) {
  const text = JSON.stringify(table, null, 2).replace(/\[\s+(-?\d+(?:,\s+-?\d+)*)\s+\]/g, (_, xs) => `[${xs.split(/,\s+/).join(', ')}]`);
  fs.writeFileSync(path.join(root, TABLE), text + '\n');
}

function main(root = ROOT) {
  const table = readTable(root);
  const dir = path.join(root, SHOTS_DIR);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let big = 0;
  for (const s of table.shots) {
    s.fromSha256 = fingerprint(fs.readFileSync(path.join(root, s.from)));
    const png = deriveShot(root, s);
    fs.writeFileSync(path.join(dir, `${s.name}.png`), png);
    if (png.length > MAX_IMAGE_BYTES) big++;
    process.stdout.write(`${png.length > MAX_IMAGE_BYTES ? 'NG' : 'OK'} shots/${s.name}.png ${png.length} バイト（${s.from}${s.crop ? ` の [${s.crop.join(', ')}]` : ''}）\n`);
  }
  for (const g of table.figures || []) {
    const svg = figureSvg(g, fs.readFileSync(path.join(dir, `${g.shot}.png`)));
    fs.writeFileSync(path.join(dir, `${g.name}.svg`), svg);
    const n = Buffer.byteLength(svg);
    if (n > MAX_IMAGE_BYTES) big++;
    process.stdout.write(`${n > MAX_IMAGE_BYTES ? 'NG' : 'OK'} shots/${g.name}.svg ${n} バイト（${g.shot} に印 ${g.marks.length} 個）\n`);
  }
  writeTable(root, table);
  const left = checkShots(root);
  for (const p of left) process.stderr.write(`${p.code} ${p.file} ${p.msg}\n`);
  if (big || left.length) return 1;
  process.stdout.write(`作りました: 写真 ${table.shots.length} 枚・図 ${(table.figures || []).length} 枚。写真の変わった記事を読み直してから commit してください\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { checkShots, figureSvg, DIGITS, deriveShot, cropImage, encodeSmall, fingerprint, isLight, TABLE, SHOTS_DIR, MAX_IMAGE_BYTES };
