/*
 * stage121.main.test.js — 0.12.1 の main の場面（計画 docs/plans/2026-10-24-121.md の Task LV-2・LV-3）
 * LV-2: 議事録の録音中も会議の検出の見張りを動かし、見張る会議のアプリ（W）を決める（設定「会議を出たら自動で止める」。記録にアプリの名前を書かない）。
 * 場面は helpers/mainrun.js を別のプロセスで回す（--mic-feed。見張りは偽の子で、場面が行を書く。偽の時計 ["clock", ms] で読みの間を作る）。
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
// 見張りの1行を書いて、偽の時計を 2 秒進める（本物の見張りの読みの間）
const L = (s) => [['line', s], ['clock', 2000]];
const Ls = (s, n) => Array.from({ length: n }, () => L(s)).flat();
const FOUND = '会議を出たかの見張り: 会議のアプリがマイクを使っているのを見た（この録音で見張る）';
// 記録・経過・知らせに出てはいけないアプリの名前（0.9.3 の K3）
const NAMES = /Teams|teams|Zoom|zoom|ms-teams|Chrome|chrome|Edge|msedge/;
const noNames = (o) => {
  for (const l of o.engineLog) assert.ok(!NAMES.test(l), `engine.log にアプリの名前: ${l}`);
  assert.ok(!NAMES.test(JSON.stringify(o.pageStateLogs)), JSON.stringify(o.pageStateLogs));
};
const PANEL = (id) => [...L(`mic ${id}:1`), ...L(`mic ${id}:1`), ['wait-show', 1], ['ipc', 'nudge:start', {}]];

// ---------------------------------------------------------------- LV-2（決めたこと L2・L3・L14〜L17・L19〜L21）
test('LV-2（L16）: 議事録の録音中も見張りが動く（止めない）・idle に戻っても起こし直さない・音声入力では止める', S, async () => {
  const steps = [['snap', 'boot'], ['start'], ['snap', 'meeting'], ['stop'], ['snap', 'idle'], ['dictate'], ['snap', 'dictate'], ['dictate-cancel'], ['snap', 'after']];
  const o = await run(steps);
  assert.deepStrictEqual([o.snaps.boot.spawns, o.snaps.boot.kills], [1, 0]);
  assert.strictEqual(o.snaps.meeting.active, true);
  assert.deepStrictEqual([o.snaps.meeting.spawns, o.snaps.meeting.kills], [1, 0], '議事録の録音中に見張りを止めた');
  assert.deepStrictEqual([o.snaps.idle.spawns, o.snaps.idle.kills], [1, 0], 'idle に戻るときに起こし直した');
  assert.deepStrictEqual([o.snaps.dictate.spawns, o.snaps.dictate.kills], [1, 1], '音声入力の録音中も見張りが動いている');
  assert.deepStrictEqual([o.snaps.after.spawns, o.snaps.after.kills], [2, 1]);
  // 設定「会議を出たら自動で止める」がオフなら 0.9.3 のまま（議事録の録音中は止める）
  const off = await run(steps, '--leave=off');
  assert.deepStrictEqual([off.snaps.meeting.spawns, off.snaps.meeting.kills], [1, 1], '--leave=off なのに議事録の録音中も見張りが動いている');
  assert.deepStrictEqual([off.snaps.idle.spawns, off.snaps.idle.kills], [2, 1]);
  // 「会議の検出の通知」を切っていても、録音中だけ起こし、idle では起こさない
  const det = await run(steps, '--detect=off');
  assert.deepStrictEqual([det.snaps.boot.spawns, det.snaps.boot.kills], [0, 0]);
  assert.deepStrictEqual([det.snaps.meeting.spawns, det.snaps.meeting.kills], [1, 0], '録音中に起こさない');
  assert.deepStrictEqual([det.snaps.idle.spawns, det.snaps.idle.kills], [1, 1], 'idle に戻っても止めない');
  assert.deepStrictEqual([det.snaps.after.spawns, det.snaps.after.kills], [1, 1]);
});

test('LV-2（L3）: パネルから始めた Teams・Chrome は初めから見張る（記録に1行）', S, async () => {
  for (const id of ['teams', 'chrome']) {
    const o = await run([...PANEL(id), ...Ls(`mic ${id}:1`, 3)]);
    assert.strictEqual(o.active, true, id);
    assert.strictEqual(o.engineLog.filter((l) => l === FOUND).length, 1, `${id}: ${o.engineLog.join('\n')}`);
    noNames(o);
  }
});

test('LV-2（L3・LQ5）: ホットキーで始めて後から Zoom が2回続けて見えたら見張る（1回だけなら見張らない）。Firefox は何回見えても見張らない', S, async () => {
  const two = await run([['hotkey-meeting'], ...Ls('mic zoom:7', 2), ...Ls('mic zoom:7', 2)]);
  assert.strictEqual(two.active, true);
  assert.strictEqual(two.engineLog.filter((l) => l === FOUND).length, 1, two.engineLog.join('\n'));
  noNames(two);
  const one = await run([['hotkey-meeting'], ...L('mic zoom:7'), ...L('mic -'), ...L('mic zoom:7'), ...L('mic -')]);
  assert.ok(!one.engineLog.includes(FOUND), one.engineLog.join('\n'));
  const ff = await run([['hotkey-meeting'], ...Ls('mic firefox:3', 5)]);
  assert.ok(!ff.engineLog.includes(FOUND), ff.engineLog.join('\n'));
  // 会議のアプリを一度も見ていない録音（対面の会議）も見張らない
  const none = await run([['start'], ...Ls('mic -', 5)]);
  assert.ok(!none.engineLog.includes(FOUND), none.engineLog.join('\n'));
  assert.strictEqual(none.active, true);
});
