'use strict';
// help-md.js — ヘルプセンターの記事の Markdown を HTML にする（HF3・HF4・RF52。実装計画 docs/plans/2026-10-20-help.md「記事の書き方」）
//
// 小さな決まった形だけを受ける。形の外の書き方・生の HTML・javascript: などのリンク・外の画像・無い飛び先は
// HelpBuildError（file・line・code）で止める。文字は「逃がしてから飾る」のではなく、印で分けたかけらを
// それぞれ escapeHtml に通して組み立てる（逃がし忘れの道を作らない）。正規表現は1行の中だけに使い、
// 入れ子の量指定を使わない（長い入力で時間が延びない）。

const NAME = '[a-z0-9-]{1,40}';
const ID = new RegExp(`^${NAME}$`);
const REF = new RegExp(`^${NAME}/${NAME}$`);
const ARTICLE_LINK = new RegExp(`^(${NAME})/(${NAME})\\.md(?:#(.*))?$`);
// https:// の住所: ホスト（@ も空白も無い）と、決まった文字だけの道
const HTTPS = /^https:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d{1,5})?(?:\/[A-Za-z0-9\-._~%!$&*+,;=:@/?#]*)?$/;
const IMAGE_PATH = /^assets\/(?:[a-z0-9-]{1,40}\/){0,3}[a-z0-9-]{1,60}\.(?:png|svg)$/;
const NOTE_KIND = { NOTE: ['note', 'メモ'], TIP: ['tip', 'ヒント'], WARNING: ['warning', '注意'] };

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** BOM を外し、CRLF と CR を LF にそろえる */
const normalize = (text) => String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const isAscii = (c) => c !== undefined && c.charCodeAt(0) < 0x80;

// ================= 前置き =================

const FRONT_KEYS = ['title', 'description', 'updated', 'sources', 'related'];
const REQUIRED = ['title', 'description', 'updated', 'sources'];

function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** 前置き（--- で挟んだ鍵: 値）を読む → { meta, body, bodyLine }。bodyLine は本文の1行目のファイルの行 */
function parseFrontMatter(text, { file = null } = {}) {
  const bad = (msg, line) => { throw new HelpBuildError(`前置き: ${msg}`, { file, line, code: 'bad-front' }); };
  const lines = normalize(text).split('\n');
  if (lines[0] !== '---') bad('1行目が --- でない', 1);
  const end = lines.indexOf('---', 1);
  if (end < 0) bad('閉じの --- が無い', 1);
  const raw = {};
  for (let i = 1; i < end; i++) {
    const m = /^([a-z]+):(.*)$/.exec(lines[i]);
    if (!m) bad(`「鍵: 値」の形でない行`, i + 1);
    const [, key, value] = m;
    if (!FRONT_KEYS.includes(key)) bad(`知らない鍵 ${key}`, i + 1);
    if (Object.prototype.hasOwnProperty.call(raw, key)) bad(`鍵 ${key} が重なる`, i + 1);
    raw[key] = { value: value.trim(), line: i + 1 };
  }
  for (const k of REQUIRED) if (!raw[k] || raw[k].value === '') bad(`${k} が無い`, raw[k] ? raw[k].line : 1);
  const list = (k) => (raw[k] ? raw[k].value.split(',').map((s) => s.trim()) : []);
  const meta = { title: raw.title.value, description: raw.description.value, updated: raw.updated.value, sources: list('sources'), related: list('related') };
  if ([...meta.title].length > 60) bad('title は 60 字まで', raw.title.line);
  if ([...meta.description].length > 100) bad('description は 100 字まで', raw.description.line);
  if (!validDate(meta.updated)) bad('updated は YYYY-MM-DD の本当の日付', raw.updated.line);
  for (const s of meta.sources) {
    if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(s) || s.split('/').some((p) => p === '..' || p === '.')) bad(`sources の形が違う: ${s}`, raw.sources.line);
  }
  if (raw.related) {
    if (meta.related.length > 3) bad('related は3つまで', raw.related.line);
    for (const r of meta.related) if (!REF.test(r)) bad(`related は 分類/名前: ${r}`, raw.related.line);
  }
  return { meta, body: lines.slice(end + 1).join('\n'), bodyLine: end + 2 };
}

// ================= 文中 =================

/**
 * 文中の飾り（**太字**・`コード`・[[キー]]・[文](住所)）を HTML にする → { html, text }
 * at(i) は s の i 文字目のファイルの行。
 */
function inline(s, ctx, at) {
  const fail = (code, msg, i) => { throw new HelpBuildError(msg, { file: ctx.file, line: at(i), code }); };
  const frames = [{ html: '', text: '', start: 0 }];
  const top = () => frames[frames.length - 1];
  const put = (html, text) => { top().html += html; top().text += text; };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j < 0) fail('syntax', '閉じていない `', i);
      if (j === i + 1) fail('syntax', '空の `` ', i);
      const code = s.slice(i + 1, j);
      put(`<code>${escapeHtml(code)}</code>`, code);
      i = j + 1;
    } else if (s.startsWith('**', i)) {
      if (frames.length === 1) {
        frames.push({ html: '', text: '', start: i });
      } else {
        const f = frames.pop();
        if (f.text.trim() === '') fail('syntax', '空の **', f.start);
        put(`<strong>${f.html}</strong>`, f.text);
      }
      i += 2;
    } else if (s.startsWith('[[', i)) {
      const j = s.indexOf(']]', i + 2);
      if (j < 0) fail('syntax', '閉じていない [[', i);
      const keys = s.slice(i + 2, j).split('+').map((k) => k.trim());
      if (keys.some((k) => k === '')) fail('syntax', '[[キー+キー]] の形でない', i);
      for (const k of keys) if (/<[A-Za-z/!?]/.test(k)) fail('raw-html', '生の HTML は書けない', i);
      put(keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('+'), keys.join('+'));
      i = j + 2;
    } else if (s.startsWith('![', i)) {
      fail('bad-image', '画像は1行に1つだけ（文の中には置けない）', i);
    } else if (c === '[' && /^\[[^\]]*\]\(/.test(s.slice(i))) {
      const close = s.indexOf(']', i);
      const end = s.indexOf(')', close + 2);
      if (end < 0) fail('bad-link', '閉じていない (', i);
      const label = s.slice(i + 1, close);
      const href = s.slice(close + 2, end);
      const inner = inline(label, ctx, (k) => at(i + 1 + k));
      if (inner.text.trim() === '') fail('bad-link', 'リンクの文が空', i);
      if (inner.html.includes('<a ')) fail('syntax', 'リンクの中にリンクは書けない', i);
      const target = linkTarget(href, ctx, at(i), fail.bind(null), i);
      put(`<a href="${escapeHtml(target)}"${target.startsWith('https://') ? ' rel="noreferrer"' : ''}>${inner.html}</a>`, inner.text);
      i = end + 1;
    } else if (c === '<') {
      if (/[A-Za-z/!?]/.test(s[i + 1] || '')) fail('raw-html', '生の HTML は書けない（< の後に英字・/・!・?）', i);
      put('&lt;', '<');
      i += 1;
    } else {
      let j = i + 1;
      while (j < s.length && !'`*[!<'.includes(s[j])) j++; // * 1つ・_ はそのまま文字
      const t = s.slice(i, j);
      put(escapeHtml(t), t);
      i = j;
    }
  }
  if (frames.length > 1) fail('syntax', '閉じていない **', frames[1].start);
  return { html: frames[0].html, text: frames[0].text };
}

