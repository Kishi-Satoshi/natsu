'use strict';
// データベースのビューの純粋な部品（0.16.0 Task DS-1。計画 docs/plans/2026-11-04-160.md の決めたこと 15〜23・30〜32）。
// ビューの照らし（normalizeView: 壊れた項目だけ既定に戻し、ほかは残す）・絞り込み（かつ／または・入れ子 3 段）・並べ替え（空はいつも最後）・
// グループ・表の下の集計・データベースの中の検索・見える行の切り出し（windowOf）を、DB の読む命令 db.view と画面の写しが同じ表で行う。
// 並べ替えと絞り込みは SQL でなくここの JS で行う（列の種類ごとの比べ方を1か所に持つ: 決めたこと 4）。
// 行の形と列の形は src/dbModel.js の頭の注のとおり。日付の「今日」はその PC の時刻の日（now はミリ秒）。
const DM = require('./dbModel');
const { searchFold } = require('./cite');

const FILTER_DEPTH = 3;          // 絞り込みのグループの入れ子（一番外のグループを 1 段と数える: V-T20）
const WIDTH_MIN = 80;
const WIDTH_MAX = 800;
const VIEW_NAME_MAX = 100;
const FILTER_TEXT_MAX = 200;
const DAYS_MAX = 3650;
const VIEW_KEYS = ['id', 'name', 'layout', 'props', 'sort', 'filter', 'group', 'agg'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const collator = new Intl.Collator('ja');

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- 日（その PC の時刻）
const pad2 = (n) => String(n).padStart(2, '0');
const dayOfDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return dayOfDate(new Date(y, m - 1, d + n, 12));
}
function realDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  return addDays(s, 0) === s;
}
const daysBetween = (a, b) => {
  const [y1, m1, d1] = a.split('-').map(Number); const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
};
// 日付の値か作成日時・最終更新日時の値 → { start, end, time? }（日は YYYY-MM-DD）か null
function spanOf(col, v) {
  if (isEmpty(v)) return null;
  if (col.type === 'ctime' || col.type === 'mtime') {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    const day = dayOfDate(d);
    return { start: day, end: day, time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
  }
  if (!isObj(v) || typeof v.start !== 'string') return null;
  return { start: v.start, end: typeof v.end === 'string' ? v.end : v.start, time: v.time || '' };
}

// ---------------------------------------------------------------- 絞り込みの条件（決めたこと 18）
const TEXT_OPS = ['contains', 'notContains', 'is', 'startsWith', 'endsWith', 'empty', 'notEmpty'];
const NUM_OPS = ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'empty'];
const DATE_OPS = ['before', 'after', 'on', 'between', 'today', 'pastDays', 'nextDays', 'empty'];
const FILTER_OPS = Object.freeze({
  title: TEXT_OPS, text: TEXT_OPS, person: TEXT_OPS, url: TEXT_OPS, email: TEXT_OPS, phone: TEXT_OPS,
  number: NUM_OPS, no: NUM_OPS,
  select: ['any', 'none', 'empty'], status: ['any', 'none', 'empty'], cby: ['any', 'none'], mby: ['any', 'none'],
  multi: ['anyOf', 'allOf', 'empty'],
  date: DATE_OPS, ctime: DATE_OPS, mtime: DATE_OPS,
  check: ['yes', 'no'],
  rel: ['contains', 'empty'],
});
const NO_VALUE = ['empty', 'notEmpty', 'today', 'yes', 'no'];
const filterText = (v) => typeof v === 'string' && v !== '' && v.length <= FILTER_TEXT_MAX && !/[\u0000-\u001f]/.test(v);
// 条件の値の形がよいか
function condValueOk(col, cmp, v) {
  if (NO_VALUE.includes(cmp)) return v === undefined;
  const t = col.type;
  if (FILTER_OPS[t] === TEXT_OPS) return filterText(v);
  if (FILTER_OPS[t] === NUM_OPS) return typeof v === 'number' && Number.isFinite(v);
  if (FILTER_OPS[t] === DATE_OPS) {
    if (cmp === 'between') return isObj(v) && realDay(v.from) && realDay(v.to) && v.from <= v.to && Object.keys(v).length === 2;
    if (cmp === 'pastDays' || cmp === 'nextDays') return Number.isInteger(v) && v >= 1 && v <= DAYS_MAX;
    return realDay(v);
  }
  if (t === 'rel') return typeof v === 'string' && ID_RE.test(v);
  if (t === 'cby' || t === 'mby') return Array.isArray(v) && v.length > 0 && v.every((x) => DM.WHO.includes(x)) && new Set(v).size === v.length;
  // 選択肢の種類: 今ある選択肢の ID の並び
  return Array.isArray(v) && v.length > 0 && v.length <= 200 && new Set(v).size === v.length &&
    v.every((id) => (col.opts || []).some((o) => o.id === id));
}
// 列の値の文字（テキストの条件と検索のため）
function textValue(col, v) {
  if (isEmpty(v)) return '';
  if (Array.isArray(v)) return v.join(', ');
  return typeof v === 'string' ? v : String(v);
}
function matchCond(c, row, byId, now) {
  const col = byId.get(c.col);
  if (!col || !isObj(c) || !(FILTER_OPS[col.type] || []).includes(c.cmp)) return true;   // 無い列・消した列・知らない条件は無いのと同じ
  const v = DM.cellValue(row, col);
  const empty = isEmpty(v);
  if (c.cmp === 'empty') return col.type === 'check' ? v !== true : empty;
  if (c.cmp === 'notEmpty') return !empty;
  switch (col.type) {
    case 'title': case 'text': case 'person': case 'url': case 'email': case 'phone': {
      const s = searchFold(textValue(col, v)); const w = searchFold(c.value);
      if (c.cmp === 'contains') return s.includes(w);
      if (c.cmp === 'notContains') return !s.includes(w);
      if (c.cmp === 'is') return s === w;
      if (c.cmp === 'startsWith') return s.startsWith(w);
      return s.endsWith(w);
    }
    case 'number': case 'no': {
      if (empty) return c.cmp === 'ne';
      const x = c.value;
      return { eq: v === x, ne: v !== x, gt: v > x, lt: v < x, ge: v >= x, le: v <= x }[c.cmp];
    }
    case 'select': case 'status': case 'cby': case 'mby': {
      const hit = !empty && c.value.includes(v);
      return c.cmp === 'any' ? hit : !hit;
    }
    case 'multi': {
      const have = Array.isArray(v) ? v : [];
      return c.cmp === 'anyOf' ? c.value.some((id) => have.includes(id)) : c.value.every((id) => have.includes(id));
    }
    case 'check': return c.cmp === 'yes' ? v === true : v !== true;
    case 'rel': return Array.isArray(v) && v.includes(c.value);
    default: {   // 日付・作成日時・最終更新日時
      const s = spanOf(col, v);
      if (!s) return false;
      const today = dayOfDate(new Date(now));
      switch (c.cmp) {
        case 'before': return s.start < c.value;
        case 'after': return s.end > c.value;
        case 'on': return s.start <= c.value && c.value <= s.end;
        case 'between': return c.value.from <= s.start && s.start <= c.value.to;
        case 'today': return s.start <= today && today <= s.end;
        case 'pastDays': return addDays(today, -(c.value - 1)) <= s.start && s.start <= today;
        case 'nextDays': return today <= s.start && s.start <= addDays(today, c.value - 1);
        default: return true;
      }
    }
  }
}
function matchTree(tree, row, byId, now) {
  if (!isObj(tree)) return true;
  if (!Array.isArray(tree.items)) return matchCond(tree, row, byId, now);
  const items = tree.items;
  if (items.length === 0) return true;
  const one = (it) => matchTree(it, row, byId, now);
  return tree.op === 'or' ? items.some(one) : items.every(one);
}
const liveCols = (cols) => (Array.isArray(cols) ? cols.filter((c) => c && !c.gone && Object.hasOwn(DM.COLS, c.type)) : []);
const colMap = (cols) => new Map(liveCols(cols).map((c) => [c.id, c]));
// 行が絞り込みに当たるか（tree が無ければ通る）
function matchFilter(tree, row, cols, now) {
  return matchTree(tree, row, colMap(cols), now);
}

