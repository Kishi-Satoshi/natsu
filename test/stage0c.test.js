/*
 * stage0c.test.js — 第0c回（土台の入れ替え）の形を固定する
 * 実行して確かめられるものは別のファイル（clipboard / update-info / update-app / launch / sqlite-probe / electron-smoke）。
 * ここは、ファイルの形と結線（注釈を落としてから見る）だけを見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tracked = () => execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
// 注釈に一致して素通りしないよう、注釈を落としてから見る（loopback.test.js と同じ）
const code = (s) => String(s).replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fnBody = (src, head, end) => { const i = src.indexOf(head); return i < 0 ? '' : src.slice(i, src.indexOf(end, i) + end.length); };

// ---------------------------------------------------------------- EL0
test('EL0: 台帳（.superpowers/）を git に入れない', () => {
  const lines = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
  assert.ok(lines.includes('.superpowers/'), '.gitignore に .superpowers/ が無い');
  assert.deepStrictEqual(tracked().filter((f) => f.startsWith('.superpowers/')), []);
});

test('EL0: src/ のコードと注釈に「Notion」と書かない（考え方だけを参考にする決まり）', () => {
  const hits = [];
  for (const f of tracked().filter((x) => /^src\/.*\.(js|html|css|json)$/.test(x))) {
    read(f).split('\n').forEach((line, i) => { if (/notion/i.test(line)) hits.push(`${f}:${i + 1}`); });
  }
  assert.deepStrictEqual(hits, []);
});

test('EL0: userData の databases という名前のフォルダを使わない（Electron 32 から Chromium が消す）', () => {
  for (const f of tracked().filter((x) => /^src\/.*\.js$/.test(x))) assert.ok(!/['"`]databases['"`]/.test(read(f)), f);
});

// ---------------------------------------------------------------- EL2
test('EL2: 画面の取り込みの受け口は、断るときに null を渡し、枠の読み取りと callback の例外で main を落とさない', () => {
  const m = code(read('src/main.js'));
  const i = m.indexOf('setDisplayMediaRequestHandler(');
  assert.ok(i > 0);
  const body = m.slice(i, m.indexOf('\n    });', i));
  assert.match(body, /const streams = chooseDisplayMedia\(\{/);
  assert.match(body, /try \{ callback\(streams\); \} catch \(e\) \{/);
  assert.match(body, /try \{ frame = \(request && request\.frame\) \|\| null;/);
  assert.ok(!/callback\(\{\}\)/.test(body), '{} を渡している');
  const lb = code(read('src/loopback.js'));
  assert.ok(!/return \{\};/.test(lb), 'loopback.js が {} を返している');
});
