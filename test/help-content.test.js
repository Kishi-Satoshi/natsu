/* help-content.test.js — ヘルプセンター H-5（HF2・RF51・RF28）: 記事の照らし
 *
 * 本物の help/ を読む。記事が 0 件の間も通る形にし、記事を足すたびに効く（C のタスク H-6〜H-8）。
 * 記事の ［…］ は NaTsu の画面の言葉だけ（R9）で、どれも src/ の .html か .js にちょうどその文字である。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { build, loadSite } = require('../tools/help-build');
const { parseFrontMatter } = require('../tools/lib/help-md');
const L = require('../tools/lib/help-labels');
const { tmpDir } = require('./helpers/help-tmp');

const { site, refs } = loadSite(ROOT);
const fileOf = (ref) => `help/articles/${ref}.md`;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const articles = refs.map((ref) => ({ ref, file: fileOf(ref), text: read(fileOf(ref)) }));
const metaOf = (a) => parseFrontMatter(a.text, { file: a.file }).meta;

test('HF2: どの記事も前置きの形が正しく、site.json の分類の articles にちょうど1回ある。site.json の記事は全部ファイルがある', { timeout: 5000 }, () => {
  const onDisk = [];
  const dir = path.join(ROOT, 'help', 'articles');
  if (fs.existsSync(dir)) {
    for (const c of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, c))) onDisk.push(`${c}/${f.replace(/\.md$/, '')}`);
  }
  assert.deepStrictEqual([...onDisk].sort(), [...refs].sort(), 'help/articles の記事と site.json の記事が合わない');
  assert.strictEqual(new Set(refs).size, refs.length, 'site.json に同じ記事が2回ある');
  for (const a of articles) assert.doesNotThrow(() => metaOf(a), a.file);
});

test('HF2: 記事の ［…］ の言葉は、どれも src/ の下の .html か .js にちょうどその文字である（無ければ、ファイル・行・言葉と「NaTsu の画面の言葉でなければ太字に（R9）」を出す）', { timeout: 5000 }, () => {
  const app = L.appLabelText(ROOT);
  assert.ok(app.length > 100000 && app.includes('終了して作成'), 'アプリの文字を読めていない');
  const missing = [];
  for (const a of articles) {
    for (const m of L.missingLabels(a.text, app)) missing.push(`${a.file}:${m.line} ［${m.label}］`);
  }
  assert.deepStrictEqual(missing, [], `アプリのコードに無い画面の言葉:\n${missing.join('\n')}\nNaTsu の画面の言葉でなければ太字に（R9）`);
});

test('HF2: labelsIn は ［…］ と行を返す（コードの塊の中は数えない）。missingLabels はアプリの文字に無い言葉だけ', { timeout: 5000 }, () => {
  const md = '---\ntitle: x\n---\n［設定］ を開き ［ログイン］ を押す\n\n```\n［コードの中］\n```\n`［文中のコード］` と ［⏸ 一時停止］\n';
  assert.deepStrictEqual(L.labelsIn(md), [{ label: '設定', line: 4 }, { label: 'ログイン', line: 4 }, { label: '⏸ 一時停止', line: 9 }]);
  assert.deepStrictEqual(L.missingLabels(md, '<button>設定</button> <span>ログイン</span>'), [{ label: '⏸ 一時停止', line: 9 }]);
  // 一部としてあれば通る（［終了して作成］ は「■ 終了して作成」の一部）
  assert.deepStrictEqual(L.missingLabels('［終了して作成］', '<button>■ 終了して作成</button>'), []);
});

test('HF2: sources のファイルは全部リポジトリにある（help/ の中は数えない）', { timeout: 5000 }, () => {
  for (const a of articles) {
    for (const s of metaOf(a).sources) {
      assert.ok(!s.startsWith('help/'), `${a.file}: sources に help/ の中を書いた ${s}`);
      assert.ok(fs.existsSync(path.join(ROOT, s)) && fs.statSync(path.join(ROOT, s)).isFile(), `${a.file}: sources の ${s} が無い`);
    }
  }
});

test('日付: updated は 2026-10-20 から今日（日本の日付）まで。未来の日付は赤', { timeout: 5000 }, () => {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  for (const a of articles) {
    const u = metaOf(a).updated;
    assert.ok(u >= '2026-10-20' && u <= today, `${a.file}: updated ${u} が 2026-10-20 から ${today} の外`);
  }
});

// 0.9.3 M-0（D54）で意図して変えた: ボタンの名前は［オフラインモード］
test('RF28: record/pc-only の記事に「1on1」「面談」「OpenAI」「［オフラインモード］」「音声入力」がある。start/what-natsu-does から record/pc-only へのリンクがあり、featured に record/pc-only がある', { timeout: 5000 }, () => {
  if (refs.length === 0) {
    // 記事がまだ無い間だけ通る。1件でもあれば下の照らしが効く（後で pc-only を消しても黙って通らない）
    assert.deepStrictEqual(site.featured, []);
    return;
  }
  assert.ok(refs.includes('record/pc-only'), 'record/pc-only の記事が無い（1on1・面談の注意）');
  const pc = read(fileOf('record/pc-only'));
  // 0.15.1 ND-4（計画 docs/plans/2026-11-04-151.md の「意図して変えるテスト」・D114）で意図して変えた: NaTsu の音声入力がなくなったので、「効かないもの」の音声入力の行を消した（「音声入力」の字は見ない）
  for (const w of ['1on1', '面談', 'OpenAI', '［オフラインモード］']) assert.ok(pc.includes(w), `record/pc-only に「${w}」が無い`);
  assert.ok(refs.includes('start/what-natsu-does'), 'start/what-natsu-does の記事が無い');
  assert.ok(read(fileOf('start/what-natsu-does')).includes('](record/pc-only.md'), 'start/what-natsu-does から record/pc-only へのリンクが無い');
  assert.ok(site.featured.includes('record/pc-only'), 'featured に record/pc-only が無い');
});

test('HF2: 照らしの元（appLabelText）は src/ の .html と .js だけを読み、help/ を読まない', { timeout: 5000 }, (t) => {
  const root = tmpDir(t, 'natsu-help-labels-');
  const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
  put('src/renderer/app.html', '<button>開始する</button>');
  put('src/main.js', "const t = '止める';");
  put('src/renderer/x.css', '/* CSSだけの言葉 */');
  put('src/notes.md', 'MDだけの言葉');
  put('help/articles/start/a.md', '［ヘルプにしか無い言葉］ と ［開始する］ と ［止める］');
  put('help/assets/site.js', "const t = 'ヘルプのJSの言葉';");
  put('README.md', 'READMEの言葉');
  const app = L.appLabelText(root);
  for (const w of ['開始する', '止める']) assert.ok(app.includes(w), w);
  for (const w of ['ヘルプにしか無い言葉', 'ヘルプのJSの言葉', 'CSSだけの言葉', 'MDだけの言葉', 'READMEの言葉']) assert.ok(!app.includes(w), `${w} を照らしの元に混ぜた`);
  assert.deepStrictEqual(L.missingLabels(fs.readFileSync(path.join(root, 'help/articles/start/a.md'), 'utf8'), app), [{ label: 'ヘルプにしか無い言葉', line: 1 }]);
});

test('公開前の確認: 記事と site.json に、チームのドメインの字面（<名前>.cloudflareaccess.com）・64 字の16進（AUD の見かけ）・C:\\Users\\・半角の @ のメールが無い', { timeout: 5000 }, () => {
  // help-relnotes 審査 A-3（R-RN4）: 形はリリースノートの元（CHANGELOG.md）に当てるものと同じ1か所
  const bad = require('../tools/lib/help-public').PUBLIC;
  const files = ['help/site.json', ...articles.map((a) => a.file)];
  const hits = [];
  for (const f of files) {
    read(f).split('\n').forEach((line, i) => { for (const [re, what] of bad) if (re.test(line)) hits.push(`${f}:${i + 1} ${what}`); });
  }
  assert.deepStrictEqual(hits, []);
  // 照らしの形そのものが当たること（空振りしない）
  const team = ['natsu', 'test.cloudflareaccess.com'].join('-');
  assert.ok(bad[0][0].test(`https://${team}/`) && !bad[0][0].test('https://<チームの名前>.cloudflareaccess.com'));
  assert.ok(bad[1][0].test('ab'.repeat(32)) && !bad[1][0].test('ab'.repeat(31)));
  assert.ok(bad[2][0].test(['C:', 'Users', 'x'].join('\\')));
});

test('HF2: 作るのが通る（build() が help/ の全部の記事で HelpBuildError を投げない）', { timeout: 5000 }, (t) => {
  const out = path.join(tmpDir(t, 'natsu-help-real-'), 'out');
  const r = build({ root: ROOT, out });
  assert.strictEqual(r.articles.length, refs.length);
  assert.ok(fs.existsSync(path.join(out, 'index.html')) && fs.existsSync(path.join(out, 'search-index.json')));
});

test('help-relnotes RN-5（RF51）: リリースノートの元（CHANGELOG.md）は照らしの元に入らない（古い版の文の［…］で記事の言葉が通ってしまわない）。リリースノートのページ自体も RF51 の照らしに掛けない（古い版の画面の言葉が残るため）', { timeout: 5000 }, (t) => {
  const root = tmpDir(t, 'natsu-help-labels-rn-');
  const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
  put('src/main.js', "const t = '止める';");
  put('CHANGELOG.md', '# 変更履歴\n\n## natsu-v0.1.0 （2026-10-17）\n\n- ［変更履歴だけの言葉］を足しました。\n');
  const app = L.appLabelText(root);
  assert.ok(app.includes('止める'));
  assert.ok(!app.includes('変更履歴だけの言葉'), 'CHANGELOG.md を照らしの元に混ぜた');
  assert.deepStrictEqual(L.missingLabels('［変更履歴だけの言葉］', app), [{ label: '変更履歴だけの言葉', line: 1 }]);
  // 本物: CHANGELOG.md にしか無い古い画面の言葉（ポータブル版など）がアプリの文字に無くても、作るのは止まらない（RF51 は記事だけ）
  const cl = read('CHANGELOG.md');
  const real = L.appLabelText(ROOT);
  const old = L.labelsIn(cl).filter((l) => !real.includes(l.label));
  assert.ok(old.length > 0, '本物の CHANGELOG.md に、今のアプリに無い［…］が無い（このテストの前提が崩れた）');
});

// H-11: README の「ヘルプセンター」の節（置き場所・作り方・出し方・利用者の用意の Access の手順）。計画の「利用者の用意」と同じ中身
test('H-11: README の「ヘルプセンター」の節に、住所・作り方（npm run help:build）・出し方（help-deploy）・利用者の用意の Access の手順がある', { timeout: 5000 }, () => {
  const readme = read('README.md');
  const at = readme.indexOf('\n## ヘルプセンター\n');
  assert.ok(at >= 0, 'README に「## ヘルプセンター」の節が無い');
  const next = readme.indexOf('\n## ', at + 5);
  const sec = readme.slice(at, next < 0 ? undefined : next);
  for (const w of [
    'https://natsu-help.natsu-code.workers.dev/',   // 住所
    'help/articles/', 'help/site.json',            // 置き場所
    'npm run help:build', 'help/dist',             // 作り方
    'help-deploy', 'Run workflow',                 // 出し方（GitHub の Actions の手で押す）
    'Protect this Worker behind Access', 'One-time PIN', '1 week',   // 利用者の用意の 1〜3（Access・7 日）
    'TEAM_DOMAIN', 'POLICY_AUD', 'ALLOWED_EMAIL_DOMAINS', 'Secret', // 利用者の用意の 5（秘密の欄。種類は Secret）
    'Access に守られています', 'Exclude',          // 2回目の確かめ・人を止めるときは両方の app に
    'node tools/help-shots.js',                    // 見た目を変えたら撮り直す（R7）
  ]) assert.ok(sec.includes(w), `README の「ヘルプセンター」の節に「${w}」が無い`);
  // 会社の固有の情報は書かない（チームの名前・会社のドメインは <…> の形だけ）
  assert.doesNotMatch(sec, /(?<![<\w-])[a-z0-9-]+\.cloudflareaccess\.com/i);
});

// 0.9.2 I-5（計画 docs/plans/2026-10-21-092.md の C）: 一時停止のスリープの節で、引いた知らせの文がもう「続けるときは、…［再開］を押してください」と
// 言うので、次の行で同じことを繰り返さない。設定の画面の使い方は、0.9.2 の ⓘ の説明と［ヘルプ］に合わせる
const sectionOf = (ref, id) => { const t = read(fileOf(ref)); const at = t.indexOf(`{#${id}}`); assert.ok(at > 0, `${ref} に #${id} が無い`); const end = t.indexOf('\n## ', at); return t.slice(at, end < 0 ? t.length : end); };
test('0.9.2 C: record/pause の「PC がスリープしたとき」は、続け方（［再開］を押す）を1回だけ言い、自動では再開しないことは残す', { timeout: 5000 }, () => {
  const s = sectionOf('record/pause', 'sleep');
  assert.strictEqual(s.split('続けるときは').length - 1, 1, `続け方を2回言っている:\n${s}`);
  assert.ok(s.includes('自動では再開しません'), '自動では再開しないことが無い');
  assert.ok(s.includes('スリープから戻りました。会議の録音は一時停止しています。続けるときは、録音中のページの［再開］を押してください。'), '引いた知らせの文が無い');
});
test('0.9.2 C: settings/appearance の「設定の画面の使い方」に、1行の説明と ⓘ（Esc はまず説明を閉じる）・「ヘルプで詳しく見る ↗」・ⓘ の中の言葉でも当たる検索・左の列の下の［ヘルプ］がある', { timeout: 5000 }, () => {
  const s = sectionOf('settings/appearance', 'settings-screen');
  for (const w of ['ⓘ', '1行', 'ヘルプで詳しく見る ↗', '［ヘルプ］', 'ⓘ の中の言葉', '[[Esc]]']) assert.ok(s.includes(w), `「${w}」が無い`);
  assert.ok(!s.includes('NaTsu 0.9.0'), '版の例が古い');
});
// 0.9.3 M-7（計画 docs/plans/2026-10-22-093.md）: 会議の検出の通知の記事と、状態の行の音の波・「聞き取り中」
test('0.9.3 M-7: record/meeting-detect に「音を聞きません」「窓の題名」「Windows でだけ」、Notion と NaTsu では出ないこと・切り方がある', { timeout: 5000 }, () => {
  const t = read(fileOf('record/meeting-detect'));
  for (const w of ['音を聞きません', '窓の題名', 'Windows でだけ', '30 秒', '会議の検出の通知', 'オフラインモードで始める', '画面を共有していても']) assert.ok(t.includes(w), `「${w}」が無い`);
  assert.ok(/Notion/.test(t) && /NaTsu 自身/.test(t), 'Notion と NaTsu では出ないことが無い');
  assert.ok(JSON.stringify(site.categories).includes('"meeting-detect"'), 'site.json に記事が無い');
});
test('0.9.3 M-7: record/status-line の「音の波と聞き取り中」に、点の動き・「音が入っていません」・「一時停止中」・「聞き取り中…」・話している途中の文字は出ないことがある', { timeout: 5000 }, () => {
  const s = sectionOf('record/status-line', 'wave');
  for (const w of ['「文字起こし」の右', '音が入っていません', '一時停止中', '聞き取り中…（約 15 秒ごとに文字になります）', '話している途中の文字は出ません', '録音バーを隠しても']) assert.ok(s.includes(w), `「${w}」が無い`);
});
// 0.9.3 持ち主の答え D55: オフラインモードの札「オフラインモード中」と、記録の行の括弧の中の「オフライン」
test('0.9.3 D55: record/pc-only の「押し方」に札「オフラインモード中」と「議事録を記録中（…・オフライン）」、パネルで始めた会議も同じこと。record/status-line に記録の行の文の並び', { timeout: 5000 }, () => {
  const how = sectionOf('record/pc-only', 'how');
  for (const w of ['「オフラインモード中」', '押せません', '「議事録を記録中（相手の声も・オフライン）」', '「議事録を記録中（オフライン）」', 'オフラインモードで始める']) assert.ok(how.includes(w), `record/pc-only の押し方に「${w}」が無い`);
  const rec = sectionOf('record/status-line', 'title');
  for (const w of ['「議事録を記録中」', '「議事録を記録中（相手の声も）」', '「議事録を記録中（相手の声も・オフライン）」', '「一時停止中（録音していません・オフライン）」',
    '「議事録を作成しています…（オフライン）」', '区間を文字起こし中', '「オフラインモード中」']) assert.ok(rec.includes(w), `record/status-line の記録の行に「${w}」が無い`);
  assert.ok(rec.includes('](record/pc-only.md'), 'record/status-line の記録の行から record/pc-only へのリンクが無い');
});
// 0.9.4 S-8（計画 docs/plans/2026-10-22-094.md の「Task S-8（作り直し）」）: 遅い PC の記事（新）・遅い会議の帯と区間・Workers Paid の見直しの目安（D55）・
// 会議の検出（参加の前の画面・診断の記録）。帯と区間の文は main の文をそのまま引く
test('0.9.4 S-8: trouble/slow-pc に「音声を残しています」「会議の後」・帯 kept-late の文（ふだん・オフラインモード）・区間の文・後回し・PC で文字起こし。site.json の「困ったとき」と HELP_ARTICLES にある', { timeout: 5000 }, () => {
  const t = read(fileOf('trouble/slow-pc'));
  const main = read('src/main.js');
  const LATE = 'この PC の文字起こしが録音に追いつかないため、音声を残しています。会議が終わったら文字起こしします。録音はそのまま続けてください。';
  const OFF = 'オフラインモードです。この PC の文字起こしが録音に追いつかないため、音声を残しています。会議が終わったら PC の中で文字起こしします。';
  const SLOW = '（文字起こし待ち: 会議の後で文字起こしします）';
  assert.ok(main.includes(LATE) && main.includes(OFF) && main.includes(`const SLOW_SEG_TEXT = '${SLOW}';`), 'main の文が変わった');
  for (const w of ['音声を残しています', '会議の後', LATE, OFF, SLOW, '音声を残しています（会議の後で文字起こしします）', '［文字起こしを後回しにして要約］', 'PC で文字起こし', '［要約を生成］']) {
    assert.ok(t.includes(w), `「${w}」が無い`);
  }
  assert.ok(!/速さを測る|軽いモデル/.test(t), '外した機能の話がある');
  assert.ok(site.categories.find((c) => c.id === 'trouble').articles.includes('slow-pc'), 'site.json の「困ったとき」に無い');
  assert.ok(require('../src/mainlib').HELP_ARTICLES.includes('trouble/slow-pc'), 'HELP_ARTICLES に無い');
});
test('0.9.4 S-8: record/status-line・trouble/banners に遅い PC の帯（kept-late）の文と区間の文と slow-pc へのリンク、admin/relay-limits に Workers Paid の見直しの目安（D55）がある', { timeout: 5000 }, () => {
  const LATE = 'この PC の文字起こしが録音に追いつかないため、音声を残しています。';
  for (const ref of ['record/status-line', 'trouble/banners']) {
    const t = read(fileOf(ref));
    for (const w of [LATE, '（文字起こし待ち: 会議の後で文字起こしします）', 'trouble/slow-pc.md']) assert.ok(t.includes(w), `${ref} に「${w}」が無い`);
  }
  assert.ok(read(fileOf('trouble/banners')).includes('オフラインモードです。この PC の文字起こしが録音に追いつかないため、音声を残しています。'), 'banners にオフラインモードの kept-late の文が無い');
  assert.ok(sectionOf('record/status-line', 'line').includes('音声を残しています（会議の後で文字起こしします）'), 'status-line に遅い会議の一番下の行が無い');
  const r = sectionOf('admin/relay-limits', 'workers-paid');
  for (const w of ['Workers Paid', 'Free', '10 ms', 'Exceeded CPU Time Limits', '8 ms', '3 日', '10 人', 'Observability']) assert.ok(r.includes(w), `relay-limits に「${w}」が無い`);
});
test('0.9.4 S-8: record/meeting-detect に参加の前の画面・マイクを使い始めた時点・記録に残す符号（名前は残さない）がある', { timeout: 5000 }, () => {
  const t = read(fileOf('record/meeting-detect'));
  for (const w of ['参加の前の画面', 'マイクを使い始めた時点', 'どのアプリを使ったかは', '始めたか']) assert.ok(t.includes(w), `「${w}」が無い`);
});

