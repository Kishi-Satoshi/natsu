/*
 * security.js — Electron の守りの判断（第1a回 SEC1。RF19・EL10）
 *
 * ここは Electron を読まない。判断は純粋な関数で、install（Task 3-2）は main から受け取った
 * app と session に受け口を付けるだけ（electron は main が渡す）。
 * 窓の種類・許可の頼みと確かめ・CSP・新しい窓の扱いを決める。
 *
 * 出典（Electron 44 の公式の文書。https://github.com/electron/electron/blob/44-x-y/docs/ の下）:
 *  - tutorial/security.md の「4. Enable process sandboxing」「5. Handle session permission requests
 *    from remote content」「7. Define a Content Security Policy」「13. Disable or limit navigation」
 *    「14. Disable or limit creation of new windows」。
 *  - api/session.md の ses.setPermissionRequestHandler（details.mediaTypes）と
 *    ses.setPermissionCheckHandler（details.mediaType）。
 *  - breaking-changes.md の 45.0: 画面の取り込み（getDisplayMedia）の許可は 'display-capture' で届く。
 *  - api/web-request.md の onHeadersReceived（responseHeaders を返すと、その見出しで読み込む）、
 *    api/app.md の 'web-contents-created'、api/web-contents.md の 'will-navigate'・'will-frame-navigate'・
 *    'will-attach-webview' と setWindowOpenHandler。
 *
 * 作業環境（Linux・Electron 44.9.0・偽のマイク）で確かめたこと:
 *  - 44 の getDisplayMedia は、頼みの受け口に 'media'（mediaTypes が空）として先に届く。
 *    断ると setDisplayMediaRequestHandler は呼ばれない。だから空の media は録音バーだけに許す。
 *  - enumerateDevices の確かめは 'media'（mediaType が 'audio'・'video'）と 'speaker-selection'。
 *    'media' の 'audio' だけを許すと、マイクとスピーカーの両方の名前が出て、カメラの名前は出ない。
 *    全部断ると名前が空になる（RF19）。'speaker-selection' は許さなくてよい。
 *
 * 第1d回 A-11（F25・F20）: ログインの窓（Cloudflare Access のログインの画面を出す BrowserWindow。partition は natsu-access）だけは、
 * 全体の「必ず止める」の代わりに、main が渡す loginGuard で行き先を決める（そのままではログインの画面のフォームの送り
 * ［Send login code］・［Sign in］が止まり、ログインが終わらない）。どの webContents がログインの窓かは main の isLoginContents（session で見る）。
 *  - 本体の枠の will-navigate・will-frame-navigate・will-redirect: loginGuard.allow(url) が真のときだけ通す（中継のホストか <チーム>.cloudflareaccess.com）
 *  - 中の枠の will-frame-navigate: https のほかは止める（ログインの画面の中の確かめの枠は通す）
 *  - will-attach-webview と新しい窓（setWindowOpenHandler）は、ほかの窓と同じく止める
 *  - 止めたら loginGuard.blocked(url, { kind, isMainFrame }) を呼ぶ（main は記録1行と、本体の枠なら窓を閉じる）。本体の枠の同じ行き先を
 *    1秒の内に続けて止めたとき（1つの移動の will-frame-navigate と will-navigate）は1回だけ
 *  資料: api/web-contents.md の 'will-navigate'・'will-frame-navigate'・'will-redirect'（44 は details に url・isMainFrame を持つ。
 *  古い位置の引数 url・isInPlace・isMainFrame も読む）
 *
 * CSP のハッシュ:
 *  - HTML は読み込むときに CRLF と CR を LF にそろえる
 *    （https://html.spec.whatwg.org/multipage/parsing.html#preprocessing-the-input-stream）。
 *    画面が実行するのはそろえた後の中身なので、ハッシュもそろえた中身で取る。
 *  - ハッシュの形は 'sha256-<base64>'（https://w3c.github.io/webappsec-csp/#grammardef-hash-source）。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** 種類の無い file:// と、HTML を読めないときの一番きつい CSP */
const STRICT_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'";

const PAGE_KINDS = ['app', 'overlay'];

