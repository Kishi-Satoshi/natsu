'use strict';
// 文字の飾りの純粋な部品（0.14.0 Task EB-1。計画 docs/plans/2026-10-26-140.md の決めたこと 14〜22・BQ3・R9〜R13・R73）。
// 書記素の境は src/blockEdit.js の safeOffset だけを読む（境の決まりを2つにしない。blockEdit も何も読まない）。
// rich の形: [{ t: 文字, m: [飾り] }]。飾りは 'b'・'i'・'u'・'s'・'code' と ['color', 色]・['bg', 色]・['link', 住所]。
// 1つの区切りが持てる色は1つ（文字の色か背景の色のどちらか: BQ3）。code と link は同じ区切りに持てない（コードの中のリンクは開かない）。
// 範囲 [s, e) の位置は UTF-16 で、どれも書記素の境に寄せる。範囲を変える関数は、整えた区切りの並び（飾りが無くても配列）を返す。
// 行に書くときは normalizeRich で整え、飾りが無ければ null（飾りの無い行は rich を持たない）。
// DB の照らし（src/db/validate.js の richText）はリンクの頭の表 LINK_HEAD_RE と LINK_CTRL_RE をここから読む（R73）。
// 画面（app.html）は使う関数を写す（0.13.0 の blockEdit と同じ形）。
const { safeOffset } = require('./blockEdit');

const MARKS = Object.freeze(['b', 'i', 'u', 's', 'code']);
const COLORS = Object.freeze(['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']);
const ORDER = Object.freeze([...MARKS, 'color', 'bg', 'link']);   // 区切りの中の飾りの決まった順
const COLOR_KINDS = Object.freeze(['color', 'bg']);
const STOP_AT_END = Object.freeze(['code', 'link']);              // 終わりで打った文字に引き継がない飾り
// 開けるリンクの頭（http(s)・mailto・NaTsu のリンク。0.10.0 の https のリンクの頭は https:// に入る）
const LINK_HEADS = Object.freeze(['https://', 'http://', 'mailto:', 'natsu://page/']);
const LINK_HEAD_RE = new RegExp(`^(?:${LINK_HEADS.map((h) => h.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})`, 'i');
const LINK_CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/;              // 制御の文字（C0・DEL・C1）
const LINK_MAX = 2048;

const nameOf = (mk) => (Array.isArray(mk) ? mk[0] : mk);
const keyOf = (mk) => (Array.isArray(mk) ? `${mk[0]}\u0000${mk[1]}` : mk);
const isRun = (r) => Boolean(r) && typeof r === 'object' && typeof r.t === 'string';

// 開いてよいリンクか（前後の空白・制御の文字・長すぎるものは偽）
function linkOk(url) {
  if (typeof url !== 'string' || !url || url.length > LINK_MAX) return false;
  if (url.trim() !== url || LINK_CTRL_RE.test(url)) return false;
  if (!LINK_HEAD_RE.test(url)) return false;
  return true;
}

// 飾り1つが決まった形か
function markOk(mk) {
  if (typeof mk === 'string') return MARKS.includes(mk);
  if (!Array.isArray(mk) || mk.length !== 2) return false;
  if (COLOR_KINDS.includes(mk[0])) return COLORS.includes(mk[1]);
  return mk[0] === 'link' && typeof mk[1] === 'string';
}
// 飾りの並びを整える（知らない飾りを落とす・重なりを1つに・決まった順に）
function cleanMarks(m) {
  const seen = new Set();
  const out = [];
  for (const mk of Array.isArray(m) ? m : []) {
    if (!markOk(mk) || seen.has(keyOf(mk))) continue;
    seen.add(keyOf(mk));
    out.push(Array.isArray(mk) ? [mk[0], mk[1]] : mk);
  }
  return out.sort((x, y) => ORDER.indexOf(nameOf(x)) - ORDER.indexOf(nameOf(y)) || (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0));
}
const sameMarks = (a, b) => a.length === b.length && a.every((mk, i) => keyOf(mk) === keyOf(b[i]));

