/*
 * engine-fetch.test.js — エンジンとモデルの取り込み src/engine-fetch.js
 *
 * その1（Task 4）: 通信の応答をどう扱うか（decide）、通信の失敗の分け方（classifyNetError）、
 * 待つ時間（backoffMs）、待てば直るもの・担当に渡すもの、利用者向けの文を、通信なしの
 * 表で固定する（第0b回 R7、RF2、RF10、RF14）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const F = require('../src/engine-fetch');
test('Content-Range を読む', () => {
  assert.deepStrictEqual(F.parseContentRange('bytes 1000-1015/885098'), { start: 1000, end: 1015, total: 885098 });
  assert.strictEqual(F.parseContentRange('bytes */885098'), null);
  assert.strictEqual(F.parseContentRange(undefined), null);
});
test('待つ時間: 1・2・4・8・16・30 秒（±20%）。Retry-After は 120 秒まで守る', () => {
  const mid = () => 0.5;
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7].map((n) => F.backoffMs(n, null, mid)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.strictEqual(F.backoffMs(1, 7, mid), 7000);
  assert.strictEqual(F.backoffMs(1, 999, mid), 120000);
  assert.ok(F.backoffMs(3, null, () => 0) >= 3200 && F.backoffMs(3, null, () => 0.999) <= 4800);
});
test('通信の失敗を分ける（Chromium の net::ERR_* と Node の errno）。プロキシの認証は proxy より先', () => {
  const t = [['net::ERR_CERT_AUTHORITY_INVALID', 'cert'], ['net::ERR_TUNNEL_CONNECTION_FAILED', 'proxy'], ['net::ERR_PROXY_CONNECTION_FAILED', 'proxy'],
    ['net::ERR_PROXY_AUTH_UNSUPPORTED', 'proxy-auth'], ['net::ERR_PROXY_AUTH_REQUESTED', 'proxy-auth'], ['net::ERR_UNEXPECTED_PROXY_AUTH', 'proxy-auth'],
    ['net::ERR_NAME_NOT_RESOLVED', 'offline'], ['net::ERR_INTERNET_DISCONNECTED', 'offline'], ['net::ERR_CONNECTION_RESET', 'net']];
  for (const [m, c] of t) assert.strictEqual(F.classifyNetError(new Error(m)), c, m);
  assert.strictEqual(F.classifyNetError(Object.assign(new Error('x'), { code: 'ENOSPC' })), 'space');
});
test('応答の扱い（206 の始まりと総量・200・416・404・407・451・5xx・4xx の HTML・gzip）', () => {
  const pin = { size: 1000, sha256: 'a'.repeat(64) };
  const d = (s, h, held = 0) => F.decide(s, h, held, pin);
  assert.deepStrictEqual(d(206, { 'Content-Range': 'bytes 500-999/1000' }, 500), { act: 'write', from: 500 });
  assert.deepStrictEqual(d(206, { 'content-range': ['bytes 400-999/1000'] }, 500), { act: 'restart', code: 'range-start' });
  assert.deepStrictEqual(d(206, { 'content-range': 'bytes 500-999/2000' }, 500), { act: 'fail', code: 'size-changed' });
  assert.deepStrictEqual(d(206, { 'content-range': 'bytes 500-999/1000', 'content-encoding': 'gzip' }, 500), { act: 'restart', code: 'encoding' });
  assert.deepStrictEqual(d(200, { 'content-length': '1000' }, 500), { act: 'write', from: 0 });
  assert.deepStrictEqual(d(200, { 'content-length': '999' }), { act: 'fail', code: 'size-changed' });
  assert.deepStrictEqual(d(200, { 'content-encoding': 'gzip', 'content-length': '123' }), { act: 'write', from: 0, skipLength: true });
  assert.deepStrictEqual(d(200, { 'content-type': 'text/html; charset=utf-8' }), { act: 'fail', code: 'blocked' });
  assert.deepStrictEqual(d(403, { 'content-type': 'text/html' }), { act: 'fail', code: 'blocked' });
  assert.deepStrictEqual(d(404, { 'content-type': 'text/html' }), { act: 'fail', code: 'blocked' });
  assert.deepStrictEqual(d(451, {}), { act: 'fail', code: 'blocked' });
  assert.deepStrictEqual(d(416, {}, 500), { act: 'restart', code: 'range-416' });
  for (const s of [404, 410]) assert.deepStrictEqual(d(s, { 'content-type': 'text/plain' }), { act: 'fail', code: 'gone' });
  assert.deepStrictEqual(d(407, { 'content-type': 'text/html' }), { act: 'fail', code: 'proxy-auth' });
  for (const s of [401, 403, 408, 429, 500, 502, 503]) assert.strictEqual(d(s, {}).act, 'retry', String(s));
  assert.strictEqual(d(502, { 'content-type': 'text/html' }).act, 'retry', '5xx の HTML は待てば直る');
  assert.strictEqual(d(503, { 'retry-after': '7' }).retryAfter, 7);
  assert.deepStrictEqual(d(418, {}), { act: 'fail', code: 'http-418' });
});
test('408・429 の HTML は止めの頁にしない（github.com の回数の制限の頁は 429 の HTML）。416 の HTML も取り直し', () => {
  const pin = { size: 1000, sha256: 'a'.repeat(64) };
  const html = { 'content-type': 'text/html', 'retry-after': '30' };
  assert.deepStrictEqual(F.decide(429, html, 0, pin), { act: 'retry', code: 'http-429', retryAfter: 30 });
  assert.deepStrictEqual(F.decide(408, html, 0, pin), { act: 'retry', code: 'http-408', retryAfter: 30 });
  assert.deepStrictEqual(F.decide(416, { 'content-type': 'text/html' }, 500, pin), { act: 'restart', code: 'range-416' });
  assert.deepStrictEqual(F.decide(401, { 'content-type': 'text/html' }, 0, pin), { act: 'fail', code: 'blocked' });
});
test('待てば直るもの（isTransient）と、担当に渡すもの（askIt）', () => {
  for (const c of ['offline', 'net', 'short', 'stall', 'header-timeout', 'http-408', 'http-429', 'http-503']) assert.ok(F.isTransient(c), c);
  for (const c of ['proxy', 'proxy-auth', 'cert', 'blocked', 'hash', 'space', 'gone', 'http-403', 'locked']) assert.ok(!F.isTransient(c), c);
  for (const c of ['proxy-auth', 'cert', 'blocked', 'hash', 'http-401', 'http-403', 'insecure-redirect', 'defender']) assert.ok(F.askIt(c), c);
  for (const c of ['offline', 'space', 'gone', 'locked']) assert.ok(!F.askIt(c), c);
});
test('利用者向けの文: どれも「することを1つ」で終わり、SHA-256 の語を出さない', () => {
  const codes = ['waiting', 'offline', 'proxy', 'proxy-auth', 'cert', 'blocked', 'http-401', 'http-403', 'space', 'hash', 'gone', 'size-changed',
    'pinned-mismatch', 'place-in-use', 'locked', 'defender', 'net', 'short', 'stall', 'header-timeout', 'insecure-redirect', 'too-many-redirects', 'what'];
  for (const c of codes) {
    const m = F.fetchErrorMessage(c, { file: 'X.dll' });
    assert.match(m, /(ください|押してください)。$/, c);
    assert.ok(!/SHA-256/.test(m), c);
    if (F.askIt(c) && c !== 'proxy') assert.ok(m.includes('［担当に渡す内容を写す］'), c);
  }
  assert.match(F.fetchErrorMessage('waiting'), /［今すぐ試す］/);
  assert.match(F.fetchErrorMessage('space', { needGB: 2.4 }), /あと 2\.4 GB/);
  assert.ok(!/\d/.test(F.fetchErrorMessage('space')), 'needGB が無いのに数を出した');
  for (const c of ['gone', 'size-changed', 'pinned-mismatch']) assert.match(F.fetchErrorMessage(c), /NaTsu の更新が必要/);
  assert.match(F.fetchErrorMessage('http-403'), /止められた可能性/);
  assert.match(F.fetchErrorMessage('proxy'), /huggingface\.co/);
  assert.match(F.fetchErrorMessage('what'), /what/);
});
