#!/usr/bin/env node
'use strict';
// NaTsu ヘルプセンター（help/）を Cloudflare に出す（ヘルプセンター H-10。HF1・HF5・RF50・R4・R5・R10。計画 docs/plans/2026-10-20-help.md）。
// wrangler も npm の依存も使わず、Node に入っている fetch・FormData・Blob・crypto だけで Cloudflare の REST API を呼ぶ。
// GitHub Actions の help-deploy.yml から走る（環境は中継と同じ relay。R5）。
//
//   node tools/help-deploy.js
//     環境変数: CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID（GitHub の環境 relay の秘密。手順の env でだけ渡す）
//              GITHUB_EVENT_NAME（push なら、秘密が2つとも無いときは何もせず 0 で終わる。手で押したとき・手元では 1）
//     試しだけ: CF_API_BASE・HELP_CHECK_BASE（どちらも http://127.0.0.1:<port> の形のときだけ効く。ほかは本物の URL）
//
// 手順: 1 作る（tools/help-build.js の build。ファイルは 2000 まで・1つ 5 MB まで）→ 2 workers.dev のサブドメインを読む →
//       3 中継の D1 を名前で探す（作らない。無ければ「先に relay-deploy」で 1。門は止めたメールを読む: R4）→
//       4 資産の上げの session（manifest: 道 → { hash, size }。hash は中身の base64 と拡張子をつないだ文字の SHA-256 の先頭 32 字）→
//       5 頼まれたバケットを1つずつ上げる（上げの札だけを付ける。欄の名前もファイルの名前も指紋。中身は base64）→ 済みの札 →
//       6 Worker があるかを見る（無ければ1回目: keep_bindings を付けない）→ 7 門（relay/help-gate.mjs と、それが import でたどるファイル）を
//       上げる（バインドは ASSETS と DB だけ。assets.config.run_worker_first: true。2回目からは keep_bindings: ['secret_text']）→
//       8 workers.dev を有効にする → 9 漏れの確かめ（leakCheck。ログインしていない GET で中身が返れば赤）。
//       9 は新しい版が答えるまで待つ（run 39520207427 の調べ: 画面の見本の Hello World! で作った Worker の前の版が、上げた約 1 秒後も
//       どの道にも 200 を返し、それを漏れと見ていた）。新しい版の印は、門の印（gate）・Access への転送と断り・ヘルプのページの印（page）・
//       検索の索引の形。2xx は本文がヘルプの中身（page の印か索引の形）のときだけ漏れ。知らない 2xx は前の版で、漏れでも成功でもない
//       （間を延ばしながら合わせて約 90 秒待ち、まだなら「新しい版がまだ効いていません」で赤）。
// 守り（HF5）:
//   - トークンは Cloudflare の API の Authorization にだけ入れる。上げの札はバケットの要求にだけ、済みの札は Worker の上げの本文にだけ。
//     漏れの確かめには見出しも cookie も付けない。どれも出力に出さない。
//   - 転送は追わない（どの要求も redirect: 'manual'。Workers の fetch と同じ決まり。3xx は失敗か、漏れの確かめの分け方で扱う）。
//   - 出すのは手順の名前・HTTP の状態の番号・Cloudflare のエラーの番号・公開した URL・確かめの結果だけ。答えの本文・転送の行き先
//     （チームの名前が入る）・例外の文は出さない（このリポジトリの Actions の記録は誰でも読める）。失敗のときだけ、本文の形
//     （JSON・HTML・空・ほか）・決まった字に洗った errors[].message・cf-ray を足す（tools/lib/cf-api.js。run 39520207427 の調べ）。
//   - スクリプトの名前は help/deploy-config.json の natsu-help だけ（中継の natsu-relay とは違う名前でなければ止まる）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeCf, why, hint: hintFor, checkSecrets } = require('./lib/cf-api');