/** リンクの住所を確かめ、HTML に書く住所を返す。links に控える */
function linkTarget(href, ctx, line, fail, i) {
  if (href === '') fail('bad-link', 'リンクの住所が空', i);
  if (href.startsWith('https://')) {
    if (!HTTPS.test(href)) fail('bad-link', `https:// の住所の形が違う: ${href}`, i);
    ctx.links.push({ kind: 'external', ref: href, anchor: null });
    return href;
  }
  if (href.startsWith('#')) {
    const id = href.slice(1);
    if (!ID.test(id)) fail('bad-link', `#id の形が違う: ${href}`, i);
    ctx.links.push({ kind: 'anchor', ref: null, anchor: id });
    ctx.pendingAnchors.push({ id: ctx.idPrefix + id, shown: id, line });   // shown: エラーには書いた字のまま出す（頭を付ける前）
    return `#${ctx.idPrefix}${id}`;
  }
  const m = ARTICLE_LINK.exec(href);
  if (m) {
    const ref = `${m[1]}/${m[2]}`;
    const anchor = m[3] === undefined ? null : m[3];
    if (anchor !== null && !ID.test(anchor)) fail('bad-link', `#id の形が違う: ${href}`, i);
    if (!ctx.articleExists || !ctx.articleExists(ref)) fail('missing-article', `無い記事へのリンク: ${href}`, i);
    if (anchor !== null && ctx.anchorExists && !ctx.anchorExists(ref, anchor)) fail('missing-anchor', `無い飛び先へのリンク: ${href}`, i);
    ctx.links.push({ kind: 'article', ref, anchor });
    return `/${ref}/${anchor ? `#${anchor}` : ''}`;
  }
  // 住所の頭に : のある形（javascript:・data:・http:・mailto:・大文字の HTTPS: など）・/ や \ で始まる形・空白で始まる形は止める
  if (href.includes(':') || /^[/\\\s]/.test(href)) fail('bad-scheme', `使えないリンクの住所: ${href}`, i);
  fail('bad-link', `リンクは 分類/名前.md・#id・https:// だけ: ${href}`, i);
  return null;
}

