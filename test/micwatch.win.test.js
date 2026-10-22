/*
 * micwatch.win.test.js — 0.9.3 Task M-2（計画 docs/plans/2026-10-22-093.md の決めたこと 1・3）: 会議の検出の見張りの PowerShell を本物の Windows で回す
 * Windows でないときは、ファイルの頭で抜ける（test.skip にしない。ci.yml は飛ばしたテストを Linux で 0 件しか許さない）。
 * HKCU の下に一時のキー（Software\NaTsuTest-<乱数>\microphone。名前に本当の名前を書かない）を作り、Windows の「マイクを使っているアプリ」の
 * 記録と同じ形の値（LastUsedTimeStart・LastUsedTimeStop の QWORD）を置いて、mainlib.micWatchScript をその root で起こす。
 * 一覧の proc はテストのプロセス（node）にした写し（会議のアプリが動いていない機械でも「プロセスがある」になる）。済んだらキーを消す。
 */
'use strict';
if (process.platform !== 'win32') return;

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const lib = require('../src/mainlib');

const KEY = `Software\\NaTsuTest-${crypto.randomBytes(4).toString('hex')}`;
const ROOT = `${KEY}\\microphone`;
const NOW = '133713371337133713';
const ps = (cmd) => new Promise((resolve, reject) => {
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${cmd}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`powershell ${c}: ${err}`))));
});
// キーを作って値を置く（値は [名前, 数か文字, 'QWord'|'String']）
const setKey = (sub, values) => ps([`$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${ROOT}\\${sub.replace(/'/g, "''")}')`,
  ...values.map(([n, v, kind]) => `$k.SetValue('${n}', ${kind === 'String' ? `'${v}'` : `[int64]${v}`}, [Microsoft.Win32.RegistryValueKind]::${kind})`), '$k.Close()'].join('; '));
const use = (start, stop) => [['LastUsedTimeStart', start, 'QWord'], ['LastUsedTimeStop', stop, 'QWord']];
const APPS = lib.MEET_APPS.map((a) => ({ ...a, proc: ['node'] }));
const SELF = 'C:\\Test\\Chrome\\chrome.exe';   // 一覧にある名前を自分にして、自分を除くことを見る

// 見張りを起こし、行を集める
function watch(opts = {}) {
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lib.micWatchScript({ root: ROOT, self: SELF, apps: APPS, everyMs: 300, parent: process.pid, ...opts })],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = [];
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } });
  const waitLines = async (n, ms = 15000) => { const until = Date.now() + ms; while (lines.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 50)); return lines.slice(); };
  return { p, lines, waitLines, stop: () => { try { p.kill(); } catch (_) { /* noop */ } } };
}

test.before(async () => {
  await setKey('NonPackaged\\C:#Test#Zoom#bin#Zoom.exe', use(NOW, 0));                                   // 使っている（大文字の名前も小文字で比べる）
  await setKey('NonPackaged\\C:#Test#Slack#slack.exe', use(NOW, '133713371337199999'));                   // 使い終わった
  await setKey('NonPackaged\\C:#Test#Webex#webex.exe', [['LastUsedTimeStart', NOW, 'QWord'], ['LastUsedTimeStop', '0', 'String']]);   // Stop が読めない
  await setKey('NonPackaged\\C:#Test#Other#notepad.exe', use(NOW, 0));                                   // 一覧に無い
  await setKey('NonPackaged\\C:#Test#Chrome#chrome.exe', use(NOW, 0));                                   // 自分のパス
  await setKey('NonPackaged\\C:#Test#Notion#Notion.exe', use(NOW, 0));                                   // 持ち主の実機の記録: Notion は会議のアプリでない
  await setKey('NonPackaged\\C:#Test#Edge#msedge.exe', use(0, 0));                                       // 使ったことの無いキー（Start が 0）
  await setKey('MSTeams_8wekyb3d8bbwe', use('133713371337133700', 0));                                   // 新しい Teams（パッケージ）
  await setKey('NotionHQ.Notion_testpkg', use(NOW, 0));                                                   // Notion のパッケージの形
});
test.after(async () => {
  await ps(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${KEY}', $false)`);
});

test('M1・M5: 最初の行は一覧の「使っている」だけ（パス・一覧に無い名前・自分・Notion・使い終わった・Stop が読めない・Start が 0 が無い）。キーを「使い終わった」に書き換えると次の行。変わらなければ書かない', { timeout: 30000 }, async () => {
  const w = watch();
  try {
    const first = await w.waitLines(1);
    assert.deepStrictEqual(first[0], 'mic teams:133713371337133700,zoom:133713371337133713');
    assert.deepStrictEqual(lib.parseMicLine(first[0]).items.map((x) => x.id), ['teams', 'zoom']);
    for (const l of first) assert.ok(!/[\\#:]\w*\.exe|notepad|notion|chrome|slack|webex|edge/i.test(l), l);
    // 変わらなければ書かない（300ms ごとに読んで 1.5 秒）
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(w.lines.length, 1, JSON.stringify(w.lines));
    await setKey('NonPackaged\\C:#Test#Zoom#bin#Zoom.exe', use(NOW, '133713371337199999'));
    const second = await w.waitLines(2);
    assert.strictEqual(second[1], 'mic teams:133713371337133700');
    await setKey('MSTeams_8wekyb3d8bbwe', use('133713371337133700', '133713371337199999'));
    const third = await w.waitLines(3);
    assert.strictEqual(third[2], 'mic -');
  } finally {
    w.stop();
    await setKey('NonPackaged\\C:#Test#Zoom#bin#Zoom.exe', use(NOW, 0));
    await setKey('MSTeams_8wekyb3d8bbwe', use('133713371337133700', 0));
  }
});

test('決めたこと 3: proc のプロセスが無いアプリの古い値は出さない（落ちたアプリの Stop == 0 が残っても出しっぱなしにしない）。root が無ければ mic -', { timeout: 30000 }, async () => {
  const apps = lib.MEET_APPS.map((a) => ({ ...a, proc: a.id === 'zoom' ? ['node'] : ['natsu-no-such-process'] }));
  const w = watch({ apps });
  try {
    assert.strictEqual((await w.waitLines(1))[0], 'mic zoom:133713371337133713');
  } finally { w.stop(); }
  const w2 = watch({ root: `${KEY}\\no-such-root` });
  try {
    assert.strictEqual((await w2.waitLines(1))[0], 'mic -');
  } finally { w2.stop(); }
});

test('決めたこと 13: 1 回の読みは 20ms まで（読みごとの時間の中央値。最初の読みは .NET の読み込みを含むので除く）。親が居なければ自分で終わる', { timeout: 30000 }, async () => {
  const w = watch({ timing: true });
  try {
    const ls = await w.waitLines(8);
    const ts = ls.filter((l) => l.startsWith('t ')).map((l) => Number(l.slice(2))).slice(1).sort((a, b) => a - b);
    assert.ok(ts.length >= 4, JSON.stringify(ls));
    assert.ok(ts[Math.floor(ts.length / 2)] <= 20, `読みが遅い: ${ts.join(',')}`);
  } finally { w.stop(); }
  // 親の pid に居ないもの（0 より大きく、まず使われない数）を渡すと、最初の見回りで終わる
  const gone = watch({ parent: 2147483000 });
  const code = await new Promise((r) => { gone.p.on('exit', (c) => r(c)); setTimeout(() => r('timeout'), 15000); });
  assert.strictEqual(code, 0, '親が居ないのに終わらない');
});
