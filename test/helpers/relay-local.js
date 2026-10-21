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
//                  'delay-stt' は文字起こしの要求を 800 ミリ秒止めてから中継へ渡す（送っている間に別のことをする場面）。
//                  第1d回 A-5 で足した: 'lag-stt' は文字起こしの要求を 300 ミリ秒止めてから中継へ渡す（待ちが積もる背圧の場面を 5 秒の内に）
//   rl.setAnswer(ch) → Promise … 第1d回 A-5: 並びの1文字ごとの答え方（mainrun の --relay-seq。区間ごとに替える）。どの文字も先に前の答え方を戻す
//                  （中継の前は ''・口は開く・DAILY_USER_SEC は始めの値・偽の OpenAI は text）。
//                  'c' 文字・'n' 中継の口を閉じる（つないだらすぐ切る。/health も届かない）・'5' 中継が 502 upstream（偽の OpenAI が 500）・
//                  'l' ログイン切れ（偽の Access で出した cookie を全部取り消す。戻さない）・'u' 429 daily-cap の user（DAILY_USER_SEC を 1）・
//                  'a' 503 quota（偽の OpenAI が insufficient_quota）・'e' 200 で空の文字・'L' 429 busy の長い待ち（偽の OpenAI が retry-after 3600。
//                  アプリは rate-long）。知らない文字は投げる。
//                  第1d回 A-11: 'l' は偽の Access で出した cookie を取り消す（rl.revokeAt と同じ。W-6 で中継の札の表を消したので、
//                  札の取り消しは外した）。'd' は出した cookie の人を止めたメールにする（中継は 403 denied。戻さない）。
//                  第1d2回 M-2: 'b' は中継が音声を見て断った答え（文字起こしの口にだけ 415 not-wav。アプリは bad-request。setFront('not-wav') と同じ）。
//                  第1d2回 M-3: 'z' は次の文字起こしの要求に今どおり答えてから口を閉じる（'n' と同じ。会議の後の待ち行列が送れないまま残る形）
//                  0.9.1 Q-2: 'p' は偽の OpenAI が認識ヒントを繰り返す（parrot）、'A'・'B' はいつも同じ作り話の文（fixA・fixB）
//   rl.setReqText(seq) … 第1d2回 M-3: 中継が偽の OpenAI へ渡した文字起こしの要求の i 番目の答えを seq の i 文字目にする（c は文字・e は空。
//                  足りなければ c）。setAnswer の口の開け閉めはそのまま（並べ直した区間の答えだけを空にする場面）
//   第1d回 A-10（RL9・F19）: startRelayLocal({ access: true }) で、中継の前に偽の Cloudflare Access の前を置く（既定は置かない。
//                  今の札（nt1_）の場面と mainrun はそのまま。A-11 で main が cookie で送るようになったら mainrun が access: true にする）。
//                  偽の Access（test/helpers/fake-access.js）を起こし、中継の env に TEAM_DOMAIN・POLICY_AUD・ACCESS_CERTS_BASE を足す
//                  （env の引数はその後に重ねるので、POLICY_AUD を別の値にして F28 の場面を作れる）。前の動き:
//                    - 要求の Cookie の CF_Authorization が rl.cookieFor で出したもので、切れていず（中継の時計）、rl.revokeAt で取り消していなければ、
//                      客の付けた Cf-Access-Jwt-Assertion を捨ててその JWT を付け、Cookie から CF_Binding を落として中継へ渡す
//                      （Cloudflare の資料のとおり）。'cookie-only' の間は見出しを付けずに Cookie だけを渡す（Worker 単位の Access が
//                      見出しを付けない場合の形）
//                    - 無い・知らない・切れた・取り消した: X-Requested-With: XMLHttpRequest があれば cf-ray つきの HTML の 401、
//                      無ければ 302 で https://natsu-test.cloudflareaccess.com/cdn-cgi/access/login/… へ
//                    - （A-10〜W-5 の移り目にあった「Cookie が無く Authorization: Bearer がある要求は中継へ渡す」道は、W-6 で中継の札の道と
//                      いっしょに消した。札だけの要求も、Cookie の無い要求と同じく前で 401／302）
//                  setFront に足した答え方（access でなくても効く。どの道にも効く）: 'access401'（cf-ray つきの HTML の 401）・
//                  'access403'（cf-ray つきの HTML の 403）・'access302'（Access のログインの画面への 302）・
//                  'redirect-other'（ほかのホストへの 302。会社の通信の検査の転送）・'cookie-only'（上）
//   rl.cookieFor(email, { ttlSec = 3600 }) → Promise<cookie> … 偽の Access がその人に出す CF_Authorization（中継の時計で iat・exp を付けた
//                  本物の形の JWT）を、session.cookies.set にそのまま渡せる形 { url: RELAY_BASE, name, value, secure, httpOnly, sameSite, expirationDate } で返す
//   rl.revokeAt(email) … その人に今までに出した cookie を、偽の Access の前で断る（Zero Trust の Revoke と同じ）
//   第1d回 A-11: 偽の Access の前は /cdn-cgi/access/logout を自分で答える（cookie の人を取り消して 200 の HTML。中継へは渡さない）。
//                  'delay-stt'・'lag-stt' の止めは偽の Access の前より先（取り消した cookie の 401 も遅れて届く）
//   rl.received  … 中継の口（偽の Access の前）が受けた要求の全部 [{ method, path, headers（小文字のキー）, relayed }]（線の上の Cookie を見る）
//   rl.access    … 偽の Access（fa。access: true のときだけ）
//   rl.stt       … 偽の OpenAI（requests・setMode）。（第1d回 W-6 で偽の Resend・rl.resend・rl.codeFor を外した。確認コードのメールが無い）
//   rl.db・rl.env・rl.logs（中継の記録の行）・rl.clock
//   rl.close()   … 中継・偽物を閉じ、ctx.waitUntil の約束を待ち、D1 を閉じる。globalThis.fetch と console.log を戻す
// 中継の外への fetch（偽の OpenAI・偽の Access の鍵の口）は、開いている間 globalThis.fetch を「127.0.0.1 のほかは断る」で包む。
// 中継の記録（console.log）は、開いている間 rl.logs に取り込む（いくつ開いても、閉じた最後の1つで元に戻す）。

