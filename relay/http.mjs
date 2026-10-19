// 中継の小さな部品（第1d回 RL1）。Web の標準の部品だけを使う（Workers と Node の node --test の両方で動く）。
//   json(status, body, extraHeaders) → Response（Content-Type: application/json; charset=utf-8・Cache-Control: no-store）
//   readCapped(request, maxBytes) → Uint8Array | null（読みながら数え、越えたら読むのをやめて null。Content-Length には頼らない）
//   readJson(request, maxBytes) → { ok: true, value: オブジェクト } | { ok: false, error: 'too-large' | 'bad-request' }
//   sha256hex(text) → 64 けたの16進
//   randomToken() → 'nt1_' + base64url(32 バイト)（43 字）
//   randomCode() → 6 けたの数字の文字（棄却で偏りなし）
//   clientIpKey(request) → 'ip:' + sha256hex(CF-Connecting-IP の値) | 'ip:unknown'
//     （X-Forwarded-For・True-Client-IP は客が付けた値が残りうるので読まない。IP そのものは鍵にも書かない）

const enc = new TextEncoder();

export function json(status, body, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

export async function readCapped(request, maxBytes) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const part = value instanceof Uint8Array ? value : new Uint8Array(value);
    total += part.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) { /* 読むのをやめるだけ */ }
      return null;
    }
    chunks.push(part);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export async function readJson(request, maxBytes) {
  const bytes = await readCapped(request, maxBytes);
  if (bytes === null) return { ok: false, error: 'too-large' };
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (_) { return { ok: false, error: 'bad-request' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'bad-request' };
  return { ok: true, value };
}

export async function sha256hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(text))));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken() {
  return 'nt1_' + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

// 2^32 を 100 万で割った余りの分を捨てる（余りの側の数が出やすくならないように）
const CODE_LIMIT = Math.floor(0x100000000 / 1000000) * 1000000;
export function randomCode() {
  const a = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(a);
    if (a[0] < CODE_LIMIT) return String(a[0] % 1000000).padStart(6, '0');
  }
}

export async function clientIpKey(request) {
  const ip = (request.headers.get('cf-connecting-ip') || '').trim();
  return ip ? 'ip:' + await sha256hex(ip) : 'ip:unknown';
}
