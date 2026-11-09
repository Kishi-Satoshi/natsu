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
    // 0.16.0 DX-2（決めたこと 44）で意図して直した: ゴミ箱の行のまとまりは pages.trash に出る（kind: 'row'）ので、ページの頭だけを比べ、行は下で見る
    ['trash', () => ok(call(db, 'pages.trash', {}), 'pages.trash').filter((h) => h.kind !== 'row')],
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
  assert.deepStrictEqual(ok(call(db, 'pages.trash', {}), 'pages.trash').filter((h) => h.kind === 'row').map((h) => [h.id, h.count]), [['r5', 0]], 'ゴミ箱の行のまとまりが出ない');
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

// ================================================================ DS-3: データベース・行・列・ビューの命令と速さ（計画の Task DS-3・決めたこと 1〜32・47・48・52）
const fs = require('node:fs');
const vm = require('node:vm');
const DM = require('../src/dbModel');
const { UNDO_CMDS } = require('../src/undoBook');
const PF = require('../tools/perf');
const { LIMITS } = require('../src/db/validate');

// 書く命令の tx も返す（edit.revert に渡す歩み）
const callTx = (db, cmd, args) => { const tx = txOf('app'); return { r: core.call(db, { role: 'app', cmd, args, tx }, { now, labels: {} }), tx }; };
const opsOfTx = (db, tx) => JSON.parse(db.prepare("select ops from oplog where role = 'app' and tx = ?").get(tx).ops);
const code = (r) => (r.ok ? 'ok' : r.code);
const mkDb = (db, parentId) => ok(call(db, 'db.create', parentId ? { parentId } : {}), 'db.create').id;
const dbGet = (db, id) => ok(call(db, 'db.get', { id }), 'db.get');
const view = (db, id, extra = {}) => ok(call(db, 'db.view', { id, viewId: 'v1', from: 0, count: 200, ...extra }), 'db.view');
const colAdd = (db, dbId, type, name) => ok(call(db, 'col.add', { db: dbId, type, ...(name ? { name } : {}) }), 'col.add').col.id;
const rowAddA = (db, dbId, extra = {}) => ok(call(db, 'row.add', { db: dbId, ...extra }), 'row.add').id;
const titles = (db, id, extra) => view(db, id, extra).rows.map((r) => r.title);
const cellsOf = (db, id) => JSON.parse(db.prepare('select attrs from blocks where id = ?').get(id).attrs).cells;
const revert = (db, pageId, steps) => callTx(db, 'edit.revert', { pageId, steps });
// 選択肢の列（高・低）
function selectCol(db, dbId) {
  const c = colAdd(db, dbId, 'select', '優先度');
  ok(call(db, 'col.setOpts', { db: dbId, col: c, opts: [{ id: 'o1', name: '高', color: 'red' }, { id: 'o2', name: '低', color: 'default' }] }), 'col.setOpts');
  return c;
}

test('DS-3: db.create は最上位・白紙のページの中（本文に子ページの行）・議事録の中に作れる。kind database・題名の列「名前」・「表」のビュー1つ・行 0。同じ tx の送り直しは同じ ID', T, () => withDb((db) => {
  const top = ok(call(db, 'db.create', {}), 'db.create');
  assert.strictEqual(top.page.kind, 'database');
  assert.strictEqual(top.page.title, '');
  const g = dbGet(db, top.id);
  assert.deepStrictEqual(g.cols, [{ id: 'title', name: '名前', type: 'title' }]);
  assert.deepStrictEqual(g.views.map((v) => [v.id, v.name, v.layout]), [['v1', '表', 'table']]);
  assert.deepStrictEqual([g.rowCount, g.title], [0, '']);
  assert.match(top.id, /^p[0-9a-z]+$/);
  assert.ok(C.listPages(db).some((p) => p.id === top.id), 'データベースのページは一覧に出る');
  // 白紙のページの中: 本文の最後に子ページの行（インラインでない）
  const blank = ok(call(db, 'page.create', {}), 'page.create').id;
  const inner = mkDb(db, blank);
  const body = ok(call(db, 'page.get', { id: blank }), 'page.get').page.blocks;
  assert.deepStrictEqual(body.map((b) => [b.type, b.page, b.inline]), [['subpage', inner, undefined]]);
  assert.strictEqual(blockOf(db, inner).parent_id, blank);
  // 議事録の中（本文には置かない）
  const inMeeting = mkDb(db, 'pa1');
  assert.strictEqual(blockOf(db, inMeeting).parent_id, 'pa1');
  // 送り直しは同じ ID
  const tx = txOf('app');
  const r1 = core.call(db, { role: 'app', cmd: 'db.create', args: {}, tx }, { now, labels: {} });
  const r2 = core.call(db, { role: 'app', cmd: 'db.create', args: {}, tx }, { now, labels: {} });
  assert.strictEqual(r2.dup, true);
  assert.strictEqual(r2.result.id, r1.result.id);
}));

test('DS-3・F142: db.create は録音中の写し・ゴミ箱・無いページ・データベースの中に作れない。page.move・page.create でデータベースの中へページを入れられない（bad-args・何も変えない）', T, () => withDb((db) => {
  const d = mkDb(db);
  const snap = () => dump(db);
  db.prepare('update blocks set attrs = json_set(attrs, \'$.meeting\', json(\'{"phase":"recording"}\')) where id = ?').run('pa2');
  assert.strictEqual(code(call(db, 'db.create', { parentId: 'pa2' })), 'bad-args', '録音中の写しの中に作れた');
  assert.strictEqual(code(call(db, 'db.create', { parentId: d })), 'bad-args', 'データベースの中にデータベース');
  assert.strictEqual(code(call(db, 'db.create', { parentId: 'nope1' })), 'bad-args');
  assert.strictEqual(code(call(db, 'page.create', { parentId: d })), 'bad-args', 'データベースの中にページを作れた');
  assert.strictEqual(code(call(db, 'page.move', { id: 'pa1', parentId: d })), 'bad-args', 'データベースの中へ議事録を動かせた');
  const blank = ok(call(db, 'page.create', {}), 'page.create').id;
  const s1 = snap();
  assert.strictEqual(code(call(db, 'page.move', { id: blank, parentId: d })), 'bad-args', 'データベースの中へページを動かせた');
  assert.deepStrictEqual(snap(), s1);
  ok(call(db, 'page.delete', { id: blank }), 'page.delete');
  assert.strictEqual(code(call(db, 'db.create', { parentId: blank })), 'bad-args', 'ゴミ箱のページの中に作れた');
  // データベースはほかのページの中へも最上位へも動かせる
  const host = ok(call(db, 'page.create', {}), 'page.create').id;
  ok(call(db, 'page.move', { id: d, parentId: host }), 'page.move');
  assert.strictEqual(blockOf(db, d).parent_id, host);
}));

test('DS-3・F137: row.add・row.setCell・rows.setCell・row.move・rows.trash（セルは cellOf を通った値だけ・操作は cell:<列> の1つずつで前の値つき・ID の番号は詰めない・作成者は me・書けない列は bad-args）', T, () => withDb((db) => {
  const d = mkDb(db);
  const num = colAdd(db, d, 'number', '見積もり');
  const sel = selectCol(db, d);
  const ct = colAdd(db, d, 'ctime');
  // 足す: 形の違うセルは断る（何も足さない）
  assert.strictEqual(code(call(db, 'row.add', { db: d, cells: { [num]: '12' } })), 'bad-args', '数値の列に文字');
  assert.strictEqual(code(call(db, 'row.add', { db: d, cells: { [sel]: 'o9' } })), 'bad-args', '選択肢に無い ID');
  assert.strictEqual(code(call(db, 'row.add', { db: d, cells: { [ct]: '2026-11-07T00:00:00.000Z' } })), 'bad-args', '作成日時に書けた');
  assert.strictEqual(code(call(db, 'row.add', { db: d, cells: { cx: 'a' } })), 'bad-args', '無い列');
  assert.strictEqual(dbGet(db, d).rowCount, 0);
  // データベースの行の題名（会議の題名ではない: D77）
  const r1 = ok(call(db, 'row.add', { db: d, title: '見積もりの依頼', cells: { [num]: 12, [sel]: 'o1' } }), 'row.add');
  assert.match(r1.id, /^r[0-9a-z]+$/);
  const row1 = db.prepare('select type, parent_id, page_id, text, attrs from blocks where id = ?').get(r1.id);
  assert.deepStrictEqual([row1.type, row1.parent_id, row1.page_id, row1.text], ['row', d, r1.id, '見積もりの依頼']);
  assert.deepStrictEqual(JSON.parse(row1.attrs), { cells: { [num]: 12, [sel]: 'o1' }, by: { c: 'me', u: 'me' }, no: 1 });
  const r2 = rowAddA(db, d);
  const r3 = rowAddA(db, d);
  assert.deepStrictEqual(titles(db, d), ['見積もりの依頼', '', '']);
  // セルを書く: 操作は cell:<列> の1つで、前の値を持つ。最終更新日時は同じ命令で
  const w = callTx(db, 'row.setCell', { db: d, id: r1.id, col: num, value: 30 });
  assert.strictEqual(code(w.r), 'ok');
  const sets = opsOfTx(db, w.tx).filter((o) => o.op === 'set');
  assert.deepStrictEqual(sets.filter((o) => o.key !== 'updatedAt' && o.key !== 'by'), [{ op: 'set', id: r1.id, key: `cell:${num}`, value: 30, old: 12 }]);
  assert.ok(sets.some((o) => o.key === 'updatedAt' && o.value === now().toISOString()), '最終更新日時を書かない');
  assert.deepStrictEqual(cellsOf(db, r1.id), { [num]: 30, [sel]: 'o1' });
  assert.strictEqual(code(call(db, 'row.setCell', { db: d, id: r1.id, col: num, value: '30' })), 'bad-args');
  assert.strictEqual(code(call(db, 'row.setCell', { db: d, id: r1.id, col: sel, value: 'o7' })), 'bad-args');
  assert.strictEqual(code(call(db, 'row.setCell', { db: d, id: r1.id, col: ct, value: null })), 'bad-args', '書けない列を空にできた');
  // 空にすると欄ごと消える・同じ値は書かない（oplog は空）
  ok(call(db, 'row.setCell', { db: d, id: r1.id, col: sel, value: null }), 'row.setCell');
  assert.deepStrictEqual(cellsOf(db, r1.id), { [num]: 30 });
  const same = callTx(db, 'row.setCell', { db: d, id: r1.id, col: num, value: 30 });
  assert.deepStrictEqual(opsOfTx(db, same.tx), []);
  // 題名の列は行の text
  ok(call(db, 'row.setCell', { db: d, id: r2, col: 'title', value: '日程の調整' }), 'row.setCell title');
  assert.strictEqual(blockOf(db, r2).text, '日程の調整');
  // 選んだ行の列の値（1つの命令）
  const m = callTx(db, 'rows.setCell', { db: d, ids: [r2, r3], col: sel, value: 'o2' });
  assert.deepStrictEqual(m.r.result, { changed: 2 });
  assert.deepStrictEqual([cellsOf(db, r2)[sel], cellsOf(db, r3)[sel]], ['o2', 'o2']);
  assert.strictEqual(opsOfTx(db, m.tx).filter((o) => o.key === `cell:${sel}`).length, 2);
  assert.strictEqual(code(call(db, 'rows.setCell', { db: d, ids: [r2, 'rnone1'], col: sel, value: 'o1' })), 'bad-args');
  // 動かす（並べ替えの無いビューは並びの鍵の順）
  ok(call(db, 'row.move', { db: d, id: r3, afterId: '' }), 'row.move');
  assert.deepStrictEqual(view(db, d).rows.map((r) => r.id), [r3, r1.id, r2]);
  ok(call(db, 'row.move', { db: d, id: r3, afterId: r1.id }), 'row.move');
  assert.deepStrictEqual(view(db, d).rows.map((r) => r.id), [r1.id, r3, r2]);
  // ゴミ箱へ（ID の番号は詰めない）
  assert.deepStrictEqual(ok(call(db, 'rows.trash', { db: d, ids: [r3] }), 'rows.trash'), { trashed: 1 });
  assert.deepStrictEqual(view(db, d).rows.map((r) => r.id), [r1.id, r2]);
  const r4 = ok(call(db, 'row.add', { db: d }), 'row.add');
  assert.strictEqual(JSON.parse(db.prepare('select attrs from blocks where id = ?').get(r4.id).attrs).no, 4, 'ID の番号を詰めた');
  // ほかのデータベースの行・ゴミ箱の行は書けない
  const d2 = mkDb(db);
  assert.strictEqual(code(call(db, 'row.setCell', { db: d2, id: r1.id, col: 'title', value: 'x' })), 'bad-args');
  assert.strictEqual(code(call(db, 'row.setCell', { db: d, id: r3, col: 'title', value: 'x' })), 'bad-args');
}));

test('DS-3・F137: 1つのデータベースの行は 10,000 まで（10,001 行目の row.add は too-big・何も足さない）', T, () => withDb((db) => {
  const d = mkDb(db);
  db.exec('BEGIN');
  const ins = db.prepare("insert into blocks(id,type,page_id,parent_id,ord,text,rich,attrs,fold,rev,created_at,updated_at,trashed_at) values (?,'row',?,?,?,'',null,'{}','',1,'','',?)");
  for (let i = 0; i < LIMITS.dbRows; i += 1) ins.run(`rq${i}`, `rq${i}`, d, `k${String(i).padStart(5, '0')}`, null);
  ins.run('rqt', 'rqt', d, 'zz', '2026-11-01T00:00:00.000Z');   // ゴミ箱の行は数えない
  db.exec('COMMIT');
  assert.strictEqual(code(call(db, 'row.add', { db: d })), 'too-big');
  assert.strictEqual(db.prepare("select count(*) c from blocks where type = 'row'").get().c, LIMITS.dbRows + 1);
  db.prepare("update blocks set trashed_at = '2026-11-01T00:00:00.000Z' where id = 'rq0'").run();
  ok(call(db, 'row.add', { db: d }), 'row.add（1つ消した後）');
}));

test('DS-3・F137: 列の命令（足す・名前・種類を変えると同じ命令でセルが読み替わり edit.revert で戻る・消すと gone でセルは残る・戻す・完全に消すとセルも消える・題名の列は消せない・101 列目は bad-args）', T, () => withDb((db) => {
  const d = mkDb(db);
  const a = colAdd(db, d, 'text', 'メモ');
  assert.strictEqual(colAdd(db, d, 'text', 'メモ'), 'c2');
  assert.deepStrictEqual(dbGet(db, d).cols.map((c) => c.name), ['名前', 'メモ', 'メモ 2']);
  assert.strictEqual(code(call(db, 'col.rename', { db: d, col: 'c2', name: 'めも' })), 'ok', '大文字小文字の違いでない名前');
  assert.strictEqual(code(call(db, 'col.rename', { db: d, col: 'c2', name: 'メモ' })), 'bad-args', '名前が重なった');
  assert.strictEqual(code(call(db, 'col.add', { db: d, type: 'rel' })), 'bad-args', 'リレーションの列は DR-1 の rel の引数で');
  // 種類を変える: テキスト → 数値（読める数だけ。読めない値は空）・1つの命令で前の値つき
  const rA = rowAddA(db, d, { cells: { [a]: '12' } });
  const rB = rowAddA(db, d, { cells: { [a]: '約 3' } });
  const rC = rowAddA(db, d, { cells: { [a]: '1,200' } });
  const t = callTx(db, 'col.setType', { db: d, col: a, type: 'number' });
  assert.deepStrictEqual(t.r.result.emptied, 1);
  assert.deepStrictEqual([cellsOf(db, rA)[a], cellsOf(db, rB)[a], cellsOf(db, rC)[a]], [12, undefined, 1200]);
  assert.strictEqual(dbGet(db, d).cols.find((c) => c.id === a).type, 'number');
  const back = revert(db, d, [t.tx]);
  assert.strictEqual(code(back.r), 'ok', `edit.revert: ${back.r.code}`);
  assert.deepStrictEqual([cellsOf(db, rA)[a], cellsOf(db, rB)[a], cellsOf(db, rC)[a]], ['12', '約 3', '1,200'], '種類の変更を戻せない');
  assert.strictEqual(dbGet(db, d).cols.find((c) => c.id === a).type, 'text');
  // 選択 ⇄ 複数選択（選択肢は同じ ID のまま）・リレーションと書けない種類へは変えられない
  const sel = selectCol(db, d);
  const rS = rowAddA(db, d, { cells: { [sel]: 'o2' } });
  ok(call(db, 'col.setType', { db: d, col: sel, type: 'multi' }), 'col.setType multi');
  assert.deepStrictEqual(cellsOf(db, rS)[sel], ['o2']);
  for (const type of ['rel', 'ctime', 'no']) assert.strictEqual(code(call(db, 'col.setType', { db: d, col: sel, type })), 'bad-args', type);
  assert.strictEqual(code(call(db, 'col.setType', { db: d, col: 'title', type: 'text' })), 'bad-args', '題名の列の種類');
  // 消す・戻す・完全に消す
  const rm = callTx(db, 'col.remove', { db: d, col: a });
  assert.strictEqual(code(rm.r), 'ok');
  assert.strictEqual(dbGet(db, d).cols.find((c) => c.id === a).gone, true);
  assert.deepStrictEqual(cellsOf(db, rA)[a], '12', '消した列のセルを消した');
  assert.ok(!dbGet(db, d).views[0].props.some((p) => p.col === a), '消した列がビューに残る');
  ok(call(db, 'col.restore', { db: d, col: a }), 'col.restore');
  assert.strictEqual(dbGet(db, d).cols.find((c) => c.id === a).gone, undefined);
  assert.strictEqual(code(call(db, 'col.purge', { db: d, col: a })), 'bad-args', '消していない列を完全に消せた');
  ok(call(db, 'col.remove', { db: d, col: a }), 'col.remove');
  ok(call(db, 'col.purge', { db: d, col: a }), 'col.purge');
  assert.ok(!dbGet(db, d).cols.some((c) => c.id === a));
  assert.strictEqual(cellsOf(db, rA)[a], undefined, '完全に消してもセルが残る');
  assert.strictEqual(code(call(db, 'col.remove', { db: d, col: 'title' })), 'bad-args', '題名の列を消せた');
  // 列の上限（消した列も数える）
  const have = dbGet(db, d).cols.length;
  for (let i = have; i < LIMITS.dbCols; i += 1) colAdd(db, d, 'check', `チェック ${i}`);
  assert.strictEqual(dbGet(db, d).cols.length, LIMITS.dbCols);
  assert.strictEqual(code(call(db, 'col.add', { db: d, type: 'text' })), 'bad-args', '101 列目');
}));

