/*
 * shots/screens.js — 画面を撮って比べる道具（第1a回 G2・PERF）の決め方。純粋（Electron を読まない。test/shots.test.js が試す）
 *
 * 撮るのは tools/shots/main.js（Electron の main）。ここには、撮る画面の並び・偽の橋の名前と見本の答え・
 * 同じ画面を2回撮ったときの揺れの判定・基準との比べ・CSP の違反の行の見分け・開く速さの判定・終了コードを置く。
 *
 * 画面は今日の日付で文字を変える（relTime の「N時間前」・dueInfo の「N日超過」。0.15.1 で音声入力の「今日の入力」は無くなった）。
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
const memoDoc = require('../../src/memoDoc');
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
// 0.13.2 LN-3（持ち主の答え LA2）: ログインしていない遅い PC の会議（PC で文字起こし・区切り 75 秒）。帯は no-login と［ログイン］（kept-late より先に出る形）
const SIGNIN_STT = { route: 'local', lastTextAt: FIXED_NOW - 12000, segSec: 75,
  problem: { code: 'no-login', action: 'signin', text: 'ログインしていないため PC で文字起こししています。［ログイン］を押してログインすると、クラウドで文字起こしします。' } };

// 一覧の1行目を開く（今の画面と同じ）
// 0.15.1 PS-2（計画 docs/plans/2026-11-04-151.md の「意図して変えるテスト」・D124）で意図して変えた: 一覧の見出しは「プライベート」（押すと畳む）になったので、
// 見出し「議事録」を押してからページを開く手順を、押さずに開く形にした（見出しを押していたのはページを開く前の何もしない一手）
const OPEN_PAGE = "document.querySelector('#plist .pitem').click()";
// サイドバーを畳む。第1b回 B-2 の前は［«］が無いので何もしない
const COLLAPSE_SIDE = "(document.getElementById('sideCollapse') || { click() {} }).click()";
// 検索の窓を開く（第1b2回 L-2 の［🔍 検索］）。L-2 の前は押す物が無いので何もしない
const OPEN_PALETTE = "(document.getElementById('sideSearch') || { click() {} }).click()";
// タブ3つ（ページ・音声入力・ページ）を開いて、最後にページを選ぶ。ページを開くのは非同期なので、押すたびに少し待つ（返す promise を main が待つ）。
// 0.9.0 U-1（SP1・D24）で意図して変えた: 設定はタブで開かない（ポップアップ）ので、3つ目は2行目のページを新しいタブ（Ctrl+クリック）で開く
// 0.15.1 ND-3（計画 docs/plans/2026-11-04-151.md の「取り直す画面」・D114）で意図して変えた: 音声入力のタブが無くなったので、ページの3つ（1行目・2行目と
// 3行目を新しいタブ（Ctrl+クリック））を開いて、最後に1行目のページを選ぶ
const OPEN_THREE_TABS = `(async () => {
  const w = () => new Promise((r) => setTimeout(r, 150));
  const item = (i) => document.querySelectorAll('#plist .pitem')[i || 0];
  item().click(); await w();
  item(1).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); await w();
  item(2).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); await w();
  item().click(); await w();
  return 1;
})()`;
// 0.15.0 PH-3: 1行目のページを開いて（非同期なので少し待つ）、子のある閉じた行（p2）のアイコンの所を ▸ にした形。
// PH-3 直し（R26）: 撮る窓は見せない窓（show: false）でフォーカスを持たず :focus も :hover も当たらない（CI run 41705176203 の画像で ▸ が出なかった）ので、
// 乗せた・フォーカスした行の CSS（.pitem.kids:hover .pe・.tw）と同じ形を行の style で当てる（focus() で一覧を捲らない）
const FOCUS_TREE = `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  const row = document.querySelector('#plist .pitem.kids[data-pid="p2"]');
  row.querySelector('.pe').style.visibility = 'hidden';
  row.querySelector('.tw').style.display = 'flex';
  return 1;
})()`;
// 0.15.0 PH-5: 6 段目のページ（d5）を開いて（祖先の行は開いた覚え書き）、パンくずの「…」を押して隠れた段の一覧を出す
const OPEN_DEEP = `(async () => {
  document.querySelector('#plist .pitem[data-pid="d5"]').click();
  await new Promise((r) => setTimeout(r, 300));
  document.querySelector('#crumb [data-crumb="more"]').click();
  return 1;
})()`;
// 0.15.0 PH-5: 子のある議事録（一覧の1行目 p1）を開いて、［AI 要約］の欄の最後の「このページの中のページ」まで捲る
const OPEN_KIDS = `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnNote').click();
  document.getElementById('pKids').scrollIntoView({ block: 'end' });
  return 1;
})()`;
// 0.15.0 PH-5: サイドバーの木の p2 を開いて「···」の［移動先…］を押す（候補は p2 と子孫を除いた木の順・場所つき）
const OPEN_MOVE = `(async () => {
  document.querySelector('#plist .pitem[data-pid="p2"]').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('pMore').click();
  [...document.querySelectorAll('#pMenu .mitem')].find((b) => b.textContent === '移動先…').click();
  return 1;
})()`;
// 0.15.0 PH-5: 1行目のページを開いて Ctrl+Shift+N（「新しいページ」の選び）
const OPEN_NEW = `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true, bubbles: true }));
  return 1;
})()`;
// 0.16.0 DX-1: サイドバーのデータベース（🗃️・▸ と［＋］が無い。一覧に混じった行は出さない）の行のメニュー（中に作る2つが無い）を開く。
// 本物の Chromium で、データベースの行のアイコンと、行が出ていないことを確かめる（違えば投げて「撮れない」）
// 0.17.0 SV-2（計画 docs/plans/2026-11-13-170.md の「撮る画面」）: サイドバーのデータベースの行の ▸ を押して、下に出たビューの行（•と名前）の1つ目を押す
// （そのビューでデータベースを開き、その行に選んでいる印）
const OPEN_SIDE_VIEWS = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  await w(300);
  const row = document.querySelector('#plist .pitem[data-pid="pd1"]');
  if (!row || !row.classList.contains('kids')) throw new Error('サイドバーのデータベースの行に ▸ が無い');
  row.querySelector('.pi').click();
  await w(150);
  const vs = [...document.querySelectorAll('#plist .pview')];
  if (vs.length !== 3) throw new Error('ビューの行が3つでない');
  vs[0].click();
  await w(500);
  const on = document.querySelector('#plist .pview.sel');
  if (!on || on.textContent !== '•表') throw new Error('開いたビューの行に印が無い');
  return 1;
})()`;
const OPEN_SIDE_DB = `(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const row = document.querySelector('#plist .pitem[data-pid="pd1"]');
  if (!row || row.querySelector('.pi').getAttribute('data-icon') !== 'ic:table_chart' || row.querySelector('.padd')) throw new Error('サイドバーのデータベースの行の形が違う');   // 0.17.0 IV-1: 表のアイコン
  if (document.querySelector('#plist .pitem[data-pid="rx1"]')) throw new Error('データベースの行がサイドバーに出る');
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 100));
  const m = document.querySelector('.treemenu');
  if (!m || [...m.querySelectorAll('.mitem')].map((b) => b.textContent).join('|') !== 'リンクを写す|名前を変える|移動先…|新しいタブで開く|削除') throw new Error('データベースの行のメニューが違う');
  return 1;
})()`;
// 0.16.0 DX-2: OPEN_TRASH と同じに［ゴミ箱］を開き、本物の Chromium で行のまとまりの2行の文を確かめる（違えば投げて「撮れない」）
const OPEN_TRASH_ROWS = `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('tabBtnTrash').click();
  await new Promise((r) => setTimeout(r, 100));
  const t = [...document.querySelectorAll('#trashList .tprow')].map((e) => e.querySelector('.tpt').textContent + '|' + e.querySelector('.tpm').textContent.replace(/^[^・]*/, ''));
  if (t[0] !== '行 見積もりの作成 3（案件の一覧）|・ほかの行 2' || t[1] !== '行 検収の段取り 9（案件の一覧）|') throw new Error('ゴミ箱の行のまとまりの文が違う: ' + t.join(' / '));
  return 1;
})()`;
// 0.15.0 PH-6: 1行目のページを開いて、サイドバーの［🗑️ ゴミ箱］を押す
const OPEN_TRASH = `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('tabBtnTrash').click();
  return 1;
})()`;
// 0.15.0 PL-3: 1行目のページを開いて（非同期なので少し待つ）、ページの頭のアイコンを押してアイコンの選びを開く
// 0.16.0 DR-1 の CI（run 42572852010）で、決まった 300 ミリ秒ではページを開き終わらずに［アイコン］を押し、窓が出ないまま撮った（2回の撮りで違う: 揺れ）。
// ページの題名が出るまで待ってから押し、窓が出るまで待つ（出なければ投げて「撮れない」）
const OPEN_ICON = `(async () => {
  document.querySelector('#plist .pitem').click();
  const until = async (ok, what) => { for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); if (!ok()) throw new Error(what); };
  await until(() => document.getElementById('pTitle').textContent !== '', 'ページが開かない');
  await new Promise((r) => setTimeout(r, 100));
  document.getElementById('pIcon').click();
  await until(() => !document.getElementById('iconPop').hidden, 'アイコンの窓が出ない');
  return 1;
})()`;
// 0.15.0 PL-3: 1行目のページを開いて「···」のメニューを開き、［書体 ▸］を押して 標準・明朝・等幅 を出す
const OPEN_LOOK_MENU = `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('pMore').click();
  [...document.querySelectorAll('#pMenu .mitem')].find((b) => b.textContent === '書体 ▸').click();
  return 1;
})()`;
// 0.16.0 DV-1: 1行目のデータベースを開いて（表を読むので少し待つ）、3行目の「状態」のセルを選ぶ
// 0.16.0 DV-2 で意図して直した: ステータスのセルは押すと選びの窓が開くので、Esc で窓を閉じて選んだだけの形にする
const OPEN_DB_AT = (then) => `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 500));
  const cell = (row, col) => [...document.querySelectorAll('#pDb .dbrow')][row].querySelector('.dbcell[data-col="' + col + '"]');
  ${then}
  return 1;
})()`;
const OPEN_DB = OPEN_DB_AT(`cell(2, 'c2').click();
  const q = document.querySelector('#pDb .dbpick input'); if (q) q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
// 0.16.0 DV-2: 列のメニュー（数値の列「金額」の見出しを押す）・選択肢の選び（3行目の「状態」のセル。3つのまとまりの見出し）・暦（1行目の「期日」のセル）
const OPEN_DB_COLMENU = OPEN_DB_AT(`[...document.querySelectorAll('#pDb .dbcolh')].find((h) => h.dataset.col === 'c3').querySelector('.dbcolbtn').click();`);
const OPEN_DB_SELECT = OPEN_DB_AT(`cell(2, 'c2').click();`);
const OPEN_DB_DATE = OPEN_DB_AT(`cell(0, 'c4').click();`);
// 0.16.0 DV-3: リスト（開くだけ）・絞り込みの窓（⚙ →［絞り込み］）・グループ（開くだけ）・タブの「他 n 件」と今のタブのメニュー
const OPEN_DB_PLAIN = OPEN_DB_AT('');
// DV-3 直し（rv48 F1・F4・F7・R89）: 本物の Chromium で見る（偽の DOM では見えない NodeList・フォーカス・タブの幅）。崩れていれば投げて「撮れない」の NG にする
const OPEN_DB_FILTER = OPEN_DB_AT(`const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errs.push(String((e.reason && e.reason.message) || e.reason)));
  const open = (label) => { document.querySelector('#pDb .dbsetbtn').click(); [...document.querySelectorAll('#pDb .dbmenu .mitem')].find((b) => b.textContent === label).click(); };
  const inPanel = () => Boolean(document.activeElement && document.activeElement.closest('.dbpanel'));
  open('並べ替え');
  if (!inPanel()) throw new Error('並べ替えの窓にフォーカスが無い');
  const add = [...document.querySelectorAll('#pDb .dbpanel button')].find((b) => b.textContent === '並べ替えを足す');
  add.focus(); add.click();
  await new Promise((r) => setTimeout(r, 300));
  if (!inPanel()) throw new Error('並べ替えを足すとフォーカスが窓から外れる');
  document.querySelector('#pDb .dbpanel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));   // 窓を閉じてから（⚙ は開いている窓を閉じる）
  if (document.querySelector('#pDb .dbpanel')) throw new Error('Esc で窓が閉じない');
  open('絞り込み');
  await new Promise((r) => setTimeout(r, 100));
  if (errs.length) throw new Error('画面のエラー: ' + errs.join(' / '));`);
