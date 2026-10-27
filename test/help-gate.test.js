/* help-gate.test.js — ヘルプセンター H-9（HF1・RF50・RF42・R3・R4）: 門の Worker（relay/help-gate.mjs）
 *
 * 門を Worker を起こさずに node --test で呼ぶ。偽の Access は test/helpers/fake-access.js（127.0.0.1 の鍵の口と偽の鍵で署名した JWT）、
 * 偽の D1 は test/helpers/fake-d1.js（中継と同じ表の形を流す）、偽の ASSETS はこのファイルの中（読まれた回数を数え、
 * <meta name="natsu-help" content="page"> と記事の文字「テスト用の記事の本文」を返す。答えの見出しは書き換えられない: Workers の
 * ASSETS の答えと同じ）。withRelay の call は worker.mjs に決め打ちなので使わない。
 * 外へはつながない（globalThis.fetch は 127.0.0.1 のほかを断る形に替える）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('./helpers/relay-run');
const { startFakeAccess } = require('./helpers/fake-access');
const { makeFakeD1 } = require('./helpers/fake-d1');

const ARTICLE = 'テスト用の記事の本文';
const PAGE_MARK = '<meta name="natsu-help" content="page">';
const GATE_MARK = '<meta name="natsu-help" content="gate">';
const BLOCKED_SQL = 'SELECT 1 AS b FROM blocked_emails WHERE email = ?1';
const HELP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const GATE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";
const NO_STORE = 'private, no-store';
const KEEP = 'private, max-age=3600';
const LOG_KEYS = new Set(['ev', 'st', 'r', 'ms', 'sec', 'n', 'left', 'scope', 'v']);
const TEXT = {
  503: 'NaTsu ヘルプセンターは準備中です。少し待ってから開き直してください。',
  401: 'ログインが必要です。このページを開き直すと、ログインの画面が出ます。',
  403: 'このアカウントではヘルプセンターを開けません。会社のメールアドレスでログインし直すか、管理者に知らせてください。',
};
const LOGOUT_NOTE = 'ログアウトすると、NaTsu アプリの文字起こしのログインも、ほかの PC を含めて切れます。';

const html = (title) => `<!doctype html><html lang="ja"><head><meta charset="utf-8">${PAGE_MARK}<title>${title}</title></head><body><p>${ARTICLE}</p></body></html>`;
const HTML = 'text/html; charset=utf-8';
// 偽の ASSETS の道（ほかの道は 404 の資産のページ）
const ROUTES = {
  '/': { status: 200, type: HTML, body: html('ホーム') },
  '/start/login/': { status: 200, type: HTML, body: html('ログイン') },
  '/404.html': { status: 200, type: HTML, body: html('404') },
  '/search-index.json': { status: 200, type: 'application/json', body: JSON.stringify({ v: 1, items: [{ u: '/start/login/', t: 'ログイン', x: ARTICLE }] }) },
  '/assets/help.css': { status: 200, type: 'text/css', body: `body{color:#000}/* ${ARTICLE} */` },
  '/assets/search.js': { status: 200, type: 'text/javascript', body: `// ${ARTICLE}` },
  // 0.10.0 LN-5（D78・決めたこと 156）: /open のページと open.js も同じ門の後ろ
  '/open/': { status: 200, type: HTML, body: html('NaTsu で開く') },
  '/assets/open.js': { status: 200, type: 'text/javascript', body: `// ${ARTICLE}` },
  '/assets/icons/start.svg': { status: 200, type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
  '/assets/fonts/ibm-plex-sans-jp-400-000.woff2': { status: 200, type: 'font/woff2', body: 'wOF2' },
  '/assets/old.css': { status: 304, type: 'text/css', body: null },
  '/assets/%68elp.css': { status: 200, type: 'text/css', body: `body{}/* ${ARTICLE} */` },
  '/start': { status: 307, type: HTML, body: null, location: '/start/' },
  '/away-host': { status: 307, type: HTML, body: null, location: 'https://evil.example/' },
  '/away-slashes': { status: 307, type: HTML, body: null, location: '//evil.example/' },
  '/away-backslash': { status: 307, type: HTML, body: null, location: '/\\evil.example/' },
};

// 答えの見出しを書き換えられなくする（Workers の ASSETS の答えと同じ。門は写してから見出しを付ける）
function lock(headers) {
  for (const k of ['set', 'append', 'delete']) headers[k] = () => { throw new TypeError('immutable'); };
  return headers;
}

function fakeAssets() {
  const a = { hits: 0, paths: [] };
  a.fetch = async (req) => {
    a.hits += 1;
    const p = new URL(req.url).pathname;
    a.paths.push(p);
    const d = ROUTES[p] || { status: 404, type: HTML, body: html('見つかりません') };
    const h = { 'content-type': d.type, 'cache-control': 'public, max-age=0, must-revalidate', etag: '"e1"' };
    if (d.location) h.location = d.location;
    const res = new Response(req.method === 'HEAD' || d.body === null ? null : d.body, { status: d.status, headers: h });
    lock(res.headers);
    return res;
  };
  return a;
}

