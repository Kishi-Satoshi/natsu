'use strict';
// main.js を偽の Electron の上で実際に動かし、記録 → 区間 → 文字起こし → 議事録の保存までを通す。
// 1 回の実行で 1 つの場面だけを試す（main.js はモジュールの中に状態を持つので、場面ごとに
// 別のプロセスにする）。結果は最後の行に JSON で出す。使い方:
//   node test/helpers/mainrun.js <FAKE_MODE> [--test] [--test-during] [--silent] [--vad] [--segs=N]
//     FAKE_MODE     … fake-whisper.js の答え方（text / empty / prompt-empty / mixed / err200 / probe500 など）
//     --test        … 記録の前に設定の［起動テスト］（app:test）を呼ぶ
//     --test-during … 最初の区間を送った直後（文字起こしの最中）に［起動テスト］を呼ぶ
//     --silent      … 区間の音声を無音にする（既定は 220Hz の音）
//     --vad         … VAD のモデル（偽物）をモデルの隣に置く（エンジンが --vad 付きで起動する）
//     --segs=N      … 送る区間の数（既定 2。1 つ目は 3 秒、2 つ目からは 2 秒）
// 本物のエンジンで試すときは NATSU_E2E_EXE・NATSU_E2E_MODEL・NATSU_E2E_WAVS（; 区切り）を渡す。
// 終わるときは、起動したエンジンを止め、一時フォルダを消す（npm test のたびに残さない）。

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const FAKE = path.join(__dirname, 'fake-whisper.js');
const mode = process.argv[2] || 'text';
const flags = process.argv.slice(3);
const runTest = flags.includes('--test');
const testDuring = flags.includes('--test-during');
const silent = flags.includes('--silent');
const withVad = flags.includes('--vad');
const segCount = Number((flags.find((f) => f.startsWith('--segs=')) || '--segs=2').slice(7)) || 2;

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 220Hz の正弦波の WAV（16kHz・モノラル・16bit。amp=0 で無音）。区間になるには 4000 バイト以上が要る
function toneWav(sec, amp = 8000) {
  const n = 16000 * sec;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * 220 * i / 16000)), 44 + i * 2);
  return b;
}

// 何を聞かれても、それらしい値か自分自身を返す（使わない Electron の API を丸ごと受け流す）
function anyProxy() {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, k) {
      if (k === 'then') return undefined;
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'isDestroyed' || k === 'isVisible') return () => false;
      return anyProxy();
    },
    apply() { return anyProxy(); },
    construct() { return anyProxy(); },
  });
}
const withFallback = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : anyProxy()) });

// 終わり方: 起動したエンジンを止め、一時フォルダを消す。process.exit の前に必ず通る
const kids = [];
let tmp = '';
process.on('exit', () => {
  for (const k of kids) { try { k.kill(); } catch (_) { /* noop */ } }
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* 消せなくても結果は出す */ } }
});

