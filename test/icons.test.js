/*
 * icons.test.js — アイコン（ICO・PNG）の形を固定する（第0a回 R4）
 *
 *  - tools/ico.js: PNG（RGBA 8bit）を書いて読み戻せる。フィルタ 0〜4 を解き、IDAT が分かれていてもつなぐ
 *  - tools/ico.js: ICO は PNG をそのまま入れ、項目（256 は 0・planes 1・bpp 32）と中身が隙間なく続く
 *  - 今の assets/icon.ico と src/assets/tray.ico を読める（検査が空振りしない）
 *  - ロゴ D: assets/icon.svg の3本の path、icon.ico と icon.png の大きさと色、端が切れていないこと（Q7）
 *  - tools/icon-render.js で icon.svg を描くと、icon.ico と icon.png に一致する（描き直し忘れを止める。Q6）
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

// ---------------------------------------------------------------- ロゴ D（第0a回 R4-2）
// 波の頂点は Q7 の答えで下げた（L30 1.5 → L30 2.6、L37 2.5 → L37 3.4）。
// 線の上端が viewBox の中に収まり、上の端が切れない。点の座標は下げる前と同じでよい。
const D = [
  '<path d="M5 16 Q5 5 16 5 H27 L30 2.6 L33.5 9 L37 3.4 L40.5 8 L43 5 H48 Q59 5 59 16 V48 Q59 59 48 59 H16 Q5 59 5 48 Z" fill="#ffffff" stroke="#151515" stroke-width="4.5" stroke-linejoin="round"/>',
  '<path d="M27 5 L30 2.6 L33.5 9 L37 3.4 L40.5 8 L43 5" fill="none" stroke="#0e8cae" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>',
  '<path d="M22 45V21 L42 45V21" fill="none" stroke="#151515" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>',
];
const near = (a, b, d = 2) => a.every((v, i) => Math.abs(v - b[i]) <= d);
const pxOf = (img) => (x, y) => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

test('ロゴ D の SVG は指定の3本の path を、この順で持つ', () => {
  const svg = fs.readFileSync(path.join(ROOT, 'assets/icon.svg'), 'utf8');
  assert.ok(svg.includes('viewBox="0 0 64 64"'));
  let at = -1;
  for (const p of D) { const i = svg.indexOf(p); assert.ok(i > at, p.slice(0, 40)); at = i; }
});

test('icon.ico は 16〜256 の7つで、256 と icon.png はロゴ D の色をしている', () => {
  const ico = parseIco(fs.readFileSync(path.join(ROOT, 'assets/icon.ico')));
  assert.deepStrictEqual(ico.map((x) => x.width), [16, 24, 32, 48, 64, 128, 256]);
  const png = decodePng(fs.readFileSync(path.join(ROOT, 'assets/icon.png')));
  assert.strictEqual(png.width, 256);
  const px = (x, y) => [...png.rgba.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];
  assert.ok(near(px(141, 23), [14, 140, 174, 255]), '波（海の色）');   // SVG (35.3, 5.9)
  assert.ok(near(px(88, 132), [21, 21, 21, 255]), 'N の左の縦線');     // SVG (22.1, 33.1)
  assert.ok(near(px(56, 200), [255, 255, 255, 255]), '箱の中の白');    // SVG (14.1, 50.1)
  assert.strictEqual(px(4, 250)[3], 0, '箱の外は透明');                 // SVG (1.1, 62.6)
  assert.deepStrictEqual(decodePng(ico[6].png).rgba, png.rgba, 'ICO の 256 と icon.png が違う');
});

test('icon.png の上下左右の端の1列は透明（線が viewBox からはみ出して切れていない。Q7）', () => {
  const png = decodePng(fs.readFileSync(path.join(ROOT, 'assets/icon.png')));
  const px = pxOf(png);
  const hits = [];
  for (let i = 0; i < 256; i++) {
    for (const [x, y, side] of [[i, 0, '上'], [i, 255, '下'], [0, i, '左'], [255, i, '右']]) {
      if (px(x, y)[3] !== 0) hits.push(`${side}の端 (${x}, ${y})`);
    }
  }
  assert.deepStrictEqual(hits.slice(0, 5), [], `線が端で切れている（${hits.length} 画素）`);
});

test('icon.png と icon.ico の各大きさは、icon.svg を tools/icon-render.js で描いたものと同じ（描き直し忘れを止める。Q6）', () => {
  const { renderSvg } = require('../tools/icon-render.js');
  const svg = fs.readFileSync(path.join(ROOT, 'assets/icon.svg'), 'utf8');
  for (const e of parseIco(fs.readFileSync(path.join(ROOT, 'assets/icon.ico')))) {
    assert.ok(decodePng(e.png).rgba.equals(renderSvg(svg, e.width)), `icon.ico の ${e.width} が icon.svg と合わない（node tools/icon-render.js で描き直す）`);
  }
  assert.ok(decodePng(fs.readFileSync(path.join(ROOT, 'assets/icon.png'))).rgba.equals(renderSvg(svg, 256)), 'icon.png が icon.svg と合わない（node tools/icon-render.js で描き直す）');
});

test('icon-render.js: 塗りは中の画素だけ、縁は覆う割合の透明度、丸い端は角を削る', () => {
  const { renderSvg } = require('../tools/icon-render.js');
  const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">${body}</svg>`;
  // 左上の 2×2 を赤で塗る
  const sq = { width: 4, rgba: renderSvg(svg('<path d="M0 0 H2 V2 H0 Z" fill="#ff0000"/>'), 4) };
  assert.deepStrictEqual(pxOf(sq)(1, 1), [255, 0, 0, 255]);
  assert.deepStrictEqual(pxOf(sq)(2, 1), [0, 0, 0, 0]);
  // 縁が画素の真ん中を通ると、色はそのままで透明度が半分になる
  const half = { width: 4, rgba: renderSvg(svg('<path d="M0 0 H1.5 V4 H0 Z" fill="#ff0000"/>'), 4) };
  assert.deepStrictEqual(pxOf(half)(1, 2), [255, 0, 0, 128]);
  // 後の path が前の path の上に重なる
  const over = { width: 4, rgba: renderSvg(svg('<path d="M0 0 H4 V4 H0 Z" fill="#ffffff"/><path d="M0 0 H2 V4 H0 Z" fill="#151515"/>'), 4) };
  assert.deepStrictEqual([pxOf(over)(0, 0), pxOf(over)(3, 0)], [[21, 21, 21, 255], [255, 255, 255, 255]]);
  // 丸い端: 太さ 2 の横線 (1,2)-(3,2) は、端の外側の画素を半円の分だけ覆う
  const line = { width: 4, rgba: renderSvg(svg('<path d="M1 2 H3" fill="none" stroke="#0e8cae" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'), 4) };
  const lp = pxOf(line);
  assert.deepStrictEqual(lp(1, 1), [14, 140, 174, 255]);
  assert.ok(lp(0, 1)[3] > 160 && lp(0, 1)[3] < 240, `丸い端の画素の透明度 ${lp(0, 1)[3]}（四分円で約 200）`);
  assert.strictEqual(lp(0, 0)[3], 0);
});

test('icon-render.js: 描けないものは黙って飛ばさずに投げる', () => {
  const { renderSvg } = require('../tools/icon-render.js');
  const svg = (body, vb = '0 0 4 4') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`;
  assert.throws(() => renderSvg(svg('<circle cx="2" cy="2" r="1"/>'), 4), /circle/);
  assert.throws(() => renderSvg(svg('<path d="M0 0 l2 2 Z" fill="#ff0000"/>'), 4), /命令 l /);
  assert.throws(() => renderSvg(svg('<path d="M0 0 C1 1 2 2 3 3 Z" fill="#ff0000"/>'), 4), /命令 C /);
  assert.throws(() => renderSvg(svg('<path d="M0 0 H2 V2 Z" fill="#ff0000" opacity="0.5"/>'), 4), /opacity/);
  assert.throws(() => renderSvg(svg('<path d="M0 0 H2 V2 Z" fill="red"/>'), 4), /red/);
  assert.throws(() => renderSvg(svg('<path d="M0 0 H2" stroke="#ff0000" fill="none" stroke-linejoin="round"/>'), 4), /stroke-linecap/);
  assert.throws(() => renderSvg(svg('<path d="M0 0 H2 V2 Z" stroke="#ff0000" fill="none"/>'), 4), /stroke-linejoin/);
  assert.throws(() => renderSvg(svg('<path d="M0 0 H2 V2 Z" fill="#ff0000"/>', '0 0 4 3'), 4), /viewBox/);
});