// 区切りの並びを整える（空の区切りを落とす・飾りを整える・隣の同じ飾りは1つ）。いつも配列
function tidy(rich) {
  const out = [];
  for (const run of Array.isArray(rich) ? rich : []) {
    if (!isRun(run) || run.t === '') continue;
    const m = cleanMarks(run.m);
    const last = out[out.length - 1];
    if (last && sameMarks(last.m, m)) last.t += run.t;
    else out.push({ t: run.t, m });
  }
  return out;
}
// 行に書く形 → 整えた rich か null（飾りが無ければ null）
function normalizeRich(rich) {
  const out = tidy(rich);
  return out.some((r) => r.m.length) ? out : null;
}
// 素の文字（validate.richText と同じ答え）
function plainOf(rich) {
  return (Array.isArray(rich) ? rich : []).map((r) => (isRun(r) ? r.t : '')).join('');
}
// ブロック → 区切りの並び（rich が無ければ文字1つの区切り）
function richOf(block) {
  const b = block && typeof block === 'object' ? block : {};
  if (Array.isArray(b.rich)) return tidy(b.rich);
  return tidy([{ t: typeof b.text === 'string' ? b.text : '', m: [] }]);
}

// 整えた並びと、書記素の境に寄せた範囲（逆さなら入れ替える）
function spanOf(rich, s, e) {
  const runs = tidy(rich);
  const text = plainOf(runs);
  const a = safeOffset(text, s);
  const b = safeOffset(text, e);
  return { runs, text, a: Math.min(a, b), b: Math.max(a, b) };
}
// 区切りを [a, b) の前・中・後ろに分ける（写しを返す）
function cut(runs, a, b) {
  const pre = [], mid = [], post = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.t.length;
    const piece = (x, y) => ({ t: r.t.slice(x - pos, y - pos), m: r.m.slice() });
    if (end <= a) pre.push(piece(pos, end));
    else if (pos >= b) post.push(piece(pos, end));
    else {
      if (pos < a) pre.push(piece(pos, a));
      mid.push(piece(Math.max(pos, a), Math.min(end, b)));
      if (end > b) post.push(piece(b, end));
    }
    pos = end;
  }
  return { pre, mid, post };
}

