'use strict';
// 箇所の検索の純粋な部品（0.10.0 Task T-2a。D51。計画 docs/plans/2026-10-20-100.md の決めたこと 71・72・75・113・115）。DB を読まない（引数だけ）。
//  - 箇所の切り方: 文字起こしは failed でない発言を時刻の順に窓にする（400 字か 75 秒で閉じ、600 字を越えるときも閉じる。前の窓が
//    2つ以上の発言を持てば、その最後の発言から次の窓を始める: 境目の語を落とさない）。要約は見出しの節（600 字を越えればブロックの
//    切れ目で分ける）。メモは空の行で段落にし、長い段落は行で分け、短い段落は続けて 400 字まで1つにする。
//  - 点: 箇所ごとの BM25 の形（idf は見える会議だけの数で呼び手が決める: 決めたこと 71・73）。題名に当たった語はその会議の箇所に tf 1 を足す。
//  - 印: {会議}#t:s12-s18・#b:{ブロック}・#m:{段落}。文字起こしの印の2つの ID は番号の大小を見ない（決めたこと 113）。
const { searchFold } = require('../cite');
const { foldWithMap } = require('../pagerules');
const search = require('../db/search');
const F = require('./format');

const PASSAGE_MAX = 600;
const WINDOW_CHARS = 400;
const WINDOW_MS = 75000;
const MEMO_MERGE = 150;
const MAX_TERMS = 8;
const K1 = 1.2;
const B = 0.75;
const AVG_LEN = 400;
const MARK_MAX = 20;
const ANCHOR_RE = /^([A-Za-z0-9_-]{1,64})#(t:s\d{1,6}-s\d{1,6}|b:[A-Za-z0-9_-]{1,64}|m:\d{1,4})$/;

// 語に分ける（畳む前に空白・「、」・「,」・「，」で分け、畳んで空の語と重なる語を捨てる。8 語まで）→ [{ raw, term }]
function termsOf(query) {
  const out = [];
  const seen = new Set();
  for (const raw of String(query || '').split(/[\s\u3000、,，]+/)) {
    const term = searchFold(raw).replace(/[\u0000-\u001f\u007f]/g, '');
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push({ raw, term });
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}
const splitTerms = (query) => termsOf(query).map((t) => t.term);
// 画面の検索と同じ決まり（3 文字以上は FTS5 の引用の形・1〜2 文字は LIKE）
const termPlan = (term) => search.plan(term);

// 発言を時刻の順に（同じ時刻は並びの順。atMs の無い発言は前の発言の後: 決めたこと 113）
function sortSegs(segments) {
  let prev = -Infinity;
  const keyed = (segments || []).map((s, i) => {
    const at = Number.isFinite(s && s.atMs) ? s.atMs : prev;
    prev = at;
    return { s, at, i };
  });
  keyed.sort((a, b) => (a.at - b.at) || (a.i - b.i));
  return keyed.map((k) => k.s);
}

const lenOf = (segs) => segs.reduce((n, s) => n + s.text.length, 0);
const spanOf = (segs) => {
  const a = segs[0], z = segs[segs.length - 1];
  if (!Number.isFinite(a.atMs) || !Number.isFinite(z.atMs)) return 0;
  return z.atMs + (Number.isFinite(z.durationMs) ? z.durationMs : 0) - a.atMs;
};
function windowOf(segs) {
  const a = segs[0], z = segs[segs.length - 1];
  return {
    kind: 't', from: a.id, to: z.id,
    atMs: Number.isFinite(a.atMs) ? a.atMs : null,
    endMs: Number.isFinite(z.atMs) ? z.atMs + (Number.isFinite(z.durationMs) ? z.durationMs : 0) : null,
    segs: segs.slice(), text: segs.map((s) => s.text).join('\n'),
  };
}

function chunkSegments(segments) {
  const segs = sortSegs((segments || []).filter((s) => s && !s.failed && typeof s.text === 'string' && s.text));
  const out = [];
  let cur = [];
  let fresh = false;   // cur に、まだどの窓にも入っていない発言がある
  const close = () => {
    out.push(windowOf(cur));
    cur = cur.length >= 2 ? [cur[cur.length - 1]] : [];   // 1つ重ねる
    fresh = false;
  };
  for (const s of segs) {
    if (cur.length && lenOf(cur) + s.text.length > PASSAGE_MAX) {
      if (fresh) close();
      if (cur.length && lenOf(cur) + s.text.length > PASSAGE_MAX) cur = [];   // 重ねた発言と合わせても入らない
    }
    cur.push(s);
    fresh = true;
    if (lenOf(cur) >= WINDOW_CHARS || spanOf(cur) >= WINDOW_MS) close();
  }
  if (cur.length && fresh) out.push(windowOf(cur));
  return out;
}

// 要約の節（見出しから次の見出しまで。見出しの前のブロックは「（見出しなし）」）→ [{ kind: 'b', blockId, heading, blocks, lines, text }]
function chunkSummary(blocks) {
  const sections = [];
  let sec = null;
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'heading') { sec = { head: b, heading: F.safeLine(b.text) || '（見出しなし）', items: [] }; sections.push(sec); continue; }
    if (!sec) { sec = { head: null, heading: '（見出しなし）', items: [] }; sections.push(sec); }
    const line = F.blockLine(b);
    if (line) sec.items.push({ b, line, raw: F.safeLine(b.text) });
  }
  const out = [];
  for (const s of sections) {
    let part = null;
    const flush = () => { if (part && (part.lines.length || part.head)) out.push(part); part = null; };
    const start = (first) => ({ kind: 'b', blockId: first.id, heading: s.heading, head: Boolean(s.head && first === s.head), blocks: [], lines: [], text: '' });
    part = start(s.head || (s.items[0] && s.items[0].b) || { id: '' });
    if (!s.head && !s.items.length) continue;
    part.text = s.heading;
    for (const { b, line, raw } of s.items) {
      if (part.lines.length && part.text.length + 1 + line.length > PASSAGE_MAX) {
        flush();
        part = start(b);
        part.text = s.heading;
      }
      part.blocks.push(b);
      part.lines.push(line);
      part.text += `\n${raw}`;
    }
    flush();
  }
  return out.map(({ head, ...rest }) => rest);
}