/**
 * file: の URL を比べる形にする（search と hash は落とす）。file: でない・読めないときは ''。
 * win32 ではドライブと大文字・小文字を区別しないので小文字にそろえる。
 */
function fileKey(url, platform) {
  if (typeof url !== 'string' || !url) return '';
  let u;
  try { u = new URL(url); } catch { return ''; }
  if (u.protocol !== 'file:') return '';
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { return ''; }
  const key = `${u.host}${p}`;
  return platform === 'win32' ? key.toLowerCase() : key;
}

/** 窓の種類 → 'app' | 'overlay' | '' */
function pageKind(url, pageUrls, platform = process.platform) {
  const key = fileKey(url, platform);
  if (!key || !pageUrls) return '';
  for (const kind of PAGE_KINDS) {
    if (fileKey(pageUrls[kind], platform) === key) return kind;
  }
  return '';
}

const isPage = (kind) => kind === 'app' || kind === 'overlay';

/** setPermissionRequestHandler の判断（既定は断る） */
function allowRequest(kind, permission, details = {}) {
  const d = details || {};
  if (permission === 'media') {
    const types = d.mediaTypes;
    if (!Array.isArray(types)) return false;
    // 44 の画面の取り込みは mediaTypes が空で届く → 録音バーだけ
    if (types.length === 0) return kind === 'overlay';
    // マイク（音だけ）→ 本体と録音バー。映像が1つでも混じれば断る
    return types.every((t) => t === 'audio') && isPage(kind);
  }
  // 45 からの画面の取り込み → 録音バーだけ
  if (permission === 'display-capture') return kind === 'overlay';
  return false;
}

/** setPermissionCheckHandler の判断（既定は断る） */
function allowCheck(kind, permission, details = {}) {
  const d = details || {};
  if (permission === 'media') return d.mediaType === 'audio' && isPage(kind);
  if (permission === 'display-capture') return kind === 'overlay';
  return false;
}

// <script …>中身</script>。閉じが無ければ文書の終わりまでが中身（HTML の読み方と同じ）
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)(?:<\/script(?=[\s/>])|$)/gi;
const SRC_ATTR_RE = /(?:^|\s)src\s*=/i;

