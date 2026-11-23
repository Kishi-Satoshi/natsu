/*
 * nameFix.js — 名前の直し（0.18.0 CS-3。計画 docs/plans/2026-11-18-180.md の決めたこと 23〜26・F237。第14回 F2 の MCP の形）
 *
 * 純粋な関数（読み書きしない）。DB の命令 mcp.fixNames（src/db/commands.js）が、1つのページの要約の行（白紙のページと行のページは本文の行）・
 * メモの行・文字起こしの発言・ToDo の担当・「議事録」の「参加者」の列の名前を、1回で直すのに使う。
 *
 * checkPairs(pairs) → [{ from, to }]（照らした写し）。だめなら code 'bad-args' の誤りを投げる。
 *   組は 1〜10 個。from は 2〜50 字（1字の語で全部の文を置き換えない）・to は 1〜50 字（消す道具にしない）。字の数はコードポイントで数える。
 *   空白だけ・改行・制御の文字・向きの制御の文字・from === to・知らない欄は断る。
 * fixNames(page, segments, pairs, { tasks = [], people = [] })
 *   → { page, segments, segIds, counts: { summary, memo, transcript, assignee, people, title, crossed, tasks }, changedBlocks: Set }
 *   ちょうど同じ字だけを置き換える（正規表現にしない・ひらがなとカタカナを寄せない）。組の順に、文の頭から1回ずつ（前の組が書いた字をあとの組が
 *   また置き換えない）。飾りのある行（rich）は飾りの区切りの中だけを置き換え、区切りをまたぐ語は置き換えずに crossed に数える（重なったまたぎは1か所。
 *   またいだ語の次の字から探し直すので、重なった区切りの中の語は置き換える: 点検 2・CR93）。
 *   題名（title）は置き換えずに数だけ。tasks（その ToDo から作ったタスクの担当の名前の並び）も数えるだけ。people は「参加者」の列の ID の並び
 *   （page.cells の人の列。重なった名前は1つにまとめる）。認識に失敗した発言（failed）は直さない。文を変えた発言は文の頭（parts）を外す
 *   （segment.update の直しと同じ）。受けた物は書き換えず、写しを返す。changedBlocks は文か担当を変えた要約の行の ID（出典を照らし直す行）。
 */
'use strict';

const MD = require('./memoDoc');

const MAX_PAIRS = 10;
const FROM_MIN = 2;
const WORD_MAX = 50;
// 改行・制御の文字・行と段落の区切り・向きの制御の文字
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const cpLen = (s) => [...s].length;

function bad(why) { const e = new Error(why); e.code = 'bad-args'; return e; }

function checkPairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > MAX_PAIRS) throw bad('pairs');
  return pairs.map((p) => {
    if (!isObj(p) || Object.keys(p).some((k) => k !== 'from' && k !== 'to')) throw bad('pair');
    const { from, to } = p;
    if (typeof from !== 'string' || typeof to !== 'string') throw bad('pair');
    if (cpLen(from) < FROM_MIN || cpLen(from) > WORD_MAX || cpLen(to) < 1 || cpLen(to) > WORD_MAX) throw bad('pair length');
    if (!from.trim() || !to.trim() || CTRL_RE.test(from) || CTRL_RE.test(to) || from === to) throw bad('pair');
    return { from, to };
  });
}

// 文の中の当たり（頭から。同じ所では組の順の最初の組）→ [{ at, len, to }]
function hitsOf(text, pairs) {
  const out = [];
  const s = String(text);
  let i = 0;
  while (i < s.length) {
    const p = pairs.find((x) => s.startsWith(x.from, i));
    if (p) { out.push({ at: i, len: p.from.length, to: p.to }); i += p.from.length; continue; }
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? 2 : 1;
  }
  return out;
}
function applyHits(text, hits, base = 0) {
  let out = '';
  let at = 0;
  for (const h of hits) { out += text.slice(at, h.at - base) + h.to; at = h.at - base + h.len; }
  return out + text.slice(at);
}
function replaceText(text, pairs) {
  const hits = hitsOf(text, pairs);
  return { text: hits.length ? applyHits(text, hits) : text, n: hits.length };
}

