/* help-site.test.js — ヘルプセンター H-1（D22・HC0）: 置き場所（help/）・分類の形（site.json）・作る道具の骨組み
 *
 * 本物の help/site.json と help/assets/icons/ を読む。build() は写しのフォルダ（os.tmpdir の下）で走らせ、
 * リポジトリの help/dist には書かない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { jobsOf, stepsOf, nameOf } = require('./helpers/yml');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NAME = /^[a-z0-9-]{1,40}$/;

function site() { return JSON.parse(read('help/site.json')); }

/** 本物の help/ を写したフォルダ（root）を作る。edit(site) で site.json を書き換えられる */
function copyRoot(edit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-help-site-'));
  fs.cpSync(path.join(ROOT, 'help'), path.join(root, 'help'), { recursive: true, filter: (s) => !s.split(path.sep).includes('dist') });
  if (edit) {
    const s = JSON.parse(fs.readFileSync(path.join(root, 'help', 'site.json'), 'utf8'));
    edit(s);
    fs.writeFileSync(path.join(root, 'help', 'site.json'), JSON.stringify(s, null, 2));
  }
  return root;
}

test('D22: help/site.json の形（title・askNote・categories の id・title・description・icon・articles・featured）。id と記事の名前は [a-z0-9-]{1,40}、重ならない', { timeout: 5000 }, () => {
  const s = site();
  assert.deepStrictEqual(Object.keys(s).sort(), ['askNote', 'categories', 'featured', 'title']);
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

test('D22: 分類の icon は help/assets/icons/<icon>.svg があり、その SVG に script・on…=・外の住所（http）・<image> が無い', { timeout: 5000 }, () => {
  for (const c of site().categories) {
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

test('D22: site.json の形が違えば build は HelpBuildError（code: bad-site）で止まり、help/dist に何も書かない', { timeout: 5000 }, () => {
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
  ];
  for (const [why, edit] of bad) {
    const root = copyRoot(edit);
    try {
      assert.throws(() => build({ root, out: path.join(root, 'help', 'dist') }), (e) => e.name === 'HelpBuildError' && e.code === 'bad-site', why);
      assert.ok(!fs.existsSync(path.join(root, 'help', 'dist')), `${why}: help/dist に書いた`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  // site.json に無い記事のファイルも止める（分類の articles と help/articles/<id>/*.md はちょうど同じ）
  const root = copyRoot();
  try {
    fs.mkdirSync(path.join(root, 'help', 'articles', 'start'), { recursive: true });
    fs.writeFileSync(path.join(root, 'help', 'articles', 'start', 'stray.md'), '---\ntitle: x\n---\n');
    assert.throws(() => build({ root, out: path.join(root, 'help', 'dist') }), (e) => e.code === 'bad-site' && /stray/.test(e.message));
    assert.ok(!fs.existsSync(path.join(root, 'help', 'dist')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  // 正しい形なら作れる（写しのフォルダの help/dist に index.html と分類の名前）
  const ok = copyRoot();
  try {
    const out = path.join(ok, 'help', 'dist');
    const r = build({ root: ok, out });
    assert.ok(r.pages.includes('index.html'), r.pages.join(','));
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    for (const c of site().categories) assert.ok(html.includes(c.title), c.title);
  } finally { fs.rmSync(ok, { recursive: true, force: true }); }
});
