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
  // 第1d回 G-4 で意図して変えた: オンラインの文字起こしは会社の中継を通した OpenAI（PC は OpenAI へ直に送らない）
  // 0.10.0 LS-5（D59）で意図して変えた: 要約は Claude Code だけ（llama を外した）
  assert.strictEqual(pkg.description, 'NaTsu — 音声入力・議事録ツール（オンラインは文字起こしの中継を通した OpenAI の文字起こしと各自の Claude Code の要約、オフラインの文字起こしは手元の whisper。出典リンク付き）');
});

// 第1b回 Task C-3 で意図して変えた: 版を 0.6.0 に（第1b回と第1b2回の画面・窓の覚え書き・一時停止。Electron は 44.9.0 のままなので［更新して再起動］で当たる）
// 第1d回 G-4 で意図して変えた: 版を 0.8.0 に（中継と Cloudflare Access のログイン・区切り 15 秒・録音中のページの状態・録音中の再起動の守り。Electron は 44.9.0 のまま）
// 0.9.0 G-3 で意図して変えた: 版を 0.9.0 に（任意のオフラインの準備・設定のポップアップ・録音バーの作り直し・帯の文。Electron は 44.9.0 のまま）
// 0.9.1 で意図して変えた: 版を 0.9.1 に（話し声の無い区間を書かない・話し声が無いときに自動で止める。Electron は 44.9.0 のまま）
// 0.9.2 で意図して変えた: 版を 0.9.2 に（設定の説明を1行にして ⓘ の吹き出しへ・アプリからヘルプを開く。Electron は 44.9.0 のまま）
// 0.9.3 で意図して変えた: 版を 0.9.3 に（会議の検出の通知・録音中のページの音の波・オフラインモードとローカル AIの名前・オフラインモードの札。Electron は 44.9.0 のまま）
// 0.9.4 で意図して変えた: 版を 0.9.4 に（会議の検出の直し・音声を消さない・遅い PC の扱い・音の波と録音バー・ローカル AI の名前・中継の安定。Electron は 44.9.0 のまま）
// 0.10.0 で意図して変えた: 版を 0.10.0 に（Claude から議事録を読む MCP・議事録のリンク・要約は Claude Code だけ・ポータブル版をやめる。Electron は 44.9.0 のまま）
// 0.10.1 で意図して変えた: 版を 0.10.1 に（Microsoft Store 版の Claude デスクトップの新しい設定の場所・動いている間は書かない・起動のときに登録し直す。Electron は 44.9.0 のまま）
// 0.11.0 で意図して変えた: 版を 0.11.0 に（会議の種類とメモの型・要約の締めと次に気をつけること・打ち合わせの質・一般・その他をなくした。Electron は 44.9.0 のまま）
// 0.11.1 で意図して変えた: 版を 0.11.1 に（ロゴの差し替え: 箱の中のリス。Electron は 44.9.0 のまま）
// 0.12.0 で意図して変えた: 版を 0.12.0 に（相手の声を取り込む会議の2つの流れの文字起こしと「自分」「相手」の札。Electron は 44.9.0 のまま）
// 0.12.1 で意図して変えた: 版を 0.12.1 に（会議を出たら聞かずに録音を止めて議事録を作る。Electron は 44.9.0 のまま）
// 0.13.0 で意図して変えた: 版を 0.13.0 に（要約の書き直し・録音の前のページ・ヘルプセンターを明るい版だけに。Electron は 44.9.0 のまま）
// 0.13.1 で意図して変えた: 版を 0.13.1 に（要約の入れ子とトグル。Electron は 44.9.0 のまま）
// 0.13.2 で意図して変えた: 版を 0.13.2 に（ログインしていないことに気づける・残った区間が止まらない・パネルを下の中央に。Electron は 44.9.0 のまま）
test('識別子: name は natsu・版は 0.13.2・productName は build の中だけ（userData は %APPDATA%\\natsu）', () => {
  assert.strictEqual(pkg.name, 'natsu');
  assert.strictEqual(pkg.version, '0.13.2');
  assert.strictEqual(pkg.productName, undefined, 'top-level の productName は userData の名前を変える');
  assert.strictEqual(pkg.build.productName, 'NaTsu');
  assert.strictEqual(pkg.build.appId, 'local.natsu.app');
  assert.strictEqual(pkg.build.nsis.shortcutName, 'NaTsu');
  assert.strictEqual(pkg.build.nsis.artifactName, 'NaTsu-${version}-setup.exe');
  assert.strictEqual(pkg.build.portable, undefined, '0.10.0 PB-1（D76）: ポータブル版は作らない');
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
  assert.ok(heads.some((h) => /^## natsu-v0\.1\.0( |$)/.test(h)), 'natsu-v0.1.0 の節が無い');
  // help-relnotes RN-1（RN4・Q1）で意図して変えた: 見出しは「## natsu-v<版>」か「## natsu-v<版> （<日付>）」（半角の空白の後に全角の括弧）
  assert.deepStrictEqual(heads.filter((h) => !HEAD.test(h)), []);
});

// help-relnotes RN-1: CHANGELOG の見出しの形（日付は任意。日付の無い節はまだ出していない版）
/** CHANGELOG に「## natsu-v<版>」か「## natsu-v<版> （<日付>）」の節がある */
const hasSec = (cl, v) => new RegExp(`\\n## natsu-v${v.replace(/\./g, '\\.')}(?: （\\d{4}-\\d{2}-\\d{2}）)?\\n`).test(cl);
const HEAD = /^## natsu-v(\d+)\.(\d+)\.(\d+)(?: （(\d{4})-(\d{2})-(\d{2})）)?$/;
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
  assert.match(read('CHANGELOG.md'), new RegExp(`^## natsu-v${pkg.version.replace(/\./g, '\\.')}(?: （\\d{4}-\\d{2}-\\d{2}）)?$`, 'm'));
});

