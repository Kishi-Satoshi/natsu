/*
 * stage181.main.test.js — 0.18.1（計画 docs/plans/2026-11-25-181.md）の main の場面。偽の Electron の上で main.js を本当に動かして確かめる
 * （helpers/mainrun.js。論理 CPU の数は --cpus、優先度は out.prioCalls と --prio=fail）。
 *  PF-1: 起こしたエンジンのスレッドの数（既定と前の版の既定の移し。メモリの中だけ）・優先度（通常より低い。失敗しても起こす）
 *  PF-2: PC の中で文字起こしする会議の区切り（既定 30 秒・前の版の 75 秒の移し。メモリの中だけ）
 *  PF-3: 「遅い」の覚え（local-pace.json）の印。印の無い・違う覚えは会議の始めにも待ち時間にも使わない。書く覚えに印を書く
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

// ---------------------------------------------------------------- PF-2（決めたこと 4）
const starts = (o) => o.overlaySent.filter((x) => x && typeof x === 'object').map((x) => x.segmentSec);
test('PF-2 前の版の間隔: settings.json の 75 秒（前の版の既定）は 30 秒で始める（録音バーへの始めの segmentSec・記録の行）。選んだ 60 秒・無いとき（既定 30 秒）。settings.json は書き換えない', T, async () => {
  const [old75, chose60, none] = await Promise.all([
    run(['text', '--relay=text', '--offline', '--segs=1', add({ segmentSec: 75 })]),
    run(['text', '--relay=text', '--offline', '--segs=1', add({ segmentSec: 60 })]),
    run(['text', '--relay=text', '--offline', '--segs=1']),
  ]);
  assert.deepStrictEqual(starts(old75), [30], JSON.stringify(old75.overlaySent));
  assert.ok(old75.engineLog.includes('文字起こしの状態: 区切り 30 秒（long・理由 start）'), old75.engineLog.join('\n'));
  assert.strictEqual(old75.savedSettings.segmentSec, 75);
  assert.deepStrictEqual(starts(chose60), [60], JSON.stringify(chose60.overlaySent));
  assert.ok(chose60.engineLog.includes('文字起こしの状態: 区切り 60 秒（long・理由 start）'), chose60.engineLog.join('\n'));
  assert.deepStrictEqual(starts(none), [30], JSON.stringify(none.overlaySent));
  assert.ok(none.engineLog.includes('文字起こしの状態: 区切り 30 秒（long・理由 start）'), none.engineLog.join('\n'));
});

// ---------------------------------------------------------------- PF-3（決めたこと 6）
const keptSlow = (o) => o.engineLog.filter((l) => /^文字起こしの経路: 区間 s\d+ → 遅い PC のため音声を残した/.test(l)).length;
const paceArg = (o) => `--pace=${JSON.stringify({ schema: 1, model: 'same', rtf: 1.7, slow: true, at: 'now-1', from: 'live', ...o })}`;
test('PF-3 前の版の覚え: 0.18.0 までの「遅い」の覚え（印が無い）・スレッドの数が違う覚えは使わない（会議は PC へ送る・待ち時間は rtf 1）。印が同じ覚えは使う。会議の後に書く覚えには印がある', T, async () => {
  const [old, threads, same, oldLate] = await Promise.all([
    run(['text', '--local-only', '--segs=2', '--seg-ms=15000', '--cpus=12', paceArg({})], { scale: '1' }),
    run(['text', '--local-only', '--segs=2', '--seg-ms=15000', '--cpus=12', paceArg({ stamp: { set: 'manual', threads: 10, prio: 2 } })], { scale: '1' }),
    run(['text', '--local-only', '--segs=2', '--seg-ms=15000', '--cpus=12', paceArg({ stamp: 'same' })], { scale: '1' }),
    run(['hang-first', '--segs=1', '--seg-ms=120000', '--cpus=12', paceArg({ slow: false })], { scale: '0.002' }),
  ]);
  for (const o of [old, threads]) {
    assert.strictEqual(keptSlow(o), 0, `印の違う覚えで遅いにした: ${o.engineLog.join('\n')}`);
    assert.ok(!o.engineLog.some((l) => /理由 saved）$/.test(l)), o.engineLog.join('\n'));
  }
  assert.strictEqual(keptSlow(same), 2, same.engineLog.join('\n'));
  assert.ok(same.engineLog.some((l) => /理由 saved）$/.test(l)), same.engineLog.join('\n'));
  // 印の無い覚えの rtf 1.7 は待ち時間にも使わない（120 秒の区間で 300 秒。使えば 468 秒）
  assert.ok(oldLate.engineLog.includes('手元の文字起こしの時間切れ: s1（音声 120 秒・待ち 300 秒）。エンジンを起こし直します'), oldLate.engineLog.join('\n'));
  // 書いた覚え: 印（手のパスの組・起こしたスレッドの数・優先度の版 2）。パスは書かない
  const j = JSON.parse(old.paceFile);
  assert.deepStrictEqual(j.stamp, { set: 'manual', threads: 4, prio: 2 });
  assert.deepStrictEqual(Object.keys(j).sort(), ['at', 'from', 'model', 'rtf', 'schema', 'slow', 'stamp']);
  assert.ok(!old.paceFile.includes('/') && !old.paceFile.includes('\\\\'), '覚えにパスを書いた');
});
