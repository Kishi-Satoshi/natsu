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
const LIST160 = require(path.join(__dirname, 'fixtures', 'v160', 'listed.js'));
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
  // 0.18.2 TD-1（計画 docs/plans/2026-11-28-182.md の決めたこと 1・「意図して変えるテスト」）で意図して変えた: 最初の移し替えで「タスク管理」を作らないので、
  // TK-1 で足した tasks（作った「タスク管理」）を答えから外した（0.17.0 の TK-1 の前の形に戻る）
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
  // F194: 0.16.0 の一覧（0a6a375 の listedRows を写した見本）と木（pageTree）と、サイドバーの絞り（!p.inRow）では、移した議事録が全部
  // 「議事録」データベースの下の子として並ぶ（行の型にしない）。rv59 軽い 4（R49）: 0.17.0 の pages.list でなく 0.16.0 の読み方で読む
  const tree = PT160.pageTree(LIST160.listedRows(db).filter((p) => !p.inRow));
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
  // ゴミ箱に入れた「議事録」は無いのと同じ（次の見回り・締めで新しく作る: 決めたこと 49）。ロックを外してから消す（決めたこと 55）
  ok(call(db, 'db.setLock', { db: M, on: false }), 'db.setLock');
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

test('MG-2・F194（決めたこと 48）: 締め・復旧の後の見回り。最初の移し替えの後は、締めの命令の後に最上位に残った議事録を別の命令（actor system）で「議事録」に入れる。最初の移し替えの前（控えが取れずに待っている間）は動かさない', { timeout: 60000 }, async () => {
  const d = tmpData({ pages: 0 });
  d.close();
  addOld(d, 'pq0', 0);
  let s = boot(d, { runCheck: async () => 'unavailable' });   // 最初の移し替えを待っている間
  try {
    await s.ready();
    addOld(d, 'pq1', 1);
    const main = s.port('main');
    const page = { title: titleAt('2026-11-14T06:00:00.000Z'), date: '2026-11-14', createdAt: '2026-11-14T06:00:00.000Z', blocks: [] };
    assert.strictEqual((await main.ask({ id: 2, cmd: 'meeting.finalize', args: { pageId: 'pf1', page, segments: [] }, tx: 'm:mg2-fin-0001' })).ok, true);
    await new Promise((res) => setTimeout(res, 50));
  } finally { await s.stop(); }
  let peek = core.open({ sqlite, file: d.file });
  try {
    const M = minutesDbs(peek.db)[0];
    assert.deepStrictEqual(['pq0', 'pq1', 'pf1'].map((id) => peek.db.prepare('select parent_id from blocks where id = ?').get(id).parent_id), [null, null, M], '控えの前に今までの議事録を動かした');
  } finally { peek.db.close(); }
  s = boot(d, { runCheck: async () => 'ok' });   // 最初の移し替え（pq0・pq1）
  try {
    await s.ready();
    addOld(d, 'pq2', 2);   // 0.16.0 で録音した最上位の議事録（起動の後に足された）
    const main = s.port('main');
    const seen = []; main.onEvent((e) => seen.push(e));
    const page = { title: titleAt('2026-11-14T07:00:00.000Z'), date: '2026-11-14', createdAt: '2026-11-14T07:00:00.000Z', blocks: [] };
    assert.strictEqual((await main.ask({ id: 3, cmd: 'meeting.finalize', args: { pageId: 'pf2', page, segments: [] }, tx: 'm:mg2-fin-0002' })).ok, true);
    await waitFor(() => seen.some((e) => e.pageIds && e.pageIds.includes('pq2')), '見回りの知らせ');
  } finally { await s.stop(); }
  peek = core.open({ sqlite, file: d.file });
  try {
    const M = minutesDbs(peek.db)[0];
    assert.deepStrictEqual(['pq0', 'pq1', 'pq2', 'pf1', 'pf2'].map((id) => peek.db.prepare('select parent_id from blocks where id = ?').get(id).parent_id), [M, M, M, M, M]);
    const log = peek.db.prepare("select actor, action from oplog where instr(ops, 'pq2') > 0 and action = 'minutes.gather'").all().map((r) => [r.actor, r.action]);
    assert.deepStrictEqual(log, [['system', 'minutes.gather']], '締めと別の命令（actor system）で入れていない');
  } finally { peek.db.close(); d.done(); }
});

// ---------------------------------------------------------------- 点検 2（rv59）の直し（計画の R43〜）
const trashedAt = (db, id) => db.prepare('select trashed_at from blocks where id = ?').get(id).trashed_at;
const parentOf = (db, id) => db.prepare('select parent_id from blocks where id = ?').get(id).parent_id;

test('rv59 重要 1・決めたこと 54: 「議事録」の表で議事録の行をゴミ箱へ（rows.trash）入れると、子孫のページも同じ時刻でゴミ箱へ（サイドバーの最上位に出ない）。Ctrl+Z でも、ゴミ箱の［戻す］でも一緒に「議事録」へ戻る', T, () => withDb((db) => {
  meeting(db, 'pa1');
  meeting(db, 'pa2', { at: '2026-11-11T02:00:00.000Z', date: '2026-11-11' });
  const M = minutesDbs(db)[0];
  const kid = ok(call(db, 'page.create', { parentId: 'pa1' }), 'page.create').result.id;
  const grand = ok(call(db, 'page.create', { parentId: kid }), 'page.create').result.id;
  const early = ok(call(db, 'page.create', { parentId: 'pa1' }), 'page.create').result.id;
  ok(call(db, 'page.delete', { id: early }), 'page.delete');   // 先にゴミ箱に入れた子の時刻は書き換えない
  const was = trashedAt(db, early);
  const tr = ok(call(db, 'rows.trash', { db: M, ids: ['pa1'] }), 'rows.trash');
  assert.strictEqual(tr.result.trashed, 1, '答えの数は表の行だけ');
  assert.ok(trashedAt(db, 'pa1'));
  assert.deepStrictEqual([trashedAt(db, kid), trashedAt(db, grand), trashedAt(db, early), trashedAt(db, 'pa2')], [trashedAt(db, 'pa1'), trashedAt(db, 'pa1'), was, null], '子孫が同じ時刻でゴミ箱に入らない');
  assert.deepStrictEqual(listOf(db).filter((p) => [kid, grand].includes(p.id)), [], '親の無い子ページが一覧に出た');
  // Ctrl+Z（データベースの歩み）で一緒に戻る
  ok(call(db, 'edit.revert', { pageId: M, steps: [tr.tx] }), 'edit.revert');
  assert.deepStrictEqual([trashedAt(db, 'pa1'), trashedAt(db, kid), trashedAt(db, grand), trashedAt(db, early)], [null, null, null, was]);
  // ゴミ箱の［戻す］でも一緒に「議事録」へ戻る
  ok(call(db, 'rows.trash', { db: M, ids: ['pa1'] }), 'rows.trash');
  ok(call(db, 'page.restore', { id: 'pa1' }), 'page.restore');
  assert.deepStrictEqual([trashedAt(db, 'pa1'), trashedAt(db, kid), trashedAt(db, grand), parentOf(db, 'pa1'), parentOf(db, kid)], [null, null, null, M, 'pa1']);
}));

