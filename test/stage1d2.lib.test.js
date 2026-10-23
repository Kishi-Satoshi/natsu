/* stage1d2.lib.test.js — 第1d2回（NaTsu 0.9.0 のレーン A。設計書 D21: オフラインの準備を任意にする）の mainlib の純粋な関数
 * （準備を選んだか・クラウドが使えそうか・会議と音声入力の始め方）と、新しい文の字面 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/mainlib');
const T = { timeout: 5000 };

// 音声入力を始めない文（計画「画面と知らせの文」の D1〜D3）
const D1 = 'インターネットにつながっていないため、音声入力を始めませんでした。オンラインに戻ってから、もう一度お試しください。つながっていなくても使うには、設定の「ローカル AI」で準備します。';
const D2 = 'ログインしていないため、音声入力を始めませんでした。設定の「アカウント」でログインしてください。';
const D3 = '文字起こしの中継が今は使えないため、音声入力を始めませんでした。少し待ってから、もう一度お試しください。';

// ---------------------------------------------------------------- M-1（OF1・F4・F5・F10）
test('F10: offlineChosen は手のパス・取り込んだ組の候補・同意・取り込み中のどれか1つで真、どれも無ければ偽', T, () => {
  const none = { manual: false, managedCand: false, consent: false, fetching: false };
  assert.strictEqual(L.offlineChosen(none), false, 'どれも無い');
  for (const k of ['manual', 'managedCand', 'consent', 'fetching']) {
    assert.strictEqual(L.offlineChosen({ ...none, [k]: true }), true, `${k} だけ`);
  }
});

test('OF1: cloudLikely は startSegmentMode の short とちょうど同じ答え（ログイン 2・hold 2・net.isOnline() 2・覚えている /health の true・false・null の 3 で 24 通り）', T, () => {
  let n = 0;
  for (const signedIn of [true, false]) {
    for (const hold of ['', 'daily-cap']) {
      for (const netOnline of [true, false]) {
        for (const peekUp of [true, false, null]) {
          const o = { signedIn, hold, netOnline, peekUp };
          const want = signedIn && !hold && netOnline && peekUp !== false;
          assert.strictEqual(L.cloudLikely(o), want, JSON.stringify(o));
          assert.strictEqual(L.cloudLikely(o), L.startSegmentMode({ localOnly: false, ...o }) === 'short', JSON.stringify(o));
          n += 1;
        }
      }
    }
  }
  assert.strictEqual(n, 24);
});

test('OF1: startPlan — 手元が使える・クラウドが使えそう → 始める。選んだ人で両方だめ → 今の文で始めない。選んでいない人で両方だめ → 始めて音声を残す（ログインしていない・切れた → login、ほか → wait）', T, () => {
  const problem = '文字起こしエンジンが未設定です。設定タブの［PC の中の文字起こしを取り込む］から取り込んでください。';
  const P = (o) => L.startPlan({ localUsable: false, chosen: false, cloud: false, problem, why: 'offline', ...o });
  for (const chosen of [true, false]) {
    assert.deepStrictEqual(P({ chosen, localUsable: true }), { ok: true, keep: '' }, `手元が使える（chosen ${chosen}）`);
    assert.deepStrictEqual(P({ chosen, cloud: true, why: '' }), { ok: true, keep: '' }, `クラウドが使えそう（chosen ${chosen}）`);
  }
  for (const why of ['offline', 'signed-out', 'login', 'relay-down', 'daily-cap']) {
    assert.deepStrictEqual(P({ chosen: true, why }), { ok: false, error: problem }, `選んだ人は今の文で始めない（${why}）`);
  }
  assert.deepStrictEqual(P({ why: 'signed-out' }), { ok: true, keep: 'login' });
  assert.deepStrictEqual(P({ why: 'login' }), { ok: true, keep: 'login' });
  for (const why of ['offline', 'relay-down', 'daily-cap', 'quota', 'upstream-auth']) assert.deepStrictEqual(P({ why }), { ok: true, keep: 'wait' }, why);
});

test('OF1: dictationPlan — 選んでいない人で両方だめなら D1・D2（signin）・D3 で始めない。選んだ人は今の文。手元が使えるかクラウドが使えそうなら始める', T, () => {
  const problem = '文字起こしエンジンが未設定です。設定タブでパスを指定してください。';
  const P = (o) => L.dictationPlan({ localUsable: false, chosen: false, cloud: false, problem, why: 'offline', ...o });
  for (const chosen of [true, false]) {
    assert.deepStrictEqual(P({ chosen, localUsable: true }), { ok: true });
    assert.deepStrictEqual(P({ chosen, cloud: true, why: '' }), { ok: true });
  }
  for (const why of ['offline', 'signed-out', 'relay-down']) assert.deepStrictEqual(P({ chosen: true, why }), { ok: false, error: problem }, why);
  assert.deepStrictEqual(P({ why: 'offline' }), { ok: false, error: D1 });
  assert.deepStrictEqual(P({ why: 'signed-out' }), { ok: false, error: D2, action: 'signin' });
  assert.deepStrictEqual(P({ why: 'login' }), { ok: false, error: D2, action: 'signin' });
  for (const why of ['relay-down', 'daily-cap', 'quota', 'upstream-auth']) assert.deepStrictEqual(P({ why }), { ok: false, error: D3 }, why);
});

// ---------------------------------------------------------------- M-2（OF2・F1・F4・F6）
// 帯（計画「画面と知らせの文」の B11〜B14）と、会議の中の左下の知らせ（K1〜K4）
const B11 = 'PC の中の文字起こしが入っていないので、音声を残しています。オンラインに戻ると文字起こしします。録音はそのまま続けてください。';
const B12 = '文字起こしの中継が今は使えないため、音声を残しています。使えるようになると自動で文字起こしします。録音はそのまま続けてください。';
const B13 = 'ログインしていないため、音声を残しています。［ログイン］を押してログインすると、文字起こしします。';
const B14 = 'この会議はオフラインモードです。PC の中の文字起こしが入っていないので、音声だけを残しています（外には送りません）。［ローカル AI の準備］から取り込むと、文字起こしします。';
const K1 = '今はクラウドで文字起こしできないため、音声だけを残します。つながると、この会議の音声を OpenAI に送って文字起こしします。1on1・面談など外に出したくない会議は、議事録の画面の［オフラインモード］を押してください。';
const K2 = 'ログインしていないため、音声だけを残します。設定の「アカウント」でログインすると、この会議の音声を OpenAI に送って文字起こしします。1on1・面談など外に出したくない会議は、議事録の画面の［オフラインモード］を押してください。';
const K3 = '文字起こしの中継が使えないため、音声を残しています。使えるようになると自動で文字起こしします。録音はそのまま続けてください。';
const K4 = 'ログインが切れたため、音声を残しています。設定の「アカウント」でもう一度ログインすると、文字起こしします。';
const KEPT_SEG_TEXT = '（文字起こし待ち: 音声は残してあります）';
// 要約の欄（計画「画面と知らせの文」の S1〜S3'。M-3）
// 0.10.0 LS-1（D59・決めたこと 110）で意図して変えた: S1・S2 は要約待ちの一文、S3' は「ローカル AI の準備」を書かない
const S1 = '要約待ち（つながったら作ります）';
const S2 = '要約待ち（つながったら作ります）';
const S3 = '文字起こし待ちの音声があります。文字起こしが済むと、自動で要約を作ります。';
const S3L = 'この会議はオフラインモードです。文字起こし待ちの音声があります。文字起こしが済んでつながると、自動で要約を作ります。';
// ［この会議は PC の中だけ］を押したが、PC の中の文字起こしが使えない（M-4）
const P1 = 'この会議をオフラインモードにしました。PC の中で文字起こしするには、設定の「ローカル AI」の準備（数 GB の取り込み）が要ります。今は音声だけをこの PC に残し、外には送りません。準備が済むと文字起こしします。';
// 音声入力の音声を残す（M-5。D4 は録音バー、D5 は履歴の行）
const D4 = '文字起こしできなかったので、音声を残しました。つながると文字起こしして、履歴に入れます。';
const D5 = '（文字起こし待ち: 音声は残してあります）';
// 新しい文（「未設定」の語を見ると、画面が設定のタブへ連れて行く: 調べた結果の 7）
const NEW_TEXTS = { B11, B12, B13, B14, K1, K2, K3, K4, KEPT_SEG_TEXT, D1, D2, D3, S1, S2, S3, S3L, P1, D4, D5 };

test('OF2: keptCodeFor の表（受け渡す名前と形に書いた理由の全部と知らない符号 × localOnly）', T, () => {
  const table = {
    'kept-login': ['signed-out', 'login'],
    'kept-relay': ['daily-cap', 'quota', 'upstream-auth', 'denied', 'server', 'bad-reply', 'something-new'],
    'kept-wait': ['offline', 'unreachable', 'net', 'timeout', 'cert', 'proxy', 'key-unreadable'],
    '': ['bad-request', 'too-large'],
  };
  for (const [code, whys] of Object.entries(table)) {
    for (const why of whys) {
      assert.strictEqual(L.keptCodeFor({ localOnly: false, why }), code, why);
      assert.strictEqual(L.keptCodeFor({ localOnly: true, why }), 'kept-local', `PC の中だけ（${why}）`);
    }
  }
  assert.strictEqual(L.keptCodeFor({ localOnly: true, why: 'local-only' }), 'kept-local');
  assert.deepStrictEqual(L.KEPT_CODES, ['kept-local', 'kept-login', 'kept-relay', 'kept-wait']);
});

test('OF2: PROBLEM_ORDER は login の後・seg-failed の前に kept の4つ。WIN_NOTIFY_CODES は 0.8.0 の4つのまま', T, () => {
  const o = L.PROBLEM_ORDER;
  assert.deepStrictEqual(o.slice(o.indexOf('login'), o.indexOf('seg-failed') + 1), ['login', 'kept-local', 'kept-login', 'kept-relay', 'kept-wait', 'seg-failed']);
  assert.deepStrictEqual(L.WIN_NOTIFY_CODES, ['engine-down', 'stall', 'login', 'seg-failed']);
  for (const c of L.KEPT_CODES) assert.strictEqual(L.notifyGate({ sent: [], lastAt: 0 }, c, 1000).ok, false, `${c} を Windows の知らせにした`);
  // 残した区間の帯は、失敗の区間の帯（B4）より前に出る
  assert.strictEqual(L.sttProblemOf(new Map([['seg-failed', { n: 1 }], ['kept-wait', {}]])).code, 'kept-wait');
});

test('OF2: publicSegments は wav と kept を外す（ページと画面に印を出さない。下書きには残る）', T, () => {
  const segs = [{ id: 's1', text: KEPT_SEG_TEXT, failed: true, kept: true, wav: '/x/1.wav' }, { id: 's2', text: 'a' }];
  assert.deepStrictEqual(L.publicSegments(segs), [{ id: 's1', text: KEPT_SEG_TEXT, failed: true }, { id: 's2', text: 'a' }]);
  assert.deepStrictEqual(L.settledSegments(segs), [{ id: 's1', text: KEPT_SEG_TEXT, failed: true }, { id: 's2', text: 'a' }]);
  assert.strictEqual(segs[0].kept, true, '入力を書き換えた');
});

test('OF2: recoverSegments は kept を外し、残した区間（失敗・WAV あり）は文をそのままにして todo に入れる', T, () => {
  const has = (f) => f === '/x/2.wav';
  const r = L.recoverSegments([{ id: 's1', atMs: 0, durationMs: 3000, text: 'a' },
    { id: 's2', atMs: 3000, durationMs: 2000, text: KEPT_SEG_TEXT, failed: true, kept: true, wav: '/x/2.wav' }], has);
  assert.deepStrictEqual(r.segments, [{ id: 's1', atMs: 0, durationMs: 3000, text: 'a' }, { id: 's2', atMs: 3000, durationMs: 2000, text: KEPT_SEG_TEXT, failed: true }]);
  assert.deepStrictEqual(r.todo, [{ id: 's2', wav: '/x/2.wav', durationMs: 2000 }]);
});

test('F4: B11〜B14・K1〜K4・P1・区間の文・D1〜D6・S1〜S3\'・R1 に「未設定」が無く、main・mainlib の文と同じ（画面の連れて行きに当たらない）', T, () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'main.js'), 'utf8')
    + require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'mainlib.js'), 'utf8');
  for (const [k, t] of Object.entries(NEW_TEXTS)) {
    assert.ok(!t.includes('未設定'), `${k} に「未設定」`);
    assert.ok(src.includes(`'${t}'`), `${k} の文が src に無い`);
  }
  // R1・D6（数を入れる文）
  assert.ok(src.includes('`残しておいた音声を文字起こししました（${done}/${q.items.length} 区間）。続けて要約を作ります。`'), 'R1 の文が main に無い');
  assert.ok(src.includes('`残しておいた音声入力を ${n} 件文字起こしして、履歴に入れました（貼り付けはしていません）。`'), 'D6 の文が main に無い');
});

test('S1・S2: 準備を選んでいない PC で手元の LLM が無いときの要約の欄の文は、PC の中だけなら S1、そうでなければ S2。文字起こし待ちのある会議は S3・S3\'', T, () => {
  assert.deepStrictEqual(L.KEPT_SUMMARY_TEXT, { local: S1, offline: S2, wait: S3, waitLocal: S3L });
});
