/*
 * stage110.memo.main.test.js — 0.11.0（計画 docs/plans/2026-10-22-110.md）の場面: main を偽の Electron の上で本当に動かす（helpers/mainrun.js）。
 * M-2: 要約の書式は種類から決まる型の見出しと締めで、Claude Code に渡す文（偽の claude の標準入力の見出し）に入る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const pCalls = (o) => o.claude.filter((l) => l.kind === 'p');

test('0.11.0 M-2（MT4・D42）: 商談の語の会議の要約は、Claude Code に商談の確認（BANTC）の見出し → 締めの4つ → 次に気をつけること の書式を渡す', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--sum', '--claude=ok', '--segs=2', '--text=商談 提案 見積 価格 契約 再販 の件です']);
  const calls = pCalls(o);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(o.pages[0].meetingType, 'sales');
  assert.deepStrictEqual(calls[0].stdinHeads, ['## 課題・要望（N）', '## 時期（T）', '## 決め方・決裁者（A）', '## 予算（B）', '## 競合・比較先（C）',
    '## 決定事項', '## 持ち越し', '## ToDo（誰が・何を・いつまでに）', '## 抜け・重なりチェック', '## 次に気をつけること']);
  assert.strictEqual(calls[0].stdinHasTranscript, true);
});
