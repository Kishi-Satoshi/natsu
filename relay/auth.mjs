// 登録とログイン（第1d回 RL3〜RL6）。W-2 で確認コードを頼む口 /auth/start、W-3 で verify・logout・me・札（issueSession・requireSession）。
// 道の関数は worker.mjs の health と同じ形: (request, env, { cfg, now, ctx }) → Response。now() はミリ秒（試しの時計を替えられる）。
//
// POST /auth/start { email }
//   順: 本文（2KB まで。越えれば 413 too-large・JSON でなければ 400 bad-request）→ メールの形（400 bad-email）
//     → 秘密がそろったか（503 not-ready。ドメインが空のまま照らすと、全部が 403 domain になるので先に見る）
//     → IP の数え（s:ip。1時間 60 回。ドメインの照らしより前に置き、ドメインの当て推量も数える。D1 の表が無ければここで 503 not-ready）
//     → ドメイン（並べたドメインとちょうど同じだけ。サブドメインも 403 domain）
//     → 同じメールの数え（s:e 15 分 3 回・s:d 1日 10 回を1つの batch で。越えれば 429 rate と Retry-After）
//     → 全体の通数（mail。1日 cfg.mailDailyMax 通。越えれば 503 mail-cap）
//     → コードを作って Resend で送る（断られた・届かない → 全体の通数を1つ戻して 503 mail。コードの行は書かない）
//     → 送れたら、コードの行を置き換え（試した回数も 0 に）、古い行を片付ける（1つの batch）→ 200 { ok: true, expiresIn: 600 }
//   数えは送る前に進める（送れなかった頼みも数える。Resend へ何度も打たせない）。全体の通数は、同じメールの数えが通ったときだけ数える
//   （送り直しの押しすぎで全体の通数を使わない）。止めたメール（blocked_emails）にも、ほかと同じく送る（start の答えで止めたかを明かさない）。
//   D1 にはコードのハッシュ sha256hex(email + ':' + code) だけを書く。記録にはメール・IP・コードを書かない（r の符号だけ）。
//
// POST /auth/verify { email, code }
//   順: 本文（413 too-large・400 bad-request）→ メールと 6 けたのコードの形（400 bad-request。コードの回数は使わない）
//     → IP の数え（v:ip。1時間 150 回。越えれば 429 rate と Retry-After）
//     → 先に1回を使ってから比べる: 1つの batch で attempts を足し（期限の内で 5 回未満の行だけ）、code_hash と attempts を読む。
//       足せなければ（無い・期限切れ・使い切った）401 code-expired。違えば 401 code と left（あと何回）
//     → 合えば DELETE … AND attempts <= 5（今の1回は先に数えてある）の meta.changes === 1 で勝ちを1つに決める（負けは code-expired）
//     → 止めたメール（blocked_emails）は、コードが合った後にだけ 403 blocked（違うコードで止めたかを明かさない）
//     → issueSession で札を作り 200 { ok, token, email, method: 'email', idleDays: 30, expiresAt }
// 札（issueSession・requireSession）
//   札 = 'nt1_' + base64url(32 バイトの乱数)。D1 の sessions には sha256hex(札) だけ。idp は 'email'（後で 'microsoft'）。
//   使わなければ 30 日（last_used_at から）、使い続けても最初から 180 日（expires_at）で切れる。last_used_at は 1 日に 1 回だけ書き直す。
//   requireSession は Authorization: Bearer nt1_… の形だけを受け、token_hash で1行を引く（比べは行を引くだけなので、文字の比べの時間の差が出ない）。
//   取り消しは管理の口を作らず、D1 の画面で revoked_at を書くか blocked_emails に足す（README の管理者の節の SQL）。
// POST /auth/logout（Bearer）→ その札だけ revoked_at を書く。無い札・切れた札・形の違う見出しでも 200 { ok: true }
// GET  /auth/me（Bearer）→ 200 { email, method, expiresAt } | 401 login

import { json, readJson, sha256hex, randomCode, randomToken, clientIpKey } from './http.mjs';
import { hit, hits, release } from './limits.mjs';
import { sendCode } from './mail.mjs';
import { logEvent } from './log.mjs';

