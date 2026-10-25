/*
 * icons.test.js — アイコン（ICO・PNG）の形を固定する（第0a回 R4）
 *
 *  - tools/ico.js: PNG（RGBA 8bit）を書いて読み戻せる。フィルタ 0〜4 を解き、IDAT が分かれていてもつなぐ
 *  - tools/ico.js: ICO は PNG をそのまま入れ、項目（256 は 0・planes 1・bpp 32）と中身が隙間なく続く
 *  - 今の assets/icon.ico と src/assets/tray.ico を読める（検査が空振りしない）
 *  - ロゴ（0.11.1 で箱の中のリスに替えた）: assets/icon.svg の2本の path（黒い箱・白いリス）、icon.ico と icon.png の大きさと色、
 *    形が viewBox の中に収まること・箱の外の四隅は透明・リスの足元に黒い線が出ないこと（RF-LG6）
 *  - tools/icon-render.js で icon.svg を描くと、icon.ico と icon.png に一致する（描き直し忘れを止める。Q6）。3次ベジェ・全部を描いてから書く（LG-1）
 *  - トレイ: 待機は新しいロゴ、録音中は尻尾の線を赤く少し太くしたもの。どちらも元の SVG を描いたものと一致する（Q8・LG4）
 *  - 小さい版は無い（L-3）: どの大きさも icon.svg（録音中は tray-rec.svg）から描く。16px でもリスが潰れず、録音中の赤が見える（RF-LG5）
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

// ---------------------------------------------------------------- 新しいロゴ（0.11.1。持ち主の決定 L-1〜L-3）
// 0.11.1 LG-2 で意図して変えた: ロゴ D（白い箱・海の色の波・N の3本）を、箱の中のリス（黒い箱・白いリスの2本）にした。
// 絵は docs/plans/2026-10-24-logo-icon.svg（持ち主の絵をなぞったもの。作る人はなぞり直さない）の座標をそのまま使う。
// 色は黒 #111111 と白 #ffffff だけ（L-1）。小さい版は作らない（L-3）。
const ART = 'docs/plans/2026-10-24-logo-icon.svg';
const ART_REC = 'docs/plans/2026-10-24-logo-tray-rec.svg';
const pathsOf = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').match(/<path\b[^>]*>/g) || [];
const near = (a, b, d = 2) => a.every((v, i) => Math.abs(v - b[i]) <= d);
const pxOf = (img) => (x, y) => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const lum = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
const BOX = [17, 17, 17, 255];      // #111111（黒い箱）
const WHITE = [255, 255, 255, 255]; // #ffffff（白いリス）

test('LG-2 L-1・L-2: ロゴの SVG は2本の path（黒 #111111 の箱・白 #ffffff のリス）だけで、絵（docs/plans/2026-10-24-logo-icon.svg）の座標をそのまま持つ', () => {
  const { parseSvg } = require('../tools/icon-render.js');
  const svg = fs.readFileSync(path.join(ROOT, 'assets/icon.svg'), 'utf8');
  assert.ok(svg.includes('viewBox="0 0 64 64"'));
  assert.deepStrictEqual(pathsOf('assets/icon.svg'), pathsOf(ART), 'assets/icon.svg の path が絵と違う');
  const { paths } = parseSvg(svg);
  assert.deepStrictEqual(paths.map((p) => [p.fill, p.stroke]), [[[17, 17, 17], null], [[255, 255, 255], null]]);
  assert.ok(!/0e8cae|stroke/.test(svg), '海の色の波や線が残っている');
});

test('icon.ico は 16〜256 の7つで、256 と icon.png は黒い箱・白いリス。色は #111111 と #ffffff（とその間の灰）だけ（0.11.1 LG-2 で意図して変えた: ロゴ D の色から）', () => {
  const ico = parseIco(fs.readFileSync(path.join(ROOT, 'assets/icon.ico')));
  assert.deepStrictEqual(ico.map((x) => x.width), [16, 24, 32, 48, 64, 128, 256]);
  const png = decodePng(fs.readFileSync(path.join(ROOT, 'assets/icon.png')));
  assert.strictEqual(png.width, 256);
  const px = pxOf(png);
  assert.ok(near(px(128, 12), BOX), '箱の上の黒');            // SVG (32, 3)
  assert.ok(near(px(80, 160), WHITE), 'リスの体の白');        // SVG (20, 40)
  assert.ok(near(px(128, 250), WHITE), 'リスの足元の白');     // SVG (32, 62.5)
  assert.strictEqual(px(0, 0)[3], 0, '箱の外の角は透明');      // SVG (0, 0)
  const off = [];
  for (let o = 0; o < png.rgba.length; o += 4) {
    const [r, g, b, a] = png.rgba.subarray(o, o + 4);
    if (a && !(r === g && g === b && r >= 17)) off.push([(o / 4) % 256, Math.floor(o / 4 / 256), r, g, b, a].join(','));
  }
  assert.deepStrictEqual(off.slice(0, 5), [], `黒と白のほかの色がある（${off.length} 画素）`);
  assert.deepStrictEqual(decodePng(ico[6].png).rgba, png.rgba, 'ICO の 256 と icon.png が違う');
});

// 0.11.1 LG-2 で意図して変えた（Ruling R6）: 前は「上下左右の端の1列は透明」（ロゴ D の線が viewBox からはみ出して切れていない。Q7）。
// 新しいロゴは線を持たない塗りの箱で、箱は viewBox の端まで届く（端の列は箱の黒）。切れていないことは「すべての点が viewBox の中」で見て、
// 角丸の箱の外の四隅は透明であることを見る
test('icon.svg の形はすべて viewBox の中に収まり（端で切れない）、icon.png の箱の外の四隅は透明', () => {
  const { parseSvg } = require('../tools/icon-render.js');
  const { vx, vy, vw, paths } = parseSvg(fs.readFileSync(path.join(ROOT, 'assets/icon.svg'), 'utf8'));
  const out = [];
  paths.forEach((p, i) => { for (const s of p.subs) for (const [x, y] of s.pts) if (x < vx || y < vy || x > vx + vw || y > vy + vw) out.push(`${i + 1} 本目の (${x}, ${y})`); });
  assert.deepStrictEqual(out.slice(0, 5), [], `viewBox からはみ出す（${out.length} 点）`);
  const px = pxOf(decodePng(fs.readFileSync(path.join(ROOT, 'assets/icon.png'))));
  for (const [x, y] of [[0, 0], [255, 0], [0, 255], [255, 255], [3, 3], [252, 252]]) assert.strictEqual(px(x, y)[3], 0, `角 (${x}, ${y}) が透明でない`);
});

// RF-LG6（持ち主の指摘 2026-10-24）: 黒い箱をリスの下まで敷くと、境目のにじみで箱の縁が透け、リスの足元に細い黒い線が出た。
// 絵は黒い箱をリスの下で少し内側に止めてある。icon.png（描き直したファイル）と、icon.svg を今描いたものの両方を見る（Ruling R5）。
// 明るい地（白）に置いた色で見る（透明な画素は地の色になる）
test('RF-LG6: リスの足元に黒い線が出ない（256 の下から2行・リスの足の幅 x 40〜140 に、明るい地で明るさ 100 未満の画素が無い）', () => {
  const { renderSvg } = require('../tools/icon-render.js');
  const fromFile = decodePng(fs.readFileSync(path.join(ROOT, 'assets/icon.png'))).rgba;
  const fresh = renderSvg(fs.readFileSync(path.join(ROOT, 'assets/icon.svg'), 'utf8'), 256);
  for (const [name, rgba] of [['icon.png', fromFile], ['icon.svg を描いたもの', fresh]]) {
    const dark = [];
    for (const y of [254, 255]) {
      for (let x = 40; x <= 140; x++) {
        const o = (y * 256 + x) * 4, a = rgba[o + 3] / 255;
        const onWhite = [0, 1, 2].map((c) => rgba[o + c] * a + 255 * (1 - a));
        if (lum(onWhite) < 100) dark.push(`(${x}, ${y})`);
      }
    }
    assert.deepStrictEqual(dark.slice(0, 5), [], `${name} の足元に暗い画素（${dark.length}）`);
  }
});

test('icon.png と icon.ico の各大きさは、icon.svg を tools/icon-render.js で描いたものと同じ（描き直し忘れを止める。Q6。0.11.1 LG-2 で意図して変えた: 32 未満も icon.svg から。小さい版は無い: L-3）', () => {
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
  // 0.11.1 LG-1 で意図して変えた: 絶対座標の 3次ベジェ（C）は描ける（新しいロゴが使う。決めたこと 1）。相対の c・略した S は今までどおり投げる（Ruling R1）
  assert.throws(() => renderSvg(svg('<path d="M0 0 c1 1 2 2 3 3 Z" fill="#ff0000"/>'), 4), /命令 c /);
  assert.throws(() => renderSvg(svg('<path d="M0 0 C1 1 2 2 3 3 S3 1 2 0 Z" fill="#ff0000"/>'), 4), /命令 S /);
  assert.throws(() => renderSvg(svg('<path d="M0 0 C1 1 2 2 Z" fill="#ff0000"/>'), 4), /C の後に数が足りない/);
  assert.throws(() => renderSvg(svg('<path d="M0 0 H2 V2 Z" fill="#ff0000" opacity="0.5"/>'), 4), /opacity/);
  assert.throws(() => renderSvg(svg('<path d="M0 0 H2 V2 Z" fill="red"/>'), 4), /red/);
  assert.throws(() => renderSvg(svg('<path d="M0 0 H2" stroke="#ff0000" fill="none" stroke-linejoin="round"/>'), 4), /stroke-linecap/);
  assert.throws(() => renderSvg(svg('<path d="M0 0 H2 V2 Z" stroke="#ff0000" fill="none"/>'), 4), /stroke-linejoin/);
  assert.throws(() => renderSvg(svg('<path d="M0 0 H2 V2 Z" fill="#ff0000"/>', '0 0 4 3'), 4), /viewBox/);
});

// ---------------------------------------------------------------- 3次ベジェ（0.11.1 LG-1。決めたこと 1・RF-LG1）
// 新しいロゴ（箱の中のリス）は 3次ベジェ（C）でできている。折れ線の分け数は 2次ベジェと同じ。
const alphaSum = (rgba) => { let s = 0; for (let o = 3; o < rgba.length; o += 4) s += rgba[o] / 255; return s; };
// 中心 (32, 32)・半径 r の円を 3次ベジェ4つで描く（k は 4/3·(√2 − 1)。円との半径の差は 0.03% 未満）
const circleD = (r, swap = false) => {
  const k = 0.5522847498 * r, c = 32;
  const arcs = [
    [[c + r, c + k], [c + k, c + r], [c, c + r]],
    [[c - k, c + r], [c - r, c + k], [c - r, c]],
    [[c - r, c - k], [c - k, c - r], [c, c - r]],
    [[c + k, c - r], [c + r, c - k], [c + r, c]],
  ];
  return `M${c + r} ${c} ` + arcs.map(([c1, c2, e]) => `C${(swap ? [c2, c1, e] : [c1, c2, e]).map((p) => p.join(' ')).join(' ')}`).join(' ') + ' Z';
};
const svg64 = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`;

test('LG-1 RF-LG1: 3次ベジェ4つで描いた円の面積は πr² の ±1% に入る（C を描ける）', () => {
  const { renderSvg } = require('../tools/icon-render.js');
  for (const [r, size] of [[24, 64], [24, 256], [10, 64]]) {
    const scale = size / 64;
    const got = alphaSum(renderSvg(svg64(`<path d="${circleD(r)}" fill="#111111"/>`), size));
    const want = Math.PI * (r * scale) ** 2;
    assert.ok(Math.abs(got - want) / want < 0.01, `半径 ${r}・${size}px の円の面積 ${got.toFixed(1)}（πr² は ${want.toFixed(1)}）`);
  }
});

test('LG-1 RF-LG1: 3次ベジェの制御点の順（c1 → c2）を取り違えない（同じ曲線の2次ベジェと同じ画素・入れ替えた path とは別の画素）', () => {
  const { renderSvg } = require('../tools/icon-render.js');
  // 2次ベジェ (P0, Q, P3) は、c1 = P0 + 2/3(Q − P0)・c2 = P3 + 2/3(Q − P3) の 3次ベジェと同じ曲線（同じ t で同じ点）。
  // Q を真ん中からずらし、c1 と c2 を入れ替えると別の曲線になるようにする
  const p0 = [4, 60], q = [12, 2], p3 = [60, 56];
  const c1 = p0.map((v, i) => v + (2 / 3) * (q[i] - v)), c2 = p3.map((v, i) => v + (2 / 3) * (q[i] - v));
  const fmt = (p) => p.map((v) => +v.toFixed(6)).join(' ');
  const quad = renderSvg(svg64(`<path d="M${fmt(p0)} Q${fmt(q)} ${fmt(p3)} Z" fill="#111111"/>`), 64);
  const cubic = renderSvg(svg64(`<path d="M${fmt(p0)} C${fmt(c1)} ${fmt(c2)} ${fmt(p3)} Z" fill="#111111"/>`), 64);
  const swapped = renderSvg(svg64(`<path d="M${fmt(p0)} C${fmt(c2)} ${fmt(c1)} ${fmt(p3)} Z" fill="#111111"/>`), 64);
  const diff = (a, b, d) => { let n = 0; for (let o = 3; o < a.length; o += 4) if (Math.abs(a[o] - b[o]) > d) n++; return n; };
  assert.strictEqual(diff(cubic, quad, 8), 0, '3次ベジェが同じ曲線の 2次ベジェと違う形になる');
  assert.ok(diff(cubic, swapped, 8) > 50, `c1 と c2 を入れ替えた path と同じ形になる（違う画素 ${diff(cubic, swapped, 8)}）`);
  // 円の4つの弧の c1 と c2 を入れ替えると、面積が大きく変わる
  const area = alphaSum(renderSvg(svg64(`<path d="${circleD(24, true)}" fill="#111111"/>`), 64));
  assert.ok(Math.abs(area - Math.PI * 576) / (Math.PI * 576) > 0.05, `入れ替えた円の面積 ${area.toFixed(1)}`);
});

test('LG-1 RF-LG4: 描けない大きさが1つでもあれば、icon-render は投げて、どのファイルも1バイトも変えない（一時ファイルも残さない）', () => {
  const { renderTargets } = require('../tools/icon-render.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-render-'));
  try {
    fs.mkdirSync(path.join(dir, 'a'));
    fs.writeFileSync(path.join(dir, 'a/one.svg'), svg64(`<path d="${circleD(24)}" fill="#111111"/>`));
    // 前の中身（描き直すと必ず変わる）
    const outs = ['a/one.png', 'a/one.ico', 'a/two.png', 'a/two.ico'];
    for (const f of outs) fs.writeFileSync(path.join(dir, f), `old ${f}`);
    const targets = [
      { svg: 'a/one.svg', png: { file: 'a/one.png', size: 32 }, ico: { file: 'a/one.ico', sizes: [16, 32] } },
      { svg: 'a/one.svg', png: { file: 'a/two.png', size: 32 }, ico: { file: 'a/two.ico', sizes: [16, 2048] } },   // 2048 は描けない（1〜1024）
    ];
    assert.throws(() => renderTargets(dir, targets), /描く大きさ/);
    for (const f of outs) assert.strictEqual(fs.readFileSync(path.join(dir, f), 'utf8'), `old ${f}`, `${f} が書き換わった`);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'a')).sort(), ['one.ico', 'one.png', 'one.svg', 'two.ico', 'two.png'], '一時ファイルが残った');
    // 全部描ければ、全部を書く
    targets[1].ico.sizes = [16, 48];
    renderTargets(dir, targets);
    for (const f of outs) assert.notStrictEqual(fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4), 'old ', `${f} が書かれない`);
    assert.deepStrictEqual(parseIco(fs.readFileSync(path.join(dir, 'a/two.ico'))).map((e) => e.width), [16, 48]);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'a')).sort(), ['one.ico', 'one.png', 'one.svg', 'two.ico', 'two.png'], '一時ファイルが残った');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- トレイ（第0a回 R4-3。Q8 の答え。0.11.1 LG-2 で絵を替えた）
// 待機は assets/icon.svg（新しいロゴ）そのもの。録音中は assets/tray-rec.svg（新しいロゴの尻尾の2本の線を赤く、少し太くしたもの。
// LG4 の答え「しっぽの中の線を赤にして」と太さの「案 1」。絵は docs/plans/2026-10-24-logo-tray-rec.svg の座標をそのまま）。
// 名前と大きさは今のまま（ICO は 16〜64 の6つ、PNG は 32）。main.js の makeTrayIcon は直さない。
const TRAY_SIZES = [16, 20, 24, 32, 48, 64];
const REC_RED = [217, 48, 37, 255]; // #d93025（録音中の尻尾の線）
const isRed = (p) => p[3] >= 128 && p[0] >= 150 && p[1] < 100 && p[2] < 100;
const ico16 = (f) => decodePng(parseIco(fs.readFileSync(path.join(ROOT, f))).find((x) => x.width === 16).png);

test('トレイ（待機）は新しいロゴ（黒い箱・白いリス。0.11.1 LG-2 で意図して変えた: ロゴ D から）', () => {
  assert.deepStrictEqual(parseIco(fs.readFileSync(path.join(ROOT, 'src/assets/tray.ico'))).map((x) => x.width), TRAY_SIZES);
  const px = pxOf(decodePng(fs.readFileSync(path.join(ROOT, 'src/assets/tray.png'))));
  assert.ok(near(px(16, 1), BOX), '箱の上の黒');       // SVG (32, 2)
  assert.ok(near(px(8, 20), WHITE), 'リスの体の白');   // SVG (16, 40)
  assert.strictEqual(px(0, 0)[3], 0, '箱の外の角は透明');
});

test('トレイ（録音中）は尻尾の線が赤い（LG4 の答え。0.11.1 LG-2 で意図して変えた: 右下の赤い点の印から）。待機の同じ所は黒い線', () => {
  const ico = parseIco(fs.readFileSync(path.join(ROOT, 'src/assets/tray-rec.ico')));
  assert.deepStrictEqual(ico.map((x) => x.width), TRAY_SIZES);
  const t = decodePng(fs.readFileSync(path.join(ROOT, 'src/assets/tray-rec.png')));
  assert.deepStrictEqual([t.width, t.height], [32, 32]);
  const px = pxOf(t);
  assert.ok(near(px(24, 20), REC_RED, 4), '尻尾の赤い線');     // SVG (48, 40)
  assert.ok(near(px(8, 20), WHITE), 'リスの体の白');
  assert.ok(near(px(16, 1), BOX), '箱の上の黒');
  const idle = pxOf(decodePng(fs.readFileSync(path.join(ROOT, 'src/assets/tray.png'))));
  assert.ok(lum(idle(24, 20)) < 64 && !isRed(idle(24, 20)), `待機のトレイの同じ所は尻尾の黒い線（${idle(24, 20)}）`);   // 線は 1 画素より細く、少し透ける
});

test('録音中の SVG は、新しいロゴの2本を同じ順でそのまま持ち、赤 #d93025 の線の path を1本その後に重ねる（絵 docs/plans/2026-10-24-logo-tray-rec.svg の座標をそのまま）', () => {
  const icon = pathsOf('assets/icon.svg');
  const rec = pathsOf('assets/tray-rec.svg');
  assert.ok(fs.readFileSync(path.join(ROOT, 'assets/tray-rec.svg'), 'utf8').includes('viewBox="0 0 64 64"'));
  assert.strictEqual(icon.length, 2);
  assert.deepStrictEqual(rec.slice(0, 2), icon, '新しいロゴの path が icon.svg と違う');
  assert.strictEqual(rec.length, 3, '赤い線の path が1本でない');
  assert.match(rec[2], /fill="#d93025"/);
  assert.deepStrictEqual(rec, pathsOf(ART_REC), 'assets/tray-rec.svg の path が絵と違う');
});

test('RF-LG5: 16px のトレイでリスが黒い塊に潰れない（白い画素が 15% 以上）。録音中の 16px に赤い画素が4つ以上あり、待機には無い', () => {
  for (const f of ['src/assets/tray.ico', 'src/assets/tray-rec.ico']) {
    const img = ico16(f);
    let white = 0;
    for (let o = 0; o < img.rgba.length; o += 4) if (img.rgba[o + 3] >= 128 && lum(img.rgba.subarray(o, o + 3)) >= 200) white++;
    assert.ok(white / 256 >= 0.15, `${f} の 16px の白い画素 ${white}（256 の 15% 以上）`);
  }
  const reds = (f) => { const img = ico16(f); let n = 0; for (let o = 0; o < img.rgba.length; o += 4) if (isRed(img.rgba.subarray(o, o + 4))) n++; return n; };
  assert.ok(reds('src/assets/tray-rec.ico') >= 4, `録音中の 16px の赤い画素 ${reds('src/assets/tray-rec.ico')}（4 以上）`);
  assert.strictEqual(reds('src/assets/tray.ico'), 0, '待機の 16px に赤い画素がある');
});

// 決めたこと 3（LG4 の続きの答え「録音中のトレイだけ赤い線を太くする」・太さは「案 1」）: 赤い線は、尻尾の黒い線（白いリスの path の穴）を
// 太らせてなぞったもの。待機のロゴの線は元の太さ。16px の赤い画素の数は元の太さでも4を超えるので、太さは面積で見る（Ruling R7）
test('LG-2 決めたこと 3: 録音中の赤い線は、待機の尻尾の線（白いリスの path の穴）より太い（256 で描いた面積が 1.3 倍以上）', () => {
  const { renderSvg } = require('../tools/icon-render.js');
  const dOf = (tag) => /\bd="([^"]*)"/.exec(tag)[1];
  const area = (d) => alphaSum(renderSvg(svg64(`<path d="${d}" fill="#000000"/>`), 256));
  const holes = dOf(pathsOf('assets/icon.svg')[1]).split(/(?=M)/).slice(1);   // 1つ目は外の輪郭、残りが尻尾の線の穴
  assert.strictEqual(holes.length, 2, '尻尾の線の穴が2つでない');
  const thin = area(holes.join(' ')), red = area(dOf(pathsOf('assets/tray-rec.svg')[2]));
  assert.ok(red >= thin * 1.3, `赤い線の面積 ${red.toFixed(0)}（尻尾の線 ${thin.toFixed(0)} の 1.3 倍以上）`);
});

test('トレイの ICO と PNG は、元の SVG を tools/icon-render.js で描いたものと同じ（描き直し忘れを止める。0.11.1 LG-2 で意図して変えた: 32 未満も元の SVG から）', () => {
  const { renderSvg } = require('../tools/icon-render.js');
  for (const [src, base] of [['assets/icon.svg', 'src/assets/tray'], ['assets/tray-rec.svg', 'src/assets/tray-rec']]) {
    const svg = fs.readFileSync(path.join(ROOT, src), 'utf8');
    for (const e of parseIco(fs.readFileSync(path.join(ROOT, `${base}.ico`)))) {
      assert.ok(decodePng(e.png).rgba.equals(renderSvg(svg, e.width)), `${base}.ico の ${e.width} が ${src} と合わない（node tools/icon-render.js で描き直す）`);
    }
    assert.ok(decodePng(fs.readFileSync(path.join(ROOT, `${base}.png`))).rgba.equals(renderSvg(svg, 32)), `${base}.png が ${src} と合わない（node tools/icon-render.js で描き直す）`);
  }
});

// 0.11.1 LG-2 で意図して変えた（L-3「そのまま」）: 小さい版（assets/icon-small.svg・assets/tray-rec-small.svg）と、その4つのテスト
// （小さい版の3本・線が viewBox に収まる・録音中の小さい版・16px と 24px の海の色の波）を外した。どの大きさも icon.svg（録音中は tray-rec.svg）から描く
test('LG-2 L-3: どの大きさも icon.svg（録音中は tray-rec.svg）から描く。小さい版のファイルと SMALL_BELOW は無く、tools/icon-render.js を一時フォルダで走らせると、リポジトリのファイルと1バイトも違わない', () => {
  const R = require('../tools/icon-render.js');
  for (const f of ['assets/icon-small.svg', 'assets/tray-rec-small.svg']) assert.ok(!fs.existsSync(path.join(ROOT, f)), `${f} が残っている`);
  assert.ok(!('SMALL_BELOW' in R), 'SMALL_BELOW が残っている');
  // 0.11.1 LG-3 で意図して足した: MCP のロゴの書き出し（js）
  for (const t of R.TARGETS) assert.deepStrictEqual(Object.keys(t).filter((k) => !['svg', 'png', 'ico', 'js'].includes(k)), [], `${t.svg} に小さい版の欄`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-targets-'));
  try {
    const outs = [];
    for (const t of R.TARGETS) {
      for (const f of [t.svg, t.png && t.png.file, t.ico && t.ico.file, t.js && t.js.file].filter(Boolean)) fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, t.svg), path.join(dir, t.svg));
      for (const o of [t.png, t.ico, t.js].filter(Boolean)) outs.push(o.file);
    }
    R.renderTargets(dir);
    for (const f of outs) assert.ok(fs.readFileSync(path.join(dir, f)).equals(fs.readFileSync(path.join(ROOT, f))), `${f} が描き直しと違う（node tools/icon-render.js で描き直す）`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 決めたこと 5（D36 の答え「assets/icon.png を 64×64 にした PNG」）: 元が変われば MCP のロゴも一緒に変わる。
// 手で貼らず、tools/icon-render.js が icon.svg を 64 で描いて src/mcp/icon.js に書き出す
test('LG-3 決めたこと 5: MCP のロゴ（src/mcp/icon.js の PNG）は、icon.svg を 64 で描いたもので、tools/icon-render.js が書き出す', () => {
  const R = require('../tools/icon-render.js');
  const { ICON_PNG_BASE64 } = require('../src/mcp/icon.js');
  const png = Buffer.from(ICON_PNG_BASE64, 'base64');
  const img = decodePng(png);
  assert.deepStrictEqual([img.width, img.height], [64, 64]);
  const want = R.renderSvg(fs.readFileSync(path.join(ROOT, 'assets/icon.svg'), 'utf8'), 64);
  assert.ok(img.rgba.equals(want), 'src/mcp/icon.js の PNG が icon.svg を 64 で描いたものと違う（node tools/icon-render.js で描き直す）');
  assert.ok(png.equals(encodePng(64, 64, want)), 'src/mcp/icon.js の PNG のバイトが tools/icon-render.js の書き出しと違う');
  assert.ok(R.TARGETS.some((t) => t.svg === 'assets/icon.svg' && t.js && t.js.file === 'src/mcp/icon.js' && t.js.size === 64), 'icon-render.js が src/mcp/icon.js を書き出さない');
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

test('main.js が src/assets から読む絵は、すべてリポジトリにある（名前の打ち間違いで透明な窓やトレイにしない）', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const names = new Set();
  for (const m of main.matchAll(/path\.join\(__dirname, 'assets', ([^)]*)\)/g)) {
    // 比べる相手（process.platform === 'win32' の 'win32'）は名前ではない
    for (const q of m[1].matchAll(/'([\w.-]+)'/g)) if (!/^(win32|darwin|linux)$/.test(q[1])) names.add(q[1]);
  }
  // トレイは 'tray-rec' / 'tray' に拡張子を足して読む（makeTrayIcon）
  const files = [];
  for (const n of names) {
    if (/\.[a-z]+$/.test(n)) files.push(n);
    else files.push(`${n}.ico`, `${n}.png`);
  }
  assert.ok(files.includes('window.ico') && files.includes('window.png') && files.includes('tray.ico'), `拾えていない: ${files.join(', ')}`);
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, 'src/assets', f)), `src/assets/${f} が無い`);
});
