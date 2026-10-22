/*
 * localhttp.test.js — 0.9.4 Task S-2（計画 docs/plans/2026-10-22-094.md の決めたこと 15・Review Focus S2）
 * PC の中の文字起こしエンジンへの要求（src/localhttp.js の postInference）を、127.0.0.1 の偽のエンジンで確かめる。
 * Node の fetch（undici）は返事の頭を既定 300 秒で切る。postInference は自前の時計（timeoutMs）だけで切る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { postInference, MAX_REPLY_BYTES } = require('../src/localhttp');

const T = { timeout: 5000 };
const ROOT = path.join(__dirname, '..');

// 偽のエンジン。handler(req, res, body) で答える。closed は要求の接続が閉じられた数
async function engine(handler) {
  const st = { closed: 0, bodies: [], heads: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.socket.on('close', () => { st.closed += 1; });
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      st.bodies.push(body);
      st.heads.push(req.headers);
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  st.port = server.address().port;
  st.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return st;
}
const form = () => {
  const f = new FormData();
  f.append('file', new Blob([Buffer.from('RIFF....WAVEfmt ')], { type: 'audio/wav' }), 'audio.wav');
  f.append('response_format', 'json');
  f.append('no_context', 'true');
  return f;
};

test('S2: 頭の時間切れが無い（答えまで 2 秒の偽のエンジンに、待ち時間 3 秒で送って 200 が読める。同じ偽のエンジンへ Node の fetch に 1 秒の時計で送ると切れる）', T, async () => {
  const e = await engine((_req, res) => setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"text":"本日の議題"}'); }, 2000));
  const realFetch = globalThis.fetch;
  try {
    // 試しの間は Node の fetch を使えなくする（postInference が undici を通らないことの確かめ）
    let fetched = 0;
    globalThis.fetch = async () => { fetched += 1; throw new Error('fetch を使った'); };
    const r = await postInference({ port: e.port, form: form(), timeoutMs: 3000 });
    assert.deepStrictEqual(r, { status: 200, body: '{"text":"本日の議題"}' });
    assert.strictEqual(fetched, 0);
    globalThis.fetch = realFetch;
    // undici の時間切れの形（返事の頭まで待つ時計）が先に切れると、同じ要求でも失敗する（違いを固定する）
    await assert.rejects(realFetch(`http://127.0.0.1:${e.port}/inference`, { method: 'POST', body: form(), signal: AbortSignal.timeout(1000) }),
      (err) => err.name === 'TimeoutError');
  } finally {
    globalThis.fetch = realFetch;
    await e.close();
  }
});

test('待ち時間を越えたら late: true の Error で、要求を壊す（偽のエンジンが接続の閉じを受ける）', T, async () => {
  const e = await engine(() => { /* 答えない */ });
  try {
    const t0 = Date.now();
    await assert.rejects(postInference({ port: e.port, form: form(), timeoutMs: 300 }), (err) => {
      assert.strictEqual(err.late, true);
      assert.strictEqual(err.code, 'LOCAL_TIMEOUT');
      assert.strictEqual(err.message, 'PC の文字起こしが時間内に終わりませんでした');
      return true;
    });
    assert.ok(Date.now() - t0 < 2000);
    const deadline = Date.now() + 2000;
    while (e.closed < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(e.closed, 1, '時間切れの後も接続を開いたまま（whisper-server が走り続ける）');
  } finally {
    await e.close();
  }
});

