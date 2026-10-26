/*
 * winstate.test.js — 第1b回 N6 の画面の覚え書きの照らし（純粋な関数）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const W = require('../src/winstate');

const D1 = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
const D2 = [...D1, { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, workArea: { x: 1920, y: 0, width: 1280, height: 984 } }];
// 0.9.0 U-1（SP3）で意図して変えた: 設定はタブで開かない（settings は読むときに落とす）ので、見本の固定のタブは dictation にした
// 0.13.0 ED-5（計画 docs/plans/2026-10-24-130.md の決めたこと 39）で意図して変えた: 正しい覚え書きに / メニューの「最近使ったもの」（slashRecent）がある
const good = (o = {}) => ({ v: 1, bounds: { x: 100, y: 80, width: 1200, height: 800 }, maximized: false, zoom: 1.25, sidebar: { width: 300, collapsed: false }, tabs: { open: ['page:pa1', 'dictation'], active: 'dictation' }, slashRecent: ['h2'], ...o });

test('N6: 置き場所は %LOCALAPPDATA%\\natsu\\window-state.json（Roaming の userData ではない）。無ければ userData', () => {
  const local = path.join(path.parse(process.cwd()).root, 'Local');
  assert.deepStrictEqual(W.statePath({ LOCALAPPDATA: local }, '/u'), { file: path.join(local, 'natsu', 'window-state.json'), local: true });
  assert.deepStrictEqual(W.statePath({}, path.join('/', 'u')), { file: path.join('/', 'u', 'window-state.json'), local: false });
  assert.strictEqual(W.statePath({ LOCALAPPDATA: 'relative' }, path.join('/', 'u')).local, false, '相対パスを信じた');
});

test('N6: 正しい覚え書きはそのまま。無い・形の違うファイルは既定（1120×780・位置なし＝真ん中・100%・幅 260）', () => {
  assert.deepStrictEqual(W.normalize(good(), D1), { state: good(), repaired: [] });
  for (const raw of [undefined, null, [], 'x', 3]) {
    assert.deepStrictEqual(W.normalize(raw, D1).state, W.defaults(), JSON.stringify(raw));
  }
  assert.deepStrictEqual(W.defaults().bounds, { width: 1120, height: 780 }, '既定に位置を入れた（真ん中に出なくなる）');
});

test('N6・F1: 大きさは整数で 820×560 以上・上限あり。外れた・小数・文字なら既定の大きさと位置なし', () => {
  for (const b of [{ x: 0, y: 0, width: 500, height: 800 }, { x: 0, y: 0, width: 1200.5, height: 800 }, { x: 0, y: 0, width: '1200', height: 800 }, { x: 0, y: 0, width: 20000, height: 800 }]) {
    const r = W.normalize(good({ bounds: b }), D1);
    assert.deepStrictEqual(r.state.bounds, { width: 1120, height: 780 }, JSON.stringify(b));
    assert.ok(r.repaired.includes('bounds'));
  }
});

test('N6・F1: 今つながっている画面のどれかの作業領域に 120×40 以上重なること。2つ目の画面を外したら真ん中に戻す', () => {
  const onSecond = good({ bounds: { x: 2100, y: 100, width: 1000, height: 700 } });
  assert.deepStrictEqual(W.normalize(onSecond, D2).state.bounds, onSecond.bounds, '2つの画面なら2つ目に戻す');
  assert.deepStrictEqual(W.normalize(onSecond, D1).state.bounds, { width: 1120, height: 780 }, '外した画面の上に出した');
  assert.strictEqual(W.onScreen({ x: 1800, y: 0, width: 1000, height: 700 }, D1), true, '120 重なれば見える');
  assert.strictEqual(W.onScreen({ x: 1801, y: 0, width: 1000, height: 700 }, D1), false, '119 しか重ならないのに見えるとした');
  assert.strictEqual(W.onScreen({ x: 100, y: 1001, width: 1000, height: 700 }, D1), false, '下に 39 しか出ていない');
  assert.strictEqual(W.onScreen({ width: 1000, height: 700 }, D1), false, '位置が無いのに見えるとした');
});

test('N6・F2: 覚えるのは getNormalBounds（最小化中の -32000 を残さない）', () => {
  const win = { getNormalBounds: () => ({ x: 100.4, y: 80, width: 1200, height: 799.6 }), getBounds: () => ({ x: -32000, y: -32000, width: 160, height: 28 }) };
  assert.deepStrictEqual(W.boundsOf(win), { x: 100, y: 80, width: 1200, height: 800 });
});

test('N6・F4: 拡大の段は 67〜200%。Ctrl+＋／－／0 と JIS の Ctrl+；、テンキー。段に無い値は 100%', () => {
  assert.deepStrictEqual(W.ZOOM_STEPS, [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
  const k = (key, o = {}) => W.zoomDir({ type: 'keyDown', key, code: o.code || '', control: true, meta: false, alt: false, shift: Boolean(o.shift), ...o });
  assert.strictEqual(k('='), 'in'); assert.strictEqual(k('+', { shift: true }), 'in'); assert.strictEqual(k(';'), 'in');
  assert.strictEqual(k('+', { code: 'NumpadAdd' }), 'in'); assert.strictEqual(k('-'), 'out'); assert.strictEqual(k('-', { code: 'NumpadSubtract' }), 'out');
  assert.strictEqual(k('0'), 'reset'); assert.strictEqual(k('0', { code: 'Numpad0' }), 'reset');
  assert.strictEqual(k('p'), null); assert.strictEqual(k('=', { control: false }), null); assert.strictEqual(k('=', { alt: true }), null);
  assert.strictEqual(W.zoomDir({ type: 'keyUp', key: '=', control: true }), null, 'キーを離したときにも動かした');
  assert.strictEqual(W.stepZoom(1, 'in'), 1.1); assert.strictEqual(W.stepZoom(2, 'in'), 2, '200% を越えた');
  assert.strictEqual(W.stepZoom(0.67, 'out'), 0.67); assert.strictEqual(W.stepZoom(1.75, 'reset'), 1);
  assert.strictEqual(W.stepZoom(1.33, 'in'), 1.1, '段に無い値から動かした');
  for (const z of [3, 0.5, 1.33, '1.5', null]) assert.strictEqual(W.normalize(good({ zoom: z }), D1).state.zoom, 1, String(z));
});

test('N6: サイドバーの幅は整数で 200〜480 に寄せ、畳みは真偽値', () => {
  assert.deepStrictEqual(W.normalize(good({ sidebar: { width: 9999, collapsed: 'yes' } }), D1).state.sidebar, { width: 480, collapsed: false });
  assert.deepStrictEqual(W.applyUi(W.defaults(), { sidebar: { width: 120.7 } }).sidebar, { width: 200, collapsed: false });
  assert.deepStrictEqual(W.applyUi(W.defaults(), { sidebar: { collapsed: true } }).sidebar, { width: 260, collapsed: true });
});

test('N6・F7: タブは形の正しい鍵だけ・録音中のページ（live）は覚えない・無いページは外して数を返す・20 まで', () => {
  assert.strictEqual(W.tabKeyOk('live'), false);
  assert.strictEqual(W.tabKeyOk('page:../x'), false);
  assert.strictEqual(W.tabKeyOk('page:pmz3k1abcd'), true);
  const r = W.keepTabs({ open: ['page:pa1', 'page:pgone', 'live', 'dictation', 'evil'], active: 'page:pgone' }, (id) => id === 'pa1');
  assert.deepStrictEqual(r, { tabs: { open: ['page:pa1', 'dictation'], active: 'dictation' }, dropped: 3 });
  const many = Array.from({ length: 30 }, (_, i) => `page:p${i}`);
  assert.strictEqual(W.applyUi(W.defaults(), { tabs: { open: many, active: 'page:p29' } }).tabs.open.length, 20);
  // 0.9.0 U-1（SP3）で意図して変えた: 固定のタブは dictation だけ（settings は下の SP3 のテスト）
  assert.deepStrictEqual(W.applyUi(W.defaults(), { tabs: { open: ['live', 'dictation'], active: 'live' } }).tabs, { open: ['dictation'], active: 'dictation' });
});

// 0.9.0 U-1（SP3・D24）: 設定はタブでなくポップアップで開く。前の版が覚えたタブの settings は、読むときに黙って落とす
//（無いページとして数えない: 数えると main が「無いページのタブを N 個外した」と事実と違う記録を書く）
test('SP3: TAB_FIXED は dictation だけ。settings は黙って落とす（dropped に数えない・active が settings なら残りの最後）', () => {
  assert.strictEqual(W.tabKeyOk('settings'), false);
  assert.strictEqual(W.tabKeyOk('dictation'), true);
  assert.deepStrictEqual(W.keepTabs({ open: ['page:pa1', 'settings', 'dictation'], active: 'settings' }, () => true), { tabs: { open: ['page:pa1', 'dictation'], active: 'dictation' }, dropped: 0 });
  assert.deepStrictEqual(W.keepTabs({ open: ['settings', 'page:pgone'], active: 'settings' }, () => false), { tabs: { open: [], active: '' }, dropped: 1 });
  assert.deepStrictEqual(W.normalize(good({ tabs: { open: ['page:pa1', 'settings'], active: 'settings' } }), D1).state.tabs, { open: ['page:pa1'], active: 'page:pa1' });
  assert.deepStrictEqual(W.applyUi(W.defaults(), { tabs: { open: ['settings', 'page:pa1'], active: 'settings' } }).tabs, { open: ['page:pa1'], active: 'page:pa1' });
});

// ---------------------------------------------------------------- 0.13.0 ED-5（決めたこと 37〜40・F52）
test('ED-5・F52: normalize は slashRecent を照らす（無い → []・配列でない → [] で repaired に slashRecent・知らない鍵と重なりと4つ目を落とす・正しい値はそのまま）', () => {
  assert.deepStrictEqual(W.defaults().slashRecent, []);
  const { slashRecent: _drop, ...noRecent } = good();
  void _drop;
  assert.deepStrictEqual(W.normalize(noRecent, D1), { state: { ...good(), slashRecent: [] }, repaired: [] });
  for (const [v, want, fixed] of [
    [['h2'], ['h2'], false], [['h1', 'todo', 'callout'], ['h1', 'todo', 'callout'], false], [[], [], false],
    ['h2', [], true], [null, [], true], [{ 0: 'h2' }, [], true], [3, [], true],
    [['x', 1, 'h2', null], ['h2'], true], [['h2', 'h2', 'todo'], ['h2', 'todo'], true], [['h1', 'h2', 'h3', 'todo'], ['h1', 'h2', 'h3'], true],
    [['toggle', 'th1', 'quote'], ['quote'], true], [['会議の題名', 'pa1', 'b2'], [], true],
  ]) {
    const r = W.normalize(good({ slashRecent: v }), D1);
    assert.deepStrictEqual(r.state.slashRecent, want, JSON.stringify(v));
    assert.strictEqual(r.repaired.includes('slashRecent'), fixed, JSON.stringify(v));
    assert.deepStrictEqual(r.repaired.filter((k) => k !== 'slashRecent'), [], JSON.stringify(v));
  }
});

test('ED-5・F52: applyUi も slashRecent を同じく照らす。ほかの項目は変えない。知らないトップの鍵は今どおり落ちる', () => {
  assert.deepStrictEqual(W.applyUi(W.defaults(), { slashRecent: ['h2'] }).slashRecent, ['h2']);
  assert.deepStrictEqual(W.applyUi(good(), { slashRecent: ['quote', 'quote', 'x', 'h1', 'h2', 'h3'] }).slashRecent, ['quote', 'h1', 'h2']);
  assert.deepStrictEqual(W.applyUi(good(), { slashRecent: 'h1' }).slashRecent, []);
  assert.deepStrictEqual(W.applyUi(good(), { sidebar: { width: 320 } }).slashRecent, ['h2'], '別の項目を送ると最近使ったものが消えた');
  const { slashRecent: _r, ...rest } = W.applyUi(good(), { slashRecent: ['todo'] });
  void _r;
  const { slashRecent: _g, ...restGood } = good();
  void _g;
  assert.deepStrictEqual(rest, restGood);
  assert.ok(!('extra' in W.normalize(good({ extra: 1 }), D1).state), '知らないトップの鍵が残った');
  assert.ok(!('extra' in W.applyUi(good(), { extra: 1 })), '画面から来た知らない鍵が残った');
});
