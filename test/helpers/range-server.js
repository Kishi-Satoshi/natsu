'use strict';
// 取り込みのテスト用の偽の取得元（origin）と CDN（cdn）。127.0.0.1 だけで待ち受ける。
// origin は hops の並びどおりに転送し、最後に cdn の署名付きの URL（?sig=N）へ 302 で送る。
// cdn は Range に従って body を返す。script[i] は、i 回目の cdn の要求の振る舞い。
const http = require('http');
const zlib = require('zlib');

function parseRange(h, size) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(h || '');
  if (!m) return null;
  return { start: Number(m[1]), end: Math.min(m[2] ? Number(m[2]) : size - 1, size - 1) };
}

// HF の CDN と同じく、416 には Content-Range を付けず、If-Range は見ない
function sendFile(req, res, buf, o = {}) {
  if (o.noHeaders) return;                                         // 見出しを返さない（header-timeout）
  if (o.status) {
    const h = {};
    if (o.retryAfter != null) h['retry-after'] = String(o.retryAfter);
    if (o.html) h['content-type'] = 'text/html; charset=utf-8';
    if (o.status === 401) h['www-authenticate'] = 'Basic realm="x"';
    if (o.status === 407) h['proxy-authenticate'] = 'Basic realm="x"';
    res.writeHead(o.status, h); res.end(o.html ? '<html>blocked</html>' : ''); return;
  }
  if (o.html) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html>blocked</html>'); return; }
  const r = o.ignoreRange ? null : parseRange(req.headers.range, buf.length);
  if (r && (o.always416 || r.start >= buf.length)) { res.writeHead(416, { 'content-length': 0 }); res.end(); return; }
  const start = r ? (o.wrongStart != null ? o.wrongStart : r.start) : 0;
  const end = r ? r.end : buf.length - 1;
  let body = buf.subarray(start, end + 1);
  if (o.flipByte != null) { body = Buffer.from(body); body[o.flipByte] ^= 0xff; }
  const h = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', etag: '"cdn-etag"' };
  if (r) h['content-range'] = `bytes ${start}-${end}/${o.wrongTotal != null ? o.wrongTotal : buf.length}`;
  if (o.gzip) { body = zlib.gzipSync(body); h['content-encoding'] = 'gzip'; }
  const chunked = o.short != null || o.zero;
  if (!chunked) h['content-length'] = body.length;
  res.writeHead(r ? 206 : 200, h);
  // 書き終えて 100ms 後に切る（止まった流れの見張り（テストは 300ms）より短く）。届いた分を受け手が読み終える前に切っても
  // 続きの位置はぶれない: 偽の net（fake-net.js の deliverAllThenFail）が、届いた分を渡し終えてから失敗を知らせる
  if (o.cutAfter != null) { res.write(body.subarray(0, o.cutAfter), () => setTimeout(() => res.socket.destroy(), 100)); return; }
  if (o.stallAfter != null) { res.write(body.subarray(0, o.stallAfter)); return; }   // 黙る
  if (o.zero) { res.end(); return; }
  if (o.short != null) { res.end(body.subarray(0, o.short)); return; }
  res.end(body);
}

async function startServers({ body, linked = null, hops = ['302-cdn'], script = [], signedOnce = false } = {}) {
  const log = [];
  const used = new Set();
  let sig = 0; let originHits = 0; let cdnN = 0; let cdnBase = '';
  const origin = http.createServer((req, res) => {
    log.push({ at: Date.now(), name: 'origin', url: req.url, range: req.headers.range || null });
    const k = Number((/^\/s(\d+)/.exec(req.url) || [])[1]);
    const hop = hops[k];
    if (hop === '307-relative') { res.writeHead(307, { location: `s${k + 1}` }); res.end(); return; }
    if (hop === '302-cdn') {
      originHits++;
      const h = { location: `${cdnBase}/blob?sig=${++sig}` };
      if (linked) { h['x-linked-size'] = String(linked.size); h['x-linked-etag'] = `"${linked.sha256}"`; }
      res.writeHead(302, h); res.end(); return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not Found');
  });
  const cdn = http.createServer((req, res) => {
    const s = new URL(req.url, 'http://x').searchParams.get('sig');
    if (signedOnce && used.has(s)) {                                // 前の試しの署名付きの URL は切れている
      log.push({ at: Date.now(), name: 'cdn-expired', url: req.url, range: req.headers.range || null });
      res.writeHead(403); res.end('expired'); return;
    }
    used.add(s);
    log.push({ at: Date.now(), name: 'cdn', url: req.url, range: req.headers.range || null, enc: req.headers['accept-encoding'] || null });
    sendFile(req, res, body, script[cdnN++] || {});
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  await new Promise((r) => cdn.listen(0, '127.0.0.1', r));
  cdnBase = `http://127.0.0.1:${cdn.address().port}`;
  return {
    originUrl: `http://127.0.0.1:${origin.address().port}/s0`,
    cdnRanges: () => log.filter((x) => x.name === 'cdn').map((x) => x.range),
    originHits: () => originHits,
    requests: () => log.slice(),
    close: () => new Promise((r) => { origin.closeAllConnections(); cdn.closeAllConnections(); origin.close(); cdn.close(() => r()); }),
  };
}

module.exports = { startServers, sendFile, parseRange };
