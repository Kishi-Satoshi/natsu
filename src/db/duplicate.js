/*
 * duplicate.js — ページの複製の操作の並び（0.18.0 Task XN-1。計画 docs/plans/2026-11-18-180.md の決めたこと 62・AQ11 (a)・AQ27 (a)・AQ28 (a)・F249。純粋）
 *
 * planDuplicate(rows, rootId, idOf) → { ops: [{ op: 'add', id, row }…], blocked, count } | null
 *   rows は元のページ（根）と、その子孫の行（blocks の行の形。attrs と rich は JSON の文字か物）。ゴミ箱の行も入れてよい（写さない）。
 *   idOf(行) は写しの新しい ID（ページは p…・行は r…・ブロックは b…。呼び手が重ならないように作る）。
 *   写すもの: 根と、ゴミ箱でない子孫のページ・データベースの行（テンプレートの行も）・その本文の行。ゴミ箱の子とその下は写さない。
 *   中の指し（本文の子ページの行 page・インラインの行・リンクドビューの db とビューの条件・リレーションの列のつなぐ先 db・リレーションのセル・
 *   ビューの条件のリレーションの値・テンプレートの既定 tplDefault・tplViews・ToDo のタスクの印 task）は、写した中を指すなら写しの ID に付け替え、
 *   外を指すならそのまま。両側のリレーションの列（back）の相手が外なら、写しの列は片側にする（外のデータベースの列も外の行の値も書かない: OC-13）。
 *   ゴミ箱の子（写さない行）を指すセルの値・本文の子ページの行は落とす。中のデータベースのロック（attrs.locked）は写す（AQ27 (a)・OC-14）。
 *   根の題名は dupTitle（末が「 (1)」なら足さない: Q-22）。根の親・並びの鍵・作成の時刻と作成者は呼び手（page.duplicate）が決める。
 *   blocked: '' か、写せないもの（'meeting' 議事録・'live' 録音中の写し・'role' 「議事録」「タスク管理」・'locked' 根がロック中のデータベース・
 *   'too-big' 写す行が DUP_MAX を越える）。blocked のとき ops は空。根が無い・ゴミ箱・ページでないときは null。入れた行は書き換えない。
 */
'use strict';

const DUP_MAX = 10000;   // 1回で写す行（ページ・行・ブロックの合計: 決めたこと 62）
const TITLE_MAX = 500;   // ページの題名の上限（validate の LIMITS.title と同じ）
const DUP_TAIL = ' (1)';

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const parseJson = (v, dflt) => {
  if (v === null || v === undefined) return dflt;
  if (typeof v !== 'string') return structuredClone(v);
  try { return JSON.parse(v); } catch (_) { return dflt; }
};
const isDoc = (r) => r.type === 'page' || r.type === 'row';
const trashed = (r) => r.trashed_at !== null && r.trashed_at !== undefined && r.trashed_at !== '';
const LIVE = ['recording', 'paused', 'finalizing'];

// 写しの題名（Q-22: 元の題名の後ろに「 (1)」。末が「 (1)」の題名（写しの写し）には足さない。上限を越えるときは元の題名の末を詰める）
function dupTitle(title) {
  const t = typeof title === 'string' ? title : '';
  if (t.endsWith(DUP_TAIL)) return t;
  if (t === '') return DUP_TAIL.trim();
  const head = [...t];
  const room = TITLE_MAX - DUP_TAIL.length;
  return `${head.length > room ? head.slice(0, room).join('') : t}${DUP_TAIL}`;
}

// 写せないものの印（ゴミ箱でない、写す行だけを見る）
function blockOf(r, attrs, isRoot) {
  if (r.type !== 'page') return '';
  if (isObj(attrs.meeting) && LIVE.includes(attrs.meeting.phase)) return 'live';
  if (attrs.kind === undefined) return 'meeting';
  if (attrs.kind === 'database' && (attrs.role === 'minutes' || attrs.role === 'tasks')) return 'role';
  if (isRoot && attrs.kind === 'database' && attrs.locked === true) return 'locked';
  return '';
}