// ---------------------------------------------------------------- 並べ替え（決めたこと 17）
const optIndex = (col, id) => { const i = (col.opts || []).findIndex((o) => o.id === id); return i < 0 ? (col.opts || []).length : i; };
function cmpPlain(col, a, b) {
  switch (col.type) {
    case 'number': case 'no': return a < b ? -1 : a > b ? 1 : 0;
    case 'select': case 'status': return optIndex(col, a) - optIndex(col, b);
    case 'multi': {
      const x = a.map((id) => optIndex(col, id)); const y = b.map((id) => optIndex(col, id));
      for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] - y[i];
      return x.length - y.length;
    }
    case 'date': { const x = `${a.start} ${a.time || ''}`; const y = `${b.start} ${b.time || ''}`; return x < y ? -1 : x > y ? 1 : 0; }
    case 'ctime': case 'mtime': return a < b ? -1 : a > b ? 1 : 0;
    case 'cby': case 'mby': return DM.WHO.indexOf(a) - DM.WHO.indexOf(b);
    case 'rel': return a.length - b.length;
    default: return collator.compare(textValue(col, a), textValue(col, b));
  }
}
// 2つの値の並び（-1・0・1）。空はいつも最後（昇順でも降順でも）。チェックは偽（空）が先
function compareCells(col, a, b, dir = 'asc') {
  const s = dir === 'desc' ? -1 : 1;
  if (col.type === 'check') return s * ((a === true ? 1 : 0) - (b === true ? 1 : 0));
  const ea = isEmpty(a); const eb = isEmpty(b);
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1;
  return Math.sign(s * cmpPlain(col, a, b));
}
const byOrd = (x, y) => (x.ord < y.ord ? -1 : x.ord > y.ord ? 1 : x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

// ---------------------------------------------------------------- 集計（決めたこと 21）
const COMMON_AGG = ['count', 'values', 'unique', 'empty', 'filled', 'emptyPct', 'filledPct'];
function AGG_KINDS(col) {
  if (!col) return [];
  if (col.type === 'number' || col.type === 'no') return [...COMMON_AGG, 'sum', 'avg', 'median', 'min', 'max', 'range'];
  if (col.type === 'date' || col.type === 'ctime' || col.type === 'mtime') return [...COMMON_AGG, 'earliest', 'latest', 'range'];
  if (col.type === 'check') return ['count', 'checked', 'unchecked', 'checkedPct', 'uncheckedPct'];
  return COMMON_AGG;
}
const pct = (n, d) => (d === 0 ? 0 : (n / d) * 100);
// 列の値の並び → 集計の値（数か日の文字。数えるものが無ければ null）
function aggregate(col, values, kind) {
  const all = Array.isArray(values) ? values : [];
  const filled = all.filter((v) => !isEmpty(v));
  switch (kind) {
    case 'count': return all.length;
    case 'values': return filled.reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);
    case 'empty': return all.length - filled.length;
    case 'filled': return filled.length;
    case 'emptyPct': return pct(all.length - filled.length, all.length);
    case 'filledPct': return pct(filled.length, all.length);
    case 'unique': return new Set(filled.flatMap((v) => (Array.isArray(v) ? v : [JSON.stringify(v)]))).size;
    case 'checked': return all.filter((v) => v === true).length;
    case 'unchecked': return all.filter((v) => v !== true).length;
    case 'checkedPct': return pct(all.filter((v) => v === true).length, all.length);
    case 'uncheckedPct': return pct(all.filter((v) => v !== true).length, all.length);
    default: break;
  }
  if (col.type === 'date' || col.type === 'ctime' || col.type === 'mtime') {
    const spans = filled.map((v) => spanOf(col, v)).filter(Boolean);
    if (!spans.length) return null;
    const first = spans.reduce((m, s) => (s.start < m ? s.start : m), spans[0].start);
    const last = spans.reduce((m, s) => (s.end > m ? s.end : m), spans[0].end);
    if (kind === 'earliest') return first;
    if (kind === 'latest') return last;
    if (kind === 'range') return daysBetween(first, last);
    return null;
  }
  const nums = filled.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!nums.length) return kind === 'sum' ? 0 : null;
  switch (kind) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'median': { const m = nums.length >> 1; return nums.length % 2 ? nums[m] : (nums[m - 1] + nums[m]) / 2; }
    case 'min': return nums[0];
    case 'max': return nums[nums.length - 1];
    case 'range': return nums[nums.length - 1] - nums[0];
    default: return null;
  }
}

