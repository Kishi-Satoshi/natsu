/* help-site.test.js — ヘルプセンター H-1（D22・HC0）: 置き場所（help/）・分類の形（site.json）・作る道具の骨組み
 *
 * 本物の help/site.json と help/assets/icons/ を読む。build() は写しのフォルダ（os.tmpdir の下。test/helpers/help-tmp.js の tmpDir）で走らせ、
 * リポジトリの help/dist には書かない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { jobsOf, stepsOf, nameOf } = require('./helpers/yml');
const { tmpDir } = require('./helpers/help-tmp');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NAME = /^[a-z0-9-]{1,40}$/;

function site() { return JSON.parse(read('help/site.json')); }

/** 本物の help/ と CHANGELOG.md（リリースノートの元。help-relnotes RN-3）を写したフォルダ（root）を作る。edit(site) で site.json を書き換えられる。テスト t の終わりに消す（早く消してもよい） */
function copyRoot(t, edit) {
  const root = tmpDir(t, 'natsu-help-site-');
  fs.cpSync(path.join(ROOT, 'help'), path.join(root, 'help'), { recursive: true, filter: (s) => !s.split(path.sep).includes('dist') });
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(root, 'CHANGELOG.md'));
  if (edit) {
    const s = JSON.parse(fs.readFileSync(path.join(root, 'help', 'site.json'), 'utf8'));
    edit(s);
    fs.writeFileSync(path.join(root, 'help', 'site.json'), JSON.stringify(s, null, 2));
  }
  return root;
}

test('D22: help/site.json の形（title・askNote・categories の id・title・description・icon・articles・featured）。id と記事の名前は [a-z0-9-]{1,40}、重ならない', { timeout: 5000 }, () => {
  const s = site();
  assert.deepStrictEqual(Object.keys(s).sort(), ['askNote', 'categories', 'featured', 'releaseNotes', 'title']);
  // help-relnotes RN-3（RN2・Q6・Q7）: リリースノートのカードとページ（分類ではないので categories に入れない）
  assert.deepStrictEqual(Object.entries(s.releaseNotes), [['title', 'リリースノート'], ['description', 'NaTsu の版ごとの変更点（新しい版が上）'], ['icon', 'release']]);
  assert.strictEqual(s.title, 'NaTsu ヘルプセンター');
  assert.ok(typeof s.askNote === 'string' && s.askNote.length > 0);
  assert.ok(Array.isArray(s.categories) && Array.isArray(s.featured));
  assert.deepStrictEqual(s.categories.map((c) => c.id), ['start', 'record', 'summary', 'dictation', 'find', 'settings', 'trouble', 'admin']);
  assert.deepStrictEqual(s.categories.map((c) => c.title), ['はじめに', '会議を記録する', '要約と出典', '音声入力', '議事録を探す・整理する', '設定', '困ったとき', '管理者向け']);
  const ids = new Set();
  const names = new Set();
  for (const c of s.categories) {
    assert.deepStrictEqual(Object.keys(c).sort(), ['articles', 'description', 'icon', 'id', 'title'], c.id);
    assert.match(c.id, NAME);
    assert.ok(!ids.has(c.id), `分類の id が重なる: ${c.id}`);
    ids.add(c.id);
    assert.ok(typeof c.description === 'string' && c.description.length > 0 && !c.description.includes('\n'), c.id);
    assert.match(c.icon, NAME);
    assert.ok(Array.isArray(c.articles));
    for (const a of c.articles) {
      assert.match(a, NAME);
      assert.ok(!names.has(`${c.id}/${a}`), `記事が重なる: ${c.id}/${a}`);
      names.add(`${c.id}/${a}`);
    }
  }
  for (const f of s.featured) assert.ok(names.has(f), `featured の ${f} が分類の記事に無い`);
  assert.strictEqual(new Set(s.featured).size, s.featured.length);
});

