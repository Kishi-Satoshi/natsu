'use strict';
// 貼り付けの変換の純粋な部品（0.14.0 Task EK-1。計画 docs/plans/2026-10-26-140.md の決めたこと 23・24・34・R15〜R17・R66・F102）。
// Word・Web・Teams の HTML、Markdown、素の文字を、行の並び [{ type, level?, rich, checked?, children? }] にする（‡131 入れ子は children）。
// 貼った HTML はデータとしてだけ読む（SEC2）: 自作の小さな字句の読み手で字句と決まった属性を読むだけで、要素を作らず・スクリプトを動かさず・
// 画面の HTML の口に渡さない（test/repo.test.js がこのファイルに要素を作る口の字が無いことを見る）。on… の属性は読まない。
// リンクは richText.linkOk に合う住所だけ（合わなければ文字だけ）。色・地の色・字の大きさ・書体は読まない（BQ5 (a)）。
// script・style などの中身・コメント・Word の条件つきコメント・<o:p>・画像・隠した要素は捨てる。
// 上限は子孫も数えて 2,000 行・1MB（validate.LIMITS と同じ値。R66）。越えれば { tooBig: true } だけを返す（一部だけを返さない）。
// 画面（app.html）は使う関数を写す（0.13.0 の blockEdit と同じ形。EK-3）。
const RT = require('./richText');
const { kidsCan } = require('./blockTree');

const PASTE_ROWS = 2000;                 // 行の数（子孫も数える。validate.LIMITS.blocks）
const PASTE_BYTES = 1024 * 1024;         // 行の並びの大きさ（UTF-8。validate.LIMITS.bytes）
const ROW_TEXT = 100000;                 // 1行の文字（validate.LIMITS.text）
const HTML_MAX = 16 * 1024 * 1024;       // 読む HTML の長さ（Word の HTML は飾りで文の 10 倍を越える）
const DEPTH_MAX = 256;                   // 読む要素の入れ子の深さ（これより深い要素は中の文字だけ）
const ROWS_HARD = PASTE_ROWS * 4;        // ここまで行が増えたら読むのをやめる（どのみち上限を越える）
const TOKENS_MAX = 400000;               // 読む HTML の字句の数（EK-1 直し: 2,000 行の Word の HTML でも 10 万ほど。越えれば大きすぎる: R124）
const TEXT_MAX = 3000000;                // 読む HTML の文字の数（実体参照を戻す前。行の 1MB の数倍。越えれば大きすぎる: R124）
const tooBig = () => ({ tooBig: true });
class TooBig extends Error {}

const ORDER = Object.freeze([...RT.MARKS, 'color', 'bg', 'link']);
const nameOf = (mk) => (Array.isArray(mk) ? mk[0] : mk);
const keyOf = (mk) => (Array.isArray(mk) ? `${mk[0]}\u0000${mk[1]}` : mk);
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;   // 落とす制御の文字（改行とタブは残す。C1 も: EK-1 直し）
const CR_RE = /\r\n?/g;   // 改行は「\n」にそろえる（HTML の &#13; も）
const isSpaceCode = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

// UTF-8 の大きさ
function utf8Len(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
// 改行をそろえ、頭の BOM と制御の文字を落とす
const cleanText = (s) => String(s ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(CTRL_RE, '');

// ---------------------------------------------------------------- 飾りの並び
// 飾りを足す・外す（同じ飾りは1つ・コードとリンクは同じ区切りに持てない: コードが勝つ・内側のリンクが外のリンクに勝つ）
function withMarks(marks, add, drop) {
  let out = marks.filter((mk) => !drop.includes(nameOf(mk)));
  for (const mk of add) {
    const n = nameOf(mk);
    if (drop.includes(n)) continue;
    if (n === 'link') {
      if (out.includes('code')) continue;
      out = out.filter((x) => nameOf(x) !== 'link');
    } else if (out.includes(n)) continue;
    if (n === 'code') out = out.filter((x) => nameOf(x) !== 'link');
    out = [...out, mk];
  }
  return out;
}
const sameMarks = (a, b) => a.length === b.length && a.every((mk, i) => keyOf(mk) === keyOf(b[i]));
const byOrder = (x, y) => ORDER.indexOf(nameOf(x)) - ORDER.indexOf(nameOf(y)) || (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0);
// 区切りの並びを整える（空の区切りを落とす・飾りを決まった順に・隣の同じ飾りは1つ）。いつも配列
function tidyRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.t) continue;
    const m = r.m.map((mk) => (Array.isArray(mk) ? [mk[0], mk[1]] : mk)).sort(byOrder);
    const last = out[out.length - 1];
    if (last && sameMarks(last.m, m)) last.t += r.t;
    else out.push({ t: r.t, m });
  }
  return out;
}
const runsText = (runs) => runs.map((r) => r.t).join('');
const hasText = (runs) => runs.some((r) => /\S/.test(r.t));
// 頭と終わりの空白（pre の行は頭の改行だけ）を落とす
function trimRuns(runs, keepLead) {
  const out = runs.map((r) => ({ t: r.t, m: r.m }));
  while (out.length) {
    const t = keepLead ? out[0].t.replace(/^\n+/, '') : out[0].t.replace(/^[ \t\n\r\f ]+/, '');
    if (t) { out[0].t = t; break; }
    out.shift();
  }
  while (out.length) {
    const t = out[out.length - 1].t.replace(/[ \t\n\r\f ]+$/, '');
    if (t) { out[out.length - 1].t = t; break; }
    out.pop();
  }
  return out;
}
// 改行で区切りの並びを分ける
function splitLines(runs) {
  const lines = [[]];
  for (const r of runs) {
    const parts = r.t.split('\n');
    parts.forEach((p, i) => { if (i) lines.push([]); if (p) lines[lines.length - 1].push({ t: p, m: r.m }); });
  }
  return lines;
}
// 頭の len 文字を落とす
function dropLead(runs, len) {
  const out = [];
  let left = len;
  for (const r of runs) {
    if (left >= r.t.length) { left -= r.t.length; continue; }
    out.push({ t: r.t.slice(left), m: r.m });
    left = 0;
  }
  return out;
}

