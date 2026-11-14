'use strict';
/**
 * 0.17.0（計画 docs/plans/2026-11-13-170.md）: ページのアイコンの表と純粋な部品。
 *  IG-1: 元の絵（assets/page-icons/）・取り出しの道具（tools/page-icons.js）・表（src/pageIconPaths.js と app.html の写し）・
 *        名前の表（src/pageIcons.js の ICON_LIST・ICON_CATS）・出典の文（src/licenses/page-icons.txt）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// デジタル庁の配る形（切り抜き・defs・evenodd・色）
const DG_SVG = (d, rule = true) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#clip0_320_221)">
<path${rule ? ' fill-rule="evenodd" clip-rule="evenodd"' : ''} d="${d}" fill="#1A1A1C"/>
</g>
<defs>
<clipPath id="clip0_320_221">
<rect width="24" height="24" fill="white"/>
</clipPath>
</defs>
</svg>
`;
// Material Symbols の形（viewBox のある物と無い物）
const MS_SVG = (d) => `<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24"><path d="${d}"/></svg>`;
const MS_NOVB = (d) => `<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24"><path d="${d}"/></svg>`;

// ---------------------------------------------------------------- IG-1
test('IG-1・F178: buildPaths の表（切り抜きと id と色を外す・evenodd を残す・viewBox の無い絵は 0 0 24 24・知らない要素や属性は投げる・d を1字も変えない）', () => {
  const T = require('../tools/page-icons.js');
  const d1 = 'M16.7 2H4V22H20V5.2L16.7 2ZM5.5 20.5V3.5H16V6H18.5V20.5H5.5Z';
  const d2 = 'M480-420q-41.92 0-70.96-29.04Q380-478.08 380-520v-240Z';
  const d3 = 'm15.5 12.2 1.8 1.8v1.5h-4.55V21l-.75.75-.75-.75Z';
  const files = {
    'assets/page-icons/dg/a_line.svg': DG_SVG(d1),
    'assets/page-icons/dg/b_line.svg': DG_SVG(d1, false),
    'assets/page-icons/ms/c_wght300_24px.svg': MS_SVG(d2),
    'assets/page-icons/ms/d_wght300_24px.svg': MS_NOVB(d3),
  };
  const list = [{ id: 'a', src: 'dg' }, { id: 'b', src: 'dg' }, { id: 'c', src: 'ms' }, { id: 'd', src: 'ms', ui: true }];
  const out = T.buildPaths(list, (rel) => Buffer.from(files[rel], 'utf8'));
  assert.strictEqual(out.v, 1);
  assert.deepStrictEqual(Object.keys(out.icons), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(out.icons.a, { src: 'dg', vb: '0 0 24 24', p: [[d1, 1]], sha: sha256(Buffer.from(files['assets/page-icons/dg/a_line.svg'])) });
  assert.deepStrictEqual(out.icons.b.p, [[d1]], 'evenodd の無い絵に印を付けた');
  assert.deepStrictEqual(out.icons.c, { src: 'ms', vb: '0 -960 960 960', p: [[d2]], sha: sha256(Buffer.from(files['assets/page-icons/ms/c_wght300_24px.svg'])) });
  assert.strictEqual(out.icons.d.vb, '0 0 24 24', 'viewBox の無い Material Symbols は 24 の座標');
  const text = JSON.stringify(out);
  for (const bad of ['clip', '1A1A1C', 'white', 'url(', '"id"', 'defs', 'rect']) assert.ok(!text.includes(bad), `表に ${bad} が残った`);
  // 知らない要素・属性は投げる（表を書かない）
  const one = (svg) => () => T.buildPaths([{ id: 'x', src: 'ms' }], () => Buffer.from(svg, 'utf8'));
  for (const [why, svg] of [
    ['<script>', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script><path d="${d3}"/></svg>`],
    ['<use>', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><use href="#a"/></svg>`],
    ['<image>', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><image href="data:,x"/></svg>`],
    ['<style>', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><style>path{}</style><path d="${d3}"/></svg>`],
    ['<foreignObject>', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><foreignObject/><path d="${d3}"/></svg>`],
    ['属性 href', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path href="#a" d="${d3}"/></svg>`],
    ['属性 onload', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path onload="x()" d="${d3}"/></svg>`],
    ['属性 transform', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path transform="scale(2)" d="${d3}"/></svg>`],
    ['属性 onload', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="x()"><path d="${d3}"/></svg>`],
    ['path の色', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d3}" fill="none"/></svg>`],
    ['fill-rule', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d3}" fill-rule="inherit"/></svg>`],
    ['d を読めない', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="url(#x)"/></svg>`],
    ['path が無い', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>`],
    ['切り抜き', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g clip-path="url(#c)"><path d="${d3}"/></g><defs><clipPath id="c"><rect width="12" height="24"/></clipPath></defs></svg>`],
    ['文字', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">text<path d="${d3}"/></svg>`],
    ['viewBox', `<svg xmlns="http://www.w3.org/2000/svg" height="12" width="12"><path d="${d3}"/></svg>`],
  ]) assert.throws(one(svg), (e) => e instanceof Error && e.message.includes(why), `${why} の理由で投げない: ${svg}`);
});

test('IG-1・F178: 作り直すと同じ（assets/page-icons/ の元の絵から buildPaths で作り直した物が src/pageIconPaths.js と app.html の写しと1字も同じ・sha は元のファイルの sha256）', () => {
  const T = require('../tools/page-icons.js');
  const { ICON_LIST } = require('../src/pageIcons.js');
  const built = T.buildPaths(ICON_LIST, (rel) => fs.readFileSync(path.join(ROOT, rel)));
  assert.strictEqual(read('src/pageIconPaths.js'), T.renderModule(built), 'src/pageIconPaths.js が元の絵から作り直した物と違う（node tools/page-icons.js で書き直す）');
  const html = read('src/renderer/app.html');
  const at = html.indexOf(T.COPY_START);
  const end = html.indexOf(T.COPY_END);
  assert.ok(at > 0 && end > at, 'app.html に pageIconPaths の写しの区切りが無い');
  assert.strictEqual(html.slice(at, end + T.COPY_END.length), T.renderCopy(built), 'app.html の pageIconPaths の写しが元の絵から作り直した物と違う');
  const P = require('../src/pageIconPaths.js');
  assert.strictEqual(P.v, 1);
  assert.deepStrictEqual(Object.keys(P.icons), ICON_LIST.map((x) => x.id), '表の絵が名前の表と合わない');
  for (const x of ICON_LIST) {
    const rel = T.fileOf(x);
    assert.strictEqual(P.icons[x.id].sha, sha256(fs.readFileSync(path.join(ROOT, rel))), `${x.id}: sha が元のファイル（${rel}）と違う`);
    assert.strictEqual(P.icons[x.id].src, x.src, `${x.id}: 出どころ`);
  }
  assert.ok(Object.isFrozen(P.icons) && Object.isFrozen(P.icons.mic) && Object.isFrozen(P.icons.mic.p), '表を凍らせていない');
  assert.strictEqual(Object.getPrototypeOf(P.icons), null, '表は持ち物の名前の無い入れ物');
});

test('IG-1: 表の形（id と名前は重ならない・よみはひらがなと「ー」・分類は ICON_CATS のどれか・出どころと元のファイルの置き場が合う・デジタル庁が先・窓に出す数はデジタル庁 60 と Material Symbols 127・飾りの絵は窓の数に入らない）', () => {
  const { ICON_LIST, ICON_CATS } = require('../src/pageIcons.js');
  const T = require('../tools/page-icons.js');
  assert.deepStrictEqual(ICON_CATS.map((c) => c.label), ['書類と仕事', '人と会議', '予定と時間', 'グラフと分析', 'お金と買い物', '知らせと印', '道具と機器', '場所と移動', '自然と暮らし', '矢印と操作']);
  const ids = ICON_LIST.map((x) => x.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'id が重なる');
  const pick = ICON_LIST.filter((x) => !x.ui);
  assert.strictEqual(new Set(pick.map((x) => x.n)).size, pick.length, '名前が重なる');
  const keys = new Set(ICON_CATS.map((c) => c.key));
  for (const x of pick) {
    assert.match(x.id, /^[a-z0-9_]{1,40}$/, x.id);
    assert.match(x.y, /^[ぁ-ゖー]+$/, `${x.id}: よみ`);
    assert.ok(x.n && keys.has(x.cat), `${x.id}: 分類`);
    assert.strictEqual(x.en, x.id.replace(/_/g, ' '));
  }
  assert.strictEqual(pick.filter((x) => x.src === 'dg').length, 60, 'デジタル庁の絵は 60（IQ4「60 種すべて」）');
  assert.strictEqual(pick.filter((x) => x.src === 'ms').length, 127, 'Material Symbols の絵は 127（IQ5）');
  assert.deepStrictEqual(ICON_LIST.filter((x) => x.ui).map((x) => x.id), ['settings', 'delete', 'library_books'], '飾りだけの絵');
  // 元のファイルの置き場: デジタル庁の 60 と Material Symbols の 130 だけがあり、表の絵とちょうど同じ
  const dir = (s) => fs.readdirSync(path.join(ROOT, 'assets', 'page-icons', s)).filter((f) => f.endsWith('.svg')).sort();
  assert.deepStrictEqual(dir('dg'), ICON_LIST.filter((x) => x.src === 'dg').map((x) => path.basename(T.fileOf(x))).sort());
  assert.deepStrictEqual(dir('ms'), ICON_LIST.filter((x) => x.src === 'ms').map((x) => path.basename(T.fileOf(x))).sort());
  const dgNames = new Set(dir('dg').map((f) => f.replace(/_line\.svg$/, '')));
  assert.deepStrictEqual(dir('ms').map((f) => f.replace(/_wght300_24px\.svg$/, '')).filter((n) => dgNames.has(n)), [], 'デジタル庁と Material Symbols に同じ名前');
  // 分類の中はデジタル庁が先（決めたこと 2）
  for (const c of ICON_CATS) {
    const srcs = pick.filter((x) => x.cat === c.key).map((x) => x.src);
    assert.deepStrictEqual(srcs, [...srcs].sort(), `${c.label}: デジタル庁が先でない`);
  }
  // 並びは分類の順
  assert.deepStrictEqual(pick.map((x) => x.cat), [...pick].sort((a, b) => [...keys].indexOf(a.cat) - [...keys].indexOf(b.cat)).map((x) => x.cat));
});

test('IG-1: 名前の表は、持ち主が承認した計画の付録の表（分類・元・名前・日本語の名前・よみ）と行の順まで同じ（IQ13「この文で作る（おすすめ）」）', () => {
  const { ICON_LIST, ICON_CATS } = require('../src/pageIcons.js');
  const plan = read('docs/plans/2026-11-13-170.md');
  const at = plan.indexOf('## 付録: 選びの窓に入れるアイコンの表');
  assert.ok(at > 0, '計画に付録の表が無い');
  const rows = [...plan.slice(at).matchAll(/^\| (\S+) \| (デジタル庁|Material Symbols) \| `([a-z0-9_]+)` \| (\S+) \| (\S+) \|$/gm)].map((m) => m.slice(1));
  assert.strictEqual(rows.length, 187);
  const label = new Map(ICON_CATS.map((c) => [c.key, c.label]));
  assert.deepStrictEqual(ICON_LIST.filter((x) => !x.ui).map((x) => [label.get(x.cat), x.src === 'dg' ? 'デジタル庁' : 'Material Symbols', x.id, x.n, x.y]), rows);
});

test('IG-1・F184: 出典（配る物の src/licenses/page-icons.txt に、デジタル庁の素材のページと利用規約の URL・加工の内容・国が作ったものでない一文・Material Symbols のリポジトリと commit・Apache License 2.0・全文の置き場・表にある出どころの全部と絵の名前。SOURCES.txt に zip の sha256）', () => {
  const { ICON_LIST } = require('../src/pageIcons.js');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('src/**/*'), '出典の文が配る物に入らない');
  const txt = read('src/licenses/page-icons.txt');
  for (const s of [
    'https://www.digital.go.jp/policies/servicedesign/designsystem/Illustration_Icons',
    'https://www.digital.go.jp/policies/servicedesign/designsystem/Illustration_Icons/terms_of_use',
    'ページのアイコンの一部は、デジタル庁の『イラストレーション・アイコン素材』（https://www.digital.go.jp/policies/servicedesign/designsystem/Illustration_Icons ）を元に、NaTsu が色を文字の色に合わせ、使わない切り抜きの指定を外し、日本語の名前を付けて使っています。デジタル庁がこのアプリを作ったり、確かめたりしたものではありません。',
    'ほかのアイコンは、Google の Material Symbols（https://github.com/google/material-design-icons 。Apache License 2.0）を元に、NaTsu が色を文字の色に合わせて使っています。',
    'https://github.com/google/material-design-icons', '10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7', 'Apache License 2.0', 'Apache-2.0.txt',
  ]) assert.ok(txt.includes(s), `出典の文に無い: ${s}`);
  assert.ok(!/国が作成|デジタル庁が作成/.test(txt), '国が作ったと読める文');
  // 表にある出どころの全部が、それぞれの節に絵の名前ごとに書いてある
  const MARK = { dg: '[デジタル庁]', ms: '[Material Symbols]' };
  for (const src of new Set(ICON_LIST.map((x) => x.src))) {
    assert.ok(MARK[src], `${src}: 知らない出どころ`);
    const at = txt.indexOf(MARK[src]);
    assert.ok(at >= 0, `出典の文に ${MARK[src]} の節が無い`);
    const sec = txt.slice(at, (txt.indexOf('\n[', at + 1) + 1 || txt.length + 1) - 1);
    for (const x of ICON_LIST.filter((y) => y.src === src)) assert.match(sec, new RegExp(`(^|[\\s,])${x.id}($|[\\s,])`), `${MARK[src]} の節に ${x.id} が無い`);
  }
  const sources = read('assets/page-icons/SOURCES.txt');
  for (const s of ['ce045533e2431b2e3368304562f9066a09cefddb93d319f1ed27b8769a752cf1', '7018476', 'designsystem-assets.zip', '10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7', 'https://github.com/google/material-design-icons']) {
    assert.ok(sources.includes(s), `SOURCES.txt に無い: ${s}`);
  }
});

