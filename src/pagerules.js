/*
 * pagerules.js — ページの決まり（純粋な関数。第2a1回 D-1 で src/store.js から切り出した）
 *
 * 一覧のまとめ（summarize・listEntry）、出典の数（citeStatOf）、短い行の印（markShortBlocks）、
 * 一時停止の印（cleanPauses）、アクションの行と並び（actionRow・byDue）、畳んだ文字の抜き出し（foldWithMap・snippetOf）。
 * 今の JSON の保存（store.js）と議事録の DB（src/db/）の両方が、同じ答えを出すためにここを使う。
 * ファイルも DB も読まない（引数だけを見て答える）。
 */
'use strict';

const { isCitable, searchFold } = require('./cite');

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- 一覧のまとめ
// 索引が持つ検索用本文の上限。要約は長い会議で 1 万字を超えることがあり、4000 字で
// 切ると後半の要点が検索に出ない（#44）。メモは短い前提だが、無制限に持つと
// 索引（起動時に丸ごと読む）が肥大するので別に上限を置く。
const SEARCH_TEXT_MAX = 20000;
const MEMO_TEXT_MAX = 2000;

function summarize(page) {
  const todos = page.blocks.filter((b) => b.type === 'todo');
  const open = todos.filter((b) => !b.checked);
  // 0.11.0 M-3（決めたこと 24）: 印のある行（未確認・チェック・助言・メモより）は最初の要点にしない
  const firstBullet = page.blocks.find((b) => b.type === 'bullet' && b.text && !b.mark);
  const dues = open.map((b) => b.due).filter(Boolean).sort();
  return {
    id: page.id,
    title: page.title || '(無題の議事録)',
    date: page.date,
    durationSec: page.durationSec || 0,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    meetingType: page.meetingType || 'general',
    hasSummary: page.blocks.some((b) => b.type === 'heading'),
    actionCount: todos.length,
    openActionCount: open.length,
    nextDue: dues[0] || '',
    assignees: [...new Set(open.map((b) => b.assignee).filter(Boolean))],
    preview: firstBullet ? firstBullet.text.slice(0, 120) : '',
    // 「すべて」の検索が見る本文。これが無いと検索はタイトルと最初の
    // 1行しか当たらず、要約の中身を探せない（実機で「検索が全部壊れて
    // いる」と報告された）。文字起こしは searchFullText が受け持つ。
    // メモは別のキーに持つ（#44）。要約に連結して切ると、長い会議ではメモが
    // 上限の外へ押し出され、メモには他の検索経路が無いので二度と探せない。
    searchText: page.blocks.map((b) => b.text).filter(Boolean).join(' ').slice(0, SEARCH_TEXT_MAX),
    memoText: String(page.memo || '').slice(0, MEMO_TEXT_MAX),
    recovered: Boolean(page.recovered),
  };
}

// 一覧の1行（ST11）。summarize から検索用の文字（searchText・memoText）を除いたもの。
// DB は検索を全文検索の索引で行うので、一覧の行に本文の写しを持たない
function listEntry(page) {
  const entry = summarize(page);
  delete entry.searchText;
  delete entry.memoText;
  return entry;
}

// ---------------------------------------------------------------- 出典
// 短すぎて出典の照合対象にならない行に citeSkip を付ける。
// v0.10.8 より前に要約したページには citeSkip が無く、そのままだと画面が
// 「根拠なし」の札を出し、保存のたびに分母へ数えてしまう（「出典 1/1」が「1/2」になる）。
// 読むたびに補うので、古いページも次の保存で正しい形になる。
function markShortBlocks(blocks) {
  for (const b of blocks) {
    if (b.type !== 'bullet' && b.type !== 'todo') continue;
    if (b.citeState === 'manual') continue;
    if (!b.citeSkip && !isCitable(b.text)) b.citeSkip = true;
  }
}

// 出典の被覆率「🔗 出典 x/y」。要約直後の値を持ち越すと、人が行を足したり書き換えたり
// したあとに数が合わなくなるので、保存のたびにブロックから数え直す。
//   分母: bullet/todo のうち、短すぎて対象外（citeSkip: cite.js が付ける）でも
//         人が足した行（manual）でもないもの
//   分子: そのうち出典があり、人が書き換えていない（stale ではない）もの
// citeStat に他のキーがあっても消さない（表示側が知らないキーを持ち越せるように）。
function citeStatOf(blocks) {
  let total = 0;
  let linked = 0;
  for (const b of blocks) {
    if (b.type !== 'bullet' && b.type !== 'todo') continue;
    if (b.citeSkip || b.citeState === 'manual' || !isCitable(b.text)) continue;
    total++;
    if (Array.isArray(b.cites) && b.cites.length && b.citeState !== 'stale') linked++;
  }
  return { linked, total };
}

