/*
 * stage181.main.test.js — 0.18.1（計画 docs/plans/2026-11-25-181.md）の main の場面。偽の Electron の上で main.js を本当に動かして確かめる
 * （helpers/mainrun.js。論理 CPU の数は --cpus、優先度は out.prioCalls と --prio=fail）。
 *  PF-1: 起こしたエンジンのスレッドの数（既定と前の版の既定の移し。メモリの中だけ）・優先度（通常より低い。失敗しても起こす）
 *  PF-2: PC の中で文字起こしする会議の区切り（既定 30 秒・前の版の 75 秒の移し。メモリの中だけ）
 *  PF-3: 「遅い」の覚え（local-pace.json）の印。印の無い・違う覚えは会議の始めにも待ち時間にも使わない。書く覚えに印を書く
 *  PF-4: 会議の後の文字起こしの時間切れ（回数に数え・待ち行列の後ろへ回し・その回は止める・3 回で保留）・会議の後の待ち時間（rtf が空なら 3）・
 *        録音を始めたら会議の後の頼みを切る（数えない）・前の NaTsu が残したエンジン（engine-proc.json と tasklist の名前の照らし）
 *  0.18.1 点検の直し（計画の CR22・CR23）: 時間切れが続く区間が保留になった後の要約・送る前に切った頼み（エンジンを止めない）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args, { scale = '0.005', env = {}, limit = 20000 } = {}) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], {
    env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001', NATSU_TEST_LOCAL_TIME_SCALE: scale, ...env },
    maxBuffer: 1 << 24, timeout: limit,
  }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});
const T = { timeout: sceneTimeout(20000) };
const whisperSpawns = (o) => (o.spawns || []).filter((s) => /fake-whisper\.js$/.test(s.cmd) || /whisper-server/.test(s.cmd));
const threadsOf = (s) => { const i = s.args.indexOf('-t'); return i >= 0 ? s.args[i + 1] : null; };
const add = (o) => `--settings-add=${JSON.stringify(o)}`;
const brief = (o) => JSON.stringify({ spawns: o.spawns, prioCalls: o.prioCalls, engineLog: o.engineLog }, null, 1);

// ---------------------------------------------------------------- PF-1（決めたこと 1〜3）
test('PF-1 前の版の設定: 前の既定のままのスレッドの数（論理 CPU 12 の 10・6、論理 CPU 4 の 4）は新しい既定（4・2）で起こす。選んだ数（8）・無いとき（既定 4）はそのまま。settings.json は書き換えない（メモリの中だけ）', T, async () => {
  const [old10, old6, chose8, none12, old4] = await Promise.all([
    run(['text', '--segs=1', '--cpus=12', add({ localThreads: 10 })]),
    run(['text', '--segs=1', '--cpus=12', add({ localThreads: 6 })]),
    run(['text', '--segs=1', '--cpus=12', add({ localThreads: 8 })]),
    run(['text', '--segs=1', '--cpus=12']),
    run(['text', '--segs=1', '--cpus=4', add({ localThreads: 4 })]),
  ]);
  const t = (o) => whisperSpawns(o).map(threadsOf);
  assert.ok(whisperSpawns(old10).length >= 1, brief(old10));
  assert.deepStrictEqual(t(old10).filter((x) => x !== '4'), [], brief(old10));
  assert.deepStrictEqual(t(old6).filter((x) => x !== '4'), [], brief(old6));
  assert.ok(t(chose8).length >= 1 && t(chose8).every((x) => x === '8'), brief(chose8));
  assert.ok(t(none12).length >= 1 && t(none12).every((x) => x === '4'), brief(none12));
  assert.ok(t(old4).length >= 1 && t(old4).every((x) => x === '2'), brief(old4));
  // 書き戻さない・知らせない（［設定］を保存すると新しい数が書かれる）
  assert.strictEqual(old10.savedSettings.localThreads, 10);
  assert.strictEqual(old4.savedSettings.localThreads, 4);
  assert.ok(!old10.engineLog.some((l) => /スレッド/.test(l)), old10.engineLog.join('\n'));
});

test('PF-1 起こしたエンジンの優先度: 起こした whisper の番号で os.setPriority(PRIORITY_BELOW_NORMAL) を呼ぶ。断られても（Linux の CI の権限）起こすのは止めず、engine.log に1行だけ', T, async () => {
  const [ok, fail] = await Promise.all([
    run(['text', '--segs=1']),
    run(['text', '--segs=1', '--prio=fail']),
  ]);
  const n = whisperSpawns(ok).length;
  assert.ok(n >= 1, brief(ok));
  assert.strictEqual(ok.prioCalls.length, n, brief(ok));
  for (const c of ok.prioCalls) assert.ok(c.kid === true && c.priority === os.constants.priority.PRIORITY_BELOW_NORMAL, brief(ok));
  assert.ok(!ok.engineLog.some((l) => /優先度/.test(l)), ok.engineLog.join('\n'));
  // 断られた: 起こして文字にした。記録は起こした回数だけ（文は1つの形）
  assert.ok(fail.prioCalls.length >= 1, brief(fail));
  assert.ok(fail.pages[0].segments.length === 1 && !fail.pages[0].segments[0].failed, JSON.stringify(fail.pages));
  const lines = fail.engineLog.filter((l) => /優先度/.test(l));
  assert.strictEqual(lines.length, fail.prioCalls.length, fail.engineLog.join('\n'));
  for (const l of lines) assert.strictEqual(l, '文字起こしエンジン: 優先度を下げられませんでした（EACCES）。通常の優先度のまま動かします');
});

// ---------------------------------------------------------------- PF-2（決めたこと 4）
const starts = (o) => o.overlaySent.filter((x) => x && typeof x === 'object').map((x) => x.segmentSec);
test('PF-2 前の版の間隔: settings.json の 75 秒（前の版の既定）は 30 秒で始める（録音バーへの始めの segmentSec・記録の行）。選んだ 60 秒・無いとき（既定 30 秒）。settings.json は書き換えない', T, async () => {
  const [old75, chose60, none] = await Promise.all([
    run(['text', '--relay=text', '--offline', '--segs=1', add({ segmentSec: 75 })]),
    run(['text', '--relay=text', '--offline', '--segs=1', add({ segmentSec: 60 })]),
    run(['text', '--relay=text', '--offline', '--segs=1']),
  ]);
  assert.deepStrictEqual(starts(old75), [30], JSON.stringify(old75.overlaySent));
  assert.ok(old75.engineLog.includes('文字起こしの状態: 区切り 30 秒（long・理由 start）'), old75.engineLog.join('\n'));
  assert.strictEqual(old75.savedSettings.segmentSec, 75);
  assert.deepStrictEqual(starts(chose60), [60], JSON.stringify(chose60.overlaySent));
  assert.ok(chose60.engineLog.includes('文字起こしの状態: 区切り 60 秒（long・理由 start）'), chose60.engineLog.join('\n'));
  assert.deepStrictEqual(starts(none), [30], JSON.stringify(none.overlaySent));
  assert.ok(none.engineLog.includes('文字起こしの状態: 区切り 30 秒（long・理由 start）'), none.engineLog.join('\n'));
});

// ---------------------------------------------------------------- PF-3（決めたこと 6）
const keptSlow = (o) => o.engineLog.filter((l) => /^文字起こしの経路: 区間 s\d+ → 遅い PC のため音声を残した/.test(l)).length;
const paceArg = (o) => `--pace=${JSON.stringify({ schema: 1, model: 'same', rtf: 1.7, slow: true, at: 'now-1', from: 'live', ...o })}`;
test('PF-3 前の版の覚え: 0.18.0 までの「遅い」の覚え（印が無い）・スレッドの数が違う覚えは使わない（会議は PC へ送る・待ち時間は rtf 1）。印が同じ覚えは使う。会議の後に書く覚えには印がある', T, async () => {
  const [old, threads, same, oldLate] = await Promise.all([
    run(['text', '--local-only', '--segs=2', '--seg-ms=15000', '--cpus=12', paceArg({})], { scale: '1' }),
    run(['text', '--local-only', '--segs=2', '--seg-ms=15000', '--cpus=12', paceArg({ stamp: { set: 'manual', threads: 10, prio: 2 } })], { scale: '1' }),
    run(['text', '--local-only', '--segs=2', '--seg-ms=15000', '--cpus=12', paceArg({ stamp: 'same' })], { scale: '1' }),
    run(['hang-first', '--segs=1', '--seg-ms=120000', '--cpus=12', paceArg({ slow: false })], { scale: '0.002' }),
  ]);
  for (const o of [old, threads]) {
    assert.strictEqual(keptSlow(o), 0, `印の違う覚えで遅いにした: ${o.engineLog.join('\n')}`);
    assert.ok(!o.engineLog.some((l) => /理由 saved）$/.test(l)), o.engineLog.join('\n'));
  }
  assert.strictEqual(keptSlow(same), 2, same.engineLog.join('\n'));
  assert.ok(same.engineLog.some((l) => /理由 saved）$/.test(l)), same.engineLog.join('\n'));
  // 印の無い覚えの rtf 1.7 は待ち時間にも使わない（120 秒の区間で 300 秒。使えば 468 秒）
  assert.ok(oldLate.engineLog.includes('手元の文字起こしの時間切れ: s1（音声 120 秒・待ち 300 秒）。エンジンを起こし直します'), oldLate.engineLog.join('\n'));
  // 書いた覚え: 印（手のパスの組・起こしたスレッドの数・優先度の版 2）。パスは書かない
  const j = JSON.parse(old.paceFile);
  assert.deepStrictEqual(j.stamp, { set: 'manual', threads: 4, prio: 2 });
  assert.deepStrictEqual(Object.keys(j).sort(), ['at', 'from', 'model', 'rtf', 'schema', 'slow', 'stamp']);
  assert.ok(!old.paceFile.includes('/') && !old.paceFile.includes('\\\\'), '覚えにパスを書いた');
});

// ---------------------------------------------------------------- PF-4（決めたこと 7・8）
const queueOf = (x) => x.map((q) => q.items.map((it) => ({ id: it.id, tries: it.tries, held: it.held })));
const LATE_SEG = '（文字起こし待ち: PC の文字起こしが間に合わなかったので、後で文字起こしします）';
const lateLines = (log) => log.filter((l) => l.startsWith('手元の文字起こしの時間切れ'));
test('PF-4 時間切れの区間: 会議の後の時間切れは回数に数え（recovery.json に残る）、3 回で保留（音声を残し「音声は残してあります」の文）。保留の区間は次の引き金で試さない', T, async () => {
  const o = await run(['hang-first', '--segs=1', '--after-retry', '--recover-again=3'], { env: { FAKE_HANG_N: '4' } });
  assert.deepStrictEqual(queueOf(o.queueAfterRetry), [[{ id: 's1', tries: 1, held: undefined }]], JSON.stringify(o.afterRetry.engineLog));
  assert.ok(o.afterRetry.engineLog.includes('復旧の文字起こし: 時間切れの区間 s1 を待ち行列の後ろへ回しました（1 回目）'), o.afterRetry.engineLog.join('\n'));
  assert.ok(o.afterRetry.engineLog.includes('復旧の文字起こしを止めました（理由: late）。残りの 1 区間の音声と待ち行列は残します'), o.afterRetry.engineLog.join('\n'));
  assert.deepStrictEqual(o.afterRetry.segments, [{ text: LATE_SEG, failed: true }]);
  assert.deepStrictEqual(queueOf(o.again[0].queue), [[{ id: 's1', tries: 2, held: undefined }]]);
  const t3 = o.again[1];
  assert.deepStrictEqual(queueOf(t3.queue), [[{ id: 's1', tries: 3, held: true }]], JSON.stringify(t3.log));
  assert.strictEqual(t3.pages[0].segments[0].text, '（この区間の認識に失敗: PC の文字起こしが時間内に終わりませんでした。音声は残してあります）');
  assert.ok(t3.log.includes('復旧の文字起こし: 時間切れが 3 回の区間 s1 は、自動ではやり直さずに音声を残します'), t3.log.join('\n'));
  assert.strictEqual(t3.wavs.length, 1);
  // 次の引き金ではエンジンへ送らない（F256: 保留の区間は試さない）。WAV も待ち行列も残る
  const t4 = o.again[2];
  assert.strictEqual(t4.requests, 0, JSON.stringify(t4));
  assert.deepStrictEqual([queueOf(t4.queue), t4.wavs.length], [[[{ id: 's1', tries: 3, held: true }]], 1]);
});

test('PF-4 ほかの区間が進む: 会議の後の時間切れの区間は待ち行列の後ろへ回し、その回は止める（時間切れは1回まで）。次の引き金はほかの区間から進み、ほかの区間は文字になる', T, async () => {
  // 会議の s1（3 秒）が時間切れ（遅いになり s2（2 秒）は残す）→ 会議の後: s1 がまた時間切れ → 後ろへ → 次の引き金: s2 が文字になり、s1 はまた時間切れ（2 回目）。
  // 偽の whisper は 3 秒の WAV（16kHz・16 ビットで 96000 バイト）の要求だけを数えて答えない
  const o = await run(['hang-first', '--segs=2', '--after-retry', '--recover-again=1'], { env: { FAKE_HANG_N: '3', FAKE_HANG_MIN_BYTES: '90000' } });
  assert.deepStrictEqual(queueOf(o.queueAfterRetry), [[{ id: 's2', tries: undefined, held: undefined }, { id: 's1', tries: 1, held: undefined }]], o.afterRetry.engineLog.join('\n'));
  // その回は s1 の時間切れで止めた（s2 を送っていない: 会議の後の時間切れは1つ・その後の要求は無い）
  assert.strictEqual(lateLines(o.afterRetry.engineLog).length, 2, o.afterRetry.engineLog.join('\n'));
  const a = o.again[0];
  assert.deepStrictEqual(queueOf(a.queue), [[{ id: 's1', tries: 2, held: undefined }]], a.log.join('\n'));
  const segs = a.pages[0].segments;
  assert.ok(segs.length === 2 && segs[0].failed && !segs[1].failed && segs[1].text.startsWith('本日の議題は進捗の確認です'), JSON.stringify(segs));
});

// 0.18.1 点検の直し（計画 docs/plans/2026-11-25-181.md の CR22・決めたこと 7 の理由「要約まで進む」）: 時間切れの続く区間が 3 回目で保留になった回は止めずに最後まで進み、
// 要約を待たせた会議（「文字起こし待ちの音声があります。…」）は、残りが保留の区間だけで文字のある区間があれば、その回で文字になった区間が無くても要約を作る（1 回だけ）
const WAIT_SUMMARY = '文字起こし待ちの音声があります。文字起こしが済むと、自動で要約を作ります。';
const startsOf = (o) => o.again.map((a) => a.summaryStarts);
test('PF-4 時間切れが続く区間の後の要約: s1 がいつも時間切れの会議（s2 は文字になる）。s1 が 3 回目で保留になった回で、文字になった区間が無くても要約を作る（1 回だけ）', T, async () => {
  const o = await run(['hang-first', '--segs=2', '--after-retry', '--recover-again=4'], { env: { FAKE_HANG_N: '99', FAKE_HANG_MIN_BYTES: '90000' } });
  const logs = o.again.map((a) => a.log.join('\n')).join('\n---\n');
  // 1 回目の引き直し: s2 が文字になり、s1 は 2 回目の時間切れ（後ろへ回してその回は止める: 要約はまだ）
  assert.deepStrictEqual(queueOf(o.again[0].queue), [[{ id: 's1', tries: 2, held: undefined }]], logs);
  assert.strictEqual(o.again[0].summaryStarts, 0, logs);
  // 2 回目の引き直し: s1 は 3 回目の時間切れで保留（止めずに最後まで進む）→ 要約を作る
  const t3 = o.again[1];
  assert.deepStrictEqual(queueOf(t3.queue), [[{ id: 's1', tries: 3, held: true }]], logs);
  assert.ok(t3.log.includes('復旧の文字起こし: 時間切れが 3 回の区間 s1 は、自動ではやり直さずに音声を残します'), logs);
  assert.ok(!t3.log.includes('復旧の文字起こしを止めました（理由: late）。残りの 1 区間の音声と待ち行列は残します'), logs);
  assert.deepStrictEqual(startsOf(o), [0, 1, 0, 0], logs);
  const last = o.again[o.again.length - 1];
  assert.ok(last.pages[0].summaryError !== WAIT_SUMMARY, JSON.stringify(last.pages));
  // 保留の区間は音声を残し、もう送らない
  assert.deepStrictEqual([last.requests, last.wavs.length], [0, 1], logs);
});

test('PF-4 時間切れが続く区間の後の要約（文字が無い会議）: 区間が s1 だけでいつも時間切れなら、保留になっても要約は作らない（要約の欄は文字起こし待ちのまま）', T, async () => {
  const o = await run(['hang-first', '--segs=1', '--after-retry', '--recover-again=3'], { env: { FAKE_HANG_N: '99' } });
  const logs = o.again.map((a) => a.log.join('\n')).join('\n---\n');
  assert.deepStrictEqual(queueOf(o.again[1].queue), [[{ id: 's1', tries: 3, held: true }]], logs);
  assert.deepStrictEqual(startsOf(o), [0, 0, 0], logs);
  assert.strictEqual(o.again[2].pages[0].summaryError, WAIT_SUMMARY, JSON.stringify(o.again[2].pages));
});

test('PF-4 会議の後の待ち時間: 会議の後の頼みは、覚えの rtf が空なら 3 とみる（120 秒の区間で 780 秒。会議中は今どおり 300 秒）', T, async () => {
  const o = await run(['hang-first', '--segs=1', '--seg-ms=120000', '--after-retry'], { scale: '0.002', env: { FAKE_HANG_N: '2' } });
  assert.deepStrictEqual(lateLines(o.afterRetry.engineLog), [
    '手元の文字起こしの時間切れ: s1（音声 120 秒・待ち 300 秒）。エンジンを起こし直します',
    '手元の文字起こしの時間切れ: s1（音声 120 秒・待ち 780 秒）。エンジンを起こし直します',
  ], o.afterRetry.engineLog.join('\n'));
});

test('PF-4 録音を始めたとき: 会議の後の文字起こしの頼みがエンジンの中にある間に録音を始めると、その頼みを切ってエンジンを起こし直す。切った区間は時間切れに数えず（F257）待ち行列に残し、録音が終わったら文字にする', T, async () => {
  const o = await run(['hang-first', '--extra-queue=localonly3', '--segs=1', '--start-when-recovering', '--wait-queue-empty'], { scale: '0.02', env: { FAKE_HANG_N: '1' } });
  const log = o.afterQueue.log;
  const cut = log.indexOf('手元の文字起こしを切りました: s1（音声 3 秒）。録音を始めたため、エンジンを起こし直します');
  assert.ok(cut >= 0, log.join('\n'));
  assert.ok(log.includes('復旧の文字起こしを止めました（理由: busy）。残りの 3 区間の音声と待ち行列は残します'), log.join('\n'));
  assert.deepStrictEqual(lateLines(log), [], log.join('\n'));
  // 切った後にエンジンを起こし直し、会議の区間を文字にした。録音を止めた後に前の会議の3区間も文字にした
  assert.ok(whisperSpawns(o).length >= 2, brief(o));
  assert.ok(o.afterQueue.pages.length === 2 && o.afterQueue.pages.every((p) => p.segments.length > 0 && p.segments.every((x) => !x.failed)), JSON.stringify(o.afterQueue.pages));
});

// 0.18.1 点検の直し（計画 docs/plans/2026-11-25-181.md の CR23）: 会議の後の頼みがエンジンの起動を待つ間に録音を始めた（頼みはまだ送っていない）。
// 送っていない頼みは whisper-server の中に無いので、エンジンを止めずに（起こしたばかりのエンジンをそのまま会議に使う）、今の録音中の止めと同じ形で待ち行列に残す。
// 場面: s1・s2 がどちらも時間切れの会議（偽の whisper は 2 秒以上の WAV に答えない）。4 回目の引き直しで s1 が 3 回目の時間切れで保留になり（CR22: 止めずに進む）、
// s2 のためにエンジンを起こし直している間（偽の whisper の起動を 2.5 秒遅らせる）に録音を始める
test('PF-4 送る前に切った頼み: 会議の後の頼みがエンジンの起動を待つ間に録音を始めると、エンジンを止めず「切りました」も書かない。区間は数えずに待ち行列に残す', { timeout: sceneTimeout(60000) }, async () => {
  const o = await run(['hang-first', '--segs=2', '--after-retry', '--recover-again=4', '--start-in-again=3'], { env: { FAKE_HANG_N: '99', FAKE_HANG_MIN_BYTES: '60000' }, limit: 60000 });
  const c = o.cutCold;
  assert.ok(c, JSON.stringify(o.again.map((a) => a.log)));
  const after = c.log.slice(c.log.findIndex((l) => /^復旧の文字起こし: 時間切れが 3 回の区間 s1 は/.test(l)));
  assert.ok(after.length > 0 && after.includes('復旧の文字起こしを止めました（理由: busy）。残りの 2 区間の音声と待ち行列は残します'), c.log.join('\n'));
  assert.ok(!after.some((l) => l.startsWith('手元の文字起こしを切りました')), c.log.join('\n'));
  assert.ok(!after.some((l) => l.startsWith('文字起こしエンジンが終了しました')), c.log.join('\n'));
  assert.deepStrictEqual(lateLines(after), [], c.log.join('\n'));
  // 録音を始めた後にエンジンを起こしていない（起こしたばかりのエンジンを使う）。切った s2 は数えない（2 回のまま）。s1 は保留
  assert.strictEqual(c.spawnsAfter, c.spawnsBefore, c.log.join('\n'));
  assert.deepStrictEqual(queueOf(c.queue), [[{ id: 's1', tries: 3, held: true }, { id: 's2', tries: 2, held: undefined }]], c.log.join('\n'));
});

test('PF-4 残ったエンジン: 起動のときポートが塞がっていて、engine-proc.json の番号のプロセスが今も同じ名前（tasklist）なら止め、ポートが空いてから起こす。起こしたエンジンの番号を engine-proc.json に書く', T, async () => {
  const o = await run(['text', '--segs=1', '--orphan=same']);
  assert.strictEqual(o.orphanAlive, false, brief(o));
  assert.ok(o.engineLog.some((l) => /^文字起こしエンジン: 前の NaTsu が残したエンジン（fake-whisper\.js・番号 \d+）を止めました$/.test(l)), o.engineLog.join('\n'));
  assert.ok(!o.engineLog.some((l) => /他のプロセスが使用中/.test(l)), o.engineLog.join('\n'));
  assert.ok(o.tasklistCalls.length >= 1 && o.tasklistCalls.every((c) => c.args.length === 5 && c.args[0] === '/FI' && /^PID eq \d+$/.test(c.args[1]) && c.args.slice(2).join(' ') === '/NH /FO CSV'), JSON.stringify(o.tasklistCalls));
  assert.ok(o.tasklistCalls.every((c) => c.opts && c.opts.windowsHide === true && !c.opts.shell), JSON.stringify(o.tasklistCalls));
  assert.ok(o.pages[0].segments.length === 1 && !o.pages[0].segments[0].failed, JSON.stringify(o.pages));
  // 今のエンジンの記録（番号は起こした偽の whisper のもの・名前だけでパスは書かない）
  const rec = JSON.parse(o.engineProcFile);
  assert.deepStrictEqual(Object.keys(rec).sort(), ['exe', 'pid', 'schema']);
  assert.ok(rec.exe === 'fake-whisper.js' && o.prioCalls.some((c) => c.pid === rec.pid && c.kid), JSON.stringify([rec, o.prioCalls]));
});

test('PF-4 ほかのプロセス: engine-proc.json の番号が今はほかのアプリ（tasklist の名前が違う）なら止めず、今までどおり「ポートが使われている」（F259）', T, async () => {
  const o = await run(['text', '--segs=1', '--orphan=other', '--offline']);
  assert.strictEqual(o.orphanAlive, true, brief(o));
  assert.ok(o.tasklistCalls.length >= 1, JSON.stringify(o.tasklistCalls));
  assert.ok(!o.engineLog.some((l) => /前の NaTsu が残したエンジン/.test(l)), o.engineLog.join('\n'));
  assert.ok(o.engineLog.some((l) => /^文字起こしエンジン: .*他のプロセスが使用中/.test(l)), o.engineLog.join('\n'));
  assert.strictEqual(whisperSpawns(o).length, 0, brief(o));
});