// ---------------------------------------------------------------- 行の並び → 入れ子の行（R66）
// rows: [{ type, level?, checked?, runs, depth }]（depth は入れ子の段。前の行より2段以上深ければ1段深いだけにする）
function nest(rows) {
  const top = [];
  const path = [];
  for (const r of rows) {
    const d = Math.min(Math.max(0, r.depth | 0), path.length);
    path.length = d;
    const b = { type: r.type };
    if (r.type === 'heading') b.level = r.level;
    if (r.type === 'todo') b.checked = r.checked === true;
    b.rich = tidyRuns(r.runs.map((x) => ({ t: x.t.replace(/\u00a0/g, ' '), m: x.m })));   // EK-1 直し: &nbsp; は空白（つぶさずに数を残す）
    if (d === 0) top.push(b);
    else (path[d - 1].children || (path[d - 1].children = [])).push(b);
    path.push(b);
  }
  return liftKids(top);
}
// 子を持てない型（トグルでない見出し・区切り線）の下に来た子は、その行の後ろの兄弟に上げる（R66。kidsCan）
function liftKids(list) {
  const out = [];
  for (const b of list) {
    const kids = b.children ? liftKids(b.children) : [];
    delete b.children;
    if (kids.length && !kidsCan(b)) out.push(b, ...kids);
    else { if (kids.length) b.children = kids; out.push(b); }
  }
  return out;
}
// 行の数（子孫も数える: R66）
const countRows = (list) => list.reduce((n, b) => n + 1 + countRows(b.children || []), 0);
// 上限を見て答えを作る（越えれば { tooBig: true } だけ）
function finish(rows) {
  if (rows.some((r) => runsText(r.runs).length > ROW_TEXT)) return tooBig();
  const blocks = nest(rows);
  if (countRows(blocks) > PASTE_ROWS) return tooBig();
  if (utf8Len(JSON.stringify(blocks)) > PASTE_BYTES) return tooBig();
  // 1行だけの型の無い行は、行の中に飾りつきで入れる（決めたこと 24）
  return { blocks, inline: blocks.length === 1 && blocks[0].type === 'paragraph' && !blocks[0].children };
}
function pushRow(rows, row) {
  if (rows.length >= ROWS_HARD) throw new TooBig();
  rows.push(row);
}

// ---------------------------------------------------------------- HTML の字句
const NAMED = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '',
  zwnj: '‌', zwj: '‍', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', times: '×', divide: '÷', deg: '°', yen: '¥', euro: '€',
  sect: '§', para: '¶',
});
// 実体参照を文字に戻す（知らない名前はそのまま・ありえない数は U+FFFD）
function decode(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (all, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      return String.fromCodePoint(cp);
    }
    return Object.hasOwn(NAMED, body) ? NAMED[body] : all;
  });
}
// 中身を文字として読まない要素（閉じる印まで丸ごと捨てる）
const RAW_TEXT = new Set(['script', 'style', 'iframe', 'noembed', 'noframes', 'noscript', 'xmp', 'textarea', 'title', 'plaintext']);
// 読む属性はこれだけ（on… の属性・src などは読まない）
const KEEP_ATTRS = new Set(['href', 'style', 'class', 'type', 'checked', 'role', 'aria-checked', 'hidden']);
const NAME_RE = /[A-Za-z][A-Za-z0-9:_.-]*/y;

// 1つのタグ（i は '<' の所）→ { name, close, attrs, self, end } か null（タグでない）。閉じない属性は終わりまで読んで dead
function readTag(s, i) {
  const n = s.length;
  let k = i + 1;
  const close = s[k] === '/';
  if (close) k++;
  NAME_RE.lastIndex = k;
  const m = NAME_RE.exec(s);
  if (!m) return null;
  const name = m[0].toLowerCase();
  k = NAME_RE.lastIndex;
  const attrs = Object.create(null);
  let self = false;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 62) return { name, close, attrs, self, end: k + 1 };                  // >
    if (c === 47) { self = s.charCodeAt(k + 1) === 62; k++; continue; }             // /
    if (isSpaceCode(c)) { k++; continue; }
    const a = k;
    while (k < n) { const d = s.charCodeAt(k); if (isSpaceCode(d) || d === 47 || d === 62 || (d === 61 && k > a)) break; k++; }
    const an = s.slice(a, k).toLowerCase();
    while (k < n && isSpaceCode(s.charCodeAt(k))) k++;
    let val = '';
    if (s.charCodeAt(k) === 61) {                                                    // =
      k++;
      while (k < n && isSpaceCode(s.charCodeAt(k))) k++;
      const q = s[k];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, k + 1);
        if (e < 0) return { dead: true, end: n };
        val = s.slice(k + 1, e);
        k = e + 1;
      } else {
        const b = k;
        while (k < n) { const d = s.charCodeAt(k); if (isSpaceCode(d) || d === 62) break; k++; }
        val = s.slice(b, k);
      }
    }
    if (KEEP_ATTRS.has(an) && !(an in attrs)) attrs[an] = decode(val);
  }
  return { dead: true, end: n };
}

