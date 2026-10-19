/* db-client.test.js — 第2a1回 ST7: main の客（偽の utilityProcess の中で本物の server.js を動かす） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFork, FakeChannel, fastTimers } = require('./helpers/fake-utility');   // worker_threads で src/db/server.js を起こし、Electron の形に包む
const { tmpData: realTmpData } = require('./helpers/dbtmp');
const { makeDbClient, RESTART_MS } = require('../src/db/client');

// 点検で足した後片付け: テストが途中で止まって（await が返らずに）finally が走らなくても、作った客・子・一時フォルダを片付ける。
// 子（worker）が残るとプロセスが終わらず、変異確認の1回が見張りの時間まで止まる
const made = { clients: [], forks: [], data: [] };
function tmpData(o) { const d = realTmpData(o); made.data.push(d); return d; }
function trackFork(f) { if (typeof f.dispose === 'function') made.forks.push(f); return f; }
test.afterEach(async () => {
  const clients = made.clients.splice(0);
  // close は子の返事か、渡したタイマーで終わる（速いタイマーでは時間で終わらない）ので、本物の時間で 2 秒まで待つ
  await Promise.race([Promise.all(clients.map((c) => c.close({ timeoutMs: 500 }).catch(() => {}))), new Promise((res) => setTimeout(res, 2000).unref())]);
  for (const f of made.forks.splice(0)) f.dispose();
  for (const d of made.data.splice(0)) { try { d.done(); } catch (_) { /* 消し済み・掴まれている */ } }
});

function client(d, o = {}) {
  const fork = o.fork || trackFork(fakeFork());
  const c = makeDbClient({ fork, Channel: FakeChannel, serverPath: require.resolve('../src/db/server'),
    init: { dataDir: d.dataDir, labels: {}, network: false }, log: (l) => (o.logs || []).push(l), timers: o.timers, now: o.now });
  made.clients.push(c);
  c.start();
  return c;
}

// 本物の時間で、条件が真になるまで待つ（決まった時間の待ちにしない）
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await new Promise((res) => setTimeout(res, 10));
  }
  return true;
}

test('ST7: 用意ができるまで頼みを待たせ、できたら順に返す', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  const c = client(d);
  try {
    const got = await c.call('page.get', { id: d.ids[0] });
    assert.strictEqual(got.page.id, d.ids[0]);
    assert.strictEqual(c.state(), 'ready');
  } finally { await c.close({ timeoutMs: 2000 }); d.done(); }
});

test('ST7・RF10: 子が落ちたら 0.5 秒後に起こし直し、返事の無かった書き込みを送った順のまま同じ tx で送り直す（1回だけ効く）', { timeout: 15000 }, async () => {
  const d = tmpData({ pages: 1 });
  const fork = trackFork(fakeFork({ crashAfterRequests: 1 }));   // 1つ目の頼みを書いた直後、返事の前に落ちる
  const logs = [];
  const rowsBefore = d.peek().oplogCount();
  const c = client(d, { fork, logs });
  try {
    const p1 = c.call('page.setTitle', { id: d.ids[0], title: '落ちる前に送った' }, { tx: 'm:title:000001' });
    // 同じ欄への2つの書き込み: 送り直しの順が逆なら、後の値が前の値で上書きされる（送った順のまま）
    c.send('page.setMemo', { id: d.ids[0], memo: '先に送ったメモ' });
    c.send('page.setMemo', { id: d.ids[0], memo: '後から送った' });
    const r = await p1;
    assert.strictEqual(r.title, '落ちる前に送った');   // dup でも、書けた後のページが返る
    assert.strictEqual(fork.starts(), 2);
    assert.ok(logs.some((l) => /DB: 子が終わった（1）。500ms 後に起こし直す/.test(l)));
    assert.strictEqual(d.peek().oplogCount('m:title:000001'), 1, '送り直しで2回効いた');
    await c.call('db.status', {});
    assert.strictEqual(d.peek().getPage(d.ids[0]).memo, '後から送った', '返事を待たない書き込みを送り直さなかったか、送った順のまま送り直していない');
    assert.strictEqual(d.peek().oplogCount(), rowsBefore + 3, '送り直しを別の tx で送り、2回効いた');   // 計画から足した確かめ
  } finally { await c.close({ timeoutMs: 2000 }); d.done(); }
});