// 門の場面: 偽の Access・偽の D1（表の形あり）・偽の ASSETS をそろえ、env を合わせる（over の undefined の欄は消す）
async function scene({ env: over = {} } = {}, fn) {
  const fa = await startFakeAccess();
  const db = makeFakeD1();
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const logs = [];
  try {
    await db.exec((await R.load('schema.mjs')).SCHEMA_SQL);
    (await R.load('access.mjs'))._resetCertsCache();
    const assets = fakeAssets();
    const env = { DB: db, ASSETS: assets, TEAM_DOMAIN: fa.teamDomain, POLICY_AUD: fa.aud, ACCESS_CERTS_BASE: fa.certsBase, ALLOWED_EMAIL_DOMAINS: 'example.com' };
    for (const [k, v] of Object.entries(over)) { if (v === undefined) delete env[k]; else env[k] = v; }
    const gate = (await R.load('help-gate.mjs')).default;
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    console.log = (...a) => { logs.push(a.map(String).join(' ')); };
    globalThis.fetch = R.loopbackOnlyFetch(realFetch);
    async function call(method, p, { jwt, cookie, headers = {} } = {}) {
      const h = new Headers(headers);
      if (jwt !== undefined) h.set('cf-access-jwt-assertion', jwt);
      if (cookie !== undefined) h.set('cookie', 'CF_Authorization=' + cookie);
      const res = await gate.fetch(new Request('https://help.test' + p, { method, headers: h }), env, ctx);
      const text = await res.text();
      return { status: res.status, headers: res.headers, text };
    }
    await fn({ call, fa, db, assets, env, logs, sign: (c, o) => fa.sign(c, o) });
    for (const l of logs) for (const k of Object.keys(JSON.parse(l))) assert.ok(LOG_KEYS.has(k), `記録に決まりの外の欄 ${k}`);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    db.close();
    await fa.close();
  }
}

// 門のページ（記事の文字なし・資産を読まない・決まった見出し）
function assertGate(r, st, label) {
  assert.strictEqual(r.status, st, `${label}: ${r.status} ${r.text.slice(0, 80)}`);
  assert.ok(!r.text.includes(ARTICLE), `${label}: 記事の文字が出た`);
  assert.ok(!r.text.includes(PAGE_MARK), `${label}: page の印が出た`);
  assert.strictEqual(r.headers.get('cache-control'), NO_STORE, label);
  for (const h of ['location', 'set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-headers', 'access-control-allow-methods']) {
    assert.strictEqual(r.headers.get(h), null, `${label}: ${h}`);
  }
  if (st !== 405) {
    assert.strictEqual(r.headers.get('content-security-policy'), GATE_CSP, label);
    assert.strictEqual(r.headers.get('content-type'), HTML, label);
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff', label);
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer', label);
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex', label);
  }
}

test('HF1: 正しい人の JWT（会社のドメイン）なら ASSETS の答えを返し、CSP・nosniff・no-referrer・noindex・Cache-Control: private を付ける（HTML と JSON は no-store、/assets/ は max-age=3600）', { timeout: 5000 }, async () => {
  await scene({}, async ({ call, sign, assets }) => {
    const jwt = await sign();
    for (const [p, cc, type] of [['/', NO_STORE, HTML], ['/start/login/', NO_STORE, HTML], ['/search-index.json', NO_STORE, 'application/json'], ['/assets/help.css', KEEP, 'text/css']]) {
      const r = await call('GET', p, { jwt });
      assert.strictEqual(r.status, 200, `${p}: ${r.text.slice(0, 80)}`);
      assert.ok(r.text.includes(ARTICLE), p);
      assert.strictEqual(r.headers.get('content-type'), type, p);
      assert.strictEqual(r.headers.get('content-security-policy'), HELP_CSP, p);
      assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff', p);
      assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer', p);
      assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex', p);
      assert.strictEqual(r.headers.get('cache-control'), cc, p);
      assert.strictEqual(r.headers.get('etag'), '"e1"', `${p}: 資産の見出しを残す`);
    }
    assert.ok((await call('GET', '/', { jwt })).text.includes(PAGE_MARK));
    // cookie の CF_Authorization でも同じ
    const c = await call('GET', '/', { cookie: jwt });
    assert.strictEqual(c.status, 200);
    assert.ok(c.text.includes(ARTICLE));
    assert.deepStrictEqual(assets.paths, ['/', '/start/login/', '/search-index.json', '/assets/help.css', '/', '/']);
  });
});

test('HF1・RF42: JWT が無い・署名が違う・alg が none・切れた・ほかの app の aud・ほかの iss・サービストークン・会社のドメインでない・+ の別名・止めたメール → 401／403／503 で、ASSETS を1回も読まず、本文に記事の文字も page の印も無い', { timeout: 5000 }, async () => {
  await scene({}, async ({ call, sign, fa, db, assets }) => {
    const t = Math.floor(Date.now() / 1000);
    const blocked = R.mail('blocked.user');
    await db.prepare('INSERT INTO blocked_emails (email, at) VALUES (?1, ?2)').bind(blocked, t).run();
    const cases = [
      ['JWT なし', undefined, 401],
      ['署名が違う', await sign({}, { key: 'stray' }), 401],
      ['alg が none', await sign({}, { alg: 'none' }), 401],
      ['切れた', await sign({ exp: t - 1 }), 401],
      ['ほかの app の aud', await sign({ aud: ['ab'.repeat(32)] }), 503],
      ['ほかの iss', await sign({ iss: 'https://other-team.cloudflareaccess.com' }), 503],
      ['サービストークン', await fa.service(), 403],
      ['会社のドメインでない', await sign({ email: R.mail('test.user', 'evil.example') }), 403],
      ['+ の別名', await sign({ email: R.mail('test.user+x') }), 403],
      ['止めたメール', await sign({ email: blocked }), 403],
    ];
    for (const [label, jwt, st] of cases) {
      for (const p of ['/', '/search-index.json']) {
        const r = await call('GET', p, { jwt });
        assertGate(r, st, `${label} ${p}`);
        assert.ok(r.text.includes(GATE_MARK), label);
        assert.ok(r.text.includes(TEXT[st]), `${label}: 門の文 ${r.text}`);
      }
      if (jwt) assertGate(await call('GET', '/', { cookie: jwt }), st, `${label}（cookie）`);
    }
    assert.strictEqual(assets.hits, 0, `ASSETS を ${assets.hits} 回読んだ: ${assets.paths.join(' ')}`);
  });
});

