/*
 * engine-fetch.js — エンジンとモデルの取り込み（1つのファイルを、続きから、中身を照らして取る）
 *
 * この版は、通信の応答をどう扱うかと利用者向けの文を決める純粋な関数だけを持つ（第0b回 R7）。
 *  - hget               見出しを大文字小文字を問わずに読む（値が配列なら先頭）
 *  - parseContentRange  206 の Content-Range を読む
 *  - backoffMs          続けて失敗したときに待つ時間
 *  - classifyNetError   通信の失敗（Chromium の net::ERR_* と Node の errno）を分ける
 *  - decide             応答の状態コードと見出しから、書く・取り直す・待つ・やめるを決める
 *  - isTransient        待てば直るもの（取り込みの係は止めずに待つ。RF14）
 *  - askIt              情報システムの担当に渡すもの（画面は［担当に渡す内容を写す］を出す）
 *  - fetchErrorMessage  利用者向けの文（最後の文は、することを1つ書いた文で終わる）
 *  - fetchFile          1つのファイルを、続きから（HTTP の Range）、転送を手で追い、記録を残して取り、
 *                       中身を SHA-256 で照らして置く（第0b回 R7、RF6、RF9）。失敗の道（見出しの待ち・
 *                       止まった流れ・名前の変更の失敗・空き・進み具合）も持つ（Task 6）
 *
 * 決まり:
 *  - Electron のモジュールは読み込まない。通信は呼ぶ側から request（本番は net.request）を
 *    もらう。Node のグローバルの通信の関数は使わない（Windows のプロキシ・証明書を使わない。RF2）。
 *  - 中身が同じかは「版を固定した URL」「206 の総量 = ピンの大きさ」「最後の中身の照らし」で決める。
 *    署名付きの CDN は If-Range を無視するので、見出しの ETag には頼らない。
 *  - GitHub と Hugging Face の本当の 404 は text/plain。HTML の 4xx は社内のプロキシの止めの頁とみなす
 *    （RF2、RF10）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fsp = fs.promises;
const first = (v) => (Array.isArray(v) ? v[0] : v);

/** 見出しの値。名前は大文字小文字を問わない。値が配列（Electron の 'redirect' の見出し）なら先頭。 */
function hget(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const want = String(name).toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === want);
  return key === undefined ? undefined : first(headers[key]);
}

// `bytes S-E/T` → { start, end, total }。416 の形（bytes の後が星印）・総量が星印・空・終わりが始まりより前は null。
// 総量が範囲より小さいもの（`bytes 100000-299999/999`）は読んで返す。総量がピンと違うことは decide が
// size-changed で止める（読めない扱いの bad-range にすると、待って何度も試してしまう）。
function parseContentRange(v) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  const r = { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
  if (r.end < r.start) return null;
  return r;
}

/**
 * 待つ時間（ミリ秒）。fails は続けて失敗した数（1 から）。1, 2, 4, 8, 16, 30 秒で、±20% ずらす
 * （50台が同時に切れても、同じ瞬間に戻らない）。Retry-After（秒）があればそれを守る（120 秒まで）。
 */
function backoffMs(fails, retryAfterSec, rand = Math.random) {
  if (Number.isFinite(retryAfterSec)) return Math.min(120, Math.max(0, retryAfterSec)) * 1000;
  const n = Math.max(1, Math.floor(Number(fails) || 1));
  const base = Math.min(30000, 1000 * 2 ** Math.min(n - 1, 15));
  return Math.round(base * (0.8 + 0.4 * rand()));
}

/**
 * 通信の失敗を分ける。上から順に見る（proxy-auth は proxy より先。https のプロキシの認証は、
 * 407 の応答ではなく net::ERR_PROXY_AUTH_* か ERR_UNEXPECTED_PROXY_AUTH で来る）。
 * → 'cert' | 'proxy-auth' | 'proxy' | 'offline' | 'space' | 'encoding' | 'net'
 * encoding は ERR_CONTENT_DECODING_FAILED。Chromium は、送った Accept-Encoding に無い content-encoding を
 * 伸ばさずに断る（identity を頼んだのに社内のプロキシが gzip にした。第0b回 Task 9 の electron-net で確かめた）。
 */
