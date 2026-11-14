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

// ---------------------------------------------------------------- IG-2
test('IG-2・F179: isIconId・isPageIconValue の表（ic:mic は真。形の悪い名前・表に無い名前・持ち物の名前・41 字・向きの制御の字・飾りだけの絵・別の頭は偽。辞書の絵文字は今どおり真）', () => {
  const P = require('../src/pageIcons.js');
  for (const v of ['ic:mic', 'ic:certification_with_seal', 'ic:search', 'ic:lightbulb']) {
    assert.strictEqual(P.isIconId(v), true, v);
    assert.strictEqual(P.isPageIconValue(v), true, v);
  }
  for (const v of ['ic:', 'ic:MIC', 'ic:mic ', ' ic:mic', 'ic:mic\n', 'ic:__proto__', 'ic:constructor', 'ic:hasOwnProperty', 'ic:toString', `ic:${'a'.repeat(41)}`, 'ic:‮mic', 'ic:mi‮c',
    'ic:notaname', 'dg:mic', 'ms:mic', 'mic', 'IC:mic', '', null, undefined, 5, ['ic:mic'], { toString: () => 'ic:mic' }]) {
    assert.strictEqual(P.isIconId(v), false, String(JSON.stringify(v)));
    assert.strictEqual(P.isPageIconValue(v), false, String(JSON.stringify(v)));
  }
  // 画面の飾りだけの絵（ui）は表にあるが、ページのアイコンにできない
  for (const v of ['ic:settings', 'ic:delete', 'ic:library_books']) {
    assert.strictEqual(P.isIconId(v), true, v);
    assert.strictEqual(P.isPageIconValue(v), false, `${v}: 飾りの絵がページのアイコンに通る`);
  }
  // 今の絵文字（辞書の絵文字ちょうど1つ）は今どおり通る
  const D = require('../src/emojiDict.js');
  for (const e of ['🚀', '🎙️', '📄', '🗃️', D.EMOJI[0].e, D.EMOJI.at(-1).e]) assert.strictEqual(P.isPageIconValue(e), true, e);
  for (const e of ['🦕', '📄📄', '👍🏻', 'a']) assert.strictEqual(P.isPageIconValue(e), false, e);
});

test('IG-2・F180: pageIconOf の表（議事録はマイク・白紙は書類・データベースは表・行のページは書類。選んだ ic: と絵文字はそのまま・表に無い ic: と形の悪い値は既定で、値は書き替えない）', () => {
  const P = require('../src/pageIcons.js');
  assert.deepStrictEqual({ ...P.DEFAULT_ICON }, { meeting: 'ic:mic', blank: 'ic:certification_with_seal', database: 'ic:table_chart' });
  assert.ok(Object.isFrozen(P.DEFAULT_ICON));
  for (const v of Object.values(P.DEFAULT_ICON)) assert.strictEqual(P.isPageIconValue(v), true, `${v}: 既定が表に無い`);
  const cases = [
    [{}, 'ic:mic'], [{ kind: undefined }, 'ic:mic'], [{ kind: 'blank' }, 'ic:certification_with_seal'], [{ kind: 'database' }, 'ic:table_chart'],
    [{ kind: 'row', db: 'pdb1' }, 'ic:certification_with_seal'], [{ kind: 'row', db: 'pdb1', icon: '🚀' }, 'ic:certification_with_seal'],
    [{ icon: 'ic:star' }, 'ic:star'], [{ kind: 'blank', icon: 'ic:star' }, 'ic:star'], [{ kind: 'database', icon: 'ic:mic' }, 'ic:mic'], [{ kind: 'blank', icon: '🚀' }, '🚀'], [{ icon: '🎙️' }, '🎙️'],
    [{ icon: 'ic:notaname' }, 'ic:mic'], [{ kind: 'blank', icon: 'ic:notaname' }, 'ic:certification_with_seal'], [{ kind: 'database', icon: 'ic:__proto__' }, 'ic:table_chart'],
    [{ kind: 'blank', icon: 'ic:settings' }, 'ic:certification_with_seal'], [{ kind: 'blank', icon: 'x' }, 'ic:certification_with_seal'], [{ icon: '' }, 'ic:mic'], [{ icon: 5 }, 'ic:mic'],
    [null, 'ic:mic'], [undefined, 'ic:mic'],
  ];
  for (const [e, want] of cases) {
    const before = JSON.stringify(e);
    assert.strictEqual(P.pageIconOf(e), want, before);
    assert.strictEqual(JSON.stringify(e), before, '値を書き替えた');
  }
});

