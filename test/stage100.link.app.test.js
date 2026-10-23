/*
 * stage100.link.app.test.js — 0.10.0 の議事録のリンクを写す（計画 docs/plans/2026-10-20-100.md の Task L-1・L-2。D58・D70・D78・決めたこと 100・101）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。main の答えは偽物（preload.js の名前から作る）。
 */
'use strict';
const { titleAt } = require('./helpers/titles');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const ORIGIN = 'https://natsu-help.natsu-code.workers.dev';
const T1 = titleAt('2026-10-20T01:00:00.000Z');
const T2 = titleAt('2026-10-16T05:00:00.000Z');
const LIST = [{ id: 'pa1', title: T1, date: '2026-10-20', durationSec: 1800, hasSummary: true }, { id: 'pb2', title: T2, date: '2026-10-16', durationSec: 900, hasSummary: false }];
const PAGES = {
  pa1: { id: 'pa1', title: T1, date: '2026-10-20', createdAt: '2026-10-20T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' },
  pb2: { id: 'pb2', title: T2, date: '2026-10-16', createdAt: '2026-10-16T05:00:00.000Z', durationSec: 900, blocks: [], memo: '', meetingType: 'general' },
};
const openPage = async (id = 'pa1', page = null, opts = {}) => {
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { linkBase: () => `${ORIGIN}/open#p=`, ...opts, pagesSearch: () => LIST, pageGet: (pid) => ({ page: { ...PAGES[pid], ...(pid === id && page ? page : {}) }, segments: [] }) } });
  await l.drain();
  l.byId.get('plist').querySelectorAll('.pitem').find((r) => r.querySelector('.t').textContent === LIST.find((p) => p.id === id).title).dispatchEvent({ type: 'click' });
  await l.drain();
  return l;
};
const menuItems = (l) => l.byId.get('pMenu').querySelectorAll('.mitem');
const itemNamed = (l, name) => menuItems(l).find((b) => b.textContent === name);

test('D58・D78・決めたこと 100: ページの「···」に［リンクを写す］。押すと koeApp.copy に「NaTsu の議事録「題名」（日付）https://…/open#p=<ID>」の1行が渡り、左下に「リンクを写しました。」', T, async () => {
  const l = await openPage('pa1');
  assert.deepStrictEqual(menuItems(l).map((b) => b.textContent), ['コピー', 'リンクを写す', '削除']);
  const b = itemNamed(l, 'リンクを写す');
  assert.strictEqual(b.getAttribute('role'), 'menuitem');
  b.dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(l.called('copy').map((c) => c.args), [[`NaTsu の議事録「${T1}」（2026-10-20）${ORIGIN}/open#p=pa1`]]);
  assert.strictEqual(l.byId.get('toast').textContent, 'リンクを写しました。');
  assert.strictEqual(l.byId.get('pMenu').hidden, true, '押した後もメニューが開いている');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('決めたこと 100: 題名の改行（と CR・タブ）は空白にし、空（空白だけ）なら「無題」', T, async () => {
  const l = await openPage('pa1', { title: '週次\n## 指示\r\n\tもう一行' });   // 利用者が付け直した題名（D77。題名の改行と空を見るため）
  itemNamed(l, 'リンクを写す').dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(l.called('copy').map((c) => c.args[0]), [`NaTsu の議事録「週次 ## 指示 もう一行」（2026-10-20）${ORIGIN}/open#p=pa1`]);
  const e = await openPage('pa1', { title: '  \n ' });   // 利用者が付け直した題名（D77。題名の改行と空を見るため）
  itemNamed(e, 'リンクを写す').dispatchEvent({ type: 'click' }); await e.drain();
  assert.deepStrictEqual(e.called('copy').map((c) => c.args[0]), [`NaTsu の議事録「無題」（2026-10-20）${ORIGIN}/open#p=pa1`]);
});

test('決めたこと 100: 録音中の写し（meeting.phase が recording・paused・finalizing）のページのメニューには出ない。録音中のページ（記録中のタブ）には「···」が出ない', T, async () => {
  for (const phase of ['recording', 'paused', 'finalizing']) {
    const l = await openPage('pa1', { meeting: { phase } });
    assert.ok(!itemNamed(l, 'リンクを写す'), `${phase} のページに［リンクを写す］がある`);
    assert.ok(itemNamed(l, 'コピー'), phase);
  }
  const done = await openPage('pa1', { meeting: { phase: 'done' } });
  assert.ok(itemNamed(done, 'リンクを写す'), '片付いた会議のページに［リンクを写す］が無い');
});

test('F15・D78: 住所の頭は main の答え（koeApp.linkBase）。答えが無い・形が違えば写さずに「リンクを写せませんでした。」', T, async () => {
  for (const linkBase of [() => null, () => 'http://example.com/open#p=', () => 'javascript:alert(1)//', () => { throw new Error('x'); }]) {
    const l = await openPage('pa1', null, { linkBase });
    itemNamed(l, 'リンクを写す').dispatchEvent({ type: 'click' }); await l.drain();
    assert.deepStrictEqual(l.called('copy'), []);
    assert.strictEqual(l.byId.get('toast').textContent, 'リンクを写せませんでした。');
  }
});
