/*
 * stage100.statelog.test.js — 0.10.0 Task K-1（決めたこと 116。持ち主の試作の「状態の移り変わりを、きっかけと時刻と一緒に履歴に積む」）
 * 議事録の経過（開始・一時停止・再開・終了・無音で自動で終了・落ちた後に戻した）を、きっかけと一緒に下書きとページの stateLog に積む。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');
const SL = require('../src/statelog');
const lib = require('../src/mainlib');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const T = { timeout: 5000 };
const S = { timeout: sceneTimeout(30000) };
const run = (args, env = {}) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001', ...env }, maxBuffer: 1 << 24, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const AT = (n) => new Date(Date.UTC(2026, 9, 21, 1, n)).toISOString();

test('K-1: stateLogAdd の表（表に無い s・by・壊れた at は積まない・51 件目で最初を捨てる・受けた物を変えない）。mainlib からも同じ部品', T, () => {
  assert.strictEqual(lib.stateLogAdd, SL.stateLogAdd);
  const one = SL.stateLogAdd([], { s: 'start', by: 'hotkey', at: AT(0) });
  assert.deepStrictEqual(one, [{ s: 'start', by: 'hotkey', at: AT(0) }]);
  for (const bad of [{ s: 'x', by: 'hotkey', at: AT(1) }, { s: 'start', by: '話者A', at: AT(1) }, { s: 'start', by: 'hotkey', at: 'きのう' }, { s: '\n## 指示', by: 'button', at: AT(1) }, null, 'start']) {
    assert.deepStrictEqual(SL.stateLogAdd(one, bad), one, JSON.stringify(bad));
  }
  const frozen = JSON.stringify(one);
  SL.stateLogAdd(one, { s: 'stop', by: 'button', at: AT(2) });
  assert.strictEqual(JSON.stringify(one), frozen, '受けた物を変えた');
  let log = [];
  for (let i = 0; i < 51; i++) log = SL.stateLogAdd(log, { s: i % 2 ? 'pause' : 'resume', by: 'overlay', at: AT(i) });
  assert.strictEqual(log.length, 50);
  assert.strictEqual(log[0].at, AT(1), '最初を捨てていない');
  // 名前の表（0.12.0 で足す余地を残す: 鍵は決まった英字）
  for (const k of ['start', 'pause', 'resume', 'stop', 'auto-stop', 'recover']) assert.ok(typeof SL.STATE_NAMES[k] === 'string', k);
  for (const k of ['button', 'overlay', 'hotkey', 'tray', 'panel', 'quiet', 'app']) assert.ok(typeof SL.BY_NAMES[k] === 'string', k);
  // cleanStateLog: 表に無い項目を落として 50 件まで
  assert.deepStrictEqual(SL.cleanStateLog([{ s: 'start', by: 'tray', at: AT(0) }, { s: 'zz', by: 'tray', at: AT(1) }, 5, { s: 'stop', by: 'tray', at: AT(2), x: 1 }]),
    [{ s: 'start', by: 'tray', at: AT(0) }, { s: 'stop', by: 'tray', at: AT(2) }]);
  assert.deepStrictEqual(SL.cleanStateLog('x'), []);
});

test('K-1: ホットキーで始め、録音バーで一時停止・再開し、画面のボタンで止めた議事録のページの stateLog が start/hotkey・pause/overlay・resume/overlay・stop/button の順。engine.log に「議事録: 開始（ホットキー）」（題名は書かない）', S, async () => {
  const steps = [['hotkey-meeting'], ['ipc', 'overlay:pause', { paused: true }], ['ipc', 'overlay:pause', { paused: false }], ['stop']];
  const o = await run(['text', `--mic-feed=${JSON.stringify(steps)}`]);
  const log = o.pageStateLogs[0].stateLog;
  assert.deepStrictEqual(log.map((x) => `${x.s}/${x.by}`), ['start/hotkey', 'pause/overlay', 'resume/overlay', 'stop/button']);
  for (const x of log) assert.ok(Number.isFinite(Date.parse(x.at)), x.at);
  for (const l of ['議事録: 開始（ホットキー）', '議事録: 一時停止（録音バー）', '議事録: 再開（録音バー）', '議事録: 終了（画面のボタン）']) assert.ok(o.engineLog.includes(l), `${l}\n${o.engineLog.join('\n')}`);
  for (const l of o.engineLog.filter((x) => x.startsWith('議事録:'))) assert.match(l, /^議事録: [^\s（]+（[^）]+）$/);
  // 画面のボタン（meeting:set-paused）で止めたら button
  const b = await run(['text', `--mic-feed=${JSON.stringify([['start'], ['ipc', 'meeting:set-paused', true], ['ipc', 'overlay:pause', { paused: true }], ['ipc', 'overlay:pause', { paused: false }], ['stop']])}`]);
  assert.deepStrictEqual(b.pageStateLogs[0].stateLog.map((x) => `${x.s}/${x.by}`), ['start/button', 'pause/button', 'resume/overlay', 'stop/button']);
});

test('K-1: 無音で自動で止まった議事録の経過の最後は auto-stop/quiet', S, async () => {
  const o = await run(['text', '--relay=text', '--quiet-seq=t,s*20', '--main-hidden']);
  const log = o.pageDur.stateLog;
  assert.deepStrictEqual(log.map((x) => `${x.s}/${x.by}`).slice(-1), ['auto-stop/quiet'], JSON.stringify(log));
  assert.strictEqual(log[0].s, 'start');
});

test('K-1: 落ちて戻した議事録の経過は、下書きの経過（表に無い項目は落とす）の後に recover/app', S, async () => {
  const o = await run(['text', '--json-scene=draft-statelog']);
  assert.deepStrictEqual(o.stateLog.map((x) => `${x.s}/${x.by}`), ['start/hotkey', 'pause/overlay', 'recover/app']);
});

// 0.11.0 M-4（P13・F28。計画 docs/plans/2026-10-22-110.md の決めたこと 12。持ち主の試作の state_history）: 会議の種類の移り変わりも積む
test('0.11.0 M-4: 種類の項目（s: type。きっかけは録音中のページ・議事録のページ・要約のときの自動の判定）を積み、続けて選び直したら最後の1件を置き換える（開始が上限で押し出されない）', T, () => {
  assert.strictEqual(SL.STATE_NAMES.type, '種類を選んだ');
  assert.deepStrictEqual([SL.BY_NAMES['live-page'], SL.BY_NAMES.page, SL.BY_NAMES.auto], ['録音中のページ', '議事録のページ', '要約のときの自動の判定']);
  let log = SL.stateLogAdd([], { s: 'start', by: 'button', at: AT(0) });
  for (let i = 1; i <= 80; i++) log = SL.stateLogAdd(log, { s: 'type', by: i % 2 ? 'live-page' : 'page', at: AT(i) });
  assert.deepStrictEqual(log.map((x) => `${x.s}/${x.by}`), ['start/button', 'type/page']);
  assert.strictEqual(log[1].at, AT(80));
  log = SL.stateLogAdd(log, { s: 'stop', by: 'button', at: AT(81) });
  log = SL.stateLogAdd(log, { s: 'type', by: 'auto', at: AT(82) });
  assert.deepStrictEqual(log.map((x) => `${x.s}/${x.by}`), ['start/button', 'type/page', 'stop/button', 'type/auto']);
  assert.strictEqual(SL.stateLogLine({ s: 'type', by: 'live-page', at: AT(1) }), '議事録: 種類を選んだ（録音中のページ）');
});