const http = require('node:http');
const crypto = require('node:crypto');
const R = require('./relay-run');
const { makeFakeD1 } = require('./fake-d1');
const { makeFakeRequest } = require('./fake-net');
const { startFakeStt } = require('./fake-stt');
const { startFakeAccess } = require('./fake-access');
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

// node の要求 → Web の Request（本文は全部読んでから渡す）。over: { set: { 名前: 値 }, drop: [小文字の名前], cookie: 文字 | undefined }
function toRequest(req, body, over = {}) {
  const h = new Headers();
  const drop = new Set(over.drop || []);
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i];
    if (/^(host|connection|content-length|transfer-encoding)$/i.test(k) || drop.has(k.toLowerCase())) continue;
    if (over.cookie !== undefined && k.toLowerCase() === 'cookie') continue;
    h.append(k, req.rawHeaders[i + 1]);
  }
  if (over.cookie) h.set('cookie', over.cookie);
  for (const [k, v] of Object.entries(over.set || {})) h.set(k, v);
  const init = { method: req.method, headers: h };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
  return new Request('https://relay.test' + req.url, init);
}

const cookiePairs = (header) => String(header || '').split(';').map((x) => x.trim()).filter(Boolean)
  .map((x) => { const at = x.indexOf('='); return at < 0 ? [x, ''] : [x.slice(0, at), x.slice(at + 1)]; });

const cfRay = () => crypto.randomBytes(8).toString('hex') + '-NRT';

