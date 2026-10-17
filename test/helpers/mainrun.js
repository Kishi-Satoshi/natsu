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
//     --kotoba      … 偽のモデルの名前を kotoba-whisper のものにする（認識ヒントを渡さない場面）
//     --port=N      … 文字起こしエンジンのポート（並べて走らせるとき、呼ぶ側が重ならないように決めて渡す）
//     --discard-during … 最初の区間を送った直後に議事録を破棄する（返事を待つ間の破棄）
//     --after-dict  … 記録の後で辞書を保存し、認識ヒントの状態を聞き直す
//     --sum         … 要約エンジン（helpers/fake-llama.js）も置く。要約は文字起こしに無い担当・期限を混ぜて返す
//     --sum-port=N  … 要約エンジンのポート（--port と同じく、呼ぶ側が重ならないように渡す）
//     --set-type-during=T … 要約の途中で会議タイプを T に手で選び直す（要約は 1.5 秒かかる）
//     --text=…      … 偽の文字起こしエンジンが返す文（既定は「本日の議題は進捗の確認です。区間N」）
//     --managed     … 詳細設定を空にし、取り込んだ組で文字起こしする（第0b回 設計 B）。engine-small の小さな組を本物の
//                     installZip・recordInstalled で %LOCALAPPDATA%（一時フォルダ）の natsu\engine に置き、main からは
//                     engineRoot（取り込める PC か）と MANIFEST だけを差し替える。取り込んだ exe の代わりに偽の whisper を起動する
//     --managed-tamper … --managed と同じ組の whisper.dll を、大きさを変えずに書き換える（照らしで合わず、起動しない。RF3）
//     --recover     … 前回落ちた会議の下書き（文字起こし待ちの区間 1 つと、その音声）を置いて起動し、復旧の文字起こしを待って終える
//                     （記録はしない。--managed と組み合わせると、照らし終えた後に復旧が動くかを見る）
//     --no-vc-runtime … --managed と組み合わせる。Visual C++ ランタイムが無い PC にする（RF4）。whenReady の後で System32 を
//                     空のフォルダに向け、Windows の外では process.platform を win32 と読ませる（main.js の engineRuntimeIssue は
//                     Windows でだけ DLL を読む）。記録はせず、engine:status・起動テスト・記録の開始の答えを見る。
//                     その後で System32 に 14.51 の DLL を置き（担当がランタイムを入れた）、起動し直さずに起動テストをもう一度押す
//     --verify-throws … --managed と組み合わせる。照らし（verifyCandidates）が例外を投げる。記録はしない
//     --sum-tamper  … --managed と組み合わせる。要約の組も置き、その llama.dll を大きさを変えずに書き換える（要約の組は壊れている）
//     --no-engine=fetchable|unsupported … 詳細設定の文字起こしを空にし、何も取り込んでいない PC にする。fetchable は取り込める PC、
//                     unsupported は取り込めない PC（engineRoot だけを差し替える）。記録はしない
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
const kotoba = flags.includes('--kotoba');
const fixedPort = Number((flags.find((f) => f.startsWith('--port=')) || '--port=0').slice(7)) || 0;
const discardDuring = flags.includes('--discard-during');
const afterDict = flags.includes('--after-dict');
const withSum = flags.includes('--sum');
const fixedSumPort = Number((flags.find((f) => f.startsWith('--sum-port=')) || '--sum-port=0').slice(11)) || 0;
const setTypeDuring = (flags.find((f) => f.startsWith('--set-type-during=')) || '').slice(18);
const fakeText = (flags.find((f) => f.startsWith('--text=')) || '').slice(7);
const FAKE_SUM = path.join(__dirname, 'fake-llama.js');
const segCount = Number((flags.find((f) => f.startsWith('--segs=')) || '--segs=2').slice(7)) || 2;
const managedMode = flags.includes('--managed') ? 'ok' : (flags.includes('--managed-tamper') ? 'tamper' : '');
const recoverMode = flags.includes('--recover');
const noVcRuntime = flags.includes('--no-vc-runtime');
const verifyThrows = flags.includes('--verify-throws');
const sumTamper = flags.includes('--sum-tamper');
const noEngine = (flags.find((f) => f.startsWith('--no-engine=')) || '').slice(12);
const REAL_PLATFORM = process.platform;

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 版（VS_FIXEDFILEINFO）だけを持つ DLL の偽物（main.js の vcRuntimeVersions が読む印 0xFEEF04BD と、その後の版）
function peWithVersion(a, b, c, d) {
  const x = Buffer.alloc(4096);
  x.writeUInt32LE(0xFEEF04BD, 1000); x.writeUInt32LE(0x00010000, 1004);
  x.writeUInt32LE(((a << 16) | b) >>> 0, 1008); x.writeUInt32LE(((c << 16) | d) >>> 0, 1012);
  return x;
}

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
    model = path.join(engDir, kotoba ? 'ggml-kotoba-whisper-v2.0-q5_0.bin' : 'ggml-fake.bin');
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
  const localPort = fixedPort || await freePort();
  const sumPort = fixedSumPort || await freePort();
  if (fakeText) process.env.FAKE_TEXT = fakeText;
  // 偽の要約モデル。大きさの床（300MB）だけを超えればよい（残りは疎）
  let sumModel = '';
  if (withSum) {
    sumModel = path.join(engDir, 'fake-sum.gguf');
    const fd = fs.openSync(sumModel, 'w');
    fs.writeSync(fd, Buffer.alloc(8192, 1));
    fs.ftruncateSync(fd, 301 * 1024 * 1024);
    fs.closeSync(fd);
    if (setTypeDuring) process.env.FAKE_SUM_DELAY = '1500';
  }
  // 取り込んだ組（--managed）。置き場所は main と同じ LOCALAPPDATA の下（日本語と 𠮷 の名前。RF1）
  const localAppData = path.join(tmp, 'LocalAppData-取込𠮷');
  let managedExe = '';
  let managedRoot = '';
  let managedMods = null;
  if (managedMode) {
    const I = require(path.join(ROOT, 'src', 'engine-install.js'));
    const realManifest = require(path.join(ROOT, 'src', 'engine-manifest.js'));
    const { smallSet } = require('./engine-small');
    const set = await smallSet();
    await set.close();   // 通信はしない（中身だけ使う）
    // 文字起こしのモデルは大きさの床（50MB）を超える疎のファイル（モデルは大きさと更新時刻で照らすので中身は見ない）。
    // VAD は本物の名前にして、モデルの隣の自動の発見（resolveVadModel）が取り込んだ models の中で効くかを見る
    const items = set.manifest.items.map((it) => {
      if (it.id === 'whisper-model') return { ...it, size: 51 * 1024 * 1024 };
      if (it.id === 'whisper-vad') return { ...it, dest: 'models/ggml-silero-v6.2.0.bin' };
      return it;
    });
    managedRoot = path.join(localAppData, 'natsu', 'engine');
    const home = { supported: true, root: managedRoot, reason: '' };
    // 要約の組は取り込んでいない（--sum-tamper のときだけ置く）
    for (const it of items.filter((i) => i.group === 'whisper' || (sumTamper && i.group === 'sum'))) {
      if (it.kind === 'zip') {
        const zip = path.join(tmp, `${it.id}.zip`);
        fs.writeFileSync(zip, set.bodies[it.id]);
        I.recordInstalled(home, it, await I.installZip(it, zip, managedRoot));
        continue;
      }
      const out = path.join(managedRoot, ...it.dest.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      if (it.id === 'whisper-model') {
        const fd = fs.openSync(out, 'w');
        fs.writeSync(fd, Buffer.alloc(8192, 1));
        fs.ftruncateSync(fd, it.size);
        fs.closeSync(fd);
      } else {
        fs.writeFileSync(out, set.bodies[it.id]);
      }
      I.recordInstalled(home, it, { file: out });
    }
    managedExe = path.join(managedRoot, 'whisper-1.0.0', 'whisper-server.exe');
    const tamper = (dir, name) => {
      const dll = path.join(managedRoot, dir, name);
      fs.writeFileSync(dll, Buffer.alloc(fs.statSync(dll).size, 7));   // 大きさは同じ・中身だけ違う
      // 記録の更新時刻も今のファイルに合わせる（大きさと更新時刻では見分けられない。SHA-256 の照らしだけが見つける）
      const instFile = path.join(managedRoot, 'installed.json');
      const inst = I.readInstalled(instFile);
      for (const rec of Object.values(inst.items)) {
        for (const f of rec.files || []) if (f.name === name) f.mtimeMs = fs.statSync(dll).mtimeMs;
      }
      I.writeInstalled(instFile, inst);
    };
    if (managedMode === 'tamper') tamper('whisper-1.0.0', 'whisper.dll');
    if (sumTamper) tamper('llama-b1', 'llama.dll');
    managedMods = {
      install: { ...I, engineRoot: () => home,
        ...(verifyThrows ? { verifyCandidates: async () => { throw new Error('照らしの試験の失敗𠮷'); } } : {}) },
      manifest: { ...realManifest, MANIFEST: Object.freeze({ schema: 1, items }) },
    };
  }
  // 何も取り込んでいない PC（取り込める・取り込めない）。置き場所だけを決め、フォルダは作らない
  if (noEngine) {
    const I = require(path.join(ROOT, 'src', 'engine-install.js'));
    const home = noEngine === 'fetchable' ? { supported: true, root: path.join(localAppData, 'natsu', 'engine'), reason: '' }
      : I.engineRoot({}, 'linux', 'x64');
    managedMods = { install: { ...I, engineRoot: () => home }, manifest: require(path.join(ROOT, 'src', 'engine-manifest.js')) };
  }
  // 前回落ちた会議の下書き（main は起動のときに復旧ページを作り、残った音声を文字起こしし直す）
  if (recoverMode) {
    const startedAt = Date.now() - 600000;
    const wav = path.join(userData, 'data', 'segbuf', String(startedAt), '0001.wav');
    fs.mkdirSync(path.dirname(wav), { recursive: true });
    fs.writeFileSync(wav, toneWav(3));
    fs.writeFileSync(path.join(userData, 'data', 'draft.json'), JSON.stringify({ startedAt, memo: '', offsetMs: 3000, savedAt: startedAt + 3000,
      segments: [{ id: 's1', atMs: 0, durationMs: 3000, pending: true, wav, text: '' }] }));
  }
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    ...(managedMode || noEngine ? {} : { localServerExe: exe, localModelPath: model }), localPort, sumPort, autoLaunch: false,
    ...(withSum ? { sumServerExe: FAKE_SUM, sumModelPath: sumModel } : {}),
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
  const spawns = [];   // エンジンの起動（実行ファイル・引数・作業フォルダ）
  const childProcess = {
    ...cp,
    spawn(cmd, args, opts) {
      if (cmd === exe || (withSum && cmd === FAKE_SUM) || (managedExe && cmd === managedExe)) {
        spawns.push({ cmd, args, cwd: (opts && opts.cwd) || '' });
        // 取り込んだ exe（中身は試験のバイト列）の代わりに、偽の whisper を node で起動する
        const js = managedExe && cmd === managedExe ? FAKE : cmd;
        const k = /\.js$/i.test(js) ? realSpawn(process.execPath, [js, ...args], opts) : realSpawn(js, args, opts);
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
  const MAIN = path.join(ROOT, 'src', 'main.js');
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electron;
    if (req === 'child_process') return childProcess;
    if (managedMods && rest[0] && rest[0].filename === MAIN) {
      if (req === './engine-install') return managedMods.install;
      if (req === './engine-manifest') return managedMods.manifest;
    }
    return orig.call(this, req, ...rest);
  };

  // 取り込んだエンジンの置き場所（%LOCALAPPDATA%\natsu\engine）は main.js を読んだときに決まるので、その前に一時フォルダへ向ける。
  // Windows の CI で本当のプロファイルの natsu\engine を見ない（フォルダは作らない。main も作らない）。
  // この場面の settings.json は手のパスを持つので、文字起こしは手の設定の道を通る
  process.env.LOCALAPPDATA = localAppData;
  require(path.join(ROOT, 'src', 'main.js'));
  const store = require(path.join(ROOT, 'src', 'store.js'));
  readyResolve();
  const out = { mode };
  if (managedMode) {
    // 照らしは本物のファイルの読み（イベントループを回す）。マイクロタスクだけを待つ今は、まだ照らし終えていない
    for (let i = 0; i < 100 && !handlers['engine:status']; i++) await null;
    out.statusChecking = handlers['engine:status']();
    out.spawnsBeforeVerify = spawns.length;
    out.managedRoot = managedRoot;
    if (noVcRuntime) {
      // whenReady（トレイ・貼り付け・窓）は今の OS のまま済んだ。照らし終える前に、ランタイムの無い Windows にする
      const winDir = path.join(tmp, 'Windows-空𠮷');
      fs.mkdirSync(winDir);   // System32 は作らない（DLL は exe のフォルダにも System32 にも無い）
      process.env.SystemRoot = winDir;
      process.env.windir = winDir;
      if (process.platform !== 'win32') Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    }
    // 照らし終えるのを待つ（最大 3 秒）
    const until = Date.now() + 3000;
    while (Date.now() < until && /確かめています/.test(handlers['engine:status']().whisper)) await sleep(20);
  }
  for (let i = 0; i < 100 && !handlers['meeting:toggle']; i++) await sleep(20);
  if (recoverMode) {
    // 復旧の文字起こしが済むのを待つ（最大 4 秒）
    const recovered = () => { const p = store.listPages()[0]; return p ? store.getTranscript(p.id) : []; };
    const until = Date.now() + 4000;
    while (Date.now() < until && !recovered().some((x) => !x.failed)) await sleep(50);
    out.recovered = recovered().map((x) => ({ text: x.text, failed: Boolean(x.failed) }));
    out.spawns = spawns;
    const elog = path.join(userData, 'engine.log');
    out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  if (managedMode === 'tamper' || noVcRuntime || verifyThrows || noEngine) {
    // 使えない組は使わない。記録も始めない（区間を送らずに終える）
    await sleep(300);
    out.engineStatus = handlers['engine:status']();
    out.engineFetchStatus = await handlers['engine:fetch-status']();
    out.start = await handlers['meeting:toggle']();
    out.test = await handlers['app:test']();
    out.spawns = spawns.slice();
    if (noVcRuntime) {
      // 情報システムの担当がランタイムを入れた（System32 に 14.51 の DLL を置く）。NaTsu を起動し直さずに［起動テスト］を押す
      const s32 = path.join(process.env.SystemRoot, 'System32');
      fs.mkdirSync(s32);
      for (const d of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll']) fs.writeFileSync(path.join(s32, d), peWithVersion(14, 51, 36247, 0));
      out.engineStatusBeforeRetest = handlers['engine:status']();
      out.testAfterInstall = await handlers['app:test']();
      out.engineStatusAfterInstall = handlers['engine:status']();
      out.spawnsAfterInstall = spawns.slice();
    }
    // 終わりの片付け（一時フォルダを消す）は今の OS のままで行う
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true });
    const elog = path.join(userData, 'engine.log');
    out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    process.exit(0);
  }
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
    if (i === 0 && discardDuring) { await sleep(300); out.discard = await handlers['meeting:discard'](); break; }
  }
  if (discardDuring) await sleep(3000);   // 破棄の後にやり直しが送られないことを、返事が来るまで待って確かめる
  const deadline = Date.now() + (discardDuring ? 0 : Number(process.env.NATSU_E2E_WAIT_MS || 60000));
  while (Date.now() < deadline && !store.listPages().length) await sleep(50);
  // 要約の途中で会議タイプを手で選び直す（画面の［要約タイプ］と同じ IPC）
  if (setTypeDuring && store.listPages().length) {
    await sleep(300);
    out.setType = await handlers['page:setType']({}, { id: store.listPages()[0].id, type: setTypeDuring });
  }
  // 要約まで済むのを待つ: 要約のブロックができるか、要約欄に理由が書かれるまで
  // （新しいページは summaryError を空で持っているので、空かどうかでは決められない）
  while (Date.now() < deadline) {
    const p = store.listPages()[0];
    const page = p && store.getPage(p.id);
    if (page && ((page.blocks && page.blocks.length) || page.summaryError)) break;
    await sleep(50);
  }
  await sleep(200);
  const pages = store.listPages().map((p) => {
    const page = store.getPage(p.id);
    return {
      summaryError: page.summaryError,
      segments: store.getTranscript(p.id).map((s) => ({ text: s.text, failed: Boolean(s.failed) })),
      meetingType: page.meetingType, typeAuto: page.typeAuto, actionStat: page.actionStat,
      todos: (page.blocks || []).filter((b) => b.type === 'todo').map((b) => ({ text: b.text, assignee: b.assignee || '', due: b.due || '', dueRaw: b.dueRaw || '' })),
    };
  });
  out.pages = pages;
  out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
  const elog = path.join(userData, 'engine.log');
  out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
  out.requests = fs.readFileSync(flog, 'utf8').split('\n').filter((l) => l.startsWith('inference'));
  out.spawnArgs = (fs.readFileSync(flog, 'utf8').split('\n').find((l) => l.startsWith('spawn ')) || '').slice(6);
  out.promptInfo = await handlers['prompt:info']();
  out.engineStatus = await handlers['engine:status']();
  out.engineFetchStatus = handlers['engine:fetch-status'] ? await handlers['engine:fetch-status']() : null;   // 第0b回 Task 13
  out.spawns = spawns;
  out.savedSettings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  if (afterDict) {
    out.saved = await handlers['settings:save']({}, { dictionary: ['検収'] });
    out.promptInfoAfterDict = await handlers['prompt:info']();
  }
  process.stdout.write(`\n${JSON.stringify(out)}\n`);
  process.exit(0);
})().catch((e) => { process.stderr.write(`mainrun: ${e.stack || e}\n`); process.exit(1); });