// help-dads HD-8（持ち主の答え Q8「最初に出た所に一言足す」。計画 docs/plans/2026-10-23-help-dads.md の決めたこと I-34）:
// 「区間」「中継」が出る記事では、その記事の本文で最初に出た所（コード・「…」の画面の文・リンクの住所の外）の直後に決まった一言がある
const TERM_NOTES = {
  区間: '（文字起こしのために録音を区切ったひとまとまりの音声）',
  中継: '（音声を OpenAI へ取り次ぐ NaTsu のサーバー）',   // 再審査の指摘 7・持ち主の答え「NaTsu のサーバー」
};
/** 本文（前置きの後ろ）の、コードの塊・`…`・「…」・リンクの住所・表の左の列（帯の文などの画面の文）を同じ長さの空白で隠したもの（位置は元と同じ） */
function plainBody(text) {
  const end = text.indexOf('\n---', 4);
  const head = text.slice(0, end + 4).replace(/[^\n]/g, ' ');
  const body = text.slice(end + 4)
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
    .replace(/「[^「」]*」/g, (m) => ' '.repeat(m.length))
    .replace(/\]\([^)\s]*\)/g, (m) => ' '.repeat(m.length))
    .replace(/^\|[^|\n]*\|/gm, (m) => `|${' '.repeat(m.length - 2)}|`);
  return head + body;
}
test('HD-8（Q8）: 「区間」「中継」が出る記事は、本文で最初に出た所（コード・「…」の画面の文・リンクの住所・表の左の列の外）の直後に決まった一言の括弧があり、見出しの中ではない。直した記事の updated は 2026-10-23 以降', { timeout: 5000 }, () => {
  let n = 0;
  for (const a of articles) {
    const text = a.text.replace(/\r\n?/g, '\n');
    const plain = plainBody(text);
    for (const [w, note] of Object.entries(TERM_NOTES)) {
      const i = plain.indexOf(w);
      if (i < 0) continue;
      n++;
      assert.ok(text.startsWith(w + note, i), `${a.ref}: 最初の「${w}」（${JSON.stringify(text.slice(Math.max(0, i - 20), i + 30))}）の後に ${note} が無い`);
      const line = text.slice(text.lastIndexOf('\n', i) + 1, i);
      assert.ok(!/^#{1,6} /.test(line), `${a.ref}: 最初の「${w}」が見出しの中`);
      assert.ok(metaOf(a).updated >= '2026-10-23', `${a.ref}: updated を直した日にしていない`);
      // 一言は最初の1回だけ（2回目からは書かない）
      assert.strictEqual(text.split(w + note).length - 1, 1, `${a.ref}: 「${w}」の一言が2回以上`);
    }
  }
  assert.ok(n >= 20, `「区間」「中継」の出る所が少ない（${n}）`);
});

// 再審査の指摘 7（持ち主の答え 2026-10-23）: 中継の説明と食い違う・重なる書き方をしない
test('再審査の指摘 7: 「中継（OpenAI）」と書かない（中継＝OpenAI と読める）。説明の一言が2つ入った1文が無い。「会社の」が説明の一言の前後で重ならない', { timeout: 5000 }, () => {
  const notes = Object.values(TERM_NOTES);
  for (const a of articles) {
    const text = a.text.replace(/\r\n?/g, '\n');
    assert.ok(!text.includes('中継（OpenAI）'), `${a.ref}: 「中継（OpenAI）」`);
    for (const sentence of text.split(/[。\n]/)) {
      assert.ok(notes.filter((n) => sentence.includes(n)).length <= 1, `${a.ref}: 1文に説明の一言が2つ: ${sentence}`);
      if (notes.some((n) => sentence.includes(n))) assert.ok((sentence.match(/会社の/g) || []).length <= 1, `${a.ref}: 「会社の」が重なる: ${sentence}`);
    }
  }
  for (const n of notes) assert.ok(!n.includes('会社'), `説明の一言に「会社」: ${n}`);
});

// 0.12.0 SP-4（計画 docs/plans/2026-10-22-120.md の「記事 record/start-stop の節」。D53・D66）。admin/relay-limits は変えない（S14 (b)）
test('0.12.0 SP-4: record/start-stop の節「文字起こしの「自分」「相手」」に、ヘッドホン・同じ部屋・取り込みが途中で切れた・直せない・ToDo の担当・Claude。start/claude-mcp に札の1行と節へのリンク', { timeout: 5000 }, () => {
  const t = read(fileOf('record/start-stop'));
  const sec = t.slice(t.indexOf('## 文字起こしの「自分」「相手」 {#speakers}'), t.indexOf('## 録音バー {#bar}'));
  assert.ok(sec.length > 100, '節が無い');
  for (const w of ['「自分」', '「相手」', 'ヘッドホン', '同じ部屋', '取り込みが途中で切れた', '経過', '直せません', '［コピー］', 'ToDo の担当', 'Claude', '話した時刻の順', '両方の行', '議事録で相手の声も録る']) {
    assert.ok(sec.includes(w), `「${w}」が無い`);
  }
  const mcp = read(fileOf('start/claude-mcp'));
  assert.ok(mcp.includes('「自分」（マイク）か「相手」（PC から流れた声）') && mcp.includes('(record/start-stop.md#speakers)'));
});

// 0.12.1 LV-5（計画 docs/plans/2026-10-24-121.md の「画面と知らせの文」の下の案。LN4・LN6・決めたこと L22）: 会議を出たら止めることと、誤って止まったときの手順
test('0.12.1 LV-5: record/meeting-detect に「会議を出たとき」（6 秒・聞かずに・Chrome・Edge・一時停止・ミュート・LN4・両方を切っている間）と「誤って止まったとき」の手順（新しい議事録 → ［文字起こし］ → ··· → ［コピー］ → ［メモ］ → ［要約を再生成］の順）がある。前の版の案の字は無い', { timeout: 5000 }, () => {
  const t = read(fileOf('record/meeting-detect'));
  const leave = sectionOf('record/meeting-detect', 'leave');
  for (const w of ['6 秒', '聞かずに', 'Chrome', 'Edge', '一時停止', 'ミュート', '会議を出たので録音を止めました。議事録を作っています。', '通知を出さないアプリ', '所要時間']) assert.ok(leave.includes(w), `「会議を出たとき」に「${w}」が無い`);
  assert.ok(t.includes('「会議の検出の通知」と「会議を出たら自動で止める」の両方を切っている間は、Windows の記録を読みません。「会議を出たら自動で止める」だけがオンなら、録音している間だけ読みます。'), '切っている間の文が新しくない');
  assert.ok(!t.includes('切っている間は、Windows の記録も読みません。'), '前の「切っている間は」の文が残っている');
  const at = t.indexOf('{#leave-split}');
  assert.ok(at > t.indexOf('{#leave}'), '「誤って止まったとき」の小見出しが無い（「会議を出たとき」の中に）');
  const split = t.slice(at, t.indexOf('\n## ', at) < 0 ? t.length : t.indexOf('\n## ', at));
  let pos = 0;
  for (const w of ['新しい議事録', '［文字起こし］', '···', '［コピー］', '［メモ］', '［要約を再生成］']) {
    const i = split.indexOf(w, pos);
    assert.ok(i >= 0, `「誤って止まったとき」に「${w}」が無いか、順が違う`);
    pos = i + w.length;
  }
  // 記事の頭の「2〜4 秒で画面の右上に」（パネルの話）は前からある字なので、前の版の案の字は「会議を出たとき」の節（小見出しを含む）だけで見る（R7）
  for (const w of ['会議を出ましたか？', '60 秒', '相手の声が 30 秒', '4 秒']) assert.ok(!leave.includes(w), `前の版の案の「${w}」が残っている`);
  // 0.15.1 ND-4（計画 docs/plans/2026-11-04-151.md の「意図して変えるテスト」・D114）で意図して変えた: 「録音しているとき（議事録・音声入力）」の音声入力を外したので updated は後の日（2026-10-25 から）
  assert.ok((t.match(/^updated: (\S+)$/m) || [])[1] >= '2026-10-25', 'updated を直していない');
  for (const s of ['src/meetleave.js', 'docs/plans/2026-10-24-121.md']) assert.ok(t.includes(s), `sources に ${s} が無い`);
});
test('0.12.1 LV-5: record/start-stop の自動で止める節から record/meeting-detect.md#leave への道、README に「会議を出たとき（0.12.1 から）」', { timeout: 5000 }, () => {
  const s = sectionOf('record/start-stop', 'auto-stop');
  assert.ok(s.includes('Teams・Zoom・Chrome・Edge の会議を出ると、6 秒ほどで録音を止めて議事録を作ります'), s);
  assert.ok(s.includes('](record/meeting-detect.md#leave)'), 'record/meeting-detect.md#leave への道が無い');
  const readme = read('README.md');
  assert.ok(readme.includes('**会議を出たとき（0.12.1 から）:**'), 'README に項目が無い');
});
test('0.12.1 点検の直し 2: 「誤って止まったとき」の録り直しは ［＋ 新しい議事録］ と [[Alt+M]] から言い、同じアプリの会議に入り直したときは右上のパネルが出ないことがあると書く（R3: 0.9.3 のつなぎ直し）', { timeout: 5000 }, () => {
  const t = read(fileOf('record/meeting-detect'));
  const at = t.indexOf('{#leave-split}');
  const step1 = t.slice(at).split('\n').find((l) => l.startsWith('1. '));
  assert.ok(step1, '手順の 1 が無い');
  const iNew = step1.indexOf('［＋ 新しい議事録］');
  const iKey = step1.indexOf('[[Alt+M]]');
  const iPanel = step1.indexOf('パネル');
  assert.ok(iNew >= 0 && iKey >= 0, step1);
  assert.ok(iPanel > iNew && iPanel > iKey, `パネルを先に言っている: ${step1}`);
  assert.ok(step1.includes('同じアプリ') && step1.includes('パネルが出ないことがあります'), step1);
});

// 0.13.0 RDY-5（計画 docs/plans/2026-10-24-130.md の第2部「画面の文（第2部）」の下の案・RD9・EQ23 (a)）: ［新しい議事録］はページを開くだけで、［文字起こしを始める］で録音が始まる
test('0.13.0 RDY-5: record/start-stop の頭の NOTE は録音の前のページの文（「同意したものとみなされます」・送り先）と「始める前に参加者へ伝えてください」の1文（EQ23 (a)）。「始める」は録音の前のページ・［文字起こしを始める］・［オフラインモードで始める］・何も残らないこと、ホットキー・パネル・トレイはすぐ始まること', { timeout: 5000 }, () => {
  const t = read(fileOf('record/start-stop'));
  const head = t.slice(0, t.indexOf('\n## '));
  for (const w of ['［文字起こしを始める］', '『始めると、録音と文字起こしに参加者全員が同意したものとみなされます。』', '音声の送り先', '録音することは、始める前に参加者へ伝えてください。']) assert.ok(head.includes(w), `頭の NOTE に「${w}」が無い`);
  assert.ok(!head.includes('録音していることは、会議の参加者へ伝えてください。'), '前の NOTE の文が残っている');
  const s = sectionOf('record/start-stop', 'start');
  for (const w of ['録音の前のページ', 'まだ録音しません', '［メモ］', '［文字起こしを始める］', '［オフラインモードで始める］', '何も残りません', '確かめます', '[[Alt+M]]', '会議の知らせのパネル', '［議事録の記録を開始］', 'すぐ録音を始めます', 'そのページのメモと種類のまま']) assert.ok(s.includes(w), `「始める」に「${w}」が無い`);
  // ［新しい議事録］を押すだけで録音が始まると読める文が無い
  assert.ok(!t.includes('- サイドバーの ［新しい議事録］ を押す\n'), '［新しい議事録］で始まる前の箇条が残っている');
  assert.ok(!/description: ［新しい議事録］・ホットキー・トレイから録音を始め/.test(t), 'description が前の形');
  assert.ok(/updated: 2026-10-2[6-9]/.test(t), 'updated を直していない');
  assert.ok(t.includes('docs/plans/2026-10-24-130.md'), 'sources に計画が無い');
  // ほかの記事と README も同じ中身
  assert.ok(read(fileOf('start/what-natsu-does')).includes('録音の前のページ'), 'start/what-natsu-does が前の形');
  const md = read(fileOf('record/meeting-detect'));
  const step1 = md.slice(md.indexOf('{#leave-split}')).split('\n').find((l) => l.startsWith('1. '));
  assert.ok(step1.includes('［＋ 新しい議事録］ → ［文字起こしを始める］ か [[Alt+M]]'), step1);
  assert.ok(read(fileOf('record/pc-only')).includes('録音の前のページの ［オフラインモードで始める］'), 'record/pc-only に録音の前のページの［オフラインモードで始める］が無い');
  const readme = read('README.md');
  assert.ok(readme.includes('［＋ 新しい議事録］を押すと録音の前のページが開きます'), 'README の記録中のページが前の形');
  assert.ok(!readme.includes('［＋ 新しい議事録］を押すと記録が始まり'), 'README に前の文が残っている');
});

// ---------------------------------------------------------------- ヘルプの全体像と図解（計画 docs/plans/2026-10-27-help-overview.md）
// HO-1（HO2・Review Focus 1〜3）: 記事の画面の写真は、アプリのテストの明るい版の基準の写真（test/shots/win32/）からだけ作り、
// 元の名前と指紋を help/shots-from-app.json に書く。アプリの基準を撮り直すと赤になり、ヘルプの写真の作り直しを忘れない
const AS = () => require('../tools/help-appshots');

/** 写しのフォルダ: 表・表の元の基準の写真・help/assets/shots だけ */
function shotsCopy(t) {
  const root = tmpDir(t, 'natsu-help-appshots-');
  const table = JSON.parse(read('help/shots-from-app.json'));
  fs.mkdirSync(path.join(root, 'test', 'shots', 'win32'), { recursive: true });
  for (const s of table.shots) fs.cpSync(path.join(ROOT, s.from), path.join(root, s.from));
  fs.mkdirSync(path.join(root, 'help'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'help', 'shots-from-app.json'), path.join(root, 'help', 'shots-from-app.json'));
  fs.cpSync(path.join(ROOT, 'help', 'assets', 'shots'), path.join(root, 'help', 'assets', 'shots'), { recursive: true });
  return { root, table };
}

test('HO-1（HO2）: help/shots-from-app.json の写真は、どれもアプリのテストの明るい版の基準の写真（test/shots/win32/）から作り、元の指紋が今の基準と同じ。help/assets/shots/ の PNG は元の写真（の切り抜き）と画素まで同じで、表に無いファイルが無い', { timeout: 10000 }, () => {
  const { checkShots, MAX_IMAGE_BYTES } = AS();
  assert.strictEqual(MAX_IMAGE_BYTES, 100000, '画像は1枚 100KB まで');
  const table = JSON.parse(read('help/shots-from-app.json'));
  assert.ok(table.shots.length >= 8, '写真が少ない');
  for (const s of table.shots) {
    assert.match(s.from, /^test\/shots\/win32\/[a-z0-9-]+\.png$/, s.name);
    assert.ok(/(?:^|-)light(?:-|$)/.test(path.basename(s.from, '.png')) && !/dark/.test(s.from), `${s.name}: 明るい版の基準だけを使う（${s.from}）`);
    assert.match(s.fromSha256, /^[A-Za-z0-9_-]{43}$/, `${s.name}: 指紋は SHA-256 の base64url（64 字の16進はゲートが AUD の見かけとして止める）`);
  }
  assert.deepStrictEqual(checkShots(ROOT), [], 'node tools/help-appshots.js で作り直し、写真の変わった記事を読み直す');
});

test('HO-1（Review Focus 1・2）: 元の基準の写真が変わると（切り抜きの外の1画素でも）from-changed、作った写真の画素を変えると pixels-differ、表に無い PNG を help/assets/shots/ に置くと not-in-table、100KB を越える画像は too-big、暗い版の基準を表に書くと not-light', { timeout: 10000 }, (t) => {
  const { checkShots } = AS();
  const { decodePng, encodePng } = require('../tools/png');
  const codes = (root) => checkShots(root).map((p) => p.code);
  // 切り抜いた写真の元の左上の1画素（切り抜きの外）を変える
  const a = shotsCopy(t);
  const cropped = a.table.shots.find((s) => s.crop && (s.crop[0] > 0 || s.crop[1] > 0));
  assert.ok(cropped, '切り抜いた写真が表に無い');
  const f = path.join(a.root, cropped.from);
  const img = decodePng(fs.readFileSync(f));
  img.data[0] = img.data[0] ^ 0xff;
  fs.writeFileSync(f, encodePng(img));
  assert.deepStrictEqual(codes(a.root), ['from-changed'], '基準の写真が変わったのに気づかない');
  // 表に無い PNG・大きすぎる画像
  const b = shotsCopy(t);
  fs.writeFileSync(path.join(b.root, 'help', 'assets', 'shots', 'stray.png'), Buffer.alloc(100001, 1));
  assert.deepStrictEqual(codes(b.root).sort(), ['not-in-table', 'too-big']);
  // 作った写真を手で直した（画素が元の切り抜きと違う）
  const d = shotsCopy(t);
  const g = path.join(d.root, 'help', 'assets', 'shots', `${d.table.shots[0].name}.png`);
  const gi = decodePng(fs.readFileSync(g));
  gi.data[gi.data.length - 4] ^= 0xff;
  fs.writeFileSync(g, encodePng(gi));
  assert.ok(codes(d.root).includes('pixels-differ'), '作った写真を直しても気づかない');   // 写真を埋め込んだ図も figure-differs になる
  // 暗い版の基準
  const c = shotsCopy(t);
  const tab = JSON.parse(fs.readFileSync(path.join(c.root, 'help', 'shots-from-app.json'), 'utf8'));
  tab.shots[0].from = tab.shots[0].from.replace('light', 'dark');
  fs.writeFileSync(path.join(c.root, 'help', 'shots-from-app.json'), JSON.stringify(tab));
  assert.ok(codes(c.root).includes('not-light'), '暗い版の基準を使えてしまう');
});

test('HO-1（Review Focus 3）: 記事の画像は全部 help/assets/ にあり、1枚 100KB まで。help/assets/shots/ の画像は表に載っている', { timeout: 5000 }, () => {
  const table = JSON.parse(read('help/shots-from-app.json'));
  const listed = new Set([...table.shots.map((s) => `shots/${s.name}.png`), ...(table.figures || []).map((g) => `shots/${g.name}.svg`)]);
  for (const a of articles) {
    a.text.split('\n').forEach((l, i) => {
      const m = /^!\[[^\]]+\]\(assets\/([^)]+)\)$/.exec(l);
      if (!m) return;
      const p = path.join(ROOT, 'help', 'assets', m[1]);
      assert.ok(fs.existsSync(p), `${a.file}:${i + 1} ${m[1]} が無い`);
      assert.ok(fs.statSync(p).size <= 100000, `${a.file}:${i + 1} ${m[1]} が 100KB を越える`);
      if (m[1].startsWith('shots/')) assert.ok(listed.has(m[1]), `${a.file}:${i + 1} ${m[1]} が help/shots-from-app.json に無い`);
    });
  }
});

