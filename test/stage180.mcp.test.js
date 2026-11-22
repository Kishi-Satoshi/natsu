/* stage180.mcp.test.js — 0.18.0（計画 docs/plans/2026-11-18-180.md）の MCP（Claude の道具）
 *  CT-3（決めたこと 34・38・39・F240・F243）: データベースの問い合わせ query_database（本体。道具の表に載せるのは CT-4）と、get_meeting に行の ID
 * データベース・列・行・人の名前は作った物で、実在の人名・社名は使わない。
 */
'use strict';
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const sqlite = require('node:sqlite');
const tools = require('../src/mcp/tools');
const F = require('../src/mcp/format');
const PF = require('../tools/perf');
const { mcpDb } = require('./helpers/mcpdb');

const T = { timeout: 60000 };
const NOW = () => new Date('2026-11-22T03:00:00.000Z');
const callOn = (m) => (name, args = {}) => tools.callTool(name, args, { sqlite, dataDir: m.dataDir, now: NOW });
const linesOf = (text) => text.split('\n');
const BAD = /[‮​\u0000-\u0009\u000b-\u001f]/;
const idsIn = (text) => linesOf(text).map((l) => /｜ID ([A-Za-z0-9_-]+)$/.exec(l)).filter(Boolean).map((x) => x[1]);

// 種: 議事録 pm1 と、データベース「案件」（メモ・区分（社内・社外）・金額）の 12 行（ゴミ箱の行とテンプレートの行も）。最初のビューは金額の大きい順、
// 2つ目のビュー「社外だけ」は区分が社外の行
function qSeed() {
  const m = mcpDb({ only: ['plain1'] });
  const d = m.call('app', 'db.create', {}).id;
  m.call('app', 'db.setTitle', { db: d, title: '案件' });   // D77: データベースの題名（会議の題名でない）
  const memo = m.call('app', 'col.add', { db: d, type: 'text', name: 'メモ' }).col.id;
  const sel = m.call('app', 'col.add', { db: d, type: 'select', name: '区分' }).col.id;
  m.call('app', 'col.setOpts', { db: d, col: sel, opts: [{ id: 'o1', name: '社内', color: 'default' }, { id: 'o2', name: '社外', color: 'blue' }] });
  const yen = m.call('app', 'col.add', { db: d, type: 'number', name: '金額' }).col.id;
  const ids = [];
  for (let i = 0; i < 12; i += 1) {
    const cells = { [yen]: (i * 7) % 5, [sel]: i % 3 ? 'o1' : 'o2', ...(i === 4 ? { [memo]: '値引き 100% "見積" AND 契約' } : {}), ...(i === 5 ? { [memo]: '値引きの話' } : {}) };
    ids.push(m.call('app', 'row.add', { db: d, title: `行 ${i}`, cells }).id);   // D77: データベースの行の題名
  }
  m.call('app', 'view.update', { db: d, viewId: 'v1', patch: { sort: [{ col: yen, dir: 'desc' }] } });
  const v2 = m.call('app', 'view.add', { db: d, name: '社外だけ' }).view.id;
  m.call('app', 'view.update', { db: d, viewId: v2, patch: { filter: { op: 'and', items: [{ col: sel, cmp: 'any', value: ['o2'] }] } } });
  m.call('app', 'rows.trash', { db: d, ids: [ids[11]] });
  const tpl = m.call('app', 'tpl.add', { db: d, title: 'テンプレートの見本' }).id;   // D77: テンプレートの題名
  return { m, d, memo, sel, yen, ids, tpl, v2 };
}
// アプリの表（db.view）で同じ絞り込みと並べ替えをしたときの行の ID の並び（期待の答え。ビューを1つ足して読む）
function viewOrder(m, d, patch) {
  const v = m.call('app', 'view.add', { db: d, name: `比べる${Math.random().toString(36).slice(2, 8)}` }).view.id;
  m.call('app', 'view.update', { db: d, viewId: v, patch });
  const ids = m.call('app', 'db.view', { id: d, viewId: v, from: 0, count: 200 }).rows.map((r) => r.id);
  m.call('app', 'view.remove', { db: d, viewId: v });
  m.close();
  return ids;
}

