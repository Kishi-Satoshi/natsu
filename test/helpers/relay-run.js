'use strict';
// 中継（relay/*.mjs）を Worker を起こさずに node --test で呼ぶ台（第1d回 W-1）。
//   load(name) → import('relay/<name>')（中継のファイルは .mjs なので、CommonJS のテストからは import で読む）
//   withRelay({ env, noSchema, start, access }, fn) … 偽の D1（test/helpers/fake-d1.js）に表の形 v1 を流し（noSchema なら流さない）、
//     env の既定に重ね（undefined の欄は消す）、globalThis.fetch を「127.0.0.1 のほかは断る」で包み、console.log を取り込んで、
//     fn({ call, env, logs, db, clock, ctx }) を呼ぶ。終わったら fetch と console.log を戻し、ctx.waitUntil の約束を待ち、D1 を閉じる。
//       env の既定: OPENAI_API_KEY 'sk-test-<乱数>'・RESEND_API_KEY 're_test_<乱数>'・ALLOWED_EMAIL_DOMAINS 'example.com'・
//                   MAIL_FROM 'NaTsu <' + mail('login') + '>'・DB 偽の D1
//       access（第1d回 W-5）… 偽の Access（test/helpers/fake-access.js の fa）を渡すと、env の既定に TEAM_DOMAIN（fa.teamDomain）・
//         POLICY_AUD（fa.aud）・ACCESS_CERTS_BASE（fa.certsBase）を足し、中継の鍵の写しを空にする（_resetCertsCache。ポートの使い回しで
//         前の場面の鍵が残らないように）。渡さなければ TEAM_DOMAIN・POLICY_AUD は無い（ready.access は false。今までの場面のまま）
//       call(method, path, { headers, body, ip, stream, jwt, cookie, ctx }) → Response。makeHandler({ now: clock.now }).fetch(new Request('https://relay.test' + path, …), env, ctx)
//         body が文字・Uint8Array のほかのオブジェクトなら JSON にする（Content-Type も付ける）。ip は CF-Connecting-IP の見出し。
//         jwt は Cf-Access-Jwt-Assertion の見出し・cookie は Cookie の見出しの CF_Authorization（文字そのまま）・
//         ctx はその1回の ctx に重ねる欄（偽の ctx.access など。第1d回 W-5）
//         stream: true は本文を 64KB ずつの ReadableStream にして Content-Length を付けない（Node の Request は duplex: 'half' が要る）
//       clock: { now(), advance(ms), set(ms) }。start（既定 Date.now()）から始まり、advance でだけ進む
//       logs: console.log に書かれた行（文字）の配列
//   loopbackOnlyFetch(realFetch) → 127.0.0.1 のほかへの要求を TypeError('外への通信（試験）') で断る fetch
//   captureConsole(fn) → fn の間に console.log に書かれた行の配列（fn が約束を返せば、約束で返す）
//   wav(sec) → 16kHz・モノラル・16 ビットの無音の WAV（Uint8Array。アプリの録音と同じ形）
//   mail(local, domain = 'example.com') → local + '@' + domain。テストのファイルにメールアドレスの形の文字を書かないため
//     （test/repo.test.js が公開のリポジトリの全部のファイルでメールアドレスの形を止める。その守りはゆるめない）

const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { makeFakeD1 } = require('./fake-d1');

const RELAY_DIR = path.join(__dirname, '..', '..', 'relay');

const load = (name) => import(pathToFileURL(path.join(RELAY_DIR, name)).href);

const mail = (local, domain = 'example.com') => local + String.fromCharCode(64) + domain;

function loopbackOnlyFetch(realFetch) {
  return async function fetch(input, init) {
    const raw = input && typeof input === 'object' && 'url' in input ? input.url : String(input);
    let u;
    try { u = new URL(raw); } catch (_) { throw new TypeError('外への通信（試験）: URL として読めない'); }
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') throw new TypeError('外への通信（試験）');
    return realFetch(input, init);
  };
}

function captureConsole(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(' ')); };
  let r;
  try { r = fn(); } catch (e) { console.log = orig; throw e; }
  if (r && typeof r.then === 'function') {
    return r.then((v) => { console.log = orig; return lines; }, (e) => { console.log = orig; throw e; });
  }
  console.log = orig;
  return lines;
}

function wav(sec) {
  const data = Math.round(sec * 32000);
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(data, 40);
  return new Uint8Array(b.buffer, b.byteOffset, b.length);
}

function streamOf(bytes) {
  let i = 0;
  const CH = 64 * 1024;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) { c.close(); return; }
      c.enqueue(bytes.slice(i, i + CH));
      i += CH;
    },
  });
}

async function withRelay(opts, fn) {
  const { env: over = {}, noSchema = false, start = Date.now(), access = null } = opts || {};
  const db = makeFakeD1();
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const pending = [];
  try {
    if (!noSchema) await db.exec((await load('schema.mjs')).SCHEMA_SQL);
    const rand = crypto.randomBytes(12).toString('hex');
    const env = {
      DB: db,
      OPENAI_API_KEY: 'sk-test-' + rand,
      RESEND_API_KEY: 're_test_' + rand,
      ALLOWED_EMAIL_DOMAINS: 'example.com',
      MAIL_FROM: 'NaTsu <' + mail('login') + '>',
    };
    if (access) {
      Object.assign(env, { TEAM_DOMAIN: access.teamDomain, POLICY_AUD: access.aud, ACCESS_CERTS_BASE: access.certsBase });
      (await load('access.mjs'))._resetCertsCache();
    }
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete env[k]; else env[k] = v;
    }
    let t = start;
    const clock = { now: () => t, advance(ms) { t += ms; }, set(ms) { t = ms; } };
    const ctx = { waitUntil(p) { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };
    const { makeHandler } = await load('worker.mjs');
    const handler = makeHandler({ now: clock.now });
    const logs = [];
    console.log = (...a) => { logs.push(a.map(String).join(' ')); };
    globalThis.fetch = loopbackOnlyFetch(realFetch);

    async function call(method, p, { headers = {}, body, ip, stream = false, jwt, cookie, ctx: more } = {}) {
      const h = new Headers(headers);
      if (ip) h.set('cf-connecting-ip', ip);
      if (jwt !== undefined) h.set('cf-access-jwt-assertion', jwt);
      if (cookie !== undefined) h.set('cookie', 'CF_Authorization=' + cookie);
      let b = body;
      if (b != null && typeof b === 'object' && !(b instanceof Uint8Array) && !(b instanceof ArrayBuffer)) {
        b = JSON.stringify(b);
        if (!h.has('content-type')) h.set('content-type', 'application/json');
      }
      const init = { method, headers: h };
      if (b !== undefined) {
        if (stream) {
          init.body = streamOf(typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b));
          init.duplex = 'half';
        } else init.body = b;
      }
      return handler.fetch(new Request('https://relay.test' + p, init), env, more ? { ...ctx, ...more } : ctx);
    }

    return await fn({ call, env, logs, db, clock, ctx });
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    await Promise.allSettled(pending);
    db.close();
  }
}

module.exports = { load, withRelay, loopbackOnlyFetch, captureConsole, wav, mail, RELAY_DIR };
