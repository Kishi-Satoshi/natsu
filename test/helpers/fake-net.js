'use strict';
// Electron 31 の net.request（lib/common/api/net-client-request.ts）のうち、取り込みが頼る振る舞いを、
// node:http / node:https の上で真似る。本物と同じかは Task 9（electron-net）で確かめる。
//  - redirect: 'manual' … 3xx で ('redirect', status, method, 絶対の URL, 見出し（値は配列）)。
//    その場で followRedirect() が呼ばれなければ Error('Redirect was cancelled') で死ぬ。
//  - Range などの見出しは、転送の先にも付ける（Chromium と同じ）。
//  - 401/407 に WWW-Authenticate / Proxy-Authenticate があれば 'login'。受け手が無ければ取り消す。
//  - abort() … 次の tick に 'abort'。応答の流れは 'error' 無しで壊す。
//  - Accept-Encoding を自分で付けなければ、Chromium と同じく、Range のときは identity、ほかは gzip, deflate
//    （https は br も）を送る。応答の content-encoding（gzip / deflate / br）が送った Accept-Encoding に
//    あれば伸ばして渡し、見出しは元のまま。無ければ（identity を頼んだのに gzip が来た）伸ばさずに
//    net::ERR_CONTENT_DECODING_FAILED で死に、応答は渡さない（本物の Electron 31 がそうだった。第0b回 Task 9）。
//  - 応答の headers は小文字のキー。時間切れの仕組みは持たない（本物にも無い）。
//  - 途中で切れたら（identity）、届いていたバイトを受け手が読み終えてから net::ERR_CONNECTION_RESET で壊す（deliverAllThenFail）。
//  - before(n, opts) … n 回目の要求の前に呼ぶ（opts は request に渡した { method, url, … }。第1c回 Task A-4 で opts を足した）。
//    { login: authInfo, error: 'net::ERR_…' } を返すと、
//    サーバーへ行かずにその出来事を起こす（https のプロキシの 407 は、応答ではなく login と error で来る）。
//  - opts.method（無ければ GET）。GET でなければ req.write(chunk) の本文を貯め、end() で content-length を付けて送る
//    （本物は chunkedEncoding が false のとき、本文を貯めて長さを付けて送る）。第1c回 Task A-2。
//  - redirect: 'error' … 3xx が来たら net::ERR_UNSAFE_REDIRECT で死ぬ（Electron の資料の redirect の error）。
//  - rewrite(url) → url … 渡したときだけ、go(url) の頭で宛先を書き換える（本番の送り先を偽の送り先へ）。
//    書き換えた後のホストが 127.0.0.1・localhost・::1 でなければ net::ERR_BLOCKED_BY_CLIENT で死ぬ（試験が外へ出た）。
//  - 第1d回 A-10（足しただけ。今の書き換えと止めは変えない）: opts.session（makeFakeSession() の偽の session）と
//    opts.useSessionCookies: true のときだけ、その session の cookie の入れ物から、**書き換える前の宛先**（本番の URL）に合う cookie を
//    Cookie の見出しにして送る（本物は Chromium が付ける。呼び手の setHeader には出ない）。useSessionCookies が無ければ付けない
//    （Electron の既定は false）。redirect: 'manual' の 'redirect' イベントは上のまま。
//  - makeFakeSession() → { cookies: { set(details), get(filter), remove(url, name) }, clearStorageData(), cookieHeader(url) }
//    Electron の session.cookies の形を真似る: set は url（と domain・path・secure・httpOnly・sameSite・expirationDate）。domain を渡すと
//    頭に '.' を付けて下のドメインにも効く形にし（hostOnly: false）、渡さなければ url のホストだけ（hostOnly: true）。
//    sameSite: 'no_restriction' は secure が無ければ断る（Chromium と同じ）。get は url（送るときに合うもの）・name・domain で絞る。
//    送るときは、期限（expirationDate の秒。本物の時計）の切れたもの・secure で https でない宛先・道の合わないものは付けない。
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const hasHeader = (h, name) => Object.keys(h).some((k) => k.toLowerCase() === name);
const headerValue = (h, name) => { const k = Object.keys(h).find((x) => x.toLowerCase() === name); return k === undefined ? '' : String(h[k]); };
// Accept-Encoding の値から、受け取れる content-encoding の集まり（q=0 は除く。identity はいつも受け取れる）
function acceptedEncodings(v) {
  const out = new Set(['identity']);
  for (const part of String(v).split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';').map((x) => x.trim());
    if (name && !params.some((x) => /^q=0(\.0*)?$/.test(x))) out.add(name);
  }
  return out;
}

