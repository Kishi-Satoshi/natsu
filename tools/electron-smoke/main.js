/*
 * electron-smoke/main.js — 本物の Electron で、第2a1回の DB が頼る仕組みと、第0c回で直したところを動かす小さなアプリ（第0c回 EL8）
 *
 * 走らせ方（Electron の main として。窓は見せない）:
 *   node_modules/electron/dist/electron.exe tools/electron-smoke
 * 次の 7 つを確かめる（CHECKS）。
 *   1〜4. utilityProcess と MessageChannelMain の口で、sandbox の隠れた窓（preload）と往復する。子を落として起こし直す。
 *         子の中で node:sqlite を開く。kill() の終わりの番号を見る
 *   5・6. mainlib の copyPrivate・deliverText を本物の clipboard で動かす（44 では Promise を返す。C1）
 *   7.    画面の取り込みを断る（loopback.chooseDisplayMedia の null）と、main は投げない（C7）
 * 結果は 1 行ずつ OK／NG で出す。7 件そろって全部 OK なら終了コード 0、そうでなければ 1（exitCodeOf）。
 * どこかで止まっても、90 秒の見張りで 1 で終わる。
 *
 * Electron を読むのは、Electron の main として動いたときだけ（下の boot。tools/net-smoke.js と同じ形）。
 * テスト（test/electron-smoke.test.js）がこのファイルを require するので、頭で読むと 44 の包みが本体を落としにいく（C6）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../../src/mainlib');
const { chooseDisplayMedia } = require('../../src/loopback');
const { versionIssue } = require('../electron-version');

const CHECKS = [
  [1, 'utilityProcess と MessageChannelMain の口で、sandbox の隠れた窓（preload）と往復する'],
  [2, '子が落ちたら（終了コード 3）起こし直して、もう一度往復する'],
  [3, '子（utilityProcess）の中で node:sqlite が開ける'],
  [4, 'utilityProcess の kill() の終わりの番号は 0（第2a1回の「落ちたのか止めたのかは印で区別する」の前提）'],
  [5, 'clipboard を mainlib.copyPrivate で書いて読み返せる（44 では Promise）'],
  [6, 'mainlib.deliverText の貼り付けの後、元の「abc」に戻る（[object Promise] にならない）'],
  [7, '画面の取り込みを断る（loopback.chooseDisplayMedia の null）と、main は投げず、画面の getDisplayMedia は失敗で返る'],
];

const PKG = path.join(__dirname, '..', '..', 'package.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const msgOf = (e) => (e && e.message) || String(e);

/** promise を ms で打ち切る（止まったまま見張りの 90 秒を待たない） */
function within(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} が ${ms}ms で返らない`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

/** 7 件そろって全部 OK のときだけ 0 */
function exitCodeOf(results) {
  return Array.isArray(results) && results.length === CHECKS.length
    && CHECKS.every(([n]) => results.some((r) => r && r.n === n && r.ok === true)) ? 0 : 1;
}

/**
 * 5 と 6。clipboard（本物か偽物）を mainlib の copyPrivate・deliverText に渡す。常駐 PowerShell は居ない（paster は null）
 * ので、copyPrivate は clipboard で書く（'electron'）。時計は縮める。
 * @returns {Promise<Array<{ n: number, ok: boolean, note: string }>>}
 */
async function clipboardChecks(clip) {
  const d = {
    clip,
    paster: () => null,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    autoPaste: true,
    fg: Promise.resolve(''),
    simulatePaste: async () => 'ok',
    notice: () => {},
    later: (fn) => setTimeout(fn, 10),
  };
  const out = [];
  try {
    const t = 'NaTsu の試し';
    const by = await lib.copyPrivate(t, d);
    const back = await lib.readClip(clip);
    out.push({ n: 5, ok: by === 'electron' && back === t, note: `copyPrivate は ${by}、読み返しは ${JSON.stringify(back)}` });
  } catch (e) { out.push({ n: 5, ok: false, note: `投げた: ${msgOf(e)}` }); }
  try {
    await lib.copyPrivate('abc', d);
    const r = await lib.deliverText('口述の試し', d);
    await wait(100);
    const back = await lib.readClip(clip);
    out.push({ n: 6, ok: back === 'abc', note: `deliverText は ${r}、100ms 後のクリップボードは ${JSON.stringify(back)}` });
  } catch (e) { out.push({ n: 6, ok: false, note: `投げた: ${msgOf(e)}` }); }
  return out;
}

/** 結果を n の順に 1 行ずつ出し、出力を流し切ってから、exitCodeOf の値で Electron を終える */
function finish(app, results, { log = (l) => console.log(l), flush = (cb) => process.stdout.write('', cb) } = {}) {
  const list = Array.isArray(results) ? results : [];
  for (const [n, title] of CHECKS) {
    const r = list.find((x) => x && x.n === n);
    log(r ? `${r.ok ? 'OK' : 'NG'} ${n} ${title} — ${r.note}` : `NG ${n} ${title} — 結果が無い`);
  }
  const code = exitCodeOf(list);
  const bad = CHECKS.filter(([n]) => !list.some((r) => r && r.n === n && r.ok === true)).length;
  log(code === 0 ? `結果: ${CHECKS.length} 件とも OK` : `結果: NG ${bad} 件`);
  flush(() => { if (code === 0) app.exit(0); else app.exit(1); });
}

// ---------------------------------------------------------------- Electron の main として動いたとき

/** 1〜4: 子（utilityProcess）と sandbox の隠れた窓を口でつなぐ */
async function processChecks(win, { utilityProcess, MessageChannelMain }) {
  const out = [];
  const note = {};
  const start = () => {
    const child = utilityProcess.fork(path.join(__dirname, 'child.js'), [], { serviceName: 'NaTsu Smoke' });
    const exited = new Promise((r) => child.once('exit', r));
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage('hello', [port1]);
    win.webContents.postMessage('port', null, [port2]);
    return { child, exited };
  };
  const ask = (x) => within(win.webContents.executeJavaScript(`window.smoke.call(${JSON.stringify(x)})`), 10000, `往復（${x}）`);
  let cur = null;
  try {
    // 1・3
    cur = start();
    const a = await ask('a');
    out.push({ n: 1, ok: Boolean(a && a.echo === 'a'), note: `返事は ${JSON.stringify(a)}` });
    const v = String((a && a.sqlite) || '');
    out.push({ n: 3, ok: /^3\.\d+\.\d+$/.test(v), note: `子の SQLite は ${v}` });
    // 2: 子を落として（終了コード 3）、起こし直して往復する
    const { child } = cur;
    child.postMessage('crash', [new MessageChannelMain().port1]);
    const code = await within(cur.exited, 10000, '子の終わり');
    note.crash = `落ちたときの番号は ${code}`;
    cur = start();
    const b = await ask('b');
    out.push({ n: 2, ok: code === 3 && Boolean(b && b.echo === 'b'), note: `${note.crash}、起こし直した後の返事は ${JSON.stringify(b)}` });
    // 4: kill() の終わりの番号
    const last = cur;
    cur = null;
    last.child.kill();
    const killed = await within(last.exited, 10000, 'kill() の後の終わり');
    out.push({ n: 4, ok: killed === 0, note: `kill() の終わりの番号は ${killed}` });
  } catch (e) {
    for (const n of [1, 3, 2, 4]) if (!out.some((r) => r.n === n)) out.push({ n, ok: false, note: `止まった: ${msgOf(e)}` });
    if (cur) { try { cur.child.kill(); } catch (_) { /* もう居ない */ } }
  }
  return out;
}

/** 7: 断るときの null を本物の受け口に渡す */
async function displayMediaCheck(win, session) {
  let given;
  let threw = '受け口が呼ばれていない';
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    const s = chooseDisplayMedia({ platform: process.platform, frame: req.frame, enabled: false, url: '' });
    try { cb(s); threw = ''; } catch (e) { threw = e.message; }
    given = s;
  });
  try {
    const res = await within(win.webContents.executeJavaScript(
      "navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(() => 'resolved', (e) => 'rejected ' + e.name)", true), 10000, 'getDisplayMedia');
    const ok = given === null && threw === '' && /^rejected/.test(String(res));
    return { n: 7, ok, note: `渡したのは ${JSON.stringify(given)}、main の例外は ${threw ? JSON.stringify(threw) : '無し'}、画面は ${res}` };
  } catch (e) {
    return { n: 7, ok: false, note: `止まった: ${msgOf(e)}（渡したのは ${JSON.stringify(given)}、main の例外は ${JSON.stringify(threw)}）` };
  }
}

function boot() {
  const { app, BrowserWindow, utilityProcess, MessageChannelMain, clipboard, session } = require('electron');
  // 見張り: どこかで止まっても、ジョブの 30 分を待たずに赤にする
  setTimeout(() => { console.log('NG 時間切れ'); app.exit(1); }, 90000);
  // 拾われない例外で Electron の窓（エラーの箱）を出すと、そこで止まる。行に出して終わる
  const die = (what) => (e) => { console.log(`NG ${what}: ${(e && e.stack) || e}`); app.exit(1); };
  process.on('uncaughtException', die('拾われない例外'));
  process.on('unhandledRejection', die('拾われない失敗'));
  // 記録は一時フォルダに（日本語と 𠮷 の名前。利用者のプロファイルを汚さない）
  try {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-smoke-土台𠮷-'));
    app.setPath('userData', data);
    app.setPath('sessionData', data);
  } catch (e) { console.log(`参考: userData を一時フォルダにできなかった（${e.message}）`); }
  app.disableHardwareAcceleration();
  // 窓を閉じても終わらない（終わるのは finish か見張り）
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    console.log(`Electron ${process.versions.electron}（Chromium ${process.versions.chrome}、Node ${process.versions.node}、${process.platform}）`);
    const issue = versionIssue(process.versions, JSON.parse(fs.readFileSync(PKG, 'utf8')));
    if (issue) { console.log(`NG 版: ${issue}`); process.stdout.write('', () => app.exit(1)); return; }
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await win.loadFile(path.join(__dirname, 'page.html'));
    const results = [];
    results.push(...await processChecks(win, { utilityProcess, MessageChannelMain }));
    results.push(...await clipboardChecks(clipboard));
    results.push(await displayMediaCheck(win, session));
    win.destroy();
    finish(app, results);
  }, die('起動の失敗'));
}

if (process.versions.electron && process.type === 'browser') boot();
else if (require.main === module) {
  console.error('electron-smoke は Electron の main として動かす: <electron の実行ファイル> tools/electron-smoke');
  process.exitCode = 2;
}

module.exports = { CHECKS, exitCodeOf, clipboardChecks, finish };