// ---------------------------------------------------------------- 一時停止の印
// 止めていた時間の印（第1b回 N4c）。形の正しいもの（有限で 0 以上の atMs・ms、why は user か suspend）だけを残す
const PAUSE_WHY = new Set(['user', 'suspend']);
function cleanPauses(list) {
  return list.filter((x) => isObj(x) && Number.isFinite(x.atMs) && x.atMs >= 0 && Number.isFinite(x.ms) && x.ms >= 0 && PAUSE_WHY.has(x.why))
    .map((x) => ({ atMs: x.atMs, ms: x.ms, why: x.why }));
}

// ---------------------------------------------------------------- 未完了アクション
// アクションタブの1行。page.json の todo ブロックから画面に要る分だけ写す
function actionRow(page, b) {
  return {
    pageId: page.id, blockId: b.id, pageTitle: page.title, date: page.date,
    text: b.text, assignee: b.assignee || '', due: b.due || '',
    dueRaw: b.dueRaw || '', dueApprox: Boolean(b.dueApprox),
  };
}

// 期限が近い順。期限なしは末尾へ回す（無期限を先頭に出しても行動につながらない）
function byDue(a, b) {
  if (a.due && b.due) return a.due.localeCompare(b.due);
  if (a.due) return -1;
  if (b.due) return 1;
  return String(b.date).localeCompare(String(a.date));
}

// ---------------------------------------------------------------- 検索の抜き出し
// 検索は畳み込んだ文字列どうしで当てる（#53）。文字起こしは「では、予算案の、作成を」の
// ように読点が挟まり、要約は「ＡＩ」と「AI」が混ざるので、原文どうしの includes では
// 言ったはずの語が見つからない。畳み込みは cite.searchFold（normalize とは別物）。

// 本文を畳み込み、畳み込み後の各文字が元の本文のどの範囲から来たかも返す。
// 一致は畳んだ文字列で探すが、抜粋は元の本文から切りたい（句読点や全角のまま見せる）。
// 文字ごとに畳むと NFKC が「ｶ」+「ﾞ」→「ガ」のように結合できないので、
// 結合記号は直前の文字と同じ塊にして畳み、塊の出力を塊の元範囲に対応付ける。
const JOIN_MARK = /[\u0300-\u036f\u3099-\u309c\uff9e\uff9f\u200d\ufe0f]/;
function foldWithMap(text) {
  const s = String(text || '');
  let folded = '';
  const from = [];   // folded[i] → 元の塊の開始位置
  const to = [];     // folded[i] → 元の塊の終了位置（排他）
  let start = 0;
  while (start < s.length) {
    let end = start + (s.codePointAt(start) > 0xffff ? 2 : 1);
    while (end < s.length && JOIN_MARK.test(s[end])) end++;
    const f = searchFold(s.slice(start, end));
    for (let k = 0; k < f.length; k++) { from.push(start); to.push(end); }
    folded += f;
    start = end;
  }
  return { folded, from, to };
}

// 畳んだ検索語 q が当たった箇所を、元の本文 text から切り出す（前後を少し添える）。
// 呼ぶ側が「当たる」ことを確かめてから呼ぶ（外れた本文に文字単位の位置対応を作らない）。
function snippetOf(text, q) {
  const { folded, from, to } = foldWithMap(text);
  const at = folded.indexOf(q);
  // 元の本文の範囲に戻す。結合の仕方の差で位置が取れない稀な場合は先頭から見せる
  const s = at >= 0 ? from[at] : 0;
  const e = at >= 0 ? to[at + q.length - 1] : Math.min(text.length, q.length);
  const head = Math.max(0, s - 20);
  return (head > 0 ? '…' : '') + text.slice(head, e + 40);
}

module.exports = {
  SEARCH_TEXT_MAX, MEMO_TEXT_MAX,
  summarize, listEntry, citeStatOf, markShortBlocks, cleanPauses, actionRow, byDue, foldWithMap, snippetOf,
};
