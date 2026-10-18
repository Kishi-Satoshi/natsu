/*
 * stt-cloud.js — OpenAI と同じ形の文字起こしの口（第1c回 OL2。RF27・RF29・RF30・F15）
 *
 *  - PRESETS          送り先の既定（Groq（無料枠）が既定・OpenAI・そのほか）
 *  - resolveProvider  設定から送り先を決める（そのほかは https だけ。http は 127.0.0.1・localhost だけ＝試験用）
 *  - buildMultipart   multipart/form-data の本文を組み立てる
 *  - postForm         net.request で1回送り、返事を読む（redirect: 'error'。時間切れつき）
 *  - transcribeCloud  1つの区間の WAV を送って文字を返す（429 の待ち・ヒントで 400 なら外して1回だけ送り直す）
 *  - isOfflineError   その区間を手元でやり直してよい失敗か（切れた・時間切れ・届かない）
 *  - checkKey         鍵の確かめ（GET {base}/models の 200／401）
 *  - cloudErrorText   区間の失敗の文（知らせ M9）
 *
 * 資料（計画「調べた結果」）:
 *  - OpenAI: https://developers.openai.com/api/docs/guides/speech-to-text
 *            https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
 *    POST /v1/audio/transcriptions（multipart の file・model。language・prompt・response_format・temperature）。
 *    ファイルは 25MB まで。ヒントがモデルの長さの上限を越えると要求を断る。
 *  - Groq:   https://console.groq.com/docs/speech-to-text ・ https://console.groq.com/docs/rate-limits
 *    同じ形の口 https://api.groq.com/openai/v1/audio/transcriptions。prompt は 224 トークンまで。
 *    429 のときだけ retry-after（秒）を付ける。
 *  - 75 秒・16kHz・モノラル・16 ビットの WAV は約 2.4MB で、25MB の上限の内（分けずに1回で送る）。
 *
 * 決まり:
 *  - Electron のモジュールは読み込まない。通信は呼ぶ側から request（本番は net.request）をもらう。
 *    Node のグローバルの通信の関数は使わない（RF2）。
 *  - 鍵は Authorization: Bearer の見出しだけに入れる。ほかの見出し・本文・例外・文には入れない（RF30）。
 *    redirect: 'error' で、鍵を別の宛先へ運ばない。
 *  - 返事の見出しは Electron では値が配列のことがあるので hget（engine-fetch.js）で読む。
 */
'use strict';

const crypto = require('crypto');
const { hget, classifyNetError } = require('./engine-fetch');