// HTML → 字句（text・start・end・cond（Word の条件つきの区切り）・raw（捨てる中身））を1つずつ feed に渡す（並びを溜めない: EK-1 直し）
function tokenize(s, feed) {
  const n = s.length;
  let i = 0, from = 0, chars = 0;
  const text = (end) => {
    if (end <= from) return;
    chars += end - from;
    if (chars > TEXT_MAX) throw new TooBig();   // 戻す前に数える（大きな文字の塊を戻してから断らない）
    feed({ type: 'text', text: decode(s.slice(from, end)) });
  };
  while (i < n) {
    i = s.indexOf('<', i);
    if (i < 0) break;
    // コメント（Word の条件つきコメント <!--[if gte mso 9]>…<![endif]--> も、中身ごと1つのコメントとして捨てる）。
    // <!--[if !supportLists]-->…<!--[endif]--> だけは区切りの印（中は見える文: Word の箇条の印）。<!--> と <!---> は空のコメント（HTML の決まり）
    if (s.startsWith('<!--', i)) {
      text(i);
      const tiny = s.startsWith('<!-->', i) ? 5 : s.startsWith('<!--->', i) ? 6 : 0;
      if (tiny) { i = from = i + tiny; continue; }
      const end = s.indexOf('-->', i + 4);
      const body = (end < 0 ? '' : s.slice(i + 4, Math.min(end, i + 4 + 200))).trim();
      if (/^\[if\s[^\]<>]*\]$/i.test(body)) feed({ type: 'cond', open: true });
      else if (/^\[endif\]$/i.test(body)) feed({ type: 'cond', open: false });
      i = from = end < 0 ? n : end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      text(i);
      const end = s.indexOf(']]>', i + 9);
      i = from = end < 0 ? n : end + 3;
      continue;
    }
    // Word の <![if !supportLists]>…<![endif]>（中は見える文。箇条の印として読み、行の文にはしない）。閉じない <![ は文字（後ろを飲み込まない）
    if (s.startsWith('<![', i)) {
      const end = s.indexOf(']>', i + 3);
      if (end < 0) { i++; continue; }
      text(i);
      const body = s.slice(i + 3, Math.min(end, i + 3 + 200)).trim();
      if (/^if\b/i.test(body)) feed({ type: 'cond', open: true });
      else if (/^endif$/i.test(body)) feed({ type: 'cond', open: false });
      i = from = end + 2;
      continue;
    }
    const c = s[i + 1];
    if (c === '!' || c === '?') {                     // <!DOCTYPE …>・<?xml …?>
      text(i);
      const end = s.indexOf('>', i + 2);
      i = from = end < 0 ? n : end + 1;
      continue;
    }
    const tag = readTag(s, i);
    if (!tag) { i++; continue; }                      // タグでない「<」は文字
    text(i);
    if (tag.dead) { i = from = n; break; }            // 閉じないタグは終わりまで捨てる
    i = from = tag.end;
    if (tag.close) { feed({ type: 'end', name: tag.name }); continue; }
    if (RAW_TEXT.has(tag.name)) {
      // 閉じる印まで中身を読まずに飛ばす（<script/> と書いても中身は捨てる）
      const re = new RegExp(`</${tag.name}(?=[\\s/>])`, 'ig');
      re.lastIndex = i;
      const hit = tag.name === 'plaintext' ? null : re.exec(s);
      const stop = hit ? hit.index : n;
      feed({ type: 'raw', name: tag.name, text: s.slice(i, stop) });
      if (!hit) { i = from = n; break; }
      const gt = s.indexOf('>', stop);
      i = from = gt < 0 ? n : gt + 1;
      continue;
    }
    feed({ type: 'start', name: tag.name, attrs: tag.attrs, self: tag.self });
  }
  text(n);
}

// ---------------------------------------------------------------- 字句 → 小さな木（{ tag, attrs, kids } と { text }。DOM の要素ではない）
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'frame', 'keygen']);
const LISTS = new Set(['ul', 'ol', 'menu', 'dir']);
const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'legend', 'li', 'main', 'menu',
  'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
