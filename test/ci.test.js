/*
 * ci.test.js — CI（.github/workflows/ci.yml）の形を固定する（第0a回 G1）
 *
 *  - Linux と Windows の両方で npm test とゲートを回す
 *  - Windows の取得で改行を変えない（変えると \n を探すテストが落ちる）
 *  - 履歴ごと取る（gate.test.js が古いコミットを読む）
 *  - ゲートの基準が使えない値（0 の並び・履歴に無い）でも落ちない
 *  - Windows では .ps1 を Windows PowerShell 5.1 で構文解析し、BOM と CRLF を確かめる
 *
 * GitHub Actions は手元で回せないので、YAML を文字列として読む（test/helpers/yml.js）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { jobsOf, stepsOf } = require('./helpers/yml');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('ci.yml: Linux と Windows で、改行を変えずに履歴ごと取り、npm test とゲートを回す', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.ok(!/\t/.test(ci), 'YAML にタブがある');
  assert.match(ci, /^  workflow_call:/m);
  assert.match(ci, /os: \[ubuntu-latest, windows-latest\]/);
  const st = stepsOf(jobsOf(ci).test);
  const iCrlf = st.findIndex((s) => s.includes('git config --global core.autocrlf false'));
  const iCo = st.findIndex((s) => /uses: actions\/checkout@v4/.test(s));
  assert.ok(iCrlf >= 0 && iCrlf < iCo, '改行の変換を止める前に checkout している');
  assert.match(st[iCo], /fetch-depth: 0/);
  assert.ok(st.some((s) => /node-version: '22'/.test(s)));
  assert.ok(st.some((s) => /^\s*npm test/m.test(s) && s.includes('# skipped')), '飛ばしたテストの数を見ていない');
  const gate = st.find((s) => s.includes('node tools/risk.js --base "$BASE" --head HEAD'));
  assert.ok(gate, 'ゲートのステップが無い');
  assert.ok(gate.includes('^0+$'), '新しいブランチ・タグの push（before が 0 の並び）で risk.js が落ちる');
  assert.ok(gate.includes('git cat-file -e "$BASE^{commit}"'), '履歴に無い基準（force-push の後）で risk.js が落ちる');
});

test('ci.yml: Windows では .ps1 を Windows PowerShell 5.1 で構文解析し、BOM と CRLF を確かめる', () => {
  const ci = read('.github/workflows/ci.yml');
  const st = stepsOf(jobsOf(ci).test);
  const parse = st.find((s) => s.includes('Parser]::ParseFile'));
  assert.ok(parse, '構文解析のステップが無い');
  assert.match(parse, /^\s*if: runner\.os == 'Windows'$/m);
  assert.match(parse, /^\s*shell: powershell$/m);
  assert.ok(parse.includes('GetEncoding(932)'), 'BOM が無いときの読まれ方（CP932）を試していない');
  assert.ok(!/pwsh/.test(ci), 'PowerShell 7 で解析している');
  const bom = st.find((s) => s.includes('0xEF') && s.includes('i/crlf'));
  assert.ok(bom, 'BOM と CRLF のステップが無い');
  assert.match(bom, /^\s*if: runner\.os == 'Windows'$/m);
});