test('DS-3・R14: 選択肢の名前を変える・列を消すと、そのデータベースの全部の行の検索の欄が作り直される。col.setOpts で消した選択肢はセルからも外れる。col.setFmt・col.move', T, () => withDb((db) => {
  const d = mkDb(db);
  const sel = selectCol(db, d);
  const r = rowAddA(db, d, { title: '会場の予約', cells: { [sel]: 'o1' } });   // データベースの行の題名（D77 の会議の題名でない）
  assert.ok(blockOf(db, r).fold.includes(searchFold('高')));
  ok(call(db, 'col.setOpts', { db: d, col: sel, opts: [{ id: 'o1', name: '至急', color: 'red' }, { id: 'o2', name: '低', color: 'default' }] }), 'col.setOpts');
  assert.ok(blockOf(db, r).fold.includes(searchFold('至急')) && !blockOf(db, r).fold.includes(searchFold('高')), '選択肢の名前を変えても検索の欄が古い');
  ok(call(db, 'col.remove', { db: d, col: sel }), 'col.remove');
  assert.ok(!blockOf(db, r).fold.includes(searchFold('至急')), '消した列が検索の欄に残る');
  ok(call(db, 'col.restore', { db: d, col: sel }), 'col.restore');
  assert.strictEqual(code(call(db, 'col.setOpts', { db: d, col: sel, opts: [{ id: 'o1', name: '高', color: 'red' }, { id: 'o2', name: 'こう', color: 'red' }, { id: 'o3', name: 'コウ', color: 'red' }] })), 'ok');
  assert.strictEqual(code(call(db, 'col.setOpts', { db: d, col: sel, opts: [{ id: 'o1', name: 'A', color: 'red' }, { id: 'o2', name: 'a', color: 'red' }] })), 'bad-args', '大文字小文字だけ違う選択肢');
  ok(call(db, 'col.setOpts', { db: d, col: sel, opts: [{ id: 'o2', name: '低', color: 'default' }] }), 'col.setOpts（o1 を消す）');
  assert.deepStrictEqual(cellsOf(db, r), {}, '消した選択肢がセルに残る');
  const n = colAdd(db, d, 'number');
  ok(call(db, 'col.setFmt', { db: d, col: n, fmt: 'yen' }), 'col.setFmt');
  assert.strictEqual(dbGet(db, d).cols.find((c) => c.id === n).fmt, 'yen');
  assert.strictEqual(code(call(db, 'col.setFmt', { db: d, col: n, fmt: 'euro' })), 'bad-args');
  const no = colAdd(db, d, 'no');
  ok(call(db, 'col.setFmt', { db: d, col: no, prefix: 'TASK' }), 'col.setFmt prefix');
  assert.strictEqual(dbGet(db, d).cols.find((c) => c.id === no).prefix, 'TASK');
  assert.strictEqual(code(call(db, 'col.setFmt', { db: d, col: sel, fmt: 'yen' })), 'bad-args', '選択の列に見せ方');
  ok(call(db, 'col.move', { db: d, col: n, after: '' }), 'col.move');
  assert.deepStrictEqual(dbGet(db, d).cols.map((c) => c.id), [n, 'title', sel, no]);
}));

test('DS-3: ビューの命令（足す・複製・設定を変えると normalizeView を通る・最後の1つは消せない・21 個目は bad-args・並べ替え）。ビューの命令は UNDO_CMDS に無く、表の命令はある（preload の写しも同じ）', T, () => withDb((db) => {
  const d = mkDb(db);
  const sel = selectCol(db, d);
  const v2 = ok(call(db, 'view.add', { db: d, layout: 'list', name: '一覧' }), 'view.add').view;
  assert.deepStrictEqual([v2.id, v2.name, v2.layout], ['v2', '一覧', 'list']);
  const u = ok(call(db, 'view.update', { db: d, viewId: 'v2', patch: { sort: [{ col: sel, dir: 'desc' }], filter: { op: 'and', items: [{ col: sel, cmp: 'any', value: ['o1'] }] } } }), 'view.update').view;
  assert.deepStrictEqual(u.sort, [{ col: sel, dir: 'desc' }]);
  assert.strictEqual(code(call(db, 'view.update', { db: d, viewId: 'v2', patch: { sort: [{ col: 'cx', dir: 'up' }] } })), 'bad-args', '壊れた並べ替えを通した');
  assert.strictEqual(code(call(db, 'view.update', { db: d, viewId: 'v2', patch: { layout: 'board' } })), 'bad-args');
  assert.deepStrictEqual(dbGet(db, d).views.find((v) => v.id === 'v1').sort, [], 'ほかのビューに写った');
  const cp = ok(call(db, 'view.add', { db: d, from: 'v2' }), 'view.add 複製').view;
  assert.deepStrictEqual([cp.id, cp.layout, cp.sort], ['v3', 'list', [{ col: sel, dir: 'desc' }]]);
  ok(call(db, 'view.move', { db: d, viewId: 'v3', after: '' }), 'view.move');
  assert.deepStrictEqual(dbGet(db, d).views.map((v) => v.id), ['v3', 'v1', 'v2']);
  for (const id of ['v3', 'v2']) ok(call(db, 'view.remove', { db: d, viewId: id }), 'view.remove');
  assert.strictEqual(code(call(db, 'view.remove', { db: d, viewId: 'v1' })), 'bad-args', '最後のビューを消せた');
  for (let i = 1; i < LIMITS.dbViews; i += 1) ok(call(db, 'view.add', { db: d }), 'view.add');
  assert.strictEqual(dbGet(db, d).views.length, LIMITS.dbViews);
  assert.strictEqual(code(call(db, 'view.add', { db: d })), 'bad-args', '21 個目のビュー');
  const PRE = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const preUndo = [.../const UNDO_CMDS = new Set\(\[([^\]]*)\]\)/.exec(PRE)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  for (const cmd of ['view.add', 'view.update', 'view.remove', 'view.move', 'col.purge', 'db.create', 'db.get', 'db.view']) {
    assert.ok(!UNDO_CMDS.has(cmd) && !preUndo.includes(cmd), `UNDO_CMDS に ${cmd}`);
  }
  for (const cmd of ['row.add', 'row.setCell', 'rows.setCell', 'rows.paste', 'row.move', 'rows.trash', 'col.add', 'col.rename', 'col.setType', 'col.move', 'col.remove', 'col.restore', 'col.setOpts', 'col.setFmt']) {
    assert.ok(UNDO_CMDS.has(cmd), `UNDO_CMDS に ${cmd} が無い`);
    assert.deepStrictEqual(core.COMMANDS[cmd].roles, ['app'], cmd);
  }
  for (const cmd of ['db.get', 'db.view']) assert.strictEqual(core.COMMANDS[cmd].write, false, cmd);
}));

test('DS-3・F139: db.view は from・count の分だけ返す（count 201 は bad-args）・total・shown・集計・同じ中身なら同じ sig・セルを書くと sig が変わる・ゴミ箱のデータベースは null', T, () => withDb((db) => {
  const d = mkDb(db);
  const n = colAdd(db, d, 'number', '点');
  const rows = [];
  for (let i = 0; i < 300; i += 1) rows.push(rowAdd(`rv${i}`, d, `k${String(i).padStart(4, '0')}`, `行 ${i}`, { [n]: i % 10 }, i + 1));
  put(db, rows);
  const v0 = view(db, d, { from: 0, count: 200 });
  assert.deepStrictEqual([v0.total, v0.shown, v0.rows.length], [300, 300, 200]);
  assert.deepStrictEqual(view(db, d, { from: 250, count: 100 }).rows.map((r) => r.title), rows.slice(250).map((o) => o.row.text));
  assert.strictEqual(view(db, d, { from: 290, count: 5 }).rows.length, 5);
  for (const count of [201, 0, -1]) assert.strictEqual(code(call(db, 'db.view', { id: d, viewId: 'v1', from: 0, count })), 'bad-args', `count ${count}`);
  assert.strictEqual(code(call(db, 'db.view', { id: d, viewId: 'v9', from: 0, count: 10 })), 'bad-args', '無いビュー');
  // 絞り込みと並べ替えと集計（絞り込んだ後の行）
  ok(call(db, 'view.update', { db: d, viewId: 'v1', patch: { filter: { op: 'and', items: [{ col: n, cmp: 'ge', value: 8 }] }, sort: [{ col: n, dir: 'desc' }], agg: { [n]: 'sum' } } }), 'view.update');
  const v1 = view(db, d, { count: 3 });
  assert.deepStrictEqual([v1.total, v1.rows.map((r) => r.cells[n]), v1.agg[n]], [60, [9, 9, 9], 30 * 8 + 30 * 9]);
  assert.deepStrictEqual(Object.keys(v1.rows[0]).sort(), ['by', 'cells', 'createdAt', 'depth', 'hasKids', 'id', 'no', 'ord', 'title', 'updatedAt']);
  // 検索の語
  assert.deepStrictEqual(view(db, d, { q: '行 29' }).rows.map((r) => r.title), ['行 29', '行 299', '行 298']);
  // sig
  const s1 = view(db, d).sig;
  assert.strictEqual(view(db, d).sig, s1, '同じ中身で sig が違う');
  ok(call(db, 'row.setCell', { db: d, id: 'rv5', col: 'title', value: '行 5 改' }), 'row.setCell');
  const s2 = view(db, d).sig;
  assert.notStrictEqual(s2, s1, '題名を書いても sig が同じ');
  ok(call(db, 'row.setCell', { db: d, id: 'rv5', col: n, value: 3 }), 'row.setCell');
  assert.notStrictEqual(view(db, d).sig, s2, 'セルを書いても sig が同じ');
  // グループでは shown で切る（複数選択の行はどの値のグループにも出る: R20）
  const m = colAdd(db, d, 'multi', 'タグ');
  ok(call(db, 'col.setOpts', { db: d, col: m, opts: [{ id: 'o1', name: '甲', color: 'red' }, { id: 'o2', name: '乙', color: 'blue' }] }), 'col.setOpts');
  ok(call(db, 'rows.setCell', { db: d, ids: ['rv0', 'rv1'], col: m, value: ['o1', 'o2'] }), 'rows.setCell');
  ok(call(db, 'view.update', { db: d, viewId: 'v1', patch: { filter: null, sort: [], group: { col: m, hide: [''] } } }), 'view.update group');
  const g = view(db, d, { count: 200 });
  assert.deepStrictEqual([g.total, g.shown, g.rows.length, g.groups.map((x) => [x.count, Boolean(x.hidden)])], [300, 4, 4, [[2, false], [2, false], [298, true]]]);
  assert.deepStrictEqual(g.rows.map((r) => [r.id, r.g]), [['rv0', 0], ['rv1', 0], ['rv0', 1], ['rv1', 1]]);
  // ゴミ箱のデータベース
  ok(call(db, 'page.delete', { id: d }), 'page.delete');
  assert.strictEqual(ok(call(db, 'db.view', { id: d, viewId: 'v1', from: 0, count: 10 }), 'db.view'), null);
  assert.strictEqual(ok(call(db, 'db.get', { id: d }), 'db.get'), null);
}));

test('DS-3・F143: 元に戻す（rows.trash の歩みを edit.revert すると行が戻る・やり直せる・後で変わった歩みは stale・足した行を戻すと消える・invertOps を dbId 無しで呼ぶと今どおり投げる）', T, () => withDb((db) => {
  const d = mkDb(db);
  const t = colAdd(db, d, 'text', 'メモ');
  const r1 = rowAddA(db, d, { title: '甲' });   // データベースの行の題名（D77 の会議の題名でない）
  const r2 = rowAddA(db, d, { title: '乙' });
  const tr = callTx(db, 'rows.trash', { db: d, ids: [r1, r2] });
  assert.deepStrictEqual(titles(db, d), []);
  const fwd = opsOfTx(db, tr.tx);
  assert.throws(() => ops.invertOps(fwd), /ページの行は戻さない/, 'dbId 無しで行の trash を戻した');
  assert.throws(() => ops.opsMatch(db, fwd), /ページの行は照らさない/);
  assert.deepStrictEqual(ops.invertOps(fwd, { dbId: d }).map((o) => o.op), ['restore', 'restore']);
  const un = revert(db, d, [tr.tx]);
  assert.strictEqual(code(un.r), 'ok', `edit.revert: ${un.r.code}`);
  assert.deepStrictEqual(titles(db, d), ['甲', '乙'], '行が戻らない');
  // 同じ歩みをもう一度戻すのは stale（行はもうゴミ箱に無い）・戻した歩みを戻すとやり直し
  assert.strictEqual(code(revert(db, d, [tr.tx]).r), 'stale');
  assert.strictEqual(code(revert(db, d, [un.tx]).r), 'ok');
  assert.deepStrictEqual(titles(db, d), []);
  assert.strictEqual(code(revert(db, d, [un.tx]).r), 'stale');
  // セル: 後で書き換えたセルの古い歩みは stale（何も変えない）
  const r3 = rowAddA(db, d);
  const w1 = callTx(db, 'row.setCell', { db: d, id: r3, col: t, value: 'はじめ' });
  const w2 = callTx(db, 'row.setCell', { db: d, id: r3, col: t, value: 'つぎ' });
  const snap = dump(db);
  assert.strictEqual(code(revert(db, d, [w1.tx]).r), 'stale', '後で変わったセルを古い歩みで戻した');
  assert.deepStrictEqual(dump(db), snap);
  assert.strictEqual(code(revert(db, d, [w2.tx]).r), 'ok');
  assert.strictEqual(cellsOf(db, r3)[t], 'はじめ');
  assert.strictEqual(code(revert(db, d, [w1.tx]).r), 'ok');
  assert.strictEqual(cellsOf(db, r3)[t], undefined);
  // 戻しも書き込み: 最終更新日時は今の時刻（行の by.u は自分）
  assert.strictEqual(db.prepare('select updated_at u from blocks where id = ?').get(r3).u, now().toISOString());
  // 足した行を戻すと消える（ID の番号は詰めない）。本文を書いた行は戻さない（stale）
  const add = callTx(db, 'row.add', { db: d, title: '丙' });   // データベースの行の題名（D77 の会議の題名でない）
  assert.strictEqual(code(revert(db, d, [add.tx]).r), 'ok');
  assert.strictEqual(blockOf(db, add.r.result.id), undefined);
  assert.strictEqual(rowAddA(db, d) && JSON.parse(db.prepare("select attrs from blocks where type = 'row' order by rid desc limit 1").get().attrs).no, 5);
  const add2 = callTx(db, 'row.add', { db: d, title: '丁' });   // データベースの行の題名（D77 の会議の題名でない）
  ok(call(db, 'block.insert', { pageId: add2.r.result.id, afterBlockId: '', type: 'paragraph' }), 'block.insert');
  assert.strictEqual(code(revert(db, d, [add2.tx]).r), 'stale', '本文のある行を戻して消した');
  // ほかのページの歩みとして戻せない・ビューの命令は戻せない
  const vu = callTx(db, 'view.update', { db: d, viewId: 'v1', patch: { sort: [{ col: t, dir: 'asc' }] } });
  assert.strictEqual(code(revert(db, d, [vu.tx]).r), 'bad-args', 'ビューの設定を戻せた');
  assert.strictEqual(code(revert(db, 'pa1', [w2.tx]).r), 'bad-args');
}));

test('DS-3・F142: page.delete でデータベースを消しても行は書かない（ゴミ箱の印は付けない）・戻すと行が見える。db.get の rowCount は今の行の数（確かめの文の数）', T, () => withDb((db) => {
  const d = mkDb(db);
  const ids = [rowAddA(db, d), rowAddA(db, d), rowAddA(db, d)];
  ok(call(db, 'rows.trash', { db: d, ids: [ids[2]] }), 'rows.trash');
  assert.strictEqual(dbGet(db, d).rowCount, 2, '確かめの文の行の数');
  const del = callTx(db, 'page.delete', { id: d });
  assert.strictEqual(code(del.r), 'ok');
  assert.deepStrictEqual(opsOfTx(db, del.tx).map((o) => o.id), [d], '行にゴミ箱の印を書いた');
  assert.deepStrictEqual(ids.slice(0, 2).map((id) => blockOf(db, id).trashed_at), [null, null]);
  ok(call(db, 'page.restore', { id: d }), 'page.restore');
  assert.deepStrictEqual(view(db, d).rows.map((r) => r.id), ids.slice(0, 2));
  assert.strictEqual(dbGet(db, d).rowCount, 2);
}));

