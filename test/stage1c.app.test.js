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

// 第1b回の続き Lane F-b: ［Claude Code を確かめる］は auth status の後に小さな本当の要求を1つ送る（main の claude:test）。
// 通れば「ログイン済み（確かめ済み）」、開いたときの自動の確かめ（claudeStatus。要求は送らない）は今の「ログイン済み（claude.ai）」のまま
test('Lane F-b: ［Claude Code を確かめる］で要求まで通れば「ログイン済み（確かめ済み）」、ログインが切れていれば main の文', async () => {
  let answer = { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '', verified: true };
  const l = await load(APP, { returns: {
    cloudStatus: () => status(),
    claudeStatus: () => ({ ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '' }),
    claudeTest: () => answer,
  } });
  await l.drain();
  assert.strictEqual(l.byId.get('claudeState').textContent, 'ログイン済み（claude.ai）');
  l.byId.get('claudeTest').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.byId.get('claudeState').textContent, 'ログイン済み（確かめ済み）');
  assert.strictEqual(l.byId.get('claudeState').className, 'eng-state ok');
  answer = { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: 'Claude Code のログインが切れています。設定の［Claude Code にログイン］を押してください。' };
  l.byId.get('claudeTest').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.byId.get('claudeState').textContent, 'Claude Code のログインが切れています。設定の［Claude Code にログイン］を押してください。');
  assert.strictEqual(l.byId.get('claudeState').className, 'eng-state ng');
  // verified が付いていても、文があればログイン済みとは言わない
  answer = { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: 'x', verified: true };
  l.byId.get('claudeTest').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.doesNotMatch(l.byId.get('claudeState').textContent, /ログイン済み/);
});

test('OL3: 送り先を変えて設定が保存されると、鍵の状態を main に聞き直し、新しい送り先の鍵で描き直す（前の送り先の「保存済み」を残さない）', async () => {
  let provider = 'groq';   // main がしまっている送り先（設定の保存で変わる）。鍵は groq にだけある
  const l = await load(APP, { returns: {
    cloudStatus: () => status({ provider: { id: provider, label: provider, host: '' }, hasKey: provider === 'groq' }),
    saveSettings: (s) => { provider = s.sttProvider; return { ok: true }; },
    claudeStatus: () => ({ ok: true, found: true, method: 'claude.ai' }),
  } });
  await l.drain();
  assert.strictEqual(l.byId.get('sttKeyState').textContent, '保存済み');
  assert.strictEqual(l.byId.get('sttKeyTest').disabled, false);
  const before = l.called('cloudStatus').length;
  const sel = l.byId.get('sttProvider'); sel.value = 'openai';
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  assert.strictEqual(l.called('saveSettings').pop().args[0].sttProvider, 'openai');
  assert.ok(l.called('cloudStatus').length > before, '送り先を変えたのに鍵の状態を聞き直していない');
  assert.strictEqual(l.byId.get('sttKeyState').textContent, '未設定', '鍵の無い送り先なのに「保存済み」のまま');
  assert.strictEqual(l.byId.get('sttKeyTest').disabled, true);
  assert.strictEqual(l.byId.get('sttKeyClear').disabled, true);
});

// ---- 第1c回 Task C-3（OL6・OL4・RF28）----
test('OL6: ページのプロパティの行に経路が出る（古いページは何も足さない）', async () => {
  const page = { id: 'p1', title: '定例', createdAt: '2026-10-18T01:00:00.000Z', durationSec: 60, blocks: [], memo: '', meetingType: 'general',
    routeText: ['☁ 文字起こし: クラウド（Groq（無料枠））2', '✨ 要約: Claude Code'] };
  const l = await load(APP, { returns: { pagesSearch: () => [{ id: 'p1', title: '定例', date: '10/18', durationSec: 60, hasSummary: true }], pageGet: () => ({ page, segments: [] }) } });
  await l.drain();
  l.byId.get('plist').querySelector('.pitem').dispatchEvent({ type: 'click' });
  await l.drain();
  // 第1b回 B-4 で意図して変えた: プロパティは「アイコン・名前・値」の行なので、routeText の1行を最初の ': ' で名前と値に分けて出す（意図はそのまま: どこで処理したかがページに出る）
  const rows = l.byId.get('pProps').querySelectorAll('.prop').map((r) => [r.querySelector('.k').textContent, r.querySelector('.v').textContent]);
  assert.deepStrictEqual(rows.filter((r) => /文字起こし|要約/.test(r[0])), [['☁ 文字起こし', 'クラウド（Groq（無料枠））2'], ['✨ 要約', 'Claude Code']]);
});

