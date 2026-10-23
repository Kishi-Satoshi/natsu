/* help-md.test.js — ヘルプセンター H-2（HF3・HF4・RF52）: 記事の Markdown の変換
 *
 * 入力と期待を表で書く（1行1件）。tools/lib/help-md.js は小さな決まった形だけを受け、どの文字も逃がし、
 * 生の HTML・javascript: などのリンク・外の画像・無い飛び先で作るのを止める。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../tools/lib/help-md');

const FILE = 'help/articles/record/pause.md';
const ARTICLES = { 'start/login': ['code', 'trouble'], 'record/pause': ['hotkey'] };
const ASSETS = new Set(['assets/img/example.png', 'assets/img/flow.svg']);
const OPTS = {
  file: FILE,
  bodyLine: 1,
  articleExists: (ref) => Object.prototype.hasOwnProperty.call(ARTICLES, ref),
  anchorExists: (ref, id) => (ARTICLES[ref] || []).includes(id),
  assetExists: (p) => ASSETS.has(p),
};
const R = (body, o = {}) => M.renderMarkdown(body, { ...OPTS, ...o });
const html = (body, o) => R(body, o).html;
/** 投げた誤りの code と line を返す（投げなければ null） */
function errOf(body, o) {
  try { R(body, o); return null; } catch (e) {
    assert.strictEqual(e.name, 'HelpBuildError', `HelpBuildError でない: ${e.stack}`);
    assert.strictEqual(e.file, FILE);
    return { code: e.code, line: e.line, msg: e.message };
  }
}
const FRONT = (extra = '') => `---\ntitle: 録音を一時停止する\ndescription: 会議の途中で録音を止めて、また始める方法\nupdated: 2026-10-21\nsources: src/renderer/app.html, README.md\n${extra}---\n`;