// ---------------------------------------------------------------- グループ（決めたこと 19）
const GROUP_BY = Object.freeze({ status: ['group', 'option'], date: ['day', 'week', 'month', 'year'], ctime: ['day', 'week', 'month', 'year'], mtime: ['day', 'week', 'month', 'year'] });
const GROUP_TYPES = Object.freeze(['title', 'text', 'number', 'select', 'multi', 'status', 'date', 'person', 'check', 'url', 'email', 'phone', 'ctime', 'mtime', 'cby', 'mby', 'no']);
const STATUS_GROUPS = ['todo', 'doing', 'done'];
function dateKey(by, day) {
  if (by === 'year') return day.slice(0, 4);
  if (by === 'month') return day.slice(0, 7);
  if (by === 'week') {
    const [y, m, d] = day.split('-').map(Number);
    const wd = (new Date(y, m - 1, d, 12).getDay() + 6) % 7;   // 月曜を週の頭に
    return addDays(day, -wd);
  }
  return day;
}
// 行の値 → グループの鍵の並び（空は ['']）
function groupKeys(col, g, v) {
  if (col.type === 'check') return [v === true ? 'true' : 'false'];
  if (col.type === 'status' && (g.by || 'group') === 'group') {
    const gs = col.groups || {};
    if (isEmpty(v)) return ['todo'];
    return [STATUS_GROUPS.find((k) => (gs[k] || []).includes(v)) || 'todo'];
  }
  if (isEmpty(v)) return [''];
  if (col.type === 'multi' || col.type === 'person') return [...new Set(v)];
  if (col.type === 'date' || col.type === 'ctime' || col.type === 'mtime') { const s = spanOf(col, v); return s ? [dateKey(g.by || 'month', s.start)] : ['']; }
  return [String(v)];
}
// 鍵の自然な並び（選択肢の並び・値の昇順。空は最後）と、行が無くても出す鍵
function naturalKeys(col, g, seen) {
  if (col.type === 'check') return ['false', 'true'];
  if (col.type === 'status' && (g.by || 'group') === 'group') return [...STATUS_GROUPS];
  if (col.type === 'select' || col.type === 'multi' || col.type === 'status') return [...(col.opts || []).map((o) => o.id), ''];
  const keys = [...seen].filter((k) => k !== '');
  if (col.type === 'number' || col.type === 'no') keys.sort((a, b) => Number(a) - Number(b));
  else if (col.type === 'cby' || col.type === 'mby') keys.sort((a, b) => DM.WHO.indexOf(a) - DM.WHO.indexOf(b));
  else if (col.type === 'date' || col.type === 'ctime' || col.type === 'mtime') keys.sort();
  else keys.sort(collator.compare);
  if (seen.has('')) keys.push('');
  return keys;
}

