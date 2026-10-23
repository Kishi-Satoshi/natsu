'use strict';
// MCP の6つの道具（0.10.0 Task T-1〜T-7。計画 docs/plans/2026-10-20-100.md の「受け渡す名前と形」と「道具」の表）。
// 流れはどの道具も同じ: checkToolArgs（引数の照らし。DB を開く前）→ reader.withReader（読み取りだけで開いて必ず閉じる）
// → commands.listedRows（一覧に出す行。ゴミ箱と録音中の写しを外す判定はこの1か所: D57）→ filterRows（日付・種類・ID の絞り）→ 本体 → format。
// オフラインモードの会議も、印の分からない会議も、ほかの会議と同じに出す（見せない会議は無い: D57）。
// 1つの答えは MAX_RESULT_CHARS まで（D58）。続きは offset・cursor・印で読む。
const reader = require('./reader');
const F = require('./format');
const commands = require('../db/commands');
const meetingType = require('../meetingType');
const { ID_RE } = require('../db/validate');

const MAX_RESULT_CHARS = 12000;
// [既定, 最大]
const LIMITS = Object.freeze({ list: [20, 100], passages: [8, 20], perMeeting: [3, 10], actions: [50, 200] });
const OFFSET_MAX = 10000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEG_RE = /^s\d{1,6}$/;
// 議事録のリンク（D58。決めたこと 97）: natsu://page/<ID> と、後の版のブロックへのリンク #<ブロック ID>（0.10.0 は # から後を読み捨てる）
const REF_RE = /^natsu:\/\/page\/([A-Za-z0-9_-]{1,64})(?:#[A-Za-z0-9_-]{1,64})?$/;

// 道具の誤りの文（E）。isError: true の答えの本文
const ERROR_TEXT = Object.freeze({
  'no-db': 'NaTsu の議事録が見つかりません。NaTsu を一度起動してから、もう一度試してください。',
  locked: 'NaTsu が議事録の手入れ（控えからの戻しなど）をしています。少し待ってから、もう一度試してください。',
  'stale-lock': '議事録を今の形で読めません。NaTsu を一度起動してから、もう一度試してください。',
  old: '議事録を今の形で読めません。NaTsu を一度起動してから、もう一度試してください。',
  newer: 'NaTsu が新しくなっています。Claude を起動し直すと読めます。',
  busy: '議事録を今は開けませんでした。少し待ってから、もう一度試してください。',
  open: '議事録を今は開けませんでした。少し待ってから、もう一度試してください。',
  read: '議事録を今は開けませんでした。少し待ってから、もう一度試してください。',
  'not-found': 'その ID の議事録はありません。list_meetings か search_passages で ID を確かめてください。',
  'no-seg': 'transcript_from の発言はこの議事録にありません。get_meeting を include_transcript だけで呼び直してください。',
  'bad-anchor': 'anchor の形が違います。search_passages の答えの「印」を、そのまま渡してください。',
  'no-anchor': 'その印の箇所は、この議事録にもうありません（メモや文字起こしが直された可能性があります）。search_passages でもう一度探してください。',
  'bad-cursor': 'cursor の会議が、この引数の並びにありません。cursor を外して、同じ引数で読み直してください。',
  'not-yet': 'この道具はまだ使えません。',
});

// ---------------------------------------------------------------- 道具の表（tools/list の中身。並びはいつも同じ）
const ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const DATE_PROP = (what) => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: `${what}（YYYY-MM-DD。両端を含む）` });
const DATES_PROP = { type: 'array', items: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, minItems: 1, maxItems: 31, description: '会議の日付の並び（YYYY-MM-DD。from・to と一緒には使えません）' };
const TYPES_PROP = { type: 'array', items: { type: 'string', enum: [...meetingType.ORDER] }, minItems: 1, maxItems: 10, description: '会議の種類の鍵の並び' };
const INT = (min, max, def, what) => ({ type: 'integer', minimum: min, maximum: max, description: `${what}（${min}〜${max}${def === undefined ? '' : `。既定 ${def}`}）` });
const schema = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });

