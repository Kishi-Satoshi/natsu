/*
 * stage132.lib.test.js — 0.13.2 の純粋な部品（計画 docs/plans/2026-10-28-132.md の Task LN-2〜LN-4・LN-7。src/mainlib.js）
 * LN-2: pendingLeft（残りの区間の数。音声の残っている区間の全部: PQ4）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lib = require('../src/mainlib.js');

const T = { timeout: 5000 };

// ---------------------------------------------------------------- LN-2（PQ4・LR10）
test('LN-2: pendingLeft の表（音声の無い区間は数えない・文字起こし待ち・失敗・止まった（stall）・held は数える: PQ4）', T, () => {
  const wav = (id, o = {}) => ({ id, wav: `/segbuf/1/${id}.wav`, durationMs: 3000, ...o });
  assert.strictEqual(lib.pendingLeft([]), 0);
  assert.strictEqual(lib.pendingLeft(null), 0);
  assert.strictEqual(lib.pendingLeft(undefined), 0);
  // 文字起こし待ち・失敗（tries）・止まった区間（待ち行列では同じ形）・held はどれも数える
  assert.strictEqual(lib.pendingLeft([wav('s1'), wav('s2', { tries: 1 }), wav('s3', { tries: 3, held: true }), wav('s4')]), 4);
  // 音声の無い区間（wav が無い・空・形の悪い行）は数えない
  assert.strictEqual(lib.pendingLeft([wav('s1'), { id: 's2', durationMs: 3000 }, { id: 's3', wav: '' }, null, 'x', wav('s4')]), 2);
  // 音声があるかの見方を渡せる（main はファイルがあるかで見る）: 消えた音声は数えない
  const gone = new Set(['/segbuf/1/s2.wav']);
  assert.strictEqual(lib.pendingLeft([wav('s1'), wav('s2'), wav('s3', { held: true })], (it) => !gone.has(it.wav)), 2);
  // 受けた物を変えない
  const list = [wav('s1', { held: true })];
  const frozen = JSON.stringify(list);
  lib.pendingLeft(list);
  assert.strictEqual(JSON.stringify(list), frozen);
});

// ---------------------------------------------------------------- LN-3（LA2・LR6・決めたこと 4・5）
test('LN-3: loginProblem の表（signed-out・key-unreadable × オンライン → no-login。オフライン・オフラインモード・ok・login → \'\'）', T, () => {
  const P = lib.loginProblem;
  for (const why of ['signed-out', 'key-unreadable']) {
    assert.strictEqual(P({ why, online: true, localOnly: false }), 'no-login', why);
    assert.strictEqual(P({ why, online: true }), 'no-login', `${why}（localOnly が無い）`);
    assert.strictEqual(P({ why, online: false, localOnly: false }), '', `${why}: オフラインで帯にした（RL14）`);
    assert.strictEqual(P({ why, online: true, localOnly: true }), '', `${why}: オフラインモードの会議で帯にした`);
  }
  for (const why of ['ok', 'login', 'offline', 'local-only', 'relay-down', 'daily-cap', '', undefined]) assert.strictEqual(P({ why, online: true, localOnly: false }), '', String(why));
  assert.strictEqual(P(), '');
  assert.strictEqual(P(null), '');
  // 帯にしない理由の表（PROBLEM_FOR_WHY）は変えない（ログインしていないは中継の帯にしない: ra-problem-offline のまま）
  assert.strictEqual(lib.problemForRoute({ route: 'local', why: 'signed-out' }), '');
  assert.strictEqual(lib.problemForRoute({ route: 'local', why: 'key-unreadable' }), '');
});

test('LN-3: PROBLEM_ORDER の頭は no-login・login・kept-login で、kept-late と no-login が両方あれば no-login（帯は1つ）', T, () => {
  assert.deepStrictEqual(lib.PROBLEM_ORDER.slice(0, 3), ['no-login', 'login', 'kept-login']);
  assert.deepStrictEqual(lib.PROBLEM_ORDER, ['no-login', 'login', 'kept-login', 'engine-down', 'kept-late', 'stall', 'kept-local', 'kept-relay', 'kept-wait', 'seg-failed', 'net-offline',
    'relay-off', 'daily-cap', 'relay-blocked', 'relay-down', 'relay-busy', 'wait']);
  assert.strictEqual(lib.sttProblemOf(new Map([['kept-late', { offline: false }], ['no-login', {}]])).code, 'no-login');
  assert.strictEqual(lib.sttProblemOf(new Map([['engine-down', {}], ['stall', { sec: 30 }], ['no-login', {}]])).code, 'no-login');
  assert.strictEqual(lib.sttProblemOf(new Map([['kept-late', {}], ['kept-login', {}]])).code, 'kept-login');
  assert.strictEqual(lib.sttProblemOf(new Map([['kept-late', {}]])).code, 'kept-late');
});
