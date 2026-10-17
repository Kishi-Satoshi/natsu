/*
 * net-smoke.js — 本物の Electron 31 の net.request が、取り込みの前提どおりに動くかを確かめる（第0b回 RF2）
 *
 * 取り込み（src/engine-fetch.js の fetchFile）は、テストでは偽物の net.request（test/helpers/fake-net.js）の
 * 上でしか試していない。本物が同じに動くかを、Windows の CI（ci.yml の electron-net）で毎回見る。
 *
 * 走らせ方（Electron の main として。窓は作らない）:
 *   "<Electron を入れたフォルダ>/node_modules/electron/dist/electron.exe" tools/net-smoke.js
 * 127.0.0.1 の偽の取得元と CDN（test/helpers/range-server.js）を立て、次の 8 つを確かめる。
 *   1. redirect: 'manual' で 'redirect' が出て、見出しの値が配列、followRedirect() で続く
 *   2. 相対の 307 の Location が、絶対の URL で渡される
 *   3. setHeader('Range', …) が、転送の先（cdn）まで届く
 *   4. abort() で 'abort' が出て、'error' は出ない（見出しを待つ間・本体の途中）
 *   5. cache: 'no-store' で、同じ URL の 2 回目もサーバーに届く
 *   6. Accept-Encoding: identity がサーバーに届く
 *   7. 本番の fetchFile に net.request を渡して、途中で切れる cdn から続きを取り、SHA-256 が合う
 *   8. 圧縮するプロキシ（cdn がいつも gzip で返す）。Accept-Encoding を自分で付けない要求は、Chromium が
 *      gzip を頼んで伸ばし、見出しの content-encoding と content-length（圧縮した長さ）は元のまま（decide の
 *      skipLength の前提）。本番の fetchFile も最後まで取り、SHA-256 が合う（identity を頼んで断られたら、
 *      Accept-Encoding と Range を付けずに 0 から取り直す）。identity を頼んだ要求がどうなるかは参考に出す
 *      （2026-10-17 の初回は net::ERR_CONTENT_DECODING_FAILED で断られた。伸ばして渡す前提は外れていた）
 * 結果は 1 行ずつ OK／NG で出す。全部 OK なら終了コード 0、1 つでも NG（か数が足りない）なら 1（exitCodeOf）。どこかで止まっても、
 * 120 秒の見張りで 1 で終わる（ジョブの 15 分を待たない）。
 *
 * 確かめの本体（runChecks）は、通信の口（request）を引数でもらう。テスト（test/ci.test.js）は、
 * 同じ確かめを偽物の上で回して、確かめそのものが動くことを見る。Electron を読むのは、Electron の
 * main として動いたときだけ（下の boot）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { fetchFile } = require('../src/engine-fetch');
const { startServers } = require('../test/helpers/range-server');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const BODY = crypto.randomBytes(1 << 20);                  // 1MB。中身は毎回違う
const BODY_SHA = sha(BODY);
const TEXT = Buffer.from('NaTsu の取り込みの試し。圧縮がよく効く文字の並び。\n'.repeat(4000));

/** 見出しの値（名前の大文字小文字を問わない） */
function headerOf(h, name) {
  const k = Object.keys(h || {}).find((x) => x.toLowerCase() === name);
  return k === undefined ? undefined : h[k];
}
const one = (v) => (Array.isArray(v) ? v[0] : v);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (cond()) return true;
  return cond();
}

/**
 * 1 回の要求を、取り込みと同じ形（redirect: 'manual'。既定は cache: 'no-store'）で出し、最後まで読む
 * → { status, headers, body, redirects: [{ status, method, url, headers }] }
 */
function exchange(request, url, { headers = {}, noStore = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(noStore
      ? { method: 'GET', url, redirect: 'manual', cache: 'no-store' }
      : { method: 'GET', url, redirect: 'manual' });
    const redirects = [];
    req.on('redirect', (status, method, newUrl, h) => {
      redirects.push({ status, method, url: newUrl, headers: h });
      req.followRedirect();
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), redirects }));
      res.on('error', reject);
    });
    req.on('error', reject);
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    req.end();
  });
}

