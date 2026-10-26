/*
 * stage120.main.test.js — 0.12.0 Task SP-3a（計画 docs/plans/2026-10-22-120.md の決めたこと 122〜141・147。D66・F21〜F25・F31〜F33）
 * main が2つの流れの区間を受け、流れごとに声の切れ目で切らせ、無音の区間と頭の無音を送らず、始まりの時刻を流れの時計から決め、
 * 入口（mic・loopback）を発言に持つことを、偽の Electron の上で main.js を本当に動かして見る（helpers/mainrun.js の --two-streams。
 * 偽の録音バーが test/fixtures/streams/ の並びで区間を送り、偽の中継（--relay=tagged）は区間の末尾の番号の文を返す）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args, { env = {}, timeout = 90000 } = {}) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], {
    env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001', NATSU_TEST_LOCAL_TIME_SCALE: '0.005', ...env },
    maxBuffer: 1 << 26, timeout,
  }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});
const runExit = (args) => new Promise((resolve) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 60000 }, (err) => resolve(err ? err.code : 0));
});
const T = { timeout: sceneTimeout(120000) };
const CLOUD = (name, ...more) => ['text', '--relay=tagged', `--two-streams=${name}`, ...more];
const PC = (name, ...more) => ['text', `--two-streams=${name}`, ...more];
const PC_SLOW = (name, ...more) => ['delay', `--two-streams=${name}`, ...more];   // 偽の whisper が FAKE_DELAY_MS だけ遅れて答える
const segsOf = (o) => (o.pages[0] ? o.pages[0].segs : []);
const sttReqs = (o) => (o.stt || []).filter((r) => r.path === '/openai/v1/audio/transcriptions');
const twoLine = (o) => o.engineLog.find((l) => l.startsWith('2つの流れで録りました')) || '';
const dump = (o) => JSON.stringify({ segs: segsOf(o), sent: o.two && o.two.sent, log: o.engineLog }, null, 1).slice(0, 6000);

test('SP-3a・F23: 交互に 4 秒ずつ話す会話で、DB の発言の extra.src が mic・loopback、atMs は流れの t0 ＋頭を切った分（相手の最初の行は 3.0 秒の区間の頭の 0.7 秒を切って 3.7 秒）。送った WAV の頭の無音は 0.3 秒＋1 こま以下。要求の数は区間の数とちょうど同じ', T, async () => {
  const o = await run(CLOUD('alternate'));
  const s = segsOf(o);
  // 時刻は偽の時計のこま（100ms）で決まる。main の切れ目の数えは本当の時計の数 ms の揺れを含むので ±30ms まで
  assert.deepStrictEqual(s.map((x) => x.src), ['mic', 'loopback', 'mic', 'loopback', 'mic'], dump(o));
  [0, 3700, 7700, 11700, 15700].forEach((at, i) => assert.ok(Math.abs(s[i].atMs - at) <= 30, `${i}: ${s[i].atMs}（${at} のはず）`));
  assert.ok(s.every((x) => !x.failed && /わたしから|そちら側で/.test(x.text)), dump(o));
  const reqs = sttReqs(o);
  assert.strictEqual(reqs.length, s.length, '要求の数と区間の数が違う');
  for (const r of reqs) assert.ok(r.leadMs <= 400, `頭の無音が長い: ${r.leadMs}ms`);
  // 認識ヒントは同じ流れの直前の文（決めたこと 126）: 相手の流れの文がヒントに入らない
  assert.ok(reqs.some((r) => /わたしから/.test(r.answer) && /わたしから見積/.test(String(r.fields.prompt || ''))), `同じ流れの文がヒントに無い: ${JSON.stringify(reqs.map((r) => [r.answer, r.fields.prompt]))}`);
  for (const r of reqs) {
    const other = /^わたしから/.test(r.answer) ? 'そちら側で' : 'わたしから';
    assert.ok(!String(r.fields.prompt || '').includes(other), `ほかの流れの文がヒントに入った: ${r.answer} ← ${r.fields.prompt}`);
  }
  assert.ok(o.two.cuts >= 9, `声の切れ目で切っていない: ${o.two.cuts}`);
  assert.match(twoLine(o), /声の無い区間 6・回り込み 0）$/, o.engineLog.join('\n'));   // マイク 2・相手 4（止めたときの 0.3 秒の最後も）
  // 始めに取り込めた会議は経過に相手の声の項目を積まない
  assert.ok(!(o.pages[0].stateLog || []).some((x) => /^sys-/.test(x.s)), JSON.stringify(o.pages[0].stateLog));
});

test('SP-3a・F23: 重なりの会話（自分 0〜8 秒・相手 2〜10 秒）で両方の行が残る', T, async () => {
  const o = await run(CLOUD('overlap'));
  const s = segsOf(o);
  assert.deepStrictEqual(s.map((x) => x.src), ['mic', 'loopback'], dump(o));
  assert.ok(Math.abs(s[0].atMs) <= 30 && Math.abs(s[1].atMs - 1700) <= 30, dump(o));
});

test('SP-3a・F24: 相手が 5 分黙る間、相手の声の流れの区間は中継へ送らず音声も残さず、ページに出さない。engine.log に声の無い区間の数', T, async () => {
  const o = await run(CLOUD('partner-silent'));
  const s = segsOf(o);
  assert.ok(s.length >= 45 && s.every((x) => x.src === 'mic'), dump(o));
  assert.strictEqual(sttReqs(o).length, s.length, '相手の声の無音の区間を中継へ送った');
  const loop = o.two.sent.filter((x) => x.src === 'loopback' && x.bytes > 0);
  assert.ok(loop.length >= 90, `相手の声の流れの区間が少ない: ${loop.length}`);
  const m = /声の無い区間 (\d+)・/.exec(twoLine(o));
  assert.ok(m && Number(m[1]) >= loop.length, o.engineLog.join('\n'));
  assert.ok(!o.recoveryKept, '無音の区間の音声を残した');
});

test('SP-3a・F24: フレームでは声なしでも −38 dBFS の小さな声の区間は送る', T, async () => {
  const o = await run(CLOUD('small-voice'));
  assert.ok(sttReqs(o).length >= 2, `小さな声の区間を送らなかった: ${dump(o)}`);
  assert.strictEqual(sttReqs(o).length, segsOf(o).length);
});

test('SP-3a・F24: 回り込み（同じ時刻にマイクにも同じ文）のマイクの行を除き、engine.log に回り込みの数。割合が 0.6 未満の行と、離れた時刻の同じ文は残す（相手の行と同じ文を「直前と同じ文」で消さない）', T, async () => {
  const o = await run(CLOUD('bleed'));
  const s = segsOf(o);
  assert.deepStrictEqual(s.map((x) => [x.src, x.text]), [
    ['loopback', 'その件は来週にお願いします。'],
    ['loopback', '在庫の取り込みが遅いので実行計画を見てください。'],
    ['mic', '取り込みが遅い件、明日見ます。'],
    ['loopback', '見積書の金額を来週までに直してください。'],
    ['mic', '見積書の金額を来週までに直してください。'],
  ], dump(o));
  assert.match(twoLine(o), /回り込み 1）$/);
  assert.ok(!o.engineLog.some((l) => /その件は来週/.test(l)), '記録に文を書いた');
});

test('SP-3a・F22・F33: 相手の声の取り込みが切れた後のマイクの区間は src が無く、切れる直前の相手の区間は知らせの後に届いても loopback。経過に sys-lost・再開で戻ると sys-back が1つずつ（録音バー）、engine.log にも出る', T, async () => {
  const o = await run(CLOUD('sys-lost'));
  const s = segsOf(o);
  const sent = o.two.sent;
  const lastLoop = sent.find((x) => x.src === 'loopback' && x.last && !x.final);
  assert.ok(lastLoop, dump(o));
  // 切れる前に始めた区間・切れた後〜一時停止までのマイクの区間・再開後
  const before = s.filter((x) => x.atMs < 26000);
  assert.ok(before.some((x) => x.src === 'loopback') && before.every((x) => x.src === 'mic' || x.src === 'loopback'), dump(o));
  assert.ok(s.some((x) => x.src === 'loopback' && x.atMs >= lastLoop.t0 && x.atMs < 26000), `切れる直前の相手の区間の札が落ちた: ${dump(o)}`);
  const gap = s.filter((x) => x.atMs > 27000 && x.atMs < 44000);
  assert.ok(gap.length >= 1 && gap.every((x) => x.src === undefined), `切れた後のマイクの区間に札: ${JSON.stringify(gap)}`);
  const after = s.filter((x) => x.atMs >= 45000);
  assert.ok(after.some((x) => x.src === 'loopback') && after.some((x) => x.src === 'mic'), dump(o));
  const log = (o.pages[0].stateLog || []).filter((x) => /^sys-/.test(x.s));
  assert.deepStrictEqual(log.map((x) => [x.s, x.by]), [['sys-lost', 'overlay'], ['sys-back', 'overlay']]);
  assert.ok(o.engineLog.includes('議事録: 相手の声を取り込めていない（録音バー）') && o.engineLog.includes('議事録: 相手の声を取り込めた（録音バー）'), o.engineLog.join('\n'));
});

test('SP-3a・F22: 1本の会議（相手の声なし）はどの発言にも src が無く、切りも無い。経過に相手の声の項目を積まない', T, async () => {
  const o = await run(['text', '--relay=text', '--segs=2']);
  const s = segsOf(o);
  assert.ok(s.length === 2 && s.every((x) => x.src === undefined), JSON.stringify(s));
  assert.strictEqual(o.cutsSent, 0);
  assert.ok(!(o.pages[0].stateLog || []).some((x) => /^sys-/.test(x.s)));
});

test('SP-3a・F22: 一度も取り込めなかった会議に meta.src: loopback・mic の区間が来ても src を付けない。経過に sys-lost を1つ。声の切れ目の見張りも回さない', T, async () => {
  const o = await run(CLOUD('fake-loopback'));
  const s = segsOf(o);
  assert.ok(s.length >= 2 && s.every((x) => x.src === undefined), dump(o));
  assert.strictEqual(o.two.cuts, 0, '一度も取り込めなかった会議で声の切れ目の見張りを回した');
  assert.strictEqual(o.cutsSent, 0);
  assert.deepStrictEqual((o.pages[0].stateLog || []).filter((x) => /^sys-/.test(x.s)).map((x) => x.s), ['sys-lost']);
});

test('SP-3a・F21: 答えが文字・負・巨大・番号が無い、4つ目が壊れていても投げず、壊れた4つ目の区間は今の1本の道で文字起こしされて src が無い', T, async () => {
  const o = await run(CLOUD('bad'));
  const s = segsOf(o);
  assert.ok(s.length >= 3, dump(o));
  assert.strictEqual(s.filter((x) => x.src === undefined).length, 1, `壊れた4つ目の区間だけが札なしでない: ${dump(o)}`);
  assert.ok(s.some((x) => x.src === 'loopback') && s.some((x) => x.src === 'mic'));
  assert.ok(o.engineLog.includes('録音バーの区間の4つ目を読めませんでした（1本の区間として扱います）'), o.engineLog.join('\n'));
});

test('SP-3a・F25: 相手が 15 分話し続け、自分が黙っている会議で、無音で止める問いが出ない。両方が 11 分黙ると 0.9.1 のとおり出る', T, async () => {
  const a = await run(CLOUD('quiet-talk'));
  assert.strictEqual(a.two.quietAsked, false, '相手が話しているのに無音で止める問いが出た');
  assert.ok(segsOf(a).length >= 55 && segsOf(a).every((x) => x.src === 'loopback'));
  const b = await run(CLOUD('quiet-both'));
  assert.strictEqual(b.two.quietAsked, true, '両方が黙っても問いが出ない');
});

test('SP-3a・F32: 相づちの短い区間（音のある空）が 3 つ続いても止まりの帯が出ない。45 秒分続くと出る', T, async () => {
  const a = await run(CLOUD('stall3'));
  assert.ok(!a.engineLog.some((l) => l.startsWith('文字起こしの状態: 止まっているかもしれない')), a.engineLog.join('\n'));
  const b = await run(CLOUD('stall'));
  assert.ok(b.engineLog.some((l) => l.startsWith('文字起こしの状態: 止まっているかもしれない')), b.engineLog.join('\n'));
});

test('SP-3a・F21: 録音中のページが見えていなくても level-ask を送り、meeting:level は送らない。一時停止の間は聞かない', T, async () => {
  const o = await run(CLOUD('alternate', '--live-not-shown'));
  assert.ok(o.two.asks >= 150, `見えていないときに聞いていない: ${o.two.asks}`);
  assert.strictEqual(o.two.meetingLevel, 0);
  const p = await run(PC('pause10'));
  assert.strictEqual(p.two.asksPaused, 0, '一時停止の間に聞いた');
});

test('SP-3a・F31: 2つの流れで 10 分録って一時停止した印の atMs が約 10 分（20 分でない）', T, async () => {
  const o = await run(PC('pause10'));
  const pauses = o.pages[0].pauses;
  assert.strictEqual(pauses.length, 1, JSON.stringify(pauses));
  assert.ok(Math.abs(pauses[0].atMs - 600000) <= 20000, `一時停止の印 ${pauses[0].atMs}`);
});

test('SP-3a・F23: 1 時間の並び（録音バーが区間ごとに長さを 30ms 短く言っても t0 がある）で、最後の行の時刻のずれが 1 秒未満', T, async () => {
  const o = await run(PC('hour'), { timeout: 110000 });
  const s = segsOf(o);
  assert.ok(s.length >= 90, `区間が少ない: ${s.length}`);
  const lastSent = o.two.sent.filter((x) => x.bytes > 0 && x.src === 'mic').pop();
  const lastRow = s.filter((x) => x.src === 'mic').pop();
  assert.ok(Math.abs(lastRow.atMs - lastSent.t0) < 1000, `ずれ ${lastRow.atMs - lastSent.t0}ms`);
});

test('SP-3a・F25: PC の側（偽の whisper）へは同時に1つしか送らない', T, async () => {
  // 待ち時間は本物の尺度（遅い PC の判断に入らない）。答えを 400ms 遅らせ、門が無ければ2つの流れの要求が重なる
  const o = await run(PC_SLOW('pc2'), { env: { FAKE_DELAY_MS: '400', NATSU_TEST_LOCAL_TIME_SCALE: '1' } });
  const busy = o.requests.filter((l) => !/probe=true/.test(l)).map((l) => Number((/busy=(\d+)/.exec(l) || [])[1]));
  assert.ok(busy.length >= 2, JSON.stringify(o.requests));
  assert.ok(busy.every((n) => n === 1), `同時に送った: ${JSON.stringify(busy)}`);
});

test('SP-3a・F25: PC の側の背圧は1つの流れあたりの待ちで見る（両方の流れで待ち 6（流れごとに 3）では区間を伸ばさない）', T, async () => {
  const o = await run(PC_SLOW('pc2'), { env: { FAKE_DELAY_MS: '300', NATSU_TEST_LOCAL_TIME_SCALE: '1' } });
  assert.ok(!o.engineLog.some((l) => /理由 backpressure/.test(l)), o.engineLog.join('\n'));
  assert.strictEqual(segsOf(o).length, 4);
});

test('SP-3a・F22: オフラインモードの会議でも DB に src が入り、偽の中継が受けた要求は 0', T, async () => {
  const o = await run(PC('pc2', '--relay=tagged', '--local-only'));
  const s = segsOf(o);
  assert.ok(s.length === 4 && s.filter((x) => x.src === 'mic').length === 2 && s.filter((x) => x.src === 'loopback').length === 2, dump(o));
  assert.strictEqual(sttReqs(o).length, 0);
});

test('SP-3a・F21・F31: 落ちて下書きから戻した発言に src が残り、戻したページの長さは録った時間に近い（2つの流れの長さの和でない）', T, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-二流𠮷-'));
  try {
    assert.strictEqual(await runExit(PC('kill', `--keep-user-data=${dir}`)), 3, '場面の前提: main ごと落ちていない');
    const o = await run(['text', '--recover', `--keep-user-data=${dir}`]);
    const p = o.pages[0];
    assert.ok(p.recovered && p.segs.length >= 2, JSON.stringify(p.segs));
    assert.deepStrictEqual([...new Set(p.segs.map((x) => x.src))].sort(), ['loopback', 'mic']);
    assert.ok(p.durationSec <= 25, `戻したページの長さ ${p.durationSec}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SP-3a: 話者の無い古い DB（v1.db の写し）の会議が今どおり開け、発言に src が無い', { timeout: 5000 }, () => {
  const sqlite = require('node:sqlite');
  const core = require('../src/db/core');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-古い𠮷-'));
  const file = path.join(dir, 'natsu.db');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'db', 'v1.db'), file);
  let r = null;
  try {
    r = core.open({ sqlite, file });
    const g = core.call(r.db, { role: 'app', cmd: 'page.get', args: { id: 'pfixture000001' } }, {});
    assert.ok(g.ok && g.result.segments.length === 10);
    assert.ok(g.result.segments.every((s) => !Object.hasOwn(s, 'src') && !Object.hasOwn(s, 'parts')));
  } finally { try { if (r) r.db.close(); } catch (_) { /* 閉じ済み */ } fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- SP-3b（決めたこと 128・144。S5 (a)）: PC の側の文の頭（parts）
