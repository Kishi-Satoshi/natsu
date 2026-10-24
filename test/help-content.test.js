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
  for (const w of ['1on1', '面談', 'OpenAI', '［オフラインモード］', '音声入力']) assert.ok(pc.includes(w), `record/pc-only に「${w}」が無い`);
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
  const bad = [
    [/(?<![\w-])[a-z0-9-]+\.cloudflareaccess\.com/i, 'チームのドメインの字面（<チームの名前> と書く）'],
    [/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i, '64 字の16進（AUD の見かけ）'],
    [/[A-Za-z]:\\{1,2}Users\\{1,2}/i, '個人の Windows のパス'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '半角の @ のメール（＠ は全角で書く）'],
  ];
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
