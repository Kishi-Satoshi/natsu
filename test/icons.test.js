/*
 * icons.test.js — アイコン（ICO・PNG）の形を固定する（第0a回 R4）
 *
 *  - tools/ico.js: PNG（RGBA 8bit）を書いて読み戻せる。フィルタ 0〜4 を解き、IDAT が分かれていてもつなぐ
 *  - tools/ico.js: ICO は PNG をそのまま入れ、項目（256 は 0・planes 1・bpp 32）と中身が隙間なく続く
 *  - 今の assets/icon.ico と src/assets/tray.ico を読める（検査が空振りしない）
 *  - ロゴ D: assets/icon.svg の3本の path、icon.ico と icon.png の大きさと色、端が切れていないこと（Q7）
 *  - tools/icon-render.js で icon.svg を描くと、icon.ico と icon.png に一致する（描き直し忘れを止める。Q6）
 *  - トレイ: 待機はロゴ D、録音中はロゴ D の右下に赤い点の印。どちらも元の SVG を描いたものと一致する（Q8）
 *  - 小さい版: 32px 未満（ICO の 16・20・24）は assets/icon-small.svg と assets/tray-rec-small.svg から描く。
 *    波を太く高く、枠と N も少し太くして、16px でも箱の上の波（海の色）が見える。線は viewBox の中に収まる
 *  - 窓のアイコンは、Windows では icon.ico を渡す（OS が 16px・24px の小さい版を選べるように）
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

// 小さい版（実機の 16px の題名の帯・タスクバーで、箱の上の波がほとんど見えなかった）。
// 32px 未満は小さい版の SVG から描く。32px 以上は今の SVG のまま。
const SMALL_BELOW = 32;
const SEA = [14, 140, 174, 255]; // #0e8cae（夏の海の色）
// 上から rows 段の中で、海の色にほぼそのままの画素（各色 ±16・不透明）を数える
const seaCount = (img, rows) => {
  const px = pxOf(img);
  let c = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < img.width; x++) if (near(px(x, y), SEA, 16)) c++;
  return c;
};

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

test('icon.png と icon.ico の各大きさは、icon.svg（32 未満は icon-small.svg）を tools/icon-render.js で描いたものと同じ（描き直し忘れを止める。Q6）', () => {
  const { renderSvg } = require('../tools/icon-render.js');
  const svg = fs.readFileSync(path.join(ROOT, 'assets/icon.svg'), 'utf8');
  const small = fs.readFileSync(path.join(ROOT, 'assets/icon-small.svg'), 'utf8');
  for (const e of parseIco(fs.readFileSync(path.join(ROOT, 'assets/icon.ico')))) {
    const [src, name] = e.width < SMALL_BELOW ? [small, 'icon-small.svg'] : [svg, 'icon.svg'];
    assert.ok(decodePng(e.png).rgba.equals(renderSvg(src, e.width)), `icon.ico の ${e.width} が ${name} と合わない（node tools/icon-render.js で描き直す）`);
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

// ---------------------------------------------------------------- トレイ（第0a回 R4-3。Q8 の答え）
// 待機は assets/icon.svg（ロゴ D）そのもの。録音中は assets/tray-rec.svg（ロゴ D の右下に赤い点の印）。
// 名前と大きさは今のまま（ICO は 16〜64 の6つ、PNG は 32）。main.js の makeTrayIcon は直さない。
const TRAY_SIZES = [16, 20, 24, 32, 48, 64];
const REC_RED = [229, 72, 77, 255]; // #e5484d（録音バーの --rec と同じ色）

test('トレイ（待機）は ロゴ D', () => {
  assert.deepStrictEqual(parseIco(fs.readFileSync(path.join(ROOT, 'src/assets/tray.ico'))).map((x) => x.width), [16, 20, 24, 32, 48, 64]);
  const t = decodePng(fs.readFileSync(path.join(ROOT, 'src/assets/tray.png')));
  const px = (x, y) => [...t.rgba.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
  assert.ok(near(px(17, 2), [14, 140, 174, 255]));   // SVG (35, 5) 波
  assert.ok(near(px(11, 16), [21, 21, 21, 255]));    // SVG (23, 33) N の縦線
});

test('トレイ（録音中）は ロゴ D の右下に赤い点の印（16px でも見える。待機には無い）', () => {
  const ico = parseIco(fs.readFileSync(path.join(ROOT, 'src/assets/tray-rec.ico')));
  assert.deepStrictEqual(ico.map((x) => x.width), TRAY_SIZES);
  const t = decodePng(fs.readFileSync(path.join(ROOT, 'src/assets/tray-rec.png')));
  assert.deepStrictEqual([t.width, t.height], [32, 32]);
  const px = pxOf(t);
  assert.ok(near(px(17, 2), [14, 140, 174, 255]), '波（海の色）');   // SVG (35, 5)
  assert.ok(near(px(11, 16), [21, 21, 21, 255]), 'N の縦線');        // SVG (23, 33)
  assert.ok(near(px(26, 26), REC_RED), '右下の赤い点');               // SVG (53, 53) 印の中心
  assert.ok(near(pxOf(decodePng(ico[0].png))(13, 13), REC_RED), '16px の右下の赤い点'); // SVG (54, 54)
  const idle = pxOf(decodePng(fs.readFileSync(path.join(ROOT, 'src/assets/tray.png'))));
  assert.ok(near(idle(26, 26), [255, 255, 255, 255]), '待機のトレイの同じ所は箱の中の白');
});

test('録音中の SVG は、ロゴ D の path を同じ順でそのまま持ち、印をその後に重ねる', () => {
  const icon = fs.readFileSync(path.join(ROOT, 'assets/icon.svg'), 'utf8');
  const rec = fs.readFileSync(path.join(ROOT, 'assets/tray-rec.svg'), 'utf8');
  const paths = (s) => s.match(/<path\b[^>]*>/g) || [];
  assert.strictEqual(paths(icon).length, D.length);
  assert.ok(rec.includes('viewBox="0 0 64 64"'));
  assert.deepStrictEqual(paths(rec).slice(0, D.length), paths(icon), 'ロゴ D の path が icon.svg と違う');
  assert.ok(paths(rec).length > D.length, '印の path が無い');
});

test('トレイの ICO と PNG は、元の SVG（32 未満は小さい版）を tools/icon-render.js で描いたものと同じ（描き直し忘れを止める）', () => {
  const { renderSvg } = require('../tools/icon-render.js');
  for (const [src, smallSrc, base] of [
    ['assets/icon.svg', 'assets/icon-small.svg', 'src/assets/tray'],
    ['assets/tray-rec.svg', 'assets/tray-rec-small.svg', 'src/assets/tray-rec'],
  ]) {
    const svg = fs.readFileSync(path.join(ROOT, src), 'utf8');
    const small = fs.readFileSync(path.join(ROOT, smallSrc), 'utf8');
    for (const e of parseIco(fs.readFileSync(path.join(ROOT, `${base}.ico`)))) {
      const [s, name] = e.width < SMALL_BELOW ? [small, smallSrc] : [svg, src];
      assert.ok(decodePng(e.png).rgba.equals(renderSvg(s, e.width)), `${base}.ico の ${e.width} が ${name} と合わない（node tools/icon-render.js で描き直す）`);
    }
    assert.ok(decodePng(fs.readFileSync(path.join(ROOT, `${base}.png`))).rgba.equals(renderSvg(svg, 32)), `${base}.png が ${src} と合わない（node tools/icon-render.js で描き直す）`);
  }
});

// ---------------------------------------------------------------- 小さい版（16〜24px）
// 実機の Windows で、16px の題名の帯・タスクバーのアイコンの、箱の上の波（海の色）がほとんど見えなかった。
// 32px 未満は assets/icon-small.svg（録音中は assets/tray-rec-small.svg）から描く。
// 形はロゴ D のまま、波を太く高く（山と谷を大きく）、枠と N も少し太くする。32px 以上は今のまま。

test('小さい版（assets/icon-small.svg）はロゴ D と同じ3本・同じ色で、波は太く高く、枠と N も少し太い', () => {
  const { parseSvg } = require('../tools/icon-render.js');
  const big = parseSvg(fs.readFileSync(path.join(ROOT, 'assets/icon.svg'), 'utf8'));
  const small = parseSvg(fs.readFileSync(path.join(ROOT, 'assets/icon-small.svg'), 'utf8'));
  assert.deepStrictEqual([small.vx, small.vy, small.vw], [0, 0, 64]);
  assert.strictEqual(small.paths.length, 3);
  const colors = (s) => s.paths.map((p) => [p.fill, p.stroke]);
  assert.deepStrictEqual(colors(small), colors(big), '色（白い箱と黒い枠・海の色の波・黒い N）が違う');
  const [box, wave, n] = small.paths;
  assert.ok(wave.half * 2 >= 6 && wave.half * 2 <= 7, `波の太さ ${wave.half * 2}（6〜7）`);
  assert.ok(wave.half > box.half, '波が枠より細いと、波の縁から枠の黒がはみ出す');
  assert.ok(box.half > big.paths[0].half, `枠が太くなっていない（${box.half * 2}）`);
  assert.ok(n.half > big.paths[2].half, `N が太くなっていない（${n.half * 2}）`);
  const ys = (p) => p.subs.flatMap((s) => s.pts.map((q) => q[1]));
  const tall = (p) => Math.max(...ys(p)) - Math.min(...ys(p));
  assert.ok(tall(wave) > tall(big.paths[1]), `波の高さ ${tall(wave)}（今の icon.svg は ${tall(big.paths[1])}）`);
});

test('小さい版の線は、太さの半分まで含めて viewBox の中に収まる（端が切れない）', () => {
  const { parseSvg } = require('../tools/icon-render.js');
  for (const f of ['assets/icon-small.svg', 'assets/tray-rec-small.svg']) {
    const { vx, vy, vw, paths } = parseSvg(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const out = [];
    paths.forEach((p, i) => {
      const r = p.stroke ? p.half : 0;
      for (const s of p.subs) {
        for (const [x, y] of s.pts) {
          if (x - r < vx || y - r < vy || x + r > vx + vw || y + r > vy + vw) out.push(`${i + 1} 本目の (${x}, ${y})`);
        }
      }
    });
    assert.deepStrictEqual(out.slice(0, 5), [], `${f} の線が viewBox からはみ出す（${out.length} 点）`);
  }
});

test('録音中の小さい版は、小さい版のロゴ D の path を同じ順でそのまま持ち、印は tray-rec.svg と同じ', () => {
  const paths = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').match(/<path\b[^>]*>/g) || [];
  const small = paths('assets/icon-small.svg');
  const recSmall = paths('assets/tray-rec-small.svg');
  assert.strictEqual(small.length, D.length);
  assert.deepStrictEqual(recSmall.slice(0, D.length), small, 'ロゴ D の小さい版の path が icon-small.svg と違う');
  assert.deepStrictEqual(recSmall.slice(D.length), paths('assets/tray-rec.svg').slice(D.length), '印が tray-rec.svg と違う');
});

test('icon.ico の 16 と 24 は小さい版で、上の段に海の色の波がはっきり見える（32 以上は今のまま）', () => {
  const ico = parseIco(fs.readFileSync(path.join(ROOT, 'assets/icon.ico')));
  const at = (w) => decodePng(ico.find((e) => e.width === w).png);
  // 上の 1/4（SVG の y 0〜16。N の上端より上）に、海の色の画素がまとまってある
  const c16 = seaCount(at(16), 4);
  assert.ok(c16 >= 6, `16px の上の4段に海の色が ${c16} 画素しかない（6 以上）`);
  const c24 = seaCount(at(24), 6);
  assert.ok(c24 >= 14, `24px の上の6段に海の色が ${c24} 画素しかない（14 以上）`);
});

test('トレイの 16px（待機・録音中）も、上の段に海の色の波がはっきり見える', () => {
  for (const f of ['src/assets/tray.ico', 'src/assets/tray-rec.ico']) {
    const e = parseIco(fs.readFileSync(path.join(ROOT, f))).find((x) => x.width === 16);
    const c = seaCount(decodePng(e.png), 4);
    assert.ok(c >= 6, `${f} の 16px の上の4段に海の色が ${c} 画素しかない（6 以上）`);
  }
});

test('窓のアイコンは、Windows では ICO を渡す（PNG の 256 を縮めると 16px で波が消える。ICO なら OS が小さい版を選ぶ）', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  assert.match(main, /const WINDOW_ICON = path\.join\(__dirname, 'assets', process\.platform === 'win32' \? 'window\.ico' : 'window\.png'\);/);
  const i = main.indexOf('function createMainWindow');
  assert.ok(i >= 0, 'createMainWindow が無い');
  const body = main.slice(i, main.indexOf('\n}\n', i));
  assert.match(body, /\bicon:\s*WINDOW_ICON\s*,/, 'メインの窓が WINDOW_ICON を使っていない');
  assert.ok(!/icon:\s*path\.join\([^)]*'icon\.png'\)/.test(main), '窓のアイコンに icon.png を直に渡している');
});

test('窓のアイコンは src/assets に置き、中身は assets/icon.ico・icon.png と同じ（アプリ内の更新は src/ だけを入れ替える。0.1.1）', () => {
  for (const [inSrc, build] of [['src/assets/window.ico', 'assets/icon.ico'], ['src/assets/window.png', 'assets/icon.png']]) {
    assert.ok(fs.readFileSync(path.join(ROOT, inSrc)).equals(fs.readFileSync(path.join(ROOT, build))),
      `${inSrc} と ${build} が違う（node tools/icon-render.js で描き直す）`);
  }
  const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  // 窓とトレイの代わりの絵が、src の外（更新で届かない assets/）を指していない
  assert.ok(!/path\.join\(__dirname, '\.\.', 'assets'/.test(main), 'src/main.js が src の外の assets/ を読んでいる');
  assert.ok(require('../tools/icon-render.js').TARGETS.some((t) => t.ico && t.ico.file === 'src/assets/window.ico'), 'icon-render.js が window.ico を書き出さない');
});
