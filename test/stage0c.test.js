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

// ---------------------------------------------------------------- EL3
test('EL3: pickDefaultPath は、今のファイルのフォルダ → 前に選んだフォルダ → エンジンの置き場所の順で、あるものを返す', () => {
  const { pickDefaultPath, PICK_KEYS } = require('../src/mainlib');
  const W = path.win32;
  const dirs = new Set(['C:\\tools\\whisper', 'D:\\前に選んだ', 'E:\\試験𠮷\\AppData\\Local\\natsu\\engine']);
  const o = { isDir: (d) => dirs.has(d), p: W, lastDir: 'D:\\前に選んだ', engineRoot: 'E:\\試験𠮷\\AppData\\Local\\natsu\\engine' };
  assert.deepStrictEqual(PICK_KEYS, ['localServerExe', 'localModelPath', 'vadModelPath', 'sumServerExe', 'sumModelPath']);
  assert.strictEqual(pickDefaultPath('localServerExe', { localServerExe: 'C:\\tools\\whisper\\whisper-server.exe' }, o), 'C:\\tools\\whisper');
  // 今のファイルのフォルダが無い（消した・別の PC の設定）→ 前に選んだフォルダ
  assert.strictEqual(pickDefaultPath('sumModelPath', { sumModelPath: 'Z:\\無い\\m.gguf' }, o), 'D:\\前に選んだ');
  // 空 → 前に選んだ → それも無ければエンジンの置き場所
  assert.strictEqual(pickDefaultPath('vadModelPath', { vadModelPath: '' }, o), 'D:\\前に選んだ');
  assert.strictEqual(pickDefaultPath('vadModelPath', {}, { ...o, lastDir: '' }), 'E:\\試験𠮷\\AppData\\Local\\natsu\\engine');
  // どれも無ければ undefined（Electron の既定に任せる）
  assert.strictEqual(pickDefaultPath('vadModelPath', {}, { ...o, isDir: () => false }), undefined);
  // 知らないキーでは設定の値を読まない（画面から任意のキーで設定の中身を開かせない）
  assert.strictEqual(pickDefaultPath('dataDir', { dataDir: 'C:\\tools\\whisper\\x' }, o), 'D:\\前に選んだ');
  assert.strictEqual(pickDefaultPath('__proto__', {}, { ...o, lastDir: '' }), 'E:\\試験𠮷\\AppData\\Local\\natsu\\engine');
});

test('EL3: 画面はキーの名前だけを送り、main は defaultPath を渡し、選んだフォルダを覚える', () => {
  const preload = read('src/preload.js');
  assert.ok(preload.includes("  pickFile: (kind, key) => ipcRenderer.invoke('dialog:pick', kind, key),"));
  const app = read('src/renderer/app.html');
  assert.ok(app.includes('const p = await window.koeApp.pickFile(kind, target);'));
  const m = code(read('src/main.js'));
  const pick = fnBody(m, "ipcMain.handle('dialog:pick'", '\n  });');
  assert.match(pick, /async \(_e, kind, key\) =>/);
  assert.match(pick, /pickDefaultPath\(String\(key \|\| ''\), settings,/);
  assert.match(pick, /\.\.\.\(defaultPath \? \{ defaultPath \} : \{\}\)/);
  assert.match(pick, /lastPickDir = path\.dirname\(res\.filePaths\[0\]\);/);
});

test('EL3: 画面の［選ぶ］ボタンが、それぞれのキーの名前を送る（simrun）', async () => {
  const { load } = require('./helpers/simrun.js');
  const l = await load(path.join(ROOT, 'src', 'renderer', 'app.html'));
  for (const [btn, kind, key] of [['pickExeBtn', 'exe', 'localServerExe'], ['pickModelBtn', 'model', 'localModelPath'], ['pickVadBtn', 'model', 'vadModelPath'],
    ['pickSumExeBtn', 'exe', 'sumServerExe'], ['pickSumModelBtn', 'model', 'sumModelPath']]) {
    l.byId.get(btn).dispatchEvent({ type: 'click' });
    await l.drain();
    const c = l.called('pickFile').pop();
    assert.deepStrictEqual(c.args, [kind, key], btn);
  }
});
