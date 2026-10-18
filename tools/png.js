'use strict';
// PNG の部品（第1a回 G2）。画面の比較（tools/shots）が使う。npm の依存は足さず、Node の zlib だけで作る。
//
//   crc32(buf)                         … PNG の塊の CRC（符号なし 32 ビット）
//   encodePng({ width, height, data }) … RGBA（width*height*4 バイト）→ PNG の Buffer（8 ビット・色の型 6・行のフィルタはいつも 0）
//   decodePng(buf)                     → { width, height, data（RGBA） }
//   diffImages(a, b, { tolerance })    → { same, sizeMismatch, count, box, image（差分の画像） }
//
// PNG の決まり（https://www.w3.org/TR/png-3/）のうち、使うところ:
//  - 署名は 89 50 4E 47 0D 0A 1A 0A。続く塊は「長さ（4）・種類（4）・中身・CRC（4）」。CRC は種類と中身に掛ける。
//  - CRC は多項式 0xEDB88320（反転した形）の CRC-32。初めの値は 0xFFFFFFFF、最後に全ビットを反転する（IEND の CRC は AE 42 60 82）。
//  - 画素は IDAT（いくつあってもつないで1つの zlib の流れ）。行ごとに先頭1バイトのフィルタの種類が付く。
//    フィルタは x を今の値、a を左（同じ行の1画素前の同じ色）、b を上（前の行の同じ位置）、c を左上として、
//    0 なし: x / 1 Sub: x + a / 2 Up: x + b / 3 Average: x + floor((a + b) / 2) / 4 Paeth: x + Paeth(a, b, c)（どれも 256 で割った余り）。
//    行の外（左端より左・最初の行の上）は 0 とみなす。
//  - Paeth(a, b, c): p = a + b - c とし、|p-a|・|p-b|・|p-c| の一番小さいものを選ぶ。同じなら a、b、c の順に選ぶ。
//
// 読むのは 8 ビット・色の型 2（RGB。Electron の toPNG() が出す）と 6（RGBA。録音バーの透ける画面）・飛び越し（インターレース）なしだけ。
// それ以外（パレット・灰色・16 ビット・飛び越しあり）と、署名・CRC・長さが合わないものは投げる（黙って違う画素を返さない）。

const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 2: 3, 6: 4 };   // 色の型 → 1画素のバイト数（8 ビット）

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
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const isSize = (n) => Number.isInteger(n) && n > 0 && n <= 0x7fffffff;

function checkImage({ width, height, data }, what) {
  if (!isSize(width) || !isSize(height)) throw new Error(`${what}の大きさが正しくない: ${width}x${height}`);
  if (!Buffer.isBuffer(data) || data.length !== width * height * 4) {
    throw new Error(`${what}の RGBA の長さが ${width}x${height}x4 と合わない: ${data && data.length}`);
  }
}

function encodePng({ width, height, data }) {
  checkImage({ width, height, data }, 'PNG ');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // ビットの深さ
  ihdr[9] = 6;   // 色の型 6（RGBA）。圧縮・フィルタの方式・飛び越しは 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);   // 各行の先頭1バイトはフィルタの種類（0 = なし）
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// フィルタを外す（raw の中で行ごとに書き換える）。bpp は1画素のバイト数。
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;   // y = 0 のときは使わない（上は 0）
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[row + i - bpp] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = (i >= bpp && y > 0) ? out[prev + i - bpp] : 0;
      let v;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else if (ft === 4) v = x + paeth(a, b, c);
      else throw new Error(`PNG の行 ${y} のフィルタの種類 ${ft} は決まりに無い`);
      out[row + i] = v & 0xff;
    }
  }
  return out;
}