test('CHANGELOG の先頭の節は今の版（新しい節は上に足す）', () => {
  const heads = read('CHANGELOG.md').split('\n').filter((l) => l.startsWith('## '));
  assert.match(heads[0], new RegExp(`^## natsu-v${pkg.version.replace(/\./g, '\\.')}(?: （|$)`));
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
// 第1d回 G-2 で意図して変えた: 0.8.0 からは、音声は PC → 文字起こしの中継（Cloudflare の workers.dev）→ OpenAI。PC は OpenAI・Groq へ直に送らない
// （src/ に api.openai.com・api.groq.com を書けない: ゲート）。前の版の送り先の表（api.groq.com）と、PC が直に送る先としての api.openai.com は書かない。
// 0.7.0 の D5 で消した「使う／使わない」の同意の選択は、もう求めない
// 第1d回 G-3 で意図して変えた（作り替え。D18）: ログインは Cloudflare Access の One-time PIN（英語の Cloudflare の画面と、Cloudflare が送るコードの
// メール）。NaTsu の自前の確認コードのメール（Resend）・MAIL_DAILY_MAX の話は書かない。中継の住所は src/relay.js の RELAY_BASE（本物の住所。
// 第1d回 A-10）と同じ。INSTALL の接続先に Access のログインの画面（<チームの名前>.cloudflareaccess.com）を足す（チームの名前は書かない）
const RELAY_HOST = new URL(require('../src/relay').RELAY_BASE).host;
// 0.9.3 M-0（D54）で意図して変えた: ［この会議は PC の中だけ］は［オフラインモード］に呼び直した（README・INSTALL も「オフラインモード」を書く）
test('OL9・RL9・D18: README と INSTALL は、中継の住所・中継の先の OpenAI・Cloudflare Access のログイン（One-time PIN）・［オフラインモード］・Claude Code の入れ方・上限を書き、Groq の送り先・「完全オフライン」・Resend・確認コードを書かない', () => {
  assert.match(RELAY_HOST, /^natsu-relay\.[a-z0-9-]+\.workers\.dev$/);
  for (const w of ['音声', '送り先', RELAY_HOST, 'Cloudflare Access', 'One-time PIN', 'OpenAI', 'ログイン', '［ログイン］', '［Send login code］', '［Sign in］', '英語',
    'オフラインモード', 'オフライン', 'irm https://claude.ai/install.ps1 | iex', '上限', 'claude auth status', '"authMethod": "claude.ai"', 'claude.ai', 'api.anthropic.com',
    'Zscaler', '情報システム', 'noreply＠notify.cloudflare.com']) {
    assert.ok(readme.includes(w), `README に「${w}」が無い`);
  }
  for (const w of [RELAY_HOST, 'Cloudflare', 'One-time PIN', 'OpenAI', 'ログイン', '［ログイン］', '［Send login code］', '［Sign in］', '英語', 'オフラインモード']) {
    assert.ok(install.includes(w), `INSTALL に「${w}」が無い`);
  }
  for (const [n, s] of [['README.md', readme], ['INSTALL.md', install], ['package.json', JSON.stringify(pkg)], ['src/main.js', main]]) {
    assert.ok(!s.includes('完全オフライン'), `${n} に「完全オフライン」が残っている`);
    assert.ok(!s.includes('api.groq.com'), `${n} に前の版の送り先 api.groq.com が残っている`);
  }
  for (const [n, s] of [['README.md', readme], ['INSTALL.md', install]]) {
    for (const w of ['確認コード', 'Resend', 'MAIL_DAILY_MAX', 'MAIL_FROM', 'RESEND_API_KEY', '/auth/start', 'UPDATE sessions', '<サブドメイン>']) {
      assert.ok(!s.includes(w), `${n} に自前のログインの「${w}」が残っている（D18）`);
    }
  }
  assert.ok(!readme.includes('外部への送信は一切ありません') && !readme.includes('外部へ送信されることはありません'), 'README が外へ送らないと言っている');
  assert.ok(!install.includes('外部に音声やテキストが送られることはありません'), 'INSTALL が外へ送らないと言っている');
  // 社内のプロキシで通す接続先: PC が直に話す先は中継・Access のログインの画面・claude.ai・api.anthropic.com だけ（OpenAI へは中継が送る）
  const hosts = install.slice(install.indexOf('## 通す必要のある接続先'), install.indexOf('\n## ', install.indexOf('## 通す必要のある接続先') + 3));
  for (const h of [RELAY_HOST, '<チームの名前>.cloudflareaccess.com', 'claude.ai', 'api.anthropic.com']) assert.ok(hosts.includes(h), `INSTALL の接続先に ${h} が無い`);
  assert.ok(!hosts.includes('api.openai.com'), 'INSTALL の接続先に api.openai.com が残っている（PC は OpenAI へ直に送らない）');
});

// 第1d回 G-2: README の管理者の節に、中継の用意と取り消しの手順を書く。第1d回 G-3 で意図して変えた（作り替え。D18）: 用意は計画の
// 「利用者の用意（作り替え）」を写し（会社のドメインとチームの名前は <会社のドメイン>・<チームの名前>）、取り消しは Cloudflare Access の画面
// （Revoke・Exclude・Remove users・Revoke existing tokens）と、中継の止めたメールの SQL（test/relay-access.test.js の RL6 が README から読み、
// 偽の D1 に流して 403 になることを見る）。自前の札の取り消しの SQL（UPDATE sessions）と確認コードの節は書かない
test('RL6・RL12・D18: README の管理者の節は、Access の用意・取り消し（Revoke）・止め方（Exclude と止めたメールの SQL）・席・全員のログアウト・送り元の許可・サービストークンの期限・会社の鍵とトークンが漏れたときの替え方を書く', () => {
  const at = readme.indexOf('## 管理者の手順');
  assert.ok(at > 0, 'README に「## 管理者の手順」が無い');
  const sec = readme.slice(at, readme.indexOf('\n## ', at + 3) < 0 ? readme.length : readme.indexOf('\n## ', at + 3));
  for (const w of [
    "INSERT INTO blocked_emails (email, at) VALUES ('<メール（小文字）>', CAST(strftime('%s','now') AS INTEGER));",
    "DELETE FROM blocked_emails WHERE email = '<メール>';",
    '［Storage & Databases］', '［D1］', '`natsu-relay`', '［Console］', '［Execute］', '［Variables and Secrets］', '`OPENAI_API_KEY`', '［Deploy］',
    '［API Tokens］', '`CLOUDFLARE_API_TOKEN`', '`CLOUDFLARE_ACCOUNT_ID`', '`ALLOWED_EMAIL_DOMAINS`', '`TEAM_DOMAIN`', '`POLICY_AUD`',
    '`CF_ACCESS_CLIENT_ID`', '`CF_ACCESS_CLIENT_SECRET`', '［Run workflow］', '/health', 'Environments',
    '［Zero Trust］', 'One-time PIN', '［Protect this Worker behind Access］', 'Login Methods', 'Service Auth', 'Application Audience (AUD) Tag',
    '<会社のドメイン>', '<チームの名前>', '［Team & Resources］', '［Users］', '［Revoke］', 'Exclude', '［Remove users］', '［Revoke existing tokens］',
    '［Refresh］', '［Rotate secret］', 'noreply＠notify.cloudflare.com', '7 日（1 週間）',
  ]) assert.ok(sec.includes(w), `管理者の節に「${w}」が無い`);
  // Revoke だけでは、その人はまたログインできる（止めるには Exclude と中継の止めたメール）
  assert.match(sec, /［Revoke］[^\n]*またログインできます/, 'Revoke だけではまたログインできると書いていない');
  // + の付いた別名は中継がいつも断る・Worker 単位の Access は外さない
  assert.match(sec, /`\+`[^\n]*中継[^\n]*断/, '+ の付いた別名を中継が断ると書いていない');
  assert.match(sec, /Worker 単位の Access は外さない/, 'Worker 単位の Access を外さないと書いていない');
  // 外しても止まるのは新しいログインだけで、もう出たログインは期限まで中継で通る（外すことを止め方と読ませない。G-3 の点検）
  const keep = sec.split('\n').find((l) => l.includes('Worker 単位の Access は外さない')) || '';
  assert.ok(!keep.includes('全員が使えなく'), 'Access を外すと全員が使えなくなると書いている（もう出たログインは期限まで通る）');
  assert.match(keep, /新しいログイン[^\n]*もう出たログイン[^\n]*期限[^\n]*通/, '外しても、もう出たログインは期限まで通ると書いていない');
  // 送り元のアドレスは ＠ を全角で書き、半角で入れると添える（公開前の確認: test/repo.test.js）
  assert.match(sec, /noreply＠notify\.cloudflare\.com[^\n]*半角/, '送り元（＠ は全角・半角で入れる）が無い');
  // 会社のドメインとチームの名前は書かない（Cloudflare の設定と Worker の秘密の欄にだけ）
  assert.ok(!/(?<![\w-])[a-z0-9-]+\.cloudflareaccess\.com/i.test(readme), 'README にチームのドメインの字面がある');
  assert.ok(!/(?<![\w-])[a-z0-9-]+\.cloudflareaccess\.com/i.test(install), 'INSTALL にチームのドメインの字面がある');
});

// 第1d回 統合（G-4 の前）: ログインの長さは 7 日（利用者が 2026-10-20 に決め、Access の app の Session Duration を 7 日にした）。
// G-3 で書いた「1 month」「1 か月」は README・INSTALL に残さない（ログインの長さを2通りに書かない）
test('D18・K15: ログインの長さは 7 日。README の利用者の節と管理者の節・INSTALL のログインの手順が同じ 7 日を書き、「1 か月」「1 month」を書かない', () => {
  for (const [n, s] of [['README.md', readme], ['INSTALL.md', install]]) {
    assert.ok(!/1 ?か月|1 ?month/i.test(s), `${n} にログインの長さの「1 か月」「1 month」が残っている`);
  }
  assert.ok(readme.includes('ログインは、管理者が決めた長さ（7 日）で切れます'), 'README の利用者の節にログインの長さ（7 日）が無い');
  assert.match(readme, /「Session Duration」を 7 日（1 週間）にします/, 'README の管理者の節に Session Duration の 7 日が無い');
  assert.match(readme, /Worker 単位の Access は外さない[^\n]*期限（7 日）/, 'README の「Worker 単位の Access は外さない」の期限が 7 日でない');
  assert.ok(install.includes('ログインは 7 日で切れます'), 'INSTALL のログインの手順にログインの長さ（7 日）が無い');
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

// 第2a1回 Task G-3（G3）: 試作の名前を持ち込まない・版 0.7.0・README の保存の説明
test('2a1: 試作の名前を持ち込んでいない（listener.db・Listener DB・koetype・app.setPath）', () => {
  // app.setPath は src だけを見る（tools/shots・tools/electron-smoke・tools/net-smoke は一時フォルダを使うために今も呼んでいる）。
  // koetype は test/repo.test.js が「README に無いこと」を確かめるために文字として持っている
  const allowed = { koetype: ['test/identity.test.js', 'test/repo.test.js'] };
  for (const f of tracked().filter((x) => /^(src|test|tools)\/.*\.(js|html)$/.test(x))) {
    const s = read(f);
    for (const bad of ['listener.db', 'Listener DB', 'koetype']) assert.ok(!s.includes(bad) || f === 'test/identity.test.js' || (allowed[bad] || []).includes(f), `${f}: ${bad}`);
    if (f.startsWith('src/')) assert.ok(!s.includes('app.setPath('), `${f}: app.setPath`);
  }
});

// 第1d回 G-4 で意図して変えた: 版は 0.8.0（README の保存の説明は 0.7.0 のまま）
// 0.9.0 G-3 で意図して変えた: 版は 0.9.0（README の保存の説明は 0.7.0 のまま）
// 0.9.1 で意図して変えた: 版は 0.9.1（README の保存の説明は 0.7.0 のまま）
// 0.9.2 で意図して変えた: 版は 0.9.2（README の保存の説明は 0.7.0 のまま）
// 0.9.3 で意図して変えた: 版は 0.9.3（README の保存の説明は 0.7.0 のまま）
// 0.9.4 で意図して変えた: 版は 0.9.4（README の保存の説明は 0.7.0 のまま）
// 0.10.0 で意図して変えた: 版は 0.10.0（README の保存の説明は 0.7.0 のまま）
// 0.10.1 で意図して変えた: 版は 0.10.1（README の保存の説明は 0.7.0 のまま）
// 0.11.0 で意図して変えた: 版は 0.11.0（README の保存の説明は 0.7.0 のまま）
// 0.11.1 で意図して変えた: 版は 0.11.1（README の保存の説明は 0.7.0 のまま）
// 0.12.0 で意図して変えた: 版は 0.12.0（README の保存の説明は 0.7.0 のまま）
// 0.12.1 で意図して変えた: 版は 0.12.1（README の保存の説明は 0.7.0 のまま）
// 0.13.0 で意図して変えた: 版は 0.13.0（README の保存の説明は 0.7.0 のまま）
// 0.13.1 で意図して変えた: 版は 0.13.1（README の保存の説明は 0.7.0 のまま）
// 0.13.2 で意図して変えた: 版は 0.13.2（README の保存の説明は 0.7.0 のまま）
test('0.7.0・0.8.0・0.9.0・0.9.1・0.9.2・0.9.3・0.9.4・0.10.0・0.10.1・0.11.0・0.11.1・0.12.0・0.12.1・0.13.0・0.13.1・0.13.2: 版と、README の保存の説明（natsu.db・backup・元の JSON を残す・古い版に戻したとき・控えに残る期間）', () => {
  assert.strictEqual(require('../package.json').version, '0.13.2');
  const r = read('README.md');
  for (const w of ['natsu.db', 'data\\backup', '元の JSON', '古い版', '3 日', '2 週']) assert.ok(r.includes(w), w);
});

// 第2a1回 G-3: CHANGELOG の 0.7.0 の節。更新は［更新して再起動］で当たること・保存の形（natsu.db・元のファイルを残す）・検索・控え・
// 録音は保存の仕組みに頼らない・削除・古い版に戻したとき、と、同じ 0.7.0 に入る設定の画面の2つ（送り先を OpenAI に固定・外観）を書く
test('0.7.0: CHANGELOG の 0.7.0 の節は、更新の仕方・保存の形・検索・控え・録音・削除・古い版に戻したとき・送り先・外観を書く', () => {
  const cl = read('CHANGELOG.md');
  assert.ok(cl.indexOf('## natsu-v0.7.0') >= 0 && cl.indexOf('## natsu-v0.7.0') < cl.indexOf('## natsu-v0.6.0'), '0.7.0 の節が 0.6.0 の上に無い');
  const sec = cl.slice(cl.indexOf('## natsu-v0.7.0'), cl.indexOf('## natsu-v0.6.0'));
  assert.ok(sec.split('\n').slice(0, 4).join('\n').includes('［更新して再起動］'), '頭に［更新して再起動］で当たることが無い');
  for (const w of ['natsu.db', '元のファイル', '検索', 'data\\backup', '録音', '［削除］', '0.6.0 に戻したとき', '3日', '2週', 'OpenAI', '外観', 'Ctrl+Shift+L']) {
    assert.ok(sec.includes(w), `0.7.0 の節に「${w}」が無い`);
  }
  assert.ok(!/notion/i.test(sec), '0.7.0 の節に「Notion」と書いた');
  // 第1d回 W-1・D-1（中継の骨組みと出し方）は 0.7.0 の版で main に入る。アプリには入らず、動きは変わらないことを1行で書く
  assert.ok(/^- .*次の版（0\.8\.0）の中継の準備.*アプリの動きは変わりません/m.test(sec), '0.7.0 の節に中継の準備の行が無い');
});

// 第1d回 G-4: CHANGELOG の 0.8.0 の節（保留した 0647c6c の節を、ログインを Cloudflare Access にした作り替えに合わせて書き直した）。
// 頭に「更新の後、［ログイン］で英語の Cloudflare の画面からログインする（するまでは PC の中）」を書き、中継・ログインの窓・7 日・鍵の欄を消したこと・
// 手元でやり直すこと・区切り 15 秒・録音中のページの状態と帯・Windows の知らせ・［この会議は PC の中だけ］の場所・カード「オフライン」・録音中の再起動の守り・
// 接続先を平易な日本語で書く。前の自前のログイン（確認コードのメール・Resend・30 日／180 日）は書かない
test('0.8.0: CHANGELOG の 0.8.0 の節は、頭に更新の後の Cloudflare の画面でのログインを書き、中継・ログインの窓・7 日・鍵の欄・手元のやり直し・15 秒・帯・再起動の守りを書く', () => {
  const cl = read('CHANGELOG.md');
  assert.ok(cl.indexOf('## natsu-v0.8.0') >= 0 && cl.indexOf('## natsu-v0.8.0') < cl.indexOf('## natsu-v0.7.0'), '0.8.0 の節が 0.7.0 の上に無い');
  const sec = cl.slice(cl.indexOf('## natsu-v0.8.0'), cl.indexOf('## natsu-v0.7.0'));
  const head = sec.split('\n').slice(0, 4).join('\n');
  assert.ok(head.includes('［更新して再起動］'), '頭に［更新して再起動］で当たることが無い');
  assert.ok(head.includes('更新の後、設定の「アカウント」の［ログイン］を押し、英語の Cloudflare の画面で会社のメールアドレスとメールの 6 けたのコードでログインしてください。ログインするまでは PC の中で文字起こしします'),
    '頭に更新の後のログインが無い');
  for (const w of ['文字起こしの中継', 'workers.dev', 'OpenAI', '［ログイン］', '［Send login code］', '［Sign in］', '7 日', '［ログインし直す］', '［詳細設定（管理者用）］', '鍵',
    'PC の中で文字起こしし直します', 'この会議は PC の中だけ', '15 秒', '録音中のページ', '［もう一度］', 'Windows の知らせ', 'オフライン', '［PC の中で試す］', '再起動',
    'natsu-relay.natsu-code.workers.dev', '<チームの名前>.cloudflareaccess.com', 'claude.ai', 'api.anthropic.com', '管理者の手順']) {
    assert.ok(sec.includes(w), `0.8.0 の節に「${w}」が無い`);
  }
  for (const w of ['確認コード', 'Resend', '30 日', '180 日', '［確認コードを送る］', 'nt1_', '1 か月', '1 month']) assert.ok(!sec.includes(w), `0.8.0 の節に前のログインの「${w}」を書いた`);
  assert.ok(!/(?<![\w-])[a-z0-9-]+\.cloudflareaccess\.com/i.test(sec), '0.8.0 の節にチームのドメインの字面がある');
  assert.ok(!sec.includes('api.groq.com') && !sec.includes('api.openai.com'), '0.8.0 の節に PC が直に送る前の送り先を書いた');
  assert.ok(!/notion/i.test(sec), '0.8.0 の節に「Notion」と書いた');
});

// ---------------------------------------------------------------- 0.9.0 G-2（OF8・D27・D28）
// 計画 docs/plans/2026-10-20-090.md の Task G-2「案内に書くこと」。版は G-3 で上げるので、CHANGELOG の 0.9.0 の節はそれまで計画の
// 「CHANGELOG の 0.9.0 の節（下書き）」に置き、G-3 が版を上げる commit で CHANGELOG.md の頭へ移す（今の版の節が先頭という守りを崩さない）
const secOf = (md, heading) => {
  const i = md.indexOf(`\n${heading}`);
  if (i < 0) return '';
  const rest = md.slice(i + 1);
  const j = rest.indexOf('\n## ', 1);
  return j < 0 ? rest : rest.slice(0, j);
};
// 0.10.0 LS-5（D59）で意図して変えた: 要約の組を外して取り込みが約 0.6GB になり、ボタンの数は今の計算（画面の文は `約 ${fetchGB(need)}`）
const FETCH_BTN = 'ローカル AI を使う（約 0.6GB を取り込む）';
test('0.9.0: README・INSTALL は手順3を任意と書き、ログインを先に書く。［ローカル AI を使う（約 …GB を取り込む）］は画面にある', () => {
  assert.ok(app.includes('ローカル AI を使う（約 ${fetchGB(need)} を取り込む）'), '画面に［ローカル AI を使う（約 …GB を取り込む）］が無い');
  // 0.9.3 M-0（D54）で意図して変えた: 手順3 の見出しと取り込みのボタンは「ローカル AI を使う」、PC の中だけの会議は「オフラインモード」
  const step3 = '## 手順3.（任意）ローカル AI を使う（約 0.6GB を取り込む）';
  assert.ok(install.includes(`\n${step3}\n`), 'INSTALL の手順3 の見出しが任意の形でない');
  const login = install.indexOf('\n## ログインする');
  assert.ok(login > 0 && login < install.indexOf(`\n${step3}`), 'INSTALL のログインの手順が手順3 の前に無い');
  assert.ok(!install.includes('この時点で起動はしますが、文字起こしと要約はまだ動きません。'), 'INSTALL に「まだ動きません」が残っている');
  assert.ok(install.includes('設定の「アカウント」でログインすると、インターネットにつながっているときは会議と音声入力が使えます。'));
  const s3 = secOf(install, step3);
  assert.ok(s3.includes(`［${FETCH_BTN}］`), 'INSTALL の手順3 に初めのボタンの名前が無い');
  for (const w of ['オフラインの会議', '音声を残し', '音声入力はオフラインでは始めません', 'オフラインモード']) assert.ok(s3.includes(w), `INSTALL の手順3 に「${w}」が無い`);
  assert.ok(!/約\s*7\s*GB 必要です/.test(install.split('\n').slice(0, 20).join('\n')) || /ローカル AI を使うときだけ/.test(install.split('\n').slice(0, 20).join('\n')),
    'INSTALL の前提の空きが「ローカル AI を使うときだけ」の書き方でない');
  assert.ok(!install.includes('ふつうは手順3（［PC の中の文字起こしを取り込む］）で足ります。'), 'INSTALL の困ったときに手順3 が要る書き方が残っている');
  assert.ok(readme.includes(`［${FETCH_BTN}］`) && readme.includes('任意'), 'README に任意の取り込みが無い');
  const ps = read('get-installer.ps1');
  assert.ok(ps.includes('インストールしたら NaTsu を起動し、［設定］→［アカウント］でログインしてください。'), 'get-installer.ps1 の終わりの案内がログインを先に言わない');
  assert.ok(ps.includes(`ローカル AI を使うときは、［設定］→［ローカル AI］の［${FETCH_BTN}］を押します（途中で切れても続きから取ります）。要約は、つながっているときに Claude Code で作ります。`));
});

const SECS = (() => {
  const m = app.match(/const SETTINGS_SECS = (\[[^\]]+\]);/);
  return m ? [...m[1].matchAll(/name: '([^']+)'/g)].map((x) => x[1]) : [];
})();
test('0.9.0: README・INSTALL に「設定タブ」「設定のタブ」の言葉が無く、設定の項目の名前は画面の SETTINGS_SECS の名前', () => {
  assert.deepStrictEqual(SECS, ['アカウント', '一般', '録音', '要約', 'ローカル AI', '更新']);   // 0.9.3 M-0（D54）で意図して変えた
  for (const [f, t] of [['README.md', readme], ['INSTALL.md', install], ['get-installer.ps1', read('get-installer.ps1')]]) {
    assert.ok(!t.includes('設定タブ') && !t.includes('設定のタブ'), `${f} に「設定タブ」「設定のタブ」がある`);
    const named = [...t.matchAll(/［設定］→［([^］]+)］/g), ...t.matchAll(/［設定］の「([^」]+)」/g)].map((m) => m[1]);
    for (const n of named) assert.ok(SECS.includes(n), `${f} の［設定］の「${n}」が設定の項目の名前でない`);
  }
  assert.ok(readme.includes('［⚙️ 設定］は、今のページの上に開きます。左の列で項目を選び、上の欄で設定の名前を探せます。Esc か × で閉じます。'), 'README に設定のポップアップの使い方が無い');
});

test('0.9.0: README は録音バーの置き場所（8か所・吸い付く・左右の中央は縦・× で隠す・出し直し）と5つの点・相手の声の印を書き、引いた名前は画面にある', () => {
  for (const w of ['8か所', 'ドラッグ', '縦', '×', '［録音バーを出す］', '［録音バーを表示］', '5つの点', 'スピーカーの印']) assert.ok(readme.includes(w), `README に「${w}」が無い`);
  assert.ok(app.includes('録音バーを出す'), '画面に［録音バーを出す］が無い');
  assert.ok(main.includes("label: '録音バーを表示'"), 'トレイに［録音バーを表示］が無い');
});

test('D28: README の管理者の手順の頭に、会社の回線では Cloudflare の画面の書き込みができず、会社の外の回線で行う1段がある（漏れたときの手順にも）', () => {
  const D28 = '会社の回線からは、Cloudflare の画面での書き込み（Worker の秘密の欄の追加・変更、Access の決まりの変更など）ができません（会社の通信の検査が止めます）。管理の操作は、会社の外の回線（自宅の回線・スマートフォンのテザリングなど）で行ってください。見るだけの操作と、GitHub の［Run workflow］は会社の回線でもできます。';
  const admin = secOf(readme, '## 管理者の手順');
  const head = admin.slice(0, admin.indexOf('\n### '));
  assert.ok(head.includes(D28), 'README の管理者の手順の頭に D28 の1段が無い');
  const leak = admin.slice(admin.indexOf('### 鍵とトークンが漏れたかもしれないとき'));
  assert.ok(leak.slice(0, leak.indexOf('\n### ', 4)).includes('会社の外の回線'), '漏れたときの手順に会社の外の回線の1行が無い');
});

test('D27: README の頭の「このリポジトリについて」に、公開のリポジトリの決まりの1段がある', () => {
  const D27 = 'このリポジトリは作っている間は公開しています。会社の名前・会社のドメイン・人の名前・社内の情報は、コード・文書・テストに書きません（公開前の確認の決まり）。';
  const i = readme.indexOf('\n## このリポジトリについて\n');
  assert.ok(i > 0 && i < readme.indexOf('\n## 機能'), 'README の頭に「このリポジトリについて」が無い');
  assert.ok(secOf(readme, '## このリポジトリについて').includes(D27));
});

// CHANGELOG の 0.9.0 の節（G-3 までは計画の下書き）の［…］は、どれも画面かトレイの名前（src/ にある）。案内の語を画面で探せるように
// 0.9.0 G-3 で意図して変えた: 版を上げたので、節を計画の下書きから CHANGELOG.md の頭（0.8.0 の節の上）へ移した。計画の下書きはもう見ない
// （計画には「移した」の1行だけを残す）
const changelog090 = () => {
  const cl = read('CHANGELOG.md');
  if (!/\n## natsu-v0\.9\.0( （[^）]+）)?\n/.test(cl)) return '';
  return secOf(cl, '## natsu-v0.9.0');
};
test('0.9.0: CHANGELOG の 0.9.0 の節（G-3 で計画の下書きから移した）は 0.8.0 の節の上にあり、任意の取り込み・設定の画面・録音バー・帯の文を書き、引いた［…］はどれも src/ にある', () => {
  const sec = changelog090();
  assert.ok(sec, 'CHANGELOG.md に 0.9.0 の節が無い');
  const cl = read('CHANGELOG.md');
  assert.ok(cl.indexOf('## natsu-v0.9.0') < cl.indexOf('## natsu-v0.8.0'), '0.9.0 の節が 0.8.0 の上に無い');
  const plan = read('docs/plans/2026-10-20-090.md');
  const d = plan.indexOf('\n### CHANGELOG の 0.9.0 の節（下書き）\n');
  assert.ok(d < 0 || !plan.slice(d, plan.indexOf('\n### ', d + 2)).includes('［更新して再起動］'), '計画に下書きの本文が残っている（G-3 で移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', '任意', 'もう取り込んでいる PC は、今までどおりです。', 'この会議は PC の中だけ', 'Esc か × で閉じます',
    '8か所', '縦', '精度が落ちます', 'ネットワークから外れた']) assert.ok(sec.includes(w), `0.9.0 の節に「${w}」が無い`);
  const src = ['src/renderer/app.html', 'src/renderer/overlay.html', 'src/main.js', 'src/mainlib.js'].map(read).join('\n');
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(names.length >= 5, `引いた［…］が少ない: ${names.join('・')}`);
  for (const n of names) assert.ok(src.includes(n), `0.9.0 の節の［${n}］が src/ に無い`);
  assert.ok(!/notion/i.test(sec) && !/(?<![\w-])[a-z0-9-]+\.cloudflareaccess\.com/i.test(sec), '0.9.0 の節に書いてはいけない字面がある');
});

// 0.9.1（計画 docs/plans/2026-10-21-091.md の「CHANGELOG の 0.9.1 の節（下書き）」）: 版を 0.9.1 に上げる commit で、下書きを CHANGELOG.md の頭
// （0.9.0 の節の上）へ移した（0.9.0 G-3 と同じ手順）。計画には「移した」の1行だけを残す。引いた［…］はどれも画面の名前（src/ にある）
test('0.9.1: CHANGELOG の 0.9.1 の節（計画の下書きから移した）は 0.9.0 の節の上にあり、自動で止めること・無音の区間を送らないことを書き、引いた［…］はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  assert.ok(hasSec(cl, '0.9.1'), 'CHANGELOG.md に 0.9.1 の節が無い');
  const sec = secOf(cl, '## natsu-v0.9.1');
  assert.ok(cl.indexOf('## natsu-v0.9.1') < cl.indexOf('## natsu-v0.9.0'), '0.9.1 の節が 0.9.0 の上に無い');
  const plan = read('docs/plans/2026-10-21-091.md');
  const d = plan.indexOf('\n### CHANGELOG の 0.9.1 の節（下書き）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.9.1 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('［更新して再起動］'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', '会議は終わりましたか？', '［続ける］', '［終了して作成］', '一時停止の間は数えません', '話し声が無いときに自動で止める',
    'クラウドにも PC の中の文字起こしにも送らず', '小さな声の短い発言は今までどおり文字にします']) assert.ok(sec.includes(w), `0.9.1 の節に「${w}」が無い`);
  const src = ['src/renderer/app.html', 'src/renderer/overlay.html', 'src/main.js', 'src/mainlib.js'].map(read).join('\n');
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(names.length >= 4, `引いた［…］が少ない: ${names.join('・')}`);
  for (const n of names) assert.ok(src.includes(n), `0.9.1 の節の［${n}］が src/ に無い`);
  assert.ok(!/notion/i.test(sec) && !/(?<![\w-])[a-z0-9-]+\.cloudflareaccess\.com/i.test(sec), '0.9.1 の節に書いてはいけない字面がある');
});

// 0.9.2（計画 docs/plans/2026-10-21-092.md の「CHANGELOG の 0.9.2 の節（下書き）」）: 版を 0.9.2 に上げる commit で、下書きを CHANGELOG.md の頭
// （0.9.1 の節の上）へ移した（0.9.1 と同じ手順）。計画には「移した」の1行だけを残す。引いた［…］はどれも画面の名前（src/ にある）
test('0.9.2: CHANGELOG の 0.9.2 の節（計画の下書きから移した）は 0.9.1 の節の上にあり、説明の1行と ⓘ・注意は見えたまま・［ヘルプ］・検索の直しを書き、引いた［…］と画面の文はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  assert.ok(hasSec(cl, '0.9.2'), 'CHANGELOG.md に 0.9.2 の節が無い');
  const sec = secOf(cl, '## natsu-v0.9.2');
  assert.ok(cl.indexOf('## natsu-v0.9.2') < cl.indexOf('## natsu-v0.9.1'), '0.9.2 の節が 0.9.1 の上に無い');
  const plan = read('docs/plans/2026-10-21-092.md');
  const d = plan.indexOf('\n### CHANGELOG の 0.9.2 の節（下書き）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.9.2 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('［更新して再起動］'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', '見える説明は1行だけ', 'ⓘ を押すと出ます', 'Esc', '大事な注意は、今までどおり見えたまま', 'ⓘ の中の言葉でも探せます',
    '［ヘルプ］', 'ヘルプで詳しく見る ↗', '説明の下に並べました', '名前に当たらない行']) assert.ok(sec.includes(w), `0.9.2 の節に「${w}」が無い`);
  const src = ['src/renderer/app.html', 'src/renderer/overlay.html', 'src/main.js', 'src/mainlib.js'].map(read).join('\n');
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(names.length >= 2, `引いた［…］が少ない: ${names.join('・')}`);
  for (const n of names) assert.ok(src.includes(n), `0.9.2 の節の［${n}］が src/ に無い`);
  // 節が引く画面の文（「…」）も、画面にそのままある
  for (const q of ['※ 録音していることは、会議の参加者に伝えてください。', 'ヘルプで詳しく見る ↗', '録音されるスピーカー']) {
    assert.ok(sec.includes(q), `0.9.2 の節に「${q}」が無い`);
    assert.ok(read('src/renderer/app.html').includes(q), `0.9.2 の節の「${q}」が画面に無い`);
  }
  assert.ok(!/notion/i.test(sec) && !/(?<![\w-])[a-z0-9-]+\.cloudflareaccess\.com/i.test(sec), '0.9.2 の節に書いてはいけない字面がある');
});