function classifyNetError(e) {
  const s = e ? `${e.code || ''} ${e.message || ''}` : '';
  if (/ERR_CERT_|SSL|CERT_|_CERT\b|UNABLE_TO_VERIFY/.test(s)) return 'cert';
  if (/ERR_PROXY_AUTH_|ERR_UNEXPECTED_PROXY_AUTH/.test(s)) return 'proxy-auth';
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_/.test(s)) return 'proxy';
  if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_CHANGED|\bENOTFOUND\b/.test(s)) return 'offline';
  if (/\bENOSPC\b/.test(s)) return 'space';
  if (/ERR_CONTENT_DECODING_FAILED/.test(s)) return 'encoding';
  return 'net';
}

const isHtml = (h) => /^\s*text\/html\b/i.test(String(hget(h, 'content-type') || ''));
const encoded = (h) => {
  const v = String(hget(h, 'content-encoding') || '').trim().toLowerCase();
  return v !== '' && v !== 'identity';
};
const retryAfterOf = (h) => {
  const v = String(hget(h, 'retry-after') || '').trim();
  return /^\d+$/.test(v) ? Number(v) : null;   // 日付の形は読まない（待つ時間は backoffMs の既定にする）
};

/**
 * 応答をどう扱うか。held は .part に持っている長さ、pin は { size, sha256 }。
 *  { act: 'write', from, skipLength? }  from から書く。skipLength は content-length を見ない（圧縮された 200）
 *  { act: 'restart', code }             .part を 0 にして取り直す
 *  { act: 'retry', code, retryAfter }   待って同じ所から（retryAfter は秒か null）
 *  { act: 'fail', code }                やめる（この応答は使わない）
 */
function decide(status, headers, held, pin) {
  const h = headers || {};
  if (status === 407) return { act: 'fail', code: 'proxy-auth' };
  // 416 は Range の答えで、止めの頁ではない（nginx などの既定の 416 は HTML）
  if (status === 416) return { act: 'restart', code: 'range-416' };
  if (status === 451) return { act: 'fail', code: 'blocked' };
  // 4xx の HTML は社内のプロキシの止めの頁（retry より先に見る）。408・429 は「待って」の意味なので除く
  // （github.com の回数の制限の頁は 429 の HTML。50台が1つの出口から取ると起きうる）
  if (status >= 400 && status <= 499 && status !== 408 && status !== 429 && isHtml(h)) return { act: 'fail', code: 'blocked' };
  if (status === 206) {
    const cr = parseContentRange(hget(h, 'content-range'));
    if (!cr) return { act: 'retry', code: 'bad-range', retryAfter: null };
    if (cr.total !== pin.size) return { act: 'fail', code: 'size-changed' };
    if (cr.start !== held) return { act: 'restart', code: 'range-start' };
    if (encoded(h)) return { act: 'restart', code: 'encoding' };
    return { act: 'write', from: held };
  }
  if (status === 200) {
    if (isHtml(h)) return { act: 'fail', code: 'blocked' };
    // 社内のプロキシが圧縮した。Chromium は伸ばして渡すが、content-length は圧縮した長さのまま
    if (encoded(h)) return { act: 'write', from: 0, skipLength: true };
    const cl = String(hget(h, 'content-length') ?? '').trim();
    if (/^\d+$/.test(cl) && Number(cl) !== pin.size) return { act: 'fail', code: 'size-changed' };
    return { act: 'write', from: 0 };   // held が 0 でなくても 0 から（Range を無視された）
  }
  if (status === 404 || status === 410) return { act: 'fail', code: 'gone' };
  if (status === 401 || status === 403 || status === 408 || status === 429 || (status >= 500 && status <= 599)) {
    return { act: 'retry', code: `http-${status}`, retryAfter: retryAfterOf(h) };
  }
  return { act: 'fail', code: `http-${status}` };
}

