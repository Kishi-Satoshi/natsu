/* stage2a1.preload.test.js — 第2a1回 ST5・ST7: preload の DB の口 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync(require.resolve('../src/preload.js'), 'utf8');

// preload を偽の electron で走らせる。口は EventTarget の偽物（postMessage を記録し、reply(id, …) で返事、close() で 'close'）。
// 記録は本物の口と同じに structuredClone した写し（計画のテストから変えたところ: vm の中で作った物は別の realm の Object で、
// そのままでは deepStrictEqual が「同じ形でも別物」と落ちる。本物の口も写しを渡すので、こちらが本物に近い）
function load(timers = { setTimeout, clearTimeout }) {
  const exposed = {}; const on = {}; let uuid = 0;
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } },
    ipcRenderer: { on: (ch, fn) => { on[ch] = fn; }, invoke: async () => ({}), send: () => {} } };
  const sandbox = { require: (m) => { if (m !== 'electron') throw new Error(`sandbox で ${m} を読んだ`); return electron; },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` }, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, console, Promise };
  vm.runInNewContext(SRC, sandbox);
  const port = () => { const p = new EventTarget(); p.sent = []; p.postMessage = (m) => p.sent.push(structuredClone(m)); p.start = () => {};
    p.reply = (id, body) => { const ev = new Event('message'); ev.data = { id, ...body }; (p.onmessage || (() => {}))(ev); p.dispatchEvent(ev); };
    p.closed = 0; p.close = () => { p.closed++; p.dispatchEvent(new Event('close')); }; return p; };
  const givePort = () => { const p = port(); on['db:port']({ ports: [p] }); return p; };
  return { exposed, givePort, lost: () => on['db:lost'] && on['db:lost']({}), sandbox };
}

// 0.13.0 ED-2 で意図して直した: 名前は 0.11.0 の page.setType を含む 14 に、要約の編集の4つを足して 18（照らしは同じ）
test('ST5: ページの 18 の名前は口に頼み、返事をそのまま返す（今の IPC と同じ引数の形）', { timeout: 5000 }, async () => {
  const l = load(); const p = l.givePort();
  const pr = l.exposed.koeApp.blockInsert('pa1', 'b2', 'todo');
  const m = p.sent[0];
  assert.deepStrictEqual([m.cmd, m.args], ['block.insert', { pageId: 'pa1', afterBlockId: 'b2', type: 'todo' }]);
  assert.match(m.tx, /^a:[0-9a-f-]{36}$/);
  p.reply(m.id, { ok: true, result: { page: { id: 'pa1' }, blockId: 'bx' } });
  assert.deepStrictEqual(await pr, { page: { id: 'pa1' }, blockId: 'bx' });
  l.exposed.koeApp.pageGet('pa1');
  assert.strictEqual(p.sent[1].tx, undefined, '読む頼みに tx を付けた');
});

test('F7: 口も口を返す関数もページに出さない・app に無い命令は送らずに断る', { timeout: 5000 }, async () => {
  const l = load(); const p = l.givePort();
  for (const [k, v] of Object.entries(l.exposed)) for (const [n, f] of Object.entries(v)) assert.strictEqual(typeof f, 'function', `${k}.${n}`);
  assert.ok(!('natsuDb' in l.exposed), '呼ばれない口を出した（第2a2回で出す）');
  assert.ok(!/exposeInMainWorld\([^)]*port/i.test(SRC));
  const r = l.exposed.koeApp.pageGet('../x');   // 形の悪い ID は DB が断る（preload は名前だけ照らす）
  p.reply(p.sent[0].id, { ok: false, code: 'bad-args', retry: false });
  await assert.rejects(r, /bad-args/);
});

// 計画のテストに足したもの: 名前の照らしを本当に走らせる（ページには dbCall を出さないので、preload の中の関数を直に呼ぶ）
test('F7: APP_COMMANDS に無い命令（main だけの命令・知らない名前）は口に送らずに forbidden で断る', { timeout: 5000 }, async () => {
  const l = load(); const p = l.givePort();
  assert.strictEqual(typeof l.sandbox.dbCall, 'function', 'preload の中に dbCall が無い');
  const names = ['page.put', 'meeting.finalize', 'snapshot.take', 'toString', '__proto__'];
  const calls = names.map((cmd) => l.sandbox.dbCall(cmd, {}));
  assert.deepStrictEqual(p.sent, [], '断る命令を口に送った');   // 待つ前に見る（送ってしまうと返事が来ず、待ちが返らない）
  for (const [i, r] of calls.entries()) {
    await assert.rejects(r, (e) => e.message === 'forbidden' && e.code === 'forbidden' && e.retry === false, names[i]);
  }
  const ok = l.exposed.koeApp.pageDelete('pa1');
  assert.deepStrictEqual([p.sent[0].cmd, p.sent[0].args], ['page.delete', { id: 'pa1' }]);
  p.reply(p.sent[0].id, { ok: true, result: [] });
  assert.deepStrictEqual(await ok, []);
});

test('ST5: preload の APP_COMMANDS は DB の役 app の命令と同じ集まり', { timeout: 5000 }, () => {
  const m = /const APP_COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(SRC);
  const names = [...m[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]).sort();
  const core = require('../src/db/core');
  const app = Object.keys(core.COMMANDS).filter((k) => core.COMMANDS[k].roles.includes('app')).sort();
  // 計画と違えたところ: 全文検索の命令 pages.searchFull は D-4 で命令の表に入る。P-1 を作るこのブランチ（D-3a の後）には
  // まだ無いので、表に無いときだけ足して比べる。D-4 の後は表にあるので、この行は効かずに完全に同じ集まりを見る
  // （D-4 が役 app を付け忘れれば、表にはあるので足されず、赤になる）。
  if (!Object.hasOwn(core.COMMANDS, 'pages.searchFull')) { app.push('pages.searchFull'); app.sort(); }
  assert.deepStrictEqual(names, app);
});

test('ST7・F7: 口が閉じたら読む頼みはすぐ失敗で返し、書く頼みは新しい口で同じ tx で送り直す', { timeout: 5000 }, async () => {
  const l = load(); const p1 = l.givePort();
  const rd = l.exposed.koeApp.pageGet('pa1');
  const wr = l.exposed.koeApp.pageSetTitle('pa1', '題');
  const tx = p1.sent[1].tx;
  p1.close();
  await assert.rejects(rd, (e) => /retry/.test(e.message));
  const p2 = l.givePort();
  assert.deepStrictEqual([p2.sent[0].cmd, p2.sent[0].tx], ['page.setTitle', tx], '送り直しで tx が変わった（2回効く）');
  // 利用者が付け直した題名（D77。題名の語に頼るため）
  p2.reply(p2.sent[0].id, { ok: true, result: { id: 'pa1', title: '題' } });
  assert.strictEqual((await wr).title, '題');
});

// 計画のテストに足したもの: main から db:lost が来たときも、口の 'close' と同じに扱う（読む頼みは返し、書く頼みは送り直す）。
// 古い口に後から届いた返事は捨てる（送り直した頼みを、古い口の答えで二重に決めない）
test('ST7: db:lost でも読む頼みは retry で返り、書く頼みは新しい口で同じ tx。古い口の遅い返事は使わない', { timeout: 5000 }, async () => {
  const l = load(); const p1 = l.givePort();
  const rd = l.exposed.koeApp.pagesActionView({ q: '', assignee: '' });
  const wr = l.exposed.koeApp.blockMove('pa1', 'b1', 2);
  const [rq, wq] = p1.sent;
  l.lost();
  await assert.rejects(rd, (e) => e.message === 'retry' && e.code === 'retry' && e.retry === true);
  p1.reply(wq.id, { ok: true, result: { id: 'pa1', from: 'old' } });   // 古い口の遅い返事
  const p2 = l.givePort();
  assert.deepStrictEqual(p2.sent.map((x) => [x.cmd, x.tx]), [['block.move', wq.tx]], '読む頼みまで送り直した・tx が変わった');
  assert.notStrictEqual(rq.tx, wq.tx);
  p2.reply(p2.sent[0].id, { ok: true, result: { id: 'pa1', from: 'new' } });
  assert.deepStrictEqual(await wr, { id: 'pa1', from: 'new' });
});

// 点検で足したもの: main が db:lost を送らずに新しい口を配っても（古い口の 'close' も来なくても）、古い口に送った頼みを
// 失ったものとして扱う（読む頼みは retry、書く頼みは新しい口で同じ tx）。古い口の遅い返事は使わない（F7: 待ちが返らない、を作らない）
test('ST7・F7: db:lost も close も無いまま新しい口が来ても、古い口の頼みを返すか送り直す', { timeout: 5000 }, async () => {
  const l = load(); const p1 = l.givePort();
  const rd = l.exposed.koeApp.pageGet('pa1');
  const wr = l.exposed.koeApp.pageSetTitle('pa1', '𠮷の題');
  const wq = p1.sent[1];
  const seen = (pr) => { const st = { done: false, err: null }; pr.then(() => { st.done = true; }, (e) => { st.done = true; st.err = e; }); return st; };
  const tick = () => new Promise((r) => setImmediate(r));
  const rs = seen(rd); const ws = seen(wr);
  const p2 = l.givePort();
  await tick();   // 待たずに見る（返らない頼みを await すると、赤ではなく途中で打ち切りになる）
  assert.ok(rs.done && rs.err && rs.err.message === 'retry' && rs.err.retry === true, '古い口に送った読む頼みが返らない');
  assert.deepStrictEqual(p2.sent.map((x) => [x.cmd, x.tx]), [['page.setTitle', wq.tx]], '古い口の書く頼みを新しい口で同じ tx で送り直していない');
  p1.reply(wq.id, { ok: true, result: { id: 'pa1', from: 'old' } });   // 古い口の遅い返事
  await tick();
  assert.strictEqual(ws.done, false, '古い口の返事で決めた');
  p2.reply(p2.sent[0].id, { ok: true, result: { id: 'pa1', from: 'new' } });
  assert.deepStrictEqual(await wr, { id: 'pa1', from: 'new' });
});

// 点検で足したもの: 失った口・替えた口は閉じて返事の受け口を外す（口を残し続けない）
test('ST7: db:lost の口と新しい口に替えた古い口は閉じ、返事の受け口を外す', { timeout: 5000 }, async () => {
  const l = load(); const p1 = l.givePort();
  l.lost();
  assert.strictEqual(p1.closed, 1, 'db:lost の口を閉じていない');
  assert.strictEqual(p1.onmessage, null);
  const p2 = l.givePort(); const p3 = l.givePort();
  assert.strictEqual(p2.closed, 1, '替えた古い口を閉じていない');
  assert.strictEqual(p2.onmessage, null);
  assert.strictEqual(p3.closed, 0);
  const r = l.exposed.koeApp.pageGet('pa1');
  p3.reply(p3.sent[0].id, { ok: true, result: { id: 'pa1' } });
  assert.deepStrictEqual(await r, { id: 'pa1' });
});

// 点検で足したもの: 口に写せない引数（関数など）は、その頼みだけ bad-args で返し、待たせていた残りの頼みは送る
test('F7: 口に写せない引数の頼みは bad-args で返り、残りの頼みは送られる', { timeout: 5000 }, async () => {
  const l = load();
  const bad = l.exposed.koeApp.blockUpdate('pa1', 'b1', { text: 'x', f: () => {} });
  const ok = l.exposed.koeApp.pageSetTitle('pa1', '題');
  const p = l.givePort();
  await assert.rejects(bad, (e) => e.message === 'bad-args' && e.code === 'bad-args' && e.retry === false);
  assert.deepStrictEqual(p.sent.map((x) => x.cmd), ['page.setTitle'], '写せない頼みの後の頼みを送っていない');
  p.reply(p.sent[0].id, { ok: true, result: { id: 'pa1' } });
  assert.deepStrictEqual(await ok, { id: 'pa1' });
  const bad2 = l.exposed.koeApp.blockUpdate('pa1', 'b1', { f: () => {} });   // 口があるときも同じ
  await assert.rejects(bad2, (e) => e.message === 'bad-args' && e.retry === false);
  assert.strictEqual(p.sent.length, 1);
});

test('ST7: DB の失敗は符号を message にした Error（.code・.retry つき）で返す', { timeout: 5000 }, async () => {
  const l = load(); const p = l.givePort();
  const r = l.exposed.koeApp.pageSetMemo('pa1', 'メモ');
  assert.deepStrictEqual(p.sent[0].args, { id: 'pa1', memo: 'メモ' });
  p.reply(p.sent[0].id, { ok: false, code: 'conflict', retry: true });
  await assert.rejects(r, (e) => Object.prototype.toString.call(e) === '[object Error]' && e.message === 'conflict' && e.code === 'conflict' && e.retry === true);
});

// 計画のテストに足したもの: 口が無いまま待たせる頼みは 30 秒で諦めて retry で返す（待ちが永遠に返らない、を作らない: F7）。
// 時計は偽物（呼ばれた setTimeout の ms を記録し、手で起こす）
test('F7: 口が戻らなければ、送り直しを待つ書く頼みと口の前の頼みは 30 秒で retry で返る。口が来て送ったら時計は止める', { timeout: 5000 }, async () => {
  const timers = []; let cleared = 0;
  const fake = { setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout: (t) => { if (t) { t.dead = true; cleared++; } } };
  const fire = () => { for (const t of timers.splice(0)) if (!t.dead) t.fn(); };
  const l = load(fake);
  const before = l.exposed.koeApp.pagesSearchFull('予算');
  assert.deepStrictEqual(timers.map((t) => t.ms), [30000]);
  const p1 = l.givePort();
  assert.deepStrictEqual([p1.sent[0].cmd, p1.sent[0].args], ['pages.searchFull', { q: '予算', limit: 60 }]);
  assert.strictEqual(cleared, 1, '送ったのに諦めの時計を止めていない');
  p1.reply(p1.sent[0].id, { ok: true, result: { hits: [], total: 0, truncated: false } });
  assert.deepStrictEqual(await before, { hits: [], total: 0, truncated: false });
  const wr = l.exposed.koeApp.blockRemove('pa1', 'b1');
  assert.strictEqual(timers.filter((t) => !t.dead).length, 0, '口があるのに時計を回した');
  p1.close();
  const late = l.exposed.koeApp.pageGet('pa1');   // 口が無い間の読む頼みは、次の口を待つ
  assert.deepStrictEqual(timers.filter((t) => !t.dead).map((t) => t.ms), [30000, 30000]);
  fire();
  await assert.rejects(wr, (e) => e.message === 'retry' && e.retry === true);
  await assert.rejects(late, (e) => e.message === 'retry' && e.retry === true);
  const p2 = l.givePort();
  assert.deepStrictEqual(p2.sent, [], '諦めた頼みを後から送った');
});

test('ST5: 口が来る前の頼み（起動の直後の一覧など）は断らずに待ち、口が来たら送る', { timeout: 5000 }, async () => {
  const l = load();
  const pr = l.exposed.koeApp.pagesSearch('');
  const bare = l.exposed.koeApp.pagesSearch();   // 引数が無くても q は ''（今の main の q || '' と同じ）
  const p = l.givePort();
  assert.deepStrictEqual([p.sent[0].cmd, p.sent[0].args], ['pages.list', { q: '' }]);
  assert.deepStrictEqual([p.sent[1].cmd, p.sent[1].args], ['pages.list', { q: '' }]);
  p.reply(p.sent[0].id, { ok: true, result: [] });
  p.reply(p.sent[1].id, { ok: true, result: [] });
  assert.deepStrictEqual(await pr, []);
  assert.deepStrictEqual(await bare, []);
});

test('ST5: preload に画面のページの invoke が残っていない（書き込みが main を通らない）', () => {
  for (const ch of ["invoke('page:get'", "invoke('pages:", "invoke('block:", "invoke('segment:"]) assert.ok(!SRC.includes(ch), ch);
  assert.ok(SRC.includes("invoke('page:summarize'"), '要約は今どおり main');
});
