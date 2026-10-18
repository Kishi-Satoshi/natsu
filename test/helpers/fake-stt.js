'use strict';
// 127.0.0.1 の偽の文字起こしの送り先（OpenAI と同じ形の口。第1c回 Task A-2）。外へはつながない。
//   POST {base}/audio/transcriptions … multipart（file・model・language・prompt・response_format・temperature）
//   GET  {base}/models               … Authorization が鍵と同じなら 200、無いか違えば 401（届くかの確かめは鍵を付けないので 401 = 届く）
//   GET  /anthropic                  … 404（第1c回 B-3 の、Anthropic へ届くかの確かめ用）
// base は http://127.0.0.1:<port>/openai/v1。
// 答え方（mode。どれも文字起こしの要求だけに効く。GET …/models はいつも鍵の有無で 200／401）:
//   text       … 200 {"text": "<text>区間<n>"}（n は文字起こしの要求の通し番号。同じ文が続くと main が区間を消すので毎回違う文）
//   401        … 401
//   429        … 最初の times 回だけ 429 と retry-after、その後は文
//   429-long   … いつも 429 と retry-after: 3600（1日の上限）
//   500 / 400  … その状態
//   403 / 413  … その状態（鍵の権限が無い・大きすぎる。計画の外の分け方を守る試験用）
//   400-prompt … prompt の欄があれば 400、無ければ文（ヒントがトークンの上限を越えた場合: F15）
//   drop       … 返事をせずに切る
//   drop-first … 最初の文字起こしの要求だけ切る
//   slow       … 1.5 秒待ってから文
//   badjson    … 200 のまま JSON でない返事
// models（第1b回の続き Lane F-e。GET …/models の答え方。鍵が合うときだけ効く。鍵が違えばいつも 401 invalid_api_key）:
//   ok         … 200 の一覧（既定）
//   no-scope   … 401 と OpenAI の制限付きの鍵の文（「Missing scopes: api.model.read」。code は null）
//   quota      … 429 と insufficient_quota（残高が無い）
//   rate       … 429 と rate_limit_exceeded（ただの上限）
//   plain401   … 401 で error の無い本文
// どの答え方でも、鍵が違えば（文字起こしの要求も）401。受けた要求は requests に
// { method, path, authOk, fields, fileName, fileType, wavOk } で覚える（鍵そのものは覚えない）。
// authOk は「Authorization が Bearer <鍵> で、ほかの見出しに鍵が無い」。

const http = require('http');

// fake-whisper.js の wavOk と同じ（16kHz・モノラル・16bit の PCM の頭）
const wavOk = (b) => Boolean(b && b.length >= 44 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE'
  && b.toString('ascii', 12, 16) === 'fmt ' && b.readUInt16LE(20) === 1 && b.readUInt16LE(22) === 1
  && b.readUInt32LE(24) === 16000 && b.readUInt16LE(34) === 16 && b.toString('ascii', 36, 40) === 'data'
  && b.readUInt32LE(40) > 0 && b.readUInt32LE(40) <= b.length - 44);

// multipart の本文から、名前の付いた欄（文字）と file（中身・名前・型）を取り出す
function parseForm(buf, type) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type || '');
  const out = { fields: {}, file: null, fileName: '', fileType: '' };
  if (!m) return out;
  const sep = Buffer.from(`--${m[1] || m[2]}`);
  let i = buf.indexOf(sep);
  while (i >= 0) {
    const next = buf.indexOf(sep, i + sep.length);
    if (next < 0) break;
    const part = buf.subarray(i + sep.length + 2, next - 2);   // 区切りの後の CRLF と、次の区切りの前の CRLF を除く
    const h = part.indexOf('\r\n\r\n');
    if (h >= 0) {
      const head = part.subarray(0, h).toString('utf8');
      const body = part.subarray(h + 4);
      const name = (/name="([^"]*)"/.exec(head) || [])[1];
      const filename = (/filename="([^"]*)"/.exec(head) || [])[1];
      if (filename !== undefined) {
        out.file = body; out.fileName = filename;
        out.fileType = ((/^content-type:\s*(.+)$/im.exec(head) || [])[1] || '').trim();
      } else if (name) out.fields[name] = body.toString('utf8');
    }
    i = next;
  }
  return out;
}

