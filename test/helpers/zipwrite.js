'use strict';
// テスト用の zip を作る（無圧縮・deflate・データ記述子・壊れた形）。src/zipread.js に頼らない。
const zlib = require('zlib');

const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = TABLE[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

function makeZip(entries) {
  const locals = []; const cds = []; let off = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    const method = e.method == null ? 8 : e.method;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = e.badCrc ? (crc32(data) ^ 1) >>> 0 : crc32(data);
    const name = Buffer.from(e.name, 'utf8');
    const dd = Boolean(e.descriptor);
    const flags = (e.flags || 0) | (dd ? 8 : 0) | 0x800;
    const big = e.zip64 ? 0xFFFFFFFF : null;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(dd ? 0 : crc, 14); lh.writeUInt32LE(dd ? 0 : (big || comp.length), 18); lh.writeUInt32LE(dd ? 0 : (big || data.length), 22);
    lh.writeUInt16LE(name.length, 26);
    const desc = dd ? Buffer.alloc(16) : Buffer.alloc(0);
    if (dd) { desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc, 4); desc.writeUInt32LE(comp.length, 8); desc.writeUInt32LE(data.length, 12); }
    locals.push(lh, name, comp, desc);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(big || comp.length, 20); ch.writeUInt32LE(big || data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    cds.push(ch, name);
    off += 30 + name.length + comp.length + desc.length;
  }
  const cd = Buffer.concat(cds);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { makeZip, crc32 };
