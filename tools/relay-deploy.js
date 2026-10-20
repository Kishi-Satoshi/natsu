#!/usr/bin/env node
'use strict';
// 文字起こしの中継（relay/）を Cloudflare に出す（第1d回 RL8）。wrangler も npm の依存も使わず、Node に入っている
// fetch・FormData・Blob だけで Cloudflare の REST API を呼ぶ。GitHub Actions の relay-deploy.yml から走る。
//
//   node tools/relay-deploy.js
//     環境変数: CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID（GitHub の環境 relay の秘密。手順の env でだけ渡す）
//              CF_ACCESS_CLIENT_ID・CF_ACCESS_CLIENT_SECRET（同じ環境の秘密。Access のサービストークン。2つともあれば /health の
//              要求にだけ CF-Access-Client-Id・CF-Access-Client-Secret の見出しで付ける: D-2）
//              GITHUB_EVENT_NAME（push なら、秘密が2つとも無いときは何もせず 0 で終わる。手で押したとき・手元では 1）
//     試しだけ: CF_API_BASE・RELAY_HEALTH_BASE（どちらも http://127.0.0.1:<port> の形のときだけ効く。ほかは本物の URL）
//
// 手順: 1 workers.dev のサブドメインを読む → 2 D1 を探す（無ければ apac に作る）→ 3 表の形（relay/schema.mjs）を流す →
//       4 Worker があるかを見る（無ければ1回目: keep_bindings を付けない）→ 5 relay/*.mjs を上げる（D1 のバインドだけ。
//       2回目からは keep_bindings: ['secret_text'] で、利用者が画面で入れた秘密を残す。呼び出しごとの記録は止める）→
//       6 workers.dev を有効にする → 7 /health を 5 秒おきに 12 回まで見る（転送は追わない。Access に止められた 3xx・401・403 は
//       1回で分ける。中継の 503 not-ready は鍵の口の一時の失敗もあるので 12 回まで試してから分ける）。
// 守り（F6・RF38）:
//   - 秘密の欄の値（会社の鍵など）は持たず、送らない。送るバインドは D1 だけ（plain_text も送らない）。
//   - トークンは Authorization の見出しにだけ入れる（引数・URL・出力に出さない）。/health（workers.dev）には付けない。
//   - サービストークンは、要求を出す口（send）が宛先をちょうど /health の URL（本物の workers.dev の住所か、試しの 127.0.0.1）と
//     比べて、合うときだけ付ける（Cloudflare の API・転送の行き先には付けない。/health は redirect: 'manual'）。値は出さない（F23）。
//   - 出すのは手順の名前・HTTP の状態の番号・Cloudflare のエラーの番号（errors[].code の数）・公開した URL・ready の真偽だけ。
//     答えの本文・トークン・アカウントの ID・例外の文は出さない（このリポジトリの Actions の記録は誰でも読める）。

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const RELAY = path.join(ROOT, 'relay');
const TEST_BASE = /^http:\/\/127\.0\.0\.1:\d{2,5}(\/[A-Za-z0-9/_-]*)?$/;
const REAL_API = 'https://api.cloudflare.com/client/v4';
const HEALTH_TRIES = 12;
const HEALTH_GAP_MS = 5000;

const SETUP = 'GitHub のリポジトリの Settings → Environments → relay に CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID を入れてください（値はこの記録に出しません）';
const SECRET_NAMES = { openai: 'OPENAI_API_KEY', domains: 'ALLOWED_EMAIL_DOMAINS' };   // ready.access は下で別の文（D-2）
const SVC_ID = /^[0-9a-f]{32}\.access$/;
const SVC_SECRET = /^[\x21-\x7e]{20,200}$/;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function readDeployConfig() {
  const c = JSON.parse(fs.readFileSync(path.join(RELAY, 'deploy-config.json'), 'utf8'));
  const name = /^[a-z0-9][a-z0-9-]{0,62}$/;
  if (!name.test(c.scriptName) || !name.test(c.dbName) || !/^\d{4}-\d{2}-\d{2}$/.test(c.compatibilityDate) || !/^[a-z]{2,8}$/.test(c.locationHint)) {
    throw new Error('relay/deploy-config.json の形が違う');
  }
  return c;
}

