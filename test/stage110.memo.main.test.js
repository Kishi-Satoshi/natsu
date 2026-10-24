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

test('0.11.0 M-3（MT4・D39・F10）: 要約の保存で、根拠の無い見出しは本文に無く未確認の1行にまとまり、チェックは 3 件、印の行に出典が無く、engine.log には数だけ', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--sum', '--claude=ok', '--segs=2', '--text=商談 提案 見積 価格 契約 再販 の件です。来月から使いたい。決裁の流れを聞く', '--sum-md=bantc-mixed']);
  const p = o.pages[0];
  const heads = p.sumBlocks.filter((b) => b.type === 'heading').map((b) => b.text);
  assert.deepStrictEqual(heads, ['課題・要望（N）', '時期（T）', '競合・比較先（C）', '決定事項', 'ToDo（誰が・何を・いつまでに）', '抜け・重なりチェック', '次に気をつけること']);
  const marked = p.sumBlocks.filter((b) => b.mark);
  assert.deepStrictEqual(marked.map((b) => [b.mark, b.text]), [
    ['memo', '見込み: 来月から使いたい（メモより）'],
    ['check', '未確認: 決め方・決裁者（A）、予算（B）'], ['check', '次の会議で決裁の流れを聞く'], ['check', '予算の枠を聞く'], ['check', '導入の時期を確かめる'],
    ['advice', '冒頭で会議の目的を言うと、論点がそろう'], ['advice', '決めることを先に挙げる'],
  ]);
  for (const b of marked) { assert.strictEqual(b.cites, 0, b.text); assert.strictEqual(b.citeState, 'manual', b.text); }
  assert.strictEqual(p.sumBlocks.find((b) => b.mark === 'check').unconfirmed, true);
  const line = o.engineLog.find((l) => /抜け・重なりチェック/.test(l));
  assert.strictEqual(line, '要約: 抜け・重なりチェック 1 件を捨てた・未確認にまとめた見出し 2 個', JSON.stringify(o.engineLog.filter((l) => /要約/.test(l))));
  assert.ok(!o.engineLog.some((l) => /決裁|予算の枠|メモより/.test(l)), '記録に要約の文が出た');
});
