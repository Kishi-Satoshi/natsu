/* stage170.minutes.mcp.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の第3部の Claude（MCP）の答え
 *  MG-2（R40。MG-3 の F197 の前倒し: 決めたこと 57）: 議事録を「議事録」データベースに移しても、MCP の6つの道具の答えは移す前と1字も同じ
 *  （「議事録」データベースそのものは一覧と探す範囲に出さず、その子の議事録には「場所: 」を付けない。ページの中に置いた議事録の場所は今のまま）
 * 種は helpers/mcpdb.js（会議の題名は titleAt: D77）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sqlite = require('node:sqlite');
const { mcpDb, withoutCt4 } = require('./helpers/mcpdb');
const tools = require('../src/mcp/tools');

const NOW = () => new Date('2026-11-14T03:00:00.000Z');

test('MG-2・F197: MCP の6つの道具の答えは、議事録を「議事録」データベースに入れた形でも、移す前の形（最上位）と1字も同じ', { timeout: 60000 }, () => {
  const m = mcpDb({ only: ['plain1', 'plain2', 'plain3', 'localOnly', 'unknown', 'trash', 'live', 'forge'] });
  try {
    const top = m.call('app', 'page.create', {}).id;
    m.call('app', 'page.setTitle', { id: top, title: '計画の親' });   // 白紙のページの題名（会議の題名でないので日付の形にしない: D77 の外）
    const nested = m.ids.plain3;
    const d = m.call('app', 'db.create', {}).id;
    m.call('app', 'page.setTitle', { id: d, title: '案件' });   // データベースの題名（D77 の外）
    m.call('app', 'row.add', { db: d, title: '見積もり' });   // データベースの行の題名（D77 の外）
    m.close();
    const raw = new sqlite.DatabaseSync(m.file);
    let M;
    try {
      M = raw.prepare("select id from blocks where type = 'page' and instr(attrs, '\"minutes\"') > 0").all().map((r) => r.id).find((id) => JSON.parse(raw.prepare('select attrs from blocks where id = ?').get(id).attrs).role === 'minutes');
      assert.ok(M, '前提: 締めが「議事録」データベースを作っていない');
      raw.prepare('update blocks set parent_id = ? where id = ?').run(top, nested);   // ページの中に置いた議事録（TQ1: 移さない物）
    } finally { raw.close(); }
    const ask = () => {
      const c = (name, args = {}) => tools.callTool(name, args, { sqlite, dataDir: m.dataDir, now: NOW }).text;
      const ids = [m.ids.plain1, m.ids.plain2, nested, m.ids.forge];
      return [c('list_meetings'), c('list_meetings', { from: '2026-10-19', to: '2026-10-20' }), ...ids.map((id) => c('get_meeting', { id })), c('get_meetings', { ids }),
        c('get_meetings', { from: '2026-10-16', to: '2026-10-20' }), c('search_passages', { query: '予算' }), c('list_action_items'), c('get_meeting', { id: top }), c('get_meeting', { id: d })];
    };
    const after = ask();
    assert.ok(after[0].includes('場所: 計画の親'), 'ページの中の議事録の場所が消えた');
    assert.ok(!after.some((t) => t.includes('場所: 議事録')), '「議事録」の子に場所を付けた');
    // 移す前の形（0.16.0: 議事録は最上位・「議事録」データベースは無い）に戻して、同じ問いの答えを比べる
    const w = new sqlite.DatabaseSync(m.file);
    try {
      w.prepare("update blocks set parent_id = null where parent_id = ? and type = 'page'").run(M);
      w.prepare('delete from blocks where id = ?').run(M);
    } finally { w.close(); }
    assert.deepStrictEqual(after, ask(), '「議事録」データベースに入れると Claude の答えが変わった');
  } finally { m.done(); }
});

test('MG-3・F197: Claude が「議事録」データベースそのものを読む（get_meeting の ID）と、議事録の題名の行を返す（わざと変える所: 0.16.0 では空の表）。議事録の子ページの場所は移す前と同じ（「議事録」を付けない）', { timeout: 60000 }, () => {
  const m = mcpDb({ only: ['plain1', 'plain2'] });
  try {
    const kid = m.call('app', 'page.create', { parentId: m.ids.plain1 }).id;
    m.call('app', 'page.setTitle', { id: kid, title: '会議の宿題' });   // 白紙のページの題名（D77 の外）
    m.close();
    const raw = new sqlite.DatabaseSync(m.file);
    let M;
    let titles;
    try {
      M = raw.prepare("select id from blocks where type = 'page' and instr(attrs, '\"minutes\"') > 0").all().map((r) => r.id).find((id) => JSON.parse(raw.prepare('select attrs from blocks where id = ?').get(id).attrs).role === 'minutes');
      titles = [m.ids.plain1, m.ids.plain2].map((id) => raw.prepare('select text from blocks where id = ?').get(id).text);
    } finally { raw.close(); }
    const c = (name, args = {}) => tools.callTool(name, args, { sqlite, dataDir: m.dataDir, now: NOW }).text;
    const dump = c('get_meeting', { id: M });
    for (const t of titles) assert.ok(dump.includes(t), `「議事録」データベースの答えに議事録「${t}」が無い`);
    const after = c('get_meeting', { id: kid });
    assert.ok(after.includes(`場所: ${titles[0]}`) && !after.includes('場所: 議事録'), after.split('\n').slice(0, 4).join(' | '));
    const w = new sqlite.DatabaseSync(m.file);
    try {
      w.prepare("update blocks set parent_id = null where parent_id = ? and type = 'page'").run(M);
      w.prepare('delete from blocks where id = ?').run(M);
    } finally { w.close(); }
    assert.strictEqual(c('get_meeting', { id: kid }), after, '議事録の子ページの答えが移す前と違う');
  } finally { m.done(); }
});

test('TK-3・F201: MCP の「開いた ToDo」（list_action_items）は、タスクにした ToDo もしていない ToDo も今どおり出て、答えはタスクにする前と1字も同じ', { timeout: 60000 }, () => {
  const m = mcpDb({ only: ['plain1', 'plain2', 'forge'] });
  try {
    // 0.18.0 CT-4（計画 docs/plans/2026-11-18-180.md の決めたこと 40・45）で意図して直した: タスクにした ToDo の行は「｜タスク <行の ID>」が足され（決めたこと 40。stage180.mcp で見る）、印を付けると版も上がるので、
    // 足した所を外して比べる（ほかは今どおり）
    const c = (name, args = {}) => withoutCt4(tools.callTool(name, args, { sqlite, dataDir: m.dataDir, now: NOW }).text);
    m.close();
    const before = [c('list_action_items'), c('get_meeting', { id: m.ids.forge })];
    const blockId = 'pf1t1';
    m.call('main', 'minutes.gather', { first: true });
    m.call('app', 'todo.toTask', { pageId: m.ids.forge, blockId });
    m.close();
    assert.deepStrictEqual([c('list_action_items'), c('get_meeting', { id: m.ids.forge })], before, 'タスクにすると Claude の答えが変わった');
  } finally { m.done(); }
});
