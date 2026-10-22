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
 * 第1b回 C-1: 画面ごとの答え（s.answers を見本に重ねる）・拡大（s.zoom。開いた後に setZoomFactor、撮る前に窓の中の幅を確かめる）・
 * Tab の後の輪（s.focus。sendInputEvent で Tab を送る。効かなければ el.focus() に落として参考に出す）・本体の画面の横のはみ出し
 * （SH.OVERFLOW_PROBE）を見る。取り直し待ち（SH.RETAKE）の画面は基準と違っても「取り直し待ち」と出し、前・後・差分は今までどおり書く。
 * 結果は 1 行ずつ OK／NG で出す。最初の行に機械の版（環境変数 ImageOS・ImageVersion。無ければ「手元」）を出す
 * （基準と違ったときに、CI の機械の更新かどうかを見分ける）。どこかで止まっても、見張り（SH.watchdogMs: 30 秒 + 撮る画面の数 × 6 秒）で 1 で終わる。
 * 0.9.0 O-3（設計書 D25・RP9・F11）: 録音バーの画面（SH.SCREENS の page 'overlay'。tools/shots/pill-states.js の状態 × 形 × 地 × 拡大率）は、
 * 形・地・拡大率の組ごとに窓を1つ開き、状態を act で替えて撮る。撮る前にピルの大きさを測り（SH.PANEL_PROBE）、main と同じ panelBounds で
 * 窓の大きさを決め直す（SH.panelWindowFor）。拡大率の画面は、画面の外で描く窓そのものに拡大率を持たせて（webPreferences の
 * offscreen: { deviceScaleFactor }）同じプロセスで撮り、撮れた画像が「窓 × 拡大率」（SH.shotSizeFor）でなければ NG。
 * （O-3 で作るときに確かめた: 44.9.0 の画面の外で描く窓は、DevTools の拡大率の上書き（Emulation の device metrics）の deviceScaleFactor を
 * devicePixelRatio には当てるが撮った画像は 1 倍のまま、プロセスの --force-device-scale-factor は窓に当たらない。offscreen の deviceScaleFactor
 * だけが 1.25・1.5・2 で「窓 × 拡大率」の画像になった）。ピルが窓の内側に 4px 以上の余白で入るか（SH.judgePanel）を、撮る画面の全部と、
 * 横と縦の記録中と警告を拡大率 1・1.25・1.5・2 で見る（SH.PANEL_PROBE_SCALES。取り直し待ちでも NG）。
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
// 0.9.3 M-7: 会議の検出のパネル（nudge.html）も撮る（守りの CSP のハッシュも本物と同じく PAGES から作る）
const PAGES = { app: path.join(SRC, 'renderer', 'app.html'), overlay: path.join(SRC, 'renderer', 'overlay.html'), nudge: path.join(SRC, 'renderer', 'nudge.html') };
const BRIDGE = { app: 'koeApp', overlay: 'koeOverlay', nudge: 'koeNudge' };
const FIRST_SIZE = { overlay: SH.OVERLAY_SIZE, nudge: SH.NUDGE_SIZE };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const msgOf = (e) => (e && e.message) || String(e);