// 0.9.3（計画 docs/plans/2026-10-22-093.md の「CHANGELOG の 0.9.3 の節（下書き）」）: 版を 0.9.3 に上げる commit で、下書きを CHANGELOG.md の頭
// （0.9.2 の節の上）へ移した（0.9.2 と同じ手順）。計画には「移した」の1行だけを残す。引いた［…］はどれも画面の名前（src/ にある。パネルの nudge.html も）。
// 前の名前（［この会議は PC の中だけ］）は「名前を変えました」の行で前の名前として引くので、src/ に無くてよい（D54 で画面から消した）
test('0.9.3: CHANGELOG の 0.9.3 の節（計画の下書きから移した）は 0.9.2 の節の上にあり、会議の検出の通知・音の波・名前の付け直し・オフラインモードの札を書き、引いた［…］と画面の文はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  assert.ok(hasSec(cl, '0.9.3'), 'CHANGELOG.md に 0.9.3 の節が無い');
  const sec = secOf(cl, '## natsu-v0.9.3');
  assert.ok(cl.indexOf('## natsu-v0.9.3') < cl.indexOf('## natsu-v0.9.2'), '0.9.3 の節が 0.9.2 の上に無い');
  const plan = read('docs/plans/2026-10-22-093.md');
  const d = plan.indexOf('\n### CHANGELOG の 0.9.3 の節（下書き）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.9.3 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('［更新して再起動］'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', 'AI 議事録を始める', '［文字起こしを始める］', 'オフラインモードで始める', '30 秒で消え', '画面の共有にも写りません',
    '音を聞いて会議を見つけているのではありません', '会議の検出の通知', '音の波', '音が入っていません', '聞き取り中…（約 15 秒ごとに文字になります）',
    '［オフラインモード］', 'ローカル AI', 'オフラインモード中', '議事録を記録中（相手の声も・オフライン）', '戻すボタンは今までどおりありません']) assert.ok(sec.includes(w), `0.9.3 の節に「${w}」が無い`);
  const src = ['src/renderer/app.html', 'src/renderer/overlay.html', 'src/renderer/nudge.html', 'src/main.js', 'src/mainlib.js'].map(read).join('\n');
  const OLD_NAMES = ['この会議は PC の中だけ'];
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))].filter((n) => !OLD_NAMES.includes(n));
  assert.ok(names.length >= 4, `引いた［…］が少ない: ${names.join('・')}`);
  for (const n of names) assert.ok(src.includes(n), `0.9.3 の節の［${n}］が src/ に無い`);
  // 節が引く画面の文（「…」）も、画面にそのままある
  for (const q of ['AI 議事録を始める', 'オフラインモードで始める', '会議の検出の通知', '音が入っていません', 'オフラインモード中']) assert.ok(src.includes(q), `0.9.3 の節の「${q}」が画面に無い`);
  assert.ok(!/notion/i.test(sec) && !/(?<![\w-])[a-z0-9-]+\.cloudflareaccess\.com/i.test(sec), '0.9.3 の節に書いてはいけない字面がある');
});

