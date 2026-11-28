/* stage182.db.test.js — 0.18.2（計画 docs/plans/2026-11-28-182.md）の DB の側
 *  TD-1（決めたこと 1・2・F261〜F263）: 最初の起動の移し替え（minutes.gather の first）で「タスク管理」を作らない。起動の送る条件（src/db/server.js）は
 *  「議事録」の移し替えの要るときだけ。作るのは［タスクにする］（todo.toTask）と Claude の make_task（mcp.makeTask）の1回の中だけ
 *  TD-2（決めたこと 3〜5・F264・F265）: todo.toTask の答えの made（その1回で「タスク管理」を作ったときだけ真）。前の版で作られた「タスク管理」（空・使っているもの）は
 *  更新の起動でそのまま残る（AQ182-2）。Ctrl+Z は今のまま（AQ182-3: 作った「タスク管理」は戻さない）
 * 議事録の題名は titleAt の形。データベース・行の題名は作った物で、実在の人名・社名は使わない。
 */
'use strict';
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');
const { MessageChannel } = require('node:worker_threads');
const { tmpDb, tmpData, samplePage, electronShape } = require('./helpers/dbtmp');
const { titleAt } = require('./helpers/titles');
const core = require('../src/db/core');
const C = require('../src/db/commands');
const DV = require('../src/dbView');
const { startServer } = require('../src/db/server');

let clock = Date.parse('2026-11-28T01:00:00.000Z');
const now = () => new Date(clock);
const tick = () => { clock += 60000; return new Date(clock).toISOString(); };
let n = 0;
const txOf = (role) => `${role[0]}:t182-${String(++n).padStart(6, '0')}`;
const call = (db, cmd, args, role = 'app', tx = txOf(role)) => { tick(); return { ...core.call(db, { role, cmd, args, tx }, { now, labels: {} }), tx }; };
const ok = (r, what) => { assert.strictEqual(r.ok, true, `${what}: ${r.code}`); return r; };
const T = { timeout: 30000 };
const attrsOf = (db, id) => JSON.parse(db.prepare('select attrs from blocks where id = ?').get(id).attrs);
function withDb(fn) {
  const t = tmpDb();
  try { const { db } = t.open(); return fn(db, t); } finally { t.done(); }
}
const byRole = (role) => (db) => db.prepare(`select id, attrs from blocks where type = 'page' and trashed_at is null and instr(attrs, '"${role}"') > 0`).all()
  .filter((r) => { try { return JSON.parse(r.attrs).role === role; } catch (_) { return false; } }).map((r) => r.id);
const tasksDbs = byRole('tasks');
const minutesDbs = byRole('minutes');
const metaOf = (db, key) => { const r = db.prepare('select value from meta where key = ?').get(key); return r ? r.value : undefined; };
const rowRole = (row) => { const a = typeof row.attrs === 'string' ? JSON.parse(row.attrs) : row.attrs; return a && a.role; };
const gatherLogs = (db) => db.prepare("select ops from oplog where action = 'minutes.gather' order by seq").all().map((r) => JSON.parse(r.ops));
// 0.16.0 までの最上位の締めた議事録（移す前の形。種は oplog を書かない）
function oldMeeting(t, id, i) {
  const at = new Date(Date.parse('2026-10-01T01:00:00.000Z') + i * 3600000 * 7).toISOString();
  const { page, segments } = samplePage(id);
  page.title = titleAt(at); page.createdAt = at; page.updatedAt = at; page.date = at.slice(0, 10);
  for (const b of page.blocks) b.id = `${id}${b.id}`;
  t.seed(page, segments.map((s) => ({ ...s, id: `${id}${s.id}` })));
  return id;
}
// 要約に ToDo の行のある締めた議事録（meeting.finalize）
function todoMeeting(db, id, todos) {
  const at = '2026-11-27T01:00:00.000Z';
  const page = { title: titleAt(at), date: '2026-11-27', createdAt: at, blocks: [{ id: `${id}h`, type: 'heading', text: 'ToDo' },
    ...todos.map((x, i) => ({ id: `${id}t${i}`, type: 'todo', text: x, checked: false }))] };
  ok(call(db, 'meeting.finalize', { pageId: id, page, segments: [] }, 'main'), 'meeting.finalize');
  return id;
}

