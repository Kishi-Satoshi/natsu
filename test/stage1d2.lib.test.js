/* stage1d2.lib.test.js — 第1d2回（NaTsu 0.9.0 のレーン A。設計書 D21: オフラインの準備を任意にする）の mainlib の純粋な関数
 * （準備を選んだか・クラウドが使えそうか・会議と音声入力の始め方）と、新しい文の字面 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/mainlib');
const T = { timeout: 5000 };

// 音声入力を始めない文（計画「画面と知らせの文」の D1〜D3）
const D1 = 'インターネットにつながっていないため、音声入力を始めませんでした。オンラインに戻ってから、もう一度お試しください。オフラインでも使うには、設定の「オフライン」で準備します。';
const D2 = 'ログインしていないため、音声入力を始めませんでした。設定の「アカウント」でログインしてください。';
const D3 = '文字起こしの中継が今は使えないため、音声入力を始めませんでした。少し待ってから、もう一度お試しください。';

// ---------------------------------------------------------------- M-1（OF1・F4・F5・F10）
test('F10: offlineChosen は手のパス・取り込んだ組の候補・同意・取り込み中のどれか1つで真、どれも無ければ偽', T, () => {
  const none = { manual: false, managedCand: false, consent: false, fetching: false };
  assert.strictEqual(L.offlineChosen(none), false, 'どれも無い');
  for (const k of ['manual', 'managedCand', 'consent', 'fetching']) {
    assert.strictEqual(L.offlineChosen({ ...none, [k]: true }), true, `${k} だけ`);
  }
});

test('OF1: cloudLikely は startSegmentMode の short とちょうど同じ答え（ログイン 2・hold 2・net.isOnline() 2・覚えている /health の true・false・null の 3 で 24 通り）', T, () => {
  let n = 0;
  for (const signedIn of [true, false]) {
    for (const hold of ['', 'daily-cap']) {
      for (const netOnline of [true, false]) {
        for (const peekUp of [true, false, null]) {
          const o = { signedIn, hold, netOnline, peekUp };
          const want = signedIn && !hold && netOnline && peekUp !== false;
          assert.strictEqual(L.cloudLikely(o), want, JSON.stringify(o));
          assert.strictEqual(L.cloudLikely(o), L.startSegmentMode({ localOnly: false, ...o }) === 'short', JSON.stringify(o));
          n += 1;
        }
      }
    }
  }
  assert.strictEqual(n, 24);
});

test('OF1: startPlan — 手元が使える・クラウドが使えそう → 始める。選んだ人で両方だめ → 今の文で始めない。選んでいない人で両方だめ → 始めて音声を残す（ログインしていない・切れた → login、ほか → wait）', T, () => {
  const problem = '文字起こしエンジンが未設定です。設定タブの［PC の中の文字起こしを取り込む］から取り込んでください。';
  const P = (o) => L.startPlan({ localUsable: false, chosen: false, cloud: false, problem, why: 'offline', ...o });
  for (const chosen of [true, false]) {
    assert.deepStrictEqual(P({ chosen, localUsable: true }), { ok: true, keep: '' }, `手元が使える（chosen ${chosen}）`);
    assert.deepStrictEqual(P({ chosen, cloud: true, why: '' }), { ok: true, keep: '' }, `クラウドが使えそう（chosen ${chosen}）`);
  }
  for (const why of ['offline', 'signed-out', 'login', 'relay-down', 'daily-cap']) {
    assert.deepStrictEqual(P({ chosen: true, why }), { ok: false, error: problem }, `選んだ人は今の文で始めない（${why}）`);
  }
  assert.deepStrictEqual(P({ why: 'signed-out' }), { ok: true, keep: 'login' });
  assert.deepStrictEqual(P({ why: 'login' }), { ok: true, keep: 'login' });
  for (const why of ['offline', 'relay-down', 'daily-cap', 'quota', 'upstream-auth']) assert.deepStrictEqual(P({ why }), { ok: true, keep: 'wait' }, why);
});

test('OF1: dictationPlan — 選んでいない人で両方だめなら D1・D2（signin）・D3 で始めない。選んだ人は今の文。手元が使えるかクラウドが使えそうなら始める', T, () => {
  const problem = '文字起こしエンジンが未設定です。設定タブでパスを指定してください。';
  const P = (o) => L.dictationPlan({ localUsable: false, chosen: false, cloud: false, problem, why: 'offline', ...o });
  for (const chosen of [true, false]) {
    assert.deepStrictEqual(P({ chosen, localUsable: true }), { ok: true });
    assert.deepStrictEqual(P({ chosen, cloud: true, why: '' }), { ok: true });
  }
  for (const why of ['offline', 'signed-out', 'relay-down']) assert.deepStrictEqual(P({ chosen: true, why }), { ok: false, error: problem }, why);
  assert.deepStrictEqual(P({ why: 'offline' }), { ok: false, error: D1 });
  assert.deepStrictEqual(P({ why: 'signed-out' }), { ok: false, error: D2, action: 'signin' });
  assert.deepStrictEqual(P({ why: 'login' }), { ok: false, error: D2, action: 'signin' });
  for (const why of ['relay-down', 'daily-cap', 'quota', 'upstream-auth']) assert.deepStrictEqual(P({ why }), { ok: false, error: D3 }, why);
});