test('IG-2: findIcons の表（よみ・カタカナ・漢字・半角カナで書類が先・英語の元の名前・前方一致が先・飾りだけの絵と絵文字は出ない・空の語は空・語を文法として読まない）', () => {
  const P = require('../src/pageIcons.js');
  for (const q of ['しょるい', 'ショルイ', '書類', 'ｼｮﾙｲ', ' しょ るい ']) {
    const hits = P.findIcons(q);
    assert.strictEqual(hits[0], 'ic:certification_with_seal', q);
    assert.ok(hits.includes('ic:application'), `${q}: 中の一致（ちぇっくしたしょるい）が無い`);
    assert.ok(hits.indexOf('ic:certification_with_seal') < hits.indexOf('ic:application'), `${q}: 前方一致が先でない`);
  }
  assert.deepStrictEqual(P.findIcons('mic'), ['ic:mic']);
  assert.deepStrictEqual(P.findIcons('Mic'), ['ic:mic']);
  assert.deepStrictEqual(P.findIcons('まいく'), ['ic:mic']);
  assert.strictEqual(P.findIcons('table')[0], 'ic:table_chart', '英語の名前（_ は空白）');
  assert.ok(P.findIcons('table chart').includes('ic:table_chart'));
  for (const q of ['settings', 'library', 'delete']) assert.deepStrictEqual(P.findIcons(q).filter((v) => ['ic:settings', 'ic:library_books', 'ic:delete'].includes(v)), [], `${q}: 飾りの絵が出た`);
  assert.deepStrictEqual(P.findIcons('settings'), []);
  for (const q of ['', '   ', null, undefined]) assert.deepStrictEqual(P.findIcons(q), [], String(q));
  for (const q of ['.*', '(', '[a-z]', '\\', 'しょるい|まいく']) assert.doesNotThrow(() => P.findIcons(q), q);
  assert.deepStrictEqual(P.findIcons('.*'), []);
  for (const q of ['ろけっと', 'ほし', 'しょるい']) assert.ok(P.findIcons(q).every((v) => /^ic:[a-z0-9_]+$/.test(v)), `${q}: 絵文字が混じった`);
  // 名前（ボタンの aria-label と title）
  assert.strictEqual(P.iconNameOf('ic:mic'), 'マイク');
  assert.strictEqual(P.iconNameOf('ic:certification_with_seal'), '書類');
  assert.strictEqual(P.iconNameOf('🚀'), require('../src/emojiDict.js').EMOJI.find((x) => x.e === '🚀').n);
  for (const v of ['ic:notaname', 'x', '', null]) assert.strictEqual(P.iconNameOf(v), '', String(v));
});

