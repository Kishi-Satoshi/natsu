/*
 * security.test.js — Electron の守り（第1a回 SEC1。RF19・EL10・F1・F6）
 * 判断は src/security.js の純粋な関数で確かめ、本物の Electron 44 での動きは tools/electron-smoke（Windows の CI）で確かめる。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('../src/security');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const W = { app: 'file:///C:/Users/%E3%83%A6%E3%83%BC%E3%82%B6%E3%83%BC/AppData/Local/Programs/NaTsu/resources/app/src/renderer/app.html',
  overlay: 'file:///C:/Users/%E3%83%A6%E3%83%BC%E3%82%B6%E3%83%BC/AppData/Local/Programs/NaTsu/resources/app/src/renderer/overlay.html' };
const L = { app: 'file:///opt/natsu/src/renderer/app.html', overlay: 'file:///opt/natsu/src/renderer/overlay.html' };
const sha = (s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;

test('SEC1: 窓の種類はファイルの URL で決める（? と # は見ない）。ほかのファイル・http・壊れた URL は種類なし', { timeout: 5000 }, () => {
  assert.strictEqual(S.pageKind(L.app, L, 'linux'), 'app');
  assert.strictEqual(S.pageKind(`${L.overlay}#x`, L, 'linux'), 'overlay');
  assert.strictEqual(S.pageKind(`${L.app}?a=1`, L, 'linux'), 'app');
  assert.strictEqual(S.pageKind('file:///opt/natsu/src/renderer/other.html', L, 'linux'), '');
  assert.strictEqual(S.pageKind('https://example.invalid/src/renderer/app.html', L, 'linux'), '');
  assert.strictEqual(S.pageKind('file:///opt/natsu/src/renderer/APP.html', L, 'linux'), '', 'Linux では大文字と小文字を区別する');
  for (const u of ['', 'not a url', null, undefined]) assert.strictEqual(S.pageKind(u, L, 'linux'), '', String(u));
});

test('SEC1: Windows ではドライブと大文字・小文字を区別せず、日本語のユーザー名は %E3… の形でも同じに扱う', { timeout: 5000 }, () => {
  assert.strictEqual(S.pageKind('file:///c:/users/ユーザー/appdata/local/programs/natsu/resources/app/src/renderer/APP.html', W, 'win32'), 'app');
  assert.strictEqual(S.pageKind(W.overlay, W, 'win32'), 'overlay');
  assert.strictEqual(S.pageKind('file:///D:/Users/ユーザー/AppData/Local/Programs/NaTsu/resources/app/src/renderer/app.html', W, 'win32'), '');
});

test('SEC1: URL の形のちがい（%27 と \'、%61 と a）は pathname を decodeURIComponent してそろえる（消すと本体が種類なし＝一番きつい CSP で真っ白）', { timeout: 5000 }, () => {
  const Q = { app: "file:///C:/Users/a'b/AppData/app.html", overlay: "file:///C:/Users/a'b/AppData/overlay.html" };
  assert.strictEqual(S.pageKind('file:///C:/Users/a%27b/AppData/app.html', Q, 'win32'), 'app');
  assert.strictEqual(S.pageKind('file:///opt/natsu/src/renderer/%61pp.html', L, 'linux'), 'app');
});

test('SEC1・RF19・EL10: 許可の頼み — マイク（音だけ）は app と overlay、画面の取り込み（44 は media の空、45 は display-capture）は overlay だけ。ほかは全部断る', { timeout: 5000 }, () => {
  const rows = [
    ['app', 'media', { mediaTypes: ['audio'] }, true], ['overlay', 'media', { mediaTypes: ['audio'] }, true], ['', 'media', { mediaTypes: ['audio'] }, false],
    ['app', 'media', { mediaTypes: ['video'] }, false], ['app', 'media', { mediaTypes: ['audio', 'video'] }, false], ['overlay', 'media', { mediaTypes: ['video'] }, false],
    ['overlay', 'media', { mediaTypes: [] }, true], ['app', 'media', { mediaTypes: [] }, false], ['', 'media', { mediaTypes: [] }, false], ['app', 'media', {}, false],
    ['overlay', 'display-capture', { mediaTypes: ['video', 'audio'] }, true], ['app', 'display-capture', {}, false], ['', 'display-capture', {}, false],
    ...['notifications', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write', 'openExternal', 'fullscreen', 'midi', 'hid', 'usb', 'serial',
      'speaker-selection', 'fileSystem', 'local-fonts', 'window-management', 'unknown'].flatMap((p) => [['app', p, {}, false], ['overlay', p, {}, false]]),
  ];
  for (const [k, p, d, want] of rows) assert.strictEqual(S.allowRequest(k, p, d), want, `${k} ${p} ${JSON.stringify(d)}`);
});

test('SEC1・RF19: 許可の確かめ — media の audio だけを app と overlay に許す（マイクとスピーカーの名前が出る。カメラは出ない）', { timeout: 5000 }, () => {
  const rows = [
    ['app', 'media', { mediaType: 'audio' }, true], ['overlay', 'media', { mediaType: 'audio' }, true], ['', 'media', { mediaType: 'audio' }, false],
    ['app', 'media', { mediaType: 'video' }, false], ['app', 'media', { mediaType: 'unknown' }, false], ['app', 'media', {}, false],
    ['overlay', 'display-capture', {}, true], ['app', 'display-capture', {}, false], ['app', 'speaker-selection', {}, false], ['app', 'notifications', {}, false],
  ];
  for (const [k, p, d, want] of rows) assert.strictEqual(S.allowCheck(k, p, d), want, `${k} ${p} ${JSON.stringify(d)}`);
});

test('SEC1・F6: CSP はインラインの <script> の中身の sha256 だけを許し、ほかの script・接続・埋め込み・eval を断る', { timeout: 5000 }, () => {
  const html = '<!doctype html><style>p{}</style><script>window.a = 1;</script><p style="x">t</p><script>\nwindow.b = 2;\n</script><script src="x.js"></script>';
  const parts = S.cspFor(html).split('; ');
  assert.ok(parts.includes("default-src 'none'"));
  const script = parts.find((d) => d.startsWith('script-src '));
  assert.deepStrictEqual(script.split(' ').slice(1).sort(), [sha('window.a = 1;'), sha('\nwindow.b = 2;\n')].sort());
  for (const d of ["style-src 'unsafe-inline'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'"]) assert.ok(parts.includes(d), d);
  assert.ok(!/unsafe-eval/.test(parts.join(';')) && !/unsafe-inline/.test(script), script);
  assert.strictEqual(S.cspFor('<p>x</p>').split('; ').find((d) => d.startsWith('script-src ')), "script-src 'none'");
});

test('F6: 改行が CRLF・CR のファイルでも、画面が見る中身（LF にそろえた文字）のハッシュにする', { timeout: 5000 }, () => {
  assert.strictEqual(S.cspFor('<script>\r\na();\r\n</script>'), S.cspFor('<script>\na();\n</script>'));
  assert.strictEqual(S.cspFor('<script>\ra();\r</script>'), S.cspFor('<script>\na();\n</script>'));
});

test('F6: 今の app.html と overlay.html のインラインの script は数え漏れなく1つずつ（数え漏れがあると画面が真っ白になる）', { timeout: 5000 }, () => {
  for (const f of ['src/renderer/app.html', 'src/renderer/overlay.html']) {
    const html = read(f);
    const n = (html.match(/<script\b(?![^>]*\bsrc=)[^>]*>/gi) || []).length;
    assert.ok(n >= 1, f);
    assert.strictEqual(S.inlineScriptHashes(html).length, n, f);
    assert.ok(!/\son[a-z]+=["']/i.test(html.replace(/<script\b[\s\S]*?<\/script>/gi, '')), `${f} にインラインの on…= がある（CSP で止まる）`);
  }
});

test('SEC1: 新しい窓は開かない', { timeout: 5000 }, () => {
  assert.deepStrictEqual(S.windowOpen({ url: 'https://example.invalid/' }), { action: 'deny' });
  assert.match(S.STRICT_CSP, /^default-src 'none'/);
});

// ── Task 3-2: 守りを main に付ける ─────────────────────────────────────
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const code = (s) => String(s).replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fnBody = (src, head, end) => { const i = src.indexOf(head); return i < 0 ? '' : src.slice(i, src.indexOf(end, i) + end.length); };

test('SEC1: install は許可の受け口2つ・file:// の画面への CSP のヘッダー・新しい webContents の移動と新しい窓の禁止を付ける', { timeout: 5000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-取込𠮷-sec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pages = { app: path.join(dir, 'app.html'), overlay: path.join(dir, 'overlay.html') };
  const url = { app: pathToFileURL(pages.app).href, overlay: pathToFileURL(pages.overlay).href };
  const files = { [pages.app]: '<script>a()</script>', [pages.overlay]: '<script>b()</script>' };
  const calls = {};
  const session = {
    setPermissionRequestHandler: (h) => { calls.req = h; },
    setPermissionCheckHandler: (h) => { calls.check = h; },
    webRequest: { onHeadersReceived: (filter, h) => { calls.headers = [filter, h]; } },
  };
  const appEv = {};
  const logs = [];
  S.install({ app: { on: (ev, f) => { appEv[ev] = f; } }, session, pages, log: (l) => logs.push(l),
    readFile: (p) => { if (!(p in files)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return files[p]; } });
  // 頼み（requestingUrl が無ければ webContents の URL で決める）
  let granted;
  calls.req(null, 'media', (g) => { granted = g; }, { mediaTypes: ['audio'], requestingUrl: url.app });
  assert.strictEqual(granted, true);
  calls.req({ getURL: () => url.app }, 'media', (g) => { granted = g; }, { mediaTypes: [] });
  assert.strictEqual(granted, false, 'app の窓に画面の取り込みを許した');
  calls.req({ getURL: () => url.overlay }, 'media', (g) => { granted = g; }, { mediaTypes: [] });
  assert.strictEqual(granted, true);
  // 確かめ
  assert.strictEqual(calls.check(null, 'media', 'file:///', { mediaType: 'audio', requestingUrl: url.overlay }), true);
  assert.strictEqual(calls.check(null, 'media', 'file:///', { mediaType: 'video', requestingUrl: url.overlay }), false);
  assert.strictEqual(calls.check(null, 'notifications', '', {}), false);
  // CSP
  assert.deepStrictEqual(calls.headers[0], { urls: ['file://*/*'] });
  let out;
  calls.headers[1]({ url: url.app, resourceType: 'mainFrame', responseHeaders: { 'Content-Type': ['text/html'] } }, (r) => { out = r; });
  assert.deepStrictEqual(out.responseHeaders['Content-Type'], ['text/html']);
  assert.deepStrictEqual(out.responseHeaders['Content-Security-Policy'], [S.cspFor(files[pages.app])]);
  calls.headers[1]({ url: pathToFileURL(path.join(dir, 'other.html')).href, resourceType: 'mainFrame', responseHeaders: {} }, (r) => { out = r; });
  assert.deepStrictEqual(out.responseHeaders['Content-Security-Policy'], [S.STRICT_CSP]);
  // 読めないとき（自動更新の途中など）も、ゆるめずに一番きつい CSP
  files[pages.app + '.gone'] = files[pages.app];
  delete files[pages.app];
  calls.headers[1]({ url: url.app, resourceType: 'mainFrame', responseHeaders: {} }, (r) => { out = r; });
  assert.deepStrictEqual(out.responseHeaders['Content-Security-Policy'], [S.STRICT_CSP]);
  assert.strictEqual(logs.length, 1);
  // 画面の中の画像など（mainFrame でないもの）には足さない
  calls.headers[1]({ url: url.app, resourceType: 'image', responseHeaders: {} }, (r) => { out = r; });
  assert.deepStrictEqual(out, {});
  // 新しい webContents
  const wcEv = {};
  let opener;
  appEv['web-contents-created']({}, { on: (ev, f) => { wcEv[ev] = f; }, setWindowOpenHandler: (f) => { opener = f; } });
  for (const ev of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) {
    let prevented = false;
    wcEv[ev]({ preventDefault: () => { prevented = true; }, url: 'https://example.invalid/' });
    assert.ok(prevented, ev);
  }
  assert.deepStrictEqual(opener({ url: 'https://example.invalid/' }), { action: 'deny' });
});

