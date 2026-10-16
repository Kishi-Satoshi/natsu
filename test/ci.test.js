/*
 * ci.test.js — CI（.github/workflows/ci.yml）の形を固定する（第0a回 G1）
 *
 *  - Linux と Windows の両方で npm test とゲートを回す
 *  - Windows の取得で改行を変えない（変えると \n を探すテストが落ちる）
 *  - 履歴ごと取る（gate.test.js が古いコミットを読む）
 *  - ゲートの基準が使えない値（0 の並び・履歴に無い）でも落ちない
 *  - Windows では .ps1 を Windows PowerShell 5.1 で構文解析し、BOM と CRLF を確かめる
 *  - release.yml は natsu-v* のタグだけで動き、ci が緑のときだけリリースする（G1-2）
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

// ---------------------------------------------------------------- release.yml（第0a回 G1-2）
// タグは natsu-v<x.y.z>。古い v* では動かさない。リリースは ci（Linux と Windows）が緑のときだけ。
const rel = () => read('.github/workflows/release.yml');

test('release.yml: natsu-v* だけで動き、古い v* では動かない', () => {
  assert.match(rel(), /^    tags:\n      - 'natsu-v\*'$/m);
  assert.match(rel(), /^    branches:\n      - 'release\/natsu-v\*'$/m);
  assert.ok(!/- 'v\*'|- 'release\/v\*'/.test(rel()));
});

test('release.yml: ci を呼び、release は ci が緑のときだけ走る', () => {
  const j = jobsOf(rel());
  assert.deepStrictEqual(Object.keys(j), ['ci', 'release', 'installer']);
  assert.match(j.ci, /^    uses: \.\/\.github\/workflows\/ci\.yml$/m);
  assert.match(j.release, /^    needs: ci$/m);
});

test('release.yml: タグは natsu-v<x.y.z> の形で、natsu-v を外した版が package.json と一致する', () => {
  const r = jobsOf(rel()).release;
  assert.ok(r.includes('TAG="${INPUT_TAG:-natsu-v${VER}}"'));
  assert.ok(r.includes('^natsu-v[0-9]+\\.[0-9]+\\.[0-9]+$'));
  assert.ok(r.includes('"${TAG#natsu-v}" != "$VER"'));
  assert.ok(!r.includes('${TAG#v}'));
});

test('release.yml: ゲートとチェックリストは前の natsu-v タグから（無ければ前の v タグ）', () => {
  const r = jobsOf(rel()).release;
  assert.ok(r.includes("--match 'natsu-v*' HEAD^") && r.includes("--match 'v*' HEAD^"));
  assert.ok(r.includes('node tools/risk.js --base "$PREV" --head HEAD --checklist RELEASE-CHECK.md'));
  assert.ok(!r.includes('--base-tag'));
});

// 資産の名前は release.yml と updater.js で同じにする（第0a回 R3）
test('release.yml が作る zip の名前を、updater の ASSET_PATTERN が拾う', () => {
  const m = rel().match(/zip -q -r -X "\.\.\/([\w-]+)\$\{VER\}\.zip"/);
  assert.ok(m, 'zip の名前が読めない');
  assert.ok(require('../src/updater').ASSET_PATTERN.test(`${m[1]}0.1.0.zip`));
});