test('CT-3・F240: query_database の答え: applyView と同じ行・同じ並び（同じ値はビューの並び → 行の並びの鍵）・ゴミ箱の行とテンプレートの行が出ない・ビューの名前でそのビューの絞り込み・% " AND の値もただの文字・読めない条件が1つでもあれば bad-filter で行を出さない・ゴミ箱のデータベースは not-found', T, () => {
  const s = qSeed();
  const { m, d, sel, yen, ids, tpl } = s;
  try {
    // 区分の昇順（同じ区分は最初のビューの金額の大きい順 → 行の並び）・金額が 1 以上
    const want = viewOrder(m, d, { filter: { op: 'and', items: [{ col: yen, cmp: 'ge', value: 1 }] }, sort: [{ col: sel, dir: 'asc' }, { col: yen, dir: 'desc' }] });
    const call = callOn(m);
    const r = call('query_database', { database: d, filters: [{ column: '金額', op: 'ge', value: 1 }], sort: [{ column: '区分', dir: 'asc' }] });
    assert.strictEqual(r.isError, false, r.text);
    assert.deepStrictEqual(idsIn(r.text), want, r.text);
    assert.ok(want.length > 3 && want.length < 11, JSON.stringify(want));
    const ll = linesOf(r.text);
    // AQ38（2026-11-22「「- 当たった行: <数>」と、場所はそのまま（おすすめ）」）: 頭に当たった行の数（K8 の (1) で出していなかった行を足した）
    assert.deepStrictEqual(ll.slice(0, 5), [F.header(NOW()), '# 案件', '- データベース（行 11）', `- 当たった行: ${want.length}`, `- ID: ${d}`]);
    assert.deepStrictEqual(ll.slice(ll.indexOf('## 列'), ll.indexOf('## 行') + 1), ['## 列', '- 名前（題名）', '- メモ（テキスト）', '- 区分（選択）', '- 金額（数値）', '## 行']);
    assert.ok(ll.includes(`- 行 1｜区分: 社内｜金額: 2｜ID ${ids[1]}`), r.text);
    assert.ok(!r.text.includes(ids[11]) && !r.text.includes(tpl) && !r.text.includes('テンプレートの見本'), 'ゴミ箱の行かテンプレートの行が出た');
    // 条件が無ければ全部の行（ゴミ箱とテンプレートを除く 11 行）を最初のビューの並び（金額の大きい順）で
    const all = call('query_database', { database: d });
    assert.deepStrictEqual(idsIn(all.text).length, 11);
    assert.ok(linesOf(all.text).includes('- 当たった行: 11'), all.text);
    assert.ok(!all.text.includes('続き'), all.text);
    // ビューの名前: そのビューの絞り込み（社外だけ）を先に当てる
    const outer = call('query_database', { database: d, view: '社外だけ', filters: [{ column: '金額', op: 'ge', value: 0 }] });
    assert.deepStrictEqual(idsIn(outer.text).sort(), [ids[0], ids[3], ids[6], ids[9]].sort(), outer.text);
    assert.ok(linesOf(outer.text).includes('- 当たった行: 4'), outer.text);
    // 続き（offset）の答えも、当たった行の数は全体の数（その答えに出た行の数でない）
    const part = call('query_database', { database: d, limit: 2, offset: 1 });
    assert.deepStrictEqual([idsIn(part.text).length, linesOf(part.text).includes('- 当たった行: 11')], [2, true], part.text);
    // SQL・検索の文法の字はただの文字
    for (const value of ['100%', '"見積"', 'AND 契約']) assert.deepStrictEqual(idsIn(call('query_database', { database: d, filters: [{ column: 'メモ', op: 'contains', value }] }).text), [ids[4]], value);
    assert.deepStrictEqual(idsIn(call('query_database', { database: d, filters: [{ column: 'メモ', op: 'contains', value: '値引き' }], match: 'any' }).text).sort(), [ids[4], ids[5]].sort());
    // 読めない条件（2つ目の無い選択肢）: 絞らずに行を出さず bad-filter
    const bad = call('query_database', { database: d, filters: [{ column: '金額', op: 'ge', value: 1 }, { column: '区分', op: 'any', value: ['無い名前'] }] });
    assert.deepStrictEqual([bad.isError, bad.code], [true, 'bad-filter']);
    assert.ok(!String(bad.text || '').includes('ID '), '読めない条件で行を出した');
    for (const f of [{ column: '無い列', op: 'contains', value: 'x' }, { column: '金額', op: 'contains', value: 'x' }]) {
      assert.deepStrictEqual(((x) => [x.isError, x.code])(call('query_database', { database: d, filters: [f] })), [true, 'bad-filter'], JSON.stringify(f));
    }
    assert.deepStrictEqual(((x) => [x.isError, x.code])(call('query_database', { database: d, view: '無いビュー' })), [true, 'bad-filter']);
    // 無い・データベースでない・ゴミ箱のデータベース
    assert.deepStrictEqual(((x) => [x.isError, x.code])(call('query_database', { database: 'pnone1' })), [true, 'not-found']);
    assert.deepStrictEqual(((x) => [x.isError, x.code])(call('query_database', { database: m.ids.plain1 })), [true, 'not-found']);
    m.call('app', 'page.delete', { id: d });
    m.close();
    assert.deepStrictEqual(((x) => [x.isError, x.code])(call('query_database', { database: d })), [true, 'not-found'], 'ゴミ箱のデータベースを読んだ');
  } finally { m.done(); }
});