const rfOf = (o) => o.requests.filter((l) => !/probe=true/.test(l)).map((l) => (/rf=(\S*)/.exec(l) || [])[1]);
const MIC_PARTS = [{ ms: 0, at: 0 }, { ms: 6667, at: 13 }, { ms: 13333, at: 23 }];
test('SP-3b・F23: オフラインモードの2つの流れの会議で、偽の whisper が文の時刻を返すと区間に parts（ms・at）が付く。偽の whisper が受けた response_format は verbose_json', T, async () => {
  const o = await run(PC('pc-parts', '--relay=tagged', '--local-only'));
  const s = segsOf(o);
  const mic0 = s.find((x) => x.src === 'mic' && x.atMs === 0);
  const loop0 = s.find((x) => x.src === 'loopback' && x.atMs === 0);
  assert.ok(mic0 && loop0, dump(o));
  assert.strictEqual(mic0.text, 'はじめに見積を確認します。次に納期を決めます。最後に担当を決めます。');
  assert.deepStrictEqual(mic0.parts, MIC_PARTS);
  assert.deepStrictEqual(loop0.parts, [{ ms: 0, at: 0 }, { ms: 10000, at: 13 }]);
  // 文が1つの区間は1行のまま（parts なし）
  assert.ok(s.filter((x) => x.atMs === 20000).every((x) => x.parts === undefined), dump(o));
  assert.ok(rfOf(o).length >= 4 && rfOf(o).every((x) => x === 'verbose_json'), JSON.stringify(o.requests));
  // R25: verbose_json では言語の確率を頼まない（本物の 1.9.5 は VAD で声の無い音声で落ちる）。json の要求には付けない
  assert.ok(o.requests.filter((l) => /rf=verbose_json/.test(l)).every((l) => /nlp=true /.test(l)), JSON.stringify(o.requests));
  assert.ok(o.requests.filter((l) => /rf=json/.test(l)).every((l) => /nlp= /.test(l)), JSON.stringify(o.requests));
  assert.strictEqual(sttReqs(o).length, 0);
});