const TOOLS = Object.freeze([
  {
    name: 'list_meetings',
    title: '議事録の一覧',
    description: 'NaTsu に保存された議事録（会議の記録）の一覧を、新しい順に返します。日付で絞るときは from・to に YYYY-MM-DD を入れるか、dates に日付の並びを入れます（例: 10/20 の会議は from と to の両方に 2026-10-20）。会議の種類は meeting_types で絞れます。今日の日付は答えの頭にあります。中身を読むときは get_meeting（1つ）か get_meetings（いくつか）に ID を渡します。',
    inputSchema: schema({ from: DATE_PROP('この日から'), to: DATE_PROP('この日まで'), dates: DATES_PROP, meeting_types: TYPES_PROP, limit: INT(1, 100, 20, '件数'), offset: INT(0, OFFSET_MAX, 0, '飛ばす件数') }),
    annotations: ANNOTATIONS,
  },
  {
    name: 'search_passages',
    title: '議事録の箇所を探す',
    description: '議事録（会議の記録）を検索し、問いに近い箇所（要約の節・メモの段落・文字起こしの区間）を、たくさんの会議にまたがって近い順に返します。過去の会議の内容に答えるときや、資料・レポートを作るときは、まずこれを使います。各箇所には会議の ID・日付・時刻・題名・会議の種類・場所（文字起こしは [m:ss]）・印があります。query には語を空白で区切って入れます（どれかに当たれば候補で、多く当たるほど上）。2文字の語（「見積」「契約」）でも探せます。言い換え・同じ意味の語・略語・人や会社や製品の名前で、何回か探し直してください。日付は from・to か dates（YYYY-MM-DD の並び）、会議の種類は meeting_types、決まった会議は meeting_ids（ID か、NaTsu の［リンクを写す］で写した natsu://page/… の形）で絞れます。文字起こしを除くときは include_transcript を false にします。箇所の前後は expand_passage に印を、会議の全体は get_meeting か get_meetings に ID を渡します。1on1・採用面接・事前面談は meeting_types か meeting_ids で頼んだときだけ探します。',
    inputSchema: schema({
      query: { type: 'string', minLength: 1, maxLength: 200, description: '探す語（空白で区切る）' },
      from: DATE_PROP('この日から'), to: DATE_PROP('この日まで'), dates: DATES_PROP, meeting_types: TYPES_PROP,
      meeting_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50, description: '会議の ID か natsu://page/… のリンクの並び' },
      include_transcript: { type: 'boolean', description: '文字起こしも探す（既定 true）' },
      limit: INT(1, 20, 8, '箇所の数'), per_meeting: INT(1, 10, 3, '1つの会議の箇所の数の上限'), offset: INT(0, 200, 0, '飛ばす箇所の数'),
    }, ['query']),
    annotations: ANNOTATIONS,
  },
  {
    name: 'get_meeting',
    title: '議事録を読む',
    description: '議事録1つの題名・日付・会議の種類・要約・メモを Markdown で返します。id には ID か、NaTsu で写した natsu://page/… の形を渡します。要点の「（出典: s12）」は文字起こしの発言の番号です。文字起こしも読むときは include_transcript を true にします。長い文字起こしは途中で切れるので、答えの最後の transcript_from で続きを読みます。',
    inputSchema: schema({
      id: { type: 'string', description: '議事録の ID か natsu://page/… のリンク' },
      include_transcript: { type: 'boolean', description: '文字起こしも返す（既定 false）' },
      transcript_from: { type: 'string', pattern: '^s\\d{1,6}$', description: '文字起こしをこの発言の番号から読む（例 s58）' },
    }, ['id']),
    annotations: ANNOTATIONS,
  },
  {
    name: 'get_meetings',
    title: 'いくつかの議事録を読む',
    description: 'いくつかの議事録（会議の記録）を1回で読みます。ids（list_meetings や search_passages の会議の ID か、NaTsu で写した natsu://page/… の形）か、dates（YYYY-MM-DD の並び。例: ["2026-09-01","2026-09-15"]）か、from・to のどれか1つで指定します。会議ごとに題名・日付・会議の種類・要約・メモを Markdown で返し、文字起こしは include_transcript が true のときだけ返します。答えが長いと途中で切れるので、最後の cursor を同じ引数に足して続きを読みます。',
    inputSchema: schema({
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: '会議の ID か natsu://page/… のリンクの並び' },
      dates: DATES_PROP, from: DATE_PROP('この日から'), to: DATE_PROP('この日まで'),
      include_transcript: { type: 'boolean', description: '文字起こしも返す（既定 false）' },
      cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}(:s\\d{1,6})?$', description: '前の答えの最後に書いた続きの印' },
    }),
    annotations: ANNOTATIONS,
  },
  {
    name: 'expand_passage',
    title: '箇所の前後を読む',
    description: 'search_passages が返した箇所の前後を読みます。anchor には答えの「印」をそのまま渡します（自分で形を作らない）。文字起こしの箇所は前後 around 秒（既定 90 秒・600 秒まで）の発言を、要約の箇所はその見出しの節の全部を、メモの箇所は前後の段落を返します。',
    inputSchema: schema({
      anchor: { type: 'string', description: 'search_passages の答えの「印」' },
      around: INT(0, 600, 90, '文字起こしの前後の秒'),
    }, ['anchor']),
    annotations: ANNOTATIONS,
  },
  {
    name: 'list_action_items',
    title: '開いた ToDo',
    description: '議事録の開いた ToDo（まだ済んでいないもの）を、期限の近い順に返します。担当者の名前（assignee）や会議の日付（from・to）で絞れます。',
    inputSchema: schema({ assignee: { type: 'string', maxLength: 50, description: '担当者の名前（ちょうど同じ名前）' }, from: DATE_PROP('この日の会議から'), to: DATE_PROP('この日の会議まで'), limit: INT(1, 200, 50, '件数'), offset: INT(0, OFFSET_MAX, 0, '飛ばす件数') }),
    annotations: ANNOTATIONS,
  },
]);
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// ---------------------------------------------------------------- 引数の照らし
// 本当にある日か
function isDate(v) {
  if (typeof v !== 'string') return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// ID か natsu://page/<ID> → ID（前後の空白は除く）。ほかは null
function meetingRef(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (ID_RE.test(t)) return t;
  const m = REF_RE.exec(t);
  return m ? m[1] : null;
}

const intIn = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
// 型ごとの照らし: 値 → 照らした値（だめなら undefined）
const ARG_TYPES = {
  date: (v) => (isDate(v) ? v : undefined),
  dates: (v) => (Array.isArray(v) && v.length >= 1 && v.length <= 31 && v.every(isDate) && new Set(v).size === v.length ? [...v] : undefined),
  types: (v) => (Array.isArray(v) && v.length >= 1 && v.length <= 10 && v.every((x) => meetingType.ORDER.includes(x)) ? [...new Set(v)] : undefined),
  query: (v) => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 200 ? v.trim() : undefined),
  segId: (v) => (typeof v === 'string' && SEG_RE.test(v) ? v : undefined),
  ref: (v) => meetingRef(v) || undefined,
  bool: (v) => (typeof v === 'boolean' ? v : undefined),
  assignee: (v) => (typeof v === 'string' && v.length <= 50 ? v : undefined),
  cursor: (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}(:s\d{1,6})?$/.test(v) ? v : undefined),
  around: (v) => (intIn(v, 0, 600) ? v : undefined),
};
const limitType = (max) => (v) => (intIn(v, 1, max) ? v : undefined);
const offsetType = (max) => (v) => (intIn(v, 0, max) ? v : undefined);
const refsType = (max) => (v) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) return undefined;
  const out = v.map(meetingRef);
  return out.every(Boolean) ? out : undefined;
};

