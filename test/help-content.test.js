/* help-content.test.js — ヘルプセンター H-5（HF2・RF51・RF28）: 記事の照らし
 *
 * 本物の help/ を読む。記事が 0 件の間も通る形にし、記事を足すたびに効く（C のタスク H-6〜H-8）。
 * 記事の ［…］ は NaTsu の画面の言葉だけ（R9）で、どれも src/ の .html か .js にちょうどその文字である。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { build, loadSite } = require('../tools/help-build');
const { parseFrontMatter } = require('../tools/lib/help-md');
const L = require('../tools/lib/help-labels');

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

test('RF28: record/pc-only の記事に「1on1」「面談」「OpenAI」「［この会議は PC の中だけ］」「音声入力」がある。start/what-natsu-does から record/pc-only へのリンクがあり、featured に record/pc-only がある', { timeout: 5000 }, () => {
  if (refs.length === 0) {
    // 記事がまだ無い間だけ通る。1件でもあれば下の照らしが効く（後で pc-only を消しても黙って通らない）
    assert.deepStrictEqual(site.featured, []);
    return;
  }
  assert.ok(refs.includes('record/pc-only'), 'record/pc-only の記事が無い（1on1・面談の注意）');
  const pc = read(fileOf('record/pc-only'));
  for (const w of ['1on1', '面談', 'OpenAI', '［この会議は PC の中だけ］', '音声入力']) assert.ok(pc.includes(w), `record/pc-only に「${w}」が無い`);
  assert.ok(refs.includes('start/what-natsu-does'), 'start/what-natsu-does の記事が無い');
  assert.ok(read(fileOf('start/what-natsu-does')).includes('](record/pc-only.md'), 'start/what-natsu-does から record/pc-only へのリンクが無い');
  assert.ok(site.featured.includes('record/pc-only'), 'featured に record/pc-only が無い');
});

test('HF2: 照らしの元（appLabelText）は src/ の .html と .js だけを読み、help/ を読まない', { timeout: 5000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-help-labels-'));
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

test('HF2: 作るのが通る（build() が help/ の全部の記事で HelpBuildError を投げない）', { timeout: 5000 }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-help-real-')), 'out');
  const r = build({ root: ROOT, out });
  assert.strictEqual(r.articles.length, refs.length);
  assert.ok(fs.existsSync(path.join(out, 'index.html')) && fs.existsSync(path.join(out, 'search-index.json')));
});