// メモの段落 → [{ kind: 'm', n, lines, text }]
function chunkMemo(memo) {
  const paras = String(memo || '').split(/\r?\n[ \t\u3000]*\r?\n/).map((p) => p.split(/\r?\n/).filter((l) => l.trim())).filter((ls) => ls.length);
  // 長い段落は行の切れ目で分ける
  const pieces = [];
  for (const ls of paras) {
    let cur = [];
    for (const l of ls) {
      if (cur.length && cur.join('\n').length + 1 + l.length > PASSAGE_MAX) { pieces.push(cur); cur = []; }
      cur.push(l);
    }
    if (cur.length) pieces.push(cur);
  }
  // 短い段落は続けて 400 字まで1つにする
  const merged = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    const text = p.join('\n');
    if (last && last.text.length < MEMO_MERGE && last.text.length + 2 + text.length <= WINDOW_CHARS) {
      last.lines.push('', ...p);
      last.text += `\n\n${text}`;
    } else merged.push({ lines: p.slice(), text });
  }
  return merged.map((m, i) => ({ kind: 'm', n: i + 1, lines: m.lines, text: m.text }));
}

const idfOf = (N, df) => Math.log(1 + (N - df + 0.5) / (df + 0.5));

// 畳んだ文の中の語の数（重ならない数え方）
function countIn(folded, term) {
  if (!term) return 0;
  let n = 0;
  for (let i = folded.indexOf(term); i >= 0; i = folded.indexOf(term, i + term.length)) n++;
  return n;
}

// 点を足した写し（当たりの無い箇所は落とす）。passages の1つは { pageId, pos, text, date, createdAt, … }
function scorePassages(passages, terms, { idf = {}, titleHits = new Map() } = {}) {
  const out = [];
  for (const p of passages) {
    const folded = searchFold(p.text);
    const len = folded.length;
    const titled = titleHits.get(p.pageId);
    let score = 0;
    const hits = {};
    for (const t of terms) {
      const c = countIn(folded, t);
      if (c) hits[t] = c;
      const tf = c + (titled && titled.has(t) ? 1 : 0);
      if (!tf) continue;
      const w = Number.isFinite(idf[t]) ? idf[t] : 1;
      score += w * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (len / AVG_LEN)));
    }
    if (score > 0 && Object.keys(hits).length) out.push({ ...p, score, hits });
  }
  return out.sort(byRank);
}