// 字句を1つずつ受けて小さな木を組む（{ feed, root }）。開いた要素の名前ごとに積んだ位置を持ち、閉じる所を上から探さずに決める
// （EK-1 直し: 開いた要素の並びを1つの字句ごとに読み直すと、深い入れ子と多い字句で O(字句 × 深さ) になって止まる）。
// 受ける字句は TOKENS_MAX まで（越えれば TooBig: 16MB の悪い HTML でも、読む手間と記憶を決まった所で止める）
function buildTree() {
  const root = { tag: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const at = new Map();   // 名前 → 開いている位置の並び（浅い順）
  const skipped = Object.create(null);
  let count = 0;
  const top = () => stack[stack.length - 1];
  const push = (el) => {
    let list = at.get(el.tag);
    if (!list) { list = []; at.set(el.tag, list); }
    list.push(stack.length);
    stack.push(el);
  };
  const popTo = (k) => { while (stack.length > k) at.get(stack.pop().tag).pop(); };
  const last = (names) => { let k = -1; for (const t of names) { const l = at.get(t); if (l && l.length && l[l.length - 1] > k) k = l[l.length - 1]; } return k; };
  // want のどれかの要素まで閉じる（stop のどれかの要素がそれより内にあればやめる）
  const closeTo = (want, stop = []) => {
    const k = last(want);
    if (k <= 0 || last(stop) > k) return false;
    popTo(k);
    return true;
  };
  const LIST_NAMES = [...LISTS];
  function feed(tok) {
    if (++count > TOKENS_MAX) throw new TooBig();
    if (tok.type === 'raw') return;   // script・style などの中身は文字にしない
    if (tok.type === 'text') { if (tok.text) top().kids.push({ text: tok.text }); return; }
    if (tok.type === 'cond') {
      if (!tok.open) { closeTo(['#cond']); return; }
      if (stack.length > DEPTH_MAX) return;
      const el = { tag: '#cond', attrs: {}, kids: [] };
      top().kids.push(el);
      push(el);
      return;
    }
    const name = tok.name;
    if (tok.type === 'end') {
      if (name === 'br') { top().kids.push({ tag: 'br', attrs: {}, kids: [] }); return; }
      if (skipped[name] > 0) { skipped[name]--; return; }
      if (name === 'li') closeTo(['li'], LIST_NAMES);
      else if (name === 'tr' || name === 'td' || name === 'th') closeTo([name], ['table']);
      else closeTo([name]);
      return;
    }
    // 始まり: 省略された閉じる印を補う（p は塊の前で閉じる・li／tr／td は前の同じ要素を閉じる）。
    // Word の条件つきの区切り（箇条の印）は行の中だけなので、閉じないまま塊が来たら閉じる（後ろの文を飲み込まない）
    if (BLOCKS.has(name)) { const k = last(['#cond']); if (k > 0) popTo(k); }
    if (BLOCKS.has(name) && top().tag === 'p') popTo(stack.length - 1);
    if (name === 'li') closeTo(['li'], LIST_NAMES);
    else if (name === 'tr') closeTo(['tr'], ['table']);
    else if (name === 'td' || name === 'th') closeTo(['td', 'th'], ['tr', 'table']);
    const leaf = VOID.has(name) || tok.self;
    if (!leaf && stack.length > DEPTH_MAX) { skipped[name] = (skipped[name] || 0) + 1; return; }
    const el = { tag: name, attrs: tok.attrs, kids: [] };
    top().kids.push(el);
    if (!leaf) push(el);
  }
  return { feed, root };
}

// ---------------------------------------------------------------- 小さな木 → 行
// 中身ごと捨てる要素（画像・埋め込み・フォームの部品・頭の部分・Word の <o:p> など）
const DROP = new Set([
  'head', 'title', 'meta', 'link', 'base', 'template', 'object', 'embed', 'applet', 'param', 'img', 'picture', 'source', 'video', 'audio',
  'track', 'canvas', 'svg', 'math', 'map', 'area', 'select', 'option', 'optgroup', 'datalist', 'button', 'frame', 'frameset', 'xml', 'o:p',
  ...RAW_TEXT,
]);
function styleOf(attrs) {
  const out = Object.create(null);
  const s = attrs.style;
  if (!s) return out;
  for (const part of s.split(';')) {
    const c = part.indexOf(':');
    if (c < 0) continue;
    const k = part.slice(0, c).trim().toLowerCase();
    if (k) out[k] = part.slice(c + 1).replace(/!important/i, '').trim().toLowerCase();
  }
  return out;
}
const isHidden = (attrs, st) => attrs.hidden !== undefined || st.display === 'none' || st.visibility === 'hidden' || st['mso-hide'] === 'all';
// Word の箇条の段落の段（mso-list の levelN）。箇条でなければ 0。EK-1 直し（R124）: mso-list の無い MsoListParagraph（Word の「リスト段落」の
// 字下げだけの段落）は箇条にしない（ふつうの段落）
function wordLevel(_attrs, st) {
  const m = /\bl\d+\s+level(\d+)/i.exec(st['mso-list'] || '');
  return m ? Math.max(1, Math.min(9, Number(m[1]))) : 0;
}
// 要素の飾り（タグの名前と style の太さ・斜め・線だけ）
function elementMarks(tag, attrs, st, marks) {
  const add = [];
  const drop = [];
  if (tag === 'b' || tag === 'strong') add.push('b');
  else if (tag === 'i' || tag === 'em') add.push('i');
  else if (tag === 'u' || tag === 'ins') add.push('u');
  else if (tag === 's' || tag === 'strike' || tag === 'del') add.push('s');
  else if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') add.push('code');
  else if (tag === 'a') {
    const url = String(attrs.href ?? '').trim();
    if (RT.linkOk(url)) add.push(['link', url]);   // 開けない住所（javascript:・data: など）は文字だけ
  }
  // style は太さ・斜め・線だけを読む（色・地の色・字の大きさ・書体は読まない: BQ5 (a)）
  const w = st['font-weight'];
  if (w !== undefined) {
    if (/^(bold|bolder|[6-9]00)$/.test(w)) add.push('b');
    else if (/^(normal|lighter|[1-5]00)$/.test(w)) drop.push('b');   // Google ドキュメントが全体を包む <b style="font-weight:normal">
  }
  const fs = st['font-style'];
  if (fs !== undefined) {
    if (/^(italic|oblique)/.test(fs)) add.push('i');
    else if (fs === 'normal') drop.push('i');
  }
  const line = `${st['text-decoration'] || ''} ${st['text-decoration-line'] || ''}`;
  // リンクの下線（Word・Google ドキュメントの見た目）は飾りにしない
  if (/underline/.test(line) && ![...marks, ...add].some((mk) => nameOf(mk) === 'link')) add.push('u');
  if (/line-through/.test(line)) add.push('s');
  return withMarks(marks, add, drop);
}
// 中の文字を全部（Word の箇条の印を読む）
function plainText(node) {
  if (node.text !== undefined) return node.text;
  return node.kids.map(plainText).join('');
}

// Word の箇条の印 → { type, checked }
const NUM_MARK = /^(?:[0-9０-９]{1,9}[.．)）]?|[a-zA-Zａ-ｚＡ-Ｚ][.．)）]|[ivxlcdmIVXLCDM]{1,8}[.．)）]|[（(](?:[0-9０-９]{1,9}|[a-zA-Z]|[ivxIVX]{1,6})[)）]|[①-⑳])$/;
function markType(marker) {
  const m = marker.replace(/[\s ]+/g, '');
  if (m === '☐') return { type: 'todo', checked: false };
  if (/^[☑☒✓✔]$/.test(m)) return { type: 'todo', checked: true };
  return { type: NUM_MARK.test(m) ? 'numbered' : 'bullet', checked: false };
}
// 印を文字で書いた箇条の頭（Word の箇条の段落だけ）→ { len, type, checked } か null
const LEAD_BULLET = /^[  ]*(?:[・·•●○◦▪■□◆◇‣⁃–—§Ø][  ]*|[-*o][  ]+)/;
const LEAD_NUMBER = /^[  ]*(?:[0-9０-９]{1,9}[.．)）]|[（(][0-9０-９]{1,3}[)）]|[①-⑳])(?![0-9０-９])[  ]*/;
const LEAD_BOX = /^[  ]*(?:\[([ xX])\]|([☐☑☒]))[  ]*/;
function leadMarker(text) {
  let m;
  if ((m = LEAD_BOX.exec(text))) return { len: m[0].length, type: 'todo', checked: m[1] ? m[1] !== ' ' : m[2] !== '☐' };
  if ((m = LEAD_NUMBER.exec(text))) return { len: m[0].length, type: 'numbered', checked: false };
  if ((m = LEAD_BULLET.exec(text))) return { len: m[0].length, type: 'bullet', checked: false };
  return null;
}

