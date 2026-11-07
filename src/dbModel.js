'use strict';
// データベースの列とセルの純粋な部品（0.16.0 Task DS-1。計画 docs/plans/2026-11-04-160.md の決めたこと 6・7・10〜14・R2・R7・R8）。
// 2026-11-07 にテスト（test/stage160.lib.test.js）と計画だけから書き直した（持ち主の答え「決まりどおり、テストから書き直す」: R11）。
// 何も書かない・何も読みに行かない。列の種類ごとの照らし・読み替え・見せ方・検索の欄を、この1か所に持つ（決めたこと 10・55）。
//
// 列の形: { id, name, type, gone?: true, …種類ごとの欄 }
//   id は題名の列だけ 'title'（種類 title はこの ID だけ）。ほかは c<数>（newCol が作る）。name は 1〜100 字・前後に空白なし・制御の文字なし。
//   種類ごとの欄: number { fmt: plain|comma|percent|yen|dollar }・select／multi { opts }・status { opts, groups: { todo, doing, done } }・
//   rel { db, back? }・no { prefix?: 英字 10 字まで }。選択肢は { id: o<数>, name, color }（OPT_COLORS の 10 色）。
// 行の形（dbView と画面が読む写し）: { id, ord, title, cells: { <列の ID>: 値 }, createdAt, updatedAt, by: { c, u }, no, trashed? }
//   cells に空の値を残さない（空は欄ごと消す: 決めたこと 10）。チェックの偽も空（R6）。
// 投げる誤りは code 'bad-args'（DB の命令の断りと同じ名前）。

// ================================================================ 表
const TYPES = Object.freeze(['title', 'text', 'number', 'select', 'multi', 'status', 'date', 'person', 'check', 'url', 'email', 'phone', 'rel', 'ctime', 'mtime', 'cby', 'mby', 'no']);
const OPT_COLORS = Object.freeze(['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']);
const NUM_FMTS = Object.freeze(['plain', 'comma', 'percent', 'yen', 'dollar']);
const WHO = Object.freeze(['me', 'claude', 'system']);            // 作成者・最終更新者の値（並べ替えもこの順: 決めたこと 11）
const STATUS_GROUPS = Object.freeze(['todo', 'doing', 'done']);
const OPT_TYPES = Object.freeze(['select', 'multi', 'status']);
const MAX = Object.freeze({
  text: 10000, title: 500, url: 2000, email: 254, phone: 30,    // 決めたこと 7・10（題名は今のページの題名と同じ 500 字: validate の LIMITS.title）
  people: 10, personName: 50, rel: 100, opts: 200, optName: 100, colName: 100,
});

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;                            // 行・データベースの ID（src/db/validate.js の ID の形と同じ）
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const PREFIX_RE = /^[A-Za-z]{0,10}$/;
const PHONE_RE = /^[0-9+\-() ]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const OPT_COMMA_RE = /[,，]/;                                       // 選択肢の名前に入れない（J-20）
const NAME_SPLIT_RE = /[、,，]/;                                    // 文字 → 複数選択・ユーザーの区切り（R7）
// 名前と住所に入れない文字: 制御の文字・書式の文字（幅の無い文字・向きの制御の文字・ソフトハイフンなど \p{Cf}）・行と段落の区切り・
// 見えない文字と空に見える文字（結合の書記素の結び・ハングルの空き・点字の空き・異体字の選び）（F145: 答えと画面の形を偽らせない。DS-1 直し F7）
const UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034f\u115f\u1160\u180e\u2800\u3164\uffa0\ufe00-\ufe0f]/u;
// 名前（列・選択肢・人）では、絵文字の後の異体字の選び（U+FE0F）と、絵文字どうしをつなぐ U+200D だけは通す（❤️・👩‍💻）
const EMOJI_JOIN_RE = /(\p{Extended_Pictographic})\ufe0f|(\p{Extended_Pictographic}\ufe0f?)\u200d(?=\p{Extended_Pictographic})/gu;
const nameUnsafe = (s) => UNSAFE_RE.test(s.replace(EMOJI_JOIN_RE, (m, a, b) => a || b));