(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-e2e-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const engDir = path.join(tmp, 'engine');
  fs.mkdirSync(engDir);
  // 偽のモデル。中身は見られず、大きさの床（50MB）だけを超えればよい。残りは疎にして場所を取らない。
  // 先頭だけは実際に書く（全部が疎だと blocks が 0 になり、OneDrive のプレースホルダと見なされる）
  let model = process.env.NATSU_E2E_MODEL;
  if (!model) {
    model = path.join(engDir, 'ggml-fake.bin');
    const fd = fs.openSync(model, 'w');
    fs.writeSync(fd, Buffer.alloc(8192, 1));
    fs.ftruncateSync(fd, 51 * 1024 * 1024);
    fs.closeSync(fd);
  }
  if (withVad) fs.writeFileSync(path.join(path.dirname(model), 'ggml-silero-v6.2.0.bin'), Buffer.alloc(1024, 1));
  const exe = process.env.NATSU_E2E_EXE || FAKE;
  const flog = path.join(tmp, 'fake.log');
  fs.writeFileSync(flog, '');
  process.env.FAKE_MODE = mode;
  process.env.FAKE_LOG = flog;
  const localPort = await freePort();
  const sumPort = await freePort();
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    localServerExe: exe, localModelPath: model, localPort, sumPort, autoLaunch: false,
  }));

  const handlers = {}, listeners = {}, sent = [];
  class Win {
    constructor() {
      this.webContents = withFallback({
        send: (ch, p) => sent.push([ch, p]), once() {}, on() {}, isLoading: () => false,
        setWindowOpenHandler() {}, executeJavaScript: () => Promise.reject(new Error('no renderer')),
      });
    }
    isDestroyed() { return false; }
    isVisible() { return true; }
    isMinimized() { return false; }
    getSize() { return [316, 72]; }
    getPosition() { return [0, 0]; }
    getBounds() { return { x: 0, y: 0, width: 316, height: 72 }; }
  }
  for (const m of ['setAlwaysOnTop', 'setVisibleOnAllWorkspaces', 'loadFile', 'on', 'once', 'show', 'showInactive',
    'hide', 'focus', 'setPosition', 'setBounds', 'setIgnoreMouseEvents', 'setSkipTaskbar', 'restore', 'close',
    'destroy', 'setMenuBarVisibility', 'removeMenu', 'moveTop', 'setBackgroundColor', 'setTitle', 'setIcon']) {
    Win.prototype[m] = function () {};
  }
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  const electron = withFallback({
    app: withFallback({
      getPath: () => userData, whenReady: () => ready, requestSingleInstanceLock: () => true, on() {},
      getVersion: () => require(path.join(ROOT, 'package.json')).version, isPackaged: false, quit() {},
      setLoginItemSettings() {}, getLoginItemSettings: () => ({}), setAppUserModelId() {}, getName: () => 'natsu',
    }),
    BrowserWindow: Win,
    ipcMain: { handle: (ch, f) => { handlers[ch] = f; }, on: (ch, f) => { listeners[ch] = f; }, removeHandler() {} },
    globalShortcut: { register: () => true, unregister() {}, unregisterAll() {}, isRegistered: () => false },
    nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on() {} },
  });
  // エンジンの spawn だけを本物にする（.js なら node で起動）。それ以外（貼り付け用の PowerShell など）は起動しない
  const realSpawn = cp.spawn;
  const childProcess = {
    ...cp,
    spawn(cmd, args, opts) {
      if (cmd === exe) {
        const k = /\.js$/i.test(cmd) ? realSpawn(process.execPath, [cmd, ...args], opts) : realSpawn(cmd, args, opts);
        kids.push(k);
        return k;
      }
      const EventEmitter = require('events');
      const p = new EventEmitter();
      p.stdin = null; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
      return p;
    },
    execFile(_cmd, _args, _opts, cb) { const done = typeof _opts === 'function' ? _opts : cb; if (done) setImmediate(() => done(new Error('not in test'))); return anyProxy(); },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electron;
    if (req === 'child_process') return childProcess;
    return orig.call(this, req, ...rest);
  };

  require(path.join(ROOT, 'src', 'main.js'));
  const store = require(path.join(ROOT, 'src', 'store.js'));
  readyResolve();
  for (let i = 0; i < 100 && !handlers['meeting:toggle']; i++) await sleep(20);

  const out = { mode };
  if (runTest) out.test = await handlers['app:test']();

  const wavs = process.env.NATSU_E2E_WAVS
    ? process.env.NATSU_E2E_WAVS.split(';').map((f) => ({ buf: fs.readFileSync(f), ms: Math.round((fs.statSync(f).size - 44) / 32) }))
    : Array.from({ length: segCount }, (_, i) => ({ buf: toneWav(i ? 2 : 3, silent ? 0 : 8000), ms: i ? 2000 : 3000 }));
  out.start = await handlers['meeting:toggle']();
  for (let i = 0; i < wavs.length; i++) {
    const last = i === wavs.length - 1;
    if (last) out.stop = await handlers['meeting:toggle']();
    listeners['audio:segment']({}, { buffer: new Uint8Array(wavs[i].buf), durationMs: wavs[i].ms, final: last });
    await sleep(50);
    if (i === 0 && testDuring) out.testDuring = await handlers['app:test']();
  }
  const deadline = Date.now() + Number(process.env.NATSU_E2E_WAIT_MS || 60000);
  while (Date.now() < deadline && !store.listPages().length) await sleep(50);
  // 要約まで済む（summaryError が書かれる）のを待つ
  while (Date.now() < deadline) {
    const p = store.listPages()[0];
    if (p && store.getPage(p.id).summaryError !== undefined) break;
    await sleep(50);
  }
  await sleep(200);
  const pages = store.listPages().map((p) => {
    const page = store.getPage(p.id);
    return { summaryError: page.summaryError, segments: store.getTranscript(p.id).map((s) => ({ text: s.text, failed: Boolean(s.failed) })) };
  });
  out.pages = pages;
  out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
  const elog = path.join(userData, 'engine.log');
  out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
  out.requests = fs.readFileSync(flog, 'utf8').split('\n').filter((l) => l.startsWith('inference'));
  out.spawnArgs = (fs.readFileSync(flog, 'utf8').split('\n').find((l) => l.startsWith('spawn ')) || '').slice(6);
  out.promptInfo = await handlers['prompt:info']();
  process.stdout.write(`\n${JSON.stringify(out)}\n`);
  process.exit(0);
})().catch((e) => { process.stderr.write(`mainrun: ${e.stack || e}\n`); process.exit(1); });
