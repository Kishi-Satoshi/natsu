'use strict';
// 要約の編集の純粋な部品（0.13.0 Task ED-1。計画 docs/plans/2026-10-24-130.md の第1部 E2〜E5・E11。何も読まない）。
// 型の表（BLOCK_TYPES。1か所）・書記素の境で分ける・行頭の記法・/ の絞り込みと「最近使ったもの」・Enter と Backspace の決まり・
// 番号・近道・［コピー］の Markdown・行だけの描き直しの計画。画面（app.html）は部品を読めないので、使う関数を写し、
// test/repo.test.js が字面で取り出して同じ表で照らす（0.10.0 の summaryLockView と同じ）。

// 型の表（計画の「ブロックの型の表」と1行ずつ同じ。test/stage130.edit.lib.test.js が計画の表と照らす）。
// key は DB の type・id は / メニューと「最近使ったもの」の鍵・words は / で当たる語・md は行頭の記法・code は近道（Ctrl+Shift+ の ev.code）・
// kids は子を持てるか（0.13.1）・cite は出典のチップが付くか・since は版（now は前からある型）
const BLOCK_TYPES = Object.freeze([
  { id: 'text', key: 'paragraph', label: 'テキスト', words: ['てきすと', 'text', 'plain'], md: [], code: 'Digit0', kids: true, cite: false, since: 'now' },
  { id: 'h1', key: 'heading', level: 1, label: '見出し1', words: ['みだし1', '見出し1', 'h1', '#'], md: ['# '], code: 'Digit1', kids: false, cite: false, since: '0.13.0' },
  { id: 'h2', key: 'heading', level: 2, label: '見出し2', words: ['みだし2', 'h2', '##'], md: ['## '], code: 'Digit2', kids: false, cite: false, since: 'now' },
  { id: 'h3', key: 'heading', level: 3, label: '見出し3', words: ['みだし3', 'h3', '###'], md: ['### '], code: 'Digit3', kids: false, cite: false, since: '0.13.0' },
  { id: 'todo', key: 'todo', label: 'ToDo', words: ['とぅーどぅー', 'todo', 'やること', 'チェック'], md: ['[] '], code: 'Digit4', kids: true, cite: true, since: 'now' },
  { id: 'bullet', key: 'bullet', label: '箇条書き', words: ['かじょうがき', 'bullet', 'リスト'], md: ['- ', '* ', '+ '], code: 'Digit5', kids: true, cite: true, since: 'now' },
  { id: 'numbered', key: 'numbered', label: '番号付き', words: ['ばんごう', 'number', 'numbered'], md: ['1. '], code: 'Digit6', kids: true, cite: false, since: '0.13.0' },
  { id: 'toggle', key: 'toggle', label: 'トグル', words: ['とぐる', 'toggle'], md: ['> '], code: 'Digit7', kids: true, cite: false, since: '0.13.1' },
  { id: 'th', key: 'heading', toggle: true, label: 'トグル見出し1〜3', words: ['とぐるみだし', 'toggle heading'], md: [], kids: true, cite: false, since: '0.13.1' },
  { id: 'quote', key: 'quote', label: '引用', words: ['いんよう', 'quote'], md: ['" '], kids: true, cite: false, since: '0.13.0' },
  { id: 'divider', key: 'divider', label: '区切り線', words: ['くぎり', 'divider', '---'], md: ['---'], kids: false, cite: false, since: '0.13.0' },
  { id: 'callout', key: 'callout', label: 'コールアウト', words: ['こーるあうと', 'callout', 'メモ書き'], md: [], kids: true, cite: false, since: '0.13.0' },
].map((r) => Object.freeze({ ...r, words: Object.freeze([...r.words]), md: Object.freeze([...r.md]) })));
// この版で使える行（0.13.1 から型の表の全部。計画 docs/plans/2026-10-27-131.md の「受け渡す名前と形」）
const VERSION_ROWS = Object.freeze([...BLOCK_TYPES]);
// / メニューと ⠿ の［変換 ▸］の項目（0.13.1 NR5: 型の表の1行 th（段を持たない）から、トグル見出し1〜3 の3つの項目 th1〜th3 を作る。型の表は 12 行のまま）
const MENU_ROWS = Object.freeze(VERSION_ROWS.flatMap((r) => (r.id !== 'th' ? [r]
  : [1, 2, 3].map((level) => Object.freeze({ ...r, id: `th${level}`, level, label: `トグル見出し${level}` })))));
