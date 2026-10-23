'use strict';
// help-page.js — ヘルプセンターのページを組み立てる（H-3。実装計画 docs/plans/2026-10-20-help.md）
//
// 文字の組み立てだけ（DOM を使わない）。差し込む文字は全部 escapeHtml を通すか、help-md が作った HTML だけ。
// style=・on…=・インラインの script・外の書体や画像は書かない。見た目は help/assets/help.css（白黒）。
// ページの id は hc- で始める（記事の見出しの id は hc- で始められない: help-build.js が止める）。

const { escapeHtml: esc } = require('./help-md');

const ARROW = '<span aria-hidden="true">›</span>';

/** 検索の箱（H-4）。JS が動かないときは出さない（hidden のまま。search.js が出す）。
 *  help-dads HD-5（HD6）: 結果の件数の見えない知らせ（role="status"）を箱ごとに1つ。読み上げソフトへの対応の例外（設計書「画面の使いやすさ」） */
const searchBox = (id, big) => `<div class="search${big ? ' search-big' : ''}" hidden><label class="vh" for="${id}">記事を探す</label><input id="${id}" class="search-q" type="search" placeholder="${big ? '記事を探す（例: ログイン、一時停止）' : '記事を探す'}" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-results"><ul id="${id}-results" class="search-results" role="listbox" aria-label="検索の結果" hidden></ul><p id="${id}-status" class="vh" role="status"></p></div>`;

/** 2026-10-21 → 2026 年 10 月 21 日 */
const jaDate = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return `${y} 年 ${m} 月 ${d} 日`; };

/** どのページも同じ枠（上の帯・本文・いちばん下の askNote） */
function shell(site, { title, main }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="natsu-help" content="page">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/fonts.css">
<link rel="stylesheet" href="/assets/help.css">
<script src="/assets/search.js" defer></script>
<script src="/assets/site.js" defer></script>
</head>
<body>
<a class="skip" href="#hc-main">本文へ移動</a>
<header class="top"><div class="top-in"><a class="brand" href="/">${esc(site.title)}</a>${searchBox('hc-q', false)}</div></header>
<div class="wrap">
${main}
</div>
<footer class="foot"><div class="foot-in"><p>${esc(site.askNote)}</p></div></footer>
</body>
</html>
`;
}

const pageTitle = (site, t) => `${t} — ${site.title}`;

/** 左の目次（分類ごとに記事の題名）。current は 'start' か 'start/login' */
function toc(site, ctx, current) {
  const cats = site.categories.map((c) => {
    const here = current === c.id ? ' aria-current="page"' : '';
    const items = c.articles.map((a) => {
      const ref = `${c.id}/${a}`;
      const art = ctx.articles.get(ref);
      return `<li><a href="/${ref}/"${current === ref ? ' aria-current="page"' : ''}>${esc(art.meta.title)}</a></li>`;
    }).join('\n');
    return `<div class="toc-cat"><p class="toc-h"><a href="/${c.id}/"${here}>${esc(c.title)}</a></p>${items ? `\n<ul>\n${items}\n</ul>` : ''}</div>`;
  }).join('\n');
  return `<nav id="hc-toc" class="toc" aria-label="記事の一覧">\n${cats}\n</nav>`;
}

const TOC_BTN = '<button type="button" class="toc-btn" aria-controls="hc-toc" aria-expanded="false" hidden>目次</button>';

/** 題名と説明の一覧（上に ink の線、各行の下に罫線） */
const rows = (list) => `<ul class="rows">\n${list.map((a) => `<li><a href="${a.url}">${esc(a.meta.title)}</a><span class="desc">${esc(a.meta.description)}</span></li>`).join('\n')}\n</ul>`;

function pageHome(site, ctx) {
  const cats = site.categories.map((c) => `<li><a href="/${c.id}/">${ctx.icons.get(c.icon) || ''}<span class="t">${esc(c.title)}</span><span class="d">${esc(c.description)}</span><span class="c">${c.articles.length} 件の記事</span></a></li>`).join('\n');
  const featured = site.featured.map((r) => ctx.articles.get(r));
  const main = `<main id="hc-main" class="home">
<h1>${esc(site.title)}</h1>
<p class="lede">NaTsu（会議の録音・文字起こし・要約と、音声入力のアプリ）の使い方を、分類ごとにまとめています。</p>
${searchBox('hc-q-home', true)}
<h2 class="vh" id="hc-cats">分類</h2>
<ul class="cats">
${cats}
</ul>
${featured.length ? `<h2 id="hc-featured">はじめての方へ</h2>\n${rows(featured)}\n` : ''}</main>`;
  return shell(site, { title: site.title, main });
}

function pageCategory(site, cat, ctx) {
  const list = cat.articles.map((a) => ctx.articles.get(`${cat.id}/${a}`));
  const main = `<main id="hc-main" class="cat">
<nav class="crumbs" aria-label="パンくず"><a href="/">ホーム</a> ${ARROW} <span aria-current="page">${esc(cat.title)}</span></nav>
<h1>${esc(cat.title)}</h1>
<p class="lede">${esc(cat.description)}</p>
${list.length ? rows(list) : '<p class="empty">この分類の記事はまだありません。</p>'}
</main>`;
  return shell(site, { title: pageTitle(site, cat.title), main: `<div class="layout">\n${TOC_BTN}\n${main}\n${toc(site, ctx, cat.id)}\n</div>` });
}

function pageArticle(site, art, ctx) {
  const cat = site.categories.find((c) => c.id === art.cat);
  const h2 = art.headings.filter((h) => h.level === 2 && h.linkable);
  const onpage = h2.length >= 3
    ? `\n<aside class="onpage" aria-labelledby="hc-onpage"><p class="onpage-h" id="hc-onpage">このページの内容</p>\n<ul>\n${h2.map((h) => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`).join('\n')}\n</ul>\n</aside>`
    : '';
  const related = art.related.map((r) => ctx.articles.get(r));
  const main = `<main id="hc-main" class="article">
<nav class="crumbs" aria-label="パンくず"><a href="/">ホーム</a> ${ARROW} <a href="/${cat.id}/">${esc(cat.title)}</a> ${ARROW} <span aria-current="page">${esc(art.meta.title)}</span></nav>
<h1>${esc(art.meta.title)}</h1>
<dl class="article-meta"><div><dt>分類</dt><dd>${esc(cat.title)}</dd></div><div><dt>最終更新日</dt><dd><time datetime="${esc(art.meta.updated)}">${jaDate(art.meta.updated)}</time></dd></div></dl>
<div class="body">
${art.html}
</div>
${related.length ? `<section class="related" aria-labelledby="hc-related"><h2 id="hc-related">関連記事</h2>\n${rows(related)}\n</section>\n` : ''}</main>`;
  return shell(site, { title: pageTitle(site, art.meta.title), main: `<div class="layout">\n${TOC_BTN}\n${main}\n${toc(site, ctx, art.ref)}${onpage}\n</div>` });
}

function page404(site, ctx) {
  const main = `<main id="hc-main" class="notfound">
<h1>ページが見つかりません</h1>
<p>住所が変わったか、記事が無くなった可能性があります。<a href="/">ホームへ戻る</a></p>
</main>`;
  return shell(site, { title: pageTitle(site, 'ページが見つかりません'), main });
}

module.exports = { pageHome, pageCategory, pageArticle, page404, jaDate };
