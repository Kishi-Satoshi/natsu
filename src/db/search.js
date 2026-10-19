/*
 * search.js — 議事録の DB の検索（第2a1回 ST8・RF12。純粋。node:sqlite の接続は引数）
 *
 * 問いは cite.searchFold で畳み（今の検索と同じ）、制御文字を除く（ページの行の fold の区切り char(1) に当てない）。
 *   plan(q) → null（畳んで空: 一覧は全部・全文検索は 0 件）
 *           | { kind: 'match', query }（符号点で3文字以上: FTS5 の trigram。引用の形にして、" は重ねる。文法の語も文字として扱う）
 *           | { kind: 'like', pattern }（1〜2文字: fold LIKE ? ESCAPE '\'。\・%・_ を逃がす）
 *   問い合わせの文は下の SQL の決まった文だけ（問いや命令の名前で文を組み立てない）。
 *
 * searchList(db, q, { ids, entryOf }) … 一覧の検索（pages.list の q。問いが無い・畳んで空なら一覧の全部）。今の store.searchIndex と同じ順で分ける:
 *   題名（一覧の行の題名。無題は「(無題の議事録)」）→ ブロック（当たったうち並びの一番前のブロックの元の文から抜き出し）→
 *   メモ（ページの行の fold が当たり、題名に無ければメモ。メモの元の文から抜き出し）。並びは ids（一覧の並び = createdAt の新しい順）
 * searchFull(db, q, limit, { ids, entryOf }) … 全文検索（文字起こしだけ）。今の store.searchFullText と同じ { hits, total, truncated }
 *   ids … 一覧に出すページの ID の並び（ゴミ箱と録音中の写しを除いたもの。commands.listedIds）
 *   entryOf(id) … 一覧の1行（R.listEntry）
 *
 * 今の検索との意図した違い（計画 D-4。比べのテストから外したもの）: ブロックごとに探すので、ブロックをまたぐ一致は無い。
 * 要約の 2 万字・メモの 2 千字の打ち切りが無い（長い要約の後半も当たる）。抜き出しは当たったブロックから切る。
 * 問いの制御文字は除く。ひらがなとカタカナは区別する（今と同じ: P8）。
 */
'use strict';

const { searchFold } = require('../cite');
const R = require('../pagerules');

const FULL_TEXT_LIMIT = 60;   // 今の store.searchFullText と同じ既定
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
// 題名の無いページの一覧の行の題名（R.summarize が付ける）を畳んだもの。今の searchIndex はこれに当てる
const UNTITLED_FOLD = searchFold(R.listEntry({ id: '', blocks: [] }).title);

const SQL = Object.freeze({
  blocksMatch: 'select b.type, b.page_id, b.ord, b.text, b.attrs from blocks_fts f join blocks b on b.rid = f.rowid where blocks_fts match ?',
  blocksLike: "select type, page_id, ord, text, attrs from blocks where fold like ? escape '\\'",
  segmentsMatch: 'select s.page_id, s.n, s.text from segments_fts f join segments s on s.rid = f.rowid where segments_fts match ?',
  segmentsLike: "select page_id, n, text from segments where fold like ? escape '\\'",
  untitled: "select id from blocks where type = 'page' and text = ''",
});

function ftsQuote(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, '\\$&');
}

function fold(q) {
  return searchFold(q).replace(CONTROL_RE, '');
}

function plan(q) {
  const f = fold(q);
  if (!f) return null;
  if ([...f].length < 3) return { kind: 'like', pattern: '%' + likeEscape(f) + '%' };
  return { kind: 'match', query: ftsQuote(f) };
}

function run(db, p, matchSql, likeSql) {
  return p.kind === 'match' ? db.prepare(matchSql).all(p.query) : db.prepare(likeSql).all(p.pattern);
}

function searchList(db, q, { ids, entryOf }) {
  const p = plan(q);
  if (!p) return ids.map(entryOf).filter(Boolean);   // 畳んで空の問いは全部（今の searchIndex と同じ）
  const f = fold(q);
  const rowHit = new Set();      // ページの行（題名・メモ）が当たったページ
  const firstBlock = new Map();  // ページ → 当たったうち並びの一番前のブロック
  const memoOf = new Map();
  for (const r of run(db, p, SQL.blocksMatch, SQL.blocksLike)) {
    if (r.type === 'page') {
      rowHit.add(r.page_id);
      const attrs = JSON.parse(r.attrs || '{}');
      memoOf.set(r.page_id, typeof attrs.memo === 'string' ? attrs.memo : '');
      continue;
    }
    const was = firstBlock.get(r.page_id);
    if (!was || r.ord < was.ord) firstBlock.set(r.page_id, r);
  }
  const untitled = UNTITLED_FOLD.includes(f) ? new Set(db.prepare(SQL.untitled).all().map((r) => r.id)) : new Set();
  const out = [];
  for (const id of ids) {
    if (!rowHit.has(id) && !firstBlock.has(id) && !untitled.has(id)) continue;
    const entry = entryOf(id);
    if (!entry) continue;
    if (searchFold(entry.title).includes(f)) { out.push(entry); continue; }
    const b = firstBlock.get(id);
    if (b) { out.push({ ...entry, snippet: R.snippetOf(b.text, f) }); continue; }
    if (rowHit.has(id)) out.push({ ...entry, snippet: R.snippetOf(memoOf.get(id), f) });
  }
  return out;
}

function searchFull(db, q, limit, { ids, entryOf }) {
  const p = plan(q);
  if (!p) return { hits: [], total: 0, truncated: false };
  const max = Number(limit) > 0 ? Math.trunc(Number(limit)) : FULL_TEXT_LIMIT;
  const byPage = new Map();   // ページ → { count, first: 並びの一番前の当たった発言 }
  for (const r of run(db, p, SQL.segmentsMatch, SQL.segmentsLike)) {
    const was = byPage.get(r.page_id);
    if (!was) byPage.set(r.page_id, { count: 1, first: r });
    else { was.count++; if (r.n < was.first.n) was.first = r; }
  }
  const hits = [];
  let total = 0;
  for (const id of ids) {
    const h = byPage.get(id);
    if (!h) continue;
    total++;
    if (hits.length >= max) continue;
    const entry = entryOf(id);
    if (entry) hits.push({ ...entry, segmentHits: h.count, snippet: h.first.text });
  }
  return { hits, total, truncated: total > hits.length };
}

module.exports = { FULL_TEXT_LIMIT, SQL, plan, ftsQuote, searchList, searchFull };
