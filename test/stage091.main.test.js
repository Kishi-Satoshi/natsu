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
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const S = { timeout: sceneTimeout(20000) };   // 場面は今の場面のテストと同じ見張り（stage090.banner）
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001' }, maxBuffer: 1 << 24, timeout: 20000 },
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

// ---------------------------------------------------------------- Q-4（決めたこと 7〜11・14）: 話し声が無いときに聞いて止める
// --quiet-seq の区間は 1 つ 60 秒（会議の時計）。t は音のある区間（中継が文字を返す）、s は無音の区間（送らない）
const QA1 = (n) => `${n} 分ほど話し声がありません。会議は終わりましたか？ このままなら 5 分後に録音を止めて議事録を作ります。`;
const QA2 = '会議は終わりましたか？';
const QA3 = (t) => `話し声が無かったので録音を止め、議事録を作りました（最後の発言 ${t}）。`;
const askedAt = (o) => o.quietTrace.findIndex((x) => x.asked);
const asksAll = (o) => o.quietTrace.filter((x) => x.asked).map((x) => x.i);
const barMsgs = (o) => o.overlaySeq.filter((p) => p && p.phase === 'recording').map((p) => p.message);
const afterStop = (o) => o.overlaySeq.slice(o.overlaySeq.findIndex((p) => p && p.stop) + 1);

test('Q-4・Q4: 話し声の無い 10 分で帯 QA1・録音バー QA2・Windows の知らせ（録音中のページが見えない）。15 分で自動で止め、議事録の所要時間は最後の発言の区間の終わり（60 秒）。知らせ QA3。止める頼みは1回', S, async () => {
  const o = await run(['text', '--relay=text', '--quiet-seq=t,s*20', '--main-hidden']);
  assert.strictEqual(askedAt(o), 10, JSON.stringify(o.quietTrace));
  assert.strictEqual(o.quietText, QA1(10));
  assert.strictEqual(o.quietStopAt, 15, JSON.stringify(o.quietTrace));
  assert.strictEqual(o.stopCalls, 1);
  assert.ok(barMsgs(o).includes(QA2), JSON.stringify(o.overlaySeq));
  assert.ok(o.notifications.some((n) => n.title === 'NaTsu' && n.body === QA1(10)), JSON.stringify(o.notifications));
  assert.ok(o.notifications.some((n) => n.body === QA3('0:00')), JSON.stringify(o.notifications));
  assert.ok(o.notices.map(textOf).includes(QA3('0:00')), JSON.stringify(o.notices));
  assert.strictEqual(o.pageDur.durationSec, 60, JSON.stringify(o.pageDur));
  assert.deepStrictEqual(o.pages[0].segments.map((s) => s.text), ['本日の議題は進捗の確認です。区間1']);
  assert.ok(o.engineLog.includes('話し声の見張り: 話し声の無い時間が 10 分になったので聞いた'), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('話し声の見張り: 聞いてから 5 分たっても話し声が無いので、録音を止めた'), o.engineLog.join('\n'));
  // 止めた後に録音バーへ「会議は終わりましたか？」を送らない（「議事録を作成中…」を消さない）
  assert.ok(!afterStop(o).some((p) => p && p.phase === 'recording'), JSON.stringify(afterStop(o)));
});

test('Q-4・Q4: 聞いている間に話し声が戻ったら聞くのをやめ（帯が消え・Windows の知らせを閉じ・録音バーへ空の文）、止めない', S, async () => {
  const o = await run(['text', '--relay=text', '--quiet-seq=t,s*12,t,s*3', '--main-hidden']);
  assert.strictEqual(askedAt(o), 10);
  assert.deepStrictEqual(asksAll(o), [10, 11, 12], JSON.stringify(o.quietTrace));
  assert.strictEqual(o.quietStopAt, undefined);
  assert.ok(o.notifyClosed >= 1, '知らせを閉じていない');
  const msgs = barMsgs(o);
  assert.ok(msgs.indexOf('') > msgs.indexOf(QA2), JSON.stringify(msgs));
  assert.ok(o.engineLog.includes('話し声の見張り: 話し声が戻ったので聞くのをやめた'), o.engineLog.join('\n'));
});

test('Q-4・Q4: ［続ける］で聞くのをやめ、数え直す（続けて 6 分では聞き直さない）', S, async () => {
  const o = await run(['text', '--relay=text', '--quiet-seq=t,s*11,k,s*6']);
  assert.deepStrictEqual(asksAll(o), [10, 11], JSON.stringify(o.quietTrace));
  assert.deepStrictEqual(o.keepGoing, { ok: true });
  assert.ok(o.engineLog.includes('話し声の見張り: ［続ける］が押されたので数え直す'), o.engineLog.join('\n'));
});

test('Q-4・Q4・決めたこと 14: 一時停止の 20 分は数えない（聞かない）', S, async () => {
  const o = await run(['text', '--relay=text', '--quiet-seq=t,s*5,P,s*4']);
  assert.deepStrictEqual(asksAll(o), [], JSON.stringify(o.quietTrace));
  assert.ok(!barMsgs(o).includes(QA2));
});

test('Q-4・Q4: 設定がオフなら聞かず止めない', S, async () => {
  const off = await run(['text', '--relay=text', '--quiet-seq=t,s*20', '--auto-stop=off']);
  assert.deepStrictEqual(asksAll(off), []);
  assert.strictEqual(off.quietStopAt, undefined);
});

