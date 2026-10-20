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
 * 第0b回（Task 17）: 案内は「アプリで［エンジンを取り込む］を押す」。スクリプトは詳しい人向けに残す。
 *  - INSTALL の手順・常駐メモリの目安、get-installer.ps1 の終わりの案内、ランタイムの URL（aka.ms/vc14）
 *  - setup-summarizer.ps1 の既定のモデルは、アプリの取り込みと同じファイル（URL も同じ commit で固定）
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
  // 要約のモデルの既定は、アプリの取り込みと同じ e4b（第0b回 Task 17。下の「既定のモデルはアプリの取り込みと同じファイル」）
  { file: 'setup-summarizer.ps1', params: ['[string]$Model = "e4b"', '[string]$Tag = ""'], done: 'セットアップ完了' },
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
    // 実行し直すコマンドとフォルダは、それぞれ札を付けて行の最後に置く（文の途中に置くと、後ろの語までひと続きに写される）
    const iHint = t.findIndex((l) => l.includes('PowerShell を開いて、次のコマンドで実行し直すと、詳しい内容が見えます。') && l.endsWith('-ForegroundColor Red'));
    const iCmd = t.indexOf(`Write-Host "  実行するコマンド: powershell -ExecutionPolicy Bypass -File .\\${file}" -ForegroundColor Red`);
    const iDir = t.indexOf('Write-Host ("  このフォルダ: " + $PSScriptRoot)');
    const iWait = t.findIndex((l) => /^Wait-BeforeClose "[^"]+"$/.test(l));
    const iExit = t.indexOf('exit 1');
    assert.ok(iMsg > 1, 'エラーの中身を赤字で出していない');
    assert.ok(iHint > iMsg, '実行し直す案内を赤字で出していない');
    assert.ok(iCmd > iHint, `実行し直すコマンドを、札を付けて行の最後に赤字で出していない: ${file}`);
    assert.ok(iDir > iCmd, 'フォルダを、札を付けて行の最後に出していない');
    assert.ok(iWait > iDir, '案内の後で Enter を待っていない');
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

test('setup-local-engine.ps1: 既定のモデルと「指定できる値」の名前に、どれも取得の分岐がある。設定の勧めのコマンドの -Model も通る', () => {
  const ps = read('setup-local-engine.ps1');
  const d = /^\s*\[string\]\$Model = "([^"]+)",?$/m.exec(ps);
  assert.ok(d, '既定の -Model が読めない');
  assert.ok(ps.includes(`$Model -eq "${d[1]}"`), `既定のモデル ${d[1]} の分岐が無い`);
  const listed = /指定できる値: ([^"]+)"/.exec(ps);
  assert.ok(listed, '「指定できる値」の案内が無い');
  for (const name of listed[1].split(' / ')) assert.ok(ps.includes(`$Model -eq "${name.trim()}"`), `${name} の分岐が無い`);
  assert.ok(listed[1].split(' / ').map((x) => x.trim()).includes(d[1]), '既定のモデルが「指定できる値」に無い');
  // 設定のエンジン欄に出す kotoba からの替え方（main.js の KOTOBA_NOTE）のコマンド
  const m = /setup-local-engine\.ps1 -Model ([\w.-]+)';/.exec(read('src/main.js'));
  assert.ok(m, 'KOTOBA_NOTE のコマンドが読めない');
  assert.ok(ps.includes(`$Model -eq "${m[1]}"`), `勧めのコマンドの -Model ${m[1]} を、セットアップスクリプトが受け付けない`);
});

// ---------------------------------------------------------------- 第0b回 Task 17: 案内はアプリでの取り込み
/** Markdown の "## 見出し" から次の "## " までを返す（無ければ ''）。stage3.dist.test.js と同じ */
function section(md, heading) {
  const i = md.indexOf(`\n${heading}\n`);
  if (i < 0) return '';
  const rest = md.slice(i + 1);
  const j = rest.indexOf('\n## ');
  return j < 0 ? rest : rest.slice(0, j);
}

// 第1d回 A-13（D19）で意図して変えた: 設定のカード「エンジン」は「オフライン」、ボタンは［PC の中の文字起こしを取り込む］（前の［エンジンを取り込む］）。案内も画面の名前に合わせる
test('INSTALL: 手順は［設定］→［オフライン］の［PC の中の文字起こしを取り込む］（約 5.6GB）。置き場所は %LOCALAPPDATA%\\natsu\\engine。スクリプトは詳しい人向けの節に残す', () => {
  const s = read('INSTALL.md');
  assert.ok(s.includes('［設定］→［オフライン］の［PC の中の文字起こしを取り込む］') && s.includes('%LOCALAPPDATA%\\natsu\\engine') && s.includes('約 5.6GB'));
  assert.ok(!s.includes('［エンジンを取り込む］') && !s.includes('［設定］→［エンジン］'), '前の名前（［エンジンを取り込む］・［設定］→［エンジン］）が残っている');
  const adv = section(s, '## 手で入れる（詳しい人向け）');
  assert.ok(adv && adv.includes('setup-local-engine.ps1') && adv.includes('setup-summarizer.ps1'));
  for (const h of ['github.com', 'huggingface.co', 'hf.co']) assert.ok(s.includes(h), h);
  const step1 = section(s, '## 手順1. インストーラーを取得する');
  assert.ok(step1 && !/setup-(local-engine|summarizer)\.ps1/.test(step1), '手順1 でスクリプトを取らせている');
});

