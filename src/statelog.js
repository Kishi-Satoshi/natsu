'use strict';
// 議事録の経過（0.10.0 Task K-1・K-2。決めたこと 116。持ち主の試作の「状態の移り変わりを、きっかけと時刻と一緒に履歴に積む」考え）。純粋。
// main が会議の移り変わり（開始・一時停止・再開・終了・無音で自動で終了・落ちた後に戻した）を、きっかけと時刻と一緒に積み、
// 下書きとページの stateLog（[{ s, by, at }]）に書く。s と by は下の表の鍵だけ（DB の値をそのまま出さない: 決めたこと 60）、at は ISO の時刻。
// DB のプロセス（src/db/commands.js の締め・復旧のページ）と MCP（src/mcp/format.js の経過の1行）もこの表で照らす。0.12.0 は同じ表に足す。

const STATE_LOG_MAX = 50;
// 0.11.0 M-4（P13・決めたこと 12）: 会議の種類の移り変わり（type）と、そのきっかけ（録音中のページ・議事録のページ・要約のときの自動の判定）を足した
// 0.12.0 SP-3a（D66・決めたこと 137）: 相手の声の取り込みの移り変わり（きっかけは録音バー overlay）
const STATE_NAMES = Object.freeze({ start: '開始', pause: '一時停止', resume: '再開', stop: '終了', 'auto-stop': '終了', recover: '戻した', type: '種類を選んだ',
  'sys-lost': '相手の声を取り込めていない', 'sys-back': '相手の声を取り込めた' });
const BY_NAMES = Object.freeze({ button: '画面のボタン', overlay: '録音バー', hotkey: 'ホットキー', tray: 'タスクトレイ', panel: '会議の知らせのパネル', quiet: '無音で自動', app: 'アプリ',
  'live-page': '録音中のページ', page: '議事録のページ', auto: '要約のときの自動の判定' });

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
// 1項目の照らし → { s, by, at } か null（ほかの欄は落とす）
function entryOf(x) {
  if (!isObj(x)) return null;
  if (typeof x.s !== 'string' || !Object.hasOwn(STATE_NAMES, x.s)) return null;
  if (typeof x.by !== 'string' || !Object.hasOwn(BY_NAMES, x.by)) return null;
  if (typeof x.at !== 'string' || x.at.length > 40 || !Number.isFinite(Date.parse(x.at))) return null;
  return { s: x.s, by: x.by, at: x.at };
}

// 積む → 新しい配列（表に無い項目は積まない・STATE_LOG_MAX 件で古い方を捨てる・受けた物を変えない）
// 0.11.0 M-4（F28）: 種類の項目は、最後の項目も種類なら置き換える（続けて選び直しても1件。開始や終了が上限で押し出されない）
function stateLogAdd(log, item) {
  const base = cleanStateLog(log);
  const e = entryOf(item);
  if (!e) return base;
  if (e.s === 'type' && base.length && base[base.length - 1].s === 'type') return [...base.slice(0, -1), e];
  return [...base, e].slice(-STATE_LOG_MAX);
}

// 読んだ経過（下書き・ページ）を照らす → 表に無い項目を落とした STATE_LOG_MAX 件までの新しい配列
function cleanStateLog(list) {
  if (!Array.isArray(list)) return [];
  return list.map(entryOf).filter(Boolean).slice(-STATE_LOG_MAX);
}

// engine.log の1行「議事録: 開始（ホットキー）」（題名・文は書かない）
function stateLogLine(item) {
  const e = entryOf(item);
  return e ? `議事録: ${STATE_NAMES[e.s]}（${BY_NAMES[e.by]}）` : '';
}

module.exports = { STATE_LOG_MAX, STATE_NAMES, BY_NAMES, stateLogAdd, cleanStateLog, stateLogLine };
