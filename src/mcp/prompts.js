'use strict';
// MCP の指示書（プロンプト。0.18.0 Task CP-1。計画 docs/plans/2026-11-18-180.md の決めたこと 47・AQ7 (a)・AQ44 (a)・F243）。純粋: DB を開かない。
// 指示書は 10 個（並びはいつも同じ）: 要約タイプ 7 つの「<種類>の型で要約して書き戻す」（書式は memoTypes.buildTemplate の1か所）と、
// よく使う頼み3つ（資料・横断・ToDo と決定事項）。本文の字は AQ44 (a)（2026-11-23「この字で作る（おすすめ）」。K11 の (a) の字）。
// 本文に入れるのは NaTsu の決まった字と、照らした ID・日付・1行にした話題だけ（議事録の文は入れない。会議の中身は Claude が道具で読む: RF66・RF77）。
// 点の節は入れない（指示書は設定を読まない: CR22・RF71）。
//   PROMPTS                    // [{ name, title, arguments: [{ name, description, required }] }]（prompts/list の中身）
//   checkPromptArgs(name, args) // → { ok: true, args } | { ok: false }
//   promptMessages(name, args)  // → [{ role: 'user', content: { type: 'text', text } }] | null（知らない名前・形の違う引数: rpc が -32602）
const memoTypes = require('../memoTypes');
const meetingType = require('../meetingType');
const F = require('./format');
const { meetingRef, isDate } = require('./tools');

const TOPIC_MAX = 200;   // 決めたこと 47: 話題は1行にして 200 字まで（字はコードポイントで数える）
const MEETINGS_MAX = 20;   // get_meetings の ids と同じ
// 引数の説明（CR83: 0.10.0 の道具の引数の字をそのまま）
const ARG = Object.freeze({
  meeting: Object.freeze({ name: 'meeting', description: '議事録の ID か、NaTsu の［リンクを写す］の住所', required: true }),
  meetings: Object.freeze({ name: 'meetings', description: '会議の ID か、NaTsu の［リンクを写す］の住所の並び', required: true }),
  topic: Object.freeze({ name: 'topic', description: '探す語（空白で区切る）', required: true }),
  from: Object.freeze({ name: 'from', description: 'この日の会議から（YYYY-MM-DD。両端を含む）', required: false }),
  to: Object.freeze({ name: 'to', description: 'この日の会議まで（YYYY-MM-DD。両端を含む）', required: false }),
});
const def = (name, title, args) => Object.freeze({ name, title, arguments: Object.freeze(args) });
const PROMPTS = Object.freeze([
  ...meetingType.SELECTABLE.map((k) => def(`summary_${k}`, `${meetingType.getLabel(k)}の型で要約して書き戻す`, [ARG.meeting])),
  def('make_material', '指した会議から資料を作る', [ARG.meetings]),
  def('cross_topic', '話題で過去の会議を横断する', [ARG.topic]),
  def('todo_digest', 'ToDo と決定事項をまとめる', [ARG.from, ARG.to]),
]);
const BY_NAME = new Map(PROMPTS.map((p) => [p.name, p]));

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
// 任意の引数の空の文字（Claude デスクトップが空の欄を '' で送る）は無いのと同じ（CR82）
const given = (v) => typeof v === 'string' && v.trim() !== '';

// checkPromptArgs(name, args) → { ok: true, args } | { ok: false }
function checkPromptArgs(name, args) {
  const p = BY_NAME.get(name);
  const a = args === undefined ? {} : args;
  if (!p || !isObj(a)) return { ok: false };
  const names = p.arguments.map((x) => x.name);
  if (Object.keys(a).some((k) => !names.includes(k))) return { ok: false };
  if (Object.values(a).some((v) => v !== undefined && typeof v !== 'string')) return { ok: false };   // MCP の指示書の引数は文字
  for (const x of p.arguments) if (x.required && !given(a[x.name])) return { ok: false };
  const out = {};
  if (names.includes('meeting')) {
    out.meeting = meetingRef(a.meeting);
    if (!out.meeting) return { ok: false };
  }
  if (names.includes('meetings')) {
    const ids = a.meetings.trim().split(/[\s,、・]+/).filter(Boolean).map(meetingRef);   // 空白・カンマ・読点・中黒で区切る（CR82）
    if (!ids.length || !ids.every(Boolean)) return { ok: false };
    out.meetings = [...new Set(ids)];
    if (out.meetings.length > MEETINGS_MAX) return { ok: false };
  }
  if (names.includes('topic')) {
    out.topic = F.safeLine(a.topic).trim();
    const n = [...out.topic].length;
    if (n < 1 || n > TOPIC_MAX) return { ok: false };
  }
  for (const k of ['from', 'to']) {
    if (!names.includes(k) || !given(a[k])) continue;
    const v = a[k].trim();
    if (!isDate(v)) return { ok: false };
    out[k] = v;
  }
  if (out.from && out.to && out.from > out.to) return { ok: false };
  return { ok: true, args: out };
}

// 本文（AQ44 (a) の字）
const SUM_LEAD = 'get_meeting を include_transcript で読み、この書式で書き、write_summary に meeting_type を付けて書き戻す。';
function bodyOf(name, a) {
  if (name.startsWith('summary_')) {
    const k = name.slice('summary_'.length);
    return [SUM_LEAD, `議事録の ID: ${a.meeting}`, `meeting_type: ${k}`, '書式:', memoTypes.buildTemplate({ meetingType: k, score: false, labeled: true })].join('\n');
  }
  if (name === 'make_material') return `次の会議を get_meetings で読み、要点を資料（見出しと箇条書き）にまとめてください。使った箇所ごとに出典を書いてください。会議: ${a.meetings.join('・')}`;
  if (name === 'cross_topic') return `search_passages で「${a.topic}」を、言い換えも使って何回か探し、会議をまたいで、いつ・何が話され・どう決まったかを日付の順にまとめてください。使った箇所ごとに出典を書いてください。`;
  const range = a.from || a.to ? `（${a.from || ''}〜${a.to || ''} の会議の分）` : '';   // 範囲が無ければ外す（AQ44 (a)）。片方だけは list_meetings の範囲の字と同じ形（CR82）
  return `list_action_items で開いた ToDo を${range}読み、query_database で『タスク管理』（あれば）の済んでいない行も読んで、ToDo と決定事項を担当ごとにまとめてください。`;
}

function promptMessages(name, args) {
  const c = checkPromptArgs(name, args);
  if (!c.ok) return null;
  return [{ role: 'user', content: { type: 'text', text: bodyOf(name, c.args) } }];
}

module.exports = { PROMPTS, checkPromptArgs, promptMessages, TOPIC_MAX };
