/* stage150.look.lib.test.js — 0.15.0 Task PL-1（U2・U6・F119。計画 docs/plans/2026-11-03-150.md の決めたこと 35〜39・BQ9 (a)）:
 * ページのアイコンの自作の辞書（src/emojiDict.js）・見た目の照らし（src/pageLook.js）・最近使ったアイコンの覚え書き（src/winstate.js の emojiRecent） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/emojiDict');
const L = require('../src/pageLook');
const W = require('../src/winstate');

const SEG = new Intl.Segmenter('ja', { granularity: 'grapheme' });
const graphemes = (s) => [...SEG.segment(s)].length;
const FLAGS = /[\u{1f1e6}-\u{1f1ff}]|[\u{1f3c1}\u{1f3f3}\u{1f3f4}\u{1f6a9}\u{1f38c}]/u;   // 国旗（地域の印の対）・🏁・🏳️・🏴・🚩・🎌

// ---------------------------------------------------------------- 辞書
test('PL-1・BQ9 (a): 辞書の形（約 500・どれも書記素 1 つの RGI の絵文字・重なりなし・旗が無い・分類は CATS のどれか・名前とよみがある（よみはひらがなだけ）・DEFAULT_ICON の2つが辞書にある）', () => {
  assert.ok(D.EMOJI.length >= 450 && D.EMOJI.length <= 550, `辞書の数が約 500 でない: ${D.EMOJI.length}`);
  assert.deepStrictEqual(D.CATS.map((c) => c.label), ['顔', '人と手', '動物と自然', '食べ物', '活動', '旅と場所', '物', '記号']);
  const keys = new Set(D.CATS.map((c) => c.key));
  const seen = new Set();
  for (const x of D.EMOJI) {
    assert.strictEqual(graphemes(x.e), 1, `書記素が1つでない: ${x.e}`);
    assert.ok(/^\p{RGI_Emoji}$/v.test(x.e), `RGI の絵文字の形でない（U+FE0F の付け忘れなど）: ${x.e} ${x.n}`);
    assert.ok(!/[‍\u{1f3fb}-\u{1f3ff}]/u.test(x.e), `ZWJ のつなぎか肌の色: ${x.e}`);
    assert.ok(!FLAGS.test(x.e), `旗がある: ${x.e}`);
    assert.ok(!seen.has(x.e), `重なり: ${x.e}`);
    seen.add(x.e);
    assert.ok(keys.has(x.c), `分類が CATS に無い: ${x.e} ${x.c}`);
    assert.ok(typeof x.n === 'string' && x.n.length > 0 && !/\s/.test(x.n), `名前が無い: ${x.e}`);
    assert.ok(/^[ぁ-ゖー]+$/.test(x.y), `よみがひらがなだけでない（外来語の長音の「ー」のほか）: ${x.e} ${x.y}`);
  }
  for (const c of D.CATS) assert.ok(D.EMOJI.filter((x) => x.c === c.key).length >= 40, `分類 ${c.label} の絵文字が少ない`);
  assert.deepStrictEqual(D.DEFAULT_ICON, { meeting: '🎙️', blank: '📄', database: '🗃️' });   // 0.16.0 DX-1（前提 P6）で意図して変えた: データベースの既定 🗃️ を足した
  for (const e of Object.values(D.DEFAULT_ICON)) assert.ok(seen.has(e), `既定のアイコン ${e} が辞書に無い`);
  assert.ok(Object.isFrozen(D.EMOJI) && Object.isFrozen(D.EMOJI[0]) && Object.isFrozen(D.CATS), '辞書を書き換えられる');
});

test('PL-1・F119: isPageIcon の表（辞書の絵文字は真／2つ・文字・文・向きの制御・空・辞書に無い絵文字・U+FE0F の無い形・文字でない値は偽）', () => {
  for (const e of ['📄', '🎙️', '😀', '❤️', '☀️', '🔆']) assert.strictEqual(D.isPageIcon(e), true, e);
  for (const v of ['📄📄', 'a', '書類', '議事録の題名', '‮', '‮📄', '📄​', '', ' ', '🦕', '🎙', '🇯🇵', '🏁', '👍🏻', null, undefined, 5, ['📄'], { e: '📄' }]) {
    assert.strictEqual(D.isPageIcon(v), false, JSON.stringify(v));
  }
});

test('PL-1: findEmoji の表（名前・よみ。カタカナはひらがなに・全角と半角を寄せる・前方一致が先・空は空）', () => {
  for (const q of ['しょるい', 'ショルイ', '書類', 'ｼｮﾙｲ', ' しょるい ']) assert.strictEqual(D.findEmoji(q)[0], '📄', q);
  assert.deepStrictEqual(D.findEmoji('しょるい'), ['📄', '🗂️'], '前方一致（書類）が中の一致（仕切りの書類入れ）より先でない');
  assert.ok(D.findEmoji('コーヒー').includes('☕') && D.findEmoji('こーひー').includes('☕'));
  assert.ok(D.findEmoji('ｺｰﾋｰ').includes('☕'), '半角のカタカナを寄せない');
  // PL-1・PH-8 直し 2（rv32）: 英字の大小を寄せる（名前「Tシャツ」）。全角の英字も
  for (const q of ['tしゃつ', 'Tシャツ', 'ｔしゃつ', 'Ｔシャツ']) assert.strictEqual(D.findEmoji(q)[0], '👕', q);
  assert.ok(D.findEmoji('ねこ').includes('🐱') && D.findEmoji('猫').includes('🐱'));
  // 前方一致（ねこ・ねずみ…ではなく「ね」で始まる名前とよみ）が先で、中の一致（笑う猫）は後ろ
  const neko = D.findEmoji('ねこ');
  assert.ok(neko.indexOf('🐱') < neko.indexOf('😺'), '前方一致が先でない');
  for (const q of ['', '   ', null, undefined]) assert.deepStrictEqual(D.findEmoji(q), [], String(q));
  assert.deepStrictEqual(D.findEmoji('あいうえおかきくけこ'), []);
  // 当たったのはどれも辞書の絵文字
  for (const e of D.findEmoji('い')) assert.ok(D.isPageIcon(e), e);
});

test('PL-1: pageIconOf（icon が辞書の絵文字ならそれ・無ければ議事録 🎙️・白紙のページ 📄・辞書に無い値と空は既定）', () => {
  assert.strictEqual(D.pageIconOf({ icon: '🚀', kind: 'blank' }), '🚀');
  assert.strictEqual(D.pageIconOf({ icon: '🚀' }), '🚀');
  assert.strictEqual(D.pageIconOf({}), '🎙️');
  assert.strictEqual(D.pageIconOf({ kind: 'blank' }), '📄');
  assert.strictEqual(D.pageIconOf({ kind: 'blank', icon: '' }), '📄', '外した（空の）アイコンが既定に戻らない');
  assert.strictEqual(D.pageIconOf({ icon: '' }), '🎙️');
  for (const icon of ['‮長い文', '📄📄', 'x', 7]) assert.strictEqual(D.pageIconOf({ kind: 'blank', icon }), '📄', String(icon));
  assert.strictEqual(D.pageIconOf(null), '🎙️');
  assert.strictEqual(D.pageIconOf(undefined), '🎙️');
});

// ---------------------------------------------------------------- 見た目
test('PL-1・F119: normalizeLook の表（決まった形は通る／知らない欄・真でない値・決まった書体のほかは投げる／全部既定は {}）と isPlainLook・lookClasses の表', () => {
  assert.deepStrictEqual(L.FONTS, ['serif', 'mono']);
  assert.deepStrictEqual(L.normalizeLook({ wide: true }), { wide: true });
  assert.deepStrictEqual(L.normalizeLook({ small: true }), { small: true });
  assert.deepStrictEqual(L.normalizeLook({ font: 'serif' }), { font: 'serif' });
  assert.deepStrictEqual(L.normalizeLook({ font: 'mono' }), { font: 'mono' });
  assert.deepStrictEqual(L.normalizeLook({ font: 'mono', small: true, wide: true }), { wide: true, small: true, font: 'mono' });
  assert.deepStrictEqual(L.normalizeLook({}), {});
  for (const v of [{ font: 'gothic' }, { font: '' }, { font: 'serif;color:red' }, { font: ['serif'] }, { wide: 1 }, { wide: false }, { small: 'true' }, { color: 'red' }, { wide: true, extra: 1 },
    null, undefined, 'wide', ['wide'], 5]) {
    assert.throws(() => L.normalizeLook(v), (e) => e.code === 'bad-look', JSON.stringify(v));
  }
  // 名前を変えた物（前の版の値・JSON から来た物でない物）も通さない
  assert.throws(() => L.normalizeLook(Object.create({ wide: true })), (e) => e.code === 'bad-look');
  assert.strictEqual(L.isPlainLook({}), true, '全部既定の見た目を既定と見ない（DB が欄を消さない）');
  assert.strictEqual(L.isPlainLook(L.normalizeLook({})), true);
  for (const v of [{ wide: true }, { font: 'serif' }, null, undefined]) assert.strictEqual(L.isPlainLook(v), false, JSON.stringify(v));
  assert.deepStrictEqual(L.lookClasses({ wide: true, small: true, font: 'serif' }), ['look-wide', 'look-small', 'look-serif']);
  assert.deepStrictEqual(L.lookClasses({ font: 'mono' }), ['look-mono']);
  assert.deepStrictEqual(L.lookClasses({}), []);
  for (const v of [undefined, null, { font: 'gothic' }, { color: 'red' }, { wide: 1 }]) assert.deepStrictEqual(L.lookClasses(v), [], JSON.stringify(v));
});

// ---------------------------------------------------------------- 最近使ったもの
test('PL-1: winstate の emojiRecent（辞書に無い・重なり・25 個目は落とす・ほかの項目は残る・画面から来た値も同じ照らし）', () => {
  const D1 = [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  assert.deepStrictEqual(W.defaults().emojiRecent, []);
  assert.strictEqual(W.EMOJI_RECENT_MAX, 24);
  const ok = D.EMOJI.slice(0, 30).map((x) => x.e);
  // 辞書に無い・重なり・文字でない値は落とし、ほかの項目は残す（直した項目の名前は emojiRecent だけ）
  const raw = { v: 1, zoom: 1.25, sidebar: { width: 300, collapsed: true }, emojiRecent: ['📄', 'x', '📄', '‮', 5, '🎙️', '🦕', '📄📄'] };
  const r = W.normalize(raw, D1);
  assert.deepStrictEqual(r.state.emojiRecent, ['📄', '🎙️']);
  assert.deepStrictEqual(r.repaired, ['emojiRecent']);
  assert.strictEqual(r.state.zoom, 1.25);
  assert.deepStrictEqual(r.state.sidebar, { width: 300, collapsed: true });
  // 新しい（先の）24 個を残し、25 個目からは落とす
  const many = W.normalize({ v: 1, emojiRecent: ok.slice(0, 25) }, D1);
  assert.deepStrictEqual(many.state.emojiRecent, ok.slice(0, 24));
  assert.deepStrictEqual(many.repaired, ['emojiRecent']);
  // 正しい値は直したことにしない・無ければ既定
  assert.deepStrictEqual(W.normalize({ v: 1, emojiRecent: ok.slice(0, 24) }, D1), { state: { ...W.defaults(), emojiRecent: ok.slice(0, 24) }, repaired: [] });
  assert.deepStrictEqual(W.normalize({ v: 1 }, D1).state.emojiRecent, []);
  for (const bad of ['📄', { e: '📄' }, null]) {
    const b = W.normalize({ v: 1, emojiRecent: bad }, D1);
    assert.deepStrictEqual([b.state.emojiRecent, b.repaired], [[], ['emojiRecent']], JSON.stringify(bad));
  }
  // 画面から来た値（ui:set）も同じ照らし。ほかの項目は変えない
  const s0 = { ...W.defaults(), tree: { open: ['pa1'] } };
  const s1 = W.applyUi(s0, { emojiRecent: ['🚀', 'x', '🚀', ...ok] });
  assert.deepStrictEqual(s1.emojiRecent, ['🚀', ...ok.filter((e) => e !== '🚀')].slice(0, 24));
  assert.deepStrictEqual(s1.tree, { open: ['pa1'] });
  assert.deepStrictEqual(W.applyUi(s1, { sidebar: { width: 300 } }).emojiRecent, s1.emojiRecent, '別の項目の ui:set で最近使ったものが消える');
});