// ================= 塊 =================

const LIST_ITEM = /^(-|\d{1,9}\.) (.*)$/;
const isFence = (t) => t.startsWith('```');
const isHeading = (t) => /^#+(?: |$)/.test(t);
const isBlockStart = (t) => t === '' || /^\s/.test(t) || isFence(t) || isHeading(t) || t.startsWith('>') || t.startsWith('|') || t.startsWith('![') || LIST_ITEM.test(t) || /^(?:-|\d{1,9}\.)$/.test(t);

/** 行をつなぐ（つなぎ目の前後が両方 ASCII なら空白1つ、ほかはそのまま）→ { s, at } */
function joinLines(parts) {
  let s = '';
  const marks = [];
  for (const p of parts) {
    if (s !== '' && isAscii(s[s.length - 1]) && isAscii(p.t[0])) s += ' ';
    marks.push({ start: s.length, line: p.n });
    s += p.t;
  }
  const at = (i) => {
    let line = marks[0].line;
    for (const m of marks) if (m.start <= i) line = m.line;
    return line;
  };
  return { s, at };
}

function renderBlocks(lines, ctx, inNote) {
  const out = [];
  const text = [];
  const fail = (code, msg, line) => { throw new HelpBuildError(msg, { file: ctx.file, line, code }); };
  const inl = (parts) => { const j = joinLines(parts); return inline(j.s, ctx, j.at); };
  let i = 0;
  while (i < lines.length) {
    const { t, n } = lines[i];
    if (t === '') { i++; continue; }
    if (/^\s/.test(t)) fail('syntax', '行の頭の字下げはリストの中だけ', n);
    if (isFence(t)) {
      if (inNote) fail('syntax', '注意の枠の中にコードの塊は書けない', n);
      if (!/^```[A-Za-z0-9-]*$/.test(t)) fail('syntax', '``` の行の形が違う', n);
      let j = i + 1;
      while (j < lines.length && lines[j].t !== '```') j++;
      if (j >= lines.length) fail('syntax', '閉じていないコードの塊', n);
      const code = lines.slice(i + 1, j).map((l) => l.raw).join('\n');
      out.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
      text.push(code);
      i = j + 1;
    } else if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) {
      fail('syntax', '区切りの線（---）は書けない', n);
    } else if (isHeading(t)) {
      const m = /^(#+) (.*)$/.exec(t);
      if (!m || (m[1].length !== 2 && m[1].length !== 3)) fail('syntax', '見出しは ## と ### だけ', n);
      if (inNote) fail('syntax', '注意の枠の中に見出しは書けない', n);
      const level = m[1].length;
      let src = m[2];
      let id = null;
      const idm = /^(.*?) *\{#([^}]*)\}$/.exec(src);
      if (idm) {
        [, src, id] = idm;
        if (!ID.test(id) || /^s\d+$/.test(id)) fail('syntax', `{#id} の形が違う（[a-z0-9-]{1,40}・s と数字だけは使えない）: ${id}`, n);
        if (ctx.ids.has(id)) fail('syntax', `{#id} が重なる: ${id}`, n);
      }
      if (src.trim() === '') fail('syntax', '見出しの文が空', n);
      const linkable = id !== null;
      if (!linkable) id = `s${++ctx.autoId}`;
      ctx.ids.add(id);
      id = ctx.idPrefix + id;   // help-relnotes 審査 A-4: 1つのページに並べる版の節では、版の id を頭に付ける
      const step = level === 2 ? /^手順(\d{1,2})\. (.+)$/.exec(src) : null;
      let html;
      let plain;
      if (step) {
        const rest = inline(step[2], ctx, () => n);
        html = `<h2 id="${id}" class="step"><span class="n" aria-hidden="true">${step[1]}</span><span class="k">手順${step[1]}</span> <span class="t">${rest.html}</span></h2>`;
        plain = `手順${step[1]}. ${rest.text}`;
      } else {
        const r = inline(src, ctx, () => n);
        html = `<h${level} id="${id}">${r.html}</h${level}>`;
        plain = r.text;
      }
      out.push(html);
      text.push(plain);
      ctx.headings.push({ level, id, text: plain, linkable });
      i++;
    } else if (t.startsWith('>')) {
      if (inNote) fail('syntax', '注意の枠は入れ子にできない', n);
      const km = /^> \[!(NOTE|TIP|WARNING)\]$/.exec(t);
      if (!km) fail('syntax', '> は > [!NOTE]・> [!TIP]・> [!WARNING] の枠だけ', n);
      const content = [];
      let j = i + 1;
      while (j < lines.length && lines[j].t.startsWith('>')) {
        const l = lines[j];
        const body = l.t === '>' ? '' : l.t.startsWith('> ') ? l.t.slice(2) : fail('syntax', '> の後に空白が要る', l.n);
        const raw = l.raw.replace(/^> ?/, '');
        if (/^\[!/.test(body)) fail('syntax', '枠の印は枠の1行目だけ', l.n);
        content.push({ t: body, raw, n: l.n });
        j++;
      }
      if (j < lines.length && lines[j].t !== '') fail('syntax', '枠の後は空の行で区切る', lines[j].n);
      if (!content.some((l) => l.t !== '')) fail('syntax', '枠の中が空', n);
      const [cls, label] = NOTE_KIND[km[1]];
      const inner = renderBlocks(content, ctx, true);
      out.push(`<aside class="note note-${cls}" role="note">\n<p class="note-t">${label}</p>\n${inner.html}\n</aside>`);
      text.push(inner.text);
      i = j;
    } else if (t.startsWith('|')) {
      let j = i;
      const rows = [];
      while (j < lines.length && lines[j].t.startsWith('|')) rows.push(lines[j++]);
      if (j < lines.length && lines[j].t !== '') fail('syntax', '表の後は空の行で区切る', lines[j].n);
      const cells = rows.map((r) => splitRow(r, fail));
      if (rows.length < 3) fail('syntax', '表は頭の行・--- の行・本文の行が要る', rows[0].n);
      if (!cells[1].every((c) => /^:?-{3,}:?$/.test(c))) fail('syntax', '表の2行目は --- の行', rows[1].n);
      const cols = cells[0].length;
      cells.forEach((c, k) => { if (c.length !== cols) fail('syntax', `表の列の数が合わない（${c.length} と ${cols}）`, rows[k].n); });
      const cell = (c, k, tag) => { const r = inline(c, ctx, () => rows[k].n); text.push(r.text); return `<${tag}>${r.html}</${tag}>`; };
      const head = `<tr>${cells[0].map((c) => cell(c, 0, 'th')).join('')}</tr>`;
      const body = cells.slice(2).map((r, k) => `<tr>${r.map((c) => cell(c, k + 2, 'td')).join('')}</tr>`).join('\n');
      // 表の領域の名前は直前の見出しから「<見出し>の表」（再審査の指摘 6）。見出しが無ければ「表 N」。同じ名前は番号を足す。
      // tabindex は付けない（横に送れるときだけ site.js が付ける: 再審査の指摘 5）
      const lastH = ctx.headings[ctx.headings.length - 1];
      const base = lastH ? `${lastH.text}の表` : `表 ${++ctx.tables}`;
      const used = (ctx.tableNames.get(base) || 0) + 1;
      ctx.tableNames.set(base, used);
      const name = `${ctx.tablePrefix}${used > 1 ? `${base} ${used}` : base}`;
      out.push(`<div class="table" role="region" aria-label="${escapeHtml(name)}"><table>\n<thead>${head}</thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`);
      i = j;
    } else if (t.startsWith('![')) {
      const m = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(t);
      if (!m) fail('bad-image', '画像の行の形が違う（![代わりの文](assets/….png)）', n);
      const [, alt, src] = m;
      if (alt.trim() === '') fail('bad-image', '画像の代わりの文が空', n);
      if (/<[A-Za-z/!?]/.test(alt)) fail('raw-html', '生の HTML は書けない', n);
      if (!IMAGE_PATH.test(src) || !ctx.assetExists || !ctx.assetExists(src)) fail('bad-image', `画像は help/assets/ の中にある .png・.svg だけ: ${src}`, n);
      out.push(`<figure><img src="/${escapeHtml(src)}" alt="${escapeHtml(alt)}"></figure>`);
      text.push(alt);
      i++;
    } else if (LIST_ITEM.test(t) || /^(?:-|\d{1,9}\.)$/.test(t)) {
      const r = renderList(lines, i, ctx, fail, inl);
      out.push(r.html);
      text.push(...r.text);
      i = r.next;
    } else {
      const parts = [];
      while (i < lines.length && (parts.length === 0 || !isBlockStart(lines[i].t))) parts.push(lines[i++]);
      const r = inl(parts);
      out.push(`<p>${r.html}</p>`);
      text.push(r.text);
    }
  }
  return { html: out.join('\n'), text: text.join('\n') };
}

/** 表の1行をセルに分ける（`…` の中の | では分けない） */
function splitRow(row, fail) {
  const t = row.t;
  if (t.length < 2 || !t.endsWith('|')) fail('syntax', '表の行は | で始まり | で終わる', row.n);
  const s = t.slice(1, -1);
  const cells = [];
  let cur = '';
  let code = false;
  for (const c of s) {
    if (c === '`') code = !code;
    if (c === '|' && !code) { cells.push(cur.trim()); cur = ''; } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** リスト（1段の入れ子まで）→ { html, text, next } */
function renderList(lines, start, ctx, fail, inl) {
  const kindOf = (marker) => (marker === '-' ? 'ul' : 'ol');
  const first = LIST_ITEM.exec(lines[start].t);
  if (!first || first[2].trim() === '') fail('syntax', '空のリストの項目', lines[start].n);
  const kind = kindOf(first[1]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (l.t === '') break;
    const m = LIST_ITEM.exec(l.t);
    if (m) {
      if (kindOf(m[1]) !== kind) break; // 種類が変われば別のリスト
      if (m[2].trim() === '') fail('syntax', '空のリストの項目', l.n);
      items.push({ marker: m[1], parts: [{ t: m[2], n: l.n }], sub: null });
      i++;
      continue;
    }
    if (/^\t/.test(l.raw) || /^ *\t/.test(l.raw)) fail('syntax', '字下げにタブは使えない', l.n);
    const ind = /^ */.exec(l.t)[0].length;
    if (ind === 0) fail('syntax', 'リストの後は空の行で区切る（字下げの無い続きは書けない）', l.n);
    const rest = l.t.slice(ind);
    const item = items[items.length - 1];
    const sm = LIST_ITEM.exec(rest);
    if (sm || /^(?:-|\d{1,9}\.)$/.test(rest)) {
      if (ind < 2 || ind > 3) fail('syntax', 'リストの入れ子は1段まで（2つか3つの空白の字下げ）', l.n);
      if (!sm || sm[2].trim() === '') fail('syntax', '空のリストの項目', l.n);
      const sk = kindOf(sm[1]);
      if (!item.sub) item.sub = { kind: sk, items: [] };
      else if (item.sub.kind !== sk) fail('syntax', '入れ子のリストの種類が途中で変わる', l.n);
      item.sub.items.push({ marker: sm[1], parts: [{ t: sm[2], n: l.n }] });
    } else {
      if (isFence(rest) || rest.startsWith('>') || rest.startsWith('|') || isHeading(rest)) fail('syntax', 'リストの中にはコード・枠・表・見出しを書けない', l.n);
      const target = item.sub ? item.sub.items[item.sub.items.length - 1] : item;
      target.parts.push({ t: rest, n: l.n });
    }
    i++;
  }
  const text = [];
  const open = (k, its) => {
    const n = parseInt(its[0].marker, 10);
    return k === 'ol' && n !== 1 ? `<ol start="${n}">` : `<${k}>`;
  };
  const li = (it) => {
    const r = inl(it.parts);
    text.push(r.text);
    let h = `<li>${r.html}`;
    if (it.sub) h += `\n${open(it.sub.kind, it.sub.items)}\n${it.sub.items.map(li).join('\n')}\n</${it.sub.kind}>`;
    return `${h}</li>`;
  };
  const html = `${open(kind, items)}\n${items.map(li).join('\n')}\n</${kind}>`;
  return { html, text, next: i };
}

/**
 * 記事の本文を HTML にする。
 * opts: { file, bodyLine（本文の1行目のファイルの行）, articleExists(ref), anchorExists(ref, id)（無ければほかの記事の #id を見ない）, assetExists(path),
 *         idPrefix（見出しの id とページの中の #id の頭に付ける字。既定は空）, tablePrefix（表の領域の名前の頭に付ける字。既定は空） }
 * → { html, headings: [{ level, id, text, linkable }], text（検索の本文）, links: [{ kind, ref, anchor }] }
 */
function renderMarkdown(body, opts = {}) {
  const ctx = {
    file: opts.file || null,
    articleExists: opts.articleExists,
    anchorExists: opts.anchorExists,
    assetExists: opts.assetExists,
    headings: [],
    links: [],
    pendingAnchors: [],
    ids: new Set(),
    autoId: 0,
    tables: 0,   // 見出しの無い表の番号（表 1・表 2…）
    tableNames: new Map(),   // 表の領域の名前の使った数（記事の中で重ねない: axe の landmark-unique）
    idPrefix: typeof opts.idPrefix === 'string' ? opts.idPrefix : '',
    tablePrefix: typeof opts.tablePrefix === 'string' ? opts.tablePrefix : '',
  };
  const base = Number.isInteger(opts.bodyLine) ? opts.bodyLine : 1;
  const lines = normalize(body).split('\n').map((raw, k) => ({ raw, t: raw.replace(/\s+$/, ''), n: base + k }));
  const r = renderBlocks(lines, ctx, false);
  const linkable = new Set(ctx.headings.filter((h) => h.linkable).map((h) => h.id));
  for (const p of ctx.pendingAnchors) {
    if (!linkable.has(p.id)) {
      // idPrefix がある（リリースノートの版の節）ときは、同じ節の見出しにしか飛べない
      const note = ctx.idPrefix ? '（リリースノートでは、同じ版の節の見出しにだけリンクできます。ほかの版の節へのリンクは書けません）' : '';
      throw new HelpBuildError(`無い飛び先へのリンク: #${p.shown}${note}`, { file: ctx.file, line: p.line, code: 'missing-anchor' });
    }
  }
  return { html: r.html, headings: ctx.headings, text: r.text, links: ctx.links };
}

module.exports = { parseFrontMatter, renderMarkdown, escapeHtml, HelpBuildError };
