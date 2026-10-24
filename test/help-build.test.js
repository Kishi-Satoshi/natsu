/* help-build.test.js — ヘルプセンター H-3（HF3・HF4）: ページの組み立てと見た目
 *
 * テスト用の小さな記事の組（test/fixtures/help/）と本物の help/assets を写したフォルダで作る（リポジトリの help/dist には書かない）。
 * 見た目は利用者の後の指定（白黒。docs/plans/2026-10-20-help.md「見た目」）: 色の札・同梱の書体（HD-4 で Noto Sans JP・Noto Sans Mono に）・ロゴのアイコンなし・
 * 大きな数字は順番のある手順だけ・白黒を反転した暗い版。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('./helpers/simcss');
const { tmpDir } = require('./helpers/help-tmp');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'help');
const { build, checkPages } = require('../tools/help-build');

/** 写しのフォルダ: 記事の組（fixtures か、edit で書き換えたもの）と本物の help/assets。
 *  写した help/assets と出力で 1 つ約 15 MB になるので、そのテストの終わりに消す（tmpDir） */
function fixtureRoot(t, edit) {
  const root = tmpDir(t, 'natsu-help-build-');
  fs.mkdirSync(path.join(root, 'help'));
  fs.cpSync(path.join(FIX, 'site.json'), path.join(root, 'help', 'site.json'));
  fs.cpSync(path.join(FIX, 'articles'), path.join(root, 'help', 'articles'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'help', 'assets'), path.join(root, 'help', 'assets'), { recursive: true });
  if (edit) edit(path.join(root, 'help'));
  return root;
}
/** 作って、出力の全部のファイル（相対の道 → Buffer）を返す */
function buildFixture(t, edit) {
  const root = fixtureRoot(t, edit);
  const out = path.join(root, 'out');
  const r = build({ root, out });
  const files = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else files.set(path.relative(out, p).split(path.sep).join('/'), fs.readFileSync(p));
    }
  };
  walk(out);
  return { root, out, r, files, html: (f) => files.get(f).toString('utf8') };
}
const listFiles = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]));
const CSS = () => fs.readFileSync(path.join(ROOT, 'help', 'assets', 'help.css'), 'utf8');
const DARK = '@media (prefers-color-scheme: dark)';

test('H-3: 作ると、ホーム・分類ごと・記事ごと・404・assets の全部のファイルができる（多くも少なくもない）', { timeout: 5000 }, (t) => {
  const { files, r } = buildFixture(t);
  const pages = ['index.html', '404.html', 'start/index.html', 'start/first/index.html', 'start/steps/index.html', 'record/index.html', 'record/pause/index.html', 'admin/index.html'];
  const assets = listFiles(path.join(ROOT, 'help', 'assets')).map((f) => `assets/${f}`);
  assert.deepStrictEqual([...files.keys()].sort(), [...pages, 'search-index.json', ...assets].sort());   // search-index.json は H-4
  assert.deepStrictEqual([...r.pages].sort(), [...pages].sort());
  assert.deepStrictEqual(r.articles, [
    { ref: 'start/first', url: '/start/first/', title: '試しの最初の記事' },
    { ref: 'start/steps', url: '/start/steps/', title: '試しの手順の記事' },
    { ref: 'record/pause', url: '/record/pause/', title: '試しの一時停止' },
  ]);
  for (const a of assets) assert.ok(files.get(a).equals(fs.readFileSync(path.join(ROOT, 'help', a))), `${a} がそのまま写っていない`);
});

test('HF4: 作った全部のページの中の / で始まるリンクと #id が、出力のファイルと id にある（a・link・script・img の全部）', { timeout: 5000 }, (t) => {
  const { files, html } = buildFixture(t);
  const idsOf = (h) => new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  let checked = 0;
  for (const f of files.keys()) {
    if (!f.endsWith('.html')) continue;
    const h = html(f);
    const ids = idsOf(h);
    assert.strictEqual(ids.size, [...h.matchAll(/\sid="([^"]+)"/g)].length, `${f}: id が重なる`);
    for (const m of h.matchAll(/<(a|link|script|img)\b[^>]*?\s(href|src)="([^"]*)"/g)) {
      const url = m[3].replace(/&amp;/g, '&');
      if (url.startsWith('https://')) { assert.strictEqual(m[1], 'a', `${f}: 外の住所を読む ${m[0]}`); continue; }
      checked++;
      if (url.startsWith('#')) { assert.ok(ids.has(url.slice(1)), `${f}: 飛び先が無い ${url}`); continue; }
      assert.ok(url.startsWith('/') && !url.startsWith('//'), `${f}: 形の違う住所 ${url}`);
      const [p, anchor] = url.split('#');
      const target = p.endsWith('/') ? `${p.slice(1)}index.html` : p.slice(1);
      assert.ok(files.has(target), `${f}: リンク先のファイルが無い ${url}`);
      if (anchor !== undefined) assert.ok(idsOf(html(target)).has(anchor), `${f}: 飛び先が無い ${url}`);
    }
  }
  assert.ok(checked > 40, `確かめたリンクが少ない: ${checked}`);
  // 作る道具も出力の前に同じことを確かめて止める
  assert.throws(() => checkPages(new Map([['index.html', '<a href="/nowhere/">x</a>']])), (e) => e.name === 'HelpBuildError' && e.code === 'missing-article');
  assert.throws(() => checkPages(new Map([['index.html', '<a href="#nowhere">x</a>']])), (e) => e.name === 'HelpBuildError' && e.code === 'missing-anchor');
  assert.throws(() => checkPages(new Map([['index.html', '<a href="/a/#x">x</a>'], ['a/index.html', '<p id="y">y</p>']])), (e) => e.code === 'missing-anchor');
  assert.doesNotThrow(() => checkPages(new Map([['index.html', '<a href="/a/#y">x</a><link rel="stylesheet" href="/assets/help.css">'], ['a/index.html', '<p id="y">y</p>'], ['assets/help.css', null]])));
});

test('HF3: 出力のどの HTML にも style=・on…=・src の無い <script>・http:// が無い。どのページにも <meta name="natsu-help" content="page"> と lang="ja"', { timeout: 5000 }, (t) => {
  const { files, html } = buildFixture(t);
  for (const f of files.keys()) {
    if (!f.endsWith('.html')) continue;
    const h = html(f);
    assert.ok(!/\sstyle\s*=/i.test(h), `${f}: style=`);
    assert.ok(!/\son[a-z]+\s*=/i.test(h), `${f}: on…=`);
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(h), `${f}: src の無い script`);
    assert.ok(!/http:\/\//i.test(h), `${f}: http://`);
    assert.ok(h.startsWith('<!doctype html>\n<html lang="ja">'), `${f}: lang="ja"`);
    assert.ok(h.includes('<meta name="natsu-help" content="page">'), `${f}: 印が無い`);
    assert.ok(h.includes('<link rel="stylesheet" href="/assets/fonts.css">') && h.includes('<link rel="stylesheet" href="/assets/help.css">'), `${f}: CSS`);
    assert.ok(h.includes('<script src="/assets/search.js" defer></script>\n<script src="/assets/site.js" defer></script>'), `${f}: search.js と site.js`);
    // 白黒の指定: ロゴのアイコンを使わない（上の帯は文字だけ）
    const header = h.slice(h.indexOf('<header'), h.indexOf('</header>'));
    assert.ok(header.includes('<a class="brand" href="/">NaTsu ヘルプセンター</a>'), `${f}: 上の帯の題名`);
    assert.ok(!/<img|<svg|logo/.test(header), `${f}: 上の帯にロゴのアイコンがある`);
    assert.ok(header.includes('<div class="search" hidden>'), `${f}: 上の帯の検索の箱`);
  }
});

test('HD-6（Q4）: 分類のページのパンくずの最後（分類名）も aria-current="page"。今のページの文字は 16px・本文の色（リンクの青にしない）', { timeout: 5000 }, (t) => {
  const { html } = buildFixture(t);
  assert.ok(html('start/index.html').includes('<nav class="crumbs" aria-label="パンくず"><a href="/">ホーム</a> <span aria-hidden="true">›</span> <span aria-current="page">はじめに</span></nav>'));
  const d = C.declsFor(C.parse(CSS()), '.crumbs [aria-current="page"]', { at: '' });
  assert.strictEqual(d.color, 'var(--body)');
});

