/*
 * stage150.db.test.js — 0.15.0「ページの階層」の DB の命令（計画 docs/plans/2026-11-03-150.md の Task PH-2）
 * 白紙のページを作る（page.create）・動かす（page.move: 自分と子孫の下へは動かせない・録音中のページは動かせない）・子ごとゴミ箱へ（page.delete）・
 * 一緒に戻す（page.restore）・ゴミ箱の頭（pages.trash）・一覧の行の親と並び（pages.list の parentId・ord・kind・icon）・録音の守り・書き戻しとのぶつかり・
 * 表の形の版を上げない・控えに oplog を当て直すと同じ表（T4b）・preload の名前。一時の DB（helpers/dbtmp）。題名は作った物で、実在の人名・社名は使わない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sqlite = require('node:sqlite');
const { tmpDb, jsonTwin, samplePage } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const C = require('../src/db/commands');
const schema = require('../src/db/schema');
const { applyOps } = require('../src/db/ops');
const { UNDO_CMDS } = require('../src/undoBook');

let clock = Date.parse('2026-11-03T01:00:00.000Z');
const now = () => new Date(clock);
const tick = () => { clock += 60000; return new Date(clock).toISOString(); };
let n = 0;
const txOf = (role) => `${role[0]}:ph2-${String(++n).padStart(6, '0')}`;
const call = (db, cmd, args, role = 'app', tx = txOf(role)) => ({ ...core.call(db, { role, cmd, args, tx }, { now, labels: {} }), tx });
const T = { timeout: 10000 };
const rowOf = (db, id) => db.prepare('select id, parent_id, ord, rev, trashed_at, attrs from blocks where id = ?').get(id);
const oplogN = (db) => db.prepare('select count(*) as c from oplog').get().c;
const listIds = (db) => call(db, 'pages.list', {}).result.map((p) => p.id);
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dump = (c) => [
  c.prepare('select id, type, page_id, parent_id, ord, text, rich, attrs, fold, rev, created_at, updated_at, trashed_at from blocks order by id').all(),
  c.prepare('select page_id, id, n, at_ms, duration_ms, text, fold, failed, extra from segments order by page_id, id').all(),
].map((list) => list.map((r) => ({ ...r })));

// 見本の議事録（行の ID はどのページでも別にする: blocks の id は表の中で1つ）
function pageOf(id, patch = {}) {
  const { page, segments } = samplePage(id);
  page.blocks = page.blocks.map((b) => ({ ...b, id: `${id}${b.id}` }));
  return { page: { ...page, ...patch }, segments };
}
// 議事録 pa1・pa2・pa3（作った時刻を違える）
function withDb(fn) {
  const t = tmpDb();
  try {
    const { db } = t.open();
    for (const [i, id] of ['pa1', 'pa2', 'pa3'].entries()) {
      const { page, segments } = pageOf(id, { title: `会議${i + 1}`, createdAt: `2026-10-2${i}T00:00:00.000Z` });   // 利用者が付け直した題名（D77）
      t.seed(page, segments);
    }
    return fn(db, t);
  } finally { t.done(); }
}
const create = (db, parentId) => { tick(); const r = call(db, 'page.create', parentId ? { parentId } : {}); assert.strictEqual(r.ok, true, `page.create ${r.code}`); return r.result.id; };
const move = (db, id, parentId, afterId) => call(db, 'page.move', { id, parentId: parentId || '', ...(afterId === undefined ? {} : { afterId }) });
// 一覧の行から作った木の子の並び（画面と同じ部品）
const kidsInList = (db, id) => require('../src/pageTree').pageTree(call(db, 'pages.list', {}).result).kids.get(id) || [];

test('PH-2・H4・F118: page.create（最上位と子に作れる・kind blank・ID はタブの鍵の形・子は兄弟の末尾・同じ tx の送り直しは同じ ID・親が無い・ゴミ箱・録音中の写しなら bad-args・役 main は forbidden）', T, () => withDb((db) => {
  const before = oplogN(db);
  tick();
  const r = call(db, 'page.create', {});
  assert.strictEqual(r.ok, true, r.code);
  assert.match(r.result.id, /^p[a-z0-9]{1,40}$/, 'タブの鍵の形でない');
  assert.ok(/^page:p[a-z0-9]{1,40}$/.test(`page:${r.result.id}`));
  const p = r.result.page;
  assert.deepStrictEqual([p.id, p.kind, p.title, p.memo, p.blocks, p.date], [r.result.id, 'blank', '', '', [], localDay(now())]);
  assert.strictEqual(p.createdAt, now().toISOString());
  assert.deepStrictEqual([rowOf(db, p.id).parent_id, rowOf(db, p.id).ord], [null, 'i'], '最上位は parent_id が NULL・鍵は i');
  assert.strictEqual(oplogN(db), before + 1, 'oplog は1行');
  const ops = JSON.parse(db.prepare('select ops from oplog where tx = ?').get(r.tx).ops);
  assert.deepStrictEqual(ops.map((o) => [o.op, o.id]), [['add', p.id]]);
  assert.deepStrictEqual(r.changed && r.changed.pageIds, [p.id]);
  // 子は兄弟の末尾（鍵の順）
  const k1 = create(db, 'pa1');
  const k2 = create(db, 'pa1');
  const k3 = create(db, k1);
  assert.strictEqual(rowOf(db, k1).parent_id, 'pa1');
  assert.ok(rowOf(db, k2).ord > rowOf(db, k1).ord, '2つ目の子が末尾でない');
  assert.strictEqual(rowOf(db, k3).parent_id, k1, '白紙のページの中にも作れる');
  assert.deepStrictEqual(kidsInList(db, 'pa1'), [k1, k2]);
  assert.notStrictEqual(k1, k2, '同じ ID');
  // 同じ tx の送り直しは同じ ID（新しいページを作らない）
  const tx = txOf('app');
  const a = call(db, 'page.create', { parentId: 'pa2' }, 'app', tx);
  const b = call(db, 'page.create', { parentId: 'pa2' }, 'app', tx);
  assert.strictEqual(b.dup, true);
  assert.strictEqual(b.result.id, a.result.id);
  assert.strictEqual(b.result.page.id, a.result.id);
  assert.deepStrictEqual(kidsInList(db, 'pa2'), [a.result.id], '送り直しで2つ作った');
  // 親が無い・ゴミ箱・録音中の写し・役 main
  const n0 = oplogN(db);
  assert.strictEqual(call(db, 'page.create', { parentId: 'pnone' }).code, 'bad-args');
  call(db, 'page.delete', { id: 'pa3' });
  const n1 = oplogN(db);
  assert.strictEqual(call(db, 'page.create', { parentId: 'pa3' }).code, 'bad-args', 'ゴミ箱のページの中に作れた');
  assert.strictEqual(call(db, 'meeting.begin', { pageId: 'plive1', startedAt: clock }, 'main').ok, true);
  const n2 = oplogN(db);
  assert.strictEqual(call(db, 'page.create', { parentId: 'plive1' }).code, 'bad-args', '録音中の写しの中に作れた');
  assert.strictEqual(oplogN(db), n2, '断った命令が書いた');
  assert.strictEqual(n1, n0 + 1);
  assert.strictEqual(call(db, 'page.create', {}, 'main').code, 'forbidden', '役 main が作れた');
}));

test('PH-2・H2・F113: page.move（子へ・最上位へ（parent_id が NULL）・兄弟の前後（afterId）・自分と子孫の下は bad-args（何も変わらない）・同じ所は操作の空の行で答えに changed が無い・動かしたページの rev だけが上がる）', T, () => withDb((db) => {
  const rev = (id) => rowOf(db, id).rev;
  const [r1, r2] = [rev('pa1'), rev('pa2')];
  tick();
  const m = move(db, 'pa2', 'pa1');
  assert.strictEqual(m.ok, true, m.code);
  assert.strictEqual(rowOf(db, 'pa2').parent_id, 'pa1');
  assert.deepStrictEqual([rev('pa1'), rev('pa2')], [r1, r2 + 1], '動かしたページの rev だけが上がる');
  assert.deepStrictEqual(m.result.map((e) => e.id), listIds(db), '答えは一覧');
  assert.strictEqual(m.result.find((e) => e.id === 'pa2').parentId, 'pa1');
  assert.deepStrictEqual(m.changed && m.changed.pageIds, ['pa2']);
  // 最上位へ
  const top = move(db, 'pa2', '');
  assert.strictEqual(top.ok, true, top.code);
  assert.strictEqual(rowOf(db, 'pa2').parent_id, null, '最上位へ動かしても parent_id が NULL にならない');
  assert.strictEqual(rowOf(db, 'pa2').ord, 'i');
  // 兄弟の前後
  const c1 = create(db, 'pa1'); const c2 = create(db, 'pa1'); const c3 = create(db, 'pa1');
  assert.deepStrictEqual(kidsInList(db, 'pa1'), [c1, c2, c3]);
  assert.strictEqual(move(db, c3, 'pa1', c1).ok, true);
  assert.deepStrictEqual(kidsInList(db, 'pa1'), [c1, c3, c2], 'afterId の後ろ');
  assert.strictEqual(move(db, c2, 'pa1', '').ok, true);
  assert.deepStrictEqual(kidsInList(db, 'pa1'), [c2, c1, c3], "'' は頭");
  assert.strictEqual(move(db, 'pa3', 'pa1', c1).ok, true);
  assert.deepStrictEqual(kidsInList(db, 'pa1'), [c2, c1, 'pa3', c3], '別の親から兄弟の間へ');
  // 自分と子孫の下は bad-args（何も変わらない）
  const g = create(db, c1);
  const snap = dump(db); const ops0 = oplogN(db);
  for (const [id, to] of [['pa1', 'pa1'], ['pa1', c1], ['pa1', g], [c1, g], [c1, c1]]) {
    assert.strictEqual(move(db, id, to).code, 'bad-args', `${id} → ${to}`);
  }
  assert.deepStrictEqual(dump(db), snap, '断った移動が表を変えた');
  assert.strictEqual(oplogN(db), ops0);
  // 無いページ・ゴミ箱のページの下
  assert.strictEqual(move(db, 'pnone', 'pa1').code, 'bad-args');
  assert.strictEqual(move(db, c1, 'pnone').code, 'bad-args');
  call(db, 'page.delete', { id: 'pa2' });
  assert.strictEqual(move(db, c1, 'pa2').code, 'bad-args', 'ゴミ箱のページの下へ動かせた');
  assert.strictEqual(move(db, 'pa2', 'pa1').code, 'bad-args', 'ゴミ箱のページを動かせた');
  // 同じ所は操作の空の行（changed が無い・rev も更新の時刻も変えない）
  const before = rowOf(db, c3);
  const upd = db.prepare('select updated_at from blocks where id = ?').get(c3).updated_at;
  for (const [id, to, after] of [[c3, 'pa1', undefined], [c2, 'pa1', ''], [c1, 'pa1', c2], [c1, 'pa1', c1], ['pa3', 'pa1', c1], ['pa1', '', undefined], ['pa1', '', 'pa3']]) {
    const s = move(db, id, to, after);
    assert.strictEqual(s.ok, true, `${id} ${s.code}`);
    assert.strictEqual(s.changed, undefined, `同じ所への移動（${id}）が changed を返した`);
    assert.deepStrictEqual(JSON.parse(db.prepare('select ops from oplog where tx = ?').get(s.tx).ops), [], '同じ所への移動が操作を書いた');
  }
  assert.deepStrictEqual(rowOf(db, c3), before);
  assert.strictEqual(db.prepare('select updated_at from blocks where id = ?').get(c3).updated_at, upd);
  assert.deepStrictEqual(kidsInList(db, 'pa1'), [c2, c1, 'pa3', c3]);
  // 役 main は動かせない・戻せない
  assert.strictEqual(call(db, 'page.move', { id: c3, parentId: '' }, 'main').code, 'forbidden');
  assert.strictEqual(call(db, 'page.restore', { id: 'pa2' }, 'main').code, 'forbidden');
  assert.strictEqual(call(db, 'pages.trash', {}, 'main').code, 'forbidden');
}));

test('PH-2・F114: 録音の守り（録音中の写しを動かす・その下に作る・その下へ動かす → bad-args。meeting.discard は子の行を最上位へ出してから消し、purge の印は今と同じ）', T, () => withDb((db, t) => {
  assert.strictEqual(call(db, 'meeting.begin', { pageId: 'plive1', startedAt: clock }, 'main').ok, true);
  const snap = dump(db);
  assert.strictEqual(move(db, 'plive1', 'pa1').code, 'bad-args', '録音中の写しを動かせた');
  assert.strictEqual(move(db, 'plive1', '').code, 'bad-args', '録音中の写しを動かせた');
  assert.strictEqual(call(db, 'page.create', { parentId: 'plive1' }).code, 'bad-args', '録音中の写しの下に作れた');
  assert.strictEqual(move(db, 'pa1', 'plive1').code, 'bad-args', '録音中の写しの下へ動かせた');
  assert.deepStrictEqual(dump(db), snap);
  // 種で作った子（普通の流れでは起きない: 決めたこと 9。前の版・壊れた行）
  t.seed(pageOf('pk1', { title: '子の議事録' }).page, []);   // 利用者が付け直した題名（D77）
  db.prepare("update blocks set parent_id = 'plive1', ord = 'm' where id = 'pk1'").run();
  const d = call(db, 'meeting.discard', { pageId: 'plive1' }, 'main');
  assert.strictEqual(d.ok, true, d.code);
  assert.strictEqual(db.prepare("select count(*) c from blocks where page_id = 'plive1'").get().c, 0, '写しが残った');
  assert.ok(rowOf(db, 'pk1'), '子のページが消えた');
  assert.strictEqual(rowOf(db, 'pk1').parent_id, null, '子が消えた親を指したまま（迷子）');
  assert.strictEqual(C.isPurged(db, 'plive1'), true, 'purge の印が無い');
  const ops = JSON.parse(db.prepare('select ops from oplog where tx = ?').get(d.tx).ops);
  assert.deepStrictEqual(ops.map((o) => o.op), ['move', 'purge'], '子を出してから消す');
  assert.ok(listIds(db).includes('pk1'));
}));

test('PH-2・F114: 書き戻しと動かす（main が読む → app が page.move → main の page.put は conflict → 読み直した page.put は書け、親はそのまま。meeting.recover（締め済み）と page.setType も親を変えない）', T, () => withDb((db) => {
  const p = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
  assert.strictEqual(move(db, 'pa1', 'pa2').ok, true);
  const put = call(db, 'page.put', { page: { ...p, title: '要約の題' }, baseRev: p.rev }, 'main');   // 利用者が付け直した題名（D77）
  assert.strictEqual(put.code, 'conflict', '動かした後の古い写しで上書きした');
  const p2 = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
  const put2 = call(db, 'page.put', { page: { ...p2, title: '要約の題' }, baseRev: p2.rev }, 'main');   // 利用者が付け直した題名（D77）
  assert.strictEqual(put2.ok, true, put2.code);
  assert.strictEqual(rowOf(db, 'pa1').parent_id, 'pa2', '書き戻しで親が変わった');
  assert.strictEqual(call(db, 'page.setType', { id: 'pa1', type: 'oneonone' }).ok, true);
  assert.strictEqual(rowOf(db, 'pa1').parent_id, 'pa2', '種類の変更で親が変わった');
  const rec = call(db, 'meeting.recover', { pageId: 'pa1', page: { title: '復旧の題', blocks: [] }, segments: [{ id: 's9', atMs: 90000, durationMs: 1000, text: '足した発言' }] }, 'main');   // 利用者が付け直した題名（D77）
  assert.strictEqual(rec.ok, true, rec.code);
  assert.strictEqual(rowOf(db, 'pa1').parent_id, 'pa2', '復旧で親が変わった');
  const ord = rowOf(db, 'pa1').ord;
  assert.strictEqual(call(db, 'page.setTitle', { id: 'pa1', title: '直した題' }).ok, true);   // 利用者が付け直した題名（D77）
  assert.deepStrictEqual([rowOf(db, 'pa1').parent_id, rowOf(db, 'pa1').ord], ['pa2', ord]);
}));

test('PH-2・H5・F113: page.delete と page.restore（親を消すと子孫の全部が同じ trashed_at・oplog は1行・一覧に無い。先に消した孫の時刻は変わらない。親を戻すと一緒に消した子孫だけ戻る。子だけを戻すと最上位に出る）', T, () => withDb((db) => {
  const c1 = create(db, 'pa1'); const g1 = create(db, c1); const g2 = create(db, c1); const c2 = create(db, 'pa1');
  const t0 = tick();
  assert.strictEqual(call(db, 'page.delete', { id: g2 }).ok, true);
  assert.strictEqual(rowOf(db, g2).trashed_at, t0);
  const t1 = tick();
  const before = oplogN(db);
  const d = call(db, 'page.delete', { id: 'pa1' });
  assert.strictEqual(d.ok, true, d.code);
  assert.strictEqual(oplogN(db), before + 1, 'oplog は1行');
  for (const id of ['pa1', c1, g1, c2]) assert.strictEqual(rowOf(db, id).trashed_at, t1, `${id} がゴミ箱に入っていない・時刻が違う`);
  assert.strictEqual(rowOf(db, g2).trashed_at, t0, '先に消した孫の時刻を書き換えた');
  const listed = d.result.map((e) => e.id);
  for (const id of ['pa1', c1, g1, c2, g2]) assert.ok(!listed.includes(id), `${id} が一覧に残った`);
  assert.deepStrictEqual(listIds(db), listed);
  // 親を戻す → 一緒に消した子孫だけ
  tick();
  const r = call(db, 'page.restore', { id: 'pa1' });
  assert.strictEqual(r.ok, true, r.code);
  for (const id of ['pa1', c1, g1, c2]) assert.strictEqual(rowOf(db, id).trashed_at, null, `${id} が戻らない`);
  assert.strictEqual(rowOf(db, g2).trashed_at, t0, '先に消した孫まで戻した');
  assert.strictEqual(rowOf(db, 'pa1').parent_id, null);
  assert.strictEqual(rowOf(db, c1).parent_id, 'pa1', '戻した子の親が変わった');
  assert.ok(r.result.some((e) => e.id === g1));
  // 子だけを戻す（親はゴミ箱のまま）→ 子は最上位に出る（子と一緒に消した孫も戻る）
  const t2 = tick();
  call(db, 'page.delete', { id: 'pa1' });
  assert.strictEqual(rowOf(db, c1).trashed_at, t2);
  tick();
  const rc = call(db, 'page.restore', { id: c1 });
  assert.strictEqual(rc.ok, true, rc.code);
  assert.deepStrictEqual([rowOf(db, c1).trashed_at, rowOf(db, c1).parent_id], [null, null], '親がゴミ箱のままの子が最上位に出ない');
  assert.strictEqual(rowOf(db, g1).trashed_at, null, '子と一緒に消した孫が戻らない');
  assert.strictEqual(rowOf(db, g1).parent_id, c1);
  assert.strictEqual(rowOf(db, 'pa1').trashed_at, t2, '親まで戻した');
  assert.ok(listIds(db).includes(c1) && listIds(db).includes(g1));
  const ops = JSON.parse(db.prepare('select ops from oplog where tx = ?').get(rc.tx).ops);
  assert.ok(ops.some((o) => o.op === 'move' && o.id === c1 && o.parent === null && o.oldParent === 'pa1'), '最上位へ出す操作が無い');
  // 親の無い子を戻しても最上位
  db.prepare(`update blocks set parent_id = 'pgone', trashed_at = ? where id = ?`).run(t2, c2);
  assert.strictEqual(call(db, 'page.restore', { id: c2 }).ok, true);
  assert.deepStrictEqual([rowOf(db, c2).trashed_at, rowOf(db, c2).parent_id], [null, null]);
  // ゴミ箱に無いページを戻すのは何もしない。無いページは bad-args
  const s = call(db, 'page.restore', { id: 'pa2' });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.changed, undefined);
  assert.strictEqual(call(db, 'page.restore', { id: 'pnone' }).code, 'bad-args');
}));

// 0.15.0 最後の点検の直し（R80・2026-11-06 の a3f0925..707ad1e の点検 rv35 の Important）: 0.7.0〜0.14.0 の page.delete はページの行の trashed_at を書くだけ
// （ops の trash の1つ）だった。その形で消した議事録も、0.15.0 の［ゴミ箱］に並び、戻せる（持ち主の答え「そのまま並べ、変更の記録とヘルプにはっきり書く（おすすめ）」。
// 偶然でなく決めた動き）
test('R80: 0.14.0 までの形で消した議事録（ページの行の trashed_at だけ）も pages.trash に頭として並び（中のページ 0）、page.restore で一覧に戻る', T, () => withDb((db) => {
  const at = '2026-10-30T01:00:00.000Z';
  db.prepare('update blocks set trashed_at = ? where id = ?').run(at, 'pa2');   // 0.14.0 の page.delete と同じ: ページの行だけ
  assert.ok(!listOf(db).some((p) => p.id === 'pa2'), '前提: 前の版で消した議事録は一覧に出ない');
  const r = call(db, 'pages.trash', {});
  assert.strictEqual(r.ok, true, r.code);
  assert.deepStrictEqual(r.result.map((x) => [x.id, x.title, x.trashedAt, x.count]), [['pa2', '会議2', at, 0]], '前の版で消した議事録がゴミ箱に並ばない');
  ok(call(db, 'page.restore', { id: 'pa2' }), 'page.restore');
  assert.ok(listOf(db).some((p) => p.id === 'pa2'), '戻しても一覧に出ない');
  assert.deepStrictEqual(call(db, 'pages.trash', {}).result, []);
}));

test('PH-2・F121: pages.trash（一緒に消したまとまりの頭だけ・count・消した新しい順・200 まで）', T, () => withDb((db) => {
  const c1 = create(db, 'pa1'); create(db, c1); create(db, 'pa1');
  const lone = create(db, 'pa2');
  tick(); call(db, 'page.delete', { id: lone });
  tick(); call(db, 'page.delete', { id: 'pa1' });
  const r = call(db, 'pages.trash', {});
  assert.strictEqual(r.ok, true, r.code);
  assert.deepStrictEqual(r.result.map((x) => [x.id, x.count]), [['pa1', 3], [lone, 0]], '頭だけ・消した新しい順・中のページの数');
  assert.deepStrictEqual(Object.keys(r.result[0]).sort(), ['count', 'id', 'title', 'trashedAt']);
  assert.strictEqual(r.result[0].title, '会議1');
  assert.deepStrictEqual(Object.keys(r.result[1]).sort(), ['count', 'id', 'kind', 'title', 'trashedAt']);
  assert.strictEqual(r.result[1].kind, 'blank');
  assert.strictEqual(r.result[1].trashedAt < r.result[0].trashedAt, true);
  const n0 = oplogN(db);
  call(db, 'pages.trash', {});
  assert.strictEqual(oplogN(db), n0, '読む命令が oplog を書いた');
  // 戻すと頭から消える。200 まで
  call(db, 'page.restore', { id: 'pa1' });
  assert.deepStrictEqual(call(db, 'pages.trash', {}).result.map((x) => x.id), [lone]);
  for (let i = 0; i < 201; i++) { const id = create(db); tick(); call(db, 'page.delete', { id }); }
  const many = call(db, 'pages.trash', {}).result;
  assert.strictEqual(many.length, 200);
  assert.ok(many.every((x, i) => i === 0 || x.trashedAt <= many[i - 1].trashedAt), '新しい順');
  assert.ok(!many.some((x) => x.id === lone), '古いものから外れる');
}));

test('PH-2・H6・P5: 表の形の版は 1 のまま・STEPS は1段だけ', T, () => {
  assert.strictEqual(core.SCHEMA_VERSION, 1);
  assert.deepStrictEqual(Object.keys(schema.STEPS), ['1']);
});

test('PH-2: T4b: 控えに後の oplog（page.move の最上位へ・page.delete・page.restore を含む）を前へ当て直すと今の表と同じ', T, async () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    for (const id of ['pa1', 'pa2']) t.seed(pageOf(id).page, pageOf(id).segments);
    const to = path.join(t.dir, 'copy-150.db');
    await sqlite.backup(db, to);
    const copy = new sqlite.DatabaseSync(to);
    try {
      const k = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
      const c1 = create(db, 'pa1'); create(db, c1); const top = create(db);
      assert.strictEqual(move(db, 'pa2', 'pa1').ok, true);
      assert.strictEqual(move(db, 'pa2', 'pa1', '').ok, true);
      assert.strictEqual(move(db, top, c1).ok, true);
      assert.strictEqual(move(db, 'pa2', '').ok, true);
      tick(); assert.strictEqual(call(db, 'page.delete', { id: 'pa1' }).ok, true);
      tick(); assert.strictEqual(call(db, 'page.restore', { id: c1 }).ok, true);
      tick(); assert.strictEqual(call(db, 'page.restore', { id: 'pa1' }).ok, true);
      const rows = db.prepare('select ops from oplog where seq > ? order by seq').all(k).map((r) => JSON.parse(r.ops));
      assert.ok(rows.flat().some((o) => o.op === 'move' && o.parent === null), '最上位への move の操作が無い');
      for (const o of rows) applyOps(copy, o, 'forward');
      assert.strictEqual(rowOf(copy, 'pa2').parent_id, null);
      assert.strictEqual(rowOf(copy, c1).parent_id, null, '子だけ戻した子が最上位でない');
      assert.deepStrictEqual(dump(copy), dump(db));
      // 後ろへ当てると、控えを取ったときの表に戻る（最上位から前の親へも）
      for (const o of [...rows].reverse()) applyOps(copy, o, 'backward');
      assert.deepStrictEqual(copy.prepare("select count(*) c from blocks where type = 'page'").get().c, 2);
      assert.strictEqual(rowOf(copy, 'pa2').parent_id, null);
    } finally { copy.close(); }
  } finally { t.done(); }
});

test('PH-2・F118: pages.list の行に parentId・ord・kind・icon（検索（問いあり）の答えも同じ欄・覚えた1行を使っても動かした後の parentId が今の値・json-backend の行は parentId: null・ord: i）', T, async () => withDb(async (db, t) => {
  const b = create(db, 'pa1');
  t.seed(pageOf('pi1', { title: '印の会議', icon: '📌' }).page, []);   // 利用者が付け直した題名（D77）
  const list = call(db, 'pages.list', {}).result;
  const at = (id, l = list) => l.find((e) => e.id === id);
  assert.deepStrictEqual([at('pa1').parentId, at('pa1').ord], [null, 'i']);
  assert.deepStrictEqual([at(b).parentId, at(b).kind], ['pa1', 'blank']);
  assert.strictEqual(at(b).ord, rowOf(db, b).ord, '子の並びの鍵');
  assert.ok(!('kind' in at('pa1')), '議事録に kind を付けた');
  assert.ok(!('icon' in at('pa1')), 'アイコンの無いページに icon を付けた');
  assert.strictEqual(at('pi1').icon, '📌');
  // 検索の答えも同じ欄
  const q = call(db, 'pages.list', { q: '会議' }).result;
  assert.ok(q.length >= 2);
  for (const e of q) { assert.ok(Object.hasOwn(e, 'parentId') && typeof e.ord === 'string', e.id); }
  // 覚えた1行を使っても、動かした後の parentId が今の値（一覧の木の欄は覚えた1行の外で、読んだ行から添える: 決めたこと 17）
  call(db, 'pages.list', {});
  assert.strictEqual(move(db, b, 'pa2').ok, true);
  assert.strictEqual(at(b, call(db, 'pages.list', {}).result).parentId, 'pa2');
  assert.strictEqual(at(b, call(db, 'pages.list', { q: '' }).result).parentId, 'pa2');
  db.prepare("update blocks set parent_id = 'pa3', ord = 'k' where id = ?").run(b);   // rev を変えずに親だけ変わった行（覚えた1行の鍵は同じ）
  const again = at(b, call(db, 'pages.list', {}).result);
  assert.deepStrictEqual([again.parentId, again.ord], ['pa3', 'k'], '覚えた1行の古い親を返した');
  // json-backend の行
  const j = jsonTwin();
  try {
    const { page, segments } = samplePage('pj1');
    await j.seed(page, segments);
    const rows = await j.call('pages.list', {});
    assert.deepStrictEqual(rows.map((e) => [e.id, e.parentId, e.ord]), [['pj1', null, 'i']]);
    const rq = await j.call('pages.list', { q: '予算' });
    assert.deepStrictEqual(rq.map((e) => [e.id, e.parentId, e.ord]), [['pj1', null, 'i']]);
  } finally { j.done(); }
}));

const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
function loadPreload() {
  const exposed = {}; const on = {}; let uuid = 0;
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } },
    ipcRenderer: { on: (ch, fn) => { on[ch] = fn; }, invoke: async () => ({}), send: () => {} } };
  const sandbox = { require: (m) => { if (m !== 'electron') throw new Error(`sandbox で ${m} を読んだ`); return electron; },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` }, setTimeout, clearTimeout, console, Promise };
  vm.runInNewContext(PRELOAD, sandbox);
  const port = () => { const p = new EventTarget(); p.sent = []; p.postMessage = (m) => p.sent.push(structuredClone(m)); p.start = () => {};
    p.reply = (id, b) => { const ev = new Event('message'); ev.data = { id, ...b }; (p.onmessage || (() => {}))(ev); }; return p; };
  const givePort = () => { const p = port(); on['db:port']({ ports: [p] }); return p; };
  return { k: exposed.koeApp, givePort };
}

// 0.15.0 PL-2 で意図して直した: page.setIcon・page.setLook を足して 35（ページの命令は UNDO_CMDS に無い: 決めたこと 15）
// 0.16.0 DS-3（計画 docs/plans/2026-11-04-160.md の「意図して変えるテスト」）で意図して直した: データベース・行・列・ビューの 22 の命令を足して 57（照らしは同じ）
// 0.16.0 DV-2（計画 docs/plans/2026-11-04-160.md の「意図して変えるテスト」・R63）で意図して直した: 種類を変える前に数を見る読む命令 col.typeCheck を足して 58（照らしは同じ）
// 0.16.0 DR-1（計画 docs/plans/2026-11-04-160.md の「意図して変えるテスト」・R99）で意図して直した: リレーションとサブアイテムの命令 rel.link・rel.unlink・db.setSub・rel.find を足して 62（照らしは今の役 app の命令と同じ集まり）
// 0.16.0 DL-1 (1)（計画 docs/plans/2026-11-04-160.md の「意図して変えるテスト」・R105・R111）で意図して直した: リンクドビューの行を置く block.insertDbView とデータベースの題名 db.setTitle を足して 64（照らしは今の役 app の命令と同じ集まり）
test('PH-2: preload の 58 の名前・pageMove の引数（afterId が無ければ送らない）・UNDO_CMDS にページの命令が無い', T, async () => {
  const names = [.../const APP_COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(PRELOAD)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  // 0.17.0 PD-1（計画 docs/plans/2026-11-13-170.md の「意図して変えるテスト」）で意図して直した: 空の白紙のページをデータベースにする page.toDb を足して 65（照らしは同じ）
  assert.strictEqual(names.length, 65);
  assert.deepStrictEqual(names.sort(), Object.keys(core.COMMANDS).filter((k) => core.COMMANDS[k].roles.includes('app')).sort());
  for (const cmd of ['page.create', 'page.move', 'page.restore', 'pages.trash']) assert.deepStrictEqual(core.COMMANDS[cmd].roles, ['app'], cmd);
  assert.strictEqual(core.COMMANDS['pages.trash'].write, false);
  const reads = [.../const DB_READS = new Set\(\[([^\]]*)\]\)/.exec(PRELOAD)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.ok(reads.includes('pages.trash'), 'pages.trash が読む命令でない');
  const undo = [.../const UNDO_CMDS = new Set\(\[([^\]]*)\]\)/.exec(PRELOAD)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  for (const cmd of ['page.create', 'page.move', 'page.restore', 'page.delete', 'pages.trash', 'page.setIcon', 'page.setLook']) {
    assert.ok(!UNDO_CMDS.has(cmd), `UNDO_CMDS に ${cmd}`);
    assert.ok(!undo.includes(cmd), `preload の UNDO_CMDS に ${cmd}`);
  }
  const { k, givePort } = loadPreload();
  const p = givePort();
  k.pageCreate(); k.pageCreate('pa1');
  k.pageMove('pb1', 'pa1'); k.pageMove('pb1', ''); k.pageMove('pb1', null); k.pageMove('pb1', 'pa1', ''); k.pageMove('pb1', 'pa1', 'pc1');
  k.pageRestore('pb1'); k.pagesTrash();
  assert.deepStrictEqual(p.sent.map((m) => [m.cmd, m.args]), [
    ['page.create', {}], ['page.create', { parentId: 'pa1' }],
    ['page.move', { id: 'pb1', parentId: 'pa1' }], ['page.move', { id: 'pb1', parentId: '' }], ['page.move', { id: 'pb1', parentId: '' }],
    ['page.move', { id: 'pb1', parentId: 'pa1', afterId: '' }], ['page.move', { id: 'pb1', parentId: 'pa1', afterId: 'pc1' }],
    ['page.restore', { id: 'pb1' }], ['pages.trash', {}],
  ]);
  for (const m of p.sent.slice(0, 8)) assert.match(m.tx, /^a:[0-9a-f-]{36}$/, `${m.cmd} に tx が無い`);
  assert.strictEqual(p.sent[8].tx, undefined, '読む頼みに tx を付けた');
});

// ---------------------------------------------------------------- 0.15.0 PH-2 直し（2026-11-03 の点検。計画の R11〜R18）
const PF = require('../tools/perf');
test('PH-2 直し・R12: 木を歩くページの行は attrs の全部を読まない（HOT_QUERIES.pageRows の attrs は json_extract の中だけ。メモと要約を読み込まない）', T, () => {
  const sql = C.HOT_QUERIES.pageRows;
  assert.ok(!/\battrs\b/.test(sql.replace(/json_extract\(attrs, '\$\.[a-z.]+'\)/g, '')), sql);
  assert.match(sql, /json_extract\(attrs, '\$\.meeting\.phase'\)/);
});

test('PH-2 直し・R11・R12: 5,000 ページ（1KB のメモ・1,000 段の子孫）で pages.trash（頭 300）・page.move・子孫 1,000 の page.delete・page.restore が目安以内（3 回の中央値。pages.trash は一覧の目安。書く命令は答えの一覧を作る分（同じ時に計った pages.list）を除いて、1 ページは一覧の目安・子孫 1,000 は一覧の目安の 2 倍: R22）', { timeout: 120000 }, async (tc) => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const memo = 'メモ'.repeat(500);
    db.exec('BEGIN');
    const ins = db.prepare("insert into blocks(id,type,page_id,parent_id,ord,text,rich,attrs,fold,rev,created_at,updated_at,trashed_at) values (?,?,?,?,?,?,null,?,'',1,?,?,null)");
    const pid = (i) => `pp${String(i).padStart(5, '0')}`;
    for (let i = 0; i < 5000; i++) {
      ins.run(pid(i), 'page', pid(i), i > 0 && i <= 1000 ? pid(i - 1) : null, 'i', `題${i}`, JSON.stringify({ memo, date: '2026-10-01', meeting: { phase: 'done' } }),
        new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), '');
    }
    db.exec('COMMIT');
    call(db, 'pages.list', {});   // 一覧の1行を覚える（画面が開いた後の形）
    const budget = PF.budgetsFor(process.platform);
    const timed = (f) => { const t0 = process.hrtime.bigint(); const r = f(); return [Number(process.hrtime.bigint() - t0) / 1e6, r]; };
    // PH-8 直し（rv31。R70）で意図して変えた: 前は命令ごとに「命令の時間 − すぐ前の pages.list の時間」を3回取って中央値にしていた（差を取るたびに
    // 一覧の揺れが2倍になり、負の値も出た）。今は命令の時間と、命令の前と後に計った pages.list の時間を別の並びに持ち、中央値どうしの差で決める
    const listMs = () => timed(() => call(db, 'pages.list', {}))[0];
    // PL-2 直し（R75・rv33 M1）: 名前ごとに、計る命令を作る関数（計る前に呼ぶ）。動かす先は今の親でない方（pp00500 と pp00600）を表から決める
    const WRITES = [
      ['page.move', () => { const to = rowOf(db, 'pp04000').parent_id === 'pp00500' ? 'pp00600' : 'pp00500'; return () => move(db, 'pp04000', to); }],
      ['page.delete（子孫 1,000）', () => () => call(db, 'page.delete', { id: 'pp00000' })],
      ['page.restore（1,000 ページ）', () => () => call(db, 'page.restore', { id: 'pp00000' })],
      ['page.delete（1 ページ）', () => () => call(db, 'page.delete', { id: 'pp03000' })],
      ['page.restore（1 ページ）', () => () => call(db, 'page.restore', { id: 'pp03000' })],
    ];
    // 3回の組（命令は今と同じ並び: 動かす → 子孫ごと消す → 戻す → 1ページ消す → 戻す）→ { 名前: 中央値(命令) − 中央値(前後の一覧) }
    // PL-1・PH-8 直し 2（rv32。R73）: 前は動かす先を組ごとに k で決めていたので、計り直しの組の最初の move がもういる所への同じ所（何も書かない）になり、
    // 中央値を下へずらしていた。PL-2 直し（R75・rv33 M1）で意図して変えた: R73 の組をまたいだ交互（動かした数）は、はじめの組だけでは崩しても
    // 赤にならなかった（計り直しの組でだけ同じ所になる）ので、動かす先を今の親から決め、動かすたびに親が替わったのを照らす（どの組でも同じに効く）
    const writeRound = () => {
      const cmd = new Map(WRITES.map(([n]) => [n, []]));
      const lists = new Map(WRITES.map(([n]) => [n, []]));
      for (let k = 0; k < 3; k++) {
        for (const [n, make] of WRITES) {
          tick();
          lists.get(n).push(listMs());
          const parent0 = rowOf(db, 'pp04000').parent_id;
          const [ms, r] = timed(make());
          assert.strictEqual(r.ok, true, `${n}: ${r.code}`);
          assert.ok(opsOf(db, r.tx).length > 0, `${n}: 計った命令が何も書かなかった（同じ所への動かしは速さを測れない）`);
          if (n === 'page.move') assert.notStrictEqual(rowOf(db, 'pp04000').parent_id, parent0, '動かしで親が替わらなかった');
          cmd.get(n).push(ms);
          lists.get(n).push(listMs());
        }
      }
      return Object.fromEntries(WRITES.map(([n]) => [n, PF.median(cmd.get(n)) - PF.median(lists.get(n))]));
    };
    const first = writeRound();
    assert.strictEqual(db.prepare("select count(*) c from blocks where type = 'page' and trashed_at is null").get().c, 5000);
    // 頭 300 のゴミ箱（消した時刻を1つずつ違える）は SQL で作る（命令で消すと、答えの一覧を 300 回作る）
    const trashAt = db.prepare('update blocks set trashed_at = ? where id = ?');
    db.exec('BEGIN');
    for (let i = 2000; i < 2300; i++) trashAt.run(new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(), pid(i));
    db.exec('COMMIT');
    const trashRound = () => {
      const xs = [];
      for (let k = 0; k < 3; k++) { const [x, xr] = timed(() => call(db, 'pages.trash', {})); assert.strictEqual(xr.result.length, 200); xs.push(x); }
      return PF.median(xs);
    };
    // R22: 一覧を引いた値は一覧の速さの揺れ（CI の台で ±50 ミリ秒ほど）を含むので、1 ページの命令は一覧の目安、子孫 1,000 の書き込み（台の書き込みの
    // 速さで決まる）は一覧の目安の 2 倍（Windows は CI で計った中央値の 2 倍の 800: R21。tools/perf.js の BUDGETS_WIN と同じ考え）。
    // メモを読まないこと（R12）は上の SQL の試験が、木を1回だけ作ること（R11）は pages.trash の目安が見る（直す前は 927 ミリ秒）
    const write = budget.list;
    const big = process.platform === 'win32' ? 800 : budget.list * 2;
    const BUDGET = { 'pages.trash': budget.list, 'page.move': write, 'page.delete（1 ページ）': write, 'page.delete（子孫 1,000）': big, 'page.restore（1 ページ）': write, 'page.restore（1,000 ページ）': big };
    const firstAll = { 'pages.trash': trashRound(), ...first };
    // 目安を越えた名前だけ、3回の組をもう2回まるごと計り直し、はじめと合わせた3回の中央値で決める（RF59・PG1 の PF.recheck と同じ決まり。目安の値は変えない）
    const judged = Object.entries(BUDGET).map(([name, b]) => ({ name, ms: Number(firstAll[name].toFixed(2)), budget: b, ok: firstAll[name] < b }));
    // PL-1・PH-8 直し 2（rv32。R73）: 計り直しの2回の組は、越えた名前のどれもが同じ組を読む（越えた名前ごとに組をまるごと計り直すと、6つとも越えたときに
    // 2 × 6 回の組で 100 秒を越え、テストの時間切れで赤になって計り直しの値も残らなかった）。はじめの値は計り直しの前に出す
    tc.diagnostic(`はじめ: ${judged.map((x) => `${x.name} ${x.ms.toFixed(1)}${x.ok ? '' : '（越えた）'}`).join('・')} ミリ秒`);
    const extra = [];
    const seen = new Map();
    const againRound = (i) => {
      if (!extra[i]) extra[i] = { 'pages.trash': trashRound(), ...writeRound() };
      return extra[i];
    };
    const logs = [];
    const out = await PF.recheck(judged, async (name) => {
      const i = seen.get(name) || 0;
      seen.set(name, i + 1);
      return Number(againRound(i)[name].toFixed(2));
    }, { rounds: 2, log: (l) => logs.push(l) });
    tc.diagnostic(`${out.map((x) => `${x.name} ${x.ms.toFixed(1)}${x.tries ? `（${x.tries.join('・')}）` : ''}`).join('・')} ミリ秒（書く命令は中央値(命令) − 中央値(前後の一覧)）${logs.length ? `。${logs.join('。')}` : ''}`);
    for (const x of out) assert.ok(x.ok, `${x.name} ${x.ms.toFixed(1)} ミリ秒（目安 ${x.budget}${x.tries ? `・計り直し ${x.tries.join('・')}` : ''}）`);
  } finally { t.done(); }
});

test('PH-2 直し・R13: 前の版・壊れた行の輪（pa↔pb）があっても、動かして輪を大きくしない（pb を pa の子 pc の下へ動かすのは bad-args）', T, () => withDb((db) => {
  db.prepare("update blocks set parent_id = 'pa2' where id = 'pa1'").run();
  db.prepare("update blocks set parent_id = 'pa1', ord = 'm' where id = 'pa2'").run();
  db.prepare("update blocks set parent_id = 'pa1', ord = 'n' where id = 'pa3'").run();
  const snap = dump(db);
  assert.strictEqual(move(db, 'pa2', 'pa3').code, 'bad-args', '輪の上の親をたどって自分に戻る所へ動かせた');
  assert.deepStrictEqual(dump(db), snap);
  assert.strictEqual(move(db, 'pa3', '').ok, true, '輪の外へは動かせる');
  assert.strictEqual(move(db, 'pa2', '').ok, true, '輪の行を最上位へ出して直せる');
  assert.strictEqual(rowOf(db, 'pa2').parent_id, null);
}));

test('PH-2 直し・R14: 輪のまま同じ時刻でゴミ箱に入った行（壊れた行）も、ゴミ箱の頭に出て戻せる', T, () => withDb((db) => {
  const at = '2026-11-01T00:00:00.000Z';
  db.prepare("update blocks set parent_id = 'pa3', trashed_at = ? where id = 'pa2'").run(at);
  db.prepare("update blocks set parent_id = 'pa2', trashed_at = ? where id = 'pa3'").run(at);
  const heads = call(db, 'pages.trash', {}).result.map((x) => x.id);
  assert.ok(heads.includes('pa2') && heads.includes('pa3'), JSON.stringify(heads));
  assert.strictEqual(call(db, 'page.restore', { id: 'pa2' }).ok, true);
  assert.ok(listIds(db).includes('pa2'));
}));

test('PH-2 直し・R15: 同じ鍵の兄弟（壊れた行）の間へ動かすと、その間に並ぶ（後ろの兄弟の鍵を同じ命令で付け直す）', T, () => withDb((db) => {
  const k1 = create(db, 'pa1'); const k2 = create(db, 'pa1'); const k3 = create(db, 'pa1');
  db.prepare('update blocks set ord = \'m\' where id in (?, ?)').run(k1, k2);
  const m = move(db, k3, 'pa1', k1);
  assert.strictEqual(m.ok, true, m.code);
  assert.deepStrictEqual(kidsInList(db, 'pa1'), [k1, k3, k2]);
  const ops = JSON.parse(db.prepare('select ops from oplog where tx = ?').get(m.tx).ops);
  assert.deepStrictEqual(ops.map((o) => [o.op, o.id, Object.hasOwn(o, 'parent')]), [['move', k3, false], ['move', k2, false]], '1つの命令に積む');
}));

test('PH-2 直し・R16: 同じ所かどうかと兄弟の鍵は、一覧に出る兄弟だけで見る（間のゴミ箱の兄弟を数えない: 決めたこと 16）', T, () => withDb((db) => {
  const k1 = create(db, 'pa1'); const k2 = create(db, 'pa1'); const k3 = create(db, 'pa1');
  tick(); call(db, 'page.delete', { id: k2 });
  const before = rowOf(db, k3);
  const s = move(db, k3, 'pa1', k1);
  assert.strictEqual(s.ok, true, s.code);
  assert.strictEqual(s.changed, undefined, '見えている並びが同じなのに書いた');
  assert.deepStrictEqual(rowOf(db, k3), before);
  // 頭へ（見えている兄弟の頭は k1）
  assert.strictEqual(move(db, k3, 'pa1', '').ok, true);
  assert.deepStrictEqual(kidsInList(db, 'pa1'), [k3, k1]);
}));

test('PH-2 直し・R17: 録音中の写しは戻さない（page.restore は bad-args・一緒に消したまとまりの中の写しは戻さない）。親が録音中の写しなら最上位へ戻す。pages.trash に写しを出さない', T, () => withDb((db) => {
  assert.strictEqual(call(db, 'meeting.begin', { pageId: 'plive3', startedAt: clock }, 'main').ok, true);
  tick();
  assert.strictEqual(call(db, 'page.delete', { id: 'plive3' }).ok, true);
  assert.ok(rowOf(db, 'plive3').trashed_at);
  assert.ok(!call(db, 'pages.trash', {}).result.some((x) => x.id === 'plive3'), 'ゴミ箱に録音中の写しを出した');
  const snap = dump(db);
  assert.strictEqual(call(db, 'page.restore', { id: 'plive3' }).code, 'bad-args', '録音中の写しを戻した');
  assert.deepStrictEqual(dump(db), snap);
  // 親が録音中の写し（壊れた行）のページを戻すと最上位へ
  const c = create(db, 'pa1');
  tick(); call(db, 'page.delete', { id: c });
  db.prepare("update blocks set parent_id = 'plive4' where id = ?").run(c);
  assert.strictEqual(call(db, 'meeting.begin', { pageId: 'plive4', startedAt: clock }, 'main').ok, true);
  assert.strictEqual(call(db, 'page.restore', { id: c }).ok, true);
  assert.deepStrictEqual([rowOf(db, c).trashed_at, rowOf(db, c).parent_id], [null, null], '見えない所（録音中の写しの下）に戻した');
  // 一緒に消したまとまりの中の写し（壊れた行）は戻さない
  const h = create(db, 'pa2');
  db.prepare("update blocks set parent_id = ? where id = 'plive4'").run(h);
  tick(); assert.strictEqual(call(db, 'page.delete', { id: h }).ok, true);
  const at = rowOf(db, h).trashed_at;
  db.prepare('update blocks set trashed_at = ? where id = \'plive4\'').run(at);
  assert.strictEqual(call(db, 'page.restore', { id: h }).ok, true);
  assert.strictEqual(rowOf(db, h).trashed_at, null);
  assert.strictEqual(rowOf(db, 'plive4').trashed_at, at, '録音中の写しを一緒に戻した');
}));

test('PH-2 直し・R17: meeting.discard は、ゴミ箱にある子の行も最上位へ出す（ゴミ箱の時刻はそのまま。戻すと最上位に出る）', T, () => withDb((db) => {
  assert.strictEqual(call(db, 'meeting.begin', { pageId: 'plive5', startedAt: clock }, 'main').ok, true);
  db.prepare("update blocks set parent_id = 'plive5', trashed_at = '2026-11-01T00:00:00.000Z' where id = 'pa3'").run();
  db.prepare("update blocks set parent_id = 'plive5' where id = 'pa2'").run();
  assert.strictEqual(call(db, 'meeting.discard', { pageId: 'plive5' }, 'main').ok, true);
  assert.deepStrictEqual([rowOf(db, 'pa3').parent_id, rowOf(db, 'pa3').trashed_at], [null, '2026-11-01T00:00:00.000Z']);
  assert.strictEqual(rowOf(db, 'pa2').parent_id, null);
  assert.ok(call(db, 'pages.trash', {}).result.some((x) => x.id === 'pa3'));
}));

test('PH-2 直し・R17: 新しいページの ID は、同じ ID のページがあれば作り直す（newPageId の重なりの照らし）', T, () => withDb((db, t) => {
  const fixed = () => new Date('2026-11-03T01:00:00.000Z');
  const a = C.newPageId(db, fixed, () => 7);
  assert.match(a, /^p[a-z0-9]{1,40}$/);
  t.seed(pageOf(a).page, []);
  const seq = [7, 7, 9];
  const b = C.newPageId(db, fixed, () => seq.shift());
  assert.notStrictEqual(b, a, '同じ ID を返した');
  assert.match(b, /^p[a-z0-9]{1,40}$/);
  assert.deepStrictEqual(seq, [], '重なりを見ずに返した');
}));

// ---------------------------------------------------------------- PH-4（決めたこと 24・HR20・R25）
test('PH-4・R25: 白紙のページの本文は要約の鍵を掛けない（空の白紙のページにも行を足せ、直せる）。文字起こしの無い議事録の要約の欄は今どおり鍵（locked）', T, () => withDb((db) => {
  const lib = require('../src/mainlib');
  assert.strictEqual(lib.summaryLock({ kind: 'blank', blocks: [] }, { segments: [] }), '', '空の白紙のページに鍵');
  assert.strictEqual(lib.summaryLock({ kind: 'blank', summaryWait: true }, { segments: [] }), '');
  assert.strictEqual(lib.summaryLock({ blocks: [] }, { segments: [] }), 'empty', '議事録の鍵が変わった');
  const id = create(db);
  const r = call(db, 'block.insert', { pageId: id, afterBlockId: '', type: 'paragraph' });
  assert.strictEqual(r.ok, true, `空の白紙のページに行を足せない: ${r.code}`);
  const u = call(db, 'block.update', { pageId: id, blockId: r.result.blockId, patch: { text: '本文の一行目' } });
  assert.strictEqual(u.ok, true, u.code);
  assert.deepStrictEqual(call(db, 'page.get', { id }).result.page.blocks.map((b) => b.text), ['本文の一行目']);
  // 文字起こしの無い議事録（行の無い要約）は今どおり鍵
  const { page } = pageOf('pz9', { title: '会議9', blocks: [], createdAt: '2026-10-25T00:00:00.000Z' });   // 利用者が付け直した題名（D77）
  delete page.route;   // 要約をまだ作っていない会議
  const t2 = tmpDb();
  try {
    const { db: d2 } = t2.open();
    t2.seed(page, []);
    assert.strictEqual(call(d2, 'block.insert', { pageId: 'pz9', afterBlockId: '', type: 'paragraph' }).code, 'locked');
  } finally { t2.done(); }
}));

test('PH-4・HR20: 白紙のページを足しても、会議の種類の見回り（pages.typeSlots）と要約待ちの見回り（pages.summaryWaits）の答えは変わらない。無題の白紙のページは一覧と検索で「無題のページ」', T, () => withDb((db) => {
  const slots = () => call(db, 'pages.typeSlots', { since: '2000-01-01T00:00:00.000Z' }, 'main').result;
  const waits = () => call(db, 'pages.summaryWaits', {}, 'main').result;
  const before = [slots(), waits()];
  const a = create(db);
  create(db, 'pa1');
  create(db, a);
  assert.deepStrictEqual([slots(), waits()], before, '白紙のページが会議の見回りに入った');
  const e = call(db, 'pages.list', {}).result.find((p) => p.id === a);
  assert.deepStrictEqual([e.title, e.kind], ['無題のページ', 'blank']);
  assert.ok(call(db, 'pages.list', { q: '無題のページ' }).result.some((p) => p.id === a), '検索で「無題のページ」が当たらない');
  call(db, 'page.setTitle', { id: 'pa2', title: '' });
  assert.strictEqual(call(db, 'pages.list', {}).result.find((p) => p.id === 'pa2').title, '(無題の議事録)', '無題の議事録の名前が変わった');
}));

// ---------------------------------------------------------------- 0.15.0 PR-1（決めたこと 43〜60・BQ3・BQ10〜BQ13・HR12〜HR18・F123）: 白紙のページの本文の子ページの行
const O = require('../src/db/ops');
const PT = require('../src/pageTree');
const flat = (list) => (list || []).flatMap((b) => [b, ...flat(b.children)]);
const bodyOf = (db, id) => call(db, 'page.get', { id }).result.page.blocks;
const subsOf = (db, id) => flat(bodyOf(db, id)).filter((b) => b.type === 'subpage').map((b) => b.page);
const subRow = (db, host, id) => flat(bodyOf(db, host)).find((b) => b.type === 'subpage' && b.page === id) || null;
const opsOf = (db, tx) => JSON.parse(db.prepare('select ops from oplog where tx = ?').get(tx).ops);
const trashedAt = (db, id) => rowOf(db, id).trashed_at;
const ok = (r, what) => { assert.strictEqual(r.ok, true, `${what}: ${r.code}`); return r; };
// 白紙のページの本文の子ページの行と、木（parent_id）が食い違っていない（一覧に出る白紙のページの全部で、行の指すページの集まり＝一覧に出る子の集まり）
function sameTree(db) {
  const list = call(db, 'pages.list', {}).result;
  for (const p of list.filter((x) => x.kind === 'blank')) {
    const kids = list.filter((x) => x.parentId === p.id).map((x) => x.id).sort();
    assert.deepStrictEqual([...subsOf(db, p.id)].sort(), kids, `${p.id} の本文の行と子が食い違う`);
  }
  for (const p of list.filter((x) => x.kind !== 'blank')) assert.deepStrictEqual(subsOf(db, p.id), [], `議事録 ${p.id} の本文に子ページの行`);
}
const insert = (db, pageId, afterBlockId, type = 'paragraph', o = {}) => ok(call(db, 'block.insert', { pageId, afterBlockId, type, ...o }), 'block.insert').result.blockId;

test('PR-1・F123: 作る（白紙のページの中に page.create → 本文の最後に subpage の行・oplog は1行。placeAt の文の無い行は子ページの行に替わり、文のある行ならすぐ下。議事録の中に作ると本文に行が無い: BQ3）', T, () => withDb((db) => {
  const P = create(db);
  const before = oplogN(db);
  tick();
  const r = ok(call(db, 'page.create', { parentId: P }), 'page.create');
  const K1 = r.result.id;
  assert.strictEqual(oplogN(db), before + 1, 'oplog は1行');
  const ops = opsOf(db, r.tx);
  assert.deepStrictEqual(ops.filter((o) => o.op === 'add').map((o) => o.row.type), ['page', 'subpage'], '同じ1行にページと子ページの行が無い');
  const last = bodyOf(db, P).slice(-1)[0];
  assert.deepStrictEqual([last.type, last.text, last.page], ['subpage', '', K1]);
  const raw = rowOf(db, last.id);
  assert.deepStrictEqual(JSON.parse(raw.attrs), { page: K1 }, '子ページの行が文・出典・担当の欄を持つ');
  // placeAt: 文の無いテキストの行は子ページの行に替わる（同じ ID）・文のある行はすぐ下
  const e1 = insert(db, P, last.id);
  const t1 = insert(db, P, e1);
  ok(call(db, 'block.update', { pageId: P, blockId: t1, patch: { text: '本文の行' } }), 'block.update');
  const tail = insert(db, P, t1);
  ok(call(db, 'block.update', { pageId: P, blockId: tail, patch: { text: '最後の行' } }), 'block.update');
  tick();
  const K2 = ok(call(db, 'page.create', { parentId: P, placeAt: e1 }), 'placeAt').result.id;
  const b2 = flat(bodyOf(db, P)).find((b) => b.id === e1);
  assert.deepStrictEqual([b2.type, b2.page, b2.text], ['subpage', K2, ''], '文の無い行が子ページの行に替わらない');
  tick();
  const K3 = ok(call(db, 'page.create', { parentId: P, placeAt: t1 }), 'placeAt').result.id;
  assert.deepStrictEqual(bodyOf(db, P).map((b) => (b.type === 'subpage' ? `@${b.page}` : b.text)), [`@${K1}`, `@${K2}`, '本文の行', `@${K3}`, '最後の行']);
  // 議事録の中には行を作らない
  const K4 = create(db, 'pa1');
  assert.deepStrictEqual(subsOf(db, 'pa1'), []);
  assert.strictEqual(rowOf(db, K4).parent_id, 'pa1');
  sameTree(db);
}));

test('PR-1・F123・HR12: 動かす（白紙 → 白紙は前の本文の行が消えて新しい本文の最後に足される・afterId の兄弟の行のすぐ後ろ・白紙 → 議事録・議事録 → 白紙・最上位へ。どれも oplog は1行で、行と parent_id が食い違わない）', T, () => withDb((db) => {
  const P = create(db); const Q = create(db);
  const K = create(db, P); const K2 = create(db, Q);
  const step = (fn, what) => { const b = oplogN(db); const r = ok(fn(), what); assert.strictEqual(oplogN(db), b + 1, `${what}: oplog は1行`); sameTree(db); return r; };
  step(() => move(db, K, Q), '白紙 → 白紙');
  assert.deepStrictEqual([subsOf(db, P), subsOf(db, Q)], [[], [K2, K]], '前の本文に行が残るか、新しい本文の最後に無い');
  const K3 = create(db, P);
  step(() => move(db, K3, Q, K2), '兄弟の後ろへ');
  assert.deepStrictEqual(subsOf(db, Q), [K2, K3, K], 'afterId の兄弟の行のすぐ後ろに無い');
  assert.deepStrictEqual(kidsInList(db, Q), [K2, K3, K], 'サイドバーの子の並びが本文の行の順でない');
  step(() => move(db, K, Q, ''), '同じ親の頭へ');
  assert.deepStrictEqual(subsOf(db, Q), [K, K2, K3]);
  step(() => move(db, K3, 'pa1'), '白紙 → 議事録');
  assert.deepStrictEqual([subsOf(db, Q), subsOf(db, 'pa1')], [[K, K2], []]);
  step(() => move(db, K3, P), '議事録 → 白紙');
  assert.deepStrictEqual(subsOf(db, P), [K3]);
  step(() => move(db, K3, ''), '最上位へ');
  assert.deepStrictEqual(subsOf(db, P), []);
  // 同じ所は書かない（本文の並びで見る）
  const n0 = oplogN(db);
  const same = move(db, K2, Q, K);
  assert.strictEqual(same.ok, true);
  assert.strictEqual(JSON.parse(db.prepare('select ops from oplog where tx = ?').get(same.tx).ops).length, 0, '同じ所への page.move が書いた');
  assert.strictEqual(oplogN(db), n0 + 1);
}));

test('PR-1・BQ10 (a)・F123: 行を消す（block.remove・blocks.remove で子ページの行を消すと、ページとゴミ箱に入っていない子孫が同じ時刻でゴミ箱・一覧に無い・答えに trashed。先にゴミ箱に入れた孫の時刻は変わらない。今の子でないページを指す行を消してもページはそのまま）', T, () => withDb((db) => {
  const P = create(db);
  const K = create(db, P); const G = create(db, K); const G2 = create(db, K);
  tick();
  ok(call(db, 'page.delete', { id: G2 }), 'page.delete');
  const t0 = trashedAt(db, G2);
  const row = subRow(db, P, K);
  tick();
  const before = oplogN(db);
  const r = ok(call(db, 'block.remove', { pageId: P, blockId: row.id }), 'block.remove');
  assert.strictEqual(oplogN(db), before + 1, 'oplog は1行');
  assert.ok(trashedAt(db, K) && trashedAt(db, K) === trashedAt(db, G), 'ページと子孫が同じ時刻でゴミ箱に入らない');
  assert.strictEqual(trashedAt(db, G2), t0, '先にゴミ箱に入れた孫の時刻が変わった');
  assert.ok(!listIds(db).includes(K) && !listIds(db).includes(G));
  assert.strictEqual(r.result.trashed, 2, '答えにゴミ箱に入れたページの数が無い');
  assert.ok(Array.isArray(r.result.blocks) && r.result.id === P, '答えがページでない');
  sameTree(db);
  // blocks.remove（ほかの行と一緒に）
  const K5 = create(db, P);
  const para = insert(db, P, subRow(db, P, K5).id);
  tick();
  const r2 = ok(call(db, 'blocks.remove', { pageId: P, ids: [subRow(db, P, K5).id, para] }), 'blocks.remove');
  assert.ok(trashedAt(db, K5));
  assert.strictEqual(r2.result.trashed, 1);
  // 子ページの行の無い本文を消す答えは今のまま（trashed を持たない）
  const p2 = insert(db, P, '');
  assert.strictEqual(Object.hasOwn(ok(call(db, 'block.remove', { pageId: P, blockId: p2 }), 'block.remove').result, 'trashed'), false);
  // 今の子でないページ（pa2）を指す行（前の版・壊れた行）を消しても、ページは何もされない
  applyOps(db, [{ op: 'add', id: 'bstale1', row: { ...O.blockRow({ id: 'bstale1', type: 'subpage', text: '', page: 'pa2' }, P, 'zz'), attrs: { page: 'pa2' } } }]);
  ok(call(db, 'block.remove', { pageId: P, blockId: 'bstale1' }), 'block.remove');
  assert.strictEqual(trashedAt(db, 'pa2'), null, '今の子でないページをゴミ箱に入れた');
}));

test('PR-1・BQ12 (a)・F123: 消した行の edit.revert（行もページも子孫も1回で戻る・もう一度戻すとまた消える・間に子孫だけをゴミ箱から戻した後の古い歩みは stale で何も変えない）。invertOps・opsMatch は pageId が無ければ今どおり投げる', T, () => withDb((db) => {
  const P = create(db);
  const K = create(db, P); const G = create(db, K);
  const rowId = subRow(db, P, K).id;
  tick();
  const s1 = ok(call(db, 'block.remove', { pageId: P, blockId: rowId }), 'block.remove');
  const T1 = trashedAt(db, K);
  assert.throws(() => O.invertOps(opsOf(db, s1.tx)), 'pageId の無い invertOps がページの行を戻した');
  assert.throws(() => O.opsMatch(db, opsOf(db, s1.tx)), 'pageId の無い opsMatch がページの行を照らした');
  tick();
  const u1 = ok(call(db, 'edit.revert', { pageId: P, steps: [s1.tx] }), 'edit.revert');
  assert.deepStrictEqual([trashedAt(db, K), trashedAt(db, G)], [null, null], 'ページと子孫が戻らない');
  assert.deepStrictEqual(subsOf(db, P), [K], '行が戻らない');
  assert.ok(listIds(db).includes(K) && listIds(db).includes(G));
  sameTree(db);
  // やり直し（戻した歩みを戻す）
  tick();
  ok(call(db, 'edit.revert', { pageId: P, steps: [u1.tx] }), 'やり直し');
  assert.deepStrictEqual([trashedAt(db, K), trashedAt(db, G)], [T1, T1], 'やり直しでまた消えない');
  assert.deepStrictEqual(subsOf(db, P), []);
  // 間に子孫だけをゴミ箱から戻した（G は最上位に出る）後の古い歩みは stale
  const P2 = create(db);
  const K2 = create(db, P2); const G2 = create(db, K2);
  tick();
  const s2 = ok(call(db, 'block.remove', { pageId: P2, blockId: subRow(db, P2, K2).id }), 'block.remove');
  tick();
  ok(call(db, 'page.restore', { id: G2 }), 'page.restore');
  const was = dump(db);
  tick();
  const u2 = call(db, 'edit.revert', { pageId: P2, steps: [s2.tx] });
  assert.strictEqual(u2.code, 'stale', '後から戻したページを古い歩みで戻した');
  assert.deepStrictEqual(dump(db), was, 'stale なのに何か変えた');
}));

test('PR-1・BQ13 (a)・BQ11 (a)・HR18: 断り（block.duplicate の子ページの行は bad-args・blocks.duplicate は子ページの行を除いて写す・トグルの中の子ページの行も写さない・block.merge（つなぐ先・元）・block.split・block.update・block.turnInto・blocks.turnInto・block.paste（子ページの行へ・subpage の型）・block.insert の subpage は bad-args）', T, () => withDb((db) => {
  const P = create(db);
  const K = create(db, P);
  const row = subRow(db, P, K).id;
  const para = insert(db, P, row);
  ok(call(db, 'block.update', { pageId: P, blockId: para, patch: { text: '下の行' } }), 'block.update');
  const was = dump(db);
  const bad = (cmd, args) => { const r = call(db, cmd, args); assert.strictEqual(r.code, 'bad-args', `${cmd} ${JSON.stringify(args)}: ${r.code}`); };
  bad('block.duplicate', { pageId: P, blockId: row });
  bad('blocks.duplicate', { pageId: P, ids: [row] });
  bad('block.merge', { pageId: P, blockId: row, text: '' });
  bad('block.merge', { pageId: P, blockId: para, text: '下の行' });   // すぐ前（平らにした順）が子ページの行
  bad('block.merge', { pageId: P, blockId: para, text: '下の行', intoId: row });
  bad('block.split', { pageId: P, blockId: row, text: '', at: 0 });
  bad('block.update', { pageId: P, blockId: row, patch: { text: '文' } });   // 決めたこと 59: 前の版の命令
  bad('block.update', { pageId: P, blockId: row, patch: { checked: true } });
  bad('block.update', { pageId: para === row ? P : P, blockId: para, patch: { type: 'subpage' } });
  bad('block.turnInto', { pageId: P, blockId: row, type: 'paragraph' });
  bad('block.turnInto', { pageId: P, blockId: para, type: 'subpage' });
  bad('blocks.turnInto', { pageId: P, ids: [row, para], type: 'bullet' });
  bad('block.paste', { pageId: P, blockId: row, rich: [{ t: '行の文' }], at: 0, blocks: [{ type: 'paragraph', rich: [{ t: '貼った文' }] }] });   // PR-2（R31）で意図して変えた: 子ページの行に文を入れる貼り付けだけを断る
  bad('block.paste', { pageId: P, blockId: para, rich: [{ t: '下の行' }], at: 3, blocks: [{ type: 'subpage', rich: [] }] });
  bad('block.setAction', { pageId: P, blockId: row, assignee: '担当' });   // 決めたこと 43: 担当と期限を持たない
  bad('block.insert', { pageId: P, afterBlockId: para, type: 'subpage' });
  bad('block.insert', { pageId: P, afterBlockId: '', type: 'paragraph', parentId: row });   // 子を持てない
  assert.deepStrictEqual(dump(db), was, '断った命令が何か書いた');
  // PR-2（R31）: 子ページの行の下に貼る（区切り線と同じ: rich が空）と、行はそのまま・貼った行はすぐ下
  const pz = ok(call(db, 'block.paste', { pageId: P, blockId: row, rich: [], at: 0, blocks: [{ type: 'paragraph', rich: [{ t: '貼った文' }] }] }), 'block.paste');
  const order = flat(pz.result.page.blocks).map((b) => (b.type === 'subpage' ? `@${b.page}` : b.text));
  assert.deepStrictEqual(order.slice(order.indexOf(`@${K}`), order.indexOf(`@${K}`) + 2), [`@${K}`, '貼った文'], '子ページの行のすぐ下に貼らない');
  assert.deepStrictEqual(flat(pz.result.page.blocks).find((b) => b.id === row), { id: row, type: 'subpage', text: '', page: K, children: [] });
  // blocks.duplicate はほかの行だけを写す
  const d = ok(call(db, 'blocks.duplicate', { pageId: P, ids: [row, para] }), 'blocks.duplicate');
  assert.strictEqual(d.result.ids.length, 1);
  assert.deepStrictEqual(subsOf(db, P), [K], '同じページを指す行が2つになった');
  // トグルの中の子ページの行も写さない（トグルの写しは子ページの行を除く）
  const tg = insert(db, P, para, 'toggle');
  ok(call(db, 'block.update', { pageId: P, blockId: tg, patch: { text: 'まとめ' } }), 'block.update');
  ok(call(db, 'block.move', { pageId: P, blockId: row, afterId: '', parentId: tg }), 'block.move');
  const d2 = ok(call(db, 'block.duplicate', { pageId: P, blockId: tg }), 'block.duplicate');
  const copy = flat(d2.result.page.blocks).find((b) => b.id === d2.result.blockId);
  assert.deepStrictEqual([copy.type, (copy.children || []).length], ['toggle', 0], 'トグルの写しに子ページの行がある');
  assert.deepStrictEqual(subsOf(db, P), [K]);
  sameTree(db);
}));

test('PR-1・HR15: ほかの所で消す・戻す（サイドバーの page.delete・親ごとの削除で本文の行が同じ命令で消え、子の attrs.rowAt に置き場。戻すと同じ置き場（トグルの中）に・置き場が無くなっていれば本文の最後）', T, () => withDb((db) => {
  const P = create(db);
  const K = create(db, P); const K2 = create(db, P);
  const tg = insert(db, P, '', 'toggle');
  const a1 = insert(db, P, '', 'paragraph', { parentId: tg });
  ok(call(db, 'block.update', { pageId: P, blockId: a1, patch: { text: 'トグルの中の文' } }), 'block.update');
  ok(call(db, 'block.move', { pageId: P, blockId: subRow(db, P, K).id, afterId: a1 }), 'block.move');
  const row = subRow(db, P, K).id;
  tick();
  const before = oplogN(db);
  ok(call(db, 'page.delete', { id: K }), 'page.delete');
  assert.strictEqual(oplogN(db), before + 1);
  assert.deepStrictEqual(subsOf(db, P), [K2], '消したページの行が本文に残る');
  const at = JSON.parse(rowOf(db, K).attrs).rowAt;
  assert.ok(at && at.parent === tg && typeof at.ord === 'string', `置き場を覚えない: ${JSON.stringify(at)}`);
  tick();
  ok(call(db, 'page.restore', { id: K }), 'page.restore');
  const back = flat(bodyOf(db, P)).find((b) => b.id === tg);
  assert.deepStrictEqual(back.children.map((b) => (b.type === 'subpage' ? `@${b.page}` : b.text)), ['トグルの中の文', `@${K}`], '覚えた置き場に戻らない');
  assert.strictEqual(Object.hasOwn(JSON.parse(rowOf(db, K).attrs), 'rowAt'), false, '戻した後も置き場を覚えている');
  void row;
  sameTree(db);
  // 置き場（トグル）が無くなっていれば本文の最後
  tick();
  ok(call(db, 'page.delete', { id: K }), 'page.delete');
  ok(call(db, 'block.remove', { pageId: P, blockId: tg }), 'block.remove');
  tick();
  ok(call(db, 'page.restore', { id: K }), 'page.restore');
  assert.deepStrictEqual(bodyOf(db, P).slice(-1)[0].page, K, '置き場が無いのに本文の最後に戻らない');
  sameTree(db);
  // 親ごとの削除（白紙の PP の中の P を消す）: PP の本文の P の行が消え、戻すと戻る。P の中の K の行は P と一緒にゴミ箱（そのまま）
  const PP = create(db);
  ok(move(db, P, PP), 'page.move');
  tick();
  ok(call(db, 'page.delete', { id: P }), 'page.delete');
  assert.deepStrictEqual(subsOf(db, PP), []);
  tick();
  ok(call(db, 'page.restore', { id: P }), 'page.restore');
  assert.deepStrictEqual([subsOf(db, PP), subsOf(db, P).sort()], [[P], [K, K2].sort()]);
  sameTree(db);
}));

test('PR-1・決めたこと 47・HR14: 一覧の行の ord（白紙のページの子の並びは本文の行の順・トグルの中の行も。本文で行を並べ替える（blocks.move）と一覧の並びも替わる。行の無い子は後ろ）', T, () => withDb((db) => {
  const P = create(db);
  const K1 = create(db, P); const K2 = create(db, P); const K3 = create(db, P);
  assert.deepStrictEqual(kidsInList(db, P), [K1, K2, K3]);
  ok(call(db, 'blocks.move', { pageId: P, ids: [subRow(db, P, K3).id], afterId: '' }), 'blocks.move');
  assert.deepStrictEqual(kidsInList(db, P), [K3, K1, K2], '本文で並べ替えても一覧の並びが替わらない');
  const tg = insert(db, P, subRow(db, P, K2).id, 'toggle');
  ok(call(db, 'block.move', { pageId: P, blockId: subRow(db, P, K1).id, afterId: '', parentId: tg }), 'block.move');
  assert.deepStrictEqual(kidsInList(db, P), [K3, K2, K1], 'トグルの中の行の順で並ばない');
  // 前の版で行を消された子（行の無い子）は後ろ
  const lost = subRow(db, P, K3).id;
  db.prepare('delete from blocks where id = ?').run(lost);
  assert.deepStrictEqual(kidsInList(db, P), [K2, K1, K3]);
  // 議事録の子は今どおりページの行の ord の順
  const M1 = create(db, 'pa1'); const M2 = create(db, 'pa1');
  ok(move(db, M2, 'pa1', ''), 'page.move');
  assert.deepStrictEqual(kidsInList(db, 'pa1'), [M2, M1]);
}));

test('PR-1・決めたこと 59: main の page.put に白紙のページが来ても、子ページの行の page の欄はそのまま。edit.revert は今は子ページの行になった行の文を戻さない', T, () => withDb((db) => {
  const P = create(db);
  const K = create(db, P);
  const p = call(db, 'page.get', { id: P }, 'main').result.page;
  ok(call(db, 'page.put', { page: { ...p, title: '書き戻した題' }, baseRev: p.rev }, 'main'), 'page.put');   // 利用者が付け直した題名（D77）
  assert.deepStrictEqual(subsOf(db, P), [K]);
  assert.deepStrictEqual(JSON.parse(rowOf(db, subRow(db, P, K).id).attrs).page, K);
  // /ページ の流れ: 行の文を消して保存（歩み）→ その行を子ページの行に替える → 前の歩みを戻しても子ページの行に文を入れない（stale）
  const e = insert(db, P, '');
  const s = ok(call(db, 'block.update', { pageId: P, blockId: e, patch: { text: '/ぺーじ' } }), 'block.update');
  const s2 = ok(call(db, 'block.update', { pageId: P, blockId: e, patch: { text: '' } }), 'block.update');
  tick();
  ok(call(db, 'page.create', { parentId: P, placeAt: e }), 'page.create');
  assert.strictEqual(call(db, 'edit.revert', { pageId: P, steps: [s2.tx] }).code, 'stale', '子ページの行に文を戻した');
  void s;
  sameTree(db);
}));

test('PR-1: T4b: 控えに後の oplog（行を作る・動かす・消す・戻す・edit.revert を含む）を前へ当て直すと今の表と同じ。後ろへ当てると控えの表', T, async () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    for (const id of ['pa1', 'pa2']) t.seed(pageOf(id).page, pageOf(id).segments);
    const to = path.join(t.dir, 'copy-150r.db');
    await sqlite.backup(db, to);
    const copy = new sqlite.DatabaseSync(to);
    try {
      const k = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
      const before = dump(copy);
      const P = create(db); const Q = create(db);
      const K = create(db, P); create(db, K);
      tick(); ok(call(db, 'page.create', { parentId: P, placeAt: subRow(db, P, K).id }), 'page.create');
      ok(move(db, K, Q), 'page.move'); ok(move(db, K, P), 'page.move'); ok(move(db, K, 'pa1'), 'page.move'); ok(move(db, K, P), 'page.move');
      tick(); const s = ok(call(db, 'block.remove', { pageId: P, blockId: subRow(db, P, K).id }), 'block.remove');
      tick(); ok(call(db, 'edit.revert', { pageId: P, steps: [s.tx] }), 'edit.revert');
      tick(); ok(call(db, 'page.delete', { id: K }), 'page.delete');
      tick(); ok(call(db, 'page.restore', { id: K }), 'page.restore');
      const rows = db.prepare('select ops from oplog where seq > ? order by seq').all(k).map((r) => JSON.parse(r.ops));
      for (const o of rows) applyOps(copy, o, 'forward');
      assert.deepStrictEqual(dump(copy), dump(db));
      for (const o of [...rows].reverse()) applyOps(copy, o, 'backward');
      assert.deepStrictEqual(dump(copy).map((l) => l.map((r) => ({ ...r, rev: 0 }))), before.map((l) => l.map((r) => ({ ...r, rev: 0 }))));
    } finally { copy.close(); }
  } finally { t.done(); }
});

test('PR-1: preload の pageCreate(parentId, placeAt) は placeAt があるときだけ送る（/ページ を打った行）', T, () => {
  const { k, givePort } = loadPreload();
  const p = givePort();
  k.pageCreate(); k.pageCreate('pa1'); k.pageCreate('pa1', 'b1'); k.pageCreate('', 'b1');
  assert.deepStrictEqual(p.sent.map((m) => [m.cmd, m.args]), [
    ['page.create', {}], ['page.create', { parentId: 'pa1' }], ['page.create', { parentId: 'pa1', placeAt: 'b1' }], ['page.create', { placeAt: 'b1' }],
  ]);
});

// ---------------------------------------------------------------- 0.15.0 PR-1 直し（2026-11-03 の 76fb1c4..0828257 の点検。計画の R32〜）
const subsRaw = (db, id) => db.prepare("select json_extract(attrs, '$.page') as page from blocks where page_id = ? and type = 'subpage' order by ord").all(id).map((r) => r.page);

test('PR-1 直し・R32: page.move の操作の old は、本文の順から作った鍵でなく、表に書いてあるページの行の ord（後ろへ当てると表の ord に戻る）', T, () => withDb((db) => {
  const P = create(db); const Q = create(db);
  const K1 = create(db, P); const K2 = create(db, P); const K3 = create(db, P);
  // 本文で K3 の行を頭へ（一覧の並びの鍵は本文の順から作るので、K3 の作った鍵とずれる）
  ok(call(db, 'blocks.move', { pageId: P, ids: [subRow(db, P, K3).id], afterId: '' }), 'blocks.move');
  const stored = rowOf(db, K3).ord;
  const shown = call(db, 'pages.list', {}).result.find((p) => p.id === K3).ord;
  assert.notStrictEqual(shown, stored, '見本が悪い: 一覧の鍵と表の鍵が同じ');
  const r = ok(move(db, K3, Q), 'page.move');
  const op = opsOf(db, r.tx).find((o) => o.op === 'move' && o.id === K3);
  assert.strictEqual(op.old, stored, `move の old が表の ord でない（${op.old}）`);
  applyOps(db, opsOf(db, r.tx), 'backward');
  assert.strictEqual(rowOf(db, K3).ord, stored, '後ろへ当てても表の ord に戻らない');
  void K1; void K2;
}));

test('PR-1 直し・R33（決めたこと 58）: 本文が 2,000 行の白紙のページの中に作る・動かし入れる・戻すと、ページは作る・動かす・戻すが行は足さない（本文は 2,000 行のまま・子は「このページの中のページ」に出る形）。/ページ の文の無い行は替えるので置ける', T, () => withDb((db, t) => {
  const N = 2000;
  const blocks = Array.from({ length: N }, (_, i) => ({ id: `fz${i}`, type: 'paragraph', text: i === N - 1 ? '' : `行${i}` }));
  t.seed({ id: 'pfull', title: '大きな本文', kind: 'blank', date: '2026-11-02', memo: '', blocks, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' }, []);   // 利用者が付けた題名（D77）
  const count = () => db.prepare('select count(*) as c from blocks where page_id = ? and id <> ?').get('pfull', 'pfull').c;
  assert.strictEqual(count(), N);
  // 作る: ページはでき、親は pfull・行は無い
  tick();
  const K = ok(call(db, 'page.create', { parentId: 'pfull' }), 'page.create').result.id;
  assert.strictEqual(rowOf(db, K).parent_id, 'pfull');
  assert.deepStrictEqual([count(), subsRaw(db, 'pfull')], [N, []], '2,000 行の本文に行を足した');
  assert.ok(listIds(db).includes(K), '作ったページが一覧に無い');
  // 動かし入れる: 動かすが行は足さない
  const Q = create(db); const K2 = create(db, Q);
  ok(move(db, K2, 'pfull'), 'page.move');
  assert.deepStrictEqual([rowOf(db, K2).parent_id, count(), subsOf(db, Q)], ['pfull', N, []], '動かし入れて行を足したか、前の親の行が残る');
  // 戻す: 行を1つ空けて作った子を消し、空いた所を埋めてから戻す → 戻るが行は足さない
  const K3 = create(db, Q);
  ok(move(db, K3, 'pfull'), 'page.move');
  ok(call(db, 'block.remove', { pageId: 'pfull', blockId: 'fz0' }), 'block.remove');
  ok(move(db, K3, 'pfull', ''), 'page.move');   // 同じ親の中の並べ替え（兄弟の頭へ。行が無いので本文の最後に置く）→ 1,999 + 1
  assert.deepStrictEqual([count(), subsRaw(db, 'pfull')], [N, [K3]]);
  tick();
  ok(call(db, 'page.delete', { id: K3 }), 'page.delete');
  insert(db, 'pfull', 'fz1');
  assert.strictEqual(count(), N);
  tick();
  ok(call(db, 'page.restore', { id: K3 }), 'page.restore');
  assert.deepStrictEqual([trashedAt(db, K3), rowOf(db, K3).parent_id, count(), subsRaw(db, 'pfull')], [null, 'pfull', N, []], '戻したページが無いか、2,000 行の本文に行を足した');
  // /ページ の文の無い行（fz1999）は子ページの行に替わる（数は変わらない）
  tick();
  const K4 = ok(call(db, 'page.create', { parentId: 'pfull', placeAt: `fz${N - 1}` }), 'page.create').result.id;
  assert.deepStrictEqual([count(), subsRaw(db, 'pfull')], [N, [K4]]);
}));

// 0.15.0 PH-5 直し 2（R56。2026-11-04 の持ち主の答え「0.15.0 の中で直す」・44f4272..148ed34 の点検）: 満杯の本文の白紙のページの行の無い子の並び
test('PH-5 直し 2・R56（R53 を直す）: 本文が 2,000 行の白紙のページの中で、行の無い子どうしの並べ替え・頭へ・外から動かし入れる（afterId なし）が一覧の並びに効く（行のある子の後ろの、行の無い子の中の所）。どれも oplog は1行で、後ろへ当てると表の ord に戻る', T, () => withDb((db, t) => {
  const N = 2000;
  const blocks = Array.from({ length: N - 2 }, (_, i) => ({ id: `fz${i}`, type: 'paragraph', text: `行${i}` }));
  t.seed({ id: 'pfull', title: '大きな本文', kind: 'blank', date: '2026-11-02', memo: '', blocks, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' }, []);   // 利用者が付けた題名（D77）
  const R1 = create(db, 'pfull'); const R2 = create(db, 'pfull');   // 行のある子（本文は 2,000 行になる）
  const K = Array.from({ length: 6 }, () => create(db, 'pfull'));   // 行の無い子（R33）
  assert.deepStrictEqual(subsRaw(db, 'pfull'), [R1, R2], '前提: 行のある子は2つ');
  assert.deepStrictEqual(kidsInList(db, 'pfull'), [R1, R2, ...K], '前提: 行のある子・行の無い子の順');
  const step = (id, parentId, afterId, want, what) => {
    const before = new Map(db.prepare("select id, ord, parent_id from blocks where type = 'page'").all().map((r) => [r.id, [r.ord, r.parent_id]]));
    const n0 = oplogN(db);
    const r = ok(move(db, id, parentId, afterId), `page.move ${what}`);
    assert.strictEqual(oplogN(db), n0 + 1, `${what}: oplog が1行でない`);
    assert.deepStrictEqual(kidsInList(db, 'pfull'), want, what);
    assert.deepStrictEqual(subsRaw(db, 'pfull'), [R1, R2], `${what}: 満杯の本文に行を足した`);
    applyOps(db, opsOf(db, r.tx), 'backward');
    const back = new Map(db.prepare("select id, ord, parent_id from blocks where type = 'page'").all().map((x) => [x.id, [x.ord, x.parent_id]]));
    assert.deepStrictEqual([...back], [...before], `${what}: 後ろへ当てても表の ord・親に戻らない`);
    applyOps(db, opsOf(db, r.tx), 'forward');
    assert.deepStrictEqual(kidsInList(db, 'pfull'), want, `${what}: 前へ当て直すと並びが違う`);
  };
  // (a) 行の無い子どうしの並べ替え（K0 を K1 の後ろへ）
  step(K[0], 'pfull', K[1], [R1, R2, K[1], K[0], K[2], K[3], K[4], K[5]], '行の無い子の並べ替え');
  // (b) 頭へ（''）・行のある兄弟の後ろへ → 行の無い子の頭（行の無い子は行のある子の前へは出られない）
  step(K[5], 'pfull', '', [R1, R2, K[5], K[1], K[0], K[2], K[3], K[4]], '頭へ');
  step(K[4], 'pfull', R1, [R1, R2, K[4], K[5], K[1], K[0], K[2], K[3]], '行のある兄弟の後ろへ');
  // (c) 外のページを afterId なしで動かし入れる（［移動先…］の形）→ 最後
  const Q = create(db);
  step(Q, 'pfull', undefined, [R1, R2, K[4], K[5], K[1], K[0], K[2], K[3], Q], '外から動かし入れる');
  // 最後の子をもう一度最後へは同じ所（書かない）
  const n0 = oplogN(db);
  const same = ok(move(db, Q, 'pfull'), 'page.move 同じ所');
  assert.deepStrictEqual([opsOf(db, same.tx), oplogN(db) - n0], [[], 1], '同じ所に書いた');
}));

test('PH-5 直し 2・R56（M-5・R54）: 本文に行のある子を同じ白紙の親へ afterId なしで動かす（［移動先…］で親だけを選ぶ）と、もう最後の兄弟でも、行は本文の最後へ。行がもう本文の最後なら同じ所（書かない）', T, () => withDb((db) => {
  const P = create(db);
  const K1 = create(db, P); const K2 = create(db, P);
  insert(db, P, subRow(db, P, K2).id);   // K2 の行の後ろにテキストの行
  const tail = () => { const b = bodyOf(db, P); const x = b[b.length - 1]; return x.type === 'subpage' ? `page:${x.page}` : x.type; };
  assert.strictEqual(tail(), 'paragraph', '前提: 本文の最後はテキストの行');
  assert.deepStrictEqual(kidsInList(db, P), [K1, K2], '前提: K2 は最後の兄弟');
  ok(move(db, K2, P), 'page.move');
  assert.strictEqual(tail(), `page:${K2}`, '最後の兄弟の行が本文の最後へ動かない');
  assert.deepStrictEqual(kidsInList(db, P), [K1, K2]);
  const n0 = oplogN(db);
  const r = ok(move(db, K2, P), 'page.move');
  assert.deepStrictEqual([opsOf(db, r.tx), oplogN(db) - n0], [[], 1], '行がもう本文の最後なのに書いた');
}));

// 0.15.0 PH-5 直し 4（2026-11-04 の 148ed34..03abad4 の点検）: 満杯の本文の行の無い子の同じ所・ゴミ箱の兄弟の後ろ・行のある子の表の鍵
test('PH-5 直し 4・R61: 満杯の本文の白紙のページで、行の無い子の今と同じ所への page.move（頭の子を頭へ・前の兄弟の後ろへ・ゴミ箱や録音中の兄弟の後ろで最後の子）は書かない。ゴミ箱・知らない兄弟の後ろは満杯でもそうでなくても末尾', T, () => withDb((db, t) => {
  const N = 2000;
  const blocks = Array.from({ length: N - 1 }, (_, i) => ({ id: `fz${i}`, type: 'paragraph', text: `行${i}` }));
  t.seed({ id: 'pfull', title: '大きな本文', kind: 'blank', date: '2026-11-02', memo: '', blocks, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' }, []);   // 利用者が付けた題名（D77）
  const R1 = create(db, 'pfull');   // 行のある子（本文は 2,000 行になる）
  const K = Array.from({ length: 4 }, () => create(db, 'pfull'));   // 行の無い子
  const T1 = create(db, 'pfull');
  tick(); ok(call(db, 'page.delete', { id: T1 }), 'page.delete');   // ゴミ箱の兄弟
  assert.deepStrictEqual(kidsInList(db, 'pfull'), [R1, ...K], '前提');
  const same = (id, afterId, what) => {
    const n0 = oplogN(db);
    const r = ok(move(db, id, 'pfull', afterId), `page.move ${what}`);
    assert.deepStrictEqual([opsOf(db, r.tx), oplogN(db) - n0], [[], 1], `${what}: 同じ所なのに書いた`);
    assert.deepStrictEqual(kidsInList(db, 'pfull'), [R1, ...K]);
  };
  same(K[0], '', '行の無い子の頭を頭へ');
  same(K[0], R1, '行の無い子の頭を行のある兄弟の後ろへ');
  same(K[2], K[1], '前の兄弟の後ろへ');
  same(K[3], T1, '最後の子をゴミ箱の兄弟の後ろへ（末尾）');
  same(K[3], 'pzzunknown', '最後の子を知らない兄弟の後ろへ（末尾）');
  // ゴミ箱の兄弟の後ろは末尾（満杯）
  ok(move(db, K[0], 'pfull', T1), 'page.move');
  assert.deepStrictEqual(kidsInList(db, 'pfull'), [R1, K[1], K[2], K[3], K[0]], '満杯の本文でゴミ箱の兄弟の後ろが末尾でない');
  // 満杯でない白紙のページでも同じ（末尾）
  const P = create(db); const A = create(db, P); const B = create(db, P); const C = create(db, P); const TT = create(db, P);
  tick(); ok(call(db, 'page.delete', { id: TT }), 'page.delete');
  ok(move(db, A, P, TT), 'page.move');
  assert.deepStrictEqual(kidsInList(db, P), [B, C, A], '満杯でない本文でゴミ箱の兄弟の後ろが末尾でない');
}));

test('PH-5 直し 4・R61: 行のある子の並びの鍵は本文の順から作った鍵の間（行の無い子の鍵の作り方を使わない）。行のある子の今と同じ所への afterId つきの page.move・自分の後ろは、行が本文の最後でなくても書かない', T, () => withDb((db) => {
  const P = create(db);
  const K1 = create(db, P); const K2 = create(db, P); const K3 = create(db, P);
  const shown = new Map(call(db, 'pages.list', {}).result.filter((p) => p.parentId === P).map((p) => [p.id, p.ord]));
  ok(move(db, K3, P, K1), 'page.move');
  const o = rowOf(db, K3).ord;
  assert.ok(o > shown.get(K1) && o < shown.get(K2), `行のある子の表の鍵が本文の順の鍵の間でない（${shown.get(K1)} < ${o} < ${shown.get(K2)}）`);
  assert.deepStrictEqual(kidsInList(db, P), [K1, K3, K2]);
  insert(db, P, subRow(db, P, K2).id);   // K2（最後の兄弟）の行の後ろにテキストの行
  for (const [afterId, what] of [[K3, '前の兄弟の後ろ'], [K2, '自分の後ろ']]) {
    const n0 = oplogN(db);
    const r = ok(move(db, K2, P, afterId), `page.move ${what}`);
    assert.deepStrictEqual([opsOf(db, r.tx), oplogN(db) - n0], [[], 1], `${what}: 同じ所なのに書いた`);
  }
}));

test('PR-1 直し・R34: 親がゴミ箱の白紙のページの子を戻すと、最上位へ出し、同じ命令でゴミ箱の親の本文から行を消す（後で親を戻しても灰色の行が残らない）', T, () => withDb((db) => {
  const P = create(db);
  const K = create(db, P);
  tick();
  ok(call(db, 'page.delete', { id: P }), 'page.delete');   // P と K が同じ時刻でゴミ箱（P の本文の K の行はそのまま）
  assert.deepStrictEqual(subsRaw(db, P), [K]);
  tick();
  const before = oplogN(db);
  ok(call(db, 'page.restore', { id: K }), 'page.restore');
  assert.strictEqual(oplogN(db), before + 1, 'oplog は1行');
  assert.deepStrictEqual([rowOf(db, K).parent_id, trashedAt(db, K)], [null, null], '最上位に戻らない');
  assert.deepStrictEqual(subsRaw(db, P), [], 'ゴミ箱の親の本文に行が残る');
  assert.ok(trashedAt(db, P), '親まで戻した');
  tick();
  ok(call(db, 'page.restore', { id: P }), 'page.restore');
  assert.deepStrictEqual(subsOf(db, P), [], '親を戻すと、もう子でないページの行が出る');
  sameTree(db);
}));

test('PR-1 直し・R35: 同じページを指す行が本文に2つ（前の版の写し）→ サイドバーで消すと先の行だけが消え、戻すと残った行を使って行を足さない（行はちょうど1つ）', T, () => withDb((db) => {
  const P = create(db);
  const K = create(db, P);
  const first = subRow(db, P, K).id;
  applyOps(db, [{ op: 'add', id: 'btwin1', row: { ...O.blockRow({ id: 'btwin1', type: 'subpage', text: '' }, P, 'zz'), attrs: { page: K } } }]);
  assert.deepStrictEqual(subsOf(db, P), [K, K]);
  tick();
  ok(call(db, 'page.delete', { id: K }), 'page.delete');
  assert.deepStrictEqual(flat(bodyOf(db, P)).filter((b) => b.type === 'subpage').map((b) => b.id), ['btwin1'], '先の行が消えない');
  tick();
  ok(call(db, 'page.restore', { id: K }), 'page.restore');
  assert.deepStrictEqual(flat(bodyOf(db, P)).filter((b) => b.type === 'subpage').map((b) => [b.id, b.page]), [['btwin1', K]], '戻すと行が2つになった（残った行があるのに足した）');
  assert.ok(!flat(bodyOf(db, P)).some((b) => b.id === first));
  sameTree(db);
}));

test('PR-1 直し・R36: 消した行の edit.revert は、間にゴミ箱から戻して動かした・戻して消し直した後も stale。戻した歩みのやり直しも、間に動かした・中のページ（子孫）だけを消した後は stale（何も変えない）', T, () => withDb((db) => {
  const Q = create(db);
  const setup = () => {
    const P = create(db);
    const K = create(db, P); const G = create(db, K);
    tick();
    const s = ok(call(db, 'block.remove', { pageId: P, blockId: subRow(db, P, K).id }), 'block.remove');
    return { P, K, G, s };
  };
  const staleNow = (pageId, step, what) => {
    const was = dump(db);
    tick();
    const r = call(db, 'edit.revert', { pageId, steps: [step] });
    assert.strictEqual(r.code, 'stale', `${what}: ${r.code}`);
    assert.deepStrictEqual(dump(db), was, `${what}: stale なのに何か変えた`);
  };
  // 戻す: 間にゴミ箱から戻して動かした
  { const { P, K, s } = setup(); tick(); ok(call(db, 'page.restore', { id: K }), 'page.restore'); ok(move(db, K, Q), 'page.move'); staleNow(P, s.tx, '戻して動かした'); }
  // 戻す: 間にゴミ箱から戻して消し直した
  { const { P, K, s } = setup(); tick(); ok(call(db, 'page.restore', { id: K }), 'page.restore'); tick(); ok(call(db, 'page.delete', { id: K }), 'page.delete'); staleNow(P, s.tx, '戻して消し直した'); }
  // やり直し: 戻した後に動かした
  { const { P, K, s } = setup(); tick(); const u = ok(call(db, 'edit.revert', { pageId: P, steps: [s.tx] }), 'edit.revert'); ok(move(db, K, Q), 'page.move'); staleNow(P, u.tx, 'やり直しの前に動かした'); }
  // やり直し: 戻した後に中のページ（子孫 G）だけを消した（P の本文は変わらない）
  { const { P, G, s } = setup(); tick(); const u = ok(call(db, 'edit.revert', { pageId: P, steps: [s.tx] }), 'edit.revert'); tick(); ok(call(db, 'page.delete', { id: G }), 'page.delete'); staleNow(P, u.tx, 'やり直しの前に中のページを消した'); }
}));

test('PR-1 直し・R37（決めたこと 43）: 子ページの行は色（飾り）を持たない。blocks.setColor は子ページの行だけなら bad-args、ほかの行と一緒なら子ページの行を除いて付ける（トグルの中の子ページの行も）', T, () => withDb((db) => {
  const P = create(db);
  const K = create(db, P);
  const row = subRow(db, P, K).id;
  const para = insert(db, P, row);
  const was = dump(db);
  for (const color of ['red', 'red_bg', '']) assert.strictEqual(call(db, 'blocks.setColor', { pageId: P, ids: [row], color }).code, 'bad-args', `子ページの行だけの色 ${color}`);
  assert.deepStrictEqual(dump(db), was, '断った命令が何か書いた');
  ok(call(db, 'blocks.setColor', { pageId: P, ids: [row, para], color: 'red' }), 'blocks.setColor');
  const colorOf = (id) => flat(bodyOf(db, P)).find((b) => b.id === id).color;
  assert.deepStrictEqual([colorOf(row), colorOf(para)], [undefined, 'red'], '子ページの行に色を付けたか、ほかの行に付けない');
  const tg = insert(db, P, para, 'toggle');
  ok(call(db, 'block.move', { pageId: P, blockId: row, afterId: '', parentId: tg }), 'block.move');
  ok(call(db, 'blocks.setColor', { pageId: P, ids: [tg], color: 'blue_bg' }), 'blocks.setColor');
  assert.deepStrictEqual([colorOf(tg), colorOf(row)], ['blue_bg', undefined], 'トグルの中の子ページの行に色を付けた');
  sameTree(db);
}));

test('PR-2 直し・R44（決めたこと 55）: page.move の rowAfter・rowParent は、同じ白紙のページの子の行を本文のその所（行の後ろ・頭・子を持てる行の子の頭）に置く（行の無い子は行を作り、行があれば動かす。oplog は1行・ページの親は替わらない）。違う親・議事録・無い行・子を持てない行・afterId と一緒は bad-args、2,000 行の本文に足すのは too-big（何も変えない）', T, () => withDb((db, t) => {
  const P = create(db);
  const K1 = create(db, P); const K2 = create(db, P);
  const r1 = subRow(db, P, K1).id;
  db.prepare('delete from blocks where id = ?').run(subRow(db, P, K2).id);   // 前の版で行を消された子（行の無い子）
  assert.deepStrictEqual(subsOf(db, P), [K1]);
  const place = (id, parentId, row, more = {}) => call(db, 'page.move', { id, parentId, ...row, ...more });
  // 行の後ろへ（行を作る）
  const before = oplogN(db);
  const r = ok(place(K2, P, { rowAfter: r1 }), 'rowAfter');
  assert.strictEqual(oplogN(db), before + 1, 'oplog は1行');
  assert.deepStrictEqual(subsOf(db, P), [K1, K2], '行の後ろに置かない');
  assert.strictEqual(rowOf(db, K2).parent_id, P, 'ページの親が替わった');
  assert.ok(!opsOf(db, r.tx).some((o) => o.op === 'move' && o.id === K2), '同じ親なのにページの行を動かした');
  assert.ok(Array.isArray(r.result) && r.result.some((p) => p.id === K2), '答えが一覧でない');
  sameTree(db);
  // 行があれば動かす（頭へ・2つにしない）
  ok(place(K2, P, { rowAfter: '' }), 'rowAfter 頭');
  assert.deepStrictEqual(subsOf(db, P), [K2, K1], '頭に置かないか、行が2つになった');
  // 子を持てる行の子の頭
  const tg = insert(db, P, r1, 'toggle');
  ok(place(K2, P, { rowAfter: '', rowParent: tg }), 'rowParent');
  assert.deepStrictEqual(flat(bodyOf(db, P)).find((b) => b.id === tg).children.map((b) => b.page), [K2], 'トグルの子の頭に置かない');
  assert.deepStrictEqual(kidsInList(db, P), [K1, K2]);
  sameTree(db);
  // 断り（何も変えない）
  const KM = create(db, 'pa1');
  const div = insert(db, P, tg, 'divider');
  const was = dump(db);
  const bad = (args, what) => { const x = call(db, 'page.move', args); assert.strictEqual(x.code, 'bad-args', `${what}: ${x.code}`); };
  // 0.16.0 DL-1 (1)（計画 docs/plans/2026-11-04-160.md の決めたこと 56・DQ9・「意図して変えるテスト」）で意図して直した: 違う親の子の rowAfter は親を替えて行を置く（test/stage160.db.test.js の DL-1・F146）。
  // 議事録・最上位・無い行などの断りは今のまま
  bad({ id: KM, parentId: 'pa1', rowAfter: '' }, '議事録の中');
  bad({ id: K2, parentId: '', rowAfter: '' }, '最上位');
  bad({ id: K2, parentId: P, rowAfter: 'bnothere1' }, '無い行');
  bad({ id: K2, parentId: P, rowAfter: '', rowParent: div }, '子を持てない行（区切り線）');
  bad({ id: K2, parentId: P, rowAfter: '', rowParent: r1 }, '子を持てない行（子ページの行）');
  bad({ id: K2, parentId: P, rowAfter: '', rowParent: 'bnothere1' }, '無い親の行');
  bad({ id: K2, parentId: P, rowAfter: r1, afterId: K1 }, 'afterId と一緒');
  bad({ id: K2, parentId: P, rowParent: tg }, 'rowAfter の無い rowParent');
  assert.deepStrictEqual(dump(db), was, '断った命令が何か書いた');
  // 2,000 行の本文に足すのは too-big（行のある子を本文の中で動かすのは通す）
  const N = 2000;
  t.seed({ id: 'pfull2', title: '大きな本文', kind: 'blank', date: '2026-11-02', memo: '', blocks: Array.from({ length: N }, (_, i) => ({ id: `fy${i}`, type: 'paragraph', text: `行${i}` })), createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' }, []);   // 利用者が付けた題名（D77）
  tick();
  const KF = ok(call(db, 'page.create', { parentId: 'pfull2' }), 'page.create').result.id;   // 行は置かない（R33）
  const was2 = dump(db);
  assert.strictEqual(place(KF, 'pfull2', { rowAfter: 'fy0' }).code, 'too-big');
  assert.deepStrictEqual(dump(db), was2, 'too-big なのに何か書いた');
}));

test('PR-2 直し・R44: preload の pageMove(id, parentId, afterId, row) は row があるときだけ rowAfter・rowParent を送る', T, () => {
  const { k, givePort } = loadPreload();
  const p = givePort();
  k.pageMove('pb1', 'pa1'); k.pageMove('pb1', 'pa1', undefined, { afterId: 'b1' }); k.pageMove('pb1', 'pa1', undefined, { afterId: '', parentId: 'b2' }); k.pageMove('pb1', 'pa1', undefined, { afterId: '' });
  assert.deepStrictEqual(p.sent.map((m) => m.args), [
    { id: 'pb1', parentId: 'pa1' }, { id: 'pb1', parentId: 'pa1', rowAfter: 'b1' }, { id: 'pb1', parentId: 'pa1', rowAfter: '', rowParent: 'b2' }, { id: 'pb1', parentId: 'pa1', rowAfter: '' },
  ]);
});

// ---------------------------------------------------------------- 0.15.0 PR-2 直し 3（2026-11-04 の 0828257..a812237 の点検。計画の R45〜）
test('PR-2 直し 3・R46: page.move の rowAfter が動かすページ自身の行なら、今の所のまま何も書かない（block.move の afterId === blockId と同じ。前は行を抜いてから探して bad-args）。rowParent が今の親の行と違えば bad-args', T, () => withDb((db) => {
  const P = create(db);
  const K1 = create(db, P); const K2 = create(db, P);
  const r2 = subRow(db, P, K2).id;
  const tg = insert(db, P, r2, 'toggle');
  const was = dump(db);
  const r = ok(call(db, 'page.move', { id: K2, parentId: P, rowAfter: r2 }), '自分の行の後ろ');
  assert.deepStrictEqual(opsOf(db, r.tx), [], '同じ所なのに操作を書いた（oplog の行は空の操作）');
  assert.deepStrictEqual(dump(db), was, '同じ所なのに何か書いた');
  assert.strictEqual(r.changed, undefined, '同じ所なのに変えた印');
  assert.ok(Array.isArray(r.result) && r.result.some((p) => p.id === K2), '答えが一覧でない');
  assert.deepStrictEqual(subsOf(db, P), [K1, K2]);
  // 今の親（最上位）と違う rowParent は、ほかの行の後ろと同じく断る（何も変えない）
  const x = call(db, 'page.move', { id: K2, parentId: P, rowAfter: r2, rowParent: tg });
  assert.strictEqual(x.code, 'bad-args', `親の違う rowParent: ${x.code}`);
  assert.deepStrictEqual(dump(db), was, '断った命令が何か書いた');
  // トグルの子の行: 同じ親の rowParent と一緒でも今の所のまま
  ok(call(db, 'page.move', { id: K2, parentId: P, rowAfter: '', rowParent: tg }), 'トグルの子の頭');
  const was2 = dump(db);
  const y = ok(call(db, 'page.move', { id: K2, parentId: P, rowAfter: r2, rowParent: tg }), '同じ親の rowParent');
  assert.deepStrictEqual(opsOf(db, y.tx), []);
  assert.deepStrictEqual(dump(db), was2, '同じ所なのに何か書いた');
}));

// ---------------------------------------------------------------- 0.15.0 PH-6・PH-7 直し（2026-11-04 の 03abad4..e235d8b の点検。rv29 F1）
test('PH-6・PH-7 直し（rv29 F1・決めたこと 16）: 満杯でない白紙のページで、本文の行がもう最後の子をゴミ箱・知らない兄弟の後ろ（末尾）へ動かすのは同じ所（書かない・版も上げない）。行が最後でなければ末尾へ動かす', T, () => withDb((db) => {
  const P = create(db);
  const A = create(db, P); const C = create(db, P); const TT = create(db, P);
  tick(); ok(call(db, 'page.delete', { id: TT }), 'page.delete');
  assert.deepStrictEqual(subsRaw(db, P), [A, C], '前提: 行のある子は A・C（C の行が本文の最後）');
  for (const [afterId, what] of [[TT, 'ゴミ箱の兄弟の後ろ'], ['pzzunknown', '知らない兄弟の後ろ']]) {
    const was = dump(db);
    const n0 = oplogN(db);
    const r = ok(move(db, C, P, afterId), `page.move ${what}`);
    assert.deepStrictEqual([opsOf(db, r.tx), oplogN(db) - n0], [[], 1], `${what}: 同じ所なのに書いた`);
    assert.deepStrictEqual(dump(db), was, `${what}: 表が変わった（ord・rev・updatedAt）`);
    assert.deepStrictEqual(kidsInList(db, P), [A, C]);
  }
  // 議事録の中（本文の行が無い）でも、最後の子をゴミ箱・知らない兄弟の後ろ（末尾）へは同じ所
  const MA = create(db, 'pa1'); const MC = create(db, 'pa1'); const MT = create(db, 'pa1');
  tick(); ok(call(db, 'page.delete', { id: MT }), 'page.delete');
  for (const [afterId, what] of [[MT, '議事録の中のゴミ箱の兄弟の後ろ'], ['pzzunknown', '議事録の中の知らない兄弟の後ろ']]) {
    const was = dump(db);
    const r = ok(move(db, MC, 'pa1', afterId), `page.move ${what}`);
    assert.deepStrictEqual(opsOf(db, r.tx), [], `${what}: 同じ所なのに書いた`);
    assert.deepStrictEqual(dump(db), was, `${what}: 表が変わった`);
    assert.deepStrictEqual(kidsInList(db, 'pa1'), [MA, MC]);
  }
  // 行が本文の最後でなければ、ゴミ箱の兄弟の後ろ（末尾）は行を本文の最後へ動かす（書く）
  insert(db, P, subRow(db, P, C).id);
  ok(move(db, C, P, TT), 'page.move');
  const b = bodyOf(db, P);
  assert.deepStrictEqual([b[b.length - 1].type, b[b.length - 1].page], ['subpage', C], '行が本文の最後へ動かない');
}));

test('PH-6・PH-7 直し（rv29 F1・決めたこと 16）: 満杯の本文の白紙のページで、行のある子を行の無い兄弟の後ろへ動かしても見える並びが変わらない（行がもう本文の最後）なら書かない。変わるなら書く', T, () => withDb((db, t) => {
  const N = 2000;
  const blocks = Array.from({ length: N - 2 }, (_, i) => ({ id: `fy${i}`, type: 'paragraph', text: `行${i}` }));
  t.seed({ id: 'pfull', title: '大きな本文', kind: 'blank', date: '2026-11-02', memo: '', blocks, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' }, []);   // 利用者が付けた題名（D77）
  const R1 = create(db, 'pfull'); const R2 = create(db, 'pfull');   // 行のある子（本文は 2,000 行になる。R2 の行が最後）
  const K = [create(db, 'pfull'), create(db, 'pfull')];   // 行の無い子
  const T1 = create(db, 'pfull');
  tick(); ok(call(db, 'page.delete', { id: T1 }), 'page.delete');
  assert.deepStrictEqual(kidsInList(db, 'pfull'), [R1, R2, ...K], '前提');
  for (const [afterId, what] of [[K[0], '行の無い兄弟の後ろ'], [K[1], '最後の行の無い兄弟の後ろ'], [T1, 'ゴミ箱の兄弟の後ろ']]) {
    const was = dump(db);
    const n0 = oplogN(db);
    const r = ok(move(db, R2, 'pfull', afterId), `page.move ${what}`);
    assert.deepStrictEqual([opsOf(db, r.tx), oplogN(db) - n0], [[], 1], `${what}: 見える並びが変わらないのに書いた`);
    assert.deepStrictEqual(dump(db), was, `${what}: 表が変わった`);
  }
  // R1 を行の無い兄弟の後ろへ → R1 の行が本文の最後へ（見える並びが変わる: 書く）
  ok(move(db, R1, 'pfull', K[0]), 'page.move');
  assert.deepStrictEqual(kidsInList(db, 'pfull'), [R2, R1, ...K]);
}));

// ---------------------------------------------------------------- 0.15.0 PH-8 直し（2026-11-04 の e235d8b..831ce7c の点検 rv31。計画の R69）
test('PH-8 直し（rv31・R54・R67）: 本文 [K1 の行, トグル[K2 の行]] で K2 を同じ親へ afterId なしで動かす（［移動先…］）と、行はトグルの中から本文の最上位の最後へ動き、書く（行の並びの形は親も見る）', T, () => withDb((db) => {
  const P = create(db);
  const K1 = create(db, P); const K2 = create(db, P);
  const tg = insert(db, P, subRow(db, P, K1).id, 'toggle');
  ok(call(db, 'block.update', { pageId: P, blockId: tg, patch: { text: 'まとめ' } }), 'block.update');
  ok(call(db, 'block.move', { pageId: P, blockId: subRow(db, P, K2).id, afterId: '', parentId: tg }), 'block.move');
  const shape = () => bodyOf(db, P).map((b) => (b.type === 'subpage' ? `page:${b.page}` : `${b.type}[${(b.children || []).map((c) => (c.type === 'subpage' ? `page:${c.page}` : c.type)).join(',')}]`));
  assert.deepStrictEqual(shape(), [`page:${K1}`, `toggle[page:${K2}]`], '前提: K2 の行はトグルの中（行の順は K1・K2 のまま）');
  const n0 = oplogN(db);
  const r = ok(move(db, K2, P), 'page.move');
  assert.strictEqual(oplogN(db), n0 + 1);
  assert.ok(opsOf(db, r.tx).length > 0, '行の並びの順が同じでも親が替わるのに書かなかった');
  assert.deepStrictEqual(shape(), [`page:${K1}`, 'toggle[]', `page:${K2}`], '行がトグルの中から本文の最上位の最後へ動かない');
}));

// ---------------------------------------------------------------- 0.15.0 PL-2（計画の決めたこと 13・15・16・35・36・39・F119）: ページのアイコンと見た目を保存する命令
const attrsOf = (db, id) => JSON.parse(rowOf(db, id).attrs);
const listOf = (db) => call(db, 'pages.list', {}).result;
test('PL-2・F119: page.setIcon は辞書の絵文字だけ（ほかは bad-args）・\'\' で欄が消える・同じ値は書かない・pages.list の行に icon。議事録にも白紙のページにも付く。役は app だけ・録音中の写しとゴミ箱のページは書かない', T, () => withDb((db) => {
  // PL-2 直し（R75・rv33 I1）: 手を付けていないページ（種のまま）に、無いアイコンを外しても何も書かない（時刻を進めても: 本当の時計は毎回進む）
  {
    tick();
    const was0 = dump(db); const n = oplogN(db);
    const r0 = ok(call(db, 'page.setIcon', { id: 'pa3', icon: '' }), '手を付けていないページで外す');
    assert.deepStrictEqual([opsOf(db, r0.tx), oplogN(db) - n], [[], 1], '手を付けていないページに無いアイコンを外して書いた');
    assert.deepStrictEqual(dump(db), was0);
    assert.strictEqual(r0.result.id, 'pa3', '同じ値の答えが今のページでない');
  }
  const P = create(db);
  const r = ok(call(db, 'page.setIcon', { id: P, icon: '🚀' }), 'page.setIcon');
  assert.strictEqual(r.result.icon, '🚀', '答えのページに icon が無い');
  assert.strictEqual(attrsOf(db, P).icon, '🚀');
  assert.strictEqual(listOf(db).find((p) => p.id === P).icon, '🚀', 'pages.list の行に icon が無い');
  // 同じ値は書かない（操作の空の行だけ・rev も更新の時刻も変えない。時刻を進めてから: R75）
  const was = dump(db);
  const n0 = oplogN(db);
  tick();
  const same = ok(call(db, 'page.setIcon', { id: P, icon: '🚀' }), '同じ値');
  assert.deepStrictEqual([opsOf(db, same.tx), oplogN(db) - n0], [[], 1], '同じアイコンなのに書いた');
  assert.deepStrictEqual(dump(db), was);
  // 辞書に無い値は断る（何も書かない）。PL-2 直し（R75・rv33 M4）: 文字でない値（undefined・欄が無い）も外さずに断る（preload は '' に替えない）
  for (const icon of ['🦕', 'a', '📄📄', '‮', '🎙', '👍🏻', 'x'.repeat(600), 5, null, undefined, false, ['🚀']]) {
    const b = call(db, 'page.setIcon', { id: P, icon });
    assert.strictEqual(b.code, 'bad-args', String(JSON.stringify(icon)));
  }
  assert.strictEqual(call(db, 'page.setIcon', { id: P }).code, 'bad-args', 'アイコンの欄の無い頼みを断らない');
  assert.strictEqual(attrsOf(db, P).icon, '🚀', '文字でない値でアイコンが外れた');
  assert.deepStrictEqual(dump(db), was, '断ったのに書いた');
  // '' で欄が消える（既定に戻る）
  ok(call(db, 'page.setIcon', { id: P, icon: '' }), '外す');
  assert.ok(!Object.hasOwn(attrsOf(db, P), 'icon'), '外しても欄が残る');
  assert.ok(!Object.hasOwn(listOf(db).find((p) => p.id === P), 'icon'));
  const n1 = oplogN(db);
  tick();
  const none = ok(call(db, 'page.setIcon', { id: P, icon: '' }), 'もう無いのを外す');
  assert.deepStrictEqual([opsOf(db, none.tx), oplogN(db) - n1], [[], 1], '無いアイコンを外して書いた');
  // 議事録にも付く
  ok(call(db, 'page.setIcon', { id: 'pa1', icon: '📊' }), '議事録');
  assert.strictEqual(listOf(db).find((p) => p.id === 'pa1').icon, '📊');
  // 役は app だけ
  assert.deepStrictEqual(core.COMMANDS['page.setIcon'].roles, ['app']);
  assert.strictEqual(call(db, 'page.setIcon', { id: P, icon: '🚀' }, 'main').code, 'forbidden');
  // 録音中の写しは書かない（bad-args）・ゴミ箱と無いページは書かない
  call(db, 'meeting.begin', { pageId: 'plive9', startedAt: Date.parse('2026-11-03T00:00:00.000Z'), localOnly: false }, 'main');
  const live = dump(db);
  tick();
  assert.strictEqual(call(db, 'page.setIcon', { id: 'plive9', icon: '🚀' }).code, 'bad-args', '録音中の写しにアイコンを書いた');
  assert.strictEqual(call(db, 'page.setIcon', { id: 'plive9', icon: '' }).code, 'bad-args', '録音中の写しで同じ値（無いアイコン）を断らない');
  assert.deepStrictEqual(dump(db), live, '録音中の写しで断ったのに書いた');
  tick(); ok(call(db, 'page.delete', { id: 'pa2' }), 'page.delete');
  const trashed = dump(db);
  for (const id of ['pa2', 'pnone']) {
    for (const icon of ['🚀', '']) {
      const x = call(db, 'page.setIcon', { id, icon });
      assert.ok(x.ok && x.result === null, `${id}・${JSON.stringify(icon)}: 答えが null でない（${x.code}）`);
      assert.deepStrictEqual(dump(db), trashed, `${id}: 何か書いた`);
    }
  }
}));

test('PL-2・F119: page.setLook は照らした形だけ保存（並びも決まった形）・全部既定で欄が消える・同じ見た目は書かない・知らない欄・決まった書体のほか・真でない値は bad-args', T, () => withDb((db) => {
  const P = create(db);
  const r = ok(call(db, 'page.setLook', { id: P, look: { font: 'serif', wide: true } }), 'page.setLook');
  assert.deepStrictEqual(r.result.look, { wide: true, font: 'serif' });
  assert.deepStrictEqual(attrsOf(db, P).look, { wide: true, font: 'serif' });
  const was = dump(db);
  const n0 = oplogN(db);
  tick();
  const same = ok(call(db, 'page.setLook', { id: P, look: { font: 'serif', wide: true } }), '同じ見た目（欄の並びは違う）');
  assert.deepStrictEqual([opsOf(db, same.tx), oplogN(db) - n0], [[], 1], '同じ見た目なのに書いた');
  assert.deepStrictEqual(dump(db), was);
  for (const look of [{ font: 'gothic' }, { wide: 1 }, { wide: false }, { color: 'red' }, { wide: true, extra: 1 }, 'wide', null, ['wide']]) {
    assert.strictEqual(call(db, 'page.setLook', { id: P, look }).code, 'bad-args', JSON.stringify(look));
  }
  assert.deepStrictEqual(dump(db), was, '断ったのに書いた');
  ok(call(db, 'page.setLook', { id: P, look: { small: true } }), '替える');
  assert.deepStrictEqual(attrsOf(db, P).look, { small: true });
  ok(call(db, 'page.setLook', { id: P, look: {} }), '全部既定');
  assert.ok(!Object.hasOwn(attrsOf(db, P), 'look'), '全部既定でも欄が残る');
  const n1 = oplogN(db);
  tick();
  const none = ok(call(db, 'page.setLook', { id: P, look: {} }), 'もう既定');
  assert.deepStrictEqual([opsOf(db, none.tx), oplogN(db) - n1], [[], 1], '既定の見た目をもう一度既定にして書いた');
  ok(call(db, 'page.setLook', { id: 'pa1', look: { font: 'mono' } }), '議事録');
  assert.deepStrictEqual(attrsOf(db, 'pa1').look, { font: 'mono' });
  assert.deepStrictEqual(core.COMMANDS['page.setLook'].roles, ['app']);
  // PL-2 直し（R75）: 手を付けていないページ（種のまま）を全部既定にしても何も書かない
  {
    tick();
    const was0 = dump(db); const n = oplogN(db);
    const r0 = ok(call(db, 'page.setLook', { id: 'pa3', look: {} }), '手を付けていないページで全部既定');
    assert.deepStrictEqual([opsOf(db, r0.tx), oplogN(db) - n], [[], 1], '手を付けていないページを全部既定にして書いた');
    assert.deepStrictEqual(dump(db), was0);
    assert.strictEqual(r0.result.id, 'pa3');
  }
  call(db, 'meeting.begin', { pageId: 'plive9', startedAt: Date.parse('2026-11-03T00:00:00.000Z'), localOnly: false }, 'main');
  const live = dump(db);
  tick();
  assert.strictEqual(call(db, 'page.setLook', { id: 'plive9', look: { wide: true } }).code, 'bad-args', '録音中の写しに見た目を書いた');
  assert.strictEqual(call(db, 'page.setLook', { id: 'plive9', look: {} }).code, 'bad-args', '録音中の写しで同じ値（全部既定）を断らない');
  assert.deepStrictEqual(dump(db), live, '録音中の写しで断ったのに書いた');
  // PL-2 直し（R75・rv33 M2）: ゴミ箱と無いページは書かず、答えが null
  tick(); ok(call(db, 'page.delete', { id: 'pa2' }), 'page.delete');
  const trashed = dump(db);
  for (const id of ['pa2', 'pnone']) {
    for (const look of [{ wide: true }, {}]) {
      const x = call(db, 'page.setLook', { id, look });
      assert.ok(x.ok && x.result === null, `${id}・${JSON.stringify(look)}: 答えが null でない（${x.code}）`);
      assert.deepStrictEqual(dump(db), trashed, `${id}: 何か書いた`);
    }
  }
}));

test('PL-2: page.put（要約の書き戻し）は icon・look を消さない（送ったページに無くても、DB の今の値のまま）・送ったページの icon・look で書き換えない。どちらの命令も UNDO_CMDS に無い', T, () => withDb((db) => {
  ok(call(db, 'page.setIcon', { id: 'pa1', icon: '📊' }), 'page.setIcon');
  ok(call(db, 'page.setLook', { id: 'pa1', look: { wide: true } }), 'page.setLook');
  const p = call(db, 'page.get', { id: 'pa1' }).result.page;
  assert.strictEqual(p.icon, '📊', '前提: page.get に icon');
  // 読んだページのまま書き戻す
  const { rev, ...rest } = p;
  ok(call(db, 'page.put', { page: { ...rest, title: '要約の題' }, baseRev: rev }, 'main'), 'page.put');   // 利用者が付け直した題名（D77）
  assert.deepStrictEqual([attrsOf(db, 'pa1').icon, attrsOf(db, 'pa1').look], ['📊', { wide: true }]);
  // icon・look の無い（か違う）ページを送っても、DB の今の値のまま
  const p2 = call(db, 'page.get', { id: 'pa1' }).result.page;
  const { rev: rev2, icon: _i, look: _l, ...bare } = p2;
  void _i; void _l;
  ok(call(db, 'page.put', { page: { ...bare, icon: '🦕', look: { font: 'gothic' } }, baseRev: rev2 }, 'main'), 'page.put');
  assert.deepStrictEqual([attrsOf(db, 'pa1').icon, attrsOf(db, 'pa1').look], ['📊', { wide: true }], '書き戻しでアイコンか見た目が変わった');
  const p3 = call(db, 'page.get', { id: 'pa1' }).result.page;
  const { rev: rev3, icon: _i3, look: _l3, ...bare3 } = p3;
  void _i3; void _l3;
  ok(call(db, 'page.put', { page: bare3, baseRev: rev3 }, 'main'), 'page.put');
  assert.deepStrictEqual([attrsOf(db, 'pa1').icon, attrsOf(db, 'pa1').look], ['📊', { wide: true }], '書き戻しでアイコンか見た目が消えた');
  // 保存してあるアイコン・見た目が無いページに、送ったページの icon・look で付けない
  const q = call(db, 'page.get', { id: 'pa2' }).result.page;
  const { rev: rev4, ...q4 } = q;
  ok(call(db, 'page.put', { page: { ...q4, icon: '📊', look: { wide: true } }, baseRev: rev4 }, 'main'), 'page.put');
  assert.ok(!Object.hasOwn(attrsOf(db, 'pa2'), 'icon') && !Object.hasOwn(attrsOf(db, 'pa2'), 'look'), '書き戻しでアイコンか見た目が付いた');
  // 同じ値の命令の答えも今のページ（null でない）
  assert.strictEqual(ok(call(db, 'page.setIcon', { id: 'pa1', icon: '📊' }), '同じ値').result.icon, '📊');
  for (const cmd of ['page.setIcon', 'page.setLook']) assert.ok(!UNDO_CMDS.has(cmd), `UNDO_CMDS に ${cmd}`);
}));