const ROOT = path.join(__dirname, '..');
const RELAY = path.join(ROOT, 'relay');
const TEST_BASE = /^http:\/\/127\.0\.0\.1:\d{2,5}(\/[A-Za-z0-9/_-]*)?$/;
const REAL_API = 'https://api.cloudflare.com/client/v4';
const CHECK_TRIES = 12;
const CHECK_GAP_MS = 5000;
const NEW_WAIT_MS = 90000;                              // 前の版が答える間、新しい版を待つ合わせての長さ
const NEW_WAIT_GAPS = [1000, 2000, 4000, 8000, 15000];  // その間の待ち（最後の値をくり返す）
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const GATE_MARK = '<meta name="natsu-help" content="gate">';
const PAGE_MARK = /<meta\s+name=["']?natsu-help["']?\s+content=["']?page\b/i;   // ヘルプのページの印（tools/lib/help-page.js）
const INDEX_SHAPE = /^\s*\{\s*"v"\s*:\s*\d+\s*,\s*"items"\s*:\s*\[/;            // 検索の索引の形（tools/help-build.js の searchIndex）
const ACCESS_HOST = '.cloudflareaccess.com';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PERMS = 'Workers Scripts: Edit と D1: Edit';
const SETUP = 'GitHub のリポジトリの Settings → Environments → relay に CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID を入れてください（値はこの記録に出しません）';
const LEAK = '失敗: ログインせずに中身が見えます。すぐに Cloudflare の画面で natsu-help の Access を確かめてください';
const READYING = '準備中（Access の app と秘密の欄がまだ。利用者の用意の 1〜5）';
const REFUSED = 'Worker が断りました。natsu-help の Access が有効かを確かめてください（利用者の用意の 1）';
const GUARDED = 'Access に守られています';
const WAITING = `9/9 漏れの確かめ: まだ前の版が答えています（HTTP 200）。新しい版が効くまで最長 ${NEW_WAIT_MS / 1000} 秒待ちます`;
// 資産の型（拡張子の表。表に無ければ application/null = 型を決めない）
const TYPES = {
  html: 'text/html', css: 'text/css', js: 'application/javascript', json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', ico: 'image/x-icon', woff2: 'font/woff2', txt: 'text/plain',
};

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const extOf = (f) => path.extname(f).slice(1);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function readDeployConfig() {
  const c = readJson(path.join(ROOT, 'help', 'deploy-config.json'));
  const relay = readJson(path.join(RELAY, 'deploy-config.json'));
  if (!NAME.test(c.scriptName) || c.scriptName === relay.scriptName || !/^\d{4}-\d{2}-\d{2}$/.test(c.compatibilityDate)
    || !/^[a-z0-9-]{1,40}\.mjs$/.test(c.entry) || !NAME.test(relay.dbName)) {
    throw new Error('help/deploy-config.json の形が違う');
  }
  return { scriptName: c.scriptName, compatibilityDate: c.compatibilityDate, entry: c.entry, dbName: relay.dbName };
}

// 門のファイルと、それが import でたどる relay/ のファイル（./x.mjs だけ。ほかの形は読まない）
function gateFiles(entry) {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    if (!/^[a-z0-9-]{1,40}\.mjs$/.test(f)) throw new Error('relay/ の外を読む');
    seen.add(f);
    const src = fs.readFileSync(path.join(RELAY, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1] || m[2];
      if (!spec.startsWith('./')) throw new Error('relay/ の外を読む');
      walk(spec.slice(2));
    }
  };
  walk(entry);
  return [...seen].sort();
}

// 作ったフォルダの全部のファイル（区切りは /。並びは決まった順）
function listFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

/** 資産の指紋（資料の見本のとおり: 中身の base64 と拡張子（. を除く）をつないだ文字の SHA-256 の16進の先頭 32 字） */
function assetHash(base64, file) {
  return crypto.createHash('sha256').update(base64 + extOf(file)).digest('hex').slice(0, 32);
}

// featured の最初の記事の URL（無ければ作った記事の最初。どちらも無ければ無し）
function firstArticlePath(root, built) {
  try {
    const f = readJson(path.join(root, 'help', 'site.json')).featured;
    if (Array.isArray(f) && typeof f[0] === 'string' && /^[a-z0-9-]{1,40}\/[a-z0-9-]{1,40}$/.test(f[0])) return `/${f[0]}/`;
  } catch (_) { /* 次の手へ */ }
  const a = built && Array.isArray(built.articles) ? built.articles[0] : null;
  return a && typeof a.url === 'string' && /^\/[a-z0-9-]{1,40}\/[a-z0-9-]{1,40}\/$/.test(a.url) ? a.url : null;
}

async function drop(res) {
  try { if (res.body) await res.body.cancel(); } catch (_) { /* 捨てるだけ */ }
}

// 1つの道を、ログインせずに（見出しも cookie も付けず）開く。転送は追わない。答えの本文は外に出さない
async function probe(url, fetchFn) {
  let res;
  try {
    res = await fetchFn(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000) });
  } catch (_) {
    return { kind: 'retry', st: 0 };
  }
  const st = res.status;
  if (st >= 200 && st < 300) {
    // 本文がヘルプの中身なら漏れ。知らない本文（前の版の Hello World! など）は前の版（漏れでも成功でもない。新しい版を待つ）
    let text = '';
    try { text = (await res.text()).slice(0, 65536); } catch (_) { text = ''; }
    const ours = PAGE_MARK.test(text) || INDEX_SHAPE.test(text);
    return ours ? { kind: 'leak', st } : { kind: 'old', st };
  }
  if (st >= 300 && st < 400) {
    let u = null;
    try { u = new URL(res.headers.get('location') || '', url); } catch (_) { u = null; }
    await drop(res);
    const host = u ? u.hostname : '';
    const toAccess = u && u.protocol === 'https:' && host.endsWith(ACCESS_HOST) && LABEL.test(host.slice(0, -ACCESS_HOST.length));
    return toAccess ? { kind: 'access', st } : { kind: 'leak', st };
  }
  if (st === 401 || st === 403 || st === 503) {
    let text = '';
    try { text = (await res.text()).slice(0, 65536); } catch (_) { text = ''; }
    if (text.includes(GATE_MARK)) return { kind: 'gate', st };
    return st === 503 ? { kind: 'retry', st } : { kind: 'access', st };   // 門の印の無い 401・403 は Access の前で止められた
  }
  await drop(res);
  return { kind: 'retry', st };
}

