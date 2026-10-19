'use strict';
// 本物の中継のコード（relay/worker.mjs）を 127.0.0.1 の Node の http で包む台（第1d回 A-1）。アプリの口（src/relay.js・
// src/stt-cloud.js の transcribeRelay）を、中継と同じ約束のまま試すため。外へはつながない。
//   startRelayLocal({ stt, env, start }) → Promise<rl>
//     stt   … 偽の OpenAI（test/helpers/fake-stt.js）の起こし方（mode・times・retryAfter など。key は中継の会社の鍵に合わせる）
//     env   … 中継の env に重ねる値（DAILY_USER_SEC など。undefined の欄は消す）
//     start … 中継の試しの時計の始まり（ミリ秒。既定 Date.now()。rl.clock.advance でだけ進む）
//   rl.base      … 'http://127.0.0.1:<port>'（中継の口）
//   rl.request   … 偽の net.request（test/helpers/fake-net.js）。宛先が src/relay.js の RELAY_BASE で始まれば rl.base へ書き換える
//                  （ほかの宛先は書き換えない。127.0.0.1 でなければ fake-net が断る）
//   rl.sent      … rl.request で送った要求の全部 [{ method, url, redirect, headers, body: Buffer }]（札がどこに入ったかを見る）
//   rl.setFront(mode) … 中継の前の答え方。''（既定）は中継へ渡す。'html401' は中継へ渡さずに HTML の 401
//                  （会社の通信の検査やログインの画面が返す形。WWW-Authenticate つき）、'drop' は返事をせずに切る。
//                  第1d回 A-3 で足した（文字起こしの口 POST /v1/audio/transcriptions にだけ効き、ほかの道は中継へ渡す）:
//                  'not-wav' は中継の形の 415 { error: 'not-wav' }、'cut-first' は最初の文字起こしの要求だけを返事せずに切る、
//                  'delay-stt' は文字起こしの要求を 800 ミリ秒止めてから中継へ渡す（送っている間に別のことをする場面）
//   rl.stt・rl.resend … 偽の OpenAI・偽の Resend（requests・mails・codeFor・setMode）
//   rl.codeFor(email) … 偽の Resend へ送った最後の確認コード
//   rl.db・rl.env・rl.logs（中継の記録の行）・rl.clock
//   rl.close()   … 中継・偽物を閉じ、ctx.waitUntil の約束を待ち、D1 を閉じる。globalThis.fetch と console.log を戻す
// 中継の外への fetch（偽の OpenAI・偽の Resend）は、開いている間 globalThis.fetch を「127.0.0.1 のほかは断る」で包む。
// 中継の記録（console.log）は、開いている間 rl.logs に取り込む（いくつ開いても、閉じた最後の1つで元に戻す）。

const http = require('node:http');
const crypto = require('node:crypto');
const R = require('./relay-run');
const { makeFakeD1 } = require('./fake-d1');
const { makeFakeRequest } = require('./fake-net');
const { startFakeStt } = require('./fake-stt');
const { startFakeResend } = require('./fake-resend');
const { RELAY_BASE } = require('../../src/relay');

const open = new Set();
let realFetch = null;
let realLog = null;

function hook(rl) {
  if (open.size === 0) {
    realFetch = globalThis.fetch;
    realLog = console.log;
    globalThis.fetch = R.loopbackOnlyFetch(realFetch);
    console.log = (...a) => { const line = a.map(String).join(' '); for (const x of open) x.logs.push(line); };
  }
  open.add(rl);
}

function unhook(rl) {
  if (!open.delete(rl) || open.size > 0) return;
  globalThis.fetch = realFetch;
  console.log = realLog;
  realFetch = null; realLog = null;
}

// node の要求 → Web の Request（本文は全部読んでから渡す）
function toRequest(req, body) {
  const h = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i];
    if (/^(host|connection|content-length|transfer-encoding)$/i.test(k)) continue;
    h.append(k, req.rawHeaders[i + 1]);
  }
  const init = { method: req.method, headers: h };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
  return new Request('https://relay.test' + req.url, init);
}

// 書き換えと記録をする偽の net.request
function recordingRequest(base, sent) {
  const inner = makeFakeRequest({ rewrite: (u) => (String(u).startsWith(RELAY_BASE) ? base + String(u).slice(RELAY_BASE.length) : u) });
  return function request(opts) {
    const rec = { method: String(opts.method || 'GET').toUpperCase(), url: String(opts.url), redirect: opts.redirect, headers: {}, chunks: [] };
    Object.defineProperty(rec, 'body', { enumerable: true, get() { return Buffer.concat(rec.chunks); } });
    sent.push(rec);
    const req = inner(opts);
    const setHeader = req.setHeader;
    const write = req.write;
    req.setHeader = (k, v) => { rec.headers[k] = v; return setHeader(k, v); };
    req.write = (chunk) => { rec.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk))); return write(chunk); };
    return req;
  };
}

async function startRelayLocal({ stt: sttOpts = {}, env: over = {}, start = Date.now() } = {}) {
  const key = 'sk-test-' + crypto.randomBytes(12).toString('hex');
  const stt = await startFakeStt({ key, ...sttOpts });
  const resend = await startFakeResend();
  const db = makeFakeD1();
  await db.exec((await R.load('schema.mjs')).SCHEMA_SQL);
  const env = {
    DB: db,
    OPENAI_API_KEY: key,
    OPENAI_BASE: stt.base,
    RESEND_API_KEY: 're_test_' + crypto.randomBytes(12).toString('hex'),
    RESEND_BASE: resend.base,
    ALLOWED_EMAIL_DOMAINS: 'example.com',
    MAIL_FROM: 'NaTsu <' + R.mail('login') + '>',
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k]; else env[k] = v;
  }
  let t = start;
  const clock = { now: () => t, advance(ms) { t += ms; }, set(ms) { t = ms; } };
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };
  const { makeHandler } = await R.load('worker.mjs');
  const handler = makeHandler({ now: clock.now });
  let front = '';
  let cutDone = false;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      if (front === 'drop') { req.socket.destroy(); return; }
      const isStt = req.method === 'POST' && req.url.split('?')[0] === '/v1/audio/transcriptions';
      if (front === 'cut-first' && isStt && !cutDone) { cutDone = true; req.socket.destroy(); return; }
      if (front === 'delay-stt' && isStt) await new Promise((r) => setTimeout(r, 800));
      if (front === 'not-wav' && isStt) {
        res.writeHead(415, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'not-wav' }));
        return;
      }
      if (front === 'html401') {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'www-authenticate': 'Basic realm="proxy"' });
        res.end('<html><body>Sign in</body></html>');
        return;
      }
      try {
        const out = await handler.fetch(toRequest(req, Buffer.concat(chunks)), env, ctx);
        const headers = {};
        out.headers.forEach((v, k) => { headers[k] = v; });
        const body = Buffer.from(await out.arrayBuffer());
        res.writeHead(out.status, headers);
        res.end(body);
      } catch (_) {
        res.writeHead(599); res.end();   // 中継は例外を外に投げない約束。ここへ来たら試しの台の誤り
      }
    });
  });
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const sent = [];
  const rl = {
    base, env, db, clock, stt, resend, sent, logs: [],
    request: recordingRequest(base, sent),
    setFront(mode) { front = mode || ''; },
    codeFor: (email) => resend.codeFor(email),
    async close() {
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
      await Promise.allSettled(pending);
      unhook(rl);
      await stt.close();
      await resend.close();
      db.close();
    },
  };
  hook(rl);
  return rl;
}

module.exports = { startRelayLocal };