// ---------------------------------------------------------------- 8 つの確かめ（{ ok, detail } を返す）

async function checkRedirect(c) {
  const s = await c.serve({ body: BODY, linked: { size: BODY.length, sha256: BODY_SHA } });
  const r = await exchange(c.request, s.originUrl);
  if (r.redirects.length !== 1) return { ok: false, detail: `'redirect' が ${r.redirects.length} 回` };
  const d = r.redirects[0];
  const notArray = Object.entries(d.headers || {}).filter(([, v]) => !Array.isArray(v)).map(([k]) => k);
  const etag = headerOf(d.headers, 'x-linked-etag');
  const detail = `${d.status} ${d.method}、見出し ${Object.keys(d.headers || {}).length} 個、x-linked-etag=${JSON.stringify(etag)}、最後 ${r.status}`;
  if (d.status !== 302 || d.method !== 'GET') return { ok: false, detail };
  if (notArray.length) return { ok: false, detail: `${detail}。配列でない見出し: ${notArray.join(', ')}` };
  if (one(etag) !== `"${BODY_SHA}"`) return { ok: false, detail };
  if (r.status !== 200 || sha(r.body) !== BODY_SHA) return { ok: false, detail: `${detail}、本体 ${r.body.length} バイト` };
  return { ok: true, detail };
}

async function checkRelative(c) {
  const s = await c.serve({ body: BODY, hops: ['307-relative', '302-cdn'] });
  const r = await exchange(c.request, s.originUrl);
  const want = new URL('s1', s.originUrl).toString();
  const got = r.redirects.map((x) => `${x.status} ${x.url}`);
  const first = r.redirects[0];
  const ok = Boolean(first) && first.status === 307 && first.url === want && r.redirects.length === 2 && r.status === 200;
  return { ok, detail: `${got.join(' → ')}（期待 307 ${want}）` };
}

async function checkRange(c) {
  const s = await c.serve({ body: BODY });
  const from = 1000;
  const r = await exchange(c.request, s.originUrl, { headers: { 'Range': `bytes=${from}-` } });   // 取り込みと同じ名前
  const ranges = s.cdnRanges();
  const cr = one(headerOf(r.headers, 'content-range'));
  const want = `bytes ${from}-${BODY.length - 1}/${BODY.length}`;
  const ok = r.status === 206 && JSON.stringify(ranges) === JSON.stringify([`bytes=${from}-`]) && cr === want
    && r.body.equals(BODY.subarray(from));
  return { ok, detail: `cdn が受けた Range ${JSON.stringify(ranges)}、${r.status}、Content-Range ${JSON.stringify(cr)}` };
}

// 取り消しの見張り: 'abort' が 1 回出て、要求の 'error' は出ないこと（応答の流れの出来事は記録だけ）
function abortCase(c, url, when, ready) {
  return new Promise((resolve) => {
    const ev = { abort: 0, error: [], response: false, resError: [], resEnd: false };
    const req = c.request({ method: 'GET', url, redirect: 'manual', cache: 'no-store' });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      req.abort();
      setTimeout(() => resolve(ev), 300);
    };
    req.on('redirect', () => req.followRedirect());
    req.on('abort', () => { ev.abort += 1; });
    req.on('error', (e) => ev.error.push(String((e && e.message) || e)));
    req.on('response', (res) => {
      ev.response = true;
      res.on('error', (e) => ev.resError.push(String((e && e.message) || e)));
      res.on('end', () => { ev.resEnd = true; });
      if (when === 'body') res.once('data', stop);
    });
    req.end();
    if (when === 'headers') until(ready, 3000).then(stop);
  });
}