test('rv59 重要 2・R39: 「議事録」の列ごとの書き直し（種類を変える・確かめの数・選択肢を消す・完全に消す）は、議事録のページ（ゴミ箱も）のセルにも当たる', T, () => withDb((db) => {
  meeting(db, 'pb1');
  meeting(db, 'pb2', { at: '2026-11-11T02:00:00.000Z', date: '2026-11-11' });
  const M = minutesDbs(db)[0];
  ok(call(db, 'db.setLock', { db: M, on: false }), 'db.setLock');   // 列の書き直しはロックを外してから（決めたこと 74）
  const cols = attrsOf(db, M).cols;
  const person = cols.find((c) => c.type === 'person').id;
  ok(call(db, 'row.setCell', { db: M, id: 'pb1', col: person, value: ['メンバー甲'] }), 'row.setCell');
  ok(call(db, 'row.setCell', { db: M, id: 'pb2', col: person, value: ['メンバー乙'] }), 'row.setCell');
  ok(call(db, 'rows.trash', { db: M, ids: ['pb2'] }), 'rows.trash');
  assert.strictEqual(ok(call(db, 'col.typeCheck', { db: M, col: person, type: 'number' }), 'col.typeCheck').result.emptied, 1, '確かめの数に議事録のセルが入らない（ゴミ箱は数えない）');
  const st = ok(call(db, 'col.setType', { db: M, col: person, type: 'text' }), 'col.setType');
  assert.ok(st.result.emptied === 0, '人の名前は文字に読める');
  assert.deepStrictEqual([attrsOf(db, 'pb1').cells[person], attrsOf(db, 'pb2').cells[person]], ['メンバー甲', 'メンバー乙'], '議事録のセルを新しい種類に読み替えない（ゴミ箱も）');
  // 選択肢を消すと議事録のセルからも外れる
  const sel = ok(call(db, 'col.add', { db: M, type: 'select', name: '区分' }), 'col.add').result.col;   // 列の名前（画面の文の外の試しの字）
  const withOpt = ok(call(db, 'col.setOpts', { db: M, col: sel.id, opts: [{ id: 'o1', name: '定例', color: 'gray' }] }), 'col.setOpts').result.col;
  ok(call(db, 'row.setCell', { db: M, id: 'pb1', col: sel.id, value: withOpt.opts[0].id }), 'row.setCell');
  ok(call(db, 'col.setOpts', { db: M, col: sel.id, opts: [] }), 'col.setOpts');
  assert.ok(!Object.hasOwn(attrsOf(db, 'pb1').cells, sel.id), '消した選択肢が議事録のセルに残る');
  // 完全に消すと議事録のセル（ゴミ箱も）からも消える
  ok(call(db, 'col.remove', { db: M, col: person }), 'col.remove');
  ok(call(db, 'col.purge', { db: M, col: person }), 'col.purge');
  assert.deepStrictEqual([Object.hasOwn(attrsOf(db, 'pb1').cells, person), Object.hasOwn(attrsOf(db, 'pb2').cells, person)], [false, false], '完全に消した列の値が議事録に残る');
}));

test('rv59 重要 3・F203（R43）: ゴミ箱から古い「議事録」を戻したとき、ほかに生きている「議事録」があれば、古い方の議事録（ゴミ箱の議事録も）を同じ命令で今の方へ移し、古い方は役の印を外したふつうのデータベースで戻る（列とビューは写さない）', T, () => withDb((db) => {
  meeting(db, 'pc1');
  meeting(db, 'pc2', { at: '2026-11-11T02:00:00.000Z', date: '2026-11-11' });
  const OLD = minutesDbs(db)[0];
  ok(call(db, 'db.setLock', { db: OLD, on: false }), 'db.setLock');   // ロックを外して列を足し、消す（決めたこと 55・74）
  const oldCols = attrsOf(db, OLD).cols;
  const person = oldCols.find((c) => c.type === 'person').id;
  ok(call(db, 'row.setCell', { db: OLD, id: 'pc1', col: person, value: ['メンバー甲'] }), 'row.setCell');
  const extra = ok(call(db, 'col.add', { db: OLD, type: 'text', name: '場所' }), 'col.add').result.col;   // 列の名前（試しの字）
  ok(call(db, 'row.setCell', { db: OLD, id: 'pc1', col: extra.id, value: '三階' }), 'row.setCell');
  const kid = ok(call(db, 'page.create', { parentId: 'pc2' }), 'page.create').result.id;
  ok(call(db, 'page.delete', { id: 'pc2' }), 'page.delete');   // 先に1つだけゴミ箱へ（古い方の子のまま）
  ok(call(db, 'page.delete', { id: OLD }), 'page.delete');
  meeting(db, 'pc3', { at: '2026-11-12T02:00:00.000Z', date: '2026-11-12' });   // 決めたこと 49: 新しい「議事録」ができる
  const CUR = minutesDbs(db)[0];
  assert.notStrictEqual(CUR, OLD);
  ok(call(db, 'db.setLock', { db: CUR, on: false }), 'db.setLock');
  const other = ok(call(db, 'col.add', { db: CUR, type: 'number', name: '人数' }), 'col.add').result.col;   // 同じ ID で種類の違う列（試しの字）
  assert.strictEqual(other.id, extra.id, '前提: 同じ ID の列');
  const oldViews = attrsOf(db, OLD).views;
  const curShape = { cols: attrsOf(db, CUR).cols, views: attrsOf(db, CUR).views };
  const r = ok(call(db, 'page.restore', { id: OLD }), 'page.restore');
  assert.deepStrictEqual(minutesDbs(db), [CUR], '役の印のある生きた「議事録」が2つ');
  assert.strictEqual(metaOf(db, 'minutes.db'), CUR);
  const a = attrsOf(db, OLD);
  assert.deepStrictEqual([a.kind, a.role, trashedAt(db, OLD), a.views], ['database', undefined, null, oldViews], '古い方はふつうのデータベース');
  assert.deepStrictEqual({ cols: attrsOf(db, CUR).cols, views: attrsOf(db, CUR).views }, curShape, '今の方の列とビューを変えた');
  assert.deepStrictEqual(['pc1', 'pc2'].map((id) => parentOf(db, id)), [CUR, CUR], '古い方の議事録が今の方へ移らない');
  assert.deepStrictEqual([trashedAt(db, 'pc1'), Boolean(trashedAt(db, 'pc2')), parentOf(db, kid)], [null, true, 'pc2'], 'ゴミ箱の議事録は移してもゴミ箱のまま');
  const ord = (id) => db.prepare('select ord from blocks where id = ?').get(id).ord;
  assert.ok(ord('pc3') < ord('pc1'), '移した議事録は今の方の末尾');
  // セル: 今の方の同じ列（参加者）は残り、同じ ID で違う列の値は外す（今の方の列に違う種類の値を見せない）
  assert.deepStrictEqual(attrsOf(db, 'pc1').cells, { [person]: ['メンバー甲'] });
  assert.deepStrictEqual(viewOf(db, CUR).rows.map((x) => x.id).sort(), ['pc1', 'pc3']);
  // 1つの命令（oplog の1行）。後でゴミ箱の議事録を戻すと今の方へ戻る
  assert.strictEqual(db.prepare('select count(*) c from oplog where tx = ?').get(r.tx).c, 1);
  ok(call(db, 'page.restore', { id: 'pc2' }), 'page.restore');
  assert.deepStrictEqual([parentOf(db, 'pc2'), trashedAt(db, 'pc2'), trashedAt(db, kid)], [CUR, null, null]);
  // ほかに「議事録」が無ければ、今どおり「議事録」として戻る
  ok(call(db, 'page.delete', { id: CUR }), 'page.delete');
  ok(call(db, 'page.restore', { id: CUR }), 'page.restore');
  assert.deepStrictEqual([minutesDbs(db), attrsOf(db, CUR).role], [[CUR], 'minutes']);
}));