// HO-2（HO3）: 「ここを押す」は、写真に番号の丸と細い枠を重ねた1枚の SVG で示す。<img> で出す SVG は外の写真を読まない（Chromium で確かめた）ので、
// 写真の PNG を data: でそのまま埋め込む。SVG は help-appshots の figureSvg が表（figures）から作り、手で直さない
const SVG_COLORS = new Set(['#000000', '#ffffff', '#ffd43d', '#cccccc']);   // 黒・白・DADS の yellow-300・罫線の灰色（solid-gray-200）だけ
function svgProblems(svg) {
  const out = [];
  if (/<text|<tspan|<foreignObject|<script|<style|\son[a-z]+\s*=/i.test(svg)) out.push('文字・script・style・on…= がある');
  for (const m of svg.matchAll(/\shref="([^"]*)"/g)) if (!m[1].startsWith('data:image/png;base64,')) out.push(`外の参照 ${m[1].slice(0, 40)}`);
  for (const m of svg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) if (!SVG_COLORS.has(m[0].toLowerCase())) out.push(`使えない色 ${m[0]}`);
  if (/rgb\(|hsl\(|url\(/i.test(svg)) out.push('rgb()・hsl()・url() がある');
  return out;
}

test('HO-2（HO3）: 写真の図（help/assets/shots/<名前>.svg）は表の写真の PNG をそのまま data: で埋め込み、番号の丸（黄色の地・黒の線の数字）と細い枠だけを重ねる。中身は figureSvg と同じ。文字（<text>）・script・外の住所が無く、色は黒・白・黄色・罫線の灰色だけ', { timeout: 10000 }, () => {
  const { checkShots, figureSvg } = AS();
  const table = JSON.parse(read('help/shots-from-app.json'));
  assert.ok(Array.isArray(table.figures) && table.figures.length >= 8, '写真の図が少ない');
  const shotNames = new Set(table.shots.map((s) => s.name));
  for (const g of table.figures) {
    assert.ok(shotNames.has(g.shot), `${g.name}: 写真 ${g.shot} が表に無い`);
    assert.ok(g.marks.length >= 1 && g.marks.length <= 9, `${g.name}: 印は 1〜9 個`);
    const png = fs.readFileSync(path.join(ROOT, 'help', 'assets', 'shots', `${g.shot}.png`));
    const svg = read(`help/assets/shots/${g.name}.svg`).replace(/\r\n?/g, '\n');
    assert.strictEqual(svg, figureSvg(g, png), `${g.name}: node tools/help-appshots.js で作り直す（手で直さない）`);
    assert.ok(svg.includes(`href="data:image/png;base64,${png.toString('base64')}"`), `${g.name}: 写真をそのまま埋め込んでいない`);
    assert.strictEqual((svg.match(/<g class="mark">/g) || []).length, g.marks.length, `${g.name}: 印の数`);
    assert.deepStrictEqual(svgProblems(svg), [], g.name);
  }
  assert.deepStrictEqual(checkShots(ROOT), []);
});

test('HO-2: 写真の図を手で直すと figure-differs、表に無い SVG を置くと not-in-table', { timeout: 10000 }, (t) => {
  const { checkShots } = AS();
  const a = shotsCopy(t);
  const f = path.join(a.root, 'help', 'assets', 'shots', `${a.table.figures[0].name}.svg`);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('fill="#ffd43d"', 'fill="#ffffff"'));
  assert.deepStrictEqual(checkShots(a.root).map((p) => p.code), ['figure-differs']);
  const b = shotsCopy(t);
  fs.writeFileSync(path.join(b.root, 'help', 'assets', 'shots', 'stray.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.deepStrictEqual(checkShots(b.root).map((p) => p.code), ['not-in-table']);
});

test('HO-2（Review Focus 3）: 記事の画像（.body img）は幅 100%・高さ自動（スマホの幅でも横にはみ出さず、図は本文の幅いっぱい）', { timeout: 5000 }, () => {
  const css = read('help/assets/help.css');
  assert.match(css, /^\.body img \{ width: 100%; height: auto; \}$/m);
  assert.doesNotMatch(css, /\.body img \{[^}]*max-width/, '幅の決まりが max-width のまま');
});

// HO-3（HO4）: 仕組みの図は手で描く白黒の箱と矢印（DADS の白黒・線の太さで強調）。図の中に文字を書かず、図の下の番号の説明と対にする
test('HO-3（HO4）: 仕組みの図（help/assets/diagrams/*.svg）は手で描く白黒の箱と矢印。文字（<text>）・script・外の参照が無く、色は黒・白・黄色・罫線の灰色だけ。番号の丸が 1 から順にあり、1枚 100KB まで。help/assets/diagrams/ には SVG だけ', { timeout: 5000 }, () => {
  const dir = path.join(ROOT, 'help', 'assets', 'diagrams');
  const files = fs.readdirSync(dir).sort();
  assert.ok(files.includes('overview-flow.svg'), '全体像の仕組みの図が無い');
  for (const f of files) {
    assert.match(f, /^[a-z0-9-]{1,60}\.svg$/, `${f}: 仕組みの図は SVG だけ`);
    const svg = read(`help/assets/diagrams/${f}`);
    assert.ok(Buffer.byteLength(svg) <= 100000, `${f}: 100KB を越える`);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+" width="\d+" height="\d+">/, `${f}: 頭の形`);
    assert.deepStrictEqual(svgProblems(svg), [], f);
    assert.ok(!/<image/.test(svg), `${f}: 仕組みの図に写真を入れない（写真は help/assets/shots/）`);
    const marks = (svg.match(/<g class="mark">/g) || []).length;
    assert.ok(marks >= 2, `${f}: 番号の丸が無い`);
    // 番号の丸の数字は figureSvg と同じ線の数字で、1 から順
    const { DIGITS } = AS();
    const ds = [...svg.matchAll(/<g class="mark">.*?\sd="([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(ds, Array.from({ length: marks }, (_, i) => DIGITS[i + 1]), `${f}: 番号が 1 から順でない`);
  }
});

// HO-3（図の下の説明）: 写真の図と仕組みの図には、図の中に文字を書かない代わりに、図のすぐ下に印の数と同じ数の番号の説明（1. …）を置く
/** 記事の中の図（.svg の画像の行）ごとに { file, line, src, marks（図の番号の丸の数）, items（直後の番号のリストの項目の数） } */
function figuresIn(a) {
  const lines = a.text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  lines.forEach((l, i) => {
    const m = /^!\[([^\]]+)\]\(assets\/((?:shots|diagrams)\/[a-z0-9-]+\.svg)\)$/.exec(l);
    if (!m) return;
    const svg = read(`help/assets/${m[2]}`);
    let j = i + 1;
    while (j < lines.length && lines[j] === '') j++;
    // 図と番号のリストの間に、1段落（「太い枠の中が…」のような読み方の一言）までは置いてよい
    if (j < lines.length && !/^\d+\. /.test(lines[j]) && !/^[-#>|!`]/.test(lines[j])) { while (j < lines.length && lines[j] !== '') j++; while (j < lines.length && lines[j] === '') j++; }
    let items = 0;
    for (let k = j, n = 1; k < lines.length && lines[k].startsWith(`${n}. `); k++, n++) items++;
    out.push({ file: a.file, line: i + 1, src: m[2], alt: m[1], marks: (svg.match(/<g class="mark">/g) || []).length, items });
  });
  return out;
}

test('HO-3（HO3・Review Focus 4）: 記事の図（写真の図と仕組みの図）のすぐ下に、図の番号の丸と同じ数の番号の説明（1. から）がある。代わりの文（alt）は空でない', { timeout: 5000 }, () => {
  let n = 0;
  for (const a of articles) {
    for (const f of figuresIn(a)) {
      n++;
      assert.ok(f.alt.trim().length >= 10, `${f.file}:${f.line} 代わりの文が短い`);
      assert.strictEqual(f.items, f.marks, `${f.file}:${f.line} ${f.src} の番号の丸は ${f.marks} 個、下の番号の説明は ${f.items} 個`);
    }
  }
  assert.ok(n >= 6, `図が少ない（${n}）`);
});

// HO-4（HO5・HO6）: 新しい記事「NaTsu の全体像」（start/overview）。はじめに のいちばん上と、ホームの「はじめての方へ」の先頭
test('HO-4（HO5）: start/overview は「はじめに」のいちばん上で、featured の先頭。題名は「NaTsu の全体像」', { timeout: 5000 }, () => {
  const start = site.categories.find((c) => c.id === 'start');
  assert.strictEqual(start.articles[0], 'overview', 'はじめに のいちばん上でない');
  assert.strictEqual(site.featured[0], 'start/overview', 'featured の先頭でない');
  assert.strictEqual(metaOf(articles.find((a) => a.ref === 'start/overview')).title, 'NaTsu の全体像');
});

test('HO-4: start/overview に、画面の地図と録音バー・1回の会議の流れ（録音の前のページ → 録音中 → 議事録）・仕組みの図・音声の行き先の表・保存の場所・Claude とのつながり・くわしい記事へのリンクがある（0.13.0 の画面: ［新しい議事録］は録音の前のページを開き、［文字起こしを始める］で始まる）', { timeout: 5000 }, () => {
  const t = read(fileOf('start/overview'));
  const srcs = figuresIn({ file: 'start/overview', text: t }).map((f) => f.src);
  assert.deepStrictEqual(srcs, ['shots/overview-map.svg', 'shots/bar.svg', 'shots/ready.svg', 'shots/live.svg', 'shots/minutes.svg', 'diagrams/overview-flow.svg']);
  for (const h of ['{#map}', '## 手順1. ', '## 手順2. ', '## 手順3. ', '{#data}', '{#storage}', '{#claude}', '{#more}']) assert.ok(t.includes(h), `見出し ${h} が無い`);
  for (const w of ['録音の前のページ', 'まだ録音しません', '［文字起こしを始める］', '［オフラインモードで始める］', '［■ 終了して作成］', '［オフラインモード］', '［AI 要約］',
    '太い矢印は音声', '細い矢印は文字', '音声も文字も保存しません', 'この PC の中にだけ保存', '守秘のためのボタンではありません', '［ヘルプ］']) assert.ok(t.includes(w), `「${w}」が無い`);
  for (const r of ['start/what-natsu-does', 'start/login', 'record/start-stop', 'record/pause', 'record/status-line', 'record/pc-only', 'start/claude-mcp']) assert.ok(t.includes(`](${r}.md`), `${r} へのリンクが無い`);
  assert.ok(!/［新しい議事録］ を押すと(?:録音|記録)が始ま/.test(t), '［新しい議事録］で録音が始まると読める（0.12.1 までの動き）');
});

// HO-5（HO1）: はじめに・会議を記録する の 7 本に画面の写真の図を足す（ほかの記事は、次にその記事を直すときに足す）
test('HO-5（HO1）: はじめに・会議を記録する の 7 本に、その記事の画面の写真の図がある（図の下の番号の説明は HO3 のテスト）。直した記事の updated は 2026-10-27 以降', { timeout: 5000 }, () => {
  const want = {
    'start/what-natsu-does': ['shots/minutes.svg'],
    'start/login': ['shots/login.svg'],
    'start/claude-mcp': ['shots/mcp.svg'],
    'record/start-stop': ['shots/ready.svg', 'shots/live.svg', 'shots/bar.svg'],
    'record/pause': ['shots/bar-paused.svg'],
    'record/status-line': ['shots/status.svg'],
    'record/pc-only': ['shots/offline.svg'],
  };
  for (const [ref, srcs] of Object.entries(want)) {
    const a = articles.find((x) => x.ref === ref);
    assert.deepStrictEqual(figuresIn(a).map((f) => f.src), srcs, `${ref} の図`);
    assert.ok(metaOf(a).updated >= '2026-10-27', `${ref}: updated を直していない`);
  }
  // 全体像の記事へのリンク（画面の全体はそちらで見る）
  assert.ok(read(fileOf('start/what-natsu-does')).includes('](start/overview.md)'), 'start/what-natsu-does から全体像へのリンクが無い');
});

// HO-7（HO8。計画の「HO-7」の節）: 古い「試験利用の手順（0.9.0）」を新しい記事「NaTsu のはじめかた」（start/getting-started）に置き換える。
// 古い住所 start/tester-guide は Teams のリンクのために残し、新しい記事へ導く短い移動の知らせにする（分類に載らない記事は置けないので、はじめに のいちばん下: R-HO1）
test('HO-7（HO8）: start/getting-started は「はじめに」の2番目（全体像の次）で、featured の2番目。featured に start/tester-guide は無く、start/tester-guide は「はじめに」のいちばん下（R-HO1）。題名は「NaTsu のはじめかた」。related は移動の知らせを指さない（R-HO3）', { timeout: 5000 }, () => {
  const start = site.categories.find((c) => c.id === 'start');
  assert.strictEqual(start.articles[1], 'getting-started', 'はじめに の2番目でない');
  assert.strictEqual(site.featured[1], 'start/getting-started', 'featured の2番目でない');
  assert.ok(!site.featured.includes('start/tester-guide'), 'featured に古い試験利用の手順が残っている');
  assert.strictEqual(start.articles[start.articles.length - 1], 'tester-guide', '移動の知らせが はじめに のいちばん下でない（R-HO1）');
  assert.strictEqual(metaOf(articles.find((a) => a.ref === 'start/getting-started')).title, 'NaTsu のはじめかた');
  for (const a of articles) assert.ok(!metaOf(a).related.includes('start/tester-guide'), `${a.ref}: related に移動の知らせ start/tester-guide`);
});

test('HO-7: start/getting-started に、用意するもの → 手順1〜4（インストール・ログイン・要約の準備・相手の声）→ 会議を記録する → 音声入力 → 知っておいてほしいこと → 困ったとき が順にあり、図は HO-1 の写真の図だけ。0.13.0 の動き（［＋ 新しい議事録］は録音の前のページを開く）で書き、参加者に了承を取る1文がある', { timeout: 5000 }, () => {
  const t = read(fileOf('start/getting-started'));
  const srcs = figuresIn({ file: 'start/getting-started', text: t }).map((f) => f.src);
  assert.deepStrictEqual(srcs, ['shots/login.svg', 'shots/claude.svg', 'shots/loop.svg', 'shots/start.svg', 'shots/live.svg', 'shots/bar.svg', 'shots/minutes.svg']);
  let at = -1;
  for (const h of ['{#prepare}', '## 手順1. ', '## 手順2. ', '## 手順3. ', '## 手順4. ', '{#record}', '{#dictation}', '{#notes}', '{#help}']) {
    const i = t.indexOf(h);
    assert.ok(i > at, `見出し ${h} が無いか、順が違う`);
    at = i;
  }
  for (const w of ['［設定］', '［アカウント］', '［ログイン］', '［要約］', '［Claude Code を入れる］', '［Claude Code にログイン］', '［Claude Code を確かめる］', '［録音］', '「議事録で相手の声も録る」',
    '［＋ 新しい議事録］', '録音の前のページ', 'まだ録音しません', '［文字起こしを始める］', '参加者に録音と文字起こしの了承を取ってください', '[[Alt+M]]', '［⏸ 一時停止］', '［■ 終了して作成］',
    // 0.15.1 ND-4（計画 docs/plans/2026-11-04-151.md の「意図して変えるテスト」・D114）で意図して変えた: 節 #dictation は Windows の音声入力の一言（[[Win+H]]）
    '［AI 要約］', '［メモ］', '［文字起こし］', '[[Win+H]]', '音声も文字も保存しません', 'この PC の中にだけ保存', '［ローカル AI］', '［更新して再起動］', '守秘のためのボタンではありません', '［ヘルプ］',
    'Teams の NaTsu のチャンネル', 'だいたいの時刻']) assert.ok(t.includes(w), `「${w}」が無い`);
  assert.ok(!/［(?:＋ )?新しい議事録］ ?(?:を押す|で)[^。]*(?:録音|記録)が始ま/.test(t), '［新しい議事録］で録音が始まると読める（0.12.1 までの動き）');
  assert.ok(!/NaTsu-\d+\.\d+\.\d+-setup\.exe/.test(t), 'インストーラーの名前に版の数がある（古くなる）');
  for (const r of ['start/overview', 'start/install-update', 'start/login', 'start/claude-code', 'record/start-stop', 'record/pc-only', 'dictation/dictation', 'trouble/banners']) assert.ok(t.includes(`](${r}.md`), `${r} へのリンクが無い`);
  assert.ok(read(fileOf('start/overview')).includes('](start/getting-started.md)'), '全体像の記事から はじめかた へのリンクが無い');
});

test('HO-7（HO8）: start/tester-guide は短い移動の知らせ。題名は「NaTsu のはじめかた（移動しました）」で、本文は start/getting-started へのリンクのある短い文だけ（見出し・図・手順・古い版の数が無い）', { timeout: 5000 }, () => {
  const file = fileOf('start/tester-guide');
  const t = read(file);
  const fm = parseFrontMatter(t, { file });
  assert.strictEqual(fm.meta.title, 'NaTsu のはじめかた（移動しました）');
  const body = fm.body.trim();
  assert.ok(body.includes('](start/getting-started.md)'), '新しい記事へのリンクが無い');
  const lines = body.split('\n').filter((l) => l.trim());
  assert.ok(lines.length >= 1 && lines.length <= 3, `移動の知らせが長い（${lines.length} 行）`);
  assert.ok(!/^(?:#|!\[|\d+\. |- |>)/m.test(body), '見出し・図・手順・箇条書き・囲みがある');
  assert.ok(!/0\.9\.0/.test(t), '古い版の数が残っている');
});

test('HO-7（R-HO5）: 設定の基準（settings-…）から作る写真は切り抜きがあり、左の列の下の版の字の所（1120×780 の [60, 705, 120, 30]）に掛からない', { timeout: 5000 }, () => {
  const VERSION_AT = [60, 705, 120, 30];
  const table = JSON.parse(read('help/shots-from-app.json'));
  const settings = table.shots.filter((s) => /\/settings-[a-z0-9-]+\.png$/.test(s.from));
  assert.ok(settings.length >= 4, `設定の写真が少ない（${settings.length}）`);
  const [vx, vy, vw, vh] = VERSION_AT;
  for (const s of settings) {
    assert.ok(Array.isArray(s.crop), `${s.name}: 切り抜きが無い（版の字が写る）`);
    const [x, y, w, h] = s.crop;
    assert.ok(!(x < vx + vw && vx < x + w && y < vy + vh && vy < y + h), `${s.name}: 切り抜き [${s.crop.join(', ')}] が版の字の所に掛かる`);
  }
});

// ---------------------------------------------------------------- 0.14.0 EK-7（計画 docs/plans/2026-10-26-140.md の Task EK-7・決めたこと 38・BQ24 (a)・R206）
// 文字の飾り・元に戻す・貼り付け・行の選び方・窓の中の近道・NaTsu の中の音声入力・口述の整え・メモの行。近道の表は src/shortcuts.js の SHORTCUTS と照らす
const { SHORTCUTS } = require('../src/shortcuts');
const EK7_REFS = ['summary/edit-summary', 'summary/summary-types', 'settings/hotkeys', 'dictation/dictation', 'admin/relay-limits'];
/** 見出しの {#id} から次の ## の見出しの前まで */
const ek7Sec = (t, id) => {
  const i = t.indexOf(`{#${id}}`);
  assert.ok(i >= 0, `{#${id}} の節が無い`);
  const j = t.indexOf('\n## ', i);
  return t.slice(i, j < 0 ? t.length : j);
};
/** 表の本文の行（頭の行と --- の行は除く）を [見出し（### の文。無ければ ''）, 左の列, 右の列] で */
const tableRows = (sec) => {
  const out = [];
  let head = '';
  for (const line of sec.split('\n')) {
    const h = /^### (.+)$/.exec(line);
    if (h) { head = h[1].replace(/ *\{#[^}]*\}$/, ''); continue; }
    const m = /^\| (.+?) \| (.+?) \|$/.exec(line);
    if (!m || /^-+$/.test(m[1]) || m[1] === 'キー') continue;
    out.push([head, m[1], m[2]]);
  }
  return out;
};
/** SHORTCUTS のキー（「・」で区切る）を記事の形（1つずつ [[…]]）に */
const keyCell = (keys) => keys.split('・').map((k) => `[[${k}]]`).join('・');
/** 記事のキーの欄・SHORTCUTS のキーを1つずつのキーにほどく（「Ctrl+Shift+0〜6」は 0 から 6 の1つずつ） */
const oneKeys = (cell) => cell.replace(/\[\[([^\]]+)\]\]/g, '$1').split('・').flatMap((k) => {
  const r = /^(.*?)(\d)〜(\d)$/.exec(k);
  if (!r) return [k];
  const out = [];
  for (let d = Number(r[2]); d <= Number(r[3]); d++) out.push(`${r[1]}${d}`);
  return out;
});

test('EK-7: 直した記事（要約を書き直す・会議の種類とメモの型・ホットキー・音声入力・中継の1日の上限）の ［…］ はアプリにある文字だけで、updated は 2026-11-02 から。pre は使わない。site.json の音声入力と要約の分類の説明に新しい働きがある', { timeout: 5000 }, () => {
  const app = L.appLabelText(ROOT);
  for (const ref of EK7_REFS) {
    const a = articles.find((x) => x.ref === ref);
    assert.ok(a, `${ref} の記事が無い`);
    assert.deepStrictEqual(L.missingLabels(a.text, app), [], `${ref}: アプリに無い ［…］`);
    assert.ok(metaOf(a).updated >= '2026-11-02', `${ref}: updated を直した日にしていない`);
    assert.ok(!/<pre|```/.test(a.text), `${ref}: pre の要素を使った`);
  }
  // 新しく書いた画面の言葉（アプリの文字にあることは上で見る）
  const es = read(fileOf('summary/edit-summary'));
  for (const w of ['［色 ▸］', '［リンクを付ける］', '［外す］', '［削除］', '［複製］', '［変換 ▸］']) assert.ok(es.includes(w), `summary/edit-summary に ${w} が無い`);
  // 0.15.1 ND-4（計画 docs/plans/2026-11-04-151.md の「意図して変えるテスト」・D114）で意図して変えた: dictation/dictation は Win+H の案内に書き換え、分類「音声入力」の説明は「NaTsu の音声入力は 0.15.1 でなくなりました。…」（WQ4。ND-4 の照らし）
  assert.ok(!read(fileOf('dictation/dictation')).includes('［元の文をコピー］'), 'dictation/dictation に消えた ［元の文をコピー］ が残っている');
  const cat = (id) => site.categories.find((c) => c.id === id).description;
  assert.match(cat('dictation'), /Windows の音声入力/);
  assert.match(cat('summary'), /メモ/);
});

test('EK-7・U3（決めたこと 38）: settings/hotkeys の「NaTsu の窓の中だけで効くキー」の表は、効く所の見出しごとに SHORTCUTS と一字ずつ同じ（並びも）。表の下に音声入力のキーの一言と Ctrl+W の決まり（0.15.0 PH-5 で意図して変えた: Ctrl+Shift+N の行がある）', { timeout: 5000 }, () => {
  const t = read(fileOf('settings/hotkeys'));
  const sec = ek7Sec(t, 'in-app');
  const got = tableRows(sec);
  const want = SHORTCUTS.map((r) => [r.where, keyCell(r.keys), r.what]);
  assert.deepStrictEqual(got, want, '近道の表が SHORTCUTS と違う（src/shortcuts.js の表を写す）');
  assert.ok(/\[\[Ctrl\+Shift\+N\]\]/.test(sec), 'Ctrl+Shift+N の行が無い（0.15.0 PH-5・BQ7 (a)）');
  // 0.15.1 ND-4（計画 docs/plans/2026-11-04-151.md の「意図して変えるテスト」・D114）で意図して変えた: 表の下の一言は Windows の音声入力の案内（記事の節 #in-natsu は無くなった）
  assert.ok(sec.includes('Windows の音声入力（[[Win+H]]）を使います'), 'Windows の音声入力の一言が無い');
  assert.ok(sec.includes('](dictation/dictation.md)'), '案内の記事へのリンクが無い');
  for (const w of ['録音中のページは閉じられません（［■ 終了して作成］で止めます）', '窓は閉じません', '空のページ']) assert.ok(sec.includes(w), `Ctrl+W の決まりに「${w}」が無い`);
  // 照らしの形そのものが当たること（空振りしない）: 1行を消すと違う
  assert.notDeepStrictEqual(tableRows(sec.replace(/^\| \[\[Ctrl\+W\]\] \|.*\n/m, '')), want);
});

test('EK-7・U3: summary/edit-summary の近道の表のキーは、SHORTCUTS の「要約の行を直しているとき」のキーと同じ集まり。行の選び方の表は「要約の行を選んでいるとき」の行と一字ずつ同じ。Ctrl+Shift+N は無い', { timeout: 5000 }, () => {
  const t = read(fileOf('summary/edit-summary'));
  const keys = tableRows(ek7Sec(t, 'keys'));
  const got = [...new Set(keys.flatMap((r) => oneKeys(r[1])))].sort();
  const want = [...new Set(SHORTCUTS.filter((r) => r.where === '要約の行を直しているとき').flatMap((r) => oneKeys(r.keys)))].sort();
  assert.deepStrictEqual(got, want, '近道の表のキーが SHORTCUTS の要約の行のキーと違う');
  const sel = tableRows(ek7Sec(t, 'select')).map((r) => [r[1], r[2]]);
  assert.deepStrictEqual(sel, SHORTCUTS.filter((r) => r.where === '要約の行を選んでいるとき').map((r) => [keyCell(r.keys), r.what]), '行の選び方の表が SHORTCUTS と違う');
  assert.ok(!/Ctrl\+Shift\+N/.test(t), 'Ctrl+Shift+N がある');
});

test('EK-7（E6・E7・E8・E9）: summary/edit-summary に文字の飾り・元に戻す・貼り付け・行の選び方の節がある。元に戻すは NaTsu を終えると消え、［要約を再生成］は戻せない。Ctrl+Shift+V。前の版の「貼り付けは文字だけ」「Esc で ⠿ へ」は無い', { timeout: 5000 }, () => {
  const t = read(fileOf('summary/edit-summary'));
  const marks = ek7Sec(t, 'marks');
  for (const w of ['[[Ctrl+B]]', '[[Ctrl+I]]', '[[Ctrl+U]]', '[[Ctrl+Shift+S]]', '[[Ctrl+E]]', '[[Ctrl+K]]', '[[Ctrl+Shift+H]]', '`**文字**`', '`*文字*`', '`~文字~`', '［色 ▸］', '文字の色', '背景の色', '既定',
    '開けるのは https・http・mailto と NaTsu のリンクだけです', '［リンクを付ける］', '［外す］', '[[Ctrl]] を押しながら', '/あか', '［コピー］']) assert.ok(marks.includes(w), `飾りの節に「${w}」が無い`);
  const undo = ek7Sec(t, 'undo');
  for (const w of ['[[Ctrl+Z]]', '[[Ctrl+Shift+Z]]', '[[Ctrl+Y]]', 'NaTsu を終えると消えます', 'これ以上は戻せません', 'やり直せるものはありません', 'ほかの所で変わったので、元に戻せませんでした', '100', '2 秒', 'ページごと', 'メモ']) {
    assert.ok(undo.includes(w), `元に戻すの節に「${w}」が無い`);
  }
  assert.ok(undo.split('\n').some((l) => l.includes('［要約を再生成］') && l.includes('元に戻せません')), '［要約を再生成］は元に戻せないことが無い（BQ2 (a)）');
  assert.ok(ek7Sec(t, 'regenerate').includes('元に戻せません'), '作り直しの節に「元に戻せません」が無い');
  const paste = ek7Sec(t, 'paste');
  for (const w of ['[[Ctrl+Shift+V]]', 'Word', 'Markdown', '貼り付けが大きすぎます（2,000 行・1MB まで）。分けて貼ってください。', '[[Ctrl+Z]] の1回', '色', 'URL']) assert.ok(paste.includes(w), `貼り付けの節に「${w}」が無い`);
  const sel = ek7Sec(t, 'select');
  for (const w of ['[[Esc]]', '[[Shift+↑]]', '[[Shift]] を押しながらクリック', '[[Alt+Shift]] を押しながらクリック', '余白', '[[Ctrl+A]]']) assert.ok(sel.includes(w), `行の選び方の節に「${w}」が無い`);
  assert.ok(!t.includes('文字だけが入ります（飾りや表は入りません）'), '前の版の「貼り付けは文字だけ」が残っている');
  assert.ok(!t.includes('メモと文字起こしの直し方は今までどおりです'), '前の版の「メモの直し方は今までどおり」が残っている');
  assert.ok(!t.includes('行の中で [[Esc]] を押すと、左の ⠿ に移ります'), '前の版の「Esc で ⠿ へ」が残っている（0.14.0 は行を選ぶ）');
});

test('EK-7（BQ11・BQ22・BQ23・BQ25・BQ29）: メモの欄も行の欄だと書く。今までのメモは「■」の行だけ見出しになり、開いただけでは変わらない。Claude に渡る文と［コピー］は今と同じ形。元に戻すは要約と別', { timeout: 5000 }, () => {
  const t = read(fileOf('summary/edit-summary'));
  const memo = ek7Sec(t, 'memo');
  for (const w of ['［メモ］', '「■ 」', '見出し', '開いただけでは', '［コピー］', 'Claude', '書いた順', '別々']) assert.ok(memo.includes(w), `メモの節に「${w}」が無い`);
  const st = read(fileOf('summary/summary-types'));
  assert.ok(st.includes('](summary/edit-summary.md#memo)'), 'summary/summary-types からメモの行の節へのリンクが無い');
  assert.ok(!st.includes('選んだ型の見出し（「■ 課題・要望（N）」など）がメモに入ります'), '前の版の「■ の文がメモに入る」が残っている（0.14.0 は見出しの行）');
});

// 0.15.1 ND-4（計画 docs/plans/2026-11-04-151.md の「意図して変えるテスト」・D114）で意図して変えた: dictation/dictation の「NaTsu の中で音声入力する」（#in-natsu）と「口述を整える」（#tidy）の節の2つのテスト（0.14.0 EK-7）を消した。
// U4・D108〜D111 を取りやめ（D114）、記事を Win+H の案内に書き換えたので、節そのものが無い（案内の記事は ND-4 の照らしが見る）

test('EK-7（DQ-2・BQ20 (a)・R50）: admin/relay-limits に整えの1日の回数（1人 2,000 回・全員 50,000 回）と秘密の欄（relay/config.mjs の名前と既定）がある', { timeout: 5000 }, () => {
  const cfg = read('relay/config.mjs');
  for (const [env, key, n] of [['DAILY_USER_TIDY', 'dailyUserTidy', 2000], ['DAILY_ALL_TIDY', 'dailyAllTidy', 50000]]) {
    assert.ok(cfg.includes(`e.${env}`), `relay/config.mjs に ${env} が無い（このテストの前提が崩れた）`);
    assert.match(cfg, new RegExp(`^  ${key}: ${n},`, 'm'), `relay/config.mjs の ${key} の既定が ${n} でない（このテストの前提が崩れた）`);
  }
  const t = read(fileOf('admin/relay-limits'));
  for (const w of ['2,000 回', '50,000 回', '`DAILY_USER_TIDY`', '`DAILY_ALL_TIDY`', '`2000`', '`50000`', '口述']) assert.ok(t.includes(w), `admin/relay-limits に「${w}」が無い`);
});

test('EK-7: 記事に Aqua Voice・Typeless の名前が無く、直した記事に Notion の名前も無い（ほかのアプリの説明の文を写さない）', { timeout: 5000 }, () => {
  for (const a of articles) assert.ok(!/aqua\s*voice|typeless/i.test(a.text), `${a.ref}: ほかの製品の名前がある`);
  for (const ref of EK7_REFS) assert.ok(!/notion/i.test(read(fileOf(ref))), `${ref}: Notion の名前がある`);
});

// ---------------------------------------------------------------- 0.15.0 PH-8（計画 docs/plans/2026-11-03-150.md の Task PH-8・決めたこと 1〜38・BQ4・BQ6・BQ8 (a)・RF60）
// ページの中のページ・白紙のページ・サイドバーの木・引っ張る・［移動先…］・パンくず・Ctrl+Shift+N・子ごとのゴミ箱と［ゴミ箱］から戻す・検索と Claude の場所の行
const PH8_REFS = ['find/page-tree', 'find/delete-and-backups', 'find/search', 'start/overview', 'settings/hotkeys', 'start/claude-mcp'];
test('PH-8: 直した記事の ［…］ はアプリにある文字だけで、updated は 2026-11-04 から。pre は使わない。site.json の find に page-tree があり、説明に新しい働きがある', { timeout: 5000 }, () => {
  const app = L.appLabelText(ROOT);
  for (const ref of PH8_REFS) {
    const a = articles.find((x) => x.ref === ref);
    assert.ok(a, `${ref} の記事が無い`);
    assert.deepStrictEqual(L.missingLabels(a.text, app), [], `${ref}: アプリに無い ［…］`);
    assert.ok(metaOf(a).updated >= '2026-11-04', `${ref}: updated を直した日にしていない`);
    assert.ok(!/<pre|```/.test(a.text), `${ref}: pre の要素を使った`);
  }
  const find = site.categories.find((c) => c.id === 'find');
  assert.ok(find.articles.includes('page-tree'), 'site.json の find に page-tree が無い');
  for (const w of ['ページの中のページ', 'ゴミ箱']) assert.ok(find.description.includes(w), `find の説明に「${w}」が無い`);
  // 新しく書いた画面の言葉（アプリの文字にあることは上で見る）
  const pt = read(fileOf('find/page-tree'));
  for (const w of ['［📄 白紙のページ］', '［🎙️ 議事録（録音の前のページ）］', '［移動先…］', '［いちばん上へ］', '［中にページを作る］', '［新しいタブで開く］', '［＋］', '/ページ', '[[Ctrl+Shift+N]]', '[[Ctrl+Shift+U]]', '[[Shift+F10]]', 'このページの中のページ', '無題のページ']) {
    assert.ok(pt.includes(w), `find/page-tree に ${w} が無い`);
  }
  for (const w of ['［ゴミ箱］', '［戻す］']) assert.ok(read(fileOf('find/delete-and-backups')).includes(w), `find/delete-and-backups に ${w} が無い`);
});

test('PH-8: 近道の表は SHORTCUTS と同じで、Ctrl+Shift+N・Ctrl+Shift+U の行がある（表そのものは EK-7・U3 のテストが一字ずつ照らす）', { timeout: 5000 }, () => {
  const sec = ek7Sec(read(fileOf('settings/hotkeys')), 'in-app');
  for (const k of ['Ctrl+Shift+N', 'Ctrl+Shift+U']) {
    const row = SHORTCUTS.find((r) => r.keys === k);
    assert.ok(row, `SHORTCUTS に ${k} が無い（このテストの前提が崩れた）`);
    assert.ok(tableRows(sec).some((r) => r[1] === `[[${k}]]` && r[2] === row.what), `${k} の行が SHORTCUTS と違う`);
  }
});

test('PH-8・BQ4・BQ6・RF60: 「録音中のページは動かせません」「新しい議事録はいちばん上にできます」「一緒に消した中のページも戻ります」「ゴミ箱のページは Claude に出ません」の字がある。「戻す画面はありません」は無い', { timeout: 5000 }, () => {
  const pt = read(fileOf('find/page-tree'));
  const del = read(fileOf('find/delete-and-backups'));
  for (const w of ['録音中のページは動かせません', '新しい議事録はいちばん上にできます']) assert.ok(pt.includes(w), `find/page-tree に「${w}」が無い`);
  for (const w of ['一緒に消した中のページも戻ります', 'ゴミ箱のページは Claude に出ません']) assert.ok(del.includes(w), `find/delete-and-backups に「${w}」が無い`);
  assert.ok(read(fileOf('start/claude-mcp')).includes('ゴミ箱のページは Claude に出ません'), 'start/claude-mcp に「ゴミ箱のページは Claude に出ません」が無い');
  assert.ok(!del.includes('戻す画面はありません'), '前の版の「戻す画面はありません」が残っている');
  // 検索の場所の行と、白紙のページも Claude から読めること（BQ8 (a)）
  assert.ok(read(fileOf('find/search')).includes('場所: '), 'find/search に場所の行が無い');
  assert.ok(read(fileOf('find/search')).includes('（白紙のページ）'), 'find/search に白紙のページの ToDo の印が無い');
  assert.ok(read(fileOf('start/claude-mcp')).includes('白紙のページ'), 'start/claude-mcp に白紙のページが無い');
  assert.ok(read(fileOf('start/overview')).includes('［ゴミ箱］'), 'start/overview に［ゴミ箱］が無い');
});

test('PH-8: 直した記事に Notion の名前が無い（ほかのアプリの名前と説明の文を写さない）', { timeout: 5000 }, () => {
  for (const ref of PH8_REFS) assert.ok(!/notion/i.test(read(fileOf(ref))), `${ref}: Notion の名前がある`);
});

// ---------------------------------------------------------------- 0.15.0 PH-8 直し（2026-11-04 の e235d8b..831ce7c の点検 rv31。計画の R69）
// PH-8 の記事が「…」で写した画面の文（確かめの文・知らせ・手引き・見出し）は、記事にその形であり、アプリのその文を作るコードの字（文字列の書き方のまま）にもある。
// PL-1・PH-8 直し 2（rv32。計画の R72）で意図して直した: 前は src/ の全部の文字（注を含む）に切れ端があるかを見ていたので、短い文（「戻しました」「## 本文」）は
// 注やほかの文に残った古い字で通ってしまった。今は文ごとに、作る所のファイルと、そこの文字列を決めて照らす。
// PL-2 直し（rv33 M3・計画の R75）で意図して直した: R72 は文字列の前後のコード（定数の名前・三項・呼ぶ所）まで照らしていたので、名前を替える・引用符を
// 替えるだけで赤になった。今は文字列そのものだけを照らす: q は引用符（' " ` のどれでも）で閉じた文字列（前後の字がちょうど引用符）・t は ` で閉じた
// 文字列の中身（${…} を含むそのまま）・h は id の要素の中の字
const PH8_QUOTES = [
  ['find/page-tree', 'ここに書く（/ で行の型を選べます）', [['src/renderer/app.html', 'q', 'ここに書く（/ で行の型を選べます）']]],
  ['find/page-tree', '無題のページ', [['src/renderer/app.html', 'q', '無題のページ']]],
  ['find/page-tree', '新しいページ', [['src/renderer/app.html', 'h', 'newPopHead', '新しいページ']]],
  ['find/page-tree', '録音中です', [['src/renderer/app.html', 'q', '録音中です']]],
  ['find/page-tree', 'ページ … 件をゴミ箱に入れました（Ctrl+Z で戻せます）', [['src/renderer/app.html', 't', 'ページ ${n} 件をゴミ箱に入れました（Ctrl+Z で戻せます）']]],
  ['find/page-tree', 'ページの行は複製できません', [['src/renderer/app.html', 'q', 'ページの行は複製できません']]],
  ['find/page-tree', 'このページの中のページ', [['src/renderer/app.html', 'q', 'このページの中のページ']]],
  ['find/delete-and-backups', 'この議事録を削除します。よろしいですか？', [['src/renderer/app.html', 'q', 'この議事録を削除します。よろしいですか？']]],
  ['find/delete-and-backups', 'このページをゴミ箱に入れます。よろしいですか？（ゴミ箱から戻せます）', [['src/renderer/app.html', 'q', 'このページをゴミ箱に入れます。よろしいですか？（ゴミ箱から戻せます）']]],
  ['find/delete-and-backups', 'このページと中のページ … 件をゴミ箱に入れます。よろしいですか？（ゴミ箱から戻せます）', [['src/renderer/app.html', 't', 'このページと中のページ ${n} 件をゴミ箱に入れます。よろしいですか？（ゴミ箱から戻せます）']]],
  ['find/delete-and-backups', '戻しました', [['src/renderer/app.html', 'q', '戻しました']]],
  ['find/delete-and-backups', 'このページの中のページ', [['src/renderer/app.html', 'q', 'このページの中のページ']]],
  ['find/search', '場所: 親 / 子 ・ ', [['src/renderer/app.html', 't', '場所: ${place} ・ ${s1.textContent}']]],
  ['find/search', '（白紙のページ）題名', [['src/renderer/app.html', 't', '（白紙のページ）${oneLine(x.pageTitle) || blankUntitled()}']]],
  ['start/claude-mcp', '（白紙のページ）題名', [['src/mcp/tools.js', 't', '（${F.BLANK_LABEL}）${F.titleLine({ title: a.pageTitle, kind: a.kind })}'], ['src/mcp/format.js', 'q', '白紙のページ']]],
  ['start/claude-mcp', '場所: 親 / 子', [['src/mcp/format.js', 't', '- 場所: ${place}']]],
  ['start/claude-mcp', '## 本文', [['src/mcp/format.js', 'q', '## 本文']]],
];
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 文字列そのものがコードにあるか（q: 引用符で閉じた文字列・t: ` の文字列・h: id の要素の字）
function hasLiteral(code, kind, a, b) {
  if (kind === 'q') return new RegExp(`(['"\`])${reEsc(a)}\\1`).test(code);
  if (kind === 't') return code.includes(`\`${a}\``);
  if (kind === 'h') return new RegExp(`\\bid="${reEsc(a)}"[^>]*>${reEsc(b)}<`).test(code);
  throw new Error(`知らない形 ${kind}`);
}
test('PH-8 直し（rv31）・PL-1・PH-8 直し 2（rv32）・PL-2 直し（rv33）: PH-8 の記事が「…」で写した画面の文は、記事にその形であり、その文を作るコードの文字列にもある（確かめの文・知らせを直すと記事も直す。名前や引用符を替えても赤にしない）', { timeout: 5000 }, () => {
  const src = new Map();
  const code = (f) => { if (!src.has(f)) src.set(f, read(f)); return src.get(f); };
  for (const [ref, quote, lits] of PH8_QUOTES) {
    assert.ok(read(fileOf(ref)).includes(`「${quote}」`), `${ref} に「${quote}」が無い`);
    for (const [f, kind, a, b] of lits) assert.ok(hasLiteral(code(f), kind, a, b), `${ref} の「${quote}」を作る文字列が ${f} に無い（画面の文を変えたら記事も直す）: ${a}`);
  }
  // 照らし方そのもの: 文字列の中の切れ端・注の字・閉じていない字では通らず、引用符の違いと前後の名前では落ちない
  assert.deepStrictEqual(['const A = "戻しました";', "x = '戻しました' + y", 'toast(`戻しました`)'].map((c) => hasLiteral(c, 'q', '戻しました')), [true, true, true]);
  assert.deepStrictEqual(["'既定に戻しました'", '// 戻しました', "'戻しました。'", "'戻しました\""].map((c) => hasLiteral(c, 'q', '戻しました')), [false, false, false, false]);
  assert.strictEqual(hasLiteral('toast(`ページ ${n} 件`)', 't', 'ページ ${n} 件'), true);
  assert.strictEqual(hasLiteral("'ページ ${n} 件'", 't', 'ページ ${n} 件'), false);
  // 白紙のページの2行目は日付だけ（R66）
  assert.ok(read(fileOf('find/search')).includes('白紙のページでは日付だけです'), 'find/search に白紙のページの2行目が日付だけなことが無い');
});

// ---------------------------------------------------------------- 0.15.0 PL-3（計画の Task PL-3・決めたこと 35〜42）: ページのアイコンと見た目の記事
test('PL-3: 記事 find/page-look の ［…］ はアプリにある文字だけで、updated は 2026-11-04 から。pre は使わない。site.json の find にあり、アイコンの選び・見た目の3つ・効く所・録音中の節がある', { timeout: 5000 }, () => {
  const app = L.appLabelText(ROOT);
  const a = articles.find((x) => x.ref === 'find/page-look');
  assert.ok(a, 'find/page-look の記事が無い');
  assert.deepStrictEqual(L.missingLabels(a.text, app), [], 'アプリに無い ［…］');
  assert.ok(metaOf(a).updated >= '2026-11-04');
  assert.ok(!/<pre|```/.test(a.text), 'pre の要素を使った');
  assert.ok(site.categories.find((c) => c.id === 'find').articles.includes('page-look'));
  for (const w of ['［全幅］', '［小さい文字］', '［書体 ▸］', '［外す］', '［最近使ったもの］', '標準・明朝・等幅', '{#icon}', '{#look}', '{#live}', '[[Esc]]', '約 500', '旗', 'Claude から読む答えには出ません', 'ほかのページには効きません', '録音中の会議のページでは、アイコンと見た目は変えられません']) {
    assert.ok(a.text.includes(w), `find/page-look に「${w}」が無い`);
  }
  assert.ok(!/notion/i.test(a.text), 'Notion の名前がある');
  // 記事の絵文字の一覧の分類は辞書の分類と同じ並び
  assert.ok(a.text.includes(`（${require('../src/emojiDict').CATS.map((c) => c.label).join('・')}）`), '分類の並びが辞書と違う');
});

// ---------------------------------------------------------------- 0.15.0 Task G（計画の Task G・R78）: README の「画面の使い方」・設計書の D の行と H1・H5・U3・notion-behavior の答え
test('0.15.0 Task G: README の「画面の使い方」にページの階層・新しいページ・ゴミ箱・アイコンと見た目の項目、近道に Ctrl+Shift+N・U。設計書に D115〜D123 と H1・H5・U3 の書き添え、notion-behavior の X-02・Q-16・Q-21 に答え', { timeout: 5000 }, () => {
  const readme = read('README.md');
  const use = readme.slice(readme.indexOf('### 画面の使い方'), readme.indexOf('\n### 音声入力'));
  for (const w of ['**ページの中のページ・白紙のページ（0.15.0 から）:**', '**新しいページ（0.15.0 から）:**', '**ゴミ箱（0.15.0 から）:**', '**ページのアイコンと見た目（0.15.0 から）:**',
    '［中にページを作る］', '［移動先…］', '`/ページ`', '「このページの中のページ」', '［📄 白紙のページ］', '［🎙️ 議事録（録音の前のページ）］', '［🗑️ ゴミ箱］', '［戻す］', '［最近使ったもの］', '［外す］', '［全幅］', '［小さい文字］', '［書体 ▸］']) {
    assert.ok(use.includes(w), `README の「画面の使い方」に「${w}」が無い`);
  }
  const app = read('src/renderer/app.html');
  for (const m of use.slice(use.indexOf('**ページの中のページ')).matchAll(/［([^］]+)］/g)) {
    const n = m[1].replace(/^[^\p{L}\p{N}]+\s*/u, '');
    assert.ok(app.includes(n), `README の［${m[1]}］がアプリに無い`);
  }
  const keys = readme.slice(readme.indexOf('### ホットキー'), readme.indexOf('\n## ', readme.indexOf('### ホットキー')));
  for (const k of ['`Ctrl+Shift+N`', '`Ctrl+Shift+U`']) assert.ok(keys.includes(k), `README のホットキーに ${k} が無い`);
  assert.ok(readme.includes('**白紙のページと中のページ（0.15.0 から）:**'), 'README の MCP の節に白紙のページが無い');
  const d = read('docs/plans/natsu-design.md');
  for (let n = 115; n <= 123; n++) assert.ok(new RegExp(`^\\| D${n} \\| \\*\\*`, 'm').test(d), `設計書に D${n} の行が無い`);
  // 0.16.0（計画 docs/plans/2026-11-04-160.md の「取り込みで確かめ直したこと（2026-11-07）」）で意図して直した: 前は設計書のどこにも D113・D114 の行が
  // 無いことを見ていた。0.15.0 を出した main を lane/160 に取り込むと、D113（0.16.0 の版の並び）の行がその道の節から入るので、0.15.0 の節
  // （D115〜D123）の中に D113・D114 が無いことを見る（意図「0.15.0 はほかの道の番号を使わない」は残す）
  // 0.15.1 Task G（計画の R55）で意図して直した: 前は設計書のどこにも D113・D114 の行が無いことを見ていた。0.15.1 の Task G で D114（音声入力を
  // なくす）の行がその道の節に入るので、0.15.0 の節（D115〜D123）の中に D113・D114 が無いことを見る（意図「0.15.0 はほかの道の番号を使わない」は残す）
  const at150 = d.indexOf('## 利用者が決めたこと（ページの階層・白紙のページ');
  const s150 = d.slice(at150, d.indexOf('\n## ', at150 + 5));
  assert.ok(at150 > 0 && s150.includes('| D115 |') && !/^\| D11[34] \|/m.test(s150), '設計書の 0.15.0 の節に D113・D114 の行がある（ほかの道で使う番号）');
  for (const [h, w] of [['H1', 'D117'], ['H5', 'D120'], ['U3', 'D121']]) {
    const row = d.split('\n').find((l) => l.startsWith(`| ${h} |`));
    assert.ok(row && row.includes(`0.15.0 で改めた: ${w}`), `設計書の ${h} に ${w} の書き添えが無い`);
  }
  assert.ok(d.includes('| 0.15.0（ページの階層とページのアイコン・見た目: `docs/plans/2026-11-03-150.md`'), '設計書の版の表の 0.15.0 の欄が前のまま');
  const nb = read('docs/plans/notion-behavior.md');
  for (const id of ['X-02', 'Q-16', 'Q-21']) {
    const row = nb.split('\n').find((l) => l.startsWith(`| ${id} |`));
    assert.ok(row && row.includes('（2026-11-03 の 0.15.0 の'), `notion-behavior の ${id} に答えが無い`);
  }
});

// ---------------------------------------------------------------- 0.15.1 Task G の前半（計画の Task G・「設計書の直し」・R55）: 設計書の D114・D124〜D126 と取り下げの印・notion-behavior
test('0.15.1 Task G: 設計書に D114・D124・D125・D126 の行（計画の「設計書の直し」の字のまま。D126 の確かめた所は緑の engine-smoke の run）・版の表の直しの版 0.15.1・U4 ほかの取り下げの印・やらないこと、notion-behavior の N-03〜N-10・Q-16・Q-24 にプライベートの分', { timeout: 5000 }, () => {
  const d = read('docs/plans/natsu-design.md');
  const plan = read('docs/plans/2026-11-04-151.md').split('\n');
  const pl = (head) => { const xs = plan.filter((l) => l.startsWith(head)); assert.equal(xs.length, 1, `計画に「${head}」の行が1つでない`); return xs[0]; };
  const row = (k) => { const xs = d.split('\n').filter((l) => l.startsWith(`| ${k} |`)); assert.equal(xs.length, 1, `設計書に ${k} の行が1つでない`); return xs[0]; };
  const decOf = (l) => l.slice(l.indexOf(':** 「') + 5, l.indexOf('」 | 設計書での形「'));
  // 決めたことの字は計画の「設計書の直し」のまま（D126 は日付の「〜」を「〜11-10」に閉じた）
  assert.ok(row('D114').startsWith(`| D114 | ${decOf(pl('- **新しい節「利用者が決めたこと（音声入力をなくす。2026-11-04）」と D114 の行:**'))} | U4・D108〜D111・C6・OF5 を取り下げた。`), 'D114 の行が計画の字と違う');
  assert.ok(row('D124').startsWith(`| D124 | ${decOf(pl('- **（第4版・第5版）D124 の行:**'))} | 見出し「議事録」は「プライベート」`), 'D124 の行が計画の字と違う');
  const l125 = pl('- **（第5版）D125 の行:**');
  assert.ok(row('D125').startsWith(`| D125 | ${l125.slice(l125.indexOf(':** 「') + 5, l125.indexOf('」。あわせて'))} | `), 'D125 の行が計画の字と違う');
  const dec126 = decOf(pl('- **（第6版・第7版・第9版）D126 の行')).replace(/2026-11-09〜）$/, '2026-11-09〜11-10）');
  const r126 = row('D126');
  assert.ok(r126.startsWith(`| D126 | ${dec126} | 取り込む文字起こしのエンジンは、whisper.cpp v1.9.5 を Vulkan 付きで`), 'D126 の行が計画の字と違う');
  assert.ok(/engine-smoke の run \d{11}）。本物の GPU では出す前に確かめていない（VQ8） \|$/.test(r126) && !r126.includes('<番号>'), 'D126 の確かめた所に engine-smoke の run の番号が無い');
  // 節の見出しと、版の表
  for (const h of ['## 利用者が決めたこと（音声入力をなくす。2026-11-04）', '## 利用者が決めたこと（PC の中の文字起こしを GPU 版に。2026-11-09）']) assert.ok(d.includes(`\n${h}\n`), `設計書に節「${h}」が無い`);
  assert.ok(d.includes('直しの版 0.15.1: 音声入力をなくす（D114: `docs/plans/2026-11-04-151.md`）・サイドバーの「プライベート」とライブラリ・行のメニューと名前を変える（D124・D125）・PC の中の文字起こしを GPU 版に（D126）） |'), '版の表の 0.15.0 の欄に直しの版 0.15.1 が無い');
  assert.ok(d.includes('\n（2026-11-04: 持ち主が音声入力をなくすと決めた（D114）。0.15.1 の直しの版で、1.0.0 の中身から音声入力を外した）\n'), '版の表の下の注が無い');
  // 取り下げの印（行は消さない）
  assert.ok(row('U4').includes('**（2026-11-04 の 0.15.1 で取りやめた: D114）**'), 'U4 に取りやめの印が無い');
  for (const k of ['C6', 'OF5', 'D108', 'D109', 'D110', 'D111']) assert.ok(row(k).includes('**取り下げ（2026-11-04・D114）**'), `${k} に取り下げの印が無い`);
  assert.ok(row('D110').includes('中継の整えの口は 2026-11-03 に上げた（P6）。0.15.1 からアプリは呼ばず、中継は変えない（WQ6）'), 'D110 に中継の添え書きが無い');
  for (const k of ['N2', 'N3', 'N5', 'RP7', 'RF21', 'RF9', 'SP2']) assert.ok(row(k).includes('0.15.1 で音声入力の分を取り下げ: D114'), `${k} に音声入力の分の取り下げが無い`);
  for (const k of ['RF9', 'SP2']) assert.ok(row(k).includes('0.15.1 から Esc はどの時も全体のホットキーにしない'), `${k} に Esc の添え書きが無い`);
  for (const k of ['RL16', 'RF41']) assert.ok(row(k).includes('（会議・音声入力。0.15.1 から会議だけ: D114）'), `${k} に会議だけの添え書きが無い`);
  for (const k of ['D21', 'OF1', '1d2']) assert.ok(row(k).includes('会議と音声入力（0.15.1 から会議だけ: D114）'), `${k} に会議だけの添え書きが無い`);
  for (const k of ['JS5', '`history.json`']) assert.ok(row(k).includes('0.15.1 から') && row(k).includes('ファイルは残す: D114'), `${k} に history.json の添え書きが無い`);
  assert.ok(row('JS6').includes('（0.15.1 で 30。'), 'JS6 にキーの数の添え書きが無い');
  assert.ok(d.includes('NaTsu の中の音声入力・口述（Windows の音声入力で代わる: D114）。'), 'やらないことに音声入力が無い');
  // D124・D125・D126 の書き添え
  assert.ok(row('L1').includes('2026-11-06 の D124・D125 で') && row('T2').includes('0.15.1 の D124・D125 で先にある') && row('TP3').includes('予定どおり 0.17.0 で入れる（おすすめ）'), 'L1・T2・TP3 の書き添えが無い');
  assert.ok(row('R7').includes('2026-11-09 の D126 で') && row('R7').includes('第0b回の計画の RF4 の照らし'), 'R7 の書き添えが無い');
  assert.ok(!row('RF4').includes('D126'), '設計書の RF4（スリープと復帰）に D126 の書き添えがある（計画の RF4 は第0b回の計画の RF4）');
  assert.ok(d.includes('- **自分たちで作ったエンジン（2026-11-09 の D126）:** 自分たちで作ったエンジン（GPU 版）は、手で押すワークフローが作った先行版の資産をピンで固定して配り、置き換えない。'), '試し方と配り方に自分たちで作ったエンジンの1行が無い');
  // notion-behavior
  const nb = read('docs/plans/notion-behavior.md');
  const nrow = (k) => nb.split('\n').find((l) => l.startsWith(`| ${k} |`)) || '';
  for (const k of ['N-03', 'N-04', 'N-05', 'N-06', 'N-09', 'N-10']) assert.ok(nrow(k).includes('0.15.1（D124・D125）'), `notion-behavior の ${k} にプライベートの分が無い`);
  assert.ok(!nrow('N-14').includes('0.15.1') && nrow('N-05').includes('セクションの上下の移動は 17 のまま'), 'N-05 の上下の移動・N-14 は 17 のまま');
  assert.ok(nrow('Q-16').includes('NaTsu は 0.15.1 で、リンクを写す・名前を変える・移動先・中にページを作る・新しいタブで開く・削除・最終更新にした（D124）'), 'notion-behavior の Q-16 に 0.15.1 の形が無い');
  assert.ok(nrow('Q-24').includes('出典 SB の頁に、見出しの横の矢印の印'), 'notion-behavior に見出しの矢印の印の Q が無い');
});

// ---------------------------------------------------------------- 0.15.0 最後の点検の直し（R80・2026-11-06 の a3f0925..707ad1e の点検）: 前の版で消した議事録もゴミ箱に並ぶ
test('R80: find/delete-and-backups と find/page-tree に、0.15.0 より前の版で消した議事録も［ゴミ箱］に並び戻せること、ゴミ箱を空にできないことがある', { timeout: 5000 }, () => {
  const del = articles.find((x) => x.ref === 'find/delete-and-backups');
  const restore = del.text.slice(del.text.indexOf('## ゴミ箱から戻す {#restore}'), del.text.indexOf('\n## ', del.text.indexOf('## ゴミ箱から戻す {#restore}') + 3));
  for (const w of ['0.15.0 より前の版で消した議事録も、［ゴミ箱］ に並びます', '200 まで', '［戻す］ で戻せます', 'ゴミ箱を空にすることはできません']) {
    assert.ok(restore.includes(w), `find/delete-and-backups の「ゴミ箱から戻す」に「${w}」が無い`);
  }
  assert.ok(metaOf(del).updated >= '2026-11-06');
  const tree = articles.find((x) => x.ref === 'find/page-tree');
  assert.ok(tree.text.includes('0.15.0 より前の版で消した議事録も ［ゴミ箱］ に並び、戻せます（[ゴミ箱から戻す](find/delete-and-backups.md#restore)）'), 'find/page-tree に前の版で消した議事録のことが無い');
  const app = L.appLabelText(ROOT);
  for (const a of [del, tree]) assert.deepStrictEqual(L.missingLabels(a.text, app), [], `${a.ref}: アプリに無い ［…］`);
  // CHANGELOG の 0.15.0 の節にも、持ち主が承認した文がそのまま
  assert.ok(read('CHANGELOG.md').includes('今までに消した議事録も［ゴミ箱］に並び、戻せます。'), 'CHANGELOG に前の版で消した議事録の文が無い');
});

// ---------------------------------------------------------------- 0.15.1 ND-4（計画 docs/plans/2026-11-04-151.md の F155・RF51・WQ4・D114）: 音声入力をなくした後のヘルプと案内
// 画面とヘルプの文の版の数字（「並べて作る決まり」の 3: 0.16.0 が先に出たら G でここだけを 0.16.1 にする）
const VER_151 = '0.15.1';
// 音声入力の語を書いてよい記事: Win+H の案内（dictation/dictation）と、中継の上限の「0.15.0 までのアプリ」の注（口述の整え）
const DICT_OK = ['dictation/dictation', 'admin/relay-limits'];
test('ND-4・F155: 音声入力の語は案内の記事だけ。ほかの記事に「口述」「Ctrl+Shift+Space」が無く、「音声入力」は「Windows の音声入力」の字の中にしか無い', { timeout: 5000 }, () => {
  for (const a of articles) {
    if (a.ref === 'dictation/dictation') continue;
    const body = a.text.replace(/Windows の音声入力/g, '');
    if (a.ref !== 'admin/relay-limits') {
      assert.ok(!a.text.includes('口述'), `${a.ref} に「口述」`);
      assert.ok(!a.text.includes('Ctrl+Shift+Space'), `${a.ref} に Ctrl+Shift+Space`);
    }
    assert.ok(!body.includes('音声入力'), `${a.ref} に「Windows の音声入力」のほかの「音声入力」: ${(body.match(/.{0,30}音声入力.{0,30}/) || [''])[0]}`);
    assert.ok(!/dictation\.md#/.test(a.text), `${a.ref} が案内の記事の消えた節を指す`);
  }
  assert.deepStrictEqual(DICT_OK.filter((r) => !refs.includes(r)), []);
});
test('ND-4・F155・RF51: 記事の ［…］ の言葉は、今の画面に見える字（app.html の注釈と <style> の外・main.js の注釈の外）にちょうどある', { timeout: 10000 }, (t) => {
  const seen = L.seenLabelText(ROOT);
  const bad = articles.flatMap((a) => L.missingLabels(a.text, seen).map((m) => `${a.file}:${m.line} ［${m.label}］`));
  assert.deepStrictEqual(bad, [], '今の画面に見えない ［…］ がある（注釈・凍結の録音バー・ほかのファイルの字だけで通っていた）');
  // 照らしの元は注釈を数えない（決まった小さな src/ で見る）
  const dir = tmpDir(t, 'nd4-seen-');
  {
    fs.mkdirSync(path.join(dir, 'src', 'renderer'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'renderer', 'app.html'), '<html><!-- ［注釈だけの字A］ --><style>/* 字B */</style><body><button>見える字C</button>\n<script>\n  // ［注釈だけの字D］\n  b.textContent = \'見える字E\';   // 注釈だけの字F\n  /* 注釈だけの字G */\n  //（［注釈だけの字K］）\n</script></body></html>\n');
    fs.writeFileSync(path.join(dir, 'src', 'main.js'), "// 注釈だけの字H\nconst t = '見える字I';   // 注釈だけの字J\nconst u = 'https://example.invalid/x';\n");
    const seen2 = L.seenLabelText(dir);
    for (const w of ['見える字C', '見える字E', '見える字I', 'https://example.invalid/x']) assert.ok(seen2.includes(w), `${w} を数えない`);
    // ND-4 直し（R13）: 「//」のすぐ後に字が続く注釈（「//（…」）も数えない
    for (const w of ['注釈だけの字A', '字B', '注釈だけの字D', '注釈だけの字F', '注釈だけの字G', '注釈だけの字H', '注釈だけの字J', '注釈だけの字K']) assert.ok(!seen2.includes(w), `${w} を数えた`);
    assert.deepStrictEqual(L.missingLabels('［注釈だけの字K］', seen2).map((m) => m.label), ['注釈だけの字K'], '「//（…」の注釈だけにある言葉を見えると数えた');
  }
});
test('ND-4・F155・WQ4: 案内の記事 dictation/dictation は Win+H の案内（題・[[Win+H]]・出典の住所2つ・Microsoft へ送られる・言い切らない・前の履歴の置き場所）', { timeout: 5000 }, () => {
  const a = articles.find((x) => x.ref === 'dictation/dictation');
  const meta = metaOf(a);
  assert.strictEqual(meta.title, '音声入力（Windows の音声入力を使う）');
  assert.ok(meta.description.startsWith(`NaTsu の音声入力は ${VER_151} でなくなりました。`), meta.description);
  assert.ok(a.text.includes('[[Win+H]]'));
  for (const u of ['https://support.microsoft.com/ja-jp/accessibility/windows/use-voice-typing-to-talk-instead-of-type-on-your-pc',
    'https://support.microsoft.com/ja-jp/windows/privacy/speech-voice-activation-inking-typing-and-privacy']) assert.ok(a.text.includes(`(${u})`), `出典 ${u} が無い`);
  assert.ok(a.text.includes('Microsoft へ送られます'));
  for (const w of ['保存されません', '残りません', '送られません']) assert.ok(!a.text.includes(w), `言い切り「${w}」`);
  assert.ok(a.text.includes('NaTsu と会社の文字起こしの中継（音声を OpenAI へ取り次ぐ NaTsu のサーバー）は通りません'));
  for (const w of ['`history.json`', '［データ保存先を開く］', '`dictwait`', 'NaTsu は読まず、消しません']) assert.ok(a.text.includes(w), `「${w}」が無い`);
  for (const id of ['windows', 'privacy', 'history']) assert.ok(new RegExp(`^## .+ \\{#${id}\\}$`, 'm').test(a.text), `節 #${id} が無い`);
  // 分類「音声入力」は残し、説明を替える（WQ4）
  const cat = site.categories.find((c) => c.id === 'dictation');
  assert.ok(cat && cat.title === '音声入力' && cat.articles.join() === 'dictation');
  assert.strictEqual(cat.description, `NaTsu の音声入力は ${VER_151} でなくなりました。代わりに Windows の音声入力を使う`);
});
test('ND-4: 案内の頭の文（README の1行目・package.json の説明・ヘルプのホームの頭の文）に「音声入力」が無い。INSTALL の近道に Ctrl+Shift+Space が無い', { timeout: 5000 }, () => {
  const readme = read('README.md').replace(/\r\n?/g, '\n').split('\n');
  const first = readme.find((l, i) => i > 0 && l.trim() && !l.startsWith('#'));
  assert.ok(first.startsWith('議事録ツール。'), first);
  assert.ok(!JSON.parse(read('package.json')).description.includes('音声入力'));
  assert.ok(JSON.parse(read('package.json')).description.startsWith('NaTsu — 議事録ツール（'));
  const home = read('tools/lib/help-page.js');
  assert.ok(home.includes('NaTsu（会議の録音・文字起こし・要約のアプリ）の使い方を、分類ごとにまとめています。'));
  assert.ok(!/<p class="lede">[^<]*音声入力/.test(home), 'ヘルプのホームの頭の文に音声入力');
  assert.ok(!read('INSTALL.md').includes('Ctrl+Shift+Space'), 'INSTALL に Ctrl+Shift+Space');
  // README の「データ保存先」の history.json の行は残し、読み書きしないと書く（NR8）
  assert.ok(read('README.md').includes('history.json           0.15.0 までの音声入力の履歴（0.15.1 からは読み書きしない。消さずに残す）'));
});

// ---------------------------------------------------------------- 0.15.1 ND-4 直し（2026-11-07 の 0684d09..f48abca の点検・計画の R13）
test('ND-4 直し: README の「何がどこへ送られるか」の表に、今の動きとしての口述の整えが無い（0.15.0 までのアプリだけと書く）。管理者の手順の整えの欄と /v1/text/tidy の手順にも同じ注', { timeout: 5000 }, () => {
  const r = read('README.md');
  const at = r.indexOf('| 送り先 | 送るもの | 費用 | 保存の扱い |');
  assert.ok(at > 0, '送り先の表が無い');
  const table = r.slice(at, r.indexOf('\n\n', at));
  for (const row of table.split('\n').filter((l) => l.includes('口述'))) {
    for (const m of row.matchAll(/[^|・、（）]*口述[^|・、（）]*/g)) {
      const around = row.slice(Math.max(0, m.index - 2), m.index + m[0].length + 40);
      assert.ok(/0\.14\.0 から 0\.15\.0 までのアプリだけ/.test(around), `送り先の表の口述が今の動きに読める: ${m[0]}`);
    }
  }
  const note = '0.15.0 までのアプリだけ';
  const tidyCfg = r.split('\n').find((l) => l.includes('`TIDY_MODEL` … 整えに使う'));
  assert.ok(tidyCfg && tidyCfg.includes(note), `管理者の手順の整えの欄に「${note}」が無い`);
  const deploy = r.split('\n').find((l) => l.includes('/v1/text/tidy'));
  assert.ok(deploy && deploy.includes(note), `中継を出す手順の /v1/text/tidy に「${note}」が無い`);
});
test('ND-4 直し: README の「データ保存先」は、［データ保存先を開く］で開くのが data のフォルダだと書き、0.15.0 までの音声入力の音声（data の dictwait）も挙げる（案内の記事と同じ言い方）', { timeout: 5000 }, () => {
  const r = read('README.md');
  const sec = r.slice(r.indexOf('\n## データ保存先'), r.indexOf('\n### 議事録の保存の形'));
  assert.ok(/^  dictwait\/ +0\.15\.0 までの音声入力で、文字にする前に残した音声（0\.15\.1 からは読み書きしない。消さずに残す）$/m.test(sec), 'data の dictwait の行が無い');
  assert.ok(sec.includes('「データ保存先を開く」で開くのは `data\\` のフォルダです'), '［データ保存先を開く］で開くフォルダが data だと書いていない');
  assert.ok(!sec.includes('設定画面の「データ保存先を開く」からエクスプローラーで開けます。'), '前の「このフォルダを開ける」と読める文が残っている');
  // 0.15.1 ND-3 直し（2026-11-07 の f48abca..fe77164 の点検）: バックアップの文は data のフォルダの文の後に来るので、「このフォルダ」でなく写す物を名指す
  assert.ok(!sec.includes('バックアップはこのフォルダをコピーするだけです'), 'バックアップの文が「このフォルダ」のまま（data のフォルダだけと読める）');
  assert.ok(sec.includes('バックアップは `%APPDATA%\\natsu\\` のフォルダ（`data\\` と、その1つ上の `settings.json`・`history.json`）をコピーするだけです'), 'バックアップで写す物を名指していない');
});
test('ND-4 直し: 案内の記事 dictation/dictation の Win+H の手順は Windows 11 の画面で書いたと断る', { timeout: 5000 }, () => {
  const a = articles.find((x) => x.ref === 'dictation/dictation');
  const sec = a.text.slice(a.text.indexOf('{#windows}'), a.text.indexOf('\n## ', a.text.indexOf('{#windows}')));
  assert.ok(sec.includes('（Windows 11 の画面で書いています）'), sec);
});

// ---------------------------------------------------------------- 0.15.1 GV-4（計画 docs/plans/2026-11-04-151.md の Task GV-4・F174・D126）: GPU 版の組のヘルプと案内
// 第9版の字（「持ち主への問い（第9版）」の「第9版で変えた文」の 4〜7 と、第8版で承認したまま変わらない文）。節は「PC の中で文字起こしするとき {#when}」の後ろ（記事の終わり）
const GPU_SEC_151 = [
  '## GPU で文字起こしする {#gpu}',
  '',
  `${VER_151} から、取り込む文字起こしのエンジンは GPU（Vulkan）で計算できる版になりました。PC の中で文字起こしをするとき（つながっていないとき・［オフラインモード］の会議・中継が使えないとき）は、PC の GPU（Intel Iris Xe など）で計算します。CPU だけで計算するより、文字になるのが速く、PC が重くなりにくい見込みです。`,
  '',
  '- GPU を使えない PC では、同じエンジンが CPU で計算します。知らせは出しません。GPU と CPU のどちらで計算したかは、理由の記録（%APPDATA%\\natsu\\engine.log）の「文字起こしの計算:」の行で分かります。',
  '- GPU で文字起こしのエンジンが止まったときや起動しないときは、ほかの理由でエンジンが起動しないときと同じです。その区間の音声は「文字起こし待ち」として残り、つながったときにクラウドで文字にします（［オフラインモード］ の会議は、PC の中で文字起こしできるようになってから）。',
  '- 前の版で取り込んだ PC は、起動したときに新しいエンジン（約 20MB）だけを取り込みます（［一時停止］ しているときと、議事録の記録中は取り込みません）。取り込み終わるまでは前のエンジンで文字起こしをし、切り替えた後に前のエンジンを消します。',
  '- 詳細設定にエンジンのパスを手で入れている PC は、今までどおりそのエンジンを使います。',
].join('\n');
test('GV-4・F174: settings/offline.md の節 #gpu は「PC の中で文字起こしするとき」の後ろ（記事の終わり）に第9版の字で。CPU の形への切り替え・ドライバの印・無くなった CPU 版・言い切りの語が無い。説明は変えない', { timeout: 5000 }, () => {
  const t = read('help/articles/settings/offline.md');
  const at = t.indexOf('\n## GPU で文字起こしする {#gpu}\n');
  const when = t.indexOf('\n## PC の中で文字起こしするとき {#when}\n');
  assert.ok(when > 0 && at > when, '節 #gpu が「PC の中で文字起こしするとき」の後ろに無い');
  assert.strictEqual(t.indexOf('\n## ', at + 5), -1, '節 #gpu が記事の終わりでない');
  const sec = t.slice(at + 1).replace(/\s+$/, '');
  assert.strictEqual(sec, GPU_SEC_151);
  for (const s of ['GPU を使えない PC では、同じエンジンが CPU で計算します。', '知らせは出しません。', 'engine.log', '文字起こしの計算:', '文字起こし待ち', '約 20MB',
    '詳細設定にエンジンのパスを手で入れている PC は、今までどおりそのエンジンを使います。', '見込みです']) {
    assert.ok(sec.includes(s), `#gpu に「${s}」が無い`);
  }
  assert.ok(!/CPU で計算する形に切り替え|ドライバが更新されると|CPU 版|必ず|確実に|倍速/.test(sec), '無くなった切り替え・印・CPU 版・言い切りの語がある');
  const meta = t.slice(0, t.indexOf('\n---', 4));
  assert.ok(meta.includes('\ndescription: ［設定］の「ローカル AI」で、PC の中の文字起こしのエンジンを取り込む（任意）。取り込まないときの動きと、使えるかの確かめ方。要約は Claude Code だけ\n'), '説明（description）を変えた');
  // 記事の最初の「中継」は #when の決まった一言のまま（HD-8）
  const first = plainBody(t).indexOf('中継');
  assert.ok(first > 0 && t.slice(first + 2).startsWith(TERM_NOTES['中継']), '記事の最初の「中継」の後に決まった一言が無い');
  // 取り込みと更新の記事から節へのリンク
  assert.ok(read('help/articles/start/install-update.md').includes(`エンジンを取り込みます（約 0.6GB）。（${VER_151} から GPU で計算できる版。[GPU で文字起こしする](settings/offline.md#gpu)）`));
});
test('GV-4・F174: INSTALL と README（取り込むエンジンは GPU（Vulkan）で計算できる版・GPU を使えない PC では同じエンジンが CPU で計算・Visual C++ ランタイムを使わない。手で入れる節に書き足さない。約 0.6GB と vc_redist は残る）', { timeout: 5000 }, () => {
  const ins = read('INSTALL.md');
  for (const s of [
    `- **管理者の権限は要りません。** ${VER_151} から、ローカル AI で取り込むエンジンは Visual C++ ランタイムを使いません\n  （詳細設定に手で入れたエンジンを使うときだけ、情報システムの担当が入れます。下の「Visual C++ ランタイム」）。`,
    '- **かかるもの:** 約 0.6GB の取り込み（ディスクの空き 約 1GB）と、その時間（50Mbps で約 2 分、10Mbps で約 8 分）。\n  PC の中の文字起こしは、クラウドより精度が落ちます。',
    `- 取り込むのは、文字起こしのエンジン（whisper.cpp。${VER_151} から GPU（Vulkan）で計算できる版）・文字起こしのモデル・VAD のモデルです。合わせて約 0.6GB です。GPU を使えない PC では、同じエンジンが CPU で計算します（どちらで計算したかは \`engine.log\` に1行）。`,
    `詳細設定に手で入れた文字起こしのエンジン（下の「手で入れる」のスクリプトの whisper.cpp）は、Microsoft Visual C++ ランタイムを使います。\nNaTsu には入っていません。${VER_151} から［ローカル AI を使う］で取り込むエンジンは使いません（C/C++ の実行の部品を中に持ち、OpenMP の \`vcomp140.dll\` を同梱しています。Vulkan の部品 \`vulkan-1.dll\` は同梱せず、GPU のドライバの物を使います）。`,
    '- 手で入れたエンジンで入っていない・古いときは、NaTsu が記録（`engine.log`）に1行残します（止めはしません）。',
    'https://aka.ms/vc14/vc_redist.x64.exe']) {
    assert.ok(ins.includes(s), `INSTALL に「${s}」が無い`);
  }
  assert.ok(!ins.includes('Visual C++ ランタイムが要ります（下の「Visual C++ ランタイム」）。'), 'かかるものにランタイムが残っている');
  assert.ok(!ins.includes('NaTsu が［設定］→［ローカル AI］に案内を出します（取り込む前にも出ます）'), '取り込む前の案内が残っている');
  assert.ok(!/CPU で計算する形に切り替え|ここで入れたエンジンのパスを詳細設定に入れると/.test(ins), '無くなった切り替え・手で入れる節の書き足し（VQ14 (a)）がある');
  assert.ok(ins.includes('詳細設定にパスを入れた側は、アプリで取り込んだエンジンより、そちらが使われます。\n'), '手で入れる節の文が変わった');
  // rv52 の軽い 1（2026-11-10 の持ち主の答え「2行に分ける（おすすめ）」・R52）: 困ったときの［PC の中で試す］・［起動テスト］の行を、手で入れたときと取り込んだエンジンで分ける
  const rows = [
    '| （手で入れたとき）［PC の中で試す］・［起動テスト］が失敗する | 情報システムの担当に Visual C++ ランタイムを入れてもらう（上の「Visual C++ ランタイム」） |',
    '| （取り込んだエンジンで）［PC の中で試す］・［起動テスト］が失敗する | 記録（`%APPDATA%\\natsu\\engine.log`）を情報システムの担当に渡す |',
  ];
  assert.ok(ins.includes(`\n${rows.join('\n')}\n`), '困ったときの［PC の中で試す］・［起動テスト］の2行が無い');
  assert.ok(!ins.includes('\n| ［PC の中で試す］・［起動テスト］が失敗する |'), '困ったときに限りの無い［PC の中で試す］・［起動テスト］の行が残っている');
  const rd = read('README.md');
  assert.ok(rd.includes(`\n${VER_151} から、取り込む文字起こしのエンジンは GPU（Vulkan）で計算できる版（NaTsu の CI が whisper.cpp を Vulkan 付きで作った物）で、GPU を使えない PC では同じエンジンが CPU で計算します（[ヘルプ](help/articles/settings/offline.md)）。\n`));
  assert.ok(rd.includes('文字起こしの whisper.cpp（MIT）をローカル実行しています（取り込むエンジンは、whisper.cpp を Vulkan 付きで NaTsu の CI が作った物。Vulkan の部品は GPU のドライバの物を使い、同梱しません。要約は各自の Claude Code）。'));
  assert.ok(!rd.includes('CPU で計算する形で続けます'), 'README に第8版の文が残っている');
});

// ---------------------------------------------------------------- 0.16.0 DH-1（計画 docs/plans/2026-11-04-160.md の Task DH-1・R119 (b)）
// データベース（表とリスト・ビュー・列・消した列・リレーション・サブアイテム・インラインとリンクドビュー・行のページ・表のキー・上限）の記事と、
// 直した記事（ページの中のページ・検索・ゴミ箱・ホットキー・Claude から読む・全体像）。承認済みの文は字のまま（R107 の2つ・R71 (3)）
const DH1_REFS = ['find/database', 'find/page-tree', 'find/search', 'find/delete-and-backups', 'settings/hotkeys', 'start/claude-mcp', 'start/overview'];
const DH1_DB_KEYS = ['データベースの表のセルを選んでいるとき', 'ビューのタブを選んでいるとき', 'リレーションの行を探す窓'];
test('DH-1: 直した記事の ［…］ はアプリにある文字だけで、updated は 2026-11-13 から。pre は使わない。site.json の find の page-tree の次に database があり、説明に「データベース」。HELP_ARTICLES も同じ並び', { timeout: 5000 }, () => {
  const app = L.appLabelText(ROOT);
  for (const ref of DH1_REFS) {
    const a = articles.find((x) => x.ref === ref);
    assert.ok(a, `${ref} の記事が無い`);
    assert.deepStrictEqual(L.missingLabels(a.text, app), [], `${ref}: アプリに無い ［…］`);
    assert.ok(metaOf(a).updated >= '2026-11-13', `${ref}: updated を直した日にしていない`);
    assert.ok(!/<pre|```/.test(a.text), `${ref}: pre の要素を使った`);
  }
  const find = site.categories.find((c) => c.id === 'find');
  assert.strictEqual(find.articles[find.articles.indexOf('page-tree') + 1], 'database', 'site.json の find の page-tree の次に database が無い');
  assert.ok(find.description.includes('データベース'), 'find の説明に「データベース」が無い');
  assert.ok(read('src/mainlib.js').includes("'find/page-tree', 'find/database', 'find/page-look'"), 'HELP_ARTICLES に find/database が無い');
  const db = read(fileOf('find/database'));
  for (const id of ['create', 'table', 'views', 'sort-filter', 'columns', 'gone', 'relation', 'subitems', 'inline', 'row', 'keys', 'limits']) assert.ok(db.includes(`{#${id}}`), `find/database に {#${id}} の節が無い`);
  for (const w of ['［🗃️ データベース］', '［中にデータベースを作る］', '/データベース', '/リンクドビュー', '［＋ 新しい行］', '［列の値を変える ▸］', '［並べ替えを足す］', '［条件を足す］', '［空のグループを隠す］', '［消した列］', '［完全に消す］', '［新しい行を作ってつなぐ］', '［サブアイテム］', '［サブアイテムを足す］', '［ページの行に変える］', '［インラインにする］', '［新しい表から始める］', '[[Alt+→]]', '[[Space]]']) {
    assert.ok(db.includes(w), `find/database に ${w} が無い`);
  }
  // 直した記事に新しい働き
  assert.ok(read(fileOf('find/page-tree')).includes('［中にデータベースを作る］') && read(fileOf('find/page-tree')).includes('［🗃️ データベース］'), 'find/page-tree にデータベースを作る道が無い');
  assert.ok(read(fileOf('find/page-tree')).includes('データベースの中へページを入れることはできません'), 'find/page-tree にデータベースの中へ入れないことが無い');
  assert.ok(read(fileOf('find/page-tree')).includes('サイドバーと本文の間'), 'find/page-tree にサイドバーと本文の間の引っ張りが無い');
  assert.ok(read(fileOf('start/overview')).includes('](find/database.md)'), 'start/overview から find/database へのリンクが無い');
});

test('DH-1: find/database の近道の表は、データベースの3つの効く所の SHORTCUTS と一字ずつ同じ（並びも）', { timeout: 5000 }, () => {
  const got = tableRows(ek7Sec(read(fileOf('find/database')), 'keys'));
  const want = SHORTCUTS.filter((r) => DH1_DB_KEYS.includes(r.where)).map((r) => [r.where, keyCell(r.keys), r.what]);
  assert.ok(want.length >= 15, 'SHORTCUTS にデータベースの行が少ない（このテストの前提が崩れた）');
  assert.deepStrictEqual(got, want, 'find/database の近道の表が SHORTCUTS と違う（src/shortcuts.js の表を写す）');
});

test('DH-1（R71 (3)・R107）: 承認済みの3つの文が字のまま。「1つのデータベースの行は 10,000 まで」「消した列は戻せます」「計算式とロールアップは後の版」の字がある。Claude からの絞り込みは後の版', { timeout: 5000 }, () => {
  const db = read(fileOf('find/database'));
  for (const w of [
    '完全に消した列の値は、操作の記録と控えを整理するまで、NaTsu のデータの中にしばらく残ります。',   // R71 (3)
    'リンクドビューやインラインの表の列のメニューで［削除］した列は、元のデータベースから消えます（ほかのビューやリンクドビューからも消えます）。［ビューの設定］の［消した列］から戻せます。そのビューで見せたくないだけなら［隠す］を使います（隠すのはそのビューだけです）。',   // R107
    'リンクドビューで変えた列と題名は、元のデータベースの Ctrl+Z で戻せます。リンクドビューのタブ（並べ替えや絞り込み）は、そのリンクドビューだけのものです。',   // R107
    '1つのデータベースの行は 10,000 まで', '消した列は戻せます', '計算式とロールアップは後の版',
  ]) assert.ok(db.includes(w), `find/database に「${w}」が無い`);
  const mcp = read(fileOf('start/claude-mcp'));
  assert.ok(mcp.includes('{#database}') && mcp.includes('後の版'), 'start/claude-mcp にデータベースの節と、絞り込みは後の版が無い');
});

// 記事が「…」で写した画面の文は、記事にその形であり、その文を作るコードの文字列にもある（PH-8 直しの hasLiteral と同じ照らし）
const DH1_QUOTES = [
  ['find/database', '無題のデータベース', [['src/renderer/app.html', 'q', '無題のデータベース']]],
  ['find/database', '名前', [['src/db/commands.js', 'q', '名前']]],
  ['find/database', '並べ替えを外すと、手で並べられます', [['src/renderer/app.html', 'q', '並べ替えを外すと、手で並べられます']]],
  ['find/database', '行 … 件をゴミ箱に入れました（Ctrl+Z で戻せます）', [['src/renderer/app.html', 't', '行 ${n} 件をゴミ箱に入れました（Ctrl+Z で戻せます）']]],
  ['find/database', 'ビューを足す', [['src/renderer/app.html', 'q', 'ビューを足す']]],
  ['find/database', '他 … 件', [['src/renderer/app.html', 't', '他 ${st.hiddenViews.length} 件']]],
  ['find/database', 'この中を探す', [['src/renderer/app.html', 'q', 'この中を探す']]],
  ['find/database', 'ビュー『名前』を削除します。並べ替えや絞り込みの設定も消えます。行は消えません。', [['src/renderer/app.html', 't', 'ビュー『${name}』を削除します。並べ替えや絞り込みの設定も消えます。行は消えません。']]],
  ['find/database', 'この列の値として読めませんでした。', [['src/renderer/app.html', 'q', 'この列の値として読めませんでした。']]],
  ['find/database', '種類を変えると、… 個の値が読めずに空になります。よろしいですか？（Ctrl+Z で戻せます）', [['src/renderer/app.html', 't', '種類を変えると、${n} 個の値が読めずに空になります。よろしいですか？（Ctrl+Z で戻せます）']]],
  ['find/database', 'この列と、すべての行のこの列の値を完全に消します。元に戻せません。よろしいですか？', [['src/renderer/app.html', 'q', 'この列と、すべての行のこの列の値を完全に消します。元に戻せません。よろしいですか？']]],
  ['find/database', 'つなぐデータベース', [['src/renderer/app.html', 'q', 'つなぐデータベース']]],
  ['find/database', '相手のデータベースにも列を作る', [['src/renderer/app.html', 'q', '相手のデータベースにも列を作る']]],
  ['find/database', '行を探す', [['src/renderer/app.html', 'q', '行を探す']]],
  ['find/database', '親アイテム', [['src/db/commands.js', 'q', '親アイテム']]],
  ['find/database', 'その行の中へは入れられません', [['src/renderer/app.html', 'q', 'その行の中へは入れられません']]],
  ['find/database', '元のビューを写す', [['src/renderer/app.html', 'q', '元のビューを写す']]],
  ['find/database', 'リンクドビューは複製できません', [['src/renderer/app.html', 'q', 'リンクドビューは複製できません']]],
  ['find/database', '（このデータベースは見られません）', [['src/renderer/app.html', 'q', '（このデータベースは見られません）']]],
  ['find/database', '1つのデータベースの行は 10,000 までです。', [['src/renderer/app.html', 'q', '1つのデータベースの行は 10,000 までです。']]],
  ['find/database', '列は 100 までです。', [['src/renderer/app.html', 'q', '列は 100 までです。']]],
  ['find/database', 'ビューは 20 までです。', [['src/renderer/app.html', 'q', 'ビューは 20 までです。']]],
  ['find/database', '1回に貼れるのは 2,000 個の値までです。', [['src/renderer/app.html', 'q', '1回に貼れるのは 2,000 個の値までです。']]],
  ['find/database', '1つのページに置けるデータベースの表は 10 までです。', [['src/renderer/app.html', 'q', '1つのページに置けるデータベースの表は 10 までです。']]],
  ['find/database', '新しいページ', [['src/renderer/app.html', 'h', 'newPopHead', '新しいページ']]],
  ['find/search', '場所: 🗃️ データベース名 ・ ', [['src/renderer/app.html', 't', "場所: 🗃️ ${oneLine(p.dbTitle) || '無題のデータベース'} ・ ${s1.textContent}"]]],
  ['find/delete-and-backups', 'このデータベースと行 … 件をゴミ箱に入れます。よろしいですか？（ゴミ箱から戻せます）', [['src/renderer/app.html', 't', 'このデータベースと行 ${n} 件をゴミ箱に入れます。よろしいですか？（ゴミ箱から戻せます）']]],
  ['find/delete-and-backups', '行 題名（データベース名）', [['src/renderer/app.html', 't', "行 ${name}（${oneLine(h.dbTitle) || '無題のデータベース'}）"]]],
  ['find/delete-and-backups', 'ほかの行 …', [['src/renderer/app.html', 't', '・ほかの行 ${n}']]],
  ['start/claude-mcp', 'データベース（行 …）', [['src/mcp/format.js', 't', 'データベース（行 ${Number(n) || 0}）']]],
  ['start/claude-mcp', '## 列', [['src/mcp/format.js', 'q', '## 列']]],
  ['start/claude-mcp', '## 行', [['src/mcp/format.js', 'q', '## 行']]],
  ['start/claude-mcp', '行は NaTsu で見てください（Claude からの絞り込みは 0.18.0 の道具で）', [['src/mcp/format.js', 'q', '行は NaTsu で見てください（Claude からの絞り込みは 0.18.0 の道具で）']]],
];
test('DH-1: 記事が「…」で写した画面の文は、記事にその形であり、その文を作るコードの文字列にもある（知らせ・確かめの文を直すと記事も直す）', { timeout: 5000 }, () => {
  const src = new Map();
  const code = (f) => { if (!src.has(f)) src.set(f, read(f)); return src.get(f); };
  for (const [ref, quote, lits] of DH1_QUOTES) {
    assert.ok(read(fileOf(ref)).includes(`「${quote}」`), `${ref} に「${quote}」が無い`);
    for (const [f, kind, a, b] of lits) assert.ok(hasLiteral(code(f), kind, a, b), `${ref} の「${quote}」を作る文字列が ${f} に無い（画面の文を変えたら記事も直す）: ${a}`);
  }
});

test('DH-1: 直した記事に Notion の名前が無い（ほかのアプリの名前と説明の文を写さない）', { timeout: 5000 }, () => {
  for (const ref of DH1_REFS) assert.ok(!/notion/i.test(read(fileOf(ref))), `${ref}: Notion の名前がある`);
});

// 0.16.0 R120 (c)（MQ3・M19。2026-11-13 の持ち主の答え「［＋］に5つを足す（おすすめ）」）: 列の種類の表に5行（右端の［＋］の末の並びと同じ順）
test('R120 (c)・MQ3: find/database の列の種類の表に［作成日時］［作成者］［最終更新日時］［最終更新者］［ID］の5行（［リレーション］の後ろ・［＋］の並びの順）。この5つへ・からは変えられない', { timeout: 5000 }, () => {
  const db = read(fileOf('find/database'));
  const rows = tableRows(ek7Sec(db, 'columns')).map((r) => r[1]);
  assert.deepStrictEqual(rows.slice(-6), ['［リレーション］', '［作成日時］', '［作成者］', '［最終更新日時］', '［最終更新者］', '［ID］']);
  assert.ok(ek7Sec(db, 'columns').includes('［作成日時］・［作成者］・［最終更新日時］・［最終更新者］・［ID］へ・から変えることもできません。'), '5つの種類へ・から変えられないことが無い');
});

// 0.16.0 R122（rv55 軽い 6・7・8）: 記事の文をコードに合わせた。行のチェックはいつも出ていて、全部を選ぶチェックは見出しの行の頭（題名の列の見出しでない）。
// 並べ替えの空の値は最後だが、チェックの列は昇順でチェックの無い行が先（src/dbView.js の compareCells）。ページを動かしたのは Ctrl+Z で戻らないが、
// もう本文に行のあるページをその本文へ落としたときは本文の行の block.move（R49）で戻せる
test('R122・rv55 軽い 6・7・8: find/database の行の選び（行の頭のチェック・表の見出しの行の頭のチェック）・並べ替えのチェックの列・find/page-tree の Ctrl+Z で戻る引っ張り', { timeout: 5000 }, () => {
  const db = read(fileOf('find/database'));
  const table = ek7Sec(db, 'table');
  assert.ok(!table.includes('行に乗せると出るチェック') && !table.includes('題名の列の見出しのチェック'), 'find/database に前の行の選びの文が残る');
  assert.ok(table.includes('行の頭のチェックで行を選びます。表では、見出しの行の頭のチェックで全部の行を選びます。'), 'find/database に行の頭のチェックと見出しの行の頭のチェックが無い');
  const sf = ek7Sec(db, 'sort-filter');
  assert.ok(sf.includes('空の値は、いつも最後に並びます（［チェック］の列は、昇順でチェックの無い行が先、降順でチェックのある行が先です）。'), 'find/database の並べ替えにチェックの列の並びが無い');
  const tree = read(fileOf('find/page-tree'));
  assert.ok(tree.includes('ページを動かしたのは [[Ctrl+Z]] では戻りません。引っ張り直すか、［移動先…］ で戻してください。'), 'find/page-tree の戻らない文が無い');
  assert.ok(tree.includes('開いている白紙のページの本文にもう行のあるページを、サイドバーからその本文へ落としたときは、本文の行を ⠿ で動かしたのと同じで、[[Ctrl+Z]] で戻せます。'), 'find/page-tree に Ctrl+Z で戻せる引っ張りが無い');
});

// 0.16.0 R125（MQ5。2026-11-13 の持ち主の答え「ヘルプに例外を足す（おすすめ）」）: サイドバー・ライブラリの［名前を変える］でデータベースの名前を変えるのは
// db.setTitle（データベースの歩み: R123 (c)）なので、表の中で変えたときと同じく、表のセルを選んでいるときの Ctrl+Z で戻せる
test('R125・MQ5: find/page-tree の #rename に、データベースの名前は表のセルを選んでいるときの Ctrl+Z で戻せる例外（戻せない文の後ろ）', { timeout: 5000 }, () => {
  const ren = ek7Sec(read(fileOf('find/page-tree')), 'rename');
  const no = '名前を変えるのは [[Ctrl+Z]] で戻せません（ページの頭の題名と同じです）。';
  const yes = 'データベースの名前は、表の中で変えたときと同じで、表のセルを選んでいるときの [[Ctrl+Z]] で戻せます。';
  assert.ok(ren.includes(no), '#rename に戻せない文が無い');
  assert.ok(ren.includes(yes), '#rename にデータベースの名前の例外が無い');
  assert.ok(ren.indexOf(no) < ren.indexOf(yes), '#rename の例外が戻せない文の後ろに無い');
});

// 0.16.0 R126（MQ6。2026-11-13 の持ち主の答え「データベースを足す（おすすめ）」）: 無題のデータベースも名前を変える欄が空から始まる（R125 (c)）ので、
// #rename の題名の無いページの例にデータベースの「無題のデータベース」を足す
test('R126・MQ6: find/page-tree の #rename の題名の無いページの例に、データベースの「無題のデータベース」がある', { timeout: 5000 }, () => {
  const ren = ek7Sec(read(fileOf('find/page-tree')), 'rename');
  assert.ok(ren.includes('- 題名の無いページ（一覧で「無題のページ」、議事録は「(無題の議事録)」、データベースは「無題のデータベース」と出るページ）では、欄は空から始まります。'), '#rename の題名の無いページの例にデータベースが無い');
  assert.ok(!ren.includes('議事録は「(無題の議事録)」と出るページ'), '#rename に前の例（データベースの無い文）が残る');
});

// ---------------------------------------------------------------- 0.16.0 Task G の前半（計画の Task G・R127）: 設計書の版の表と D127〜D139・第11回の書き添え、notion-behavior の答え
test('0.16.0 Task G: 設計書の版の表の 0.16.0 の欄・節「利用者が決めたこと（データベース。…）」の D127〜D139（持ち主の言葉は計画の字のまま）・第11回の D1・D3・D4・D7・D8 の書き添え・振り分けの D4、notion-behavior の R-15・X-08・X-10〜X-12・Q-19 と DR-1・DL-1 の項目、計画の R126・R127', { timeout: 5000 }, () => {
  const d = read('docs/plans/natsu-design.md');
  const plan = read('docs/plans/2026-11-04-160.md');
  // 版の表の 0.16.0 の欄
  assert.ok(d.includes('| 0.16.0（データベース: `docs/plans/2026-11-04-160.md`。') && d.includes('D113 で 15b より前へ。D127〜D139） |'), '版の表の 0.16.0 の欄に計画と D127〜D139 が無い');
  // 0.16.0 の節: D127〜D139 がちょうど1つずつ、節の中に並ぶ
  const h = '## 利用者が決めたこと（データベース。2026-11-04〜11-13）';
  const at = d.indexOf(`\n${h}\n`);
  assert.ok(at > 0, `設計書に節「${h}」が無い`);
  const sec = d.slice(at, d.indexOf('\n## ', at + 5));
  const ids = [...sec.matchAll(/^\| (D\d+) \| \*\*/gm)].map((m) => m[1]);
  assert.deepStrictEqual(ids, Array.from({ length: 13 }, (_, i) => `D${127 + i}`), '0.16.0 の節の D の行が D127〜D139 でない');
  for (const id of ids) assert.strictEqual(d.split('\n').filter((l) => l.startsWith(`| ${id} |`)).length, 1, `設計書に ${id} の行が1つでない`);
  assert.ok(d.indexOf('\n| D113 |') < at && at < d.indexOf('\n## 作り方（Superpowers の進め方。'), '0.16.0 の節が D113 の節と「作り方」の間に無い');
  // 持ち主の言葉（「…（おすすめ）」）は計画にある字のまま
  const quotes = [...sec.matchAll(/「([^「」]|「[^「」]*(「[^「」]*」[^「」]*)*」)*（おすすめ）」/g)].map((m) => m[0]);
  assert.ok(quotes.length >= 25, `0.16.0 の節の持ち主の答えの字が少ない（${quotes.length}）`);
  for (const q of quotes) assert.ok(plan.includes(q), `設計書の ${q} が計画に無い（持ち主の言葉の字が違う）`);
  for (const k of ['DQ1', 'DQ2', 'DQ3', 'DQ4', 'DQ5', 'DQ6', 'DQ7', 'DQ8', 'DQ9', 'DQ10', 'DQ11', 'M14', 'M15-1', 'M15-4', 'M16', 'MQ1', 'MQ2', 'MQ3', 'MQ4', 'MQ5', 'MQ6']) {
    assert.ok(new RegExp(`${k}(?![0-9-])`).test(sec), `0.16.0 の節に ${k} の答えが無い`);
  }
  assert.ok(sec.includes('（DQ8「0.17.0 まで「議事録」のまま（おすすめ）」） | 2026-11-06 の D124 で、0.15.1 から見出しは「プライベート」になった（D124 が追い越した） |'), 'D135 に D124 が追い越した印が無い');
  // 第11回の行の書き添え（第1c回の D1〜D10 と同じ番号なので、第11回の節の中で見る）
  const a11 = d.indexOf('\n### 第11回 — データベース（表・リスト）\n');
  const s11 = d.slice(a11, d.indexOf('\n### ', a11 + 5)).split('\n');
  const r11 = (k) => { const xs = s11.filter((l) => l.startsWith(`| ${k} |`)); assert.equal(xs.length, 1, `第11回に ${k} の行が1つでない`); return xs[0]; };
  assert.ok(r11('D1').includes('**（0.16.0 の形: データベースはページの行（`kind: \'database\'`）、行は新しい型 `row`。'), '第11回の D1 に 0.16.0 の形が無い');
  assert.ok(r11('D3').includes('**（0.16.0 で全部入れた: D128。ユーザーは人の名前を書く列: D129）**'), '第11回の D3 に書き添えが無い');
  assert.ok(r11('D4').includes('**（0.16.0 はリレーションだけ。ロールアップは 11b: D128。細かい形: D136）**'), '第11回の D4 に書き添えが無い');
  assert.ok(r11('D7').includes('**（0.16.0 で入れた: D130。ホームビューは第17回）**') && r11('D8').includes('**（0.16.0 で入れた: D136）**'), '第11回の D7・D8 に書き添えが無い');
  assert.ok(!r11('D5').includes('0.16.0') && !r11('D9').includes('0.16.0'), '第11回の D5・D9（11b）に 0.16.0 の書き添えがある');
  assert.ok(d.includes('- **11a:** D1〜D4（D4 はリレーションだけ。ロールアップは 11b: 2026-11-04 の 0.16.0 の計画の DQ2 の答え「17種類を入れる（おすすめ）」）'), '振り分けの D4 の書き添え（第2版）が無い');
  // notion-behavior
  const nb = read('docs/plans/notion-behavior.md');
  const nrow = (k) => { const xs = nb.split('\n').filter((l) => l.startsWith(`| ${k} |`)); assert.equal(xs.length, 1, `notion-behavior に ${k} の行が1つでない`); return xs[0]; };
  assert.ok(nrow('R-15').endsWith('| 11a（設計書 D4）→ 11b（2026-11-04 の 0.16.0 の DQ2「17種類を入れる（おすすめ）」。設計書 D128） |'), 'notion-behavior の R-15 に 11b が無い（食い違い M5）');
  assert.ok(nrow('X-08').includes('**（0.16.0 の形: 計画の決めたこと 52・設計書 D134）** NaTsu の表の中の Ctrl+D は何もしない（下へ埋めるは入れない）。'), 'notion-behavior の X-08 に 0.16.0 の答えが無い');
  for (const k of ['X-10', 'X-11', 'X-12']) assert.ok(nrow(k).includes('（2026-11-09: 持ち主の答え') && nrow(k).includes('計画の R98'), `notion-behavior の ${k} に M15 の答えが無い`);
  assert.ok(nrow('Q-19').includes('**（0.16.0 の形: 公開の資料に無いので作り手が決めた（計画の決めたこと 20・23・24・51）。') && nrow('Q-19').includes('Space で行のページを開く。') && nrow('Q-19').includes('リスト: 下の［＋ 新しい行］で足し、'), 'notion-behavior の Q-19 に 0.16.0 の答えが無い');
  for (let n = 25; n <= 36; n++) nrow(`V-T${n}`);
  for (let n = 10; n <= 13; n++) nrow(`X-${n}`);
  // 計画: MQ6 の答え・R126・R127・今の状態
  for (const r of ['R126', 'R127']) assert.strictEqual(plan.split('\n').filter((l) => l.startsWith(`- **${r}（`)).length, 1, `計画に ${r} が1つでない`);
  assert.ok(plan.includes('- **持ち主の答え（2026-11-13）:「データベースを足す（おすすめ）」。**'), '計画に MQ6 の答えが無い');
  assert.ok(plan.startsWith(plan.split('\n')[0] + '\n\n> **今の状態（2026-11-13）: Task G の前半まで済んだ（R127）。**'), '計画の頭の今の状態が Task G の前半でない');
});