async function checkAbort(c) {
  // 1 回目の cdn は見出しを返さない。2 回目は 64KB だけ送って黙る
  const s = await c.serve({ body: BODY, script: [{ noHeaders: true }, { stallAfter: 64 * 1024 }] });
  const cdnSeen = (n) => () => s.requests().filter((x) => x.name === 'cdn').length >= n;
  const a = await abortCase(c, s.originUrl, 'headers', cdnSeen(1));
  const b = await abortCase(c, s.originUrl, 'body');
  const show = (name, e) => `${name}: abort ${e.abort} 回、error ${e.error.length ? JSON.stringify(e.error) : 'なし'}`
    + `${e.response ? `、応答の流れ（error ${e.resError.length ? JSON.stringify(e.resError) : 'なし'}・end ${e.resEnd ? 'あり' : 'なし'}）` : ''}`;
  const ok = a.abort === 1 && a.error.length === 0 && !a.response && b.abort === 1 && b.error.length === 0 && b.response;
  return { ok, detail: `${show('見出しを待つ間', a)}／${show('本体の途中', b)}` };
}

async function checkNoStore(c) {
  // 新しさが 1 時間ある応答。キャッシュを使えば、2 回目はサーバーに来ない
  const hits = {};
  const srv = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'max-age=3600', 'content-length': 5 });
    res.end('natsu');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  c.closers.push(() => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }));
  const base = `http://127.0.0.1:${srv.address().port}`;
  for (let i = 0; i < 2; i++) await exchange(c.request, `${base}/no-store`);
  // 参考: 指定なし。1 回なら、キャッシュが効く状況で上を試せている
  for (let i = 0; i < 2; i++) await exchange(c.request, `${base}/default`, { noStore: false });
  const n = hits['/no-store'] || 0;
  const d = hits['/default'] || 0;
  return { ok: n === 2, detail: `no-store で ${n} 回届いた（参考: 指定なしでは ${d} 回${d === 1 ? '。キャッシュが効く状況で試せている' : ''}）` };
}

async function checkIdentity(c) {
  const s = await c.serve({ body: BODY });
  const r = await exchange(c.request, s.originUrl, { headers: { 'Accept-Encoding': 'identity' } });
  const got = s.requests().filter((x) => x.name === 'cdn').map((x) => x.enc);
  return { ok: r.status === 200 && JSON.stringify(got) === '["identity"]', detail: `cdn が受けた Accept-Encoding ${JSON.stringify(got)}` };
}

async function checkFetchFile(c) {
  const cut = 256 * 1024;
  const s = await c.serve({ body: BODY, script: [{ cutAfter: cut }] });
  const dir = c.tmp();
  const lines = [];
  const r = await fetchFile({ url: s.originUrl, size: BODY.length, sha256: BODY_SHA }, {
    dir: path.join(dir, '.download'), dest: path.join(dir, 'models', 'm.bin'), request: c.request,
    requireHttps: false, headerTimeoutMs: 10000, stallMs: 10000, sleep: (ms) => wait(Math.min(ms, 50)), log: (l) => lines.push(l),
  });
  const ranges = s.cdnRanges();
  const resumed = ranges.slice(1).some((x) => /^bytes=[1-9]\d*-$/.test(String(x)));
  const same = sha(fs.readFileSync(r.file)) === BODY_SHA;
  return { ok: ranges[0] === null && resumed && same, detail: `cdn が受けた Range ${JSON.stringify(ranges)}、SHA-256 ${same ? '一致' : '不一致'}` };
}

