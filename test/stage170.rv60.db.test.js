/* stage170.rv60.db.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の点検 3（rv60）の直しの DB（一時の DB に本物の命令を通す）
 *  重要 1（R68）: ロック中のデータベースの列は、相手の側（両側のリレーション）からも書かない
 *  重要 2（R69）: db.get の rowCount は表と同じ数え方（「議事録」は議事録の行も・テンプレートは数えない）
 *  重要 3（R70）: テンプレートは両側のリレーションのセルを書けない・row.fromTpl は両側のリレーションの値を写さない
 *  重要 4（R65）: 親ごと戻した古い「議事録」・古い「タスク管理」を戻したときは今の方へ移して役の印を外す
 *  軽い 2〜7（R67・R71〜R75）: 複製で task を写さない・ゴミ箱のタスクは無い物として作り直す・要約の書き戻しで同じ文の ToDo に印を引き継ぐ・
 *  「タスク管理」の「議事録」の列のつなぐ先・ロック中のテンプレートのやり直し・rows.trash の送り直しの答え・テンプレートの中の子ページ
 * 会議の題名は titleAt（D77）。データベースの題名・列の名前・人の名前は作った物（実在の人名を使わない）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpDb, samplePage } = require('./helpers/dbtmp');
const { titleAt } = require('./helpers/titles');
const core = require('../src/db/core');
const commands = require('../src/db/commands');

let clock = Date.parse('2026-11-15T03:00:00.000Z');
const now = () => new Date(clock);
const tick = () => { clock += 60000; return new Date(clock).toISOString(); };
let n = 0;
const txOf = (role) => `${role[0]}:r60-${String(++n).padStart(6, '0')}`;
const call = (db, cmd, args, role = 'app', tx = txOf(role)) => { tick(); return { ...core.call(db, { role, cmd, args, tx }, { now, labels: {} }), tx }; };
const ok = (r, what) => { assert.strictEqual(r.ok, true, `${what}: ${r.code}`); return r; };
const T = { timeout: 30000 };
const attrsOf = (db, id) => JSON.parse(db.prepare('select attrs from blocks where id = ?').get(id).attrs);
const trashedAt = (db, id) => db.prepare('select trashed_at from blocks where id = ?').get(id).trashed_at;
const parentOf = (db, id) => db.prepare('select parent_id from blocks where id = ?').get(id).parent_id;
const oplogN = (db) => db.prepare('select count(*) c from oplog').get().c;
const snap = (db) => db.prepare('select id, parent_id, ord, text, attrs, trashed_at from blocks order by id').all().map((r) => ({ ...r }));
function withDb(fn) {
  const t = tmpDb();
  try { const { db } = t.open(); return fn(db, t); } finally { t.done(); }
}
const byRole = (role) => (db) => db.prepare(`select id, attrs from blocks where type = 'page' and trashed_at is null and instr(attrs, '${role}') > 0`).all()
  .filter((r) => { try { return JSON.parse(r.attrs).role === role; } catch (_) { return false; } }).map((r) => r.id);
const minutesDbs = byRole('minutes');
const tasksDbs = byRole('tasks');
// 締めた議事録（要約の見出しと ToDo）
function meeting(db, id, { at = '2026-11-10T01:30:00.000Z', date = '2026-11-10', todos = [] } = {}) {
  const page = { title: titleAt(at), date, createdAt: at, blocks: [{ id: `${id}h`, type: 'heading', text: 'ToDo' }, ...todos.map((x, i) => ({ id: `${id}t${i}`, type: 'todo', text: x, checked: false }))] };
  ok(call(db, 'meeting.finalize', { pageId: id, page, segments: [] }, 'main'), 'meeting.finalize');
  return id;
}
// 0.16.0 までに締めた議事録（移す前の形: 最上位）と、最初の移し替え（「議事録」と「タスク管理」を作る）
function oldMeeting(t, id, i) {
  const at = new Date(Date.parse('2026-10-01T01:00:00.000Z') + i * 3600000 * 7).toISOString();
  const { page, segments } = samplePage(id);
  page.title = titleAt(at); page.createdAt = at; page.updatedAt = at; page.date = at.slice(0, 10);
  for (const b of page.blocks) b.id = `${id}${b.id}`;
  t.seed(page, segments.map((s) => ({ ...s, id: `${id}${s.id}` })));
  return id;
}
const firstGather = (db, t) => { oldMeeting(t, 'pz0', 0); return ok(call(db, 'minutes.gather', { first: true }, 'main'), 'minutes.gather').result; };
const view = (db, id, viewId = 'v1') => ok(call(db, 'db.view', { id, viewId, from: 0, count: 200 }), 'db.view').result;
const dbGet = (db, id) => ok(call(db, 'db.get', { id }), 'db.get').result;

// ---------------------------------------------------------------- 重要 1（R68・決めたこと 61・74）
test('rv60 重要 1・決めたこと 74: ロック中のデータベースには、ほかのデータベースから両側のリレーションの列を足せない（col.add の both は bad-args・何も書かない）。片側は足せる。両側の列の片方を消す（col.remove）も、相手がロック中なら bad-args', T, () => withDb((db, t) => {
  const A = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const B = ok(call(db, 'db.create', {}), 'db.create').result.id;
  ok(call(db, 'db.setLock', { db: B, on: true }), 'db.setLock');
  const before = snap(db); const n0 = oplogN(db);
  assert.strictEqual(call(db, 'col.add', { db: A, type: 'rel', target: B, both: true }).code, 'bad-args', 'ロック中の相手に列を足した');
  assert.deepStrictEqual([snap(db), oplogN(db)], [before, n0], '断ったのに書いた');
  const one = ok(call(db, 'col.add', { db: A, type: 'rel', target: B }), 'col.add 片側').result.col;
  assert.strictEqual(attrsOf(db, B).cols.length, before.find((r) => r.id === B) && JSON.parse(before.find((r) => r.id === B).attrs).cols.length, '片側の列で相手の列が増えた');
  ok(call(db, 'col.rename', { db: A, col: one.id, name: '相手' }), 'col.rename');   // 列の名前（試しの字）。相手を書かない命令は通る
  // ロックの前に作った両側の列: 相手がロック中なら、こちらの側を消すと相手の列を書き換えるので断る
  ok(call(db, 'db.setLock', { db: B, on: false }), 'db.setLock');
  const both = ok(call(db, 'col.add', { db: A, type: 'rel', target: B, both: true }), 'col.add 両側').result;
  ok(call(db, 'db.setLock', { db: B, on: true }), 'db.setLock');
  const bCols = attrsOf(db, B).cols;
  const n1 = oplogN(db);
  assert.strictEqual(call(db, 'col.remove', { db: A, col: both.col.id }).code, 'bad-args', 'ロック中の相手の列の back を外した');
  assert.deepStrictEqual([attrsOf(db, B).cols, oplogN(db)], [bCols, n1]);
  // 「議事録」（ロックした形で作る）へ、「タスク管理」から両側の列を足せない（決めたこと 61・TQ2b）
  const g = firstGather(db, t);
  const mCols = attrsOf(db, g.db).cols;
  assert.strictEqual(call(db, 'col.add', { db: g.tasks, type: 'rel', target: g.db, both: true }).code, 'bad-args', '「議事録」に列ができた');
  assert.deepStrictEqual(attrsOf(db, g.db).cols, mCols);
}));

// ---------------------------------------------------------------- 重要 2（R69）
test('rv60 重要 2: db.get の rowCount は表（db.view の total）と同じ数え方。「議事録」は議事録の行を数え、テンプレートは数えない（消す確かめの「行 n 件」・表の中の検索の欄の境）', T, () => withDb((db) => {
  meeting(db, 'pa1');
  meeting(db, 'pa2', { at: '2026-11-11T01:30:00.000Z', date: '2026-11-11' });
  const M = minutesDbs(db)[0];
  ok(call(db, 'row.add', { db: M, title: '行の題' }), 'row.add');   // データベースの行の題名（D77 の外）
  assert.deepStrictEqual([dbGet(db, M).rowCount, view(db, M).total], [3, 3], '「議事録」の行の数');
  const D = ok(call(db, 'db.create', {}), 'db.create').result.id;
  ok(call(db, 'row.add', { db: D, title: '一' }), 'row.add');   // 行の題名（D77 の外）
  ok(call(db, 'tpl.add', { db: D, title: '見本' }), 'tpl.add');   // テンプレートの題名（D77 の外）
  assert.deepStrictEqual([dbGet(db, D).rowCount, view(db, D).total], [1, 1], 'テンプレートを数えた');
  assert.strictEqual(commands.dbRowCountOf(db, D), 1);
}));

// ---------------------------------------------------------------- 重要 3（R70・F202）
test('rv60 重要 3・F202: テンプレートは両側のリレーション（自分への列1つも）のセルを書けない（rel.link が bad-args・相手に書かない）。ほかの行からテンプレートへもつながない。片側の列は書け、row.fromTpl は片側の値だけを写す', T, () => withDb((db) => {
  const A = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const B = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const both = ok(call(db, 'col.add', { db: A, type: 'rel', target: B, both: true }), 'col.add').result;
  const one = ok(call(db, 'col.add', { db: A, type: 'rel', target: B }), 'col.add').result.col;
  const b1 = ok(call(db, 'row.add', { db: B, title: '相手' }), 'row.add').result.id;   // 行の題名（D77 の外）
  const tp = ok(call(db, 'tpl.add', { db: A, title: '見本' }), 'tpl.add').result.id;   // テンプレートの題名（D77 の外）
  const before = snap(db); const n0 = oplogN(db);
  assert.strictEqual(call(db, 'rel.link', { db: A, id: tp, col: both.col.id, ids: [b1] }).code, 'bad-args', 'テンプレートが両側のセルを書いた');
  assert.strictEqual(call(db, 'rel.link', { db: B, id: b1, col: both.back.id, ids: [tp] }).code, 'bad-args', 'ほかの行からテンプレートへつないだ');
  assert.deepStrictEqual([snap(db), oplogN(db)], [before, n0], '断ったのに書いた');
  const self = ok(call(db, 'col.add', { db: A, type: 'rel', target: A }), 'col.add 自分').result.col;
  const a1 = ok(call(db, 'row.add', { db: A, title: '自分の行' }), 'row.add').result.id;   // 行の題名（D77 の外）
  assert.strictEqual(call(db, 'rel.link', { db: A, id: tp, col: self.id, ids: [a1] }).code, 'bad-args', 'テンプレートが自分への列1つ（行どうしが互いを指す）を書いた');
  ok(call(db, 'rel.link', { db: A, id: tp, col: one.id, ids: [b1] }), 'rel.link 片側');
  // 前の版の形（テンプレートに両側の値がある）でも、作る行は片側の値だけを持ち、相手の行は作った行を指さない
  db.prepare("update blocks set attrs = json_set(attrs, '$.cells.' || ?, json(?)) where id = ?").run(both.col.id, JSON.stringify([b1]), tp);
  const r = ok(call(db, 'row.fromTpl', { db: A, id: tp }), 'row.fromTpl').result.id;
  const cells = attrsOf(db, r).cells;
  assert.deepStrictEqual([cells[one.id], cells[both.col.id]], [[b1], undefined], '作った行のリレーションの値');
  assert.ok(!JSON.stringify(attrsOf(db, b1).cells || {}).includes(r));
}));

// ---------------------------------------------------------------- 重要 4（R64・R65・F203）
test('rv60 重要 4・F203（R43 の続き）: 親のページごとゴミ箱に入った古い「議事録」は、親を戻すと（restoreGroup の全部を見て）中身を今の方へ移し、役の印を外す', T, () => withDb((db) => {
  meeting(db, 'pb1');
  const OLD = minutesDbs(db)[0];
  const P = ok(call(db, 'page.create', {}), 'page.create').result.id;
  ok(call(db, 'db.setLock', { db: OLD, on: false }), 'db.setLock');
  ok(call(db, 'page.move', { id: OLD, parentId: P }), 'page.move');
  ok(call(db, 'db.setLock', { db: OLD, on: true }), 'db.setLock');
  ok(call(db, 'page.delete', { id: P }), 'page.delete');   // 親ごと（決めたこと 74 の外: 軽い 1 は持ち主が Notion の画面で確かめてから決める）
  meeting(db, 'pb2', { at: '2026-11-11T01:30:00.000Z', date: '2026-11-11' });
  const CUR = minutesDbs(db)[0];
  assert.notStrictEqual(CUR, OLD);
  const r = ok(call(db, 'page.restore', { id: P }), 'page.restore');
  assert.deepStrictEqual(minutesDbs(db), [CUR], '生きた「議事録」が2つ');
  assert.deepStrictEqual([attrsOf(db, OLD).role, parentOf(db, OLD), trashedAt(db, OLD)], [undefined, P, null], '古い方はふつうのデータベースで親の中に戻る');
  assert.deepStrictEqual([parentOf(db, 'pb1'), parentOf(db, 'pb2')], [CUR, CUR], '古い方の議事録が今の方へ移らない');
  assert.strictEqual(db.prepare('select count(*) c from oplog where tx = ?').get(r.tx).c, 1);
  assert.ok(!commands.listedRows(db).some((x) => x.id !== CUR && x.minutes), '一覧に「議事録」の印が2つ');
}));

test('rv60 重要 4・F203（2026-11-15 の持ち主の答え「議事録と同じく今の方へ移す（おすすめ）」）: 古い「タスク管理」をゴミ箱から戻すと、ほかに生きている「タスク管理」があれば、同じ命令で古い方の行（ゴミ箱の行も。テンプレートは除く）を今の方の末尾へ移し、古い方は役の印を外す。番号は今の方の続き・同じ列の値は残る', T, () => withDb((db, t) => {
  const g = firstGather(db, t);
  const OLD = g.tasks;
  meeting(db, 'pc1', { todos: ['見積もりを出す', '資料を集める', '先方に送る'] });
  const r1 = ok(call(db, 'todo.toTask', { pageId: 'pc1', blockId: 'pc1t0' }), 'todo.toTask').result.id;
  const r2 = ok(call(db, 'todo.toTask', { pageId: 'pc1', blockId: 'pc1t1' }), 'todo.toTask').result.id;
  ok(call(db, 'rows.trash', { db: OLD, ids: [r2] }), 'rows.trash');
  const pri = attrsOf(db, OLD).cols.find((c) => c.name === '優先度').id;
  ok(call(db, 'row.setCell', { db: OLD, id: r1, col: pri, value: 'o4' }), 'row.setCell');
  const tp = ok(call(db, 'tpl.add', { db: OLD, title: '見本' }), 'tpl.add').result.id;   // テンプレートの題名（D77 の外）
  ok(call(db, 'page.delete', { id: OLD }), 'page.delete');
  const r3 = ok(call(db, 'todo.toTask', { pageId: 'pc1', blockId: 'pc1t2' }), 'todo.toTask').result;   // 「タスク管理」を作り直す（R56）
  const CUR = r3.db;
  assert.notStrictEqual(CUR, OLD);
  const curShape = { cols: attrsOf(db, CUR).cols, views: attrsOf(db, CUR).views };
  const r = ok(call(db, 'page.restore', { id: OLD }), 'page.restore');
  assert.deepStrictEqual(tasksDbs(db), [CUR], '生きた「タスク管理」が2つ');
  assert.deepStrictEqual([attrsOf(db, OLD).role, attrsOf(db, OLD).kind, trashedAt(db, OLD)], [undefined, 'database', null], '古い方はふつうのデータベース');
  assert.deepStrictEqual({ cols: attrsOf(db, CUR).cols, views: attrsOf(db, CUR).views }, curShape, '今の方の列とビューを変えた');
  assert.deepStrictEqual([parentOf(db, r1), parentOf(db, r2), parentOf(db, tp)], [CUR, CUR, OLD], '行が今の方へ移らない（テンプレートは残る）');
  assert.deepStrictEqual([trashedAt(db, r1), Boolean(trashedAt(db, r2))], [null, true], 'ゴミ箱の行はゴミ箱のまま移る');
  const nos = [r3.id, r1, r2].map((id) => attrsOf(db, id).no);
  assert.strictEqual(new Set(nos).size, 3, `番号が重なる: ${nos}`);
  assert.strictEqual(attrsOf(db, CUR).nextNo, Math.max(...nos) + 1);
  assert.strictEqual(attrsOf(db, r1).cells[pri], 'o4', '同じ列（同じ ID・名前・選択肢）の値が消えた');
  const ord = (id) => db.prepare('select ord from blocks where id = ?').get(id).ord;
  assert.ok(ord(r3.id) < ord(r1), '移した行は今の方の末尾');
  assert.strictEqual(db.prepare('select count(*) c from oplog where tx = ?').get(r.tx).c, 1);
  assert.deepStrictEqual(view(db, CUR).rows.map((x) => x.id).sort(), [r1, r3.id].sort());
  assert.strictEqual(attrsOf(db, 'pc1t0').task, r1, 'ToDo の印が移した行を指さない');
  // 次の［タスクにする］は今の方へ
  meeting(db, 'pc2', { at: '2026-11-11T01:30:00.000Z', date: '2026-11-11', todos: ['次の段取り'] });
  assert.strictEqual(ok(call(db, 'todo.toTask', { pageId: 'pc2', blockId: 'pc2t0' }), 'todo.toTask').result.db, CUR);
  // ほかに「タスク管理」が無ければ、今どおり「タスク管理」として戻る
  ok(call(db, 'page.delete', { id: CUR }), 'page.delete');
  ok(call(db, 'page.restore', { id: CUR }), 'page.restore');
  assert.deepStrictEqual([tasksDbs(db), attrsOf(db, CUR).role], [[CUR], 'tasks']);
}));

// ---------------------------------------------------------------- 軽い 4（R72）
test('rv60 軽い 4: 「議事録」を作り直したとき（ロックを外して消した後の締め）と、古い「議事録」を戻して今の方へ移したときに、「タスク管理」の「議事録」の列のつなぐ先を今の「議事録」にする（前の値つきの set）', T, () => withDb((db, t) => {
  const g = firstGather(db, t);
  const K = g.tasks; const OLD = g.db;
  const relOf = () => attrsOf(db, K).cols.find((c) => c.type === 'rel');
  assert.strictEqual(relOf().db, OLD);
  ok(call(db, 'db.setLock', { db: OLD, on: false }), 'db.setLock');
  ok(call(db, 'page.delete', { id: OLD }), 'page.delete');
  const seq0 = db.prepare('select max(seq) s from oplog').get().s;
  meeting(db, 'pd1', { todos: ['見積もりを出す'] });
  const CUR = minutesDbs(db)[0];
  assert.notStrictEqual(CUR, OLD);
  assert.strictEqual(relOf().db, CUR, '新しい「議事録」を作ってもつなぐ先が古いまま');
  const ops = JSON.parse(db.prepare('select ops from oplog where seq > ? order by seq limit 1').get(seq0).ops);
  assert.ok(ops.some((o) => o.op === 'set' && o.id === K && o.key === 'cols' && o.old.find((c) => c.type === 'rel').db === OLD), '前の値つきの set でない');
  const row = ok(call(db, 'todo.toTask', { pageId: 'pd1', blockId: 'pd1t0' }), 'todo.toTask').result.id;
  assert.deepStrictEqual(attrsOf(db, row).cells[relOf().id], ['pd1'], 'タスクの「議事録」が空');
  // 古い方を戻す（R43 で中身が移る）: つなぐ先が古い方を指していれば今の方へ
  db.prepare("update blocks set attrs = json_set(attrs, '$.cols[5].db', ?) where id = ?").run(OLD, K);
  ok(call(db, 'page.restore', { id: OLD }), 'page.restore');
  assert.strictEqual(relOf().db, CUR, '古い「議事録」を戻した後もつなぐ先が古いまま');
}));

// ---------------------------------------------------------------- 軽い 2（R71）
test('rv60 軽い 2: タスクにした ToDo を複製（block.duplicate・blocks.duplicate）しても、写しは task の印を持たない（元は持つ）。貼り付け（block.paste）も印を作らない。タスクの行がゴミ箱なら todo.toTask は新しく作り、印を書き替える', T, () => withDb((db, t) => {
  const g = firstGather(db, t);
  meeting(db, 'pe1', { todos: ['見積もりを出す'] });
  const row = ok(call(db, 'todo.toTask', { pageId: 'pe1', blockId: 'pe1t0' }), 'todo.toTask').result.id;
  const d1 = ok(call(db, 'block.duplicate', { pageId: 'pe1', blockId: 'pe1t0' }), 'block.duplicate').result.blockId;
  const d2 = ok(call(db, 'blocks.duplicate', { pageId: 'pe1', ids: ['pe1t0'] }), 'blocks.duplicate').result.ids[0];
  assert.deepStrictEqual([attrsOf(db, 'pe1t0').task, attrsOf(db, d1).task, attrsOf(db, d2).task], [row, undefined, undefined], '複製に task が写る');
  ok(call(db, 'block.paste', { pageId: 'pe1', blockId: d1, rich: [{ t: '見積もりを出す', m: [] }], at: 7, blocks: [{ type: 'todo', rich: [{ t: '貼った', m: [] }] }] }), 'block.paste');
  const marks = db.prepare("select attrs from blocks where page_id = 'pe1' and type = 'todo'").all().map((r) => JSON.parse(r.attrs).task).filter(Boolean);
  assert.deepStrictEqual(marks, [row], '貼り付けで印が増えた');
  // ゴミ箱のタスクは無い物として扱う
  ok(call(db, 'rows.trash', { db: g.tasks, ids: [row] }), 'rows.trash');
  const again = ok(call(db, 'todo.toTask', { pageId: 'pe1', blockId: 'pe1t0' }), 'todo.toTask');
  assert.notStrictEqual(again.result.id, row, 'ゴミ箱の行の ID を返した');
  assert.deepStrictEqual([attrsOf(db, 'pe1t0').task, trashedAt(db, again.result.id), db.prepare('select count(*) c from oplog where tx = ?').get(again.tx).c], [again.result.id, null, 1]);
}));

// ---------------------------------------------------------------- 軽い 3（R67。2026-11-15 の持ち主の答え「同じ文の ToDo に印を引き継ぐ（おすすめ）」）
test('rv60 軽い 3: 要約の書き戻し（page.put）で、作り直した ToDo の文（前後の空白を除いて1字も同じ）が前の印のある ToDo と同じなら、前から順に最初の1つへ印を引き継ぐ。1つのタスクを2つの ToDo が指さない・文の違う ToDo・印の無かった文には付けない', T, () => withDb((db, t) => {
  firstGather(db, t);
  meeting(db, 'pf1', { todos: ['見積もりを出す', '資料を集める', '見積もりを出す', '先方に送る'] });
  const r0 = ok(call(db, 'todo.toTask', { pageId: 'pf1', blockId: 'pf1t0' }), 'todo.toTask').result.id;
  const r2 = ok(call(db, 'todo.toTask', { pageId: 'pf1', blockId: 'pf1t2' }), 'todo.toTask').result.id;
  const r3 = ok(call(db, 'todo.toTask', { pageId: 'pf1', blockId: 'pf1t3' }), 'todo.toTask').result.id;
  const got = ok(call(db, 'page.get', { id: 'pf1' }, 'main'), 'page.get').result.page;
  const todo = (id, text) => ({ id, type: 'todo', text, checked: false, cites: [] });
  const page = { ...got, blocks: [{ id: 'nh', type: 'heading', text: 'ToDo', cites: [] }, todo('n1', ' 見積もりを出す '), todo('n2', '資料を集める'), todo('n3', '見積もりを出す'), todo('n4', '見積もりを出す'), todo('n5', '先方に送る。'), { ...todo('n6', '先方に送る'), task: r3 }] };
  ok(call(db, 'page.put', { page, baseRev: got.rev }, 'main'), 'page.put');
  const marks = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((id) => attrsOf(db, id).task);
  assert.deepStrictEqual(marks, [r0, undefined, r2, undefined, undefined, r3], '印の引き継ぎ');
}));

// ---------------------------------------------------------------- 軽い 5（R73）・軽い 6（R74）・軽い 7（R75）
test('rv60 軽い 5・決めたこと 69・74: ロック中は、消したテンプレートの作り（tpl.add・tpl.dup の歩み）を Ctrl+Y でやり直さない（stale・何も書かない）', T, () => withDb((db) => {
  const D = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const add = ok(call(db, 'tpl.add', { db: D, title: '見本' }), 'tpl.add');   // テンプレートの題名（D77 の外）
  const undo = ok(call(db, 'edit.revert', { pageId: D, steps: [add.tx] }), 'edit.revert');
  ok(call(db, 'db.setLock', { db: D, on: true }), 'db.setLock');
  const before = snap(db);
  assert.strictEqual(call(db, 'edit.revert', { pageId: D, steps: [undo.tx] }).code, 'stale', 'ロック中にテンプレートの作りをやり直した');
  assert.deepStrictEqual(snap(db), before);
  ok(call(db, 'db.setLock', { db: D, on: false }), 'db.setLock');
  ok(call(db, 'edit.revert', { pageId: D, steps: [undo.tx] }), 'ロックを外せばやり直せる');
}));

test('rv60 軽い 6・R44: rows.trash の送り直しの答えは1回目と同じ（表の行の数だけ。子孫のページを数えない）', T, () => withDb((db) => {
  meeting(db, 'pg1');
  const M = minutesDbs(db)[0];
  ok(call(db, 'page.create', { parentId: 'pg1' }), 'page.create');
  ok(call(db, 'page.create', { parentId: 'pg1' }), 'page.create');
  const first = ok(call(db, 'rows.trash', { db: M, ids: ['pg1'] }), 'rows.trash');
  const again = ok(call(db, 'rows.trash', { db: M, ids: ['pg1'] }, 'app', first.tx), '送り直し');
  assert.deepStrictEqual([first.result, again.result], [{ trashed: 1 }, { trashed: 1 }]);
}));

test('rv60 軽い 7・F202: テンプレートの中にはページを作れない（page.create が bad-args）。テンプレートの中にある子ページは一覧（サイドバー・検索・Claude）に出ない', T, () => withDb((db) => {
  const D = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const tp = ok(call(db, 'tpl.add', { db: D, title: '見本' }), 'tpl.add').result.id;   // テンプレートの題名（D77 の外）
  assert.strictEqual(call(db, 'page.create', { parentId: tp }).code, 'bad-args', 'テンプレートの中にページを作れた');
  const r = ok(call(db, 'row.add', { db: D, title: '一' }), 'row.add').result.id;   // 行の題名（D77 の外）
  const kid = ok(call(db, 'page.create', { parentId: r }), 'page.create').result.id;
  assert.ok(commands.listedRows(db).some((x) => x.id === kid), '前提: 行の中のページは一覧にある');
  db.prepare("update blocks set attrs = json_set(attrs, '$.tpl', json('true')) where id = ?").run(r);   // 前の版で作った形（行の中のページを持つテンプレート）
  assert.ok(!commands.listedRows(db).some((x) => x.id === kid), 'テンプレートの中の子ページが一覧に出た');
}));