test('DS-3・F146: rows.paste（選んだセルから右下へ埋まる・足りない行を足す・はみ出した列は捨てて数・読めない値は空にして数・選択肢を足す・書けない列は飛ばす・2,001 セルと行の上限は断る・oplog は1行で edit.revert の1回で全部戻る）', T, () => withDb((db) => {
  const d = mkDb(db);
  const num = colAdd(db, d, 'number', '金額');
  const sel = selectCol(db, d);
  const ct = colAdd(db, d, 'ctime');
  const dt = colAdd(db, d, 'date', '期日');
  const r1 = rowAddA(db, d, { title: '甲' });   // データベースの行の題名（D77 の会議の題名でない）
  const r2 = rowAddA(db, d, { title: '乙' });
  // 絞り込み（優先度が「高」）のビュー: 足した行に「高」を入れる
  ok(call(db, 'view.update', { db: d, viewId: 'v1', patch: { props: [{ col: 'title' }, { col: num }, { col: sel }, { col: ct }, { col: dt }] } }), 'view.update');
  const snap = dump(db);
  const p = callTx(db, 'rows.paste', { db: d, viewId: 'v1', at: { row: r2, col: num }, grid: [
    ['1,200', '中', '2026-01-01', '2026/11/05 10:00', '余り'],
    ['abc', '高', '', '明日'],
    ['30', '', '', '2026-11-30'],
  ] });
  assert.strictEqual(code(p.r), 'ok', `rows.paste: ${p.r.code}`);
  assert.deepStrictEqual(p.r.result, { filled: 9, added: 2, skipped: 4, unread: 2 });
  const vrows = view(db, d).rows;
  assert.deepStrictEqual(vrows.map((r) => r.title), ['甲', '乙', '', '']);
  const cellRows = vrows.slice(1).map((r) => cellsOf(db, r.id));
  const opts = dbGet(db, d).cols.find((c) => c.id === sel).opts;
  const optId = (name) => opts.find((o) => o.name === name).id;
  assert.deepStrictEqual(cellRows, [
    { [num]: 1200, [sel]: optId('中'), [dt]: { start: '2026-11-05', time: '10:00' } },
    { [sel]: 'o1' },
    { [num]: 30, [dt]: { start: '2026-11-30' } },
  ]);
  assert.deepStrictEqual(JSON.parse(db.prepare('select attrs from blocks where id = ?').get(vrows[3].id).attrs).no, 4);
  assert.deepStrictEqual(db.prepare('select count(*) c from oplog where tx = ?').get(p.tx).c, 1);
  // Ctrl+Z の1回で全部戻る（足した行・セル・選択肢）
  assert.strictEqual(code(revert(db, d, [p.tx]).r), 'ok');
  const after = dump(db);
  // DS-3 直し（R56）で意図して変えた: 振った ID の数 seq も戻さない（nextNo と同じ。ID を使い直さない）
  const strip = (rows) => rows[0].map(({ rev, updated_at, attrs, ...r }) => ({ ...r, attrs: (() => { const a = JSON.parse(attrs); delete a.by; delete a.nextNo; delete a.seq; return a; })() }));
  assert.deepStrictEqual(strip(after), strip(snap), '戻しても表が元に戻らない');
  // 絞り込みのあるビューで足した行に値が入る
  ok(call(db, 'view.update', { db: d, viewId: 'v1', patch: { filter: { op: 'and', items: [{ col: sel, cmp: 'any', value: ['o1'] }] } } }), 'view.update filter');
  ok(call(db, 'row.setCell', { db: d, id: r1, col: sel, value: 'o1' }), 'row.setCell');
  const f = ok(call(db, 'rows.paste', { db: d, viewId: 'v1', at: { row: r1, col: 'title' }, grid: [['甲'], ['丙']] }), 'rows.paste filter');
  assert.strictEqual(f.added, 1);
  assert.deepStrictEqual(view(db, d).rows.map((r) => r.title), ['甲', '丙'], '貼った行がすぐ見えなくなる');
  // 断る: 2,001 セル・行の上限・無いセル
  const s2 = dump(db);
  assert.strictEqual(code(call(db, 'rows.paste', { db: d, viewId: 'v1', at: { row: r1, col: num }, grid: [new Array(LIMITS.pasteCells + 1).fill('1')] })), 'bad-args', '2,001 セル');
  assert.strictEqual(code(call(db, 'rows.paste', { db: d, viewId: 'v1', at: { row: 'rnone1', col: num }, grid: [['1']] })), 'bad-args');
  assert.strictEqual(code(call(db, 'rows.paste', { db: d, viewId: 'v1', at: { row: r1, col: 'cx' }, grid: [['1']] })), 'bad-args');
  db.exec('BEGIN');
  const ins = db.prepare("insert into blocks(id,type,page_id,parent_id,ord,text,rich,attrs,fold,rev,created_at,updated_at,trashed_at) values (?,'row',?,?,?,'',null,'{}','',1,'','',null)");
  for (let i = 0; i < LIMITS.dbRows - 4; i += 1) ins.run(`rp${i}`, `rp${i}`, d, `zz${String(i).padStart(5, '0')}`);
  db.exec('COMMIT');
  const s3 = dump(db);
  assert.strictEqual(code(call(db, 'rows.paste', { db: d, viewId: 'v1', at: { row: r1, col: 'title' }, grid: [['a'], ['b'], ['c'], ['d']] })), 'too-big', '行の上限を越えた');
  assert.deepStrictEqual(dump(db), s3);
  assert.notDeepStrictEqual(s2, s3);
}));

test('DS-3: T4b: 控えに表の命令の oplog（データベース・行・列・ビュー・貼り付け・戻し）を当て直すと今の表と同じ。後ろへ当てると控えの表', T, async () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const s = pageOf('pa1'); t.seed(s.page, s.segments);
    const to = path.join(t.dir, 'copy-160-ds3.db');
    await sqlite.backup(db, to);
    const copy = new sqlite.DatabaseSync(to);
    try {
      const base = dump(copy);
      const k = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
      const d = mkDb(db);
      const tx = colAdd(db, d, 'text', 'メモ');
      const sel = selectCol(db, d);
      const r1 = rowAddA(db, d, { title: '甲', cells: { [tx]: '前提', [sel]: 'o1' } });   // データベースの行の題名（D77 の会議の題名でない）
      const r2 = rowAddA(db, d, { title: '乙' });
      ok(call(db, 'row.setCell', { db: d, id: r2, col: tx, value: '12' }), 'row.setCell');
      const ty = callTx(db, 'col.setType', { db: d, col: tx, type: 'number' });
      ok(call(db, 'col.setOpts', { db: d, col: sel, opts: [{ id: 'o1', name: '至急', color: 'red' }] }), 'col.setOpts');
      ok(call(db, 'rows.paste', { db: d, viewId: 'v1', at: { row: r2, col: 'title' }, grid: [['乙2', '3'], ['丙', '4']] }), 'rows.paste');
      ok(call(db, 'view.add', { db: d, layout: 'list' }), 'view.add');
      ok(call(db, 'rows.trash', { db: d, ids: [r1] }), 'rows.trash');
      ok(call(db, 'row.move', { db: d, id: r2, afterId: '' }), 'row.move');
      assert.strictEqual(code(revert(db, d, [ty.tx]).r), 'stale', '後で書き換えた列の種類を戻した');
      const tr = db.prepare("select tx from oplog where action = 'rows.trash' order by seq desc limit 1").get().tx;
      assert.strictEqual(code(revert(db, d, [tr]).r), 'ok');
      ok(call(db, 'col.remove', { db: d, col: sel }), 'col.remove');
      const later = db.prepare('select ops from oplog where seq > ? order by seq').all(k).map((r) => JSON.parse(r.ops));
      for (const o of later) ops.applyOps(copy, o, 'forward');
      assert.deepStrictEqual(dump(copy), dump(db));
      for (const o of [...later].reverse()) ops.applyOps(copy, o, 'backward');
      assert.deepStrictEqual(dump(copy), base);
    } finally { copy.close(); }
  } finally { t.done(); }
});