test('rv59 軽い 5・決めたこと 52: 「議事録」の表への貼り付け（rows.paste）は表に見えている並び（dbRowsOf: 議事録の行も）で書き、行を足す分は断る', T, () => withDb((db) => {
  meeting(db, 'pd1', { at: '2026-11-10T01:30:00.000Z', date: '2026-11-10' });
  meeting(db, 'pd2', { at: '2026-11-11T01:30:00.000Z', date: '2026-11-11' });
  const M = minutesDbs(db)[0];
  const row = ok(call(db, 'row.add', { db: M, title: '行の題' }), 'row.add').result.id;   // データベースの行の題名（D77 の外）
  const person = attrsOf(db, M).cols.find((c) => c.type === 'person').id;
  const order = viewOf(db, M).rows.map((r) => r.id);
  assert.deepStrictEqual(order, ['pd2', 'pd1', row], '前提: 表の並び（日付の新しい順・日付の無い行は後ろ）');
  ok(call(db, 'rows.paste', { db: M, viewId: 'v1', at: { row: 'pd2', col: person }, grid: [['メンバー甲'], ['メンバー乙']] }), 'rows.paste');
  assert.deepStrictEqual([attrsOf(db, 'pd2').cells[person], attrsOf(db, 'pd1').cells[person], (attrsOf(db, row).cells || {})[person]], [['メンバー甲'], ['メンバー乙'], undefined], '見えている並びで書かない');
  const n0 = db.prepare('select count(*) c from oplog').get().c;
  assert.strictEqual(call(db, 'rows.paste', { db: M, viewId: 'v1', at: { row: 'pd1', col: person }, grid: [['甲'], ['乙'], ['丙']] }).code, 'bad-args', '「議事録」に行を足した');
  assert.strictEqual(db.prepare('select count(*) c from oplog').get().c, n0);
}));

test('rv59 軽い 2・決めたこと 48: ゴミ箱から最上位に戻した議事録（移す前にゴミ箱にあった・消した「議事録」の中の1つ）は、戻した命令の後の見回りで「議事録」に入る（次の起動を待たない）', { timeout: 60000 }, async () => {
  const d = tmpData({ pages: 0 });
  d.close();
  addOld(d, 'pq0', 0);
  addOld(d, 'pq1', 1);
  const c = core.open({ sqlite, file: d.file });
  try { c.db.prepare("update blocks set trashed_at = '2026-11-01T00:00:00.000Z' where id = 'pq1'").run(); } finally { c.db.close(); }   // 移す前にゴミ箱にあった議事録
  const s = boot(d, { runCheck: async () => 'ok' });
  try {
    await s.ready();
    const app = s.port('app');
    const seen = []; app.onEvent((e) => seen.push(e));
    assert.strictEqual((await app.ask({ id: 2, cmd: 'page.restore', args: { id: 'pq1' }, tx: 'a:rv59-res-0001' })).ok, true);
    await waitFor(() => seen.some((e) => e.pageIds && e.pageIds.includes('pq1') && e.actor === 'system'), '見回りの知らせ');
  } finally { await s.stop(); }
  const peek = core.open({ sqlite, file: d.file });
  try {
    const M = minutesDbs(peek.db)[0];
    assert.deepStrictEqual(['pq0', 'pq1'].map((id) => peek.db.prepare('select parent_id from blocks where id = ?').get(id).parent_id), [M, M], '戻した議事録が最上位に残る');
  } finally { peek.db.close(); d.done(); }
});

test('rv59 重要 4・決めたこと 59（R51）: 移し替えは Ctrl+Z で戻らない（edit.revert は断り、何も変えない）。議事録はページのまま「議事録」の子で、0.16.0 の一覧と木でも全部見える', T, () => withDb((db, t) => {
  for (let i = 0; i < 3; i += 1) oldMeeting(t, `pu${i}`, i);
  const g = ok(gather(db), 'minutes.gather');
  const M = g.result.db;
  const n0 = db.prepare('select count(*) c from oplog').get().c;
  assert.strictEqual(call(db, 'edit.revert', { pageId: M, steps: [g.tx] }).code, 'bad-args', '移し替えを Ctrl+Z で戻した');
  assert.strictEqual(db.prepare('select count(*) c from oplog').get().c, n0);
  assert.deepStrictEqual(['pu0', 'pu1', 'pu2'].map((id) => parentOf(db, id)), [M, M, M]);
  const tree = PT160.pageTree(LIST160.listedRows(db).filter((p) => !p.inRow));
  assert.deepStrictEqual([...(tree.kids.get(M) || [])].sort(), ['pu0', 'pu1', 'pu2']);
}));

// ---------------------------------------------------------------- LK-1（決めたこと 55・73〜77・F204）: データベースのロック
test('LK-1・F204: ロック中は page.delete・page.move・col.*・view.add・view.remove・db.setSub が bad-args で何も変えない。row.add・row.setCell・rows.trash・view.update（並べ替えと絞り込み）・題名とアイコンは通る。ロックを外すとできる。ロックの切り替えは Ctrl+Z の歩みにしない', T, () => withDb((db) => {
  const D = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const host = ok(call(db, 'page.create', {}), 'page.create').result.id;
  const c1 = ok(call(db, 'col.add', { db: D, type: 'text', name: '場所' }), 'col.add').result.col.id;   // 列の名前（試しの字）
  const sel = ok(call(db, 'col.add', { db: D, type: 'select', name: '区分' }), 'col.add').result.col.id;   // 列の名前（試しの字）
  const lk = ok(call(db, 'db.setLock', { db: D, on: true }), 'db.setLock');
  assert.strictEqual(attrsOf(db, D).locked, true);
  assert.strictEqual(listOf(db).find((p) => p.id === D).locked, true, '一覧の行にロックの印が無い');
  assert.strictEqual(ok(call(db, 'db.get', { id: D }), 'db.get').result.locked, true, 'db.get にロックの印が無い');
  const snap = () => db.prepare('select id, parent_id, ord, text, attrs, trashed_at from blocks order by id').all().map((r) => ({ ...r }));
  const before = snap();
  const n0 = db.prepare('select count(*) c from oplog').get().c;
  const refused = [
    ['page.delete', { id: D }], ['page.move', { id: D, parentId: host }],
    ['col.add', { db: D, type: 'text', name: '別' }], ['col.rename', { db: D, col: c1, name: '別' }], ['col.setType', { db: D, col: c1, type: 'number' }],
    ['col.move', { db: D, col: c1, after: '' }], ['col.remove', { db: D, col: c1 }], ['col.setOpts', { db: D, col: sel, opts: [{ id: 'o1', name: '定例', color: 'gray' }] }],
    ['col.setFmt', { db: D, col: c1, fmt: 'comma' }], ['view.add', { db: D, layout: 'table' }], ['view.remove', { db: D, viewId: 'v1' }], ['db.setSub', { db: D, on: true }],
  ];
  for (const [cmd, args] of refused) assert.strictEqual(call(db, cmd, args).code, 'bad-args', `ロック中に ${cmd} が通った`);
  assert.deepStrictEqual([snap(), db.prepare('select count(*) c from oplog').get().c], [before, n0], '断ったのに書いた');
  // 中身は書ける（決めたこと 74）
  const r = ok(call(db, 'row.add', { db: D, title: '一' }), 'row.add').result.id;   // データベースの行の題名（D77 の外）
  ok(call(db, 'row.setCell', { db: D, id: r, col: c1, value: '三階' }), 'row.setCell');
  const v = ok(call(db, 'db.get', { id: D }), 'db.get').result.views[0];
  ok(call(db, 'view.update', { db: D, viewId: v.id, patch: { sort: [{ col: c1, dir: 'asc' }] } }), 'view.update');
  ok(call(db, 'db.setTitle', { db: D, title: '名簿' }), 'db.setTitle');   // データベースの題名（D77 の外）
  ok(call(db, 'page.setIcon', { id: D, icon: 'ic:star' }), 'page.setIcon');
  ok(call(db, 'rows.trash', { db: D, ids: [r] }), 'rows.trash');
  // ロックの切り替えは元に戻すの歩みにしない
  assert.strictEqual(call(db, 'edit.revert', { pageId: D, steps: [lk.tx] }).code, 'bad-args', 'ロックを Ctrl+Z で戻した');
  // ロックを外せば、ふつうのデータベースと同じ
  ok(call(db, 'db.setLock', { db: D, on: false }), 'db.setLock');
  assert.ok(!Object.hasOwn(attrsOf(db, D), 'locked'), '外したのに印が残る');
  assert.ok(!Object.hasOwn(listOf(db).find((p) => p.id === D), 'locked'));
  ok(call(db, 'col.rename', { db: D, col: c1, name: '別' }), 'col.rename');
  ok(call(db, 'page.delete', { id: D }), 'page.delete');
  assert.strictEqual(call(db, 'db.setLock', { db: D, on: true }).code, 'bad-args', 'ゴミ箱のデータベースをロックした');
}));

