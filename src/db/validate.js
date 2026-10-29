/*
 * validate.js — 議事録の DB の命令の引数を照らす（第2a1回 ST4。純粋。第15回の MCP の道具と後の shared/api-schema.js でも使う）
 *
 * checkArgs(spec, args) は、命令の表の1行の args（spec）に照らして、引数の形・ID の形・長さ・件数・1つの頼みの大きさ・
 * attrs の決まった名前・rich の飾りとリンクを見る。spec は { 引数の名前: 型 }。型の名前の末尾に '?' があれば無くてよい。
 * 型は下の TYPES の名前か、(値) → 真偽 の関数。spec に無い引数は断る（知らない欄を黙って通さない）。
 * 通れば { ok: true, args }（ブロックは normalizeBlock で rich から text を作り直した写し）、だめなら { ok: false, field }。
 * field は引数の名前だけ（値やパスは入れない）。
 */
'use strict';
const mtype = require('../meetingType');
const blockEdit = require('../blockEdit');
const RT = require('../richText');   // 0.14.0 EB-1: リンクの頭の表（R73）

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;      // 今の ID（p…・b…・s<n>・テストの p1）を全部通し、区切り・点・空白は通さない
const TX_RE = /^[A-Za-z0-9:_.-]{8,120}$/;
// 件数・1つの頼みの大きさ・文字の長さ。segments は計画の 500 から 5000 に変えた（区間の長さは最短 20 秒なので、500 では
// 2 時間 46 分より長い会議の締め・復旧が DB に入らない。大きさは 1MB の上限が別に押さえる）
const LIMITS = { blocks: 2000, segments: 5000, bytes: 1024 * 1024, text: 100000, title: 500 };
const RESERVED_BLOCK = ['id', 'type', 'text', 'rich', 'children'];
const RESERVED_PAGE = ['id', 'title', 'blocks', 'createdAt', 'updatedAt', 'children', 'type', 'text', 'rich'];
const RESERVED_SEG = ['id', 'atMs', 'durationMs', 'text', 'failed'];
const RICH_MARKS = ['b', 'i', 'u', 's', 'code', 'color', 'bg', 'link'];   // 2b の飾り（2a1 では照らしだけ）
// 0.14.0 EB-1（R73）: リンクの頭は src/richText.js の linkOk と同じ表（http(s)://・mailto:・natsu://page/）。制御の文字と前後の空白は別の条件で断る
const LINK_RE = RT.LINK_HEAD_RE;
const COLOR_KINDS = ['color', 'bg'];   // 0.14.0 EB-2: 値が richText.COLORS の飾り
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;   // ブロックの型・会議の種類の名前（知らない型も通す。2a2 で増える）
const TXS_MAX = 50;                         // 0.14.0 EB-2: 1回の edit.revert に渡す歩みの tx の数
const SHORT = 500;                          // 担当・期限の文字・検索の語などの短い文字
// 0.13.0 ED-2（計画 docs/plans/2026-10-24-130.md の決めたこと 9。持ち主の試作の命令ごとの照らし）: 画面の書く命令（block.*）の型は決まった表
// （blockEdit.TYPE_KEYS）だけ。main の page.put・meeting.* は今の NAME_RE のまま（新しい版の型を古い版で壊さない）
const isBlockType = (v) => typeof v === 'string' && blockEdit.TYPE_KEYS.includes(v);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

function bad(why) { const e = new Error(why); e.code = 'bad-args'; return e; }

