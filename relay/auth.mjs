// 登録とログイン（第1d回 RL3〜RL6）。W-2 は確認コードを頼む口 /auth/start だけ（verify・logout・me・札は W-3）。
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

import { json, readJson, sha256hex, randomCode, clientIpKey } from './http.mjs';
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

const nowSec = (now) => Math.floor(now() / 1000);
const emailKey = async (email) => (await sha256hex(email)).slice(0, 32);

function answer(ev, r, status, body, headers) {
  logEvent(ev, { r });
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
