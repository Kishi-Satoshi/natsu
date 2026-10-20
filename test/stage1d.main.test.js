/*
 * stage1d.main.test.js — 第1d回 Task A-3（RL11・RF35・RF36・F4・F5・F7）: 文字起こしを中継へ送る main のつなぎを、偽の Electron の上で
 * main.js を本当に動かして確かめる（helpers/mainrun.js の --relay）。中継は本物の relay/ のコードを 127.0.0.1 で包んだもの
 * （helpers/relay-local.js）で、その後ろの OpenAI は偽物（helpers/fake-stt.js）。偽の Electron の net.request が RELAY_BASE を書き換えて
 * 届ける。外へはつながない。ログインは mainrun が main を読む前に、偽の Access がその人に出した cookie を packCookies でまとめて secrets に置く（第1d回 A-11。--signed-out なら置かない）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args) => new Promise((resolve, reject) => {
  execFile(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const T = { timeout: 20000 };
const HOST = new URL(require('../src/relay').RELAY_BASE).hostname;   // src/relay.js の RELAY_BASE のホスト（第1d回 A-10: 仮の値を書かずに RELAY_BASE から取る）
// 知らせ（計画「画面と知らせの文」の L1〜L10）
const L1 = 'この会議の音声は OpenAI に送られます（文字起こしのため）。1on1・面談など外に出したくない会議は、議事録の画面の［この会議は PC の中だけ］を押してください。';
const L2 = 'ログインしていないため、この PC で文字起こししています（精度が落ちます）。設定の「アカウント」でログインしてください。';
const L3 = 'ログインが切れたため、この PC で文字起こししています（精度が落ちます）。設定の「アカウント」でもう一度ログインしてください。';
const L4 = 'NaTsu のサーバーにつながらないため、この PC で文字起こしを続けますが、精度が落ちます。録音はそのまま続けてください。';
const L5 = `文字起こしの中継につながりません（会社の通信の検査で証明書が差し替えられている可能性があります）。この PC で文字起こしを続けますが、精度が落ちます。続くときは情報システムに ${HOST} への通信の許可を頼んでください。`;
const L6 = '今日のクラウドの文字起こしの上限に達したため、今日の残りはこの PC で文字起こしします。精度が落ちます。録音はそのまま続けてください。';
const L7 = '文字起こしの中継が今は使えません。この PC で文字起こしを続けますが、精度が落ちます。続くときは管理者に知らせてください。';
const L8 = '文字起こしの中継が混み合っているか、止まっているため、この区間はこの PC で文字起こししました（精度が落ちます）。録音はそのまま続けてください。';
const L9 = (sec) => `OpenAI の利用の上限に近いため、${sec} 秒待ってから送り直しています。録音はそのまま続けてください。`;
const L11 = 'このメールアドレスでは文字起こしの中継を使えないため、この PC で文字起こしを続けますが、精度が落ちます。管理者に知らせてください。';   // 第1d回 A-11
const L10 = 'OpenAI の利用の上限に達しました。文字起こしできなかった区間の音声は残してあり、議事録を閉じた後にもう一度試します。録音はそのまま続けてください。';
const ALL_L = [L1, L2, L3, L4, L5, L6, L7, L8, L10];

const textOf = (n) => (typeof n === 'string' ? n : (n && typeof n.text === 'string' ? n.text : ''));
const count = (o, text) => o.notices.filter((n) => textOf(n) === text).length;
const STT = '/v1/audio/transcriptions';
const posts = (calls) => calls.filter((p) => p === STT).length;
const whisperSpawned = (o) => o.spawns.some((s) => /fake-whisper\.js$/.test(s.cmd) || /whisper-server/.test(s.cmd));
const allText = (segs) => segs.length > 0 && segs.every((s) => !s.failed && s.text.startsWith('本日の議題は進捗の確認です'));
// mainrun の偽の safeStorage の暗号（'ENC1:' + hex を base64）を戻した、しまった文字（第1d回 A-11: packCookies の JSON）
const plainOf = (secretsRaw) => {
  try { return Buffer.from(Buffer.from(JSON.parse(secretsRaw).keys.relay, 'base64').toString('latin1').slice(5), 'hex').toString('utf8'); } catch (_) { return ''; }
};
// しまった CF_Authorization の値（JWT）。無ければ ''
const cookieOf = (secretsRaw) => {
  try { return JSON.parse(plainOf(secretsRaw)).c.find((x) => x.name === 'CF_Authorization').value; } catch (_) { return ''; }
};
// cookie（JWT）の文字が、設定・記録・知らせ・ページ・中継の記録のどこにも無い（F1・F21）
const noTokenAnywhere = (o, jwt) => {
  assert.match(jwt, /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/, 'secrets.json に cookie が無い');
  const blob = JSON.stringify([o.savedSettings, o.settingsText, o.engineLog, o.notices, o.balloons, o.pages, o.relayLog]);
  assert.ok(!blob.includes(jwt), 'cookie の文字が設定・記録・知らせ・ページのどこかにある');
};

test('RL11: ログインしてオンラインなら、会議の全部の区間を中継で文字起こしし、ページの経路は『クラウド（OpenAI）』。L1 の知らせが1回。手元の whisper は起きない', T, async () => {
  const o = await run(['text', '--relay=text', '--segs=2']);
  assert.strictEqual(posts(o.relayCalls), 2, `中継へ送った区間の数: ${o.relayCalls}`);
  // 中継の後ろの偽の OpenAI が受けた形（モデルは中継が決める・言語とヒントはアプリの見出しから）
  const up = o.stt.filter((r) => r.path.endsWith('/audio/transcriptions'));
  assert.strictEqual(up.length, 2);
  assert.ok(up.every((r) => r.authOk && r.wavOk && r.fields.language === 'ja' && r.fields.model === 'gpt-4o-transcribe'));
  assert.match(up[1].fields.prompt, /確認です。区間1$/, '2つ目の区間の認識ヒントの終わりに、直前の区間の尻尾が無い（#15）');
  assert.strictEqual(whisperSpawned(o), false, 'オンラインでログインしているのに手元の whisper を起動した');
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 2, local: 0, provider: 'openai' });
  assert.deepStrictEqual(o.pages[0].routeText.slice(0, 1), ['☁ 文字起こし: クラウド（OpenAI）2']);
  assert.ok(allText(o.pages[0].segments));
  assert.strictEqual(o.statusCloud, true, 'ログインしているのに会議の状態の cloud が true でない（［PC の中だけ］のボタンが出ない）');
  assert.strictEqual(count(o, L1), 1, `L1 が1回でない: ${JSON.stringify(o.notices)}`);
  assert.ok(o.balloons.includes(L1), '会議の始めのトレイの知らせ（L1）が無い');
  assert.ok(!o.notices.some((n) => ALL_L.slice(1).includes(textOf(n))), `クラウドで取れたのに手元の知らせが出た: ${JSON.stringify(o.notices)}`);
  assert.ok(o.engineLog.some((l) => /文字起こしの経路: 区間 s1 → cloud\(relay\) [0-9.]+ 秒/.test(l)), o.engineLog.join('\n'));
  assert.ok(!o.engineLog.some((l) => l.includes('本日の議題')), '記録に文字起こしの本文がある');
  // RF2・F6: 外へ出た要求は全部 RELAY_BASE のホストだけで、api.openai.com に1回も行かない（要約の経路の確かめの Anthropic は除く）
  assert.deepStrictEqual([...new Set(o.netHosts.filter((h) => h !== 'api.anthropic.com'))], [HOST]);
  assert.ok(!o.netHosts.includes('api.openai.com'));
  noTokenAnywhere(o, cookieOf(o.secretsRaw));
  // 第1d回 A-11（RL9・F21）: 文字起こしの要求は cookie つき（線の上の Cookie）で、Authorization の見出しは無く、X-Requested-With が付く。
  // 届くかの確かめ（/health）も同じ partition で送るが、cookie を付けなくてよい（転送も「届く」なので、Access のログインの画面への 302 でも届く）
  const sttWire = o.relayWire.filter((x) => x.path === STT);
  assert.ok(sttWire.length === 2 && sttWire.every((x) => x.cookie && !x.authorization && x.xrw === 'XMLHttpRequest'), JSON.stringify(o.relayWire));
  assert.ok(o.relayWire.every((x) => !x.authorization), JSON.stringify(o.relayWire));
});

test('RL11: ログインしていなければ、中継へ1回も送らず（/health も聞かない）手元で、L2 を1回', T, async () => {
  const o = await run(['text', '--relay=text', '--signed-out', '--segs=2']);
  assert.deepStrictEqual(o.relayCalls, [], 'ログインしていないのに中継へ要求を出した');
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.ok(allText(o.pages[0].segments));
  assert.strictEqual(whisperSpawned(o), true);
  assert.strictEqual(o.statusCloud, false, 'ログインしていないのに［PC の中だけ］のボタンが出る');
  assert.strictEqual(count(o, L2), 1);
  assert.ok(!o.notices.concat(o.balloons).some((n) => textOf(n) === L1), 'ログインしていないのに OpenAI へ送ると知らせた');
  assert.ok(o.engineLog.some((l) => /区間 s1 → local（理由: signed-out）/.test(l)), o.engineLog.join('\n'));
});

// 第1d回 A-11 で意図して変えた: 札の取り消し（D1 の revoked_at）を、偽の Access の前での取り消し（Zero Trust の Revoke）に。消すのは cookie
test('F5・F19: 会議の途中で偽の Access の前がその人を取り消す（Zero Trust の Revoke と同じ）→ その区間から手元でやり直し、全部の区間に文字がある。L3 の知らせは1回で action: account。cookie は secrets.json から消える。次の会議は手元のまま（中継に送らない）。ログインの窓は開かない', T, async () => {
  const o = await run(['text', '--json-scene=relay-revoke', '--relay=text']);
  assert.strictEqual(o.firstCloud, true, '1つ目の区間が中継で文字にならなかった');
  assert.deepStrictEqual(o.m1.route.stt, { cloud: 1, local: 2, provider: 'openai' });
  assert.ok(allText(o.m1.segments), `取り消した後の区間に文字が無い: ${JSON.stringify(o.m1.segments)}`);
  // 2つ目の区間で Access の 401（cf-ray つきの HTML）。3つ目の区間はログインが無いので、/health も文字起こしも送らない
  assert.strictEqual(posts(o.m1.calls), 2);
  assert.strictEqual(o.m1.calls[o.m1.calls.length - 1], STT, `ログインを消した後に中継へ送った: ${o.m1.calls}`);
  const l3 = o.notices.filter((n) => textOf(n) === L3);
  assert.deepStrictEqual(l3, [{ text: L3, action: 'account' }], `L3 は ［ログインし直す］のボタン付きで1回: ${JSON.stringify(o.notices)}`);
  assert.strictEqual(count(o, L2), 1, 'L3 を出した会議の中で「ログインしていない」（L2）を重ねた・次の会議で L2 が出ない');
  assert.ok(cookieOf(o.secretsBefore), '種をまいた cookie が無い');
  assert.strictEqual(JSON.parse(o.secretsAfter).keys.relay, undefined, 'Access が 401 を返したのに cookie を secrets.json に残した');
  assert.strictEqual(JSON.parse(o.settingsAfter).accountEmail, '', 'ログイン切れなのに accountEmail を残した');
  assert.strictEqual(o.statusCloudAfter, false);
  assert.ok(o.engineLog.includes('アカウント: 中継が login。ログインを消した'), o.engineLog.join('\n'));
  // Access の答えの形を1行（実機の R4 の手がかり。値・URL は書かない）
  assert.ok(o.engineLog.includes('アカウント: 中継の答え 401（cf-ray あり・行き先 なし）→ login'), o.engineLog.join('\n'));
  // 2回目の会議: ログインが無いので /health も文字起こしも送らない
  assert.deepStrictEqual(o.m2.calls, [], 'ログインが消えた後の会議で中継へ送った');
  assert.deepStrictEqual(o.m2.route.stt, { cloud: 0, local: 1, provider: 'openai' });
  assert.ok(allText(o.m2.segments));
  assert.ok(!JSON.stringify([o.engineLog, o.notices]).includes(cookieOf(o.secretsBefore)), 'cookie の文字が記録か知らせにある');
  assert.deepStrictEqual(o.loginWins, [], 'ログイン切れでログインの窓を開いた（F27）');
});

test('F5: 古い cookie の 401 が、送っている間にログインし直した新しい cookie を消さない（送ったときの pack と比べる。次の会議は新しい cookie で中継へ）', T, async () => {
  const o = await run(['text', '--json-scene=relay-relogin', '--relay=text']);
  assert.strictEqual(o.login.ok, true, `ログインし直せなかった: ${JSON.stringify(o.login)}`);
  const a = cookieOf(o.secretsBefore);
  const b = cookieOf(o.secretsRelogin);
  assert.ok(a && b && a !== b, 'ログインし直して新しい cookie になっていない（場面の前提）');
  assert.strictEqual(cookieOf(o.secretsAfter), b, '古い cookie の 401 で、ログインし直した新しい cookie を消した');
  assert.deepStrictEqual(o.m1.route.stt, { cloud: 0, local: 1, provider: 'openai' });
  assert.ok(allText(o.m1.segments));
  assert.ok(o.engineLog.includes('アカウント: 中継が login。送った後にログインし直していたので、今のログインは消さない'), o.engineLog.join('\n'));
  assert.strictEqual(count(o, L3), 0, `ログインし直した後なのに「ログインが切れた」を出した: ${JSON.stringify(o.notices)}`);
  assert.deepStrictEqual(o.m2.route.stt, { cloud: 1, local: 0, provider: 'openai' }, '新しい cookie で中継へ送っていない');
});

test('F5・F22: 送っている間に自分でログアウトした後の古い cookie の 401 は、「ログインが切れた」（L3）を出さず、記録も「ログアウトした後」。その区間は手元でやり直す', T, async () => {
  const o = await run(['text', '--json-scene=relay-logout', '--relay=text']);
  assert.ok(cookieOf(o.secretsBefore), '種をまいた cookie が無い（場面の前提）');
  assert.strictEqual(o.logout.ok, true, JSON.stringify(o.logout));
  assert.ok(o.engineLog.includes('アカウント: ログアウトした（Access ok）'), o.engineLog.join('\n'));
  assert.deepStrictEqual(o.m1.route.stt, { cloud: 0, local: 1, provider: 'openai' });
  assert.ok(allText(o.m1.segments));
  assert.ok(o.engineLog.some((l) => /中継で失敗（login 401）/.test(l)), `古い cookie の 401 になっていない（場面の前提）: ${o.engineLog.join('\n')}`);
  assert.strictEqual(count(o, L3), 0, `自分でログアウトしたのに「ログインが切れた」を出した: ${JSON.stringify(o.notices)}`);
  assert.ok(o.engineLog.includes('アカウント: 中継が login。送った後にログアウトしていた'), o.engineLog.join('\n'));
  assert.ok(!o.engineLog.some((l) => l.includes('ログインし直していた')), '理由の違う記録を書いた');
  assert.ok(!JSON.parse(o.secretsAfter || '{"keys":{}}').keys.relay, 'ログアウトしたのに cookie が残った');
});

test('F4・RF35: --relay-down（中継の口が閉じている）→ 全部の区間が手元・L4 を1回', T, async () => {
  const o = await run(['text', '--relay=text', '--relay-down', '--segs=2']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.ok(allText(o.pages[0].segments));
  assert.strictEqual(o.stt.length, 0);
  assert.strictEqual(posts(o.relayCalls), 0, '届かない中継へ音声を送ろうとした（/health が届かないなら送らない）');
  assert.strictEqual(count(o, L4), 1, JSON.stringify(o.notices));
  assert.ok(o.engineLog.some((l) => /区間 s1 → local（理由: unreachable）/.test(l)), o.engineLog.join('\n'));
});

test('F4・RF35: --relay=500（中継の後ろが 5xx → 中継は 502 upstream）→ その区間は手元でやり直し、全部の区間に文字がある。L8 を1回', T, async () => {
  const o = await run(['text', '--relay=500', '--segs=2']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.ok(allText(o.pages[0].segments));
  assert.strictEqual(posts(o.relayCalls), 2, '次の区間でもう一度中継を試していない');
  assert.strictEqual(count(o, L8), 1, JSON.stringify(o.notices));
  assert.ok(o.engineLog.some((l) => /区間 s1 → local（理由: server）/.test(l)), o.engineLog.join('\n'));
  assert.strictEqual(o.recoveryKept, false, '手元で取れたのに送り直しの待ち行列に残した');
});

test('F4・RF35: --relay=slow（中継の後ろが 1.5 秒待つ）→ クラウドのまま（時間切れにしない）', T, async () => {
  const o = await run(['text', '--relay=slow', '--segs=1']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 1, local: 0, provider: 'openai' });
  assert.strictEqual(whisperSpawned(o), false);
  assert.ok(allText(o.pages[0].segments));
});

test('RF27・RF35: 中継へ送っている途中で切れた区間だけ手元でやり直し（L4 を1回）、次の区間はクラウドに戻る', T, async () => {
  const o = await run(['text', '--relay=cut-first', '--segs=2']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 1, local: 1, provider: 'openai' });
  assert.ok(allText(o.pages[0].segments));
  assert.ok(o.engineLog.some((l) => /区間 s1 → local（理由: net）/.test(l)), o.engineLog.join('\n'));
  assert.strictEqual(count(o, L4), 1);
});

test('F7・RF36: --relay-cert → 手元・L5 を1回で、ホストの名前（workers.dev）が入る', T, async () => {
  const o = await run(['text', '--relay=text', '--relay-cert', '--segs=2']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.ok(allText(o.pages[0].segments));
  assert.strictEqual(o.stt.length, 0);
  assert.strictEqual(count(o, L5), 1, JSON.stringify(o.notices));
  assert.ok(o.engineLog.some((l) => /区間 s1 → local（理由: cert）/.test(l)), o.engineLog.join('\n'));
});

test('F5: --relay=foreign401（中継の形でない 401。会社の通信の検査の画面など）→ その区間は手元でやり直し、cookie は secrets.json に残る（次の区間はまた中継を試す）', T, async () => {
  const o = await run(['text', '--relay=foreign401', '--segs=2']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.ok(allText(o.pages[0].segments));
  assert.strictEqual(posts(o.relayCalls), 2, '中継の形でない 401 の後に、次の区間で中継を試していない');
  assert.ok(cookieOf(o.secretsRaw), '中継の形でない 401 で cookie を消した（取り違えて全員のログインを消す）');
  assert.strictEqual(count(o, L3), 0, '中継の形でない 401 を「ログインが切れた」と知らせた');
  assert.strictEqual(count(o, L8), 1);
  assert.ok(!o.engineLog.some((l) => l.includes('ログインを消した')));
});

for (const mode of ['415', 'badjson']) {
  test(`RF35: --relay=${mode} → その区間は手元でやり直し、全部の区間に文字がある（失敗の区間を残さない）`, T, async () => {
    const o = await run(['text', `--relay=${mode}`, '--segs=2']);
    assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' }, mode);
    assert.ok(allText(o.pages[0].segments), `${mode}: ${JSON.stringify(o.pages[0].segments)}`);
    assert.strictEqual(o.recoveryKept, false, mode);
    assert.strictEqual(count(o, L8), 1, mode);
  });
}

test('RL11: daily-cap（user）→ その区間から今日の残りは手元（hold）・L6 を1回・その間は /health も聞かない。日が替わる（main の時計を進める）とクラウドに戻る', T, async () => {
  const o = await run(['text', '--json-scene=relay-day', '--relay=daily-cap']);
  assert.deepStrictEqual(o.m1.route.stt, { cloud: 1, local: 2, provider: 'openai' });
  assert.ok(allText(o.m1.segments), JSON.stringify(o.m1.segments));
  // 2つ目の区間で上限（429 daily-cap）。3つ目は hold の間なので、中継へは何も送らない（/health も）
  assert.strictEqual(posts(o.m1.calls), 2);
  assert.strictEqual(o.m1.calls[o.m1.calls.length - 1], STT, `hold の間に中継へ送った: ${o.m1.calls}`);
  // L6 は会議ごとに1回（上限に達した会議で1回と、hold の間に始めた2回目の会議で1回。区間ごとには出さない）
  assert.strictEqual(count(o, L6), 2, JSON.stringify(o.notices));
  assert.strictEqual(count(o, L7), 0, '1人の上限を「中継が使えない」と知らせた');
  assert.ok(o.engineLog.some((l) => /区間 s2 → local（理由: daily-cap）/.test(l)) && o.engineLog.some((l) => /区間 s3 → local（理由: daily-cap）/.test(l)), o.engineLog.join('\n'));
  // 11 分後の会議も、日が替わるまでは中継へ送らない（/health も聞かない）
  assert.deepStrictEqual(o.m2.calls, [], `日が替わる前に中継へ送った: ${o.m2.calls}`);
  assert.deepStrictEqual(o.m2.route.stt, { cloud: 0, local: 1, provider: 'openai' });
  assert.ok(allText(o.m2.segments));
  // 日が替わった後の会議はクラウドに戻る
  assert.deepStrictEqual(o.m3.route.stt, { cloud: 1, local: 0, provider: 'openai' });
  assert.strictEqual(posts(o.m3.calls), 1);
});

for (const mode of ['quota', 'upstream-auth', 'daily-cap-all']) {
  test(`RL11: ${mode} → 手元・L7 を1回・その後の区間は中継に送らない（/health も聞かない）`, T, async () => {
    const o = await run(['text', `--relay=${mode}`, '--segs=3']);
    const cloud = mode === 'daily-cap-all' ? 1 : 0;   // 全体の上限 4 秒は、1つ目（3 秒）の区間の後に越える
    assert.deepStrictEqual(o.pages[0].route.stt, { cloud, local: 3 - cloud, provider: 'openai' }, mode);
    assert.ok(allText(o.pages[0].segments), mode);
    assert.strictEqual(posts(o.relayCalls), cloud + 1, `${mode}: ${o.relayCalls}`);
    assert.strictEqual(o.relayCalls[o.relayCalls.length - 1], STT, `${mode}: hold の間に中継へ送った: ${o.relayCalls}`);
    assert.strictEqual(count(o, L7), 1, `${mode}: ${JSON.stringify(o.notices)}`);
    assert.strictEqual(count(o, L6), 0, mode);
    assert.strictEqual(o.recoveryKept, false, mode);
  });
}

test('RL11: quota の hold は 10 分。9 分後の会議も中継へ送らず、11 分後の会議はまた中継を試す', T, async () => {
  const o = await run(['text', '--json-scene=relay-hold', '--relay=quota']);
  assert.strictEqual(posts(o.m1.calls), 1);
  assert.deepStrictEqual(o.m2.calls, [], `9 分後に中継へ送った: ${o.m2.calls}`);
  assert.strictEqual(posts(o.m3.calls), 1, `11 分後に中継を試していない: ${o.m3.calls}`);
  for (const m of [o.m1, o.m2, o.m3]) assert.ok(allText(m.segments), JSON.stringify(m.segments));
});

test('RF29（今の守り）: 429 の busy は待って同じ区間を送り直し、L9 を1回。手元へは落とさない', T, async () => {
  const o = await run(['text', '--relay=429', '--segs=2']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 2, local: 0, provider: 'openai' });
  assert.strictEqual(whisperSpawned(o), false);
  assert.strictEqual(count(o, L9(1)), 1, JSON.stringify(o.notices));
});

test('RF29（今の守り）: 長い 429 は区間を失敗として WAV を残し、L10 を1回。手元へは落とさない', T, async () => {
  const o = await run(['text', '--relay=429-long', '--segs=2']);
  assert.ok(o.pages[0].segments.every((s) => s.failed), JSON.stringify(o.pages[0].segments));
  assert.strictEqual(o.recoveryKept, true, '長い 429 なのに音声か待ち行列を消した');
  assert.strictEqual(whisperSpawned(o), false);
  assert.strictEqual(count(o, L10), 1, JSON.stringify(o.notices));
});

test('RF28（今の守り）: ［この会議は PC の中だけ］の会議では、しまったログインを復号もせず、中継に1回も送らない', T, async () => {
  const l = await run(['text', '--relay=text', '--local-only', '--segs=2']);
  assert.strictEqual(posts(l.relayCalls), 0);
  assert.deepStrictEqual(l.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.strictEqual(l.pages[0].route.localOnly, true);
  assert.ok(!l.notices.concat(l.balloons).some((n) => textOf(n) === L1), '［PC の中だけ］を押した後に、OpenAI へ送ると知らせた');
  assert.ok(!l.notices.some((n) => textOf(n) === L2), '［PC の中だけ］なのに、ログインしていないと知らせた');
  // 復号は起動と会議の始めの経路の確かめの分だけで、区間の数では増えない
  const l1 = await run(['text', '--relay=text', '--local-only', '--segs=1']);
  assert.strictEqual(l.decrypts, l1.decrypts, `［PC の中だけ］の区間で復号した（区間 2 つで ${l.decrypts} 回・1つで ${l1.decrypts} 回）`);
});

test('RL11: 音声入力（口述）も同じ経路（ログインしていれば中継）', T, async () => {
  const o = await run(['text', '--relay=text', '--dictate']);
  assert.strictEqual(posts(o.relayCalls), 1);
  assert.strictEqual(o.history[0].text.startsWith('本日の議題は進捗の確認です'), true);
  assert.strictEqual(whisperSpawned(o), false);
});

test('RL11: 復旧の文字起こしも同じ経路（ログインしていれば中継。手元のエンジンを起こさない）', T, async () => {
  const o = await run(['text', '--relay=text', '--recover']);
  assert.strictEqual(posts(o.relayCalls), 1);
  assert.strictEqual(whisperSpawned(o), false);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 1, local: 0, provider: 'openai' });
});

// ---------------------------------------------------------------- 第1d回 A-11（RL10・F19・F21・F26・L11）: しまった Access のログイン
test('F21: 起動のとき、しまった cookie を partition に戻し、最初の会議の区間は中継へ cookie つきで送られる。nt1_ の前の試しの札は消して記録1行（ログインしていない形で L2）', T, async () => {
  const [o, old] = await Promise.all([run(['text', '--relay=text', '--segs=1']), run(['text', '--relay=text', '--old-token', '--segs=1'])]);
  assert.ok(o.engineLog.includes('アカウント: しまったログインを戻した（cookie 1 個）'), o.engineLog.join('\n'));
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 1, local: 0, provider: 'openai' });
  const stt = o.relayWire.filter((x) => x.path === STT);
  assert.deepStrictEqual(stt.map((x) => [x.cookie, x.authorization]), [[true, false]], '区間を cookie つきで送っていない・札の見出しを付けた');
  assert.strictEqual(o.cookiesOnDisk, false, 'userData の下に Partitions のフォルダがある');
  // 0.8.0 の前の試しの札は消す（中継へ送らない）
  assert.ok(old.engineLog.includes('アカウント: しまったログインの形が違うため消した（old）'), old.engineLog.join('\n'));
  assert.ok(!JSON.parse(old.secretsRaw).keys.relay, '前の試しの札を残した');
  assert.deepStrictEqual(old.relayCalls, []);
  assert.strictEqual(count(old, L2), 1);
  assert.strictEqual(count(old, L3), 0);
});

test('F19: しまった cookie が期限切れで起動 → 最初の会議で L3（action: account）と帯 B3（login）。L2 にしない。中継へは送らず、ログインの窓は開かない', T, async () => {
  const o = await run(['text', '--relay=text', '--relay-expired', '--segs=2']);
  assert.deepStrictEqual(o.relayCalls, [], '期限の切れた cookie で中継へ送った');
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.ok(allText(o.pages[0].segments));
  assert.deepStrictEqual(o.notices.filter((n) => textOf(n) === L3), [{ text: L3, action: 'account' }], JSON.stringify(o.notices));
  assert.strictEqual(count(o, L2), 0, '期限切れを「ログインしていない」（L2）にした');
  assert.ok(o.sttSeen.some((x) => x.problem && x.problem.code === 'login'), `帯 B3（login）が出ない: ${JSON.stringify(o.sttSeen)}`);
  assert.ok(!JSON.parse(o.secretsRaw).keys.relay, '期限の切れた cookie を残した');
  assert.ok(o.engineLog.includes('アカウント: しまったログインの期限が切れていた'), o.engineLog.join('\n'));
  assert.deepStrictEqual(o.loginWins, [], 'ログイン切れでログインの窓を開いた（F27）');
});

test('L11: 中継が 403 denied（止めたメール）→ その区間から手元・L11 を1回・帯 B5（relay-off）・cookie を消す。次の区間は中継へ送らない。ログインの窓は開かない', T, async () => {
  const o = await run(['text', '--relay-seq=cdc', `--text=${'手元で起こした文です。'}`]);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 1, local: 2, provider: 'openai' });
  assert.ok(o.pages[0].segments.every((x) => !x.failed && x.text), JSON.stringify(o.pages[0].segments));
  assert.strictEqual(count(o, L11), 1, JSON.stringify(o.notices));
  assert.strictEqual(count(o, L8), 0, '止めたメールを「混み合っている」（L8）にした');
  assert.strictEqual(count(o, L3), 0);
  assert.ok(o.sttSeen.some((x) => x.problem && x.problem.code === 'relay-off'), `帯 B5（relay-off）が出ない: ${JSON.stringify(o.sttSeen)}`);
  assert.ok(!JSON.parse(o.secretsRaw).keys.relay, '止めたメールの cookie を残した');
  assert.strictEqual(JSON.parse(o.settingsText || JSON.stringify(o.savedSettings)).accountEmail, '');
  assert.strictEqual(posts(o.relayCalls), 2, `止めた後に中継へ送った: ${o.relayCalls}`);
  assert.ok(o.engineLog.includes('アカウント: 中継が denied。ログインを消した'), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('アカウント: 中継の答え 403（cf-ray なし・行き先 なし）→ denied'), o.engineLog.join('\n'));
  assert.deepStrictEqual(o.loginWins, [], '止めたメールでログインの窓を開いた（F27）');
});

test('F26: 起動のときに safeStorage の復号が失敗（unreadable）→ secrets の relay を消さず、最初の会議は手元（why: key-unreadable・L2 も L3 も出さない）・記録1行。次の会議の前に復号できれば戻して中継へ送る', T, async () => {
  const o = await run(['text', '--json-scene=access-unreadable', '--relay=text', '--access-login=unreadable']);
  assert.strictEqual(o.status0.signedIn, false);
  assert.deepStrictEqual(o.m1.calls, [], '復号できないのに中継へ送った（空の partition の 401 をログイン切れと取り違える）');
  assert.deepStrictEqual(o.m1.route.stt, { cloud: 0, local: 1, provider: 'openai' });
  assert.ok(allText(o.m1.segments));
  assert.strictEqual(o.secretsAfterM1, o.secretsBefore, '復号できないだけの cookie を消した・書き換えた');
  assert.ok(o.engineLog.some((l) => /区間 s1 → local（理由: key-unreadable）/.test(l)), o.engineLog.join('\n'));
  assert.deepStrictEqual(o.engineLog.filter((l) => l.includes('しまったログインを復号できません')), ['アカウント: しまったログインを復号できません（key-unreadable）。消さずに PC の中で文字起こしします']);
  assert.strictEqual(count(o, L2) + count(o, L3), 0, `復号できないだけなのに知らせた: ${JSON.stringify(o.notices)}`);
  assert.deepStrictEqual(o.m2.route.stt, { cloud: 1, local: 0, provider: 'openai' }, '復号できるようになっても中継へ戻らない');
  assert.ok(o.engineLog.includes('アカウント: しまったログインを戻した（cookie 1 個）'), o.engineLog.join('\n'));
  assert.strictEqual(o.status1.signedIn, true);
});
