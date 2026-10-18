/*
 * shots/main.js — 主な画面を撮って比べる道具（第1a回 G2・PERF）。Electron の main として動かす
 *
 * 使い方:
 *   node_modules/electron/dist/electron.exe tools/shots --out <dir>                 … 撮って <dir>/<name>.png に書く（比べない）
 *   node_modules/electron/dist/electron.exe tools/shots --compare <基準> --out <dir> … 撮って基準と比べる（違えば <dir> に前・後・差分）
 *
 * 画面は本物（src/renderer の app.html・overlay.html）。橋は偽物（tools/shots/preload.js が本物の preload.js と同じ名前で出し、
 * 答えは screens.fixtures の見本）。窓には本物の守り（src/security の install）を付けた別の session（natsu-shots）を使う。
 * 撮る前に、時間帯を Asia/Tokyo にし（DevTools の Emulation.setTimezoneOverride）、時計を止め（preload）、アニメーションを止める（insertCSS）。
 * 同じ画面を2回撮り、1画素でも違えば「揺れる」で NG。CSP に断られた行（console-message）が1つでもあれば NG。
 * 2,000 ブロックのページと 1万行の文字起こしを開く速さを3回計り、中央値が目安（screens.PERF）を越えれば NG。
 * 結果は 1 行ずつ OK／NG で出す。最初の行に機械の版（環境変数 ImageOS・ImageVersion。無ければ「手元」）を出す
 * （基準と違ったときに、CI の機械の更新かどうかを見分ける）。どこかで止まっても、90 秒の見張りで 1 で終わる。
 *
 * Electron を読むのは、Electron の main として動いたときだけ（下の boot。tools/electron-smoke と同じ形）。
 * テスト（test/shots.test.js）がこのファイルを読むので、頭で読むと 44 の包みが本体を落としにいく（第0c回 C6）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const png = require('../png');
const security = require('../../src/security');
const SH = require('./screens');

const SRC = path.join(__dirname, '..', '..', 'src');
const PAGES = { app: path.join(SRC, 'renderer', 'app.html'), overlay: path.join(SRC, 'renderer', 'overlay.html') };
const BRIDGE = { app: 'koeApp', overlay: 'koeOverlay' };
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

/** --out <dir> と --compare <dir> を読む（Electron が足す引数は無視する） */
function parseArgs(argv) {
  const o = { out: '', compare: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') o.out = argv[++i] || '';
    else if (argv[i] === '--compare') o.compare = argv[++i] || '';
  }
  return o;
}

/** 機械の版（GitHub Actions の runner は ImageOS・ImageVersion を持つ） */
function machineOf(env) {
  return env.ImageOS || env.ImageVersion ? `${env.ImageOS || '?'} ${env.ImageVersion || '?'}` : '手元';
}

