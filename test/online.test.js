/*
 * online.test.js — オンラインかの判定と経路の決め方（第1c回 OL1・OL4。RF26・RF27・RF28）
 * 127.0.0.1 の小さなサーバーと、Electron の net.request の偽物（helpers/fake-net.js）で試す。外へはつながない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { makeFakeRequest } = require('./helpers/fake-net');
const O = require('../src/online');

const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => r(s)); });
const urlOf = (s, p = '/v1/models') => `http://127.0.0.1:${s.address().port}${p}`;
// 確かめが落ちても、サーバーを閉じてファイルが止まらずに終わるように（変異を入れたときに、開いたままで待ち続けた）
const shut = (s) => { if (s.listening) { s.closeAllConnections(); s.close(); } };
const T = { timeout: 10000 };

test('OL1: isOnline が false なら、届くかを確かめずに「オフライン」（要求を1つも出さない）', T, async () => {
  let asked = 0;
  const o = O.makeOnline({ isOnline: () => false, request: () => { asked += 1; throw new Error('呼ばれた'); } });
  assert.deepStrictEqual(await o.isUp('https://api.groq.com/openai/v1/models'), { up: false, why: 'offline' });
  assert.strictEqual(asked, 0);
});

test('OL1: 何かの HTTP の返事（401 でも）があれば届く。届いた結果は 60 秒、届かない結果は 15 秒覚える', T, async (tc) => {
  let hits = 0;
  const s = await serve((req, res) => { hits += 1; res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"no key"}'); });
  tc.after(() => shut(s));
  let t = 1000;
  const o = O.makeOnline({ isOnline: () => true, request: makeFakeRequest(), now: () => t });
  const u = urlOf(s);
  assert.deepStrictEqual(await o.isUp(u), { up: true, why: 'ok' });
  t += O.REACH_OK_MS - 1000; assert.deepStrictEqual(await o.isUp(u), { up: true, why: 'ok' });
  assert.strictEqual(hits, 1, '覚えている間に確かめ直した');
  t += 2000; await o.isUp(u);
  assert.strictEqual(hits, 2, '覚える長さを過ぎても確かめ直さない');
  o.forget(u); await o.isUp(u);
  assert.strictEqual(hits, 3, 'forget の後に確かめ直さない');
  await new Promise((r) => s.close(r));
  // 閉じたポート: 届かない（覚える長さは REACH_NG_MS。値そのものは変異 on-cache-ng が見る）
  const o2 = O.makeOnline({ isOnline: () => true, request: makeFakeRequest(), now: () => t });
  assert.deepStrictEqual(await o2.isUp(u), { up: false, why: 'unreachable' });
});

test('RF27: 届かない結果は 15 秒だけ覚える（届いた結果の 60 秒より短い。回線が戻ったら次の区間で気づく）', T, async () => {
  assert.ok(O.REACH_NG_MS < O.REACH_OK_MS);
  let asked = 0;
  let t = 5000;
  const o = O.makeOnline({ isOnline: () => true, now: () => t, request: makeFakeRequest({ before: (n) => { asked = n; return { error: 'net::ERR_CONNECTION_REFUSED' }; } }) });
  const u = 'http://127.0.0.1:9/v1/models';
  assert.deepStrictEqual(await o.isUp(u), { up: false, why: 'unreachable' });
  t += O.REACH_NG_MS - 1; await o.isUp(u);
  assert.strictEqual(asked, 1, '届かない結果を覚えている間に確かめ直した');
  t += 2; await o.isUp(u);
  assert.strictEqual(asked, 2, '15 秒を過ぎても確かめ直さない（届いた結果と同じ長さ覚えている）');
});

test('OL1: 転送（302）も返事のうちで「届く」。転送の先へは追わない（鍵は付けていないが、先の宛先へ要求を出さない）', T, async (tc) => {
  let moved = 0;
  const s = await serve((req, res) => {
    if (req.url === '/elsewhere') { moved += 1; res.writeHead(200); res.end('x'); return; }
    res.writeHead(302, { location: '/elsewhere' }); res.end();
  });
  tc.after(() => shut(s));
  const o = O.makeOnline({ isOnline: () => true, request: makeFakeRequest() });
  assert.deepStrictEqual(await o.isUp(urlOf(s)), { up: true, why: 'ok' });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(moved, 0, '転送の先へ要求を出した');
});

test('OL1: 返事の無いサーバーは 3 秒（ここでは 150ms）で諦めて「届かない」。要求は abort する', T, async (tc) => {
  const s = await serve(() => { /* 返事をしない */ });
  tc.after(() => shut(s));
  const o = O.makeOnline({ isOnline: () => true, request: makeFakeRequest(), timeoutMs: 150 });
  const t0 = Date.now();
  assert.deepStrictEqual(await o.isUp(urlOf(s)), { up: false, why: 'unreachable' });
  assert.ok(Date.now() - t0 < 2000);
  s.closeAllConnections(); s.close();
});

