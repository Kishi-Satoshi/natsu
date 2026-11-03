/*
 * stage150.lib.test.js — 0.15.0「ページの階層」の純粋な部品（計画 docs/plans/2026-11-03-150.md の Task PH-1）
 * ページの木（src/pageTree.js: 並び・親の無い行と輪は最上位・子孫・動かしてよいか・一緒に消す子と戻す子・見える行・兄弟の中の鍵・
 * 落とす所・場所の文）と、サイドバーの開け閉めの覚え書きの照らし（src/winstate.js の tree.open）。
 * ページの ID と題名は作った物で、実在の人名・社名は使わない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/pageTree.js');
const W = require('../src/winstate.js');

const row = (id, parentId, ord, createdAt, trashedAt) => ({ id, parentId, ord, createdAt, ...(trashedAt ? { trashedAt } : {}) });
const day = (d) => `2026-${d}T09:00:00.000Z`;
const kidsOf = (tree, id) => tree.kids.get(id) || [];

// 3 段の木（a の子 a1・a2・a3、a2 の子 a2x）と、親が rows に無い2つ（消した親・ゴミ箱の親）
const ROWS = [
  row('pa', null, 'i', day('11-01')),
  row('pb', null, 'i', day('11-03')),
  row('pc', null, 'i', day('11-02')),
  row('pa1', 'pa', 'm', day('11-05')),
  row('pa2', 'pa', 'c', day('11-06')),
  row('pa3', 'pa', 'm', day('11-04')),
  row('pa2x', 'pa2', 'i', day('11-07')),
  row('pz', 'pgone', 'i', day('10-30')),
  row('pt', 'ptrashed', 'i', day('10-29')),
];
const TITLE = { pa: '計画', pb: '週の振り返り', pc: '定例', pa1: '資料', pa2: '論点', pa3: '日程', pa2x: '下書き', pz: '迷子', pt: '残り' };

test('PH-1・BQ5 (a): pageTree の表（最上位は作った新しい順・子は ord の順で同じ鍵は作った古い順・3 段・親が rows に無い行は最上位で orphans に数える・親がゴミ箱の行も最上位）', () => {
  const tree = T.pageTree(ROWS);
  assert.deepStrictEqual(tree.roots, ['pb', 'pc', 'pa', 'pz', 'pt'], '最上位の並び');
  assert.deepStrictEqual(kidsOf(tree, 'pa'), ['pa2', 'pa3', 'pa1'], '子の並び（ord の順・同じ鍵は作った古い順）');
  assert.deepStrictEqual(kidsOf(tree, 'pa2'), ['pa2x'], '3 段目');
  assert.deepStrictEqual(kidsOf(tree, 'pb'), []);
  assert.strictEqual(tree.orphans, 2, '親が rows に無い行の数');
  assert.strictEqual(tree.parent.get('pa2x'), 'pa2');
  assert.strictEqual(tree.parent.get('pz'), null, '親の無い行の親は null（最上位）');
  assert.strictEqual(tree.parent.get('pa'), null);
  assert.deepStrictEqual([...tree.parent.keys()].sort(), Object.keys(TITLE).sort(), 'どの行も1回ずつ木にある（捨てない）');
  // 空・形の悪い行
  assert.deepStrictEqual(T.pageTree([]).roots, []);
  assert.deepStrictEqual(T.pageTree(null).roots, []);
  assert.deepStrictEqual(T.pageTree([null, { id: 3 }, row('px', null, 'i', day('11-01'))]).roots, ['px']);
});

test('PH-1・F113: 輪のある行でも止まる（A→B→A の輪・自分を親に持つ行 → どれも最上位に1回だけ。descendants・crumbsOf も止まる）', () => {
  const started = Date.now();
  const rows = [
    row('px', 'py', 'i', day('11-01')),
    row('py', 'px', 'i', day('11-02')),
    row('ps', 'ps', 'i', day('11-03')),
    row('pk', 'px', 'i', day('11-04')),   // 輪の行の子（輪ではない）
    row('pn', null, 'i', day('10-01')),
  ];
  const tree = T.pageTree(rows);
  assert.deepStrictEqual(tree.roots, ['ps', 'py', 'px', 'pn'], '輪の行はどれも最上位に1回だけ');
  assert.strictEqual(new Set(tree.roots).size, tree.roots.length);
  assert.strictEqual(tree.orphans, 3, '輪の行の数');
  assert.deepStrictEqual(kidsOf(tree, 'px'), ['pk'], '輪の行の子はそのまま');
  assert.deepStrictEqual(T.descendants(tree, 'px'), ['pk']);
  assert.deepStrictEqual(T.crumbsOf(tree, 'pk'), ['px']);
  // 輪のある木を直に渡しても止まる
  const bad = { roots: ['px'], kids: new Map([['px', ['py']], ['py', ['px']]]), parent: new Map([['px', 'py'], ['py', 'px']]), orphans: 0 };
  assert.deepStrictEqual(T.descendants(bad, 'px'), ['py']);
  assert.deepStrictEqual(T.crumbsOf(bad, 'px'), ['py']);
  assert.strictEqual(T.canMoveUnder(bad, 'pq', 'px'), true);
  assert.deepStrictEqual(T.visibleRows(bad, new Set(['px', 'py'])).map((r) => r.id), ['px', 'py']);
  assert.ok(Date.now() - started < 100, `時間がかかった（${Date.now() - started} ミリ秒）`);
});

test('PH-1: descendants・crumbsOf・canMoveUnder の表（自分を含まない・根から親まで・自分と子孫の下は偽・null（最上位）は真）', () => {
  const tree = T.pageTree(ROWS);
  assert.deepStrictEqual(T.descendants(tree, 'pa'), ['pa2', 'pa2x', 'pa3', 'pa1'], '深さ優先・子の並びの順・自分を含まない');
  assert.deepStrictEqual(T.descendants(tree, 'pb'), []);
  assert.deepStrictEqual(T.descendants(tree, 'pnone'), []);
  assert.deepStrictEqual(T.crumbsOf(tree, 'pa2x'), ['pa', 'pa2'], '根から親まで');
  assert.deepStrictEqual(T.crumbsOf(tree, 'pa'), []);
  assert.deepStrictEqual(T.crumbsOf(tree, 'pz'), [], '親をたどれない行は最上位');
  for (const [id, parentId, want] of [
    ['pa', null, true], ['pa', '', true], ['pa', 'pa', false], ['pa', 'pa2', false], ['pa', 'pa2x', false], ['pa', 'pb', true],
    ['pa2x', 'pa', true], ['pa2', 'pa3', true], ['pa2', 'pa2x', false], ['pa1', 'pa1', false], ['pz', 'pa2x', true],
  ]) {
    assert.strictEqual(T.canMoveUnder(tree, id, parentId), want, `${id} → ${parentId}`);
  }
});

test('PH-1・H5: trashGroup・restoreGroup の表（先にゴミ箱に入れた子は入れない・同じ時刻に入った子孫だけ戻す・間に別の時刻の子があれば、その下は戻さない）', () => {
  const T0 = '2026-11-02T10:00:00.000Z';
  const T1 = '2026-11-03T10:00:00.000Z';
  const live = [
    row('pr', null, 'i', day('11-01')),
    row('pc1', 'pr', 'b', day('11-01')),
    row('pg1', 'pc1', 'i', day('11-01')),
    row('pc2', 'pr', 'c', day('11-01'), T0),   // 先に消した子
    row('pg2', 'pc2', 'i', day('11-01'), T0),
    row('pc3', 'pr', 'd', day('11-01')),
    row('po', null, 'i', day('11-01')),
  ];
  assert.deepStrictEqual(T.trashGroup(live, 'pr'), ['pr', 'pc1', 'pg1', 'pc3'], 'もうゴミ箱にある子とその下は入れない');
  assert.deepStrictEqual(T.trashGroup(live, 'pc1'), ['pc1', 'pg1']);
  assert.deepStrictEqual(T.trashGroup(live, 'po'), ['po']);
  assert.deepStrictEqual(T.trashGroup(live, 'pnone'), [], '無いページは空');
  // 親を T1 で消した後。別の時刻の子 pc2 の下に、同じ T1 の行 pg3 がある（壊れた行）
  const gone = new Set(['pr', 'pc1', 'pg1', 'pc3']);
  const after = [...live.map((r) => (gone.has(r.id) ? { ...r, trashedAt: T1 } : r)), row('pg3', 'pc2', 'm', day('11-01'), T1)];
  assert.deepStrictEqual(T.restoreGroup(after, 'pr'), ['pr', 'pc1', 'pg1', 'pc3'], '同じ時刻の子孫だけ・別の時刻の子の下は戻さない');
  assert.deepStrictEqual(T.restoreGroup(after, 'pc1'), ['pc1', 'pg1']);
  assert.deepStrictEqual(T.restoreGroup(after, 'pc2'), ['pc2', 'pg2'], '先に消したまとまりは、その時刻の子孫');
  assert.deepStrictEqual(T.restoreGroup(after, 'po'), ['po'], 'ゴミ箱に無いページは自分だけ');
  assert.deepStrictEqual(T.restoreGroup(after, 'pnone'), []);
});

test('PH-1: visibleRows（閉じた行の子は出さない・depth・hasKids・開いた行の中の閉じた行）', () => {
  const tree = T.pageTree(ROWS);
  const ids = (open) => T.visibleRows(tree, new Set(open)).map((r) => `${r.id}:${r.depth}`);
  assert.deepStrictEqual(ids([]), ['pb:0', 'pc:0', 'pa:0', 'pz:0', 'pt:0'], '閉じた行の子は出さない');
  assert.deepStrictEqual(ids(['pa']), ['pb:0', 'pc:0', 'pa:0', 'pa2:1', 'pa3:1', 'pa1:1', 'pz:0', 'pt:0'], '開いた行の中の閉じた行');
  assert.deepStrictEqual(ids(['pa', 'pa2']), ['pb:0', 'pc:0', 'pa:0', 'pa2:1', 'pa2x:2', 'pa3:1', 'pa1:1', 'pz:0', 'pt:0']);
  assert.deepStrictEqual(ids(['pa2']), ['pb:0', 'pc:0', 'pa:0', 'pz:0', 'pt:0'], '閉じた親の下の開いた行は出さない');
  const rows = T.visibleRows(tree, new Set(['pa']));
  assert.deepStrictEqual(rows.find((r) => r.id === 'pa'), { id: 'pa', depth: 0, hasKids: true, open: true });
  assert.deepStrictEqual(rows.find((r) => r.id === 'pa2'), { id: 'pa2', depth: 1, hasKids: true, open: false });
  assert.deepStrictEqual(rows.find((r) => r.id === 'pb'), { id: 'pb', depth: 0, hasKids: false, open: false });
  assert.deepStrictEqual(T.visibleRows(tree, null).map((r) => r.id), ['pb', 'pc', 'pa', 'pz', 'pt']);
});

test('PH-1: siblingKey・pageDropSpot の表（後ろ・頭・末尾の鍵が兄弟の鍵の間に入る・真ん中は中へ・上下の4分の1は前後・自分と子孫の上は null）', () => {
  const rows = [row('pp', null, 'i', day('11-01')), row('pk1', 'pp', 'b', day('11-01')), row('pk2', 'pp', 'd', day('11-01')), row('pk3', 'pp', 'f', day('11-01'))];
  const tree = T.pageTree(rows);
  const ords = new Map(rows.map((r) => [r.id, r.ord]));
  const mid = T.siblingKey(tree, ords, 'pp', 'pk1');
  assert.ok(mid > 'b' && mid < 'd', `pk1 の後ろ（${mid}）`);
  const mid2 = T.siblingKey(tree, ords, 'pp', 'pk2');
  assert.ok(mid2 > 'd' && mid2 < 'f', `pk2 の後ろ（${mid2}）`);
  const head = T.siblingKey(tree, ords, 'pp', '');
  assert.ok(head < 'b' && head > '', `頭（${head}）`);
  const tail = T.siblingKey(tree, ords, 'pp', undefined);
  assert.ok(tail > 'f', `末尾（${tail}）`);
  assert.ok(T.siblingKey(tree, ords, 'pp', 'pk3') > 'f', '最後の子の後ろは末尾');
  assert.ok(T.siblingKey(tree, ords, 'pp', 'pother') > 'f', '兄弟でない ID は末尾');
  assert.strictEqual(T.siblingKey(tree, ords, null, 'pp'), T.TOP_ORD, '最上位は鍵で並べない');
  assert.strictEqual(T.TOP_ORD, 'i');
  assert.ok(/^[0-9a-z]*[1-9a-z]$/.test(T.siblingKey(tree, ords, 'pk1', undefined)), '子の無い親の鍵');
  // 同じ鍵の兄弟（壊れた行）の間でも投げない
  const tie = [row('pq', null, 'i', day('11-01')), row('pt1', 'pq', 'm', day('11-01')), row('pt2', 'pq', 'm', day('11-02'))];
  assert.ok(T.siblingKey(T.pageTree(tie), new Map(tie.map((r) => [r.id, r.ord])), 'pq', 'pt1') > 'm');

  // 落とす所（見えている行: pb pc pa pa2 pa3 pa1 pz pt。行の高さ 28）
  const t2 = T.pageTree(ROWS);
  const vis = T.visibleRows(t2, new Set(['pa']));
  const at = (id) => vis.findIndex((r) => r.id === id);
  const H = 28;
  assert.deepStrictEqual(T.pageDropSpot(vis, at('pa'), 14, H, 'pb', t2), { parentId: 'pa', afterId: undefined }, '真ん中は中へ');
  assert.deepStrictEqual(T.pageDropSpot(vis, at('pa3'), 25, H, 'pb', t2), { parentId: 'pa', afterId: 'pa3' }, '下の4分の1は後ろ');
  assert.deepStrictEqual(T.pageDropSpot(vis, at('pa3'), 2, H, 'pb', t2), { parentId: 'pa', afterId: 'pa2' }, '上の4分の1は前');
  assert.deepStrictEqual(T.pageDropSpot(vis, at('pa2'), 2, H, 'pb', t2), { parentId: 'pa', afterId: '' }, '最初の兄弟の前は頭');
  assert.deepStrictEqual(T.pageDropSpot(vis, at('pa1'), 2, H, 'pa3', t2), { parentId: 'pa', afterId: 'pa2' }, '前の兄弟が自分なら、その前の兄弟');
  assert.deepStrictEqual(T.pageDropSpot(vis, at('pc'), 26, H, 'pa2', t2), { parentId: null, afterId: 'pc' }, '最上位の行の後ろ');
  assert.strictEqual(T.pageDropSpot(vis, at('pa'), 14, H, 'pa', t2), null, '自分の上');
  for (const y of [2, 14, 26]) {
    assert.strictEqual(T.pageDropSpot(vis, at('pa2'), y, H, 'pa', t2), null, `子孫の上（${y}）`);
    assert.strictEqual(T.pageDropSpot(vis, at('pa3'), y, H, 'pa', t2), null, `子孫の上（${y}）`);
  }
  assert.strictEqual(T.pageDropSpot(vis, 99, 14, H, 'pb', t2), null, '行の無い所');
});

test('PH-1: placeText（根から親まで「親 / 子」・最上位は空・max 段を越えたら近い段の前に「…」）', () => {
  const tree = T.pageTree(ROWS);
  const titleOf = (id) => TITLE[id];
  assert.strictEqual(T.placeText(tree, titleOf, 'pa2x'), '計画 / 論点');
  assert.strictEqual(T.placeText(tree, titleOf, 'pa1'), '計画');
  assert.strictEqual(T.placeText(tree, titleOf, 'pa'), '');
  const chain = Array.from({ length: 8 }, (_, i) => row(`pd${i}`, i ? `pd${i - 1}` : null, 'i', day('11-01')));
  const t2 = T.pageTree(chain);
  assert.strictEqual(T.placeText(t2, (id) => id.toUpperCase(), 'pd7'), '… / PD2 / PD3 / PD4 / PD5 / PD6');
  assert.strictEqual(T.placeText(t2, (id) => id.toUpperCase(), 'pd7', 2), '… / PD5 / PD6');
});

test('PH-1・F115: 5,000 ページ・深さ 1,000 の木の pageTree と descendants が 100 ミリ秒以内（3 回の中央値）', () => {
  const rows = [];
  for (let i = 0; i < 1000; i++) rows.push(row(`pc${i}`, i ? `pc${i - 1}` : null, 'i', `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`));
  for (let i = 0; i < 4000; i++) rows.push(row(`pf${i}`, null, 'i', `2026-09-01T00:00:00.${String(i % 1000).padStart(3, '0')}Z`));
  const times = [];
  let got = null;
  for (let n = 0; n < 3; n++) {
    const t0 = process.hrtime.bigint();
    const tree = T.pageTree(rows);
    got = T.descendants(tree, 'pc0');
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  assert.strictEqual(got.length, 999);
  assert.strictEqual(got[998], 'pc999');
  times.sort((a, b) => a - b);
  assert.ok(times[1] < 100, `中央値 ${times[1].toFixed(1)} ミリ秒`);
  assert.strictEqual(T.trashGroup(rows, 'pc0').length, 1000, '深い木でも子孫を全部');
});

test('PH-1・F118: winstate の tree.open（形の悪い ID・重なり・501 個目は落とす・repaired に tree・ほかの項目は残る・applyUi の tree も同じ照らし）', () => {
  const D1 = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  const good = (o = {}) => ({ v: 1, bounds: { x: 100, y: 80, width: 1200, height: 800 }, maximized: false, zoom: 1.25, sidebar: { width: 300, collapsed: false },
    tabs: { open: ['page:pa1'], active: 'page:pa1' }, slashRecent: ['h2'], tree: { open: ['pa1', 'pb2'] }, ...o });
  assert.deepStrictEqual(W.defaults().tree, { open: [] });
  assert.strictEqual(W.TREE_MAX, 500);
  assert.deepStrictEqual(W.normalize(good(), D1), { state: good(), repaired: [] }, '正しい値はそのまま');
  const { tree: _t, ...noTree } = good();
  void _t;
  assert.deepStrictEqual(W.normalize(noTree, D1), { state: { ...good(), tree: { open: [] } }, repaired: [] }, '無ければ既定（直したことにしない）');
  for (const [v, want] of [
    [{ open: ['pa1', 'pa1', 'PA2', 'x', `p${'a'.repeat(41)}`, 3, null, 'page:pa3', 'pb2', 'p'] }, ['pa1', 'pb2']],
    [{ open: 'pa1' }, []], ['pa1', []], [null, []], [[], []], [{}, []], [{ open: ['pa1'], extra: 1 }, ['pa1']],
    // PH-3 直し（R28 (2)）で意図して変えた: 501 個目からは、古い（先の）方を落として新しい 500 個を残す（開いた順に並ぶので、新しく開いた行を覚え続ける）
    [{ open: Array.from({ length: 501 }, (_, i) => `p${i}`) }, Array.from({ length: 500 }, (_, i) => `p${i + 1}`)],
  ]) {
    const r = W.normalize(good({ tree: v }), D1);
    assert.deepStrictEqual(r.state.tree, { open: want }, JSON.stringify(v).slice(0, 80));
    assert.deepStrictEqual(r.repaired, ['tree'], JSON.stringify(v).slice(0, 80));
    assert.deepStrictEqual({ ...r.state, tree: null }, { ...good(), tree: null }, 'ほかの項目が変わった');
  }
  const many = Array.from({ length: 500 }, (_, i) => `p${i}`);
  assert.deepStrictEqual(W.normalize(good({ tree: { open: many } }), D1).repaired, [], '500 個ちょうどは直さない');
  // applyUi（画面から来た値）も同じ照らし。tree を送らなければ今のまま
  assert.deepStrictEqual(W.applyUi(good(), { tree: { open: ['pc3', 'pc3', 'bad', 'page:pa1'] } }).tree, { open: ['pc3'] });
  assert.deepStrictEqual(W.applyUi(good(), { tree: { open: [...many, 'p999'] } }).tree.open.length, 500);
  assert.deepStrictEqual(W.applyUi(good(), { tree: { open: [...many, 'p999'] } }).tree.open.slice(-2), ['p499', 'p999'], '501 個目に開いた行を落とした');
  assert.deepStrictEqual(W.applyUi(good(), { tree: { open: [...many, 'p999'] } }).tree.open[0], 'p1', 'いちばん古い行を落とさない');
  assert.deepStrictEqual(W.applyUi(good(), { sidebar: { width: 320 } }).tree, { open: ['pa1', 'pb2'] }, '別の項目を送ると開け閉めが消えた');
  assert.deepStrictEqual(W.applyUi(good(), { tree: 'x' }).tree, { open: ['pa1', 'pb2'] }, '形の悪い値で今の開け閉めを消した');
  assert.deepStrictEqual(W.applyUi(W.defaults(), { tree: { open: ['pa1'] } }).tree, { open: ['pa1'] });
});

// ---------------------------------------------------------------- 0.15.0 PH-1 直し（2026-11-03 の点検。計画の R11・R15）
test('PH-1 直し・R11: trashGroup・restoreGroup は作った木を受け、同じ答え。5,000 ページで頭 300 個の restoreGroup が 100 ミリ秒以内（木を1回だけ作る）', () => {
  const T0 = '2026-11-02T10:00:00.000Z';
  const rows = [];
  for (let i = 0; i < 5000; i++) {
    const parent = i % 10 === 0 ? null : `pq${i - (i % 10)}`;
    rows.push(row(`pq${i}`, parent, `k${i % 10 || 1}`, `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z`, i < 3000 ? T0 : undefined));
  }
  const tree = T.pageTree(rows);
  assert.deepStrictEqual(T.restoreGroup(rows, 'pq10', tree), T.restoreGroup(rows, 'pq10'));
  assert.deepStrictEqual(T.trashGroup(rows, 'pq4000', tree), T.trashGroup(rows, 'pq4000'));
  assert.strictEqual(T.restoreGroup(rows, 'pq10', tree).length, 10);
  const times = [];
  for (let n = 0; n < 3; n++) {
    const t0 = process.hrtime.bigint();
    const t = T.pageTree(rows);
    for (let h = 0; h < 300; h++) T.restoreGroup(rows, `pq${h * 10}`, t);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[1] < 100, `中央値 ${times[1].toFixed(1)} ミリ秒`);
});

test('PH-1 直し・R15: placeKeys は同じ鍵の兄弟（壊れた行）の間にも入れる（後ろの同じ鍵の兄弟は入れるページの後ろへ鍵を付け直す）。siblingKey は placeKeys の ord', () => {
  const rows = [row('pp', null, 'i', day('11-01')), row('pk1', 'pp', 'm', day('11-01')), row('pk2', 'pp', 'm', day('11-02')), row('pk4', 'pp', 'q', day('11-03'))];
  const tree = T.pageTree(rows);
  const ords = new Map(rows.map((r) => [r.id, r.ord]));
  const p = T.placeKeys(tree, ords, 'pp', 'pk1');
  assert.deepStrictEqual(p.rekey.map(([id]) => id), ['pk2'], '同じ鍵の後ろの兄弟を付け直さない');
  assert.ok(p.ord > 'm' && p.rekey[0][1] > p.ord && p.rekey[0][1] < 'q', JSON.stringify(p));
  // 当てた後の並びは pk1・入れたページ・pk2・pk4
  const after = [...rows, row('pk3', 'pp', p.ord, day('11-04'))].map((r) => (r.id === 'pk2' ? { ...r, ord: p.rekey[0][1] } : r));
  assert.deepStrictEqual(T.pageTree(after).kids.get('pp'), ['pk1', 'pk3', 'pk2', 'pk4']);
  assert.strictEqual(T.siblingKey(tree, ords, 'pp', 'pk1'), p.ord);
  // 鍵の違う兄弟の間・頭・末尾・最上位は付け直さない
  for (const after2 of ['pk2', '', undefined, 'pk4']) assert.deepStrictEqual(T.placeKeys(tree, ords, 'pp', after2).rekey, [], String(after2));
  assert.deepStrictEqual(T.placeKeys(tree, ords, null, 'pk1'), { ord: T.TOP_ORD, rekey: [] });
});