function fail(why) { const e = new Error(why); e.code = 'bad-args'; return e; }
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const missing = (v) => v === null || v === undefined;
const isBlank = (v) => missing(v) || v === '' || v === false || (Array.isArray(v) && v.length === 0);
const has = (o, k) => isObj(o) && Object.hasOwn(o, k);
// 名前の寄せ方（大文字小文字と全角半角: J-20）
const foldName = (s) => String(s).normalize('NFKC').toLowerCase();
const nameOk = (s, max) => typeof s === 'string' && s.length >= 1 && s.length <= max && s === s.trim() && !nameUnsafe(s);
const optOf = (col, id) => (Array.isArray(col.opts) ? col.opts.find((o) => isObj(o) && o.id === id) : undefined);
// 頭の文字と数の ID（o<数>・c<数>）の、今ある一番大きい数の次（R2）
function nextId(head, ids) {
  const re = new RegExp(`^${head}(\\d{1,9})$`);
  let top = 0;
  for (const id of ids) { const m = typeof id === 'string' && re.exec(id); if (m) top = Math.max(top, Number(m[1])); }
  return `${head}${top + 1}`;
}

// ---------------------------------------------------------------- 日と時刻
function realDay(s) {
  const m = typeof s === 'string' && DAY_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (y < 1000 || mo < 1 || mo > 12 || d < 1) return false;   // 年は 1000〜9999（4 桁: DS-1 直し F5）
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= days;
}
const realTime = (s) => typeof s === 'string' && TIME_RE.test(s);

// ---------------------------------------------------------------- 住所・メール・電話の形
const HTTP_HEAD_RE = /^https?:\/\//i;                              // SEC2: 住所の頭は http(s) だけ（javascript:・file:・data: を通さない。頭を見るのはここ1か所）
function httpUrlOk(s) {
  if (s.length > MAX.url || /\s/.test(s) || UNSAFE_RE.test(s) || !HTTP_HEAD_RE.test(s)) return false;
  let u;
  try { u = new URL(s); } catch (_) { return false; }                 // 「https://」だけ・壊れた住所を断る
  return u.username === '' && u.password === '';                       // 利用者の欄（https://見せたい名前@本当の住所）で見た目を偽らせない（DS-1 直し F13）
}
const emailOk = (s) => s.length <= MAX.email && EMAIL_RE.test(s) && !UNSAFE_RE.test(s);
const phoneOk = (s) => s.length <= MAX.phone && PHONE_RE.test(s) && /\d/.test(s);

// ================================================================ セルの照らし（種類ごと。空は undefined を返す）
function textCell(max, okFn) {
  return (col, v) => {
    if (missing(v) || v === '') return undefined;
    if (typeof v !== 'string') throw fail('cell-not-text');
    if (okFn) { if (!okFn(v)) throw fail(`cell-${col.type}`); return v; }
    if (v.length > max) throw fail('cell-too-long');
    return v;
  };
}
function numberCell(col, v) {
  if (missing(v)) return undefined;
  if (!Number.isFinite(v)) throw fail('cell-not-number');   // 文字の '12'・NaN・Infinity・真偽を断る（Number.isFinite は型を変えない）
  return v === 0 ? 0 : v;
}
function optionCell(col, v) {
  if (missing(v) || v === '') return undefined;
  const known = typeof v === 'string' && optOf(col, v) !== undefined;
  if (!known) throw fail('cell-option');
  return v;
}
function optionsCell(col, v) {
  if (missing(v)) return undefined;
  if (!Array.isArray(v)) throw fail('cell-not-list');
  if (v.length === 0) return undefined;
  if (v.length > MAX.opts || new Set(v).size !== v.length) throw fail('cell-options');
  for (const id of v) if (typeof id !== 'string' || optOf(col, id) === undefined) throw fail('cell-option');
  return [...v];
}
const DATE_KEYS = Object.freeze(['start', 'end', 'time', 'endTime']);
function dateCell(col, v) {
  if (missing(v)) return undefined;
  if (!isObj(v) || Object.keys(v).some((k) => !DATE_KEYS.includes(k))) throw fail('cell-date');
  if (!realDay(v.start)) throw fail('cell-date-start');
  const out = { start: v.start };
  if (v.time !== undefined) { if (!realTime(v.time)) throw fail('cell-date-time'); out.time = v.time; }
  if (v.end !== undefined) { if (!realDay(v.end)) throw fail('cell-date-end'); out.end = v.end; }
  if (v.endTime !== undefined) {
    if (out.time === undefined || !realTime(v.endTime)) throw fail('cell-date-end-time');   // 始まりの時刻の無い終わりの時刻は断る
    out.endTime = v.endTime;
  }
  const lastDay = out.end === undefined ? out.start : out.end;
  if (lastDay < out.start) throw fail('cell-date-backwards');
  if (lastDay === out.start && out.endTime !== undefined && out.endTime < out.time) throw fail('cell-time-backwards');
  return out;
}
function peopleCell(col, v) {
  if (missing(v)) return undefined;
  if (!Array.isArray(v)) throw fail('cell-not-list');
  if (v.length === 0) return undefined;
  if (v.length > MAX.people || new Set(v).size !== v.length || !v.every((s) => nameOk(s, MAX.personName))) throw fail('cell-people');
  return [...v];
}
function checkCell(col, v) {
  if (v === true) return true;
  if (missing(v) || v === false) return undefined;          // 偽は空（R6）
  throw fail('cell-not-check');
}
function relCell(col, v) {
  if (missing(v)) return undefined;
  if (!Array.isArray(v)) throw fail('cell-not-list');
  if (v.length === 0) return undefined;
  if (v.length > MAX.rel || new Set(v).size !== v.length || !v.every((id) => typeof id === 'string' && ID_RE.test(id))) throw fail('cell-rel');
  return [...v];
}

