/*
 * stage1d2.main.test.js — 第1d2回（NaTsu 0.9.0 のレーン A。設計書 D21: オフラインの準備を任意にする）の場面。main.js を偽の Electron の上で
 * 本当に動かす（helpers/mainrun.js）。中継は本物の relay/ のコードを 127.0.0.1 で包んだもの（helpers/relay-local.js）。外へはつながない。
 * 「エンジンの無い PC」は --no-engine=fetchable（詳細設定の文字起こしが空で、何も取り込んでいない取り込める PC）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
// NATSU_TEST_ONLINE_MEMO_SCALE: 届くかの覚え（届いた 60 秒・届かない 15 秒）を縮め、区間ごとに中継の答えを替えても次の区間で気づくようにする（stage1d.seg と同じ）
const ENV = { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001' };
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: ENV, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const T = { timeout: sceneTimeout(20000) };

const L1 = 'この会議の音声は OpenAI に送られます（文字起こしのため）。1on1・面談など外に出したくない会議は、議事録の画面の［オフラインモード］を押してください。';
const D1 = 'インターネットにつながっていないため、音声入力を始めませんでした。オンラインに戻ってから、もう一度お試しください。つながっていなくても使うには、設定の「ローカル AI」で準備します。';
const UNSET_FETCH = '文字起こしエンジンが未設定です。設定タブの［PC の中の文字起こしを取り込む］から取り込んでください。';

// 帯（B11〜B14）と会議の中の知らせ（K1〜K4）。計画「画面と知らせの文」
const B11 = 'PC の中の文字起こしが入っていないので、音声を残しています。オンラインに戻ると文字起こしします。録音はそのまま続けてください。';
const B13 = 'ログインしていないため、音声を残しています。［ログイン］を押してログインすると、文字起こしします。';
const K1 = '今はクラウドで文字起こしできないため、音声だけを残します。つながると、この会議の音声を OpenAI に送って文字起こしします。1on1・面談など外に出したくない会議は、議事録の画面の［オフラインモード］を押してください。';
const K2 = 'ログインしていないため、音声だけを残します。設定の「アカウント」でログインすると、この会議の音声を OpenAI に送って文字起こしします。1on1・面談など外に出したくない会議は、議事録の画面の［オフラインモード］を押してください。';
const K3 = '文字起こしの中継が使えないため、音声を残しています。使えるようになると自動で文字起こしします。録音はそのまま続けてください。';
const KEPT_SEG_TEXT = '（文字起こし待ち: 音声は残してあります）';
const KS = [K1, K2, K3, 'ログインが切れたため、音声を残しています。設定の「アカウント」でもう一度ログインすると、文字起こしします。'];
const count = (o, text) => o.notices.filter((n) => textOf(n) === text).length;
// PC で文字起こししたと言う 0.8.0 の知らせ（L2〜L8・L11）は、準備を選んでいない PC では本当でない
const saysLocal = (o) => o.notices.map(textOf).filter((t) => /PC の中で文字起こし(し|を続)/.test(t));
const segFiles = (o) => o.files.filter((f) => /^data\/segbuf\/[^/]+\/\d+\.wav$/.test(f));
const os = require('node:os');
const fs = require('node:fs');
const tmpDirs = [];
const tmpUserData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-ud-残す𠮷-')); tmpDirs.push(d); return d; };
test.after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 消せなくても結果は変わらない */ } } });
// main ごと落ちる場面（終わりの番号が 0 でない）を1回動かす
const runExit = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: ENV, maxBuffer: 1 << 24, timeout: 20000 },
    (err, _stdout, stderr) => { if (err && typeof err.code === 'number' && err.code !== 0) resolve(err.code); else reject(new Error(`main ごと落ちなかった: ${stderr}`)); });
});

const textOf = (n) => (typeof n === 'string' ? n : (n && typeof n.text === 'string' ? n.text : ''));
const STT = '/v1/audio/transcriptions';
const posts = (calls) => (calls || []).filter((p) => p === STT).length;
const whisperSpawned = (o) => (o.spawns || []).some((s) => /fake-whisper\.js$/.test(s.cmd) || /whisper-server/.test(s.cmd));
const allText = (segs) => segs.length > 0 && segs.every((s) => !s.failed && s.text.startsWith('本日の議題は進捗の確認です'));
const problems = (o) => (o.sttSeen || []).map((s) => (s.problem ? s.problem.code : '')).filter(Boolean);
const dump = (o) => JSON.stringify({ notices: o.notices, engineLog: o.engineLog, sttSeen: o.sttSeen, start: o.start });

// ---------------------------------------------------------------- M-1（OF1・F4・F5・F10）
test('D21: エンジンの無い PC でもログインしてオンラインなら会議が始まり、2 区間とも中継で文字になる。手元のエンジンを起こさない・知らせは L1 だけ・帯は出ない・engine.log に「起動: オフラインの準備 選んでいない」', T, async () => {
  // 要約は Claude Code（偽の claude）。手元の要約の文（M-3 の S1・S2）を「知らせは L1 だけ」に混ぜない
  const o = await run(['text', '--relay=text', '--no-engine=fetchable', '--segs=2', '--claude=text']);
  assert.strictEqual(o.start.ok, true, dump(o));
  assert.strictEqual(posts(o.relayCalls), 2, JSON.stringify(o.relayCalls));
  assert.ok(allText(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 2, local: 0, provider: 'openai' });
  assert.deepStrictEqual(o.spawns, [], '手元のエンジンを起こした');
  assert.deepStrictEqual(o.notices.map(textOf), [L1], dump(o));
  assert.deepStrictEqual(problems(o), [], dump(o));
  assert.deepStrictEqual(o.notifications, []);
  assert.strictEqual(o.engineLog.filter((l) => l === '起動: オフラインの準備 選んでいない').length, 1, o.engineLog.join('\n'));
  assert.ok(o.claude.some((c) => c.kind === 'p'), '要約が Claude Code へ行っていない');
});