const OPEN_DB_VIEWS = OPEN_DB_AT(`const shown = [...document.querySelectorAll('#pDb .dbtab')].filter((b) => !b.hidden).map((b) => b.getBoundingClientRect().height);
  if (Math.max(...shown) > Math.min(...shown) + 1) throw new Error('タブの高さが揃わない（名前が折り返している）: ' + shown.join(','));
  if (document.querySelector('#pDb .dbtabmore').hidden) throw new Error('入り切らないタブがあるのに「他 n 件」が出ない');
  const mh = document.querySelector('#pDb .dbtabmore').getBoundingClientRect().height;   // DV-3 直し2（rv49 I1）: 「他 n 件」も1行・中の検索の欄は縮まない
  if (mh > Math.max(...shown) + 1) throw new Error('「他 n 件」が折り返している: ' + mh);
  const qw = document.querySelector('#pDb .dbsearchq').getBoundingClientRect().width;
  if (qw < 150) throw new Error('中の検索の欄が縮んでいる: ' + qw);
  const strip = document.querySelector('#pDb .dbtabs').getBoundingClientRect().height;
  if (strip > Math.max(...shown) + 16) throw new Error('タブの並びが2行以上: ' + strip);
  // R96: 切れている（240px で …）タブだけ名前全体の吹き出し（title）
  const cut = [...document.querySelectorAll('#pDb .dbtab')].filter((b) => !b.hidden && b.scrollWidth > b.clientWidth);
  if (!cut.length) throw new Error('長い名前のタブが切れていない');
  for (const b of document.querySelectorAll('#pDb .dbtab')) {
    if (b.hidden) continue;
    const want = cut.includes(b) ? b.textContent : null;
    if (b.getAttribute('title') !== want) throw new Error('タブの吹き出しが違う: ' + b.textContent + ' → ' + b.getAttribute('title'));
  }
  document.querySelector('#pDb .dbtab[aria-selected="true"]').click();`);
// 0.16.0 DV-4: 1行目の題名のセルの［開く］で行のページ（列の値の並びと本文）。本物の Chromium で列の値の並び・パンくず・画面のエラーを確かめ、崩れていれば「撮れない」
const OPEN_DB_ROW = OPEN_DB_AT(`const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errs.push(String((e.reason && e.reason.message) || e.reason)));
  document.querySelector('#pDb .dbrow .dbopen').click();
  await new Promise((r) => setTimeout(r, 500));
  if (document.querySelectorAll('#pProps .dbprop').length !== 6) throw new Error('行のページに列の値の並びが無い');
  if (!document.querySelector('#pageWrap.row') || !document.getElementById('pDb').hidden) throw new Error('行のページの形でない');
  if ([...document.querySelectorAll('#crumb .cseg .cst')].map((x) => x.textContent).join('/') !== '案件の一覧') throw new Error('パンくずにデータベースの段が無い');
  if (errs.length) throw new Error('画面のエラー: ' + errs.join(' / '));`);
// 0.16.0 DR-1: リレーションのセルの「📄 題名」と選びの窓。本物の Chromium で並び・窓の欄・画面のエラーを確かめ、崩れていれば「撮れない」
const OPEN_DB_REL = OPEN_DB_AT(`const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errs.push(String((e.reason && e.reason.message) || e.reason)));
  const chips = [...cell(1, 'c7').querySelectorAll('.dbrel')].map((x) => \`\${(x.querySelector('.pgi') || { getAttribute: () => '' }).getAttribute('data-icon')} \${x.textContent}\`);   // 0.17.0 IV-1: 頭は書類のアイコンの絵
  if (chips.join('/') !== 'ic:certification_with_seal 南の印刷所/ic:certification_with_seal 東の運送') throw new Error('リレーションのセルの並びが違う: ' + chips.join('/'));
  if (cell(1, 'c7').scrollHeight > cell(1, 'c7').clientHeight + 2) throw new Error('リレーションのセルが折り返している');
  const r = cell(1, 'c7').getBoundingClientRect();
  cell(1, 'c7').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.right - 4, clientY: r.top + 4 }));
  await new Promise((res) => setTimeout(res, 300));
  const q = document.querySelector('#pDb .dbpick input');
  if (!q || q.getAttribute('aria-label') !== '行を探す') throw new Error('選びの窓が出ない');
  if (document.querySelectorAll('#pDb .dbpick .dbopt').length !== 4) throw new Error('選びの窓の行が違う');
  if (errs.length) throw new Error('画面のエラー: ' + errs.join(' / '));`);
// 0.16.0 DR-1: サブアイテムの1行目の ▸ を押して開き（▾）、字下げを本物の Chromium で確かめる
const OPEN_DB_SUB = OPEN_DB_AT(`const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message)));
  const tog = document.querySelector('#pDb .dbrow .dbsubtog');
  if (!tog) throw new Error('サブアイテムの ▸ が無い');
  tog.click();
  await new Promise((res) => setTimeout(res, 300));
  const t = document.querySelector('#pDb .dbrow .dbsubtog');
  if (t.getAttribute('aria-expanded') !== 'true') throw new Error('▸ を押しても開かない');
  // 0.16.0 直し（R128）: 見本の答えは r3 の子（r4）も並べるので、r3 の ▸ も押して ▾ にする（取り直しの画面で、閉じた ▸ の下に子が写っていた）
  const tog3 = document.querySelectorAll('#pDb .dbrow')[2].querySelector('.dbsubtog');
  if (!tog3) throw new Error('3行目（r3）の ▸ が無い');
  tog3.click();
  await new Promise((res) => setTimeout(res, 300));
  const t3 = document.querySelectorAll('#pDb .dbrow')[2].querySelector('.dbsubtog');   // 描き直しで替わるので探し直す
  if (!t3 || t3.getAttribute('aria-expanded') !== 'true') throw new Error('r3 の ▸ を押しても開かない');
  const x0 = cell(0, 'title').getBoundingClientRect().left + parseFloat(getComputedStyle(cell(0, 'title')).paddingLeft);
  const x1 = cell(1, 'title').getBoundingClientRect().left + parseFloat(getComputedStyle(cell(1, 'title')).paddingLeft);
  if (!(x1 > x0 - 26 + 10)) throw new Error('子が字下げされない: ' + x0 + ' ' + x1);
  if (errs.length) throw new Error('画面のエラー: ' + errs.join(' / '));`);
