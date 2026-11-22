/*
 * summaryWrite.js — 要約の作り方（0.18.0 CS-1。計画 docs/plans/2026-11-18-180.md の決めたこと 15・16・F236）
 *
 * main の［要約を生成］（doRunSummary）と、DB のプロセスの Claude の要約の書き戻し（mcp.writeSummary: CS-2）が、同じ1つの作り方を使う
 * （2つの作り方を持つと、写しの落とし方・印・担当と期限の裏付け・出典の付け方がずれていく: RF68〜RF72）。
 * 純粋な関数（読み書きしない・Electron を読まない）。markdownToBlocks と cite.js は呼ぶだけで変えない。記録の行と知らせの文は呼び手が持つ。
 *
 * stripCiteMarks(md) → md
 *   行の終わりの出典の印（読む道具の答えの形: mcp/format.js の citeSuffix。「（出典: s12）」「（出典: s12, s15）」「（出典: [s12](…)・[s15](…)）」）を外す。
 *   行の途中の印・ほかの括弧の文は残す。出典は NaTsu が今の文字起こしと照らして付け直す（印を信じない: 出典リンクを LLM に作らせない）。
 * prepareSummary({ md, page, segments, segmentsAtStart = segments, score, template, at })
 *   → { blocks, citeStat, actionStat, quality: obj | null, scoreNote, scoreCode, dropped, folded, droppedAssignee, droppedDue }
 *   順: quality.splitScore → stripCiteMarks → markdownToBlocks → dropRedundantEmpty → dropTemplateEcho(template) → memoTypes.markBlocks
 *       → enrichActionBlocks → groundActionFields（要約の材料にした文字起こし segmentsAtStart ＋ アジェンダの雛形を除いたメモ）
 *       → attachCitationsAcross（今の文字起こし segments と材料にした配列）→ 点（score のときだけ。読めなければ scoreNote と scoreCode）
 *   page は { meetingType, createdAt, memo }。at は点の時刻（無ければ今）。
 */
'use strict';

const minutes = require('./minutes');
const memoTypes = require('./memoTypes');
const mtype = require('./meetingType');
const quality = require('./quality');
const cite = require('./cite');
const timeline = require('./mcp/timeline');
const { enrichActionBlocks, groundActionFields } = require('./actions');
const { memoEvidence } = require('./mainlib');

const { markdownToBlocks, dropRedundantEmpty } = minutes;
const dropTemplateEcho = minutes.dropTemplateEcho || ((b) => b);

// 採点の節を読めなかったときの注（0.11.0 Q-3 の QN1。Claude Code の要約と Claude の書き戻しで同じ文）
const QUALITY_NOTE_UNREAD = 'この要約には打ち合わせの質の点を付けていません（AI の答えの形を読み取れなかったため）。要約はそのまま使えます。［要約を再生成］でもう一度付けられます。';
// 文字起こしが短くて点を付けなかったときの注（QN2。0.18.0 CS-2 で main から移した: Claude の書き戻しも同じ文）
const QUALITY_NOTE_SHORT = '文字起こしが短いため、打ち合わせの質の点は付けていません。';

// 出典の印1つ（s<数>、か [s<数>](住所)）と、行の終わりの印の括弧
const MARK = String.raw`(?:\[s\d{1,6}\]\([^()\s]*\)|s\d{1,6})`;
const CITE_TAIL_RE = new RegExp(String.raw`\s*（出典[:：]\s*${MARK}(?:\s*[,、・]\s*${MARK})*\s*）\s*$`);

function stripCiteMarks(md) {
  return String(md ?? '').split('\n').map((line) => line.replace(CITE_TAIL_RE, '')).join('\n');
}

function prepareSummary({ md: answer, page = {}, segments, segmentsAtStart = segments, score = false, template = '', at } = {}) {
  const fresh = Array.isArray(segments) ? segments : [];
  const start = Array.isArray(segmentsAtStart) ? segmentsAtStart : fresh;
  // 採点の節はいつも本文から外す（頼まなかった採点の節も、2つ以上の節も、本文に残さない: 0.11.0 Q-3）
  const split = quality.splitScore(String(answer ?? ''));
  const md = stripCiteMarks(split.body);
  // 写しを落とした後に印を付ける（0.11.0 M-3）
  const marked = memoTypes.markBlocks(dropTemplateEcho(dropRedundantEmpty(markdownToBlocks(md)), template), { meetingType: page.meetingType });
  const blocks = marked.blocks;
  // 担当・期限を先に抜く（出典の照合は「（担当: ○○ / 期限: ○○）」を落とした文で）
  enrichActionBlocks(blocks, new Date(page.createdAt));
  // 文字起こし（タイムラインの行の順・札の無い文）とメモ（アジェンダの雛形の行を除く）に出てこない担当・期限は外す（推測で埋めない）
  const rows = timeline.timelineOf(start.filter((s) => s && !s.failed && !s.pending));
  const plain = rows.map((r) => r.text).join('\n');
  const grounded = groundActionFields(blocks, `${plain}\n${memoEvidence(page.memo, [...mtype.listTypes(), ...memoTypes.presetLines()])}`);
  // 出典は今の文字起こしと、要約の材料にした配列の両方で付ける（#4）
  const citeStat = cite.attachCitationsAcross(blocks, fresh, start);
  let q = null; let scoreNote = ''; let scoreCode = '';
  if (score) {
    const parsed = quality.parseScore(split.lines, quality.AI_AXES, { found: split.found });
    if (parsed.ok) {
      const cites = {};
      for (const a of quality.AI_AXES) {
        const tmp = [{ id: `q-${a.key}`, type: 'bullet', text: parsed.ai[a.key].reason, cites: [] }];
        cite.attachCitationsAcross(tmp, fresh, start);
        cites[a.key] = Array.isArray(tmp[0].cites) ? tmp[0].cites.filter((c) => typeof c === 'string') : [];
      }
      q = quality.buildQuality({ ai: parsed.ai, todo: quality.todoAxis(blocks), fill: quality.fillAxis(blocks, { headings: memoTypes.sectionsOf(page.meetingType), key: memoTypes.headingKey }), cites, at: typeof at === 'string' && at ? at : new Date().toISOString() });
    } else {
      scoreNote = QUALITY_NOTE_UNREAD;
      scoreCode = parsed.code;
    }
  }
  return { blocks, citeStat, actionStat: grounded.stat, quality: q, scoreNote, scoreCode, dropped: marked.dropped, folded: marked.folded,
    droppedAssignee: grounded.droppedAssignee, droppedDue: grounded.droppedDue };
}

module.exports = { QUALITY_NOTE_UNREAD, QUALITY_NOTE_SHORT, stripCiteMarks, prepareSummary };