const TRANSIENT = new Set(['offline', 'net', 'short', 'stall', 'header-timeout', 'bad-range', 'http-408', 'http-429']);
/** 待てば直るもの。取り込みの係は、これらで止めずに「つながるのを待っています」にする（RF14）。 */
function isTransient(code) {
  return TRANSIENT.has(code) || /^http-5\d\d$/.test(String(code));
}

const ASK_IT = new Set(['proxy', 'proxy-auth', 'cert', 'blocked', 'hash', 'http-401', 'http-403',
  'insecure-redirect', 'too-many-redirects', 'defender']);
/** 情報システムの担当に渡すもの。画面はこのとき［担当に渡す内容を写す］を出す。 */
function askIt(code) {
  return ASK_IT.has(code);
}

const COPY = '［担当に渡す内容を写す］を押して、情報システムの担当に渡してください。';
const MESSAGES = {
  waiting: 'つながるのを待っています（ここまでの分は残っています）。つながれば自動で続きから取り込みます。すぐ試すときは［今すぐ試す］を押してください。',
  offline: 'インターネットにつながっていません（ここまでの分は残っています）。つながったら［続きから取り込む］を押してください。',
  proxy: '社内のプロキシを通れませんでした。情報システムの担当に、github.com・release-assets.githubusercontent.com・huggingface.co・hf.co への接続を許してもらってください。',
  'proxy-auth': `社内のプロキシがパスワードを求めていますが、NaTsu からは入力できません。${COPY}`,
  cert: `通信の証明書を確かめられませんでした（社内の通信の検査で使う証明書が、この PC に無い可能性があります）。${COPY}`,
  blocked: `取り込み元の代わりに別のページが返ってきたか、断られました（社内のプロキシに止められた可能性があります）。${COPY}`,
  hash: `取り込んだファイルの中身が、決められたものと合いませんでした（取り直しても同じでした。通信の途中で書き換えられた可能性があります）。${COPY}`,
  gone: '取り込み元のファイルが見つからないか、変わっています。NaTsu の更新が必要です。［更新を確認］を押してください。',
  locked: 'ファイルを置けませんでした（ほかのプログラムが使っています。ウイルス対策の検査の途中かもしれません）。少し待ってから［もう一度］を押してください。',
  net: '通信が何度も途切れました（ここまでの分は残っています）。［続きから取り込む］を押してください。',
  redirect: `取り込み元から、安全でない場所へ送られました。${COPY}`,
};
const SAME_AS = {
  'http-401': 'blocked', 'http-403': 'blocked',
  'size-changed': 'gone', 'pinned-mismatch': 'gone', 'place-in-use': 'gone',
  short: 'net', stall: 'net', 'header-timeout': 'net', 'bad-range': 'net',
  'insecure-redirect': 'redirect', 'too-many-redirects': 'redirect',
};

/**
 * 利用者向けの文。extra は { needGB }（space）・{ file }（defender）。
 * 画面の文には「SHA-256」の語を出さない（照らしの値は［担当に渡す内容を写す］の中身にだけ出す）。
 * cancelled は文を出さない（一時停止の表示にする）ので ''。
 */
function fetchErrorMessage(code, extra = {}) {
  const x = extra || {};
  if (code === 'cancelled') return '';
  if (code === 'space') {
    const gb = Number(x.needGB);
    return x.needGB != null && Number.isFinite(gb) && gb > 0
      ? `ディスクの空きが足りません。あと ${x.needGB} GB 空けてから、［もう一度］を押してください。`
      : 'ディスクの空きが足りません。空きを増やしてから、［もう一度］を押してください。';
  }
  if (code === 'defender') {
    const what = x.file ? `取り込んだ ${x.file} が` : '取り込んだファイルが';
    return `${what}、また消えました。ウイルス対策が消している可能性があります（Windows セキュリティ → ウイルスと脅威の防止 → 保護の履歴）。${COPY}`;
  }
  const key = Object.prototype.hasOwnProperty.call(MESSAGES, code) ? code
    : Object.prototype.hasOwnProperty.call(SAME_AS, code) ? SAME_AS[code]
      : /^http-\d+$/.test(String(code)) ? 'net' : null;
  if (key) return MESSAGES[key];
  return `取り込みに失敗しました（${code}）。［もう一度］を押してください。`;
}

