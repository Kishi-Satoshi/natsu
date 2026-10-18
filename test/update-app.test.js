/*
 * update-app.test.js — 画面: 更新の知らせ（第0c回 EL4・C2）
 * 入れ直しが要る版では、設定の画面と左下の告知が、同じ文と［ダウンロード］を出す（「更新して再起動」は出さない）。
 * 押すとリリースのページを開くだけで、更新は当てない。simrun の confirm は false を返すので、［ダウンロード］は confirm を使わない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { load } = require('./helpers/simrun.js');
const { REINSTALL_MESSAGE: R } = require('../src/updater');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const UPD = { ok: true, update: true, version: '0.4.0', notes: '変更点', url: 'https://example.invalid/natsu-src-0.4.0.zip', size: 1,
  reinstall: true, applyable: false, notice: { action: 'download', message: R, button: 'ダウンロード' } };
const APPLY = { ...UPD, reinstall: false, applyable: true, notice: { action: 'apply', message: '', button: '更新して再起動' } };

test('設定の［更新を確認］: 入れ直しが要る版では［ダウンロード］と入れ直しの文を出し、押すと配布ページを開く（更新しない）', async () => {
  const l = await load(APP, { returns: { updateCheck: () => UPD } });
  l.byId.get('chkUpdBtn').dispatchEvent({ type: 'click' }); await l.drain();
  const b = l.byId.get('applyUpdBtn');
  assert.strictEqual(b.textContent, 'ダウンロード');
  assert.notStrictEqual(b.style.display, 'none');
  assert.ok(l.byId.get('updMsg').textContent.includes(R), l.byId.get('updMsg').textContent);
  b.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('openReleases').length, 1);
  assert.strictEqual(l.called('updateApply').length, 0);
});

test('起動時の知らせ（左下の告知）: 同じ文と［ダウンロード］。押すと配布ページを開く', async () => {
  const l = await load(APP);
  l.fire('onUpdateAvailable', UPD); await l.drain();
  const badge = l.byId.get('updBadge');
  assert.strictEqual(badge.hidden, false);
  assert.ok(badge.textContent.includes(R));
  const go = badge.querySelector('.go');
  assert.strictEqual(go.textContent, 'ダウンロード');
  go.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('openReleases').length, 1);
  assert.strictEqual(l.called('updateApply').length, 0);
});

test('いつもの更新（入れ直しが要らない）は今までどおり［更新して再起動］', async () => {
  const l = await load(APP);
  l.fire('onUpdateAvailable', APPLY); await l.drain();
  assert.strictEqual(l.byId.get('updBadge').querySelector('.go').textContent, '更新して再起動');
});

test('当てる途中で門が断ったら（古い版のための最後の守り）、ボタンを［ダウンロード］に替える', async () => {
  const l = await load(APP, { returns: { updateApply: () => ({ ok: false, reinstall: true, error: R }) } });
  l.fire('onUpdateAvailable', APPLY); await l.drain();
  const go = l.byId.get('updBadge').querySelector('.go');
  go.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('updateApply').length, 1);
  assert.strictEqual(go.textContent, 'ダウンロード');
  assert.ok(l.byId.get('updBadge').textContent.includes(R));
  go.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('openReleases').length, 1);
  assert.strictEqual(l.called('updateApply').length, 1, '断られた後にもう一度当てようとした');
});

test('notice の無い古い形の知らせでも落ちない（test/invariants.js と同じ形）', async () => {
  const l = await load(APP);
  l.fire('onUpdateAvailable', { version: '9.9.9', url: 'https://example.invalid/x.exe' }); await l.drain();
  assert.deepStrictEqual(l.errors, []);
  assert.strictEqual(l.byId.get('updBadge').querySelector('.go').textContent, '更新して再起動');
});

test('設定の［更新して再起動］でも、門が断ったらボタンを［ダウンロード］に替え、次は配布ページを開く', async () => {
  const l = await load(APP, { returns: { updateCheck: () => APPLY, updateApply: () => ({ ok: false, reinstall: true, error: R }) } });
  l.window.confirm = () => true; // simrun の confirm は false を返す。ここでは「続行」を選んだことにする
  l.byId.get('chkUpdBtn').dispatchEvent({ type: 'click' }); await l.drain();
  const b = l.byId.get('applyUpdBtn');
  assert.strictEqual(b.textContent, '更新して再起動');
  b.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('updateApply').length, 1);
  assert.strictEqual(b.textContent, 'ダウンロード');
  assert.ok(l.byId.get('updMsg').textContent.includes(R), l.byId.get('updMsg').textContent);
  b.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('openReleases').length, 1);
  assert.strictEqual(l.called('updateApply').length, 1, '断られた後にもう一度当てようとした');
});
