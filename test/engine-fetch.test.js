/*
 * engine-fetch.test.js — エンジンとモデルの取り込み src/engine-fetch.js
 *
 * その1（Task 4）: 通信の応答をどう扱うか（decide）、通信の失敗の分け方（classifyNetError）、
 * 待つ時間（backoffMs）、待てば直るもの・担当に渡すもの、利用者向けの文を、通信なしの
 * 表で固定する（第0b回 R7、RF2、RF10、RF14）。
 *
 * その2（Task 5）: fetchFile の本体。127.0.0.1 の偽の取得元と CDN（test/helpers/range-server.js）へ、
 * Electron の net.request と同じ振る舞いの偽物（test/helpers/fake-net.js）で取りに行き、続きから・
 * 転送・記録・SHA-256 の照らしを確かめる（第0b回 R7、RF6、RF9）。一時フォルダの名前には日本語と 𠮷。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

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

const { fetchFile } = require('../src/engine-fetch');
const { fakeRequest } = require('./helpers/fake-net');
const { startServers } = require('./helpers/range-server');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-取込𠮷-'));
const body = crypto.randomBytes(300000);
const SHA = crypto.createHash('sha256').update(body).digest('hex');
const pinOf = (url) => ({ url, size: body.length, sha256: SHA });
const opts = (dir, o = {}) => ({ dir, dest: path.join(dir, '置き場所', 'm.bin'), request: fakeRequest, sleep: async () => {},
  requireHttps: false, headerTimeoutMs: 2000, stallMs: 300, ...o });
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => /\.(part|json)$/.test(f));
const side = (dir, o) => fs.writeFileSync(path.join(dir, `${SHA}.json`), JSON.stringify({ url: o.url, size: body.length, sha256: SHA, synced: o.synced }));
test('途中で切れたら、次は Range: bytes=N- で続きから取り、中身は元と同じ。試しごとに1行の記録', async () => {
  const s = await startServers({ body, script: [{ cutAfter: 120000 }] });
  try {
    const dir = tmp(); const lines = [];
    const r = await fetchFile(pinOf(s.originUrl), opts(dir, { log: (l) => lines.push(l) }));
    assert.ok(fs.readFileSync(r.file).equals(body));
    assert.deepStrictEqual(s.cdnRanges(), [null, 'bytes=120000-']);
    assert.deepStrictEqual(lines, ['取り込み: m.bin 0/300000 から続ける', '取り込み: m.bin 120000/300000 から続ける']);
    assert.deepStrictEqual(leftovers(dir), [], '.part と記録が残っている');
  } finally { await s.close(); }
});
test('試しのたびに固定の URL から始める（CDN の URL は使い回さない）。相対の 307 → 別のホストの 302 でも Range を保つ', async () => {
  const s = await startServers({ body, hops: ['307-relative', '302-cdn'], signedOnce: true, script: [{ cutAfter: 100000 }] });
  try {
    await fetchFile(pinOf(s.originUrl), opts(tmp()));
    assert.strictEqual(s.originHits(), 2);
    assert.deepStrictEqual(s.cdnRanges(), [null, 'bytes=100000-']);
    assert.ok(!s.requests().some((x) => x.name === 'cdn-expired'), '前の試しの署名付きの URL を使った');
  } finally { await s.close(); }
});
test('転送の x-linked-etag がピンと違えば、CDN へ行く前に止める（pinned-mismatch）', async () => {
  const s = await startServers({ body, linked: { size: body.length, sha256: 'b'.repeat(64) } });
  try {
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(tmp())), { code: 'pinned-mismatch' });
    assert.deepStrictEqual(s.cdnRanges(), []);
  } finally { await s.close(); }
});
test('http への転送は断る（insecure-redirect）。転送が 10 回を超えたら断る（too-many-redirects）', async () => {
  const s = await startServers({ body });
  try { await assert.rejects(fetchFile(pinOf(s.originUrl), opts(tmp(), { requireHttps: true })), { code: 'insecure-redirect' }); }
  finally { await s.close(); }
  const t = await startServers({ body, hops: [...Array(11).fill('307-relative'), '302-cdn'] });
  try {
    await assert.rejects(fetchFile(pinOf(t.originUrl), opts(tmp())), { code: 'too-many-redirects' });
    assert.deepStrictEqual(t.cdnRanges(), []);
  } finally { await t.close(); }
});
test('大きさは同じで 1 バイト違う: 1 回だけ Range なしで全部取り直し、それでも違えば hash。最後のファイルも .part も残さない', async () => {
  const s = await startServers({ body, script: [{ flipByte: 5 }, { flipByte: 5 }] });
  try {
    const dir = tmp();
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(dir)), { code: 'hash' });
    assert.deepStrictEqual(s.cdnRanges(), [null, null]);
    assert.ok(!fs.existsSync(path.join(dir, '置き場所', 'm.bin')));
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => /\.part$/.test(f)), []);
  } finally { await s.close(); }
});
test('取り終えた .part は、要求を出さずに照らして使う', async () => {
  const s = await startServers({ body });
  try {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, `${SHA}.part`), body); side(dir, { url: s.originUrl, synced: body.length });
    const r = await fetchFile(pinOf(s.originUrl), opts(dir));
    assert.strictEqual(s.requests().length, 0);
    assert.ok(fs.readFileSync(r.file).equals(body));
    assert.deepStrictEqual(leftovers(dir), []);
  } finally { await s.close(); }
});
test('置く先にもう正しいファイルがあれば（installed.json が消えても）、要求を出さずに使う', async () => {
  const s = await startServers({ body });
  try {
    const dir = tmp(); const o = opts(dir);
    fs.mkdirSync(path.dirname(o.dest), { recursive: true }); fs.writeFileSync(o.dest, body);
    const r = await fetchFile(pinOf(s.originUrl), o);
    assert.deepStrictEqual([r.reused, s.requests().length], [true, 0]);
  } finally { await s.close(); }
});
test('取り消すと、書き込みを確定して .part と記録が残り、新しく呼ぶと記録の長さから Range で続ける', async () => {
  const s = await startServers({ body, script: [{ stallAfter: 100000 }] });   // 10 万バイト送って黙る
  try {
    const dir = tmp(); const ac = new AbortController();
    let t = 0; const now = () => (t += 1000);                    // 毎回 250ms 以上進む時計（進み具合を毎回出す）
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(dir, { signal: ac.signal, now,
      onProgress: (p) => { if (p.done > 0) ac.abort(); } })), { code: 'cancelled' });
    const held = JSON.parse(fs.readFileSync(path.join(dir, `${SHA}.json`), 'utf8')).synced;
    assert.ok(held > 0 && held <= 100000, String(held));
    assert.strictEqual(fs.statSync(path.join(dir, `${SHA}.part`)).size, held);
    await fetchFile(pinOf(s.originUrl), opts(dir));
    assert.deepStrictEqual(s.cdnRanges().slice(-1), [`bytes=${held}-`]);
  } finally { await s.close(); }
});
test('電源が切れたときの末尾（記録の synced より後ろ）は、先に切り捨ててから続ける', async () => {
  const s = await startServers({ body });
  try {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, `${SHA}.part`), Buffer.concat([body.subarray(0, 100000), Buffer.alloc(50000)]));
    side(dir, { url: s.originUrl, synced: 100000 });
    const r = await fetchFile(pinOf(s.originUrl), opts(dir));
    assert.deepStrictEqual(s.cdnRanges(), ['bytes=100000-']);
    assert.ok(fs.readFileSync(r.file).equals(body));
  } finally { await s.close(); }
});
test('古いピンの .part（記録の url が違う）は捨てて 0 から', async () => {
  const s = await startServers({ body });
  try {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, `${SHA}.part`), body.subarray(0, 100000)); side(dir, { url: 'https://example.invalid/old', synced: 100000 });
    await fetchFile(pinOf(s.originUrl), opts(dir));
    assert.deepStrictEqual(s.cdnRanges(), [null]);
  } finally { await s.close(); }
});
test('ピンより大きい .part は、SHA-256 の違いと同じ扱い（捨てて全部取り直す。その 1 回を使う）', async () => {
  const s = await startServers({ body });
  try {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, `${SHA}.part`), Buffer.concat([body, Buffer.from('x')])); side(dir, { url: s.originUrl, synced: body.length + 1 });
    await fetchFile(pinOf(s.originUrl), opts(dir));
    assert.deepStrictEqual(s.cdnRanges(), [null]);
  } finally { await s.close(); }
  const t = await startServers({ body, script: [{ flipByte: 5 }] });
  try {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, `${SHA}.part`), Buffer.concat([body, Buffer.from('x')])); side(dir, { url: t.originUrl, synced: body.length + 1 });
    await assert.rejects(fetchFile(pinOf(t.originUrl), opts(dir)), { code: 'hash' });
    assert.deepStrictEqual(t.cdnRanges(), [null], '取り直しを 2 回使った');
  } finally { await t.close(); }
});
