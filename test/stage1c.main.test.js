/*
 * stage1c.main.test.js — 第1c回の main のつなぎ（オンラインの文字起こし・Claude Code の要約）を、偽の Electron の上で
 * main.js を本当に動かして確かめる（helpers/mainrun.js）。偽の送り先（helpers/fake-stt.js）と偽の claude（helpers/fake-claude.js）だけを使い、外へつながない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const KEY = 'gsk_test_0123456789';
const run = (args) => new Promise((resolve, reject) => {
  execFile(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
// net.request に渡した宛先のホスト（書き換える前）。要約の経路の確かめ（Anthropic）は除く
const sttHosts = (o) => [...new Set(o.netHosts.filter((h) => h !== 'api.anthropic.com'))];
const sttPosts = (o) => o.stt.filter((r) => r.path.endsWith('/audio/transcriptions'));
const whisperSpawned = (o) => o.spawns.some((s) => /fake-whisper\.js$/.test(s.cmd) || /whisper-server/.test(s.cmd));
const noKeyAnywhere = (o) => {
  const blob = JSON.stringify([o.savedSettings, o.secretsRaw, o.engineLog, o.notices, o.balloons, o.pages]);
  assert.ok(!blob.includes(KEY), '鍵の文字が設定・記録・知らせ・ページのどこかにある');
};

test('OL2: オンラインで鍵があれば、区間はクラウド（OpenAI）で文字起こしされ、手元の whisper は起動しない。ページに経路が残る', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--segs=2']);
  assert.strictEqual(sttPosts(o).length, 2);
  assert.ok(sttPosts(o).every((r) => r.authOk && r.wavOk && r.fields.language === 'ja' && r.fields.model === 'gpt-4o-transcribe'));
  assert.match(sttPosts(o)[1].fields.prompt, /確認です。区間1$/, '2つ目の区間の認識ヒントの終わりに、直前の区間の尻尾が無い（#15）');
  assert.strictEqual(whisperSpawned(o), false, 'オンラインなのに手元の whisper を起動した');
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 2, local: 0, provider: 'openai' });
  assert.deepStrictEqual(o.pages[0].routeText.slice(0, 1), ['☁ 文字起こし: クラウド（OpenAI）2'], 'page:get の返事に経路の行が無い（C-3）');
  assert.strictEqual(o.statusCloud, true, 'OpenAI の鍵があるのに会議の状態の cloud が true でない（［PC の中だけ］のボタンが出ない）');
  assert.deepStrictEqual(sttHosts(o), ['api.openai.com'], 'OpenAI のほかの宛先へ文字起こしの要求を出した');
  assert.ok(o.pages[0].segments.every((s) => s.text.startsWith('本日の議題は進捗の確認です') && !s.failed));
  assert.ok(o.balloons.some((b) => /この会議の音声は OpenAI に送って文字起こしします/.test(b)), '会議の始めの知らせ（M1）が無い');
  assert.ok(!o.engineLog.some((l) => l.includes('本日の議題')), '記録に文字起こしの本文がある');
  noKeyAnywhere(o);
});

test('D1: オフライン（isOnline が false）なら手元の whisper で文字起こしし、送り先には1回も要求が無い', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--offline', '--segs=2']);
  assert.strictEqual(o.stt.length, 0);
  assert.strictEqual(whisperSpawned(o), true);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
});

// 0.7.0 U-1（設計書 D5・D7）で意図して変えた: 同意の選択を外した。前の版が保存した同意（ask・off）と送り先（groq・そのほかの URL・モデル）は読まず、
// OpenAI の鍵があれば OpenAI（gpt-4o-transcribe）で文字起こしする（計画 docs/plans/2026-10-19-ui07.md の「決めたこと」の 1）
for (const consent of ['ask', 'off']) {
  test(`U-1: 保存の値が ${consent}・そのほかの URL でも、OpenAI の鍵があれば OpenAI（gpt-4o-transcribe）で文字起こしし、そのほかの URL へは送らない`, { timeout: 20000 }, async () => {
    const o = await run(['text', '--stt=text', `--consent=${consent}`, '--legacy-provider', '--segs=1']);
    assert.strictEqual(sttPosts(o).length, 1, consent);
    assert.ok(sttPosts(o).every((r) => r.authOk && r.fields.model === 'gpt-4o-transcribe'), `${consent}: 前の版のモデルの名前で送った`);
    assert.deepStrictEqual(sttHosts(o), ['api.openai.com'], `${consent}: 前の版の「そのほか」の URL へ直に送った`);
    assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 1, local: 0, provider: 'openai' }, consent);
    assert.strictEqual(o.statusCloud, true, consent);
    assert.ok(!o.notices.some((n) => /オンラインの文字起こしを使うか/.test(n)), `${consent}: 外した同意の案内が出た`);
    assert.deepStrictEqual([o.savedSettings.cloudTranscribe, o.savedSettings.sttProvider], [consent, 'custom'], `${consent}: 前の版の値を settings.json から消した・書き換えた（JS6）`);
    noKeyAnywhere(o);
  });
}

for (const id of ['groq', 'custom']) {
  test(`U-1: ${id} の名前の鍵しか無い PC は、その鍵を OpenAI へ送らず手元で取り、鍵の案内を1回出す（鍵は消さない）`, { timeout: 20000 }, async () => {
    const o = await run(['text', '--stt=text', `--key-for=${id}`, '--legacy-provider', '--segs=2']);
    assert.strictEqual(o.stt.length, 0, `${id}: ほかの送り先の鍵で送った`);
    assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' }, id);
    assert.strictEqual(o.statusCloud, false, `${id}: OpenAI の鍵が無いのに［PC の中だけ］のボタンが出る`);
    assert.strictEqual(o.notices.filter((n) => n === 'OpenAI の鍵が入っていないため、PC の中で文字起こししています。鍵は設定の「オンライン」の［詳細設定（管理者用）］で入れます。').length, 1, id);
    assert.ok(o.secretsRaw.includes(`"${id}"`), `${id}: ほかの送り先の鍵を消した`);
  });
}

test('RF28: ［この会議は PC の中だけ］なら、送り先に音声を送らず、鍵も復号しない', { timeout: 20000 }, async () => {
  const l = await run(['text', '--stt=text', '--local-only', '--segs=2']);
  assert.strictEqual(l.stt.filter((r) => r.path.endsWith('/audio/transcriptions')).length, 0);
  assert.deepStrictEqual(l.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.strictEqual(l.draftLocalOnly, true, '［PC の中だけ］を下書きに書いていない（落ちて復旧すると送り直しがクラウドへ行く）');
  assert.strictEqual(l.pages[0].route.localOnly, true);
  assert.ok(l.engineLog.some((x) => /区間 s1 → local（理由: local-only）/.test(x)), '［PC の中だけ］の区間の理由が local-only でない');
  assert.ok(!l.notices.some((n) => /鍵が入っていないため/.test(n)), '［PC の中だけ］なのに、鍵が無いと知らせた');
  assert.ok(!l.notices.concat(l.balloons).some((n) => /この会議の音声は .* に送って文字起こしします/.test(n)), '［PC の中だけ］を押した後に、クラウドへ送ると知らせた（M1）');
  // C-3: 画面と同じ IPC（meeting:set-local-only）で押し、会議の状態に印と「クラウドで処理する設定か」が載る
  assert.deepStrictEqual(l.localOnly, { ok: true, localOnly: true });
  assert.deepStrictEqual(l.statusLocalOnly, { localOnly: true, cloud: true });
  assert.deepStrictEqual(l.pages[0].routeText.slice(0, 1), ['🖥 文字起こし: PC']);
  // 0.7.0 U-1: 同意の前は復号しない（mn-ask-no-decrypt）の代わりに、［PC の中だけ］の区間では鍵を復号しない
  // （復号は起動と会議の始めの経路の確かめの分だけで、区間の数では増えない）
  const l1 = await run(['text', '--stt=text', '--local-only', '--segs=1']);
  assert.strictEqual(l.decrypts, l1.decrypts, `［PC の中だけ］の区間で鍵を復号した（区間 2 つで ${l.decrypts} 回・1つで ${l1.decrypts} 回）`);
});

test('RF27: 送っている途中で切れた区間だけ手元でやり直し、次の区間はクラウドに戻る', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=drop-first', '--segs=2']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 1, local: 1, provider: 'openai' });
  assert.ok(o.pages[0].segments.every((s) => !s.failed));
  assert.ok(o.engineLog.some((l) => /区間 s1 → local（理由: net）/.test(l)));
});

test('RF29: 429 は待ってからクラウドで取れる（手元へ落とさない）。待っていることを1回知らせる', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=429', '--segs=2']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 2, local: 0, provider: 'openai' });
  assert.strictEqual(whisperSpawned(o), false);
  assert.strictEqual(o.notices.filter((n) => /利用の上限に近いため/.test(n)).length, 1);
});

test('OL2: 401 は区間を失敗として残し（音声は送り直しの待ち行列へ）、鍵の入れ直しを1回知らせる。手元へは落とさない', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=401', '--segs=2']);
  assert.ok(o.pages[0].segments.every((s) => s.failed && /鍵が正しくありません/.test(s.text)));
  assert.strictEqual(whisperSpawned(o), false);
  assert.strictEqual(o.notices.filter((n) => /鍵が正しくないか、使えなくなっています/.test(n)).length, 1, '会議と送り直しで二重に知らせた');
  assert.strictEqual(o.recoveryKept, true, '送り直しで 401 だったのに、音声か待ち行列を消した');
  noKeyAnywhere(o);
});

test('RF30: 鍵のファイルはあるが復号できない（safeStorage が一時的に使えない）ときは、空の鍵で送らずに手元で取り、鍵の案内を出す', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--key-unreadable', '--segs=1']);
  assert.strictEqual(o.stt.length, 0, '空の鍵で送った');
  assert.ok(o.notices.some((n) => /鍵が入っていないため/.test(n)));
  assert.ok(!o.notices.some((n) => /鍵が正しくないか/.test(n)), '鍵の誤り（M8）と誤って知らせた');
  assert.ok(o.engineLog.some((l) => l.includes('key-unreadable')));
});

test('F10: 鍵が無い最初の日は手元で取れ、鍵の案内が1回出る。［PC の中だけ］のボタンは出ない', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--no-key', '--segs=2']);
  assert.strictEqual(o.stt.length, 0);
  assert.strictEqual(o.statusCloud, false, 'OpenAI の鍵が無いのに会議の状態の cloud が true（［PC の中だけ］のボタンが出る）');
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.strictEqual(o.notices.filter((n) => /鍵が入っていないため、PC の中で文字起こししています/.test(n)).length, 1);
});

test('D1: 音声入力もオンラインならクラウドで文字起こしし、履歴に入る', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--dictate']);
  assert.strictEqual(sttPosts(o).length, 1);
  assert.strictEqual(o.history[0].text.startsWith('本日の議題は進捗の確認です'), true);
  assert.strictEqual(whisperSpawned(o), false);
});

test('OL2: 復旧の文字起こしもクラウドで処理でき、そのときは手元のエンジンを起こさない', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--recover']);
  assert.strictEqual(sttPosts(o).length, 1);
  assert.strictEqual(whisperSpawned(o), false);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 1, local: 0, provider: 'openai' });
});

test('RF26: 送り先に届かない（証明書）ときは手元で続け、理由を会議ごとに1回だけ知らせる', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=cert', '--segs=2']);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 2, provider: 'openai' });
  assert.strictEqual(o.notices.filter((n) => /証明書が差し替えられている可能性があります/.test(n)).length, 1);
});

test('調べた結果の 10: 復旧をクラウドで先へ通した後、手元に落ちた区間で whisper が無ければ、音声と待ち行列を消さずに残す', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=drop', '--recover', '--no-whisper']);
  assert.strictEqual(o.recoveryKept, true, '手元のエンジンが無いのに、送り直しの音声か待ち行列を消した');
});

// 0.7.0 U-1 で意図して変えた: 手元の場面は「同意が既定の ask」でなく「OpenAI の鍵が無い PC」
test('F14: 手元の場面（OpenAI の鍵が無い）は今どおり起動のときに whisper を先読みし、ページに印が残る', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--no-key', '--segs=1']);
  assert.strictEqual(whisperSpawned(o), true);
  assert.strictEqual(o.pages[0].route.localOnly, false);
});

test('RF28: ［PC の中だけ］の会議が落ちて復旧しても、送り直しは手元で、送り先に要求が無く、ページに印が残る', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--recover', '--local-only']);
  assert.strictEqual(o.stt.length, 0);
  assert.strictEqual(whisperSpawned(o), true);
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 0, local: 1, provider: 'openai' });
  assert.strictEqual(o.pages[0].route.localOnly, true);
});

// ---------------------------------------------------------------- 第1c回 B-3: 要約の経路（偽の claude）
const llamaSpawned = (o) => o.spawns.some((s) => /fake-llama\.js$/.test(s.cmd));
const pCalls = (o) => o.claude.filter((l) => l.kind === 'p');

test('D2: オンラインの自動の要約は Claude Code で作られ、出典が付き、手元の llama は起動しない。課金の変数は子に渡らない', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--sum', '--claude=ok', '--segs=2']);
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

test('D1・F2: オンラインで上限なら、要約の欄にリセットの時刻を出し、手元の llama では作らない', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--sum', '--claude=limit', '--segs=1']);
  assert.match(o.pages[0].summaryError, /Claude の利用の上限に達しました（3:45pm に戻ります）/);
  assert.strictEqual(llamaSpawned(o), false);
  assert.strictEqual(o.pages[0].todos.length, 0);
  assert.ok(o.engineLog.some((l) => /要約: Claude Code → limit/.test(l)));
  assert.strictEqual((o.pages[0].route || {}).summary, undefined, '失敗したのに、ページに要約の経路を書いた（成功したときだけ書く）');
});

// 第1b回の続き Lane F（利用者の PC の 0.5.0）: auth status は claude.ai のまま、-p だけが 401（OAuth の鍵が切れた）で落ちた。
// 要約の欄は［Claude Code にログイン］へ案内し、engine.log は符号・副型・状態の番号だけ（返事の英語の文も本文も写さない）
test('Lane F-a: -p が 401（OAuth の鍵が切れた）なら、要約の欄にログインの案内、記録は符号と副型と状態の番号だけ。手元の llama では作らない', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--sum', '--claude=expired401', '--segs=1']);
  assert.strictEqual(pCalls(o).length, 1);
  assert.strictEqual(o.pages[0].summaryError, 'Claude Code のログインが切れています。設定の［Claude Code にログイン］を押してください。');
  assert.ok(o.engineLog.includes('要約: Claude Code → auth-expired（subtype=success・api_error_status=401）'), o.engineLog.filter((l) => l.includes('Claude')).join('\n'));
  assert.ok(!o.engineLog.some((l) => /OAuth|authenticate|Re-authenticate/i.test(l)), '返事の英語の文が記録に写った');
  assert.ok(!o.engineLog.some((l) => l.includes('本日の議題')), '記録に文字起こしがある');
  assert.strictEqual(llamaSpawned(o), false);
  assert.strictEqual((o.pages[0].route || {}).summary, undefined);
});

test('RF25: Claude Code が API キーで動く設定なら -p を呼ばずに理由を出す', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--sum', '--claude=ok', '--claude-auth=api_key_helper', '--segs=1']);
  assert.strictEqual(pCalls(o).length, 0);
  assert.match(o.pages[0].summaryError, /API キー（従量課金）で動く設定/);
  assert.strictEqual((o.pages[0].route || {}).summary, undefined, '失敗したのに、ページに要約の経路を書いた（成功したときだけ書く）');
  assert.strictEqual(llamaSpawned(o), false);
});

test('RF24: Claude Code が無ければ入れ方を出す（手元の llama では作らない）', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--sum', '--claude=missing', '--segs=1']);
  assert.match(o.pages[0].summaryError, /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
  assert.strictEqual((o.pages[0].route || {}).summary, undefined, '失敗したのに、ページに要約の経路を書いた（成功したときだけ書く）');
  assert.strictEqual(llamaSpawned(o), false);
});

test('D1: オフラインなら今までどおり手元の llama で要約し、Claude Code は呼ばない。ページに「local」', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--offline', '--sum', '--claude=ok', '--segs=2']);
  assert.strictEqual(o.claude.length, 0);
  assert.strictEqual(llamaSpawned(o), true);
  assert.strictEqual(o.pages[0].route.summary.by, 'local');
});

test('C10・F13: ［この会議は PC の中だけ］の会議は、オンラインでも Claude Code を呼ばず（auth status も無し）、手元の llama で要約する', { timeout: 20000 }, async () => {
  const o = await run(['text', '--stt=text', '--local-only', '--sum', '--claude=ok', '--segs=2']);
  assert.strictEqual(o.claude.length, 0, '［PC の中だけ］の文字起こしを Claude へ渡した');
  // 送り先への要求は、会議の始めの文字起こしの経路の確かめ（［PC の中だけ］を押す前。A-4）の GET だけ。
  // 要約のための Anthropic へ届くかの確かめ（/anthropic）も、音声の送信も無い
  assert.deepStrictEqual(o.stt.filter((r) => r.path === '/anthropic' || r.path.endsWith('/audio/transcriptions')), []);
  assert.strictEqual(llamaSpawned(o), true);
  assert.strictEqual(o.pages[0].route.summary.by, 'local');
});

test('今の場面を守る: --claude を付けない要約の場面は、届くかの確かめが試験の守りで止まり、今どおり手元の llama で作る（偽の claude も本物も起こさない）', { timeout: 20000 }, async () => {
  const o = await run(['text', '--sum', '--segs=2']);
  assert.deepStrictEqual(o.claude, []);
  assert.strictEqual(llamaSpawned(o), true);
  assert.strictEqual(o.pages[0].route.summary.by, 'local');
  assert.strictEqual(o.pages[0].summaryError, '');
  assert.deepStrictEqual(o.pages[0].routeText, ['🖥 文字起こし: PC', '🖥 要約: PC（オフライン）']);
});
