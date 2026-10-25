'use strict';
// 偽の whisper-server。main.js が spawn する実行ファイルの代わりに、node で起動される
// （mainrun.js が child_process.spawn を差し替える）。/health は 200、/inference は FAKE_MODE で答える。
//   text          … いつも文を返す（改行を挟む。main 側で 1 行にまとめるかを見る）
//   empty         … ヒント付きは {"text":""}、ヒントなしは "[BLANK_AUDIO]"（どちらも main では空になる）
//   prompt-empty  … ヒント（prompt）付きなら {"text":""}、無ければ文（kotoba-whisper に長いヒントを渡したとき。0.1.1）
//   mixed         … 大きい区間（80KB 超）は空、小さい区間は文（一部だけ空の議事録）
//   err200        … 200 のまま {"error": …}（古い whisper-server が WAV を読めないとき）
//   probe500      … 起動テストの試し（probe.wav）にだけ 500。ほかは文
//   probe-badjson … 起動テストの試しにだけ JSON でない返事
//   probe-drop    … 起動テストの試しにだけ、返事をせずに接続を切る
//   slow          … 区間の返事を 1.5 秒遅らせる（文字起こしの最中に起動テストを押した場面）
//   slow-prompt-empty … ヒント付きの区間は 1.5 秒待ってから {"text":""}、ヒントなしは文（返事を待つ間に議事録を破棄する場面）
//   big-prompt-empty  … 大きい区間（80KB 超）だけ、ヒント付きなら {"text":""}。ほかは文（雑音の 1 区間だけヒントで空になる場面）
//   drop-first    … 区間（起動テストの試しでない）の最初の要求だけ、受け取った後で返事をせずに接続を切る。2 回目からは文
//                   （CI run 39183232615: 起動テストの直後、区間の要求が使い回しの接続の上で切れた）
//   drop-all      … 区間の要求は毎回、受け取った後で返事をせずに接続を切る
//   0.9.4 S-2:
//   hang          … 区間の要求には答えない（main の時間切れで切られるまで。接続が閉じられたら FAKE_LOG に closed を書く）
//   hang-first    … 区間の最初の要求だけ答えない（FAKE_HANG_N があればその数まで。FAKE_LOG の隣の印のファイルで数える: 起こし直した次のプロセスは答える）
//   err500        … 区間の要求に 500 {"error":"boom"}（エンジンが答えた誤り）
//   refuse        … 区間の要求を受けたら口を閉じ、その接続も切る（次からは ECONNREFUSED。エンジンが止まった）
//   delay         … 0.9.4 S-4: 区間の答えを FAKE_DELAY_MS ミリ秒遅らせる（遅い PC）
// 0.9.4 S-4: FAKE_START_MS があれば、その分だけ口を開くのを遅らせる（エンジンの起動・モデルの読み込みに時間がかかる）
// どの場面でも、WAV の頭（RIFF/WAVE、16kHz・モノラル・16bit）が壊れていれば 200 のまま {"error"} を返す
// （本物の 1.7.6・1.8.0 と同じ）。受けた要求は FAKE_LOG に 1 行ずつ書く。
// 0.12.0 SP-3a: FAKE_TAG_FILE（JSON の文の並び）があり、WAV の末尾の3つの標本が [3, -3, 番号] なら、その番号の文を返す（mainrun の --two-streams）
// 0.12.0 SP-3b: response_format が verbose_json なら、文（「。」で切る）ごとに区間の長さを等分した start・end（秒）の segments を付ける。
//   FAKE_SENTENCES=none は segments を付けない（古いエンジン）・drift は最後の end を 3 秒ずらす。要求の行に rf=<response_format> を足した
// 0.12.0 SP-3a: 要求の行の最後に busy=<そのとき答えていない区間の要求の数（この要求を含む）>（2つの流れの会議で PC へ同時に送らないかを見る）

const http = require('http');
const fs = require('fs');

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const mode = process.env.FAKE_MODE || 'text';
const log = process.env.FAKE_LOG;
const note = (line) => { if (log) { try { fs.appendFileSync(log, `${line}\n`); } catch (_) { /* 片付けの後 */ } } };
note(`spawn ${JSON.stringify(args)}`);

// 起動した側（mainrun）が居なくなったら自分も終わる（孤児として残り続けない）
const parent = process.ppid;
setInterval(() => { try { process.kill(parent, 0); } catch (_) { process.exit(0); } }, 500).unref();

// multipart の本文から、名前の付いた欄（文字）と file の中身（バイト列）を取り出す
function parseForm(buf, type) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type || '');
  const out = { fields: {}, file: null, filename: '' };
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
      if (filename !== undefined) { out.file = body; out.filename = filename; } else if (name) out.fields[name] = body.toString('utf8');
    }
    i = next;
  }
  return out;
}

const wavOk = (b) => Boolean(b && b.length >= 44 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE'
  && b.toString('ascii', 12, 16) === 'fmt ' && b.readUInt16LE(20) === 1 && b.readUInt16LE(22) === 1
  && b.readUInt32LE(24) === 16000 && b.readUInt16LE(34) === 16 && b.toString('ascii', 36, 40) === 'data'
  && b.readUInt32LE(40) > 0 && b.readUInt32LE(40) <= b.length - 44);

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