// 0.10.0 L-1: 1行目のページを開いて（非同期なので少し待つ）、「···」のメニュー（［コピー］［リンクを写す］［削除］）を開く
const OPEN_PAGE_MENU = `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('pMore').click();
  return 1;
})()`;
// 0.10.0 LS-2 の見直し（取り直しの見比べで、要約の無いページは「文字起こし」の欄で開き、鍵の一言が写っていなかった）: ページを開いてから［AI 要約］の欄を押す
const OPEN_PAGE_SUMMARY = `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnNote').click();
  return 1;
})()`;
// 0.11.0 V-1: ページを開いてメモのタブにし、会議の種類の欄を一覧の形にして中身（自動・群・種類）を見せる
const OPEN_TYPE_LIST = `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnMemo').click();
  // 欄の高さ（.typeSel の 22px）を外して、一覧の形で全部の項目を見せる（R22 (3)）
  const s = document.getElementById('pType'); s.size = s.querySelectorAll('option').length; s.style.height = 'auto';
  return 1;
})()`;
// 0.12.0 SP-4: ページを開いて文字起こしのタブにする（札・重なり・文ごとの行）
const OPEN_PAGE_SCRIPT = `(async () => {
  document.querySelector('#plist .pitem').click();
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
  document.querySelector('#plist .pitem').click();
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
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnNote').click();
  [...document.querySelectorAll('#pNote .blk')].find((e) => e.dataset.id === 'b2').querySelector('.grip').click();
  [...document.querySelectorAll('#pNote .blockmenu .mitem')].find((b) => b.textContent === '変換 ▸').click();
  return 1;
})()`;
// 0.14.0 EB-5（計画 docs/plans/2026-10-26-140.md の決めたこと 19〜21）: 行 b2 の頭の4文字を選んで道具の帯を出し、then を続ける（リンクの欄・色のメニュー）
// EB-5 直し: tail なら行の文の終わりの4字を選ぶ（拡大 200% で右へ寄った選びの帯と色のメニューが欄の幅に収まるかを撮る）
const SELECT_MARKS = (then, tail = false) => `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnNote').click();
  const t = [...document.querySelectorAll('#pNote .blk')].find((e) => e.dataset.id === 'b2').querySelector('.txt');
  t.focus();
  const n = document.createTreeWalker(t, NodeFilter.SHOW_TEXT).nextNode();
  const r = document.createRange(); ${tail ? 'r.setStart(n, Math.max(0, n.length - 4)); r.setEnd(n, n.length);' : 'r.setStart(n, 0); r.setEnd(n, Math.min(4, n.length));'}
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  ${then}
  await new Promise((r2) => setTimeout(r2, 50));
  return 1;
})()`;
const LINK_REFUSED = `t.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }));
  const i = document.querySelector('#linkPop input'); i.value = 'javascript:alert(1)';
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`;
const COLOR_OPEN = "document.querySelector('#markBar .mb-color').click();";
// 0.14.0 EK-4（計画 docs/plans/2026-10-26-140.md の決めたこと 28）: 行 b2 で Esc を押して行を選び、Shift+↓ を2回で3行を選んだ形（選んだ行の地の色）
const SELECT_ROWS = `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnNote').click();
  const t = [...document.querySelectorAll('#pNote .blk')].find((e) => e.dataset.id === 'b2').querySelector('.txt');
  t.focus();
  t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const box = document.getElementById('pNote');
  for (let i = 0; i < 2; i++) box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
  await new Promise((r2) => setTimeout(r2, 50));
  return 1;
})()`;
// 0.13.0 ED-7（E5）: ページを開いて［AI 要約］の欄の頭まで捲る（新しい型の行が全部見えるように。撮った画像の確かめで、欄が窓の下に切れていた）
const OPEN_TYPES = `(async () => {
  document.querySelector('#plist .pitem').click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnNote').click();
  document.querySelector('#pNote .blk').scrollIntoView({ block: 'start' });
  return 1;
})()`;
// 0.14.0 MB-4: ページ（か録音中のページ）を開いてメモのタブにし、メモの行の頭まで捲る
const OPEN_MEMO = (page) => `(async () => {
  ${page ? "document.querySelector('#plist .pitem').click();" : ''}
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById('paneBtnMemo').click();
  const b = document.querySelector('#pMemo .memorows'); if (b) b.scrollIntoView({ block: 'center' });
  return 1;
})()`;
// 0.11.0 V-2: ページを開き、打ち合わせの質のカードまで捲る
const OPEN_QUALITY = `(async () => {
  document.querySelector('#plist .pitem').click();
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
// 0.15.1 PS-2（D124）: 見出し「プライベート」を押して畳む（1行目のページを開いた後）
const FOLD_PRIVATE = `${OPEN_PAGE}; document.getElementById('privHead').click()`;
// 見出しの右の3つは乗せたとき・フォーカスがあるときだけ出る（PQ6）。撮る窓は :hover も :focus-within も当たらない（0.15.0 PH-3 直し R26 と同じ）ので、
// 乗せた行の CSS（.privrow:hover の地と .ph-btn の opacity: 1）と同じ形を style で当てる
const SHOW_PRIVATE_BTNS = "document.getElementById('privRow').style.background = 'var(--hover)'; for (const id of ['privLib', 'newPageBtn', 'privMore']) document.getElementById(id).style.opacity = '1'";
// 見出しの［···］を開き、［並べ替え: 手動 ›］の下のメニュー（手動・最終更新）を開いた形
const PRIVATE_MENU = `(async () => {
  ${SHOW_PRIVATE_BTNS};
  document.getElementById('privMore').click();
  document.getElementById('privSort').click();
  await new Promise((r) => setTimeout(r, 150));
  return 1;
})()`;
// 0.15.1 PS-3（D124）: 1行目のページを開いて、その行の［···］で行のメニュー（6つの項目と最終更新の行）を開いた形。行の［···］と［＋］は乗せたときだけ出る
//（撮る窓は :hover が当たらない）ので、乗せた行の CSS と同じ形を style で当てる
const ROW_MENU = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  ${OPEN_PAGE}; await w(200);
  const row = document.querySelector('#plist .pitem');
  row.style.background = 'var(--hover)';
  for (const b of row.querySelectorAll('.pmore, .padd')) b.style.display = 'inline-flex';
  row.querySelector('.pmore').click(); await w(150);
  return 1;
})()`;
// 0.15.1 PS-3（D124）: 2行目で Ctrl+Shift+R を押して、行の題名の所の名前を変える欄を出した形（今の題名を全部選んだ形）
const ROW_RENAME = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  ${OPEN_PAGE}; await w(200);
  const row = document.querySelectorAll('#plist .pitem')[1];
  row.focus();
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true, bubbles: true })); await w(150);
  return 1;
})()`;
// 0.15.1 PS-4（D125）: 見出しの ↗ でライブラリのタブを開く（探す形は語「見積」を入れて木を崩した形）
const OPEN_LIBRARY = "document.getElementById('privLib').click()";
const LIBRARY_SEARCH = `(async () => {
  document.getElementById('privLib').click();
  await new Promise((r) => setTimeout(r, 150));
  const q = document.getElementById('libSearch'); q.value = '見積'; q.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 150));
  return 1;
})()`;
// 0.10.0 L-2: 左の一覧の［選ぶ］を押し、1行目と3行目を選ぶ（頭の枠「2 件を選んでいます」と［リンクを写す］［やめる］）
const SELECT_TWO = `(() => {
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
  // 0.15.1 PS-2（D124）で意図して変えた: notes-empty-light は起動したままの形（見出しを押す手順は無い。押していた goNotes は、開いたタブの無い起動では何もしなかった）
  { name: 'notes-empty-light', page: 'app', theme: 'light' },
  { name: 'notes-page-light', page: 'app', theme: 'light', act: OPEN_PAGE },
  { name: 'notes-page-dark', page: 'app', theme: 'dark', act: OPEN_PAGE },
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
  // 0.13.2 LN-3（持ち主の答え LA2）: 録音中のページの帯 no-login と［ログイン］。足した画面（まだ基準が無い）
  { name: 'live-banner-signin-light', page: 'app', theme: 'light', answers: liveAnswers(SIGNIN_STT) },
  // 0.13.2 LN-5（持ち主の答え LA4）: 保存した議事録のページの「文字起こし」の欄の頭の1行（文字起こし待ちと［もう一度文字起こし］・回している途中で押せない形）。足した画面（まだ基準が無い）
  { name: 'page-pending-light', page: 'app', theme: 'light', answers: { 'koeApp.pagePending': { left: 12, running: false, busy: false } }, act: OPEN_PAGE_SCRIPT },
  { name: 'page-pending-running-light', page: 'app', theme: 'light', answers: { 'koeApp.pagePending': { left: 5, running: true, busy: false } }, act: OPEN_PAGE_SCRIPT },
  // 0.14.0 EB-4（計画 docs/plans/2026-10-26-140.md の「取り直す画面（RETAKE）」）: 行の文の飾り5つ・文字の色と背景の色の全部（9色ずつ）・リンク（明暗で読めるか）。
  // 足した画面（まだ基準が無い）
  { name: 'edit-marks-light', page: 'app', theme: 'light', get answers() { return marksAnswers(); }, act: OPEN_TYPES },
  { name: 'edit-marks-dark', page: 'app', theme: 'dark', get answers() { return marksAnswers(); }, act: OPEN_TYPES },
  // 0.14.0 EB-5（計画の「取り直す画面（RETAKE）」）: 文字を選んで出た道具の帯・Ctrl+K のリンクの欄（開けない頭の断りの文）・帯の［色 ▸］の2列。足した画面（まだ基準が無い）。
  // ⠿ のメニューの画面 edit-block-menu-light は［色 ▸］が増えるので取り直す
  { name: 'edit-toolbar-light', page: 'app', theme: 'light', act: SELECT_MARKS('') },
  { name: 'edit-link-light', page: 'app', theme: 'light', act: SELECT_MARKS(LINK_REFUSED) },
  { name: 'edit-color-menu-light', page: 'app', theme: 'light', act: SELECT_MARKS(COLOR_OPEN) },
  // 0.14.0 EB-5 直し: 拡大 200% で行の文の終わりを選んだ帯と［色 ▸］のメニュー（欄の幅に収まり、横の捲り棒が出ない）。足した画面（まだ基準が無い）
  { name: 'edit-toolbar-zoom200-light', page: 'app', theme: 'light', zoom: 2, act: SELECT_MARKS(COLOR_OPEN, true) },
  // 0.14.0 EK-4（計画の「取り直す画面（RETAKE）」）: 要約の3行を選んだ形（選んだ行の地の色の明暗）。足した画面（まだ基準が無い）
  { name: 'edit-select-light', page: 'app', theme: 'light', act: SELECT_ROWS },
  { name: 'edit-select-dark', page: 'app', theme: 'dark', act: SELECT_ROWS },
  // 0.14.0 EK-5（計画の「取り直す画面（RETAKE）」）: 設定の［一般］の「ホットキー」の下の窓の中の近道の表（Ctrl+Shift+N の行は無い）と音声入力のキーの一言（表の見出しまで捲った形）。
  // 足した画面（まだ基準が無い）。表で「ホットキー」のカードが伸びる settings-light・settings-dark・settings-zoom200-dark は取り直す
  { name: 'settings-shortcuts-light', page: 'app', theme: 'light', act: `${OPEN_SETTINGS}; document.getElementById('shortcutTitle').scrollIntoView({ block: 'start' })` },
  // 0.14.0 MB-4（計画の「取り直す画面（RETAKE）」）: 保存したページのメモの行（雛形の見出し3・箇条書き・太字・色）の明暗と、録音中のページのメモの行。足した画面（まだ基準が無い）。
  // メモの欄が textarea から行になる live-ready-*・live-type-light・page-type-* は取り直す
  { name: 'memo-blocks-light', page: 'app', theme: 'light', get answers() { return memoBlocksAnswers(); }, act: OPEN_MEMO(true) },
  { name: 'memo-blocks-dark', page: 'app', theme: 'dark', get answers() { return memoBlocksAnswers(); }, act: OPEN_MEMO(true) },
  { name: 'live-memo-blocks-light', page: 'app', theme: 'light', get answers() { return liveMemoAnswers(); }, act: OPEN_MEMO(false) },
  // 0.15.0 PH-3（計画 docs/plans/2026-11-03-150.md の「取り直す画面（RETAKE）」）: サイドバーの木（3 段より深い開いた行・閉じた行・フォーカスした ▸・深い段の字下げ）。
  // 足した画面（まだ基準が無い）。拡大 200% でも題名が切れずに並ぶ
  { name: 'sidebar-tree-light', page: 'app', theme: 'light', get answers() { return treeAnswers(); }, act: FOCUS_TREE },
  { name: 'sidebar-tree-dark', page: 'app', theme: 'dark', get answers() { return treeAnswers(); }, act: FOCUS_TREE },
  { name: 'sidebar-tree-zoom200-light', page: 'app', theme: 'light', zoom: 2, get answers() { return treeAnswers(); }, act: FOCUS_TREE },
  // 0.15.0 PH-4（計画の「取り直す画面（RETAKE）」）: 白紙のページ（頭はアイコン 📄 と題名だけ・タブと会議の種類とプロパティが無い・本文の見出しと箇条書き）の明暗。
  // 足した画面（まだ基準が無い）。/ メニューに［ページ］が増える edit-slash-recent-light は取り直す（語「みだし」で開く edit-slash-light・dark は変わらない）
  { name: 'page-blank-light', page: 'app', theme: 'light', get answers() { return blankAnswers(); }, act: OPEN_PAGE },
  { name: 'page-blank-dark', page: 'app', theme: 'dark', get answers() { return blankAnswers(); }, act: OPEN_PAGE },
  // 0.15.0 PR-2（計画 docs/plans/2026-11-03-150.md の「取り直す画面」）: 白紙のページの本文の子ページの行（見出し・箇条書きの間・トグルの中・灰色の行・行の無い子の一覧）
  { name: 'page-rows-light', page: 'app', theme: 'light', get answers() { return rowsAnswers(); }, act: OPEN_PAGE },
  { name: 'page-rows-dark', page: 'app', theme: 'dark', get answers() { return rowsAnswers(); }, act: OPEN_PAGE },
  // 0.15.0 PH-5（計画 docs/plans/2026-11-03-150.md の「取り直す画面」）: 6 段のパンくずの「…」と隠れた段の一覧・議事録の［AI 要約］の下の子ページの一覧・
  // ［移動先…］の窓・Ctrl+Shift+N の「新しいページ」の選び。足した画面（まだ基準が無い）
  { name: 'crumb-deep-light', page: 'app', theme: 'light', get answers() { return deepAnswers(); }, act: OPEN_DEEP },
  { name: 'page-kids-light', page: 'app', theme: 'light', get answers() { return kidsAnswers(); }, act: OPEN_KIDS },
  { name: 'move-pop-light', page: 'app', theme: 'light', get answers() { return moveAnswers(); }, act: OPEN_MOVE },
  { name: 'new-pop-light', page: 'app', theme: 'light', act: OPEN_NEW },
  // 0.15.0 PH-6（計画の「取り直す画面」）: ゴミ箱の窓（一緒に消したまとまりの頭の行・消した日時・中のページ n・［戻す］）。種にゴミ箱のページを持つのはこの画面だけ（ほかの画面は空）
  { name: 'trash-pop-light', page: 'app', theme: 'light', get answers() { return trashAnswers(); }, act: OPEN_TRASH },
  // 0.15.0 PL-3（計画の「取り直す画面」）: アイコンの選び（最近使ったもの・分類の見出しと並び）の明暗・全幅（拡大 200% で横の捲り棒が出ない）・
  // 小さい文字と明朝・等幅・「···」の見た目の項目（全幅に印・［書体 ▸］を開いて明朝に印）。足した画面（まだ基準が無い）
  { name: 'icon-pop-light', page: 'app', theme: 'light', answers: { 'koeApp.uiState': { emojiRecent: ['🚀', '📊', '🌸'] } }, act: OPEN_ICON },
  { name: 'icon-pop-dark', page: 'app', theme: 'dark', answers: { 'koeApp.uiState': { emojiRecent: ['🚀', '📊', '🌸'] } }, act: OPEN_ICON },
  { name: 'look-wide-light', page: 'app', theme: 'light', get answers() { return lookAnswers({ wide: true }); }, act: OPEN_PAGE },
  { name: 'look-wide-zoom200-light', page: 'app', theme: 'light', zoom: 2, get answers() { return lookAnswers({ wide: true }); }, act: OPEN_PAGE },
  { name: 'look-small-serif-light', page: 'app', theme: 'light', get answers() { return lookAnswers({ small: true, font: 'serif' }); }, act: OPEN_PAGE },
  { name: 'look-mono-light', page: 'app', theme: 'light', get answers() { return lookAnswers({ font: 'mono' }); }, act: OPEN_PAGE },
  { name: 'page-menu-look-light', page: 'app', theme: 'light', get answers() { return lookAnswers({ wide: true, font: 'serif' }); }, act: OPEN_LOOK_MENU },
  // PL-3 直し（R77）: 小さい文字の拡大 200%（狭い窓の題名は標準の狭い窓より小さい）
  { name: 'look-small-zoom200-light', page: 'app', theme: 'light', zoom: 2, get answers() { return lookAnswers({ small: true }); }, act: OPEN_PAGE },
  // 0.15.1 PS-2（計画 docs/plans/2026-11-04-151.md の「取り直す画面（RETAKE）」・D124）: 見出し「プライベート」を畳んだサイドバーの明暗（印 ›・下の［設定］が同じ所）・
  // 見出しの右の ↗・［＋］・［···］と開いた［···］のメニューと［並べ替え ›］の下のメニュー・表示 5 と［もっと見る］・拡大 200% の見出しの行。足した画面（まだ基準が無い）
  { name: 'side-private-folded-light', page: 'app', theme: 'light', act: FOLD_PRIVATE },
  { name: 'side-private-folded-dark', page: 'app', theme: 'dark', act: FOLD_PRIVATE },
  { name: 'side-private-menu-light', page: 'app', theme: 'light', act: PRIVATE_MENU },
  { name: 'side-private-more-light', page: 'app', theme: 'light', get answers() { return moreAnswers(); } },
  { name: 'side-private-zoom200-light', page: 'app', theme: 'light', zoom: 2, act: `${OPEN_PAGE}; ${SHOW_PRIVATE_BTNS}` },
  // 0.15.1 PS-3（計画の「取り直す画面（RETAKE）」・D124）: 行の［···］のメニュー（6つと最終更新の行）と、行の中の名前を変える欄。足した画面（まだ基準が無い）
  { name: 'side-row-menu-light', page: 'app', theme: 'light', act: ROW_MENU },
  { name: 'side-row-rename-light', page: 'app', theme: 'light', act: ROW_RENAME },
  // 0.15.1 PS-4（計画の「取り直す画面（RETAKE）」・D125）: ライブラリ（題・種類のタブ・探す欄・［＋ 新しいページ］・表・相対の日時・▸）の明暗・拡大 200% と、
  // 探したとき（木を崩して場所付き）。サイドバーの木と同じ見本（0.15.0 PH-3 の treeAnswers）。足した画面（まだ基準が無い）
  { name: 'library-light', page: 'app', theme: 'light', get answers() { return treeAnswers(); }, act: OPEN_LIBRARY },
  { name: 'library-dark', page: 'app', theme: 'dark', get answers() { return treeAnswers(); }, act: OPEN_LIBRARY },
  { name: 'library-zoom200-light', page: 'app', theme: 'light', zoom: 2, get answers() { return treeAnswers(); }, act: OPEN_LIBRARY },
  { name: 'library-search-light', page: 'app', theme: 'light', get answers() { return treeAnswers(); }, act: LIBRARY_SEARCH },
  // 0.16.0 DV-1（計画 docs/plans/2026-11-04-160.md の「取り直す画面」）: データベースの表（20 行・7 種類の列・下の集計・選んだセル）の明暗と拡大 200%（横に捲れて見出しが切れない）。
  // 足した画面（まだ基準が無い）
  { name: 'db-table-light', page: 'app', theme: 'light', get answers() { return dbAnswers(); }, act: OPEN_DB },
  { name: 'db-table-dark', page: 'app', theme: 'dark', get answers() { return dbAnswers(); }, act: OPEN_DB },
  { name: 'db-table-zoom200-light', page: 'app', theme: 'light', zoom: 2, get answers() { return dbAnswers(); }, act: OPEN_DB },
  { name: 'db-colmenu-light', page: 'app', theme: 'light', get answers() { return dbAnswers(); }, act: OPEN_DB_COLMENU },
  { name: 'db-cell-select-light', page: 'app', theme: 'light', get answers() { return dbAnswers(); }, act: OPEN_DB_SELECT },
  { name: 'db-cell-date-light', page: 'app', theme: 'light', get answers() { return dbAnswers(); }, act: OPEN_DB_DATE },
  { name: 'db-list-light', page: 'app', theme: 'light', get answers() { return dbAnswers('list'); }, act: OPEN_DB_PLAIN },
  { name: 'db-filter-light', page: 'app', theme: 'light', get answers() { return dbAnswers('filter'); }, act: OPEN_DB_FILTER },
  { name: 'db-group-light', page: 'app', theme: 'light', get answers() { return dbAnswers('group'); }, act: OPEN_DB_PLAIN },
  { name: 'db-views-light', page: 'app', theme: 'light', get answers() { return dbAnswers('views'); }, act: OPEN_DB_VIEWS },
  { name: 'db-row-page-light', page: 'app', theme: 'light', get answers() { return dbAnswers('row'); }, act: OPEN_DB_ROW },
  // 0.16.0 DR-1: リレーションのセル（📄 題名の並び）と選びの窓（2行目の「取引先」）・サブアイテムの ▾ と字下げ（足した画面。まだ基準が無い）
  { name: 'db-relation-light', page: 'app', theme: 'light', get answers() { return dbAnswers('relation'); }, act: OPEN_DB_REL },
  { name: 'db-subitems-light', page: 'app', theme: 'light', get answers() { return dbAnswers('sub'); }, act: OPEN_DB_SUB },
  // 0.16.0 DX-1: サイドバーのデータベース（🗃️ の行と、その行のメニュー。足した画面。まだ基準が無い）
  { name: 'sidebar-db-light', page: 'app', theme: 'light', get answers() { return sideDbAnswers(); }, act: OPEN_SIDE_DB },
  // 0.16.0 DX-2: ［ゴミ箱］の窓の行のまとまり（「行 題名（データベース名）」・「ほかの行 n」。足した画面。まだ基準が無い）
  { name: 'trash-pop-rows-light', page: 'app', theme: 'light', get answers() { return trashRowsAnswers(); }, act: OPEN_TRASH_ROWS },
  // 0.16.0 DL-1 (2)（R111・R115）: 白紙のページの本文のインラインの表（頭の 🗃️・題名の欄・⤢ と、15 行の高さで中を捲る表。足した画面。まだ基準が無い）
  { name: 'db-inline-light', page: 'app', theme: 'light', get answers() { return inlineAnswers(); }, act: OPEN_PAGE },
  // 0.16.0 DL-1 (2b)（R105・R107・R116）: 白紙のページの本文のリンクドビュー（頭の 🗃️・題名の欄・⤢ と、自分の2つのタブ「表」「担当別」。足した画面。まだ基準が無い）
  { name: 'db-linked-light', page: 'app', theme: 'light', get answers() { return linkedAnswers(); }, act: OPEN_PAGE },
  // 0.16.0 直し（R128）: 設定の近道の表を、見出し「データベースの表のセルを選んでいるとき」まで捲った形（settings-shortcuts-light の下の方で写らない、
  // データベースの表・ビューのタブ・リレーションの窓の行を見せる。足した画面。まだ基準が無い）
  { name: 'settings-shortcuts-db-light', page: 'app', theme: 'light', act: `${OPEN_SETTINGS}; [...document.querySelectorAll('#shortcutRows th')].find((th) => th.textContent === 'データベースの表のセルを選んでいるとき').scrollIntoView({ block: 'start' })` },
  // 0.17.0 PD-2（計画 docs/plans/2026-11-13-170.md の「撮る画面」。アプリの画面のいちばん後ろに足す）: 空の白紙のページ（本文の手引きと、いちばん下の灰色の文と［データベース］）
  { name: 'page-blank-empty-light', page: 'app', theme: 'light', get answers() { return blankEmptyAnswers(); }, act: OPEN_PAGE },
  { name: 'page-blank-empty-dark', page: 'app', theme: 'dark', get answers() { return blankEmptyAnswers(); }, act: OPEN_PAGE },
  // 0.17.0 SV-2（計画 docs/plans/2026-11-13-170.md の「撮る画面」）: サイドバーで開いたデータベースの下のビューの行（3つ。開いたビュー「表」の行に印）
  { name: 'sidebar-db-views-light', page: 'app', theme: 'light', get answers() { return sideViewsAnswers(); }, act: OPEN_SIDE_VIEWS },
  { name: 'sidebar-db-views-dark', page: 'app', theme: 'dark', get answers() { return sideViewsAnswers(); }, act: OPEN_SIDE_VIEWS },
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
// 0.13.1（版を 0.13.1 に上げる commit。Task G）: 持ち主が取り直しの見比べの初めの 8 枚（足した 4 枚: 入れ子の明暗と拡大 200%・トグルの1枚、取り直した 4 枚:
// / メニューの3枚・⠿ の［変換 ▸］の1枚）に「この見た目でよい（おすすめ）」と答え、2026-10-28 に点検の直しの後の画面（▸ を 24px にした形・拡大 200% で文が
// 崩れない形。点検 2 で足した notes-page-zoom200-light を含む 9 枚）に「OK（版を 0.13.1 に上げてよい）」と答えたので、CI run 40623116933（9ede0e7）の
// artifact 12787992574 の .after.png（9 枚）をバイトのまま基準にし、空に戻した
// 0.13.2（版を 0.13.2 に上げる commit。Task G）: 持ち主が取り直しの見比べ（足した 3 枚: 帯 no-login・議事録のページの「残り n 区間」の2枚、取り直した 5 枚:
// 会議の知らせのパネル）に「この見た目でよい（おすすめ）」（2026-10-28）と答えたので、CI run 40796780384（80ea908）の artifact 12864058378 の .after.png（5 枚。閉じたパネルの3枚は今の基準と
// バイトが同じで artifact に出なかったので替えていない）をバイトのまま基準にし、空に戻した（基準は 161 枚）
// 0.14.0（計画 docs/plans/2026-10-26-140.md の「取り直す画面（RETAKE）」）: EB-4 で足した飾りの明暗の2枚と、EB-5 で足した道具の帯・リンクの欄・色のメニューの3枚（まだ基準が無い）。
// EB-5 で ⠿ のメニューに［色 ▸］が増えた edit-block-menu-light（今の基準がある）。EK-4 で足した選んだ行の明暗の2枚（まだ基準が無い）。
// EK-5 で足した設定の近道の表の1枚（まだ基準が無い）と、表で「ホットキー」のカードが伸びる設定の［一般］の3枚（今の基準がある）
// MB-4 で足した保存したページと録音中のページのメモの行の3枚（まだ基準が無い）と、メモの欄が textarea から行になる録音の前のページの3枚・録音中の種類の1枚・
// 保存したページの種類の2枚（今の基準がある。live-ready-light はヘルプの写真の元: R71。基準を替えたら Task G で tools/help-appshots.js を回す）
// DQ-3 で足した設定の「口述の文を AI で整える」の1枚と履歴の［元の文をコピー］の1枚（まだ基準が無い）と、BQ27 (a) で［録音］の「文字起こし」のカードに1行増える
// settings-record の3枚（今の基準がある。settings-record-light はヘルプの写真の元: R71）
// DQ-3 直し（R200）: 同じく［録音］を開く ⓘ の吹き出しの3枚と「会議の検出」の2枚も、項目が伸びて捲り棒のつまみ（stt は吹き出しの下の行）が変わるので取り直す
// 0.14.0（版を 0.14.0 に上げる commit。Task G）: 持ち主が取り直しの見比べ（足した 14 枚: 飾り・道具の帯・リンクの欄・色のメニュー・選んだ行・近道の表・メモの行・
// 「口述の文を AI で整える」・履歴の［元の文をコピー］、取り直した 18 枚: ⠿ のメニュー・設定の［一般］と［録音］・録音の前のページ・種類）に「この見た目でよい（おすすめ）」
// （2026-11-03）と答えたので、CI run 41612673475（036c020）の artifact 13220336274 の .after.png（32 枚）をバイトのまま基準にし、空に戻した（基準は 175 枚）
// 0.15.0（計画 docs/plans/2026-11-03-150.md の「取り直す画面（RETAKE）」）: PH-3 で足したサイドバーの木の明暗と拡大 200% の3枚（まだ基準が無い）
// PH-4 で足した白紙のページの明暗の2枚（まだ基準が無い）と、/ メニューに［ページ］が増える edit-slash-recent-light（今の基準がある）
// PR-2 で足した白紙のページの本文の子ページの行の明暗の2枚（まだ基準が無い）
// PH-5 で足したパンくず・議事録の子ページの一覧・［移動先…］・新しいページの4枚（まだ基準が無い）と、近道の表に行が増える settings-shortcuts-light・
// 「···」に［移動先…］が増える page-menu-link の2枚・計画の表のとおり / メニューの edit-slash-light・edit-slash-dark（今の基準がある）。
// PH-5 直し（R55。CI run 41758331037 の画像）: 近道の表が伸びて「ホットキー」のカードの下が下がり、捲り棒のつまみも変わる設定の［一般］の3枚（今の基準がある）
// 0.15.0（版を 0.15.0 に上げる commit。Task G の後半: R79）: 持ち主が取り直しの見比べ（足した 20 枚: サイドバーの木・白紙のページ・本文の子ページの行・パンくず・
// 議事録の子ページの一覧・［移動先…］・新しいページ・ゴミ箱の窓・アイコンの選び・全幅・小さい文字と書体・「···」の見た目の項目、取り直した 7 枚: 設定の［一般］の3枚と近道の表・
// / メニュー・「···」の2枚）に「0.15.0の画面はこの見た目でよいです」（2026-11-06）と答えたので、CI run 41936731119（622444a）の artifact 13374567273 の .after.png（27 枚。
// edit-slash-light・edit-slash-dark は今の基準とバイトが同じで artifact に出なかったので替えていない）をバイトのまま基準にし、空に戻した（基準は 195 枚）
// 0.15.1 ND-3（計画 docs/plans/2026-11-04-151.md の「取り直す画面（RETAKE）」・D114）: サイドバーの下の［🎤 音声入力］の行が無くなり、［🗑️ ゴミ箱］［⚙️ 設定］が上へ上がるので、
// サイドバーの出ている app の画面の全部（サイドバーを畳んだ notes-collapsed-light のほか。105 枚）を取り直し待ちにした。録音バーと会議の知らせのパネルは変わらない（WQ1）
// 0.15.1（版を 0.15.1 に上げる commit。Task G の後半: R56）: 持ち主が取り直しの見比べ（違いのある画面 105 枚: サイドバーの［🎤 音声入力］の行が無くなり、一覧の見出しが
// 「プライベート」になる・設定の行と ⓘ の吹き出しの文。新しい画面 11 枚: プライベートを畳んだ明暗・［···］のメニュー・もっと見る・拡大 200%・行のメニュー・名前を変える欄・
// ライブラリの4枚）に「この見た目でよい（おすすめ）」（2026-11-10）と答えたので、CI run 42752361720（ba0be5a）の artifact 13733319867 の .after.png（116 枚）を
// バイトのまま基準にし、空に戻した（基準は 203 枚）
// 0.16.0（計画 docs/plans/2026-11-04-160.md の「取り直す画面（RETAKE）」）: DV-1 で足したデータベースの表の明暗と拡大 200% の3枚（まだ基準が無い）と、
// 近道の表に「データベースの表のセルを選んでいるとき」の行が増える設定の4枚（settings-shortcuts-light と［一般］の3枚。今の基準がある）
// DV-2 で足した列のメニュー・選択肢の選び・暦の3枚（まだ基準が無い）
// DV-3 で足したリスト・絞り込みの窓・グループ・ビューのタブ（「他 n 件」とタブのメニュー）の4枚（まだ基準が無い）
// DV-4 で足した行のページ（列の値の並びと本文。まだ基準が無い）
// DR-1 で足したリレーションとサブアイテムの2枚（まだ基準が無い）
// DX-1 で足したサイドバーのデータベース（まだ基準が無い）と、Ctrl+Shift+N の「新しいページ」に［🗃️ データベース］が増える new-pop-light（今の基準がある）
// DX-2 で足した［ゴミ箱］の窓の行のまとまり（まだ基準が無い）
// DL-1 (2) で足した白紙のページの本文のインラインの表（まだ基準が無い）
// DL-1 (2b) で足した白紙のページの本文のリンクドビュー（まだ基準が無い）
// 0.15.1 を出した main の取り込み（R123）: 0.15.1 で足した行の［···］のメニュー side-row-menu-light（main の基準がある）は、0.16.0 の［中にデータベースを作る］が増えるので取り直す
// 0.16.0 直し（R128）: 近道の表をデータベースの行まで捲った settings-shortcuts-db-light（まだ基準が無い）
// 0.16.0（版を 0.16.0 に上げる commit。Task G の後半: R130）: 持ち主が取り直しの見比べ（新しい画面 18 枚: データベースの表の明暗と拡大 200%・列のメニュー・選択肢の選び・暦・
// リスト・絞り込みの窓・グループ・ビューのタブ・行のページ・リレーション・サブアイテム・サイドバーのデータベース・ゴミ箱の行・本文の表・リンクドビュー・近道の表のデータベースの行。
// 違いのある画面 6 枚: 設定の近道の表と［一般］の3枚・Ctrl+Shift+N の新しいページ・行の［···］のメニュー）に「OK」（2026-11-13）と答えたので、
// CI run 43448034019（54ba556）の artifact 14048528391 の .after.png（24 枚）をバイトのまま基準にし、空に戻した（基準は 221 枚）
// 0.17.0 IV-1（計画 docs/plans/2026-11-13-170.md の「取り直す画面（RETAKE）」）: 既定のアイコンが絵文字から線のアイコン（ic:mic・ic:certification_with_seal・
// ic:table_chart）になり、サイドバー・タブ・パンくず・ページの頭のどれかが写るアプリの画面は全部変わる見込み（設定の窓の画面も後ろにサイドバーが写る）。
// 録音バーと会議の知らせのパネルの画面は変わらない（overlay.html は触らない）。基準にするのは Task G の前の1回（IQ12 の答えの手順。持ち主が目で見るのは新しい画面と選びの窓だけ）
const RETAKE_170_APP = SCREENS.filter((s) => s.page === 'app').map((s) => s.name);
const RETAKE = new Set([...RETAKE_170_APP]);
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

/**
 * 0.15.0 PH-3: サイドバーの木（一覧の行に parentId・ord・kind。DB の pages.list と同じ作った新しい順）。p1 の中に白紙のページ2つ、その1つ目の中に
 * 4 段まで続く白紙のページ（どれも開いている）。p2 の中に白紙のページ1つ（閉じている）。開け閉めは uiState の tree
 */
function treeAnswers() {
  const blank = (id, title, at, parentId, ord) => ({ id, title, date: at.slice(0, 10), durationSec: 0, createdAt: at, updatedAt: at, meetingType: '', hasSummary: false, parentId, ord, kind: 'blank' });
  const kids = [
    blank('p2a', '採用の進め方', '2026-10-17T05:00:00.000Z', 'p2', 'i'),
    blank('p1a1a1', '数の根拠', '2026-10-17T04:00:00.000Z', 'p1a1a', 'i'),
    blank('p1a1a', '見積もりの内訳', '2026-10-17T03:00:00.000Z', 'p1a1', 'i'),
    blank('p1a1', '見積もりの下書き', '2026-10-17T02:00:00.000Z', 'p1a', 'i'),
    blank('p1b', '次回の議題', '2026-10-17T01:00:00.000Z', 'p1', 'r'),
    blank('p1a', 'プロジェクトの資料', '2026-10-17T00:00:00.000Z', 'p1', 'i'),
  ];
  return {
    'koeApp.pagesSearch': [...kids, ...LIST.map((p) => ({ ...p, parentId: null, ord: 'i' }))],
    'koeApp.uiState': { tree: { open: ['p1', 'p1a', 'p1a1', 'p1a1a'] } },
  };
}

/** 0.16.0 DX-1: サイドバーの一覧の2つ目にデータベース（kind 'database'）。一覧の答えに行（kind 'row'）が混じっても出さない */
function sideDbAnswers() {
  const at = '2026-10-17T06:00:00.000Z';
  return {
    'koeApp.pagesSearch': [
      { ...LIST[0], parentId: null, ord: 'i' },
      { id: 'pd1', title: '案件の一覧', date: '2026-10-17', durationSec: 0, createdAt: at, updatedAt: at, meetingType: '', hasSummary: false, parentId: null, ord: 'i', kind: 'database' },
      { id: 'rx1', title: '見積もりの作成 1', date: '2026-10-17', createdAt: at, updatedAt: at, parentId: 'pd1', ord: 'a', kind: 'row', db: 'pd1' },
      ...LIST.slice(1).map((p) => ({ ...p, parentId: null, ord: 'i' })),
    ],
  };
}

/**
 * 0.16.0 DV-1: データベースのページ（一覧のいちばん上。page:get の答えは kind 'database'）。列は 名前（題名）・担当（ユーザー）・状態（ステータス）・
 * 金額（数値の円）・期日（日付）・済み（チェック）・資料（URL）の7種類。表の読み（db.view）は 20 行と下の集計（全件・合計・チェック済みの割合）
 */
// 0.16.0 DV-3: kind で見本のビューを替える（list: リスト・filter: 入れ子の絞り込み・group: ステータスでまとめる・views: タブ 12 個）
// 0.16.0 DV-4: row は 1行目（r1）の行のページの page.get の答えも（「koeApp.pageGet:r1」。本文は見本の3行）
function dbAnswers(kind = '') {
  const at = '2026-10-17T00:00:00.000Z';
  const page = { id: 'pd1', kind: 'database', title: '案件の一覧', date: '2026-10-17', memo: '', createdAt: at, updatedAt: at, blocks: [] };
  const cols = [
    { id: 'title', name: '名前', type: 'title' },
    { id: 'c1', name: '担当', type: 'person' },
    { id: 'c2', name: '状態', type: 'status', opts: [{ id: 'o1', name: '未着手', color: 'default' }, { id: 'o2', name: '進行中', color: 'blue' }, { id: 'o3', name: '完了', color: 'green' }],
      groups: { todo: ['o1'], doing: ['o2'], done: ['o3'] } },
    { id: 'c3', name: '金額', type: 'number', fmt: 'yen' },
    { id: 'c4', name: '期日', type: 'date' },
    { id: 'c5', name: '済み', type: 'check' },
    { id: 'c6', name: '資料', type: 'url' },
  ];
  // 0.16.0 DR-1: リレーション（取引先のデータベースへ）・サブアイテム（親アイテム・サブアイテムの列）
  if (kind === 'relation') cols.splice(1, 0, { id: 'c7', name: '取引先', type: 'rel', db: 'pd2' });
  if (kind === 'sub') cols.push({ id: 'c8', name: '親アイテム', type: 'rel', db: 'pd1', back: 'c9' }, { id: 'c9', name: 'サブアイテム', type: 'rel', db: 'pd1', back: 'c8' });
  const view = { id: 'v1', name: '表', layout: 'table', props: cols.map((c) => ({ col: c.id, show: true, wrap: false })), sort: [], filter: null, group: null,
    agg: { title: 'count', c3: 'sum', c5: 'checkedPct' } };
  if (kind === 'list') Object.assign(view, { name: '一覧', layout: 'list', props: cols.map((c) => ({ col: c.id, show: ['title', 'c1', 'c2', 'c4'].includes(c.id), wrap: false })), agg: {} });
  if (kind === 'filter') view.filter = { op: 'and', items: [{ col: 'c2', cmp: 'any', value: ['o1', 'o2'] }, { op: 'or', items: [{ col: 'c3', cmp: 'gt', value: 20000 }, { col: 'c5', cmp: 'yes' }] }] };
  if (kind === 'group') view.group = { col: 'c2' };
  const views = kind === 'views' ? [view, ...['今週のうちに終わらせたい見積もりと発注と検収のまとめ', '担当別', '完了したもの', '金額の大きい順', '来月の期日', '資料のあるもの', 'リスト', '未着手', '進行中', '確認待ち', '保留'].map((name, i) => ({ ...view, id: `v${i + 2}`, name }))] : [view];
  const NAMES = ['見積もりの作成', '発注書の確認', '検収の段取り', '請求書の発行', '打ち合わせの準備'];
  const WHO = ['佐藤', '鈴木', '高橋'];
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: `r${i + 1}`, ord: `a${String(i).padStart(2, '0')}`, title: `${NAMES[i % 5]} ${i + 1}`, createdAt: at, updatedAt: at, by: { c: 'me', u: 'me' }, no: i + 1,
    cells: { c1: [WHO[i % 3]], c2: ['o1', 'o2', 'o3'][i % 3], c3: 12000 + i * 1500, c4: { start: `2026-11-${String(4 + (i % 20)).padStart(2, '0')}` },
      ...(i % 3 === 2 ? { c5: true } : {}), ...(i % 4 === 0 ? { c6: `https://example.com/doc/${i + 1}` } : {}) },
    depth: 0, hasKids: false,
  }));
  const PARTNERS = { rb1: { title: '北の工務店' }, rb2: { title: '南の印刷所' }, rb3: { title: '東の運送' } };
  if (kind === 'relation') rows.forEach((r, i) => { r.cells.c7 = [['rb1'], ['rb2', 'rb3'], ['rb3'], []][i % 4]; if (!r.cells.c7.length) delete r.cells.c7; });
  // サブアイテム: r1 の子は r2・r3（r3 の子は r4）、r5 の子は r6。開いた r1・r3 の子を段を下げて並べる（r5 は閉じている）
  let subRows = null;
  if (kind === 'sub') {
    const par = { r2: 'r1', r3: 'r1', r4: 'r3', r6: 'r5' };
    for (const r of rows) { if (par[r.id]) r.cells.c8 = [par[r.id]]; const ks = Object.keys(par).filter((k) => par[k] === r.id); if (ks.length) r.cells.c9 = ks; }
    const at2 = (id, depth, hasKids) => ({ ...rows.find((r) => r.id === id), depth, hasKids });
    subRows = [at2('r1', 0, true), at2('r2', 1, false), at2('r3', 1, true), at2('r4', 2, false), at2('r5', 0, true), ...rows.slice(6).map((r) => ({ ...r }))];
  }
  const sum = rows.reduce((n, r) => n + r.cells.c3, 0);
  // グループ: ステータスの3つのまとまりの順に並べ、g にまとまりの番号
  const grouped = kind === 'group' ? [0, 1, 2].flatMap((g) => rows.filter((r) => r.cells.c2 === `o${g + 1}`).map((r) => ({ ...r, g }))) : rows;
  const groups = kind === 'group' ? ['todo', 'doing', 'done'].map((key, g) => ({ key, count: rows.filter((r) => r.cells.c2 === `o${g + 1}`).length })) : null;
  const row = { id: 'pd1', title: page.title, date: page.date, durationSec: 0, createdAt: at, updatedAt: at, meetingType: '', hasSummary: false, parentId: null, ord: 'i', kind: 'database' };
  return {
    'koeApp.pagesSearch': [row, ...LIST.map((p) => ({ ...p, parentId: null, ord: 'i' }))], 'koeApp.pageGet': { page, segments: [] },
    'koeApp.dbGet': { id: 'pd1', title: page.title, cols, views, rowCount: 20, ...(kind === 'sub' ? { sub: { parent: 'c8', kids: 'c9' } } : {}) },
    'koeApp.dbView': { total: 20, shown: subRows ? subRows.length : 20, rows: subRows || grouped, groups, agg: { title: 20, c3: sum, c5: (rows.filter((r) => r.cells.c5).length / 20) * 100 },
      ...(kind === 'relation' ? { rel: PARTNERS } : kind === 'sub' ? { rel: Object.fromEntries(rows.map((r) => [r.id, { title: r.title }])) } : {}), sig: '1.20.shots' },
    ...(kind === 'relation' ? { 'koeApp.relFind': { rows: Object.entries(PARTNERS).map(([id, r]) => ({ id, ...r })), total: 3 } } : {}),
    ...(kind === 'row' ? { 'koeApp.pageGet:r1': { db: 'pd1', segments: [], page: { id: 'r1', title: rows[0].title, cells: rows[0].cells, by: rows[0].by, no: 1, createdAt: at, updatedAt: at, blocks: [
      { id: 'q1', type: 'heading', level: 2, text: '進め方', citeState: 'manual', cites: [] },
      { id: 'q2', type: 'todo', text: '先方に単価を確かめる', checked: false, citeState: 'manual', cites: [] },
      { id: 'q3', type: 'paragraph', text: '前回の見積もりとの差を書き足す。', citeState: 'manual', cites: [] },
    ] } } } : {}),
  };
}

