// 中継の小さな部品（第1d回 RL1）。Web の標準の部品だけを使う（Workers と Node の node --test の両方で動く）。
//   json(status, body, extraHeaders) → Response（Content-Type: application/json; charset=utf-8・Cache-Control: no-store）
//   readCapped(request, maxBytes) → Uint8Array | null（読みながら数え、越えたら読むのをやめて null。Content-Length には頼らない）
//   sha256hex(text) → 64 けたの16進
// 第1d回 W-6 で、自前のログインの部品（readJson・randomToken・randomCode・clientIpKey）を消した（使う所が無い）。

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

export async function sha256hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(text))));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}
