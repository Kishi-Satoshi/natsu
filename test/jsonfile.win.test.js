/*
 * jsonfile.win.test.js — Windows だけで意味のある、保存の部品のテスト（第1a回 RF20・P14・JS1）
 * Windows でないときは、ファイルの頭で抜ける（test.skip にしない。ci.yml は飛ばしたテストを Linux で 0 件しか許さない）。
 * PowerShell は短い命令を -Command で渡し、パスや日本語は環境変数で渡す（.ps1 は作らない。switch と [ValidateSet] は使わない）。
 */
'use strict';
if (process.platform !== 'win32') return;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const J = require('../src/jsonfile');

const dir = (tag = '') => fs.mkdtempSync(path.join(os.tmpdir(), `natsu-win取込𠮷${tag}-`));
const ps = (cmd, env) => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
const run = (cmd, env) => new Promise((resolve, reject) => { const p = ps(cmd, env); p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`powershell ${c}`)))); });
const PS_WAIT = { timeout: 20000 };   // 止まったときの見張り（ふつうは 1〜2 秒）。PowerShell の最初の起動の遅さは下の before が吸う

// PowerShell 5.1 を1回温める（CI の機械の最初の起動は数秒かかることがある。テストの時間に入れない）
test.before(() => run('exit 0'), { timeout: 60000 });

// ファイルを共有なしで ms ミリ秒だけ掴む（ウイルス対策・索引・バックアップの道具の代わり）
function hold(file, ms) {
  const p = ps(`$f = [IO.File]::Open($env:NATSU_LOCK, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $f.Close()`, { NATSU_LOCK: file });
  const done = new Promise((r) => p.on('exit', r));
  const locked = new Promise((resolve, reject) => {
    let buf = '';
    p.stdout.on('data', (c) => { buf += c; if (buf.includes('LOCKED')) resolve(); });
    p.on('exit', (code) => reject(new Error(`掴む前に終わった（${code}）`)));
  });
  return { locked, done };
}

test('RF20 通る場合: 名前の変更のやり直しの持ち時間より短く（250ms）掴まれても、待ってやり直して書ける', PS_WAIT, async () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  fs.writeFileSync(f, '{"theme":"light"}');
  const h = hold(f, 250);
  await h.locked;
  J.writeJsonFile(f, { theme: 'dark' });
  await h.done;
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { theme: 'dark' });
  assert.deepStrictEqual(fs.readdirSync(d), ['settings.json']);
});

test('RF20 対照: やり直さない（waits: []）と、同じ 250ms 掴まれただけで投げる（上の「通る場合」はやり直しが効いている証）', PS_WAIT, async () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  fs.writeFileSync(f, '{"theme":"light"}');
  const h = hold(f, 250);
  await h.locked;
  assert.throws(() => J.writeJsonFile(f, { theme: 'dark' }, { waits: [] }), (e) => ['EPERM', 'EBUSY', 'EACCES'].includes(e.code));
  await h.done;
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"theme":"light"}');
});

test('RF20 通らない場合: 1.2 秒掴まれたままなら投げ、一時ファイルは消え、元のファイルは1バイトも変わらない', PS_WAIT, async () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  const before = Buffer.from('{\n  "theme": "light"\n}');
  fs.writeFileSync(f, before);
  const h = hold(f, 1200);
  await h.locked;
  assert.throws(() => J.writeJsonFile(f, { theme: 'dark' }), (e) => ['EPERM', 'EBUSY', 'EACCES'].includes(e.code));
  await h.done;
  assert.ok(fs.readFileSync(f).equals(before));
  assert.deepStrictEqual(fs.readdirSync(d), ['settings.json']);
});

test('RF22: 300ms 掴まれた設定は、読み直して読める（合わせて約1秒まで待つ）', PS_WAIT, async () => {
  const f = path.join(dir(), 'settings.json');
  fs.writeFileSync(f, '{"theme":"dark"}');
  const h = hold(f, 300);
  await h.locked;
  assert.deepStrictEqual(J.readJsonFile(f), { state: 'ok', value: { theme: 'dark' } });
  await h.done;
});

test('P14: 読み取り専用の印は Windows でも見分けられ、書かずに readOnly で投げる。一時ファイルは残らない', () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  fs.writeFileSync(f, '{"theme":"light"}');
  fs.chmodSync(f, 0o444);   // Windows では読み取り専用の属性になる
  try {
    assert.throws(() => J.writeJsonFile(f, { theme: 'dark' }), (e) => e.readOnly === true);
    // 先に見る理由: Windows では読み取り専用のファイルへの名前の変更そのものが失敗する
    const other = path.join(d, 'other.json');
    fs.writeFileSync(other, '{}');
    assert.throws(() => fs.renameSync(other, f), (e) => ['EPERM', 'EACCES'].includes(e.code));
    fs.unlinkSync(other);
    assert.deepStrictEqual(fs.readdirSync(d), ['settings.json']);
  } finally { fs.chmodSync(f, 0o644); }
});

test('0o600 は Windows では効かない（守りとして書かない。設計書「NaTsu で変えること」）。フォルダの fsync を頼んでも投げない', () => {
  const d = dir();
  const f = path.join(d, 'a.json');
  J.writeJsonFile(f, { a: 1 }, { dirFsync: true });
  fs.chmodSync(f, 0o600);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o666);
});

test('日本語と「𠮷」を含むパスで書いて読める（RF1 と同じ形）', () => {
  const f = path.join(dir('-日本語𠮷'), 'settings.json');
  J.writeJsonFile(f, { micId: '会議室𠮷' });
  assert.deepStrictEqual(J.readJsonFile(f), { state: 'ok', value: { micId: '会議室𠮷' } });
});

test('PowerShell 5.1 の Out-File（UTF-16LE）と Set-Content -Encoding UTF8（BOM 付き）で書いた設定が、日本語ごと読める', PS_WAIT, async () => {
  const d = dir();
  const json = '{"theme":"dark","micId":"会議室のマイク"}';
  const f1 = path.join(d, 'outfile.json');
  const f2 = path.join(d, 'setcontent.json');
  // 1回の PowerShell で両方を書く（起動を1回にして短くする）
  await run('$env:NATSU_JSON | Out-File -FilePath $env:NATSU_P1; Set-Content -Path $env:NATSU_P2 -Value $env:NATSU_JSON -Encoding UTF8', { NATSU_JSON: json, NATSU_P1: f1, NATSU_P2: f2 });
  assert.deepStrictEqual([...fs.readFileSync(f1).subarray(0, 2)], [0xff, 0xfe]);
  assert.deepStrictEqual([...fs.readFileSync(f2).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  for (const f of [f1, f2]) assert.deepStrictEqual(J.readJsonFile(f), { state: 'ok', value: { theme: 'dark', micId: '会議室のマイク' } });
});