// [{t, m}] → 素の文字。m の1つは飾りの名前か [名前, 値]。知らない飾り・http(s)/mailto/natsu://page/ 以外のリンクは投げる
function richText(rich) {
  if (!Array.isArray(rich)) throw bad('rich');
  let out = '';
  for (const run of rich) {
    if (!isObj(run) || typeof run.t !== 'string') throw bad('rich');
    const marks = run.m === undefined ? [] : run.m;
    if (!Array.isArray(marks)) throw bad('rich');
    for (const mk of marks) {
      const name = Array.isArray(mk) ? mk[0] : mk;
      if (typeof name !== 'string' || !RICH_MARKS.includes(name)) throw bad('rich mark');
      if (name === 'link') {
        if (!Array.isArray(mk) || typeof mk[1] !== 'string' || mk[1].length > 2048 || !LINK_RE.test(mk[1])) throw bad('rich link');
        if (mk[1].trim() !== mk[1] || RT.LINK_CTRL_RE.test(mk[1])) throw bad('rich link');
      } else if (Array.isArray(mk) && (mk.length !== 2 || typeof mk[1] !== 'string' || mk[1].length > 64)) throw bad('rich mark');
      if (COLOR_KINDS.includes(name) && !(Array.isArray(mk) && RT.COLORS.includes(mk[1]))) throw bad('rich color');   // 0.14.0 EB-2: 色は決まった9色だけ
    }
    // 0.14.0 EB-2（BQ3・決めたこと 15）: 1つの区切りが持てる色は1つ（文字の色か背景の色のどちらか）。コードの中のリンクは開かないので同じ区切りに持てない
    const kinds = marks.map((mk) => (Array.isArray(mk) ? mk[0] : mk));
    if (kinds.filter((k) => COLOR_KINDS.includes(k)).length > 1) throw bad('rich color');
    if (kinds.includes('code') && kinds.includes('link')) throw bad('rich mark');
    out += run.t;
  }
  if (out.length > LIMITS.text) throw bad('rich');
  return out;
}

// rich があれば text を richText(rich) で作り直す（食い違ったまま保存しない）
function normalizeBlock(b) {
  if (!isObj(b)) return b;
  if (!Array.isArray(b.rich)) return { ...b };
  return { ...b, text: richText(b.rich) };
}

// attrs を明示した形（{ …, attrs: {…} }）で、決まった名前を attrs に入れようとしていないか
function attrsOk(v, reserved) {
  if (!Object.hasOwn(v, 'attrs')) return true;
  if (!isObj(v.attrs)) return false;
  return !Object.keys(v.attrs).some((k) => reserved.includes(k));
}

// ブロック1つ（children も数える）。count は { n } で、ブロックの件数を足していく。通れば作り直した写しを返し、だめなら投げる
function checkBlock(b, count) {
  if (!isObj(b)) throw bad('block');
  if (++count.n > LIMITS.blocks) throw bad('blocks');
  if (typeof b.id !== 'string' || !ID_RE.test(b.id)) throw bad('block.id');
  if (typeof b.type !== 'string' || !NAME_RE.test(b.type)) throw bad('block.type');
  if (b.text !== undefined && !isStr(b.text, LIMITS.text)) throw bad('block.text');
  if (b.rich !== undefined && b.rich !== null) richText(b.rich);
  if (!attrsOk(b, RESERVED_BLOCK)) throw bad('block.attrs');
  const out = normalizeBlock(b);
  if (b.children !== undefined) {
    if (!Array.isArray(b.children)) throw bad('block.children');
    out.children = b.children.map((c) => checkBlock(c, count));
  }
  return out;
}

function checkBlocks(list) {
  if (!Array.isArray(list)) throw bad('blocks');
  const count = { n: 0 };   // 件数の上限は checkBlock が数えて見る（children も入れて1か所で）
  return list.map((b) => checkBlock(b, count));
}

// ページ（page.put・meeting.finalize・meeting.recover）。id は無くてよい（会議の命令は pageId で渡す）
function checkPage(p) {
  if (!isObj(p)) throw bad('page');
  if (p.id !== undefined && (typeof p.id !== 'string' || !ID_RE.test(p.id))) throw bad('page.id');
  if (p.title !== undefined && !isStr(p.title, LIMITS.title)) throw bad('page.title');
  if (p.memo !== undefined && !isStr(p.memo, LIMITS.text)) throw bad('page.memo');
  for (const k of ['type', 'text', 'rich', 'children']) if (Object.hasOwn(p, k)) throw bad('page.' + k);
  if (!attrsOk(p, RESERVED_PAGE)) throw bad('page.attrs');
  const out = { ...p };
  if (p.blocks !== undefined) out.blocks = checkBlocks(p.blocks);
  return out;
}