test('DS-3: preload に表の命令の呼び口（どれも dbCall の1回・書く頼みに tx）。表の命令の歩みの知らせはデータベースの ID（args.db）の歩み', T, async () => {
  const PRE = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const names = [.../const APP_COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(PRE)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.deepStrictEqual(names.sort(), Object.keys(core.COMMANDS).filter((c) => core.COMMANDS[c].roles.includes('app')).sort());
  const reads = [.../const DB_READS = new Set\(\[([^\]]*)\]\)/.exec(PRE)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  for (const c of ['db.get', 'db.view']) assert.ok(reads.includes(c), `${c} が読む命令でない`);
  const exposed = {}; const on = {}; let uuid = 0;
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { on: (ch, fn) => { on[ch] = fn; }, invoke: async () => ({}), send: () => {} } };
  vm.runInNewContext(PRE, { require: () => electron, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` }, setTimeout, clearTimeout, console, Promise });
  const port = new EventTarget(); port.sent = []; port.postMessage = (m) => port.sent.push(structuredClone(m)); port.start = () => {};
  port.reply = (id, b) => { const ev = new Event('message'); ev.data = { id, ...b }; (port.onmessage || (() => {}))(ev); };
  on['db:port']({ ports: [port] });
  const k = exposed.koeApp;
  const seen = [];
  k.onEditStep((x) => seen.push(structuredClone(x)));
  k.dbCreate(); k.dbCreate('pa1'); k.dbGet('pd1'); k.dbView('pd1', 'v1', 0, 200, '語');
  const w = k.rowSetCell('pd1', 'r1', 'c1', 3);
  k.rowAdd('pd1', { title: '甲', cells: { c1: 1 } }); k.rowsSetCell('pd1', ['r1'], 'c1', null); k.rowMove('pd1', 'r1', ''); k.rowsTrash('pd1', ['r1']);   // データベースの行の題名（D77 の会議の題名でない）
  k.rowsPaste('pd1', 'v1', { row: 'r1', col: 'c1' }, [['1']]);
  k.colAdd('pd1', 'text', 'メモ', 'c1'); k.colRename('pd1', 'c1', '名'); k.colSetType('pd1', 'c1', 'number'); k.colMove('pd1', 'c1', '');
  k.colRemove('pd1', 'c1'); k.colRestore('pd1', 'c1'); k.colPurge('pd1', 'c1'); k.colSetOpts('pd1', 'c1', [], undefined); k.colSetFmt('pd1', 'c1', { fmt: 'yen' });
  k.viewAdd('pd1', { layout: 'list' }); k.viewUpdate('pd1', 'v1', { sort: [] }); k.viewRemove('pd1', 'v2'); k.viewMove('pd1', 'v2', '');
  assert.deepStrictEqual(port.sent.map((m) => m.cmd), ['db.create', 'db.create', 'db.get', 'db.view', 'row.setCell', 'row.add', 'rows.setCell', 'row.move', 'rows.trash', 'rows.paste',
    'col.add', 'col.rename', 'col.setType', 'col.move', 'col.remove', 'col.restore', 'col.purge', 'col.setOpts', 'col.setFmt', 'view.add', 'view.update', 'view.remove', 'view.move']);
  assert.deepStrictEqual(port.sent.slice(0, 5).map((m) => m.args), [{}, { parentId: 'pa1' }, { id: 'pd1' }, { id: 'pd1', viewId: 'v1', from: 0, count: 200, q: '語' }, { db: 'pd1', id: 'r1', col: 'c1', value: 3 }]);
  for (const m of port.sent) if (['db.get', 'db.view'].includes(m.cmd)) assert.strictEqual(m.tx, undefined, m.cmd); else assert.match(m.tx, /^a:/, m.cmd);
  port.reply(port.sent[4].id, { ok: true, result: {}, changed: true });
  await w;
  assert.deepStrictEqual(seen, [{ cmd: 'row.setCell', pageId: 'pd1', step: port.sent[4].tx }], '歩みがデータベースの ID でない');
});

test('DS-3・PERF・F139: 議事録 5,000 ページと1万行で、db.view の初めの 200 行・絞り込みと並べ替えを替えた db.view が 500 ミリ秒以内・row.setCell が 50 ミリ秒以内・pages.list が行の無いときの 1.5 倍以内（3 回の中央値。越えたら計り直す）', { timeout: 300000 }, async (tc) => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const memo = 'メモ'.repeat(500);
    db.exec('BEGIN');
    const ins = db.prepare("insert into blocks(id,type,page_id,parent_id,ord,text,rich,attrs,fold,rev,created_at,updated_at,trashed_at) values (?,?,?,?,?,?,null,?,'',1,?,?,null)");
    for (let i = 0; i < 5000; i += 1) {
      const id = `pp${String(i).padStart(5, '0')}`;
      ins.run(id, 'page', id, null, 'i', `題${i}`, JSON.stringify({ memo, date: '2026-10-01', meeting: { phase: 'done' } }), new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), '');
    }
    db.exec('COMMIT');
    const d = mkDb(db);
    const txt = colAdd(db, d, 'text', 'メモ');
    const num = colAdd(db, d, 'number', '金額');
    const sel = selectCol(db, d);
    const dt = colAdd(db, d, 'date', '期日');
    const timed = (f) => { const t0 = process.hrtime.bigint(); const r = f(); return [Number(process.hrtime.bigint() - t0) / 1e6, r]; };
    const med = (f, n = 3) => PF.median(Array.from({ length: n }, () => timed(f)[0]));
    call(db, 'pages.list', {});
    const listBefore = med(() => call(db, 'pages.list', {}), 5);
    const rows = [];
    for (let i = 0; i < 10000; i += 1) {
      rows.push(rowAdd(`rz${i}`, d, `k${String(i).padStart(5, '0')}`, `行 ${i}`,
        { [txt]: `メモ ${i % 97}`, [num]: (i * 37) % 1000, [sel]: i % 3 ? 'o1' : 'o2', [dt]: { start: `2026-${String(1 + (i % 12)).padStart(2, '0')}-1${i % 9}` } }, i + 1));
    }
    put(db, rows);
    rows.length = 0;
    const first = () => { const [ms, r] = timed(() => call(db, 'db.view', { id: d, viewId: 'v1', from: 0, count: 200 })); assert.strictEqual(r.result.rows.length, 200); return ms; };
    // 絞り込みと並べ替えは命令の前に替え（view.update は計らない）、db.view を計る
    let flip = 0;
    const filtered = () => {
      flip += 1;
      ok(call(db, 'view.update', { db: d, viewId: 'v1', patch: { filter: { op: 'and', items: [{ col: txt, cmp: 'contains', value: String(flip % 9) }, { col: sel, cmp: 'any', value: ['o1'] }] }, sort: [{ col: num, dir: flip % 2 ? 'asc' : 'desc' }, { col: dt, dir: 'asc' }] } }), 'view.update');
      const [ms, r] = timed(() => call(db, 'db.view', { id: d, viewId: 'v1', from: 0, count: 200 }));
      assert.ok(r.result.total > 0 && r.result.total < 10000);
      return ms;
    };
    let v = 0;
    const write = () => { v += 1; const [ms, r] = timed(() => call(db, 'row.setCell', { db: d, id: 'rz5000', col: num, value: v })); assert.strictEqual(r.ok, true); return ms; };
    const list = () => timed(() => call(db, 'pages.list', {}))[0];
    const round = () => ({ 'db.view': PF.median([first(), first(), first()]), 'db.view（絞り込みと並べ替え）': PF.median([filtered(), filtered(), filtered()]),
      'row.setCell': PF.median([write(), write(), write()]), 'pages.list の倍': PF.median([list(), list(), list()]) / listBefore });
    const BUDGET = { 'db.view': 500, 'db.view（絞り込みと並べ替え）': 500, 'row.setCell': 50, 'pages.list の倍': 1.5 };
    const r0 = round();
    const judged = Object.entries(BUDGET).map(([name, b]) => ({ name, ms: Number(r0[name].toFixed(2)), budget: b, ok: r0[name] < b }));
    tc.diagnostic(`はじめ: ${judged.map((x) => `${x.name} ${x.ms}`).join('・')}（一覧の基準 ${listBefore.toFixed(1)} ミリ秒）`);
    const extra = [];
    const seen = new Map();
    const out = await PF.recheck(judged, async (name) => { const i = seen.get(name) || 0; seen.set(name, i + 1); if (!extra[i]) extra[i] = round(); return Number(extra[i][name].toFixed(2)); }, { rounds: 2, log: () => {} });
    for (const x of out) assert.ok(x.ok, `${x.name} ${x.ms}（目安 ${x.budget}${x.tries ? `・計り直し ${x.tries.join('・')}` : ''}）`);
  } finally { t.done(); }
});

// ================================================================ DS-2 直し（2026-11-07 の da53aad..9304bb5 の点検 rv40）
test('DS-2 直し・R41（rv40 F1）: 行のページの本文の Ctrl+Z（edit.revert の pageId は行）が戻せる（stale にならない）。行の add は dbId 無しの invertOps・opsMatch で投げる', T, () => withDb((db) => {
  const d = mkDb(db);
  const r = rowAddA(db, d, { title: '甲' });   // データベースの行の題名（D77 の会議の題名でない）
  at();   // 書くたびに時計を進める（行の最終更新日時が変わる。前は行の updatedAt を attrs の欄として照らして stale になった）
  const ins = callTx(db, 'block.insert', { pageId: r, afterBlockId: '', type: 'paragraph' });
  at();
  const up = callTx(db, 'block.update', { pageId: r, blockId: ins.r.result.blockId, patch: { text: '行の本文' } });
  const un = revert(db, r, [up.tx]);
  assert.strictEqual(code(un.r), 'ok', `行の本文の戻し: ${un.r.code}`);
  assert.deepStrictEqual(ok(call(db, 'page.get', { id: r }), 'page.get').page.blocks.map((b) => b.text), ['']);
  assert.strictEqual(code(revert(db, r, [ins.tx]).r), 'ok');
  assert.deepStrictEqual(ok(call(db, 'page.get', { id: r }), 'page.get').page.blocks, []);
  const add = opsOfTx(db, db.prepare("select tx from oplog where action = 'row.add' order by seq desc limit 1").get().tx);
  assert.throws(() => ops.invertOps(add), /ページの行は戻さない/, 'dbId 無しで行の add を戻した（本文が親の無い行になる）');
  assert.throws(() => ops.opsMatch(db, add), /ページの行は照らさない/);
}));

test('DS-2 直し・R42（rv40 F2）: page.delete に行の ID を渡すと bad-args（internal でない・何も変えない。行は rows.trash で消す）', T, () => withDb((db) => {
  const d = mkDb(db);
  const r = rowAddA(db, d);
  const snap = dump(db);
  assert.strictEqual(code(call(db, 'page.delete', { id: r })), 'bad-args');
  assert.deepStrictEqual(dump(db), snap);
}));

test('DS-2 直し・R16（rv40 F6）: 送り直しの答えは、oplog の1行の行（row）の add を本文の行と取り違えない（block.insert・block.split の答えの blockId は本文の行）', T, () => withDb((db) => {
  const d = mkDb(db);
  const r = rowAddA(db, d);
  const b = ok(call(db, 'block.insert', { pageId: r, afterBlockId: '', type: 'paragraph' }), 'block.insert').blockId;
  const rowOp = { op: 'add', id: 'rfake1', row: ops.rowBlock({ id: 'rfake1', db: d, ord: 'z', title: '', cells: {}, by: { c: 'me', u: 'me' }, no: 9, at: '' }) };   // データベースの行の題名（D77 の会議の題名でない）
  const blkOp = { op: 'add', id: b, row: ops.blockRow({ id: b, type: 'paragraph', text: '' }, r, 'i') };
  const oplogRow = { ops: JSON.stringify([rowOp, blkOp]) };
  for (const cmd of ['block.insert', 'block.split', 'block.duplicate']) {
    assert.strictEqual(core.COMMANDS[cmd].dupResult(db, { pageId: r, blockId: b }, oplogRow, { labels: {} }).blockId, b, `${cmd} の送り直しが行の ID を返した`);
  }
}));

test('DS-2 直し・R40（rv40 F5）: 1つの applyOps の中では、データベースの列（設定）を行ごとに読み直さない（選んだ 300 行のセル・300 行の貼り付け）', T, () => withDb((db) => {
  const d = mkDb(db);
  const t = colAdd(db, d, 'text', 'メモ');
  const ids = [];
  for (let i = 0; i < 300; i += 1) ids.push(`rc${i}`);
  put(db, ids.map((id, i) => rowAdd(id, d, `k${String(i).padStart(4, '0')}`, `行 ${i}`)));
  const SQL = 'select attrs from blocks where id = ? and type = ?';
  let reads = 0;
  const wrapped = new Proxy(db, { get(target, key) {
    const v = Reflect.get(target, key);
    if (key === 'prepare') return (sql, ...rest) => { if (sql === SQL) reads += 1; return v.call(target, sql, ...rest); };
    return typeof v === 'function' ? v.bind(target) : v;
  } });
  const r1 = core.call(wrapped, { role: 'app', cmd: 'rows.setCell', args: { db: d, ids, col: t, value: 'x' }, tx: txOf('app') }, { now, labels: {} });
  assert.strictEqual(code(r1), 'ok');
  assert.ok(reads <= 2, `列を ${reads} 回読んだ`);
  reads = 0;
  const grid = ids.map((_, i) => [`新 ${i}`]);
  const r2 = core.call(wrapped, { role: 'app', cmd: 'rows.paste', args: { db: d, viewId: 'v1', at: { row: ids[299], col: 'title' }, grid }, tx: txOf('app') }, { now, labels: {} });
  assert.deepStrictEqual([code(r2), r2.result.added], ['ok', 299]);
  assert.ok(reads <= 2, `貼り付けで列を ${reads} 回読んだ`);
}));

// ---------------------------------------------------------------- DS-3 直し（2026-11-08 の 9304bb5..e3981e3 の点検: rv42）
const attrsOf = (db, id) => JSON.parse(db.prepare('select attrs from blocks where id = ?').get(id).attrs);
const liveRows = (db, d) => db.prepare("select count(*) c from blocks where type = 'row' and parent_id = ? and trashed_at is null").get(d).c;

test('DS-3 直し・I1（rv42）: 列と選択肢の ID は使い直さない（完全に消した列・消した選択肢の ID を、後の列・選択肢に振らない）。完全に消すと、ビューの設定からもその列を外す', T, () => withDb((db) => {
  const d = mkDb(db);
  const c1 = colAdd(db, d, 'text', 'メモ');
  const c2 = colAdd(db, d, 'text', '備考');
  ok(call(db, 'view.update', { db: d, viewId: 'v1', patch: { sort: [{ col: c2, dir: 'asc' }], filter: { op: 'and', items: [{ col: c2, cmp: 'contains', value: 'abc' }] },
    group: { col: c2 }, agg: { [c2]: 'count' } } }), 'view.update');
  ok(call(db, 'col.remove', { db: d, col: c2 }), 'col.remove');
  ok(call(db, 'col.purge', { db: d, col: c2 }), 'col.purge');
  assert.ok(!JSON.stringify(attrsOf(db, d).views).includes(`"${c2}"`), '完全に消した列がビューの設定に残る');
  const c3 = colAdd(db, d, 'text', '次');
  assert.notStrictEqual(c3, c2, '完全に消した列の ID を使い直した');
  assert.ok(![c1, c2].includes(c3));
  // 新しい列に、消した列の絞り込みが生き返らない
  const r = rowAddA(db, d, { cells: { [c3]: 'xyz' } });
  assert.deepStrictEqual(view(db, d).rows.map((x) => x.id), [r]);
  // 選択肢: 一番大きい ID の選択肢を消してから足しても、その ID を振らない（画面が送った ID でも、新しい選択肢は DB が振り直す）
  const s = selectCol(db, d);
  ok(call(db, 'col.setOpts', { db: d, col: s, opts: [{ id: 'o1', name: '高', color: 'red' }] }), 'col.setOpts 消す');
  const got = ok(call(db, 'col.setOpts', { db: d, col: s, opts: [{ id: 'o1', name: '高', color: 'red' }, { id: 'o2', name: '中', color: 'blue' }] }), 'col.setOpts 足す').col;
  assert.strictEqual(got.opts[0].id, 'o1');
  assert.ok(!['o1', 'o2'].includes(got.opts[1].id), `消した選択肢の ID を使い直した: ${got.opts[1].id}`);
  assert.deepStrictEqual(dbGet(db, d).cols.find((c) => c.id === s).opts.map((o) => o.name), ['高', '中']);
  // 種類の読み替え（選択 → テキスト → 選択）と貼り付けで足す選択肢も、前に振った ID を使い直さない
  const r2 = rowAddA(db, d, { cells: { [s]: got.opts[1].id } });
  ok(call(db, 'col.setType', { db: d, col: s, type: 'text' }), 'col.setType text');
  const back = ok(call(db, 'col.setType', { db: d, col: s, type: 'select' }), 'col.setType select').col;
  const used = new Set(['o1', 'o2', got.opts[1].id]);
  assert.ok(back.opts.every((o) => !used.has(o.id)), `読み替えで前の ID を使い直した: ${back.opts.map((o) => o.id)}`);
  assert.deepStrictEqual(back.opts.map((o) => o.name), ['中']);
  assert.strictEqual(cellsOf(db, r2)[s], back.opts[0].id, '読み替えたセルが振り直した ID を指さない');
  for (const o of back.opts) used.add(o.id);
  const p = ok(call(db, 'rows.paste', { db: d, viewId: 'v1', at: { row: r2, col: s }, grid: [['新しい']] }), 'rows.paste');
  assert.strictEqual(p.unread, 0);
  const after = dbGet(db, d).cols.find((c) => c.id === s).opts;
  const fresh = after.find((o) => o.name === '新しい');
  assert.ok(fresh && !used.has(fresh.id), '貼り付けで足した選択肢が前の ID を使い直した');
  assert.strictEqual(cellsOf(db, r2)[s], fresh.id);
}));

test('DS-3 直し・I2（rv42）: 列を足した歩みの edit.revert は、その列に値のある行（ゴミ箱の行も）があれば stale（何も変えない・行のセルを残さない）', T, () => withDb((db) => {
  const d = mkDb(db);
  const add = callTx(db, 'col.add', { db: d, type: 'text', name: 'メモ' });
  const c = add.r.result.col.id;
  const r = rowAddA(db, d, { cells: { [c]: 'abc' } });
  assert.strictEqual(code(revert(db, d, [add.tx]).r), 'stale', '値のある列を消した');
  assert.ok(dbGet(db, d).cols.some((x) => x.id === c));
  assert.strictEqual(cellsOf(db, r)[c], 'abc');
  ok(call(db, 'rows.trash', { db: d, ids: [r] }), 'rows.trash');
  assert.strictEqual(code(revert(db, d, [add.tx]).r), 'stale', 'ゴミ箱の行に値のある列を消した');
  // 値の無い列なら戻せる
  const add2 = callTx(db, 'col.add', { db: d, type: 'number', name: '数' });
  assert.strictEqual(code(revert(db, d, [add2.tx]).r), 'ok');
  assert.ok(!dbGet(db, d).cols.some((x) => x.id === add2.r.result.col.id));
}));

test('DS-3 直し・M1（rv42）: 元に戻す・やり直しでも、1つのデータベースの行は 10,000 まで（rows.trash の戻し・row.add のやり直しは too-big・何も変えない）', T, () => withDb((db) => {
  const d = mkDb(db);
  const rows = [];
  for (let i = 0; i < LIMITS.dbRows - 1; i += 1) rows.push(rowAdd(`rm${i}`, d, `k${String(i).padStart(5, '0')}`, `行 ${i}`));
  put(db, rows);
  rows.length = 0;
  assert.strictEqual(liveRows(db, d), LIMITS.dbRows - 1);
  const t1 = callTx(db, 'rows.trash', { db: d, ids: ['rm0'] });
  rowAddA(db, d);
  rowAddA(db, d);
  assert.strictEqual(liveRows(db, d), LIMITS.dbRows);
  assert.strictEqual(code(revert(db, d, [t1.tx]).r), 'too-big', 'rows.trash の戻しで上限を越えた');
  assert.strictEqual(liveRows(db, d), LIMITS.dbRows);
  assert.ok(blockOf(db, 'rm0').trashed_at, '断ったのに行が戻った');
  // row.add の歩みを戻して（ゴミ箱へ）から1行足し、やり直す
  const a = callTx(db, 'row.add', { db: d });
  assert.strictEqual(code(a.r), 'too-big');
  ok(call(db, 'rows.trash', { db: d, ids: ['rm1'] }), 'rows.trash');
  const a2 = callTx(db, 'row.add', { db: d });
  const undo = revert(db, d, [a2.tx]);
  assert.strictEqual(code(undo.r), 'ok');
  rowAddA(db, d);
  assert.strictEqual(code(revert(db, d, [undo.tx]).r), 'too-big', 'row.add のやり直しで上限を越えた');
  assert.strictEqual(liveRows(db, d), LIMITS.dbRows);
}));

test('DS-3 直し・M2（rv42）: rows.paste で同じ時刻に足す行の ID が重ならない（1つの命令の中で振った ID を覚える）', T, () => withDb((db) => {
  const d = mkDb(db);
  const r0 = rowAddA(db, d);
  const nodeCrypto = require('node:crypto');
  const real = nodeCrypto.randomBytes;
  const seq = [5, 5, 5, 6, 6, 7, 7, 8];
  nodeCrypto.randomBytes = (n) => { const b = Buffer.alloc(n); b.writeUInt32BE(seq.length ? seq.shift() : 9, 0); return b; };
  let r;
  try { r = call(db, 'rows.paste', { db: d, viewId: 'v1', at: { row: r0, col: 'title' }, grid: [['甲'], ['乙'], ['丙'], ['丁']] }); }
  finally { nodeCrypto.randomBytes = real; }
  assert.strictEqual(code(r), 'ok', '同じ時刻に足した行の ID が重なった');
  assert.strictEqual(r.result.added, 3);
  assert.deepStrictEqual(titles(db, d), ['甲', '乙', '丙', '丁']);
}));

test('DS-3 直し・M3（rv42）: 表の書く命令の送り直し（同じ tx）は、1回目と同じ形の答え（R29）を今の中身から作り直す', T, () => withDb((db) => {
  const d = mkDb(db);
  const c = colAdd(db, d, 'text', 'メモ');
  const s = selectCol(db, d);
  const r1 = rowAddA(db, d, { title: '一' });   // データベースの行の題名（D77 の会議の題名でない）
  const r2 = rowAddA(db, d, { title: '二' });   // データベースの行の題名（D77 の会議の題名でない）
  const twice = (cmd, args) => {
    const tx = txOf('app');
    const a = core.call(db, { role: 'app', cmd, args, tx }, { now, labels: {} });
    const b = core.call(db, { role: 'app', cmd, args, tx }, { now, labels: {} });
    assert.strictEqual(code(a), 'ok', cmd);
    assert.strictEqual(b.dup, true, `${cmd}: 送り直しでない`);
    assert.deepStrictEqual(b.result, a.result, `${cmd}: 送り直しの答えが違う`);
    return a.result;
  };
  twice('col.add', { db: d, type: 'number', name: '金額' });
  twice('col.rename', { db: d, col: c, name: '覚え' });
  twice('col.move', { db: d, col: c, after: '' });
  ok(call(db, 'row.setCell', { db: d, id: r1, col: c, value: '12' }), 'row.setCell');
  ok(call(db, 'row.setCell', { db: d, id: r2, col: c, value: 'abc' }), 'row.setCell');
  const st = twice('col.setType', { db: d, col: c, type: 'number' });
  assert.strictEqual(st.emptied, 1);
  twice('col.setOpts', { db: d, col: s, opts: [{ id: 'o1', name: '高', color: 'red' }] });
  const n = colAdd(db, d, 'number', '数');
  twice('col.setFmt', { db: d, col: n, fmt: 'yen' });
  twice('col.remove', { db: d, col: n });
  twice('col.restore', { db: d, col: n });
  ok(call(db, 'col.remove', { db: d, col: n }), 'col.remove');
  twice('col.purge', { db: d, col: n });
  twice('row.move', { db: d, id: r2, afterId: '' });
  twice('rows.setCell', { db: d, ids: [r1, r2], col: s, value: 'o1' });
  const p = twice('rows.paste', { db: d, viewId: 'v1', at: { row: r2, col: 'title' }, grid: [['三', '3', 'x', '1', 'e'], ['四', 'y', 'z', '2', 'f'], ['五', '5', '高', '3', 'g']] });
  assert.deepStrictEqual(p, { filled: 12, added: 1, skipped: 3, unread: 1 }, '貼り付けの数（このテストの前提）');
  const v = twice('view.add', { db: d, layout: 'list', name: 'リスト' });
  twice('view.update', { db: d, viewId: v.view.id, patch: { sort: [{ col: 'title', dir: 'desc' }] } });
  twice('view.move', { db: d, viewId: v.view.id, after: '' });
  twice('view.remove', { db: d, viewId: v.view.id });
}));

test('DS-3 直し（rv42 の手の変異 m3・m4・m6・m7・m18・m23）: 足した行の戻しは後でセルが変われば stale・列の歩みは後で列が変われば stale・種類の読み替えと選択肢を消すはゴミ箱の行にも当てる・戻すと行の最終更新は今の時刻と自分・消した列のセルは書けない・db.view は出す列のセルだけ', T, () => withDb((db) => {
  const d = mkDb(db);
  const c = colAdd(db, d, 'text', 'メモ');
  const s = selectCol(db, d);
  // m3: 足した行の歩みを、後で書いたセルの上から戻さない
  const a = callTx(db, 'row.add', { db: d, cells: { [c]: 'x' } });
  ok(call(db, 'row.setCell', { db: d, id: a.r.result.id, col: c, value: 'y' }), 'row.setCell');
  assert.strictEqual(code(revert(db, d, [a.tx]).r), 'stale', '後で書いたセルの行を戻して消した');
  // m4: 列の名前の歩みを、後で列を足した上から戻さない
  const rn = callTx(db, 'col.rename', { db: d, col: c, name: '覚え' });
  colAdd(db, d, 'number', '数');
  assert.strictEqual(code(revert(db, d, [rn.tx]).r), 'stale', '後で列が変わったのに列の歩みを戻した');
  // m6: ゴミ箱の行にも読み替えと選択肢を消すが当たる（R32・R34）
  const t = rowAddA(db, d, { cells: { [c]: '12', [s]: 'o2' } });
  ok(call(db, 'rows.trash', { db: d, ids: [t] }), 'rows.trash');
  ok(call(db, 'col.setType', { db: d, col: c, type: 'number' }), 'col.setType');
  ok(call(db, 'col.setOpts', { db: d, col: s, opts: [{ id: 'o1', name: '高', color: 'red' }] }), 'col.setOpts');
  assert.deepStrictEqual(cellsOf(db, t), { [c]: 12 }, 'ゴミ箱の行のセルを読み替えない・消した選択肢を外さない');
  // m7: 戻して書き直した行の最終更新日時と更新者は、戻した時刻と自分（R31）
  const r = rowAddA(db, d);
  const w = callTx(db, 'row.setCell', { db: d, id: r, col: c, value: 5 });
  clock += 3600000;
  ok(revert(db, d, [w.tx]).r, 'edit.revert');
  const row = view(db, d).rows.find((x) => x.id === r);
  assert.strictEqual(row.updatedAt, new Date(clock).toISOString(), '戻した行の最終更新日時が戻した時刻でない');
  assert.deepStrictEqual(row.by, { c: 'me', u: 'me' });
  // m18: 消した列のセルは書けない
  ok(call(db, 'col.remove', { db: d, col: c }), 'col.remove');
  assert.strictEqual(code(call(db, 'row.setCell', { db: d, id: r, col: c, value: 1 })), 'bad-args', '消した列のセルを書けた');
  assert.strictEqual(code(call(db, 'rows.setCell', { db: d, ids: [r], col: c, value: 1 })), 'bad-args');
  ok(call(db, 'col.restore', { db: d, col: c }), 'col.restore');
  // m23: db.view は出す列のセルだけ
  ok(call(db, 'row.setCell', { db: d, id: r, col: c, value: 7 }), 'row.setCell');
  ok(call(db, 'view.update', { db: d, viewId: 'v1', patch: { props: dbGet(db, d).views[0].props.map((p) => (p.col === c ? { ...p, show: false } : p)) } }), 'view.update');
  assert.ok(!Object.hasOwn(view(db, d).rows.find((x) => x.id === r).cells, c), '隠した列のセルを返した');
}));

test('DS-3 直し（rv42 の手の変異 m2・m12・m11・m16・m1）: 末尾に足す並びの鍵は短いまま（R31）・列とビューの設定が 256KB を越えると too-big・リレーションの列は書けず貼り付けでは飛ばす・1つの applyOps で列を書いたら覚えた列を捨てる', T, () => withDb((db) => {
  const d = mkDb(db);
  const r0 = rowAddA(db, d);
  // m2: 1,500 行を末尾に足しても、並びの鍵は 6 字まで
  const grid = Array.from({ length: 1500 }, (_, i) => [`行 ${i}`]);
  ok(call(db, 'rows.paste', { db: d, viewId: 'v1', at: { row: r0, col: 'title' }, grid }), 'rows.paste');
  const longest = db.prepare("select max(length(ord)) m from blocks where type = 'row' and parent_id = ?").get(d).m;
  assert.ok(longest <= 6, `並びの鍵が長い（${longest} 字）`);
  // m12: 列の設定（選択肢）が 256KB を越える書き込みは too-big
  const opts = Array.from({ length: 200 }, (_, i) => ({ id: `o${i + 1}`, name: `${'x'.repeat(95)}${String(i).padStart(4, '0')}`, color: 'default' }));
  let last = 'ok';
  for (let k = 0; k < 12 && last === 'ok'; k += 1) {
    const sc = colAdd(db, d, 'select', `選択 ${k}`);
    last = code(call(db, 'col.setOpts', { db: d, col: sc, opts }));
  }
  assert.strictEqual(last, 'too-big', '256KB を越える列の設定を書いた');
  assert.ok(Buffer.byteLength(JSON.stringify({ cols: attrsOf(db, d).cols, views: attrsOf(db, d).views })) <= LIMITS.dbAttrs);
  // m11・m16: リレーションの列（DR-1 まで命令では作れないので種で置く）は row.setCell では書けず、貼り付けでは飛ばす
  const d2 = mkDb(db);
  const a2 = attrsOf(db, d2);
  put(db, [{ op: 'set', id: d2, key: 'cols', value: [...a2.cols, { id: 'c9', name: 'つなぐ', type: 'rel', db: d2 }], old: a2.cols }]);
  const q = rowAddA(db, d2);
  assert.strictEqual(code(call(db, 'row.setCell', { db: d2, id: q, col: 'c9', value: [q] })), 'bad-args');
  ok(call(db, 'view.update', { db: d2, viewId: 'v1', patch: { props: [{ col: 'title', show: true, wrap: false }, { col: 'c9', show: true, wrap: false }] } }), 'view.update');
  const pr = ok(call(db, 'rows.paste', { db: d2, viewId: 'v1', at: { row: q, col: 'title' }, grid: [['甲', q]] }), 'rows.paste');
  assert.deepStrictEqual([pr.filled, pr.skipped], [1, 1], 'リレーションの列に貼った');
  // m1: 1つの applyOps で、行を足して（列を覚える）から列の選択肢の名前を変えると、行の検索の欄は新しい名前
  const d3 = mkDb(db);
  const s3 = selectCol(db, d3);
  const cols3 = attrsOf(db, d3).cols;
  const renamed = cols3.map((x) => (x.id === s3 ? { ...x, opts: x.opts.map((o) => (o.id === 'o1' ? { ...o, name: '最優先' } : o)) } : x));
  put(db, [rowAdd('rq1', d3, 'k1', '行', { [s3]: 'o1' }), { op: 'set', id: d3, key: 'cols', value: renamed, old: cols3 }]);
  assert.ok(blockOf(db, 'rq1').fold.includes(searchFold('最優先')), '列を書いた後も前の列で検索の欄を作った');
}));

test('PERF・DS-3 直し・I3（rv42）: 1万行で、列の名前・並び・見せ方を変えても行の検索の欄を読み直さない。列を消す・戻す・選択肢の名前を変える・種類を変えるとその列に値のある行だけを作り直す（かかった時間を出す: 目安は持ち主に問う）', { timeout: 300000 }, (tc) => withDb((db) => {
  const d = mkDb(db);
  const txt = colAdd(db, d, 'text', 'メモ');
  const sel = selectCol(db, d);
  const num = colAdd(db, d, 'number', '金額');
  const empty = colAdd(db, d, 'text', '空');
  const rows = [];
  for (let i = 0; i < 10000; i += 1) rows.push(rowAdd(`rp${i}`, d, `k${String(i).padStart(5, '0')}`, `行 ${i}`, { [txt]: `メモ ${i % 97}`, [sel]: i % 3 ? 'o1' : 'o2', [num]: i }, i + 1));
  put(db, rows);
  rows.length = 0;
  const SQL = 'select type, parent_id, text, attrs, fold from blocks where id = ?';
  let reads = 0;
  const wrapped = new Proxy(db, { get(target, key) {
    const v = Reflect.get(target, key);
    if (key === 'prepare') return (sql, ...rest) => { if (sql === SQL) reads += 1; return v.call(target, sql, ...rest); };
    return typeof v === 'function' ? v.bind(target) : v;
  } });
  const times = {};
  const run = (name, cmd, args) => {
    reads = 0;
    const t0 = process.hrtime.bigint();
    const tx = txOf('app');
    const r = core.call(wrapped, { role: 'app', cmd, args, tx }, { now, labels: {} });
    times[name] = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.strictEqual(code(r), 'ok', name);
    return { r, n: reads, tx };
  };
  // 検索の欄に入らない変え方は、行を1つも読み直さない
  for (const [name, cmd, args] of [['col.rename', 'col.rename', { db: d, col: txt, name: '覚え' }], ['col.move', 'col.move', { db: d, col: num, after: '' }],
    ['col.setFmt', 'col.setFmt', { db: d, col: num, fmt: 'yen' }], ['col.remove（値の無い列）', 'col.remove', { db: d, col: empty }], ['col.remove（数値）', 'col.remove', { db: d, col: num }]]) {
    assert.strictEqual(run(name, cmd, args).n, 0, `${name} で行の検索の欄を読み直した`);
  }
  // 値のある列だけ: 選択肢の名前を変える・テキストの列を消す・戻す・種類を変える
  const so = run('col.setOpts（名前を変える）', 'col.setOpts', { db: d, col: sel, opts: [{ id: 'o1', name: '最優先', color: 'red' }, { id: 'o2', name: '低', color: 'default' }] });
  assert.strictEqual(so.n, 10000);
  assert.ok(blockOf(db, 'rp1').fold.includes(searchFold('最優先')));
  assert.strictEqual(run('col.remove（テキスト）', 'col.remove', { db: d, col: txt }).n, 10000);
  assert.ok(!blockOf(db, 'rp1').fold.includes(searchFold('メモ 1')), '消した列の文字が検索の欄に残る');
  assert.strictEqual(run('col.restore（テキスト）', 'col.restore', { db: d, col: txt }).n, 10000);
  assert.ok(blockOf(db, 'rp1').fold.includes(searchFold('メモ 1')));
  const st = run('col.setType（選択 → テキスト）', 'col.setType', { db: d, col: sel, type: 'text' });
  assert.strictEqual(st.n, 10000);
  run('col.setType の Ctrl+Z', 'edit.revert', { pageId: d, steps: [st.tx] });
  assert.strictEqual(dbGet(db, d).cols.find((c) => c.id === sel).type, 'select');
  tc.diagnostic(`1万行の列の命令（ミリ秒）: ${JSON.stringify(times)}`);
}));

// ---------------------------------------------------------------- DV-2（決めたこと 13・TR6・R63）
// DV-2 直し（rv46 M7・R85）で意図して直した: 確かめに出す数はゴミ箱でない行だけ（col.setType はゴミ箱の行も読み替え、emptied はそれも数える）
test('DV-2・R63: col.typeCheck（読む命令）は種類を変えると読めずに空になるセルの数（ゴミ箱でない行）を返し、何も書かない。変えられない種類は bad-args', T, () => withDb((db) => {
  const d = mkDb(db);
  const a = colAdd(db, d, 'text', 'メモ');
  rowAddA(db, d, { cells: { [a]: '12' } });
  rowAddA(db, d, { cells: { [a]: '約 3' } });
  const gone = rowAddA(db, d, { cells: { [a]: 'よみ' } });
  rowAddA(db, d, {});
  ok(call(db, 'rows.trash', { db: d, ids: [gone] }), 'rows.trash');
  const seq = () => db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
  const before = seq();
  const peek = ok(call(db, 'col.typeCheck', { db: d, col: a, type: 'number' }), 'col.typeCheck');
  assert.deepStrictEqual(peek, { emptied: 1 });
  assert.strictEqual(seq(), before, '読む命令が oplog に書いた');
  assert.strictEqual(core.COMMANDS['col.typeCheck'].write, false);
  assert.deepStrictEqual(ok(call(db, 'col.typeCheck', { db: d, col: a, type: 'text' }), 'same'), { emptied: 0 });
  assert.deepStrictEqual(ok(call(db, 'col.typeCheck', { db: d, col: a, type: 'select' }), 'select'), { emptied: 0 });
  assert.strictEqual(cellsOf(db, gone)[a], 'よみ');
  assert.strictEqual(dbGet(db, d).cols.find((c) => c.id === a).type, 'text', '読む命令で種類が変わった');
  for (const [col, type] of [[a, 'rel'], [a, 'ctime'], ['title', 'text'], ['c99', 'text']]) assert.strictEqual(code(call(db, 'col.typeCheck', { db: d, col, type })), 'bad-args', `${col} → ${type}`);
  assert.strictEqual(ok(call(db, 'col.setType', { db: d, col: a, type: 'number' }), 'col.setType').emptied, 2, 'col.setType がゴミ箱の行を読み替えない');
}));

// ---------------------------------------------------------------- DV-1 直し（2026-11-08 の e3981e3..6377ef8 の点検 rv44: F5・F6）
test('DV-1 直し・R56: 足した列を戻した後に足す列は、戻した列の ID を使い直さない（seq は元に戻すで戻さない）', T, () => withDb((db) => {
  const d = mkDb(db);
  const a1 = callTx(db, 'col.add', { db: d, type: 'text', name: '一つ目' });
  const id1 = ok(a1.r, 'col.add').col.id;
  assert.strictEqual(code(revert(db, d, [a1.tx]).r), 'ok');
  assert.ok(!dbGet(db, d).cols.some((c) => c.id === id1));
  const id2 = colAdd(db, d, 'text', '二つ目');
  assert.notStrictEqual(id2, id1, '戻した列の ID を使い直した');
}));

test('DV-1 直し・R56: 振り直した選択肢の ID はステータスのまとまりにも当てる', T, () => withDb((db) => {
  const d = mkDb(db);
  const s = colAdd(db, d, 'status', '状態');
  const sel = colAdd(db, d, 'select', '優先度');
  const so = ok(call(db, 'col.setOpts', { db: d, col: sel, opts: [{ id: 'o4', name: '高', color: 'red' }, { id: 'o5', name: '低', color: 'default' }] }), 'opts').col.opts;
  const st = dbGet(db, d).cols.find((c) => c.id === s);
  const reuse = so[0].id;   // ほかの列で使った ID（この列には無い）を画面が送った
  const got = ok(call(db, 'col.setOpts', { db: d, col: s, opts: [...st.opts, { id: reuse, name: '保留', color: 'gray' }], groups: { ...st.groups, doing: [...st.groups.doing, reuse] } }), 'status opts').col;
  const made = got.opts.find((o) => o.name === '保留');
  assert.notStrictEqual(made.id, reuse, 'ほかの列の選択肢の ID を使い直した（このテストの前提）');
  assert.ok(got.groups.doing.includes(made.id), '振り直した ID が「進行中」のまとまりに無い');
  assert.ok(!got.groups.doing.includes(reuse), '古い ID がまとまりに残る');
}));

test('DV-1 直し・R61: 検索の欄に入る列の並びが変わると、値のある行の検索の欄をその並びに作り直す', T, () => withDb((db) => {
  const d = mkDb(db);
  const a = colAdd(db, d, 'text', '甲');
  const b = colAdd(db, d, 'text', '乙');
  const r = rowAddA(db, d, { title: '行', cells: { [a]: 'あかい', [b]: 'みどり' } });   // データベースの行の題名（D77 の会議の題名でない）
  const f0 = blockOf(db, r).fold;
  assert.ok(f0.indexOf(searchFold('あかい')) < f0.indexOf(searchFold('みどり')), '前提: 列の並びの順');
  ok(call(db, 'col.move', { db: d, col: b, after: 'title' }), 'col.move');
  const f1 = blockOf(db, r).fold;
  assert.ok(f1.indexOf(searchFold('みどり')) < f1.indexOf(searchFold('あかい')), '列を並べ替えても検索の欄が古い並びのまま');
}));

test('DV-1 直し（rv44 F5）: 足した選択肢を戻すと、その選択肢を持つ行（ゴミ箱の行も）があれば stale（何も変えない）。貼り付けで足した選択肢は行と一緒に戻る', T, () => withDb((db) => {
  const d = mkDb(db);
  const s = selectCol(db, d);
  const cols = () => dbGet(db, d).cols.find((c) => c.id === s);
  const ad = callTx(db, 'col.setOpts', { db: d, col: s, opts: [...cols().opts, { id: 'o9', name: '黄', color: 'yellow' }] });
  const nid = ok(ad.r, 'col.setOpts').col.opts.at(-1).id;
  const r = rowAddA(db, d, { cells: { [s]: nid } });
  assert.strictEqual(code(revert(db, d, [ad.tx]).r), 'stale', '持ち主のいる選択肢を戻して消した');
  assert.ok(cols().opts.some((o) => o.id === nid));
  ok(call(db, 'rows.trash', { db: d, ids: [r] }), 'rows.trash');
  assert.strictEqual(code(revert(db, d, [ad.tx]).r), 'stale', 'ゴミ箱の行の選択肢を消した');
  // 誰も持っていなければ戻せる
  const ad2 = callTx(db, 'col.setOpts', { db: d, col: s, opts: [...cols().opts, { id: 'o10', name: '紫', color: 'purple' }] });
  ok(ad2.r, 'col.setOpts 2');
  assert.strictEqual(code(revert(db, d, [ad2.tx]).r), 'ok');
  assert.ok(!cols().opts.some((o) => o.name === '紫'));
  // 貼り付けで足した選択肢と行は、同じ歩みで一緒に戻る（戻した後に持ち主はいない）
  const r2 = rowAddA(db, d, {});
  const pa = callTx(db, 'rows.paste', { db: d, viewId: 'v1', at: { row: r2, col: s }, grid: [['青']] });
  ok(pa.r, 'rows.paste');
  assert.ok(cols().opts.some((o) => o.name === '青'));
  assert.strictEqual(code(revert(db, d, [pa.tx]).r), 'ok', '貼り付けの戻しが stale');
  assert.ok(!cols().opts.some((o) => o.name === '青'));
}));

// ================================================================ DV-2 直し（2026-11-08 の 6377ef8..6a9f0c5 の点検 rv46）
test('DV-2 直し（2026-11-08 の持ち主の答え「PC の中だけの会議の名前は候補に出さない（おすすめ）」・R83）: pages.actionView の noPrivate は、オフラインモードの会議と印の分からない会議（片付けた落ちた会議で経路の記録が無い）の担当を数えない。アクション一覧（noPrivate 無し）は今のまま', T, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const seedOne = (id, who, patch) => {
      const s = pageOf(id);
      s.page.blocks = s.page.blocks.map((b) => (b.type === 'todo' ? { ...b, assignee: who } : b));
      Object.assign(s.page, patch);
      t.seed(s.page, s.segments);
    };
    seedOne('pa1', '総務係', {});
    seedOne('pa2', '人事係', { route: { stt: { cloud: 0, local: 3, provider: '' }, localOnly: true } });
    seedOne('pa3', '経理係', { meeting: { phase: 'done', recovered: false, localOnly: true } });
    seedOne('pa4', '企画係', { recovered: true, route: undefined });
    const all = ok(call(db, 'pages.actionView', {}), 'pages.actionView');
    assert.deepStrictEqual(all.people.map((p) => p.name).sort(), ['人事係', '企画係', '経理係', '総務係'].sort(), 'アクション一覧が変わった');
    const out = ok(call(db, 'pages.actionView', { noPrivate: true }), 'pages.actionView');
    assert.deepStrictEqual(out.people.map((p) => p.name), ['総務係']);
    assert.ok(out.actions.every((a) => a.pageId === 'pa1'));
  } finally { t.done(); }
});

test('DV-3 直し（rv48 F11・R88）: ビューの ID は使い直さない（消したビューの古いリンクがほかのビューを開かない）', T, () => withDb((db) => {
  const d = mkDb(db);
  const v2 = ok(call(db, 'view.add', { db: d }), 'view.add').view.id;
  assert.strictEqual(v2, 'v2');
  ok(call(db, 'view.remove', { db: d, viewId: v2 }), 'view.remove');
  assert.strictEqual(ok(call(db, 'view.add', { db: d }), 'view.add').view.id, 'v3');
  // 列を足しても（列と選択肢の数 seq.c・seq.o を書いても）ビューの数は残る
  ok(call(db, 'view.remove', { db: d, viewId: 'v3' }), 'view.remove');
  colAdd(db, d, 'text', 'メモ');
  assert.strictEqual(ok(call(db, 'view.add', { db: d }), 'view.add').view.id, 'v4');
}));

// ================================================================ DV-4（決めたこと 26・R90〜）
test('DV-4（R91）: page.get の行の答えにデータベースの ID（db）を添える（ページの欄には入れない）。ページ・データベースの答えには db が無い', T, () => withDb((db) => {
  const d = ok(call(db, 'db.create', {}), 'db.create').id;
  // データベースの行の題名（D77 の会議の題名でない）
  const r = rowAddA(db, d, { title: '行の題名' });
  const got = ok(call(db, 'page.get', { id: r }), 'page.get');
  assert.strictEqual(got.db, d, '行の答えにデータベースの ID が無い');
  assert.ok(!Object.hasOwn(got.page, 'db') && !Object.hasOwn(got.page, 'kind'), 'ページの欄に db・kind を入れた（書き戻すと行の attrs に入る）');
  assert.strictEqual(got.page.title, '行の題名');
  assert.ok(!Object.hasOwn(ok(call(db, 'page.get', { id: d }), 'page.get'), 'db'), 'データベースの答えに db がある');
  assert.ok(!Object.hasOwn(ok(call(db, 'page.get', { id: 'pa1' }), 'page.get'), 'db'), '議事録の答えに db がある');
  assert.ok(!Object.hasOwn(JSON.parse(blockOf(db, r).attrs), 'db'));
}));

// ================================================================ R97（2026-11-09 の持ち主の答え・M14: 行の本文の /ページ）
const listIds = (db) => ok(call(db, 'pages.list', {}), 'pages.list').map((e) => e.id);
const listEntry = (db, id) => ok(call(db, 'pages.list', {}), 'pages.list').find((e) => e.id === id);
const subRows = (db, id) => ok(call(db, 'page.get', { id }), 'page.get').page.blocks.filter((b) => b.type === 'subpage').map((b) => b.page);

test('R97: page.create は生きている行の中に白紙のページを作る（親は行・行の本文の最後か placeAt の所に 📄 の行・oplog は1行）。一覧には inRow（行・題名・データベース・その題名）つきで出る。孫も同じ', T, () => withDb((db) => {
  const d = mkDb(db);
  // データベースの題名（D77 の会議の題名でない）
  ok(call(db, 'page.setTitle', { id: d, title: '案件' }), 'page.setTitle');
  // データベースの行の題名（D77 の会議の題名でない）
  const r = rowAddA(db, d, { title: '見積もり' });
  const b = ok(call(db, 'block.insert', { pageId: r, afterBlockId: '', type: 'paragraph' }), 'block.insert').blockId;
  const mk = callTx(db, 'page.create', { parentId: r });
  const c1 = ok(mk.r, 'page.create').id;
  assert.deepStrictEqual([blockOf(db, c1).type, blockOf(db, c1).parent_id, ok(mk.r, '').page.kind], ['page', r, 'blank']);
  assert.ok(db.prepare("select count(*) as c from oplog where role = 'app' and tx = ?").get(mk.tx).c === 1);
  assert.deepStrictEqual(subRows(db, r), [c1], '行の本文の最後に 📄 の行が無い');
  const c2 = ok(call(db, 'page.create', { parentId: r, placeAt: b }), 'page.create').id;
  assert.deepStrictEqual(ok(call(db, 'page.get', { id: r }), 'page.get').page.blocks.map((x) => x.type === 'subpage' ? x.page : x.id), [c2, c1], 'placeAt の空の行が 📄 の行にならない');
  assert.notStrictEqual(blockOf(db, c1).ord, blockOf(db, c2).ord, '行の子の並びの鍵が同じ');
  const g = ok(call(db, 'page.create', { parentId: c1 }), 'page.create').id;
  // データベースと行の題名（D77 の会議の題名でない）
  for (const id of [c1, c2, g]) assert.deepStrictEqual(listEntry(db, id).inRow, { row: r, title: '見積もり', db: d, dbTitle: '案件' }, `${id} の一覧の1行に inRow が無い`);
  assert.ok(!Object.hasOwn(listEntry(db, d), 'inRow') && !Object.hasOwn(listEntry(db, 'pa1'), 'inRow'));
  assert.strictEqual(listEntry(db, g).parentId, c1);
  // 行の本文に書いた後も行のセルと題名はそのまま
  assert.strictEqual(view(db, d).rows[0].title, '見積もり');
}));

test('R97: 行の中に作れないとき（ゴミ箱の行・ゴミ箱のデータベースの行・無い ID）は bad-args で何も変えない。行の本文が満杯（2,000 行）なら too-big（行の無い子を作らない）', T, () => withDb((db) => {
  const d = mkDb(db);
  const [r1, r2] = [rowAddA(db, d), rowAddA(db, d)];
  ok(call(db, 'rows.trash', { db: d, ids: [r1] }), 'rows.trash');
  const before = dump(db);
  assert.strictEqual(code(call(db, 'page.create', { parentId: r1 })), 'bad-args');
  assert.strictEqual(code(call(db, 'page.create', { parentId: 'rnothere1' })), 'bad-args');
  assert.deepStrictEqual(dump(db), before);
  const d2 = mkDb(db);
  const r3 = rowAddA(db, d2);
  ok(call(db, 'page.delete', { id: d2 }), 'page.delete');
  const mid = dump(db);
  assert.strictEqual(code(call(db, 'page.create', { parentId: r3 })), 'bad-args');
  assert.deepStrictEqual(dump(db), mid);
  // 満杯の本文
  const list = [];
  for (let i = 0; i < 2000; i += 1) list.push({ op: 'add', id: `bfull${i}`, row: { id: `bfull${i}`, type: 'paragraph', page_id: r2, parent_id: r2, ord: `a${String(i).padStart(5, '0')}`, text: '', rich: null, attrs: '{}', fold: '' } });
  put(db, list);
  const full = dump(db);
  assert.strictEqual(code(call(db, 'page.create', { parentId: r2 })), 'too-big');
  assert.deepStrictEqual(dump(db), full, '満杯の行の中に行の無い子を作った');
}));

test('R97・決めたこと 28: 行をゴミ箱へ入れると、行の中の子ページ（と孫）は一覧・アクション一覧から見えなくなる（ページには書かない）。行を戻すと見える。データベースをゴミ箱へ入れても同じ', T, () => withDb((db) => {
  const d = mkDb(db);
  const r = rowAddA(db, d);
  const c = ok(call(db, 'page.create', { parentId: r }), 'page.create').id;
  const g = ok(call(db, 'page.create', { parentId: c }), 'page.create').id;
  ok(call(db, 'block.insert', { pageId: g, afterBlockId: '', type: 'todo' }), 'block.insert');
  const tb = ok(call(db, 'page.get', { id: g }), 'page.get').page.blocks[0].id;
  ok(call(db, 'block.update', { pageId: g, blockId: tb, patch: { text: '見積もりを送る' } }), 'block.update');
  const acts = () => ok(call(db, 'pages.actionView', {}), 'pages.actionView').actions.map((x) => x.pageId);
  assert.ok(listIds(db).includes(c) && listIds(db).includes(g) && acts().includes(g));
  const tr = callTx(db, 'rows.trash', { db: d, ids: [r] });
  assert.strictEqual(code(tr.r), 'ok');
  assert.deepStrictEqual(opsOfTx(db, tr.tx).map((o) => o.id), [r], '子ページにゴミ箱の印を書いた');
  assert.ok(!listIds(db).includes(c) && !listIds(db).includes(g), '行をゴミ箱へ入れても子が一覧に出る');
  assert.ok(!acts().includes(g), '行をゴミ箱へ入れても子の ToDo が出る');
  assert.deepStrictEqual([blockOf(db, c).trashed_at, blockOf(db, g).trashed_at], [null, null]);
  assert.ok(!ok(call(db, 'pages.trash', {}), 'pages.trash').some((x) => x.id === c || x.id === g), '子がゴミ箱の窓に出る');
  ok(call(db, 'edit.revert', { pageId: d, steps: [tr.tx] }), 'edit.revert');
  assert.ok(listIds(db).includes(c) && listIds(db).includes(g), '行を戻しても子が見えない');
  ok(call(db, 'page.delete', { id: d }), 'page.delete');
  assert.ok(!listIds(db).includes(c), 'データベースをゴミ箱へ入れても子が一覧に出る');
  assert.strictEqual(blockOf(db, c).trashed_at, null);
  ok(call(db, 'page.restore', { id: d }), 'page.restore');
  assert.ok(listIds(db).includes(c) && listIds(db).includes(g));
}));

test('R97: 行の子ページの page.delete は行の本文の 📄 の行を消して置き場を覚え、page.restore で同じ所へ戻る（親は行のまま）。行がゴミ箱のときに戻すと最上位へ（見えない所に戻さない）', T, () => withDb((db) => {
  const d = mkDb(db);
  const r = rowAddA(db, d);
  const c1 = ok(call(db, 'page.create', { parentId: r }), 'page.create').id;
  const c2 = ok(call(db, 'page.create', { parentId: r }), 'page.create').id;
  ok(call(db, 'page.delete', { id: c1 }), 'page.delete');
  assert.deepStrictEqual(subRows(db, r), [c2], '消した子の 📄 の行が本文に残る');
  assert.ok(blockOf(db, c1).trashed_at);
  ok(call(db, 'page.restore', { id: c1 }), 'page.restore');
  assert.deepStrictEqual([subRows(db, r), blockOf(db, c1).parent_id], [[c1, c2], r], '元の所へ戻らない');
  ok(call(db, 'page.delete', { id: c2 }), 'page.delete');
  ok(call(db, 'rows.trash', { db: d, ids: [r] }), 'rows.trash');
  ok(call(db, 'page.restore', { id: c2 }), 'page.restore');
  assert.deepStrictEqual([blockOf(db, c2).parent_id, blockOf(db, c2).trashed_at], [null, null], 'ゴミ箱の行の下へ戻した');
  assert.ok(listIds(db).includes(c2) && !listEntry(db, c2).inRow);
}));

test('R97: page.move で行の子ページを外へ出す（行の本文の 📄 の行が消える）・外のページを行の中へ入れる（本文の最後に行）・行の本文の中で置き直す（rowAfter）。ゴミ箱の行・見えない子・輪（自分の下のデータベースの行）は bad-args', T, () => withDb((db) => {
  const top = ok(call(db, 'page.create', {}), 'page.create').id;
  const d = mkDb(db, top);
  const r = rowAddA(db, d);
  const c1 = ok(call(db, 'page.create', { parentId: r }), 'page.create').id;
  const c2 = ok(call(db, 'page.create', { parentId: r }), 'page.create').id;
  // 本文の中で置き直す
  const rowOf = (pid) => ok(call(db, 'page.get', { id: r }), 'page.get').page.blocks.find((b) => b.type === 'subpage' && b.page === pid).id;
  ok(call(db, 'page.move', { id: c2, parentId: r, rowAfter: '' }), 'page.move');
  assert.deepStrictEqual(subRows(db, r), [c2, c1]);
  assert.ok(rowOf(c1));
  // 外へ
  ok(call(db, 'page.move', { id: c1, parentId: '' }), 'page.move');
  assert.deepStrictEqual([subRows(db, r), blockOf(db, c1).parent_id], [[c2], null]);
  assert.ok(!listEntry(db, c1).inRow);
  // 中へ
  ok(call(db, 'page.move', { id: c1, parentId: r }), 'page.move');
  assert.deepStrictEqual([subRows(db, r), blockOf(db, c1).parent_id], [[c2, c1], r]);
  assert.strictEqual(listEntry(db, c1).inRow.row, r);
  // 輪: top の下のデータベースの行の中へ top は入れない。行の子の中へも
  const before = dump(db);
  assert.strictEqual(code(call(db, 'page.move', { id: top, parentId: r })), 'bad-args');
  assert.strictEqual(code(call(db, 'page.move', { id: top, parentId: c1 })), 'bad-args');
  assert.strictEqual(code(call(db, 'page.move', { id: d, parentId: c1 })), 'bad-args');
  assert.deepStrictEqual(dump(db), before);
  // ゴミ箱の行・見えない子
  const r2 = rowAddA(db, d);
  ok(call(db, 'rows.trash', { db: d, ids: [r] }), 'rows.trash');
  const mid = dump(db);
  assert.strictEqual(code(call(db, 'page.move', { id: 'pa1', parentId: r })), 'bad-args');
  assert.strictEqual(code(call(db, 'page.move', { id: c1, parentId: '' })), 'bad-args');
  assert.strictEqual(code(call(db, 'page.create', { parentId: c1 })), 'bad-args', '見えない子の中に作った');
  assert.deepStrictEqual(dump(db), mid);
  ok(call(db, 'page.move', { id: 'pa1', parentId: r2 }), 'page.move');
  assert.deepStrictEqual(subRows(db, r2), ['pa1']);
}));

test('R97: page.get の行の子ページの答えは今のまま（db を添えない）。行の本文の 📄 の行を消すと子ページはゴミ箱へ（白紙のページと同じ）', T, () => withDb((db) => {
  const d = mkDb(db);
  const r = rowAddA(db, d);
  const c = ok(call(db, 'page.create', { parentId: r }), 'page.create').id;
  const got = ok(call(db, 'page.get', { id: c }), 'page.get');
  assert.ok(!Object.hasOwn(got, 'db') && got.page.kind === 'blank');
  const sb = ok(call(db, 'page.get', { id: r }), 'page.get').page.blocks.find((b) => b.type === 'subpage').id;
  ok(call(db, 'block.remove', { pageId: r, blockId: sb }), 'block.remove');
  assert.ok(blockOf(db, c).trashed_at, '📄 の行を消しても子がゴミ箱に入らない');
}));

// ================================================================ DR-1: リレーションとサブアイテム（計画の Task DR-1・決めたこと 33〜38・R98）
const relOf = (db, id, col) => { const c = cellsOf(db, id) || {}; return Object.hasOwn(c, col) ? c[col] : undefined; };
const oplogN = (db) => db.prepare('select count(*) as c from oplog').get().c;
// データベースの行の題名（D77 の会議の題名でない）
function twoDbs(db) {
  const d1 = mkDb(db); const d2 = mkDb(db);
  const a1 = rowAddA(db, d1, { title: '見積もり' }); const a2 = rowAddA(db, d1, { title: '発注' });   // D77 の会議の題名でない（データベースの行の題名）
  const b1 = rowAddA(db, d2, { title: '取引先 甲' }); const b2 = rowAddA(db, d2, { title: '取引先 乙' });   // D77 の会議の題名でない（データベースの行の題名）
  return { d1, d2, a1, a2, b1, b2 };
}

test('DR-1・F140: 両側のリレーション（列を足すと相手のデータベースにも列・rel.link で両側のセルが同じ oplog の1行・rel.unlink で両側から外れる・Ctrl+Z で両側が戻る）。つなぐ先の無いリレーションの列は bad-args', T, () => withDb((db) => {
  const { d1, d2, a1, a2, b1, b2 } = twoDbs(db);
  assert.strictEqual(code(call(db, 'col.add', { db: d1, type: 'rel' })), 'bad-args', 'つなぐ先が無い');
  assert.strictEqual(code(call(db, 'col.add', { db: d1, type: 'rel', target: 'pa1' })), 'bad-args', 'つなぐ先がデータベースでない');
  assert.strictEqual(code(call(db, 'col.add', { db: d1, type: 'text', target: d2 })), 'bad-args', 'リレーションでない列につなぐ先');
  const n0 = oplogN(db);
  const got = ok(call(db, 'col.add', { db: d1, type: 'rel', target: d2, both: true }), 'col.add');
  assert.strictEqual(oplogN(db), n0 + 1, '列を足すのは1つの命令');
  const col = got.col;
  const back = dbGet(db, d2).cols.find((c) => c.type === 'rel');
  assert.ok(back, '相手のデータベースに列が無い');
  assert.deepStrictEqual([col.type, col.db, col.back, back.db, back.back], ['rel', d2, back.id, d1, col.id]);
  assert.deepStrictEqual(got.back, back);
  // 足す: 両側が同じ命令
  const n1 = oplogN(db);
  ok(call(db, 'rel.link', { db: d1, id: a1, col: col.id, ids: [b1, b2] }), 'rel.link');
  assert.strictEqual(oplogN(db), n1 + 1);
  assert.deepStrictEqual([relOf(db, a1, col.id), relOf(db, b1, back.id), relOf(db, b2, back.id)], [[b1, b2], [a1], [a1]]);
  // 相手の側から足しても両方に写る
  const l2 = callTx(db, 'rel.link', { db: d2, id: b1, col: back.id, ids: [a2] });
  assert.strictEqual(code(l2.r), 'ok');
  assert.deepStrictEqual([relOf(db, b1, back.id), relOf(db, a2, col.id)], [[a1, a2], [b1]]);
  // Ctrl+Z（データベースの歩み）で両側が戻る・やり直すと両側に
  const un = revert(db, d2, [l2.tx]);
  assert.strictEqual(code(un.r), 'ok', `edit.revert: ${un.r.code}`);
  assert.deepStrictEqual([relOf(db, b1, back.id), relOf(db, a2, col.id)], [[a1], undefined]);
  assert.strictEqual(code(revert(db, d2, [un.tx]).r), 'ok');
  assert.deepStrictEqual([relOf(db, b1, back.id), relOf(db, a2, col.id)], [[a1, a2], [b1]]);
  // 外す: 両方から
  ok(call(db, 'rel.unlink', { db: d1, id: a1, col: col.id, ids: [b1] }), 'rel.unlink');
  assert.deepStrictEqual([relOf(db, a1, col.id), relOf(db, b1, back.id), relOf(db, b2, back.id)], [[b2], [a2], [a1]]);
  // 同じ行をもう一度足すのは何もしない（重ねない）・外していない行を外すのも何もしない
  const same = [callTx(db, 'rel.link', { db: d1, id: a1, col: col.id, ids: [b2] }), callTx(db, 'rel.unlink', { db: d1, id: a1, col: col.id, ids: [b1] })];
  for (const x of same) assert.deepStrictEqual([code(x.r), opsOfTx(db, x.tx)], ['ok', []], '変わらない命令に操作がある');
  // 後で相手の側が変わった歩みは stale（何も変えない）
  assert.strictEqual(code(revert(db, d2, [l2.tx]).r), 'stale');
  // つなぐ先の行は生きているつなぐ先のデータベースの行だけ（自分のデータベースの行・無い行・ゴミ箱の行は bad-args）
  for (const ids of [[a2], ['rnone'], [d2]]) assert.strictEqual(code(call(db, 'rel.link', { db: d1, id: a1, col: col.id, ids })), 'bad-args', ids[0]);
  // 片側（both 無し）: 相手に列も値も無い
  const one = ok(call(db, 'col.add', { db: d1, type: 'rel', target: d2 }), 'col.add').col;
  assert.strictEqual(one.back, undefined);
  assert.strictEqual(dbGet(db, d2).cols.filter((c) => c.type === 'rel').length, 1);
  ok(call(db, 'rel.link', { db: d1, id: a2, col: one.id, ids: [b2] }), 'rel.link');
  assert.deepStrictEqual([relOf(db, a2, one.id), relOf(db, b2, back.id)], [[b2], [a1]]);
  // 両側の片方を消すと、相手の列は片側に戻る（相手の値は消さない: 決めたこと 36）
  ok(call(db, 'col.remove', { db: d1, col: col.id }), 'col.remove');
  assert.strictEqual(dbGet(db, d2).cols.find((c) => c.id === back.id).back, undefined, '相手の列が両側のまま');
  assert.deepStrictEqual(relOf(db, b2, back.id), [a1]);
  ok(call(db, 'rel.link', { db: d2, id: b2, col: back.id, ids: [a2] }), 'rel.link');
  assert.deepStrictEqual(relOf(db, a2, col.id), [b1], '消した列に書いた');
}));

test('DR-1・F140: 相手の行をゴミ箱へ入れるとセルに出ない（値は残る）・戻すと出る。相手のデータベースをゴミ箱へ入れても出ない。101 個目は bad-args（相手の側の 101 個目も）', T, () => withDb((db) => {
  const { d1, d2, a1, a2, b1, b2 } = twoDbs(db);
  const col = ok(call(db, 'col.add', { db: d1, type: 'rel', target: d2, both: true }), 'col.add').col;
  ok(call(db, 'rel.link', { db: d1, id: a1, col: col.id, ids: [b1, b2] }), 'rel.link');
  const relIn = () => { const v = view(db, d1); return { cell: v.rows.find((r) => r.id === a1).cells[col.id], rel: v.rel || {} }; };
  assert.deepStrictEqual(relIn().rel, { [b1]: { title: '取引先 甲' }, [b2]: { title: '取引先 乙' } });   // D77 の会議の題名でない（データベースの行の題名）
  assert.strictEqual(DM.fmtCell(col, relIn().cell, { rowsById: relIn().rel }), '取引先 甲, 取引先 乙');
  const tr = callTx(db, 'rows.trash', { db: d2, ids: [b2] });
  assert.strictEqual(code(tr.r), 'ok');
  assert.deepStrictEqual(relIn().cell, [b1, b2], '値が消えた');
  assert.deepStrictEqual(Object.keys(relIn().rel), [b1], 'ゴミ箱の行がセルに出る');
  assert.strictEqual(code(call(db, 'rel.link', { db: d1, id: a2, col: col.id, ids: [b2] })), 'bad-args', 'ゴミ箱の行をつないだ');
  assert.strictEqual(code(revert(db, d2, [tr.tx]).r), 'ok');
  assert.deepStrictEqual(Object.keys(relIn().rel).sort(), [b1, b2].sort(), '戻した行が出ない');
  ok(call(db, 'page.delete', { id: d2 }), 'page.delete');
  assert.deepStrictEqual(relIn().rel, {}, 'ゴミ箱のデータベースの行が出る');
  ok(call(db, 'page.restore', { id: d2 }), 'page.restore');
  // 101 個目（自分の側）
  const many = [];
  for (let i = 0; i < 100; i += 1) many.push({ op: 'add', id: `rk${i}`, row: ops.rowBlock({ id: `rk${i}`, db: d2, ord: `k${String(i).padStart(3, '0')}`, title: `相手 ${i}`, cells: {}, by: { c: 'me', u: 'me' }, no: 100 + i, at: at() }) });   // D77 の会議の題名でない（データベースの行の題名）
  put(db, many);
  ok(call(db, 'rel.link', { db: d1, id: a2, col: col.id, ids: many.slice(0, 99).map((o) => o.id) }), 'rel.link 99');
  ok(call(db, 'rel.link', { db: d1, id: a2, col: col.id, ids: [b1] }), 'rel.link 100');
  assert.strictEqual(relOf(db, a2, col.id).length, 100);
  const mid = dump(db);
  assert.strictEqual(code(call(db, 'rel.link', { db: d1, id: a2, col: col.id, ids: ['rk99'] })), 'bad-args', '101 個目');
  assert.deepStrictEqual(dump(db), mid);
  // 相手の側の 101 個目: b1 のセルを 100 にして、もう1行から b1 をつなぐ
  const back = col.back;
  const fill = [];
  for (let i = 0; i < 98; i += 1) fill.push({ op: 'add', id: `rj${i}`, row: ops.rowBlock({ id: `rj${i}`, db: d1, ord: `j${String(i).padStart(3, '0')}`, title: `自分 ${i}`, cells: {}, by: { c: 'me', u: 'me' }, no: 300 + i, at: at() }) });   // D77 の会議の題名でない（データベースの行の題名）
  put(db, fill);
  ok(call(db, 'rel.link', { db: d2, id: b1, col: back, ids: fill.map((o) => o.id) }), 'rel.link 相手');
  assert.strictEqual(relOf(db, b1, back).length, 100);
  const a3 = rowAddA(db, d1, { title: '検収' });   // D77 の会議の題名でない（データベースの行の題名）
  const mid2 = dump(db);
  assert.strictEqual(code(call(db, 'rel.link', { db: d1, id: a3, col: col.id, ids: [b1] })), 'bad-args', '相手のセルの 101 個目');
  assert.deepStrictEqual(dump(db), mid2);
}));

test('DR-1・R98（M15-2）: 自分のデータベースへの片側のリレーション（列1つ）は、行 A のセルに行 B を入れると同じ命令で行 B のセルにも行 A・外すと両方から外れる', T, () => withDb((db) => {
  const { d1, a1, a2 } = twoDbs(db);
  const col = ok(call(db, 'col.add', { db: d1, type: 'rel', target: d1 }), 'col.add').col;
  assert.deepStrictEqual([col.db, col.back], [d1, undefined]);
  assert.strictEqual(dbGet(db, d1).cols.filter((c) => c.type === 'rel').length, 1, '列が2つできた');
  const n0 = oplogN(db);
  ok(call(db, 'rel.link', { db: d1, id: a1, col: col.id, ids: [a2] }), 'rel.link');
  assert.strictEqual(oplogN(db), n0 + 1);
  assert.deepStrictEqual([relOf(db, a1, col.id), relOf(db, a2, col.id)], [[a2], [a1]]);
  ok(call(db, 'rel.unlink', { db: d1, id: a2, col: col.id, ids: [a1] }), 'rel.unlink');
  assert.deepStrictEqual([relOf(db, a1, col.id), relOf(db, a2, col.id)], [undefined, undefined]);
  // 両側（列2つ）の自分へのリレーションは、片方に入れるともう片方に写る（同じ列には入れない）
  const two = ok(call(db, 'col.add', { db: d1, type: 'rel', target: d1, both: true }), 'col.add');
  assert.deepStrictEqual([two.col.db, two.back.db, two.col.back, two.back.back], [d1, d1, two.back.id, two.col.id]);
  ok(call(db, 'rel.link', { db: d1, id: a1, col: two.col.id, ids: [a2] }), 'rel.link');
  assert.deepStrictEqual([relOf(db, a1, two.col.id), relOf(db, a2, two.back.id), relOf(db, a2, two.col.id)], [[a2], [a1], undefined]);
}));

test('DR-1・F140: サブアイテム（db.setSub で2つの列「親アイテム」「サブアイテム」・親は1つ・自分の子孫を親にすると bad-args・［サブアイテムを足す］は新しい行を子にして作る・外すと列は残る）', T, () => withDb((db) => {
  const d = mkDb(db);
  const p1 = rowAddA(db, d, { title: '親 一' }); const p2 = rowAddA(db, d, { title: '親 二' });   // D77 の会議の題名でない（データベースの行の題名）
  const c1 = rowAddA(db, d, { title: '子 一' }); const g1 = rowAddA(db, d, { title: '孫 一' });   // D77 の会議の題名でない（データベースの行の題名）
  const n0 = oplogN(db);
  const on = ok(call(db, 'db.setSub', { db: d, on: true }), 'db.setSub');
  assert.strictEqual(oplogN(db), n0 + 1);
  const info = dbGet(db, d);
  const P = info.cols.find((c) => c.id === info.sub.parent); const K = info.cols.find((c) => c.id === info.sub.kids);
  assert.deepStrictEqual(on.sub, info.sub);
  assert.deepStrictEqual([P.name, P.type, P.db, P.back, K.name, K.type, K.db, K.back], ['親アイテム', 'rel', d, K.id, 'サブアイテム', 'rel', d, P.id]);
  // 入れたままもう一度入れても列を足さない
  ok(call(db, 'db.setSub', { db: d, on: true }), 'db.setSub');
  assert.strictEqual(dbGet(db, d).cols.length, info.cols.length);
  ok(call(db, 'rel.link', { db: d, id: c1, col: P.id, ids: [p1] }), 'rel.link 親');
  ok(call(db, 'rel.link', { db: d, id: c1, col: K.id, ids: [g1] }), 'rel.link 子');
  assert.deepStrictEqual([relOf(db, c1, P.id), relOf(db, p1, K.id), relOf(db, g1, P.id), relOf(db, c1, K.id)], [[p1], [c1], [c1], [g1]]);
  const mid = dump(db);
  // 親は1つ（どちらの列から入れても）
  assert.strictEqual(code(call(db, 'rel.link', { db: d, id: c1, col: P.id, ids: [p2] })), 'bad-args', '2つ目の親');
  assert.strictEqual(code(call(db, 'rel.link', { db: d, id: p2, col: K.id, ids: [c1] })), 'bad-args', '親のある行を子にした');
  assert.strictEqual(code(call(db, 'rel.link', { db: d, id: p2, col: P.id, ids: [p1, c1] })), 'bad-args', '1回に親を2つ');
  // 輪（自分・子・孫を親にする）
  for (const x of [p1, c1, g1]) assert.strictEqual(code(call(db, 'rel.link', { db: d, id: p1, col: P.id, ids: [x] })), 'bad-args', `輪 ${x}`);
  assert.strictEqual(code(call(db, 'rel.link', { db: d, id: g1, col: K.id, ids: [p1] })), 'bad-args', '子の列から輪');
  assert.deepStrictEqual(dump(db), mid);
  // 親を替える: 外してから入れる
  ok(call(db, 'rel.unlink', { db: d, id: c1, col: P.id, ids: [p1] }), 'rel.unlink');
  ok(call(db, 'rel.link', { db: d, id: c1, col: P.id, ids: [p2] }), 'rel.link');
  assert.deepStrictEqual([relOf(db, p1, K.id), relOf(db, p2, K.id)], [undefined, [c1]]);
  // ［サブアイテムを足す］: 新しい行（題名つき）を作って子にする（1つの命令）
  const n1 = oplogN(db);
  const add = ok(call(db, 'rel.link', { db: d, id: p1, col: K.id, ids: [], title: '新しい子' }), 'rel.link title');   // D77 の会議の題名でない（データベースの行の題名）
  assert.strictEqual(oplogN(db), n1 + 1);
  assert.match(add.added, /^r[0-9a-z]+$/);
  assert.deepStrictEqual([blockOf(db, add.added).text, blockOf(db, add.added).parent_id, relOf(db, add.added, P.id), relOf(db, p1, K.id)], ['新しい子', d, [p1], [add.added]]);
  // 外す: attrs.sub だけ消え、列と値は残る（ふつうのリレーション）
  ok(call(db, 'db.setSub', { db: d, on: false }), 'db.setSub off');
  const off = dbGet(db, d);
  assert.strictEqual(off.sub, undefined);
  assert.deepStrictEqual(off.cols.filter((c) => c.type === 'rel').map((c) => c.id), [P.id, K.id]);
  assert.deepStrictEqual(relOf(db, c1, P.id), [p2]);
  // サブアイテムでないリレーションは、親が2つでも・輪でもよい（ただのつながり）
  ok(call(db, 'rel.link', { db: d, id: c1, col: P.id, ids: [p1] }), 'rel.link');
  assert.deepStrictEqual(relOf(db, c1, P.id), [p2, p1]);
}));

test('DR-1・R98（M15-1）: 子のある行をゴミ箱へ入れると子孫も同じ命令でゴミ箱へ（答えの数は子孫も数える・同じ時刻）・Ctrl+Z で一緒に戻る。db.view の木（開いた行の子・字下げ）', T, () => withDb((db) => {
  const d = mkDb(db);
  const p1 = rowAddA(db, d, { title: '親 一' }); const p2 = rowAddA(db, d, { title: '親 二' });   // D77 の会議の題名でない（データベースの行の題名）
  const c1 = rowAddA(db, d, { title: '子 一' }); const c2 = rowAddA(db, d, { title: '子 二' }); const g1 = rowAddA(db, d, { title: '孫 一' });   // D77 の会議の題名でない（データベースの行の題名）
  const { sub } = ok(call(db, 'db.setSub', { db: d, on: true }), 'db.setSub');
  ok(call(db, 'rel.link', { db: d, id: p1, col: sub.kids, ids: [c1, c2] }), 'rel.link');
  ok(call(db, 'rel.link', { db: d, id: g1, col: sub.parent, ids: [c1] }), 'rel.link');
  // 木: 閉じていれば親の無い行だけ・開いた行の子は段を下げて親のすぐ後ろ
  const tree = (open) => view(db, d, open ? { open } : {}).rows.map((r) => [r.title, r.depth, r.hasKids]);
  assert.deepStrictEqual(tree(), [['親 一', 0, true], ['親 二', 0, false]]);
  assert.deepStrictEqual(tree([p1, c1]), [['親 一', 0, true], ['子 一', 1, true], ['孫 一', 2, false], ['子 二', 1, false], ['親 二', 0, false]]);
  assert.strictEqual(view(db, d, { open: [p1] }).shown, 4);
  // 子孫ごとゴミ箱へ
  const tr = callTx(db, 'rows.trash', { db: d, ids: [p1] });
  assert.strictEqual(code(tr.r), 'ok');
  assert.strictEqual(tr.r.result.trashed, 4, '答えの数に子孫が無い');
  const when = [p1, c1, c2, g1].map((id) => blockOf(db, id).trashed_at);
  assert.ok(when.every((x) => x && x === when[0]), '子孫が同じ時刻にゴミ箱へ入らない');
  assert.strictEqual(blockOf(db, p2).trashed_at, null);
  assert.deepStrictEqual(titles(db, d), ['親 二']);
  assert.strictEqual(opsOfTx(db, tr.tx).filter((o) => o.op === 'trash').length, 4);
  // Ctrl+Z で一緒に戻る
  assert.strictEqual(code(revert(db, d, [tr.tx]).r), 'ok');
  assert.deepStrictEqual(tree([p1, c1]), [['親 一', 0, true], ['子 一', 1, true], ['孫 一', 2, false], ['子 二', 1, false], ['親 二', 0, false]]);
  // 子だけ消すと、その子孫だけ一緒に（親は残る）
  const t2 = callTx(db, 'rows.trash', { db: d, ids: [c1, g1] });
  assert.strictEqual(t2.r.result.trashed, 2, '選んだ行と子孫を2度数えた');
  assert.deepStrictEqual(tree([p1]), [['親 一', 0, true], ['子 二', 1, false], ['親 二', 0, false]]);
  // サブアイテムでないデータベースは今のまま（選んだ行だけ）
  const e = mkDb(db);
  const x1 = rowAddA(db, e, { title: '甲' }); const x2 = rowAddA(db, e, { title: '乙' });   // D77 の会議の題名でない（データベースの行の題名）
  const rc = ok(call(db, 'col.add', { db: e, type: 'rel', target: e, both: true }), 'col.add');
  ok(call(db, 'rel.link', { db: e, id: x1, col: rc.col.id, ids: [x2] }), 'rel.link');
  assert.strictEqual(ok(call(db, 'rows.trash', { db: e, ids: [x1] }), 'rows.trash').trashed, 1);
  assert.deepStrictEqual(titles(db, e), ['乙']);
}));

test('DR-1: rel.find はつなぐ先のデータベースの生きている行を題名で探す（ひらがなとカタカナを寄せる・200 まで・ゴミ箱の行は出ない）。page.get の行の答えにリレーションの相手の題名（rel）', T, () => withDb((db) => {
  const { d1, d2, a1, b1, b2 } = twoDbs(db);
  const kana = rowAddA(db, d2, { title: 'カイギシツ' });   // D77 の会議の題名でない（データベースの行の題名）
  const found = (q) => ok(call(db, 'rel.find', { db: d2, ...(q === undefined ? {} : { q }) }), 'rel.find');
  assert.deepStrictEqual(found().rows.map((r) => r.id), [b1, b2, kana]);
  assert.deepStrictEqual(found('かいぎ').rows.map((r) => r.title), ['カイギシツ']);
  assert.deepStrictEqual(found('甲').rows.map((r) => r.id), [b1]);
  ok(call(db, 'rows.trash', { db: d2, ids: [b2] }), 'rows.trash');
  assert.deepStrictEqual(found('取引先').rows.map((r) => r.id), [b1]);
  assert.strictEqual(code(call(db, 'rel.find', { db: 'pa1' })), 'bad-args', 'データベースでない');
  const many = [];
  for (let i = 0; i < 230; i += 1) many.push({ op: 'add', id: `rf${i}`, row: ops.rowBlock({ id: `rf${i}`, db: d2, ord: `m${String(i).padStart(3, '0')}`, title: `多い ${i}`, cells: {}, by: { c: 'me', u: 'me' }, no: 50 + i, at: at() }) });   // D77 の会議の題名でない（データベースの行の題名）
  put(db, many);
  const f = found('多い');
  assert.deepStrictEqual([f.rows.length, f.total], [200, 230]);
  const col = ok(call(db, 'col.add', { db: d1, type: 'rel', target: d2 }), 'col.add').col;
  ok(call(db, 'rel.link', { db: d1, id: a1, col: col.id, ids: [b1, kana] }), 'rel.link');
  const g = ok(call(db, 'page.get', { id: a1 }), 'page.get');
  assert.deepStrictEqual(g.rel, { [b1]: { title: '取引先 甲' }, [kana]: { title: 'カイギシツ' } });   // D77 の会議の題名でない（データベースの行の題名）
  assert.ok(!Object.hasOwn(g.page, 'rel'), 'ページの欄に入れた');
}));

test('DR-1: preload の呼び口（relLink・relUnlink・dbSetSub・relFind・colAdd の rel・dbView の open。どれも dbCall の1回）。rel.link・rel.unlink・db.setSub は元に戻すの歩み（データベースの ID）・rel.find は読む命令', T, async () => {
  const PRE = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  for (const cmd of ['rel.link', 'rel.unlink', 'db.setSub']) { assert.ok(UNDO_CMDS.has(cmd), cmd); assert.deepStrictEqual(core.COMMANDS[cmd].roles, ['app'], cmd); }
  assert.ok(!UNDO_CMDS.has('rel.find') && core.COMMANDS['rel.find'].write === false);
  const reads = [.../const DB_READS = new Set\(\[([^\]]*)\]\)/.exec(PRE)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.ok(reads.includes('rel.find'));
  const exposed = {}; const on = {}; let uuid = 0;
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { on: (ch, fn) => { on[ch] = fn; }, invoke: async () => ({}), send: () => {} } };
  vm.runInNewContext(PRE, { require: () => electron, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` }, setTimeout, clearTimeout, console, Promise });
  const port = new EventTarget(); port.sent = []; port.postMessage = (m) => port.sent.push(structuredClone(m)); port.start = () => {};
  on['db:port']({ ports: [port] });
  const k = exposed.koeApp;
  k.relLink('pd1', 'r1', 'c1', ['r2']); k.relLink('pd1', 'r1', 'c1', [], ''); k.relUnlink('pd1', 'r1', 'c1', ['r2']); k.dbSetSub('pd1', true); k.relFind('pd2', 'か');
  k.colAdd('pd1', 'rel', undefined, undefined, { target: 'pd2', both: true }); k.colAdd('pd1', 'rel', undefined, undefined, { target: 'pd1' });
  k.dbView('pd1', 'v1', 0, 200, '', ['r1']); k.dbView('pd1', 'v1', 0, 200, '', []);
  assert.deepStrictEqual(port.sent.map((m) => [m.cmd, m.args]), [
    ['rel.link', { db: 'pd1', id: 'r1', col: 'c1', ids: ['r2'] }], ['rel.link', { db: 'pd1', id: 'r1', col: 'c1', ids: [], title: '' }],
    ['rel.unlink', { db: 'pd1', id: 'r1', col: 'c1', ids: ['r2'] }], ['db.setSub', { db: 'pd1', on: true }], ['rel.find', { db: 'pd2', q: 'か' }],
    ['col.add', { db: 'pd1', type: 'rel', target: 'pd2', both: true }], ['col.add', { db: 'pd1', type: 'rel', target: 'pd1' }],
    ['db.view', { id: 'pd1', viewId: 'v1', from: 0, count: 200, open: ['r1'] }], ['db.view', { id: 'pd1', viewId: 'v1', from: 0, count: 200 }],
  ]);
  for (const m of port.sent) if (['rel.find', 'db.view'].includes(m.cmd)) assert.strictEqual(m.tx, undefined, m.cmd); else assert.match(m.tx, /^a:/, m.cmd);
});

