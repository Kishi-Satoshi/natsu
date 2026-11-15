/* stage170.rv60.mcp.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の点検 3（rv60）の Claude（MCP）の答え
 *  重要 5（R64。2026-11-15 の持ち主の答え「このままにする（おすすめ）」）: 最初の移し替えで作る「タスク管理」は、Claude の一覧に出る（ほかのデータベースと同じ）。
 *  持ち主が受けた差（失うもの）を、移し替えの前と後の答えで固定する: 「すべての議事録 n 件」と「探した会議 n 件」が1つ増え、移し替えの日の日付の絞りに当たる
 *  重要 2（R69）: 「データベース（行 n）」はテンプレートを数えない（表と同じ数え方）
 * 種は helpers/mcpdb.js（会議の題名は titleAt: D77）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sqlite = require('node:sqlite');
const { mcpDb } = require('./helpers/mcpdb');
const tools = require('../src/mcp/tools');

const NOW = () => new Date('2026-11-14T03:00:00.000Z');

test('rv60 重要 5（R64）: 最初の移し替え（minutes.gather の first）の前と後の list_meetings・search_passages の差は、「タスク管理」の1行・件数の1つ・移し替えの日の絞りだけ（わざと変える所）。「タスク管理」のテンプレートは「行 n」に数えない（rv60 重要 2）', { timeout: 60000 }, () => {
  const m = mcpDb({ only: ['plain1', 'plain2'] });
  try {
    const c = (name, args = {}) => tools.callTool(name, args, { sqlite, dataDir: m.dataDir, now: NOW }).text;
    const DAY = { from: '2026-10-21', to: '2026-10-21' };   // 種の時計（SEED_NOW）の日: 移し替えで作る「タスク管理」の日付
    const ask = () => [c('list_meetings'), c('search_passages', { query: '予算' }), c('list_meetings', DAY), c('list_action_items')];
    const before = ask();
    const g = m.call('main', 'minutes.gather', { first: true });
    const K = g.tasks;
    assert.ok(K, '前提: 移し替えで「タスク管理」を作っていない');
    m.call('app', 'tpl.add', { db: K, title: '見本' });   // テンプレートの題名（D77 の外）
    m.close();
    const after = ask();
    const line = `- 2026-10-21（水）｜タスク管理｜データベース（行 0）｜ID ${K}`;
    const [head, count, ...rest] = before[0].split('\n');
    assert.strictEqual(count, 'すべての議事録 2 件（新しい順）', '前提: 移す前の一覧');
    assert.strictEqual(after[0], [head, 'すべての議事録 3 件（新しい順）', line, ...rest].join('\n'), 'list_meetings の差');
    assert.ok(before[1].includes('（近い順。探した会議 2 件）'), '前提: 移す前の探した範囲');
    assert.strictEqual(after[1], before[1].replace('（近い順。探した会議 2 件）', '（近い順。探した会議 3 件）'), 'search_passages の差');
    const [dh] = before[2].split('\n');
    assert.strictEqual(before[2], [dh, '2026-10-21〜2026-10-21 の議事録 0 件（新しい順）', '- この範囲の議事録はありません。'].join('\n'), '前提: 移す前の日付の絞り');
    assert.strictEqual(after[2], [dh, '2026-10-21〜2026-10-21 の議事録 1 件（新しい順）', line].join('\n'), '日付の絞りの差');
    assert.strictEqual(after[3], before[3], 'list_action_items が変わった');
  } finally { m.done(); }
});
