'use strict';
// テスト用の小さな偽のピンの組。本物の MANIFEST と同じ形（whisper の zip・VAD・モデル、llama の zip・モデル）で、
// 中身は数十 KB。gen: 2 は「更新でピンが変わった」組（文字起こしのモデルと llama の版が変わる）。
// sameDest: true は、gen 2 の文字起こしのモデルを gen 1 と同じ置き場所にする（place-in-use の試し）。
const http = require('http');
const crypto = require('crypto');
const { makeZip } = require('./zipwrite');
const { sendFile } = require('./range-server');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const bytes = (n, seed) => {
  const out = Buffer.alloc(n);
  let h = crypto.createHash('sha256').update(String(seed)).digest();
  for (let i = 0; i < n; i += 32) { h.copy(out, i, 0, Math.min(32, n - i)); h = crypto.createHash('sha256').update(h).digest(); }
  return out;
};
const freeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };

async function smallSet({ gen = 1, sameDest = false, missing = [], onHit = null } = {}) {
  const bodies = {};
  const zipItem = (id, group, dir, strip, exe, used, extra, seed) => {
    const ents = used.map(([name, n]) => ({ name, data: bytes(n, seed + name) }));
    const zip = makeZip([...ents, ...extra.map(([name, n]) => ({ name, data: bytes(n, seed + name) }))]);
    bodies[id] = zip;
    return { id, group, kind: 'zip', label: id, version: dir.split('-').pop(), size: zip.length, sha256: sha(zip), dir, strip, exe,
      files: ents.map((e) => ({ name: e.name, size: e.data.length, sha256: sha(e.data) })), license: 'MIT（試験）' };
  };
  const fileItem = (id, group, role, dest, n, seed) => {
    const b = bytes(n, seed); bodies[id] = b;
    return { id, group, kind: 'file', role, label: id, version: String(seed), size: b.length, sha256: sha(b), dest, license: 'MIT（試験）' };
  };
  const items = [
    zipItem('whisper-engine', 'whisper', 'whisper-1.0.0', 'Release/', 'whisper-server.exe',
      [['Release/whisper-server.exe', 3000], ['Release/whisper.dll', 2000], ['Release/ggml.dll', 1000]], [['Release/test-extra.exe', 500]], 'w1'),
    fileItem('whisper-vad', 'whisper', 'vad', 'models/vad.bin', 3000, 'vad1'),
    fileItem('whisper-model', 'whisper', 'model', gen === 2 && !sameDest ? 'models/w-model-2.bin' : 'models/w-model.bin', 40000, `wm${gen}`),
    zipItem('sum-engine', 'sum', gen === 2 ? 'llama-b2' : 'llama-b1', '', 'llama-server.exe',
      [['llama-server.exe', 900], ['llama.dll', 2500], ['ggml.dll', 1100]], [], `l${gen}`),
    fileItem('sum-model', 'sum', 'model', 'models/s-model.gguf', 60000, 'sm1'),
  ];
  const hits = [];
  let down = false;
  const server = http.createServer((req, res) => {
    if (down) { req.socket.destroy(); return; }
    const id = (/^\/i\/([^/]+)\//.exec(req.url) || [])[1];
    hits.push({ id, range: req.headers.range || null });
    if (onHit) onHit(id);
    if (!bodies[id] || missing.includes(id)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not Found'); return; }
    sendFile(req, res, bodies[id]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const it of items) it.url = `${base}/i/${it.id}/${gen}`;
  return {
    manifest: freeze({ schema: 1, items }),
    bodies,
    hits: () => hits.slice(),
    setDown: (v) => { down = Boolean(v); },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

module.exports = { smallSet };