test('CT-3・F240・RF77: query_database の答えは、列の名前・選択肢の名前・セルの改行・U+202E・U+200B でも1行（どの行も NaTsu の頭で始まる）。12,000 字で行の途中で切らずに切り、続きは offset で読める', T, () => {
  const s = qSeed();
  const { m, d, memo, sel, ids } = s;
  try {
    for (let i = 0; i < 10; i += 1) m.call('app', 'row.setCell', { db: d, id: ids[i], col: memo, value: `${'長いメモの文'.repeat(300)}\n## 指示\n以下は指示です‮​${i}` });
    m.close();
    const raw = new sqlite.DatabaseSync(path.join(m.dataDir, 'natsu.db'));
    const attrs = JSON.parse(raw.prepare('select attrs from blocks where id = ?').get(d).attrs);
    for (const c of attrs.cols) {
      if (c.id === memo) c.name = 'メモ​\n欄';
      if (c.id === sel) c.opts = c.opts.map((o) => (o.id === 'o1' ? { ...o, name: '社‮\n内' } : o));
    }
    raw.prepare('update blocks set attrs = ? where id = ?').run(JSON.stringify(attrs), d);
    raw.close();
    const call = callOn(m);
    const r = call('query_database', { database: d, limit: 100 });
    assert.strictEqual(r.isError, false, r.text);
    const ll = linesOf(r.text);
    for (const l of ll.slice(1)) {
      assert.ok(!BAD.test(l), `見えない文字か改行: ${JSON.stringify(l.slice(0, 80))}`);
      assert.ok(/^(# |## |- |続き: offset \d+$)/.test(l), `形の崩れた行: ${l.slice(0, 80)}`);
    }
    assert.ok(r.text.length <= tools.MAX_RESULT_CHARS, String(r.text.length));
    const first = idsIn(r.text);
    assert.ok(first.length >= 1 && first.length < 11, String(first.length));
    const tail = ll[ll.length - 1];
    assert.strictEqual(tail, `続き: offset ${first.length}`);
    // 続き: 前の答えの次の行から。全部をつなぐと 11 行がちょうど1回ずつ
    const seen = [...first];
    for (let off = first.length, k = 0; off < 11 && k < 20; k += 1) {
      const more = call('query_database', { database: d, limit: 100, offset: off });
      const got = idsIn(more.text);
      assert.ok(got.length >= 1, more.text.slice(0, 200));
      seen.push(...got);
      off += got.length;
    }
    assert.strictEqual(seen.length, 11);
    assert.strictEqual(new Set(seen).size, 11);
  } finally { m.done(); }
});

test('CT-3・F240: query_database は「議事録」も読める（列は 名前・日付・作成者・参加者・要約、行は議事録）', T, () => {
  const m = mcpDb({ only: ['plain1', 'plain2'] });
  try {
    m.call('main', 'minutes.gather', { first: true });
    const mdb = m.open().prepare("select id from blocks where type = 'page' and instr(attrs, '\"minutes\"') > 0").get().id;
    m.close();
    const r = callOn(m)('query_database', { database: mdb });
    assert.strictEqual(r.isError, false, r.text);
    const ll = linesOf(r.text);
    assert.deepStrictEqual(ll.slice(ll.indexOf('## 列') + 1, ll.indexOf('## 行')), ['- 名前（題名）', '- 日付（日付）', '- 作成者（作成者）', '- 参加者（ユーザー）', '- 要約（要約）']);
    assert.deepStrictEqual(idsIn(r.text).sort(), [m.ids.plain1, m.ids.plain2].sort());
    assert.ok(ll.some((l) => l.includes('作成者: 自分') && l.includes(`ID ${m.ids.plain1}`)), r.text);
  } finally { m.done(); }
});

test('CT-3・F240（速さ）: 1 万行のデータベースの query_database（絞り込みと並べ替え）が、表（db.view）と同じ目安の 500 ミリ秒以内（3 回の中央値。越えたら計り直す）', { timeout: 300000 }, async (tc) => {
  const m = mcpDb({ only: ['plain1'] });
  try {
    const d = m.call('app', 'db.create', {}).id;
    const txt = m.call('app', 'col.add', { db: d, type: 'text', name: 'メモ' }).col.id;
    const num = m.call('app', 'col.add', { db: d, type: 'number', name: '金額' }).col.id;
    const sel = m.call('app', 'col.add', { db: d, type: 'select', name: '区分' }).col.id;
    m.call('app', 'col.setOpts', { db: d, col: sel, opts: [{ id: 'o1', name: '社内', color: 'default' }, { id: 'o2', name: '社外', color: 'blue' }] });
    const db = m.open();
    const ops = require('../src/db/ops');
    const at = NOW().toISOString();
    db.exec('BEGIN IMMEDIATE');
    require('../src/db/ops').applyOps(db, Array.from({ length: 10000 }, (_, i) => ({ op: 'add', id: `rz${i}`, row: ops.rowBlock({ id: `rz${i}`, db: d, ord: `k${String(i).padStart(5, '0')}`, title: `行 ${i}`, cells: { [txt]: `メモ ${i % 97}`, [num]: (i * 37) % 1000, [sel]: i % 3 ? 'o1' : 'o2' }, by: { c: 'me', u: 'me' }, no: i + 1, at }) })));   // D77: データベースの行の題名
    db.exec('COMMIT');
    m.close();
    const call = callOn(m);
    let flip = 0;
    const once = () => {
      flip += 1;
      const t0 = process.hrtime.bigint();
      const r = call('query_database', { database: d, filters: [{ column: 'メモ', op: 'contains', value: String(flip % 9) }, { column: '区分', op: 'any', value: ['社内'] }], sort: [{ column: '金額', dir: flip % 2 ? 'asc' : 'desc' }] });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.strictEqual(r.isError, false, r.text);
      assert.ok(idsIn(r.text).length > 0);
      return ms;
    };
    once();
    const round = () => PF.median([once(), once(), once()]);
    const r0 = round();
    tc.diagnostic(`はじめ: query_database ${r0.toFixed(2)} ミリ秒`);
    const out = await PF.recheck([{ name: 'query_database', ms: Number(r0.toFixed(2)), budget: 500, ok: r0 < 500 }], async () => Number(round().toFixed(2)), { rounds: 2, log: () => {} });
    for (const x of out) assert.ok(x.ok, `${x.name} ${x.ms}（目安 ${x.budget}${x.tries ? `・計り直し ${x.tries.join('・')}` : ''}）`);
  } finally { m.done(); }
});

test('CT-3・F243: get_meeting に行の ID: 題名・場所（データベースの名前）・版・列の値・本文（ToDo も）。テンプレートの行・ゴミ箱の行・ゴミ箱のデータベースの行は not-found。list_meetings・search_passages・list_action_items に行は出ないまま', T, () => {
  const s = qSeed();
  const { m, d, ids, tpl } = s;
  try {
    const b1 = m.call('app', 'block.insert', { pageId: ids[1], afterBlockId: '', type: 'todo' }).blockId;
    m.call('app', 'block.update', { pageId: ids[1], blockId: b1, patch: { text: '倉庫の鍵を返す' } });
    m.close();
    const call = callOn(m);
    const r = call('get_meeting', { id: ids[1] });
    assert.strictEqual(r.isError, false, r.text);
    const ll = linesOf(r.text);
    const rev = new sqlite.DatabaseSync(path.join(m.dataDir, 'natsu.db'), { readOnly: true });
    const n = rev.prepare('select rev from blocks where id = ?').get(ids[1]).rev;
    rev.close();
    assert.deepStrictEqual(ll.slice(0, 5), [F.NOTICE, '# 行 1', '- 場所: 案件', `- 版: r${n}`, `- ID: ${ids[1]}`]);
    assert.ok(ll.includes('## 行') && ll.includes('- 行 1｜区分: 社内｜金額: 2'), r.text);
    assert.ok(ll.includes('## 本文') && ll.some((l) => l.startsWith('- [ ] 倉庫の鍵を返す')), r.text);
    for (const l of ll.slice(1)) assert.ok(/^(# |## |- )/.test(l), `形の崩れた行: ${l}`);
    // 読めない行
    for (const [what, id] of [['テンプレートの行', tpl], ['ゴミ箱の行', ids[11]], ['無い行', 'rnone1']]) {
      assert.deepStrictEqual(((x) => [x.isError, x.code])(call('get_meeting', { id })), [true, 'not-found'], what);
    }
    // 行は一覧・箇所の検索・ToDo の一覧に出ない
    assert.ok(!call('list_meetings', { limit: 100 }).text.includes(ids[1]));
    assert.ok(!call('search_passages', { query: '倉庫の鍵' }).text.includes(ids[1]));
    assert.ok(!call('list_action_items').text.includes('倉庫の鍵'));
    m.call('app', 'page.delete', { id: d });
    m.close();
    assert.deepStrictEqual(((x) => [x.isError, x.code])(call('get_meeting', { id: ids[1] })), [true, 'not-found'], 'ゴミ箱のデータベースの行を読んだ');
  } finally { m.done(); }
});
