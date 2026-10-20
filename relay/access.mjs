// Cloudflare Access の JWT を中継が自分で確かめる（第1d回 W-5。RL2・RL5・RF42・F17・F18・F24・F28）。Web の標準の部品だけを使う。
// 中継は Worker 単位の Access の後ろに置くが、Access が外れていても、確かめられない要求は通さない。
//
//   requireAccess(request, env, cfg, { now, need = 'user', ctx }) →
//     { ok: true, kind: 'user', email, exp, via } | { ok: true, kind: 'service', via }（need: 'any' のときだけ）| { ok: false, st: 401|403|503, r }
//     now はミリ秒を返す関数（試しの時計を替えられる）。r は記録の符号:
//       'no-jwt'・'bad-jwt'・'alg'・'kid'・'sig'・'iss'・'aud'・'exp'・'nbf'・'type'・'certs'・'domain'・'alias'・'blocked'・'service'・'not-ready'
//     順: cfg.ready.access（無ければ 503 not-ready）
//       → JWT を取る（takeJwt: 見出し Cf-Access-Jwt-Assertion → 無ければ Cookie の CF_Authorization。8KB まで・3つの base64url）。
//         どちらも無く need: 'any'（/health だけ）なら、ctx.access.aud が POLICY_AUD と同じ（文字か配列）ときだけ kind: 'service', via: 'ctx'
//         （ctx.access は Workers の仕組みが付けるもので、客は作れない。サービストークンの要求には cookie が無い）
//       → verifyJwt（'iss'・'aud'・'certs' は 503 not-ready。署名の合う JWT の aud・iss の食い違いは秘密の欄の入れ間違いなので、
//         401 にしてアプリに全員の cookie を消させない: F28。ほかの失敗は 401 login）
//       → 人かサービスか（人 = email が文字・sub が空でない文字・common_name が無い。サービス = sub が ''・common_name が文字・email が無い。
//         どちらでもなければ 401 bad-jwt）。サービスは need: 'any' のときだけ通し、ほかは 403 service
//       → 人なら email の形（ASCII の見える字だけかを先に見てから小文字にする。形が違えば 403 domain。@ より前に + があれば 403 alias: F24）
//       → 会社のドメイン（cfg.domains とちょうど同じ。2つ目の照らし: K13。ドメインを入れていなければ 503 not-ready）
//       → blocked_emails（あれば 403 blocked。D1 が投げたら 503 not-ready）
//     失敗は記録 { ev: 'access', st, r }。通ったときは、取り方（via）ごとに isolate で最初の1回だけ { ev: 'access', r: 'ok', v: via }
//     （メール・kid・JWT・チームの名前は書かない）
//   accessError(st) → 答えの error の符号（401 'login'・403 'denied'・503 'not-ready'）
//   takeJwt(request) → { token, via: 'hdr'|'cookie' } | null（空の見出し・空の cookie は無いのと同じ。形はまだ見ない）
//   verifyJwt(token, { teamDomain, aud, certsBase, now, fetch = globalThis.fetch }) → { ok: true, claims } | { ok: false, r }
//     now はミリ秒（数）。見出しの alg は 'RS256' だけ（'none'・'HS256' などは 'alg'）。kid は文字（無ければ 'kid'）。
//     署名は RSASSA-PKCS1-v1_5・SHA-256（crypto.subtle.verify）。署名が合った後に iss === teamDomain・aud（文字か配列）に POLICY_AUD がある・
//     exp（数）> 今・nbf（あれば数）<= 今 + 60・type === 'app' の順に見る
//   鍵の写し: モジュールの Map（certsBase ごと）。1時間で取り直す。知らない kid は、前に取ってから 30 秒より後なら1回だけ取り直す（鍵の替わり目）。
//     取りに行っている間の要求は同じ Promise を待つ（同時の知らない kid で何本も取りに行かない）。取れなかった後 30 秒は取りに行かずに 'certs'。
//     fetch は redirect: 'manual'（Workers は 'error' を受けない。3xx は 200 でないので取れなかった扱い）・AbortSignal.timeout(5000)・答えは 64KB まで。keys の kty 'RSA'・alg が無いか 'RS256'・use が無いか 'sig' だけを読む
//   _resetCertsCache()（テストだけが呼ぶ）

