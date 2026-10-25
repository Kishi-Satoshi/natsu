/*
 * stage101.mcp.app.test.js — 0.10.1 の設定のカード「Claude との連携（MCP）」の新しい文（計画 docs/plans/2026-10-23-101.md の Task CD-3。D84・D85・D90）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。main の答えは偽物。
 * RN1（動いていたので断った）・RN2（確かめられなかったので断った）・RN3（開いたときに動いている）・RN5（確かめられないまま2回目で変えた）。
 */
'use strict';
const { titleAt } = require('./helpers/titles');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { parseHTML } = require('./helpers/simdom');
const lib = require('../src/mainlib');
const cli = require('../src/claude-cli');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const html = fs.readFileSync(APP, 'utf8');
const doc = parseHTML(html).root;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const LIST = [{ id: 'pa1', title: titleAt('2026-10-16T01:00:00.000Z'), date: '10/16', durationSec: 1800, hasSummary: true }];
const PAGE = (id) => ({ page: { id, title: titleAt('2026-10-16T01:00:00.000Z'), createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
const UI = () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' } });
const ST = (state, running = false) => ({ desktop: { state, files: state === 'noclaude' ? 0 : 1, running } });
const open = (o = {}) => load(APP, { preloadSrc: PRELOAD, html, returns: { pagesSearch: () => LIST, pageGet: PAGE, uiState: UI, openHelp: () => true, mcpStatus: () => ST('none'), ...o } });
const $ = (l, id) => l.document.getElementById(id);
const click = async (l, el) => { (typeof el === 'string' ? $(l, el) : el).dispatchEvent({ type: 'click' }); await l.drain(); };
const pick = async (l, sec) => { const nav = $(l, 'setNav'); nav.dispatchEvent({ type: 'click', target: nav.querySelector(`[data-sec="${sec}"]`) }); await l.drain(); };
const search = async (l, q) => { const b = $(l, 'setSearch'); b.value = q; b.dispatchEvent({ type: 'input', target: b }); await l.drain(); };
const settingsOpen = (l) => $(l, 'settingsModal').hidden === false;
const visible = (el) => { for (let n = el; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) { if (n.id === 'settingsModal') return true; if (n.hidden || n.classList.contains('set-miss')) return false; } return true; };
const shownRows = (l) => l.byId.get('tabSettings').querySelectorAll('[data-row]').filter(visible).map((r) => r.dataset.row);
const openSummary = async (o) => { const l = await open(o); await l.drain(); await click(l, 'tabBtnSettings'); await pick(l, 'summary'); return l; };


const RN1 = 'Claude デスクトップが動いているため、登録を変えませんでした。Claude デスクトップを終了してから、もう一度押してください（タスクトレイのアイコンからも終了してください）。';
const RN2 = 'Claude デスクトップが動いているか確かめられませんでした。Claude デスクトップを終了してから、もう一度押してください（タスクトレイのアイコンからも終了してください）。';
const RN3 = 'Claude デスクトップが動いています。登録や外すときは、タスクトレイのアイコンからも終了してから押してください。';
const RN5 = 'Claude デスクトップが動いているか確かめられないまま、登録を変えました。Claude デスクトップが動いていたら、タスクトレイのアイコンからも終了してから起動し直してください。';

test('0.10.1 CD-3・D84: 押して running で断られたら #mcpMsg は RN1 だけ（RN3 を頭に重ねない）。登録でも外すでも。ボタンは押せるまま', T, async () => {
  const l = await openSummary({ mcpStatus: () => ST('none', true), mcpRegister: () => ({ ok: false, state: 'none', code: 'running', running: true }) });
  assert.strictEqual($(l, 'mcpMsg').textContent, RN3, '開いたときに動いていれば RN3');
  assert.strictEqual($(l, 'mcpRegister').disabled, false, '動いているときに押せない');
  await click(l, 'mcpRegister');
  assert.strictEqual($(l, 'mcpMsg').textContent, RN1);
  assert.strictEqual($(l, 'mcpRegister').disabled, false);
  const u = await openSummary({ mcpStatus: () => ST('same', true), mcpUnregister: () => ({ ok: false, state: 'same', code: 'running', running: true }) });
  await click(u, 'mcpUnregister');
  assert.strictEqual($(u, 'mcpMsg').textContent, RN1);
});

test('0.10.1 CD-3・D85: unknown で断られたら RN2 だけ。2回目で書いた答え（unverified）なら RN5 だけ（登録でも外すでも）', T, async () => {
  let n = 0;
  const l = await openSummary({ mcpStatus: () => ST(n ? 'same' : 'none'), mcpRegister: () => (n++ === 0 ? { ok: false, state: 'none', code: 'unknown', running: null } : { ok: true, state: 'same', running: null, unverified: true }) });
  await click(l, 'mcpRegister');
  assert.strictEqual($(l, 'mcpMsg').textContent, RN2);
  await click(l, 'mcpRegister');
  assert.strictEqual($(l, 'mcpMsg').textContent, RN5);
  const u = await openSummary({ mcpStatus: () => ST('same'), mcpUnregister: () => ({ ok: true, state: 'none', running: null, unverified: true }) });
  await click(u, 'mcpUnregister');
  assert.strictEqual($(u, 'mcpMsg').textContent, RN5);
});

test('0.10.1 点検の直し R8: どこかのファイルに NaTsu の natsu が残っていれば（hasEntry）、状態が none・gone でも［登録を外す］を出す（外し直せる）', T, async () => {
  for (const state of ['none', 'gone']) {
    const l = await openSummary({ mcpStatus: () => ({ desktop: { state, files: 2, running: false, hasEntry: true } }) });
    assert.strictEqual($(l, 'mcpUnregister').hidden, false, state);
    const n = await openSummary({ mcpStatus: () => ({ desktop: { state, files: 2, running: false, hasEntry: false } }) });
    assert.strictEqual($(n, 'mcpUnregister').hidden, true, state);
  }
});