// ---- 起動の順（src/db/server.js）: 取り込み → 控え → 移し替え（初めて）か見回り
async function waitFor(pred, what, ms = 15000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`待ちきれない: ${what}`);
    await new Promise((res) => setTimeout(res, 10));
  }
}
function boot(d, opts = {}) {
  const fromServer = [];
  const parent = electronShape.parent((x) => fromServer.push(x));
  startServer({ parentPort: parent, sqlite, ...opts });
  parent.emit({ type: 'init', dataDir: d.dataDir, labels: {}, network: false });
  const clients = [];
  const port = (role) => {
    const ch = new MessageChannel();
    parent.emit({ type: 'port', role }, [electronShape.port(ch.port1)]);
    const c = electronShape.client(ch.port2);
    clients.push(c);
    return c;
  };
  const ready = () => waitFor(() => fromServer.some((x) => x.type === 'ready'), 'ready');
  const stop = async () => {
    parent.emit({ type: 'close' });
    await waitFor(() => fromServer.some((x) => x.type === 'closed'), 'closed');
    for (const c of clients.splice(0)) c.close();
  };
  const logs = () => fromServer.filter((x) => x.type === 'log').map((x) => x.line);
  return { port, ready, stop, logs };
}
const status = async (s) => (await s.port('main').ask({ id: 1, cmd: 'db.status', args: {} })).result;
const backups = (d, kind) => { try { return fs.readdirSync(path.join(d.dataDir, 'backup')).filter((x) => x.endsWith(`-${kind}.db.gz`)); } catch (_) { return []; } };
function peekDb(d, fn) {
  const c = core.open({ sqlite, file: d.file });
  try { return fn(c.db); } finally { c.db.close(); }
}
function addOld(d, id, i) {
  peekDb(d, (db) => oldMeeting({ seed: (page, segs) => C.putPageRows(db, page, segs) }, id, i));
}

// ---------------------------------------------------------------- TD-1（決めたこと 1・2）
test('TD-1・F261: 新しく入れた PC（DB が空）の最初の起動は「議事録」だけを作り、「タスク管理」を作らない。meta の minutes.gathered は今どおり書き、二度目・三度目の起動では移し替えの命令を送らない', { timeout: 60000 }, async () => {
  const d = tmpData({ pages: 0 });
  d.close();
  try {
    let s = boot(d, { runCheck: async () => 'ok' });
    try {
      await s.ready();
      const st = await status(s);
      assert.deepStrictEqual([st.startup.minutes.first, st.startup.minutes.moved], [true, 0]);
    } finally { await s.stop(); }
    peekDb(d, (db) => {
      assert.deepStrictEqual(tasksDbs(db), [], '最初の起動で「タスク管理」を作った');
      assert.strictEqual(minutesDbs(db).length, 1, '「議事録」（0.17.0 の決めたこと 49 のまま）');
      assert.deepStrictEqual(JSON.parse(metaOf(db, 'minutes.gathered')).n, 0, 'minutes.gathered を書かない（毎回送り続ける）');
      assert.ok(gatherLogs(db).flat().every((o) => !(o.op === 'add' && o.row && rowRole(o.row) === 'tasks')), '移し替えの行に「タスク管理」の add');
    });
    const seq = peekDb(d, (db) => db.prepare('select coalesce(max(seq), 0) s from oplog').get().s);
    for (let i = 0; i < 2; i += 1) {
      s = boot(d, { runCheck: async () => 'ok' });
      try {
        await s.ready();
        const st = await status(s);
        assert.deepStrictEqual([st.startup.minutes.first, st.startup.minutes.moved, st.startup.minutes.created], [false, 0, false]);
      } finally { await s.stop(); }
    }
    peekDb(d, (db) => {
      assert.deepStrictEqual(tasksDbs(db), [], '起動を繰り返して「タスク管理」を作った');
      assert.strictEqual(db.prepare('select count(*) c from oplog where seq > ?').get(seq).c, 0, '二度目からの起動で命令を送った');
    });
  } finally { d.done(); }
});

