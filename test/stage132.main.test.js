/*
 * stage132.main.test.js — 0.13.2 の main の場面（計画 docs/plans/2026-10-28-132.md の Task LN-2〜LN-5・LN-7）
 * 偽の Electron の上で main.js を本当に動かして確かめる（helpers/mainrun.js）。
 * LN-2（LA3・LA4 の main）: 遅い PC で残した区間は、ログインしていてつながればクラウドで文字にする（オフラインモードの会議は PC だけ）・
 *       音声入力の後にも回し直す・進み具合を区間ごとに知らせる（page:pending）・回し始めた引き金を記録に符号で1行。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args, { scale = '0.005', env = {}, timeout = 30000 } = {}) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], {
    env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001', NATSU_TEST_LOCAL_TIME_SCALE: scale, ...env },
    maxBuffer: 1 << 24, timeout,
  }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});
const T = { timeout: sceneTimeout(30000) };
const SLOW_PACE = `--pace=${JSON.stringify({ schema: 1, model: 'same', rtf: 1.6, slow: true, at: 'now-1', from: 'live' })}`;
const STT = '/v1/audio/transcriptions';
const S3 = '文字起こし待ちの音声があります。文字起こしが済むと、自動で要約を作ります。';
const ETA_RE = /この PC では約 \d+ 分かかります/;
const sttPosts = (calls) => (calls || []).filter((p) => p === STT).length;

// ---------------------------------------------------------------- LN-2（LA3・決めたこと 6・7・LR10〜LR12）
test('LN-2・LA3: ログインしていない遅い会議の残した区間は、会議の後に PC へ（今のまま）。PC が時間切れで止まった後にログインすると、その直後の見回りで残りがクラウドで文字になり、要約も自動で作る（持ち主の報告の形）', T, async () => {
  const o = await run(['hang', '--relay=text', '--signed-out', SLOW_PACE, '--segs=2', '--sum', '--claude=ok', '--login-after']);
  // 会議の後: ログインしていないので PC へ。PC が時間切れで止まり、待ち行列は残る
  assert.ok(o.engineLog.some((l) => /^文字起こしの経路: 復旧 s1 → local/.test(l)), o.engineLog.join('\n'));
  assert.ok(o.engineLog.some((l) => /^復旧の文字起こしを止めました（理由: late）/.test(l)), o.engineLog.join('\n'));
  assert.ok(o.pages[0].segs.every((x) => x.failed), '前提: ログインする前は文字起こし待ち');
  assert.strictEqual(o.pages[0].summaryError, S3);
  // ログインした直後: クラウドで文字になり、要約を自動で作る
  const a = o.afterLogin;
  assert.strictEqual(a.login.ok, true, JSON.stringify(a.login));
  assert.ok(a.pages[0].segments.every((x) => !x.failed && /本日の議題/.test(x.text)), JSON.stringify(a.pages));
  for (const id of ['s1', 's2']) assert.ok(a.engineLog.some((l) => new RegExp(`^文字起こしの経路: 復旧 ${id} → cloud`).test(l)), a.engineLog.join('\n'));
  assert.strictEqual(sttPosts(a.relayCalls), 2, JSON.stringify(a.relayCalls));
  assert.ok(a.notices.some((n) => /^残しておいた音声を文字起こししました（2\/2 区間）。続けて要約を作ります。$/.test(n)), JSON.stringify(a.notices));
  assert.strictEqual(a.claudeCalls, 1, '待ち行列の後に要約を自動で作っていない');
  assert.notStrictEqual(a.pages[0].summaryError, S3);
  // LR11: 回し始めた引き金（会議の後・ログイン）
  assert.ok(a.engineLog.includes('文字起こし待ち: 始めた（meeting-end）'), a.engineLog.join('\n'));
  assert.ok(a.engineLog.includes('文字起こし待ち: 始めた（login）'), a.engineLog.join('\n'));
});

test('LN-2・LA3・LR12: ログインしてつながっている遅い会議の待ち行列は、会議の後にクラウドへ（復旧 s1 → cloud）。PC の目安の知らせは出ない', T, async () => {
  const o = await run(['text', '--relay-seq=nnc', SLOW_PACE, '--wait-queue-empty'], { scale: '1' });
  for (const id of ['s1', 's2']) assert.ok(o.engineLog.some((l) => l.startsWith(`文字起こしの経路: 区間 ${id} → 遅い PC のため音声を残した（`)), o.engineLog.join('\n'));
  const after = o.afterQueue.log;
  for (const id of ['s1', 's2']) {
    assert.ok(after.some((l) => new RegExp(`^文字起こしの経路: 復旧 ${id} → cloud`).test(l)), `会議の後にクラウドへ送っていない: ${after.join('\n')}`);
    assert.ok(!after.some((l) => new RegExp(`^文字起こしの経路: 復旧 ${id} → local`).test(l)), `会議の後に PC で文字起こしした: ${after.join('\n')}`);
  }
  assert.ok(o.afterQueue.pages[0].segments.every((s) => !s.failed), JSON.stringify(o.afterQueue.pages));
  assert.ok(!o.afterQueue.notices.some((n) => ETA_RE.test(typeof n === 'string' ? n : JSON.stringify(n))), JSON.stringify(o.afterQueue.notices));
});

test('LN-2・RF47: オフラインモードの遅い会議の待ち行列は、ログインしていても偽の中継への要求 0（PC だけ）', T, async () => {
  const o = await run(['text', '--relay-seq=ccc', SLOW_PACE, '--local-only', '--wait-queue-empty'], { scale: '1' });
  assert.deepStrictEqual(o.localOnly && o.localOnly.ok, true, JSON.stringify(o.localOnly));
  const after = o.afterQueue.log;
  assert.ok(after.some((l) => /^文字起こしの経路: 復旧 s1 → local/.test(l)), after.join('\n'));
  assert.ok(!after.some((l) => /^文字起こしの経路: 復旧 s\d → cloud/.test(l)), after.join('\n'));
  assert.strictEqual(sttPosts(o.afterQueue.relayCalls), 0, `オフラインモードの会議の音声を中継へ送った: ${o.afterQueue.relayCalls}`);
  assert.ok(o.afterQueue.pages[0].segments.every((s) => !s.failed), JSON.stringify(o.afterQueue.pages));
});

test('LN-2・決めたこと 7: 音声入力で止めた（busy）待ち行列は、音声入力が終わると回る（次の会議を待たない）', T, async () => {
  const o = await run(['slow', '--extra-queue=localonly3', '--dictate', '--after-dict-queue'], { scale: '0.02' });
  const log = o.afterDictQueue.log;
  const busy = log.findIndex((l) => /^復旧の文字起こしを止めました（理由: busy）/.test(l));
  assert.ok(busy >= 0, log.join('\n'));
  assert.strictEqual(o.afterDictQueue.queues, 0, `音声入力の後に待ち行列が残った: ${log.join('\n')}`);
  assert.ok(o.afterDictQueue.pages.every((p) => p.segments.every((s) => !s.failed)), JSON.stringify(o.afterDictQueue.pages));
  const again = log.indexOf('文字起こし待ち: 始めた（dictation-end）');
  assert.ok(again > busy, log.join('\n'));
  assert.ok(log.slice(again).some((l) => /^文字起こしの経路: 復旧 s\d → local/.test(l)), log.join('\n'));
});

test('LN-2・LR10: 区間を1つ文字にするたびに page:pending { id, left } が1つずつ減って届き、最後に running: false。recovery.json の残りも区間ごとに減る', T, async () => {
  const o = await run(['text', '--relay-seq=nnnc', SLOW_PACE, '--wait-queue-empty'], { scale: '1' });
  const pid = o.afterQueue.pages[0].id;
  const pend = o.afterQueue.pending.filter((p) => p.id === pid);
  assert.deepStrictEqual(pend.map((p) => [p.left, p.running]), [[2, true], [1, true], [0, true], [0, false]], JSON.stringify(pend));
  // 区間を片付けた後の recovery.json の区間の数（最後は消えている）
  assert.deepStrictEqual(pend.slice(0, 2).map((p) => p.queueItems), [[2], [1]], JSON.stringify(pend));
  assert.deepStrictEqual(pend[pend.length - 1].queueItems, [], JSON.stringify(pend));
});

test('LN-2・LR10: 途中で止まっても running: false と残りが届く（PC が時間切れ）', T, async () => {
  const o = await run(['hang', '--relay=text', '--signed-out', SLOW_PACE, '--segs=2', '--login-after']);
  const pid = o.pages[0].id;
  // 会議の後（ログインの前）: PC が時間切れで止まり、残り 2 で running: false
  const before = o.afterLogin.pending.filter((p) => p.id === pid);
  const stop = before.findIndex((p) => p.running === false);
  assert.ok(stop >= 0, JSON.stringify(before));
  assert.strictEqual(before[stop].left, 2, JSON.stringify(before));
  // ログインの後: 1つずつ減り、最後は running: false で 0
  assert.deepStrictEqual(before.slice(stop + 1).map((p) => [p.left, p.running]), [[1, true], [0, true], [0, false]], JSON.stringify(before));
});
