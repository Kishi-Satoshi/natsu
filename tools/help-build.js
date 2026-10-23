#!/usr/bin/env node
'use strict';
// help-build.js — NaTsu ヘルプセンターを作る（D22・HC0。実装計画 docs/plans/2026-10-20-help.md）
//
//   node tools/help-build.js   … help/ の記事から help/dist/ に静的なサイトを作る
//
// Node に入っている部品だけで作る（npm の依存を足さない）。同じ元からは何度作っても同じバイトになる。
// help/ はアプリにも自動更新の zip にも入らない（test/help-site.test.js）。

const fs = require('node:fs');
const path = require('node:path');
const { HelpBuildError, parseFrontMatter, renderMarkdown } = require('./lib/help-md');
const P = require('./lib/help-page');

const ROOT = path.resolve(__dirname, '..');
const NAME = /^[a-z0-9-]{1,40}$/;

const badSite = (msg) => { throw new HelpBuildError(msg, { file: 'help/site.json', code: 'bad-site' }); };
const isText = (v) => typeof v === 'string' && v.trim().length > 0 && !/[\r\n]/.test(v);
const sameKeys = (o, keys) => o && typeof o === 'object' && !Array.isArray(o)
  && Object.keys(o).sort().join(',') === [...keys].sort().join(',');

/** help/site.json を読んで形を確かめる。help/articles/<分類>/*.md とちょうど同じかも見る */
function loadSite(root) {
  const help = path.join(root, 'help');
  let site;
  try { site = JSON.parse(fs.readFileSync(path.join(help, 'site.json'), 'utf8').replace(/^﻿/, '')); } catch (e) { badSite(`site.json を読めない（${e.message}）`); }
  if (!sameKeys(site, ['title', 'askNote', 'categories', 'featured'])) badSite('site.json の鍵は title・askNote・categories・featured だけ');
  if (!isText(site.title) || !isText(site.askNote)) badSite('title と askNote は1行の文字');
  if (!Array.isArray(site.categories) || site.categories.length === 0) badSite('categories は1つ以上の配列');
  if (!Array.isArray(site.featured)) badSite('featured は配列');
  const ids = new Set();
  const refs = [];
  for (const c of site.categories) {
    if (!sameKeys(c, ['id', 'title', 'description', 'icon', 'articles'])) badSite('分類の鍵は id・title・description・icon・articles だけ');
    if (typeof c.id !== 'string' || !NAME.test(c.id)) badSite(`分類の id の形が違う: ${c.id}`);
    if (ids.has(c.id)) badSite(`分類の id が重なる: ${c.id}`);
    ids.add(c.id);
    if (!isText(c.title) || !isText(c.description)) badSite(`分類 ${c.id} の title と description は1行の文字`);
    if (typeof c.icon !== 'string' || !NAME.test(c.icon) || !fs.existsSync(path.join(help, 'assets', 'icons', `${c.icon}.svg`))) badSite(`分類 ${c.id} のアイコン help/assets/icons/${c.icon}.svg が無い`);
    if (!Array.isArray(c.articles)) badSite(`分類 ${c.id} の articles は配列`);
    const seen = new Set();
    for (const a of c.articles) {
      if (typeof a !== 'string' || !NAME.test(a)) badSite(`分類 ${c.id} の記事の名前の形が違う: ${a}`);
      if (seen.has(a)) badSite(`分類 ${c.id} の記事が重なる: ${a}`);
      seen.add(a);
      refs.push(`${c.id}/${a}`);
    }
    // 分類の articles と help/articles/<id>/*.md はちょうど同じ（多くも少なくもない）
    const dir = path.join(help, 'articles', c.id);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() : [];
    const want = [...seen].sort();
    const extra = files.filter((f) => !seen.has(f));
    const missing = want.filter((a) => !files.includes(a));
    if (missing.length) badSite(`site.json の記事のファイルが無い: ${missing.map((a) => `help/articles/${c.id}/${a}.md`).join(', ')}`);
    if (extra.length) badSite(`site.json に無い記事のファイルがある: ${extra.map((a) => `help/articles/${c.id}/${a}.md`).join(', ')}`);
  }
  const artDir = path.join(help, 'articles');
  if (fs.existsSync(artDir)) {
    for (const d of fs.readdirSync(artDir)) if (!ids.has(d)) badSite(`分類に無いフォルダ help/articles/${d}`);
  }
  const fset = new Set();
  for (const f of site.featured) {
    if (!refs.includes(f)) badSite(`featured の ${f} が分類の記事に無い`);
    if (fset.has(f)) badSite(`featured が重なる: ${f}`);
    fset.add(f);
  }
  return { site, refs };
}