test('HD-6（Q5）: 一覧の説明は、広い画面でも題名の下に左寄せ（縦の並び）。右寄せの規則が無い', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  const li = C.declsFor(rules, '.rows li', { at: '' });
  assert.strictEqual(li.display, 'flex');
  assert.strictEqual(li['flex-direction'], 'column', '広い画面で一覧が横の並び');
  assert.strictEqual(li['align-items'], 'flex-start');
  assert.strictEqual(C.declsFor(rules, '.rows .desc', { at: '' })['text-align'], 'left');
  for (const r of rules) if (r.sel.includes('.rows')) assert.notStrictEqual(r.decls['text-align'], 'right', `${r.sel} が右寄せ`);
});

test('HD-6（Q6）: 48rem 未満では表の最小幅を 640px 相当（calc(640 / 16 * 1rem)）にし、表の領域の中だけ横に送る（ページ全体は送らない）。影（グラデーション）は付けない', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  assert.strictEqual(C.declsFor(rules, '.table table', { at: '@media (max-width: 47.9375rem)' })['min-width'], 'calc(640 / 16 * 1rem)');
  assert.strictEqual(C.declsFor(rules, '.table table', { at: '' })['min-width'], undefined, '広い画面に表の最小幅');
  assert.strictEqual(C.declsFor(rules, '.table', { at: '' })['overflow-x'], 'auto');
});

test('H-3: 同じ元から2回作ると、全部のファイルが同じバイト（日付は記事の updated だけ）', { timeout: 5000 }, (t) => {
  const a = buildFixture(t);
  const b = buildFixture(t);
  assert.deepStrictEqual([...a.files.keys()].sort(), [...b.files.keys()].sort());
  for (const [f, buf] of a.files) assert.ok(buf.equals(b.files.get(f)), `${f} が違う`);
  const all = [...a.files].filter(([f]) => f.endsWith('.html')).map(([, v]) => v.toString('utf8')).join('\n');
  const years = new Set([...all.matchAll(/20\d\d/g)].map((m) => m[0]));
  assert.deepStrictEqual([...years], ['2026'], '記事の updated のほかの日付がある');
});