test('TD-1・F261: 「議事録」がもうあり（締めが作った）「タスク管理」が無い PC の最初の起動は、移す物が無ければ命令を送らずに minutes.gathered（数 0）だけを書く（空の oplog の行を積まない）', { timeout: 60000 }, async () => {
  const d = tmpData({ pages: 1 });
  const before = [minutesDbs(d.db), tasksDbs(d.db), metaOf(d.db, 'minutes.gathered'), d.lastSeq()];
  d.close();
  try {
    assert.deepStrictEqual([before[0].length, before[1], before[2]], [1, [], undefined], '前提: 締めが「議事録」を作り、移し替えはまだ');
    const s = boot(d, { runCheck: async () => 'ok' });
    try {
      await s.ready();
      const st = await status(s);
      assert.deepStrictEqual(st.startup.minutes, { first: true, moved: 0, skipped: 0, created: false, db: null }, '命令を送った');
      assert.ok(s.logs().every((x) => !x.startsWith('DB: 議事録 移した')), s.logs().join('\n'));
    } finally { await s.stop(); }
    peekDb(d, (db) => {
      assert.deepStrictEqual(tasksDbs(db), [], '「タスク管理」を作った');
      assert.strictEqual(db.prepare('select count(*) c from oplog where seq > ?').get(before[3]).c, 0, '空の oplog の行を積んだ');
      assert.strictEqual(JSON.parse(metaOf(db, 'minutes.gathered')).n, 0);
    });
  } finally { d.done(); }
});

test('TD-1・F262: 0.16.0 以前からの更新の最初の移し替えは、今どおり確かめ済みの控えを取ってから1つの oplog の行で議事録を「議事録」へ移し、「タスク管理」だけを作らない', { timeout: 60000 }, async () => {
  const d = tmpData({ pages: 0 });
  d.close();
  try {
    for (let i = 0; i < 3; i += 1) addOld(d, `pq${i}`, i);
    const s = boot(d, { runCheck: async () => 'ok' });
    try {
      await s.ready();
      const st = await status(s);
      assert.deepStrictEqual([st.startup.minutes.first, st.startup.minutes.moved, st.startup.minutes.created], [true, 3, true]);
      assert.strictEqual(backups(d, 'upgrade').length, 1, '移す前の控えが無い');
      assert.ok(s.logs().some((x) => x === 'DB: 議事録 移した 3・残した 0・データベースを作った'), s.logs().join('\n'));
    } finally { await s.stop(); }
    peekDb(d, (db) => {
      const M = minutesDbs(db)[0];
      assert.deepStrictEqual(['pq0', 'pq1', 'pq2'].map((id) => db.prepare('select parent_id from blocks where id = ?').get(id).parent_id), [M, M, M]);
      assert.deepStrictEqual(tasksDbs(db), [], '更新の移し替えで「タスク管理」を作った');
      const logs = gatherLogs(db);
      assert.strictEqual(logs.length, 1, '移し替えが1つの oplog の行でない');
      assert.deepStrictEqual(logs[0].map((o) => o.op).sort(), ['add', 'move', 'move', 'move'], '移し替えの行の操作（「議事録」の add と move だけ）');
    });
  } finally { d.done(); }
});

test('TD-1・F262: minutes.gather（first）は議事録を移して「議事録」を作るだけで、「タスク管理」の無い DB にも作らない。二度目・見回りも作らない', T, () => withDb((db, t) => {
  oldMeeting(t, 'pt0', 0);
  oldMeeting(t, 'pt1', 1);
  const g = ok(call(db, 'minutes.gather', { first: true }, 'main'), 'minutes.gather');
  assert.deepStrictEqual([g.result.moved, g.result.created], [2, true]);
  assert.deepStrictEqual(tasksDbs(db), [], '最初の移し替えで「タスク管理」を作った');
  assert.ok(!g.changed.pageIds.some((id) => tasksDbs(db).includes(id)));
  oldMeeting(t, 'pt2', 2);
  ok(call(db, 'minutes.gather', {}, 'main'), '見回り');
  ok(call(db, 'minutes.gather', { first: true }, 'main'), '二度目の最初の移し替え（控えから戻した: minutes.gathered の無い控え）');
  assert.deepStrictEqual(tasksDbs(db), [], '見回り・二度目で「タスク管理」を作った');
}));

