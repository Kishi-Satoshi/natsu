/*
 * security.js — Electron の守りの判断（第1a回 SEC1。RF19・EL10）
 *
 * ここは Electron を読まない純粋な関数だけを置く（取り付けの install は Task 3-2）。
 * 窓の種類・許可の頼みと確かめ・CSP・新しい窓の扱いを決める。
 *
 * 出典（Electron 44 の公式の文書。https://github.com/electron/electron/blob/44-x-y/docs/ の下）:
 *  - tutorial/security.md の「4. Enable process sandboxing」「5. Handle session permission requests
 *    from remote content」「7. Define a Content Security Policy」「13. Disable or limit navigation」
 *    「14. Disable or limit creation of new windows」。
 *  - api/session.md の ses.setPermissionRequestHandler（details.mediaTypes）と
 *    ses.setPermissionCheckHandler（details.mediaType）。
 *  - breaking-changes.md の 45.0: 画面の取り込み（getDisplayMedia）の許可は 'display-capture' で届く。
 *
 * 作業環境（Linux・Electron 44.9.0・偽のマイク）で確かめたこと:
 *  - 44 の getDisplayMedia は、頼みの受け口に 'media'（mediaTypes が空）として先に届く。
 *    断ると setDisplayMediaRequestHandler は呼ばれない。だから空の media は録音バーだけに許す。
 *  - enumerateDevices の確かめは 'media'（mediaType が 'audio'・'video'）と 'speaker-selection'。
 *    'media' の 'audio' だけを許すと、マイクとスピーカーの両方の名前が出て、カメラの名前は出ない。
 *    全部断ると名前が空になる（RF19）。'speaker-selection' は許さなくてよい。
 *
 * CSP のハッシュ:
 *  - HTML は読み込むときに CRLF と CR を LF にそろえる
 *    （https://html.spec.whatwg.org/multipage/parsing.html#preprocessing-the-input-stream）。
 *    画面が実行するのはそろえた後の中身なので、ハッシュもそろえた中身で取る。
 *  - ハッシュの形は 'sha256-<base64>'（https://w3c.github.io/webappsec-csp/#grammardef-hash-source）。
 */
'use strict';

const crypto = require('node:crypto');

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

module.exports = { pageKind, allowRequest, allowCheck, inlineScriptHashes, cspFor, STRICT_CSP, windowOpen };