/**
 * 0.15.1 PS-2（D124）: 表示 5 と［もっと見る］。いちばん上に8つのページ（見本の議事録3つと白紙のページ5つ）。表示の数は uiState の sections（覚えた形）
 */
function moreAnswers() {
  const blank = (id, title, at) => ({ id, title, date: at.slice(0, 10), durationSec: 0, createdAt: at, updatedAt: at, meetingType: '', hasSummary: false, parentId: null, ord: 'i', kind: 'blank' });
  const tops = [
    blank('pm5', '採用の進め方', '2026-10-17T05:00:00.000Z'),
    blank('pm4', '見積もりの内訳', '2026-10-17T04:00:00.000Z'),
    blank('pm3', '次回の議題', '2026-10-17T03:00:00.000Z'),
    blank('pm2', 'プロジェクトの資料', '2026-10-17T02:00:00.000Z'),
    blank('pm1', '数の根拠', '2026-10-17T01:00:00.000Z'),
  ];
  return {
    'koeApp.pagesSearch': [...tops, ...LIST.map((p) => ({ ...p, parentId: null, ord: 'i' }))],
    'koeApp.uiState': { sections: { private: { open: true, sort: 'manual', show: 5 } } },
  };
}

/** 0.15.0 PH-4: 白紙のページ（一覧のいちばん上。page:get の答えは kind 'blank'・題名・本文の行だけ。出典・会議の種類・長さ・文字起こしは無い） */
function blankAnswers() {
  const at = '2026-10-17T00:00:00.000Z';
  const page = { id: 'pb1', kind: 'blank', title: 'プロジェクトの資料', date: '2026-10-17', memo: '', createdAt: at, updatedAt: at, blocks: [
    { id: 'q1', type: 'heading', level: 2, text: '目的', citeState: 'manual', cites: [] },
    { id: 'q2', type: 'bullet', text: '見積もりを出す日を決める。', citeState: 'manual', cites: [] },
    { id: 'q3', type: 'bullet', text: '予算は先月の案のまま進める。', citeState: 'manual', cites: [] },
    { id: 'q4', type: 'heading', level: 2, text: '進め方', citeState: 'manual', cites: [] },
    { id: 'q5', type: 'todo', text: '案を送る', checked: false, citeState: 'manual', cites: [] },
    { id: 'q6', type: 'paragraph', text: '次の打ち合わせで決まったことを書き足す。', citeState: 'manual', cites: [] },
  ] };
  const row = { id: 'pb1', title: page.title, date: page.date, durationSec: 0, createdAt: at, updatedAt: at, meetingType: '', hasSummary: true, parentId: null, ord: 'i', kind: 'blank' };
  return { 'koeApp.pagesSearch': [row, ...LIST.map((p) => ({ ...p, parentId: null, ord: 'i' }))], 'koeApp.pageGet': { page, segments: [] } };
}

