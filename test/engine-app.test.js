/*
 * engine-app.test.js — 画面: エンジンのカードの取り込みの欄（第0b回 Task 15・R7-10）
 *
 * 取り込む前に「何を・どこから・どれだけ・どこへ・どれくらいの時間」を見せ、利用者が押してから取り込む。
 * 進み具合と失敗を、詳細設定を開かずに見られるようにする。未設定のときに連れて行く先（showEngineSettings）は、
 * 取り込める PC で取り込んだ組がまだなら、詳細設定ではなくこの欄にする。
 *
 * 画面は simrun（test/helpers/simrun.js）で実際に走らせる。simrun の confirm は false を返すので、
 * ［エンジンを取り込む］は confirm() を使わない（押したことが同意）。
 *
 * 計画のテストから直したところ（今の preload と simrun に合わせた。意図は同じ）:
 *  - クリップボードの API は preload の名前 copy（計画は copyText）。simrun の called は { args } を返すので c.args[0]。
 *  - 記録の状態の知らせは preload の名前 onMeetingUpdate（計画は onMeetingState）。
 *  - 進み具合の割合は、計画の数（doneBytes 286,000,000 / totalBytes 5,580,564,403）から出る 5%（計画は 18% と書いたが、
 *    その数からは出ない。全体の割合 = doneBytes / totalBytes を見る意図は同じ）。
 *
 * 第1d回 A-13（D19）で意図して変えた: カード「エンジン」は「オフライン」になり、カードの中の文字起こしの言葉は「PC の中の文字起こし」
 * （［PC の中の文字起こしを取り込む］・「PC の中の文字起こし：使えます」・「PC の中の文字起こしは取り込み済みです」など）。同じ意図を新しい文で見る。
 * main の知らせの文が指すボタンの名前も新しい名前にした（NOTSET。理由の文の言い方は変えない）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { load } = require('./helpers/simrun.js');
const { MANIFEST } = require('../src/engine-manifest');
const { fetchErrorMessage } = require('../src/engine-fetch');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
// 0.10.0 LS-3（D59）で意図して直した: 取り込む組は文字起こしだけ（要約の組・パス・sumReady を外し、合計は文字起こしの組の 583,854,933 バイト）
const EMPTY = { localServerExe: '', localModelPath: '', vadModelPath: '' };
const ST = (o = {}) => ({ ok: true, supported: true, mode: { whisper: 'managed' }, state: 'missing', totalBytes: 583854933, doneBytes: 0,
  needBytes: 583854933, whisperBytes: 583854933, freeBytes: 120e9, whisperReady: false, runtime: null, askIt: false, report: '',
  items: MANIFEST.items.map((i) => ({ id: i.id, group: i.group, label: i.label, version: i.version, file: (i.dest || i.dir).split('/').pop(), url: i.url,
    host: new URL(i.url).hostname, sha256: i.sha256, size: i.size, done: 0, state: 'missing', license: i.license, place: '%LOCALAPPDATA%\\natsu\\engine\\…' })), error: null, ...o });
// パスが空の設定（simrun の既定の getSettings はパスが埋まっているので、初めての PC の形を自分で作る）
const SET_EMPTY = () => ({ hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M', language: 'ja', segmentSec: 75, pillPos: 'bottom',
  theme: 'system', dictionary: [], useBuiltinTerms: true, localPort: 8990, localThreads: 4, useVad: true, ...EMPTY });
const NOTSET = '文字起こしエンジンが未設定です。設定タブの［PC の中の文字起こしを取り込む］から取り込んでください。';
const base = (st, extra = {}) => load(APP, { returns: { engineFetchStatus: () => st,
  engineStatus: () => ({ ok: true, whisper: NOTSET, sum: '' }), ...extra } });

// 0.10.0 LS-3（D59）で意図して直した: 合計は文字起こしの組だけ（約 0.6GB・約 8 分）。「文字起こしの分が済めば…」の行は無い（組は1つ）
test('取り込み前: 合計・10Mbps の時間・空き・Teams の行・取得元の表と［PC の中の文字起こしを取り込む］。詳細設定は開かない', async () => {
  const l = await base(ST(), { getSettings: SET_EMPTY });
  assert.ok(!l.byId.get('engineFetch').hidden);
  const t = l.byId.get('engineFetchSummary').textContent;
  for (const k of [/約 0\.6GB/, /10Mbps の回線で約 8 分/, /空き 約 120\.0GB|空き 約 120GB/, /Teams/]) assert.match(t, k);
  assert.ok(!/要約/.test(t), '取り込みの欄に要約の文がある');
  const rows = l.byId.get('engineFetchRows').textContent;
  for (const it of MANIFEST.items) { assert.ok(rows.includes(it.sha256), it.id); assert.ok(rows.includes(it.version), it.id); }
  assert.strictEqual(l.byId.get('engineFetchBtn').textContent, 'PC の中の文字起こしを取り込む');
  const adv = l.byId.get('engineAdv');
  assert.ok(!adv.open && !adv.hasAttribute('open'), '取り込み前なのに詳細設定が開く');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('［PC の中の文字起こしを取り込む］で engineFetchStart を呼ぶ（confirm は使わない）', async () => {
  const l = await base(ST());
  l.byId.get('engineFetchBtn').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('engineFetchStart').length, 1);
});

test('記録開始で「未設定」が返ったら（showEngineSettings）、取り込みの欄を出し、詳細設定は閉じたまま', async () => {
  const l = await base(ST(), { getSettings: SET_EMPTY, meetingToggle: () => ({ ok: false, error: NOTSET }) });
  l.byId.get('mtToggleBtn').dispatchEvent({ type: 'click' }); await l.drain();
  assert.ok(!l.byId.get('engineFetch').hidden);
  assert.ok(!l.byId.get('engineAdv').open, '詳細設定が開いた');
});

// 「要約の組だけがまだでも取り込みの欄へ案内する」は 0.10.0 LS-3（D59）で外した（要約の組を取り込まない）

test('進み具合の知らせで、全体の割合と今の項目と残りの時間を出し、［一時停止］を出す', async () => {
  const l = await base(ST());
  l.fire('onEngineFetchProgress', ST({ state: 'running', current: 'whisper-model', doneBytes: 286000000, etaSec: 180,
    items: ST().items.map((i) => (i.id === 'whisper-model' ? { ...i, done: 312000000, state: 'running' } : i)) }));
  await l.drain();
  // 0.10.0 LS-3 で意図して直した: 全体は文字起こしの組だけなので 286,000,000 / 583,854,933 = 48%
  assert.match(l.byId.get('engineFetchSummary').textContent, /文字起こしのモデル.*312MB \/ 574MB.*48%.*残り約 3 分/);
  assert.ok(!l.byId.get('engineFetchPause').hidden);
});

test('待っている（waiting）: 待ちの文と［今すぐ試す］。記録中（held）: ボタンを出さない', async () => {
  const l = await base(ST({ state: 'waiting' }));
  assert.match(l.byId.get('engineFetchSummary').textContent + l.byId.get('engineFetchMsg').textContent, /つながるのを待っています/);
  // 画面に置いた待ちの文は、main の fetchErrorMessage('waiting') と同じ（片方だけ直さない）
  assert.ok((l.byId.get('engineFetchSummary').textContent + l.byId.get('engineFetchMsg').textContent).includes(fetchErrorMessage('waiting')));
  assert.strictEqual(l.byId.get('engineFetchBtn').textContent, '今すぐ試す');
  l.fire('onEngineFetchProgress', ST({ state: 'held' })); await l.drain();
  assert.match(l.byId.get('engineFetchSummary').textContent, /記録中のため/);
  for (const id of ['engineFetchBtn', 'engineFetchPause', 'engineFetchSwitch']) assert.ok(l.byId.get(id).hidden, id);
});

test('新しい版（update）: 今のものはそのまま使えることと［新しい版を取り込む］', async () => {
  const l = await base(ST({ state: 'update', updateBytes: 40e6, whisperReady: true }));
  assert.match(l.byId.get('engineFetchSummary').textContent, /^新しい版の PC の中の文字起こし（約 40MB）があります。今のものはそのまま使えます。$/);
  assert.strictEqual(l.byId.get('engineFetchBtn').textContent, '新しい版を取り込む');
});

test('ランタイムが無い PC では、取り込む前に案内を出す（RF4）', async () => {
  const l = await base(ST({ runtime: { level: 'missing', message: 'エンジンに必要な部品（Microsoft Visual C++ ランタイム）が…' } }));
  assert.match(l.byId.get('engineFetchSummary').textContent + l.byId.get('engineFetchMsg').textContent, /Visual C\+\+ ランタイム/);
});

test('失敗の知らせ: 文をそのまま出し、［もう一度］にする。askIt なら［担当に渡す内容を写す］で report を写す', async () => {
  const l = await base(ST());
  l.fire('onEngineFetchProgress', ST({ state: 'error', error: { code: 'blocked', message: '取り込み元の代わりに別のページが…' }, askIt: true, report: '置き場所: X' }));
  await l.drain();
  assert.match(l.byId.get('engineFetchMsg').textContent, /別のページ/);
  assert.strictEqual(l.byId.get('engineFetchBtn').textContent, 'もう一度');
  assert.ok(!l.byId.get('engineFetchCopy').hidden);
  l.byId.get('engineFetchCopy').dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(l.called('copy').map((c) => c.args[0]), ['置き場所: X']);
});

test('手で設定している: 「手で設定した PC の中の文字起こしを使っています」と［アプリの取り込みに切り替える］だけ', async () => {
  const l = await base(ST({ mode: { whisper: 'manual' } }));
  assert.match(l.byId.get('engineFetchSummary').textContent, /手で設定した PC の中の文字起こしを使っています/);
  assert.ok(!l.byId.get('engineFetchSwitch').hidden && l.byId.get('engineFetchBtn').hidden);
});

// 0.10.0 LS-3（D59）で意図して直した: 詳細設定のパスは文字起こしの3つ
test('切り替え: 取り込み済みで押すと、詳細設定の 3 つのパスを空にして保存する。記録中は押せない', async () => {
  const l = await base(ST({ mode: { whisper: 'manual' }, state: 'ready', whisperReady: true }));
  assert.strictEqual(l.byId.get('engineFetchSwitch').textContent, '取り込んだ PC の中の文字起こしに切り替える');
  l.byId.get('engineFetchSwitch').dispatchEvent({ type: 'click' }); await l.drain();
  const saved = l.called('saveSettings').pop().args[0];
  for (const k of Object.keys(EMPTY)) assert.strictEqual(saved[k], '', k);
  l.fire('onMeetingUpdate', { active: true, startedAt: Date.now() }); await l.drain();
  assert.strictEqual(l.byId.get('engineFetchSwitch').disabled, true);
});

test('engineFetchStatus が無い・{ok:true} だけ: 欄は出さず、今までどおり（要確認なら詳細設定を開く）', async () => {
  const l = await load(APP, { returns: { engineStatus: () => ({ ok: true, whisper: '文字起こしエンジンの実行ファイルまたはモデルが見つかりません', sum: '' }) } });
  assert.ok(l.byId.get('engineFetch').hidden);
  assert.strictEqual(l.byId.get('engineAdv').open, true);
});

test('whisper が使えるようになったら engineStatus を聞き直し、「PC の中の文字起こし：使えます」になる', async () => {
  let n = 0;
  const l = await base(ST(), { engineStatus: () => (++n === 1 ? { ok: true, whisper: NOTSET, sum: '' } : { ok: true, whisper: '', sum: '' }) });
  l.fire('onEngineFetchProgress', ST({ state: 'running', whisperReady: true })); await l.drain();
  assert.ok(n >= 2); assert.strictEqual(l.byId.get('engineState').textContent, 'PC の中の文字起こし：使えます');
  // 変わり目の無い進み具合（取り込みの途中は 250ms ごとに来る）では聞き直さない（0.10.0 LS-3 で要約の組の確かめを外した）
  const m = n;
  l.fire('onEngineFetchProgress', ST({ state: 'running', whisperReady: true })); await l.drain();
  assert.strictEqual(n, m, '変わり目の無い進み具合で聞き直した');
});

// 点検で足した確かめ（起動のときの「確かめています」が残る・使えなくなった組が「正常」のまま残る）
test('起動のときに「確かめています」を聞いても詳細設定は開かず、確かめ終えた知らせ（checking が偽）で聞き直して「PC の中の文字起こし：使えます」になる（両方の組が前から使える PC）', async () => {
  let n = 0;
  const CHECKING = '文字起こしエンジンを確かめています（数秒で終わります）';
  const ready = { state: 'ready', whisperReady: true, needBytes: 0, doneBytes: 583854933 };
  const l = await base(ST({ ...ready, checking: true }),
    { getSettings: SET_EMPTY, engineStatus: () => (++n === 1 ? { ok: true, whisper: CHECKING, sum: '' } : { ok: true, whisper: '', sum: '' }) });
  assert.strictEqual(l.byId.get('engineState').textContent, `PC の中の文字起こし：使えません（${CHECKING}）`);
  assert.ok(!l.byId.get('engineAdv').open, '確かめている間に詳細設定を開いた');
  // whisperReady は前から真（変わり目が無い）。確かめ終えたことだけが変わる
  l.fire('onEngineFetchProgress', ST({ ...ready, checking: false })); await l.drain();
  assert.strictEqual(n, 2, '確かめ終えた知らせで聞き直さない');
  assert.strictEqual(l.byId.get('engineState').textContent, 'PC の中の文字起こし：使えます');
  assert.ok(!l.byId.get('engineAdv').open);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('取り込んだ組が使えなくなった知らせ（落ちて照らし直したら合わない）でも聞き直し、「使えません」にする。詳細設定ではなく取り込みの欄へ案内する', async () => {
  let n = 0;
  const BROKEN = '文字起こしエンジンのファイルが消えたか変わっています。ウイルス対策が消した可能性があります（Windows セキュリティ → ウイルスと脅威の防止 → 保護の履歴）。取り直しています';
  const l = await base(ST({ state: 'ready', whisperReady: true }),
    { engineStatus: () => (++n === 1 ? { ok: true, whisper: '', sum: '' } : { ok: true, whisper: BROKEN, sum: '' }) });
  assert.strictEqual(l.byId.get('engineState').textContent, 'PC の中の文字起こし：使えます');
  l.fire('onEngineFetchProgress', ST({ state: 'running', whisperReady: false })); await l.drain();
  assert.strictEqual(n, 2, '使えなくなった知らせで聞き直さない');
  assert.strictEqual(l.byId.get('engineState').textContent, `PC の中の文字起こし：使えません（${BROKEN}）`);
  assert.ok(!l.byId.get('engineAdv').open, '取り直している組なのに詳細設定を開いた');
});

// ---------------------------------------------------------------- 計画のテストに足したもの

test('取り込み済み（詳細設定のパスは空・ready）で起動しても、設定タブへ連れて行かず、詳細設定も開かない', async () => {
  const l = await base(ST({ state: 'ready', whisperReady: true, needBytes: 0, doneBytes: 583854933 }),
    { getSettings: SET_EMPTY, engineStatus: () => ({ ok: true, whisper: '', sum: '' }) });
  assert.ok(!l.byId.get('tabSettings').classList.contains('active'), '起動のたびに設定タブへ連れて行く');
  assert.ok(!l.byId.get('engineAdv').open, '詳細設定が開いた');
  assert.match(l.byId.get('engineFetchSummary').textContent, /^PC の中の文字起こしは取り込み済みです（whisper\.cpp 1\.9\.5）。$/);   // 0.10.0 LS-3 で要約の組を外した
  assert.ok(!l.byId.get('engineDirBtn').hidden, '［取り込み先を開く］が無い');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('取り込みの途中・一時停止・続き・この PC で取れない・RF3 の失敗の、ボタンと文', async () => {
  const l = await base(ST({ state: 'partial', doneBytes: 1200000000, needBytes: 4380564403 }));
  assert.strictEqual(l.byId.get('engineFetchBtn').textContent, '続きから取り込む');
  l.fire('onEngineFetchProgress', ST({ state: 'paused', doneBytes: 1200000000 })); await l.drain();
  assert.match(l.byId.get('engineFetchSummary').textContent, /一時停止中（1\.2GB 済み）/);
  assert.strictEqual(l.byId.get('engineFetchBtn').textContent, '続きから取り込む');
  assert.ok(l.byId.get('engineFetchPause').hidden);
  l.fire('onEngineFetchProgress', ST({ state: 'error', error: { code: 'defender', message: '取り込んだ whisper-server.exe が、また消えました。' }, askIt: true })); await l.drain();
  assert.ok(!l.byId.get('engineDirBtn').hidden, 'RF3 の失敗なのに［取り込み先を開く］が無い');
  assert.ok(/\bng\b/.test(l.byId.get('engineFetchMsg').className), '失敗の文が ng の色でない');
  l.fire('onEngineFetchProgress', ST({ state: 'unsupported', supported: false })); await l.drain();
  assert.match(l.byId.get('engineFetchSummary').textContent, /この PC では自動の取り込みに対応していません（Windows の 64 ビット版だけ）/);
  for (const id of ['engineFetchBtn', 'engineFetchPause', 'engineFetchSwitch', 'engineDirBtn', 'engineFetchCopy']) assert.ok(l.byId.get(id).hidden, id);
  // main から来たでたらめな値（items が無い）は、出ている欄を壊さない
  l.fire('onEngineFetchProgress', { active: true }); await l.drain();
  assert.ok(!l.byId.get('engineFetch').hidden);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('［一時停止］は engineFetchPause、まだ取り込んでいない手の設定の［アプリの取り込みに切り替える］は全部を取り込む（all）', async () => {
  const l = await base(ST({ state: 'running' }));
  l.byId.get('engineFetchPause').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('engineFetchPause').length, 1);
  l.fire('onEngineFetchProgress', ST({ mode: { whisper: 'manual', sum: 'manual' }, state: 'ready' })); await l.drain();
  assert.strictEqual(l.byId.get('engineFetchSwitch').textContent, 'アプリの取り込みに切り替える');
  l.byId.get('engineFetchSwitch').dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(l.called('engineFetchStart').map((c) => c.args[0]), [{ all: true }]);
  assert.strictEqual(l.called('saveSettings').length, 0, 'まだ取り込んでいないのにパスを消した');
});

// INSTALL.md の「手順3」と「困ったときは」は、画面のボタンと文を［…］「…」で引く。片方だけ直すと、利用者が案内の語を画面で探せない
test('INSTALL の手順3 と困ったときに引いた［ボタン］と、取り込みの欄の「文」は、画面にある', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'INSTALL.md'), 'utf8');
  const html = fs.readFileSync(APP, 'utf8');
  const sec = (h) => { const i = md.indexOf(`\n${h}`); assert.ok(i >= 0, h); const rest = md.slice(i + 1); const j = rest.indexOf('\n## ', 1); return j < 0 ? rest : rest.slice(0, j); };
  // 0.9.0 G-2（OF8）で意図して変えた: 手順3 の見出しは「（任意）オフラインでも使う（約 5.6GB を取り込む）」
  // 0.9.3 M-0（D54）で意図して変えた: 手順3 の見出しは「（任意）ローカル AI を使う（約 5.6GB を取り込む）」
  const text = sec('## 手順3.（任意）ローカル AI を使う') + sec('## 困ったときは');
  const buttons = [...new Set([...text.matchAll(/［([^］]+)］/g)].map((m) => m[1]))];
  assert.ok(buttons.length >= 8, `引いたボタンが少ない: ${buttons.join('・')}`);
  // 0.10.0 LS-5（D59）で意図して変えた: 取り込みのボタンの数は今の計算（画面の文は `約 ${fetchGB(need)}`）。INSTALL の「約 0.6GB」はその形で探す
  for (const b of buttons) assert.ok(html.includes(b.replace(/約 \d+\.\dGB/, '約 ${fetchGB(need)}')), `INSTALL の［${b}］が画面に無い`);
  for (const s of ['取り込むもの（取得元・版・SHA-256・置き場所）', 'PC の中の文字起こしは取り込み済みです', 'つながるのを待っています']) {
    assert.ok(text.includes(`「${s}`), `INSTALL が「${s}」を引いていない`);
    assert.ok(html.includes(s), `INSTALL の「${s}」が画面に無い`);
  }
});
