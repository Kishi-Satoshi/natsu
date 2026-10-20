/*
 * shots/screens.js — 画面を撮って比べる道具（第1a回 G2・PERF）の決め方。純粋（Electron を読まない。test/shots.test.js が試す）
 *
 * 撮るのは tools/shots/main.js（Electron の main）。ここには、撮る画面の並び・偽の橋の名前と見本の答え・
 * 同じ画面を2回撮ったときの揺れの判定・基準との比べ・CSP の違反の行の見分け・開く速さの判定・終了コードを置く。
 *
 * 画面は今日の日付で文字を変える（relTime の「N時間前」・dueInfo の「N日超過」・音声入力の「今日の入力」）。
 * 撮るときは時計を FIXED_NOW に止め、時間帯を TIME_ZONE にし、アニメーションを FREEZE_CSS で止める。
 * 見本の日付は、どれも止めた時計より前の決まった日にする（基準を取った次の日に CI が赤にならない）。
 *
 * 第1b回 C-1: 画面ごとに、偽の橋の答えを足せる（answers。fixtures に上から重ねる）・拡大できる（zoom）・Tab を送ってから撮れる（focus）。
 * 本体の画面はどれも、撮る前に横のはみ出しを集めて（OVERFLOW_PROBE）judgeOverflow で決める。
 * 意図して変える画面は取り直し待ちの一覧（RETAKE）に入れ、基準と違っても NG にしない（揺れ・CSP・はみ出しは NG のまま）。
 *
 * 0.9.0 O-3（設計書 D25・RP9・F11）: 録音バーを作り直したので、録音バーの画面を状態 × 形 × 地 × 拡大率（tools/shots/pill-states.js）で撮る
 * （第1a回の overlay-processing は外した）。窓の大きさは撮るときに測ったピルの大きさから main と同じ panelBounds で決め（panelWindowFor）、
 * 拡大率の画面は「窓 × 拡大率」の大きさで撮れたかを見る（shotSizeFor）。ピルが窓の内側に 4px 以上の余白で入るか（PANEL_PROBE・judgePanel）は
 * 取り直し待ちでも NG。撮る道具の見張りは画面の数で決める（watchdogMs: 30 秒 + 枚数 × 6 秒）。
 */
'use strict';

const path = require('path');
const mtype = require('../../src/meetingType');
const { MANIFEST } = require('../../src/engine-manifest');
const lib = require('../../src/mainlib');
const PS = require('./pill-states');

const SIZE = { width: 1120, height: 780 };         // 本体の窓の既定（main.js の createMainWindow）
// 録音バーの窓の初めの大きさ（main.js の createOverlay と同じ panelBounds の PANEL_FIRST の横。撮るときは測ったピルの大きさに合わせ直す）
const SHOT_AREA = { x: 0, y: 0, width: 4000, height: 4000 };
const OVERLAY_SIZE = (({ width, height }) => ({ width, height }))(lib.panelBounds({ slot: 'bottom-center', size: null, workArea: SHOT_AREA }));
const FIXED_NOW = Date.UTC(2026, 9, 18, 0, 0, 0);   // 撮るときの時計（2026-10-18 09:00 日本時間）。見本の日付はこれより前の決まった日
// 録音中のページの文字起こしの状態（第1d回 A-7。main の meetingStatus().stt の形）。帯の文は main の STT_BANNER の B8 と同じ（test/shots.test.js が照らす）
const LIVE_STT = { route: 'cloud', lastTextAt: FIXED_NOW - 12000, segSec: 15, problem: null };
const BANNER_STT = { route: 'local', lastTextAt: FIXED_NOW - 12000, segSec: 15,
  problem: { code: 'relay-down', action: '', text: 'NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。' } };