/**
 * ログインしていない GET で、ヘルプの中身が返らないことを確かめる（HF1）。投げない。
 * 中身の 2xx（ページの印か検索の索引の形）と、Cloudflare Access のほかへの転送は、その場で ok: false。
 * 404 と届かないのは gapMs おきに tries 回まで試す。知らない 2xx（前の版）は、新しい版が答えるまで waitGaps の間をあけて
 * 合わせて waitMs まで待ち、まだなら ok: false（'stale'。漏れとは言わない）。
 * @returns {Promise<{ ok: boolean, state: 'guarded'|'refused'|'readying'|'leak'|'unreached'|'stale', lines: string[] }>}
 */
async function leakCheck({ base, paths, fetch: fetchFn = globalThis.fetch, sleep = sleepMs, tries = CHECK_TRIES, gapMs = CHECK_GAP_MS, waitMs = NEW_WAIT_MS, waitGaps = NEW_WAIT_GAPS }) {
  const lines = [];
  const got = new Map();
  const seen = new Map();                        // 道 → 最後の答え（retry か old）
  const probes = new Map(paths.map((p) => [p, 0]));
  const left = [];                               // 試し終えても決まらなかった道
  let pending = [...paths];
  let last = 0;
  let waited = 0;
  let oldGaps = 0;
  let told = false;
  for (let i = 0; pending.length; i++) {
    if (i > 0) {
      const gap = pending.some((p) => seen.get(p).kind === 'old') ? waitGaps[Math.min(oldGaps++, waitGaps.length - 1)] : gapMs;
      await sleep(gap);
      waited += gap;
    }
    const next = [];
    for (const p of pending) {
      const v = await probe(base + p, fetchFn);
      probes.set(p, probes.get(p) + 1);
      if (v.kind === 'leak') {
        lines.push(`9/9 漏れの確かめ ${p}: HTTP ${v.st}`);
        lines.push(LEAK);
        return { ok: false, state: 'leak', lines };
      }
      if (v.kind === 'retry' || v.kind === 'old') {
        seen.set(p, v);
        next.push(p);
        if (v.kind === 'retry') last = v.st;
        continue;
      }
      got.set(p, v);
    }
    if (!told && next.some((p) => seen.get(p).kind === 'old')) { told = true; lines.push(WAITING); }
    pending = [];
    for (const p of next) {
      const more = seen.get(p).kind === 'old' ? waited < waitMs : probes.get(p) < tries;
      (more ? pending : left).push(p);
    }
  }
  const stale = left.filter((p) => seen.get(p).kind === 'old');
  if (stale.length) {
    lines.push(`失敗: 9/9 漏れの確かめ: 新しい版がまだ効いていません（${stale.join('・')} が、前の版の答え（HTTP 200。ヘルプのページでも門でもない）を返します。`
      + `${Math.round(waited / 1000)} 秒待ちました）。数分待ってから、もう一度 Run workflow を押してください`);
    return { ok: false, state: 'stale', lines };
  }
  if (left.length) {
    lines.push(`失敗: 9/9 漏れの確かめ: ${left.join('・')} に届きませんでした（${last ? `HTTP ${last}` : '返事なし'}）。${gapMs / 1000} 秒おきに ${tries} 回試しました`);
    return { ok: false, state: 'unreached', lines };
  }
  for (const p of paths) {
    const v = got.get(p);
    lines.push(`9/9 漏れの確かめ ${p}: HTTP ${v.st}（${v.kind === 'access' ? 'Access の前で止まった' : '門が断った'}）`);
  }
  const vs = [...got.values()];
  if (vs.some((v) => v.kind === 'gate' && v.st === 503)) { lines.push(READYING); return { ok: true, state: 'readying', lines }; }
  if (vs.some((v) => v.kind === 'gate')) { lines.push(REFUSED); return { ok: true, state: 'refused', lines }; }
  lines.push(GUARDED);
  return { ok: true, state: 'guarded', lines };
}

