/*
 * stage1d2.main.test.js — 第1d2回（NaTsu 0.9.0 のレーン A。設計書 D21: オフラインの準備を任意にする）の場面。main.js を偽の Electron の上で
 * 本当に動かす（helpers/mainrun.js）。中継は本物の relay/ のコードを 127.0.0.1 で包んだもの（helpers/relay-local.js）。外へはつながない。
 * 「エンジンの無い PC」は --no-engine=fetchable（詳細設定の文字起こしが空で、何も取り込んでいない取り込める PC）。
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

const L1 = 'この会議の音声は OpenAI に送られます（文字起こしのため）。1on1・面談など外に出したくない会議は、議事録の画面の［この会議は PC の中だけ］を押してください。';
const D1 = 'インターネットにつながっていないため、音声入力を始めませんでした。オンラインに戻ってから、もう一度お試しください。オフラインでも使うには、設定の「オフライン」で準備します。';
const UNSET_FETCH = '文字起こしエンジンが未設定です。設定タブの［PC の中の文字起こしを取り込む］から取り込んでください。';

// 帯（B11〜B14）と会議の中の知らせ（K1〜K4）。計画「画面と知らせの文」
const B11 = 'PC の中の文字起こしが入っていないので、音声を残しています。オンラインに戻ると文字起こしします。録音はそのまま続けてください。';
const B13 = 'ログインしていないため、音声を残しています。［ログイン］を押してログインすると、文字起こしします。';
const K1 = '今はクラウドで文字起こしできないため、音声だけを残します。つながると、この会議の音声を OpenAI に送って文字起こしします。1on1・面談など外に出したくない会議は、議事録の画面の［この会議は PC の中だけ］を押してください。';
const K2 = 'ログインしていないため、音声だけを残します。設定の「アカウント」でログインすると、この会議の音声を OpenAI に送って文字起こしします。1on1・面談など外に出したくない会議は、議事録の画面の［この会議は PC の中だけ］を押してください。';
const K3 = '文字起こしの中継が使えないため、音声を残しています。使えるようになると自動で文字起こしします。録音はそのまま続けてください。';
const KEPT_SEG_TEXT = '（文字起こし待ち: 音声は残してあります）';
const KS = [K1, K2, K3, 'ログインが切れたため、音声を残しています。設定の「アカウント」でもう一度ログインすると、文字起こしします。'];
const count = (o, text) => o.notices.filter((n) => textOf(n) === text).length;
// PC で文字起こししたと言う 0.8.0 の知らせ（L2〜L8・L11）は、準備を選んでいない PC では本当でない
const saysLocal = (o) => o.notices.map(textOf).filter((t) => /PC の中で文字起こし/.test(t));
const segFiles = (o) => o.files.filter((f) => /^data\/segbuf\/[^/]+\/\d+\.wav$/.test(f));
const os = require('node:os');
const fs = require('node:fs');
const tmpDirs = [];
const tmpUserData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-ud-残す𠮷-')); tmpDirs.push(d); return d; };
test.after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 消せなくても結果は変わらない */ } } });
// main ごと落ちる場面（終わりの番号が 0 でない）を1回動かす
const runExit = (args) => new Promise((resolve, reject) => {
  execFile(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 20000 },
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
  const o = await run(['text', '--relay=text', '--no-engine=fetchable', '--segs=2', '--claude=ok']);
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

test('F2・決めたこと 12: 中継が断った区間は残さず今の失敗の区間（帯は B4［もう一度］だけで、B1・B9・B12 は出ない）。会議の後の待ち行列は止まらずに済み（recovery.json が無い）、その区間は失敗の文', T, async () => {
  const o = await run(['text', '--relay-seq=cb', '--no-engine=fetchable', '--after-retry']);
  assert.deepStrictEqual([...new Set(problems(o))], ['seg-failed'], dump(o));
  const s2 = o.sttAt['seg-failed'].find((x) => x.id === 's2');
  assert.strictEqual(s2.failed, true);
  assert.match(s2.text, /^（この区間の認識に失敗: /);
  assert.strictEqual(o.afterRetry.segments[1].failed, true);
  assert.match(o.afterRetry.segments[1].text, /^（この区間の認識に失敗: /);
  assert.strictEqual(o.recoveryKept, false);
  assert.ok(!o.files.some((f) => f.endsWith('recovery.json')), JSON.stringify(o.files));
  assert.deepStrictEqual(saysLocal(o), []);
});

test('F5: エンジンのある PC では、中継が止まっても kept の帯も K の知らせも出ない', T, async () => {
  const o = await run(['text', '--relay-seq=cnc']);
  assert.ok(!problems(o).some((c) => c.startsWith('kept-')), dump(o));
  assert.ok(!o.notices.some((n) => KS.includes(textOf(n))), dump(o));
});