/** 0.17.0 SV-2: データベースのページ（dbAnswers）にビューを3つ（表・一覧・担当別）。一覧の行にもその3つ（pages.list の views） */
function sideViewsAnswers() {
  const a = dbAnswers();
  const g = a['koeApp.dbGet'];
  const v1 = g.views[0];
  const views = [v1, { ...v1, id: 'v2', name: '一覧', layout: 'list' }, { ...v1, id: 'v3', name: '担当別' }];
  const list = a['koeApp.pagesSearch'].map((p) => (p.id === 'pd1' ? { ...p, views: views.map((v) => ({ id: v.id, name: v.name, type: v.layout })) } : p));
  return { ...a, 'koeApp.pagesSearch': list, 'koeApp.dbGet': { ...g, views } };
}

/** 0.17.0 PD-2: 一覧のいちばん上の、本文が空の白紙のページ pe1（題名だけ） */
function blankEmptyAnswers() {
  const at = '2026-10-17T00:00:00.000Z';
  const page = { id: 'pe1', kind: 'blank', title: '新しい案', date: '2026-10-17', memo: '', createdAt: at, updatedAt: at, blocks: [] };
  const row = { id: 'pe1', title: page.title, date: page.date, durationSec: 0, createdAt: at, updatedAt: at, meetingType: '', hasSummary: false, parentId: null, ord: 'i', kind: 'blank' };
  return { 'koeApp.pagesSearch': [row, ...LIST.map((p) => ({ ...p, parentId: null, ord: 'i' }))], 'koeApp.pageGet': { page, segments: [] } };
}

