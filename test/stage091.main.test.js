/*
 * stage091.main.test.js — 0.9.1 の main の場面（計画 docs/plans/2026-10-21-091.md の Task Q-2・Q-4。設計書 D29）
 * Q-2: 音がほとんど無い区間はクラウドにも PC の中にも送らない。答えが認識ヒントの材料だけなら書かない（会議・復旧・音声入力）
 * 場面は helpers/mainrun.js を別のプロセスで回す（--relay は本物の中継のコードを 127.0.0.1 で動かし、後ろの偽の OpenAI が答える）。
 * 偽の OpenAI の答え方 parrot は、受けた認識ヒントの部品（文例 → 言葉の並び → 最初の語）をくり返す（利用者の 0.8.0 の記録の形）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const S = { timeout: 20000 };   // 場面は今の場面のテストと同じ見張り（stage090.banner）
const run = (args) => new Promise((resolve, reject) => {
  execFile(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001' }, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const sttCalls = (o) => (o.relayCalls || []).filter((p) => p === '/v1/audio/transcriptions').length;
const SAMPLE = 'お疲れさまです。よろしくお願いします。';
const textOf = (v) => (v && typeof v === 'object' ? v.text : v);

test('Q-2・Q3: 無音の区間はクラウドへ送らない（中継への文字起こしの要求 0）。議事録に区間が無く、記録に数つきの「音の無い区間」の行。全部が無音なら「すべて空」の知らせ（マイクを確かめる）', S, async () => {
  const o = await run(['text', '--relay-seq=pp', '--silent']);
  assert.strictEqual(o.start.ok, true, JSON.stringify(o.start));
  assert.strictEqual(sttCalls(o), 0, JSON.stringify(o.relayCalls));
  assert.deepStrictEqual(o.pages[0].segments, [], JSON.stringify(o.pages[0].segments));
  assert.ok(o.engineLog.includes('音の無い区間: 区間 s1 を送らずに除きました（無音・起動から 1 回目）'), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('音の無い区間: 区間 s2 を送らずに除きました（無音・起動から 2 回目）'), o.engineLog.join('\n'));
  // 記録に文字起こしの文が入らない（区間の名前・数・dBFS だけ）
  assert.ok(!o.engineLog.some((l) => l.includes('お疲れさま')), '記録に文を書いた');
  assert.ok(o.notices.map(textOf).some((t) => /2 区間の音声を受け取りましたが、文字起こしの結果がすべて空でした。/.test(t || '')), JSON.stringify(o.notices));
});

test('Q-2・Q2: 音のある区間の答えが認識ヒントの繰り返し（文例・言葉の並び・最初の語）なら、3 区間とも書かない。帯 stall を出さない。記録は数つきの1行（文字は書かない）', S, async () => {
  const o = await run(['text', '--relay-seq=ppp', '--segs=3']);
  assert.strictEqual(o.start.ok, true, JSON.stringify(o.start));
  assert.strictEqual(sttCalls(o), 3, JSON.stringify(o.relayCalls));
  // 偽の OpenAI は本当にヒントを繰り返した（場面が空で通っていない）
  assert.strictEqual(o.stt.filter((r) => r.fields && String(r.fields.prompt || '').startsWith(SAMPLE)).length, 3, JSON.stringify(o.stt.map((r) => r.fields)));
  assert.deepStrictEqual(o.pages[0].segments, [], JSON.stringify(o.pages[0].segments));
  for (let i = 1; i <= 3; i++) {
    assert.ok(o.engineLog.includes(`認識ヒントの繰り返し: 区間 s${i} の答えを除きました（起動から ${i} 回目）`), o.engineLog.join('\n'));
    assert.ok(o.engineLog.some((l) => new RegExp(`^区間 s${i}（音声 \\d+ 秒）: 認識ヒントの繰り返しのため除きました$`).test(l)), o.engineLog.join('\n'));
  }
  assert.ok(!o.sttSeen.some((s) => s.problem && s.problem.code === 'stall'), JSON.stringify(o.sttSeen));
  assert.ok(!o.engineLog.some((l) => /お疲れさま|不具合/.test(l)), '記録に文を書いた');
});

test('Q-2・Q2: 作り話の間の本物の区間は書く（parrot・文字・parrot・文字）', S, async () => {
  const o = await run(['text', '--relay-seq=pcpc', '--segs=4']);
  const segs = o.pages[0].segments;
  assert.strictEqual(segs.length, 2, JSON.stringify(segs));
  assert.ok(segs.every((s) => /^本日の議題は進捗の確認です。区間[24]$/.test(s.text) && !s.failed), JSON.stringify(segs));
});

test('Q-2・Q1: 15 秒の無音の真ん中の 0.6 秒の小さな音（-45 dBFS）の区間は、中継へ送って文字を書く（区間全体の RMS では無音に見える）', S, async () => {
  const o = await run(['text', '--relay=text', '--blip', '--segs=1']);
  assert.strictEqual(sttCalls(o), 1, JSON.stringify(o.relayCalls));
  assert.deepStrictEqual(o.pages[0].segments.map((s) => s.text), ['本日の議題は進捗の確認です。区間1']);
  assert.ok(!o.engineLog.some((l) => l.startsWith('音の無い区間:')), o.engineLog.join('\n'));
});

test('Q-2・決めたこと 4: 小さな音の区間で交互にくり返す同じ作り話（A・B・A・B。7 字以上）は、3 つ目から除く（直前の2つの済んだ区間と比べる）', S, async () => {
  const o = await run(['text', '--relay-seq=ABAB', '--segs=4', '--blip', '--blip-sec=3']);
  assert.deepStrictEqual(o.pages[0].segments.map((s) => s.text), ['ご視聴ありがとうございました。', 'チャンネル登録をお願いします。']);
  // 3 つ目（A）は直前の2つの済んだ区間（A・B）にある。4 つ目（B）は直前の済んだ区間の文が認識ヒントの尻尾に入っているので、作り話としても除く
  assert.ok(o.engineLog.some((l) => /^区間 s3（音声 \d+ 秒）: 直前と同じ文のため除きました$/.test(l)), o.engineLog.join('\n'));
  assert.ok(o.engineLog.some((l) => /^区間 s4（音声 \d+ 秒）: (直前と同じ文|認識ヒントの繰り返し)のため除きました$/.test(l)), o.engineLog.join('\n'));
});

test('Q-2・Q2: 起動の復旧（会議の後の待ち行列と同じ道）でも、作り話の答えは書かず区間を消す', S, async () => {
  const o = await run(['text', '--recover', '--relay=parrot']);
  assert.strictEqual(sttCalls(o), 1, JSON.stringify(o.relayCalls));
  assert.deepStrictEqual(o.pages[0].segments, [], JSON.stringify(o.pages[0].segments));
  assert.ok(o.engineLog.includes('認識ヒントの繰り返し: 復旧 s1 の答えを除きました（起動から 1 回目）'), o.engineLog.join('\n'));
});

test('Q-2: 無音の復旧の区間は送らずに消し、ページの経路の数（route.stt）に知らない経路を足さない', S, async () => {
  const o = await run(['text', '--recover', '--silent', '--relay=text']);
  assert.strictEqual(sttCalls(o), 0, JSON.stringify(o.relayCalls));
  assert.deepStrictEqual(o.pages[0].segments, [], JSON.stringify(o.pages[0].segments));
  assert.deepStrictEqual(Object.keys(o.pages[0].route.stt).sort(), ['cloud', 'local', 'provider'], JSON.stringify(o.pages[0].route));
  assert.ok(o.engineLog.includes('音の無い区間: 復旧 s1 を送らずに除きました（無音・起動から 1 回目）'), o.engineLog.join('\n'));
});

test('Q-2・Q1・決めたこと 3: 小さな音の音声入力の作り話は貼らず履歴に入れない。大きな声の音声入力の「お疲れさまです。…」は口述として貼る', S, async () => {
  const q = await run(['text', '--dictate', '--blip', '--relay-seq=p']);
  assert.deepStrictEqual(q.history, [], JSON.stringify(q.history));
  assert.ok(q.overlayPhases.some((p) => p.phase === 'error' && p.message === '音声を認識できませんでした'), JSON.stringify(q.overlayPhases));
  assert.ok(q.engineLog.includes('認識ヒントの繰り返し: 音声入力 の答えを除きました（起動から 1 回目）'), q.engineLog.join('\n'));
  const l = await run(['text', '--dictate', '--relay-seq=p']);
  assert.deepStrictEqual(l.history.map((h) => h.text), [SAMPLE], JSON.stringify(l.history));
});