async function checkGzip(c) {
  const s = await c.serve({ body: TEXT, script: [{ gzip: true }, { gzip: true }] });
  const zipped = zlib.gzipSync(TEXT).length;            // range-server と同じ圧縮なので、同じ長さ
  // 参考: identity を頼んだのに gzip が来たとき（結果の OK／NG には数えない）
  let identity;
  try {
    const r0 = await exchange(c.request, s.originUrl, { headers: { 'Accept-Encoding': 'identity' } });
    identity = `${r0.status}・本体 ${r0.body.length} バイト`;
  } catch (e) { identity = `断られた ${(e && e.message) || e}`; }
  // Accept-Encoding を付けない要求（fetchFile が断られた後に出す形）
  const r = await exchange(c.request, s.originUrl);
  const enc = one(headerOf(r.headers, 'content-encoding'));
  const len = one(headerOf(r.headers, 'content-length'));
  const asked = s.requests().filter((x) => x.name === 'cdn').map((x) => x.enc).pop();
  const plainOk = r.status === 200 && r.body.equals(TEXT) && enc === 'gzip' && String(len) === String(zipped);
  // 本番の fetchFile で、いつも圧縮する cdn から最後まで取る
  // maxFails（既定 6）より多く圧縮する（断られたまま identity を頼み続けると、最後に圧縮しない応答で通ってしまわないように）
  const f = await c.serve({ body: BODY, script: Array.from({ length: 12 }, () => ({ gzip: true })) });
  const dir = c.tmp();
  const got = await fetchFile({ url: f.originUrl, size: BODY.length, sha256: BODY_SHA }, {
    dir: path.join(dir, '.download'), dest: path.join(dir, 'models', 'z.bin'), request: c.request,
    requireHttps: false, headerTimeoutMs: 10000, stallMs: 10000, sleep: (ms) => wait(Math.min(ms, 50)),
  });
  const same = sha(fs.readFileSync(got.file)) === BODY_SHA;
  const cdn = f.requests().filter((x) => x.name === 'cdn');
  const ok = plainOk && same;
  return { ok, detail: `付けない要求: ${r.status}・本体 ${r.body.length} バイト（元 ${TEXT.length}）・頼んだ Accept-Encoding ${JSON.stringify(asked)}・`
    + `content-encoding ${JSON.stringify(enc)}・content-length ${JSON.stringify(len)}（圧縮した長さ ${zipped}）／fetchFile: SHA-256 ${same ? '一致' : '不一致'}・`
    + `cdn への要求 ${cdn.length} 回（Accept-Encoding ${JSON.stringify(cdn.map((x) => x.enc))}・Range ${JSON.stringify(cdn.map((x) => x.range))}）／参考: identity を頼んだ要求は ${identity}` };
}

const CHECKS = [
  [1, "転送を手で追う（redirect: 'manual' で 'redirect'、見出しの値は配列、followRedirect() で続く）", checkRedirect],
  [2, '相対の 307 の Location が、絶対の URL で渡される', checkRelative],
  [3, "setHeader('Range') が転送の先（cdn）まで届き、206 が返る", checkRange],
  [4, "abort() で 'abort' が出て、'error' は出ない", checkAbort],
  [5, "cache: 'no-store' で、同じ URL の 2 回目もサーバーに届く", checkNoStore],
  [6, 'Accept-Encoding: identity がサーバーに届く', checkIdentity],
  [7, '本番の fetchFile で、途中で切れる cdn から続きを取り、SHA-256 が合う', checkFetchFile],
  [8, '圧縮するプロキシ: Accept-Encoding を付けない要求は伸ばして届き、見出しは元のまま。本番の fetchFile も最後まで取る', checkGzip],
];

/**
 * 8 つの確かめを順に回す → [{ n, ok, line }]。1 つずつ log(line) に 'OK n …' か 'NG n …' を出す。
 *  request  net.request と同じ形の口（本番は (o) => net.request(o)、テストは fake-net）
 *  checkMs  1 つの確かめの時間の上限（超えたら NG にして次へ。立てたサーバーと要求は片付ける）
 */