// ---------------------------------------------------------------- 列の欄の照らし（種類ごと）
function optsOk(col) {
  const opts = col.opts;
  if (!Array.isArray(opts) || opts.length > MAX.opts) return false;
  const ids = new Set();
  const names = new Set();
  for (const o of opts) {
    if (!isObj(o) || Object.keys(o).length !== 3 || !/^o\d{1,9}$/.test(o.id) || ids.has(o.id)) return false;
    if (!nameOk(o.name, MAX.optName) || OPT_COMMA_RE.test(o.name) || names.has(foldName(o.name))) return false;
    if (!OPT_COLORS.includes(o.color)) return false;
    ids.add(o.id); names.add(foldName(o.name));
  }
  return true;
}
function statusOk(col) {
  if (!optsOk(col) || !isObj(col.groups)) return false;
  const g = col.groups;
  if (Object.keys(g).length !== STATUS_GROUPS.length || !STATUS_GROUPS.every((k) => Array.isArray(g[k]))) return false;
  const placed = STATUS_GROUPS.flatMap((k) => g[k]);
  // どの選択肢もちょうど1つのまとまりに入る
  return placed.length === col.opts.length && new Set(placed).size === placed.length && placed.every((id) => optOf(col, id) !== undefined);
}

// ---------------------------------------------------------------- 列の種類の表（label は列のメニューの［種類 ▸］の名前: 決めたこと 10 の表の左の列）
const always = () => true;
const noFold = () => '';
const textFold = (col, v) => (typeof v === 'string' ? v : '');
const optFold = (col, v) => { const o = optOf(col, v); return o ? o.name : ''; };
const optsFold = (col, v) => (Array.isArray(v) ? v.map((id) => optFold(col, id)).filter(Boolean).join('\n') : '');
const statusDefaults = () => ({
  opts: [{ id: 'o1', name: '未着手', color: 'default' }, { id: 'o2', name: '進行中', color: 'blue' }, { id: 'o3', name: '完了', color: 'green' }],
  groups: { todo: ['o1'], doing: ['o2'], done: ['o3'] },
});
const kind = (label, cell, more = {}) => Object.freeze({
  label, writable: cell !== null, cell, keys: [], defaults: () => ({}), check: always, fold: noFold, ...more,
});
const COLS = Object.freeze({
  title: kind('題名', textCell(MAX.title)),
  text: kind('テキスト', textCell(MAX.text), { fold: textFold }),
  number: kind('数値', numberCell, { keys: ['fmt'], defaults: () => ({ fmt: 'plain' }), check: (c) => c.fmt === undefined || NUM_FMTS.includes(c.fmt) }),
  select: kind('選択', optionCell, { keys: ['opts'], defaults: () => ({ opts: [] }), check: optsOk, fold: optFold }),
  multi: kind('複数選択', optionsCell, { keys: ['opts'], defaults: () => ({ opts: [] }), check: optsOk, fold: optsFold }),
  status: kind('ステータス', optionCell, { keys: ['opts', 'groups'], defaults: statusDefaults, check: statusOk, fold: optFold }),
  date: kind('日付', dateCell),
  person: kind('ユーザー', peopleCell),
  check: kind('チェック', checkCell),
  url: kind('URL', textCell(MAX.url, httpUrlOk), { fold: textFold }),
  email: kind('メール', textCell(MAX.email, emailOk), { fold: textFold }),
  phone: kind('電話', textCell(MAX.phone, phoneOk), { fold: textFold }),
  rel: kind('リレーション', relCell, {
    keys: ['db', 'back'],
    check: (c) => typeof c.db === 'string' && ID_RE.test(c.db) && (c.back === undefined || (typeof c.back === 'string' && ID_RE.test(c.back))),
  }),
  // 書けない種類（行の欄から読む: cellValue）
  ctime: kind('作成日時', null),
  mtime: kind('最終更新日時', null),
  cby: kind('作成者', null),
  mby: kind('最終更新者', null),
  no: kind('ID', null, { keys: ['prefix'], check: (c) => c.prefix === undefined || (typeof c.prefix === 'string' && PREFIX_RE.test(c.prefix)) }),
});
const defOf = (col) => (isObj(col) && typeof col.type === 'string' && Object.hasOwn(COLS, col.type) ? COLS[col.type] : null);

