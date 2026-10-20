/*
 * stt-cloud.js — クラウドの文字起こしの口（第1c回 OL2。RF27・RF29・RF30・F15。第1d回 RL9 で中継へ送る形にした）
 *
 *  - PRESETS          文字起こしをした相手の名前（id・label）だけ。古いページの経路の行（☁ 文字起こし: クラウド（Groq（無料枠））…・
 *                     クラウド（OpenAI））と、議事録の DB の子の表示の名前のために残す。送り先の URL・モデルは持たない
 *                     （第1d回 A-4・F11: PC から OpenAI・Groq へ直に送る道（transcribeCloud・resolveProvider・fixedProvider）と、
 *                     鍵の確かめ（checkKey・keyErrorKind・CHECK_WAV）を消した。送り先は中継（src/relay.js の relayProvider）だけ）
 *  - buildMultipart   multipart/form-data の本文を組み立てる
 *  - postForm         net.request で1回送り、返事を読む（既定は redirect: 'error'。時間切れつき。第1d回 A-10: session を渡すと
 *                     Access の cookie の道（useSessionCookies・X-Requested-With）で、redirect: 'manual' の転送にはついて行かずに止める）
 *  - isOfflineError   その区間を手元でやり直してよい失敗か（切れた・時間切れ・届かない）
 *  - transcribeRelay  1つの区間の WAV を中継（relay/。第1d回 RL9）へ生のまま送って文字を返す（言語とヒントは見出し。
 *                     第1d回 A-10: session があれば Access の cookie で送り、見出しに札を入れない。無ければ今の札の Authorization（A-11 まで残す移り目）。
 *                     429 の待ち・ヒントで 400 なら外して1回だけ送り直す）
 *  - isAccessHost     ホストが <チーム>.cloudflareaccess.com の形か（チームの名前はアプリに書かない。第1d回 A-10）
 *  - classifyAuth     中継への答えの 3xx・401・403 → 'login' | 'denied' | 'server' | ''（Access と会社の通信の検査の答えを取り違えない。F19）。
 *                     src/relay.js が同じ関数を出す（relay.js がこのファイルを読むので、ここに置いて読み込みの輪を作らない）
 *  - relayErrorCode   中継の答えの本文 → 中継の JSON の error の符号（中継の形でなければ ''）
 *  - redoLocally      中継の失敗のあと、その区間を手元でやり直すか（rate・rate-long のほかは全部 true）
 *  - cloudErrorText   区間の失敗の文（知らせ M9）
 *
 * 資料（計画「調べた結果」）:
 *  - OpenAI: https://developers.openai.com/api/docs/guides/speech-to-text
 *    中継（relay/stt.mjs）が POST /v1/audio/transcriptions の multipart を組み立てて送る。ファイルは 25MB まで。
 *    ヒントがモデルの長さの上限を越えると要求を断る（中継は 400 bad-request で返す）。
 *  - 75 秒・16kHz・モノラル・16 ビットの WAV は約 2.4MB で、25MB の上限の内（分けずに1回で送る）。
 *
 * 決まり:
 *  - Electron のモジュールは読み込まない。通信は呼ぶ側から request（本番は net.request）をもらう。
 *    Node のグローバルの通信の関数は使わない（RF2）。
 *  - 札は Authorization: Bearer の見出しだけに入れる。ほかの見出し・本文・例外・文には入れない（RF30・RF32）。
 *    redirect: 'error' で、札を別の宛先へ運ばない。
 *  - （第1d回 A-10・RL9）Access の cookie は Chromium が session（メモリの partition）から付ける。アプリは cookie の値を見出し・本文・
 *    例外・文に入れない（Authorization も cf-access-token も付けない）。転送（Access のログインの画面への 302 など）には
 *    redirect: 'manual' でついて行かない（followRedirect を呼ばない）。
 *  - 返事の見出しは Electron では値が配列のことがあるので hget（engine-fetch.js）で読む。
 */
'use strict';

const { hget, classifyNetError } = require('./engine-fetch');

// 文字起こしをした相手の名前（ページの route.stt.provider → 経路の行の名前）。groq・custom は古いページのためだけに残す
const PRESETS = Object.freeze({
  groq:   Object.freeze({ id: 'groq',   label: 'Groq（無料枠）' }),
  openai: Object.freeze({ id: 'openai', label: 'OpenAI' }),
  custom: Object.freeze({ id: 'custom', label: 'そのほか' }),
});
const WAIT_CAP_MS = 120000;     // 1つの区間で 429 を待つ合計の上限
const LONG_WAIT_SEC = 90;       // retry-after がこれを越えたら待たずに「上限」（1日の上限など）
const SEND_TIMEOUT_MS = 120000; // 1回の送りの上限（75 秒の音声の返事が来ないとき）
const DEFAULT_RETRY_SEC = 2;    // retry-after が無い・日付の形のとき
const REPLY_MAX_BYTES = 4 * 1024 * 1024; // 文字起こしの返事の上限（これを越える返事は読まない）