// 小さな木 → 行の並び（{ type, level?, checked?, runs, depth }）
function htmlRows(root) {
  const rows = [];
  let cur = null;   // 書いている行 { runs, frame, pre }
  const rootFrame = { kind: 'root', depth: 0 };
  // 行の続きの段（項目の中の段落・表・引用は、その項目の子）
  const contDepth = (f) => (f.kind === 'li' ? f.depth + 1 : f.depth);
  const flush = () => {
    if (!cur) return;
    const { runs, frame, pre } = cur;
    cur = null;
    emit(runs, frame, pre);
  };
  function emit(runs, frame, pre) {
    const lines = frame.kind === 'root' || frame.kind === 'quote' ? splitLines(runs) : [runs];
    for (const raw of lines) {
      let line = trimRuns(raw, pre);
      if (!hasText(line)) continue;
      if (frame.kind === 'heading') { pushRow(rows, { type: 'heading', level: frame.level, runs: line, depth: frame.depth }); continue; }
      if (frame.kind === 'quote') { pushRow(rows, { type: 'quote', runs: line, depth: frame.depth }); continue; }
      if (frame.kind !== 'li') { pushRow(rows, { type: 'paragraph', runs: line, depth: frame.depth }); continue; }
      if (frame.emitted) { pushRow(rows, { type: 'paragraph', runs: line, depth: frame.depth + 1 }); continue; }
      frame.emitted = true;
      let kind = frame.word ? markType(frame.marker) : { type: frame.todo ? 'todo' : frame.ordered ? 'numbered' : 'bullet', checked: frame.checked };
      const lead = runsText(line);
      const head = (frame.word && !frame.marker.trim()) || LEAD_BOX.test(lead) ? leadMarker(lead) : null;
      if (head) { line = trimRuns(dropLead(line, head.len), pre); kind = head; }
      if (!hasText(line)) continue;
      pushRow(rows, { type: kind.type, checked: kind.checked, runs: line, depth: frame.depth });
    }
  }
  function addText(text, ctx) {
    let t = text.replace(CR_RE, '\n').replace(CTRL_RE, '');
    // 空白をつぶすのは HTML の空白だけ（&nbsp; は数を残す: nest で空白にする）
    t = ctx.pre ? t.replace(/ /g, ' ') : t.replace(/[ \t\n\f]+/g, ' ');
    if (!t) return;
    if (cur && cur.frame !== ctx.frame) flush();
    if (!ctx.pre && t[0] === ' ') {
      const last = cur && cur.runs.length ? cur.runs[cur.runs.length - 1].t : '';
      if (!last || last.endsWith(' ') || last.endsWith('\n')) t = t.slice(1);
      if (!t) return;
    }
    if (!cur) cur = { runs: [], frame: ctx.frame, pre: ctx.pre };
    cur.runs.push({ t, m: ctx.marks });
  }
  // 表は1行ずつ「セル / セル」の箇条書き（空のセルは詰める。0.13.0 の tableRowText と同じ考え）
  function tableRows(node, ctx) {
    const trs = [];
    const gone = (k) => DROP.has(k.tag) || isHidden(k.attrs, styleOf(k.attrs));   // EK-1 直し: 隠した行・セル・行の組も捨てる
    const findRows = (n) => {
      for (const k of n.kids || []) {
        if (k.text !== undefined || k.tag === 'table' || gone(k)) continue;
        if (k.tag === 'tr') trs.push(k);
        else if (k.tag !== 'td' && k.tag !== 'th') findRows(k);
      }
    };
    findRows(node);
    for (const tr of trs) {
      const row = [];
      for (const cell of tr.kids) {
        if ((cell.tag !== 'td' && cell.tag !== 'th') || gone(cell)) continue;
        const sink = [];
        inlineRuns(cell, ctx.marks, sink);
        const runs = trimRuns(sink.map((r) => ({ t: r.t.replace(/[ \t\n\f]+/g, ' '), m: r.m })), false);
        if (!hasText(runs)) continue;
        if (row.length) row.push({ t: ' / ', m: [] });
        row.push(...runs);
      }
      if (row.length) pushRow(rows, { type: 'bullet', runs: row, depth: contDepth(ctx.frame) });
    }
  }
  // 表のセルの中の文字（塊と改行は空白・入れ子の表も文字だけ）
  function inlineRuns(node, marks, sink) {
    for (const k of node.kids) {
      if (k.text !== undefined) { sink.push({ t: k.text.replace(CR_RE, '\n').replace(CTRL_RE, ''), m: marks }); continue; }
      const st = styleOf(k.attrs);
      if (DROP.has(k.tag) || k.tag.startsWith('v:') || k.tag === '#cond' || st['mso-list'] === 'ignore' || isHidden(k.attrs, st)) continue;
      if (k.tag === 'br' || BLOCKS.has(k.tag)) sink.push({ t: ' ', m: marks });
      inlineRuns(k, elementMarks(k.tag, k.attrs, st, marks), sink);
      if (BLOCKS.has(k.tag)) sink.push({ t: ' ', m: marks });
    }
  }
  function walk(node, ctx) {
    if (node.text !== undefined) { addText(node.text, ctx); return; }
    const tag = node.tag;
    const attrs = node.attrs;
    const st = styleOf(attrs);
    if (DROP.has(tag) || tag.startsWith('v:') || isHidden(attrs, st)) return;
    // Word の箇条の印（<![if !supportLists]> の中と mso-list:Ignore の span）は行の文にしない。箇条の段落なら印として読む
    if (tag === '#cond' || st['mso-list'] === 'ignore') {
      const f = ctx.frame;
      if (f.kind === 'li' && f.word && !f.emitted && !(cur && cur.frame === f && hasText(cur.runs))) f.marker += plainText(node);
      return;
    }
    if (tag === 'br') {
      if (cur && cur.frame !== ctx.frame) flush();
      if (!cur) cur = { runs: [], frame: ctx.frame, pre: ctx.pre };
      cur.runs.push({ t: '\n', m: ctx.marks });
      return;
    }
    if (tag === 'hr') { flush(); pushRow(rows, { type: 'divider', runs: [], depth: contDepth(ctx.frame) }); return; }
    if (tag === 'input') {
      if (String(attrs.type || '').toLowerCase() === 'checkbox' && ctx.frame.kind === 'li' && !ctx.frame.emitted) {
        ctx.frame.todo = true;
        ctx.frame.checked = attrs.checked !== undefined;
      }
      return;
    }
    if (tag === 'table') { flush(); tableRows(node, ctx); return; }
    const block = BLOCKS.has(tag) || tag === '#root';
    if (block) flush();
    // EK-1 直し（R124）: 文の無い項目の頭に入れ子の箇条が来たら、その項目を空の行にして子を付ける（前の箇条の最後の項目の子にしない）
    const fr = ctx.frame;
    if (LISTS.has(tag) && fr.kind === 'li' && !fr.word && !fr.emitted) {
      fr.emitted = true;
      pushRow(rows, { type: fr.todo ? 'todo' : fr.ordered ? 'numbered' : 'bullet', checked: fr.checked, runs: [], depth: fr.depth });
    }
    const c = { ...ctx, marks: elementMarks(tag, attrs, st, ctx.marks) };
    let m;
    if ((m = /^h([1-6])$/.exec(tag))) c.frame = { kind: 'heading', level: Math.min(Number(m[1]), 3), depth: contDepth(ctx.frame) };
    else if (tag === 'blockquote') c.frame = { kind: 'quote', depth: contDepth(ctx.frame) };
    else if (LISTS.has(tag)) {
      // ul の中に直に ul があれば1段深い（Google ドキュメントの形）。li の中なら、その項目の子
      c.list = { depth: ctx.listHere ? ctx.list.depth + 1 : contDepth(ctx.frame), ordered: tag === 'ol' };
      c.listHere = true;
    } else if (tag === 'li') {
      const role = String(attrs.role || '').toLowerCase();
      c.frame = {
        kind: 'li', depth: ctx.list ? ctx.list.depth : contDepth(ctx.frame), ordered: Boolean(ctx.list && ctx.list.ordered),
        todo: role === 'checkbox', checked: role === 'checkbox' && String(attrs['aria-checked'] || '').toLowerCase() === 'true', emitted: false,
      };
      c.listHere = false;
    } else if (tag === 'p' || tag === 'div') {
      const level = wordLevel(attrs, st);
      if (level) c.frame = { kind: 'li', word: true, marker: '', depth: level - 1, emitted: false, todo: false, checked: false };
    }
    if (tag === 'pre' || /^pre/.test(st['white-space'] || '')) c.pre = true;
    for (const k of node.kids) walk(k, c);
    if (block) flush();
  }
  walk(root, { marks: [], frame: rootFrame, list: null, listHere: false, pre: false });
  flush();
  return rows;
}