test('H-3: 記事のページにパンくず・題名・最終更新日（2026 年 10 月 21 日）・左の目次で今の記事に aria-current="page"・関連記事・askNote がある', { timeout: 5000 }, (t) => {
  const { html } = buildFixture(t);
  const h = html('start/first/index.html');
  assert.ok(h.includes('<title>試しの最初の記事 — NaTsu ヘルプセンター</title>'));
  // help-dads HD-6（Q4）: パンくずの最後に今のページ（記事の題名。リンクでない文字で aria-current="page"）
  assert.match(h, /<nav class="crumbs" aria-label="パンくず"><a href="\/">ホーム<\/a> <span aria-hidden="true">›<\/span> <a href="\/start\/">はじめに<\/a> <span aria-hidden="true">›<\/span> <span aria-current="page">試しの最初の記事<\/span><\/nav>/);
  assert.ok(h.includes('<h1>試しの最初の記事</h1>'));
  assert.ok(h.includes('<dl class="article-meta"><div><dt>分類</dt><dd>はじめに</dd></div><div><dt>最終更新日</dt><dd><time datetime="2026-10-21">2026 年 10 月 21 日</time></dd></div></dl>'));
  // 左の目次: 全部の分類と記事。今の記事だけに aria-current
  const toc = h.slice(h.indexOf('<nav id="hc-toc"'), h.indexOf('</nav>', h.indexOf('<nav id="hc-toc"')));
  for (const u of ['/start/first/', '/start/steps/', '/record/pause/', '/start/', '/record/', '/admin/']) assert.ok(toc.includes(`href="${u}"`), u);
  assert.deepStrictEqual([...toc.matchAll(/aria-current="page"/g)].length, 1);
  assert.ok(toc.includes('<a href="/start/first/" aria-current="page">試しの最初の記事</a>'));
  // 狭い画面の［目次］のボタン（JS が出す。始めは hidden）
  assert.ok(h.includes('<button type="button" class="toc-btn" aria-controls="hc-toc" aria-expanded="false" hidden>目次</button>'));
  // 関連記事: related のとおり
  const rel = h.slice(h.indexOf('<section class="related"'), h.indexOf('</section>', h.indexOf('<section class="related"')));
  assert.deepStrictEqual([...rel.matchAll(/<a href="([^"]+)">/g)].map((m) => m[1]), ['/record/pause/']);
  // related が無い記事は、同じ分類の前後の記事（3つまで）
  const s = html('start/steps/index.html');
  const rel2 = s.slice(s.indexOf('<section class="related"'), s.indexOf('</section>', s.indexOf('<section class="related"')));
  assert.deepStrictEqual([...rel2.matchAll(/<a href="([^"]+)">/g)].map((m) => m[1]), ['/start/first/']);
  // askNote はどのページもいちばん下
  for (const f of ['start/first/index.html', 'index.html', 'record/index.html', '404.html']) {
    assert.match(html(f), /<footer class="foot"><div class="foot-in"><p>解決しないときは Teams の NaTsu のチャンネルで聞いてください<\/p><\/div><\/footer>\n<\/body>/, f);
  }
  // 本文: 記事の HTML（help-md の出力）がそのまま入る。手順の見出しは大きな数字の形
  assert.ok(s.includes('<h2 id="install" class="step"><span class="n" aria-hidden="true">1</span><span class="k">手順1</span> <span class="t">インストールする</span></h2>'));
  assert.ok(html('record/pause/index.html').includes('<a href="https://example.com/docs" rel="noreferrer">外の資料</a>'));
});

test('H-3: 「このページの内容」は linkable な ## が3つ以上の記事にだけ出る（HD-6 Q11: 見出しの h2）', { timeout: 5000 }, (t) => {
  const { html } = buildFixture(t);
  const s = html('start/steps/index.html');
  assert.ok(s.includes('<aside class="onpage" aria-labelledby="hc-onpage">'));
  // help-dads HD-6（Q11）: 「このページの内容」は見出し（h2。見た目は 14px のまま。aside の中なので本文の見出しの順は変わらない）
  assert.ok(s.includes('<aside class="onpage" aria-labelledby="hc-onpage"><h2 class="onpage-h" id="hc-onpage">このページの内容</h2>'), 'HD-6 Q11: このページの内容が見出しでない');
  assert.strictEqual(C.declsFor(C.parse(CSS()), '.onpage-h', { at: '' })['font-size'], '.875rem');
  const on = s.slice(s.indexOf('<aside class="onpage"'), s.indexOf('</aside>', s.indexOf('<aside class="onpage"')));
  assert.deepStrictEqual([...on.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]), [['#prepare', '用意するもの'], ['#install', '手順1. インストールする'], ['#login', '手順2. ログインする']]);
  assert.ok(!html('start/first/index.html').includes('class="onpage"'), '## が2つの記事に出ている');
  assert.ok(!html('record/pause/index.html').includes('class="onpage"'));
});

test('H-3: ホームに分類の格子（題名・説明・記事の件数）と「はじめての方へ」（featured の順）がある。格子の順は site.json の順', { timeout: 5000 }, (t) => {
  const { html } = buildFixture(t);
  const h = html('index.html');
  assert.ok(h.includes('<h1>NaTsu ヘルプセンター</h1>'));
  assert.match(h, /<p class="lede">[^<]+<\/p>/);
  const cats = h.slice(h.indexOf('<ul class="cats">'), h.indexOf('</ul>', h.indexOf('<ul class="cats">')));
  const items = [...cats.matchAll(/<a href="([^"]+)">(?:<svg[\s\S]*?<\/svg>)?<span class="t">([^<]+)<\/span><span class="d">([^<]+)<\/span><span class="c">([^<]+)<\/span><\/a>/g)].map((m) => m.slice(1));
  assert.deepStrictEqual(items, [
    ['/start/', 'はじめに', '試しの分類の説明', '2 件の記事'],
    ['/record/', '会議を記録する', '録音の試しの説明', '1 件の記事'],
    ['/admin/', '管理者向け', '記事の無い分類', '0 件の記事'],
  ]);
  // 分類のアイコンは help/assets/icons の線の絵をそのまま差し込む（色は文字の色。http の名前空間は書かない）
  assert.ok(cats.includes('<svg class="ic" viewBox="0 0 24 24"'), 'アイコン');
  assert.ok(!/xmlns/.test(cats));
  const feat = h.slice(h.indexOf('<h2 id="hc-featured">はじめての方へ</h2>'));
  assert.ok(feat.length > 0 && h.includes('<h2 id="hc-featured">はじめての方へ</h2>'));
  const rows = feat.slice(0, feat.indexOf('</ul>'));
  assert.deepStrictEqual([...rows.matchAll(/<li><a href="([^"]+)">([^<]+)<\/a><span class="desc">([^<]+)<\/span><\/li>/g)].map((m) => [m[1], m[2]]), [['/start/steps/', '試しの手順の記事'], ['/record/pause/', '試しの一時停止']]);
  // 分類のページ: パンくず・題名・説明・記事の一覧。記事の無い分類は「まだありません」
  const c = html('start/index.html');
  assert.ok(c.includes('<h1>はじめに</h1>') && c.includes('<p class="lede">試しの分類の説明</p>'));
  assert.ok(c.includes('<li><a href="/start/first/">試しの最初の記事</a><span class="desc">作る道具のテストに使う、見出しが2つの記事</span></li>'));
  assert.ok(c.includes('<a href="/start/" aria-current="page">はじめに</a>'), '左の目次で今の分類に印');
  assert.ok(html('admin/index.html').includes('<p class="empty">この分類の記事はまだありません。</p>'));
  // 404
  const nf = html('404.html');
  assert.ok(nf.includes('<h1>ページが見つかりません</h1>') && nf.includes('<a href="/">ホームへ戻る</a>'));
  assert.ok(!nf.includes('試しの'), '404 に記事の文字がある');
});

test('H-3: 作るのを止める（記事の形の誤り・無い related・作る道具の id と重なる hc- の id）。止めたときは出力に何も書かない', { timeout: 5000 }, (t) => {
  const cases = [
    ['raw-html', (h) => fs.appendFileSync(path.join(h, 'articles', 'start', 'first.md'), '\n<b>x</b>\n'), 'help/articles/start/first.md'],
    ['missing-article', (h) => { const f = path.join(h, 'articles', 'record', 'pause.md'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('related: start/first, start/steps', 'related: start/none')); }, 'help/articles/record/pause.md'],
    ['missing-anchor', (h) => { const f = path.join(h, 'articles', 'record', 'pause.md'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('{#hotkey}', '{#keys}').replace('(#hotkey)', '(#keys)')); }, 'help/articles/start/first.md'],
    ['syntax', (h) => fs.appendFileSync(path.join(h, 'articles', 'start', 'first.md'), '\n## 予約 {#hc-main}\n'), 'help/articles/start/first.md'],
    ['bad-front', (h) => { const f = path.join(h, 'articles', 'start', 'first.md'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('updated: 2026-10-21', 'updated: 2026-13-01')); }, 'help/articles/start/first.md'],
  ];
  for (const [code, edit, file] of cases) {
    const root = fixtureRoot(t, edit);
    const out = path.join(root, 'out');
    assert.throws(() => build({ root, out }), (e) => e.name === 'HelpBuildError' && e.code === code && e.file === file && (code === 'missing-article' || Number.isInteger(e.line)), code);
    assert.ok(!fs.existsSync(out), `${code}: 止めたのに出力がある`);
  }
});

test('H-1: 書き出す先が元のフォルダ・その中・それを含む所なら bad-out で止め、何も消さない。help の中は help/dist とその下だけ', { timeout: 5000 }, (t) => {
  const root = fixtureRoot(t);
  const h = path.join(root, 'help');
  const before = listFiles(h);
  const bad = [root, path.dirname(root), h, path.join(h, 'articles'), path.join(h, 'articles', 'start'), path.join(h, 'assets'), path.join(h, 'assets', 'fonts'), path.join(h, 'other'), path.join(h, 'distx')];
  for (const out of bad) {
    assert.throws(() => build({ root, out }), (e) => e.name === 'HelpBuildError' && e.code === 'bad-out', out);
    assert.deepStrictEqual(listFiles(h), before, `${out}: 元のファイルを消した`);
  }
  for (const out of [path.join(h, 'dist'), path.join(h, 'dist', 'sub'), path.join(root, 'out')]) {
    build({ root, out });
    assert.ok(fs.existsSync(path.join(out, 'index.html')), out);
  }
});

// help-dads HD-1（HD1・HD7・重要 1・重要 2。計画 docs/plans/2026-10-23-help-dads.md の決めたこと A〜C）: 白黒が基本のまま、色はリンクとキーボードの輪だけ。
// 色の値は決まった一覧（DADS の札の値と、DADS-PROTECT.md のブランド色）だけを通し、外れた色は「どの規則の、どの値か」を出す（持ち主の試作の state-store.js の SCHEMA の考え）
const DADS_COLORS = {
  '#ffffff': 'white', '#000000': 'black', '#333333': 'solid-gray-800', '#666666': 'solid-gray-600', '#cccccc': 'solid-gray-200', '#f2f2f2': 'solid-gray-50',
  '#00118f': 'blue-1000', '#0017c1': 'blue-900', '#8b008b': 'magenta-900', '#ac3e00': 'orange-900',
  '#9db7f9': 'blue-300', '#7096f8': 'blue-400', '#ff8eff': 'magenta-300', '#ffa66d': 'orange-300', '#ffd43d': 'yellow-300',
};
const brandColors = () => [...fs.readFileSync(path.join(ROOT, 'DADS-PROTECT.md'), 'utf8').matchAll(/^- (#[0-9a-f]{6})（/gm)].map((m) => m[1]);
// 文中のリンク（Q1「本文の中のリンクだけ」: 記事の本文・404・パンくず・一覧と関連記事の題名・/open のページの説明の文の中）
const BODY_LINKS = ['.body a', '.notfound a', '.crumbs a', '.rows li > a', '.open-note a'];

test('HD-1（HD7・HD5）: help.css の色の値は :root と暗い版の :root の札にだけ書き、値は DADS の札の値か DADS-PROTECT.md のブランド色だけ。明るい版の灰色は DADS の札（muted #666666・rule #cccccc・wash #f2f2f2）。グラデーション・text-shadow・filter・入れ子は無い。影と角丸は :focus-visible の決まった値だけ（COLOR-05）', { timeout: 5000 }, () => {
  const css = CSS();
  const rules = C.parse(css);
  const light = C.tokens(rules, '');
  const want = { '--bg': '#ffffff', '--ink': '#000000', '--body': '#333333', '--muted': '#666666', '--rule': '#cccccc', '--wash': '#f2f2f2',
    '--link': '#00118f', '--link-visited': '#8b008b', '--link-hover': '#0017c1', '--link-active': '#ac3e00' };
  for (const [k, v] of Object.entries(want)) assert.strictEqual((light[k] || '').toLowerCase(), v, k);
  const dark = C.tokens(rules, DARK);
  for (const k of Object.keys(want)) assert.ok(dark[k], `暗い版に ${k} が無い`);
  const lum = (v) => C.luminance(C.parseColor(v));
  assert.strictEqual(dark['--ink'].toLowerCase(), '#ffffff', '暗い版の ink は白');
  assert.ok(lum(dark['--bg']) < 0.02, '暗い版の地は黒に近い暗い灰');
  assert.ok(lum(dark['--rule']) < lum(dark['--muted']) && lum(dark['--wash']) < lum(dark['--rule']), '暗い版の並び（地 < 面 < 罫線 < 薄文字）');
  // 決まった一覧の色だけ（DADS の札・ブランド色）。色の値は :root の札にだけ書く
  const allowed = new Map([...Object.entries(DADS_COLORS), ...brandColors().map((c) => [c, 'ブランド色'])]);
  assert.ok(brandColors().length === 5, 'DADS-PROTECT.md のブランド色が読めない');
  const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:white|black)\b/g;
  let seen = 0;
  for (const r of rules) {
    for (const [k, val] of Object.entries(r.decls)) {
      for (const c of String(val).match(COLOR) || []) {
        seen++;
        const where = `${r.at ? `${r.at} ` : ''}${r.sel} の ${k}: ${c}`;
        assert.ok(r.sel === ':root' && (r.at === '' || r.at === DARK) && k.startsWith('--'), `札の外に色の値: ${where}`);
        assert.ok(allowed.has(c.toLowerCase()), `決まった一覧に無い色: ${where}`);
      }
    }
  }
  assert.ok(seen >= 20);
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/gradient|text-shadow|filter\s*:|backdrop-filter/i.test(plain), 'グラデーション・文字の影・ぼかしを使わない');
  // 影と角丸: :focus-visible の輪（DADS の黄色の縁 2px と角 4px）だけ。ほかの規則は角 0 のまま・影なし
  for (const r of rules) {
    const fv = r.sel.includes(':focus-visible');
    if (r.decls['box-shadow'] !== undefined) assert.ok(fv && r.decls['box-shadow'] === '0 0 0 calc(2 / 16 * 1rem) var(--focus-ring)', `${r.sel} に影: ${r.decls['box-shadow']}`);
    if (r.decls['border-radius'] !== undefined) assert.ok(r.decls['border-radius'] === '0' || (fv && r.decls['border-radius'] === 'calc(4 / 16 * 1rem)'), `${r.sel} に角丸: ${r.decls['border-radius']}`);
  }
  assert.ok(!rules.some((r) => r.nested), 'CSS の入れ子');
});

test('白黒: 文字と地の濃さの差が明暗の両方で 4.5:1 以上（本文・薄文字・見出し・注意の枠・コード・表の頭・選んでいる目次の行。HD-1: リンクの4つの色も地と面の両方で。DF1）。検索の箱の枠（--muted）は地と 3:1 以上', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  for (const at of ['', DARK]) {
    const v = (name) => C.parseColor(C.resolveVar(rules, `var(${name})`, at));
    const pairs = [['--body', '--bg'], ['--muted', '--bg'], ['--ink', '--bg'], ['--body', '--wash'], ['--muted', '--wash'], ['--ink', '--wash']];
    for (const k of ['--link', '--link-visited', '--link-hover', '--link-active']) pairs.push([k, '--bg'], [k, '--wash']);
    for (const [fg, bg] of pairs) {
      const r = C.contrast(v(fg), v(bg));
      assert.ok(r >= 4.5, `${at || '明るい'}: ${fg} と ${bg} が ${r.toFixed(2)}:1`);
    }
    assert.ok(C.contrast(v('--muted'), v('--bg')) >= 3, `${at || '明るい'}: 検索の箱の枠と地が 3:1 に届かない`);
    // 部品に書いた色が札を通っている（直に色を書くと暗い版で反転しない）
    for (const r of rules) {
      if (r.sel === ':root' || r.at.startsWith('@font-face')) continue;
      for (const [k, val] of Object.entries(r.decls)) {
        if (/^(color|background|background-color|border(-[a-z]+)*|outline(-color)?|text-decoration-color|box-shadow)$/.test(k)) {
          assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|\b(white|black)\b/i.test(val), `${r.sel} の ${k} に札を通らない色: ${val}`);
        }
      }
    }
  }
});

test('HD-1（HD1・Q1・Q2・Q10。重要 2）: 文中のリンク（本文・404・パンくず・一覧の題名・/open の説明）は :any-link で var(--link) と下線（文字と同じ色・1px・3px 空け）、:visited で var(--link-visited)、ホバーで var(--link-hover) と 3px、押している間 var(--link-active) と 1px。ホバーの規則はどれも @media (hover: hover) の中。左の目次・このページの内容・検索の結果・分類のカード・上の帯の名前は青にしない', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  const HOVER = '@media (hover: hover)';
  for (const sel of BODY_LINKS) {
    const any = C.declsFor(rules, `${sel}:any-link`, { at: '' });
    assert.strictEqual(any.color, 'var(--link)', `${sel}:any-link の色`);
    assert.strictEqual(any['text-decoration-line'] || any['text-decoration'], 'underline', `${sel} の下線`);
    assert.strictEqual(any['text-decoration-color'], 'currentColor', `${sel} の下線の色`);
    assert.strictEqual(any['text-decoration-thickness'], 'calc(1 / 16 * 1rem)', `${sel} の下線の太さ`);
    assert.strictEqual(any['text-underline-offset'], 'calc(3 / 16 * 1rem)', `${sel} の下線の空き`);
    assert.strictEqual(C.declsFor(rules, `${sel}:visited`, { at: '' }).color, 'var(--link-visited)', `${sel}:visited`);
    const hv = C.declsFor(rules, `${sel}:hover`, { at: HOVER });
    assert.strictEqual(hv.color, 'var(--link-hover)', `${sel}:hover の色`);
    assert.strictEqual(hv['text-decoration-thickness'], 'calc(3 / 16 * 1rem)', `${sel}:hover の下線`);
    const ac = C.declsFor(rules, `${sel}:active`, { at: '' });
    assert.strictEqual(ac.color, 'var(--link-active)', `${sel}:active の色`);
    assert.strictEqual(ac['text-decoration-thickness'], 'calc(1 / 16 * 1rem)', `${sel}:active の下線`);
  }
  // 文中のリンクの色を後から上書きする規則（.crumbs a { color: var(--muted) } など）が無い
  for (const r of rules) {
    if (!/(^|,\s*)(\.body|\.notfound|\.crumbs|\.rows li >|\.open-note) a(?![\w-])/.test(r.sel) || r.sel.includes(':')) continue;
    assert.strictEqual(r.decls.color, undefined, `${r.sel} がリンクの色を上書き: ${r.decls.color}`);
  }
  // ホバーの規則（:hover を含む）はどれも @media (hover: hover) の中（スマホで押した後に残らない）
  for (const r of rules) if (r.sel.includes(':hover')) assert.strictEqual(r.at, HOVER, `${r.sel} が @media (hover: hover) の外`);
  // ナビゲーションは黒のまま（DADS の目次の部品も地の文字の色を継ぐ）
  for (const r of rules) {
    if (/\.(toc|onpage|search-results|cats|brand)\b/.test(r.sel)) {
      for (const k of ['color', 'text-decoration-color']) assert.ok(!/--link/.test(r.decls[k] || ''), `${r.sel} の ${k} が青`);
    }
  }
});