// / メニューの鍵（「最近使ったもの」に覚える鍵。0.13.1 で toggle・th1〜th3 を足した 14）
const MENU_KEYS = Object.freeze(MENU_ROWS.map((r) => r.id));
const TYPE_KEYS = Object.freeze([...new Set(VERSION_ROWS.map((r) => r.key))]);   // 画面の役の命令が通す型（DB の validate も同じ表）
const RECENT_MAX = 3;
const CALLOUT_ICON = '💡';   // EQ15 (a): コールアウトの絵文字は 💡 だけ

const rowById = (id) => MENU_ROWS.find((r) => r.id === id) || null;
const headingLevel = (b) => (b && (b.level === 1 || b.level === 2 || b.level === 3) ? b.level : 2);   // 段の無い古い見出しは段 2

// ブロック → 型の表の行（知らない型はテキストの見た目・段の無い見出しは段 2）
function typeOf(block) {
  const b = block && typeof block === 'object' ? block : {};
  if (b.type === 'heading') return rowById(`${b.toggle === true ? 'th' : 'h'}${headingLevel(b)}`);   // 0.13.1: トグル見出しは th1〜th3
  const r = VERSION_ROWS.find((x) => x.key === b.type && x.key !== 'heading');
  return r || rowById('text');
}
// テキストでない型か（知らない型はテキストの見た目なので偽）
function isTyped(block) {
  return typeOf(block).id !== 'text';
}

// ---------------------------------------------------------------- 書記素の境で分ける（F40）
function graphemeEnds(text) {
  const s = String(text);
  const out = [0];
  if (typeof Intl === 'object' && typeof Intl.Segmenter === 'function') {
    const seg = new Intl.Segmenter('ja', { granularity: 'grapheme' });
    for (const g of seg.segment(s)) out.push(g.index + g.segment.length);
  } else {
    for (let i = 0; i < s.length;) { const c = s.codePointAt(i); i += c > 0xffff ? 2 : 1; out.push(i); }
  }
  return out;
}
// 位置（UTF-16）を書記素の境に寄せる。途中なら次の境へ・負は 0・長さより大は長さ
function safeOffset(text, at) {
  const s = String(text ?? '');
  const n = Number.isFinite(at) ? Math.trunc(at) : 0;
  if (n <= 0) return 0;
  if (n >= s.length) return s.length;
  for (const e of graphemeEnds(s)) if (e >= n) return e;
  return s.length;
}
function splitText(text, at) {
  const s = String(text ?? '');
  const a = safeOffset(s, at);
  return [s.slice(0, a), s.slice(a)];
}
// rich（[{ t, m }]）を at で前と後に分ける（区切りの飾りを両方に残す）
function splitRich(rich, at) {
  const runs = Array.isArray(rich) ? rich : [];
  const a = [], b = [];
  let pos = 0;
  for (const run of runs) {
    const t = String(run && run.t != null ? run.t : '');
    const m = run && Array.isArray(run.m) ? run.m : undefined;
    const mk = (s) => (m ? { t: s, m: m.slice() } : { t: s });
    if (pos + t.length <= at) a.push(mk(t));
    else if (pos >= at) b.push(mk(t));
    else { a.push(mk(t.slice(0, at - pos))); b.push(mk(t.slice(at - pos))); }
    pos += t.length;
  }
  return [a.filter((r) => r.t !== ''), b.filter((r) => r.t !== '')];
}
// 2つの rich をつなぐ（つなぎ目の2つの飾りが同じなら1つの run にする）
function joinRich(a, b) {
  const out = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].map((r) => ({ ...r }));
  const same = (x, y) => JSON.stringify(x.m || []) === JSON.stringify(y.m || []);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && same(last, r)) last.t += r.t;
    else merged.push(r);
  }
  return merged;
}

