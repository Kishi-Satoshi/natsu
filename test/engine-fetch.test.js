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
 *
 * その3（Task 6）: fetchFile の失敗の道。短い本体・止まった流れ・見出しが来ない・総量の違い・416・
 * Retry-After・404・止めの頁・プロキシの認証・圧縮・名前の変更の失敗・空き・進み具合で、止まらず・
 * 壊さず・正しいコードで終わることを固定する（第0b回 R7、RF2、RF9）。どのテストも 5 秒で切る
 * （止まった流れの見張りを外すと、永久に待たずに時間切れで赤になる）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const F = require('../src/engine-fetch');
// 偽のサーバーを立ててファイルを書き換えるテストの見張り（止まったときだけ当たる。ふだんは 1 秒まで）。Windows の CI では、ほかのテストと
// 重なった時間帯に 5 秒を越えた（第1a回 合流、run 39104480319）。5 秒の見張りは速さの目安ではないので、子のプロセスを起こすテストと同じ 20 秒にする
const IO_WAIT = { timeout: 20000 };

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
test('Content-Range が読めない 206（bad-range）は待てば直るもの。文は通信の途切れと同じ（RF14）', () => {
  assert.deepStrictEqual(F.decide(206, { 'content-range': 'bytes 5-x/1000' }, 0, { size: 1000, sha256: 'a'.repeat(64) }),
    { act: 'retry', code: 'bad-range', retryAfter: null });
  assert.ok(F.isTransient('bad-range'), 'bad-range で止めると、壊れた Content-Range の 1 回で取り込みが止まる');
  assert.strictEqual(F.fetchErrorMessage('bad-range'), F.fetchErrorMessage('net'));
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
test('途中で切れたら、次は Range: bytes=N- で続きから取り、中身は元と同じ。試しごとに1行の記録', IO_WAIT, async () => {
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
test('テストの道具: cutAfter の切断は、書き込みが少し遅くても（負荷のある機械。1 回 20ms）、届いていた分を捨てさせない（続きの位置がぶれない）', IO_WAIT, async () => {
  // 切断で Node の応答は読み残しのバイトごと捨てられる。書き込みを待つ間に次の塊が届いていると、続きの位置が cutAfter より
  // 手前になり、bytes=100000- を見るテストが負荷のときだけ赤になる（偽の net が届いた分を渡し終えてから失敗にする。下のテストも）
  const s = await startServers({ body, script: [{ cutAfter: 100000 }] });
  try {
    const openPart = async (f) => {
      const fh = await fs.promises.open(f, fs.existsSync(f) ? 'r+' : 'w+');
      return new Proxy(fh, { get: (t, k) => (k === 'write'
        ? async (...a) => { await new Promise((r) => setTimeout(r, 20)); return t.write(...a); }
        : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
    };
    const r = await fetchFile(pinOf(s.originUrl), opts(tmp(), { openPart }));
    assert.ok(fs.readFileSync(r.file).equals(body));
    assert.deepStrictEqual(s.cdnRanges(), [null, 'bytes=100000-']);
  } finally { await s.close(); }
});
test('テストの道具: 書き込みが切断の待ち（100ms）より遅くても（最初の1回が 300ms。Windows のウイルス対策が書き込みを止めたとき）、切断の前に届いたバイトは全部受け手に渡る（続きの位置が時間しだいでぶれない）', IO_WAIT, async () => {
  // 第1a回の合流の CI（Windows）で bytes=65329- が再び出た。切断の待ちを長くしても、書き込みがそれより遅ければ同じこと
  // が起きる。偽の net は、本物（Chromium の取り込みは受け手が読んだ分だけ次を渡し、届いた分を渡し終えてから失敗を知らせる）
  // と同じく、届いていた分を渡し終えてから ERR_CONNECTION_RESET にする
  const s = await startServers({ body, script: [{ cutAfter: 100000 }] });
  try {
    let first = true;
    const openPart = async (f) => {
      const fh = await fs.promises.open(f, fs.existsSync(f) ? 'r+' : 'w+');
      return new Proxy(fh, { get: (t, k) => (k === 'write'
        ? async (...a) => { if (first) { first = false; await new Promise((r) => setTimeout(r, 300)); } return t.write(...a); }
        : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
    };
    const r = await fetchFile(pinOf(s.originUrl), opts(tmp(), { openPart, stallMs: 1000 }));
    assert.ok(fs.readFileSync(r.file).equals(body));
    assert.deepStrictEqual(s.cdnRanges(), [null, 'bytes=100000-']);
  } finally { await s.close(); }
});
test('テストの道具: 偽の net は、届いた塊を1つずつ渡す（先に読んだ分をまとめて大きな1つにしない）。4MB の途中（400KB を超えたところ）の取り消しが途中で効き、記録は途中の長さ（engine-smoke の続きからと同じ形）', IO_WAIT, async () => {
  const big = crypto.randomBytes(4 << 20);
  const bigPin = (url) => ({ url, size: big.length, sha256: crypto.createHash('sha256').update(big).digest('hex') });
  const s = await startServers({ body: big });
  try {
    const dir = tmp(); const ac = new AbortController(); let biggest = 0; let first = true;   // 最初の書き込みを 100ms 待たせ、その間に届いた分を貯めさせる
    const openPart = async (f) => {
      const fh = await fs.promises.open(f, fs.existsSync(f) ? 'r+' : 'w+');
      return new Proxy(fh, { get: (t, k) => (k === 'write'
        ? async (buf, ...a) => { biggest = Math.max(biggest, buf.length); await new Promise((r) => setTimeout(r, biggest === buf.length && first ? 100 : 1)); first = false; return t.write(buf, ...a); }
        : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
    };
    const pin = bigPin(s.originUrl);
    await assert.rejects(fetchFile(pin, opts(dir, { openPart, signal: ac.signal, progressMs: 0, onProgress: (p) => { if (p.done > 400 * 1024) ac.abort(); } })), { code: 'cancelled' });
    const held = JSON.parse(fs.readFileSync(path.join(dir, `${pin.sha256}.json`), 'utf8')).synced;
    assert.ok(held > 400 * 1024 && held < big.length, `取り消した後の記録の長さが ${held}`);
    assert.ok(biggest <= 1 << 20, `1回に渡した塊が ${biggest} バイト（先に読んだ分をまとめている）`);
  } finally { await s.close(); }
});
test('試しのたびに固定の URL から始める（CDN の URL は使い回さない）。相対の 307 → 別のホストの 302 でも Range を保つ', IO_WAIT, async () => {
  const s = await startServers({ body, hops: ['307-relative', '302-cdn'], signedOnce: true, script: [{ cutAfter: 100000 }] });
  try {
    await fetchFile(pinOf(s.originUrl), opts(tmp()));
    assert.strictEqual(s.originHits(), 2);
    assert.deepStrictEqual(s.cdnRanges(), [null, 'bytes=100000-']);
    assert.ok(!s.requests().some((x) => x.name === 'cdn-expired'), '前の試しの署名付きの URL を使った');
  } finally { await s.close(); }
});
test('転送の x-linked-etag がピンと違えば、CDN へ行く前に止める（pinned-mismatch）', IO_WAIT, async () => {
  const s = await startServers({ body, linked: { size: body.length, sha256: 'b'.repeat(64) } });
  try {
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(tmp())), { code: 'pinned-mismatch' });
    assert.deepStrictEqual(s.cdnRanges(), []);
  } finally { await s.close(); }
});
test('http への転送は断る（insecure-redirect）。転送が 10 回を超えたら断る（too-many-redirects）', IO_WAIT, async () => {
  const s = await startServers({ body });
  try { await assert.rejects(fetchFile(pinOf(s.originUrl), opts(tmp(), { requireHttps: true })), { code: 'insecure-redirect' }); }
  finally { await s.close(); }
  const t = await startServers({ body, hops: [...Array(11).fill('307-relative'), '302-cdn'] });
  try {
    await assert.rejects(fetchFile(pinOf(t.originUrl), opts(tmp())), { code: 'too-many-redirects' });
    assert.deepStrictEqual(t.cdnRanges(), []);
  } finally { await t.close(); }
});
test('大きさは同じで 1 バイト違う: 1 回だけ Range なしで全部取り直し、それでも違えば hash。最後のファイルも .part も残さない', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ flipByte: 5 }, { flipByte: 5 }] });
  try {
    const dir = tmp();
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(dir)), { code: 'hash' });
    assert.deepStrictEqual(s.cdnRanges(), [null, null]);
    assert.ok(!fs.existsSync(path.join(dir, '置き場所', 'm.bin')));
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => /\.part$/.test(f)), []);
  } finally { await s.close(); }
});
test('取り終えた .part は、要求を出さずに照らして使う', IO_WAIT, async () => {
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
test('置く先にもう正しいファイルがあれば（installed.json が消えても）、要求を出さずに使う', IO_WAIT, async () => {
  const s = await startServers({ body });
  try {
    const dir = tmp(); const o = opts(dir);
    fs.mkdirSync(path.dirname(o.dest), { recursive: true }); fs.writeFileSync(o.dest, body);
    const r = await fetchFile(pinOf(s.originUrl), o);
    assert.deepStrictEqual([r.reused, s.requests().length], [true, 0]);
  } finally { await s.close(); }
});
test('取り消すと、書き込みを確定して .part と記録が残り、新しく呼ぶと記録の長さから Range で続ける', IO_WAIT, async () => {
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
test('電源が切れたときの末尾（記録の synced より後ろ）は、先に切り捨ててから続ける', IO_WAIT, async () => {
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
test('古いピンの .part（記録の url が違う）は捨てて 0 から', IO_WAIT, async () => {
  const s = await startServers({ body });
  try {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, `${SHA}.part`), body.subarray(0, 100000)); side(dir, { url: 'https://example.invalid/old', synced: 100000 });
    await fetchFile(pinOf(s.originUrl), opts(dir));
    assert.deepStrictEqual(s.cdnRanges(), [null]);
  } finally { await s.close(); }
});
test('ピンより大きい .part は、SHA-256 の違いと同じ扱い（捨てて全部取り直す。その 1 回を使う）', IO_WAIT, async () => {
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
test('転送の x-linked-size がピンと違っても（x-linked-etag は同じ）、CDN へ行く前に止める（pinned-mismatch）', IO_WAIT, async () => {
  const s = await startServers({ body, linked: { size: body.length + 1, sha256: SHA } });
  try {
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(tmp())), { code: 'pinned-mismatch' });
    assert.deepStrictEqual(s.cdnRanges(), []);
  } finally { await s.close(); }
});
test('転送はちょうど 10 回までなら追い、11 回目で断る（too-many-redirects）', IO_WAIT, async () => {
  const s = await startServers({ body, hops: [...Array(9).fill('307-relative'), '302-cdn'] });
  try {
    const r = await fetchFile(pinOf(s.originUrl), opts(tmp()));
    assert.ok(fs.readFileSync(r.file).equals(body));
  } finally { await s.close(); }
  const t = await startServers({ body, hops: [...Array(10).fill('307-relative'), '302-cdn'] });
  try {
    await assert.rejects(fetchFile(pinOf(t.originUrl), opts(tmp())), { code: 'too-many-redirects' });
    assert.deepStrictEqual(t.cdnRanges(), []);
  } finally { await t.close(); }
});
test('取り込み元そのものの認証（login の isProxy が偽）は取り消して 401 を待って試し直し、http-401 で終わる（proxy-auth にしない）', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ status: 401 }, { status: 401 }, { status: 401 }] });
  const reqs = [];
  // 本物の Electron では、login の callback を呼んだ後の応答（401）は後から届く（Chromium の network service を
  // 経由するため）。fake-net は callback の中で応答をその場で渡すので、ここで本物と同じく後に回す
  const later = (o) => {
    const r = fakeRequest(o); reqs.push(r);
    const emit = r.emit.bind(r);
    r.emit = (ev, ...a) => (ev === 'login' ? emit(ev, a[0], (...x) => setImmediate(() => a[1](...x))) : emit(ev, ...a));
    return r;
  };
  try {
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(tmp(), { maxFails: 2, request: later })), { code: 'http-401' });
    assert.strictEqual(s.cdnRanges().length, 3);
    assert.deepStrictEqual(reqs[reqs.length - 1].loginArgs, [], 'login の callback に何かを渡した');
  } finally { await s.close(); }
});

