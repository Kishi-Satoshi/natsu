'use strict';
// 127.0.0.1 の偽の Resend（第1d回 W-2）。外へはつながない。中継（relay/mail.mjs）の RESEND_BASE に base を入れて使う。
//   POST {base}/emails … JSON（from・to・subject・text）。答え方（mode）ごとに:
//     ok   … 200 {"id": "fake-<n>"}（既定）
//     403  … 403（resend.dev のドメインから本人のほかへ送ろうとした、など）
//     429  … 429 と retry-after: 1（Resend の毎秒 10 回の上限）
//     500  … 500
//     drop … 返事をせずに切る
//   受けた要求は mails に { to, from, subject, text, headers, at } で覚える（headers は見出しの名前を小文字にしたもの）。
//   答え方によらず全部覚える（送れなかった要求も「Resend へ打った」に数えるため）。sent は 200 を返したものだけ。
//   codeFor(to) → その宛先へ 200 で送った最後のメールの 6 けたのコード（無ければ ''）
//   setMode(mode) で答え方を替える。close() で閉じる。

const http = require('node:http');

function startFakeResend({ mode = 'ok' } = {}) {
  const mails = [];
  const sent = [];
  let current = mode;
  let n = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method !== 'POST' || p !== '/emails') { res.writeHead(404); res.end(); return; }
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { body = {}; }
      const mail = { to: body.to, from: body.from, subject: body.subject, text: body.text, headers: { ...req.headers }, at: Date.now() };
      mails.push(mail);
      const reply = (status, obj, extra = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...extra });
        res.end(JSON.stringify(obj));
      };
      if (current === 'drop') { req.socket.destroy(); return; }
      if (current === '403') { reply(403, { statusCode: 403, name: 'validation_error', message: 'You can only send testing emails to your own email address.' }); return; }
      if (current === '429') { reply(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests.' }, { 'retry-after': '1' }); return; }
      if (current === '500') { reply(500, { statusCode: 500, name: 'internal_server_error', message: 'internal' }); return; }
      n += 1;
      sent.push(mail);
      reply(200, { id: `fake-${n}` });
    });
  });

  const codeFor = (to) => {
    for (let i = sent.length - 1; i >= 0; i--) {
      const m = sent[i];
      if (Array.isArray(m.to) && m.to.includes(to)) return (/\b(\d{6})\b/.exec(String(m.text || '')) || [])[1] || '';
    }
    return '';
  };

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        mails,
        sent,
        codeFor,
        setMode(m) { current = m; },
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
      });
    });
  });
}

module.exports = { startFakeResend };