test('D22: 分類の icon（と help-relnotes RN-3 のリリースノートの icon）は help/assets/icons/<icon>.svg があり、その SVG に script・on…=・外の住所（http）・<image> が無い', { timeout: 5000 }, () => {
  for (const c of [...site().categories, site().releaseNotes]) {
    const f = `help/assets/icons/${c.icon}.svg`;
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} が無い`);
    const svg = read(f);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"/, f);
    assert.match(svg, /stroke="currentColor"/, f);
    assert.match(svg, /fill="none"/, f);
    assert.ok(!/<script|\son[a-z]+\s*=|<image|<foreignObject|xlink:href|href=/i.test(svg), `${f} に script・on…=・外の参照がある`);
    // http は名前空間の宣言だけ（外の住所を読まない）
    assert.deepStrictEqual(svg.match(/https?:\/\/[^"\s]*/g), ['http://www.w3.org/2000/svg'], f);
  }
  // help-relnotes RN-3（Q6）: リリースノートのアイコンは、持ち主が「この見本でよい」と言った見本（2026-10-24）のまま（札に横線2本と札の穴の丸。線 1.5）
  assert.strictEqual(read('help/assets/icons/release.svg').trim(), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9-9-9z"/><circle cx="7.5" cy="7.5" r="1.25"/><path d="M9.5 12.5h5"/><path d="M9.5 15.5h3"/></svg>');
});

test('D22: help/ と tools/help-* はアプリに入らない（build.files に help が無い・release.yml の配布 zip は src と package.json だけ・make-release.ps1 も同じ）', { timeout: 5000 }, () => {
  const pkg = JSON.parse(read('package.json'));
  for (const f of pkg.build.files) {
    assert.match(f, /^(src\/|assets\/[^*]+$|package\.json$)/, `build.files の ${f} は src・assets・package.json の外も拾いうる`);
    assert.ok(!/help/.test(f), f);
  }
  for (const k of ['extraResources', 'extraFiles', 'asarUnpack']) assert.ok(!(k in pkg.build) || !/help/.test(JSON.stringify(pkg.build[k])), k);
  const st = stepsOf(jobsOf(read('.github/workflows/release.yml')).release);
  const zip = st.find((s) => nameOf(s) === '配布zipを作る');
  assert.ok(zip, 'release.yml に「配布zipを作る」が無い');
  const cps = [...zip.matchAll(/^\s*cp (?:-a )?(\S+) release\/_stage\//gm)].map((m) => m[1]);
  assert.deepStrictEqual(cps.sort(), ['package.json', 'src']);
  assert.ok(!/help/.test(zip), zip);
  const ps = read('make-release.ps1');
  const copies = [...ps.matchAll(/^Copy-Item (.+)$/gm)].map((m) => m[1].trim());
  assert.deepStrictEqual(copies, ['(Join-Path $root "src") (Join-Path $stage "src") -Recurse', '$pkgPath (Join-Path $stage "package.json")']);
  assert.ok(!/help/i.test(ps.replace(/Get-Help|-Help\b/g, '')));
  // アプリのコードは help/ も作る道具も読まない
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(ROOT, 'src')).filter((p) => /\.(js|html|mjs)$/.test(p))) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/(require\(|import\(|from\s)\s*['"][./]*\/?(\.\.\/)+(help|tools)\//.test(s), `${path.relative(ROOT, f)} が help/ か tools/ を読む`);
  }
});

test('D22: help/dist は git に入らない（git check-ignore help/dist/index.html が当たる）', { timeout: 5000 }, () => {
  const out = execFileSync('git', ['check-ignore', 'help/dist/index.html', 'help/dist/assets/help.css'], { cwd: ROOT, encoding: 'utf8' });
  assert.deepStrictEqual(out.trim().split('\n'), ['help/dist/index.html', 'help/dist/assets/help.css']);
});

test('D22: package.json に依存が増えていない（dependencies が無く、devDependencies は electron と electron-builder だけ）。scripts の help:build は node tools/help-build.js', { timeout: 5000 }, () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!('dependencies' in pkg), 'dependencies がある');
  assert.deepStrictEqual(Object.keys(pkg.devDependencies).sort(), ['electron', 'electron-builder']);
  assert.strictEqual(pkg.scripts['help:build'], 'node tools/help-build.js');
  // 作る道具は Node に入っている部品だけを読む
  const src = read('tools/help-build.js');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  for (const r of reqs) assert.ok(/^node:/.test(r) || /^\.\/lib\/help-[a-z]+(\.js)?$/.test(r), `help-build.js が ${r} を読む`);
});

test('D22: site.json の形が違えば build は HelpBuildError（code: bad-site）で止まり、help/dist に何も書かない', { timeout: 5000 }, (t) => {
  const { build } = require('../tools/help-build');
  const bad = [
    ['知らない鍵', (s) => { s.extra = 1; }],
    ['title が無い', (s) => { delete s.title; }],
    ['分類の id の形', (s) => { s.categories[0].id = 'Start'; }],
    ['分類の id が重なる', (s) => { s.categories[1].id = s.categories[0].id; }],
    ['分類の知らない鍵', (s) => { s.categories[0].order = 1; }],
    ['説明が空', (s) => { s.categories[0].description = ''; }],
    ['アイコンが無い', (s) => { s.categories[0].icon = 'no-such-icon'; }],
    ['記事の名前の形', (s) => { s.categories[0].articles = ['../x']; }],
    ['記事のファイルが無い', (s) => { s.categories[0].articles = ['no-such-article']; }],
    ['featured が分類の記事に無い', (s) => { s.featured = ['start/no-such-article']; }],
    ['分類が無い', (s) => { s.categories = []; }],
    // help-relnotes RN-3: releaseNotes の鍵は title・description・icon だけ。release-notes は分類の id に使えない（ページの住所と重なる）
    ['releaseNotes の知らない鍵', (s) => { s.releaseNotes.url = '/x/'; }],
    ['releaseNotes の鍵が足りない', (s) => { delete s.releaseNotes.icon; }],
    ['releaseNotes が配列', (s) => { s.releaseNotes = []; }],
    ['releaseNotes の説明が空', (s) => { s.releaseNotes.description = ''; }],
    ['releaseNotes の題名が2行', (s) => { s.releaseNotes.title = 'リリース\nノート'; }],
    ['releaseNotes のアイコンが無い', (s) => { s.releaseNotes.icon = 'no-such-icon'; }],
  ];
  for (const [why, edit] of bad) {
    const root = copyRoot(t, edit);
    try {
      assert.throws(() => build({ root, out: path.join(root, 'help', 'dist') }), (e) => e.name === 'HelpBuildError' && e.code === 'bad-site', why);
      assert.ok(!fs.existsSync(path.join(root, 'help', 'dist')), `${why}: help/dist に書いた`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  // help-relnotes RN-3: 分類の id の release-notes は、記事のフォルダもそろえても止める（/release-notes/ のページと重なる）
  {
    const root = copyRoot(t, (s) => { s.categories[s.categories.length - 1].id = 'release-notes'; s.featured = s.featured.filter((f) => !f.startsWith('admin/')); });
    try {
      fs.renameSync(path.join(root, 'help', 'articles', 'admin'), path.join(root, 'help', 'articles', 'release-notes'));
      assert.throws(() => build({ root, out: path.join(root, 'help', 'dist') }), (e) => e.code === 'bad-site' && /release-notes/.test(e.message), 'release-notes の分類');
      assert.ok(!fs.existsSync(path.join(root, 'help', 'dist')));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  // site.json に無い記事のファイルも止める（分類の articles と help/articles/<id>/*.md はちょうど同じ）
  const root = copyRoot(t);
  try {
    fs.mkdirSync(path.join(root, 'help', 'articles', 'start'), { recursive: true });
    fs.writeFileSync(path.join(root, 'help', 'articles', 'start', 'stray.md'), '---\ntitle: x\n---\n');
    assert.throws(() => build({ root, out: path.join(root, 'help', 'dist') }), (e) => e.code === 'bad-site' && /stray/.test(e.message));
    assert.ok(!fs.existsSync(path.join(root, 'help', 'dist')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  // 正しい形なら作れる（写しのフォルダの help/dist に index.html と分類の名前）
  const ok = copyRoot(t);
  try {
    const out = path.join(ok, 'help', 'dist');
    const r = build({ root: ok, out });
    assert.ok(r.pages.includes('index.html'), r.pages.join(','));
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    for (const c of site().categories) assert.ok(html.includes(c.title), c.title);
  } finally { fs.rmSync(ok, { recursive: true, force: true }); }
});

// help-dads HD-0（HD8・HD6。計画 docs/plans/2026-10-23-help-dads.md の決めたこと G・H と問答の Q15・Q18）:
// 守るものの宣言（DADS のスキルの references/protect-file.md の書式）と、読み上げの例外を設計書に先に書く
test('HD-0: リポジトリの直下に DADS-PROTECT.md がある（# 守るもの と決まった4つの見出しを決まった順で）。ブランド色の行は「- #xxxxxx（…）」で、その値は help.css の暗い版の灰色の札（地・面・罫線・補足・本文）とちょうど同じ', { timeout: 5000 }, () => {
  const C = require('./helpers/simcss');
  assert.ok(fs.existsSync(path.join(ROOT, 'DADS-PROTECT.md')), 'DADS-PROTECT.md が無い');
  const md = read('DADS-PROTECT.md').replace(/\r\n?/g, '\n');
  assert.ok(md.startsWith('# 守るもの\n'), '頭が # 守るもの でない');
  const order = ['守るファイル・フォルダ', 'ブランド色', '顧客の基準', 'メモ'];
  const heads = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.ok(heads.length > 0 && heads.every((h) => order.includes(h)), `知らない見出し: ${heads.join(' / ')}`);
  assert.deepStrictEqual(heads, order.filter((h) => heads.includes(h)), '見出しの順が決まりと違う');
  assert.strictEqual(new Set(heads).size, heads.length, '見出しが重なる');
  const sec = (h) => { const i = md.indexOf(`## ${h}\n`); const j = md.indexOf('\n## ', i + 1); return md.slice(i, j < 0 ? md.length : j); };
  const lines = sec('ブランド色').split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines.length > 0);
  for (const l of lines) assert.match(l, /^- #[0-9a-f]{6}（[^）]+）$/, `ブランド色の行の形: ${l}`);
  const brand = lines.map((l) => l.slice(2, 9)).sort();
  const dark = C.tokens(C.parse(read('help/assets/help.css')), '@media (prefers-color-scheme: dark)');
  const greys = ['--bg', '--wash', '--rule', '--muted', '--body'].map((k) => (dark[k] || '').toLowerCase()).sort();
  assert.deepStrictEqual(brand, greys, 'ブランド色と暗い版の灰色の札が違う');
  // 守るファイル: アプリの画面・ロゴ・記事・門・出し方（ヘルプの DADS の直しの外）
  for (const f of ['src/**', 'assets/**', 'help/articles/**', 'relay/**', '.github/**']) assert.ok(sec('守るファイル・フォルダ').includes(`- ${f}（`), f);
  // メモ: 読み上げの例外（HD6 の検索の件数・0.10.0 の /open の知らせ）と暗い版を残すこと
  const memo = sec('メモ');
  assert.match(memo, /読み上げソフトへの対応は作らない/);
  assert.match(memo, /検索の件数の知らせ（role="status"）/);
  assert.match(memo, /\/open のページ/);
  assert.match(memo, /暗い版（OS の設定に従う）は残す/);
});

