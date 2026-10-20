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

const ROOT = path.resolve(__dirname, '..');
const NAME = /^[a-z0-9-]{1,40}$/;

/** 作るのを止める誤り。file はリポジトリの根からの道、line は 1 から（分からなければ null） */
class HelpBuildError extends Error {
  constructor(message, { file = null, line = null, code } = {}) {
    super(message);
    this.name = 'HelpBuildError';
    this.file = file;
    this.line = line;
    this.code = code;
  }
}

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
  fs.rmSync(o, { recursive: true, force: true });
  fs.mkdirSync(o, { recursive: true });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 作る（H-1 は骨組み: 分類の名前だけの仮のページ） */
function build({ root = ROOT, out } = {}) {
  out = out || path.join(root, 'help', 'dist');
  const { site } = loadSite(root);
  clearOut(root, out);
  const html = `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<title>${esc(site.title)}</title>\n</head>\n<body>\n<h1>${esc(site.title)}</h1>\n<ul>\n${site.categories.map((c) => `<li>${esc(c.title)}</li>`).join('\n')}\n</ul>\n</body>\n</html>\n`;
  fs.writeFileSync(path.join(out, 'index.html'), html);
  return { pages: ['index.html'], articles: [], bytes: Buffer.byteLength(html) };
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
module.exports = { build, loadSite, HelpBuildError };
