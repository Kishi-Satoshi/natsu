/*
 * stage160.db.test.js — 0.16.0「データベース」の DB の命令と保存の形（計画 docs/plans/2026-11-04-160.md の Task DS-2 から）
 * DS-2: データベースの行を新しい型 row で持つ（ページとして開けて書ける・書くと rev が上がる・検索の欄に題名とセルの文字）。
 *       行が1万あっても、今の一覧・木・ゴミ箱・会議の見回り・アクション一覧・MCP の一覧は行が無いときと同じ。表の形の版は上げない。
 *       控えに後の oplog（行の add・set・text・trash・restore）を当て直すと今の表と同じ（T4b）。
 * 行はまだ命令が無い（DS-3 の row.add）ので、試しの命令（core.registerForTest）で ops.rowBlock の行を足す。
 * 一時の DB（helpers/dbtmp）。データベース・列・行の名前は作った物で、実在の人名・社名は使わない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const sqlite = require('node:sqlite');
const { tmpDb, samplePage } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const C = require('../src/db/commands');
const schema = require('../src/db/schema');
const ops = require('../src/db/ops');
const { searchFold } = require('../src/cite');
const tools = require('../src/mcp/tools');
const PT = require('../src/pageTree');

const T = { timeout: 120000 };
let clock = Date.parse('2026-11-07T01:00:00.000Z');
const now = () => new Date(clock);
const at = () => { clock += 60000; return new Date(clock).toISOString(); };
let n = 0;
const txOf = (role) => `${role[0]}:ds2-${String(++n).padStart(6, '0')}`;
const call = (db, cmd, args, role = 'app') => core.call(db, { role, cmd, args, tx: txOf(role) }, { now, labels: {} });
const ok = (r, what) => { assert.strictEqual(r.ok, true, `${what}: ${r.code}`); return r.result; };
const dump = (c) => [
  c.prepare('select id, type, page_id, parent_id, ord, text, rich, attrs, fold, rev, created_at, updated_at, trashed_at from blocks order by id').all(),
  c.prepare('select page_id, id, n, at_ms, duration_ms, text, fold, failed, extra from segments order by page_id, id').all(),
].map((list) => list.map((r) => ({ ...r })));
const blockOf = (db, id) => db.prepare('select id, type, page_id, parent_id, ord, text, attrs, fold, rev, trashed_at from blocks where id = ?').get(id);

// 試しの命令: 渡した操作の列をそのまま当てて oplog の1行にする（行を足す命令は DS-3 で作る）
let pending = [];
core.registerForTest({
  'test160.ops': { roles: ['app'], write: true, args: {}, pageOf: () => null,
    run: (db) => { const list = pending; pending = []; ops.applyOps(db, list); return { ops: list, pageIds: [], result: null }; } },
});
const put = (db, list) => { pending = list; ok(call(db, 'test160.ops', {}), 'test160.ops'); };

// データベースのページ（題名の列・テキストの列・選択の列）と行
const COLS = [
  { id: 'title', name: '名前', type: 'title' },
  { id: 'c1', name: 'メモ', type: 'text' },
  { id: 'c2', name: '優先度', type: 'select', opts: [{ id: 'o1', name: '高', color: 'red' }, { id: 'o2', name: '低', color: 'default' }] },
];
const dbPage = (id, title) => {
  const t = at();
  return { op: 'add', id, row: ops.pageRow({ id, title, kind: 'database', cols: COLS, views: [], nextNo: 1, createdAt: t, updatedAt: t }) };
};
const rowAdd = (id, dbId, ord, title, cells = {}, no = 1) => ({ op: 'add', id, row: ops.rowBlock({ id, db: dbId, ord, title, cells, by: { c: 'me', u: 'me' }, no, at: at() }) });
const pageOf = (id) => {
  const { page, segments } = samplePage(id);
  page.blocks = page.blocks.map((b) => ({ ...b, id: `${id}${b.id}` }));
  return { page, segments };
};
function withDb(fn) {
  const t = tmpDb();
  try {
    const { db } = t.open();
    for (const id of ['pa1', 'pa2']) { const s = pageOf(id); t.seed(s.page, s.segments); }
    return fn(db, t);
  } finally { t.done(); }
}

test('DS-2: ops.rowBlock は型 row の行（page_id は自分・parent_id はデータベース・セルと作成者と番号は attrs）。isDocType は page と row だけ', () => {
  // データベースの行の題名（D77 の会議の題名でない）
  const r = ops.rowBlock({ id: 'r1', db: 'pdb', ord: 'i', title: '見積もり', cells: { c1: 'x' }, by: { c: 'me', u: 'claude' }, no: 3, at: '2026-11-07T00:00:00.000Z' });
  assert.deepStrictEqual(r, {
    id: 'r1', type: 'row', page_id: 'r1', parent_id: 'pdb', ord: 'i', text: '見積もり', rich: null,
    attrs: { cells: { c1: 'x' }, by: { c: 'me', u: 'claude' }, no: 3 },
    rev: 1, created_at: '2026-11-07T00:00:00.000Z', updated_at: '2026-11-07T00:00:00.000Z', trashed_at: null,
  });
  assert.deepStrictEqual(['page', 'row', 'paragraph', 'subpage', 'todo', '', undefined].map(ops.isDocType), [true, true, false, false, false, false, false]);
});

test('DS-2・F136: 型 row の行は page.get で読め（セル・番号・作成者も）、本文の block.insert が書け、書くと行の rev が上がる。fold に題名とテキストのセルと選択肢の名前', T, () => withDb((db) => {
  put(db, [dbPage('pdb', 'タスク'), rowAdd('r1', 'pdb', 'i', '見積もりの依頼', { c1: '前提の確認', c2: 'o1' })]);
  // 足したときの検索の欄（題名・テキストのセル・選択肢の名前を1つずつ。欄をまたいで当たらない）と rev（足した命令では 1 のまま）
  const fold0 = blockOf(db, 'r1').fold;
  for (const w of ['見積もりの依頼', '前提の確認', '高']) assert.ok(fold0.includes(searchFold(w)), `足した行の fold に ${w}`);
  assert.ok(!fold0.includes(searchFold('確認高')) && !fold0.includes(searchFold('依頼前提')), '欄をまたいで当たる');
  assert.strictEqual(blockOf(db, 'r1').rev, 1, '足した行の rev');
  const p = ok(call(db, 'page.get', { id: 'r1' }), 'page.get').page;
  assert.strictEqual(p.id, 'r1');
  assert.strictEqual(p.title, '見積もりの依頼');
  assert.deepStrictEqual(p.cells, { c1: '前提の確認', c2: 'o1' });
  assert.deepStrictEqual([p.no, p.by], [1, { c: 'me', u: 'me' }]);
  assert.deepStrictEqual(p.blocks, []);
  const rev0 = blockOf(db, 'r1').rev;
  const b = ok(call(db, 'block.insert', { pageId: 'r1', afterBlockId: '', type: 'paragraph' }), 'block.insert');
  ok(call(db, 'block.update', { pageId: 'r1', blockId: b.blockId, patch: { text: '行の本文' } }), 'block.update');
  assert.strictEqual(blockOf(db, b.blockId).page_id, 'r1');
  assert.strictEqual(blockOf(db, 'r1').rev, rev0 + 2, '本文を書くたびに行の rev が上がる');
  assert.deepStrictEqual(ok(call(db, 'page.get', { id: 'r1' }), 'page.get').page.blocks.map((x) => x.text), ['行の本文']);
  // 検索の欄: 題名・テキストのセル・選択肢の名前
  const fold = blockOf(db, 'r1').fold;
  for (const w of ['見積もりの依頼', '前提の確認', '高']) assert.ok(fold.includes(searchFold(w)), `fold に ${w}`);
  assert.ok(!fold.includes('o1'), '選択肢の ID は入れない');
  // 題名を変えると fold も変わる
  put(db, [{ op: 'text', id: 'r1', value: '発注の依頼', old: '見積もりの依頼' }]);
  assert.ok(blockOf(db, 'r1').fold.includes(searchFold('発注の依頼')));
  assert.ok(!blockOf(db, 'r1').fold.includes(searchFold('見積もりの依頼')));
  // データベースのページの fold は今のページと同じ（題名とメモ）
  assert.strictEqual(blockOf(db, 'pdb').fold, `${searchFold('タスク')}\u0001`);
  // ゴミ箱の行は page.get で読めない（ページと同じ）・行でもページでもない行は今どおり読めない
  put(db, [{ op: 'trash', id: 'r1', at: at(), old: null }]);
  assert.strictEqual(ok(call(db, 'page.get', { id: 'r1' }), 'page.get'), null);
  assert.strictEqual(ok(call(db, 'page.get', { id: b.blockId }), 'page.get'), null);
}));

test('DS-2・F135・RF17: 行が1万あっても、pages.list・listedRows・木の行・pages.trash・pages.typeSlots・pages.summaryWaits・pages.actionView・MCP の list_meetings は行が無いときと同じ（行はサイドバーの木にも出ない）', T, () => withDb((db, t) => {
  put(db, [dbPage('pdb', 'タスク')]);
  ok(call(db, 'page.delete', { id: 'pa2' }), 'page.delete');
  // 読み手を軽い順に並べ、1つずつ比べる（行が一覧に漏れる壊れ方では、重い読み手に1万の行を渡す前に赤で止まる。
  // 漏れた1万の行を MCP や木の読み手に全部渡すと、変異確認の CI で数 GB を使い切るため: DS-2 直し）
  const READERS = [
    ['listed', () => C.listedRows(db)],
    ['list', () => ok(call(db, 'pages.list', {}), 'pages.list')],
    ['tree', () => db.prepare(C.HOT_QUERIES.pageRows).all().map((r) => ({ ...r }))],
    ['slots', () => ok(call(db, 'pages.typeSlots', { since: '2000-01-01' }, 'main'), 'pages.typeSlots')],
    ['waits', () => ok(call(db, 'pages.summaryWaits', {}, 'main'), 'pages.summaryWaits')],
    ['actions', () => ok(call(db, 'pages.actionView', {}), 'pages.actionView')],
    ['trash', () => ok(call(db, 'pages.trash', {}), 'pages.trash')],
    ['mcp', () => tools.callTool('list_meetings', {}, { sqlite, dataDir: path.dirname(t.file), now: () => new Date('2026-11-07T00:00:00.000Z') }).text],
  ];
  const before = Object.fromEntries(READERS.map(([k, read]) => [k, read()]));
  assert.ok(before.list.some((p) => p.id === 'pdb'), 'データベースのページは一覧に出る');
  const rows = [];
  for (let i = 0; i < 10000; i += 1) rows.push(rowAdd(`r${i}`, 'pdb', `k${String(i).padStart(5, '0')}`, `行 ${i}`, { c1: `メモ ${i}`, c2: i % 2 ? 'o1' : 'o2' }, i + 1));
  put(db, rows);
  // ゴミ箱の行と、ToDo のある行の本文（アクション一覧に出さない: 決めたこと 54）
  put(db, [{ op: 'trash', id: 'r5', at: at(), old: null }]);
  ok(call(db, 'block.insert', { pageId: 'r7', afterBlockId: '', type: 'todo' }), 'block.insert');
  assert.strictEqual(db.prepare("select count(*) c from blocks where type = 'row'").get().c, 10000);
  const after = {};
  for (const [k, read] of READERS) {
    after[k] = read();
    // 先に数（長さ）を比べる（大きな並びの違いを assert が全部書き出さない）
    if (Array.isArray(before[k]) || typeof before[k] === 'string') assert.strictEqual(after[k].length, before[k].length, `${k} の数が行で変わった`);
    assert.deepStrictEqual(after[k], before[k], `${k} が行で変わった`);
  }
  // サイドバーの木（一覧の行から作る）に行は出ない（前の版の描き方も同じ一覧を読む: RF17）
  const tree = PT.pageTree(after.list);
  assert.ok(!tree.byId.has('r0') && !(tree.kids.get('pdb') || []).length, '木に行が出た');
}));

test('DS-2・P8: 表の形の版は 1 のまま・STEPS は1段（データベースは今の blocks の行と attrs に入れる）', () => {
  assert.strictEqual(core.SCHEMA_VERSION, 1);
  assert.deepStrictEqual(Object.keys(schema.STEPS), ['1']);
});

test('DS-2: T4b: 控えに後の oplog（データベースのページと行の add・set・text・trash・restore・行の本文）を前へ当て直すと今の表と同じ。後ろへ当てると控えの表', T, async () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const s = pageOf('pa1'); t.seed(s.page, s.segments);
    const to = path.join(t.dir, 'copy-160.db');
    await sqlite.backup(db, to);
    const copy = new sqlite.DatabaseSync(to);
    try {
      const base = dump(copy);
      const k = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
      put(db, [dbPage('pdb', 'タスク'), rowAdd('r1', 'pdb', 'i', '見積もり', { c1: '前提' }), rowAdd('r2', 'pdb', 'q', '日程', { c2: 'o2' }, 2)]);
      put(db, [{ op: 'set', id: 'r1', key: 'cells', value: { c1: '前提の確認', c2: 'o1' }, old: { c1: '前提' } }, { op: 'text', id: 'r2', value: '日程の調整', old: '日程' }]);
      const upd = at();
      put(db, [{ op: 'set', id: 'r2', key: 'updatedAt', value: upd, old: db.prepare('select updated_at u from blocks where id = ?').get('r2').u }]);
      const r2 = db.prepare('select updated_at, attrs from blocks where id = ?').get('r2');
      assert.deepStrictEqual([r2.updated_at, 'updatedAt' in JSON.parse(r2.attrs)], [upd, false], '行の最終更新日時は列（attrs に入れない）');
      const b = ok(call(db, 'block.insert', { pageId: 'r1', afterBlockId: '', type: 'paragraph' }), 'block.insert');
      ok(call(db, 'block.update', { pageId: 'r1', blockId: b.blockId, patch: { text: '行の本文' } }), 'block.update');
      const when = at();
      put(db, [{ op: 'trash', id: 'r2', at: when, old: null }]);
      put(db, [{ op: 'restore', id: 'r2', at: null, old: when }]);
      const later = db.prepare('select ops from oplog where seq > ? order by seq').all(k).map((r) => JSON.parse(r.ops));
      for (const o of later) ops.applyOps(copy, o, 'forward');
      assert.deepStrictEqual(dump(copy), dump(db));
      assert.ok(blockOf(copy, 'r1').fold.includes(searchFold('前提の確認')) && blockOf(copy, 'r1').fold.includes(searchFold('高')), '当て直した行の fold');
      for (const o of [...later].reverse()) ops.applyOps(copy, o, 'backward');
      assert.deepStrictEqual(dump(copy), base);
    } finally { copy.close(); }
  } finally { t.done(); }
});
