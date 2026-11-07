'use strict';
// データベースの列とセルの純粋な部品（0.16.0 Task DS-1。計画 docs/plans/2026-11-04-160.md の決めたこと 10〜14・29・52・55）。
// 列の種類の表 COLS を1か所に持ち、セルの値の照らし（cellOf）・種類の読み替え（convertCell）・見せる文字（fmtCell）・検索の欄の文字（foldCells）は
// どれもこの表から引く（後からロールアップと計算式を足せる形: 決めたこと 55）。DB の命令（src/db/commands.js）・画面の写し（app.html）・MCP が同じ部品を使う。
// 列の形: { id, name, type, gone?, …種類ごとの欄（opts・groups・fmt・db・back・prefix） }。題名の列は id 'title' で1つ。
// 行の形（この部品が読む形）: { id, ord, title, cells: { <列の ID>: 値 }, createdAt, updatedAt, by: { c, u }, no }。
// セルの値は照らした形だけを持ち、空のセルは欄ごと持たない（cellOf が null を返したら cells から消す: 決めたこと 10）。
// 形が違う値は code 'bad-args' の誤りを投げる（DB の命令はそのまま断る）。
const { COLORS } = require('./richText');

// 選択肢の色（既定と、0.14.0 の行の色の9色: J-21）
const OPT_COLORS = Object.freeze(['default', ...COLORS]);
const TEXT_MAX = 10000;     // テキストのセル（決めたこと 7）
const TITLE_MAX = 500;      // 題名（src/db/validate.js の LIMITS.title と同じ）
const URL_MAX = 2000;
const EMAIL_MAX = 254;
const PHONE_MAX = 30;
const PERSON_MAX = 10;      // 1つのセルの人の名前の数（決めたこと 10）
const PERSON_LEN = 50;
const REL_MAX = 100;        // 1つのリレーションのセルの行の数（決めたこと 7）
const OPT_MAX = 200;        // 1つの列の選択肢（決めたこと 7）
const OPT_NAME_MAX = 100;
const NAME_MAX = 100;       // 列の名前
const PREFIX_RE = /^[A-Za-z]{0,10}$/;
const NUM_FMTS = Object.freeze(['plain', 'comma', 'percent', 'yen', 'dollar']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;   // src/db/validate.js の ID_RE と同じ形
// 開ける URL（http(s) だけ: SEC2）。頭の後ろに1文字は要る。空白・制御の文字・向きを変える見えない文字は通さない
const URL_RE = /^https?:\/\/\S+$/i;
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const PHONE_RE = /^[0-9+\-\s()]+$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WHO = Object.freeze(['me', 'claude', 'system']);
const WHO_LABEL = Object.freeze({ me: '自分', claude: 'Claude', system: 'NaTsu' });   // 個人の版の見せ方（決めたこと 11）

function bad(why) { const e = new Error(`db: ${why}`); e.code = 'bad-args'; return e; }
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => v === null || v === undefined;
const oneLine = (s) => typeof s === 'string' && !CTRL_RE.test(s);
// 選択肢の名前の寄せ方（全角と半角・大文字小文字を同じに: J-20）
const optFold = (s) => String(s).normalize('NFKC').toLowerCase();

function realDay(s) {
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// ---------------------------------------------------------------- 値の照らし（種類ごと）
function textCell(max) {
  return (col, v) => {
    if (isEmpty(v) || v === '') return null;
    if (typeof v !== 'string') throw bad('text');
    if (v.length > max) throw bad('text-len');
    return v;
  };
}
function numberCell(col, v) {
  if (isEmpty(v)) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('number');
  return v;
}
const optById = (col, id) => (Array.isArray(col.opts) ? col.opts.find((o) => o && o.id === id) : undefined);
function oneOpt(col, v) {
  if (isEmpty(v) || v === '') return null;
  if (typeof v !== 'string' || !optById(col, v)) throw bad('select');
  return v;
}
function multiCell(col, v) {
  if (isEmpty(v)) return null;
  if (!Array.isArray(v)) throw bad('multi');
  if (v.length === 0) return null;
  if (new Set(v).size !== v.length) throw bad('multi-dup');
  for (const id of v) if (typeof id !== 'string' || !optById(col, id)) throw bad('multi');
  return [...v];
}
const DATE_KEYS = ['start', 'end', 'time', 'endTime'];
function dateCell(col, v) {
  if (isEmpty(v)) return null;
  if (!isObj(v) || Object.keys(v).some((k) => !DATE_KEYS.includes(k))) throw bad('date');
  if (!realDay(v.start)) throw bad('date');
  if (v.end !== undefined && !realDay(v.end)) throw bad('date');
  if (v.time !== undefined && !TIME_RE.test(v.time)) throw bad('date');
  if (v.endTime !== undefined && (v.time === undefined || !TIME_RE.test(v.endTime))) throw bad('date');
  const out = { start: v.start };
  if (v.end !== undefined) out.end = v.end;
  if (v.time !== undefined) out.time = v.time;
  if (v.endTime !== undefined) out.endTime = v.endTime;
  // 終わりは始まりより前にしない（同じ日なら時刻で見る）
  const from = `${out.start} ${out.time || '00:00'}`;
  const to = `${out.end || out.start} ${out.endTime || out.time || '00:00'}`;
  if (to < from) throw bad('date-order');
  return out;
}
function personCell(col, v) {
  if (isEmpty(v)) return null;
  if (!Array.isArray(v)) throw bad('person');
  if (v.length === 0) return null;
  if (v.length > PERSON_MAX) throw bad('person-max');
  for (const n of v) if (typeof n !== 'string' || !n.trim() || n !== n.trim() || n.length > PERSON_LEN || !oneLine(n)) throw bad('person');
  if (new Set(v).size !== v.length) throw bad('person-dup');
  return [...v];
}
function checkCell(col, v) {
  if (isEmpty(v)) return null;
  if (typeof v !== 'boolean') throw bad('check');
  return v ? true : null;   // 偽は空（欄を持たない）
}
function urlCell(col, v) {
  if (isEmpty(v) || v === '') return null;
  if (typeof v !== 'string' || v.length > URL_MAX || CTRL_RE.test(v) || !URL_RE.test(v)) throw bad('url');
  return v;
}
function emailCell(col, v) {
  if (isEmpty(v) || v === '') return null;
  if (typeof v !== 'string' || v.length > EMAIL_MAX || CTRL_RE.test(v) || !EMAIL_RE.test(v)) throw bad('email');
  return v;
}
function phoneCell(col, v) {
  if (isEmpty(v) || v === '') return null;
  if (typeof v !== 'string' || v.length > PHONE_MAX || !PHONE_RE.test(v) || !/\d/.test(v)) throw bad('phone');
  return v;
}
function relCell(col, v) {
  if (isEmpty(v)) return null;
  if (!Array.isArray(v)) throw bad('rel');
  if (v.length === 0) return null;
  if (v.length > REL_MAX) throw bad('rel-max');
  if (new Set(v).size !== v.length) throw bad('rel-dup');
  for (const id of v) if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('rel');
  return [...v];
}
const asIs = (col, v) => v;   // 書けない種類（作成日時など）。cellOf は writable を先に見る

// ---------------------------------------------------------------- 検索の欄の文字（決めたこと 6）
const optNames = (col, ids) => ids.map((id) => (optById(col, id) || {}).name).filter((n) => typeof n === 'string');
const noFold = () => '';
const strFold = (col, v) => (typeof v === 'string' ? v : '');

// ---------------------------------------------------------------- 既定の列の欄
const STATUS_DEFAULT = () => ({
  opts: [{ id: 'o1', name: '未着手', color: 'default' }, { id: 'o2', name: '進行中', color: 'blue' }, { id: 'o3', name: '完了', color: 'green' }],
  groups: { todo: ['o1'], doing: ['o2'], done: ['o3'] },
});
function optsOk(col) {
  if (!Array.isArray(col.opts) || col.opts.length > OPT_MAX) return false;
  const ids = new Set();
  const names = new Set();
  for (const o of col.opts) {
    if (!isObj(o) || typeof o.id !== 'string' || !ID_RE.test(o.id) || ids.has(o.id)) return false;
    if (!nameShapeOk(o.name, OPT_NAME_MAX) || /[,，]/.test(o.name) || names.has(optFold(o.name))) return false;
    if (!OPT_COLORS.includes(o.color)) return false;
    ids.add(o.id); names.add(optFold(o.name));
  }
  return true;
}
function statusOk(col) {
  if (!optsOk(col) || !isObj(col.groups)) return false;
  const seen = new Set();
  for (const g of ['todo', 'doing', 'done']) {
    if (!Array.isArray(col.groups[g])) return false;
    for (const id of col.groups[g]) { if (!optById(col, id) || seen.has(id)) return false; seen.add(id); }
  }
  return seen.size === col.opts.length && Object.keys(col.groups).length === 3;
}
const yes = () => true;

// 列の種類の表（決めたこと 10。label は画面の種類の名前）
const COLS = Object.freeze({
  title: { label: '題名', writable: true, defaults: () => ({}), check: yes, cell: textCell(TITLE_MAX), fold: strFold },
  text: { label: 'テキスト', writable: true, defaults: () => ({}), check: yes, cell: textCell(TEXT_MAX), fold: strFold },
  number: { label: '数値', writable: true, defaults: () => ({ fmt: 'plain' }), check: (c) => NUM_FMTS.includes(c.fmt), cell: numberCell, fold: noFold },
  select: { label: '選択', writable: true, defaults: () => ({ opts: [] }), check: optsOk, cell: oneOpt, fold: (c, v) => optNames(c, [v]).join(' ') },
  multi: { label: '複数選択', writable: true, defaults: () => ({ opts: [] }), check: optsOk, cell: multiCell, fold: (c, v) => (Array.isArray(v) ? optNames(c, v).join(' ') : '') },
  status: { label: 'ステータス', writable: true, defaults: STATUS_DEFAULT, check: statusOk, cell: oneOpt, fold: (c, v) => optNames(c, [v]).join(' ') },
  date: { label: '日付', writable: true, defaults: () => ({}), check: yes, cell: dateCell, fold: noFold },
  person: { label: 'ユーザー', writable: true, defaults: () => ({}), check: yes, cell: personCell, fold: noFold },
  check: { label: 'チェック', writable: true, defaults: () => ({}), check: yes, cell: checkCell, fold: noFold },
  url: { label: 'URL', writable: true, defaults: () => ({}), check: yes, cell: urlCell, fold: strFold },
  email: { label: 'メール', writable: true, defaults: () => ({}), check: yes, cell: emailCell, fold: strFold },
  phone: { label: '電話', writable: true, defaults: () => ({}), check: yes, cell: phoneCell, fold: strFold },
  rel: { label: 'リレーション', writable: true, defaults: () => ({ db: '' }), check: (c) => typeof c.db === 'string' && ID_RE.test(c.db) && (c.back === undefined || (typeof c.back === 'string' && ID_RE.test(c.back))), cell: relCell, fold: noFold },
  ctime: { label: '作成日時', writable: false, defaults: () => ({}), check: yes, cell: asIs, fold: noFold },
  mtime: { label: '最終更新日時', writable: false, defaults: () => ({}), check: yes, cell: asIs, fold: noFold },
  cby: { label: '作成者', writable: false, defaults: () => ({}), check: yes, cell: asIs, fold: noFold },
  mby: { label: '最終更新者', writable: false, defaults: () => ({}), check: yes, cell: asIs, fold: noFold },
  no: { label: 'ID', writable: false, defaults: () => ({ prefix: '' }), check: (c) => typeof c.prefix === 'string' && PREFIX_RE.test(c.prefix), cell: asIs, fold: noFold },
});
const TYPES = Object.freeze(Object.keys(COLS));
const OPT_TYPES = Object.freeze(['select', 'multi', 'status']);

function nameShapeOk(s, max) {
  return typeof s === 'string' && s.trim() !== '' && s === s.trim() && s.length <= max && oneLine(s);
}

// 列の形を照らす（id・名前・種類・種類ごとの欄）
function colOk(col) {
  if (!isObj(col) || typeof col.id !== 'string' || !ID_RE.test(col.id) || !Object.hasOwn(COLS, col.type)) return false;
  if ((col.id === 'title') !== (col.type === 'title')) return false;
  if (!nameShapeOk(col.name, NAME_MAX)) return false;
  if (col.gone !== undefined && col.gone !== true) return false;
  return Boolean(COLS[col.type].check(col));
}

// セルの値を照らす → 照らした値 | null（空）。形が違えば・書けない種類なら bad-args を投げる
function cellOf(col, v) {
  if (!isObj(col) || !Object.hasOwn(COLS, col.type)) throw bad('col');
  const def = COLS[col.type];
  if (!def.writable) throw bad('readonly');
  return def.cell(col, v);
}

// 行のその列の値（題名・作成日時などは行の欄から）
function cellValue(row, col) {
  if (!row || !col) return null;
  switch (col.type) {
    case 'title': return typeof row.title === 'string' && row.title !== '' ? row.title : null;
    case 'ctime': return row.createdAt || null;
    case 'mtime': return row.updatedAt || row.createdAt || null;
    case 'cby': return row.by && WHO.includes(row.by.c) ? row.by.c : null;
    case 'mby': return row.by && WHO.includes(row.by.u) ? row.by.u : (row.by && WHO.includes(row.by.c) ? row.by.c : null);
    case 'no': return Number.isSafeInteger(row.no) ? row.no : null;
    default: {
      const v = row.cells && Object.hasOwn(row.cells, col.id) ? row.cells[col.id] : null;
      return v === undefined ? null : v;
    }
  }
}

// ---------------------------------------------------------------- 選択肢と列を作る
// 選択肢の名前がよいか（1〜100 字・カンマなし・大文字小文字と全角半角を寄せて重ならない。exceptId はその選択肢自身を除く）
function optNameOk(opts, name, exceptId) {
  if (!nameShapeOk(name, OPT_NAME_MAX) || /[,，]/.test(name)) return false;
  const f = optFold(name);
  return !(Array.isArray(opts) ? opts : []).some((o) => o && o.id !== exceptId && optFold(o.name) === f);
}
// 次の ID（頭の字 + 数。今ある同じ頭の数の一番大きいものの次）
function nextId(head, ids) {
  let n = 0;
  for (const id of ids) {
    const m = new RegExp(`^${head}(\\d+)$`).exec(id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `${head}${n + 1}`;
}
// 選択肢を足した列 → { col, id }（名前がよくない・上限なら投げる）
function addOpt(col, name, color = 'default') {
  const opts = Array.isArray(col.opts) ? col.opts : [];
  if (!optNameOk(opts, name) || opts.length >= OPT_MAX || !OPT_COLORS.includes(color)) throw bad('opt');
  const id = nextId('o', opts.map((o) => o.id));
  return { col: { ...col, opts: [...opts, { id, name, color }] }, id };
}
// 新しい列（名前が重なれば「名前 2」。名前が無ければ種類の名前）
function newCol(type, name, cols) {
  if (!Object.hasOwn(COLS, type) || type === 'title') throw bad('col-type');
  const list = Array.isArray(cols) ? cols : [];
  const base = typeof name === 'string' && nameShapeOk(name, NAME_MAX) ? name : COLS[type].label;
  const used = new Set(list.map((c) => optFold(c.name)));
  let n = base; let k = 2;
  while (used.has(optFold(n))) { n = `${base} ${k}`; k += 1; }
  return { id: nextId('c', list.map((c) => c.id)), name: n, type, ...COLS[type].defaults() };
}

// ---------------------------------------------------------------- 種類の読み替え（決めたこと 13・52）
// 値を文字にする（読み替えのため。見せる文字と同じ）
function textOf(col, v) {
  if (isEmpty(v)) return '';
  return fmtCell(col, v, {});
}
// 文字を区切る（複数選択・ユーザー: 読点とカンマ）
const pieces = (s) => String(s).split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
// 数として読む（読める数だけ。全角は寄せ、3桁区切りのカンマは外す）
function parseNum(s) {
  const t = String(s).normalize('NFKC').trim().replace(/,/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
// 日付として読む（YYYY-MM-DD・YYYY/MM/DD と時刻 HH:MM の形だけ。「明日」などは読まない）
function parseDay(s) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(String(s).normalize('NFKC').trim());
  if (!m) return null;
  const day = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (!realDay(day)) return null;
  const out = { start: day };
  if (m[4] !== undefined) {
    const time = `${m[4].padStart(2, '0')}:${m[5]}`;
    if (!TIME_RE.test(time)) return null;
    out.time = time;
  }
  return out;
}
const TRUE_WORDS = ['はい', 'true', 'yes', 'y', '1', '✓', '✔', 'on'];
// 選択肢の名前 → ID（無ければ選択肢を足す。足せなければ null）
function optIdFor(state, name) {
  const f = optFold(name);
  const hit = (state.col.opts || []).find((o) => optFold(o.name) === f);
  if (hit) return hit.id;
  try { const r = addOpt(state.col, name); state.col = r.col; return r.id; } catch (_) { return null; }
}
// 文字を toCol の値に読む（state.col は選択肢を足した列）
function fromText(state, s) {
  const t = String(s ?? '').trim();
  if (t === '') return null;
  const to = state.col;
  switch (to.type) {
    case 'title': return t.replace(/\s*\n\s*/g, ' ').slice(0, TITLE_MAX);
    case 'text': return t.slice(0, TEXT_MAX);
    case 'number': return parseNum(t);
    case 'select': case 'status': { const p = pieces(t); return p.length ? optIdFor(state, p[0]) : null; }
    case 'multi': {
      const ids = [];
      for (const p of pieces(t)) { const id = optIdFor(state, p); if (id && !ids.includes(id)) ids.push(id); }
      return ids.length ? ids : null;
    }
    case 'person': {
      const ns = [...new Set(pieces(t).filter((n) => n.length <= PERSON_LEN && oneLine(n)))].slice(0, PERSON_MAX);
      return ns.length ? ns : null;
    }
    case 'date': return parseDay(t);
    case 'check': return TRUE_WORDS.includes(t.normalize('NFKC').toLowerCase()) ? true : null;
    default: {   // url・email・phone: 形が合うときだけ
      try { return COLS[to.type].cell(to, t); } catch (_) { return null; }
    }
  }
}
// fromCol の値 v を toCol の種類に読み替える → { value（null は空）, col（選択肢を足した toCol） }。
// リレーションへ・リレーションから・書けない種類へ・書けない種類から・題名の列は bad-args（決めたこと 13）
function convertCell(fromCol, toCol, v) {
  if (!isObj(fromCol) || !isObj(toCol) || !Object.hasOwn(COLS, fromCol.type) || !Object.hasOwn(COLS, toCol.type)) throw bad('col');
  if (!COLS[fromCol.type].writable || !COLS[toCol.type].writable) throw bad('convert-readonly');
  if ((fromCol.type === 'rel') !== (toCol.type === 'rel')) throw bad('convert-rel');
  const state = { col: toCol };
  if (isEmpty(v)) return { value: null, col: toCol };
  if (fromCol.type === toCol.type && fromCol.type !== 'select' && fromCol.type !== 'multi' && fromCol.type !== 'status') {
    try { return { value: COLS[toCol.type].cell(toCol, v), col: toCol }; } catch (_) { return { value: null, col: toCol }; }
  }
  if (toCol.type === 'number' && fromCol.type === 'check') return { value: v === true ? 1 : null, col: toCol };
  if (toCol.type === 'check' && fromCol.type === 'number') return { value: v !== 0 ? true : null, col: toCol };
  if (toCol.type === 'date' && fromCol.type === 'date') {
    try { return { value: dateCell(toCol, v), col: toCol }; } catch (_) { return { value: null, col: toCol }; }
  }
  // 選択肢の種類どうし・文字から: 名前で寄せる
  let names;
  if (OPT_TYPES.includes(fromCol.type)) names = optNames(fromCol, Array.isArray(v) ? v : [v]);
  else names = fromCol.type === 'person' && Array.isArray(v) ? v : null;
  const s = names ? names.join(', ') : textOf(fromCol, v);
  const value = fromText(state, s);
  return { value, col: state.col };
}

// ---------------------------------------------------------------- 見せる文字（画面と MCP: 決めたこと 11・14）
const pad2 = (n) => String(n).padStart(2, '0');
const slashDay = (d) => d.replace(/-/g, '/');
function fmtNumber(fmt, v) {
  const grouped = (x) => x.toLocaleString('en-US', { maximumFractionDigits: 10 });
  switch (fmt) {
    case 'comma': return grouped(v);
    case 'percent': return `${String(v)}%`;
    case 'yen': return `${v < 0 ? '-' : ''}¥${grouped(Math.abs(v))}`;
    case 'dollar': return `${v < 0 ? '-' : ''}$${grouped(Math.abs(v))}`;
    default: return String(v);
  }
}
function fmtTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// col の値 v の見せる文字（空は ''）。ctx.rowsById はリレーションの相手の行（{ title, trashed? }）
function fmtCell(col, v, ctx = {}) {
  if (isEmpty(v) || !isObj(col)) return '';
  switch (col.type) {
    case 'title': case 'text': case 'url': case 'email': case 'phone': return typeof v === 'string' ? v : '';
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? fmtNumber(col.fmt, v) : '';
    case 'select': case 'status': return optNames(col, [v]).join('');
    case 'multi': return Array.isArray(v) ? optNames(col, v).join(', ') : '';
    case 'person': return Array.isArray(v) ? v.join(', ') : '';
    case 'check': return v === true ? '✓' : '';
    case 'date': {
      if (!isObj(v) || typeof v.start !== 'string') return '';
      const a = `${slashDay(v.start)}${v.time ? ` ${v.time}` : ''}`;
      if (v.end === undefined && v.endTime === undefined) return a;
      const b = `${slashDay(v.end || v.start)}${v.endTime ? ` ${v.endTime}` : ''}`;
      return `${a} → ${b}`;
    }
    case 'rel': {
      const by = ctx.rowsById;
      if (!Array.isArray(v) || !by) return '';
      const get = (id) => (typeof by.get === 'function' ? by.get(id) : by[id]);
      return v.map(get).filter((r) => r && !r.trashed).map((r) => r.title || '無題のページ').join(', ');   // 無題の行は白紙のページと同じ名前（0.15.0 の blankUntitled）
    }
    case 'ctime': case 'mtime': return typeof v === 'string' ? fmtTimestamp(v) : '';
    case 'cby': case 'mby': return WHO_LABEL[v] || '';
    case 'no': return Number.isSafeInteger(v) ? (col.prefix ? `${col.prefix}-${v}` : String(v)) : '';
    default: return '';
  }
}

// 行の検索の欄に足す文字（テキスト・URL・メール・電話の文字と、選択肢の名前。題名は行の text が持つ: 決めたこと 6）
function foldCells(cols, cells) {
  if (!Array.isArray(cols) || !isObj(cells)) return '';
  const out = [];
  for (const c of cols) {
    if (!c || c.type === 'title' || !Object.hasOwn(cells, c.id) || !Object.hasOwn(COLS, c.type)) continue;
    const s = COLS[c.type].fold(c, cells[c.id]);
    if (s) out.push(s);
  }
  return out.join('\n');
}

module.exports = {
  COLS, TYPES, OPT_COLORS, NUM_FMTS, WHO, WHO_LABEL,
  LIMITS: Object.freeze({ TEXT_MAX, TITLE_MAX, URL_MAX, EMAIL_MAX, PHONE_MAX, PERSON_MAX, PERSON_LEN, REL_MAX, OPT_MAX, OPT_NAME_MAX, NAME_MAX }),
  cellOf, cellValue, colOk, convertCell, newCol, addOpt, optNameOk, fmtCell, foldCells, parseNum, parseDay, optFold,
};