test('LK-1・F204: ロックの前の列とビューの歩みは、ロック中は Ctrl+Z で戻さない（stale）。ロック中の貼り付けは選択肢を足さない（読めない値は空にして数える）。ロック中のデータベースは白紙のページに戻さない', T, () => withDb((db) => {
  const D = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const add = ok(call(db, 'col.add', { db: D, type: 'select', name: '区分' }), 'col.add');   // 列の名前（試しの字）
  const sel = add.result.col.id;
  ok(call(db, 'row.add', { db: D, title: '一' }), 'row.add');   // データベースの行の題名（D77 の外）
  ok(call(db, 'db.setLock', { db: D, on: true }), 'db.setLock');
  assert.strictEqual(call(db, 'edit.revert', { pageId: D, steps: [add.tx] }).code, 'stale', 'ロック中に列を足した歩みを戻した');
  const first = ok(call(db, 'db.view', { id: D, viewId: 'v1', from: 0, count: 10 }), 'db.view').result.rows[0].id;
  const p = ok(call(db, 'rows.paste', { db: D, viewId: 'v1', at: { row: first, col: sel }, grid: [['定例']] }), 'rows.paste').result;
  assert.deepStrictEqual([p.unread, attrsOf(db, D).cols.find((c) => c.id === sel).opts || []], [1, []], 'ロック中の貼り付けで選択肢を足した');
  // page.toDb で作ったデータベースをロックしたら、白紙のページへ戻さない
  const P = ok(call(db, 'page.create', {}), 'page.create').result.id;
  const to = ok(call(db, 'page.toDb', { id: P }), 'page.toDb');
  ok(call(db, 'db.setLock', { db: P, on: true }), 'db.setLock');
  assert.strictEqual(call(db, 'edit.revert', { pageId: P, steps: [to.tx] }).code, 'stale', 'ロック中のデータベースを白紙のページに戻した');
}));

test('LK-1・lc-minutes-start（決めたこと 76・77）: 「議事録」はロックした形で作る。0.16.0 の一覧の読み方（0a6a375 の listedRows を写した見本）とビューの照らしは、locked があっても落ちずにデータベースとして読む', T, () => withDb((db) => {
  meeting(db, 'pk1');
  const M = minutesDbs(db)[0];
  assert.strictEqual(attrsOf(db, M).locked, true);
  assert.strictEqual(call(db, 'page.delete', { id: M }).code, 'bad-args', '「議事録」を消せた');
  const row = LIST160.listedRows(db).find((r) => r.id === M);
  assert.ok(row && row.attrs.kind === 'database' && row.attrs.locked === true);
  const V160 = require(path.join(__dirname, 'fixtures', 'v160', 'dbView.js'));
  assert.doesNotThrow(() => V160.normalizeView(row.attrs.views[0], row.attrs.cols));
}));

// ---------------------------------------------------------------- MG-3（決めたこと 54〜57・F197・F198）: サイドバー・検索・Claude・移動と削除の断り
test('MG-3・F198: 一覧の行は「議事録」データベースに minutes・その子孫（議事録と議事録の子ページ）に inMinutes の印（ほかの行は1字も同じ）。中の議事録は page.move で外へ出さない（議事録の子ページと、白紙のページの中の議事録は今どおり動かせる）。「議事録」はロック中は消せない。ゴミ箱から戻すと「議事録」に戻る', T, () => withDb((db) => {
  meeting(db, 'ps1');
  const M = minutesDbs(db)[0];
  const kid = ok(call(db, 'page.create', { parentId: 'ps1' }), 'page.create').result.id;
  const blank = ok(call(db, 'page.create', {}), 'page.create').result.id;
  meeting(db, 'ps2', { at: '2026-11-11T02:00:00.000Z', date: '2026-11-11' });
  under(db, 'ps2', blank, 'b1');   // 白紙のページの中の議事録（TQ1: 移さない物）
  const list = listOf(db);
  const by = new Map(list.map((p) => [p.id, p]));
  assert.deepStrictEqual([by.get(M).minutes, by.get(M).inMinutes, by.get('ps1').inMinutes, by.get(kid).inMinutes], [true, undefined, true, true]);
  assert.deepStrictEqual([by.get(blank).inMinutes, by.get('ps2').inMinutes, by.get(blank).minutes], [undefined, undefined, undefined], '「議事録」の外の行に印');
  for (const [where, to] of [['最上位', ''], ['白紙のページ', blank]]) assert.strictEqual(call(db, 'page.move', { id: 'ps1', parentId: to }).code, 'bad-args', `中の議事録を${where}へ出した`);
  assert.strictEqual(parentOf(db, 'ps1'), M);
  ok(call(db, 'page.move', { id: kid, parentId: blank }), '議事録の子ページを動かせない');
  ok(call(db, 'page.move', { id: kid, parentId: 'ps1' }), '議事録の子ページを戻せない');
  ok(call(db, 'page.move', { id: 'ps2', parentId: '' }), '白紙のページの中の議事録を動かせない');
  assert.strictEqual(call(db, 'page.delete', { id: M }).code, 'bad-args', 'ロック中の「議事録」を消した');
  // MG-4（決めたこと 52）: 「議事録」はロックを外してもサブアイテムを使えない・行を足す貼り付けは断る（rv59 軽い 5）
  ok(call(db, 'db.setLock', { db: M, on: false }), 'db.setLock');
  assert.strictEqual(call(db, 'db.setSub', { db: M, on: true }).code, 'bad-args', '「議事録」にサブアイテムを入れた');
  ok(call(db, 'db.setLock', { db: M, on: true }), 'db.setLock');
  ok(call(db, 'page.delete', { id: 'ps1' }), 'page.delete');
  ok(call(db, 'page.restore', { id: 'ps1' }), 'page.restore');
  assert.deepStrictEqual([parentOf(db, 'ps1'), parentOf(db, kid), trashedAt(db, kid)], [M, 'ps1', null]);
}));