// 第1d回 A-11 で意図して変えた: 窓は3つ（録音バー・本体・ログインの窓）。ログインの窓は preload を持たず、partition はログインの partition。
// install にはログインの窓の守り（isLoginContents・loginGuard）を渡す
test('SEC1: main はどの窓にも sandbox: true を明記し、窓を作る前に security.install を呼ぶ（第1d回 A-11: ログインの窓も）', { timeout: 5000 }, () => {
  const m = code(read('src/main.js'));
  assert.match(m, /const security = require\('\.\/security'\);/);
  assert.match(m, /const RENDERER_PAGES = \{ app: path\.join\(__dirname, 'renderer', 'app\.html'\), overlay: path\.join\(__dirname, 'renderer', 'overlay\.html'\) \};/);
  const prefs = [...m.matchAll(/webPreferences: \{([^}]*)\}/g)].map((x) => x[1]);
  assert.strictEqual(prefs.length, 3);
  for (const p of prefs) for (const k of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false']) assert.ok(p.includes(k), `${k}: ${p}`);
  const login = prefs.filter((p) => p.includes('partition: relay.ACCESS_PARTITION'));
  assert.strictEqual(login.length, 1, 'ログインの窓の webPreferences が無い');
  for (const k of ['webviewTag: false', 'spellcheck: false']) assert.ok(login[0].includes(k), `${k}: ${login[0]}`);
  assert.ok(!login[0].includes('preload'), 'ログインの窓に preload を付けた（Cloudflare の画面に NaTsu の口を渡す）');
  const ready = fnBody(m, 'app.whenReady().then(', '\n  });');
  const i = ready.indexOf('security.install({ app, session: session.defaultSession, pages: RENDERER_PAGES, log: engineLog, isLoginContents, loginGuard });');
  assert.ok(i > 0 && i < ready.indexOf('createOverlay();') && i < ready.indexOf('createMainWindow();'), '窓を作った後に守りを付けている');
  assert.ok(!/webSecurity: false|allowRunningInsecureContent|nodeIntegration: true|contextIsolation: false/.test(m));
});