test('TD-1・F263: 最初の移し替えの後の「タスク管理」の無い PC で、初めての［タスクにする］（todo.toTask）は1つの命令（oplog の1行）で「タスク管理」（「議事録」の下に固定する役の印・列・ビューは 0.17.0 のまま）と行を作る。二度目は作らない', T, () => withDb((db, t) => {
  oldMeeting(t, 'pz0', 0);
  const M = ok(call(db, 'minutes.gather', { first: true }, 'main'), 'minutes.gather').result.db;
  assert.deepStrictEqual(tasksDbs(db), [], '前提: 「タスク管理」が無い');
  todoMeeting(db, 'pw1', ['見積もりを出す', '資料を集める']);
  const seq = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
  const r = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }), 'todo.toTask');
  const K = tasksDbs(db);
  assert.strictEqual(K.length, 1, '「タスク管理」を作らない');
  assert.strictEqual(r.result.db, K[0]);
  assert.deepStrictEqual(db.prepare('select tx, action from oplog where seq > ?').all(seq).map((x) => [x.tx, x.action]), [[r.tx, 'todo.toTask']], '1つの命令でない');
  assert.deepStrictEqual([db.prepare('select type, parent_id, text from blocks where id = ?').get(r.result.id)].map((x) => [x.type, x.parent_id, x.text])[0], ['row', K[0], '見積もりを出す']);
  assert.strictEqual(attrsOf(db, 'pw1t0').task, r.result.id, 'ToDo に印が無い');
  const a = attrsOf(db, K[0]);
  assert.deepStrictEqual([db.prepare('select text, parent_id from blocks where id = ?').get(K[0]).text, a.kind, a.role, a.locked], ['タスク管理', 'database', 'tasks', undefined]);
  assert.deepStrictEqual(a.cols.map((c) => [c.name, c.type]), [['名前', 'title'], ['ステータス', 'status'], ['担当', 'person'], ['期限', 'date'], ['優先度', 'select'], ['議事録', 'rel']]);
  assert.deepStrictEqual([a.cols[5].db, a.cols[5].back], [M, undefined], '「議事録」への片側のリレーションでない');
  assert.deepStrictEqual(a.views.map((v) => v.name), ['すべて', 'マイタスク', '期限順']);
  for (const v of a.views) assert.deepStrictEqual(DV.normalizeView(v, a.cols).view, v, `${v.name} のビューの形が照らしで変わる`);
  assert.ok(ok(call(db, 'pages.list', {}), 'pages.list').result.some((p) => p.id === K[0] && p.tasks === true), 'サイドバーの「タスク管理」の印が無い');
  // 二度目（別の ToDo）は同じ「タスク管理」に
  const r2 = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t1' }), 'todo.toTask');
  assert.strictEqual(r2.result.db, K[0]);
  assert.deepStrictEqual(tasksDbs(db), K, '「タスク管理」を2つ作った');
}));

test('TD-1・F263: 最初の移し替えの後の「タスク管理」の無い PC で、Claude の make_task（mcp.makeTask）も1つの命令で「タスク管理」と行を作る（答えは今どおり made 真）', T, () => withDb((db, t) => {
  oldMeeting(t, 'pz0', 0);
  ok(call(db, 'minutes.gather', { first: true }, 'main'), 'minutes.gather');
  todoMeeting(db, 'pw1', ['見積もりを出す']);
  assert.deepStrictEqual(tasksDbs(db), [], '前提: 「タスク管理」が無い');
  const seq = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
  const r = ok(call(db, 'mcp.makeTask', { pageId: 'pw1', blockId: 'pw1t0' }, 'mcp'), 'mcp.makeTask');
  const K = tasksDbs(db);
  assert.strictEqual(K.length, 1, '「タスク管理」を作らない');
  assert.deepStrictEqual(r.result, { id: r.result.id, db: K[0], made: true });
  assert.deepStrictEqual(db.prepare('select action from oplog where seq > ?').all(seq).map((x) => x.action), ['mcp.makeTask'], '1つの命令でない');
  assert.strictEqual(db.prepare('select parent_id from blocks where id = ?').get(r.result.id).parent_id, K[0]);
}));

