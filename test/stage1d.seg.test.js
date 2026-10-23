/*
 * stage1d.seg.test.js — 第1d回 Task A-5（RL13・D16・F13・RF40）: 区切りの長さを、偽の Electron の上で main.js を本当に動かして確かめる
 * （helpers/mainrun.js の --relay・--relay-seq）。中継は本物の relay/ のコードを 127.0.0.1 で包んだもの（helpers/relay-local.js）。
 * out.overlaySent は録音バーへ送った overlay:start の payload と overlay:segment-ms の値の並び、out.order はそれと中継への要求の順。
 * 録音バー（overlay.html）は始めの segmentSec を丸めずに使い、途中の overlay:segment-ms は 20〜300 秒に丸める（変えない）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
// NATSU_TEST_ONLINE_MEMO_SCALE: 届くかの覚え（届いた 60 秒・届かない 15 秒）を縮め、区間ごとに中継の答えを替えても次の区間で気づくようにする
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001' }, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const T = { timeout: sceneTimeout(20000) };
const STT = '/v1/audio/transcriptions';
const starts = (o) => o.overlaySent.filter((x) => x && typeof x === 'object').map((x) => x.segmentSec);
const live = (o) => o.overlaySent.filter((x) => typeof x === 'number');
const texts = (segs) => segs.length > 0 && segs.every((s) => !s.failed && s.text.startsWith('本日の議題は進捗の確認です'));
const posts = (calls) => calls.filter((p) => p === STT).length;

test('D16: ログインしてオンラインなら、録音バーへの始めの segmentSec は 15。途中の overlay:segment-ms は送らない。記録に『区切り 15 秒（short・理由 start）』', T, async () => {
  // 計画は --relay=text --segs=4。区間を 50 ミリ秒ごとに送ると、混んだ機械では待ちが 4 になって背圧で倍にしうるので、1区間ずつ待つ --relay-seq で同じことを見る
  const o = await run(['text', '--relay-seq=cccc']);
  assert.deepStrictEqual(starts(o), [15], JSON.stringify(o.overlaySent));
  assert.deepStrictEqual(live(o), [], `途中で区切りを送った: ${JSON.stringify(o.overlaySent)}`);
  assert.ok(o.engineLog.includes('文字起こしの状態: 区切り 15 秒（short・理由 start）'), o.engineLog.join('\n'));
  assert.strictEqual(posts(o.relayCalls), 4);
  assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
});

for (const [name, args] of [['オフライン', ['--relay=text', '--offline']], ['ログインしていない', ['--relay=text', '--signed-out']]]) {
  test(`D16: ${name}なら始めから 75 秒（記録に『区切り 75 秒（long・理由 start）』）`, T, async () => {
    const o = await run(['text', ...args, '--segs=2']);
    assert.deepStrictEqual(starts(o), [75], JSON.stringify(o.overlaySent));
    assert.deepStrictEqual(live(o), [], JSON.stringify(o.overlaySent));
    assert.ok(o.engineLog.includes('文字起こしの状態: 区切り 75 秒（long・理由 start）'), o.engineLog.join('\n'));
    assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
  });
}

test('D16: hold の日（daily-cap の後に始めた会議）は始めから 75 秒。上限に達した区間の後すぐ 75 秒。日が替わった会議は 15 秒に戻る', T, async () => {
  const o = await run(['text', '--json-scene=relay-day', '--relay=daily-cap']);
  // 1つ目の会議（ログイン・オンライン）は 15、11 分後の2つ目（hold の間）は 75、日が替わった3つ目は 15
  assert.deepStrictEqual(starts(o), [15, 75, 15], JSON.stringify(o.overlaySent));
  // 1つ目の会議の2つ目の区間で 429 daily-cap → その区間の後すぐ 75 秒（同じ側が2区間続くのを待たない）
  assert.deepStrictEqual(o.overlaySent.slice(0, 2).map((x) => (typeof x === 'number' ? x : x.segmentSec)), [15, 75000], JSON.stringify(o.overlaySent));
  assert.deepStrictEqual(live(o), [75000], JSON.stringify(o.overlaySent));
});

test('D16・RF28: ［この会議は PC の中だけ］を押すと、その場で 75 秒を送る（次の区間から）。中継へは1回も送らない', T, async () => {
  const o = await run(['text', '--relay=text', '--local-only', '--segs=2']);
  assert.strictEqual(o.localOnly && o.localOnly.ok, true, JSON.stringify(o.localOnly));
  assert.deepStrictEqual(starts(o), [15], JSON.stringify(o.overlaySent));
  assert.strictEqual(o.overlaySent[1], 75000, `押した直後に 75 秒を送っていない: ${JSON.stringify(o.overlaySent)}`);
  assert.ok(live(o).every((ms) => ms >= 75000), `PC の中だけの会議で短い区切りを送った: ${JSON.stringify(o.overlaySent)}`);
  assert.strictEqual(posts(o.relayCalls), 0, `中継へ送った: ${o.relayCalls}`);
  // 押した直後（最初の区間の文字起こしより前）に送る。区間の後の「PC の中だけはすぐ長い側」だけに頼らない
  const at = o.engineLog.indexOf('文字起こしの状態: 区切り 75 秒（long・理由 local-only）');
  const s1 = o.engineLog.findIndex((l) => /区間 s1 → local/.test(l));
  assert.ok(at >= 0 && s1 > at, `押した直後に 75 秒にしていない: ${o.engineLog.join('\n')}`);
  assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
});

// 0.9.4 S-1（決めたこと 30・依頼7）で意図して直した: 中継に届かない（一時の失敗）区間は PC でやり直すが、区切りの側には数えないので、
// 長い側（75 秒）へ替えず 15 秒のまま（前は 2 区間続いたら 75 秒にし、戻って 20 秒にした）。区間が全部文字になり、経路の数は同じ
test('D16: 会議の途中で中継が止まっても（届かない区間が 4 つ続いても）、区切りは 15 秒のまま。その区間は PC で文字起こしする', T, async () => {
  const o = await run(['text', '--relay-seq=ccnnnncc', '--segs=8']);
  assert.deepStrictEqual(starts(o), [15]);
  assert.deepStrictEqual(live(o), [], JSON.stringify(o.overlaySent));
  assert.strictEqual(o.pages[0].segments.length, 8, JSON.stringify(o.pages[0].segments));
  assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 4, local: 4, provider: 'openai' });
  assert.ok(!o.engineLog.some((l) => /区切り 75 秒/.test(l)), o.engineLog.join('\n'));
});

test('D16: 1 区間だけ中継が 502 でも区切りは変えない（その区間は PC でやり直す）', T, async () => {
  const o = await run(['text', '--relay-seq=c5cc']);
  assert.deepStrictEqual(starts(o), [15]);
  assert.deepStrictEqual(live(o), [], JSON.stringify(o.overlaySent));
  assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
  assert.deepStrictEqual(o.pages[0].route.stt, { cloud: 3, local: 1, provider: 'openai' });
});

test('D16: ログインが切れたら、その区間の後すぐ 75 秒', T, async () => {
  const o = await run(['text', '--relay-seq=cl']);
  assert.deepStrictEqual(starts(o), [15]);
  assert.deepStrictEqual(live(o), [75000], JSON.stringify(o.overlaySent));
  assert.ok(o.engineLog.includes('文字起こしの状態: 区切り 75 秒（long・理由 login）'), o.engineLog.join('\n'));
  assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
});

test('D16: ログインが切れて PC で起こした区間がエンジンの失敗でも、その区間の後すぐ 75 秒（理由は login。A-5 の点検）', T, async () => {
  // 手元のエンジンが 200 のまま誤りを返す err200: 2 区間目は中継の 401 で手元に落ち、手元でも失敗する
  const o = await run(['err200', '--relay-seq=cl']);
  assert.deepStrictEqual(starts(o), [15]);
  assert.deepStrictEqual(live(o), [75000], JSON.stringify(o.overlaySent));
  assert.ok(o.engineLog.includes('文字起こしの状態: 区切り 75 秒（long・理由 login）'), o.engineLog.join('\n'));
});

// 0.9.4 S-5（決めたこと 29・依頼7）で意図して直した: クラウドで文字起こしする会議（15 秒の側）は、待ちが積もっても区切りを伸ばさない
// （前は 30 秒に倍にし、追いついたら 20 秒に戻した。大きくなった WAV が中継の CPU をさらに使った）。背圧で伸ばすのは PC の側だけ（stage094.main）
test('D16: 15 秒の会議は待ちが 3 を越えて増えても区切りを伸ばさない（背圧は PC の側だけ）', T, async () => {
  // --relay=lag（中継の前で 300 ミリ秒ずつ止める。区間を 50 ミリ秒ごとに送り、待ちが 4 になる）で、今までと同じ詰まり方を作る
  const o = await run(['text', '--relay=lag', '--segs=5']);
  assert.deepStrictEqual(starts(o), [15]);
  assert.deepStrictEqual(live(o), [], `クラウドの側を背圧で伸ばした: ${JSON.stringify(o.overlaySent)}`);
  assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
});

test('D16・F13: 始めに /health を聞かない（録音の始まりを待たせない）', T, async () => {
  const o = await run(['text', '--relay=text', '--segs=1']);
  const first = o.order.findIndex((x) => x.startsWith('relay '));
  assert.ok(first > 0, `中継への要求が無いか、録音バーより前: ${JSON.stringify(o.order)}`);
  assert.strictEqual(o.order[0], 'overlay:start', JSON.stringify(o.order));
});