// 列の形がよいか（決めたこと 10 の表）
function colOk(col) {
  const def = defOf(col);
  if (!def || typeof col.id !== 'string' || !ID_RE.test(col.id)) return false;
  if ((col.id === 'title') !== (col.type === 'title')) return false;
  if (!nameOk(col.name, MAX.colName)) return false;
  if (col.gone !== undefined && (col.gone !== true || col.type === 'title')) return false;   // gone は true だけ。題名の列は消せない
  const allowed = ['id', 'name', 'type', 'gone', ...def.keys];
  if (Object.keys(col).some((k) => !allowed.includes(k))) return false;
  return def.check(col);
}

// セルの値を照らす → 照らした値 | null（空） | 投げる（bad-args）
function cellOf(col, v) {
  const def = defOf(col);
  if (!def) throw fail('col-type');
  if (def.writable === false) throw fail('col-read-only');
  const out = def.cell(col, v);
  return out === undefined ? null : out;
}

// ================================================================ 選択肢と列を足す
// 選択肢の名前がよいか（1〜100 字・前後に空白なし・カンマなし・大文字小文字と全角半角を寄せて重ならない。exceptId は名前を変える選択肢自身）
function optNameOk(opts, name, exceptId) {
  if (!nameOk(name, MAX.optName) || OPT_COMMA_RE.test(name)) return false;
  const want = foldName(name);
  const others = (Array.isArray(opts) ? opts : []).filter((o) => isObj(o) && o.id !== exceptId);
  return others.every((o) => foldName(o.name) !== want);
}
// 選択肢を足した列の写し → { id, col }（もとの列は変えない。ステータスの新しい選択肢は「未着手」のまとまりに入れる）
function addOpt(col, name, color = 'default') {
  if (!isObj(col) || !OPT_TYPES.includes(col.type)) throw fail('col-no-options');
  const opts = Array.isArray(col.opts) ? col.opts : [];
  if (opts.length >= MAX.opts) throw fail('too-many-options');
  if (!optNameOk(opts, name)) throw fail('option-name');
  if (!OPT_COLORS.includes(color)) throw fail('option-color');
  const id = nextId('o', opts.map((o) => o && o.id));
  const out = { ...col, opts: [...opts, { id, name, color }] };
  if (col.type === 'status') {
    const g = isObj(col.groups) ? col.groups : {};
    out.groups = {};
    for (const k of STATUS_GROUPS) out.groups[k] = Array.isArray(g[k]) ? [...g[k]] : [];
    out.groups.todo.push(id);
  }
  return { id, col: out };
}
// 新しい列 → { id: c<数>, name, type, …既定 }（名前が空なら種類の名前・重なれば「名前 2」「名前 3」…。題名の列は足せない）
function newCol(type, name, cols) {
  if (typeof type !== 'string' || !Object.hasOwn(COLS, type) || type === 'title') throw fail('col-type');
  if (!missing(name) && typeof name !== 'string') throw fail('col-name');
  const list = Array.isArray(cols) ? cols.filter(isObj) : [];
  const base = (name || '').trim() || COLS[type].label;
  if (!nameOk(base, MAX.colName)) throw fail('col-name');
  const taken = new Set(list.map((c) => (typeof c.name === 'string' ? foldName(c.name) : '')));
  let pick = base;
  for (let n = 2; taken.has(foldName(pick)); n += 1) {
    const tail = ` ${n}`;
    pick = `${base.slice(0, MAX.colName - tail.length).trimEnd()}${tail}`;
  }
  return { id: nextId('c', list.map((c) => c.id)), name: pick, type, ...COLS[type].defaults() };
}