// 0.9.4（計画 docs/plans/2026-10-22-094.md の「CHANGELOG の 0.9.4 の節（下書き）」）: 版を 0.9.4 に上げる commit で、持ち主の答えに合わせて書き直した下書きを
// CHANGELOG.md の頭（0.9.3 の節の上）へ移した。計画には「移した」の1行だけを残す。外した「速さを測る」・軽いモデルは書かない。
// 前の名前（［文字起こしを打ち切って要約］・ローカル AI の設定）は前の名前として引くので、src/ に無くてよい
test('0.9.4: CHANGELOG の 0.9.4 の節（計画の下書きから移した）は 0.9.3 の節の上にあり、会議の検出の直し・音声を残す・遅い PC・音の波・録音バー・名前を書き、外したものは書かず、引いた［…］と画面の文はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  assert.ok(hasSec(cl, '0.9.4'), 'CHANGELOG.md に 0.9.4 の節が無い');
  const sec = secOf(cl, '## natsu-v0.9.4');
  assert.ok(cl.indexOf('## natsu-v0.9.4') < cl.indexOf('## natsu-v0.9.3'), '0.9.4 の節が 0.9.3 の上に無い');
  const plan = read('docs/plans/2026-10-22-094.md');
  const d = plan.indexOf('\n### CHANGELOG の 0.9.4 の節（下書き）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.9.4 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('［更新して再起動］'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', '参加の前の画面', 'AI 議事録を始める', '文字起こし待ち', '［文字起こしを後回しにして要約］', '会議の後に PC で文字起こし',
    '90 秒', '5つの点', '相手の声を録れません', '保存の音', 'ローカル AI', '15 秒']) assert.ok(sec.includes(w), `0.9.4 の節に「${w}」が無い`);
  for (const w of ['速さを測る', 'medium', '軽いモデル']) assert.ok(!sec.includes(w), `外したもの「${w}」が 0.9.4 の節にある`);
  const src = ['src/renderer/app.html', 'src/renderer/overlay.html', 'src/renderer/nudge.html', 'src/main.js', 'src/mainlib.js'].map(read).join('\n');
  const OLD_NAMES = ['文字起こしを打ち切って要約'];
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))].filter((n) => !OLD_NAMES.includes(n));
  assert.ok(names.length >= 2, `引いた［…］が少ない: ${names.join('・')}`);
  for (const n of names) assert.ok(src.includes(n), `0.9.4 の節の［${n}］が src/ に無い`);
  for (const q of ['AI 議事録を始める', '相手の声を録れません', 'ローカル AI']) assert.ok(src.includes(q), `0.9.4 の節の「${q}」が画面に無い`);
  assert.ok(!/notion/i.test(sec) && !/(?<![\w-])[a-z0-9-]+\.cloudflareaccess\.com/i.test(sec), '0.9.4 の節に書いてはいけない字面がある');
});