// EK-2 直し（C1・R127）: StartFragment の印の前で開いたままの表と箇条の要素（Excel は印を <table …><col …> の後ろ・表の中に書く）。
// 属性の無い開く印にして、貼った所の頭に足す（足さないと、表のセルが1つずつの段落になる）。字句の読み手で読む（コメント・style の中の字はタグにしない）。
// 積むのは DEPTH_MAX 段まで・字句は TOKENS_MAX まで（16MB の悪い頭でも止まる）
const CONTEXT = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'menu', 'dir', 'li']);
function openContext(head) {
  const open = [];
  const skipped = Object.create(null);
  let count = 0;
  tokenize(head, (tok) => {
    if (++count > TOKENS_MAX) throw new TooBig();
    if ((tok.type !== 'start' && tok.type !== 'end') || !CONTEXT.has(tok.name)) return;
    const name = tok.name;
    if (tok.type === 'end') {
      if (skipped[name] > 0) { skipped[name]--; return; }
      const k = open.lastIndexOf(name);
      if (k >= 0) open.length = k;
      return;
    }
    if (tok.self) return;
    if ((name === 'li' || name === 'tr') && open[open.length - 1] === name) open.pop();   // 省いた閉じる印
    if (open.length >= DEPTH_MAX) { skipped[name] = (skipped[name] || 0) + 1; return; }
    open.push(name);
  });
  return open.map((n) => `<${n}>`).join('');
}
// Chromium・Word・Excel のクリップボードの HTML の、貼った所だけ（Windows の頭の行・StartFragment の外は読まない。印の前で開いたままの表と箇条は残す）
function fragmentOf(html) {
  let s = html;
  if (/^Version:\d/.test(s)) { const lt = s.indexOf('<'); s = lt < 0 ? '' : s.slice(lt); }
  const a = s.indexOf('<!--StartFragment-->');
  const b = s.lastIndexOf('<!--EndFragment-->');
  if (a >= 0 && b > a) s = openContext(s.slice(0, a)) + s.slice(a + '<!--StartFragment-->'.length, b);
  return s;
}

// HTML（Word・Web・Teams）→ { blocks, inline } か { tooBig: true }
function fromHtml(html) {
  const s = typeof html === 'string' ? html : '';
  if (s.length > HTML_MAX) return tooBig();
  try {
    const tree = buildTree();
    tokenize(fragmentOf(s), tree.feed);
    return finish(htmlRows(tree.root));
  } catch (e) {
    if (e instanceof TooBig) return tooBig();
    throw e;
  }
}

