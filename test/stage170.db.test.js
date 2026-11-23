/*
 * stage170.db.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の DB の命令と Claude（MCP）の答え。
 *  IG-2: page.setIcon が ic:<名前> の値を受ける・page.put（要約の書き戻し）が ic: の値を消さない・ic: の字が MCP の答えと文字の写しと記録に出ない
 * 一時の DB（helpers/dbtmp・helpers/mcpdb）。題名は作った物で、実在の人名・社名は使わない。
 */
'use strict';
// MCP の答えの時刻は PC の時計の時刻なので、このテストの中だけ UTC にする（どの OS でも同じ答え）
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert');
const sqlite = require('node:sqlite');
const { MessageChannel } = require('node:worker_threads');
const { tmpDb, tmpData, electronShape, samplePage } = require('./helpers/dbtmp');
const { mcpDb, withoutCt4 } = require('./helpers/mcpdb');
const core = require('../src/db/core');
const tools = require('../src/mcp/tools');
const { blocksMarkdown } = require('../src/blockEdit');

let clock = Date.parse('2026-11-14T01:00:00.000Z');
const now = () => new Date(clock);
const tick = () => { clock += 60000; return new Date(clock).toISOString(); };
let n = 0;
const txOf = (role) => `${role[0]}:s170-${String(++n).padStart(6, '0')}`;
const call = (db, cmd, args, role = 'app', tx = txOf(role)) => ({ ...core.call(db, { role, cmd, args, tx }, { now, labels: {} }), tx });
const ok = (r, what) => { assert.strictEqual(r.ok, true, `${what}: ${r.code}`); return r; };
const T = { timeout: 30000 };
const rowOf = (db, id) => db.prepare('select id, parent_id, ord, rev, trashed_at, attrs from blocks where id = ?').get(id);
const attrsOf = (db, id) => JSON.parse(rowOf(db, id).attrs);
const listOf = (db) => call(db, 'pages.list', {}).result;
const oplogN = (db) => db.prepare('select count(*) as c from oplog').get().c;
const opsOf = (db, tx) => JSON.parse(db.prepare('select ops from oplog where tx = ?').get(tx).ops);
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
function withDb(fn) {
  const t = tmpDb();
  try {
    const { db } = t.open();
    for (const [i, id] of ['pa1', 'pa2'].entries()) {
      const { page, segments } = pageOf(id, { title: `会議${i + 1}`, createdAt: `2026-11-1${i}T00:00:00.000Z` });   // 利用者が付け直した題名（D77）
      t.seed(page, segments);
    }
    return fn(db, t);
  } finally { t.done(); }
}
const create = (db, parentId) => { tick(); const r = call(db, 'page.create', parentId ? { parentId } : {}); assert.strictEqual(r.ok, true, `page.create ${r.code}`); return r.result.id; };

// ---------------------------------------------------------------- IG-2
test('IG-2・F179: page.setIcon は ic:<名前>（表にある絵）を書ける・表に無い名前と飾りだけの絵と形の悪い値は bad-args（何も書かない）・同じ値は書かない・pages.list の行の icon が ic:mic・絵文字も今どおり', T, () => withDb((db) => {
  const P = create(db);
  const r = ok(call(db, 'page.setIcon', { id: P, icon: 'ic:mic' }), 'page.setIcon');
  assert.strictEqual(r.result.icon, 'ic:mic', '答えのページに icon が無い');
  assert.strictEqual(attrsOf(db, P).icon, 'ic:mic');
  assert.strictEqual(listOf(db).find((p) => p.id === P).icon, 'ic:mic', 'pages.list の行の icon');
  // 同じ値は書かない（操作の空の行だけ）
  const was = dump(db);
  const n0 = oplogN(db);
  tick();
  const same = ok(call(db, 'page.setIcon', { id: P, icon: 'ic:mic' }), '同じ値');
  assert.deepStrictEqual([opsOf(db, same.tx), oplogN(db) - n0], [[], 1], '同じアイコンなのに書いた');
  assert.deepStrictEqual(dump(db), was);
  // 表に無い名前・飾りだけの絵・形の悪い値・持ち物の名前は断る（何も書かない）
  for (const icon of ['ic:notaname', 'ic:settings', 'ic:delete', 'ic:library_books', 'ic:MIC', 'ic:mic ', 'ic:__proto__', 'ic:constructor', `ic:${'a'.repeat(41)}`, 'ic:‮mic', 'dg:mic', 'ic:']) {
    tick();
    assert.strictEqual(call(db, 'page.setIcon', { id: P, icon }).code, 'bad-args', icon);
  }
  assert.deepStrictEqual(dump(db), was, '断ったのに書いた');
  // 絵文字は今どおり・ic: に戻せる・外せる
  ok(call(db, 'page.setIcon', { id: P, icon: '🚀' }), '絵文字');
  assert.strictEqual(attrsOf(db, P).icon, '🚀');
  ok(call(db, 'page.setIcon', { id: P, icon: 'ic:certification_with_seal' }), 'デジタル庁の絵');
  assert.strictEqual(listOf(db).find((p) => p.id === P).icon, 'ic:certification_with_seal');
  ok(call(db, 'page.setIcon', { id: 'pa1', icon: 'ic:groups' }), '議事録にも付く');
  assert.strictEqual(listOf(db).find((p) => p.id === 'pa1').icon, 'ic:groups');
  ok(call(db, 'page.setIcon', { id: P, icon: '' }), '外す');
  assert.ok(!Object.hasOwn(attrsOf(db, P), 'icon'), '外しても欄が残る');
}));

test('IG-2・F179: page.put（要約の書き戻し）は ic: の値を消さない（P3）', T, () => withDb((db) => {
  ok(call(db, 'page.setIcon', { id: 'pa1', icon: 'ic:mic' }), 'page.setIcon');
  const p = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
  assert.strictEqual(p.icon, 'ic:mic', 'page.get に icon が無い');
  const { icon: _drop, ...noIcon } = p;
  ok(call(db, 'page.put', { page: { ...noIcon, title: '書き戻した題' }, baseRev: p.rev }, 'main'), 'page.put');   // 利用者が付け直した題名（D77）
  assert.strictEqual(attrsOf(db, 'pa1').icon, 'ic:mic', '書き戻しで ic: の値が消えた');
  assert.strictEqual(listOf(db).find((x) => x.id === 'pa1').icon, 'ic:mic');
}));