function checkSeg(s) {
  if (!isObj(s)) throw bad('seg');
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) throw bad('seg.id');
  if (s.text !== undefined && !isStr(s.text, LIMITS.text)) throw bad('seg.text');
  for (const k of ['atMs', 'durationMs']) if (s[k] !== undefined && s[k] !== null && !Number.isFinite(s[k])) throw bad('seg.' + k);
  if (s.failed !== undefined && typeof s.failed !== 'boolean') throw bad('seg.failed');
  if (!attrsOk(s, RESERVED_SEG)) throw bad('seg.attrs');
  return { ...s };
}

function checkSegments(list) {
  if (!Array.isArray(list) || list.length > LIMITS.segments) throw bad('segments');
  return list.map(checkSeg);
}

// ブロックの直し（block.update の patch。今の store.updateBlock が見る欄だけ）
function checkPatch(p) {
  if (!isObj(p)) throw bad('patch');
  for (const k of Object.keys(p)) {
    if (k === 'text') { if (!isStr(p.text, LIMITS.text)) throw bad('patch.text'); }
    else if (k === 'checked') { if (typeof p.checked !== 'boolean') throw bad('patch.checked'); }
    else if (k === 'type') { if (!isBlockType(p.type)) throw bad('patch.type'); }
    else if (k === 'rich') { richText(p.rich); }
    else throw bad('patch');
  }
  return normalizeBlock(p);
}

// 発言の直し（segment.update の patch。text と、0.12.0 SP-3b の parts（PC の側の文の頭: 決めたこと 144））。
// parts は形だけを照らす（2〜200 個・{ ms, at } の 0 以上の整数・最初は 0・0・どちらも増える）。文と合うかは読む側（timeline.checkParts）が見る
const PARTS_MAX = 200;
function checkPartsShape(list) {
  if (!Array.isArray(list) || list.length < 2 || list.length > PARTS_MAX) return false;
  let prev = null;
  for (const x of list) {
    if (!isObj(x) || Object.keys(x).some((k) => k !== 'ms' && k !== 'at')) return false;
    if (!Number.isSafeInteger(x.ms) || !Number.isSafeInteger(x.at) || x.ms < 0 || x.at < 0) return false;
    if (prev ? (x.ms <= prev.ms || x.at <= prev.at) : (x.ms !== 0 || x.at !== 0)) return false;
    prev = x;
  }
  return true;
}
function checkSegPatch(p) {
  if (!isObj(p)) throw bad('patch');
  for (const k of Object.keys(p)) {
    if (k === 'text') { if (!isStr(p.text, LIMITS.text)) throw bad('patch'); }
    else if (k === 'parts') { if (!checkPartsShape(p.parts)) throw bad('patch'); }
    else throw bad('patch');
  }
  const out = { ...p };
  if (out.parts) out.parts = out.parts.map((x) => ({ ms: x.ms, at: x.at }));
  return out;
}