function startFakeStt({ mode = 'text', key = 'gsk_test_0123', text = '本日の議題は進捗の確認です。', times = 1, retryAfter = '1', models = 'ok' } = {}) {
  const requests = [];
  const timers = new Set();
  let n = 0;
  const json = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...extra });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      const auth = String(req.headers.authorization || '');
      const keyElsewhere = Object.entries(req.headers).some(([k, v]) => k !== 'authorization' && String(v).includes(key));
      const authOk = auth === `Bearer ${key}` && !keyElsewhere;
      const isStt = req.method === 'POST' && p === '/openai/v1/audio/transcriptions';
      const form = isStt ? parseForm(Buffer.concat(chunks), req.headers['content-type']) : { fields: {}, file: null, fileName: '', fileType: '' };
      requests.push({ method: req.method, path: p, authOk, fields: form.fields, fileName: form.fileName, fileType: form.fileType, wavOk: wavOk(form.file) });

      if (req.method === 'GET' && p === '/openai/v1/models') {
        if (!authOk) json(res, 401, { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } });
        else if (models === 'no-scope') {
          json(res, 401, { error: { message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read. Check that you have the correct role in your organization (Reader, Writer, Owner) and project (Member, Owner), and if you\'re using a restricted API key, that it has the necessary scopes.', type: 'invalid_request_error', param: null, code: null } });
        } else if (models === 'quota') {
          json(res, 429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } });
        } else if (models === 'rate') json(res, 429, { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } });
        else if (models === 'plain401') json(res, 401, { data: [] });
        else json(res, 200, { object: 'list', data: [{ id: 'whisper-large-v3', object: 'model' }] });
        return;
      }
      if (req.method === 'GET' && p === '/anthropic') { res.writeHead(404); res.end(); return; }
      if (!isStt) { res.writeHead(404); res.end(); return; }

      n += 1;
      const reply = () => json(res, 200, { text: `${text}区間${n}` });
      if (!authOk || mode === '401') { json(res, 401, { error: { message: 'Invalid API Key', code: 'invalid_api_key' } }); return; }
      if (mode === 'drop' || (mode === 'drop-first' && n === 1)) { req.socket.destroy(); return; }
      if (mode === '429' && n <= times) { json(res, 429, { error: { message: 'Rate limit reached' } }, { 'retry-after': String(retryAfter) }); return; }
      if (mode === '429-long') { json(res, 429, { error: { message: 'Rate limit reached (per day)' } }, { 'retry-after': '3600' }); return; }
      if (mode === '500') { json(res, 500, { error: { message: 'internal' } }); return; }
      if (mode === '403' || mode === '413') { json(res, Number(mode), { error: { message: mode === '403' ? 'forbidden' : 'too large' } }); return; }
      if (mode === '400' || (mode === '400-prompt' && 'prompt' in form.fields)) { json(res, 400, { error: { message: 'bad request' } }); return; }
      if (mode === 'badjson') { json(res, 200, '<html>not json</html>'); return; }
      if (mode === 'slow') { later(1500, () => { if (!res.destroyed && !res.writableEnded) reply(); }); return; }
      reply();
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const origin = `http://127.0.0.1:${port}`;
      resolve({
        base: `${origin}/openai/v1`,
        url: (path) => `${origin}${path}`,
        requests,
        close: () => new Promise((r) => {
          for (const t of timers) clearTimeout(t);
          timers.clear();
          server.close(() => r());
          server.closeAllConnections();
        }),
      });
    });
  });
}

module.exports = { startFakeStt, parseForm, wavOk };
