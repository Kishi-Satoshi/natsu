/* stage170.minutes.db.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の第3部の DB（一時の DB に本物の命令を通す）
 *  MG-1（決めたこと 46・50〜52・F196）: データベースの行を読む1か所（「議事録」データベースでは子の議事録のページも行）と、議事録から自動で入る列（日付・作成者・要約）
 * 会議の題名は titleAt（D77）。データベースの題名・列の名前・人の名前は作った物（実在の人名を使わない）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { tmpDb } = require('./helpers/dbtmp');
const { titleAt } = require('./helpers/titles');
const core = require('../src/db/core');
const DM = require('../src/dbModel');
const DV = require('../src/dbView');

let clock = Date.parse('2026-11-14T03:00:00.000Z');
const now = () => new Date(clock);
const tick = () => { clock += 60000; return new Date(clock).toISOString(); };
let n = 0;
const txOf = (role) => `${role[0]}:m170-${String(++n).padStart(6, '0')}`;
const call = (db, cmd, args, role = 'app', tx = txOf(role)) => { tick(); return { ...core.call(db, { role, cmd, args, tx }, { now, labels: {} }), tx }; };
const ok = (r, what) => { assert.strictEqual(r.ok, true, `${what}: ${r.code}`); return r; };
const T = { timeout: 30000 };
const attrsOf = (db, id) => JSON.parse(db.prepare('select attrs from blocks where id = ?').get(id).attrs);
function withDb(fn) {
  const t = tmpDb();
  try { const { db } = t.open(); return fn(db, t); } finally { t.done(); }
}
// 「議事録」データベースの列（決めたこと 50: 名前・日付・作成者・参加者・要約。試しの形: 作るのは MG-2 の移し替え）
const MIN_COLS = [
  { id: 'title', name: '名前', type: 'title' }, { id: 'c1', name: '日付', type: 'mdate' }, { id: 'c2', name: '作成者', type: 'cby' },
  { id: 'c3', name: '参加者', type: 'person' }, { id: 'c4', name: '要約', type: 'msum' },
];
// 試しの「議事録」データベース: db.create で作り、役の印と列とビューを SQL で書く（MG-1 は読む所だけを見る。作る命令は MG-2）
function minutesDb(db) {
  const d = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const views = [DV.defaultView('v1', 'table', MIN_COLS, 'すべて')];
  db.prepare("update blocks set text = '議事録', attrs = json_set(attrs, '$.role', 'minutes', '$.cols', json(?), '$.views', json(?)) where id = ?")
    .run(JSON.stringify(MIN_COLS), JSON.stringify(views), d);
  return d;
}
const LONG = '次の打ち合わせまでに見積もりの案を三つ用意し、予算の上限と納期の目安を添えて先方に送ることを確かめた。あわせて、前回の宿題だった資料の直しは今週中に終える。担当の割り振りは来週の初めに決め直し、遅れの出そうな所は早めに知らせ合うことにした。次の確かめは月末に行う。';
// 締めた議事録（meeting.finalize。要約の見出しと箇条書き）
function meeting(db, id, { at = '2026-11-10T01:30:00.000Z', date = '2026-11-10', bullet = LONG } = {}) {
  const page = { title: titleAt(at), date, createdAt: at, blocks: [{ id: `${id}h`, type: 'heading', text: '要点' }, ...(bullet ? [{ id: `${id}b`, type: 'bullet', text: bullet }] : [])] };
  ok(call(db, 'meeting.finalize', { pageId: id, page, segments: [] }, 'main'), 'meeting.finalize');
  return id;
}
const under = (db, id, parent, ord = 'i') => db.prepare('update blocks set parent_id = ?, ord = ? where id = ?').run(parent, ord, id);
const viewOf = (db, d, extra = {}) => ok(call(db, 'db.view', { id: d, viewId: 'v1', from: 0, count: 200, ...extra }), 'db.view').result;
const colOf = (id) => MIN_COLS.find((c) => c.id === id);

test('MG-1・F196: dbRowsOf（「議事録」データベースでは子の議事録のページ（録音中の写し・ゴミ箱・白紙のページとデータベースを除く）と行が並ぶ。ふつうのデータベースは今と1つも違わない。テンプレートの行はどちらにも出ない）', T, () => withDb((db) => {
  const M = minutesDb(db);
  const a = meeting(db, 'pm1'); under(db, a, M);
  const b = meeting(db, 'pm2', { at: '2026-11-11T02:00:00.000Z', date: '2026-11-11' }); under(db, b, M);
  const gone = meeting(db, 'pm3'); under(db, gone, M); ok(call(db, 'page.delete', { id: gone }), 'page.delete');
  call(db, 'meeting.begin', { pageId: 'pm4', startedAt: Date.parse('2026-11-12T00:00:00.000Z'), localOnly: false }, 'main'); under(db, 'pm4', M);
  const blank = ok(call(db, 'page.create', {}), 'page.create').result.id; under(db, blank, M);
  const other = ok(call(db, 'db.create', {}), 'db.create').result.id; under(db, other, M);
  const row = ok(call(db, 'row.add', { db: M, title: '行の題' }), 'row.add').result.id;   // データベースの行の題名（D77 の外）
  const tpl = ok(call(db, 'row.add', { db: M, title: 'ひな形' }), 'row.add').result.id;   // テンプレートの行の題名（D77 の外）
  db.prepare("update blocks set attrs = json_set(attrs, '$.tpl', json('true')) where id = ?").run(tpl);
  const got = viewOf(db, M);
  assert.deepStrictEqual(got.rows.map((r) => r.id).sort(), [a, b, row].sort(), '「議事録」の表の行');
  assert.strictEqual(got.total, 3);
  // ふつうのデータベース: 行だけ（子のページ・テンプレートの行・ゴミ箱の行は出ない）
  const N = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const r1 = ok(call(db, 'row.add', { db: N, title: '一' }), 'row.add').result.id;   // データベースの行の題名（D77 の外）
  const r2 = ok(call(db, 'row.add', { db: N, title: '二' }), 'row.add').result.id;   // データベースの行の題名（D77 の外）
  ok(call(db, 'rows.trash', { db: N, ids: [r2] }), 'rows.trash');
  const t2 = ok(call(db, 'row.add', { db: N, title: 'ひな形' }), 'row.add').result.id;   // テンプレートの行の題名（D77 の外）
  db.prepare("update blocks set attrs = json_set(attrs, '$.tpl', json('true')) where id = ?").run(t2);
  const m9 = meeting(db, 'pm9'); under(db, m9, N);
  assert.deepStrictEqual(viewOf(db, N).rows.map((r) => r.id), [r1], 'ふつうのデータベースの表');
  // Claude が読む形（dbDump）とリレーションの選び（rel.find）も同じ1か所
  const dump = require('../src/db/commands').dbDump(db, M, 100, clock);
  assert.strictEqual(dump.total, 3);
  assert.deepStrictEqual(ok(call(db, 'rel.find', { db: N }), 'rel.find').result.rows.map((r) => r.id), [r1]);
}));

test('MG-1・F196: 読む列（日付は会議の日付と始めた時刻・作成者は「自分」・要約は最初の要点（120 字まで。全部でない・作り直すと替わる・無ければ空）。row.setCell で書くと bad-args・col.remove で消せない・隠せる・並べ替えと絞り込みが効く）', T, () => withDb((db) => {
  const M = minutesDb(db);
  const a = meeting(db, 'pm1'); under(db, a, M);
  const b = meeting(db, 'pm2', { at: '2026-11-11T02:00:00.000Z', date: '2026-11-11', bullet: '' }); under(db, b, M);
  const rowsById = () => new Map(viewOf(db, M).rows.map((r) => [r.id, r]));
  let rows = rowsById();
  const hm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  assert.deepStrictEqual(DM.cellValue(rows.get(a), colOf('c1')), { start: '2026-11-10', time: hm('2026-11-10T01:30:00.000Z') }, '日付');
  assert.strictEqual(DM.fmtCell(colOf('c2'), DM.cellValue(rows.get(a), colOf('c2'))), '自分', '作成者');
  assert.strictEqual(DM.cellValue(rows.get(a), colOf('c4')), LONG.slice(0, 120), '要約は最初の要点の 120 字まで');
  assert.ok(LONG.length > 120);
  assert.strictEqual(DM.cellValue(rows.get(b), colOf('c4')), null, '要約が無ければ空');
  assert.strictEqual(DM.fmtCell(colOf('c1'), DM.cellValue(rows.get(a), colOf('c1'))), `2026/11/10 ${hm('2026-11-10T01:30:00.000Z')}`);
  // 要約を作り直すと替わる（page.put: 要約の書き戻し）
  const p = ok(call(db, 'page.get', { id: a }, 'main'), 'page.get').result.page;
  ok(call(db, 'page.put', { page: { ...p, blocks: [{ id: 'pm1h2', type: 'heading', text: '要点' }, { id: 'pm1b2', type: 'bullet', text: '作り直した最初の要点' }] }, baseRev: p.rev }, 'main'), 'page.put');
  rows = rowsById();
  assert.strictEqual(DM.cellValue(rows.get(a), colOf('c4')), '作り直した最初の要点', '作り直しで替わらない');
  // 書けない（日付・作成者・要約）
  for (const [c, value] of [['c1', { start: '2026-11-12' }], ['c2', 'me'], ['c4', '書いた要約']]) assert.strictEqual(call(db, 'row.setCell', { db: M, id: a, col: c, value }).code, 'bad-args', `${c} を書けた`);
  // 消せない・隠せる
  for (const c of ['c1', 'c2', 'c4']) assert.strictEqual(call(db, 'col.remove', { db: M, col: c }).code, 'bad-args', `${c} を消せた`);
  ok(call(db, 'view.update', { db: M, viewId: 'v1', patch: { props: MIN_COLS.map((c) => ({ col: c.id, show: c.id !== 'c4' })) } }), 'view.update（隠す）');
  // 並べ替え（日付の新しい順）と絞り込み（日付が 2026-11-10）
  ok(call(db, 'view.update', { db: M, viewId: 'v1', patch: { sort: [{ col: 'c1', dir: 'desc' }] } }), 'view.update（並べ替え）');
  assert.deepStrictEqual(viewOf(db, M).rows.map((r) => r.id), [b, a], '日付の新しい順');
  ok(call(db, 'view.update', { db: M, viewId: 'v1', patch: { sort: [{ col: 'c1', dir: 'asc' }] } }), 'view.update（並べ替え）');
  assert.deepStrictEqual(viewOf(db, M).rows.map((r) => r.id), [a, b], '日付の古い順');
  ok(call(db, 'view.update', { db: M, viewId: 'v1', patch: { filter: { op: 'and', items: [{ col: 'c1', cmp: 'on', value: '2026-11-10' }] } } }), 'view.update（絞り込み）');
  assert.deepStrictEqual(viewOf(db, M).rows.map((r) => r.id), [a], '日付の絞り込み');
  ok(call(db, 'view.update', { db: M, viewId: 'v1', patch: { filter: { op: 'and', items: [{ col: 'c4', cmp: 'contains', value: '作り直した' }] } } }), 'view.update（絞り込み）');
  assert.deepStrictEqual(viewOf(db, M).rows.map((r) => r.id), [a], '要約の絞り込み');
  // 書けない列は足せない（「議事録」データベースにだけある）
  assert.strictEqual(call(db, 'col.add', { db: M, type: 'mdate' }).code, 'bad-args');
  assert.strictEqual(call(db, 'col.add', { db: M, type: 'msum' }).code, 'bad-args');
}));

test('MG-1・F196: 議事録の行の書ける列（参加者）は議事録のページの attrs.cells に入り、page.put（要約の書き戻し）と締め直しで消えない（親と並びの鍵も）', T, () => withDb((db) => {
  const M = minutesDb(db);
  const a = meeting(db, 'pm1'); under(db, a, M, 'k5');
  const set = ok(call(db, 'row.setCell', { db: M, id: a, col: 'c3', value: ['メンバー甲', 'メンバー乙'] }), 'row.setCell');
  assert.deepStrictEqual(attrsOf(db, a).cells, { c3: ['メンバー甲', 'メンバー乙'] });
  assert.deepStrictEqual(DM.cellValue(viewOf(db, M).rows.find((r) => r.id === a), colOf('c3')), ['メンバー甲', 'メンバー乙']);
  // 要約の書き戻し（送ったページに cells が無い）
  const p = ok(call(db, 'page.get', { id: a }, 'main'), 'page.get').result.page;
  const sent = { ...p };
  delete sent.cells;
  ok(call(db, 'page.put', { page: { ...sent, blocks: [{ id: 'pm1x', type: 'bullet', text: '書き戻し' }] }, baseRev: p.rev }, 'main'), 'page.put');
  assert.deepStrictEqual(attrsOf(db, a).cells, { c3: ['メンバー甲', 'メンバー乙'] }, '要約の書き戻しで参加者が消えた');
  // 締め直し（同じページの meeting.finalize）
  meeting(db, a, { bullet: '締め直した' });
  assert.deepStrictEqual(attrsOf(db, a).cells, { c3: ['メンバー甲', 'メンバー乙'] }, '締め直しで参加者が消えた');
  assert.deepStrictEqual({ ...db.prepare('select parent_id, ord from blocks where id = ?').get(a) }, { parent_id: M, ord: 'k5' }, '親と並びの鍵が変わった');
  // 参加者を書いた歩みは、データベースの歩み（Ctrl+Z）で戻る
  ok(call(db, 'edit.revert', { pageId: M, steps: [set.tx] }), 'edit.revert');
  assert.ok(!Object.hasOwn(attrsOf(db, a).cells || {}, 'c3'), 'Ctrl+Z で参加者が戻らない');
}));

test('MG-1: タスク管理からのリレーションの選び（rel.find）に議事録が出て、つなぐと片側（タスクの側の列だけ。「議事録」に列はできない: TQ2b）', T, () => withDb((db) => {
  const M = minutesDb(db);
  const a = meeting(db, 'pm1'); under(db, a, M);
  const gone = meeting(db, 'pm2'); under(db, gone, M); ok(call(db, 'page.delete', { id: gone }), 'page.delete');
  const K = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const rel = ok(call(db, 'col.add', { db: K, type: 'rel', name: '議事録', target: M }), 'col.add').result.col.id;
  const found = ok(call(db, 'rel.find', { db: M }), 'rel.find').result;
  assert.deepStrictEqual(found.rows.map((r) => [r.id, r.title]), [[a, titleAt('2026-11-10T01:30:00.000Z')]], 'リレーションの選びに議事録が無い');
  const task = ok(call(db, 'row.add', { db: K, title: '見積もりを送る' }), 'row.add').result.id;   // タスクの題名（D77 の外）
  ok(call(db, 'rel.link', { db: K, id: task, col: rel, ids: [a] }), 'rel.link');
  const v = ok(call(db, 'db.view', { id: K, viewId: 'v1', from: 0, count: 50 }), 'db.view').result;
  assert.deepStrictEqual(v.rows[0].cells[rel], [a]);
  assert.deepStrictEqual(v.rel[a], { title: titleAt('2026-11-10T01:30:00.000Z') }, 'リレーションのセルの相手の題名');
  assert.deepStrictEqual(attrsOf(db, M).cols.map((c) => c.id), MIN_COLS.map((c) => c.id), '「議事録」に列ができた');
  assert.ok(!Object.hasOwn(attrsOf(db, a), 'cells'), '議事録のページにセルが書かれた（片側でない）');
  assert.strictEqual(call(db, 'rel.link', { db: K, id: task, col: rel, ids: [gone] }).code, 'bad-args', 'ゴミ箱の議事録とつないだ');
}));

test('MG-1（決めたこと 58）: 0.16.0 の dbView・dbModel（0a6a375 を写した見本）で「議事録」の新しい列の種類を読んでも落ちず、列の設定は残る（知らない列はビューから外すだけ）', () => {
  const V160 = require(path.join(__dirname, 'fixtures', 'v160', 'dbView.js'));
  const M160 = require(path.join(__dirname, 'fixtures', 'v160', 'dbModel.js'));
  const view = { ...DV.defaultView('v1', 'table', MIN_COLS, 'すべて'), sort: [{ col: 'c1', dir: 'desc' }] };
  const norm = V160.normalizeView(view, MIN_COLS);
  assert.deepStrictEqual(norm.view.props.map((p) => p.col), ['title', 'c2', 'c3'], '0.16.0 のビューの列');
  assert.deepStrictEqual(norm.view.sort, [], '知らない列の並べ替えは外すだけ');
  const rows = [{ id: 'pm1', ord: 'i', title: titleAt('2026-11-10T01:30:00.000Z'), cells: { c3: ['メンバー甲'] }, createdAt: '2026-11-10T01:30:00.000Z', updatedAt: '2026-11-10T01:30:00.000Z', by: { c: 'me' }, mdate: { start: '2026-11-10' }, msum: '要点' }];
  const out = V160.applyView(rows, norm.view, MIN_COLS, { now: clock });
  assert.deepStrictEqual(out.order.map((o) => o.id), ['pm1']);
  assert.strictEqual(M160.fmtCell(MIN_COLS[1], { start: '2026-11-10' }), '', '0.16.0 は知らない種類を空で見せる');
  assert.throws(() => M160.cellOf(MIN_COLS[4], 'x'), (e) => e.code === 'bad-args', '0.16.0 は知らない種類のセルを bad-args で断る（落ちない）');
  // 列そのもの（attrs.cols）は 0.16.0 の照らしで消えない（知らない種類の列は照らしに通らないだけで、並びの中に残る）
  assert.deepStrictEqual(MIN_COLS.filter((c) => !M160.colOk(c)).map((c) => c.id), ['c1', 'c4']);
});

// ---------------------------------------------------------------- MG-2（決めたこと 45〜49・58・59・F193〜F195・F203）: 移し替えと見回りと録音の置き場
const fs = require('node:fs');
const sqlite = require('node:sqlite');
const { MessageChannel } = require('node:worker_threads');
const { samplePage, tmpData, electronShape } = require('./helpers/dbtmp');
const { startServer } = require('../src/db/server');
const { applyOps } = require('../src/db/ops');
const PT160 = require(path.join(__dirname, 'fixtures', 'v160', 'pageTree.js'));
// 0.16.0 までに締めた議事録（移す前の形: 最上位・親なし）。種は putPageRows（oplog を書かない: 0.16.0 の DB にもともとある行）
function oldMeeting(t, id, i) {
  const at = new Date(Date.parse('2026-10-01T01:00:00.000Z') + i * 3600000 * 7).toISOString();
  const { page, segments } = samplePage(id);
  page.title = titleAt(at); page.createdAt = at; page.updatedAt = at; page.date = at.slice(0, 10);
  for (const b of page.blocks) b.id = `${id}${b.id}`;
  t.seed(page, segments.map((s) => ({ ...s, id: `${id}${s.id}` })));
  return id;
}
const gather = (db, args = { first: true }) => call(db, 'minutes.gather', args, 'main');
const listOf = (db) => ok(call(db, 'pages.list', {}), 'pages.list').result;
const minutesDbs = (db) => db.prepare("select id, attrs from blocks where type = 'page' and trashed_at is null and instr(attrs, 'minutes') > 0").all()
  .filter((r) => { try { return JSON.parse(r.attrs).role === 'minutes'; } catch (_) { return false; } }).map((r) => r.id);
const metaOf = (db, key) => { const r = db.prepare('select value from meta where key = ?').get(key); return r ? r.value : undefined; };
const pageCols = (db, id) => { const r = db.prepare('select * from blocks where id = ?').get(id); const { rid, parent_id: _p, ord: _o, rev: _r, ...rest } = r; return rest; };   // eslint-disable-line no-unused-vars
const bodyOf = (db, id) => ({
  blocks: db.prepare('select * from blocks where page_id = ? and id <> ? order by id').all(id, id).map((r) => ({ ...r, rid: undefined })),
  segs: db.prepare('select * from segments where page_id = ? order by n').all(id).map((r) => ({ ...r })),
});

test('MG-2・F193: 移し替え（最上位の締めた議事録 300 だけが「議事録」データベースの子になり、並びの鍵は日時の順・ほかの欄は1字も同じ・oplog の1行（actor system）・meta に数。ページの中の議事録・ゴミ箱・録音中の写し・白紙のページ・データベースはそのまま）', { timeout: 120000 }, () => withDb((db, t) => {
  const ids = []; for (let i = 0; i < 300; i += 1) ids.push(oldMeeting(t, `pq${String(i).padStart(3, '0')}`, (i * 37) % 300));
  const blank = ok(call(db, 'page.create', {}), 'page.create').result.id;
  const nested = oldMeeting(t, 'pn1', 400); under(db, nested, blank, 'a5');
  const gone = oldMeeting(t, 'pg1', 401); ok(call(db, 'page.delete', { id: gone }), 'page.delete');
  call(db, 'meeting.begin', { pageId: 'pl1', startedAt: Date.parse('2026-11-14T00:00:00.000Z'), localOnly: false }, 'main');
  const otherDb = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const before = new Map([...ids, nested, gone, blank, otherDb, 'pl1'].map((id) => [id, { cols: pageCols(db, id), body: bodyOf(db, id), place: { ...db.prepare('select parent_id, ord from blocks where id = ?').get(id) } }]));
  const seq0 = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
  const r = ok(gather(db), 'minutes.gather');
  assert.deepStrictEqual({ ...r.result, db: undefined }, { moved: 300, skipped: 0, created: true, db: undefined });
  const dbs = minutesDbs(db);
  assert.strictEqual(dbs.length, 1, '「議事録」データベースが1つでない');
  const M = dbs[0];
  assert.strictEqual(r.result.db, M);
  const m = attrsOf(db, M);
  assert.deepStrictEqual([db.prepare('select text, parent_id from blocks where id = ?').get(M).text, db.prepare('select parent_id from blocks where id = ?').get(M).parent_id, m.kind, m.role, m.locked],
    ['議事録', null, 'database', 'minutes', true], '「議事録」データベースの形');
  assert.deepStrictEqual(m.cols.map((c) => [c.name, c.type]), [['名前', 'title'], ['日付', 'mdate'], ['作成者', 'cby'], ['参加者', 'person'], ['要約', 'msum']], '列（決めたこと 50）');
  assert.deepStrictEqual(m.views.map((v) => [v.name, v.layout, v.sort]), [['すべて', 'table', [{ col: m.cols[1].id, dir: 'desc' }]]], 'ビュー（決めたこと 51）');
  // 移したのは最上位の議事録だけ。並びの鍵は日時の順。ほかの欄（本文・発言・要約・メモ・出典・会議の状態・作った日時と直した日時）は1字も同じ
  const kids = db.prepare("select id, ord from blocks where parent_id = ? and type = 'page'").all(M);
  assert.deepStrictEqual(kids.map((k) => k.id).sort(), [...ids].sort());
  const byTime = [...ids].sort((a, b) => { const x = attrsOf(db, a); const y = attrsOf(db, b); return `${x.date} ${db.prepare('select created_at from blocks where id = ?').get(a).created_at}` < `${y.date} ${db.prepare('select created_at from blocks where id = ?').get(b).created_at}` ? -1 : 1; });
  assert.deepStrictEqual([...kids].sort((a, b) => (a.ord < b.ord ? -1 : 1)).map((k) => k.id), byTime, '並びの鍵が日時の順でない');
  for (const [id, w] of before) {
    assert.deepStrictEqual(pageCols(db, id), w.cols, `${id} の欄が変わった`);
    assert.deepStrictEqual(bodyOf(db, id), w.body, `${id} の本文・発言が変わった`);
    if (!ids.includes(id)) assert.deepStrictEqual({ ...db.prepare('select parent_id, ord from blocks where id = ?').get(id) }, w.place, `${id} を動かした`);
  }
  // oplog の1行（actor system・action minutes.gather）が、前の値つきの move を全部持つ
  const logs = db.prepare('select actor, action, ops from oplog where seq > ?').all(seq0);
  assert.deepStrictEqual(logs.map((x) => [x.actor, x.action]), [['system', 'minutes.gather']]);
  const moves = JSON.parse(logs[0].ops).filter((o) => o.op === 'move');
  assert.deepStrictEqual(moves.map((o) => o.id).sort(), [...ids].sort());
  assert.ok(moves.every((o) => o.parent === M && o.oldParent === null && typeof o.old === 'string'), '前の値の無い move');
  // meta: 「議事録」データベースの ID と、移した数と日時
  assert.strictEqual(metaOf(db, 'minutes.db'), M);
  assert.deepStrictEqual(JSON.parse(metaOf(db, 'minutes.gathered')), { n: 300, at: new Date(clock).toISOString() });
  // F194: 0.16.0 の木（0a6a375 の pageTree を写した見本）では、移した議事録が全部「議事録」データベースの下の子として並ぶ（行の型にしない）
  const tree = PT160.pageTree(listOf(db));
  assert.deepStrictEqual([...(tree.kids.get(M) || [])].sort(), [...ids].sort(), '0.16.0 の木で「議事録」の下に並ばない');
  assert.strictEqual(db.prepare("select count(*) c from blocks where type = 'row' and parent_id = ?").get(M).c, 0, '議事録を行の型にした');
}));

test('MG-2・F193: 途中で投げると何も変わらない（meta も書かない）・照らせないページ（壊れた attrs）はそこに残して数え、ほかは移す・二度目は移さない（数は 0・meta はそのまま）', T, () => withDb((db, t) => {
  const ids = [0, 1, 2, 3].map((i) => oldMeeting(t, `pq${i}`, i));
  db.exec(`create temp trigger natsu_test_boom before update of parent_id on blocks when new.id = '${ids[2]}' begin select raise(abort, 'boom'); end;`);
  const snap = [db.prepare('select id, parent_id, ord, rev, attrs from blocks order by id').all().map((r) => ({ ...r })), db.prepare('select count(*) c from oplog').get().c];
  assert.strictEqual(gather(db).code, 'internal');
  assert.deepStrictEqual([db.prepare('select id, parent_id, ord, rev, attrs from blocks order by id').all().map((r) => ({ ...r })), db.prepare('select count(*) c from oplog').get().c], snap, '途中で投げたのに書いた');
  assert.deepStrictEqual([metaOf(db, 'minutes.db'), metaOf(db, 'minutes.gathered')], [undefined, undefined]);
  db.exec('drop trigger natsu_test_boom');
  // 照らせないページ（attrs が JSON でない）
  db.prepare("update blocks set attrs = '{壊れた' where id = ?").run(ids[3]);
  const r = ok(gather(db), 'minutes.gather');
  assert.deepStrictEqual([r.result.moved, r.result.skipped, r.result.created], [3, 1, true]);
  const M = minutesDbs(db)[0];
  assert.deepStrictEqual(ids.map((id) => db.prepare('select parent_id from blocks where id = ?').get(id).parent_id), [M, M, M, null]);
  const gathered = metaOf(db, 'minutes.gathered');
  assert.deepStrictEqual(JSON.parse(gathered).n, 3);
  // 二度目（見回り）: 移すものが無ければ 0・新しいデータベースを作らない・meta の数はそのまま
  const again = ok(gather(db, {}), 'minutes.gather');
  assert.deepStrictEqual([again.result.moved, again.result.created], [0, false]);
  assert.deepStrictEqual(minutesDbs(db), [M]);
  assert.strictEqual(metaOf(db, 'minutes.gathered'), gathered);
}));

test('MG-2・F203: 「議事録」の題名を変えても、見回りで新しいデータベースを作らない（役の印で探す）。meta が別のページを指していれば印を正にして meta を直す。ゴミ箱に入れた後は新しく作る', T, () => withDb((db, t) => {
  oldMeeting(t, 'pq1', 1);
  ok(gather(db), 'minutes.gather');
  const M = minutesDbs(db)[0];
  ok(call(db, 'page.setTitle', { id: M, title: '会議の記録' }), 'page.setTitle');   // データベースの題名（D77 の外）
  const other = ok(call(db, 'db.create', {}), 'db.create').result.id;
  db.prepare("insert into meta(key, value) values ('minutes.db', ?) on conflict(key) do update set value = excluded.value").run(other);
  oldMeeting(t, 'pq2', 2);
  const r = ok(gather(db, {}), 'minutes.gather');
  assert.deepStrictEqual([r.result.moved, r.result.created, r.result.db], [1, false, M]);
  assert.deepStrictEqual(minutesDbs(db), [M], '題名を変えたら新しいデータベースを作った');
  assert.strictEqual(metaOf(db, 'minutes.db'), M, 'meta を印に合わせない');
  assert.strictEqual(db.prepare('select parent_id from blocks where id = ?').get('pq2').parent_id, M);
  // ゴミ箱に入れた「議事録」は無いのと同じ（次の見回り・締めで新しく作る: 決めたこと 49）
  ok(call(db, 'page.delete', { id: M }), 'page.delete');
  oldMeeting(t, 'pq3', 3);
  const r2 = ok(gather(db, {}), 'minutes.gather');
  assert.strictEqual(r2.result.created, true);
  assert.notStrictEqual(r2.result.db, M);
  assert.strictEqual(db.prepare('select parent_id from blocks where id = ?').get('pq3').parent_id, r2.result.db);
}));

test('MG-2・F195: 締め・復旧した新しい議事録の親は「議事録」データベース（無ければ同じ命令の中で作る）・録音中の写しは親なしで一覧の外・白紙のページの中の議事録の締め直しは親が変わらない・page.put は親と cells を消さない', T, () => withDb((db) => {
  // 「議事録」が無いときの締め: 同じ命令の中で作って、その子にする（oplog の1行）
  call(db, 'meeting.begin', { pageId: 'pl1', startedAt: Date.parse('2026-11-14T00:00:00.000Z'), localOnly: false }, 'main');
  assert.strictEqual(db.prepare('select parent_id from blocks where id = ?').get('pl1').parent_id, null, '録音中の写しに親がある');
  assert.deepStrictEqual(minutesDbs(db), [], '録音中に「議事録」を作った');
  const f = ok(call(db, 'meeting.finalize', { pageId: 'pl1', page: { title: titleAt('2026-11-14T00:00:00.000Z'), date: '2026-11-14', createdAt: '2026-11-14T00:00:00.000Z', blocks: [] }, segments: [] }, 'main'), 'meeting.finalize');
  const M = minutesDbs(db)[0];
  assert.ok(M, '締めで「議事録」を作らない');
  assert.strictEqual(db.prepare('select parent_id from blocks where id = ?').get('pl1').parent_id, M, '締めた議事録が最上位');
  assert.strictEqual(db.prepare('select count(*) c from oplog where tx = ?').get(f.tx).c, 1);
  assert.strictEqual(metaOf(db, 'minutes.db'), M);
  // 2つ目の録音: 写しは親なし・「議事録」の表に出ない。締めると同じ「議事録」の子（作り直さない）。並びの鍵は後ろ
  call(db, 'meeting.begin', { pageId: 'pl2', startedAt: Date.parse('2026-11-14T02:00:00.000Z'), localOnly: false }, 'main');
  assert.strictEqual(db.prepare('select parent_id from blocks where id = ?').get('pl2').parent_id, null);
  assert.deepStrictEqual(viewOf(db, M).rows.map((x) => x.id), ['pl1'], '録音中の写しが表に出た');
  meeting(db, 'pl2', { at: '2026-11-14T02:00:00.000Z', date: '2026-11-14' });
  assert.deepStrictEqual(minutesDbs(db), [M]);
  assert.strictEqual(db.prepare('select parent_id from blocks where id = ?').get('pl2').parent_id, M);
  const ord = (id) => db.prepare('select ord from blocks where id = ?').get(id).ord;
  assert.ok(ord('pl1') < ord('pl2'), '新しい議事録の並びの鍵が後ろでない');
  // 復旧（下書きから作る）も「議事録」の子
  ok(call(db, 'meeting.recover', { pageId: 'pr1', page: { title: titleAt('2026-11-14T03:00:00.000Z'), date: '2026-11-14', createdAt: '2026-11-14T03:00:00.000Z', blocks: [] }, segments: [] }, 'main'), 'meeting.recover');
  assert.strictEqual(db.prepare('select parent_id from blocks where id = ?').get('pr1').parent_id, M, '復旧した議事録が最上位');
  // 白紙のページの中の議事録（TQ1 で移さなかった物）の締め直しは親が変わらない（P9）
  const blank = ok(call(db, 'page.create', {}), 'page.create').result.id;
  under(db, 'pl2', blank, 'b7');
  meeting(db, 'pl2', { at: '2026-11-14T02:00:00.000Z', date: '2026-11-14', bullet: '締め直し' });
  assert.deepStrictEqual({ ...db.prepare('select parent_id, ord from blocks where id = ?').get('pl2') }, { parent_id: blank, ord: 'b7' }, '締め直しで親が変わった');
  // 要約の書き戻し（page.put）は親・並びの鍵・cells を消さない
  ok(call(db, 'row.setCell', { db: M, id: 'pl1', col: attrsOf(db, M).cols[3].id, value: ['メンバー甲'] }), 'row.setCell');
  const p = ok(call(db, 'page.get', { id: 'pl1' }, 'main'), 'page.get').result.page;
  ok(call(db, 'page.put', { page: { ...p, cells: undefined, blocks: [{ id: 'pl1x', type: 'bullet', text: '書き戻し' }] }, baseRev: p.rev }, 'main'), 'page.put');
  assert.deepStrictEqual([db.prepare('select parent_id from blocks where id = ?').get('pl1').parent_id, attrsOf(db, 'pl1').cells], [M, { [attrsOf(db, M).cols[3].id]: ['メンバー甲'] }]);
}));

test('MG-2: T4b（控えに後の oplog（移し替え・見回り・締め）を前へ当て直すと今の表と同じ）', T, async () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    for (let i = 0; i < 5; i += 1) oldMeeting(t, `pq${i}`, i);
    const to = path.join(t.dir, 'copy-mg2.db');
    await sqlite.backup(db, to);
    const copy = new sqlite.DatabaseSync(to);
    try {
      const k = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
      ok(gather(db), 'minutes.gather');
      oldMeeting(t, 'pq9', 9);   // 0.16.0 に戻して作った最上位の議事録（種は oplog を書かないので、控えにも同じ行を足す）
      const seed = db.prepare('select * from blocks where page_id = ?').all('pq9');
      const segs = db.prepare('select * from segments where page_id = ?').all('pq9');
      for (const r of seed) copy.prepare(`insert into blocks(${Object.keys(r).join(', ')}) values (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r));
      for (const r of segs) copy.prepare(`insert into segments(${Object.keys(r).join(', ')}) values (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r));
      ok(gather(db, {}), '見回り');
      meeting(db, 'pz1', { at: '2026-11-14T05:00:00.000Z', date: '2026-11-14' });
      const rows = db.prepare('select ops from oplog where seq > ? order by seq').all(k).map((r) => JSON.parse(r.ops));
      for (const o of rows) applyOps(copy, o, 'forward');
      const dump = (c) => [c.prepare('select id, type, page_id, parent_id, ord, text, attrs, rev, created_at, updated_at, trashed_at from blocks order by id').all().map((r) => ({ ...r })),
        c.prepare('select page_id, id, n, text from segments order by page_id, n').all().map((r) => ({ ...r }))];
      assert.deepStrictEqual(dump(copy), dump(db));
    } finally { copy.close(); }
  } finally { t.done(); }
});

// ---- 起動の順（src/db/server.js）: JSON の取り込み → 確かめ済みの控え → 移し替え（初めて）か見回り
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
const backups = (d, kind) => { try { return fs.readdirSync(path.join(d.dataDir, 'backup')).filter((x) => x.endsWith(`-${kind}.db.gz`)); } catch (_) { return []; } };
// 0.16.0 までの最上位の議事録を、閉じた DB に足す（0.16.0 に戻して録音した会議・移す前の形）
function addOld(d, id, i) {
  const c = core.open({ sqlite, file: d.file });
  try { const t = { seed: (page, segs) => require('../src/db/commands').putPageRows(c.db, page, segs) }; oldMeeting(t, id, i); } finally { c.db.close(); }
}
const status = async (s) => (await s.port('main').ask({ id: 1, cmd: 'db.status', args: {} })).result;

test('MG-2・F193: 起動のとき、確かめ済みの控え（upgrade）を取ってから移す。控えが取れない（偽の失敗）と移さず meta も書かず、次の起動で移す。三度目の起動では控えを取らず移さない', { timeout: 60000 }, async () => {
  const d = tmpData({ pages: 0 });
  d.close();
  for (let i = 0; i < 3; i += 1) addOld(d, `pq${i}`, i);
  let s = boot(d, { runCheck: async () => 'unavailable' });
  try {
    await s.ready();
    const st = await status(s);
    assert.deepStrictEqual(st.startup.minutes, { failed: true }, '控えが取れないのに移した');
    assert.deepStrictEqual(backups(d, 'upgrade'), []);
  } finally { await s.stop(); }
  let peek = core.open({ sqlite, file: d.file });
  try {
    assert.deepStrictEqual([minutesDbs(peek.db), metaOf(peek.db, 'minutes.gathered')], [[], undefined], '控えが取れないのに書いた');
    assert.strictEqual(peek.db.prepare("select count(*) c from blocks where type = 'page' and parent_id is null").get().c, 3);
  } finally { peek.db.close(); }
  s = boot(d, { runCheck: async () => 'ok' });
  try {
    await s.ready();
    const st = await status(s);
    assert.deepStrictEqual([st.startup.minutes.first, st.startup.minutes.moved, st.startup.minutes.created], [true, 3, true]);
    assert.strictEqual(backups(d, 'upgrade').length, 1, '移す前の控えが無い');
    assert.ok(s.logs().some((x) => x === 'DB: 議事録 移した 3・残した 0・データベースを作った'), s.logs().join('\n'));
    assert.ok(s.logs().every((x) => !x.includes('議事録 ') || !/\d{4}\/\d{2}\/\d{2}/.test(x)), '記録に題名を書いた');
  } finally { await s.stop(); }
  s = boot(d, { runCheck: async () => 'ok' });
  try {
    await s.ready();
    const st = await status(s);
    assert.deepStrictEqual([st.startup.minutes.first, st.startup.minutes.moved, st.startup.minutes.created], [false, 0, false]);
    assert.strictEqual(backups(d, 'upgrade').length, 1, '二度目の起動でまた控えを取った');
  } finally { await s.stop(); }
  peek = core.open({ sqlite, file: d.file });
  try {
    assert.strictEqual(JSON.parse(metaOf(peek.db, 'minutes.gathered')).n, 3, '二度目の起動で移した数を書き替えた');
    assert.strictEqual(minutesDbs(peek.db).length, 1);
  } finally { peek.db.close(); d.done(); }
});

test('MG-2・F194: 0.16.0 に戻して録音した最上位の議事録と、JSON の取り込み（ST10）で戻った議事録を、次の起動の見回りで「議事録」に入れる', { timeout: 60000 }, async () => {
  const d = tmpData({ pages: 2, withJson: true });
  d.close();
  let s = boot(d, { runCheck: async () => 'ok' });
  try { await s.ready(); assert.strictEqual((await status(s)).startup.minutes.moved, 2); } finally { await s.stop(); }
  addOld(d, 'pq7', 7);
  // 古い版が JSON に書いた新しい議事録（起動の取り込みで足される）
  const J = require('../src/jsonfile');
  const { page, segments } = samplePage('pdj01');
  for (const b of page.blocks) b.id = `pdj01${b.id}`;
  J.writeJsonFile(path.join(d.dataDir, 'pages', 'pdj01.json'), page);
  J.writeJsonFile(path.join(d.dataDir, 'transcripts', 'pdj01.json'), { id: 'pdj01', segments });
  s = boot(d, { runCheck: async () => 'ok' });
  try {
    await s.ready();
    const st = await status(s);
    assert.strictEqual(st.startup.reimport.added, 1, '前提: 取り込みで足されない');
    assert.deepStrictEqual([st.startup.minutes.first, st.startup.minutes.moved], [false, 2]);
  } finally { await s.stop(); }
  const peek = core.open({ sqlite, file: d.file });
  try {
    const M = minutesDbs(peek.db)[0];
    for (const id of ['pq7', 'pdj01', ...d.ids]) assert.strictEqual(peek.db.prepare('select parent_id from blocks where id = ?').get(id).parent_id, M, id);
  } finally { peek.db.close(); d.done(); }
});