// 一覧の1行目を開く（今の画面と同じ）
const OPEN_PAGE = "document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click()";
// サイドバーを畳む。第1b回 B-2 の前は［«］が無いので何もしない
const COLLAPSE_SIDE = "(document.getElementById('sideCollapse') || { click() {} }).click()";
// 検索の窓を開く（第1b2回 L-2 の［🔍 検索］）。L-2 の前は押す物が無いので何もしない
const OPEN_PALETTE = "(document.getElementById('sideSearch') || { click() {} }).click()";
// タブ3つ（ページ・音声入力・ページ）を開いて、最後にページを選ぶ。ページを開くのは非同期なので、押すたびに少し待つ（返す promise を main が待つ）。
// 0.9.0 U-1（SP1・D24）で意図して変えた: 設定はタブで開かない（ポップアップ）ので、3つ目は2行目のページを新しいタブ（Ctrl+クリック）で開く
const OPEN_THREE_TABS = `(async () => {
  const w = () => new Promise((r) => setTimeout(r, 150));
  const item = (i) => document.querySelectorAll('#plist .pitem')[i || 0];
  document.getElementById('tabBtnNotes').click(); item().click(); await w();
  document.getElementById('tabBtnDictation').click(); await w();
  item(1).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); await w();
  document.getElementById('tabBtnNotes').click(); item().click(); await w();
  return 1;
})()`;
const SCREENS = [
  { name: 'notes-empty-light', page: 'app', theme: 'light', act: "document.getElementById('tabBtnNotes').click()" },
  { name: 'notes-page-light', page: 'app', theme: 'light', act: "document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click()" },
  { name: 'notes-page-dark', page: 'app', theme: 'dark', act: "document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click()" },
  { name: 'dictation-light', page: 'app', theme: 'light', act: "document.getElementById('tabBtnDictation').click()" },
  { name: 'settings-light', page: 'app', theme: 'light', act: "document.getElementById('tabBtnSettings').click()" },
  { name: 'settings-dark', page: 'app', theme: 'dark', act: "document.getElementById('tabBtnSettings').click()" },
  // 第1b回で足した画面（C-2 で基準を取るまでは取り直し待ち）
  { name: 'notes-tabs-light', page: 'app', theme: 'light', act: OPEN_THREE_TABS },
  { name: 'notes-collapsed-light', page: 'app', theme: 'light', act: `${OPEN_PAGE}; ${COLLAPSE_SIDE}` },
  { name: 'live-light', page: 'app', theme: 'light', answers: liveAnswers() },
  { name: 'live-dark', page: 'app', theme: 'dark', answers: liveAnswers() },
  { name: 'notes-page-zoom200-light', page: 'app', theme: 'light', zoom: 2, act: OPEN_PAGE },
  { name: 'settings-zoom200-dark', page: 'app', theme: 'dark', zoom: 2, act: "document.getElementById('tabBtnSettings').click()" },
  // 第1b2回 R-3: 検索の窓（L-2 の #sideSearch を押して開く）。L-2 の前は押す物が無いので何もしない（取り直し待ちなので赤にならない）
  { name: 'search-palette-light', page: 'app', theme: 'light', act: `${OPEN_PAGE}; ${OPEN_PALETTE}` },
  // 第1d回 A-7（RL14・D17）: 録音中のページの頭の帯（live-light と同じ会議に帯 relay-down（B8）を入れた形。取り直し待ち）
  { name: 'live-banner-light', page: 'app', theme: 'light', answers: liveAnswers(BANNER_STT) },
  // 第1d回 A-13（あとの直し (b)）: 帯の暗い画面と 200% の暗い画面（live-banner-light と同じ会議と帯。注意の色の枠と文字を暗い地と折り返しで見る。取り直し待ち）
  { name: 'live-banner-dark', page: 'app', theme: 'dark', answers: liveAnswers(BANNER_STT) },
  { name: 'live-banner-zoom200-dark', page: 'app', theme: 'dark', zoom: 2, answers: liveAnswers(BANNER_STT) },
  // 0.9.0 U-2（SP4・SP5・D24）: 設定のポップアップの項目「録音」と、検索「マイク」の結果（足した画面でまだ基準が無い。取り直し待ち）
  { name: 'settings-record-light', page: 'app', theme: 'light', act: "document.getElementById('tabBtnSettings').click(); document.getElementById('setNavRecord').click()" },
  { name: 'settings-search-light', page: 'app', theme: 'light',
    act: "document.getElementById('tabBtnSettings').click(); const b = document.getElementById('setSearch'); b.value = 'マイク'; b.dispatchEvent(new Event('input', { bubbles: true }))" },
  // 0.9.0 U-3（OF7・D21）: オフラインの準備を選んでいない人のカード「オフライン」（OFF1〜OFF5。足した画面でまだ基準が無い。取り直し待ち）。
  // ログインしている形にする（ログインしていないと、起動で設定の「アカウント」が開く: 計画 U-3）
  { name: 'settings-offline-light', page: 'app', theme: 'light', answers: offlineAnswers(),
    act: "document.getElementById('tabBtnSettings').click(); document.getElementById('setNavOffline').click()" },
];
// 0.9.0 O-3（RP9）: 録音バーの画面（形 → 地 → 拡大率 → 状態の順。撮る道具は形・地・拡大率の組ごとに窓を1つ開いて状態を act で替える）。
// 録音は始めずに見た目だけを撮る（act は pill-states の見本を録音バーの DOM に当てる。撮るときだけ体の地にデスクトップの色を塗る）。
// slot は窓の大きさを決める置き場所（横は下の中央、縦は右の中央）
for (const form of PS.FORMS) for (const desk of Object.keys(PS.DESKS)) for (const scale of PS.SCALES) for (const st of PS.STATES) {
  SCREENS.push({
    name: `overlay-${form}-${desk}-${st.state}-${Math.round(scale * 100)}`, page: 'overlay', theme: desk, act: PS.actFor(st.state, form, desk),
    scale, slot: form === 'v' ? 'middle-right' : 'bottom-center', pill: { state: st.state, form, desk, scale },
  });
}
// Tab の輪を見る画面は1つだけ（何も選んでいない所から Tab を3回で［● 記録開始］。サイドバーの頭の［«］→ 検索 → ［● 記録開始］）
SCREENS.find((x) => x.name === 'notes-page-light').focus = { tabs: 3, want: 'mtToggleBtn' };

