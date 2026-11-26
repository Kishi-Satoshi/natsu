/*
 * stage181.mcp.test.js — 0.18.1（計画 docs/plans/2026-11-25-181.md）の MCP（Claude が読む行）。
 *  PF-6（決めたこと 10・AQ181-10〜AQ181-12 の (a)）: 一覧の行と会議の頭の「文字起こし」「要約」の経路で、PC の中を「オフライン」と呼ぶ。
 *  「両方」「クラウド」と保存の形（route.stt.local・route.summary.by）は変えない。
 */
'use strict';
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert');
const F = require('../src/mcp/format');
const { titleAt } = require('./helpers/titles');

const T = { timeout: 5000 };
const ENTRY = { id: 'pm1', title: titleAt('2026-11-20T01:00:00.000Z'), date: '2026-11-20', durationSec: 60, meetingType: 'general', hasSummary: true, openActionCount: 0 };
const PAGE = { id: 'pm1', title: titleAt('2026-11-20T01:00:00.000Z'), date: '2026-11-20', createdAt: '2026-11-20T01:00:00.000Z', durationSec: 60, meetingType: 'general', blocks: [], rev: 1 };
const headOf = (route) => F.meetingMarkdown({ ...PAGE, route }, [], { header: false }).text.split('\n');

test('PF-6 Claude が読む行: 文字起こしの経路は PC の中だけなら「オフライン」、両方・クラウドは今どおり。一覧の行と会議の頭の行も同じ', T, () => {
  assert.strictEqual(F.sttOf({ stt: { cloud: 0, local: 3 } }), 'オフライン');
  assert.strictEqual(F.sttOf({ stt: { cloud: 2, local: 1 } }), '両方');
  assert.strictEqual(F.sttOf({ stt: { cloud: 2, local: 0 } }), 'クラウド');
  assert.strictEqual(F.sttOf({}), '');
  const line = F.meetingLine(ENTRY, { route: { stt: { cloud: 0, local: 3 } } });
  assert.ok(line.includes('｜文字起こし: オフライン｜'), line);
  const head = headOf({ stt: { cloud: 0, local: 3 } });
  assert.ok(head.includes('- 文字起こし: オフライン'), head.join('\n'));
  for (const l of [line, ...head]) assert.ok(!/文字起こし: PC/.test(l), l);
});

test('PF-6 要約の行（Claude が読む行）: PC の中で作った要約（by local）は会議の頭で「- 要約: オフライン」、一覧で「要約: あり（オフライン）」。Claude Code は今どおり', T, () => {
  const head = headOf({ stt: { cloud: 0, local: 3 }, summary: { by: 'local' } });
  assert.ok(head.includes('- 要約: オフライン'), head.join('\n'));
  assert.ok(headOf({ summary: { by: 'claude-code' } }).includes('- 要約: Claude Code'));
  const line = F.meetingLine(ENTRY, { route: { summary: { by: 'local' } } });
  assert.ok(line.includes('｜要約: あり（オフライン）｜'), line);
  assert.ok(F.meetingLine(ENTRY, { route: { summary: { by: 'claude-code' } } }).includes('｜要約: あり（Claude Code）｜'));
  for (const l of [line, ...head]) assert.ok(!/要約: PC|あり（PC）/.test(l), l);
});
