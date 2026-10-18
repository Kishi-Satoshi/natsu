/*
 * stt-cloud.test.js — OpenAI と同じ形の文字起こしの口（第1c回 OL2。RF27・RF29・RF30）
 * 127.0.0.1 の偽の送り先（helpers/fake-stt.js）と、net.request の偽物（helpers/fake-net.js）で試す。外へはつながない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeFakeRequest } = require('./helpers/fake-net');
const { startFakeStt } = require('./helpers/fake-stt');
const C = require('../src/stt-cloud');

const KEY = 'gsk_test_0123';
function toneWav(sec) {
  const n = 16000 * sec; const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii'); b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 220 * i / 16000)), 44 + i * 2);
  return b;
}
const custom = (f, model = 'whisper-large-v3') => C.resolveProvider({ sttProvider: 'custom', sttBaseUrl: f.base, sttModel: model });

test('OL2: 送り先の既定。Groq が既定の名前、OpenAI、そのほかは https だけ（http は 127.0.0.1 と localhost だけ）', () => {
  const g = C.resolveProvider({ sttProvider: 'groq', sttBaseUrl: '', sttModel: '' });
  assert.deepStrictEqual([g.id, g.base, g.model, g.host, g.reachUrl], ['groq', 'https://api.groq.com/openai/v1', 'whisper-large-v3', 'api.groq.com', 'https://api.groq.com/openai/v1/models']);
  const o = C.resolveProvider({ sttProvider: 'openai', sttBaseUrl: 'https://evil.example/v1', sttModel: '' });
  assert.deepStrictEqual([o.base, o.model], ['https://api.openai.com/v1', 'gpt-4o-transcribe'], '既定の送り先が sttBaseUrl で書き換わった');
  assert.strictEqual(C.resolveProvider({ sttProvider: 'groq', sttBaseUrl: '', sttModel: 'whisper-large-v3-turbo' }).model, 'whisper-large-v3-turbo');
  assert.deepStrictEqual(C.resolveProvider({ sttProvider: 'custom', sttBaseUrl: 'http://stt.example/v1', sttModel: 'm' }), { error: 'base' });
  assert.deepStrictEqual(C.resolveProvider({ sttProvider: 'custom', sttBaseUrl: '', sttModel: 'm' }), { error: 'base' });
  assert.strictEqual(C.resolveProvider({ sttProvider: 'custom', sttBaseUrl: 'https://stt.example/v1/', sttModel: 'm' }).base, 'https://stt.example/v1');
  assert.strictEqual(C.resolveProvider({ sttProvider: 'custom', sttBaseUrl: 'http://127.0.0.1:9/v1', sttModel: 'm' }).base, 'http://127.0.0.1:9/v1');
  assert.strictEqual(C.resolveProvider({ sttProvider: 'zzz', sttBaseUrl: '', sttModel: '' }).id, 'groq', '知らない送り先は既定の Groq');
});

test('OL2: OpenAI と同じ形の multipart で送る（file・model・language・prompt・response_format・temperature）。鍵は Authorization だけ', async () => {
  const f = await startFakeStt({ key: KEY });
  try {
    const text = await C.transcribeCloud(toneWav(3), { request: makeFakeRequest(), provider: custom(f), key: KEY, language: 'ja', prompt: 'お疲れさまです。見積 検収' });
    assert.strictEqual(text, '本日の議題は進捗の確認です。区間1');
    const r = f.requests.find((x) => x.path.endsWith('/audio/transcriptions'));
    assert.deepStrictEqual([r.method, r.path, r.authOk, r.wavOk, r.fileName, r.fileType], ['POST', '/openai/v1/audio/transcriptions', true, true, 'segment.wav', 'audio/wav']);
    assert.deepStrictEqual(r.fields, { model: 'whisper-large-v3', language: 'ja', prompt: 'お疲れさまです。見積 検収', response_format: 'json', temperature: '0' });
    // 言語が auto なら language を送らない。ヒントが空なら prompt を送らない
    await C.transcribeCloud(toneWav(1), { request: makeFakeRequest(), provider: custom(f), key: KEY, language: 'auto', prompt: '' });
    const r2 = f.requests.filter((x) => x.path.endsWith('/audio/transcriptions'))[1];
    assert.deepStrictEqual(Object.keys(r2.fields).sort(), ['model', 'response_format', 'temperature']);
  } finally { await f.close(); }
});

test('RF29: 429 は retry-after だけ待って送り直す（オンラインのまま）。待つたびに onWait で秒を伝える', async () => {
  const f = await startFakeStt({ key: KEY, mode: '429', times: 2, retryAfter: '3' });
  try {
    const slept = []; const told = [];
    const text = await C.transcribeCloud(toneWav(1), { request: makeFakeRequest(), provider: custom(f), key: KEY, language: 'ja', prompt: '', sleep: async (ms) => { slept.push(ms); }, onWait: (s) => told.push(s) });
    assert.match(text, /^本日の議題は進捗の確認です。区間\d+$/);
    assert.deepStrictEqual(slept, [3000, 3000]);
    assert.deepStrictEqual(told, [3, 3]);
  } finally { await f.close(); }
});

test('RF29: retry-after が長い（1日の上限）なら待たずに rate-long。待ちの合計が上限を越えるなら rate', async () => {
  const f = await startFakeStt({ key: KEY, mode: '429-long' });
  const g = await startFakeStt({ key: KEY, mode: '429', times: 99, retryAfter: '60' });
  try {
    const slept = [];
    await assert.rejects(C.transcribeCloud(toneWav(1), { request: makeFakeRequest(), provider: custom(f), key: KEY, language: 'ja', prompt: '', sleep: async (ms) => { slept.push(ms); } }),
      (e) => e instanceof C.CloudSttError && e.code === 'rate-long' && e.retryAfter === 3600);
    assert.deepStrictEqual(slept, []);
    await assert.rejects(C.transcribeCloud(toneWav(1), { request: makeFakeRequest(), provider: custom(g), key: KEY, language: 'ja', prompt: '', sleep: async () => {}, waitCapMs: 150000 }),
      (e) => e.code === 'rate');
    assert.strictEqual(g.requests.filter((x) => x.path.endsWith('/audio/transcriptions')).length, 3, '60 秒 × 2 回待った後の3回目で諦めていない');
  } finally { await f.close(); await g.close(); }
});

test('OL2: 失敗の分け方。401 は auth、500 は server、400 は bad-request、JSON でない返事は bad-reply（どれも手元へ落とさない側）', async () => {
  for (const [mode, code] of [['401', 'auth'], ['500', 'server'], ['400', 'bad-request'], ['badjson', 'bad-reply']]) {
    const f = await startFakeStt({ key: KEY, mode });
    try {
      await assert.rejects(C.transcribeCloud(toneWav(1), { request: makeFakeRequest(), provider: custom(f), key: KEY, language: 'ja', prompt: '' }),
        (e) => e.code === code && C.isOfflineError(e) === false, mode);
    } finally { await f.close(); }
  }
});

test('F15: ヒントを付けた要求が 400 なら、ヒントを外して1回だけ送り直す（ヒントの無い 400 は送り直さない）', async () => {
  const f = await startFakeStt({ key: KEY, mode: '400-prompt' });
  const g = await startFakeStt({ key: KEY, mode: '400' });
  try {
    let dropped = 0;
    const text = await C.transcribeCloud(toneWav(1), { request: makeFakeRequest(), provider: custom(f), key: KEY, language: 'ja', prompt: '見積 検収', onPromptDropped: () => { dropped += 1; } });
    assert.match(text, /^本日の議題は進捗の確認です。区間\d+$/);
    const posts = f.requests.filter((x) => x.path.endsWith('/audio/transcriptions'));
    assert.deepStrictEqual(posts.map((r) => 'prompt' in r.fields), [true, false]);
    assert.strictEqual(posts[1].fields.language, 'ja', '言語まで外した');
    assert.strictEqual(dropped, 1);
    await assert.rejects(C.transcribeCloud(toneWav(1), { request: makeFakeRequest(), provider: custom(g), key: KEY, language: 'ja', prompt: '見積' }), (e) => e.code === 'bad-request');
    assert.strictEqual(g.requests.filter((x) => x.path.endsWith('/audio/transcriptions')).length, 2, 'ヒントを外した後の 400 でまた送り直した');
  } finally { await f.close(); await g.close(); }
});

test('RF27: 送っている途中で切れた・返事が来ない・届かないは「オフラインの失敗」（その区間は手元でやり直してよい）', async () => {
  const f = await startFakeStt({ key: KEY, mode: 'drop' });
  const s = await startFakeStt({ key: KEY, mode: 'slow' });
  try {
    await assert.rejects(C.transcribeCloud(toneWav(1), { request: makeFakeRequest(), provider: custom(f), key: KEY, language: 'ja', prompt: '' }),
      (e) => C.isOfflineError(e) && e.code === 'net');
    await assert.rejects(C.transcribeCloud(toneWav(1), { request: makeFakeRequest(), provider: custom(s), key: KEY, language: 'ja', prompt: '', timeoutMs: 200 }),
      (e) => C.isOfflineError(e) && e.code === 'timeout');
    const cert = makeFakeRequest({ before: () => ({ error: 'net::ERR_CERT_AUTHORITY_INVALID' }) });
    await assert.rejects(C.transcribeCloud(toneWav(1), { request: cert, provider: custom(f), key: KEY, language: 'ja', prompt: '' }),
      (e) => C.isOfflineError(e) && e.code === 'cert');
  } finally { await f.close(); await s.close(); }
});

test('RF30: 鍵を別の宛先へ運ばない（redirect: error）。失敗の文と例外に鍵を含めない', async () => {
  const f = await startFakeStt({ key: KEY, mode: '401' });
  try {
    let err = null;
    try { await C.transcribeCloud(toneWav(1), { request: makeFakeRequest(), provider: custom(f), key: KEY, language: 'ja', prompt: '' }); } catch (e) { err = e; }
    assert.ok(!JSON.stringify({ m: err.message, s: err.stack, t: C.cloudErrorText(err, 'そのほか') }).includes(KEY));
    assert.match(C.cloudErrorText(err, 'Groq（無料枠）'), /Groq（無料枠）: 鍵が正しくありません/);
    assert.match(C.cloudErrorText(new C.CloudSttError('rate-long', { retryAfter: 3600 }), 'Groq（無料枠）'), /上限に達しました/);
  } finally { await f.close(); }
  let opts = null;
  const spy = (o) => { opts = o; return makeFakeRequest()(o); };
  const g = await startFakeStt({ key: KEY });
  try { await C.transcribeCloud(toneWav(1), { request: spy, provider: custom(g), key: KEY, language: 'ja', prompt: '' }); } finally { await g.close(); }
  assert.deepStrictEqual([opts.method, opts.redirect], ['POST', 'error']);
});

test('OL3: 鍵の確かめは GET {base}/models の 200／401 で見る', async () => {
  const f = await startFakeStt({ key: KEY });
  try {
    assert.deepStrictEqual(await C.checkKey({ request: makeFakeRequest(), provider: custom(f), key: KEY }), { ok: true });
    assert.deepStrictEqual(await C.checkKey({ request: makeFakeRequest(), provider: custom(f), key: 'gsk_wrong' }), { ok: false, code: 'auth' });
  } finally { await f.close(); }
});

test('試験の守り: fake-net の宛先の書き換えの後が 127.0.0.1 でなければ死ぬ（テストが外へ出ない）', async () => {
  const req = makeFakeRequest({ rewrite: (u) => u })({ method: 'GET', url: 'https://api.groq.com/openai/v1/models' });
  const err = await new Promise((r) => { req.on('error', r); req.on('response', () => r(null)); req.end(); });
  assert.match(String(err && err.message), /ERR_BLOCKED_BY_CLIENT/);
});