// ---------------------------------------------------------------- 行頭の記法（E3・EQ9〜EQ13。F43）
// 全角の記号と全角の空白（EQ9 (a)）。「ー」（長音）と「・」は入れない
const ZEN = Object.freeze({ '－': '-', '＊': '*', '＋': '+', '［': '[', '］': ']', '１': '1', '．': '.', '＃': '#', '”': '"', '“': '"', '＂': '"', '＞': '>', '　': ' ' });
const halfOf = (s) => [...String(s)].map((c) => ZEN[c] || c).join('');
// before（カーソルの前の文）が行頭の記法ちょうどなら { type, level?, strip }。full（行の全部の文）は区切り線の「空の行」を見る
function shortcutFor(before, { full } = {}) {
  const raw = String(before ?? '');
  if (!raw || raw.length > 4) return null;
  const s = halfOf(raw);
  if (s === '---') return String(full ?? raw) === raw ? { type: 'divider', strip: raw.length } : null;   // EQ13: 空の行の3つ目の -
  for (const r of VERSION_ROWS) {
    if (r.md.includes(s) && s.endsWith(' ')) return r.key === 'heading' ? { type: 'heading', level: r.level, strip: raw.length } : { type: r.key, strip: raw.length };
  }
  return null;
}

// ---------------------------------------------------------------- / メニュー（E2・EQ7・EQ8。F52）
// before（カーソルの前の文）の最後の半角の / が行頭か空白の後なら開く。語は / の後ろ（空白を含めば閉じる）
function slashQuery(before) {
  const s = String(before ?? '');
  const i = s.lastIndexOf('/');
  if (i < 0) return { open: false, query: '' };
  if (i > 0 && !/\s/.test(s[i - 1])) return { open: false, query: '' };
  const query = s.slice(i + 1);
  if (/\s/.test(query)) return { open: false, query: '' };
  return { open: true, query };
}
const hits = (r, q) => {
  const f = q.toLowerCase();
  return [r.label, ...r.words].some((w) => w.toLowerCase().includes(f));
};
// 項目の並び → [{ id, group }]（group は 'recent'・'types'・''）。当たりが無いまま3文字打ったら null（閉じる）
function slashFilter(query, recent) {
  const q = String(query ?? '');
  const rec = recentCheck(recent);
  if (!q) return [...rec.map((id) => ({ id, group: 'recent' })), ...MENU_KEYS.map((id) => ({ id, group: 'types' }))];
  const found = MENU_ROWS.filter((r) => hits(r, q)).map((r) => r.id);
  if (!found.length) return q.length >= 3 ? null : [];
  return [...rec.filter((id) => found.includes(id)), ...found.filter((id) => !rec.includes(id))].map((id) => ({ id, group: '' }));
}
// 選んだ鍵を頭に足す（新しい順・同じ鍵は1つ・3つまで）→ 新しい配列
function recentAdd(recent, key) {
  const rec = recentCheck(recent);
  if (!MENU_KEYS.includes(key)) return rec;
  return [key, ...rec.filter((k) => k !== key)].slice(0, RECENT_MAX);
}
// 覚え書きの値を照らす → 鍵の表の文字だけ・重なり無し・3つまでの新しい配列（配列でなければ空）
function recentCheck(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const k of v) if (typeof k === 'string' && MENU_KEYS.includes(k) && !out.includes(k)) out.push(k);
  return out.slice(0, RECENT_MAX);
}