export const CODE_TTL_SEC = 600;
export const JSON_MAX_BYTES = 2048;
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}$/;
const DAY = 86400;
export const START_LIMITS = Object.freeze({
  ip: { windowSec: 3600, max: 60 },
  email: { windowSec: 900, max: 3 },
  emailDay: { windowSec: DAY, max: 10 },
});
export const VERIFY_LIMIT = Object.freeze({ windowSec: 3600, max: 150 });
export const MAX_ATTEMPTS = 5;
export const SESSION_IDLE_SEC = 30 * DAY;
export const SESSION_MAX_SEC = 180 * DAY;
const CODE = /^\d{6}$/;
const BEARER = /^Bearer (nt1_[A-Za-z0-9_-]{43})$/;
const IDPS = new Set(['email', 'microsoft']);

const nowSec = (now) => Math.floor(now() / 1000);
const emailKey = async (email) => (await sha256hex(email)).slice(0, 32);

function answer(ev, r, status, body, headers, more = {}) {
  logEvent(ev, { ...more, r });
  return json(status, body, headers);
}

export async function handleStart(request, env, { cfg, now }) {
  const ev = 'auth.start';
  const body = await readJson(request, JSON_MAX_BYTES);
  if (!body.ok) return answer(ev, body.error, body.error === 'too-large' ? 413 : 400, { error: body.error });
  const email = typeof body.value.email === 'string' ? body.value.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) return answer(ev, 'bad-email', 400, { error: 'bad-email' });
  if (!cfg.ready.domains || !cfg.ready.mail) return answer(ev, 'not-ready', 503, { error: 'not-ready' });

  const t = nowSec(now);
  const db = env.DB;
  let ipHit;
  try {
    ipHit = await hit(db, 's:' + await clientIpKey(request), { ...START_LIMITS.ip, now: t });
  } catch (_) {
    return answer(ev, 'not-ready', 503, { error: 'not-ready' });   // D1 が無い・表が無い。例外の文は写さない
  }
  if (!ipHit.ok) return rate(ev, ipHit.retryAfter);

  if (!cfg.domains.has(email.slice(email.indexOf('@') + 1))) return answer(ev, 'domain', 403, { error: 'domain' });

  const ek = await emailKey(email);
  const per = await hits(db, [
    { key: 's:e:' + ek, ...START_LIMITS.email },
    { key: 's:d:' + ek, ...START_LIMITS.emailDay },
  ], t);
  const blocked = per.filter((x) => !x.ok);
  if (blocked.length) return rate(ev, Math.max(...blocked.map((x) => x.retryAfter)));

  const cap = { windowSec: DAY, max: cfg.mailDailyMax };
  if (!(await hit(db, 'mail', { ...cap, now: t })).ok) return answer(ev, 'mail-cap', 503, { error: 'mail-cap' });

  const code = randomCode();
  const sent = await sendCode(cfg, { to: email, code });
  if (!sent.ok) {
    await release(db, 'mail', { windowSec: DAY, now: t });   // Resend の失敗で全体の通数を使い切らない
    return answer(ev, 'mail', 503, { error: 'mail' });
  }

  await db.batch([
    db.prepare('INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?1, ?2, ?3, 0, ?4) '
      + 'ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at')
      .bind(email, await sha256hex(email + ':' + code), t + CODE_TTL_SEC, t),
    db.prepare('DELETE FROM login_codes WHERE expires_at <= ?1').bind(t),
    db.prepare('DELETE FROM counters WHERE win < ?1').bind(t - 2 * DAY),
  ]);
  return answer(ev, 'sent', 200, { ok: true, expiresIn: CODE_TTL_SEC });
}

function rate(ev, retryAfter) {
  return answer(ev, 'rate', 429, { error: 'rate', retryAfter }, { 'retry-after': String(retryAfter) });
}