// ---------------------------------------------------------------- 0.16.0 DX-2（決めたこと 44・46・R98 (1)・R102）
const ld = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// 案件（テキスト・ステータスの列）と行 4 つ（r3 は本文に1行）、ゴミ箱のデータベース（行 1 つ）
function dx2Seed(db) {
  const d = ok(call(db, 'db.create', {}), 'db.create').id;
  ok(call(db, 'page.setTitle', { id: d, title: '案件' }), 'setTitle');   // データベースと行の題名（D77 の会議の題名でない）
  const memo = ok(call(db, 'col.add', { db: d, type: 'text', name: 'メモ' }), 'col.add').col.id;
  const st = ok(call(db, 'col.add', { db: d, type: 'status', name: '状態' }), 'col.add').col;
  const doing = st.opts.find((o) => o.name === '進行中').id;
  // データベースの行の題名（D77 の会議の題名でない）
  const r1 = ok(call(db, 'row.add', { db: d, title: '見積もりの作成', cells: { [memo]: '倉庫の鍵を確かめる' } }), 'row.add').id;   // データベースと行の題名（D77 の会議の題名でない）
  const r2 = ok(call(db, 'row.add', { db: d, title: '発注', cells: { [st.id]: doing } }), 'row.add').id;   // データベースと行の題名（D77 の会議の題名でない）
  const r3 = ok(call(db, 'row.add', { db: d, title: '検収' }), 'row.add').id;   // データベースと行の題名（D77 の会議の題名でない）
  const r4 = ok(call(db, 'row.add', { db: d, title: '見積もりの返事' }), 'row.add').id;   // データベースと行の題名（D77 の会議の題名でない）
  const b = ok(call(db, 'block.insert', { pageId: r3, afterBlockId: '', type: 'paragraph' }), 'block.insert').blockId;
  ok(call(db, 'block.update', { pageId: r3, blockId: b, patch: { text: '納品書の控えを箱にしまう' } }), 'block.update');
  at(); ok(call(db, 'rows.trash', { db: d, ids: [r4] }), 'rows.trash');   // 消した時刻はまとまりの印なので、命令ごとに時計を進める
  const g = ok(call(db, 'db.create', {}), 'db.create').id;
  ok(call(db, 'page.setTitle', { id: g, title: '古い案件' }), 'setTitle');   // データベースと行の題名（D77 の会議の題名でない）
  const r5 = ok(call(db, 'row.add', { db: g, title: '見積もりの古い行' }), 'row.add').id;   // データベースと行の題名（D77 の会議の題名でない）
  ok(call(db, 'page.delete', { id: g }), 'page.delete');
  return { d, g, r1, r2, r3, r4, r5, memo, st };
}

