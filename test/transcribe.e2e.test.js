/*
 * transcribe.e2e.test.js — 記録 → 区間 → 文字起こし → 議事録の保存を、main.js ごと通しで試す
 *
 * 0.1.0 の実機で、録音の波形は出ているのに議事録が「0 区間」になった。原因は既定の認識ヒント
 * （初期プロンプト 376 バイト）で、kotoba-whisper が話し声に {"text":""} を返し、
 * main.js が空の区間を何も書かずに消していた。ここでは偽の whisper-server（helpers/fake-whisper.js）
 * を相手に、main.js を偽の Electron の上で実際に動かして固定する（helpers/mainrun.js）。
 *   - ヒント付きで空なら、ヒントなしでもう一度送り、区間を残す。議事録で 2 回続いたら、以後はヒントを渡さない
 *     （1 回では止めない。辞書を変えたら、またヒントを渡す。議事録を破棄したら、やり直しは送らない）
 *   - VAD が無く、ほぼ無音なら、ヒントなしのやり直しはしない（作り話を拾わない）
 *   - 本当に空なら、engine.log に理由を書き、全部が空なら利用者に知らせる（一部だけ空なら知らせない）
 *   - 200 のまま {"error"} を返すエンジンは、空ではなく失敗として区間を残す
 *   - 起動テスト（app:test）は /inference に無音を実際に送り、返事の異常を見逃さない。
 *     記録や文字起こしの最中は試さない
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');
const net = require('node:net');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');

// 場面ごとの文字起こしエンジンのポートを、先にまとめて取る。別々に空きを探すと、並べて走らせた
// 場面どうしで同じポートを掴むことがある（100 回に 1 回ほど落ちた）
async function reservePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  })));
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [RUN, ...args], { timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      const last = stdout.trim().split('\n').pop();
      try { resolve(JSON.parse(last)); } catch (e) { reject(new Error(`mainrun ${args.join(' ')} の出力を読めない: ${last}\n${stderr}`)); }
    });
  });
}

// 場面を並べて走らせる（1 つ 2〜3 秒）
const SCENES = {
  promptEmpty: ['prompt-empty', '--test', '--segs=3'],
  noiseFirst: ['big-prompt-empty', '--segs=3'],
  discard: ['slow-prompt-empty', '--discard-during'],
  dict: ['prompt-empty', '--segs=3', '--after-dict'],
  text: ['text', '--test'],
  empty: ['empty', '--test'],
  emptyOne: ['empty', '--segs=1'],
  mixed: ['mixed'],
  silentNoVad: ['empty', '--silent', '--segs=1'],
  silentVad: ['empty', '--silent', '--vad', '--segs=1'],
  err200: ['err200', '--test'],
  probe500: ['probe500', '--test'],
  probeBadJson: ['probe-badjson', '--test'],
  probeDrop: ['probe-drop', '--test'],
  busy: ['slow', '--test-during'],
  kotoba: ['prompt-empty', '--kotoba'],
};
const results = {};
const ready = reservePorts(Object.keys(SCENES).length).then((ports) =>
  Promise.all(Object.entries(SCENES).map(async ([k, a], i) => { results[k] = await run([...a, `--port=${ports[i]}`]); })));
const meetingReqs = (r) => r.requests.filter((l) => !/probe=true/.test(l));
const prompted = (r) => meetingReqs(r).map((l) => /prompt=true/.test(l));

test('ヒント付きで空なら、ヒントなしでもう一度送り、区間を残す。2 回続いたら以後はヒントを渡さない（0.1.0 の「0 区間」）', async () => {
  await ready;
  const r = results.promptEmpty;
  assert.strictEqual(r.pages.length, 1, '議事録が 1 つできていない');
  const segs = r.pages[0].segments;
  assert.strictEqual(segs.length, 3, `区間が消えた: ${JSON.stringify(segs)}`);
  assert.ok(segs.every((s) => !s.failed && /^本日の議題は進捗の確認です。区間\d+$/.test(s.text)), JSON.stringify(segs));
  // 1・2 つ目の区間は「ヒント付き → ヒントなし」。続いたので、3 つ目はヒントなしの 1 回だけ（毎回 2 回送らない）
  assert.deepStrictEqual(prompted(r), [true, false, true, false, false]);
  // ヒントなしのやり直しも、前の要求（ヒント付き）の続きにしない
  assert.ok(meetingReqs(r).every((l) => /nc=true/.test(l)), JSON.stringify(r.requests));
  assert.strictEqual(r.engineLog.filter((l) => /^文字起こし: 認識ヒント（\d+ バイト）付きでは空 → ヒントなしで \d+ 文字（音声 \d 秒）$/.test(l)).length, 2,
    `やり直しが engine.log に残っていない: ${JSON.stringify(r.engineLog)}`);
  assert.ok(r.engineLog.includes('文字起こし: 以後、エンジンと認識ヒントの設定が変わるまで、認識ヒントを渡しません'), JSON.stringify(r.engineLog));
  // 設定画面にも「いまはヒントを渡していない」と伝える
  assert.strictEqual(r.promptInfo.off, true);
  assert.ok(!r.notices.some((n) => /すべて空/.test(n)), '取れたのに「すべて空」と知らせている');
});

test('文字が取れたときは 1 回だけ送り、ヒントも止めない', async () => {
  await ready;
  const r = results.text;
  assert.deepStrictEqual(prompted(r), [true, true]);
  // ヒント付きの要求には、区間全体に効かせる carry_initial_prompt と言語を必ず添える
  assert.ok(meetingReqs(r).every((l) => /lang=ja/.test(l) && /carry=true/.test(l)), JSON.stringify(r.requests));
  // どの要求も前の要求の続きにしない（1.8.0 以前は既定で持ち越す）
  assert.ok(r.requests.every((l) => /nc=true/.test(l)), JSON.stringify(r.requests));
  // 改行をはさんだ返事は 1 行にまとめて保存する
  assert.deepStrictEqual(r.pages[0].segments.map((s) => s.text), ['本日の議題は進捗の確認です。区間2', '本日の議題は進捗の確認です。区間3']);
  assert.ok(!r.engineLog.some((l) => /認識ヒント|除きました/.test(l)), JSON.stringify(r.engineLog));
  assert.strictEqual(r.promptInfo.off, false);
});

test('本当に空なら、engine.log に区間ごとの理由を書き、全部が空なら利用者に知らせる', async () => {
  await ready;
  const r = results.empty;
  assert.strictEqual(r.pages[0].segments.length, 0);
  // 通知は数秒で消えるので、議事録の要約の欄にも同じ理由と確かめ方を残す（理由の記録の場所は札を付けて最後に）
  assert.match(r.pages[0].summaryError, /^2 区間の音声を受け取りましたが、文字起こしの結果がすべて空でした。.*使用するマイク.*理由の記録: %APPDATA%\\natsu\\engine\.log$/);
  // [BLANK_AUDIO] だけの返事も空として扱う
  assert.strictEqual(r.engineLog.filter((l) => /^文字起こし: 認識ヒント（\d+ バイト）付きでは空 → ヒントなしでも空/.test(l)).length, 2, JSON.stringify(r.engineLog));
  assert.strictEqual(r.engineLog.filter((l) => /^区間 s\d+（音声 \d+ 秒）: 文字起こしが空のため除きました$/.test(l)).length, 2, JSON.stringify(r.engineLog));
  assert.ok(r.engineLog.includes('議事録を保存: 文字起こしが空の区間が 2、文字の残った区間は 0'), JSON.stringify(r.engineLog));
  const notice = r.notices.find((n) => n.startsWith('2 区間の音声を受け取りましたが、文字起こしの結果がすべて空でした。'));
  assert.ok(notice, `利用者に知らせていない: ${JSON.stringify(r.notices)}`);
  assert.strictEqual(notice, r.pages[0].summaryError, '通知と要約の欄の文が違う');
  assert.match(notice, /使用するマイク/);
  assert.match(notice, /engine\.log/);
  // 空が続いても、ヒントは止めない（ヒントのせいだと分かったわけではない）
  assert.strictEqual(r.promptInfo.off, false);
});

test('空の区間が 1 つだけでも、全部が空なら知らせる。一部だけ空なら知らせない', async () => {
  await ready;
  assert.ok(results.emptyOne.notices.some((n) => n.startsWith('1 区間の音声を受け取りましたが、文字起こしの結果がすべて空でした。')),
    JSON.stringify(results.emptyOne.notices));
  const m = results.mixed;
  assert.strictEqual(m.pages[0].segments.length, 1, JSON.stringify(m.pages));
  assert.ok(m.engineLog.some((l) => /^区間 s1（音声 3 秒）: 文字起こしが空のため除きました$/.test(l)), JSON.stringify(m.engineLog));
  assert.ok(!m.notices.some((n) => /すべて空/.test(n)), `一部が取れたのに知らせた: ${JSON.stringify(m.notices)}`);
});

test('VAD が無く、ほぼ無音なら、ヒントなしのやり直しをしない（VAD があればやり直す）', async () => {
  await ready;
  const a = results.silentNoVad;
  assert.deepStrictEqual(prompted(a), [true], JSON.stringify(a.requests));
  assert.ok(a.engineLog.some((l) => /^文字起こし: 認識ヒント付きでは空。音がほとんど無いため（無音）、ヒントなしでのやり直しは省きました/.test(l)), JSON.stringify(a.engineLog));
  const b = results.silentVad;
  assert.match(b.spawnArgs, /--vad/, 'VAD の偽モデルを置いたのに --vad で起動していない');
  assert.deepStrictEqual(prompted(b), [true, false], JSON.stringify(b.requests));
});

test('200 のまま {"error"} を返すエンジンは、空ではなく失敗として区間を残す', async () => {
  await ready;
  const r = results.err200;
  const segs = r.pages[0].segments;
  assert.strictEqual(segs.length, 2, `区間が黙って消えた: ${JSON.stringify(segs)}`);
  assert.ok(segs.every((s) => s.failed && /failed to read audio data/.test(s.text)), JSON.stringify(segs));
  // 失敗はヒントなしのやり直しの対象にしない（空のときだけ）
  assert.ok(!r.engineLog.some((l) => /^文字起こし:/.test(l)), JSON.stringify(r.engineLog));
});

test('起動テストは /inference に正しい WAV の無音を実際に送り、返事の異常を見逃さない', async () => {
  await ready;
  for (const k of ['text', 'promptEmpty', 'empty']) {
    const t = results[k].test;
    assert.strictEqual(t.ok, true, `${k}: ${JSON.stringify(t)}`);
    assert.match(t.info, /短い無音を試しに文字起こしさせ、返事があることも確かめました/);
    assert.match(results[k].requests[0], /prompt=false probe=true lang=ja carry= nc=true wav=true/, `${k}: 起動テストの送り方が違う`);
  }
  const cases = {
    err200: /^文字起こしを試せませんでした: failed to read audio data$/,
    probe500: /^文字起こしを試せませんでした（500: boom）$/,
    probeBadJson: /^文字起こしエンジンの返事を読めませんでした$/,
    probeDrop: /^文字起こしを試せませんでした: エンジンにつながりませんでした$/,
  };
  for (const [k, re] of Object.entries(cases)) {
    const t = results[k].test;
    assert.strictEqual(t.ok, false, `${k}: ${JSON.stringify(t)}`);
    assert.match(t.error, re, k);
    assert.ok(results[k].engineLog.includes(`起動テスト: ${t.error}`), `${k}: engine.log に残っていない`);
  }
});

test('記録や文字起こしの最中は、起動テストで試しの文字起こしをしない', async () => {
  await ready;
  const r = results.busy;
  assert.strictEqual(r.testDuring.ok, true, JSON.stringify(r.testDuring));
  assert.match(r.testDuring.info, /記録や文字起こしの最中のため、試しの文字起こしは省きました/);
  assert.ok(!r.requests.some((l) => /probe=true/.test(l)), JSON.stringify(r.requests));
  assert.strictEqual(r.pages[0].segments.length, 2);
});

test('モデルが kotoba-whisper なら認識ヒントを渡さず（1 回だけ送る）、設定で large-v3-turbo を勧める', async () => {
  await ready;
  const r = results.kotoba;
  // ヒント付きなら空を返す偽エンジンでも、最初からヒントなしなので区間は残り、やり直しも起きない
  assert.deepStrictEqual(prompted(r), [false, false], JSON.stringify(r.requests));
  assert.ok(meetingReqs(r).every((l) => /carry= /.test(l) && /nc=true/.test(l)), JSON.stringify(r.requests));
  assert.strictEqual(r.pages[0].segments.length, 2);
  assert.ok(!r.engineLog.some((l) => /^文字起こし:/.test(l)), JSON.stringify(r.engineLog));
  assert.deepStrictEqual([r.promptInfo.off, r.promptInfo.offReason], [true, 'kotoba']);
  assert.match(r.engineStatus.whisperNote, /kotoba-whisper/);
  assert.match(r.engineStatus.whisperNote, /large-v3-turbo に替えることをおすすめします/);
  // kotoba でなければ勧めない・ヒントを止めた理由は 'empty'
  assert.strictEqual(results.text.engineStatus.whisperNote, '');
  assert.strictEqual(results.text.promptInfo.offReason, '');
  assert.strictEqual(results.promptEmpty.promptInfo.offReason, 'empty');
});

test('雑音の 1 区間だけヒント付きで空になっても、ヒントは止めない（続けて起きたときだけ止める）', async () => {
  await ready;
  const r = results.noiseFirst;
  // 1 つ目（3 秒）はヒント付きで空 → ヒントなし。2・3 つ目はヒント付きのまま取れる
  assert.deepStrictEqual(prompted(r), [true, false, true, true], JSON.stringify(r.requests));
  assert.strictEqual(r.pages[0].segments.length, 3);
  assert.deepStrictEqual([r.promptInfo.off, r.promptInfo.offReason], [false, '']);
  assert.ok(!r.engineLog.some((l) => /認識ヒントを渡しません/.test(l)), JSON.stringify(r.engineLog));
});

test('返事を待つ間に議事録を破棄したら、ヒントなしのやり直しは送らない', async () => {
  await ready;
  const r = results.discard;
  assert.strictEqual(r.discard && r.discard.ok, true, JSON.stringify(r.discard));
  assert.deepStrictEqual(prompted(r), [true], JSON.stringify(r.requests));
  assert.ok(!r.engineLog.some((l) => /^文字起こし: 認識ヒント/.test(l)), JSON.stringify(r.engineLog));
  assert.strictEqual(r.pages.length, 0, '破棄した議事録が保存された');
});

test('ヒントを止めた後で辞書を変えたら、またヒントを渡す（設定画面の約束どおり）', async () => {
  await ready;
  const r = results.dict;
  assert.deepStrictEqual([r.promptInfo.off, r.promptInfo.offReason], [true, 'empty']);
  assert.strictEqual(r.saved && r.saved.ok, true, JSON.stringify(r.saved));
  assert.deepStrictEqual([r.promptInfoAfterDict.off, r.promptInfoAfterDict.offReason], [false, '']);
});
