/*
 * zipread.test.js — zip を依存なしで読む src/zipread.js
 *
 * 取り込んだ zip の目次から、決めたファイルだけを伸ばす。危ない名前（..・絶対・
 * ドライブ付き）、暗号化、ZIP64、知らない方式、CRC の違い、切れた zip、伸ばすと
 * 記録より大きくなるもの（zip 爆弾）は読まない（第0b回 R7、RF3）。
 * zip は test/helpers/zipwrite.js で作る（src/zipread.js に頼らない）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { listZip, readEntry } = require('../src/zipread');
const { makeZip } = require('./helpers/zipwrite');

test('zip: 無圧縮・deflate・データ記述子つきを読み、名前の \\ を / にそろえる', async () => {
  const z = makeZip([
    { name: 'Release/a.exe', data: Buffer.alloc(1000, 65) },
    { name: 'b.dll', data: Buffer.from('BB'), method: 0 },
    { name: 'Release\\c.dll', data: Buffer.alloc(50, 67), descriptor: true },
  ]);
  const es = listZip(z);
  assert.deepStrictEqual(es.map((e) => e.name), ['Release/a.exe', 'b.dll', 'Release/c.dll']);
  assert.deepStrictEqual(await readEntry(z, es[0]), Buffer.alloc(1000, 65));
  assert.deepStrictEqual(await readEntry(z, es[2]), Buffer.alloc(50, 67));
});

test('zip: 危ない名前・暗号化・ZIP64・知らない方式・CRC の違い・切れた zip を断る', async () => {
  for (const name of ['../x', 'a/../../x', '/x', 'C:/x', 'C:\\x']) {
    assert.throws(() => listZip(makeZip([{ name, data: Buffer.from('x') }])), { code: 'zip-name' }, name);
  }
  assert.throws(() => listZip(makeZip([{ name: 'a', data: Buffer.from('x'), flags: 1 }])), { code: 'zip-encrypted' });
  assert.throws(() => listZip(makeZip([{ name: 'a', data: Buffer.from('x'), zip64: true }])), { code: 'zip64' });
  assert.throws(() => listZip(makeZip([{ name: 'a', data: Buffer.from('x'), method: 12 }])), { code: 'zip-method' });
  const bad = makeZip([{ name: 'a', data: Buffer.from('hello'), badCrc: true }]);
  await assert.rejects(readEntry(bad, listZip(bad)[0]), { code: 'zip-crc' });
  assert.throws(() => listZip(bad.subarray(0, bad.length - 10)), { code: 'zip-eocd' });
});

test('zip: 伸ばすと記録より大きくなるもの（zip 爆弾）は途中で止める', async () => {
  const z = makeZip([{ name: 'a', data: Buffer.alloc(100000) }]);
  const e = { ...listZip(z)[0], size: 10 };
  await assert.rejects(readEntry(z, e), (err) => err.code === 'zip-size' || /maxOutputLength|buffer/i.test(err.message));
});

// 計画の3件の後に足した1件: 上の1件は、全部を伸ばしてから大きさを比べても通ってしまう。
// 伸ばす量そのものを記録の大きさで止めている（maxOutputLength）ことを押さえる。
test('zip: deflate は記録の大きさまでしか伸ばさない（全部を伸ばしてから比べない）', async () => {
  const zlib = require('zlib');
  const z = makeZip([{ name: 'a', data: Buffer.alloc(100000) }]);
  const e = { ...listZip(z)[0], size: 10 };
  const orig = zlib.inflateRaw;
  const seen = [];
  zlib.inflateRaw = (data, opts, cb) => { seen.push(opts && opts.maxOutputLength); return orig(data, opts, cb); };
  try {
    await assert.rejects(readEntry(z, e), { code: 'zip-size' });
  } finally {
    zlib.inflateRaw = orig;
  }
  assert.deepStrictEqual(seen, [10]);
});

// 点検の指摘で足した3件: 上の4件は、次の3つの直しを戻しても緑のままだった。
//  - 中身の始まりに項目の見出しの extra の長さを足す（makeZip は extra を書かないので、いつも 0 だった）
//  - 伸ばした大きさ・無圧縮の大きさが記録より小さいときの zip-size（大きい側は maxOutputLength で止まる）
//  - UTF-8 の印（0x800）のある名前を UTF-8 で読む（どの名前も英数字だった）

// 項目の見出し（ローカルヘッダー）ごとに、中央ディレクトリには無い extra の欄を差し込む。
// 上流の zip には見出しに extra を持つものがある（同じリリースの vulkan 版は 28 バイト）。
// makeZip の zip だけを相手にし（注釈なし・項目は目次の順）、src/zipread.js には頼らない。
function withLocalExtra(z, extra) {
  const eocd = z.length - 22;
  const count = z.readUInt16LE(eocd + 10);
  const cdOff = z.readUInt32LE(eocd + 16);
  const cd = Buffer.from(z.subarray(cdOff, eocd));
  const offs = [];
  for (let i = 0, p = 0; i < count; i++) {
    offs.push(cd.readUInt32LE(p + 42));
    cd.writeUInt32LE(offs[i] + i * extra.length, p + 42);
    p += 46 + cd.readUInt16LE(p + 28) + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
  }
  const parts = [];
  offs.forEach((at, i) => {
    const nlen = z.readUInt16LE(at + 26);
    const head = Buffer.from(z.subarray(at, at + 30 + nlen));
    head.writeUInt16LE(extra.length, 28);
    parts.push(head, extra, z.subarray(at + 30 + nlen, i + 1 < count ? offs[i + 1] : cdOff));
  });
  const end = Buffer.from(z.subarray(eocd));
  end.writeUInt32LE(cdOff + count * extra.length, 16);
  return Buffer.concat([...parts, cd, end]);
}

test('zip: 項目の見出しの extra を飛ばして中身を読む（無圧縮・deflate・データ記述子つき）', async () => {
  const z = withLocalExtra(makeZip([
    { name: 'Release/a.dll', data: Buffer.alloc(300, 7) },
    { name: 'b.dll', data: Buffer.from('BB'), method: 0 },
    { name: 'Release\\c.dll', data: Buffer.alloc(40, 9), descriptor: true },
  ]), Buffer.alloc(28, 0x55));
  const es = listZip(z);
  assert.deepStrictEqual(es.map((e) => z.readUInt16LE(e.offset + 28)), [28, 28, 28]);
  assert.deepStrictEqual(await readEntry(z, es[0]), Buffer.alloc(300, 7));
  assert.deepStrictEqual(await readEntry(z, es[1]), Buffer.from('BB'));
  assert.deepStrictEqual(await readEntry(z, es[2]), Buffer.alloc(40, 9));
});

test('zip: 伸ばした大きさ・無圧縮の大きさが記録と違えば zip-size（記録より小さくても）', async () => {
  const z = makeZip([
    { name: 'a', data: Buffer.alloc(300, 7) },
    { name: 'b', data: Buffer.from('BB'), method: 0 },
  ]);
  const es = listZip(z);
  await assert.rejects(readEntry(z, { ...es[0], size: es[0].size + 1 }), { code: 'zip-size' });
  await assert.rejects(readEntry(z, { ...es[1], size: es[1].size + 1 }), { code: 'zip-size' });
  await assert.rejects(readEntry(z, { ...es[1], size: es[1].size - 1 }), { code: 'zip-size' });
});

test('zip: UTF-8 の印（0x800）のある名前は UTF-8 で読む', async () => {
  const z = makeZip([{ name: 'Release/取込𠮷.txt', data: Buffer.from('x') }]);
  const es = listZip(z);
  assert.deepStrictEqual(es.map((e) => e.name), ['Release/取込𠮷.txt']);
  assert.deepStrictEqual(await readEntry(z, es[0]), Buffer.from('x'));
});