// 並び: 点の大きい順、同じ点なら日付の新しい順・createdAt の新しい順・会議の ID・会議の中の位置
function byRank(a, b) {
  return (b.score - a.score)
    || String(b.date || '').localeCompare(String(a.date || ''))
    || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    || (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0)
    || ((a.pos || 0) - (b.pos || 0));
}

// 並べてから会議ごとの上限・offset・limit → { items, next, total }
function pick(list, { limit, offset = 0, perMeeting }) {
  const sorted = list.slice().sort(byRank);
  const per = new Map();
  const kept = [];
  for (const p of sorted) {
    const n = per.get(p.pageId) || 0;
    if (n >= perMeeting) continue;
    per.set(p.pageId, n + 1);
    kept.push(p);
  }
  const items = kept.slice(offset, offset + limit);
  const next = offset + limit < kept.length ? offset + limit : null;
  return { items, next, total: kept.length };
}

function anchorOf(pageId, p) {
  if (p.kind === 't') return `${pageId}#t:${p.from}-${p.to}`;
  if (p.kind === 'b') return `${pageId}#b:${p.blockId}`;
  return `${pageId}#m:${p.n}`;
}

function parseAnchor(s) {
  if (typeof s !== 'string') return null;
  const m = ANCHOR_RE.exec(s);
  if (!m) return null;
  const [kind, rest] = [m[2][0], m[2].slice(2)];
  if (kind === 't') {
    const [from, to] = rest.split('-');
    return { pageId: m[1], kind, from, to };
  }
  if (kind === 'b') return { pageId: m[1], kind, blockId: rest };
  return { pageId: m[1], kind, n: Number(rest) };
}

// 最初に当たった語の前後で max 文字に切った文（切った側に「…」）
function cutAround(text, term, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const { folded, from, to } = foldWithMap(s);
  const at = term ? folded.indexOf(term) : -1;
  const hs = at >= 0 ? from[at] : 0;
  const he = at >= 0 ? to[at + term.length - 1] : 0;
  let start = Math.max(0, Math.min(hs - Math.floor((max - (he - hs)) / 2), s.length - max));
  if (start > 0 && s.codePointAt(start - 1) > 0xffff && start - 1 >= 0 && /[\udc00-\udfff]/.test(s[start])) start -= 1;
  let end = Math.min(s.length, start + max);
  if (end < s.length && /[\ud800-\udbff]/.test(s[end - 1])) end -= 1;
  return `${start > 0 ? '…' : ''}${s.slice(start, end)}${end < s.length ? '…' : ''}`;
}

// 当たった所を ⟦ ⟧ で囲む（畳んだ形で当て、元の文字の範囲を囲む。重なる語は長い方。MARK_MAX か所まで）。text は safeLine を通した後の文
function markHits(text, terms) {
  const s = String(text || '');
  const { folded, from, to } = foldWithMap(s);
  const spans = [];
  for (const t of [...terms].sort((a, b) => b.length - a.length)) {
    if (!t) continue;
    for (let i = folded.indexOf(t); i >= 0; i = folded.indexOf(t, i + t.length)) {
      const a = from[i], z = to[i + t.length - 1];
      if (spans.some((x) => a < x.z && z > x.a)) continue;
      spans.push({ a, z });
    }
  }
  spans.sort((x, y) => x.a - y.a);
  let out = '';
  let last = 0;
  for (const { a, z } of spans.slice(0, MARK_MAX)) {
    out += `${s.slice(last, a)}⟦${s.slice(a, z)}⟧`;
    last = z;
  }
  return out + s.slice(last);
}

module.exports = {
  PASSAGE_MAX, WINDOW_CHARS, WINDOW_MS, MEMO_MERGE, MAX_TERMS, K1, B, AVG_LEN, MARK_MAX, ANCHOR_RE,
  termsOf, splitTerms, termPlan, sortSegs, chunkSegments, chunkSummary, chunkMemo, idfOf, countIn, scorePassages, byRank, pick,
  anchorOf, parseAnchor, cutAround, markHits,
};
