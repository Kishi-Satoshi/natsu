/*
 * stt-cloud.test.js — 文字起こしの口（src/stt-cloud.js。第1c回 OL2・RF27・RF29・RF30・F15）
 *
 * 第1d回 A-4（RL11・F11）で意図して変えた: PC から OpenAI へ直に送る道（transcribeCloud・resolveProvider・fixedProvider・checkKey・
 * keyErrorKind・CHECK_WAV）を消したので、その試しを外し、同じ意図（429 の待ち・待ちの上限・ヒントの 400 の送り直し・413・5xx・
 * 通信の失敗の分け方・札を運ばない）を transcribeRelay で、本物の中継のコード（helpers/relay-local.js）を相手に見る。
 * 中継の符号の分け方（login・upstream-auth・daily-cap・quota）は test/relay-app.test.js が見る。外へはつながない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeFakeRequest } = require('./helpers/fake-net');
const R = require('./helpers/relay-run');
const relay = require('../src/relay');
const C = require('../src/stt-cloud');
const { startRelayLocal } = require('./helpers/relay-local');

const wav = (sec) => Buffer.from(R.wav(sec));
const SAID = /^本日の議題は進捗の確認です。区間\d+$/;

// 中継を起こしてログインし、札で fn(rl, call) を呼ぶ。call(extra) は transcribeRelay の引数
async function withRelay(stt, fn) {
  const rl = await startRelayLocal({ stt });
  try {
    const api = relay.makeAccountApi({ request: rl.request });
    const email = R.mail('stt');
    assert.deepStrictEqual(await api.start(email), { ok: true });
    const v = await api.verify(email, rl.codeFor(email));
    assert.strictEqual(v.ok, true, JSON.stringify(v));
    const call = (extra = {}) => ({ request: rl.request, provider: relay.relayProvider(), token: v.token, language: 'ja', prompt: '', sleep: async () => {}, ...extra });
    return await fn(rl, call, v.token);
  } finally { await rl.close(); }
}
const posts = (rl) => rl.stt.requests.filter((x) => x.path.endsWith('/audio/transcriptions'));

test('F11: PRESETS は名前だけ（id・label）。PC から OpenAI・Groq へ直に送る道（送り先の URL・鍵の確かめ）は無い', () => {
  assert.deepStrictEqual(Object.keys(C.PRESETS), ['groq', 'openai', 'custom']);
  assert.deepStrictEqual(C.PRESETS.openai, { id: 'openai', label: 'OpenAI' });
  assert.deepStrictEqual(C.PRESETS.groq, { id: 'groq', label: 'Groq（無料枠）' }, '古いページの経路の名前（クラウド（Groq（無料枠）））が変わった');
  assert.deepStrictEqual(C.PRESETS.custom, { id: 'custom', label: 'そのほか' });
  for (const n of ['transcribeCloud', 'resolveProvider', 'fixedProvider', 'FIXED_PROVIDER_ID', 'checkKey', 'keyErrorKind', 'CHECK_WAV']) assert.ok(!(n in C), `${n} が残っている`);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'stt-cloud.js'), 'utf8');
  for (const host of ['api.openai.com', 'api.groq.com']) assert.ok(!src.includes(host), `src/stt-cloud.js に ${host} が残っている`);
});

test('RF29: 中継の busy（OpenAI の 429）は retry-after だけ待って同じ区間を送り直す。待つたびに onWait で秒を伝え、retry-after: 0 は 1 秒待つ', { timeout: 5000 }, async () => {
  await withRelay({ mode: '429', times: 2, retryAfter: '3' }, async (rl, call) => {
    const slept = []; const told = [];
    const text = await C.transcribeRelay(wav(1), call({ sleep: async (ms) => { slept.push(ms); }, onWait: (s) => told.push(s) }));
    assert.match(text, SAID);
    assert.deepStrictEqual(slept, [3000, 3000]);
    assert.deepStrictEqual(told, [3, 3]);
    assert.strictEqual(posts(rl).length, 3);
  });
  await withRelay({ mode: '429', times: 1, retryAfter: '0' }, async (rl, call) => {
    const slept = [];
    assert.match(await C.transcribeRelay(wav(1), call({ sleep: async (ms) => { slept.push(ms); } })), SAID);
    assert.deepStrictEqual(slept, [1000], '待たずに打ち続けた');
  });
});

test('RF29: retry-after が長い（1日の上限）なら待たずに rate-long。待ちの合計が上限を越えるなら rate（60 秒 × 2 回待った後の3回目で諦める）', { timeout: 5000 }, async () => {
  await withRelay({ mode: '429-long' }, async (rl, call) => {
    const slept = [];
    await assert.rejects(C.transcribeRelay(wav(1), call({ sleep: async (ms) => { slept.push(ms); } })),
      (e) => e instanceof C.CloudSttError && e.code === 'rate-long' && e.retryAfter === 3600 && C.isOfflineError(e) === false);
    assert.deepStrictEqual(slept, []);
  });
  await withRelay({ mode: '429', times: 99, retryAfter: '60' }, async (rl, call) => {
    await assert.rejects(C.transcribeRelay(wav(1), call({ waitCapMs: 150000 })), (e) => e.code === 'rate' && e.retryAfter === 60);
    assert.strictEqual(posts(rl).length, 3);
  });
});

test('F15: ヒントを付けた要求が 400 なら、ヒントを外して1回だけ送り直す（言語は外さない。ヒントの無い 400 は送り直さない）', { timeout: 5000 }, async () => {
  await withRelay({ mode: '400-prompt' }, async (rl, call) => {
    let dropped = 0;
    const text = await C.transcribeRelay(wav(1), call({ prompt: '見積 検収', onPromptDropped: () => { dropped += 1; } }));
    assert.match(text, SAID);
    assert.deepStrictEqual(posts(rl).map((r) => 'prompt' in r.fields), [true, false]);
    assert.strictEqual(posts(rl)[1].fields.language, 'ja', '言語まで外した');
    assert.strictEqual(dropped, 1);
  });
  await withRelay({ mode: '400' }, async (rl, call) => {
    await assert.rejects(C.transcribeRelay(wav(1), call({ prompt: '見積' })), (e) => e.code === 'bad-request' && e.status === 400);
    assert.strictEqual(posts(rl).length, 2, 'ヒントを外した後の 400 でまた送り直した');
  });
});

test('OL2: 失敗の分け方。大きすぎれば too-large（413）、OpenAI の 5xx・JSON でない返事は中継の 502 で server。どれも「オフラインの失敗」ではない', { timeout: 5000 }, async () => {
  for (const [mode, code, status] of [['413', 'too-large', 413], ['500', 'server', 502], ['badjson', 'server', 502]]) {
    await withRelay({ mode }, async (rl, call) => {
      await assert.rejects(C.transcribeRelay(wav(1), call()), (e) => e.code === code && e.status === status && C.isOfflineError(e) === false, mode);
      assert.strictEqual(posts(rl).length, 1, `${mode}: 送り直した`);
    });
  }
});

test('RF27: 中継へ送っている途中で切れた・返事が来ない・証明書が差し替えられたは「オフラインの失敗」（net・timeout・cert）', { timeout: 5000 }, async () => {
  await withRelay({}, async (rl, call) => {
    rl.setFront('drop');
    await assert.rejects(C.transcribeRelay(wav(1), call()), (e) => C.isOfflineError(e) && e.code === 'net');
    rl.setFront('delay-stt');
    await assert.rejects(C.transcribeRelay(wav(1), call({ timeoutMs: 200 })), (e) => C.isOfflineError(e) && e.code === 'timeout');
    rl.setFront('');
    const cert = makeFakeRequest({ before: () => ({ error: 'net::ERR_CERT_AUTHORITY_INVALID' }) });
    await assert.rejects(C.transcribeRelay(wav(1), call({ request: cert })), (e) => C.isOfflineError(e) && e.code === 'cert');
  });
});

test('RF30: 札を別の宛先へ運ばない（redirect: error）。失敗の例外と区間の失敗の文（M9）に札を含めない', { timeout: 5000 }, async () => {
  await withRelay({}, async (rl, call, token) => {
    let opts = null;
    const spy = (o) => { opts = o; return rl.request(o); };
    assert.match(await C.transcribeRelay(wav(1), call({ request: spy })), SAID);
    assert.deepStrictEqual([opts.method, opts.redirect], ['POST', 'error']);
    rl.setFront('html401');
    let err = null;
    try { await C.transcribeRelay(wav(1), call()); } catch (e) { err = e; }
    assert.ok(err && err.code === 'server', '中継の形でない 401 は server');
    assert.ok(!JSON.stringify({ m: err.message, s: err.stack, t: C.cloudErrorText(err, 'OpenAI') }).includes(token), '札が例外か文に入った');
  });
  assert.match(C.cloudErrorText(new C.CloudSttError('rate-long', { retryAfter: 3600 }), 'OpenAI'), /^OpenAI: 上限に達しました$/);
  assert.match(C.cloudErrorText(new C.CloudSttError('rate', { retryAfter: 60 }), 'OpenAI'), /^OpenAI: 上限に達しました$/);
});

test('試験の守り: fake-net の宛先の書き換えの後が 127.0.0.1 でなければ死ぬ（テストが外へ出ない）', async () => {
  const req = makeFakeRequest({ rewrite: (u) => u })({ method: 'GET', url: 'https://api.groq.com/openai/v1/models' });
  const err = await new Promise((r) => { req.on('error', r); req.on('response', () => r(null)); req.end(); });
  assert.match(String(err && err.message), /ERR_BLOCKED_BY_CLIENT/);
});
