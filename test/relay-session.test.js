/* relay-session.test.js — 第1d回 RL5・RL6・RF32・RF33・F12: コードを確かめて札を渡す口 /auth/verify・札の期限・/auth/logout・/auth/me・取り消し
   （node --test で Worker を起こさずに呼ぶ。偽の D1 は文ごとに往復の間を置くので、「読んでから数える」形は同時の要求で赤になる） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('./helpers/relay-run');
const { startFakeResend } = require('./helpers/fake-resend');

// 試しの時計の始まり: UTC の 1 時ちょうど
const T0 = Date.UTC(2026, 9, 19, 1, 0, 0);
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const DAY = 24 * H;
const KEYS = new Set(['ev', 'st', 'r', 'ms', 'sec', 'n', 'left', 'scope', 'v']);
const COUNTER_KEY = /^(?:s:e:[0-9a-f]{32}|s:d:[0-9a-f]{32}|s:ip:(?:[0-9a-f]{64}|unknown)|v:ip:(?:[0-9a-f]{64}|unknown)|mail)$/;
const TOKEN = /^nt1_[A-Za-z0-9_-]{43}$/;
const TABLES = ['meta', 'login_codes', 'sessions', 'blocked_emails', 'counters'];

// どの場面の記録・答えの見出し・数えの鍵も合わせて見る（RF32・F9）
const ALL = { logs: [], heads: [], keys: [], secrets: new Set(), results: new Set(), scenes: 0 };

const sha = async (s) => (await R.load('http.mjs')).sha256hex(s);
const rowsOf = async (db, sql, ...v) => (await db.prepare(sql).bind(...v).all()).results;
const sec = (ms) => Math.floor(ms / 1000);
// 正しいコードと違う 6 けた（i ごとに別の値）
const wrong = (code, i = 0) => String((Number(code) + 1 + i) % 1000000).padStart(6, '0');

// 取り消しの SQL は README の管理者の節に書くもの（計画の Task G-2 の 2・3）と同じ文字を、そのまま D1 に流す
const PLAN = fs.readFileSync(path.join(__dirname, '..', 'docs', 'plans', '2026-10-19-1d.md'), 'utf8');
function adminSql(head) {
  const m = new RegExp('`(' + head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "[^`]*'<[^>]+>'[^`]*;)`").exec(PLAN);
  assert.ok(m, `計画に「${head}」の SQL が無い`);
  assert.match(m[1], /CAST\(strftime\('%s','now'\) AS INTEGER\)/, '取り消しの SQL の時刻の書き方が計画と違う');
  return (email) => m[1].replace(/'<[^>]+>'/, `'${email}'`);
}

async function scene({ env = {}, start = T0 } = {}, fn) {
  const fr = await startFakeResend();
  try {
    await R.withRelay({ env: { RESEND_BASE: fr.base, ...env }, start }, async (ctx) => {
      const secrets = new Set();
      const heads = [];
      const calls = {};
      const keep = (s) => { if (typeof s === 'string' && s.trim()) { secrets.add(s.trim()); secrets.add(s.trim().toLowerCase()); } };
      async function send(ev, method, p, opts) {
        calls[ev] = (calls[ev] || 0) + 1;
        if (opts.ip) secrets.add(opts.ip);
        const res = await ctx.call(method, p, opts);
        const text = await res.text();
        let body = null;
        try { body = JSON.parse(text); } catch (_) { body = null; }
        if (body && typeof body.token === 'string') keep(body.token);
        for (const [k, v] of res.headers) heads.push(k + ': ' + v);
        return { status: res.status, body, headers: res.headers };
      }
      const bearer = (token) => (token === undefined ? {} : { authorization: 'Bearer ' + token });
      const api = {
        start(email, { ip = '192.0.2.10' } = {}) { keep(email); return send('auth.start', 'POST', '/auth/start', { body: { email }, ip }); },
        verify(email, code, { ip = '192.0.2.10', raw } = {}) {
          keep(email);
          return send('auth.verify', 'POST', '/auth/verify', { body: raw !== undefined ? raw : { email, code }, ip });
        },
        me(token, { headers } = {}) { keep(token); return send('auth.me', 'GET', '/auth/me', { headers: headers || bearer(token), ip: '192.0.2.10' }); },
        logout(token, { headers } = {}) { keep(token); return send('auth.logout', 'POST', '/auth/logout', { headers: headers || bearer(token), ip: '192.0.2.10' }); },
        // start → 偽の Resend からコード → verify。札の答えを返す
        async login(email, opts) {
          assert.strictEqual((await api.start(email, opts)).status, 200, 'start');
          const r = await api.verify(email, fr.codeFor(email), opts);
          assert.strictEqual(r.status, 200, 'verify ' + JSON.stringify(r.body));
          return r.body;
        },
        updates: () => ctx.db.ran.filter((s) => /^\s*UPDATE sessions\b/i.test(s)).length,
      };
      try {
        await fn({ ...ctx, fr, ...api });
      } finally {
        secrets.add(ctx.env.RESEND_API_KEY);
        secrets.add(ctx.env.OPENAI_API_KEY);
        for (const m of fr.mails) {
          for (const t of m.to || []) secrets.add(t);
          const c = /\b(\d{6})\b/.exec(String(m.text || ''));
          if (c) secrets.add(c[1]);
        }
        ALL.scenes += 1;
        ALL.logs.push(...ctx.logs);
        ALL.heads.push(...heads);
        for (const s of secrets) ALL.secrets.add(s);
      }
      // 場面の中で落ちたときは、ここに来ない（下の照らしで元の誤りを隠さない）
      const parsed = ctx.logs.map((l) => JSON.parse(l));
      for (const p of parsed) {
        for (const k of Object.keys(p)) assert.ok(KEYS.has(k), `記録に決まりの外の欄 ${k}`);
        if (p.r) ALL.results.add(p.ev + ':' + p.r);
      }
      for (const [ev, n] of Object.entries(calls)) {
        assert.strictEqual(parsed.filter((p) => p.ev === ev).length, n, `${ev} の1回に記録が1行でない`);
      }
      const text = ctx.logs.join('\n') + '\n' + heads.join('\n');
      for (const s of secrets) assert.ok(!text.includes(s), `記録か答えの見出しに ${s}`);
      for (const { key } of await rowsOf(ctx.db, 'SELECT key FROM counters')) {
        ALL.keys.push(key);
        assert.match(key, COUNTER_KEY, '数えの鍵にメールか IP');
      }
    });
  } finally {
    await fr.close();
  }
}

test('RL5: 正しいコードで札を渡し、D1 には札のハッシュだけ・コードの行は消える', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, verify, me, fr, db, clock, call }) => {
    const e = R.mail('Sess.User', 'Example.COM');
    const lower = R.mail('sess.user');
    const t = () => sec(clock.now());
    // 片付けの的: 同じメールの期限の切れた札（最初から 180 日・使わずに 30 日）と、ほかのメールの期限の切れた札
    await db.prepare('INSERT INTO sessions (token_hash, email, idp, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind('a'.repeat(64), lower, 'email', t() - 200 * 86400, t() - 86400, t() - 1).run();
    await db.prepare('INSERT INTO sessions (token_hash, email, idp, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind('b'.repeat(64), lower, 'email', t() - 40 * 86400, t() - 30 * 86400, t() + 140 * 86400).run();
    await db.prepare('INSERT INTO sessions (token_hash, email, idp, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind('c'.repeat(64), R.mail('other'), 'email', t() - 200 * 86400, t() - 86400, t() - 1).run();

    assert.strictEqual((await start(e)).status, 200);
    const code = fr.codeFor(lower);
    assert.match(code, /^\d{6}$/);
    clock.advance(5 * MIN);
    const r = await verify(' ' + e + ' ', code);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.strictEqual(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['email', 'expiresAt', 'idleDays', 'method', 'ok', 'token']);
    assert.strictEqual(r.body.ok, true);
    assert.match(r.body.token, TOKEN);
    assert.strictEqual(r.body.email, lower);
    assert.strictEqual(r.body.method, 'email');
    assert.strictEqual(r.body.idleDays, 30);
    assert.strictEqual(r.body.expiresAt, t() + 180 * 86400);
    const token = r.body.token;

    const rows = await rowsOf(db, 'SELECT * FROM sessions WHERE email = ?1', lower);
    assert.strictEqual(rows.length, 1, '同じメールの期限の切れた札が残った: ' + rows.map((x) => x.token_hash.slice(0, 4)).join(','));
    const s = rows[0];
    assert.notStrictEqual(s.token_hash, token);
    assert.strictEqual(s.token_hash, await sha(token));
    assert.strictEqual(s.idp, 'email');
    assert.strictEqual(s.created_at, t());
    assert.strictEqual(s.last_used_at, t());
    assert.strictEqual(s.expires_at, t() + 180 * 86400);
    assert.strictEqual(s.revoked_at, null);
    assert.strictEqual((await rowsOf(db, 'SELECT token_hash FROM sessions WHERE email = ?1', R.mail('other'))).length, 1, 'ほかのメールの札まで消した');
    assert.strictEqual((await rowsOf(db, 'SELECT email FROM login_codes WHERE email = ?1', lower)).length, 0, 'コードの行が残った');
    for (const tb of TABLES) {
      const all = JSON.stringify(await rowsOf(db, `SELECT * FROM ${tb}`));
      assert.ok(!all.includes(token), `${tb} に札`);
      assert.ok(!all.includes(token.slice(4)), `${tb} に札の乱数の部分`);
      assert.ok(!all.includes(code), `${tb} にコード`);
    }

    const m = await me(token);
    assert.strictEqual(m.status, 200);
    assert.deepStrictEqual(m.body, { email: lower, method: 'email', expiresAt: t() + 180 * 86400 });
    // 同じコードは2回使えない
    const again = await verify(lower, code);
    assert.strictEqual(again.status, 401);
    assert.deepStrictEqual(again.body, { error: 'code-expired' });
    // 方法が違えば 405
    assert.strictEqual((await call('GET', '/auth/verify')).status, 405);
    assert.strictEqual((await call('POST', '/auth/me')).status, 405);
    assert.strictEqual((await call('GET', '/auth/logout')).status, 405);
  });
});

test('RF33: 違うコードは 5 回まで（left が 4,3,2,1,0）、6 回目からは正しいコードでも code-expired', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, verify, fr, db }) => {
    const e = R.mail('five');
    assert.strictEqual((await start(e)).status, 200);
    const code = fr.codeFor(e);
    for (let i = 0; i < 5; i++) {
      const r = await verify(e, wrong(code, i));
      assert.strictEqual(r.status, 401, `${i + 1} 回目`);
      assert.deepStrictEqual(r.body, { error: 'code', left: 4 - i }, `${i + 1} 回目`);
    }
    const r6 = await verify(e, code);
    assert.strictEqual(r6.status, 401);
    assert.deepStrictEqual(r6.body, { error: 'code-expired' });
    assert.strictEqual((await rowsOf(db, 'SELECT token_hash FROM sessions')).length, 0, '使い切ったコードで札を渡した');
  });
  // 4 回違えた後の 5 回目の正しいコードは通る（今の1回を先に数えるので、勝ちを決める DELETE は attempts <= 5）
  await scene({}, async ({ start, verify, fr }) => {
    const e = R.mail('fifth');
    assert.strictEqual((await start(e)).status, 200);
    const code = fr.codeFor(e);
    for (let i = 0; i < 4; i++) assert.strictEqual((await verify(e, wrong(code, i))).body.left, 4 - i);
    const r5 = await verify(e, code);
    assert.strictEqual(r5.status, 200, '5 回目の正しいコードが通らない: ' + JSON.stringify(r5.body));
    assert.match(r5.body.token, TOKEN);
  });
});

test('RF33: 違うコードを 10 本同時に送っても、比べるのは 5 回だけ。その後の正しいコードも code-expired', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, verify, fr, db }) => {
    const e = R.mail('burst');
    assert.strictEqual((await start(e)).status, 200);
    const code = fr.codeFor(e);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => verify(e, wrong(code, i))));
    const errs = rs.map((x) => x.body.error).sort();
    assert.deepStrictEqual(errs, ['code', 'code', 'code', 'code', 'code', 'code-expired', 'code-expired', 'code-expired', 'code-expired', 'code-expired']);
    for (const x of rs) assert.strictEqual(x.status, 401);
    assert.deepStrictEqual(rs.filter((x) => x.body.error === 'code').map((x) => x.body.left).sort(), [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(await rowsOf(db, 'SELECT attempts FROM login_codes WHERE email = ?1', e), [{ attempts: 5 }]);
    const ok = await verify(e, code);
    assert.strictEqual(ok.status, 401);
    assert.deepStrictEqual(ok.body, { error: 'code-expired' });
  });
});

test('RF33: 正しいコードを2つ同時に送っても、札は1つだけ（もう1つは code-expired）', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, verify, fr, db }) => {
    const e = R.mail('twice');
    assert.strictEqual((await start(e)).status, 200);
    const code = fr.codeFor(e);
    const rs = await Promise.all([verify(e, code), verify(e, code), verify(e, code)]);
    assert.deepStrictEqual(rs.map((x) => x.status).sort(), [200, 401, 401]);
    for (const x of rs.filter((y) => y.status === 401)) assert.deepStrictEqual(x.body, { error: 'code-expired' });
    assert.strictEqual((await rowsOf(db, 'SELECT token_hash FROM sessions WHERE email = ?1', e)).length, 1, '1つのコードで札を2つ渡した');
  });
});

test('RL5: 期限の 10 分を過ぎたコードは code-expired', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, verify, fr, clock }) => {
    const e = R.mail('late');
    assert.strictEqual((await start(e)).status, 200);
    const code = fr.codeFor(e);
    clock.advance(599 * S);
    assert.deepStrictEqual((await verify(e, wrong(code))).body, { error: 'code', left: 4 }, '10 分の内なのに使えない');
    clock.advance(1 * S);
    const r = await verify(e, code);
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(r.body, { error: 'code-expired' });
    // 頼んでいないメールも同じ答え
    assert.deepStrictEqual((await verify(R.mail('never'), '123456')).body, { error: 'code-expired' });
  });
});

test('RL5: 同じ IP の verify は1時間に 150 回まで（429 と Retry-After）', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, verify, fr, clock, db }) => {
    const ip = '198.51.100.30';
    const e = R.mail('ipv');
    assert.strictEqual((await start(e)).status, 200);
    const code = fr.codeFor(e);
    for (let i = 0; i < 150; i++) assert.strictEqual((await verify(R.mail('n' + i), '000000', { ip })).status, 401, `${i + 1} 回目`);
    const r = await verify(e, code, { ip });
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.error, 'rate');
    assert.ok(Number.isInteger(r.body.retryAfter) && r.body.retryAfter >= 1 && r.body.retryAfter <= 3600, String(r.body.retryAfter));
    assert.strictEqual(r.headers.get('retry-after'), String(r.body.retryAfter));
    assert.deepStrictEqual(await rowsOf(db, 'SELECT attempts FROM login_codes WHERE email = ?1', e), [{ attempts: 0 }], '止めた verify でコードの回数を使った');
    // ほかの IP は止めない。1時間の窓を越えれば同じ IP も通る（start の IP の数えとは別）
    assert.strictEqual((await verify(R.mail('x'), '000000', { ip: '198.51.100.31' })).status, 401);
    assert.strictEqual((await start(R.mail('ipv2'), { ip })).status, 200, 'verify の数えで start まで止めた');
    clock.advance(61 * MIN);
    assert.strictEqual((await verify(e, wrong(code), { ip })).status, 401);
    const keys = (await rowsOf(db, 'SELECT key FROM counters')).map((x) => x.key);
    assert.ok(keys.includes('v:ip:' + await sha(ip)), keys.join(','));
  });
});

test('RL5: 形の悪い本文は 400（コードの回数は使わない）・大きすぎる本文は 413', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, verify, fr, db }) => {
    const e = R.mail('shape');
    assert.strictEqual((await start(e)).status, 200);
    const code = fr.codeFor(e);
    const bad = [
      ['not json', 'not json'],
      ['配列', '[1]'],
      ['null', 'null'],
      ['空', {}],
      ['コードが無い', { email: e }],
      ['メールが無い', { code }],
      ['コードが数', { email: e, code: Number(code) }],
      ['コードが 5 けた', { email: e, code: code.slice(1) }],
      ['コードが 7 けた', { email: e, code: code + '0' }],
      ['コードに文字', { email: e, code: code.slice(1) + 'a' }],
      ['全角の数字', { email: e, code: '１２３４５６' }],
      ['メールの形', { email: 'example.com', code }],
    ];
    for (const [label, raw] of bad) {
      const r = await verify(undefined, undefined, { raw });
      assert.strictEqual(r.status, 400, label);
      assert.deepStrictEqual(r.body, { error: 'bad-request' }, label);
    }
    const big = await verify(undefined, undefined, { raw: JSON.stringify({ email: e, code, pad: 'x'.repeat(3000) }) });
    assert.strictEqual(big.status, 413);
    assert.deepStrictEqual(big.body, { error: 'too-large' });
    assert.deepStrictEqual(await rowsOf(db, 'SELECT attempts FROM login_codes WHERE email = ?1', e), [{ attempts: 0 }]);
    // 前後の空白は落とす（貼り付けたコード）
    const ok = await verify(e, ' ' + code + ' ');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });
});

test('RL6: 札の期限: 使えば 30 日延びる・30 日使わなければ切れる・使い続けても最初から 180 日で切れる。last_used_at は 1日に 1 回だけ書き直す', { timeout: 5000 }, async () => {
  await scene({}, async ({ login, me, clock, updates, db }) => {
    const a = await login(R.mail('long'));
    const b = await login(R.mail('idle'));
    const c = await login(R.mail('idle2'));
    const d = await login(R.mail('daily'));
    const u0 = updates();
    // 1日に 1 回だけ: 同じ日の内は何回使っても書き直さない
    for (let i = 0; i < 3; i++) assert.strictEqual((await me(d.token)).status, 200);
    clock.advance(23 * H);
    assert.strictEqual((await me(d.token)).status, 200);
    assert.strictEqual(updates() - u0, 0, '1日たつ前に last_used_at を書き直した');
    clock.advance(1 * H);
    assert.strictEqual((await me(d.token)).status, 200);
    assert.strictEqual((await me(d.token)).status, 200);
    assert.strictEqual(updates() - u0, 1, '1日たった後の書き直しが1回でない');
    const [row] = await rowsOf(db, 'SELECT last_used_at, created_at FROM sessions WHERE token_hash = ?1', await sha(d.token));
    assert.strictEqual(row.last_used_at - row.created_at, 86400);

    // 使えば延びる（29 日目に使った札は、30 日を過ぎても使える）
    clock.set(T0 + 29 * DAY);
    assert.strictEqual((await me(a.token)).status, 200, '29 日目に切れた');
    // 30 日使わなければ切れる（30 日ちょうどで切れ、その 1 秒前は使える）
    clock.set(T0 + 30 * DAY - S);
    assert.strictEqual((await me(c.token)).status, 200, '30 日の前に切れた');
    clock.set(T0 + 30 * DAY);
    const gone = await me(b.token);
    assert.strictEqual(gone.status, 401, '30 日使わなかった札が使えた');
    assert.deepStrictEqual(gone.body, { error: 'login' });

    // 使い続ければ延びるが、最初から 180 日で切れる
    for (let day = 58; day < 180; day += 29) {
      clock.set(T0 + day * DAY);
      const r = await me(a.token);
      assert.strictEqual(r.status, 200, `${day} 日目に切れた`);
      assert.strictEqual(r.body.expiresAt, sec(T0) + 180 * 86400);
    }
    clock.set(T0 + 180 * DAY - S);
    assert.strictEqual((await me(a.token)).status, 200, '180 日の前に切れた');
    clock.set(T0 + 180 * DAY);
    const end = await me(a.token);
    assert.strictEqual(end.status, 401, '180 日を過ぎた札が使えた');
    assert.deepStrictEqual(end.body, { error: 'login' });
  });
});

test('RL6: 取り消し: D1 の画面の SQL（revoked_at・blocked_emails）の後は 401 login。止めたメールは、正しいコードの verify だけが 403 blocked', { timeout: 5000 }, async () => {
  const revokeSql = adminSql('UPDATE sessions SET revoked_at');
  const blockSql = adminSql('INSERT INTO blocked_emails');
  await scene({}, async ({ login, me, start, verify, fr, db, clock }) => {
    const e = R.mail('revoke');
    const a = await login(e);
    clock.advance(MIN);
    const b = await login(e);
    const o = await login(R.mail('keep'));
    assert.strictEqual((await me(a.token)).status, 200);
    await db.prepare(revokeSql(e)).run();
    for (const t of [a, b]) {
      const r = await me(t.token);
      assert.strictEqual(r.status, 401, '取り消した札が使えた');
      assert.deepStrictEqual(r.body, { error: 'login' });
    }
    assert.strictEqual((await me(o.token)).status, 200, 'ほかのメールの札まで取り消した');
    // 取り消した後でも、ログインし直せば新しい札は使える
    clock.advance(16 * MIN);
    const c = await login(e);
    assert.strictEqual((await me(c.token)).status, 200);

    // 止めたメール: 生きている札も 401、start は 200（止めたかを明かさない）、違うコードは 401 code、正しいコードは 403 blocked
    await db.prepare(blockSql(e)).run();
    assert.deepStrictEqual((await me(c.token)).body, { error: 'login' }, '止めたメールの札が使えた');
    clock.advance(16 * MIN);
    const s = await start(e);
    assert.strictEqual(s.status, 200);
    assert.deepStrictEqual(s.body, { ok: true, expiresIn: 600 });
    const code = fr.codeFor(e);
    const w = await verify(e, wrong(code));
    assert.strictEqual(w.status, 401);
    assert.deepStrictEqual(w.body, { error: 'code', left: 4 }, '違うコードで止めたことを明かした');
    const before = (await rowsOf(db, 'SELECT token_hash FROM sessions')).length;
    const r = await verify(e, code);
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(r.body, { error: 'blocked' });
    assert.strictEqual((await rowsOf(db, 'SELECT token_hash FROM sessions')).length, before, '止めたメールに札を作った');
    assert.strictEqual((await me(o.token)).status, 200, 'ほかのメールまで止めた');
  });
});

test('RL5: /auth/logout はその札だけを取り消し（同じメールのほかの札は生きている）、無い札・切れた札でも 200', { timeout: 5000 }, async () => {
  await scene({}, async ({ login, me, logout, clock, db }) => {
    const e = R.mail('bye');
    const a = await login(e);
    clock.advance(MIN);
    const b = await login(e);
    const r = await logout(a.token);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true });
    assert.deepStrictEqual((await me(a.token)).body, { error: 'login' });
    assert.strictEqual((await me(b.token)).status, 200, '同じメールのほかの札まで取り消した');
    const [row] = await rowsOf(db, 'SELECT revoked_at FROM sessions WHERE token_hash = ?1', await sha(a.token));
    assert.strictEqual(row.revoked_at, sec(clock.now()));
    // 何回でも・無い札・形の違う見出し・見出しが無いときも 200
    const cases = [
      ['2回目', { token: a.token }],
      ['無い札', { token: 'nt1_' + 'A'.repeat(43) }],
      ['形の違う札', { token: 'xyz' }],
      ['見出しが無い', { headers: {} }],
      ['Basic', { headers: { authorization: 'Basic ' + b.token } }],
    ];
    for (const [label, o] of cases) {
      const x = o.headers ? await logout(undefined, { headers: o.headers }) : await logout(o.token);
      assert.strictEqual(x.status, 200, label);
      assert.deepStrictEqual(x.body, { ok: true }, label);
    }
    assert.strictEqual((await me(b.token)).status, 200, '形の違う見出しで札を取り消した');
    // 切れた札も 200
    clock.advance(31 * DAY);
    assert.strictEqual((await me(b.token)).status, 401);
    assert.deepStrictEqual((await logout(b.token)).body, { ok: true });
  });
});

test('RL5: /auth/me は Bearer の nt1_ の形だけを受ける（無い・違う・形の違う札は 401 login）', { timeout: 5000 }, async () => {
  await scene({}, async ({ login, me }) => {
    const a = await login(R.mail('form'));
    const bad = [
      {},
      { authorization: a.token },
      { authorization: 'bearer ' + a.token },
      { authorization: 'Bearer  ' + a.token },
      { authorization: 'Bearer ' + a.token + 'x' },
      { authorization: 'Bearer ' + a.token.slice(0, -1) },
      { authorization: 'Bearer ' + a.token.slice(4) },
      { authorization: 'Bearer nt1_' + 'A'.repeat(43) },
      { authorization: 'Bearer ' + a.token.slice(0, -1) + (a.token.endsWith('A') ? 'B' : 'A') },
    ];
    for (const headers of bad) {
      const r = await me(undefined, { headers });
      assert.strictEqual(r.status, 401, JSON.stringify(headers).replace(a.token, '<札>'));
      assert.deepStrictEqual(r.body, { error: 'login' });
    }
    assert.strictEqual((await me(a.token)).status, 200);
  });
});

test('F12: issueSession(env, cfg, { email, idp: microsoft }) で作った札も requireSession で通り、/auth/me の method が microsoft', { timeout: 5000 }, async () => {
  const auth = await R.load('auth.mjs');
  const { readConfig } = await R.load('config.mjs');
  await scene({}, async ({ env, me, db, clock }) => {
    const cfg = readConfig(env);
    const e = R.mail('Ms.User');
    const lower = R.mail('ms.user');
    const s = await auth.issueSession(env, cfg, { email: e, idp: 'microsoft', now: clock.now });
    assert.deepStrictEqual(Object.keys(s).sort(), ['expiresAt', 'token']);
    assert.match(s.token, TOKEN);
    assert.strictEqual(s.expiresAt, sec(clock.now()) + 180 * 86400);
    const [row] = await rowsOf(db, 'SELECT email, idp FROM sessions WHERE token_hash = ?1', await sha(s.token));
    assert.deepStrictEqual(row, { email: lower, idp: 'microsoft' });
    const r = await me(s.token);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { email: lower, method: 'microsoft', expiresAt: s.expiresAt });
    const got = await auth.requireSession(new Request('https://relay.test/auth/me', { headers: { authorization: 'Bearer ' + s.token } }), env, cfg, { now: clock.now });
    assert.deepStrictEqual(got, { email: lower, idp: 'microsoft', tokenHash: await sha(s.token), expiresAt: s.expiresAt });
    assert.strictEqual(await auth.requireSession(new Request('https://relay.test/auth/me'), env, cfg, { now: clock.now }), null);
    // idp を省けば email。知らない idp・形の悪いメールでは作らない
    const d = await auth.issueSession(env, cfg, { email: lower, now: clock.now });
    assert.strictEqual((await me(d.token)).body.method, 'email');
    await assert.rejects(auth.issueSession(env, cfg, { email: lower, idp: 'other', now: clock.now }));
    await assert.rejects(auth.issueSession(env, cfg, { email: 'example.com', idp: 'email', now: clock.now }));
  });
});

test('RF32・F9: 記録・答えの見出し・D1 の counters の鍵のどこにも、札・メール・コードが無い（上の全部の場面を合わせて）', { timeout: 5000 }, () => {
  assert.ok(ALL.scenes >= 12, `場面が少ない（${ALL.scenes}）。このテストはファイルの最後に置く`);
  assert.ok(ALL.logs.length >= 200, `記録が少ない（${ALL.logs.length}）`);
  for (const r of ['auth.verify:ok', 'auth.verify:code', 'auth.verify:code-expired', 'auth.verify:blocked', 'auth.verify:rate',
    'auth.verify:bad-request', 'auth.verify:too-large', 'auth.me:ok', 'auth.me:login', 'auth.logout:ok']) {
    assert.ok(ALL.results.has(r), `記録に ${r} の行が無い`);
  }
  assert.ok([...ALL.secrets].some((s) => TOKEN.test(s)), '札を集めていない');
  const text = ALL.logs.join('\n') + '\n' + ALL.heads.join('\n') + '\n' + ALL.keys.join('\n');
  for (const s of ALL.secrets) assert.ok(!text.includes(s), `記録・見出し・数えの鍵に ${s}`);
  assert.ok(!/example\./i.test(text), '記録・見出し・数えの鍵にドメイン');
  for (const l of ALL.logs) assert.deepStrictEqual(Object.keys(JSON.parse(l)).filter((k) => !KEYS.has(k)), [], l);
  const verifyLines = ALL.logs.map((l) => JSON.parse(l)).filter((p) => p.ev === 'auth.verify' && p.r === 'code');
  assert.ok(verifyLines.length > 0 && verifyLines.every((p) => Number.isInteger(p.left)), '違うコードの記録に left が無い');
});
