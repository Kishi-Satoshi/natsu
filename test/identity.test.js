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
test('識別子: name は natsu・版は 0.7.0・productName は build の中だけ（userData は %APPDATA%\\natsu）', () => {
  assert.strictEqual(pkg.name, 'natsu');
  assert.strictEqual(pkg.version, '0.7.0');
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
// 第1d回 G-2 で意図して変えた: 0.8.0 からは、音声は PC → 文字起こしの中継（Cloudflare の workers.dev）→ OpenAI。PC は OpenAI・Groq へ直に送らない
// （src/ に api.openai.com・api.groq.com を書けない: ゲート）。前の版の送り先の表（api.groq.com）と、PC が直に送る先としての api.openai.com は書かない。
// 0.7.0 の D5 で消した「使う／使わない」の同意の選択は、もう求めない
// 第1d回 G-3 で意図して変えた（作り替え。D18）: ログインは Cloudflare Access の One-time PIN（英語の Cloudflare の画面と、Cloudflare が送るコードの
// メール）。NaTsu の自前の確認コードのメール（Resend）・MAIL_DAILY_MAX の話は書かない。中継の住所は src/relay.js の RELAY_BASE（本物の住所。
// 第1d回 A-10）と同じ。INSTALL の接続先に Access のログインの画面（<チームの名前>.cloudflareaccess.com）を足す（チームの名前は書かない）
const RELAY_HOST = new URL(require('../src/relay').RELAY_BASE).host;
test('OL9・RL9・D18: README と INSTALL は、中継の住所・中継の先の OpenAI・Cloudflare Access のログイン（One-time PIN）・［この会議は PC の中だけ］・Claude Code の入れ方・上限を書き、Groq の送り先・「完全オフライン」・Resend・確認コードを書かない', () => {
  assert.match(RELAY_HOST, /^natsu-relay\.[a-z0-9-]+\.workers\.dev$/);
  for (const w of ['音声', '送り先', RELAY_HOST, 'Cloudflare Access', 'One-time PIN', 'OpenAI', 'ログイン', '［ログイン］', '［Send login code］', '［Sign in］', '英語',
    'PC の中だけ', 'オフライン', 'irm https://claude.ai/install.ps1 | iex', '上限', 'claude auth status', '"authMethod": "claude.ai"', 'claude.ai', 'api.anthropic.com',
    'Zscaler', '情報システム', 'noreply＠notify.cloudflare.com']) {
    assert.ok(readme.includes(w), `README に「${w}」が無い`);
  }
  for (const w of [RELAY_HOST, 'Cloudflare', 'One-time PIN', 'OpenAI', 'ログイン', '［ログイン］', '［Send login code］', '［Sign in］', '英語', 'PC の中だけ']) {
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

test('0.7.0: 版と、README の保存の説明（natsu.db・backup・元の JSON を残す・古い版に戻したとき・控えに残る期間）', () => {
  assert.strictEqual(require('../package.json').version, '0.7.0');
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