// 外に出ない: MCP の6つの道具の答え・blocksMarkdown（文字の写し）・記録
test('IG-2・F179: 外に出ない（ic:mic を付けたページを MCP の6つの道具で読んでも ic: の字が無く、答えは付ける前と1文字も同じ・文字の写しの子ページの行は「📄 題名」のまま）', T, () => {
  const m = mcpDb({ only: ['plain1', 'plain2'] });
  try {
    const top = m.call('app', 'page.create', {}).id;
    m.call('app', 'page.setTitle', { id: top, title: '計画の親' });   // 白紙のページの題名（会議の題名でないので日付の形にしない: D77 の外）
    const p1 = m.call('app', 'block.insert', { pageId: top, afterBlockId: '', type: 'paragraph' }).blockId;
    m.call('app', 'block.update', { pageId: top, blockId: p1, patch: { text: '段取り表の下書きを書く' } });
    const kid = m.call('app', 'page.create', { parentId: top }).id;
    m.call('app', 'page.setTitle', { id: kid, title: '中のページ' });   // 白紙のページの題名（会議の題名でないので日付の形にしない: D77 の外）
    const NOW = () => new Date('2026-11-14T03:00:00.000Z');
    const ask = () => {
      // 0.18.0 CT-4（計画 docs/plans/2026-11-18-180.md の決めたこと 40・45）で意図して直した: アイコンを付けると版（rev）は上がるので、足した「- 版」「｜印」を外して比べる
      const c = (name, args = {}) => withoutCt4(tools.callTool(name, args, { sqlite, dataDir: m.dataDir, now: NOW }).text);
      const ids = Object.values(m.ids);
      return [c('list_meetings'), c('get_meeting', { id: top }), c('get_meeting', { id: kid }), c('get_meeting', { id: ids[0] }), c('get_meetings', { ids: [top, ids[1]] }),
        c('search_passages', { query: '段取り表' }), c('list_action_items')];
    };
    m.close();
    const before = ask();
    for (const [id, icon] of [[top, 'ic:mic'], [kid, 'ic:table_chart'], [Object.values(m.ids)[0], 'ic:certification_with_seal']]) m.call('app', 'page.setIcon', { id, icon });
    const got = m.call('app', 'page.get', { id: top }).page;
    assert.strictEqual(got.icon, 'ic:mic', '前提: アイコンが保存されていない');
    // 文字の写し（Markdown）の子ページの行は決まった「📄 題名」（ページのアイコンを写さない: 決めたこと 22）
    const md = blocksMarkdown(got.blocks, 0, { base: 0, title: () => '中のページ' });
    assert.ok(md.includes('📄 中のページ'), md);
    assert.ok(!md.includes('ic:'), md);
    m.close();
    const after = ask();
    for (const t of after) for (const w of ['ic:', 'mic', 'table_chart', 'certification']) assert.ok(!t.includes(w), `${w}: ${t}`);
    assert.deepStrictEqual(after, before, 'アイコンで答えが変わった');
  } finally { m.done(); }
});

test('IG-2・F179: 記録（engine.log に行く DB のプロセスの記録の行）にアイコンの値を書かない（書けた頼み・断った頼みのどちらも）', T, async () => {
  const d = tmpData({ pages: 1 });
  const fromServer = [];
  const parent = electronShape.parent((msg) => fromServer.push(msg));
  require('../src/db/server').startServer({ parentPort: parent, sqlite });
  parent.emit({ type: 'init', dataDir: d.dataDir, labels: {}, network: false });
  const ch = new MessageChannel();
  parent.emit({ type: 'port', role: 'app' }, [electronShape.port(ch.port1)]);
  const app = electronShape.client(ch.port2);
  const wait = async (pred, what) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > 5000) throw new Error(`待ちきれない: ${what}`); await new Promise((res) => setTimeout(res, 10)); } };
  try {
    await wait(() => fromServer.some((x) => x.type === 'ready'), 'ready');
    const a = await app.ask({ id: 1, cmd: 'page.setIcon', args: { id: d.ids[0], icon: 'ic:mic' }, tx: 'a:s170-log-01' });
    assert.strictEqual(a.ok, true, a.code);
    const b = await app.ask({ id: 2, cmd: 'page.setIcon', args: { id: d.ids[0], icon: 'ic:notaname' }, tx: 'a:s170-log-02' });
    assert.strictEqual(b.code, 'bad-args');
    await new Promise((res) => setTimeout(res, 50));
    const logs = fromServer.filter((x) => x.type === 'log').map((x) => x.line);
    for (const l of logs) assert.ok(!/ic:|notaname/.test(l), `記録にアイコンの値: ${l}`);
  } finally {
    parent.emit({ type: 'close' });
    await wait(() => fromServer.some((x) => x.type === 'closed'), 'closed').catch(() => {});
    app.close();
    d.done();
  }
});