// ---------------------------------------------------------------- 第1d回 A-11（F25・F20）: ログインの窓だけ、許した行き先を通す
// 全体の守り（どの webContents の移動も止める）のままでは、ログインの窓の中のフォームの送り（［Send login code］・［Sign in］）が止まり、
// ログインが終わらない。isLoginContents が真の webContents（ログインの partition）だけ、loginGuard で決める。ほかは今のまま必ず止める
test('F25・F20: isLoginContents が真の webContents だけ、will-navigate・will-frame-navigate・will-redirect を loginGuard で決め（許す行き先は通し、ほかは止める）、will-attach-webview と window.open は止める。偽の webContents（本体・録音バー・ほかの partition）は今のまま必ず止める', { timeout: 5000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'natsu-取込𠮷-sec-login-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pages = { app: path.join(dir, 'app.html'), overlay: path.join(dir, 'overlay.html') };
  const session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onHeadersReceived() {} } };
  const loginSes = { partition: 'natsu-access' };
  const RELAY = 'natsu-relay.example-team.workers.dev';
  const ACCESS = 'example-team.cloudflareaccess.com';
  const allowed = new Set([RELAY, ACCESS]);
  const blocked = [];
  const appEv = {};
  S.install({ app: { on: (ev, f) => { appEv[ev] = f; } }, session, pages, readFile: () => '',
    isLoginContents: (wc) => wc.session === loginSes,
    loginGuard: {
      allow: (url) => { try { const u = new URL(url); return u.protocol === 'https:' && allowed.has(u.hostname); } catch (_) { return false; } },
      blocked: (url, d) => { blocked.push([url, d.kind, d.isMainFrame]); },
    } });
  const make = (ses) => {
    const ev = {};
    let opener = null;
    appEv['web-contents-created']({}, { session: ses, on: (e, f) => { ev[e] = f; }, setWindowOpenHandler: (f) => { opener = f; } });
    return { ev, open: (url) => opener({ url }) };
  };
  // 止めたら true。Electron 44 の出来事は details（url・isMainFrame）を持つ。古い形（位置の引数 url・isInPlace・isMainFrame）も読む
  const fire = (w, kind, details, ...pos) => { let prevented = false; w.ev[kind]({ preventDefault: () => { prevented = true; }, ...details }, ...pos); return prevented; };
  const login = make(loginSes);
  // 許した行き先（本体の枠）: 中継のホストと Access のホストへのフォームの送り・転送は通す
  assert.strictEqual(fire(login, 'will-navigate', { url: `https://${ACCESS}/cdn-cgi/access/login/x`, isMainFrame: true }), false);
  assert.strictEqual(fire(login, 'will-frame-navigate', { url: `https://${ACCESS}/cdn-cgi/access/callback`, isMainFrame: true }), false);
  assert.strictEqual(fire(login, 'will-redirect', { url: `https://${RELAY}/auth/done`, isMainFrame: true }), false);
  assert.deepStrictEqual(blocked, [], '許した行き先を止めた');
  // 許していない行き先（本体の枠）: 止めて loginGuard.blocked に知らせる
  assert.strictEqual(fire(login, 'will-navigate', { url: 'https://evil.example/phish', isMainFrame: true }), true);
  assert.strictEqual(fire(login, 'will-redirect', { url: 'https://proxy.example/blocked?u=1', isMainFrame: true }), true);
  assert.strictEqual(fire(login, 'will-frame-navigate', { url: `http://${RELAY}/auth/done`, isMainFrame: true }), true);
  // 古い形: details に url が無く、位置の引数（url・isInPlace・isMainFrame）で来る
  assert.strictEqual(fire(login, 'will-navigate', {}, 'https://evil.example/old', false, true), true);
  // 中の枠: https は通し（ログインの画面の中の確かめの枠など）、ほかは止める
  assert.strictEqual(fire(login, 'will-frame-navigate', { url: 'https://challenges.cloudflare.com/x', isMainFrame: false }), false);
  assert.strictEqual(fire(login, 'will-frame-navigate', { url: 'http://challenges.example/x', isMainFrame: false }), true);
  assert.strictEqual(fire(login, 'will-frame-navigate', { url: 'javascript:alert(1)', isMainFrame: false }), true);
  // webview と新しい窓は止める
  assert.strictEqual(fire(login, 'will-attach-webview', {}), true);
  assert.deepStrictEqual(login.open(`https://${ACCESS}/`), { action: 'deny' });
  assert.deepStrictEqual(blocked, [
    ['https://evil.example/phish', 'will-navigate', true],
    ['https://proxy.example/blocked?u=1', 'will-redirect', true],
    [`http://${RELAY}/auth/done`, 'will-frame-navigate', true],
    ['https://evil.example/old', 'will-navigate', true],
    ['http://challenges.example/x', 'will-frame-navigate', false],
    ['javascript:alert(1)', 'will-frame-navigate', false],
  ]);
  // ほかの webContents（本体・録音バー・既定の session・同じ名前の別の session の偽物）は、許した行き先でも今のまま必ず止める
  for (const ses of [undefined, { partition: '' }, { partition: 'natsu-access' }]) {
    const w = make(ses);
    for (const kind of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) {
      assert.strictEqual(fire(w, kind, { url: `https://${RELAY}/auth/done`, isMainFrame: true }), true, `${kind} を止めなかった`);
    }
    assert.deepStrictEqual(w.open(`https://${RELAY}/`), { action: 'deny' });
  }
  // isLoginContents が投げたら、ログインの窓とみなさない（必ず止める）
  const appEv2 = {};
  S.install({ app: { on: (ev, f) => { appEv2[ev] = f; } }, session, pages, readFile: () => '',
    isLoginContents: () => { throw new Error('壊れた'); }, loginGuard: { allow: () => true, blocked() {} } });
  const ev2 = {};
  appEv2['web-contents-created']({}, { session: loginSes, on: (e, f) => { ev2[e] = f; }, setWindowOpenHandler() {} });
  let p2 = false;
  ev2['will-navigate']({ preventDefault: () => { p2 = true; }, url: `https://${RELAY}/` });
  assert.strictEqual(p2, true);
  // loginGuard を渡さなければ、ログインの partition でも必ず止める（今までの install の形）
  const appEv3 = {};
  S.install({ app: { on: (ev, f) => { appEv3[ev] = f; } }, session, pages, readFile: () => '', isLoginContents: () => true });
  const ev3 = {};
  appEv3['web-contents-created']({}, { session: loginSes, on: (e, f) => { ev3[e] = f; }, setWindowOpenHandler() {} });
  let p3 = false;
  ev3['will-navigate']({ preventDefault: () => { p3 = true; }, url: `https://${RELAY}/` });
  assert.strictEqual(p3, true);
});
