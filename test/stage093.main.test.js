/*
 * stage093.main.test.js — 0.9.3 の main の場面（計画 docs/plans/2026-10-22-093.md の Task M-2・M-3・M-5）
 * M-2: 会議の検出の見張り（Windows のマイクの記録を読む常駐の PowerShell）を起こす・止める・起こし直す。記録にアプリの名前を書かない。
 * 場面は helpers/mainrun.js を別のプロセスで回す（--mic-feed。見張りは偽の子で、場面が行を書く。NATSU_TEST_MIC_WATCH で Windows の外でも起こす）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const S = { timeout: sceneTimeout(20000) };
const run = (steps, ...flags) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, 'text', `--mic-feed=${JSON.stringify(steps)}`, ...flags], { env: { ...process.env }, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const Z = 'mic zoom:133713371337133713';
const NAMES = /zoom|teams|webex|slack|chrome|edge|firefox|Zoom|Teams|Webex|Slack|Chrome|Edge|Firefox|ブラウザ/;

test('M-2: 起動の時に設定がオンなら見張りを1つ起こす（powershell.exe -NoProfile -NonInteractive -Command・窓を出さない・中身に自分のパスと親の pid）。オフなら起こさない', S, async () => {
  const o = await run([['snap', 'boot']]);
  assert.strictEqual(o.micSpawns.length, 1, JSON.stringify(o.micSpawns));
  const sp = o.micSpawns[0];
  assert.strictEqual(sp.cmd, 'powershell.exe');
  assert.deepStrictEqual(sp.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.strictEqual(sp.opts.windowsHide, true);
  const script = sp.args[3];
  assert.ok(script.includes(`'${process.execPath.replace(/\\/g, '#').toLowerCase().replace(/'/g, "''")}'`), '自分のパスが無い');
  assert.ok(/GetProcessById\(\d+\)/.test(script), '親の pid が無い');
  assert.ok(o.engineLog.includes('会議の検出: 見張りを始めた'), o.engineLog.join('\n'));
  const off = await run([['snap', 'boot']], '--detect=off');
  assert.strictEqual(off.micSpawns.length, 0);
  assert.ok(!off.engineLog.some((l) => l.startsWith('会議の検出')), off.engineLog.join('\n'));
});

test('M-2: 録音を始めると見張りを止め、idle に戻ると起こす（議事録・音声入力）', S, async () => {
  const o = await run([['snap', 'boot'], ['start'], ['snap', 'meeting'], ['stop'], ['snap', 'idle'], ['dictate'], ['snap', 'dictate'], ['dictate-cancel'], ['snap', 'after']]);
  assert.deepStrictEqual([o.snaps.boot.spawns, o.snaps.boot.kills], [1, 0]);
  assert.strictEqual(o.snaps.meeting.active, true);
  assert.deepStrictEqual([o.snaps.meeting.spawns, o.snaps.meeting.kills], [1, 1], '議事録の録音中も見張りが動いている');
  assert.deepStrictEqual([o.snaps.idle.spawns, o.snaps.idle.kills], [2, 1], 'idle に戻っても見張りを起こさない');
  assert.deepStrictEqual([o.snaps.dictate.spawns, o.snaps.dictate.kills], [2, 2], '音声入力の録音中も見張りが動いている');
  assert.deepStrictEqual([o.snaps.after.spawns, o.snaps.after.kills], [3, 2]);
  assert.strictEqual(o.engineLog.filter((l) => l === '会議の検出: 見張りを止めた').length, 2);
});

test('M-2: 設定を切ると止め、入れると起こす', S, async () => {
  const o = await run([['save', { meetingDetect: false }], ['snap', 'off'], ['save', { meetingDetect: true }], ['snap', 'on']]);
  assert.deepStrictEqual([o.snaps.off.spawns, o.snaps.off.kills], [1, 1]);
  assert.deepStrictEqual([o.snaps.on.spawns, o.snaps.on.kills], [2, 1]);
  assert.strictEqual(JSON.parse(o.settingsText).meetingDetect, true);
});

test('M-2: 落ちたら 30 秒・2 分・10 分の後に起こし直し、4 回目に落ちたら設定のオンオフまで起こさない。行を受けたら数え直す', S, async () => {
  const o = await run([['exit', 1], ['sleep', 40], ['exit', 1], ['sleep', 40], ['exit', 1], ['sleep', 40], ['exit', 1], ['sleep', 40], ['snap', 'gave'],
    ['save', { meetingDetect: false }], ['save', { meetingDetect: true }], ['snap', 'again']]);
  assert.deepStrictEqual(o.restartDelays, [30000, 120000, 600000]);
  assert.strictEqual(o.snaps.gave.spawns, 4, '起こし直しの数が違う');
  assert.ok(o.engineLog.includes('会議の検出: 見張りが落ちたので 30 秒後に起こし直します'), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('会議の検出: 見張りが続けて落ちたので、次の起動か設定のオンオフまで起こしません'), o.engineLog.join('\n'));
  assert.strictEqual(o.snaps.again.spawns, 5, '設定を入れ直しても起こさない');
  const r = await run([['exit', 1], ['sleep', 40], [`line`, Z], ['exit', 1], ['sleep', 40]]);
  assert.deepStrictEqual(r.restartDelays, [30000, 30000], '行を受けた後も落ちた数を数え直していない');
});

test('M5・M-2: engine.log の見張りの行にアプリの名前と id が無い（読めない符号だけ）。終了で止める', S, async () => {
  const o = await run([['line', Z], ['line', Z], ['line', 'err read'], ['line', 'mic -'], ['line', 'mic teams:1,chrome:2'], ['quit']]);
  const lines = o.engineLog.filter((l) => l.startsWith('会議の検出'));
  assert.ok(lines.includes('会議の検出: マイクの記録を読めません（read）'), lines.join('\n'));
  assert.ok(!o.engineLog.some((l) => NAMES.test(l) && /会議|マイク|見張り/.test(l)), o.engineLog.join('\n'));
  assert.ok(o.micKills >= 1 && o.engineLog.includes('会議の検出: 見張りを止めた'), '終了で見張りを止めていない');
});
