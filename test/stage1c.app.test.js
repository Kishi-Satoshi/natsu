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
const RETIRED_IDS = ['onlineAskNote', 'cloudTranscribe', 'sttProvider', 'sttBaseUrl', 'sttModel'];
const CLAUDE_OK = () => ({ ok: true, found: true, method: 'claude.ai' });

// 0.7.0 U-1（設計書 D5）で意図して変えた: 同意・送り先・URL・モデルの欄と案内の行を外した。
// 第1d回 A-4（RL10・F11）で意図して変えた: ［詳細設定（管理者用）］の鍵の欄（D5 の仮の欄）も消した。鍵の欄が無いことと、ログインのカード
// 「アカウント」は test/stage1d.app.test.js が見る
test('U-1・F11: カード「オンライン」に同意・送り先・URL・モデルの欄も鍵の欄も無く、初期化が最後まで走る', async () => {
  const l = await load(APP, { returns: { claudeStatus: () => ({ ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '' }) } });
  await l.drain();
  for (const id of RETIRED_IDS) assert.strictEqual(l.byId.get(id), undefined, `${id} がまだある`);
  assert.strictEqual(l.byId.get('sttKey'), undefined, '鍵の欄がまだある');
  assert.strictEqual(l.byId.get('claudeTest').closest('.card').querySelectorAll('details').length, 0, 'カード「オンライン」に詳細設定が残っている');
  assert.match(l.byId.get('claudeState').textContent, /ログイン済み（claude\.ai）/);
  assert.deepStrictEqual(l.errors.map(fmt), []);
  assert.deepStrictEqual(l.missingIds.filter((id) => RETIRED_IDS.includes(id)), [], '消した欄をまだ引いている');
});