function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('PNG ではない（先頭の8バイトの署名が違う）');
  let p = 8;
  let ihdr = null;
  let ended = false;
  const idat = [];
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (len > buf.length - p - 12) throw new Error(`PNG の塊 ${type} が途中で切れている`);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (crc32(buf.subarray(p + 4, p + 8 + len)) !== buf.readUInt32BE(p + 8 + len)) throw new Error(`PNG の塊 ${type} の CRC が合わない（壊れている）`);
    if (!ihdr && type !== 'IHDR') throw new Error('PNG の最初の塊が IHDR ではない');
    if (type === 'IHDR') {
      if (ihdr) throw new Error('PNG の IHDR が2つある');
      ihdr = data;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { ended = true; break; }
    p += 12 + len;
  }
  if (!ihdr || ihdr.length !== 13) throw new Error('PNG の IHDR が無いか、長さが違う');
  if (!ended) throw new Error('PNG の IEND が無い（途中で切れている）');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [depth, colorType, compression, filterMethod, interlace] = ihdr.subarray(8, 13);
  if (!isSize(width) || !isSize(height)) throw new Error(`PNG の大きさが正しくない: ${width}x${height}`);
  if (depth !== 8) throw new Error(`PNG のビットの深さ ${depth} は読まない（8 だけ）`);
  const bpp = CHANNELS[colorType];
  if (!bpp) throw new Error(`PNG の色の型 ${colorType} は読まない（2 = RGB と 6 = RGBA だけ）`);
  if (compression !== 0 || filterMethod !== 0) throw new Error('PNG の圧縮かフィルタの方式が決まりと違う');
  if (interlace !== 0) throw new Error('飛び越し（インターレース）の PNG は読まない');
  if (!idat.length) throw new Error('PNG に IDAT が無い');
  const expected = height * (1 + width * bpp);
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });   // 決まった長さより大きくなれば途中で止める
  } catch (err) {
    throw new Error(`PNG の IDAT を解けない: ${err.message}`);
  }
  if (raw.length !== expected) throw new Error(`PNG の画素の長さが合わない: ${raw.length}（${expected} のはず）`);
  const px = unfilter(raw, width, height, bpp);
  if (bpp === 4) return { width, height, data: px };
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    data[j] = px[i];
    data[j + 1] = px[i + 1];
    data[j + 2] = px[i + 2];
    data[j + 3] = 255;
  }
  return { width, height, data };
}

// 同じ画素は薄い灰（元の明るさを 200〜255 に縮めて、どこが違うかの目印に形だけ残す）。違う画素は赤。
function faint(d, i) {
  const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  return 200 + Math.round(lum * 55 / 255);
}

function diffImages(a, b, { tolerance = 0 } = {}) {
  checkImage(a, '比べる前の画像');
  checkImage(b, '比べる後の画像');
  if (a.width !== b.width || a.height !== b.height) {
    const width = Math.max(a.width, b.width);
    const height = Math.max(a.height, b.height);
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 3] = 255; }
    return { same: false, sizeMismatch: true, count: width * height, box: { x0: 0, y0: 0, x1: width - 1, y1: height - 1 }, image: { width, height, data } };
  }
  const { width, height } = a;
  const data = Buffer.alloc(width * height * 4);
  let count = 0;
  let box = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let differs = false;
      for (let k = 0; k < 4; k++) {
        if (Math.abs(a.data[i + k] - b.data[i + k]) > tolerance) { differs = true; break; }
      }
      if (differs) {
        count++;
        data[i] = 255; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
        if (!box) box = { x0: x, y0: y, x1: x, y1: y };
        else {
          if (x < box.x0) box.x0 = x;
          if (x > box.x1) box.x1 = x;
          box.y1 = y;   // 上から順に見るので、y は増えるだけ
        }
      } else {
        const g = faint(b.data, i);
        data[i] = g; data[i + 1] = g; data[i + 2] = g; data[i + 3] = 255;
      }
    }
  }
  return { same: count === 0, sizeMismatch: false, count, box, image: { width, height, data } };
}

module.exports = { crc32, encodePng, decodePng, diffImages };