test('HD-0（HD6・Q18）: 設計書の「画面の使いやすさ」の「作らないもの」と「やらないこと」に、読み上げの例外（ヘルプの検索の件数の知らせと /open のページの知らせの role="status"）が書いてある', { timeout: 5000 }, () => {
  const d = read('docs/plans/natsu-design.md');
  const part = (h) => { const i = d.indexOf(h); assert.ok(i >= 0, h); return d.slice(i, d.indexOf('\n### ', i + 1)); };
  const ease = part('### 画面の使いやすさ');
  const line = ease.split('\n').find((l) => l.includes('**作らないもの:**'));
  assert.ok(line, '作らないもの の行が無い');
  assert.match(line, /読み上げソフトへの対応（例外: .*検索の件数の知らせ `role="status"`.*HD6.*\/open.*`role="status"`.*D78/);
  const never = part('### やらないこと').split('\n').find((l) => l.includes('**画面と端末:**'));
  assert.match(never, /読み上げソフト（例外は「画面の使いやすさ」の2つ）/);
});

// help-relnotes RN-0（計画 docs/plans/2026-10-23-help-relnotes.md）: 持ち主の決定 RN1〜RN4 を設計書に先に書く
test('RN-0: 設計書に「利用者が決めたこと（ヘルプセンターのリリースノート。2026-10-23）」の RN1〜RN4 があり、HC0 がリリースノートのページ（CHANGELOG.md から作る）を言う', { timeout: 5000 }, () => {
  const d = read('docs/plans/natsu-design.md');
  const i = d.indexOf('## 利用者が決めたこと（ヘルプセンターのリリースノート。2026-10-23）');
  assert.ok(i >= 0, '節が無い');
  const sec = d.slice(i, d.indexOf('\n## ', i + 1));
  for (const k of ['RN1', 'RN2', 'RN3', 'RN4']) assert.match(sec, new RegExp(`^\\| ${k} \\|`, 'm'), k);
  assert.match(sec, /docs\/plans\/2026-10-23-help-relnotes\.md/);
  const hc0 = d.split('\n').find((l) => l.startsWith('- **HC0'));
  assert.match(hc0, /リリースノート/);
  assert.match(hc0, /CHANGELOG\.md/);
});