test('INSTALL の常駐メモリの目安: 手で入れた 3B の「約 3GB」は残し、取り込んだモデルの行を足す', () => {
  const sec = section(read('INSTALL.md'), '## 常駐メモリの目安');
  assert.ok(/約\s*3\s*GB/.test(sec));
  assert.ok(/取り込んだ[^\n]*約\s*4\s*GB/.test(sec), '取り込んだ要約のモデルのメモリが書いていない');
});

test('get-installer.ps1: セットアップスクリプトを落とさず、終わりの案内は［設定］→［オフライン］の［PC の中の文字起こしを取り込む］（第1d回 A-13 で名前を変えた）', () => {
  const s = read('get-installer.ps1');
  assert.ok(s.includes('［設定］→［オフライン］の［PC の中の文字起こしを取り込む］'));
  assert.ok(!s.includes('［エンジンを取り込む］'));
  assert.ok(!s.includes('setup-local-engine.ps1') && !s.includes('貼り付け'));
  // 計画の2つの確かめは、名前を書かない `-like "setup-*.ps1"` の取得の繰り返しを見逃すので、注釈でない行に setup- が無いことも見る
  assert.ok(!codeLines(s).some((l) => /setup-/.test(l)), 'get-installer.ps1 がまた setup-*.ps1 を落としている');
});

test('ランタイムの案内は aka.ms/vc14（14.51 以上）。aka.ms/vs/17（14.44）は残っていない', () => {
  for (const f of ['INSTALL.md', 'setup-local-engine.ps1', 'src/mainlib.js']) {
    const s = read(f);
    assert.ok(s.includes('https://aka.ms/vc14/vc_redist.x64.exe'), f);
    assert.ok(!s.includes('aka.ms/vs/17'), f);
  }
});

test('setup-summarizer.ps1 の既定のモデルは、アプリの取り込みと同じファイル（全員同じモデル）。URL は commit で固定', () => {
  const pin = require('../src/engine-manifest').MANIFEST.items.find((i) => i.id === 'sum-model');
  const name = pin.dest.split('/').pop();
  const s = read('setup-summarizer.ps1');
  const def = (s.match(/\[string\]\$Model = "([^"]+)"/) || [])[1];
  const block = s.slice(s.indexOf(`if ($Model -eq "${def}")`), s.indexOf('}', s.indexOf(`if ($Model -eq "${def}")`)));
  assert.ok(block.includes(name), `既定 ${def} のファイルが ${name} でない`);
  assert.ok(s.includes(pin.url), 'ピンと同じ commit の URL でない');
});

// INSTALL の「困ったときは」は、画面に出る取り込みの文（src/engine-fetch.js の fetchErrorMessage）と
// ランタイムの文（src/mainlib.js の vcRuntimeIssue）の一部を「…」と出る の形でそのまま引く。文を直したのに
// INSTALL を直し忘れると、利用者が表で探せなくなるので、引いた文が本当の文のどれかの一部であることを見る。
// 「 … 」は、その間に何かが入る（defender の文のファイル名）。
test('INSTALL の困ったときは: 「…」と出る と書いた文は、取り込みとランタイムの本当の文の一部（文を直したら INSTALL も直す）', () => {
  const { fetchErrorMessage } = require('../src/engine-fetch');
  const { vcRuntimeIssue } = require('../src/mainlib');
  const codes = ['waiting', 'offline', 'proxy', 'proxy-auth', 'cert', 'blocked', 'http-401', 'http-403', 'space', 'hash', 'gone',
    'size-changed', 'pinned-mismatch', 'place-in-use', 'locked', 'defender', 'net', 'bad-range', 'insecure-redirect', 'too-many-redirects'];
  const real = [...codes.map((c) => fetchErrorMessage(c)), ...codes.map((c) => fetchErrorMessage(c, { file: 'whisper-server.exe', needGB: 2.4 })),
    vcRuntimeIssue({}, { whisper: true }).message];
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sec = section(read('INSTALL.md'), '## 困ったときは');
  const quoted = sec.split('\n').map((l) => /^\| 「([^」]+)」[^|]*(?:と出る|から進まない) \|/.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.ok(quoted.length >= 7, `引いた文が少ない: ${JSON.stringify(quoted)}`);
  for (const q of quoted) {
    const re = new RegExp(q.split(' … ').map(esc).join('.+'));
    assert.ok(real.some((m) => re.test(m)), `INSTALL の「${q}」が、画面に出る文のどれにも無い`);
  }
});