test('HF1: TEAM_DOMAIN・POLICY_AUD・ALLOWED_EMAIL_DOMAINS のどれかが無い（1回目の出し方の後）→ どの道も、JWT が無くても正しくても 503 の「準備中」で、ASSETS を読まない', { timeout: 5000 }, async () => {
  for (const name of ['TEAM_DOMAIN', 'POLICY_AUD', 'ALLOWED_EMAIL_DOMAINS']) {
    for (const bad of [undefined, 'not valid']) {
      await scene({ env: { [name]: bad } }, async ({ call, sign, assets }) => {
        const jwt = await sign();
        for (const p of ['/', '/search-index.json', '/assets/help.css', '/nope/']) {
          for (const j of [undefined, jwt]) {
            const r = await call('GET', p, { jwt: j });
            assertGate(r, 503, `${name}=${bad} ${p} ${j ? 'JWT あり' : 'JWT なし'}`);
            assert.ok(r.text.includes(TEXT[503]), r.text);
          }
        }
        assert.strictEqual(assets.hits, 0, `${name}: ASSETS を読んだ`);
      });
    }
  }
  // ASSETS が無くても投げずに 503（中身を返す道が無い）
  await scene({ env: { ASSETS: undefined } }, async ({ call, sign }) => {
    assertGate(await call('GET', '/', { jwt: await sign() }), 503, 'ASSETS なし');
  });
});

test('HF1: D1 が無い・投げる → 503（止めたかを確かめずに通さない）', { timeout: 5000 }, async () => {
  const throwing = { prepare() { throw new Error('D1 down'); } };
  const failing = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 down'); } }) }) };
  for (const [label, DB] of [['D1 なし', undefined], ['prepare が投げる', throwing], ['first が投げる', failing], ['D1 が null', null]]) {
    await scene({ env: { DB } }, async ({ call, sign, assets }) => {
      const r = await call('GET', '/', { jwt: await sign() });
      assertGate(r, 503, label);
      assert.ok(!r.text.includes('D1 down'), label);
      assert.strictEqual(assets.hits, 0, label);
    });
  }
});