test('OL5: Claude Code が見つからなければ main の文と、入れ方の説明（決まった命令）を出す', async () => {
  const l = await load(APP, { returns: {
    claudeStatus: () => ({ ok: true, found: false, cmdOnly: false, method: '', message: 'Claude Code が見つかりません' }),
  } });
  await l.drain();
  assert.match(l.byId.get('claudeState').textContent, /見つかりません/);
  assert.match(l.byId.get('claudeHelp').textContent, /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
});

// 0.7.0 U-1 で意図して変えた: 送り先は OpenAI だけなので、Groq の無料枠・費用の目安は書かない。1on1 の注意は残す（RF28）。
// 第1d回 A-4 で意図して変えた: 送り先は文字起こしの中継（その先は OpenAI）。管理者用の仮の欄の案内は無い
// 0.9.0 U-2（SP4・D24）で意図して変えた: 送り先の説明は「文字起こし」のカード（認識言語の欄のあるカード）、Claude Code の欄は「要約（Claude Code）」のカード。
// 文は今のまま。管理者用の仮の欄などが無いことは、両方のカードで見る
test('OL4・U-1・RL11: カードに送り先（中継と OpenAI）・オフラインのとき・1on1 の注意が書いてあり、「使う」を選ぶ・Groq・管理者用の仮の欄の話は無い', async () => {
  const l = await load(APP, { returns: { claudeStatus: CLAUDE_OK } });
  await l.drain();
  const t = l.byId.get('language').closest('.card').textContent + l.byId.get('claudeTest').closest('.card').textContent;
  for (const w of ['文字起こしの中継', 'OpenAI（gpt-4o-transcribe）', 'つながっていないときは、いつも PC の中で文字起こしします', '［オフラインモード］']) assert.ok(t.includes(w), w);
  for (const w of ['Groq', '「使う」', 'まだ決めていない', '管理者用の仮の欄']) assert.ok(!t.includes(w), `${w} が残っている`);
});

// 0.7.0 の後の直し: カードの頭の説明は、ほかの説明と同じく .field の中の .desc（.field .desc の 12px・薄い色。.field の下の間で
// 「要約（Claude Code）」の名前と離れる）。HTML の改行は画面で空白になるので、「します。」と「1on1」の間に空白を置かない
// 0.9.0 U-2 で意図して変えた: 説明は「文字起こし」のカードの頭（認識言語の欄の前）
// 0.9.2 I-2（計画 docs/plans/2026-10-21-092.md）で意図して変えた: 頭の説明は1行（.setlead の .desc）にし、長い文は見出しの ⓘ の吹き出し（#setPopStt）の
// 箇条書きにした。文の中に HTML の改行の空白が混ざらないことは、吹き出しの頭と箇条の1つずつで見る
test('OL4: カード「文字起こし」（前の「オンライン」）の頭の説明は .field の中の .desc（1行）で、長い文は吹き出しの箇条書き。どの文にも改行の空白が無い', async () => {
  const l = await load(APP, { returns: { claudeStatus: CLAUDE_OK } });
  await l.drain();
  const card = l.byId.get('language').closest('.card');
  const lead = card.querySelector('.setlead');
  assert.ok(lead, '頭の説明が無い');
  const desc = lead.querySelector('.desc');
  assert.ok(lead.classList.contains('field') && lead.parentNode === card, '頭の説明がカードの直下の .field に無い（.field .desc の書式と .field の下の間が効かない）');
  assert.ok(card.children.indexOf(lead) < card.children.indexOf(l.byId.get('language').closest('.field')), '頭の説明が「認識言語」の前に無い');
  assert.strictEqual(desc.textContent, 'つながっているときはクラウド、つながっていないときは PC の中で文字起こしします。');
  const pop = l.byId.get('setPopStt');
  for (const el of [pop.querySelector('.setpop-head'), ...pop.querySelectorAll('li')]) assert.ok(!/\s{2,}|\n/.test(el.textContent), `吹き出しの文に改行の空白がある: ${el.textContent}`);
  assert.ok(pop.querySelectorAll('li').some((li) => li.textContent.startsWith('1on1・面談')), '1on1 の注意の箇条が無い');
});

// ---- 計画の外で足した守り（Task C-2 の実装で決めたこと）----
// 0.7.0 U-1 で意図して変えた: 保存の値に送り先と同意の4つのキーは無い（main は読まない。前の版の値は settings.json に残る）。
// 第1d回 A-4: 鍵の欄が無くなったので、鍵を送らないことの確かめは外した（ログインのメールとコードを送らないことは stage1d.app が見る）
test('U-1: 設定の自動保存は送り先と同意のキーを送らない。Claude Code の場所を変えたら確かめ直す', async () => {
  const l = await load(APP, { returns: { claudeStatus: CLAUDE_OK } });
  await l.drain();
  l.byId.get('claudeExe').value = 'C:\\c\\claude.exe';
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  const sent = l.called('saveSettings').pop().args[0];
  assert.strictEqual(sent.claudeExe, 'C:\\c\\claude.exe');
  for (const k of ['cloudTranscribe', 'sttProvider', 'sttBaseUrl', 'sttModel']) assert.ok(!(k in sent), `保存の値に ${k} がある`);
  assert.strictEqual(l.called('claudeStatus').length, 2, 'Claude Code の場所を変えたのに確かめ直していない');
});

test('OL5: ［Claude Code を確かめる］で読み直し、ログイン済みでなければ main の文を出す（-p の口は画面に無い）', async () => {
  let n = 0;
  const l = await load(APP, { returns: {
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
  const odd = await load(APP, { returns: { claudeStatus: () => ({ ok: true, found: true, method: 'api_key', message: '' }) } });
  await odd.drain();
  assert.doesNotMatch(odd.byId.get('claudeState').textContent, /ログイン済み/);
  assert.ok(l.apis.koeApp.includes('claudeTest') && !l.apis.koeApp.some((k) => /^claude(Run|Summar)/i.test(k)), '画面から Claude Code の要約を呼べる口がある');
});

// 第1b回の続き Lane F-b: ［Claude Code を確かめる］は auth status の後に小さな本当の要求を1つ送る（main の claude:test）。
// 通れば「ログイン済み（確かめ済み）」、開いたときの自動の確かめ（claudeStatus。要求は送らない）は今の「ログイン済み（claude.ai）」のまま
test('Lane F-b: ［Claude Code を確かめる］で要求まで通れば「ログイン済み（確かめ済み）」、ログインが切れていれば main の文', async () => {
  let answer = { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '', verified: true };
  const l = await load(APP, { returns: {
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

// 0.7.0 U-1 で外した: 「OL3: 送り先を変えて設定が保存されると、鍵の状態を…聞き直し」（送り先を選ぶ欄が無くなった。鍵の状態は設定の保存のたびに今どおり聞き直す）

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
  assert.match(l.byId.get('meetingLocalOnlyNote').textContent, /オフラインモードです。この会議の音声は外へ送らず、PC の中で文字起こししています/);
  // 0.9.3 持ち主の答え D55 で足した: ボタンのあった所に押せない札「オフラインモード中」、記録の行の括弧に「オフライン」（戻すボタンは今どおり無い）
  assert.strictEqual(l.byId.get('meetingLocalOnlyState').hidden, false, '押した後に札「オフラインモード中」が無い');
  assert.strictEqual(l.byId.get('meetingLocalOnlyStateText').textContent, 'オフラインモード中');
  assert.strictEqual(l.byId.get('liveTitle').textContent, '議事録を記録中（オフライン）');
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
  assert.strictEqual(l.byId.get('meetingLocalOnlyState').hidden, true, '次の会議なのに札「オフラインモード中」が出ている（0.9.3 D55）');
  assert.strictEqual(l.byId.get('liveTitle').textContent, '議事録を記録中', '次の会議なのに記録の行に「オフライン」がある（0.9.3 D55）');
  l.fire('onMeetingUpdate', { active: true, segments: [], localOnly: false, cloud: false });
  await l.drain();
  assert.strictEqual(l.byId.get('meetingLocalOnly').hidden, true, 'クラウドで処理しない PC（OpenAI の鍵が無い）なのにボタンが出ている');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// 0.7.0 U-1 で外した: 「OL4: 同意をまだ決めていないときだけ…案内の行が出る」（同意の選択と案内の行を外した。無いことは上の U-1 のテスト）

// 第1b回の続き Lane F-c・F-d: 利用者は PowerShell を打たない。カード「オンライン」の［Claude Code にログイン］（見つかったとき）と
// ［Claude Code を入れる］（見つからない・claude.cmd しか無いとき）で、main が見える窓を開き、閉じたら確かめ直した答えで描き直す
test('Lane F-c・F-d: ［Claude Code にログイン］は見つかったときだけ、［Claude Code を入れる］は見つからない・claude.cmd だけのときだけ出る', async () => {
  const shown = async (st) => {
    const l = await load(APP, { returns: { claudeStatus: () => st } });
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
