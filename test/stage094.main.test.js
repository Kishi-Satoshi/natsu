/*
 * stage094.main.test.js — 0.9.4（計画 docs/plans/2026-10-22-094.md）の main の場面。偽の Electron の上で main.js を本当に動かして確かめる
 * （helpers/mainrun.js。偽の whisper は helpers/fake-whisper.js の hang・hang-first・err500・refuse）。
 * PC への要求の待ち時間は NATSU_TEST_LOCAL_TIME_SCALE で縮める（0.005 なら 240 秒が 1.2 秒）。
 *  S-2: PC への要求を node:http に・時間切れの扱い（区間は kept・帯 kept-late・エンジンの起こし直し）と文
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args, { scale = '0.005', env = {} } = {}) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], {
    env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001', NATSU_TEST_LOCAL_TIME_SCALE: scale, ...env },
    maxBuffer: 1 << 24, timeout: 20000,
  }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});
const T = { timeout: sceneTimeout(20000) };
const LATE_SEG = '（文字起こし待ち: PC の文字起こしが間に合わなかったので、後で文字起こしします）';
const DOWN_SEG = '（文字起こし待ち: PC の文字起こしエンジンにつながらなかったので、後で文字起こしします）';
const LATE_BANNER = 'この PC の文字起こしが録音に追いつかないため、音声を残しています。会議が終わったら文字起こしします。録音はそのまま続けてください。';
const codes = (o) => o.sttSeen.map((s) => (s && s.problem ? s.problem.code : null)).filter((c, i, a) => i === 0 || a[i - 1] !== c);
const problemOf = (o, code) => o.sttSeen.map((s) => s && s.problem).find((p) => p && p.code === code);
const whisperSpawns = (o) => (o.spawns || []).filter((s) => /fake-whisper\.js$/.test(s.cmd) || /whisper-server/.test(s.cmd));
const dump = (o) => JSON.stringify({ sttSeen: o.sttSeen, sttAt: o.sttAt, engineLog: o.engineLog, requests: o.requests }, null, 1);
const lateLine = /^手元の文字起こしの時間切れ: (s\d+)（音声 (\d+) 秒・待ち (\d+) 秒）。エンジンを起こし直します$/;

// ---------------------------------------------------------------- S-2（決めたこと 15〜18）
test('S3: 時間切れの区間は kept・文は『（文字起こし待ち: PC の文字起こしが間に合わなかったので、後で文字起こしします）』・帯は kept-late（engine-down でない）。会議の後のやり直しで文字になる', T, async () => {
  const o = await run(['hang-first', '--segs=2', '--after-retry']);
  const at = o.sttAt['kept-late'];
  assert.ok(at, dump(o));
  const s1 = at.find((s) => s.id === 's1');
  assert.deepStrictEqual(s1, { id: 's1', text: LATE_SEG, failed: true, wav: true }, dump(o));
  assert.deepStrictEqual(problemOf(o, 'kept-late'), { code: 'kept-late', text: LATE_BANNER, action: '', offline: false });
  assert.ok(!codes(o).includes('engine-down'), `時間切れで engine-down を立てた: ${JSON.stringify(codes(o))}`);
  assert.ok(!o.engineLog.includes('文字起こしの状態: 帯 engine-down'), o.engineLog.join('\n'));
  assert.ok(!o.engineLog.includes('文字起こしの状態: 帯 seg-failed'), `時間切れの区間を失敗に数えた: ${o.engineLog.join('\n')}`);
  // 会議の後のやり直し（起こし直したエンジン）で文字になる
  assert.ok(o.afterRetry.segments.length >= 2 && o.afterRetry.segments.every((s) => !s.failed && s.text.startsWith('本日の議題は進捗の確認です')), JSON.stringify(o.afterRetry.segments));
  assert.ok(!o.engineLog.some((l) => /エンジンにつながりませんでした/.test(l)));
});

// 0.9.4 S-4 の後: 時間切れは遅い PC の印でもある（決めたこと 9 の (c)）ので、その会議の 2 区間目は PC へ送らずに残し、起こし直したエンジンは会議の後に使う
test('S11: 時間切れの後は whisper のプロセスを止め、次の区間で起こし直す（偽の spawn が2回）。engine.log の時間切れの行は区間の番号・秒・符号だけ', T, async () => {
  const o = await run(['hang-first', '--segs=2', '--after-retry']);
  assert.strictEqual(whisperSpawns(o).length, 2, dump(o));
  const lines = o.engineLog.filter((l) => l.startsWith('手元の文字起こしの時間切れ'));
  assert.deepStrictEqual(lines, ['手元の文字起こしの時間切れ: s1（音声 3 秒・待ち 240 秒）。エンジンを起こし直します'], o.engineLog.join('\n'));
  // 時間切れの要求の接続は閉じた（whisper-server の中で走り続けない）。区間は起こし直したエンジンが文字にした
  assert.ok(o.engineLog.includes('手元の文字起こしの失敗: s1（LOCAL_TIMEOUT）'), o.engineLog.join('\n'));
  assert.ok(o.afterRetry.segments.length === 2 && o.afterRetry.segments.every((s) => !s.failed && /区間/.test(s.text)), JSON.stringify(o.afterRetry.segments));
  const log = o.afterRetry.engineLog;
  const idx = log.findIndex((l) => lateLine.test(l));
  const spawnAfter = log.slice(idx + 1).some((l) => /起動: /.test(l));
  assert.ok(spawnAfter, `時間切れの後に起こし直していない: ${log.join('\n')}`);
  // 時間切れの行に文字起こしの文・パスを書かない
  for (const l of lines) assert.ok(!/本日の議題|[\\/]|\.bin/.test(l), l);
});

test('S3: 偽のエンジンが止まっている（ECONNREFUSED）区間は kept・文は『…エンジンにつながらなかったので…』・帯は engine-down', T, async () => {
  const o = await run(['refuse', '--segs=2']);
  const at = o.sttAt['engine-down'];
  assert.ok(at, dump(o));
  const s1 = at.find((s) => s.id === 's1');
  assert.deepStrictEqual(s1, { id: 's1', text: DOWN_SEG, failed: true, wav: true }, dump(o));
  assert.ok(!codes(o).includes('kept-late') && !codes(o).includes('seg-failed'), JSON.stringify(codes(o)));
  assert.ok(!o.engineLog.includes('文字起こしの状態: 帯 seg-failed'), `届かない区間を失敗に数えた: ${o.engineLog.join('\n')}`);
  assert.ok(o.engineLog.includes('手元の文字起こしの失敗: s2（ECONNREFUSED）'), o.engineLog.join('\n'));
  assert.ok(!o.engineLog.some((l) => l.startsWith('手元の文字起こしの時間切れ')), o.engineLog.join('\n'));
});

test('エンジンが 500 を返した区間は今の失敗（seg-failed。音声は残す。帯は今どおり engine-down が先）', T, async () => {
  const o = await run(['err500', '--segs=2']);
  const at = o.sttAt['engine-down'];
  assert.ok(at, dump(o));
  assert.deepStrictEqual(at.find((s) => s.id === 's1'), { id: 's1', text: '（この区間の認識に失敗: 文字起こしエンジンエラー (500): boom）', failed: true, wav: true }, dump(o));
  assert.ok(o.engineLog.includes('文字起こしの状態: 帯 seg-failed'), o.engineLog.join('\n'));
  assert.ok(!codes(o).includes('kept-late'), JSON.stringify(codes(o)));
  assert.ok(!o.engineLog.some((l) => l.startsWith('手元の文字起こしの時間切れ')), o.engineLog.join('\n'));
});

test('待ち時間は localTimeoutMs（覚えの rtf 1.7・120 秒の区間で 468 秒 × 尺度）。別のモデルの覚えは使わない（300 秒）', T, async () => {
  const pace = (model) => `--pace=${JSON.stringify({ schema: 1, model, rtf: 1.7, slow: false, at: 'now-1', from: 'live' })}`;
  const [same, other] = await Promise.all([
    run(['hang-first', '--segs=1', '--seg-ms=120000', pace('same')], { scale: '0.002' }),
    run(['hang-first', '--segs=1', '--seg-ms=120000', pace({ name: 'ggml-medium-q5_0.bin', size: 539212467 })], { scale: '0.002' }),
  ]);
  assert.ok(same.engineLog.includes('手元の文字起こしの時間切れ: s1（音声 120 秒・待ち 468 秒）。エンジンを起こし直します'), same.engineLog.join('\n'));
  assert.ok(other.engineLog.includes('手元の文字起こしの時間切れ: s1（音声 120 秒・待ち 300 秒）。エンジンを起こし直します'), other.engineLog.join('\n'));
});

test('音声入力の時間切れは文字起こし待ちの履歴に残す', T, async () => {
  const o = await run(['hang', '--dictate']);
  assert.strictEqual(o.history.length, 1, JSON.stringify(o.history));
  assert.match(o.history[0].wait || '', /^\d+-[A-Za-z0-9]+\.wav$/, JSON.stringify(o.history));
  assert.ok(o.engineLog.includes('手元の文字起こしの時間切れ: 音声入力（音声 3 秒・待ち 240 秒）。エンジンを起こし直します'), o.engineLog.join('\n'));
});

// ---------------------------------------------------------------- S-3（決めたこと 2〜6）: 音声を失わない
// --recover-again=<n> は会議の後の文字起こしを設定の保存（settings:save）で n 回引き直し、そのたびの議事録・待ち行列・WAV・要求の数を out.again に写す
const queueOf = (x) => x.queue.map((q) => q.items.map((it) => ({ id: it.id, tries: it.tries, held: it.held })));
const SKIP_DONE = /^残しておいた音声を文字起こししました（2\/2 区間）。［要約を生成］で議事録を作り直せます。$/;

test('S1: 時間切れの区間は、会議の後のやり直しでも時間切れなら WAV と待ち行列（recovery.json）を残し、エンジンを起こし直した次の引き金で文字になる', T, async () => {
  const o = await run(['hang-first', '--segs=1', '--after-retry', '--recover-again=1'], { env: { FAKE_HANG_N: '2' } });
  // 会議の後のやり直しも時間切れ: 区間は「文字起こし待ち」のまま、WAV と待ち行列が残る
  assert.ok(o.afterRetry.engineLog.includes('復旧の文字起こしを止めました（理由: late）。残りの 1 区間の音声と待ち行列は残します'), o.afterRetry.engineLog.join('\n'));
  assert.deepStrictEqual(o.afterRetry.segments, [{ text: LATE_SEG, failed: true }]);
  assert.strictEqual(o.afterRetry.engineLog.filter((l) => lateLine.test(l)).length, 2, o.afterRetry.engineLog.join('\n'));
  // 次の引き金（設定の保存）で、起こし直したエンジンが文字にする。WAV と待ち行列は消える
  const a = o.again[0];
  assert.ok(a.pages[0].segments.length === 1 && !a.pages[0].segments[0].failed && a.pages[0].segments[0].text.startsWith('本日の議題は進捗の確認です'), JSON.stringify(a.pages));
  assert.deepStrictEqual([a.queue, a.wavs], [[], []]);
});

test('S1: エンジンが誤りを返す区間は 3 回までやり直し、3 回目の後は WAV を残したまま held。次の引き金ではやり直さない。ページを消すと WAV も消える。前の版の recovery.json（tries の無い item）を読める', T, async () => {
  const o = await run(['err500', '--segs=1', '--after-retry', '--recover-again=3', '--delete-pages-then-recover']);
  // 締めが書く待ち行列は前の版と同じ形（item に tries が無い）。1 回目の会議の後のやり直しで tries 1、引き直しで 2
  assert.deepStrictEqual(o.queueAfterRetry.map((q) => q.items.map((it) => ({ id: it.id, tries: it.tries, held: it.held }))), [[{ id: 's1', tries: 1, held: undefined }]]);
  const t1 = o.again[0];
  assert.deepStrictEqual(queueOf(o.again[0]), [[{ id: 's1', tries: 2, held: undefined }]]);
  assert.match(t1.pages[0].segments[0].text, /^（この区間の認識に失敗: 文字起こしエンジンエラー \(500\): boom）$/);
  // 3 回目で held。文に「音声は残してあります」。WAV は残る
  const t3 = o.again[1];
  assert.deepStrictEqual(queueOf(t3), [[{ id: 's1', tries: 3, held: true }]]);
  assert.strictEqual(t3.pages[0].segments[0].text, '（この区間の認識に失敗: 文字起こしエンジンエラー (500): boom。音声は残してあります）');
  assert.strictEqual(t3.wavs.length, 1, JSON.stringify(t3));
  // 次の引き金ではやり直さない（エンジンへ送らない）。WAV も待ち行列も残る
  const t4 = o.again[2];
  assert.strictEqual(t4.requests, 0, JSON.stringify(t4));
  assert.deepStrictEqual([queueOf(t4), t4.wavs.length], [[[{ id: 's1', tries: 3, held: true }]], 1]);
  // ページを消すと、次の引き金で WAV と待ち行列が消える
  assert.deepStrictEqual([o.afterDelete.queue, o.afterDelete.wavs], [[], []], JSON.stringify(o.afterDelete));
});

test('S1: ［文字起こしを後回しにして要約］は待ちの区間を kept にし、WAV を消さない。要約は今ある分で作る。会議の後に残した区間が文字になったら『［要約を生成］で議事録を作り直せます』の知らせ（自動で作り直さない）', T, async () => {
  // 0.10.0 LS-2（D59）で意図して直した: 要約は Claude Code だけなので、偽の claude で作る（chats は作った要約の数）
  const o = await run(['slow', '--segs=3', '--sum', '--claude=ok', '--skip-at-stop', '--wait-queue-empty'], { scale: '0.02' });
  assert.deepStrictEqual(o.skip, { ok: true, skipped: 2 });
  // 後回しにした区間は「文字起こし待ち」の文で WAV を残す（打ち切りの文にしない）
  assert.deepStrictEqual(o.skippedSegs.map((s) => [s.text, s.wav]), [['（文字起こし待ち: 音声は残してあります）', true], ['（文字起こし待ち: 音声は残してあります）', true]], JSON.stringify(o.skippedSegs));
  // 要約は待たずに、今ある分で 1 回作った
  assert.ok(o.afterQueue.chats >= 1, JSON.stringify(o.afterQueue));
  const chatsAtSummary = o.chatsAtFinalize;
  // 残した区間は会議の後に文字になり、知らせは「［要約を生成］で作り直せます」。要約は作り直さない
  assert.ok(o.afterQueue.pages[0].segments.every((s) => !s.failed), JSON.stringify(o.afterQueue.pages));
  assert.ok(o.afterQueue.notices.some((n) => SKIP_DONE.test(n)), JSON.stringify(o.afterQueue.notices));
  assert.strictEqual(o.afterQueue.chats, chatsAtSummary, '残した区間の後に要約を自動で作り直した');
  assert.deepStrictEqual(o.afterQueue.wavs, []);
});

test('kept-late の区間がある会議は、締めで要約を待たせ（S3）、待ち行列が済んだら自動で要約する（0.9.0 の R1 と同じ）', T, async () => {
  // 0.10.0 LS-2（D59）で意図して直した: 要約は Claude Code だけなので、偽の claude で作る（chats は作った要約の数）
  const o = await run(['hang-first', '--segs=1', '--sum', '--claude=ok', '--wait-queue-empty']);
  assert.strictEqual(o.chatsAtFinalize, 0, '時間切れの区間を待たずに要約した');
  assert.strictEqual(o.summaryAtFinalize, '文字起こし待ちの音声があります。文字起こしが済むと、自動で要約を作ります。');
  assert.ok(o.afterQueue.notices.some((n) => /^残しておいた音声を文字起こししました（1\/1 区間）。続けて要約を作ります。$/.test(n)), JSON.stringify(o.afterQueue.notices));
  assert.strictEqual(o.afterQueue.chats, 1, JSON.stringify(o.afterQueue));
});

test('S12: 録音中は会議の後の PC の文字起こしを止め（クラウドで送れる区間は続ける）、録音が終わったら続ける', T, async () => {
  const o = await run(['slow', '--extra-queue=localonly3', '--segs=1', '--wait-queue-empty'], { scale: '0.02' });
  assert.ok(o.afterQueue.log.some((l) => /^復旧の文字起こしを止めました（理由: busy）。残りの [1-3] 区間の音声と待ち行列は残します$/.test(l)), o.afterQueue.log.join('\n'));
  // 録音を止めた後に続きを文字にした（前の会議のページの区間が全部文字になり、待ち行列は無い）
  assert.ok(o.afterQueue.pages.every((p) => p.segments.every((s) => !s.failed)), JSON.stringify(o.afterQueue.pages));
  assert.strictEqual(o.afterQueue.pages.length, 2);
  // 止めた後に送った復旧の区間は、会議の区間より後（録音中は会議の後の PC の文字起こしを送らない）
  const busy = o.afterQueue.log.findIndex((l) => /理由: busy/.test(l));
  const meetingSeg = o.afterQueue.log.findIndex((l) => /^文字起こしの経路: 区間 s1 → local/.test(l));
  const recoverAfter = o.afterQueue.log.findIndex((l, i) => i > busy && /^文字起こしの経路: 復旧 s\d → local/.test(l));
  assert.ok(busy >= 0 && meetingSeg >= 0 && recoverAfter > meetingSeg, o.afterQueue.log.join('\n'));
});

// ---------------------------------------------------------------- S-4（決めたこと 7〜13）: 遅い PC では会議中に PC で文字起こししない
// 偽の whisper の delay は区間の答えを FAKE_DELAY_MS 遅らせる。速さの処理の時間は待ち時間と同じ尺度（NATSU_TEST_LOCAL_TIME_SCALE）で割って数える
// （0.01 なら 400 ミリ秒が 40 秒。15 秒の区間は 30 秒の床で 1.33 倍）
const SLOW_SEG = '（文字起こし待ち: 会議の後で文字起こしします）';
const SLOW_NOTICE = 'この PC の文字起こしが録音に追いつかないため、会議中は音声を残し、会議が終わってから文字起こしします（クラウドで文字起こしできるときはクラウドで続けます）。';
// 0.9.4 O-1 で意図して直した: 「（外には送りません）」を外した
const LATE_BANNER_OFFLINE = 'オフラインモードです。この PC の文字起こしが録音に追いつかないため、音声を残しています。会議が終わったら PC の中で文字起こしします。';
const slowEnv = { FAKE_DELAY_MS: '400' };
// 0.10.0 の CI の直し（CI run 39893973701 の test (windows-latest)）: 「2 区間目の後から」（理由 two）を見るテストは、1 区間の速さが over（1.0）を越えて
// big（1.5 = 30 秒の床で 45 秒）を越えない所に置く。400 ミリ秒（40 秒・1.33 倍）では big まで 50 ミリ秒しか無く、混んだ Windows の機械で要求の外の
// 時間が 60 ミリ秒ほど足されて 46 秒（1.53 倍・理由 big）になり、1 区間目で遅いに倒れた（テストの台の時間の具合。製品のコードは変えない）。
// 330 ミリ秒（33 秒・1.1 倍）なら over を越え、big まで 120 ミリ秒の余りがある
const twoEnv = { FAKE_DELAY_MS: '330' };
const infer = (o) => (o.requests || []).filter((l) => !/probe=true/.test(l)).length;
const slowLine = /^文字起こしの速さ: この PC は録音に追いつかないため、会議中は音声を残します（\d+\.\d\d 倍・理由 (two|big|late|backlog|saved)）$/;
const textOf = (n) => (typeof n === 'string' ? n : n && n.text);

test('S4・S5: 偽のエンジンが 15 秒の区間に 40 秒（尺度で縮める）かかる会議で、2 区間目の後から PC に落ちる区間は送らずに kept（文『（文字起こし待ち: 会議の後で文字起こしします）』・帯 kept-late・知らせ1回・engine.log の1行）。中継が答える区間はクラウドで文字になる', T, async () => {
  const o = await run(['delay', '--relay-seq=nncnn', '--seg-ms=15000'], { scale: '0.01', env: twoEnv });
  // 会議の中で PC へ送ったのは 2 区間だけ（会議の後の文字起こしは議事録を写す前に進むことがあるので、記録の行で区切って数える）
  const live = o.engineLog.slice(0, Math.max(0, o.engineLog.findIndex((l) => /^文字起こしの経路: 復旧 /.test(l))) || o.engineLog.length);
  assert.strictEqual(live.filter((l) => l.startsWith('文字起こしの速さ: 音声 15 秒')).length, 2, `遅いと分かった後も PC へ送った: ${o.engineLog.join('\n')}`);
  for (const id of ['s4', 's5']) assert.ok(o.engineLog.some((l) => l.startsWith(`文字起こしの経路: 区間 ${id} → 遅い PC のため音声を残した（`)), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('文字起こしの経路: 区間 s3 → cloud(relay) 0.0 秒') || o.engineLog.some((l) => /^文字起こしの経路: 区間 s3 → cloud\(relay\)/.test(l)), '中継が答える区間をクラウドで送っていない');
  const at = o.sttAt['kept-late'];
  assert.ok(at && at.some((x) => x.id === 's4' && x.text === SLOW_SEG && x.failed && x.wav), JSON.stringify(o.sttAt));
  assert.ok(o.pages[0].route.stt.cloud >= 1, JSON.stringify(o.pages[0].route));
  assert.strictEqual(o.notices.filter((n) => textOf(n) === SLOW_NOTICE).length, 1, JSON.stringify(o.notices));
  const lines = o.engineLog.filter((l) => slowLine.test(l));
  assert.deepStrictEqual(lines.map((l) => slowLine.exec(l)[1]), ['two'], o.engineLog.join('\n'));
  // 会議の中では遅いのまま（クラウドで文字になった区間の後も、PC に落ちる区間は残す）。遅い区間で長い側へ替えた
  assert.ok(o.engineLog.some((l) => /^文字起こしの状態: 区切り \d+ 秒（long・理由 slow）$/.test(l)), o.engineLog.join('\n'));
});

test('S4: 速さの数は PC への要求だけ（中継に 0.8 秒かけて断られ、エンジンの起動に 1 秒かかった区間でも、処理の時間は偽のエンジンの答えの時間）', T, async () => {
  const o = await run(['delay', '--relay-seq=D', '--seg-ms=15000'], { scale: '0.01', env: { ...slowEnv, FAKE_START_MS: '1000' } });
  const sp = o.engineLog.find((l) => l.startsWith('文字起こしの速さ: 音声 15 秒'));
  assert.ok(sp, o.engineLog.join('\n'));
  const proc = Number(/処理 (\d+) 秒/.exec(sp)[1]);
  assert.ok(proc >= 35 && proc < 100, `処理の時間に中継の時間かエンジンの起動を入れた: ${sp}`);
});

test('S5: オフラインモードの会議でも遅ければ kept（帯の文はオフラインモードの形）。外へは送らない。会議の後は PC で文字起こしし、知らせに『この PC では約 N 分かかります』', T, async () => {
  const o = await run(['delay', '--relay=text', '--local-only', '--segs=4', '--seg-ms=15000', '--wait-queue-empty'], { scale: '0.01', env: slowEnv });
  assert.strictEqual(o.relayCalls.filter((p) => p !== '/health').length, 0, `外へ送った: ${o.relayCalls}`);
  const p = o.sttSeen.map((x) => x.problem).find((x) => x && x.code === 'kept-late');
  assert.ok(p, JSON.stringify(o.sttSeen));
  assert.strictEqual(p.text, LATE_BANNER_OFFLINE);
  assert.ok(o.sttAt['kept-late'].some((s) => s.text === SLOW_SEG && s.wav), JSON.stringify(o.sttAt));
  assert.ok(o.afterQueue.notices.some((n) => /^残しておいた音声（約 1 分）を文字起こししています。この PC では約 \d+ 分かかります。済むと自動で要約を作ります。$/.test(textOf(n))), JSON.stringify(o.afterQueue.notices));
  assert.ok(o.afterQueue.pages[0].segments.every((s) => !s.failed), JSON.stringify(o.afterQueue.pages));
});

test('S4: 覚え（local-pace.json）にモデルの名前と大きさで書き、次の会議は始めから遅い。モデルを替えると覚えは使わない。14 日を過ぎると会議中に試す', T, async () => {
  const pace = (model, at) => `--pace=${JSON.stringify({ schema: 1, model, rtf: 1.6, slow: true, at, from: 'live' })}`;
  const [first, saved, other, old] = await Promise.all([
    run(['delay', '--local-only', '--segs=3', '--seg-ms=15000'], { scale: '0.01', env: slowEnv }),
    // 尺度 1（縮めない）: 偽のエンジンはすぐ答えるので、混んだ機械でも遅いに数えない
    run(['text', '--local-only', '--segs=2', '--seg-ms=15000', pace('same', 'now-1')], { scale: '1' }),
    run(['text', '--local-only', '--segs=2', '--seg-ms=15000', pace({ name: 'ggml-medium-q5_0.bin', size: 539212467 }, 'now-1')], { scale: '1' }),
    run(['text', '--local-only', '--segs=2', '--seg-ms=15000', pace('same', 'now-15')], { scale: '1' }),
  ]);
  const j = JSON.parse(first.paceFile);
  assert.deepStrictEqual(Object.keys(j).sort(), ['at', 'from', 'model', 'rtf', 'schema', 'slow']);
  assert.deepStrictEqual([j.schema, j.slow, j.from, j.model.name, typeof j.model.size, j.rtf > 1], [1, true, 'live', 'ggml-fake.bin', 'number', true]);
  assert.ok(!first.paceFile.includes('/') && !first.paceFile.includes('\\\\'), '覚えにパスを書いた');
  // 会議の後の文字起こし（残した区間を PC で）は議事録を写す前に進むことがあるので、要求の数でなく会議の中の記録の行で見る
  const keptSlow = (o) => o.engineLog.filter((l) => /^文字起こしの経路: 区間 s\d+ → 遅い PC のため音声を残した/.test(l)).length;
  assert.strictEqual(keptSlow(saved), 2, `覚えが遅いのに PC へ送った: ${saved.engineLog.join('\n')}`);
  assert.ok(saved.engineLog.some((l) => /理由 saved）$/.test(l)), saved.engineLog.join('\n'));
  assert.strictEqual(keptSlow(other), 0, '別のモデルの覚えを使った');
  assert.strictEqual(keptSlow(old), 0, '14 日を過ぎた覚えを使った');
  assert.strictEqual(infer(other), 2);
  assert.strictEqual(infer(old), 2);
});

test('音声入力は遅い PC でも PC で文字起こしする', T, async () => {
  const o = await run(['text', '--dictate', `--pace=${JSON.stringify({ schema: 1, model: 'same', rtf: 3, slow: true, at: 'now-1', from: 'live' })}`]);
  assert.strictEqual(o.history.length, 1, JSON.stringify(o.history));
  assert.ok(!o.history[0].wait && /本日の議題/.test(o.history[0].text), JSON.stringify(o.history));
});

// ---------------------------------------------------------------- S-5（決めたこと 29〜32）: クラウドの区切りを伸ばさない・中継の失敗が続いたら間を空ける
const liveMs = (o) => o.overlaySent.filter((x) => typeof x === 'number');
const sttPosts = (o) => o.relayCalls.filter((p) => p === '/v1/audio/transcriptions').length;

test('S6: クラウドの会議で PC に落ちた区間が詰まっても（待ち 5）、録音バーへ送る区切りは 15 秒のまま（overlay:segment-ms を送らない）', T, async () => {
  const o = await run(['slow', '--relay=text', '--relay-down', '--segs=6'], { scale: '1' });
  assert.deepStrictEqual(o.overlaySent.filter((x) => x && typeof x === 'object').map((x) => x.segmentSec), [15]);
  assert.deepStrictEqual(liveMs(o), [], JSON.stringify(o.overlaySent));
  assert.ok(!o.engineLog.some((l) => /区切り \d+ 秒（short・理由 backpressure）/.test(l)), o.engineLog.join('\n'));
});

test('S6: 中継が 503 を返し続けても、区切りは short のまま（long へ替えない）', T, async () => {
  const o = await run(['text', '--relay-seq=5555']);
  assert.deepStrictEqual(liveMs(o), [], JSON.stringify(o.overlaySent));
  assert.ok(!o.engineLog.some((l) => /区切り \d+ 秒（long/.test(l)), o.engineLog.join('\n'));
});

test('PC の会議（オフラインモード）で待ちが増えると 75 → 90 秒（150 にしない）', T, async () => {
  const o = await run(['slow', '--relay=text', '--local-only', '--segs=6'], { scale: '1' });
  const l = liveMs(o);
  assert.ok(l.includes(90000), JSON.stringify(o.overlaySent));
  assert.ok(l.every((ms) => ms <= 90000), `PC の区間を 90 秒より長くした: ${JSON.stringify(l)}`);
});

test('S7: 中継の 503 が 2 回続くと、60 秒の間は中継へも /health へも送らない（偽の中継が受けた数）。その後の 1 区間で 503 なら 120 秒。中継が答えたら 0 に戻る', T, async () => {
  const o = await run(['text', '--relay-seq=55c5cc55', '--clock-seq=3:61000,5:121000']);
  const holds = o.engineLog.filter((l) => /^文字起こしの経路: 中継の失敗が続いたため、\d+ 秒の間は中継へ送りません（server）$/.test(l)).map((l) => Number(/(\d+) 秒/.exec(l)[1]));
  assert.deepStrictEqual(holds, [60, 120, 60], o.engineLog.join('\n'));
  assert.strictEqual(sttPosts(o), 6, `間を空けている間に中継へ送った: ${o.relayCalls}`);
  for (const id of ['s3', 's5']) assert.ok(o.engineLog.includes(`文字起こしの経路: 区間 ${id} → local（理由: relay-hold）`), o.engineLog.join('\n'));
  // 間を空けている間（s3・s5）は /health も聞かない: 中継への道の並びで、s2 の後 s4 の前に /health が無い
  const seq = o.relayCalls.filter((p) => p === '/health' || p === '/v1/audio/transcriptions');
  const posts = seq.map((p, i) => (p === '/v1/audio/transcriptions' ? i : -1)).filter((i) => i >= 0);
  // （間が明けた次の区間の前に 1 回だけ聞く。間を空けていなければ s3・s5 の前にも聞く）
  assert.ok(seq.slice(posts[1] + 1, posts[2]).filter((p) => p === '/health').length <= 1, JSON.stringify(seq));
  assert.ok(seq.slice(posts[2] + 1, posts[3]).filter((p) => p === '/health').length <= 1, JSON.stringify(seq));
  assert.ok(o.pages[0].segments.every((s) => !s.failed), JSON.stringify(o.pages[0].segments));
});

test('S5: 遅い PC で中継の間が空いている間の区間は kept', T, async () => {
  const o = await run(['text', '--relay-seq=55c', `--pace=${JSON.stringify({ schema: 1, model: 'same', rtf: 1.6, slow: true, at: 'now-1', from: 'live' })}`], { scale: '1' });
  assert.ok(o.engineLog.includes('文字起こしの経路: 区間 s3 → 遅い PC のため音声を残した（relay-hold）'), o.engineLog.join('\n'));
  assert.strictEqual(sttPosts(o), 2);
});

// ---------------------------------------------------------------- S-4F（3回目の問答 Q14 の直し: 持ち主の答え「PC で文字起こし」）
// 0.13.2 LN-2 で意図して変えた（持ち主の答え LA3「ログインしていればクラウドで（おすすめ）」。計画 docs/plans/2026-10-28-132.md の「意図して変えるテスト」）:
// 遅い会議で残した音声は、ログインしていて中継が使えれば会議の後にクラウドで文字起こしする（PC へは送らない）。オフラインモードの遅い会議は PC だけ
// （stage132.main の「LN-2・RF47」に分けた）
test('S-4F: 遅い会議の待ち行列は、ログインしていて中継が使えれば会議の後にクラウドで文字起こしする（偽の中継に届き、偽の PC のエンジンへは送らない）', T, async () => {
  // 覚えから始めから遅い会議。中継に届かない（n: 一時の失敗）区間は PC に送らず残し、3つ目は中継で文字になる。会議の後は中継が答える（c）
  const o = await run(['text', '--relay-seq=nnc', `--pace=${JSON.stringify({ schema: 1, model: 'same', rtf: 1.6, slow: true, at: 'now-1', from: 'live' })}`, '--wait-queue-empty'], { scale: '1' });
  for (const id of ['s1', 's2']) assert.ok(o.engineLog.some((l) => l.startsWith(`文字起こしの経路: 区間 ${id} → 遅い PC のため音声を残した（`)), o.engineLog.join('\n'));
  const after = o.afterQueue.log || [];
  for (const id of ['s1', 's2']) {
    assert.ok(after.some((l) => new RegExp(`^文字起こしの経路: 復旧 ${id} → cloud`).test(l)), `会議の後にクラウドで文字起こししていない: ${after.join('\n')}`);
    assert.ok(!after.some((l) => new RegExp(`^文字起こしの経路: 復旧 ${id} → local`).test(l)), `会議の後に PC へ送った: ${after.join('\n')}`);
  }
  assert.ok(o.afterQueue.pages[0].segments.every((s) => !s.failed), JSON.stringify(o.afterQueue.pages));
});
