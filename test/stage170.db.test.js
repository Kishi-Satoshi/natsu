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
const { mcpDb } = require('./helpers/mcpdb');
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
      const c = (name, args = {}) => tools.callTool(name, args, { sqlite, dataDir: m.dataDir, now: NOW }).text;
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
