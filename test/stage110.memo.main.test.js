/*
 * stage110.memo.main.test.js — 0.11.0（計画 docs/plans/2026-10-22-110.md）の場面: main を偽の Electron の上で本当に動かす（helpers/mainrun.js）。
 * M-2: 要約の書式は種類から決まる型の見出しと締めで、Claude Code に渡す文（偽の claude の標準入力の見出し）に入る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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

// ---------------------------------------------------------------- M-4（MT3・F14・F27・P13。決めたこと 10〜12）
const M = require('../src/memoTypes');
const BANTC_HEADS = ['## 課題・要望（N）', '## 時期（T）', '## 決め方・決裁者（A）', '## 予算（B）', '## 競合・比較先（C）'];

test('0.11.0 M-4（D50・F27）: 録音中のページで商談を選んだ会議は、締めのページの種類が商談（手で選んだ）で、要約の書式が BANTC。メモが空なら BANTC の雛形が入り、経過に種類の項目が積まれる', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--sum', '--claude=ok', '--segs=2', '--set-type-live=sales']);
  assert.deepStrictEqual(o.setTypeLive.map((x) => [x.ok, x.inserted, x.meetingType]), [[true, true, 'sales']]);
  assert.strictEqual(o.liveStatusType, 'sales');
  const p = o.pages[0];
  assert.deepStrictEqual([p.meetingType, p.typeAuto], ['sales', false]);
  assert.strictEqual(p.memo, M.memoPreset('bantc'));
  assert.ok(p.stateLog.some((x) => x.s === 'type' && x.by === 'live-page'), JSON.stringify(p.stateLog));
  assert.ok(!p.stateLog.some((x) => x.s === 'type' && x.by === 'auto'), '手で選んだのに自動の判定の項目を積んだ');
  assert.deepStrictEqual(pCalls(o)[0].stdinHeads.slice(0, 5), BANTC_HEADS);
  assert.ok(o.engineLog.includes('議事録: 種類を選んだ（録音中のページ）'));
});

test('0.11.0 M-4・F14: 録音中のメモに人の文があれば、種類を選んでもメモは1文字も変わらない。商談を選んでから自動に戻すと、要約のときに判定する（選んでいない会議と同じ）', { timeout: sceneTimeout(30000) }, async () => {
  const a = await run(['text', '--sum', '--claude=ok', '--segs=2', '--live-memo=予算の相談をする', '--set-type-live=sales']);
  assert.deepStrictEqual(a.setTypeLive.map((x) => [x.inserted, x.memo]), [[false, '予算の相談をする']]);
  assert.strictEqual(a.pages[0].memo, '予算の相談をする');
  const b = await run(['text', '--sum', '--claude=ok', '--segs=2', '--set-type-live=sales,auto']);
  assert.strictEqual(b.liveStatusType, null);
  assert.deepStrictEqual([b.pages[0].meetingType, b.pages[0].typeAuto], [b.pages[0].autoType, true]);
  assert.notDeepStrictEqual(pCalls(b)[0].stdinHeads.slice(0, 5), BANTC_HEADS);
  assert.ok(b.pages[0].stateLog.some((x) => x.s === 'type' && x.by === 'auto'), '自動の判定の項目が無い');
  assert.strictEqual(b.pages[0].stateLog.filter((x) => x.s === 'type' && x.by === 'live-page').length, 1, '続けて選んだ項目が1件にまとまっていない');
});

test('0.11.0 M-4・F27: 録音中に商談を選んでから main ごと落ちても、下書きから戻したページの種類は商談（手で選んだ）', { timeout: sceneTimeout(60000) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-種類𠮷-'));
  try {
    const crashed = await new Promise((resolve) => {
      execScene(process.execPath, [RUN, 'text', '--segs=3', '--set-type-live=sales', '--kill-main-during', `--keep-user-data=${dir}`], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 30000 },
        (err) => resolve(err));
    });
    assert.ok(crashed && crashed.code !== 0, '場面の前提: main ごと落ちていない');
    const o = await run(['text', '--recover', `--keep-user-data=${dir}`]);
    const p = o.pages[0];
    assert.deepStrictEqual([p.meetingType, p.typeAuto, p.recovered], ['sales', false, true]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
