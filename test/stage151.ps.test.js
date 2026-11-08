/*
 * stage151.ps.test.js — 0.15.1 サイドバーの「プライベート」のセクション・行の［···］と名前を変える・ライブラリ（計画 docs/plans/2026-11-04-151.md の
 * Task PS-1〜PS-5。D124・D125）
 * PS-1（F158・F161・F162・F164）: 純粋な部品（src/sideSection.js）と窓の覚え書きの sections・ライブラリのタブ（TAB_FIXED）・ui:get の sections。
 * PS-2（F157〜F162）: 見出し「プライベート」（押すと畳む・↗・［＋］・［···］の並べ替え・表示・ページを選ぶ）・［もっと見る］・畳み・並べ替え・表示を覚える。
 *       画面の sideSection の写しは src/sideSection.js と字も答えも同じ（R30）。
 * 要素を比べるときは assert.ok(a === b, 文) にする（赤のときに報告が最小 DOM の木を丸ごと書き出し、CI の記憶を使い切る: 0.11.0 R22・0.15.1 R41）。
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
  // ND-1・PS-1 直し（2026-11-08 の点検 M2）: 真偽でない偽の値（0・''）も既定（開く）に戻す（Boolean で寄せると閉じてしまう）
  for (const open of [0, '', null]) assert.deepStrictEqual(N({ private: { open, sort: 'edited', show: 5 } }), { sections: { private: P({ sort: 'edited', show: 5 }) }, repaired: true }, String(open));
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
  // ND-1・PS-1 直し（2026-11-08 の点検 M5・R36）: private の中の後の版の項目（形の正しい名前で、真偽・有限の数・40 字までの文字）は読まずに残す（10 項目まで）。
  // 形の悪い項目だけ落とす。sort・show は今どおり決まった値だけ（後の版の値は既定に戻す）
  assert.deepStrictEqual(N({ private: { ...P({ open: false }), pinned: true, note: 'あ'.repeat(40), n: 3 } }),
    { sections: { private: { ...P({ open: false }), pinned: true, note: 'あ'.repeat(40), n: 3 } }, repaired: false });
  for (const bad of [{ deep: { x: 1 } }, { list: [1] }, { note: 'あ'.repeat(41) }, { n: Infinity }, { 'a-b': true }, { ['x'.repeat(21)]: true }]) {
    assert.deepStrictEqual(N({ private: { ...P(), pinned: true, ...bad } }), { sections: { private: { ...P(), pinned: true } }, repaired: true }, JSON.stringify(bad));
  }
  const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${String.fromCharCode(97 + i)}`, i]));
  const kept = N({ private: { ...P(), ...many } });
  assert.deepStrictEqual(Object.keys(kept.sections.private), ['open', 'sort', 'show', 'ka', 'kb', 'kc', 'kd', 'ke', 'kf', 'kg'], '10 項目より多く残した・少なく残した');
  assert.strictEqual(kept.repaired, true);
  assert.strictEqual(Object.getPrototypeOf(N(JSON.parse('{"private":{"__proto__":{"x":1},"open":true}}')).sections.private), Object.prototype, '__proto__ の項目で組の形が変わった');
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
  // ND-1・PS-1 直し（点検 M2）: 決まった値でない数（3）はすべて（3 つに絞らない）
  assert.deepStrictEqual(SS.sectionRows(TREE, new Set(), { show: 3 }), { rows: PT.visibleRows(TREE, new Set()), hidden: 0 });
  assert.deepStrictEqual(SS.sectionRows(TREE, null, {}).rows.map((r) => r.id), ['pa', 'pb', 'pc', 'pd', 'pe', 'pf', 'pg']);
  // 閉じた行の子は出さない
  assert.deepStrictEqual(ids(SS.sectionRows(TREE, new Set(), { sort: 'edited' }).rows), ['pg', 'pb', 'pd', 'pc', 'pe', 'pa', 'pf']);
});

// ---------------------------------------------------------------- relTime（決めたこと 34・F164）
test('PS-1・F164: relTime の表（たった今・n 分前・n 時間前・n 日前・n 週間前・年/月/日。未来はたった今・壊れた値は空）と stampText', T, (t) => {
  // ND-1・PS-1 直し（2026-11-08 の点検 M1）: 日本の暦で見る（CI の UTC では、その PC の暦と UTC の暦が同じになり、UTC で日付を作る間違いを見落とす）
  const prevTZ = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  t.after(() => { if (prevTZ === undefined) delete process.env.TZ; else process.env.TZ = prevTZ; });
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
  // 日本の朝 08:30 は UTC では前の日の 23:30（UTC の暦で書くと日も時も違う）
  assert.strictEqual(SS.stampText('2026-11-05T23:30:00.000Z'), '2026/11/06 08:30');
  assert.strictEqual(SS.relTime('2026-09-30T23:30:00.000Z', now), '2026/10/01');
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

test('PS-1・F164: libraryRows の表（ND-1・PS-1 直し: 名前の順は数を数として並べる・同じ名前は手動の並びのまま・場所は 5 段より深ければ頭を「…」・英字の大小を寄せる）', T, () => {
  // 持ち主の答え（2026-11-08）「数を数として並べる（第1回→第2回→第10回）（おすすめ）」（R36）
  const rows = [ROW('n10', '2026-11-07T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), ROW('n1', '2026-11-06T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
    ROW('n2', '2026-11-05T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), ROW('s1', '2026-11-04T00:00:00.000Z', '2026-11-03T00:00:00.000Z'),
    ROW('s2', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z')];
  const names = { n10: '定例 第10回', n1: '定例 第1回', n2: '定例 第2回', s1: '同じ名前', s2: '同じ名前' };
  const tree = PT.pageTree(rows);
  const L = (o) => SS.libraryRows(tree, { titleOf: (id) => names[id], ...o }).map((r) => r.id);
  assert.deepStrictEqual(L({ col: 'title', dir: 'asc' }), ['n1', 'n2', 'n10', 's1', 's2'], '数を数として並べない（第10回が第2回より前）');
  assert.deepStrictEqual(L({ col: 'title', dir: 'desc' }), ['s1', 's2', 'n10', 'n2', 'n1'], '逆の向きで、同じ名前の手動の並びが崩れた');
  // 同じ最終更新も手動の並び（いちばん上は新しい順）のまま
  assert.deepStrictEqual(L({ col: 'edited', dir: 'desc' }), ['s1', 's2', 'n10', 'n1', 'n2']);
  assert.deepStrictEqual(L({ col: 'edited', dir: 'asc' }), ['n10', 'n1', 'n2', 's1', 's2']);
  // 場所: 7 段の深い行は祖先の後ろの 5 つと頭の「…」
  const deep = Array.from({ length: 7 }, (_, i) => ROW(`d${i}`, `2026-11-0${i + 1}T00:00:00.000Z`, '2026-11-01T00:00:00.000Z', i ? `d${i - 1}` : null, 'a'));
  const dt = PT.pageTree(deep);
  const dn = (id) => (id === 'd6' ? 'いちばん下' : `段${id.slice(1)}`);
  assert.deepStrictEqual(SS.libraryRows(dt, { titleOf: dn, q: 'いちばん' }).map((r) => r.place), ['… / 段1 / 段2 / 段3 / 段4 / 段5']);
  assert.deepStrictEqual(SS.libraryRows(dt, { titleOf: (id) => (id === 'd5' ? 'いちばん下' : `段${id.slice(1)}`), q: 'いちばん' }).map((r) => r.place), ['段0 / 段1 / 段2 / 段3 / 段4']);
  // 英字の大小と全角を寄せる
  assert.strictEqual(SS.kanaFold('ＡＢＣ Def'), 'abcdef');
  assert.deepStrictEqual(SS.libraryRows(tree, { titleOf: (id) => (id === 's2' ? 'Weekly Review' : names[id]), q: 'weekly' }).map((r) => r.id), ['s2']);
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
    SS.libraryRows(tree, { q: '会議', titleOf: title });   // ND-1・PS-1 直し（点検 M2）: 全部に当たる語（当たりと場所の道も測る）
    times.push(Number(process.hrtime.bigint() - t0) / 1e6 / 3);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[1] <= 100, `中央値 ${times[1].toFixed(1)} ms`);
  assert.strictEqual(SS.libraryRows(tree, { open, titleOf: title }).length, 5000);
  const hits = SS.libraryRows(tree, { q: '会議', titleOf: title });
  assert.strictEqual(hits.length, 5000, '測った語が当たっていない');
  assert.ok(hits.some((r) => r.place), '測った語の当たりに場所が無い');
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

// ================================================================ PS-2（画面: 最小 DOM の simrun で app.html の <script> を走らせる）
// 見出し「プライベート」（畳む・↗・［＋］・［···］）・並べ替えと表示の数・［もっと見る］（決めたこと 20〜28・F157〜F162）
const fs = require('node:fs');
const { load } = require('./helpers/simrun.js');
const { titleAt } = require('./helpers/titles');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const HTML = fs.readFileSync(APP, 'utf8');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
// 見本の一覧（DB の pages.list と同じ並び: 作った新しい順）。最上位 7 つ（pg7…pg1）。pg6 の中に k1・k2（並びの鍵の順）。
// 最終更新（updatedAt）は作った日と別: pg2 がいちばん新しく、pg5・pg7・pg6 の順。子の k2 は全部の中でいちばん新しい（段をまたがない）
const AT = (d) => `2026-11-${d}.000Z`;
const UROW = (id, createdAt, updatedAt, o = {}) => ({ id, title: titleAt(createdAt), date: createdAt.slice(0, 10), durationSec: 600, hasSummary: true, createdAt, updatedAt, parentId: null, ord: 'i', ...o });
const ULIST = () => [
  UROW('pg7', AT('07T00:00:00'), AT('07T01:00:00')),
  UROW('k2', AT('06T08:00:00'), AT('20T00:00:00'), { parentId: 'pg6', ord: 'r', kind: 'blank' }),
  UROW('k1', AT('06T07:00:00'), AT('06T07:00:00'), { parentId: 'pg6', ord: 'i', kind: 'blank' }),
  UROW('pg6', AT('06T00:00:00'), AT('06T00:00:00')),
  UROW('pg5', AT('05T00:00:00'), AT('15T00:00:00')),
  UROW('pg4', AT('04T00:00:00'), AT('04T00:00:00')),
  UROW('pg3', AT('03T00:00:00'), AT('03T00:00:00')),
  UROW('pg2', AT('02T00:00:00'), AT('18T00:00:00')),
  UROW('pg1', AT('01T00:00:00'), AT('01T00:00:00')),
];
const UPAGE = (id) => {
  const p = ULIST().find((x) => x.id === id);
  return p ? { page: { id, title: p.title, date: p.date, createdAt: p.createdAt, updatedAt: p.updatedAt, durationSec: 600, blocks: [], memo: '', meetingType: 'general', ...(p.kind ? { kind: p.kind } : {}) }, segments: [] } : null;
};
const UNEW = () => ({ page: { id: 'pnew1', kind: 'blank', title: '', date: '2026-11-08', createdAt: '2026-11-08T01:00:00.000Z', durationSec: 0, blocks: [], memo: '' }, segments: [] });
async function bootUi(o = {}) {
  const l = await load(APP, { returns: {
    pagesSearch: () => (o.list ? o.list() : ULIST()), pageGet: (id) => UPAGE(id) || (id === 'pnew1' ? UNEW() : null), pageCreate: () => ({ id: 'pnew1', page: UNEW().page }),
    pageMove: () => ULIST(), uiState: () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' }, ...(o.ui || {}) }), ...(o.returns || {}) } });
  await l.drain();
  return l;
}
const uRows = (l) => $(l, 'plist').querySelectorAll('.pitem');
const uIds = (l) => uRows(l).map((r) => r.dataset.pid);
const uRow = (l, id) => uRows(l).find((r) => r.dataset.pid === id);
const press = async (l, el, o = {}) => { el.dispatchEvent({ type: 'click', ...o }); await l.drain(); };
const secSaves = (l) => l.called('uiSave').map((c) => c.args[0]).filter((p) => p && p.sections);
const menuTop = (l) => $(l, 'privMenu').querySelectorAll('.mitem').filter((x) => x.parentNode === $(l, 'privMenu'));
const labels = (l) => menuTop(l).map((b) => b.textContent);
const tabKeysOf = (l) => $(l, 'tabbar').querySelectorAll('[role="tab"]').map((t) => t.dataset.key);
const hiddenUp = (el) => {
  for (let n = el; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) {
    if (n.hidden || /display:\s*none/.test(n.getAttribute('style') || '') || (n.style && n.style.display === 'none')) return true;
  }
  return false;
};
// Tab で届く順（サイドバーの中。DOM の順で、tabIndex が 0 以上で、隠れた祖先の無い物）
const tabStops = (l) => $(l, 'side')._walk([]).filter((e) => {
  const ti = e.tabIndex !== undefined ? e.tabIndex : e.hasAttribute('tabindex') ? Number(e.getAttribute('tabindex')) : ['button', 'input', 'select', 'textarea'].includes(e.tagName) ? 0 : -1;
  return ti >= 0 && !hiddenUp(e);
}).map((e) => e.id || (e.dataset && e.dataset.pid ? `row:${e.dataset.pid}` : e.className));
const pickMenu = async (l, head, label) => {
  await press(l, $(l, 'privMore'));
  $(l, head).focus();
  l.key({ key: 'ArrowRight' }, $(l, 'privMenu')); await l.drain();
  const it = menuTop(l).find((b) => b.textContent === label);
  assert.ok(it, `［${label}］が無い`);
  await press(l, it);
};
const SORT_NOTE = '並べ替えを「手動」に戻すと、手で並べられます';
const MANUAL = ['pg7', 'pg6', 'pg5', 'pg4', 'pg3', 'pg2', 'pg1'];
const EDITED = ['pg2', 'pg5', 'pg7', 'pg6', 'pg4', 'pg3', 'pg1'];

test('PS-2（R30）: 画面の写し（app.html の sideSectionView）は src/sideSection.js と字も答えも同じ', () => {
  const at = HTML.indexOf('  // ---- sideSection の写し');
  const end = HTML.indexOf('  // ---- sideSection の写しはここまで');
  assert.ok(at > 0 && end > at, 'app.html に sideSection の写しが無い');
  const seg = HTML.slice(at, end);
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'sideSection.js'), 'utf8');
  const body = SRC.slice(SRC.indexOf('const SECTION_DEFAULT'), SRC.indexOf('\nmodule.exports')).replace(/\s+$/, '');
  assert.ok(seg.includes(body.split('\n').map((x) => (x ? `    ${x}` : x)).join('\n')), 'app.html の写しの字が src/sideSection.js と違う');
  const app = new Function(`${seg}\nreturn sideSectionView;`)();   // eslint-disable-line no-new-func
  assert.deepStrictEqual([app.SECTION_DEFAULT, app.SORTS, app.SHOW_STEPS], [SS.SECTION_DEFAULT, SS.SORTS, SS.SHOW_STEPS]);
  for (const raw of [undefined, null, { private: { open: false, sort: 'x', show: 10 }, fav: { open: true }, Bad: { open: true } }]) {
    assert.deepStrictEqual(app.normSections(raw), SS.normSections(raw));
  }
  for (const o of [{}, { sort: 'edited' }, { show: 5 }, { sort: 'edited', show: 10 }]) {
    for (const open of [new Set(), new Set(['pa', 'pb'])]) assert.deepStrictEqual(app.sectionRows(TREE, open, o), SS.sectionRows(TREE, open, o), JSON.stringify(o));
  }
  const now = Date.parse('2026-11-08T00:00:00.000Z');
  for (const iso of ['2026-11-07T23:59:30.000Z', '2026-11-07T20:00:00.000Z', '2026-10-01T00:00:00.000Z', 'x']) {
    assert.strictEqual(app.relTime(iso, now), SS.relTime(iso, now));
    assert.strictEqual(app.stampText(iso), SS.stampText(iso));
  }
  const titleOf = (id) => ({ pa: 'あ', pb: 'ア', pc: 'a', pd: 'カ' })[id] || id;
  for (const o of [{}, { col: 'title' }, { col: 'title', dir: 'desc' }, { col: 'edited', dir: 'desc' }, { q: 'あ' }, { open: new Set(['pa']) }]) {
    assert.deepStrictEqual(app.libraryRows(TREE, { titleOf, ...o }), SS.libraryRows(TREE, { titleOf, ...o }), JSON.stringify(o));
  }
  assert.strictEqual(app.oneLineTitle(' a\nb\tc '), SS.oneLineTitle(' a\nb\tc '));
  assert.strictEqual(app.kanaFold('カタカナ ＡＢ'), SS.kanaFold('カタカナ ＡＢ'));
});

test('PS-2・F157・F161: 見出しは「プライベート」と印 ⌄（#tabBtnNotes は無い）。押すと #plist に hidden・aria-expanded="false"・印 ›・title「プライベートを開く」、もう一度で元に戻る（木・開け閉め・選んでいる行は同じ）', T, async () => {
  const l = await bootUi({ ui: { tree: { open: ['pg6'] } } });
  assert.strictEqual(l.root.querySelectorAll('#tabBtnNotes').length, 0, '#tabBtnNotes が残っている');
  const h = $(l, 'privHead');
  assert.ok(h && h.tagName === 'button' && h.getAttribute('type') === 'button', '見出しが type="button" の button でない（Enter・Space は本物の button が押す）');
  const mark = h.querySelector('[aria-hidden="true"]');
  assert.ok(mark, '印が aria-hidden の別の span でない');
  const look = () => [h.textContent, mark.textContent, h.getAttribute('aria-expanded'), h.getAttribute('aria-controls'), h.title, $(l, 'plist').hidden];
  assert.deepStrictEqual(look(), ['プライベート⌄', '⌄', 'true', 'plist', 'プライベートを畳む', false]);
  assert.strictEqual($(l, 'plist').getAttribute('aria-label'), 'プライベートのページ');
  await press(l, uRow(l, 'pg5'));
  const before = uIds(l);
  assert.deepStrictEqual(before, ['pg7', 'pg6', 'k1', 'k2', 'pg5', 'pg4', 'pg3', 'pg2', 'pg1']);
  await press(l, h);
  assert.deepStrictEqual(look(), ['プライベート›', '›', 'false', 'plist', 'プライベートを開く', true]);
  assert.deepStrictEqual(uIds(l), before, '畳むと木が変わった');
  await press(l, h);
  assert.deepStrictEqual(look(), ['プライベート⌄', '⌄', 'true', 'plist', 'プライベートを畳む', false]);
  assert.deepStrictEqual(uIds(l), before, '開き直すと木の開け閉めが変わった');
  assert.ok(uRow(l, 'pg5').classList.contains('sel'), '開き直すと選んでいる行が変わった');
  assert.deepStrictEqual(tabKeysOf(l), ['page:pg5'], '見出しを押すとタブが替わった（前の goNotes の動き）');
  // 見出しの行に［選ぶ］の字のボタンが無い（［···］の［ページを選ぶ］へ移った）・［＋］は「ページを追加」・↗ は「ライブラリで開く」・［···］は「プライベートのメニュー」
  assert.ok(!$(l, 'side').querySelectorAll('button').some((b) => b.textContent === '選ぶ'), '［選ぶ］のボタンが残っている');
  const btn = (id) => [$(l, id).textContent, $(l, id).getAttribute('title'), $(l, id).getAttribute('aria-label')];
  assert.deepStrictEqual([btn('privLib'), btn('newPageBtn'), btn('privMore')],
    [['↗', 'ライブラリで開く', 'ライブラリで開く'], ['＋', 'ページを追加', 'ページを追加'], ['···', 'プライベートのメニュー', 'プライベートのメニュー']]);
  assert.deepStrictEqual([$(l, 'privMore').getAttribute('aria-haspopup'), $(l, 'privMore').getAttribute('aria-expanded')], ['menu', 'false']);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PS-2・F157（決めたこと 26）: Tab の並びは［検索］→［新しい議事録］→ 見出し → ↗・［＋］・［···］→ 木の行1つ →［もっと見る］→［設定］。畳んでいるときは木の行と［もっと見る］に届かない', T, async () => {
  const l = await bootUi({ ui: { sections: { private: { open: true, sort: 'manual', show: 5 } } } });
  const seg = (xs) => xs.slice(xs.indexOf('sideSearch'), xs.indexOf('tabBtnSettings') + 1);
  assert.deepStrictEqual(seg(tabStops(l)), ['sideSearch', 'mtToggleBtn', 'privHead', 'privLib', 'newPageBtn', 'privMore', 'row:pg7', 'sideMore', 'tabBtnSettings']);
  await press(l, $(l, 'privHead'));
  assert.deepStrictEqual(seg(tabStops(l)), ['sideSearch', 'mtToggleBtn', 'privHead', 'privLib', 'newPageBtn', 'privMore', 'tabBtnSettings']);
  // 見出しの右の3つは、見出しの行に乗せたとき・その中にフォーカスがあるときだけ見える（PQ6）
  const css = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
  assert.match(css, /\.ph-btn \{[^}]*opacity: 0;/, '見出しの右のボタンがふだんから見えている');
  assert.match(css, /\.privrow:hover \.ph-btn, \.privrow:focus-within \.ph-btn[^{]*\{[^}]*opacity: 1;/, '乗せる・フォーカスで出ない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PS-2・F158（PQ5）: 畳む・並べ替え・表示を変えるたびに uiSave({ sections }) の1回（後の版のセクションも送る）。uiState の sections で畳んだ形・最終更新・表示 10 で始まる', T, async () => {
  const later = { favorites: { open: false } };
  const l = await bootUi({ ui: { sections: { private: { open: false, sort: 'edited', show: 10 }, ...later } } });
  assert.strictEqual($(l, 'privHead').getAttribute('aria-expanded'), 'false', '覚えた畳みで始まらない');
  assert.strictEqual($(l, 'plist').hidden, true);
  assert.deepStrictEqual(uIds(l), EDITED, '覚えた並べ替え（最終更新）で始まらない');
  assert.deepStrictEqual(secSaves(l), [], '起動で sections を書いた');
  await press(l, $(l, 'privHead'));
  assert.deepStrictEqual(secSaves(l), [{ sections: { private: { open: true, sort: 'edited', show: 10 }, ...later } }]);
  await pickMenu(l, 'privSort', '手動');
  assert.deepStrictEqual(secSaves(l).slice(1), [{ sections: { private: { open: true, sort: 'manual', show: 10 }, ...later } }]);
  await pickMenu(l, 'privShow', '5');
  assert.deepStrictEqual(secSaves(l).slice(2), [{ sections: { private: { open: true, sort: 'manual', show: 5 }, ...later } }]);
  assert.strictEqual(secSaves(l).length, 3, '1回の変えに2回以上送った');
  // 形の悪い覚え書きは項目ごとに照らした形で始まる（壊れた sort だけ既定）
  const b = await bootUi({ ui: { sections: { private: { open: false, sort: 'x', show: 5 } } } });
  assert.strictEqual($(b, 'privHead').getAttribute('aria-expanded'), 'false');
  await press(b, $(b, 'privMore'));
  assert.deepStrictEqual(labels(b), ['並べ替え: 手動 ›', '表示: 5 ›', 'ページを選ぶ']);
  assert.deepStrictEqual([...l.errors, ...b.errors].map(fmt), []);
});

test('PS-2・F159・F161: 畳んでいる間（［＋］は開いてから最上位に pageCreate の1回・リンク・タブ・Ctrl+Shift+N・ライブラリから開いても畳んだまま・選ぶ形の間に畳むと選ぶ形が終わる・下の［設定］は同じ所）', T, async () => {
  const l = await bootUi();
  await press(l, uRow(l, 'pg5'));
  await press(l, uRow(l, 'pg3'), { ctrlKey: true });
  await press(l, $(l, 'privHead'));
  // タブ・リンク（main から）・Ctrl+Shift+N の［白紙のページ］・ライブラリのタブで開いても畳んだまま
  $(l, 'tabbar').querySelectorAll('[role="tab"]').find((t) => t.dataset.key === 'page:pg5').dispatchEvent({ type: 'click' }); await l.drain();
  l.fire('onPageOpen', 'pg2'); await l.drain();
  await press(l, $(l, 'privLib'));
  l.key({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }); await l.drain();
  l.key({ key: 'Enter' }, $(l, 'newList')); await l.drain();
  assert.deepStrictEqual(l.called('pageCreate').map((c) => c.args), [[]], '前提: Ctrl+Shift+N の［白紙のページ］');
  assert.strictEqual($(l, 'privHead').getAttribute('aria-expanded'), 'false', 'ページを開いたらプライベートが開いた');
  assert.strictEqual($(l, 'plist').hidden, true);
  // ［＋］は開いてから、開いているページの中でなく最上位に作る（PQ3 (a)）
  await press(l, $(l, 'newPageBtn'));
  assert.deepStrictEqual(l.called('pageCreate').map((c) => c.args), [[], []], '［＋］が最上位に作らない（開いているページの中に作った）');
  assert.strictEqual($(l, 'privHead').getAttribute('aria-expanded'), 'true', '畳んだまま［＋］で作った');
  assert.strictEqual($(l, 'plist').hidden, false);
  // 選ぶ形の間に畳むと選ぶ形が終わる
  await press(l, $(l, 'privMore'));
  await press(l, $(l, 'listSelect'));
  await press(l, uRow(l, 'pg7'));
  assert.ok(uRows(l).every((r) => r.querySelector('.pchk')), '前提: 選ぶ形');
  assert.strictEqual($(l, 'selBar').hidden, false);
  await press(l, $(l, 'privHead'));
  await press(l, $(l, 'privHead'));
  assert.ok(uRows(l).every((r) => !r.querySelector('.pchk')), '選ぶ形のまま畳んだ');
  assert.strictEqual($(l, 'selBar').hidden, true, '選ぶ形のまま畳んだ（頭の枠）');
  // 下の［ゴミ箱］［設定］: 畳んだときは伸びる余白（#sideFill）が一覧の所を受け持つ
  const fill = $(l, 'sideFill');
  assert.ok(fill, '伸びる余白の部品が無い');
  assert.strictEqual(fill.hidden, true, '開いているのに余白を出した');
  await press(l, $(l, 'privHead'));
  assert.strictEqual(fill.hidden, false, '畳んだのに余白を出さない（下の［設定］が上へ跳ぶ）');
  const kids = $(l, 'side').children;
  assert.ok(kids.indexOf(fill) > kids.indexOf($(l, 'plist')) && kids.indexOf(fill) < kids.indexOf($(l, 'tabBtnTrash')), '余白の場所が一覧と［ゴミ箱］の間でない');
  const css = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
  assert.match(css, /\.side-fill \{[^}]*flex: 1;/, '余白が伸びない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PS-2・F160: 見出しの［···］のメニュー（並べ替え・表示・ページを選ぶ）。→ と Enter で下のメニュー・← と Esc で戻る・Esc で閉じて［···］へ・Tab は中で留める・［ページを選ぶ］で選ぶ形（畳んでいれば開く・ページが無ければ灰色）', T, async () => {
  const l = await bootUi();
  const box = $(l, 'privMenu');
  const more = $(l, 'privMore');
  assert.strictEqual(box.hidden, true);
  await press(l, more);
  assert.strictEqual(box.hidden, false, '［···］で開かない');
  assert.deepStrictEqual([box.getAttribute('role'), more.getAttribute('aria-expanded')], ['menu', 'true']);
  assert.deepStrictEqual(menuTop(l).map((b) => [b.textContent, b.getAttribute('role')]), [['並べ替え: 手動 ›', 'menuitem'], ['表示: すべて ›', 'menuitem'], ['ページを選ぶ', 'menuitem']]);
  assert.deepStrictEqual([$(l, 'privSort').getAttribute('aria-haspopup'), $(l, 'privShow').getAttribute('aria-haspopup')], ['menu', 'menu']);
  assert.ok(l.document.activeElement === $(l, 'privSort'), '開いて1つ目にフォーカスが無い');
  // ↓ で次へ・Tab は中で留める（最後から最初へ）
  l.key({ key: 'ArrowDown' }, box); assert.ok(l.document.activeElement === $(l, 'privShow'));
  l.key({ key: 'Tab' }, box); assert.ok(l.document.activeElement === $(l, 'listSelect'), 'Tab で次の項目へ移らない');
  const tabEv = l.key({ key: 'Tab' }, box); await l.drain();
  assert.ok(tabEv.defaultPrevented && l.document.activeElement === $(l, 'privSort') && !box.hidden, 'Tab でメニューの外へ出た');
  // → で下のメニュー（手動・最終更新の menuitemradio）・← で戻る
  l.key({ key: 'ArrowRight' }, box); await l.drain();
  assert.deepStrictEqual(menuTop(l).map((b) => [b.textContent, b.getAttribute('role'), b.getAttribute('aria-checked')]),
    [['並べ替え: 手動 ›', 'menuitem', null], ['手動', 'menuitemradio', 'true'], ['最終更新', 'menuitemradio', 'false'], ['表示: すべて ›', 'menuitem', null], ['ページを選ぶ', 'menuitem', null]]);
  assert.strictEqual($(l, 'privSort').getAttribute('aria-expanded'), 'true');
  assert.strictEqual(l.document.activeElement.textContent, '手動', '下のメニューの選んでいる項目へフォーカスが行かない');
  l.key({ key: 'ArrowLeft' }, box); await l.drain();
  assert.deepStrictEqual(labels(l), ['並べ替え: 手動 ›', '表示: すべて ›', 'ページを選ぶ']);
  assert.ok(l.document.activeElement === $(l, 'privSort'), '← で［並べ替え ›］へ戻らない');
  // Enter で表示の下のメニュー（5・10・15・20・すべて）・Esc で戻る（メニューは閉じない）
  l.key({ key: 'ArrowDown' }, box);
  l.key({ key: 'Enter' }, box); await l.drain();
  assert.deepStrictEqual(labels(l), ['並べ替え: 手動 ›', '表示: すべて ›', '5', '10', '15', '20', 'すべて', 'ページを選ぶ']);
  assert.strictEqual(l.document.activeElement.textContent, 'すべて', '既定（PQ8）がすべてでない');
  l.key({ key: 'Escape' }, box); await l.drain();
  assert.ok(!box.hidden && l.document.activeElement === $(l, 'privShow'), 'Esc で下のメニューだけが閉じない');
  // Esc で閉じて［···］へ
  const esc = l.key({ key: 'Escape' }, box); await l.drain();
  assert.ok(esc.defaultPrevented && box.hidden && l.document.activeElement === more, 'Esc で閉じて［···］へフォーカスが戻らない');
  assert.strictEqual(more.getAttribute('aria-expanded'), 'false');
  // ［ページを選ぶ］: 畳んでいれば開いて選ぶ形に入る
  await press(l, $(l, 'privHead'));
  await press(l, more);
  l.key({ key: 'End' }, box);
  assert.ok(l.document.activeElement === $(l, 'listSelect'));
  l.key({ key: 'Enter' }, box); await l.drain();
  assert.ok(box.hidden, '［ページを選ぶ］でメニューが閉じない');
  assert.strictEqual($(l, 'privHead').getAttribute('aria-expanded'), 'true', '畳んだまま選ぶ形に入った');
  assert.ok(uRows(l).length && uRows(l).every((r) => r.querySelector('.pchk')), '［ページを選ぶ］で選ぶ形に入らない');
  // ページが無いときは灰色で押しても何も起きない
  const e = await bootUi({ list: () => [] });
  await press(e, $(e, 'privMore'));
  assert.strictEqual($(e, 'listSelect').getAttribute('aria-disabled'), 'true', 'ページが無いのに［ページを選ぶ］が灰色でない');
  await press(e, $(e, 'listSelect'));
  assert.strictEqual($(e, 'selBar').hidden, true);
  assert.deepStrictEqual([...l.errors, ...e.errors].map(fmt), []);
});

test('PS-2・F162: ［最終更新］で木の並びが sectionRows の答え（段ごと・子は親の下）・［手動］で元の並び。最終更新の間に兄弟の前後へ落とすと pageMove を呼ばず一言（真ん中へは今どおり中へ）', T, async () => {
  const l = await bootUi({ ui: { tree: { open: ['pg6'] } } });
  const withKids = (top, kids) => top.flatMap((id) => (id === 'pg6' ? ['pg6', ...kids] : [id]));
  assert.deepStrictEqual(uIds(l), withKids(MANUAL, ['k1', 'k2']));
  await pickMenu(l, 'privSort', '最終更新');
  assert.deepStrictEqual(uIds(l), withKids(EDITED, ['k2', 'k1']), '最終更新の並びが違う（作った日の順・段をまたいだ）');
  assert.ok($(l, 'privMenu').hidden, '選んでもメニューが閉じない');
  assert.ok(l.document.activeElement === $(l, 'privMore'), '選んだ後のフォーカスが［···］でない');
  await press(l, $(l, 'privMore'));
  assert.deepStrictEqual(labels(l), ['並べ替え: 最終更新 ›', '表示: すべて ›', 'ページを選ぶ']);
  l.key({ key: 'Escape' }, $(l, 'privMenu')); await l.drain();
  // 前後へ落とす → 呼ばずに一言・真ん中 → 中へ
  for (const r of uRows(l)) r._rect = { top: 0, height: 30 };
  const dt = () => ({ effectAllowed: '', setData() {} });
  const drag = (id) => uRow(l, id).dispatchEvent({ type: 'dragstart', target: uRow(l, id), dataTransfer: dt() });
  const drop = (id, y) => uRow(l, id).dispatchEvent({ type: 'drop', clientY: y, dataTransfer: { types: ['application/x-natsu-page'] }, preventDefault() {} });
  drag('k1'); drop('pg4', 28); await l.drain();
  drag('pg4'); drop('pg5', 2); await l.drain();
  assert.deepStrictEqual(l.called('pageMove'), [], '最終更新の間に前後へ落として並べた');
  assert.strictEqual($(l, 'toast').textContent, SORT_NOTE);
  for (const r of uRows(l)) r._rect = { top: 0, height: 30 };
  drag('k1'); drop('pg4', 15); await l.drain();
  assert.deepStrictEqual(l.called('pageMove').map((c) => c.args), [['k1', 'pg4', undefined]], '真ん中へ落としても中へ入らない');
  await pickMenu(l, 'privSort', '手動');
  assert.deepStrictEqual(uIds(l), withKids(MANUAL, ['k1', 'k2']), '［手動］で元の並びに戻らない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PS-2・F162・PQ8: ［表示］の［5］でいちばん上の行が 5 つ（開いた子は数えない）と［もっと見る］。押すと library のタブ。［すべて］で［もっと見る］が無い。↗ も library のタブ（2回押してもタブは1つ）', T, async () => {
  const l = await bootUi({ ui: { tree: { open: ['pg6'] } } });
  assert.strictEqual($(l, 'sideMore').hidden, true, '既定（すべて）で［もっと見る］が出た');
  await pickMenu(l, 'privShow', '5');
  assert.deepStrictEqual(uIds(l), ['pg7', 'pg6', 'k1', 'k2', 'pg5', 'pg4', 'pg3'], '表示の数に子を数えた・数を見ない');
  assert.deepStrictEqual([$(l, 'sideMore').hidden, $(l, 'sideMore').textContent, $(l, 'sideMore').tagName, $(l, 'sideMore').className], [false, 'もっと見る', 'button', 'side-more']);
  await press(l, $(l, 'sideMore'));
  assert.deepStrictEqual(tabKeysOf(l), ['library'], '［もっと見る］でライブラリを開かない');
  assert.strictEqual($(l, 'tabbar').querySelector('[aria-selected="true"]').dataset.key, 'library');
  assert.strictEqual($(l, 'tabbar').querySelector('[aria-selected="true"]').textContent.replace('×', ''), '📚 ライブラリ');
  assert.deepStrictEqual([$(l, 'tabLibrary').classList.contains('active'), $(l, 'tabNotes').classList.contains('active'), $(l, 'tabLibrary').querySelector('h1').textContent],
    [true, false, 'ライブラリ'], 'ライブラリの中身が出ない');
  await press(l, uRow(l, 'pg7'));
  await press(l, $(l, 'privLib'));
  await press(l, $(l, 'privLib'));
  assert.deepStrictEqual(tabKeysOf(l).filter((k) => k === 'library'), ['library'], '↗ でライブラリのタブが増えた');
  assert.strictEqual($(l, 'tabbar').querySelector('[aria-selected="true"]').dataset.key, 'library', '↗ でライブラリのタブへ移らない');
  await pickMenu(l, 'privShow', 'すべて');
  assert.strictEqual($(l, 'sideMore').hidden, true, '［すべて］で［もっと見る］が残った');
  assert.deepStrictEqual(uIds(l), ['pg7', 'pg6', 'k1', 'k2', 'pg5', 'pg4', 'pg3', 'pg2', 'pg1']);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ================================================================ PS-3（行の［···］と、その場で名前を変える: 決めたこと 29・30・F163）
const ORIGIN = 'https://natsu-help.natsu-code.workers.dev';
const rowMenu = (l) => l.document.querySelector('.treemenu');
const rowItems = (l) => rowMenu(l).querySelectorAll('.mitem');
const renameBox = (l) => $(l, 'plist').querySelector('input.pren');
const CSR = { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true };
const tokyo = (t) => {
  const prev = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  t.after(() => { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; });
};
// 名前を変えられる一覧（pageSetTitle で一覧の題名も替わる。fail が真なら断る）
function renamable(o = {}) {
  const names = new Map();
  const list = () => ULIST().map((p) => (names.has(p.id) ? { ...p, title: names.get(p.id) || (p.kind === 'blank' ? '無題のページ' : '(無題の議事録)') } : p));
  return {
    list,
    returns: {
      linkBase: () => `${ORIGIN}/open#p=`,
      pageGet: (id) => { const p = list().find((x) => x.id === id); const g = UPAGE(id); return g && p ? { ...g, page: { ...g.page, title: names.has(id) ? names.get(id) : g.page.title } } : null; },
      pageSetTitle: (id, title) => { if (o.fail) throw Object.assign(new Error('bad-args'), { code: 'bad-args' }); names.set(id, title); return { ok: true }; },
    },
  };
}

test('PS-3・F163: 行の［···］（.pmore・「ページのメニュー」・tabIndex -1・右端の［＋］の左）で行のメニュー。6つの項目の並びと、区切りの下に押せない「最終更新 年/月/日 時:分」（updatedAt）。右クリック・Shift+F10 も同じ。［リンクを写す］は今の［リンクを写す］と同じ行', T, async (t) => {
  tokyo(t);
  const r0 = renamable();
  const l = await bootUi({ list: r0.list, returns: r0.returns });
  const row = uRow(l, 'pg5');
  const more = row.querySelector('.pmore');
  assert.ok(more, '行に［···］が無い');
  assert.deepStrictEqual([more.tagName, more.textContent, more.title, more.getAttribute('aria-label'), more.tabIndex], ['button', '···', 'ページのメニュー', 'ページのメニュー', -1]);
  const kids = row.children;
  assert.ok(kids.indexOf(more) >= 0 && kids.indexOf(more) + 1 === kids.indexOf(row.querySelector('.padd')), '［···］が右端の［＋］のすぐ左に無い');
  await press(l, more);
  assert.ok(rowMenu(l), '［···］で行のメニューが出ない');
  const want = ['リンクを写す', '名前を変える', '移動先…', '中にページを作る', '新しいタブで開く', '削除'];
  assert.deepStrictEqual(rowItems(l).map((b) => b.textContent), want);
  assert.deepStrictEqual(rowItems(l).map((b) => b.getAttribute('data-kbd')), [null, 'Ctrl+Shift+R', null, null, 'Ctrl+Enter', null]);
  assert.deepStrictEqual(rowItems(l).map((b) => b.getAttribute('aria-keyshortcuts')), [null, 'Control+Shift+R', null, null, 'Control+Enter', null]);
  const foot = rowMenu(l).querySelector('.mfoot');
  assert.ok(foot, '最終更新の行が無い');
  assert.deepStrictEqual([foot.textContent, foot.getAttribute('role'), foot.tabIndex], ['最終更新 2026/11/15 09:00', 'none', undefined], '最終更新の行が updatedAt でない（作った日時を出した）');
  assert.ok(rowMenu(l).querySelector('.msep'), '区切りが無い');
  assert.ok(foot.id && rowMenu(l).getAttribute('aria-describedby') === foot.id, '最終更新の行をメニューの説明として読まない');
  // ↑↓ は項目だけ（最終更新の行で止まらない）
  assert.ok(l.document.activeElement === rowItems(l)[0]);
  l.key({ key: 'ArrowUp' }, rowMenu(l));
  assert.strictEqual(l.document.activeElement.textContent, '削除', '↑ で最終更新の行に止まった');
  l.key({ key: 'Escape' }, rowMenu(l)); await l.drain();
  // 右クリック・Shift+F10 も同じメニュー
  uRow(l, 'pg5').dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain();
  assert.deepStrictEqual(rowItems(l).map((b) => b.textContent), want);
  l.key({ key: 'Escape' }, rowMenu(l)); await l.drain();
  l.key({ key: 'F10', shiftKey: true }, uRow(l, 'pg5')); await l.drain();
  assert.deepStrictEqual(rowItems(l).map((b) => b.textContent), want);
  // ［リンクを写す］: 「···」のページのメニュー・選んだ行の［リンクを写す］と同じ行（決めたこと 100 の形）
  await press(l, rowItems(l)[0]);
  const p5 = ULIST().find((p) => p.id === 'pg5');
  assert.deepStrictEqual(l.called('copy').map((c) => c.args[0]), [`NaTsu の議事録「${p5.title}」（${p5.date}）${ORIGIN}/open#p=pg5`]);
  assert.strictEqual($(l, 'toast').textContent, 'リンクを写しました。');
  assert.ok(rowMenu(l) === null, '写した後もメニューが残る');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PS-3・F163: 名前を変える（［名前を変える］・行で Ctrl+Shift+R → 行の題名の所に1行の欄。変換中の Enter では決まらない・Enter で pageSetTitle の1回（続くフォーカスの外れで2回目を送らない）・外を押すと決まる・Esc でやめて行へ・同じ名前は送らない・改行とタブは1行に・空も送る）', T, async () => {
  const r0 = renamable();
  const l = await bootUi({ list: r0.list, returns: r0.returns });
  const sent = () => l.called('pageSetTitle').map((c) => c.args);
  // ［名前を変える］
  await press(l, uRow(l, 'pg5').querySelector('.pmore'));
  await press(l, rowItems(l)[1]);
  let box = renameBox(l);
  assert.ok(box, '［名前を変える］で欄が出ない');
  assert.ok(box.parentNode === uRow(l, 'pg5').querySelector('.t'), '欄が行の題名の所に無い');
  assert.deepStrictEqual([box.value, box.getAttribute('aria-label'), box.maxLength, l.document.activeElement === box], [ULIST().find((p) => p.id === 'pg5').title, 'ページの名前', 500, true]);
  // 変換中の Enter（isComposing・keyCode 229）では決まらない
  box.value = '見積もりの件';
  l.key({ key: 'Enter', isComposing: true }, box); l.key({ key: 'Enter', keyCode: 229 }, box); await l.drain();
  assert.deepStrictEqual(sent(), [], '変換確定の Enter で名前が決まった');
  assert.ok(renameBox(l) === box, '変換確定の Enter で欄が閉じた');
  // Enter で1回・続くフォーカスの外れで2回目を送らない
  const ev = l.key({ key: 'Enter' }, box);
  box.dispatchEvent({ type: 'blur' }); await l.drain();
  assert.strictEqual(ev.defaultPrevented, true);
  assert.deepStrictEqual(sent(), [['pg5', '見積もりの件']], 'Enter とフォーカスの外れで2回送った');
  assert.ok(renameBox(l) === null, '決めた後も欄が残る');
  assert.strictEqual(uRow(l, 'pg5').querySelector('.t').textContent, '見積もりの件', '一覧の名前が替わらない');
  // 行で Ctrl+Shift+R・外を押す（フォーカスが外れる）と決まる
  uRow(l, 'pg4').focus();
  const k = l.key(CSR, uRow(l, 'pg4')); await l.drain();
  assert.strictEqual(k.defaultPrevented, true);
  box = renameBox(l);
  assert.ok(box && box.parentNode === uRow(l, 'pg4').querySelector('.t'), 'Ctrl+Shift+R で欄が出ない');
  box.value = '  会議の\n控え\tその二  ';
  box.dispatchEvent({ type: 'blur' }); await l.drain();
  assert.deepStrictEqual(sent().slice(1), [['pg4', '会議の 控え その二']], '外を押して決まらない・改行とタブを1行に寄せない');
  // Esc でやめる（送らない・元の題名・フォーカスは行へ）
  uRow(l, 'pg3').focus();
  l.key(CSR, uRow(l, 'pg3')); await l.drain();
  box = renameBox(l);
  box.value = '取り消す名前';
  const esc = l.key({ key: 'Escape' }, box);
  box.dispatchEvent({ type: 'blur' }); await l.drain();
  assert.strictEqual(esc.defaultPrevented, true);
  assert.deepStrictEqual(sent().length, 2, 'Esc で名前を決めた');
  assert.strictEqual(uRow(l, 'pg3').querySelector('.t').textContent, ULIST().find((p) => p.id === 'pg3').title);
  assert.ok(l.document.activeElement === uRow(l, 'pg3'), 'Esc の後のフォーカスが行でない');
  // 同じ名前は送らない・空は送る（一覧は「(無題の議事録)」）
  l.key(CSR, uRow(l, 'pg2')); await l.drain();
  l.key({ key: 'Enter' }, renameBox(l)); await l.drain();
  assert.deepStrictEqual(sent().length, 2, '同じ名前を送った');
  l.key(CSR, uRow(l, 'pg1')); await l.drain();
  renameBox(l).value = '   ';
  l.key({ key: 'Enter' }, renameBox(l)); await l.drain();
  assert.deepStrictEqual(sent().slice(2), [['pg1', '']]);
  assert.strictEqual(uRow(l, 'pg1').querySelector('.t').textContent, '(無題の議事録)');
  // 欄の中のキーは木へ渡らない（↓ で行が移らない・Space で開かない）。一覧を読み直しても（main の知らせ）欄と打った字はそのまま
  l.key(CSR, uRow(l, 'pg7')); await l.drain();
  renameBox(l).value = '打ちかけ';
  l.fire('onPagesUpdated'); await l.drain();
  box = renameBox(l);
  assert.ok(box && box.parentNode === uRow(l, 'pg7').querySelector('.t') && box.value === '打ちかけ' && l.document.activeElement === box, '一覧を読み直すと名前の欄か打った字が消えた');
  assert.deepStrictEqual(sent().length, 3, '読み直しで名前を決めた');
  l.key({ key: 'ArrowDown' }, box); l.key({ key: ' ' }, box); await l.drain();
  assert.ok(renameBox(l) === box && l.document.activeElement === box, '欄の中の ↓・Space が木の行を動かした');
  assert.deepStrictEqual(l.called('pageGet'), [], '欄の中のキーでページを開いた');
  box.dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(l.called('pageGet'), [], '欄を押すとページを開いた');
  l.key({ key: 'Escape' }, box); await l.drain();
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PS-3・F163: 名前を変えられないとき（DB が断る → 元に戻して「名前を変えられませんでした。」・選ぶ形の間と本文・ページの題名の欄の Ctrl+Shift+R は何もしない）と、開いているページの名前を変えるとタブとページの頭の題名も替わる', T, async () => {
  const bad = renamable({ fail: true });
  const l = await bootUi({ list: bad.list, returns: bad.returns });
  const was = ULIST().find((p) => p.id === 'pg5').title;
  l.key(CSR, uRow(l, 'pg5')); await l.drain();
  renameBox(l).value = '断られる名前';
  l.key({ key: 'Enter' }, renameBox(l)); await l.drain();
  assert.ok(renameBox(l) === null, '断られた後も欄が残る');
  assert.strictEqual(uRow(l, 'pg5').querySelector('.t').textContent, was, '断られたのに元に戻さない');
  assert.strictEqual($(l, 'toast').textContent, '名前を変えられませんでした。');
  // 選ぶ形の間は何もしない
  await press(l, $(l, 'privMore'));
  await press(l, $(l, 'listSelect'));
  l.key(CSR, uRow(l, 'pg5')); await l.drain();
  assert.ok(renameBox(l) === null, '選ぶ形の間に欄が出た');
  await press(l, $(l, 'selCancel'));
  // 開いているページ: ページの頭の題名と本文の文字の欄の Ctrl+Shift+R は何もしない。行の名前を変えるとタブと頭の題名も替わる
  const ok = renamable();
  const o = await bootUi({ list: ok.list, returns: ok.returns });
  await press(o, uRow(o, 'pg5'));
  for (const el of [$(o, 'pTitle'), $(o, 'pMemo')].filter(Boolean)) {
    el.focus();
    o.key(CSR, el); await o.drain();
    assert.ok(renameBox(o) === null, `${el.id} の Ctrl+Shift+R で名前の欄が出た`);
  }
  o.key(CSR, uRow(o, 'pg5')); await o.drain();
  renameBox(o).value = '替えた題名';
  o.key({ key: 'Enter' }, renameBox(o)); await o.drain();
  assert.strictEqual($(o, 'tabbar').querySelector('[data-key="page:pg5"]').textContent.replace('×', ''), '替えた題名', 'タブの名前が替わらない');
  assert.strictEqual($(o, 'pTitle').textContent, '替えた題名', 'ページの頭の題名が替わらない');
  assert.deepStrictEqual([...l.errors, ...o.errors].map(fmt), []);
});

test('PS-3・F163: 近道の表（src/shortcuts.js の SHORTCUTS）に Ctrl+Shift+R の行と、新しい項目の並びに直した Shift+F10 の行。設定の表にも同じ行が出る', T, async () => {
  const { SHORTCUTS } = require('../src/shortcuts');
  const at = (k, w) => SHORTCUTS.find((r) => r.keys === k && r.where.startsWith(w));
  assert.deepStrictEqual({ ...at('Ctrl+Shift+R', 'サイドバー') }, { keys: 'Ctrl+Shift+R', what: 'ページの名前を変える', where: 'サイドバーのページの一覧（ライブラリの行でも）', codes: [] });
  assert.strictEqual(at('Shift+F10', 'サイドバー').what, '行のメニューを開く（リンクを写す・名前を変える・移動先・中にページを作る・新しいタブで開く・削除）');
  assert.ok(SHORTCUTS.indexOf(at('Ctrl+Shift+R', 'サイドバー')) === SHORTCUTS.indexOf(at('Shift+F10', 'サイドバー')) + 1, 'Ctrl+Shift+R の行が Shift+F10 の次に無い');
  const l = await bootUi();
  $(l, 'tabBtnSettings').dispatchEvent({ type: 'click' }); await l.drain();
  const text = $(l, 'tabSettings').textContent;
  assert.ok(text.includes('Ctrl+Shift+R') && text.includes('ページの名前を変える'), '設定の近道の表に Ctrl+Shift+R の行が無い');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ================================================================ PS-2 直し（2026-11-08 の e70aa9e..32e3fa1 の点検・R42）
test('PS-2 直し・F160: 選ぶ形の間はいつも下の帯と［やめる］を出す（0 件でも。［リンクを写す］は 0 件では押せない）。［ページを選ぶ］の後のフォーカスは木の行（持ち主の答え 2026-11-08）', T, async () => {
  const l = await bootUi();
  uRow(l, 'pg7').focus();
  for (const id of ['pg7', 'pg6']) { l.key({ key: 'ArrowDown' }, uRow(l, id)); await l.drain(); }   // 木の中で pg5 へ移る
  await press(l, $(l, 'privMore'));
  l.key({ key: 'End' }, $(l, 'privMenu'));
  l.key({ key: 'Enter' }, $(l, 'privMenu')); await l.drain();
  assert.ok(uRows(l).every((r) => r.querySelector('.pchk')), '前提: 選ぶ形');
  const a = l.document.activeElement;
  assert.ok(a && a.parentNode === $(l, 'plist') && a.dataset.pid === 'pg5', '［ページを選ぶ］の後のフォーカスが前の木の行でない（隠れたメニューの項目に残る）');
  assert.deepStrictEqual([$(l, 'selBar').hidden, $(l, 'selCount').textContent, $(l, 'selCopy').disabled, $(l, 'selCancel').disabled === true], [false, '', true, false], '0 件で帯か［やめる］が出ない・［リンクを写す］が押せる');
  await press(l, uRow(l, 'pg7'));
  assert.deepStrictEqual([$(l, 'selBar').hidden, $(l, 'selCount').textContent, $(l, 'selCopy').disabled], [false, '1 件を選んでいます', false]);
  await press(l, uRow(l, 'pg7'));
  assert.deepStrictEqual([$(l, 'selBar').hidden, $(l, 'selCopy').disabled], [false, true], '選びを外して 0 件にすると帯が消えた');
  // マウスで（0 件のまま）［やめる］で終える
  await press(l, $(l, 'selCancel'));
  assert.ok(uRows(l).every((r) => !r.querySelector('.pchk')) && $(l, 'selBar').hidden, '0 件のときに［やめる］で選ぶ形が終わらない');
  // 前にフォーカスした行が無ければ、見えているいちばん上の行へ
  const b = await bootUi();
  await press(b, $(b, 'privMore'));
  await press(b, $(b, 'listSelect'));
  assert.ok(b.document.activeElement === uRow(b, 'pg7'), '前の行が無いときにいちばん上の行へフォーカスしない');
  assert.deepStrictEqual([...l.errors, ...b.errors].map(fmt), []);
});

test('PS-2 直し・F162: 選ぶ形の間に並べ替え・表示を変えると、見えなくなった行の選びを外す（数と写す行が合う）。写す並びは見えている並び（最終更新）', T, async () => {
  const l = await bootUi({ returns: { linkBase: () => `${'https://natsu-help.natsu-code.workers.dev'}/open#p=`, copy: () => ({ ok: true }) } });
  await pickMenu(l, 'privSort', '最終更新');
  await press(l, $(l, 'privMore'));
  await press(l, $(l, 'listSelect'));
  await press(l, uRow(l, EDITED[0]));
  await press(l, uRow(l, EDITED[6]), { shiftKey: true });
  assert.strictEqual($(l, 'selCount').textContent, '7 件を選んでいます');
  await press(l, $(l, 'selCopy'));
  const order = l.called('copy')[0].args[0].split('\n').map((s) => s.slice(s.lastIndexOf('=') + 1));
  assert.deepStrictEqual(order, EDITED, '写す並びが見えている並び（最終更新）でない');
  await pickMenu(l, 'privShow', '5');
  assert.strictEqual($(l, 'selCount').textContent, '5 件を選んでいます', '表示の数の外になった行の選びが残った');
  await press(l, $(l, 'selCopy'));
  assert.strictEqual(l.called('copy')[1].args[0].split('\n').length, 5);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PS-2 直し・F160: 見出しの［···］のメニューの細かい決まり（外を押すと閉じる・行き先が無ければ［···］へ・行のメニューを開いていれば閉じる・Space で押す・変換中の Enter は先に抜ける）と、覚えた形が届く前に変えたら上書きしない', T, async () => {
  const l = await bootUi();
  // 行のメニューを開いたまま［···］を押すと、行のメニューは閉じる
  uRow(l, 'pg5').dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain();
  assert.ok(rowMenu(l), '前提: 行のメニュー');
  await press(l, $(l, 'privMore'));
  assert.ok(rowMenu(l) === null, '見出しのメニューを開いても行のメニューが残る');
  // 変換中の Enter では下のメニューを開かない・Space では開く
  l.key({ key: 'Enter', isComposing: true }, $(l, 'privMenu')); await l.drain();
  assert.strictEqual($(l, 'privSort').getAttribute('aria-expanded'), 'false', '変換中の Enter で下のメニューを開いた');
  l.key({ key: ' ' }, $(l, 'privMenu')); await l.drain();
  assert.strictEqual($(l, 'privSort').getAttribute('aria-expanded'), 'true', 'Space で下のメニューを開かない');
  l.key({ key: 'Escape' }, $(l, 'privMenu')); await l.drain();
  // 項目の Space で押す（［ページを選ぶ］）
  l.key({ key: 'End' }, $(l, 'privMenu'));
  l.key({ key: ' ' }, $(l, 'privMenu')); await l.drain();
  assert.ok(uRows(l).every((r) => r.querySelector('.pchk')), 'Space で［ページを選ぶ］を押せない');
  await press(l, $(l, 'selCancel'));
  // 外を押す: フォーカスがほかの行へ移ればそこに残して閉じる・行き先が無ければ閉じて［···］へ
  await press(l, $(l, 'privMore'));
  uRow(l, 'pg3').focus();
  $(l, 'privMenu').dispatchEvent({ type: 'focusout' });
  await l.clock.advance(5); await l.drain();
  assert.ok($(l, 'privMenu').hidden && l.document.activeElement === uRow(l, 'pg3'), '外を押して閉じない・押した行のフォーカスを奪った');
  await press(l, $(l, 'privMore'));
  l.document.activeElement.blur();
  $(l, 'privMenu').dispatchEvent({ type: 'focusout' });
  await l.clock.advance(5); await l.drain();
  assert.ok($(l, 'privMenu').hidden && l.document.activeElement === $(l, 'privMore'), '行き先の無い所を押して閉じたのに［···］へ戻らない');
  // 覚えた形が届く前に見出しを押していたら、届いた形で上書きしない
  let give = null;
  const late = await bootUi({ returns: { uiState: () => new Promise((r) => { give = r; }) } });
  await press(late, $(late, 'privHead'));
  give({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' }, sections: { private: { open: true, sort: 'edited', show: 0 } } });
  await late.drain();
  assert.strictEqual($(late, 'privHead').getAttribute('aria-expanded'), 'false', '届く前に畳んだのに、届いた覚え書きで開いた');
  assert.deepStrictEqual(uIds(late), MANUAL, '届く前に変えたのに、届いた並べ替えで上書きした');
  assert.deepStrictEqual([...l.errors, ...late.errors].map(fmt), []);
});

test('PS-2 直し: 「最終更新」の間は、兄弟の前後へ落とす印（線）を出さない（中へ落とす枠は出す）', T, async () => {
  const l = await bootUi();
  await pickMenu(l, 'privSort', '最終更新');
  for (const r of uRows(l)) r._rect = { top: 0, height: 30 };
  uRow(l, 'pg4').dispatchEvent({ type: 'dragstart', target: uRow(l, 'pg4'), dataTransfer: { effectAllowed: '', setData() {} } });
  const over = (id, y) => uRow(l, id).dispatchEvent({ type: 'dragover', clientY: y, dataTransfer: { types: ['application/x-natsu-page'] }, preventDefault() {} });
  over('pg5', 2);
  assert.ok(!uRow(l, 'pg5').classList.contains('dropbefore') && !uRow(l, 'pg5').classList.contains('dropafter'), '最終更新の間に前後の線を出した');
  over('pg5', 15);
  assert.ok(uRow(l, 'pg5').classList.contains('dropin'), '中へ落とす枠が出ない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PS-2 直し: sectionRows の「最終更新」は 5,000 ページでも速い（日時を木ごとに1回だけ読む。一覧の読み直しの4回で 40 ミリ秒以内・3 回の中央値）', { timeout: 30000 }, () => {
  const rows = [];
  for (let i = 0; i < 5000; i++) rows.push({ id: `q${i.toString(36)}`, parentId: null, ord: 'i', createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), updatedAt: new Date(Date.UTC(2026, 5, 1) - ((i * 7919) % 100000) * 60000).toISOString() });
  const times = [];
  for (let k = 0; k < 3; k++) {
    const tree = PT.pageTree(rows);   // 一覧を読み直すたびに木は組み直す
    const t0 = process.hrtime.bigint();
    for (let j = 0; j < 4; j++) SS.sectionRows(tree, new Set(), { sort: 'edited', show: j % 2 ? 5 : 0 });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[1] <= 40, `中央値 ${times[1].toFixed(1)} ms`);
  const r = SS.sectionRows(PT.pageTree(rows), new Set(), { sort: 'edited', show: 5 });
  assert.deepStrictEqual([r.rows.length, r.hidden], [5, 4995]);
});
