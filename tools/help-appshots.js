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
// checkShots(root) → [{ code, file, msg }]（空なら全部よい）。code:
//   bad-table（表の形）・not-light（明るい版の基準でない）・no-from（基準の写真が無い）・from-changed（基準の指紋が違う）・
//   no-file（作った写真が無い）・pixels-differ（作った写真が元の切り抜きと画素で違う）・not-in-table（表に無いファイル）・too-big（100KB を越える）

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
  writeTable(root, table);
  const left = checkShots(root);
  for (const p of left) process.stderr.write(`${p.code} ${p.file} ${p.msg}\n`);
  if (big || left.length) return 1;
  process.stdout.write(`作りました: ${table.shots.length} 枚。写真の変わった記事を読み直してから commit してください\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { checkShots, deriveShot, cropImage, encodeSmall, fingerprint, isLight, TABLE, SHOTS_DIR, MAX_IMAGE_BYTES };
