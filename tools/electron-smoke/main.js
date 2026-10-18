/*
 * electron-smoke/main.js — 本物の Electron で、第2a1回の DB が頼る仕組みと、第0c回で直したところを動かす小さなアプリ（第0c回 EL8）
 *
 * 走らせ方（Electron の main として。窓は見せない）:
 *   node_modules/electron/dist/electron.exe tools/electron-smoke
 * 次の 12 を確かめる（CHECKS）。
 *   1〜4. utilityProcess と MessageChannelMain の口で、sandbox の隠れた窓（preload）と往復する。子を落として起こし直す。
 *         子の中で node:sqlite を開く。kill() の終わりの番号を見る
 *   5・6. mainlib の copyPrivate・deliverText を本物の clipboard で動かす（44 では Promise を返す。C1）
 *   7.    画面の取り込みを断る（loopback.chooseDisplayMedia の null）と、main は投げない（C7）
 *   8〜12. 第1a回 SEC1: 別の session（natsu-sec-smoke）に本物の security.install を付け、守りの確かめ用のページ
 *         （sec-app.html を本体、sec-overlay.html を録音バーの代わりに）で、sandbox・ヘッダーの CSP・マイクと画面の取り込みの
 *         許可・移動と新しい窓の禁止を見る（securityChecks。判定は純粋な securityResults）。偽のマイク
 *         （--use-fake-device-for-media-stream）を使う。1〜7 の受け口（defaultSession）は変えない
 * 結果は 1 行ずつ OK／NG で出す。12 件そろって全部 OK なら終了コード 0、そうでなければ 1（exitCodeOf）。
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
const security = require('../../src/security');
const { versionIssue, versionGate } = require('../electron-version');

const CHECKS = [
  [1, 'utilityProcess と MessageChannelMain の口で、sandbox の隠れた窓（preload）と往復する'],
  [2, '子が落ちたら（終了コード 3）起こし直して、もう一度往復する'],
  [3, '子（utilityProcess）の中で node:sqlite が開ける'],
  [4, 'utilityProcess の kill() の終わりの番号は 0（第2a1回の「落ちたのか止めたのかは印で区別する」の前提）'],
  [5, 'clipboard を mainlib.copyPrivate で書いて読み返せる（44 では Promise）'],
  [6, 'mainlib.deliverText の貼り付けの後、元の「abc」に戻る（[object Promise] にならない）'],
  [7, '画面の取り込みを断る（loopback.chooseDisplayMedia の null）と、main は投げず、画面の getDisplayMedia は失敗で返る'],
  [8, 'sandbox: true の窓の preload で process.sandboxed が真'],
  [9, 'CSP（main がヘッダーで付ける）: ハッシュで許したインラインの script は動き、後から差し込んだ script は止まる'],
  [10, '許可: 本体の窓でマイク（音だけ）は許され、マイクの名前が出る。カメラと画面の取り込みは断る'],
  [11, '許可: 録音バーの窓の画面の取り込み（44 では media・mediaTypes が空）は、受け口まで届く'],
  [12, '移動と新しい窓: location の書き換え・リンク・window.open で、窓は元のページのまま、新しい窓は開かない'],
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

/** CHECKS の全部（12 件）がそろって全部 OK のときだけ 0 */
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

/**
 * 8〜12 の判定（純粋）。securityChecks が本物の Electron で集めた観測を渡す。
 * @param {{ sandboxed: boolean, inlineRan: boolean, injectedRan: boolean, violations: number, gumAudio: string, audioLabels: number,
 *   gumVideo: string, gdmApp: string, gdmOverlay: string, handlerCalls: number, urlAfter: string, opened: boolean }} o
 *   gum…・gdm… は成功なら 'ok'、失敗なら DOMException の名前（NotAllowedError・AbortError など）
 * @returns {Array<{ n: number, ok: boolean, note: string }>}
 */