// 型の表: 値を照らして、保存してよい写しを返す（だめなら投げる）
const TYPES = Object.freeze(Object.assign(Object.create(null), {
  id: (v) => { if (typeof v !== 'string' || !ID_RE.test(v)) throw bad('id'); return v; },
  ids: (v) => { if (!Array.isArray(v) || v.length > LIMITS.blocks || !v.every((x) => typeof x === 'string' && ID_RE.test(x))) throw bad('ids'); return [...v]; },
  idOrEmpty: (v) => { if (v !== '' && (typeof v !== 'string' || !ID_RE.test(v))) throw bad('id'); return v; },
  text: (v) => { if (!isStr(v, LIMITS.text)) throw bad('text'); return v; },
  title: (v) => { if (!isStr(v, LIMITS.title)) throw bad('title'); return v; },
  short: (v) => { if (!isStr(v, SHORT)) throw bad('short'); return v; },
  name: (v) => { if (typeof v !== 'string' || !NAME_RE.test(v)) throw bad('name'); return v; },
  // 0.11.0 M-4（持ち主の試作の命令ごとの照らし）: 会議の種類は選べる鍵（meetingType.SELECTABLE）と auto（自動に戻す）だけ
  meetingTypeArg: (v) => { if (v !== 'auto' && !mtype.isSelectable(v)) throw bad('meetingType'); return v; },
  // 0.13.0 ED-2: ブロックの型（決まった表）・見出しの段（1〜3）・分ける位置（0 以上の整数。文の長さとサロゲートは命令の中で見る）・コールアウトの絵文字（EQ15 (a): 💡 だけ）
  blockType: (v) => { if (!isBlockType(v)) throw bad('type'); return v; },
  level: (v) => { if (v !== 1 && v !== 2 && v !== 3) throw bad('level'); return v; },
  offset: (v) => { if (!Number.isSafeInteger(v) || v < 0 || v > LIMITS.text) throw bad('offset'); return v; },
  icon: (v) => { if (v !== blockEdit.CALLOUT_ICON) throw bad('icon'); return v; },
  // 0.13.1（決めたこと 4）: 字下げの向き（in・out だけ）
  dir: (v) => { if (v !== 'in' && v !== 'out') throw bad('dir'); return v; },
  int: (v) => { if (!Number.isSafeInteger(v)) throw bad('int'); return v; },
  num: (v) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('num'); return v; },
  bool: (v) => { if (typeof v !== 'boolean') throw bad('bool'); return v; },
  block: (v) => checkBlock(v, { n: 0 }),
  blocks: checkBlocks,
  page: checkPage,
  seg: checkSeg,
  segments: checkSegments,
  patch: checkPatch,
  segPatch: checkSegPatch,
  object: (v) => { if (!isObj(v)) throw bad('object'); return v; },
  // 0.14.0 EB-2（決めたこと 2・14・16・21）: 戻す歩みの tx の並び（1〜50 個・重なりなし）・画面の今の飾り（block.split・block.merge）・行の色（'' は外す）
  txs: (v) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > TXS_MAX || !v.every((x) => typeof x === 'string' && TX_RE.test(x)) || new Set(v).size !== v.length) throw bad('steps');
    return [...v];
  },
  richArg: (v) => { richText(v); return structuredClone(v); },
  blockColor: (v) => { if (v !== '' && !(typeof v === 'string' && RT.COLORS.includes(v.replace(/_bg$/, '')))) throw bad('color'); return v; },
}));

function checkArgs(spec, args) {
  if (!isObj(spec) || !isObj(args)) return { ok: false, field: '' };
  let size;
  try { size = Buffer.byteLength(JSON.stringify(args), 'utf8'); } catch (_) { return { ok: false, field: '' }; }
  if (size > LIMITS.bytes) return { ok: false, field: '' };
  for (const k of Object.keys(args)) if (!Object.hasOwn(spec, k)) return { ok: false, field: k };
  const out = {};
  for (const [k, t] of Object.entries(spec)) {
    const optional = typeof t === 'string' && t.endsWith('?');
    const name = optional ? t.slice(0, -1) : t;
    if (!Object.hasOwn(args, k) || args[k] === undefined) {
      if (optional) continue;
      return { ok: false, field: k };
    }
    try {
      if (typeof name === 'function') {
        if (!name(args[k])) return { ok: false, field: k };
        out[k] = args[k];
      } else {
        if (!Object.hasOwn(TYPES, name)) return { ok: false, field: k };   // spec の書き誤りも通さない
        out[k] = TYPES[name](args[k]);
      }
    } catch (_) {
      return { ok: false, field: k };
    }
  }
  return { ok: true, args: out };
}

module.exports = {
  ID_RE, TX_RE, LIMITS, RESERVED_BLOCK, RESERVED_PAGE, RESERVED_SEG, RICH_MARKS,
  checkArgs, richText, normalizeBlock,
};