test('HF3: 文字は全部逃がす（& < > " \' が本文・見出し・表・リンクの文・リンクの住所・画像の代わりの文・コードの中で）', { timeout: 5000 }, () => {
  const S = `a < b & c > d "e" 'f'`;
  const E = 'a &lt; b &amp; c &gt; d &quot;e&quot; &#39;f&#39;';
  assert.strictEqual(M.escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
  const rows = [
    [S, `<p>${E}</p>`],
    [`## ${S} {#h}`, `<h2 id="h">${E}</h2>`],
    [`| ${S} | x |\n| --- | --- |\n| ${S} | \`${S}\` |`, `<div class="table" role="region" aria-label="表 1"><table>\n<thead><tr><th>${E}</th><th>x</th></tr></thead>\n<tbody>\n<tr><td>${E}</td><td><code>${E}</code></td></tr>\n</tbody>\n</table></div>`],
    [`[${S}](https://example.com/?a=1&b=2)`, `<p><a href="https://example.com/?a=1&amp;b=2" rel="noreferrer">${E}</a></p>`],
    [`![${S}](assets/img/example.png)`, `<figure><img src="/assets/img/example.png" alt="${E}"></figure>`],
    ['`<b> & "x"`', '<p><code>&lt;b&gt; &amp; &quot;x&quot;</code></p>'],
    ['```\n<script>alert("x")</script>\n**a** & \'b\'\n```', '<pre><code>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\n**a** &amp; &#39;b&#39;</code></pre>'],
    [`- ${S}`, `<ul>\n<li>${E}</li>\n</ul>`],
    [`> [!NOTE]\n> ${S}`, `<aside class="note note-note" role="note">\n<p class="note-t">メモ</p>\n<p>${E}</p>\n</aside>`],
    [`[[Ctrl+"]]`, '<p><kbd>Ctrl</kbd>+<kbd>&quot;</kbd></p>'],
  ];
  for (const [src, want] of rows) assert.strictEqual(html(src), want, src);
});

test('HF3: 生の HTML（<b>・</p>・<!-- -->・<?x・<script>・<img onerror>）はコードの外なら raw-html で止め、行の番号を出す。a < b や 1<2 は文字として逃がす', { timeout: 5000 }, () => {
  const bad = ['<b>太字</b>', '本文</p>', '<!-- 注 -->', '<?xml x?>', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '## 見出し <i>x</i>', '- 項目 <br>', '| <u>a</u> | b |\n| --- | --- |\n| c | d |', '[<b>x</b>](https://example.com/)', '**<em>x</em>**', '> [!TIP]\n> <span>x</span>'];
  for (const src of bad) assert.strictEqual((errOf(src) || {}).code, 'raw-html', src);
  // 行の番号: 本文の3行目、本文はファイルの 7 行目から
  const e = errOf('一行目\n\n<b>三行目</b>', { bodyLine: 7 });
  assert.deepStrictEqual([e.code, e.line], ['raw-html', 9]);
  assert.strictEqual(html('a < b と 1<2 と <ログイン> と a<1'), '<p>a &lt; b と 1&lt;2 と &lt;ログイン&gt; と a&lt;1</p>');
  // コードの中なら止めない
  assert.strictEqual(html('`<b>`'), '<p><code>&lt;b&gt;</code></p>');
});

test('HF3: リンクの住所は 分類/名前.md・#id・https:// だけ。javascript:（大文字・空白・&#x6a; の形も）・data:・http:・mailto:・//・\\ は bad-scheme で止める', { timeout: 5000 }, () => {
  const bad = ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', '&#x6a;avascript:alert(1)', 'data:text/html,x', 'http://example.com/', 'mailto:x', '//example.com/', '\\\\example.com\\x', '/start/login/', 'HTTPS://example.com/', 'vbscript:x', 'file:///c:/x'];
  for (const u of bad) assert.strictEqual((errOf(`[x](${u})`) || {}).code, 'bad-scheme', u);
  // 形の違う住所（空・空白入り・@ 入り・.md の無い記事・空のリンクの文）は bad-link
  for (const src of ['[x]()', '[x](https://example.com/a b)', '[x](https://user\u0040example.com/)', '[x](start/login)', '[x](https://)', '[](https://example.com/)', '[ ](start/login.md)', '[x](start/login.md#Bad)', '[x](https://example.com/"x")']) {
    assert.strictEqual((errOf(src) || {}).code, 'bad-link', src);
  }
  const r = R('[ログイン](start/login.md)・[コード](start/login.md#code)・[同じ](#hotkey)・[外](https://example.com/x)\n\n## ホットキー {#hotkey}');
  assert.strictEqual(r.html.split('\n')[0], '<p><a href="/start/login/">ログイン</a>・<a href="/start/login/#code">コード</a>・<a href="#hotkey">同じ</a>・<a href="https://example.com/x" rel="noreferrer">外</a></p>');
  assert.deepStrictEqual(r.links, [
    { kind: 'article', ref: 'start/login', anchor: null },
    { kind: 'article', ref: 'start/login', anchor: 'code' },
    { kind: 'anchor', ref: null, anchor: 'hotkey' },
    { kind: 'external', ref: 'https://example.com/x', anchor: null },
  ]);
  assert.ok(!/target=/.test(r.html), '新しいタブにしない');
});

test('HF4: 無い記事へのリンクは missing-article、無い {#id} への #id は missing-anchor（同じページでもほかの記事でも）', { timeout: 5000 }, () => {
  assert.strictEqual(errOf('[x](start/no-such.md)').code, 'missing-article');
  assert.strictEqual(errOf('[x](start/login.md#no-such)').code, 'missing-anchor');
  const e = errOf('[x](#nowhere)\n\n## ある {#here}');
  assert.deepStrictEqual([e.code, e.line], ['missing-anchor', 1]);
  // {#id} の無い見出し（s1）へは飛べない
  assert.strictEqual(errOf('## 見出し\n\n[x](#s1)').code, 'missing-anchor');
  // anchorExists が無いとき（作る道具の1回目の読み）は、ほかの記事の #id を見ない
  assert.doesNotThrow(() => R('[x](start/login.md#no-such)', { anchorExists: undefined }));
});

test('HF3: 画像は assets/ の中に本当にある .png・.svg だけ。代わりの文が空・../ を含む・ほかの拡張子は bad-image', { timeout: 5000 }, () => {
  assert.strictEqual(html('![流れ](assets/img/flow.svg)'), '<figure><img src="/assets/img/flow.svg" alt="流れ"></figure>');
  for (const src of ['![](assets/img/example.png)', '![ ](assets/img/example.png)', '![x](assets/img/../img/example.png)', '![x](assets/img/none.png)', '![x](assets/img/example.gif)', '![x](https://example.com/a.png)', '![x](/assets/img/example.png)', '![x](assets/img/example.png "t")', '文の中の ![x](assets/img/example.png) は止める', '![x](data:image/png;base64,AAAA)']) {
    assert.strictEqual((errOf(src) || {}).code, 'bad-image', src);
  }
});

test('記事の書き方: 前置き（title・description・updated・sources は必ず・related は3つまで・知らない鍵は止める・updated は YYYY-MM-DD）', { timeout: 5000 }, () => {
  const ok = M.parseFrontMatter(`${FRONT('related: record/start-stop, record/status-line\n')}\n本文\n`, { file: FILE });
  assert.deepStrictEqual(ok.meta, { title: '録音を一時停止する', description: '会議の途中で録音を止めて、また始める方法', updated: '2026-10-21', sources: ['src/renderer/app.html', 'README.md'], related: ['record/start-stop', 'record/status-line'] });
  assert.strictEqual(ok.body, '\n本文\n');
  // bodyLine は本文の1行目のファイルの行（閉じの --- が 7 行目なので 8）
  assert.strictEqual(ok.bodyLine, 8);
  assert.deepStrictEqual(M.parseFrontMatter(FRONT(), { file: FILE }).meta.related, []);
  const bad = [
    ['前置きが無い', '本文だけ\n'],
    ['閉じていない', '---\ntitle: x\n'],
    ['title が無い', FRONT().replace(/title: .*\n/, '')],
    ['description が無い', FRONT().replace(/description: .*\n/, '')],
    ['updated が無い', FRONT().replace(/updated: .*\n/, '')],
    ['sources が無い', FRONT().replace(/sources: .*\n/, '')],
    ['sources が空', FRONT().replace(/sources: .*\n/, 'sources: \n')],
    ['sources が外の道', FRONT().replace(/sources: .*\n/, 'sources: ../x.md\n')],
    ['知らない鍵', FRONT('author: x\n')],
    ['鍵が重なる', FRONT('title: もう一つ\n')],
    ['related が4つ', FRONT('related: a/b, a/c, a/d, a/e\n')],
    ['related の形', FRONT('related: start/login.md\n')],
    ['updated の形', FRONT().replace('2026-10-21', '2026/10/21')],
    ['updated が無い日', FRONT().replace('2026-10-21', '2026-02-30')],
    ['title が 61 字', FRONT().replace('録音を一時停止する', 'あ'.repeat(61))],
    ['description が 101 字', FRONT().replace('会議の途中で録音を止めて、また始める方法', 'い'.repeat(101))],
    ['コロンの無い行', FRONT('なにか\n')],
  ];
  for (const [why, src] of bad) {
    assert.throws(() => M.parseFrontMatter(src, { file: FILE }), (e) => e.name === 'HelpBuildError' && e.code === 'bad-front' && e.file === FILE && Number.isInteger(e.line), why);
  }
  assert.doesNotThrow(() => M.parseFrontMatter(FRONT().replace('録音を一時停止する', 'あ'.repeat(60)), { file: FILE }));
});

test('記事の書き方: 見出しは ## と ### だけ。{#id} の無い見出しは s1・s2… で linkable: false。# と #### は syntax', { timeout: 5000 }, () => {
  const r = R('## はじめ\n\n### ホットキー {#hotkey}\n\n## 終わり\n\n## 手順1. インストールする {#install}');
  assert.deepStrictEqual(r.headings, [
    { level: 2, id: 's1', text: 'はじめ', linkable: false },
    { level: 3, id: 'hotkey', text: 'ホットキー', linkable: true },
    { level: 2, id: 's2', text: '終わり', linkable: false },
    { level: 2, id: 'install', text: '手順1. インストールする', linkable: true },
  ]);
  assert.deepStrictEqual(r.html.split('\n'), ['<h2 id="s1">はじめ</h2>', '<h3 id="hotkey">ホットキー</h3>', '<h2 id="s2">終わり</h2>',
    // 順番のある手順の見出し（手順N.）だけ大きな数字（白黒の指定: 大きな数字は順番のある手順にだけ）
    '<h2 id="install" class="step"><span class="n" aria-hidden="true">1</span><span class="k">手順1</span> <span class="t">インストールする</span></h2>']);
  assert.strictEqual(html('## **太字** と `code` {#x}'), '<h2 id="x"><strong>太字</strong> と <code>code</code></h2>');
  for (const src of ['# 題名', '#### 小さい', '##### x', '## {#only-id}', '##', '## x {#Bad}', '## x {#s1}', '## a {#d}\n\n## b {#d}', '## x {#a b}', '## x {#}', '### x {#' + 'a'.repeat(41) + '}']) {
    assert.strictEqual((errOf(src) || {}).code, 'syntax', src);
  }
  // #の後に空白の無い行は見出しでなく文字
  assert.strictEqual(html('#タグ'), '<p>#タグ</p>');
});

test('記事の書き方: 段落のつなぎ（日本語の行は空白なしでつなぐ・英語どうしは空白1つ）・**太字**・`コード`・[[Ctrl+Shift+P]] は kbd 3つと +', { timeout: 5000 }, () => {
  const rows = [
    ['日本語の行\nつづき', '<p>日本語の行つづき</p>'],
    ['English line\nnext line', '<p>English line next line</p>'],
    ['日本語\nEnglish', '<p>日本語English</p>'],
    ['abc\n日本', '<p>abc日本</p>'],
    ['段落1\n\n段落2', '<p>段落1</p>\n<p>段落2</p>'],
    ['**もう一度押すと再開**します', '<p><strong>もう一度押すと再開</strong>します</p>'],
    ['`code` と **`太字の code`**', '<p><code>code</code> と <strong><code>太字の code</code></strong></p>'],
    ['[[Ctrl+Shift+P]] でも', '<p><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> でも</p>'],
    ['*1つ* と _下線_ と a*b', '<p>*1つ* と _下線_ と a*b</p>'],
    ['［⏸ 一時停止］ を押す', '<p>［⏸ 一時停止］ を押す</p>'],
    ['[ただの角かっこ] と ]', '<p>[ただの角かっこ] と ]</p>'],
    ['**[ログイン](start/login.md) を見る**', '<p><strong><a href="/start/login/">ログイン</a> を見る</strong></p>'],
    ['行の終わりの空白   \nつづき', '<p>行の終わりの空白つづき</p>'],
  ];
  for (const [src, want] of rows) assert.strictEqual(html(src), want, JSON.stringify(src));
  for (const src of ['**閉じていない', '`閉じていない', '[[閉じていない', '[[Ctrl+]]', '****', '** **']) assert.strictEqual((errOf(src) || {}).code, 'syntax', src);
});

test('記事の書き方: リストは1段の入れ子まで。2段目の下の入れ子は syntax。番号のリストは <ol>', { timeout: 5000 }, () => {
  assert.strictEqual(html('- a\n- b\n  - c\n  - d\n- e'), '<ul>\n<li>a</li>\n<li>b\n<ul>\n<li>c</li>\n<li>d</li>\n</ul></li>\n<li>e</li>\n</ul>');
  assert.strictEqual(html('1. 開く\n2. 押す\n   - 管理者の権限は聞かれません。\n   - 署名なし\n3. 済み'), '<ol>\n<li>開く</li>\n<li>押す\n<ul>\n<li>管理者の権限は聞かれません。</li>\n<li>署名なし</li>\n</ul></li>\n<li>済み</li>\n</ol>');
  assert.strictEqual(html('3. 三から\n4. 次'), '<ol start="3">\n<li>三から</li>\n<li>次</li>\n</ol>');
  // 字下げした続きの行は同じ項目につなぐ
  assert.strictEqual(html('1. PowerShell で次を実行します。\n   `irm x | iex`'), '<ol>\n<li>PowerShell で次を実行します。<code>irm x | iex</code></li>\n</ol>');
  // 種類が変わると別のリスト・段落の後のリスト
  assert.strictEqual(html('段落\n- a\n1. b'), '<p>段落</p>\n<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>');
  for (const src of ['- a\n  - b\n    - c', '- a\n  - b\n      - c', '  - 親が無い', '- a\n - 1つの空白', '- a\n字下げの無い続き', '- a\n\t- タブ']) {
    assert.strictEqual((errOf(src) || {}).code, 'syntax', JSON.stringify(src));
  }
});

test('記事の書き方: > [!NOTE]・[!TIP]・[!WARNING] はメモ・ヒント・注意の枠。印の無い > は syntax', { timeout: 5000 }, () => {
  assert.strictEqual(html('> [!NOTE]\n> メモの枠'), '<aside class="note note-note" role="note">\n<p class="note-t">メモ</p>\n<p>メモの枠</p>\n</aside>');
  assert.strictEqual(html('> [!TIP]\n> 一行目\n> 二行目\n>\n> - 項目'), '<aside class="note note-tip" role="note">\n<p class="note-t">ヒント</p>\n<p>一行目二行目</p>\n<ul>\n<li>項目</li>\n</ul>\n</aside>');
  assert.strictEqual(html('> [!WARNING]\n> **外に出したくない会議**では押す\n\n後の段落'), '<aside class="note note-warning" role="note">\n<p class="note-t">注意</p>\n<p><strong>外に出したくない会議</strong>では押す</p>\n</aside>\n<p>後の段落</p>');
  for (const src of ['> 印の無い引用', '> [!INFO]\n> x', '> [!NOTE]', '> [!NOTE]\n> ## 見出し', '> [!NOTE]\n> > [!TIP]\n> > x', '段落\n> [!NOTE]\n> x\n> [!TIP]']) {
    assert.strictEqual((errOf(src) || {}).code, 'syntax', JSON.stringify(src));
  }
});

test('記事の書き方: 表の頭・本文・セルの中の飾り（HD-6 Q6・再審査の指摘 5・6: 表の領域は role="region" と見出しからの名前。tabindex は site.js が送れるときだけ）。列の数が合わない行は syntax', { timeout: 5000 }, () => {
  assert.strictEqual(html('| キー | 動き |\n| --- | :---: |\n| [[Alt+M]] | **記録** と `x|y` |'),
    '<div class="table" role="region" aria-label="表 1"><table>\n<thead><tr><th>キー</th><th>動き</th></tr></thead>\n<tbody>\n<tr><td><kbd>Alt</kbd>+<kbd>M</kbd></td><td><strong>記録</strong> と <code>x|y</code></td></tr>\n</tbody>\n</table></div>');
  // 再審査の指摘 6: 表の領域の名前は直前の見出しから「<見出し>の表」。同じ名前は番号を足して重ねない。見出しの無い表は「表 N」。
  // 再審査の指摘 5: tabindex は出さない（横に送れるときだけ site.js が付ける）
  assert.deepStrictEqual([...html('## ボタンのある帯 {#with}\n\n| a |\n| --- |\n| b |\n\n| c |\n| --- |\n| d |\n\n### A & "B"\n\n| e |\n| --- |\n| f |').matchAll(/<div class="table"([^>]*)>/g)].map((m) => m[1]),
    [' role="region" aria-label="ボタンのある帯の表"', ' role="region" aria-label="ボタンのある帯の表 2"', ' role="region" aria-label="A &amp; &quot;B&quot;の表"']);
  // 再審査（axe の landmark-unique）: 表の領域の名前は記事の中で重ならない（表 1・表 2…）
  assert.deepStrictEqual([...html('| a |\n| --- |\n| b |\n\n段落\n\n| c |\n| --- |\n| d |').matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]), ['表 1', '表 2']);
  for (const src of ['| a | b |\n| --- | --- |\n| c |', '| a | b |\n| c | d |', '| a | b |\n| --- | --- |\n| c | d', '| a |']) {
    assert.strictEqual((errOf(src) || {}).code, 'syntax', JSON.stringify(src));
  }
});