// ---------------------------------------------------------------- Enter と Backspace（EQ5 (a)・EQ6 (a)）
const LIST_KEYS = ['bullet', 'todo', 'numbered'];
// Enter で分けた後ろの行の型 → { type, level?, toggle? }。空のリストの Enter は 'revert'（テキストに戻す）。
// 0.13.1: 字下げされた空のリストは 'outdent'（EQ5 (a)。先に1段戻す）。トグルは open（見えている開け閉め）で決める（TQ3: 開いていれば
// 最初の子のテキスト、閉じていれば子の後ろの兄弟で同じ型。トグル見出しは同じ段のトグル見出し: 計画の Ruling NR25）
function nextTypeOnEnter(block, { empty = false, depth = 0, open = true } = {}) {
  const r = typeOf(block);
  if (LIST_KEYS.includes(r.key) && empty && depth > 0) return 'outdent';
  if (LIST_KEYS.includes(r.key)) return empty ? 'revert' : { type: r.key };
  if (r.toggle === true || r.key === 'toggle') {
    if (open) return { type: 'paragraph' };
    return r.key === 'toggle' ? { type: 'toggle' } : { type: 'heading', level: r.level, toggle: true };
  }
  if (r.key === 'heading') return { type: 'bullet' };
  return { type: 'paragraph' };
}
// 行頭の Backspace → 'revert'（型の付いた行はテキストに戻す）・'merge'（テキストの行は前とつなぐ）・'outdent'（0.13.1 の字下げ）
function backspaceAtStart(block, { depth = 0 } = {}) {
  if (depth > 0) return 'outdent';
  return isTyped(block) ? 'revert' : 'merge';
}

// ---------------------------------------------------------------- 番号（F50）
// 同じ親の続いた番号付きの行を数える → Map(id → '1.')。間に別の型が入れば 1 から
function numberLabels(blocks) {
  const out = new Map();
  let n = 0;
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b && b.type === 'numbered') { n += 1; out.set(b.id, `${n}.`); } else n = 0;
  }
  return out;
}

// ---------------------------------------------------------------- 近道（E11・EQ12。F45）
const DIGIT_TURN = Object.freeze(Object.fromEntries(VERSION_ROWS.filter((r) => r.code).map((r) => [r.code, r.id])));
// キーの事象 → 近道の名前（'turn:<鍵>'・'duplicate'・'moveUp'・'moveDown'・'ctrlEnter'・'menu'）か null。数字は ev.code で見る（JIS の Shift+数字）。
// 変換中は null。今の近道（Ctrl+P・Ctrl+Shift+P・Ctrl+Shift+L）と 0.14.0 に入る近道（Ctrl+W・Ctrl+Shift+N・Ctrl+Alt+V）は取らない
function keyAction(ev) {
  if (!ev || ev.isComposing || ev.keyCode === 229) return null;
  if (!ev.ctrlKey || ev.metaKey) return null;
  const code = String(ev.code || '');
  // 0.13.1 NR21: Alt つきは Ctrl+Alt+T（ページのトグルをまとめて開け閉め: EQ19 (a)）だけ。Ctrl+Alt+V（0.14.0 で何もしない）などは取らない
  if (ev.altKey) return !ev.shiftKey && code === 'KeyT' ? 'openAll' : null;
  if (ev.shiftKey) {
    if (Object.hasOwn(DIGIT_TURN, code)) return `turn:${DIGIT_TURN[code]}`;
    if (code === 'ArrowUp' || ev.key === 'ArrowUp') return 'moveUp';
    if (code === 'ArrowDown' || ev.key === 'ArrowDown') return 'moveDown';
    return null;
  }
  if (code === 'KeyD') return 'duplicate';
  if (code === 'Enter' || code === 'NumpadEnter' || ev.key === 'Enter') return 'ctrlEnter';
  if (code === 'Slash' || ev.key === '/') return 'menu';
  return null;
}