test('決めたこと 3: オフラインで始めた会議は始まる（start.ok）。meeting:status の cloud が真（［この会議は PC の中だけ］が出る）。中継への要求は 0', T, async () => {
  const o = await run(['text', '--relay=text', '--offline', '--no-engine=fetchable', '--segs=1']);
  assert.strictEqual(o.start.ok, true, dump(o));
  assert.strictEqual(o.statusCloud, true);
  assert.deepStrictEqual(o.relayCalls, [], '中継へ要求を出した');
  assert.deepStrictEqual(o.spawns, []);
});

test('F10・F5: 取り込みのボタンを押した（installed.json の consent）が組の無い PC は「選んだ」人。オフラインでは今どおり「未設定」の文で始めない', T, async () => {
  const o = await run(['text', '--relay=text', '--offline', '--no-engine=fetchable', '--fetch-consent', '--segs=1']);
  assert.deepStrictEqual([o.start.ok, o.start.error], [false, UNSET_FETCH], dump(o));
  assert.strictEqual(o.engineLog.filter((l) => l === '起動: オフラインの準備 選んだ').length, 1, o.engineLog.join('\n'));
});

test('F10・F5: 取り込みのボタンを押したか分からない（installed.json を読めない: ウイルス対策が掴んでいる）PC は「選んだ」人に倒す。オフラインでは今どおり「未設定」の文で始めない', T, async () => {
  const o = await run(['text', '--relay=text', '--offline', '--no-engine=fetchable', '--installed-unreadable', '--segs=1']);
  assert.deepStrictEqual([o.start.ok, o.start.error], [false, UNSET_FETCH], dump(o));
  assert.strictEqual(o.engineLog.filter((l) => l === '起動: オフラインの準備 選んだ').length, 1, o.engineLog.join('\n'));
  assert.deepStrictEqual(o.relayCalls, []);
});

