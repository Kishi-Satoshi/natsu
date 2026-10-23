/* stage1d.lib.test.js — 第1d回 D16・D17 の mainlib の純粋な関数（区切りの長さ・止まりの見張り・帯の選び方・知らせの間引き・再起動を断る理由）と、A-2 のログインの文（accountMessage） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../src/mainlib');
const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- A-9（RL16・F16・RF41）: 更新の再起動を断る理由
test('RF41: 録音中（会議・音声入力の録音と文字起こし）は recording、締めと残りの区間は finalizing、要約は summary、ほかは \'\'', { timeout: 5000 }, () => {
  const B = (o) => L.restartBlock({ state: 'idle', finalizing: 0, pendingSegs: 0, summarizing: false, ...o });
  assert.deepStrictEqual(['meeting', 'recording', 'processing'].map((state) => B({ state })), ['recording', 'recording', 'recording']);
  assert.deepStrictEqual([B({ state: 'meeting-finalizing' }), B({ finalizing: 1 }), B({ pendingSegs: 2 })], ['finalizing', 'finalizing', 'finalizing']);
  assert.strictEqual(B({ summarizing: true }), 'summary');
  assert.strictEqual(B({}), '');
  assert.strictEqual(B({ state: 'meeting', summarizing: true }), 'recording', '録音中を要約より先に言う');
});

// ---------------------------------------------------------------- A-2（RL10）・A-12: ログインの IPC の文
// 第1d回 A-12 で意図して変えた: 前の自前のログイン（確認コード）の文 R2〜R10・R17 を消した。文は計画「作り替え」の「画面と知らせの文」の
// AR4〜AR7・R12〜R16 だけ（前の符号は知らない符号として R15）
test('RL10: ログインの答えの符号ごとの文は計画「作り替え」の AR4〜AR7・R12〜R16 のまま。{ホスト} は中継のホストの名前だけ。前の確認コードの符号（R2〜R10・R17）は R15', { timeout: 5000 }, () => {
  const host = new URL(require('../src/relay').RELAY_BASE).hostname;   // 第1d回 A-10: RELAY_BASE から取る
  const M = (code, o = {}) => L.accountMessage(code, { host, ...o });
  assert.strictEqual(M('login-ok'), 'ログインしました。インターネットにつながっているときは、クラウドで文字起こしします。');
  assert.strictEqual(M('cancel'), 'ログインの窓を閉じたため、ログインしていません。もう一度［ログイン］を押してください。');
  for (const c of ['login', 'no-cookie']) assert.strictEqual(M(c), 'ログインを確かめられませんでした。もう一度［ログイン］を押してください。', c);
  assert.strictEqual(M('denied'), 'このメールアドレスでは文字起こしの中継を使えません。管理者に知らせてください。');
  assert.strictEqual(M('logout'), 'ログアウトしました。これからは PC の中で文字起こしします。');
  for (const c of ['offline', 'net', 'timeout']) assert.strictEqual(M(c), '文字起こしの中継につながりませんでした。インターネットにつながっているかを確かめてください。', c);
  for (const c of ['cert', 'proxy']) assert.strictEqual(M(c), `文字起こしの中継につながりません（会社の通信の検査で止められている可能性があります）。続くときは情報システムに ${host} への通信の許可を頼んでください。`, c);
  assert.strictEqual(M('store'), 'この PC ではログインの情報をしまえません（暗号にする仕組みが使えません）。管理者に知らせてください。');
  // 中継の形でない答え・約束の形でない答え・知らない符号・前の確認コードの符号は R15（管理者へ）。符号の文字そのものは文に入れない
  for (const c of ['not-ready', 'server', 'bad-reply', 'bad-request', 'too-large', 'write', '__proto__', '',
    'domain', 'bad-email', 'rate', 'mail', 'mail-cap', 'code', 'code-expired', 'blocked', 'bad-code']) {
    assert.strictEqual(M(c, { left: 2, retryAfter: 120 }), '文字起こしの中継の準備ができていません。管理者に知らせてください。', c);
  }
});

// ---------------------------------------------------------------- A-5（RL13・D16・F13・RF40）: 区切りの長さ
test('D16: 始めの区切りは、ログインしてオンラインで、覚えている /health が「届かない」でなければ 15 秒。ほかは設定の長さ', { timeout: 5000 }, () => {
  const base = { localOnly: false, signedIn: true, hold: '', netOnline: true, peekUp: null };
  assert.strictEqual(L.startSegmentMode(base), 'short');
  assert.strictEqual(L.startSegmentMode({ ...base, peekUp: true }), 'short');
  for (const o of [{ peekUp: false }, { signedIn: false }, { hold: 'daily-cap' }, { netOnline: false }, { localOnly: true }]) {
    assert.strictEqual(L.startSegmentMode({ ...base, ...o }), 'long', JSON.stringify(o));
  }
  assert.strictEqual(L.segmentBaseMs('short', 75), 15000);
  assert.strictEqual(L.segmentBaseMs('long', 75), 75000);
  assert.strictEqual(L.segmentBaseMs('long', 120), 90000, '0.9.4 S-1（持ち主の答え Q3）で意図して直した: PC の側は 90 秒まで');
  assert.strictEqual(L.segmentBaseMs('short', 120), 15000, 'オンラインの 15 秒は設定の長さに引きずられない');
});

// 0.9.4 S-1（決めたこと 30）で意図して直した: 中継の一時の失敗（net・server など RELAY_TRANSIENT）で PC に落ちた区間は数えないので、
// 2区間続いてから替えるのを、数える理由（offline: ネットワークから外れた）で見る。server の1区間で替えない行はそのまま
test('D16: 経路の切り替えは同じ側が2区間続いてから（行ったり来たりしない）。ログイン切れ・上限・PC の中だけはすぐ長い側', { timeout: 5000 }, () => {
  let st = { mode: 'short', localRun: 0, cloudRun: 0 };
  const step = (route, why = route === 'cloud' ? 'ok' : 'offline') => (st = L.segmentModeNext(st, { route, why })).mode;
  assert.deepStrictEqual(['local', 'cloud', 'local', 'cloud'].map((r) => step(r)), ['short', 'short', 'short', 'short']);
  assert.deepStrictEqual(['local', 'local'].map((r) => step(r)), ['short', 'long']);
  assert.deepStrictEqual(['cloud', 'local', 'cloud', 'cloud'].map((r) => step(r)), ['long', 'long', 'long', 'short']);
  for (const why of ['login', 'daily-cap', 'quota', 'upstream-auth', 'signed-out', 'local-only']) {
    assert.strictEqual(L.segmentModeNext({ mode: 'short', localRun: 0, cloudRun: 5 }, { route: 'local', why }).mode, 'long', why);
  }
  assert.strictEqual(L.segmentModeNext({ mode: 'short', localRun: 0, cloudRun: 5 }, { route: 'local', why: 'server' }).mode, 'short', '1 区間の 502 で替えた');
});

// 0.9.4 S-1（決めたこと 14・29）で意図して直した: クラウドの側（short）は背圧で伸ばさない（倍にしない・上限の行は short では来ない）。
// PC の側（long）の背圧は上限 90 秒（持ち主の答え Q3）のほかは今と同じ。丸め（20〜300 秒）・始めの 15 秒のままなら送らない・長い側へすぐ、はそのまま
test('D16: 途中で送る長さは録音バーと同じく 20〜300 秒に丸める。始めの 15 秒のままなら送らない。75 秒の会議の背圧は今と同じ', { timeout: 5000 }, () => {
  const ov = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'overlay.html'), 'utf8');
  assert.match(ov, /const SEG_MIN_MS = 20000, SEG_MAX_MS = 300000;/, '録音バーの丸めが変わった（mainlib の写しを合わせる）');
  assert.strictEqual(L.OVERLAY_SEG_MIN_MS, 20000);
  const n = L.nextLiveSegmentMs;
  assert.strictEqual(n(0, 15000, 15000, -1, 'short'), 15000, '始めの 15 秒のまま');
  assert.strictEqual(n(4, 15000, 15000, 1, 'short'), 15000, 'クラウドの側を背圧で倍にした');
  assert.strictEqual(n(1, 30000, 15000, -1, 'short'), 20000, '戻すときは録音バーの下限の 20 秒');
  assert.strictEqual(n(1, 20000, 15000, -1, 'short'), 20000, '同じ値（送らない）');
  assert.strictEqual(n(2, 20000, 75000, 0, 'long'), 75000, '長い側へは待ちが残っていてもすぐ');
  assert.strictEqual(n(6, 90000, 75000, 1, 'long'), 90000, '上限（Q3 で 90 秒）');
  for (const [p, c, d] of [[4, 75000, 1], [5, 90000, 1], [3, 90000, 1], [2, 90000, -1], [1, 90000, -1], [0, 75000, -1]]) {
    assert.strictEqual(n(p, c, 75000, d, 'long'), L.nextSegmentMs(p, c, 75000, d), `75 秒の会議の背圧が変わった ${[p, c, d]}`);
  }
});

// ---------------------------------------------------------------- A-6（RL14・D17・F14・F15）: 止まりの見張りと帯の選び方
test('D17: 止まりの見張りは約 45 秒（15 秒なら3区間・75 秒なら2区間）。無音の空は数えず戻しもしない', { timeout: 5000 }, () => {
  assert.deepStrictEqual([15000, 20000, 30000, 75000, 300000].map(L.stallAfter), [3, 3, 2, 2, 2]);
  assert.strictEqual(L.STALL_SPAN_MS, 45000);
  assert.strictEqual(L.STALL_MIN_DBFS, -40);
  let run = 0;
  const s = (text, levelDbfs) => (run = L.stallStep(run, { text, levelDbfs }));
  assert.deepStrictEqual([s('', -20), s('', -70), s('', -30), s('こんにちは', -20), s('', -35)], [1, 1, 2, 0, 1]);
  assert.strictEqual(L.stallStep(0, { text: '', levelDbfs: -Infinity }), 0, '無音を数えた');
  assert.strictEqual(L.stallStep(0, { text: '', levelDbfs: -41 }), 0, '-40 dBFS より小さい音を数えた');
  assert.strictEqual(L.stallStep(2, { text: '', levelDbfs: -40 }), 2, 'ちょうど -40 dBFS を数えた（より大きい音だけ）');
});

// 第1d2回 M-2（D21）で意図して変えた: ログインの後・残した失敗の前に、準備を選んでいない PC で音声を残している帯（kept の4つ）を足した
test('D17: 帯は1つだけで、エンジン → 止まり → ログイン → 音声を残している → 残した失敗 → 中継の順。手元に落ちた理由ごとの符号', { timeout: 5000 }, () => {
  // 0.9.0 B-2（BN2）で意図して変えた: ネットワークから外れた帯 net-offline を seg-failed の後・中継の帯の前に足した
  // 0.9.4 S-1（決めたこと 18）で意図して変えた: PC の文字起こしが間に合わない帯 kept-late を engine-down の後に足した
  assert.deepStrictEqual(L.PROBLEM_ORDER, ['engine-down', 'kept-late', 'stall', 'login', 'kept-local', 'kept-login', 'kept-relay', 'kept-wait', 'seg-failed', 'net-offline', 'relay-off', 'daily-cap', 'relay-blocked', 'relay-down', 'relay-busy', 'wait']);
  const m = new Map([['relay-down', {}], ['seg-failed', { n: 2 }], ['wait', { sec: 7 }]]);
  assert.deepStrictEqual(L.sttProblemOf(m), { code: 'seg-failed', n: 2 });
  m.set('engine-down', {});
  assert.strictEqual(L.sttProblemOf(m).code, 'engine-down');
  m.set('stall', { sec: 45 }); m.set('login', {});
  assert.deepStrictEqual(['engine-down', 'stall', 'login', 'seg-failed', 'relay-down'].map((c) => { const r = L.sttProblemOf(m).code; m.delete(c); return r; }),
    ['engine-down', 'stall', 'login', 'seg-failed', 'relay-down']);
  assert.deepStrictEqual(L.sttProblemOf(m), { code: 'wait', sec: 7 });
  assert.strictEqual(L.sttProblemOf(new Map()), null);
  assert.strictEqual(L.sttProblemOf(new Map([['知らない', {}]])), null, '表に無い符号を帯にした');
  const P = (why) => L.problemForRoute({ route: 'local', why });
  assert.deepStrictEqual(['unreachable', 'net', 'timeout', 'cert', 'proxy', 'login', 'server', 'bad-reply', 'quota', 'upstream-auth'].map(P),
    ['relay-down', 'relay-down', 'relay-down', 'relay-blocked', 'relay-blocked', 'login', 'relay-busy', 'relay-busy', 'relay-off', 'relay-off']);
  assert.deepStrictEqual(['too-large', 'bad-request', 'まだ無い符号'].map(P), ['relay-busy', 'relay-busy', 'relay-busy']);
  assert.deepStrictEqual(['offline', 'signed-out', 'local-only', 'ok'].map(P), ['', '', '', ''], 'オフライン・ログインしていない・PC の中だけを帯にした');
  assert.strictEqual(L.problemForRoute({ route: 'cloud', why: 'ok' }), '');
  // daily-cap は scope で分かれる（1人の上限は daily-cap、全体の上限は relay-off）
  assert.strictEqual(L.problemForRoute({ route: 'local', why: 'daily-cap', scope: 'user' }), 'daily-cap');
  assert.strictEqual(L.problemForRoute({ route: 'local', why: 'daily-cap', scope: 'all' }), 'relay-off');
});

// ---------------------------------------------------------------- A-8（RL15・D17・F15）: Windows の知らせの間引き
test('D17: Windows の知らせは4つの符号だけ・同じ符号は会議で1回・違う符号でも 5 分は出さない・5 分後は出す', { timeout: 5000 }, () => {
  assert.deepStrictEqual(L.WIN_NOTIFY_CODES, ['engine-down', 'stall', 'login', 'seg-failed']);
  assert.strictEqual(L.WIN_NOTIFY_GAP_MS, 5 * 60 * 1000);
  let st = { sent: [], lastAt: 0 };
  const g = (code, now) => { const r = L.notifyGate(st, code, now); st = r.st; return r.ok; };
  assert.deepStrictEqual([g('relay-down', 1e6), g('login', 1e6), g('login', 2e6), g('stall', 1e6 + 299999), g('stall', 1e6 + 300000)], [false, true, false, false, true]);
  assert.deepStrictEqual(st, { sent: ['login', 'stall'], lastAt: 1e6 + 300000 }, '出さなかった知らせを数えた');
  // B5〜B10 と表に無い符号は出さない（PC の中で文字起こしが続いていて、帯と左下の知らせで足りる）
  for (const c of ['relay-off', 'daily-cap', 'relay-blocked', 'relay-down', 'relay-busy', 'wait', '知らない', '__proto__']) {
    assert.strictEqual(L.notifyGate({ sent: [], lastAt: 0 }, c, 1e6).ok, false, c);
  }
  // 4つの符号は、その会議で初めてなら出す（起動の直後の小さな時刻でも）
  for (const c of L.WIN_NOTIFY_CODES) assert.strictEqual(L.notifyGate({ sent: [], lastAt: 0 }, c, 1000).ok, true, c);
  // 前の st は書き換えない（main は答えの st を会議に持つ）。壊れた st でも投げない
  const s0 = { sent: [], lastAt: 0 };
  L.notifyGate(s0, 'login', 1e6);
  assert.deepStrictEqual(s0, { sent: [], lastAt: 0 });
  assert.deepStrictEqual(L.notifyGate(undefined, 'stall', 1e6), { ok: true, st: { sent: ['stall'], lastAt: 1e6 } });
  assert.strictEqual(L.notifyGate({ sent: 'login', lastAt: 'x' }, 'login', 1e6).ok, true);
});
