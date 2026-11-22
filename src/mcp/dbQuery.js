'use strict';
/*
 * dbQuery.js — Claude のデータベースの問い合わせと、書く値の読み替え（0.18.0 CT-3。計画 docs/plans/2026-11-18-180.md の決めたこと 34〜38・F240・F241。純粋）
 *
 * Claude は列・選択肢・作成者を名前で渡す。ここで列の ID・選択肢の ID・me／claude／system に読み替え、0.16.0 の dbView.normalizeView と
 * dbModel.cellOf と同じ照らしに通す（SQL も式も受けない。値はただの文字・数として JS の絞り込みに渡る: 試作の記録した読み「検索の入力をそのまま
 * 検索の文法に渡さない」）。読めない条件・値が1つでもあれば、絞らず書かずに、どれが読めなかったかを返す（黙って落とさない: F240）。
 *
 * toView(args, cols, views) → { ok: true, view, pre } | { ok: false, at, why, col? }
 *   args: { view?（ビューの名前）, filters?: [{ column, op, value? }], match?: 'all'|'any', sort?: [{ column, dir }] }（形は道具の引数の照らしが先に見る）。
 *   view は dbView.applyView に渡す形（filter は Claude の条件だけ・sort は渡した並べ替えの後にビューの並べ替え・group は無し）。
 *   pre は名前で選んだビューの絞り込み（先に当てる。入れ子の深さを越えないように Claude の条件と分ける）か null。
 *   名前を渡さなければ、最初のビューの並べ替えだけを使う（get_meeting のデータベースの行の並びと同じ: 続きを offset で読める）。
 *   at: 'view' | 'filter:<何番目>' | 'sort:<何番目>'。why: 'no-view' | 'no-col' | 'no-op' | 'no-opt' | 'bad-value'
 * cellsFromNames(cells, cols, { minutes }) → { ok: true, cells: { <列の ID>: 値 | null } } | { ok: false, col（渡した列の名前）, why, opts? }
 *   why: 'no-col' | 'title'（題名は title の引数で） | 'read-only'（作成日時・作成者・ID・「議事録」の読む列。「議事録」は参加者のほかも） |
 *   'no-opt'（opts に今ある選択肢の名前） | 'bad-value'。リレーションは相手の行の ID の並びのまま（つなぐのは DB の命令: 相手の行を見る）
 * OPS_HELP: 道具の説明に入れる、列の種類の名前ごとの op の表（FILTER_OPS から作る。手で書かない）
 */
const DV = require('../dbView');
const DM = require('../dbModel');

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const NO_VALUE = ['empty', 'notEmpty', 'today', 'yes', 'no'];
const OPT_TYPES = ['select', 'status', 'multi'];
// 作成者・最終更新者の名前（画面の「自分」「Claude」「NaTsu」）→ 値
const WHO_NAMES = Object.freeze([['自分', 'me'], ['Claude', 'claude'], ['NaTsu', 'system']]);

const liveCols = (cols) => (Array.isArray(cols) ? cols.filter((c) => isObj(c) && !c.gone && Object.hasOwn(DM.COLS, c.type)) : []);
// 名前で探す: ちょうど同じ名前の最初、無ければ寄せた名前（大文字小文字・全角半角）が1つだけ当たるもの
function byName(list, name, nameOf = (x) => x.name) {
  if (typeof name !== 'string' || !name) return null;
  const exact = list.find((x) => nameOf(x) === name);
  if (exact) return exact;
  const f = DM.foldName(name);
  const hits = list.filter((x) => typeof nameOf(x) === 'string' && DM.foldName(nameOf(x)) === f);
  return hits.length === 1 ? hits[0] : null;
}
const listOf = (v) => (Array.isArray(v) ? v : [v]);
// 選択肢の名前（1つか並び）→ ID の並び | null（無い名前）
function optIds(col, v) {
  const out = [];
  for (const name of listOf(v)) {
    const o = byName(Array.isArray(col.opts) ? col.opts : [], name);
    if (!o) return null;
    out.push(o.id);
  }
  return out;
}
const whoIds = (v) => {
  const out = [];
  for (const name of listOf(v)) {
    const w = byName(WHO_NAMES, name, (x) => x[0]);
    if (!w) return null;
    out.push(w[1]);
  }
  return out;
};