// ---------------------------------------------------------------- ビュー（決めたこと 15）
function defaultView(id, layout, cols, name) {
  const lay = layout === 'list' ? 'list' : 'table';
  return {
    id, name: typeof name === 'string' && name ? name : (lay === 'list' ? 'リスト' : '表'), layout: lay,
    props: liveCols(cols).map((c) => ({ col: c.id, show: lay === 'table' || c.type === 'title', wrap: false })),
    sort: [], filter: null, group: null, agg: {},
  };
}
const nameOk = (s) => typeof s === 'string' && s.trim() !== '' && s === s.trim() && s.length <= VIEW_NAME_MAX && !/[\u0000-\u001f]/.test(s);
// 絞り込みのグループを照らす（depth は今のグループの段）→ 照らしたグループ | null（中身が無い）
function normGroup(g, byId, depth, bad) {
  if (!isObj(g) || (g.op !== 'and' && g.op !== 'or') || !Array.isArray(g.items) || Object.keys(g).some((k) => k !== 'op' && k !== 'items')) { bad(); return null; }
  const items = [];
  for (const it of g.items) {
    if (isObj(it) && Array.isArray(it.items)) {
      if (depth + 1 > FILTER_DEPTH) { bad(); continue; }
      const sub = normGroup(it, byId, depth + 1, bad);
      if (sub) items.push(sub);
      continue;
    }
    const col = isObj(it) ? byId.get(it.col) : null;
    const keysOk = isObj(it) && Object.keys(it).every((k) => k === 'col' || k === 'cmp' || k === 'value');
    if (!col || !keysOk || !(FILTER_OPS[col.type] || []).includes(it.cmp) || !condValueOk(col, it.cmp, it.value)) { bad(); continue; }
    items.push(it.value === undefined ? { col: it.col, cmp: it.cmp } : { col: it.col, cmp: it.cmp, value: it.value });
  }
  return items.length ? { op: g.op, items } : null;
}
function normGroupBy(g, byId, bad) {
  const col = isObj(g) ? byId.get(g.col) : null;
  if (!col || !GROUP_TYPES.includes(col.type)) { bad(); return null; }
  const out = { col: g.col };
  const strs = (a) => Array.isArray(a) && a.length <= 1000 && a.every((x) => typeof x === 'string' && x.length <= 64) && new Set(a).size === a.length;
  for (const k of Object.keys(g)) {
    if (k === 'col') continue;
    if (k === 'by' && (GROUP_BY[col.type] || []).includes(g.by)) out.by = g.by;
    else if ((k === 'hide' || k === 'order') && strs(g[k])) { if (g[k].length) out[k] = [...g[k]]; }
    else if (k === 'hideEmpty' && typeof g.hideEmpty === 'boolean') { if (g.hideEmpty) out.hideEmpty = true; }
    else bad();
  }
  return out;
}
// ビューを照らす → { view, repaired（落とした・既定に戻した項目の名前） }。壊れた項目だけを直し、ほかの設定は残す（試作の項目ごとの照らし）
function normalizeView(v, cols) {
  const repaired = [];
  const mark = (k) => () => { if (!repaired.includes(k)) repaired.push(k); };
  const src = isObj(v) ? v : (mark('view')(), {});
  for (const k of Object.keys(src)) if (!VIEW_KEYS.includes(k)) mark(k)();
  const byId = colMap(cols);
  const layout = src.layout === 'table' || src.layout === 'list' ? src.layout : (mark('layout')(), 'table');
  const id = typeof src.id === 'string' && ID_RE.test(src.id) ? src.id : (mark('id')(), 'v1');
  const out = defaultView(id, layout, cols);
  if (nameOk(src.name)) out.name = src.name; else mark('name')();
  // 列の表示・幅・折り返し（無い列・消した列・重なりは落とす。ビューに無い列は後ろに足す）
  if (src.props !== undefined) {
    if (!Array.isArray(src.props)) mark('props')();
    else {
      const props = [];
      const bad = mark('props');
      for (const p of src.props) {
        const col = isObj(p) ? byId.get(p.col) : null;
        if (!col || props.some((x) => x.col === p.col)) { bad(); continue; }
        const one = { col: p.col, show: true, wrap: false };
        if (p.show !== undefined) { if (typeof p.show === 'boolean') one.show = p.show; else bad(); }
        if (col.type === 'title' && !one.show) { one.show = true; bad(); }
        if (p.width !== undefined) { if (Number.isInteger(p.width) && p.width >= WIDTH_MIN && p.width <= WIDTH_MAX) one.width = p.width; else bad(); }
        if (p.wrap !== undefined) { if (typeof p.wrap === 'boolean') one.wrap = p.wrap; else bad(); }
        if (Object.keys(p).some((k) => !['col', 'show', 'width', 'wrap'].includes(k))) bad();
        props.push(one);
      }
      for (const d of out.props) if (!props.some((x) => x.col === d.col)) props.push(d);
      out.props = props;
    }
  }
  if (src.sort !== undefined) {
    const bad = mark('sort');
    if (!Array.isArray(src.sort)) bad();
    else {
      for (const s of src.sort) {
        if (!isObj(s) || !byId.has(s.col) || (s.dir !== 'asc' && s.dir !== 'desc') || Object.keys(s).length !== 2 || out.sort.some((x) => x.col === s.col)) { bad(); continue; }
        out.sort.push({ col: s.col, dir: s.dir });
      }
    }
  }
  if (src.filter !== undefined && src.filter !== null) out.filter = normGroup(src.filter, byId, 1, mark('filter'));
  if (src.group !== undefined && src.group !== null) out.group = normGroupBy(src.group, byId, mark('group'));
  if (src.agg !== undefined) {
    const bad = mark('agg');
    if (!isObj(src.agg)) bad();
    else {
      for (const [k, kind] of Object.entries(src.agg)) {
        if (!byId.has(k) || !AGG_KINDS(byId.get(k)).includes(kind)) { bad(); continue; }
        out.agg[k] = kind;
      }
    }
  }
  return { view: out, repaired };
}