// ---------------------------------------------------------------- ［コピー］の Markdown（決めたこと 22）
// 今の4つの型（段の無い見出し・ToDo・箇条書き・テキスト）は 0.11.0 の［コピー］と1文字も同じ（見出しは前に空の行）。
// 0.13.1（決めたこと 22・NR20）: 子は段ごとに2つの空白で下げる（閉じたトグルの子も写す）。トグルは箇条書きと同じ「- 」、トグル見出しは見出しの段の #。番号は親ごと
function blocksMarkdown(blocks, depth = 0) {
  const list = Array.isArray(blocks) ? blocks.filter((b) => b && typeof b === 'object') : [];
  const nums = numberLabels(list);
  const pad = '  '.repeat(depth);
  const indent = (t) => String(t ?? '').replace(/\n/g, `\n${pad}  `);
  const line = (b) => {
    const t = indent(b.text);
    if (b.type === 'heading') return `\n${'#'.repeat(headingLevel(b))} ${t}`;
    if (b.type === 'todo') return `- [${b.checked ? 'x' : ' '}] ${t}`;
    if (b.type === 'bullet') return `- ${t}`;
    if (b.type === 'numbered') return `${nums.get(b.id) || '1.'} ${t}`;
    if (b.type === 'quote') return `> ${t}`;
    if (b.type === 'divider') return '---';
    if (b.type === 'callout') return `> ${CALLOUT_ICON} ${t}`;
    if (b.type === 'toggle') return `- ${t}`;
    return t;
  };
  return list.map((b) => {
    const own = pad ? line(b).replace(/^(\n?)/, `$1${pad}`) : line(b);
    const kids = Array.isArray(b.children) && b.children.length ? blocksMarkdown(b.children, depth + 1) : '';
    return kids ? `${own}\n${kids}` : own;
  }).join('\n');
}

// ---------------------------------------------------------------- 行だけの描き直し（E4。F47）
// 前の行の並びと新しい並び → 当てる操作の並び（{ op: 'remove', id }・{ op: 'add', id, at }・{ op: 'move', id, at }・{ op: 'update', id }）。同じなら []
function patchPlan(oldBlocks, newBlocks) {
  const olds = (Array.isArray(oldBlocks) ? oldBlocks : []).filter((b) => b && typeof b.id === 'string');
  const news = (Array.isArray(newBlocks) ? newBlocks : []).filter((b) => b && typeof b.id === 'string');
  const oldById = new Map(olds.map((b) => [b.id, b]));
  const newIds = new Set(news.map((b) => b.id));
  const ops = [];
  for (const b of olds) if (!newIds.has(b.id)) ops.push({ op: 'remove', id: b.id });
  // 残る行のうち、並びを保つ最も長い組（LIS）に入らない行だけを動かす
  const kept = news.filter((b) => oldById.has(b.id));
  const oldIdx = new Map(olds.map((b, i) => [b.id, i]));
  const seq = kept.map((b) => oldIdx.get(b.id));
  const stay = new Set(lisIndexes(seq).map((i) => kept[i].id));
  news.forEach((b, at) => {
    if (!oldById.has(b.id)) { ops.push({ op: 'add', id: b.id, at }); return; }
    if (!stay.has(b.id)) ops.push({ op: 'move', id: b.id, at });
    if (JSON.stringify(oldById.get(b.id)) !== JSON.stringify(b)) ops.push({ op: 'update', id: b.id });
  });
  return ops;
}
// 増えていく最も長い部分列の添字（seq の中の位置）
function lisIndexes(seq) {
  const tails = [], prev = new Array(seq.length).fill(-1), tailIdx = [];
  seq.forEach((v, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
    tails[lo] = v; tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  });
  const out = [];
  for (let i = tailIdx[tails.length - 1]; i !== undefined && i >= 0; i = prev[i]) out.unshift(i);
  return out;
}

module.exports = {
  BLOCK_TYPES, VERSION_ROWS, MENU_ROWS, MENU_KEYS, TYPE_KEYS, RECENT_MAX, CALLOUT_ICON,
  typeOf, isTyped, headingLevel, safeOffset, splitText, splitRich, joinRich,
  shortcutFor, slashQuery, slashFilter, recentAdd, recentCheck,
  nextTypeOnEnter, backspaceAtStart, numberLabels, keyAction, blocksMarkdown, patchPlan,
};
