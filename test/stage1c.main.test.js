/*
 * stage1c.main.test.js — 第1c回の main のつなぎ（オンラインの文字起こし・Claude Code の要約）を、偽の Electron の上で
 * main.js を本当に動かして確かめる（helpers/mainrun.js）。偽の送り先（helpers/fake-stt.js）と偽の claude（helpers/fake-claude.js）だけを使い、外へつながない。
 * 第1d回 A-3（RL11）で意図して変えた: 文字起こしは PC から OpenAI へ直に送らず、中継（relay/）へ送る。場面は --stt（OpenAI の鍵）の代わりに
 * --relay（本物の中継のコードを 127.0.0.1 で動かし、ログインの札を種まきする。その後ろが偽の OpenAI）で、同じ意図（オンラインならクラウド・
 * 通信が切れたら手元・429 を待つ・PC の中だけは送らない・復号できなければ送らない）を見る。鍵の誤り（401 auth）の場面は「ログイン切れは
 * 手元でやり直す」（F5）に替えた。中継だけの場面（取り消し・hold・中継の止まり）は stage1d.main.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const HOST = new URL(require('../src/relay').RELAY_BASE).hostname;   // src/relay.js の RELAY_BASE のホスト（第1d回 A-10: 仮の値を書かずに RELAY_BASE から取る）
// 0.10.0 LS-5（D62・決めたこと 112）で意図して変えた: オフラインモードは守秘のボタンでない（「外に出したくない会議」「外には送りません」を外した）
const L1 = 'この会議の音声は OpenAI に送られます（文字起こしのため）。ネットワークが不安定なときは、議事録の画面の［オフラインモード］を押すと、この会議の文字起こしを PC の中で行います。';
const L2 = 'ログインしていないため、この PC で文字起こししています（精度が落ちます）。設定の「アカウント」でログインしてください。';
const L3 = 'ログインが切れたため、この PC で文字起こししています（精度が落ちます）。設定の「アカウント」でもう一度ログインしてください。';
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
// net.request に渡した宛先のホスト（書き換える前）。要約の経路の確かめ（Anthropic）は除く
const sttHosts = (o) => [...new Set(o.netHosts.filter((h) => h !== 'api.anthropic.com'))];
// 中継の後ろの偽の OpenAI が受けた文字起こしの要求
const sttPosts = (o) => o.stt.filter((r) => r.path.endsWith('/audio/transcriptions'));
const textOf = (n) => (typeof n === 'string' ? n : (n && typeof n.text === 'string' ? n.text : ''));
const count = (o, text) => o.notices.filter((n) => textOf(n) === text).length;
const whisperSpawned = (o) => o.spawns.some((s) => /fake-whisper\.js$/.test(s.cmd) || /whisper-server/.test(s.cmd));
// mainrun の偽の safeStorage の暗号（'ENC1:' + hex を base64）を戻した、しまったログインの CF_Authorization（第1d回 A-11 で札から cookie にした）
const tokenOf = (o) => {
  try {
    const pack = JSON.parse(Buffer.from(Buffer.from(JSON.parse(o.secretsRaw).keys.relay, 'base64').toString('latin1').slice(5), 'hex').toString('utf8'));
    return pack.c.find((x) => x.name === 'CF_Authorization').value;
  } catch (_) { return ''; }
};
const noTokenAnywhere = (o) => {
  const token = tokenOf(o);
  assert.match(token, /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/, 'secrets.json にログインの cookie が無い');
  const blob = JSON.stringify([o.savedSettings, o.engineLog, o.notices, o.balloons, o.pages, o.relayLog]);
  assert.ok(!blob.includes(token), 'cookie の文字が設定・記録・知らせ・ページのどこかにある');
};

test('OL2・RL11: オンラインでログインしていれば、区間は中継の先のクラウド（OpenAI）で文字起こしされ、手元の whisper は起動しない。ページに経路が残る', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--segs=2']);
  assert.strictEqual(sttPosts(o).length, 2);
  assert.ok(sttPosts(o).every((r) => r.authOk && r.wavOk && r.fields.language === 'ja' && r.fields.model === 'gpt-4o-transcribe'));
  assert.match(sttPosts(o)[1].fields.prompt, /確認です。区間1$/, '2つ目の区間の認識ヒントの終わりに、直前の区間の尻尾が無い（#15）');
  assert.strictEqual(whisperSpawned(o), false, 'オンラインなのに手元の whisper を起動した');
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 2, local: 0, provider: 'openai' });
  assert.deepStrictEqual(o.pages[0].routeText.slice(0, 1), ['☁ 文字起こし: クラウド（OpenAI）2'], 'page:get の返事に経路の行が無い（C-3）');
  assert.strictEqual(o.statusCloud, true, 'ログインしているのに会議の状態の cloud が true でない（［PC の中だけ］のボタンが出ない）');
  assert.deepStrictEqual(sttHosts(o), [HOST], '中継のほかの宛先へ文字起こしの要求を出した');
  assert.ok(o.pages[0].segments.every((s) => s.text.startsWith('本日の議題は進捗の確認です') && !s.failed));
  assert.ok(o.balloons.includes(L1), '会議の始めの知らせ（L1）が無い');
  assert.ok(!o.engineLog.some((l) => l.includes('本日の議題')), '記録に文字起こしの本文がある');
  noTokenAnywhere(o);
});

test('D1: オフライン（isOnline が false）なら手元の whisper で文字起こしし、中継には1回も要求が無い', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--offline', '--segs=2']);
  assert.strictEqual(o.stt.length, 0);
  assert.deepStrictEqual(o.relayCalls, []);
  assert.strictEqual(whisperSpawned(o), true);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
});

// 0.7.0 U-1（設計書 D5・D7）で意図して変えた: 同意の選択を外した。前の版が保存した同意（ask・off）と送り先（groq・そのほかの URL・モデル）は読まない。
// 第1d回 A-3: ログインしていれば中継（その先の OpenAI の gpt-4o-transcribe は中継が決める）。前の版の「そのほか」の URL へは送らない
for (const consent of ['ask', 'off']) {
  test(`U-1・RL11: 保存の値が ${consent}・そのほかの URL でも、ログインしていれば中継（gpt-4o-transcribe）で文字起こしし、そのほかの URL へは送らない`, { timeout: sceneTimeout(20000) }, async () => {
    const o = await run(['text', '--relay=text', `--consent=${consent}`, '--legacy-provider', '--segs=1']);
    assert.strictEqual(sttPosts(o).length, 1, consent);
    assert.ok(sttPosts(o).every((r) => r.authOk && r.fields.model === 'gpt-4o-transcribe'), `${consent}: 前の版のモデルの名前で送った`);
    assert.deepStrictEqual(sttHosts(o), [HOST], `${consent}: 前の版の「そのほか」の URL へ直に送った`);
    assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 1, local: 0, provider: 'openai' }, consent);
    assert.strictEqual(o.statusCloud, true, consent);
    assert.ok(!o.notices.some((n) => /オンラインの文字起こしを使うか/.test(textOf(n))), `${consent}: 外した同意の案内が出た`);
    assert.deepStrictEqual([o.savedSettings.cloudTranscribe, o.savedSettings.sttProvider], [consent, 'custom'], `${consent}: 前の版の値を settings.json から消した・書き換えた（JS6）`);
    noTokenAnywhere(o);
  });
}

// 第1d回 A-3（RL11・D6）で意図して変えた: 前の版の鍵（groq・custom と、0.7.0 の OpenAI の鍵）は文字起こしに使わない。
// ログインしていない PC は、鍵があっても中継へも OpenAI へも送らず手元で取り、ログインの案内（L2）を出す。
// 第1d回 A-4（F11・K2）で意図して変えた: 前の版の鍵は起動のときに purgeOld が消す（前は「鍵は消さない」を見ていた）
for (const id of ['groq', 'custom', 'openai']) {
  test(`U-1・RL11・K2: ${id} の名前の鍵しか無い（ログインしていない）PC は、その鍵を送らず手元で取り、ログインの案内を1回出す（鍵は起動で消す）`, { timeout: sceneTimeout(20000) }, async () => {
    const o = await run(['text', '--relay=text', '--signed-out', `--key-for=${id}`, '--legacy-provider', '--segs=2']);
    assert.strictEqual(o.stt.length, 0, `${id}: 前の版の鍵で送った`);
    assert.deepStrictEqual(o.relayCalls, [], `${id}: ログインしていないのに中継へ要求を出した`);
    assert.deepStrictEqual(sttHosts(o), [], `${id}: 外へ文字起こしの要求を出した`);
    assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' }, id);
    assert.strictEqual(o.statusCloud, false, `${id}: ログインしていないのに［PC の中だけ］のボタンが出る`);
    assert.strictEqual(count(o, L2), 1, id);
    assert.ok(o.secretsRaw === null || !o.secretsRaw.includes(`"${id}"`), `${id}: 前の版の鍵が残った`);
    assert.ok(o.engineLog.includes('secrets: 前の鍵 1 個を消しました'), `${id}: 起動で前の版の鍵を消していない`);
  });
}

test('RF28: ［この会議は PC の中だけ］なら、中継に音声を送らず、札も復号しない', { timeout: sceneTimeout(20000) }, async () => {
  const l = await run(['text', '--relay=text', '--local-only', '--segs=2']);
  assert.strictEqual(sttPosts(l).length, 0);
  assert.ok(!l.relayCalls.includes('/v1/audio/transcriptions'));
  assert.deepStrictEqual(l.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.strictEqual(l.draftLocalOnly, true, '［PC の中だけ］を下書きに書いていない（落ちて復旧すると送り直しがクラウドへ行く）');
  assert.strictEqual(l.pages[0].route.localOnly, true);
  assert.ok(l.engineLog.some((x) => /区間 s1 → local（理由: local-only）/.test(x)), '［PC の中だけ］の区間の理由が local-only でない');
  assert.ok(!l.notices.some((n) => textOf(n) === L2), '［PC の中だけ］なのに、ログインしていないと知らせた');
  assert.ok(!l.notices.concat(l.balloons).some((n) => textOf(n) === L1), '［PC の中だけ］を押した後に、クラウドへ送ると知らせた（L1）');
  // C-3: 画面と同じ IPC（meeting:set-local-only）で押し、会議の状態に印と「クラウドで処理する PC か」が載る
  assert.deepStrictEqual(l.localOnly, { ok: true, localOnly: true });
  assert.deepStrictEqual(l.statusLocalOnly, { localOnly: true, cloud: true });
  assert.deepStrictEqual(l.pages[0].routeText.slice(0, 1), ['🖥 文字起こし: PC']);
  // ［PC の中だけ］の区間では札を復号しない（復号は起動と会議の始めの経路の確かめの分だけで、区間の数では増えない）
  const l1 = await run(['text', '--relay=text', '--local-only', '--segs=1']);
  assert.strictEqual(l.decrypts, l1.decrypts, `［PC の中だけ］の区間で札を復号した（区間 2 つで ${l.decrypts} 回・1つで ${l1.decrypts} 回）`);
  // 第1d回 A-11（F26）: 経路の判断のたびに復号し直すのは、起動のときに復号できなかった（key-unreadable）ときだけ。そのときも［PC の中だけ］の
  // 区間では復号し直さない（区間の数で増えない）
  const [u2, u1] = await Promise.all([run(['text', '--relay=text', '--local-only', '--key-unreadable', '--segs=2']),
    run(['text', '--relay=text', '--local-only', '--key-unreadable', '--segs=1'])]);
  assert.ok(u1.decrypts >= 1, '場面の前提: 起動のときに復号を試していない');
  assert.strictEqual(u2.decrypts, u1.decrypts, `復号できないとき、［PC の中だけ］の区間で復号し直した（区間 2 つで ${u2.decrypts} 回・1つで ${u1.decrypts} 回）`);
});

test('RF27: 中継へ送っている途中で切れた区間だけ手元でやり直し、次の区間はクラウドに戻る', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=cut-first', '--segs=2']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 1, local: 1, provider: 'openai' });
  assert.ok(o.pages[0].segments.every((s) => !s.failed));
  assert.ok(o.engineLog.some((l) => /区間 s1 → local（理由: net）/.test(l)));
});

test('RF29: 429 は待ってからクラウドで取れる（手元へ落とさない）。待っていることを1回知らせる', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=429', '--segs=2']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 2, local: 0, provider: 'openai' });
  assert.strictEqual(whisperSpawned(o), false);
  assert.strictEqual(o.notices.filter((n) => /利用の上限に近いため/.test(textOf(n))).length, 1);
});

// 第1d回 A-3（F5）で意図して変えた: 前は 401（鍵の誤り）を区間の失敗として残した。中継の 401 login（ログイン切れ）は、その区間を手元でやり直し、
// 札を消して［ログインし直す］付きの L3 を1回出す。次の区間は中継へ送らない（会社の鍵の誤りは中継の 502 upstream-auth で、別の符号: stage1d.main）
// 第1d回 A-11 で意図して変えた: 取り消しは偽の Access の前（--revoked はその人の cookie を取り消す）。答えは Access の 401（cf-ray つき）
test('F5: Access の 401（cookie が取り消されていた）は、その区間を手元でやり直し（失敗として残さない）、cookie を消して L3 を1回。次の区間は中継へ送らない', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--revoked', '--segs=2']);
  assert.ok(o.pages[0].segments.every((s) => !s.failed && s.text.startsWith('本日の議題は進捗の確認です')), JSON.stringify(o.pages[0].segments));
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.strictEqual(o.relayCalls.filter((p) => p === '/v1/audio/transcriptions').length, 1, `札を消した後も中継へ送った: ${o.relayCalls}`);
  assert.deepStrictEqual(o.notices.filter((n) => textOf(n) === L3), [{ text: L3, action: 'account' }]);
  assert.strictEqual(tokenOf(o), '', 'Access が 401 を返したのに cookie を残した');
  assert.strictEqual(o.recoveryKept, false, '手元で取れたのに送り直しの待ち行列に残した');
  assert.strictEqual(whisperSpawned(o), true);
});

// 第1d回 A-3 で意図して変えた: 前は 401（鍵の誤り）でも残した。中継の失敗で区間の失敗として残すのは、OpenAI の上限の 429 を待ちきれないときだけ
test('RF29・OL2: 長い 429（OpenAI の 1日の上限）は区間を失敗として残し（音声は送り直しの待ち行列へ）、上限を1回知らせる。手元へは落とさない', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=429-long', '--segs=2']);
  assert.ok(o.pages[0].segments.every((s) => s.failed && /上限に達しました/.test(s.text)), JSON.stringify(o.pages[0].segments));
  assert.strictEqual(whisperSpawned(o), false);
  assert.strictEqual(o.notices.filter((n) => /OpenAI の利用の上限に達しました/.test(textOf(n))).length, 1, '会議と送り直しで二重に知らせた');
  assert.strictEqual(o.recoveryKept, true, '送り直しでも長い 429 だったのに、音声か待ち行列を消した');
  // 0.9.4 S-3 で足した: エンジンが答えた誤りの区間も音声を残すようになったので、上限は「止めて残す」（失敗に数えない）道を通ったことも見る
  assert.ok(o.engineLog.some((l) => /^復旧の文字起こしを止めました（理由: rate-long）/.test(l)), o.engineLog.join('\n'));
  noTokenAnywhere(o);
});

// 第1d回 A-11（F26）で意図して変えた: 復号できないだけのときは「ログインしていない」（L2）も出さない（記録1行だけ。次の判断で戻し直す）
test('RF30・F26: しまったログインのファイルはあるが復号できない（safeStorage が一時的に使えない）ときは、空の partition で送らずに手元で取り、ログインは消さない。L2・L3 は出さない', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--key-unreadable', '--segs=1']);
  assert.strictEqual(o.stt.length, 0, '空の partition で送った');
  assert.deepStrictEqual(o.relayCalls, []);
  assert.strictEqual(count(o, L2), 0, '復号できないだけなのに「ログインしていない」と知らせた');
  assert.strictEqual(count(o, L3), 0, 'ログイン切れ（L3）と誤って知らせた');
  assert.ok(o.engineLog.some((l) => l.includes('key-unreadable')));
  assert.ok(JSON.parse(o.secretsRaw).keys.relay, '復号できないだけのログインを消した');
});

test('F10: ログインしていない最初の日は手元で取れ、ログインの案内が1回出る。［PC の中だけ］のボタンは出ない', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--signed-out', '--segs=2']);
  assert.strictEqual(o.stt.length, 0);
  assert.strictEqual(o.statusCloud, false, 'ログインしていないのに会議の状態の cloud が true（［PC の中だけ］のボタンが出る）');
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.strictEqual(count(o, L2), 1);
});

test('D1: 音声入力もオンラインならクラウドで文字起こしし、履歴に入る', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--dictate']);
  assert.strictEqual(sttPosts(o).length, 1);
  assert.strictEqual(o.history[0].text.startsWith('本日の議題は進捗の確認です'), true);
  assert.strictEqual(whisperSpawned(o), false);
});

test('OL2: 復旧の文字起こしもクラウドで処理でき、そのときは手元のエンジンを起こさない', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--recover']);
  assert.strictEqual(sttPosts(o).length, 1);
  assert.strictEqual(whisperSpawned(o), false);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 1, local: 0, provider: 'openai' });
});

// CI の直し（run 39583796615 の Windows で OL2 が sttPosts 0 で落ちた）: 復旧のページは DB に入った後、main が答えを受けてから recovery.json を書く。
// 混んだ機械ではその間が空き、場面が「待ち行列が無い」を「済んだ」と読んで、クラウドへ送る前に写していた。答えを 3 秒止めても同じ結果になること（場面が待ち始めた後まで止める）
test('OL2（CI の直し）: 復旧の頼みの答えが遅れても、場面はクラウドの文字起こしが済むまで待つ', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--recover', '--slow-ack=meeting.recover:3000']);
  assert.strictEqual(sttPosts(o).length, 1);
  assert.strictEqual(whisperSpawned(o), false);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 1, local: 0, provider: 'openai' });
});

test('RF26: 中継に届かない（証明書）ときは手元で続け、理由を会議ごとに1回だけ知らせる', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--relay-cert', '--segs=2']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.strictEqual(o.notices.filter((n) => /証明書が差し替えられている可能性があります/.test(textOf(n))).length, 1);
});

test('調べた結果の 10: 復旧をクラウドで先へ通した後、手元に落ちた区間で whisper が無ければ、音声と待ち行列を消さずに残す', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=drop', '--recover', '--no-whisper']);
  assert.strictEqual(o.recoveryKept, true, '手元のエンジンが無いのに、送り直しの音声か待ち行列を消した');
  // 0.9.4 S-3 で足した: 失敗に数えず（tries を増やさず）止めて残す道を通った
  assert.ok(o.engineLog.some((l) => /^復旧の文字起こしを止めました（理由: (engine|down)）/.test(l)), o.engineLog.join('\n'));
});

// 0.7.0 U-1 で意図して変えた: 手元の場面は「同意が既定の ask」でなく、第1d回 A-3 から「ログインしていない PC」
test('F14: 手元の場面（ログインしていない）は今どおり起動のときに whisper を先読みし、ページに印が残る', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--signed-out', '--segs=1']);
  assert.strictEqual(whisperSpawned(o), true);
  assert.strictEqual(o.pages[0].route.localOnly, false);
});

test('RF28: ［PC の中だけ］の会議が落ちて復旧しても、送り直しは手元で、中継に要求が無く、ページに印が残る', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--recover', '--local-only']);
  assert.strictEqual(o.stt.length, 0);
  assert.deepStrictEqual(o.relayCalls, [], 'PC の中だけの会議の復旧で、中継へ届くかを確かめた（/health）か送った');
  assert.strictEqual(whisperSpawned(o), true);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 1, provider: 'openai' });
  assert.strictEqual(o.pages[0].route.localOnly, true);
});

// ---------------------------------------------------------------- 第1c回 B-3: 要約の経路（偽の claude）
const llamaSpawned = (o) => o.spawns.some((s) => /fake-llama\.js$/.test(s.cmd));
const pCalls = (o) => o.claude.filter((l) => l.kind === 'p');

test('D2: オンラインの自動の要約は Claude Code で作られ、出典が付き、手元の llama は起動しない。課金の変数は子に渡らない', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--sum', '--claude=ok', '--segs=2']);
  assert.strictEqual(pCalls(o).length, 1);
  assert.deepStrictEqual(o.claude.map((l) => l.envKeys), [[], []], '課金の変数が auth status か -p に渡った');
  assert.ok(o.claude[0].kind === 'auth' && o.claude[1].kind === 'p', 'auth status を先に読んでいない');
  assert.strictEqual(pCalls(o)[0].stdinHasTranscript, true, '文字起こしを標準入力で渡していない');
  // 手元の1回の要約と同じ指示文（構成の指示と型の見出し）を標準入力で渡し、役割の文（MINUTES_SYS）を --system-prompt に渡す（F9。
  // 偽の claude は何を受けても同じ Markdown を返すので、受けたものを記録で見る）
  assert.strictEqual(pCalls(o)[0].stdinHasAsk, true, '手元と同じ構成の指示文を標準入力で渡していない');
  const pargs = pCalls(o)[0].args;
  const sys = pargs[pargs.indexOf('--system-prompt') + 1] || '';
  assert.ok(pargs.includes('--system-prompt') && sys.startsWith('あなたは議事録作成の専門家です') && sys.includes('文字起こしに無い情報を創作せず'),
    '役割の文が手元の llama の system と同じでない');
  assert.strictEqual(path.basename(pCalls(o)[0].cwd), 'claude-run', '作業フォルダが NaTsu の空のフォルダ（<userData>/claude-run）でない');
  assert.strictEqual(llamaSpawned(o), false, 'オンラインなのに手元の llama を起動した');
  const p = o.pages[0];
  assert.strictEqual(p.route.summary.by, 'claude-code');
  // C-3: 画面に渡る経路の行は page:get の返事にも、要約の後の page:updated にも載る（要約の後に描き直しても消えない）
  assert.deepStrictEqual(p.routeText, ['☁ 文字起こし: クラウド（OpenAI）2', '✨ 要約: Claude Code']);
  assert.deepStrictEqual(o.updatedRouteText, p.routeText, '要約の後の page:updated に経路の行が無い（描き直すとプロパティの行から消える）');
  assert.deepStrictEqual(o.segUpdateRouteText, p.routeText, '文字起こしの行を直した返事に経路の行が無い（直すとプロパティの行から消える）');
  assert.ok(p.citeStat && p.citeStat.total > 0, '出典の照合を通っていない');
  assert.ok(p.todos.every((t) => t.assignee === '' && t.due === ''), '文字起こしに無い担当・期限が残った（照らしを通っていない）');
  assert.strictEqual(p.summaryError, '');
  assert.ok(!o.engineLog.some((l) => l.includes('進捗の確認を行った')), '記録に要約の本文がある');
});

test('D1・F2: オンラインで上限なら、要約の欄にリセットの時刻を出し、手元の llama では作らない', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--sum', '--claude=limit', '--segs=1']);
  assert.match(o.pages[0].summaryError, /Claude の利用の上限に達しました（3:45pm に戻ります）/);
  assert.strictEqual(llamaSpawned(o), false);
  assert.strictEqual(o.pages[0].todos.length, 0);
  assert.ok(o.engineLog.some((l) => /要約: Claude Code → limit/.test(l)));
  assert.strictEqual((o.pages[0].route || {}).summary, undefined, '失敗したのに、ページに要約の経路を書いた（成功したときだけ書く）');
});

// 第1b回の続き Lane F（利用者の PC の 0.5.0）: auth status は claude.ai のまま、-p だけが 401（OAuth の鍵が切れた）で落ちた。
// 要約の欄は［Claude Code にログイン］へ案内し、engine.log は符号・副型・状態の番号だけ（返事の英語の文も本文も写さない）
test('Lane F-a: -p が 401（OAuth の鍵が切れた）なら、要約の欄にログインの案内、記録は符号と副型と状態の番号だけ。手元の llama では作らない', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--sum', '--claude=expired401', '--segs=1']);
  assert.strictEqual(pCalls(o).length, 1);
  assert.strictEqual(o.pages[0].summaryError, 'Claude Code のログインが切れています。設定の［Claude Code にログイン］を押してください。');
  assert.ok(o.engineLog.includes('要約: Claude Code → auth-expired（subtype=success・api_error_status=401）'), o.engineLog.filter((l) => l.includes('Claude')).join('\n'));
  assert.ok(!o.engineLog.some((l) => /OAuth|authenticate|Re-authenticate/i.test(l)), '返事の英語の文が記録に写った');
  assert.ok(!o.engineLog.some((l) => l.includes('本日の議題')), '記録に文字起こしがある');
  assert.strictEqual(llamaSpawned(o), false);
  assert.strictEqual((o.pages[0].route || {}).summary, undefined);
});

test('RF25: Claude Code が API キーで動く設定なら -p を呼ばずに理由を出す', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--sum', '--claude=ok', '--claude-auth=api_key_helper', '--segs=1']);
  assert.strictEqual(pCalls(o).length, 0);
  assert.match(o.pages[0].summaryError, /API キー（従量課金）で動く設定/);
  assert.strictEqual((o.pages[0].route || {}).summary, undefined, '失敗したのに、ページに要約の経路を書いた（成功したときだけ書く）');
  assert.strictEqual(llamaSpawned(o), false);
});

test('RF24: Claude Code が無ければ入れ方を出す（手元の llama では作らない）', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--sum', '--claude=missing', '--segs=1']);
  assert.match(o.pages[0].summaryError, /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
  assert.strictEqual((o.pages[0].route || {}).summary, undefined, '失敗したのに、ページに要約の経路を書いた（成功したときだけ書く）');
  assert.strictEqual(llamaSpawned(o), false);
});

// 0.10.0 LS-2（D59・決めたこと 103）で意図して変えた: オフラインなら手元の llama で作らず、要約待ち（つながったら作る）
test('D1・D59: オフラインなら Claude Code も手元の llama も呼ばず、要約待ち。ページに要約の経路を書かない', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--offline', '--sum', '--claude=ok', '--segs=2']);
  assert.strictEqual(o.claude.length, 0);
  assert.strictEqual(llamaSpawned(o), false);
  assert.strictEqual(o.pages[0].summaryWait, true);
  assert.strictEqual(o.pages[0].summaryError, '要約待ち（つながったら作ります）');
  assert.strictEqual((o.pages[0].route || {}).summary, undefined);
});

// 0.10.0 LS-2（D59。設計書の C10 を要約について取り消した）で意図して変えた: オフラインモードの会議も要約は Claude Code。
// 文字起こしは今どおり PC の中（音声をクラウドの文字起こしへ送らない）
test('C10・F13・D59: オフラインモードの会議は、音声をクラウドへ送らず PC で文字起こしし、要約は Claude Code で作る（手元の llama は起こさない）', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--relay=text', '--local-only', '--sum', '--claude=ok', '--segs=2']);
  assert.strictEqual(pCalls(o).length, 1, 'オフラインモードの会議の要約を Claude Code で作っていない');
  assert.deepStrictEqual(o.stt.filter((r) => r.path.endsWith('/audio/transcriptions')), [], 'オフラインモードの会議の音声をクラウドへ送った');
  assert.strictEqual(llamaSpawned(o), false);
  assert.strictEqual(o.pages[0].route.summary.by, 'claude-code');
});

// 0.10.0 LS-2（D59）で意図して変えた: --claude を付けない場面は届くかの確かめが試験の守りで止まり、要約待ち（手元の llama で作らない）
test('今の場面を守る: --claude を付けない要約の場面は、届くかの確かめが試験の守りで止まり、要約待ちになる（偽の claude も本物も手元の llama も起こさない）', { timeout: sceneTimeout(20000) }, async () => {
  const o = await run(['text', '--sum', '--segs=2']);
  assert.deepStrictEqual(o.claude, []);
  assert.strictEqual(llamaSpawned(o), false);
  assert.strictEqual(o.pages[0].summaryError, '要約待ち（つながったら作ります）');
  assert.deepStrictEqual(o.pages[0].routeText, ['🖥 文字起こし: PC']);
});
