/*
 * launch.test.js — ソースから起動する人のための起動の助け（第0c回 EL5・C3）
 * Electron 42 から npm install では本体が落ちてこない。start-natsu.bat と create-shortcut.ps1 は、
 * electron.exe が無いときだけ tools/get-electron.js を呼ぶ。get-electron.js は本当に node で走らせて確かめる。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const G = require('../tools/get-electron');

test('get-electron: Node の版は 22.12.0 以上だけ通す（Electron 44 の包みが求める版）', () => {
  for (const [v, ok] of [['22.11.9', false], ['22.12.0', true], ['v22.12.1', true], ['22.19.0', true], ['24.22.0', true], ['20.18.0', false], ['16.20.2', false], ['', false]]) {
    assert.strictEqual(G.nodeOk(v), ok, v);
  }
});

test('get-electron: 本体があれば何もしない。Node が古ければ取り込まずに平易な文で止まる。包みが無ければ npm install を促す', () => {
  const root = path.join(os.tmpdir(), 'natsu-起動-なし');
  const logs = [];
  let runs = 0;
  const d = (o) => ({ version: '24.22.0', platform: 'win32', exists: () => false, run: () => { runs += 1; return 0; }, log: (l) => logs.push(l), ...o });
  assert.strictEqual(G.getElectron(root, d({ exists: (p) => p === G.electronExe(root, 'win32') })), 0);
  assert.strictEqual(runs, 0);
  assert.strictEqual(G.getElectron(root, d({ version: '20.18.0' })), 3);
  assert.strictEqual(logs.pop(), 'Node.js 22.12 以上を入れてください（今の Node.js は 20.18.0）。https://nodejs.org/ja から LTS 版を入れられます。');
  assert.strictEqual(runs, 0, '古い Node で取り込みを走らせた');
  assert.strictEqual(G.getElectron(root, d({})), 2);
  assert.match(logs.pop(), /npm install/);
});

test('get-electron: install.js を走らせ、本体ができれば 0、できなければプロキシの案内つきで 1', () => {
  const root = path.join(os.tmpdir(), 'natsu-起動-走る');
  const script = path.join(root, 'node_modules', 'electron', 'install.js');
  const made = new Set([script]);
  const logs = [];
  const d = (run) => ({ version: '22.12.0', platform: 'win32', exists: (p) => made.has(p), run, log: (l) => logs.push(l) });
  assert.strictEqual(G.getElectron(root, d(() => 1)), 1);
  assert.match(logs.pop(), /NODE_USE_SYSTEM_CA/);
  assert.strictEqual(G.getElectron(root, d(() => 0)), 1, '0 で終わっても本体が無ければ失敗');
  assert.strictEqual(G.getElectron(root, d((s) => { assert.strictEqual(s, script); made.add(G.electronExe(root, 'win32')); return 0; })), 0);
  assert.strictEqual(logs.pop(), '取り込みました。');
});

test('get-electron: 本当に node で走らせる（日本語のフォルダ。偽の install.js が本体の代わりを置く）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-起動𠮷-'));
  try {
    const run = () => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'get-electron.js'), root], { encoding: 'utf8' });
    let r = run();
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /npm install/);
    const pkg = path.join(root, 'node_modules', 'electron');
    fs.mkdirSync(pkg, { recursive: true });
    const exe = process.platform === 'win32' ? 'electron.exe' : 'electron';
    fs.writeFileSync(path.join(pkg, 'install.js'),
      `const fs = require('fs'); const p = require('path'); fs.mkdirSync(p.join(__dirname, 'dist'), { recursive: true }); fs.writeFileSync(p.join(__dirname, 'dist', '${exe}'), 'x');\n`);
    r = run();
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(pkg, 'dist', exe)));
    r = run();
    assert.strictEqual(r.status, 0);
    assert.ok(!/取り込んでいます/.test(r.stdout), '本体があるのにもう一度取り込んだ');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('get-electron.js は古い Node でも構文で落ちない書き方（var と function だけ）で、npx を呼ばない', () => {
  const s = read('tools/get-electron.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/=>|\bconst\b|\blet\b|`|\.\.\.|\basync\b/.test(s), '新しい書き方がある（古い Node で案内を出す前に落ちる）');
  assert.ok(!/npx/.test(s));
  assert.ok(s.includes("'install.js'"));
  assert.ok(s.includes('if (require.main === module)'), 'require されただけで取り込みを走らせる（npm test が本体を落としにいく）');
});

test('start-natsu.bat: electron.exe が無いときだけ node で get-electron.js を呼び、npx を使わない。BOM なし・CRLF', () => {
  const b = fs.readFileSync(path.join(ROOT, 'start-natsu.bat'));
  assert.ok(!(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF), 'BOM がある');
  const t = b.toString('utf8');
  assert.strictEqual((t.match(/\r\n/g) || []).length, (t.match(/\n/g) || []).length, 'CRLF でない行がある');
  assert.ok(!/npx/i.test(t));
  const i1 = t.indexOf('if exist "%APPDIR%\\node_modules\\electron\\dist\\electron.exe" goto run');
  const i2 = t.indexOf('node "%APPDIR%\\tools\\get-electron.js" "%APPDIR%"');
  const i3 = t.indexOf(':run');
  const i4 = t.indexOf('start "" "%APPDIR%\\node_modules\\electron\\dist\\electron.exe" "%APPDIR%"');
  assert.ok(i1 >= 0 && i2 > i1 && i3 > i2 && i4 > i3, `順が違う: ${[i1, i2, i3, i4]}`);
  assert.ok(t.includes('Node.js 22.12 以上を入れてください'));
});

test('create-shortcut.ps1: electron.exe が無いときだけ node で get-electron.js を呼び、npx を使わない', () => {
  const t = read('create-shortcut.ps1').replace(/^﻿/, '');
  assert.ok(!/npx/i.test(t));
  assert.ok(t.includes('& $node.Source (Join-Path $app "tools\\get-electron.js") $app'));
  assert.ok(t.includes('if ($LASTEXITCODE -ne 0) { exit 1 }'));
  assert.ok(t.includes('Node.js 22.12 以上を入れてください'));
});
