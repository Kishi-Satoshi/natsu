'use strict';
// Cloudflare の REST API を呼ぶ共通の部品（ヘルプセンター H-10。中継の出し方 tools/relay-deploy.js から出した）。
// 使うのは中継の出し方（relay-deploy）とヘルプの出し方（help-deploy）。Node に入っている fetch・FormData・Blob だけを使う。
//
//   makeCf({ token, api, fetch, timeoutMs = 60000, redirect = 'manual' }) → cf(method, path, { json, form, bearer })
//     → { status, ok, result, codes, net, kind, messages, doc, ray }
//     答えの本文そのものは返さない。返すのは状態の番号・result・Cloudflare のエラーの番号 errors[].code と、失敗を調べるための
//     次の4つだけ（help-deploy の 4/9 が、どこで断られたかの分からない 403 で止まった。run 39520207427）:
//       kind     本文の形（'json'｜'html'｜'empty'｜'other'。HTML は Cloudflare の API の JSON でない答え＝前に立つ守りの頁など）
//       messages errors[].message の先頭 3 つを cleanMessage で洗ったもの（使ってよい字は A〜Z・a〜z・0〜9・空白と . , : ; ' ( ) / _ -
//                だけ。メール・URL・長い英数字の並び（トークン・アカウントの ID・札の見かけ）は伏せ、1 つ 160 字まで）
//       doc      errors[].documentation_url のうち https://developers.cloudflare.com/ の決まった形のもの 1 つ（無ければ ''）
//       ray      見出し cf-ray（/^[0-9a-f]{16}-[A-Z]{3}$/ のときだけ。Cloudflare に問い合わせるときの番号）
//     届かなければ status 0 と net（例外の名前）。
//     Authorization はトークン。bearer を渡したとき（資産のバケットの上げだけ）は、トークンの代わりに上げの札を付ける。
//     転送は追わない。redirect は manual（Workers の fetch と同じ決まり。3xx は ok でない答えとして返る）。
//     relay-deploy だけは今の動き（redirect: 'error'。転送は届かない扱い）を変えないために、その値を渡す。
//   why(r) → 「HTTP 403・本文 JSON・Cloudflare のエラー 10000・文「Authentication error」・cf-ray 0123456789abcdef-NRT」か
//            「届きません: TypeError」（トークン・アカウントの ID・本文のほかの文字は出さない）
//   hint(r, perms) → 401・403 のときだけ「。トークンの権限（このアカウントだけの <perms>）と CLOUDFLARE_ACCOUNT_ID を確かめてください」
//   checkSecrets(env, { setupText, label }) → { ok: true, token, acct } | { ok: false, code: 0|1, line }
//     push で2つとも無ければ code 0（何もしない）。足りない・形が違えば code 1。line は値を含まない平易な文（label は「中継」「ヘルプ」）

const RAY = /^[0-9a-f]{16}-[A-Z]{3}$/;
const DOC = /^https:\/\/developers\.cloudflare\.com\/[A-Za-z0-9/_.#-]{0,160}$/;
const MAX_MESSAGES = 3;
const MAX_MESSAGE = 160;
const REDACTED = '(redacted)';

/**
 * Cloudflare の errors[].message を、記録に出してよい字だけに洗う（投げない。出せる字が残らなければ ''）。
 * 1 メールと URL を伏せる → 2 使ってよい字（A〜Z・a〜z・0〜9・空白・. , : ; ' ( ) / _ -）のほかを落とす（空白の類は空白に）→
 * 3 英数字と _ - の 20 字以上の並み（トークン・JWT の欠片）と 16 字以上の16進（アカウントの ID・cf-ray）を伏せる →
 * 4 渡された秘密（トークンなど 8 字以上）がまだ残れば伏せる → 5 空白をつめて 160 字まで
 */
function cleanMessage(s, secrets = []) {
  if (typeof s !== 'string') return '';
  let t = s.slice(0, 4096)
    .replace(/[^\s@]*@[^\s@]*/g, ' (email) ')
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g, ' (url) ')
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z0-9 .,:;'()/_-]/g, '')
    .replace(/[A-Za-z0-9_-]{20,}/g, REDACTED)
    .replace(/[0-9a-fA-F]{16,}/g, REDACTED);
  for (const x of secrets) {
    if (typeof x === 'string' && x.length >= 8) t = t.split(x).join(REDACTED);
  }
  t = t.replace(/ {2,}/g, ' ').trim();
  return t.length > MAX_MESSAGE ? t.slice(0, MAX_MESSAGE).trim() : t;
}

/** 本文の形（中身は返さない） */
function bodyKind(text, j) {
  if (j && typeof j === 'object') return 'json';
  if (!text || !text.trim()) return 'empty';
  if (/^\s*</.test(text)) return 'html';
  return 'other';
}

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
      return { status: 0, ok: false, result: null, codes: [], net: (e && e.name) || 'Error', kind: '', messages: [], doc: '', ray: '' };
    }
    let text = '';
    try { text = await res.text(); } catch (_) { text = ''; }
    let j = null;
    try { j = JSON.parse(text); } catch (_) { j = null; }
    const errs = j && typeof j === 'object' && Array.isArray(j.errors) ? j.errors.filter((x) => x && typeof x === 'object') : [];
    const codes = errs.map((x) => (Number.isInteger(x.code) ? x.code : null)).filter((x) => x !== null);
    const messages = errs.map((x) => cleanMessage(x.message, [token, bearer])).filter(Boolean).slice(0, MAX_MESSAGES);
    const docs = errs.map((x) => x.documentation_url).filter((u) => typeof u === 'string' && DOC.test(u));
    let ray = '';
    try { ray = String((res.headers && res.headers.get('cf-ray')) || ''); } catch (_) { ray = ''; }
    return {
      status: res.status,
      ok: res.ok && Boolean(j) && j.success !== false,
      result: j && typeof j === 'object' ? j.result : null,
      codes,
      kind: bodyKind(text, j),
      messages,
      doc: docs.length ? docs[0] : '',
      ray: RAY.test(ray) ? ray : '',
    };
  };
}

const KIND = { json: 'JSON', html: 'HTML（Cloudflare の API の JSON でない）', empty: '空', other: 'JSON でも HTML でもない' };

function why(r) {
  if (r.status === 0) return `届きません: ${/^[A-Za-z]{1,32}$/.test(r.net) ? r.net : 'Error'}`;
  const parts = [`HTTP ${r.status}`];
  if (KIND[r.kind]) parts.push(`本文 ${KIND[r.kind]}`);
  if (Array.isArray(r.codes) && r.codes.length) parts.push(`Cloudflare のエラー ${r.codes.slice(0, 5).join(',')}`);
  // 出す前にもう一度洗う（cf の外で作った r が来ても、決まった字だけにする）
  const msgs = (Array.isArray(r.messages) ? r.messages : []).map((m) => cleanMessage(m)).filter(Boolean).slice(0, MAX_MESSAGES);
  if (msgs.length) parts.push(`文${msgs.map((m) => `「${m}」`).join('')}`);
  if (typeof r.doc === 'string' && DOC.test(r.doc)) parts.push(`資料 ${r.doc}`);
  if (typeof r.ray === 'string' && RAY.test(r.ray)) parts.push(`cf-ray ${r.ray}`);
  return parts.join('・');
}

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

module.exports = { makeCf, why, hint, checkSecrets, cleanMessage };