/** 書き出す先を空にする。help/ や根そのもの（と、それを含むフォルダ）は消さない */
function clearOut(root, out) {
  const o = path.resolve(out);
  const keep = [path.resolve(root), path.resolve(root, 'help'), path.resolve(root, 'help', 'articles'), path.resolve(root, 'help', 'assets')];
  if (keep.some((k) => k === o || k.startsWith(o + path.sep))) throw new HelpBuildError(`書き出す先が元を含む: ${out}`, { code: 'bad-out' });
  // help の中は help/dist とその下だけ（help/articles・help/assets の中を消さない）
  const help = path.resolve(root, 'help');
  const dist = path.join(help, 'dist');
  if (o.startsWith(help + path.sep) && o !== dist && !o.startsWith(dist + path.sep)) throw new HelpBuildError(`書き出す先が元の中: ${out}`, { code: 'bad-out' });
  fs.rmSync(o, { recursive: true, force: true });
  fs.mkdirSync(o, { recursive: true });
}

const toPosix = (p) => p.split(path.sep).join('/');

/** help/assets の下の全部のファイル（相対の道。順は決まった並び） */
function listAssets(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((e) => (e.isDirectory() ? listAssets(path.join(dir, e.name), base) : [toPosix(path.relative(base, path.join(dir, e.name)))]));
}

/** 分類のアイコン（自作の線の絵）を HTML に差し込む形にする（名前空間の住所を外し、class="ic" を付ける） */
function iconMarkup(help, name) {
  const svg = fs.readFileSync(path.join(help, 'assets', 'icons', `${name}.svg`), 'utf8').trim();
  if (!/^<svg [^>]*>[\s\S]*<\/svg>$/.test(svg) || /<script|\son[a-z]+\s*=|<image|<foreignObject|href=/i.test(svg)) badSite(`アイコン ${name}.svg の形が違う`);
  return svg.replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '').replace(/^<svg /, '<svg class="ic" ');
}