test('HD-1（重要 1）: 検索の箱は 1px の枠（var(--muted)）で、地は var(--bg)（面の地と枠なしでは箱と分からない）。角は 0 のまま', { timeout: 5000 }, () => {
  const d = C.declsFor(C.parse(CSS()), '.search-q', { at: '' });
  assert.strictEqual(d.border, '1px solid var(--muted)');
  assert.strictEqual(d.background, 'var(--bg)');
  assert.strictEqual(d['border-radius'], '0');
});

test('画面の使いやすさ: help.css に :focus-visible の輪があり、outline: none で消す規則が無い。640px より狭いときは左右 16px の余白で、min-width の固定が無い', { timeout: 5000 }, () => {
  const css = CSS();
  const rules = C.parse(css);
  const fv = rules.filter((r) => r.sel.includes(':focus-visible'));
  assert.ok(fv.length > 0, ':focus-visible の規則が無い');
  for (const r of rules) assert.ok(!/^(none|0)$/.test((r.decls.outline || '').trim()), `${r.sel} が outline を消す`);
  const narrow = rules.filter((r) => r.at === '@media (max-width: 639px)');
  assert.ok(narrow.length > 0, '狭い画面の規則が無い');
  for (const sel of ['.wrap', '.foot-in']) {
    const d = C.declsFor(narrow, sel);
    assert.ok(d['padding-left'] === '16px' && d['padding-right'] === '16px', `${sel} の左右の余白`);
  }
  // 上の帯の左右の余白は --top-gutter（5回目の指摘 2）。狭い画面では 16px
  assert.strictEqual(C.resolveVar(rules, C.declsFor(rules, '.top-in', { at: '' }).padding, '@media (max-width: 639px)'), '0 16px', '.top-in の左右の余白');
  for (const r of rules) assert.ok(!/\d+px/.test(r.decls['min-width'] || ''), `${r.sel} に min-width の固定`);
  // 横のはみ出し: 表とコードの塊はその中で横に送る。本文の長い住所は折り返す
  assert.strictEqual(C.declsFor(rules, '.table')['overflow-x'], 'auto');
  assert.strictEqual(C.declsFor(rules, 'pre')['overflow-x'], 'auto');
  assert.ok(/break-word|anywhere/.test(C.declsFor(rules, '.body')['overflow-wrap'] || ''));
});