// ---------------------------------------------------------------- ビューを当てる（決めたこと 30）
// rows（ゴミ箱でない行）→ { order: [{ id, depth, hasKids, g? }], groups: [{ key, count, hidden? }] | null, agg, total }
function applyView(rows, view, cols, opts = {}) {
  const byId = colMap(cols);
  const live = liveCols(cols);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let list = (Array.isArray(rows) ? rows : []).filter((r) => matchTree(view && view.filter, r, byId, now));
  const q = typeof opts.q === 'string' ? searchFold(opts.q) : '';
  if (q) list = list.filter((r) => searchFold(`${r.title || ''}\u0001${DM.foldCells(live, r.cells)}`).includes(q));
  // 並べ替え（重ねた列の順。同じなら並びの鍵）。並べ替えの無いビューは並びの鍵の順（手で並べる: 決めたこと 17）
  const sorts = (view && Array.isArray(view.sort) ? view.sort : []).map((s) => ({ col: byId.get(s.col), dir: s.dir })).filter((s) => s.col);
  if (sorts.length) {
    const keyed = list.map((r) => ({ r, k: sorts.map((s) => DM.cellValue(r, s.col)) }));
    keyed.sort((x, y) => {
      for (let i = 0; i < sorts.length; i += 1) {
        const c = compareCells(sorts[i].col, x.k[i], y.k[i], sorts[i].dir);
        if (c) return c;
      }
      return byOrd(x.r, y.r);
    });
    list = keyed.map((x) => x.r);
  } else {
    list = [...list].sort(byOrd);
  }
  // 集計は絞り込んだ後の行で数える
  const agg = {};
  for (const [k, kind] of Object.entries((view && view.agg) || {})) {
    const col = byId.get(k);
    if (col) agg[k] = aggregate(col, list.map((r) => DM.cellValue(r, col)), kind);
  }
  const g = view && view.group;
  const gcol = g ? byId.get(g.col) : null;
  if (!gcol) return { order: list.map((r) => ({ id: r.id, depth: 0, hasKids: false })), groups: null, agg, total: list.length };
  // グループ: 鍵ごとに行を分ける（複数選択とユーザーは、どの値のグループにも行が出る）
  const members = new Map();
  for (const r of list) {
    for (const k of groupKeys(gcol, g, DM.cellValue(r, gcol))) {
      if (!members.has(k)) members.set(k, []);
      members.get(k).push(r);
    }
  }
  const natural = naturalKeys(gcol, g, new Set(members.keys()));
  for (const k of members.keys()) if (!natural.includes(k)) natural.push(k);
  const manual = Array.isArray(g.order) ? g.order.filter((k) => natural.includes(k)) : [];
  const keys = [...manual, ...natural.filter((k) => !manual.includes(k))];
  const hide = new Set(Array.isArray(g.hide) ? g.hide : []);
  const groups = [];
  const order = [];
  for (const key of keys) {
    const rs = members.get(key) || [];
    if (g.hideEmpty && rs.length === 0) continue;
    const at = groups.length;
    if (hide.has(key)) { groups.push({ key, count: rs.length, hidden: true }); continue; }   // 隠したグループは数だけ（目のアイコン）
    groups.push({ key, count: rs.length });
    for (const r of rs) order.push({ id: r.id, depth: 0, hasKids: false, g: at });
  }
  return { order, groups, agg, total: list.length };
}

