// 文字起こしの口 POST /v1/audio/transcriptions（第1d回 RL7・RF34・RF38）。Web の標準の部品だけを使う。
// アプリは生の WAV（Content-Type: audio/wav）を送り、言語と認識ヒントは見出し（X-Natsu-Language・X-Natsu-Prompt）で渡す。
// 中継がモデル（cfg.model）・response_format・temperature を決めて OpenAI の multipart を自分で組み立て、会社の鍵を付けて送り、
// 文字だけを返す。アプリから来た欄を解かないので、客はモデルも欄も差し込めない。
//
//   handleTranscribe(request, env, { cfg, now, ctx }) → Response（道の関数。worker.mjs の health・me と同じ形。now はミリ秒の時計）
//   順: ready（503 not-ready）→ 認め（access.mjs の requireAccess（人の JWT。見出し Cf-Access-Jwt-Assertion か Cookie の CF_Authorization）
//     だけ。401 login・403 denied・503 not-ready。W-6 で自前の札（Authorization: Bearer）の道を消した）
//     → Content-Type が audio/wav で始まる（415 not-wav）
//     → 言語（/^[a-z]{2,3}$/ のときだけ送る。ほかと無いときは送らない＝自動）
//     → ヒント（見出しの文字のまま 9,000 バイトまで・decodeURIComponent で戻せる・戻して 1,000 字まで。ほかは 400 bad-request）
//     → 1日の上限の先の確かめ（1人と全体。もう上限なら本文を読まずに 429 daily-cap）
//     → 本文を読みながら数える（cfg.maxAudioBytes を越えたら読むのをやめて 413 too-large）
//     → wavInfo（アプリの録音の形だけ。ほかは 415 not-wav）
//     → reserveUsage（1人と全体の秒を送る前に取り置く。越えれば 429 daily-cap。同じ batch で 2 日より前の日の数えの行を片付ける: W-6）
//     → OpenAI へ（cfg.openaiBase は試しの 127.0.0.1 のほかは本物の固定の URL。redirect: 'manual' で転送に付いていかず、3xx は upstream の失敗にして鍵を別の宛先へ運ばない。Workers は 'error' を受けない）
//     → 答えの分け方 → 200 でなければ取り置いた秒を戻す（refundUsage）→ 記録 1 行 { ev: 'stt', st, r, ms, sec }（scope は daily-cap だけ）
//   取り置きの後に Worker が止まると秒は戻らない（使った側に多く数える。費用は越えない側に倒れる）。
//   OpenAI の答えの本文は、200 の text と、429 の error.code（insufficient_quota を見るため）のほかは読まない・記録に写さない。
//   音声も文字も D1 にも記録にも残さない。
//
//   wavInfo(bytes) → { ok: true, dataBytes, sec } | { ok: false }
//     受けるのはアプリの録音の形（overlay.html の 44 バイトの頭）だけ: RIFF・WAVE・'fmt ' の長さ 16・PCM（1）・1 チャンネル・16000Hz・
//     byteRate 32000・blockAlign 2・16 ビット・36 バイト目から 'data'。dataBytes は頭の後に届いたバイト数で、頭の data の長さは見ない
//     （0 や 1 時間と書いても、届いた分で数える）。sec は dataBytes ÷ 32,000 の切り上げ。届いた data が 0 バイトなら ok: false。
//   buildForm({ model, language, prompt, wav, boundary }) → Uint8Array（欄は model・language（あれば）・prompt（あれば）・
//     response_format=json・temperature=0・file（filename="segment.wav"・Content-Type: audio/wav）。文字の欄は UTF-8）
//
// 0.9.4 S-6（計画 docs/plans/2026-10-22-094.md の決めたこと 23〜28）: 本文を貯めずに流す道。Workers の CPU（Free は 1 要求 10 ms）を、
// 本文を3回写す（readCapped の貯め・wavInfo・buildForm の写し）作りが使い切って 503 が続いた（2026-10-22）。
//   要求に Content-Length（/^\d{1,9}$/）があれば流す道: 上限を越えれば本文を読まずに 413・44 以下なら 415 → 最初の塊で 44 バイトの頭を wavHead で
//   見る（違えば 415）→ 秒は (Content-Length − 44) ÷ 32,000 の切り上げで reserveUsage → streamUpstream が multipart の頭（formParts の head）・
//   本文の塊（写さない）・終わり（tail）を FixedLengthStream（Workers。長さが Content-Length になる。Node の試しでは TransformStream と duplex）
//   で OpenAI へ流し、流しながら数える。数えた合計が Content-Length と違えば流れを止めて 400 bad-request（秒は戻す）。
//   Content-Length が無ければ今の貯める道（前の版のアプリ）。記録の行に v（stream・buf）を足す
//   wavHead(bytes) → { ok }（頭の 44 バイトだけを見る。wavInfo の頭の照らしと同じ）
//   formParts({ model, language, prompt, boundary }) → { head, tail }（buildForm の本文の前と後。本文は持たない）
//   streamUpstream(cfg, { length, first, reader, form }) → 中継の答え（upstream と同じ形）

