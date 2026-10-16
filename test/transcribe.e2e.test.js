/*
 * transcribe.e2e.test.js — 記録 → 区間 → 文字起こし → 議事録の保存を、main.js ごと通しで試す
 *
 * 0.1.0 の実機で、録音の波形は出ているのに議事録が「0 区間」になった。原因は既定の語彙の
 * ヒント（初期プロンプト 376 バイト）で、kotoba-whisper が話し声に {"text":""} を返し、
 * main.js が空の区間を何も書かずに消していた。ここでは偽の whisper-server（helpers/fake-whisper.js）
 * を相手に、main.js を偽の Electron の上で実際に動かして固定する（helpers/mainrun.js）。
 *   - ヒント付きで空なら、ヒントなしでもう一度送り、区間を残す
 *   - 本当に空なら、engine.log に理由を書き、全部が空なら利用者に知らせる
 *   - 200 のまま {"error"} を返すエンジンは、空ではなく失敗として区間を残す
 *   - 起動テスト（app:test）は /inference に実際に送り、{"error"} を見逃さない
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');

function run(mode) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [RUN, mode, '--test'], { timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${mode} が失敗: ${err.message}\n${stderr}`)); return; }
      const last = stdout.trim().split('\n').pop();
      try { resolve(JSON.parse(last)); } catch (e) { reject(new Error(`mainrun ${mode} の出力を読めない: ${last}\n${stderr}`)); }
    });
  });
}

// 4 つの場面を並べて走らせる（1 つ 2〜3 秒）
const results = {};
const ready = Promise.all(['prompt-empty', 'empty', 'err200', 'text'].map(async (m) => { results[m] = await run(m); }));

test('語彙のヒント付きで空なら、ヒントなしでもう一度送り、区間を残す（0.1.0 の「0 区間」）', async () => {
  await ready;
  const r = results['prompt-empty'];
  assert.strictEqual(r.pages.length, 1, '議事録が 1 つできていない');
  const segs = r.pages[0].segments;
  assert.strictEqual(segs.length, 2, `区間が消えた: ${JSON.stringify(segs)}`);
  assert.ok(segs.every((s) => !s.failed && /本日の議題/.test(s.text)), JSON.stringify(segs));
  // 区間ごとに「ヒント付き → ヒントなし」の 2 回。起動テストの 1 回はヒントなし
  const meeting = r.requests.filter((l) => !/probe=true/.test(l));
  assert.deepStrictEqual(meeting.map((l) => /prompt=true/.test(l)), [true, false, true, false]);
  assert.strictEqual(r.engineLog.filter((l) => /語彙のヒント（\d+ バイト）付きでは空 → ヒントなしで \d+ 文字/.test(l)).length, 2,
    `やり直しが engine.log に残っていない: ${JSON.stringify(r.engineLog)}`);
  assert.ok(!r.notices.some((n) => /すべて空/.test(n)), '取れたのに「すべて空」と知らせている');
});

test('文字が取れたときは 1 回だけ送る（ヒントなしのやり直しをしない）', async () => {
  await ready;
  const r = results.text;
  const meeting = r.requests.filter((l) => !/probe=true/.test(l));
  assert.deepStrictEqual(meeting.map((l) => /prompt=true/.test(l)), [true, true]);
  assert.strictEqual(r.pages[0].segments.length, 2);
  assert.ok(!r.engineLog.some((l) => /語彙のヒント|除きました/.test(l)), JSON.stringify(r.engineLog));
});

test('本当に空なら、engine.log に区間ごとの理由を書き、全部が空なら利用者に知らせる', async () => {
  await ready;
  const r = results.empty;
  assert.strictEqual(r.pages[0].segments.length, 0);
  assert.strictEqual(r.pages[0].summaryError, '文字起こしが空のため要約できません');
  assert.ok(r.engineLog.some((l) => /語彙のヒント（\d+ バイト）付きでは空 → ヒントなしでも空/.test(l)), JSON.stringify(r.engineLog));
  assert.strictEqual(r.engineLog.filter((l) => /^区間 s\d+（音声 \d+ 秒）: 文字起こしが空のため除きました$/.test(l)).length, 2, JSON.stringify(r.engineLog));
  assert.ok(r.engineLog.some((l) => /文字起こしが空の区間が 2、文字の残った区間は 0/.test(l)), JSON.stringify(r.engineLog));
  const notice = r.notices.find((n) => /2 区間の音声を受け取りましたが、文字起こしの結果がすべて空でした/.test(n));
  assert.ok(notice, `利用者に知らせていない: ${JSON.stringify(r.notices)}`);
  assert.match(notice, /使用するマイク/);
});

test('200 のまま {"error"} を返すエンジンは、空ではなく失敗として区間を残す', async () => {
  await ready;
  const r = results.err200;
  const segs = r.pages[0].segments;
  assert.strictEqual(segs.length, 2, `区間が黙って消えた: ${JSON.stringify(segs)}`);
  assert.ok(segs.every((s) => s.failed && /failed to read audio data/.test(s.text)), JSON.stringify(segs));
  // 失敗はヒントなしのやり直しの対象にしない（空のときだけ）
  assert.ok(!r.engineLog.some((l) => /語彙のヒント/.test(l)), JSON.stringify(r.engineLog));
});

test('起動テストは /inference に無音を実際に送り、{"error"} を見逃さない', async () => {
  await ready;
  for (const m of ['text', 'prompt-empty', 'empty']) {
    assert.strictEqual(results[m].test.ok, true, `${m}: ${JSON.stringify(results[m].test)}`);
    assert.match(results[m].test.info, /試しの文字起こしにも答えました/);
    assert.match(results[m].requests[0], /prompt=false probe=true/, `${m}: 起動テストが /inference に送っていない`);
  }
  const bad = results.err200.test;
  assert.strictEqual(bad.ok, false, JSON.stringify(bad));
  assert.match(bad.error, /文字起こしを試せませんでした: failed to read audio data/);
  assert.ok(results.err200.engineLog.some((l) => /^起動テスト: 文字起こしを試せませんでした/.test(l)));
});