// ---------------------------------------------------------------- 見える行の切り出し（決めたこと 32）
// heights（Map か配列: 行の番号 → 読んだ高さ）・defaultHeight（まだ読んでいない行）・total（行の数）
// → { from, count, before（from より上の行の高さの和）, after（from + count から下の和） }
function windowOf({ scrollTop = 0, viewHeight = 0, heights, defaultHeight = 32, pad = 50, total = 0 } = {}) {
  const n = Math.max(0, Math.floor(total));
  if (n === 0) return { from: 0, count: 0, before: 0, after: 0 };
  const hOf = (i) => {
    const h = heights && (typeof heights.get === 'function' ? heights.get(i) : heights[i]);
    return Number.isFinite(h) && h > 0 ? h : defaultHeight;
  };
  const tops = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) tops[i + 1] = tops[i] + hOf(i);
  let first = -1;
  for (let i = 0; i < n; i += 1) if (tops[i + 1] > scrollTop) { first = i; break; }
  if (first < 0) first = n - 1;
  let last = first + 1;
  while (last < n && tops[last] < scrollTop + viewHeight) last += 1;
  const from = Math.max(0, first - pad);
  const end = Math.min(n, last + pad);
  return { from, count: end - from, before: tops[from], after: tops[n] - tops[end] };
}

module.exports = { FILTER_OPS, FILTER_DEPTH, GROUP_TYPES, AGG_KINDS, defaultView, normalizeView, matchFilter, compareCells, aggregate, applyView, windowOf };