// ---------------------------------------------------------------- Markdown
const DELIMS = Object.freeze([
  { sym: '***', marks: ['b', 'i'], word: false }, { sym: '___', marks: ['b', 'i'], word: true },   // EK-1 直し: 太字の斜体
  { sym: '**', marks: ['b'], word: false }, { sym: '__', marks: ['b'], word: true }, { sym: '~~', marks: ['s'], word: false },
  { sym: '*', marks: ['i'], word: true }, { sym: '_', marks: ['i'], word: true },
]);
const ESC_RE = /[!-/:-@[-`{-~]/;           // \ で逃がせる ASCII の記号
const WORD_CH = /[A-Za-z0-9]/;
const isWs = (ch) => ch === undefined || /\s/.test(ch);
// 1行の文中の飾り（**b**・__b__・*i*・_i_・~~s~~・`code`・[t](u)）→ 区切りの並び。
// 閉じる記号・対の括弧は前もって表にし、どの位置も一度ずつ読む（大きな行でも止まらない）
function mdInline(s) {
  const n = s.length;
  if (!/[*_~`[\\]/.test(s)) return s ? [{ t: s, m: [] }] : [];
  const opener = (i, d) => {
    if (!s.startsWith(d.sym, i) || isWs(s[i + d.sym.length])) return false;
    const ch = d.sym[0];
    if (d.sym.length === 1 && (s[i + 1] === ch || s[i - 1] === ch)) return false;
    if (d.word && i > 0 && WORD_CH.test(s[i - 1])) return false;   // 語の途中（1*2*3・snake_case）は開かない
    return true;
  };
  const closer = (j, d) => {
    if (j === 0 || !s.startsWith(d.sym, j) || isWs(s[j - 1]) || s[j - 1] === '\\') return false;
    const ch = d.sym[0];
    if (d.sym.length === 1 && (s[j - 1] === ch || s[j + 1] === ch)) return false;
    if (ch === '_' && WORD_CH.test(s[j + d.sym.length] || '')) return false;
    return true;
  };
  // 記号ごとに「この位置から先で最初の閉じる記号」
  const next = DELIMS.map((d) => {
    const a = new Int32Array(n + 2).fill(-1);
    for (let j = n - 1; j >= 0; j--) a[j] = closer(j, d) ? j : a[j + 1];
    return a;
  });
  // ` の並びの対（同じ長さの次の並び）
  const code = new Int32Array(n + 1).fill(-1);
  const ticks = [];
  for (let i = 0; i < n;) { if (s[i] === '`') { let j = i; while (s[j] === '`') j++; ticks.push([i, j - i]); i = j; } else i++; }
  const seen = new Map();
  for (let k = ticks.length - 1; k >= 0; k--) { const [at, len] = ticks[k]; if (seen.has(len)) code[at] = seen.get(len); seen.set(len, at); }
  // [ ] と ( ) の対（逃がした記号は数えない）
  const pair = (open, close) => {
    const a = new Int32Array(n + 1).fill(-1);
    const st = [];
    for (let i = 0; i < n; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === open) st.push(i);
      else if (s[i] === close && st.length) a[st.pop()] = i;
    }
    return a;
  };
  const bracket = pair('[', ']');
  const paren = pair('(', ')');
  const out = [];
  const parse = (a, b, marks) => {
    let buf = '';
    const put = () => { if (buf) { out.push({ t: buf, m: marks }); buf = ''; } };
    let i = a;
    while (i < b) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < b && ESC_RE.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      if (ch === '`') {
        let len = 0;
        while (i + len < b && s[i + len] === '`') len++;
        const j = code[i];
        if (j > i && j + len <= b) {
          put();
          let t = s.slice(i + len, j);
          if (t.length > 2 && t[0] === ' ' && t[t.length - 1] === ' ' && t.trim()) t = t.slice(1, -1);
          out.push({ t, m: withMarks(marks, ['code'], []) });
          i = j + len;
          continue;
        }
        buf += s.slice(i, i + len);
        i += len;
        continue;
      }
      if (ch === '[') {
        const k = bracket[i];
        if (k > i && k + 1 < b && s[k + 1] === '(') {
          const p = paren[k + 1];
          // EK-1 直し: リンクの中のリンク（[[a](u)](v)）は外のリンクの文字だけ（中の記号と住所は落とす）
          if (p > k + 1 && p < b && marks.some((mk) => nameOf(mk) === 'link')) { put(); parse(i + 1, k, marks); i = p + 1; continue; }
          if (p > k + 1 && p < b) {
            put();
            let url = s.slice(k + 2, p).trim();
            url = url.startsWith('<') && url.includes('>') ? url.slice(1, url.indexOf('>')) : url.split(/[ \t]/)[0];
            url = url.replace(/\\([!-/:-@[-`{-~])/g, '$1');
            // 開けない住所（javascript:・data: など）は文字だけ
            parse(i + 1, k, RT.linkOk(url) ? withMarks(marks, [['link', url]], []) : marks);
            i = p + 1;
            continue;
          }
        }
      }
      let hit = false;
      for (let x = 0; x < DELIMS.length; x++) {
        const d = DELIMS[x];
        if (d.marks.some((mk) => marks.includes(mk)) || !opener(i, d)) continue;
        const len = d.sym.length;
        const j = i + len + 1 <= n ? next[x][i + len + 1] : -1;
        if (j < 0 || j + len > b) continue;
        put();
        parse(i + len, j, withMarks(marks, d.marks, []));
        i = j + len;
        hit = true;
        break;
      }
      if (hit) continue;
      buf += ch;
      i++;
    }
    put();
  };
  parse(0, n, []);
  return out;
}

const MD_FENCE = /^(`{3,}|~{3,})/;
const MD_DIVIDER = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const MD_TODO = /^[-*+][ \t]+\[([ xX])\](?:[ \t]+(.*))?$/;
const MD_BULLET = /^[-*+][ \t]+(.*)$/;
const MD_NUMBER = /^\d{1,9}[.)][ \t]+(.*)$/;
const MD_QUOTE = /^(?:>[ \t]?)+(.*)$/;
const MD_TABLE_SEP = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?$/;
const MD_TABLE_ROW = /^\|(.+)\|$/;
const MD_BLOCK = /^(?:#{1,6}[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t]|>|```|~~~)/;
// 字下げの幅（タブは 4 の倍数まで進む）と、字下げの字の数
function indentOf(line) {
  let w = 0, k = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) { w = line[k] === '\t' ? w + 4 - (w % 4) : w + 1; k++; }
  return { width: w, len: k };
}
// Markdown として読むか（行の頭の印か文中の飾りがある: R17）
function looksMarkdown(text) {
  const lines = cleanText(text).split('\n');
  for (const line of lines) {
    const body = line.replace(/^[ \t]+/, '').trimEnd();
    if (MD_BLOCK.test(body) || MD_DIVIDER.test(body) || MD_TABLE_SEP.test(body)) return true;
  }
  return lines.some((line) => line.length <= ROW_TEXT && /[*_~`[]/.test(line) && mdInline(line).some((r) => r.m.length));
}
// Markdown → { blocks, inline } か { tooBig: true }
function fromMarkdown(text) {
  const t = cleanText(text);
  if (utf8Len(t) > PASTE_BYTES) return tooBig();
  const lines = t.split('\n');
  if (lines.some((l) => l.length > ROW_TEXT)) return tooBig();
  const table = lines.some((l) => MD_TABLE_SEP.test(l.trim()));
  const rows = [];
  const indents = [];   // 上の行の字下げの幅（浅い順）
  let fence = null;
  try {
    for (const raw of lines) {
      if (fence) {
        // 囲みのコードの中は印を読まない（1行1行を文字の行に）
        const body = raw.replace(/^[ \t]+/, '').trimEnd();
        if (body.length >= fence.len && body === fence.mark.repeat(body.length)) { fence = null; continue; }
        const line = raw.slice(Math.min(indentOf(raw).len, fence.cut)).trimEnd();
        if (line.trim()) pushRow(rows, { type: 'paragraph', runs: [{ t: line, m: [] }], depth: fence.depth });
        continue;
      }
      if (!raw.trim()) continue;
      const { width, len } = indentOf(raw);
      const body = raw.slice(len).trimEnd();
      // 字下げの段: 上の行で今より浅い字下げの数（2つ・4つの空白・タブのどれでも1段: R66）
      const depth = indents.filter((w) => w < width).length;
      indents.length = depth;
      const f = MD_FENCE.exec(body);
      // EK-1 直し: 同じ行で閉じる ```…```（` の囲みの頭の文に ` は入らない）は文中のコード
      if (f && !(f[1][0] === '`' && body.slice(f[1].length).includes('`'))) { fence = { mark: f[1][0], len: f[1].length, cut: len, depth }; continue; }
      indents.push(width);
      let m;
      if (MD_DIVIDER.test(body)) pushRow(rows, { type: 'divider', runs: [], depth });
      else if ((m = MD_HEADING.exec(body))) pushRow(rows, { type: 'heading', level: Math.min(m[1].length, 3), runs: mdInline(m[2]), depth });
      else if ((m = MD_TODO.exec(body))) pushRow(rows, { type: 'todo', checked: m[1] !== ' ', runs: mdInline(m[2] || ''), depth });
      else if ((m = MD_BULLET.exec(body))) pushRow(rows, { type: 'bullet', runs: mdInline(m[1]), depth });
      else if ((m = MD_NUMBER.exec(body))) pushRow(rows, { type: 'numbered', runs: mdInline(m[1]), depth });
      else if ((m = MD_QUOTE.exec(body))) pushRow(rows, { type: 'quote', runs: mdInline(m[1]), depth });
      else if (table && MD_TABLE_SEP.test(body)) indents.pop();
      else if (table && (m = MD_TABLE_ROW.exec(body))) {
        // 表は1行ずつ「セル / セル」の箇条書き（空のセルは詰める）
        const cells = m[1].split('|').map((c) => trimRuns(mdInline(c.trim()), false)).filter(hasText);
        pushRow(rows, { type: 'bullet', runs: cells.flatMap((c, k) => (k ? [{ t: ' / ', m: [] }, ...c] : c)), depth });
      } else pushRow(rows, { type: 'paragraph', runs: mdInline(body), depth });
    }
  } catch (e) {
    if (e instanceof TooBig) return tooBig();
    throw e;
  }
  // 中身の無い行（「- 」だけ・「- [ ]」だけ）は落とす。区切り線は文を持たない
  return finish(rows.filter((r) => r.type === 'divider' || hasText(r.runs)).map((r) => (r.type === 'divider' ? r : { ...r, runs: trimRuns(r.runs, false) })));
}

// ---------------------------------------------------------------- 素の文字
// 素の文字 → 1行1行をテキストの行（空の行は詰める: R16）
function fromPlain(text) {
  const t = cleanText(text);
  if (utf8Len(t) > PASTE_BYTES) return tooBig();
  const lines = t.split('\n');
  const rows = [];
  try {
    for (const line of lines) {
      const s = line.trimEnd();
      if (s.trim()) pushRow(rows, { type: 'paragraph', runs: [{ t: s, m: [] }], depth: 0 });
    }
  } catch (e) {
    if (e instanceof TooBig) return tooBig();
    throw e;
  }
  return finish(rows);
}

// どれで変換するかを決める（HTML があれば HTML。無ければ Markdown の印か文中の飾りがあれば Markdown、どちらでもなければ素の文字: 決めたこと 24）
// EK-3 直し（R140）: 要素の印（<名前）の無い HTML（素の文字を text/html にも置くアプリ）は、文字の方に文があれば文字で読む（HTML の空白の決まりで改行がつぶれない）
function pasteBlocks(input) {
  const { html, text } = input && typeof input === 'object' ? input : {};
  const plainToo = typeof text === 'string' && text.trim() !== '';
  if (typeof html === 'string' && html.trim() && (/<[A-Za-z]/.test(html) || !plainToo)) {
    const r = fromHtml(html);
    if (r.tooBig || r.blocks.length) return r;   // 画像だけの HTML などで行が無ければ素の文字を読む
  }
  const t = typeof text === 'string' ? text : '';
  if (utf8Len(t) > PASTE_BYTES) return tooBig();
  if (looksMarkdown(t)) return fromMarkdown(t);
  return fromPlain(t);
}

module.exports = { PASTE_ROWS, PASTE_BYTES, fromHtml, fromMarkdown, fromPlain, pasteBlocks };
