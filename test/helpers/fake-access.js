'use strict';
// 127.0.0.1 の偽の Cloudflare Access（第1d回 W-5）。外へはつながない。中継の ACCESS_CERTS_BASE に certsBase を入れて使う。
//   startFakeAccess() → Promise<fa>
//     crypto.subtle.generateKey で RSA 2048 の組を作り（今の鍵・前の鍵・どこにも出さない鍵 stray）、
//     127.0.0.1 に GET /cdn-cgi/access/certs（{ keys: [JWK], public_cert, public_certs }。Cloudflare の鍵の口と同じ形）を開く。
//   fa.teamDomain … 'https://natsu-test.cloudflareaccess.com'（テストの中だけの名前。本物のチームの名前は書かない）
//   fa.certsBase  … 'http://127.0.0.1:<port>'
//   fa.aud        … 64 字の16進（この偽物の Access の app の AUD のタグ）
//   fa.sign(claims, { kid, alg, key, now }) → Promise<JWT の文字>（RS256）
//     claims の既定: { aud: [fa.aud], iss: fa.teamDomain, type: 'app', iat, exp: iat + 3600, email: mail('test.user'), sub: 'u-<乱数>' }
//     （人のログインの JWT の形。値を undefined にした欄は消す）。iat は now（ミリ秒。既定 Date.now()）の秒
//     kid … 見出しの kid（既定は署名した鍵の kid。stray のときは今の鍵の kid（署名だけが違う JWT）。null なら kid を書かない）
//     alg … 見出しの alg（既定 'RS256'。'none' なら署名を空にする。ほかの値でも署名は RS256 で作る）
//     key … 'current'（既定）・'prev'・'stray'（鍵の口に出していない鍵。署名の違う JWT を作る）
//   fa.service(claims, opts) → サービストークンの JWT（email なし・sub は ''・common_name は '<32 字の16進>.access'）
//   fa.rotate() → Promise（今の鍵を前に回し、新しい鍵を今にする。鍵の口は今と前の2つを出す。鍵の替わり目）
//   fa.kids()   → 鍵の口に出している kid の配列（今・前の順）
//   fa.certHits … 鍵の口を取りに来た回数
//   fa.setCerts(mode) … 鍵の口の答え方: 'ok'（既定）・'500'・'hang'（返事をしない。close() で切る）・'redirect'（302 で 127.0.0.1 のほかの道へ）
//   fa.setDelay(ms) … 鍵の口が答えるまでの間（同時の要求が1本の取りに行きを待つかを見る）
//   fa.close()
// テストのファイルにメールアドレスの形の文字を書かないため、メールは relay-run の mail で作る（test/repo.test.js の守り）。

const http = require('node:http');
const crypto = require('node:crypto');
const { mail } = require('./relay-run');

const ALG = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const b64u = (buf) => Buffer.from(buf).toString('base64url');

async function makeKey() {
  const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const kid = crypto.randomBytes(32).toString('hex');
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: 'RSA', alg: 'RS256', use: 'sig', e: jwk.e, n: jwk.n } };
}

async function startFakeAccess() {
  const keys = { current: null, prev: null, stray: null };
  [keys.current, keys.prev, keys.stray] = await Promise.all([makeKey(), makeKey(), makeKey()]);
  const teamDomain = 'https://natsu-test.cloudflareaccess.com';
  const aud = crypto.randomBytes(32).toString('hex');
  let mode = 'ok';
  let delay = 0;
  let certHits = 0;

  const certsBody = () => JSON.stringify({
    keys: [keys.current.jwk, keys.prev.jwk],
    public_cert: { kid: keys.current.kid, cert: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n' },
    public_certs: [keys.current, keys.prev].map((k) => ({ kid: k.kid, cert: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n' })),
  });

  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method !== 'GET' || p !== '/cdn-cgi/access/certs') { res.writeHead(404); res.end(); return; }
    certHits += 1;
    const answer = () => {
      if (mode === 'hang') return;
      if (mode === '500') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('internal'); return; }
      if (mode === 'redirect') { res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/elsewhere` }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(certsBody());
    };
    if (delay > 0) setTimeout(answer, delay); else answer();
  });

  async function signWith(claims, { kid, alg = 'RS256', key = 'current' } = {}) {
    const k = keys[key];
    if (!k) throw new TypeError('fake-access: 知らない鍵 ' + key);
    const header = { alg, typ: 'JWT' };
    const useKid = kid === undefined ? (key === 'stray' ? keys.current.kid : k.kid) : kid;
    if (useKid !== null) header.kid = useKid;
    const body = {};
    for (const [n, v] of Object.entries(claims)) if (v !== undefined) body[n] = v;
    const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(body));
    if (alg === 'none') return input + '.';
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k.privateKey, new TextEncoder().encode(input));
    return input + '.' + b64u(new Uint8Array(sig));
  }

  const base = (now) => {
    const iat = Math.floor((now === undefined ? Date.now() : now) / 1000);
    return { aud: [aud], iss: teamDomain, type: 'app', iat, exp: iat + 3600 };
  };

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        teamDomain,
        certsBase: `http://127.0.0.1:${port}`,
        aud,
        sign(claims = {}, opts = {}) {
          return signWith({ ...base(opts.now), email: mail('test.user'), sub: 'u-' + crypto.randomBytes(8).toString('hex'), ...claims }, opts);
        },
        service(claims = {}, opts = {}) {
          return signWith({ ...base(opts.now), sub: '', common_name: crypto.randomBytes(16).toString('hex') + '.access', ...claims }, opts);
        },
        async rotate() { keys.prev = keys.current; keys.current = await makeKey(); },
        kids: () => [keys.current.kid, keys.prev.kid],
        get certHits() { return certHits; },
        setCerts(m) { mode = m; },
        setDelay(ms) { delay = ms; },
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
      });
    });
  });
}

module.exports = { startFakeAccess };
