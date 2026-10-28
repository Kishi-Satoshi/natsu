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
const memoTypes = require('../../src/memoTypes');
const PS = require('./pill-states');

const SIZE = { width: 1120, height: 780 };         // 本体の窓の既定（main.js の createMainWindow）
// 録音バーの窓の初めの大きさ（main.js の createOverlay と同じ panelBounds の PANEL_FIRST の横。撮るときは測ったピルの大きさに合わせ直す）
const SHOT_AREA = { x: 0, y: 0, width: 4000, height: 4000 };
const OVERLAY_SIZE = (({ width, height }) => ({ width, height }))(lib.panelBounds({ slot: 'bottom-center', size: null, workArea: SHOT_AREA }));
const FIXED_NOW = Date.UTC(2026, 9, 18, 0, 0, 0);   // 撮るときの時計（2026-10-18 09:00 日本時間）。見本の日付はこれより前の決まった日
// 録音中のページの文字起こしの状態（第1d回 A-7。main の meetingStatus().stt の形）。帯の文は main の STT_BANNER の B8 と同じ（test/shots.test.js が照らす）
const LIVE_STT = { route: 'cloud', lastTextAt: FIXED_NOW - 12000, segSec: 15, problem: null };
// 0.9.3 D55: オフラインモードの会議（PC の中で文字起こし・区切り 75 秒・相手の声も録っている）
const OFFLINE_STT = { route: 'local', lastTextAt: FIXED_NOW - 12000, segSec: 75, problem: null };
const OFFLINE_EXTRA = { localOnly: true, systemAudio: true };
// 0.9.1 Q-5: 話し声が無いので聞く帯の文（main の quietAskText(10) と同じ。test/shots.test.js が照らす）
const QUIET_ASK = { text: '10 分ほど話し声がありません。会議は終わりましたか？ このままなら 5 分後に録音を止めて議事録を作ります。' };
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
// 0.10.0 L-1: 1行目のページを開いて（非同期なので少し待つ）、「···」のメニュー（［コピー］［リンクを写す］［削除］）を開く
const OPEN_PAGE_MENU = `(async () => {
  document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('pMore').click();
  return 1;
})()`;
// 0.10.0 LS-2 の見直し（取り直しの見比べで、要約の無いページは「文字起こし」の欄で開き、鍵の一言が写っていなかった）: ページを開いてから［AI 要約］の欄を押す
const OPEN_PAGE_SUMMARY = `(async () => {
  document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnNote').click();
  return 1;
})()`;
// 0.11.0 V-1: ページを開いてメモのタブにし、会議の種類の欄を一覧の形にして中身（自動・群・種類）を見せる
const OPEN_TYPE_LIST = `(async () => {
  document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnMemo').click();
  // 欄の高さ（.typeSel の 22px）を外して、一覧の形で全部の項目を見せる（R22 (3)）
  const s = document.getElementById('pType'); s.size = s.querySelectorAll('option').length; s.style.height = 'auto';
  return 1;
})()`;
// 0.12.0 SP-4: ページを開いて文字起こしのタブにする（札・重なり・文ごとの行）
const OPEN_PAGE_SCRIPT = `(async () => {
  document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnScript').click();
  document.getElementById('pScript').scrollIntoView({ block: 'start' });   // 文字起こしの行（札・重なり・文ごとの行）が全部見えるように捲る
  return 1;
})()`;
// 0.13.0 RDY-3: サイドバーの［＋ 新しい議事録］を押して録音の前のページを開く（main の答えは見本: 録音の前のページがある）
const OPEN_READY = `(async () => {
  document.getElementById('mtToggleBtn').click();
  await new Promise((r) => setTimeout(r, 300));
  return 1;
})()`;
// 0.13.0 ED-5（計画 docs/plans/2026-10-24-130.md の「取り直す画面（RETAKE）」）: ページの要約の1つ目の箇条書き（b2）の終わりに「 /」と語を打ち、
// / メニューを開いた形（本物の Chromium の getSelection でカーソルを行の終わりに置き、input を起こす）
const OPEN_SLASH = (q) => `(async () => {
  document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnNote').click();
  const t = [...document.querySelectorAll('#pNote .blk')].find((e) => e.dataset.id === 'b2').querySelector('.txt');
  t.focus();
  t.textContent = t.textContent + ' /' + ${JSON.stringify(q)};
  const sel = getSelection(); const rg = document.createRange(); rg.selectNodeContents(t); rg.collapse(false); sel.removeAllRanges(); sel.addRange(rg);
  t.dispatchEvent(new InputEvent('input', { bubbles: true }));
  return 1;
})()`;
// 0.13.0 ED-6（E1・決めたこと 24）: ページの要約の1つ目の箇条書き（b2）の ⠿ を押してメニューを開き、［変換 ▸］の中を開いた形
const OPEN_BLOCK_MENU = `(async () => {
  document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnNote').click();
  [...document.querySelectorAll('#pNote .blk')].find((e) => e.dataset.id === 'b2').querySelector('.grip').click();
  [...document.querySelectorAll('#pNote .blockmenu .mitem')].find((b) => b.textContent === '変換 ▸').click();
  return 1;
})()`;
// 0.13.0 ED-7（E5）: ページを開いて［AI 要約］の欄の頭まで捲る（新しい型の行が全部見えるように。撮った画像の確かめで、欄が窓の下に切れていた）
const OPEN_TYPES = `(async () => {
  document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnNote').click();
  document.querySelector('#pNote .blk').scrollIntoView({ block: 'start' });
  return 1;
})()`;
// 0.11.0 V-2: ページを開き、打ち合わせの質のカードまで捲る
const OPEN_QUALITY = `(async () => {
  document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  const c = document.getElementById('qualityCard'); if (c) c.scrollIntoView({ block: 'end' });
  return 1;
})()`;
// 0.11.0 V-1: 録音中のページで会議の種類に商談を選ぶ（main の答えは見本: 見出しを入れた）
const LIVE_PICK_SALES = `(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const s = document.getElementById('pType'); s.value = 'sales'; s.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 300));
  return 1;
})()`;
// 0.10.0 L-2: 左の一覧の［選ぶ］を押し、1行目と3行目を選ぶ（頭の枠「2 件を選んでいます」と［リンクを写す］［やめる］）
const SELECT_TWO = `(() => {
  document.getElementById('tabBtnNotes').click();
  document.getElementById('listSelect').click();
  const rows = () => document.querySelectorAll('#plist .pitem');
  rows()[0].click(); rows()[2].click();
  return 1;
})()`;
// 0.9.2 I-4: 設定を開いて項目を選ぶ・ⓘ を真ん中に見えるように捲って押す（押すと吹き出しが開く。最後に押す）
const OPEN_SETTINGS = "document.getElementById('tabBtnSettings').click()";
const NAV = (id) => `document.getElementById('${id}').click()`;
// 0.10.1 CD-3（D84）: 項目「要約」を開いて［Claude デスクトップに登録］を押し、Claude デスクトップが動いていたので断った文（RN1）が出てから、カードまで捲る
const MCP_RUNNING_ACT = `(async () => {
  document.getElementById('tabBtnSettings').click(); document.getElementById('setNavSummary').click();
  await new Promise((r) => setTimeout(r, 200));
  document.getElementById('mcpRegister').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('mcpCard').scrollIntoView({ block: 'start' });
})()`;
const INFO = (pop) => `const i = document.querySelector('[aria-controls="${pop}"]'); i.scrollIntoView({ block: 'center' }); i.click()`;
// 0.9.3 M-7（計画 docs/plans/2026-10-22-093.md の「取り直す画面」）: 話しているときの音の波の決まった 20 の値（main の levelMsg を通った形。
// 新しい値が右から入るので、いちばん後ろが右端）。マイクと相手の声の大きい方が棒の高さになる（相手の方が大きい値も入れる）
// 0.9.4 W-1 で意図して並べ替えた: 録音中のページは流さず今の大きさ（いちばん後ろの値）を5本で描くので、話している大きさ（0.78）が最後に来るようにした（同じ 20 の値）
const WAVE_SPEECH = [
  [0.6, 0.08], [0.1, 0.38], [0.05, 0.62], [0.04, 0.71], [0.02, 0.44], [0.22, 0.05], [0.5, 0], [0.36, 0], [0.12, 0],
  [0.04, 0], [0.18, 0], [0.42, 0.05], [0.66, 0.05], [0.52, 0], [0.3, 0], [0.08, 0.02], [0.01, 0], [0.14, 0.03], [0.48, 0.1], [0.78, 0.12],
].map(([mic, sys]) => ({ mic, sys, warn: '' }));
const WAVE_EVENTS = WAVE_SPEECH.map((v) => ['onMeetingLevel', v]);
// 録音バーと同じ無音の文（main の LEVEL_WARNS の1つ）。8 秒の無音を表す数だけ送らなくても、届いた文のまま出る
const SILENT_EVENTS = Array.from({ length: 20 }, () => ['onMeetingLevel', { mic: 0, sys: 0, warn: '音が入っていません' }]);
// パネル（nudge.html）の地: 透過の窓なので、撮るときだけ体にデスクトップの色を塗る（録音バーの画面と同じ PS.DESKS）。⌄ を開いた形はボタンを押す
const NUDGE_ACT = (theme, menu) => `document.body.style.background = '${PS.DESKS[theme]}';${menu ? " document.getElementById('nzMore').click();" : ''}`;
// 0.9.4 S-8（計画 docs/plans/2026-10-22-094.md の「取り直す画面（決めた形）」）: 遅い会議の録音中のページ（中継に落ちて PC の側・帯 kept-late・残した区間）の stt。
// 帯の文は main の STT_BANNER['kept-late']、区間の文は main の SLOW_SEG_TEXT と同じ（test/shots.test.js が照らす）
const LATE_STT = { route: 'local', lastTextAt: FIXED_NOW - 95000, segSec: 75, slow: true,
  problem: { code: 'kept-late', action: '', text: 'この PC の文字起こしが録音に追いつかないため、音声を残しています。会議が終わったら文字起こしします。録音はそのまま続けてください。' } };