/** 記事を読む（1回目: 前置きと見出し、2回目: ほかの記事の #id も確かめる）→ Map(ref → 記事) */
function readArticles(root, site) {
  const help = path.join(root, 'help');
  const refs = site.categories.flatMap((c) => c.articles.map((a) => `${c.id}/${a}`));
  const exists = new Set(refs);
  const assetExists = (p) => { const f = path.join(help, p); return f.startsWith(path.join(help, 'assets') + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile(); };
  const arts = new Map();
  for (const ref of refs) {
    const file = `help/articles/${ref}.md`;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const fm = parseFrontMatter(text, { file });
    const opts = { file, bodyLine: fm.bodyLine, articleExists: (r) => exists.has(r), assetExists };
    const first = renderMarkdown(fm.body, opts);
    const bodyLines = fm.body.split('\n');
    for (const h of first.headings) {
      if (h.id.startsWith('hc-')) {
        const k = bodyLines.findIndex((l) => l.includes(`{#${h.id}}`));
        throw new HelpBuildError(`hc- で始まる id はページの部品が使う: ${h.id}`, { file, line: fm.bodyLine + Math.max(k, 0), code: 'syntax' });
      }
    }
    const relLine = text.replace(/\r\n?/g, '\n').split('\n').findIndex((l) => l.startsWith('related:')) + 1;
    for (const r of fm.meta.related) {
      if (!exists.has(r)) throw new HelpBuildError(`related の記事が無い: ${r}`, { file, line: relLine || null, code: 'missing-article' });
    }
    const [cat, name] = ref.split('/');
    arts.set(ref, { ref, cat, name, url: `/${ref}/`, meta: fm.meta, fm, opts, headings: first.headings });
  }
  const anchors = new Map([...arts].map(([ref, a]) => [ref, new Set(a.headings.filter((h) => h.linkable).map((h) => h.id))]));
  for (const a of arts.values()) {
    const r = renderMarkdown(a.fm.body, { ...a.opts, anchorExists: (ref, id) => anchors.has(ref) && anchors.get(ref).has(id) });
    Object.assign(a, { html: r.html, headings: r.headings, text: r.text, links: r.links });
    // 関連記事: related のとおり。無ければ同じ分類の前後の記事を近い順に3つまで
    const own = site.categories.find((c) => c.id === a.cat).articles;
    const i = own.indexOf(a.name);
    a.related = a.meta.related.length
      ? a.meta.related.filter((r) => r !== a.ref)
      : own.map((n, k) => ({ n, k })).filter((x) => x.k !== i).sort((x, y) => Math.abs(x.k - i) - Math.abs(y.k - i) || x.k - y.k).slice(0, 3).map((x) => `${a.cat}/${x.n}`);
  }
  return arts;
}

/**
 * 出力のページの中の / で始まる住所と #id が、出力のファイルと id にあるかを確かめる（HF4）。
 * pages: Map(出力の相対の道 → HTML の文字。HTML でないファイルは null)
 */
function checkPages(pages) {
  const idsOf = (h) => new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const ids = new Map();
  for (const [f, h] of pages) if (typeof h === 'string') ids.set(f, idsOf(h));
  for (const [f, h] of pages) {
    if (typeof h !== 'string') continue;
    const file = `help/dist/${f}`;
    for (const m of h.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const url = m[1].replace(/&amp;/g, '&');
      if (url.startsWith('https://')) continue;
      if (url.startsWith('#')) {
        if (!ids.get(f).has(url.slice(1))) throw new HelpBuildError(`無い飛び先: ${url}`, { file, code: 'missing-anchor' });
        continue;
      }
      if (!url.startsWith('/') || url.startsWith('//')) throw new HelpBuildError(`形の違う住所: ${url}`, { file, code: 'bad-link' });
      const [p, anchor] = url.split('#');
      const target = p.endsWith('/') ? `${p.slice(1)}index.html` : p.slice(1);
      if (!pages.has(target)) throw new HelpBuildError(`リンク先が無い: ${url}`, { file, code: 'missing-article' });
      if (anchor !== undefined && !(ids.get(target) || new Set()).has(anchor)) throw new HelpBuildError(`無い飛び先: ${url}`, { file, code: 'missing-anchor' });
    }
  }
}

/** 検索の索引（H-4）: { v: 1, items: [{ u, t, d, c, h, x }] }。記事の順は site.json の順。x は印の無い本文で 4,000 字まで */
function searchIndex(site, articles) {
  const items = [...articles.values()].map((a) => ({
    u: a.url,
    t: a.meta.title,
    d: a.meta.description,
    c: site.categories.find((c) => c.id === a.cat).title,
    h: a.headings.map((h) => h.text),
    x: [...a.text.replace(/\s+/g, ' ').trim()].slice(0, 4000).join(''),
  }));
  return JSON.stringify({ v: 1, items });
}

/** 作る。全部のページを先に組み立てて確かめ、通ったときだけ out を空にして書く */
function build({ root = ROOT, out } = {}) {
  out = out || path.join(root, 'help', 'dist');
  const help = path.join(root, 'help');
  const { site } = loadSite(root);
  const articles = readArticles(root, site);
  const icons = new Map(site.categories.map((c) => [c.icon, iconMarkup(help, c.icon)]));
  const ctx = { articles, icons };
  const pages = new Map();
  pages.set('index.html', P.pageHome(site, ctx));
  for (const c of site.categories) pages.set(`${c.id}/index.html`, P.pageCategory(site, c, ctx));
  for (const a of articles.values()) pages.set(`${a.ref}/index.html`, P.pageArticle(site, a, ctx));
  pages.set('404.html', P.page404(site, ctx));
  // 0.10.0 LN-5（D78・決めたこと 155）: /open のページ（Claude の出典のリンクから NaTsu を開く静かなページ）。help/open/index.html をそのまま出す。
  // 記事ではないので、検索の索引・記事の一覧・ホームと分類の一覧には入れない（ページの中の住所は checkPages が照らす）
  const openPage = path.join(help, 'open', 'index.html');
  if (fs.existsSync(openPage)) pages.set('open/index.html', fs.readFileSync(openPage, 'utf8'));
  const index = searchIndex(site, articles);
  const assets = listAssets(path.join(help, 'assets'));
  const all = new Map(pages);
  all.set('search-index.json', null);
  for (const f of assets) all.set(`assets/${f}`, null);
  checkPages(all);
  clearOut(root, out);
  let bytes = 0;
  for (const [f, h] of pages) {
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
    fs.writeFileSync(path.join(out, f), h);
    bytes += Buffer.byteLength(h);
  }
  fs.writeFileSync(path.join(out, 'search-index.json'), index);
  bytes += Buffer.byteLength(index);
  for (const f of assets) {
    const dst = path.join(out, 'assets', f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(help, 'assets', f), dst);
    bytes += fs.statSync(dst).size;
  }
  return { pages: [...pages.keys()], articles: [...articles.values()].map((a) => ({ ref: a.ref, url: a.url, title: a.meta.title })), bytes };
}

function main() {
  try {
    const r = build();
    console.log(`ページ ${r.pages.length}・記事 ${r.articles.length}・合わせて ${r.bytes} バイト`);
    return 0;
  } catch (e) {
    if (e instanceof HelpBuildError) {
      console.error(`${e.file || 'help'}${e.line ? `:${e.line}` : ''} ${e.code} ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { build, loadSite, checkPages, HelpBuildError };
