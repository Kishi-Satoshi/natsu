#!/usr/bin/env node
/*
 * engine-smoke.js — 取り込むエンジンの本物を、Windows の CI で確かめる（第0b回 Task 8。RF1・RF10）
 *
 *   node tools/engine-smoke.js --pins
 *     MANIFEST の全部の項目に Range: bytes=0-0 で GET し、転送を手で追う。
 *     最後の応答が 206 で、Content-Range の総量がピンの大きさと同じこと。
 *     Hugging Face の項目は、途中の転送の x-linked-etag がピンの SHA-256、x-repo-commit が URL の
 *     commit と同じこと。上流が資産を消したり替えたりしていないかを毎回見る（RF10）。
 *     要約のモデル（約 5GB）も、ここで届くかと記録が合うかだけを見る（--start では落とさない）。
 *
 *   node tools/engine-smoke.js --start
 *     1. Windows の ANSI と OEM のコードページを、レジストリから読んでログに出す（エンジンが引数を
 *        読むときに使うのは ANSI。コンソールのコードページではない）。Visual C++ ランタイムの4つの DLL の
 *        版も、アプリと同じ vcRuntimeVersions で System32 から読んでログに出す（RF4。どちらの zip にも無い）。
 *     2. 本物の CDN で、取り消してから続きを取れるか（resumeCheck）。キャッシュがあっても毎回。
 *     3. é・日本語・𠮷 の名前のフォルダに、アプリと同じ道（fetchFile → listZip/readEntry で
 *        MANIFEST の files だけを出して SHA-256 を照らす）でエンジンと試験用の小さなモデルを置く。
 *        取ったものはキャッシュ（英数字だけの名前）に置き、SHA-256 の合うものは取り直さない。
 *     4. whisper を engineSpawnPlan（アプリと同じ）で起動し、/health の後に /inference へ無音を送る
 *        （VAD のモデルは最初の文字起こしで初めて読む）。
 *     5. 負の確かめ: 同じ whisper を、-m を英数字以外の絶対パスのままで起動し、落ちる（か /health が
 *        来ない）ことを見る。200 になったら、RF1 を試せていない。
 *     6. llama を英数字以外の絶対パスのモデルで起動し（llama は引数を UTF-16 から読み直す）、
 *        /health と /completion を見る。
 *     落としたエンジンを起動するのは Windows だけ。ほかの OS では 1〜3 だけをして、NG で終わる。
 *
 * 結果は1行ずつ OK／NG で出し、1つでも NG なら終了コード 1。
 * 通信はアプリと同じ net.request の形で行う（test/helpers/fake-net.js の fakeRequest を https で使う）。
 * 素のグローバルの fetch は使わない（RF2）。GitHub の API も使わない（資産の URL を直に使う）。
 * Electron は読み込まない（CI の node で走る）。npm の依存も使わない。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { MANIFEST, hostOf } = require('../src/engine-manifest');
const { fetchFile, hget, parseContentRange } = require('../src/engine-fetch');
const { listZip, readEntry } = require('../src/zipread');
const { engineSpawnPlan, silentWav, vcRuntimeVersions, vcRuntimeIssue } = require('../src/mainlib');
const { fakeRequest } = require('../test/helpers/fake-net');

const UA = `NaTsu/${require('../package.json').version} (engine-smoke)`;
const TEMP = process.env.RUNNER_TEMP || os.tmpdir();
// 英数字だけの名前（ci.yml の actions/cache と同じ場所）
const CACHE = path.join(TEMP, 'engine-cache');
// 利用者名に é・日本語・𠮷 が入った PC と同じ形。é は CP1252（CI の機械の ANSI）にあって UTF-8 としては
// 正しくないので、日本語の Windows と同じ「例外で落ちる」道を通る。𠮷 は CP932 に無い字。
const USER_DIR = path.join(TEMP, 'Jé 日本語ユーザー𠮷');
const ROOT = path.join(USER_DIR, 'AppData', 'Local', 'natsu', 'engine');

// 試験用の小さなモデル。アプリのピン（engine-manifest.js）には入れない。
const SMALL = Object.freeze({
  whisper: Object.freeze({
    id: 'whisper-tiny',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny-q5_1.bin',
    size: 32152673, sha256: '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7',
    dest: 'models/ggml-tiny-q5_1.bin',
  }),
  llama: Object.freeze({
    id: 'llama-stories',
    url: 'https://huggingface.co/ggml-org/models-moved/resolve/499bc8821c6b12b4e53c5bffcb21ec206f212d81/tinyllamas/stories260K.gguf',
    size: 1185376, sha256: '270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d',
    dest: 'models/stories260K.gguf',
  }),
});

const PORT = { whisper: 18990, llama: 18991, negative: 18992 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(line);
const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (file) => sha256Of(fs.readFileSync(file));
const ok = (name, why) => ({ ok: true, line: `OK ${name}: ${why}` });
const ng = (name, why) => ({ ok: false, line: `NG ${name}: ${why}` });
const report = (r) => { log(r.line); return r; };
const itemOf = (id) => MANIFEST.items.find((i) => i.id === id);
const fileNameOf = (url) => path.posix.basename(new URL(url).pathname);
const placeOf = (rel) => path.join(ROOT, ...rel.split('/'));
const errText = (e) => (e && (e.code ? `${e.code}${e.message ? `（${e.message}）` : ''}` : e.message)) || String(e);

// ---------------------------------------------------------------- --pins
/**
 * 1つの項目に Range: bytes=0-0 で GET し、転送を手で追う。{ ok, line } を返す（投げない）。
 * request は net.request の形（既定は fakeRequest）。
 */
