'use strict';
// main.js を偽の Electron の上で実際に動かし、記録 → 区間 → 文字起こし → 議事録の保存までを通す。
// 1 回の実行で 1 つの場面だけを試す（main.js はモジュールの中に状態を持つので、場面ごとに
// 別のプロセスにする）。結果は最後の行に JSON で出す。使い方:
//   node test/helpers/mainrun.js <FAKE_MODE> [--test]
//     FAKE_MODE … fake-whisper.js の答え方（text / empty / prompt-empty / err200）
//     --test    … 記録の前に設定の［起動テスト］（app:test）を呼ぶ
// 本物のエンジンで試すときは NATSU_E2E_EXE・NATSU_E2E_MODEL・NATSU_E2E_WAVS（; 区切り）を渡す。

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const FAKE = path.join(__dirname, 'fake-whisper.js');
const mode = process.argv[2] || 'text';
const runTest = process.argv.includes('--test');

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 220Hz の正弦波の WAV（16kHz・モノラル・16bit）。偽のエンジンは中身を見ない。大きさだけが要る（4000 バイト以上）
function toneWav(sec) {
  const n = 16000 * sec;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 220 * i / 16000)), 44 + i * 2);
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

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-e2e-'));
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
      if (cmd === exe) return /\.js$/i.test(cmd) ? realSpawn(process.execPath, [cmd, ...args], opts) : realSpawn(cmd, args, opts);
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
    : [{ buf: toneWav(3), ms: 3000 }, { buf: toneWav(2), ms: 2000 }];
  out.start = await handlers['meeting:toggle']();
  for (let i = 0; i < wavs.length; i++) {
    const last = i === wavs.length - 1;
    if (last) out.stop = await handlers['meeting:toggle']();
    listeners['audio:segment']({}, { buffer: new Uint8Array(wavs[i].buf), durationMs: wavs[i].ms, final: last });
    await sleep(50);
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
  process.stdout.write(`\n${JSON.stringify(out)}\n`);
  process.exit(0);
})().catch((e) => { process.stderr.write(`mainrun: ${e.stack || e}\n`); process.exit(1); });
