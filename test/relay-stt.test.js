/* relay-stt.test.js — 第1d回 RL7・RF34・RF38・F3・F6・F9: 文字起こしの口 POST /v1/audio/transcriptions
   （node --test で Worker を起こさずに呼ぶ。偽の OpenAI は test/helpers/fake-stt.js（OpenAI と同じ形）。
    偽の D1 は文ごとに往復の間を置くので、「送る前に読む・200 の後に足す」形は同時の要求で赤になる）
   第1d回 W-6 で意図して変えた: ログインは Cloudflare Access の JWT だけ（自前の札と確認コードのメールを消した）。場面は偽の Access
   （test/helpers/fake-access.js）を立て、login は偽の Access が署名した JWT を作り、send はそれを Cf-Access-Jwt-Assertion で送る */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const R = require('./helpers/relay-run');
const { startFakeStt } = require('./helpers/fake-stt');
const { startFakeAccess } = require('./helpers/fake-access');

// 試しの時計の始まり: UTC の 1 時ちょうど（日本の 10 時。日本の日付の替わりまで 14 時間）
const T0 = Date.UTC(2026, 9, 19, 1, 0, 0);
const S = 1000;
const H = 3600 * S;
const DAY = 24 * H;
const TO_DAY_END = 14 * 3600;
const KEYS = new Set(['ev', 'st', 'r', 'ms', 'sec', 'n', 'left', 'scope', 'v']);
const STT_KEYS = new Set(['ev', 'st', 'r', 'ms', 'sec', 'scope', 'v']);   // 0.9.4 S-6 で v（stream・buf）を足した
const COUNTER_KEY = /^(?:a:u:[0-9a-f]{32}|a:all)$/;
const TABLES = ['meta', 'blocked_emails', 'counters'];
const PATH = '/v1/audio/transcriptions';
const HINT = '見積と予算';
const SAID = '本日の議題は進捗の確認です。';

// どの場面の記録・答えの見出し・D1 の行も合わせて見る（F9・RL7）
const ALL = { logs: [], heads: [], secrets: new Set(), results: new Set(), scenes: 0, rows: [] };

const enc = encodeURIComponent;
const rowsOf = async (db, sql, ...v) => (await db.prepare(sql).bind(...v).all()).results;
const used = async (db, key) => Number((await rowsOf(db, 'SELECT n FROM counters WHERE key = ?1', key))[0]?.n || 0);
const userKey = async (email) => 'a:u:' + (await (await R.load('http.mjs')).sha256hex(email)).slice(0, 32);

// 16kHz・モノラル・16 ビットの WAV の頭を書き換えた写し（嘘の頭・ほかの形を作る）
function wavWith(sec, { rate, channels, byteRate, blockAlign, bits, format, dataLen, riff } = {}) {
  const b = Buffer.from(R.wav(sec));
  if (riff !== undefined) b.write(riff, 0, 'ascii');
  if (format !== undefined) b.writeUInt16LE(format, 20);
  if (channels !== undefined) b.writeUInt16LE(channels, 22);
  if (rate !== undefined) b.writeUInt32LE(rate, 24);
  if (byteRate !== undefined) b.writeUInt32LE(byteRate, 28);
  if (blockAlign !== undefined) b.writeUInt16LE(blockAlign, 32);
  if (bits !== undefined) b.writeUInt16LE(bits, 34);
  if (dataLen !== undefined) b.writeUInt32LE(dataLen, 40);
  return new Uint8Array(b.buffer, b.byteOffset, b.length);
}

// 中継の場面: 偽の OpenAI（mode）と偽の Access を 127.0.0.1 に立て、中継の env の宛先と会社の鍵を合わせる
async function scene({ env = {}, mode = 'text', stt: sttOpts = {}, start = T0 } = {}, fn) {
  const key = 'sk-test-' + crypto.randomBytes(12).toString('hex');
  const stt = await startFakeStt({ mode, key, text: SAID, ...sttOpts });
  const fa = await startFakeAccess();
  try {
    await R.withRelay({ access: fa, env: { OPENAI_API_KEY: key, OPENAI_BASE: stt.base, ...env }, start }, async (ctx) => {
      const secrets = new Set([key, HINT, enc(HINT), SAID, fa.teamDomain, fa.aud]);
      const heads = [];
      let calls = 0;
      const api = {
        // 偽の Access が署名した JWT（試しの時計で。作った JWT・署名・メールは記録に出てはいけない秘密に足す）
        async sign(claims = {}, opts = {}) {
          const t = await fa.sign(claims, { now: ctx.clock.now(), ...opts });
          secrets.add(t); secrets.add(t.split('.')[2]);
          if (typeof claims.email === 'string') secrets.add(claims.email);
          return t;
        },
        // ログインした人の JWT（30 日もつ。日をまたぐ場面のため）。/v1/me を1回開いて確かめ、鍵の写しも温める
        // （後で globalThis.fetch や AbortSignal.timeout を包む場面に、鍵の口への取りに行きが混ざらないように）
        async login(local = 'stt.user') {
          const email = R.mail(local);
          const token = await api.sign({ email, exp: Math.floor(ctx.clock.now() / 1000) + 30 * 86400 });
          const me = await ctx.call('GET', '/v1/me', { jwt: token });
          assert.strictEqual(me.status, 200, 'login の JWT が通らない: ' + await me.text());
          return { token, email };
        },
        // language・prompt・type は null なら、その見出しを付けない。token は Cf-Access-Jwt-Assertion の見出しで送る
        // 0.9.4 S-6: アプリは WAV を Content-Length 付きで送る（stream でないときは既定で付ける）。length: false で付けない（前の版の送り方）
        async send(token, wav, { language = 'ja', prompt = HINT, headers = {}, query = '', stream = false, type = 'audio/wav', length = stream ? undefined : true, hold, pulls } = {}) {
          calls += 1;
          const h = { ...headers };
          if (token !== undefined) h['cf-access-jwt-assertion'] = token;
          if (type !== null) h['content-type'] = type;
          if (language !== null) h['x-natsu-language'] = language;
          if (prompt !== null) { h['x-natsu-prompt'] = enc(prompt); if (prompt.trim()) secrets.add(prompt); }
          const res = await ctx.call('POST', PATH + query, { headers: h, body: wav, stream, ip: '192.0.2.20', length, hold, pulls });
          const text = await res.text();
          let body = null;
          try { body = JSON.parse(text); } catch (_) { body = null; }
          assert.ok(body && typeof body === 'object', '答えが JSON でない: ' + text.slice(0, 80));
          assert.strictEqual(res.headers.get('content-type'), 'application/json; charset=utf-8');
          assert.strictEqual(res.headers.get('cache-control'), 'no-store');
          for (const [k, v] of res.headers) heads.push(k + ': ' + v);
          if (res.status !== 200) {
            const k = Object.keys(body).sort().join(',');
            assert.ok(['error', 'error,retryAfter', 'error,retryAfter,scope'].includes(k), '失敗の答えの欄: ' + k);
          }
          return { status: res.status, body, headers: res.headers };
        },
        // send を通さずに中継を呼んだ回数（記録の行の数の照らしのため）
        counted() { calls += 1; },
      };
      await fn({ ...ctx, stt, fa, key, ...api });
      // 場面の中で落ちたときは、ここに来ない（下の照らしで元の誤りを隠さない）
      for (const r of stt.requests) for (const v of Object.values(r.fields)) if (v.length > 4) secrets.add(v);
      for (const t of TABLES) for (const row of await rowsOf(ctx.db, `SELECT * FROM ${t}`)) ALL.rows.push(JSON.stringify(row));
      const parsed = ctx.logs.map((l) => JSON.parse(l));
      for (const p of parsed) {
        for (const k of Object.keys(p)) assert.ok(KEYS.has(k), `記録に決まりの外の欄 ${k}`);
        if (p.ev === 'stt') {
          for (const k of Object.keys(p)) assert.ok(STT_KEYS.has(k), `stt の記録に ${k}`);
          ALL.results.add(p.st + ':' + p.r);
        }
      }
      assert.strictEqual(parsed.filter((p) => p.ev === 'stt').length, calls, 'stt の1回に記録が1行でない');
      const text = ctx.logs.join('\n') + '\n' + heads.join('\n');
      for (const s of secrets) assert.ok(!text.includes(s), `記録か答えの見出しに ${s.slice(0, 12)}…`);
      for (const { key: k } of await rowsOf(ctx.db, 'SELECT key FROM counters')) assert.match(k, COUNTER_KEY, '数えの鍵にメールか IP');
      ALL.scenes += 1;
      ALL.logs.push(...ctx.logs);
      ALL.heads.push(...heads);
      for (const s of secrets) ALL.secrets.add(s);
    });
  } finally {
    await stt.close();
    await fa.close();
  }
}