function checkPin(item, { request = fakeRequest, timeoutMs = 60000, maxHops = 10 } = {}) {
  const name = `${item.id}（${hostOf(item.url)}）`;
  const hf = hostOf(item.url) === 'huggingface.co';
  const commit = (/\/resolve\/([0-9a-f]{40})\//.exec(item.url) || [])[1] || '';
  const seen = { etag: [], commit: [], size: [] };
  return new Promise((resolve) => {
    let done = false;
    let hops = 0;
    let req = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { req.abort(); } catch (_) { /* もう終わっている */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish(ng(name, `${timeoutMs / 1000} 秒で答えが来ない`)), timeoutMs);
    try {
      req = request({ method: 'GET', url: item.url, redirect: 'manual', cache: 'no-store' });
      req.setHeader('Range', 'bytes=0-0');
      req.setHeader('Accept-Encoding', 'identity');
      req.setHeader('User-Agent', UA);
    } catch (e) {
      finish(ng(name, `要求を作れない ${errText(e)}`));
      return;
    }
    req.on('redirect', (status, method, newUrl, headers) => {
      if (++hops > maxHops) { finish(ng(name, `転送が ${maxHops} 回を超えた`)); return; }
      const etag = hget(headers, 'x-linked-etag');
      const repo = hget(headers, 'x-repo-commit');
      const size = hget(headers, 'x-linked-size');
      if (etag) seen.etag.push(String(etag).replace(/^W\//, '').replace(/"/g, ''));
      if (repo) seen.commit.push(String(repo));
      if (size) seen.size.push(Number(size));
      log(`  ${item.id}: ${status} → ${hostOf(newUrl)}`);
      req.followRedirect();   // 同じ流れの中で続ける（fetchFile と同じ）
    });
    req.on('login', (info, cb) => cb());   // 何も渡さない＝取り消す（アプリと同じ）
    req.on('error', (e) => finish(ng(name, `通信の失敗 ${errText(e)}`)));
    req.on('response', (res) => {
      const st = res.statusCode;
      const cr = parseContentRange(hget(res.headers, 'content-range'));
      res.on('error', () => {});
      res.resume();
      const bad = [];
      if (st !== 206) bad.push(`最後の応答が ${st}（206 でない。資産が消えたか、Range が効かない）`);
      else if (!cr) bad.push('206 なのに Content-Range が読めない');
      else if (cr.total !== item.size) bad.push(`Content-Range の総量 ${cr.total} がピンの大きさ ${item.size} と違う`);
      if (hf) {
        if (!seen.etag.length) bad.push('転送に x-linked-etag が無い');
        else if (seen.etag.some((e) => e !== item.sha256)) bad.push(`x-linked-etag ${seen.etag.join(',')} がピンの SHA-256 と違う`);
        if (!seen.commit.length) bad.push('転送に x-repo-commit が無い');
        else if (seen.commit.some((c) => c !== commit)) bad.push(`x-repo-commit ${seen.commit.join(',')} が URL の commit ${commit} と違う`);
        if (seen.size.some((n) => n !== item.size)) bad.push(`x-linked-size ${seen.size.join(',')} がピンの大きさと違う`);
      }
      if (bad.length) { finish(ng(name, bad.join('・'))); return; }
      finish(ok(name, `206・総量 ${cr.total} バイト${hf ? '・x-linked-etag と x-repo-commit がピンと同じ' : ''}`));
    });
    req.end();
  });
}

async function pins() {
  const rs = [];
  for (const item of MANIFEST.items) rs.push(report(await checkPin(item)));
  return rs;
}

// ---------------------------------------------------------------- --start: コードページ
function codePages() {
  const key = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage';
  for (const v of ['ACP', 'OEMCP']) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', v], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const m = new RegExp(`\\b${v}\\s+REG_SZ\\s+(\\S+)`).exec(out);
      log(`コードページ ${v}: ${m ? m[1] : out.trim()}`);
    } catch (e) {
      log(`コードページ ${v}: 読めない（${String(e.message).split('\n')[0]}）`);
    }
  }
}

// ---------------------------------------------------------------- --start: Visual C++ ランタイム（RF4）
// 4つの DLL の版を、アプリと同じ vcRuntimeVersions で読んでログに出す。まだ何も置いていないので、exe の
// フォルダは渡さず System32 だけを読む（CI の機械に入っている版）。結果の OK／NG には数えない（記録だけ）。
function runtimeVersions() {
  if (process.platform !== 'win32') { log('Visual C++ ランタイム: Windows でだけ読む'); return; }
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  const read = (f) => { try { return fs.readFileSync(f); } catch (_) { return null; } };
  const v = vcRuntimeVersions('', sys, read);
  log(`Visual C++ ランタイム（${sys}）: ${Object.entries(v).map(([d, x]) => `${d} ${x || 'なし'}`).join('、')}`);
  log(`Visual C++ ランタイムの判断: whisper ${vcRuntimeIssue(v, { whisper: true }).level}・llama ${vcRuntimeIssue(v, { whisper: false }).level}`);
}

// ---------------------------------------------------------------- --start: 続きから（本物の CDN）
/** request を包み、要求ごとの Range の見出しと最後の応答の状態コードを seen に残す */
function watchRequests(request, seen) {
  return (opts) => {
    const req = request(opts);
    const rec = { url: opts.url, range: null, status: null };
    seen.push(rec);
    const setHeader = req.setHeader.bind(req);
    req.setHeader = (k, v) => { if (String(k).toLowerCase() === 'range') rec.range = v; setHeader(k, v); };
    req.on('response', (res) => { rec.status = res.statusCode; });
    return req;
  };
}

/**
 * キャッシュを使わずに一時フォルダへ取り、cancelAt バイトを超えたら取り消す。それから新しく fetchFile を
 * 呼んで続きを取る。2回目の最初の要求が Range: bytes=<残した長さ>- で 206 になり、最後の SHA-256 が
 * ピンと合うこと。{ ok, line } を返す（投げない）。o はテスト用（pin・request・requireHttps・tmp）。
 */
async function resumeCheck(id, cancelAt, o = {}) {
  const pin = o.pin || itemOf(id);
  const name = `続きから（${id}・${hostOf(pin.url)}）`;
  const request = o.request || fakeRequest;
  const dir = fs.mkdtempSync(path.join(o.tmp || TEMP, 'natsu-取込𠮷-'));
  const base = { dir, dest: path.join(dir, 'out', fileNameOf(pin.url)), sleep, log, progressMs: 0, userAgent: UA,
    requireHttps: o.requireHttps !== false };
  try {
    const ac = new AbortController();
    try {
      await fetchFile(pin, { ...base, request, signal: ac.signal, onProgress: (p) => { if (p && p.done > cancelAt) ac.abort(); } });
      return ng(name, `${cancelAt} バイトを超えても取り消せず、最後まで取れてしまった`);
    } catch (e) {
      if (!e || e.code !== 'cancelled') return ng(name, `1回目が取り消しでなく ${errText(e)} で終わった`);
    }
    let held = null;
    try { held = JSON.parse(fs.readFileSync(path.join(dir, `${pin.sha256}.json`), 'utf8')).synced; } catch (_) { /* 下で扱う */ }
    if (!(Number.isInteger(held) && held > 0 && held < pin.size)) return ng(name, `取り消した後の記録の長さが ${held}（1〜${pin.size - 1} でない）`);
    const seen = [];
    const r = await fetchFile(pin, { ...base, request: watchRequests(request, seen) });
    const first = seen[0];
    if (!first) return ng(name, '2回目に要求を出していない');
    if (first.range !== `bytes=${held}-`) return ng(name, `2回目の最初の要求の Range が ${first.range}（bytes=${held}- でない）`);
    if (first.status !== 206) return ng(name, `2回目の最初の要求の応答が ${first.status}（206 でない）`);
    const sha = sha256File(r.file);
    if (sha !== pin.sha256) return ng(name, `取り終えたファイルの SHA-256 ${sha} がピンと違う`);
    return ok(name, `${held} バイトで取り消し → 2回目は ${first.range} で 206 → SHA-256 がピンと同じ（要求 ${seen.length} 回）`);
  } catch (e) {
    return ng(name, errText(e));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- --start: 置く
/** キャッシュに取る（SHA-256 の合うものがあれば、fetchFile は要求を出さずにそれを使う）。キャッシュのパスを返す */
async function obtain(pin) {
  const file = fileNameOf(pin.url);
  const r = await fetchFile(pin, { dir: path.join(CACHE, 'download'), dest: path.join(CACHE, file), request: fakeRequest,
    sleep, log, userAgent: UA });
  log(`${r.reused ? 'キャッシュを使う' : '取った'}: ${file}（${pin.size} バイト）`);
  return r.file;
}

/** zip から MANIFEST の files だけを出し、1つずつ大きさと SHA-256 を照らして置く（アプリと同じ）。exe のパスを返す */
async function placeZip(item, zipFile) {
  const buf = fs.readFileSync(zipFile);
  if (sha256Of(buf) !== item.sha256) throw new Error(`${item.id} の zip の SHA-256 がピンと違う`);
  const entries = new Map(listZip(buf).map((e) => [e.name, e]));
  const dir = placeOf(item.dir);
  for (const f of item.files) {
    const e = entries.get(f.name);
    if (!e) throw new Error(`${item.id} の zip に ${f.name} が無い`);
    if (!f.name.startsWith(item.strip)) throw new Error(`${f.name} が ${item.strip} の外`);
    const data = await readEntry(buf, e);
    if (data.length !== f.size || sha256Of(data) !== f.sha256) throw new Error(`${item.id} の ${f.name} の中身がピンと違う`);
    const out = path.join(dir, ...f.name.slice(item.strip.length).split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
  log(`置いた: ${item.id} の ${item.files.length} 個 → ${dir}`);
  return path.join(dir, item.exe);
}

async function placeFile(pin) {
  const out = placeOf(pin.dest);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(await obtain(pin), out);
  if (sha256File(out) !== pin.sha256) throw new Error(`${pin.id} を置いた後の SHA-256 がピンと違う`);
  log(`置いた: ${pin.id} → ${out}`);
  return out;
}

async function placeAll() {
  fs.rmSync(USER_DIR, { recursive: true, force: true });   // 前の回の残りで通らないように
  const w = itemOf('whisper-engine');
  const l = itemOf('sum-engine');
  return {
    whisperExe: await placeZip(w, await obtain(w)),
    vad: await placeFile(itemOf('whisper-vad')),
    tiny: await placeFile(SMALL.whisper),
    llamaExe: await placeZip(l, await obtain(l)),
    stories: await placeFile(SMALL.llama),
  };
}

// ---------------------------------------------------------------- --start: 起動
function httpCall(port, method, urlPath, { body = null, type = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = body ? { 'content-type': type, 'content-length': body.length } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${timeoutMs / 1000} 秒で答えが来ない`)));
    req.on('error', reject);
    req.end(body || undefined);
  });
}

function startChild(exe, args, cwd) {
  const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  child.stderr.on('data', (b) => { tail = (tail + b.toString('utf8')).slice(-3000); });
  child.ended = null;
  child.exited = new Promise((resolve) => {
    const end = (r) => { if (!child.ended) { child.ended = r; resolve(r); } };
    child.on('exit', (code, signal) => end({ code, signal }));
    child.on('error', (e) => end({ code: null, error: e }));
  });
  child.tail = () => tail;
  return child;
}

async function stopChild(label, child) {
  if (!child.ended) child.kill();
  const r = await Promise.race([child.exited, sleep(15000).then(() => null)]);
  log(`${label} 終了: ${r ? `終了コード ${r.code}${r.signal ? `（${r.signal}）` : ''}${r.error ? ` ${errText(r.error)}` : ''}` : '15 秒で止まらない'}`);
  const tail = child.tail().trim();
  log(`${label} の stderr の末尾:${tail ? `\n${tail.split(/\r?\n/).slice(-15).map((s) => `  | ${s}`).join('\n')}` : ' （なし）'}`);
}

/** /health が 200 になるまで待つ。{ ok } か { ok: false, exited } か { ok: false, timeout: true } */
async function waitHealth(port, child, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.ended) return { ok: false, exited: child.ended };
    const r = await httpCall(port, 'GET', '/health', { timeoutMs: 2000 }).catch(() => null);
    if (r && r.status === 200) return { ok: true };
    await sleep(500);
  }
  return { ok: false, timeout: true };
}

const healthText = (h) => (h.exited ? `起動して /health の前に終わった（終了コード ${h.exited.code}${h.exited.error ? ` ${errText(h.exited.error)}` : ''}）` : '/health が 200 にならない');

/** 無音の WAV を /inference へ送る（アプリの起動テストと同じ欄）。200 の JSON で error が無いこと */
async function inference(port) {
  const b = `----natsu${crypto.randomBytes(8).toString('hex')}`;
  const field = (k, v) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="probe.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    silentWav(2), Buffer.from('\r\n'),
    field('response_format', 'json'), field('temperature', '0.0'), field('no_context', 'true'), field('language', 'ja'),
    Buffer.from(`--${b}--\r\n`),
  ]);
  const r = await httpCall(port, 'POST', '/inference', { body, type: `multipart/form-data; boundary=${b}`, timeoutMs: 120000 });
  let data = null;
  try { data = JSON.parse(r.text); } catch (_) { /* 下で扱う */ }
  if (r.status !== 200) return { ok: false, why: `/inference が ${r.status}: ${r.text.slice(0, 200)}` };
  if (!data || typeof data !== 'object') return { ok: false, why: `/inference の返事が JSON でない: ${r.text.slice(0, 200)}` };
  if (data.error) return { ok: false, why: `/inference が error を返した: ${data.error}` };
  return { ok: true, why: `/inference が 200（文 ${JSON.stringify(String(data.text || '').trim()).slice(0, 60)}）` };
}

const whisperArgs = (model, vad, port) => ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', '2', '-l', 'ja', '-sns',
  '--vad', '--vad-model', vad];

async function smokeWhisper(p) {
  const name = 'whisper（相対パス・日本語の作業フォルダ）';
  const plan = engineSpawnPlan(p.whisperExe, whisperArgs(p.tiny, p.vad, PORT.whisper), { whisper: true });
  if (plan.problem) return ng(name, `engineSpawnPlan が起動を止めた: ${plan.problem}`);
  log(`whisper 起動: ${p.whisperExe} ${plan.args.join(' ')}（作業フォルダ: ${plan.cwd}）`);
  const child = startChild(p.whisperExe, plan.args, plan.cwd);
  try {
    const h = await waitHealth(PORT.whisper, child, 60000);
    if (!h.ok) return ng(name, healthText(h));
    const inf = await inference(PORT.whisper);   // ここで VAD のモデルが読まれる
    return inf.ok ? ok(name, `/health が 200・${inf.why}`) : ng(name, inf.why);
  } catch (e) {
    return ng(name, errText(e));
  } finally {
    await stopChild('whisper', child);
  }
}

// 負の確かめ: 同じ whisper を、-m を英数字以外の絶対パスのままで起動する（アプリの相対化を通さない）。
// 30 秒以内に終わるか、/health が 200 にならないこと。200 になったら、RF1 を試せていない。
// 相対パスの whisper（smokeWhisper）が動かなかったときや、起動そのものができないときは、落ちても
// RF1 のせいとは言えないので NG にする（DLL が無いなど、別の理由で落ちているかもしれない）。
async function smokeWhisperAbsolute(p, relativeOk = true) {
  const name = '負の確かめ（whisper に英数字以外の絶対パス）';
  const plan = engineSpawnPlan(p.whisperExe, whisperArgs(p.tiny, p.vad, PORT.negative), { whisper: true });
  const args = plan.args.map((a, i) => (plan.args[i - 1] === '-m' ? p.tiny : a));
  log(`whisper 起動（負の確かめ）: ${p.whisperExe} ${args.join(' ')}（作業フォルダ: ${plan.cwd}）`);
  const child = startChild(p.whisperExe, args, plan.cwd);
  try {
    const h = await waitHealth(PORT.negative, child, 30000);
    if (h.ok) return ng(name, '/health が 200 になった。RF1 を試せていない（上流が直したか、置き場所が英数字だけ）');
    if (h.exited && h.exited.error) return ng(name, `起動できない ${errText(h.exited.error)}`);
    const seen = h.exited ? `落ちた（終了コード ${h.exited.code}）` : '30 秒の間 /health が 200 にならない';
    if (!relativeOk) return ng(name, `${seen}。ただし相対パスの whisper も動かなかったので、RF1 のせいとは言えない`);
    return ok(name, seen);
  } catch (e) {
    return ng(name, errText(e));
  } finally {
    await stopChild('whisper（負の確かめ）', child);
  }
}

async function smokeLlama(p) {
  const name = 'llama（英数字以外の絶対パス）';
  // 取り込んだ llama の旗は Task 16 で同じものを足す
  const args = ['-m', p.stories, '--host', '127.0.0.1', '--port', String(PORT.llama), '-t', '2', '-c', '512'];
  const cwd = path.dirname(p.llamaExe);
  log(`llama 起動: ${p.llamaExe} ${args.join(' ')}（作業フォルダ: ${cwd}）`);
  const child = startChild(p.llamaExe, args, cwd);
  try {
    const h = await waitHealth(PORT.llama, child, 60000);
    if (!h.ok) return ng(name, healthText(h));
    const r = await httpCall(PORT.llama, 'POST', '/completion',
      { body: Buffer.from(JSON.stringify({ prompt: 'Once', n_predict: 4 })), type: 'application/json', timeoutMs: 60000 });
    if (r.status !== 200) return ng(name, `/completion が ${r.status}: ${r.text.slice(0, 200)}`);
    return ok(name, '/health と /completion が 200');
  } catch (e) {
    return ng(name, errText(e));
  } finally {
    await stopChild('llama', child);
  }
}

async function start() {
  const rs = [];
  codePages();
  runtimeVersions();
  rs.push(report(await resumeCheck('whisper-vad', 400 * 1024)));
  rs.push(report(await resumeCheck('whisper-engine', 1024 * 1024)));
  let placed = null;
  try {
    placed = await placeAll();
    rs.push(report(ok('置き場所', ROOT)));
  } catch (e) {
    rs.push(report(ng('置き場所', errText(e))));
    return rs;
  }
  if (process.platform !== 'win32') {
    rs.push(report(ng('起動', 'エンジンの起動は Windows でだけ試す（ほかの OS では落としたエンジンを実行しない）')));
    return rs;
  }
  const relative = report(await smokeWhisper(placed));
  rs.push(relative);
  rs.push(report(await smokeWhisperAbsolute(placed, relative.ok)));
  rs.push(report(await smokeLlama(placed)));
  return rs;
}

// ---------------------------------------------------------------- 入口
async function main(argv) {
  const mode = argv[0];
  let rs;
  if (mode === '--pins') rs = await pins();
  else if (mode === '--start') rs = await start();
  else { log('使い方: node tools/engine-smoke.js --pins | --start'); return 2; }
  const bad = rs.filter((r) => !r.ok).length;
  log(`結果: OK ${rs.length - bad} 件 / NG ${bad} 件`);
  return bad ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    log(`NG 止まった: ${(e && e.stack) || e}`);
    process.exitCode = 1;
  }).finally(() => {
    // 残ったつなぎ（keep-alive）で終わりが延びないように。unref なので、ほかに何も無ければ待たない
    setTimeout(() => process.exit(process.exitCode), 10000).unref();
  });
}

module.exports = { checkPin, resumeCheck, watchRequests, placeZip, smokeWhisper, smokeWhisperAbsolute, smokeLlama, SMALL, PORT, main };