// ================================================================ 種類の読み替え（決めたこと 13・52・R2・R7）
const TRUE_WORDS = Object.freeze(['はい', 'true', 'yes', 'y', '1', '✓', 'on']);   // テキスト → チェックで真にする語（R7。大文字小文字を寄せる）
const THOUSANDS_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;   // 指数の形（1e+21・1e-7: 数を文字にした形）も読む（DS-1 直し F9）
const DATE_TEXT_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/;

// 文字 → 数（全角を寄せ、3桁区切りのカンマを外した数だけ。読めなければ null）
function readNumber(s) {
  let t = String(s).normalize('NFKC').replace(/\u2212/g, '-').trim();
  if (THOUSANDS_RE.test(t)) t = t.replace(/,/g, '');
  const n = DECIMAL_RE.test(t) ? Number(t) : NaN;
  return Number.isFinite(n) ? n : null;
}
// 文字 → 日付（YYYY-MM-DD・YYYY/MM/DD と HH:MM の形だけ。推し量らない: 決めたこと 14）
function readDate(s) {
  const m = DATE_TEXT_RE.exec(String(s).normalize('NFKC').trim());
  if (!m) return null;
  const p2 = (x) => x.padStart(2, '0');
  const out = { start: `${m[1]}-${p2(m[2])}-${p2(m[3])}` };
  if (m[4] !== undefined) out.time = `${p2(m[4])}:${m[5]}`;
  return realDay(out.start) && (out.time === undefined || realTime(out.time)) ? out : null;
}
const splitNames = (s) => String(s).split(NAME_SPLIT_RE).map((x) => x.trim()).filter(Boolean);
// もとの値の文字（テキストへの読み替え。日付とチェックは見せる文字と同じ形）
function plainOf(col, v) {
  switch (col.type) {
    case 'number': return String(v);
    case 'select': case 'status': return optFold(col, v);
    case 'multi': return v.map((id) => optFold(col, id)).filter(Boolean).join(SHOW.join);
    case 'person': return v.join(SHOW.join);
    case 'date': return showDate(v);
    case 'check': return SHOW.check;
    default: return v;   // 題名・テキスト・URL・メール・電話
  }
}
// もとの値の名前の並び（選択肢の種類とユーザーへの読み替え）
function namesOf(col, v) {
  if (col.type === 'multi') return v.map((id) => optFold(col, id)).filter(Boolean);
  if (col.type === 'select' || col.type === 'status') return [optFold(col, v)].filter(Boolean);
  if (col.type === 'person') return [...v];
  return splitNames(plainOf(col, v));
}
// 名前 → 選択肢の ID（名前で寄せる。無ければ足す。足せなければ null）
function optionFor(col, name) {
  const want = foldName(name);
  const hit = (col.opts || []).find((o) => isObj(o) && foldName(o.name) === want);
  if (hit) return { id: hit.id, col };
  if ((col.opts || []).length >= MAX.opts || !optNameOk(col.opts, name)) return null;
  return addOpt(col, name);
}
const tryCell = (col, v) => { try { return cellOf(col, v); } catch (_) { return null; } };