test('RL7: ログインした JWT で WAV を送ると、中継は会社の鍵とモデルを付けて OpenAI の形で送り、{ text } だけを返す', { timeout: 5000 }, async () => {
  await scene({}, async ({ login, send, stt, db }) => {
    const a = await login();
    const r = await send(a.token, R.wav(2));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body, { text: SAID + '区間1' });
    assert.strictEqual(stt.requests.length, 1);
    const q = stt.requests[0];
    assert.strictEqual(q.method, 'POST');
    assert.strictEqual(q.path, '/openai/v1/audio/transcriptions');
    assert.strictEqual(q.authOk, true, 'Authorization が Bearer <会社の鍵> でない・ほかの見出しに鍵');
    assert.deepStrictEqual(q.fields, { model: 'gpt-4o-transcribe', language: 'ja', prompt: HINT, response_format: 'json', temperature: '0' });
    assert.strictEqual(q.wavOk, true);
    assert.strictEqual(q.fileName, 'segment.wav');
    assert.strictEqual(q.fileType, 'audio/wav');
    // 秒は 200 の区間だけ数える（1人と全体）
    assert.strictEqual(await used(db, await userKey(a.email)), 2);
    assert.strictEqual(await used(db, 'a:all'), 2);
    // ヒントと言語が無ければ、その欄を送らない（言語は自動）
    const b = await send(a.token, R.wav(1), { language: null, prompt: null });
    assert.strictEqual(b.status, 200);
    assert.deepStrictEqual(stt.requests[1].fields, { model: 'gpt-4o-transcribe', response_format: 'json', temperature: '0' });
    // Content-Type の後ろに付けた値は受ける（audio/wav で始まる）
    assert.strictEqual((await send(a.token, R.wav(1), { type: 'audio/wav; codecs=1' })).status, 200);
  });
});

test('RF34: 客はモデルも欄も差し込めない（見出し・問い合わせの文字・言語の見出しの混ぜ物）。STT_MODEL ならそれ', { timeout: 5000 }, async () => {
  await scene({}, async ({ login, send, stt }) => {
    const a = await login();
    const tries = [
      { headers: { 'x-natsu-model': 'whisper-1', 'x-natsu-response-format': 'verbose_json', 'x-natsu-temperature': '1' } },
      { query: '?model=whisper-1&response_format=verbose_json' },
      // 見出しに改行は入れられない（Headers が断る）ので、区切りの文字と空白で混ぜる
      { language: 'ja; model=whisper-1' },
      { language: 'ja model' },
      { language: 'ja,en' },
      { language: 'JA' },
      { language: 'japanese' },
      { language: 'en' },
    ];
    for (const t of tries) assert.strictEqual((await send(a.token, R.wav(1), t)).status, 200, JSON.stringify(t));
    assert.strictEqual(stt.requests.length, tries.length);
    const langs = stt.requests.map((q) => q.fields.language);
    assert.deepStrictEqual(langs, ['ja', 'ja', undefined, undefined, undefined, undefined, undefined, 'en']);
    for (const q of stt.requests) {
      assert.strictEqual(q.fields.model, 'gpt-4o-transcribe');
      assert.strictEqual(q.fields.response_format, 'json');
      assert.strictEqual(q.fields.temperature, '0');
      assert.deepStrictEqual(Object.keys(q.fields).filter((k) => !['model', 'language', 'prompt', 'response_format', 'temperature'].includes(k)), []);
    }
  });
  await scene({ env: { STT_MODEL: 'gpt-4o-mini-transcribe' } }, async ({ login, send, stt }) => {
    const a = await login();
    assert.strictEqual((await send(a.token, R.wav(1), { headers: { 'x-natsu-model': 'whisper-1' } })).status, 200);
    assert.strictEqual(stt.requests[0].fields.model, 'gpt-4o-mini-transcribe');
  });
});