// 書き換えと記録をする偽の net.request
function recordingRequest(base, sent) {
  const inner = makeFakeRequest({ rewrite: (u) => (String(u).startsWith(RELAY_BASE) ? base + String(u).slice(RELAY_BASE.length) : u) });
  return function request(opts) {
    const rec = { method: String(opts.method || 'GET').toUpperCase(), url: String(opts.url), redirect: opts.redirect, headers: {}, chunks: [] };
    if (opts.session !== undefined) rec.session = opts.session;   // 第1d回 A-10: cookie の道（偽の session と useSessionCookies）
    if (opts.useSessionCookies !== undefined) rec.useSessionCookies = opts.useSessionCookies;
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

async function startRelayLocal({ stt: sttOpts = {}, env: over = {}, start = Date.now(), access = false } = {}) {
  const key = 'sk-test-' + crypto.randomBytes(12).toString('hex');
  const stt = await startFakeStt({ key, ...sttOpts });
  const db = makeFakeD1();
  await db.exec((await R.load('schema.mjs')).SCHEMA_SQL);
  const env = {
    DB: db,
    OPENAI_API_KEY: key,
    OPENAI_BASE: stt.base,
    ALLOWED_EMAIL_DOMAINS: 'example.com',
  };
  const fa = access ? await startFakeAccess() : null;
  if (fa) {
    Object.assign(env, { TEAM_DOMAIN: fa.teamDomain, POLICY_AUD: fa.aud, ACCESS_CERTS_BASE: fa.certsBase });
    (await R.load('access.mjs'))._resetCertsCache();   // ポートの使い回しで前の場面の鍵が残らないように（relay-run の withRelay と同じ）
  }
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
  let closed = false;   // 第1d回 A-5: 'n'（口を閉じる）の間は、つないだらすぐ切る
  let closeAfterStt = false;   // 第1d2回 M-3: 'z'（次の文字起こしの答えの後に閉じる）
  let reqText = '';   // 第1d2回 M-3: setReqText の並び
  let sttRelayed = 0;   // 偽の OpenAI へ渡した文字起こしの要求の数
  const baseUserSec = env.DAILY_USER_SEC;
  const issued = new Map();    // 偽の Access が出した CF_Authorization → { email, iat（ミリ秒）, exp（秒） }
  const revoked = new Map();   // email → 取り消した時（ミリ秒）
  const received = [];
  const accessLogin = `${fa ? fa.teamDomain : 'https://natsu-test.cloudflareaccess.com'}/cdn-cgi/access/login/relay.test`;

  const server = http.createServer((req, res) => {
    if (closed) { req.socket.destroy(); return; }   // つないだままの口（keep-alive）で来た要求も切る
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const seen = { method: req.method, path: req.url.split('?')[0], headers: { ...req.headers }, relayed: false };
      received.push(seen);
      if (front === 'drop') { req.socket.destroy(); return; }
      // 第1d回 A-10: Access の前の答え（どの道にも効く）
      const html = (st, extra = {}) => {
        res.writeHead(st, { 'content-type': 'text/html; charset=utf-8', 'cf-ray': cfRay(), ...extra });
        res.end(st === 302 ? '' : (st === 200 ? '<html><body>Logged out</body></html>' : '<html><body>Forbidden</body></html>'));
      };
      if (front === 'access401') { html(401); return; }
      if (front === 'access403') { html(403); return; }
      if (front === 'access302') { html(302, { location: accessLogin }); return; }
      if (front === 'redirect-other') { res.writeHead(302, { location: 'https://proxy.example/blocked?u=1', 'content-type': 'text/html' }); res.end(''); return; }
      // 文字起こしの要求の止め（第1d回 A-11 で偽の Access の前より先に置いた: 取り消した cookie の 401 も遅れて届く。送っている間に
      // ログインし直す・ログアウトする場面のため）
      const isStt = req.method === 'POST' && req.url.split('?')[0] === '/v1/audio/transcriptions';
      if (front === 'delay-stt' && isStt) await new Promise((r) => setTimeout(r, 800));
      if (front === 'lag-stt' && isStt) await new Promise((r) => setTimeout(r, 300));
      let over = {};
      // 偽の Access のログアウト（第1d回 A-11。本物の Access は中継の住所の /cdn-cgi/access/logout を Worker へ渡さずに自分で答え、
      // その人のログインを取り消す）。cookie の人を取り消して 200 の HTML（中継へは渡さない）
      if (fa && seen.path === '/cdn-cgi/access/logout') {
        const jwt0 = (cookiePairs(req.headers.cookie).find(([k]) => k === 'CF_Authorization') || [])[1] || '';
        const e0 = jwt0 ? issued.get(jwt0) : null;
        if (e0) revoked.set(e0.email, clock.now());
        html(200);
        return;
      }
      if (fa) {
        const pairs = cookiePairs(req.headers.cookie);
        const jwt = (pairs.find(([k]) => k === 'CF_Authorization') || [])[1] || '';
        const e = jwt ? issued.get(jwt) : null;
        const ok = Boolean(e) && e.exp > clock.now() / 1000 && !(revoked.has(e.email) && revoked.get(e.email) >= e.iat);
        if (!ok) {
          if (String(req.headers['x-requested-with'] || '') === 'XMLHttpRequest') html(401);
          else html(302, { location: accessLogin });
          return;
        }
        const cookie = pairs.filter(([k]) => k !== 'CF_Binding').map(([k, v]) => `${k}=${v}`).join('; ');
        over = { drop: ['cf-access-jwt-assertion'], cookie, set: front === 'cookie-only' ? {} : { 'Cf-Access-Jwt-Assertion': jwt } };
      }
      seen.relayed = true;
      if (front === 'cut-first' && isStt && !cutDone) { cutDone = true; req.socket.destroy(); return; }
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
        if (isStt && reqText) stt.setMode(reqText[sttRelayed] === 'e' ? 'empty' : 'text');   // 第1d2回 M-3
        if (isStt) sttRelayed += 1;
        const out = await handler.fetch(toRequest(req, Buffer.concat(chunks), over), env, ctx);
        const headers = {};
        out.headers.forEach((v, k) => { headers[k] = v; });
        const body = Buffer.from(await out.arrayBuffer());
        res.writeHead(out.status, headers);
        res.end(body);
        // 第1d2回 M-3: 'z' は答えてから口を閉じる（'n' と同じ）
        if (isStt && closeAfterStt) { closeAfterStt = false; closed = true; setImmediate(() => server.closeAllConnections()); }
      } catch (_) {
        res.writeHead(599); res.end();   // 中継は例外を外に投げない約束。ここへ来たら試しの台の誤り
      }
    });
  });
  server.on('connection', (sock) => { if (closed) sock.destroy(); });
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const sent = [];
  const rl = {
    base, env, db, clock, stt, sent, received, access: fa, logs: [],
    request: recordingRequest(base, sent),
    setFront(mode) { front = mode || ''; },
    setReqText(seq) { reqText = String(seq || ''); },
    async setAnswer(ch) {
      front = ''; closed = false; closeAfterStt = false; stt.setMode('text');
      if (baseUserSec === undefined) delete env.DAILY_USER_SEC; else env.DAILY_USER_SEC = baseUserSec;
      if (ch === 'c') return;
      if (ch === 'n') { closed = true; server.closeAllConnections(); return; }
      if (ch === 'l') {
        for (const e of issued.values()) revoked.set(e.email, clock.now());   // 第1d回 A-11: Access で出した cookie を取り消す（Zero Trust の Revoke）
        return;
      }
      if (ch === 'd') {   // 第1d回 A-11: 出した cookie の人を止めたメールにする（中継は 403 denied）
        for (const e of issued.values()) await db.prepare('INSERT OR IGNORE INTO blocked_emails (email, at) VALUES (?1, ?2)').bind(e.email, 0).run();
        return;
      }
      if (ch === 'u') { env.DAILY_USER_SEC = '1'; return; }
      if (ch === 'b') { front = 'not-wav'; return; }   // 第1d2回 M-2
      if (ch === 'z') { closeAfterStt = true; return; }   // 第1d2回 M-3
      const mode = { 5: '500', a: 'quota', e: 'empty', L: '429-long', p: 'parrot', A: 'fixA', B: 'fixB' }[ch];
      if (!mode) throw new Error(`relay-local: 並びの文字 ${JSON.stringify(ch)} を知らない`);
      stt.setMode(mode);
    },
    async cookieFor(email, { ttlSec = 3600 } = {}) {
      if (!fa) throw new Error('relay-local: cookieFor は access: true のときだけ');
      const iatMs = clock.now();
      const exp = Math.floor(iatMs / 1000) + ttlSec;
      const value = await fa.sign({ email, exp }, { now: iatMs });
      issued.set(value, { email, iat: iatMs, exp });
      return { url: RELAY_BASE, name: 'CF_Authorization', value, secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: exp };
    },
    revokeAt(email) { revoked.set(email, clock.now()); },
    async close() {
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
      await Promise.allSettled(pending);
      unhook(rl);
      await stt.close();
      if (fa) await fa.close();
      db.close();
    },
  };
  hook(rl);
  return rl;
}

module.exports = { startRelayLocal };