function planDuplicate(rows, rootId, idOf) {
  const list = Array.isArray(rows) ? rows.filter((r) => isObj(r) && typeof r.id === 'string') : [];
  const byId = new Map(list.map((r) => [r.id, r]));
  const root = byId.get(rootId);
  if (!root || root.type !== 'page' || trashed(root)) return null;
  // 写すページと行（根から parent_id をたどる。ゴミ箱の子とその下は写さず、gone に覚える）
  const kids = new Map();
  for (const r of list) if (isDoc(r) && typeof r.parent_id === 'string') { if (!kids.has(r.parent_id)) kids.set(r.parent_id, []); kids.get(r.parent_id).push(r); }
  const docs = [];
  const gone = new Set();
  const seen = new Set([root.id]);
  for (const queue = [root]; queue.length;) {
    const r = queue.shift();
    docs.push(r);
    for (const k of kids.get(r.id) || []) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      if (trashed(k)) { gone.add(k.id); continue; }
      queue.push(k);
    }
  }
  // ゴミ箱の子の下（写さない）も gone に
  for (const stack = [...gone]; stack.length;) for (const k of kids.get(stack.pop()) || []) if (!gone.has(k.id)) { gone.add(k.id); stack.push(k.id); }
  const docIds = new Set(docs.map((r) => r.id));
  const attrsOf = new Map(list.map((r) => [r.id, parseJson(r.attrs, {})]));
  for (const r of docs) {
    const why = blockOf(r, attrsOf.get(r.id) || {}, r === root);
    if (why) return { ops: [], blocked: why, count: 0 };
  }
  // 本文の行（写すページ・行の本文。親の行を写さない行の下は写さない。ゴミ箱の子を指す子ページの行は落とす）
  const bodyOf = new Map();
  for (const r of list) if (!isDoc(r) && docIds.has(r.page_id)) { if (!bodyOf.has(r.page_id)) bodyOf.set(r.page_id, []); bodyOf.get(r.page_id).push(r); }
  const blocks = [];
  for (const d of docs) {
    const mine = bodyOf.get(d.id) || [];
    const under = new Map();
    for (const b of mine) { const p = typeof b.parent_id === 'string' ? b.parent_id : d.id; if (!under.has(p)) under.set(p, []); under.get(p).push(b); }
    for (const stack = [d.id]; stack.length;) {
      for (const b of under.get(stack.pop()) || []) {
        const a = attrsOf.get(b.id) || {};
        if (b.type === 'subpage' && gone.has(a.page)) continue;
        blocks.push(b);
        stack.push(b.id);
      }
    }
  }
  const count = docs.length + blocks.length;
  if (count > DUP_MAX) return { ops: [], blocked: 'too-big', count };
  // 新しい ID（行ごとに1回）と付け替え
  const map = new Map();
  for (const r of [...docs, ...blocks]) map.set(r.id, idOf(r));
  const to = (id) => (map.has(id) ? map.get(id) : id);
  const ref = (id) => to(id);   // 中の指し（写した中なら写しの ID・外はそのまま）
  const refs = (ids) => (Array.isArray(ids) ? ids.filter((x) => !gone.has(x)).map(ref) : ids);
  // ビューの条件の中のリレーションの値（グループの入れ子もたどる）
  const relCols = (cols) => new Set((Array.isArray(cols) ? cols : []).filter((c) => isObj(c) && c.type === 'rel').map((c) => c.id));
  const fixFilter = (f, rel) => {
    if (!isObj(f)) return f;
    const out = { ...f };
    if (Array.isArray(f.items)) out.items = f.items.map((x) => fixFilter(x, rel));
    if (rel.has(f.col) && typeof f.value === 'string') out.value = ref(f.value);
    return out;
  };
  const fixViews = (views, cols) => (Array.isArray(views) ? views.map((v) => (isObj(v) && isObj(v.filter) ? { ...v, filter: fixFilter(v.filter, relCols(cols)) } : v)) : views);
  const colsOfDb = (id) => { const a = attrsOf.get(id); return a && Array.isArray(a.cols) ? a.cols : []; };
  const fixAttrs = (r) => {
    const a = parseJson(r.attrs, {});
    if (r.type === 'page') {
      delete a.rowAt;   // 元の親の本文の置き場（ゴミ箱から戻すときの印）は写さない
      if (Array.isArray(a.cols)) {
        a.cols = a.cols.map((c) => {
          if (!isObj(c) || c.type !== 'rel') return c;
          const n = { ...c, db: ref(c.db) };
          if (!docIds.has(c.db)) delete n.back;   // 外への両側の列は写しでは片側（OC-13）
          return n;
        });
      }
      a.views = fixViews(a.views, a.cols);
      if (typeof a.tplDefault === 'string') { if (gone.has(a.tplDefault)) delete a.tplDefault; else a.tplDefault = ref(a.tplDefault); }
      if (isObj(a.tplViews)) a.tplViews = Object.fromEntries(Object.entries(a.tplViews).filter(([, v]) => !gone.has(v)).map(([k, v]) => [k, ref(v)]));
    } else if (r.type === 'row') {
      if (isObj(a.cells)) {
        const rel = relCols(colsOfDb(r.parent_id));
        for (const k of Object.keys(a.cells)) {
          if (!rel.has(k)) continue;
          const v = refs(a.cells[k]);
          if (Array.isArray(v) && !v.length) delete a.cells[k]; else a.cells[k] = v;
        }
      }
    } else if (r.type === 'subpage') {
      a.page = ref(a.page);
    } else if (r.type === 'dbview') {
      a.views = fixViews(a.views, colsOfDb(a.db));
      a.db = ref(a.db);
    }
    if (typeof a.task === 'string') a.task = ref(a.task);
    return a;
  };
  const ops = [];
  for (const r of [...docs, ...blocks]) {
    const id = map.get(r.id);
    const rich = parseJson(r.rich, null);
    const row = {
      id, type: r.type, page_id: r === root ? id : to(r.page_id), parent_id: r === root ? (r.parent_id ?? null) : to(r.parent_id),
      ord: r.ord, text: r === root ? dupTitle(r.text) : (typeof r.text === 'string' ? r.text : ''), rich: Array.isArray(rich) ? rich : null,
      attrs: fixAttrs(r), rev: 1, created_at: typeof r.created_at === 'string' ? r.created_at : '', updated_at: typeof r.updated_at === 'string' ? r.updated_at : '', trashed_at: null,
    };
    ops.push({ op: 'add', id, row });
  }
  return { ops, blocked: '', count };
}

module.exports = { DUP_MAX, planDuplicate, dupTitle };