/**
 * 取り直し待ち（第1b回 F14）: この回で意図して見た目を変える画面。基準と違っても（diff・size・missing）NG にせず「取り直し待ち」と出す。
 * 録音バー（overlay-processing）は入れない（overlay.html は変えないので、違えば本当の崩れ）。C-2 で CI の画像から基準を取り直して空にする
 */
// 第1b回 Task C-2 で空にした（13 枚を Windows の CI の画像から取り直し、利用者が 2026-10-19 に OK と言った）。
// 0.7.0 U-2（設計書 D5・D8）で設定の3枚を取り直し待ちにした（いちばん上の「外観」と、送り先と同意の欄を外した「オンライン」）。
// 利用者が CI の新しい画像を見て OK と言ったら、その画像を基準にして空に戻す（2026-10-19 に OK をもらって空にした）。
// 第1d回 A-4（RL10・F11）で設定の3枚をまた取り直し待ちにした（外観のすぐ下に「アカウント」のカードを足し、「オンライン」のカードの説明を替えて
// ［詳細設定（管理者用）］の鍵の欄を消した）。0.8.0 を出す前に、利用者が CI の新しい3枚を見て OK と言ったら基準にして空に戻す
// 第1d回 A-7（RL14・D17）で録音中のページの3枚を足した（記録の行に文字起こしの状態の行、その上に帯。live-banner-light は足した画面でまだ基準が無い）。
// 同じく、利用者が CI の新しい画像を見て OK と言ったら基準にして空に戻す（空になるまで版を上げられない: test/shots.test.js）
// 第1d回 A-13 で帯の暗い画面と 200% の暗い画面（live-banner-dark・live-banner-zoom200-dark。足した画面でまだ基準が無い）を足して8枚にした
// （設定の3枚はカード「オフライン」（D19）、録音中のページの3枚は［この会議は PC の中だけ］を1行目に（D20）でも見た目が変わる）
// 第1d回 G-4: 利用者が 2026-10-20 に CI の新しい8枚（run 39398639423・artifact 12252523286）を見て OK と言ったので、その画像を基準にして空に戻した
// 0.9.0（計画 docs/plans/2026-10-20-090.md の「取り直す画面」）: B-1（BN1・D26）で帯の文を B8 の新しい文にしたので、帯の3枚を取り直し待ちにした。
// U・O の画面は各タスクが足す。利用者がまとめて OK と言ったら G-3 で基準にして空に戻す
// 0.9.0（計画 docs/plans/2026-10-20-090.md の「取り直す画面」）: U-1（SP1〜SP3・D24）で設定をポップアップにしたので、設定の3枚と、
// 3つのタブの並びから設定のタブが消える notes-tabs-light を取り直し待ちにした（B・O の画面は各タスクが足す）。
// 利用者がまとめて OK と言ったら G-3 で基準にして空に戻す
// U-2（SP4・SP5）で足した設定の項目「録音」と検索の画面（settings-record-light・settings-search-light。まだ基準が無い）も入れた。
// U-3（OF7）で足した準備を選んでいない人のカード「オフライン」の画面（settings-offline-light。まだ基準が無い）も入れた。
const RETAKE = new Set(['live-banner-light', 'live-banner-dark', 'live-banner-zoom200-dark', 'notes-tabs-light', 'settings-light', 'settings-dark', 'settings-zoom200-dark', 'settings-record-light', 'settings-search-light', 'settings-offline-light']);
// 0.9.0 O-3（設計書 D25）: 録音バーを作り直したので、録音バーの画面は全部取り直し待ち（新しい画面で基準がまだ無い）。利用者が CI の画像を見て
// OK と言ったら、G-3 でその画像を基準にして、この行ごと外して空に戻す
for (const s of SCREENS) if (s.page === 'overlay') RETAKE.add(s.name);
const PERF = [{ name: 'open-2000-blocks', budgetMs: 500 }];   // 3回開いた中央値で見る
const TIME_ZONE = 'Asia/Tokyo';
const TOLERANCE = 2;   // 色の差（0〜255）がこれ以下の画素は同じとみなす。CI の機械の CPU ごとの描き方の1段の差を拾わないため（揺れの確かめ judgePair は 0 で見る）
const FREEZE_CSS = '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}';

/**
 * preload.js の exposeInMainWorld から、橋の名前ごとの関数の名前を取る（test/helpers/simrun.js の preloadApis と同じ読み方。
 * テストが同じ結果になることを見る）。偽の橋（tools/shots/preload.js）はこの名前で作るので、本物の preload に足した関数も撮る画面に届く。
 * @returns {{ [bridge: string]: string[] }}
 */