test('SP-3b・F23: segments を返さない（古いエンジン）・最後の end と長さが 3 秒ずれる → parts が無く区間が1行（札は付く）', T, async () => {
  for (const mode of ['none', 'drift']) {
    const o = await run(PC('pc-parts'), { env: { FAKE_SENTENCES: mode } });
    const s = segsOf(o);
    assert.ok(s.length === 4 && s.every((x) => x.parts === undefined && (x.src === 'mic' || x.src === 'loopback')), `${mode}: ${dump(o)}`);
  }
});

test('SP-3b: ヒントなしのやり直しも verbose_json。起動の試しと1本の会議（音声入力と同じく文だけを読む）は今のまま json', T, async () => {
  // 待ち時間は本物の尺度（偽の時計を進める場面で、ヒントなしのやり直しの前の残り時間の確かめが先に切れない）
  const o = await run(['prompt-empty', '--two-streams=pc-parts', '--test'], { env: { NATSU_TEST_LOCAL_TIME_SCALE: '1' } });
  const rf = rfOf(o);
  assert.ok(o.requests.some((l) => /prompt=false probe=false/.test(l)), '場面の前提: ヒントなしのやり直しが無い');
  assert.ok(rf.length >= 6 && rf.every((x) => x === 'verbose_json'), JSON.stringify(o.requests));
  assert.ok(o.requests.filter((l) => /probe=true/.test(l)).every((l) => /rf=json$/.test(l)), JSON.stringify(o.requests));
  assert.deepStrictEqual(segsOf(o).find((x) => x.src === 'mic' && x.atMs === 0).parts, MIC_PARTS);
  const one = await run(['text', '--segs=2']);
  assert.ok(rfOf(one).length >= 2 && rfOf(one).every((x) => x === 'json'), JSON.stringify(one.requests));
});