test('ST7: 自分で止めたときは起こし直さない（kill の番号は 0 でも印で分かる）。10 分に 5 回落ちたら諦めて、待たせていた頼みも db-down', { timeout: 15000 }, async () => {
  assert.deepStrictEqual(RESTART_MS, [500, 1000, 2000, 4000, 8000]);
  const d = tmpData({ pages: 1 });
  const fork = trackFork(fakeFork({ exitOnStart: 1 }));   // 起こすたびにすぐ落ちる
  const timers = fastTimers();
  const c = client(d, { fork, timers });
  try {
    const waiting = c.call('page.get', { id: d.ids[0] });   // 用意の前に頼んだもの
    waiting.catch(() => {});   // 計画から足した: 諦めたときの reject は runAll の中で起きるので、先に受け手を付ける（未処理の reject でテストが落ちない。下の assert.rejects は同じ Promise を見る）
    // 計画から足した確かめ: 落ちてもすぐには起こさず、500ms の待ちを置く（mc-backoff）
    assert.ok(await until(() => timers.pending().length > 0), '落ちた後の起こし直しの待ちが無い');
    assert.deepStrictEqual(timers.pending(), [500]);
    assert.strictEqual(fork.starts(), 1, '待たずに起こし直した');
    await timers.runAll();
    assert.strictEqual(c.state(), 'down');
    assert.strictEqual(fork.starts(), 5);
    assert.deepStrictEqual(timers.history(), [500, 1000, 2000, 4000], '起こし直しの待ちが RESTART_MS の順でない');
    await assert.rejects(waiting, (e) => e.code === 'db-down' && e.retry === false, '諦めた後も待たせたまま（締めが永遠に返らない）');
    await assert.rejects(c.call('page.get', { id: d.ids[0] }), (e) => e.code === 'db-down' && e.retry === false);
    assert.doesNotThrow(() => c.send('page.setTitle', { id: d.ids[0], title: 'x' }), 'send が投げた');
  } finally { await c.close({ timeoutMs: 500 }); d.done(); }
  // 計画から変えたところ: 止めた後の起こし直しは 500ms 後に来るので、速いタイマーを全部進めてから数える（mc-intentional）
  const d2 = tmpData({ pages: 1 }); const f2 = trackFork(fakeFork()); const t2 = fastTimers(); const c2 = client(d2, { fork: f2, timers: t2 });
  await c2.call('db.status', {}); await c2.close({ timeoutMs: 2000 });
  await t2.runAll();
  assert.strictEqual(f2.starts(), 1, '止めた後に起こし直した');
  d2.done();
});

// 点検で足した確かめ: Electron の UtilityProcess は 'exit' の前に 'error'（FatalError）を出すことがある。受け手が無いと EventEmitter が
// main で投げる（捕まえていない例外の窓）。記録して、起こし直しはいつもどおり 'exit' で決める
test('ST7: 子の error（致命的な失敗）を受け止めて記録し、main で投げない', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  const inner = trackFork(fakeFork());
  let kid = null;
  const fork = (...a) => { kid = inner(...a); return kid; };
  const logs = [];
  const c = client(d, { fork, logs });
  try {
    await c.call('db.status', {});
    assert.doesNotThrow(() => kid.emit('error', 'FatalError'), '子の error を受け止めていない');
    assert.ok(logs.some((l) => l === 'DB: 子の致命的な失敗（FatalError）'), JSON.stringify(logs));
  } finally { await c.close({ timeoutMs: 2000 }); d.done(); }
});