// 道具ごとの引数（名前 → [型, 例の文]）
const SPECS = {
  list_meetings: {
    from: [ARG_TYPES.date], to: [ARG_TYPES.date], dates: [ARG_TYPES.dates], meeting_types: [ARG_TYPES.types],
    limit: [limitType(LIMITS.list[1]), `limit は 1〜${LIMITS.list[1]} の数です。`], offset: [offsetType(OFFSET_MAX), `offset は 0〜${OFFSET_MAX} の数です。`],
  },
  search_passages: {
    query: [ARG_TYPES.query, 'query は 1〜200 文字の語です（空白で区切ります）。'],
    from: [ARG_TYPES.date], to: [ARG_TYPES.date], dates: [ARG_TYPES.dates], meeting_types: [ARG_TYPES.types],
    meeting_ids: [refsType(50), 'meeting_ids は 50 個までの ID（か NaTsu で写したリンク）の並びです。'], include_transcript: [ARG_TYPES.bool],
    limit: [limitType(LIMITS.passages[1]), `limit は 1〜${LIMITS.passages[1]} の数です。`], per_meeting: [limitType(LIMITS.perMeeting[1]), `per_meeting は 1〜${LIMITS.perMeeting[1]} の数です。`],
    offset: [offsetType(200), 'offset は 0〜200 の数です。'],
  },
  get_meeting: {
    id: [ARG_TYPES.ref, 'id は list_meetings の ID（か NaTsu で写したリンク）です。'], include_transcript: [ARG_TYPES.bool],
    transcript_from: [ARG_TYPES.segId, 'transcript_from は s58 のような発言の番号です。'],
  },
  get_meetings: {
    ids: [refsType(20), 'ids は 20 個までの ID（か NaTsu で写したリンク）の並びです。'], dates: [ARG_TYPES.dates], from: [ARG_TYPES.date], to: [ARG_TYPES.date],
    include_transcript: [ARG_TYPES.bool], cursor: [ARG_TYPES.cursor, 'cursor は前の答えの最後に書いた形のまま渡します。'],
  },
  expand_passage: {
    anchor: [(v) => (typeof v === 'string' && v.length <= 200 ? v : undefined), 'anchor は search_passages の答えの「印」です。'],
    around: [ARG_TYPES.around, 'around は 0〜600 の秒です。'],
  },
  list_action_items: {
    assignee: [ARG_TYPES.assignee, 'assignee は 50 文字までの名前です。'], from: [ARG_TYPES.date], to: [ARG_TYPES.date],
    limit: [limitType(LIMITS.actions[1]), `limit は 1〜${LIMITS.actions[1]} の数です。`], offset: [offsetType(OFFSET_MAX), `offset は 0〜${OFFSET_MAX} の数です。`],
  },
};
const REQUIRED = { search_passages: ['query'], get_meeting: ['id'], expand_passage: ['anchor'] };
const COMMON_EXAMPLE = {
  from: 'from は 2026-10-20 のような YYYY-MM-DD です。',
  to: 'to は 2026-10-20 のような YYYY-MM-DD です。',
  dates: 'dates は ["2026-10-20"] のような日付の並びです（from・to と一緒には使えません）。',
  meeting_types: `meeting_types は ${meetingType.ORDER.join('・')} の並びです。`,
  include_transcript: 'include_transcript は true か false です。',
};