// fromCol の値 v を toCol の種類に読み替える → { value（照らした値 | null）, col（選択肢を足したなら足した toCol の写し。でなければ toCol） }
// リレーションへ・から、書けない種類へ・からは投げる（決めたこと 13）。読めない値は空（null）。もとの列は変えない。
function convertCell(fromCol, toCol, v) {
  const fd = defOf(fromCol); const td = defOf(toCol);
  if (!fd || !td) throw fail('col-type');
  if (!fd.writable || !td.writable) throw fail('col-read-only');
  if (fromCol.type === 'rel' && toCol.type === 'rel') return { value: tryCell(toCol, v), col: toCol };   // リレーションどうしは値のまま（DS-1 直し F11）
  if (fromCol.type === 'rel' || toCol.type === 'rel') throw fail('col-rel');
  // 消えた選択肢の ID は外して、分かる名前だけを読み替える（DS-1 直し F8）
  const known = fromCol.type === 'multi' && Array.isArray(v) ? v.filter((id) => optOf(fromCol, id) !== undefined) : v;
  const src = tryCell(fromCol, known);
  if (src === null) return { value: null, col: toCol };
  const from = fromCol.type;
  switch (toCol.type) {
    case 'number': return { value: from === 'number' ? src : readNumber(plainOf(fromCol, src)), col: toCol };
    case 'check': {
      const word = foldName(plainOf(fromCol, src)).trim();
      return { value: TRUE_WORDS.includes(word) ? true : null, col: toCol };
    }
    case 'date': return { value: from === 'date' ? { ...src } : readDate(plainOf(fromCol, src)), col: toCol };
    case 'person': {
      const names = [...new Set(namesOf(fromCol, src))].filter((s) => nameOk(s, MAX.personName)).slice(0, MAX.people);
      return { value: names.length ? names : null, col: toCol };
    }
    case 'select': case 'status': {
      const first = namesOf(fromCol, src)[0];
      const got = first === undefined ? null : optionFor(toCol, first);
      return got ? { value: got.id, col: got.col } : { value: null, col: toCol };
    }
    case 'multi': {
      let col = toCol;
      const ids = [];
      for (const name of namesOf(fromCol, src)) {
        const got = optionFor(col, name);
        if (!got) continue;
        col = got.col;
        if (!ids.includes(got.id)) ids.push(got.id);
      }
      return { value: ids.length ? ids : null, col };
    }
    case 'url': case 'email': case 'phone': return { value: tryCell(toCol, String(plainOf(fromCol, src)).trim()), col: toCol };
    default: return { value: tryCell(toCol, plainOf(fromCol, src)), col: toCol };   // 題名・テキスト
  }
}