// 第1d回 W-6 で意図して変えた: 札（取り消し・30 日の期限は中継の札の表のもの）を Access の JWT にした。取り消しとログインの長さは
// Access の側（Zero Trust の Revoke・決まりのログインの長さ）。止めたメールは 401 login でなく 403 denied（W-5 の requireAccess）
test('RL7: JWT が無い・違う・切れた → 401 login、止めたメール → 403 denied。OpenAI へは1回も送らない・秒も数えない', { timeout: 5000 }, async () => {
  await scene({}, async ({ login, sign, send, stt, db, clock }) => {
    const a = await login('gone.user');
    const c = await login('blocked.user');
    const short = await sign({ email: R.mail('short.user'), exp: Math.floor(clock.now() / 1000) + 60 });
    const cases = [
      [undefined, 'JWT が無い'],
      ['', '空の JWT'],
      ['nt1_' + 'A'.repeat(43), '札の形'],
      [await sign({}, { key: 'stray' }), '署名の違う JWT'],
      [a.token.slice(0, -2) + (a.token.endsWith('AA') ? 'BB' : 'AA'), '署名の2字違う JWT'],
      [await sign({ email: R.mail('old.user'), exp: Math.floor(clock.now() / 1000) - 1 }), '切れた JWT'],
    ];
    for (const [token, why] of cases) {
      const r = await send(token, R.wav(1));
      assert.strictEqual(r.status, 401, why);
      assert.deepStrictEqual(r.body, { error: 'login' }, why);
    }
    await db.prepare('INSERT INTO blocked_emails (email, at) VALUES (?1, ?2)').bind(c.email, 1).run();
    const b = await send(c.token, R.wav(1));
    assert.strictEqual(b.status, 403, '止めたメール');
    assert.deepStrictEqual(b.body, { error: 'denied' }, '止めたメール');
    clock.advance(61 * S);
    assert.deepStrictEqual((await send(short, R.wav(1))).body, { error: 'login' }, '送る前に切れた JWT');
    assert.strictEqual(stt.requests.length, 0, 'OpenAI へ送った');
    assert.deepStrictEqual(await rowsOf(db, "SELECT key FROM counters WHERE key LIKE 'a:%'"), []);
    // 切れていない JWT は通る（同じ場面で、ほかの理由で断っていないことを見る）
    assert.strictEqual((await send(a.token, R.wav(1))).status, 200);
  });
});

// 0.9.4 S-6 で意図して分けた: Content-Length のある本文（アプリの送り方）は上限を越えれば読まずに 413（流す道）、無い本文（前の版の送り方）は今どおり読みながら 413（貯める道）
test('RF34: 大きさの上限は Content-Length のある本文なら読まずに 413、無い本文なら読みながら 413。WAV でない・アプリの録音の形でない WAV は 415。どれも OpenAI へ送らない', { timeout: 5000 }, async () => {
  await scene({ env: { MAX_AUDIO_BYTES: String(44 + 3 * 32000) } }, async ({ login, send, stt, db }) => {
    const a = await login();
    assert.strictEqual((await send(a.token, R.wav(3))).status, 200, 'ちょうど上限は通る');
    for (const stream of [false, true]) {
      const r = await send(a.token, R.wav(3.5), { stream });
      assert.strictEqual(r.status, 413, 'stream ' + stream);
      assert.deepStrictEqual(r.body, { error: 'too-large' });
    }
    // 中継の上限は既定（25MB − 4KB）より上げられない
    const bad = [
      [new TextEncoder().encode('これは音声ではない'), 'WAV でない'],
      [new Uint8Array(0), '空'],
      [R.wav(0), 'data が空'],
      [wavWith(1, { riff: 'RIFX' }), 'RIFF でない'],
      [wavWith(1, { rate: 48000, byteRate: 96000 }), '48kHz'],
      [wavWith(1, { channels: 2, byteRate: 64000, blockAlign: 4 }), 'ステレオ'],
      [wavWith(1, { byteRate: 64000 }), 'byteRate だけを大きく書いた嘘の頭'],
      [wavWith(1, { bits: 8, blockAlign: 1, byteRate: 16000 }), '8 ビット'],
      [wavWith(1, { format: 3 }), 'PCM でない（浮動小数）'],
      // 1つの欄だけを変え、byteRate 32000・blockAlign 2 はそのままの嘘の頭（OpenAI は頭の値で読むので、
      // 8000Hz なら届いたバイト数で数えた秒の 2 倍、1000Hz なら 32 倍、8 ビットなら 2 倍を払うことになる）
      [wavWith(1, { rate: 8000 }), '8kHz と書いた頭（ほかは 16kHz のまま）'],
      [wavWith(1, { rate: 1000 }), '1kHz と書いた頭（ほかは 16kHz のまま）'],
      [wavWith(1, { channels: 2 }), '2 チャンネルと書いた頭（ほかはモノラルのまま）'],
      [wavWith(1, { bits: 8 }), '8 ビットと書いた頭（ほかは 16 ビットのまま）'],
      [wavWith(1, { blockAlign: 4 }), 'blockAlign だけを 4 と書いた頭'],
      [R.wav(1).slice(0, 40), '頭が途中で切れた'],
    ];
    for (const [wav, why] of bad) {
      const r = await send(a.token, wav);
      assert.strictEqual(r.status, 415, why);
      assert.deepStrictEqual(r.body, { error: 'not-wav' }, why);
    }
    for (const type of ['application/octet-stream', 'multipart/form-data; boundary=x', 'audio/mpeg', null]) {
      const r = await send(a.token, R.wav(1), { type });
      assert.strictEqual(r.status, 415, String(type));
      assert.deepStrictEqual(r.body, { error: 'not-wav' });
    }
    assert.strictEqual(stt.requests.length, 1, 'OpenAI へ送った');
    assert.strictEqual(await used(db, 'a:all'), 3);
  });
  const { readConfig } = await R.load('config.mjs');
  assert.strictEqual(readConfig({ MAX_AUDIO_BYTES: String(100 * 1024 * 1024) }).maxAudioBytes, 25 * 1024 * 1024 - 4096);
});

test('RF34: 秒は届いたバイト数で数える（WAV の頭の data の長さの嘘で減らせない・切り上げ）', { timeout: 5000 }, async () => {
  const { wavInfo } = await R.load('stt.mjs');
  assert.deepStrictEqual(wavInfo(R.wav(10)), { ok: true, dataBytes: 320000, sec: 10 });
  assert.deepStrictEqual(wavInfo(wavWith(10, { dataLen: 3600 * 32000 })), { ok: true, dataBytes: 320000, sec: 10 });
  assert.deepStrictEqual(wavInfo(wavWith(10, { dataLen: 0 })), { ok: true, dataBytes: 320000, sec: 10 });
  assert.deepStrictEqual(wavInfo(wavWith(10, { dataLen: 32000 })), { ok: true, dataBytes: 320000, sec: 10 });
  assert.deepStrictEqual(wavInfo(R.wav(0.01)), { ok: true, dataBytes: 320, sec: 1 });
  assert.deepStrictEqual(wavInfo(R.wav(10.5)), { ok: true, dataBytes: 336000, sec: 11 });
  assert.strictEqual(wavInfo(wavWith(1, { rate: 8000, byteRate: 16000 })).ok, false);
  // 1つの欄だけの嘘（byteRate と blockAlign は合ったまま）も断る。どれも、その欄の照らしだけが断る
  for (const o of [{ rate: 8000 }, { rate: 1000 }, { rate: 48000 }, { channels: 2 }, { channels: 0 }, { bits: 8 }, { bits: 32 }, { blockAlign: 4 }, { byteRate: 64000 }, { format: 3 }]) {
    assert.deepStrictEqual(wavInfo(wavWith(1, o)), { ok: false }, JSON.stringify(o));
  }
  await scene({}, async ({ login, send, db, logs }) => {
    const a = await login();
    assert.strictEqual((await send(a.token, wavWith(10, { dataLen: 3600 * 32000 }))).status, 200);
    assert.strictEqual(await used(db, 'a:all'), 10, 'data の長さを 1 時間と書いた 10 秒');
    assert.strictEqual((await send(a.token, wavWith(10, { dataLen: 0 }))).status, 200);
    assert.strictEqual(await used(db, 'a:all'), 20, 'data の長さを 0 と書いた 10 秒');
    assert.strictEqual(await used(db, await userKey(a.email)), 20);
    const secs = logs.map((l) => JSON.parse(l)).filter((p) => p.ev === 'stt').map((p) => p.sec);
    assert.deepStrictEqual(secs, [10, 10]);
  });
});