// ---------------------------------------------------------------- fetchFile

// fetchFile が自分で決めた失敗の印（本体を読む途中の失敗を、通信の失敗と取り違えないため）
const OWN = Symbol('engine-fetch');
/** code 付きの失敗。retry は「待って続きから試す」もの（ほかはすぐやめる）。 */
const failure = (code, extra) => Object.assign(new Error(`取り込み: ${code}`), { code, [OWN]: true }, extra);

const HEADER_MAX_MS = 10 * 60 * 1000;          // 見出しの待ちは、倍にしても 10 分まで
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_TRIES = 10;                        // 名前の変更は 300ms から伸ばしながら 10 回まで

// 通信の失敗のうち、待っても直らないもの（すぐやめる）
const NET_STOP = new Set(['cert', 'proxy-auth', 'proxy', 'space']);
const netFailure = (e) => {
  const code = classifyNetError(e);
  return failure(code, { cause: e, retry: !NET_STOP.has(code) });
};

function defaultUserAgent() {
  try { return `NaTsu/${require('../package.json').version}`; } catch (_) { return 'NaTsu'; }
}

async function openPartDefault(file) {
  return fsp.open(file, fs.existsSync(file) ? 'r+' : 'w+');
}

/** file の頭から n バイト（省けば全部）を、流して読んで hash に足す */
function hashFile(file, hash, n) {
  if (n === 0) return Promise.resolve(hash);
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file, n == null ? {} : { start: 0, end: n - 1 });
    rs.on('data', (c) => hash.update(c));
    rs.on('end', () => resolve(hash));
    rs.on('error', reject);
  });
}

async function readRecord(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return null; }
}
async function rmQuiet(file) {
  try { await fsp.unlink(file); } catch (_) { /* 無ければよい */ }
}

/**
 * 1回の要求を出し、応答の見出しが来るまで待つ → { req, res }。
 * 転送は手で追う（redirect: 'manual'。その場で followRedirect() を呼ぶ）。
 * プロキシの login は取り消して proxy-auth で終わる（その後に来る error より優先）。
 */
