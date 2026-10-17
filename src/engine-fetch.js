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

const first = (v) => (Array.isArray(v) ? v[0] : v);

/** 見出しの値。名前は大文字小文字を問わない。値が配列（Electron の 'redirect' の見出し）なら先頭。 */
function hget(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const want = String(name).toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === want);
  return key === undefined ? undefined : first(headers[key]);
}

// `bytes S-E/T` → { start, end, total }。416 の形（bytes の後が星印）・総量が星印・空・矛盾は null。
function parseContentRange(v) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  const r = { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
  if (r.end < r.start || r.end >= r.total) return null;
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
 * → 'cert' | 'proxy-auth' | 'proxy' | 'offline' | 'space' | 'net'
 */
function classifyNetError(e) {
  const s = e ? `${e.code || ''} ${e.message || ''}` : '';
  if (/ERR_CERT_|SSL|CERT_|_CERT\b|UNABLE_TO_VERIFY/.test(s)) return 'cert';
  if (/ERR_PROXY_AUTH_|ERR_UNEXPECTED_PROXY_AUTH/.test(s)) return 'proxy-auth';
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_/.test(s)) return 'proxy';
  if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_CHANGED|\bENOTFOUND\b/.test(s)) return 'offline';
  if (/\bENOSPC\b/.test(s)) return 'space';
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

module.exports = { hget, parseContentRange, backoffMs, classifyNetError, decide, isTransient, askIt, fetchErrorMessage };