/**
 * 0.16.0 DL-1 (2)（R111）: 白紙のページの本文のインラインの表（一覧のいちばん上の白紙のページ pi1。行 s1 は子のデータベース pd1 を指す inline: true の
 * 子ページの行。表の答えは dbAnswers の「案件の一覧」の 20 行で、表は 15 行の高さで中を捲る）
 */
function inlineAnswers() {
  const at = '2026-10-17T00:00:00.000Z';
  const m = { citeState: 'manual', cites: [] };
  const d = dbAnswers();
  const page = { id: 'pi1', kind: 'blank', title: '案件のまとめ', date: '2026-10-17', memo: '', createdAt: at, updatedAt: at, blocks: [
    { id: 'q1', type: 'heading', level: 2, text: '今月の案件', ...m },
    { id: 's1', type: 'subpage', text: '', page: 'pd1', inline: true },
    { id: 'q2', type: 'paragraph', text: '金額の大きい案件から先に進める。', ...m },
  ] };
  const row = { id: 'pi1', title: page.title, date: page.date, durationSec: 0, createdAt: at, updatedAt: at, meetingType: '', hasSummary: true, parentId: null, ord: 'i', kind: 'blank' };
  const dbRow = { ...d['koeApp.pagesSearch'][0], parentId: 'pi1', ord: 'a' };
  return { ...d, 'koeApp.pagesSearch': [row, dbRow, ...LIST.map((p) => ({ ...p, parentId: null, ord: 'i' }))], 'koeApp.pageGet': { page, segments: [] } };
}