// 届いたバイトを全部渡してから ERR_CONNECTION_RESET にする（本物の Chromium の取り込みは、受け手が読んだ分だけ次を渡し、
// 届いた分を渡し終えてから失敗を知らせる）。Node の応答をそのまま渡すと、切断のときに Node が応答を壊し、受け手がまだ
// 読んでいない塊が捨てられる。受け手の書き込みが遅いと（Windows のウイルス対策が1回でも 100ms 止めると）続きの位置が
// 時間しだいでぶれ、bytes=100000- を見るテストが赤になった（第1a回の合流の CI。bytes=65329- = 64KB の1回の読みから見出しを
// 引いた長さ）。届いた塊は1つずつ、届いた大きさのまま渡す（readableObjectMode。先に読んだ分を read() が1つにまとめると、
// 取り消しが途中で効かずに最後まで書いてしまう。本物も塊ごとに渡す）。受け手が流れを壊したら（取り消し・止まった流れ・
// break）、下の応答も壊す
function deliverAllThenFail(res) {
  const out = new PassThrough({ readableObjectMode: true });
  let failed = false;
  const fail = (e) => {
    if (failed) return;
    failed = true;
    const tryFail = () => {
      if (out.destroyed) return;
      if (out.readableLength === 0 && out.writableLength === 0) out.destroy(e);
      else setTimeout(tryFail, 1);
    };
    tryFail();
  };
  res.on('data', (c) => { if (!out.destroyed) out.write(c); });
  res.on('end', () => { if (!out.destroyed) out.end(); });
  res.on('aborted', () => fail(new Error('net::ERR_CONNECTION_RESET')));
  res.on('error', (e) => fail(e));
  out.on('close', () => { if (!res.destroyed) res.destroy(); });
  return out;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const isLoopback = (url) => { try { return LOOPBACK.has(new URL(url).hostname); } catch (_) { return false; } };

const SAME_SITE = new Set(['unspecified', 'no_restriction', 'lax', 'strict']);

function makeFakeSession() {
  const jar = [];
  const matches = (c, url) => {
    let u;
    try { u = new URL(url); } catch (_) { return false; }
    const host = u.hostname.toLowerCase();
    if (c.hostOnly ? host !== c.domain : !(host === c.domain.slice(1) || host.endsWith(c.domain))) return false;
    if (c.secure && u.protocol !== 'https:') return false;
    const p = u.pathname || '/';
    return p === c.path || p.startsWith(c.path.endsWith('/') ? c.path : c.path + '/');
  };
  const alive = (c) => c.expirationDate === undefined || c.expirationDate > Date.now() / 1000;
  const copy = (c) => ({ ...c });
  const cookies = {
    async set(d) {
      const u = new URL(String(d.url));
      const name = String(d.name || '');
      const sameSite = d.sameSite === undefined ? 'unspecified' : d.sameSite;
      if (!SAME_SITE.has(sameSite)) throw new Error('Failed to set cookie - bad sameSite');
      if (sameSite === 'no_restriction' && d.secure !== true) throw new Error('Failed to set cookie - SameSite=None needs Secure');
      const hostOnly = !d.domain;
      const domain = hostOnly ? u.hostname.toLowerCase() : (String(d.domain).startsWith('.') ? String(d.domain) : '.' + String(d.domain)).toLowerCase();
      const c = { name, value: String(d.value == null ? '' : d.value), domain, hostOnly, path: d.path || '/', secure: d.secure === true,
        httpOnly: d.httpOnly === true, session: d.expirationDate === undefined, sameSite };
      if (d.expirationDate !== undefined) c.expirationDate = d.expirationDate;
      const at = jar.findIndex((x) => x.name === c.name && x.domain === c.domain && x.path === c.path);
      if (at >= 0) jar.splice(at, 1);
      jar.push(c);
    },
    async get(filter = {}) {
      return jar.filter((c) => alive(c)
        && (filter.url === undefined || matches(c, filter.url))
        && (filter.name === undefined || c.name === filter.name)
        && (filter.domain === undefined || c.domain === filter.domain || c.domain === '.' + filter.domain)).map(copy);
    },
    async remove(url, name) {
      for (let i = jar.length - 1; i >= 0; i--) if (jar[i].name === name && matches(jar[i], url)) jar.splice(i, 1);
    },
  };
  return {
    cookies,
    async clearStorageData() { jar.length = 0; },
    cookieHeader(url) { return jar.filter((c) => alive(c) && matches(c, url)).map((c) => `${c.name}=${c.value}`).join('; '); },
  };
}

function makeFakeRequest({ before = null, rewrite = null } = {}) {
  let n = 0;
  return function request(opts) {
    const req = new EventEmitter();
    const headers = {};
    const method = String(opts.method || 'GET').toUpperCase();
    const chunks = [];
    let aborted = false; let cur = null; let curRes = null; let followCb = null;
    req.setHeader = (k, v) => { headers[k] = v; };
    req.write = (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; };
    req.followRedirect = () => {
      if (!followCb) throw new Error('followRedirect() called, but was not waiting for a redirect');
      followCb();
    };
    req.abort = () => {
      if (!aborted) process.nextTick(() => req.emit('abort'));
      aborted = true;
      if (cur) cur.destroy();
      if (curRes) curRes.destroy();
    };
    const die = (e) => { if (!aborted) { aborted = true; req.emit('error', e); if (cur) cur.destroy(); } };
    // 本物と同じく、受け手が無ければ何も渡さずに callback を呼ぶ（取り消し）
    const login = (info, after) => {
      const cb = (...args) => { req.loginArgs = args; after(); };
      if (!req.emit('login', info, cb)) cb();
    };
    const go = (url0) => {
      let url = url0;
      if (rewrite) {
        url = String(rewrite(url0));
        if (!isLoopback(url)) { die(new Error('net::ERR_BLOCKED_BY_CLIENT')); return; }
      }
      const lib = url.startsWith('https:') ? https : http;
      const wire = { ...headers };
      if (opts.session && opts.useSessionCookies === true && typeof opts.session.cookieHeader === 'function') {
        const ck = opts.session.cookieHeader(url0);
        if (ck) wire.Cookie = ck;
      }
      if (!hasHeader(wire, 'accept-encoding')) {
        wire['Accept-Encoding'] = hasHeader(wire, 'range') ? 'identity' : url.startsWith('https:') ? 'gzip, deflate, br' : 'gzip, deflate';
      }
      const onRes = (res) => {
        const st = res.statusCode;
        if ([301, 302, 303, 307, 308].includes(st) && res.headers.location) {
          res.resume();
          if (opts.redirect === 'error') { die(new Error('net::ERR_UNSAFE_REDIRECT')); return; }
          const next = new URL(res.headers.location, url).toString();
          const arr = {};
          for (const [k, v] of Object.entries(res.headers)) arr[k.toLowerCase()] = Array.isArray(v) ? v : [v];
          if (opts.redirect === 'manual') {
            let follow = false;
            followCb = () => { follow = true; };
            try { req.emit('redirect', st, 'GET', next, arr); } finally {
              followCb = null;
              if (!follow && !aborted) die(new Error('Redirect was cancelled'));
            }
            if (follow && !aborted) go(next);
          } else go(next);
          return;
        }
        const deliver = () => {
          if (aborted) { res.resume(); return; }
          const enc = String(res.headers['content-encoding'] || 'identity').toLowerCase();
          if (enc !== 'identity' && !acceptedEncodings(headerValue(wire, 'accept-encoding')).has(enc)) {
            res.resume(); die(new Error('net::ERR_CONTENT_DECODING_FAILED')); return;
          }
          let body = res;
          if (enc === 'gzip' || enc === 'deflate' || enc === 'br') {
            body = enc === 'gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : zlib.createBrotliDecompress();
            res.on('error', (e) => body.destroy(e));
            res.pipe(body);
            res.on('aborted', () => body.destroy(new Error('net::ERR_CONNECTION_RESET')));
          } else {
            body = deliverAllThenFail(res);
          }
          body.statusCode = st; body.headers = res.headers;
          curRes = body;
          req.emit('response', body);
        };
        const challenge = (st === 401 && res.headers['www-authenticate']) || (st === 407 && res.headers['proxy-authenticate']);
        if (challenge) { login({ isProxy: st === 407, scheme: 'basic', host: new URL(url).hostname, port: 0, realm: 'x' }, deliver); return; }
        deliver();
      };
      if (method === 'GET') cur = lib.get(url, { headers: wire }, onRes);
      else {
        const body = Buffer.concat(chunks);
        cur = lib.request(url, { method, headers: { ...wire, 'Content-Length': String(body.length) } }, onRes);
        cur.end(body);
      }
      cur.on('error', (e) => die(new Error(e.code === 'ECONNREFUSED' ? 'net::ERR_CONNECTION_REFUSED' : 'net::ERR_CONNECTION_RESET')));
    };
    req.end = () => {
      process.nextTick(() => {
        if (aborted) return;
        const inj = before ? before(++n, opts) : null;
        if (!inj) { go(opts.url); return; }
        const fail = () => { if (inj.error) die(new Error(inj.error)); };
        if (inj.login) login(inj.login, fail); else fail();
      });
    };
    return req;
  };
}

const fakeRequest = makeFakeRequest();
module.exports = { makeFakeRequest, makeFakeSession, fakeRequest };