/**
 * 中継を出す。終わりの番号（0 = 出せた・何もしなくてよい、1 = 出せなかった）を返す（投げない）。
 * @param {{ env?: object, fetch?: Function, out?: (line: string) => void, sleep?: (ms: number) => Promise<void> }} [o]
 */
async function deploy({ env = process.env, fetch = globalThis.fetch, out = (l) => process.stdout.write(l + '\n'), sleep = sleepMs } = {}) {
  const say = (l) => out(l);
  const fail = (l) => { say((env.GITHUB_ACTIONS === 'true' ? '::error::' : '') + l); return 1; };

  // ---- 秘密がそろっているか（値は出さない）
  const token = typeof env.CLOUDFLARE_API_TOKEN === 'string' ? env.CLOUDFLARE_API_TOKEN.trim() : '';
  const acct = typeof env.CLOUDFLARE_ACCOUNT_ID === 'string' ? env.CLOUDFLARE_ACCOUNT_ID.trim() : '';
  if (!token && !acct && env.GITHUB_EVENT_NAME === 'push') {
    say(`中継の秘密がまだ用意されていないので出しません（main への push。手で出すときは ${SETUP}）`);
    return 0;
  }
  if (!token || !acct) return fail(`中継を出せません: 秘密が足りません。${SETUP}`);
  if (!/^[0-9a-f]{32}$/.test(acct)) return fail(`中継を出せません: CLOUDFLARE_ACCOUNT_ID の形が違います（32 けたの 0〜9 と a〜f）。${SETUP}`);
  if (!/^[\x21-\x7e]{1,512}$/.test(token)) return fail(`中継を出せません: CLOUDFLARE_API_TOKEN の形が違います（空白や改行が入っていないか）。${SETUP}`);
  // Access のサービストークン（無くても出せる。片方だけ・形が違うときは、何も上げずに止める）
  const svcId = typeof env.CF_ACCESS_CLIENT_ID === 'string' ? env.CF_ACCESS_CLIENT_ID.trim() : '';
  const svcSecret = typeof env.CF_ACCESS_CLIENT_SECRET === 'string' ? env.CF_ACCESS_CLIENT_SECRET.trim() : '';
  const svc = svcId || svcSecret ? { id: svcId, secret: svcSecret } : null;
  if (svc && (!SVC_ID.test(svc.id) || !SVC_SECRET.test(svc.secret))) {
    return fail('中継を出せません: CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET を確かめてください（2つともそろえる。Client ID は 32 けたの 0〜9 と a〜f の後ろに .access、Client Secret は空白と改行の無い 20〜200 字。値はこの記録に出しません）');
  }

  let cfg;
  let schema;
  let files;
  try {
    cfg = readDeployConfig();
    schema = await import(pathToFileURL(path.join(RELAY, 'schema.mjs')).href);
    files = fs.readdirSync(RELAY).filter((f) => f.endsWith('.mjs')).sort();
    if (!files.includes('worker.mjs')) throw new Error('worker.mjs が無い');
  } catch (_) {
    return fail('中継を出せません: relay/ の中身（deploy-config.json・schema.mjs・worker.mjs）を読めません');
  }

  const api = typeof env.CF_API_BASE === 'string' && TEST_BASE.test(env.CF_API_BASE) ? env.CF_API_BASE : REAL_API;
  const A = `/accounts/${acct}`;
  const S = `${A}/workers/scripts/${cfg.scriptName}`;

  // 要求を出す口は、Cloudflare の API も /health もこれだけ。サービストークンは宛先がちょうど /health の URL のときだけ付ける（F23）
  let healthUrl = null;
  function send(u, init) {
    const headers = { ...(init.headers || {}) };
    if (svc && healthUrl !== null && u === healthUrl) {
      headers['CF-Access-Client-Id'] = svc.id;
      headers['CF-Access-Client-Secret'] = svc.secret;
    }
    return fetch(u, { ...init, headers });
  }

  // Cloudflare の API を1回呼ぶ。答えの本文は外に出さず、状態の番号・result・エラーの番号だけを返す
  async function cf(method, p, { json, form } = {}) {
    const headers = { authorization: `Bearer ${token}` };
    let body;
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    let res;
    try {
      res = await send(api + p, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(60000) });
    } catch (e) {
      return { status: 0, ok: false, result: null, codes: [], net: (e && e.name) || 'Error' };
    }
    let j = null;
    try { j = JSON.parse(await res.text()); } catch (_) { j = null; }
    const codes = j && Array.isArray(j.errors) ? j.errors.map((x) => (x && Number.isInteger(x.code) ? x.code : null)).filter((x) => x !== null) : [];
    return { status: res.status, ok: res.ok && Boolean(j) && j.success !== false, result: j && typeof j === 'object' ? j.result : null, codes };
  }
  const why = (r) => (r.status === 0 ? `届きません: ${/^[A-Za-z]{1,32}$/.test(r.net) ? r.net : 'Error'}`
    : `HTTP ${r.status}${r.codes.length ? `・Cloudflare のエラー ${r.codes.slice(0, 5).join(',')}` : ''}`);
  const hint = (r) => (r.status === 401 || r.status === 403
    ? '。トークンの権限（このアカウントだけの Workers Scripts: Edit と D1: Edit）と CLOUDFLARE_ACCOUNT_ID を確かめてください' : '');
  const stepFail = (name, r) => fail(`失敗: ${name}（${why(r)}）${hint(r)}`);
  const stepOk = (name, r) => say(`${name}: HTTP ${r.status}`);

  // 1. workers.dev のサブドメイン
  let r = await cf('GET', `${A}/workers/subdomain`);
  const sub = r.ok && r.result && typeof r.result.subdomain === 'string' ? r.result.subdomain : '';
  if (r.status === 404 || (r.ok && !sub)) {
    return fail('中継を出せません: Cloudflare の画面の Workers & Pages で、workers.dev のサブドメインを決めてください（会社名を含まない名前）');
  }
  if (!r.ok) return stepFail('1/7 workers.dev のサブドメインを読む', r);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(sub)) return fail('失敗: 1/7 workers.dev のサブドメインの形が思っていたのと違います');
  stepOk('1/7 workers.dev のサブドメインを読む', r);

  // 2. D1 を探す・無ければ作る
  r = await cf('GET', `${A}/d1/database?name=${encodeURIComponent(cfg.dbName)}`);
  if (!r.ok) return stepFail('2/7 D1 を探す', r);
  stepOk('2/7 D1 を探す', r);
  const found = Array.isArray(r.result) ? r.result.find((d) => d && d.name === cfg.dbName) : null;
  let dbId = found ? found.uuid : '';
  if (!found) {
    r = await cf('POST', `${A}/d1/database`, { json: { name: cfg.dbName, primary_location_hint: cfg.locationHint } });
    if (!r.ok) return stepFail('2/7 D1 を作る', r);
    stepOk('2/7 D1 を作る', r);
    dbId = r.result && r.result.uuid;
  }
  if (typeof dbId !== 'string' || !/^[0-9a-f-]{32,36}$/.test(dbId)) return fail('失敗: 2/7 D1 の ID の形が思っていたのと違います');

  // 3. 表の形（何回流しても同じ）
  r = await cf('POST', `${A}/d1/database/${dbId}/query`, { json: { sql: schema.SCHEMA_SQL } });
  if (!r.ok) return stepFail('3/7 D1 の表の形を流す', r);
  stepOk('3/7 D1 の表の形を流す', r);

  // 4. Worker があるか（無ければ1回目。keep_bindings は前の版があるときだけ付ける）
  r = await cf('GET', S);
  if (r.status !== 200 && r.status !== 404) return stepFail('4/7 Worker があるかを見る', r);
  const first = r.status === 404;
  say(`4/7 Worker があるかを見る: HTTP ${r.status}（${first ? '1回目' : '2回目から。画面で入れた秘密を残す'}）`);

  // 5. 上げる
  const metadata = {
    main_module: 'worker.mjs',
    compatibility_date: cfg.compatibilityDate,
    bindings: [{ type: 'd1', name: 'DB', database_id: dbId }],
    ...(first ? {} : { keep_bindings: ['secret_text'] }),
    observability: { enabled: true, logs: { enabled: true, invocation_logs: false } },
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  for (const f of files) {
    form.append(f, new Blob([fs.readFileSync(path.join(RELAY, f))], { type: 'application/javascript+module' }), f);
  }
  r = await cf('PUT', S, { form });
  if (!r.ok) return stepFail('5/7 Worker を上げる', r);
  stepOk(`5/7 Worker を上げる（${files.length} ファイル）`, r);

  // 6. workers.dev を有効にする
  r = await cf('POST', `${S}/subdomain`, { json: { enabled: true, previews_enabled: false } });
  if (!r.ok) return stepFail('6/7 workers.dev を有効にする', r);
  stepOk('6/7 workers.dev を有効にする', r);

  // 7. /health（Cloudflare の API のトークンは付けない。サービストークンは send がこの URL にだけ付ける）
  const url = `https://${cfg.scriptName}.${sub}.workers.dev`;
  const healthBase = typeof env.RELAY_HEALTH_BASE === 'string' && TEST_BASE.test(env.RELAY_HEALTH_BASE) ? env.RELAY_HEALTH_BASE : url;
  healthUrl = `${healthBase}/health`;
  // Access に止められた（3xx・401・403）。中継の JSON（Worker まで来て札が無い・違う）か、Access の前で止められたかを書き分ける
  const blocked = (st, fromRelay) => {
    const where = `7/7 /health: HTTP ${st}（${fromRelay ? '中継がサービストークンの札を受け取れませんでした' : 'Cloudflare Access の前で止められました'}）`;
    if (svc) return fail(`失敗: ${where}。Access の決まりに Service Auth（サービストークン）の決まりがあるかを確かめてください（利用者の用意の 7。値はこの記録に出しません）`);
    const need = 'GitHub の Environments → relay に CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET を入れてください（利用者の用意の 7）';
    if (env.GITHUB_EVENT_NAME === 'push') { say(`${where}。中継は上げました。確かめるには ${need}`); return 0; }
    return fail(`失敗: ${where}。${need}`);
  };
  let last = 0;
  let notReady = false;
  for (let i = 0; i < HEALTH_TRIES; i++) {
    if (i > 0) await sleep(HEALTH_GAP_MS);
    let j = null;
    try {
      const res = await send(healthUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      last = res.status;
      try { j = JSON.parse(await res.text()); } catch (_) { j = null; }
    } catch (_) { last = 0; }
    const relayErr = j && typeof j === 'object' && typeof j.error === 'string' ? j.error : '';
    if ((last >= 300 && last < 400) || last === 401 || last === 403) return blocked(last, (last === 401 && relayErr === 'login') || (last === 403 && relayErr === 'denied'));
    notReady = last === 503 && relayErr === 'not-ready';
    if (last !== 200 || !j || j.ok !== true || !j.ready || typeof j.ready !== 'object') continue;
    const yes = (k) => (j.ready[k] === true ? 'はい' : 'まだ');
    say(`7/7 /health: HTTP 200`);
    say(`公開した URL: ${url}`);
    say(`ready: db ${yes('db')}・openai ${yes('openai')}・access ${yes('access')}・domains ${yes('domains')}`);
    if (j.ready.db !== true) return fail('失敗: D1 の表が見えません（/health の ready.db がまだ）。もう一度 Run workflow を押し、続くときは作り手に知らせてください');
    const place = `Workers & Pages → ${cfg.scriptName} → Settings → Variables and Secrets。種類は Secret`;
    const missing = Object.keys(SECRET_NAMES).filter((k) => j.ready[k] !== true).map((k) => SECRET_NAMES[k]);
    if (missing.length) say(`Cloudflare の画面で秘密の欄を入れてください: ${missing.join('・')}（${place}）`);
    if (j.ready.access !== true) say(`Cloudflare の画面で TEAM_DOMAIN と POLICY_AUD を入れてください（利用者の用意の 8。${place}）`);
    return 0;
  }
  if (notReady) {
    return fail('失敗: 7/7 /health: HTTP 503（中継が Access の確かめを断りました: not-ready）。Cloudflare の画面の TEAM_DOMAIN と POLICY_AUD が、natsu-relay の Access の app のものかを確かめてください（利用者の用意の 8）。合っていれば、少し待ってからもう一度 Run workflow を押してください。値はこの記録に出しません');
  }
  return fail(`失敗: 7/7 中継の /health に届きませんでした（${last ? `HTTP ${last}` : '返事なし'}）。${HEALTH_GAP_MS / 1000} 秒おきに ${HEALTH_TRIES} 回試しました`);
}

module.exports = { deploy };

if (require.main === module) {
  deploy().then((code) => { process.exitCode = code; }, () => {
    process.stdout.write('失敗: 思わぬ誤りで止まりました（中身は記録に出しません）\n');
    process.exitCode = 1;
  });
}