/**
 * 0.16.0 DL-1 (2b)（R105・R116）: 白紙のページの本文のリンクドビュー（一覧のいちばん上の白紙のページ pi1。行 s1 は最上位のデータベース pd1 を見せる dbview の行で、
 * 自分のビューの並び「表」「担当別」を持つ。表の答えは dbAnswers の「案件の一覧」の 20 行）
 */
function linkedAnswers() {
  const at = '2026-10-17T00:00:00.000Z';
  const m = { citeState: 'manual', cites: [] };
  const d = dbAnswers();
  const v1 = d['koeApp.dbGet'].views[0];
  const views = [v1, { ...v1, id: 'v2', name: '担当別', sort: [{ col: 'c1', dir: 'asc' }] }];
  const page = { id: 'pi1', kind: 'blank', title: '今週の進み具合', date: '2026-10-17', memo: '', createdAt: at, updatedAt: at, blocks: [
    { id: 'q1', type: 'heading', level: 2, text: '担当ごとの案件', ...m },
    { id: 's1', type: 'dbview', text: '', db: 'pd1', views },
    { id: 'q2', type: 'paragraph', text: '金曜の打ち合わせで進み具合を確かめる。', ...m },
  ] };
  const row = { id: 'pi1', title: page.title, date: page.date, durationSec: 0, createdAt: at, updatedAt: at, meetingType: '', hasSummary: true, parentId: null, ord: 'i', kind: 'blank' };
  const dbRow = { ...d['koeApp.pagesSearch'][0], ord: 'j' };
  return { ...d, 'koeApp.dbGet': { ...d['koeApp.dbGet'], views }, 'koeApp.pagesSearch': [row, dbRow, ...LIST.map((p) => ({ ...p, parentId: null, ord: 'i' }))], 'koeApp.pageGet': { page, segments: [] } };
}

/**
 * 0.15.0 PR-2: 白紙のページの本文の子ページの行（一覧のいちばん上の白紙のページ pr1。子は pk1〜pk4 で、pk4 は本文に行の無い子。
 * 行 s9 は今の子でないページ pzz を指す灰色の行。行の文 text は空で、画面が一覧の題名から描く）
 */
function rowsAnswers() {
  const at = '2026-10-17T00:00:00.000Z';
  const m = { citeState: 'manual', cites: [] };
  const page = { id: 'pr1', kind: 'blank', title: '計画のまとめ', date: '2026-10-17', memo: '', createdAt: at, updatedAt: at, blocks: [
    { id: 'q1', type: 'heading', level: 2, text: '目的', ...m },
    { id: 'q2', type: 'bullet', text: '見積もりを出す日を決める。', ...m },
    { id: 's1', type: 'subpage', text: '', page: 'pk1' },
    { id: 'q3', type: 'bullet', text: '予算は先月の案のまま進める。', ...m },
    { id: 's2', type: 'subpage', text: '', page: 'pk2' },
    { id: 'q4', type: 'heading', level: 2, text: '資料', ...m },
    { id: 't1', type: 'toggle', text: '取引先ごとの資料', ...m, children: [{ id: 's3', type: 'subpage', text: '', page: 'pk3' }] },
    { id: 's9', type: 'subpage', text: '', page: 'pzz' },
    { id: 'q5', type: 'paragraph', text: '次の打ち合わせで決まったことを書き足す。', ...m },
  ] };
  const row = (id, title, ord, parentId) => ({ id, title, date: page.date, durationSec: 0, createdAt: at, updatedAt: at, meetingType: '', hasSummary: true, parentId, ord, kind: 'blank' });
  const kids = [row('pk1', '週の予定', 'i', 'pr1'), row('pk2', '見積もりの内訳', 'r', 'pr1'), row('pk3', '取引先の一覧', 't', 'pr1'), row('pk4', '前の版で行を消した子', 'v', 'pr1')];
  return { 'koeApp.pagesSearch': [row('pr1', page.title, 'i', null), ...kids, ...LIST.map((p) => ({ ...p, parentId: null, ord: 'i' }))], 'koeApp.pageGet': { page, segments: [] } };
}

/** 0.15.0 PH-5: 6 段の白紙のページの木（d0〜d5。祖先の行は開いた覚え書き）。開く d5 の page:get は白紙のページ */
function deepAnswers() {
  const at = (h) => `2026-10-17T0${h}:00:00.000Z`;
  const titles = ['プロジェクトの資料', '見積もり', '見積もりの下書き', '見積もりの内訳', '数の根拠', '根拠の出どころ'];
  const rows = titles.map((title, i) => ({ id: `d${i}`, title, date: '2026-10-17', durationSec: 0, createdAt: at(i), updatedAt: at(i), meetingType: '', hasSummary: true,
    parentId: i ? `d${i - 1}` : null, ord: 'i', kind: 'blank' }));
  const page = { id: 'd5', kind: 'blank', title: titles[5], date: '2026-10-17', memo: '', createdAt: at(5), updatedAt: at(5), blocks: [
    { id: 'q1', type: 'paragraph', text: '見積もりの数の出どころを書き足す。', citeState: 'manual', cites: [] },
  ] };
  return {
    'koeApp.pagesSearch': [...rows.slice().reverse(), ...LIST.map((p) => ({ ...p, parentId: null, ord: 'i' }))],
    'koeApp.uiState': { tree: { open: ['d0', 'd1', 'd2', 'd3', 'd4'] } },
    'koeApp.pageGet': { page, segments: [] },
  };
}

/** 0.15.0 PH-5: 議事録 p1（見本のページ）の中に白紙のページ2つと議事録1つ（並びの鍵の順） */
function kidsAnswers() {
  const at = '2026-10-17T00:00:00.000Z';
  const kid = (id, title, ord, kind) => ({ id, title, date: '2026-10-17', durationSec: kind ? 0 : 900, createdAt: at, updatedAt: at, meetingType: kind ? '' : 'general', hasSummary: true,
    parentId: 'p1', ord, ...(kind ? { kind } : {}) });
  return {
    'koeApp.pagesSearch': [kid('pk1', '決まったことの続き', 'i', 'blank'), kid('pk2', '見積もりの内訳', 'r', 'blank'), kid('pk3', lib.meetingTitleAt('2026-10-17T00:00:00.000Z', JST_MIN), 'v', ''),
      ...LIST.map((p) => ({ ...p, parentId: null, ord: 'i' }))],
    'koeApp.uiState': { tree: { open: ['p1'] } },
  };
}

/** 0.15.0 PH-5: サイドバーの木（treeAnswers と同じ）で、開く p2 の page:get は p2（見本のページの中身） */
function moveAnswers() {
  const a = treeAnswers();
  const page = fixtures()['koeApp.pageGet'].page;
  const p2 = LIST[1];
  return { ...a, 'koeApp.pageGet': { page: { ...page, id: p2.id, title: p2.title, date: p2.date, createdAt: p2.createdAt, durationSec: p2.durationSec }, segments: SEGMENTS } };
}

/** 0.15.0 PL-3: 見本のページ（一覧の1行目の page:get）に見た目 look を付けた答え */
function lookAnswers(look) {
  const a = fixtures()['koeApp.pageGet'];
  return { 'koeApp.pageGet': { ...a, page: { ...a.page, look } } };
}

/** 0.15.0 PH-6: ゴミ箱の頭の行（DB の pages.trash の形。消した新しい順。白紙のページは中のページ 3 つと一緒に・議事録は1つで） */
function trashAnswers() {
  return { 'koeApp.pagesTrash': [
    { id: 'pt1', title: '去年の計画', kind: 'blank', trashedAt: '2026-10-17T05:10:00.000Z', count: 3 },
    { id: 'pt2', title: lib.meetingTitleAt('2026-10-02T01:00:00.000Z', JST_MIN), trashedAt: '2026-10-16T08:30:00.000Z', count: 0 },
  ] };
}