function apiNamesOf(preloadSrc) {
  const src = String(preloadSrc || '');
  const out = {};
  const re = /exposeInMainWorld\(\s*'([^']+)'\s*,\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    let depth = 1;
    while (i < src.length && depth > 0) { const c = src[i]; if (c === '{') depth++; else if (c === '}') depth--; i++; }
    const body = src.slice(re.lastIndex, i - 1);
    const names = [];
    let d = 0;
    for (const line of body.split('\n')) {
      const t = line.trim();
      const k = d === 0 && /^([A-Za-z_$][\w$]*)\s*:/.exec(t);
      if (k) names.push(k[1]);
      for (const c of line) { if ('{(['.includes(c)) d++; else if ('})]'.includes(c)) d--; }
      d = Math.max(0, d);
    }
    out[m[1]] = names;
  }
  return out;
}

// ---------------------------------------------------------------- 見本の答え（偽の橋が返す）
// 人の名前は、テストの見本（test/fixtures.js）と同じ代表的な置き名だけを使う。パスは置き場所の形だけ（利用者名を出さない）
const ENGINE_DIR = 'C:\\NaTsu\\engine';
const SEGMENTS = [
  { id: 's1', atMs: 0, text: 'それでは週次の定例を始めます。まず進み具合から順にお願いします。' },
  { id: 's2', atMs: 75000, text: '受注の画面の直しは、結合の試験が今週で終わりました。残りの不具合は2件です。' },
  { id: 's3', atMs: 150000, text: '在庫の取り込みが遅いので、山田さんに実行計画を見てもらえますか。期限は10月14日でお願いします。' },
  { id: 's4', atMs: 225000, text: '分かりました。索引が効いているかを確かめます。' },
  { id: 's5', atMs: 300000, text: '求人票の見直しは、佐藤さんが今月末までに案を出します。' },
  { id: 's6', atMs: 375000, text: '出す日は11月15日で決まりです。以上で終わります。' },
];
const PAGE = {
  id: 'p1', title: '週次定例（見本）', date: '2026-10-16', durationSec: 1820,
  memo: '議題: 進み具合 / 在庫の取り込み / 採用',
  meetingType: 'standup', typeAuto: true, autoType: 'standup',
  createdAt: '2026-10-16T01:00:00.000Z', updatedAt: '2026-10-16T01:40:00.000Z',
  recovered: false, summaryError: '',
  blocks: [
    { id: 'b1', type: 'heading', text: '概要' },
    { id: 'b2', type: 'bullet', text: '結合の試験が終わり、残りの不具合は2件になった。', cites: ['s2'] },
    { id: 'b3', type: 'heading', text: '決まったこと' },
    { id: 'b4', type: 'bullet', text: '出す日を11月15日に決めた。', cites: ['s6'] },
    { id: 'b5', type: 'heading', text: 'アクションアイテム' },
    { id: 'b6', type: 'todo', text: '在庫の取り込みの実行計画を確かめる', checked: false, assignee: '山田', due: '2026-10-14', dueRaw: '10月14日', cites: ['s3', 's4'] },
    { id: 'b7', type: 'todo', text: '求人票の見直しの案を出す', checked: false, assignee: '佐藤', due: '', dueRaw: '今月末', cites: ['s5'] },
    { id: 'b8', type: 'todo', text: '残りの不具合2件を直す', checked: true, cites: [] },
    { id: 'b9', type: 'bullet', text: '次回は会議室を替える。', citeState: 'manual', cites: [] },
  ],
  citeStat: { linked: 5, total: 6 },
  actionStat: { total: 3, withAssignee: 2, withDue: 1 },
};
const LIST = [
  { id: 'p1', title: PAGE.title, date: '2026-10-16', durationSec: 1820, createdAt: PAGE.createdAt, updatedAt: PAGE.updatedAt, meetingType: 'standup', hasSummary: true },
  { id: 'p2', title: '設計の打ち合わせ（見本）', date: '2026-10-09', durationSec: 2710, createdAt: '2026-10-09T05:00:00.000Z', updatedAt: '2026-10-09T05:50:00.000Z', meetingType: 'general', hasSummary: true },
  { id: 'p3', title: '1on1（見本）', date: '2026-10-01', durationSec: 905, createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:20:00.000Z', meetingType: 'general', hasSummary: false },
];
const HISTORY = [
  // 止めた時計（10/18 09:00 日本時間）の 30 分前。「今日の入力」と「30分前」が出る
  { id: 'h1', text: '明日の打ち合わせは10時からに変更になりました。資料は前日までに共有します。', createdAt: '2026-10-17T23:30:00.000Z', durationSec: 9, chars: 38, procMs: 1400 },
  { id: 'h2', text: '見積もりの件、承知しました。来週の水曜までにお送りします。', createdAt: '2026-10-16T06:12:00.000Z', durationSec: 7, chars: 29, procMs: 1100 },
  { id: 'h3', text: '会議室の予約をお願いします。', createdAt: '2026-10-01T02:05:00.000Z', durationSec: 3, chars: 13, procMs: 800 },
];

/**
 * 記録中の画面（live-light・live-dark）の答え: main の meetingStatus() の形。区間3つ・一時停止の印1つ（第1b回 A-3 の pauses）・
 * クラウドで文字起こしする設定（cloud: true）で［この会議は PC の中だけ］が出る。時刻は止めた時計からの決まった差
 * 第1d回 A-7（D17）: 文字起こしの状態 stt（A-6 の形）。既定はクラウドで最後の文字が 12 秒前・帯なし（撮るときの時計は止まるので揺れない）。
 * stt を渡すとそれに替える（live-banner-light は帯 relay-down）
 */
// 0.9.0 U-3: オフラインの準備を選んでいない PC の答え（engine:status の chosen が偽・取り込みの欄はまだ取り込んでいず、押したことも無い。空き 20GB）
function offlineAnswers() {
  const total = MANIFEST.items.reduce((n, i) => n + i.size, 0);
  const whisperBytes = MANIFEST.items.filter((i) => i.group === 'whisper').reduce((n, i) => n + i.size, 0);
  return {
    'koeApp.engineStatus': { ok: true, whisper: 'PC の中の文字起こしはまだ取り込んでいません。', sum: '', chosen: false },
    'koeApp.engineFetchStatus': { ok: true, supported: true, mode: { whisper: 'managed', sum: 'managed' }, state: 'missing', totalBytes: total, doneBytes: 0,
      needBytes: total, whisperBytes, freeBytes: 20e9, whisperReady: false, sumReady: false, runtime: null, askIt: false, report: '', consent: false, userPaused: false,
      items: MANIFEST.items.map((i) => ({ id: i.id, group: i.group, label: i.label, version: i.version, file: (i.dest || i.dir).split('/').pop(), url: i.url,
        host: new URL(i.url).hostname, sha256: i.sha256, size: i.size, done: 0, state: 'missing', license: i.license, place: '%LOCALAPPDATA%\\natsu\\engine\\…' })),
      error: null },
    'koeApp.accountStatus': { ok: true, signedIn: true, email: '', method: 'access', until: null, canStore: true, online: { up: true, why: 'ok' } },
  };
}
function liveAnswers(stt = LIVE_STT) {
  const segs = [
    { id: 's1', atMs: 0, durationMs: 75000, text: 'それでは週次の定例を始めます。まず進み具合から順にお願いします。' },
    { id: 's2', atMs: 75000, durationMs: 75000, text: '受注の画面の直しは、結合の試験が今週で終わりました。残りの不具合は2件です。' },
    { id: 's3', atMs: 150000, durationMs: 75000, text: '在庫の取り込みが遅いので、実行計画を見てもらえますか。' },
  ];
  return {
    'koeApp.meetingStatus': {
      active: true, finalizing: false, startedAt: FIXED_NOW - 300000, memo: '議題: 進み具合 / 在庫の取り込み',
      segments: segs, pending: 0, stoppedAt: null, stopping: false, paused: false, pausedMs: 45000,
      systemAudio: false, micFallback: false, etaSec: null, skipped: 0,
      pauses: [{ atMs: 150000, ms: 45000, why: 'user' }], pausing: false, resumeHint: false,
      localOnly: false, cloud: true, stt,
    },
  };
}

/**
 * 偽の橋の答え: { '<橋>.<関数>': 値 }。値は main の受け口が返す形（main.js の ipcMain.handle）。
 * ここに無い関数は main が { ok: true } を返す（test/helpers/simrun.js と同じ）。日付は 2026-10-01 などの決まった過去の日。
 */
function fixtures() {
  return JSON.parse(JSON.stringify({
    'koeApp.getSettings': {
      localServerExe: `${ENGINE_DIR}\\whisper\\whisper-server.exe`, localModelPath: `${ENGINE_DIR}\\models\\ggml-model.bin`,
      localThreads: 4, localPort: 8990, vadModelPath: '', useVad: true, suppressNst: true,
      sumServerExe: `${ENGINE_DIR}\\llama\\llama-server.exe`, sumModelPath: `${ENGINE_DIR}\\models\\summary.gguf`,
      sumThreads: 4, sumPort: 8991, sumCtx: 16384, sumGpuLayers: 0, engineIdleMin: 10, autoSummarize: true,
      hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M', segmentSec: 75, pillPos: 'bottom', micId: '',
      language: 'ja', autoPaste: true, removeFillers: true, soundFeedback: true, autoLaunch: false,
      dictionary: ['議事録', '結合試験'], useBuiltinTerms: true, stayInTray: false, theme: 'system', useSystemAudio: false,
    },
    'koeApp.vadStatus': { path: `${ENGINE_DIR}\\models\\ggml-silero-vad.bin`, auto: true },
    'koeApp.engineStatus': { ok: true, whisper: '', sum: '' },
    'koeApp.engineFetchStatus': null,   // 取り込みの欄は出さない（取り込みの状態で画面が変わらないように）
    'koeApp.hotkeyState': { ok: true, failed: [], fallback: {}, message: '' },
    // 第1d回 A-12: カード「アカウント」はログインしていない形（AR1・AR2 と［ログイン］）。main の account:status の形（cookie は入っていない）
    'koeApp.accountStatus': { ok: true, signedIn: false, email: '', method: 'access', until: null, canStore: true, online: { up: true, why: 'ok' } },
    'koeApp.promptInfo': { ok: true, kept: 2, total: 2, over: false },
    'koeApp.meetingTypes': mtype.listTypes(),
    'koeApp.appVersion': { version: '0.4.0', repo: '' },   // 版を上げても画面が変わらないように決まった値
    'koeApp.getHistory': HISTORY,
    'koeApp.meetingStatus': { active: false, paused: false, startedAt: null, segments: [] },
    'koeApp.pagesSearch': LIST,
    'koeApp.pagesSearchFull': { hits: [], total: 0, truncated: false },
    'koeApp.pageGet': { page: PAGE, segments: SEGMENTS },
  }));
}

/**
 * page:get の答えの形（main.js の ipcMain.handle('page:get')）の { page, segments }。2,000 ブロック（見出し・箇条書き・ToDo を順に）と
 * 1万行の発言。PERF の計りのときだけ pageGet の答えにする。
 */
function bigPage() {
  const segments = [];
  for (let i = 0; i < 10000; i++) {
    segments.push({ id: `s${i + 1}`, atMs: i * 7000, text: `${i + 1} 行目の発言です。進み具合と次の手を確かめ、決まったことを順に読み上げます。` });
  }
  const blocks = [];
  for (let i = 0; i < 2000; i++) {
    const n = i + 1;
    const kind = i % 3;
    if (kind === 0) blocks.push({ id: `b${n}`, type: 'heading', text: `見出し ${n}` });
    else if (kind === 1) blocks.push({ id: `b${n}`, type: 'bullet', text: `${n} 番目の要点。文字起こしの発言に出典を付けています。`, cites: [`s${(i * 5) % 10000 + 1}`] });
    else blocks.push({ id: `b${n}`, type: 'todo', text: `${n} 番目のやること`, checked: i % 2 === 0, assignee: i % 4 === 0 ? '山田' : '', due: i % 4 === 0 ? '2026-10-14' : '', dueRaw: '', cites: [] });
  }
  const page = {
    id: 'big', title: '2,000 ブロックの見本', date: '2026-10-01', durationSec: 70000, memo: '',
    meetingType: 'general', typeAuto: true, autoType: 'general',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', recovered: false, summaryError: '',
    blocks,
  };
  return { page, segments };
}

/** PERF の計りで一覧に出す1行（押すと bigPage を開く） */
function bigListEntry() {
  const { page } = bigPage();
  return { id: page.id, title: page.title, date: page.date, durationSec: page.durationSec, createdAt: page.createdAt, updatedAt: page.updatedAt, meetingType: 'general', hasSummary: true };
}

// ---------------------------------------------------------------- 判定（純粋）

/** 同じ画面を2回撮った RGBA → { ok, note }。1画素でも違えば揺れ（'flaky'）。差を許さない */
function judgePair(a, b, png) {
  const d = png.diffImages(a, b, { tolerance: 0 });
  if (d.same) return { ok: true, note: `2回とも同じ（${a.width}x${a.height}）` };
  return { ok: false, note: d.sizeMismatch ? 'flaky: 2回の大きさが違う' : `flaky: ${d.count} 画素が違う` };
}

/**
 * 撮った画面を基準と比べる。shots: { name: { width, height, data } } → [{ name, status, count? }]（shots の並び）。
 * 'diff'・'size' なら outDir に <name>.before.png（基準）・<name>.after.png（今）・<name>.diff.png、'missing' なら <name>.after.png。
 * 基準を読めない（壊れた PNG）ときも 'missing' にして今の画像を書く（黙って同じにしない）。
 */
function compareAll({ baseDir, outDir, shots, png, fs, tolerance = TOLERANCE }) {
  const out = [];
  const write = (file, buf) => { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, file), buf); };
  for (const [name, shot] of Object.entries(shots || {})) {
    const file = path.join(baseDir, `${name}.png`);
    let baseBuf = null;
    let base = null;
    let note = '';
    try {
      baseBuf = fs.readFileSync(file);
      base = png.decodePng(baseBuf);
    } catch (e) {
      note = e && e.code === 'ENOENT' ? '基準が無い' : `基準を読めない（${(e && (e.code || e.message)) || e}）`;
    }
    if (!base) {
      write(`${name}.after.png`, png.encodePng(shot));
      out.push({ name, status: 'missing', note });
      continue;
    }
    const d = png.diffImages(base, shot, { tolerance });
    if (d.same) { out.push({ name, status: 'same' }); continue; }
    write(`${name}.before.png`, baseBuf);
    write(`${name}.after.png`, png.encodePng(shot));
    write(`${name}.diff.png`, png.encodePng(d.image));
    out.push({ name, status: d.sizeMismatch ? 'size' : 'diff', count: d.count, box: d.box });
  }
  return out;
}