import { readCapped } from './http.mjs';
import { logEvent } from './log.mjs';

const JWT_MAX = 8192;
const SEG = /^[A-Za-z0-9_-]*$/;
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}$/;
const CERTS_TTL_MS = 60 * 60 * 1000;
const REFETCH_MS = 30 * 1000;
const CERTS_TIMEOUT_MS = 5000;
const CERTS_MAX_BYTES = 64 * 1024;
const NBF_SKEW_SEC = 60;
const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const ERRORS = { 401: 'login', 403: 'denied', 503: 'not-ready' };
const enc = new TextEncoder();

const certsCache = new Map();
const loggedVia = new Set();

export function _resetCertsCache() {
  certsCache.clear();
}

export function accessError(st) {
  return ERRORS[st] || 'not-ready';
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

export function takeJwt(request) {
  const hdr = (request.headers.get('cf-access-jwt-assertion') || '').trim();
  if (hdr) return { token: hdr, via: 'hdr' };
  const ck = cookieValue(request.headers.get('cookie'), 'CF_Authorization');
  if (ck) return { token: ck, via: 'cookie' };
  return null;
}

function b64urlBytes(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '==='.slice((b.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s) {
  try {
    const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b64urlBytes(s)));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

async function loadCerts(certsBase, fetchFn) {
  const res = await fetchFn(certsBase + '/cdn-cgi/access/certs', {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(CERTS_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (res.status !== 200) {
    try { if (res.body) await res.body.cancel(); } catch (_) { /* 捨てるだけ */ }
    throw new Error('certs');
  }
  const bytes = await readCapped(res, CERTS_MAX_BYTES);
  if (bytes === null) throw new Error('certs');
  const j = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const keys = new Map();
  for (const k of Array.isArray(j && j.keys) ? j.keys : []) {
    if (!k || typeof k !== 'object' || k.kty !== 'RSA' || typeof k.kid !== 'string' || !k.kid) continue;
    if (k.alg !== undefined && k.alg !== 'RS256') continue;
    if (k.use !== undefined && k.use !== 'sig') continue;
    if (typeof k.n !== 'string' || typeof k.e !== 'string') continue;
    try {
      keys.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, RSA, false, ['verify']));
    } catch (_) { /* 読めない鍵は使わない */ }
  }
  if (keys.size === 0) throw new Error('certs');
  return keys;
}

// → { key } | { r: 'kid' | 'certs' }
async function keyFor(certsBase, kid, nowMs, fetchFn) {
  let e = certsCache.get(certsBase);
  if (!e) {
    e = { keys: null, at: 0, failedAt: null, inflight: null };
    certsCache.set(certsBase, e);
  }
  const fresh = e.keys !== null && nowMs - e.at < CERTS_TTL_MS;
  if (fresh && e.keys.has(kid)) return { key: e.keys.get(kid) };
  if (fresh && nowMs - e.at < REFETCH_MS) return { r: 'kid' };   // 取ったばかり。知らない kid で何度も取りに行かない
  if (e.failedAt !== null && nowMs - e.failedAt < REFETCH_MS) return { r: 'certs' };
  if (!e.inflight) {   // 取りに行っている間に来た要求は、同じ Promise を待つ（何本も取りに行かない）
    e.inflight = loadCerts(certsBase, fetchFn).then(
      (keys) => { e.keys = keys; e.at = nowMs; e.failedAt = null; },
      () => { e.failedAt = nowMs; },
    ).finally(() => { e.inflight = null; });
  }
  await e.inflight;
  if (e.keys === null || e.failedAt !== null) return { r: 'certs' };
  return e.keys.has(kid) ? { key: e.keys.get(kid) } : { r: 'kid' };
}

export async function verifyJwt(token, { teamDomain, aud, certsBase, now, fetch: fetchFn = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || token.length > JWT_MAX) return { ok: false, r: 'bad-jwt' };
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts.every((p) => SEG.test(p))) return { ok: false, r: 'bad-jwt' };
  const header = b64urlJson(parts[0]);
  if (!header) return { ok: false, r: 'bad-jwt' };
  if (header.alg !== 'RS256') return { ok: false, r: 'alg' };
  if (typeof header.kid !== 'string' || !header.kid) return { ok: false, r: 'kid' };
  const claims = b64urlJson(parts[1]);
  if (!claims) return { ok: false, r: 'bad-jwt' };
  let sig;
  try { sig = b64urlBytes(parts[2]); } catch (_) { return { ok: false, r: 'bad-jwt' }; }
  const k = await keyFor(certsBase, header.kid, now, fetchFn);
  if (!k.key) return { ok: false, r: k.r };
  let good = false;
  try { good = await crypto.subtle.verify(RSA, k.key, sig, enc.encode(parts[0] + '.' + parts[1])); } catch (_) { good = false; }
  if (good !== true) return { ok: false, r: 'sig' };
  const t = Math.floor(now / 1000);
  if (claims.iss !== teamDomain) return { ok: false, r: 'iss' };
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return { ok: false, r: 'aud' };
  if (typeof claims.exp !== 'number' || !(claims.exp > t)) return { ok: false, r: 'exp' };
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !(claims.nbf <= t + NBF_SKEW_SEC))) return { ok: false, r: 'nbf' };
  if (claims.type !== 'app') return { ok: false, r: 'type' };
  return { ok: true, claims };
}

function audMatches(v, want) {
  return (Array.isArray(v) ? v : [v]).some((x) => typeof x === 'string' && x === want);
}

function kindOf(c) {
  const has = (n) => Object.prototype.hasOwnProperty.call(c, n);
  if (typeof c.email === 'string' && typeof c.sub === 'string' && c.sub !== '' && !has('common_name')) return 'user';
  if (c.sub === '' && typeof c.common_name === 'string' && !has('email')) return 'service';
  return '';
}

function fail(st, r) {
  logEvent('access', { st, r });
  return { ok: false, st, r };
}

function passed(out) {
  if (!loggedVia.has(out.via)) {
    loggedVia.add(out.via);
    logEvent('access', { r: 'ok', v: out.via });
  }
  return out;
}

export async function requireAccess(request, env, cfg, { now = Date.now, need = 'user', ctx } = {}) {
  if (!cfg.ready.access) return fail(503, 'not-ready');
  const got = takeJwt(request);
  if (!got) {
    const a = ctx && typeof ctx === 'object' ? ctx.access : null;
    if (need === 'any' && a && typeof a === 'object' && audMatches(a.aud, cfg.policyAud)) return passed({ ok: true, kind: 'service', via: 'ctx' });
    return fail(401, 'no-jwt');
  }
  const v = await verifyJwt(got.token, { teamDomain: cfg.teamDomain, aud: cfg.policyAud, certsBase: cfg.certsBase, now: now() });
  if (!v.ok) return fail(v.r === 'iss' || v.r === 'aud' || v.r === 'certs' ? 503 : 401, v.r);
  const kind = kindOf(v.claims);
  if (!kind) return fail(401, 'bad-jwt');
  if (kind === 'service') return need === 'any' ? passed({ ok: true, kind: 'service', via: got.via }) : fail(403, 'service');
  if (!/^[\x21-\x7e]+$/.test(v.claims.email)) return fail(403, 'domain');   // 小文字にする前に ASCII だけ（U+212A が k になるような畳み込みをしない）
  const email = v.claims.email.toLowerCase();
  if (!EMAIL.test(email)) return fail(403, 'domain');
  const at = email.indexOf('@');
  if (email.slice(0, at).includes('+')) return fail(403, 'alias');
  if (!cfg.ready.domains) return fail(503, 'not-ready');
  if (!cfg.domains.has(email.slice(at + 1))) return fail(403, 'domain');
  let blocked;
  try {
    blocked = await env.DB.prepare('SELECT 1 AS b FROM blocked_emails WHERE email = ?1').bind(email).first('b');
  } catch (_) {
    return fail(503, 'not-ready');   // D1 が無い・表が無い。止めたかを確かめずに通さない。例外の文は写さない
  }
  if (blocked) return fail(403, 'blocked');
  return passed({ ok: true, kind: 'user', email, exp: v.claims.exp, via: got.via });
}