/** 0.16.0 DX-2: ゴミ箱の頭に行のまとまり（DB の pages.trash の形。行は kind 'row' と db・dbTitle・count はほかの行の数）と、白紙のページ・議事録 */
function trashRowsAnswers() {
  return { 'koeApp.pagesTrash': [
    { id: 'rt1', title: '見積もりの作成 3', kind: 'row', db: 'pd1', dbTitle: '案件の一覧', trashedAt: '2026-10-17T06:20:00.000Z', count: 2 },
    { id: 'rt4', title: '検収の段取り 9', kind: 'row', db: 'pd1', dbTitle: '案件の一覧', trashedAt: '2026-10-17T06:00:00.000Z', count: 0 },
    ...trashAnswers()['koeApp.pagesTrash'],
  ] };
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
// 0.14.0 MB-4: メモの行（商談の雛形の見出し3に、箇条書き・太字・色・ToDo を書いた形。memo は memoPlain から: 決めたこと 59）
function memoRowsDoc() {
  const r = (t, ...m) => ({ t, m });
  const doc = memoDoc.memoFromText(memoTypes.memoPreset('bantc'));
  const heads = doc.filter((b) => b.type === 'heading');
  let n = 100;
  const row = (type, rich, o = {}) => ({ id: `m${(n++).toString(36)}`, type, text: rich.map((x) => x.t).join(''), rich, citeState: 'manual', ...o });
  const out = [];
  for (const h of heads) {
    out.push(h);
    if (out.length === 1) out.push(row('bullet', [r('年間の予算は'), r('800万円', 'b'), r('の見込み')]), row('bullet', [r('稟議は'), r('来月の役員会', ['color', 'red']), r('で通す')]));
    else if (out.length === 4) out.push(row('todo', [r('決裁者を先方に確かめる')], { checked: false }), row('paragraph', [r('購買部の'), r('担当者', ['bg', 'yellow']), r('も同席する')]));
  }
  return out;
}
function memoBlocksAnswers() {
  const page = fixtures()['koeApp.pageGet'].page;
  const doc = memoRowsDoc();
  return { 'koeApp.pageGet': { page: { ...page, meetingType: 'sales', typeAuto: false, autoType: 'sales', memo: memoDoc.memoPlain(doc), memoDoc: doc }, segments: SEGMENTS } };
}
function liveMemoAnswers() {
  const a = liveAnswers();
  const doc = memoRowsDoc();
  a['koeApp.meetingStatus'] = { ...a['koeApp.meetingStatus'], memo: memoDoc.memoPlain(doc), memoDoc: doc, meetingType: 'sales' };
  return a;
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
    // 2026-10-28 の点検 2（計画の Ruling NR46）: 段 0 の ToDo（担当・期限の札つき）も拡大 200% で文が細くならないかを見る
    m('n0', 'todo', '見積書を月末までに先方へ送る', { checked: false, assignee: '佐藤', due: '2026-10-31', dueRaw: '月末' }),
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
// 0.14.0 EB-4（決めたこと 14・17・21）: 飾りの行（太字・斜体・下線・取り消し線・コード・リンクと、文字の色・背景の色の9色ずつ）
function marksAnswers() {
  const page = fixtures()['koeApp.pageGet'].page;
  const COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
  const NAMES = ['灰', '茶', '橙', '黄', '緑', '青', '紫', '桃', '赤'];
  const r = (t, ...m) => ({ t, m });
  const m = (id, type, rich, o = {}) => ({ id, type, text: rich.map((x) => x.t).join(''), rich, citeState: 'manual', cites: [], ...o });
  const join = (kind) => COLORS.flatMap((c, i) => [r(NAMES[i], [kind, c]), ...(i < COLORS.length - 1 ? [r(' ')] : [])]);
  const blocks = [
    m('k1', 'heading', [r('飾りの'), r('見本', 'b')], { level: 2 }),
    m('k2', 'bullet', [r('太字', 'b'), r('・'), r('斜体', 'i'), r('・'), r('下線', 'u'), r('・'), r('取り消し線', 's'), r('・'), r('コード', 'code'), r('・'), r('リンク', ['link', 'https://example.com/'])]),
    m('k3', 'bullet', [r('太字の斜体', 'b', 'i'), r(' と '), r('下線の取り消し線', 'u', 's'), r(' と '), r('太字のリンク', 'b', ['link', 'https://example.com/'])]),
    m('k4', 'paragraph', [r('文字の色: '), ...join('color')]),
    m('k5', 'paragraph', [r('背景の色: '), ...join('bg')]),
    m('k6', 'todo', [r('見積もりを'), r('金曜まで', 'b', ['color', 'red']), r('に送る')], { checked: false }),
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

// 0.16.0 の CI 直し（R110）: 描き終わりの待ちの自己点検。画面の全部を覆う層に、塗るのに時間のかかる影（box-shadow と text-shadow）を
// たくさん重ねて見せる（手元の Linux の画面の外の窓で 300 個は約 1 秒。待ちを外すと、2回の requestAnimationFrame と 300 ミリ秒の後に撮っても
// 前の絵のままだった）。撮る道具だけが使い、製品の画面には無い
const PAINT_PROBE = `(() => {
  const box = document.createElement('div');
  box.id = 'shotsPaintProbe';
  box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#c00;overflow:hidden';
  for (let i = 0; i < 300; i++) {
    const d = document.createElement('span');
    d.textContent = 'あ😀';
    d.style.cssText = 'position:absolute;left:' + ((i * 37) % 1000) + 'px;top:' + ((i * 53) % 700) + 'px;font-size:60px;' +
      'text-shadow:0 0 90px #00f,0 0 70px #0f0,0 0 50px #ff0;box-shadow:0 0 150px 40px rgba(0,0,' + (i % 255) + ',.3)';
    box.appendChild(d);
  }
  document.body.appendChild(box);
  return 1;
})()`;

/** 描き終わりの待ちの自己点検の判定。PAINT_PROBE の後の絵が前の絵と半分以上違えば OK（同じなら古い枠を写した） */
function judgePaintWait(before, after, png) {
  if (!before || !after) return { ok: false, note: '撮れなかった' };
  const d = png.diffImages(before, after, { tolerance: 0 });
  if (d.sizeMismatch) return { ok: false, note: '前と後の大きさが違う' };
  const half = Math.ceil((before.width * before.height) / 2);
  if (d.count >= half) return { ok: true, note: `描くのに時間のかかる変化の後の絵を撮れた（${d.count} 画素が前と違う）` };
  return { ok: false, note: `変化の前の古い枠を撮った（前と違うのは ${d.count} 画素。半分の ${half} に届かない）` };
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
    out.push({ name, status: d.sizeMismatch ? 'size' : 'diff', count: d.count, box: d.box, regions: diffRegions(base, shot, { tolerance }) });   // 0.15.1 ND-5（WQ8）
  }
  return out;
}

/**
 * 0.15.1 ND-5（計画 docs/plans/2026-11-04-151.md の WQ8）: 基準と今の画像の違いの場所の枠。色の差が tolerance を越える画素を、cell 画素の升目に
 * 落として 8 方向につながった升の塊ごとにまとめ、塊の中の違う画素をちょうど囲む → [{ x0, y0, x1, y1 }]（上から・左から）。同じなら空。
 * 大きさが違えば画像の全部の1つ。升目でまとめるので、cell より近い違いは1つの枠になる（字の1つずつに枠を作らない）
 */
function diffRegions(a, b, { tolerance = TOLERANCE, cell = 8 } = {}) {
  if (a.width !== b.width || a.height !== b.height) return [{ x0: 0, y0: 0, x1: Math.max(a.width, b.width) - 1, y1: Math.max(a.height, b.height) - 1 }];
  const { width: w, height: h } = a;
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const cells = new Array(cw * ch).fill(null);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let differs = false;
      for (let k = 0; k < 4; k++) if (Math.abs(a.data[i + k] - b.data[i + k]) > tolerance) { differs = true; break; }
      if (!differs) continue;
      const c = Math.floor(y / cell) * cw + Math.floor(x / cell);
      const r = cells[c];
      if (!r) cells[c] = { x0: x, y0: y, x1: x, y1: y };
      else { r.x0 = Math.min(r.x0, x); r.y0 = Math.min(r.y0, y); r.x1 = Math.max(r.x1, x); r.y1 = Math.max(r.y1, y); }
    }
  }
  const seen = new Uint8Array(cw * ch);
  const out = [];
  for (let c = 0; c < cells.length; c++) {
    if (!cells[c] || seen[c]) continue;
    seen[c] = 1;
    const box = { ...cells[c] };
    const stack = [c];
    while (stack.length) {
      const q = stack.pop();
      const cx = q % cw;
      const cy = Math.floor(q / cw);
      const r = cells[q];
      box.x0 = Math.min(box.x0, r.x0); box.y0 = Math.min(box.y0, r.y0); box.x1 = Math.max(box.x1, r.x1); box.y1 = Math.max(box.y1, r.y1);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const n = ny * cw + nx;
          if (cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    out.push(box);
  }
  return out.sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
}
/** 枠の全部が、どれかの場所の中にあるか（場所の外に1画素でもはみ出せば偽。枠が無ければ真） */
function onlyIn(regions, areas) {
  return (regions || []).every((r) => (areas || []).some((a) => r.x0 >= a.x0 && r.y0 >= a.y0 && r.x1 <= a.x1 && r.y1 <= a.y1));
}
// サイドバーの所（既定の幅 260px と幅のつまみ 4px。拡大率を掛ける）。0.15.1 の取り直し（音声入力の行・見出しの行）はここに出る見込み
const SIDE_AREA_PX = 264;
function sideArea(zoom = 1) {
  return { x0: 0, y0: 0, x1: Math.round(SIDE_AREA_PX * (Number(zoom) || 1)) - 1, y1: SIZE.height - 1 };
}
/**
 * 取り直し待ちの画面ごとの違いの場所の一覧（CI の成果物 retake-regions.json の中身）: [{ name, status, count, regions, onlySide }]。
 * onlySide はサイドバーの所だけが違うか（基準と同じ画面は書かない。基準の無い画面・大きさの違う画面は偽 = 画像で見てもらう）
 * 0.15.1 Task G の後半（R56）で意図して変えた: 取り直し待ちの一覧を引数でも渡せる（既定は RETAKE。取り直し待ちを空に戻した後も、テストが決まった一覧で形を見られるように）
 */
function retakeReport(compare, retake = RETAKE) {
  const zoomOf = (n) => (SCREENS.find((s) => s.name === n) || {}).zoom || 1;
  return (compare || []).filter((c) => retake.has(c.name) && c.status !== 'same').map((c) => ({
    name: c.name, status: c.status, count: c.count || 0, regions: c.regions || [],
    onlySide: c.status === 'diff' && onlyIn(c.regions || [], [sideArea(zoomOf(c.name))]),
  }));
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
 * 0.16.0 直し（R128）: cut は、データベースの浮く箱（.dbmenu・.dbpick。列のメニュー・ビューの設定の窓・セルの選びの窓）のうち、窓か中を切る祖先
 *（捲る枠は捲り棒を除いた内側・content-visibility: auto・contain の paint は枠）の端を越えて切れているもの（取り直しの画面で、捲る枠に切られた列のメニューを見逃した）
 * 0.16.0 直し（R129。rv57 軽い 6）: 切るのは軸ごと（overflow-x だけが clip なら横だけ）。描くのを省く枠と clip は overflow-clip-margin の分だけ外まで描く（捲る枠は使わない）
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
  const cut = [];
  const POP = '.dbmenu, .dbpick';
  const H = window.innerHeight;
  for (const e of document.querySelectorAll(POP)) {
    if (typeof e.matches !== 'function' || !e.matches(POP)) continue;
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const st = cs(e);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    let L = 0, T = 0, R = W, B = H;
    for (let p = e.parentElement; p && p !== document.body && p !== de; p = p.parentElement) {
      const ps = cs(p);
      const paint = ps.contentVisibility === 'auto' || /paint|strict|content/.test(String(ps.contain || ''));
      const cx = paint || ps.overflowX !== 'visible', cy = paint || ps.overflowY !== 'visible';
      if (!cx && !cy) continue;
      const m = parseFloat(ps.overflowClipMargin) || 0;
      const mx = ps.overflowX === 'visible' || ps.overflowX === 'clip' ? m : 0, my = ps.overflowY === 'visible' || ps.overflowY === 'clip' ? m : 0;
      const pr = p.getBoundingClientRect();
      const l = pr.left + (p.clientLeft || 0), t = pr.top + (p.clientTop || 0);
      if (cx) { L = Math.max(L, l - mx); R = Math.min(R, l + (p.clientWidth || pr.width) + mx); }
      if (cy) { T = Math.max(T, t - my); B = Math.min(B, t + (p.clientHeight || pr.height) + my); }
    }
    if ((r.left < L - 0.5 || r.top < T - 0.5 || r.right > R + 0.5 || r.bottom > B + 0.5) && cut.length < 10) cut.push(label(e));
  }
  return { sw: de.scrollWidth, cw: de.clientWidth, iw: W, offenders, cut };
})()`;

/**
 * OVERFLOW_PROBE の結果 → { ok, note }。ページが横に流れる（scrollWidth > clientWidth）か、窓の外へ出た要素があれば NG。計れなければ NG。
 * 0.16.0 直し（R128）: データベースの浮く箱（.dbmenu・.dbpick）が窓か中を切る祖先の端で切れていれば（cut）NG（前の形の cut の無い答えは切れ 0 と読む）
 */
function judgeOverflow(r) {
  if (!r || !Number.isFinite(r.sw) || !Number.isFinite(r.cw) || !r.offenders) return { ok: false, note: 'はみ出しを計れなかった' };
  const list = Array.from(r.offenders);
  const cut = Array.from(r.cut || []);
  if (r.sw <= r.cw && list.length === 0 && cut.length === 0) return { ok: true, note: `はみ出し 0（幅 ${r.cw}）` };
  if (r.sw <= r.cw && list.length === 0) return { ok: false, note: `浮く箱が窓か捲る枠の端で切れる（${cut.join(' ')}）` };
  return { ok: false, note: `横にはみ出す（scrollWidth ${r.sw} > clientWidth ${r.cw}${list.length ? `・窓の外: ${list.join(' ')}` : ''}${cut.length ? `・切れる浮く箱: ${cut.join(' ')}` : ''}）` };
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
  diffRegions, onlyIn, sideArea, retakeReport,   // 0.15.1 ND-5（WQ8）
  SIZE, OVERLAY_SIZE, SHOT_AREA, SCREENS, RETAKE, PERF, FIXED_NOW, TIME_ZONE, TOLERANCE, FREEZE_CSS, OVERFLOW_PROBE,
  WAVE_SPEECH, NUDGE_SIZE, NUDGE_PROBE, nudgeWindowFor, detectAnswers,
  PANEL_PROBE, PANEL_PROBE_SCALES, PANEL_PROBE_STATES, judgePanel, panelWindowFor, shotSizeFor, watchdogMs,
  apiNamesOf, fixtures, liveAnswers, bigPage, bigListEntry, judgePair, PAINT_PROBE, judgePaintWait, compareAll, cspViolation, median, judgePerf, judgeOverflow, judgeFocus, judgeZoom,
  exitCodeOf, ensureContentSize,
};
