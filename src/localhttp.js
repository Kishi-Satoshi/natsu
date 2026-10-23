'use strict';
// PC の中の文字起こしエンジン（whisper-server）への要求（0.9.4 S-2。計画 docs/plans/2026-10-22-094.md の決めたこと 15）。
// Node の組み込みの fetch（undici）は、返事の頭と本文を既定 300 秒（headersTimeout・bodyTimeout）で切る。whisper-server は文字起こしが
// 済むまで返事の頭を返さないので、300 秒を越える区間は自前の時計より先に undici が切っていた（持ち主の engine.log の
// UND_ERR_HEADERS_TIMEOUT）。npm の undici を足さずに、127.0.0.1 だけへ送る小さな node:http の部品で送る。
//   postInference({ port, form, timeoutMs, signal, request }) → Promise<{ status, body }>（body は文字。1 MB まで）
//     - 宛先は 127.0.0.1:<port>/inference だけ（host を引数で受けない）。agent: false（使い回しの接続を持たない）
//     - form は FormData。new Response(form) で multipart の本文と content-type にする（自前で組まない）
//     - 時間切れは自前の時計だけ（timeoutMs）。越えたら要求を壊し（whisper-server も接続の閉じを受ける）、late: true・
//       code 'LOCAL_TIMEOUT' の Error で断る。頭の時間切れ・本文の時間切れは付けない
//     - signal（AbortSignal）が止めたら AbortError で断る
//     - 答えが 1 MB を越えたら要求を壊して断る（code 'LOCAL_TOO_BIG'）
//     - 接続の誤り（ECONNREFUSED・ECONNRESET・EPIPE など）は Node の Error のまま（code を持つ）
//   request は試験だけが差し替える（既定は http.request）

const http = require('http');

const MAX_REPLY_BYTES = 1 << 20;
const LATE_TEXT = 'PC の文字起こしが時間内に終わりませんでした';

function lateError(timeoutMs) {
  const e = new Error(LATE_TEXT);
  e.late = true;
  e.code = 'LOCAL_TIMEOUT';
  e.timeoutMs = timeoutMs;
  return e;
}

async function postInference({ port, form, timeoutMs, signal, request = http.request } = {}) {
  const wire = new Response(form);
  const type = wire.headers.get('content-type') || 'application/octet-stream';
  const body = Buffer.from(await wire.arrayBuffer());
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let req = null;
    const onAbort = () => {
      const e = new Error('取り消しました');
      e.name = 'AbortError';
      fail(e, true);
    };
    const done = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    };
    function fail(e, destroy) {
      if (settled) return;
      done();
      if (destroy && req) { try { req.destroy(); } catch (_) { /* 壊せなくても断る */ } }
      reject(e);
    }
    if (signal && signal.aborted) { onAbort(); return; }
    try {
      req = request({
        host: '127.0.0.1', port: Number(port), path: '/inference', method: 'POST', agent: false,
        headers: { 'content-type': type, 'content-length': String(body.length) },
      }, (res) => {
        const chunks = [];
        let n = 0;
        res.on('data', (d) => {
          n += d.length;
          if (n > MAX_REPLY_BYTES) {
            const e = new Error('文字起こしエンジンの返事が大きすぎます');
            e.code = 'LOCAL_TOO_BIG';
            fail(e, true);
            return;
          }
          chunks.push(d);
        });
        res.on('end', () => {
          if (settled) return;
          done();
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (e) => fail(e, true));
        res.on('aborted', () => { const e = new Error('文字起こしエンジンとの接続が切れました'); e.code = 'ECONNRESET'; fail(e, true); });
      });
    } catch (e) {
      fail(e, false);
      return;
    }
    req.on('error', (e) => fail(e, false));
    timer = setTimeout(() => fail(lateError(ms), true), ms);
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    req.end(body);
  });
}

module.exports = { postInference, MAX_REPLY_BYTES, LATE_TEXT };
