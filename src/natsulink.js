'use strict';
// 議事録のリンクの形と照らし（0.10.0 Task LN-1。計画 docs/plans/2026-10-20-100.md の決めたこと 142・153・154。D72・D78）。純粋（Node の部品も Electron も読まない）。
// MCP の道具（src/mcp/tools.js の meetingRef と答えの出典）・main（リンクで起こされたとき・画面に貼ったとき・［リンクを写す］の住所の頭）が使う。
//  - natsu://page/<ID>（会議）と natsu://page/<ID>#<印>（印は t:s12-s18・b:<ブロック>・m:<段落>。決めたこと 75 の印と同じ形）。
//    前の形 #<ブロック ID>（設計書の B10）も受けて読み捨てる（会議の全体を指したものとして読む）。
//  - https の住所 <LINK_ORIGIN>/open#p=<ID>（&a=<印>）。# の後ろはブラウザーがサーバーへ送らないので、会議の ID が Worker・Cloudflare・
//    会社の通信の検査の記録に残らない。後の共有のために、知らない鍵（&w=… など）は飛ばして読む（今の鍵の順は決まり: p、あれば a）。
//  - 住所の頭は LINK_ORIGIN の1か所（main の HELP_URL もここから作る）。読むときに受ける頭は LINK_ORIGINS（会社のドメインへ移したら、古い頭を残す）。
// どれも前後の空白を除いた 300 文字まで。ID・印・鍵と値は決まった字（英数字と _ - と印の : ）だけなので、? ・% ・空白・引用符・\ ・制御の文字は
// どこにも入らない（読まない）。末尾の / を1つだけ許す（Windows が足すことがある）。

const LINK_ORIGIN = 'https://natsu-help.natsu-code.workers.dev';
const LINK_ORIGINS = Object.freeze([LINK_ORIGIN]);
const LINK_MAX = 300;
const NATSU_PREFIX = 'natsu://page/';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;   // src/db/validate.js の ID_RE と同じ形
const ANCHOR_RE = /^(?:t:s\d{1,6}-s\d{1,6}|b:[A-Za-z0-9_-]{1,64}|m:\d{1,4})$/;
const LEGACY_RE = /^[A-Za-z0-9_-]{1,64}$/;   // 前の形 #<ブロック ID>（読み捨てる）
const KEY_RE = /^[a-z]{1,16}$/;
const VALUE_RE = /^[A-Za-z0-9_:.-]{0,64}$/;

const okId = (id) => typeof id === 'string' && ID_RE.test(id);
const okAnchor = (a) => a === '' || (typeof a === 'string' && ANCHOR_RE.test(a));

// 照らす前の形: 文字・前後の空白を除く・長さ・末尾の / を1つ外す。だめなら null
function clean(str) {
  if (typeof str !== 'string') return null;
  let t = str.trim();
  if (!t || t.length > LINK_MAX) return null;
  if (t.endsWith('/')) t = t.slice(0, -1);
  return t;
}

function natsuLink(id, anchor = '') {
  if (!okId(id) || !okAnchor(anchor)) return '';
  return anchor ? `${NATSU_PREFIX}${id}#${anchor}` : `${NATSU_PREFIX}${id}`;
}

// → { id, anchor } か null
function parseNatsuLink(str) {
  const t = clean(str);
  if (t === null || !t.startsWith(NATSU_PREFIX)) return null;
  const parts = t.slice(NATSU_PREFIX.length).split('#');
  if (parts.length > 2 || !okId(parts[0])) return null;
  if (parts.length === 1) return { id: parts[0], anchor: '' };
  const frag = parts[1];
  if (ANCHOR_RE.test(frag)) return { id: parts[0], anchor: frag };
  if (LEGACY_RE.test(frag)) return { id: parts[0], anchor: '' };
  return null;
}

function openUrl(id, anchor = '') {
  if (!okId(id) || !okAnchor(anchor)) return '';
  return `${LINK_ORIGIN}/open#p=${id}${anchor ? `&a=${anchor}` : ''}`;
}

// → { id, anchor } か null
function parseOpenUrl(str) {
  const t = clean(str);
  if (t === null) return null;
  const origin = LINK_ORIGINS.find((o) => t.startsWith(`${o}/open#`));
  if (!origin) return null;
  const pairs = t.slice(origin.length + '/open#'.length).split('&');
  const first = pairs[0];
  if (!first.startsWith('p=') || !okId(first.slice(2))) return null;
  let anchor = null;
  for (const pair of pairs.slice(1)) {
    const at = pair.indexOf('=');
    if (at < 0) return null;
    const k = pair.slice(0, at);
    const v = pair.slice(at + 1);
    if (!KEY_RE.test(k)) return null;
    if (k === 'p') return null;
    if (k === 'a') {
      if (anchor !== null || !ANCHOR_RE.test(v)) return null;
      anchor = v;
      continue;
    }
    if (!VALUE_RE.test(v)) return null;   // 知らない鍵は飛ばす（後の共有の &w=<チーム> など）
  }
  return { id: first.slice(2), anchor: anchor || '' };
}

// natsu:// か https の住所のどちらか → { id, anchor } か null（ID だけの文字は null。ID は呼び手が照らす）
function parseAnyLink(str) {
  return parseNatsuLink(str) || parseOpenUrl(str);
}

module.exports = { LINK_ORIGIN, LINK_ORIGINS, LINK_MAX, natsuLink, parseNatsuLink, openUrl, parseOpenUrl, parseAnyLink };
