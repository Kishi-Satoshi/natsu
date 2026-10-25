/*
 * stage121.app.test.js — 0.12.1 Task LV-4（計画 docs/plans/2026-10-24-121.md の決めたこと L15。LN5・LN6）
 * ［設定］→［録音］のカード「会議の検出」の2行目「会議を出たら自動で止める」（既定オン）。読み込み・自動保存・検索・ⓘ の吹き出し。
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。main の答えは偽物（preload.js の名前から作る）。
 */
'use strict';
const { titleAt } = require('./helpers/titles');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { parseHTML } = require('./helpers/simdom');
const SH = require('../tools/shots/screens');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const html = fs.readFileSync(APP, 'utf8');
const doc = parseHTML(html).root;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const LIST = [{ id: 'pa1', title: titleAt('2026-10-16T01:00:00.000Z'), date: '10/16', durationSec: 1800, hasSummary: true }];
const PAGE = (id) => ({ page: { id, title: titleAt('2026-10-16T01:00:00.000Z'), createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
const UI = () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' } });
const open = (settings = {}) => load(APP, { preloadSrc: PRELOAD, returns: { pagesSearch: () => LIST, pageGet: PAGE, uiState: UI, getSettings: () => ({ autoLaunch: false, ...settings }) } });
const $ = (l, id) => l.document.getElementById(id);
const click = async (l, el) => { (typeof el === 'string' ? $(l, el) : el).dispatchEvent({ type: 'click' }); await l.drain(); };
const search = async (l, q) => { const b = $(l, 'setSearch'); b.value = q; b.dispatchEvent({ type: 'input', target: b }); await l.drain(); };
const visible = (el) => { for (let n = el; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) { if (n.id === 'settingsModal') return true; if (n.hidden || n.classList.contains('set-miss')) return false; } return true; };
const shownRows = (l) => l.byId.get('tabSettings').querySelectorAll('[data-row]').filter(visible).map((r) => r.dataset.row);
const saves = (l) => l.called('saveSettings').map((c) => c.args[0]);

const LN5 = { name: '会議を出たら自動で止める', desc: '会議のアプリがマイクを使わなくなったら、録音を止めて議事録を作ります。' };
const LN6 = {
  head: '会議のアプリがマイクを使わなくなったら、会議を出たとみなして、聞かずに録音を止めて議事録を作ります。止まるのは出てから 6 秒ほど後で、止めた後に Windows の知らせを 1 回出します。',
  items: ['見るアプリ: Teams・Zoom・Chrome・Edge。ブラウザでは、会議でないタブがマイクを使って放したときにも止まることがあります。',
    '数秒だけマイクを放したとき（会議に入るとき・マイクの機器を素早く替えたときなど）は止めません。6 秒ほどより長く放すと止まるので、そのときは新しい議事録で録り直してください。',
    '一時停止の間は数えません。',
    '録音中も 2 秒ごとに、Windows の「マイクを使っているアプリ」の記録を読みます。'],
};

test('LV-4（L15・LN5・LN6）: カード「会議の検出」の2行目に「会議を出たら自動で止める」。名前と見える説明は LN5、ⓘ の吹き出しは LN6（頭と箇条4つ）・ヘルプは record/meeting-detect', T, () => {
  const card = doc.querySelector('#detectCard');
  assert.deepStrictEqual(card.querySelectorAll('[data-row]').map((r) => r.dataset.row), ['会議の検出の通知', LN5.name, '通知を出さないアプリ']);
  const row = card.querySelector(`[data-row="${LN5.name}"]`);
  assert.strictEqual(norm(row.querySelector('label[for="autoStopLeave"]').textContent), LN5.name);
  assert.strictEqual(norm(doc.querySelector('#autoStopLeaveDesc').textContent), LN5.desc);
  const box = doc.querySelector('#autoStopLeave');
  assert.strictEqual(box.getAttribute('type'), 'checkbox');
  assert.strictEqual(box.getAttribute('aria-describedby'), 'autoStopLeaveDesc');
  const info = row.querySelector('button.setinfo');
  assert.strictEqual(info.getAttribute('aria-controls'), 'setPopLeave');
  assert.strictEqual(info.getAttribute('aria-label'), `「${LN5.name}」の説明`);
  const pop = doc.querySelector('#setPopLeave');
  assert.ok(pop.hasAttribute('hidden'));
  assert.strictEqual(norm(pop.querySelector('.setpop-head').textContent), LN6.head);
  assert.deepStrictEqual(pop.querySelectorAll('li').map((li) => norm(li.textContent)), LN6.items);
  assert.strictEqual(pop.querySelector('.setpop-help').dataset.help, 'record/meeting-detect');
  // アプリの名前は吹き出しの「見るアプリ」の1つだけ（Firefox・Webex・Slack は書かない）
  assert.ok(!/Firefox|Webex|Slack/.test(norm(row.textContent)), norm(row.textContent));
});

test('LV-4（L15）: 読んだ autoStopLeave が false なら外れ、無ければ（既定）オン。トグルを変えると自動保存の引数に autoStopLeave', T, async () => {
  const l = await open({});
  await l.drain();
  assert.strictEqual($(l, 'autoStopLeave').checked, true, '既定（無い）でオンになっていない');
  $(l, 'autoStopLeave').checked = false;
  $(l, 'tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  assert.strictEqual(saves(l).pop().autoStopLeave, false);
  $(l, 'autoStopLeave').checked = true;
  $(l, 'tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  assert.strictEqual(saves(l).pop().autoStopLeave, true);
  const off = await open({ autoStopLeave: false });
  await off.drain();
  assert.strictEqual($(off, 'autoStopLeave').checked, false);
  assert.deepStrictEqual(l.errors, []);
});

test('LV-4: 設定の検索「自動で止める」「マイク」「会議を出た」でこの行も出る', T, async () => {
  const l = await open({});
  await l.drain();
  await click(l, 'tabBtnSettings');
  await search(l, '自動で止める');
  assert.deepStrictEqual(shownRows(l), [LN5.name, '話し声が無いときに自動で止める']);
  await search(l, 'マイク');
  assert.ok(shownRows(l).includes(LN5.name), JSON.stringify(shownRows(l)));
  await search(l, '会議を出た');
  assert.deepStrictEqual(shownRows(l), [LN5.name]);
  assert.deepStrictEqual(l.errors, []);
});

// 0.12.1 で意図して変えた（版を 0.12.1 に上げる commit。LV-7）: 持ち主が見比べを OK と言ったので、表の画面を基準にして取り直し待ちを空に戻した。表の画面にはどれも基準がある
test('LV-4・LV-7: 計画の「取り直す画面（RETAKE）」の表の画面はどれも撮る画面にあって基準があり、取り直し待ちは空（版を 0.12.1 に上げる commit で基準にした）', T, () => {
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-24-121.md'), 'utf8');
  const i = plan.indexOf('## 取り直す画面（RETAKE');
  const table = plan.slice(i, plan.indexOf('\n## ', i + 5));
  const rows = [...table.matchAll(/^\| (`[^|]+`(?:・`[^|]+`)*)/gm)].flatMap((m) => [...m[1].matchAll(/`([a-z0-9-]+)`/g)].map((x) => x[1]));
  assert.ok(rows.length >= 7, table);
  assert.deepStrictEqual([...SH.RETAKE], []);
  for (const n of rows) {
    assert.ok(SH.SCREENS.some((s) => s.name === n), `${n} が撮る画面に無い`);
    assert.ok(fs.existsSync(path.join(ROOT, 'test', 'shots', 'win32', `${n}.png`)), `${n} の基準が無い`);
  }
});