/** src の無い <script> ごとに 'sha256-…'（中身の CRLF・CR を LF にそろえてから） */
function inlineScriptHashes(html) {
  if (typeof html !== 'string') return [];
  const out = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    if (SRC_ATTR_RE.test(m[1])) continue;
    const body = m[2].replace(/\r\n?/g, '\n');
    out.push(`'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return out;
}

/** 画面の HTML に付ける CSP（インラインの script のハッシュだけを許す） */
function cspFor(html) {
  if (typeof html !== 'string') return STRICT_CSP;
  const hashes = [...new Set(inlineScriptHashes(html))];
  return [
    "default-src 'none'",
    `script-src ${hashes.length ? hashes.join(' ') : "'none'"}`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'media-src blob: mediastream:',
    "connect-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
  ].join('; ');
}

/** setWindowOpenHandler の判断: 新しい窓は開かない */
function windowOpen() { return { action: 'deny' }; }

const prevent = (e) => { e.preventDefault(); };

/**
 * ログインの窓の移動の出来事 → { url, isMainFrame }。44 の details（e.url・e.isMainFrame）を先に読み、無ければ古い位置の引数
 * （will-navigate・will-redirect の url・isInPlace・isMainFrame）。will-frame-navigate は details だけ。分からなければ本体の枠とみなす（きつい側）
 */
function navDetails(kind, e, pos) {
  const d = e && typeof e === 'object' ? e : {};
  const url = typeof d.url === 'string' ? d.url : (typeof pos[0] === 'string' ? pos[0] : '');
  let isMainFrame = true;
  if (typeof d.isMainFrame === 'boolean') isMainFrame = d.isMainFrame;
  else if (kind !== 'will-frame-navigate' && typeof pos[2] === 'boolean') isMainFrame = pos[2];
  return { url, isMainFrame };
}

/** ログインの窓の行き先の判断（純粋）: 本体の枠は allow(url)、中の枠は https だけ */
function loginNavOk({ url, isMainFrame }, allow) {
  if (isMainFrame) {
    try { return allow(url) === true; } catch { return false; }
  }
  try { return new URL(String(url)).protocol === 'https:'; } catch { return false; }
}

// ログインの窓の守り（第1d回 A-11）。止めたら loginGuard.blocked に知らせる（投げても止めたまま）。
// 44 では本体の枠の1つの移動で will-frame-navigate と will-navigate の両方が来るので、本体の枠の同じ行き先を続けて止めたときは
// 知らせを1回にする（止めるのはどちらも。A-11 の点検: engine.log の行が2つにならない）
const SAME_NAV_MS = 1000;
function guardLogin(wc, loginGuard) {
  let lastMain = { url: null, at: 0 };
  for (const kind of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    wc.on(kind, (e, ...pos) => {
      const d = navDetails(kind, e, pos);
      if (loginNavOk(d, loginGuard.allow)) return;
      e.preventDefault();
      if (d.isMainFrame) {
        const now = Date.now();
        if (lastMain.url === d.url && now - lastMain.at < SAME_NAV_MS) return;
        lastMain = { url: d.url, at: now };
      }
      try { loginGuard.blocked(d.url, { kind, isMainFrame: d.isMainFrame }); } catch { /* 止めたまま */ }
    });
  }
  wc.on('will-attach-webview', prevent);
  wc.setWindowOpenHandler(windowOpen);
}

/** 受け口が渡す webContents の URL（無い・投げるときは ''） */
function wcUrl(wc) {
  try { return wc && typeof wc.getURL === 'function' ? String(wc.getURL() || '') : ''; } catch { return ''; }
}

/**
 * 守りを1度に付ける（main は窓を作る前に呼ぶ）。
 * pages = { app: '<絶対パス>', overlay: '<絶対パス>' }。
 * CSP はその時のファイルから毎回計算する（自動更新で src/ が入れ替わってもハッシュがずれない）。
 * 読めなければゆるめずに STRICT_CSP を付け、log に理由の符号とファイルの名前だけを書く。
 */
function install({ app, session, pages, readFile = (p) => fs.readFileSync(p, 'utf8'), log = () => {}, isLoginContents = () => false, loginGuard = null }) {
  const pageUrls = {};
  for (const k of PAGE_KINDS) pageUrls[k] = pathToFileURL(pages[k]).href;
  const kindOf = (url) => pageKind(url, pageUrls);

  session.setPermissionRequestHandler((wc, permission, cb, details) => {
    const d = details || {};
    cb(allowRequest(kindOf(d.requestingUrl || wcUrl(wc)), permission, d));
  });
  session.setPermissionCheckHandler((wc, permission, _origin, details) => {
    const d = details || {};
    return allowCheck(kindOf(d.requestingUrl || wcUrl(wc) || ''), permission, d);
  });

  session.webRequest.onHeadersReceived({ urls: ['file://*/*'] }, (d, cb) => {
    if (!d || (d.resourceType !== 'mainFrame' && d.resourceType !== 'subFrame')) { cb({}); return; }
    const kind = kindOf(d.url);
    let csp = STRICT_CSP;
    if (kind) {
      try {
        csp = cspFor(readFile(pages[kind]));
      } catch (e) {
        csp = STRICT_CSP;
        log(`CSP: 画面のファイルを読めないため一番きつい CSP にしました（${path.basename(pages[kind])}・${(e && e.code) || 'read'}）`);
      }
    }
    cb({ responseHeaders: { ...(d.responseHeaders || {}), 'Content-Security-Policy': [csp] } });
  });

  app.on('web-contents-created', (_e, wc) => {
    // ログインの窓（第1d回 A-11）だけは許した行き先を通す。決められない・投げるときは、ほかの窓と同じく必ず止める
    let login = false;
    try { login = Boolean(loginGuard) && isLoginContents(wc) === true; } catch { login = false; }
    if (login) { guardLogin(wc, loginGuard); return; }
    wc.on('will-navigate', prevent);
    wc.on('will-frame-navigate', prevent);
    wc.on('will-attach-webview', prevent);
    wc.setWindowOpenHandler(windowOpen);
  });

  return { kindOf };
}

module.exports = { pageKind, allowRequest, allowCheck, inlineScriptHashes, cspFor, STRICT_CSP, windowOpen, loginNavOk, install };
