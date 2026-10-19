/*
 * stage1d.restart.test.js — 第1d回 Task A-9（RL16・F16・RF41）: 録音中と議事録の保存の間は、更新の再起動と取り込みを断る
 *
 * 場面は helpers/mainrun.js の --restart-during=meeting|dictation|finalizing|idle（main.js を偽の Electron の上で本当に動かす）。
 * 偽の app.relaunch の回数は out.relaunches（そのときの DB の客の状態は out.relaunchDb）、取り込み（updater.apply。場面では何もしない
 * 偽物）の回数は out.applyCalls。finalizing は偽の DB が締めの返事（meeting.finalize）を場面が離すまで止める（fake-utility の holdReply）。
 * トレイの［更新を確認］は場面で押せない（窓の箱の答えを待つ）ので、今の repo.test.js と同じく字面で見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const fnBody = (src, from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `${from} が無い`);
  const j = src.indexOf(to, i + from.length);
  return src.slice(i, j > 0 ? j : src.length);
};
// 画面と知らせの文（計画「更新の再起動を断るときの文」）
const U1 = '録音中のため、更新と再起動をしませんでした。録音を終えてから、もう一度［更新して再起動］を押してください。';
const U2 = '議事録を保存しています。保存が終わってから、もう一度［更新して再起動］を押してください。';
const U3 = '録音中のため、再起動しませんでした。更新は次に NaTsu を起動したときに使われます。録音を終えてから、NaTsu を終了して起動し直してください。';

function runMain(mode, flags) {
  const stdout = execFileSync(process.execPath, [RUN, mode, ...flags], { timeout: 25000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(stdout.trim().split('\n').pop());
}
const refused = (code, error) => ({ ok: false, code, error });

test('RF41: 会議の録音中に app:restart を呼ぶと断り（code recording・U1 の文）、再起動しない。エンジンも DB も止めず、録音はそのまま最後まで保存される', { timeout: 30000 }, () => {
  const out = runMain('text', ['--segs=2', '--restart-during=meeting']);
  assert.deepStrictEqual(out.restart, refused('recording', U1));
  assert.strictEqual(out.relaunches, 0, '録音中に再起動した');
  assert.strictEqual(out.pages.length, 1, JSON.stringify(out.pages));
  assert.deepStrictEqual(out.pages[0].segments.map((s) => s.failed), [false, false], '断った後の区間が文字起こしされていない（エンジンを止めた）');
  assert.ok(out.pages[0].segments.every((s) => s.text.includes('本日の議題')), JSON.stringify(out.pages[0].segments));
  assert.ok(out.engineLog.includes('更新の再起動: 断った（recording）'), out.engineLog.join('\n'));
  // 断ったら何も止めない（A-9 の点検）: 断る前後で main が起こした子（エンジン・貼り付け）の kill() は 0 回。
  // 区間の文字起こしだけを見ると、止めても次の区間で起こし直すので通ってしまう
  assert.ok(out.enginesAtRefusal >= 1, `場面の前提: 断るときにエンジンが動いていない（${out.enginesAtRefusal}）`);
  assert.strictEqual(out.killsAtRefusal, 0, '断ったのにエンジンか貼り付けを止めた');
  // 断った後も終了の途中にしない（quitting を立てない）: 録音中の閉じるボタンは今までどおり確かめで止まる
  assert.deepStrictEqual(out.closeAfterRefusal, { prevented: 1, asked: ['議事録を記録中です'] }, '断った後に閉じるボタンが確かめずに閉じる（終了の途中のまま）');
});

test('RF41: update:apply も録音中は取り込みを始めずに断る（取り込みの要求が 0）', { timeout: 30000 }, () => {
  const out = runMain('text', ['--segs=2', '--restart-during=meeting']);
  assert.deepStrictEqual(out.apply, refused('recording', U1));
  assert.strictEqual(out.applyCalls, 0, '録音中に取り込みを始めた');
  assert.strictEqual(out.pages.length, 1);
});

test('RF41: 音声入力の録音中・文字起こし中も断る', { timeout: 30000 }, () => {
  const out = runMain('text', ['--dictate', '--restart-during=dictation']);
  assert.deepStrictEqual(out.restartRecording, refused('recording', U1), '音声入力の録音中');
  assert.deepStrictEqual(out.restartProcessing, refused('recording', U1), '音声入力の文字起こし中');
  assert.deepStrictEqual(out.apply, refused('recording', U1));
  assert.strictEqual(out.applyCalls, 0);
  assert.strictEqual(out.relaunches, 0);
  assert.strictEqual(out.history.length, 1, '断った後の音声入力が履歴に残っていない');
  assert.ok(out.enginesAtRefusal >= 1, `場面の前提: 断るときにエンジンが動いていない（${out.enginesAtRefusal}）`);
  assert.strictEqual(out.killsAtRefusal, 0, '断ったのにエンジンか貼り付けを止めた');
});

test('RF41: 議事録の締めの返事を待つ間は finalizing（U2）。返事が来た後は再起動する（DB を閉じてから relaunch 1 回）', { timeout: 30000 }, () => {
  const out = runMain('text', ['--segs=2', '--restart-during=finalizing']);
  assert.strictEqual(out.stateHeld, 'idle', '場面の前提: 録音の状態はもう待機（締めの返事だけを待つ）');
  assert.strictEqual(out.heldAcked, false, '場面の前提: 止めている間に締めの返事が来た');
  assert.deepStrictEqual(out.restartHeld, refused('finalizing', U2));
  assert.deepStrictEqual(out.applyHeld, refused('finalizing', U2));
  assert.strictEqual(out.applyCalls, 0);
  assert.ok(out.engineLog.includes('更新の再起動: 断った（finalizing）'), out.engineLog.join('\n'));
  assert.strictEqual(out.restartAfter, true);
  assert.strictEqual(out.relaunches, 1);
  assert.deepStrictEqual(out.relaunchDb, ['down'], 'DB を閉じる前に再起動した');
  assert.strictEqual(out.pages.length, 1, '締めた議事録が残っていない');
});

test('RF41: 何もしていないときは今までどおり取り込んで再起動する（DB を閉じてから relaunch 1 回）', { timeout: 30000 }, () => {
  const out = runMain('text', ['--restart-during=idle']);
  assert.deepStrictEqual(out.apply, { ok: true });
  assert.strictEqual(out.applyCalls, 1);
  assert.strictEqual(out.restart, true);
  assert.strictEqual(out.relaunches, 1);
  assert.deepStrictEqual(out.relaunchDb, ['down']);
  assert.ok(!out.engineLog.some((l) => l.startsWith('更新の再起動: 断った')), out.engineLog.join('\n'));
});

test('RF41: 再起動を受けて DB を閉じている間は、会議（ボタン・ホットキー）も音声入力も始めない（始めると relaunch で録音が切れる）', { timeout: 30000 }, () => {
  const out = runMain('text', ['--restart-during=closing']);
  assert.strictEqual(out.closeHeld, true, '場面の前提: DB を閉じるところで止まっていない');
  assert.strictEqual(out.hotkeysFound, true, '場面の前提: ホットキーが登録されていない');
  assert.deepStrictEqual(out.startWhileClosing, { ok: false, error: '他の処理を実行中です' }, '閉じている間に会議を始めた');
  assert.strictEqual(out.meetingWhileClosing, false, '閉じている間に会議のホットキーで会議が始まった');
  assert.strictEqual(out.overlayStartsWhileClosing, 0, '閉じている間に音声入力の録音を始めた');
  assert.strictEqual(out.restart, true);
  assert.strictEqual(out.relaunches, 1);
  assert.deepStrictEqual(out.relaunchDb, ['down']);
});

test('RF41: checkUpdateFromTray は updater.apply の前と relaunchAndExit の前の2か所で restartBlock を見る', { timeout: 5000 }, () => {
  const m = read('src/main.js');
  const tray = fnBody(m, 'async function checkUpdateFromTray()', '\nfunction updateTray');
  const at = (s) => { const i = tray.indexOf(s); assert.ok(i >= 0, `${s} が無い`); return i; };
  const looks = [...tray.matchAll(/restartBlockNow\(\)/g)].map((x) => x.index);
  const apply = at('updater.apply(');
  const relaunch = at('relaunchAndExit()');
  assert.ok(looks.some((i) => i < apply), '取り込みの前に録音中を見ていない');
  assert.ok(looks.some((i) => i > apply && i < relaunch), '再起動の直前（取り込みの後）に録音中を見直していない');
  assert.ok(tray.includes('RESTART_BLOCK_TEXT.late'), '取り込みの後に断るとき U3 の文を出していない');
  // 断る理由は mainlib.restartBlock で決め、main の状態の4つだけを渡す
  assert.ok(m.includes('restartBlock({ state, finalizing: finalizingPageIds.size, pendingSegs, summarizing: isSummarizing() })'));
  for (const t of [U1, U2, U3]) assert.ok(m.includes(t), `文が無い: ${t}`);
  // 設定の口も同じ関数で見る（要約中の文は今のまま）
  assert.ok(fnBody(m, "ipcMain.handle('app:restart'", '\n  });').includes('restartBlockNow()'));
  assert.ok(fnBody(m, "ipcMain.handle('update:apply'", '\n  });').includes('restartBlockNow()'));
});
