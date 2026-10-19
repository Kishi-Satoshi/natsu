/* relay-auth.test.js — 第1d回 RL3・RL4・RF33・RF37: 確認コードを頼む口 /auth/start（node --test で Worker を起こさずに呼ぶ） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('./helpers/relay-run');
const { startFakeResend } = require('./helpers/fake-resend');

// 試しの時計の始まり: UTC の 1 時ちょうど（15 分・1 時間・1 日の窓の境が分かる。4 回 16 分進めても日を越えない）
const T0 = Date.UTC(2026, 9, 19, 1, 0, 0);
const KEYS = new Set(['ev', 'st', 'r', 'ms', 'sec', 'n', 'left', 'scope', 'v']);
const COUNTER_KEY = /^(?:s:e:[0-9a-f]{32}|s:d:[0-9a-f]{32}|s:ip:(?:[0-9a-f]{64}|unknown)|mail)$/;

// どの場面の記録も合わせて見る（RL7・F9）
const ALL = { logs: [], secrets: new Set(), results: new Set(), scenes: 0 };

const sha = async (s) => (await R.load('http.mjs')).sha256hex(s);
const rowsOf = async (db, sql, ...v) => (await db.prepare(sql).bind(...v).all()).results;

// 偽の Resend を RESEND_BASE にして中継を呼ぶ。終わったら、記録に秘密が無いこと・数えの鍵にメールも IP も無いことを見る
async function scene({ env = {}, resend = 'ok', start = T0, noSchema = false } = {}, fn) {
  const fr = await startFakeResend({ mode: resend });
  try {
    await R.withRelay({ env: { RESEND_BASE: fr.base, ...env }, noSchema, start }, async (ctx) => {
      const secrets = new Set();
      let calls = 0;
      const ask = (email, { ip = '192.0.2.10', raw } = {}) => {
        calls += 1;
        if (ip) secrets.add(ip);
        if (typeof email === 'string' && email.trim()) { secrets.add(email.trim()); secrets.add(email.trim().toLowerCase()); }
        return ctx.call('POST', '/auth/start', { body: raw !== undefined ? raw : { email }, ip });
      };
      try {
        await fn({ ...ctx, fr, start: ask });
      } finally {
        // 記録に秘密が無いかの照らしは、場面が落ちても最後のテストで合わせて見る
        if (ctx.env.RESEND_API_KEY) secrets.add(ctx.env.RESEND_API_KEY);
        if (ctx.env.OPENAI_API_KEY) secrets.add(ctx.env.OPENAI_API_KEY);
        for (const m of fr.mails) {
          for (const t of m.to || []) secrets.add(t);
          const c = /\b(\d{6})\b/.exec(String(m.text || ''));
          if (c) secrets.add(c[1]);
        }
        ALL.scenes += 1;
        ALL.logs.push(...ctx.logs);
        for (const s of secrets) ALL.secrets.add(s);
      }
      // 場面の中で落ちたときは、ここに来ない（下の照らしで元の誤りを隠さない）
      {
        const parsed = ctx.logs.map((l) => JSON.parse(l));
        for (const p of parsed) {
          for (const k of Object.keys(p)) assert.ok(KEYS.has(k), `記録に決まりの外の欄 ${k}`);
          if (p.r) ALL.results.add(p.r);
        }
        assert.strictEqual(parsed.filter((p) => p.ev === 'auth.start').length, calls, '/auth/start の1回に記録が1行でない');
        const text = ctx.logs.join('\n');
        for (const s of secrets) assert.ok(!text.includes(s), `記録に ${s}`);
        assert.ok(!/example\./i.test(text), '記録にドメイン');
        if (!noSchema) {
          for (const { key } of await rowsOf(ctx.db, 'SELECT key FROM counters')) assert.match(key, COUNTER_KEY, '数えの鍵にメールか IP');
        }
      }
    });
  } finally {
    await fr.close();
  }
}

test('RL3: 登録できるドメインのメールにだけ送り、メールには 6 けたのコードがあり、D1 にはハッシュだけが残る', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, call, fr, db, env, clock }) => {
    const res = await start(' ' + R.mail('Test.User', 'Example.COM') + ' ');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    assert.strictEqual(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepStrictEqual(await res.json(), { ok: true, expiresIn: 600 });
    assert.strictEqual(fr.mails.length, 1);
    const m = fr.mails[0];
    const to = R.mail('test.user');
    assert.deepStrictEqual(m.to, [to]);
    assert.strictEqual(m.from, env.MAIL_FROM);
    assert.strictEqual(m.subject, 'NaTsu の確認コード');
    const code = fr.codeFor(to);
    assert.match(code, /^\d{6}$/);
    assert.match(m.text, /\b\d{6}\b/);
    assert.strictEqual(m.text, `NaTsu の確認コードは ${code} です。10 分の間だけ使えます。心当たりが無いときは、このメールを消してください（だれかがメールアドレスを打ち間違えた可能性があります）。`);
    assert.strictEqual(m.headers.authorization, 'Bearer ' + env.RESEND_API_KEY);
    assert.strictEqual(m.headers['idempotency-key'], (await sha(to + code)).slice(0, 32));
    assert.ok(!JSON.stringify(m.headers).includes(env.OPENAI_API_KEY), 'Resend へ OpenAI の鍵');
    const rows = await rowsOf(db, 'SELECT * FROM login_codes');
    assert.strictEqual(rows.length, 1);
    const r = rows[0];
    assert.strictEqual(r.email, to);
    assert.notStrictEqual(r.code_hash, code);
    assert.match(r.code_hash, /^[0-9a-f]{64}$/);
    assert.strictEqual(r.code_hash, await sha(to + ':' + code));
    assert.strictEqual(r.expires_at - r.created_at, 600);
    assert.strictEqual(r.created_at, Math.floor(clock.now() / 1000));
    assert.strictEqual(r.attempts, 0);
    // D1 のどの表のどの行にも、コードそのものが無い
    for (const t of ['meta', 'login_codes', 'sessions', 'blocked_emails', 'counters']) {
      assert.ok(!JSON.stringify(await rowsOf(db, `SELECT * FROM ${t}`)).includes(code), `${t} にコード`);
    }
    // 止めたメールにも、ほかと同じく送る（start の答えで止めたかどうかを明かさない）
    await db.prepare('INSERT INTO blocked_emails (email, at) VALUES (?1, ?2)').bind(R.mail('blocked'), 1).run();
    const b = await start(R.mail('blocked'));
    assert.strictEqual(b.status, 200);
    assert.deepStrictEqual(await b.json(), { ok: true, expiresIn: 600 });
    assert.match(fr.codeFor(R.mail('blocked')), /^\d{6}$/);
    // 方法が違えば 405
    assert.strictEqual((await call('GET', '/auth/start')).status, 405);
  });
});

test('RL3: ほかのドメイン・サブドメイン・形の悪いメールは送らない', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, fr, db }) => {
    const cases = [
      [R.mail('a', 'example.net'), 403, 'domain'],
      [R.mail('a', 'sub.example.com'), 403, 'domain'],
      [R.mail('a', 'example.com.evil.example'), 403, 'domain'],
      [R.mail('a', 'example.co'), 403, 'domain'],
      [R.mail('a', '@example.com'), 400, 'bad-email'],
      [R.mail('a'.repeat(70)), 400, 'bad-email'],
      [R.mail('a b'), 400, 'bad-email'],
      ['example.com', 400, 'bad-email'],
      ['', 400, 'bad-email'],
      [5, 400, 'bad-email'],
      [null, 400, 'bad-email'],
    ];
    for (const [email, st, error] of cases) {
      const res = await start(email);
      assert.strictEqual(res.status, st, String(email));
      assert.deepStrictEqual(await res.json(), { error }, String(email));
    }
    assert.deepStrictEqual(await (await start(undefined, { raw: {} })).json(), { error: 'bad-email' });
    for (const raw of ['not json', '[1]', 'null']) {
      const res = await start(undefined, { raw });
      assert.strictEqual(res.status, 400, raw);
      assert.deepStrictEqual(await res.json(), { error: 'bad-request' }, raw);
    }
    const big = await start(undefined, { raw: JSON.stringify({ email: R.mail('big'), pad: 'x'.repeat(3000) }) });
    assert.strictEqual(big.status, 413);
    assert.deepStrictEqual(await big.json(), { error: 'too-large' });
    assert.strictEqual(fr.mails.length, 0, 'Resend に送った');
    assert.strictEqual((await rowsOf(db, 'SELECT email FROM login_codes')).length, 0);
  });
});

test('RL4・RF33: 同じメールは 15 分に 3 回・1日 10 回まで（大文字と小文字は同じメール）', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, fr, clock }) => {
    const e = R.mail('rate');
    for (let i = 0; i < 3; i++) assert.strictEqual((await start(e)).status, 200, `${i + 1} 回目`);
    const r4 = await start(e);
    assert.strictEqual(r4.status, 429);
    const j = await r4.json();
    assert.strictEqual(j.error, 'rate');
    assert.ok(Number.isInteger(j.retryAfter) && j.retryAfter >= 1 && j.retryAfter <= 900, String(j.retryAfter));
    assert.strictEqual(r4.headers.get('retry-after'), String(j.retryAfter));
    assert.strictEqual((await start(R.mail('RATE', 'EXAMPLE.com'))).status, 429, '大文字にすると数えが別になる');
    assert.strictEqual(fr.mails.length, 3, '止めたのに Resend に送った');
    // 15 分の窓を越えれば通る。1日に頼めるのは 10 回まで（止めた頼みも数える: 先に数えてから比べる。ここまでで 5 回）
    clock.advance(16 * 60 * 1000);
    for (let i = 0; i < 3; i++) assert.strictEqual((await start(e)).status, 200, `${6 + i} 回目`);
    clock.advance(16 * 60 * 1000);
    for (let i = 0; i < 2; i++) assert.strictEqual((await start(e)).status, 200, `${9 + i} 回目`);
    const r11 = await start(e);
    assert.strictEqual(r11.status, 429);
    const j11 = await r11.json();
    assert.strictEqual(j11.error, 'rate');
    assert.ok(j11.retryAfter > 900 && j11.retryAfter <= 86400, `1日の数えの retryAfter ${j11.retryAfter}`);
    assert.strictEqual(r11.headers.get('retry-after'), String(j11.retryAfter));
    // 15 分の窓と1日の窓の両方を越えたら、長いほう（日の替わり）まで待たせる（15 分後に試させて、また止めない）
    const r12 = await start(e);
    assert.strictEqual(r12.status, 429);
    assert.strictEqual((await r12.json()).retryAfter, j11.retryAfter, '両方を越えたのに短い窓の retryAfter');
    assert.strictEqual(fr.mails.length, 8);
    assert.strictEqual((await start(R.mail('other'))).status, 200, 'ほかのメールまで止めた');
  });
});

test('RL4・RF33: 同じ IP は1時間に 60 回まで（許していないドメインの頼みも数える）', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, fr, db, clock }) => {
    const ip = '198.51.100.20';
    for (let i = 0; i < 30; i++) assert.strictEqual((await start(R.mail('g' + i, 'example.net'), { ip })).status, 403);
    for (let i = 0; i < 30; i++) assert.strictEqual((await start(R.mail('u' + i), { ip })).status, 200);
    const r = await start(R.mail('u-last'), { ip });
    assert.strictEqual(r.status, 429);
    const j = await r.json();
    assert.strictEqual(j.error, 'rate');
    assert.ok(j.retryAfter >= 1 && j.retryAfter <= 3600, String(j.retryAfter));
    assert.strictEqual(r.headers.get('retry-after'), String(j.retryAfter));
    // 上限の後は、ドメインの当て推量にも同じ 429（許したドメインかを答えない）
    const g = await start(R.mail('g-last', 'example.net'), { ip });
    assert.strictEqual(g.status, 429);
    assert.strictEqual(fr.mails.length, 30);
    // ほかの IP は止めない。1時間の窓を越えれば同じ IP も通る
    assert.strictEqual((await start(R.mail('v1'), { ip: '198.51.100.21' })).status, 200);
    clock.advance(61 * 60 * 1000);
    assert.strictEqual((await start(R.mail('u-last'), { ip })).status, 200);
    const keys = (await rowsOf(db, 'SELECT key FROM counters')).map((x) => x.key);
    assert.ok(keys.includes('s:ip:' + await sha(ip)), keys.join(','));
  });
});

test('RL4・RF33: 全体は1日 MAIL_DAILY_MAX 通まで（数えてから送る・同時でも越えない・送らなかった頼みは数えない）', { timeout: 5000 }, async () => {
  await scene({ env: { MAIL_DAILY_MAX: '3' } }, async ({ start, fr }) => {
    for (let i = 0; i < 3; i++) assert.strictEqual((await start(R.mail('m' + i), { ip: '203.0.113.' + (i + 1) })).status, 200);
    const r = await start(R.mail('m3'), { ip: '203.0.113.9' });
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(await r.json(), { error: 'mail-cap' });
    assert.strictEqual(fr.mails.length, 3, '止めたのに Resend に送った');
  });
  await scene({ env: { MAIL_DAILY_MAX: '3' } }, async ({ start, fr }) => {
    const rs = await Promise.all([0, 1, 2, 3, 4].map((i) => start(R.mail('c' + i), { ip: '203.0.113.' + (20 + i) })));
    assert.deepStrictEqual(rs.map((x) => x.status).sort(), [200, 200, 200, 503, 503]);
    for (const x of rs.filter((y) => y.status === 503)) assert.deepStrictEqual(await x.json(), { error: 'mail-cap' });
    assert.strictEqual(fr.mails.length, 3, '同時の頼みで上限を越えて送った');
  });
  // 同じメールの送りすぎ（rate で送らなかった頼み）は、全体の通数を使わない
  await scene({ env: { MAIL_DAILY_MAX: '4' } }, async ({ start, fr }) => {
    for (let i = 0; i < 3; i++) assert.strictEqual((await start(R.mail('same'))).status, 200);
    for (let i = 0; i < 3; i++) assert.strictEqual((await start(R.mail('same'))).status, 429);
    assert.strictEqual((await start(R.mail('next'))).status, 200, '送らなかった頼みで全体の通数を使った');
    assert.strictEqual(fr.mails.length, 4);
  });
});

test('RL4: コードを送り直すと前のコードは使えない（行を置き換える）・試した回数も 0 に戻る・古い行は片付ける', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, fr, db, clock }) => {
    const e = R.mail('again');
    const now = () => Math.floor(clock.now() / 1000);
    assert.strictEqual((await start(e)).status, 200);
    const code1 = fr.codeFor(e);
    await db.prepare('UPDATE login_codes SET attempts = 3 WHERE email = ?1').bind(e).run();
    // 片付けの的: 期限の切れたほかのコードと、2 日より古い窓の数え
    await db.prepare('INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?1, ?2, ?3, 0, ?4)')
      .bind(R.mail('stale'), 'x'.repeat(64), now() - 1, now() - 601).run();
    await db.prepare('INSERT INTO counters (key, win, n) VALUES (?1, ?2, 5)').bind('s:e:' + 'a'.repeat(32), now() - 3 * 86400).run();
    clock.advance(60 * 1000);
    assert.strictEqual((await start(e)).status, 200);
    const code2 = fr.codeFor(e);
    assert.strictEqual(fr.sent.length, 2);
    const rows = await rowsOf(db, 'SELECT * FROM login_codes WHERE email = ?1', e);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].attempts, 0);
    assert.strictEqual(rows[0].code_hash, await sha(e + ':' + code2));
    if (code1 !== code2) assert.notStrictEqual(rows[0].code_hash, await sha(e + ':' + code1));
    assert.strictEqual(rows[0].created_at, now());
    assert.strictEqual(rows[0].expires_at, now() + 600);
    assert.deepStrictEqual((await rowsOf(db, 'SELECT email FROM login_codes')).map((x) => x.email), [e], '期限の切れたコードが残った');
    assert.strictEqual((await rowsOf(db, 'SELECT key FROM counters WHERE key = ?1', 's:e:' + 'a'.repeat(32))).length, 0, '古い数えが残った');
    assert.ok((await rowsOf(db, 'SELECT key FROM counters')).length >= 4, '今の数えまで消した');
  });
});

test('RF37: Resend が 403・429・500・切れた → 503 mail、D1 のコードの行は残さず、全体の通数も戻す', { timeout: 5000 }, async () => {
  for (const mode of ['403', '429', '500', 'drop']) {
    await scene({ resend: mode, env: { MAIL_DAILY_MAX: '1' } }, async ({ start, fr, db }) => {
      const r = await start(R.mail('fail-' + mode));
      assert.strictEqual(r.status, 503, mode);
      assert.deepStrictEqual(await r.json(), { error: 'mail' }, mode);
      assert.strictEqual(fr.mails.length, 1, `${mode}: Resend へ打っていない`);
      assert.strictEqual((await rowsOf(db, 'SELECT email FROM login_codes')).length, 0, `${mode}: 送れていないコードの行を残した`);
      fr.setMode('ok');
      const ok = await start(R.mail('next-' + mode));
      assert.strictEqual(ok.status, 200, `${mode}: 送れなかった分で全体の通数を使い切った`);
      assert.strictEqual((await rowsOf(db, 'SELECT email FROM login_codes')).length, 1);
    });
  }
});

test('RL4: IP の見出しが無いときは全員で1つの数え（止まらずに、IP ごとの上限だけが効かない）', { timeout: 5000 }, async () => {
  await scene({}, async ({ start, db, fr }) => {
    for (let i = 0; i < 2; i++) assert.strictEqual((await start(R.mail('noip' + i), { ip: '' })).status, 200);
    assert.deepStrictEqual(await rowsOf(db, 'SELECT n FROM counters WHERE key = ?1', 's:ip:unknown'), [{ n: 2 }]);
    for (let i = 0; i < 58; i++) assert.strictEqual((await start(R.mail('n' + i, 'example.net'), { ip: '' })).status, 403);
    assert.strictEqual((await start(R.mail('noip-last'), { ip: '' })).status, 429, '見出しの無い頼みを数えていない');
    assert.strictEqual((await start(R.mail('with-ip'), { ip: '192.0.2.77' })).status, 200, '見出しのある頼みまで止めた');
    assert.strictEqual(fr.mails.length, 3);
  });
});

test('RL3: 秘密が足りない（ドメインが空・RESEND_API_KEY・MAIL_FROM が無い・D1 の表が無い）→ 503 not-ready', { timeout: 5000 }, async () => {
  const cases = [
    ['ドメインが空', { env: { ALLOWED_EMAIL_DOMAINS: '' } }],
    ['ドメインが空白とカンマだけ', { env: { ALLOWED_EMAIL_DOMAINS: ' , ' } }],
    ['RESEND_API_KEY が無い', { env: { RESEND_API_KEY: undefined } }],
    ['MAIL_FROM が無い', { env: { MAIL_FROM: undefined } }],
    ['D1 の表が無い', { noSchema: true }],
  ];
  for (const [label, opts] of cases) {
    await scene(opts, async ({ start, fr }) => {
      const r = await start(R.mail('nr'));
      assert.strictEqual(r.status, 503, label);
      assert.deepStrictEqual(await r.json(), { error: 'not-ready' }, label);
      assert.strictEqual(fr.mails.length, 0, label);
    });
  }
});

test('RL7・F9: 記録の全部の行に、メール・IP・コード・Resend の鍵が無い（上の全部の場面を合わせて）', { timeout: 5000 }, () => {
  assert.ok(ALL.scenes >= 15, `場面が少ない（${ALL.scenes}）。このテストはファイルの最後に置く`);
  assert.ok(ALL.logs.length >= 150, `記録が少ない（${ALL.logs.length}）`);
  for (const r of ['sent', 'domain', 'rate', 'mail', 'mail-cap', 'bad-email', 'bad-request', 'too-large', 'not-ready']) {
    assert.ok(ALL.results.has(r), `記録に r: ${r} の行が無い`);
  }
  const text = ALL.logs.join('\n');
  for (const s of ALL.secrets) assert.ok(!text.includes(s), `記録に ${s}`);
  for (const l of ALL.logs) assert.deepStrictEqual(Object.keys(JSON.parse(l)).filter((k) => !KEYS.has(k)), [], l);
});