test('記事の書き方: ``` の塊は中身をそのまま逃がす（< も ** も飾りにしない）。閉じていない塊・閉じていない ** は syntax', { timeout: 5000 }, () => {
  assert.strictEqual(html('```sql\nSELECT 1 AS b FROM t WHERE x < 2;\n**そのまま**\n\n  字下げも\n```'), '<pre><code>SELECT 1 AS b FROM t WHERE x &lt; 2;\n**そのまま**\n\n  字下げも</code></pre>');
  const e = errOf('前\n\n```\n閉じていない');
  assert.deepStrictEqual([e.code, e.line], ['syntax', 3]);
  for (const src of ['**閉じていない太字', '- a\n  ```\n  x\n  ```', '---', '***']) assert.strictEqual((errOf(src) || {}).code, 'syntax', JSON.stringify(src));
});

test('記事の書き方: CRLF と LF と BOM 付きで同じ HTML になる', { timeout: 5000 }, () => {
  const body = '## 見出し {#a}\n\n段落の\nつづき\n\n- a\n  - b\n\n> [!NOTE]\n> x\n\n| a | b |\n| --- | --- |\n| c | d |\n\n```\ncode\n```\n';
  const lf = R(body);
  const crlf = R(body.replace(/\n/g, '\r\n'));
  const bom = R('\uFEFF' + body);
  assert.strictEqual(crlf.html, lf.html);
  assert.strictEqual(bom.html, lf.html);
  assert.deepStrictEqual(crlf.headings, lf.headings);
  const f = FRONT() + '本文\n';
  assert.deepStrictEqual(M.parseFrontMatter('\uFEFF' + f.replace(/\n/g, '\r\n'), { file: FILE }), M.parseFrontMatter(f, { file: FILE }));
});

test('検索の本文（text）は印を落とした文字だけ（** も [[ も # も無い）', { timeout: 5000 }, () => {
  const r = R('## 止める {#stop}\n\n**太字** と `code` と [[Ctrl+Shift+P]] と [ログイン](start/login.md)\n\n- 項目\n\n> [!NOTE]\n> メモ\n\n| a | b |\n| --- | --- |\n| c | d |\n\n![流れの図](assets/img/flow.svg)');
  assert.ok(!/\*\*|\[\[|\]\]|#|<|>|\]\(|`/.test(r.text), r.text);
  for (const w of ['止める', '太字', 'code', 'Ctrl+Shift+P', 'ログイン', '項目', 'メモ', 'a', 'd', '流れの図']) assert.ok(r.text.includes(w), w);
});
