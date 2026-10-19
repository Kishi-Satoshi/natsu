/* stage1d.lib.test.js — 第1d回 D16・D17 の mainlib の純粋な関数（区切りの長さ・止まりの見張り・帯の選び方・知らせの間引き・再起動を断る理由）と、A-2 のログインの文（accountMessage） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/mainlib');

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