/**
 * console-message の行が CSP の違反か（Chromium の「Refused to … because it violates the following Content Security Policy directive」）。
 * Electron 自身の警告（Insecure Content-Security-Policy）は違反ではない。level は版で数か文字かが違うので見ない
 */
function cspViolation(level, message) {
  const m = String(message || '');
  return /Content Security Policy/.test(m) && /Refused to|violates/.test(m);
}

/** 並べて真ん中の値（偶数個なら真ん中の2つの平均）。空なら NaN */
function median(list) {
  const s = (Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** [{ name, ms }]（ms は median 済み）→ [{ name, ms, budgetMs, ok }]。目安の無い名前・数でない ms は NG */
function judgePerf(results) {
  return (Array.isArray(results) ? results : []).map((r) => {
    const p = PERF.find((x) => x.name === (r && r.name));
    const ms = Number(r && r.ms);
    return { name: r && r.name, ms, budgetMs: p ? p.budgetMs : null, ok: Boolean(p) && Number.isFinite(ms) && ms <= p.budgetMs };
  });
}

/**
 * 横のはみ出しを集める文（本体の画面で executeJavaScript する）→ { sw, cw, iw, offenders }。
 * offenders は、見える要素（大きさがあり、visibility・display で隠れていない）のうち、右端が窓（innerWidth）の外に出ているものの「タグ#id」か「タグ.class」。
 * 横に流れる帯（overflow-x が visible でない祖先）の中で切られて見えない部分は数えない。body・html は祖先として切らない（窓の端で切られるのが「はみ出し」）
 */
const OVERFLOW_PROBE = `(() => {
  const W = window.innerWidth;
  const de = document.documentElement;
  const cs = (e) => window.getComputedStyle(e);
  const label = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/)[0] : '');
  const offenders = [];
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const st = cs(e);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    let right = r.right;
    if (st.position !== 'fixed') {
      for (let p = e.parentElement; p && p !== document.body && p !== de; p = p.parentElement) {
        if (cs(p).overflowX !== 'visible') right = Math.min(right, p.getBoundingClientRect().right);
      }
    }
    if (right > W + 0.5 && offenders.length < 10) offenders.push(label(e));
  }
  return { sw: de.scrollWidth, cw: de.clientWidth, iw: W, offenders };
})()`;

/** OVERFLOW_PROBE の結果 → { ok, note }。ページが横に流れる（scrollWidth > clientWidth）か、窓の外へ出た要素があれば NG。計れなければ NG */
function judgeOverflow(r) {
  if (!r || !Number.isFinite(r.sw) || !Number.isFinite(r.cw) || !r.offenders) return { ok: false, note: 'はみ出しを計れなかった' };
  const list = Array.from(r.offenders);
  if (r.sw <= r.cw && list.length === 0) return { ok: true, note: `はみ出し 0（幅 ${r.cw}）` };
  return { ok: false, note: `横にはみ出す（scrollWidth ${r.sw} > clientWidth ${r.cw}${list.length ? `・窓の外: ${list.join(' ')}` : ''}）` };
}

/** Tab を送った後のフォーカス { id, outline } → { ok, note }。決めた id にフォーカスがあり、輪（outline-style）が none でなければ OK */
function judgeFocus(got, focus) {
  const id = got && got.id ? String(got.id) : '';
  const outline = got && got.outline ? String(got.outline) : '';
  const ok = Boolean(focus && id && id === focus.want && outline && outline !== 'none');
  return { ok, note: ok ? `Tab ${focus.tabs} 回で #${id} に輪（${outline}）` : `Tab の後のフォーカスが #${id || '（なし）'}・輪 ${outline || '（なし）'}（${focus ? `#${focus.want} に輪がほしい` : '決めが無い'}）` };
}

/** 拡大した窓の中の幅（innerWidth）が「窓の幅 ÷ 倍率」か → { ok, note }。画面の外で描く窓で拡大が効かなければ NG */
function judgeZoom(innerWidth, zoom) {
  const want = Math.round(SIZE.width / (Number(zoom) || 1));
  const ok = innerWidth === want;
  return { ok, note: ok ? `拡大 ${Math.round((Number(zoom) || 1) * 100)}%（幅 ${want}）` : `拡大が効いていない（innerWidth ${innerWidth}・${want} のはず）` };
}

/** 撮る道具の見張りの時間（ms）: 30 秒 + 撮る画面の数 × 6 秒（決まった 90 秒では録音バーの 80 枚を足すと必ず時間切れになる） */
function watchdogMs(n) { return 30000 + Math.max(0, Number(n) || 0) * 6000; }

/** 撮るときに測ったピルの大きさ（CSS の px）→ 録音バーの窓の大きさ（main.js と同じ panelBounds。置き場所 slot の形） */
function panelWindowFor(size, slot) {
  const b = lib.panelBounds({ slot, size, workArea: SHOT_AREA });
  return { width: b.width, height: b.height };
}
/** 窓の大きさ（DIP）× 拡大率 → 撮れるはずの画像の大きさ（点） */
function shotSizeFor(win, scale) {
  const k = Number(scale) || 1;
  return { width: Math.round(win.width * k), height: Math.round(win.height * k) };
}
/**
 * 録音バーの画面で、ピルの四角と窓の内側の大きさを集める文 → { pill: { left, top, right, bottom }, iw, ih }（CSS の px）。
 * 撮る道具は、これでピルの大きさを測って窓を合わせ（panelWindowFor）、合わせた後の余白を judgePanel で決める
 */
const PANEL_PROBE = `(() => {
  const r = document.getElementById('pill').getBoundingClientRect();
  return { pill: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, iw: window.innerWidth, ih: window.innerHeight };
})()`;
// 余白を確かめる拡大率と状態（横と縦の記録中と、文を伸ばした警告）。基準の画像は 100・150% だけ（pill-states の SCALES）
const PANEL_PROBE_SCALES = [1, 1.25, 1.5, 2];
const PANEL_PROBE_STATES = ['rec', 'warn'];
/** PANEL_PROBE の結果 → { ok, note }。ピルの四角が窓の内側に 4px 以上の余白で入らなければ NG（拡大率で切れる: F11）。計れなければ NG */
function judgePanel(r) {
  if (!r || !r.pill || ![r.pill.left, r.pill.top, r.pill.right, r.pill.bottom, r.iw, r.ih].every(Number.isFinite)) return { ok: false, note: '余白を計れなかった' };
  const m = [r.pill.left, r.pill.top, r.iw - r.pill.right, r.ih - r.pill.bottom];
  const ok = m.every((x) => x >= 4 - 1e-6);
  const f = (x) => Math.round(x * 100) / 100;
  return { ok, note: `${ok ? '' : '切れる・'}余白 左 ${f(m[0])}・上 ${f(m[1])}・右 ${f(m[2])}・下 ${f(m[3])}（窓 ${r.iw}x${r.ih}）` };
}

/**
 * 終了コード。比べるとき（compare がある）は全部 'same'、撮るだけのときは shots が1枚以上で、
 * 揺れ・CSP の違反・速さの NG・撮れなかった画面（errors）が無いときだけ 0。
 * 第1b回 C-1: 横のはみ出し（overflow）の NG はいつも 1。Tab の輪（focus）の NG は取り直し待ち（retake）でない画面なら 1。
 * 比べた結果が 'same' でなくても、取り直し待ちの画面なら NG にしない（録音バーは RETAKE に入らない）
 */
function exitCodeOf({ shots, compare, flaky = [], csp = [], perf = [], errors = [], retake = new Set(), overflow = [], focus = [], panel = [] } = {}) {
  const bad = flaky.length > 0 || csp.length > 0 || errors.length > 0 || perf.some((p) => !p || p.ok !== true);
  if (bad) return 1;
  if (overflow.some((o) => !o || o.ok !== true)) return 1;
  // 0.9.0 O-3（F11）: 録音バーのピルが窓の内側に入らない（拡大率で切れる）は、取り直し待ちの画面でも NG
  if (panel.some((p) => !p || p.ok !== true)) return 1;
  if (focus.some((x) => !x || (x.ok !== true && !retake.has(x.name)))) return 1;
  if (compare !== undefined) return Array.isArray(compare) && compare.length > 0 && compare.every((c) => c && (c.status === 'same' || retake.has(c.name))) ? 0 : 1;
  const n = Array.isArray(shots) ? shots.length : shots && typeof shots === 'object' ? Object.keys(shots).length : 0;
  return n > 0 ? 0 : 1;
}

// 窓の中の大きさを決めた大きさにする（作業域より大きい窓は、作るときに作業域まで縮められる: Windows の CI の 1024x768 の画面で
// 1120x780 が 1024x720 になった）。直したら true
function ensureContentSize(win, size) {
  const [w, h] = win.getContentSize();
  if (w === size.width && h === size.height) return false;
  win.setContentSize(size.width, size.height);
  return true;
}

module.exports = {
  SIZE, OVERLAY_SIZE, SHOT_AREA, SCREENS, RETAKE, PERF, FIXED_NOW, TIME_ZONE, TOLERANCE, FREEZE_CSS, OVERFLOW_PROBE,
  PANEL_PROBE, PANEL_PROBE_SCALES, PANEL_PROBE_STATES, judgePanel, panelWindowFor, shotSizeFor, watchdogMs,
  apiNamesOf, fixtures, liveAnswers, bigPage, bigListEntry, judgePair, compareAll, cspViolation, median, judgePerf, judgeOverflow, judgeFocus, judgeZoom,
  exitCodeOf, ensureContentSize,
};
