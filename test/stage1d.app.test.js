/*
 * stage1d.app.test.js — 第1d回の画面（app.html）の確かめ（最小 DOM（helpers/simrun.js）の上で画面の <script> を本当に走らせる）
 * A-9（RL16・F16・RF41）: ［更新して再起動］で取り込みが通っても、restart が断ったら文を出してボタンを戻し、次は取り込み直さずに restart だけ。
 * A-4（RL10・RL11・F5・F11）: 設定のカード「アカウント」（メール → 確認コード → ログイン中・ログアウト）、ログイン切れの知らせの
 * ［ログインし直す］、0.7.0 の管理者用の鍵の欄が無いこと。main の答えは偽物（preload.js の名前から作る）。文は main が返す message を
 * そのまま出すので、試験の文は本物の文（mainlib.accountMessage）と、画面が作れない印の文の両方で見る。
 * A-7（RL14・D17・F14）: 録音中のページの文字起こしの状態の行（#liveStt）と頭の帯（#liveSttBanner）。main の meetingStatus().stt を
 * そのまま描く（帯の文は main の text）。ボタンは［もう一度］（meetingRetry を1回）・［ログインし直す］・［エンジンを確かめる］。
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

// ---------------------------------------------------------------- 第1d回 A-4（RL10・RL11・F5・F11）
const lib = require('../src/mainlib');

const fmt = (e) => `${e.constructor.name}: ${e.message}`;
// テストのファイルにメールアドレスの形の文字を書かない（公開前の確認）
const mail = (local) => local + String.fromCharCode(64) + 'example.com';
const M = mail('kaigi');
const R1 = '会社のメールアドレスでログインすると、インターネットにつながっているときに、会議と音声入力の音声を文字起こしの中継に送り、OpenAI で文字起こしします。ログインしていないときと、つながっていないときは、PC の中で文字起こしします。';
const R3 = (m) => `${m} に 6 けたの確認コードを送りました（10 分の間だけ使えます）。届かないときは迷惑メールのフォルダも見てください。`;
const ONLINE = 'ログインしていて、インターネットにつながっているときは、会議と音声入力の音声を文字起こしの中継に送り、OpenAI（gpt-4o-transcribe）で文字起こしします。中継も OpenAI も、音声と文字を保存しません。つながっていないときは、いつも PC の中で文字起こしします。1on1・面談など外に出したくない会議は、議事録の画面の［この会議は PC の中だけ］を押してください。';
const L3 = 'ログインが切れたため、PC の中で文字起こししています。設定の「アカウント」でもう一度ログインしてください。';
const CLAUDE = () => ({ ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '' });
const status = (o = {}) => ({ ok: true, signedIn: false, email: '', method: 'email', canStore: true, online: { up: true, why: 'ok' }, ...o });
const RETIRED = ['onlineAdv', 'sttKey', 'sttKeySave', 'sttKeyTest', 'sttKeyClear', 'sttKeyState'];

// 要素とその祖先のどれにも hidden が無い（画面に出ている）
const shown = (el) => { for (let n = el; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) if (n.hidden) return false; return true; };
const click = async (l, id) => { l.byId.get(id).dispatchEvent({ type: 'click' }); await l.drain(); };

// ログインの流れを覚える偽の main（start・verify・logout の答えは差し替えられる）
function fakeMain(over = {}) {
  const st = { signedIn: false, email: '' };
  return {
    st,
    returns: {
      claudeStatus: CLAUDE,
      accountStatus: () => status({ signedIn: st.signedIn, email: st.signedIn ? st.email : '' }),
      accountStart: () => ({ ok: true }),
      accountVerify: (email) => { st.signedIn = true; st.email = email; return { ok: true, email }; },
      accountLogout: () => { st.signedIn = false; st.email = ''; return { ok: true, message: lib.accountMessage('logout') }; },
      ...over,
    },
  };
}

test('RL10: 設定の2つ目のカードが「アカウント」（1つ目は外観）。ログインしていなければメールの欄と［確認コードを送る］、送れたら R3 とコードの欄・［ログイン］［コードを送り直す］、ログインしたら R11 と［ログアウト］', async () => {
  const f = fakeMain();
  const l = await load(APP, { returns: f.returns });
  await l.drain();
  assert.deepStrictEqual(l.errors.map(fmt), []);
  const cards = l.byId.get('tabSettings').querySelectorAll('.card');
  assert.strictEqual(cards[0].id, 'appearanceCard', '1つ目のカードが外観でない');
  assert.strictEqual(cards[1].id, 'accountCard', '2つ目のカードがアカウントでない');
  assert.strictEqual(cards[1].querySelector('h2').textContent.trim(), 'アカウント');
  assert.ok(cards[1].textContent.includes(R1), 'カードの説明（R1）が無い');
  // ログインしていない: メールの欄と［確認コードを送る］だけ
  assert.strictEqual(l.byId.get('accountEmail').closest('.card'), cards[1]);
  assert.ok(shown(l.byId.get('accountEmail')) && shown(l.byId.get('accountSend')));
  assert.strictEqual(l.byId.get('accountSend').textContent.trim(), '確認コードを送る');
  assert.ok(l.byId.get('tabSettings').querySelectorAll('label').some((x) => x.getAttribute('for') === 'accountEmail' && x.textContent.trim() === 'メールアドレス'), '欄の名前「メールアドレス」が無い');
  assert.ok(!shown(l.byId.get('accountCode')) && !shown(l.byId.get('accountLogin')) && !shown(l.byId.get('accountLogout')), 'ログインしていないのにコードの欄かログアウトが出ている');
  // 送れた: R3 とコードの欄・［ログイン］［コードを送り直す］
  l.byId.get('accountEmail').value = ` ${M} `;
  await click(l, 'accountSend');
  assert.deepStrictEqual(l.called('accountStart').map((c) => c.args), [[M]]);
  assert.strictEqual(l.byId.get('accountSent').textContent, R3(M));
  assert.ok(shown(l.byId.get('accountSent')) && shown(l.byId.get('accountCode')) && shown(l.byId.get('accountLogin')) && shown(l.byId.get('accountResend')));
  assert.ok(l.byId.get('tabSettings').querySelectorAll('label').some((x) => x.getAttribute('for') === 'accountCode' && x.textContent.trim() === '確認コード'), '欄の名前「確認コード」が無い');
  assert.strictEqual(l.byId.get('accountLogin').textContent.trim(), 'ログイン');
  assert.strictEqual(l.byId.get('accountResend').textContent.trim(), 'コードを送り直す');
  assert.strictEqual(l.document.activeElement, l.byId.get('accountCode'), '送れた後にコードの欄へフォーカスが行かない');
  // ［コードを送り直す］はメールの欄のメールでもう一度頼む
  await click(l, 'accountResend');
  assert.deepStrictEqual(l.called('accountStart').map((c) => c.args), [[M], [M]]);
  // ログインした: R11 と［ログアウト］。メールとコードの欄は出ない
  l.byId.get('accountCode').value = '123456';
  await click(l, 'accountLogin');
  assert.deepStrictEqual(l.called('accountVerify').map((c) => c.args), [[M, '123456']]);
  assert.strictEqual(l.byId.get('accountWho').textContent, `ログイン中: ${M}`);
  assert.ok(shown(l.byId.get('accountWho')) && shown(l.byId.get('accountLogout')));
  assert.strictEqual(l.byId.get('accountLogout').textContent.trim(), 'ログアウト');
  assert.ok(!shown(l.byId.get('accountEmail')) && !shown(l.byId.get('accountCode')), 'ログインしたのにメールかコードの欄が出ている');
  // ログアウト: main の文（R12）を出し、メールの欄に戻る（コードの欄は出ない）
  await click(l, 'accountLogout');
  assert.strictEqual(l.called('accountLogout').length, 1);
  assert.strictEqual(l.byId.get('accountMsg').textContent, lib.accountMessage('logout'));
  assert.ok(shown(l.byId.get('accountEmail')) && !shown(l.byId.get('accountCode')) && !shown(l.byId.get('accountLogout')));
  // 設定を開くたびに main の写しを聞き直す（外へは通信しない口: account:status）
  const before = l.called('accountStatus').length;
  await click(l, 'tabBtnSettings');
  assert.strictEqual(l.called('accountStatus').length, before + 1, '設定を開いたのに状態を聞き直していない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('RL10: 開いたときにログイン中なら R11 と［ログアウト］だけを出す（メールは main の写し）', async () => {
  const f = fakeMain();
  f.st.signedIn = true; f.st.email = M;
  const l = await load(APP, { returns: f.returns });
  await l.drain();
  assert.strictEqual(l.byId.get('accountWho').textContent, `ログイン中: ${M}`);
  assert.ok(shown(l.byId.get('accountLogout')) && !shown(l.byId.get('accountEmail')));
  // 答えが読めない（古い main・投げた）ときもメールの欄を出し、初期化は最後まで走る
  const odd = await load(APP, { returns: { claudeStatus: CLAUDE, accountStatus: () => { throw new Error('x'); } } });
  await odd.drain();
  assert.ok(shown(odd.byId.get('accountEmail')) && !shown(odd.byId.get('accountLogout')));
  assert.deepStrictEqual(odd.errors.map(fmt), []);
});

test('RL10: ［ログイン］を押したらコードの欄を空にする（成功でも失敗でも）。メールの欄は残す', async () => {
  let answer = { ok: false, code: 'code', left: 4, message: lib.accountMessage('code', { left: 4 }) };
  const f = fakeMain({ accountVerify: (email) => { const a = answer; if (a.ok) { f.st.signedIn = true; f.st.email = email; } return a; } });
  const l = await load(APP, { returns: f.returns });
  await l.drain();
  l.byId.get('accountEmail').value = M;
  await click(l, 'accountSend');
  l.byId.get('accountCode').value = '000000';
  await click(l, 'accountLogin');
  assert.strictEqual(l.byId.get('accountCode').value, '', '違うコードが欄に残っている');
  assert.strictEqual(l.byId.get('accountEmail').value, M, 'メールの欄を消した');
  assert.strictEqual(l.byId.get('accountMsg').textContent, '確認コードが違います（あと 4 回試せます）。メールの 6 けたを入れ直してください。');
  assert.match(l.byId.get('accountMsg').className, /\bng\b/);
  assert.ok(shown(l.byId.get('accountCode')), '違うコードの後にコードの欄が消えた（入れ直せない）');
  answer = { ok: true, email: M };
  l.byId.get('accountCode').value = '123456';
  await click(l, 'accountLogin');
  assert.strictEqual(l.byId.get('accountCode').value, '', 'ログインした後もコードが欄に残っている');
  assert.strictEqual(l.byId.get('accountMsg').textContent, '', 'ログインした後も前の断りの文が残っている');
  assert.deepStrictEqual(l.called('accountVerify').map((c) => c.args), [[M, '000000'], [M, '123456']]);
});

test('RL10: ［ログイン］は確認コードを送ったメールで確かめる（送った後にメールの欄を書き換えても、コードの無い宛先へ送らない）', async () => {
  const f = fakeMain();
  const l = await load(APP, { returns: f.returns });
  await l.drain();
  l.byId.get('accountEmail').value = M;
  await click(l, 'accountSend');
  l.byId.get('accountEmail').value = mail('betsu');
  l.byId.get('accountCode').value = '123456';
  await click(l, 'accountLogin');
  assert.deepStrictEqual(l.called('accountVerify').map((c) => c.args), [[M, '123456']], '確認コードを送っていないメールで確かめた');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('RL10: main の答えの code ごとに R4〜R16 の文を出す（文は main が返す message をそのまま）', async () => {
  const host = 'natsu-relay.-unset-.workers.dev';
  const startCodes = ['domain', 'bad-email', 'rate', 'mail', 'mail-cap', 'offline', 'net', 'timeout', 'cert', 'proxy', 'not-ready', 'server'];
  for (const code of startCodes) {
    const message = lib.accountMessage(code, { host, retryAfter: 600 });
    const l = await load(APP, { returns: fakeMain({ accountStart: () => ({ ok: false, code, message }) }).returns });
    await l.drain();
    l.byId.get('accountEmail').value = M;
    await click(l, 'accountSend');
    assert.strictEqual(l.byId.get('accountMsg').textContent, message, code);
    assert.match(l.byId.get('accountMsg').className, /\bng\b/, code);
    assert.ok(!shown(l.byId.get('accountCode')), `${code}: 送れなかったのにコードの欄が出た`);
  }
  for (const code of ['code', 'code-expired', 'blocked', 'store', 'bad-code', 'rate', 'offline', 'cert']) {
    const message = lib.accountMessage(code, { host, left: 2, retryAfter: 120 });
    const l = await load(APP, { returns: fakeMain({ accountVerify: () => ({ ok: false, code, message }) }).returns });
    await l.drain();
    l.byId.get('accountEmail').value = M;
    await click(l, 'accountSend');
    l.byId.get('accountCode').value = '123456';
    await click(l, 'accountLogin');
    assert.strictEqual(l.byId.get('accountMsg').textContent, message, code);
    assert.ok(!shown(l.byId.get('accountLogout')), `${code}: 断られたのにログイン中の形になった`);
  }
  // 画面は文を作らない: main の文がそのまま出る（画面の中の表から引かない）
  const odd = '（main の文: 印 7f3a）';
  const l = await load(APP, { returns: fakeMain({ accountStart: () => ({ ok: false, code: 'domain', message: odd }) }).returns });
  await l.drain();
  l.byId.get('accountEmail').value = M;
  await click(l, 'accountSend');
  assert.strictEqual(l.byId.get('accountMsg').textContent, odd);
  // ログアウトで PC の札を消せなかった（R15 の文）: 文を出して、ログイン中の形のまま
  const f = fakeMain({ accountLogout: () => ({ ok: false, code: 'write', message: lib.accountMessage('write') }) });
  f.st.signedIn = true; f.st.email = M;
  const w = await load(APP, { returns: f.returns });
  await w.drain();
  await click(w, 'accountLogout');
  assert.strictEqual(w.byId.get('accountMsg').textContent, lib.accountMessage('write'));
  assert.match(w.byId.get('accountMsg').className, /\bng\b/);
  assert.ok(shown(w.byId.get('accountLogout')));
});

test('RL10: Enter でも送れる。IME の確定の Enter では送らない（imeEnter）', async () => {
  const l = await load(APP, { returns: fakeMain().returns });
  await l.drain();
  const email = l.byId.get('accountEmail');
  email.value = M;
  l.key({ key: 'Enter', isComposing: true }, email);
  l.key({ key: 'Enter', keyCode: 229 }, email);
  await l.drain();
  assert.strictEqual(l.called('accountStart').length, 0, '変換の確定の Enter で送った');
  const ev = l.key({ key: 'Enter' }, email);
  await l.drain();
  assert.deepStrictEqual(l.called('accountStart').map((c) => c.args), [[M]]);
  assert.strictEqual(ev.defaultPrevented, true);
  const code = l.byId.get('accountCode');
  code.value = '１２３４５６';
  l.key({ key: 'Enter', isComposing: true }, code);
  await l.drain();
  assert.strictEqual(l.called('accountVerify').length, 0, '変換の確定の Enter でログインした');
  l.key({ key: 'Enter' }, code);
  await l.drain();
  // 全角の数字の直しは main がする（画面はそのまま渡す）
  assert.deepStrictEqual(l.called('accountVerify').map((c) => c.args), [[M, '１２３４５６']]);
  assert.strictEqual(code.value, '');
  // ほかのキーでは送らない
  l.key({ key: 'a' }, l.byId.get('accountEmail'));
  await l.drain();
  assert.strictEqual(l.called('accountStart').length, 1);
});

test('RL10: 送っている間はボタンを止め、2回押しても1回だけ送る。メールとコードは設定の自動保存に混ざらない', async () => {
  let release = null;
  const f = fakeMain({ accountStart: () => new Promise((r) => { release = () => r({ ok: true }); }) });
  const l = await load(APP, { returns: f.returns });
  await l.drain();
  l.byId.get('accountEmail').value = M;
  l.byId.get('accountSend').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.byId.get('accountSend').disabled, true, '送っている間に［確認コードを送る］を押せる');
  l.byId.get('accountSend').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.called('accountStart').length, 1, '2回押して2回頼んだ');
  release();
  await l.drain();
  assert.strictEqual(l.byId.get('accountSend').disabled, false);
  l.byId.get('accountCode').value = '654321';
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  const sent = l.called('saveSettings').pop().args[0];
  assert.ok(!JSON.stringify(sent).includes('654321') && !JSON.stringify(sent).includes('example.com'), '設定の保存にメールかコードが混ざった');
  assert.ok(!('accountEmail' in sent), '設定の保存に accountEmail を送った（main は画面のメールを使わない）');
});

test('F11: ［詳細設定（管理者用）］・鍵の欄・3つのボタンが無い。カード「オンライン」の説明は新しい文', async () => {
  const l = await load(APP, { returns: fakeMain().returns });
  await l.drain();
  for (const id of RETIRED) assert.strictEqual(l.byId.get(id), undefined, `${id} がまだある`);
  assert.deepStrictEqual(l.missingIds.filter((id) => RETIRED.includes(id)), [], '消した欄をまだ引いている');
  const card = l.byId.get('claudeTest').closest('.card');
  assert.strictEqual(card.querySelector('h2').textContent.trim(), 'オンライン');
  const t = l.byId.get('tabSettings').textContent;
  for (const w of ['詳細設定（管理者用）', '管理者用の仮の欄', 'OpenAI の鍵', '鍵を確かめる', '鍵を消す', 'API キー']) assert.ok(!t.includes(w), `${w} が残っている`);
  const desc = card.querySelectorAll('.desc').find((d) => d.textContent.includes('文字起こしの中継'));
  assert.ok(desc, 'カード「オンライン」の説明が無い');
  assert.strictEqual(desc.textContent.replace(/\s+/g, ' ').trim(), ONLINE);
  assert.strictEqual(desc.textContent, ONLINE, '説明の中に改行か空白が混ざった（HTML の改行は画面で空白になる）');
  // 画面は鍵の口を呼ばない（preload にも無い）
  for (const n of ['cloudStatus', 'cloudSetKey', 'cloudTestKey', 'cloudClearKey']) assert.ok(!l.apis.koeApp.includes(n), `preload に ${n} が残っている`);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('F5: app:notice が { text, action: \'account\' } のとき、トーストに［ログインし直す］があり、押すと設定の「アカウント」のカードが開いてメールの欄にフォーカスが行く。文字だけの知らせは今のまま', async () => {
  const l = await load(APP, { returns: fakeMain().returns });
  await l.drain();
  await click(l, 'tabBtnNotes');
  const toastEl = l.byId.get('toast');
  // 文字だけの知らせ: 文だけで、ボタンは無い
  l.fire('onNotice', '要約を作りました');
  await l.drain();
  assert.strictEqual(toastEl.textContent, '要約を作りました');
  assert.strictEqual(toastEl.querySelectorAll('button').length, 0, '文字だけの知らせにボタンが付いた');
  // ログイン切れ（L3）: 文と［ログインし直す］
  const n = l.called('accountStatus').length;
  l.fire('onNotice', { text: L3, action: 'account' });
  await l.drain();
  assert.ok(toastEl.textContent.startsWith(L3), `知らせの文が違う: ${toastEl.textContent}`);
  assert.ok(!toastEl.textContent.includes('[object Object]'));
  const btns = toastEl.querySelectorAll('button');
  assert.strictEqual(btns.length, 1);
  assert.strictEqual(btns[0].textContent, 'ログインし直す');
  assert.ok(toastEl.classList.contains('show') && toastEl.classList.contains('act'), '押せる形（act）になっていない');
  assert.ok(!l.byId.get('tabSettings').classList.contains('active'), '押す前に設定を開いた');
  btns[0].dispatchEvent({ type: 'click' });
  await l.drain();
  assert.ok(l.byId.get('tabSettings').classList.contains('active'), '設定が開かない');
  assert.ok(l.called('accountStatus').length > n, '開いたのにログインの状態を聞き直していない');
  assert.strictEqual(l.document.activeElement, l.byId.get('accountEmail'), 'メールの欄にフォーカスが行かない');
  assert.ok(!toastEl.classList.contains('show'), '押した後も知らせが残っている');
  // 次の文字だけの知らせには、前のボタンが残らない
  l.fire('onNotice', 'コピーしました');
  await l.drain();
  assert.strictEqual(toastEl.querySelectorAll('button').length, 0, '前の知らせのボタンが残った');
  assert.ok(!toastEl.classList.contains('act'));
  // 知らない action と文の無い形は、文字だけとして出す（画面を壊さない）
  l.fire('onNotice', { text: '知らない形', action: 'zzz' });
  await l.drain();
  assert.strictEqual(toastEl.textContent, '知らない形');
  assert.strictEqual(toastEl.querySelectorAll('button').length, 0);
  // 「未設定」の知らせは今どおりエンジンの設定を開く
  l.fire('onNotice', 'エンジンが未設定です');
  await l.drain();
  assert.strictEqual(l.byId.get('engineAdv').open, true);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- 第1d回 A-7（RL14・D17・F14）
// 録音中のページの状態の行（#liveStt）と帯（#liveSttBanner）。main の meetingStatus().stt（A-6）をそのまま描く（文は main の text）
const T0 = Date.UTC(2026, 9, 19, 1, 0, 0);
const LIVE = (stt, o = {}) => ({ active: true, finalizing: false, startedAt: T0 - 60000, memo: '', segments: [], pending: 0, stoppedAt: null,
  stopping: false, paused: false, pausedMs: 0, systemAudio: false, micFallback: false, etaSec: null, skipped: 0, pauses: [], pausing: false,
  resumeHint: false, localOnly: false, cloud: true, stt, ...o });
const PROB = (code, action, text) => LIVE({ route: 'local', lastTextAt: T0 - 5000, segSec: 15, problem: { code, action, text } });
// 次の要素（simdom には nextElementSibling が無いので、親の子の並びから引く）
const nextEl = (el) => { const kids = el.parentNode.children; return kids[kids.indexOf(el) + 1] || null; };
// 今の木の中にその id の要素があるか（会議が終わって外した要素は数えない）
const inTree = (l, id) => l.root.querySelectorAll(`#${id}`).length > 0;

test('D17: 録音中のページの状態の行（クラウド・この PC・最初の文字を待っています・1 分を越えたら分。一時停止では隠す）', { timeout: 5000 }, async () => {
  const l = await load(APP, { now: T0 });
  l.fire('onMeetingUpdate', LIVE({ route: 'cloud', lastTextAt: T0 - 12000, segSec: 15, problem: null })); await l.drain();
  assert.strictEqual(l.byId.get('liveStt').textContent, '文字起こし中（クラウド）・最後の文字 12 秒前');
  // 状態の行は #liveTitle の行のすぐ下（1行目の時計の後の最初の説明の行）
  const stt = l.byId.get('liveStt');
  assert.strictEqual(stt.parentNode, l.byId.get('liveBar'));
  assert.strictEqual(nextEl(l.document.getElementById('liveTm')), stt, '状態の行が記録の行の1行目のすぐ下に無い');
  assert.strictEqual(stt.hidden, false);
  await l.clock.advance(60000);
  assert.strictEqual(l.byId.get('liveStt').textContent, '文字起こし中（クラウド）・最後の文字 1 分前');
  l.fire('onMeetingUpdate', LIVE({ route: 'local', lastTextAt: null, segSec: 75, problem: null })); await l.drain();
  assert.strictEqual(l.byId.get('liveStt').textContent, '文字起こし中（この PC）・最初の文字を待っています');
  l.fire('onMeetingUpdate', LIVE({ route: 'local', lastTextAt: null, segSec: 75, problem: null }, { paused: true })); await l.drain();
  assert.strictEqual(l.byId.get('liveStt').hidden, true);
  assert.strictEqual(l.byId.get('liveStt').getAttribute('aria-live'), null);
  // 再開すれば出る。stt の無い古い main の答えでは隠す（画面を壊さない）
  l.fire('onMeetingUpdate', LIVE({ route: 'local', lastTextAt: T0, segSec: 75, problem: null })); await l.drain();
  assert.strictEqual(l.byId.get('liveStt').hidden, false);
  l.fire('onMeetingUpdate', LIVE(undefined)); await l.drain();
  assert.strictEqual(l.byId.get('liveStt').hidden, true);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('D17: 帯は #liveBar の上に1つ。文は main の text のまま、ボタンは action ごとに1つ。problem が null になると消える', { timeout: 5000 }, async () => {
  const l = await load(APP, { now: T0 });
  l.fire('onMeetingUpdate', PROB('relay-down', '', '中継につながりません。PC の中で文字起こしを続けています。録音はそのまま続けてください。')); await l.drain();
  const b = l.byId.get('liveSttBanner');
  assert.strictEqual(b.hidden, false);
  assert.strictEqual(b.getAttribute('role'), 'alert');
  assert.strictEqual(nextEl(b), l.byId.get('liveBar'), '帯が録音中のページの頭（#liveBar の上）に無い');
  assert.strictEqual(l.root.querySelectorAll('.stt-banner').length, 1, '帯が2つ以上ある');
  assert.strictEqual(l.byId.get('liveSttBannerText').textContent, '中継につながりません。PC の中で文字起こしを続けています。録音はそのまま続けてください。');
  assert.strictEqual(l.byId.get('liveSttBannerBtn').hidden, true);
  // F15: 区間ごとの meeting:update で同じ帯の文を書き直さない（role="alert" は書き直すたびに読み上げ直されることがある）。
  // simdom の textContent の代入は子の並びを作り直すので、並びが同じなら書いていない（A-7 の点検で足した）
  const kids = l.byId.get('liveSttBannerText').childNodes;
  l.fire('onMeetingUpdate', { ...PROB('relay-down', '', '中継につながりません。PC の中で文字起こしを続けています。録音はそのまま続けてください。'), segments: [{ atMs: 0, text: '区間', failed: false }] }); await l.drain();
  assert.strictEqual(l.byId.get('liveSttBannerText').childNodes, kids, '同じ帯の文を区間の知らせのたびに書き直した');
  for (const [action, label] of [['retry', 'もう一度'], ['account', 'ログインし直す'], ['engine', 'エンジンを確かめる']]) {
    l.fire('onMeetingUpdate', PROB('x', action, '文')); await l.drain();
    assert.strictEqual(l.byId.get('liveSttBannerBtn').textContent, label, action);
    assert.strictEqual(l.byId.get('liveSttBannerBtn').hidden, false, action);
  }
  // 画面は文を作らない: main の文がそのまま出る（符号から画面の中の表を引かない）
  const odd = '（main の文: 印 5c1e）';
  l.fire('onMeetingUpdate', PROB('relay-down', '', odd)); await l.drain();
  assert.strictEqual(l.byId.get('liveSttBannerText').textContent, odd);
  assert.strictEqual(l.byId.get('liveSttBannerBtn').hidden, true, 'action が空なのにボタンが残った');
  l.fire('onMeetingUpdate', LIVE({ route: 'cloud', lastTextAt: T0, segSec: 15, problem: null })); await l.drain();
  assert.strictEqual(b.hidden, true, '戻ったのに帯が残った');
  assert.strictEqual(l.root.querySelectorAll('.stt-banner').length, 1, '帯を作り直して増やした');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('D17: ［もう一度］は meetingRetry を1回だけ呼び、返事まで押せない', { timeout: 5000 }, async () => {
  let release = null;
  const l = await load(APP, { now: T0, returns: { meetingRetry: () => new Promise((r) => { release = () => r({ ok: true, n: 2 }); }) } });
  l.fire('onMeetingUpdate', PROB('seg-failed', 'retry', '2 区間の文字起こしに失敗しました（音声は残してあります）。［もう一度］を押してください。')); await l.drain();
  const btn = l.byId.get('liveSttBannerBtn');
  assert.strictEqual(btn.textContent, 'もう一度');
  btn.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(btn.disabled, true, '返事を待つ間に押せる');
  btn.dispatchEvent({ type: 'click' }); await l.drain();
  // 返事の前に main の知らせ（同じ帯）が来ても、押せるようには戻さない
  l.fire('onMeetingUpdate', PROB('seg-failed', 'retry', '2 区間の文字起こしに失敗しました（音声は残してあります）。［もう一度］を押してください。')); await l.drain();
  assert.strictEqual(btn.disabled, true, '返事の前の知らせで押せるように戻った');
  btn.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('meetingRetry').length, 1, '返事の前に2回呼んだ');
  release(); await l.drain();
  assert.strictEqual(btn.disabled, false, '返事の後も押せない');
  btn.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('meetingRetry').length, 2);
  release(); await l.drain();
  // 投げても押せるように戻る
  const t = await load(APP, { now: T0, returns: { meetingRetry: () => { throw new Error('x'); } } });
  t.fire('onMeetingUpdate', PROB('stall', 'retry', '文')); await t.drain();
  t.byId.get('liveSttBannerBtn').dispatchEvent({ type: 'click' }); await t.drain();
  assert.strictEqual(t.byId.get('liveSttBannerBtn').disabled, false);
  assert.deepStrictEqual([...l.errors, ...t.errors].map(fmt), []);
});

test('D17: ［ログインし直す］は設定の『アカウント』を開いてメールの欄にフォーカス。［エンジンを確かめる］は詳細設定の『文字起こし』を開く', { timeout: 5000 }, async () => {
  const l = await load(APP, { now: T0, returns: fakeMain().returns });
  l.fire('onMeetingUpdate', PROB('login', 'account', 'ログインが切れたため、PC の中で文字起こししています。［ログインし直す］を押して、もう一度ログインしてください。')); await l.drain();
  assert.ok(!l.byId.get('tabSettings').classList.contains('active'));
  const n = l.called('accountStatus').length;
  await click(l, 'liveSttBannerBtn');
  assert.ok(l.byId.get('tabSettings').classList.contains('active'), '設定が開かない');
  assert.ok(l.called('accountStatus').length > n, '開いたのにログインの状態を聞き直していない');
  assert.strictEqual(l.document.activeElement, l.byId.get('accountEmail'), 'メールの欄にフォーカスが行かない');
  assert.strictEqual(l.called('meetingRetry').length, 0);
  const e = await load(APP, { now: T0 });
  e.fire('onMeetingUpdate', PROB('engine-down', 'engine', 'PC の中の文字起こしエンジンが動いていません（音声は残してあります）。［エンジンを確かめる］を押してください。')); await e.drain();
  assert.strictEqual(e.byId.get('engineAdv').open, undefined, '押す前に詳細設定が開いている');
  await click(e, 'liveSttBannerBtn');
  assert.ok(e.byId.get('tabSettings').classList.contains('active'), '設定が開かない');
  assert.strictEqual(e.byId.get('engineAdv').open, true, '詳細設定（文字起こし）が開かない');
  assert.deepStrictEqual([...l.errors, ...e.errors].map(fmt), []);
});

test('D17: 会議が終わる（active: false）と帯も状態の行も消える', { timeout: 5000 }, async () => {
  const l = await load(APP, { now: T0 });
  l.fire('onMeetingUpdate', PROB('relay-down', '', '文')); await l.drain();
  assert.ok(inTree(l, 'liveStt') && inTree(l, 'liveSttBanner'));
  l.fire('onMeetingUpdate', { active: false, finalizing: false, paused: false, startedAt: null, segments: [], stt: null }); await l.drain();
  assert.ok(!inTree(l, 'liveSttBanner'), '会議が終わったのに帯が残った');
  assert.ok(!inTree(l, 'liveStt'), '会議が終わったのに状態の行が残った');
  assert.ok(!inTree(l, 'liveBar'));
  // 時計が進んでも投げない（片付けた行を描きに行かない）
  await l.clock.advance(2000);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('D17: 帯は録音中のタブだけのもの。ほかのページのタブを開くと記録の行と一緒に隠れ、録音中のタブに戻ると出る', { timeout: 5000 }, async () => {
  const PAGES = [{ id: 'pa1', title: '定例（見本）', date: '10/16', durationSec: 1800, hasSummary: true }];
  const pageGet = (id) => ({ page: { id, title: '定例（見本）', createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
  const l = await load(APP, { now: T0, returns: { pagesSearch: () => PAGES, pageGet } });
  await l.drain();
  l.fire('onMeetingUpdate', PROB('relay-down', '', '文')); await l.drain();
  assert.strictEqual(l.byId.get('liveSttBanner').hidden, false);
  await click(l, 'tabBtnNotes');
  const item = l.root.querySelector('#plist .pitem');
  assert.ok(item, '一覧にページが無い（simrun の見本）');
  item.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.byId.get('liveBar').hidden, true);
  assert.strictEqual(l.byId.get('liveSttBanner').hidden, true, 'ほかのページのタブに帯が出ている');
  l.fire('onMeetingUpdate', PROB('relay-down', '', '文')); await l.drain();
  assert.strictEqual(l.byId.get('liveSttBanner').hidden, true, 'ほかのページのタブで、知らせのたびに帯が出た');
  const liveTab = l.root.querySelectorAll('[data-key]').find((x) => x.dataset.key === 'live');
  assert.ok(liveTab, '録音中のタブが無い');
  liveTab.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.byId.get('liveSttBanner').hidden, false, '録音中のタブに戻っても帯が出ない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- A-8（RL15・D17・F15）: 録音中のページが見えているかを main へ知らせる
test('D17: 録音中のタブを開くと meetingLiveShown(true)、ほかのタブ・ページへ移ると false、visibilitychange で隠れると false。onShowLive で録音中のタブが開く', { timeout: 5000 }, async () => {
  const PAGES = [{ id: 'pa1', title: '定例（見本）', date: '10/16', durationSec: 1800, hasSummary: true }];
  const pageGet = (id) => ({ page: { id, title: '定例（見本）', createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
  const l = await load(APP, { now: T0, returns: { pagesSearch: () => PAGES, pageGet } });
  await l.drain();
  const sent = () => l.called('meetingLiveShown').map((c) => c.args[0]);
  const lastSent = () => sent()[sent().length - 1];
  const liveTab = () => l.root.querySelectorAll('[data-key]').find((x) => x.dataset.key === 'live');
  const vis = async (state) => { l.document.visibilityState = state; l.key({ type: 'visibilitychange' }); await l.drain(); };
  assert.notStrictEqual(lastSent(), true, '会議の前から録音中のページを開いていると知らせた');
  l.fire('onMeetingUpdate', PROB('relay-down', '', '文')); await l.drain();
  assert.strictEqual(lastSent(), true, '録音中のタブを開いたのに知らせない');
  // 知らせるのは変わったときだけ（meeting:update のたびに送らない）
  const n = sent().length;
  l.fire('onMeetingUpdate', PROB('relay-down', '', '文')); await l.drain();
  assert.strictEqual(sent().length, n, '変わっていないのに送った');
  await click(l, 'tabBtnSettings');
  assert.strictEqual(lastSent(), false, '設定のタブへ移ったのに録音中のページを開いているまま');
  liveTab().dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(lastSent(), true);
  await click(l, 'tabBtnNotes');
  l.root.querySelector('#plist .pitem').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(lastSent(), false, 'ほかのページのタブへ移ったのに録音中のページを開いているまま');
  liveTab().dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(lastSent(), true);
  await vis('hidden');
  assert.strictEqual(lastSent(), false, '窓が隠れたのに録音中のページを開いているまま');
  await vis('visible');
  assert.strictEqual(lastSent(), true, '窓が見えるようになったのに知らせない');
  const m = sent().length;
  await vis('visible');
  assert.strictEqual(sent().length, m, '見えたままの visibilitychange でも送った（変わったときだけ）');
  // 知らせを押した（main の meeting:show-live）: ほかのタブにいても録音中のタブが開く
  await click(l, 'tabBtnSettings');
  assert.strictEqual(lastSent(), false);
  assert.ok(l.fire('onShowLive') > 0, '画面が onShowLive を受けていない');
  await l.drain();
  assert.strictEqual(liveTab().getAttribute('aria-selected'), 'true', '録音中のタブが開かない');
  assert.strictEqual(l.byId.get('liveBar').hidden, false);
  assert.strictEqual(l.byId.get('liveSttBanner').hidden, false);
  assert.strictEqual(lastSent(), true);
  // 会議が終わった後に押しても、録音中のタブは無いので何もしない（投げない）
  l.fire('onMeetingUpdate', { active: false, finalizing: false, paused: false, startedAt: null, segments: [], stt: null }); await l.drain();
  l.fire('onShowLive'); await l.drain();
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ================= 第1d回 A-13（RL17・RL18・D19・D20・あとの直し (a)） =================
// D19: 設定のカード「エンジン」を「オフライン」にし、文字起こしの言葉を決めた文にする（要約の欄の「エンジン」は変えない: 問い Q15）。
// 文を作るのは画面だけ（main の engine:status の理由の文は「（…）」の中にそのまま入る）
const OFFLINE_LEAD = 'インターネットにつながっていないときと、［この会議は PC の中だけ］の会議では、この PC の中で文字起こしと要約をします。';
const LOCK_OFFLINE = '記録中は PC の中の文字起こしの設定を変更できません';
const { MANIFEST } = require('../src/engine-manifest');
// 取り込みの欄の写し（engine-app.test.js の ST と同じ形。main の engine:fetch-status の答え）
const FETCH = (o = {}) => ({ ok: true, supported: true, mode: { whisper: 'managed', sum: 'managed' }, state: 'missing', totalBytes: 5580564403, doneBytes: 0,
  needBytes: 5580564403, whisperBytes: 583854933, freeBytes: 120e9, whisperReady: false, sumReady: false, runtime: null, askIt: false, report: '',
  items: MANIFEST.items.map((i) => ({ id: i.id, group: i.group, label: i.label, version: i.version, file: (i.dest || i.dir).split('/').pop(), url: i.url,
    host: new URL(i.url).hostname, sha256: i.sha256, size: i.size, done: 0, state: 'missing', license: i.license, place: '%LOCALAPPDATA%\\natsu\\engine\\…' })), error: null, ...o });
const offlineCard = (l) => l.byId.get('engineState').closest('.card');
// カードの文から、詳細設定の要約の欄（要約の小見出しから後ろ）を除いた分
const outsideSummaryText = (l) => {
  const h = l.byId.get('engineAdv').querySelectorAll('h3').find((x) => x.textContent.startsWith('要約'));
  assert.ok(h, '詳細設定に要約の小見出しが無い');
  const t = offlineCard(l).textContent;
  const k = t.indexOf(h.textContent);
  assert.ok(k > 0 && t.indexOf(h.textContent, k + 1) < 0, '要約の小見出しの文がカードの中で1つでない');
  return t.slice(0, k);
};

test('D19: 設定のカードの見出しが『オフライン』で、すぐ下に決めた説明の文。状態は『PC の中の文字起こし：使えます』、ボタンは［PC の中で試す］。カードの中に『エンジン』の語が残るのは、詳細設定の要約の欄だけ', { timeout: 5000 }, async () => {
  let fetch = FETCH();
  const l = await load(APP, { returns: { engineStatus: () => ({ ok: true, whisper: '', sum: '' }), engineFetchStatus: () => fetch } });
  const card = offlineCard(l);
  const h2 = card.children[0];
  assert.strictEqual(h2.tagName, 'h2');
  assert.strictEqual(h2.textContent, 'オフライン');
  const lead = card.children[1];
  assert.ok(lead.classList.contains('field') && !lead.classList.contains('lockNote'), '見出しのすぐ下が説明の欄でない');
  assert.strictEqual(lead.textContent.trim(), OFFLINE_LEAD);
  assert.strictEqual(l.byId.get('engineState').textContent, 'PC の中の文字起こし：使えます');
  assert.strictEqual(l.byId.get('testBtn').textContent, 'PC の中で試す');
  assert.strictEqual(l.byId.get('engineFetchBtn').textContent, 'PC の中の文字起こしを取り込む');
  assert.ok(l.byId.get('engineFetchSummary').textContent.startsWith('PC の中の文字起こしと要約を、この PC に取り込みます（合計 約 5.6GB'), l.byId.get('engineFetchSummary').textContent);
  // 記録中の理由（カードの頭と詳細設定の中）。カードの外（動作の「認識言語」）は今のまま
  const notes = card.querySelectorAll('.lockNote');
  assert.strictEqual(notes.length, 2);
  for (const n of notes) assert.strictEqual(n.textContent.trim(), LOCK_OFFLINE);
  // 取り込むものの名前（main の engine:fetch-status が送る engine-manifest の label。例「文字起こしエンジン（whisper.cpp）」）は、
  // 理由の文と同じく main の文なので除く（文を作るのは画面だけ: 計画の A-13 の注）
  const screenText = () => MANIFEST.items.reduce((t, it) => t.split(it.label).join(''), outsideSummaryText(l));
  const noEngine = (when) => assert.ok(!screenText().includes('エンジン'), `${when}: 要約の欄の外に「エンジン」が残る: ${screenText().match(/.{0,20}エンジン.{0,20}/)}`);
  noEngine('取り込む前');
  // 取り込みの欄のどの形でも、要約の欄の外に「エンジン」を出さない
  const scenes = [
    ['途中', FETCH({ state: 'partial', doneBytes: 1200000000, needBytes: 4380564403 })],
    ['取り込み中', FETCH({ state: 'running', current: 'whisper-model', doneBytes: 286000000, etaSec: 180 })],
    ['待ち', FETCH({ state: 'waiting' })], ['記録中', FETCH({ state: 'held' })], ['一時停止', FETCH({ state: 'paused', doneBytes: 1200000000 })],
    ['新しい版', FETCH({ state: 'update', updateBytes: 40e6, whisperReady: true, sumReady: true })],
    ['取り込み済み', FETCH({ state: 'ready', whisperReady: true, sumReady: true, needBytes: 0 })],
    ['両方とも手の設定', FETCH({ mode: { whisper: 'manual', sum: 'manual' }, state: 'ready', whisperReady: true, sumReady: true })],
    ['文字起こしだけ手の設定', FETCH({ mode: { whisper: 'manual', sum: 'managed' }, whisperReady: true, needBytes: 1005586654 })],
    ['要約だけ手の設定・取り込み済み', FETCH({ mode: { whisper: 'managed', sum: 'manual' }, state: 'ready', whisperReady: true })],
  ];
  const seen = {};
  for (const [when, s] of scenes) {
    fetch = s;
    l.fire('onEngineFetchProgress', s); await l.drain();
    noEngine(when);
    seen[when] = l.byId.get('engineFetchSummary').textContent;
    if (when === '両方とも手の設定') seen.switch = l.byId.get('engineFetchSwitch').textContent;
  }
  assert.strictEqual(seen['新しい版'], '新しい版の PC の中の文字起こし（約 40MB）があります。今のものはそのまま使えます。');
  assert.strictEqual(seen['取り込み済み'], 'PC の中の文字起こしは取り込み済みです（whisper.cpp 1.9.5・llama.cpp b11669）。');
  assert.strictEqual(seen['両方とも手の設定'], '手で設定した PC の中の文字起こしを使っています（詳細設定のパス）。');
  assert.strictEqual(seen.switch, '取り込んだ PC の中の文字起こしに切り替える');
  assert.ok(seen['文字起こしだけ手の設定'].startsWith('文字起こしは手で設定したものを使っています。要約を、この PC に取り込みます（'), seen['文字起こしだけ手の設定']);
  assert.ok(seen['要約だけ手の設定・取り込み済み'].startsWith('要約は手で設定したものを使っています。文字起こしは取り込み済みです（whisper.cpp'), seen['要約だけ手の設定・取り込み済み']);
  // 記録中（理由が出る）も同じ
  l.fire('onMeetingUpdate', LIVE(undefined)); await l.drain();
  assert.ok(notes.every((n) => !n.hidden), '記録中の理由が出ない');
  noEngine('記録中の理由');
  // 要約の欄の言葉は変えない（問い Q15）
  assert.strictEqual(l.byId.get('testSumBtn').textContent, '起動テスト');
  assert.ok(l.byId.get('sumCtx').closest('.field').textContent.includes('要約エンジンに渡すトークン数'));
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('D19: 問題があれば『PC の中の文字起こし：使えません（{理由}）』（理由は main の文のまま）。［PC の中で試す］が失敗しても同じ形', { timeout: 5000 }, async () => {
  const WHY = '文字起こしエンジンの実行ファイルまたはモデルが見つかりません';
  let st = { ok: true, whisper: WHY, sum: '' };
  const l = await load(APP, { returns: { engineStatus: () => st, testApi: () => ({ ok: false, error: '起動に失敗しました' }) } });
  assert.strictEqual(l.byId.get('engineState').textContent, `PC の中の文字起こし：使えません（${WHY}）`);
  assert.strictEqual(l.byId.get('engineState').className, 'eng-state ng');
  st = { ok: true, whisper: '', sum: '' };
  await l.byId.get('testBtn').onclick();
  await l.drain();
  assert.strictEqual(l.byId.get('engineState').textContent, 'PC の中の文字起こし：使えません（起動に失敗しました）');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('D20: 録音中のページの記録の行で、［この会議は PC の中だけ］は説明の行（.desc）のどれよりも前にあり、［文字起こしを打ち切って要約］のすぐ後ろ。#liveTm の次が #liveStt なのは今のまま', { timeout: 5000 }, async () => {
  const l = await load(APP, { now: T0 });
  l.fire('onMeetingUpdate', LIVE({ route: 'cloud', lastTextAt: T0 - 12000, segSec: 15, problem: null })); await l.drain();
  const bar = l.byId.get('liveBar');
  const kids = bar.children;
  const at = (id) => kids.indexOf(l.document.getElementById(id));
  const b = at('meetingLocalOnly');
  assert.ok(b > 0, '［この会議は PC の中だけ］が記録の行に無い');
  assert.strictEqual(l.document.getElementById('meetingLocalOnly').hidden, false, '前提: クラウドの会議でボタンが出ていない');
  assert.strictEqual(b, at('liveSkipBtn') + 1, '［この会議は PC の中だけ］が［文字起こしを打ち切って要約］のすぐ後ろに無い');
  const descs = kids.filter((k) => k.classList.contains('desc'));
  assert.ok(descs.length >= 6, `説明の行が足りない（${descs.length}）`);
  for (const d of descs) assert.ok(kids.indexOf(d) > b, `説明の行 #${d.id} が［この会議は PC の中だけ］より前にある`);
  assert.strictEqual(nextEl(l.document.getElementById('liveTm')), l.byId.get('liveStt'), '#liveTm の次が #liveStt でない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('あとの直し (a): 入力の欄の見た目 — app.html の <input> の type（text・password・email・number・search・url・tel）は、どれも入力の欄の CSS の決まりに入っている（email も text と同じ高さ・枠・文字）', { timeout: 5000 }, () => {
  const fs = require('node:fs');
  const S = require('./helpers/simcss.js');
  const html = fs.readFileSync(APP, 'utf8');
  const rules = S.parse([...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n'));
  const TEXTISH = ['text', 'password', 'email', 'number', 'search', 'url', 'tel'];
  // 書いた欄（<input type="…">）と、画面の <script> が作る欄（createElement('input') の直後の .type = '…'）
  const tags = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
  for (const t of tags) assert.match(t, /\btype="[a-z]+"/, `type の無い <input>: ${t}`);
  const used = new Set([...tags.map((t) => /\btype="([a-z]+)"/.exec(t)[1]),
    ...[...html.matchAll(/createElement\('input'\);\s*\w+\.type = '([a-z]+)'/g)].map((m) => m[1])]);
  assert.ok(used.has('text') && used.has('checkbox'), `前提: 読めた type が少ない（${[...used].join('・')}）`);
  const base = S.declsFor(rules, 'input[type="text"]', { at: '' });
  const tall = S.declsFor(rules, 'input[type="text"]:not(.atag-edit)', { at: '' });
  assert.strictEqual(tall.height, '32px', '前提: 1行の入力欄の高さが 32px でない');
  // 決まりの側には、今は欄の無い email も入れておく（A-12 でメールの欄が消えても、足したときに崩れない）
  for (const ty of new Set([...TEXTISH.filter((x) => used.has(x)), 'email'])) {
    if (ty === 'text') continue;
    const d = S.declsFor(rules, `input[type="${ty}"]`, { at: '' });
    for (const k of ['background', 'border', 'color', 'font', 'padding', 'border-radius', 'width']) {
      assert.strictEqual(d[k], base[k], `input[type="${ty}"] の ${k} が text と違う（入力の欄の決まりに入っていない）`);
    }
    assert.strictEqual(d.height, tall.height, `input[type="${ty}"] の高さが text と違う`);
    assert.strictEqual(d['padding-top'], tall['padding-top'], `input[type="${ty}"] の上の余白が text と違う`);
  }
  // 文字を入れる種類のほかの type（date など）の欄を足したら、ここで止める（決まりに入れるか、この表に足す）
  for (const ty of used) assert.ok([...TEXTISH, 'checkbox'].includes(ty), `決まりに無い type の欄: ${ty}`);
});