test('DX-2・決めたこと 46: pages.list の q に行の題名・テキストのセル・選択肢の名前・行の本文の当たりが kind: row の行で出る（db・dbTitle・date。ページの当たりの後ろ・データベースの並びと行の並びの順）。ゴミ箱の行・ゴミ箱のデータベースの行・空の q の一覧には出ない', T, () => withDb((db) => {
  const s = dx2Seed(db);
  const list = (q) => ok(call(db, 'pages.list', { q }), 'pages.list');
  const rowsIn = (q) => list(q).filter((e) => e.kind === 'row');
  const r1 = db.prepare('select created_at from blocks where id = ?').get(s.r1).created_at;
  assert.deepStrictEqual(rowsIn('見積もり'), [{ id: s.r1, title: '見積もりの作成', kind: 'row', db: s.d, dbTitle: '案件', date: ld(r1) }], '題名の当たりの行が違うか、ゴミ箱の行・ゴミ箱のデータベースの行が出る');   // データベースと行の題名（D77 の会議の題名でない）
  assert.deepStrictEqual(rowsIn('倉庫の鍵').map((e) => [e.id, e.snippet]), [[s.r1, '倉庫の鍵を確かめる']], 'テキストのセルの当たりの抜き出しが違う');
  assert.deepStrictEqual(rowsIn('進行中').map((e) => [e.id, e.snippet]), [[s.r2, '進行中']], '選択肢の名前で当たらない');
  assert.deepStrictEqual(rowsIn('納品書の控え').map((e) => [e.id, e.snippet]), [[s.r3, '納品書の控えを箱にしまう']], '行の本文で当たらない');
  assert.deepStrictEqual(rowsIn('箱').map((e) => e.id), [s.r3], '1字の語（LIKE の道）で行の本文に当たらない');
  // データベースのページそのものは題名で当たる（今のページと同じ・行より前）
  assert.deepStrictEqual(list('案件').map((e) => [e.id, e.kind]), [[s.d, 'database']]);
  // 空の問い（サイドバーの一覧）には行が出ない
  assert.ok(!list('').some((e) => e.kind === 'row'), '一覧に行が出る');
  // 並び: ページの当たりの後ろに、データベースの並び（一覧の順）・行の並びの鍵の順
  ok(call(db, 'block.insert', { pageId: s.r2, afterBlockId: '', type: 'paragraph' }), 'block.insert');
  const b2 = ok(call(db, 'page.get', { id: s.r2 }), 'page.get').page.blocks[0].id;
  ok(call(db, 'block.update', { pageId: s.r2, blockId: b2, patch: { text: '見積もりを待つ' } }), 'block.update');
  assert.deepStrictEqual(rowsIn('見積もり').map((e) => e.id), [s.r1, s.r2], '行の並びの鍵の順でない');
  // 行をゴミ箱へ入れると出ない・データベースを戻すと、その行が出る
  ok(call(db, 'rows.trash', { db: s.d, ids: [s.r1] }), 'rows.trash');
  assert.deepStrictEqual(rowsIn('見積もり').map((e) => e.id), [s.r2]);
  ok(call(db, 'page.restore', { id: s.g }), 'page.restore');
  assert.deepStrictEqual(rowsIn('見積もり').map((e) => e.id), [s.r2, s.r5].sort((a, b) => list('').findIndex((x) => x.id === (a === s.r2 ? s.d : s.g)) - list('').findIndex((x) => x.id === (b === s.r2 ? s.d : s.g))), 'データベースを戻しても行が出ない');
}));