test('HD-2（HD2・HD5・DF1）: キーボードの輪は DADS の形（黒 4px・2px 空け・角 4px・yellow-300 の 2px の縁）。暗い版は白＋黄色。リンクは地を黄色・文字を黒に（中の文字も黒）。輪と地は明暗で 3:1 以上・黄色の上の黒は 4.5:1 以上', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  const fv = C.declsFor(rules, ':focus-visible', { at: '' });
  assert.strictEqual(fv.outline, 'calc(4 / 16 * 1rem) solid var(--focus-outline)');
  assert.strictEqual(fv['outline-offset'], 'calc(2 / 16 * 1rem)');
  assert.strictEqual(fv['border-radius'], 'calc(4 / 16 * 1rem)');
  assert.strictEqual(fv['box-shadow'], '0 0 0 calc(2 / 16 * 1rem) var(--focus-ring)');
  // 文中のリンクの色（.body a:any-link など）より強く効かせる（暗い版の本文の色が黄色の上に残ると読めない）
  const la = C.declsFor(rules, 'a:focus-visible', { at: '' });
  assert.strictEqual(la['background-color'], 'var(--focus-link-bg) !important');
  assert.strictEqual(la.color, 'var(--focus-link-ink) !important');
  for (const sel of ['.cats a:focus-visible .t', '.cats a:focus-visible .d', '.cats a:focus-visible .c', '.cats a:focus-visible .ic']) assert.strictEqual(C.declsFor(rules, sel, { at: '' }).color, 'var(--focus-link-ink)', sel);
  const light = C.tokens(rules, '');
  const dark = C.tokens(rules, DARK);
  assert.strictEqual((light['--focus-outline'] || '').toLowerCase(), '#000000');
  assert.strictEqual((dark['--focus-outline'] || '').toLowerCase(), '#ffffff', '暗い版の輪が白でない');
  for (const k of ['--focus-ring', '--focus-link-bg']) assert.strictEqual((light[k] || '').toLowerCase(), '#ffd43d', k);
  assert.strictEqual((light['--focus-link-ink'] || '').toLowerCase(), '#000000');
  for (const at of ['', DARK]) {
    const v = (name) => C.parseColor(C.resolveVar(rules, `var(${name})`, at));
    for (const bg of ['--bg', '--wash']) assert.ok(C.contrast(v('--focus-outline'), v(bg)) >= 3, `${at || '明るい'}: 輪と ${bg}`);
    assert.ok(C.contrast(v('--focus-link-ink'), v('--focus-link-bg')) >= 4.5, `${at || '明るい'}: 黄色の上の文字`);
  }
  // 輪を消す・弱める規則が無い（outline: none・0 と、:focus-visible の外の outline の上書き）
  for (const r of rules) if (r.decls.outline !== undefined) assert.ok(r.sel.includes(':focus-visible') || r.at === '@media (forced-colors: active)', `${r.sel} が outline を書く`);
});

test('HD-3（HD4・Q3）: 文字の大きさはどれも rem・em・inherit（px が無い。ブラウザの文字の設定に従う）。body は 1rem。説明・目次・パンくず・このページの内容・検索の箱・メモは 1rem（16px）、補足は .875rem（14px）以上', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  for (const r of rules) {
    const fs0 = r.decls['font-size'];
    if (fs0 === undefined) continue;
    assert.match(fs0, /^(?:\d*\.?\d+(?:rem|em)|inherit)$/, `${r.at ? `${r.at} ` : ''}${r.sel} の font-size: ${fs0}`);
    if (/rem$/.test(fs0)) assert.ok(parseFloat(fs0) >= 0.875, `${r.sel} の文字が 14px より小さい: ${fs0}`);
  }
  const size = (sel, at = '') => C.declsFor(rules, sel, { at })['font-size'];
  assert.strictEqual(size('body'), '1rem');
  for (const sel of ['.crumbs', '.toc', '.onpage', '.rows .desc', '.cats .d', '.search-q', '.note']) assert.strictEqual(size(sel), '1rem', `${sel} は 16px`);
  for (const sel of ['.toc-h', '.onpage-h', '.article-meta dt', '.cats .c', '.search-results .rc', '.step .k', '.foot-in']) {
    const v = size(sel);
    assert.ok(/rem$/.test(v || '') && parseFloat(v) >= 0.875, `${sel} は 14px 以上: ${v}`);
  }
});

// 3回目の審査の指摘 5（持ち主の答え「直す」）: 文字の大きさを DADS の文字スタイルの段（14・16・17・18・20・22・24・26・28・32・36…px）にそろえる。
// kbd・code は rem の 14px（em だと表の中で 12.5px になった）。持ち主が残したもの（表の .92rem・狭い画面の h1・手順の大きな数字）はそのまま
test('3回目の指摘 5: font-size の rem はどれも DADS の段の値（残した3つを除く）。em の font-size が無い。kbd・code は .875rem（表の中でも 14px）', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  const SCALE = new Set([14, 16, 17, 18, 20, 22, 24, 26, 28, 32, 36, 45, 57, 64].map((px) => px / 16));
  const KEPT = new Map([['table', '.92rem'], ['h1', '1.6rem'], ['.step .n', '3.2rem']]);
  for (const r of rules) {
    const v = r.decls['font-size'];
    if (v === undefined || v === 'inherit') continue;
    assert.ok(!/em$/.test(v) || /rem$/.test(v), `${r.sel} の font-size が em: ${v}`);
    if (KEPT.get(r.sel) === v) continue;
    assert.ok(SCALE.has(parseFloat(v)), `${r.at ? `${r.at} ` : ''}${r.sel} の font-size が DADS の段に無い: ${v}`);
  }
  assert.strictEqual(C.declsFor(rules, 'kbd', { at: '' })['font-size'], '.875rem');
  assert.strictEqual(C.declsFor(rules, 'code', { at: '' })['font-size'], '.875rem');
  assert.strictEqual(C.declsFor(rules, '.body h2', { at: '' })['font-size'], '1.25rem');
  assert.strictEqual(C.declsFor(rules, '.lede', { at: '' })['font-size'], '1.0625rem');
});

test('HD-3（HD4・DF5）: 48rem 未満（@media (max-width: 47.9375rem)）だけで、［目次］・検索の箱・左の目次の行・パンくずのリンク・/open の［NaTsu で開く］の押す場所が 44px（calc(44 / 16 * 1rem)）。広い画面には効かない', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  const NARROW = '@media (max-width: 47.9375rem)';
  const TAP = ['.toc-btn', '.search-q', '.toc li a', '.crumbs a', '.open-go'];
  for (const sel of TAP) assert.strictEqual(C.declsFor(rules, sel, { at: NARROW })['min-height'], 'calc(44 / 16 * 1rem)', sel);
  // 再審査: ［目次］のボタンは広い画面（隠れている）でもブラウザの既定の 13.33px でなく本文の書体を継ぐ
  assert.strictEqual(C.declsFor(rules, '.toc-btn', { at: '' }).font, 'inherit');
  for (const sel of ['.toc li a', '.crumbs a', '.open-go']) {
    const d = C.declsFor(rules, sel, { at: NARROW });
    assert.ok(/flex$/.test(d.display || '') && d['align-items'] === 'center', `${sel} の文字が 44px の真ん中に来ない`);
  }
  for (const r of rules) {
    if (r.decls['min-height'] === undefined || r.at === NARROW) continue;
    for (const sel of TAP) assert.ok(!r.sel.split(',').map((x) => x.trim()).includes(sel), `${sel} の min-height が 48rem 未満の外にある（${r.at || '基底'}）`);
  }
});

