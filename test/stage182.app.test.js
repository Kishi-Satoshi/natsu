/* stage182.app.test.js — 0.18.2（計画 docs/plans/2026-11-28-182.md）の画面
 *  TD-2（決めたこと 5・AQ182-4・AQ182-5・F265）: 初めて「タスク管理」を作った［タスクにする］だけ、知らせを「「タスク管理」を作って、タスクにしました（タスクは Ctrl+Z で戻せます）」に。
 *  2回目からと、ゴミ箱のタスクを作り直すとき（「タスク管理」はある）は今の「タスクにしました（Ctrl+Z で戻せます）」
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせ、DB の命令は一時の DB に本当に通す（helpers/realapp.js）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { realApp } = require('./helpers/realapp');
const { titleAt } = require('./helpers/titles');

const T = { timeout: 60000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const open = async (l, id) => { l.fire('onPageOpen', id); await l.drain(120); };
const clickEl = async (l, el, ms = 80) => { el.dispatchEvent({ type: 'click' }); await l.drain(ms); };
const sideIds = (l) => $(l, 'plist').querySelectorAll('.pitem').map((r) => r.dataset.pid).filter(Boolean);
const todoRow = (l, id) => $(l, 'pNote').querySelectorAll('.blk').find((e) => e._b && e._b.id === id);
const taskBtnOf = (l, id) => { const r = todoRow(l, id); return r ? r.querySelector('.totask') : null; };
const markOf = (l, pid, bid) => l.call('page.get', { id: pid }).page.blocks.find((b) => b.id === bid).task;
const MADE = '「タスク管理」を作って、タスクにしました（タスクは Ctrl+Z で戻せます）';
const DONE = 'タスクにしました（Ctrl+Z で戻せます）';

test('TD-2・F265: 「タスク管理」の無い PC の初めての［タスクにする］の知らせは「「タスク管理」を作って、タスクにしました（タスクは Ctrl+Z で戻せます）」で、サイドバーの「議事録」の下に「タスク管理」が出る。2回目は今の知らせ。ゴミ箱のタスクの［タスクを開く］（「タスク管理」はある）で作り直したときも今の知らせ', T, async () => {
  const l = await realApp({ before: (call) => {
    const at = '2026-11-27T01:00:00.000Z';
    call('meeting.finalize', { pageId: 'pw1', page: { title: titleAt(at), date: '2026-11-27', createdAt: at, blocks: [{ id: 'pw1h', type: 'heading', text: 'ToDo' },
      { id: 'pw1t0', type: 'todo', text: '見積もりを出す', checked: false }, { id: 'pw1t1', type: 'todo', text: '資料を集める', checked: false }] }, segments: [] }, 'main');
    call('minutes.gather', { first: true }, 'main');
    return { M: call('pages.list', {}).find((p) => p.minutes).id };
  } });
  try {
    const { M } = l.made;
    assert.ok(!l.call('pages.list', {}).some((p) => p.tasks), '前提: 「タスク管理」が初めからある');
    assert.deepStrictEqual(sideIds(l).slice(0, 1), [M]);
    await open(l, 'pw1');
    await clickEl(l, taskBtnOf(l, 'pw1t0'), 300);
    assert.deepStrictEqual(l.called('todoToTask').map((c) => c.args), [['pw1', 'pw1t0']]);
    assert.ok($(l, 'toast').textContent === MADE, `初めての知らせ: ${$(l, 'toast').textContent}`);
    const K = l.call('pages.list', {}).find((p) => p.tasks).id;
    assert.deepStrictEqual(sideIds(l).slice(0, 2), [M, K], 'サイドバーの「議事録」の下に「タスク管理」が出ない');
    // 2回目（ほかの ToDo）
    await clickEl(l, taskBtnOf(l, 'pw1t1'), 300);
    assert.ok($(l, 'toast').textContent === DONE, `2回目の知らせ: ${$(l, 'toast').textContent}`);
    // ゴミ箱のタスクの［タスクを開く］は作り直す（「タスク管理」はある）
    const gone = markOf(l, 'pw1', 'pw1t0');
    l.call('rows.trash', { db: K, ids: [gone] });
    await open(l, 'pw1');
    const b = taskBtnOf(l, 'pw1t0');
    assert.ok(b && b.textContent === 'タスクを開く');
    await clickEl(l, b, 400);
    assert.strictEqual(l.called('todoToTask').length, 3, 'ゴミ箱のタスクを作り直さない');
    assert.ok(markOf(l, 'pw1', 'pw1t0') !== gone, '印が新しい行を指さない');
    assert.ok($(l, 'toast').textContent === DONE, `作り直しの知らせ: ${$(l, 'toast').textContent}`);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
