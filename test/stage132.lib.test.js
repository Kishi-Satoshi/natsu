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

// ---------------------------------------------------------------- LN-4（LA1・PQ1〜PQ3・LR3）
test('LN-4: loginAskPlan の表（boot・meeting・dictation × オンライン・オフライン × ログインしている・していない・切れた・復号できない × 今はしない × オフラインモード × 準備を選んだ・選んでいない（LR3: boot だけ） × もう開いている）', T, () => {
  const P = (o) => lib.loginAskPlan({ moment: 'meeting', online: true, signedIn: false, why: 'signed-out', snoozed: false, localOnly: false, chosen: true, showing: false, ...o });
  for (const moment of ['boot', 'meeting', 'dictation']) {
    for (const why of ['signed-out', 'login', 'key-unreadable']) assert.deepStrictEqual(P({ moment, why }), { ask: true }, `${moment}・${why}`);
    assert.deepStrictEqual(P({ moment, online: false }), { ask: false }, `${moment}: オフラインで開いた`);
    assert.deepStrictEqual(P({ moment, signedIn: true, why: '' }), { ask: false }, `${moment}: ログインしているのに開いた`);
    assert.deepStrictEqual(P({ moment, snoozed: true }), { ask: false }, `${moment}: × で閉じた後に開いた（PQ3）`);
    assert.deepStrictEqual(P({ moment, showing: true }), { ask: false }, `${moment}: もう開いているのに開いた`);
  }
  // オフラインモードの会議では開かない（会議・音声入力の始め）
  assert.deepStrictEqual(P({ moment: 'meeting', localOnly: true }), { ask: false });
  // LR3: 準備を選んでいない PC の起動は今どおり設定の「アカウント」（窓は開かない）。会議・音声入力の始めには開く
  assert.deepStrictEqual(P({ moment: 'boot', chosen: false }), { ask: false });
  assert.deepStrictEqual(P({ moment: 'meeting', chosen: false }), { ask: true });
  assert.deepStrictEqual(P({ moment: 'dictation', chosen: false }), { ask: true });
  // 知らない時・形の悪い引数は開かない
  assert.deepStrictEqual(P({ moment: 'patrol' }), { ask: false });
  assert.deepStrictEqual(lib.loginAskPlan(), { ask: false });
  assert.deepStrictEqual(lib.loginAskPlan(null), { ask: false });
});

// 0.13.2 点検の直し 2（LR37）: 起動の仕事（startupWork）が遅れて済んだとき、会議か音声入力が動いている・始まっている（recording）なら、起動の窓は開かない
// （録音の途中に開かない。オフラインモードの会議の途中にも）。会議・音声入力の始めの窓は今どおり（recording はその後に真になる）
test('LN-4・点検の直し 2: loginAskPlan は、録音中（recording）の boot では開かない。録音していない boot と、meeting・dictation は recording に関わらず今どおり', T, () => {
  const P = (o) => lib.loginAskPlan({ moment: 'boot', online: true, signedIn: false, why: 'signed-out', snoozed: false, localOnly: false, chosen: true, showing: false, ...o });
  assert.deepStrictEqual(P({ recording: true }), { ask: false }, '録音中に起動の窓を開いた');
  assert.deepStrictEqual(P({ recording: false }), { ask: true });
  assert.deepStrictEqual(P({}), { ask: true });
  for (const moment of ['meeting', 'dictation']) assert.deepStrictEqual(P({ moment, recording: true }), { ask: true }, `${moment}: 始めた後の窓を止めた`);
});

// ---------------------------------------------------------------- LN-7（パネルの位置の答え「下の中央、録音バーと同じ高さ」・LR22）
test('LN-7: nudgeBounds の表（作業領域の下の中央・カードの下の端が 12px・左右の真ん中・整数。左と上の画面・タスクバーが上と左・メニューを開くと上へ伸びる・大きすぎる・大きさが無い）', T, () => {
  const P = lib.NUDGE_PAD, E = lib.NUDGE_EDGE;
  assert.strictEqual(E, 12);
  const ints = (b) => assert.ok(['x', 'y', 'width', 'height'].every((k) => Number.isInteger(b[k])), JSON.stringify(b));
  const card = (b, wa, w, h) => {
    ints(b);
    assert.strictEqual(b.y + P + h, wa.y + wa.height - E, `カードの下の端が作業領域の下の端から 12px でない: ${JSON.stringify(b)}`);
    const mid = b.x + P + w / 2;
    assert.ok(Math.abs(mid - (wa.x + wa.width / 2)) <= 0.5, `カードの左右の真ん中が作業領域の真ん中でない: ${mid}`);
  };
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const b = lib.nudgeBounds({ size: { w: 520.4, h: 60 }, workArea: wa });
  assert.deepStrictEqual([b.width, b.height], [521 + 2 * P, 60 + 2 * P]);
  card(b, wa, 521, 60);
  assert.strictEqual(b.y + P + 60, 1040 - 12);
  // 左の画面（x が負）・上の画面（y が負）・タスクバーが上（y: 48）と左（x: 64）の作業領域
  for (const w of [{ x: -1280, y: 0, width: 1280, height: 984 }, { x: 0, y: -1080, width: 1920, height: 1040 }, { x: 0, y: 48, width: 1920, height: 1032 }, { x: 64, y: 0, width: 1856, height: 1080 }]) {
    card(lib.nudgeBounds({ size: { w: 400, h: 60 }, workArea: w }), w, 400, 60);
  }
  // メニューを開いて大きさが変わる（h: 200）と、下の端はそのままで y が小さくなる
  const open = lib.nudgeBounds({ size: { w: 520.4, h: 200 }, workArea: wa });
  card(open, wa, 521, 200);
  assert.strictEqual(open.y + open.height, b.y + b.height, '大きさが変わって下の端が動いた');
  assert.ok(open.y < b.y);
  // 大きすぎる大きさは作業領域 − 2 × (12 − 余白) で切る（下の端から 12px のまま）
  const small = { x: 0, y: 0, width: 300, height: 100 };
  const c = lib.nudgeBounds({ size: { w: 5000, h: 5000 }, workArea: small });
  assert.deepStrictEqual(c, { x: E - P, y: E - P, width: 300 - 2 * (E - P), height: 100 - 2 * (E - P) });
  // 大きさが無い・壊れている → 決まった初めの大きさ
  for (const size of [null, undefined, {}, { w: 0, h: 10 }, { w: NaN, h: 1 }, { w: -1, h: 5 }, { w: '400', h: '60' }]) {
    assert.deepStrictEqual(lib.nudgeBounds({ size, workArea: wa }), lib.nudgeBounds({ size: lib.NUDGE_FIRST, workArea: wa }), JSON.stringify(size));
  }
});