test('再審査の指摘 2・3: 強制カラー（ハイコントラスト）でも検索の選んだ行が分かる（Highlight の左の線と輪。ほかの行の線は Canvas）。左の目次は送るときに上下 6px 余らせる（scroll-padding-block。送った後の行の輪が切れない: DF4）', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  const FC = '@media (forced-colors: active)';
  assert.strictEqual(C.declsFor(rules, '.search-results a', { at: FC })['border-left-color'], 'Canvas');
  const sel = C.declsFor(rules, '.search-results a[aria-selected="true"]', { at: FC });
  assert.strictEqual(sel['border-left'], 'calc(4 / 16 * 1rem) solid Highlight');
  assert.strictEqual(sel.outline, 'calc(2 / 16 * 1rem) solid Highlight');
  assert.strictEqual(sel['outline-offset'], 'calc(-2 / 16 * 1rem)');
  assert.strictEqual(C.declsFor(rules, '.toc', { at: '' })['scroll-padding-block'], 'calc(6 / 16 * 1rem)');
});

test('3回目の指摘 3・5回目の指摘 2: 48rem 未満では上の帯の検索の結果を上の帯の幅いっぱい（左右の余白の内側: 640px 以上は 24px、より狭いと 16px）に出す。結果の左右と上の帯の余白は1つの値 --top-gutter から取る（文字の設定を大きくしてもずれない。単位は Q3 の答えで px）。広い画面とホームの大きな箱は今のまま', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  const N48 = '@media (max-width: 47.9375rem)';
  const N639 = '@media (max-width: 639px)';
  assert.strictEqual(C.declsFor(rules, '.top-in', { at: N48 }).position, 'relative');
  assert.strictEqual(C.declsFor(rules, '.top-in .search', { at: N48 }).position, 'static');
  // 1つの値: 広い画面 24px・640px 未満 16px（Q3: 上の帯の余白は px のまま。DADS の rem の印はここでは受け入れる）
  assert.strictEqual(C.tokens(rules, '')['--top-gutter'], '24px');
  assert.strictEqual(C.tokens(rules, N639)['--top-gutter'], '16px');
  // 上の帯の余白はその値から取り、狭い画面でも別の値で上書きしない
  assert.strictEqual(C.declsFor(rules, '.top-in', { at: '' }).padding, '0 var(--top-gutter)');
  for (const at of [N639, N48]) {
    const d = C.declsFor(rules, '.top-in', { at });
    for (const k of ['padding', 'padding-left', 'padding-right']) assert.strictEqual(d[k], undefined, `${at} で .top-in の ${k} を別の値にした（結果の左右とずれる）`);
  }
  // 結果の左右も同じ値から取る（5回目の指摘 2: rem と px でずれていた）
  const r48 = C.declsFor(rules, '.top-in .search-results', { at: N48 });
  assert.deepStrictEqual([r48.left, r48.right], ['var(--top-gutter)', 'var(--top-gutter)'], '上の帯の結果の左右が上の帯の余白と同じ値でない');
  assert.deepStrictEqual(rules.filter((r) => r.at !== N48 && r.sel === '.top-in .search-results').map((r) => r.at), [], '上の帯の結果の左右をほかの所で上書きした');
  assert.deepStrictEqual([N48, N639].map((at) => C.resolveVar(rules, r48.left, at)), ['24px', '16px']);
  assert.strictEqual(C.declsFor(rules, '.top-in .search-results', { at: '' }).left, undefined, '広い画面の上の帯の一覧を変えた');
});

test('画面の使いやすさ: 広い画面の左の目次は止まる（sticky）が、窓より高くならずその中で縦に送れる（記事が 26・分類が 8 でも下の分類が切れない）。狭い画面では止めず、高さも切らない', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  const wide = C.declsFor(rules, '.toc', { at: '' });
  assert.strictEqual(wide.position, 'sticky');
  assert.strictEqual(wide.top, '24px');
  assert.strictEqual(wide['max-height'], 'calc(100vh - 48px)', '広い画面の目次に高さの上限が無い');
  assert.strictEqual(wide['overflow-y'], 'auto', '広い画面の目次がその中で縦に送れない');
  // 送れる箱は中の輪を切るので、内に輪の太さ＋空け（HD-2: 4px＋2px）の余白を取り、外へ同じだけ戻して位置を変えない（DF4）
  assert.strictEqual(wide.padding, 'calc(6 / 16 * 1rem)', 'HD-2: 目次の中の輪（4px＋空け 2px）が箱の端で切れる');
  assert.strictEqual(wide.margin, 'calc(-6 / 16 * 1rem)');
  const narrow = C.declsFor(rules, '.toc', { at: '@media (max-width: 639px)' });
  assert.strictEqual(narrow.position, 'static');
  assert.strictEqual(narrow['max-height'], 'none', '狭い画面で目次の高さを切っている');
  assert.strictEqual(narrow['overflow-y'], 'visible');
  assert.strictEqual(narrow.padding, '1rem 0 0');
  assert.strictEqual(narrow.margin, '2.5rem 0 0');
});