const OFFLINE_CODES = new Set(['offline', 'cert', 'proxy', 'timeout', 'net']);

// CloudSttError の符号（第1d回 A-10 で 'denied' を足した: 中継の JSON の 403 denied。その区間は手元でやり直す）
class CloudSttError extends Error {
  constructor(code, { status, retryAfter, scope } = {}) {
    super(`cloud-stt: ${code}${status ? ` (${status})` : ''}`);
    this.name = 'CloudSttError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
    if (scope !== undefined) this.scope = scope;   // daily-cap の 'user' | 'all'（第1d回）
  }
}

/** 'offline' | 'cert' | 'proxy' | 'timeout' | 'net' なら true（呼び手は、その区間を手元でやり直してよい） */
function isOfflineError(e) {
  return Boolean(e && e instanceof CloudSttError && OFFLINE_CODES.has(e.code));
}

const quoteName = (s) => String(s).replace(/[\r\n"]/g, '_');

/** fields: [[name, value]]、file: { name, filename, type, data: Buffer } → Buffer */
function buildMultipart(fields, file, boundary) {
  const parts = [];
  for (const [name, value] of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quoteName(name)}"\r\n\r\n`, 'utf8'));
    parts.push(Buffer.from(String(value), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quoteName(file.name)}"; filename="${quoteName(file.filename)}"\r\n`
      + `Content-Type: ${quoteName(file.type || 'application/octet-stream')}\r\n\r\n`, 'utf8'));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(parts);
}

// 通信の失敗 → CloudSttError の符号（cert・proxy・offline・net）
function netCode(e) {
  const k = classifyNetError(e);
  if (k === 'cert') return 'cert';
  if (k === 'proxy' || k === 'proxy-auth') return 'proxy';
  if (k === 'offline') return 'offline';
  return 'net';
}

// ================= Access の答えの分け方（第1d回 A-10。F19） =================
const ACCESS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

/** host が <チーム>.cloudflareaccess.com（1つのラベル）なら true。cloudflareaccess.com そのもの・後ろに続くホストは偽 */
function isAccessHost(host) {
  return typeof host === 'string' && ACCESS_HOST.test(host.toLowerCase());
}

/**
 * 中継への答え → 'login' | 'denied' | 'server' | ''（ほかの状態は ''。今の分け方のまま）。
 *  - 3xx: 行き先（location）のホストが isAccessHost → 'login'（Access のログインの画面へ戻された）。ほかは 'server'（ついて行かない）
 *  - 401: 中継の JSON { error: 'login' } → 'login'。中継の形でなく cf-ray の見出しがある → 'login'（Access の前。X-Requested-With を付けた
 *         要求に Access は 302 の代わりに 401 を返す）。ほか（cf-ray の無い HTML の 401 = 会社の通信の検査など）は 'server'（ログインを消さない）
 *  - 403: 中継の JSON { error: 'denied' } → 'denied'。ほかは cf-ray があっても 'server'（Cloudflare の 403 は Access のほかにも出る）
 * cf-ray は見出しがあるかだけを見る（値は記録に写さない）。body は Buffer か文字。headers は値が配列でもよい（hget）
 */
function classifyAuth({ status, headers, body, location } = {}) {
  const st = Number(status);
  if (st >= 300 && st <= 399) {
    let host = '';
    try { host = new URL(String(location)).hostname; } catch (_) { host = ''; }
    return isAccessHost(host) ? 'login' : 'server';
  }
  if (st === 401) {
    const code = relayErrorCode(body);
    if (code === 'login') return 'login';
    return !code && hget(headers || {}, 'cf-ray') != null ? 'login' : 'server';
  }
  if (st === 403) return relayErrorCode(body) === 'denied' ? 'denied' : 'server';
  return '';
}

/**
 * 1回送って返事を全部読む → Promise<{ status, headers, body: Buffer }>。
 * 通信の失敗・時間切れは CloudSttError（cert・proxy・offline・net・timeout）で断る。
 * method は既定 POST。redirect は既定 'error'（3xx は通信の失敗）。
 * 第1d回 A-10: session（Electron の session。メモリの partition）を渡すと、useSessionCookies: true と見出し X-Requested-With: XMLHttpRequest を
 * 付ける（cookie は Chromium が付ける）。redirect: 'manual' の 'redirect' イベントでは followRedirect を呼ばず、その場で
 * classifyAuth の答えの CloudSttError（'login' か 'server'）で終え、要求を取り消す（後から来る 'abort'・'error'・'response' は捨てる）
 */
function postForm({ request, url, headers = {}, body = null, timeoutMs = SEND_TIMEOUT_MS, method = 'POST', session = null, redirect = 'error' }) {
  return new Promise((resolve, reject) => {
    let done = false; let timer = null; let req = null;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (err) {
        try { if (req) req.abort(); } catch (_) { /* もう閉じた */ }
        reject(err);
      } else resolve(val);
    };
    try {
      const opts = { method, url, redirect };
      const all = { ...headers };
      if (session) {
        opts.session = session;
        opts.useSessionCookies = true;
        all['X-Requested-With'] = 'XMLHttpRequest';
      }
      req = request(opts);
      for (const [k, v] of Object.entries(all)) req.setHeader(k, v);
    } catch (e) {
      finish(new CloudSttError(netCode(e)));
      return;
    }
    req.on('response', (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > REPLY_MAX_BYTES) { finish(new CloudSttError('bad-reply', { status: res.statusCode })); return; }
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      });
      res.on('end', () => finish(null, { status: res.statusCode, headers: res.headers || {}, body: Buffer.concat(chunks) }));
      res.on('error', (e) => finish(new CloudSttError(netCode(e))));
      res.on('aborted', () => finish(new CloudSttError('net')));
    });
    // 転送にはついて行かない（followRedirect を呼ばない）。redirect: 'manual' のときだけ来る
    req.on('redirect', (status, _method, redirectUrl, resHeaders) => {
      finish(new CloudSttError(classifyAuth({ status, headers: resHeaders, location: redirectUrl }) || 'server', { status }));
    });
    // 認証を求められても名乗らない（取り消すと、401 はそのまま返事として届く。プロキシの認証は error で来る）
    req.on('login', (_info, cb) => { try { cb(); } catch (_) { /* 取り消し済み */ } });
    req.on('error', (e) => finish(new CloudSttError(netCode(e))));
    req.on('abort', () => finish(new CloudSttError('net')));
    timer = setTimeout(() => { timer = null; finish(new CloudSttError('timeout')); }, timeoutMs);
    try {
      if (body) req.write(body);
      req.end();
    } catch (e) {
      finish(new CloudSttError(netCode(e)));
    }
  });
}