// 0.10.0 LN-3（D72・決めたこと 144・設計書 L5）: インストーラーが natsu:// を利用者ごとに登録する（HKCU。管理者の権限は要らない。消すときに外れる）
test('LN-3: build.protocols は natsu の1つ（名前「NaTsu の議事録」）', () => {
  assert.deepStrictEqual(pkg.build.protocols, [{ name: 'NaTsu の議事録', schemes: ['natsu'] }]);
  assert.strictEqual(pkg.build.nsis.perMachine, false, '利用者ごとの入れ方でないと HKCU に書けない');
});

// 0.10.0（計画 docs/plans/2026-10-20-100.md の「CHANGELOG の 0.10.0 の節（下書き）」）: 版を 0.10.0 に上げる commit で、G-1 で画面の言葉に合わせた下書きを
// CHANGELOG.md の頭（0.9.4 の節の上）へ移した。計画には「移した」の1行だけを残す
test('0.10.0: CHANGELOG の 0.10.0 の節（計画の下書きから移した）は 0.9.4 の節の上にあり、Claude から読むこと・Anthropic へ送られること（オフラインモードの会議も）・リンク・ポータブル版をやめること・要約は Claude Code だけ・要約待ちを書き、引いた［…］と画面の文はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  assert.ok(hasSec(cl, '0.10.0'), 'CHANGELOG.md に 0.10.0 の節が無い');
  const sec = secOf(cl, '## natsu-v0.10.0');
  assert.ok(cl.indexOf('## natsu-v0.10.0') < cl.indexOf('## natsu-v0.9.4'), '0.10.0 の節が 0.9.4 の節の上に無い');
  const plan = read('docs/plans/2026-10-20-100.md');
  const d = plan.indexOf('\n### CHANGELOG の 0.10.0 の節（下書き）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.10.0 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('［更新して再起動］'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', 'Claude デスクトップ', 'Claude（Anthropic）へ送られます', '［オフラインモード］', '学習', '読むだけ', '［リンクを写す］', '［選ぶ］',
    'ポータブル版', '0.9.4', '要約待ち（つながったら作ります）', '約 5 GB', '約 0.6 GB', '守秘', 'NaTsu が起動しています']) assert.ok(sec.includes(w), `0.10.0 の節に「${w}」が無い`);
  for (const w of ['llama', 'Gemma', 'D62', 'D63', '外へ送りません']) assert.ok(!sec.includes(w), `0.10.0 の節に「${w}」がある`);
  const src = ['src/renderer/app.html', 'src/renderer/overlay.html', 'src/renderer/nudge.html', 'src/main.js', 'src/mainlib.js'].map(read).join('\n');
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(names.length >= 5, `引いた［…］が少ない: ${names.join('・')}`);
  for (const n of names) assert.ok(src.includes(n), `0.10.0 の節の［${n}］が src/ に無い`);
  for (const q of ['Claude との連携（MCP）', '要約待ち（つながったら作ります）']) assert.ok(src.includes(q), `0.10.0 の節の「${q}」が画面に無い`);
  assert.ok(!/notion/i.test(sec) && !/(?<![\w-])[a-z0-9-]+\.cloudflareaccess\.com/i.test(sec), '0.10.0 の節に書いてはいけない字面がある');
});

