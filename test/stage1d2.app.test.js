/*
 * stage1d2.app.test.js — 0.9.0（第1d2回）U-3（OF7・F4・F5・D21）: 設定のカード「オフライン」を任意の選択にする・起動で催促しない・帯と知らせのボタン。
 * 画面（app.html）の <script> を最小 DOM（helpers/simrun.js）の上で本当に走らせる。main の答えは偽物（preload.js の名前から作る）で、
 * 受け渡す名前と形は計画（docs/plans/2026-10-20-090.md）の「受け渡す名前と形」のまま: engine:status の chosen（M-1）・取り込みの欄の写しの
 * consent（0.8.0 からある）・meetingStatus().needsSetup と meeting:set-local-only の答えの needsSetup（M-4）・帯と知らせの action の signin・offline（M-1・M-2・M-4）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { load, RETURNS } = require('./helpers/simrun.js');
const { MANIFEST } = require('../src/engine-manifest');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
// 計画「画面と知らせの文」の設定のカード「オフライン」（OFF1〜OFF5）
// 0.10.0 LS-3（D59）で意図して変えた: 要約は PC の中で作らないので、頭の1行（OFF1_LEAD）と取り込みの欄の得るもの（OFF3）から「要約」を外し、
// 取り込みの合計は文字起こしの組だけ（約 0.6GB・約 8 分）
const OFF1_LEAD = 'PC の中で文字起こしをするための準備です（任意）。';
const OFF1 = 'インターネットにつながっていないときと、オフラインモードの会議でも、この PC の中で文字起こしと要約ができるようにする準備です（任意）。準備しなくても、インターネットにつながっていてログインしていれば、会議と音声入力はそのまま使えます。';
const OFF2 = 'PC の中の文字起こし：準備していません（任意）';
const OFF3 = '取り込むと: インターネットにつながっていないときやオフラインモードの会議でも、PC の中で文字起こしができます。要約は、インターネットにつながっているときに作ります。';
const OFF4 = (need, free, min) => `かかるもの: ディスクの空き 約 ${need}（今の空き 約 ${free}）・取り込みの時間 10Mbps の回線で約 ${min} 分。議事録の記録中は、Web 会議の回線を守るため取り込みを止めます。`;
// 0.10.0 LS-5（D59）で意図して変えた: 取り込みが約 0.6GB になり、ボタンの数は今の計算
const OFF5 = 'ローカル AI を使う（約 0.6GB を取り込む）';
const NOT_FETCHED = '文字起こしエンジンがまだ取り込まれていません（見本）';
// 取り込みの欄の写し（engine-app.test.js の ST と同じ形。main の engine:fetch-status の答え）
const FETCH = (o = {}) => ({ ok: true, supported: true, mode: { whisper: 'managed' }, state: 'missing', totalBytes: 583854933, doneBytes: 0,
  needBytes: 583854933, whisperBytes: 583854933, freeBytes: 120e9, whisperReady: false, runtime: null, askIt: false, report: '', consent: false,
  items: MANIFEST.items.map((i) => ({ id: i.id, group: i.group, label: i.label, version: i.version, file: (i.dest || i.dir).split('/').pop(), url: i.url,
    host: new URL(i.url).hostname, sha256: i.sha256, size: i.size, done: 0, state: 'missing', license: i.license, place: '%LOCALAPPDATA%\\natsu\\engine\\…' })), error: null, ...o });
const EMPTY = () => ({ ...RETURNS.getSettings(), localServerExe: '', localModelPath: '', sumServerExe: '', sumModelPath: '', vadModelPath: '' });
const ENG = (o = {}) => () => ({ ok: true, whisper: NOT_FETCHED, sum: '', ...o });
const ACCOUNT = (signedIn) => () => ({ ok: true, signedIn, email: '', method: 'access', until: null, canStore: true, online: { up: true, why: 'ok' } });
const open = (returns = {}, opt = {}) => load(APP, { ...opt, returns: { engineStatus: ENG({ chosen: false }), engineFetchStatus: () => FETCH(), accountStatus: ACCOUNT(true), ...returns } });
const $ = (l, id) => l.document.getElementById(id);
const settingsOpen = (l) => $(l, 'settingsModal').hidden === false;
const secOf = (l) => { const on = $(l, 'setNav').querySelectorAll('.setnav-item').filter((b) => b.classList.contains('on')); return on.length === 1 ? on[0].dataset.sec : `(${on.length} 個)`; };
const click = async (l, id) => { $(l, id).dispatchEvent({ type: 'click' }); await l.drain(); };
const T0 = Date.UTC(2026, 9, 19, 1, 0, 0);
const LIVE = (o = {}) => ({ active: true, finalizing: false, startedAt: T0 - 60000, memo: '', segments: [], pending: 0, stoppedAt: null,
  stopping: false, paused: false, pausedMs: 0, systemAudio: false, micFallback: false, etaSec: null, skipped: 0, pauses: [], pausing: false,
  resumeHint: false, localOnly: false, cloud: true, stt: null, ...o });
const PROB = (code, action, text) => LIVE({ stt: { route: 'cloud', lastTextAt: T0 - 5000, segSec: 15, problem: { code, action, text } } });

test('OF7・F4: chosen が偽なら、状態は『PC の中の文字起こし：準備していません（任意）』で赤くなく、詳細設定を開かず、［PC の中で試す］が無い', T, async () => {
  const l = await open({ getSettings: EMPTY });
  await l.drain();
  const st = $(l, 'engineState');
  assert.strictEqual(st.textContent, OFF2);
  assert.strictEqual(st.className, 'eng-state', '準備していないのに赤（ng）か緑（ok）の印');
  assert.ok(!$(l, 'engineAdv').open, '準備していない人の詳細設定を開いた');
  assert.strictEqual($(l, 'testBtn').hidden, true, '準備していない人に［PC の中で試す］を出した');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('F5: chosen が真か無いときの状態は 0.8.0 のまま（使えません（理由）は赤・［PC の中で試す］を出す・取り込みの欄が要らなければ詳細設定を開く）', T, async () => {
  for (const chosen of [true, undefined]) {
    const l = await open({ engineStatus: ENG(chosen === undefined ? {} : { chosen }), engineFetchStatus: () => ({ ok: true }) });
    await l.drain();
    assert.strictEqual($(l, 'engineState').textContent, `PC の中の文字起こし：使えません（${NOT_FETCHED}）`, String(chosen));
    assert.strictEqual($(l, 'engineState').className, 'eng-state ng', String(chosen));
    assert.ok(!$(l, 'testBtn').hidden, String(chosen));
    assert.strictEqual($(l, 'engineAdv').open, true, String(chosen));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  }
  const ok = await open({ engineStatus: ENG({ whisper: '', chosen: true }) });
  await ok.drain();
  assert.strictEqual($(ok, 'engineState').textContent, 'PC の中の文字起こし：使えます');
  assert.strictEqual($(ok, 'engineState').className, 'eng-state ok');
});

test('OF7: 取り込みの欄（consent が偽・missing）の文は OFF3・OFF4（空きと分の数は今の計算）で、ボタンは［ローカル AI を使う（約 0.6GB を取り込む）］（数は今の計算）。押すと engine:fetch-start を1回', T, async () => {
  const l = await open();
  await l.drain();
  assert.strictEqual($(l, 'engineFetch').hidden, false);
  const lines = $(l, 'engineFetchSummary').children.map((d) => d.textContent);
  assert.deepStrictEqual(lines, [OFF3, OFF4('0.6GB', '120.0GB', 8)]);
  const b = $(l, 'engineFetchBtn');
  assert.strictEqual(b.textContent, OFF5);
  assert.strictEqual(b.hidden, false);
  assert.strictEqual($(l, 'engineFetch').dataset.row, 'ローカル AI を使う', '検索の行の名前がボタンの文と違う');
  const n = l.called('engineFetchStart').length;
  await click(l, 'engineFetchBtn');
  assert.strictEqual(l.called('engineFetchStart').length, n + 1);
  assert.deepStrictEqual(l.called('engineFetchStart').pop().args, [], '押したときの頼みの形が 0.8.0 と違う');
  // 空きが分からない写しでは「（今の空き …）」を書かない
  const u = await open({ engineFetchStatus: () => FETCH({ freeBytes: null }) });
  await u.drain();
  assert.strictEqual($(u, 'engineFetchSummary').children[1].textContent, 'かかるもの: ディスクの空き 約 0.6GB・取り込みの時間 10Mbps の回線で約 8 分。議事録の記録中は、Web 会議の回線を守るため取り込みを止めます。');
  assert.deepStrictEqual([...l.errors, ...u.errors].map(fmt), []);
});

test('F5: consent が真・手の組あり・取り込み済みの写しの文とボタンは 0.8.0 のまま', T, async () => {
  const cases = [
    // 0.10.0 LS-3（D59）で意図して直した: 組は文字起こしだけ（「要約を」の文と、片方だけ手の設定の形が無い）
    [FETCH({ consent: true }), 'PC の中の文字起こしを取り込む', /^PC の中の文字起こしを、この PC に取り込みます（合計 約 0\.6GB/],
    [FETCH({ consent: undefined }), 'PC の中の文字起こしを取り込む', /^PC の中の文字起こしを、この PC に取り込みます/],
    [FETCH({ state: 'partial', doneBytes: 1e8 }), '続きから取り込む', /^PC の中の文字起こしを、この PC に取り込みます（残り/],
    [FETCH({ state: 'ready', whisperReady: true }), '', /^PC の中の文字起こしは取り込み済みです/],
  ];
  for (const [st, btn, re] of cases) {
    const l = await open({ engineFetchStatus: () => st, engineStatus: ENG({ whisper: '', chosen: true }) });
    await l.drain();
    const b = $(l, 'engineFetchBtn');
    assert.strictEqual(b.hidden ? '' : b.textContent, btn, JSON.stringify([st.state, st.consent, st.mode]));
    assert.match($(l, 'engineFetchSummary').textContent, re);
    assert.ok(!$(l, 'engineFetchSummary').textContent.includes('取り込むと:'), '選んだ人に選んでいない人の文を出した');
    assert.strictEqual($(l, 'engineFetch').dataset.row, 'PC の中の文字起こしを取り込む');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  }
});

test('F4: chosen が偽で、ログインしているなら起動で設定のタブへ連れて行かない。ログインしていなければ設定の『アカウント』を開く（オフラインのカードへは行かない）', T, async () => {
  const inn = await open({ getSettings: EMPTY, accountStatus: ACCOUNT(true) });
  await inn.drain();
  assert.ok(!settingsOpen(inn), 'ログインしている・準備していない人を起動で設定へ連れて行った');
  assert.ok(!$(inn, 'engineAdv').open);
  const out = await open({ getSettings: EMPTY, accountStatus: ACCOUNT(false) });
  await out.drain();
  assert.ok(settingsOpen(out), 'ログインしていない人に設定の「アカウント」を開かない');
  assert.strictEqual(secOf(out), 'account', 'オフラインのカードへ連れて行った');
  assert.ok(!$(out, 'engineAdv').open, 'エンジンの欄を開いた');
  assert.deepStrictEqual([...inn.errors, ...out.errors].map(fmt), []);
});

test('F4: engine:status の答えが他の問い合わせより遅れて届いても、起動の連れて行きは答え（chosen）を待ってから決める（準備していない・ログインしている人を設定へ連れて行かない）', T, async () => {
  // 偽の IPC は呼んだ順にすぐ答えるので、実機で engine:status が遅いときの競り合いを、わざと遅らせた答えで作る
  const later = (v, n = 30) => new Promise((resolve) => { let i = 0; const step = () => (++i >= n ? resolve(v) : setImmediate(step)); setImmediate(step); });
  const l = await open({ getSettings: EMPTY, accountStatus: ACCOUNT(true), engineStatus: () => later({ ok: true, whisper: NOT_FETCHED, sum: '', chosen: false }) });
  await l.drain(80);
  assert.strictEqual($(l, 'engineState').textContent, OFF2, '前提: 遅れた答え（chosen が偽）が画面に届いていない');
  assert.ok(!settingsOpen(l), '答えを待たずに決めて、準備していない人を起動で設定へ連れて行った');
  assert.ok(!$(l, 'engineAdv').open);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('F5: chosen が真か無く、パスが空で取り込んだ組も無ければ、今どおり取り込みの欄へ連れて行く（ログインしていても）', T, async () => {
  for (const chosen of [true, undefined]) {
    const l = await open({ getSettings: EMPTY, engineStatus: ENG(chosen === undefined ? {} : { chosen }), engineFetchStatus: () => FETCH({ consent: true }), accountStatus: ACCOUNT(true) });
    await l.drain();
    assert.ok(settingsOpen(l), `chosen ${chosen}: 連れて行かない`);
    assert.strictEqual(secOf(l), 'offline', String(chosen));
    assert.ok(!$(l, 'engineAdv').open, '取り込みの欄でなく詳細設定を開いた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  }
});

// 0.13.2 LN-3（LR8）で意図して変えた: 帯の action signin の［ログイン］は設定の「アカウント」でなく、ログインの窓を直に開く（accountLogin。stage132.app の LN-3）。
// 知らせの action signin は今どおり設定の「アカウント」
test('OF2: 帯の action offline は［オフラインの準備］で取り込みの欄、account は［ログインし直す］で設定の『アカウント』（signin の［ログイン］は 0.13.2 からログインの窓）。知らせの action signin は［ログイン］、account は今どおり［ログインし直す］、offline は［オフラインの準備］', T, async () => {
  for (const [action, label, sec] of [['offline', 'ローカル AI の準備', 'offline'], ['account', 'ログインし直す', 'account']]) {
    const l = await open({}, { now: T0 });
    await l.drain();
    l.fire('onMeetingUpdate', PROB('kept-x', action, '帯の文（見本）')); await l.drain();
    const btn = $(l, 'liveSttBannerBtn');
    assert.strictEqual(btn.hidden, false, `帯の ${action} のボタンが無い`);
    assert.strictEqual(btn.textContent, label, action);
    await click(l, 'liveSttBannerBtn');
    assert.ok(settingsOpen(l), `帯の ${action} で設定が開かない`);
    assert.strictEqual(secOf(l), sec, action);
    if (action === 'offline') assert.ok(!$(l, 'engineAdv').open, '［オフラインの準備］で詳細設定を開いた（取り込みの欄へ行く）');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  }
  for (const [action, label, sec] of [['signin', 'ログイン', 'account'], ['account', 'ログインし直す', 'account'], ['offline', 'ローカル AI の準備', 'offline']]) {
    const l = await open();
    await l.drain();
    l.fire('onNotice', { text: '知らせの文（見本）', action }); await l.drain();
    const b = $(l, 'toast').querySelector('button');
    assert.ok(b, `知らせの ${action} にボタンが無い`);
    assert.strictEqual(b.textContent, label, action);
    b.dispatchEvent({ type: 'click' }); await l.drain();
    assert.ok(settingsOpen(l), `知らせの ${action} で設定が開かない`);
    assert.strictEqual(secOf(l), sec, action);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  }
});

// 0.10.0 LS-5（D59・D62）で意図して変えた: 守秘の約束（外へ送らない）にしない。要約はつながっているときに Claude Code で作る
const NEEDS = 'オフラインモードです。音声だけを PC に残しています。ローカル AI の準備が済むと文字起こしします（要約はつながっているときに Claude Code で作ります）';
const LOCAL = 'オフラインモードです。文字起こしを PC の中で行います（要約はつながっているときに Claude Code で作ります）';
test('OF4: needsSetup の答えのとき、PC の中だけの文が準備なしの文。画面を描き直しても（meeting:update の needsSetup が真）準備なしの文のまま。準備した PC は今の文', T, async () => {
  let st = LIVE();
  const l = await open({ meetingStatus: () => st, meetingSetLocalOnly: () => ({ ok: true, localOnly: true, needsSetup: true }) }, { now: T0 });
  await l.drain();
  l.fire('onMeetingUpdate', st); await l.drain();
  assert.strictEqual($(l, 'meetingLocalOnly').hidden, false, '前提: ［この会議は PC の中だけ］が出ない');
  // 押した直後は答えの needsSetup で描く（meetingStatus はまだ needsSetup を持たない古い形でも）
  await click(l, 'meetingLocalOnly');
  assert.strictEqual($(l, 'meetingLocalOnlyNote').textContent, NEEDS);
  st = LIVE({ localOnly: true, needsSetup: true });
  l.fire('onMeetingUpdate', st); await l.drain();
  assert.strictEqual($(l, 'meetingLocalOnlyNote').textContent, NEEDS, '描き直したら準備なしの文が消えた');
  // 読み直した画面（押していない画面）でも meetingStatus().needsSetup で決める
  const r = await open({ meetingStatus: () => LIVE({ localOnly: true, needsSetup: true }) }, { now: T0 });
  await r.drain();
  r.fire('onMeetingUpdate', LIVE({ localOnly: true, needsSetup: true })); await r.drain();
  assert.strictEqual($(r, 'meetingLocalOnlyNote').textContent, NEEDS);
  // 準備した PC（needsSetup が偽・無い）は今の文
  const k = await open({ meetingStatus: () => LIVE({ localOnly: true }) }, { now: T0 });
  await k.drain();
  k.fire('onMeetingUpdate', LIVE({ localOnly: true, needsSetup: false })); await k.drain();
  assert.strictEqual($(k, 'meetingLocalOnlyNote').textContent, LOCAL);
  assert.deepStrictEqual([...l.errors, ...r.errors, ...k.errors].map(fmt), []);
});

test('OFF1: カードの説明は D21 の文（選んだ人も選んでいない人も）。新しい文に「未設定」が無い', T, async () => {
  for (const chosen of [false, true]) {
    const l = await open({ engineStatus: ENG({ chosen }) });
    await l.drain();
    const card = $(l, 'engineState').closest('.card');
    // 0.9.2 I-3（計画 docs/plans/2026-10-21-092.md）で意図して変えた: 頭の説明は1行（OFF1_LEAD）。D21 の文の芯は ⓘ の吹き出し（#setPopOffline）にある
    assert.strictEqual(card.children[1].textContent.trim(), OFF1_LEAD, String(chosen));
    const pop = $(l, 'setPopOffline').textContent;
    for (const w of ['準備しなくても、インターネットにつながっていてログインしていれば、会議と音声入力はそのまま使えます。', 'オフラインモードの会議でも']) assert.ok(pop.includes(w), w);   // 0.9.3 M-0（D54）で意図して変えた
  }
  for (const t of [OFF1_LEAD, OFF1, OFF2, OFF3, OFF4('1GB', '2GB', 3), OFF5, NEEDS, 'ログイン', 'ローカル AI の準備']) assert.ok(!t.includes('未設定'), t);
});
