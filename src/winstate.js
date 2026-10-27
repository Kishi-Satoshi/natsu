/*
 * winstate.js — 画面の覚え書き（window-state.json）の照らし（第1b回 N6）
 *
 * 窓の大きさと位置・最大化・拡大の倍率・サイドバーの幅と畳み・開いているタブを
 * 起動をまたいで覚える。ここは「読んだ値が使えるか」を決める純粋な関数だけを持ち、
 * Electron は読まない（main が screen・BrowserWindow の値を渡す）。
 * 読み書きは main が第1a回の部品（J.loadJsonFile・J.makeBatchWriter）で行う。
 *
 * 守ること（設計書 N6・Review Focus F1・F2・F4・F7）:
 *   - 置き場所は %LOCALAPPDATA%\natsu（Roaming の userData に置かない）
 *   - 大きさは整数で 820×560 以上・MAX_EDGE 以下。外れたら既定の大きさと位置なし（真ん中）
 *   - 位置は、今つながっている画面のどれかの作業領域に 120×40 以上重なるときだけ戻す
 *     （2つ目の画面を外した・解像度を変えた後に、見えない所へ出さない）
 *   - 覚えるのは getNormalBounds（最小化中の -32000 や、最大化中の大きさを残さない）
 *   - 拡大は決まった段の上だけ（200% で止まる）。JIS の Ctrl+；（＋の刻印のキー）も拡大
 *   - タブは形の正しい鍵だけ。録音中のページ（live）は覚えない。無いページは外す
 *   - 0.9.0 U-1（SP3・D24）: 設定はタブでなくポップアップで開くので、前の版が覚えた settings は黙って落とす
 *     （無いページとして数えない。数えると main が「無いページのタブを N 個外した」と事実と違う記録を書く）
 *
 * 壊れた項目だけを既定に戻し、ほかの項目は残す。v が 1 でなくても読めるものは読む
 * （後の版の覚え書きを古い版で開いても落ちない）。
 */
'use strict';

const path = require('path');
const blockEdit = require('./blockEdit');   // 0.13.0 ED-5（EQ8 (b)）: / メニューの「最近使ったもの」の照らし（recentCheck）

const DEFAULT_SIZE = { width: 1120, height: 780 };
const MIN_SIZE = { width: 820, height: 560 };
const MAX_EDGE = 16384;
const VISIBLE_MIN = { width: 120, height: 40 };
const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const SIDEBAR = { min: 200, max: 480, width: 260 };
const MAX_TABS = 20;

const TAB_PAGE_RE = /^page:p[a-z0-9]{1,40}$/;
const TAB_FIXED = ['dictation'];
const TAB_RETIRED = 'settings';   // 0.8.0 までの設定のタブ（読むときに黙って落とす）

function isObj(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function statePath(env, userData) {
  const local = env && typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA : '';
  if (local && path.isAbsolute(local)) {
    return { file: path.join(local, 'natsu', 'window-state.json'), local: true };
  }
  return { file: path.join(String(userData || ''), 'window-state.json'), local: false };
}

function defaults() {
  return {
    v: 1,
    bounds: { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height },
    maximized: false,
    zoom: 1,
    sidebar: { width: SIDEBAR.width, collapsed: false },
    tabs: { open: [], active: '' },
    slashRecent: [],   // 0.13.0 ED-5（決めたこと 37〜40）: / メニューで選んだ鍵だけ（新しい順に3つまで。会議の題名・行の文・ID は持たない）
  };
}

function shapeOk(v) {
  return isObj(v);
}

function sizeOk(n, min) {
  return Number.isInteger(n) && n >= min && n <= MAX_EDGE;
}

function onScreen(bounds, displays) {
  if (!isObj(bounds)) return false;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(Number.isFinite)) return false;
  if (!Array.isArray(displays)) return false;
  for (const d of displays) {
    const wa = d && d.workArea;
    if (!wa || ![wa.x, wa.y, wa.width, wa.height].every(Number.isFinite)) continue;
    const w = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x);
    const h = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y);
    if (w >= VISIBLE_MIN.width && h >= VISIBLE_MIN.height) return true;
  }
  return false;
}

// 大きさと位置。位置が無い（x・y のどちらも無い）ものは大きさだけ残す（真ん中に出す）
function normBounds(b, displays) {
  if (!isObj(b)) return null;
  if (!sizeOk(b.width, MIN_SIZE.width) || !sizeOk(b.height, MIN_SIZE.height)) return null;
  if (b.x === undefined && b.y === undefined) return { width: b.width, height: b.height };
  if (!Number.isInteger(b.x) || !Number.isInteger(b.y)) return null;
  const out = { x: b.x, y: b.y, width: b.width, height: b.height };
  return onScreen(out, displays) ? out : null;
}

function clampWidth(n) {
  return Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, Math.round(n)));
}

function normSidebar(s) {
  const d = defaults().sidebar;
  if (!isObj(s)) return d;
  return {
    width: Number.isFinite(s.width) ? clampWidth(s.width) : d.width,
    collapsed: typeof s.collapsed === 'boolean' ? s.collapsed : d.collapsed,
  };
}