function securityResults(o) {
  const x = o || {};
  const j = (v) => JSON.stringify(v);
  return [
    { n: 8, ok: x.sandboxed === true, note: `process.sandboxed は ${j(x.sandboxed)}` },
    { n: 9, ok: x.inlineRan === true && x.injectedRan !== true && x.violations >= 1,
      note: `インラインの script は ${x.inlineRan === true ? '動いた' : '動かない'}、差し込んだ script は ${x.injectedRan === true ? '動いた' : '止まった'}、CSP の違反は ${j(x.violations)} 件` },
    { n: 10, ok: x.gumAudio === 'ok' && x.audioLabels >= 1 && x.gumVideo === 'NotAllowedError' && x.gdmApp === 'NotAllowedError',
      note: `マイクは ${j(x.gumAudio)}（名前の出た音の機器 ${j(x.audioLabels)} 個）、カメラは ${j(x.gumVideo)}、本体の窓の画面の取り込みは ${j(x.gdmApp)}` },
    { n: 11, ok: x.gdmOverlay === 'AbortError' && x.handlerCalls === 1,
      note: `録音バーの窓の画面の取り込みは ${j(x.gdmOverlay)}、受け口が呼ばれたのは ${j(x.handlerCalls)} 回（本体の窓の分は来ないので 1）` },
    { n: 12, ok: x.urlAfter === 'sec-app.html' && x.opened === false,
      note: `移動を試した後のページは ${j(x.urlAfter)}、新しい窓は ${x.opened === false ? '開かない' : `開いた（${j(x.opened)}）`}` },
  ];
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
  // 口（webContents.postMessage）と executeJavaScript は別の道で届くので、着く順は決まっていない。
  // 窓が新しい口を受け取った（preload の gen が進んだ）のを見てから往復する
  const genOf = () => within(win.webContents.executeJavaScript('window.smoke.gen()'), 10000, '口の数');
  const start = async () => {
    const before = await genOf();
    const child = utilityProcess.fork(path.join(__dirname, 'child.js'), [], { serviceName: 'NaTsu Smoke' });
    const exited = new Promise((r) => child.once('exit', r));
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage('hello', [port1]);
    win.webContents.postMessage('port', null, [port2]);
    for (const end = Date.now() + 10000; (await genOf()) === before;) {
      if (Date.now() > end) { try { child.kill(); } catch (_) { /* もう居ない */ } throw new Error('新しい口が 10000ms で窓に届かない'); }
      await wait(20);
    }
    return { child, exited };
  };
  const ask = (x) => within(win.webContents.executeJavaScript(`window.smoke.call(${JSON.stringify(x)})`), 10000, `往復（${x}）`);
  let cur = null;
  try {
    // 1・3
    cur = await start();
    const a = await ask('a');
    out.push({ n: 1, ok: Boolean(a && a.echo === 'a'), note: `返事は ${JSON.stringify(a)}` });
    const v = String((a && a.sqlite) || '');
    out.push({ n: 3, ok: /^3\.\d+\.\d+$/.test(v), note: `子の SQLite は ${v}` });
    // 2: 子を落として（終了コード 3）、起こし直して往復する
    const { child } = cur;
    child.postMessage('crash', [new MessageChannelMain().port1]);
    const code = await within(cur.exited, 10000, '子の終わり');
    note.crash = `落ちたときの番号は ${code}`;
    cur = await start();
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
  // 8〜12 の偽のマイク（whenReady の前に付ける）
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
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
    if (versionGate(app, versionIssue(process.versions, JSON.parse(fs.readFileSync(PKG, 'utf8'))))) return;
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
    results.push(...await securityChecks({ app, BrowserWindow, session }));
    finish(app, results);
  }, die('起動の失敗'));
}

/**
 * 8〜12: 別の session（natsu-sec-smoke）に本物の security.install を付け、守りの確かめ用の2つのページで観測を集める。
 * boot() の中で 1〜7 が済んでから呼ぶ（install は app の web-contents-created に移動の禁止を付けるので、1〜7 の窓より後に）。
 * 置き場所は boot() の後（ファイルの中で、版を見る前の所に new BrowserWindow( を書かない）。
 * 判定は securityResults。どこかで止まっても、8〜12 を NG にして返す（見張りの 90 秒を待たない）。
 */