test('DX-2・決めたこと 44・R98 (1): pages.trash に行のまとまり（同じデータベース・同じ時刻。頭は並びの鍵の一番前）が kind: row で出る（db・dbTitle・count はほかの行の数）。page.restore に行の ID で、そのまとまりだけを元の並びの鍵のまま戻す（oplog の1行）。ゴミ箱のデータベースの行は出ず、戻せない', T, () => withDb((db) => {
  const s = dx2Seed(db);
  at(); ok(call(db, 'rows.trash', { db: s.d, ids: [s.r2, s.r1] }), 'rows.trash');
  at(); ok(call(db, 'rows.trash', { db: s.d, ids: [s.r3] }), 'rows.trash');
  const heads = () => ok(call(db, 'pages.trash', {}), 'pages.trash');
  const rowHeads = () => heads().filter((h) => h.kind === 'row').map((h) => [h.id, h.title, h.db, h.dbTitle, h.count]);
  assert.deepStrictEqual(rowHeads(), [[s.r3, '検収', s.d, '案件', 0], [s.r1, '見積もりの作成', s.d, '案件', 1], [s.r4, '見積もりの返事', s.d, '案件', 0]], '行のまとまりが違う（ゴミ箱のデータベースの行が出るか）');
  assert.ok(heads().some((h) => h.id === s.g && h.kind !== 'row'), 'ゴミ箱のデータベースが出ない');
  const all = heads().map((h) => h.trashedAt);
  assert.deepStrictEqual(all, [...all].sort().reverse(), '消した新しい順でない');
  const ord = (id) => ({ ...db.prepare('select ord, trashed_at from blocks where id = ?').get(id) });
  const before = [ord(s.r1).ord, ord(s.r2).ord];
  const n0 = db.prepare('select count(*) as c from oplog').get().c;
  ok(call(db, 'page.restore', { id: s.r1 }), 'page.restore');
  assert.strictEqual(db.prepare('select count(*) as c from oplog').get().c - n0, 1, 'oplog の1行でない');
  assert.deepStrictEqual([ord(s.r1), ord(s.r2)], [{ ord: before[0], trashed_at: null }, { ord: before[1], trashed_at: null }], 'まとまりが元の鍵のまま戻らない');
  assert.ok(ord(s.r3).trashed_at && ord(s.r4).trashed_at, 'ほかのまとまりも戻した');
  assert.deepStrictEqual(rowHeads().map((h) => h[0]), [s.r3, s.r4]);
  const view = ok(call(db, 'db.view', { id: s.d, viewId: 'v1', from: 0, count: 50 }), 'db.view');
  assert.deepStrictEqual(view.rows.map((r) => r.id), [s.r1, s.r2], '表に戻らない');
  // ゴミ箱のデータベースの行: 窓に出ず、戻せない
  const t2 = ok(call(db, 'row.add', { db: s.d, title: '片付け' }), 'row.add').id;   // データベースの行の題名（D77 の会議の題名でない）
  at(); ok(call(db, 'rows.trash', { db: s.d, ids: [t2] }), 'rows.trash');
  at(); ok(call(db, 'page.delete', { id: s.d }), 'page.delete');
  assert.deepStrictEqual(rowHeads(), [], 'ゴミ箱のデータベースの行が出る');
  assert.strictEqual(call(db, 'page.restore', { id: t2 }).code, 'bad-args', 'ゴミ箱のデータベースの行を戻せた');
  // データベースを戻すと、ゴミ箱に入れていなかった行が見える（消した行はゴミ箱のまま）
  ok(call(db, 'page.restore', { id: s.d }), 'page.restore');
  assert.deepStrictEqual(ok(call(db, 'db.view', { id: s.d, viewId: 'v1', from: 0, count: 50 }), 'db.view').rows.map((r) => r.id), [s.r1, s.r2]);
  assert.deepStrictEqual(rowHeads().map((h) => h[0]), [t2, s.r3, s.r4]);
  // 無い行・生きている行は bad-args か何もしない
  assert.strictEqual(call(db, 'page.restore', { id: 'rnothere1' }).code, 'bad-args');
  const n1 = db.prepare('select count(*) as c from oplog').get().c;
  ok(call(db, 'page.restore', { id: s.r1 }), 'page.restore');
  assert.strictEqual(ord(s.r1).trashed_at, null);
  assert.ok(db.prepare('select count(*) as c from oplog').get().c - n1 <= 1);
}));

test('DX-2・決めたこと 7: 行を戻すと 10,000 行を越えるまとまりは戻さない（too-big）', T, () => withDb((db) => {
  const d = ok(call(db, 'db.create', {}), 'db.create').id;
  // データベースの行の題名（D77 の会議の題名でない）
  const a = ok(call(db, 'row.add', { db: d, title: '戻す行' }), 'row.add').id;   // データベースと行の題名（D77 の会議の題名でない）
  ok(call(db, 'rows.trash', { db: d, ids: [a] }), 'rows.trash');
  const list = [];
  for (let i = 0; i < 10000; i += 1) list.push({ op: 'add', id: `rz${i}`, row: ops.rowBlock({ id: `rz${i}`, db: d, ord: `z${String(i).padStart(5, '0')}`, title: `行 ${i}`, cells: {}, by: { c: 'me', u: 'me' }, no: 10 + i, at: at() }) });   // データベースの行の題名（D77 の会議の題名でない）
  put(db, list);
  assert.strictEqual(call(db, 'page.restore', { id: a }).code, 'too-big', '1万1行目を戻した');
  assert.ok(db.prepare('select trashed_at from blocks where id = ?').get(a).trashed_at, '戻した');
}));