// ---------------------------------------------------------------- PD-1（決めたこと 31〜34・F187・F188）
const PT = require('../src/pageTree');
const fs = require('node:fs');
const path = require('node:path');
const { applyOps } = require('../src/db/ops');
const para = (id, o = {}) => ({ id, type: 'paragraph', text: '', ...o });
test('PD-1・F187: isEmptyBlank の表（行なし・空のテキストの行だけは真。文字のある行・区切り線・子ページの行・ToDo・飾りのある空の行・子のある空の行・メモ・ゴミ箱の子だけ・議事録・行のページは偽。題名・アイコン・見た目は数えない）', () => {
  const B = (blocks, o = {}) => ({ kind: 'blank', blocks, memo: '', ...o });
  for (const [p, kid, why] of [
    [B([]), false, '行なし'], [B(undefined), false, '本文の欄が無い'], [B([para('b1')]), false, '空のテキストの行'], [B([para('b1'), para('b2')]), false, '空のテキストの行2つ'],
    [B([para('b1')], { title: '題名あり', icon: 'ic:star', look: { wide: true, font: 'mono' } }), false, '題名・アイコン・見た目は数えない'],   // 白紙のページの題名（D77 の外）
  ]) assert.strictEqual(PT.isEmptyBlank(p, kid), true, why);
  for (const [p, kid, why] of [
    [B([para('b1', { text: 'あ' })]), false, '文字のある行'], [B([para('b1', { text: ' ' })]), false, '空白だけの行'], [B([{ id: 'b1', type: 'divider', text: '' }]), false, '区切り線'],
    [B([{ id: 'b1', type: 'subpage', text: '', page: 'p1' }]), false, '子ページの行'], [B([{ id: 'b1', type: 'todo', text: '' }]), false, 'ToDo'],
    [B([para('b1', { color: 'red' })]), false, '色のある空の行'], [B([para('b1', { rich: [{ s: 0, e: 0, m: 'b' }] })]), false, '飾りのある空の行'],
    [B([para('b1', { children: [para('b2')] })]), false, '子のある空の行'], [B([], { memo: 'メモ' }), false, 'メモ'],
    [B([], { memoDoc: [{ id: 'm1', type: 'paragraph', text: 'メモ' }] }), false, 'メモの行'],
    [B([]), true, 'ゴミ箱の子（子がある）'], [{ blocks: [], memo: '' }, false, '議事録'], [{ kind: 'row', blocks: [], memo: '' }, false, '行のページ'],
    [{ kind: 'database', blocks: [], memo: '' }, false, 'データベース'], [null, false, '無い'],
  ]) assert.strictEqual(PT.isEmptyBlank(p, kid), false, why);
});

// 白紙のページ（題名・見た目・アイコン・空のテキストの行）を作る → { P }
function blankWith(db, { title = '下書きの表', icon = 'ic:star', parentId } = {}) {
  const P = create(db, parentId);
  ok(call(db, 'page.setTitle', { id: P, title }), 'page.setTitle');   // 白紙のページの題名（D77 の外）
  ok(call(db, 'page.setLook', { id: P, look: { wide: true } }), 'page.setLook');
  if (icon) ok(call(db, 'page.setIcon', { id: P, icon }), 'page.setIcon');
  ok(call(db, 'block.insert', { pageId: P, afterBlockId: '', type: 'paragraph' }), 'block.insert');   // 手引きを押してできる空のテキストの行
  return P;
}
const toDb = (db, id, tx) => { tick(); return call(db, 'page.toDb', { id }, 'app', tx); };
const rowCols = (db, id) => db.prepare('select id, parent_id, ord, text, created_at from blocks where id = ?').get(id);