test('RF34: 同時の要求でも1日の上限を越えない（1人の秒・全体の秒。送る前に取り置く）', { timeout: 5000 }, async () => {
  await scene({ env: { DAILY_USER_SEC: '100' } }, async ({ login, send, stt, db }) => {
    const a = await login();
    const rs = await Promise.all(Array.from({ length: 5 }, () => send(a.token, R.wav(60))));
    const ok = rs.filter((r) => r.status === 200);
    assert.strictEqual(ok.length, 1, rs.map((r) => r.status).join(','));
    for (const r of rs.filter((x) => x.status !== 200)) {
      assert.strictEqual(r.status, 429);
      assert.deepStrictEqual(r.body, { error: 'daily-cap', scope: 'user', retryAfter: TO_DAY_END });
    }
    assert.strictEqual(stt.requests.length, 1, '偽の OpenAI に届いた数');
    assert.strictEqual(await used(db, await userKey(a.email)), 60, '断った分の秒が残っている');
    assert.strictEqual(await used(db, 'a:all'), 60);
  });
  await scene({ env: { DAILY_ALL_SEC: '100' } }, async ({ login, send, stt, db }) => {
    const people = await Promise.all(Array.from({ length: 5 }, (_, i) => login('all.user' + i)));
    const rs = await Promise.all(people.map((p) => send(p.token, R.wav(60))));
    assert.strictEqual(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(','));
    for (const r of rs.filter((x) => x.status !== 200)) {
      assert.strictEqual(r.status, 429);
      assert.deepStrictEqual(r.body, { error: 'daily-cap', scope: 'all', retryAfter: TO_DAY_END });
    }
    assert.strictEqual(stt.requests.length, 1);
    assert.strictEqual(await used(db, 'a:all'), 60);
  });
});

test('RF34: 1日の上限（1人・全体）は 429 daily-cap と日本の日付の替わりまでの retryAfter。数えるのは 200 の区間だけ。日が替われば通る', { timeout: 5000 }, async () => {
  await scene({ env: { DAILY_USER_SEC: '100', DAILY_ALL_SEC: '150' } }, async ({ login, send, stt, db, env, clock, key }) => {
    const fails = await Promise.all(['401', '429', '500', 'drop'].map((mode) => startFakeStt({ mode, key, retryAfter: '3' })));
    try {
      const a = await login('cap.user');
      const b = await login('cap.other');
      // 失敗の区間（偽の OpenAI が 401・429・500・切れた）は秒を数えない
      for (const f of fails) {
        env.OPENAI_BASE = f.base;
        const r = await send(a.token, R.wav(60));
        assert.notStrictEqual(r.status, 200, f.base);
      }
      assert.ok(fails.every((f) => f.requests.length === 1), '失敗の偽物に届いていない');
      assert.strictEqual(await used(db, await userKey(a.email)), 0, '失敗の区間の秒を数えた');
      assert.strictEqual(await used(db, 'a:all'), 0);
      env.OPENAI_BASE = stt.base;
      assert.strictEqual((await send(a.token, R.wav(60))).status, 200);
      assert.strictEqual((await send(a.token, R.wav(40))).status, 200, 'ちょうど 100 秒は通る');
      const r = await send(a.token, R.wav(1));
      assert.strictEqual(r.status, 429);
      assert.deepStrictEqual(r.body, { error: 'daily-cap', scope: 'user', retryAfter: TO_DAY_END });
      assert.strictEqual(r.headers.get('retry-after'), String(TO_DAY_END));
      // 全体: ほかの人は 50 秒まで（150 − 100）
      assert.strictEqual((await send(b.token, R.wav(50))).status, 200);
      const c = await send(b.token, R.wav(1));
      assert.deepStrictEqual(c.body, { error: 'daily-cap', scope: 'all', retryAfter: TO_DAY_END });
      assert.strictEqual(stt.requests.length, 3, '上限の後に OpenAI へ送った');
      assert.strictEqual(await used(db, 'a:all'), 150);
      // 日本の日付の替わり（UTC の 15 時）の 1 秒前はまだ止まり、替われば通る
      clock.advance((TO_DAY_END - 1) * S);
      assert.deepStrictEqual((await send(a.token, R.wav(1))).body, { error: 'daily-cap', scope: 'user', retryAfter: 1 });
      clock.advance(1 * S);
      assert.strictEqual((await send(a.token, R.wav(30))).status, 200, '日が替わっても通らない');
      assert.strictEqual(await used(db, await userKey(a.email)), 30);
      assert.strictEqual(await used(db, 'a:all'), 30);
    } finally {
      await Promise.all(fails.map((f) => f.close()));
    }
  });
});

test('RF34: もう上限に達していれば、本文を読まずに 429（25MB を読ませて CPU を使わせない）', { timeout: 5000 }, async () => {
  await scene({ env: { DAILY_USER_SEC: '10' } }, async ({ login, send, env, clock, ctx, counted }) => {
    const a = await login();
    assert.strictEqual((await send(a.token, R.wav(10))).status, 200);
    const { makeHandler } = await R.load('worker.mjs');
    let pulled = 0;
    const body = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(R.wav(1)); c.close(); } }, { highWaterMark: 0 });
    const req = new Request('https://relay.test' + PATH, {
      method: 'POST', body, duplex: 'half',
      headers: { 'cf-access-jwt-assertion': a.token, 'content-type': 'audio/wav', 'x-natsu-language': 'ja' },
    });
    counted();
    const res = await makeHandler({ now: clock.now }).fetch(req, env, ctx);
    assert.strictEqual(res.status, 429);
    assert.deepStrictEqual(await res.json(), { error: 'daily-cap', scope: 'user', retryAfter: TO_DAY_END });
    assert.strictEqual(pulled, 0, '上限の後に本文を読んだ');
  });
});

