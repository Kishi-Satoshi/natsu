/*
 * stage094.main.test.js — 0.9.4（計画 docs/plans/2026-10-22-094.md）の main の場面。偽の Electron の上で main.js を本当に動かして確かめる
 * （helpers/mainrun.js。偽の whisper は helpers/fake-whisper.js の hang・hang-first・err500・refuse）。
 * PC への要求の待ち時間は NATSU_TEST_LOCAL_TIME_SCALE で縮める（0.005 なら 240 秒が 1.2 秒）。
 *  S-2: PC への要求を node:http に・時間切れの扱い（区間は kept・帯 kept-late・エンジンの起こし直し）と文
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
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
const LATE_SEG = '（文字起こし待ち: PC の文字起こしが間に合わなかったので、後で文字起こしします）';
const DOWN_SEG = '（文字起こし待ち: PC の文字起こしエンジンにつながらなかったので、後で文字起こしします）';
const LATE_BANNER = 'この PC の文字起こしが録音に追いつかないため、音声を残しています。会議が終わったら文字起こしします。録音はそのまま続けてください。';
const codes = (o) => o.sttSeen.map((s) => (s && s.problem ? s.problem.code : null)).filter((c, i, a) => i === 0 || a[i - 1] !== c);
const problemOf = (o, code) => o.sttSeen.map((s) => s && s.problem).find((p) => p && p.code === code);
const whisperSpawns = (o) => (o.spawns || []).filter((s) => /fake-whisper\.js$/.test(s.cmd) || /whisper-server/.test(s.cmd));
const dump = (o) => JSON.stringify({ sttSeen: o.sttSeen, sttAt: o.sttAt, engineLog: o.engineLog, requests: o.requests }, null, 1);
const lateLine = /^手元の文字起こしの時間切れ: (s\d+)（音声 (\d+) 秒・待ち (\d+) 秒）。エンジンを起こし直します$/;

// ---------------------------------------------------------------- S-2（決めたこと 15〜18）
test('S3: 時間切れの区間は kept・文は『（文字起こし待ち: PC の文字起こしが間に合わなかったので、後で文字起こしします）』・帯は kept-late（engine-down でない）。会議の後のやり直しで文字になる', T, async () => {
  const o = await run(['hang-first', '--segs=2', '--after-retry']);
  const at = o.sttAt['kept-late'];
  assert.ok(at, dump(o));
  const s1 = at.find((s) => s.id === 's1');
  assert.deepStrictEqual(s1, { id: 's1', text: LATE_SEG, failed: true, wav: true }, dump(o));
  assert.deepStrictEqual(problemOf(o, 'kept-late'), { code: 'kept-late', text: LATE_BANNER, action: '', offline: false });
  assert.ok(!codes(o).includes('engine-down'), `時間切れで engine-down を立てた: ${JSON.stringify(codes(o))}`);
  assert.ok(!o.engineLog.includes('文字起こしの状態: 帯 engine-down'), o.engineLog.join('\n'));
  // 会議の後のやり直し（起こし直したエンジン）で文字になる
  assert.ok(o.afterRetry.segments.length >= 2 && o.afterRetry.segments.every((s) => !s.failed && s.text.startsWith('本日の議題は進捗の確認です')), JSON.stringify(o.afterRetry.segments));
  assert.ok(!o.engineLog.some((l) => /エンジンにつながりませんでした/.test(l)));
});

test('S11: 時間切れの後は whisper のプロセスを止め、次の区間で起こし直す（偽の spawn が2回）。engine.log の時間切れの行は区間の番号・秒・符号だけ', T, async () => {
  const o = await run(['hang-first', '--segs=2']);
  assert.strictEqual(whisperSpawns(o).length, 2, dump(o));
  const lines = o.engineLog.filter((l) => l.startsWith('手元の文字起こしの時間切れ'));
  assert.deepStrictEqual(lines, ['手元の文字起こしの時間切れ: s1（音声 3 秒・待ち 240 秒）。エンジンを起こし直します'], o.engineLog.join('\n'));
  // 時間切れの要求の接続は閉じた（whisper-server の中で走り続けない）。2 区間目は起こし直したエンジンが文字にした
  assert.ok(o.engineLog.includes('手元の文字起こしの失敗: s1（LOCAL_TIMEOUT）'), o.engineLog.join('\n'));
  assert.ok(o.pages[0].segments.some((s) => !s.failed && /区間/.test(s.text)), JSON.stringify(o.pages[0].segments));
  const idx = o.engineLog.findIndex((l) => lateLine.test(l));
  const spawnAfter = o.engineLog.slice(idx + 1).some((l) => /起動: /.test(l));
  assert.ok(spawnAfter, `時間切れの後に起こし直していない: ${o.engineLog.join('\n')}`);
  // 時間切れの行に文字起こしの文・パスを書かない
  for (const l of lines) assert.ok(!/本日の議題|[\\/]|\.bin/.test(l), l);
});

test('S3: 偽のエンジンが止まっている（ECONNREFUSED）区間は kept・文は『…エンジンにつながらなかったので…』・帯は engine-down', T, async () => {
  const o = await run(['refuse', '--segs=2']);
  const at = o.sttAt['engine-down'];
  assert.ok(at, dump(o));
  const s1 = at.find((s) => s.id === 's1');
  assert.deepStrictEqual(s1, { id: 's1', text: DOWN_SEG, failed: true, wav: true }, dump(o));
  assert.ok(!codes(o).includes('kept-late') && !codes(o).includes('seg-failed'), JSON.stringify(codes(o)));
  assert.ok(!o.engineLog.includes('文字起こしの状態: 帯 seg-failed'), `届かない区間を失敗に数えた: ${o.engineLog.join('\n')}`);
  assert.ok(o.engineLog.includes('手元の文字起こしの失敗: s2（ECONNREFUSED）'), o.engineLog.join('\n'));
  assert.ok(!o.engineLog.some((l) => l.startsWith('手元の文字起こしの時間切れ')), o.engineLog.join('\n'));
});

test('エンジンが 500 を返した区間は今の失敗（seg-failed。音声は残す。帯は今どおり engine-down が先）', T, async () => {
  const o = await run(['err500', '--segs=2']);
  const at = o.sttAt['engine-down'];
  assert.ok(at, dump(o));
  assert.deepStrictEqual(at.find((s) => s.id === 's1'), { id: 's1', text: '（この区間の認識に失敗: 文字起こしエンジンエラー (500): boom）', failed: true, wav: true }, dump(o));
  assert.ok(o.engineLog.includes('文字起こしの状態: 帯 seg-failed'), o.engineLog.join('\n'));
  assert.ok(!codes(o).includes('kept-late'), JSON.stringify(codes(o)));
  assert.ok(!o.engineLog.some((l) => l.startsWith('手元の文字起こしの時間切れ')), o.engineLog.join('\n'));
});

test('待ち時間は localTimeoutMs（覚えの rtf 1.7・120 秒の区間で 468 秒 × 尺度）。別のモデルの覚えは使わない（300 秒）', T, async () => {
  const pace = (model) => `--pace=${JSON.stringify({ schema: 1, model, rtf: 1.7, slow: false, at: 'now-1', from: 'live' })}`;
  const [same, other] = await Promise.all([
    run(['hang-first', '--segs=1', '--seg-ms=120000', pace('same')], { scale: '0.002' }),
    run(['hang-first', '--segs=1', '--seg-ms=120000', pace({ name: 'ggml-medium-q5_0.bin', size: 539212467 })], { scale: '0.002' }),
  ]);
  assert.ok(same.engineLog.includes('手元の文字起こしの時間切れ: s1（音声 120 秒・待ち 468 秒）。エンジンを起こし直します'), same.engineLog.join('\n'));
  assert.ok(other.engineLog.includes('手元の文字起こしの時間切れ: s1（音声 120 秒・待ち 300 秒）。エンジンを起こし直します'), other.engineLog.join('\n'));
});

test('音声入力の時間切れは文字起こし待ちの履歴に残す', T, async () => {
  const o = await run(['hang', '--dictate']);
  assert.strictEqual(o.history.length, 1, JSON.stringify(o.history));
  assert.match(o.history[0].wait || '', /^\d+-[A-Za-z0-9]+\.wav$/, JSON.stringify(o.history));
  assert.ok(o.engineLog.includes('手元の文字起こしの時間切れ: 音声入力（音声 3 秒・待ち 240 秒）。エンジンを起こし直します'), o.engineLog.join('\n'));
});
