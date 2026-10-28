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

// ---------------------------------------------------------------- LN-3（LA2・LR6・決めたこと 4・5）
const codes = (o) => (o.sttSeen || []).map((s) => (s && s.problem ? s.problem.code : null)).filter((c, i, a) => i === 0 || a[i - 1] !== c);
const NO_LOGIN = 'ログインしていないため PC で文字起こししています。［ログイン］を押してログインすると、クラウドで文字起こしします。';

test('LN-3・持ち主の報告: 準備を選んだ遅い PC でログインしないで会議を始めると、帯は no-login（kept-late ではない）。ログインすると消え、kept-late が見える', T, async () => {
  const o = await run(['text', '--relay=text', '--signed-out', SLOW_PACE, '--segs=3', '--relogin-after=1']);
  const before = (o.sttSeen || []).find((s) => s && s.problem);
  assert.ok(before, JSON.stringify(o.sttSeen));
  assert.deepStrictEqual([before.problem.code, before.problem.text, before.problem.action], ['no-login', NO_LOGIN, 'signin']);
  assert.ok(!codes(o).slice(0, codes(o).indexOf('no-login') + 1).includes('kept-late'), `kept-late が先に出た: ${codes(o)}`);
  // ログインした直後: no-login が消え、残している区間の帯 kept-late が見える
  assert.strictEqual(o.relogin.login.ok, true, JSON.stringify(o.relogin));
  assert.strictEqual(o.reloginStt.problem && o.reloginStt.problem.code, 'kept-late', JSON.stringify(o.reloginStt));
  assert.ok(o.engineLog.includes('文字起こしの状態: 帯 no-login'), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('文字起こしの状態: 帯を消した no-login'), o.engineLog.join('\n'));
});

test('LN-3・LR6: しまったログインを復号できない PC の会議で帯 no-login（記録は key-unreadable の符号）', T, async () => {
  const o = await run(['text', '--relay=text', '--key-unreadable', '--segs=1']);
  assert.ok(codes(o).includes('no-login'), JSON.stringify(o.sttSeen));
  assert.ok(o.engineLog.some((l) => l.includes('key-unreadable')), o.engineLog.join('\n'));
});

test('LN-3: オフラインで始めた会議・オフラインモードの会議では no-login を出さない（ログインしていなくても）', T, async () => {
  for (const flag of ['--offline', '--local-only']) {
    const o = await run(['text', '--relay=text', '--signed-out', flag, '--segs=2']);
    assert.ok(!codes(o).includes('no-login'), `${flag}: ${JSON.stringify(o.sttSeen)}`);
    assert.ok(!o.engineLog.includes('文字起こしの状態: 帯 no-login'), `${flag}: ${o.engineLog.join('\n')}`);
  }
});

// ---------------------------------------------------------------- LN-4（LA1・PQ1〜PQ3・PQ5・LR1〜LR4・LR16〜LR21）
// 場面は --mic-feed の手順（録音の前のページ・会議・音声入力・ネットワーク・見回り・ログインの窓）。中継を置かない場面は「オンラインでログインしていない」の形
const mic = (steps, ...flags) => run(['text', `--mic-feed=${JSON.stringify(steps)}`, ...flags]);
const ML = (s) => [['line', s], ['clock', 2000]];
const MLs = (s, n) => Array.from({ length: n }, () => ML(s)).flat();
const PANEL_LN = (id) => [...ML(`mic ${id}:1`), ...ML(`mic ${id}:1`), ['wait-show', 1], ['ipc', 'nudge:start', {}]];
const AUTO = (m) => `アカウント: ログインの窓を自動で開いた（${m}）`;
const NOT_CHOSEN = ['--no-engine=fetchable', '--signed-out'];
const autoWin = (w) => {
  assert.ok(w, 'ログインの窓が無い');
  assert.deepStrictEqual([w.width, w.height, w.title, w.modal, w.show], [480, 680, 'NaTsu のログイン', false, false], JSON.stringify(w));
  assert.deepStrictEqual([w.parent, w.inactive, w.shown, w.focused], ['none', 1, false, 0], `自動の窓の出し方が違う: ${JSON.stringify(w)}`);
};