function boot() {
  const { app, BrowserWindow, ipcMain, nativeTheme, session } = require('electron');
  const args = parseArgs(process.argv.slice(1));
  // 記録の一時フォルダは終わるときに消す（手元で回すたびにプロファイルのフォルダが溜まらないように）。消せなくても終わりは止めない
  let data = null;
  const exit = (code) => {
    if (data) { try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) { /* 消せなくても終わる */ } }
    app.exit(code);
  };
  // 見張り: どこかで止まっても、ジョブの 30 分を待たずに赤にする
  setTimeout(() => { console.log('NG 時間切れ（90 秒）'); exit(1); }, 90000);
  const die = (what) => (e) => { console.log(`NG ${what}: ${(e && e.stack) || e}`); exit(1); };
  process.on('uncaughtException', die('拾われない例外'));
  process.on('unhandledRejection', die('拾われない失敗'));
  if (!args.out) {
    console.error('使い方: <electron の実行ファイル> tools/shots [--compare <基準のフォルダ>] --out <書き出すフォルダ>');
    app.exit(2);
    return;
  }
  // 記録は一時フォルダに（日本語と 𠮷 の名前。利用者のプロファイルを汚さない）
  try {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-shots-画面𠮷-'));
    app.setPath('userData', data);
    app.setPath('sessionData', data);
  } catch (e) { console.log(`参考: userData を一時フォルダにできなかった（${e.message}）`); }
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.on('window-all-closed', () => {});

  app.whenReady().then(async () => {
    console.log(`機械: ${machineOf(process.env)}（Electron ${process.versions.electron}・Chromium ${process.versions.chrome}・${process.platform}）`);
    const names = SH.apiNamesOf(fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8'));
    const ses = session.fromPartition('natsu-shots');
    security.install({ app, session: ses, pages: PAGES, log: (l) => console.log(`参考: ${l}`) });

    // 偽の橋の受け口。窓ごとに答えの表を持ち、呼ばれている数と最後に呼ばれた時刻を数える（静まるのを待つため）
    const tables = new Map();   // webContents.id → { answers, pending, last }
    ipcMain.on('shots:apis', (e) => { e.returnValue = { apis: names, now: SH.FIXED_NOW }; });
    ipcMain.on('shots:send', () => {});
    ipcMain.handle('shots:call', async (e, key) => {
      const t = tables.get(e.sender.id);
      if (!t) return { ok: true };
      t.pending += 1;
      t.last = Date.now();
      try {
        return Object.prototype.hasOwnProperty.call(t.answers, key) ? t.answers[key] : { ok: true };
      } finally { t.pending -= 1; t.last = Date.now(); }
    });

    const csp = [];
    /** 静まるまで待つ: 橋の呼び出しが 300ms 無く、文字の読み込みと2回の requestAnimationFrame が済む */
    const settle = async (wc, t) => {
      for (const end = Date.now() + 5000; Date.now() < end;) {
        if (t.pending === 0 && Date.now() - t.last >= 300) break;
        await wait(50);
      }
      await within(wc.executeJavaScript('document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))))'), 10000, '描き終わり');
    };
    /** 窓を開く（守りを付けた session・sandbox・偽の橋）。時間帯と色の主題は開く前に決める */
    const open = async (page, theme, answers) => {
      const size = page === 'overlay' ? SH.OVERLAY_SIZE : SH.SIZE;
      nativeTheme.themeSource = theme;
      const win = new BrowserWindow({
        ...size, useContentSize: true, show: false, frame: false, resizable: false,
        ...(page === 'overlay' ? { transparent: true, backgroundColor: '#00000000' } : {}),
        webPreferences: {
          offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
          preload: path.join(__dirname, 'preload.js'), session: ses,
        },
      });
      const wc = win.webContents;
      const t = { answers, pending: 0, last: Date.now() };
      tables.set(wc.id, t);
      wc.on('console-message', (e, ...rest) => {
        const level = e && e.level !== undefined ? e.level : rest[0];
        const message = e && e.message !== undefined ? e.message : rest[1];
        if (SH.cspViolation(level, message)) csp.push(`${page}: ${message}`);
        else if (level === 'error' || level === 3) console.log(`参考: ${page} の画面のエラー: ${message}`);
      });
      // 時間帯は画面を開く前に決める。作ったばかりの窓（まだ何も開いていない）に送ると 44 では返らないので、空のページを開いてから
      await within(wc.loadURL('about:blank'), 10000, '空のページ');
      wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: SH.TIME_ZONE });
      await within(win.loadFile(PAGES[page]), 15000, `${path.basename(PAGES[page])} の読み込み`);
      await wc.insertCSS(SH.FREEZE_CSS);
      await settle(wc, t);
      return { win, wc, t };
    };
    // 画面の外で描く窓（offscreen）は、まだ1枚も描いていないと capturePage が失敗する。そのときは描き直させて1度だけやり直す
    const capture = async (wc) => {
      let im;
      try { im = await within(wc.capturePage(), 10000, '撮影'); } catch (_) {
        wc.invalidate();
        await wait(500);
        im = await within(wc.capturePage(), 10000, '撮影のやり直し');
      }
      return png.decodePng(im.toPNG());
    };

    // ---- 画面を撮る
    const shots = {};
    const flaky = [];
    const errors = [];
    for (const s of SH.SCREENS) {
      let win = null;
      try {
        const o = await open(s.page, s.theme, SH.fixtures());
        win = o.win;
        if (s.event) o.wc.send(`shots:event:${BRIDGE[s.page]}.${s.event[0]}`, s.event[1]);
        if (s.act) await within(o.wc.executeJavaScript(s.act, true), 10000, `${s.name} の操作`);
        await settle(o.wc, o.t);
        await wait(300);
        const a = await capture(o.wc);
        await wait(300);
        const b = await capture(o.wc);
        const want = s.page === 'overlay' ? SH.OVERLAY_SIZE : SH.SIZE;
        const j = SH.judgePair(a, b, png);
        shots[s.name] = a;
        if (!j.ok) {
          flaky.push(s.name);
          fs.mkdirSync(args.out, { recursive: true });
          fs.writeFileSync(path.join(args.out, `${s.name}.flaky-2.png`), png.encodePng(b));
        }
        const sizeOk = a.width === want.width && a.height === want.height;
        if (!sizeOk) errors.push(`${s.name}: 大きさが ${a.width}x${a.height}（窓は ${want.width}x${want.height}）`);
        console.log(`${j.ok && sizeOk ? 'OK' : 'NG'} ${s.name} — ${j.note}${sizeOk ? '' : `、窓の大きさ ${want.width}x${want.height} と違う`}`);
      } catch (e) {
        errors.push(`${s.name}: ${msgOf(e)}`);
        console.log(`NG ${s.name} — 撮れなかった: ${msgOf(e)}`);
      } finally {
        if (win) { tables.delete(win.webContents.id); try { win.destroy(); } catch (_) { /* もう無い */ } }
      }
    }

    // ---- 書く・比べる
    let compare;
    fs.mkdirSync(args.out, { recursive: true });
    if (args.compare) {
      compare = SH.compareAll({ baseDir: path.resolve(args.compare), outDir: args.out, shots, png, fs });
      for (const c of compare) {
        const why = c.status === 'same' ? '基準と同じ' : c.status === 'diff' ? `基準と ${c.count} 画素違う（前・後・差分を書いた）`
          : c.status === 'size' ? '基準と大きさが違う（前・後・差分を書いた）' : `${c.note || '基準が無い'}（今の画像を書いた）`;
        console.log(`${c.status === 'same' ? 'OK' : 'NG'} 比べる ${c.name} — ${why}`);
      }
      const missingScreens = SH.SCREENS.filter((s) => !compare.some((c) => c.name === s.name));
      for (const s of missingScreens) errors.push(`${s.name}: 比べる画像が無い`);
    } else {
      for (const [name, im] of Object.entries(shots)) fs.writeFileSync(path.join(args.out, `${name}.png`), png.encodePng(im));
      console.log(`参考: ${Object.keys(shots).length} 枚を ${args.out} に書いた`);
    }

    // ---- 開く速さ（2,000 ブロックのページと 1万行の文字起こし。一覧のその行を押してから、ブロックが 2,000 個そろうまで）
    const perf = [];
    try {
      const answers = { ...SH.fixtures(), 'koeApp.pagesSearch': [SH.bigListEntry()], 'koeApp.pageGet': SH.bigPage() };
      const times = [];
      for (let i = 0; i < 3; i++) {
        const o = await open('app', 'light', answers);
        try {
          const ms = await within(o.wc.executeJavaScript(`(async () => {
            const t0 = performance.now();
            document.querySelector('#plist .pitem').click();
            while (document.querySelectorAll('#pNote .blk').length < 2000) await new Promise((r) => setTimeout(r, 0));
            void document.body.offsetHeight;
            return performance.now() - t0;
          })()`, true), 20000, '2,000 ブロックのページを開く');
          times.push(Math.round(ms));
        } finally { tables.delete(o.wc.id); o.win.destroy(); }
      }
      for (const r of SH.judgePerf([{ name: SH.PERF[0].name, ms: SH.median(times) }])) {
        perf.push(r);
        console.log(`${r.ok ? 'OK' : 'NG'} 速さ ${r.name} — 中央値 ${r.ms}ms（目安 ${r.budgetMs}ms。3回: ${times.join('・')}ms）`);
      }
    } catch (e) {
      perf.push({ name: SH.PERF[0].name, ms: NaN, ok: false });
      console.log(`NG 速さ ${SH.PERF[0].name} — 計れなかった: ${msgOf(e)}`);
    }

    for (const c of csp) console.log(`NG CSP の違反: ${c}`);
    const code = SH.exitCodeOf({ shots, compare, flaky, csp, perf, errors });
    console.log(code === 0
      ? `結果: OK（${Object.keys(shots).length} 枚${compare ? '・基準と全部同じ' : ''}・揺れ 0・CSP の違反 0・速さ OK）`
      : `結果: NG（揺れ ${flaky.length}・CSP の違反 ${csp.length}・撮れない ${errors.length}・速さの NG ${perf.filter((p) => !p.ok).length}${compare ? `・基準と違う ${compare.filter((c) => c.status !== 'same').length}` : ''}）`);
    for (const e of errors) console.log(`参考: ${e}`);
    process.stdout.write('', () => exit(code));
  }, die('起動の失敗'));
}

if (process.versions.electron && process.type === 'browser') boot();
else if (require.main === module) {
  console.error('shots は Electron の main として動かす: <electron の実行ファイル> tools/shots --out <dir>');
  process.exitCode = 2;
}

module.exports = { parseArgs, machineOf };