test('PD-1・F187: page.toDb（同じ ID・親・並びの鍵・題名・見た目のまま kind database。列とビューと次の番号は db.create と同じ・空のテキストの行は消える・アイコンは外れ前の値は oplog に。断る場合は bad-args で何も変えない・送り直しは1回だけ効く）', T, () => withDb((db, t) => {
  const P = blankWith(db);
  const before = rowCols(db, P);
  const was = attrsOf(db, P);
  assert.strictEqual(was.icon, 'ic:star');
  const r = ok(toDb(db, P, 'a:s170-todb-1'), 'page.toDb');
  assert.strictEqual(r.result.id, P);
  assert.strictEqual(r.result.page.kind, 'database');
  assert.deepStrictEqual({ ...rowCols(db, P) }, { ...before }, 'ID・親・並びの鍵・題名・作った日時が変わった');
  const now = attrsOf(db, P);
  assert.strictEqual(now.kind, 'database');
  assert.ok(!Object.hasOwn(now, 'icon'), 'アイコンが外れない（RQ2）');
  assert.deepStrictEqual(now.look, { wide: true }, '見た目が消えた');
  const fresh = ok(call(db, 'db.create', {}), 'db.create').result.page;
  assert.deepStrictEqual([now.cols, now.views, now.nextNo], [fresh.cols, fresh.views, fresh.nextNo], '列・ビュー・次の番号が db.create と違う');
  assert.ok(ok(call(db, 'db.get', { id: P }), 'db.get').result, 'db.get で読めない');
  assert.deepStrictEqual(ok(call(db, 'db.view', { id: P, viewId: 'v1', from: 0, count: 50 }), 'db.view').result.rows, []);
  assert.strictEqual(db.prepare('select count(*) c from blocks where page_id = ? and id <> ?').get(P, P).c, 0, '空のテキストの行が残る');
  assert.strictEqual(listOf(db).find((p) => p.id === P).kind, 'database');
  // oplog の1行で、前の値を持つ
  const ops = opsOf(db, 'a:s170-todb-1');
  assert.strictEqual(db.prepare("select count(*) c from oplog where tx = 'a:s170-todb-1'").get().c, 1);
  assert.deepStrictEqual(ops.filter((o) => o.op === 'set' && o.key === 'icon').map((o) => [o.value, o.old]), [[undefined, 'ic:star']], 'アイコンの前の値が無い');
  assert.ok(ops.some((o) => o.op === 'set' && o.key === 'kind' && o.old === 'blank' && o.value === 'database'), '種類の前の値が無い');
  assert.ok(ops.some((o) => o.op === 'trash' && o.old && o.old.type === 'paragraph'), '空のテキストの行の前の値が無い');
  // 送り直し（同じ tx）は1回だけ効く
  const n0 = oplogN(db); const d0 = dump(db);
  const again = toDb(db, P, 'a:s170-todb-1');
  assert.ok(again.ok, again.code);
  assert.deepStrictEqual([oplogN(db), dump(db)], [n0, d0], '送り直しでもう一度書いた');
  // 断る（何も変えない）
  const text = blankWith(db, { icon: '' });
  const tb = call(db, 'page.get', { id: text }).result.page.blocks[0].id;
  ok(call(db, 'block.update', { pageId: text, blockId: tb, patch: { text: '本文' } }), 'block.update');
  const kidP = blankWith(db, { icon: '' }); create(db, kidP);
  const trashKid = blankWith(db, { icon: '' }); const tk = create(db, trashKid); ok(call(db, 'page.delete', { id: tk }), 'page.delete');
  const memoP = blankWith(db, { icon: '' }); ok(call(db, 'page.setMemo', { id: memoP, memo: 'メモ' }), 'page.setMemo');
  const gone = blankWith(db, { icon: '' }); ok(call(db, 'page.delete', { id: gone }), 'page.delete');
  const d = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const row = ok(call(db, 'row.add', { db: d, title: '行' }), 'row.add').result.id;   // データベースの行の題名（D77 の外）
  const inRow = create(db, row);   // 行の本文の /ページ（親がデータベースの行）
  call(db, 'meeting.begin', { pageId: 'plive9', startedAt: Date.parse('2026-11-14T00:00:00.000Z'), localOnly: false }, 'main');
  // 録音中の印の付いた空の白紙のページ（命令では作れない形。録音中の写しを種類だけで見分けていないかを見る）
  t.seed({ id: 'plive8', title: '', kind: 'blank', date: '2026-11-14', memo: '', blocks: [], meeting: { phase: 'recording' }, createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z' }, []);
  const snap = dump(db); const n1 = oplogN(db);
  for (const [id, why] of [[text, '文字のある行'], [kidP, '子ページ'], [trashKid, 'ゴミ箱の子だけ'], [memoP, 'メモ'], [gone, 'ゴミ箱'], ['pa1', '議事録'], [row, '行のページ'],
    [inRow, '親がデータベースの行'], ['plive9', '録音中の写し'], ['plive8', '録音中の印の白紙のページ'], [d, 'データベース'], ['pnone', '無い']]) {
    assert.strictEqual(toDb(db, id).code, 'bad-args', why);
  }
  assert.deepStrictEqual(dump(db), snap, '断ったのに書いた');
  assert.strictEqual(oplogN(db), n1, '断ったのに操作の行を積んだ');
  // 役は app だけ
  assert.deepStrictEqual(core.COMMANDS['page.toDb'].roles, ['app']);
  assert.strictEqual(call(db, 'page.toDb', { id: kidP }, 'main').code, 'forbidden');
}));

test('PD-1・F188: 親の本文の子ページの行は残る（inline は付かない）・サイドバーの木の所（親と並び）が変わらない', T, () => withDb((db) => {
  const top = blankWith(db, { icon: '' });
  const K = blankWith(db, { parentId: top, icon: '' });
  const subOf = () => call(db, 'page.get', { id: top }).result.page.blocks.filter((b) => b.type === 'subpage' && b.page === K);
  const sub0 = subOf();
  assert.strictEqual(sub0.length, 1, '前提: 親の本文に子ページの行が無い');
  const tree0 = PT.pageTree(listOf(db));
  const place0 = [tree0.parent.get(K), (tree0.kids.get(top) || []).indexOf(K)];
  ok(toDb(db, K), 'page.toDb');
  assert.deepStrictEqual(subOf(), sub0, '親の本文の子ページの行が変わった');
  assert.ok(!subOf()[0].inline, 'inline が付いた');
  const tree1 = PT.pageTree(listOf(db));
  assert.deepStrictEqual([tree1.parent.get(K), (tree1.kids.get(top) || []).indexOf(K)], place0, '木の所が変わった');
}));

test('PD-1・F188: Ctrl+Z（edit.revert の歩み）で白紙のページに戻る（空のテキストの行と外したアイコンも）・やり直しでまたデータベース・列を足した後はその列が先に戻る・行を1つ足した（ゴミ箱に入れた）後は戻さず断る', T, () => withDb((db) => {
  const revert = (id, tx) => { tick(); return call(db, 'edit.revert', { pageId: id, steps: [tx] }); };
  const P = blankWith(db);
  const was = call(db, 'page.get', { id: P }).result.page;
  ok(toDb(db, P, 'a:s170-undo-1'), 'page.toDb');
  const back = ok(revert(P, 'a:s170-undo-1'), 'edit.revert');
  const now = call(db, 'page.get', { id: P }).result.page;
  assert.strictEqual(now.kind, 'blank');
  assert.strictEqual(now.icon, 'ic:star', 'アイコンが戻らない');
  assert.deepStrictEqual(now.blocks.map((b) => [b.id, b.type, b.text]), was.blocks.map((b) => [b.id, b.type, b.text]), '空のテキストの行が戻らない');
  assert.ok(!Object.hasOwn(attrsOf(db, P), 'cols') && !Object.hasOwn(attrsOf(db, P), 'views') && !Object.hasOwn(attrsOf(db, P), 'nextNo'), '列・ビューが残る');
  assert.strictEqual(listOf(db).find((p) => p.id === P).kind, 'blank');
  // やり直し（戻した edit.revert をもう一度戻す）
  ok(revert(P, back.tx), 'やり直し');
  assert.strictEqual(attrsOf(db, P).kind, 'database');
  assert.ok(!Object.hasOwn(attrsOf(db, P), 'icon'));
  // 列を足した後: 列が先に戻り、そのあと白紙のページへ
  const Q = blankWith(db, { icon: '' });
  ok(toDb(db, Q, 'a:s170-undo-2'), 'page.toDb');
  const ca = ok(call(db, 'col.add', { db: Q, type: 'text', name: 'メモ' }), 'col.add');
  assert.strictEqual(revert(Q, 'a:s170-undo-2').code, 'stale', '列が残っているのに白紙のページに戻した');
  ok(revert(Q, ca.tx), '列の戻し');
  ok(revert(Q, 'a:s170-undo-2'), '列を戻した後に白紙のページへ');
  assert.strictEqual(attrsOf(db, Q).kind, 'blank');
  // 行を1つ足してゴミ箱に入れた後は、戻さず断る（行を見えなくしない）
  const R = blankWith(db, { icon: '' });
  ok(toDb(db, R, 'a:s170-undo-3'), 'page.toDb');
  const rid = ok(call(db, 'row.add', { db: R, title: '行' }), 'row.add').result.id;   // データベースの行の題名（D77 の外）
  ok(call(db, 'rows.trash', { db: R, ids: [rid] }), 'rows.trash');
  const snap = dump(db);
  assert.strictEqual(revert(R, 'a:s170-undo-3').code, 'has-rows', '行があるのに白紙のページに戻した（行で断った答えは has-rows: rv58 軽い 1）');
  assert.deepStrictEqual(dump(db), snap);
  assert.ok(require('../src/undoBook').UNDO_CMDS.has('page.toDb'), 'UNDO_CMDS に page.toDb が無い');
}));

test('PD-1・F188（rv58 軽い 1）: データベースから白紙のページへ戻せない答えは、行があるときだけ has-rows。ほかの理由（後で列を足した・アイコンを選び直した）は今の stale のまま', T, () => withDb((db) => {
  const revert = (id, tx) => { tick(); return call(db, 'edit.revert', { pageId: id, steps: [tx] }); };
  const P = blankWith(db, { icon: 'ic:star' });
  ok(toDb(db, P, 'a:s170-why-1'), 'page.toDb');
  ok(call(db, 'col.add', { db: P, type: 'text', name: 'メモ' }), 'col.add');
  assert.strictEqual(revert(P, 'a:s170-why-1').code, 'stale', '列が残るときの答え');
  const Q = blankWith(db, { icon: 'ic:star' });
  ok(toDb(db, Q, 'a:s170-why-2'), 'page.toDb');
  ok(call(db, 'page.setIcon', { id: Q, icon: 'ic:mic' }), 'page.setIcon');   // データベースにした後にアイコンを選び直した
  assert.strictEqual(revert(Q, 'a:s170-why-2').code, 'stale', 'アイコンを選び直したときの答え');
  ok(call(db, 'row.add', { db: Q, title: '行' }), 'row.add');   // データベースの行の題名（D77 の外）
  assert.strictEqual(revert(Q, 'a:s170-why-2').code, 'has-rows', '行があれば、ほかの理由より先に has-rows');
}));

test('PD-1・F188（rv58 重要 2）: やり直し（白紙のページに戻した歩みをもう一度戻す）も page.toDb と同じ照らし。本文に文・子のページ（ゴミ箱の子も）・メモがあれば stale で何も変えない。空のままならデータベースに戻る', T, () => withDb((db) => {
  const revert = (id, tx) => { tick(); return call(db, 'edit.revert', { pageId: id, steps: [tx] }); };
  const cycle = (tag) => {
    const P = blankWith(db, { icon: '' });
    ok(toDb(db, P, `a:s170-redo-${tag}`), 'page.toDb');
    return { P, back: ok(revert(P, `a:s170-redo-${tag}`), 'edit.revert').tx };
  };
  // 本文に文（戻した空のテキストの行はそのままで、その下の新しい行に書いた）
  const a = cycle('a');
  const ab = call(db, 'page.get', { id: a.P }).result.page.blocks[0].id;
  ok(call(db, 'block.insert', { pageId: a.P, afterBlockId: ab, type: 'paragraph' }), 'block.insert');
  const nb = call(db, 'page.get', { id: a.P }).result.page.blocks.find((x) => x.id !== ab).id;
  ok(call(db, 'block.update', { pageId: a.P, blockId: nb, patch: { text: '大事なメモ' } }), 'block.update');
  // 子のページ（生きている子）・ゴミ箱の子だけ・メモ
  const b = cycle('b'); create(db, b.P);
  const c = cycle('c'); ok(call(db, 'page.delete', { id: create(db, c.P) }), 'page.delete');
  const m = cycle('m'); ok(call(db, 'page.setMemo', { id: m.P, memo: 'メモ' }), 'page.setMemo');
  const snap = dump(db); const n0 = oplogN(db);
  for (const [x, why] of [[a, '本文に文'], [b, '子のページ'], [c, 'ゴミ箱の子だけ'], [m, 'メモ']]) {
    assert.strictEqual(revert(x.P, x.back).code, 'stale', `${why}があるのにやり直しでデータベースにした`);
  }
  assert.deepStrictEqual(dump(db), snap, '断ったのに書いた');
  assert.strictEqual(oplogN(db), n0, '断ったのに操作の行を積んだ');
  for (const x of [a, b, c, m]) assert.strictEqual(attrsOf(db, x.P).kind, 'blank');
  // 空のままならやり直せる
  const e = cycle('e');
  ok(revert(e.P, e.back), 'やり直し');
  assert.strictEqual(attrsOf(db, e.P).kind, 'database');
}));

test('PD-1・F188（rv58 重要 3・rv59 軽い 1）: データベースから白紙のページへ戻す前に、ほかの所からの指し（データベースのリレーションの列（消した列も・ゴミ箱のデータベースも）の相手・リンクドビューの行（消した行も））があれば stale で何も変えない。指しが無くなれば戻る。壊れた attrs の行があっても internal にならない', T, () => withDb((db) => {
  const revert = (id, tx) => { tick(); return call(db, 'edit.revert', { pageId: id, steps: [tx] }); };
  // ほかのデータベースのリレーションの列（片側）の相手
  const P = blankWith(db, { icon: '' });
  ok(toDb(db, P, 'a:s170-ptr-1'), 'page.toDb');
  const O = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const col = ok(call(db, 'col.add', { db: O, type: 'rel', target: P }), 'col.add').result.col.id;
  let snap = dump(db); let n0 = oplogN(db);
  assert.strictEqual(revert(P, 'a:s170-ptr-1').code, 'stale', 'リレーションの列の相手なのに白紙のページに戻した');
  assert.deepStrictEqual([dump(db), oplogN(db)], [snap, n0], '断ったのに書いた');
  ok(call(db, 'col.remove', { db: O, col }), 'col.remove');   // 消した列は戻せる（col.restore）ので、まだ指している
  assert.strictEqual(revert(P, 'a:s170-ptr-1').code, 'stale', '消した（戻せる）リレーションの列の相手なのに戻した');
  ok(call(db, 'col.purge', { db: O, col }), 'col.purge');
  ok(revert(P, 'a:s170-ptr-1'), '列を完全に消した後');
  assert.strictEqual(attrsOf(db, P).kind, 'blank');
  // rv59 軽い 1: ゴミ箱のデータベースの列も数える（ゴミ箱から戻すと、その列が白紙のページを指す）
  const Q = blankWith(db, { icon: '' });
  ok(toDb(db, Q, 'a:s170-ptr-2'), 'page.toDb');
  const O2 = ok(call(db, 'db.create', {}), 'db.create').result.id;
  ok(call(db, 'col.add', { db: O2, type: 'rel', target: Q }), 'col.add');
  ok(call(db, 'page.delete', { id: O2 }), 'page.delete');
  assert.strictEqual(revert(Q, 'a:s170-ptr-2').code, 'stale', 'ゴミ箱のデータベースの列の相手なのに白紙のページに戻した');
  // 壊れた attrs の行（ページ・リンクドビューの行）があっても、問い合わせごと投げない（Ctrl+Z を internal にしない）
  const R2 = blankWith(db, { icon: '' });
  ok(toDb(db, R2, 'a:s170-ptr-4'), 'page.toDb');
  const brokenView = blankWith(db, { icon: '' });
  db.prepare("insert into blocks(id, type, page_id, parent_id, ord, text, attrs, rev, created_at, updated_at) values ('bbroken01', 'dbview', ?, null, 'z', '', '{', 1, '', '')").run(brokenView);
  const o2Attrs = rowOf(db, O2).attrs;
  db.prepare("update blocks set attrs = '{\"rel\":' where id = ?").run(O2);
  ok(revert(R2, 'a:s170-ptr-4'), '壊れた attrs の行で戻せない');
  db.prepare('delete from blocks where id = ?').run('bbroken01');
  db.prepare('update blocks set attrs = ? where id = ?').run(o2Attrs, O2);
  // ほかの白紙のページのリンクドビューの行
  const S = blankWith(db, { icon: '' });
  ok(toDb(db, S, 'a:s170-ptr-3'), 'page.toDb');
  const host = blankWith(db, { icon: '' });
  ok(call(db, 'block.insertDbView', { pageId: host, afterId: '', db: S }), 'block.insertDbView');
  const vid = call(db, 'page.get', { id: host }).result.page.blocks.find((x) => x.type === 'dbview').id;
  snap = dump(db); n0 = oplogN(db);
  assert.strictEqual(revert(S, 'a:s170-ptr-3').code, 'stale', 'リンクドビューが指しているのに白紙のページに戻した');
  assert.deepStrictEqual([dump(db), oplogN(db)], [snap, n0], '断ったのに書いた');
  // ページごとゴミ箱に入れたリンクドビューの行も数える（ページを戻すと、白紙のページを指すビューが残る）
  ok(call(db, 'page.delete', { id: host }), 'page.delete');
  assert.strictEqual(revert(S, 'a:s170-ptr-3').code, 'stale', 'ゴミ箱のページのリンクドビューが指しているのに戻した');
  ok(call(db, 'page.restore', { id: host }), 'page.restore');
  // rv59 軽い 1: 消したリンクドビューの行（block.remove は行を消し、行は oplog だけにある）は戻せるが、その後でホストのページの Ctrl+Z で
  // データベースでないページを指すビューの行を足し直さない（stale）
  const rm = ok(call(db, 'block.remove', { pageId: host, blockId: vid }), 'block.remove');
  ok(revert(S, 'a:s170-ptr-3'), 'リンクドビューの行が無くなった後');
  assert.strictEqual(attrsOf(db, S).kind, 'blank');
  snap = dump(db); n0 = oplogN(db);
  assert.strictEqual(revert(host, rm.tx).code, 'stale', 'データベースでないページを指すリンクドビューの行を Ctrl+Z で戻した');
  assert.deepStrictEqual([dump(db), oplogN(db)], [snap, n0], '断ったのに書いた');
}));

test('PD-1: T4b（控えに後の oplog（page.toDb・edit.revert・やり直しを含む）を前へ当て直すと今の表と同じ）', T, async () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const P = blankWith(db);
    const to = path.join(t.dir, 'copy-170.db');
    await sqlite.backup(db, to);
    const copy = new sqlite.DatabaseSync(to);
    try {
      const k = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
      ok(toDb(db, P, 'a:s170-t4b-1'), 'page.toDb');
      tick(); const b1 = ok(call(db, 'edit.revert', { pageId: P, steps: ['a:s170-t4b-1'] }), 'edit.revert');
      tick(); ok(call(db, 'edit.revert', { pageId: P, steps: [b1.tx] }), 'やり直し');
      const rows = db.prepare('select ops from oplog where seq > ? order by seq').all(k).map((r) => JSON.parse(r.ops));
      for (const o of rows) applyOps(copy, o, 'forward');
      assert.deepStrictEqual(dump(copy), dump(db));
    } finally { copy.close(); }
  } finally { t.done(); }
});

