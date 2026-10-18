/*
 * stage1b2.rec.test.js — 第1b2回の設定と音声入力（題名のある平らなページ）と録音中のページ（会議のブロックの記録の行）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { parseHTML } = require('./helpers/simdom');
const S = require('./helpers/simcss');
const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const html = fs.readFileSync(APP, 'utf8');
const doc = parseHTML(html).root;
const rules = S.parse(doc.querySelectorAll('style').map((s) => s._raw).join('\n'));

test('1b2 R-1: 設定と音声入力はページの題名を持ち、設定の見出しは 16px の文字の色（小さな灰色の見出しではない）。<h2> の並びは今のまま', () => {
  // simdom の文字の節は tagName が '#text'（空白も節になる）。要素だけを見る
  assert.deepStrictEqual(['#tabSettings', '#tabDictation'].map((s) => doc.querySelector(`${s} .scroll`).childNodes.find((n) => n.tagName && !n.tagName.startsWith('#')).className), ['stitle', 'stitle']);
  assert.deepStrictEqual(doc.querySelectorAll('.stitle').map((h) => h.textContent), ['音声入力', '設定']);
  const h2 = S.declsFor(rules, '.card h2', { at: '' });
  assert.deepStrictEqual([h2['font-size'], h2.color], ['16px', 'var(--text)']);
  assert.strictEqual(S.declsFor(rules, '.stitle', { at: '' })['font-size'], '32px');
});

test('1b2 R-1: トグルの行は文字が左・トグルが右。数の札は線を持たない', () => {
  const c = S.declsFor(rules, '.check', { at: '' });
  assert.deepStrictEqual([c['flex-direction'], c['justify-content']], ['row-reverse', 'space-between']);
  const st = S.declsFor(rules, '.stat', { at: '' });
  assert.ok(!st.border || /none/.test(st.border), st.border);
});

const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const preloadWith = (...names) => names.reduce((src, n) => (new RegExp(`^\\s+${n}\\s*:`, 'm').test(src) ? src
  : src.replace("exposeInMainWorld('koeApp', {", `exposeInMainWorld('koeApp', {\n  ${n}: (...a) => ipcRenderer.invoke('test:${n}', ...a),`)), PRELOAD);
const LIST = [{ id: 'pb2', title: '設計の打ち合わせ（見本）', date: '2026-10-15', durationSec: 900, hasSummary: false }];
const PAGE = (id) => ({ page: { id, title: '設計の打ち合わせ（見本）', createdAt: '2026-10-15T01:00:00.000Z', durationSec: 900, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
const ST = (o = {}) => ({ active: true, finalizing: false, startedAt: Date.now() - 60000, segments: [{ atMs: 0, text: '始めます（見本）' }], pending: 0, pauses: [], cloud: true, ...o });

test('1b2 R-2・G9: 記録の行（#liveBar）は会議のブロックの頭（丸いタブの前）にあり、［この会議は PC の中だけ］が見える', async () => {
  const l = await load(APP, { preloadSrc: preloadWith('meetingSetPaused'), returns: { pagesSearch: () => LIST, pageGet: PAGE } });
  await l.drain();
  l.fire('onMeetingUpdate', ST()); await l.drain();
  const live = l.byId.get('liveBar') || l.document.getElementById('liveBar');
  const mb = live.parentNode;
  assert.ok(mb.className.split(' ').includes('mblock'), '記録の行が会議のブロックの中に無い');
  const kids = mb.childNodes.filter((n) => n.tagName && !n.tagName.startsWith('#'));
  assert.ok(kids.indexOf(live) < kids.findIndex((n) => (n.className || '').split(' ').includes('ptabs')), '記録の行が丸いタブより下');
  assert.strictEqual(l.document.getElementById('meetingLocalOnly').hidden, false);
  assert.strictEqual(S.declsFor(rules, '#liveStopBtn', { at: '' }).color, 'var(--danger)');
});

test('1b2 R-2・G10: 記録中の題名は「記録中の会議」で編集できない。ページに替わったら、そのページの題名で編集できる', async () => {
  const l = await load(APP, { preloadSrc: preloadWith('meetingSetPaused'), returns: { pagesSearch: () => LIST, pageGet: PAGE } });
  await l.drain();
  l.fire('onMeetingUpdate', ST()); await l.drain();
  const t = l.byId.get('pTitle');
  assert.deepStrictEqual([t.textContent, t.getAttribute('contenteditable')], ['記録中の会議', 'false']);
  assert.ok(l.byId.get('pageWrap').classList.contains('live-on'));
  l.fire('onMeetingUpdate', { active: false, finalizing: false, segments: [], pending: 0 });
  l.fire('onPageOpen', 'pb2'); await l.drain();
  assert.deepStrictEqual([t.textContent, t.getAttribute('contenteditable')], ['設計の打ち合わせ（見本）', 'true']);
  assert.ok(!l.byId.get('pageWrap').classList.contains('live-on'));
});
