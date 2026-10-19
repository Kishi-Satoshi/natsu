/*
 * identity.test.js — アプリの名前（NaTsu）を固定する
 *
 *  - 画面・録音バー・ウィンドウ・トレイ・インストーラーの説明に出る表示名
 *  - 識別子（name・版・appId・exe の名前）と保存先 %APPDATA%\natsu
 *  - Windows の AppUserModelID とメッセージの窓の見出し
 *  - CHANGELOG は natsu-v0.1.0 から始める（Listener の古い節は持たない）
 *  - Listener の名前がリポジトリに残っていない（スクリプト・案内・テスト）
 *  - get-installer.ps1 の取得元は updater.REPO（Kishi-Satoshi/natsu）と同じ
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
// git が登録しているファイル（index の一覧）
const tracked = () => execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);

test('表示名は NaTsu（画面・録音バー・ウィンドウ・トレイ・インストーラーの説明）', () => {
  assert.ok(app.includes('<title>NaTsu</title>'));
  assert.ok(app.includes('<div class="wordmark">NaTsu</div>'));
  assert.ok(overlay.includes('<title>NaTsu Overlay</title>'));
  assert.ok(main.includes("    title: 'NaTsu',"));
  for (const s of ["'NaTsu — 議事録を記録中'", "'NaTsu — 録音中'", "'NaTsu — 処理中'", '`NaTsu — ${activeHotkeys.hotkey}: 音声入力']) {
    assert.ok(main.includes(s), s);
  }
  assert.strictEqual(pkg.description, 'NaTsu — 音声入力・議事録ツール（オンラインはクラウドの文字起こしと各自の Claude Code の要約、オフラインは手元の whisper と llama。出典リンク付き）');
});

// 第1b回 Task C-3 で意図して変えた: 版を 0.6.0 に（第1b回と第1b2回の画面・窓の覚え書き・一時停止。Electron は 44.9.0 のままなので［更新して再起動］で当たる）
test('識別子: name は natsu・版は 0.6.0・productName は build の中だけ（userData は %APPDATA%\\natsu）', () => {
  assert.strictEqual(pkg.name, 'natsu');
  assert.strictEqual(pkg.version, '0.6.0');
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

const TEXT = /\.(js|html|json|md|ps1|bat|yml)$|(^|\/)[^./]+$/;
test('Listener の名前がリポジトリに残っていない（CHANGELOG の履歴と計画書を除く）', () => {
  const hits = [];
  for (const f of tracked()) {
    if (f === 'CHANGELOG.md' || f.startsWith('docs/plans/') || f === 'test/identity.test.js' || !TEXT.test(f)) continue;
    read(f).split('\n').forEach((line, i) => {
      if (/\blistener\b/i.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(hits, []);
  assert.deepStrictEqual(tracked().filter((f) => /listener/i.test(f)), []);
});

test('get-installer.ps1 の取得元は updater.REPO と同じで、タグは natsu-v', () => {
  const ps = read('get-installer.ps1');
  assert.strictEqual((ps.match(/\$repo = "([^"]+)"/) || [])[1], require('../src/updater').REPO);
  assert.ok(ps.includes('releases/tags/natsu-v$Version'));
});

test('CHANGELOG に今の版の節（## natsu-v<version>）がある（release.yml が本文に使う）', () => {
  assert.match(read('CHANGELOG.md'), new RegExp(`^## natsu-v${pkg.version.replace(/\./g, '\\.')}$`, 'm'));
});

test('CHANGELOG の先頭の節は今の版（新しい節は上に足す）', () => {
  const heads = read('CHANGELOG.md').split('\n').filter((l) => l.startsWith('## '));
  assert.strictEqual(heads[0], `## natsu-v${pkg.version}`);
});

// 守りのテスト（今は通る）。読んだ文字の U+FEFF を外さずに writePs1 へ渡すと BOM が2つになる（全体の決まり）
test('.ps1 の BOM は1つだけ（4バイト目から EF BB BF が続かない）', () => {
  for (const f of tracked().filter((x) => x.endsWith('.ps1'))) {
    const b = fs.readFileSync(path.join(ROOT, f));
    assert.ok(!(b[3] === 0xEF && b[4] === 0xBB && b[5] === 0xBF), `${f}: BOM が2つある`);
  }
});

// 第1c回 Task D-2（OL9）: 0.5.0 からはオンラインのとき音声を送り先へ、文字起こしの文を Claude へ送る。
// 「完全オフライン」「外へ送らない」と言い続けると、利用者が音声の行き先を誤って思う
test('OL9: README と INSTALL は、送るもの・送り先・同意・［この会議は PC の中だけ］・Claude Code の入れ方・上限を書き、「完全オフライン」と言わない', () => {
  for (const w of ['音声', '送り先', '同意', 'PC の中だけ', 'irm https://claude.ai/install.ps1 | iex', '上限', 'claude auth status', '"authMethod": "claude.ai"',
    'api.groq.com', 'api.openai.com', 'claude.ai', 'api.anthropic.com', 'Zscaler']) {
    assert.ok(readme.includes(w), `README に「${w}」が無い`);
  }
  for (const [n, s] of [['README.md', readme], ['INSTALL.md', install], ['package.json', JSON.stringify(pkg)], ['src/main.js', main]]) {
    assert.ok(!s.includes('完全オフライン'), `${n} に「完全オフライン」が残っている`);
  }
  assert.ok(!readme.includes('外部への送信は一切ありません') && !readme.includes('外部へ送信されることはありません'), 'README が外へ送らないと言っている');
  assert.ok(!install.includes('外部に音声やテキストが送られることはありません'), 'INSTALL が外へ送らないと言っている');
  for (const h of ['api.groq.com', 'api.openai.com', 'claude.ai', 'api.anthropic.com']) assert.ok(install.includes(h), `INSTALL の接続先に ${h} が無い`);
});

test('OL9: CHANGELOG の 0.5.0 の節は、更新の前に Claude Code を入れてログインすることを、入れ方の文と一緒に頭に書く', () => {
  const cl = read('CHANGELOG.md');
  const sec = cl.slice(cl.indexOf('## natsu-v0.5.0'), cl.indexOf('## natsu-v0.4.0'));
  const head = sec.split('\n').slice(0, 4).join('\n');
  assert.ok(head.includes('更新の前に') && head.includes('Claude Code'), '頭に「更新の前に Claude Code」が無い');
  for (const w of ['irm https://claude.ai/install.ps1 | iex', 'claude auth status', '同意', '送り先', 'Groq', 'OpenAI', 'この会議は PC の中だけ', 'オフライン', '上限']) {
    assert.ok(sec.includes(w), `0.5.0 の節に「${w}」が無い`);
  }
});

// 第1b回 Task C-3（G3）と第1b2回の「つなぎ」: README の使い方に、サイドバー・タブ・Ctrl+クリック・拡大・一時停止・覚えるもの（window-state.json）、
// 検索の窓（［🔍 検索］・Ctrl+P）と［＋ 新しい議事録］を書く。古い言い方（「一覧から検索」「開いているタブの内容をコピー」）は残さない
test('第1b回 C-3: README は新しい画面の使い方（サイドバー・タブ・検索の窓・記録中のページ・一時停止・拡大・覚えるもの）を書く', () => {
  for (const w of ['サイドバー', 'タブ', 'Ctrl+クリック', '拡大', '一時停止', 'window-state.json', '%LOCALAPPDATA%\\natsu', '［🔍 検索］', 'Ctrl+P', '［＋ 新しい議事録］',
    'Ctrl+Shift+P', 'Ctrl+\\', '200%', 'スリープ']) {
    assert.ok(readme.includes(w), `README に「${w}」が無い`);
  }
  assert.ok(!readme.includes('開いているタブの内容をコピー'), 'README に古い「開いているタブの内容をコピー」が残っている（「···」の［コピー］）');
  assert.ok(!readme.includes('一覧から検索'), 'README に古い「一覧から検索」が残っている（［🔍 検索］の窓）');
});

// 第1b回 Task C-3: CHANGELOG の 0.6.0 の節。更新は［更新して再起動］で当たること・新しい画面・ログインのボタンと切れたときの文・鍵の確かめ・速さを、
// 平易な日本語で書く（「Notion」とは書かない: 第1b2回の決まり）
test('第1b回 C-3: CHANGELOG の 0.6.0 の節は、更新の仕方・新しい画面・Claude Code のボタン・鍵の確かめ・速さを書き、「Notion」と書かない', () => {
  const cl = read('CHANGELOG.md');
  assert.ok(cl.indexOf('## natsu-v0.6.0') >= 0 && cl.indexOf('## natsu-v0.6.0') < cl.indexOf('## natsu-v0.5.0'), '0.6.0 の節が 0.5.0 の上に無い');
  const sec = cl.slice(cl.indexOf('## natsu-v0.6.0'), cl.indexOf('## natsu-v0.5.0'));
  assert.ok(sec.split('\n').slice(0, 4).join('\n').includes('［更新して再起動］'), '頭に［更新して再起動］で当たることが無い');
  for (const w of ['サイドバー', 'タブ', '［🔍 検索］', 'Ctrl+P', '記録中', 'Ctrl+Shift+P', 'スリープ', 'window-state.json', '拡大',
    '［Claude Code にログイン］', '［Claude Code を入れる］', 'Claude Code のログインが切れています', 'OpenAI', '鍵', '速く']) {
    assert.ok(sec.includes(w), `0.6.0 の節に「${w}」が無い`);
  }
  assert.ok(!/notion/i.test(sec), '0.6.0 の節に「Notion」と書いた');
});
