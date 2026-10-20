/* help-build.test.js — ヘルプセンター H-3（HF3・HF4）: ページの組み立てと見た目
 *
 * テスト用の小さな記事の組（test/fixtures/help/）と本物の help/assets を写したフォルダで作る（リポジトリの help/dist には書かない）。
 * 見た目は利用者の後の指定（白黒。docs/plans/2026-10-20-help.md「見た目」）: 色の札・IBM Plex の同梱・ロゴのアイコンなし・
 * 大きな数字は順番のある手順だけ・白黒を反転した暗い版。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('./helpers/simcss');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'help');
const { build, checkPages } = require('../tools/help-build');

/** 写しのフォルダ: 記事の組（fixtures か、edit で書き換えたもの）と本物の help/assets */
function fixtureRoot(edit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-help-build-'));
  fs.mkdirSync(path.join(root, 'help'));
  fs.cpSync(path.join(FIX, 'site.json'), path.join(root, 'help', 'site.json'));
  fs.cpSync(path.join(FIX, 'articles'), path.join(root, 'help', 'articles'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'help', 'assets'), path.join(root, 'help', 'assets'), { recursive: true });
  if (edit) edit(path.join(root, 'help'));
  return root;
}
/** 作って、出力の全部のファイル（相対の道 → Buffer）を返す */
function buildFixture(edit) {
  const root = fixtureRoot(edit);
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

test('H-3: 作ると、ホーム・分類ごと・記事ごと・404・assets の全部のファイルができる（多くも少なくもない）', { timeout: 5000 }, () => {
  const { files, r } = buildFixture();
  const pages = ['index.html', '404.html', 'start/index.html', 'start/first/index.html', 'start/steps/index.html', 'record/index.html', 'record/pause/index.html', 'admin/index.html'];
  const assets = listFiles(path.join(ROOT, 'help', 'assets')).map((f) => `assets/${f}`);
  assert.deepStrictEqual([...files.keys()].sort(), [...pages, ...assets].sort());
  assert.deepStrictEqual([...r.pages].sort(), [...pages].sort());
  assert.deepStrictEqual(r.articles, [
    { ref: 'start/first', url: '/start/first/', title: '試しの最初の記事' },
    { ref: 'start/steps', url: '/start/steps/', title: '試しの手順の記事' },
    { ref: 'record/pause', url: '/record/pause/', title: '試しの一時停止' },
  ]);
  for (const a of assets) assert.ok(files.get(a).equals(fs.readFileSync(path.join(ROOT, 'help', a))), `${a} がそのまま写っていない`);
});

test('HF4: 作った全部のページの中の / で始まるリンクと #id が、出力のファイルと id にある（a・link・script・img の全部）', { timeout: 5000 }, () => {
  const { files, html } = buildFixture();
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

test('HF3: 出力のどの HTML にも style=・on…=・src の無い <script>・http:// が無い。どのページにも <meta name="natsu-help" content="page"> と lang="ja"', { timeout: 5000 }, () => {
  const { files, html } = buildFixture();
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
    assert.ok(h.includes('<script src="/assets/site.js" defer></script>'), `${f}: site.js`);
    // 白黒の指定: ロゴのアイコンを使わない（上の帯は文字だけ）
    const header = h.slice(h.indexOf('<header'), h.indexOf('</header>'));
    assert.ok(header.includes('<a class="brand" href="/">NaTsu ヘルプセンター</a>'), `${f}: 上の帯の題名`);
    assert.ok(!/<img|<svg|logo/.test(header), `${f}: 上の帯にロゴのアイコンがある`);
  }
});

test('H-3: 同じ元から2回作ると、全部のファイルが同じバイト（日付は記事の updated だけ）', { timeout: 5000 }, () => {
  const a = buildFixture();
  const b = buildFixture();
  assert.deepStrictEqual([...a.files.keys()].sort(), [...b.files.keys()].sort());
  for (const [f, buf] of a.files) assert.ok(buf.equals(b.files.get(f)), `${f} が違う`);
  const all = [...a.files].filter(([f]) => f.endsWith('.html')).map(([, v]) => v.toString('utf8')).join('\n');
  const years = new Set([...all.matchAll(/20\d\d/g)].map((m) => m[0]));
  assert.deepStrictEqual([...years], ['2026'], '記事の updated のほかの日付がある');
});

test('H-3: 記事のページにパンくず・題名・最終更新日（2026 年 10 月 21 日）・左の目次で今の記事に aria-current="page"・関連記事・askNote がある', { timeout: 5000 }, () => {
  const { html } = buildFixture();
  const h = html('start/first/index.html');
  assert.ok(h.includes('<title>試しの最初の記事 — NaTsu ヘルプセンター</title>'));
  assert.match(h, /<nav class="crumbs" aria-label="パンくず"><a href="\/">ホーム<\/a> <span aria-hidden="true">›<\/span> <a href="\/start\/">はじめに<\/a><\/nav>/);
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

test('H-3: 「このページの内容」は linkable な ## が3つ以上の記事にだけ出る', { timeout: 5000 }, () => {
  const { html } = buildFixture();
  const s = html('start/steps/index.html');
  assert.ok(s.includes('<aside class="onpage" aria-labelledby="hc-onpage">'));
  const on = s.slice(s.indexOf('<aside class="onpage"'), s.indexOf('</aside>', s.indexOf('<aside class="onpage"')));
  assert.deepStrictEqual([...on.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]), [['#prepare', '用意するもの'], ['#install', '手順1. インストールする'], ['#login', '手順2. ログインする']]);
  assert.ok(!html('start/first/index.html').includes('class="onpage"'), '## が2つの記事に出ている');
  assert.ok(!html('record/pause/index.html').includes('class="onpage"'));
});

test('H-3: ホームに分類の格子（題名・説明・記事の件数）と「はじめての方へ」（featured の順）がある。格子の順は site.json の順', { timeout: 5000 }, () => {
  const { html } = buildFixture();
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

test('H-3: 作るのを止める（記事の形の誤り・無い related・作る道具の id と重なる hc- の id）。止めたときは出力に何も書かない', { timeout: 5000 }, () => {
  const cases = [
    ['raw-html', (h) => fs.appendFileSync(path.join(h, 'articles', 'start', 'first.md'), '\n<b>x</b>\n'), 'help/articles/start/first.md'],
    ['missing-article', (h) => { const f = path.join(h, 'articles', 'record', 'pause.md'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('related: start/first, start/steps', 'related: start/none')); }, 'help/articles/record/pause.md'],
    ['missing-anchor', (h) => { const f = path.join(h, 'articles', 'record', 'pause.md'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('{#hotkey}', '{#keys}').replace('(#hotkey)', '(#keys)')); }, 'help/articles/start/first.md'],
    ['syntax', (h) => fs.appendFileSync(path.join(h, 'articles', 'start', 'first.md'), '\n## 予約 {#hc-main}\n'), 'help/articles/start/first.md'],
    ['bad-front', (h) => { const f = path.join(h, 'articles', 'start', 'first.md'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('updated: 2026-10-21', 'updated: 2026-13-01')); }, 'help/articles/start/first.md'],
  ];
  for (const [code, edit, file] of cases) {
    const root = fixtureRoot(edit);
    const out = path.join(root, 'out');
    assert.throws(() => build({ root, out }), (e) => e.name === 'HelpBuildError' && e.code === code && e.file === file && (code === 'missing-article' || Number.isInteger(e.line)), code);
    assert.ok(!fs.existsSync(out), `${code}: 止めたのに出力がある`);
  }
});

test('白黒: help.css の色の札は指定の値（地 #fff・ink #000・本文 #333・薄文字 #6e6e6e・罫線 #dadada・面 #f4f4f4）。暗い版は白黒を反転した灰色だけ。どの色も灰色（色を使わない）。CSS の入れ子を使わない（COLOR-05）', { timeout: 5000 }, () => {
  const css = CSS();
  const rules = C.parse(css);
  const light = C.tokens(rules, '');
  const want = { '--bg': '#ffffff', '--ink': '#000000', '--body': '#333333', '--muted': '#6e6e6e', '--rule': '#dadada', '--wash': '#f4f4f4' };
  for (const [k, v] of Object.entries(want)) assert.strictEqual((light[k] || '').toLowerCase(), v, k);
  const dark = C.tokens(rules, DARK);
  for (const k of Object.keys(want)) assert.ok(dark[k], `暗い版に ${k} が無い`);
  const lum = (v) => C.luminance(C.parseColor(v));
  assert.strictEqual(dark['--ink'].toLowerCase(), '#ffffff', '暗い版の ink は白');
  assert.ok(lum(dark['--bg']) < 0.02, '暗い版の地は黒に近い暗い灰');
  assert.ok(lum(dark['--rule']) < lum(dark['--muted']) && lum(dark['--wash']) < lum(dark['--rule']), '暗い版の並び（地 < 面 < 罫線 < 薄文字）');
  // どの色も灰色（r = g = b）。紺・グラデーションを使わない
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const colors = plain.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) || [];
  assert.ok(colors.length >= 12);
  for (const c of colors) {
    const p = C.parseColor(c);
    assert.ok(p && p[0] === p[1] && p[1] === p[2], `灰色でない色: ${c}`);
  }
  assert.ok(!/gradient|box-shadow\s*:\s*(?!none)|text-shadow|filter\s*:|backdrop-filter/i.test(plain), '影・グラデーション・ぼかしを使わない');
  assert.ok(!/border-radius\s*:\s*(?!0[;}\s])/.test(plain), '角丸を使わない');
  assert.ok(!rules.some((r) => r.nested), 'CSS の入れ子');
});

test('白黒: 文字と地の濃さの差が明暗の両方で 4.5:1 以上（本文・薄文字・見出し・リンク・注意の枠・コード・表の頭・選んでいる目次の行）', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  for (const at of ['', DARK]) {
    const v = (name) => C.parseColor(C.resolveVar(rules, `var(${name})`, at));
    const pairs = [['--body', '--bg'], ['--muted', '--bg'], ['--ink', '--bg'], ['--body', '--wash'], ['--muted', '--wash'], ['--ink', '--wash']];
    for (const [fg, bg] of pairs) {
      const r = C.contrast(v(fg), v(bg));
      assert.ok(r >= 4.5, `${at || '明るい'}: ${fg} と ${bg} が ${r.toFixed(2)}:1`);
    }
    // 部品に書いた色が札を通っている（直に色を書くと暗い版で反転しない）
    for (const r of rules) {
      if (r.sel === ':root' || r.at.startsWith('@font-face')) continue;
      for (const [k, val] of Object.entries(r.decls)) {
        if (/^(color|background|background-color|border(-[a-z]+)*|outline(-color)?|text-decoration-color)$/.test(k)) {
          assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|\b(white|black)\b/i.test(val), `${r.sel} の ${k} に札を通らない色: ${val}`);
        }
      }
    }
  }
});

test('画面の使いやすさ: help.css に :focus-visible の輪があり、outline: none で消す規則が無い。640px より狭いときは左右 16px の余白で、min-width の固定が無い', { timeout: 5000 }, () => {
  const css = CSS();
  const rules = C.parse(css);
  const fv = rules.filter((r) => r.sel.includes(':focus-visible'));
  assert.ok(fv.some((r) => /2px solid var\(--ink\)/.test(r.decls.outline || '')), ':focus-visible に 2px の輪が無い');
  for (const r of rules) assert.ok(!/^(none|0)$/.test((r.decls.outline || '').trim()), `${r.sel} が outline を消す`);
  const narrow = rules.filter((r) => r.at === '@media (max-width: 639px)');
  assert.ok(narrow.length > 0, '狭い画面の規則が無い');
  for (const sel of ['.top-in', '.wrap', '.foot-in']) {
    const d = C.declsFor(narrow, sel);
    assert.ok(d['padding-left'] === '16px' && d['padding-right'] === '16px', `${sel} の左右の余白`);
  }
  for (const r of rules) assert.ok(!/\d+px/.test(r.decls['min-width'] || ''), `${r.sel} に min-width の固定`);
  // 横のはみ出し: 表とコードの塊はその中で横に送る。本文の長い住所は折り返す
  assert.strictEqual(C.declsFor(rules, '.table')['overflow-x'], 'auto');
  assert.strictEqual(C.declsFor(rules, 'pre')['overflow-x'], 'auto');
  assert.ok(/break-word|anywhere/.test(C.declsFor(rules, '.body')['overflow-wrap'] || ''));
});

test('白黒: 大きな数字は順番のある手順（.step .n）にだけ。書体は同梱の IBM Plex Sans JP（本文）と IBM Plex Mono（コード）', { timeout: 5000 }, () => {
  const rules = C.parse(CSS());
  const big = rules.filter((r) => /^[\d.]+rem$/.test(r.decls['font-size'] || '') && parseFloat(r.decls['font-size']) >= 2.5).map((r) => r.sel);
  assert.deepStrictEqual(big, ['.step .n']);
  const n = C.declsFor(rules, '.step .n');
  assert.strictEqual(n['font-weight'], '300');
  assert.strictEqual(n['font-size'], '3.2rem');
  const root = C.tokens(rules, '');
  assert.match(root['--sans'], /^"IBM Plex Sans JP", /);
  assert.match(root['--mono'], /^"IBM Plex Mono", /);
  assert.strictEqual(C.declsFor(rules, 'body')['font-family'], 'var(--sans)');
  assert.strictEqual(C.declsFor(rules, 'code')['font-family'], 'var(--mono)');
  assert.ok(/1\.8/.test(C.declsFor(rules, 'body')['line-height']), '本文の行間 1.85 前後');
});

test('白黒: fonts.css の書体は help/assets/fonts の中のファイルだけ（外の配信なし）。400 と 700 の IBM Plex Sans JP・Mono と、数字だけの 300。OFL のライセンス文がある', { timeout: 5000 }, () => {
  const dir = path.join(ROOT, 'help', 'assets', 'fonts');
  const css = fs.readFileSync(path.join(ROOT, 'help', 'assets', 'fonts.css'), 'utf8');
  const faces = [...css.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => C.decls(m[1]));
  assert.ok(faces.length > 200);
  const used = new Set();
  const weights = { 'IBM Plex Sans JP': new Set(), 'IBM Plex Mono': new Set() };
  for (const f of faces) {
    const fam = f['font-family'].replace(/"/g, '');
    assert.ok(weights[fam], `知らない書体 ${fam}`);
    weights[fam].add(f['font-weight']);
    const m = /^url\("\/assets\/fonts\/([a-z0-9-]{1,40}\.woff2)"\) format\("woff2"\)$/.exec(f.src);
    assert.ok(m, `src の形: ${f.src}`);
    used.add(m[1]);
    if (f['font-weight'] === '300') assert.strictEqual(f['unicode-range'], 'U+0030-0039', '300 は数字だけ');
  }
  assert.deepStrictEqual([...weights['IBM Plex Sans JP']].sort(), ['300', '400', '700']);
  assert.deepStrictEqual([...weights['IBM Plex Mono']].sort(), ['400', '700']);
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.woff2')).sort();
  assert.deepStrictEqual([...used].sort(), onDisk, '使わない書体のファイルがある・無いファイルを指す');
  for (const f of onDisk) assert.strictEqual(fs.readFileSync(path.join(dir, f)).subarray(0, 4).toString('latin1'), 'wOF2', f);
  assert.ok(!/https?:|\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\("\/assets\/fonts\//g, '')), '外の住所');
  const ofl = fs.readFileSync(path.join(dir, 'OFL.txt'), 'utf8');
  assert.ok(ofl.includes('SIL Open Font License') && ofl.includes('Version 1.1'));
  assert.ok(!/https?:|@import/.test(CSS().replace(/\/\*[\s\S]*?\*\//g, '')), 'help.css が外を読む');
});

test('H-3: site.js は［目次］の開け閉めだけ（外へ通信しない・innerHTML も eval も無い）', { timeout: 5000 }, () => {
  const js = fs.readFileSync(path.join(ROOT, 'help', 'assets', 'site.js'), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write|localStorage|https?:/.test(js));
  assert.match(js, /aria-expanded/);
  assert.match(js, /classList\.add\('js'\)/);
});