function openOnce(url, headers, c) {
  return new Promise((resolve, reject) => {
    // credentials は渡さない（プロキシの認証の情報は送り、クッキーは送らない）
    const req = c.request({ method: 'GET', url, redirect: 'manual', cache: 'no-store' });
    let settled = false; let hops = 0; let proxyAuth = false;
    // 見出しの待ち（転送を含めて、応答の見出しが来るまで）。社内の検査のプロキシは、ファイルを抱えて
    // から渡すことがある。時間切れは header-timeout で、呼ぶ側が次の待ちを倍にする
    const timer = setTimeout(() => finish(failure('header-timeout', { retry: true })), c.headerTimeoutMs);
    const onAbort = () => finish(failure('cancelled'));
    function finish(err, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (c.signal) c.signal.removeEventListener('abort', onAbort);
      if (err) {
        try { req.abort(); } catch (_) { /* もう終わっている */ }
        reject(err);
      } else resolve(val);
    }
    req.on('redirect', (status, method, newUrl, h) => {
      if (settled) return;
      hops += 1;
      if (hops > c.maxHops) { finish(failure('too-many-redirects')); return; }
      if (c.requireHttps && !/^https:/i.test(String(newUrl))) { finish(failure('insecure-redirect')); return; }
      // HF は最初の転送に、ファイルの SHA-256 と大きさを付ける。ピンと違えば本体を取る前に止める
      const etag = hget(h, 'x-linked-etag');
      const size = hget(h, 'x-linked-size');
      if (etag != null && String(etag).replace(/"/g, '').trim().toLowerCase() !== c.sha256) { finish(failure('pinned-mismatch')); return; }
      if (size != null && Number(String(size).trim()) !== c.size) { finish(failure('pinned-mismatch')); return; }
      req.followRedirect();
    });
    req.on('login', (info, cb) => {
      // 取り込み元そのものの認証（isProxy が偽）は、取り消して応答（401）を decide に回す
      if (info && info.isProxy === false) { try { cb(); } catch (_) { /* 終わっている */ } return; }
      proxyAuth = true;
      try { cb(); } catch (_) { /* 終わっている */ }   // 何も渡さない = 取り消す（NaTsu からは入力できない）
      finish(failure('proxy-auth'));
    });
    req.on('response', (res) => {
      // 本体の途中の失敗は、読む側（for await）で受ける。受け手が付く前に出ても落ちないように
      if (res && typeof res.on === 'function') res.on('error', () => {});
      if (settled) { try { req.abort(); } catch (_) { /* 終わっている */ } return; }
      finish(null, { req, res });
    });
    // 受け手はずっと付けておく（後から来る error で落ちない）
    req.on('error', (e) => { if (!settled) finish(proxyAuth ? failure('proxy-auth') : netFailure(e)); });
    if (c.signal) {
      if (c.signal.aborted) { finish(failure('cancelled')); return; }
      c.signal.addEventListener('abort', onAbort, { once: true });
    }
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    req.end();
  });
}

/**
 * 1つのファイルを取る → { file, reused }。失敗は Error（code 付き）で投げる。
 *  pin:  { url, size, sha256 }
 *  opts: { dir, dest, request, sleep, onProgress, signal, log, now, openPart, requireHttps, headerTimeoutMs,
 *          stallMs, maxFails, maxHops, syncEvery, progressMs, rename, userAgent }
 *    dir は .download のフォルダ（<sha256>.part と記録 <sha256>.json を置く）、dest は置く先の本当のパス。
 *    request は Electron の net.request と同じ形（本番は (o) => net.request(o)）。
 *    openPart(file) は .part を開く口（テストで書き込みの失敗を起こすために差し替える）。
 *    log(line) は試しごとに1行。onProgress({ done, total }) は progressMs に1回まで（now() で測る。最後は必ず）。
 *    onProgress の done は続きからの分を含み、増えるだけ（0 から取り直しても、追いつくまで前の値のまま）。
 *    続けての失敗が maxFails を超えたら、.part を残して最後の失敗のコードでやめる（バイトが届いたら数え直す）。
 *    正常に終わったのに短い（short）も1回の失敗に数える（いつも 0 バイトのサーバーで永久に回らない）。
 *    見出しの待ちは headerTimeoutMs から、続けて時間切れになるたびに倍（10 分まで）。stallMs の間に
 *    1 バイトも来なければ要求を止めて続きから（stall）。
 *
 * 手0: dest が有り、大きさがピンと同じで SHA-256 も合えば、要求を出さずに使う（installed.json が消えても
 *      数 GB を取り直さない）。
 * 試しのたびにピンの URL から始める（前の試しの署名付きの CDN の URL は切れている。RF6）。
 * 記録の synced は、fh.sync() を済ませた長さ。始める前に .part をそこまで切り捨てる（電源断の末尾。RF9）。
 * 途中の記録の書き込みの失敗（ENOSPC 以外）では止めない（記録は前の長さのままで安全）。
 * 取り消し・失敗で返る前にも、確定して今の長さを記録に書く（次はその長さから続く）。
 * 大きさがピンに達したら SHA-256 を照らし、違えば（ピンより大きい .part も）Range なしで1回だけ全部
 * 取り直す。それでも違えば hash（.part も記録も残さない）。206 の総量がピンと違えば size-changed で、
 * .part と記録を捨てる（違うファイルの続きは使えない）。
 * 書き込みの ENOSPC はすぐ space でやめ（.part は確定して残す）、needBytes に残りの大きさを入れる。
 * 名前の変更の EPERM・EBUSY・EACCES（ウイルス対策の検査など）は、待って 10 回まで試してから locked。
 * 頼んでいない圧縮（encoding: identity を頼んだのに社内のプロキシが圧縮し、Chromium が断った）の後は、この取り込みの
 * 終わりまで Accept-Encoding と Range を付けずに 0 から取る。Chromium が gzip などを頼んで伸ばし、圧縮された 200 は
 * 長さを見ずに SHA-256 で決める（decide の skipLength）。Range を付けると Chromium が identity を頼むので、続きからは取れない。
 */
async function fetchFile(pin, opts = {}) {
  const {
    dir, dest, request, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onProgress = () => {}, signal = null,
    log = () => {}, now = Date.now, openPart = openPartDefault, requireHttps = true, headerTimeoutMs = 60000, stallMs = 120000,
    maxFails = 6, maxHops = 10, syncEvery = 32 << 20, progressMs = 250, rename = fsp.rename, userAgent = defaultUserAgent(),
  } = opts;
  if (typeof request !== 'function') throw new TypeError('fetchFile: request が要る');
  const size = pin.size;
  const sha256 = String(pin.sha256).toLowerCase();
  const aborted = () => Boolean(signal && signal.aborted);
  if (aborted()) throw failure('cancelled');

  // 手0: 置く先にもう正しいファイルがある
  try {
    const st = await fsp.stat(dest);
    if (st.isFile() && st.size === size
      && (await hashFile(dest, crypto.createHash('sha256'))).digest('hex') === sha256) return { file: dest, reused: true };
  } catch (_) { /* 無い・読めない → 普通に取る */ }

  await fsp.mkdir(dir, { recursive: true });
  const part = path.join(dir, `${sha256}.part`);
  const side = path.join(dir, `${sha256}.json`);
  const name = path.basename(dest);

  // 記録がピンと同じときだけ .part を続きに使い、synced まで切り捨てる。記録が無い・違う .part は捨てる
  const rec = await readRecord(side);
  const same = rec && rec.url === pin.url && rec.size === size && String(rec.sha256).toLowerCase() === sha256
    && Number.isSafeInteger(rec.synced) && rec.synced >= 0;
  if (!same) await rmQuiet(part);
  let held = 0;
  if (same) {
    try { held = Math.min((await fsp.stat(part)).size, rec.synced); } catch (_) { held = 0; }
  }
  let fullRetryUsed = false;
  if (held > size) { held = 0; fullRetryUsed = true; }   // ピンより大きい .part は SHA-256 の違いと同じ扱い

  const fh = await openPart(part);
  let synced = -1;       // 記録に書けた長さ（fh.sync() の後）
  let nextSync = 0;      // 次に途中の確定をする長さ
  let discard = false;
  const writeRecord = async (n) => {
    const tmp = `${side}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ url: pin.url, size, sha256, synced: n }));
    await fsp.rename(tmp, side);   // opts.rename は置く先の名前の変更だけに使う
  };
  const commit = async () => { await fh.sync(); await writeRecord(held); synced = held; nextSync = held + syncEvery; };
  let hash;
  const reset = async () => { await fh.truncate(0); held = 0; hash = crypto.createHash('sha256'); await commit(); };

  // ディスクの失敗: ENOSPC は space（needBytes = ピンの大きさ − 持っている長さ）。ほかはそのまま。
  // どちらも印を付けて、本体を読む途中の通信の失敗と取り違えない
  const diskFailure = (e) => (e && e.code === 'ENOSPC'
    ? failure('space', { cause: e, needBytes: Math.max(0, size - held) })
    : Object.assign(e, { [OWN]: true }));
  // 位置を指定して書く。短い書き込み（空きが尽きかけたとき）は残りを書き足す。held は書けた分だけ進める
  const writeChunk = async (chunk) => {
    let off = 0;
    try {
      while (off < chunk.length) {
        const r = await fh.write(chunk, off, chunk.length - off, held + off);
        const n = r && r.bytesWritten;
        if (!(n > 0)) throw Object.assign(new Error('書き込めませんでした'), { code: 'ENOSPC' });
        off += n;
      }
    } catch (e) { throw diskFailure(e); }
    hash.update(chunk);
    held += chunk.length;
  };
  // 途中の確定（syncEvery ごと）。fh.sync() の失敗では止める（ENOSPC は space）。記録の書き込みの失敗
  // （ENOSPC 以外。ウイルス対策が .json.tmp → .json を止めたなど）では止めない: 前の記録は確定済みの長さを
  // 指すので安全で、次の続きはそこまで切り捨てる。記録は次の syncEvery の後にまた試す
  const checkpoint = async () => {
    nextSync = held + syncEvery;
    try { await fh.sync(); } catch (e) { throw diskFailure(e); }
    try { await writeRecord(held); synced = held; } catch (e) { if (e && e.code === 'ENOSPC') throw diskFailure(e); }
  };

  // 進み具合の done は増えるだけ（0 から取り直したときは、追いつくまで前の値のまま）
  let lastProgress = -Infinity;
  let shown = 0;
  const progress = (force) => {
    const t = now();
    if (!force && t - lastProgress < progressMs) return;
    lastProgress = t;
    shown = Math.max(shown, held);
    onProgress({ done: shown, total: size });
  };

  // 取り消されたら、今の要求を止める
  let current = null;
  const onAbort = () => { if (current) { try { current.abort(); } catch (_) { /* 終わっている */ } } };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  // 待つ。取り消されたらすぐ起きる（試し直しの待ちも、名前の変更の待ちも）
  const pause = (ms) => new Promise((resolve) => {
    if (aborted()) { resolve(); return; }
    const done = () => { if (signal) signal.removeEventListener('abort', done); resolve(); };
    if (signal) signal.addEventListener('abort', done, { once: true });
    Promise.resolve(sleep(ms)).then(done, done);
  });

  // 中身が違う（かピンより大きい）: 1回だけ Range なしで全部取り直す。それでも違えば hash で、何も残さない
  const mismatch = async () => {
    if (fullRetryUsed) { discard = true; throw failure('hash'); }
    fullRetryUsed = true;
    await reset();
  };

  try {
    if (fullRetryUsed) await reset();
    else {
      await fh.truncate(held);
      hash = await hashFile(part, crypto.createHash('sha256'), held);
      await commit();
    }
    let fails = 0;
    let headerWait = headerTimeoutMs;
    let plain = false;   // 頼んでいない圧縮で断られた後は、Accept-Encoding と Range を付けない
    for (;;) {
      if (aborted()) throw failure('cancelled');
      if (held === size) {
        if (hash.digest('hex') === sha256) break;
        await mismatch();
        continue;
      }
      log(`取り込み: ${name} ${plain ? 0 : held}/${size} から続ける`);
      const headers = plain ? { 'User-Agent': userAgent } : { 'Accept-Encoding': 'identity', 'User-Agent': userAgent };
      if (held > 0 && !plain) headers.Range = `bytes=${held}-`;   // If-Range は送らない（署名付きの CDN は無視する）
      let got = false;
      try {
        const { req, res } = await openOnce(pin.url, headers,
          { request, signal, requireHttps, maxHops, sha256, size, headerTimeoutMs: headerWait });
        current = req;
        headerWait = headerTimeoutMs;                    // 見出しが来たら、待ちを元に戻す
        const d = decide(res.statusCode, res.headers, held, pin);
        if (d.act !== 'write') {
          try { req.abort(); } catch (_) { /* 終わっている */ }
          if (d.act === 'fail') {
            if (d.code === 'size-changed') discard = true;   // 違うファイルの続きは使えない
            throw failure(d.code);
          }
          if (d.act === 'restart') await reset();
          throw failure(d.code, { retry: true, retryAfter: d.act === 'retry' ? d.retryAfter : null });
        }
        if (d.from === 0 && held > 0) await reset();   // Range を無視された（200）: 0 から書き直す
        let over = false;
        // 止まった流れ: stallMs の間に1バイトも来なければ、要求を止めて続きから試す（書いている間は数えない）
        let stalled = false;
        let stallTimer = null;
        const arm = () => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            stalled = true;
            try { req.abort(); } catch (_) { /* 終わっている */ }
            try { if (typeof res.destroy === 'function') res.destroy(); } catch (_) { /* 終わっている */ }
          }, stallMs);
        };
        try {
          arm();
          for await (const chunk of res) {
            clearTimeout(stallTimer);
            if (aborted() || stalled) break;
            if (held + chunk.length > size) { over = true; break; }   // ピンを超えた（圧縮された 200 など）
            await writeChunk(chunk);
            got = true;
            if (held >= nextSync) await checkpoint();
            progress(false);
            arm();
          }
        } catch (e) {
          if (aborted()) throw failure('cancelled');
          if (e && e[OWN]) throw e;                     // ディスクの失敗（space など）
          if (stalled) throw failure('stall', { retry: true });
          throw netFailure(e);
        } finally {
          clearTimeout(stallTimer);
        }
        if (aborted()) throw failure('cancelled');
        if (stalled && held < size) throw failure('stall', { retry: true });
        if (over) {
          try { req.abort(); } catch (_) { /* 終わっている */ }
          await mismatch();
          continue;
        }
        if (held < size) throw failure('short', { retry: true });
      } catch (err) {
        current = null;
        if (aborted()) throw failure('cancelled');
        const e = err && err.code === 'ENOSPC' ? diskFailure(err) : err;   // 記録や切り捨ての ENOSPC も space
        if (!e.retry) throw e;
        if (e.code === 'encoding') plain = true;        // 次からは Chromium に圧縮を頼ませて、伸ばしたものを取る
        if (e.code === 'header-timeout') headerWait = Math.min(headerWait * 2, Math.max(HEADER_MAX_MS, headerTimeoutMs));
        fails = got ? 1 : fails + 1;                     // バイトが届いたら数え直す
        if (fails > maxFails) throw failure(e.code, { cause: e.cause || e });
        await pause(backoffMs(fails, e.retryAfter));
      }
      current = null;
    }
    progress(true);
  } catch (e) {
    // 始めの切り捨て・確定や、取り直しの切り捨ての ENOSPC も space（needBytes 付き）にする
    throw e && e.code === 'ENOSPC' ? diskFailure(e) : e;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    // 返る前に書き込みを確定し、その長さを記録する（取り消し・失敗でも、次はそこから続く）
    if (!discard && synced !== held) {
      try { await commit(); } catch (_) { /* 記録は前の長さのまま */ }
    }
    try { await fh.close(); } catch (_) { /* 閉じている */ }
    if (discard) { await rmQuiet(part); await rmQuiet(side); }
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  // ウイルス対策の検査などで名前を変えられないときは、待って試す（.part と記録は残るので、次は照らすだけ）
  for (let i = 1; ; i++) {
    try { await rename(part, dest); break; } catch (e) {
      if (!e || !LOCKED.has(e.code)) throw e;
      if (i >= RENAME_TRIES) throw failure('locked', { cause: e });
      await pause(Math.min(300 * 2 ** (i - 1), 5000));   // 取り消されたらすぐ起きる
      if (aborted()) throw failure('cancelled');
    }
  }
  await rmQuiet(side);
  return { file: dest, reused: false };
}

module.exports = { hget, parseContentRange, backoffMs, classifyNetError, decide, isTransient, askIt, fetchErrorMessage, fetchFile };