test('RL7: 答えの分け方（OpenAI の 429 の retry-after をそのまま・鍵の誤りは 502 upstream-auth で中継の 401 と分ける・残高切れは 503 quota）', { timeout: 5000 }, async () => {
  const table = [
    [{ mode: '429', retryAfter: '7', times: 99 }, 429, { error: 'busy', retryAfter: 7 }, '7'],
    [{ mode: '429', retryAfter: '', times: 99 }, 429, { error: 'busy', retryAfter: 2 }, '2'],
    [{ mode: '429', retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT', times: 99 }, 429, { error: 'busy', retryAfter: 2 }, '2'],
    [{ mode: '429-long' }, 429, { error: 'busy', retryAfter: 3600 }, '3600'],
    [{ mode: 'quota' }, 503, { error: 'quota' }],
    [{ mode: '401' }, 502, { error: 'upstream-auth' }],
    [{ mode: '403' }, 502, { error: 'upstream-auth' }],
    [{ mode: '500' }, 502, { error: 'upstream' }],
    [{ mode: 'drop' }, 502, { error: 'upstream' }],
    [{ mode: 'badjson' }, 502, { error: 'upstream' }],
    [{ mode: '400-prompt' }, 400, { error: 'bad-request' }],
    [{ mode: '400' }, 400, { error: 'bad-request' }],
    [{ mode: '413' }, 413, { error: 'too-large' }],
  ];
  const wrongKey = await startFakeStt({ key: 'sk-test-other' });
  try {
    await scene({}, async ({ login, send, env, db, key }) => {
      const a = await login();
      for (let i = 0; i < table.length; i++) {
        // 偽物の鍵を中継の鍵に合わせる（401 の行のほかは鍵が合う）
        const f = await startFakeStt({ key, ...table[i][0] });
        try {
          env.OPENAI_BASE = f.base;
          const r = await send(a.token, R.wav(2));
          assert.strictEqual(r.status, table[i][1], JSON.stringify(table[i][0]) + ' ' + JSON.stringify(r.body));
          assert.deepStrictEqual(r.body, table[i][2], JSON.stringify(table[i][0]));
          assert.strictEqual(r.headers.get('retry-after'), table[i][3] === undefined ? null : table[i][3], JSON.stringify(table[i][0]));
          assert.strictEqual(f.requests.length, 1);
        } finally { await f.close(); }
      }
      // 400-prompt でもヒントが無ければ文字（アプリはヒントを外して送り直す: F15）
      const f = await startFakeStt({ key, mode: '400-prompt' });
      try {
        env.OPENAI_BASE = f.base;
        assert.strictEqual((await send(a.token, R.wav(2), { prompt: null })).status, 200);
      } finally { await f.close(); }
      assert.strictEqual(await used(db, 'a:all'), 2, '失敗の区間の秒を数えた');
      // 偽物の鍵が違えば（会社の鍵を OpenAI が断った）upstream-auth
      env.OPENAI_BASE = wrongKey.base;
      assert.deepStrictEqual((await send(a.token, R.wav(1))).body, { error: 'upstream-auth' });
    });
  } finally {
    await wrongKey.close();
  }
});

test('RL7: 秘密がそろわなければ 503 not-ready・方法が違えば 405・ヒントの見出しが大きい／戻せなければ 400', { timeout: 5000 }, async () => {
  await scene({ env: { OPENAI_API_KEY: undefined } }, async ({ login, send, stt }) => {
    const a = await login();
    const r = await send(a.token, R.wav(1));
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(r.body, { error: 'not-ready' });
    assert.strictEqual(stt.requests.length, 0);
  });
  await scene({}, async ({ login, send, stt, call }) => {
    const a = await login();
    const g = await call('GET', PATH, { jwt: a.token });
    assert.strictEqual(g.status, 405);
    assert.deepStrictEqual(await g.json(), { error: 'method' });
    // 見出しの文字のまま 9,000 バイトまで・戻して 1,000 字まで（「見」は戻す前の 9 バイト）
    assert.strictEqual((await send(a.token, R.wav(1), { prompt: '見'.repeat(1000) })).status, 200, '1,000 字・9,000 バイト');
    const bad = [
      [{ prompt: '見'.repeat(1001) }, '9,009 バイト'],
      // 字の数は 1,000 より少ないが、見出しの文字では 9,000 バイトを越える（𠮷 は戻す前の 12 バイト）
      [{ prompt: '𠮷'.repeat(751) }, '751 字・9,012 バイト'],
      [{ prompt: 'a'.repeat(1001) }, '1,001 字'],
      [{ prompt: null, headers: { 'x-natsu-prompt': '%E8%A6%8' } }, '戻せない'],
      [{ prompt: null, headers: { 'x-natsu-prompt': '%' } }, '戻せない %'],
    ];
    for (const [o, why] of bad) {
      const r = await send(a.token, R.wav(1), o);
      assert.strictEqual(r.status, 400, why);
      assert.deepStrictEqual(r.body, { error: 'bad-request' }, why);
    }
    assert.strictEqual(stt.requests.length, 1);
    assert.strictEqual(stt.requests[0].fields.prompt, '見'.repeat(1000));
    // 絵文字や 𠮷 も UTF-8 のまま OpenAI へ
    assert.strictEqual((await send(a.token, R.wav(1), { prompt: '𠮷野の議事録' })).status, 200);
    assert.strictEqual(stt.requests[1].fields.prompt, '𠮷野の議事録');
    // ちょうど 9,000 バイト（750 字）は通る
    assert.strictEqual(enc('𠮷'.repeat(750)).length, 9000);
    assert.strictEqual((await send(a.token, R.wav(1), { prompt: '𠮷'.repeat(750) })).status, 200, '750 字・9,000 バイト');
    assert.strictEqual(stt.requests[2].fields.prompt, '𠮷'.repeat(750));
  });
});

// 第1d回 W-6 で意図して変えた: Resend の道を消したので、名前と場面から「偽の Resend の見出しにも鍵が無い」を外した
test('RF38: OpenAI の鍵を OpenAI のほかへは送らない（OPENAI_BASE が 127.0.0.1 の形でなければ本物の固定の URL・転送について行かない）', { timeout: 5000 }, async () => {
  for (const base of ['https://127.0.0.1:9/v1', 'http://192.0.2.1:8080/v1', 'http://127.0.0.1.example.org:80/v1', 'http://localhost:8080/v1', '']) {
    await scene({ env: { OPENAI_BASE: base } }, async ({ login, send, stt, db, key }) => {
      const a = await login();
      const seen = [];
      const inner = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const u = typeof input === 'string' ? input : input.url;
        const h = new Headers(init && init.headers);
        seen.push({ url: u, auth: h.get('authorization') });
        return inner(input, init);
      };
      let r;
      try { r = await send(a.token, R.wav(1)); } finally { globalThis.fetch = inner; }
      assert.strictEqual(r.status, 502, base);
      assert.deepStrictEqual(r.body, { error: 'upstream' });
      assert.deepStrictEqual(seen, [{ url: 'https://api.openai.com/v1/audio/transcriptions', auth: 'Bearer ' + key }], base);
      assert.strictEqual(stt.requests.length, 0);
      assert.strictEqual(await used(db, 'a:all'), 0);
    });
  }
  // OpenAI の宛先が転送（307）を返しても、ついて行かない（鍵と音声を転送の先へ運ばない）。
  // Node の fetch はバイトの本文を転送の先へ送り直せずに投げるので、答えだけでは転送を追ったかが見えない。
  // だから fetch に渡した redirect も見る（Workers の fetch は既定で転送について行き、'error' は受けない）
  await scene({}, async ({ login, send, stt, env, db }) => {
    const a = await login();   // 鍵の口への取りに行き（redirect: 'manual'）を下の modes に混ぜない
    const modes = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (input, init) => { modes.push(init && init.redirect); return inner(input, init); };
    const hops = [];
    const redirector = http.createServer((req, res) => {
      hops.push(req.url);
      req.resume();
      req.on('end', () => { res.writeHead(307, { location: stt.base + '/audio/transcriptions' }); res.end(); });
    });
    await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
    try {
      env.OPENAI_BASE = `http://127.0.0.1:${redirector.address().port}/v1`;
      const r = await send(a.token, R.wav(1));
      assert.strictEqual(r.status, 502);
      assert.deepStrictEqual(r.body, { error: 'upstream' });
      assert.deepStrictEqual(hops, ['/v1/audio/transcriptions']);
      assert.strictEqual(stt.requests.length, 0, '転送の先へ送った');
      assert.strictEqual(await used(db, 'a:all'), 0);
      assert.deepStrictEqual(modes, ['manual'], '転送について行く fetch（Workers は error を受けないので manual。3xx は 502 upstream）');
    } finally {
      globalThis.fetch = inner;
      await new Promise((r) => { redirector.close(() => r()); redirector.closeAllConnections(); });
    }
  });
});

test('RF34: OpenAI が答えないままなら 120 秒で切って 502 upstream、取り置いた秒を戻す（Worker の要求を開いたままにしない）', { timeout: 5000 }, async () => {
  // 本物の 120 秒は待てないので、AbortSignal.timeout に渡した長さを覚え、実際には 50 ミリ秒で切る
  // （第1d回 W-6: 包むのはログインの後。ログインの /v1/me の鍵の口への取りに行きの 5 秒を asked に混ぜない）
  const asked = [];
  const real = AbortSignal.timeout;
  const hung = [];
  const silent = http.createServer((req) => { hung.push(req.url); req.resume(); });
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  // 時間切れが無ければ、2 秒後にこちらから切る（そのときは時間で赤にする）
  const guard = setTimeout(() => silent.closeAllConnections(), 2000);
  try {
    await scene({}, async ({ login, send, env, db }) => {
      env.OPENAI_BASE = `http://127.0.0.1:${silent.address().port}/v1`;
      const a = await login();
      AbortSignal.timeout = (ms) => { asked.push(ms); return real.call(AbortSignal, 50); };
      const inits = [];
      const inner = globalThis.fetch;
      globalThis.fetch = (input, init) => { inits.push(init || {}); return inner(input, init); };
      const t0 = Date.now();
      let r;
      try { r = await send(a.token, R.wav(3)); } finally { globalThis.fetch = inner; }
      const took = Date.now() - t0;
      assert.ok(took < 1500, `答えない OpenAI を ${took} ミリ秒待った（時間切れが効いていない）`);
      assert.strictEqual(r.status, 502);
      assert.deepStrictEqual(r.body, { error: 'upstream' });
      assert.deepStrictEqual(hung, ['/v1/audio/transcriptions']);
      assert.strictEqual(inits.length, 1);
      assert.ok(inits[0].signal instanceof AbortSignal, 'OpenAI への fetch に時間切れが無い');
      assert.strictEqual(inits[0].redirect, 'manual');   // Workers は 'error' を受けない（relay-workers-compat.test.js）
      assert.strictEqual(await used(db, await userKey(a.email)), 0, '切れた区間の秒を戻していない');
      assert.strictEqual(await used(db, 'a:all'), 0);
    });
  } finally {
    clearTimeout(guard);
    AbortSignal.timeout = real;
    await new Promise((r) => { silent.close(() => r()); silent.closeAllConnections(); });
  }
  assert.deepStrictEqual(asked, [120000], 'OpenAI の時間切れが 120 秒でない');
});

// 第1d回 W-6: 古い窓の片付けは /auth/start がしていた。/auth/start を消したので、文字起こしの取り置きの batch で続ける
// （日本の日付の番号で、おととい（2 日前）までの日の行は残し、それより前の日の行を消す。今の日・きのうの行と a:all は消さない）
test('RL7: 2 日より前の窓の counters の行は、文字起こしの取り置きのときに消える', { timeout: 5000 }, async () => {
  const L = await R.load('limits.mjs');
  const day = L.dayNumber(T0 / 1000, 540);
  const DAYSEC = 86400;
  const other = (n) => 'a:u:' + String(n).repeat(32);
  await scene({}, async ({ login, send, db, stt }) => {
    const a = await login();
    const seed = [[other(1), (day - 3) * DAYSEC, 50], [other(2), (day - 2) * DAYSEC - 1, 40], [other(3), (day - 2) * DAYSEC, 30],
      [other(4), (day - 1) * DAYSEC, 20], [other(5), day * DAYSEC, 10]];
    for (const [k, w, n] of seed) await db.prepare('INSERT INTO counters (key, win, n) VALUES (?1, ?2, ?3)').bind(k, w, n).run();
    // 断った要求（JWT が無い・WAV でない）では片付けない（取り置きのときだけ書く）
    assert.strictEqual((await send(undefined, R.wav(1))).status, 401);
    assert.strictEqual((await send(a.token, new Uint8Array(10))).status, 415);
    assert.strictEqual((await rowsOf(db, 'SELECT key FROM counters')).length, 5, '取り置きの前に片付けた');
    assert.strictEqual((await send(a.token, R.wav(2))).status, 200);
    const rows = await rowsOf(db, 'SELECT key, win, n FROM counters ORDER BY key');
    assert.deepStrictEqual(rows, [
      { key: 'a:all', win: day * DAYSEC, n: 2 },
      { key: other(3), win: (day - 2) * DAYSEC, n: 30 },
      { key: other(4), win: (day - 1) * DAYSEC, n: 20 },
      { key: other(5), win: day * DAYSEC, n: 10 },
      { key: await userKey(a.email), win: day * DAYSEC, n: 2 },
    ].sort((x, y) => (x.key < y.key ? -1 : 1)));
    assert.strictEqual(stt.requests.length, 1);
  });
  // 上限で断った（取り置けなかった）ときも、取り置きの batch は流れるので片付く。数えは戻る
  await scene({ env: { DAILY_USER_SEC: '1' } }, async ({ login, send, db }) => {
    const a = await login();
    await db.prepare('INSERT INTO counters (key, win, n) VALUES (?1, ?2, ?3)').bind(other(6), (day - 5) * DAYSEC, 9).run();
    const r = await send(a.token, R.wav(2));
    assert.strictEqual(r.status, 429);
    assert.deepStrictEqual(await rowsOf(db, 'SELECT key FROM counters WHERE key = ?1', other(6)), []);
    assert.strictEqual(await used(db, await userKey(a.email)), 0);
  });
});

test('limits: 日の番号・日の替わりまでの秒は日本の日付（DAY_OFFSET_MIN）で数える', { timeout: 5000 }, async () => {
  const L = await R.load('limits.mjs');
  const t = T0 / 1000;
  assert.strictEqual(L.secondsToDayEnd(t, 540), TO_DAY_END);
  assert.strictEqual(L.secondsToDayEnd(t, 0), 23 * 3600);
  assert.strictEqual(L.dayNumber(t, 540), L.dayNumber(t + TO_DAY_END - 1, 540));
  assert.strictEqual(L.dayNumber(t + TO_DAY_END, 540), L.dayNumber(t, 540) + 1);
  assert.strictEqual(L.secondsToDayEnd(t + TO_DAY_END, 540), 86400);
  assert.strictEqual(L.secondsToDayEnd(t + TO_DAY_END - 1, 540), 1);
});

// ---------------------------------------------------------------- 0.9.4 S-6（決めたこと 23〜28）: 中継は本文を貯めずに流す
const MB = 1024 * 1024;
const sttLog = (logs) => logs.map((l) => JSON.parse(l)).filter((p) => p.ev === 'stt');

test('S8: Content-Length のある本文は、全部読む前に OpenAI へ流し始める（アプリの側の流れは、偽の OpenAI が 1 MB を受けたと言うまで最後の塊を出さない。4 MB の WAV で 5 秒以内に 200）', { timeout: 5000 }, async () => {
  await scene({}, async ({ login, send, stt, logs }) => {
    const a = await login();
    const w = R.wav(131);   // 約 4 MB
    let late = false;
    const hold = async () => {
      const until = Date.now() + 3000;
      while (stt.received() < MB && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      if (stt.received() < MB) late = true;
    };
    const t0 = Date.now();
    const r = await send(a.token, w, { stream: true, length: true, hold });
    assert.strictEqual(late, false, '中継が本文を全部読むまで OpenAI へ送らなかった（貯めている）');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(Date.now() - t0 < 5000);
    assert.strictEqual(stt.requests[0].fileSha, crypto.createHash('sha256').update(w).digest('hex'), '本文がバイトどおりでない');
    assert.deepStrictEqual(sttLog(logs).map((l) => [l.st, l.v, l.sec]), [[200, 'stream', 131]]);
  });
});

test('S8: 流す道の OpenAI の要求は今と同じ multipart（欄の並び・file の名前と型・model は中継の値・言語とヒント）で、本文はバイトどおり', { timeout: 5000 }, async () => {
  await scene({ env: { STT_MODEL: 'whisper-1' } }, async ({ login, send, stt, logs }) => {
    const a = await login();
    const w = R.wav(2);
    const viaStream = await send(a.token, w, { stream: true, length: true, headers: { 'x-natsu-model': 'gpt-4o', model: 'gpt-4o' } });
    const viaBuf = await send(a.token, w, { length: false });
    assert.deepStrictEqual([viaStream.status, viaBuf.status], [200, 200]);
    const [q1, q2] = stt.requests;
    assert.deepStrictEqual(q1.fields, { model: 'whisper-1', language: 'ja', prompt: HINT, response_format: 'json', temperature: '0' });
    assert.deepStrictEqual(q1.fieldOrder, ['model', 'language', 'prompt', 'response_format', 'temperature', 'file']);
    assert.deepStrictEqual([q1.fields, q1.fieldOrder, q1.fileName, q1.fileType, q1.fileSha, q1.authOk, q1.wavOk], [q2.fields, q2.fieldOrder, q2.fileName, q2.fileType, q2.fileSha, q2.authOk, q2.wavOk]);
    assert.strictEqual(q1.fileSha, crypto.createHash('sha256').update(w).digest('hex'));
    assert.deepStrictEqual(sttLog(logs).map((l) => l.v), ['stream', 'buf']);
  });
});

test('S9: Content-Length が maxAudioBytes を越えれば本文を読まずに 413（読み手が 1 回も読まない）・OpenAI へ送らない・秒を数えない。数でない Content-Length は貯める道', { timeout: 5000 }, async () => {
  await scene({ env: { MAX_AUDIO_BYTES: String(44 + 3 * 32000) } }, async ({ login, send, stt, db }) => {
    const a = await login();
    const pulls = { n: 0 };
    const r = await send(a.token, R.wav(4), { stream: true, length: true, pulls });
    assert.deepStrictEqual([r.status, r.body], [413, { error: 'too-large' }]);
    assert.strictEqual(pulls.n, 0, '上限を越える本文を読んだ');
    // 嘘の Content-Length（小さく書いた）でも、届いたバイトが言った長さを越えたら止める（下の S9 の長さの違い）
    assert.strictEqual(stt.requests.length, 0);
    assert.strictEqual(await used(db, 'a:all'), 0);
  });
});

test('S9: 頭が違う（RIFF でない・16000Hz でない・mono でない）なら 415・OpenAI へ送らない・秒を数えない（流す道）', { timeout: 5000 }, async () => {
  await scene({}, async ({ login, send, stt, db, logs }) => {
    const a = await login();
    for (const [w, why] of [[wavWith(2, { riff: 'RIFX' }), 'RIFF でない'], [wavWith(2, { rate: 8000 }), '8kHz'], [wavWith(2, { channels: 2 }), 'ステレオ'],
      [R.wav(2).slice(0, 44), '頭だけ'], [R.wav(2).slice(0, 30), '頭が途中で切れた']]) {
      for (const stream of [false, true]) {
        const r = await send(a.token, w, { stream, length: true });
        assert.deepStrictEqual([r.status, r.body], [415, { error: 'not-wav' }], `${why} stream ${stream}`);
      }
    }
    assert.strictEqual(stt.requests.length, 0);
    assert.strictEqual(await used(db, 'a:all'), 0);
    assert.ok(sttLog(logs).every((l) => l.v === 'stream'), JSON.stringify(sttLog(logs)));
  });
});

test('S9: 本文が Content-Length より短く終わった・長い（偽の要求の作り）→ 400 bad-request・取り置いた秒を戻す（D1 の数が 0）', { timeout: 5000 }, async () => {
  await scene({}, async ({ login, send, db, logs }) => {
    const a = await login();
    const w = R.wav(3);
    for (const [len, why] of [[w.byteLength + 32000, '短い（言った長さより 1 秒少ない）'], [w.byteLength - 32000, '長い（言った長さより 1 秒多い）'], [w.byteLength + 1, '1 バイト短い']]) {
      const r = await send(a.token, w, { stream: true, length: len });
      assert.deepStrictEqual([r.status, r.body], [400, { error: 'bad-request' }], why);
    }
    assert.strictEqual(await used(db, 'a:all'), 0, '取り置いた秒を戻していない');
    assert.strictEqual(await used(db, await userKey(a.email)), 0);
    assert.strictEqual((await send(a.token, w, { stream: true, length: true })).status, 200, '長さの合う本文が通らない');
    assert.strictEqual(await used(db, 'a:all'), 3);
    assert.deepStrictEqual(sttLog(logs).map((l) => [l.st, l.r, l.v]), [[400, 'bad-request', 'stream'], [400, 'bad-request', 'stream'], [400, 'bad-request', 'stream'], [200, 'ok', 'stream']]);
  });
});

test('S9: 秒は Content-Length（＝届いたバイト数）から。WAV の頭の data の長さの嘘で減らせない（流す道）', { timeout: 5000 }, async () => {
  await scene({}, async ({ login, send, db, logs }) => {
    const a = await login();
    assert.strictEqual((await send(a.token, wavWith(10, { dataLen: 32000 }), { stream: true, length: true })).status, 200);
    assert.strictEqual((await send(a.token, wavWith(10, { dataLen: 0 }), { stream: true, length: true })).status, 200);
    assert.strictEqual((await send(a.token, R.wav(10.5), { stream: true, length: true })).status, 200);
    assert.strictEqual(await used(db, 'a:all'), 31);
    assert.deepStrictEqual(sttLog(logs).map((l) => [l.sec, l.v]), [[10, 'stream'], [10, 'stream'], [11, 'stream']]);
  });
});

test('S10: Content-Length の無い本文は今の貯める道（記録の v は buf）。流す道は stream', { timeout: 5000 }, async () => {
  await scene({}, async ({ login, send, logs, stt }) => {
    const a = await login();
    assert.strictEqual((await send(a.token, R.wav(2), { stream: true })).status, 200);
    assert.strictEqual((await send(a.token, R.wav(2), { length: false })).status, 200);
    assert.strictEqual((await send(a.token, R.wav(2), { length: 'abc' })).status, 200, '数でない Content-Length');
    assert.strictEqual((await send(a.token, R.wav(2))).status, 200);
    assert.deepStrictEqual(sttLog(logs).map((l) => l.v), ['buf', 'buf', 'buf', 'stream']);
    assert.strictEqual(stt.requests.length, 4);
  });
});

test('FixedLengthStream があれば使う（globalThis に偽の FixedLengthStream を置いて、長さ total で作られる・duplex を付けない）', { timeout: 5000 }, async () => {
  const { formParts } = await R.load('stt.mjs');
  const made = [];
  const inits = [];
  globalThis.FixedLengthStream = class extends TransformStream { constructor(n) { super(); made.push(n); } };
  try {
    await scene({}, async ({ login, send }) => {
      const a = await login();
      const f = globalThis.fetch;
      globalThis.fetch = (u, init) => { inits.push(init); return f(u, { ...init, duplex: 'half' }); };   // Node の fetch は流れの本文に duplex が要る（Workers は付けない）
      try {
        const w = R.wav(2);
        assert.strictEqual((await send(a.token, w, { stream: true, length: true })).status, 200);
        const { head, tail } = formParts({ model: 'gpt-4o-transcribe', language: 'ja', prompt: HINT, boundary: 'natsu-' + '0'.repeat(36) });
        assert.deepStrictEqual(made, [head.byteLength + w.byteLength + tail.byteLength]);
        assert.strictEqual(inits.length, 1);
        assert.strictEqual('duplex' in inits[0], false, 'Workers の FixedLengthStream に duplex を付けた');
        assert.strictEqual(inits[0].redirect, 'manual');
      } finally { globalThis.fetch = f; }
    });
  } finally { delete globalThis.FixedLengthStream; }
});

test('字面: 流す道（streamUpstream）に readCapped(・buildForm(・arrayBuffer(・本文の長さの new Uint8Array( が無い。relay/ に node: と Buffer が無い。redirect は manual', { timeout: 5000 }, () => {
  const src = require('node:fs').readFileSync(require('node:path').join(R.RELAY_DIR, 'stt.mjs'), 'utf8');
  const i = src.indexOf('export async function streamUpstream(');
  assert.ok(i >= 0, 'streamUpstream が無い');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  for (const bad of ['readCapped(', 'buildForm(', 'arrayBuffer(', 'new Uint8Array(']) assert.ok(!body.includes(bad), `streamUpstream に ${bad}`);
  assert.ok(body.includes("redirect: 'manual'"));
  for (const f of require('node:fs').readdirSync(R.RELAY_DIR).filter((n) => n.endsWith('.mjs'))) {
    const t = require('node:fs').readFileSync(require('node:path').join(R.RELAY_DIR, f), 'utf8');
    assert.ok(!/from 'node:|require\(|\bBuffer\b/.test(t), f);
  }
});

test('F9・RL7: 記録は { ev: stt, st, r, ms, sec } の形だけで、ヒント・文字・札・メール・鍵が無い。D1 のどの行にもヒントと文字が無い（上の全部の場面を合わせて）', { timeout: 5000 }, () => {
  assert.ok(ALL.scenes >= 14, `場面が少ない（${ALL.scenes}）。このテストはファイルの最後に置く`);
  for (const r of ['200:ok', '401:login', '403:denied', '413:too-large', '415:not-wav', '429:daily-cap', '429:busy', '502:upstream-auth', '502:upstream',
    '503:quota', '503:not-ready', '400:bad-request']) {
    assert.ok(ALL.results.has(r), `記録に ${r} の行が無い`);
  }
  for (const l of ALL.logs.map((x) => JSON.parse(x)).filter((p) => p.ev === 'stt')) {
    assert.ok(Number.isInteger(l.st) && typeof l.r === 'string' && Number.isFinite(l.ms) && Number.isInteger(l.sec), JSON.stringify(l));
  }
  const text = ALL.logs.join('\n') + '\n' + ALL.heads.join('\n');
  for (const s of ALL.secrets) assert.ok(!text.includes(s), `記録・見出しに ${s.slice(0, 12)}…`);
  assert.ok(!/example\./i.test(text), '記録・見出しにドメイン');
  assert.ok(!/区間|議題|見積|𠮷/.test(text), '記録・見出しに文字かヒント');
  const rows = ALL.rows.join('\n');
  assert.ok(ALL.rows.length > 20, `D1 の行が少ない（${ALL.rows.length}）`);
  assert.ok(!/区間|議題|見積|予算|𠮷/.test(rows), 'D1 の行に文字かヒント');
  // メールは blocked_emails の行にある（止めたメール）。ほかの秘密（JWT・鍵・ヒント・文字）は D1 のどの行にも無い
  for (const s of ALL.secrets) if (!s.includes(String.fromCharCode(64))) assert.ok(!rows.includes(s), `D1 の行に ${s.slice(0, 12)}…`);
});