// checkToolArgs(name, args) → { ok: true, args } か { ok: false, field, text }（text は bad-arg の文）
function checkToolArgs(name, args) {
  const spec = SPECS[name];
  const a = args === undefined ? {} : args;
  const badArg = (field, example) => ({ ok: false, field, text: `${field} の形が違います。${example || ''}`.trim() });
  if (!spec || !a || typeof a !== 'object' || Array.isArray(a)) return badArg('arguments', '');
  for (const k of Object.keys(a)) {
    if (!Object.hasOwn(spec, k)) {
      const shown = F.safeLine(k).slice(0, 40);
      return { ok: false, field: shown, text: `${shown} はこの道具の引数にありません（使える引数: ${Object.keys(spec).join('・')}）。` };
    }
  }
  const out = {};
  for (const [k, [check, example]] of Object.entries(spec)) {
    if (!Object.hasOwn(a, k) || a[k] === undefined) {
      if ((REQUIRED[name] || []).includes(k)) return badArg(k, example || COMMON_EXAMPLE[k]);
      continue;
    }
    const v = check(a[k]);
    if (v === undefined) return badArg(k, example || COMMON_EXAMPLE[k]);
    out[k] = v;
  }
  if (out.dates && (out.from || out.to)) return badArg('dates', COMMON_EXAMPLE.dates);
  return { ok: true, args: out };
}