// 0.10.1（計画 docs/plans/2026-10-23-101.md の「CHANGELOG の 0.10.1 の節（下書き）」）: 版を 0.10.1 に上げる commit で、下書きを日付つきの見出し
// （## natsu-v0.10.1 （2026-10-24））で CHANGELOG.md の頭（0.10.0 の節の上）へ移した。計画には「移した」の1行だけを残す
test('0.10.1: CHANGELOG の 0.10.1 の節（計画の下書きから移した）は日付つきの見出しで 0.10.0 の節の上にあり、Store 版の新しい場所・0.10.0 で登録した人・動いている間は変えない・ほかの設定を残すを書き、引いた［…］はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  const lines = cl.replace(/\r\n?/g, '\n').split('\n');
  assert.ok(lines.includes('## natsu-v0.10.1 （2026-10-24）'), 'CHANGELOG.md に「## natsu-v0.10.1 （2026-10-24）」の見出しが無い');
  assert.ok(cl.indexOf('## natsu-v0.10.1') < cl.indexOf('## natsu-v0.10.0'), '0.10.1 の節が 0.10.0 の節の上に無い');
  const sec = secOf(cl, '## natsu-v0.10.1');
  const plan = read('docs/plans/2026-10-23-101.md');
  const d = plan.indexOf('\n### CHANGELOG の 0.10.1 の節（下書き）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.10.1 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('［更新して再起動］'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', 'Microsoft Store', 'Claude-Data', '0.10.0 で登録した人へ', '［登録し直す］', '動いている間は', 'もう一度押す', '控え']) assert.ok(sec.includes(w), `0.10.1 の節に「${w}」が無い`);
  assert.ok(!/<[a-z]/i.test(sec), '0.10.1 の節に生の HTML がある');
  const src = ['src/renderer/app.html', 'src/main.js'].map(read).join('\n');
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(names.length >= 4, `引いた［…］が少ない: ${names.join('・')}`);
  for (const n of names) assert.ok(src.includes(n), `0.10.1 の節の［${n}］が src/ に無い`);
  assert.ok(src.includes('Claude との連携の登録を直します。'), '0.10.1 の節の知らせの文が main に無い');
});

// 0.11.0（計画 docs/plans/2026-10-22-110.md の「CHANGELOG の 0.11.0 の節（下書き）」）: 版を 0.11.0 に上げる commit（G）で、下書きを日付つきの見出し
// （## natsu-v0.11.0 （2026-10-24））で CHANGELOG.md の頭（0.10.1 の節の上）へ移した。計画には「移した」の1行だけを残す
test('0.11.0: CHANGELOG の 0.11.0 の節（計画の下書きから移した）は日付つきの見出しで 0.10.1 の節の上にあり、会議の種類とメモの型・未確認・締め・打ち合わせの質を書き、引いた［…］はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  const lines = cl.replace(/\r\n?/g, '\n').split('\n');
  assert.ok(lines.includes('## natsu-v0.11.0 （2026-10-24）'), 'CHANGELOG.md に「## natsu-v0.11.0 （2026-10-24）」の見出しが無い');
  assert.ok(cl.indexOf('## natsu-v0.11.0') < cl.indexOf('## natsu-v0.10.1'), '0.11.0 の節が 0.10.1 の節の上に無い');
  const sec = secOf(cl, '## natsu-v0.11.0');
  const plan = read('docs/plans/2026-10-22-110.md');
  const d = plan.indexOf('\n## CHANGELOG の 0.11.0 の節（下書き）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.11.0 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('打ち合わせの質」（25 点）'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', '会議の種類', '一般・その他', '自動', '未確認', '（メモより）', '持ち越し', '次に気をつけること', '担当: 要確認', '打ち合わせの質', '人の評価ではありません']) assert.ok(sec.includes(w), `0.11.0 の節に「${w}」が無い`);
  assert.ok(!/<[a-z]/i.test(sec), '0.11.0 の節に生の HTML がある');
  const src = ['src/renderer/app.html', 'src/main.js'].map(read).join('\n');
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(names.length >= 2, `引いた［…］が少ない: ${names.join('・')}`);
  for (const n of names) assert.ok(src.includes(n), `0.11.0 の節の［${n}］が src/ に無い`);
});

// 0.11.1（計画 docs/plans/2026-10-24-logo.md の「CHANGELOG の 0.11.1 の節（下書き）」）: 版を 0.11.1 に上げる commit（LG-8）で、下書きを日付つきの見出し
// （## natsu-v0.11.1 （2026-10-25））で CHANGELOG.md の頭（0.11.0 の節の上）へ移した。計画には「移した」の1行だけを残す
test('0.11.1: CHANGELOG の 0.11.1 の節（計画の下書きから移した）は日付つきの見出しで 0.11.0 の節の上にあり、新しいロゴ・暗い画面の白い箱・録音中の赤い線・ピン留めのアイコンは入れ直しで変わることを書き、引いた［…］はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  const lines = cl.replace(/\r\n?/g, '\n').split('\n');
  assert.ok(lines.includes('## natsu-v0.11.1 （2026-10-25）'), 'CHANGELOG.md に「## natsu-v0.11.1 （2026-10-25）」の見出しが無い');
  assert.ok(cl.indexOf('## natsu-v0.11.1') < cl.indexOf('## natsu-v0.11.0'), '0.11.1 の節が 0.11.0 の節の上に無い');
  const sec = secOf(cl, '## natsu-v0.11.1');
  const plan = read('docs/plans/2026-10-24-logo.md');
  const d = plan.indexOf('\n## CHANGELOG の 0.11.1 の節（下書き）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.11.1 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('尻尾の中に音の波'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', 'ロゴを新しくしました', 'リス', '白い箱', '尻尾の線が赤く', 'インストーラーで入れ直したとき']) assert.ok(sec.includes(w), `0.11.1 の節に「${w}」が無い`);
  assert.ok(!/<[a-z]/i.test(sec), '0.11.1 の節に生の HTML がある');
  const src = ['src/renderer/app.html', 'src/main.js'].map(read).join('\n');
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(names.length >= 1, `引いた［…］が無い`);
  for (const n of names) assert.ok(src.includes(n), `0.11.1 の節の［${n}］が src/ に無い`);
});

// 0.12.0（計画 docs/plans/2026-10-22-120.md の「CHANGELOG の 0.12.0 の節（下書き）」）: 版を 0.12.0 に上げる commit（Task G）で、下書きを日付つきの見出し
// （## natsu-v0.12.0 （2026-10-25））で CHANGELOG.md の頭（0.11.1 の節の上）へ移した。計画には「移した」の1行だけを残す
test('0.12.0: CHANGELOG の 0.12.0 の節（計画の下書きから移した）は日付つきの見出しで 0.11.1 の節の上にあり、［更新して再起動］で当てられること・「自分」「相手」・時刻の順・同じ部屋・ヘッドホン・要約と［コピー］と Claude・取り込みが切れた後を書き、引いた［…］はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  const lines = cl.replace(/\r\n?/g, '\n').split('\n');
  assert.ok(lines.includes('## natsu-v0.12.0 （2026-10-25）'), 'CHANGELOG.md に「## natsu-v0.12.0 （2026-10-25）」の見出しが無い');
  assert.ok(cl.indexOf('## natsu-v0.12.0') < cl.indexOf('## natsu-v0.11.1'), '0.12.0 の節が 0.11.1 の節の上に無い');
  const sec = secOf(cl, '## natsu-v0.12.0');
  const plan = read('docs/plans/2026-10-22-120.md');
  const d = plan.indexOf('\n## CHANGELOG の 0.12.0 の節（下書き）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.12.0 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('同時に話した所は両方の行が出ます'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', '「自分」「相手」', '話した時刻の順', '同じ部屋の人', 'ヘッドホン', '要約と文字起こしの［コピー］', 'Claude から読む', '取り込みが途中で切れた']) assert.ok(sec.includes(w), `0.12.0 の節に「${w}」が無い`);
  assert.ok(!/<[a-z]/i.test(sec), '0.12.0 の節に生の HTML がある');
  const src = ['src/renderer/app.html', 'src/main.js'].map(read).join('\n');
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(names.length >= 2, `引いた［…］が少ない`);
  for (const n of names) assert.ok(src.includes(n), `0.12.0 の節の［${n}］が src/ に無い`);
});