function defaultBuild({ root, out }) {
  return require('./help-build').build({ root, out });
}

/**
 * ヘルプを出す。終わりの番号（0 = 出せた・何もしなくてよい、1 = 出せなかった・漏れた）を返す（投げない）。
 * @param {{ env?: object, fetch?: Function, out?: (line: string) => void, sleep?: (ms: number) => Promise<void>, root?: string, build?: Function }} [o]
 */
async function deploy({ env = process.env, fetch = globalThis.fetch, out = (l) => process.stdout.write(l + '\n'), sleep = sleepMs, root = ROOT, build = defaultBuild } = {}) {
  const say = (l) => out(l);
  const fail = (l) => { say((env.GITHUB_ACTIONS === 'true' ? '::error::' : '') + l); return 1; };

  // ---- 秘密がそろっているか（値は出さない）
  const sec = checkSecrets(env, { setupText: SETUP, label: 'ヘルプ' });
  if (!sec.ok) {
    if (sec.code === 0) { say(sec.line); return 0; }
    return fail(sec.line);
  }
  const { token, acct } = sec;

  let cfg;
  let modules;
  try {
    cfg = readDeployConfig();
    modules = gateFiles(cfg.entry).map((f) => ({ name: f, bytes: fs.readFileSync(path.join(RELAY, f)) }));
  } catch (_) {
    return fail('ヘルプを出せません: help/deploy-config.json と relay/ の門のファイルを読めません');
  }

  // 1. 作る
  const dist = path.join(root, 'help', 'dist');
  let built;
  try {
    built = await build({ root, out: dist });
  } catch (e) {
    const where = e && typeof e.file === 'string' ? `${e.file}${Number.isInteger(e.line) ? `:${e.line}` : ''} ${typeof e.code === 'string' ? e.code : ''}`.trim() : '';
    const msg = e && e.name === 'HelpBuildError' && typeof e.message === 'string' ? ` ${e.message}` : '';
    return fail(`失敗: 1/9 ヘルプを作る（${where || '思わぬ誤り'}${msg}）`);
  }
  let files;
  const assets = new Map();   // 指紋 → { b64, type }
  const manifest = {};
  try {
    files = listFiles(dist);
    if (files.length > MAX_FILES) return fail(`失敗: 1/9 ヘルプを作る（ファイルが ${MAX_FILES} を越えました: ${files.length}）`);
    if (!files.includes('index.html')) return fail('失敗: 1/9 ヘルプを作る（index.html がありません）');
    for (const f of files) {
      const bytes = fs.readFileSync(path.join(dist, ...f.split('/')));
      if (bytes.length > MAX_FILE_BYTES) return fail(`失敗: 1/9 ヘルプを作る（${f} が 1 つ 5 MB の上限を越えました）`);
      const b64 = bytes.toString('base64');
      const hash = assetHash(b64, f);
      manifest['/' + f] = { hash, size: bytes.length };
      assets.set(hash, { b64, type: TYPES[extOf(f)] || 'application/null' });
    }
  } catch (_) {
    return fail('失敗: 1/9 ヘルプを作る（作ったファイルを読めません）');
  }
  const total = Object.values(manifest).reduce((n, m) => n + m.size, 0);
  say(`1/9 ヘルプを作る: ページ ${Array.isArray(built && built.pages) ? built.pages.length : 0}・ファイル ${files.length}・合わせて ${total} バイト`);

  const api = typeof env.CF_API_BASE === 'string' && TEST_BASE.test(env.CF_API_BASE) ? env.CF_API_BASE : REAL_API;
  const A = `/accounts/${acct}`;
  const S = `${A}/workers/scripts/${cfg.scriptName}`;
  const cf = makeCf({ token, api, fetch, timeoutMs: 60000 });
  const stepFail = (name, r) => fail(`失敗: ${name}（${why(r)}）${hintFor(r, PERMS)}`);
  const stepOk = (name, r) => say(`${name}: HTTP ${r.status}`);
  const sessionDenied = async () => {
    const g = await cf('GET', S);
    const head = `4/9 の調べ: ${cfg.scriptName}`;
    if (g.status === 404) {
      return `${head} はまだありません（HTTP 404）。新しい Worker を作るには、トークンに Workers の Admin の権限が要ります（Cloudflare の新しい役割の Editor は、今ある Worker を直すだけで作れません）。`
        + `Cloudflare の画面でトークンに Workers の Admin を足すか、${cfg.scriptName} という名前の Worker を画面で一度作ってから、もう一度 Run workflow を押してください`;
    }
    if (g.status === 200) return `${head} はあります（HTTP 200）。トークンが中継（natsu-relay）だけに絞られていないかを確かめてください`;
    if (g.status === 401 || g.status === 403) return `${head} を見られません（HTTP ${g.status}）。トークンが中継（natsu-relay）だけに絞られていないか、Workers の Admin の権限があるかを確かめてください`;
    return `${head} があるかを見る: ${why(g)}`;
  };

  // 2. workers.dev のサブドメイン
  let r = await cf('GET', `${A}/workers/subdomain`);
  const sub = r.ok && r.result && typeof r.result.subdomain === 'string' ? r.result.subdomain : '';
  if (r.status === 404 || (r.ok && !sub)) {
    return fail('ヘルプを出せません: Cloudflare の画面の Workers & Pages で、workers.dev のサブドメインを決めてください（会社名を含まない名前）');
  }
  if (!r.ok) return stepFail('2/9 workers.dev のサブドメインを読む', r);
  if (!LABEL.test(sub)) return fail('失敗: 2/9 workers.dev のサブドメインの形が思っていたのと違います');
  stepOk('2/9 workers.dev のサブドメインを読む', r);

  // 3. 中継の D1 を探す（作らない: R4）
  r = await cf('GET', `${A}/d1/database?name=${encodeURIComponent(cfg.dbName)}`);
  if (!r.ok) return stepFail('3/9 中継の D1 を探す', r);
  const found = Array.isArray(r.result) ? r.result.find((d) => d && d.name === cfg.dbName) : null;
  if (!found) {
    return fail(`失敗: 3/9 中継の D1（${cfg.dbName}）が見つかりません。先に relay-deploy を走らせてください（ヘルプは中継の止めたメールの表を読むので、D1 を作りません）`);
  }
  const dbId = found.uuid;
  if (typeof dbId !== 'string' || !/^[0-9a-f-]{32,36}$/.test(dbId)) return fail('失敗: 3/9 D1 の ID の形が思っていたのと違います');
  stepOk('3/9 中継の D1 を探す', r);

  // 4. 資産の上げの session
  r = await cf('POST', `${S}/assets-upload-session`, { json: { manifest } });
  if (!r.ok) {
    // 権限に断られたら、natsu-help があるかを1回だけ見て文を足す（状態の番号だけ。run 39520207427 の 4/9 の 403 の調べ）。
    // Cloudflare の新しい役割では、今ある Worker を直す Editor は新しい Worker を作れず、作るのは Workers の Admin
    // （https://developers.cloudflare.com/workers/authorization/ 。前の Workers Scripts: Edit に当たるのは Editor:
    // https://blog.cloudflare.com/workers-granular-authorization/ ）。中継（natsu-relay）は前からあるので、同じトークンでも通りうる（見立て）
    if (r.status === 401 || r.status === 403) say(await sessionDenied());
    return stepFail('4/9 資産の上げを始める', r);
  }
  const sessionJwt = r.result && typeof r.result.jwt === 'string' && /^[\x21-\x7e]{1,8192}$/.test(r.result.jwt) ? r.result.jwt : '';
  const buckets = r.result && Array.isArray(r.result.buckets) ? r.result.buckets : null;
  if (!sessionJwt || !buckets || !buckets.every((b) => Array.isArray(b) && b.every((h) => typeof h === 'string' && assets.has(h)))) {
    return fail('失敗: 4/9 資産の上げを始める（Cloudflare の答えが、作ったファイルと合いません）');
  }
  stepOk('4/9 資産の上げを始める', r);

  // 5. バケットを1つずつ上げる（上げの札だけを付ける）
  let doneJwt = buckets.length === 0 ? sessionJwt : '';
  let sent = 0;
  for (const bucket of buckets) {
    const form = new FormData();
    for (const h of bucket) {
      const a = assets.get(h);
      form.append(h, new Blob([a.b64], { type: a.type }), h);
    }
    r = await cf('POST', `${A}/workers/assets/upload?base64=true`, { form, bearer: sessionJwt });
    if (!r.ok) return stepFail('5/9 資産を上げる', r);
    sent += bucket.length;
    if (r.result && typeof r.result.jwt === 'string' && /^[\x21-\x7e]{1,8192}$/.test(r.result.jwt)) doneJwt = r.result.jwt;
  }
  if (!doneJwt) return fail('失敗: 5/9 資産を上げる（上げ終わりの札が返りませんでした）。もう一度 Run workflow を押してください');
  say(`5/9 資産を上げる: バケット ${buckets.length}・ファイル ${sent}`);

  // 6. Worker があるか（無ければ1回目。keep_bindings は前の版があるときだけ付ける）
  r = await cf('GET', S);
  if (r.status !== 200 && r.status !== 404) return stepFail('6/9 Worker があるかを見る', r);
  const first = r.status === 404;
  say(`6/9 Worker があるかを見る: HTTP ${r.status}（${first ? '1回目' : '2回目から。画面で入れた秘密を残す'}）`);

  // 7. 門を上げる
  const metadata = {
    main_module: cfg.entry,
    compatibility_date: cfg.compatibilityDate,
    bindings: [{ type: 'assets', name: 'ASSETS' }, { type: 'd1', name: 'DB', database_id: dbId }],
    assets: { jwt: doneJwt, config: { run_worker_first: true, html_handling: 'auto-trailing-slash', not_found_handling: '404-page' } },
    ...(first ? {} : { keep_bindings: ['secret_text'] }),
    observability: { enabled: true, logs: { enabled: true, invocation_logs: false } },
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  for (const m of modules) form.append(m.name, new Blob([m.bytes], { type: 'application/javascript+module' }), m.name);
  r = await cf('PUT', S, { form });
  if (!r.ok) return stepFail('7/9 Worker を上げる', r);
  stepOk(`7/9 Worker を上げる（${modules.length} ファイル）`, r);

  // 8. workers.dev を有効にする
  r = await cf('POST', `${S}/subdomain`, { json: { enabled: true, previews_enabled: false } });
  if (!r.ok) return stepFail('8/9 workers.dev を有効にする', r);
  stepOk('8/9 workers.dev を有効にする', r);

  // 9. 漏れの確かめ（トークンも見出しも付けない）
  const url = `https://${cfg.scriptName}.${sub}.workers.dev`;
  say(`公開した URL: ${url}`);
  const base = typeof env.HELP_CHECK_BASE === 'string' && TEST_BASE.test(env.HELP_CHECK_BASE) ? env.HELP_CHECK_BASE : url;
  const paths = [...new Set(['/', '/search-index.json', firstArticlePath(root, built)].filter(Boolean))];
  const c = await leakCheck({ base, paths, fetch, sleep });
  const tail = c.lines.pop();
  for (const l of c.lines) say(l);
  return c.ok ? (say(tail), 0) : fail(tail);
}

module.exports = { deploy, leakCheck, assetHash };

if (require.main === module) {
  deploy().then((code) => { process.exitCode = code; }, () => {
    process.stdout.write('失敗: 思わぬ誤りで止まりました（中身は記録に出しません）\n');
    process.exitCode = 1;
  });
}