// ================================================================ 見せる文字（R8。持ち主が 2026-11-07 に承認した形。見せ方を変えるときはこの節だけを直す）
// 画面のセル・行のページのプロパティ・MCP の答えが同じ文字を使う。
const SHOW = Object.freeze({
  untitled: '無題のページ',                                        // 無題の行（白紙のページの「無題のページ」と同じ）
  check: '✓',                                                      // チェック済み
  join: ', ',                                                       // 複数選択・ユーザー・リレーションのつなぎ
  arrow: ' → ',                                                     // 日付の期間
  noJoin: '-',                                                      // ID の接頭辞と番号の間（TASK-12）
  who: Object.freeze({ me: '自分', claude: 'Claude', system: 'NaTsu' }),   // 作成者・最終更新者（決めたこと 11）
  yen: '¥',
  dollar: '$',
  percent: '%',
});
const pad2 = (n) => String(n).padStart(2, '0');
const showDay = (day) => day.replace(/-/g, '/');                    // 2026-11-04 → 2026/11/04
// 日付 → 「2026/11/04」「2026/11/04 10:00」「2026/11/04 → 2026/11/08」（同じ日の終わりの時刻は「2026/11/04 10:00 → 11:00」）
function showDate(v) {
  let s = showDay(v.start) + (v.time ? ` ${v.time}` : '');
  if (v.end && v.end !== v.start) s += SHOW.arrow + showDay(v.end) + (v.endTime ? ` ${v.endTime}` : '');
  else if (v.endTime) s += SHOW.arrow + v.endTime;
  return s;
}
// 作成日時・最終更新日時（ISO の文字）→ その PC の時刻の「2026/11/04 10:00」
function showStamp(iso) {
  const d = new Date(iso);
  if (typeof iso !== 'string' || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// 数の3桁区切り（打った数のまま。丸めない）: 1234567.5 → 1,234,567.5
function grouped(n) {
  const s = String(Math.abs(n));
  if (/e/i.test(s)) return String(n);
  const [whole, frac] = s.split('.');
  return (n < 0 ? '-' : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
}
const money = (sign, n) => (n < 0 ? '-' : '') + sign + grouped(Math.abs(n));   // ¥1,200・-$5.25
const SHOW_NUMBER = Object.freeze({
  plain: (n) => String(n),
  comma: grouped,
  percent: (n) => `${String(n)}${SHOW.percent}`,                    // 打った数のまま（100 倍しない）
  yen: (n) => money(SHOW.yen, n),
  dollar: (n) => money(SHOW.dollar, n),
});
function lookupRow(rowsById, id) {
  if (!rowsById) return undefined;
  if (typeof rowsById.get === 'function') return rowsById.get(id);
  return Object.hasOwn(rowsById, id) ? rowsById[id] : undefined;
}
// リレーションの相手の行の題名（無い行・ゴミ箱の行は出さない。無題は「無題のページ」）
function relTitles(ids, rowsById) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const r = lookupRow(rowsById, id);
    if (!isObj(r) || r.trashed) continue;
    out.push(typeof r.title === 'string' && r.title !== '' ? r.title : SHOW.untitled);
  }
  return out;
}
// セルの見せる文字（opts.rowsById: リレーションの相手の行 ID → { title, trashed? } の Map か物）
function fmtCell(col, v, opts) {
  const def = defOf(col);
  if (!def) return '';
  if (col.type === 'title') return typeof v === 'string' && v !== '' ? v : SHOW.untitled;
  if (isBlank(v)) return '';
  switch (col.type) {
    case 'text': case 'url': case 'email': case 'phone': return typeof v === 'string' ? v : '';
    case 'number': return Number.isFinite(v) ? (SHOW_NUMBER[col.fmt] || SHOW_NUMBER.plain)(v) : '';
    case 'select': case 'status': return optFold(col, v);
    case 'multi': return Array.isArray(v) ? v.map((id) => optFold(col, id)).filter(Boolean).join(SHOW.join) : '';
    case 'person': return Array.isArray(v) ? v.join(SHOW.join) : '';
    case 'date': return isObj(v) && typeof v.start === 'string' ? showDate(v) : '';
    case 'check': return v === true ? SHOW.check : '';
    case 'ctime': case 'mtime': return showStamp(v);
    case 'cby': case 'mby': return has(SHOW.who, v) ? SHOW.who[v] : '';
    case 'no': return Number.isFinite(v) ? (col.prefix ? `${col.prefix}${SHOW.noJoin}${v}` : String(v)) : '';
    case 'rel': return relTitles(v, opts && opts.rowsById).join(SHOW.join);
    default: return '';
  }
}

// ================================================================ 検索の欄と行の値
// 行の fold に足す文字（決めたこと 6: テキスト・URL・メール・電話の文字と、選択・複数選択・ステータスの選択肢の名前。1つ1行。消した列は入れない）
function foldCells(cols, cells) {
  const lines = [];
  for (const col of Array.isArray(cols) ? cols : []) {
    const def = defOf(col);
    if (!def || col.gone || !has(cells, col.id) || isBlank(cells[col.id])) continue;
    const s = def.fold(col, cells[col.id]);
    if (s) lines.push(s);
  }
  return lines.join('\n');
}
// 行の、その列の値（題名・作成日時・最終更新日時・作成者・最終更新者・ID は行の欄から。空は null）
function cellValue(row, col) {
  if (!isObj(row) || !isObj(col)) return null;
  switch (col.type) {
    case 'title': return typeof row.title === 'string' && row.title !== '' ? row.title : null;
    case 'ctime': return typeof row.createdAt === 'string' ? row.createdAt : null;
    case 'mtime': return typeof row.updatedAt === 'string' ? row.updatedAt : (typeof row.createdAt === 'string' ? row.createdAt : null);   // 書き換えていなければ作成日時（DS-1 直し F11）
    case 'cby': return isObj(row.by) && WHO.includes(row.by.c) ? row.by.c : null;
    case 'mby': return isObj(row.by) && WHO.includes(row.by.u) ? row.by.u : (isObj(row.by) && WHO.includes(row.by.c) ? row.by.c : null);   // 書き換えていなければ作成者
    case 'no': return Number.isFinite(row.no) ? row.no : null;
    default: return has(row.cells, col.id) && !missing(row.cells[col.id]) ? row.cells[col.id] : null;
  }
}

module.exports = {
  TYPES, COLS, OPT_COLORS, NUM_FMTS, WHO, STATUS_GROUPS, MAX,
  colOk, cellOf, optNameOk, addOpt, newCol, convertCell, fmtCell, foldCells, cellValue,
};