// [s, e) が全部その飾りなら外す・どこか無ければ付ける。空の範囲は何もしない
function toggleMark(rich, s, e, mark) {
  if (!MARKS.includes(mark)) throw new Error('toggleMark: 知らない飾り');
  const { runs, a, b } = spanOf(rich, s, e);
  if (a >= b) return runs;
  const { pre, mid, post } = cut(runs, a, b);
  const all = mid.every((r) => r.m.includes(mark));
  for (const r of mid) {
    r.m = r.m.filter((x) => x !== mark);
    if (all) continue;
    r.m.push(mark);
    if (mark === 'code') r.m = r.m.filter((x) => nameOf(x) !== 'link');
  }
  return tidy([...pre, ...mid, ...post]);
}
// [s, e) の色を置き換える（前の文字の色も背景の色も外してから付ける: BQ3）。name が null なら色を全部外す（「既定」）
function setColor(rich, s, e, kind, name) {
  if (!COLOR_KINDS.includes(kind)) throw new Error('setColor: 知らない種類');
  if (name !== null && !COLORS.includes(name)) throw new Error('setColor: 知らない色');
  const { runs, a, b } = spanOf(rich, s, e);
  if (a >= b) return runs;
  const { pre, mid, post } = cut(runs, a, b);
  for (const r of mid) {
    r.m = r.m.filter((x) => !COLOR_KINDS.includes(nameOf(x)));
    if (name !== null) r.m.push([kind, name]);
  }
  return tidy([...pre, ...mid, ...post]);
}
// [s, e) にリンクを付ける（コードは外れる）。url が null なら外す。開けない住所は投げる
function setLink(rich, s, e, url) {
  if (url !== null && !linkOk(url)) throw new Error('setLink: 開けないリンク');
  const { runs, a, b } = spanOf(rich, s, e);
  if (a >= b) return runs;
  const { pre, mid, post } = cut(runs, a, b);
  for (const r of mid) {
    r.m = r.m.filter((x) => nameOf(x) !== 'link');
    if (url !== null) r.m = [...r.m.filter((x) => x !== 'code'), ['link', url]];
  }
  return tidy([...pre, ...mid, ...post]);
}
// at に piece（区切りの並び。素の文字ならその所で打った文字と同じ飾りを引き継ぐ）を入れる
function insertRich(rich, at, piece) {
  const { runs, a } = spanOf(rich, at, at);
  const add = typeof piece === 'string' ? [{ t: piece, m: marksAt(runs, a) }] : tidy(piece);
  const { pre, post } = cut(runs, a, a);
  return tidy([...pre, ...add, ...post]);
}
// [s, e) の区切りの並び
function sliceRich(rich, s, e) {
  const { runs, a, b } = spanOf(rich, s, e);
  return a >= b ? [] : tidy(cut(runs, a, b).mid);
}
// at で打った文字が引き継ぐ飾り（前の文字の飾り。コードとリンクは、その終わりと頭では引き継がない）
function marksAt(rich, at) {
  const { runs, text, a } = spanOf(rich, at, at);
  if (!runs.length) return [];
  const marksOfChar = (i) => {
    let pos = 0;
    for (const r of runs) { if (i < pos + r.t.length) return r.m; pos += r.t.length; }
    return [];
  };
  const prev = marksOfChar(a > 0 ? a - 1 : 0);
  const next = a < text.length ? marksOfChar(a) : [];
  const has = (list, mk) => list.some((x) => keyOf(x) === keyOf(mk));
  return prev.filter((mk) => !STOP_AT_END.includes(nameOf(mk)) || (a > 0 && has(next, mk))).map((mk) => (Array.isArray(mk) ? [...mk] : mk));
}

