/* stage100.titles.test.js — 0.10.0 Task SH-1（D71・決めたこと 140。計画 docs/plans/2026-10-20-100.md）: 見本の議事録の題名を本物と同じ日付の形にする */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../src/mainlib');

const T = { timeout: 5000 };
const ROOT = path.join(__dirname, '..');

test('D71: meetingTitleAt の表（日本の時刻で 2026-10-16T01:00Z → 2026/10/16 10:00 の議事録・月と日は 0 を付けない・時と分は 2 けた）', T, () => {
  const JST = 540;
  for (const [at, want] of [
    ['2026-10-16T01:00:00.000Z', '2026/10/16 10:00 の議事録'],
    ['2026-10-09T05:00:00.000Z', '2026/10/9 14:00 の議事録'],
    ['2026-10-01T08:00:00.000Z', '2026/10/1 17:00 の議事録'],
    ['2026-01-04T15:05:00.000Z', '2026/1/5 00:05 の議事録'],   // 日本の時刻では次の日
    ['2026-12-31T14:59:00.000Z', '2026/12/31 23:59 の議事録'],
  ]) {
    assert.strictEqual(lib.meetingTitleAt(at, JST), want, at);
    assert.strictEqual(lib.meetingTitleAt(new Date(at), JST), want, at);
  }
  // 時差を渡さなければ PC の時計の時刻（今の main の fallbackTitle と同じ）
  const d = new Date(2026, 9, 3, 7, 4);
  assert.strictEqual(lib.meetingTitleAt(d), '2026/10/3 07:04 の議事録');
  assert.strictEqual(lib.meetingTitleAt('こわれた'), '');
});

test('D71: main の新しい議事録の題名は meetingTitleAt の1か所で作る（文字は今と同じ: PC の時計の時刻）', T, () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(main, /const fallbackTitle = lib\.meetingTitleAt\(dt\);/);
  assert.ok(!/の議事録`;/.test(main), 'main.js に題名の形を直に書いている');
});

test('D71: 撮る道具の見本の会議の題名は、どれも meetingTitleAt(createdAt, 日本の時刻) と同じ', T, () => {
  const SH = require('../tools/shots/screens');
  const fx = SH.fixtures();
  const pages = fx['koeApp.pagesSearch'];
  assert.strictEqual(pages.length, 3);
  for (const p of pages) assert.strictEqual(p.title, lib.meetingTitleAt(p.createdAt, 540), p.id);
  assert.deepStrictEqual(pages.map((p) => p.title), ['2026/10/16 10:00 の議事録', '2026/10/9 14:00 の議事録', '2026/10/1 17:00 の議事録']);
  assert.strictEqual(fx['koeApp.pageGet'].page.title, pages[0].title);
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'shots', 'screens.js'), 'utf8');
  assert.ok(!/（見本）'/.test(src.replace(/label: '[^']*'/g, '')), '見本の題名に「（見本）」が残っている');
});