test('LN-4・LA1・LR1・LR17: 準備を選んだ PC でログインしないで起動すると、ログインの窓が1つ（LOGIN_WIN の大きさ・題『NaTsu のログイン』・modal: false・parent が none・inactive が 1・shown が偽・focused が 0）。engine.log に『アカウント: ログインの窓を自動で開いた（boot）』', T, async () => {
  const o = await mic([['wait-login', 1], ['sleep', 50]]);
  assert.strictEqual(o.loginWins.length, 1, JSON.stringify(o.loginWins));
  autoWin(o.loginWins[0]);
  assert.strictEqual(o.engineLog.filter((l) => l === AUTO('boot')).length, 1, o.engineLog.join('\n'));
  assert.ok(!o.engineLog.includes('アカウント: ログインの窓を開いた'), '自動の窓を押して開いた窓の行で書いた');
  // LR3: 準備を選んでいない PC の起動では開かない（今どおり設定の「アカウント」）
  const nc = await mic([['sleep', 300]], ...NOT_CHOSEN);
  assert.deepStrictEqual(nc.loginWins, [], '準備を選んでいない PC の起動でログインの窓を開いた（LR3）');
});

test('LN-4・決めたこと 1: 準備を選んでいない PC でログインしないで会議を始めると、meeting:toggle の答えは { ok: true } で録音が始まった後に窓が1つ（inactive）。音声入力は断っても、ログインが理由なら窓が1つ', T, async () => {
  const o = await mic([['start'], ['wait-login', 1], ['snap', 'm']], ...NOT_CHOSEN);
  assert.deepStrictEqual(o.ipc[0], ['start', { ok: true }], JSON.stringify(o.ipc));
  assert.strictEqual(o.snaps.m.active, true);
  assert.strictEqual(o.loginWins.length, 1, JSON.stringify(o.loginWins));
  autoWin(o.loginWins[0]);
  const started = o.engineLog.indexOf('会議: 始めた（page）');
  const opened = o.engineLog.indexOf(AUTO('meeting'));
  assert.ok(started >= 0 && opened > started, `録音を始める前に窓を開いた: ${o.engineLog.join('\n')}`);
  const d = await mic([['dictate'], ['wait-login', 1], ['sleep', 50]], ...NOT_CHOSEN);
  assert.strictEqual(d.loginWins.length, 1, JSON.stringify(d.loginWins));
  autoWin(d.loginWins[0]);
  assert.ok(d.engineLog.includes(AUTO('dictation')), d.engineLog.join('\n'));
});

test('LN-4・PQ2: オフラインで起動し（窓は 0）、途中でつながっても（見回り1回）窓は 0。その後に音声入力を始めると、録音を始めた後に窓が1つ（貼り付け先は変えない: inactive）', T, async () => {
  const o = await mic([['sleep', 200], ['snap', 'boot'], ['online', true], ['tick'], ['sleep', 100], ['snap', 'back'], ['dictate'], ['wait-login', 1], ['snap', 'd'], ['dictate-cancel']], '--offline');
  assert.strictEqual(o.snaps.boot.logins, 0, 'オフラインで起動して窓を開いた');
  assert.strictEqual(o.snaps.back.logins, 0, 'つながった途端に窓を開いた（PQ2）');
  assert.strictEqual(o.snaps.d.logins, 1, '音声入力の始めに窓を開いていない');
  autoWin(o.loginWins[0]);
  assert.ok(o.engineLog.includes(AUTO('dictation')), o.engineLog.join('\n'));
  assert.ok(!o.engineLog.includes(AUTO('boot')), o.engineLog.join('\n'));
});

test('LN-4: オフライン（net.isOnline() が偽）では起動・会議・音声入力のどれでも開かない。録音の前のページの［オフラインモードで始める］・パネルの「オフラインモードで始める」でも開かない', T, async () => {
  const off = await mic([['sleep', 200], ['start'], ['stop'], ['dictate'], ['sleep', 50], ['dictate-cancel'], ['sleep', 50]], '--offline');
  assert.deepStrictEqual(off.loginWins, [], `オフラインで窓を開いた: ${off.engineLog.join('\n')}`);
  const page = await mic([['ipc', 'meeting:prepare'], ['ipc', 'meeting:start', { pcOnly: true }], ['sleep', 200]], ...NOT_CHOSEN);
  assert.deepStrictEqual(page.ipc[1], ['meeting:start', { ok: true, localOnly: true }], JSON.stringify(page.ipc));
  assert.deepStrictEqual(page.loginWins, [], '［オフラインモードで始める］で窓を開いた');
  const panel = await mic([...ML('mic teams:1'), ...ML('mic teams:1'), ['wait-show', 1], ['ipc', 'nudge:start', { pcOnly: true }], ['sleep', 200]], ...NOT_CHOSEN);
  assert.strictEqual(panel.active, true, panel.engineLog.join('\n'));
  assert.deepStrictEqual(panel.loginWins, [], 'パネルの「オフラインモードで始める」で窓を開いた');
});