const SLOW_SEG = '（文字起こし待ち: 会議の後で文字起こしします）';
const SIGNED_OUT = { ok: true, signedIn: false, email: '', method: 'access', until: null, canStore: true, online: { up: true, why: 'ok' } };
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
  // 0.9.0 U-2（SP4・SP5・D24）: 設定のポップアップの項目「録音」と、検索「マイク」の結果（足した画面。G-3 で CI の画像を基準にした）
  { name: 'settings-record-light', page: 'app', theme: 'light', act: "document.getElementById('tabBtnSettings').click(); document.getElementById('setNavRecord').click()" },
  { name: 'settings-search-light', page: 'app', theme: 'light',
    act: "document.getElementById('tabBtnSettings').click(); const b = document.getElementById('setSearch'); b.value = 'マイク'; b.dispatchEvent(new Event('input', { bubbles: true }))" },
  // 0.9.0 U-3（OF7・D21）: オフラインの準備を選んでいない人のカード「オフライン」（OFF1〜OFF5。足した画面。G-3 で CI の画像を基準にした）。
  // ログインしている形にする（ログインしていないと、起動で設定の「アカウント」が開く: 計画 U-3）
  { name: 'settings-offline-light', page: 'app', theme: 'light', answers: offlineAnswers(),
    act: "document.getElementById('tabBtnSettings').click(); document.getElementById('setNavOffline').click()" },
  // 0.9.1 Q-5（計画 docs/plans/2026-10-21-091.md の「取り直す画面」）: 録音中のページの「会議は終わりましたか？」の帯（live-light と同じ会議）と、設定の検索「自動で止める」
  // （足した画面。版を 0.9.1 に上げる commit で CI の画像を基準にした）
  { name: 'live-quiet-light', page: 'app', theme: 'light', answers: liveAnswers(LIVE_STT, { quiet: QUIET_ASK }) },
  { name: 'live-quiet-dark', page: 'app', theme: 'dark', answers: liveAnswers(LIVE_STT, { quiet: QUIET_ASK }) },
  { name: 'settings-quiet-search-light', page: 'app', theme: 'light',
    act: "document.getElementById('tabBtnSettings').click(); const b = document.getElementById('setSearch'); b.value = '自動で止める'; b.dispatchEvent(new Event('input', { bubbles: true }))" },
  // 0.9.2 I-4（計画 docs/plans/2026-10-21-092.md の「取り直す画面」）: 設定の説明を1行にして ⓘ を足した項目（「録音」の暗い・200%・要約・ログインしていない
  // アカウント）、ⓘ の吹き出しを開いた形（モックの「相手の声」「暗い地の文字起こし」「要約」と、200% で箱の中に収まるか）、吹き出しの中にだけある言葉の検索
  // （足した画面。版を 0.9.2 に上げる commit で CI の画像を基準にした）
  { name: 'settings-record-dark', page: 'app', theme: 'dark', act: `${OPEN_SETTINGS}; ${NAV('setNavRecord')}` },
  { name: 'settings-record-zoom200-light', page: 'app', theme: 'light', zoom: 2, act: `${OPEN_SETTINGS}; ${NAV('setNavRecord')}` },
  { name: 'settings-summary-light', page: 'app', theme: 'light', act: `${OPEN_SETTINGS}; ${NAV('setNavSummary')}` },
  { name: 'settings-account-light', page: 'app', theme: 'light', answers: { 'koeApp.accountStatus': SIGNED_OUT },
    act: `${OPEN_SETTINGS}; ${NAV('setNavAccount')}` },
  { name: 'settings-info-loop-light', page: 'app', theme: 'light', act: `${OPEN_SETTINGS}; ${NAV('setNavRecord')}; ${INFO('setPopLoop')}` },
  { name: 'settings-info-stt-dark', page: 'app', theme: 'dark', act: `${OPEN_SETTINGS}; ${NAV('setNavRecord')}; ${INFO('setPopStt')}` },
  { name: 'settings-info-claude-light', page: 'app', theme: 'light', act: `${OPEN_SETTINGS}; ${NAV('setNavSummary')}; ${INFO('claudeHelp')}` },
  { name: 'settings-info-zoom200-light', page: 'app', theme: 'light', zoom: 2, act: `${OPEN_SETTINGS}; ${NAV('setNavRecord')}; ${INFO('setPopLoop')}` },
  { name: 'settings-info-search-light', page: 'app', theme: 'light',
    act: `${OPEN_SETTINGS}; const b = document.getElementById('setSearch'); b.value = 'イヤホン'; b.dispatchEvent(new Event('input', { bubbles: true }))` },
  // 0.9.3 M-7（計画 docs/plans/2026-10-22-093.md の「取り直す画面」）: 録音中のページの音の波（話している WAVE_SPEECH・無音・一時停止。live-light と同じ会議）と、
  // 設定の「録音」の頭の「会議の検出」（出さないアプリ Zoom の札のある形）。足した画面（版を 0.9.3 に上げる commit で CI の画像を基準にした）
  // 話している波は「動きを減らす」でない形で撮る（Windows の CI の機械は prefers-reduced-motion が reduce で、CI run 39751610440 では
  // 真ん中の5本だけの形になった。main.js が DevTools の Emulation.setEmulatedMedia で motion を当てる）
  { name: 'live-wave-light', page: 'app', theme: 'light', answers: liveAnswers(), events: WAVE_EVENTS, motion: 'no-preference' },
  { name: 'live-wave-dark', page: 'app', theme: 'dark', answers: liveAnswers(), events: WAVE_EVENTS, motion: 'no-preference' },
  { name: 'live-silent-light', page: 'app', theme: 'light', answers: liveAnswers(), events: SILENT_EVENTS },
  { name: 'live-paused-dark', page: 'app', theme: 'dark', answers: liveAnswers(LIVE_STT, { paused: true }) },
  // 答えは見本の設定に2つのキーを足した形（見本の fixtures はこのファイルの後ろで決まるので、読むときに作る）
  { name: 'settings-detect-light', page: 'app', theme: 'light', get answers() { return detectAnswers(); }, act: `${OPEN_SETTINGS}; ${NAV('setNavRecord')}` },
  { name: 'settings-detect-dark', page: 'app', theme: 'dark', get answers() { return detectAnswers(); }, act: `${OPEN_SETTINGS}; ${NAV('setNavRecord')}` },
  // 0.9.3 持ち主の答え D55: オフラインモードの会議の録音中のページ（札「オフラインモード中」・記録の行「議事録を記録中（相手の声も・オフライン）」・灰色の説明の行）。
  // live-light と同じ会議を、オフラインモードで PC の中の文字起こし（区切り 75 秒）にした形。足した画面（版を 0.9.3 に上げる commit で CI の画像を基準にした）
  { name: 'live-offline-light', page: 'app', theme: 'light', answers: liveAnswers(OFFLINE_STT, OFFLINE_EXTRA) },
  { name: 'live-offline-dark', page: 'app', theme: 'dark', answers: liveAnswers(OFFLINE_STT, OFFLINE_EXTRA) },
  // 0.9.4 S-8（計画 docs/plans/2026-10-22-094.md の「取り直す画面（決めた形）」）: 遅い会議の録音中のページ（帯 kept-late・残した区間・一番下の
  // 「音声を残しています」。明暗と 200% の折り返し）。足した画面（まだ基準が無い）
  { name: 'live-late-light', page: 'app', theme: 'light', answers: lateAnswers() },
  { name: 'live-late-dark', page: 'app', theme: 'dark', answers: lateAnswers() },
  { name: 'live-late-zoom200-light', page: 'app', theme: 'light', zoom: 2, answers: lateAnswers() },
  // 0.10.0 C-3（計画 docs/plans/2026-10-20-100.md の「取り直す画面（RETAKE）」）: 項目「要約」のカード「Claude との連携（MCP）」まで捲った形（状態 none）と、
  // その ⓘ の吹き出しを開いた形。足した画面（まだ基準が無い）
  { name: 'settings-mcp-light', page: 'app', theme: 'light', act: `${OPEN_SETTINGS}; ${NAV('setNavSummary')}; document.getElementById('mcpCard').scrollIntoView({ block: 'start' })` },
  { name: 'settings-info-mcp-light', page: 'app', theme: 'light', act: `${OPEN_SETTINGS}; ${NAV('setNavSummary')}; ${INFO('setPopMcp')}` },
  // 0.10.0 L-1（D58）: ページの「···」のメニューを開いた形（［リンクを写す］）。足した画面（まだ基準が無い）
  { name: 'page-menu-link-light', page: 'app', theme: 'light', act: OPEN_PAGE_MENU },
  { name: 'page-menu-link-dark', page: 'app', theme: 'dark', act: OPEN_PAGE_MENU },
  // 0.10.0 L-2（D58・D70）: 左の一覧の［選ぶ］で3件のうち2件を選んだ形。足した画面（まだ基準が無い）
  { name: 'list-select-light', page: 'app', theme: 'light', act: SELECT_TWO },
  { name: 'list-select-dark', page: 'app', theme: 'dark', act: SELECT_TWO },
  // 0.10.0 LS-2（D63・D69・決めたこと 111 の 7）: まだ要約を作っていない会議のページ（要約の欄の頭の灰色の一言と、右上の［要約を生成］）。
  // 足した画面（まだ基準が無い）
  { name: 'page-summary-lock-light', page: 'app', theme: 'light', get answers() { return summaryLockAnswers(); }, act: OPEN_PAGE_SUMMARY },
  // 0.10.1 CD-3（D84・計画 docs/plans/2026-10-23-101.md の「取り直す画面（RETAKE）」）: Claude デスクトップが動いている間に［Claude デスクトップに登録］を押して
  // 断った形（#mcpMsg に RN1）。足した画面（版を 0.10.1 に上げる commit で、持ち主が OK と言った CI の画像を基準にした）
  {
    name: 'settings-mcp-running-light', page: 'app', theme: 'light', act: MCP_RUNNING_ACT,
    answers: { 'koeApp.mcpStatus': { desktop: { state: 'none', files: 1, running: true } }, 'koeApp.mcpRegister': { ok: false, state: 'none', code: 'running', running: true } },
  },
  // 0.11.0 V-1（計画 docs/plans/2026-10-22-110.md の「取り直す画面（RETAKE）」）: 会議の種類のプルダウンを開いた形（群・自動。撮るときは欄を
  // 一覧の形（size）にして中身を見せる）と「メモの型」・メモのタブの手引き（商談を手で選び、メモが BANTC の雛形のページ）。前の版の一般・その他の
  // ページが「自動」と決まらなかった文で出る形。録音中に商談を選び、メモのタブに切り替わって見出しと手引きが出た形（P17）。足した画面（版を 0.11.0 に上げる commit で、持ち主が OK と言った CI の画像を基準にした）
  { name: 'page-type-light', page: 'app', theme: 'light', get answers() { return typeAnswers(); }, act: OPEN_TYPE_LIST },
  { name: 'page-type-dark', page: 'app', theme: 'dark', get answers() { return typeAnswers(); }, act: OPEN_TYPE_LIST },
  { name: 'page-type-undecided-light', page: 'app', theme: 'light', get answers() { return undecidedAnswers(); }, act: OPEN_PAGE },
  { name: 'live-type-light', page: 'app', theme: 'light', get answers() { return liveTypeAnswers(); }, act: LIVE_PICK_SALES },
  // 0.11.0 V-2: 新しい形の要約（締め → 型の見出し → 抜け・重なりチェック → 次に気をつけること）と打ち合わせの質のカードまで捲った形。足した画面（版を 0.11.0 に上げる commit で基準にした）
  { name: 'page-quality-light', page: 'app', theme: 'light', get answers() { return qualityAnswers(); }, act: OPEN_QUALITY },
  { name: 'page-quality-dark', page: 'app', theme: 'dark', get answers() { return qualityAnswers(); }, act: OPEN_QUALITY },
  // 0.11.0 V-3: 項目「要約」のカード「打ち合わせの質」まで捲った形。足した画面（版を 0.11.0 に上げる commit で基準にした）
  { name: 'settings-quality-light', page: 'app', theme: 'light', act: `${OPEN_SETTINGS}; ${NAV('setNavSummary')}; document.getElementById('qualityCardSet').scrollIntoView({ block: 'start' })` },
  // 0.12.0 SP-4（D53・D66）: 文字起こしのタブの「自分」「相手」の札・重なり・PC の側の文ごとの行。足した画面（版を 0.12.0 に上げる commit で基準にした）
  { name: 'notes-script-spk-light', page: 'app', theme: 'light', act: OPEN_PAGE_SCRIPT },
  // 0.13.0 RDY-3（計画 docs/plans/2026-10-24-130.md の第2部「取り直す画面（第2部の分）」）: 録音の前のページ（題名・種類の行・一言・メモのタブ・録音の前の行の
  // 2つのボタン・同意と送り先の文）。明暗と、拡大 200% で録音の前の行が折り返す形。足した画面（まだ基準が無い）
  { name: 'live-ready-light', page: 'app', theme: 'light', answers: readyAnswers(), act: OPEN_READY },
  { name: 'live-ready-dark', page: 'app', theme: 'dark', answers: readyAnswers(), act: OPEN_READY },
  { name: 'live-ready-zoom200-light', page: 'app', theme: 'light', zoom: 2, answers: readyAnswers(), act: OPEN_READY },
  // 0.13.0 ED-5（E2・EQ8）: / メニュー（「みだし」で絞った形の明暗と、語を打つ前に頭に「最近使ったもの」が出た形）。足した画面（まだ基準が無い）。
  // 撮る道具は koeApp.uiState に見本の答えを持たない（{ ok: true }）ので、ほかの画面は「最近使ったもの」が無いまま撮れる
  { name: 'edit-slash-light', page: 'app', theme: 'light', act: OPEN_SLASH('みだし') },
  { name: 'edit-slash-dark', page: 'app', theme: 'dark', act: OPEN_SLASH('みだし') },
  { name: 'edit-slash-recent-light', page: 'app', theme: 'light', answers: { 'koeApp.uiState': { slashRecent: ['h2', 'todo'] } }, act: OPEN_SLASH('') },
  // 0.13.0 ED-6（E1）: ⠿ のメニューと［変換 ▸］の中（文のある行なので区切り線は灰色）。足した画面（まだ基準が無い）
  { name: 'edit-block-menu-light', page: 'app', theme: 'light', act: OPEN_BLOCK_MENU },
  // 0.13.0 ED-7（E5）: 見出し1〜3・番号付き・引用・区切り線・コールアウトを1枚に（明暗と拡大 150%）。足した画面（まだ基準が無い）
  { name: 'edit-types-light', page: 'app', theme: 'light', get answers() { return typesAnswers(); }, act: OPEN_TYPES },
  { name: 'edit-types-dark', page: 'app', theme: 'dark', get answers() { return typesAnswers(); }, act: OPEN_TYPES },
  { name: 'edit-types-zoom150-light', page: 'app', theme: 'light', zoom: 1.5, get answers() { return typesAnswers(); }, act: OPEN_TYPES },
  // 0.13.1 NE-4a（E10・NR15・NR23。計画 docs/plans/2026-10-27-131.md の「取り直す画面（RETAKE）」）: 2段・3段の字下げ（箇条書き・ToDo・番号付きの子。番号は親ごと）の
  // 明暗と、拡大 200%（深い段の行の ＋・⠿・文が切れない・折り返しが崩れない）。足した画面（まだ基準が無い）
  { name: 'edit-nested-light', page: 'app', theme: 'light', get answers() { return nestedAnswers(); }, act: OPEN_TYPES },
  { name: 'edit-nested-dark', page: 'app', theme: 'dark', get answers() { return nestedAnswers(); }, act: OPEN_TYPES },
  { name: 'edit-nested-zoom200-light', page: 'app', theme: 'light', zoom: 2, get answers() { return nestedAnswers(); }, act: OPEN_TYPES },
  // 0.13.1 NE-4b（E5・決めたこと 18）: 開いたトグルと閉じたトグル・トグル見出し（▸ の向き）。足した画面（まだ基準が無い）
  { name: 'edit-toggle-light', page: 'app', theme: 'light', get answers() { return toggleAnswers(); }, act: OPEN_TYPES },
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
// 0.9.0 O-4（RP8）: 縦の形の × が出た形（カーソルが乗った記録中。暗い地・150%）
SCREENS.push({
  name: PS.HOVER.name, page: 'overlay', theme: PS.HOVER.desk, act: PS.actFor(PS.HOVER.state, PS.HOVER.form, PS.HOVER.desk, true),
  scale: PS.HOVER.scale, slot: 'middle-right', pill: { state: PS.HOVER.state, form: PS.HOVER.form, desk: PS.HOVER.desk, scale: PS.HOVER.scale, hover: true },
});
// 0.9.3 M-7: 会議の検出のパネル（page nudge。モック v4-light.png・v4-dark.png・v4-light-menu.png）。明暗は main と同じく onShow の theme で渡し、
// 窓は録音バーと同じく透過で、測ったパネルの大きさから main と同じ nudgeBounds で決める（nudgeWindowFor）。いちばん後ろに撮る
for (const [name, theme, scale, menu] of [['nudge-light-100', 'light', 1, false], ['nudge-dark-100', 'dark', 1, false], ['nudge-light-150', 'light', 1.5, false],
  ['nudge-menu-light-100', 'light', 1, true], ['nudge-menu-dark-100', 'dark', 1, true]]) {
  SCREENS.push({ name, page: 'nudge', theme, scale, events: [['onShow', { label: 'Zoom', theme }]], act: NUDGE_ACT(theme, menu) });
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
// 0.9.0 G-3: 利用者が 2026-10-20 に CI の取り直しの画像（run 39496101442（ed9365a）・artifact 12297628165 の .after.png。帯の3枚・notes-tabs-light・
// 設定の6枚・録音バーの 81 枚）を見て OK と言ったので、その画像をバイトのまま基準にし、録音バーの行と設定の3枚の行ごと外して空に戻した
// 0.9.1（計画 docs/plans/2026-10-21-091.md の「取り直す画面」）: Q-3 で設定の項目「録音」にカード「話し声が無いとき」を足したので settings-record-light を入れた。
// Q-5 で足した画面（「会議は終わりましたか？」の帯の2枚・設定の検索「自動で止める」・録音バーの状態 quiet の 8 枚。まだ基準が無い）も入れた。
// 利用者がまとめて OK と言ったら、版を上げる commit で基準にして空に戻す
// 0.9.1（版を 0.9.1 に上げる commit）: 利用者が 2026-10-21 に CI の取り直しの画像（run 39539780418（a83d61d）・artifact 12319056756 の .after.png。
// settings-record-light・帯の2枚・settings-quiet-search-light・録音バーの quiet の 8 枚）を見て OK と言ったので、その画像をバイトのまま基準にし、空に戻した
// 0.9.2（計画 docs/plans/2026-10-21-092.md の「取り直す画面」）: I-1 で設定の左の列の下に［ヘルプ］を出したので、設定の 7 枚を入れた
// （I-2・I-3 で説明を1行にして ⓘ を足すのも同じ 7 枚に写る）。I-4 で足す画面も入れる。利用者がまとめて OK と言ったら、版を上げる commit で基準にして空に戻す
// I-4 で足した画面（まだ基準が無い）も入れた
// 0.9.2（版を 0.9.2 に上げる commit）: 利用者が 2026-10-21 に CI の取り直しの画像（run 39560229700（2649858）・artifact 12327173484 の .after.png。
// 設定の 7 枚と I-4 で足した 9 枚の 16 枚）を見て OK と言ったので、その画像をバイトのまま基準にし、空に戻した
// 0.9.3（計画 docs/plans/2026-10-22-093.md の「取り直す画面」）: M-0（持ち主の答え D54）で設定の左の列の名前を「ローカル AI の設定」にして列を 196px に
// 広げたので設定の 16 枚、録音中のページのボタンを［オフラインモード］にしたので録音中のページの 7 枚を入れた。M-4・M-6・M-7 で足す画面も入れる。
// 利用者がまとめて OK と言ったら、版を上げる commit で基準にして空に戻す
// 0.9.3（版を 0.9.3 に上げる commit）: 持ち主が 2026-10-22 に「CI の画像を基準にして 0.9.3 の版を上げてよい」と言ったので、オフラインモードの札の commit
// （a6b8271）の CI run 39769254304 の取り直しの画像（.after.png。計画の「取り直す画面」の全部の 36 枚）をバイトのまま基準にし、空に戻した
// 0.9.4（計画 docs/plans/2026-10-22-094.md の「取り直す画面（決めた形）」）: W-1 で録音中のページの波を5つの灰色の点に・録音バーの声の点を5本がそれぞれ
// 揺れる形にしたので、録音中のページの 13 枚と録音バーの声のある状態（rec・dict・fallback・spk-ng）の 32 枚と縦の × の1枚を入れた。タスクごとに足し、
// 持ち主が最後にまとめて OK と言ったら、版を上げる commit で基準にして空に戻す
const OVL_094 = (states) => PS.FORMS.flatMap((form) => Object.keys(PS.DESKS).flatMap((desk) => PS.SCALES.flatMap((sc) => states.map((st) => `overlay-${form}-${desk}-${st}-${Math.round(sc * 100)}`))));
// 0.9.4（版を 0.9.4 に上げる commit）: 持ち主が 2026-10-22 に取り直しの見比べ（CI run 39831111027（bd2320d）・artifact 12448422820 の .after.png）を見て
// 「OK」と言ったので、その画像をバイトのまま基準にし（基準と同じだった live-banner-zoom200-dark は今の基準のまま）、空に戻した
// 0.10.0（版を 0.10.0 に上げる commit）: 持ち主が 2026-10-23 に取り直しの見比べ（CI run 39931820118（7feee33）の 46 枚。tools の見比べの絵）を見て
// 「OK」と言った。持ち主の答えで MCP のカードの頭の1行（「Claude デスクトップから議事録を読めるようにします。」）だけを直した後の CI run 39934849171
// （03d209d）・artifact 12493472101 の .after.png（46 枚）をバイトのまま基準にし、空に戻した。OK の画像と比べて、直した1行の写る4枚（settings-summary-light・
// settings-info-claude-light・settings-mcp-light・settings-info-mcp-light）のその行のほかに違いは無い（左の列の印の 1 段の色の揺れは、同じ app.html の2つの run の間にもある）
// 0.10.1（版を 0.10.1 に上げる commit）: 持ち主が 2026-10-24 に settings-mcp-running-light（CD-3 の断った文 RN1）の画像を見て「OK」と言ったので、
// CI run 40071461858（1dff338）・artifact 12552271208 の .after.png をバイトのまま基準にし、空に戻した
// 0.11.0（版を 0.11.0 に上げる commit）: 持ち主が 2026-10-24 に取り直しの見比べ（37 枚。V-5 の page-type-light・page-type-dark を含む）を見て
// 「OK（版を 0.11.0 に上げてよい）」と言ったので、CI run 40142063730（1a46130）・artifact 12578889430 の .after.png（37 枚）をバイトのまま基準にし、空に戻した
// （持ち主が見た 1e6a4c2 の画像との違いは、左の列の印の 1 段の色の揺れだけ）
// 0.11.1（版を 0.11.1 に上げる commit。LG-8）: 持ち主が 2026-10-25 にロゴの見比べ（CI run 40158349532（1c87b3c）の撮影の見比べの絵）を見て
// 「OK（版を 0.11.1 に上げてよい）」と言ったので、その run の artifact 12585288773 の .after.png（139 枚: 録音バー 81・本体の窓 53・パネル 5）を
// バイトのまま基準にし、空に戻した
// 0.12.0（版を 0.12.0 に上げる commit。Task G）: 持ち主が 2026-10-25 に取り直しの見比べ（CI run 40187063736（e580fca）の 14 枚。録音中のページの文字起こしの
// 「自分」「相手」の札の 13 枚と、足した notes-script-spk-light）を見て「OK（版を 0.12.0 に上げてよい）」と言ったので、その run の artifact 12596530760 の
// .after.png をバイトのまま基準にし、空に戻した
// 0.12.1（版を 0.12.1 に上げる commit。LV-7）: 持ち主が 2026-10-25 に取り直しの見比べ（review-121.html。LV-4 で［設定］→［録音］のカード「会議の検出」に行
// 「会議を出たら自動で止める」を足して変わった 10 枚）を見て「OK（版を 0.12.1 に上げてよい）」と言ったので、点検の直しの後の CI run 40207175980（ba3387f）の
// artifact 12604106323 の .after.png をバイトのまま基準にし、空に戻した
// 0.13.0（版を 0.13.0 に上げる commit。Task G・RDY-7）: 持ち主が 2026-10-27 に取り直しの見比べ（足した 10 枚: 録音の前のページの3枚・/ メニューの3枚・
// ⠿ のメニューの1枚・新しい型の3枚に「この見た目でよい」、行の左の ＋ で要約の文がずれた今の画面の 11 枚に「この見た目でよい（おすすめ）」）と答えたので、
// CI run 40466764263（20ceb94）の artifact 12717370368 の .after.png（21 枚）をバイトのまま基準にし、空に戻した
// 0.13.1（計画 docs/plans/2026-10-27-131.md の「取り直す画面（RETAKE）」）: NE-1 で / メニューと ⠿ の［変換 ▸］にトグルとトグル見出し1〜3 が増えた
// （型の表の写しを NE-1 で替えたので、計画の NE-4b でなく NE-1 で入れた: Ruling NR26）。持ち主が見比べを OK と言ったら、版を上げる commit（Task G）で基準にして空に戻す
const RETAKE = new Set(['edit-slash-light', 'edit-slash-dark', 'edit-slash-recent-light', 'edit-block-menu-light', 'edit-nested-light', 'edit-nested-dark', 'edit-nested-zoom200-light', 'edit-toggle-light']);
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
// 0.12.0 SP-4（決めたこと 85・127・128）: 相手の声も録った会議の形。入口（src）は自分（mic）と相手（loopback）で、相手の s2 は PC の側の長い区間で
// 文ごとの行（parts）を持ち、2つ目の文（2:35）が自分の s3（2:30）と重なる（文字起こしのタブを写す notes-script-spk-light で見える）
const SEGMENTS = [
  { id: 's1', atMs: 0, text: 'それでは週次の定例を始めます。まず進み具合から順にお願いします。', src: 'mic' },
  { id: 's2', atMs: 75000, durationMs: 90000, text: '受注の画面の直しは、結合の試験が今週で終わりました。残りの不具合は2件です。', src: 'loopback',
    parts: [{ ms: 0, at: 0 }, { ms: 80000, at: 26 }] },
  { id: 's3', atMs: 150000, text: '在庫の取り込みが遅いので、山田さんに実行計画を見てもらえますか。期限は10月14日でお願いします。', src: 'mic' },
  { id: 's4', atMs: 225000, text: '分かりました。索引が効いているかを確かめます。', src: 'loopback' },
  { id: 's5', atMs: 300000, text: '求人票の見直しは、佐藤さんが今月末までに案を出します。', src: 'mic' },
  { id: 's6', atMs: 375000, text: '出す日は11月15日で決まりです。以上で終わります。', src: 'mic' },
];
// 0.10.0 SH-1（D71・決めたこと 140）: 見本の題名は本物と同じ日付の形（作った時刻の日本の時刻。lib.meetingTitleAt の1か所で決める）
const JST_MIN = 540;
const PAGE = {
  id: 'p1', title: lib.meetingTitleAt('2026-10-16T01:00:00.000Z', JST_MIN), date: '2026-10-16', durationSec: 1820,
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
  { id: 'p2', title: lib.meetingTitleAt('2026-10-09T05:00:00.000Z', JST_MIN), date: '2026-10-09', durationSec: 2710, createdAt: '2026-10-09T05:00:00.000Z', updatedAt: '2026-10-09T05:50:00.000Z', meetingType: 'general', hasSummary: true },
  { id: 'p3', title: lib.meetingTitleAt('2026-10-01T08:00:00.000Z', JST_MIN), date: '2026-10-01', durationSec: 905, createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:20:00.000Z', meetingType: 'general', hasSummary: false },
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
    // 0.10.0 LS-3（D59）: 組は文字起こしだけ（要約のエンジンの欄 sum・sumReady を外した）
    'koeApp.engineStatus': { ok: true, whisper: 'PC の中の文字起こしはまだ取り込んでいません。', chosen: false },
    'koeApp.engineFetchStatus': { ok: true, supported: true, mode: { whisper: 'managed' }, state: 'missing', totalBytes: total, doneBytes: 0,
      needBytes: total, whisperBytes, freeBytes: 20e9, whisperReady: false, runtime: null, askIt: false, report: '', consent: false, userPaused: false,
      items: MANIFEST.items.map((i) => ({ id: i.id, group: i.group, label: i.label, version: i.version, file: (i.dest || i.dir).split('/').pop(), url: i.url,
        host: new URL(i.url).hostname, sha256: i.sha256, size: i.size, done: 0, state: 'missing', license: i.license, place: '%LOCALAPPDATA%\\natsu\\engine\\…' })),
      error: null },
    'koeApp.accountStatus': { ok: true, signedIn: true, email: '', method: 'access', until: null, canStore: true, online: { up: true, why: 'ok' } },
  };
}
function liveAnswers(stt = LIVE_STT, extra = {}) {
  // 0.12.0 SP-4（決めたこと 85）: 発言に入口（src）。行の時刻の後に「自分」「相手」の札が出る
  const segs = [
    { id: 's1', atMs: 0, durationMs: 75000, text: 'それでは週次の定例を始めます。まず進み具合から順にお願いします。', src: 'mic' },
    { id: 's2', atMs: 75000, durationMs: 75000, text: '受注の画面の直しは、結合の試験が今週で終わりました。残りの不具合は2件です。', src: 'loopback' },
    { id: 's3', atMs: 150000, durationMs: 75000, text: '在庫の取り込みが遅いので、実行計画を見てもらえますか。', src: 'mic' },
  ];
  return {
    'koeApp.meetingStatus': {
      active: true, finalizing: false, startedAt: FIXED_NOW - 300000, memo: '議題: 進み具合 / 在庫の取り込み',
      segments: segs, pending: 0, stoppedAt: null, stopping: false, paused: false, pausedMs: 45000,
      systemAudio: false, micFallback: false, etaSec: null, skipped: 0,
      pauses: [{ atMs: 150000, ms: 45000, why: 'user' }], pausing: false, resumeHint: false,
      localOnly: false, cloud: true, stt, ...extra,
    },
  };
}

/** 0.13.0 RDY-3: 録音の前のページ（main の meetingStatus() の形。録音していない・prep は空のメモと「自動」・クラウドで文字起こしする PC） */
function readyAnswers() {
  return {
    'koeApp.meetingStatus': { active: false, finalizing: false, startedAt: null, memo: '', meetingType: null, segments: [], pending: 0, stoppedAt: null,
      stopping: false, paused: false, pausedMs: 0, pauses: [], localOnly: false, cloud: true, stt: null, prep: { memo: '', meetingType: null } },
    'koeApp.meetingPrepare': { ok: true },
  };
}

/** 0.9.4 S-8: 遅い会議（live-light と同じ会議。中継に落ちて PC の側になり、文字になった区間の後に残した区間が2つ） */
function lateAnswers() {
  const a = liveAnswers(LATE_STT);
  a['koeApp.meetingStatus'].segments = [
    { id: 's1', atMs: 0, durationMs: 75000, text: 'それでは週次の定例を始めます。まず進み具合から順にお願いします。' },
    { id: 's2', atMs: 75000, durationMs: 75000, text: SLOW_SEG, failed: true },
    { id: 's3', atMs: 150000, durationMs: 75000, text: SLOW_SEG, failed: true },
  ];
  return a;
}

/** 0.9.3 M-7: 設定の「会議の検出」の画面の答え（見本の設定に、通知オンと出さないアプリ Zoom を足した形） */
// 0.10.0 LS-2: 見本のページから要約（ブロック・出典とアクションの数・要約の経路）を外した形（決めたこと 111 の 7「まだ要約を作っていない」）
function summaryLockAnswers() {
  const page = fixtures()['koeApp.pageGet'].page;
  const route = { ...(page.route || {}) };
  delete route.summary;
  return { 'koeApp.pageGet': { page: { ...page, blocks: [], citeStat: null, actionStat: null, summaryError: '', route }, segments: SEGMENTS } };
}
// 0.11.0 V-1: 商談を手で選び、メモが BANTC の雛形のページ
function typeAnswers() {
  const page = fixtures()['koeApp.pageGet'].page;
  return { 'koeApp.pageGet': { page: { ...page, meetingType: 'sales', typeAuto: false, autoType: 'sales', memo: memoTypes.memoPreset('bantc') }, segments: SEGMENTS } };
}
// 0.11.0 V-1: 前の版の一般・その他のページ（一覧の2行目 p2 の会議。自動で一般・その他になった形）
function undecidedAnswers() {
  const page = fixtures()['koeApp.pageGet'].page;
  const p2 = LIST[1];
  return { 'koeApp.pageGet': { page: { ...page, id: p2.id, title: p2.title, date: p2.date, createdAt: p2.createdAt, durationSec: p2.durationSec, meetingType: 'general', typeAuto: true, autoType: 'general' }, segments: SEGMENTS } };
}
// 0.11.0 V-1: 録音中のページ（live-light と同じ会議）で種類を選んだときの main の答え（空のメモに BANTC の見出しを入れた）
function liveTypeAnswers() {
  return { ...liveAnswers(), 'koeApp.meetingSetMemo': { ok: true },
    'koeApp.meetingSetType': { ok: true, memo: memoTypes.memoPreset('bantc'), inserted: true, meetingType: 'sales' } };
}
// 0.13.0 ED-7（E5）: 人が書き直した要約（新しい型の全部。一覧の1行目 p1 の会議の要約だけを替える: 0.11.0 の qualityAnswers と同じ形）
function typesAnswers() {
  const page = fixtures()['koeApp.pageGet'].page;
  const blocks = [
    { id: 'e1', type: 'heading', level: 1, text: '週次の定例のまとめ', citeState: 'manual', cites: [] },
    { id: 'e2', type: 'callout', icon: '💡', text: '出す日は11月15日で決まりです。', citeState: 'manual', cites: [] },
    { id: 'e3', type: 'heading', text: '進み具合' },
    { id: 'e4', type: 'numbered', text: '結合の試験が今週で終わった。', citeState: 'manual', cites: [] },
    { id: 'e5', type: 'numbered', text: '残りの不具合は2件。', citeState: 'manual', cites: [] },
    { id: 'e6', type: 'heading', level: 3, text: '在庫の取り込み', citeState: 'manual', cites: [] },
    { id: 'e7', type: 'quote', text: '索引が効いているかを確かめます。', citeState: 'manual', cites: [] },
    { id: 'e8', type: 'divider', text: '', citeState: 'manual', cites: [] },
    { id: 'e9', type: 'bullet', text: '次回は会議室を替える。', citeState: 'manual', cites: [] },
    { id: 'e10', type: 'paragraph', text: '以上で終わります。', citeState: 'manual', cites: [] },
  ];
  return { 'koeApp.pageGet': { page: { ...page, blocks, citeStat: { linked: 0, total: 0 }, actionStat: null }, segments: SEGMENTS } };
}
// 0.13.1 NE-4a（NR15）: 入れ子の要約（2段・3段の箇条書き・ToDo・番号付き。番号は親ごと）
function nestedAnswers() {
  const page = fixtures()['koeApp.pageGet'].page;
  const m = (id, type, text, o = {}) => ({ id, type, text, citeState: 'manual', cites: [], ...o });
  const blocks = [
    m('n1', 'heading', '進め方を決めた', { level: 2 }),
    m('n2', 'bullet', '受注の画面は11月15日に出す。', { children: [
      m('n3', 'bullet', '結合の試験は今週で終わった。', { children: [
        m('n4', 'todo', '残りの不具合2件の直しを確かめる', { checked: false, assignee: '山田', due: '2026-10-14', dueRaw: '10月14日' }),
        m('n5', 'bullet', '在庫の取り込みの速さは、索引を足してから測り直す。'),
      ] }),
      m('n6', 'numbered', '試験の環境を空ける。'),
      m('n7', 'numbered', '利用者に知らせる。', { children: [m('n8', 'numbered', '社内の掲示板に書く。'), m('n9', 'numbered', '取引先にはメールで送る。')] }),
    ] }),
    m('n10', 'numbered', '次回は会議室を替える。'),
    m('n11', 'paragraph', '以上で終わります。'),
  ];
  return { 'koeApp.pageGet': { page: { ...page, blocks, citeStat: { linked: 0, total: 0 }, actionStat: null }, segments: SEGMENTS } };
}
// 0.13.1 NE-4b（E5）: 開いたトグル（子が見える）・閉じたトグル（子は描かない）・トグル見出し（開いた・閉じた）
function toggleAnswers() {
  const page = fixtures()['koeApp.pageGet'].page;
  const m = (id, type, text, o = {}) => ({ id, type, text, citeState: 'manual', cites: [], ...o });
  const blocks = [
    m('g1', 'heading', '論点ごとの要点', { level: 2, toggle: true, children: [
      m('g2', 'toggle', '受注の画面', { children: [m('g3', 'bullet', '結合の試験は今週で終わった。'), m('g4', 'bullet', '残りの不具合は2件。')] }),
      m('g5', 'toggle', '在庫の取り込み', { open: false, children: [m('g6', 'bullet', '索引を足してから測り直す。')] }),
    ] }),
    m('g7', 'heading', '持ち越したこと', { level: 3, toggle: true, open: false, children: [m('g8', 'bullet', '価格は次回に決める。')] }),
    m('g9', 'paragraph', '以上で終わります。'),
  ];
  return { 'koeApp.pageGet': { page: { ...page, blocks, citeStat: { linked: 0, total: 0 }, actionStat: null }, segments: SEGMENTS } };
}
// 0.11.0 V-2: 朝会の新しい形の要約（保存は AI の書いた順: 型の見出し → 締め → チェック → 助言）と、照らした点（qualityView）
function qualityAnswers() {
  const page = fixtures()['koeApp.pageGet'].page;
  const blocks = [
    { id: 'q1', type: 'heading', text: '前回の宿題の状況' },
    { id: 'q2', type: 'bullet', text: '受注の画面の結合の試験は今週で終わった。', cites: ['s2'] },
    { id: 'q3', type: 'heading', text: '事実（進捗・課題）' },
    { id: 'q4', type: 'bullet', text: '残りの不具合は2件。在庫の取り込みが遅い。', cites: ['s2', 's3'] },
    { id: 'q5', type: 'heading', text: '決定事項' },
    { id: 'q6', type: 'bullet', text: '出す日を11月15日に決めた。', cites: ['s6'] },
    { id: 'q7', type: 'heading', text: 'ToDo（誰が・何を・いつまでに）' },
    { id: 'q8', type: 'todo', text: '在庫の取り込みの実行計画を確かめる', checked: false, assignee: '山田', due: '2026-10-14', dueRaw: '10月14日', cites: ['s3', 's4'] },
    { id: 'q9', type: 'todo', text: '求人票の見直しの案を出す', checked: false, assignee: '', due: '', dueRaw: '', cites: ['s5'] },
    { id: 'q10', type: 'heading', text: '抜け・重なりチェック' },
    { id: 'q11', type: 'bullet', text: '未確認: 見立て（原因・リスク）', cites: [], citeState: 'manual', mark: 'check', unconfirmed: true },
    { id: 'q12', type: 'heading', text: '次に気をつけること' },
    { id: 'q13', type: 'bullet', text: '遅れの話は、原因と次の手を先に言ってもらう。', cites: [], citeState: 'manual', mark: 'advice' },
  ];
  const qualityView = { total: 17, max: 25, axes: [
    { key: 'purpose', label: '目的と結論', by: 'ai', score: 4, reason: '冒頭で進み具合の確認と言い、出す日を決めた', cites: ['s1', 's6'] },
    { key: 'mece', label: '抜け・重なり（MECE）', by: 'ai', score: 3, reason: '遅れの原因の見立てが話されなかった', cites: [] },
    { key: 'decisions', label: '決定事項', by: 'ai', score: 4, reason: '出す日を11月15日で決まりと言った', cites: ['s6'] },
    { key: 'todos', label: 'ToDo の具体さ', by: 'app', score: 3, reason: 'ToDo 2 件のうち担当と期限がそろったのは 1 件', cites: [] },
    { key: 'fill', label: '型の埋まり具合', by: 'app', score: 3, reason: '型の見出し 4 つのうち根拠があるのは 2 つ', cites: [] },
  ] };
  return { 'koeApp.pageGet': { page: { ...page, blocks, citeStat: { linked: 5, total: 5 }, qualityView }, segments: SEGMENTS } };
}
function detectAnswers() {
  return { 'koeApp.getSettings': { ...fixtures()['koeApp.getSettings'], meetingDetect: true, meetingDetectMute: ['zoom'] } };
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
      engineIdleMin: 10, autoSummarize: true,   // 0.10.0 LS-3 で要約のエンジンのキーを外した
      hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M', segmentSec: 75, pillPos: 'bottom', micId: '',
      language: 'ja', autoPaste: true, removeFillers: true, soundFeedback: true, autoLaunch: false,
      dictionary: ['議事録', '結合試験'], useBuiltinTerms: true, stayInTray: false, theme: 'system', useSystemAudio: false,
    },
    'koeApp.vadStatus': { path: `${ENGINE_DIR}\\models\\ggml-silero-vad.bin`, auto: true },
    'koeApp.engineStatus': { ok: true, whisper: '' },
    'koeApp.engineFetchStatus': null,   // 取り込みの欄は出さない（取り込みの状態で画面が変わらないように）
    'koeApp.hotkeyState': { ok: true, failed: [], fallback: {}, message: '' },
    // 第1d回 A-12: カード「アカウント」はログインしていない形（AR1・AR2 と［ログイン］）。main の account:status の形（cookie は入っていない）
    'koeApp.accountStatus': { ok: true, signedIn: false, email: '', method: 'access', until: null, canStore: true, online: { up: true, why: 'ok' } },
    'koeApp.promptInfo': { ok: true, kept: 2, total: 2, over: false },
    // 0.10.0 C-3: カード「Claude との連携（MCP）」は登録していない形（Claude デスクトップは動いていない）
    'koeApp.mcpStatus': { desktop: { state: 'none', files: 1, running: false } },
    'koeApp.meetingTypes': lib.typesForView(),   // 0.11.0 V-1・V-5: { types, selectable }
    'koeApp.memoTypes': memoTypes.listMemoTypes(),
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
// 0.9.3 M-7: パネルの窓の初めの大きさ（main.js の createNudge と同じ nudgeBounds の NUDGE_FIRST）と、測ったパネル（#nz）の大きさ → 窓の大きさ
const NUDGE_SIZE = (({ width, height }) => ({ width, height }))(lib.nudgeBounds({ size: null, workArea: SHOT_AREA }));
function nudgeWindowFor(size) {
  const b = lib.nudgeBounds({ size, workArea: SHOT_AREA });
  return { width: b.width, height: b.height };
}
/** パネルの四角と窓の内側の大きさを集める文（PANEL_PROBE と同じ形で返すので judgePanel で余白を決める） */
const NUDGE_PROBE = `(() => {
  const r = document.getElementById('nz').getBoundingClientRect();
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
  WAVE_SPEECH, NUDGE_SIZE, NUDGE_PROBE, nudgeWindowFor, detectAnswers,
  PANEL_PROBE, PANEL_PROBE_SCALES, PANEL_PROBE_STATES, judgePanel, panelWindowFor, shotSizeFor, watchdogMs,
  apiNamesOf, fixtures, liveAnswers, bigPage, bigListEntry, judgePair, compareAll, cspViolation, median, judgePerf, judgeOverflow, judgeFocus, judgeZoom,
  exitCodeOf, ensureContentSize,
};