/** promise を ms で打ち切る（止まったまま見張りの時間を待たない） */
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
  // 見張り: どこかで止まっても、ジョブの 30 分を待たずに赤にする。時間は撮る画面の数で決める（決まった値では録音バーの画面を足すと必ず切れる）
  const limitMs = SH.watchdogMs(SH.SCREENS.length);
  setTimeout(() => { console.log(`NG 時間切れ（${Math.round(limitMs / 1000)} 秒）`); exit(1); }, limitMs);
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
    /**
     * 窓を開く（守りを付けた session・sandbox・偽の橋）。時間帯と色の主題は開く前に決める。
     * 拡大は開いた後に決める。倍率は同じ出どころ（file://）の窓どうしで引き継がれるので、拡大しない窓も 1 を決め直す。
     * 0.9.0 O-3: 拡大率（scale。録音バーの 150% などの画面）は、画面の外で描く窓そのものに持たせる（offscreen: { deviceScaleFactor }）
     */
    const open = async (page, theme, answers, zoom = 1, size = FIRST_SIZE[page] || SH.SIZE, scale = 1) => {
      nativeTheme.themeSource = theme;
      const win = new BrowserWindow({
        ...size, useContentSize: true, show: false, frame: false, resizable: false,
        // 録音バーとパネル（0.9.3 M-7）は本物と同じ透過の窓
        ...(page === 'app' ? {} : { transparent: true, backgroundColor: '#00000000' }),
        webPreferences: {
          offscreen: scale === 1 ? true : { deviceScaleFactor: scale }, sandbox: true, contextIsolation: true, nodeIntegration: false,
          preload: path.join(__dirname, 'preload.js'), session: ses,
        },
      });
      // 画面の作業域より大きい窓は、作るときに作業域まで縮められる（Windows の CI の画面は 1024x768 で、1120x780 が 1024x720 になった）。
      // offscreen の窓は画面に出ないので、作った後に決めた大きさへ戻す（画面の大きさで撮る画像が変わらないように）
      SH.ensureContentSize(win, size);
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
      wc.setZoomFactor(zoom);
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
    // 今のフォーカスと輪。body（何も選んでいない）なら none
    const FOCUS_READ = `(() => {
      const a = document.activeElement;
      const none = !a || a === document.body || a === document.documentElement;
      return { none, id: none ? '' : a.id, outline: none ? '' : getComputedStyle(a).outlineStyle };
    })()`;
    /**
     * 何も選んでいない所から本物の Tab を n 回送る。画面の外の窓で Tab が効かなければ（body のまま）、決めた要素を focus() して輪の見え方だけを見る。
     * 見せない窓（show: false）のページはフォーカスを持たず、:focus-visible が当たらない（作業環境の 44.9.0 で、Tab で移っても outline は none だった）。
     * だから DevTools の Emulation.setFocusEmulationEnabled でページがフォーカスを持つ扱いにする（この画面だけ。ほかの画面の見た目は変えない）
     */
    const tabTo = async (wc, focus) => {
      await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await within(wc.executeJavaScript('(document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1)'), 10000, 'フォーカスを外す');
      wc.focus();
      for (let i = 0; i < focus.tabs; i++) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
        await wait(100);
      }
      let got = await within(wc.executeJavaScript(FOCUS_READ), 10000, 'フォーカスを読む');
      let real = true;
      if (got.none) {
        real = false;
        await within(wc.executeJavaScript(`((document.getElementById(${JSON.stringify(focus.want)}) || { focus() {} }).focus(), 1)`), 10000, 'focus()');
        got = await within(wc.executeJavaScript(FOCUS_READ), 10000, 'フォーカスを読む');
      }
      return { got, real };
    };

    // ---- 画面を撮る
    const shots = {};
    const flaky = [];
    const errors = [];
    const overflow = [];   // 本体の画面ごとの { name, ok, note }
    const focus = [];      // Tab の輪を見る画面の { name, ok, note }
    // 慣らし: Windows の CI で、最初に開いた窓（notes-empty-light）だけ、札と枠の角の縁の画素が実行ごとに2通りに描かれた
    // （色の差 8 まで・31 画素。2 枚目からの窓は4回の実行でいつも同じ、同じ札も同じに描かれる）。最初の画面を1度開いて撮って
    // 捨ててから本番を撮る。慣らしの画像は本番の最初の画面と比べて、違えば参考に出す（直ったかを CI の記録で見るため）
    let warmShot = null;
    try {
      const warm = await open(SH.SCREENS[0].page, SH.SCREENS[0].theme, SH.fixtures());
      try {
        if (SH.SCREENS[0].act) await within(warm.wc.executeJavaScript(SH.SCREENS[0].act, true), 10000, '慣らしの操作');
        await settle(warm.wc, warm.t);
        warmShot = await capture(warm.wc);
      } finally {
        tables.delete(warm.wc.id);
        try { warm.win.destroy(); } catch (_) { /* もう無い */ }
      }
    } catch (e) {
      console.log(`参考: 慣らしの画面を撮れなかった（本番は続ける）: ${msgOf(e)}`);
    }
    // ---- 録音バーの画面（0.9.0 O-3・設計書 D25・RP9・F11）
    const panel = [];   // ピルが窓の内側に 4px 以上の余白で入るかの { name, ok, note }（取り直し待ちでも NG）
    let ov = null;      // 今開いている録音バーの窓 { key, win, wc, t }（形・地・拡大率の組ごとに1つ）
    const closeOverlay = () => {
      if (!ov) return;
      tables.delete(ov.wc.id);
      try { ov.win.destroy(); } catch (_) { /* もう無い */ }
      ov = null;
    };
    const probePanel = async (o) => within(o.wc.executeJavaScript(SH.PANEL_PROBE), 10000, 'ピルを測る');
    /** 録音バーの窓を、ピルの大きさ（CSS の px）から main と同じ panelBounds の大きさにする。答えは窓の大きさ（DIP） */
    const fitPanel = async (o, slot) => {
      const r = await probePanel(o);
      if (!r || !r.pill) throw new Error('ピルを測れなかった');
      const winSize = SH.panelWindowFor({ w: r.pill.right - r.pill.left, h: r.pill.bottom - r.pill.top }, slot);
      o.win.setContentSize(winSize.width, winSize.height);
      await settle(o.wc, o.t);
      await wait(150);
      return winSize;
    };
    /** 録音バーの画面を1枚撮る（窓は形・地・拡大率の組が替わったときだけ開き直す。状態は act で替える） */
    const shootPanel = async (s) => {
      const { form, desk, scale } = s.pill;
      try {
        const key = `${form}|${desk}|${scale}`;
        if (!ov || ov.key !== key) {
          closeOverlay();
          ov = { key, ...(await open('overlay', s.theme, SH.fixtures(), 1, SH.OVERLAY_SIZE, scale)) };
        }
        await within(ov.wc.executeJavaScript(s.act, true), 10000, `${s.name} の操作`);
        await settle(ov.wc, ov.t);
        const winSize = await fitPanel(ov, s.slot);
        const room = SH.judgePanel(await probePanel(ov));
        panel.push({ name: s.name, ok: room.ok, note: room.note });
        if (!room.ok) console.log(`NG 余白 ${s.name} — ${room.note}`);
        const a = await capture(ov.wc);
        // 2枚目は描き直させてから撮る（同じ描き終わりの写しを2回比べても、描くたびの揺れは見つからない）
        ov.wc.invalidate();
        await settle(ov.wc, ov.t);
        await wait(300);
        const b = await capture(ov.wc);
        const want = SH.shotSizeFor(winSize, scale);
        const j = SH.judgePair(a, b, png);
        shots[s.name] = a;
        if (!j.ok) {
          flaky.push(s.name);
          fs.mkdirSync(args.out, { recursive: true });
          fs.writeFileSync(path.join(args.out, `${s.name}.flaky-2.png`), png.encodePng(b));
        }
        // 拡大率の画面は「窓 × 拡大率」の大きさで撮れていなければ NG（拡大率が当たっていない画像を 150% と言わない）
        const sizeOk = a.width === want.width && a.height === want.height;
        if (!sizeOk) errors.push(`${s.name}: 大きさが ${a.width}x${a.height}（窓 ${winSize.width}x${winSize.height} × 拡大率 ${scale} は ${want.width}x${want.height}）`);
        console.log(`${j.ok && sizeOk ? 'OK' : 'NG'} ${s.name} — ${j.note}${sizeOk ? '' : `、${want.width}x${want.height} のはず`}`);
      } catch (e) {
        errors.push(`${s.name}: ${msgOf(e)}`);
        console.log(`NG ${s.name} — 撮れなかった: ${msgOf(e)}`);
        closeOverlay();   // 次の画面は窓を開き直す
      }
    };

    /**
     * 0.9.3 M-7: パネルの画面を1枚撮る（画面ごとに透過の窓を開く）。onShow で明暗とアプリの名前を渡し、act で地を塗る（⌄ を開く）。
     * 測ったパネル（#nz）の大きさから main と同じ nudgeBounds で窓を決め直し、パネルが窓の内側に入るか（judgePanel）を見る。150% は窓 × 拡大率で撮れたか
     */
    const shootNudge = async (s) => {
      closeOverlay();
      const scale = s.scale || 1;
      let o = null;
      try {
        o = await open('nudge', s.theme, SH.fixtures(), 1, SH.NUDGE_SIZE, scale);
        for (const [name, payload] of s.events || []) o.wc.send(`shots:event:${BRIDGE[s.page]}.${name}`, payload);
        await wait(150);
        if (s.act) await within(o.wc.executeJavaScript(s.act, true), 10000, `${s.name} の操作`);
        await settle(o.wc, o.t);
        const r = await within(o.wc.executeJavaScript(SH.NUDGE_PROBE), 10000, 'パネルを測る');
        if (!r || !r.pill) throw new Error('パネルを測れなかった');
        const winSize = SH.nudgeWindowFor({ w: r.pill.right - r.pill.left, h: r.pill.bottom - r.pill.top });
        o.win.setContentSize(winSize.width, winSize.height);
        await settle(o.wc, o.t);
        await wait(150);
        const room = SH.judgePanel(await within(o.wc.executeJavaScript(SH.NUDGE_PROBE), 10000, 'パネルを測る'));
        panel.push({ name: s.name, ok: room.ok, note: room.note });
        if (!room.ok) console.log(`NG 余白 ${s.name} — ${room.note}`);
        o.wc.invalidate();
        await settle(o.wc, o.t);
        await wait(300);
        const a = await capture(o.wc);
        o.wc.invalidate();
        await settle(o.wc, o.t);
        await wait(300);
        const b = await capture(o.wc);
        const want = SH.shotSizeFor(winSize, scale);
        const j = SH.judgePair(a, b, png);
        shots[s.name] = a;
        if (!j.ok) {
          flaky.push(s.name);
          fs.mkdirSync(args.out, { recursive: true });
          fs.writeFileSync(path.join(args.out, `${s.name}.flaky-2.png`), png.encodePng(b));
        }
        const sizeOk = a.width === want.width && a.height === want.height;
        if (!sizeOk) errors.push(`${s.name}: 大きさが ${a.width}x${a.height}（窓 ${winSize.width}x${winSize.height} × 拡大率 ${scale} は ${want.width}x${want.height}）`);
        console.log(`${j.ok && sizeOk ? 'OK' : 'NG'} ${s.name} — ${j.note}${sizeOk ? '' : `、${want.width}x${want.height} のはず`}`);
      } catch (e) {
        errors.push(`${s.name}: ${msgOf(e)}`);
        console.log(`NG ${s.name} — 撮れなかった: ${msgOf(e)}`);
      } finally {
        if (o) { tables.delete(o.wc.id); try { o.win.destroy(); } catch (_) { /* もう無い */ } }
      }
    };

    for (const s of SH.SCREENS) {
      if (s.page === 'overlay') { await shootPanel(s); continue; }
      if (s.page === 'nudge') { await shootNudge(s); continue; }
      closeOverlay();
      let win = null;
      try {
        const o = await open(s.page, s.theme, { ...SH.fixtures(), ...JSON.parse(JSON.stringify(s.answers || {})) }, s.zoom || 1);
        win = o.win;
        // 0.9.3 M-7: 「動きを減らす」の設定を画面ごとに決める（CI の機械の設定で撮る形が変わらないように）
        if (s.motion) await o.wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: s.motion }] });
        // 0.9.3 M-7: main から届く出来事の並び（音の波の WAVE_SPEECH など）を順に送る
        for (const [name, payload] of s.events || []) o.wc.send(`shots:event:${BRIDGE[s.page]}.${name}`, payload);
        if (s.act) await within(o.wc.executeJavaScript(s.act, true), 10000, `${s.name} の操作`);
        await settle(o.wc, o.t);
        await wait(300);
        if (s.zoom) {
          const z = SH.judgeZoom(await within(o.wc.executeJavaScript('window.innerWidth'), 10000, '窓の中の幅'), s.zoom);
          if (!z.ok) errors.push(`${s.name}: ${z.note}`);
          console.log(`${z.ok ? 'OK' : 'NG'} 拡大 ${s.name} — ${z.note}`);
        }
        if (s.focus) {
          const { got, real } = await tabTo(o.wc, s.focus);
          const j = SH.judgeFocus(got, s.focus);
          focus.push({ name: s.name, ok: j.ok, note: j.note });
          if (!real) console.log(`参考: ${s.name} — 本物の Tab が効かない（画面の外の窓）。#${s.focus.want} を focus() して輪の見え方だけを見た`);
          console.log(`${j.ok ? 'OK' : SH.RETAKE.has(s.name) ? '取り直し待ち' : 'NG'} Tab の輪 ${s.name} — ${j.note}`);
          await settle(o.wc, o.t);
          await wait(100);
        }
        if (s.page === 'app') {
          const j = SH.judgeOverflow(await within(o.wc.executeJavaScript(SH.OVERFLOW_PROBE), 10000, 'はみ出しを集める'));
          overflow.push({ name: s.name, ok: j.ok, note: j.note });
          console.log(`${j.ok ? 'OK' : 'NG'} はみ出し ${s.name} — ${j.note}`);
        }
        // 0.9.0 O-3: 1枚目も描き直させてから撮る。本体の画面の間にあった録音バーの画面（overlay-processing）を外すと、Linux の手元で
        // live-banner-zoom200-dark の初めの描き終わりが1画素だけ後の描き直しと違うことがあった（34c9dfa の道具で、その1枚を外しただけで
        // 3回に2回。1枚目も描き直しの後にすると4回とも同じ）。2枚とも描き直しの後なので、描くたびの揺れは今どおり見つかる
        o.wc.invalidate();
        await settle(o.wc, o.t);
        await wait(300);
        const a = await capture(o.wc);
        // 2枚目は描き直させてから撮る（同じ描き終わりの写しを2回比べても、描くたびの揺れは見つからない）
        o.wc.invalidate();
        await settle(o.wc, o.t);
        await wait(300);
        const b = await capture(o.wc);
        if (warmShot && s === SH.SCREENS[0]) {
          const w = png.diffImages(warmShot, a, { tolerance: 0 });
          console.log(`参考: 慣らしの画像と本番の ${s.name} は${w.same ? '同じ' : `${w.sizeMismatch ? '大きさが違う' : `${w.count} 画素違う`}`}`);
        }
        const want = SH.SIZE;
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
    closeOverlay();

    // ---- 録音バーの余白（F11）: 横と縦の記録中と警告を、拡大率 1・1.25・1.5・2 で（基準の画像は 100・150% だけ。ここは測るだけ）
    for (const form of [...new Set(SH.SCREENS.filter((x) => x.pill).map((x) => x.pill.form))]) {
      for (const scale of SH.PANEL_PROBE_SCALES) {
        let o = null;
        try {
          o = await open('overlay', 'light', SH.fixtures(), 1, SH.OVERLAY_SIZE, scale);
          for (const state of SH.PANEL_PROBE_STATES) {
            const name = `panel-${form}-${state}-${Math.round(scale * 100)}`;
            const s = SH.SCREENS.find((x) => x.pill && x.pill.form === form && x.pill.state === state && x.pill.desk === 'light' && x.pill.scale === 1);
            if (!s) throw new Error(`録音バーの画面 ${form}・${state} が無い`);
            await within(o.wc.executeJavaScript(s.act, true), 10000, `${name} の操作`);
            await settle(o.wc, o.t);
            const winSize = await fitPanel(o, s.slot);
            const dpr = await within(o.wc.executeJavaScript('window.devicePixelRatio'), 10000, '拡大率を読む');
            const j = SH.judgePanel(await probePanel(o));
            // 拡大率が窓に当たっていなければ、確かめになっていないので NG
            const ok = j.ok && dpr === scale;
            const note = `${j.note}・devicePixelRatio ${dpr}${dpr === scale ? '' : `（${scale} のはず）`}・窓 ${winSize.width}x${winSize.height}`;
            panel.push({ name, ok, note });
            console.log(`${ok ? 'OK' : 'NG'} 余白 ${name} — ${note}`);
          }
        } catch (e) {
          panel.push({ name: `panel-${form}-${Math.round(scale * 100)}`, ok: false, note: msgOf(e) });
          console.log(`NG 余白 panel-${form}-${Math.round(scale * 100)} — 測れなかった: ${msgOf(e)}`);
        } finally {
          if (o) { tables.delete(o.wc.id); try { o.win.destroy(); } catch (_) { /* もう無い */ } }
        }
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
        console.log(`${c.status === 'same' ? 'OK' : SH.RETAKE.has(c.name) ? '取り直し待ち' : 'NG'} 比べる ${c.name} — ${why}`);
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
    const code = SH.exitCodeOf({ shots, compare, flaky, csp, perf, errors, retake: SH.RETAKE, overflow, focus, panel });
    const retakeN = compare ? compare.filter((c) => c.status !== 'same' && SH.RETAKE.has(c.name)).length : 0;
    const overN = overflow.filter((x) => !x.ok).length;
    console.log(code === 0
      ? `結果: OK（${Object.keys(shots).length} 枚${compare ? (retakeN ? `・取り直し待ち ${retakeN}・ほかは基準と同じ` : '・基準と全部同じ') : ''}・はみ出し 0・録音バーの余白 OK・揺れ 0・CSP の違反 0・速さ OK）`
      : `結果: NG（揺れ ${flaky.length}・CSP の違反 ${csp.length}・撮れない ${errors.length}・はみ出し ${overN}・録音バーの余白の NG ${panel.filter((x) => !x.ok).length}・Tab の輪の NG ${focus.filter((x) => !x.ok && !SH.RETAKE.has(x.name)).length}・速さの NG ${perf.filter((p) => !p.ok).length}${compare ? `・基準と違う ${compare.filter((c) => c.status !== 'same' && !SH.RETAKE.has(c.name)).length}・取り直し待ち ${retakeN}` : ''}）`);
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