// ---------------------------------------------------------------- TK-1（決めたこと 60〜62・65・F200・F203）: 「タスク管理」データベースとマイタスク
const tasksDbs = (db) => db.prepare("select id, attrs from blocks where type = 'page' and trashed_at is null and instr(attrs, 'tasks') > 0").all()
  .filter((r) => { try { return JSON.parse(r.attrs).role === 'tasks'; } catch (_) { return false; } }).map((r) => r.id);
// 0.18.2 TD-1（計画 docs/plans/2026-11-28-182.md の決めたこと 1・2・「意図して変えるテスト」）: 「タスク管理」は最初の移し替えでは作らず、初めての［タスクにする］で作る。
// 前の形（「タスク管理」がある）を、要約に ToDo のある議事録を1つ足して todo.toTask を1回通して作り直す → { K（「タスク管理」）, row（作った行）, tx }
function firstTask(db, id = 'pk0') {
  todoMeeting(db, id, [{ text: '段取りを決める' }]);
  const r = ok(call(db, 'todo.toTask', { pageId: id, blockId: `${id}t0` }), 'todo.toTask');
  return { K: r.result.db, row: r.result.id, tx: r.tx };
}
// 0.18.2 TD-1（計画 docs/plans/2026-11-28-182.md の決めたこと 1・2・「意図して変えるテスト」）で意図して変えた: 最初の移し替えでは「タスク管理」を作らない。
// 「タスク管理」の形（列・ビュー）と1つだけであること（二度目・見回り・消した後の見回りで作らない）は、初めての［タスクにする］（1つの命令）で作ったもので確かめる
test('TK-1・F200・F203: 最初の移し替えでは「タスク管理」を作らず、初めての［タスクにする］と同じトランザクションで「タスク管理」が1つ（列 ステータス・担当・期限・優先度・議事録（「議事録」への片側のリレーション）・ビュー すべて・マイタスク・期限順）。二度目は作らない・消しても見回りで作り直さない', T, () => withDb((db, t) => {
  oldMeeting(t, 'pt0', 0);
  const g = ok(gather(db), 'minutes.gather');
  assert.deepStrictEqual(tasksDbs(db), [], '最初の移し替えで「タスク管理」を作った');
  const seq0 = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
  const first = firstTask(db);
  const T1 = tasksDbs(db);
  assert.strictEqual(T1.length, 1, '「タスク管理」が1つでない');
  const K = T1[0];
  assert.strictEqual(first.K, K);
  assert.deepStrictEqual(db.prepare('select tx from oplog where seq > ? and action = ?').all(seq0, 'todo.toTask').map((x) => x.tx), [first.tx], '別のトランザクションで作った');
  const a = attrsOf(db, K);
  const M = g.result.db;
  assert.deepStrictEqual([db.prepare('select text, parent_id from blocks where id = ?').get(K).text, a.kind, a.role, a.locked], ['タスク管理', 'database', 'tasks', undefined]);
  assert.deepStrictEqual(a.cols.map((c) => [c.name, c.type]), [['名前', 'title'], ['ステータス', 'status'], ['担当', 'person'], ['期限', 'date'], ['優先度', 'select'], ['議事録', 'rel']]);
  const st = a.cols[1]; const pr = a.cols[4]; const rel = a.cols[5];
  assert.deepStrictEqual(st.opts.map((o) => o.name), ['未着手', '進行中', '完了']);
  assert.deepStrictEqual(pr.opts.map((o) => o.name), ['高', '中', '低']);
  assert.deepStrictEqual([rel.db, rel.back], [M, undefined], '「議事録」への片側のリレーションでない');
  assert.ok(attrsOf(db, M).cols.every((c) => c.type !== 'rel'), '「議事録」の側に列を作った（TQ2b）');
  assert.deepStrictEqual(a.views.map((v) => v.name), ['すべて', 'マイタスク', '期限順']);
  for (const v of a.views) assert.deepStrictEqual(DV.normalizeView(v, a.cols).view, v, `${v.name} のビューの形が照らしで変わる`);
  // 二度目の［タスクにする］・見回りでは作らない。消した後も見回りでは作らない（作り直すのは［タスクにする］: TK-2）
  todoMeeting(db, 'pk1', [{ text: '資料を集める' }]);
  assert.strictEqual(ok(call(db, 'todo.toTask', { pageId: 'pk1', blockId: 'pk1t0' }), 'todo.toTask').result.db, K);
  oldMeeting(t, 'pt1', 1);
  ok(gather(db, {}), '見回り');
  assert.deepStrictEqual(tasksDbs(db), [K]);
  ok(call(db, 'page.delete', { id: K }), 'page.delete');
  oldMeeting(t, 'pt2', 2);
  ok(gather(db, {}), '見回り');
  assert.deepStrictEqual(tasksDbs(db), [], '消した「タスク管理」を見回りで作り直した');
}));

// 0.18.2 TD-1（計画 docs/plans/2026-11-28-182.md の「意図して変えるテスト」）で意図して変えた: 「タスク管理」を最初の移し替えでなく初めての［タスクにする］で作り、
// そのとき作った行はゴミ箱へ入れる（ビューの並びを確かめる中身は変えない）
test('TK-1・F200: 「マイタスク」は担当に「自分」があり完了でない行を期限の順に・「期限順」は完了を除いて期限の順。「議事録」へのリレーションの［新しい行を作ってつなぐ］は断る（rv59 軽い 6）', T, () => withDb((db, t) => {
  oldMeeting(t, 'pt0', 0);
  ok(gather(db), 'minutes.gather');
  const { K, row: made } = firstTask(db);
  ok(call(db, 'rows.trash', { db: K, ids: [made] }), 'rows.trash');
  const a = attrsOf(db, K);
  const [, st, who, due] = a.cols;
  const add = (title, cells) => ok(call(db, 'row.add', { db: K, title, cells }), 'row.add').result.id;   // タスクの題名（D77 の外）
  const r1 = add('見積もり', { [st.id]: 'o1', [who.id]: ['自分'], [due.id]: { start: '2026-11-20' } });
  const r2 = add('発注', { [st.id]: 'o3', [who.id]: ['自分'], [due.id]: { start: '2026-11-18' } });
  const r3 = add('検収', { [st.id]: 'o2', [who.id]: ['メンバー甲'], [due.id]: { start: '2026-11-17' } });
  const r4 = add('請求', { [who.id]: ['自分', 'メンバー乙'], [due.id]: { start: '2026-11-19' } });
  const r5 = add('段取り', { [who.id]: ['自分'] });
  const ids = (v) => ok(call(db, 'db.view', { id: K, viewId: v.id, from: 0, count: 50 }), 'db.view').result.rows.map((r) => r.id);
  assert.deepStrictEqual(ids(a.views[1]), [r4, r1, r5], 'マイタスク');
  assert.deepStrictEqual(ids(a.views[2]), [r3, r4, r1, r5], '期限順');
  assert.strictEqual(ids(a.views[0]).length, 5);
  assert.ok(r2);
  assert.strictEqual(call(db, 'rel.link', { db: K, id: r1, col: a.cols[5].id, ids: [], title: '新しい会議' }).code, 'bad-args', '「議事録」にふつうの行を作った');   // 題名（D77 の外: 断る）
  ok(call(db, 'rel.link', { db: K, id: r1, col: a.cols[5].id, ids: ['pt0'] }), '議事録をつなげない');
}));

