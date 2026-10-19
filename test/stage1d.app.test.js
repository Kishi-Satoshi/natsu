/*
 * stage1d.app.test.js — 第1d回の画面（app.html）の確かめ
 * A-9（RL16・F16・RF41）: ［更新して再起動］で取り込みが通っても、restart が断ったら文を出してボタンを戻し、次は取り込み直さずに restart だけ。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const U1 = '録音中のため、更新と再起動をしませんでした。録音を終えてから、もう一度［更新して再起動］を押してください。';
const APPLY = { ok: true, update: true, version: '0.8.1', notes: '変更点', url: 'https://example.invalid/natsu-src-0.8.1.zip', size: 1,
  reinstall: false, applyable: true, notice: { action: 'apply', message: '', button: '更新して再起動' } };

// restart は1回目に断り（録音中）、2回目に通る
const restartOnce = () => { let n = 0; return () => { n += 1; return n === 1 ? { ok: false, code: 'recording', error: U1 } : true; }; };

test('RF41: ［更新して再起動］で取り込みが通っても、restart が { ok: false, error } を返したら文を出してボタンを戻し、次に押すと updateApply を呼ばずに restart だけを呼ぶ', { timeout: 5000 }, async () => {
  const l = await load(APP, { returns: { updateCheck: () => APPLY, restart: restartOnce() } });
  l.window.confirm = () => true; // simrun の confirm は false を返す。ここでは「続行」を選んだことにする
  l.byId.get('chkUpdBtn').dispatchEvent({ type: 'click' }); await l.drain();
  const b = l.byId.get('applyUpdBtn');
  const m = l.byId.get('updMsg');
  b.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('updateApply').length, 1);
  await l.clock.advance(1000); await l.drain();
  assert.strictEqual(l.called('restart').length, 1);
  assert.ok(m.textContent.includes(U1), m.textContent);
  assert.strictEqual(m.className, 'save-msg ng');
  assert.strictEqual(b.disabled, false, 'ボタンが押せないまま');
  assert.strictEqual(b.textContent, '更新して再起動');
  b.dispatchEvent({ type: 'click' }); await l.drain();
  await l.clock.advance(1000); await l.drain();
  assert.strictEqual(l.called('updateApply').length, 1, '断られた後にもう一度取り込んだ');
  assert.strictEqual(l.called('restart').length, 2);
  assert.deepStrictEqual(l.errors, []);
});

test('RF41: 更新の知らせの行（左下）のボタンも同じ。断られたら文を出して戻し、次は restart だけ', { timeout: 5000 }, async () => {
  const l = await load(APP, { returns: { restart: restartOnce() } });
  l.fire('onUpdateAvailable', APPLY); await l.drain();
  const badge = l.byId.get('updBadge');
  const go = badge.querySelector('.go');
  go.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('updateApply').length, 1);
  await l.clock.advance(1000); await l.drain();
  assert.strictEqual(l.called('restart').length, 1);
  const st = badge.querySelector('.st');
  assert.ok(st.textContent.includes(U1), st.textContent);
  assert.strictEqual(st.className, 'st ng');
  assert.strictEqual(go.disabled, false);
  go.dispatchEvent({ type: 'click' }); await l.drain();
  await l.clock.advance(1000); await l.drain();
  assert.strictEqual(l.called('updateApply').length, 1, '断られた後にもう一度取り込んだ');
  assert.strictEqual(l.called('restart').length, 2);
  assert.deepStrictEqual(l.errors, []);
});

test('RF41: 片方（左下の知らせ）で取り込んで断られた後は、設定の［更新して再起動］も取り込み直さずに restart だけ', { timeout: 5000 }, async () => {
  const l = await load(APP, { returns: { updateCheck: () => APPLY, restart: restartOnce() } });
  l.window.confirm = () => true;
  l.fire('onUpdateAvailable', APPLY); await l.drain();
  l.byId.get('updBadge').querySelector('.go').dispatchEvent({ type: 'click' }); await l.drain();
  await l.clock.advance(1000); await l.drain();
  assert.strictEqual(l.called('restart').length, 1);
  l.byId.get('applyUpdBtn').dispatchEvent({ type: 'click' }); await l.drain();
  await l.clock.advance(1000); await l.drain();
  assert.strictEqual(l.called('updateApply').length, 1, '断られた後にもう一度取り込んだ');
  assert.strictEqual(l.called('restart').length, 2);
});