test('Q-4: 知らせるまでの時間を 5 分にすれば 5 分で聞き 10 分で止める', S, async () => {
  const five = await run(['text', '--relay=text', '--quiet-seq=t,s*11', '--auto-stop-min=5']);
  assert.strictEqual(askedAt(five), 5, JSON.stringify(five.quietTrace));
  assert.strictEqual(five.quietText, QA1(5));
  assert.strictEqual(five.quietStopAt, 10);
});

test('Q-4・Q4・決めたこと 7: 失敗して音声を残した区間は話し声ありに数える（聞かない）', S, async () => {
  const f = await run(['text', '--relay=text', '--quiet-seq=t,s*9,t:L,s*3']);
  assert.deepStrictEqual(asksAll(f), [], JSON.stringify(f.quietTrace));
  assert.ok(f.engineLog.some((l) => /429/.test(l) || /rate-long/.test(l)), '前提: 区間が中継の 429 の長い待ちで失敗していない');
});

test('Q-4・Q4・決めたこと 7: 音のある空の区間は話し声ありに数える（聞かない）', S, async () => {
  const e = await run(['text', '--relay=text', '--quiet-seq=t,s*9,t:e,s*3']);
  assert.deepStrictEqual(asksAll(e), [], JSON.stringify(e.quietTrace));
});

test('Q-4・Q2・決めたこと 7: 認識ヒントの作り話の区間は話し声なしに数える（聞く）', S, async () => {
  const p = await run(['text', '--relay=text', '--quiet-seq=t,t:p*12']);
  assert.strictEqual(askedAt(p), 10, JSON.stringify(p.quietTrace));
});

test('Q-4・Q5・Q6: 聞いている間に手で止めると、止める頼みは1回・所要時間は最後の発言の区間の終わり・止めた後に録音バーへ文を送らない・Windows の知らせを閉じる・QA3 は出ない', S, async () => {
  const o = await run(['text', '--relay=text', '--quiet-seq=t,s*11,x', '--main-hidden']);
  assert.strictEqual(askedAt(o), 10);
  assert.strictEqual(o.stopCalls, 1);
  assert.strictEqual(o.quietStopAt, undefined);
  assert.strictEqual(o.pageDur.durationSec, 60, JSON.stringify(o.pageDur));
  assert.ok(!afterStop(o).some((p) => p && p.phase === 'recording'), JSON.stringify(afterStop(o)));
  assert.ok(o.notifyClosed >= 1, '止めたのに Windows の知らせを閉じていない');
  assert.ok(!o.notices.map(textOf).some((t) => /話し声が無かったので/.test(t || '')), JSON.stringify(o.notices));
});

test('Q-4・Q5: 止めた後の最後の区間で 10 分に達しても聞かない（帯・録音バー・Windows の知らせを出さない）。聞いていない手の停止は所要時間を切らない', S, async () => {
  const o = await run(['text', '--relay=text', '--quiet-seq=t,s*9,X', '--main-hidden']);
  assert.deepStrictEqual(asksAll(o), []);
  assert.ok(!barMsgs(o).includes(QA2), JSON.stringify(o.overlaySeq));
  assert.ok(!o.notifications.some((n) => n.body === QA1(10)), JSON.stringify(o.notifications));
  assert.ok(o.pageDur.durationSec < 60, JSON.stringify(o.pageDur));
});

test('Q-4・Q5: 聞いている間に破棄したら、録音バーへ何も送らず、Windows の知らせを閉じる', S, async () => {
  const o = await run(['text', '--relay=text', '--quiet-seq=t,s*11,d', '--main-hidden']);
  assert.strictEqual(o.discard.ok, true);
  assert.strictEqual(o.overlaySeq.length, o.seqAtDiscard, JSON.stringify(o.overlaySeq.slice(o.seqAtDiscard)));
  assert.ok(o.notifyClosed >= 1);
});

test('Q-4・Q3: PC の中だけの会議でも、無音の区間は中継へ送らない（文字起こしの要求 0）', S, async () => {
  const o = await run(['text', '--relay=text', '--local-only', '--quiet-seq=t,s*3']);
  assert.strictEqual(o.localOnly.localOnly, true, JSON.stringify(o.localOnly));
  assert.strictEqual(sttCalls(o), 0, JSON.stringify(o.relayCalls));
  assert.strictEqual(o.engineLog.filter((l) => l.startsWith('音の無い区間: ')).length, 3, o.engineLog.join('\n'));
});

test('Q-4・Q4・決めたこと 14: 一時停止の間に分けた区間で 15 分に達しても止めない（聞くのも、再開の後に決め直す）。再開は［続ける］と同じに数え直す', S, async () => {
  const o = await run(['text', '--relay=text', '--quiet-seq=t,s*14,S,R,s*3']);
  assert.strictEqual(askedAt(o), 10, JSON.stringify(o.quietTrace));
  assert.strictEqual(o.quietStopAt, undefined, JSON.stringify(o.quietTrace));
  assert.strictEqual(o.stopCalls, 1, '一時停止の間に止めた');
  // 再開で聞くのをやめ、続けて 3 分では聞き直さない
  assert.deepStrictEqual(asksAll(o).filter((i) => i > 16), [], JSON.stringify(o.quietTrace));
  assert.ok(o.engineLog.includes('話し声の見張り: 再開したので数え直す'), o.engineLog.join('\n'));
});

test('Q-4・Q4・決めたこと 14: 一時停止の間に分けた区間で 10 分に達しても聞かない（再開で数え直す）', S, async () => {
  const a = await run(['text', '--relay=text', '--quiet-seq=t,s*9,S,R,s*2']);
  assert.deepStrictEqual(asksAll(a), [], JSON.stringify(a.quietTrace));
});
