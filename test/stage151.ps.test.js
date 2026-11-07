/*
 * stage151.ps.test.js — 0.15.1 サイドバーの「プライベート」のセクション・行の［···］と名前を変える・ライブラリ（計画 docs/plans/2026-11-04-151.md の
 * Task PS-1〜PS-5。D124・D125）
 * PS-1（F158・F161・F162・F164）: 純粋な部品（src/sideSection.js）と窓の覚え書きの sections・ライブラリのタブ（TAB_FIXED）・ui:get の sections。
 * 題名は作った物。実在の人名・社名は使わない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SS = require('../src/sideSection');
const W = require('../src/winstate');
const PT = require('../src/pageTree');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});

const T = { timeout: 15000 };
const P = (o = {}) => ({ open: true, sort: 'manual', show: 0, ...o });

// ---------------------------------------------------------------- normSections（決めたこと 24・F158）
test('PS-1・F158: normSections の表（項目ごとに照らす・壊れた項目だけ既定・後の版のセクションは残す・名前と中身の形の悪いもの・11 個目は落とす）', T, () => {
  assert.deepStrictEqual(SS.SECTION_DEFAULT, { open: true, sort: 'manual', show: 0 });
  assert.deepStrictEqual([SS.SORTS, SS.SHOW_STEPS], [['manual', 'edited'], [0, 5, 10, 15, 20]]);
  const N = (raw) => SS.normSections(raw);
  for (const p of [P(), P({ open: false, sort: 'edited', show: 10 }), P({ show: 5 }), P({ show: 20 })]) {
    assert.deepStrictEqual(N({ private: p }), { sections: { private: p }, repaired: false }, JSON.stringify(p));
  }
  // 壊れた項目だけ既定に戻し、ほかの2つは残す
  assert.deepStrictEqual(N({ private: { open: false, sort: 'x', show: 10 } }), { sections: { private: P({ open: false, show: 10 }) }, repaired: true });
  assert.deepStrictEqual(N({ private: { open: false, sort: 'edited', show: 7 } }), { sections: { private: P({ open: false, sort: 'edited' }) }, repaired: true });
  assert.deepStrictEqual(N({ private: { open: 'no', sort: 'edited', show: 5 } }), { sections: { private: P({ sort: 'edited', show: 5 }) }, repaired: true });
  assert.deepStrictEqual(N({ private: { open: false, sort: 'edited', show: '5' } }).sections.private, P({ open: false, sort: 'edited' }));
  // 組でない・null は既定
  for (const raw of [{ private: 'x' }, null, 'x', [], 3]) assert.deepStrictEqual(N(raw), { sections: { private: P() }, repaired: true }, JSON.stringify(raw));
  // private が無いだけなら既定（直したことにしない）
  assert.deepStrictEqual(N({}), { sections: { private: P() }, repaired: false });
  assert.deepStrictEqual(N(undefined), { sections: { private: P() }, repaired: false });
  // 後の版のセクション（形の正しい名前・中身は真偽・数・40 字までの文字だけの 10 項目までの組）はそのまま残る
  const later = { favorites: { open: false }, shared: { open: true, show: 5, sort: 'edited', note: 'あ'.repeat(40) } };
  assert.deepStrictEqual(N({ private: P(), ...later }), { sections: { private: P(), ...later }, repaired: false });
  // 形の悪い名前（大文字・21 字・記号）・中身に組や配列や 41 字の文字・11 項目の組は落とす
  for (const bad of [{ Fav: { open: true } }, { [`${'a'.repeat(21)}`]: { open: true } }, { 'fav-x': { open: true } }, { fav: { open: { x: 1 } } },
    { fav: { list: [1] } }, { fav: { note: 'あ'.repeat(41) } }, { fav: { n: Infinity } }, { fav: 'x' },
    { fav: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, true])) }]) {
    assert.deepStrictEqual(N({ private: P(), ...bad }), { sections: { private: P() }, repaired: true }, JSON.stringify(bad));
  }
  // セクションは private を入れて 10 まで（11 個目は落とす）
  const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${String.fromCharCode(97 + i)}`, { open: true }]));
  const r = N({ private: P(), ...ten });
  assert.deepStrictEqual(Object.keys(r.sections), ['private', 'sa', 'sb', 'sc', 'sd', 'se', 'sf', 'sg', 'sh', 'si']);
  assert.strictEqual(r.repaired, true);
  // 入力は書き換えない・返す組は入力と別の物
  const raw = { private: P({ show: 7 }), fav: { open: true } };
  const copy = JSON.parse(JSON.stringify(raw));
  const out = N(raw);
  assert.deepStrictEqual(raw, copy);
  out.sections.fav.open = false;
  assert.strictEqual(raw.fav.open, true);
});

test('PS-1・F158: winstate の normalize・applyUi は sections を同じ照らしで読み、ほかの項目（sidebar・tabs・tree・emojiRecent）は残す。無い覚え書きは既定で repaired に入らない', T, () => {
  assert.deepStrictEqual(W.defaults().sections, { private: P() });
  const base = { v: 1, sidebar: { width: 300, collapsed: false }, tabs: { open: ['page:pa1'], active: 'page:pa1' }, tree: { open: ['pa1'] }, emojiRecent: ['📄'] };
  const none = W.normalize(base, []);
  assert.deepStrictEqual(none.state.sections, { private: P() });
  assert.deepStrictEqual(none.repaired, []);
  const ok = W.normalize({ ...base, sections: { private: P({ open: false, sort: 'edited', show: 10 }), favorites: { open: false } } }, []);
  assert.deepStrictEqual(ok.state.sections, { private: P({ open: false, sort: 'edited', show: 10 }), favorites: { open: false } });
  assert.deepStrictEqual(ok.repaired, []);
  const bad = W.normalize({ ...base, sections: { private: { open: false, sort: 'x', show: 10 }, Fav: { open: true } } }, []);
  assert.deepStrictEqual(bad.state.sections, { private: P({ open: false, show: 10 }) });
  assert.deepStrictEqual(bad.repaired, ['sections']);
  for (const k of ['sidebar', 'tabs', 'tree', 'emojiRecent']) assert.deepStrictEqual(bad.state[k], base[k], k);
  assert.deepStrictEqual(W.normalize({ ...base, sections: null }, []).state.sections, { private: P() });
  // applyUi: 画面から来た形も同じ照らし。ほかの項目は変えない
  const st = W.normalize(base, []).state;
  const next = W.applyUi(st, { sections: { private: { open: false, sort: 'edited', show: 7 }, shared: { open: true }, BAD: { open: 1 } } });
  assert.deepStrictEqual(next.sections, { private: P({ open: false, sort: 'edited' }), shared: { open: true } });
  assert.deepStrictEqual([next.sidebar, next.tabs, next.tree, next.emojiRecent], [st.sidebar, st.tabs, st.tree, st.emojiRecent]);
  assert.deepStrictEqual(W.applyUi(st, { sidebar: { width: 320 } }).sections, { private: P() }, '別の項目を送るとセクションが変わった');
  assert.deepStrictEqual(W.sectionsOf({}), { private: P() });
});

test('PS-1・D125: TAB_FIXED は [\'library\']（ライブラリのタブは起動し直しても戻す）。音声入力のタブと設定のタブは今どおり黙って落とす', T, () => {
  assert.strictEqual(W.tabKeyOk('library'), true);
  assert.strictEqual(W.tabKeyOk('dictation'), false);
  assert.deepStrictEqual(W.keepTabs({ open: ['library', 'page:pa1'], active: 'library' }, () => true), { tabs: { open: ['library', 'page:pa1'], active: 'library' }, dropped: 0 });
  assert.deepStrictEqual(W.keepTabs({ open: ['dictation', 'library', 'settings'], active: 'dictation' }, () => true), { tabs: { open: ['library'], active: 'library' }, dropped: 0 });
  assert.deepStrictEqual(W.applyUi(W.defaults(), { tabs: { open: ['library', 'library'], active: 'library' } }).tabs, { open: ['library'], active: 'library' });
});

// ---------------------------------------------------------------- sectionRows（決めたこと 23・F162）
// 木: a（最上位・新しい）> a1・a2、b > b1、c・d・e・f・g（最上位）。updatedAt は並べ替えを見るために作った値
const ROW = (id, createdAt, updatedAt, parentId = null, ord = 'i') => ({ id, createdAt, updatedAt, parentId, ord });
const ROWS = [
  ROW('pa', '2026-11-07T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
  ROW('pa1', '2026-11-07T01:00:00.000Z', '2026-11-02T00:00:00.000Z', 'pa', 'a'),
  ROW('pa2', '2026-11-07T02:00:00.000Z', '2026-11-06T00:00:00.000Z', 'pa', 'b'),
  ROW('pb', '2026-11-06T00:00:00.000Z', '2026-11-05T00:00:00.000Z'),
  ROW('pb1', '2026-11-06T01:00:00.000Z', '2026-11-07T09:00:00.000Z', 'pb', 'a'),
  ROW('pc', '2026-11-05T00:00:00.000Z', '2026-11-03T00:00:00.000Z'),
  ROW('pd', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z'),
  ROW('pe', '2026-11-03T00:00:00.000Z', '2026-11-02T12:00:00.000Z'),
  ROW('pf', '2026-11-02T00:00:00.000Z', 'x'),
  ROW('pg', '2026-11-01T00:00:00.000Z', '2026-11-06T12:00:00.000Z'),
];
const TREE = PT.pageTree(ROWS);
const ids = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}${r.id}`);

test('PS-1・F162: sectionRows の表（手動は 0.15.0 の visibleRows と同じ・最終更新はどの段も兄弟の中で updatedAt の新しい順（作った日でない・子は親の下）・表示の数はいちばん上の段だけ数える・すべて）', T, () => {
  const open = new Set(['pa', 'pb']);
  const manual = SS.sectionRows(TREE, open, { sort: 'manual', show: 0 });
  assert.deepStrictEqual(manual, { rows: PT.visibleRows(TREE, open), hidden: 0 });
  assert.deepStrictEqual(ids(manual.rows), ['pa', '  pa1', '  pa2', 'pb', '  pb1', 'pc', 'pd', 'pe', 'pf', 'pg']);
  const edited = SS.sectionRows(TREE, open, { sort: 'edited', show: 0 });
  assert.deepStrictEqual(ids(edited.rows), ['pg', 'pb', '  pb1', 'pd', 'pc', 'pe', 'pa', '  pa2', '  pa1', 'pf']);
  assert.strictEqual(edited.hidden, 0);
  // 表示 5: いちばん上の 5 つ（開いた子は数えずに出す）と出していない数
  const five = SS.sectionRows(TREE, open, { sort: 'manual', show: 5 });
  assert.deepStrictEqual(ids(five.rows), ['pa', '  pa1', '  pa2', 'pb', '  pb1', 'pc', 'pd', 'pe']);
  assert.strictEqual(five.hidden, 2);
  assert.deepStrictEqual(ids(SS.sectionRows(TREE, open, { sort: 'edited', show: 5 }).rows), ['pg', 'pb', '  pb1', 'pd', 'pc', 'pe']);
  // 数が段の数より多い・壊れた値はすべて
  assert.deepStrictEqual(SS.sectionRows(TREE, new Set(), { show: 20 }), { rows: PT.visibleRows(TREE, new Set()), hidden: 0 });
  assert.strictEqual(SS.sectionRows(TREE, new Set(), { show: 7 }).rows.length, 7);
  assert.deepStrictEqual(SS.sectionRows(TREE, null, {}).rows.map((r) => r.id), ['pa', 'pb', 'pc', 'pd', 'pe', 'pf', 'pg']);
  // 閉じた行の子は出さない
  assert.deepStrictEqual(ids(SS.sectionRows(TREE, new Set(), { sort: 'edited' }).rows), ['pg', 'pb', 'pd', 'pc', 'pe', 'pa', 'pf']);
});

// ---------------------------------------------------------------- relTime（決めたこと 34・F164）
test('PS-1・F164: relTime の表（たった今・n 分前・n 時間前・n 日前・n 週間前・年/月/日。未来はたった今・壊れた値は空）と stampText', T, () => {
  const now = new Date(2026, 10, 6, 14, 5, 0);   // その PC の暦の 2026/11/06 14:05
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();
  const S = 1000; const M = 60 * S; const H = 60 * M; const D = 24 * H;
  for (const [ms, want] of [[0, 'たった今'], [59 * S, 'たった今'], [60 * S, '1 分前'], [59 * M, '59 分前'], [H, '1 時間前'], [23 * H, '23 時間前'],
    [24 * H, '1 日前'], [6 * D, '6 日前'], [7 * D, '1 週間前'], [13 * D, '1 週間前'], [14 * D, '2 週間前'], [34 * D, '4 週間前']]) {
    assert.strictEqual(SS.relTime(ago(ms), now), want, `${ms}`);
  }
  assert.strictEqual(SS.relTime(new Date(2026, 9, 2, 14, 5, 0).toISOString(), now), '2026/10/02');
  assert.strictEqual(SS.relTime(new Date(2025, 0, 9, 8, 0, 0).toISOString(), now.getTime()), '2025/01/09');
  assert.strictEqual(SS.relTime(new Date(now.getTime() + 5 * M).toISOString(), now), 'たった今');
  for (const bad of ['', 'x', null, undefined, 3, {}]) assert.strictEqual(SS.relTime(bad, now), '', String(bad));
  assert.strictEqual(SS.relTime(ago(H), 'x'), '');
  assert.strictEqual(SS.stampText(new Date(2026, 10, 6, 4, 5, 0).toISOString()), '2026/11/06 04:05');
  assert.strictEqual(SS.stampText('x'), '');
});

// ---------------------------------------------------------------- libraryRows（決めたこと 34〜38・F164）
const LIB_ROWS = [
  ROW('pr1', '2026-11-07T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
  ROW('pr2', '2026-11-06T00:00:00.000Z', '2026-11-05T00:00:00.000Z'),
  ROW('pr3', '2026-11-05T00:00:00.000Z', '2026-11-03T00:00:00.000Z'),
  ROW('pk1', '2026-11-07T01:00:00.000Z', '2026-11-02T00:00:00.000Z', 'pr2', 'a'),
  ROW('pk2', '2026-11-07T02:00:00.000Z', '2026-11-04T00:00:00.000Z', 'pr2', 'b'),
  ROW('pg1', '2026-11-07T03:00:00.000Z', '2026-11-06T00:00:00.000Z', 'pk2', 'a'),
];
const TITLES = { pr1: 'うみの資料', pr2: 'あさの会議', pr3: 'イベントの準備', pk1: 'ノートの下書き', pk2: 'かいぎの控え', pg1: 'ミーティング記録' };
const LIB = PT.pageTree(LIB_ROWS);
const titleOf = (id) => TITLES[id] || '';

test('PS-1・F164: libraryRows の表（並べ替え無しはサイドバーの手動・題名は五十音で兄弟の中・dir で逆・最終更新・開け閉め・語はひらがなとカタカナを寄せて木を崩し place を付ける）', T, () => {
  const L = (o) => SS.libraryRows(LIB, { titleOf, ...o });
  const open = new Set(['pr2']);
  assert.deepStrictEqual(L({ open }), SS.sectionRows(LIB, open, { sort: 'manual', show: 0 }).rows);
  // 五十音（あ・イ・う）。文字の番号の順（あ・う・イ）ではない。子も兄弟の中で（か・ノ）
  assert.deepStrictEqual(ids(L({ col: 'title', dir: 'asc', open })), ['pr2', '  pk2', '  pk1', 'pr3', 'pr1']);
  assert.deepStrictEqual(ids(L({ col: 'title', dir: 'desc', open })), ['pr1', 'pr3', 'pr2', '  pk1', '  pk2']);
  assert.deepStrictEqual(ids(L({ col: 'edited', dir: 'desc', open: new Set(['pr2', 'pk2']) })), ['pr2', '  pk2', '    pg1', '  pk1', 'pr3', 'pr1']);
  assert.deepStrictEqual(ids(L({ col: 'edited', dir: 'asc', open })), ['pr1', 'pr3', 'pr2', '  pk1', '  pk2']);
  // 閉じていれば子は出ない・hasKids は出す
  assert.deepStrictEqual(L({}).map((r) => [r.id, r.hasKids, r.open]), [['pr1', false, false], ['pr2', true, false], ['pr3', false, false]]);
  // 語で絞る: カタカナの語でひらがなの題名にも当たり、木を崩して場所を付ける（最上位は ''）
  const hit = L({ q: 'カイギ' });
  assert.deepStrictEqual(hit.map((r) => [r.id, r.depth, r.place]), [['pk2', 0, 'あさの会議']]);
  assert.deepStrictEqual(L({ q: 'アサ' }).map((r) => [r.id, r.depth, r.place]), [['pr2', 0, '']]);
  assert.deepStrictEqual(L({ q: 'みーてぃんぐ' }).map((r) => [r.id, r.place]), [['pg1', 'あさの会議 / かいぎの控え']]);
  assert.deepStrictEqual(L({ q: 'ｶｲｷﾞ' }).map((r) => r.id), ['pk2'], '半角カタカナを寄せない');
  // 語があるときの並べ替えは、崩した行の全部を五十音で（あ・イ・う・か・ノ）
  assert.deepStrictEqual(L({ q: 'の', col: 'title', dir: 'asc' }).map((r) => r.id), ['pr2', 'pr3', 'pr1', 'pk2', 'pk1']);
  assert.deepStrictEqual(L({ q: '見つからない語' }), []);
  assert.deepStrictEqual(L({ q: '   ' }).map((r) => r.id), ['pr1', 'pr2', 'pr3'], '空白だけの語で絞った');
});

test('PS-1・F164: libraryRows は 5,000 ページで 100 ミリ秒以内（3 回の中央値。並べ替え・語・開け閉め）', { timeout: 30000 }, () => {
  const rows = [];
  for (let i = 0; i < 5000; i++) {
    const parentId = i < 500 ? null : `p${(i % 500).toString(36)}x`;
    rows.push({ id: `p${i.toString(36)}x`, parentId, ord: `a${(i % 37).toString(36)}`, createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 5, 1) - ((i * 7919) % 100000) * 60000).toISOString() });
  }
  const tree = PT.pageTree(rows);
  const title = (id) => `会議の記録 ${id}`;
  const open = new Set(rows.slice(0, 500).map((r) => r.id));
  const times = [];
  for (let k = 0; k < 3; k++) {
    const t0 = process.hrtime.bigint();
    SS.libraryRows(tree, { col: 'title', dir: 'asc', open, titleOf: title });
    SS.libraryRows(tree, { col: 'edited', dir: 'desc', open, titleOf: title });
    SS.libraryRows(tree, { q: 'ｷﾛｸ', titleOf: title });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6 / 3);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[1] <= 100, `中央値 ${times[1].toFixed(1)} ms`);
  assert.strictEqual(SS.libraryRows(tree, { open, titleOf: title }).length, 5000);
});

test('PS-1: oneLineTitle（改行・タブ・続いた改行を1つの空白に・前後の空白を落とす）', T, () => {
  assert.strictEqual(SS.oneLineTitle('  見積\nの\r\n件\t確認  '), '見積 の 件 確認');
  assert.strictEqual(SS.oneLineTitle('一\n\n\n二'), '一 二');
  assert.strictEqual(SS.oneLineTitle('  そのまま  の 空白 '), 'そのまま  の 空白');
  assert.strictEqual(SS.oneLineTitle(''), '');
  assert.strictEqual(SS.oneLineTitle(null), '');
  assert.strictEqual(SS.oneLineTitle('\n\t'), '');
});

// ---------------------------------------------------------------- 場面（mainrun。F158）
test('PS-1・F158: ui:get は window-state.json の sections を照らして渡し、ui:set で送った形を覚えて次の ui:get に出す（後の版のセクションも残す）', { timeout: sceneTimeout(20000) }, async () => {
  const r = await run(['text', '--json-scene=ws-sections-get']);
  assert.deepStrictEqual(r.ui.sections, { private: P({ open: false, show: 10 }), favorites: { open: false } }, '壊れた sort だけを既定に戻していない');
  assert.deepStrictEqual(r.set, { ok: true });
  assert.deepStrictEqual(r.again.sections, { private: P({ sort: 'edited', show: 5 }), favorites: { open: false } });
  assert.deepStrictEqual(r.again.tabs, { open: ['library'], active: 'library' }, 'ライブラリのタブが戻らない');
  assert.deepStrictEqual(r.none.sections, { private: P() });
});
