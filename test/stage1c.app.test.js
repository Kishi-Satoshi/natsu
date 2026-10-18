/*
 * stage1c.app.test.js — 第1c回の画面（設定のカード「オンライン」・ページの経路・会議の［PC の中だけ］）を、最小 DOM の上で本当に走らせて確かめる
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const status = (o = {}) => ({ ok: true, consent: 'ask', provider: { id: 'groq', label: 'Groq（無料枠）', host: 'api.groq.com' }, hasKey: false, canStore: true, online: { up: true, why: 'ok' }, ...o });

test('OL7: カード「オンライン」が出て、同意・送り先・鍵・Claude Code の状態を描く。初期化が最後まで走る', async () => {
  const l = await load(APP, { returns: { cloudStatus: () => status(), claudeStatus: () => ({ ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '' }) } });
  await l.drain();
  assert.strictEqual(l.byId.get('cloudTranscribe').value, 'ask');
  assert.strictEqual(l.byId.get('sttProvider').value, 'groq');
  assert.strictEqual(l.byId.get('sttKeyState').textContent, '未設定');
  assert.match(l.byId.get('claudeState').textContent, /ログイン済み（claude\.ai）/);
  assert.ok(l.byId.get('sttBaseUrl').closest('.field').hidden, '「そのほか」でないのに URL の欄が出ている');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('RF30: 鍵は保存の後に欄から消え、画面は鍵を受け取らない（状態は「保存済み」だけ）', async () => {
  const calls = [];
  const l = await load(APP, { returns: {
    cloudStatus: () => status({ hasKey: calls.length > 0 }),
    cloudSetKey: (p, k) => { calls.push([p, k]); return { ok: true }; },
    claudeStatus: () => ({ ok: true, found: false, cmdOnly: false, method: '', message: 'Claude Code が見つかりません' }),
  } });
  await l.drain();
  l.byId.get('sttKey').value = 'gsk_test_0123456789';
  l.byId.get('sttKeySave').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(calls, [['groq', 'gsk_test_0123456789']]);
  assert.strictEqual(l.byId.get('sttKey').value, '', '保存の後も鍵が欄に残っている');
  assert.strictEqual(l.byId.get('sttKeyState').textContent, '保存済み');
  assert.match(l.byId.get('claudeState').textContent, /見つかりません/);
  assert.match(l.byId.get('claudeHelp').textContent, /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
});

test('OL7: 送り先を「そのほか」にすると URL とモデルの欄が出る。暗号にできない PC では鍵の保存が押せない', async () => {
  const l = await load(APP, { returns: { cloudStatus: () => status({ canStore: false }), claudeStatus: () => ({ ok: true, found: true, method: 'claude.ai' }) } });
  await l.drain();
  const sel = l.byId.get('sttProvider'); sel.value = 'custom'; sel.dispatchEvent({ type: 'change' });
  await l.drain();
  assert.strictEqual(l.byId.get('sttBaseUrl').closest('.field').hidden, false);
  assert.strictEqual(l.byId.get('sttKeySave').disabled, true);
  assert.match(l.byId.get('sttKeyState').textContent, /この PC では鍵をしまえません/);
});

test('OL4: カードに送り先・保存の扱い・費用の目安・1on1 の注意が書いてある', async () => {
  const l = await load(APP, { returns: { cloudStatus: () => status(), claudeStatus: () => ({ ok: true, found: true, method: 'claude.ai' }) } });
  await l.drain();
  const t = l.byId.get('cloudTranscribe').closest('.card').textContent;
  for (const w of ['1日 8 時間分', 'Zero Data Retention', '1分 約 1 円', '［この会議は PC の中だけ］']) assert.ok(t.includes(w), w);
});

// ---- 計画の外で足した守り（Task C-2 の実装で決めたこと）----
test('OL7・RF30: 設定の自動保存は5つのキーを送り、鍵の欄の値は送らない。鍵の保存に失敗しても欄に鍵を残さない', async () => {
  const l = await load(APP, { returns: {
    cloudStatus: () => status(), cloudSetKey: () => ({ ok: false, code: 'bad-key', message: '鍵の形が正しくありません' }),
    claudeStatus: () => ({ ok: true, found: true, method: 'claude.ai' }),
  } });
  await l.drain();
  l.byId.get('cloudTranscribe').value = 'on';
  l.byId.get('sttProvider').value = 'custom';
  l.byId.get('sttBaseUrl').value = ' https://stt.example/v1 ';
  l.byId.get('sttModel').value = 'whisper-large-v3';
  l.byId.get('claudeExe').value = 'C:\\c\\claude.exe';
  l.byId.get('sttKey').value = 'gsk_test_0123456789';
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  const sent = l.called('saveSettings').pop().args[0];
  assert.deepStrictEqual([sent.cloudTranscribe, sent.sttProvider, sent.sttBaseUrl, sent.sttModel, sent.claudeExe],
    ['on', 'custom', 'https://stt.example/v1', 'whisper-large-v3', 'C:\\c\\claude.exe']);
  assert.ok(!JSON.stringify(sent).includes('gsk_test'), '設定の保存に鍵が混ざった');
  assert.strictEqual(l.called('claudeStatus').length, 2, 'Claude Code の場所を変えたのに確かめ直していない');
  l.byId.get('sttKeySave').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('cloudSetKey').map((c) => c.args), [['custom', 'gsk_test_0123456789']]);
  assert.strictEqual(l.byId.get('sttKey').value, '', '保存に失敗した鍵が欄に残っている');
  assert.match(l.byId.get('onlineMsg').textContent, /鍵の形が正しくありません/);
});

test('OL3: 鍵が無いときは［鍵を確かめる］［鍵を消す］が押せず、あれば押せて選んだ送り先の名前で main を呼ぶ', async () => {
  const none = await load(APP, { returns: { cloudStatus: () => status(), claudeStatus: () => ({ ok: true, found: true, method: 'claude.ai' }) } });
  await none.drain();
  assert.strictEqual(none.byId.get('sttKeyTest').disabled, true);
  assert.strictEqual(none.byId.get('sttKeyClear').disabled, true);
  let has = true;
  const l = await load(APP, { returns: {
    cloudStatus: () => status({ hasKey: has }),
    cloudTestKey: () => ({ ok: false, code: 'auth', message: 'Groq（無料枠）: 鍵が正しくないか、使えなくなっています。' }),
    cloudClearKey: () => { has = false; return { ok: true }; },
    claudeStatus: () => ({ ok: true, found: true, method: 'claude.ai' }),
  } });
  await l.drain();
  assert.strictEqual(l.byId.get('sttKeyState').textContent, '保存済み');
  assert.strictEqual(l.byId.get('sttKeyTest').disabled, false);
  l.byId.get('sttKeyTest').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('cloudTestKey').map((c) => c.args), [['groq']]);
  assert.match(l.byId.get('onlineMsg').textContent, /鍵が正しくないか/);
  l.byId.get('sttKeyClear').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('cloudClearKey').map((c) => c.args), [['groq']]);
  assert.strictEqual(l.byId.get('sttKeyState').textContent, '未設定');
});

test('OL5: ［Claude Code を確かめる］で読み直し、ログイン済みでなければ main の文を出す（-p の口は画面に無い）', async () => {
  let n = 0;
  const l = await load(APP, { returns: {
    cloudStatus: () => status(),
    claudeStatus: () => ({ ok: true, found: true, method: 'claude.ai', message: '' }),
    claudeTest: () => { n += 1; return { ok: true, found: true, method: 'api_key', message: 'Claude Code が API キー（従量課金）で動く設定になっているため' }; },
  } });
  await l.drain();
  assert.match(l.byId.get('claudeState').textContent, /ログイン済み/);
  l.byId.get('claudeTest').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(n, 1);
  assert.match(l.byId.get('claudeState').textContent, /API キー（従量課金）/);
  assert.strictEqual(l.byId.get('claudeState').className, 'eng-state ng');
  // 文が空でも、claude.ai のログインでなければ「ログイン済み」とは言わない（API キーの従量課金の設定を見逃さない）
  const odd = await load(APP, { returns: { cloudStatus: () => status(), claudeStatus: () => ({ ok: true, found: true, method: 'api_key', message: '' }) } });
  await odd.drain();
  assert.doesNotMatch(odd.byId.get('claudeState').textContent, /ログイン済み/);
  assert.ok(l.apis.koeApp.includes('claudeTest') && !l.apis.koeApp.some((k) => /^claude(Run|Summar)/i.test(k)), '画面から Claude Code の要約を呼べる口がある');
});
