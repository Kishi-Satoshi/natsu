/*
 * stage181.main.test.js — 0.18.1（計画 docs/plans/2026-11-25-181.md）の main の場面。偽の Electron の上で main.js を本当に動かして確かめる
 * （helpers/mainrun.js。論理 CPU の数は --cpus、優先度は out.prioCalls と --prio=fail）。
 *  PF-1: 起こしたエンジンのスレッドの数（既定と前の版の既定の移し。メモリの中だけ）・優先度（通常より低い。失敗しても起こす）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args, { scale = '0.005', env = {} } = {}) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], {
    env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001', NATSU_TEST_LOCAL_TIME_SCALE: scale, ...env },
    maxBuffer: 1 << 24, timeout: 20000,
  }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});
const T = { timeout: sceneTimeout(20000) };
const whisperSpawns = (o) => (o.spawns || []).filter((s) => /fake-whisper\.js$/.test(s.cmd) || /whisper-server/.test(s.cmd));
const threadsOf = (s) => { const i = s.args.indexOf('-t'); return i >= 0 ? s.args[i + 1] : null; };
const add = (o) => `--settings-add=${JSON.stringify(o)}`;
const brief = (o) => JSON.stringify({ spawns: o.spawns, prioCalls: o.prioCalls, engineLog: o.engineLog }, null, 1);

// ---------------------------------------------------------------- PF-1（決めたこと 1〜3）
test('PF-1 前の版の設定: 前の既定のままのスレッドの数（論理 CPU 12 の 10・6、論理 CPU 4 の 4）は新しい既定（4・2）で起こす。選んだ数（8）・無いとき（既定 4）はそのまま。settings.json は書き換えない（メモリの中だけ）', T, async () => {
  const [old10, old6, chose8, none12, old4] = await Promise.all([
    run(['text', '--segs=1', '--cpus=12', add({ localThreads: 10 })]),
    run(['text', '--segs=1', '--cpus=12', add({ localThreads: 6 })]),
    run(['text', '--segs=1', '--cpus=12', add({ localThreads: 8 })]),
    run(['text', '--segs=1', '--cpus=12']),
    run(['text', '--segs=1', '--cpus=4', add({ localThreads: 4 })]),
  ]);
  const t = (o) => whisperSpawns(o).map(threadsOf);
  assert.ok(whisperSpawns(old10).length >= 1, brief(old10));
  assert.deepStrictEqual(t(old10).filter((x) => x !== '4'), [], brief(old10));
  assert.deepStrictEqual(t(old6).filter((x) => x !== '4'), [], brief(old6));
  assert.ok(t(chose8).length >= 1 && t(chose8).every((x) => x === '8'), brief(chose8));
  assert.ok(t(none12).length >= 1 && t(none12).every((x) => x === '4'), brief(none12));
  assert.ok(t(old4).length >= 1 && t(old4).every((x) => x === '2'), brief(old4));
  // 書き戻さない・知らせない（［設定］を保存すると新しい数が書かれる）
  assert.strictEqual(old10.savedSettings.localThreads, 10);
  assert.strictEqual(old4.savedSettings.localThreads, 4);
  assert.ok(!old10.engineLog.some((l) => /スレッド/.test(l)), old10.engineLog.join('\n'));
});

test('PF-1 起こしたエンジンの優先度: 起こした whisper の番号で os.setPriority(PRIORITY_BELOW_NORMAL) を呼ぶ。断られても（Linux の CI の権限）起こすのは止めず、engine.log に1行だけ', T, async () => {
  const [ok, fail] = await Promise.all([
    run(['text', '--segs=1']),
    run(['text', '--segs=1', '--prio=fail']),
  ]);
  const n = whisperSpawns(ok).length;
  assert.ok(n >= 1, brief(ok));
  assert.strictEqual(ok.prioCalls.length, n, brief(ok));
  for (const c of ok.prioCalls) assert.ok(c.kid === true && c.priority === os.constants.priority.PRIORITY_BELOW_NORMAL, brief(ok));
  assert.ok(!ok.engineLog.some((l) => /優先度/.test(l)), ok.engineLog.join('\n'));
  // 断られた: 起こして文字にした。記録は起こした回数だけ（文は1つの形）
  assert.ok(fail.prioCalls.length >= 1, brief(fail));
  assert.ok(fail.pages[0].segments.length === 1 && !fail.pages[0].segments[0].failed, JSON.stringify(fail.pages));
  const lines = fail.engineLog.filter((l) => /優先度/.test(l));
  assert.strictEqual(lines.length, fail.prioCalls.length, fail.engineLog.join('\n'));
  for (const l of lines) assert.strictEqual(l, '文字起こしエンジン: 優先度を下げられませんでした（EACCES）。通常の優先度のまま動かします');
});
