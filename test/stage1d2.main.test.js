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