test('LN-4・LR18: 自動の窓が開いたままで音声入力・会議を始めても、窓は増えず、その窓に show・focus を呼ばない', T, async () => {
  const o = await mic([['wait-login', 1], ['dictate'], ['sleep', 50], ['dictate-cancel'], ['start'], ['sleep', 50]]);
  assert.strictEqual(o.loginWins.length, 1, JSON.stringify(o.loginWins));
  autoWin(o.loginWins[0]);
});

test('LN-4・LR4・PQ3: 自動の窓を × で閉じると、同じ起動の間の会議と音声入力で開かない。記録『アカウント: ログインできませんでした（cancel）』', T, async () => {
  const o = await mic([['wait-login', 1], ['login-close'], ['wait-login-closed', 1], ['start'], ['stop'], ['dictate'], ['sleep', 50], ['dictate-cancel'], ['sleep', 50]]);
  assert.strictEqual(o.loginWins.length, 1, `× の後に窓を開いた: ${o.engineLog.join('\n')}`);
  assert.ok(o.engineLog.includes('アカウント: ログインできませんでした（cancel）'), o.engineLog.join('\n'));
});

test('LN-4・LR4: 帯の［ログイン］（account:login）で開いた窓を × で閉じた後は、次の会議の始めに自動の窓が開く（押して開いた窓は数えない）', T, async () => {
  const o = await mic([['ipc', 'account:login'], ['start'], ['wait-login', 2], ['sleep', 50]], ...NOT_CHOSEN, '--access-login=cancel');
  assert.strictEqual(o.ipc[0][1].ok, false, JSON.stringify(o.ipc));
  assert.strictEqual(o.loginWins.length, 2, JSON.stringify(o.loginWins));
  assert.deepStrictEqual([o.loginWins[0].parent, o.loginWins[0].shown, o.loginWins[0].inactive], ['main', true, 0], '押して開いた窓が今の形でない');
  autoWin(o.loginWins[1]);
});

test('LN-4・LR19: 自動の窓が denied403 で閉じた後も、同じ起動の間は開かない', T, async () => {
  const o = await mic([['wait-login', 1], ['wait-login-closed', 1], ['start'], ['stop'], ['sleep', 50]], '--auto-login=denied403');
  assert.strictEqual(o.loginWins.length, 1, `失敗で閉じた後に窓を開いた: ${o.engineLog.join('\n')}`);
  assert.ok(o.engineLog.includes('アカウント: ログインできませんでした（denied）'), o.engineLog.join('\n'));
});

test('LN-4・LR20: 自動の窓で --auto-login=ok → ログインでき、本体の窓に account:changed が1回。次の会議の始めには開かない', T, async () => {
  const o = await mic([['wait-login', 1], ['wait-login-closed', 1], ['start'], ['sleep', 100]], '--relay=text', '--signed-out', '--auto-login=ok');
  assert.ok(o.engineLog.includes('アカウント: ログインした'), o.engineLog.join('\n'));
  assert.strictEqual(o.mainSentAll.filter(([ch]) => ch === 'account:changed').length, 1, JSON.stringify(o.mainSentAll.map(([ch]) => ch)));
  assert.strictEqual(o.loginWins.length, 1, 'ログインした後の会議で窓を開いた');
});

test('LN-4・LR2・PQ5: ログインして始めた会議の録音中に中継が 401 を返しても窓は開かない（loginWins が []）。帯 login が先頭', T, async () => {
  const o = await run(['text', '--relay-seq=cl', '--segs=3']);
  assert.deepStrictEqual(o.loginWins, [], `録音中のログイン切れで窓を開いた（F27・PQ5）: ${o.engineLog.join('\n')}`);
  assert.ok(codes(o).includes('login'), JSON.stringify(o.sttSeen));
});

// ---------------------------------------------------------------- LN-5（LA4・PQ4・決めたこと 8〜10・LR13）
test('LN-5: page:retranscribe はログインしていてつながればクラウド、していなければ PC のエンジンを起こして文字にする。押す前の page:pending は { left, running: false, busy: false }', T, async () => {
  const cloud = await run(['text', '--idle', '--relay=text', '--extra-queue-late=cloud', '--retranscribe']);
  assert.deepStrictEqual(cloud.pendingBefore, { left: 1, running: false, busy: false }, JSON.stringify(cloud.pendingBefore));
  assert.deepStrictEqual(cloud.retranscribe, { ok: true, left: 1 }, JSON.stringify(cloud.retranscribe));
  const a = cloud.afterRetranscribe;
  assert.strictEqual(a.queues, 0, a.engineLog.join('\n'));
  assert.ok(a.engineLog.some((l) => /^文字起こしの経路: 復旧 s1 → cloud/.test(l)), a.engineLog.join('\n'));
  assert.ok(a.engineLog.includes('文字起こし待ち: 始めた（button）'), a.engineLog.join('\n'));
  assert.deepStrictEqual(a.pendingAfter, { left: 0, running: false, busy: false });
  const pc = await run(['text', '--idle', '--relay=text', '--signed-out', '--extra-queue-late=cloud', '--retranscribe']);
  const b = pc.afterRetranscribe;
  assert.strictEqual(b.queues, 0, b.engineLog.join('\n'));
  assert.ok(b.engineLog.some((l) => /^文字起こしの経路: 復旧 s1 → local/.test(l)), b.engineLog.join('\n'));
  assert.strictEqual(sttPosts(b.relayCalls), 0);
  assert.ok(b.pages.find((p) => p.id.startsWith('plate')).segments.every((s) => !s.failed), JSON.stringify(b.pages));
});

