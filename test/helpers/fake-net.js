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
//  - before(n) … n 回目の要求の前に呼ぶ。{ login: authInfo, error: 'net::ERR_…' } を返すと、
//    サーバーへ行かずにその出来事を起こす（https のプロキシの 407 は、応答ではなく login と error で来る）。
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { EventEmitter } = require('events');

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

function makeFakeRequest({ before = null } = {}) {
  let n = 0;
  return function request(opts) {
    const req = new EventEmitter();
    const headers = {};
    let aborted = false; let cur = null; let curRes = null; let followCb = null;
    req.setHeader = (k, v) => { headers[k] = v; };
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
    const go = (url) => {
      const lib = url.startsWith('https:') ? https : http;
      const wire = { ...headers };
      if (!hasHeader(wire, 'accept-encoding')) {
        wire['Accept-Encoding'] = hasHeader(wire, 'range') ? 'identity' : url.startsWith('https:') ? 'gzip, deflate, br' : 'gzip, deflate';
      }
      cur = lib.get(url, { headers: wire }, (res) => {
        const st = res.statusCode;
        if ([301, 302, 303, 307, 308].includes(st) && res.headers.location) {
          res.resume();
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
          }
          body.statusCode = st; body.headers = res.headers;
          curRes = body;
          res.on('aborted', () => body.destroy(new Error('net::ERR_CONNECTION_RESET')));
          req.emit('response', body);
        };
        const challenge = (st === 401 && res.headers['www-authenticate']) || (st === 407 && res.headers['proxy-authenticate']);
        if (challenge) { login({ isProxy: st === 407, scheme: 'basic', host: new URL(url).hostname, port: 0, realm: 'x' }, deliver); return; }
        deliver();
      });
      cur.on('error', (e) => die(new Error(e.code === 'ECONNREFUSED' ? 'net::ERR_CONNECTION_REFUSED' : 'net::ERR_CONNECTION_RESET')));
    };
    req.end = () => {
      process.nextTick(() => {
        if (aborted) return;
        const inj = before ? before(++n) : null;
        if (!inj) { go(opts.url); return; }
        const fail = () => { if (inj.error) die(new Error(inj.error)); };
        if (inj.login) login(inj.login, fail); else fail();
      });
    };
    return req;
  };
}

const fakeRequest = makeFakeRequest();
module.exports = { makeFakeRequest, fakeRequest };
