'use strict';
// Cloudflare の REST API を呼ぶ共通の部品（ヘルプセンター H-10。中継の出し方 tools/relay-deploy.js から出した）。
// 使うのは中継の出し方（relay-deploy）とヘルプの出し方（help-deploy）。Node に入っている fetch・FormData・Blob だけを使う。
//
//   makeCf({ token, api, fetch, timeoutMs = 60000, redirect = 'manual' }) → cf(method, path, { json, form, bearer })
//     → { status, ok, result, codes, net }
//     答えの本文は返さない（状態の番号・result・Cloudflare のエラーの番号 errors[].code だけ）。届かなければ status 0 と net（例外の名前）。
//     Authorization はトークン。bearer を渡したとき（資産のバケットの上げだけ）は、トークンの代わりに上げの札を付ける。
//     転送は追わない。redirect は manual（Workers の fetch と同じ決まり。3xx は ok でない答えとして返る）。
//     relay-deploy だけは今の動き（redirect: 'error'。転送は届かない扱い）を変えないために、その値を渡す。
//   why(r) → 「HTTP 403・Cloudflare のエラー 10000」か「届きません: TypeError」（値は出さない）
//   hint(r, perms) → 401・403 のときだけ「。トークンの権限（このアカウントだけの <perms>）と CLOUDFLARE_ACCOUNT_ID を確かめてください」
//   checkSecrets(env, { setupText, label }) → { ok: true, token, acct } | { ok: false, code: 0|1, line }
//     push で2つとも無ければ code 0（何もしない）。足りない・形が違えば code 1。line は値を含まない平易な文（label は「中継」「ヘルプ」）

function makeCf({ token, api, fetch, timeoutMs = 60000, redirect = 'manual' }) {
  return async function cf(method, p, { json, form, bearer } = {}) {
    const headers = { authorization: `Bearer ${bearer || token}` };
    let body;
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    let res;
    try {
      res = await fetch(api + p, { method, headers, body, redirect, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return { status: 0, ok: false, result: null, codes: [], net: (e && e.name) || 'Error' };
    }
    let j = null;
    try { j = JSON.parse(await res.text()); } catch (_) { j = null; }
    const codes = j && Array.isArray(j.errors) ? j.errors.map((x) => (x && Number.isInteger(x.code) ? x.code : null)).filter((x) => x !== null) : [];
    return { status: res.status, ok: res.ok && Boolean(j) && j.success !== false, result: j && typeof j === 'object' ? j.result : null, codes };
  };
}

const why = (r) => (r.status === 0 ? `届きません: ${/^[A-Za-z]{1,32}$/.test(r.net) ? r.net : 'Error'}`
  : `HTTP ${r.status}${r.codes.length ? `・Cloudflare のエラー ${r.codes.slice(0, 5).join(',')}` : ''}`);

const hint = (r, perms) => (r.status === 401 || r.status === 403
  ? `。トークンの権限（このアカウントだけの ${perms}）と CLOUDFLARE_ACCOUNT_ID を確かめてください` : '');

function checkSecrets(env, { setupText, label }) {
  const token = typeof env.CLOUDFLARE_API_TOKEN === 'string' ? env.CLOUDFLARE_API_TOKEN.trim() : '';
  const acct = typeof env.CLOUDFLARE_ACCOUNT_ID === 'string' ? env.CLOUDFLARE_ACCOUNT_ID.trim() : '';
  if (!token && !acct && env.GITHUB_EVENT_NAME === 'push') {
    return { ok: false, code: 0, line: `${label}の秘密がまだ用意されていないので出しません（main への push。手で出すときは ${setupText}）` };
  }
  if (!token || !acct) return { ok: false, code: 1, line: `${label}を出せません: 秘密が足りません。${setupText}` };
  if (!/^[0-9a-f]{32}$/.test(acct)) return { ok: false, code: 1, line: `${label}を出せません: CLOUDFLARE_ACCOUNT_ID の形が違います（32 けたの 0〜9 と a〜f）。${setupText}` };
  if (!/^[\x21-\x7e]{1,512}$/.test(token)) return { ok: false, code: 1, line: `${label}を出せません: CLOUDFLARE_API_TOKEN の形が違います（空白や改行が入っていないか）。${setupText}` };
  return { ok: true, token, acct };
}

module.exports = { makeCf, why, hint, checkSecrets };