async function securityChecks({ app, BrowserWindow, session }) {
  const PAGES = { app: path.join(__dirname, 'sec-app.html'), overlay: path.join(__dirname, 'sec-overlay.html') };
  const o = { handlerCalls: 0, opened: false };
  const wins = [];
  const onCreated = () => { o.opened = true; };
  try {
    const ses = session.fromPartition('natsu-sec-smoke');
    security.install({ app, session: ses, pages: PAGES, log: (l) => console.log(`参考: ${l}`) });
    ses.setDisplayMediaRequestHandler((req, cb) => { o.handlerCalls += 1; cb(null); });
    const open = async (file) => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses },
      });
      wins.push(w);
      await within(w.loadFile(file), 10000, `${path.basename(file)} の読み込み`);
      return w;
    };
    const appWin = await open(PAGES.app);
    const ovWin = await open(PAGES.overlay);
    app.on('browser-window-created', onCreated);
    // 1つの観測が止まっても（移動が止まらずにページが替わったなど）ほかの観測は続け、止まった観測は文字で残す（判定では NG）
    const run = (w, js, what, gesture = false) => within(w.webContents.executeJavaScript(js, gesture), 10000, what)
      .catch((e) => `止まった（${what}）: ${msgOf(e)}`);
    const nameOf = (p) => `${p}.then((s) => { if (s && s.getTracks) s.getTracks().forEach((t) => t.stop()); return 'ok'; }, (e) => (e && e.name) || String(e))`;

    // 8
    o.sandboxed = await run(appWin, 'window.smoke.sandboxed()', 'process.sandboxed');
    // 9: インラインは読み込みで動いたはず。後から script を差し込み、違反の合図を待つ
    o.inlineRan = await run(appWin, 'window.inlineRan === true', 'インラインの script');
    await run(appWin, "(() => { const s = document.createElement('script'); s.textContent = 'window.injectedRan = true;'; document.head.appendChild(s); return 1; })()", '差し込み');
    await wait(300);
    o.injectedRan = await run(appWin, 'window.injectedRan === true', '差し込んだ script');
    o.violations = await run(appWin, 'window.violations', 'CSP の違反の数');
    // 10
    o.gumAudio = await run(appWin, nameOf('navigator.mediaDevices.getUserMedia({ audio: true })'), 'マイク');
    o.audioLabels = await run(appWin, "navigator.mediaDevices.enumerateDevices().then((l) => l.filter((d) => /^audio/.test(d.kind) && d.label).length)", '機器の名前');
    o.gumVideo = await run(appWin, nameOf('navigator.mediaDevices.getUserMedia({ video: true })'), 'カメラ');
    o.gdmApp = await run(appWin, nameOf('navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })'), '本体の窓の画面の取り込み', true);
    // 11
    o.gdmOverlay = await run(ovWin, nameOf('navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })'), '録音バーの窓の画面の取り込み', true);
    // 12: location の書き換え・リンク・window.open
    await run(appWin, "(() => { location.href = 'https://example.invalid/'; return 1; })()", 'location の書き換え');
    await wait(300);
    await run(appWin, "(() => { document.getElementById('out').click(); return 1; })()", 'リンク', true);
    await wait(300);
    const w = await run(appWin, "window.open('https://example.invalid/') === null", 'window.open', true);
    await wait(300);
    if (w !== true) o.opened = w === false ? true : String(w);   // null でない窓が返った → 開いた。止まった → 確かめられない（NG）
    let after = '';
    try { after = path.basename(decodeURIComponent(new URL(appWin.webContents.getURL()).pathname)); } catch (_) { after = ''; }
    o.urlAfter = after;
    return securityResults(o);
  } catch (e) {
    return [8, 9, 10, 11, 12].map((n) => ({ n, ok: false, note: `止まった: ${msgOf(e)}（ここまでの観測 ${JSON.stringify(o)}）` }));
  } finally {
    app.removeListener('browser-window-created', onCreated);
    for (const w of wins) { try { w.destroy(); } catch (_) { /* もう無い */ } }
  }
}

if (process.versions.electron && process.type === 'browser') boot();
else if (require.main === module) {
  console.error('electron-smoke は Electron の main として動かす: <electron の実行ファイル> tools/electron-smoke');
  process.exitCode = 2;
}

module.exports = { CHECKS, exitCodeOf, clipboardChecks, securityResults, finish };