test('FormData を multipart で送る（偽のエンジンが file・response_format・no_context を読める）。宛先は /inference の POST', T, async () => {
  let seen = null;
  const e = await engine((req, res) => { seen = { method: req.method, url: req.url }; res.writeHead(200); res.end('{"text":""}'); });
  try {
    await postInference({ port: e.port, form: form(), timeoutMs: 2000 });
    assert.deepStrictEqual(seen, { method: 'POST', url: '/inference' });
    const type = e.heads[0]['content-type'];
    const m = /^multipart\/form-data; boundary=(.+)$/.exec(type);
    assert.ok(m, type);
    assert.strictEqual(Number(e.heads[0]['content-length']), e.bodies[0].length);
    const text = e.bodies[0].toString('latin1');
    assert.match(text, /name="file"; filename="audio\.wav"\r\nContent-Type: audio\/wav\r\n\r\nRIFF\.\.\.\.WAVEfmt /);
    assert.match(text, /name="response_format"\r\n\r\njson\r\n/);
    assert.match(text, /name="no_context"\r\n\r\ntrue\r\n/);
  } finally {
    await e.close();
  }
});

test('答えは 1 MB まで（越えたら誤り）。HTTP の誤りは status で返す。止まっているエンジンは ECONNREFUSED', T, async () => {
  const big = await engine((_req, res) => { res.writeHead(200); res.end(Buffer.alloc(MAX_REPLY_BYTES + 10, 0x61)); });
  try {
    await assert.rejects(postInference({ port: big.port, form: form(), timeoutMs: 2000 }), (err) => err.code === 'LOCAL_TOO_BIG');
  } finally {
    await big.close();
  }
  assert.strictEqual(MAX_REPLY_BYTES, 1048576);
  const bad = await engine((_req, res) => { res.writeHead(500); res.end('{"error":"boom"}'); });
  const port = bad.port;
  try {
    assert.deepStrictEqual(await postInference({ port, form: form(), timeoutMs: 2000 }), { status: 500, body: '{"error":"boom"}' });
  } finally {
    await bad.close();
  }
  await assert.rejects(postInference({ port, form: form(), timeoutMs: 2000 }), (err) => err.code === 'ECONNREFUSED' && !err.late);
});

test('127.0.0.1 のほかへは送らない（host を引数で受けない）。使い回しの接続を持たない（agent: false）。signal で止めると AbortError', T, async () => {
  const seen = [];
  const request = (opts, cb) => {
    seen.push(opts);
    return http.request({ ...opts, host: '127.0.0.1' }, cb);
  };
  const e = await engine((_req, res) => { res.writeHead(200); res.end('{}'); });
  try {
    await postInference({ port: e.port, form: form(), timeoutMs: 2000, request, host: 'example.com', hostname: 'example.com' });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].host, '127.0.0.1');
    assert.strictEqual(seen[0].hostname, undefined);
    assert.strictEqual(seen[0].agent, false);
    assert.strictEqual(seen[0].path, '/inference');
  } finally {
    await e.close();
  }
  const hang = await engine(() => { /* 答えない */ });
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(postInference({ port: hang.port, form: form(), timeoutMs: 3000, signal: ac.signal }), (err) => err.name === 'AbortError' && !err.late);
  } finally {
    await hang.close();
  }
  const src = fs.readFileSync(path.join(ROOT, 'src', 'localhttp.js'), 'utf8');
  assert.ok(!/fetch\(/.test(src), 'localhttp に fetch( がある');
  assert.ok(!/require\('https'\)/.test(src));
  assert.strictEqual((src.match(/host: '127\.0\.0\.1'/g) || []).length, 1);
});

test('字面: transcribeLocal・probeInference に fetch( が無く、localhttp.postInference を使う', T, () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const body = (name) => {
    const i = main.indexOf(`async function ${name}(`);
    assert.ok(i >= 0, name);
    const j = main.indexOf('\n}\n', i);
    return main.slice(i, j);
  };
  for (const name of ['transcribeLocal', 'probeInference']) {
    const b = body(name);
    assert.ok(!/\bfetch\(/.test(b), `${name} に fetch( がある`);
    assert.ok(b.includes('localhttp.postInference('), `${name} が localhttp.postInference を使っていない`);
  }
  assert.match(main, /^const localhttp = require\('\.\/localhttp'\);$/m);
});
