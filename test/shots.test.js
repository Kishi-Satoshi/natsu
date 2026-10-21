/*
 * shots.test.js — 画面を撮って比べる道具（第1a回 G2・PERF）の決め方
 * 本物の Electron で撮るのは Windows の CI（electron-smoke）だけ。ここでは画面の並び・偽の橋の名前・比べ方・揺れ・CSP・速さ・CI の段を見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SH = require('../tools/shots/screens');
const P = require('../tools/png');
const { preloadApis } = require('./helpers/simrun');
const { jobsOf, stepsOf } = require('./helpers/yml');
const PS = require('../tools/shots/pill-states');
const lib = require('../src/mainlib');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const img = (w, h, fill = [255, 255, 255, 255]) => ({ width: w, height: h, data: Buffer.from(Array.from({ length: w * h }, () => fill).flat()) });
// 一時フォルダ（日本語と 𠮷 の名前。RF1 と同じ形）。テストの終わりに消す
const tmp = (t, name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `natsu-画面𠮷-${name}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

// 第1b回 Task C-1 で意図して変えた: 撮る画面は 7 から 13 へ（タブ・畳んだサイドバー・記録中のページの明暗・200% の2つ）
// 第1b2回 Task R-3 で意図して変えた: 最後に検索の窓の画面を足す（14）
// 第1d回 Task A-7（RL14・D17）で意図して変えた: 最後に録音中のページの帯の画面（live-banner-light）を足す（15）
// 第1d回 Task A-13（あとの直し (b)）で意図して変えた: 最後に帯の暗い画面（live-banner-dark）と 200% の暗い画面（live-banner-zoom200-dark）を足す（17）
// 0.9.0 O-3（設計書 D25・RP9）で意図して変えた: 録音バーの画面 overlay-processing を外し、録音バーの画面（pill-states の状態 × 形 × 地 × 拡大率の 80 枚）を最後に足した
test('G2: 撮る画面は決まった並び（第1b回の 13 と第1b2回の検索の窓と第1d回の録音中のページの帯の3枚から録音バーの1枚を外し、0.9.0 の録音バーの 80 枚）で、名前は重ならない', { timeout: 5000 }, () => {
  assert.deepStrictEqual(SH.SCREENS.filter((s) => s.page === 'app').map((s) => s.name), ['notes-empty-light', 'notes-page-light', 'notes-page-dark', 'dictation-light', 'settings-light', 'settings-dark',
    'notes-tabs-light', 'notes-collapsed-light', 'live-light', 'live-dark', 'notes-page-zoom200-light', 'settings-zoom200-dark', 'search-palette-light', 'live-banner-light',
    'live-banner-dark', 'live-banner-zoom200-dark',
    // 0.9.0 U-2（SP4・SP5）で意図して変えた: 設定のポップアップの項目「録音」と検索の画面を足した（取り直し待ち・まだ基準が無い）
    'settings-record-light', 'settings-search-light',
    // 0.9.0 U-3（OF7）で意図して変えた: 準備を選んでいない人のカード「オフライン」の画面を足した（取り直し待ち・まだ基準が無い）
    'settings-offline-light']);
  assert.deepStrictEqual(SH.SCREENS.filter((s) => s.page === 'overlay').map((s) => s.name), PS.screenNames());
  assert.ok(SH.SCREENS.findIndex((s) => s.page === 'overlay') > SH.SCREENS.map((s) => s.page).lastIndexOf('app'), '録音バーの画面が本体の画面の間にある');
  assert.strictEqual(new Set(SH.SCREENS.map((s) => s.name)).size, SH.SCREENS.length, '名前が重なっている');
  for (const s of SH.SCREENS) assert.ok(['app', 'overlay'].includes(s.page) && ['light', 'dark'].includes(s.theme), s.name);
  assert.deepStrictEqual(SH.SCREENS.filter((s) => s.zoom).map((s) => [s.name, s.zoom]), [['notes-page-zoom200-light', 2], ['settings-zoom200-dark', 2], ['live-banner-zoom200-dark', 2]]);
  const live = SH.SCREENS.find((s) => s.name === 'live-light');
  const st = live.answers['koeApp.meetingStatus'];
  assert.ok(st.active && st.cloud && st.pauses.length === 1, '記録中の画面に一時停止の印か［PC の中だけ］が出ない');
});

// 第1d回 Task A-7（RL14・D17）: 録音中のページの2枚は状態の行（クラウド・最後の文字 12 秒前）を出し、帯の画面は同じ会議に帯 relay-down（B8）を入れた形。
// 帯の文は main の STT_BANNER の文（画面は文を作らない）。撮るときの時計は FIXED_NOW に止まるので「12 秒前」は揺れない
test('D17: 録音中のページの画面の答えに stt。live-banner-light は live-light と同じ会議に帯 relay-down（文は main の B8・ボタン無し）', { timeout: 5000 }, () => {
  const st = (n) => SH.SCREENS.find((s) => s.name === n).answers['koeApp.meetingStatus'];
  for (const n of ['live-light', 'live-dark']) assert.deepStrictEqual(st(n).stt, { route: 'cloud', lastTextAt: SH.FIXED_NOW - 12000, segSec: 15, problem: null }, n);
  const b = SH.SCREENS.find((s) => s.name === 'live-banner-light');
  assert.strictEqual(b.page, 'app');
  assert.strictEqual(b.theme, 'light');
  assert.ok(!b.zoom && !b.act && !b.focus);
  const bs = st('live-banner-light');
  assert.deepStrictEqual({ ...bs, stt: undefined }, { ...st('live-light'), stt: undefined }, '帯の画面の会議が live-light と違う');
  assert.strictEqual(bs.stt.route, 'local');
  assert.strictEqual(bs.stt.problem.code, 'relay-down');
  assert.strictEqual(bs.stt.problem.action, '');
  const B8 = 'NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。';
  assert.strictEqual(bs.stt.problem.text, B8);
  assert.ok(read('src/main.js').includes(`'relay-down': () => '${B8}'`), '帯の文が main の STT_BANNER の B8 と違う');
});

// 第1d回 Task A-13（あとの直し (b)）: 帯は注意の色（--danger）の枠と文字なので、暗い地と 200% の折り返しでも利用者に見てもらう。
// 2枚とも live-banner-light と同じ会議・同じ帯（B8）で、明暗と拡大だけが違う。
// 第1d回 G-4 で意図して変えた: 利用者が CI の新しい画像を見て OK と言ったので基準にした。取り直し待ちではなく、基準の PNG と比べる
// 0.9.0 B-1（BN1・D26）で意図して変えた: 帯の文を B8 の新しい文にしたので、帯の3枚を取り直し待ちにした（基準の PNG は 0.8.0 のまま残り、G-3 で取り直す）
// 0.9.0 G-3 で意図して変えた: 利用者が CI の新しい画像を見て OK と言ったので基準にした。取り直し待ちではなく、基準の PNG と比べる
test('あとの直し (b)・0.9.0 B-1・G-3: 撮る画面に live-banner-dark・live-banner-zoom200-dark があり、基準の PNG と比べる（取り直し待ちではない）。帯の画面は B8 の文', { timeout: 5000 }, () => {
  const B8 = 'NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。';
  const light = SH.SCREENS.find((s) => s.name === 'live-banner-light');
  for (const [n, zoom] of [['live-banner-dark', undefined], ['live-banner-zoom200-dark', 2]]) {
    const s = SH.SCREENS.find((x) => x.name === n);
    assert.ok(s, `${n} が撮る画面に無い`);
    assert.strictEqual(s.page, 'app', n);
    assert.strictEqual(s.theme, 'dark', n);
    assert.strictEqual(s.zoom, zoom, n);
    assert.ok(!s.act && !s.focus && !s.event, n);
    assert.deepStrictEqual(s.answers, light.answers, `${n} の会議と帯が live-banner-light と違う`);
    assert.strictEqual(s.answers['koeApp.meetingStatus'].stt.problem.text, B8, n);
    assert.ok(!SH.RETAKE.has(n), `${n} が取り直し待ちに残っている`);
    assert.ok(fs.existsSync(path.join(ROOT, 'test', 'shots', 'win32', `${n}.png`)), `${n} の基準が無い`);
  }
});

// 第1b回 Task C-2 で意図して変えた: 基準を取り直したので、検索の窓の画面は取り直し待ちではなく、基準の PNG と比べる（取り直し待ちが空であることは下の C-2 のテスト）
// 0.7.0 U-2 のレビューで名前を中身に合わせた（前の名前は「…取り直し待ちが残るなら録音バーのほかの全部（13）」。計画 ui07 の表の「取り直し待ちが残るなら 13」はこのテスト）
test('1b2 R-3・G12: 検索の窓の画面は窓を開く act を持ち、取り直し待ちに戻さない', { timeout: 5000 }, () => {
  const s = SH.SCREENS.find((x) => x.name === 'search-palette-light');
  assert.ok(s, '検索の窓の画面が撮る並びに無い');
  assert.match(s.act, /sideSearch/);
  // 0.7.0 U-2 で意図して変えた: 取り直し待ちは設定の3枚だけになった（下の U-2 のテスト。第1d回 A-4 でまた設定の3枚）。検索の窓は基準と比べる（取り直し待ちに戻さない）
  assert.ok(!SH.RETAKE.has('search-palette-light'), '検索の窓の画面が取り直し待ちに戻った');
});

// 0.9.0 O-3 で意図して変えた: 録音バーは作り直した（D25）ので、O-3〜O-4 の間は録音バーの画面を取り直し待ちに入れてよい（G-3 で空にする）。
// 外した overlay-processing は撮る画面に無いので、取り直し待ちにも入れられない（下の「撮る画面に無い」）
test('F14: 取り直し待ち（RETAKE）の画面は違っても NG にしないが、撮る画面に無い名前は入れられず、揺れ・CSP・はみ出しは NG のまま', { timeout: 5000 }, () => {
  assert.ok(!SH.RETAKE.has('overlay-processing'), '外した録音バーの画面を取り直し待ちに入れた');
  for (const n of SH.RETAKE) assert.ok(SH.SCREENS.some((s) => s.name === n), `${n} は撮る画面に無い`);
  const cmp = [{ name: 'notes-page-light', status: 'diff', count: 9 }, { name: 'overlay-processing', status: 'same' }];
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake: new Set(['notes-page-light']) }), 0);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: [{ name: 'overlay-processing', status: 'diff', count: 1 }], retake: new Set(['notes-page-light']) }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake: new Set(['notes-page-light']), overflow: [{ name: 'notes-page-light', ok: false }] }), 1);
  // 揺れ・CSP の違反・撮れなかった画面・速さの NG は、取り直し待ちの画面でも NG（足した: 計画の目的の「RETAKE でも NG」の残り）
  const retake = new Set(['notes-page-light']);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, flaky: ['notes-page-light'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, csp: ['app: Refused to execute inline script'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, errors: ['notes-page-light: 撮れなかった'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, perf: [{ name: 'open-2000-blocks', ms: 600, ok: false }] }), 1);
  // Tab の輪の NG は、取り直し待ちでない画面では NG（取り直し待ちの間は骨組みが変わる途中なので参考に出すだけ）
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, focus: [{ name: 'notes-page-light', ok: false }] }), 0);
  // 比べた結果は全部「同じ」にして、Tab の輪の NG だけで 1 になることを見る（違う画面が混ざると、輪を見なくても 1 になる）
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp.map((c) => ({ ...c, status: 'same' })), retake: new Set(), focus: [{ name: 'notes-page-light', ok: false }] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp.map((c) => ({ ...c, status: 'same' })), focus: [{ name: 'notes-page-light', ok: true }], overflow: [{ name: 'notes-page-light', ok: true }] }), 0);
});

test('F11: 横のはみ出しの判定（scrollWidth が clientWidth を越える・右端が窓の外の要素がある）', { timeout: 5000 }, () => {
  assert.deepStrictEqual(SH.judgeOverflow({ sw: 560, cw: 560, offenders: [] }).ok, true);
  assert.deepStrictEqual(SH.judgeOverflow({ sw: 600, cw: 560, offenders: [] }).ok, false);
  assert.deepStrictEqual(SH.judgeOverflow({ sw: 560, cw: 560, offenders: ['button#pMore'] }).ok, false);
  assert.match(SH.OVERFLOW_PROBE, /scrollWidth/);
  assert.strictEqual(SH.judgeOverflow(null).ok, false, '計れなかったのを OK にした');
});

test('F11: はみ出しを集める文（OVERFLOW_PROBE）を偽の画面で走らせる — 窓の外へ出た要素だけを集め、祖先で切られた・隠れた要素は数えない', { timeout: 5000 }, () => {
  const vm = require('node:vm');
  const el = (tag, id, cls, rect, style = {}, parent = null) => ({ tagName: tag.toUpperCase(), id, className: cls, rect, style, parentElement: parent, getBoundingClientRect: () => rect });
  const body = el('body', '', '', { left: 0, right: 560, width: 560, height: 700 }, { overflowX: 'visible' });
  const scroller = el('div', 'tabbar', 'tabs', { left: 0, right: 560, width: 560, height: 30 }, { overflowX: 'auto' }, body);
  const inScroll = el('button', '', 'tab', { left: 500, right: 700, width: 200, height: 30 }, {}, scroller);   // 横に流れる帯の中（切られる）
  const out = el('button', 'pMore', '', { left: 520, right: 620, width: 100, height: 30 }, {}, body);       // 窓の外へ出た
  const hidden = el('div', 'x', '', { left: 0, right: 900, width: 900, height: 10 }, { visibility: 'hidden' }, body);
  const empty = el('span', '', '', { left: 0, right: 0, width: 0, height: 0 }, {}, body);
  const doc = { documentElement: { scrollWidth: 600, clientWidth: 560 }, body, querySelectorAll: () => [scroller, inScroll, out, hidden, empty] };
  const win = { innerWidth: 560, getComputedStyle: (e) => ({ overflowX: 'visible', visibility: 'visible', display: 'block', position: 'static', ...e.style }) };
  const r = vm.runInNewContext(SH.OVERFLOW_PROBE, { document: doc, window: win, getComputedStyle: win.getComputedStyle });
  assert.deepStrictEqual([r.sw, r.cw, Array.from(r.offenders)], [600, 560, ['button#pMore']]);
  assert.strictEqual(SH.judgeOverflow(r).ok, false);
});

test('F12: Tab の輪の判定（決めた id にフォーカスがあり、outline が none でない）', { timeout: 5000 }, () => {
  const s = SH.SCREENS.find((x) => x.focus);
  // 第1b回 載せ直し: B-2 でサイドバーの頭に［«］が入り、［● 記録開始］は Tab 3 回目（«→ 検索 → 記録開始）。下の「Tab を何回」のテストが今の順と照らす
  assert.deepStrictEqual([s.name, s.focus.tabs, s.focus.want], ['notes-page-light', 3, 'mtToggleBtn']);
  assert.deepStrictEqual(SH.SCREENS.filter((x) => x.focus).map((x) => x.name), ['notes-page-light']);
  assert.strictEqual(SH.judgeFocus({ id: 'mtToggleBtn', outline: 'solid' }, s.focus).ok, true);
  assert.strictEqual(SH.judgeFocus({ id: 'mtToggleBtn', outline: 'none' }, s.focus).ok, false);
  assert.strictEqual(SH.judgeFocus({ id: '', outline: 'none' }, s.focus).ok, false);
  assert.strictEqual(SH.judgeFocus({ id: 'tabBtnDictation', outline: 'solid' }, s.focus).ok, false);
  assert.strictEqual(SH.judgeFocus({ id: 'searchBox', outline: 'solid' }, s.focus).ok, false);
  assert.strictEqual(SH.judgeFocus(null, s.focus).ok, false);
});

test('F11: 拡大の画面は、撮る前に窓の中の幅が「窓の幅 ÷ 倍率」になっている（画面の外で描く窓で拡大が効いたか）', { timeout: 5000 }, () => {
  assert.strictEqual(SH.judgeZoom(560, 2).ok, true);
  assert.strictEqual(SH.judgeZoom(1120, 2).ok, false);
  assert.strictEqual(SH.judgeZoom(1120, 1).ok, true);
  assert.strictEqual(SH.judgeZoom(undefined, 2).ok, false);
});

test('G2: 画面ごとの答えの名前も、本物の preload.js にあるものだけ', { timeout: 5000 }, () => {
  const names = SH.apiNamesOf(read('src/preload.js'));
  for (const s of SH.SCREENS) for (const key of Object.keys(s.answers || {})) {
    const [bridge, fn] = key.split('.');
    assert.ok(names[bridge] && names[bridge].includes(fn), `${s.name}: ${key}`);
  }
});

// 0.9.0 O-3 で意図して変えた: 第1a回の録音バーの基準（overlay-processing.png）は、録音バーを作り直した（D25）ので外した。新しい録音バーの基準は
// 利用者が CI の画像を見て OK と言った後に G-3 で置く（それまでは録音バーの画面は全部取り直し待ち）
// 0.9.0 G-3 で意図して変えた: 利用者が CI の録音バーの 81 枚（run 39496101442・artifact 12297628165 の .after.png）を見て OK と言ったので、バイトのまま
// 基準にした。どの録音バーの画面にも基準があり、取り直し待ちではない。基準の大きさは「main と同じ panelBounds の窓 × 拡大率」で（撮る道具の
// shotSizeFor・panelWindowFor）、ピルの太さは形の初めの太さ（PANEL_FIRST）+ 余白、明るい地と暗い地で同じ大きさ
test('G2・F14・RP9・G-3: 第1a回の録音バーの画面と基準は無い。録音バーの画面にはどれも基準があり、大きさは panelBounds の窓 × 拡大率で、地で変わらない', { timeout: 5000 }, () => {
  assert.ok(!SH.SCREENS.some((s) => s.name === 'overlay-processing'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'test', 'shots', 'win32', 'overlay-processing.png')), '外した画面の基準が残っている');
  const byDesk = new Map();
  for (const s of SH.SCREENS.filter((x) => x.page === 'overlay')) {
    assert.ok(!SH.RETAKE.has(s.name), `${s.name} が取り直し待ちに残っている`);
    const f = path.join(ROOT, 'test', 'shots', 'win32', `${s.name}.png`);
    assert.ok(fs.existsSync(f), `${s.name} の基準が無い`);
    const im = P.decodePng(fs.readFileSync(f));
    const k = s.scale || 1;
    const win = { width: Math.round(im.width / k), height: Math.round(im.height / k) };
    assert.deepStrictEqual(SH.shotSizeFor(win, k), { width: im.width, height: im.height }, `${s.name}: 窓 × 拡大率 ${k} の大きさでない`);
    assert.deepStrictEqual(SH.panelWindowFor({ w: win.width - 2 * lib.PANEL_PAD, h: win.height - 2 * lib.PANEL_PAD }, s.slot), win, `${s.name}: panelBounds の窓の大きさでない`);
    const thick = s.pill.form === 'v' ? [win.width, lib.PANEL_FIRST.v.w] : [win.height, lib.PANEL_FIRST.h.h];
    assert.strictEqual(thick[0], thick[1] + 2 * lib.PANEL_PAD, `${s.name}: ピルの太さが形の太さでない`);
    const key = `${s.pill.form}|${s.pill.state}|${k}|${s.pill.hover ? 'hover' : ''}`;
    if (byDesk.has(key)) assert.deepStrictEqual([im.width, im.height], byDesk.get(key), `${s.name}: 明るい地と暗い地で大きさが違う`);
    else byDesk.set(key, [im.width, im.height]);
  }
});

// 0.7.0 U-2 で意図して変えた: 今の版は 0.6.0。取り直し待ち（設定の3枚）が残る間は 0.7.0 に上げさせない（利用者が新しい画像を見る前に出さない）。
// 第1d回 A-4 で意図して変えた: 今の版は 0.7.0。取り直し待ち（設定の3枚。A-7 で録音中のページの3枚も）が残る間は 0.8.0 に上げさせない
// （G-2 で版を上げる前に、利用者が CI の新しい画像を見て OK と言い、基準にして空に戻す）
// 第1d回 G-4 で意図して変えた: 利用者が8枚を OK と言ったので取り直し待ちを空にし、版を 0.8.0 にした。次の版も、取り直し待ちが残る間は 0.8.0 のまま
// 0.9.0 G-3 で意図して変えた: 利用者が取り直しの画像を OK と言ったので取り直し待ちを空にし、版を 0.9.0 にした。次の版も、取り直し待ちが残る間は 0.9.0 のまま
test('F14: 取り直し待ちが残っている間は、版を上げられない（取り直し待ちのまま次の版を出さない）', { timeout: 5000 }, () => {
  if (SH.RETAKE.size) assert.strictEqual(JSON.parse(read('package.json')).version, '0.9.0', `取り直し待ち ${[...SH.RETAKE].join(',')} を残したまま版を上げた`);
});

test('tools/shots/main.js は画面ごとの答え・拡大・はみ出し・Tab を使う', { timeout: 5000 }, () => {
  const m = read('tools/shots/main.js');
  for (const s of ['s.answers', 'setZoomFactor(', 'SH.OVERFLOW_PROBE', 'sendInputEvent(', 'SH.RETAKE']) assert.ok(m.includes(s), s);
  // つなぎ方そのもの: はみ出し・Tab の輪を終わりの答えに渡す、はみ出しは app の画面で見る、拡大の NG は errors に入れる、拡大と答えを本当に使う
  // 0.9.0 O-3（F11）で意図して変えた: 終わりの答えに録音バーの余白（panel）も渡す
  for (const s of [
    'retake: SH.RETAKE, overflow, focus, panel })',
    'if (!z.ok) errors.push(',
    'wc.setZoomFactor(zoom)',
    '...JSON.parse(JSON.stringify(s.answers || {}))',
  ]) assert.ok(m.includes(s), s);
  assert.match(m, /if \(s\.page === 'app'\) \{\s*const j = SH\.judgeOverflow\(await within\(o\.wc\.executeJavaScript\(SH\.OVERFLOW_PROBE\)/, 'はみ出しを app の画面で見ていない');
});

test('G2: 偽の橋の名前は、本物の preload.js から取ったものと同じ（simrun と同じ結果）。見本の答えは、その名前のものだけ', { timeout: 5000 }, () => {
  const src = read('src/preload.js');
  assert.deepStrictEqual(SH.apiNamesOf(src), preloadApis(src));
  const names = SH.apiNamesOf(src);
  for (const key of Object.keys(SH.fixtures())) {
    const [bridge, fn] = key.split('.');
    assert.ok(names[bridge] && names[bridge].includes(fn), key);
  }
  const fx = JSON.stringify(SH.fixtures());
  assert.ok(!/\d{4}-\d\d-\d\d/.test(fx) || /2026-10-01/.test(fx), '見本の日付は決まった過去の日にする');
});

test('G2・F9: 比べる — 基準が無い・大きさが違う・1画素違う・同じ、を分け、違えば前・後・差分の PNG を書く', { timeout: 5000 }, (t) => {
  const base = tmp(t, 'base');
  const out = tmp(t, 'out');
  const same = img(4, 3);
  const one = img(4, 3);
  one.data[0] = 0;   // 左上の1画素の赤だけ違う
  fs.writeFileSync(path.join(base, 'b.png'), P.encodePng(same));
  fs.writeFileSync(path.join(base, 'c.png'), P.encodePng(same));
  fs.writeFileSync(path.join(base, 'd.png'), P.encodePng(img(5, 3)));
  const r = SH.compareAll({ baseDir: base, outDir: out, shots: { a: same, b: one, c: same, d: same }, png: P, fs });
  assert.deepStrictEqual(r.map((x) => [x.name, x.status]), [['a', 'missing'], ['b', 'diff'], ['c', 'same'], ['d', 'size']]);
  assert.strictEqual(r[1].count, 1);
  for (const f of ['a.after.png', 'b.before.png', 'b.after.png', 'b.diff.png', 'd.before.png', 'd.after.png', 'd.diff.png']) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.ok(!fs.existsSync(path.join(out, 'c.after.png')), '同じ画面の画像まで書いた');
  assert.strictEqual(SH.exitCodeOf({ compare: r }), 1);
  assert.strictEqual(SH.exitCodeOf({ compare: r.filter((x) => x.status === 'same') }), 0);
});

test('F9: 同じ画面を2回撮って違えば「揺れる」で NG。揺れ・CSP の違反・速さの NG があれば終了コードは 1', { timeout: 5000 }, () => {
  const a = img(2, 2);
  const b = img(2, 2);
  b.data[5] = 9;
  assert.deepStrictEqual(SH.judgePair(a, img(2, 2), P).ok, true);
  assert.deepStrictEqual(SH.judgePair(a, b, P).ok, false);
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'], flaky: ['x'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'], csp: ['Refused to execute inline script'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'], perf: [{ name: 'open-2000-blocks', ms: 600, ok: false }] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'] }), 0);
  assert.strictEqual(SH.exitCodeOf({ shots: [] }), 1, '1枚も撮れていないのに 0');
  // 撮れなかった画面（errors）があれば、残りが撮れていても・残りが基準と全部同じでも 1（「比べる物が無いのに緑」にしない）
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'], errors: ['y: 撮れなかった'] }), 1, '撮れなかった画面を見ていない');
  assert.strictEqual(SH.exitCodeOf({ compare: [{ name: 'a', status: 'same' }], errors: ['b: 比べる画像が無い'] }), 1, '比べられなかった画面を見ていない');
});

test('F6: CSP に断られた行を見分ける（自分のインラインの script が止まると画面が真っ白になる）', { timeout: 5000 }, () => {
  assert.strictEqual(SH.cspViolation(3, "Refused to execute inline script because it violates the following Content Security Policy directive: \"script-src 'sha256-x'\"."), true);
  assert.strictEqual(SH.cspViolation(2, 'Electron Security Warning (Insecure Content-Security-Policy)'), false);
  assert.strictEqual(SH.cspViolation(3, 'Uncaught TypeError: x'), false);
  // Electron 44.9.0（Chromium 152）が実際に出す形（作業環境の xvfb で、差し込んだ script を止めたときの行）。「Refused to」で始まらない
  assert.strictEqual(SH.cspViolation('error', "Executing inline script violates the following Content Security Policy directive 'script-src 'sha256-x''. Either the 'unsafe-inline' keyword, a hash ('sha256-y'), or a nonce ('nonce-...') is required to enable inline execution. The action has been blocked."), true);
});

test('F9: 撮る画面は時計・時間帯・アニメーションを止めて撮る（基準を取った次の日に「N日超過」が変わって赤にならない）', { timeout: 5000 }, () => {
  assert.strictEqual(new Date(SH.FIXED_NOW).toISOString(), '2026-10-18T00:00:00.000Z');
  assert.strictEqual(SH.TIME_ZONE, 'Asia/Tokyo');
  assert.match(SH.FREEZE_CSS, /transition:none!important/);
  assert.match(SH.FREEZE_CSS, /animation:none!important/);
  const pre = read('tools/shots/preload.js');
  assert.ok(pre.includes('contextBridge.executeInMainWorld(') && pre.includes('static now()'), '画面の時計を止めていない');
  const m = read('tools/shots/main.js');
  assert.ok(m.includes("'Emulation.setTimezoneOverride'") && m.includes('insertCSS('), '時間帯かアニメーションを止めていない');
  const fx = JSON.stringify(SH.fixtures());
  for (const d of fx.match(/\d{4}-\d\d-\d\d/g) || []) assert.ok(d < '2026-10-18', `見本の日付 ${d} が止めた時計より後`);
});

// preload.js の executeInMainWorld に渡す func の矢印関数を、func: から括弧を数えて取り出す（見本の文字列に括弧は無い）
function preloadFuncSource() {
  const pre = read('tools/shots/preload.js');
  const start = pre.indexOf('func:');
  assert.ok(start >= 0, 'preload.js に func: が無い');
  const from = pre.indexOf('(', start);
  const open = pre.indexOf('{', pre.indexOf('=>', from));
  let depth = 0;
  for (let i = open; i < pre.length; i++) {
    if (pre[i] === '{') depth++;
    else if (pre[i] === '}' && --depth === 0) return pre.slice(from, i + 1);
  }
  throw new Error('func: の括弧が閉じていない');
}

test('F9: preload の時計の止め方を本当に走らせる — 画面の Date が FIXED_NOW を返し、日付を渡した Date は変えない。機器の名前は見本', { timeout: 5000 }, async () => {
  const vm = require('node:vm');
  const md = { enumerateDevices: () => Promise.resolve([{ kind: 'audioinput', label: '本物のマイク' }]), getUserMedia: () => Promise.reject(new Error('本物')) };
  const w = { navigator: { mediaDevices: md } };
  vm.runInNewContext(`(${preloadFuncSource()})`, { window: w, navigator: w.navigator })(SH.FIXED_NOW);
  assert.strictEqual(typeof w.Date, 'function', '止めた Date を画面の世界に入れていない');
  assert.strictEqual(new w.Date().getTime(), SH.FIXED_NOW);
  assert.strictEqual(w.Date.now(), SH.FIXED_NOW);
  assert.strictEqual(new w.Date('2026-10-01T00:00:00.000Z').toISOString(), '2026-10-01T00:00:00.000Z');
  const list = await md.enumerateDevices();
  assert.deepStrictEqual(Array.from(list, (d) => d.label), [  // 画面の世界の配列なので、こちらの配列に写して比べる
    '既定 - マイク（見本）', 'マイク（見本）', '既定 - スピーカー（見本）']);
  assert.strictEqual((await md.getUserMedia({ audio: true })).getTracks().length, 0);
});

test('F9: 基準との比べは色の差 2 までを同じとみなす（CI の機械ごとの1段の差）。3 以上は違いとして数える。揺れの確かめは差を許さない', { timeout: 5000 }, (t) => {
  const base = tmp(t, 'tol');
  const out = tmp(t, 'tolout');
  fs.writeFileSync(path.join(base, 'a.png'), P.encodePng(img(2, 2)));
  fs.writeFileSync(path.join(base, 'b.png'), P.encodePng(img(2, 2)));
  const near = img(2, 2); near.data[0] = 253;
  const far = img(2, 2); far.data[0] = 252;
  const r = SH.compareAll({ baseDir: base, outDir: out, shots: { a: near, b: far }, png: P, fs });
  assert.deepStrictEqual(r.map((x) => [x.name, x.status]), [['a', 'same'], ['b', 'diff']]);
  assert.strictEqual(SH.TOLERANCE, 2);
  assert.strictEqual(SH.judgePair(img(2, 2), near, P).ok, false, '揺れの確かめが差を許した');
});

test('PERF: 2,000 ブロックのページと 1万行の文字起こしを開くのは 0.5 秒まで（3回の中央値）', { timeout: 5000 }, () => {
  assert.deepStrictEqual(SH.PERF, [{ name: 'open-2000-blocks', budgetMs: 500 }]);
  assert.strictEqual(SH.median([900, 410, 420]), 420);
  assert.deepStrictEqual(SH.judgePerf([{ name: 'open-2000-blocks', ms: 420 }]).map((x) => x.ok), [true]);
  assert.deepStrictEqual(SH.judgePerf([{ name: 'open-2000-blocks', ms: 501 }]).map((x) => x.ok), [false]);
  const big = SH.bigPage();
  assert.strictEqual(big.page.blocks.length, 2000);
  assert.strictEqual(big.segments.length, 10000);
});

test('ci.yml の electron-smoke: 小さなアプリの後に画面を撮り、撮った画像をいつも artifact に上げる', { timeout: 5000 }, () => {
  const st = stepsOf(jobsOf(read('.github/workflows/ci.yml'))['electron-smoke']);
  const iSmoke = st.findIndex((s) => /electron\.exe tools\/electron-smoke$/m.test(s));
  const iShots = st.findIndex((s) => /node_modules\/electron\/dist\/electron\.exe tools\/shots (--compare test\/shots\/win32 )?--out "\$RUNNER_TEMP\/shots"/.test(s));
  const iUp = st.findIndex((s) => /uses: actions\/upload-artifact@v4/.test(s));
  assert.ok(iSmoke >= 0 && iShots > iSmoke && iUp > iShots, `${iSmoke},${iShots},${iUp}`);
  assert.match(st[iUp], /^\s*if: always\(\)$/m);
  assert.match(st[iUp], /path: \$\{\{ runner\.temp \}\}\/shots/);
});

test('tools/shots/main.js は electron を boot() の中だけで読む（npm test が require しても本体を落としにいかない。第0c回 C6）', { timeout: 5000 }, () => {
  const m = read('tools/shots/main.js');
  assert.ok(m.includes("if (process.versions.electron && process.type === 'browser') boot();"));
  assert.ok(!/^const .*require\('electron'\)/m.test(m));
  assert.ok(m.includes("require('../../src/security')") && m.includes('security.install('));
  assert.ok(m.includes("require('../png')") && !m.includes('toBitmap('), 'PNG は自作の部品で読む（toBitmap の並びは版ごとに変わる）');
});

test('G2: 作業域より大きい窓が作るときに縮められても（Windows の CI の画面は 1024x768）、撮る前に決めた大きさへ戻す', { timeout: 5000 }, () => {
  const fake = (w, h) => {
    const calls = [];
    return { calls, getContentSize: () => [w, h], setContentSize: (...a) => { calls.push(a); } };
  };
  const shrunk = fake(1024, 720);
  assert.strictEqual(SH.ensureContentSize(shrunk, SH.SIZE), true);
  assert.deepStrictEqual(shrunk.calls, [[SH.SIZE.width, SH.SIZE.height]]);
  const right = fake(SH.OVERLAY_SIZE.width, SH.OVERLAY_SIZE.height);
  assert.strictEqual(SH.ensureContentSize(right, SH.OVERLAY_SIZE), false);
  assert.deepStrictEqual(right.calls, []);
  // main は窓を作った直後（ページを開く前）に呼ぶ
  const m = read('tools/shots/main.js');
  const made = m.indexOf('new BrowserWindow(');
  const fix = m.indexOf('SH.ensureContentSize(win, size)');
  assert.ok(made >= 0 && fix > made && fix < m.indexOf("wc.loadURL('about:blank')"), '窓を作った直後に大きさを決め直していない');
});

// 第1b回 Task C-2（G2・F14）: C-1 で緩めた確かめを元の「全部ある」に戻した（第1b2回の検索の窓 search-palette-light も、もう取り直し待ちの新しい画面ではない）。
// 13 枚は Windows の CI（run 39150265077・c823b81）が撮った画像。利用者が 2026-10-19 に見て OK と言った
// 0.7.0 U-2（設計書 D8）で意図して変えた: 設定のいちばん上に「外観」を足し、「オンライン」のカードを D5 の形にしたので、設定の3枚を取り直し待ちにした。
// 利用者が 2026-10-19 に CI の新しい3枚（run 39243734668・artifact 12183195820）を見て OK と言ったので、その画像を基準にして取り直し待ちを空に戻した（第1b回 C-2 と同じ手順）
// 第1d回 A-4（RL10・F11）で意図して変えた: 設定の2つ目に「アカウント」のカードを足し、「オンライン」のカードの説明を替えて［詳細設定（管理者用）］を
// 消したので、設定の3枚を取り直し待ちにした（計画の「意図して変えるもの」の RETAKE の行）。CI は「取り直し待ち」と出して NG にしない。
// 利用者が CI の新しい3枚を見て OK と言ったら、その画像を基準にして取り直し待ちを空に戻す（0.8.0 を出す前。上の版のテスト）
// 第1d回 A-7（RL14・D17）で意図して変えた: 録音中のページに文字起こしの状態の行と帯を足したので、録音中のページの2枚（live-light・live-dark）と、
// 足した帯の画面（live-banner-light）を取り直し待ちにした（6枚）。live-banner-light はまだ基準の PNG が無い（CI は比べで「missing」を
// 取り直し待ちとして NG にしない）。基準が無くてよいのはこの1枚だけで、取り直し待ちにあるときだけ（第1b回 C-1 と同じ形。基準にしたら下の NEW を空にする）
// 第1d回 A-13（あとの直し (b)）で意図して変えた: 帯の暗い画面（live-banner-dark）と 200% の暗い画面（live-banner-zoom200-dark）を足して取り直し待ちにした（8枚）。
// 設定の3枚はカード「エンジン」を「オフライン」にした（D19）ので取り直し待ちのまま、録音中のページの3枚は［この会議は PC の中だけ］を1行目にした（D20）ので
// 取り直し待ちのまま。基準が無くてよいのは取り直し待ちにある帯の3枚（live-banner-*）だけ
// 第1d回 G-4 で意図して変えた: 利用者が 2026-10-20 に CI の新しい8枚（run 39398639423・artifact 12252523286 の .after.png）を見て OK と言ったので、
// その画像をバイトのまま基準にして取り直し待ちを空に戻した（0.7.0 U-2・第1b回 C-2 と同じ手順）。帯の3枚の「基準が無くてよい」の例外も外した
// 0.9.0 で意図して変えた: 取り直し待ちは計画（docs/plans/2026-10-20-090.md）の「取り直す画面」の表の画面だけ。B-1 は帯の3枚（U・O は各タスクが足す）。
// 利用者がまとめて OK と言ったら G-3 で基準にして空に戻す（空になるまで版を上げられない: 下の版のテスト）
// 0.9.0 で意図して変えた: 取り直し待ちは計画（docs/plans/2026-10-20-090.md）の「取り直す画面」の表の画面だけ。U-1 は設定の3枚と
// notes-tabs-light（設定がポップアップになり、3つのタブの並びから設定のタブが消える）。B・O は各タスクが足す。
// 利用者がまとめて OK と言ったら G-3 で基準にして空に戻す（空になるまで版を上げられない: 上の版のテスト）
// 0.9.0 G-3 で意図して変えた: 利用者が 2026-10-20 に CI の取り直しの画像（run 39496101442（ed9365a）・artifact 12297628165 の .after.png。計画の
// 「取り直す画面」の全部: 本体の 10 枚と録音バーの 81 枚）を見て OK と言ったので、その画像をバイトのまま基準にして取り直し待ちを空に戻した
// （第1d回 G-4 と同じ手順）。計画の表の画面（前の RETAKE_090）と、0.9.0 で足した画面の「取り直し待ちの間は基準が無くてよい」の例外（前の NEW_090）は外した

// 0.9.0 U-3（OF7・D21）: 準備を選んでいない人のカード「オフライン」の画面。偽の答えは engine:status の chosen が偽・取り込みの欄は
// まだ取り込んでいず押したことも無い（consent 偽・missing）・空き 20GB。ログインしている形（していないと起動で「アカウント」が開く）
// 0.9.0 G-3 で意図して変えた: 利用者が CI の画像を見て OK と言ったので基準にした。取り直し待ちではなく、基準の PNG と比べる
test('U-3・G-3: settings-offline-light は基準の PNG と比べる（取り直し待ちではない）。答えは chosen 偽・consent 偽の missing・空き 20GB・ログイン中で、項目「オフライン」を開く', { timeout: 5000 }, () => {
  assert.ok(!SH.RETAKE.has('settings-offline-light'), '準備を選んでいない人のカードの画面が取り直し待ちに残っている');
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'shots', 'win32', 'settings-offline-light.png')), '準備を選んでいない人のカードの画面の基準が無い');
  const s = SH.SCREENS.find((x) => x.name === 'settings-offline-light');
  assert.ok(s, '撮る画面に無い');
  assert.deepStrictEqual([s.page, s.theme, s.zoom], ['app', 'light', undefined]);
  const a = s.answers;
  assert.strictEqual(a['koeApp.engineStatus'].chosen, false);
  assert.match(a['koeApp.engineStatus'].whisper, /まだ取り込んでいません/);
  const f = a['koeApp.engineFetchStatus'];
  assert.deepStrictEqual([f.state, f.consent, f.freeBytes, f.whisperReady, f.sumReady, f.mode], ['missing', false, 20e9, false, false, { whisper: 'managed', sum: 'managed' }]);
  assert.ok(Array.isArray(f.items) && f.items.length > 0);
  assert.strictEqual(a['koeApp.accountStatus'].signedIn, true);
  assert.match(s.act, /setNavOffline/);
});
// 0.9.0 O-3（設計書 D25・RP9）で意図して変えた: 録音バーの画面（80 枚）を全部取り直し待ちにした（新しい画面で基準がまだ無い）。利用者が CI の画像を
// 見て OK と言ったら、G-3 でその画像を基準にして空に戻す（空になるまで版を上げられない: 上の F14）。本体の画面は取り直し待ちでなければ基準と比べる
// 0.9.0 O-4（RP1）で意図して変えた: 設定の「録音バーの置き場所」の欄の名前と選択肢を替えたので、設定の3枚も取り直し待ちにした
// 0.9.0 G-3 で意図して変えた: 取り直し待ちを空に戻した（上の注）。録音バーの画面の基準の大きさは、上の「G2・F14・RP9・G-3」が panelBounds の答えと比べる
// 0.9.1（計画 docs/plans/2026-10-21-091.md の「取り直す画面」）で意図して変えた: 取り直し待ちは計画の表の画面だけ（RETAKE_091）。Q-3 で設定の項目「録音」に
// カード「話し声が無いとき」を足したので settings-record-light を入れた。Q-5 が足す新しい画面（NEW_091）は、取り直し待ちの間は基準が無くてよい。
// 利用者がまとめて OK と言ったら、版を上げる commit で基準にして空に戻す（空になるまで版を上げられない: 上の F14）
const RETAKE_091 = ['settings-record-light'];
const NEW_091 = new Set([]);
test('G2・F14・G-4・0.9.0 G-3・0.9.1: 取り直し待ちは計画の表の画面だけ。取り直し待ちの新しい画面のほかは、どの画面にも基準の PNG があり、本体の画面の大きさは窓の大きさと同じ', { timeout: 5000 }, () => {
  for (const n of SH.RETAKE) assert.ok(RETAKE_091.includes(n), `${n} は 0.9.1 の計画の「取り直す画面」に無い`);
  assert.ok(!SH.RETAKE.has('overlay-processing'), '外した録音バーの画面を取り直し待ちに入れた');
  for (const s of SH.SCREENS) {
    const f = path.join(ROOT, 'test', 'shots', 'win32', `${s.name}.png`);
    if (NEW_091.has(s.name) && SH.RETAKE.has(s.name)) { assert.ok(!fs.existsSync(f), `${s.name} は新しい画面なのに基準がある`); continue; }
    assert.ok(fs.existsSync(f), `${s.name} の基準が無い`);
    if (s.page === 'overlay') continue;
    const im = P.decodePng(fs.readFileSync(f));
    assert.deepStrictEqual([im.width, im.height], [SH.SIZE.width, SH.SIZE.height], s.name);
  }
  // 基準のフォルダに、撮る画面に無い名前の画像を置かない（外した画面の基準が残らない）
  const names = new Set(SH.SCREENS.map((s) => `${s.name}.png`));
  assert.deepStrictEqual(fs.readdirSync(path.join(ROOT, 'test', 'shots', 'win32')).filter((n) => !names.has(n)), [], '撮る画面に無い基準がある');
});

// 0.9.0 O-3（設計書 D25・RP9・F11）: 録音バーの画面は pill-states の表の状態 × 形（横・縦）× 地（明るい・暗いデスクトップ）× 拡大率（100・150%）。
// 窓の大きさは、撮るときに測ったピルの大きさから main と同じ panelBounds で決め、拡大率の画面は × 拡大率の大きさで撮れたかを見る
// 0.9.0 O-4（RP8）で足した: 縦の形の × が出た1枚（overlay-vertical-dark-hover-150。モックの名前）を最後に
test('RP9: 録音バーの画面は pill-states の表の状態 × 形 × 地 × 拡大率で 80 枚と、縦の形の × の1枚。名前は overlay-<形>-<地>-<状態>-<100|150>、act は表の見本', { timeout: 5000 }, () => {
  const all = SH.SCREENS.filter((s) => s.page === 'overlay');
  assert.strictEqual(all.length, 81);
  const hv = all.pop();
  assert.deepStrictEqual([hv.name, hv.scale, hv.slot, hv.theme], ['overlay-vertical-dark-hover-150', 1.5, 'middle-right', 'dark']);
  assert.strictEqual(hv.act, PS.actFor('rec', 'v', 'dark', true));
  assert.ok(hv.act.includes('"hover":true') && !PS.actFor('rec', 'v', 'dark').includes('"hover":true'));
  const ov = all;
  assert.strictEqual(ov.length, 80);
  assert.deepStrictEqual(PS.FORMS, ['h', 'v']);
  assert.deepStrictEqual(Object.keys(PS.DESKS), ['light', 'dark']);
  assert.deepStrictEqual(PS.SCALES, [1, 1.5]);
  assert.strictEqual(PS.STATES.length, 10);
  for (const s of ov) {
    const { state, form, desk, scale } = s.pill;
    assert.strictEqual(s.name, `overlay-${form}-${desk}-${state}-${Math.round(scale * 100)}`);
    assert.strictEqual(s.act, PS.actFor(state, form, desk), s.name);
    assert.strictEqual(s.scale, scale);
    assert.strictEqual(s.slot, form === 'v' ? 'middle-right' : 'bottom-center');
  }
  // 撮るときだけ足す地（製品には無い）
  assert.ok(PS.actFor('rec', 'h', 'light').includes(PS.DESKS.light) && PS.actFor('rec', 'h', 'dark').includes(PS.DESKS.dark));
  assert.ok(!read('src/renderer/overlay.html').includes(PS.DESKS.light), '撮るときの地が製品の画面にある');
  // 窓の大きさ: 撮るときに測ったピルの大きさから main と同じ panelBounds（拡大率の画面は × 拡大率で撮れたか）
  assert.deepStrictEqual(SH.panelWindowFor({ w: 236.4, h: 40 }, 'bottom-center'), (({ width, height }) => ({ width, height }))(lib.panelBounds({ slot: 'bottom-center', size: { w: 236.4, h: 40 }, workArea: SH.SHOT_AREA })));
  assert.deepStrictEqual(SH.shotSizeFor({ width: 253, height: 56 }, 1.5), { width: 380, height: 84 });
  // 拡大率は画面の外で描く窓そのものに持たせる（O-3 で作るときに確かめた: 44.9.0 では DevTools の Emulation.setDeviceMetricsOverride も
  // プロセスの --force-device-scale-factor も、画面の外で描く窓の撮った画像を 1 倍のままにした。計画の O-3 を直した）
  const m = read('tools/shots/main.js');
  for (const k of ['SH.panelWindowFor(', 'SH.shotSizeFor(winSize, scale)', 'offscreen: scale === 1 ? true : { deviceScaleFactor: scale }', 'SH.PANEL_PROBE', 'SH.judgePanel(',
    'for (const scale of SH.PANEL_PROBE_SCALES)', 'for (const state of SH.PANEL_PROBE_STATES)']) assert.ok(m.includes(k), k);
  assert.ok(!m.includes('setDeviceMetricsOverride'), '撮った画像に効かない DevTools の拡大率に頼っている');
});

test('F11: PANEL_PROBE の判定は、ピルの四角が窓の内側に 4px 以上の余白で入らなければ NG（取り直し待ちでも NG）。横と縦の rec と warn を拡大率 1・1.25・1.5・2 で見る', { timeout: 5000 }, () => {
  const ok = { pill: { left: 8, top: 8, right: 244, bottom: 48 }, iw: 252, ih: 56 };
  assert.strictEqual(SH.judgePanel(ok).ok, true);
  assert.strictEqual(SH.judgePanel({ ...ok, pill: { ...ok.pill, right: 249 } }).ok, false, '右の余白 3px を OK にした');
  assert.strictEqual(SH.judgePanel({ ...ok, pill: { ...ok.pill, top: 3.5 } }).ok, false);
  assert.strictEqual(SH.judgePanel({ ...ok, ih: 51 }).ok, false);
  assert.strictEqual(SH.judgePanel({ ...ok, pill: { ...ok.pill, left: 4, right: 248 }, iw: 252 }).ok, true, 'ちょうど 4px を NG にした');
  assert.strictEqual(SH.judgePanel(null).ok, false, '計れなかったのを OK にした');
  assert.deepStrictEqual(SH.PANEL_PROBE_SCALES, [1, 1.25, 1.5, 2]);
  assert.deepStrictEqual(SH.PANEL_PROBE_STATES, ['rec', 'warn']);
  assert.match(SH.PANEL_PROBE, /getBoundingClientRect/);
  assert.match(SH.PANEL_PROBE, /innerWidth/);
  const retake = new Set(['overlay-h-light-rec-100']);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: [{ name: 'overlay-h-light-rec-100', status: 'missing' }], retake, panel: [{ name: 'overlay-h-light-rec-100', ok: false }] }), 1, '取り直し待ちの録音バーのはみ出しを NG にしなかった');
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: [{ name: 'overlay-h-light-rec-100', status: 'missing' }], retake, panel: [{ name: 'overlay-h-light-rec-100', ok: true }] }), 0);
  const m = read('tools/shots/main.js');
  assert.ok(m.includes('retake: SH.RETAKE, overflow, focus, panel })'), 'はみ出しの判定を終わりの答えに渡していない');
});

test('CI: 撮る道具の見張りの時間は 30 秒 + SCREENS の数 × 6 秒（決まった 90 秒でない）', { timeout: 5000 }, () => {
  assert.strictEqual(SH.watchdogMs(0), 30000);
  assert.strictEqual(SH.watchdogMs(100), 630000);
  assert.strictEqual(SH.watchdogMs(SH.SCREENS.length), 30000 + SH.SCREENS.length * 6000);
  const m = read('tools/shots/main.js');
  assert.ok(m.includes('SH.watchdogMs(SH.SCREENS.length)'), '見張りの時間を画面の数から決めていない');
  assert.ok(!/90000/.test(m), '決まった 90 秒の見張りが残っている');
});
// 0.9.0 O-3: 第1a回の録音バーの基準は外した。録音バーの中身は test/stage1b.look.test.js の overlay.html の sha256 が見続ける

// 0.7.0 の出す前の CI（run 39250045942）: 573d111 で設定のカード「オンライン」の説明を小さくしたらページが短くなり、
// 見える中身は同じなのに右の捲り棒のつまみの端（x 1108〜1116・y 322〜326 の 24 画素）だけが変わって settings-light・settings-dark が NG になった
// （第1c回 4ec68b6 と同じ形。「いちばん上ではないので撮った画面には当たらない」は、つまみの長さがページ全体の長さで決まるので誤り）。
// 画面は app.html の1ファイル（script と style は中に書く）なので、基準の画像を撮った app.html の sha256 をここに持ち、変えたら手元で赤にする。
// 赤になったら: Windows の CI の「主な画面を撮る」を見て、違えば基準を取り直す（見える中身が変わるなら RETAKE に入れて利用者に見てもらう）。それから下の値を今の app.html に合わせる
// 第1d回 A-9（RL16）: ［更新して再起動］と更新の知らせの行のボタンが restart の答えを見るように、<script> の中だけを直した（要素・文・CSS は
// 変えていないので、撮る画面の見た目もページの長さも変わらない。計画の A-9 は RETAKE に足さない）。値を今の app.html に合わせた。
// 本当に同じかは Windows の CI の「主な画面を撮る」の比べで見る（違えば基準を取り直し、見える中身が変わったなら RETAKE に入れる）
// 第1d回 A-4（RL10・F11）: 設定に「アカウント」のカードを足し、「オンライン」の説明を替えて［詳細設定（管理者用）］を消し、知らせに
// ［ログインし直す］を足した。見える中身が変わるのは設定の3枚なので RETAKE に入れた（上の「取り直し待ちは設定の3枚だけ」）。
// ほかの画面（議事録・音声入力・録音中のページ・検索の窓）は要素も文も変えていないので、基準のまま比べる。値を今の app.html に合わせた
// 第1d回 A-1〜A-4 の点検の直し: ［ログイン］が確かめるメールを「コードを送ったメール」にした（<script> の中の1行だけ。要素・文・CSS は
// 変えていないので見た目もページの長さも変わらない。RETAKE は設定の3枚のまま足さない）。値を今の app.html に合わせた
// 第1d回 A-7（RL14・D17）: 録音中のページの記録の行に状態の行（#liveStt）を、その上に帯（#liveSttBanner）を足した（CSS の .stt-banner も）。
// 見える中身が変わるのは録音中のページの2枚と足した帯の画面なので RETAKE に入れた（上の「取り直し待ちは設定の3枚と録音中のページの3枚」）。
// 議事録・音声入力・設定・検索の窓は要素も文も変えていないので、基準のまま比べる。値を今の app.html に合わせた
// 第1d回 A-8（RL15・D17）: 録音中のページが見えているかを main へ知らせる（meetingLiveShown）のと、Windows の知らせを押したら録音中のタブへ
// 移る（onShowLive）を、<script> の中だけに足した（要素・文・CSS は変えていないので、撮る画面の見た目もページの長さも変わらない。
// A-9 と同じく RETAKE に足さない）。値を今の app.html に合わせた
// 第1d回 A-7・A-8 の点検の直し: 帯の文が同じなら書き直さない（<script> の中の1行だけ。要素・文・CSS は変えていないので見た目も
// ページの長さも変わらない。RETAKE は今のまま足さない）。値を今の app.html に合わせた
// 第1d回 A-13（RL17・RL18・D19・D20・あとの直し (a)(b)）: 設定のカード「エンジン」を「オフライン」にして説明の行を足し、文字起こしの言葉を
// 「PC の中の文字起こし」に（設定の3枚）、［この会議は PC の中だけ］を記録の行の1行目へ（録音中のページの3枚）、入力の欄の決まりに
// input[type="email"] を足した（設定のメールの欄。設定の3枚）。見える中身が変わるのは設定の3枚と録音中のページの3枚で、どれも RETAKE にある。
// 帯の暗い画面と 200% の暗い画面を足して RETAKE に入れた（8枚）。議事録・音声入力・検索の窓は要素も文も変えていないので、基準のまま比べる。値を今の app.html に合わせた
// 第1d回 A-12（RL10）: 設定のカード「アカウント」のメールアドレスと確認コードの欄・［確認コードを送る］［コードを送り直す］を消し、
// ［ログイン］と英語の Cloudflare の画面の説明（AR1）・コードのメールの注意（AR2）にした。見える中身が変わるのは設定の3枚で、どれも RETAKE にある
// （tools/shots/screens.js の accountStatus の答えはログインしていない形）。録音中のページ・議事録・音声入力・検索の窓は要素も文も変えていない
// （［ログインし直す］のフォーカスの行き先は <script> の中だけ）ので、基準のまま比べる。値を今の app.html に合わせた
// 第1d回 G-4: 取り直し待ちの8枚を、この値の app.html で CI（run 39398639423・4f47ad0）が撮った画像にした（app.html は変えていないので値はそのまま）
// 0.9.0 U-1（SP1〜SP3・D24）: 設定をタブでなく、ページの上に開くポップアップにした（左の項目の列・×・設定の section を中へ動かし、題名を
// 選んだ項目の名前に）。見える中身が変わるのは設定の3枚と、3つのタブの並びから設定のタブが消える notes-tabs-light で、どれも RETAKE に入れた
// （上の「取り直し待ちは計画の画面だけ」）。議事録・音声入力・録音中のページ・検索の窓は要素も文も CSS も変えていない（設定の section は
// main から動いたが、閉じている間は hidden）ので、基準のまま比べる。値を今の app.html に合わせた
// 0.9.0 U-2（SP4・SP5・D24）: 設定のカードを項目ごとに分け（「動作」「オンライン」を無くしてホットキー・起動と終了・録音バー・マイクと
// 相手の声・文字起こし・要約（Claude Code）へ。id と文はそのまま）、上に検索の欄を足した。見える中身が変わるのは設定の画面だけで、どれも RETAKE
// にある（項目「録音」と検索の画面を足した）。入力の欄の決まりに input[type="search"] を足したが、議事録・音声入力・録音中のページ・検索の窓に
// search の欄は無いので、基準のまま比べる。値を今の app.html に合わせた
// 0.9.0 U-3（OF7・F4・D21）: カード「オフライン」の説明を OFF1 に、準備を選んでいない人の状態の文・取り込みの欄の文とボタン・起動の連れて行き・
// 帯と知らせの［ログイン］［オフラインの準備］・PC の中だけの文を足した。見える中身が変わるのは設定の画面（RETAKE にある。準備を選んでいない人の
// カードの画面 settings-offline-light を足した）。録音中のページの画面の答えは action も needsSetup も持たないので、議事録・音声入力・録音中の
// ページ・検索の窓は基準のまま比べる。値を今の app.html に合わせた
// 0.9.0 U-4（SP6・SP7・F15）: 設定の左の列の下に［ヘルプセンター］（HELP_SITE_LIVE が偽なので hidden）と版の文字を足した。見える中身が
// 変わるのは設定の画面だけで、どれも RETAKE にある。ほかの画面は基準のまま比べる。値を今の app.html に合わせた
// 0.9.0 U-2 の点検の直し（SP5）: 設定の検索が、今は隠れている行（ログインしていない間の「ログアウト」など）に当たらないようにした
//（filterSettings の <script> の中だけ）。変わり得るのは設定の検索の画面（settings-search-light。RETAKE にある）だけで、ほかの画面は
// 要素も文も CSS も変えていないので基準のまま比べる。値を今の app.html に合わせた
// 0.9.0 O-4（RP1・RP8）: 設定の「録音バーの置き場所」の欄の名前と8つの選択肢を替え（設定の3枚。RETAKE に入れた）、録音中のページの記録の行に
// ［録音バーを出す］を足した（録音バーを隠しているときだけ出す hidden のボタン。撮る画面の録音中のページは隠していないので見た目は変わらない）。値を今の app.html に合わせた
// 統合（U・O）: U の設定のポップアップの中へ動かした「録音バーの置き場所」の欄（data-row も「録音バーの置き場所」に）に O-4 の名前と8つの選択肢を当てた。
// 見える中身が変わるのは設定の画面（RETAKE にある）だけ。値を今の app.html に合わせた
// 0.9.0 O-2・O-4 の点検の直し: ドラッグで吸い付いた置き場所を main から受けて #pillPos に入れる（onSettingsPatched）のと、保存の applied の
// pillSlot を #pillPos に戻す（FIELD_IDS）を、<script> の中だけに足した（要素・文・CSS は変えていないので見た目もページの長さも変わらない。
// RETAKE は今のまま足さない）。値を今の app.html に合わせた
// 0.9.0 見た目の直し（利用者に見せる前の見直し）: 設定のポップアップの捲り棒を × の下から角の丸みの内側までにし（scrollbar-gutter: stable）、検索の間は
// ［データ保存先を開く］を外し、モック 案C に合わせた（検索の虫めがね・名前が左で入力が右の行・キーの形の箱のホットキー・項目の見出し 20px・
// 項目の見出しと同じ言葉のカードの見出しを出さない）。CSS はどれも設定のポップアップの中（#tabSettings・.setpane・.setsearch・.hkbox・.frow）だけで、
// 見える中身が変わるのは設定の画面（6枚とも RETAKE にある）。議事録・音声入力・録音中のページ・検索の窓は要素も文も CSS も変えていないので
// 基準のまま比べる。値を今の app.html に合わせた
// 同じ直しの続き: 設定の入力とボタンの行（スピーカーの欄とボタン 2 つ）が右の列で折り返したので、行の幅の上限を 460px に（設定の画面だけ。RETAKE にある）。値を今の app.html に合わせた
test('基準の画像（test/shots/win32）は今の app.html で撮ったもの（app.html を変えたら撮り直しを確かめる）', { timeout: 5000 }, () => {
  const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.html'))).digest('hex');
  // 0.9.1 Q-3（D29）: 設定の項目「録音」にカード「話し声が無いとき」（チェックと選ぶ欄）を足した。見える中身が変わるのは settings-record-light で、
  // RETAKE に入れた（設定のほかの画面は項目「一般」を開くので変わらない）。値を今の app.html に合わせた
  // 0.9.1 Q-4（D29）: 録音中のページの頭に「会議は終わりましたか？」の帯（#liveQuietAsk。quiet が無ければ hidden）と、その CSS（.quiet-ask だけ）を足した。
  // 撮る今の録音中のページは quiet が無いので見た目は変わらない。帯の出た画面は Q-5 で足して RETAKE に入れる。値を今の app.html に合わせた
  assert.strictEqual(sha, '25011637a86da94020d8d7e207cae06ebe48f138df3a3fcec2c42f8f5f5ef58f',
    'app.html が基準の画像を撮った時と違う。Windows の CI の画面の比べ（捲り棒のつまみも）を見て、基準を取り直してからこの値を直す');
});

test('ci.yml の electron-smoke: 撮った画面を基準（test/shots/win32）と比べる', { timeout: 5000 }, () => {
  const st = stepsOf(jobsOf(read('.github/workflows/ci.yml'))['electron-smoke']);
  assert.ok(st.some((s) => s.includes('electron.exe tools/shots --compare test/shots/win32 --out "$RUNNER_TEMP/shots"')));
});

test('F9: 最初の画面を1度開いて撮って捨ててから（慣らし）本番を撮る（Windows の CI で、最初に開いた窓だけ縁の画素が実行ごとに2通りに描かれた）', { timeout: 5000 }, () => {
  const m = read('tools/shots/main.js');
  const warm = m.indexOf('const warm = await open(SH.SCREENS[0].page, SH.SCREENS[0].theme, SH.fixtures());');
  const loop = m.indexOf('for (const s of SH.SCREENS) {');
  assert.ok(warm >= 0 && loop > warm, '本番の前に慣らしの窓を開いていない');
  assert.ok(m.slice(warm, loop).includes('await capture(warm.wc)'), '慣らしの窓を撮っていない（描き終わる前に壊すと慣らしにならない）');
  assert.ok(m.slice(warm, loop).includes('warm.win.destroy()'), '慣らしの窓を壊していない');
});

test('F9: 揺れの確かめの2枚目は、描き直させて（invalidate）から撮る（同じ描き終わりの写しを2回比べても揺れは見つからない）', { timeout: 5000 }, () => {
  const m = read('tools/shots/main.js');
  const a = m.indexOf('const a = await capture(o.wc);');
  const b = m.indexOf('const b = await capture(o.wc);');
  assert.ok(a >= 0 && b > a);
  assert.ok(/o\.wc\.invalidate\(\);/.test(m.slice(a, b)), '2枚目の前に描き直させていない');
  // 0.9.0 O-3 で足した: 1枚目も描き直させてから撮る（初めの描き終わりだけが1画素違うことがあった）
  assert.ok(/o\.wc\.invalidate\(\);\s*await settle\(o\.wc, o\.t\);\s*await wait\(300\);\s*const a = await capture\(o\.wc\);/.test(m), '1枚目の前に描き直させていない');
  assert.ok(m.slice(a, b).includes('await settle(o.wc, o.t);'), '描き直しが済むのを待っていない');
});

// 第1b回 載せ直し: Tab の輪の画面の「Tab を何回」は、今の画面の Tab の順（偽 DOM の木の順。正の tabindex は使わない）と合っていること。
// サイドバーの頭に［«］が入って順が1つずれたのに、C-1 の決め（Tab 2 回）が古いままで、CI が #searchBox を撮った（取り直し待ちの間は NG にならない）
test('画面の使いやすさ・F12: Tab の輪の画面の「Tab を何回」は、今の画面の Tab の順でちょうど want に届く', { timeout: 10000 }, async () => {
  const { load } = require('./helpers/simrun');
  const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  const returns = {};
  for (const [k, v] of Object.entries(SH.fixtures())) if (k.startsWith('koeApp.')) returns[k.slice(7)] = () => JSON.parse(JSON.stringify(v));
  const l = await load(APP, { preloadSrc, returns });
  await l.drain();
  const order = l.root._walk([]).filter((e) => {
    for (let n = e; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) {
      const cls = (n.className || '').split(' ');
      if (n.hidden || (cls.includes('tab') && !cls.includes('active')) || n.id === 'pMenu' || (n.style && n.style.display === 'none')) return false;
    }
    if (e.disabled) return false;
    const attr = e.getAttribute('tabindex');
    const ti = e.tabIndex !== undefined ? e.tabIndex : (attr == null ? null : Number(attr));
    if (ti === -1) return false;
    return ['button', 'input', 'select', 'textarea'].includes(e.tagName) || ti === 0 || e.getAttribute('contenteditable') === 'true';
  }).map((e) => e.id || e.className);
  const shots = SH.SCREENS.filter((s) => s.focus);
  assert.ok(shots.length >= 1);
  for (const s of shots) assert.strictEqual(order[s.focus.tabs - 1], s.focus.want, `${s.name}: Tab ${s.focus.tabs} 回で届くのは ${order[s.focus.tabs - 1]}（順: ${order.slice(0, 5).join(' → ')}）`);
});