export async function handleVerify(request, env, { cfg, now }) {
  const ev = 'auth.verify';
  const body = await readJson(request, JSON_MAX_BYTES);
  if (!body.ok) return answer(ev, body.error, body.error === 'too-large' ? 413 : 400, { error: body.error });
  const email = typeof body.value.email === 'string' ? body.value.email.trim().toLowerCase() : '';
  const code = typeof body.value.code === 'string' ? body.value.code.trim() : '';
  if (!EMAIL.test(email) || !CODE.test(code)) return answer(ev, 'bad-request', 400, { error: 'bad-request' });

  const t = nowSec(now);
  const db = env.DB;
  const ipHit = await hit(db, 'v:' + await clientIpKey(request), { ...VERIFY_LIMIT, now: t });
  if (!ipHit.ok) return rate(ev, ipHit.retryAfter);

  // 先に1回を使ってから比べる（読んでから数えると、同時の要求で 5 回を越えて比べられる）
  const [used, read] = await db.batch([
    db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?1 AND expires_at > ?2 AND attempts < ?3')
      .bind(email, t, MAX_ATTEMPTS),
    db.prepare('SELECT code_hash, attempts FROM login_codes WHERE email = ?1').bind(email),
  ]);
  const row = (read.results || [])[0];
  if (used.meta.changes !== 1 || !row) return answer(ev, 'code-expired', 401, { error: 'code-expired' });
  const hash = await sha256hex(email + ':' + code);
  if (row.code_hash !== hash) {
    const left = Math.max(0, MAX_ATTEMPTS - Number(row.attempts));
    return answer(ev, 'code', 401, { error: 'code', left }, {}, { left });
  }
  // 勝ちは1つ（正しいコードを同時に何本送っても、行を消せたのは1本だけ）
  const won = await db.prepare('DELETE FROM login_codes WHERE email = ?1 AND code_hash = ?2 AND expires_at > ?3 AND attempts <= ?4')
    .bind(email, hash, t, MAX_ATTEMPTS).run();
  if (won.meta.changes !== 1) return answer(ev, 'code-expired', 401, { error: 'code-expired' });
  if (await isBlocked(db, email)) return answer(ev, 'blocked', 403, { error: 'blocked' });

  const s = await issueSession(env, cfg, { email, idp: 'email', now });
  return answer(ev, 'ok', 200, { ok: true, token: s.token, email, method: 'email', idleDays: SESSION_IDLE_SEC / DAY, expiresAt: s.expiresAt });
}

async function isBlocked(db, email) {
  return Boolean(await db.prepare('SELECT 1 AS b FROM blocked_emails WHERE email = ?1').bind(email).first('b'));
}

// 札を作るのはここだけ（Microsoft のサインインを足すときも、ここを呼ぶ: F12）。now はミリ秒を返す関数（省けば本番の時計）。
// 同じ batch で、同じメールの期限の切れた札（最初から 180 日・使わずに 30 日）を片付ける。
export async function issueSession(env, cfg, { email, idp = 'email', now = Date.now } = {}) {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!EMAIL.test(e) || !IDPS.has(idp)) throw new TypeError('issueSession: メールか idp の形が違う');
  const t = nowSec(now);
  const token = randomToken();
  const expiresAt = t + SESSION_MAX_SEC;
  const db = env.DB;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE email = ?1 AND (expires_at <= ?2 OR last_used_at <= ?3)').bind(e, t, t - SESSION_IDLE_SEC),
    db.prepare('INSERT INTO sessions (token_hash, email, idp, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?4, ?5)')
      .bind(await sha256hex(token), e, idp, t, expiresAt),
  ]);
  return { token, expiresAt };
}

// → { email, idp, tokenHash, expiresAt } | null。now はミリ秒を返す関数（省けば本番の時計）
export async function requireSession(request, env, cfg, { now = Date.now } = {}) {
  const m = BEARER.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const t = nowSec(now);
  const tokenHash = await sha256hex(m[1]);
  const db = env.DB;
  const row = await db.prepare('SELECT s.email, s.idp, s.last_used_at, s.expires_at, s.revoked_at, '
    + 'EXISTS (SELECT 1 FROM blocked_emails b WHERE b.email = s.email) AS blocked FROM sessions s WHERE s.token_hash = ?1')
    .bind(tokenHash).first();
  if (!row) return null;
  if (row.revoked_at !== null && row.revoked_at !== undefined) return null;
  if (!(row.expires_at > t)) return null;
  if (!(row.last_used_at + SESSION_IDLE_SEC > t)) return null;
  if (row.blocked) return null;
  if (t - row.last_used_at >= DAY) {
    await db.prepare('UPDATE sessions SET last_used_at = ?2 WHERE token_hash = ?1').bind(tokenHash, t).run();
  }
  return { email: row.email, idp: row.idp, tokenHash, expiresAt: row.expires_at };
}

export async function handleLogout(request, env, { now }) {
  const m = BEARER.exec(request.headers.get('authorization') || '');
  if (m) {
    await env.DB.prepare('UPDATE sessions SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL')
      .bind(await sha256hex(m[1]), nowSec(now)).run();
  }
  return answer('auth.logout', 'ok', 200, { ok: true });
}

export async function handleMe(request, env, { cfg, now }) {
  const s = await requireSession(request, env, cfg, { now });
  if (!s) return answer('auth.me', 'login', 401, { error: 'login' });
  return answer('auth.me', 'ok', 200, { email: s.email, method: s.idp, expiresAt: s.expiresAt });
}
