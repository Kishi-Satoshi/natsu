/*
 * relay-app.test.js — 第1d回 RL9・F5: アプリの中継の口（src/relay.js のログインの口と、stt-cloud.transcribeRelay）を、
 * 本物の中継のコード（relay/worker.mjs）を 127.0.0.1 で動かした台（helpers/relay-local.js）を相手に試す。
 * アプリの側は偽の net.request（helpers/fake-net.js）で送り、RELAY_BASE を 127.0.0.1 の中継へ書き換える。外へはつながない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { makeFakeRequest } = require('./helpers/fake-net');
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

const sttCall = (rl, extra = {}) => ({ request: rl.request, provider: relay.relayProvider(), language: 'ja', prompt: '', sleep: noSleep, ...extra });

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

test('RL9: logout の後は、その札で文字起こしできない（login）', { timeout: 5000 }, async () => {
  await withLocal({}, async (rl) => {
    const token = await signIn(rl);
    assert.strictEqual(await C.transcribeRelay(wav(1), sttCall(rl, { token })), `${SAID}区間1`);
    const api = relay.makeAccountApi({ request: rl.request });
    assert.deepStrictEqual(await api.logout(token), { ok: true });
    assert.deepStrictEqual(await api.logout(token), { ok: true }, '何回でも同じ');
    const e = await codeOf(C.transcribeRelay(wav(1), sttCall(rl, { token })));
    assert.ok(e instanceof C.CloudSttError);
    assert.strictEqual(e.code, 'login');
  });
});

test('RL9: transcribeRelay は WAV を生のまま送り、言語とヒントは見出しで渡す（ヒントに改行や % があっても壊れない）', { timeout: 5000 }, async () => {
  await withLocal({ stt: { text: SAID } }, async (rl) => {
    const token = await signIn(rl);
    const before = rl.sent.length;
    const w = wav(2);
    assert.strictEqual(await C.transcribeRelay(w, sttCall(rl, { token, prompt: '見積と予算' })), `${SAID}区間1`);
    const r1 = rl.stt.requests.at(-1);
    assert.deepStrictEqual([r1.fields.model, r1.fields.language, r1.fields.prompt, r1.wavOk], ['gpt-4o-transcribe', 'ja', '見積と予算', true]);
    const s1 = rl.sent[before];
    assert.strictEqual(`${s1.method} ${s1.url}`, `POST ${relay.RELAY_BASE}/v1/audio/transcriptions`);
    assert.strictEqual(s1.redirect, 'error');
    assert.deepStrictEqual(Object.keys(s1.headers).sort(), ['Authorization', 'Content-Type', 'X-Natsu-Language', 'X-Natsu-Prompt']);
    assert.strictEqual(s1.headers['Content-Type'], 'audio/wav');
    assert.strictEqual(s1.headers['X-Natsu-Language'], 'ja');
    assert.strictEqual(s1.headers['X-Natsu-Prompt'], encodeURIComponent('見積と予算'));
    assert.ok(s1.body.equals(w), '本文が WAV そのものでない');

    const odd = '見積 100%\n予算%E3「𠮷」';
    assert.strictEqual(await C.transcribeRelay(w, sttCall(rl, { token, prompt: odd, language: 'auto' })), `${SAID}区間2`);
    const r2 = rl.stt.requests.at(-1);
    assert.strictEqual(r2.fields.prompt, odd);
    assert.ok(!('language' in r2.fields), '自動なのに言語を送った');
    const s2 = rl.sent.at(-1);
    assert.ok(!('X-Natsu-Language' in s2.headers), 'auto で X-Natsu-Language を付けた');
    // ヒントが空なら見出しも付けない
    await C.transcribeRelay(w, sttCall(rl, { token, prompt: '' }));
    assert.ok(!('X-Natsu-Prompt' in rl.sent.at(-1).headers));
    assert.ok(!('prompt' in rl.stt.requests.at(-1).fields));
  });
});

test('RL9: 札は Authorization の見出しにだけ入る（どの要求の見出し・本文・URL にも、ほかに出ない）・redirect: \'error\'', { timeout: 5000 }, async () => {
  await withLocal({}, async (rl) => {
    const token = await signIn(rl);
    await C.transcribeRelay(wav(1), sttCall(rl, { token, prompt: '見積' }));
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
    assert.strictEqual(auth, 2, '札を付けたのは文字起こしと logout の2回だけのはず');
    assert.ok(rl.logs.length > 0 && rl.logs.every((l) => !l.includes(token)), '中継の記録に札');
  });
});

test('F5: 符号の分け方 — 札が違えば login、中継の形でない 401 は server、OpenAI の 401 は upstream-auth、500 は server', { timeout: 5000 }, async () => {
  await withLocal({}, async (rl) => {
    const token = await signIn(rl);
    const bad = await codeOf(C.transcribeRelay(wav(1), sttCall(rl, { token: 'nt1_' + 'A'.repeat(43) })));
    assert.deepStrictEqual([bad.code, bad.status], ['login', 401]);
    rl.setFront('html401');
    const foreign = await codeOf(C.transcribeRelay(wav(1), sttCall(rl, { token })));
    assert.deepStrictEqual([foreign.code, foreign.status], ['server', 401], '中継の形でない 401 を login にした（全員の札を消してしまう）');
    rl.setFront('drop');
    assert.strictEqual((await codeOf(C.transcribeRelay(wav(1), sttCall(rl, { token })))).code, 'net');
  });
  await withLocal({ stt: { mode: '401' } }, async (rl) => {
    const token = await signIn(rl);
    const e = await codeOf(C.transcribeRelay(wav(1), sttCall(rl, { token })));
    assert.deepStrictEqual([e.code, e.status], ['upstream-auth', 502], '会社の鍵の誤りを利用者のログイン切れと取り違えた');
  });
  await withLocal({ stt: { mode: '500' } }, async (rl) => {
    const token = await signIn(rl);
    const e = await codeOf(C.transcribeRelay(wav(1), sttCall(rl, { token })));
    assert.deepStrictEqual([e.code, e.status], ['server', 502]);
  });
});

test('F5: 429（7 秒）は onWait(7) の後に送り直して文字、429-long は rate-long、400-prompt はヒントを外して1回だけ送り直す', { timeout: 5000 }, async () => {
  await withLocal({ stt: { mode: '429', times: 1, retryAfter: '7' } }, async (rl) => {
    const token = await signIn(rl);
    const waits = []; const slept = [];
    const text = await C.transcribeRelay(wav(1), sttCall(rl, { token, onWait: (s) => waits.push(s), sleep: async (ms) => { slept.push(ms); } }));
    assert.strictEqual(text, `${SAID}区間2`);
    assert.deepStrictEqual([waits, slept], [[7], [7000]]);
  });
  await withLocal({ stt: { mode: '429', times: 1, retryAfter: '7' } }, async (rl) => {
    const token = await signIn(rl);
    const e = await codeOf(C.transcribeRelay(wav(1), sttCall(rl, { token, waitCapMs: 5000 })));
    assert.deepStrictEqual([e.code, e.retryAfter], ['rate', 7], '待ちの合計の上限を越えても待った');
    assert.strictEqual(C.redoLocally(e), false, 'rate は WAV を残す（手元でやり直さない）');
  });
  await withLocal({ stt: { mode: '429-long' } }, async (rl) => {
    const token = await signIn(rl);
    const e = await codeOf(C.transcribeRelay(wav(1), sttCall(rl, { token })));
    assert.deepStrictEqual([e.code, e.retryAfter], ['rate-long', 3600]);
  });
  await withLocal({ stt: { mode: '400-prompt' } }, async (rl) => {
    const token = await signIn(rl);
    let dropped = 0;
    const text = await C.transcribeRelay(wav(1), sttCall(rl, { token, prompt: '見積と予算', onPromptDropped: () => { dropped += 1; } }));
    assert.strictEqual(text, `${SAID}区間2`);
    assert.strictEqual(dropped, 1);
    const tx = rl.sent.filter((s) => s.url.endsWith('/v1/audio/transcriptions'));
    assert.deepStrictEqual(tx.map((s) => 'X-Natsu-Prompt' in s.headers), [true, false]);
  });
  await withLocal({ stt: { mode: '400' } }, async (rl) => {
    const token = await signIn(rl);
    let dropped = 0;
    const e = await codeOf(C.transcribeRelay(wav(1), sttCall(rl, { token, prompt: '見積', onPromptDropped: () => { dropped += 1; } })));
    assert.deepStrictEqual([e.code, dropped], ['bad-request', 1], 'ヒントを外しても 400 なら bad-request（送り直しは1回だけ）');
  });
});

test('F5: 1日の上限は daily-cap（retryAfter つき）、残高が無ければ quota、大きすぎれば too-large', { timeout: 5000 }, async () => {
  await withLocal({ env: { DAILY_USER_SEC: '1' } }, async (rl) => {
    const token = await signIn(rl);
    const e = await codeOf(C.transcribeRelay(wav(2), sttCall(rl, { token })));
    assert.deepStrictEqual([e.code, e.status, e.scope], ['daily-cap', 429, 'user']);
    assert.ok(Number.isInteger(e.retryAfter) && e.retryAfter > 0 && e.retryAfter <= 86400, String(e.retryAfter));
  });
  await withLocal({ stt: { mode: 'quota' } }, async (rl) => {
    const token = await signIn(rl);
    const e = await codeOf(C.transcribeRelay(wav(1), sttCall(rl, { token })));
    assert.deepStrictEqual([e.code, e.status], ['quota', 503]);
  });
  await withLocal({ env: { MAX_AUDIO_BYTES: '40000' } }, async (rl) => {
    const token = await signIn(rl);
    assert.strictEqual((await codeOf(C.transcribeRelay(wav(2), sttCall(rl, { token })))).code, 'too-large');
  });
});

test('F5: redoLocally が偽なのは rate・rate-long だけ（ほかは全部、その区間を手元でやり直す）', () => {
  const E = (code) => new C.CloudSttError(code);
  for (const code of ['rate', 'rate-long']) assert.strictEqual(C.redoLocally(E(code)), false, code);
  for (const code of ['offline', 'cert', 'proxy', 'timeout', 'net', 'login', 'server', 'upstream-auth', 'quota', 'daily-cap',
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
