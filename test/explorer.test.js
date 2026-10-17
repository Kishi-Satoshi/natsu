/*
 * explorer.test.js — エクスプローラーから起動したスクリプトの窓が、読む前に閉じない（0.1.1）
 *
 * 実機で、setup-*.ps1 を右クリックの「PowerShell で実行」やダブルクリックで起動すると、
 * 窓が一瞬で閉じて、エラーも貼り付けるパスも読めなかった（開いてある窓から実行すれば動く）。
 *
 *  - -NoPause（自動実行用）を足す。今までの引数はそのまま
 *  - エクスプローラーからの起動を調べる関数があり、try/catch で包む（調べられなければ待たない）
 *  - 最後（成功）とエラーの後始末の両方で Read-Host "Enter キーを押すと閉じます" に届く
 *  - エラーの後始末は、赤字でエラーと「実行し直すと詳しい内容が見える」を出す
 *  - 案内を出して止まるところ（exit 1）も、待ってから閉じる
 *  - 開いてある窓からの実行は今までどおり（待たない。エラーは break で PowerShell の表示に任せる）
 *
 * PowerShell は手元で回せないので、.ps1 を文字列として読む（構文は CI が PowerShell 5.1 で見る）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
// コメント行を落とした、中身のある行
const codeLines = (s) => s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
// 行頭の head（例: 'function Foo {' / 'trap {'）から、行頭の '}' だけの行までを切り出す
function block(s, head) {
  const lines = s.split('\n');
  const i = lines.findIndex((l) => l === head);
  if (i < 0) return null;
  const j = lines.findIndex((l, k) => k > i && l === '}');
  return j < 0 ? null : lines.slice(i, j + 1).join('\n');
}

const PROMPT = 'Read-Host "Enter キーを押すと閉じます"';
const SCRIPTS = [
  { file: 'setup-local-engine.ps1', params: ['[string]$Model = "large-v3-turbo-q5"', '[switch]$ForceBinary'], done: 'セットアップ完了' },
  { file: 'setup-summarizer.ps1', params: ['[string]$Model = "3b"', '[string]$Tag = ""'], done: 'セットアップ完了' },
  { file: 'get-installer.ps1', params: ['[string]$Version = ""', '[string]$OutDir = "."'], done: '取得完了' },
];

for (const { file, params, done } of SCRIPTS) {
  test(`${file}: -NoPause を足し、今までの引数はそのまま`, () => {
    const s = read(file);
    const p = s.slice(s.indexOf('\nparam(\n'), s.indexOf('\n)\n', s.indexOf('\nparam(\n')));
    assert.ok(p.length > 0, 'param が読めない');
    assert.match(p, /^ {4}\[switch\]\$NoPause$/m, '-NoPause が無い');
    for (const x of params) assert.ok(p.includes(x), `今までの引数 ${x} が無い`);
    // -NoPause なら、調べもせずに待たない
    assert.ok(s.includes('if (-not $NoPause) { $script:PauseOnExit = Test-LaunchedFromExplorer $PSCommandPath }'),
      '-NoPause でエクスプローラーの判定を止めていない');
    assert.ok(s.includes('$script:PauseOnExit = $false'), '待つかどうかの既定が「待たない」になっていない');
  });

  test(`${file}: エクスプローラーからの起動を調べる関数は try/catch で包み、失敗したら待たない`, () => {
    const s = read(file);
    const fn = block(s, 'function Test-LaunchedFromExplorer {');
    assert.ok(fn, 'Test-LaunchedFromExplorer が無い');
    const lines = codeLines(fn).map((l) => l.trim());
    assert.strictEqual(lines[1], 'param([string]$ScriptPath)');
    assert.strictEqual(lines[2], 'try {', '本体が try で始まっていない');
    const iCatch = lines.indexOf('catch { }');
    assert.ok(iCatch > 2, 'catch が無い');
    assert.deepStrictEqual(lines.slice(iCatch + 1), ['return $false', '}'], 'catch の後で「待たない」を返していない');
    const body = lines.slice(3, iCatch).join('\n');
    // 親のプロセスが explorer.exe（ダブルクリックなど）
    for (const x of ['Get-CimInstance -ClassName Win32_Process', '.ParentProcessId', '"explorer"']) assert.ok(body.includes(x), `try の中に ${x} が無い`);
    // 右クリックの「PowerShell で実行」の起動の行
    assert.ok(body.includes('[Environment]::CommandLine'), '起動の行を見ていない');
    assert.ok(body.includes("'Set-ExecutionPolicy -Scope Process Bypass'") && body.includes("'-Command'"), '「PowerShell で実行」の形を見ていない');
    // 開いてある窓（親が explorer.exe のこともある）で .\ から実行したときは待たない: 起動の行にこのスクリプトの名前が要る
    const iName = body.indexOf('$cmd.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }');
    assert.ok(iName >= 0, '起動の行にこのスクリプトの名前があるかを見ていない');
    assert.ok(iName < body.indexOf('Get-CimInstance') && iName < body.indexOf('Set-ExecutionPolicy'), '名前を見る前に「エクスプローラー」と決めている');
  });

  test(`${file}: 成功して終わるときは、最後に Enter を待つ`, () => {
    const s = read(file);
    const wait = block(s, 'function Wait-BeforeClose {');
    assert.ok(wait, 'Wait-BeforeClose が無い');
    const w = codeLines(wait).map((l) => l.trim());
    const iGuard = w.indexOf('if (-not $script:PauseOnExit) { return }');
    const iRead = w.findIndex((l) => l.includes(PROMPT));
    assert.ok(iGuard > 0, 'エクスプローラーから起動していないときに待たずに戻っていない');
    assert.ok(iRead > iGuard, `${PROMPT} が無い（または判定より前にある）`);
    const code = codeLines(s);
    const last = code[code.length - 1];
    assert.match(last, /^Wait-BeforeClose "[^"]+"$/, `最後の行が Wait-BeforeClose でない: ${last}`);
    assert.ok(s.lastIndexOf(done) < s.lastIndexOf('\nWait-BeforeClose '), '完了の表示より前に待っている');
  });

  test(`${file}: エラーの後始末は、赤字でエラーと実行し直す案内を出し、Enter を待ってから閉じる`, () => {
    const s = read(file);
    const trap = block(s, 'trap {');
    assert.ok(trap, 'trap が無い');
    const t = codeLines(trap).map((l) => l.trim());
    // 開いてある窓から実行したときは、今までどおり PowerShell のエラー表示に任せる
    assert.strictEqual(t[1], 'if (-not $script:PauseOnExit) { break }');
    const iMsg = t.findIndex((l) => l.includes('$_.Exception.Message') && l.endsWith('-ForegroundColor Red'));
    const hint = `PowerShell を開いて powershell -ExecutionPolicy Bypass -File .\\${file} で実行し直すと、詳しい内容が見えます`;
    const iHint = t.findIndex((l) => l.includes(hint) && l.endsWith('-ForegroundColor Red'));
    const iWait = t.findIndex((l) => /^Wait-BeforeClose "[^"]+"$/.test(l));
    const iExit = t.indexOf('exit 1');
    assert.ok(iMsg > 1, 'エラーの中身を赤字で出していない');
    assert.ok(iHint > iMsg, `実行し直す案内を赤字で出していない: ${hint}`);
    assert.ok(iWait > iHint, '案内の後で Enter を待っていない');
    assert.ok(iExit > iWait, '待った後に exit 1 で終わっていない');
    assert.match(block(s, 'function Wait-BeforeClose {'), new RegExp(PROMPT));
  });

  test(`${file}: 案内を出して止まるところ（exit）も、Enter を待ってから閉じる`, () => {
    const s = read(file);
    const ex = block(s, 'function Exit-Script {');
    assert.ok(ex, 'Exit-Script が無い');
    const e = codeLines(ex).map((l) => l.trim());
    const iWait = e.findIndex((l) => /^Wait-BeforeClose "[^"]+"$/.test(l));
    assert.ok(iWait > 0 && e.indexOf('exit $Code') > iWait, 'Exit-Script が待ってから exit していない');
    // exit を直接書いてよいのは Exit-Script と trap の中だけ
    let rest = s;
    for (const b of [ex, block(s, 'trap {')]) rest = rest.replace(b, '');
    const bare = codeLines(rest).filter((l) => /(^|[\s;{])exit\b/.test(l));
    assert.deepStrictEqual(bare, [], '待たずに閉じる exit が残っている');
    assert.ok(codeLines(rest).some((l) => l.trim() === 'Exit-Script 1'), 'Exit-Script 1 を使っていない（検査が空振りしている）');
  });

  test(`${file}: 関数は使う前に定義し、PowerShell 5.1 に無い演算子を使わない`, () => {
    const s = read(file);
    const def = (n) => s.indexOf(`\nfunction ${n} {`);
    for (const n of ['Test-LaunchedFromExplorer', 'Wait-BeforeClose', 'Exit-Script']) assert.ok(def(n) > 0, `${n} が無い`);
    assert.ok(def('Test-LaunchedFromExplorer') < s.indexOf('$script:PauseOnExit = Test-LaunchedFromExplorer'));
    assert.ok(def('Exit-Script') < s.search(/\n\s*Exit-Script 1/), '定義より前で Exit-Script を呼んでいる');
    assert.ok(def('Wait-BeforeClose') < def('Exit-Script'));
    for (const l of codeLines(s)) assert.ok(!/&&|\|\||\?\?/.test(l), `PowerShell 5.1 に無い演算子: ${l.trim()}`);
  });
}

test('make-release.ps1 は開発者が開いた窓で使うので、待たない（変えない）', () => {
  const s = read('make-release.ps1');
  assert.ok(!/NoPause|Read-Host|trap\s*\{/.test(s));
});