function tabKeyOk(k) {
  return typeof k === 'string' && (TAB_PAGE_RE.test(k) || TAB_FIXED.includes(k));
}

// 鍵の形・重なり・数で照らす。exists が渡れば、ページのタブはそのページが在るときだけ残す
function filterTabs(tabs, exists) {
  if (!isObj(tabs) || !Array.isArray(tabs.open)) return { tabs: { open: [], active: '' }, dropped: 0 };
  const open = [];
  let dropped = 0;
  for (const k of tabs.open) {
    if (k === TAB_RETIRED) continue;
    let keep = tabKeyOk(k) && !open.includes(k) && open.length < MAX_TABS;
    if (keep && exists && k.startsWith('page:')) {
      try { keep = Boolean(exists(k.slice('page:'.length))); } catch (_) { keep = false; }
    }
    if (keep) open.push(k);
    else dropped += 1;
  }
  const active = open.includes(tabs.active) ? tabs.active : (open.length ? open[open.length - 1] : '');
  return { tabs: { open, active }, dropped };
}

function keepTabs(tabs, exists) {
  return filterTabs(tabs, typeof exists === 'function' ? exists : () => false);
}

function sameSidebar(a, raw) {
  return isObj(raw) && raw.width === a.width && raw.collapsed === a.collapsed;
}

function sameTabs(a, raw) {
  return isObj(raw) && Array.isArray(raw.open) && raw.active === a.active
    && raw.open.length === a.open.length && raw.open.every((k, i) => k === a.open[i]);
}

function normalize(raw, displays) {
  const state = defaults();
  const repaired = [];
  if (!shapeOk(raw)) return { state, repaired };

  if (raw.bounds !== undefined) {
    const b = normBounds(raw.bounds, displays);
    if (b) state.bounds = b;
    else repaired.push('bounds');
  }
  if (raw.zoom !== undefined) {
    if (typeof raw.zoom === 'number' && ZOOM_STEPS.includes(raw.zoom)) state.zoom = raw.zoom;
    else repaired.push('zoom');
  }
  if (raw.sidebar !== undefined) {
    state.sidebar = normSidebar(raw.sidebar);
    if (!sameSidebar(state.sidebar, raw.sidebar)) repaired.push('sidebar');
  }
  if (raw.tabs !== undefined) {
    const t = filterTabs(raw.tabs, null);
    state.tabs = t.tabs;
    if (!sameTabs(t.tabs, raw.tabs)) repaired.push('tabs');
  }
  if (raw.maximized !== undefined) {
    if (typeof raw.maximized === 'boolean') state.maximized = raw.maximized;
    else repaired.push('maximized');
  }
  if (raw.slashRecent !== undefined) {
    state.slashRecent = blockEdit.recentCheck(raw.slashRecent);
    if (JSON.stringify(state.slashRecent) !== JSON.stringify(raw.slashRecent)) repaired.push('slashRecent');
  }
  return { state, repaired };
}

function boundsOf(win) {
  const b = win && typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : null;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}

function zoomDir(input) {
  if (!input || input.type !== 'keyDown' || !input.control || input.alt || input.meta) return null;
  const key = input.key;
  const code = input.code;
  if (key === '=' || key === '+' || key === ';' || code === 'NumpadAdd') return 'in';
  if (key === '-' || code === 'NumpadSubtract') return 'out';
  if ((key === '0' && !input.shift) || code === 'Numpad0') return 'reset';   // 0.13.0 ED-7（決めたこと 27）: Ctrl+Shift+0 は要約の行の「テキスト」の近道（拡大を戻さない）
  return null;
}

function stepZoom(z, dir) {
  if (dir === 'reset') return 1;
  let i = ZOOM_STEPS.indexOf(z);
  if (i < 0) i = ZOOM_STEPS.indexOf(1);
  if (dir === 'in') i = Math.min(i + 1, ZOOM_STEPS.length - 1);
  else if (dir === 'out') i = Math.max(i - 1, 0);
  return ZOOM_STEPS[i];
}

function copyState(s) {
  return JSON.parse(JSON.stringify(s));
}

function applyUi(state, patch) {
  const next = copyState(state);
  if (!isObj(patch)) return next;
  if (isObj(patch.sidebar)) {
    const cur = normSidebar(next.sidebar);
    if (Number.isFinite(patch.sidebar.width)) cur.width = clampWidth(patch.sidebar.width);
    if (typeof patch.sidebar.collapsed === 'boolean') cur.collapsed = patch.sidebar.collapsed;
    next.sidebar = cur;
  }
  if (isObj(patch.tabs) && Array.isArray(patch.tabs.open)) {
    next.tabs = filterTabs(patch.tabs, null).tabs;
  }
  if (patch.slashRecent !== undefined) next.slashRecent = blockEdit.recentCheck(patch.slashRecent);
  return next;
}

module.exports = {
  DEFAULT_SIZE, MIN_SIZE, MAX_EDGE, VISIBLE_MIN, ZOOM_STEPS, SIDEBAR, MAX_TABS,
  statePath, defaults, shapeOk, normalize, onScreen, boundsOf,
  zoomDir, stepZoom, tabKeyOk, keepTabs, applyUi,
};