// ---------------------------------------------------------------- 問い合わせ
// 1つの条件 → { cond } | { why }
function condOf(f, cols) {
  const col = byName(liveCols(cols), f.column);
  if (!col) return { why: 'no-col' };
  if (!(DV.FILTER_OPS[col.type] || []).includes(f.op)) return { why: 'no-op' };
  const has = f.value !== undefined && f.value !== null;
  if (NO_VALUE.includes(f.op)) return has ? { why: 'bad-value' } : { cond: { col: col.id, cmp: f.op } };
  if (!has) return { why: 'bad-value' };
  let value = f.value;
  if (OPT_TYPES.includes(col.type)) {
    value = optIds(col, f.value);
    if (!value) return { why: 'no-opt' };
  } else if (col.type === 'cby' || col.type === 'mby') {
    value = whoIds(f.value);
    if (!value) return { why: 'bad-value' };
  }
  const cond = { col: col.id, cmp: f.op, value };
  // dbView と同じ照らし（値の形・日付・選択肢・FILTER_OPS）。直されたら（落とされたら）読めない値
  const n = DV.normalizeView({ id: 'q', name: 'q', layout: 'table', filter: { op: 'and', items: [cond] } }, cols);
  if (n.repaired.includes('filter') || !n.view.filter) return { why: 'bad-value' };
  return { cond };
}
function toView(args, cols, views) {
  const a = isObj(args) ? args : {};
  const vs = Array.isArray(views) ? views.filter(isObj) : [];
  let picked = null;
  if (a.view !== undefined) {
    picked = vs.find((v) => v.name === a.view) || null;
    if (!picked) return { ok: false, at: 'view', why: 'no-view' };
  }
  const base = DV.normalizeView(picked || vs[0] || DV.defaultView('v1', 'table', cols), cols).view;
  const conds = [];
  const filters = Array.isArray(a.filters) ? a.filters : [];
  for (let i = 0; i < filters.length; i += 1) {
    const r = condOf(isObj(filters[i]) ? filters[i] : {}, cols);
    if (!r.cond) return { ok: false, at: `filter:${i + 1}`, why: r.why, col: isObj(filters[i]) ? filters[i].column : undefined };   // 1つでも読めなければ絞らない（F240）
    conds.push(r.cond);
  }
  const sort = [];
  const sorts = Array.isArray(a.sort) ? a.sort : [];
  for (let i = 0; i < sorts.length; i += 1) {
    const s = isObj(sorts[i]) ? sorts[i] : {};
    const col = byName(liveCols(cols), s.column);
    if (!col || (s.dir !== 'asc' && s.dir !== 'desc')) return { ok: false, at: `sort:${i + 1}`, why: col ? 'bad-value' : 'no-col', col: s.column };
    if (!sort.some((x) => x.col === col.id)) sort.push({ col: col.id, dir: s.dir });
  }
  for (const s of base.sort) if (!sort.some((x) => x.col === s.col)) sort.push(s);   // 同じ値はビューの並び → 行の並びの鍵（applyView）
  const filter = conds.length ? { op: a.match === 'any' ? 'or' : 'and', items: conds } : null;
  return { ok: true, view: { ...base, filter, sort, group: null, agg: {} }, pre: picked ? base.filter : null };
}

// ---------------------------------------------------------------- 書く値
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Claude の値 → dbModel の値の形（読めない形はそのまま返し、cellOf が断る）
function cellValueOf(col, v) {
  if (OPT_TYPES.includes(col.type)) {
    const ids = optIds(col, v);
    if (!ids) return { why: 'no-opt' };
    return { v: col.type === 'multi' ? ids : (Array.isArray(v) ? v : ids[0]) };
  }
  if (col.type === 'person' || col.type === 'rel') return { v: typeof v === 'string' ? [v] : v };
  if (col.type === 'date') {
    if (typeof v === 'string' && DAY_RE.test(v)) return { v: { start: v } };
    if (isObj(v) && Object.keys(v).length === 2 && typeof v.from === 'string' && typeof v.to === 'string') return { v: { start: v.from, end: v.to } };
    return { why: 'bad-value' };
  }
  return { v };
}
function cellsFromNames(cells, cols, { minutes = false } = {}) {
  const out = {};
  const live = liveCols(cols);
  for (const [name, v] of Object.entries(isObj(cells) ? cells : {})) {
    const col = byName(live, name);
    if (!col) return { ok: false, col: name, why: 'no-col' };
    if (col.type === 'title') return { ok: false, col: name, why: 'title' };
    if (!DM.COLS[col.type].writable || (minutes && col.type !== 'person')) return { ok: false, col: name, why: 'read-only' };   // 「議事録」の行は参加者だけ（決めたこと 36）
    if (v === null) { out[col.id] = null; continue; }   // 空にする（CR20）
    const m = cellValueOf(col, v);
    if (m.why === 'no-opt') return { ok: false, col: name, why: 'no-opt', opts: (col.opts || []).map((o) => o.name) };
    if (m.why) return { ok: false, col: name, why: m.why };
    try { out[col.id] = DM.cellOf(col, m.v); } catch (_) { return { ok: false, col: name, why: 'bad-value' }; }
  }
  return { ok: true, cells: out };
}

// ---------------------------------------------------------------- 道具の説明の表（同じ op の並びの種類を1行に。種類の名前は列のメニューの名前）
const OPS_HELP = (() => {
  const groups = new Map();
  for (const [type, ops] of Object.entries(DV.FILTER_OPS)) {
    const k = ops.join('・');
    if (!groups.has(k)) groups.set(k, []);
    const label = DM.COLS[type].label;
    if (!groups.get(k).includes(label)) groups.get(k).push(label);
  }
  return [...groups].map(([ops, labels]) => `${labels.join('・')}: ${ops}`).join('\n');
})();

module.exports = { toView, cellsFromNames, OPS_HELP, WHO_NAMES };
