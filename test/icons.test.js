/*
 * icons.test.js — アイコン（ICO・PNG）の形を固定する（第0a回 R4）
 *
 *  - tools/ico.js: PNG（RGBA 8bit）を書いて読み戻せる。フィルタ 0〜4 を解き、IDAT が分かれていてもつなぐ
 *  - tools/ico.js: ICO は PNG をそのまま入れ、項目（256 は 0・planes 1・bpp 32）と中身が隙間なく続く
 *  - 今の assets/icon.ico と src/assets/tray.ico を読める（検査が空振りしない）
 *
 * 依存は足さない（node の zlib だけ）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { encodePng, decodePng, packIco, parseIco } = require('../tools/ico.js');

const ROOT = path.join(__dirname, '..');

// PNG の塊を手で作る（CRC は node の zlib.crc32。tools/ico.js の自前の表とは別の実装）
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngOf(ihdr, idats) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), ...idats.map((d) => pngChunk('IDAT', d)), pngChunk('IEND', Buffer.alloc(0))]);
}
function ihdrOf(w, h, depth = 8, type = 6) {
  const b = Buffer.alloc(13); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = depth; b[9] = type;
  return b;
}
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
};

test('ico.js: PNG を書いて読み戻せる（RGBA 8bit）', () => {
  const rgba = Buffer.alloc(2 * 2 * 4); rgba.writeUInt32BE(0x0e8caeff, 0);
  const png = encodePng(2, 2, rgba);
  assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const back = decodePng(png);
  assert.deepStrictEqual([back.width, back.height], [2, 2]);
  assert.deepStrictEqual(back.rgba, rgba);
});

test('ico.js: ICO は PNG をそのまま入れ、256 は幅の1バイトが 0・planes 1・bpp 32・中身が隙間なく続く', () => {
  const ico = packIco([256, 16].map((n) => encodePng(n, n, Buffer.alloc(n * n * 4))));
  assert.deepStrictEqual([...ico.subarray(0, 6)], [0, 0, 1, 0, 2, 0]);
  const e = parseIco(ico);
  assert.deepStrictEqual(e.map((x) => x.width), [16, 256]);
  assert.strictEqual(ico[6 + 16], 0);
  assert.deepStrictEqual(e.map((x) => [x.planes, x.bpp]), [[1, 32], [1, 32]]);
  assert.strictEqual(e[0].offset, 6 + 16 * 2);
  assert.strictEqual(e[1].offset, e[0].offset + e[0].size);
  assert.strictEqual(ico.length, e[1].offset + e[1].size);
});

test('ico.js: 今の assets/icon.ico と src/assets/tray.ico を読める（検査が空振りしない）', () => {
  assert.deepStrictEqual(parseIco(fs.readFileSync(path.join(ROOT, 'assets/icon.ico'))).map((x) => x.width), [16, 24, 32, 48, 64, 128, 256]);
  assert.deepStrictEqual(parseIco(fs.readFileSync(path.join(ROOT, 'src/assets/tray.ico'))).map((x) => x.width), [16, 20, 24, 32, 48, 64]);
});

test('ico.js: 行ごとのフィルタ 0〜4 を解き、分かれた IDAT をつないで読む', () => {
  const w = 3, h = 10, st = w * 4;
  const rgba = Buffer.alloc(st * h);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + (i >> 3) * 101) & 0xff;
  const raw = Buffer.alloc((st + 1) * h);
  for (let y = 0; y < h; y++) {
    const ft = y % 5;
    raw[y * (st + 1)] = ft;
    for (let i = 0; i < st; i++) {
      const a = i >= 4 ? rgba[y * st + i - 4] : 0;
      const b = y ? rgba[(y - 1) * st + i] : 0;
      const c = i >= 4 && y ? rgba[(y - 1) * st + i - 4] : 0;
      const p = [0, a, b, (a + b) >> 1, paeth(a, b, c)][ft];
      raw[y * (st + 1) + 1 + i] = (rgba[y * st + i] - p) & 0xff;
    }
  }
  const z = zlib.deflateSync(raw);
  const cut = z.length >> 1;
  const back = decodePng(pngOf(ihdrOf(w, h), [z.subarray(0, cut), z.subarray(cut)]));
  assert.deepStrictEqual([back.width, back.height], [w, h]);
  assert.deepStrictEqual(back.rgba, rgba);
});

test('ico.js: 色の型 6・8bit 以外の PNG と、壊れた PNG は読まずに投げる', () => {
  const raw = zlib.deflateSync(Buffer.alloc((1 * 3 + 1) * 1));
  assert.throws(() => decodePng(pngOf(ihdrOf(1, 1, 8, 2), [raw])), /色の型/);
  assert.throws(() => decodePng(pngOf(ihdrOf(1, 1, 16, 6), [zlib.deflateSync(Buffer.alloc(1 + 8))])), /8bit/);
  assert.throws(() => decodePng(Buffer.from('not a png')), /PNG/);
  const png = encodePng(2, 2, Buffer.alloc(16, 0x80));
  const bad = Buffer.from(png); bad[png.length - 20] ^= 0xff; // IDAT の中身を1バイト壊す
  assert.throws(() => decodePng(bad), /CRC/);
  assert.throws(() => encodePng(2, 2, Buffer.alloc(15)), /RGBA/);
});

test('ico.js: 今の ICO の中身の PNG を解ける（大きさが項目と合う）', () => {
  for (const f of ['assets/icon.ico', 'src/assets/tray.ico', 'src/assets/tray-rec.ico']) {
    for (const e of parseIco(fs.readFileSync(path.join(ROOT, f)))) {
      const p = decodePng(e.png);
      assert.deepStrictEqual([p.width, p.height, p.rgba.length], [e.width, e.height, e.width * e.height * 4], `${f} の ${e.width}`);
    }
  }
});

test('ico.js: node tools/ico.js <out.ico> <in.png>... で ICO を書き出す（出力が .ico でなければ書かない）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ico-test-'));
  try {
    const ins = [32, 16].map((n) => {
      const f = path.join(dir, `${n}.png`);
      fs.writeFileSync(f, encodePng(n, n, Buffer.alloc(n * n * 4, n)));
      return f;
    });
    const out = path.join(dir, 'out.ico');
    execFileSync(process.execPath, [path.join(ROOT, 'tools/ico.js'), out, ...ins], { stdio: 'pipe' });
    const e = parseIco(fs.readFileSync(out));
    assert.deepStrictEqual(e.map((x) => x.width), [16, 32]);
    assert.deepStrictEqual(decodePng(e[1].png).rgba, Buffer.alloc(32 * 32 * 4, 32));
    // 引数の順を取り違えても、PNG を上書きしない
    const before = fs.readFileSync(ins[0]);
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'tools/ico.js'), ins[0], ins[1]], { stdio: 'pipe' }));
    assert.deepStrictEqual(fs.readFileSync(ins[0]), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
