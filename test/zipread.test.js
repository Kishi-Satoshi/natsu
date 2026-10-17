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
