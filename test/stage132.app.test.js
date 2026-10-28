/*
 * stage132.app.test.js — 0.13.2 の画面（計画 docs/plans/2026-10-28-132.md の Task LN-3〜LN-5・LN-7）
 * 画面（app.html）の <script> を最小 DOM（helpers/simrun.js）の上で本当に走らせる。main の答えは偽物（preload.js の名前から作る）。
 * LN-3（LR8）: 帯 no-login・kept-login の［ログイン］は、設定の「アカウント」でなくログインの窓を直に開く（accountLogin の1回）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const settingsOpen = (l) => $(l, 'settingsModal').hidden === false;
const click = async (l, id) => { $(l, id).dispatchEvent({ type: 'click' }); await l.drain(); };
const T0 = Date.UTC(2026, 9, 28, 1, 0, 0);
// メールの見本は字をつないで作る（公開前の確認はメールアドレスの形の文字を見る: repo.test.js）
const MAIL = ['kaigi', 'example.com'].join('@');
const ACCOUNT = (signedIn) => () => ({ ok: true, signedIn, email: signedIn ? MAIL : '', method: 'access', until: null, canStore: true, online: { up: true, why: 'ok' } });
const LIVE = (o = {}) => ({ active: true, finalizing: false, startedAt: T0 - 60000, memo: '', segments: [], pending: 0, stoppedAt: null,
  stopping: false, paused: false, pausedMs: 0, systemAudio: false, micFallback: false, etaSec: null, skipped: 0, pauses: [], pausing: false,
  resumeHint: false, localOnly: false, cloud: false, stt: null, ...o });
const PROB = (code, action, text) => LIVE({ stt: { route: 'local', lastTextAt: T0 - 5000, segSec: 15, problem: { code, action, text } } });
const NO_LOGIN = 'ログインしていないため PC で文字起こししています。［ログイン］を押してログインすると、クラウドで文字起こしします。';

// ---------------------------------------------------------------- LN-3（LR8）
test('LN-3・LR8: 帯 no-login の［ログイン］を押すと accountLogin の1回（設定の『アカウント』は開かない）。kept-login も同じ。login の［ログインし直す］は今どおり『アカウント』', T, async () => {
  for (const [code, action, label] of [['no-login', 'signin', 'ログイン'], ['kept-login', 'signin', 'ログイン']]) {
    const l = await load(APP, { now: T0, returns: { accountStatus: ACCOUNT(false), accountLogin: () => ({ ok: false, code: 'cancel', message: 'ログインを取りやめました。' }) } });
    await l.drain();
    l.fire('onMeetingUpdate', PROB(code, action, code === 'no-login' ? NO_LOGIN : '帯の文（見本）')); await l.drain();
    const btn = $(l, 'liveSttBannerBtn');
    assert.strictEqual(btn.hidden, false, `${code}: 帯のボタンが無い`);
    assert.strictEqual(btn.textContent, label, code);
    const n0 = l.called('accountLogin').length;
    await click(l, 'liveSttBannerBtn');
    assert.strictEqual(l.called('accountLogin').length - n0, 1, `${code}: ログインの窓を開いていない`);
    assert.ok(!settingsOpen(l), `${code}: 設定の「アカウント」を開いた`);
    // 2回続けて押しても、返事の前は1回だけ（設定の［ログイン］と同じ）
    assert.deepStrictEqual(l.errors.map(fmt), []);
  }
  const l = await load(APP, { now: T0, returns: { accountStatus: ACCOUNT(false) } });
  await l.drain();
  l.fire('onMeetingUpdate', PROB('login', 'account', '帯の文（見本）')); await l.drain();
  assert.strictEqual($(l, 'liveSttBannerBtn').textContent, 'ログインし直す');
  await click(l, 'liveSttBannerBtn');
  assert.ok(settingsOpen(l), 'login の［ログインし直す］で「アカウント」を開いていない');
  assert.strictEqual(l.called('accountLogin').length, 0, 'login の［ログインし直す］でログインの窓を直に開いた');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- LN-4（LR20）
test('LN-4・LR20: onAccountChanged が来ると accountStatus を1回読み直し、『アカウント』の行が『ログイン中: …』になる', T, async () => {
  let signedIn = false;
  const l = await load(APP, { now: T0, returns: { accountStatus: () => ACCOUNT(signedIn)() } });
  await l.drain();
  const n0 = l.called('accountStatus').length;
  signedIn = true;
  l.fire('onAccountChanged'); await l.drain();
  assert.strictEqual(l.called('accountStatus').length - n0, 1, 'accountStatus を読み直していない');
  assert.ok($(l, 'accountWho').textContent.startsWith(`ログイン中: ${MAIL}`), $(l, 'accountWho').textContent);
  assert.strictEqual($(l, 'accountIn').hidden, false);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- LN-5（LA4・決めたこと 8・9）
const { titleAt } = require('./helpers/titles');
const PAGES = [{ id: 'pa1', title: titleAt('2026-10-28T01:00:00.000Z'), date: '10/28', durationSec: 1800, hasSummary: false }];
const pageGet = (id) => ({ page: { id, title: titleAt('2026-10-28T01:00:00.000Z'), createdAt: '2026-10-28T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' },
  segments: [{ id: 's1', atMs: 0, durationMs: 75000, text: '（文字起こし待ち: 会議の後で文字起こしします）', failed: true }] });
async function openSaved(returns = {}, before = async () => {}) {
  const l = await load(APP, { now: T0, returns: { pagesSearch: () => PAGES, pageGet, ...returns } });
  await l.drain();
  await before(l);
  await click(l, 'tabBtnNotes');
  l.root.querySelector('#plist .pitem').dispatchEvent({ type: 'click' }); await l.drain();
  await click(l, 'paneBtnScript');
  return l;
}
const lineOf = (l) => ({ hidden: $(l, 'pPending').hidden, text: $(l, 'pPendingText').textContent, disabled: $(l, 'pRetranscribe').disabled, tip: $(l, 'pRetranscribe').title });

test('LN-5・LA4: 待ち行列のある議事録のページの「文字起こし」の欄の頭に「文字起こし待ち: 残り 3 区間」と［もう一度文字起こし］。押すと pageRetranscribe の1回で、onPagePending の数で「文字起こししています（残り 2 区間）」に替わり、0 で行が消える', T, async () => {
  const l = await openSaved({ pagePending: () => ({ left: 3, running: false, busy: false }), pageRetranscribe: () => ({ ok: true, left: 3 }) });
  assert.deepStrictEqual(l.called('pagePending').map((c) => c.args[0]), ['pa1']);
  assert.deepStrictEqual(lineOf(l), { hidden: false, text: '文字起こし待ち: 残り 3 区間', disabled: false, tip: '' });
  assert.strictEqual($(l, 'pRetranscribe').textContent, 'もう一度文字起こし');
  // 「AI 要約」の欄には出さない
  await click(l, 'paneBtnNote');
  assert.strictEqual($(l, 'pPending').hidden, true, '「AI 要約」の欄に出した');
  await click(l, 'paneBtnScript');
  await click(l, 'pRetranscribe');
  assert.deepStrictEqual(l.called('pageRetranscribe').map((c) => c.args[0]), ['pa1']);
  assert.strictEqual($(l, 'pRetranscribe').disabled, true, '押した後も押せる（回している間）');
  l.fire('onPagePending', { id: 'pa1', left: 2, running: true }); await l.drain();
  assert.deepStrictEqual(lineOf(l), { hidden: false, text: '文字起こししています（残り 2 区間）', disabled: true, tip: '' });
  // ほかのページの知らせは描かない
  l.fire('onPagePending', { id: 'pz9', left: 7, running: true }); await l.drain();
  assert.strictEqual($(l, 'pPendingText').textContent, '文字起こししています（残り 2 区間）');
  l.fire('onPagePending', { id: 'pa1', left: 0, running: false }); await l.drain();
  assert.strictEqual($(l, 'pPending').hidden, true, '残りが 0 なのに行が残った');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('LN-5: 録音中は［もう一度文字起こし］が押せず title が出る。録音中のページ（写し）には行が無い。待ち行列の無いページにも行は無い', T, async () => {
  const l = await openSaved({ pagePending: () => ({ left: 2, running: false, busy: true }) }, async (x) => { x.fire('onMeetingUpdate', LIVE()); await x.drain(); });
  assert.deepStrictEqual(lineOf(l), { hidden: false, text: '文字起こし待ち: 残り 2 区間', disabled: true, tip: '録音が終わってから押してください。' });
  const liveTab = l.root.querySelectorAll('[data-key]').find((x) => x.dataset.key === 'live');
  assert.ok(liveTab, '録音中のタブが無い');
  liveTab.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual($(l, 'pPending').hidden, true, '録音中のページ（写し）に行を出した');
  assert.deepStrictEqual(l.errors.map(fmt), []);
  const none = await openSaved({ pagePending: () => ({ left: 0, running: false, busy: false }) });
  assert.strictEqual($(none, 'pPending').hidden, true);
  assert.deepStrictEqual(none.errors.map(fmt), []);
});