// retry-after の秒（数字の秒だけ読む。無い・日付の形は 2 秒。0 は 1 秒にする: 待たずに打ち続けない）
function retryAfterSec(headers) {
  const v = String(hget(headers, 'retry-after') ?? '').trim();
  if (!/^\d+$/.test(v)) return DEFAULT_RETRY_SEC;
  return Math.max(1, Number(v));
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 中継（第1d回 RL9・F5） =================
const RELAY_CODE = /^[a-z-]{1,24}$/;
const RELAY_LANG = /^[a-z]{2,3}$/;

/** 中継の答えの本文（Buffer か文字）→ { error: '<符号>' } の符号。JSON で /^[a-z-]{1,24}$/ のときだけ。ほかは '' */
function relayErrorCode(body) {
  let j;
  try { j = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body == null ? '' : body)); } catch (_) { return ''; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return '';
  return typeof j.error === 'string' && RELAY_CODE.test(j.error) ? j.error : '';
}

/**
 * 中継の失敗のあと、その区間を手元（whisper）でやり直すか。'rate'・'rate-long'（OpenAI の短い 429 を待ちきれなかった。
 * RF29 のまま WAV を残す）のほかは全部 true（通信の符号・login・server・upstream-auth・quota・daily-cap・too-large・
 * bad-request・bad-reply・知らない符号・CloudSttError でない失敗）。録音と文字起こしは中継に頼らない
 */
function redoLocally(e) {
  return !(e instanceof CloudSttError && (e.code === 'rate' || e.code === 'rate-long'));
}

/**
 * 1つの区間の WAV を中継の POST {base}/v1/audio/transcriptions へ生のまま送り、文字を返す。失敗は CloudSttError を投げる。
 * 見出し: Content-Type: audio/wav・X-Natsu-Language（/^[a-z]{2,3}$/ のときだけ。auto は付けない）・
 *         X-Natsu-Prompt（ヒントを encodeURIComponent。空なら付けない）。モデルは中継が決める。
 * 第1d回 A-10: session があれば Access の cookie で送る（postForm の session・redirect: 'manual'。X-Requested-With が付き、札の見出しは
 *         付けない）。session が無ければ今の札の Authorization: Bearer <札> と redirect: 'error'（今の main がまだ札でログインする
 *         移り目。A-11 で札の道を消す）。
 * 答えの分け方（中継の JSON の error の符号で。中継の形でない答えは 'server' にして、ログインを消させない）:
 *  - 3xx（session の道）・401・403 → classifyAuth（'login'・'denied'・'server'）。cf-ray のある中継の形でない 401 と、Access のホストへの
 *    3xx だけがログイン切れ。中継の JSON の 403 denied は 'denied'
 *  - 429 daily-cap → 'daily-cap'（retryAfter・scope）。ほかの 429 は retry-after だけ待って送り直す（LONG_WAIT_SEC を越えれば待たずに
 *    'rate-long'、待ちの合計が waitCapMs を越えれば 'rate'。RF29）
 *  - 400 bad-request: ヒントを送っていたら外して1回だけ送り直す（onPromptDropped。F15）。それでも 400 なら 'bad-request'
 *  - 415 not-wav → 'bad-request'・413 → 'too-large'・502 upstream-auth → 'upstream-auth'・503 quota → 'quota'・ほかは 'server'
 */