test('白黒: 大きな数字は順番のある手順（.step .n）にだけ。HD-4（HD3）: 書体は同梱の Noto Sans JP（本文）と Noto Sans Mono（コード。日本語の字は Noto Sans JP に落ちる）', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  const big = rules.filter((r) => /^[\d.]+rem$/.test(r.decls['font-size'] || '') && parseFloat(r.decls['font-size']) >= 2.5).map((r) => r.sel);
  assert.deepStrictEqual(big, ['.step .n']);
  const n = C.declsFor(rules, '.step .n');
  assert.strictEqual(n['font-weight'], '300');
  assert.strictEqual(n['font-size'], '3.2rem');
  const root = C.tokens(rules, '');
  assert.match(root['--sans'], /^"Noto Sans JP", /, 'HD-4: 本文の書体が Noto Sans JP でない');
  assert.match(root['--mono'], /^"Noto Sans Mono", "Noto Sans JP", /, 'HD-4: コードの書体が Noto Sans Mono でない');
  assert.ok(!/IBM|Plex/.test(CSS().replace(/\/\*[\s\S]*?\*\//g, '')), 'HD-4: IBM Plex が残っている');
  assert.strictEqual(C.declsFor(rules, 'body')['font-family'], 'var(--sans)');
  assert.strictEqual(C.declsFor(rules, 'code')['font-family'], 'var(--mono)');
  assert.ok(/1\.8/.test(C.declsFor(rules, 'body')['line-height']), '本文の行間 1.85 前後');
});

test('HD-4（HD3・DF2）: fonts.css の書体は help/assets/fonts の中のファイルだけ（外の配信なし）。Noto Sans JP の 300（数字だけ1つ）・400・700 と Noto Sans Mono の 400・700。使うファイルと置いたファイルがちょうど同じ・どれも woff2・一括の japanese と .woff が無い・合計 6.5 MB 以下・どの住所も門で private, max-age=3600。OFL.txt に Noto Sans JP と Noto Sans Mono の配布元の著作権の行', { timeout: 10000 }, async () => {
  const { pathToFileURL } = require('node:url');
  const { helpHeaders } = await import(pathToFileURL(path.join(ROOT, 'relay', 'help-gate.mjs')).href);
  const dir = path.join(ROOT, 'help', 'assets', 'fonts');
  const css = fs.readFileSync(path.join(ROOT, 'help', 'assets', 'fonts.css'), 'utf8');
  const faces = [...css.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => C.decls(m[1]));
  assert.ok(faces.length > 200);
  const used = new Set();
  const weights = { 'Noto Sans JP': new Set(), 'Noto Sans Mono': new Set() };
  let light = 0;
  for (const f of faces) {
    const fam = f['font-family'].replace(/"/g, '');
    assert.ok(weights[fam], `知らない書体 ${fam}`);
    weights[fam].add(f['font-weight']);
    assert.strictEqual(f['font-display'], 'swap');
    const m = /^url\("\/assets\/fonts\/([a-z0-9-]{1,40}\.woff2)"\) format\("woff2"\)$/.exec(f.src);
    assert.ok(m, `src の形: ${f.src}`);
    assert.match(m[1], /^noto-sans-(jp|mono)-[a-z0-9-]+-(300|400|700)-normal\.woff2$/, m[1]);
    assert.ok(!m[1].includes('japanese'), `一括のファイル: ${m[1]}`);
    assert.strictEqual(m[1].startsWith('noto-sans-mono-'), fam === 'Noto Sans Mono', `書体と名前が合わない: ${m[1]}`);
    assert.ok(m[1].endsWith(`-${f['font-weight']}-normal.woff2`), `太さと名前が合わない: ${m[1]}`);
    used.add(m[1]);
    assert.strictEqual(helpHeaders(`/assets/fonts/${m[1]}`, 200)['cache-control'], 'private, max-age=3600', `門がキャッシュさせない: ${m[1]}`);
    if (f['font-weight'] === '300') { light++; assert.strictEqual(f['unicode-range'], 'U+0030-0039', '300 は数字だけ'); }
  }
  assert.strictEqual(light, 1, '300 は1つだけ');
  assert.deepStrictEqual([...weights['Noto Sans JP']].sort(), ['300', '400', '700']);
  assert.deepStrictEqual([...weights['Noto Sans Mono']].sort(), ['400', '700']);
  const all = fs.readdirSync(dir);
  assert.deepStrictEqual(all.filter((f) => !f.endsWith('.woff2')), ['OFL.txt'], 'woff2 と OFL.txt のほかのファイル（.woff など）がある');
  const onDisk = all.filter((f) => f.endsWith('.woff2')).sort();
  assert.deepStrictEqual([...used].sort(), onDisk, '使わない書体のファイルがある・無いファイルを指す');
  let bytes = 0;
  for (const f of onDisk) {
    const buf = fs.readFileSync(path.join(dir, f));
    bytes += buf.length;
    assert.strictEqual(buf.subarray(0, 4).toString('latin1'), 'wOF2', f);
  }
  assert.ok(bytes <= 6.5 * 1024 * 1024, `書体の合計が 6.5 MB を越える: ${bytes}`);
  assert.ok(!/https?:|\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\("\/assets\/fonts\//g, '')), '外の住所');
  const ofl = fs.readFileSync(path.join(dir, 'OFL.txt'), 'utf8');
  assert.ok(ofl.includes('SIL Open Font License') && ofl.includes('Version 1.1'));
  assert.ok(ofl.includes("Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'"), 'Noto Sans JP の著作権の行');
  assert.ok(ofl.includes('Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)'), 'Noto Sans Mono の著作権の行');
  assert.ok(!/IBM|Plex/.test(ofl), 'OFL.txt に IBM Plex の行が残っている');
  assert.ok(!/https?:|@import/.test(CSS().replace(/\/\*[\s\S]*?\*\//g, '')), 'help.css が外を読む');
});

test('H-3: site.js は［目次］の開け閉めだけ（外へ通信しない・innerHTML も eval も無い）', { timeout: 5000 }, () => {
  const js = fs.readFileSync(path.join(ROOT, 'help', 'assets', 'site.js'), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write|localStorage|https?:/.test(js));
  assert.match(js, /aria-expanded/);
  assert.match(js, /classList\.add\('js'\)/);
});

// 再審査の指摘 5（持ち主の答え「全部直す」）: 表の領域の tabindex="0" は、横に送れるとき（scrollWidth > clientWidth）だけ site.js が付け、窓の大きさが変わったら付け外しする
test('再審査の指摘 5: site.js は横に送れる表の領域にだけ tabindex="0" を付け、resize で付け外しする（style は書かない）', { timeout: 5000 }, () => {
  const vm = require('node:vm');
  const { parseHTML } = require('./helpers/simdom');
  const { root } = parseHTML('<!doctype html><html><body><div class="table" role="region" aria-label="a"><table></table></div><div class="table" role="region" aria-label="b"><table></table></div></body></html>');
  const [wide, fit] = root.querySelectorAll('.table');
  wide.scrollWidth = 640; wide.clientWidth = 343;
  fit.scrollWidth = 343; fit.clientWidth = 343;
  const listeners = {};
  const document = { documentElement: root.querySelector('html'), querySelector: (q) => root.querySelector(q), querySelectorAll: (q) => root.querySelectorAll(q), getElementById: () => null };
  const window = { addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } };
  const js = fs.readFileSync(path.join(ROOT, 'help', 'assets', 'site.js'), 'utf8');
  vm.runInContext(js, vm.createContext({ document, window }), { filename: 'site.js' });
  assert.strictEqual(wide.getAttribute('tabindex'), '0', '送れる表に tabindex が無い');
  assert.strictEqual(fit.getAttribute('tabindex'), null, '送れない表に tabindex');
  wide.scrollWidth = 343;
  fit.scrollWidth = 700;
  assert.ok((listeners.resize || []).length > 0, 'resize を見ていない');
  for (const fn of listeners.resize) fn({ type: 'resize' });
  assert.strictEqual(wide.getAttribute('tabindex'), null, '広くなっても tabindex が残る');
  assert.strictEqual(fit.getAttribute('tabindex'), '0');
  assert.ok(!/\.style\b|setAttribute\(['"]style/.test(js), 'site.js が style を書く');
});

// 3回目の審査の指摘 1（WCAG 2.4.3。持ち主の答え B）: 狭い画面では目次が［目次］のすぐ下に開くのに、HTML では本文の後ろにあるので Tab が目次を飛ばした。
// 狭い間（CSS の order と同じ (max-width: 639px)）だけ、site.js が目次の nav を DOM で［目次］の直後へ移し、広くなれば本文の後ろへ戻す（1280px の Tab の順は Q12 のまま）
test('6回目の指摘（WCAG 2.1.1。リリースノートの審査役が見つけた前からのもの）: site.js は本文のコードの塊（main pre）も、横に送れるときだけ tabindex="0" と名前（role="region"・aria-label。2つ以上あれば「コード 1」「コード 2」）を付け、resize で付け外しする。表と同じ扱い', { timeout: 5000 }, () => {
  const vm = require('node:vm');
  const { parseHTML } = require('./helpers/simdom');
  const { root } = parseHTML('<!doctype html><html><body><header><pre id="out">外</pre></header><main><pre id="p1"><code>a</code></pre><pre id="p2"><code>b</code></pre></main></body></html>');
  const p1 = root.querySelector('#p1');
  const p2 = root.querySelector('#p2');
  const out = root.querySelector('#out');
  p1.scrollWidth = 917; p1.clientWidth = 614;
  p2.scrollWidth = 300; p2.clientWidth = 614;
  out.scrollWidth = 999; out.clientWidth = 10;
  const listeners = {};
  const document = { documentElement: root.querySelector('html'), querySelector: (q) => root.querySelector(q), querySelectorAll: (q) => root.querySelectorAll(q), getElementById: () => null };
  const window = { addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } };
  const js = fs.readFileSync(path.join(ROOT, 'help', 'assets', 'site.js'), 'utf8');
  vm.runInContext(js, vm.createContext({ document, window }), { filename: 'site.js' });
  const attrs = (el) => [el.getAttribute('tabindex'), el.getAttribute('role'), el.getAttribute('aria-label')];
  assert.deepStrictEqual(attrs(p1), ['0', 'region', 'コード 1'], '送れるコードの塊に tabindex と名前が無い');
  assert.deepStrictEqual(attrs(p2), [null, null, null], '送れないコードの塊に付けた');
  assert.deepStrictEqual(attrs(out), [null, null, null], 'main の外の pre に付けた');
  p1.scrollWidth = 614;
  p2.scrollWidth = 900;
  assert.ok((listeners.resize || []).length > 0, 'resize を見ていない');
  for (const fn of listeners.resize) fn({ type: 'resize' });
  assert.deepStrictEqual(attrs(p1), [null, null, null], '送れなくなっても残る');
  assert.deepStrictEqual(attrs(p2), ['0', 'region', 'コード 2']);
  // コードの塊が1つだけなら名前は「コード」
  const one = parseHTML('<!doctype html><html><body><main><pre id="only"><code>c</code></pre></main></body></html>').root;
  const only = one.querySelector('#only');
  only.scrollWidth = 900; only.clientWidth = 300;
  const d1 = { documentElement: one.querySelector('html'), querySelector: (q) => one.querySelector(q), querySelectorAll: (q) => one.querySelectorAll(q), getElementById: () => null };
  vm.runInContext(js, vm.createContext({ document: d1, window: { addEventListener() {} } }), { filename: 'site.js' });
  assert.deepStrictEqual(attrs(only), ['0', 'region', 'コード']);
  assert.ok(!/\.style\b|setAttribute\(['"]style/.test(js), 'site.js が style を書く');
});

test('3回目の指摘 1: site.js は狭い画面（matchMedia の (max-width: 639px)）の間だけ目次を［目次］の直後へ移し、広くなれば本文の後ろ（元の場所）へ戻す。matchMedia が無ければ動かさない。CSS の order の切り替えも同じ幅', { timeout: 5000 }, (t) => {
  const vm = require('node:vm');
  const { parseHTML } = require('./helpers/simdom');
  const { html } = buildFixture(t);
  const run = (narrow) => {
    const { root } = parseHTML(html('start/steps/index.html'));
    const media = [];
    const document = { documentElement: root.querySelector('html'), querySelector: (q) => root.querySelector(q), querySelectorAll: (q) => root.querySelectorAll(q), getElementById: (id) => root.querySelector(`#${id}`) };
    const window = { addEventListener() {} };
    if (narrow !== undefined) window.matchMedia = (q) => { const m = { media: q, matches: narrow, fns: [], addEventListener: (ty, fn) => { if (ty === 'change') m.fns.push(fn); } }; media.push(m); return m; };
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'help', 'assets', 'site.js'), 'utf8'), vm.createContext({ document, window }), { filename: 'site.js' });
    const layout = root.querySelector('.layout');
    const order = () => layout.children.map((e) => (e.id || e.className || e.tagName).split(' ')[0]);
    const flip = (m) => { media[0].matches = m; for (const fn of media[0].fns) fn({ matches: m }); };
    return { order, flip, media };
  };
  const WIDE = ['toc-btn', 'hc-main', 'hc-toc', 'onpage'];
  const NARROW = ['toc-btn', 'hc-toc', 'hc-main', 'onpage'];
  const n = run(true);
  assert.deepStrictEqual(n.media.map((m) => m.media), ['(max-width: 639px)']);
  assert.deepStrictEqual(n.order(), NARROW, '狭い画面で目次が［目次］の直後に無い');
  n.flip(false);
  assert.deepStrictEqual(n.order(), WIDE, '広くなっても目次が本文の後ろへ戻らない（1280px の Tab の順が変わる）');
  n.flip(true);
  assert.deepStrictEqual(n.order(), NARROW);
  assert.deepStrictEqual(run(false).order(), WIDE, '広い画面で目次を動かした');
  assert.deepStrictEqual(run(undefined).order(), WIDE, 'matchMedia が無いのに動かした');
  // CSS の見た目の並び（order）を切り替える幅と同じ
  const rules = C.parse(CSS());
  assert.strictEqual(C.declsFor(rules, '.js .toc', { at: '@media (max-width: 639px)' }).order, '-1');
});

// 4回目の審査の指摘 2: 目次を DOM で動かすと、ブラウザーは中のフォーカスを外して body に戻す。目次の中にフォーカスがあったら、動かした後にそこへ戻す
test('4回目の指摘 2: site.js が目次を動かすとき（640px の境をまたぐ）、目次の中にあったフォーカスを動かした後に戻す（preventScroll）。目次の外のフォーカスには触らない', { timeout: 5000 }, (t) => {
  const vm = require('node:vm');
  const { parseHTML, Element } = require('./helpers/simdom');
  const { html } = buildFixture(t);
  const { root } = parseHTML(html('start/steps/index.html'));
  const media = [];
  const focusCalls = [];
  const document = { documentElement: root.querySelector('html'), querySelector: (q) => root.querySelector(q), querySelectorAll: (q) => root.querySelectorAll(q), getElementById: (id) => root.querySelector(`#${id}`), get activeElement() { return Element.focused || root.querySelector('body'); } };
  const window = { addEventListener() {}, matchMedia: (q) => { const m = { media: q, matches: true, fns: [], addEventListener: (ty, fn) => { if (ty === 'change') m.fns.push(fn); } }; media.push(m); return m; } };
  const layout = root.querySelector('.layout');
  // 本物のブラウザーと同じく、動かした要素の中にフォーカスがあれば外す
  const insert = layout.insertBefore.bind(layout);
  layout.insertBefore = (n, ref) => {
    let f = Element.focused;
    while (f && f !== n) f = f.parentNode;
    if (f === n) Element.focused = null;
    return insert(n, ref);
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'help', 'assets', 'site.js'), 'utf8'), vm.createContext({ document, window }), { filename: 'site.js' });
  const flip = (m) => { media[0].matches = m; for (const fn of media[0].fns) fn({ matches: m }); };
  const link = root.querySelector('#hc-toc li a');
  const orig = link.focus.bind(link);
  link.focus = (opt) => { focusCalls.push(JSON.stringify(opt)); orig(); };
  link.focus();
  focusCalls.length = 0;
  flip(false);
  assert.strictEqual(Element.focused, link, '広くなって目次を動かしたら、目次の中のフォーカスが外れた');
  assert.deepStrictEqual(focusCalls, [JSON.stringify({ preventScroll: true })]);
  flip(true);
  assert.strictEqual(Element.focused, link, '狭くなって目次を動かしたら、目次の中のフォーカスが外れた');
  // 目次の外（本文のリンク）にあるフォーカスには触らない
  const out = root.querySelector('main a');
  out.focus();
  focusCalls.length = 0;
  flip(false);
  assert.strictEqual(Element.focused, out);
  assert.deepStrictEqual(focusCalls, []);
  Element.focused = null;
});

// H-11（R7）: 画面の写真は CI の基準にしないが、CSS を変えたら撮り直す。tools/help-shots.js が最後に撮った CSS の指紋を help/shots.json に書く。
// 指紋はファイルごとの SHA-256 の base64url（改行を LF にそろえてから。Windows の取り出しの CRLF でも同じ。16進の 64 字はゲートが AUD の見かけとして止める）
test('R7: help/shots.json の CSS の指紋が、今の help/assets/*.css の指紋と同じ（CSS を変えたら node tools/help-shots.js で撮り直す）', { timeout: 5000 }, () => {
  const crypto = require('node:crypto');
  const p = path.join(ROOT, 'help', 'shots.json');
  assert.ok(fs.existsSync(p), 'help/shots.json が無い（node tools/help-shots.js で撮る）');
  const shots = JSON.parse(fs.readFileSync(p, 'utf8'));
  const dir = path.join(ROOT, 'help', 'assets');
  const now = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.css')).sort()) {
    now[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n?/g, '\n')).digest('base64url');
  }
  assert.ok(Object.keys(now).length >= 2);
  assert.deepStrictEqual(shots.css, now, 'CSS が撮った後に変わった。node tools/help-shots.js で撮り直し、写真を見てから help/shots.json を commit する');
  // 撮った組: ホーム・分類（record）・記事（record/pc-only）と試験利用の手順 × 明暗 × 1280 と 390
  assert.deepStrictEqual(shots.pages, ['/', '/record/', '/record/pc-only/', '/start/tester-guide/']);
  assert.deepStrictEqual(shots.schemes, ['light', 'dark']);
  assert.deepStrictEqual(shots.widths, [1280, 390]);
});

test('H-11: help-shots.js は作業環境の Playwright と Chromium の場所を環境変数で受け、無ければ使い方を出して 1（npm の依存を足さず、外へ通信しない）', { timeout: 5000 }, () => {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.HELP_SHOTS_PLAYWRIGHT;
  delete env.HELP_SHOTS_CHROMIUM;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'help-shots.js')], { env, encoding: 'utf8', timeout: 4000 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /HELP_SHOTS_PLAYWRIGHT/);
  assert.match(r.stderr, /HELP_SHOTS_CHROMIUM/);
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'help-shots.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]playwright/, 'Playwright はリポジトリの依存ではない（場所を HELP_SHOTS_PLAYWRIGHT で受ける）');
  assert.doesNotMatch(src, /https?:\/\/(?!127\.0\.0\.1)/, '写真の道具は 127.0.0.1 のほかへ通信しない');
  assert.match(src, /helpHeaders/, '門と同じ見出し（CSP）で出して撮る');
});