// ---------------------------------------------------------------- TD-2（決めたこと 3〜5）
test('TD-2・F265: todo.toTask の答えの made は、その1回で「タスク管理」を作ったときだけ真（初めての押し・送り直し・「タスク管理」をゴミ箱に入れた後の押し）。二度目・ゴミ箱の行を作り直す（「タスク管理」はある）・もうタスクのある ToDo では付かない', T, () => withDb((db, t) => {
  oldMeeting(t, 'pz0', 0);
  ok(call(db, 'minutes.gather', { first: true }, 'main'), 'minutes.gather');
  todoMeeting(db, 'pw1', ['見積もりを出す', '資料を集める', '先方に送る']);
  const r1 = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }), '初めての［タスクにする］');
  const K = r1.result.db;
  assert.deepStrictEqual(r1.result, { id: r1.result.id, db: K, made: true }, '初めての押しで made が無い');
  const re = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }, 'app', r1.tx), '送り直し');
  assert.deepStrictEqual([re.dup, re.result], [true, { id: r1.result.id, db: K, made: true }], '送り直しの答えに made が無い');
  const r2 = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t1' }), '二度目');
  assert.deepStrictEqual(r2.result, { id: r2.result.id, db: K }, '二度目に made が付いた');
  const re2 = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t1' }, 'app', r2.tx), '二度目の送り直し');
  assert.deepStrictEqual(re2.result, { id: r2.result.id, db: K }, '二度目の送り直しに made が付いた');
  assert.deepStrictEqual(ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }), 'もうタスクのある ToDo').result, { id: r1.result.id, db: K });
  // ゴミ箱のタスクを作り直す（「タスク管理」はある）
  ok(call(db, 'rows.trash', { db: K, ids: [r1.result.id] }), 'rows.trash');
  const again = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }), 'ゴミ箱の行を作り直す');
  assert.deepStrictEqual(again.result, { id: again.result.id, db: K }, 'ゴミ箱の行を作り直して made が付いた');
  assert.notStrictEqual(again.result.id, r1.result.id);
  // 「タスク管理」をゴミ箱に入れた後は作り直す（made 真）
  ok(call(db, 'page.delete', { id: K }), 'page.delete');
  const fresh = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t2' }), '「タスク管理」がゴミ箱');
  assert.notStrictEqual(fresh.result.db, K);
  assert.deepStrictEqual(fresh.result, { id: fresh.result.id, db: fresh.result.db, made: true });
  assert.deepStrictEqual(tasksDbs(db), [fresh.result.db]);
}));

test('TD-2・F265（決めたこと 4・AQ182-3）: 初めての［タスクにする］の Ctrl+Z（edit.revert）は今のまま、行をゴミ箱へ・ToDo の印を前へ戻し、作った「タスク管理」は空で残る。もう一度押すと同じ「タスク管理」に作り、made は付かない', T, () => withDb((db, t) => {
  oldMeeting(t, 'pz0', 0);
  ok(call(db, 'minutes.gather', { first: true }, 'main'), 'minutes.gather');
  todoMeeting(db, 'pw1', ['見積もりを出す']);
  const r = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }), 'todo.toTask');
  const K = r.result.db;
  ok(call(db, 'edit.revert', { pageId: 'pw1', steps: [r.tx] }), 'edit.revert');
  assert.deepStrictEqual([Boolean(db.prepare('select trashed_at from blocks where id = ?').get(r.result.id).trashed_at), attrsOf(db, 'pw1t0').task], [true, undefined], 'Ctrl+Z で行と印が戻らない');
  assert.deepStrictEqual(tasksDbs(db), [K], 'Ctrl+Z で「タスク管理」を戻した');
  const r2 = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }), 'もう一度');
  assert.deepStrictEqual(r2.result, { id: r2.result.id, db: K });
}));

