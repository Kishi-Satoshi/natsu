/*
 * stage1d.app.test.js — 第1d回の画面（app.html）の確かめ（最小 DOM（helpers/simrun.js）の上で画面の <script> を本当に走らせる）
 * A-9（RL16・F16・RF41）: ［更新して再起動］で取り込みが通っても、restart が断ったら文を出してボタンを戻し、次は取り込み直さずに restart だけ。
 * A-4（RL10・RL11・F5・F11）・A-12（RL10）: 設定のカード「アカウント」（A-12 から［ログイン］（Cloudflare Access の窓）→ ログイン中・
 * ［ログアウト］。メールと確認コードの欄は無い）、ログイン切れの知らせの
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
const ONLINE = 'ログインしていて、インターネットにつながっているときは、会議と音声入力の音声を文字起こしの中継に送り、OpenAI（gpt-4o-transcribe）で文字起こしします。中継も OpenAI も、音声と文字を保存しません。つながっていないときは、いつも PC の中で文字起こしします。1on1・面談など外に出したくない会議は、議事録の画面の［オフラインモード］を押してください。';
const L3 = 'ログインが切れたため、この PC で文字起こししています（精度が落ちます）。設定の「アカウント」でもう一度ログインしてください。';
const CLAUDE = () => ({ ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '' });
const status = (o = {}) => ({ ok: true, signedIn: false, email: '', method: 'access', until: null, canStore: true, online: { up: true, why: 'ok' }, ...o });
const RETIRED = ['onlineAdv', 'sttKey', 'sttKeySave', 'sttKeyTest', 'sttKeyClear', 'sttKeyState'];

// 要素とその祖先のどれにも hidden が無い（画面に出ている）。
// 0.9.0 U-1（SP1・D24）で意図して変えた: 設定はポップアップ（#settingsModal）の中なので、ポップアップの hidden は見ない（開けば出る形か）
const shown = (el) => { for (let n = el; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) if (n.hidden && n.id !== 'settingsModal') return false; return true; };
const click = async (l, id) => { l.byId.get(id).dispatchEvent({ type: 'click' }); await l.drain(); };

// 第1d回 A-12 で意図して変えた: 自前のログイン（メール → 確認コード）の試しを、Cloudflare Access の窓の［ログイン］／［ログアウト］の試しに替えた
// （計画「作り替え」の「画面と知らせの文」の AR1〜AR7。R2〜R10・R17 の文と、メールとコードの欄は無い）
const AR1 = '［ログイン］を押すと、ログインの画面が別の窓で開きます。画面は Cloudflare（中継を守る仕組み）のもので、英語です。会社のメールアドレスを入れて［Send login code］を押し、届いたメール（差出人は Cloudflare。英語）の 6 けたのコードを入れて［Sign in］を押してください。ログインできると、窓は自動で閉じます。';
const AR2 = 'コードのメールが届かないときは、迷惑メールのフォルダも見てください。「already been used」と出たら、［Request new code］でコードを頼み直してください（会社のメールの検査が、先にコードを使ってしまうことがあります）。';
// 前の［ログイン］#accountLogin は消した #accountCodeField の中のボタン。A-12 の［ログイン］は #accountSignIn（同じ id で外へ出すとゲートの「枠からの離脱」）
const RETIRED_ACCOUNT = ['accountEmail', 'accountSend', 'accountCodeField', 'accountSent', 'accountCode', 'accountResend', 'accountLogin'];
// 期限（UNIX 秒）→「{M} 月 {D} 日」（画面と同じく、この PC の時刻で）
const md = (sec) => { const d = new Date(sec * 1000); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
const UNTIL = Math.floor(Date.UTC(2026, 10, 18, 3, 0, 0) / 1000);

// ログインの流れを覚える偽の main（login・logout の答えは差し替えられる）
function fakeMain(over = {}) {
  const st = { signedIn: false, email: '', until: null };
  return {
    st,
    returns: {
      claudeStatus: CLAUDE,
      accountStatus: () => status({ signedIn: st.signedIn, email: st.signedIn ? st.email : '', until: st.signedIn ? st.until : null }),
      accountLogin: () => { st.signedIn = true; st.email = M; st.until = UNTIL; return { ok: true, email: M, message: lib.accountMessage('login-ok') }; },
      accountLogout: () => { st.signedIn = false; st.email = ''; st.until = null; return { ok: true, message: lib.accountMessage('logout') }; },
      ...over,
    },
  };
}

test('RL10: ログインしていなければ AR1・AR2 と［ログイン］、ログイン中は『ログイン中: {メール}（{M} 月 {D} 日まで、このままです）』と［ログアウト］。期限が無ければ括弧ごと外す', async () => {
  const f = fakeMain();
  const l = await load(APP, { returns: f.returns });
  await l.drain();
  assert.deepStrictEqual(l.errors.map(fmt), []);
  // 0.9.0 U-2（SP4・D24）で意図して変えた: 設定は項目ごと。アカウントのカードは設定の頭（項目「アカウント」の1枚）、外観はその次（項目「一般」の頭）
  const cards = l.byId.get('tabSettings').querySelectorAll('.card');
  assert.strictEqual(cards[0].id, 'accountCard', '1つ目のカードがアカウントでない');
  assert.strictEqual(cards[1].id, 'appearanceCard', '2つ目のカードが外観でない');
  assert.strictEqual(cards[0].querySelector('h2').textContent.trim(), 'アカウント');
  // 0.9.2 I-3（計画 docs/plans/2026-10-21-092.md）で意図して変えた: カードの頭は1行（.setlead）、R1・AR1・AR2 はログインの行の ⓘ の吹き出し（#setPopLogin）の
  // 頭と箇条書きに分けた。どの文も吹き出しにある（R1 の頭の文は「ログインしていて、…」の言い方にした: 芯の言葉を見る）
  assert.strictEqual(cards[0].querySelector('.setlead').textContent.trim(), 'ログインすると、つながっている間はクラウドで文字起こしします。');
  // ログインしていない: AR1・AR2 と［ログイン］。［ログアウト］は出ない
  const out = l.byId.get('accountOut');
  assert.ok(shown(out) && !shown(l.byId.get('accountIn')));
  const pop = l.byId.get('setPopLogin');
  assert.ok(pop && pop.closest('#accountOut'), 'ログインの行に吹き出しが無い');
  const popText = pop.textContent.replace(/\s+/g, ' ');
  for (const sent of [...AR1.split('。'), ...AR2.split('。'), R1.split('。')[1]].filter(Boolean).map((x) => `${x}。`)) assert.ok(popText.includes(sent), `「${sent}」が無い: ${popText}`);
  assert.ok(popText.includes('文字起こしの中継に送り、OpenAI で文字起こしします'), 'R1 の送り先の説明が無い');
  // AR1・AR2 の行はどちらも画面に出ている（隠した説明にしない）
  // 0.9.2 I-3 で意図して変えた: 見える説明は1行（画面が英語であることは見える行に残す）。AR1・AR2 は名前の横の ⓘ を押すと出る（計画の問い Q9）
  const seen = out.querySelectorAll('.desc').filter((x) => !x.closest('.setpop') && shown(x)).map((x) => x.textContent.trim());
  assert.deepStrictEqual(seen, ['会社のメールアドレスでログインします（画面は英語です）。'], 'ログインの行の見える説明が1行でない');
  const info = out.querySelector('.setinfo');
  assert.ok(info && shown(info) && info.getAttribute('aria-controls') === 'setPopLogin', 'AR1・AR2 を開く ⓘ が出ていない');
  const btn = l.byId.get('accountSignIn');
  assert.strictEqual(btn.closest('.card'), cards[0]);
  assert.ok(out.querySelectorAll('button').includes(btn), '［ログイン］がログインしていないときの欄に無い');
  assert.strictEqual(btn.textContent.trim(), 'ログイン');
  assert.ok(shown(btn) && !shown(l.byId.get('accountLogout')));
  // ログインした: AR4（ok の色）と「ログイン中: {メール}（{M} 月 {D} 日まで、このままです）」・［ログアウト］
  await click(l, 'accountSignIn');
  assert.strictEqual(l.called('accountLogin').length, 1);
  assert.strictEqual(l.byId.get('accountWho').textContent, `ログイン中: ${M}（${md(UNTIL)}まで、このままです）`);
  assert.ok(shown(l.byId.get('accountWho')) && shown(l.byId.get('accountLogout')) && !shown(btn) && !shown(out));
  assert.strictEqual(l.byId.get('accountLogout').textContent.trim(), 'ログアウト');
  // ログアウト: main の文（R12）を出し、ログインしていない形に戻る
  await click(l, 'accountLogout');
  assert.strictEqual(l.called('accountLogout').length, 1);
  assert.strictEqual(l.byId.get('accountMsg').textContent, lib.accountMessage('logout'));
  assert.ok(shown(btn) && !shown(l.byId.get('accountLogout')));
  // 設定を開くたびに main の写しを聞き直す（外へは通信しない口: account:status）
  const before = l.called('accountStatus').length;
  await click(l, 'tabBtnSettings');
  assert.strictEqual(l.called('accountStatus').length, before + 1, '設定を開いたのに状態を聞き直していない');
  // 期限が分からない（null・数でない・0 以下）ときは括弧ごと外す
  for (const until of [null, undefined, '1790000000', 0, -5, 1.5, NaN]) {
    const g = fakeMain();
    Object.assign(g.st, { signedIn: true, email: M, until });
    const w = await load(APP, { returns: g.returns });
    await w.drain();
    assert.strictEqual(w.byId.get('accountWho').textContent, `ログイン中: ${M}`, String(until));
    assert.deepStrictEqual(w.errors.map(fmt), []);
  }
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('RL10: 開いたときにログイン中ならログイン中の行と［ログアウト］だけ（メールと期限は main の写し）。答えが読めなければログインしていない形', async () => {
  const f = fakeMain();
  Object.assign(f.st, { signedIn: true, email: M, until: UNTIL });
  const l = await load(APP, { returns: f.returns });
  await l.drain();
  assert.strictEqual(l.byId.get('accountWho').textContent, `ログイン中: ${M}（${md(UNTIL)}まで、このままです）`);
  assert.ok(shown(l.byId.get('accountLogout')) && !shown(l.byId.get('accountSignIn')));
  // 答えが読めない（古い main・投げた）ときも［ログイン］を出し、初期化は最後まで走る
  const odd = await load(APP, { returns: { claudeStatus: CLAUDE, accountStatus: () => { throw new Error('x'); } } });
  await odd.drain();
  assert.ok(shown(odd.byId.get('accountSignIn')) && !shown(odd.byId.get('accountLogout')));
  assert.deepStrictEqual(odd.errors.map(fmt), []);
});

test('RL10: ［ログイン］は accountLogin を1回だけ呼び、返事まで押せない。答えの message をそのまま出す（成功は ok・断りは ng の色）', async () => {
  let release = null;
  const f = fakeMain({ accountLogin: () => new Promise((r) => { release = () => { Object.assign(f.st, { signedIn: true, email: M, until: UNTIL }); r({ ok: true, email: M, message: lib.accountMessage('login-ok') }); }; }) });
  const l = await load(APP, { returns: f.returns });
  await l.drain();
  l.byId.get('accountMsg').textContent = '前の文';
  l.byId.get('accountSignIn').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.byId.get('accountSignIn').disabled, true, '返事を待つ間に［ログイン］を押せる');
  l.byId.get('accountSignIn').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.called('accountLogin').length, 1, '2回押して窓を2回頼んだ');
  assert.deepStrictEqual(l.called('accountLogin')[0].args, [], '画面から main へ何かを渡した');
  release();
  await l.drain();
  assert.strictEqual(l.byId.get('accountSignIn').disabled, false);
  assert.strictEqual(l.byId.get('accountMsg').textContent, lib.accountMessage('login-ok'));
  assert.match(l.byId.get('accountMsg').className, /\bok\b/);
  assert.ok(shown(l.byId.get('accountLogout')), 'ログインできたのにログイン中の形にならない');
  // 断り: main の文（AR5〜AR7・R13〜R16）をそのまま ng の色で。ログイン中の形にしない
  const host = new URL(require('../src/relay').RELAY_BASE).hostname;   // 第1d回 A-10: RELAY_BASE から取る
  for (const code of ['cancel', 'no-cookie', 'login', 'denied', 'offline', 'net', 'timeout', 'cert', 'proxy', 'not-ready', 'server', 'store']) {
    const message = lib.accountMessage(code, { host });
    const w = await load(APP, { returns: fakeMain({ accountLogin: () => ({ ok: false, code, message }) }).returns });
    await w.drain();
    await click(w, 'accountSignIn');
    assert.strictEqual(w.byId.get('accountMsg').textContent, message, code);
    assert.match(w.byId.get('accountMsg').className, /\bng\b/, code);
    assert.ok(!shown(w.byId.get('accountLogout')) && shown(w.byId.get('accountSignIn')), `${code}: 断られたのにログイン中の形になった`);
    assert.strictEqual(w.byId.get('accountSignIn').disabled, false, `${code}: 断られた後に押せない`);
  }
  // 画面は文を作らない: main の文がそのまま出る（画面の中の表から引かない）。投げても押せるように戻る
  const odd = '（main の文: 印 7f3a）';
  const o = await load(APP, { returns: fakeMain({ accountLogin: () => ({ ok: false, code: 'cancel', message: odd }) }).returns });
  await o.drain();
  await click(o, 'accountSignIn');
  assert.strictEqual(o.byId.get('accountMsg').textContent, odd);
  const t = await load(APP, { returns: fakeMain({ accountLogin: () => { throw new Error('x'); } }).returns });
  await t.drain();
  await click(t, 'accountSignIn');
  assert.strictEqual(t.byId.get('accountSignIn').disabled, false);
  assert.match(t.byId.get('accountMsg').className, /\bng\b/);
  // ログアウトで PC のログインを消せなかった（R15 の文）: 文を出して、ログイン中の形のまま
  const g = fakeMain({ accountLogout: () => ({ ok: false, code: 'write', message: lib.accountMessage('write') }) });
  Object.assign(g.st, { signedIn: true, email: M, until: UNTIL });
  const w = await load(APP, { returns: g.returns });
  await w.drain();
  await click(w, 'accountLogout');
  assert.strictEqual(w.byId.get('accountMsg').textContent, lib.accountMessage('write'));
  assert.match(w.byId.get('accountMsg').className, /\bng\b/);
  assert.ok(shown(w.byId.get('accountLogout')));
  assert.deepStrictEqual([...l.errors, ...o.errors, ...t.errors, ...w.errors].map(fmt), []);
});

test('RL10: メールアドレスと確認コードの欄・［確認コードを送る］［コードを送り直す］が無い（画面はメールもコードも扱わない）', async () => {
  const l = await load(APP, { returns: fakeMain().returns });
  await l.drain();
  for (const id of RETIRED_ACCOUNT) assert.strictEqual(l.byId.get(id), undefined, `${id} がまだある`);
  assert.deepStrictEqual(l.missingIds.filter((id) => RETIRED_ACCOUNT.includes(id)), [], '消した欄をまだ引いている');
  const card = l.byId.get('accountCard');
  assert.deepStrictEqual(card.querySelectorAll('input'), [], 'カード「アカウント」に入力の欄がある');
  // 0.9.2 I-3 で意図して変えた: ほかのボタンは ⓘ と吹き出しの「ヘルプで詳しく見る ↗」だけ（id は無い）
  assert.deepStrictEqual(card.querySelectorAll('button').filter((b) => b.id).map((b) => b.id).sort(), ['accountLogout', 'accountSignIn']);
  assert.ok(card.querySelectorAll('button').filter((b) => !b.id).every((b) => b.classList.contains('setinfo') || b.classList.contains('setpop-help')), 'カード「アカウント」に知らないボタンがある');
  const t = card.textContent;
  // （「会社のメールアドレス」は R1・AR1 の説明が言うので、欄の名前「メールアドレス」は label が無いことで見る）
  for (const w of ['確認コード', 'コードを送り直す', '6 けたの確認コードを送りました']) assert.ok(!t.includes(w), `${w} が残っている`);
  assert.ok(!card.querySelectorAll('label').length, 'カード「アカウント」に欄の名前がある');
  // preload にも画面にも、前の自前のログインの口が無い
  for (const n of ['accountStart', 'accountVerify']) assert.ok(!l.apis.koeApp.includes(n), `preload に ${n} が残っている`);
  assert.ok(l.apis.koeApp.includes('accountLogin'));
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('F11: ［詳細設定（管理者用）］・鍵の欄・3つのボタンが無い。カード「オンライン」の説明は新しい文', async () => {
  const l = await load(APP, { returns: fakeMain().returns });
  await l.drain();
  for (const id of RETIRED) assert.strictEqual(l.byId.get(id), undefined, `${id} がまだある`);
  assert.deepStrictEqual(l.missingIds.filter((id) => RETIRED.includes(id)), [], '消した欄をまだ引いている');
  // 0.9.0 U-2（SP4・D24）で意図して変えた: Claude Code の欄は「要約（Claude Code）」のカード、前の「オンライン」の説明は「文字起こし」のカード（文は今のまま）
  assert.strictEqual(l.byId.get('claudeTest').closest('.card').querySelector('h2').textContent.trim(), '要約（Claude Code）');
  const card = l.byId.get('language').closest('.card');
  assert.strictEqual(card.querySelector('h2').textContent.trim(), '文字起こし');
  const t = l.byId.get('tabSettings').textContent;
  for (const w of ['詳細設定（管理者用）', '管理者用の仮の欄', 'OpenAI の鍵', '鍵を確かめる', '鍵を消す', 'API キー']) assert.ok(!t.includes(w), `${w} が残っている`);
  // 0.9.2 I-2（計画 docs/plans/2026-10-21-092.md）で意図して変えた: 説明は見出しの ⓘ の吹き出し（#setPopStt）の頭と箇条書きに分けた。文は今のまま1つずつある
  const pop = l.byId.get('setPopStt');
  assert.ok(pop && pop.closest('.card') === card, 'カード「オンライン」の説明（吹き出し）が無い');
  const parts = [pop.querySelector('.setpop-head'), ...pop.querySelectorAll('li')].map((e) => e.textContent);
  for (const sent of ONLINE.split('。').filter(Boolean).map((x) => `${x}。`)) assert.ok(parts.some((x) => x.includes(sent)), `「${sent}」が無い`);
  for (const x of parts) assert.ok(!/\n|\s{2,}/.test(x), '説明の中に改行か空白が混ざった（HTML の改行は画面で空白になる）');
  // 画面は鍵の口を呼ばない（preload にも無い）
  for (const n of ['cloudStatus', 'cloudSetKey', 'cloudTestKey', 'cloudClearKey']) assert.ok(!l.apis.koeApp.includes(n), `preload に ${n} が残っている`);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// 第1d回 A-12 で意図して変えた: フォーカスの行き先はメールの欄でなく［ログイン］（メールの欄は無い）
test('F5: app:notice が { text, action: \'account\' } のとき、トーストに［ログインし直す］があり、押すと設定の「アカウント」のカードが開いて［ログイン］にフォーカスが行く。文字だけの知らせは今のまま', async () => {
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
  // 要素どうしの strictEqual は、落ちたときに DOM の木を全部書き出して遅いので、真偽で見る
  assert.ok(l.document.activeElement === l.byId.get('accountSignIn'), '［ログイン］にフォーカスが行かない');
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
  l.fire('onMeetingUpdate', PROB('relay-down', '', 'NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。')); await l.drain();
  const b = l.byId.get('liveSttBanner');
  assert.strictEqual(b.hidden, false);
  assert.strictEqual(b.getAttribute('role'), 'alert');
  assert.strictEqual(nextEl(b), l.byId.get('liveBar'), '帯が録音中のページの頭（#liveBar の上）に無い');
  assert.strictEqual(l.root.querySelectorAll('.stt-banner').length, 1, '帯が2つ以上ある');
  assert.strictEqual(l.byId.get('liveSttBannerText').textContent, 'NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。');
  assert.strictEqual(l.byId.get('liveSttBannerBtn').hidden, true);
  // F15: 区間ごとの meeting:update で同じ帯の文を書き直さない（role="alert" は書き直すたびに読み上げ直されることがある）。
  // simdom の textContent の代入は子の並びを作り直すので、並びが同じなら書いていない（A-7 の点検で足した）
  const kids = l.byId.get('liveSttBannerText').childNodes;
  l.fire('onMeetingUpdate', { ...PROB('relay-down', '', 'NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。'), segments: [{ atMs: 0, text: '区間', failed: false }] }); await l.drain();
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

// 第1d回 A-12 で意図して変えた: フォーカスの行き先は［ログイン］
test('D17: ［ログインし直す］は設定の『アカウント』を開いて［ログイン］にフォーカス。［エンジンを確かめる］は詳細設定の『文字起こし』を開く', { timeout: 5000 }, async () => {
  const l = await load(APP, { now: T0, returns: fakeMain().returns });
  l.fire('onMeetingUpdate', PROB('login', 'account', 'ログインが切れたため、この PC で文字起こしを続けていますが、精度が落ちます。［ログインし直す］を押して、もう一度ログインしてください。')); await l.drain();
  assert.ok(!l.byId.get('tabSettings').classList.contains('active'));
  const n = l.called('accountStatus').length;
  await click(l, 'liveSttBannerBtn');
  assert.ok(l.byId.get('tabSettings').classList.contains('active'), '設定が開かない');
  assert.ok(l.called('accountStatus').length > n, '開いたのにログインの状態を聞き直していない');
  // 要素どうしの strictEqual は、落ちたときに DOM の木を全部書き出して遅いので、真偽で見る
  assert.ok(l.document.activeElement === l.byId.get('accountSignIn'), '［ログイン］にフォーカスが行かない');
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
  // 0.9.0 U-1（SP1・D24）で意図して変えた: 設定はタブでなく、録音中のページの上に開くポップアップ。開いている間は見えていない（false）、
  // 閉じると録音中のタブのままなので見えている（true）
  await click(l, 'tabBtnSettings');
  assert.strictEqual(lastSent(), false, '設定のポップアップで覆ったのに録音中のページを開いているまま');
  await click(l, 'setClose');
  assert.strictEqual(lastSent(), true, '設定を閉じて録音中のページが見えたのに知らせない');
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
  // 0.9.0 U-1: 設定のポップアップを開いている間に知らせを押すと、ポップアップを閉じて録音中のページを見せる
  await click(l, 'tabBtnSettings');
  assert.strictEqual(lastSent(), false);
  assert.ok(l.fire('onShowLive') > 0, '画面が onShowLive を受けていない');
  await l.drain();
  assert.strictEqual(l.byId.get('settingsModal').hidden, true, '知らせを押したのに設定のポップアップが録音中のページを覆ったまま');
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
// 0.9.0 U-3（OFF1・D21）で意図して変えた: 説明の文は「準備（任意）」の文（stage1d2.app の OFF1。選んだ人も選んでいない人も同じ）
// 0.9.2 I-3（計画 docs/plans/2026-10-21-092.md）で意図して変えた: 頭の説明は1行。前の D21 の文（OFFLINE_D21）は頭の説明の ⓘ の吹き出し（#setPopOffline）にある
const OFFLINE_LEAD = 'PC の中で文字起こしと要約をするための準備です（任意）。';
const OFFLINE_D21 = 'インターネットにつながっていないときと、オフラインモードの会議でも、この PC の中で文字起こしと要約ができるようにする準備です（任意）。準備しなくても、インターネットにつながっていてログインしていれば、会議と音声入力はそのまま使えます。';
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
  assert.strictEqual(h2.textContent, 'ローカル AI の設定');   // 0.9.3 M-0（D54）で意図して変えた
  const lead = card.children[1];
  assert.ok(lead.classList.contains('field') && !lead.classList.contains('lockNote'), '見出しのすぐ下が説明の欄でない');
  assert.strictEqual(lead.textContent.trim(), OFFLINE_LEAD);
  const offPop = l.byId.get('setPopOffline');
  assert.ok(offPop && offPop.parentNode === card, 'オフラインのカードに頭の説明の吹き出しが無い');
  for (const w of ['準備しなくても、インターネットにつながっていてログインしていれば、会議と音声入力はそのまま使えます。', 'インターネットにつながっていないときと、オフラインモードの会議でも、この PC の中で文字起こしと要約が']) {
    assert.ok(offPop.textContent.includes(w), `吹き出しに「${w}」が無い（前の文 ${OFFLINE_D21.length} 字の芯）`);
  }
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
  assert.strictEqual(b, at('liveSkipBtn') + 1, '［この会議は PC の中だけ］が［文字起こしを後回しにして要約］のすぐ後ろに無い');
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
  // 決まりの側には、今は欄の無い email も入れておく（A-12 でメールの欄が消えたが、足したときに崩れない）
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