// ---------------------------------------------------------------- 画面の欄の span の木（決めたこと 17）
// 区切り1つ → span の印（data-m は MARKS の名前を空白で区切る・色と背景と住所は別の印）
function runAttrs(m) {
  const attrs = {};
  const names = m.filter((mk) => typeof mk === 'string');
  if (names.length) attrs['data-m'] = names.join(' ');
  for (const mk of m) {
    if (!Array.isArray(mk)) continue;
    if (mk[0] === 'color') attrs['data-color'] = mk[1];
    else if (mk[0] === 'bg') attrs['data-bg'] = mk[1];
    else if (mk[0] === 'link') attrs['data-link'] = mk[1];
  }
  return attrs;
}
// rich → 画面が要素にする木（{ text } か { tag: 'span', attrs, kids }）。画面の richNodes はこれを createElement と textContent で作る
function richTree(rich) {
  return tidy(rich).map((r) => (r.m.length ? { tag: 'span', attrs: runAttrs(r.m), kids: [{ text: r.t }] } : { text: r.t }));
}
// 自分の span の印 → 飾り（知らない名前・決まっていない色・開けない住所は捨てる）
function spanMarks(attrs) {
  const at = attrs && typeof attrs === 'object' ? attrs : {};
  const out = String(at['data-m'] ?? '').split(/\s+/).filter((x) => MARKS.includes(x));
  if (COLORS.includes(at['data-color'])) out.push(['color', at['data-color']]);
  else if (COLORS.includes(at['data-bg'])) out.push(['bg', at['data-bg']]);
  if (linkOk(at['data-link'])) out.push(['link', at['data-link']]);
  return out;
}
// 内側の飾りを外の飾りに重ねる（内側に色があれば外の色を外す・内側のリンクは外のコードを外す・内側のコードは外のリンクを外す）
function layer(outer, own) {
  const ownNames = own.map(nameOf);
  const drop = new Set();
  if (ownNames.some((n) => COLOR_KINDS.includes(n))) COLOR_KINDS.forEach((n) => drop.add(n));
  if (ownNames.includes('link')) { drop.add('code'); drop.add('link'); }
  if (ownNames.includes('code')) drop.add('link');
  const mine = ownNames.includes('code') && ownNames.includes('link') ? own.filter((mk) => nameOf(mk) !== 'link') : own;
  return [...outer.filter((mk) => !drop.has(nameOf(mk))), ...mine];
}
// 欄の子の木（{ text } | { tag, attrs, kids }。1つか並び）→ 区切りの並び（知らない要素は文字だけ・br は改行）
function richFromNodes(tree) {
  const out = [];
  const walk = (node, marks) => {
    if (Array.isArray(node)) { for (const k of node) walk(k, marks); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') { out.push({ t: node.text, m: marks }); return; }
    const tag = String(node.tag ?? '').toLowerCase();
    if (tag === 'br') { out.push({ t: '\n', m: marks }); return; }
    const own = tag === 'span' ? spanMarks(node.attrs) : [];
    walk(Array.isArray(node.kids) ? node.kids : [], layer(marks, own));
  };
  walk(tree, []);
  return tidy(out);
}

// ---------------------------------------------------------------- 打って変える記法（M-10〜M-13。半角だけ: R10）
const INLINE = Object.freeze([
  { mark: 'b', sym: '**' }, { mark: 'i', sym: '*' }, { mark: 'code', sym: '`' }, { mark: 's', sym: '~' },
]);
const WORD_RE = /[A-Za-z0-9]/;
// before（カーソルの前の文。閉じる記号を打った後）→ { mark, open, close, size } か null。
// open は開く記号の頭・close は閉じる記号の頭・size は記号の長さ。中身は空でなく、空白で始まらず終わらず、改行を持たない。
// 開く記号の前が英数字（語の途中: 1*2*3）・1文字の記号の隣に同じ記号（** の片方・~~）なら変えない
function inlineShortcut(before) {
  const s = String(before ?? '');
  const row = INLINE.find((r) => s.endsWith(r.sym));
  if (!row) return null;
  const n = row.sym.length;
  const close = s.length - n;
  if (n === 1 && s[close - 1] === row.sym) return null;
  const open = s.lastIndexOf(row.sym, close - n - 1);
  if (open < 0) return null;
  if (n === 1 && (s[open - 1] === row.sym || s[open + 1] === row.sym)) return null;
  const inner = s.slice(open + n, close);
  if (!inner || /^\s|\s$/.test(inner) || inner.includes('\n')) return null;
  if (open > 0 && (WORD_RE.test(s[open - 1]) || s[open - 1] === row.sym[0])) return null;
  return { mark: row.mark, open, close, size: n };
}

// ---------------------------------------------------------------- ［コピー］の Markdown（R13: 下線と色は文字だけ）
function richMarkdown(rich) {
  return tidy(rich).map(({ t, m }) => {
    let s = t;
    if (m.includes('code')) s = `\`${s}\``;
    if (m.includes('s')) s = `~~${s}~~`;
    if (m.includes('i')) s = `*${s}*`;
    if (m.includes('b')) s = `**${s}**`;
    const link = m.find((mk) => nameOf(mk) === 'link');
    if (link) s = `[${s}](${link[1]})`;
    return s;
  }).join('');
}

module.exports = {
  MARKS, COLORS, LINK_HEADS, LINK_HEAD_RE, LINK_CTRL_RE, LINK_MAX,
  richOf, normalizeRich, plainOf, toggleMark, setColor, setLink, insertRich, sliceRich, marksAt,
  richTree, richFromNodes, inlineShortcut, linkOk, richMarkdown,
};