test('RF28: 会議中の［この会議は PC の中だけ］を押すと main に伝わり、押した後は戻すボタンが無い', async () => {
  const calls = [];
  const l = await load(APP, { returns: { meetingStatus: () => ({ active: true, segments: [], localOnly: false, cloud: true }), meetingSetLocalOnly: (on) => { calls.push(on); return { ok: true, localOnly: true }; } } });
  await l.drain();
  const b = l.byId.get('meetingLocalOnly');
  assert.ok(b && !b.hidden, 'クラウドで処理している会議にボタンが無い');
  b.dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(calls, [true]);
  assert.strictEqual(l.byId.get('meetingLocalOnly').hidden, true);
  assert.match(l.byId.get('meetingLocalOnlyNote').textContent, /この会議は PC の中だけで文字起こししています/);
});

test('RF28: ［PC の中だけ］は会議ごと。次の会議ではボタンが戻り、文は出ない。クラウドで処理しない設定ならボタンを出さない', async () => {
  const l = await load(APP, { returns: { meetingStatus: () => ({ active: true, segments: [], localOnly: false, cloud: true }), meetingSetLocalOnly: () => ({ ok: true, localOnly: true }) } });
  await l.drain();
  l.byId.get('meetingLocalOnly').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.byId.get('meetingLocalOnly').hidden, true);
  l.fire('onMeetingUpdate', { active: false, segments: [], localOnly: false, cloud: true });
  l.fire('onMeetingUpdate', { active: true, segments: [], localOnly: false, cloud: true });
  await l.drain();
  assert.strictEqual(l.byId.get('meetingLocalOnly').hidden, false, '前の会議の［PC の中だけ］が次の会議に残り、ボタンが無い（main の新しい会議はクラウドへ送る）');
  assert.strictEqual(l.byId.get('meetingLocalOnlyNote').hidden, true, '次の会議なのに「PC の中だけで文字起こししています」と出ている（実際はクラウドへ送る）');
  l.fire('onMeetingUpdate', { active: true, segments: [], localOnly: false, cloud: false });
  await l.drain();
  assert.strictEqual(l.byId.get('meetingLocalOnly').hidden, true, 'クラウドで処理しない設定（同意が ask・off）なのにボタンが出ている');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('OL4: 同意をまだ決めていないときだけ、設定のカード「オンライン」の頭に案内の行が出る', async () => {
  const a = await load(APP, { returns: { cloudStatus: () => status({ consent: 'ask' }), claudeStatus: () => ({ ok: true, found: true, method: 'claude.ai' }) } });
  await a.drain();
  assert.strictEqual(a.byId.get('onlineAskNote').hidden, false);
  const b = await load(APP, { returns: { cloudStatus: () => status({ consent: 'off' }), claudeStatus: () => ({ ok: true, found: true, method: 'claude.ai' }) } });
  await b.drain();
  assert.strictEqual(b.byId.get('onlineAskNote').hidden, true);
});

// 第1b回の続き Lane F-c・F-d: 利用者は PowerShell を打たない。カード「オンライン」の［Claude Code にログイン］（見つかったとき）と
// ［Claude Code を入れる］（見つからない・claude.cmd しか無いとき）で、main が見える窓を開き、閉じたら確かめ直した答えで描き直す
test('Lane F-c・F-d: ［Claude Code にログイン］は見つかったときだけ、［Claude Code を入れる］は見つからない・claude.cmd だけのときだけ出る', async () => {
  const shown = async (st) => {
    const l = await load(APP, { returns: { cloudStatus: () => status(), claudeStatus: () => st } });
    await l.drain();
    assert.deepStrictEqual(l.errors.map(fmt), []);
    return [!l.byId.get('claudeLogin').hidden, !l.byId.get('claudeInstall').hidden];
  };
  assert.deepStrictEqual(await shown({ ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '' }), [true, false]);
  assert.deepStrictEqual(await shown({ ok: true, found: true, cmdOnly: false, method: 'none', message: 'Claude Code にログインしていないか、ログインが切れています。' }), [true, false]);
  assert.deepStrictEqual(await shown({ ok: true, found: false, cmdOnly: false, method: '', message: 'Claude Code が見つかりません。' }), [false, true]);
  assert.deepStrictEqual(await shown({ ok: true, found: false, cmdOnly: true, method: '', message: 'Claude Code が `claude.cmd` の形' }), [false, true]);
  assert.deepStrictEqual(await shown(null), [false, false]);
});

test('Lane F-c: ［Claude Code にログイン］で main の窓を開き、待つ間は案内とボタンの無効、閉じたら確かめ直した答え（確かめ済み）。断られたら main の文', async () => {
  let release;
  let answer = new Promise((r) => { release = r; });
  const l = await load(APP, { returns: {
    cloudStatus: () => status(),
    claudeStatus: () => ({ ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '' }),
    claudeLogin: () => answer,
  } });
  await l.drain();
  l.byId.get('claudeLogin').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.called('claudeLogin').length, 1);
  assert.strictEqual(l.byId.get('claudeState').textContent, 'ログインの窓を開きました。窓の案内に従ってログインし、終わったら窓を閉じてください（閉じると NaTsu が確かめ直します）。');
  assert.deepStrictEqual([l.byId.get('claudeLogin').disabled, l.byId.get('claudeInstall').disabled, l.byId.get('claudeTest').disabled], [true, true, true]);
  release({ ok: true, status: { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '', verified: true } });
  await l.drain();
  assert.strictEqual(l.byId.get('claudeState').textContent, 'ログイン済み（確かめ済み）');
  assert.strictEqual(l.byId.get('claudeState').className, 'eng-state ok');
  assert.deepStrictEqual([l.byId.get('claudeLogin').disabled, l.byId.get('claudeInstall').disabled, l.byId.get('claudeTest').disabled], [false, false, false]);
  answer = { ok: false, code: 'busy', message: 'Claude Code の窓がもう開いています。窓での操作が終わったら閉じてください。' };
  l.byId.get('claudeLogin').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.byId.get('claudeState').textContent, 'Claude Code の窓がもう開いています。窓での操作が終わったら閉じてください。');
  assert.strictEqual(l.byId.get('claudeState').className, 'eng-state ng');
  assert.ok(l.apis.koeApp.includes('claudeLogin') && l.apis.koeApp.includes('claudeInstall'));
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('Lane F-d: ［Claude Code を入れる］は入れる命令（決まった文字）を見せて main の窓を開き、閉じたら確かめ直す。入った後はログインのボタンに替わる', async () => {
  let release;
  const l = await load(APP, { returns: {
    cloudStatus: () => status(),
    claudeStatus: () => ({ ok: true, found: false, cmdOnly: false, method: '', message: 'Claude Code が見つかりません。' }),
    claudeInstall: () => new Promise((r) => { release = r; }),
  } });
  await l.drain();
  l.byId.get('claudeInstall').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.called('claudeInstall').length, 1);
  assert.strictEqual(l.byId.get('claudeState').textContent, 'PowerShell の窓で Anthropic の公式の入れ方（irm https://claude.ai/install.ps1 | iex）を実行しています。終わったら窓を閉じてください（閉じると NaTsu が確かめ直します）。');
  release({ ok: true, status: { ok: true, found: true, cmdOnly: false, method: 'none', message: 'Claude Code にログインしていないか、ログインが切れています。［Claude Code にログイン］を押してログインしてください。' } });
  await l.drain();
  assert.match(l.byId.get('claudeState').textContent, /［Claude Code にログイン］を押して/);
  assert.deepStrictEqual([!l.byId.get('claudeLogin').hidden, !l.byId.get('claudeInstall').hidden], [true, false]);
  // 説明の行に、入れる命令と「インターネットの命令をそのまま実行する」こと・ログインの情報を読まないことが書いてある
  const help = l.byId.get('claudeHelp').textContent;
  assert.match(help, /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
  assert.match(help, /Anthropic の公式の入れ方/);
  assert.match(help, /NaTsu はログインの情報を読みません/);
});

// 第1b回の続き Lane F-e: ［鍵を確かめる］が「使えるが一覧の権限は無い」と答えたら、その文を「使えます」の色で出す
test('Lane F-e: ［鍵を確かめる］の答えに文があれば、通ったときもその文を出す（一覧の権限の無い鍵）。無ければ今どおり「鍵は使えます」', async () => {
  let answer = { ok: true, code: 'no-model-read', message: 'OpenAI: 鍵は使えます（モデルの一覧を読む権限はありません）' };
  const l = await load(APP, { returns: {
    cloudStatus: () => status({ hasKey: true, provider: { id: 'openai', label: 'OpenAI', host: 'api.openai.com' } }),
    claudeStatus: () => ({ ok: true, found: true, method: 'claude.ai' }),
    cloudTestKey: () => answer,
  } });
  await l.drain();
  l.byId.get('sttKeyTest').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.byId.get('onlineMsg').textContent, 'OpenAI: 鍵は使えます（モデルの一覧を読む権限はありません）');
  assert.strictEqual(l.byId.get('onlineMsg').className, 'desc save-msg ok');
  answer = { ok: true };
  l.byId.get('sttKeyTest').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.byId.get('onlineMsg').textContent, '鍵は使えます');
  answer = { ok: false, code: 'quota', message: 'OpenAI: 残高が足りません（OpenAI の Billing を確かめてください）。' };
  l.byId.get('sttKeyTest').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.byId.get('onlineMsg').textContent, 'OpenAI: 残高が足りません（OpenAI の Billing を確かめてください）。');
  assert.strictEqual(l.byId.get('onlineMsg').className, 'desc save-msg ng');
});
