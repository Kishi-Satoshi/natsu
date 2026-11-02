'use strict';
// 口述の整えの純粋な部品（0.14.0 DQ-1。計画 docs/plans/2026-10-26-140.md の決めたこと 45〜51・R45・R46）
//   dropFillers  … つなぎ言葉を除く決まり（0.13.x までの main.js の決まりを同じ字のまま移した。会議の区間の文もこれを通るので、答えは1文字も変えない）
//   tidyRules    … 決まりの整え（PC の中・すぐ）。つなぎ言葉は設定「フィラー除去」がオンのときだけ、同じ語のすぐの繰り返しはいつも1つに
//   tidyGuard    … AI の整えの答えの照らし（形・長さ・元の文に無い文字が多い答え・中身を落とした短すぎる答えを外す）
//   linesToText  … 箇条の行を「・ 」「1. 」で始まる行の文にする（NaTsu の外のアプリへ貼る文）
//   tidyBody     … 中継の整えの口へ送る本文（文・言語・辞書の語）。文が空か 300 字（TIDY_MAX_CHARS）を越えれば null（送らない。文は切らない: BQ35）
// 字数はどれも符号位置（Array.from の数。𠮷 は1字）で数える（R195）
// どれも通信もファイルも触らない。

// ---------------------------------------------------------------- つなぎ言葉（決めたこと 45。ただの「あの」「その」は除かない）
function dropFillers(text) {
  let t = text;
  const patterns = [
    /(?:えー+っ?と+|えっ?と+|ええと+|ええっと+)[、,。.\s]*/g,
    /(?:えー+|えぇ+ー*)[、,\s]*/g,
    /(?:あのー+|あのう+|そのー+|そのう+)[、,\s]*/g,
    /(?:うー+ん(?:と+)?|んー+と?)[、,\s]*/g,
    /\b(?:u+m+|u+h+|erm+|hm+)\b[,\s]*/gi,
  ];
  for (const p of patterns) t = t.replace(p, '');
  return t.replace(/、{2,}/g, '、').replace(/。{2,}/g, '。')
    .replace(/(^|。)、+/g, '$1').replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- 決まりの整え（決めたこと 46・R45）
// 同じ語（2字以上）が「、」か空白（改行は除く）で区切られてすぐ続くときだけ1つにする。語の頭と終わりは文の頭・終わりか区切りの字。
// 区切りの無い「確認確認」は語の区切りが分からないので触らない。数だけの語（「12、12、13」）は並びの見込みがあるので触らない
const REPEAT_RE = /(^|[、,，。．.!?！？\s])([^、,，。．.!?！？\s]{2,})((?:(?:[、,，][ \t\u3000]*|[ \t\u3000]+)\2)+)(?=$|[、,，。．.!?！？\s])/gu;
// 文の終わりの言い方の重なり（「そうですです」）は語の区切りが分かるので、区切りが無くても1つにする（「ますます」は語なので入れない）
const TAIL_REPEAT_RE = /(です|でした|ました)\1+/g;
function tidyRules(text, { fillers } = {}) {
  if (typeof text !== 'string') return '';
  let t = fillers ? dropFillers(text) : text;
  t = t.replace(REPEAT_RE, (all, head, word) => (/^[0-9０-９.,．，]+$/.test(word) ? all : head + word));
  return t.replace(TAIL_REPEAT_RE, '$1');
}

// ---------------------------------------------------------------- AI の答えの照らし（決めたこと 48・R46）
const LINE_KINDS = new Set(['bullet', 'number', 'p']);
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
// 答えは JSON から読んだ物なので、自分の持ち物の欄だけを読む（どの物にも生えている名前を拾わない）
const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const chars = (s) => Array.from(s);
// 比べる文: 空白・句読点・記号を除き、英字は小文字に
const bare = (s) => chars(s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''));
// 答えの文の2字の組のうち、元の文にもある組の割合（2字に満たなければ、字が元の文にあるか）
function overlap(raw, out) {
  const a = bare(raw);
  const b = bare(out);
  if (b.length === 0) return 0;
  if (b.length === 1) return a.includes(b[0]) ? 1 : 0;
  const have = new Set();
  for (let i = 0; i + 1 < a.length; i++) have.add(a[i] + a[i + 1]);
  let hit = 0;
  for (let i = 0; i + 1 < b.length; i++) if (have.has(b[i] + b[i + 1])) hit++;
  return hit / (b.length - 1);
}
const noSpace = (s) => s.replace(/\s+/g, '');
const SHORT_MIN = 0.5;
function tidyGuard(raw, reply) {
  if (typeof raw !== 'string' || !raw.trim() || !isPlain(reply)) return null;
  const text = own(reply, 'text');
  const lines = own(reply, 'lines');
  if (typeof text !== 'string' || !text.trim() || !Array.isArray(lines)) return null;
  const out = [];
  for (const l of lines) {
    if (!isPlain(l)) return null;
    const kind = own(l, 'kind');
    const t = own(l, 't');
    if (!LINE_KINDS.has(kind) || typeof t !== 'string' || !t.trim()) return null;
    out.push({ kind, t });
  }
  // 箇条の行の文は text と同じ文（印の無い形か、linesToText の形）。空白は見ない
  if (out.length && noSpace(text) !== noSpace(out.map((l) => l.t).join('')) && noSpace(text) !== noSpace(linesToText(out))) return null;
  // 長すぎる・元の文に無い文字が多い（答え・訳・作り話の見込み）
  if (chars(text).length > chars(raw).length * 1.3 + 20 || overlap(raw, text) < 0.6) return null;
  // 短すぎる（中身を落とした・まとめた答えの見込み）: 決まりの整え（つなぎ言葉・繰り返しを除いた）文の半分に満たなければ外す（R195）
  if (bare(text).length < bare(tidyRules(raw, { fillers: true })).length * SHORT_MIN) return null;
  return { text, lines: out };
}

