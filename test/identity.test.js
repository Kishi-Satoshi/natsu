/*
 * identity.test.js — アプリの名前（NaTsu）を固定する
 *
 *  - 画面・録音バー・ウィンドウ・トレイ・インストーラーの説明に出る表示名
 *  - 識別子（name・版・appId・exe の名前）と保存先 %APPDATA%\natsu
 *  - Windows の AppUserModelID とメッセージの窓の見出し
 *  - CHANGELOG は natsu-v0.1.0 から始める（Listener の古い節は持たない）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = read('src/renderer/app.html');
const overlay = read('src/renderer/overlay.html');
const main = read('src/main.js');
const pkg = JSON.parse(read('package.json'));
const readme = read('README.md');
const install = read('INSTALL.md');
// 行頭の // コメントと /* */ を落とす（コメントの中の文字で通らないように）
const code = (t) => String(t).replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('表示名は NaTsu（画面・録音バー・ウィンドウ・トレイ・インストーラーの説明）', () => {
  assert.ok(app.includes('<title>NaTsu</title>'));
  assert.ok(app.includes('<div class="wordmark">NaTsu</div>'));
  assert.ok(overlay.includes('<title>NaTsu Overlay</title>'));
  assert.ok(main.includes("    title: 'NaTsu',"));
  for (const s of ["'NaTsu — 議事録を記録中'", "'NaTsu — 録音中'", "'NaTsu — 処理中'", '`NaTsu — ${activeHotkeys.hotkey}: 音声入力']) {
    assert.ok(main.includes(s), s);
  }
  assert.strictEqual(pkg.description, 'NaTsu — 完全オフラインの音声入力・議事録ツール（ローカルLLM要約 + 出典リンク付き）');
});

test('識別子: name は natsu・版は 0.1.0・productName は build の中だけ（userData は %APPDATA%\\natsu）', () => {
  assert.strictEqual(pkg.name, 'natsu');
  assert.strictEqual(pkg.version, '0.1.0');
  assert.strictEqual(pkg.productName, undefined, 'top-level の productName は userData の名前を変える');
  assert.strictEqual(pkg.build.productName, 'NaTsu');
  assert.strictEqual(pkg.build.appId, 'local.natsu.app');
  assert.strictEqual(pkg.build.nsis.shortcutName, 'NaTsu');
  assert.strictEqual(pkg.build.nsis.artifactName, 'NaTsu-${version}-setup.exe');
  assert.strictEqual(pkg.build.portable.artifactName, 'NaTsu-${version}-portable.exe');
  for (const [n, s] of [['README.md', readme], ['INSTALL.md', install]]) {
    assert.ok(s.includes('%APPDATA%\\natsu\\'), `${n}: 保存先`);
    assert.ok(s.includes('%LOCALAPPDATA%\\Programs\\NaTsu'), `${n}: インストール先`);
  }
});

// 配る package.json から build は消える（app-builder-lib の fileTransformer）。
// そのため main.js は appId を写しで持つ。写しが build.appId と食い違わないことをここで見る
test('起動の初めに AppUserModelID を build.appId にする（Windows だけ。窓とトレイより先）', () => {
  const m = code(main);
  assert.ok(m.includes(`const APP_ID = '${pkg.build.appId}';`), 'main.js の APP_ID が build.appId と食い違う');
  const i = m.indexOf("if (process.platform === 'win32') app.setAppUserModelId(APP_ID);");
  assert.ok(i > 0, 'setAppUserModelId を呼んでいない（Windows だけの関数なので win32 のときだけ呼ぶ）');
  assert.ok(i < m.indexOf('app.requestSingleInstanceLock()'), '起動の初めに呼んでいない');
});

test('メッセージの窓には見出し NaTsu を渡す（渡さないと Windows は小文字の natsu を出す）', () => {
  const m = code(main);
  assert.ok(m.includes("const APP_TITLE = 'NaTsu';"), 'APP_TITLE が無い');
  const at = [...m.matchAll(/dialog\.showMessageBox(Sync)?\(/g)].map((x) => x.index);
  assert.ok(at.length > 0, 'メッセージの窓が見つからない（検査が空振りしている）');
  for (const i of at) {
    const call = m.slice(i, m.indexOf('});', i));
    assert.ok(call.includes('title: APP_TITLE'), `見出しを渡していない: ${call.split('\n')[0]}`);
  }
});

test('CHANGELOG は natsu-v0.1.0 から始まり、Listener の古い節（## v…）を持たない', () => {
  const heads = read('CHANGELOG.md').split('\n').filter((l) => l.startsWith('## '));
  assert.ok(heads.includes('## natsu-v0.1.0'), 'natsu-v0.1.0 の節が無い');
  assert.deepStrictEqual(heads.filter((h) => !/^## natsu-v\d+\.\d+\.\d+$/.test(h)), []);
});