// ---------------------------------------------------------------- SV-1
const viewsIn = (db, id) => { const e = listOf(db).find((p) => p.id === id); return e ? e.views : null; };
const dbMake = (db, title) => { tick(); const d = ok(call(db, 'db.create', {}), 'db.create').result.id; ok(call(db, 'page.setTitle', { id: d, title }), 'page.setTitle'); return d; };   // データベースの題名（D77 の外）

test('SV-1・F191: pages.list のデータベースの行に views（並び・名前・種類）・ほかの行は1字も同じ・ビューを足す／名前を変える／消す／並べ替える／種類を変えた後の一覧に効く・ゴミ箱のデータベースは今どおり出ない', T, () => withDb((db, t) => {
  const d = dbMake(db, '案件');
  const P = blankWith(db, { icon: '' });
  // 白紙のページに迷い込んだ views の欄（命令では作れない形）があっても、データベースでない行には views を付けない
  t.seed({ id: 'pstray', title: '', kind: 'blank', date: '2026-11-14', memo: '', blocks: [], views: [{ id: 'v1', name: '迷子', layout: 'table' }], createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z' }, []);
  const others = () => listOf(db).filter((p) => p.id !== d).map((p) => structuredClone(p));
  const before = others();
  for (const p of before) assert.ok(!Object.hasOwn(p, 'views'), `${p.id}: データベースでない行に views`);
  assert.deepStrictEqual(viewsIn(db, d), [{ id: 'v1', name: '表', type: 'table' }]);
  // 足す・名前を変える・種類を変える・並べ替える・消す
  tick(); const v2 = ok(call(db, 'view.add', { db: d, layout: 'list', name: '一覧' }), 'view.add').result.view.id;
  assert.deepStrictEqual(viewsIn(db, d), [{ id: 'v1', name: '表', type: 'table' }, { id: v2, name: '一覧', type: 'list' }], '足したビューが一覧に無い');
  tick(); ok(call(db, 'view.update', { db: d, viewId: 'v1', patch: { name: '全部' } }), 'view.update');
  assert.deepStrictEqual(viewsIn(db, d).map((v) => v.name), ['全部', '一覧'], '名前を変えても一覧が古い');
  tick(); ok(call(db, 'view.update', { db: d, viewId: v2, patch: { layout: 'table' } }), 'view.update');
  assert.deepStrictEqual(viewsIn(db, d).map((v) => v.type), ['table', 'table'], '種類を変えても一覧が古い');
  tick(); ok(call(db, 'view.move', { db: d, viewId: 'v1', after: v2 }), 'view.move');
  assert.deepStrictEqual(viewsIn(db, d).map((v) => v.id), [v2, 'v1'], '並べ替えても一覧が古い');
  tick(); ok(call(db, 'view.remove', { db: d, viewId: v2 }), 'view.remove');
  assert.deepStrictEqual(viewsIn(db, d), [{ id: 'v1', name: '全部', type: 'table' }], '消しても一覧が古い');
  // リンクドビュー（白紙のページの本文の行のビュー）は、データベースのビューの行に入れない
  tick(); const lb = ok(call(db, 'block.insertDbView', { pageId: P, afterId: '', db: d }), 'block.insertDbView').result.blockId;
  tick(); ok(call(db, 'view.add', { db: d, layout: 'list', name: 'つないだ側', linked: lb }), 'view.add linked');
  assert.deepStrictEqual(viewsIn(db, d).map((v) => v.name), ['全部'], 'リンクドビューのビューがデータベースの行に入った');
  // ほかの行は1字も同じ（データベースのビューを変えても）
  const P2 = others().find((p) => p.id === P);
  assert.deepStrictEqual(others().filter((p) => p.id !== P), before.filter((p) => p.id !== P), 'ほかの行が変わった');
  assert.ok(!Object.hasOwn(P2, 'views'));
  // ゴミ箱のデータベースは出ない・戻せば views ごと戻る
  tick(); ok(call(db, 'page.delete', { id: d }), 'page.delete');
  assert.strictEqual(viewsIn(db, d), null, 'ゴミ箱のデータベースが一覧に出た');
  tick(); ok(call(db, 'page.restore', { id: d }), 'page.restore');
  assert.deepStrictEqual(viewsIn(db, d), [{ id: 'v1', name: '全部', type: 'table' }]);
  // 20 まで・名前は1行（壊れた項目は飛ばす）
  const many = Array.from({ length: 23 }, (_, i) => ({ id: `v${i + 1}`, name: i === 0 ? '上\n下' : `ビュー${i + 1}`, layout: i % 2 ? 'list' : 'table' }));
  db.prepare('update blocks set attrs = json_set(attrs, \'$.views\', json(?)) where id = ?').run(JSON.stringify([{ name: 'ID が無い' }, ...many]), d);
  const vs = viewsIn(db, d);
  assert.strictEqual(vs.length, 20);
  assert.deepStrictEqual(vs[0], { id: 'v1', name: '上 下', type: 'table' });
  assert.deepStrictEqual(vs[19], { id: 'v20', name: 'ビュー20', type: 'list' });
}));

test('SV-1・F191: MCP の一覧と答えにビューの名前を出さない（ビューを足しても答えは1字も同じ）', T, () => {
  const m = mcpDb({ only: ['plain1'] });
  try {
    const d = m.call('app', 'db.create', {}).id;
    m.call('app', 'page.setTitle', { id: d, title: '案件' });   // データベースの題名（D77 の外）
    const NOW = () => new Date('2026-11-14T03:00:00.000Z');
    const ask = () => { const c = (name, args = {}) => tools.callTool(name, args, { sqlite, dataDir: m.dataDir, now: NOW }).text; return [c('list_meetings'), c('get_meeting', { id: d })]; };
    m.close();
    const before = ask();
    m.call('app', 'view.add', { db: d, layout: 'list', name: '見せない名前' });
    m.close();
    const after = ask();
    for (const x of after) assert.ok(!x.includes('見せない名前'), x);
    assert.deepStrictEqual(after, before);
  } finally { m.done(); }
});

test('SV-1・F190: 一覧の速さ（2,000 ページ・100 のデータベース。どれもビュー 20）が、ビューを読まない同じ一覧（同じ大きさの欄）の 1.1 倍以内で、データベースでない行には views を付けない', { timeout: 120000 }, (tc) => {
  const temps = [];
  try {
    // 同じ形の DB を作る。読む方（A）はデータベースのビューの欄が views、読まない方（B）は同じ中身を vx に置く（欄の大きさも中身も同じで、
    // ビューを読むかだけが違う）。R34: 前は1つの DB で欄の名前を替えながら（views ↔ vx）計っていたので、2つを1回ずつ交互に呼べなかった
    const build = (key) => {
      const t = tmpDb();
      temps.push(t);
      const { db } = t.open();
      const made = ok(call(db, 'db.create', {}), 'db.create').result;
      const fresh = made.page;
      const views = Array.from({ length: 20 }, (_, i) => ({ ...fresh.views[0], id: `v${i + 1}`, name: `ビュー${i + 1}` }));
      const dbAttrs = JSON.stringify({ kind: 'database', cols: fresh.cols, [key]: views, nextNo: 1, date: '2026-11-01' });
      const memo = 'メモ'.repeat(200);
      db.exec('BEGIN');
      const ins = db.prepare("insert into blocks(id,type,page_id,parent_id,ord,text,rich,attrs,fold,rev,created_at,updated_at,trashed_at) values (?,?,?,?,?,?,null,?,'',1,?,?,null)");
      const pid = (i) => `ps${String(i).padStart(5, '0')}`;
      for (let i = 0; i < 2000; i++) {
        const isDb = i % 20 === 0;
        // 議事録の 100 に、迷い込んだ views の欄（データベースでない行に views を付けないかを見る）
        ins.run(pid(i), 'page', pid(i), null, 'i', `題${i}`, isDb ? dbAttrs : JSON.stringify({ memo, date: '2026-11-01', meeting: { phase: 'done' }, ...(i % 20 === 1 ? { views } : {}) }),
          new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), '');
      }
      db.exec('COMMIT');
      return { db, made };
    };
    const A = build('views');
    const B = build('vx');
    const stray = (list) => list.filter((p) => Object.hasOwn(p, 'views') && p.kind !== 'database').map((p) => p.id);
    const check = (side, list) => {
      if (side === B) {
        assert.deepStrictEqual(list.filter((p) => Array.isArray(p.views) && p.views.length), list.filter((p) => p.id === B.made.id && p.views.length), '前提: 読まない方の DB にも views がある');
      } else assert.strictEqual(list.filter((p) => Array.isArray(p.views) && p.views.length === 20).length, 100, '前提: データベースの行に views が無い');
      assert.deepStrictEqual(stray(list), [], 'データベースでない行に views を付けた');
    };
    // R107（release の run 44250035465 の ci / test (windows-latest)）: 計るのは壁時計でなく CPU の時間（ほかのテストのファイルに機械を取られて、
    // この手が走っていなかった間を数えない）。
    // R34（計画 docs/plans/2026-11-18-171.md。R20 の根）: 前は「読む」と「読まない」をそれぞれ 8 回続けて、プロセス全体の CPU の時間で計っていた。
    // (1) 1回の一覧が若い世代に置く量（約 15.5MB）が若い世代の大きさとほぼ同じなので、若い世代の GC（scavenge）が一覧の中のほぼ同じ所で起き続け、
    // 組みかけの一覧が生きている所で起きると写す物が多く、重さが約3倍違う。ビューの分（置く量で約 2%）で起きる所がずれ、続けた 8 回の片方だけが重い所に
    // 固まった。(2) その重さの多くは GC の手伝いの糸の CPU の時間で、手伝いの糸の時間は空いているコアの数で 10 倍ほど変わり（同じ仕事で、混んで
    // いない機械では1回あたり約 9ms、混んだ機械では 1ms 未満）、Windows では約 15.6ms 刻みで数えるので、片方に 5ms ほど寄った（CI の Electron の
    // Node で 32.9ms と 27.0ms の赤）。今は、計る1回の前にでたらめな量（種を決めた乱数。若い世代の大きさまで）のごみを作って GC の起きる所を毎回
    // ずらし、2つの DB を1回ずつ ABBA と BAAB の順に交互に呼んで、一覧を走らせる糸（主の糸）の CPU の時間を 64 回ずつ合わせて比べる。
    // R26（種類を替えて比べない）・R41（別の時に計った回どうしを比べない）の考えはそのまま
    const v8 = require('node:v8');
    const space = v8.getHeapSpaceStatistics().find((s) => s.space_name === 'new_space');
    const young = Math.max(space ? space.space_size : 0, 32 * 1024 * 1024);
    let seed = 190;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    let keep = null;
    const shake = () => { const kb = Math.floor(rnd() * young / 1024); for (let i = 0; i < kb; i += 8) keep = new Array(1000).fill(i); };
    // 判定は一覧を走らせる糸（主の糸）の CPU の時間（process.threadCpuUsage。無い Node では process.cpuUsage）。プロセス全体の CPU の時間と壁時計は記録だけ
    const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
    const thrMs = typeof process.threadCpuUsage === 'function' ? () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; } : cpuMs;
    const wallMs = () => Number(process.hrtime.bigint()) / 1e6;
    const sum = { A: { cpu: 0, thr: 0, wall: 0 }, B: { cpu: 0, thr: 0, wall: 0 } };
    // 1回ずつ計る（前の一覧を生かしたまま次の一覧を呼ばない。続けて呼ぶと、同じ側が続く間だけ GC の重さが寄る）
    const one = (side) => {
      shake();
      const w0 = wallMs(); const t0 = thrMs(); const c0 = cpuMs();
      const r = call(side.db, 'pages.list', {});
      const got = { cpu: cpuMs() - c0, thr: thrMs() - t0, wall: wallMs() - w0 };
      check(side, r.result);
      return got;
    };
    // JIT は別の DB（同じ形）で温めてから、A と B の一覧を覚える（冷えたコードで先に覚えた側の一覧が、同じ仕事でも 2〜3% 重く出た）
    const C = build('views');
    for (let i = 0; i < 3; i++) call(C.db, 'pages.list', {});
    for (let i = 0; i < 2; i++) { call(A.db, 'pages.list', {}); call(B.db, 'pages.list', {}); }   // 一覧を覚える（計らない）
    const BLOCKS = 32;
    for (let k = 0; k < BLOCKS + 2; k++) {   // はじめの 2 組は捨てる（温まる前）。組ごとに ABBA と BAAB を替える（並びの位置に寄らない）
      const order = k % 2 === 0 ? [A, B, B, A] : [B, A, A, B];
      const got = order.map(one);
      if (k < 2) continue;
      got.forEach((g, i) => { const s0 = sum[order[i] === A ? 'A' : 'B']; s0.cpu += g.cpu; s0.thr += g.thr; s0.wall += g.wall; });
    }
    assert.ok(keep);
    const n = BLOCKS * 2;
    const a = sum.A.thr / n; const b = sum.B.thr / n;
    const f = (x) => (x / n).toFixed(1);
    tc.diagnostic(`1回あたり（読む・読まない）: 主の糸 ${f(sum.A.thr)}・${f(sum.B.thr)}ms、プロセス全体の CPU ${f(sum.A.cpu)}・${f(sum.B.cpu)}ms、壁時計 ${f(sum.A.wall)}・${f(sum.B.wall)}ms、若い世代 ${(young / 1048576).toFixed(0)}MB`);
    // 比べるのは1回あたりの差（読む − 読まない × 1.1）で、揺れの分の 2 ミリ秒は見逃す
    assert.ok(a - b * 1.1 <= 2, `ビューを読む一覧が読まない一覧の 1.1 倍を超えた（1回あたりの主の糸の CPU の時間で ${a.toFixed(1)}ms と ${b.toFixed(1)}ms）`);
  } finally { for (const t of temps) t.done(); }
});
