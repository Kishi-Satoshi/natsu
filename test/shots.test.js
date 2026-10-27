/*
 * shots.test.js — 画面を撮って比べる道具（第1a回 G2・PERF）の決め方
 * 本物の Electron で撮るのは Windows の CI（electron-smoke）だけ。ここでは画面の並び・偽の橋の名前・比べ方・揺れ・CSP・速さ・CI の段を見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SH = require('../tools/shots/screens');
const P = require('../tools/png');
const { preloadApis } = require('./helpers/simrun');
const { jobsOf, stepsOf } = require('./helpers/yml');
const PS = require('../tools/shots/pill-states');
const lib = require('../src/mainlib');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// 0.9.1（計画 docs/plans/2026-10-21-091.md の「取り直す画面」）で意図して変えた: 取り直し待ちは計画の表の画面だけ（RETAKE_091）。Q-3 で設定の項目「録音」に
// カード「話し声が無いとき」を足したので settings-record-light、Q-5 で「会議は終わりましたか？」の帯の画面（明るい・暗い）・設定の検索「自動で止める」・
// 録音バーの短い文（状態 quiet の 8 枚）を足した。足した画面（NEW_091）は、取り直し待ちの間は基準が無くてよい。
// 利用者がまとめて OK と言ったら、版を上げる commit で基準にして空に戻す（空になるまで版を上げられない: 下の F14）
// 0.9.1 で意図して変えた（版を 0.9.1 に上げる commit）: 利用者が 2026-10-21 に CI の取り直しの画像（run 39539780418（a83d61d）・artifact 12319056756 の
// .after.png。計画の「取り直す画面」の全部の 12 枚）を見て OK と言ったので、その画像をバイトのまま基準にして取り直し待ちを空に戻した（0.9.0 G-3 と同じ手順）。
// 計画の表の画面（前の RETAKE_091）と、足した画面の「取り直し待ちの間は基準が無くてよい」の例外（前の NEW_091）は外した
const QUIET_OVERLAY = PS.FORMS.flatMap((f) => Object.keys(PS.DESKS).flatMap((d) => PS.SCALES.map((k) => `overlay-${f}-${d}-quiet-${Math.round(k * 100)}`)));
const ADDED_091 = ['settings-record-light', 'live-quiet-light', 'live-quiet-dark', 'settings-quiet-search-light', ...QUIET_OVERLAY];
// 0.9.2（計画 docs/plans/2026-10-21-092.md の「取り直す画面」）で意図して変えた: 取り直し待ちは計画の表の画面だけ（RETAKE_092）。I-1 で設定の左の列の下に
// ［ヘルプ］を出したので、設定の 7 枚を入れた（I-2・I-3 で説明も変わる）。I-4 で足す画面（NEW_092）は、取り直し待ちの間は基準が無くてよい。
// 利用者がまとめて OK と言ったら、版を上げる commit で基準にして空に戻す（空になるまで版を上げられない: 下の F14）
// 0.9.2 で意図して変えた（版を 0.9.2 に上げる commit）: 利用者が 2026-10-21 に CI の取り直しの画像（run 39560229700（2649858）・artifact 12327173484 の
// .after.png。計画の「取り直す画面」の全部の 16 枚）を見て OK と言ったので、その画像をバイトのまま基準にして取り直し待ちを空に戻した（0.9.1 と同じ手順）。
// 計画の表の画面（前の RETAKE_092）と、足した画面の「取り直し待ちの間は基準が無くてよい」の例外（前の NEW_092）は外した
// I-4 で足した画面（計画の「取り直す画面」の表の（新）。撮る並びの順）
const I4_SCREENS_092 = ['settings-record-dark', 'settings-record-zoom200-light', 'settings-summary-light', 'settings-account-light', 'settings-info-loop-light',
  'settings-info-stt-dark', 'settings-info-claude-light', 'settings-info-zoom200-light', 'settings-info-search-light'];
// 0.9.2 で基準にした画面（計画の「取り直す画面」の表の全部: 設定の 7 枚と I-4 で足した 9 枚）
const ADDED_092 = ['settings-light', 'settings-dark', 'settings-zoom200-dark', 'settings-record-light', 'settings-search-light', 'settings-offline-light',
  'settings-quiet-search-light', ...I4_SCREENS_092];
// 0.9.3（計画 docs/plans/2026-10-22-093.md の「取り直す画面」）で意図して変えた: 取り直し待ちは計画の表の画面だけ（RETAKE_093）。M-0（持ち主の答え D54）で
// 設定の左の列の名前を「ローカル AI」にして列を 196px に広げたので設定の 16 枚、録音中のページのボタンを［オフラインモード］にしたので録音中のページの
// 7 枚を入れた。M-4・M-6・M-7 で足す画面（NEW_093）は、取り直し待ちの間は基準が無くてよい。利用者がまとめて OK と言ったら、版を上げる commit で基準にして空に戻す
const SETTINGS_093 = ['settings-light', 'settings-dark', 'settings-zoom200-dark', 'settings-record-light', 'settings-search-light', 'settings-offline-light',
  'settings-quiet-search-light', ...I4_SCREENS_092];
const LIVE_093 = ['live-light', 'live-dark', 'live-banner-light', 'live-banner-dark', 'live-banner-zoom200-dark', 'live-quiet-light', 'live-quiet-dark'];
// M-7 で足した画面（計画の「取り直す画面」の表の（新）。撮る並びの順。本体の画面のあとに録音バー、そのあとにパネル）
const M7_APP_093 = ['live-wave-light', 'live-wave-dark', 'live-silent-light', 'live-paused-dark', 'settings-detect-light', 'settings-detect-dark'];
const M7_NUDGE_093 = ['nudge-light-100', 'nudge-dark-100', 'nudge-light-150', 'nudge-menu-light-100', 'nudge-menu-dark-100'];
// 持ち主の答え D55（オフラインモードの札と記録の行の「オフライン」）で足した画面（計画の「取り直す画面」の表の（新）。本体の画面の最後）
const D55_APP_093 = ['live-offline-light', 'live-offline-dark'];
// 0.9.3 で意図して変えた（版を 0.9.3 に上げる commit）: 持ち主が 2026-10-22 に「CI の画像を基準にして 0.9.3 の版を上げてよい」と言ったので、CI の取り直しの画像
// （run 39769254304（a6b8271）の .after.png。計画の「取り直す画面」の全部の 36 枚）をバイトのまま基準にして取り直し待ちを空に戻した（0.9.2 と同じ手順）。
// 計画の表の画面（前の RETAKE_093）と、足した画面の「取り直し待ちの間は基準が無くてよい」の例外（前の NEW_093）は外した
// 0.9.3 で基準にした画面（計画の「取り直す画面」の表の全部: 設定の 16 枚・録音中のページの 7 枚・M-7 で足した 11 枚・D55 で足した 2 枚）
const ADDED_093 = [...SETTINGS_093, ...LIVE_093, ...M7_APP_093, ...M7_NUDGE_093, ...D55_APP_093];
// 0.9.4（計画 docs/plans/2026-10-22-094.md の「取り直す画面（決めた形）」）で意図して変えた: 取り直し待ちは 0.9.4 の表の画面だけ（RETAKE_094）。
// 最後に1回まとめて持ち主に見てもらい（Q33）、版を上げる commit で基準にして空に戻す。タスクごとに足す
const OVL_094 = (states) => PS.FORMS.flatMap((form) => Object.keys(PS.DESKS).flatMap((desk) => PS.SCALES.flatMap((sc) => states.map((st) => `overlay-${form}-${desk}-${st}-${Math.round(sc * 100)}`))));
// W-1: 録音中のページの波（5つの灰色の点。録音中のページの画面はどれも波の箱を出す）と、録音バーの声のある状態の点（5本がそれぞれ揺れる）と縦の ×
const W1_094 = ['live-light', 'live-dark', 'live-banner-light', 'live-banner-dark', 'live-banner-zoom200-dark', 'live-quiet-light', 'live-quiet-dark',
  'live-offline-light', 'live-offline-dark', 'live-wave-light', 'live-wave-dark', 'live-silent-light', 'live-paused-dark',
  ...OVL_094(['rec', 'dict', 'fallback', 'spk-ng']), 'overlay-vertical-dark-hover-150'];
// P-1: 録音バーのスピーカーの印を外した（印のあった無音・一時停止。声の rec・spk-ng は W-1 で入れた）
// P-1 の CI の直し（CI run 39821563457）: 縦の形の quiet は見た目を変えていないが、同じ窓で直前に撮る spk-ng（P-1 でロゴの角の黄色い点が出る）の後に
// ロゴの縁の数画素（3〜8 画素）が基準と違って撮れる（窓の描き直しが前の状態に左右される）。持ち主の最後のまとめての確かめで一緒に見て基準にする
const P1_094 = [...OVL_094(['silent', 'paused']), 'overlay-v-light-quiet-100', 'overlay-v-light-quiet-150', 'overlay-v-dark-quiet-100', 'overlay-v-dark-quiet-150'];
// R-1: 設定の左の列の名前を「ローカル AI」に（設定の画面はどれも左の列を写す）
const R1_094 = ['settings-light', 'settings-dark', 'settings-zoom200-dark', 'settings-record-light', 'settings-search-light', 'settings-offline-light',
  'settings-quiet-search-light', 'settings-record-dark', 'settings-record-zoom200-light', 'settings-summary-light', 'settings-account-light',
  'settings-info-loop-light', 'settings-info-stt-dark', 'settings-info-claude-light', 'settings-info-zoom200-light', 'settings-info-search-light',
  'settings-detect-light', 'settings-detect-dark'];
// S-8: 遅い会議の帯と区間（足した画面。まだ基準が無い: NEW_094）
const S8_APP_094 = ['live-late-light', 'live-late-dark', 'live-late-zoom200-light'];
// 0.9.4 で意図して変えた（版を 0.9.4 に上げる commit）: 持ち主が 2026-10-22 に CI の取り直しの画像（run 39831111027（bd2320d）・artifact 12448422820 の
// .after.png）を見て「OK」と言ったので、その画像をバイトのまま基準にして取り直し待ちを空に戻した（0.9.3 と同じ手順）。表の画面（前の RETAKE_094）と、
// 足した画面の「取り直し待ちの間は基準が無くてよい」の例外（前の NEW_094）は外した
const ADDED_094 = [...W1_094, ...P1_094, ...R1_094, ...S8_APP_094];
// 0.10.0（計画 docs/plans/2026-10-20-100.md の「取り直す画面（RETAKE）」）で意図して変えた: 取り直し待ちは 0.10.0 の表の画面だけ（RETAKE_100）。タスクごとに足し、
// 最後に1回まとめて持ち主に見てもらい、版を上げる commit（G-2）で基準にして空に戻す
// SH-1（D71）: 見本の議事録の題名を日付の形にしたので、左の一覧・タブ・道しるべ・大きな題名・検索の窓の結果が写る本体の画面（CI run 39895432371 で撮って基準と違った画面だけ: notes-empty-light も左の一覧に見本が出る。拡大の設定の3枚は基準と同じ）
const SH1_100 = ['notes-empty-light', 'notes-page-light', 'notes-page-dark', 'dictation-light', 'settings-light', 'settings-dark', 'notes-tabs-light', 'notes-collapsed-light',
  'live-light', 'live-dark', 'notes-page-zoom200-light', 'search-palette-light', 'live-banner-light', 'live-banner-dark',
  'live-banner-zoom200-dark', 'settings-record-light', 'settings-search-light', 'settings-offline-light', 'live-quiet-light', 'live-quiet-dark',
  'settings-quiet-search-light', 'settings-record-dark', 'settings-summary-light', 'settings-account-light',
  'settings-info-loop-light', 'settings-info-stt-dark', 'settings-info-claude-light', 'settings-info-search-light',
  'live-wave-light', 'live-wave-dark', 'live-silent-light', 'live-paused-dark', 'settings-detect-light', 'settings-detect-dark', 'live-offline-light',
  'live-offline-dark', 'live-late-light', 'live-late-dark', 'live-late-zoom200-light'];
// C-3（MR8）: 項目「要約」にカード「Claude との連携（MCP）」を足し、要約（Claude Code）の吹き出しに Sonnet の1行（D34）。変わる2枚（SH-1 の表にもある）と足した2枚
const C3_100 = ['settings-summary-light', 'settings-info-claude-light', 'settings-mcp-light', 'settings-info-mcp-light'];
// 0.10.0 で足した画面（取り直し待ちの間は基準が無くてよい。版を上げる commit で基準にして空に戻す）
// L-1（D58）: ページの「···」のメニューを開いた形（［リンクを写す］）
const L1_100 = ['page-menu-link-light', 'page-menu-link-dark'];
// L-2（D58・D70）: 左の一覧の［選ぶ］で2件を選んだ形（ほかの本体の画面に出る見出しの行の［選ぶ］は、SH-1 の表の画面に入っている）
const L2_100 = ['list-select-light', 'list-select-dark'];
// LS-2（D63・D69・決めたこと 111 の 7）: まだ要約を作っていない会議のページ（要約の欄の鍵の一言）。足した画面
const LS2_100 = ['page-summary-lock-light'];
// 撮る画面の並びの確かめ（下）は、0.10.0 で足した画面の名前として NEW_100 を使う
const NEW_100 = ['settings-mcp-light', 'settings-info-mcp-light', ...L1_100, ...L2_100, ...LS2_100];
// 0.10.0 で意図して変えた（版を 0.10.0 に上げる commit）: 持ち主が 2026-10-23 に取り直しの見比べ（CI run 39931820118（7feee33）の 46 枚）を見て「OK」と言った。
// 持ち主の答えで MCP のカードの頭の1行だけを直した後の CI run 39934849171（03d209d）・artifact 12493472101 の画像をバイトのまま基準にし、取り直し待ちを空に戻した（0.9.4 と同じ手順）。
// 表の画面（前の RETAKE_100）と、足した画面の「取り直し待ちの間は基準が無くてよい」の例外（NEW_100 の使い道）は外した
const ADDED_100 = [...SH1_100, ...C3_100, ...L1_100, ...L2_100, ...LS2_100];
// 0.10.1（計画 docs/plans/2026-10-23-101.md の「取り直す画面（RETAKE）」）で意図して変えた: 取り直し待ちは 0.10.1 の表の画面だけ（RETAKE_101）。
// CD-3（D84）: Claude デスクトップが動いていたので断った文（RN1）の画面を足した（まだ基準が無い。持ち主が OK と言ったら CD-7 で基準にして空に戻す）
const NEW_101 = ['settings-mcp-running-light'];
// 0.11.0 V-1: 会議の種類のプルダウンを開いた明暗・前の版の一般・その他のページ・録音中に種類を選んだ形（取り直し待ち・まだ基準が無い）
// V-2: 打ち合わせの質のカードの明暗
// V-3: 設定のカード「打ち合わせの質」
const NEW_110 = ['page-type-light', 'page-type-dark', 'page-type-undecided-light', 'live-type-light', 'page-quality-light', 'page-quality-dark', 'settings-quality-light'];
// 0.10.1 で意図して変えた（版を 0.10.1 に上げる commit）: 持ち主が 2026-10-24 に settings-mcp-running-light（断った文 RN1）の画像を見て「OK」と言った。
// CI run 40071461858（1dff338）の2回目・artifact 12552271208 の .after.png をバイトのまま基準にし（持ち主が見た画像とバイトで同じ）、取り直し待ちを空に戻した。
// 撮る画面の並びの確かめ（下）は、0.10.1 で足した画面の名前として NEW_101 を使う
const ADDED_101 = [...NEW_101];
// 0.11.0（計画 docs/plans/2026-10-22-110.md の「取り直す画面（RETAKE）」）: 0.11.0 で取り直した画面（ADDED_110）。版を 0.11.0 に上げる commit で、持ち主が 2026-10-24 に
// 見比べを「OK（版を 0.11.0 に上げてよい）」と言ったので、CI run 40142063730（1a46130）・artifact 12578889430 の .after.png（37 枚）をバイトのまま基準にし、取り直し待ちを空に戻した。
// M-1（R7）: 会議の種類の名前と説明の付け直しで、種類の行を写すページの画面（CI run 40079245997 で違いが出た 8 枚。検索の窓の後ろのページも）
const ADDED_110 = ['notes-page-light', 'notes-page-dark', 'notes-tabs-light', 'notes-collapsed-light',
  'page-menu-link-light', 'page-menu-link-dark', 'page-summary-lock-light', 'search-palette-light',
  // P-12（R7・R15）: 種類の欄の「自動」と灰色の文で、種類の行を写す残りの画面も
  'notes-page-zoom200-light',
  // V-1: 行の名前「会議の種類」と「メモの型」。足した画面と、録音中のページを写す画面（種類の行と一言: P10 (a)）
  'page-type-light', 'page-type-dark', 'page-type-undecided-light', 'live-type-light',
  'live-light', 'live-dark', 'live-banner-light', 'live-banner-dark', 'live-banner-zoom200-dark', 'live-quiet-light', 'live-quiet-dark',
  'live-wave-light', 'live-wave-dark', 'live-silent-light', 'live-paused-dark', 'live-offline-light', 'live-offline-dark',
  'live-late-light', 'live-late-dark', 'live-late-zoom200-light',
  // V-2: 新しい形の要約の並びと打ち合わせの質のカード（足した画面）
  'page-quality-light', 'page-quality-dark',
  // V-3: 設定のカード「打ち合わせの質」（足した画面）と、項目「要約」を写す設定の画面（カードが1枚増える）
  'settings-quality-light', 'settings-summary-light', 'settings-info-claude-light', 'settings-mcp-light', 'settings-info-mcp-light', 'settings-mcp-running-light'];
// 0.11.1（計画 docs/plans/2026-10-24-logo.md の「取り直す画面（RETAKE）」）: 0.11.1 で取り直した画面（ADDED_LOGO）。版を 0.11.1 に上げる commit（LG-8）で、持ち主が
// 2026-10-25 にロゴの見比べを「OK（版を 0.11.1 に上げてよい）」と言ったので、CI run 40158349532（1c87b3c）・artifact 12585288773 の .after.png（139 枚）を
// バイトのまま基準にし、取り直し待ちを空に戻した
// LG-2（Ruling R8・R14）: 録音バーのロゴの path（録音バーの画面はどれもロゴを写す。RP9 のテストが 81 枚を見る）
const LG2_LOGO = SH.SCREENS.filter((s) => s.page === 'overlay').map((s) => s.name);
// LG-4（LG2・LG3）: サイドバーの頭のロゴを写す本体の窓の画面（サイドバーを畳んだ notes-collapsed-light と、200% で設定のポップアップがサイドバーを覆う
// settings-zoom200-dark・settings-record-zoom200-light・settings-info-zoom200-light のほかの 53 枚）と、会議の知らせのパネルの 5 枚
const LG4_LOGO = [
  'notes-empty-light', 'notes-page-light', 'notes-page-dark', 'dictation-light', 'settings-light', 'settings-dark', 'notes-tabs-light', 'live-light', 'live-dark',
  'notes-page-zoom200-light', 'search-palette-light', 'live-banner-light', 'live-banner-dark', 'live-banner-zoom200-dark', 'settings-record-light',
  'settings-search-light', 'settings-offline-light', 'live-quiet-light', 'live-quiet-dark', 'settings-quiet-search-light', 'settings-record-dark',
  'settings-summary-light', 'settings-account-light', 'settings-info-loop-light', 'settings-info-stt-dark', 'settings-info-claude-light', 'settings-info-search-light',
  'live-wave-light', 'live-wave-dark', 'live-silent-light', 'live-paused-dark', 'settings-detect-light', 'settings-detect-dark', 'live-offline-light',
  'live-offline-dark', 'live-late-light', 'live-late-dark', 'live-late-zoom200-light', 'settings-mcp-light', 'settings-info-mcp-light', 'page-menu-link-light',
  'page-menu-link-dark', 'list-select-light', 'list-select-dark', 'page-summary-lock-light', 'settings-mcp-running-light', 'page-type-light', 'page-type-dark',
  'page-type-undecided-light', 'live-type-light', 'page-quality-light', 'page-quality-dark', 'settings-quality-light', 'nudge-light-100', 'nudge-dark-100',
  'nudge-light-150', 'nudge-menu-light-100', 'nudge-menu-dark-100',
];
const ADDED_LOGO = [...LG2_LOGO, ...LG4_LOGO];
// 0.12.0（計画 docs/plans/2026-10-22-120.md の「取り直す画面（RETAKE）」）: 0.12.0 で取り直した画面（ADDED_120）。版を 0.12.0 に上げる commit（Task G）で、持ち主が
// 2026-10-25 に見比べを「OK（版を 0.12.0 に上げてよい）」と言ったので、CI run 40187063736（e580fca）・artifact 12596530760 の .after.png（14 枚）をバイトのまま基準にし、
// 取り直し待ちを空に戻した。SP-4（D53・D66）: 録音中のページの文字起こしの行の「自分」「相手」の札（13 枚）と、足した文字起こしのタブの画面（NEW_120）
const NEW_120 = ['notes-script-spk-light'];
const ADDED_120 = ['live-light', 'live-dark', 'live-banner-light', 'live-banner-dark', 'live-banner-zoom200-dark', 'live-quiet-light', 'live-quiet-dark',
  'live-wave-light', 'live-wave-dark', 'live-silent-light', 'live-paused-dark', 'live-offline-light', 'live-offline-dark', ...NEW_120];
// 0.12.1（計画 docs/plans/2026-10-24-121.md の「取り直す画面（RETAKE）」）: 0.12.1 で取り直した画面（ADDED_121）。版を 0.12.1 に上げる commit（LV-7）で、持ち主が
// 2026-10-25 に見比べを「OK（版を 0.12.1 に上げてよい）」と言ったので、CI run 40207175980（ba3387f）・artifact 12604106323 の .after.png（10 枚）をバイトのまま基準にし、
// 取り直し待ちを空に戻した。LV-4: ［設定］→［録音］のカード「会議の検出」に行「会議を出たら自動で止める」を足して変わった、そのカードと［録音］の下を写す画面と検索の画面
const ADDED_121 = ['settings-record-light', 'settings-record-dark', 'settings-record-zoom200-light', 'settings-detect-light', 'settings-detect-dark',
  'settings-search-light', 'settings-quiet-search-light', 'settings-info-loop-light', 'settings-info-stt-dark', 'settings-info-zoom200-light'];
// 0.13.0（計画 docs/plans/2026-10-24-130.md の「取り直す画面（RETAKE）」）で意図して変えた: 取り直し待ちは 0.13.0 の表の画面だけ（RETAKE_130）。RDY-3 で
// 録音の前のページの3枚（NEW_130。足した画面で、まだ基準が無い）を足した。ED-5 で / メニューの3枚を、ED-6 で ⠿ のメニューの1枚を、ED-7 で新しい型の3枚を足した
const NEW_130 = ['live-ready-light', 'live-ready-dark', 'live-ready-zoom200-light', 'edit-slash-light', 'edit-slash-dark', 'edit-slash-recent-light', 'edit-block-menu-light',
  'edit-types-light', 'edit-types-dark', 'edit-types-zoom150-light'];
// 2026-10-26 の持ち主の答え（問2「⠿ の左に並べる（Notion と同じ並び）」。計画の Ruling R36）で意図して変えた: 鍵の無い要約の行が見える今の画面は、
// 行の左の ＋ が行の並びに入って要約の文が約 22px 右へずれるので取り直す（RETAKEN_130。今の基準がある）
const RETAKEN_130 = ['notes-page-light', 'notes-page-dark', 'notes-tabs-light', 'notes-collapsed-light', 'search-palette-light', 'page-menu-link-light', 'page-menu-link-dark',
  'page-type-undecided-light', 'page-quality-light', 'page-quality-dark',
  'notes-page-zoom200-light'];   // CI run 40403886281: 窓に入らない要約の行の折り返しが増え、捲り棒のつまみが短くなる
const RETAKE_130 = [...NEW_130, ...RETAKEN_130];
const img = (w, h, fill = [255, 255, 255, 255]) => ({ width: w, height: h, data: Buffer.from(Array.from({ length: w * h }, () => fill).flat()) });
// 一時フォルダ（日本語と 𠮷 の名前。RF1 と同じ形）。テストの終わりに消す
const tmp = (t, name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `natsu-画面𠮷-${name}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

// 第1b回 Task C-1 で意図して変えた: 撮る画面は 7 から 13 へ（タブ・畳んだサイドバー・記録中のページの明暗・200% の2つ）
// 第1b2回 Task R-3 で意図して変えた: 最後に検索の窓の画面を足す（14）
// 第1d回 Task A-7（RL14・D17）で意図して変えた: 最後に録音中のページの帯の画面（live-banner-light）を足す（15）
// 第1d回 Task A-13（あとの直し (b)）で意図して変えた: 最後に帯の暗い画面（live-banner-dark）と 200% の暗い画面（live-banner-zoom200-dark）を足す（17）
// 0.9.0 O-3（設計書 D25・RP9）で意図して変えた: 録音バーの画面 overlay-processing を外し、録音バーの画面（pill-states の状態 × 形 × 地 × 拡大率の 80 枚）を最後に足した
test('G2: 撮る画面は決まった並び（第1b回の 13 と第1b2回の検索の窓と第1d回の録音中のページの帯の3枚から録音バーの1枚を外し、0.9.0 の録音バーの 80 枚）で、名前は重ならない', { timeout: 5000 }, () => {
  assert.deepStrictEqual(SH.SCREENS.filter((s) => s.page === 'app').map((s) => s.name), ['notes-empty-light', 'notes-page-light', 'notes-page-dark', 'dictation-light', 'settings-light', 'settings-dark',
    'notes-tabs-light', 'notes-collapsed-light', 'live-light', 'live-dark', 'notes-page-zoom200-light', 'settings-zoom200-dark', 'search-palette-light', 'live-banner-light',
    'live-banner-dark', 'live-banner-zoom200-dark',
    // 0.9.0 U-2（SP4・SP5）で意図して変えた: 設定のポップアップの項目「録音」と検索の画面を足した（取り直し待ち・まだ基準が無い）
    'settings-record-light', 'settings-search-light',
    // 0.9.0 U-3（OF7）で意図して変えた: 準備を選んでいない人のカード「オフライン」の画面を足した（取り直し待ち・まだ基準が無い）
    'settings-offline-light',
    // 0.9.1 Q-5 で意図して変えた: 「会議は終わりましたか？」の帯の2枚と、設定の検索「自動で止める」を足した（取り直し待ち・まだ基準が無い）
    'live-quiet-light', 'live-quiet-dark', 'settings-quiet-search-light',
    // 0.9.2 I-4 で意図して変えた: 設定の「録音」の暗い・200%・要約・アカウント、ⓘ の吹き出しを開いた4枚、吹き出しの中の言葉で当たる検索を足した（取り直し待ち・まだ基準が無い）
    ...I4_SCREENS_092,
    // 0.9.3 M-7 で意図して変えた: 音の波（話している・無音・一時停止）と設定の「会議の検出」を足した（取り直し待ち・まだ基準が無い）
    ...M7_APP_093,
    // 0.9.3 持ち主の答え D55 で意図して変えた: オフラインモードの録音中のページの明るい・暗いを足した（取り直し待ち・まだ基準が無い）
    ...D55_APP_093,
    // 0.9.4 S-8 で意図して変えた: 遅い会議の帯と区間（明暗・200%）を足した（取り直し待ち・まだ基準が無い）
    ...S8_APP_094,
    // 0.10.0 C-3 で意図して変えた: カード「Claude との連携（MCP）」まで捲った形と、その吹き出しを開いた形を足した（取り直し待ち・まだ基準が無い）。
    // L-1 で意図して変えた: ページのメニューを開いた明暗の2枚を足した。L-2 で一覧で2件を選んだ明暗の2枚を足した
    ...NEW_100,
    // 0.10.1 CD-3 で意図して変えた: 動いていたので断った文（RN1）の画面を足した（取り直し待ち・まだ基準が無い）
    ...NEW_101,
    // 0.11.0 V-1 で意図して変えた: 会議の種類の画面4枚を足した（取り直し待ち・まだ基準が無い）。V-2 で打ち合わせの質のカードの明暗2枚を、V-3 で設定のカード「打ち合わせの質」の1枚を足した
    ...NEW_110,
    // 0.12.0 SP-4 で意図して変えた: 文字起こしのタブの「自分」「相手」の札・重なり・文ごとの行の1枚を足した（版を 0.12.0 に上げる commit で基準にした）
    ...NEW_120,
    // 0.13.0 RDY-3 で意図して変えた: 録音の前のページの明暗と 200% の3枚を足した（取り直し待ち・まだ基準が無い）。ED-5 で / メニューの明暗と「最近使ったもの」の3枚を、ED-6 で ⠿ のメニューの1枚を、ED-7 で新しい型の明暗と 150% の3枚を足した
    ...NEW_130]);
  assert.deepStrictEqual(SH.SCREENS.filter((s) => s.page === 'overlay').map((s) => s.name), PS.screenNames());
  // 0.9.3 M-7 で意図して変えた: 会議の検出のパネル（page nudge）の5枚を録音バーのあと（いちばん後ろ）に足した
  assert.deepStrictEqual(SH.SCREENS.filter((s) => s.page === 'nudge').map((s) => s.name), M7_NUDGE_093);
  assert.deepStrictEqual(SH.SCREENS.slice(-M7_NUDGE_093.length).map((s) => s.name), M7_NUDGE_093, 'パネルの画面がいちばん後ろに無い');
  assert.ok(SH.SCREENS.findIndex((s) => s.page === 'overlay') > SH.SCREENS.map((s) => s.page).lastIndexOf('app'), '録音バーの画面が本体の画面の間にある');
  assert.strictEqual(new Set(SH.SCREENS.map((s) => s.name)).size, SH.SCREENS.length, '名前が重なっている');
  for (const s of SH.SCREENS) assert.ok(['app', 'overlay', 'nudge'].includes(s.page) && ['light', 'dark'].includes(s.theme), s.name);
  assert.deepStrictEqual(SH.SCREENS.filter((s) => s.zoom).map((s) => [s.name, s.zoom]), [['notes-page-zoom200-light', 2], ['settings-zoom200-dark', 2], ['live-banner-zoom200-dark', 2],
    ['settings-record-zoom200-light', 2], ['settings-info-zoom200-light', 2], ['live-late-zoom200-light', 2], ['live-ready-zoom200-light', 2],
    ['edit-types-zoom150-light', 1.5]]);   // 0.9.2 I-4・0.9.4 S-8・0.13.0 RDY-3・ED-7 で意図して足した
  const live = SH.SCREENS.find((s) => s.name === 'live-light');
  const st = live.answers['koeApp.meetingStatus'];
  assert.ok(st.active && st.cloud && st.pauses.length === 1, '記録中の画面に一時停止の印か［PC の中だけ］が出ない');
});

// 第1d回 Task A-7（RL14・D17）: 録音中のページの2枚は状態の行（クラウド・最後の文字 12 秒前）を出し、帯の画面は同じ会議に帯 relay-down（B8）を入れた形。
// 帯の文は main の STT_BANNER の文（画面は文を作らない）。撮るときの時計は FIXED_NOW に止まるので「12 秒前」は揺れない
test('D17: 録音中のページの画面の答えに stt。live-banner-light は live-light と同じ会議に帯 relay-down（文は main の B8・ボタン無し）', { timeout: 5000 }, () => {
  const st = (n) => SH.SCREENS.find((s) => s.name === n).answers['koeApp.meetingStatus'];
  for (const n of ['live-light', 'live-dark']) assert.deepStrictEqual(st(n).stt, { route: 'cloud', lastTextAt: SH.FIXED_NOW - 12000, segSec: 15, problem: null }, n);
  const b = SH.SCREENS.find((s) => s.name === 'live-banner-light');
  assert.strictEqual(b.page, 'app');
  assert.strictEqual(b.theme, 'light');
  assert.ok(!b.zoom && !b.act && !b.focus);
  const bs = st('live-banner-light');
  assert.deepStrictEqual({ ...bs, stt: undefined }, { ...st('live-light'), stt: undefined }, '帯の画面の会議が live-light と違う');
  assert.strictEqual(bs.stt.route, 'local');
  assert.strictEqual(bs.stt.problem.code, 'relay-down');
  assert.strictEqual(bs.stt.problem.action, '');
  const B8 = 'NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。';
  assert.strictEqual(bs.stt.problem.text, B8);
  assert.ok(read('src/main.js').includes(`'relay-down': () => '${B8}'`), '帯の文が main の STT_BANNER の B8 と違う');
});

// 0.9.4 S-8（計画 docs/plans/2026-10-22-094.md の「取り直す画面（決めた形）」）: 遅い会議の録音中のページ（live-light と同じ会議で、中継に落ちて PC の側になった形。
// 帯 kept-late・残した区間の「（文字起こし待ち: 会議の後で文字起こしします）」・一番下の「音声を残しています」）。文は main の文（画面は文を作らない）
test('0.9.4 S-8: live-late の3枚は同じ会議で帯 kept-late（文は main の STT_BANNER）と残した区間の文（main の SLOW_SEG_TEXT）と slow', { timeout: 5000 }, () => {
  const main = read('src/main.js');
  const late = SH.SCREENS.find((s) => s.name === 'live-late-light');
  assert.deepStrictEqual([late.page, late.theme, late.zoom, late.act], ['app', 'light', undefined, undefined]);
  for (const [n, theme, zoom] of [['live-late-dark', 'dark', undefined], ['live-late-zoom200-light', 'light', 2]]) {
    const s = SH.SCREENS.find((x) => x.name === n);
    assert.deepStrictEqual([s.page, s.theme, s.zoom], ['app', theme, zoom], n);
    assert.deepStrictEqual(s.answers, late.answers, `${n} の会議と帯が live-late-light と違う`);
  }
  const st = late.answers['koeApp.meetingStatus'];
  assert.deepStrictEqual([st.stt.route, st.stt.slow, st.stt.problem.code, st.stt.problem.action], ['local', true, 'kept-late', '']);
  const LATE = 'この PC の文字起こしが録音に追いつかないため、音声を残しています。会議が終わったら文字起こしします。録音はそのまま続けてください。';
  assert.strictEqual(st.stt.problem.text, LATE);
  assert.ok(main.includes(`: '${LATE}'),`), '帯の文が main の STT_BANNER の kept-late と違う');
  const SLOW = '（文字起こし待ち: 会議の後で文字起こしします）';
  assert.ok(main.includes(`const SLOW_SEG_TEXT = '${SLOW}';`));
  const kept = st.segments.filter((x) => x.failed);
  assert.ok(kept.length >= 1 && kept.every((x) => x.text === SLOW), JSON.stringify(st.segments));
  assert.ok(st.segments.some((x) => !x.failed && x.text), '文字になった区間も並べる');
  const live = SH.SCREENS.find((s) => s.name === 'live-light').answers['koeApp.meetingStatus'];
  const strip = (x) => ({ ...x, stt: undefined, segments: undefined });
  assert.deepStrictEqual(strip(st), strip(live), '会議が live-light と違う');
});

// 第1d回 Task A-13（あとの直し (b)）: 帯は注意の色（--danger）の枠と文字なので、暗い地と 200% の折り返しでも利用者に見てもらう。
// 2枚とも live-banner-light と同じ会議・同じ帯（B8）で、明暗と拡大だけが違う。
// 第1d回 G-4 で意図して変えた: 利用者が CI の新しい画像を見て OK と言ったので基準にした。取り直し待ちではなく、基準の PNG と比べる
// 0.9.0 B-1（BN1・D26）で意図して変えた: 帯の文を B8 の新しい文にしたので、帯の3枚を取り直し待ちにした（基準の PNG は 0.8.0 のまま残り、G-3 で取り直す）
// 0.9.0 G-3 で意図して変えた: 利用者が CI の新しい画像を見て OK と言ったので基準にした。取り直し待ちではなく、基準の PNG と比べる
test('あとの直し (b)・0.9.0 B-1・G-3: 撮る画面に live-banner-dark・live-banner-zoom200-dark があり、基準の PNG と比べる（取り直し待ちではない）。帯の画面は B8 の文', { timeout: 5000 }, () => {
  const B8 = 'NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。';
  const light = SH.SCREENS.find((s) => s.name === 'live-banner-light');
  for (const [n, zoom] of [['live-banner-dark', undefined], ['live-banner-zoom200-dark', 2]]) {
    const s = SH.SCREENS.find((x) => x.name === n);
    assert.ok(s, `${n} が撮る画面に無い`);
    assert.strictEqual(s.page, 'app', n);
    assert.strictEqual(s.theme, 'dark', n);
    assert.strictEqual(s.zoom, zoom, n);
    assert.ok(!s.act && !s.focus && !s.event, n);
    assert.deepStrictEqual(s.answers, light.answers, `${n} の会議と帯が live-banner-light と違う`);
    assert.strictEqual(s.answers['koeApp.meetingStatus'].stt.problem.text, B8, n);
    // 0.9.3 M-0 で意図して変えた: 0.9.3 の計画の表（RETAKE_093）にあるときだけ取り直し待ちでよい（ボタン［オフラインモード］）
    // 0.9.3 で意図して変えた（版を 0.9.3 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
    // 0.9.4 W-1 で意図して変えた: 0.9.4 の表（RETAKE_094）にあるときだけ取り直し待ちでよい（録音中のページの5つの点）
    // 0.9.4 で意図して変えた（版を 0.9.4 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
    // 0.10.0 SH-1 で意図して変えた: 0.10.0 の表（RETAKE_100）にあるときだけ取り直し待ちでよい（左の一覧の見本の題名）
    // 0.10.0 で意図して変えた（版を 0.10.0 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
    // 0.11.0 V-1 で意図して変えた: 0.11.0 の表（ADDED_110）にあるときだけ取り直し待ちでよい（録音中のページの種類の行と一言）
    // 0.11.0 で意図して変えた（版を 0.11.0 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
    // 0.11.1 LG-4 で意図して変えた: 0.11.1 の表（ADDED_LOGO）にあるときだけ取り直し待ちでよい（サイドバーの頭のロゴ）
    // 0.11.1 で意図して変えた（版を 0.11.1 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
    assert.ok(!SH.RETAKE.has(n) || ADDED_LOGO.includes(n), `${n} が取り直し待ちに残っている`);
    assert.ok(fs.existsSync(path.join(ROOT, 'test', 'shots', 'win32', `${n}.png`)), `${n} の基準が無い`);
  }
});

// 第1b回 Task C-2 で意図して変えた: 基準を取り直したので、検索の窓の画面は取り直し待ちではなく、基準の PNG と比べる（取り直し待ちが空であることは下の C-2 のテスト）
// 0.7.0 U-2 のレビューで名前を中身に合わせた（前の名前は「…取り直し待ちが残るなら録音バーのほかの全部（13）」。計画 ui07 の表の「取り直し待ちが残るなら 13」はこのテスト）
test('1b2 R-3・G12: 検索の窓の画面は窓を開く act を持ち、取り直し待ちに戻さない', { timeout: 5000 }, () => {
  const s = SH.SCREENS.find((x) => x.name === 'search-palette-light');
  assert.ok(s, '検索の窓の画面が撮る並びに無い');
  assert.match(s.act, /sideSearch/);
  // 0.7.0 U-2 で意図して変えた: 取り直し待ちは設定の3枚だけになった（下の U-2 のテスト。第1d回 A-4 でまた設定の3枚）。検索の窓は基準と比べる（取り直し待ちに戻さない）
  // 0.10.0 SH-1 で意図して変えた: 0.10.0 の表（RETAKE_100）にあるときだけ取り直し待ちでよい（結果の行の見本の題名）
  // 0.10.0 で意図して変えた（版を 0.10.0 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
  // 0.11.0 M-1 で意図して変えた: 0.11.0 の表（ADDED_110）にあるときだけ取り直し待ちでよい（窓の後ろのページの種類の名前）
  // 0.11.0 で意図して変えた（版を 0.11.0 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
  // 0.11.1 LG-4 で意図して変えた: 0.11.1 の表（ADDED_LOGO）にあるときだけ取り直し待ちでよい（窓の後ろのサイドバーの頭のロゴ）
  // 0.11.1 で意図して変えた（版を 0.11.1 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
  assert.ok(!SH.RETAKE.has('search-palette-light') || ADDED_LOGO.includes('search-palette-light'), '検索の窓の画面が取り直し待ちに戻った');
});

// 0.9.0 O-3 で意図して変えた: 録音バーは作り直した（D25）ので、O-3〜O-4 の間は録音バーの画面を取り直し待ちに入れてよい（G-3 で空にする）。
// 外した overlay-processing は撮る画面に無いので、取り直し待ちにも入れられない（下の「撮る画面に無い」）
test('F14: 取り直し待ち（RETAKE）の画面は違っても NG にしないが、撮る画面に無い名前は入れられず、揺れ・CSP・はみ出しは NG のまま', { timeout: 5000 }, () => {
  assert.ok(!SH.RETAKE.has('overlay-processing'), '外した録音バーの画面を取り直し待ちに入れた');
  for (const n of SH.RETAKE) assert.ok(SH.SCREENS.some((s) => s.name === n), `${n} は撮る画面に無い`);
  const cmp = [{ name: 'notes-page-light', status: 'diff', count: 9 }, { name: 'overlay-processing', status: 'same' }];
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake: new Set(['notes-page-light']) }), 0);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: [{ name: 'overlay-processing', status: 'diff', count: 1 }], retake: new Set(['notes-page-light']) }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake: new Set(['notes-page-light']), overflow: [{ name: 'notes-page-light', ok: false }] }), 1);
  // 揺れ・CSP の違反・撮れなかった画面・速さの NG は、取り直し待ちの画面でも NG（足した: 計画の目的の「RETAKE でも NG」の残り）
  const retake = new Set(['notes-page-light']);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, flaky: ['notes-page-light'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, csp: ['app: Refused to execute inline script'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, errors: ['notes-page-light: 撮れなかった'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, perf: [{ name: 'open-2000-blocks', ms: 600, ok: false }] }), 1);
  // Tab の輪の NG は、取り直し待ちでない画面では NG（取り直し待ちの間は骨組みが変わる途中なので参考に出すだけ）
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, focus: [{ name: 'notes-page-light', ok: false }] }), 0);
  // 比べた結果は全部「同じ」にして、Tab の輪の NG だけで 1 になることを見る（違う画面が混ざると、輪を見なくても 1 になる）
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp.map((c) => ({ ...c, status: 'same' })), retake: new Set(), focus: [{ name: 'notes-page-light', ok: false }] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp.map((c) => ({ ...c, status: 'same' })), focus: [{ name: 'notes-page-light', ok: true }], overflow: [{ name: 'notes-page-light', ok: true }] }), 0);
});

test('F11: 横のはみ出しの判定（scrollWidth が clientWidth を越える・右端が窓の外の要素がある）', { timeout: 5000 }, () => {
  assert.deepStrictEqual(SH.judgeOverflow({ sw: 560, cw: 560, offenders: [] }).ok, true);
  assert.deepStrictEqual(SH.judgeOverflow({ sw: 600, cw: 560, offenders: [] }).ok, false);
  assert.deepStrictEqual(SH.judgeOverflow({ sw: 560, cw: 560, offenders: ['button#pMore'] }).ok, false);
  assert.match(SH.OVERFLOW_PROBE, /scrollWidth/);
  assert.strictEqual(SH.judgeOverflow(null).ok, false, '計れなかったのを OK にした');
});

test('F11: はみ出しを集める文（OVERFLOW_PROBE）を偽の画面で走らせる — 窓の外へ出た要素だけを集め、祖先で切られた・隠れた要素は数えない', { timeout: 5000 }, () => {
  const vm = require('node:vm');
  const el = (tag, id, cls, rect, style = {}, parent = null) => ({ tagName: tag.toUpperCase(), id, className: cls, rect, style, parentElement: parent, getBoundingClientRect: () => rect });
  const body = el('body', '', '', { left: 0, right: 560, width: 560, height: 700 }, { overflowX: 'visible' });
  const scroller = el('div', 'tabbar', 'tabs', { left: 0, right: 560, width: 560, height: 30 }, { overflowX: 'auto' }, body);
  const inScroll = el('button', '', 'tab', { left: 500, right: 700, width: 200, height: 30 }, {}, scroller);   // 横に流れる帯の中（切られる）
  const out = el('button', 'pMore', '', { left: 520, right: 620, width: 100, height: 30 }, {}, body);       // 窓の外へ出た
  const hidden = el('div', 'x', '', { left: 0, right: 900, width: 900, height: 10 }, { visibility: 'hidden' }, body);
  const empty = el('span', '', '', { left: 0, right: 0, width: 0, height: 0 }, {}, body);
  const doc = { documentElement: { scrollWidth: 600, clientWidth: 560 }, body, querySelectorAll: () => [scroller, inScroll, out, hidden, empty] };
  const win = { innerWidth: 560, getComputedStyle: (e) => ({ overflowX: 'visible', visibility: 'visible', display: 'block', position: 'static', ...e.style }) };
  const r = vm.runInNewContext(SH.OVERFLOW_PROBE, { document: doc, window: win, getComputedStyle: win.getComputedStyle });
  assert.deepStrictEqual([r.sw, r.cw, Array.from(r.offenders)], [600, 560, ['button#pMore']]);
  assert.strictEqual(SH.judgeOverflow(r).ok, false);
});

test('F12: Tab の輪の判定（決めた id にフォーカスがあり、outline が none でない）', { timeout: 5000 }, () => {
  const s = SH.SCREENS.find((x) => x.focus);
  // 第1b回 載せ直し: B-2 でサイドバーの頭に［«］が入り、［● 記録開始］は Tab 3 回目（«→ 検索 → 記録開始）。下の「Tab を何回」のテストが今の順と照らす
  assert.deepStrictEqual([s.name, s.focus.tabs, s.focus.want], ['notes-page-light', 3, 'mtToggleBtn']);
  assert.deepStrictEqual(SH.SCREENS.filter((x) => x.focus).map((x) => x.name), ['notes-page-light']);
  assert.strictEqual(SH.judgeFocus({ id: 'mtToggleBtn', outline: 'solid' }, s.focus).ok, true);
  assert.strictEqual(SH.judgeFocus({ id: 'mtToggleBtn', outline: 'none' }, s.focus).ok, false);
  assert.strictEqual(SH.judgeFocus({ id: '', outline: 'none' }, s.focus).ok, false);
  assert.strictEqual(SH.judgeFocus({ id: 'tabBtnDictation', outline: 'solid' }, s.focus).ok, false);
  assert.strictEqual(SH.judgeFocus({ id: 'searchBox', outline: 'solid' }, s.focus).ok, false);
  assert.strictEqual(SH.judgeFocus(null, s.focus).ok, false);
});

test('F11: 拡大の画面は、撮る前に窓の中の幅が「窓の幅 ÷ 倍率」になっている（画面の外で描く窓で拡大が効いたか）', { timeout: 5000 }, () => {
  assert.strictEqual(SH.judgeZoom(560, 2).ok, true);
  assert.strictEqual(SH.judgeZoom(1120, 2).ok, false);
  assert.strictEqual(SH.judgeZoom(1120, 1).ok, true);
  assert.strictEqual(SH.judgeZoom(undefined, 2).ok, false);
});

test('G2: 画面ごとの答えの名前も、本物の preload.js にあるものだけ', { timeout: 5000 }, () => {
  const names = SH.apiNamesOf(read('src/preload.js'));
  for (const s of SH.SCREENS) for (const key of Object.keys(s.answers || {})) {
    const [bridge, fn] = key.split('.');
    assert.ok(names[bridge] && names[bridge].includes(fn), `${s.name}: ${key}`);
  }
});

// 0.9.0 O-3 で意図して変えた: 第1a回の録音バーの基準（overlay-processing.png）は、録音バーを作り直した（D25）ので外した。新しい録音バーの基準は
// 利用者が CI の画像を見て OK と言った後に G-3 で置く（それまでは録音バーの画面は全部取り直し待ち）
// 0.9.0 G-3 で意図して変えた: 利用者が CI の録音バーの 81 枚（run 39496101442・artifact 12297628165 の .after.png）を見て OK と言ったので、バイトのまま
// 基準にした。どの録音バーの画面にも基準があり、取り直し待ちではない。基準の大きさは「main と同じ panelBounds の窓 × 拡大率」で（撮る道具の
// shotSizeFor・panelWindowFor）、ピルの太さは形の初めの太さ（PANEL_FIRST）+ 余白、明るい地と暗い地で同じ大きさ
test('G2・F14・RP9・G-3: 第1a回の録音バーの画面と基準は無い。録音バーの画面にはどれも基準があり、大きさは panelBounds の窓 × 拡大率で、地で変わらない', { timeout: 5000 }, () => {
  assert.ok(!SH.SCREENS.some((s) => s.name === 'overlay-processing'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'test', 'shots', 'win32', 'overlay-processing.png')), '外した画面の基準が残っている');
  const byDesk = new Map();
  for (const s of SH.SCREENS.filter((x) => x.page === 'overlay')) {
    // 0.9.4 W-1 で意図して変えた: 0.9.4 の表（RETAKE_094）にあるときだけ取り直し待ちでよい（録音バーの5本の揺れ）
    // 0.9.4 で意図して変えた（版を 0.9.4 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
    // 0.11.1 LG-2 で意図して変えた: 0.11.1 の表（ADDED_LOGO）にあるときだけ取り直し待ちでよい（録音バーのロゴ）
    // 0.11.1 で意図して変えた（版を 0.11.1 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
    assert.ok(!SH.RETAKE.has(s.name) || ADDED_LOGO.includes(s.name), `${s.name} が取り直し待ちに残っている`);
    const f = path.join(ROOT, 'test', 'shots', 'win32', `${s.name}.png`);
    assert.ok(fs.existsSync(f), `${s.name} の基準が無い`);
    const im = P.decodePng(fs.readFileSync(f));
    const k = s.scale || 1;
    const win = { width: Math.round(im.width / k), height: Math.round(im.height / k) };
    assert.deepStrictEqual(SH.shotSizeFor(win, k), { width: im.width, height: im.height }, `${s.name}: 窓 × 拡大率 ${k} の大きさでない`);
    assert.deepStrictEqual(SH.panelWindowFor({ w: win.width - 2 * lib.PANEL_PAD, h: win.height - 2 * lib.PANEL_PAD }, s.slot), win, `${s.name}: panelBounds の窓の大きさでない`);
    const thick = s.pill.form === 'v' ? [win.width, lib.PANEL_FIRST.v.w] : [win.height, lib.PANEL_FIRST.h.h];
    assert.strictEqual(thick[0], thick[1] + 2 * lib.PANEL_PAD, `${s.name}: ピルの太さが形の太さでない`);
    const key = `${s.pill.form}|${s.pill.state}|${k}|${s.pill.hover ? 'hover' : ''}`;
    if (byDesk.has(key)) assert.deepStrictEqual([im.width, im.height], byDesk.get(key), `${s.name}: 明るい地と暗い地で大きさが違う`);
    else byDesk.set(key, [im.width, im.height]);
  }
});

// 0.7.0 U-2 で意図して変えた: 今の版は 0.6.0。取り直し待ち（設定の3枚）が残る間は 0.7.0 に上げさせない（利用者が新しい画像を見る前に出さない）。
// 第1d回 A-4 で意図して変えた: 今の版は 0.7.0。取り直し待ち（設定の3枚。A-7 で録音中のページの3枚も）が残る間は 0.8.0 に上げさせない
// （G-2 で版を上げる前に、利用者が CI の新しい画像を見て OK と言い、基準にして空に戻す）
// 第1d回 G-4 で意図して変えた: 利用者が8枚を OK と言ったので取り直し待ちを空にし、版を 0.8.0 にした。次の版も、取り直し待ちが残る間は 0.8.0 のまま
// 0.9.0 G-3 で意図して変えた: 利用者が取り直しの画像を OK と言ったので取り直し待ちを空にし、版を 0.9.0 にした。次の版も、取り直し待ちが残る間は 0.9.0 のまま
// 0.9.1 で意図して変えた: 利用者が取り直しの 12 枚を OK と言ったので取り直し待ちを空にし、版を 0.9.1 にした。次の版も、取り直し待ちが残る間は 0.9.1 のまま
// 0.9.2 で意図して変えた: 利用者が取り直しの 16 枚を OK と言ったので取り直し待ちを空にし、版を 0.9.2 にした。次の版も、取り直し待ちが残る間は 0.9.2 のまま
// 0.9.3 で意図して変えた: 持ち主が取り直しの 36 枚を OK と言ったので取り直し待ちを空にし、版を 0.9.3 にした。次の版も、取り直し待ちが残る間は 0.9.3 のまま
// 0.9.4 で意図して変えた: 持ち主が取り直しの見比べを OK と言ったので取り直し待ちを空にし、版を 0.9.4 にした。次の版も、取り直し待ちが残る間は 0.9.4 のまま
// 0.10.0 で意図して変えた: 持ち主が取り直しの見比べ（46 枚）を「OK」と言ったので取り直し待ちを空にし、版を 0.10.0 にした。次の版も、取り直し待ちが残る間は 0.10.0 のまま
// 0.10.1 で意図して変えた: 持ち主が取り直しの画像（1 枚）を「OK」と言ったので取り直し待ちを空にし、版を 0.10.1 にした。次の版も、取り直し待ちが残る間は 0.10.1 のまま
// 0.11.0 で意図して変えた: 持ち主が取り直しの見比べ（37 枚）を「OK」と言ったので取り直し待ちを空にし、版を 0.11.0 にした。次の版も、取り直し待ちが残る間は 0.11.0 のまま
// 0.11.1 で意図して変えた: 持ち主がロゴの見比べ（139 枚）を「OK」と言ったので取り直し待ちを空にし、版を 0.11.1 にした。次の版も、取り直し待ちが残る間は 0.11.1 のまま
// 0.12.0 で意図して変えた: 持ち主が取り直しの見比べ（14 枚）を「OK」と言ったので取り直し待ちを空にし、版を 0.12.0 にした。次の版も、取り直し待ちが残る間は 0.12.0 のまま
// 0.12.1 で意図して変えた: 持ち主が取り直しの見比べ（10 枚）を「OK」と言ったので取り直し待ちを空にし、版を 0.12.1 にした。次の版も、取り直し待ちが残る間は 0.12.1 のまま
test('F14: 取り直し待ちが残っている間は、版を上げられない（取り直し待ちのまま次の版を出さない）', { timeout: 5000 }, () => {
  if (SH.RETAKE.size) assert.strictEqual(JSON.parse(read('package.json')).version, '0.12.1', `取り直し待ち ${[...SH.RETAKE].join(',')} を残したまま版を上げた`);
});

test('tools/shots/main.js は画面ごとの答え・拡大・はみ出し・Tab を使う', { timeout: 5000 }, () => {
  const m = read('tools/shots/main.js');
  for (const s of ['s.answers', 'setZoomFactor(', 'SH.OVERFLOW_PROBE', 'sendInputEvent(', 'SH.RETAKE']) assert.ok(m.includes(s), s);
  // つなぎ方そのもの: はみ出し・Tab の輪を終わりの答えに渡す、はみ出しは app の画面で見る、拡大の NG は errors に入れる、拡大と答えを本当に使う
  // 0.9.0 O-3（F11）で意図して変えた: 終わりの答えに録音バーの余白（panel）も渡す
  for (const s of [
    'retake: SH.RETAKE, overflow, focus, panel })',
    'if (!z.ok) errors.push(',
    'wc.setZoomFactor(zoom)',
    '...JSON.parse(JSON.stringify(s.answers || {}))',
  ]) assert.ok(m.includes(s), s);
  assert.match(m, /if \(s\.page === 'app'\) \{\s*const j = SH\.judgeOverflow\(await within\(o\.wc\.executeJavaScript\(SH\.OVERFLOW_PROBE\)/, 'はみ出しを app の画面で見ていない');
});

test('G2: 偽の橋の名前は、本物の preload.js から取ったものと同じ（simrun と同じ結果）。見本の答えは、その名前のものだけ', { timeout: 5000 }, () => {
  const src = read('src/preload.js');
  assert.deepStrictEqual(SH.apiNamesOf(src), preloadApis(src));
  const names = SH.apiNamesOf(src);
  for (const key of Object.keys(SH.fixtures())) {
    const [bridge, fn] = key.split('.');
    assert.ok(names[bridge] && names[bridge].includes(fn), key);
  }
  const fx = JSON.stringify(SH.fixtures());
  assert.ok(!/\d{4}-\d\d-\d\d/.test(fx) || /2026-10-01/.test(fx), '見本の日付は決まった過去の日にする');
});

test('G2・F9: 比べる — 基準が無い・大きさが違う・1画素違う・同じ、を分け、違えば前・後・差分の PNG を書く', { timeout: 5000 }, (t) => {
  const base = tmp(t, 'base');
  const out = tmp(t, 'out');
  const same = img(4, 3);
  const one = img(4, 3);
  one.data[0] = 0;   // 左上の1画素の赤だけ違う
  fs.writeFileSync(path.join(base, 'b.png'), P.encodePng(same));
  fs.writeFileSync(path.join(base, 'c.png'), P.encodePng(same));
  fs.writeFileSync(path.join(base, 'd.png'), P.encodePng(img(5, 3)));
  const r = SH.compareAll({ baseDir: base, outDir: out, shots: { a: same, b: one, c: same, d: same }, png: P, fs });
  assert.deepStrictEqual(r.map((x) => [x.name, x.status]), [['a', 'missing'], ['b', 'diff'], ['c', 'same'], ['d', 'size']]);
  assert.strictEqual(r[1].count, 1);
  for (const f of ['a.after.png', 'b.before.png', 'b.after.png', 'b.diff.png', 'd.before.png', 'd.after.png', 'd.diff.png']) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.ok(!fs.existsSync(path.join(out, 'c.after.png')), '同じ画面の画像まで書いた');
  assert.strictEqual(SH.exitCodeOf({ compare: r }), 1);
  assert.strictEqual(SH.exitCodeOf({ compare: r.filter((x) => x.status === 'same') }), 0);
});

test('F9: 同じ画面を2回撮って違えば「揺れる」で NG。揺れ・CSP の違反・速さの NG があれば終了コードは 1', { timeout: 5000 }, () => {
  const a = img(2, 2);
  const b = img(2, 2);
  b.data[5] = 9;
  assert.deepStrictEqual(SH.judgePair(a, img(2, 2), P).ok, true);
  assert.deepStrictEqual(SH.judgePair(a, b, P).ok, false);
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'], flaky: ['x'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'], csp: ['Refused to execute inline script'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'], perf: [{ name: 'open-2000-blocks', ms: 600, ok: false }] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'] }), 0);
  assert.strictEqual(SH.exitCodeOf({ shots: [] }), 1, '1枚も撮れていないのに 0');
  // 撮れなかった画面（errors）があれば、残りが撮れていても・残りが基準と全部同じでも 1（「比べる物が無いのに緑」にしない）
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'], errors: ['y: 撮れなかった'] }), 1, '撮れなかった画面を見ていない');
  assert.strictEqual(SH.exitCodeOf({ compare: [{ name: 'a', status: 'same' }], errors: ['b: 比べる画像が無い'] }), 1, '比べられなかった画面を見ていない');
});

test('F6: CSP に断られた行を見分ける（自分のインラインの script が止まると画面が真っ白になる）', { timeout: 5000 }, () => {
  assert.strictEqual(SH.cspViolation(3, "Refused to execute inline script because it violates the following Content Security Policy directive: \"script-src 'sha256-x'\"."), true);
  assert.strictEqual(SH.cspViolation(2, 'Electron Security Warning (Insecure Content-Security-Policy)'), false);
  assert.strictEqual(SH.cspViolation(3, 'Uncaught TypeError: x'), false);
  // Electron 44.9.0（Chromium 152）が実際に出す形（作業環境の xvfb で、差し込んだ script を止めたときの行）。「Refused to」で始まらない
  assert.strictEqual(SH.cspViolation('error', "Executing inline script violates the following Content Security Policy directive 'script-src 'sha256-x''. Either the 'unsafe-inline' keyword, a hash ('sha256-y'), or a nonce ('nonce-...') is required to enable inline execution. The action has been blocked."), true);
});

test('F9: 撮る画面は時計・時間帯・アニメーションを止めて撮る（基準を取った次の日に「N日超過」が変わって赤にならない）', { timeout: 5000 }, () => {
  assert.strictEqual(new Date(SH.FIXED_NOW).toISOString(), '2026-10-18T00:00:00.000Z');
  assert.strictEqual(SH.TIME_ZONE, 'Asia/Tokyo');
  assert.match(SH.FREEZE_CSS, /transition:none!important/);
  assert.match(SH.FREEZE_CSS, /animation:none!important/);
  const pre = read('tools/shots/preload.js');
  assert.ok(pre.includes('contextBridge.executeInMainWorld(') && pre.includes('static now()'), '画面の時計を止めていない');
  const m = read('tools/shots/main.js');
  assert.ok(m.includes("'Emulation.setTimezoneOverride'") && m.includes('insertCSS('), '時間帯かアニメーションを止めていない');
  const fx = JSON.stringify(SH.fixtures());
  for (const d of fx.match(/\d{4}-\d\d-\d\d/g) || []) assert.ok(d < '2026-10-18', `見本の日付 ${d} が止めた時計より後`);
});

// preload.js の executeInMainWorld に渡す func の矢印関数を、func: から括弧を数えて取り出す（見本の文字列に括弧は無い）
function preloadFuncSource() {
  const pre = read('tools/shots/preload.js');
  const start = pre.indexOf('func:');
  assert.ok(start >= 0, 'preload.js に func: が無い');
  const from = pre.indexOf('(', start);
  const open = pre.indexOf('{', pre.indexOf('=>', from));
  let depth = 0;
  for (let i = open; i < pre.length; i++) {
    if (pre[i] === '{') depth++;
    else if (pre[i] === '}' && --depth === 0) return pre.slice(from, i + 1);
  }
  throw new Error('func: の括弧が閉じていない');
}

test('F9: preload の時計の止め方を本当に走らせる — 画面の Date が FIXED_NOW を返し、日付を渡した Date は変えない。機器の名前は見本', { timeout: 5000 }, async () => {
  const vm = require('node:vm');
  const md = { enumerateDevices: () => Promise.resolve([{ kind: 'audioinput', label: '本物のマイク' }]), getUserMedia: () => Promise.reject(new Error('本物')) };
  const w = { navigator: { mediaDevices: md } };
  vm.runInNewContext(`(${preloadFuncSource()})`, { window: w, navigator: w.navigator })(SH.FIXED_NOW);
  assert.strictEqual(typeof w.Date, 'function', '止めた Date を画面の世界に入れていない');
  assert.strictEqual(new w.Date().getTime(), SH.FIXED_NOW);
  assert.strictEqual(w.Date.now(), SH.FIXED_NOW);
  assert.strictEqual(new w.Date('2026-10-01T00:00:00.000Z').toISOString(), '2026-10-01T00:00:00.000Z');
  const list = await md.enumerateDevices();
  assert.deepStrictEqual(Array.from(list, (d) => d.label), [  // 画面の世界の配列なので、こちらの配列に写して比べる
    '既定 - マイク（見本）', 'マイク（見本）', '既定 - スピーカー（見本）']);
  assert.strictEqual((await md.getUserMedia({ audio: true })).getTracks().length, 0);
});

test('F9: 基準との比べは色の差 2 までを同じとみなす（CI の機械ごとの1段の差）。3 以上は違いとして数える。揺れの確かめは差を許さない', { timeout: 5000 }, (t) => {
  const base = tmp(t, 'tol');
  const out = tmp(t, 'tolout');
  fs.writeFileSync(path.join(base, 'a.png'), P.encodePng(img(2, 2)));
  fs.writeFileSync(path.join(base, 'b.png'), P.encodePng(img(2, 2)));
  const near = img(2, 2); near.data[0] = 253;
  const far = img(2, 2); far.data[0] = 252;
  const r = SH.compareAll({ baseDir: base, outDir: out, shots: { a: near, b: far }, png: P, fs });
  assert.deepStrictEqual(r.map((x) => [x.name, x.status]), [['a', 'same'], ['b', 'diff']]);
  assert.strictEqual(SH.TOLERANCE, 2);
  assert.strictEqual(SH.judgePair(img(2, 2), near, P).ok, false, '揺れの確かめが差を許した');
});

test('PERF: 2,000 ブロックのページと 1万行の文字起こしを開くのは 0.5 秒まで（3回の中央値）', { timeout: 5000 }, () => {
  assert.deepStrictEqual(SH.PERF, [{ name: 'open-2000-blocks', budgetMs: 500 }]);
  assert.strictEqual(SH.median([900, 410, 420]), 420);
  assert.deepStrictEqual(SH.judgePerf([{ name: 'open-2000-blocks', ms: 420 }]).map((x) => x.ok), [true]);
  assert.deepStrictEqual(SH.judgePerf([{ name: 'open-2000-blocks', ms: 501 }]).map((x) => x.ok), [false]);
  const big = SH.bigPage();
  assert.strictEqual(big.page.blocks.length, 2000);
  assert.strictEqual(big.segments.length, 10000);
});

test('ci.yml の electron-smoke: 小さなアプリの後に画面を撮り、撮った画像をいつも artifact に上げる', { timeout: 5000 }, () => {
  const st = stepsOf(jobsOf(read('.github/workflows/ci.yml'))['electron-smoke']);
  const iSmoke = st.findIndex((s) => /electron\.exe tools\/electron-smoke$/m.test(s));
  const iShots = st.findIndex((s) => /node_modules\/electron\/dist\/electron\.exe tools\/shots (--compare test\/shots\/win32 )?--out "\$RUNNER_TEMP\/shots"/.test(s));
  const iUp = st.findIndex((s) => /uses: actions\/upload-artifact@v4/.test(s));
  assert.ok(iSmoke >= 0 && iShots > iSmoke && iUp > iShots, `${iSmoke},${iShots},${iUp}`);
  assert.match(st[iUp], /^\s*if: always\(\)$/m);
  assert.match(st[iUp], /path: \$\{\{ runner\.temp \}\}\/shots/);
});

test('tools/shots/main.js は electron を boot() の中だけで読む（npm test が require しても本体を落としにいかない。第0c回 C6）', { timeout: 5000 }, () => {
  const m = read('tools/shots/main.js');
  assert.ok(m.includes("if (process.versions.electron && process.type === 'browser') boot();"));
  assert.ok(!/^const .*require\('electron'\)/m.test(m));
  assert.ok(m.includes("require('../../src/security')") && m.includes('security.install('));
  assert.ok(m.includes("require('../png')") && !m.includes('toBitmap('), 'PNG は自作の部品で読む（toBitmap の並びは版ごとに変わる）');
});

test('G2: 作業域より大きい窓が作るときに縮められても（Windows の CI の画面は 1024x768）、撮る前に決めた大きさへ戻す', { timeout: 5000 }, () => {
  const fake = (w, h) => {
    const calls = [];
    return { calls, getContentSize: () => [w, h], setContentSize: (...a) => { calls.push(a); } };
  };
  const shrunk = fake(1024, 720);
  assert.strictEqual(SH.ensureContentSize(shrunk, SH.SIZE), true);
  assert.deepStrictEqual(shrunk.calls, [[SH.SIZE.width, SH.SIZE.height]]);
  const right = fake(SH.OVERLAY_SIZE.width, SH.OVERLAY_SIZE.height);
  assert.strictEqual(SH.ensureContentSize(right, SH.OVERLAY_SIZE), false);
  assert.deepStrictEqual(right.calls, []);
  // main は窓を作った直後（ページを開く前）に呼ぶ
  const m = read('tools/shots/main.js');
  const made = m.indexOf('new BrowserWindow(');
  const fix = m.indexOf('SH.ensureContentSize(win, size)');
  assert.ok(made >= 0 && fix > made && fix < m.indexOf("wc.loadURL('about:blank')"), '窓を作った直後に大きさを決め直していない');
});

// 第1b回 Task C-2（G2・F14）: C-1 で緩めた確かめを元の「全部ある」に戻した（第1b2回の検索の窓 search-palette-light も、もう取り直し待ちの新しい画面ではない）。
// 13 枚は Windows の CI（run 39150265077・c823b81）が撮った画像。利用者が 2026-10-19 に見て OK と言った
// 0.7.0 U-2（設計書 D8）で意図して変えた: 設定のいちばん上に「外観」を足し、「オンライン」のカードを D5 の形にしたので、設定の3枚を取り直し待ちにした。
// 利用者が 2026-10-19 に CI の新しい3枚（run 39243734668・artifact 12183195820）を見て OK と言ったので、その画像を基準にして取り直し待ちを空に戻した（第1b回 C-2 と同じ手順）
// 第1d回 A-4（RL10・F11）で意図して変えた: 設定の2つ目に「アカウント」のカードを足し、「オンライン」のカードの説明を替えて［詳細設定（管理者用）］を
// 消したので、設定の3枚を取り直し待ちにした（計画の「意図して変えるもの」の RETAKE の行）。CI は「取り直し待ち」と出して NG にしない。
// 利用者が CI の新しい3枚を見て OK と言ったら、その画像を基準にして取り直し待ちを空に戻す（0.8.0 を出す前。上の版のテスト）
// 第1d回 A-7（RL14・D17）で意図して変えた: 録音中のページに文字起こしの状態の行と帯を足したので、録音中のページの2枚（live-light・live-dark）と、
// 足した帯の画面（live-banner-light）を取り直し待ちにした（6枚）。live-banner-light はまだ基準の PNG が無い（CI は比べで「missing」を
// 取り直し待ちとして NG にしない）。基準が無くてよいのはこの1枚だけで、取り直し待ちにあるときだけ（第1b回 C-1 と同じ形。基準にしたら下の NEW を空にする）
// 第1d回 A-13（あとの直し (b)）で意図して変えた: 帯の暗い画面（live-banner-dark）と 200% の暗い画面（live-banner-zoom200-dark）を足して取り直し待ちにした（8枚）。
// 設定の3枚はカード「エンジン」を「オフライン」にした（D19）ので取り直し待ちのまま、録音中のページの3枚は［この会議は PC の中だけ］を1行目にした（D20）ので
// 取り直し待ちのまま。基準が無くてよいのは取り直し待ちにある帯の3枚（live-banner-*）だけ
// 第1d回 G-4 で意図して変えた: 利用者が 2026-10-20 に CI の新しい8枚（run 39398639423・artifact 12252523286 の .after.png）を見て OK と言ったので、
// その画像をバイトのまま基準にして取り直し待ちを空に戻した（0.7.0 U-2・第1b回 C-2 と同じ手順）。帯の3枚の「基準が無くてよい」の例外も外した
// 0.9.0 で意図して変えた: 取り直し待ちは計画（docs/plans/2026-10-20-090.md）の「取り直す画面」の表の画面だけ。B-1 は帯の3枚（U・O は各タスクが足す）。
// 利用者がまとめて OK と言ったら G-3 で基準にして空に戻す（空になるまで版を上げられない: 下の版のテスト）
// 0.9.0 で意図して変えた: 取り直し待ちは計画（docs/plans/2026-10-20-090.md）の「取り直す画面」の表の画面だけ。U-1 は設定の3枚と
// notes-tabs-light（設定がポップアップになり、3つのタブの並びから設定のタブが消える）。B・O は各タスクが足す。
// 利用者がまとめて OK と言ったら G-3 で基準にして空に戻す（空になるまで版を上げられない: 上の版のテスト）
// 0.9.0 G-3 で意図して変えた: 利用者が 2026-10-20 に CI の取り直しの画像（run 39496101442（ed9365a）・artifact 12297628165 の .after.png。計画の
// 「取り直す画面」の全部: 本体の 10 枚と録音バーの 81 枚）を見て OK と言ったので、その画像をバイトのまま基準にして取り直し待ちを空に戻した
// （第1d回 G-4 と同じ手順）。計画の表の画面（前の RETAKE_090）と、0.9.0 で足した画面の「取り直し待ちの間は基準が無くてよい」の例外（前の NEW_090）は外した

// 0.9.0 U-3（OF7・D21）: 準備を選んでいない人のカード「オフライン」の画面。偽の答えは engine:status の chosen が偽・取り込みの欄は
// まだ取り込んでいず押したことも無い（consent 偽・missing）・空き 20GB。ログインしている形（していないと起動で「アカウント」が開く）
// 0.9.0 G-3 で意図して変えた: 利用者が CI の画像を見て OK と言ったので基準にした。取り直し待ちではなく、基準の PNG と比べる
test('U-3・G-3: settings-offline-light は基準の PNG と比べる（取り直し待ちではない）。答えは chosen 偽・consent 偽の missing・空き 20GB・ログイン中で、項目「オフライン」を開く', { timeout: 5000 }, () => {
  // 0.9.2 I-1 で意図して変えた: 0.9.2 の計画の表（RETAKE_092）にあるときだけ取り直し待ちでよい（［ヘルプ］と I-3 のオフラインの頭の説明）
  // 0.9.2 で意図して変えた（版を 0.9.2 に上げる commit）: 利用者が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
  // 0.9.3 M-0 で意図して変えた: 0.9.3 の計画の表（RETAKE_093）にあるときだけ取り直し待ちでよい（項目の名前「ローカル AI」）
  // 0.9.3 で意図して変えた（版を 0.9.3 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
  // 0.9.4 R-1 で意図して変えた: 0.9.4 の表（RETAKE_094）にあるときだけ取り直し待ちでよい（左の列の名前「ローカル AI」）
  // 0.9.4 で意図して変えた（版を 0.9.4 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
  // 0.10.0 SH-1 で意図して変えた: 0.10.0 の表（RETAKE_100）にあるときだけ取り直し待ちでよい
  // 0.10.0 で意図して変えた（版を 0.10.0 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
  // 0.11.1 LG-4 で意図して変えた: 0.11.1 の表（ADDED_LOGO）にあるときだけ取り直し待ちでよい（ポップアップの後ろのサイドバーの頭のロゴ）
  // 0.11.1 で意図して変えた（版を 0.11.1 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
  assert.ok(!SH.RETAKE.has('settings-offline-light') || ADDED_LOGO.includes('settings-offline-light'), '準備を選んでいない人のカードの画面が取り直し待ちに残っている');
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'shots', 'win32', 'settings-offline-light.png')), '準備を選んでいない人のカードの画面の基準が無い');
  const s = SH.SCREENS.find((x) => x.name === 'settings-offline-light');
  assert.ok(s, '撮る画面に無い');
  assert.deepStrictEqual([s.page, s.theme, s.zoom], ['app', 'light', undefined]);
  const a = s.answers;
  assert.strictEqual(a['koeApp.engineStatus'].chosen, false);
  assert.match(a['koeApp.engineStatus'].whisper, /まだ取り込んでいません/);
  const f = a['koeApp.engineFetchStatus'];
  // 0.10.0 LS-3（D59）で意図して直した: 組は文字起こしだけ（sumReady・mode.sum が無い）
  assert.deepStrictEqual([f.state, f.consent, f.freeBytes, f.whisperReady, 'sumReady' in f, f.mode], ['missing', false, 20e9, false, false, { whisper: 'managed' }]);
  assert.ok(Array.isArray(f.items) && f.items.length > 0);
  assert.strictEqual(a['koeApp.accountStatus'].signedIn, true);
  assert.match(s.act, /setNavOffline/);
});
// 0.9.0 O-3（設計書 D25・RP9）で意図して変えた: 録音バーの画面（80 枚）を全部取り直し待ちにした（新しい画面で基準がまだ無い）。利用者が CI の画像を
// 見て OK と言ったら、G-3 でその画像を基準にして空に戻す（空になるまで版を上げられない: 上の F14）。本体の画面は取り直し待ちでなければ基準と比べる
// 0.9.0 O-4（RP1）で意図して変えた: 設定の「録音バーの置き場所」の欄の名前と選択肢を替えたので、設定の3枚も取り直し待ちにした
// 0.9.0 G-3 で意図して変えた: 取り直し待ちを空に戻した（上の注）。録音バーの画面の基準の大きさは、上の「G2・F14・RP9・G-3」が panelBounds の答えと比べる
// 0.9.1: 取り直し待ちは計画の表の画面（ファイルの頭の RETAKE_091）とちょうど同じ
// 0.9.1 で意図して変えた（版を 0.9.1 に上げる commit）: 取り直し待ちを空に戻した（ファイルの頭の注）。計画の表の画面（ADDED_091）にはどれも基準がある
// 0.9.2 で意図して変えた: 取り直し待ちは 0.9.2 の計画の表の画面（ファイルの頭の RETAKE_092）とちょうど同じ。取り直し待ちの新しい画面（NEW_092）のほかは基準がある
// 0.9.2 で意図して変えた（版を 0.9.2 に上げる commit）: 取り直し待ちを空に戻した（ファイルの頭の注）。計画の表の画面（ADDED_092）にはどれも基準がある
// 0.9.3 で意図して変えた: 取り直し待ちは 0.9.3 の計画の表の画面（ファイルの頭の RETAKE_093）とちょうど同じ。取り直し待ちの新しい画面（NEW_093）のほかは基準がある
// 0.9.3 で意図して変えた（版を 0.9.3 に上げる commit）: 取り直し待ちを空に戻した（ファイルの頭の注）。計画の表の画面（ADDED_093）にはどれも基準がある
// 0.9.4 で意図して変えた: 取り直し待ちは 0.9.4 の表の画面（ファイルの頭の RETAKE_094）とちょうど同じ
// 0.9.4 で意図して変えた（版を 0.9.4 に上げる commit）: 取り直し待ちを空に戻した（ファイルの頭の注）。0.9.4 の表の画面（ADDED_094）にはどれも基準がある
// 0.10.0 で意図して変えた（版を 0.10.0 に上げる commit）: 取り直し待ちを空に戻した（ファイルの頭の注）。0.10.0 の表の画面（ADDED_100）はどれも計画の表にあり、基準がある
// 0.10.1 で意図して変えた（版を 0.10.1 に上げる commit）: 取り直し待ちを空に戻した（ファイルの頭の注）。0.10.1 の表の画面（ADDED_101）はどれも計画の表にあり、基準がある
// 0.11.0 で意図して変えた（版を 0.11.0 に上げる commit）: 取り直し待ちを空に戻した（ファイルの頭の注）。0.11.0 の表の画面（ADDED_110）はどれも計画の表にあり、基準がある
test('G2・F14・G-4・0.9.0 G-3・0.9.1・0.9.2・0.9.3・0.9.4・0.10.0・0.10.1・0.11.0・0.11.1・0.12.0・0.12.1: 取り直し待ちは無い（0.11.1 のロゴの差し替えの 139 枚と 0.12.0 の 14 枚と 0.12.1 の 10 枚は基準にした）。どの画面にも基準の PNG があり（0.9.1・0.9.2・0.9.3・0.9.4・0.10.0・0.10.1・0.11.0・0.12.0 で足した画面も）、本体の画面の大きさは窓の大きさと同じ', { timeout: 5000 }, () => {
  // 0.11.1 LG-2 で意図して変えた: 取り直し待ちは 0.11.1 の表の画面（ファイルの頭の ADDED_LOGO）とちょうど同じで、どれも計画の「取り直す画面（RETAKE）」の表にある
  // 0.11.1 で意図して変えた（版を 0.11.1 に上げる commit。LG-8）: 取り直し待ちを空に戻した（ファイルの頭の注）。0.11.1 の表の画面（ADDED_LOGO）はどれも計画の表にあり、基準がある
  // 0.12.0 SP-4 で意図して変えた: 取り直し待ちは 0.12.0 の表の画面（ファイルの頭の RETAKE_120）とちょうど同じで、どれも計画の「取り直す画面（RETAKE）」の表にある
  // 0.12.0 で意図して変えた（版を 0.12.0 に上げる commit。Task G）: 取り直し待ちを空に戻した（ファイルの頭の注）。0.12.0 の表の画面（ADDED_120）はどれも計画の表にあり、基準がある
  // 0.12.1 LV-4 で意図して変えた: 取り直し待ちは 0.12.1 の表の画面（ファイルの頭の RETAKE_121）とちょうど同じで、どれも計画の「取り直す画面（RETAKE）」の表にある
  // 0.12.1 で意図して変えた（版を 0.12.1 に上げる commit。LV-7）: 取り直し待ちを空に戻した（ファイルの頭の注）。0.12.1 の表の画面（ADDED_121）はどれも計画の表にあり、基準がある
  // 0.13.0 RDY-3 で意図して変えた: 取り直し待ちは 0.13.0 の表の画面（ファイルの頭の RETAKE_130）とちょうど同じで、どれも計画の「取り直す画面（RETAKE）」の表にある。
  // 足した画面（NEW_130）はまだ基準が無い
  assert.deepStrictEqual([...SH.RETAKE].sort(), [...RETAKE_130].sort());
  const plan130 = read('docs/plans/2026-10-24-130.md');
  const table130 = plan130.slice(plan130.indexOf('## 取り直す画面（RETAKE）'), plan130.indexOf('\n## ', plan130.indexOf('## 取り直す画面（RETAKE）') + 5));
  for (const n of RETAKE_130) assert.ok(table130.includes(`\`${n}\``), `0.13.0 の計画の「取り直す画面」の表に ${n} が無い`);
  const plan121 = read('docs/plans/2026-10-24-121.md');
  const table121 = plan121.slice(plan121.indexOf('## 取り直す画面（RETAKE'), plan121.indexOf('\n## ', plan121.indexOf('## 取り直す画面（RETAKE') + 5));
  for (const n of ADDED_121) assert.ok(table121.includes(`\`${n}\``), `0.12.1 の計画の「取り直す画面」の表に ${n} が無い`);
  const plan120 = read('docs/plans/2026-10-22-120.md');
  const table120 = plan120.slice(plan120.indexOf('## 取り直す画面（RETAKE）'), plan120.indexOf('## ', plan120.indexOf('## 取り直す画面（RETAKE）') + 5));
  for (const n of ADDED_120) assert.ok(table120.includes(`\`${n}\``), `0.12.0 の計画の「取り直す画面」の表に ${n} が無い`);
  const planLogo = read('docs/plans/2026-10-24-logo.md');
  const tableLogo = planLogo.slice(planLogo.indexOf('## 取り直す画面（RETAKE）'), planLogo.indexOf('## 自己点検'));
  for (const n of ADDED_LOGO) assert.ok(tableLogo.includes(`\`${n}\``), `0.11.1 の計画の「取り直す画面」の表に ${n} が無い`);
  const plan110 = read('docs/plans/2026-10-22-110.md');
  const table110 = plan110.slice(plan110.indexOf('## 取り直す画面（RETAKE）'), plan110.indexOf('## CHANGELOG の 0.11.0 の節'));
  for (const n of ADDED_110) assert.ok(table110.includes(`\`${n}\``), `0.11.0 の計画の「取り直す画面」の表に ${n} が無い`);
  const plan101 = read('docs/plans/2026-10-23-101.md');
  const table101 = plan101.slice(plan101.indexOf('## 取り直す画面（RETAKE）'), plan101.indexOf('## 実機で利用者に見てもらうこと'));
  for (const n of ADDED_101) assert.ok(table101.includes(`\`${n}\``), `0.10.1 の計画の「取り直す画面」の表に ${n} が無い`);
  const plan100 = read('docs/plans/2026-10-20-100.md');
  const table100 = plan100.slice(plan100.indexOf('## 取り直す画面（RETAKE）'), plan100.indexOf('## 実機で利用者に見てもらうこと'));
  for (const n of ADDED_100) assert.ok(table100.includes(`\`${n}\``), `0.10.0 の計画の「取り直す画面」の表に ${n} が無い`);
  const plan = read('docs/plans/2026-10-21-092.md');
  const table = plan.slice(plan.indexOf('## 取り直す画面（RETAKE）'), plan.indexOf('## 実機で利用者に見てもらうこと'));
  for (const n of ADDED_092) assert.ok(table.includes(`\`${n}\``), `計画の「取り直す画面」の表に ${n} が無い`);
  const plan093 = read('docs/plans/2026-10-22-093.md');
  const table093 = plan093.slice(plan093.indexOf('## 取り直す画面（RETAKE）'), plan093.indexOf('## 実機で利用者に見てもらうこと'));
  for (const n of ADDED_093) assert.ok(table093.includes(`\`${n}\``), `0.9.3 の計画の「取り直す画面」の表に ${n} が無い`);
  assert.ok(!SH.RETAKE.has('overlay-processing'), '外した録音バーの画面を取り直し待ちに入れた');
  for (const n of [...ADDED_091, ...ADDED_092, ...ADDED_093, ...new Set(ADDED_094), ...new Set(ADDED_100), ...ADDED_101, ...ADDED_110, ...ADDED_LOGO, ...ADDED_120, ...ADDED_121]) {
    assert.ok(SH.SCREENS.some((s) => s.name === n), `${n} が撮る画面に無い`);
    assert.ok(fs.existsSync(path.join(ROOT, 'test', 'shots', 'win32', `${n}.png`)), `${n} の基準が無い`);
  }
  for (const s of SH.SCREENS) {
    const f = path.join(ROOT, 'test', 'shots', 'win32', `${s.name}.png`);
    if (NEW_130.includes(s.name) && SH.RETAKE.has(s.name)) continue;   // 0.13.0: 取り直し待ちの足した画面は基準がまだ無い
    assert.ok(fs.existsSync(f), `${s.name} の基準が無い`);
    if (s.page !== 'app') continue;   // 0.9.3 M-7 で意図して変えた: パネル（nudge）の画面も、録音バーと同じく窓の大きさが中身で決まる
    const im = P.decodePng(fs.readFileSync(f));
    assert.deepStrictEqual([im.width, im.height], [SH.SIZE.width, SH.SIZE.height], s.name);
  }
  // 基準のフォルダに、撮る画面に無い名前の画像を置かない（外した画面の基準が残らない）
  const names = new Set(SH.SCREENS.map((s) => `${s.name}.png`));
  assert.deepStrictEqual(fs.readdirSync(path.join(ROOT, 'test', 'shots', 'win32')).filter((n) => !names.has(n)), [], '撮る画面に無い基準がある');
});

// 0.9.0 O-3（設計書 D25・RP9・F11）: 録音バーの画面は pill-states の表の状態 × 形（横・縦）× 地（明るい・暗いデスクトップ）× 拡大率（100・150%）。
// 窓の大きさは、撮るときに測ったピルの大きさから main と同じ panelBounds で決め、拡大率の画面は × 拡大率の大きさで撮れたかを見る
// 0.9.0 O-4（RP8）で足した: 縦の形の × が出た1枚（overlay-vertical-dark-hover-150。モックの名前）を最後に
// 0.9.1 Q-5 で意図して変えた: 状態 quiet（「会議は終わりましたか？」）を足して 88 枚と × の1枚
// 0.9.4 P-1 で意図して変えた: 完了（done）は薄く消えて撮る形が無いので外した（80 枚と × の1枚。done の基準の8枚も外した）
test('RP9: 録音バーの画面は pill-states の表の状態 × 形 × 地 × 拡大率で 80 枚と、縦の形の × の1枚。名前は overlay-<形>-<地>-<状態>-<100|150>、act は表の見本', { timeout: 5000 }, () => {
  const all = SH.SCREENS.filter((s) => s.page === 'overlay');
  assert.strictEqual(all.length, 81);
  const hv = all.pop();
  assert.deepStrictEqual([hv.name, hv.scale, hv.slot, hv.theme], ['overlay-vertical-dark-hover-150', 1.5, 'middle-right', 'dark']);
  assert.strictEqual(hv.act, PS.actFor('rec', 'v', 'dark', true));
  assert.ok(hv.act.includes('"hover":true') && !PS.actFor('rec', 'v', 'dark').includes('"hover":true'));
  const ov = all;
  assert.strictEqual(ov.length, 80);
  assert.deepStrictEqual(PS.FORMS, ['h', 'v']);
  assert.deepStrictEqual(Object.keys(PS.DESKS), ['light', 'dark']);
  assert.deepStrictEqual(PS.SCALES, [1, 1.5]);
  assert.strictEqual(PS.STATES.length, 10);
  for (const s of ov) {
    const { state, form, desk, scale } = s.pill;
    assert.strictEqual(s.name, `overlay-${form}-${desk}-${state}-${Math.round(scale * 100)}`);
    assert.strictEqual(s.act, PS.actFor(state, form, desk), s.name);
    assert.strictEqual(s.scale, scale);
    assert.strictEqual(s.slot, form === 'v' ? 'middle-right' : 'bottom-center');
  }
  // 撮るときだけ足す地（製品には無い）
  assert.ok(PS.actFor('rec', 'h', 'light').includes(PS.DESKS.light) && PS.actFor('rec', 'h', 'dark').includes(PS.DESKS.dark));
  assert.ok(!read('src/renderer/overlay.html').includes(PS.DESKS.light), '撮るときの地が製品の画面にある');
  // 窓の大きさ: 撮るときに測ったピルの大きさから main と同じ panelBounds（拡大率の画面は × 拡大率で撮れたか）
  assert.deepStrictEqual(SH.panelWindowFor({ w: 236.4, h: 40 }, 'bottom-center'), (({ width, height }) => ({ width, height }))(lib.panelBounds({ slot: 'bottom-center', size: { w: 236.4, h: 40 }, workArea: SH.SHOT_AREA })));
  assert.deepStrictEqual(SH.shotSizeFor({ width: 253, height: 56 }, 1.5), { width: 380, height: 84 });
  // 拡大率は画面の外で描く窓そのものに持たせる（O-3 で作るときに確かめた: 44.9.0 では DevTools の Emulation.setDeviceMetricsOverride も
  // プロセスの --force-device-scale-factor も、画面の外で描く窓の撮った画像を 1 倍のままにした。計画の O-3 を直した）
  const m = read('tools/shots/main.js');
  for (const k of ['SH.panelWindowFor(', 'SH.shotSizeFor(winSize, scale)', 'offscreen: scale === 1 ? true : { deviceScaleFactor: scale }', 'SH.PANEL_PROBE', 'SH.judgePanel(',
    'for (const scale of SH.PANEL_PROBE_SCALES)', 'for (const state of SH.PANEL_PROBE_STATES)']) assert.ok(m.includes(k), k);
  assert.ok(!m.includes('setDeviceMetricsOverride'), '撮った画像に効かない DevTools の拡大率に頼っている');
});

test('F11: PANEL_PROBE の判定は、ピルの四角が窓の内側に 4px 以上の余白で入らなければ NG（取り直し待ちでも NG）。横と縦の rec と warn を拡大率 1・1.25・1.5・2 で見る', { timeout: 5000 }, () => {
  const ok = { pill: { left: 8, top: 8, right: 244, bottom: 48 }, iw: 252, ih: 56 };
  assert.strictEqual(SH.judgePanel(ok).ok, true);
  assert.strictEqual(SH.judgePanel({ ...ok, pill: { ...ok.pill, right: 249 } }).ok, false, '右の余白 3px を OK にした');
  assert.strictEqual(SH.judgePanel({ ...ok, pill: { ...ok.pill, top: 3.5 } }).ok, false);
  assert.strictEqual(SH.judgePanel({ ...ok, ih: 51 }).ok, false);
  assert.strictEqual(SH.judgePanel({ ...ok, pill: { ...ok.pill, left: 4, right: 248 }, iw: 252 }).ok, true, 'ちょうど 4px を NG にした');
  assert.strictEqual(SH.judgePanel(null).ok, false, '計れなかったのを OK にした');
  assert.deepStrictEqual(SH.PANEL_PROBE_SCALES, [1, 1.25, 1.5, 2]);
  assert.deepStrictEqual(SH.PANEL_PROBE_STATES, ['rec', 'warn']);
  assert.match(SH.PANEL_PROBE, /getBoundingClientRect/);
  assert.match(SH.PANEL_PROBE, /innerWidth/);
  const retake = new Set(['overlay-h-light-rec-100']);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: [{ name: 'overlay-h-light-rec-100', status: 'missing' }], retake, panel: [{ name: 'overlay-h-light-rec-100', ok: false }] }), 1, '取り直し待ちの録音バーのはみ出しを NG にしなかった');
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: [{ name: 'overlay-h-light-rec-100', status: 'missing' }], retake, panel: [{ name: 'overlay-h-light-rec-100', ok: true }] }), 0);
  const m = read('tools/shots/main.js');
  assert.ok(m.includes('retake: SH.RETAKE, overflow, focus, panel })'), 'はみ出しの判定を終わりの答えに渡していない');
});

test('CI: 撮る道具の見張りの時間は 30 秒 + SCREENS の数 × 6 秒（決まった 90 秒でない）', { timeout: 5000 }, () => {
  assert.strictEqual(SH.watchdogMs(0), 30000);
  assert.strictEqual(SH.watchdogMs(100), 630000);
  assert.strictEqual(SH.watchdogMs(SH.SCREENS.length), 30000 + SH.SCREENS.length * 6000);
  const m = read('tools/shots/main.js');
  assert.ok(m.includes('SH.watchdogMs(SH.SCREENS.length)'), '見張りの時間を画面の数から決めていない');
  assert.ok(!/90000/.test(m), '決まった 90 秒の見張りが残っている');
});
// 0.9.0 O-3: 第1a回の録音バーの基準は外した。録音バーの中身は test/stage1b.look.test.js の overlay.html の sha256 が見続ける

// 0.7.0 の出す前の CI（run 39250045942）: 573d111 で設定のカード「オンライン」の説明を小さくしたらページが短くなり、
// 見える中身は同じなのに右の捲り棒のつまみの端（x 1108〜1116・y 322〜326 の 24 画素）だけが変わって settings-light・settings-dark が NG になった
// （第1c回 4ec68b6 と同じ形。「いちばん上ではないので撮った画面には当たらない」は、つまみの長さがページ全体の長さで決まるので誤り）。
// 画面は app.html の1ファイル（script と style は中に書く）なので、基準の画像を撮った app.html の sha256 をここに持ち、変えたら手元で赤にする。
// 赤になったら: Windows の CI の「主な画面を撮る」を見て、違えば基準を取り直す（見える中身が変わるなら RETAKE に入れて利用者に見てもらう）。それから下の値を今の app.html に合わせる
// 第1d回 A-9（RL16）: ［更新して再起動］と更新の知らせの行のボタンが restart の答えを見るように、<script> の中だけを直した（要素・文・CSS は
// 変えていないので、撮る画面の見た目もページの長さも変わらない。計画の A-9 は RETAKE に足さない）。値を今の app.html に合わせた。
// 本当に同じかは Windows の CI の「主な画面を撮る」の比べで見る（違えば基準を取り直し、見える中身が変わったなら RETAKE に入れる）
// 第1d回 A-4（RL10・F11）: 設定に「アカウント」のカードを足し、「オンライン」の説明を替えて［詳細設定（管理者用）］を消し、知らせに
// ［ログインし直す］を足した。見える中身が変わるのは設定の3枚なので RETAKE に入れた（上の「取り直し待ちは設定の3枚だけ」）。
// ほかの画面（議事録・音声入力・録音中のページ・検索の窓）は要素も文も変えていないので、基準のまま比べる。値を今の app.html に合わせた
// 第1d回 A-1〜A-4 の点検の直し: ［ログイン］が確かめるメールを「コードを送ったメール」にした（<script> の中の1行だけ。要素・文・CSS は
// 変えていないので見た目もページの長さも変わらない。RETAKE は設定の3枚のまま足さない）。値を今の app.html に合わせた
// 第1d回 A-7（RL14・D17）: 録音中のページの記録の行に状態の行（#liveStt）を、その上に帯（#liveSttBanner）を足した（CSS の .stt-banner も）。
// 見える中身が変わるのは録音中のページの2枚と足した帯の画面なので RETAKE に入れた（上の「取り直し待ちは設定の3枚と録音中のページの3枚」）。
// 議事録・音声入力・設定・検索の窓は要素も文も変えていないので、基準のまま比べる。値を今の app.html に合わせた
// 第1d回 A-8（RL15・D17）: 録音中のページが見えているかを main へ知らせる（meetingLiveShown）のと、Windows の知らせを押したら録音中のタブへ
// 移る（onShowLive）を、<script> の中だけに足した（要素・文・CSS は変えていないので、撮る画面の見た目もページの長さも変わらない。
// A-9 と同じく RETAKE に足さない）。値を今の app.html に合わせた
// 第1d回 A-7・A-8 の点検の直し: 帯の文が同じなら書き直さない（<script> の中の1行だけ。要素・文・CSS は変えていないので見た目も
// ページの長さも変わらない。RETAKE は今のまま足さない）。値を今の app.html に合わせた
// 第1d回 A-13（RL17・RL18・D19・D20・あとの直し (a)(b)）: 設定のカード「エンジン」を「オフライン」にして説明の行を足し、文字起こしの言葉を
// 「PC の中の文字起こし」に（設定の3枚）、［この会議は PC の中だけ］を記録の行の1行目へ（録音中のページの3枚）、入力の欄の決まりに
// input[type="email"] を足した（設定のメールの欄。設定の3枚）。見える中身が変わるのは設定の3枚と録音中のページの3枚で、どれも RETAKE にある。
// 帯の暗い画面と 200% の暗い画面を足して RETAKE に入れた（8枚）。議事録・音声入力・検索の窓は要素も文も変えていないので、基準のまま比べる。値を今の app.html に合わせた
// 第1d回 A-12（RL10）: 設定のカード「アカウント」のメールアドレスと確認コードの欄・［確認コードを送る］［コードを送り直す］を消し、
// ［ログイン］と英語の Cloudflare の画面の説明（AR1）・コードのメールの注意（AR2）にした。見える中身が変わるのは設定の3枚で、どれも RETAKE にある
// （tools/shots/screens.js の accountStatus の答えはログインしていない形）。録音中のページ・議事録・音声入力・検索の窓は要素も文も変えていない
// （［ログインし直す］のフォーカスの行き先は <script> の中だけ）ので、基準のまま比べる。値を今の app.html に合わせた
// 第1d回 G-4: 取り直し待ちの8枚を、この値の app.html で CI（run 39398639423・4f47ad0）が撮った画像にした（app.html は変えていないので値はそのまま）
// 0.9.0 U-1（SP1〜SP3・D24）: 設定をタブでなく、ページの上に開くポップアップにした（左の項目の列・×・設定の section を中へ動かし、題名を
// 選んだ項目の名前に）。見える中身が変わるのは設定の3枚と、3つのタブの並びから設定のタブが消える notes-tabs-light で、どれも RETAKE に入れた
// （上の「取り直し待ちは計画の画面だけ」）。議事録・音声入力・録音中のページ・検索の窓は要素も文も CSS も変えていない（設定の section は
// main から動いたが、閉じている間は hidden）ので、基準のまま比べる。値を今の app.html に合わせた
// 0.9.0 U-2（SP4・SP5・D24）: 設定のカードを項目ごとに分け（「動作」「オンライン」を無くしてホットキー・起動と終了・録音バー・マイクと
// 相手の声・文字起こし・要約（Claude Code）へ。id と文はそのまま）、上に検索の欄を足した。見える中身が変わるのは設定の画面だけで、どれも RETAKE
// にある（項目「録音」と検索の画面を足した）。入力の欄の決まりに input[type="search"] を足したが、議事録・音声入力・録音中のページ・検索の窓に
// search の欄は無いので、基準のまま比べる。値を今の app.html に合わせた
// 0.9.0 U-3（OF7・F4・D21）: カード「オフライン」の説明を OFF1 に、準備を選んでいない人の状態の文・取り込みの欄の文とボタン・起動の連れて行き・
// 帯と知らせの［ログイン］［オフラインの準備］・PC の中だけの文を足した。見える中身が変わるのは設定の画面（RETAKE にある。準備を選んでいない人の
// カードの画面 settings-offline-light を足した）。録音中のページの画面の答えは action も needsSetup も持たないので、議事録・音声入力・録音中の
// ページ・検索の窓は基準のまま比べる。値を今の app.html に合わせた
// 0.9.0 U-4（SP6・SP7・F15）: 設定の左の列の下に［ヘルプセンター］（HELP_SITE_LIVE が偽なので hidden）と版の文字を足した。見える中身が
// 変わるのは設定の画面だけで、どれも RETAKE にある。ほかの画面は基準のまま比べる。値を今の app.html に合わせた
// 0.9.0 U-2 の点検の直し（SP5）: 設定の検索が、今は隠れている行（ログインしていない間の「ログアウト」など）に当たらないようにした
//（filterSettings の <script> の中だけ）。変わり得るのは設定の検索の画面（settings-search-light。RETAKE にある）だけで、ほかの画面は
// 要素も文も CSS も変えていないので基準のまま比べる。値を今の app.html に合わせた
// 0.9.0 O-4（RP1・RP8）: 設定の「録音バーの置き場所」の欄の名前と8つの選択肢を替え（設定の3枚。RETAKE に入れた）、録音中のページの記録の行に
// ［録音バーを出す］を足した（録音バーを隠しているときだけ出す hidden のボタン。撮る画面の録音中のページは隠していないので見た目は変わらない）。値を今の app.html に合わせた
// 統合（U・O）: U の設定のポップアップの中へ動かした「録音バーの置き場所」の欄（data-row も「録音バーの置き場所」に）に O-4 の名前と8つの選択肢を当てた。
// 見える中身が変わるのは設定の画面（RETAKE にある）だけ。値を今の app.html に合わせた
// 0.9.0 O-2・O-4 の点検の直し: ドラッグで吸い付いた置き場所を main から受けて #pillPos に入れる（onSettingsPatched）のと、保存の applied の
// pillSlot を #pillPos に戻す（FIELD_IDS）を、<script> の中だけに足した（要素・文・CSS は変えていないので見た目もページの長さも変わらない。
// RETAKE は今のまま足さない）。値を今の app.html に合わせた
// 0.9.0 見た目の直し（利用者に見せる前の見直し）: 設定のポップアップの捲り棒を × の下から角の丸みの内側までにし（scrollbar-gutter: stable）、検索の間は
// ［データ保存先を開く］を外し、モック 案C に合わせた（検索の虫めがね・名前が左で入力が右の行・キーの形の箱のホットキー・項目の見出し 20px・
// 項目の見出しと同じ言葉のカードの見出しを出さない）。CSS はどれも設定のポップアップの中（#tabSettings・.setpane・.setsearch・.hkbox・.frow）だけで、
// 見える中身が変わるのは設定の画面（6枚とも RETAKE にある）。議事録・音声入力・録音中のページ・検索の窓は要素も文も CSS も変えていないので
// 基準のまま比べる。値を今の app.html に合わせた
// 同じ直しの続き: 設定の入力とボタンの行（スピーカーの欄とボタン 2 つ）が右の列で折り返したので、行の幅の上限を 460px に（設定の画面だけ。RETAKE にある）。値を今の app.html に合わせた
test('基準の画像（test/shots/win32）は今の app.html で撮ったもの（app.html を変えたら撮り直しを確かめる）', { timeout: 5000 }, () => {
  const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.html'))).digest('hex');
  // 0.9.1 Q-3（D29）: 設定の項目「録音」にカード「話し声が無いとき」（チェックと選ぶ欄）を足した。見える中身が変わるのは settings-record-light で、
  // RETAKE に入れた（設定のほかの画面は項目「一般」を開くので変わらない）。値を今の app.html に合わせた
  // 0.9.1 Q-4（D29）: 録音中のページの頭に「会議は終わりましたか？」の帯（#liveQuietAsk。quiet が無ければ hidden）と、その CSS（.quiet-ask だけ）を足した。
  // 撮る今の録音中のページは quiet が無いので見た目は変わらない。帯の出た画面は Q-5 で足して RETAKE に入れる。値を今の app.html に合わせた
  // 0.9.2 I-1: 設定の左の列の下の［ヘルプセンター］を「ヘルプ」にして出した（HELP_SITE_LIVE を真に・口の名前の回り道をやめた）。見える中身が変わるのは
  // 設定の 7 枚で、どれも RETAKE に入れた。ほかの画面は設定のポップアップを開かないので変わらない。値を今の app.html に合わせた
  // 0.9.2 I-2: 設定の「録音」と「要約」の説明を1行にし、ⓘ の吹き出しを足した（CSS・吹き出しの開け閉め・検索）。検索で外した 2列の行が CSS で消えなかった
  // のも直した（.set-miss の詳細度）。見える中身が変わるのは設定の画面で、どれも RETAKE にある。値を今の app.html に合わせた
  // 0.9.2 I-3: 「アカウント」「一般」「オフライン」「更新」の説明も1行にし、ⓘ の吹き出しを足した（ログインの行は2列に）。見える中身が変わるのは設定の画面で、
  // どれも RETAKE にある。値を今の app.html に合わせた
  // 0.9.2 I-4: 吹き出しを開いたときに上にも下にも収まらなければ ⓘ を右の列の上へ捲る・書体の読み込みの後に置き直す（<script> の中だけ）。撮る吹き出しの画面は
  // どれも RETAKE にある。値を今の app.html に合わせた
  // 0.9.3 M-0（持ち主の答え D54）: 録音中のページのボタンを［オフラインモード］、設定の項目「オフライン」を「ローカル AI」と呼び、左の列を 196px に
  // 広げた（文と .setnav の幅だけ）。見える中身が変わるのは設定の 16 枚と録音中のページの 7 枚で、どれも RETAKE に入れた。議事録・音声入力・検索の窓は
  // 変わらない。値を今の app.html に合わせた
  // 0.9.3 M-3: main の app:open-settings（パネルの「会議の検出の通知の設定…」）を受けて設定の項目を開く受け口を <script> の中だけに足した（要素・文・CSS は
  // 変えていないので見た目は変わらない）。値を今の app.html に合わせた
  // 0.9.3 M-4: ［設定］→［録音］の頭にカード「会議の検出」（トグルと、通知を出さないアプリの札。札の CSS .chip）を足し、パネルから開いたときにその行を見せる。
  // 見える中身が変わるのは設定の「録音」の画面と検索「マイク」の画面で、どれも RETAKE にある。値を今の app.html に合わせた
  // 0.9.3 M-5: main が送る音の大きさ（meeting:level）を受ける受け口を <script> の中だけに足した（見た目は変わらない）。値を今の app.html に合わせた
  // 0.9.3 M-6: 録音中のページの「文字起こし」の右に音の波（#liveWaveBox・CSS .lwave・#liveWave）と、文字起こしの一番下の「聞き取り中…」（.livetail）を足した。
  // 見える中身が変わるのは録音中のページの 7 枚で、どれも RETAKE にある（保存したページ・設定・音声入力・検索の窓は波を出さないので変わらない）。値を今の app.html に合わせた
  // 0.9.3 M-4 の CI の直し（CI run 39745472232）: 出さないアプリの札を .chip でなく .mutechip で描く（.chip の規則を足すと検索の窓の絞り込みの札の形まで
  // 変わり、search-palette-light が基準と違った）。検索の窓は 0.9.2 の基準と同じに戻る。値を今の app.html に合わせた
  // 0.9.3 M-6 の撮った画面の直し（CI run 39751610440）: 「聞き取り中」の行を区間の行と同じ並びにした（CSS .livetail だけ）。変わるのは録音中のページの画面で、
  // どれも RETAKE にある。値を今の app.html に合わせた
  // 0.9.3 持ち主の答え D55: 記録の行に押せない札「オフラインモード中」（#meetingLocalOnlyState・CSS .offpill。オフラインモードの会議のときだけ出る）と、
  // 記録の行の括弧の中の「オフライン」（liveTitleText）を足した。今の録音中のページの画面はオフラインモードでないので見た目は変わらず、オフラインモードの
  // 画面（live-offline-light・live-offline-dark）を足して RETAKE に入れた。値を今の app.html に合わせた
  // 0.9.4 S-3: 録音を止めた後の待ちのボタンを［文字起こしを後回しにして要約］にし、確かめの文と「後回しにしました」の行を替えた（止めた後の待ちの
  // 画面は撮っていないので、撮る画面は変わらない）。値を今の app.html に合わせた
  // 0.9.4 S-4: 遅い会議の「聞き取り中」の行を「音声を残しています（会議の後で文字起こしします）」にする分かれ道を <script> に足した（遅くない会議の
  // 見た目は変わらない。遅い会議の画面は S-8 で足す）。値を今の app.html に合わせた
  // 0.9.4 S-7（決めたこと 19〜21・持ち主の答え Q9）: 設定の「ローカル AI」に行「この PC の速さ」（［速さを測る］・勧めるスレッド数と［この数にする］）と
  // 閉じた details「軽いモデルと精度」（表・取り込む・使う・戻す・手の組のパスの案内）と CSS .alttable を足した。見える中身が変わるのは設定の
  // 「ローカル AI」の画面と検索の画面で、どれも RETAKE にある（settings-offline-light・settings-search-light）。測った画面は S-8 で足す。値を今の app.html に合わせた
  // 0.9.4 M-0: 0.9.3（746ea67・6e79416）を merge した（0.9.3 の D55 と 0.9.4 の S-3・S-4・S-7 の app.html の直しが両方入った）。値を merge の後の app.html に合わせた
  // 0.9.4 S-7R（持ち主の答え Q15・Q26）: S-7 を revert して「この PC の速さ」の行と「軽いモデルと精度」を外した（設定の画面は 0.9.3 の基準と同じに戻る）。値を今の app.html に合わせた
  // 0.9.4 W-1: 録音中のページの波を録音バーと同じ5つの灰色の点（5本がそれぞれ揺れる）にした（CSS #liveWave・点の数・levelBars）。見える中身が変わるのは
  // 録音中のページの画面（RETAKE にある: W1_094）。値を今の app.html に合わせた
  // 0.9.4 R-1（持ち主の答え Q25）: 設定の項目の名前を「ローカル AI の設定」から「ローカル AI」にした（左の列・隠した見出し・項目の名前・文の中）。見える中身が
  // 変わるのは設定の画面（RETAKE にある: R1_094）。値を今の app.html に合わせた
  // 0.10.0 C-3（MR8・D34）: 項目「要約」にカード「Claude との連携（MCP）」と、要約（Claude Code）の吹き出しに Sonnet の1行を足し、左下の知らせの
  // action settings-summary を足した。見える中身が変わるのは項目「要約」を写す画面（settings-summary-light・settings-info-claude-light。RETAKE にある）と、
  // 足した2枚（settings-mcp-light・settings-info-mcp-light）。値を今の app.html に合わせた（前の値は 40052bfc…）
  // 0.10.0 L-1（D58）: ページの「···」のメニューに［リンクを写す］（押したときだけ作る項目と、その <script>）。見える中身が変わるのはメニューを開いた画面
  // （page-menu-link-light・page-menu-link-dark。足して RETAKE に）だけ（ほかの画面はメニューを閉じている）。値を今の app.html に合わせた（前の値は cf1634c0…）
  // 0.10.0 L-2（D58・D70）: 左の一覧の見出し「議事録」の行の右に［選ぶ］（見出しの行に重ね、一覧の位置は変えない）・選んでいる間の頭の枠・行のチェックボックス。
  // 見える中身が変わるのは左の一覧が写る本体の画面（SH-1 の表で RETAKE にある）と、足した list-select-light・list-select-dark。値を今の app.html に合わせた（前の値は c33e797e…）
  // 0.10.0 LN-1（D72）: natsu:// のリンクの照らしの写し parseNatsuLinkView を <script> の中だけに足した（要素・文・CSS は変えていないので見た目は変わらない。
  // RETAKE は足さない）。値を今の app.html に合わせた（前の値は e98ee8b8…）
  // 0.10.0 LN-4（D72・決めたこと 145・148）: リンクで開いたページの箇所を 3 秒だけ地の色で示す（.linkhit。リンクで開いたときだけ付く）・検索の窓に貼ったリンクの行
  // （貼ったときだけ出る）を足した。撮る画面には出ないので見た目は変わらない（RETAKE は足さない）。値を今の app.html に合わせた（前の値は 2776757e…）
  // 0.10.0 H-1a（HC2）: カード「Claude との連携（MCP）」の吹き出しの「ヘルプで詳しく見る ↗」の記事を start/claude-mcp に（属性だけ。見た目は変わらない）。
  // 値を今の app.html に合わせた（前の値は 2b0ba2e1…）
  // 0.10.0 LS-2 で意図して変えた: 要約の欄の鍵（欄の頭の一言・読むだけの形・summary:running。D63・D69）。変わるのは鍵のかかったページだけ
  // （page-summary-lock-light を足して RETAKE に）。値を今の app.html に合わせた（前の値は 61cb7146…）
  // 0.10.0 LS-3 で意図して変えた: 「ローカル AI」のカードから要約の欄（詳細設定の llama の行・起動テスト）を外し、頭の1行と取り込みの欄の文から「要約」を外した（D59）。
  // 変わる画面は settings-offline-light（RETAKE にある）。値を今の app.html に合わせた（前の値は 04d522ab…）
  // 0.10.0 LS-5 で意図して変えた: オフラインモードの押した後の行・準備の無い PC の行・文字起こしの吹き出しの1行を守秘の約束でない文に（D62）、取り込みのボタンの数を今の計算に（D59）。
  // 変わる画面は live-offline-light・live-offline-dark・settings-info-stt-dark・settings-offline-light（どれも RETAKE にある）。値を今の app.html に合わせた（前の値は 003e98d9…）
  // 持ち主の答え（2026-10-23）で意図して変えた: カード「Claude との連携（MCP）」の頭の1行から「Claude Code」を外した（D64）。変わる画面は settings-summary-light・
  // settings-info-claude-light・settings-mcp-light・settings-info-mcp-light（どれも RETAKE にある）。値を今の app.html に合わせた（前の値は 9a700bc9…）
  // 0.10.1 CD-3（D84・D85）: カード「Claude との連携（MCP）」の断った文（RN1・RN2）・確かめないまま変えた文（RN5）を足し、動いているときの頭の文（RN3）を書き直した。
  // 撮る今の画面は「登録していない・動いていない」の形で #mcpMsg が空なので見た目は変わらない。新しい文は足した settings-mcp-running-light（RETAKE）に写る。
  // 値を今の app.html に合わせた（前の値は 13470282…）
  // 0.10.1 点検の直し（Ruling R8）: どこかのファイルに natsu が残っていれば（main の答えの hasEntry）［登録を外す］を出す1行を足した。撮る画面の答えに hasEntry は
  // 無いので見た目は変わらない（RETAKE は足さない）。値を今の app.html に合わせた（前の値は 2c44162a…）
  // 0.11.0 P-12（R15）: 種類の欄の頭に「自動（文字起こしから判定）」、自動と決まらなかったページの灰色の文。変わる画面は種類の行を写す画面（ADDED_110）。
  // 値を今の app.html に合わせた（前の値は 4130627a…）
  // 0.11.0 V-1: 行の名前「会議の種類」・「メモの型」・群・録音中の種類の行と一言・手引き・札。変わる画面は ADDED_110。値を今の app.html に合わせた（前の値は 1b081c36…）
  // 0.11.0 V-2: 要約の画面の並び（orderForView）・つまみの番号・打ち合わせの質のカード・コピーの順。変わる画面は ADDED_110。値を今の app.html に合わせた（前の値は c114b59f…）
  // 0.11.0 V-3: 設定のカード「打ち合わせの質」。変わる画面は ADDED_110。値を今の app.html に合わせた（前の値は 4ee8365f…）
  // 0.11.0 V-4: 種類の横の題名からの一言（初めは隠れている。見た目は変わらない）。値を今の app.html に合わせた（前の値は fa63fba9…）
  // 0.11.0 H-1b: #setPopQuality の［ヘルプで詳しく見る ↗］を記事 summary/meeting-quality に付け替えた（見た目は変わらない）。値を今の app.html に合わせた（前の値は 13c2c317…）
  // 0.11.0 V-5: 会議の種類のプルダウンの群の見出し（<optgroup>）を外した（持ち主の画面の確かめ）。変わる画面は page-type-light・page-type-dark（ADDED_110）。値を今の app.html に合わせた（前の値は e58d2778…）
  // 0.11.1 LG-4（LG2・LG3）: サイドバーの頭のロゴを箱の中のリスにした（path の d と印・色の CSS 2行・海の色の注）。変わる画面はサイドバーの頭を写す本体の窓の 53 枚
  // （ADDED_LOGO の LG4_LOGO）。値を今の app.html に合わせた（前の値は 8d23c411…）
  // 0.12.0 SP-4（D53・D66）: 文字起こしの行をタイムラインの順にし、時刻の後に「自分」「相手」の札（span.spk と CSS の .seg .spk）・PC の側の文ごとの行・
  // 文ごとの行の直し・［コピー］の札・リンクの印の行（R26）。変わる画面は録音中のページの文字起こしの 13 枚と足した notes-script-spk-light（RETAKE_120）。
  // 値を今の app.html に合わせた（前の値は d3620f20…）。SP-4 の撮った画像の確かめで、折り返した行の札が行の高さに伸びていたので .seg .spk に
  // align-self: flex-start を足した（変わる画面は同じ RETAKE_120）。値を今の app.html に合わせた（前の値は 15ff8c69…）
  // 0.12.1 LV-4（決めたこと L15）: カード「会議の検出」の2行目に「会議を出たら自動で止める」（行・ⓘ の吹き出し）と、読み込みと自動保存の1行ずつ。変わる画面は RETAKE_121。
  // 値を今の app.html に合わせた（前の値は 2d669bc1…）
  // 0.13.0 RDY-2（第2部 RD1・RD20）: 録音の前のページ（#readyBar と CSS の #readyState・#readyBar button.action、<script> の中の録音の前の描き方）。録音の前のページは
  // ［＋ 新しい議事録］を押したときだけ出るので、今の撮る画面は変わらない見込み（RDY-3 で撮る画面を足す）。値を今の app.html に合わせた（前の値は 6c70ba30…）
  // 0.13.0 RDY-3（第2部 RD6・RD8・RD10・RD13・RD15）: 録音の前のページから録音に替わる時（メモ欄と種類の行をそのまま・始めた直後の守り）・page:open の受けを pageOpenFromMain の1か所に・読み直したときの録音の前のタブ（<script> の中だけ）。変わる画面は足した RETAKE_130 の3枚。値を今の app.html に合わせた（前の値は dd181948…）
  // 0.13.0 ED-3（決めたこと 20・22）: 要約の［コピー］を blocksMarkdown の写しにし、orderForView の写しに人の見出し（EQ3 (a)）を足した（<script> の中だけ。前の版の要約の見た目は変わらない）。値を今の app.html に合わせた（前の値は b9983662…）
  // 0.13.0 ED-4（決めたこと 15〜19・21・41）: 要約の行の部品を blockRows の1か所にし、Enter の分割・行頭の Backspace・記法・貼り付け・↑↓ と、答えを変わった行だけに当てる描き方（<script> の中と .blk .txt の white-space: pre-wrap。前の版の要約の文は改行も続いた空白も持たないので見た目は変わらない見込み）。値を今の app.html に合わせた（前の値は 3c41e7bd…）
  // 0.13.0 ED-5（E1・E2・決めたこと 23・30・37〜42）: / メニュー（.slashmenu の CSS と描き方）・行の左の ＋（乗せたときだけ。行の外の左の余白に置き、行の並びは変えない。.blk の切る線を 18px に）・Esc・書き直している途中の page:open（<script> の中）。今の撮る画面は変わらない見込みで、変わる画面は足した RETAKE_130 の / メニューの3枚。値を今の app.html に合わせた（前の値は 5fec108a…）
  // 0.13.0 ED-6（E1・決めたこと 18・24）: ⠿ のメニュー（.blockmenu の CSS と描き方・⠿ の title）と、落とした所の上の行の後ろへ入れるドラッグ・savedIndexForDrop の写しを外した（<script> の中）。今の撮る画面は変わらない見込みで、変わる画面は足した RETAKE_130 の edit-block-menu-light。値を今の app.html に合わせた（前の値は 718a2461…）
  // 0.13.0 ED-7（E5・E11・決めたこと 5・6・26〜29）: 見出し1・3（段 2 は前の .blk.heading のまま）・番号付き・引用・区切り線・コールアウトの CSS と描き方・近道（keyAction の写し）。前の版の要約（段の無い見出し・ToDo・箇条書き・テキスト）の見た目は変わらない見込みで、変わる画面は足した RETAKE_130 の edit-types-* の3枚。値を今の app.html に合わせた（前の値は 59b1531e…）
  // 0.13.0 ED-8（EQ4 (a)・決めたこと 35）: ［要約を再生成］の前の確かめ（人が直した行があるときだけ。.askbox の CSS と描き方）。押したときだけ出るので今の撮る画面は変わらない見込み。値を今の app.html に合わせた（前の値は 7ece40dd…）
  // 0.13.0 ED-5〜ED-7 の撮った画像の確かめ: / メニューと ⠿ のメニューは開いたときに箱の全部が見える所まで捲る（scrollIntoView。行が窓の下の端に近いと項目が窓の外に出ていた）。値を今の app.html に合わせた（前の値は 32854479…）
  // 2026-10-26 の持ち主の答え 問2（「⠿ の左に並べる（Notion と同じ並び）」。計画の Ruling R36）: 行の左の ＋ を行の並びの中で ⠿ の左に置いた（.blk .plus の CSS。.blk の切る線は 8px に戻した）。変わる画面は RETAKE_130 の RETAKEN_130 の 10 枚と足した 10 枚。値を今の app.html に合わせた（前の値は ce75391c…）
  // 2026-10-26 の持ち主の答え 点検1（「上に空の行を足す（おすすめ）」。計画の Ruling R37）: 文のある行の頭の Enter で今の行の文を消さず、カーソルを今の行の頭に残す（<script> の中だけ。撮る画面は変わらない）。値を今の app.html に合わせた（前の値は c2964b13…）
  // 2026-10-26 の持ち主の答え 点検4（「どんな手直しでも確かめる（おすすめ）」。計画の Ruling R39）: ［要約を再生成］の確かめをページの印 summaryEdited でも出す（<script> の中だけ。撮る画面は変わらない）。値を今の app.html に合わせた（前の値は e205126e…）
  // 2026-10-26 の持ち主の答え 点検6（「書いている間は切り替えない（おすすめ）」。計画の Ruling R40）: 録音の前のページのメモ・種類の欄に書いている間の保存した page:open は後ろのタブに足す（<script> の中だけ。撮る画面は変わらない）。値を今の app.html に合わせた（前の値は 1674e122…）
  // 点検5（作り手が決めた。計画の Ruling R41）: Enter の1回は oplog の1行（splitRow で分けた前の文を削らない・_commit は画面の文が行の文と同じなら送らない。<script> の中だけ。撮る画面は変わらない）。値を今の app.html に合わせた（前の値は d09354eb…）
  assert.strictEqual(sha, '8a74feb1c87fb98944b52650a69016bf8964d56be9adaaae71702cf858ccc3b1',
    'app.html が基準の画像を撮った時と違う。Windows の CI の画面の比べ（捲り棒のつまみも）を見て、基準を取り直してからこの値を直す');
});

test('ci.yml の electron-smoke: 撮った画面を基準（test/shots/win32）と比べる', { timeout: 5000 }, () => {
  const st = stepsOf(jobsOf(read('.github/workflows/ci.yml'))['electron-smoke']);
  assert.ok(st.some((s) => s.includes('electron.exe tools/shots --compare test/shots/win32 --out "$RUNNER_TEMP/shots"')));
});

test('F9: 最初の画面を1度開いて撮って捨ててから（慣らし）本番を撮る（Windows の CI で、最初に開いた窓だけ縁の画素が実行ごとに2通りに描かれた）', { timeout: 5000 }, () => {
  const m = read('tools/shots/main.js');
  const warm = m.indexOf('const warm = await open(SH.SCREENS[0].page, SH.SCREENS[0].theme, SH.fixtures());');
  const loop = m.indexOf('for (const s of SH.SCREENS) {');
  assert.ok(warm >= 0 && loop > warm, '本番の前に慣らしの窓を開いていない');
  assert.ok(m.slice(warm, loop).includes('await capture(warm.wc)'), '慣らしの窓を撮っていない（描き終わる前に壊すと慣らしにならない）');
  assert.ok(m.slice(warm, loop).includes('warm.win.destroy()'), '慣らしの窓を壊していない');
});

test('F9: 揺れの確かめの2枚目は、描き直させて（invalidate）から撮る（同じ描き終わりの写しを2回比べても揺れは見つからない）', { timeout: 5000 }, () => {
  const m = read('tools/shots/main.js');
  const a = m.indexOf('const a = await capture(o.wc);');
  const b = m.indexOf('const b = await capture(o.wc);');
  assert.ok(a >= 0 && b > a);
  assert.ok(/o\.wc\.invalidate\(\);/.test(m.slice(a, b)), '2枚目の前に描き直させていない');
  // 0.9.0 O-3 で足した: 1枚目も描き直させてから撮る（初めの描き終わりだけが1画素違うことがあった）
  assert.ok(/o\.wc\.invalidate\(\);\s*await settle\(o\.wc, o\.t\);\s*await wait\(300\);\s*const a = await capture\(o\.wc\);/.test(m), '1枚目の前に描き直させていない');
  assert.ok(m.slice(a, b).includes('await settle(o.wc, o.t);'), '描き直しが済むのを待っていない');
});

// 第1b回 載せ直し: Tab の輪の画面の「Tab を何回」は、今の画面の Tab の順（偽 DOM の木の順。正の tabindex は使わない）と合っていること。
// サイドバーの頭に［«］が入って順が1つずれたのに、C-1 の決め（Tab 2 回）が古いままで、CI が #searchBox を撮った（取り直し待ちの間は NG にならない）
test('画面の使いやすさ・F12: Tab の輪の画面の「Tab を何回」は、今の画面の Tab の順でちょうど want に届く', { timeout: 10000 }, async () => {
  const { load } = require('./helpers/simrun');
  const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  const returns = {};
  for (const [k, v] of Object.entries(SH.fixtures())) if (k.startsWith('koeApp.')) returns[k.slice(7)] = () => JSON.parse(JSON.stringify(v));
  const l = await load(APP, { preloadSrc, returns });
  await l.drain();
  const order = l.root._walk([]).filter((e) => {
    for (let n = e; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) {
      const cls = (n.className || '').split(' ');
      if (n.hidden || (cls.includes('tab') && !cls.includes('active')) || n.id === 'pMenu' || (n.style && n.style.display === 'none')) return false;
    }
    if (e.disabled) return false;
    const attr = e.getAttribute('tabindex');
    const ti = e.tabIndex !== undefined ? e.tabIndex : (attr == null ? null : Number(attr));
    if (ti === -1) return false;
    return ['button', 'input', 'select', 'textarea'].includes(e.tagName) || ti === 0 || e.getAttribute('contenteditable') === 'true';
  }).map((e) => e.id || e.className);
  const shots = SH.SCREENS.filter((s) => s.focus);
  assert.ok(shots.length >= 1);
  for (const s of shots) assert.strictEqual(order[s.focus.tabs - 1], s.focus.want, `${s.name}: Tab ${s.focus.tabs} 回で届くのは ${order[s.focus.tabs - 1]}（順: ${order.slice(0, 5).join(' → ')}）`);
});

// 0.9.1 Q-5（計画 docs/plans/2026-10-21-091.md の「取り直す画面」）: 録音中のページの「会議は終わりましたか？」の帯（QA1）・設定の検索「自動で止める」
test('Q-5: live-quiet-light・live-quiet-dark は live-light と同じ会議に quiet（main の quietAskText(10) と同じ文）を入れた形。settings-quiet-search-light は検索「自動で止める」', { timeout: 5000 }, () => {
  const main = read('src/main.js');
  const at = main.indexOf('const quietAskText = (min) => ');
  const ask = new Function(`return ${main.slice(at + 'const quietAskText = '.length, main.indexOf(';\n', at))}`)();   // eslint-disable-line no-new-func
  const live = SH.SCREENS.find((s) => s.name === 'live-light');
  for (const [n, theme] of [['live-quiet-light', 'light'], ['live-quiet-dark', 'dark']]) {
    const s = SH.SCREENS.find((x) => x.name === n);
    assert.ok(s, `${n} が撮る画面に無い`);
    assert.deepStrictEqual([s.page, s.theme, s.zoom], ['app', theme, undefined], n);
    const st = s.answers['koeApp.meetingStatus'];
    assert.deepStrictEqual(st.quiet, { text: ask(10) }, n);
    const { quiet, ...rest } = st;
    assert.deepStrictEqual(rest, live.answers['koeApp.meetingStatus'], `${n} の会議が live-light と違う`);
  }
  const q = SH.SCREENS.find((x) => x.name === 'settings-quiet-search-light');
  assert.ok(q && q.page === 'app' && q.theme === 'light', '設定の検索の画面が無い');
  assert.match(q.act, /tabBtnSettings/);
  assert.match(q.act, /自動で止める/);
  // 録音バーの quiet は状態の表にあり、短い文は main の QUIET_BAR_TEXT と同じ（赤の短い文 err。無音の警告の黄色い点のまま）
  const bar = (/const QUIET_BAR_TEXT = '([^']+)';/.exec(main) || [])[1];
  // 0.9.4 P-1 で意図して変えた: 相手の声の印（spk）を外した
  assert.deepStrictEqual(PS.byState.quiet, { state: 'quiet', mode: 'meeting', phase: 'recording', level: 0, warn: true, msg: { h: bar, v: bar }, kind: 'err' });
  for (const n of QUIET_OVERLAY) assert.ok(SH.SCREENS.some((s) => s.name === n), `${n} が撮る画面に無い`);
});

// 0.9.2 I-4（計画 docs/plans/2026-10-21-092.md の「取り直す画面」）: ⓘ の吹き出しを開いた画面と、吹き出しの中にだけある言葉の検索
test('I-4: 吹き出しの画面は項目を開いて ⓘ を押す act を持ち（モックの3枚と 200%）、検索の画面は吹き出しの中にだけある言葉で探す。アカウントの画面はログインしていない形', { timeout: 5000 }, () => {
  const by = (n) => SH.SCREENS.find((x) => x.name === n);
  const INFO = { 'settings-info-loop-light': ['setNavRecord', 'setPopLoop', 'light', undefined], 'settings-info-stt-dark': ['setNavRecord', 'setPopStt', 'dark', undefined],
    'settings-info-claude-light': ['setNavSummary', 'claudeHelp', 'light', undefined], 'settings-info-zoom200-light': ['setNavRecord', 'setPopLoop', 'light', 2] };
  for (const [n, [nav, pop, theme, zoom]] of Object.entries(INFO)) {
    const s = by(n);
    assert.ok(s, `${n} が撮る画面に無い`);
    assert.deepStrictEqual([s.page, s.theme, s.zoom], ['app', theme, zoom], n);
    assert.ok(s.act.includes('tabBtnSettings') && s.act.includes(nav), `${n}: 項目を開いていない`);
    assert.ok(s.act.includes(`[aria-controls="${pop}"]`) && /\.click\(\)\s*$/.test(s.act.trim().replace(/;$/, '')), `${n}: 最後に ⓘ（${pop}）を押していない`);
  }
  for (const [n, nav, theme, zoom] of [['settings-record-dark', 'setNavRecord', 'dark', undefined], ['settings-record-zoom200-light', 'setNavRecord', 'light', 2],
    ['settings-summary-light', 'setNavSummary', 'light', undefined], ['settings-account-light', 'setNavAccount', 'light', undefined]]) {
    const s = by(n);
    assert.ok(s && s.act.includes(nav) && s.theme === theme && s.zoom === zoom && !s.act.includes('aria-controls'), n);
  }
  assert.strictEqual(by('settings-account-light').answers['koeApp.accountStatus'].signedIn, false, 'アカウントの画面がログインしている形');
  // 検索の言葉は、吹き出しの中にだけある（行の名前・見える説明には無い）
  const q = by('settings-info-search-light');
  const word = (/b\.value = '([^']+)'/.exec(q.act) || [])[1];
  assert.strictEqual(word, 'イヤホン');
  const { parseHTML } = require('./helpers/simdom');
  const doc = parseHTML(read('src/renderer/app.html')).root;
  const sec = doc.querySelector('#tabSettings');
  assert.ok(doc.querySelector('#setPopLoop').textContent.includes(word), '吹き出しに検索の言葉が無い');
  assert.ok(!sec.querySelectorAll('[data-row]').some((r) => r.dataset.row.includes(word)), '行の名前に検索の言葉がある');
  assert.ok(!sec.querySelectorAll('.desc, .d, .lhint').some((d) => !d.closest('.setpop') && d.textContent.includes(word)), '見える説明に検索の言葉がある');
});

// 0.9.3 M-7（計画 docs/plans/2026-10-22-093.md の「取り直す画面」）: 音の波は決まった 20 の値（WAVE_SPEECH）を onMeetingLevel で送って撮る。
// 撮るときの時計は止まっているので「1 秒届かなければ平ら」にならない
test('0.9.3 M-7: 音の波の画面は WAVE_SPEECH の 20 の出来事を送る。無音は「音が入っていません」、一時停止は paused の会議（どれも live-light と同じ会議）', { timeout: 5000 }, () => {
  assert.strictEqual(SH.WAVE_SPEECH.length, 20);
  for (const v of SH.WAVE_SPEECH) assert.ok(typeof v.mic === 'number' && typeof v.sys === 'number' && v.mic >= 0 && v.mic <= 1 && v.sys >= 0 && v.sys <= 1 && v.warn === '', JSON.stringify(v));
  // 照らしても変わらない（main の levelMsg を通った形）。話している形なので、点（0.02 以下）でない棒がほとんど
  for (const v of SH.WAVE_SPEECH) assert.deepStrictEqual(lib.levelMsg(v), v);
  assert.ok(SH.WAVE_SPEECH.filter((v) => Math.max(v.mic, v.sys) > 0.02).length >= 16, '話している形でない');
  assert.ok(SH.WAVE_SPEECH.some((v) => v.sys > v.mic), '相手の声の方が大きい値が無い');
  // 0.9.4 W-1 で意図して足した: 録音中のページは流さず今の大きさだけを5本で描くので、最後の値が話している大きさ（0.5 以上）でないと話している画面にならない
  // （CI run 39826643828 の live-wave-light・live-wave-dark が、最後の 0.12 のためにほとんど平らな点で撮れた）
  const lastV = SH.WAVE_SPEECH[SH.WAVE_SPEECH.length - 1];
  assert.ok(Math.max(lastV.mic, lastV.sys) >= 0.5, `最後の値が小さい: ${JSON.stringify(lastV)}`);
  assert.ok(lib.levelBars(Math.max(lastV.mic, lastV.sys), SH.FIXED_NOW).some((h) => h >= 10), '撮る時刻の5本が伸びていない');
  const live = SH.SCREENS.find((s) => s.name === 'live-light').answers['koeApp.meetingStatus'];
  const by = (n) => SH.SCREENS.find((x) => x.name === n);
  for (const [n, theme] of [['live-wave-light', 'light'], ['live-wave-dark', 'dark']]) {
    const s = by(n);
    assert.ok(s, `${n} が撮る画面に無い`);
    assert.deepStrictEqual([s.page, s.theme, s.zoom, s.act], ['app', theme, undefined, undefined], n);
    // CI run 39751610440 で、Windows の CI の機械の「動きを減らす」（reduce）のために真ん中の5本だけの形で撮れた。話している波は no-preference で撮る
    assert.strictEqual(s.motion, 'no-preference', `${n}: 動きを減らさない形で撮っていない`);
    assert.deepStrictEqual(s.events, SH.WAVE_SPEECH.map((v) => ['onMeetingLevel', v]), n);
    assert.deepStrictEqual(s.answers['koeApp.meetingStatus'], live, `${n} の会議が live-light と違う`);
  }
  const q = by('live-silent-light');
  assert.ok(q && q.page === 'app' && q.theme === 'light', 'live-silent-light が無い');
  assert.ok(q.events.length >= 1 && q.events.every(([name, v]) => name === 'onMeetingLevel' && v.mic === 0 && v.sys === 0 && v.warn === '音が入っていません'), '無音の出来事でない');
  assert.ok(lib.LEVEL_WARNS.includes('音が入っていません'));
  assert.deepStrictEqual(q.answers['koeApp.meetingStatus'], live);
  const p = by('live-paused-dark');
  assert.ok(p && p.page === 'app' && p.theme === 'dark', 'live-paused-dark が無い');
  const { paused, ...rest } = p.answers['koeApp.meetingStatus'];
  assert.strictEqual(paused, true);
  const { paused: _p, ...liveRest } = live;
  assert.deepStrictEqual(rest, liveRest, 'live-paused-dark の会議が live-light と違う');
  // 設定の「会議の検出」: 出さないアプリ Zoom の札のある形で、項目「録音」を開く
  for (const [n, theme] of [['settings-detect-light', 'light'], ['settings-detect-dark', 'dark']]) {
    const s = by(n);
    assert.ok(s && s.page === 'app' && s.theme === theme, `${n} が無い`);
    assert.ok(s.act.includes('tabBtnSettings') && s.act.includes('setNavRecord'), `${n}: 項目「録音」を開いていない`);
    const st = s.answers['koeApp.getSettings'];
    assert.deepStrictEqual([st.meetingDetect, st.meetingDetectMute], [true, ['zoom']], n);
    const { meetingDetect, meetingDetectMute, ...others } = st;
    assert.deepStrictEqual(others, SH.fixtures()['koeApp.getSettings'], `${n}: ほかの設定が見本と違う`);
  }
  // 撮る道具は events を順に送る（本体の画面も、パネルも）
  const m = read('tools/shots/main.js');
  assert.match(m, /if \(s\.motion\) await o\.wc\.debugger\.sendCommand\('Emulation\.setEmulatedMedia', \{ features: \[\{ name: 'prefers-reduced-motion', value: s\.motion \}\] \}\);\n\s*\/\/[^\n]*\n\s*for \(const \[name, payload\] of s\.events/, '出来事を送る前に motion を当てていない');
  assert.match(m, /for \(const \[name, payload\] of s\.events \|\| \[\]\) o\.wc\.send\(`shots:event:\$\{BRIDGE\[s\.page\]\}\.\$\{name\}`, payload\)/);
});

// 0.9.3 持ち主の答え D55: オフラインモードの会議の録音中のページ（札「オフラインモード中」・記録の行の「オフライン」）。live-light と同じ会議を、
// オフラインモード（localOnly）・PC の中の文字起こし（区切り 75 秒）・相手の声も録っている形にした（記録の行が「議事録を記録中（相手の声も・オフライン）」になる）
test('0.9.3 D55: オフラインモードの画面（live-offline-light・live-offline-dark）は live-light と同じ会議に localOnly・相手の声も・PC の中の文字起こし。準備のある PC（needsSetup なし）', { timeout: 5000 }, () => {
  const live = SH.SCREENS.find((s) => s.name === 'live-light').answers['koeApp.meetingStatus'];
  for (const [n, theme] of [['live-offline-light', 'light'], ['live-offline-dark', 'dark']]) {
    const s = SH.SCREENS.find((x) => x.name === n);
    assert.ok(s, `${n} が撮る画面に無い`);
    assert.deepStrictEqual([s.page, s.theme, s.zoom, s.act, s.events], ['app', theme, undefined, undefined, undefined], n);
    const st = s.answers['koeApp.meetingStatus'];
    assert.deepStrictEqual([st.localOnly, st.systemAudio, st.cloud, st.needsSetup, st.paused, st.finalizing], [true, true, true, undefined, false, false], n);
    assert.deepStrictEqual(st.stt, { route: 'local', lastTextAt: SH.FIXED_NOW - 12000, segSec: 75, problem: null }, n);
    const { localOnly, systemAudio, stt, ...rest } = st;
    const { localOnly: _l, systemAudio: _s, stt: _t, ...liveRest } = live;
    assert.deepStrictEqual(rest, liveRest, `${n} の会議が live-light と違う`);
    // 0.9.3 で意図して変えた（版を 0.9.3 に上げる commit）: 持ち主が OK と言った CI の画像を基準にした
    // 0.9.4 W-1 で意図して変えた: 0.9.4 の表（RETAKE_094）にあるときだけ取り直し待ちでよい（録音中のページの5つの点）
    // 0.9.4 で意図して変えた（版を 0.9.4 に上げる commit）: 持ち主が OK と言った CI の画像を基準にした
    // 0.10.0 SH-1 で意図して変えた: 0.10.0 の表（RETAKE_100）にあるときだけ取り直し待ちでよい（左の一覧の見本の題名）
    // 0.10.0 で意図して変えた（版を 0.10.0 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
    // 0.11.0 V-1 で意図して変えた: 0.11.0 の表（ADDED_110）にあるときだけ取り直し待ちでよい（録音中のページの種類の行と一言）
    // 0.11.0 で意図して変えた（版を 0.11.0 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
    // 0.11.1 LG-4 で意図して変えた: 0.11.1 の表（ADDED_LOGO）にあるときだけ取り直し待ちでよい（サイドバーの頭のロゴ）
    // 0.11.1 で意図して変えた（版を 0.11.1 に上げる commit）: 持ち主が OK と言った CI の画像を基準にしたので、また取り直し待ちではない
    assert.ok((!SH.RETAKE.has(n) || ADDED_LOGO.includes(n)) && fs.existsSync(path.join(ROOT, 'test', 'shots', 'win32', `${n}.png`)), `${n} が取り直し待ちに残っているか、基準が無い`);
  }
});

test('0.9.3 M-7: パネルの画面は透過の窓で撮る（明暗は onShow の theme・地はデスクトップの色・窓は main と同じ nudgeBounds・150% は窓 × 拡大率・⌄ を開いた形）', { timeout: 5000 }, () => {
  const all = SH.SCREENS.filter((s) => s.page === 'nudge');
  const want = { 'nudge-light-100': ['light', 1, false], 'nudge-dark-100': ['dark', 1, false], 'nudge-light-150': ['light', 1.5, false],
    'nudge-menu-light-100': ['light', 1, true], 'nudge-menu-dark-100': ['dark', 1, true] };
  assert.deepStrictEqual(all.map((s) => s.name), Object.keys(want));
  for (const s of all) {
    const [theme, scale, menu] = want[s.name];
    assert.deepStrictEqual([s.theme, s.scale], [theme, scale], s.name);
    assert.deepStrictEqual(s.events, [['onShow', { label: 'Zoom', theme }]], s.name);
    assert.ok(s.act.includes(`document.body.style.background = '${PS.DESKS[theme]}'`), `${s.name}: 地がデスクトップの色でない`);
    assert.strictEqual(s.act.includes("getElementById('nzMore').click()"), menu, `${s.name}: ⌄ の開き方`);
  }
  // 窓の大きさは main と同じ nudgeBounds（周りに影の輪の余白 NUDGE_PAD）
  assert.deepStrictEqual(SH.nudgeWindowFor({ w: 500.2, h: 60 }), (({ width, height }) => ({ width, height }))(lib.nudgeBounds({ size: { w: 500.2, h: 60 }, workArea: SH.SHOT_AREA })));
  assert.deepStrictEqual(SH.nudgeWindowFor({ w: 500.2, h: 60 }), { width: 501 + 2 * lib.NUDGE_PAD, height: 60 + 2 * lib.NUDGE_PAD });
  assert.deepStrictEqual(SH.NUDGE_SIZE, { width: lib.NUDGE_FIRST.w + 2 * lib.NUDGE_PAD, height: lib.NUDGE_FIRST.h + 2 * lib.NUDGE_PAD });
  // パネルの四角を測る文は #nz を測り、judgePanel と同じ形で返す（窓の内側に余白で入らなければ NG）
  assert.ok(SH.NUDGE_PROBE.includes("getElementById('nz')"));
  assert.strictEqual(SH.judgePanel({ pill: { left: 8, top: 8, right: 508, bottom: 68 }, iw: 516, ih: 76 }).ok, true);
  const m = read('tools/shots/main.js');
  assert.match(m, /PAGES = \{[^}]*nudge: path\.join\(SRC, 'renderer', 'nudge\.html'\)/, '撮る道具の画面に nudge.html が無い（守りの CSP のハッシュも作られない）');
  assert.match(m, /BRIDGE = \{[^}]*nudge: 'koeNudge'/);
  assert.match(m, /\.\.\.\(page === 'app' \? \{\} : \{ transparent: true, backgroundColor: '#00000000' \}\)/, 'パネルを透過の窓で開いていない');
  assert.ok(m.includes("if (s.page === 'nudge') { await shootNudge(s); continue; }"), 'パネルの画面を撮る道が無い');
  assert.ok(m.includes('SH.nudgeWindowFor(') && m.includes('SH.NUDGE_PROBE') && m.includes('SH.shotSizeFor(winSize, scale)'));
  // 本物の preload のパネルの橋（koeNudge）が偽の橋の名前にある
  assert.ok(SH.apiNamesOf(read('src/preload.js')).koeNudge.includes('onShow'));
});