// ---------------------------------------------------------------- 箇条の文（決めたこと 50）
// bullet は「・ 」、number は続く番号の行ごとに「1. 」から数える（ほかの行をはさむと 1 から）、p はそのまま。改行でつなぐ
function linesToText(lines) {
  if (!Array.isArray(lines)) return '';
  const rows = [];
  let n = 0;
  for (const l of lines) {
    if (!isPlain(l) || typeof l.t !== 'string') continue;
    if (l.kind === 'number') { n += 1; rows.push(`${n}. ${l.t}`); continue; }
    n = 0;
    rows.push(l.kind === 'bullet' ? `・ ${l.t}` : l.t);
  }
  return rows.join('\n');
}

// ---------------------------------------------------------------- 中継へ送る本文（決めたこと 51・53）
// 2026-11-02 の BQ35: 整えの前の文がこれを越える口述は整えの口へ送らない（はじめから決まりの整えの文をすぐ入れる。文は切らない）
const TIDY_MAX_CHARS = 300;
const WORDS_MAX = 50;
const WORD_MAX = 40;
// 辞書の語を max 字（符号位置）までに切る（𠮷 は割らない）
const cut = (s, max) => chars(s).slice(0, max).join('');
function tidyBody(raw, { lang, words } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (chars(raw).length > TIDY_MAX_CHARS) return null;   // 長い口述は送らない（BQ35。切って送ると後ろが消える）
  const body = { text: raw };
  // 言語は settings.language。auto（決めない）と形の違う値は送らない（中継が決める）
  if (typeof lang === 'string' && lang !== 'auto' && /^[a-z]{2,3}$/.test(lang)) body.lang = lang;
  const list = [];
  for (const w of Array.isArray(words) ? words : []) {
    if (list.length >= WORDS_MAX) break;
    if (typeof w !== 'string') continue;
    const v = cut(w.trim(), WORD_MAX);
    if (v && !list.includes(v)) list.push(v);
  }
  body.words = list;
  return body;
}

module.exports = { dropFillers, tidyRules, tidyGuard, linesToText, tidyBody, TIDY_MAX_CHARS, WORDS_MAX, WORD_MAX };