let n = 0;
let dropped = false;
let busy = 0;   // 0.12.0 SP-3a: 答えていない区間の要求の数
const server = http.createServer((req, res) => {
  if (req.url === '/health') { json(res, 200, { status: 'ok' }); return; }
  if (req.url !== '/inference') { res.writeHead(404); res.end(); return; }
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    n++;
    const body = Buffer.concat(chunks);
    const form = parseForm(body, req.headers['content-type']);
    const hasPrompt = 'prompt' in form.fields;
    const isProbe = form.filename === 'probe.wav';
    const okWav = wavOk(form.file);
    if (!isProbe) { busy++; res.on('close', () => { busy--; }); }
    note(`inference #${n} bytes=${body.length} prompt=${hasPrompt} probe=${isProbe} lang=${form.fields.language || ''} carry=${form.fields.carry_initial_prompt || ''} nc=${form.fields.no_context || ''} wav=${okWav} busy=${busy} rf=${form.fields.response_format || ''}`);
    if (!okWav) { json(res, 200, { error: 'failed to read audio data' }); return; }
    if (isProbe && mode === 'probe500') { json(res, 500, { error: 'boom' }); return; }
    if (isProbe && mode === 'probe-badjson') { json(res, 200, 'not json'); return; }
    if (isProbe && mode === 'probe-drop') { req.socket.destroy(); return; }
    if (!isProbe && (mode === 'drop-all' || (mode === 'drop-first' && !dropped))) { dropped = true; req.socket.destroy(); return; }
    const hungMark = `${log || ''}.hung`;
    const hung = () => { try { return Number(fs.readFileSync(hungMark, 'utf8')) || 0; } catch (_) { return 0; } };
    if (!isProbe && (mode === 'hang' || (mode === 'hang-first' && log && hung() < (Number(process.env.FAKE_HANG_N) || 1)))) {
      if (mode === 'hang-first') fs.writeFileSync(hungMark, String(hung() + 1));
      req.socket.on('close', () => note(`closed #${n}`));
      return;
    }
    if (!isProbe && mode === 'err500') { json(res, 500, { error: 'boom' }); return; }
    if (!isProbe && mode === 'refuse') { server.close(); req.socket.destroy(); return; }
    if (mode === 'err200') { json(res, 200, { error: 'failed to read audio data' }); return; }
    if (mode === 'empty') { json(res, 200, { text: hasPrompt ? '' : ' [BLANK_AUDIO]\n' }); return; }
    if (mode === 'prompt-empty' && hasPrompt) { json(res, 200, { text: '' }); return; }
    if (mode === 'mixed' && !isProbe && form.file.length > 80000) { json(res, 200, { text: '' }); return; }
    if (mode === 'big-prompt-empty' && hasPrompt && form.file.length > 80000) { json(res, 200, { text: '' }); return; }
    if (mode === 'slow-prompt-empty' && hasPrompt && !isProbe) { setTimeout(() => json(res, 200, { text: '' }), 1500); return; }
    const tagged = (() => {
      const f = form.file;
      if (!process.env.FAKE_TAG_FILE || !f || f.length < 50) return null;
      const k = Math.floor((f.length - 44) / 2);
      const at = (i) => f.readInt16LE(44 + (k - i) * 2);
      if (at(3) !== 3 || at(2) !== -3) return null;
      try { const list = JSON.parse(fs.readFileSync(process.env.FAKE_TAG_FILE, 'utf8')); return typeof list[at(1)] === 'string' ? list[at(1)] : null; } catch (_) { return null; }
    })();
    const answerText = tagged !== null ? tagged : process.env.FAKE_TEXT ? `${process.env.FAKE_TEXT}区間${n}` : ` 本日の議題は\n進捗の確認です。区間${n}\n`;
    const sentencesOf = (text) => {
      const pieces = String(text).split(/(?<=。)/).filter((x) => x.trim());
      const sec = okWav ? Math.floor((form.file.length - 44) / 2) / 16000 : 0;
      const segs = pieces.map((x, i) => ({ id: i, start: Math.round((i * sec / pieces.length) * 1000) / 1000, end: Math.round(((i + 1) * sec / pieces.length) * 1000) / 1000, text: x }));
      if (segs.length && process.env.FAKE_SENTENCES === 'drift') segs[segs.length - 1].end += 3;
      return segs;
    };
    const reply = () => json(res, 200, form.fields.response_format === 'verbose_json' && process.env.FAKE_SENTENCES !== 'none'
      ? { text: answerText, segments: sentencesOf(answerText) } : { text: answerText });
    if (mode === 'slow' && !isProbe) setTimeout(reply, 1500);
    else if (mode === 'delay' && !isProbe) setTimeout(reply, Number(process.env.FAKE_DELAY_MS) || 0);
    else reply();
  });
}).on('error', (e) => {
  // ポートが塞がっていたなど。黙って落ちると原因が分からないので、記録に残して終わる
  note(`listen error ${e.code || e.message}`);
  process.exit(3);
});
setTimeout(() => server.listen(port, '127.0.0.1'), Number(process.env.FAKE_START_MS) || 0);