async function transcribeRelay(wav, { request, provider, session, token, language, prompt, sleep = defaultSleep, onWait, onPromptDropped, timeoutMs = SEND_TIMEOUT_MS, waitCapMs = WAIT_CAP_MS } = {}) {
  const body = Buffer.isBuffer(wav) ? wav : Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  let usePrompt = Boolean(prompt);
  let waitedMs = 0;
  for (;;) {
    const headers = { 'Content-Type': 'audio/wav' };
    if (!session) headers.Authorization = `Bearer ${token}`;   // 札の道（A-11 で消す）
    if (typeof language === 'string' && RELAY_LANG.test(language)) headers['X-Natsu-Language'] = language;
    if (usePrompt) headers['X-Natsu-Prompt'] = encodeURIComponent(String(prompt));
    const res = await postForm({ request, url: `${provider.base}/v1/audio/transcriptions`, headers, body, timeoutMs,
      ...(session ? { session, redirect: 'manual' } : {}) });
    const st = res.status;
    if (st >= 200 && st <= 299) {
      let j;
      try { j = JSON.parse(res.body.toString('utf8')); } catch (_) { throw new CloudSttError('bad-reply', { status: st }); }
      if (!j || typeof j.text !== 'string') throw new CloudSttError('bad-reply', { status: st });
      return j.text;
    }
    const code = relayErrorCode(res.body);
    const auth = classifyAuth({ status: st, headers: res.headers, body: res.body });
    if (auth) throw new CloudSttError(auth, { status: st });
    if (st === 429 && code === 'daily-cap') {
      let j = null;
      try { j = JSON.parse(res.body.toString('utf8')); } catch (_) { j = null; }
      const ra = j && Number.isInteger(j.retryAfter) && j.retryAfter > 0 ? j.retryAfter : retryAfterSec(res.headers);
      const scope = j && (j.scope === 'user' || j.scope === 'all') ? j.scope : undefined;
      throw new CloudSttError('daily-cap', { status: st, retryAfter: ra, scope });
    }
    if (st === 429) {   // 中継の busy（OpenAI の 429 の retry-after）。中継の形でない 429 も同じ待ち
      const waitSec = retryAfterSec(res.headers);
      if (waitSec > LONG_WAIT_SEC) throw new CloudSttError('rate-long', { status: st, retryAfter: waitSec });
      if (waitedMs + waitSec * 1000 > waitCapMs) throw new CloudSttError('rate', { status: st, retryAfter: waitSec });
      waitedMs += waitSec * 1000;
      if (onWait) onWait(waitSec);
      await sleep(waitSec * 1000);
      continue;
    }
    if (st === 400 && code === 'bad-request' && usePrompt) {
      usePrompt = false;
      if (onPromptDropped) onPromptDropped();
      continue;
    }
    if (st === 400 && code === 'bad-request') throw new CloudSttError('bad-request', { status: st });
    if (st === 415 && code === 'not-wav') throw new CloudSttError('bad-request', { status: st });
    if (st === 413) throw new CloudSttError('too-large', { status: 413 });
    if (st === 502 && code === 'upstream-auth') throw new CloudSttError('upstream-auth', { status: st });
    if (st === 503 && code === 'quota') throw new CloudSttError('quota', { status: st });
    throw new CloudSttError('server', { status: st });
  }
}

/** 区間の失敗の文（知らせ M9）。札・本文を含めない */
function cloudErrorText(e, label) {
  const code = e && e.code;
  const status = e && e.status;
  let why;
  if (code === 'rate' || code === 'rate-long') why = '上限に達しました';
  else if (code === 'auth') why = '鍵が正しくありません';
  else if (code === 'bad-request' || code === 'too-large' || code === 'server') why = status ? `送り先が受け付けませんでした（${status}）` : '送り先が受け付けませんでした';
  else why = '送り先が返事を返しませんでした';
  return `${label}: ${why}`;
}

module.exports = { PRESETS, WAIT_CAP_MS, LONG_WAIT_SEC, SEND_TIMEOUT_MS, buildMultipart, postForm, CloudSttError, isOfflineError,
  cloudErrorText, transcribeRelay, relayErrorCode, redoLocally, isAccessHost, classifyAuth };