// 前の版（0.17.0〜0.18.1）の最初の移し替えが作った形の「タスク管理」の行を、別の DB で初めての［タスクにする］に作らせてから写す（行の無い・手を付けていない形）
function oldTasksRow() {
  const t = tmpDb();
  try {
    const { db } = t.open();
    todoMeeting(db, 'px1', ['写すためだけの ToDo']);
    const K = ok(call(db, 'todo.toTask', { pageId: 'px1', blockId: 'px1t0' }), 'todo.toTask').result.db;
    const row = { ...db.prepare('select * from blocks where id = ?').get(K) };
    delete row.rid;
    row.attrs = JSON.stringify({ ...JSON.parse(row.attrs), nextNo: 1 });
    return row;
  } finally { t.done(); }
}
const insertRow = (db, row) => db.prepare(`insert into blocks(${Object.keys(row).join(', ')}) values (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
const rowsOf = (db, ids) => ids.map((id) => { const r = { ...db.prepare('select * from blocks where id = ?').get(id) }; delete r.rid; return r; });

test('TD-2・F264（決めたこと 3・AQ182-2）: 前の版で作られた「タスク管理」は、0.18.2 の起動でそのまま残る。手を付けていない空のもの（移し替えの済んだ DB）も、使っているもの（行と ToDo の印）も、行の欄・列・ビュー・番号・rev が1字も同じで、命令も送らない', { timeout: 60000 }, async () => {
  const old = oldTasksRow();
  // 空の「タスク管理」（前の版の最初の移し替えが作り、手を付けていない）
  const a = tmpData({ pages: 1 });
  insertRow(a.db, old);
  a.db.prepare("insert into meta(key, value) values ('minutes.gathered', ?)").run(JSON.stringify({ n: 0, at: '2026-11-20T00:00:00.000Z' }));
  const beforeA = [rowsOf(a.db, [old.id]), a.lastSeq()];
  a.close();
  // 使っている「タスク管理」（［タスクにする］の行と ToDo の印。0.16.0 から更新した最初の移し替えの前の形: 最上位の議事録が残っている）
  const b = tmpData({ pages: 0 });
  todoMeeting(b.db, 'pw1', ['見積もりを出す']);
  const r = ok(call(b.db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }), 'todo.toTask').result;
  const K = r.db;
  b.db.prepare('delete from meta where key = ?').run('minutes.gathered');
  b.close();
  addOld(b, 'pq0', 0);
  const beforeB = peekDb(b, (db) => rowsOf(db, [K, r.id, 'pw1t0']));
  try {
    for (const [d, runCheck] of [[a, async () => 'ok'], [b, async () => 'ok']]) {
      for (let i = 0; i < 2; i += 1) {
        const s = boot(d, { runCheck });
        try { await s.ready(); assert.ok((await status(s)).startup.minutes, '起動の移し替えの答えが無い'); } finally { await s.stop(); }
      }
    }
    peekDb(a, (db) => {
      assert.deepStrictEqual([rowsOf(db, [old.id]), db.prepare('select coalesce(max(seq), 0) s from oplog').get().s], beforeA, '空の「タスク管理」を書き替えた・命令を送った');
      assert.deepStrictEqual(tasksDbs(db), [old.id]);
    });
    peekDb(b, (db) => {
      assert.deepStrictEqual(rowsOf(db, [K, r.id, 'pw1t0']), beforeB, '使っている「タスク管理」・タスクの行・ToDo の印を書き替えた');
      assert.deepStrictEqual(tasksDbs(db), [K], '「タスク管理」を2つにした・消した');
      assert.strictEqual(db.prepare('select parent_id from blocks where id = ?').get('pq0').parent_id, minutesDbs(db)[0], '前提: 最初の移し替えで議事録を移していない');
    });
  } finally { a.done(); b.done(); }
});