test('IG-2・F183: 最近使ったもの（emojiRecent に ic: と絵文字が混じって残る・形の悪い値と重なりと飾りだけの絵は落ちる・25 個目は落ちる・0.16.0 の照らしで読むと ic: だけが落ちて絵文字は残る）', () => {
  const W = require('../src/winstate.js');
  const D1 = [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  const raw = { v: 1, zoom: 1.25, emojiRecent: ['ic:mic', '📄', 'ic:mic', 'ic:notaname', 'ic:settings', 'ic:__proto__', '🎙️', 'x', 5, 'ic:star'] };
  const r = W.normalize(raw, D1);
  assert.deepStrictEqual(r.state.emojiRecent, ['ic:mic', '📄', '🎙️', 'ic:star']);
  assert.deepStrictEqual(r.repaired, ['emojiRecent']);
  assert.strictEqual(r.state.zoom, 1.25, 'ほかの項目を落とした');
  const ok = W.normalize({ v: 1, emojiRecent: ['ic:mic', '🚀', 'ic:star'] }, D1);
  assert.deepStrictEqual([ok.state.emojiRecent, ok.repaired], [['ic:mic', '🚀', 'ic:star'], []]);
  const P = require('../src/pageIcons.js');
  const many = P.ICON_LIST.filter((x) => !x.ui).slice(0, 25).map((x) => `ic:${x.id}`);
  assert.deepStrictEqual(W.normalize({ v: 1, emojiRecent: many }, D1).state.emojiRecent, many.slice(0, 24));
  // 画面から来た値も同じ照らし
  assert.deepStrictEqual(W.applyUi(W.defaults(), { emojiRecent: ['ic:mic', 'ic:bad', '🚀'] }).emojiRecent, ['ic:mic', '🚀']);
  // 0.16.0 の照らし（0a6a375 の src/winstate.js の normEmojiRecent を写した見本: 辞書の絵文字だけ）で読むと、ic: だけが落ち、絵文字は残る（RF17・決めたこと 11）
  const D = require('../src/emojiDict.js');
  const norm160 = (list) => { if (!Array.isArray(list)) return []; const out = []; for (const e of list) { if (!D.isPageIcon(e) || out.includes(e)) continue; out.push(e); } return out.slice(0, 24); };
  assert.deepStrictEqual(norm160(r.state.emojiRecent), ['📄', '🎙️']);
});

test('IG-2（P4）: 画面の写し（app.html の pageIconView）は src/pageIcons.js と字も答えも同じ', () => {
  const P = require('../src/pageIcons.js');
  const D = require('../src/emojiDict.js');
  const HTML = read('src/renderer/app.html');
  const at = HTML.indexOf('  // ---- pageIcons の写し');
  const end = HTML.indexOf('  // ---- pageIcons の写しはここまで');
  assert.ok(at > 0 && end > at, 'app.html に pageIcons の写しが無い');
  const seg = HTML.slice(at, end);
  const SRC = read('src/pageIcons.js');
  const body = SRC.slice(SRC.indexOf('const ICON_CATS'), SRC.indexOf('\nmodule.exports')).replace(/\s+$/, '');
  assert.ok(seg.includes(body.split('\n').map((x) => (x ? `    ${x}` : x)).join('\n')), 'app.html の pageIcons の写しの字が src/pageIcons.js と違う');
  const v = new Function('emojiView', `${seg}\nreturn pageIconView;`)(D);   // eslint-disable-line no-new-func
  assert.deepStrictEqual(v.ICON_LIST.map((x) => [x.id, x.src, x.cat, x.n, x.y, x.en, Boolean(x.ui)]), P.ICON_LIST.map((x) => [x.id, x.src, x.cat, x.n, x.y, x.en, Boolean(x.ui)]));
  assert.deepStrictEqual({ ...v.DEFAULT_ICON }, { ...P.DEFAULT_ICON });
  for (const q of ['しょるい', 'ｼｮﾙｲ', 'mic', 'table chart', '']) assert.deepStrictEqual(v.findIcons(q), P.findIcons(q), q);
  for (const x of ['ic:mic', 'ic:settings', 'ic:__proto__', '🚀', 'x']) {
    assert.strictEqual(v.isIconId(x), P.isIconId(x), x);
    assert.strictEqual(v.isPageIconValue(x), P.isPageIconValue(x), x);
    assert.strictEqual(v.iconNameOf(x), P.iconNameOf(x), x);
  }
  for (const e of [{ icon: 'ic:star' }, { kind: 'blank' }, {}, { kind: 'database' }, { kind: 'row', db: 'p1' }, { icon: 'x', kind: 'blank' }]) assert.strictEqual(v.pageIconOf(e), P.pageIconOf(e));
});
