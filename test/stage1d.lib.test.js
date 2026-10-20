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

// ---------------------------------------------------------------- A-2（RL10）: ログインの IPC の文（計画「画面と知らせの文」の R4〜R17）
test('RL10: ログインの答えの符号ごとの文は計画の R4〜R17 のまま。{n} は分（切り上げ・1 以上）と回数、{ホスト} は中継のホストの名前だけ', { timeout: 5000 }, () => {
  const host = 'natsu-relay.-unset-.workers.dev';
  const M = (code, o = {}) => L.accountMessage(code, { host, ...o });
  assert.strictEqual(M('domain'), 'このメールアドレスでは登録できません。会社のメールアドレスを入れてください。');
  assert.strictEqual(M('bad-email'), 'メールアドレスの形が正しくありません。入れ直してください。');
  assert.strictEqual(M('rate', { retryAfter: 61 }), '確認コードを送る回数が多すぎます。2 分ほど待ってから、もう一度試してください。');
  assert.strictEqual(M('rate', { retryAfter: 5 }), '確認コードを送る回数が多すぎます。1 分ほど待ってから、もう一度試してください。');
  assert.strictEqual(M('rate'), '確認コードを送る回数が多すぎます。15 分ほど待ってから、もう一度試してください。', '待ちの秒が無いときは同じメールの窓の 15 分');
  for (const c of ['mail', 'mail-cap']) assert.strictEqual(M(c), '確認コードのメールを送れませんでした。しばらく待ってから、［確認コードを送る］をもう一度押してください。', c);
  assert.strictEqual(M('code', { left: 4 }), '確認コードが違います（あと 4 回試せます）。メールの 6 けたを入れ直してください。');
  assert.strictEqual(M('code-expired'), '確認コードの期限が切れたか、試せる回数を使い切りました。［コードを送り直す］を押してください。');
  assert.strictEqual(M('blocked'), 'このメールアドレスは使えなくなっています。管理者に知らせてください。');
  assert.strictEqual(M('logout'), 'ログアウトしました。これからは PC の中で文字起こしします。');
  for (const c of ['offline', 'net', 'timeout']) assert.strictEqual(M(c), '文字起こしの中継につながりませんでした。インターネットにつながっているかを確かめてください。', c);
  for (const c of ['cert', 'proxy']) assert.strictEqual(M(c), `文字起こしの中継につながりません（会社の通信の検査で止められている可能性があります）。続くときは情報システムに ${host} への通信の許可を頼んでください。`, c);
  assert.strictEqual(M('store'), 'この PC ではログインの情報をしまえません（暗号にする仕組みが使えません）。管理者に知らせてください。');
  assert.strictEqual(M('bad-code'), '確認コードは 6 けたの数字です。メールの 6 けたを入れ直してください。');
  // 中継の形でない答え・約束の形でない答え・知らない符号は R15（管理者へ）。符号の文字そのものは文に入れない
  for (const c of ['not-ready', 'server', 'bad-reply', 'bad-request', 'too-large', 'write', '__proto__', '']) {
    assert.strictEqual(M(c), '文字起こしの中継の準備ができていません。管理者に知らせてください。', c);
  }
  assert.strictEqual(M('code'), '確認コードが違います。メールの 6 けたを入れ直してください。', '残りの回数が無いときは括弧ごと外す');
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
  assert.strictEqual(L.segmentBaseMs('long', 120), 120000);
  assert.strictEqual(L.segmentBaseMs('short', 120), 15000, 'オンラインの 15 秒は設定の長さに引きずられない');
});

test('D16: 経路の切り替えは同じ側が2区間続いてから（行ったり来たりしない）。ログイン切れ・上限・PC の中だけはすぐ長い側', { timeout: 5000 }, () => {
  let st = { mode: 'short', localRun: 0, cloudRun: 0 };
  const step = (route, why = route === 'cloud' ? 'ok' : 'net') => (st = L.segmentModeNext(st, { route, why })).mode;
  assert.deepStrictEqual(['local', 'cloud', 'local', 'cloud'].map((r) => step(r)), ['short', 'short', 'short', 'short']);
  assert.deepStrictEqual(['local', 'local'].map((r) => step(r)), ['short', 'long']);
  assert.deepStrictEqual(['cloud', 'local', 'cloud', 'cloud'].map((r) => step(r)), ['long', 'long', 'long', 'short']);
  for (const why of ['login', 'daily-cap', 'quota', 'upstream-auth', 'signed-out', 'local-only']) {
    assert.strictEqual(L.segmentModeNext({ mode: 'short', localRun: 0, cloudRun: 5 }, { route: 'local', why }).mode, 'long', why);
  }
  assert.strictEqual(L.segmentModeNext({ mode: 'short', localRun: 0, cloudRun: 5 }, { route: 'local', why: 'server' }).mode, 'short', '1 区間の 502 で替えた');
});

test('D16: 途中で送る長さは録音バーと同じく 20〜300 秒に丸める。始めの 15 秒のままなら送らない。75 秒の会議の背圧は今と同じ', { timeout: 5000 }, () => {
  const ov = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'overlay.html'), 'utf8');
  assert.match(ov, /const SEG_MIN_MS = 20000, SEG_MAX_MS = 300000;/, '録音バーの丸めが変わった（mainlib の写しを合わせる）');
  assert.strictEqual(L.OVERLAY_SEG_MIN_MS, 20000);
  const n = L.nextLiveSegmentMs;
  assert.strictEqual(n(0, 15000, 15000, -1), 15000, '始めの 15 秒のまま');
  assert.strictEqual(n(4, 15000, 15000, 1), 30000, '背圧で倍');
  assert.strictEqual(n(1, 30000, 15000, -1), 20000, '戻すときは録音バーの下限の 20 秒');
  assert.strictEqual(n(1, 20000, 15000, -1), 20000, '同じ値（送らない）');
  assert.strictEqual(n(2, 20000, 75000, 0), 75000, '長い側へは待ちが残っていてもすぐ');
  assert.strictEqual(n(6, 300000, 15000, 1), 300000, '上限');
  for (const [p, c, d] of [[4, 75000, 1], [5, 150000, 1], [3, 150000, 1], [2, 150000, -1], [1, 300000, -1], [0, 75000, -1]]) {
    assert.strictEqual(n(p, c, 75000, d), L.nextSegmentMs(p, c, 75000, d), `75 秒の会議の背圧が変わった ${[p, c, d]}`);
  }
});