test('RF26: 証明書とプロキシの失敗を分ける（Zscaler で止められたときに理由を出すため）', T, async () => {
  const fail = (error) => O.makeOnline({ isOnline: () => true, request: makeFakeRequest({ before: () => ({ error }) }) });
  assert.deepStrictEqual(await fail('net::ERR_CERT_AUTHORITY_INVALID').isUp('http://127.0.0.1:9/x'), { up: false, why: 'cert' });
  assert.deepStrictEqual(await fail('net::ERR_TUNNEL_CONNECTION_FAILED').isUp('http://127.0.0.1:9/x'), { up: false, why: 'proxy' });
  assert.deepStrictEqual(await fail('net::ERR_PROXY_AUTH_UNSUPPORTED').isUp('http://127.0.0.1:9/x'), { up: false, why: 'proxy' });
  assert.deepStrictEqual(await fail('net::ERR_NAME_NOT_RESOLVED').isUp('http://127.0.0.1:9/x'), { up: false, why: 'unreachable' });
});

test('RF28: 経路の決め方は、会議の印・同意・鍵を、届くかの確かめより先に見る（同意していなければ要求を出さない）', T, async () => {
  let asked = 0;
  const up = (r) => async () => { asked += 1; return r; };
  const UP = { up: true, why: 'ok' };
  const cases = [
    [{ consent: 'on', localOnly: true, hasKey: true }, 'local', 'local-only'],
    [{ consent: 'off', localOnly: false, hasKey: true }, 'local', 'consent-off'],
    [{ consent: 'ask', localOnly: false, hasKey: true }, 'local', 'consent-ask'],
    [{ consent: 'on', localOnly: false, hasKey: false }, 'local', 'no-key'],
  ];
  for (const [c, route, why] of cases) {
    assert.deepStrictEqual(await O.decideStt({ ...c, up: up(UP) }), { route, why }, JSON.stringify(c));
  }
  assert.strictEqual(asked, 0, '同意・印・鍵で決まるのに、届くかを確かめた');
  assert.deepStrictEqual(await O.decideStt({ consent: 'on', localOnly: false, hasKey: true, up: up(UP) }), { route: 'cloud', why: 'ok' });
  assert.deepStrictEqual(await O.decideStt({ consent: 'on', localOnly: false, hasKey: true, up: up({ up: false, why: 'cert' }) }), { route: 'local', why: 'cert' });
  assert.deepStrictEqual(await O.decideStt({ consent: 'on', localOnly: false, hasKey: true, up: up({ up: false, why: 'offline' }) }), { route: 'local', why: 'offline' });
  // 知らない同意の値は「使わない」と同じ（外へ送らない側に倒す）
  assert.deepStrictEqual(await O.decideStt({ consent: 'yes', localOnly: false, hasKey: true, up: up(UP) }), { route: 'local', why: 'consent-off' });
});

test('D1・C10: 要約は、届けば Claude Code、届かなければ手元。［PC の中だけ］のページは届くかを確かめずに手元', T, async () => {
  assert.deepStrictEqual(await O.decideSummary({ up: async () => ({ up: true, why: 'ok' }) }), { route: 'claude-code', why: 'ok' });
  assert.deepStrictEqual(await O.decideSummary({ up: async () => ({ up: false, why: 'offline' }) }), { route: 'local', why: 'offline' });
  let asked = 0;
  assert.deepStrictEqual(await O.decideSummary({ localOnly: true, up: async () => { asked += 1; return { up: true, why: 'ok' }; } }), { route: 'local', why: 'local-only' });
  assert.strictEqual(asked, 0, '［PC の中だけ］なのに届くかを確かめた');
});