test('R4: 門が D1 に出すのは止めたメールの SELECT の1文だけ。readOnlyDb は ほかの文（INSERT・DELETE・UPDATE・DROP・別の SELECT）・batch・exec を投げ、偽の D1 に1回も届かない', { timeout: 5000 }, async () => {
  // 門の文は access.mjs の requireAccess の文とちょうど同じ（access.mjs が文を変えれば、門は全員を 503 にする: 上の正しい JWT のテストが赤）
  assert.ok(fs.readFileSync(path.join(R.RELAY_DIR, 'access.mjs'), 'utf8').includes(`'${BLOCKED_SQL}'`), 'access.mjs の止めたメールの文が変わった');
  await scene({}, async ({ call, sign, db }) => {
    db.ran.length = 0;
    assert.strictEqual((await call('GET', '/', { jwt: await sign() })).status, 200);
    assert.strictEqual((await call('GET', '/assets/help.css', { jwt: await sign() })).status, 200);
    assert.deepStrictEqual(db.ran, [BLOCKED_SQL, BLOCKED_SQL]);
  });
  const { readOnlyDb } = await R.load('help-gate.mjs');
  const db = makeFakeD1();
  try {
    await db.exec((await R.load('schema.mjs')).SCHEMA_SQL);
    const ro = readOnlyDb(db);
    assert.deepStrictEqual(Object.keys(ro), ['prepare'], 'prepare のほかの口がある');
    const bad = [
      "INSERT INTO blocked_emails (email, at) VALUES ('x', 1)",
      'DELETE FROM blocked_emails',
      "UPDATE counters SET n = 0 WHERE key = 'a:all'",
      'DROP TABLE blocked_emails',
      "SELECT value FROM meta WHERE key = 'schema'",
      'SELECT * FROM counters',
      BLOCKED_SQL + ' ',
      ' ' + BLOCKED_SQL,
      BLOCKED_SQL + '; DELETE FROM blocked_emails',
      BLOCKED_SQL.toLowerCase(),
      '',
    ];
    for (const sql of bad) assert.throws(() => ro.prepare(sql), `通した: ${sql}`);
    assert.throws(() => ro.prepare({ toString: () => BLOCKED_SQL }), '文字でない sql を通した');
    for (const m of ['batch', 'exec', 'dump', 'withSession']) assert.throws(() => ro[m]('DELETE FROM blocked_emails'), m);
    assert.deepStrictEqual(db.ran, [], '偽の D1 に届いた');
    // 決まった文だけは本物へ渡り、読める
    assert.strictEqual(await ro.prepare(BLOCKED_SQL).bind(R.mail('a')).first('b'), null);
    assert.deepStrictEqual(db.ran, [BLOCKED_SQL]);
    assert.throws(() => readOnlyDb(undefined).prepare(BLOCKED_SQL), 'D1 が無いのに投げない');
  } finally { db.close(); }
  // 門は env.DB をそのまま渡さない（requireAccess に渡す env は readOnlyDb で包んだ DB だけ）
  const src = fs.readFileSync(path.join(R.RELAY_DIR, 'help-gate.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(src, /requireAccess\(\s*request\s*,\s*\{\s*DB:\s*readOnlyDb\(\s*env\.DB\s*\)\s*\}\s*,/, 'requireAccess に { DB: readOnlyDb(env.DB) } を渡していない');
  assert.strictEqual((src.match(/\benv\.DB\b/g) || []).length, 1, 'env.DB をほかでも使う');
});

test('HF1: /search-index.json・/assets/help.css・/404.html・/%2e%2e/search-index.json・//search-index.json・/assets/%2e%2e/search-index.json・/cdn-cgi/x も同じ門を通る（道で分けない。ログインしていなければどれも ASSETS を読まない）', { timeout: 5000 }, async () => {
  await scene({}, async ({ call, assets }) => {
    for (const p of ['/', '/search-index.json', '/assets/help.css', '/404.html', '/%2e%2e/search-index.json', '//search-index.json',
      '/assets/%2e%2e/search-index.json', '/cdn-cgi/x', '/cdn-cgi/access/logout', '/assets/icons/start.svg', '/start/login/', '/start/login/index.html']) {
      for (const method of ['GET', 'HEAD']) {
        const r = await call(method, p);
        assertGate(r, 401, `${method} ${p}`);
        if (method === 'HEAD') assert.strictEqual(r.text, '', `HEAD ${p} に本文`);
      }
    }
    assert.strictEqual(assets.hits, 0, assets.paths.join(' '));
  });
});

test('HF1: Cache-Control: /assets/help.css の 200 だけ private, max-age=3600。HTML・search-index.json・ASSETS の 404・304・307・% や .. を含む /assets/ の道・門のページは private, no-store。ASSETS が public, max-age=0 を付けて返しても上書きされ、Cache-Control の行は1つだけ', { timeout: 5000 }, async () => {
  await scene({}, async ({ call, sign }) => {
    const jwt = await sign();
    const want = [
      ['/assets/help.css', 200, KEEP],
      ['/assets/search.js', 200, KEEP],
      ['/assets/icons/start.svg', 200, KEEP],
      ['/assets/fonts/ibm-plex-sans-jp-400-000.woff2', 200, KEEP],
      ['/', 200, NO_STORE],
      ['/start/login/', 200, NO_STORE],
      ['/search-index.json', 200, NO_STORE],
      ['/404.html', 200, NO_STORE],
      ['/nope/', 404, NO_STORE],
      ['/assets/nope.css', 404, NO_STORE],
      ['/assets/old.css', 304, NO_STORE],
      ['/start', 307, NO_STORE],
      ['/assets/%68elp.css', 200, NO_STORE],
    ];
    for (const [p, st, cc] of want) {
      const r = await call('GET', p, { jwt });
      assert.strictEqual(r.status, st, p);
      assert.strictEqual(r.headers.get('cache-control'), cc, p);
    }
    const r = await call('GET', '/', {});
    assert.strictEqual(r.headers.get('cache-control'), NO_STORE, '門のページ');
  });
  // 決まりそのもの（helpHeaders）: 決めかねたら no-store
  const { helpHeaders } = await R.load('help-gate.mjs');
  const cc = (p, st) => new Headers(helpHeaders(p, st)).get('cache-control');
  for (const p of ['/assets/help.css', '/assets/site.js', '/assets/icons/admin.svg', '/assets/fonts/ibm-plex-mono-400.woff2']) assert.strictEqual(cc(p, 200), KEEP, p);
  for (const [p, st] of [['/assets/help.css', 304], ['/assets/help.css', 404], ['/assets/help.css', 307], ['/assets/help.css', 206],
    ['/assets/../help.css', 200], ['/assets/%2e%2e/x.css', 200], ['/assets/Help.css', 200], ['/assets/help.css.map', 200], ['/assets/help.json', 200],
    ['/assets/a/b/help.css', 200], ['/assets/icons/../x.svg', 200], ['/assets/fonts/x.ttf', 200], ['/assets//help.css', 200], ['//assets/help.css', 200],
    ['/x/assets/help.css', 200], ['/search-index.json', 200], ['/', 200], ['/assets/', 200], ['/assets/help.css/', 200], [`/assets/${'a'.repeat(41)}.css`, 200]]) {
    assert.strictEqual(cc(p, st), NO_STORE, `${p} ${st}`);
  }
  const h = new Headers(helpHeaders('/', 200));
  assert.strictEqual(h.get('content-security-policy'), HELP_CSP);
  assert.strictEqual(h.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(h.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(h.get('x-robots-tag'), 'noindex');
});

test('H-9: GET と HEAD のほかは 405（OPTIONS・POST・PUT・DELETE）。門のページと 405 に Location・Access-Control-Allow-*・Set-Cookie が無い。ASSETS の 307 の Location は / で始まる同じサイトの道だけ通し、ほかのホスト・// の Location は 503。HEAD の答えに本文が無い', { timeout: 5000 }, async () => {
  await scene({}, async ({ call, sign, assets }) => {
    const jwt = await sign();
    for (const method of ['OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const j of [undefined, jwt]) {
        const r = await call(method, '/', { jwt: j, headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
        assertGate(r, 405, `${method}`);
        assert.strictEqual(r.text, '', `${method} に本文`);
        assert.strictEqual(r.headers.get('allow'), 'GET, HEAD');
      }
    }
    assert.strictEqual(assets.hits, 0, '405 で ASSETS を読んだ');
    const ok = await call('GET', '/start', { jwt });
    assert.strictEqual(ok.status, 307);
    assert.strictEqual(ok.headers.get('location'), '/start/');
    for (const p of ['/away-host', '/away-slashes', '/away-backslash']) {
      const r = await call('GET', p, { jwt });
      assertGate(r, 503, p);
      assert.ok(!r.text.includes('evil.example'), p);
    }
    const head = await call('HEAD', '/', { jwt });
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.text, '');
    assert.strictEqual(head.headers.get('cache-control'), NO_STORE);
    for (const p of ['/', '/assets/help.css']) {
      const r = await call('GET', p, { jwt, headers: { origin: 'https://evil.example' } });
      for (const h of ['set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials']) assert.strictEqual(r.headers.get(h), null, `${p}: ${h}`);
    }
  });
  // 門のページは HEAD でも本文なし
  await scene({ env: { POLICY_AUD: undefined } }, async ({ call }) => {
    const r = await call('HEAD', '/');
    assertGate(r, 503, 'HEAD 準備中');
    assert.strictEqual(r.text, '');
  });
});

test('H-9: 門のページは <meta name="natsu-help" content="gate"> で、script も /assets/ も外の物も無い（CSP は GATE_CSP）', { timeout: 5000 }, async () => {
  const { gatePage } = await R.load('help-gate.mjs');
  for (const st of [401, 403, 503]) {
    const res = gatePage(st);
    const text = await res.text();
    assert.strictEqual(res.status, st);
    assert.ok(text.startsWith('<!doctype html>'), st);
    assert.ok(text.includes('<html lang="ja">'), st);
    assert.ok(text.includes(GATE_MARK), st);
    assert.ok(text.includes(TEXT[st]), `${st}: ${text}`);
    assert.ok(!/<script|<link|<img|<iframe|<form|\bsrc=|\bon[a-z]+=|\/assets\/|https?:|\/\/[a-z]/i.test(text.replace(/<a href="\/cdn-cgi\/access\/logout">/, '')), `${st}: ${text}`);
    assert.ok(!text.includes(ARTICLE));
    assert.strictEqual(res.headers.get('content-security-policy'), GATE_CSP);
    assert.strictEqual(res.headers.get('cache-control'), NO_STORE);
  }
  const t403 = await gatePage(403).text();
  assert.ok(t403.includes('<a href="/cdn-cgi/access/logout">'), 'ログアウトのリンクが無い');
  assert.ok(t403.includes(LOGOUT_NOTE), 'ログアウトの注意が無い');
  for (const st of [401, 503]) assert.ok(!(await gatePage(st).text()).includes('logout'), st);
  const r405 = gatePage(405);
  assert.strictEqual(r405.status, 405);
  assert.strictEqual(await r405.text(), '');
  // 準備中の理由: 503 のページにだけ、小さな灰色の行で決まった短い符号（小文字・数字・ハイフン）を出す。符号でなければ行ごと出さない
  for (const st of [401, 403, 503]) assert.ok(!(await gatePage(st).text()).includes('理由'), `${st}: 理由を渡していないのに行がある`);
  const why = await gatePage(503, { why: 'cfg-aud' }).text();
  assert.ok(why.includes('<p class="why">（理由: cfg-aud）</p>'), why);
  assert.ok(why.indexOf(TEXT[503]) < why.indexOf('（理由: cfg-aud）'), '理由の行は準備中の文の後');
  assert.match(why, /\.why\{[^}]*color:#[0-9a-f]{6}/, '理由の行の色（灰色）が無い');
  for (const st of [401, 403]) assert.ok(!(await gatePage(st, { why: 'aud' }).text()).includes('理由'), `${st}: 401・403 のページは変えない`);
  for (const bad of ['Cfg-Aud', 'cfg aud', '<b>x</b>', 'a'.repeat(33), '', R.mail('x'), 1, null, { toString: () => 'cfg-aud' }]) {
    assert.ok(!(await gatePage(503, { why: bad }).text()).includes('理由'), `符号でない理由を出した: ${String(bad)}`);
  }
  assert.strictEqual(await gatePage(503, { why: 'cfg-aud', head: true }).text(), '', 'HEAD に本文');
  assert.strictEqual(await gatePage(405, { why: 'method' }).text(), '', '405 に本文');
});

test('H-9: 門の記録にメール・JWT・チームの名前が無い（requireAccess の記録のまま）', { timeout: 5000 }, async () => {
  await scene({}, async ({ call, sign, fa, logs }) => {
    const email = R.mail('Secret.Person');
    const jwt = await sign({ email });
    const other = R.mail('test.user', 'evil.example');
    const bad = await sign({ email: other });
    await call('GET', '/', { jwt });
    await call('GET', '/', { jwt: bad });
    await call('GET', '/', { cookie: jwt });
    await call('GET', '/');
    assert.ok(logs.length >= 2, logs.join('\n'));
    const text = logs.join('\n');
    for (const s of [email, email.toLowerCase(), other, jwt, jwt.split('.')[2], bad, fa.teamDomain, 'natsu-test', fa.aud, ...fa.kids(), 'evil.example']) {
      assert.ok(!text.includes(s), `記録に ${s.slice(0, 16)}…`);
    }
    const evs = logs.map((l) => JSON.parse(l));
    assert.ok(evs.every((e) => e.ev === 'access'), text);
    assert.ok(evs.some((e) => e.r === 'domain') && evs.some((e) => e.r === 'no-jwt'), text);   // 通った記録（r: ok）は isolate で最初の1回だけ
  });
});

// 準備中の理由（門の 503・405 の1行）: 出した後に Workers Logs に何も出ず、どの 503 か分からなかった（記録は requireAccess の
// 失敗だけで、門が自分で返す 503 は何も残さなかった）。門が自分で返す 503・405 は必ず1行 { ev: 'help', st, r } を残し、503 のページにも
// 同じ符号を「（理由: …）」で出す。値（チームの名前・AUD・ドメイン・メール・例外の文）は出さない
const helpLogs = (logs) => logs.map((l) => JSON.parse(l)).filter((e) => e.ev === 'help');

test('HF1（準備中の理由）: 設定の欠けは、欠けた欄を cfg-team・cfg-aud・cfg-domains（重なれば cfg-team-aud のようにつなぐ）で、記録の r と 503 のページの「（理由: …）」に出す。値は出さない', { timeout: 10000 }, async () => {
  const cases = [
    [{ TEAM_DOMAIN: undefined }, 'cfg-team'],
    [{ TEAM_DOMAIN: 'https://natsu-test.cloudflareaccess.com.evil.example' }, 'cfg-team'],
    [{ POLICY_AUD: undefined }, 'cfg-aud'],
    [{ POLICY_AUD: 'AB'.repeat(32) }, 'cfg-aud'],
    [{ POLICY_AUD: 'ab'.repeat(31) }, 'cfg-aud'],
    [{ ALLOWED_EMAIL_DOMAINS: undefined }, 'cfg-domains'],
    [{ ALLOWED_EMAIL_DOMAINS: 'not valid, @x' }, 'cfg-domains'],
    [{ TEAM_DOMAIN: undefined, POLICY_AUD: undefined }, 'cfg-team-aud'],
    [{ TEAM_DOMAIN: undefined, ALLOWED_EMAIL_DOMAINS: '' }, 'cfg-team-domains'],
    [{ POLICY_AUD: 'x', ALLOWED_EMAIL_DOMAINS: undefined }, 'cfg-aud-domains'],
    [{ TEAM_DOMAIN: '', POLICY_AUD: '', ALLOWED_EMAIL_DOMAINS: '' }, 'cfg-team-aud-domains'],
  ];
  for (const [over, code] of cases) {
    await scene({ env: over }, async ({ call, sign, fa, logs, assets }) => {
      const jwt = await sign();
      const label = `${Object.keys(over).join('+')} → ${code}`;
      for (const j of [undefined, jwt]) {
        logs.length = 0;
        const r = await call('GET', '/', { jwt: j });
        assertGate(r, 503, label);
        assert.ok(r.text.includes(TEXT[503]), label);
        assert.ok(r.text.includes(`（理由: ${code}）`), `${label}: ${r.text}`);
        assert.deepStrictEqual(logs.map((l) => JSON.parse(l)), [{ ev: 'help', st: 503, r: code }], label);
        const seen = logs.join('\n') + r.text;
        for (const s of [fa.teamDomain, 'natsu-test', fa.aud, 'example.com', jwt]) assert.ok(!seen.includes(s), `${label}: 値 ${s.slice(0, 16)}… が出た`);
      }
      logs.length = 0;
      const h = await call('HEAD', '/search-index.json');
      assertGate(h, 503, `${label} HEAD`);
      assert.strictEqual(h.text, '');
      assert.deepStrictEqual(helpLogs(logs), [{ ev: 'help', st: 503, r: code }], `${label} HEAD`);
      assert.strictEqual(assets.hits, 0, label);
    });
  }
});

test('H-9（門の理由）: ASSETS が無い → no-assets、ほかのサイトへの転送 → assets-redirect、思わぬ誤り → error（例外の型の名前だけを小文字で v に。文は出さない）、GET・HEAD のほか → 405 で method。requireAccess の 503 はその符号をページに出し、門は記録を重ねない。401・403 のページに理由は無い', { timeout: 10000 }, async () => {
  await scene({ env: { ASSETS: undefined } }, async ({ call, sign, logs }) => {
    const r = await call('GET', '/', { jwt: await sign() });
    assertGate(r, 503, 'ASSETS なし');
    assert.ok(r.text.includes('（理由: no-assets）'), r.text);
    assert.deepStrictEqual(helpLogs(logs), [{ ev: 'help', st: 503, r: 'no-assets' }]);
  });
  await scene({}, async ({ call, sign, logs, env, fa }) => {
    const jwt = await sign();
    // 正しい人の 200 と転送の 307 では門の記録を残さない
    for (const p of ['/', '/start']) await call('GET', p, { jwt });
    assert.deepStrictEqual(helpLogs(logs), [], '通った要求で門の記録が出た');
    for (const p of ['/away-host', '/away-slashes', '/away-backslash']) {
      logs.length = 0;
      const r = await call('GET', p, { jwt });
      assertGate(r, 503, p);
      assert.ok(r.text.includes('（理由: assets-redirect）'), `${p}: ${r.text}`);
      assert.deepStrictEqual(helpLogs(logs), [{ ev: 'help', st: 503, r: 'assets-redirect' }], p);
      assert.ok(!logs.join('\n').includes('evil.example'), p);
    }
    // 405（本文なし）も1行
    for (const method of ['POST', 'OPTIONS']) {
      logs.length = 0;
      const r = await call(method, '/', { jwt });
      assertGate(r, 405, method);
      assert.strictEqual(r.text, '');
      assert.deepStrictEqual(logs.map((l) => JSON.parse(l)), [{ ev: 'help', st: 405, r: 'method' }], method);
    }
    // 思わぬ誤り: 例外の型の名前（英字だけ・32 字まで）だけを小文字で v に。文（メール・ドメイン）は記録にもページにも出ない
    const secret = `${R.mail('Secret.Person')} ${fa.teamDomain}`;
    class Odd1 extends Error {}
    const named = (n) => { const C = class extends Error {}; Object.defineProperty(C, 'name', { value: n }); return new C(secret); };
    for (const [label, thrown, v] of [
      ['TypeError', new TypeError(secret), 'typeerror'],
      ['RangeError', new RangeError(secret), 'rangeerror'],
      ['英字と数字の名前', new Odd1(secret), undefined],
      ['ハイフンの名前', named('Bad-Name'), undefined],
      ['33 字の名前', named('E'.repeat(33)), undefined],
      ['文字を投げる', secret, undefined],
      ['null を投げる', null, undefined],
    ]) {
      env.ASSETS = { fetch: async () => { throw thrown; } };
      logs.length = 0;
      const r = await call('GET', '/', { jwt });
      assertGate(r, 503, label);
      assert.ok(r.text.includes('（理由: error）'), `${label}: ${r.text}`);
      assert.deepStrictEqual(helpLogs(logs), [v ? { ev: 'help', st: 503, r: 'error', v } : { ev: 'help', st: 503, r: 'error' }], label);
      const seen = logs.join('\n') + r.text;
      for (const s of [secret, 'secret.person', 'natsu-test', 'example.com']) assert.ok(!seen.toLowerCase().includes(s.toLowerCase()), `${label}: ${s.slice(0, 16)}… が出た`);
    }
  });
  // requireAccess の 503（ほかの app の aud・D1 が無い）: ページに requireAccess の符号を出す。記録は requireAccess の1行だけ（門は重ねない）
  for (const [label, over, signOpts, code] of [['ほかの app の aud', {}, { aud: ['ab'.repeat(32)] }, 'aud'], ['D1 なし', { DB: undefined }, {}, 'not-ready']]) {
    await scene({ env: over }, async ({ call, sign, logs }) => {
      const r = await call('GET', '/', { jwt: await sign(signOpts) });
      assertGate(r, 503, label);
      assert.ok(r.text.includes(`（理由: ${code}）`), `${label}: ${r.text}`);
      assert.deepStrictEqual(helpLogs(logs), [], label);
      assert.ok(logs.map((l) => JSON.parse(l)).some((e) => e.ev === 'access' && e.st === 503 && e.r === code), logs.join('\n'));
    });
  }
  // 401・403 のページは変えない（理由の行が無い）
  await scene({}, async ({ call, sign, fa, logs }) => {
    for (const [label, r, st] of [['JWT なし', await call('GET', '/'), 401], ['サービストークン', await call('GET', '/', { jwt: await fa.service() }), 403],
      ['会社のドメインでない', await call('GET', '/', { jwt: await sign({ email: R.mail('test.user', 'evil.example') }) }), 403]]) {
      assertGate(r, st, label);
      assert.ok(!r.text.includes('理由'), `${label}: ${r.text}`);
    }
    assert.deepStrictEqual(helpLogs(logs), []);
  });
});

// 準備中の理由の記録（門の 503・405 の1行）で意図して変えた: 門は ./log.mjs の logEvent も読む（access.mjs がもう読んでいるので、上げるファイルの組は変わらない）
test('R3: help-gate.mjs が読むのは ./access.mjs・./config.mjs・./log.mjs だけ（stt・limits・schema・worker を読まない）。console・node:・Buffer が無い', { timeout: 5000 }, () => {
  const src = fs.readFileSync(path.join(R.RELAY_DIR, 'help-gate.mjs'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const mods = [...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] || m[2] || m[3]);
  assert.deepStrictEqual(mods.sort(), ['./access.mjs', './config.mjs', './log.mjs']);
  assert.ok(!/\bconsole\./.test(code), 'console を使う');
  assert.ok(!/node:|\brequire\s*\(/.test(code), 'node: か require を使う');
  assert.ok(!/\bBuffer\b/.test(code), 'Buffer を使う');
  assert.ok(!/\bprocess\./.test(code), 'process を使う');
  assert.match(code, /need:\s*'user'/, "requireAccess の need が 'user' でない");
  assert.ok(!/need:\s*'any'/.test(code), "need: 'any' がある（サービストークンで中身が見える）");
});

test('0.10.0 LN-5（D78・決めたこと 156）: /open/ と /assets/open.js も、正しい人の JWT のときだけ返す（HELP_CSP・no-referrer・noindex。/open/ は no-store）。JWT が無い・切れた・違う AUD・サービストークンには中身を1字も返さず ASSETS を読まない', { timeout: 5000 }, async () => {
  await scene({}, async ({ call, sign, fa, assets }) => {
    const t = Math.floor(Date.now() / 1000);
    for (const [label, jwt, st] of [['JWT なし', undefined, 401], ['切れた', await sign({ exp: t - 1 }), 401], ['違う AUD', await sign({ aud: ['ab'.repeat(32)] }), 503], ['サービストークン', await fa.service(), 403]]) {
      for (const p of ['/open/', '/open/index.html', '/assets/open.js']) assertGate(await call('GET', p, { jwt }), st, `${label} ${p}`);
    }
    assert.strictEqual(assets.hits, 0, assets.paths.join(' '));
    const ok = await sign({});
    const page = await call('GET', '/open/', { jwt: ok });
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes(PAGE_MARK));
    assert.strictEqual(page.headers.get('content-security-policy'), HELP_CSP);
    assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(page.headers.get('x-robots-tag'), 'noindex');
    assert.strictEqual(page.headers.get('cache-control'), NO_STORE);
    const js = await call('GET', '/assets/open.js', { jwt: ok });
    assert.strictEqual(js.status, 200);
    assert.strictEqual(js.headers.get('content-security-policy'), HELP_CSP);
  });
});

// help-dads HD-6（Q7。計画 docs/plans/2026-10-23-help-dads.md の決めたこと I-30）: 門のページ（ログインできないときだけ出る）も
// main と h1 を持ち、色はヘルプと同じ値（DADS の札）、ログアウトのリンクは青と下線、輪は DADS の形。CSP（GATE_CSP）は変えない。
// help-light HL-2（計画 docs/plans/2026-10-27-help-light.md の HL1「する」）: 門のページも明るい版だけ。Windows の設定が暗くても白地のまま
// （暗い版の上書き @media (prefers-color-scheme) を持たない）。色は明るい版の DADS の札だけ（暗い版の灰色・明るい青の段は使わない）
test('HD-6 Q7・HL-2: 門のページは <main> の中に <h1>NaTsu ヘルプセンター</h1> と文。<style> は明るい版だけ（prefers-color-scheme の上書きが無く、色は明るい版の DADS の札だけ: 地 #ffffff・文字 #333333・見出し #000000・理由 #666666）。リンクは青と下線（訪問済み・ホバーは @media (hover: hover) の中・押している間）、:focus-visible は黒 4px＋黄色の縁', { timeout: 5000 }, async () => {
  const C = require('./helpers/simcss');
  const { gatePage } = await R.load('help-gate.mjs');
  const allowed = new Set(['#ffffff', '#000000', '#333333', '#666666', '#00118f', '#0017c1', '#8b008b', '#ac3e00', '#ffd43d']);
  for (const st of [401, 403, 503]) {
    const text = await gatePage(st, { why: 'cfg-aud' }).text();
    assert.match(text, /<body><main><h1>NaTsu ヘルプセンター<\/h1><p>[\s\S]*<\/main><\/body>/, `${st}: main と h1`);
    assert.strictEqual((text.match(/<h1>/g) || []).length, 1);
    const css = /<style>([\s\S]*)<\/style>/.exec(text)[1];
    // HL-2: 暗い版の上書きが無い（Windows の設定が暗くても門だけ暗くならない）。@media はホバーの1つだけ
    assert.doesNotMatch(css, /prefers-color-scheme/, `${st}: 門の style に暗い版の上書きがある`);
    assert.deepStrictEqual([...css.matchAll(/@media\s*([^{]+)\{/g)].map((m) => m[1].trim()), ['(hover:hover)'], `${st}: ホバーのほかの @media`);
    for (const c of css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g) || []) assert.ok(allowed.has(c.toLowerCase()), `${st}: 明るい版の札に無い色 ${c}`);
    const rules = C.parse(css);
    const d = (sel, at = '') => C.declsFor(rules, sel, { at });
    assert.deepStrictEqual([d('body').color, d('body').background, d('h1').color, d('.why').color], ['#333333', '#ffffff', '#000000', '#666666']);
    assert.strictEqual(d('a').color, '#00118f');
    assert.strictEqual(d('a')['text-decoration'], 'underline');
    assert.strictEqual(d('a:visited').color, '#8b008b');
    assert.strictEqual(d('a:hover', '@media (hover:hover)').color, '#0017c1');
    assert.strictEqual(d('a:active').color, '#ac3e00');
    for (const r of rules) if (r.sel.includes(':hover')) assert.ok(r.at.includes('(hover:hover)'), `${r.sel} が @media (hover: hover) の外`);
    // HL2「今のまま」: 輪は黒 4px＋黄色の縁だけ（白の輪に替える規則が無い）
    assert.strictEqual(d(':focus-visible').outline, 'calc(4 / 16 * 1rem) solid #000000');
    assert.strictEqual(d(':focus-visible')['box-shadow'], '0 0 0 calc(2 / 16 * 1rem) #ffd43d');
    assert.deepStrictEqual(rules.filter((r) => r.decls.outline !== undefined).map((r) => [r.at, r.sel, r.decls.outline]), [['', ':focus-visible', 'calc(4 / 16 * 1rem) solid #000000']], `${st}: 輪を替える規則`);
    assert.deepStrictEqual([d('a:focus-visible')['background-color'], d('a:focus-visible').color], ['#ffd43d', '#000000']);
  }
});
