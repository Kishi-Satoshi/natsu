'use strict';
// 0.16.0（0a6a375）の src/db/commands.js から、一覧に出すページの行を作る所（listedRows と、その rowScope）を、字のまま写した見本（点検 2 の rv59 軽い 4・R49）。
// 0.17.0 の DB を 0.16.0 の一覧の読み方で読み、0.16.0 の画面の木（pageTree と、サイドバーの絞り !p.inRow）で議事録がどこに並ぶかを見るテストが使う。
// 写したのは 0a6a375 の行 74・76（LIVE_PHASES・isObj）・88 と 103（HOT_QUERIES の list と dbRow）・263（isLive）・270（keyOfRow）・1528（isDbPage）・
// 282〜301（listedRows）・1260〜1297（rowScope）だけ。

const LIVE_PHASES = ['recording', 'paused', 'finalizing'];
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const HOT_QUERIES = Object.freeze({
  list: "select rid, id, parent_id, ord, text, rev, created_at, updated_at, attrs, trashed_at from blocks where type = 'page' order by created_at desc, rid desc",
  dbRow: 'select id, type, parent_id, ord, text, attrs, rev, created_at, updated_at, trashed_at from blocks where id = ?',
});
const isLive = (attrs) => isObj(attrs.meeting) && LIVE_PHASES.includes(attrs.meeting.phase);
const keyOfRow = (r) => [r.rid, r.rev, r.text, r.created_at, r.updated_at, r.attrs].join('\u0000');
const isDbPage = (attrs) => isObj(attrs) && attrs.kind === 'database';

function listedRows(db) {
  const out = [];
  for (const r of db.prepare(HOT_QUERIES.list).all()) {
    if (r.trashed_at !== null && r.trashed_at !== undefined) continue;
    const attrs = JSON.parse(r.attrs || '{}');
    if (isLive(attrs)) continue;
    out.push({ id: r.id, key: keyOfRow(r), attrs, createdAt: r.created_at, parentId: r.parent_id ?? null, ord: r.ord, title: r.text });   // 0.15.0 PH-7: 題名は MCP の場所の文（決めたこと 34）
  }
  // 0.16.0 R97（2026-11-09 の持ち主の答え・M14）: データベースの行の中の子ページ（と子孫）は、行が生きている間だけ一覧に出し、一番近い行の印 inRow を付ける
  // （画面はサイドバーの木に出さない）。行かデータベースをゴミ箱へ入れると見えなくなる（ページには書かない: 決めたこと 28）
  const scope = rowScope(db, out);
  return out.filter((r) => {
    const s = scope.page(r.id);
    if (!s) return true;
    if (!s.live) return false;
    r.inRow = { row: s.row, title: s.title, db: s.db, dbTitle: s.dbTitle };
    return true;
  });
}


function rowScope(db, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pages = new Map();
  const rowsMemo = new Map();
  const busy = new Set();
  const alive = (r) => Boolean(r) && (r.trashedAt === null || r.trashedAt === undefined);
  const parentOf = (r) => (r && typeof r.parentId === 'string' && r.parentId ? r.parentId : null);
  function row(id) {
    if (rowsMemo.has(id)) return rowsMemo.get(id);
    rowsMemo.set(id, null);   // 輪の見張り（データベースの道が同じ行に戻る）
    const r = db.prepare(HOT_QUERIES.dbRow).get(id);
    let info = null;
    if (r && r.type === 'row') {
      const d = byId.get(r.parent_id);
      const up = d ? page(d.id) : null;
      const live = (r.trashed_at === null || r.trashed_at === undefined) && alive(d) && isDbPage(d.attrs) && !isLive(d.attrs) && (!up || up.live);
      info = { row: r.id, title: r.text, db: r.parent_id, dbTitle: d ? d.title : '', live };
    }
    rowsMemo.set(id, info);
    return info;
  }
  function page(start) {
    const path = [];
    let info = null;
    for (let cur = start; ;) {
      if (pages.has(cur)) { info = pages.get(cur); break; }
      if (busy.has(cur)) break;
      busy.add(cur); path.push(cur);
      const p = parentOf(byId.get(cur));
      if (p === null) break;
      if (!byId.has(p)) { info = row(p); break; }
      cur = p;
    }
    for (const id of path) { pages.set(id, info); busy.delete(id); }
    return info;
  }
  return { page: (id) => (byId.has(id) ? page(id) : null), row };
}

module.exports = { listedRows };
