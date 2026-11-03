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

test('PH-2: preload の 33 の名前・pageMove の引数（afterId が無ければ送らない）・UNDO_CMDS にページの命令が無い', T, async () => {
  const names = [.../const APP_COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(PRELOAD)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.strictEqual(names.length, 33);
  assert.deepStrictEqual(names.sort(), Object.keys(core.COMMANDS).filter((k) => core.COMMANDS[k].roles.includes('app')).sort());
  for (const cmd of ['page.create', 'page.move', 'page.restore', 'pages.trash']) assert.deepStrictEqual(core.COMMANDS[cmd].roles, ['app'], cmd);
  assert.strictEqual(core.COMMANDS['pages.trash'].write, false);
  const reads = [.../const DB_READS = new Set\(\[([^\]]*)\]\)/.exec(PRELOAD)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.ok(reads.includes('pages.trash'), 'pages.trash が読む命令でない');
  const undo = [.../const UNDO_CMDS = new Set\(\[([^\]]*)\]\)/.exec(PRELOAD)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  for (const cmd of ['page.create', 'page.move', 'page.restore', 'page.delete', 'pages.trash']) {
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

test('PH-2 直し・R11・R12: 5,000 ページ（1KB のメモ・1,000 段の子孫）で pages.trash（頭 300）・page.move・子孫 1,000 の page.delete・page.restore が目安以内（3 回の中央値。pages.trash は一覧の目安。書く命令は答えの一覧を作る分（同じ時に計った pages.list）を除いて、1 ページは一覧の目安・子孫 1,000 は一覧の目安の 2 倍: R22）', { timeout: 120000 }, (tc) => {
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
    const median = (xs) => [...xs].sort((a, b) => a - b)[1];
    // 書く命令の答えは一覧（今の page.delete と同じ）。一覧を作る分は今の一覧の速さ（PERF の list）なので、すぐ前に計った pages.list を引いて木の分を見る
    const listMs = () => timed(() => call(db, 'pages.list', {}))[0];
    const moves = []; const dels = []; const rests = []; const one = []; const oneDel = [];
    for (let k = 0; k < 3; k++) {
      let l = listMs();
      const [m, mr] = timed(() => move(db, 'pp04000', k % 2 ? 'pp00600' : 'pp00500'));
      assert.strictEqual(mr.ok, true, mr.code); moves.push(m - l);
      tick(); l = listMs();
      const [d, dr] = timed(() => call(db, 'page.delete', { id: 'pp00000' }));
      assert.strictEqual(dr.ok, true, dr.code); dels.push(d - l);
      tick(); l = listMs();
      const [r, rr] = timed(() => call(db, 'page.restore', { id: 'pp00000' }));
      assert.strictEqual(rr.ok, true, rr.code); rests.push(r - l);
      tick(); l = listMs();
      const [od, odr] = timed(() => call(db, 'page.delete', { id: 'pp03000' }));
      assert.strictEqual(odr.ok, true, odr.code); oneDel.push(od - l);
      tick(); l = listMs();
      const [o, or] = timed(() => call(db, 'page.restore', { id: 'pp03000' }));
      assert.strictEqual(or.ok, true, or.code); one.push(o - l);
    }
    assert.strictEqual(db.prepare("select count(*) c from blocks where type = 'page' and trashed_at is null").get().c, 5000);
    // 頭 300 のゴミ箱（消した時刻を1つずつ違える）は SQL で作る（命令で消すと、答えの一覧を 300 回作る）
    const trashAt = db.prepare('update blocks set trashed_at = ? where id = ?');
    db.exec('BEGIN');
    for (let i = 2000; i < 2300; i++) trashAt.run(new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(), pid(i));
    db.exec('COMMIT');
    const trash = [];
    for (let k = 0; k < 3; k++) { const [x, xr] = timed(() => call(db, 'pages.trash', {})); assert.strictEqual(xr.result.length, 200); trash.push(x); }
    // R22: 一覧を引いた値は一覧の速さの揺れ（CI の台で ±50 ミリ秒ほど）を含むので、1 ページの命令は一覧の目安、子孫 1,000 の書き込み（台の書き込みの
    // 速さで決まる）は一覧の目安の 2 倍（Windows は CI で計った中央値の 2 倍の 800: R21。tools/perf.js の BUDGETS_WIN と同じ考え）。
    // メモを読まないこと（R12）は上の SQL の試験が、木を1回だけ作ること（R11）は pages.trash の目安が見る（直す前は 927 ミリ秒）
    const write = budget.list;
    const big = process.platform === 'win32' ? 800 : budget.list * 2;
    tc.diagnostic(`pages.trash ${median(trash).toFixed(1)}・page.move ${median(moves).toFixed(1)}・page.delete ${median(dels).toFixed(1)}・page.restore（1,000）${median(rests).toFixed(1)}・page.delete（1）${median(oneDel).toFixed(1)}・page.restore（1）${median(one).toFixed(1)} ミリ秒（書く命令は一覧の分を引いた値）`);
    assert.ok(median(trash) < budget.list, `pages.trash ${median(trash).toFixed(1)} ミリ秒`);
    assert.ok(median(moves) < write, `page.move ${median(moves).toFixed(1)} ミリ秒`);
    assert.ok(median(oneDel) < write, `page.delete（1 ページ）${median(oneDel).toFixed(1)} ミリ秒`);
    assert.ok(median(dels) < big, `page.delete（子孫 1,000）${median(dels).toFixed(1)} ミリ秒`);
    assert.ok(median(one) < write, `page.restore（1 ページ）${median(one).toFixed(1)} ミリ秒`);
    assert.ok(median(rests) < big, `page.restore（1,000 ページ）${median(rests).toFixed(1)} ミリ秒`);
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