async function runChecks({ request, log = (l) => console.log(l), checkMs = 12000 } = {}) {
  if (typeof request !== 'function') throw new TypeError('runChecks: request が要る');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-取込𠮷-'));
  const out = [];
  try {
    for (const [n, title, fn] of CHECKS) {
      const reqs = [];
      const c = {
        request: (o) => { const r = request(o); reqs.push(r); return r; },
        closers: [],
        serve: async (o) => { const s = await startServers(o); c.closers.push(() => s.close()); return s; },
        tmp: () => fs.mkdtempSync(path.join(root, `${n}-`)),
      };
      let timer = null;
      let res;
      try {
        const p = Promise.resolve().then(() => fn(c));
        p.catch(() => {});                                // 時間切れの後に失敗しても、拾われない失敗にしない
        res = await Promise.race([
          p,
          new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, detail: `${checkMs / 1000} 秒で終わらない` }), checkMs); }),
        ]);
      } catch (e) {
        res = { ok: false, detail: `例外: ${(e && (e.code || e.message)) || e}${e && e.code && e.message ? `（${e.message}）` : ''}` };
      } finally {
        clearTimeout(timer);
        for (const r of reqs) { try { r.abort(); } catch (_) { /* 終わっている */ } }
        for (const close of c.closers) { try { await close(); } catch (_) { /* 閉じている */ } }
      }
      const line = `${res.ok ? 'OK' : 'NG'} ${n} ${title}${res.detail ? ` — ${res.detail}` : ''}`;
      log(line);
      out.push({ n, ok: Boolean(res.ok), line });
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* 残ってもよい */ }
  }
  return out;
}

/**
 * 終了コード: 8 つとも OK のときだけ 0。NG がある・数が足りない（途中で止まった）ときは 1。
 * electron-net のジョブを赤にするのはこの値だけなので、テスト（test/ci.test.js）で押さえる。
 */
function exitCodeOf(results) {
  return Array.isArray(results) && results.length === CHECKS.length && results.every((r) => Boolean(r && r.ok)) ? 0 : 1;
}

/** 結果の行を出し、出力を流し切ってから、exitCodeOf の値で Electron を終える */
function finish(app, results, { log = (l) => console.log(l), flush = (cb) => process.stdout.write('', cb) } = {}) {
  const code = exitCodeOf(results);
  const list = Array.isArray(results) ? results : [];
  const bad = Math.max(1, CHECKS.length - list.filter((r) => r && r.ok).length);
  log(code === 0 ? `結果: ${list.length} 件とも OK` : `結果: NG ${bad} 件（計画の Task 9 の「NG のとき」に従って直す）`);
  flush(() => { if (code === 0) app.exit(0); else app.exit(1); });
}

// ---------------------------------------------------------------- Electron の main として動いたとき

function boot() {
  const { app, net } = require('electron');
  // 見張り: どこかで止まっても、ジョブの 15 分を待たずに赤にする
  setTimeout(() => { console.log('NG 時間切れ'); app.exit(1); }, 120000);
  // 拾われない例外で Electron の窓（エラーの箱）を出すと、そこで止まる。行に出して終わる
  const die = (what) => (e) => { console.log(`NG ${what}: ${(e && e.stack) || e}`); app.exit(1); };
  process.on('uncaughtException', die('拾われない例外'));
  process.on('unhandledRejection', die('拾われない失敗'));
  // キャッシュと記録は一時フォルダに（日本語と 𠮷 の名前。利用者のプロファイルを汚さない）
  try {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-net-取込𠮷-'));
    app.setPath('userData', data);
    app.setPath('sessionData', data);
  } catch (e) { console.log(`参考: userData を一時フォルダにできなかった（${e.message}）`); }
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    console.log(`Electron ${process.versions.electron}（Chromium ${process.versions.chrome}、Node ${process.versions.node}、${process.platform}）`);
    finish(app, await runChecks({ request: (o) => net.request(o) }));
  }, die('起動の失敗'));
}

if (process.versions.electron && process.type === 'browser') boot();
else if (require.main === module) {
  console.error('net-smoke.js は Electron の main として動かす: <electron の実行ファイル> tools/net-smoke.js');
  process.exitCode = 2;
}

module.exports = { runChecks, CHECKS, exitCodeOf, finish };