const { makeFakeRequest } = require('./helpers/fake-net');
test('正常に終わったのに短い: 本当の長さから続ける。いつも 0 バイトなら maxFails を超えて short（永久に回らない）', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ short: 1000 }] });
  try { await fetchFile(pinOf(s.originUrl), opts(tmp())); assert.deepStrictEqual(s.cdnRanges(), [null, 'bytes=1000-']); }
  finally { await s.close(); }
  const t = await startServers({ body, script: Array.from({ length: 10 }, () => ({ zero: true })) });
  try {
    await assert.rejects(fetchFile(pinOf(t.originUrl), opts(tmp(), { maxFails: 2 })), { code: 'short' });
    assert.strictEqual(t.cdnRanges().length, 3);
  } finally { await t.close(); }
});
test('止まった流れ（見出しと少しのバイトのあと黙る）は stallMs で切って続ける', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ stallAfter: 50000 }] });
  try { await fetchFile(pinOf(s.originUrl), opts(tmp(), { stallMs: 200 })); assert.deepStrictEqual(s.cdnRanges(), [null, 'bytes=50000-']); }
  finally { await s.close(); }
});
test('見出しが来ない: header-timeout を数え、待ちを倍にする（100ms → 200ms）', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ noHeaders: true }, { noHeaders: true }, { noHeaders: true }] });
  try {
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(tmp(), { headerTimeoutMs: 100, maxFails: 2 })), { code: 'header-timeout' });
    const at = s.requests().filter((x) => x.name === 'cdn').map((x) => x.at);
    assert.strictEqual(at.length, 3);
    assert.ok(at[1] - at[0] >= 90, `1 回目の待ち ${at[1] - at[0]}ms`);
    assert.ok(at[2] - at[1] >= 190, `2 回目の待ちが倍になっていない ${at[2] - at[1]}ms`);
  } finally { await s.close(); }
});
test('206 の総量がピンと違う: size-changed で .part を消す。始まりが違う: 書かずに 0 から', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ cutAfter: 100000 }, { wrongTotal: 999 }] });
  try {
    const dir = tmp();
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(dir)), { code: 'size-changed' });
    assert.ok(!fs.existsSync(path.join(dir, `${SHA}.part`)));
  } finally { await s.close(); }
  const t = await startServers({ body, script: [{ cutAfter: 100000 }, { wrongStart: 0 }] });
  try {
    const r = await fetchFile(pinOf(t.originUrl), opts(tmp()));
    assert.deepStrictEqual(t.cdnRanges(), [null, 'bytes=100000-', null]);
    assert.ok(fs.readFileSync(r.file).equals(body));
  } finally { await t.close(); }
});
test('416（まだ短い .part）: .part を捨てて Range なしで取り直す', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ always416: true }] });
  try {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, `${SHA}.part`), body.subarray(0, 100000)); side(dir, { url: s.originUrl, synced: 100000 });
    await fetchFile(pinOf(s.originUrl), opts(dir));
    assert.deepStrictEqual(s.cdnRanges(), ['bytes=100000-', null]);
  } finally { await s.close(); }
});
test('503 と Retry-After 7: 7000ms 待つ。404（text/plain）: 要求は 1 回だけで gone', IO_WAIT, async () => {
  const waits = [];
  const s = await startServers({ body, script: [{ status: 503, retryAfter: 7 }, {}] });
  try { await fetchFile(pinOf(s.originUrl), opts(tmp(), { sleep: async (ms) => { waits.push(ms); } })); assert.deepStrictEqual(waits, [7000]); }
  finally { await s.close(); }
  const t = await startServers({ body, script: [{ status: 404 }] });
  try { await assert.rejects(fetchFile(pinOf(t.originUrl), opts(tmp())), { code: 'gone' }); assert.strictEqual(t.cdnRanges().length, 1); }
  finally { await t.close(); }
});
test('止めの頁: 200 の HTML・403 の HTML・404 の HTML は、待たずに blocked（要求は 1 回）', IO_WAIT, async () => {
  for (const sc of [{ html: true }, { status: 403, html: true }, { status: 404, html: true }]) {
    const s = await startServers({ body, script: [sc, {}] });
    try {
      await assert.rejects(fetchFile(pinOf(s.originUrl), opts(tmp())), { code: 'blocked' }, JSON.stringify(sc));
      assert.strictEqual(s.cdnRanges().length, 1, JSON.stringify(sc));
    } finally { await s.close(); }
  }
});
test('407 は proxy-auth で、login の callback は何も渡さずに呼ぶ', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ status: 407 }] });
  const reqs = [];
  try {
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(tmp(), { request: (o) => { const r = fakeRequest(o); reqs.push(r); return r; } })), { code: 'proxy-auth' });
    assert.deepStrictEqual(reqs[reqs.length - 1].loginArgs, []);
  } finally { await s.close(); }
});
test('https のプロキシの認証: login の後の ERR_TUNNEL_CONNECTION_FAILED より proxy-auth が勝つ。ERR_PROXY_AUTH_UNSUPPORTED も proxy-auth。どちらも待たない', { timeout: 5000 }, async () => {
  let n = 0;
  const a = makeFakeRequest({ before: () => { n++; return { login: { isProxy: true, host: 'proxy' }, error: 'net::ERR_TUNNEL_CONNECTION_FAILED' }; } });
  await assert.rejects(fetchFile(pinOf('https://example.invalid/x'), opts(tmp(), { request: a })), { code: 'proxy-auth' });
  assert.strictEqual(n, 1);
  let m = 0;
  const b = makeFakeRequest({ before: () => { m++; return { error: 'net::ERR_PROXY_AUTH_UNSUPPORTED' }; } });
  await assert.rejects(fetchFile(pinOf('https://example.invalid/x'), opts(tmp(), { request: b })), { code: 'proxy-auth' });
  assert.strictEqual(m, 1);
});
test('圧縮された 200（プロキシが gzip にした）は、長さと SHA-256 で決めて使う。圧縮された 206 は書かずに 0 から', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ gzip: true }] });
  try { const r = await fetchFile(pinOf(s.originUrl), opts(tmp())); assert.ok(fs.readFileSync(r.file).equals(body)); }
  finally { await s.close(); }
  const t = await startServers({ body, script: [{ cutAfter: 100000 }, { gzip: true }] });
  try {
    const r = await fetchFile(pinOf(t.originUrl), opts(tmp()));
    assert.deepStrictEqual(t.cdnRanges(), [null, 'bytes=100000-', null]);
    assert.ok(fs.readFileSync(r.file).equals(body));
  } finally { await t.close(); }
});
test('名前の変更が EPERM で 2 回失敗、3 回目に通る。いつも EPERM なら locked で .part は残る', IO_WAIT, async () => {
  const s = await startServers({ body });
  try {
    let n = 0;
    const rename = async (a, b) => { if (++n <= 2) throw Object.assign(new Error('x'), { code: 'EPERM' }); return fs.promises.rename(a, b); };
    const r = await fetchFile(pinOf(s.originUrl), opts(tmp(), { rename }));
    assert.ok(fs.readFileSync(r.file).equals(body)); assert.strictEqual(n, 3);
    const dir = tmp();
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(dir, { rename: async () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } })), { code: 'locked' });
    assert.ok(fs.existsSync(path.join(dir, `${SHA}.part`)));
  } finally { await s.close(); }
});
test('書き込みで ENOSPC: space でやめ、.part は残し、needBytes に残りの大きさ', IO_WAIT, async () => {
  const s = await startServers({ body });
  try {
    const dir = tmp();
    const openPart = async (f) => {
      const fh = await fs.promises.open(f, fs.existsSync(f) ? 'r+' : 'w+'); let n = 0;
      return new Proxy(fh, { get: (t, k) => (k === 'write'
        ? async (...a) => { if (++n >= 2) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); return t.write(...a); }
        : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
    };
    const e = await fetchFile(pinOf(s.originUrl), opts(dir, { openPart })).then(() => null, (x) => x);
    assert.strictEqual(e && e.code, 'space');
    const held = fs.statSync(path.join(dir, `${SHA}.part`)).size;
    assert.strictEqual(e.needBytes, body.length - held);
  } finally { await s.close(); }
});
test('進み具合は増えるだけで、続きからの分を含み、250ms に 1 回まで（最後は必ず 1 回）', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ cutAfter: 120000 }] });
  try {
    const seen = [];
    await fetchFile(pinOf(s.originUrl), opts(tmp(), { onProgress: (p) => seen.push(p.done) }));
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], seen.join(','));
    assert.strictEqual(seen[seen.length - 1], body.length);
  } finally { await s.close(); }
  const t = await startServers({ body });
  try {
    const seen = [];
    await fetchFile(pinOf(t.originUrl), opts(tmp(), { now: () => 5000, onProgress: (p) => seen.push(p.done) }));   // 時計が進まない
    assert.deepStrictEqual(seen.length, 2, `間引いていない: ${seen.length} 回`);                                       // 最初の1回と最後の1回
  } finally { await t.close(); }
});
test('取り直し（206 の始まりが違う）で 0 から書き直しても、進み具合の done は戻らない', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ cutAfter: 100000 }, { wrongStart: 0 }] });
  try {
    const seen = []; let t = 0;
    await fetchFile(pinOf(s.originUrl), opts(tmp(), { now: () => (t += 1000), onProgress: (p) => seen.push(p.done) }));   // 毎回出す時計
    assert.deepStrictEqual(s.cdnRanges(), [null, 'bytes=100000-', null]);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], seen.join(','));
    assert.strictEqual(seen[seen.length - 1], body.length);
  } finally { await s.close(); }
});
test('書き込みが一部だけ（空きが尽きかけたときの短い書き込み）でも、残りを書き足し、置いたファイルは元と同じ', IO_WAIT, async () => {
  const s = await startServers({ body });
  try {
    const openPart = async (f) => {
      const fh = await fs.promises.open(f, fs.existsSync(f) ? 'r+' : 'w+');
      return new Proxy(fh, { get: (t, k) => (k === 'write'
        ? async (buf, off, len, pos) => t.write(buf, off, Math.ceil(len / 2), pos)   // いつも半分だけ書く
        : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
    };
    const r = await fetchFile(pinOf(s.originUrl), opts(tmp(), { openPart }));
    assert.ok(fs.readFileSync(r.file).equals(body), '穴のあいたファイルを置いた');
  } finally { await s.close(); }
});
test('待っている間（Retry-After 60 秒）に取り消すと、待ちを切り上げてすぐ cancelled。記録は残る（Task 12b の［一時停止］）', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ status: 503, retryAfter: 60 }] });
  try {
    const dir = tmp(); const ac = new AbortController(); const waits = [];
    // 本物の時計で待つ。待ち始めて 50ms で取り消す（取り消しで起きなければ 60 秒待って時間切れ）
    const sleep = (ms) => { waits.push(ms); setTimeout(() => ac.abort(), 50); return new Promise((r) => setTimeout(r, ms).unref()); };
    const t0 = Date.now();
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(dir, { signal: ac.signal, sleep })), { code: 'cancelled' });
    assert.ok(Date.now() - t0 < 2000, `待ちを切り上げていない ${Date.now() - t0}ms`);
    assert.deepStrictEqual(waits, [60000]);
    assert.ok(fs.existsSync(path.join(dir, `${SHA}.json`)), '記録が残っていない');
  } finally { await s.close(); }
});
test('名前の変更の EBUSY・EACCES も、EPERM と同じく待って試し直す（ウイルス対策が抱えたファイル。RF9）', IO_WAIT, async () => {
  const s = await startServers({ body });
  try {
    for (const code of ['EBUSY', 'EACCES']) {
      let n = 0;
      const rename = async (a, b) => { if (++n <= 2) throw Object.assign(new Error('x'), { code }); return fs.promises.rename(a, b); };
      const r = await fetchFile(pinOf(s.originUrl), opts(tmp(), { rename }));
      assert.ok(fs.readFileSync(r.file).equals(body), code);
      assert.strictEqual(n, 3, code);
    }
  } finally { await s.close(); }
});
test('見出しが来たら、見出しの待ちは headerTimeoutMs に戻る（倍にするのは続けて時間切れのときだけ）', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ noHeaders: true }, { noHeaders: true }, { noHeaders: true }, { cutAfter: 1000 }, { noHeaders: true }, {}] });
  try {
    await fetchFile(pinOf(s.originUrl), opts(tmp(), { headerTimeoutMs: 100 }));
    const at = s.requests().filter((x) => x.name === 'cdn').map((x) => x.at);
    assert.strictEqual(at.length, 6);
    assert.ok(at[3] - at[2] >= 390, `3 回続けて時間切れの後の待ちが 400ms になっていない ${at[3] - at[2]}ms`);
    assert.ok(at[5] - at[4] < 500, `見出しが来た後も待ちが 800ms のまま ${at[5] - at[4]}ms`);
  } finally { await s.close(); }
});
test('途中の記録の書き込み（一時ファイル → .json）が EPERM で失敗しても、取り込みは続けて終える（記録は前の長さのまま。RF9）', IO_WAIT, async () => {
  const s = await startServers({ body });
  // 記録は部品（jsonfile.writeJsonFile）で書く: 一時ファイル <記録>.<pid>-<乱数>.tmp → fs.renameSync（opts.rename は置く先だけ）。
  // 2 回目の書き込み（途中の確定）の名前の変更だけを、部品のやり直しも含めて全部失敗させる（やり直しの待ちは縮める）
  const J = require('../src/jsonfile');
  const orig = fs.renameSync; const origSleep = J.sleepSync; let k = 0; let last = null;
  fs.renameSync = (a, b) => {
    if (/\.json\.\d+-[0-9a-z]+\.tmp$/.test(String(a))) {
      if (a !== last) { k += 1; last = a; }   // 一時ファイルの名前が新しければ、新しい書き込み（同じ名前はやり直し）
      if (k === 2) throw Object.assign(new Error('x'), { code: 'EPERM' });
    }
    return orig.call(fs, a, b);
  };
  J.sleepSync = () => {};
  // 本体を 4KB ずつ渡す（失敗の後も syncEvery ごとにしか記録を試さないことを、塊の大きさに左右されずに見る）
  async function* pieces(src) { for await (const c of src) for (let i = 0; i < c.length; i += 4096) yield c.subarray(i, i + 4096); }
  const small = (o) => {
    const r = fakeRequest(o);
    const emit = r.emit.bind(r);
    r.emit = (ev, ...a) => {
      if (ev !== 'response') return emit(ev, ...a);
      const out = Readable.from(pieces(a[0]), { objectMode: false });
      out.statusCode = a[0].statusCode; out.headers = a[0].headers;
      return emit(ev, out);
    };
    return r;
  };
  try {
    const dir = tmp();
    const r = await fetchFile(pinOf(s.originUrl), opts(dir, { syncEvery: 64 * 1024, request: small }));
    assert.ok(fs.readFileSync(r.file).equals(body));
    // 始め 1・途中 4（64K・128K・192K・256K。2 回目の書き込みが失敗）・終わり 1
    assert.strictEqual(k, 6, `記録を書いた回数 ${k}（失敗の後に書かない／syncEvery ごとより多く書いた）`);
    assert.deepStrictEqual(leftovers(dir), []);
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], '記録の一時ファイルが残った');
  } finally { fs.renameSync = orig; J.sleepSync = origSleep; await s.close(); }
});
test('始めの確定（.part の続きを記録に書く前の fsync）で ENOSPC でも、space でやめ、needBytes に残りの大きさ', IO_WAIT, async () => {
  const s = await startServers({ body });
  try {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, `${SHA}.part`), body.subarray(0, 100000)); side(dir, { url: s.originUrl, synced: 100000 });
    const openPart = async (f) => {
      const fh = await fs.promises.open(f, 'r+'); let n = 0;
      return new Proxy(fh, { get: (t, k) => (k === 'sync'
        ? async () => { if (++n === 1) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); return t.sync(); }
        : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
    };
    const e = await fetchFile(pinOf(s.originUrl), opts(dir, { openPart })).then(() => null, (x) => x);
    assert.strictEqual(e && e.code, 'space', e && e.message);
    assert.strictEqual(e.needBytes, body.length - 100000);
    assert.strictEqual(s.requests().length, 0);
  } finally { await s.close(); }
});
test('名前の変更を待っている間に取り消すと、待ちを切り上げてすぐ cancelled（.part と記録は残る）', IO_WAIT, async () => {
  const s = await startServers({ body });
  try {
    const dir = tmp(); const ac = new AbortController();
    const rename = async () => { setTimeout(() => ac.abort(), 50); throw Object.assign(new Error('x'), { code: 'EPERM' }); };
    const sleep = () => new Promise((r) => setTimeout(r, 60000).unref());   // 長い待ち（取り消しで起きなければ時間切れ）
    const t0 = Date.now();
    await assert.rejects(fetchFile(pinOf(s.originUrl), opts(dir, { signal: ac.signal, rename, sleep })), { code: 'cancelled' });
    assert.ok(Date.now() - t0 < 2000, `待ちを切り上げていない ${Date.now() - t0}ms`);
    assert.ok(fs.existsSync(path.join(dir, `${SHA}.part`)) && fs.existsSync(path.join(dir, `${SHA}.json`)));
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- 圧縮するプロキシ（第0b回 Task 9 の electron-net で分かったこと）
// 本物の Electron（第0b回は 31.7.7。第0c回から 44.9.0 でも同じ）の Chromium は、送った Accept-Encoding に無い content-encoding の応答を、伸ばさずに
// net::ERR_CONTENT_DECODING_FAILED で断る（identity を頼んだ要求に gzip が返ったとき。2026-10-17 の CI）。
// Accept-Encoding を自分で付けなければ、Range のときは identity、ほかは gzip などを Chromium が頼み、伸ばして渡す。
// fake-net はこれを真似る。fetchFile は断られたら、Accept-Encoding と Range を付けずに 0 から取り直し、
// 圧縮された 200 は長さを見ずに SHA-256 で決める（decide の skipLength）。
test('fake-net: identity を頼んで gzip が返ると ERR_CONTENT_DECODING_FAILED（応答は渡さない）。自分で付けなければ gzip を頼んで伸ばす。Range のときは identity', IO_WAIT, async () => {
  const s = await startServers({ body, script: [{ gzip: true }, { gzip: true }, {}] });
  const one = (headers) => new Promise((resolve) => {
    const req = fakeRequest({ method: 'GET', url: s.originUrl, redirect: 'manual', cache: 'no-store' });
    req.on('redirect', () => req.followRedirect());
    req.on('response', (res) => { const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => resolve({ res, body: Buffer.concat(cs) })); });
    req.on('error', (e) => resolve({ error: e.message }));
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    req.end();
  });
  try {
    const a = await one({ 'Accept-Encoding': 'identity' });
    // 応答の流れの写しを比べると、失敗の表示が大きくなりすぎるので、値だけを比べる
    assert.strictEqual(a.error, 'net::ERR_CONTENT_DECODING_FAILED', '頼んでいない圧縮を伸ばして渡した');
    assert.ok(!a.res, '断るときは応答を渡さない');
    const b = await one({});
    assert.strictEqual(b.res.statusCode, 200);
    assert.ok(b.body.equals(body), '伸ばしていない');
    assert.strictEqual(b.res.headers['content-encoding'], 'gzip', '見出しは元のまま');
    await one({ Range: 'bytes=10-' });
    assert.deepStrictEqual(s.requests().filter((x) => x.name === 'cdn').map((x) => x.enc), ['identity', 'gzip, deflate', 'identity']);
  } finally { await s.close(); }
});
test('通信の失敗: ERR_CONTENT_DECODING_FAILED は encoding（頼んでいない圧縮。待っても直らないので待たない）', () => {
  assert.strictEqual(F.classifyNetError(new Error('net::ERR_CONTENT_DECODING_FAILED')), 'encoding');
  assert.ok(!F.isTransient('encoding'), 'encoding で待ち続けると、圧縮するプロキシの PC で「つながるのを待っています」のまま');
});
test('圧縮するプロキシ: identity を頼んで断られたら、Accept-Encoding と Range を付けずに 0 から取り直し、伸ばした中身を SHA-256 で照らして使う', IO_WAIT, async () => {
  const s = await startServers({ body, script: Array.from({ length: 5 }, () => ({ gzip: true })) });
  try {
    const dir = tmp();
    const r = await fetchFile(pinOf(s.originUrl), opts(dir));
    assert.ok(fs.readFileSync(r.file).equals(body));
    const cdn = s.requests().filter((x) => x.name === 'cdn');
    assert.deepStrictEqual(cdn.map((x) => x.enc), ['identity', 'gzip, deflate'], '断られた後も identity を頼んでいる');
    assert.deepStrictEqual(cdn.map((x) => x.range), [null, null]);
    assert.deepStrictEqual(leftovers(dir), []);
  } finally { await s.close(); }
  // 途中まで取ってから圧縮が始まった: 続き（Range）は断られるので、0 から取り直す
  const t = await startServers({ body, script: [{ cutAfter: 100000 }, ...Array.from({ length: 5 }, () => ({ gzip: true }))] });
  try {
    const r = await fetchFile(pinOf(t.originUrl), opts(tmp()));
    assert.ok(fs.readFileSync(r.file).equals(body));
    assert.deepStrictEqual(t.cdnRanges(), [null, 'bytes=100000-', null]);
  } finally { await t.close(); }
});