import { json, readCapped, sha256hex } from './http.mjs';
import { requireAccess, accessError } from './access.mjs';
import { ALL_USAGE_KEY, dayNumber, secondsToDayEnd, usage, reserveUsage, refundUsage } from './limits.mjs';
import { logEvent } from './log.mjs';

export const BYTES_PER_SEC = 32000;
export const PROMPT_MAX_HEADER = 9000;
export const PROMPT_MAX_CHARS = 1000;
const HEAD = 44;
const LANG = /^[a-z]{2,3}$/;
const RETRY_AFTER = /^\d{1,7}$/;
const BUSY_DEFAULT_SEC = 2;
const UPSTREAM_TIMEOUT_MS = 120000;
const TEXT_MAX_BYTES = 1024 * 1024;
const ERROR_MAX_BYTES = 64 * 1024;
const enc = new TextEncoder();

export function wavHead(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEAD) return { ok: false };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, HEAD);
  const tag = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  const u16 = (at) => dv.getUint16(at, true);
  const u32 = (at) => dv.getUint32(at, true);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || u32(16) !== 16 || tag(36) !== 'data') return { ok: false };
  if (u16(20) !== 1 || u16(22) !== 1 || u32(24) !== 16000 || u32(28) !== BYTES_PER_SEC || u16(32) !== 2 || u16(34) !== 16) return { ok: false };
  return { ok: true };
}

export function wavInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength <= HEAD) return { ok: false };
  if (!wavHead(bytes).ok) return { ok: false };
  const dataBytes = bytes.byteLength - HEAD;
  return { ok: true, dataBytes, sec: Math.ceil(dataBytes / BYTES_PER_SEC) };
}