// 飾りのある行: 区切りの中の当たりだけを置き換え、区切りをまたぐ当たりは数える → { rich, text, n, crossed }
function replaceRich(rich, pairs) {
  const runs = rich.map((r) => (isObj(r) && typeof r.t === 'string' ? r.t : ''));
  const full = runs.join('');
  const starts = [];
  let pos = 0;
  for (const t of runs) { starts.push(pos); pos += t.length; }
  const inside = runs.map(() => []);
  let crossed = 0;
  // 点検 2（CR93）: 区切りをまたぐ当たりは字を使わず、次の字から探し直す（重なった区切りの中の当たりも見つける）。重なったまたぎは1か所に数える
  let crossEnd = 0;
  let i = 0;
  while (i < full.length) {
    const p = pairs.find((x) => full.startsWith(x.from, i));
    if (p) {
      let k = starts.length - 1;
      while (k > 0 && starts[k] > i) k -= 1;
      if (i + p.from.length <= starts[k] + runs[k].length) { inside[k].push({ at: i, len: p.from.length, to: p.to }); i += p.from.length; continue; }
      if (i >= crossEnd) crossed += 1;
      crossEnd = Math.max(crossEnd, i + p.from.length);
    }
    const c = full.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < full.length ? 2 : 1;
  }
  const n = inside.reduce((x, l) => x + l.length, 0);
  if (!n) return { rich, text: full, n: 0, crossed };
  const out = rich.map((r, k) => (inside[k].length ? { ...r, t: applyHits(runs[k], inside[k], starts[k]) } : r));
  return { rich: out, text: out.map((r) => r.t).join(''), n, crossed };
}

// 行の並び（子も）の文と ToDo の担当を直す。key は counts の欄の名前（summary・memo）
function fixRows(list, pairs, counts, key, changed) {
  for (const b of Array.isArray(list) ? list : []) {
    if (!isObj(b)) continue;
    let touched = false;
    if (Array.isArray(b.rich)) {
      const r = replaceRich(b.rich, pairs);
      counts.crossed += r.crossed;
      if (r.n) { b.rich = r.rich; b.text = r.text; counts[key] += r.n; touched = true; }
    } else if (typeof b.text === 'string') {
      const r = replaceText(b.text, pairs);
      if (r.n) { b.text = r.text; counts[key] += r.n; touched = true; }
    }
    if (b.type === 'todo' && typeof b.assignee === 'string' && b.assignee) {
      const r = replaceText(b.assignee, pairs);
      if (r.n) { b.assignee = r.text; counts.assignee += r.n; touched = true; }
    }
    if (touched && changed) changed.add(b.id);
    fixRows(b.children, pairs, counts, key, changed);
  }
}

function fixNames(page, segments, pairs, { tasks = [], people = [] } = {}) {
  const ps = checkPairs(pairs);
  const p = structuredClone(isObj(page) ? page : {});
  const counts = { summary: 0, memo: 0, transcript: 0, assignee: 0, people: 0, title: 0, crossed: 0, tasks: 0 };
  const changedBlocks = new Set();
  fixRows(p.blocks, ps, counts, 'summary', changedBlocks);
  if (Array.isArray(p.memoDoc)) {
    const was = counts.memo + counts.assignee;
    fixRows(p.memoDoc, ps, counts, 'memo', null);
    if (counts.memo + counts.assignee !== was) p.memo = MD.memoPlain(p.memoDoc);   // 素の文字のメモはメモの行から作り直す（食い違わせない）
  } else if (typeof p.memo === 'string') {
    const r = replaceText(p.memo, ps);
    if (r.n) { p.memo = r.text; counts.memo += r.n; }
  }
  if (isObj(p.cells)) {
    for (const col of Array.isArray(people) ? people : []) {
      const v = p.cells[col];
      if (!Array.isArray(v)) continue;
      let n = 0;
      const names = v.map((x) => { if (typeof x !== 'string') return x; const r = replaceText(x, ps); n += r.n; return r.text; });
      if (n) { p.cells[col] = [...new Set(names)]; counts.people += n; }
    }
  }
  counts.title = typeof p.title === 'string' ? hitsOf(p.title, ps).length : 0;
  for (const t of Array.isArray(tasks) ? tasks : []) if (typeof t === 'string') counts.tasks += hitsOf(t, ps).length;
  const segIds = [];
  const segs = (Array.isArray(segments) ? segments : []).map((s) => {
    if (!isObj(s) || s.failed === true || typeof s.text !== 'string') return s;
    const r = replaceText(s.text, ps);
    if (!r.n) return s;
    counts.transcript += r.n;
    segIds.push(s.id);
    const out = { ...s, text: r.text };
    delete out.parts;   // 文を直した発言は1行（文の頭は古い文の位置: segment.update と同じ）
    return out;
  });
  return { page: p, segments: segs, segIds, counts, changedBlocks };
}

module.exports = { MAX_PAIRS, checkPairs, fixNames };
