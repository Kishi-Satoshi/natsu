/*
 * zipread.js — zip を依存なしで読む（取り込んだエンジンの zip から、決めたファイルだけを伸ばす）
 *
 * 終わりの目次（EOCD）を後ろから探し、中央ディレクトリから項目の並びを作る。大きさは
 * 中央ディレクトリから読むので、データ記述子つきの項目でも正しい。伸ばすのは zlib.inflateRaw
 * （非同期）で、main の中で動かしても記録中に main を止めない（updater.js の Expand-Archive の
 * execFileSync と違って）。
 *
 * 断るもの（Error の code）:
 *  - zip-eocd       終わりの目次が無い（切れた zip など）
 *  - zip64          ZIP64 の印（0xFFFF / 0xFFFFFFFF）
 *  - zip-encrypted  暗号化（フラグの 1 ビット目）
 *  - zip-method     方式が 0（無圧縮）と 8（deflate）以外
 *  - zip-name       名前が空・絶対（/x）・ドライブ付き（C:/x）・.. を含む
 *  - zip-size       伸ばした大きさが記録と違う（記録より大きくなるものは途中で止める）
 *  - zip-crc        CRC-32 が記録と違う
 *  - zip-corrupt    目次や項目の見出しが壊れている・範囲の外を指す・deflate が読めない
 *
 * 名前の \ は / にそろえる（PowerShell 5.1 の Compress-Archive が \ で書く）。
 * Electron のモジュールは読み込まない。通信もしない。
 */
'use strict';

const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const zipError = (code, message, cause) => Object.assign(new Error(`zip: ${message}`), { code }, cause ? { cause } : {});

function safeName(raw) {
  const name = raw.replace(/\\/g, '/');
  if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
    throw zipError('zip-name', `危ない名前 ${JSON.stringify(raw)}`);
  }
  return name;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xFFFF);   // 注釈は最大 65535 バイト
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD && i + 22 + buf.readUInt16LE(i + 20) <= buf.length) return i;
  }
  throw zipError('zip-eocd', '終わりの目次が見つからない（切れた zip？）');
}

function listZip(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) throw zipError('zip64', 'ZIP64 は読まない');
  const cdEnd = cdOff + cdSize;
  if (cdEnd > eocd) throw zipError('zip-corrupt', '中央ディレクトリが範囲の外');
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdEnd || buf.readUInt32LE(p) !== SIG_CEN) throw zipError('zip-corrupt', `中央ディレクトリの ${i + 1} 番目が壊れている`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const next = p + 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    if (next > cdEnd) throw zipError('zip-corrupt', `中央ディレクトリの ${i + 1} 番目が範囲の外`);
    const raw = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen);
    if (csize === 0xFFFFFFFF || size === 0xFFFFFFFF || offset === 0xFFFFFFFF) throw zipError('zip64', `ZIP64 は読まない（${raw}）`);
    if (flags & 1) throw zipError('zip-encrypted', `暗号化された項目は読まない（${raw}）`);
    if (method !== 0 && method !== 8) throw zipError('zip-method', `方式 ${method} は読まない（${raw}）`);
    out.push({ name: safeName(raw), method, flags, crc32: crc, csize, size, offset });
    p = next;
  }
  return out;
}

function inflateRaw(data, maxOutputLength) {
  return new Promise((resolve, reject) => {
    zlib.inflateRaw(data, { maxOutputLength }, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

async function readEntry(buf, entry) {
  const at = entry.offset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== SIG_LOC) throw zipError('zip-corrupt', `項目の見出しが壊れている（${entry.name}）`);
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  if (start + entry.csize > buf.length) throw zipError('zip-corrupt', `中身が切れている（${entry.name}）`);
  const data = buf.subarray(start, start + entry.csize);
  let out;
  if (entry.method === 0) {
    out = Buffer.from(data);
  } else if (entry.method === 8) {
    try {
      out = await inflateRaw(data, Math.max(1, entry.size));   // 記録より大きくなれば途中で止める（zip 爆弾）
    } catch (err) {
      if (err && err.code === 'ERR_BUFFER_TOO_LARGE') throw zipError('zip-size', `伸ばすと記録の ${entry.size} バイトより大きい（${entry.name}）`, err);
      throw zipError('zip-corrupt', `deflate を読めない（${entry.name}）`, err);
    }
  } else {
    throw zipError('zip-method', `方式 ${entry.method} は読まない（${entry.name}）`);
  }
  if (out.length !== entry.size) throw zipError('zip-size', `大きさが記録と違う（${entry.name}: ${out.length} / ${entry.size}）`);
  if (crc32(out) !== entry.crc32) throw zipError('zip-crc', `CRC-32 が記録と違う（${entry.name}）`);
  return out;
}

module.exports = { listZip, readEntry };
