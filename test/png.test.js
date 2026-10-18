/*
 * png.test.js — PNG の部品（第1a回 G2。tools/png.js）
 * 見本の PNG は、別の道具で作ったもの（Python の zlib で行ごとにフィルタを手で掛けたもの4つと、ImageMagick が書いた RGBA の1つ）。
 * どれも ImageMagick（convert … txt:-）で読み戻して、下の6つの画素になることを確かめてある（計画の「調べた結果」の 10）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const P = require('../tools/png');

const PIX = [[10, 20, 30], [200, 100, 50], [0, 255, 128], [255, 255, 255], [1, 2, 3], [90, 80, 70]];   // 3×2、左上から
const RGBA = Buffer.from(PIX.flatMap((p) => [...p, 255]));
const FIXTURES = {
  sub_up: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAHUlEQVR42mPkEpHbFyBiMduP6evrh5bzLkYFHgMAQ8AIXZjkcqMAAAAASUVORK5CYII=',
  avg_paeth: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAHUlEQVR42mPmEpE7HKU852w6y9fXD5mYWaLeiAAARzIHeNRjWZkAAAAASUVORK5CYII=',
  paeth_avg: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAHElEQVR42mPhEpHbFyBiMduP+dfXD3KB2VEXWAFBbgdvry7JXgAAAABJRU5ErkJggg==',
  none_sub: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAHElEQVR42mPgEpE7kWLE8L+B8f///0zMLJF+zgBEywcLp6sKdAAAAABJRU5ErkJggg==',
  imagemagick_rgba: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAI0lEQVQI12PgEpH7fyLF6D/D/4b/LF9fP2RgYmZhiHojwgAAkfIKP1axwy4AAAAASUVORK5CYII=',
};

test('G2: crc32 は PNG の決まりの値（IEND の CRC は AE 42 60 82）', { timeout: 5000 }, () => {
  assert.strictEqual(P.crc32(Buffer.from('IEND', 'ascii')), 0xae426082);
  assert.strictEqual(P.crc32(Buffer.alloc(0)), 0);
});

test('G2: 別の道具が作った PNG を、フィルタ 0〜4 と色の型 2・6 のどれでも同じ画素に読む', { timeout: 5000 }, () => {
  for (const [name, b64] of Object.entries(FIXTURES)) {
    const im = P.decodePng(Buffer.from(b64, 'base64'));
    assert.deepStrictEqual([im.width, im.height], [3, 2], name);
    assert.ok(im.data.equals(RGBA), `${name}: ${[...im.data].join(',')}`);
  }
});

test('G2: 自分で書いた PNG（RGBA）を読み戻すと同じ画素（透けた画素も）。zlib の inflate で読める形', { timeout: 5000 }, () => {
  const data = Buffer.from([0, 0, 0, 0, 255, 0, 0, 128, 12, 34, 56, 255, 1, 1, 1, 1]);
  const buf = P.encodePng({ width: 2, height: 2, data });
  assert.deepStrictEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const im = P.decodePng(buf);
  assert.deepStrictEqual([im.width, im.height], [2, 2]);
  assert.ok(im.data.equals(data));
  const idatAt = buf.indexOf(Buffer.from('IDAT'));
  const len = buf.readUInt32BE(idatAt - 4);
  assert.strictEqual(zlib.inflateSync(buf.subarray(idatAt + 4, idatAt + 4 + len)).length, 2 * (1 + 2 * 4));
});

test('G2: CRC が合わない PNG・パレットの PNG・16 ビットの PNG は投げる', { timeout: 5000 }, () => {
  const good = Buffer.from(FIXTURES.sub_up, 'base64');
  const badCrc = Buffer.from(good);
  badCrc[badCrc.length - 1] ^= 0xff;   // IEND の CRC の最後の1バイト
  assert.throws(() => P.decodePng(badCrc), /CRC/);
  const pal = Buffer.from(good);
  pal[25] = 3;   // 色の型 3（パレット）
  assert.throws(() => P.decodePng(pal));
  const deep = Buffer.from(good);
  deep[24] = 16;
  assert.throws(() => P.decodePng(deep));
  assert.throws(() => P.decodePng(Buffer.from('not a png')), /PNG/);
});

test('G2: diffImages — 同じなら same。違えば数と範囲と差分の画像（違う画素は赤）。大きさが違えば sizeMismatch', { timeout: 5000 }, () => {
  const a = { width: 3, height: 2, data: Buffer.from(RGBA) };
  const b = { width: 3, height: 2, data: Buffer.from(RGBA) };
  assert.deepStrictEqual([P.diffImages(a, b).same, P.diffImages(a, b).count], [true, 0]);
  b.data[4 * 4 + 1] = 9;   // (1,1) の緑
  const d = P.diffImages(a, b);
  assert.deepStrictEqual([d.same, d.count, d.box], [false, 1, { x0: 1, y0: 1, x1: 1, y1: 1 }]);
  assert.deepStrictEqual([...d.image.data.subarray(16, 20)], [255, 0, 0, 255]);
  assert.notDeepStrictEqual([...d.image.data.subarray(0, 4)], [255, 0, 0, 255]);
  const s = P.diffImages(a, { width: 2, height: 2, data: Buffer.alloc(16) });
  assert.deepStrictEqual([s.same, s.sizeMismatch], [false, true]);
  // tolerance: 差が tolerance 以下なら同じ、越えたら違う（既定は 0）
  const c = { width: 3, height: 2, data: Buffer.from(RGBA) };
  c.data[0] += 2;
  assert.deepStrictEqual([P.diffImages(a, c).count, P.diffImages(a, c, { tolerance: 2 }).count, P.diffImages(a, c, { tolerance: 1 }).count], [1, 0, 1]);
});

test('G2: diffImages — 透け具合（A）だけの差も数える。範囲は違う画素を全部囲む。大きさが違えば大きいほうの大きさで全部赤', { timeout: 5000 }, () => {
  const a = { width: 3, height: 2, data: Buffer.from(RGBA) };
  const e = { width: 3, height: 2, data: Buffer.from(RGBA) };
  e.data[3] = 0;   // (0,0) の A だけ
  assert.strictEqual(P.diffImages(a, e).count, 1);
  const f = { width: 3, height: 2, data: Buffer.from(RGBA) };
  f.data[2 * 4] = 99;   // (2,0) の赤
  f.data[3 * 4 + 2] = 99;   // (0,1) の青
  const d = P.diffImages(a, f);
  assert.strictEqual(d.count, 2);
  assert.deepStrictEqual(d.box, { x0: 0, y0: 0, x1: 2, y1: 1 });   // 左へ広がる
  const g = { width: 3, height: 2, data: Buffer.from(RGBA) };
  g.data[1] = 99;   // (0,0) の緑
  g.data[5 * 4 + 1] = 99;   // (2,1) の緑
  assert.deepStrictEqual([P.diffImages(a, g).count, P.diffImages(a, g).box], [2, { x0: 0, y0: 0, x1: 2, y1: 1 }]);   // 右へ広がる
  const s = P.diffImages(a, { width: 2, height: 2, data: Buffer.alloc(16) });
  assert.deepStrictEqual([s.image.width, s.image.height], [3, 2]);
  assert.strictEqual(s.image.data.length, 3 * 2 * 4);
  for (let i = 0; i < s.image.data.length; i += 4) assert.deepStrictEqual([...s.image.data.subarray(i, i + 4)], [255, 0, 0, 255], `画素 ${i / 4}`);
});

test('G2: IHDR が2つある PNG と、画素の長さが IHDR の大きさと合わない PNG は投げる', { timeout: 5000 }, () => {
  const good = P.encodePng({ width: 3, height: 2, data: Buffer.from(RGBA) });
  const ihdrChunk = good.subarray(8, 8 + 12 + 13);   // 長さ・型・13 バイト・CRC
  const dup = Buffer.concat([good.subarray(0, 8 + 25), ihdrChunk, good.subarray(8 + 25)]);
  assert.throws(() => P.decodePng(dup), /IHDR が2つ/);
  const tall = Buffer.from(good);
  tall.writeUInt32BE(3, 8 + 8 + 4);   // 高さを 3 に（IDAT は 2 行ぶんのまま）
  tall.writeUInt32BE(P.crc32(tall.subarray(8 + 4, 8 + 8 + 13)), 8 + 8 + 13);
  assert.throws(() => P.decodePng(tall), /画素の長さ/);
});
