#!/usr/bin/env node
'use strict';
// PNG（RGBA 8bit）の読み書きと、ICO（中身は PNG）の組み立て・読み取り。
// 依存は足さない（node の zlib だけ）。ロゴの描き出しと、アイコンの検査（test/icons.test.js）が使う。
//
//   node tools/ico.js <out.ico> <in.png>...   … PNG を小さい順に並べて ICO を書き出す
//
// 扱うのは 8bit・色の型 6（RGBA）・インターレースなしの PNG だけ。それ以外は読まずに投げる。

const fs = require('fs');
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC32（PNG の塊の検査）。表は自前で作る。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const isSize = (n) => Number.isInteger(n) && n > 0 && n <= 0x7fffffff;

// 8bit・色の型 6（RGBA）・各行のフィルタ 0 で書く。
function encodePng(width, height, rgba) {
  if (!isSize(width) || !isSize(height)) throw new Error(`PNG の大きさが正しくない: ${width}x${height}`);
  if (!Buffer.isBuffer(rgba) || rgba.length !== width * height * 4) {
    throw new Error(`RGBA の長さが ${width}x${height}x4 と合わない: ${rgba && rgba.length}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 圧縮・フィルタ・インターレースは 0
  const st = width * 4;
  const raw = Buffer.alloc((st + 1) * height); // 各行の先頭 1 バイトはフィルタの種類（0）
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (st + 1) + 1, y * st, (y + 1) * st);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// 8bit・色の型 6 だけを読む。IDAT が複数あればつないで解く。フィルタは 0〜4。
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('PNG ではない（先頭の8バイトが違う）');
  let p = 8, ihdr = null, ended = false;
  const idat = [];
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (p + 12 + len > buf.length) throw new Error(`PNG の塊 ${type} が途中で切れている`);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (crc32(buf.subarray(p + 4, p + 8 + len)) !== buf.readUInt32BE(p + 8 + len)) throw new Error(`PNG の塊 ${type} の CRC が合わない（壊れている）`);
    if (!ihdr && type !== 'IHDR') throw new Error('PNG の最初の塊が IHDR ではない');
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { ended = true; break; }
    p += 12 + len;
  }
  if (!ihdr || ihdr.length !== 13) throw new Error('PNG の IHDR が無い');
  if (!ended) throw new Error('PNG の IEND が無い（途中で切れている）');
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const depth = ihdr[8], color = ihdr[9];
  if (depth !== 8) throw new Error(`8bit の PNG だけを読む（この PNG は ${depth}bit）`);
  if (color !== 6) throw new Error(`色の型 6（RGBA）の PNG だけを読む（この PNG は色の型 ${color}）`);
  if (ihdr[10] !== 0 || ihdr[11] !== 0) throw new Error('PNG の圧縮かフィルタの方式が 0 ではない');
  if (ihdr[12] !== 0) throw new Error('インターレースの PNG は読まない');
  if (!isSize(width) || !isSize(height)) throw new Error(`PNG の大きさが正しくない: ${width}x${height}`);

  const st = width * 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (st + 1) * height) throw new Error('PNG の画素が足りない');
  const out = Buffer.alloc(st * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (st + 1)];
    const src = y * (st + 1) + 1, cur = y * st, prev = cur - st;
    for (let i = 0; i < st; i++) {
      const x = raw[src + i];
      const a = i >= 4 ? out[cur + i - 4] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = (i >= 4 && y > 0) ? out[prev + i - 4] : 0;
      let v;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else if (ft === 4) v = x + paeth(a, b, c);
      else throw new Error(`PNG の ${y} 行目のフィルタの種類 ${ft} を知らない`);
      out[cur + i] = v & 0xff;
    }
  }
  return { width, height, rgba: out };
}

// PNG の IHDR から幅と高さを取る（中身は解かない）
function pngSize(png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(SIG) || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('ICO に入れるのは PNG だけ（先頭が PNG の形ではない）');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// PNG をそのまま入れた ICO を組み立てる。大きさは IHDR から取り、小さい順に並べる。
function packIco(pngs) {
  if (!Array.isArray(pngs) || !pngs.length) throw new Error('ICO に入れる PNG が無い');
  const items = pngs.map((png) => ({ png, ...pngSize(png) }));
  for (const it of items) {
    if (it.width < 1 || it.width > 256 || it.height < 1 || it.height > 256) throw new Error(`ICO に入る大きさは 1〜256: ${it.width}x${it.height}`);
  }
  items.sort((x, y) => (x.width - y.width) || (x.height - y.height));
  const head = Buffer.alloc(6 + 16 * items.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(items.length, 4);
  let offset = head.length;
  items.forEach((it, i) => {
    const o = 6 + 16 * i;
    head[o] = it.width === 256 ? 0 : it.width;
    head[o + 1] = it.height === 256 ? 0 : it.height;
    head[o + 2] = 0; // 色数
    head[o + 3] = 0; // 予約
    head.writeUInt16LE(1, o + 4);  // planes
    head.writeUInt16LE(32, o + 6); // bpp
    head.writeUInt32LE(it.png.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += it.png.length;
  });
  return Buffer.concat([head, ...items.map((it) => it.png)]);
}

// ICO の項目を、ファイルの順に読む。中身が PNG でない項目（BMP）は扱わないので投げる。
function parseIco(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('ICO ではない（頭の 6 バイトが違う）');
  const n = buf.readUInt16LE(4);
  if (buf.length < 6 + 16 * n) throw new Error('ICO の項目が途中で切れている');
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + 16 * i;
    const width = buf[o] || 256, height = buf[o + 1] || 256;
    const planes = buf.readUInt16LE(o + 4), bpp = buf.readUInt16LE(o + 6);
    const size = buf.readUInt32LE(o + 8), offset = buf.readUInt32LE(o + 12);
    if (offset + size > buf.length) throw new Error(`ICO の ${i + 1} 番目の中身がファイルの外を指している`);
    const png = buf.subarray(offset, offset + size);
    if (size < 8 || !png.subarray(0, 8).equals(SIG)) throw new Error(`ICO の ${i + 1} 番目（${width}x${height}）の中身が PNG ではない`);
    out.push({ width, height, planes, bpp, size, offset, png });
  }
  return out;
}

module.exports = { encodePng, decodePng, packIco, parseIco, crc32 };

if (require.main === module) {
  const [, , out, ...ins] = process.argv;
  if (!out || !ins.length) { console.error('usage: node tools/ico.js <out.ico> <in.png>...'); process.exit(2); }
  if (!/\.ico$/i.test(out)) { console.error(`書き出し先は .ico にする（PNG を上書きしないように）: ${out}`); process.exit(2); }
  const ico = packIco(ins.map((f) => fs.readFileSync(f)));
  fs.writeFileSync(out, ico);
  console.log(`${out}: ${parseIco(ico).map((e) => e.width).join(', ')} px`);
}