// ---------------------------------------------------------------- TK-2（決めたこと 63・F199）: ［タスクにする］（todo.toTask）
function todoMeeting(db, id, todos) {
  const at = '2026-11-12T01:00:00.000Z';
  const page = { title: titleAt(at), date: '2026-11-12', createdAt: at, blocks: [{ id: `${id}h`, type: 'heading', text: 'ToDo' }, ...todos.map((t, i) => ({ id: `${id}t${i}`, type: 'todo', text: t.text, checked: Boolean(t.checked), ...(t.assignee ? { assignee: t.assignee } : {}), ...(t.due ? { due: t.due, dueRaw: t.due, dueApprox: Boolean(t.approx) } : {}) }))] };
  ok(call(db, 'meeting.finalize', { pageId: id, page, segments: [] }, 'main'), 'meeting.finalize');
  return id;
}
const taskCells = (db, K, rowId) => { const cols = attrsOf(db, K).cols; const c = attrsOf(db, rowId).cells || {}; const by = (n) => c[cols.find((x) => x.name === n).id]; return { status: by('ステータス'), who: by('担当'), due: by('期限'), mins: by('議事録') }; };
// 0.18.2 TD-1（計画 docs/plans/2026-11-28-182.md の「意図して変えるテスト」）で意図して変えた: 「タスク管理」は最初の移し替えで作らないので、最初の todo.toTask が
// 作った「タスク管理」を K にする（作るのは1つだけ）
test('TK-2・F199: todo.toTask は「タスク管理」に行を1つ（題名・担当・期限は ToDo のまま・無ければ空・推し量った期限は入れない・済みなら完了）を作り、議事録のリレーションにその議事録、ToDo に印。二度押しても送り直しても1つ', T, () => withDb((db, t) => {
  oldMeeting(t, 'pz0', 0);
  ok(gather(db), 'minutes.gather');
  todoMeeting(db, 'pw1', [{ text: '見積もりを出す', assignee: 'メンバー甲', due: '2026-11-20' }, { text: '資料を集める' }, { text: '先方に送る', checked: true, due: '2026-11-21', approx: true }]);
  const r = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }), 'todo.toTask');
  const row = r.result.id;
  const K = r.result.db;
  assert.deepStrictEqual(tasksDbs(db), [K]);
  assert.deepStrictEqual([db.prepare('select type, parent_id, text from blocks where id = ?').get(row).type, db.prepare('select parent_id from blocks where id = ?').get(row).parent_id, db.prepare('select text from blocks where id = ?').get(row).text], ['row', K, '見積もりを出す']);
  assert.deepStrictEqual(taskCells(db, K, row), { status: 'o1', who: ['メンバー甲'], due: { start: '2026-11-20' }, mins: ['pw1'] });
  assert.strictEqual(attrsOf(db, 'pw1t0').task, row, 'ToDo に印が無い');
  assert.strictEqual(db.prepare('select count(*) c from oplog where tx = ?').get(r.tx).c, 1);
  // 二度押す・送り直す: 1つのまま
  const again = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }), 'todo.toTask');
  assert.strictEqual(again.result.id, row);
  ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }, 'app', r.tx), '送り直し');
  assert.strictEqual(db.prepare("select count(*) c from blocks where type = 'row' and parent_id = ?").get(K).c, 1, '2つ作った');
  // 担当も期限も無い ToDo は空・推し量った期限は入れない・済みの ToDo は完了
  const r2 = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t1' }), 'todo.toTask').result.id;
  assert.deepStrictEqual(taskCells(db, K, r2), { status: 'o1', who: undefined, due: undefined, mins: ['pw1'] });
  const r3 = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t2' }), 'todo.toTask').result.id;
  assert.deepStrictEqual(taskCells(db, K, r3), { status: 'o3', who: undefined, due: undefined, mins: ['pw1'] });
  // 白紙のページの ToDo は議事録のリレーションが空
  const P = ok(call(db, 'page.create', {}), 'page.create').result.id;
  const tb = ok(call(db, 'block.insert', { pageId: P, afterBlockId: '', type: 'todo' }), 'block.insert').result.blockId;
  ok(call(db, 'block.update', { pageId: P, blockId: tb, patch: { text: '机を片付ける' } }), 'block.update');
  const r4 = ok(call(db, 'todo.toTask', { pageId: P, blockId: tb }), 'todo.toTask').result.id;
  assert.deepStrictEqual(taskCells(db, K, r4).mins, undefined);
  // ToDo でない行・録音中の写しは断る
  assert.strictEqual(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1h' }).code, 'bad-args');
  call(db, 'meeting.begin', { pageId: 'pl9', startedAt: Date.parse('2026-11-14T00:00:00.000Z'), localOnly: false }, 'main');
  assert.strictEqual(call(db, 'todo.toTask', { pageId: 'pl9', blockId: 'x1' }).code, 'bad-args');
}));