test('F5: エンジンのある PC で中継が止まると、その区間は PC で文字になる（0.8.0 と同じ）', T, async () => {
  const o = await run(['text', '--relay-seq=cnc']);
  assert.strictEqual(o.start.ok, true);
  assert.ok(allText(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
  assert.ok(o.pages[0].route.stt.local >= 1, JSON.stringify(o.pages[0].route));
  assert.strictEqual(whisperSpawned(o), true);
  assert.ok(o.engineLog.includes('起動: オフラインの準備 選んだ'), o.engineLog.join('\n'));
});

test('D21・決めたこと 5: オフラインでエンジンが無いと音声入力を始めず、本体の窓に D1。録音バーに overlay:start を送らない・履歴は変わらない', T, async () => {
  const o = await run(['text', '--dictate', '--relay=text', '--offline', '--no-engine=fetchable']);
  assert.deepStrictEqual(o.notices.map(textOf), [D1], dump(o));
  assert.strictEqual(o.overlayStarts, 0);
  assert.deepStrictEqual(o.history, []);
  assert.deepStrictEqual(o.relayCalls, []);
  assert.deepStrictEqual(o.spawns, []);
});

test('D21: エンジンの無い PC でもログインしてオンラインなら音声入力が中継で文字になり、貼り付けに回る', T, async () => {
  const o = await run(['text', '--dictate', '--relay=text', '--no-engine=fetchable']);
  assert.strictEqual(o.overlayStarts, 1);
  assert.strictEqual(o.history.length, 1, dump(o));
  assert.match(o.history[0].text, /^本日の議題は進捗の確認です/);
  assert.strictEqual(posts(o.relayCalls), 1);
  assert.deepStrictEqual(o.pastes, [o.history[0].text], '文字を貼り付け（クリップボード）に回していない');
  assert.deepStrictEqual(o.spawns, []);
});

// ---------------------------------------------------------------- M-2（OF2・F1・F4・F6）
test('F1: 中継が止まった2つの区間は「文字起こし待ち」の失敗の区間になり、その WAV が segbuf に残る。帯は B11（ボタン無し）で、B1・B4 は出ない。知らせは L1 と K3 の1回ずつ。Windows の知らせは出ない。手元のエンジンを起こさない・区間が片付くまで 2 秒以内', T, async () => {
  const o = await run(['text', '--relay-seq=cnn', '--no-engine=fetchable', '--main-hidden']);
  const at = o.sttAt['kept-wait'];
  assert.ok(at, dump(o));
  assert.deepStrictEqual(at.find((x) => x.id === 's2'), { id: 's2', text: KEPT_SEG_TEXT, failed: true, wav: true });
  const kw = o.sttSeen.filter((s) => s.problem && s.problem.code === 'kept-wait');
  assert.ok(kw.length && kw.every((s) => s.problem.text === B11 && s.problem.action === ''), JSON.stringify(kw));
  assert.ok(!problems(o).includes('engine-down') && !problems(o).includes('seg-failed'), dump(o));
  assert.ok(!o.engineLog.some((l) => /帯 (engine-down|seg-failed)$/.test(l)), o.engineLog.join('\n'));
  assert.strictEqual(count(o, L1), 1, dump(o));
  assert.strictEqual(count(o, K3), 1, dump(o));
  assert.deepStrictEqual(saysLocal(o), [], 'PC で文字起こししていると言った');
  assert.deepStrictEqual(o.notifications, []);
  assert.deepStrictEqual(o.spawns, []);
  assert.ok(o.segWaitMs.every((ms) => ms < 2000), JSON.stringify(o.segWaitMs));
  // 締めの後: 残した2区間の WAV と待ち行列が segbuf に残り、ページの区間は「文字起こし待ち」
  assert.strictEqual(segFiles(o).length, 2, JSON.stringify(o.files));
  assert.strictEqual(o.recoveryKept, true);
  assert.deepStrictEqual(o.pages[0].segments.map((x) => [x.text === KEPT_SEG_TEXT, x.failed]), [[false, false], [true, true], [true, true]]);
  assert.ok(o.engineLog.some((l) => /^文字起こしの経路: 区間 s2 → 音声を残した（/.test(l)), o.engineLog.join('\n'));
});

test('OF2: ログインしていない PC の会議は、帯 B13（action signin）・知らせ K2（action signin）。meeting:status の cloud が真。中継へは送らない', T, async () => {
  const o = await run(['text', '--relay=text', '--signed-out', '--no-engine=fetchable', '--segs=2']);
  assert.strictEqual(o.start.ok, true);
  const kl = o.sttSeen.filter((s) => s.problem && s.problem.code === 'kept-login');
  assert.ok(kl.length && kl.every((s) => s.problem.text === B13 && s.problem.action === 'signin'), dump(o));
  assert.deepStrictEqual(o.notices.filter((n) => textOf(n) === K2), [{ text: K2, action: 'signin' }], dump(o));
  assert.deepStrictEqual(saysLocal(o), []);
  assert.strictEqual(o.statusCloud, true);
  assert.deepStrictEqual(o.relayCalls, []);
});

test('決めたこと 3・K1: オフラインで始めた会議は、始めに K1 を1回（トレイの吹き出しも）。帯は B11', T, async () => {
  const o = await run(['text', '--relay=text', '--offline', '--no-engine=fetchable', '--segs=1']);
  assert.strictEqual(count(o, K1), 1, dump(o));
  assert.ok(o.balloons.includes(K1), JSON.stringify(o.balloons));
  // 始めに出す（区間の音声を残すより前。後で OpenAI に送ることを、送る前に: RF28）
  const at = (re) => o.engineLog.findIndex((l) => re.test(l));
  assert.ok(at(/^文字起こしの経路: 知らせ k1$/) >= 0 && at(/^文字起こしの経路: 知らせ k1$/) < at(/^文字起こしの経路: 区間 s1 → 音声を残した（offline）$/), o.engineLog.join('\n'));
  assert.ok(problems(o).includes('kept-wait'), dump(o));
  assert.strictEqual(count(o, K3), 0);
});

test('F1: 残した区間の後に落ちても、次の起動で復旧のページに「文字起こし待ち」として載り（文はそのまま）、ページの区間に kept の印が無く、待ち行列に入る', T, async () => {
  const dir = tmpUserData();
  // 3 区間の会議（3つ目は送らない）。2つ目（中継が止まって残した区間）が下書きに書かれたら、録音中のまま main ごと落ちる
  assert.strictEqual(await runExit(['text', '--relay-seq=cn', '--segs=3', '--no-engine=fetchable', '--kill-main-after-kept', `--keep-user-data=${dir}`]), 3);
  const o = await run(['text', '--relay=text', '--offline', '--no-engine=fetchable', '--recover', `--keep-user-data=${dir}`]);
  assert.strictEqual(o.pages.length, 1);
  assert.deepStrictEqual(o.pages[0].segments.map((x) => [x.text === KEPT_SEG_TEXT, x.failed]), [[false, false], [true, true]], JSON.stringify(o.pages));
  assert.ok(o.pages[0].keys.every((k) => !k.includes('kept')), JSON.stringify(o.pages[0].keys));
  assert.strictEqual(o.recoveryKept, true, '待ち行列（recovery.json と WAV）が無い');
});

test('F3・RF28: 始めは中継が使えそうに見えたが落ちていた会議は、残し始めたとき K1 を1回（OpenAI に送ることを知らせる）。K3 は出さない。帯は B11', T, async () => {
  const o = await run(['text', '--relay=text', '--relay-down', '--no-engine=fetchable', '--segs=2']);
  assert.strictEqual(count(o, K1), 1, dump(o));
  assert.strictEqual(count(o, K3), 0, dump(o));
  assert.strictEqual(count(o, L1), 0);
  assert.ok(problems(o).includes('kept-wait'), dump(o));
  assert.deepStrictEqual(saysLocal(o), []);
});

// 0.9.4 S-3（K1・決めたこと 3）で意図して直した: 音声を消すのは文字になった・無音だった・ページを消したときだけ。会議の後の送り直しで中継が断った区間は
// エンジンが答えた誤り（error）と同じく、区間は失敗の文のまま音声と待ち行列を残し（tries 1。3 回まで次の引き金でやり直す）、待ち行列は止まらずに先へ進む
test('F2・決めたこと 12: 中継が断った区間は残さず今の失敗の区間（帯は B4［もう一度］だけで、B1・B9・B12 は出ない）。会議の後の待ち行列は止まらずに進み（音声は残す）、その区間は失敗の文', T, async () => {
  const o = await run(['text', '--relay-seq=cb', '--no-engine=fetchable', '--after-retry']);
  assert.deepStrictEqual([...new Set(problems(o))], ['seg-failed'], dump(o));
  const s2 = o.sttAt['seg-failed'].find((x) => x.id === 's2');
  assert.strictEqual(s2.failed, true);
  assert.match(s2.text, /^（この区間の認識に失敗: /);
  assert.strictEqual(o.afterRetry.segments[1].failed, true);
  assert.match(o.afterRetry.segments[1].text, /^（この区間の認識に失敗: /);
  assert.strictEqual(o.recoveryKept, true);
  assert.ok(o.files.some((f) => f.endsWith('recovery.json')), JSON.stringify(o.files));
  assert.ok(o.engineLog.some((l) => /^復旧の文字起こしを保留: 失敗した区間の音声を残しました（1 区間・自動ではやり直さない 0 区間・やり直し 1 回）$/.test(l)), o.engineLog.join('\n'));
  assert.deepStrictEqual(saysLocal(o), []);
});

test('F5: エンジンのある PC では、中継が止まっても kept の帯も K の知らせも出ない', T, async () => {
  const o = await run(['text', '--relay-seq=cnc']);
  assert.ok(!problems(o).some((c) => c.startsWith('kept-')), dump(o));
  assert.ok(!o.notices.some((n) => KS.includes(textOf(n))), dump(o));
});

// ---------------------------------------------------------------- M-3（OF3・OF6・F2・F6・F8）
const S2 = '要約待ち（つながったら作ります）';
const S3 = '文字起こし待ちの音声があります。文字起こしが済むと、自動で要約を作ります。';
const S3L = 'この会議はオフラインモードです。文字起こし待ちの音声があります。文字起こしが済んでつながると、自動で要約を作ります。';
const R1 = (n, m) => `残しておいた音声を文字起こししました（${n}/${m} 区間）。続けて要約を作ります。`;
const isText = (x) => !x.failed && x.text.startsWith('本日の議題は進捗の確認です');
const sttPosts = (o) => o.stt.filter((r) => r.path.endsWith('/audio/transcriptions')).length;
// engine.log の、区間 a の文字起こしの後から区間 b の前までにある「（もう一度）」の区間
const retriedBetween = (log, a, b) => {
  const i = log.findIndex((l) => l.startsWith(`文字起こしの経路: 区間 ${a} → cloud`));
  const j = log.findIndex((l) => l.startsWith(`文字起こしの経路: 区間 ${b} → `));
  return log.slice(i + 1, j < 0 ? undefined : j).filter((l) => /^文字起こしの経路: 区間 s\d+（もう一度） → /.test(l)).map((l) => l.match(/区間 (s\d+)/)[1]);
};

test('OF3: 中継が戻った区間の後、残した2つの区間が自動で並べ直されて文字になり、WAV が消え、帯 B11 が消える。ページの5区間がどれも文字', T, async () => {
  const o = await run(['text', '--relay-seq=cnncc', '--no-engine=fetchable']);
  assert.deepStrictEqual(retriedBetween(o.engineLog, 's4', 's5'), ['s2', 's3'], o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('文字起こしの経路: 残した区間 2 を並べ直した'), o.engineLog.join('\n'));
  assert.strictEqual(o.pages[0].segments.length, 5);
  assert.ok(o.pages[0].segments.every(isText), JSON.stringify(o.pages[0].segments));
  assert.deepStrictEqual(segFiles(o), [], JSON.stringify(o.files));
  assert.strictEqual(o.sttSeen[o.sttSeen.length - 1].problem, null, dump(o));
});

test('F6: 1つの区間が文字になった後に並べ直すのは2つまで（中継への文字起こしの要求の並びで見る）', T, async () => {
  const o = await run(['text', '--relay-seq=cnnnncc', '--no-engine=fetchable']);
  assert.deepStrictEqual(retriedBetween(o.engineLog, 's6', 's7'), ['s2', 's3'], o.engineLog.join('\n'));
  // 最後の区間（s7）は止めた後に届くので並べ直さない。残りの s4・s5 は会議の後の待ち行列が送る
  assert.deepStrictEqual(retriedBetween(o.engineLog, 's7', 'none'), [], o.engineLog.join('\n'));
  assert.deepStrictEqual(o.engineLog.filter((l) => /^文字起こしの経路: 復旧 s\d+ → cloud/.test(l)).map((l) => l.match(/復旧 (s\d+)/)[1]), ['s4', 's5'], o.engineLog.join('\n'));
  assert.ok(o.pages[0].segments.every(isText), JSON.stringify(o.pages[0].segments));
});

test('F6: 残した区間がある会議を止めると、止めた後に中継で文字になる区間があっても並べ直さずにすぐ締める（締めまで 2 秒以内・中継で文字になった要求は 2 つ）。要約の欄は S3、要約は呼ばない。recovery.json に残した2区間', T, async () => {
  // 4つ目（最後）は止めた後に届き、中継で文字になる。中継はその答えの後に止まる（z: 会議の後の待ち行列が送れないまま残るのを見る）
  const o = await run(['text', '--relay-seq=cnnz', '--no-engine=fetchable', '--claude=text', '--after-retry']);
  assert.ok(o.segWaitMs.every((ms) => ms < 2000), JSON.stringify(o.segWaitMs));
  assert.deepStrictEqual(retriedBetween(o.engineLog, 's4', 'none'), [], o.engineLog.join('\n'));
  assert.strictEqual(sttPosts(o), 2, JSON.stringify(o.stt.map((r) => r.path)));
  assert.strictEqual(o.pages[0].summaryError, S3);
  assert.deepStrictEqual(o.claude.filter((c) => c.kind === 'p'), [], '要約を Claude Code へ送った');
  assert.strictEqual(o.recoveryKept, true);
  assert.strictEqual(segFiles(o).length, 2, JSON.stringify(o.files));
});

test('F1・F2・決めたこと 6: 並べ直した残した区間の答えが空なら区間ごと消え（WAV も消える）、次の区間の後にもう一度送らない（中継への文字起こしの要求はちょうど 5 つ）。帯 B11 が消える', T, async () => {
  const o = await run(['text', '--relay-seq=cnccc', '--relay-req-text=ccecc', '--no-engine=fetchable']);
  assert.strictEqual(sttPosts(o), 5, o.engineLog.join('\n'));
  // 3つ目の要求（空の答え）は、s3 の後に並べ直した s2。その後は s2 を送らない（並べ直しも、会議の後の待ち行列も）
  assert.deepStrictEqual(retriedBetween(o.engineLog, 's3', 's4'), ['s2'], o.engineLog.join('\n'));
  assert.deepStrictEqual(retriedBetween(o.engineLog, 's4', 'none'), [], o.engineLog.join('\n'));
  assert.ok(!o.engineLog.some((l) => /^文字起こしの経路: 復旧 s2 /.test(l)), o.engineLog.join('\n'));
  assert.strictEqual(o.pages[0].segments.length, 4, JSON.stringify(o.pages[0].segments));
  assert.ok(o.pages[0].segments.every(isText), JSON.stringify(o.pages[0].segments));
  assert.deepStrictEqual(segFiles(o), []);
  assert.strictEqual(o.sttSeen[o.sttSeen.length - 1].problem, null, dump(o));
});

test('OF3・F8: 戻った後の見回り1回で、待ち行列の2区間が中継で文字になり、R1 の知らせ、要約が Claude Code で入り、要約の欄の S3 が消える。WAV と recovery.json が片付く', T, async () => {
  const o = await run(['text', '--relay-seq=cnn', '--no-engine=fetchable', '--claude=text', '--back-after']);
  assert.strictEqual(o.pages[0].summaryError, S3, '締めで S3 を書いていない');
  const b = o.afterBack;
  assert.ok(b.pages[0].segments.every(isText), JSON.stringify(b.pages[0].segments));
  assert.ok(b.notices.map(textOf).includes(R1(2, 2)), JSON.stringify(b.notices));
  assert.strictEqual(b.claudeCalls, 1, '要約を Claude Code で作っていない');
  assert.strictEqual(b.pages[0].summaryError, '');
  assert.ok(b.pages[0].blocks > 0, '要約が入っていない');
  assert.deepStrictEqual(b.files.filter((f) => /^data\/segbuf\//.test(f)), [], JSON.stringify(b.files));
});

test('F2: オフラインの見回り3回では中継へ何も送らず（/health も）、見回りの3回で増えた記録は「文字起こし待ち: 見回り」の1行だけ（「復旧の文字起こしを保留」も増えない）', T, async () => {
  const o = await run(['text', '--relay-seq=cn', '--no-engine=fetchable', '--ticks-offline=3']);
  assert.strictEqual(o.ticksOffline.ticks, 3);
  assert.deepStrictEqual(o.ticksOffline.relayAdded, []);
  // 待ち行列 1・音声入力 0・理由 offline（オフラインの間は何もしない）
  assert.deepStrictEqual(o.ticksOffline.logAdded, ['文字起こし待ち: 見回り（1・0・offline）']);
});

test('F2: PC の中だけの待ち行列が先にあっても、後ろのクラウドの待ち行列が見回りで文字になる。PC の中だけの区間は中継へ送らず、その WAV と recovery.json は残る。「復旧の文字起こしを保留」は起動から終わりまでで1行', T, async () => {
  const o = await run(['text', '--relay=text', '--no-engine=fetchable', '--extra-queue=localonly', '--recover', '--idle', '--kept-ticks=2']);
  const byLocal = (local) => o.pages.find((p) => Boolean(p.route && p.route.localOnly) === local);
  assert.ok(byLocal(false).segments.every((x) => !x.failed), JSON.stringify(o.pages));
  assert.ok(byLocal(true).segments.every((x) => x.failed), JSON.stringify(o.pages));
  assert.strictEqual(sttPosts(o), 1, 'PC の中だけの区間を中継へ送った');
  assert.strictEqual(o.engineLog.filter((l) => l.startsWith('復旧の文字起こしを保留')).length, 1, o.engineLog.join('\n'));
  assert.ok(o.files.some((f) => /^data\/segbuf\/[^/]+\/recovery\.json$/.test(f)), JSON.stringify(o.files));
  assert.strictEqual(o.files.filter((f) => /^data\/segbuf\/.+\.wav$/.test(f)).length, 1, JSON.stringify(o.files));
});

test('F5・RF49: エンジンのある PC で、起動の後に置いた PC の中だけの待ち行列は、見回りでは手元のエンジンで文字起こししない（inference 0・待ち行列は残る）。中継へも送らない', T, async () => {
  const o = await run(['text', '--relay=text', '--extra-queue-late=localonly', '--idle', '--kept-ticks=1']);
  assert.deepStrictEqual(o.requests, [], '手元のエンジンで文字起こしした');
  assert.strictEqual(sttPosts(o), 0);
  assert.ok(o.files.some((f) => /^data\/segbuf\/[^/]+\/recovery\.json$/.test(f)), JSON.stringify(o.files));
});

test('F5・RF49: エンジンのある PC の見回りは、中継が /health に答えて文字起こしだけ 502 でも、手元のエンジンで文字起こししない（inference 0）。待ち行列と残した音声入力（行の wait と WAV）は残る', T, async () => {
  const o = await run(['text', '--relay=text', '--relay-seq=5', '--extra-queue-late=cloud', '--wait-dictwait', '--idle', '--kept-ticks=2']);
  assert.ok(sttPosts(o) >= 1, '前提: 見回りが中継へ送っていない');
  assert.deepStrictEqual(o.requests, [], '手元のエンジンで文字起こしした');
  assert.ok(o.files.some((f) => /^data\/segbuf\/[^/]+\/recovery\.json$/.test(f)), JSON.stringify(o.files));
  assert.strictEqual(o.files.filter((f) => /^data\/segbuf\/.+\.wav$/.test(f)).length, 1, JSON.stringify(o.files));
  assert.ok(o.files.some((f) => /^data\/dictwait\/\d+-hwait1\.wav$/.test(f)), JSON.stringify(o.files));
  assert.deepStrictEqual(o.history.map((h) => [h.id, Boolean(h.wait)]), [['hwait1', true]], JSON.stringify(o.history));
  assert.ok(o.pages[0].segments.every((x) => x.failed), JSON.stringify(o.pages));
});

test('F8: 準備を選んでいない PC の、PC の中だけの会議（残した区間あり）の要約の欄は S3\'。偽の claude は呼ばれない', T, async () => {
  const o = await run(['text', '--relay=text', '--no-engine=fetchable', '--local-only', '--sum', '--claude=text', '--segs=1']);
  assert.strictEqual(o.pages[0].summaryError, S3L, dump(o));
  assert.deepStrictEqual(o.claude.filter((c) => c.kind === 'p'), []);
});

test('S2: 準備を選んでいない PC で、要約のときに Claude Code へ届かない（手元の LLM も無い）なら、要約の欄と知らせは S2（「未設定」の文で設定へ連れて行かない）', T, async () => {
  const o = await run(['text', '--relay=text', '--no-engine=fetchable', '--segs=1']);
  assert.strictEqual(o.pages[0].summaryError, S2, dump(o));
  assert.ok(o.notices.map(textOf).includes(S2), dump(o));
  assert.ok(!JSON.stringify(o.notices).includes('未設定'), dump(o));
});

test('OF3: ログインした直後に、待ち行列が中継で文字になる（見回りを待たない）', T, async () => {
  const o = await run(['text', '--relay=text', '--signed-out', '--no-engine=fetchable', '--segs=2', '--login-after']);
  assert.ok(o.pages[0].segments.every((x) => x.failed), '前提: ログインする前は文字起こし待ち');
  assert.strictEqual(o.afterLogin.login.ok, true, JSON.stringify(o.afterLogin.login));
  assert.ok(o.afterLogin.pages[0].segments.every(isText), JSON.stringify(o.afterLogin));
  assert.strictEqual(o.afterLogin.keptTicks, 0, '見回りを呼んだ');
});

// ---------------------------------------------------------------- M-4（OF4・F3）
const P1 = 'この会議をオフラインモードにしました。PC の中で文字起こしするには、設定の「ローカル AI」の準備（数 GB の取り込み）が要ります。今は音声だけをこの PC に残し、外には送りません。準備が済むと文字起こしします。';
const B14 = 'この会議はオフラインモードです。PC の中の文字起こしが入っていないので、音声だけを残しています（外には送りません）。［ローカル AI の準備］から取り込むと、文字起こしします。';

test('F3: エンジンの無い PC で押すと受け（localOnly・needsSetup が真。meeting:status の needsSetup も真）、知らせ P1、帯 B14（action offline）。区間は「文字起こし待ち」で WAV が残る。押した後・会議の後・見回りのどれでも、中継の文字起こしの口への要求は 0、偽の claude の呼び出しも 0。recovery.json は localOnly: true で残る', T, async () => {
  const o = await run(['text', '--relay=text', '--no-engine=fetchable', '--local-only', '--segs=2', '--claude=text', '--back-after']);
  assert.deepStrictEqual(o.localOnly, { ok: true, localOnly: true, needsSetup: true });
  assert.strictEqual(o.statusNeedsSetup, true);
  assert.deepStrictEqual(o.notices.filter((n) => textOf(n) === P1), [{ text: P1, action: 'offline' }], dump(o));
  const kl = o.sttSeen.filter((s) => s.problem && s.problem.code === 'kept-local');
  assert.ok(kl.length && kl.every((s) => s.problem.text === B14 && s.problem.action === 'offline'), dump(o));
  assert.ok(o.pages[0].segments.every((x) => x.text === KEPT_SEG_TEXT && x.failed), JSON.stringify(o.pages[0].segments));
  assert.strictEqual(sttPosts(o), 0, '押した後・会議の後に中継へ送った');
  assert.strictEqual(o.afterBack.relayCalls.filter((p) => p === STT).length, 0, '見回りで中継へ送った');
  assert.strictEqual(o.afterBack.claudeCalls, 0);
  assert.deepStrictEqual(o.afterBack.queues, [{ localOnly: true, items: 2 }], '待ち行列が localOnly で残っていない');
  assert.deepStrictEqual(saysLocal(o), []);
});

test('F3: 中継が止まって残した区間の後に押すと、その区間は中継が戻っても送らない（文字起こしの要求は押す前の1区間だけ）', T, async () => {
  const o = await run(['text', '--relay-seq=cnccc', '--no-engine=fetchable', '--local-only-after=2', '--back-after']);
  assert.deepStrictEqual(o.localOnly, { ok: true, localOnly: true, needsSetup: true });
  assert.strictEqual(sttPosts(o), 1, o.engineLog.join('\n'));
  assert.strictEqual(o.afterBack.relayCalls.filter((p) => p === STT).length, posts(o.relayCalls), '見回りで中継へ送った');
  assert.deepStrictEqual(o.afterBack.queues, [{ localOnly: true, items: 4 }]);
});

test('F3: 中継で文字になった区間が残した区間を並べ直し、1つ目を送っている間に押すと、segChain で待っている2つ目は中継へ送らない。会議の後の待ち行列は localOnly: true で、その区間の WAV が残る', T, async () => {
  const o = await run(['text', '--relay-seq=cnncc', '--no-engine=fetchable', '--local-only-at-retry=4', '--back-after']);
  assert.deepStrictEqual(o.localOnly, { ok: true, localOnly: true, needsSetup: true });
  assert.strictEqual(o.sttSentAtLocalOnly, 2, '前提: 押したときに s4 と並べ直した1つ目を送っていない');
  // s1・s4・並べ直した s2 の3つだけ（s3 と押した後の s5 は送らない）
  assert.strictEqual(sttPosts(o), 3, o.engineLog.join('\n'));
  assert.deepStrictEqual(retriedBetween(o.engineLog, 's4', 'none'), ['s2'], o.engineLog.join('\n'));
  assert.strictEqual(o.afterBack.relayCalls.filter((p) => p === STT).length, posts(o.relayCalls), '見回りで中継へ送った');
  assert.deepStrictEqual(o.afterBack.queues, [{ localOnly: true, items: 2 }]);
  assert.strictEqual(segFiles(o).length, 2, JSON.stringify(o.files));
});

test('F5: エンジンのある PC で押すと needsSetup は偽・P1 も B14 も出ず、今どおり PC で文字になる', T, async () => {
  const o = await run(['text', '--relay=text', '--local-only']);
  // 答えの needsSetup は真のときだけ（無ければ偽。0.8.0 の答えの形のまま）
  assert.deepStrictEqual(o.localOnly, { ok: true, localOnly: true });
  assert.strictEqual(o.statusNeedsSetup, false);
  assert.ok(!o.notices.some((n) => textOf(n) === P1), dump(o));
  assert.ok(!problems(o).includes('kept-local'), dump(o));
  assert.ok(allText(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
  assert.strictEqual(sttPosts(o), 0);
});

// ---------------------------------------------------------------- M-5（OF5・F7・F9）
const D4 = '文字起こしできなかったので、音声を残しました。つながると文字起こしして、履歴に入れます。';
const D5 = '（文字起こし待ち: 音声は残してあります）';
const D6 = (n) => `残しておいた音声入力を ${n} 件文字起こしして、履歴に入れました（貼り付けはしていません）。`;
const waitFiles = (files) => files.filter((f) => /^data\/dictwait\/\d+-[A-Za-z0-9]+\.wav$/.test(f));
const overlayMsgs = (o) => (o.overlayPhases || []).map((p) => p.message);

test('F7: 録った後で中継が使えないと、音声を dictwait に残し、履歴に D5 の行、録音バーに D4。貼り付けは 0 回。戻った見回りで行が文字になり、WAV が消え、D6 を1回、貼り付けは 0 回のまま', T, async () => {
  const o = await run(['text', '--dictate', '--relay-seq=n', '--no-engine=fetchable', '--dict-back']);
  assert.strictEqual(o.history.length, 1, dump(o));
  const h = o.history[0];
  assert.strictEqual(h.text, D5);
  assert.match(h.wait, /^\d+-[A-Za-z0-9]+\.wav$/);
  assert.ok(h.wait.endsWith(`-${h.id}.wav`), `ファイルの名前に履歴の id が無い: ${h.wait}`);
  assert.ok(!h.wait.includes('/') && !h.wait.includes('\\'), 'パスを書いた');
  assert.ok(overlayMsgs(o).includes(D4), JSON.stringify(o.overlayPhases));
  assert.deepStrictEqual(o.pastes, []);
  assert.deepStrictEqual(waitFiles(o.files), [`data/dictwait/${h.wait}`]);
  assert.ok(o.engineLog.some((l) => /^音声入力: 音声を残した（\d+ 秒）$/.test(l)), o.engineLog.join('\n'));
  // 戻った
  const b = o.dictBack;
  assert.strictEqual(b.history.length, 1);
  assert.strictEqual(b.history[0].id, h.id);
  assert.match(b.history[0].text, /^本日の議題は進捗の確認です/);
  assert.strictEqual(b.history[0].wait, undefined);
  assert.deepStrictEqual(waitFiles(b.files), []);
  assert.strictEqual(b.notices.filter((n) => textOf(n) === D6(1)).length, 1, JSON.stringify(b.notices));
  assert.deepStrictEqual(b.pastes, [], '戻った後に貼り付けた');
});

test('F7: 履歴の上限で行が切れても、見回りがその時刻の行を足し直して文字にする', T, async () => {
  const o = await run(['text', '--dictate-twice', '--relay-seq=nc', '--max-history=1', '--no-engine=fetchable', '--dict-back']);
  assert.strictEqual(o.history.length, 1, '前提: 上限で残した行が切れていない');
  assert.strictEqual(o.history[0].wait, undefined);
  assert.strictEqual(waitFiles(o.files).length, 1, '前提: 残した音声が無い');
  const id = waitFiles(o.files)[0].match(/-([A-Za-z0-9]+)\.wav$/)[1];
  const b = o.dictBack;
  const row = b.history.find((x) => x.id === id);
  assert.ok(row, JSON.stringify(b.history));
  assert.match(row.text, /^本日の議題は進捗の確認です/);
  assert.deepStrictEqual(b.history.map((x) => x.id), [o.history[0].id, id], '時刻の順の所に足していない');
  assert.deepStrictEqual(waitFiles(b.files), []);
});

test('F9: 8 日前の残した音声入力の WAV は起動の掃除で消えない', T, async () => {
  const o = await run(['text', '--old-dictwait', '--idle']);
  assert.strictEqual(waitFiles(o.files).length, 1, JSON.stringify(o.files));
});

test('OF5: 履歴の行を消すと、残した WAV も消える（全部消すときも）', T, async () => {
  const [d, c] = await Promise.all([run(['text', '--dictate', '--relay-seq=n', '--no-engine=fetchable', '--dict-delete']),
    run(['text', '--dictate', '--relay-seq=n', '--no-engine=fetchable', '--dict-clear'])]);
  for (const o of [d, c]) assert.strictEqual(waitFiles(o.files).length, 1, '前提: 残した音声が無い');
  assert.deepStrictEqual(d.afterDelete.history, []);
  assert.deepStrictEqual(waitFiles(d.afterDelete.files), [], '行を消しても WAV が残った');
  assert.deepStrictEqual(c.afterClear.history, []);
  assert.deepStrictEqual(waitFiles(c.afterClear.files), [], '全部消しても WAV が残った');
});

test('F7: 保存した後・消す前に落ちた WAV は、行を足し直さずに消す（履歴の行の数は変わらない・中継へ送らない）', T, async () => {
  const o = await run(['text', '--done-dictwait', '--relay=text', '--idle', '--kept-ticks=1']);
  assert.deepStrictEqual(waitFiles(o.files), []);
  assert.strictEqual(o.history.length, 1, JSON.stringify(o.history));
  assert.strictEqual(o.history[0].text, '保存した後に落ちた音声入力の文');
  assert.strictEqual(sttPosts(o), 0);
});

test('F5・F7・決めたこと 14: 選んだ人でも、手元が使えずクラウドで始めた音声入力は、中継が使えないと音声を dictwait に残す（音声を捨てない）', T, async () => {
  const o = await run(['text', '--dictate', '--relay-seq=n', '--no-whisper']);
  assert.strictEqual(o.history.length, 1, dump(o));
  assert.strictEqual(o.history[0].text, D5);
  assert.strictEqual(waitFiles(o.files).length, 1, JSON.stringify(o.files));
  assert.ok(overlayMsgs(o).includes(D4), JSON.stringify(o.overlayPhases));
});

test('F7: 見回りが残した音声入力を文字起こししている間に利用者がその行を消すと、行を足し直さない（行の数は 0 のまま・WAV も無い・D6 は出ない）', T, async () => {
  const o = await run(['text', '--dictate', '--relay-seq=n', '--no-engine=fetchable', '--dict-back=delete']);
  assert.strictEqual(o.history.length, 1, '前提: 残した行が無い');
  const id = o.history[0].id;
  assert.deepStrictEqual(o.deletedDuring, { id, history: 0 }, '前提: 送っている間に消していない');
  const b = o.dictBack;
  assert.deepStrictEqual(b.history, [], '利用者が消した行を足し直した');
  assert.deepStrictEqual(waitFiles(b.files), []);
  assert.strictEqual(b.notices.filter((n) => /^残しておいた音声入力を/.test(textOf(n))).length, 0, JSON.stringify(b.notices));
  assert.deepStrictEqual(b.pastes, []);
});

test('F7: 見回りで文字になっても（空の答えでも）履歴を保存できなければ、残した WAV を消さず、行も「文字起こし待ち」（wait）のまま。D6 は出ない', T, async () => {
  // 2つ目は、見回りの文字起こしの答えが空（無音）。行を消す保存ができなければ、行も WAV も残す
  const [t, e] = await Promise.all([run(['text', '--dictate', '--relay-seq=n', '--no-engine=fetchable', '--dict-back=readonly']),
    run(['text', '--dictate', '--relay-seq=n', '--relay-req-text=e', '--no-engine=fetchable', '--dict-back=readonly'])]);
  for (const [o, line] of [[t, '履歴: 残した音声入力の文字を保存できませんでした（音声は残します）'], [e, '履歴: 残した音声入力の行を消せませんでした（音声は残します）']]) {
    const h = o.history[0];
    assert.strictEqual(h.text, D5, '前提: 残した行が無い');
    const b = o.dictBack;
    assert.ok(b.engineLog.some((l) => l.startsWith('文字起こしの経路: 音声入力（残した音声） → cloud')), '前提: 見回りが文字起こししていない');
    assert.deepStrictEqual(waitFiles(b.files), [`data/dictwait/${h.wait}`], '保存できないのに WAV を消した');
    assert.deepStrictEqual(b.history.map((x) => [x.id, x.text, x.wait]), [[h.id, D5, h.wait]], JSON.stringify(b.history));
    assert.ok(b.engineLog.includes(line), b.engineLog.join('\n'));
    assert.strictEqual(b.notices.filter((n) => /^残しておいた音声入力を/.test(textOf(n))).length, 0, JSON.stringify(b.notices));
  }
});

test('F7・RF20: 音声入力の音声を残す一時ファイルの名前の変更が1回 EPERM（ウイルス対策が掴んだ）でも、待ってやり直して残す（D5 の行・WAV・.tmp は残らない）', T, async () => {
  const o = await run(['text', '--dictate', '--relay-seq=n', '--no-engine=fetchable', '--dict-rename-busy-once']);
  assert.strictEqual(o.dictRenameBusy, 1, '前提: 名前の変更を止めていない');
  assert.strictEqual(o.history.length, 1, dump(o));
  assert.strictEqual(o.history[0].text, D5);
  assert.deepStrictEqual(waitFiles(o.files), [`data/dictwait/${o.history[0].wait}`]);
  assert.ok(!o.files.some((f) => f.endsWith('.tmp')), JSON.stringify(o.files));
  assert.ok(overlayMsgs(o).includes(D4), JSON.stringify(o.overlayPhases));
});