// 0.12.1（計画 docs/plans/2026-10-24-121.md の「CHANGELOG の 0.12.1 の節（下書き）」）: 版を 0.12.1 に上げる commit（LV-7）で、下書きを日付つきの見出し
// （## natsu-v0.12.1 （2026-10-25））で CHANGELOG.md の頭（0.12.0 の節の上）へ移した。計画には「移した」の1行だけを残す
test('0.12.1: CHANGELOG の 0.12.1 の節（計画の下書きから移した）は日付つきの見出しで 0.12.0 の節の上にあり、［更新して再起動］で当てられること・会議を出たら止める・6 秒・LN4 の知らせ・ミュート・一時停止・録り直しと［コピー］・設定・経過を書き、引いた［…］はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  const lines = cl.replace(/\r\n?/g, '\n').split('\n');
  assert.ok(lines.includes('## natsu-v0.12.1 （2026-10-25）'), 'CHANGELOG.md に「## natsu-v0.12.1 （2026-10-25）」の見出しが無い');
  assert.ok(cl.indexOf('## natsu-v0.12.1') < cl.indexOf('## natsu-v0.12.0'), '0.12.1 の節が 0.12.0 の節の上に無い');
  const sec = secOf(cl, '## natsu-v0.12.1');
  const plan = read('docs/plans/2026-10-24-121.md');
  const d = plan.indexOf('\n## CHANGELOG の 0.12.1 の節（下書き）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.12.1 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('議事録の経過に「終了（会議を出たので自動）」が残ります'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', 'Teams・Zoom・Chrome・Edge の会議を出ると', '6 秒ほど', '会議を出たので録音を止めました。議事録を作っています。', 'ミュート', '一時停止', '［コピー］', '［メモ］',
    '「会議を出たら自動で止める」', '終了（会議を出たので自動）']) assert.ok(sec.includes(w), `0.12.1 の節に「${w}」が無い`);
  assert.ok(!/<[a-z]/i.test(sec), '0.12.1 の節に生の HTML がある');
  const src = ['src/renderer/app.html', 'src/main.js'].map(read).join('\n');
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(names.length >= 2, '引いた［…］が少ない');
  for (const n of names) assert.ok(src.includes(n), `0.12.1 の節の［${n}］が src/ に無い`);
});

// 0.13.0（計画 docs/plans/2026-10-24-130.md の「CHANGELOG の 0.13.0 の節（下書き）」。Task G・RDY-7）: 版を 0.13.0 に上げる commit で、下書きを日付つきの見出し
// （## natsu-v0.13.0 （2026-10-27））で CHANGELOG.md の頭（0.12.1 の節の上）へ移した。第2部（録音の前のページ）の行を頭に、取り込んだ help-light（ヘルプセンターを
// 明るい版だけに）の1行を最後に。計画には「移した」の1行だけを残す
test('0.13.0: CHANGELOG の 0.13.0 の節（計画の下書きから移した）は日付つきの見出しで 0.12.1 の節の上にあり、［更新して再起動］・録音の前のページと同意の文・/ メニュー・記法・Enter と Backspace・新しい型・⠿ と ＋・近道・［要約を再生成］の確かめ・ヘルプセンターの明るい版を書き、引いた［…］はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  const lines = cl.replace(/\r\n?/g, '\n').split('\n');
  assert.ok(lines.includes('## natsu-v0.13.0 （2026-10-27）'), 'CHANGELOG.md に「## natsu-v0.13.0 （2026-10-27）」の見出しが無い');
  assert.ok(cl.indexOf('## natsu-v0.13.0') < cl.indexOf('## natsu-v0.12.1'), '0.13.0 の節が 0.12.1 の節の上に無い');
  const sec = secOf(cl, '## natsu-v0.13.0');
  const plan = read('docs/plans/2026-10-24-130.md');
  const d = plan.indexOf('\n## CHANGELOG の 0.13.0 の節（下書き）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.13.0 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('録音の前のページが開くので'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', '［＋ 新しい議事録］', '［文字起こしを始める］', '始めると、録音と文字起こしに参加者全員が同意したものとみなされます。', '何も残りません',
    '/ （半角）', '「- 」', 'Enter', 'Backspace', '見出し1〜3', 'コールアウト', '⠿', '＋', 'Ctrl+Shift+0〜6', '［要約を再生成］', 'ヘルプセンター', '明るい']) assert.ok(sec.includes(w), `0.13.0 の節に「${w}」が無い`);
  assert.ok(sec.indexOf('［＋ 新しい議事録］') < sec.indexOf('/ （半角）'), '第2部の行が節の頭に無い');
  assert.ok(!/<[a-z]/i.test(sec), '0.13.0 の節に生の HTML がある');
  const src = ['src/renderer/app.html', 'src/main.js'].map(read).join('\n');
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(names.length >= 5, '引いた［…］が少ない');
  for (const n of names) assert.ok(src.includes(n), `0.13.0 の節の［${n}］が src/ に無い`);
});