test('SP-3b・F23: 遅い PC の会議で残した音声を、会議の後に文字起こしすると parts が付く', T, async () => {
  const o = await run(PC('pc-slow-parts', '--after-retry'), { timeout: 110000 });
  assert.ok(o.engineLog.some((l) => /遅い PC のため音声を残した/.test(l)), `場面の前提: 遅い PC の会議になっていない: ${o.engineLog.join('\n')}`);
  const after = o.afterRetry.segments;
  assert.ok(after.length >= 6 && after.every((x) => !x.failed), JSON.stringify(after));
  assert.ok(after.every((x) => Array.isArray(x.parts) && x.parts.length >= 2), `会議の後に文字起こしした区間に parts が無い: ${JSON.stringify(after)}`);
});

test('SP-3b・F23: 落ちて下書きから戻しても parts が残る', T, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-文頭𠮷-'));
  try {
    assert.strictEqual(await runExit(PC('kill-parts', `--keep-user-data=${dir}`)), 3, '場面の前提: main ごと落ちていない');
    const o = await run(['text', '--recover', `--keep-user-data=${dir}`]);
    const withParts = o.pages[0].segs.filter((x) => Array.isArray(x.parts));
    assert.ok(withParts.length >= 1 && withParts.every((x) => x.parts.length >= 2), JSON.stringify(o.pages[0].segs));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- SP-4（D58・F33。決めたこと 102・143・R1）: 要約への入力の札
const M = require('../src/memoTypes');
const L = require('../src/mainlib');
const pCalls = (o) => (o.claude || []).filter((l) => l.kind === 'p');
const LABEL_RULE = '文字起こしの行の頭の 自分: はマイクから、相手: は PC から流れた声から文字起こしした行です。同じ部屋の人の発言も 自分: に入るので、ToDo の担当は行の頭の札で決めず、発言の中の名前で決めてください。';
const SUM = ['--sum', '--claude=ok', '--claude-stdin'];

test('SP-4・D58・F33: 偽の claude の標準入力の文字起こしがタイムラインの順（届いた順でない）で「自分: 」「相手: 」付き、書式の最後（OUTPUT_RULE の後）に札の1行。札の無い会議の標準入力は今と1文字も同じ', T, async () => {
  const o = await run(CLOUD('sum-order', ...SUM));
  const p = o.pages[0];
  // 場面の前提: 自分の区間が先に届き（DB の並び）、相手の区間の方が時刻は前
  assert.deepStrictEqual(p.segs.map((s) => s.src), ['mic', 'loopback'], dump(o));
  assert.ok(p.segs[1].atMs < p.segs[0].atMs, dump(o));
  const calls = pCalls(o);
  assert.strictEqual(calls.length, 1);
  const plain = '相手: そちらの見積を今週中に送ります\n自分: わたしは来週の工程を確認します';
  const template = M.buildTemplate({ meetingType: p.meetingType, score: false, labeled: true });
  assert.ok(template.endsWith(`${M.OUTPUT_RULE}\n\n${LABEL_RULE}`), template.slice(-300));
  assert.strictEqual(calls[0].stdinText, L.buildClaudeInput({ memoText: '', plain, template }));
  // 札の無い会議（1本の会議）は今の入力と1文字も同じ（DB の並びの文・札の1行なし）
  const one = await run(['text', '--segs=2', ...SUM]);
  const q = one.pages[0];
  const want = L.buildClaudeInput({ memoText: '', plain: q.segs.map((s) => s.text).join('\n'), template: M.buildTemplate({ meetingType: q.meetingType, score: false }) });
  assert.strictEqual(pCalls(one)[0].stdinText, want);
  assert.ok(!want.includes('自分:') && !want.includes(LABEL_RULE));
});

test('SP-4・F33（決めたこと 143）: 札を足すと 400 文字を越えるが、札の無い文では 400 文字に満たない会議に点が付かない（注 QN2）', T, async () => {
  const o = await run(CLOUD('sum-score', ...SUM));
  const p = o.pages[0];
  assert.strictEqual(p.segs.length, 10, dump(o));
  const tr = pCalls(o)[0].stdinText.split('【会議の文字起こし】\n')[1].split('\n\n上記から')[0];
  const raw = tr.split('\n').map((l) => l.replace(/^(自分|相手): /, '')).join('\n');
  // 場面の前提: 札を付けた文は 400 文字以上・札の無い文は 400 文字未満
  assert.ok(tr.length >= 400 && raw.length < 400, `${tr.length} / ${raw.length}`);
  assert.strictEqual(p.quality, undefined);
  assert.ok(String(p.summaryError).includes('文字起こしが短いため、打ち合わせの質の点は付けていません。'), p.summaryError);
  assert.ok(!pCalls(o)[0].stdinHeads.includes('## 打ち合わせの質（採点）'));
});

test('SP-4・F33（S16 (a)）: AI が「担当: 相手」「担当: 自分」と書き、発言に「相手」「自分」が無い ToDo の担当は外れる（期限は発言にあれば残る）。書式の札の1行を写し返した行は要約に残らない', T, async () => {
  const o = await run(CLOUD('sum-order', ...SUM, '--sum-md=spk-assignee'));
  const p = o.pages[0];
  assert.deepStrictEqual(p.todos.map((t) => [t.text, t.assignee, t.due ? 'due' : '']), [['見積を送る', '', 'due'], ['工程を確認する', '', '']], JSON.stringify(p.todos));
  assert.ok(!p.sumBlocks.some((b) => b.text.includes('文字起こしの行の頭の')), JSON.stringify(p.sumBlocks));
  assert.ok(p.sumBlocks.some((b) => b.text === '見積と工程の件を確かめた'));
});

// ---------------------------------------------------------------- 点検の直し（2026-10-25）C1（決めたこと 130 の改め。持ち主「両方の最後が届くまで待ってから締める（おすすめ）」）
test('点検の直し C1: 自分が黙って終わり（最後のマイクの区間は無音）マイクの最後が先に届き、相手が話し続けて終わり相手の最後が後に届いても、両方の行が残る（クラウド・PC）', T, async () => {
  for (const args of [CLOUD('last-mic-first'), PC('last-mic-first', '--relay=tagged', '--local-only')]) {
    const o = await run(args);
    const s = segsOf(o);
    assert.ok(s.some((x) => x.src === 'mic' && /わたしから見積/.test(x.text)), `${args.join(' ')}: ${dump(o)}`);
    assert.ok(s.some((x) => x.src === 'loopback' && /そちらの工程は最後まで/.test(x.text) && !x.failed), `相手の最後の区間が消えた（${args.join(' ')}）: ${dump(o)}`);
    assert.ok(!o.engineLog.some((l) => /締めの待ち/.test(l)), o.engineLog.join('\n'));
  }
});

test('点検の直し C1: 相手の声の最後が届かない（録音バーが落ちた形）ときは、止めてから 60 秒の見張りで締め、engine.log に決まった1行（文は書かない）。届いた行は残る', T, async () => {
  const o = await run(CLOUD('last-drop'));
  assert.deepStrictEqual(o.two.finalWaitMs, [60000]);
  assert.ok(o.pages.length === 1, dump(o));
  assert.ok(segsOf(o).some((x) => x.src === 'mic' && /わたしから見積/.test(x.text)), dump(o));
  const line = o.engineLog.filter((l) => /締めの待ち/.test(l));
  assert.deepStrictEqual(line, ['締めの待ち: 録音バーの最後の区間が 60 秒届かなかったので締めました（2つの流れ）'], o.engineLog.join('\n'));
});

// ---------------------------------------------------------------- 点検の直し（2026-10-25）I1（決めたこと 128 の改め）
test('点検の直し I1: 偽の whisper の文が音声の終わりの 5 秒前に終わる（最後が無音の区間）ときも、PC の側の区間に parts が付く', T, async () => {
  const o = await run(PC('pc-parts'), { env: { FAKE_SENTENCES: 'early' } });
  const s = segsOf(o);
  const mic0 = s.find((x) => x.src === 'mic' && x.atMs === 0);
  assert.ok(mic0 && Array.isArray(mic0.parts) && mic0.parts.length === 3, dump(o));
  assert.ok(mic0.parts[2].ms < mic0.durationMs - 5000, JSON.stringify(mic0));
});
