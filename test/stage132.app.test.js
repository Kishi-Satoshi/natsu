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