test('LN-5・PQ4: 押すと、3回失敗して止めた区間（held）・止まった（stall）区間・失敗した区間も試す（持ち主の答え「音声が残っている行すべて」）。音声の無い区間は試さない（残りの数にも入れない）', T, async () => {
  const o = await run(['text', '--idle', '--relay=text', '--extra-queue-late=held', '--retranscribe']);
  assert.deepStrictEqual(o.pendingBefore, { left: 3, running: false, busy: false }, '音声の無い区間を数えた・held を数えていない');
  const a = o.afterRetranscribe;
  const page = a.pages.find((p) => p.id.startsWith('plate'));
  assert.deepStrictEqual(page.segments.map((s) => [s.id, s.failed]), [['s1', false], ['s2', false], ['s3', false]], JSON.stringify(page.segments));
  for (const id of ['s1', 's2', 's3']) assert.ok(a.engineLog.some((l) => new RegExp(`^文字起こしの経路: 復旧 ${id} → cloud`).test(l)), a.engineLog.join('\n'));
  assert.ok(!a.engineLog.some((l) => /復旧 s4/.test(l)), '音声の無い区間を試した');
  assert.strictEqual(a.queues, 0);
  // 区間ごとの残りの数（2・1・0 と、最後に回し終えた印）
  const pend = a.pending.filter((p) => p.id === page.id);
  assert.deepStrictEqual(pend.map((p) => [p.left, p.running]), [[2, true], [1, true], [0, true], [0, false]], JSON.stringify(pend));
});

test('LN-5: 録音中（会議・音声入力）の page:retranscribe は { ok: false, code: \'busy\' }・page:pending の busy は真。待ち行列の無いページは none', T, async () => {
  const o = await mic([['ipc', 'page:retranscribe', { id: 'p-none' }], ['ipc', 'page:pending', { id: 'p-none' }], ['start'],
    ['ipc', 'page:retranscribe', { id: 'p-none' }], ['ipc', 'page:pending', { id: 'p-none' }], ['stop'], ['dictate'], ['ipc', 'page:retranscribe', { id: 'p-none' }], ['dictate-cancel']]);
  const r = o.ipc.filter(([ch]) => ch === 'page:retranscribe' || ch === 'page:pending').map(([, v]) => v);
  assert.deepStrictEqual(r, [{ ok: false, code: 'none' }, { left: 0, running: false, busy: false }, { ok: false, code: 'busy' }, { left: 0, running: false, busy: true }, { ok: false, code: 'busy' }], JSON.stringify(o.ipc));
});

test('LN-5・LR13: 会議を出て止めた後、保存の返事の前に知らせを押すと、保存の後に page:open が ID の文字で1回。保存に失敗したら開かない', T, async () => {
  const LEAVE = [...PANEL_LN('teams'), ...MLs('mic -', 3)];
  const o = await mic([...LEAVE, ['final-only'], ['click-notice', 0], ['snap', 'c'], ['wait-finalized'], ['sleep', 100]], '--finalize-delay=400');
  const opens = o.mainSentAll.filter(([ch]) => ch === 'page:open').map(([, p]) => p);
  const pid = o.pageMemos[0].id;
  assert.deepStrictEqual(opens, [{ id: pid, saved: true }, pid], JSON.stringify(opens));
  assert.ok(o.mainWinCalls.includes('show'), '押したのに本体の窓を出していない');
  // 保存に失敗したら、押していても何も開かない（本体の窓はもう出ている）
  const f = await mic([...LEAVE, ['db-fail', 'meeting.finalize'], ['final-only'], ['click-notice', 0], ['wait-finalized'], ['sleep', 100]], '--finalize-delay=400');
  assert.deepStrictEqual(f.mainSentAll.filter(([ch]) => ch === 'page:open'), [], JSON.stringify(f.mainSentAll.filter(([ch]) => ch === 'page:open')));
});
