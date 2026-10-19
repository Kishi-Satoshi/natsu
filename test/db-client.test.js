/* db-client.test.js — 第2a1回 ST7: main の客（偽の utilityProcess の中で本物の server.js を動かす） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFork, FakeChannel, fastTimers } = require('./helpers/fake-utility');   // worker_threads で src/db/server.js を起こし、Electron の形に包む
const { tmpData } = require('./helpers/dbtmp');
const { makeDbClient, RESTART_MS } = require('../src/db/client');

function client(d, o = {}) {
  const c = makeDbClient({ fork: o.fork || fakeFork(), Channel: FakeChannel, serverPath: require.resolve('../src/db/server'),
    init: { dataDir: d.dataDir, labels: {}, network: false }, log: (l) => (o.logs || []).push(l), timers: o.timers, now: o.now });
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
  const fork = fakeFork({ crashAfterRequests: 1 });   // 1つ目の頼みを書いた直後、返事の前に落ちる
  const logs = [];
  const rowsBefore = d.peek().oplogCount();
  const c = client(d, { fork, logs });
  try {
    const p1 = c.call('page.setTitle', { id: d.ids[0], title: '落ちる前に送った' }, { tx: 'm:title:000001' });
    c.send('page.setMemo', { id: d.ids[0], memo: '後から送った' });
    const r = await p1;
    assert.strictEqual(r.title, '落ちる前に送った');   // dup でも、書けた後のページが返る
    assert.strictEqual(fork.starts(), 2);
    assert.ok(logs.some((l) => /DB: 子が終わった（1）。500ms 後に起こし直す/.test(l)));
    assert.strictEqual(d.peek().oplogCount('m:title:000001'), 1, '送り直しで2回効いた');
    await c.call('db.status', {});
    assert.strictEqual(d.peek().getPage(d.ids[0]).memo, '後から送った', '返事を待たない書き込みを送り直さなかった');
    assert.strictEqual(d.peek().oplogCount(), rowsBefore + 2, '送り直しを別の tx で送り、2回効いた');   // 計画から足した確かめ
  } finally { await c.close({ timeoutMs: 2000 }); d.done(); }
});

test('ST7: 自分で止めたときは起こし直さない（kill の番号は 0 でも印で分かる）。10 分に 5 回落ちたら諦めて、待たせていた頼みも db-down', { timeout: 15000 }, async () => {
  assert.deepStrictEqual(RESTART_MS, [500, 1000, 2000, 4000, 8000]);
  const d = tmpData({ pages: 1 });
  const fork = fakeFork({ exitOnStart: 1 });   // 起こすたびにすぐ落ちる
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
  const d2 = tmpData({ pages: 1 }); const f2 = fakeFork(); const t2 = fastTimers(); const c2 = client(d2, { fork: f2, timers: t2 });
  await c2.call('db.status', {}); await c2.close({ timeoutMs: 2000 });
  await t2.runAll();
  assert.strictEqual(f2.starts(), 1, '止めた後に起こし直した');
  d2.done();
});
