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
