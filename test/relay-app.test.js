/*
 * relay-app.test.js — 第1d回 RL9・F5: アプリの中継の口（src/relay.js のログインの口と、stt-cloud.transcribeRelay）を、
 * 本物の中継のコード（relay/worker.mjs）を 127.0.0.1 で動かした台（helpers/relay-local.js）を相手に試す。
 * アプリの側は偽の net.request（helpers/fake-net.js）で送り、RELAY_BASE を 127.0.0.1 の中継へ書き換える。外へはつながない。
 * 第1d回 A-10（RL9・F19・F21）: Cloudflare Access の cookie で送る道（偽の session の cookie・useSessionCookies・X-Requested-With・
 * redirect: 'manual'）と Access の答えの分け方を、relay-local の偽の Access の前（startRelayLocal({ access: true })）を相手に見る。
 * 第1d回 A-11: 文字起こしの札（nt1_）の道を消した。文字起こしの試しは全部 cookie の道。ログインの口（makeAccountApi）の試しは A-12 まで残す。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { makeFakeRequest, makeFakeSession } = require('./helpers/fake-net');
const R = require('./helpers/relay-run');
const relay = require('../src/relay');
const C = require('../src/stt-cloud');
const { startRelayLocal } = require('./helpers/relay-local');

const SAID = '本日の議題は進捗の確認です。';
const wav = (sec) => Buffer.from(R.wav(sec));
const noSleep = async () => {};
const TOKEN = /^nt1_[A-Za-z0-9_-]{43}$/;

async function withLocal(opts, fn) {
  const rl = await startRelayLocal(opts);
  try { return await fn(rl); } finally { await rl.close(); }
}

// ログインして札をもらう（アプリの口で）
async function signIn(rl, email = R.mail('a')) {
  const api = relay.makeAccountApi({ request: rl.request });
  assert.deepStrictEqual(await api.start(email), { ok: true });
  const v = await api.verify(email, rl.codeFor(email));
  assert.strictEqual(v.ok, true, JSON.stringify(v));
  return v.token;
}

// 閉じた口（つながらない 127.0.0.1 のポート）
async function closedBase() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}


async function codeOf(p) {
  try { await p; } catch (e) { return e; }
  assert.fail('投げなかった');
  return null;
}

test('RL9: relayProvider の id は \'openai\'、label は \'OpenAI\'、reachUrl は RELAY_BASE + \'/health\'、RELAY_BASE は https の workers.dev の住所で会社名を含まない形', () => {
  assert.match(relay.RELAY_BASE, /^https:\/\/natsu-relay\.[a-z0-9-]+\.workers\.dev$/);
  const p = relay.relayProvider();
  assert.deepStrictEqual(p, { id: 'openai', label: 'OpenAI', base: relay.RELAY_BASE, host: new URL(relay.RELAY_BASE).hostname, reachUrl: relay.RELAY_BASE + '/health' });
  assert.strictEqual(relay.relayProvider.length, 0, '設定を引数に取る形になった');
});

test('RL9: ログインの口: start → メールのコード → verify で札が返る（me はアプリの口に持たない。設定を開いても外へ通信しないため）', { timeout: 5000 }, async () => {
  await withLocal({}, async (rl) => {
    const api = relay.makeAccountApi({ request: rl.request });
    assert.deepStrictEqual(Object.keys(api).sort(), ['logout', 'start', 'verify'], 'me などの口が増えた');
    const email = R.mail('a');
    assert.deepStrictEqual(await api.start(email), { ok: true });
    const code = rl.codeFor(email);
    assert.match(code, /^\d{6}$/);
    const wrong = code === '000000' ? '111111' : '000000';
    assert.deepStrictEqual(await api.verify(email, wrong), { ok: false, code: 'code', left: 4 });
    const v = await api.verify(email, code);
    assert.deepStrictEqual(Object.keys(v).sort(), ['email', 'expiresAt', 'ok', 'token']);
    assert.strictEqual(v.ok, true);
    assert.match(v.token, TOKEN);
    assert.strictEqual(v.email, email);
    assert.ok(Number.isInteger(v.expiresAt) && v.expiresAt > rl.clock.now() / 1000, String(v.expiresAt));
    // 同じコードの2回目は使えない
    assert.deepStrictEqual(await api.verify(email, code), { ok: false, code: 'code-expired' });
    // 送った要求は全部 RELAY_BASE の道（書き換えの前）で、redirect: 'error'
    assert.deepStrictEqual(rl.sent.map((s) => `${s.method} ${s.url}`), [
      `POST ${relay.RELAY_BASE}/auth/start`, `POST ${relay.RELAY_BASE}/auth/verify`, `POST ${relay.RELAY_BASE}/auth/verify`, `POST ${relay.RELAY_BASE}/auth/verify`]);
    assert.ok(rl.sent.every((s) => s.redirect === 'error'));
  });
});

test('RL9: ログインの口の断り（domain・rate と retryAfter・mail）はそのまま返し、投げない', { timeout: 5000 }, async () => {
  await withLocal({}, async (rl) => {
    const api = relay.makeAccountApi({ request: rl.request });
    assert.deepStrictEqual(await api.start(R.mail('a', 'example.net')), { ok: false, code: 'domain' });
    assert.deepStrictEqual(await api.start('not-an-address'), { ok: false, code: 'bad-email' });
    const b = R.mail('b');
    for (let i = 0; i < 3; i++) assert.deepStrictEqual(await api.start(b), { ok: true });
    const r = await api.start(b);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'rate');
    assert.ok(Number.isInteger(r.retryAfter) && r.retryAfter > 0 && r.retryAfter <= 900, String(r.retryAfter));
    rl.resend.setMode('500');
    assert.deepStrictEqual(await api.start(R.mail('c')), { ok: false, code: 'mail' });
    rl.resend.setMode('ok');
    // 中継の形でない答え（会社の通信の検査のログインの画面）は server
    rl.setFront('html401');
    assert.deepStrictEqual(await api.start(R.mail('d')), { ok: false, code: 'server' });
    assert.deepStrictEqual(await api.verify(R.mail('d'), '123456'), { ok: false, code: 'server' });
  });
});

test('RL9: 中継に届かない（閉じた口・切れた）ときは { ok: false, code: offline | net } で、どれも投げない', { timeout: 5000 }, async () => {
  const base = await closedBase();
  const api = relay.makeAccountApi({ request: makeFakeRequest(), base });
  const s = await api.start(R.mail('a'));
  assert.strictEqual(s.ok, false);
  assert.ok(['offline', 'net'].includes(s.code), s.code);
  const v = await api.verify(R.mail('a'), '123456');
  assert.strictEqual(v.ok, false);
  assert.ok(['offline', 'net'].includes(v.code), v.code);
  assert.deepStrictEqual(await api.logout('nt1_' + 'A'.repeat(43)), { ok: false });
  await withLocal({}, async (rl) => {
    rl.setFront('drop');
    const a2 = relay.makeAccountApi({ request: rl.request });
    assert.deepStrictEqual(await a2.start(R.mail('a')), { ok: false, code: 'net' });
    assert.deepStrictEqual(await a2.logout('nt1_' + 'A'.repeat(43)), { ok: false });
  });
});

// 第1d回 A-11 で意図して変えた: 札の道（Authorization: Bearer）を消したので、文字起こしの試しは全部 Access の cookie の道（偽の session）で送る。
// 前の「logout の後は、その札で文字起こしできない」は、Access の取り消し（Zero Trust の Revoke・ログアウト）の後の login にした
test('RL9・F22: Access で取り消した（Revoke・ログアウト）後は、その cookie で文字起こしできない（login）', { timeout: 5000 }, async () => {
  await withAccess({}, async (rl) => {
    const session = await sessionFor(rl);
    assert.strictEqual(await C.transcribeRelay(wav(1), cookieCall(rl, session)), `${SAID}区間1`);
    rl.revokeAt(R.mail('a'));
    const e = await codeOf(C.transcribeRelay(wav(1), cookieCall(rl, session)));
    assert.ok(e instanceof C.CloudSttError);
    assert.deepStrictEqual([e.code, e.status], ['login', 401]);
    assert.strictEqual(rl.stt.requests.length, 1, '取り消した cookie の要求が中継の後ろへ届いた');
  });
});

test('RL9: transcribeRelay は WAV を生のまま送り、言語とヒントは見出しで渡す（ヒントに改行や % があっても壊れない）', { timeout: 5000 }, async () => {
  await withAccess({ stt: { text: SAID } }, async (rl) => {
    const session = await sessionFor(rl);
    const before = rl.sent.length;
    const w = wav(2);
    assert.strictEqual(await C.transcribeRelay(w, cookieCall(rl, session, { prompt: '見積と予算' })), `${SAID}区間1`);
    const r1 = rl.stt.requests.at(-1);
    assert.deepStrictEqual([r1.fields.model, r1.fields.language, r1.fields.prompt, r1.wavOk], ['gpt-4o-transcribe', 'ja', '見積と予算', true]);
    const s1 = rl.sent[before];
    assert.strictEqual(`${s1.method} ${s1.url}`, `POST ${relay.RELAY_BASE}/v1/audio/transcriptions`);
    assert.strictEqual(s1.redirect, 'manual');
    assert.deepStrictEqual(Object.keys(s1.headers).sort(), ['Content-Type', 'X-Natsu-Language', 'X-Natsu-Prompt', 'X-Requested-With']);
    assert.strictEqual(s1.headers['Content-Type'], 'audio/wav');
    assert.strictEqual(s1.headers['X-Natsu-Language'], 'ja');
    assert.strictEqual(s1.headers['X-Natsu-Prompt'], encodeURIComponent('見積と予算'));
    assert.ok(s1.body.equals(w), '本文が WAV そのものでない');

    const odd = '見積 100%\n予算%E3「𠮷」';
    assert.strictEqual(await C.transcribeRelay(w, cookieCall(rl, session, { prompt: odd, language: 'auto' })), `${SAID}区間2`);
    const r2 = rl.stt.requests.at(-1);
    assert.strictEqual(r2.fields.prompt, odd);
    assert.ok(!('language' in r2.fields), '自動なのに言語を送った');
    const s2 = rl.sent.at(-1);
    assert.ok(!('X-Natsu-Language' in s2.headers), 'auto で X-Natsu-Language を付けた');
    // ヒントが空なら見出しも付けない
    await C.transcribeRelay(w, cookieCall(rl, session, { prompt: '' }));
    assert.ok(!('X-Natsu-Prompt' in rl.sent.at(-1).headers));
    assert.ok(!('prompt' in rl.stt.requests.at(-1).fields));
  });
});

// 第1d回 A-11 で意図して変えた: 文字起こしは札を送らない（cookie の道の見出しは A-10 の「transcribeRelay は session の cookie で送り…」が見る）。
// ログインの口の logout だけが札を Authorization に入れる（A-12 で口ごと消す）
test('RL9: ログインの口の logout は、札を Authorization の見出しにだけ入れる（どの要求の見出し・本文・URL にも、ほかに出ない）・redirect: \'error\'', { timeout: 5000 }, async () => {
  await withLocal({}, async (rl) => {
    const token = await signIn(rl);
    await relay.makeAccountApi({ request: rl.request }).logout(token);
    let auth = 0;
    for (const s of rl.sent) {
      assert.strictEqual(s.redirect, 'error', s.url);
      assert.ok(!s.url.includes(token), 'URL に札');
      assert.ok(!s.body.includes(Buffer.from(token)), `本文に札: ${s.url}`);
      for (const [k, v] of Object.entries(s.headers)) {
        if (k === 'Authorization') { assert.strictEqual(v, `Bearer ${token}`); auth += 1; } else assert.ok(!String(v).includes(token), `見出し ${k} に札`);
      }
    }
    assert.strictEqual(auth, 1, '札を付けたのは logout の1回だけのはず');
    assert.ok(rl.logs.length > 0 && rl.logs.every((l) => !l.includes(token)), '中継の記録に札');
  });
});

test('F5: 符号の分け方 — 札が違えば login、中継の形でない 401 は server、OpenAI の 401 は upstream-auth、500 は server', { timeout: 5000 }, async () => {
  await withAccess({}, async (rl) => {
    const session = await sessionFor(rl);
    // 偽の Access が出していない（知らない）cookie は、Access の前の cf-ray つきの 401 → login
    const stranger = makeFakeSession();
    await stranger.cookies.set({ url: relay.RELAY_BASE, name: 'CF_Authorization', value: 'eyJx.eyJy.z', secure: true, httpOnly: true, sameSite: 'no_restriction' });
    const bad = await codeOf(C.transcribeRelay(wav(1), cookieCall(rl, stranger)));
    assert.deepStrictEqual([bad.code, bad.status], ['login', 401]);
    rl.setFront('html401');
    const foreign = await codeOf(C.transcribeRelay(wav(1), cookieCall(rl, session)));
    assert.deepStrictEqual([foreign.code, foreign.status], ['server', 401], '中継の形でない 401 を login にした（全員の札を消してしまう）');
    rl.setFront('drop');
    assert.strictEqual((await codeOf(C.transcribeRelay(wav(1), cookieCall(rl, session)))).code, 'net');
  });
  await withAccess({ stt: { mode: '401' } }, async (rl) => {
    const session = await sessionFor(rl);
    const e = await codeOf(C.transcribeRelay(wav(1), cookieCall(rl, session)));
    assert.deepStrictEqual([e.code, e.status], ['upstream-auth', 502], '会社の鍵の誤りを利用者のログイン切れと取り違えた');
  });
  await withAccess({ stt: { mode: '500' } }, async (rl) => {
    const session = await sessionFor(rl);
    const e = await codeOf(C.transcribeRelay(wav(1), cookieCall(rl, session)));
    assert.deepStrictEqual([e.code, e.status], ['server', 502]);
  });
});

test('F5: 429（7 秒）は onWait(7) の後に送り直して文字、429-long は rate-long、400-prompt はヒントを外して1回だけ送り直す', { timeout: 5000 }, async () => {
  await withAccess({ stt: { mode: '429', times: 1, retryAfter: '7' } }, async (rl) => {
    const session = await sessionFor(rl);
    const waits = []; const slept = [];
    const text = await C.transcribeRelay(wav(1), cookieCall(rl, session, { onWait: (s) => waits.push(s), sleep: async (ms) => { slept.push(ms); } }));
    assert.strictEqual(text, `${SAID}区間2`);
    assert.deepStrictEqual([waits, slept], [[7], [7000]]);
  });
  await withAccess({ stt: { mode: '429', times: 1, retryAfter: '7' } }, async (rl) => {
    const session = await sessionFor(rl);
    const e = await codeOf(C.transcribeRelay(wav(1), cookieCall(rl, session, { waitCapMs: 5000 })));
    assert.deepStrictEqual([e.code, e.retryAfter], ['rate', 7], '待ちの合計の上限を越えても待った');
    assert.strictEqual(C.redoLocally(e), false, 'rate は WAV を残す（手元でやり直さない）');
  });
  await withAccess({ stt: { mode: '429-long' } }, async (rl) => {
    const session = await sessionFor(rl);
    const e = await codeOf(C.transcribeRelay(wav(1), cookieCall(rl, session)));
    assert.deepStrictEqual([e.code, e.retryAfter], ['rate-long', 3600]);
  });
  await withAccess({ stt: { mode: '400-prompt' } }, async (rl) => {
    const session = await sessionFor(rl);
    let dropped = 0;
    const text = await C.transcribeRelay(wav(1), cookieCall(rl, session, { prompt: '見積と予算', onPromptDropped: () => { dropped += 1; } }));
    assert.strictEqual(text, `${SAID}区間2`);
    assert.strictEqual(dropped, 1);
    const tx = rl.sent.filter((s) => s.url.endsWith('/v1/audio/transcriptions'));
    assert.deepStrictEqual(tx.map((s) => 'X-Natsu-Prompt' in s.headers), [true, false]);
  });
  await withAccess({ stt: { mode: '400' } }, async (rl) => {
    const session = await sessionFor(rl);
    let dropped = 0;
    const e = await codeOf(C.transcribeRelay(wav(1), cookieCall(rl, session, { prompt: '見積', onPromptDropped: () => { dropped += 1; } })));
    assert.deepStrictEqual([e.code, dropped], ['bad-request', 1], 'ヒントを外しても 400 なら bad-request（送り直しは1回だけ）');
  });
});

test('F5: 1日の上限は daily-cap（retryAfter つき）、残高が無ければ quota、大きすぎれば too-large', { timeout: 5000 }, async () => {
  await withAccess({ env: { DAILY_USER_SEC: '1' } }, async (rl) => {
    const session = await sessionFor(rl);
    const e = await codeOf(C.transcribeRelay(wav(2), cookieCall(rl, session)));
    assert.deepStrictEqual([e.code, e.status, e.scope], ['daily-cap', 429, 'user']);
    assert.ok(Number.isInteger(e.retryAfter) && e.retryAfter > 0 && e.retryAfter <= 86400, String(e.retryAfter));
  });
  await withAccess({ stt: { mode: 'quota' } }, async (rl) => {
    const session = await sessionFor(rl);
    const e = await codeOf(C.transcribeRelay(wav(1), cookieCall(rl, session)));
    assert.deepStrictEqual([e.code, e.status], ['quota', 503]);
  });
  await withAccess({ env: { MAX_AUDIO_BYTES: '40000' } }, async (rl) => {
    const session = await sessionFor(rl);
    assert.strictEqual((await codeOf(C.transcribeRelay(wav(2), cookieCall(rl, session)))).code, 'too-large');
  });
});

test('F5: redoLocally が偽なのは rate・rate-long だけ（ほかは全部、その区間を手元でやり直す）', () => {
  const E = (code) => new C.CloudSttError(code);
  for (const code of ['rate', 'rate-long']) assert.strictEqual(C.redoLocally(E(code)), false, code);
  for (const code of ['offline', 'cert', 'proxy', 'timeout', 'net', 'login', 'denied', 'server', 'upstream-auth', 'quota', 'daily-cap',
    'too-large', 'bad-request', 'bad-reply', 'zzz-unknown']) assert.strictEqual(C.redoLocally(E(code)), true, code);
  assert.strictEqual(C.redoLocally(new Error('x')), true, 'CloudSttError でない失敗も手元で');
  assert.strictEqual(C.redoLocally(null), true);
});

test('F5: relayErrorCode は中継の JSON の error の符号だけを読む（ほかは \'\'）', () => {
  assert.strictEqual(C.relayErrorCode(Buffer.from('{"error":"login"}')), 'login');
  assert.strictEqual(C.relayErrorCode('{"error":"daily-cap","scope":"user","retryAfter":5}'), 'daily-cap');
  for (const b of ['<html>Sign in</html>', '', '{"error":{"code":"invalid_api_key"}}', '{"error":"LOGIN"}', '{"error":"' + 'a'.repeat(25) + '"}', '[1]', 'null', null, undefined]) {
    assert.strictEqual(C.relayErrorCode(b), '', String(b));
  }
});

test('RL9: 200 でも中継の約束の形でない答えは bad-reply（札の形でないものを札として返さない）', { timeout: 5000 }, async () => {
  const replies = [
    { token: 'x', email: R.mail('a'), expiresAt: 1 },
    { token: 'nt1_' + 'A'.repeat(42), email: R.mail('a'), expiresAt: 1 },
    { token: 'nt1_' + 'A'.repeat(43), expiresAt: 1 },
    { token: 'nt1_' + 'A'.repeat(43), email: R.mail('a'), expiresAt: '1' },
  ];
  let i = 0;
  const s = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/auth/verify' ? { ok: true, ...replies[i++] } : { queued: true }));
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const api = relay.makeAccountApi({ request: makeFakeRequest(), base: `http://127.0.0.1:${s.address().port}` });
    assert.deepStrictEqual(await api.start(R.mail('a')), { ok: false, code: 'bad-reply' });
    for (const r of replies) assert.deepStrictEqual(await api.verify(R.mail('a'), '123456'), { ok: false, code: 'bad-reply' }, JSON.stringify(r));
  } finally {
    await new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });
  }
});

// ================= 第1d回 A-10（RL9・F19・F21）: Access の cookie の道 =================
const HOST = new URL(relay.RELAY_BASE).hostname;

async function withAccess(opts, fn) {
  const rl = await startRelayLocal({ ...opts, access: true });
  try { return await fn(rl); } finally { await rl.close(); }
}
// 偽の Access がその人に出した CF_Authorization を、偽の session（メモリの partition の代わり）に置く
async function sessionFor(rl, email = R.mail('a'), opts) {
  const s = makeFakeSession();
  await s.cookies.set(await rl.cookieFor(email, opts));
  return s;
}
const cookieCall = (rl, session, extra = {}) => ({ request: rl.request, provider: relay.relayProvider(), session, language: 'ja', prompt: '', sleep: noSleep, ...extra });

test('RL9: Access の名前と形（ACCESS_PARTITION は persist: の無いメモリの partition・LOGIN_URL・LOGOUT_URL は中継の住所の下）', () => {
  assert.strictEqual(relay.ACCESS_PARTITION, 'natsu-access');
  assert.ok(!relay.ACCESS_PARTITION.startsWith('persist:'), 'cookie をディスクに置く partition になった（F21）');
  assert.strictEqual(relay.LOGIN_URL, relay.RELAY_BASE + '/auth/done');
  assert.strictEqual(relay.LOGOUT_URL, relay.RELAY_BASE + '/cdn-cgi/access/logout');
  assert.strictEqual(relay.classifyAuth, C.classifyAuth, 'classifyAuth は stt-cloud と同じ1つ');
  assert.strictEqual(relay.isAccessHost, C.isAccessHost);
});

test('RL9・F21: transcribeRelay は session の cookie で送り、Authorization も cf-access-token も付けない。X-Requested-With: XMLHttpRequest と redirect: \'manual\' が付く', { timeout: 5000 }, async () => {
  await withAccess({ stt: { text: SAID } }, async (rl) => {
    const session = await sessionFor(rl);
    const cookie = (await session.cookies.get({ name: 'CF_Authorization' }))[0].value;
    const w = wav(1);
    assert.strictEqual(await C.transcribeRelay(w, cookieCall(rl, session, { prompt: '見積' })), `${SAID}区間1`);
    const s = rl.sent.at(-1);
    assert.strictEqual(`${s.method} ${s.url}`, `POST ${relay.RELAY_BASE}/v1/audio/transcriptions`);
    assert.deepStrictEqual([s.redirect, s.useSessionCookies, s.session === session], ['manual', true, true]);
    assert.deepStrictEqual(Object.keys(s.headers).sort(), ['Content-Type', 'X-Natsu-Language', 'X-Natsu-Prompt', 'X-Requested-With']);
    assert.strictEqual(s.headers['X-Requested-With'], 'XMLHttpRequest');
    assert.ok(s.body.equals(w), '本文が WAV そのものでない');
    // 線の上（偽の Access の前が受けた要求）では、cookie は Cookie の見出しにだけある（アプリは見出しに札を入れない）
    const got = rl.received.at(-1);
    assert.strictEqual(got.path, '/v1/audio/transcriptions');
    assert.ok(String(got.headers.cookie).split('; ').includes('CF_Authorization=' + cookie), 'cookie が届いていない');
    assert.ok(!('authorization' in got.headers) && !('cf-access-token' in got.headers), '見出しに札を入れた');
    assert.strictEqual(got.headers['x-requested-with'], 'XMLHttpRequest');
    // アプリが組んだ見出し・URL・本文に cookie の値は無い（Chromium が付ける）
    for (const x of rl.sent) {
      assert.ok(!x.url.includes(cookie) && !x.body.includes(Buffer.from(cookie)), 'URL か本文に cookie');
      for (const v of Object.values(x.headers)) assert.ok(!String(v).includes(cookie), '見出しに cookie');
    }
    // Worker 単位の Access が Cf-Access-Jwt-Assertion を付けず Cookie だけを渡す形でも通る
    rl.setFront('cookie-only');
    assert.strictEqual(await C.transcribeRelay(w, cookieCall(rl, session)), `${SAID}区間2`);
    assert.strictEqual(rl.stt.requests.length, 2);
    // cookie の無い session は Access の前で止まり（X-Requested-With があるので 401）、中継の後ろの OpenAI へは行かない
    rl.setFront('');
    const e = await codeOf(C.transcribeRelay(w, cookieCall(rl, makeFakeSession())));
    assert.deepStrictEqual([e.code, e.status], ['login', 401]);
    assert.strictEqual(rl.stt.requests.length, 2);
  });
});

// 第1d回 A-11（RL9・RF32）: 札の道を消した。札（token）を渡されても見出しに入れず、いつも redirect: 'manual'（転送について行かない）で送る
test('RL9: transcribeRelay は札（token）を渡されても Authorization を付けず、session が無くても redirect: \'manual\'（札の道は無い）', { timeout: 5000 }, async () => {
  await withAccess({}, async (rl) => {
    const token = 'nt1_' + 'A'.repeat(43);
    const e = await codeOf(C.transcribeRelay(wav(1), { ...cookieCall(rl, null), token }));
    const s = rl.sent.at(-1);
    assert.ok(!('Authorization' in s.headers), '札を Authorization に入れた');
    assert.ok(!Object.values(s.headers).some((v) => String(v).includes(token)), '見出しに札');
    assert.strictEqual(s.redirect, 'manual');
    // cookie の無い要求は Access の前で止まる（X-Requested-With が無いので 302 → ついて行かずに login）
    assert.deepStrictEqual([e.code, e.status], ['login', 302]);
    assert.strictEqual(rl.stt.requests.length, 0);
  });
});

test('F19: cf-ray のある中継の形でない 401 → login・cf-ray の無い HTML の 401 → server・302 で行き先が *.cloudflareaccess.com → login（ついて行かない）・ほかの 302 → server・中継の JSON の 403 denied → denied・cf-ray のある中継の形でない 403 → server・中継の JSON の 503 not-ready → server', { timeout: 5000 }, async () => {
  await withAccess({}, async (rl) => {
    const email = R.mail('a');
    const session = await sessionFor(rl, email);
    const codeFor = async (s = session) => { const e = await codeOf(C.transcribeRelay(wav(1), cookieCall(rl, s))); return [e.code, e.status]; };
    rl.setFront('access401');
    assert.deepStrictEqual(await codeFor(), ['login', 401], 'Access の前の 401');
    rl.setFront('html401');
    assert.deepStrictEqual(await codeFor(), ['server', 401], '会社の通信の検査の 401 をログイン切れにした（全員のログインを消してしまう）');
    rl.setFront('access302');
    const before = rl.received.length;
    assert.deepStrictEqual(await codeFor(), ['login', 302], 'Access のログインの画面への 302');
    assert.strictEqual(rl.received.length, before + 1, '302 の後にもう一度送った');
    rl.setFront('redirect-other');
    assert.deepStrictEqual(await codeFor(), ['server', 302], 'ほかのホストへの 302 をログイン切れにした');
    rl.setFront('access403');
    assert.deepStrictEqual(await codeFor(), ['server', 403], 'cf-ray のある 403 を denied にした（Cloudflare の 403 は Access のほかにも出る）');
    rl.setFront('');
    assert.deepStrictEqual(await codeFor(await sessionFor(rl, R.mail('a', 'example.net'))), ['denied', 403], '中継の 403 denied');
    // Zero Trust の Revoke と同じ: 偽の Access の前がその人の cookie を断る → X-Requested-With があるので cf-ray つきの 401
    rl.revokeAt(email);
    assert.deepStrictEqual(await codeFor(), ['login', 401]);
    assert.strictEqual(rl.stt.requests.length, 0, 'どれも OpenAI へ送っていない');
  });
  // 秘密の欄の入れ間違い（POLICY_AUD が別の app のもの）は中継の 503 not-ready → server（cookie を残す: F28）
  await withAccess({ env: { POLICY_AUD: 'f'.repeat(64) } }, async (rl) => {
    const e = await codeOf(C.transcribeRelay(wav(1), cookieCall(rl, await sessionFor(rl))));
    assert.deepStrictEqual([e.code, e.status], ['server', 503]);
    assert.strictEqual(C.redoLocally(e), true);
  });
});

test('F19: classifyAuth の表（cf-ray は見出しがあるかだけを見る。3xx は行き先のホストだけ）', () => {
  const A = C.classifyAuth;
  const j = (o) => Buffer.from(JSON.stringify(o));
  assert.strictEqual(A({ status: 401, headers: {}, body: j({ error: 'login' }) }), 'login');
  assert.strictEqual(A({ status: 401, headers: { 'cf-ray': ['8c0ffee-NRT'] }, body: Buffer.from('<html>Forbidden</html>') }), 'login');
  assert.strictEqual(A({ status: 401, headers: { 'cf-ray': '' }, body: Buffer.from('<html></html>') }), 'login', 'cf-ray の値は見ない');
  assert.strictEqual(A({ status: 401, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>Sign in</html>') }), 'server');
  assert.strictEqual(A({ status: 401, headers: { 'cf-ray': 'x' }, body: j({ error: 'other' }) }), 'server', '中継の形の 401 で login でない');
  assert.strictEqual(A({ status: 403, headers: { 'cf-ray': 'x' }, body: j({ error: 'denied' }) }), 'denied');
  assert.strictEqual(A({ status: 403, headers: { 'cf-ray': 'x' }, body: Buffer.from('<html>Access denied</html>') }), 'server');
  assert.strictEqual(A({ status: 403, headers: {}, body: j({ error: 'service' }) }), 'server');
  for (const st of [301, 302, 303, 307, 308]) {
    assert.strictEqual(A({ status: st, headers: {}, location: 'https://natsu-test.cloudflareaccess.com/cdn-cgi/access/login/x?kid=1' }), 'login', String(st));
    assert.strictEqual(A({ status: st, headers: {}, location: 'https://proxy.example/block' }), 'server', String(st));
  }
  for (const loc of ['https://cloudflareaccess.com/x', 'https://cloudflareaccess.com.evil.example/x', '/cdn-cgi/access/login', '', undefined, 'not a url']) {
    assert.strictEqual(A({ status: 302, headers: {}, location: loc }), 'server', String(loc));
  }
  for (const st of [200, 400, 413, 429, 500, 502, 503]) assert.strictEqual(A({ status: st, headers: { 'cf-ray': 'x' }, body: j({ error: 'login' }) }), '', String(st));
  assert.strictEqual(A({}), '');
});

test('RL9: makeAccessApi.me() は cookie で /v1/me を開き { ok, email, exp, via }。401 → login・403 → denied・届かない → 通信の符号（投げない）', { timeout: 5000 }, async () => {
  await withAccess({}, async (rl) => {
    const email = R.mail('a');
    const session = await sessionFor(rl, email);
    const api = relay.makeAccessApi({ request: rl.request, session });
    assert.deepStrictEqual(Object.keys(api), ['me'], 'ほかの口が増えた');
    const m = await api.me();
    assert.deepStrictEqual(Object.keys(m).sort(), ['email', 'exp', 'ok', 'via']);
    assert.deepStrictEqual([m.ok, m.email, m.via], [true, email, 'hdr']);
    assert.ok(Number.isInteger(m.exp) && m.exp > rl.clock.now() / 1000, String(m.exp));
    const s = rl.sent.at(-1);
    assert.deepStrictEqual([`${s.method} ${s.url}`, s.redirect, s.useSessionCookies, s.session === session],
      [`GET ${relay.RELAY_BASE}/v1/me`, 'manual', true, true]);
    assert.deepStrictEqual(s.headers, { 'X-Requested-With': 'XMLHttpRequest' });
    rl.setFront('cookie-only');
    assert.strictEqual((await api.me()).via, 'cookie');
    rl.setFront('access302');
    assert.deepStrictEqual(await api.me(), { ok: false, code: 'login' });
    rl.setFront('redirect-other');
    assert.deepStrictEqual(await api.me(), { ok: false, code: 'server' });
    rl.setFront('html401');
    assert.deepStrictEqual(await api.me(), { ok: false, code: 'server' });
    rl.setFront('drop');
    assert.deepStrictEqual(await api.me(), { ok: false, code: 'net' });
    rl.setFront('');
    assert.deepStrictEqual(await relay.makeAccessApi({ request: rl.request, session: makeFakeSession() }).me(), { ok: false, code: 'login' }, 'cookie が無い');
    assert.deepStrictEqual(await relay.makeAccessApi({ request: rl.request, session: await sessionFor(rl, R.mail('b', 'example.net')) }).me(), { ok: false, code: 'denied' });
    rl.revokeAt(email);
    assert.deepStrictEqual(await api.me(), { ok: false, code: 'login' });
  });
  await withAccess({ env: { POLICY_AUD: 'e'.repeat(64) } }, async (rl) => {
    assert.deepStrictEqual(await relay.makeAccessApi({ request: rl.request, session: await sessionFor(rl) }).me(), { ok: false, code: 'not-ready' });
  });
  const base = await closedBase();
  const r = await relay.makeAccessApi({ request: makeFakeRequest(), session: makeFakeSession(), base }).me();
  assert.strictEqual(r.ok, false);
  assert.ok(['offline', 'net'].includes(r.code), r.code);
});

test('RL9: makeAccessApi.me() は 200 でも形の違う答え（email が文字でない・exp が整数でない・via が知らない値・JSON でない）を bad-reply にする', { timeout: 5000 }, async () => {
  const replies = [{ email: 1, exp: 1, via: 'hdr' }, { email: R.mail('a'), exp: '1', via: 'hdr' }, { email: R.mail('a'), exp: 1, via: 'ctx' }, 'not json', [1]];
  let i = 0;
  const s = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const r = replies[i++];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(typeof r === 'string' ? r : JSON.stringify(r));
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const api = relay.makeAccessApi({ request: makeFakeRequest(), session: makeFakeSession(), base: `http://127.0.0.1:${s.address().port}` });
    for (const r of replies) assert.deepStrictEqual(await api.me(), { ok: false, code: 'bad-reply' }, JSON.stringify(r));
  } finally {
    await new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });
  }
});

const ck = (o = {}) => ({ name: 'CF_Authorization', value: 'aa.bb.cc', domain: HOST, hostOnly: true, path: '/', secure: true, httpOnly: true,
  session: false, sameSite: 'no_restriction', expirationDate: 2000000000.5, ...o });

test('F21: packCookies は中継のホストちょうど（host-only か \'.\' ＋中継のホスト）の CF_Authorization と CF_Binding だけ（親のドメイン・ほかのホスト・CF_AppSession などほかの名前は捨てる）・CF_Authorization が無ければ \'\'・8KB まで・until は me() の exp', () => {
  const text = relay.packCookies([
    ck(),
    ck({ name: 'CF_Binding', value: 'bind1' }),
    ck({ name: 'CF_AppSession', value: 'app1' }),
    ck({ name: 'CF_Other', value: 'oth1' }),
    ck({ domain: '.natsu-code.workers.dev', hostOnly: false, value: 'parent1' }),
    ck({ domain: 'other.example', value: 'other1' }),
    ck({ domain: HOST + '.evil.example', value: 'evil1' }),
    ck({ domain: '.' + HOST, hostOnly: false, value: 'dot1', sameSite: 'lax', httpOnly: false }),
  ], { exp: 1900000000 });
  const j = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(j), ['v', 'until', 'c']);
  assert.deepStrictEqual([j.v, j.until], [1, 1900000000]);
  assert.deepStrictEqual(j.c.map((c) => [c.name, c.value, c.domain, c.hostOnly]),
    [['CF_Authorization', 'aa.bb.cc', HOST, true], ['CF_Binding', 'bind1', HOST, true], ['CF_Authorization', 'dot1', '.' + HOST, false]]);
  assert.deepStrictEqual(j.c[0], { name: 'CF_Authorization', value: 'aa.bb.cc', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction',
    hostOnly: true, domain: HOST, expirationDate: 2000000000.5 });
  assert.deepStrictEqual([j.c[2].sameSite, j.c[2].httpOnly], ['lax', false]);
  for (const w of ['app1', 'oth1', 'parent1', 'other1', 'evil1']) assert.ok(!text.includes(w), `${w} をしまった`);
  // CF_Authorization が無い・名前の大文字小文字が違う・値が 8KB を越える・値が空 → ''
  assert.strictEqual(relay.packCookies([ck({ name: 'CF_Binding' })], { exp: 1 }), '');
  assert.strictEqual(relay.packCookies([ck({ name: 'cf_authorization' })], { exp: 1 }), '');
  assert.strictEqual(relay.packCookies([ck({ value: 'a'.repeat(8193) })], { exp: 1 }), '');
  assert.ok(relay.packCookies([ck({ value: 'a'.repeat(8192) })], { exp: 1 }).length > 8192);
  assert.strictEqual(relay.packCookies([ck({ value: '' })], { exp: 1 }), '');
  assert.strictEqual(relay.packCookies([ck({ value: 'a;b' })], { exp: 1 }), '');
  assert.strictEqual(relay.packCookies([], { exp: 1 }), '');
  assert.strictEqual(relay.packCookies(null), '');
  // until: exp が無ければ、しまう cookie のいちばん早い expirationDate（秒）。それも無ければ null
  assert.strictEqual(JSON.parse(relay.packCookies([ck({ expirationDate: 1800000000.9 }), ck({ name: 'CF_Binding', expirationDate: 1700000000.2 })])).until, 1700000000);
  assert.strictEqual(JSON.parse(relay.packCookies([ck({ expirationDate: undefined, session: true })], {})).until, null);
  assert.ok(!('expirationDate' in JSON.parse(relay.packCookies([ck({ expirationDate: undefined })], {})).c[0]));
});

test('F21: unpackCookies は期限の切れたものを expired、nt1_ の前の試しの札を old、壊れた形を shape にし、名前と domain の照らしをもう一度かける', () => {
  const text = relay.packCookies([ck(), ck({ name: 'CF_Binding', value: 'bind1' })], { exp: 1900000000 });
  const u = relay.unpackCookies(text, 1800000000);
  assert.deepStrictEqual(Object.keys(u).sort(), ['cookies', 'ok', 'until']);
  assert.deepStrictEqual([u.ok, u.until, u.cookies.map((c) => c.name)], [true, 1900000000, ['CF_Authorization', 'CF_Binding']]);
  assert.deepStrictEqual(relay.unpackCookies(text, 1900000000), { ok: false, why: 'expired' });
  assert.deepStrictEqual(relay.unpackCookies(text, 1900000001), { ok: false, why: 'expired' });
  // until が null（期限の分からない cookie）は切れていない
  const noUntil = relay.packCookies([ck({ expirationDate: undefined })], {});
  assert.strictEqual(relay.unpackCookies(noUntil, 1900000000).ok, true);
  assert.deepStrictEqual(relay.unpackCookies('nt1_' + 'A'.repeat(43), 1), { ok: false, why: 'old' });
  for (const bad of ['', '{', 'null', '[]', '{"v":2,"until":null,"c":[]}', '{"v":1,"until":"x","c":[]}', '{"v":1,"until":null,"c":{}}', null, undefined, 7]) {
    assert.deepStrictEqual(relay.unpackCookies(bad, 1), { ok: false, why: 'shape' }, String(bad));
  }
  // しまった文字が書き換えられて、親のドメインやほかの名前の cookie だけになっていたら戻さない
  const forged = JSON.stringify({ v: 1, until: null, c: [{ ...ck({ domain: '.natsu-code.workers.dev', hostOnly: false }) }, { ...ck({ name: 'CF_AppSession' }) }] });
  assert.deepStrictEqual(relay.unpackCookies(forged, 1), { ok: false, why: 'shape' });
  const mixed = JSON.stringify({ v: 1, until: null, c: [ck(), ck({ name: 'CF_AppSession', value: 'app1' }), ck({ domain: 'other.example', value: 'o1' })] });
  const m = relay.unpackCookies(mixed, 1);
  assert.deepStrictEqual(m.cookies.map((c) => [c.name, c.value]), [['CF_Authorization', 'aa.bb.cc']]);
});

test('RL9: loginNavAllowed は https の中継のホストと *.cloudflareaccess.com だけ。pinnedAccessHost を渡すと、ほかのチームの *.cloudflareaccess.com は偽', () => {
  const T = 'natsu-test.cloudflareaccess.com';
  for (const u of [relay.LOGIN_URL, relay.RELAY_BASE + '/cdn-cgi/access/authorized?x=1', `https://${T}/cdn-cgi/access/login/natsu`, `https://${T}/`]) {
    assert.strictEqual(relay.loginNavAllowed(u), true, u);
  }
  for (const u of [`http://${HOST}/auth/done`, 'https://other.example/', `https://${HOST}.evil.example/`, 'https://natsu-relay.natsu-code.workers.dev.evil.example/',
    'https://cloudflareaccess.com.evil.example/', 'https://cloudflareaccess.com/', `http://${T}/`, `https://${HOST}:8443/`, `https://${T}:8443/`,
    `https://user:pw@${HOST}/`, 'https://a.b.cloudflareaccess.com/', 'https://natsu-code.workers.dev/', 'javascript:alert(1)', 'file:///C:/x', '', 'not a url', null, undefined]) {
    assert.strictEqual(relay.loginNavAllowed(u), false, String(u));
  }
  assert.strictEqual(relay.loginNavAllowed(`https://${T}/x`, T), true);
  assert.strictEqual(relay.loginNavAllowed('https://other-team.cloudflareaccess.com/x', T), false, 'ほかのチームへ行けた');
  assert.strictEqual(relay.loginNavAllowed(relay.LOGIN_URL, T), true, '留めても中継へは戻れる');
  assert.strictEqual(relay.isAccessHost(T), true);
  for (const h of ['cloudflareaccess.com', 'x.cloudflareaccess.com.evil.example', '-x.cloudflareaccess.com', 'X.cloudflareaccess.com.', '', null, 3]) {
    assert.strictEqual(relay.isAccessHost(h), false, String(h));
  }
});