// ---------------------------------------------------------------- 絞り
// filterRows(rows, { from, to, dates, types, ids }) → 絞った行（rows は listedRows の答え。並びはそのまま）
function filterRows(rows, { from, to, dates, types, ids } = {}) {
  const dateSet = dates ? new Set(dates) : null;
  const typeSet = types ? new Set(types) : null;
  const idSet = ids ? new Set(ids) : null;
  return rows.filter((r) => {
    const d = typeof r.attrs.date === 'string' ? r.attrs.date : '';
    if (from && !(d >= from)) return false;
    if (to && !(d <= to)) return false;
    if (dateSet && !dateSet.has(d)) return false;
    if (typeSet && !typeSet.has(r.attrs.meetingType || 'general')) return false;
    if (idSet && !idSet.has(r.id)) return false;
    return true;
  });
}

// 範囲の文（一覧の件数の行・当たりが無いときの文）
function scopeText({ from, to, dates, meeting_types: types } = {}) {
  let s = dates ? dates.join('・') : from || to ? `${from || ''}〜${to || ''}` : 'すべて';
  if (types) s += `（会議の種類: ${types.map((t) => meetingType.getLabel(t)).join('・')}）`;
  return s;
}

// ---------------------------------------------------------------- 道具の本体（db は読み取りだけの接続）
function listMeetings(db, args, { now }) {
  const rows = filterRows(commands.listedRows(db), { from: args.from, to: args.to, dates: args.dates, types: args.meeting_types });
  const limit = args.limit || LIMITS.list[0];
  const offset = args.offset || 0;
  const head = [F.header(now), `${scopeText(args)} の議事録 ${rows.length} 件（新しい順）`];
  const lines = [];
  let size = head.join('\n').length;
  const reserve = 40;   // 続きの行の分
  let i = offset;
  for (; i < rows.length && lines.length < limit; i++) {
    const e = commands.entryOf(db, rows[i]);
    if (!e) continue;
    const line = F.meetingLine(e, rows[i].attrs);
    if (size + 1 + line.length + reserve > MAX_RESULT_CHARS) break;
    size += 1 + line.length;
    lines.push(line);
  }
  if (!rows.length) lines.push('- この範囲の議事録はありません。');
  const tail = i < rows.length ? [`続き: offset ${i}`] : [];
  return { text: [...head, ...lines, ...tail].join('\n'), count: rows.length ? lines.length : 0 };
}

const BODIES = { list_meetings: listMeetings };

// callTool(name, args, { sqlite, dataDir, now, fs }) → { text, isError, code?, count? }。知らない名前は投げる
function callTool(name, args, ctx = {}) {
  if (!TOOL_NAMES.has(name)) throw new Error('知らない道具');
  const checked = checkToolArgs(name, args);
  if (!checked.ok) return { text: checked.text, isError: true, code: 'bad-arg' };
  const body = BODIES[name];
  if (!body) return { text: ERROR_TEXT['not-yet'], isError: true, code: 'not-yet' };
  const now = ctx.now ? ctx.now() : new Date();
  const r = reader.withReader({ sqlite: ctx.sqlite, dataDir: ctx.dataDir, fs: ctx.fs, now: () => now.getTime() }, (db) => body(db, checked.args, { now, ctx }));
  if (!r.ok) return { text: ERROR_TEXT[r.code] || ERROR_TEXT.read, isError: true, code: r.code };
  const v = r.value;
  if (v.error) return { text: v.text || ERROR_TEXT[v.error], isError: true, code: v.error };
  return { text: v.text, isError: false, code: 'ok', count: v.count };
}

module.exports = { TOOLS, callTool, checkToolArgs, filterRows, meetingRef, REF_RE, ERROR_TEXT, MAX_RESULT_CHARS, LIMITS, isDate, scopeText };