// 0.18.2 TD-1（計画 docs/plans/2026-11-28-182.md の「意図して変えるテスト」）で意図して変えた: 最初の todo.toTask が作った「タスク管理」を K にする
test('TK-2・F199: Ctrl+Z（edit.revert）で行（ゴミ箱へ）と ToDo の印が一緒に戻り、やり直しでまた付く。「タスク管理」を消した後は、同じ命令の中で作り直す', T, () => withDb((db, t) => {
  oldMeeting(t, 'pz0', 0);
  ok(gather(db), 'minutes.gather');
  todoMeeting(db, 'pw1', [{ text: '見積もりを出す' }]);
  const r = ok(call(db, 'todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }), 'todo.toTask');
  const row = r.result.id;
  const K = r.result.db;
  const back = ok(call(db, 'edit.revert', { pageId: 'pw1', steps: [r.tx] }), 'edit.revert');
  assert.deepStrictEqual([Boolean(trashedAt(db, row)), attrsOf(db, 'pw1t0').task], [true, undefined], 'Ctrl+Z で行と印が一緒に戻らない');
  ok(call(db, 'edit.revert', { pageId: 'pw1', steps: [back.tx] }), 'やり直し');
  assert.deepStrictEqual([trashedAt(db, row), attrsOf(db, 'pw1t0').task], [null, row]);
  // 「タスク管理」を消した後は作り直す（二度作らない: F203）
  ok(call(db, 'page.delete', { id: K }), 'page.delete');
  todoMeeting(db, 'pw2', [{ text: '次の段取り' }]);
  const r2 = ok(call(db, 'todo.toTask', { pageId: 'pw2', blockId: 'pw2t0' }), 'todo.toTask');
  assert.notStrictEqual(r2.result.db, K);
  assert.strictEqual(tasksDbs(db).length, 1);
  todoMeeting(db, 'pw3', [{ text: 'もう一つ' }]);
  assert.strictEqual(ok(call(db, 'todo.toTask', { pageId: 'pw3', blockId: 'pw3t0' }), 'todo.toTask').result.db, r2.result.db);
  assert.strictEqual(tasksDbs(db).length, 1, '「タスク管理」を2つ作った');
}));

// ---------------------------------------------------------------- RT-1（決めたこと 66・67・69・70・F202）: 行のテンプレートの命令
const bodyIds = (db, id) => db.prepare('select id from blocks where page_id = ? and id <> ? order by ord').all(id, id).map((r) => r.id);
const bodyTexts = (db, id) => db.prepare('select type, text from blocks where page_id = ? and id <> ? order by ord').all(id, id).map((r) => `${r.type}:${r.text}`);
function tplWithBody(db, D, title) {
  const tp = ok(call(db, 'tpl.add', { db: D, title }), 'tpl.add').result.id;
  const b1 = ok(call(db, 'block.insert', { pageId: tp, afterBlockId: '', type: 'heading' }), 'block.insert').result.blockId;
  ok(call(db, 'block.update', { pageId: tp, blockId: b1, patch: { text: '進め方' } }), 'block.update');
  const b2 = ok(call(db, 'block.insert', { pageId: tp, afterBlockId: b1, type: 'todo' }), 'block.insert').result.blockId;
  ok(call(db, 'block.update', { pageId: tp, blockId: b2, patch: { text: '先方に確かめる' } }), 'block.update');
  return tp;
}
test('RT-1・F202: tpl.add のテンプレートの行は表・検索・MCP・集計・リレーションの選びに出ない。row.fromTpl は題名・列の値・本文を写した行（ブロックの ID は新しい・テンプレートを直しても作った行は変わらない）。tpl.dup は ID が新しい。21 個目は too-big。「議事録」とロック中は tpl.add が bad-args', T, () => withDb((db, t) => {
  const D = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const c1 = ok(call(db, 'col.add', { db: D, type: 'text', name: '場所' }), 'col.add').result.col.id;   // 列の名前（試しの字）
  const tp = tplWithBody(db, D, '定例の見本');   // テンプレートの題名（D77 の外）
  ok(call(db, 'row.setCell', { db: D, id: tp, col: c1, value: '会議室' }), 'row.setCell');
  assert.strictEqual(attrsOf(db, tp).tpl, true);
  const N = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const rel = ok(call(db, 'col.add', { db: N, type: 'rel', target: D }), 'col.add').result.col.id;
  const r0 = ok(call(db, 'row.add', { db: N, title: '相手' }), 'row.add').result.id;   // 行の題名（D77 の外）
  assert.deepStrictEqual(ok(call(db, 'db.view', { id: D, viewId: 'v1', from: 0, count: 50 }), 'db.view').result.rows.map((r) => r.id), [], 'テンプレートが表に出た');
  assert.deepStrictEqual(ok(call(db, 'rel.find', { db: D }), 'rel.find').result.rows.map((r) => r.id), [], 'テンプレートがリレーションの選びに出た');
  assert.ok(rel && r0);
  assert.strictEqual(require('../src/db/commands').dbDump(db, D, 100, clock).total, 0, 'テンプレートが Claude の答えに出た');
  // row.fromTpl: 写した行（本文のブロックの ID は新しい）
  const f = ok(call(db, 'row.fromTpl', { db: D, id: tp }), 'row.fromTpl');
  const r1 = f.result.id;
  const a1 = attrsOf(db, r1);
  assert.deepStrictEqual([db.prepare('select text from blocks where id = ?').get(r1).text, a1.cells[c1], a1.tpl], ['定例の見本', '会議室', undefined]);
  assert.deepStrictEqual(bodyTexts(db, r1), bodyTexts(db, tp), '本文が写らない');
  assert.ok(bodyIds(db, r1).every((id) => !bodyIds(db, tp).includes(id)), 'ブロックの ID を分け合う');
  const hits = JSON.stringify(ok(call(db, 'pages.list', { q: '会議室' }), 'pages.list').result);
  assert.ok(hits.includes(r1) && !hits.includes(tp), `テンプレートが検索に出た（作った行は出る）: ${hits.slice(0, 200)}`);
  ok(call(db, 'block.update', { pageId: tp, blockId: bodyIds(db, tp)[0], patch: { text: '変えた' } }), 'block.update');
  assert.deepStrictEqual(bodyTexts(db, r1)[0], 'heading:進め方', 'テンプレートを直すと作った行が変わった');
  // Ctrl+Z（データベースの歩み）で作った行が本文ごと戻る
  ok(call(db, 'edit.revert', { pageId: D, steps: [f.tx] }), 'edit.revert');
  assert.deepStrictEqual([db.prepare('select count(*) c from blocks where id = ?').get(r1).c, bodyIds(db, r1)], [0, []], 'Ctrl+Z で行と本文が戻らない');
  // tpl.dup
  const dp = ok(call(db, 'tpl.dup', { db: D, id: tp }), 'tpl.dup').result.id;
  assert.notStrictEqual(dp, tp);
  assert.strictEqual(attrsOf(db, dp).tpl, true);
  assert.ok(bodyIds(db, dp).length === 2 && bodyIds(db, dp).every((id) => !bodyIds(db, tp).includes(id)), '複製がブロックの ID を分け合う');
  // 20 まで
  for (let i = 0; i < 18; i += 1) ok(call(db, 'tpl.add', { db: D }), 'tpl.add');
  assert.strictEqual(call(db, 'tpl.add', { db: D }).code, 'too-big', '21 個目を作れた');
  assert.strictEqual(call(db, 'tpl.dup', { db: D, id: tp }).code, 'too-big');
  // 「議事録」とロック中
  oldMeeting(t, 'px0', 0);
  const M = ok(gather(db), 'minutes.gather').result.db;
  ok(call(db, 'db.setLock', { db: M, on: false }), 'db.setLock');
  assert.strictEqual(call(db, 'tpl.add', { db: M }).code, 'bad-args', '「議事録」でテンプレートを作れた');
  ok(call(db, 'db.setLock', { db: N, on: true }), 'db.setLock');
  assert.strictEqual(call(db, 'tpl.add', { db: N }).code, 'bad-args', 'ロック中にテンプレートを作れた');
}));

test('RT-1・F202: 既定（データベースの既定・ビューごとの既定）。「このビューだけ」はほかのビューを変えない・「空白のページ」に戻せる・既定のテンプレートを消すとビューは「データベースの既定」→「空白のページ」に戻る。どれもデータベースの歩みで Ctrl+Z', T, () => withDb((db) => {
  const D = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const v2 = ok(call(db, 'view.add', { db: D, layout: 'table' }), 'view.add').result.view.id;
  const A = ok(call(db, 'tpl.add', { db: D, title: '見本A' }), 'tpl.add').result.id;   // テンプレートの題名（D77 の外）
  const B = ok(call(db, 'tpl.add', { db: D, title: '見本B' }), 'tpl.add').result.id;   // テンプレートの題名（D77 の外）
  const def = (v) => ok(call(db, 'db.get', { id: D }), 'db.get').result.tpls.defaults[v];
  ok(call(db, 'tpl.setDefault', { db: D, id: A }), 'tpl.setDefault');
  assert.deepStrictEqual([def('v1'), def(v2)], [A, A], '「すべてのビュー」');
  const s2 = ok(call(db, 'tpl.setDefault', { db: D, id: B, view: v2 }), 'tpl.setDefault');
  assert.deepStrictEqual([def('v1'), def(v2)], [A, B], '「このビューだけ」がほかのビューに効いた');
  ok(call(db, 'tpl.setDefault', { db: D, id: '', view: 'v1' }), 'tpl.setDefault');
  assert.deepStrictEqual([def('v1'), def(v2)], ['', B], '「空白のページ」に戻せない');
  // 既定のテンプレート B を消すと、v2 はデータベースの既定（A）に戻る。A を消すと「空白のページ」
  ok(call(db, 'tpl.remove', { db: D, id: B }), 'tpl.remove');
  assert.strictEqual(def(v2), A);
  ok(call(db, 'tpl.setDefault', { db: D, id: A, view: 'v1' }), 'tpl.setDefault');
  ok(call(db, 'tpl.remove', { db: D, id: A }), 'tpl.remove');
  assert.deepStrictEqual([def('v1'), def(v2)], ['', ''], '消したテンプレートが既定に残る');
  assert.deepStrictEqual([attrsOf(db, D).tplDefault, attrsOf(db, D).tplViews], [undefined, undefined], '消したテンプレートの既定の欄が残る（ゴミ箱から戻すとまた既定になる）');
  assert.deepStrictEqual(ok(call(db, 'db.get', { id: D }), 'db.get').result.tpls.list, [], '消したテンプレートが並びに残る');
  // Ctrl+Z
  const steps = db.prepare("select tx from oplog where action in ('tpl.remove') order by seq desc").all().map((r) => r.tx);
  ok(call(db, 'edit.revert', { pageId: D, steps: [steps[0]] }), 'edit.revert');
  assert.deepStrictEqual(ok(call(db, 'db.get', { id: D }), 'db.get').result.tpls.list.map((x) => x.id), [A], 'Ctrl+Z で消したテンプレートが戻らない');
  assert.strictEqual(def('v1'), A, 'Ctrl+Z で既定が戻らない');
  assert.ok(s2.tx);
}));

// ---------------------------------------------------------------- NX-7（第4部・第6版。決めたこと 95・F216・計画の R66・notion-behavior の N-30）
// ロックしたデータベースを入れた親のページは、今どおり確かめなしで一緒にゴミ箱へ入り、一緒に戻る（2026-11-16 に確かめた実機と同じ: notion-behavior の N-30）。コードは変えない
const trashedOf = (db, id) => (db.prepare('select trashed_at from blocks where id = ?').get(id) || {}).trashed_at;
const oplogCount = (db) => db.prepare('select count(*) as c from oplog').get().c;
// データベースの行は、データベースと一緒にゴミ箱の中にある（行そのものの印は付けず、データベースの中に残る: 0.16.0 のゴミ箱の形のまま）
const rowsKept = (db, D, rows) => { for (const r of rows) assert.deepStrictEqual([db.prepare('select parent_id from blocks where id = ?').get(r).parent_id, trashedOf(db, r)], [D, null], `行 ${r} がデータベースの中に無い`); };
const snap = (db) => JSON.stringify(db.prepare('select id, parent_id, ord, attrs, trashed_at from blocks order by id').all());
function lockedDbIn(db, parentId) {
  const D = ok(call(db, 'db.create', { parentId }), 'db.create').result.id;
  ok(call(db, 'db.setTitle', { db: D, title: '名簿' }), 'db.setTitle');   // データベースの題名（D77 の外）
  const rows = ['一行目', '二行目'].map((t) => ok(call(db, 'row.add', { db: D, title: t }), 'row.add').result.id);   // 行の題名（D77 の外）
  ok(call(db, 'db.setLock', { db: D, on: true }), 'db.setLock');
  return { D, rows };
}
test('NX-7・F216: ロックしたデータベースを中に持つ白紙のページの page.delete は断られず、親・データベース・行が oplog の1行で一緒にゴミ箱へ（ロック中のまま）。page.restore で一緒に戻る。途中のデータベースそのものの page.delete は bad-args で何も変えない', T, () => withDb((db) => {
  const P = ok(call(db, 'page.create', {}), 'page.create').result.id;
  const { D, rows } = lockedDbIn(db, P);
  // 途中に断られるはずの頼みを混ぜる（記録した試作の読み）
  const before = snap(db); const n0 = oplogCount(db);
  const no = call(db, 'page.delete', { id: D });
  assert.deepStrictEqual([no.ok, no.code], [false, 'bad-args'], 'ロックしたデータベースそのものを消せた（lc-delete）');
  assert.strictEqual(snap(db), before, '断った後に何か変わった');
  assert.strictEqual(oplogCount(db), n0, '断った命令が oplog に残った');
  const r = ok(call(db, 'page.delete', { id: P }), '親のページの page.delete');
  assert.strictEqual(oplogCount(db), n0 + 1, '親を消す命令が oplog の1行でない');
  for (const id of [P, D]) assert.ok(trashedOf(db, id), `${id} がゴミ箱に入らない`);
  rowsKept(db, D, rows);
  assert.strictEqual(attrsOf(db, D).locked, true, 'ゴミ箱の中でロックが外れた');
  ok(call(db, 'page.restore', { id: P }), 'page.restore');
  for (const id of [P, D]) assert.strictEqual(trashedOf(db, id), null, `${id} が親と一緒に戻らない`);
  rowsKept(db, D, rows);
  assert.strictEqual(attrsOf(db, D).locked, true, '戻したときにロックが外れた');
  const U = require('../src/undoBook');
  assert.strictEqual(U.UNDO_CMDS.has('page.delete'), false, 'page.delete が Ctrl+Z の歩みに入った（今どおりゴミ箱の［戻す］で戻す）');
  assert.ok(r.ok);
}));

test('NX-7・F216: 本文の子ページの行ごと（block.remove・blocks.remove）でも、ロックしたデータベースを入れた子ページは一緒にゴミ箱へ入り、戻すと一緒に戻る', T, () => withDb((db) => {
  for (const cmd of ['block.remove', 'blocks.remove']) {
    const P = ok(call(db, 'page.create', {}), 'page.create').result.id;
    const C = ok(call(db, 'page.create', { parentId: P }), 'page.create（子）').result.id;
    const { D, rows } = lockedDbIn(db, C);
    const sub = ok(call(db, 'page.get', { id: P }), 'page.get').result.page.blocks.find((b) => b.type === 'subpage' && b.page === C);
    assert.ok(sub, '前提: 親の本文に子ページの行が無い');
    const n0 = oplogCount(db);
    ok(call(db, cmd, cmd === 'block.remove' ? { pageId: P, blockId: sub.id } : { pageId: P, ids: [sub.id] }), cmd);
    assert.strictEqual(oplogCount(db), n0 + 1, `${cmd} が oplog の1行でない`);
    for (const id of [C, D]) assert.ok(trashedOf(db, id), `${cmd}: ${id} がゴミ箱に入らない`);
  rowsKept(db, D, rows);
    assert.strictEqual(attrsOf(db, D).locked, true);
    ok(call(db, 'page.restore', { id: C }), 'page.restore');
    for (const id of [C, D]) assert.strictEqual(trashedOf(db, id), null, `${cmd}: ${id} が一緒に戻らない`);
  rowsKept(db, D, rows);
    assert.strictEqual(attrsOf(db, D).locked, true);
  }
}));

test('NX-7・F216: 「議事録」の行ごと（rows.trash）でも、ロックしたデータベースを入れた議事録のページは一緒にゴミ箱へ入り、戻すと一緒に戻る', T, () => withDb((db) => {
  const M = minutesDb(db);
  const a = meeting(db, 'pm1'); under(db, a, M);
  const { D, rows } = lockedDbIn(db, a);
  const n0 = oplogCount(db);
  ok(call(db, 'rows.trash', { db: M, ids: [a] }), 'rows.trash');
  assert.strictEqual(oplogCount(db), n0 + 1, 'rows.trash が oplog の1行でない');
  for (const id of [a, D]) assert.ok(trashedOf(db, id), `${id} がゴミ箱に入らない`);
  rowsKept(db, D, rows);
  assert.strictEqual(attrsOf(db, D).locked, true);
  ok(call(db, 'page.restore', { id: a }), 'page.restore');
  for (const id of [a, D]) assert.strictEqual(trashedOf(db, id), null, `${id} が一緒に戻らない`);
  rowsKept(db, D, rows);
  assert.strictEqual(attrsOf(db, D).locked, true);
}));