const PRESETS = Object.freeze({
  groq:   Object.freeze({ id: 'groq',   label: 'Groq（無料枠）', base: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' }),
  openai: Object.freeze({ id: 'openai', label: 'OpenAI',          base: 'https://api.openai.com/v1',      model: 'gpt-4o-transcribe' }),
  custom: Object.freeze({ id: 'custom', label: 'そのほか',        base: '',                               model: '' }),
});
const WAIT_CAP_MS = 120000;     // 1つの区間で 429 を待つ合計の上限
const LONG_WAIT_SEC = 90;       // retry-after がこれを越えたら待たずに「上限」（1日の上限など）
const SEND_TIMEOUT_MS = 120000; // 1回の送りの上限（75 秒の音声の返事が来ないとき）
const DEFAULT_RETRY_SEC = 2;    // retry-after が無い・日付の形のとき
const REPLY_MAX_BYTES = 4 * 1024 * 1024; // 文字起こしの返事の上限（これを越える返事は読まない）

const LOCAL_HTTP_HOSTS = new Set(['127.0.0.1', 'localhost']);
const OFFLINE_CODES = new Set(['offline', 'cert', 'proxy', 'timeout', 'net']);

class CloudSttError extends Error {
  constructor(code, { status, retryAfter } = {}) {
    super(`cloud-stt: ${code}${status ? ` (${status})` : ''}`);
    this.name = 'CloudSttError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/** 'offline' | 'cert' | 'proxy' | 'timeout' | 'net' なら true（呼び手は、その区間を手元でやり直してよい） */
function isOfflineError(e) {
  return Boolean(e && e instanceof CloudSttError && OFFLINE_CODES.has(e.code));
}

// そのほかの送り先の base。https か、127.0.0.1・localhost の http だけ。資格情報・問い合わせ・断片の付いた URL は断る
function customBase(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol === 'https:') return s;
  if (u.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(u.hostname)) return s;
  return null;
}

/**
 * 設定 → { id, label, base, model, host, reachUrl } | { error: 'base' }
 * 既定の送り先（groq・openai）の base は sttBaseUrl で書き換えない。sttModel が空でなければ既定のモデルの代わりに使う。
 */
function resolveProvider({ sttProvider, sttBaseUrl, sttModel } = {}) {
  const p = Object.prototype.hasOwnProperty.call(PRESETS, sttProvider) ? PRESETS[sttProvider] : PRESETS.groq;
  let base = p.base;
  if (p.id === 'custom') {
    base = customBase(sttBaseUrl);
    if (!base) return { error: 'base' };
  }
  const m = String(sttModel == null ? '' : sttModel).trim();
  return { id: p.id, label: p.label, base, model: m || p.model, host: new URL(base).hostname, reachUrl: `${base}/models` };
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

/**
 * 1回送って返事を全部読む → Promise<{ status, headers, body: Buffer }>。
 * 通信の失敗・時間切れは CloudSttError（cert・proxy・offline・net・timeout）で断る。
 * method は既定 POST（checkKey は GET で使う）。
 */
function postForm({ request, url, headers = {}, body = null, timeoutMs = SEND_TIMEOUT_MS, method = 'POST' }) {
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
      req = request({ method, url, redirect: 'error' });
      for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
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

/**
 * 1つの区間の WAV を送り、文字を返す（cleanWhisperText は呼び手が掛ける）。失敗は CloudSttError を投げる。
 *  - 429: retry-after が LONG_WAIT_SEC 以下なら onWait(秒) → sleep → 送り直し。待ちの合計が waitCapMs を越えるなら 'rate'。
 *         越える retry-after は待たずに 'rate-long'
 *  - 400: prompt を送っていたら、prompt を外して1回だけ送り直す（onPromptDropped()。F15）。prompt の無い 400 は 'bad-request'
 */
async function transcribeCloud(wav, { request, provider, key, language, prompt, sleep = defaultSleep, onWait, onPromptDropped, timeoutMs = SEND_TIMEOUT_MS, waitCapMs = WAIT_CAP_MS } = {}) {
  let usePrompt = Boolean(prompt);
  let waitedMs = 0;
  for (;;) {
    const fields = [['model', provider.model]];
    if (language && language !== 'auto') fields.push(['language', language]);
    if (usePrompt) fields.push(['prompt', prompt]);
    fields.push(['response_format', 'json'], ['temperature', '0']);
    const boundary = crypto.randomBytes(16).toString('hex');
    const body = buildMultipart(fields, { name: 'file', filename: 'segment.wav', type: 'audio/wav', data: wav }, boundary);
    const res = await postForm({
      request,
      url: `${provider.base}/audio/transcriptions`,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: `Bearer ${key}` },
      body,
      timeoutMs,
    });
    const st = res.status;
    if (st >= 200 && st <= 299) {
      let j;
      try { j = JSON.parse(res.body.toString('utf8')); } catch (_) { throw new CloudSttError('bad-reply', { status: st }); }
      if (!j || typeof j.text !== 'string') throw new CloudSttError('bad-reply', { status: st });
      return j.text;
    }
    if (st === 401 || st === 403) throw new CloudSttError('auth', { status: st });
    if (st === 429) {
      const sec = retryAfterSec(res.headers);
      if (sec > LONG_WAIT_SEC) throw new CloudSttError('rate-long', { status: st, retryAfter: sec });
      if (waitedMs + sec * 1000 > waitCapMs) throw new CloudSttError('rate', { status: st, retryAfter: sec });
      waitedMs += sec * 1000;
      if (onWait) onWait(sec);
      await sleep(sec * 1000);
      continue;
    }
    if (st === 400 && usePrompt) {
      usePrompt = false;
      if (onPromptDropped) onPromptDropped();
      continue;
    }
    if (st === 413) throw new CloudSttError('too-large', { status: st });
    if (st >= 500) throw new CloudSttError('server', { status: st });
    throw new CloudSttError('bad-request', { status: st });
  }
}

/** 鍵の確かめ: GET reachUrl に Authorization → { ok: true } | { ok: false, code } */
async function checkKey({ request, provider, key, timeoutMs = 15000 }) {
  try {
    const res = await postForm({ request, url: provider.reachUrl, method: 'GET', headers: { Authorization: `Bearer ${key}` }, timeoutMs });
    if (res.status >= 200 && res.status <= 299) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'auth' };
    if (res.status === 429) return { ok: false, code: 'rate' };
    if (res.status >= 500) return { ok: false, code: 'server' };
    return { ok: false, code: 'bad-request' };
  } catch (e) {
    return { ok: false, code: e instanceof CloudSttError ? e.code : 'net' };
  }
}

/** 区間の失敗の文（知らせ M9）。鍵・本文を含めない */
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

module.exports = { PRESETS, WAIT_CAP_MS, LONG_WAIT_SEC, SEND_TIMEOUT_MS, resolveProvider, buildMultipart, postForm, CloudSttError, isOfflineError, transcribeCloud, checkKey, cloudErrorText };