export function formParts({ model, language, prompt, boundary }) {
  let head = '';
  const field = (name, value) => { head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`; };
  field('model', model);
  if (language) field('language', language);
  if (prompt) field('prompt', prompt);
  field('response_format', 'json');
  field('temperature', '0');
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="segment.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
  return { head: enc.encode(head), tail: enc.encode(`\r\n--${boundary}--\r\n`) };
}

export function buildForm({ model, language, prompt, wav, boundary }) {
  const { head, tail } = formParts({ model, language, prompt, boundary });
  const parts = [head, wav, tail];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

// → { ok: true, prompt } | { ok: false }（無ければ ''）
function readPrompt(raw) {
  if (raw === null) return { ok: true, prompt: '' };
  if (raw.length > PROMPT_MAX_HEADER) return { ok: false };   // 見出しの値は 1 字 1 バイト（ByteString）
  let s;
  try { s = decodeURIComponent(raw); } catch (_) { return { ok: false }; }
  if ([...s].length > PROMPT_MAX_CHARS) return { ok: false };
  return { ok: true, prompt: s };
}

async function readJsonCapped(res, max) {
  try {
    const bytes = await readCapped(res, max);
    if (bytes === null) return null;
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_) {
    return null;
  }
}

async function discard(res) {
  try { if (res.body) await res.body.cancel(); } catch (_) { /* 捨てるだけ */ }
}

// OpenAI へ1回送り、中継の答え { st, body, headers, r } に分ける（貯める道）
async function upstream(cfg, form) {
  const boundary = 'natsu-' + crypto.randomUUID();
  let res;
  try {
    res = await fetch(cfg.openaiBase + '/audio/transcriptions', {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { authorization: 'Bearer ' + cfg.openaiKey, 'content-type': 'multipart/form-data; boundary=' + boundary },
      body: buildForm({ ...form, boundary }),
    });
  } catch (_) {
    return fail(502, 'upstream');   // 届かない・切れた・時間切れ。例外の文は写さない（転送の 3xx は下の 502 upstream）
  }
  return answerOf(res);
}

// 流す道（0.9.4 S-6）: multipart の頭 → 読んだ最初の塊（写さない）→ 残りの塊を読んでは数えて書く → 終わり。数えた合計が length と違えば
// 書き手を止める（FixedLengthStream も長さの違いで誤りにする）→ fetch が断り、400 bad-request（呼び手が秒を戻す）
export async function streamUpstream(cfg, { length, first, reader, form }) {
  const boundary = 'natsu-' + crypto.randomUUID();
  const { head, tail } = formParts({ ...form, boundary });
  const total = head.byteLength + length + tail.byteLength;
  const Fixed = globalThis.FixedLengthStream;
  const pipe = typeof Fixed === 'function' ? new Fixed(total) : new TransformStream();
  const writer = pipe.writable.getWriter();
  let bad = false;       // アプリの側の本文が長さと違った・途中で切れた（400 bad-request）
  let stopped = false;   // OpenAI の側が先に終わったので、こちらから流れを止めた（本文の誤りに数えない）
  (async () => {
    let n = 0;
    try {
      await writer.write(head);
      for (const c of first) { n += c.byteLength; if (n > length) throw new RangeError('long'); await writer.write(c); }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > length) throw new RangeError('long');
        await writer.write(value);
      }
      if (n !== length) throw new RangeError('short');
      await writer.write(tail);
      await writer.close();
    } catch (e) {
      if (!stopped) bad = true;
      try { await writer.abort(e); } catch (_) { /* 止めるだけ */ }
      try { await reader.cancel(); } catch (_) { /* 読むのをやめるだけ */ }
    }
  })();
  const stop = async () => {
    stopped = true;
    try { await writer.abort(new Error('stop')); } catch (_) { /* 止めるだけ */ }
    try { await reader.cancel(); } catch (_) { /* 読むのをやめるだけ */ }
  };
  const init = {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { authorization: 'Bearer ' + cfg.openaiKey, 'content-type': 'multipart/form-data; boundary=' + boundary },
    body: pipe.readable,
  };
  if (typeof Fixed !== 'function') init.duplex = 'half';   // Node の試しだけ（Workers の fetch は流れの本文をそのまま受ける）
  let res;
  try {
    res = await fetch(cfg.openaiBase + '/audio/transcriptions', init);
  } catch (_) {
    if (bad) return fail(400, 'bad-request');
    await stop();
    return fail(502, 'upstream');
  }
  if (bad) { await discard(res); return fail(400, 'bad-request'); }
  if (res.status !== 200) await stop();   // OpenAI が本文を読み終える前に断った（読み残しの流れを開いたままにしない）
  return answerOf(res);
}

// OpenAI の答え → 中継の答え（どちらの道も同じ分け方）
async function answerOf(res) {
  const st = res.status;
  if (st === 200) {
    const j = await readJsonCapped(res, TEXT_MAX_BYTES);
    if (!j || typeof j !== 'object' || typeof j.text !== 'string') return fail(502, 'upstream');
    return { st: 200, r: 'ok', body: { text: j.text }, headers: {} };
  }
  if (st === 429) {
    const ra = (res.headers.get('retry-after') || '').trim();
    const j = await readJsonCapped(res, ERROR_MAX_BYTES);
    const code = j && j.error && typeof j.error === 'object' ? j.error.code : null;
    if (code === 'insufficient_quota') return fail(503, 'quota');
    const retryAfter = RETRY_AFTER.test(ra) ? Number(ra) : BUSY_DEFAULT_SEC;
    return { st: 429, r: 'busy', body: { error: 'busy', retryAfter }, headers: { 'retry-after': String(retryAfter) } };
  }
  await discard(res);
  if (st === 401 || st === 403) return fail(502, 'upstream-auth');   // 会社の鍵の誤り。利用者のログイン切れ（401 login）と分ける
  if (st === 400) return fail(400, 'bad-request');
  if (st === 413) return fail(413, 'too-large');
  return fail(502, 'upstream');
}

function fail(st, r) {
  return { st, r, body: { error: r }, headers: {} };
}

const CONTENT_LENGTH = /^\d{1,9}$/;

// 流す道の最初の塊を、44 バイトの頭がそろうまで読む → { chunks, head }（head は 44 バイトの小さな写しか最初の塊の一部。そろわなければ null）
async function readHead(reader) {
  const chunks = [];
  let got = 0;
  while (got < HEAD) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
  }
  if (got < HEAD) return { chunks, head: null };
  if (chunks[0].byteLength >= HEAD) return { chunks, head: chunks[0].subarray(0, HEAD) };
  const head = new Uint8Array(HEAD);
  let at = 0;
  for (const c of chunks) { const k = Math.min(c.byteLength, HEAD - at); head.set(c.subarray(0, k), at); at += k; if (at >= HEAD) break; }
  return { chunks, head };
}

export async function handleTranscribe(request, env, { cfg, now, ctx }) {
  const started = Date.now();
  let way = 'buf';
  const done = (st, body, headers = {}, { r, sec = 0, scope } = {}) => {
    logEvent('stt', { st, r: r || body.error || 'ok', ms: Date.now() - started, sec, scope, v: way });
    return json(st, body, headers);
  };
  if (!cfg.ready.openai) return done(503, { error: 'not-ready' });
  const s = await requireAccess(request, env, cfg, { now, ctx });   // ctx.access は need: 'any'（/health）のほかでは見ない
  if (!s.ok) return done(s.st, { error: accessError(s.st) });
  if (!(request.headers.get('content-type') || '').trim().toLowerCase().startsWith('audio/wav')) return done(415, { error: 'not-wav' });
  const langRaw = (request.headers.get('x-natsu-language') || '').trim();
  const language = LANG.test(langRaw) ? langRaw : '';
  const hint = readPrompt(request.headers.get('x-natsu-prompt'));
  if (!hint.ok) return done(400, { error: 'bad-request' });

  const db = env.DB;
  const t = Math.floor(now() / 1000);
  const day = dayNumber(t, cfg.dayOffsetMin);
  const userKey = 'a:u:' + (await sha256hex(s.email)).slice(0, 32);
  const capped = (scope) => {
    const retryAfter = secondsToDayEnd(t, cfg.dayOffsetMin);
    return done(429, { error: 'daily-cap', scope, retryAfter }, { 'retry-after': String(retryAfter) }, { scope });
  };
  // もう上限なら本文を読まない（読みながらの 25MB も CPU も使わせない）
  const [userUsed, allUsed] = await Promise.all([usage(db, userKey, day), usage(db, ALL_USAGE_KEY, day)]);
  if (userUsed >= cfg.dailyUserSec) return capped('user');
  if (allUsed >= cfg.dailyAllSec) return capped('all');

  // 0.9.4 S-6: Content-Length があれば流す道（本文を貯めない・写さない）
  const clRaw = (request.headers.get('content-length') || '').trim();
  if (CONTENT_LENGTH.test(clRaw)) {
    way = 'stream';
    const length = Number(clRaw);
    if (length > cfg.maxAudioBytes) return done(413, { error: 'too-large' });   // 読まずに断る
    if (length <= HEAD || !request.body) return done(415, { error: 'not-wav' });
    const reader = request.body.getReader();
    const { chunks, head } = await readHead(reader);
    if (!head || !wavHead(head).ok) {
      try { await reader.cancel(); } catch (_) { /* 読むのをやめるだけ */ }
      return done(415, { error: 'not-wav' });
    }
    const sec = Math.ceil((length - HEAD) / BYTES_PER_SEC);
    const held = await reserveUsage(db, { userKey, day, sec, userMax: cfg.dailyUserSec, allMax: cfg.dailyAllSec });
    if (!held.ok) {
      try { await reader.cancel(); } catch (_) { /* 読むのをやめるだけ */ }
      return capped(held.scope);
    }
    let out;
    try {
      out = await streamUpstream(cfg, { length, first: chunks, reader, form: { model: cfg.model, language, prompt: hint.prompt } });
    } finally {
      if (!out || out.st !== 200) {
        try { await refundUsage(db, { userKey, day, sec }); } catch (_) { /* 戻せなければ多く数えたまま（費用は越えない側） */ }
      }
    }
    return done(out.st, out.body, out.headers, { r: out.r, sec });
  }

  const wav = await readCapped(request, cfg.maxAudioBytes);
  if (wav === null) return done(413, { error: 'too-large' });
  const info = wavInfo(wav);
  if (!info.ok) return done(415, { error: 'not-wav' });

  const held = await reserveUsage(db, { userKey, day, sec: info.sec, userMax: cfg.dailyUserSec, allMax: cfg.dailyAllSec });
  if (!held.ok) return capped(held.scope);
  let out;
  try {
    out = await upstream(cfg, { model: cfg.model, language, prompt: hint.prompt, wav });
  } finally {
    if (!out || out.st !== 200) {
      try { await refundUsage(db, { userKey, day, sec: info.sec }); } catch (_) { /* 戻せなければ多く数えたまま（費用は越えない側） */ }
    }
  }
  return done(out.st, out.body, out.headers, { r: out.r, sec: info.sec });
}