// 0.13.1（計画 docs/plans/2026-10-27-131.md の「CHANGELOG の 0.13.1 の節（下書き）」。Task G）: 版を 0.13.1 に上げる commit で、下書きを日付つきの見出し
// （## natsu-v0.13.1 （2026-10-28））で CHANGELOG.md の頭（0.13.0 の節の上）へ移した。持ち主が見る言葉で、字下げ・トグルと ▸・Ctrl+Alt+T・中へのドラッグ・
// 行の頭の Backspace（画面で上に見えている行: TQ1）・ヘルプの節と、点検の直しで利用者に分かるもの（閉じても打った文が消えない: NR39・拡大 200%: NR46・
// ［コピー］の見出し: NR40）を書く。計画には「移した」の1行だけを残す
test('0.13.1: CHANGELOG の 0.13.1 の節（計画の下書きから移した）は日付つきの見出しで 0.13.0 の節の上にあり、［更新して再起動］・Tab と Shift+Tab・トグルと ▸・Ctrl+Alt+T・中へのドラッグ・行の頭の Backspace・ヘルプの節・点検の直し（閉じても文が消えない・拡大 200%・［コピー］の見出し）を書き、引いた［…］はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  const lines = cl.replace(/\r\n?/g, '\n').split('\n');
  assert.ok(lines.includes('## natsu-v0.13.1 （2026-10-28）'), 'CHANGELOG.md に「## natsu-v0.13.1 （2026-10-28）」の見出しが無い');
  assert.ok(cl.indexOf('## natsu-v0.13.1') < cl.indexOf('## natsu-v0.13.0'), '0.13.1 の節が 0.13.0 の節の上に無い');
  // 0.13.2 で意図して変えた: CHANGELOG の頭は 0.13.2 の節になった（0.13.1 の節はそのすぐ下: 下の 0.13.2 のテスト）
  const sec = secOf(cl, '## natsu-v0.13.1');
  const plan = read('docs/plans/2026-10-27-131.md');
  const d = plan.indexOf('\n## CHANGELOG の 0.13.1 の節（下書き）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.13.1 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('Shift+Tab で字下げできるように'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', 'Tab', 'Shift+Tab', 'トグル', 'トグル見出し1〜3', '▸', '「> 」', 'Ctrl+Enter', 'Ctrl+Alt+T', '⠿', '中へ入れられる', 'Backspace',
    '画面ですぐ上に見えている行', '［アクション］', '［コピー］', '見出しのまま', '打った文は消えません', '拡大 200%', '1字ずつに折れない', 'ヘルプセンター', '「要約を書き直す」', '「入れ子とトグル」']) {
    assert.ok(sec.includes(w), `0.13.1 の節に「${w}」が無い`);
  }
  assert.ok(!/<[a-z]/i.test(sec), '0.13.1 の節に生の HTML がある');
  assert.ok(!/`/.test(sec), '0.13.1 の節に Markdown のコードの印がある（持ち主が読む言葉で書く）');
  const src = ['src/renderer/app.html', 'src/main.js'].map(read).join('\n');
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(names.length >= 3, '引いた［…］が少ない');
  for (const n of names) assert.ok(src.includes(n), `0.13.1 の節の［${n}］が src/ に無い`);
  const help = read('help/articles/summary/edit-summary.md');
  assert.ok(help.includes('## 入れ子とトグル {#nest}'), 'ヘルプの記事に「入れ子とトグル」の節が無い（CHANGELOG が引く節）');
});

// 0.13.2（計画 docs/plans/2026-10-28-132.md の「CHANGELOG の 0.13.2 の節（下書き）」。Task G）: 版を 0.13.2 に上げる commit で、下書きを日付つきの見出し
// （## natsu-v0.13.2 （2026-10-29））で CHANGELOG.md の頭（0.13.1 の節の上）へ移した。持ち主が読む言葉で、自動で開くログインの窓・帯・残った区間をログインしていれば
// クラウドで・［もう一度文字起こし］と「残り n 区間」・パネルを下の中央に・会議を出て止めた知らせを書く。計画には「移した」の1行だけを残す
test('0.13.2: CHANGELOG の 0.13.2 の節（計画の下書きから移した）は日付つきの見出しで CHANGELOG の頭（0.13.1 の節の上）にあり、ログインの窓・帯・残った区間をクラウドで・［もう一度文字起こし］と残り n 区間・パネルを下の中央に・会議を出た知らせを書き、引いた［…］はどれも src/ にある', () => {
  const cl = read('CHANGELOG.md');
  const lines = cl.replace(/\r\n?/g, '\n').split('\n');
  assert.ok(lines.includes('## natsu-v0.13.2 （2026-10-29）'), 'CHANGELOG.md に「## natsu-v0.13.2 （2026-10-29）」の見出しが無い');
  assert.ok(cl.indexOf('## natsu-v0.13.2') < cl.indexOf('## natsu-v0.13.1'), '0.13.2 の節が 0.13.1 の節の上に無い');
  assert.ok(cl.indexOf('\n## natsu-v') === cl.indexOf('\n## natsu-v0.13.2'), '0.13.2 の節が CHANGELOG の頭に無い');
  const sec = secOf(cl, '## natsu-v0.13.2');
  const plan = read('docs/plans/2026-10-28-132.md');
  const d = plan.indexOf('\n## CHANGELOG の 0.13.2 の節（下書き。G で日付つきの見出しにして移す）\n');
  assert.ok(d >= 0, '計画に「CHANGELOG の 0.13.2 の節（下書き）」の見出しが無い');
  assert.ok(!plan.slice(d, plan.indexOf('\n## ', d + 2)).includes('ログインしていないことに気づけるようにしました'), '計画に下書きの本文が残っている（移したら「移した」の1行にする）');
  for (const w of ['［更新して再起動］', 'ログインの窓', '自動で開きます', '× で閉じて', 'NaTsu を起動し直すまで', 'オフラインモードの会議', '録音の途中に窓が開くことはありません',
    'ログインしていないため PC で文字起こししています。', '［ログイン］', 'クラウドで文字起こし', 'ログインした直後', '「文字起こし待ち: 残り n 区間」', '［もう一度文字起こし］',
    '1区間ずつ減ります', '画面の下の中央', '⌄ のメニューは上に開きます', '会議を出たので録音を止めました。議事録を作っています。', 'その議事録を開く']) {
    assert.ok(sec.includes(w), `0.13.2 の節に「${w}」が無い`);
  }
  assert.ok(!/<[a-z]/i.test(sec), '0.13.2 の節に生の HTML がある');
  assert.ok(!/`/.test(sec), '0.13.2 の節に Markdown のコードの印がある（持ち主が読む言葉で書く）');
  const src = ['src/renderer/app.html', 'src/main.js'].map(read).join('\n');
  const names = [...new Set([...sec.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(names.length >= 3, '引いた［…］が少ない');
  for (const n of names) assert.ok(src.includes(n), `0.13.2 の節の［${n}］が src/ に無い`);
  assert.ok(src.includes('ログインしていないため PC で文字起こししています。'), '帯の文が src/ に無い');
});

// ---------------------------------------------------------------- help-relnotes RN-1（RN4・Q1・RNF1。計画 docs/plans/2026-10-23-help-relnotes.md）
// 見出しに公開日を足しても、release.yml がリリース本文（アプリの［設定］→［更新］に出る文）を取れて、出した 16 版の本文が1字も変わらない
const RELEASE_AWK = '$0 ~ "^## +" tag "([ \\t]|$)" { found = 1; next }';
/** release.yml の「リリース本文を組み立てる」の awk と sed をそのまま写したもの（タグの直後が空白か行の終わりの見出しから、次の ## の前まで。前後の空行を落とす） */
function releaseBody(cl, tag) {
  const re = new RegExp(`^## +${tag}([ \\t]|$)`);
  const out = [];
  let on = false;
  for (const l of cl.replace(/\r\n?/g, '\n').split('\n')) {
    if (!on) { if (re.test(l)) on = true; continue; }
    if (/^## /.test(l)) break;
    out.push(l);
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
// 出した 16 版: 公開日（GitHub のリリースの published_at を日本の日付に）と、日付を足す前の本文の SHA-256（base64url。16進の 64 字はゲートが止める）
const PUBLISHED = {
  '0.10.0': ['2026-10-23', 'YP-RaMWisi_b7jdV0lzeuxLes1RbnCtlb0S9hEnerOs'],
  '0.9.4': ['2026-10-23', 'JZyXvVcVcXW8VdObjVwjm1LPflz-ptWEVnEgC1YS3BQ'],
  '0.9.3': ['2026-10-22', 'u22AhysDjEoRKSMM9yY9CvBDkOP0f2gt8lYDQVXOuow'],
  '0.9.2': ['2026-10-21', 'eDPFujDszKilGWUjHhmhDroT1U9GJg9FPA8o-crOG6g'],
  '0.9.1': ['2026-10-21', 'zu_iB2Gtslf17meCeEyEQ24fitnvuAiMtt3ynHZyKB4'],
  '0.9.0': ['2026-10-21', 'IBQXkm7nvrp0tB5tJmfTUdH5r_xFTMK1jBfLZHzP9dg'],
  '0.8.0': ['2026-10-20', 'qD67J9Cv_ij28STcGOu8R6NipLP3djo0IOl2VVy8NlE'],
  '0.7.0': ['2026-10-19', 'LTxM1UpR10OHoPI-fo-3KYY8G7bmAAwFIMK96RUbow4'],
  '0.6.0': ['2026-10-19', 'd_5GNhat8rSSYKBn8W-HkWNs1XtS11lym33II-tVRtg'],
  '0.5.0': ['2026-10-18', 've25eZm-jh-Hlj1vFA5kzosGgj6rvQ-RZTqbQVHTeCQ'],
  '0.4.0': ['2026-10-18', '1qpKNtqpjfo4rn5vKxgOXkEb9VF3w6nEDF1svYIMBy4'],
  '0.3.0': ['2026-10-18', '3e2jpm98saDj3ASlI4Ht5UwNZf1iz2tAs9pqhgB-W84'],
  '0.2.0': ['2026-10-18', '3neTjbEU7WfhJ-H1n4AKQJim_qX4Ce1RNTN4KtnsyG8'],
  '0.1.2': ['2026-10-17', 'xL3rjGOyhG4e4Z7K3Nbjtq4lIDx8_XffSPrIqi3Kogo'],
  '0.1.1': ['2026-10-17', 'YrlnPiu6box4xp36pC22cTwdncCh-FGUstUuZZwvsfI'],
  '0.1.0': ['2026-10-17', '4f5W_0P6RvO7odUS3--Dyg-JcdbANjaXFbFBeL6fPXs'],
};
test('RN-1（RN4・RNF1）: 出した 16 版の見出しは「## natsu-v<版> （<公開日>）」（半角の空白の後に全角の括弧）。release.yml の本文の取り方で 16 版とも本文が取れ、日付を足す前の本文と1字も変わらない', () => {
  const crypto = require('node:crypto');
  const cl = read('CHANGELOG.md');
  assert.ok(read('.github/workflows/release.yml').includes(RELEASE_AWK), 'release.yml の本文の取り方が変わった（このテストの写しを直す）');
  const lines = cl.replace(/\r\n?/g, '\n').split('\n');
  for (const [v, [date, hash]] of Object.entries(PUBLISHED)) {
    assert.ok(lines.includes(`## natsu-v${v} （${date}）`), `${v} の見出しが「## natsu-v${v} （${date}）」でない（全角の括弧の前の半角の空白が無いと、release.yml が本文を取れない）`);
    const body = releaseBody(cl, `natsu-v${v}`);
    assert.ok(body.length > 0, `${v}: release.yml の取り方で本文が取れない`);
    assert.strictEqual(crypto.createHash('sha256').update(body).digest('base64url'), hash, `${v}: 出した本文と変わった（アプリに出た文と食い違う）`);
  }
  // 本物の awk があれば、写しと同じ答えか（無い所では写しだけで見る）
  const { spawnSync } = require('node:child_process');
  const awk = spawnSync('awk', ['-v', 'tag=natsu-v0.10.0', `${RELEASE_AWK} found && /^## / { exit } found { print }`, path.join(ROOT, 'CHANGELOG.md')], { encoding: 'utf8' });
  if (awk.status === 0) assert.strictEqual(awk.stdout.replace(/^\n+/, '').replace(/\n+$/, ''), releaseBody(cl, 'natsu-v0.10.0'), '本物の awk と写しの答えが違う');
});

test('RN-1（RN4）: CHANGELOG の版は上から新しい順で重ならない。日付は実在する日で、下の版より古くない。日付の無い節（まだ出していない版）は一番上だけ', () => {
  const heads = read('CHANGELOG.md').split('\n').filter((l) => l.startsWith('## '));
  let prev = null;
  heads.forEach((h, k) => {
    const m = HEAD.exec(h);
    assert.ok(m, `見出しの形: ${h}`);
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (prev) assert.ok(v[0] < prev.v[0] || (v[0] === prev.v[0] && (v[1] < prev.v[1] || (v[1] === prev.v[1] && v[2] < prev.v[2]))), `版の並びが新しい順でない: ${prev.h} の下に ${h}`);
    if (m[4]) {
      const d = new Date(Date.UTC(Number(m[4]), Number(m[5]) - 1, Number(m[6])));
      assert.strictEqual(d.toISOString().slice(0, 10), `${m[4]}-${m[5]}-${m[6]}`, `実在しない日: ${h}`);
      if (prev && prev.date) assert.ok(prev.date >= `${m[4]}-${m[5]}-${m[6]}`, `上の版より新しい日付: ${h}`);
    } else {
      assert.strictEqual(k, 0, `日付の無い節は一番上だけ: ${h}`);
    }
    prev = { h, v, date: m[4] ? `${m[4]}-${m[5]}-${m[6]}` : null };
  });
});
