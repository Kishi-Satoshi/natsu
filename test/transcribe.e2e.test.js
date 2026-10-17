/*
 * transcribe.e2e.test.js — 記録 → 区間 → 文字起こし → 議事録の保存を、main.js ごと通しで試す
 *
 * 0.1.0 の実機で、録音の波形は出ているのに議事録が「0 区間」になった。原因は既定の認識ヒント
 * （初期プロンプト 376 バイト）で、kotoba-whisper が話し声に {"text":""} を返し、
 * main.js が空の区間を何も書かずに消していた。ここでは偽の whisper-server（helpers/fake-whisper.js）
 * を相手に、main.js を偽の Electron の上で実際に動かして固定する（helpers/mainrun.js）。
 *   - ヒント付きで空なら、ヒントなしでもう一度送り、区間を残す。議事録で 2 回続いたら、以後はヒントを渡さない
 *     （1 回では止めない。辞書を変えたら、またヒントを渡す。議事録を破棄したら、やり直しは送らない）
 *   - VAD が無く、ほぼ無音なら、ヒントなしのやり直しはしない（作り話を拾わない）
 *   - 本当に空なら、engine.log に理由を書き、全部が空なら利用者に知らせる（一部だけ空なら知らせない）
 *   - 200 のまま {"error"} を返すエンジンは、空ではなく失敗として区間を残す
 *   - 起動テスト（app:test）は /inference に無音を実際に送り、返事の異常を見逃さない。
 *     記録や文字起こしの最中は試さない
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');
const net = require('node:net');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const { vcRuntimeIssue } = require('../src/mainlib');

// 場面ごとの文字起こしエンジンのポートを、先にまとめて取る。別々に空きを探すと、並べて走らせた
// 場面どうしで同じポートを掴むことがある（100 回に 1 回ほど落ちた）
async function reservePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  })));
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [RUN, ...args], { timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      const last = stdout.trim().split('\n').pop();
      try { resolve(JSON.parse(last)); } catch (e) { reject(new Error(`mainrun ${args.join(' ')} の出力を読めない: ${last}\n${stderr}`)); }
    });
  });
}

// 場面を並べて走らせる（1 つ 2〜3 秒）
const SCENES = {
  promptEmpty: ['prompt-empty', '--test', '--segs=3'],
  noiseFirst: ['big-prompt-empty', '--segs=3'],
  discard: ['slow-prompt-empty', '--discard-during'],
  dict: ['prompt-empty', '--segs=3', '--after-dict'],
  text: ['text', '--test'],
  empty: ['empty', '--test'],
  emptyOne: ['empty', '--segs=1'],
  mixed: ['mixed'],
  silentNoVad: ['empty', '--silent', '--segs=1'],
  silentVad: ['empty', '--silent', '--vad', '--segs=1'],
  err200: ['err200', '--test'],
  probe500: ['probe500', '--test'],
  probeBadJson: ['probe-badjson', '--test'],
  probeDrop: ['probe-drop', '--test'],
  busy: ['slow', '--test-during'],
  kotoba: ['prompt-empty', '--kotoba'],
  sumGround: ['text', '--sum', '--text=山田さんが来週金曜までに進捗の確認をまとめます。'],
  sumType: ['text', '--sum', '--set-type-during=standup'],
};
// 取り込んだエンジン・取り込みの案内の場面（第0b回 Task 13）。1 つ 0.5〜0.7 秒と軽いが、上の場面と同時に走らせると
// node のプロセスが CPU を取り合い、上の重い場面（busy は 1.5 秒の返事を 2 回待つ）が 5 秒を超える。上の場面が済んでから走らせる
const MANAGED_SCENES = {
  managed: ['text', '--managed', '--test'],
  managedTamper: ['text', '--managed-tamper'],
  managedRecover: ['text', '--managed', '--recover'],
  managedNoRuntime: ['text', '--managed', '--no-vc-runtime'],
  managedVerifyThrows: ['text', '--managed', '--verify-throws'],
  managedSumBroken: ['text', '--managed', '--sum-tamper'],
  noEngineFetchable: ['text', '--no-engine=fetchable'],
  noEngineUnsupported: ['text', '--no-engine=unsupported'],
};
const results = {};
const running = {};
// 場面ごとに 2 つ（文字起こしと要約のエンジン）のポートを取って、並べて走らせる。テストは自分が見る場面だけを待つ
// （全部を待つと、いちばん遅い場面〔busy は 1.5 秒の返事を 2 回待つ〕を最初のテストが背負い、5 秒に近づく）
function runAll(scenes) {
  const ports = reservePorts(Object.keys(scenes).length * 2);
  Object.entries(scenes).forEach(([k, a], i) => {
    running[k] = ports.then((p) => run([...a, `--port=${p[2 * i]}`, `--sum-port=${p[2 * i + 1]}`])).then((r) => { results[k] = r; });
    running[k].catch(() => {});   // 落ちたら、その場面を待つテストで落とす（まだ誰も待っていないうちに unhandled にしない）
  });
  return Promise.all(Object.keys(scenes).map((k) => running[k]));
}
// 取り込みの場面は、上の場面が全部済んでから（落ちた場面があっても）走らせる
const managedStarted = runAll(SCENES).catch(() => {}).then(() => { runAll(MANAGED_SCENES).catch(() => {}); });
// 場面 ks が済むのを待つ
const need = (...ks) => Promise.all(ks.map((k) => (k in MANAGED_SCENES ? managedStarted.then(() => running[k]) : running[k])));
const meetingReqs = (r) => r.requests.filter((l) => !/probe=true/.test(l));
const prompted = (r) => meetingReqs(r).map((l) => /prompt=true/.test(l));

test('ヒント付きで空なら、ヒントなしでもう一度送り、区間を残す。2 回続いたら以後はヒントを渡さない（0.1.0 の「0 区間」）', async () => {
  await need('promptEmpty');
  const r = results.promptEmpty;
  assert.strictEqual(r.pages.length, 1, '議事録が 1 つできていない');
  const segs = r.pages[0].segments;
  assert.strictEqual(segs.length, 3, `区間が消えた: ${JSON.stringify(segs)}`);
  assert.ok(segs.every((s) => !s.failed && /^本日の議題は進捗の確認です。区間\d+$/.test(s.text)), JSON.stringify(segs));
  // 1・2 つ目の区間は「ヒント付き → ヒントなし」。続いたので、3 つ目はヒントなしの 1 回だけ（毎回 2 回送らない）
  assert.deepStrictEqual(prompted(r), [true, false, true, false, false]);
  // ヒントなしのやり直しも、前の要求（ヒント付き）の続きにしない
  assert.ok(meetingReqs(r).every((l) => /nc=true/.test(l)), JSON.stringify(r.requests));
  assert.strictEqual(r.engineLog.filter((l) => /^文字起こし: 認識ヒント（\d+ バイト）付きでは空 → ヒントなしで \d+ 文字（音声 \d 秒）$/.test(l)).length, 2,
    `やり直しが engine.log に残っていない: ${JSON.stringify(r.engineLog)}`);
  assert.ok(r.engineLog.includes('文字起こし: 以後、エンジンと認識ヒントの設定が変わるまで、認識ヒントを渡しません'), JSON.stringify(r.engineLog));
  // 設定画面にも「いまはヒントを渡していない」と伝える
  assert.strictEqual(r.promptInfo.off, true);
  assert.ok(!r.notices.some((n) => /すべて空/.test(n)), '取れたのに「すべて空」と知らせている');
});

test('文字が取れたときは 1 回だけ送り、ヒントも止めない', async () => {
  await need('text');
  const r = results.text;
  assert.deepStrictEqual(prompted(r), [true, true]);
  // ヒント付きの要求には、区間全体に効かせる carry_initial_prompt と言語を必ず添える
  assert.ok(meetingReqs(r).every((l) => /lang=ja/.test(l) && /carry=true/.test(l)), JSON.stringify(r.requests));
  // どの要求も前の要求の続きにしない（1.8.0 以前は既定で持ち越す）
  assert.ok(r.requests.every((l) => /nc=true/.test(l)), JSON.stringify(r.requests));
  // 改行をはさんだ返事は 1 行にまとめて保存する
  assert.deepStrictEqual(r.pages[0].segments.map((s) => s.text), ['本日の議題は進捗の確認です。区間2', '本日の議題は進捗の確認です。区間3']);
  assert.ok(!r.engineLog.some((l) => /認識ヒント|除きました/.test(l)), JSON.stringify(r.engineLog));
  assert.strictEqual(r.promptInfo.off, false);
});

test('本当に空なら、engine.log に区間ごとの理由を書き、全部が空なら利用者に知らせる', async () => {
  await need('empty');
  const r = results.empty;
  assert.strictEqual(r.pages[0].segments.length, 0);
  // 通知は数秒で消えるので、議事録の要約の欄にも同じ理由と確かめ方を残す（理由の記録の場所は札を付けて最後に）
  assert.match(r.pages[0].summaryError, /^2 区間の音声を受け取りましたが、文字起こしの結果がすべて空でした。.*使用するマイク.*理由の記録: %APPDATA%\\natsu\\engine\.log$/);
  // [BLANK_AUDIO] だけの返事も空として扱う
  assert.strictEqual(r.engineLog.filter((l) => /^文字起こし: 認識ヒント（\d+ バイト）付きでは空 → ヒントなしでも空/.test(l)).length, 2, JSON.stringify(r.engineLog));
  assert.strictEqual(r.engineLog.filter((l) => /^区間 s\d+（音声 \d+ 秒）: 文字起こしが空のため除きました$/.test(l)).length, 2, JSON.stringify(r.engineLog));
  assert.ok(r.engineLog.includes('議事録を保存: 文字起こしが空の区間が 2、文字の残った区間は 0'), JSON.stringify(r.engineLog));
  const notice = r.notices.find((n) => n.startsWith('2 区間の音声を受け取りましたが、文字起こしの結果がすべて空でした。'));
  assert.ok(notice, `利用者に知らせていない: ${JSON.stringify(r.notices)}`);
  assert.strictEqual(notice, r.pages[0].summaryError, '通知と要約の欄の文が違う');
  assert.match(notice, /使用するマイク/);
  assert.match(notice, /engine\.log/);
  // 空が続いても、ヒントは止めない（ヒントのせいだと分かったわけではない）
  assert.strictEqual(r.promptInfo.off, false);
});

test('空の区間が 1 つだけでも、全部が空なら知らせる。一部だけ空なら知らせない', async () => {
  await need('emptyOne', 'mixed');
  assert.ok(results.emptyOne.notices.some((n) => n.startsWith('1 区間の音声を受け取りましたが、文字起こしの結果がすべて空でした。')),
    JSON.stringify(results.emptyOne.notices));
  const m = results.mixed;
  assert.strictEqual(m.pages[0].segments.length, 1, JSON.stringify(m.pages));
  assert.ok(m.engineLog.some((l) => /^区間 s1（音声 3 秒）: 文字起こしが空のため除きました$/.test(l)), JSON.stringify(m.engineLog));
  assert.ok(!m.notices.some((n) => /すべて空/.test(n)), `一部が取れたのに知らせた: ${JSON.stringify(m.notices)}`);
});

test('VAD が無く、ほぼ無音なら、ヒントなしのやり直しをしない（VAD があればやり直す）', async () => {
  await need('silentNoVad', 'silentVad');
  const a = results.silentNoVad;
  assert.deepStrictEqual(prompted(a), [true], JSON.stringify(a.requests));
  assert.ok(a.engineLog.some((l) => /^文字起こし: 認識ヒント付きでは空。音がほとんど無いため（無音）、ヒントなしでのやり直しは省きました/.test(l)), JSON.stringify(a.engineLog));
  const b = results.silentVad;
  assert.match(b.spawnArgs, /--vad/, 'VAD の偽モデルを置いたのに --vad で起動していない');
  assert.deepStrictEqual(prompted(b), [true, false], JSON.stringify(b.requests));
});

test('200 のまま {"error"} を返すエンジンは、空ではなく失敗として区間を残す', async () => {
  await need('err200');
  const r = results.err200;
  const segs = r.pages[0].segments;
  assert.strictEqual(segs.length, 2, `区間が黙って消えた: ${JSON.stringify(segs)}`);
  assert.ok(segs.every((s) => s.failed && /failed to read audio data/.test(s.text)), JSON.stringify(segs));
  // 失敗はヒントなしのやり直しの対象にしない（空のときだけ）
  assert.ok(!r.engineLog.some((l) => /^文字起こし:/.test(l)), JSON.stringify(r.engineLog));
});

test('起動テストは /inference に正しい WAV の無音を実際に送り、返事の異常を見逃さない', async () => {
  await need('text', 'promptEmpty', 'empty', 'err200', 'probe500', 'probeBadJson', 'probeDrop');
  for (const k of ['text', 'promptEmpty', 'empty']) {
    const t = results[k].test;
    assert.strictEqual(t.ok, true, `${k}: ${JSON.stringify(t)}`);
    assert.match(t.info, /短い無音を試しに文字起こしさせ、返事があることも確かめました/);
    assert.match(results[k].requests[0], /prompt=false probe=true lang=ja carry= nc=true wav=true/, `${k}: 起動テストの送り方が違う`);
  }
  const cases = {
    err200: /^文字起こしを試せませんでした: failed to read audio data$/,
    probe500: /^文字起こしを試せませんでした（500: boom）$/,
    probeBadJson: /^文字起こしエンジンの返事を読めませんでした$/,
    probeDrop: /^文字起こしを試せませんでした: エンジンにつながりませんでした$/,
  };
  for (const [k, re] of Object.entries(cases)) {
    const t = results[k].test;
    assert.strictEqual(t.ok, false, `${k}: ${JSON.stringify(t)}`);
    assert.match(t.error, re, k);
    assert.ok(results[k].engineLog.includes(`起動テスト: ${t.error}`), `${k}: engine.log に残っていない`);
  }
});

test('記録や文字起こしの最中は、起動テストで試しの文字起こしをしない', async () => {
  await need('busy');
  const r = results.busy;
  assert.strictEqual(r.testDuring.ok, true, JSON.stringify(r.testDuring));
  assert.match(r.testDuring.info, /記録や文字起こしの最中のため、試しの文字起こしは省きました/);
  assert.ok(!r.requests.some((l) => /probe=true/.test(l)), JSON.stringify(r.requests));
  assert.strictEqual(r.pages[0].segments.length, 2);
});

test('モデルが kotoba-whisper なら認識ヒントを渡さず（1 回だけ送る）、設定で large-v3-turbo を勧める', async () => {
  await need('kotoba', 'text', 'promptEmpty');
  const r = results.kotoba;
  // ヒント付きなら空を返す偽エンジンでも、最初からヒントなしなので区間は残り、やり直しも起きない
  assert.deepStrictEqual(prompted(r), [false, false], JSON.stringify(r.requests));
  assert.ok(meetingReqs(r).every((l) => /carry= /.test(l) && /nc=true/.test(l)), JSON.stringify(r.requests));
  assert.strictEqual(r.pages[0].segments.length, 2);
  assert.ok(!r.engineLog.some((l) => /^文字起こし:/.test(l)), JSON.stringify(r.engineLog));
  assert.deepStrictEqual([r.promptInfo.off, r.promptInfo.offReason], [true, 'kotoba']);
  assert.match(r.engineStatus.whisperNote, /kotoba-whisper/);
  assert.match(r.engineStatus.whisperNote, /large-v3-turbo に替えることをおすすめします/);
  // kotoba でなければ勧めない・ヒントを止めた理由は 'empty'
  assert.strictEqual(results.text.engineStatus.whisperNote, '');
  assert.strictEqual(results.text.promptInfo.offReason, '');
  assert.strictEqual(results.promptEmpty.promptInfo.offReason, 'empty');
});

test('取り込みの状態の受け口（engine:fetch-status）は実際に動き、手の設定の側は manual。置き場所は一時フォルダの LOCALAPPDATA の下（第0b回 Task 13）', async () => {
  await need('text');
  const r = results.text;
  const s = r.engineFetchStatus;
  assert.ok(s && s.ok === true, JSON.stringify(s));
  // この場面の settings.json は文字起こしだけ手のパス。要約は空なので取り込む側
  assert.deepStrictEqual(s.mode, { whisper: 'manual', sum: 'managed' });
  assert.deepStrictEqual([s.whisperReady, s.sumReady], [false, false]);
  assert.strictEqual(r.engineStatus.whisper, '', '手の設定の文字起こしに取り込みの文を出した');
  const win64 = process.platform === 'win32' && process.arch === 'x64';
  assert.strictEqual(s.supported, win64);
  if (win64) {
    // 本当のプロファイルの natsu\engine を見ていない（mainrun が main.js を読む前に LOCALAPPDATA を替える）
    assert.match(s.root, /LocalAppData-取込𠮷\\natsu\\engine$/);
    assert.strictEqual(s.state, 'missing');
    assert.match(r.engineStatus.sum, /^要約エンジンはまだ取り込んでいません。設定タブの［エンジンを取り込む］を押してください$/);
  } else {
    // 取り込めない PC では今までどおり（手の設定だけ）
    assert.deepStrictEqual([s.root, s.state], [null, 'unsupported']);
    assert.strictEqual(r.engineStatus.sum, '要約エンジンの実行ファイルまたはモデルが見つかりません');
  }
});

test('設計 B・RF3: 詳細設定が空なら、照らし終えた取り込んだ組で起動する。照らす前は起動せず「確かめています」。設定には書かない（第0b回 Task 13）', async () => {
  await need('managed');
  const r = results.managed;
  const W = r.managedRoot;
  // 照らし終える前（マイクロタスクだけを待った時点）。取り込んだ側はまだ使えない
  assert.strictEqual(r.statusChecking.whisper, '文字起こしエンジンを確かめています（数秒で終わります）');
  assert.strictEqual(r.spawnsBeforeVerify, 0);
  // 照らし終えた後: 取り込んだ exe を cwd = exe のフォルダで、モデルと VAD は英数字だけの相対パスで起動する（RF1）
  assert.strictEqual(r.spawns.length, 1, JSON.stringify(r.spawns));
  const sp = r.spawns[0];
  assert.strictEqual(sp.cmd, path.join(W, 'whisper-1.0.0', 'whisper-server.exe'));
  assert.strictEqual(sp.cwd, path.join(W, 'whisper-1.0.0'));
  const arg = (f) => sp.args[sp.args.indexOf(f) + 1];
  assert.strictEqual(arg('-m'), path.join('..', 'models', 'w-model.bin'));
  assert.strictEqual(arg('--vad-model'), path.join('..', 'models', 'ggml-silero-v6.2.0.bin'), 'VAD の自動の発見が取り込んだ models で効いていない');
  assert.ok(sp.args.every((a) => /^[\x20-\x7e]*$/.test(a)), `英数字以外の引数: ${sp.args}`);
  // 起動テストと記録が通る
  assert.strictEqual(r.test.ok, true, JSON.stringify(r.test));
  assert.strictEqual(r.pages.length, 1, JSON.stringify(r.notices));
  assert.ok(r.pages[0].segments.length === 2 && r.pages[0].segments.every((x) => !x.failed), JSON.stringify(r.pages[0].segments));
  assert.strictEqual(r.engineStatus.whisper, '');
  // 要約の組はまだ取り込んでいない: ［エンジンを取り込む］を指す。議事録の欄の文は「未設定」の語を残す（画面が設定タブへ案内する）
  assert.strictEqual(r.engineStatus.sum, '要約エンジンはまだ取り込んでいません。設定タブの［エンジンを取り込む］を押してください');
  assert.match(r.pages[0].summaryError, /^要約エンジンが未設定のため、文字起こしのみ保存しました。設定タブの［エンジンを取り込む］/);
  // 取り込みの欄の写し
  const s = r.engineFetchStatus;
  assert.deepStrictEqual([s.supported, s.root, s.mode, s.using, s.whisperReady, s.sumReady],
    [true, W, { whisper: 'managed', sum: 'managed' }, { whisper: 'current', sum: null }, true, false]);
  // RF7: 取り込んだパスを設定に書いていない
  for (const k of ['localServerExe', 'localModelPath', 'vadModelPath', 'sumServerExe', 'sumModelPath']) assert.ok(!r.savedSettings[k], `${k} を書いた: ${r.savedSettings[k]}`);
});

test('RF3: 大きさと更新時刻が同じでも中身の違う DLL の組は使わない。起動せず、記録・起動テスト・engine.log に理由を出す（第0b回 Task 13）', async () => {
  await need('managedTamper');
  const r = results.managedTamper;
  assert.strictEqual(r.statusChecking.whisper, '文字起こしエンジンを確かめています（数秒で終わります）');
  const broken = /^文字起こしエンジンのファイルが消えたか変わっています。ウイルス対策が消した可能性があります（Windows セキュリティ → ウイルスと脅威の防止 → 保護の履歴）。/;
  assert.match(r.engineStatus.whisper, broken);
  assert.match(r.start.error, broken, '記録を始めた');
  assert.match(r.test.error, broken);
  assert.deepStrictEqual(r.spawns, [], '照らしで合わない組を起動した');
  assert.ok(r.engineLog.includes(`取り込んだエンジンの照らし: 合わない ${path.join(r.managedRoot, 'whisper-1.0.0', 'whisper.dll')}（changed）`), JSON.stringify(r.engineLog));
});

test('起動のときの復旧の文字起こしは、取り込んだ組を照らし終えたらもう一度試す（照らす前は「確かめています」で保留になる。第0b回 Task 13）', async () => {
  await need('managedRecover');
  const r = results.managedRecover;
  assert.ok(r.engineLog.includes('復旧の文字起こしを保留: 文字起こしエンジンを確かめています（数秒で終わります）'), JSON.stringify(r.engineLog));
  assert.deepStrictEqual(r.recovered, [{ text: '本日の議題は進捗の確認です。区間1', failed: false }], '照らし終えた後に復旧を試していない');
  assert.deepStrictEqual(r.spawns.map((x) => x.cmd), [path.join(r.managedRoot, 'whisper-1.0.0', 'whisper-server.exe')]);
});

test('RF4: 取り込んだ組は、Visual C++ ランタイムが無い PC では起動しない。engine:status・起動テスト・記録の開始・取り込みの欄に同じ案内（第0b回 Task 13）', async () => {
  await need('managedNoRuntime');
  const r = results.managedNoRuntime;
  // 照らしは通っている（ランタイムの前に「確かめています」「壊れた」で止まっていない）
  assert.strictEqual(r.statusChecking.whisper, '文字起こしエンジンを確かめています（数秒で終わります）');
  const msg = vcRuntimeIssue({}, { whisper: true }).message;
  assert.match(msg, /Microsoft Visual C\+\+ ランタイム.*今の版: なし/);
  assert.strictEqual(r.engineStatus.whisper, msg);
  assert.deepStrictEqual([r.test.ok, r.test.error], [false, msg]);
  assert.deepStrictEqual([r.start.ok, r.start.error], [false, msg]);
  assert.deepStrictEqual(r.spawns, [], 'ランタイムの無い PC で取り込んだ組を起動した');
  // 取り込む前の欄にも同じ理由（数 GB を落としてから知らせない。画面は Task 15）
  assert.deepStrictEqual(r.engineFetchStatus.runtime, { level: 'missing', message: msg });
});

test('RF3: 照らしが例外で終わっても「確かめています」のまま残さず、壊れた組として使わない（第0b回 Task 13）', async () => {
  await need('managedVerifyThrows');
  const r = results.managedVerifyThrows;
  assert.ok(r.engineLog.includes('取り込んだエンジンの照らしに失敗: 照らしの試験の失敗𠮷'), JSON.stringify(r.engineLog));
  const broken = /^文字起こしエンジンのファイルが消えたか変わっています。/;
  assert.match(r.engineStatus.whisper, broken);
  assert.match(r.start.error, broken);
  assert.deepStrictEqual(r.spawns, []);
});

test('要約の組が壊れていたら、議事録の欄は理由と、終わったら「要約を生成」で作れることを伝える（文字起こしは取り込んだ組で動く。第0b回 Task 13）', async () => {
  await need('managedSumBroken');
  const r = results.managedSumBroken;
  assert.strictEqual(r.engineStatus.whisper, '');
  assert.ok(r.pages.length === 1 && r.pages[0].segments.length === 2 && r.pages[0].segments.every((x) => !x.failed), JSON.stringify(r.pages));
  assert.strictEqual(r.pages[0].summaryError, '要約エンジンを使えないため、文字起こしのみ保存しました。'
    + '要約エンジンのファイルが消えたか変わっています。ウイルス対策が消した可能性があります（Windows セキュリティ → ウイルスと脅威の防止 → 保護の履歴）。取り直しています。'
    + '終わったら「要約を生成」で作成できます。');
});

test('何も取り込んでいない PC: 取り込める PC では［エンジンを取り込む］へ、取り込めない PC では今までどおりパスの指定へ案内する。どちらも「未設定」の語を残す（第0b回 Task 13）', async () => {
  await need('noEngineFetchable', 'noEngineUnsupported');
  const f = results.noEngineFetchable;
  assert.deepStrictEqual([f.start.ok, f.start.error], [false, '文字起こしエンジンが未設定です。設定タブの［エンジンを取り込む］から取り込んでください。']);
  assert.strictEqual(f.engineStatus.whisper, '文字起こしエンジンはまだ取り込んでいません。設定タブの［エンジンを取り込む］を押してください');
  assert.deepStrictEqual([f.engineFetchStatus.supported, f.engineFetchStatus.state], [true, 'missing']);
  const u = results.noEngineUnsupported;
  assert.deepStrictEqual([u.start.ok, u.start.error], [false, '文字起こしエンジンが未設定です。設定タブでパスを指定してください。']);
  assert.strictEqual(u.engineStatus.whisper, '文字起こしエンジンの実行ファイルまたはモデルが見つかりません');
  assert.deepStrictEqual([u.engineFetchStatus.supported, u.engineFetchStatus.state], [false, 'unsupported']);
  for (const r of [f, u]) assert.deepStrictEqual(r.spawns, []);
});

test('雑音の 1 区間だけヒント付きで空になっても、ヒントは止めない（続けて起きたときだけ止める）', async () => {
  await need('noiseFirst');
  const r = results.noiseFirst;
  // 1 つ目（3 秒）はヒント付きで空 → ヒントなし。2・3 つ目はヒント付きのまま取れる
  assert.deepStrictEqual(prompted(r), [true, false, true, true], JSON.stringify(r.requests));
  assert.strictEqual(r.pages[0].segments.length, 3);
  assert.deepStrictEqual([r.promptInfo.off, r.promptInfo.offReason], [false, '']);
  assert.ok(!r.engineLog.some((l) => /認識ヒントを渡しません/.test(l)), JSON.stringify(r.engineLog));
});

test('返事を待つ間に議事録を破棄したら、ヒントなしのやり直しは送らない', async () => {
  await need('discard');
  const r = results.discard;
  assert.strictEqual(r.discard && r.discard.ok, true, JSON.stringify(r.discard));
  assert.deepStrictEqual(prompted(r), [true], JSON.stringify(r.requests));
  assert.ok(!r.engineLog.some((l) => /^文字起こし: 認識ヒント/.test(l)), JSON.stringify(r.engineLog));
  assert.strictEqual(r.pages.length, 0, '破棄した議事録が保存された');
});

test('ヒントを止めた後で辞書を変えたら、またヒントを渡す（設定画面の約束どおり）', async () => {
  await need('dict');
  const r = results.dict;
  assert.deepStrictEqual([r.promptInfo.off, r.promptInfo.offReason], [true, 'empty']);
  assert.strictEqual(r.saved && r.saved.ok, true, JSON.stringify(r.saved));
  assert.deepStrictEqual([r.promptInfoAfterDict.off, r.promptInfoAfterDict.offReason], [false, '']);
});

// ================= 要約（0.1.2）。偽の要約エンジン helpers/fake-llama.js を相手にする =================
test('要約が文字起こしに無い担当・期限を書いても、議事録には載せない（発言にある担当・期限は残す）', async () => {
  await need('sumGround');
  const p = results.sumGround.pages[0];
  // 偽の要約は「進捗の確認をまとめる（担当: 山田 / 期限: 来週金曜）」と「資料を配布する（担当: 鈴木 / 期限: 10/23）」を返す。
  // 文字起こしは「山田さんが来週金曜までに…」なので、山田・来週金曜は残り、鈴木・10/23 は外れる
  assert.deepStrictEqual(p.todos.map((t) => [t.text, t.assignee, t.dueRaw]), [
    ['進捗の確認をまとめる', '山田', '来週金曜'],
    ['資料を配布する', '', ''],
  ]);
  assert.match(p.todos[0].due, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(p.todos[1].due, '');
  assert.deepStrictEqual(p.actionStat, { total: 2, withAssignee: 1, withDue: 1 });
  assert.ok(results.sumGround.engineLog.includes('要約: 文字起こしに無い担当 1 件・期限 1 件を外しました'), JSON.stringify(results.sumGround.engineLog));
  // engine.log に名前を書かない（1on1・面談の議事録は機微）
  assert.ok(!results.sumGround.engineLog.some((l) => /鈴木|山田/.test(l)), JSON.stringify(results.sumGround.engineLog));
});

test('要約の途中で会議タイプを手で選び直したら、その選択を残し、作り直しを勧める', async () => {
  await need('sumType', 'sumGround');
  const r = results.sumType;
  assert.strictEqual(r.setType && r.setType.meetingType, 'standup', JSON.stringify(r.setType));
  const p = r.pages[0];
  assert.strictEqual(p.todos.length > 0, true, '要約が保存されていない');
  // 0.1.1 までは、要約を始めたときの種類（自動）で上書きしていた
  assert.deepStrictEqual([p.meetingType, p.typeAuto], ['standup', false]);
  assert.strictEqual(p.summaryError, 'この要約は「一般・その他」として作りました。途中で選んだ「定例・進捗報告」で作り直すには［要約を再生成］を押してください。');
  // 途中で何も選ばなければ、自動で決めた種類のまま（判定材料が無いので一般・その他）で、添え書きも無い
  const q = results.sumGround.pages[0];
  assert.deepStrictEqual([q.meetingType, q.typeAuto, q.summaryError], ['general', true, '']);
});
