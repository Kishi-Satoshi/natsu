/*
 * stage181.lib.test.js — 0.18.1（計画 docs/plans/2026-11-25-181.md）の純粋な部分。
 *  PF-1: 文字起こしのスレッドの既定（lib.defaultThreads。settings.js の defaultSettings も同じ数）・前の版の既定（lib.oldDefaultThreads）と移し（lib.oldDefaultsPatch）
 *  PF-2: 文字起こしの間隔の既定 30 秒（settings.js・lib.segmentBaseMs）・前の版の 75 秒の移し（lib.oldDefaultsPatch）・録音中は変えない（F260）
 *  PF-3: 「遅い」の覚えの印（lib.paceStamp・lib.sameStamp。印の違う覚えは無いのと同じ）と覚える条件（lib.paceSaved。速さの数 3 つ以上で理由 two・big だけ）
 *  PF-4: 会議の後の待ち時間（lib.localTimeoutMs の after。rtf が空なら 3）・残ったエンジンの照らし（lib.tasklistImageOf・lib.orphanMatches）
 *  PF-5: ヘルプ trouble/slow-pc（3 回までは時間切れの区間にも当たる・PC が重いときはスレッド数を下げる・覚えと録音の始まりの直し）
 *  AQ181-14: 前の版の既定の移しを1回だけにする（lib.oldDefaultsOnce と印 defaultsMigrated。印は settings.js の決まりの表に無い知らないキー）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/mainlib');
const S = require('../src/settings');

const T = { timeout: 5000 };
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// ---------------------------------------------------------------- PF-1（決めたこと 1〜3）
test('PF-1 既定のスレッドの表: 論理 CPU が 4 より多ければ 4、4 以下なら max(2, floor(n / 2))。settings.js の既定も同じ数', T, () => {
  const table = [[1, 2], [2, 2], [3, 2], [4, 2], [5, 4], [6, 4], [8, 4], [12, 4], [16, 4], [20, 4], [64, 4]];
  for (const [n, t] of table) {
    assert.strictEqual(L.defaultThreads(n), t, `論理 CPU ${n}`);
    assert.strictEqual(S.defaultSettings(n).localThreads, t, `settings.js の既定（論理 CPU ${n}）`);
  }
  // 数でない・0 以下は論理 CPU 1 とみる（os.cpus() が空の PC）
  for (const n of [0, -1, NaN, undefined, null, '8']) assert.strictEqual(L.defaultThreads(n), 2, String(n));
});

test('PF-1 前の版の設定: 前の既定（max(4, n − 2)・max(4, floor(n / 2))）と同じスレッドの数だけを新しい既定へ移す。選んだ数・新しい既定と同じ数・ほかのキーは触らない', T, () => {
  assert.deepStrictEqual(L.oldDefaultThreads(12), [10, 6]);
  assert.deepStrictEqual(L.oldDefaultThreads(8), [6]);   // max(4, 6)・max(4, 4)
  assert.deepStrictEqual(L.oldDefaultThreads(4), [4]);   // CI の機械（論理 CPU 4）: 前の既定 4 → 新しい既定 2
  assert.deepStrictEqual(L.oldDefaultThreads(6), []);    // 前の既定はどちらも 4 で、新しい既定と同じ
  const patch = (localThreads, n) => L.oldDefaultsPatch({ localThreads, language: 'ja' }, n);
  assert.deepStrictEqual(patch(10, 12), { localThreads: 4 });
  assert.deepStrictEqual(patch(6, 12), { localThreads: 4 });
  assert.deepStrictEqual(patch(4, 4), { localThreads: 2 });
  assert.deepStrictEqual(patch(6, 8), { localThreads: 4 });
  // 持ち主の PC（論理 CPU 12）の 4 は前の既定と違う（新しい既定と同じ）ので移さない。自分で選んだ 8・3 も残す
  for (const [t, n] of [[4, 12], [8, 12], [3, 4], [2, 4], [4, 6], [12, 12]]) assert.deepStrictEqual(patch(t, n), {}, `${t} スレッド・論理 CPU ${n}`);
  assert.deepStrictEqual(L.oldDefaultsPatch(null, 12), {});
  assert.deepStrictEqual(L.oldDefaultsPatch({ localThreads: '10' }, 12), {});   // 数でない（読み込みの決まりを通る前の形）は触らない
});

// ---------------------------------------------------------------- PF-2（決めたこと 4）
test('PF-2 間隔の既定: 設定の既定は 30 秒。読み直しの既定も 30 秒。PC の中の会議の区切りは設定が無ければ 30 秒（90 秒まで）。クラウドの会議は 15 秒のまま', T, () => {
  for (const n of [2, 4, 12]) assert.strictEqual(S.defaultSettings(n).segmentSec, 30, `論理 CPU ${n}`);
  for (const v of ['abc', null, undefined]) assert.strictEqual(S.normalizeSettings({ segmentSec: v }, {}).segmentSec, 30, String(v));
  assert.strictEqual(S.normalizeSettings({ segmentSec: 'abc' }, S.defaultSettings(8)).segmentSec, 30);
  assert.strictEqual(S.readSettings({ segmentSec: 'x' }, S.defaultSettings(8)).settings.segmentSec, 30);
  for (const v of [undefined, null, 0, '', 'x']) assert.strictEqual(L.segmentBaseMs('long', v), 30000, String(v));
  assert.strictEqual(L.segmentBaseMs('long', 45), 45000);
  assert.strictEqual(L.segmentBaseMs('long', 75), 75000);   // 自分で選んだ 75 は読み込みの後なら使う（移すのは起動のときだけ）
  assert.strictEqual(L.segmentBaseMs('long', 120), 90000);
  for (const v of [undefined, 30, 75]) assert.strictEqual(L.segmentBaseMs('short', v), 15000, String(v));
});

test('PF-2 前の版の間隔: 前の版の既定のままの 75 秒だけを 30 秒へ移す。ほかの秒・スレッドとの組み合わせ', T, () => {
  assert.deepStrictEqual(L.oldDefaultsPatch({ segmentSec: 75 }, 12), { segmentSec: 30 });
  assert.deepStrictEqual(L.oldDefaultsPatch({ segmentSec: 75, localThreads: 10 }, 12), { localThreads: 4, segmentSec: 30 });
  for (const v of [30, 20, 60, 74, 76, 90, 150, '75']) assert.deepStrictEqual(L.oldDefaultsPatch({ segmentSec: v, localThreads: 8 }, 12), {}, String(v));
});

// ---------------------------------------------------------------- 0.18.1 AQ181-14（決めたこと 3・4 の一度だけの移し。計画の CR25〜CR27）
test('AQ181-14 一度だけの移し: 読めた設定に印が無ければ前の版の既定を移し、印を付けて書く（移すものが無くても印は書く）。印があれば何もしない。無い・壊れた設定は印だけで書かない。読めない間は何もしない', T, () => {
  assert.strictEqual(L.DEFAULTS_MOVED_KEY, 'defaultsMigrated');
  assert.strictEqual(L.DEFAULTS_MOVED_VER, 1);
  const K = L.DEFAULTS_MOVED_KEY;
  const old = { localThreads: 10, segmentSec: 75, language: 'ja' };
  const moved = { patch: { localThreads: 4, segmentSec: 30 }, mark: true, write: true };
  const none = { patch: {}, mark: false, write: false };
  assert.deepStrictEqual(L.oldDefaultsOnce(old, 12, 'ok'), moved);
  // 前の既定でない数（自分で選んだ 8・60）は触らないが、印は書く（後で 10・75 を選んでも、次の起動で移さないため）
  assert.deepStrictEqual(L.oldDefaultsOnce({ localThreads: 8, segmentSec: 60 }, 12, 'ok'), { patch: {}, mark: true, write: true });
  // 印がある（0.18.1 で一度起動した）: その後に自分で選んだ 10・75 は残す。後の版の印（2）も同じ
  assert.deepStrictEqual(L.oldDefaultsOnce({ ...old, [K]: 1 }, 12, 'ok'), none);
  assert.deepStrictEqual(L.oldDefaultsOnce({ ...old, [K]: 2 }, 12, 'ok'), none);
  // 形の違う印（手で書き換えた）は無いのと同じ（もう一度移して印を書き直す）
  for (const v of ['1', 0, -1, true, null, 1.5, {}]) assert.deepStrictEqual(L.oldDefaultsOnce({ ...old, [K]: v }, 12, 'ok'), moved, JSON.stringify(v));
  // 無い（新しく入れた PC）・壊れていて退けた設定: 既定で動くので移すものは無い。印だけ付け、起動では書かない（次のふつうの保存に印が乗る）
  for (const st of ['missing', 'broken']) assert.deepStrictEqual(L.oldDefaultsOnce({ localThreads: 4, segmentSec: 30 }, 12, st), { patch: {}, mark: true, write: false }, st);
  // 読めない間は何もしない（読み直しで読めたときに移す。読めないファイルは上書きしない）
  assert.deepStrictEqual(L.oldDefaultsOnce(old, 12, 'unreadable'), none);
  assert.deepStrictEqual(L.oldDefaultsOnce(null, 12, 'ok'), none);
});

test('AQ181-14 印の読み書き: 印は settings.js の決まりの表に無い知らないキー。読み込み（readSettings）で直さずに残り、既定には無く、画面からは保存させない（pickSavable が落とす）', T, () => {
  const r = S.readSettings({ localThreads: 10, segmentSec: 75, defaultsMigrated: 1 }, S.defaultSettings(12));
  assert.strictEqual(r.settings.defaultsMigrated, 1);
  assert.deepStrictEqual([r.settings.localThreads, r.settings.segmentSec], [10, 75]);
  assert.deepStrictEqual(r.repaired, []);
  assert.ok(!S.SETTING_KEYS.includes('defaultsMigrated'));
  assert.ok(!('defaultsMigrated' in S.defaultSettings(12)));
  assert.deepStrictEqual(S.pickSavable({ defaultsMigrated: 1, theme: 'dark' }), { theme: 'dark' });
});

test('PF-2・F260: 録音中に保存した文字起こしの間隔は前の値に留める（会議の区切りは会議の初めの設定のまま）', T, () => {
  const g = L.guardEngineSettings({ segmentSec: 30, language: 'ja' }, { segmentSec: 60, language: 'ja' }, true);
  assert.strictEqual(g.settings.segmentSec, 30);
  assert.deepStrictEqual(g.kept, ['segmentSec']);
  assert.strictEqual(L.guardEngineSettings({ segmentSec: 30 }, { segmentSec: 60 }, false).settings.segmentSec, 60);
});

test('PF-2 字（決めたこと 5）: 設定の説明・ヘルプ・README の既定の区切りは 30 秒。kotoba-whisper の案内は「長い区切りの文字起こし」。75 秒の既定を言う字は残らない', T, () => {
  assert.ok(read('src', 'renderer', 'app.html').includes('文の切れ目が増えます（既定30秒。最初の1回は20秒）。'), '設定の説明');
  const stops = read('help', 'articles', 'trouble', 'transcription-stops.md');
  assert.ok(stops.includes('PC の中で文字起こしする間は区切りが長い（既定 30 秒）ので、'), 'transcription-stops.md');
  assert.ok(read('help', 'articles', 'settings', 'offline.md').includes('区切りが設定の長さ（既定 30 秒）なので、クラウド（15 秒）より'), 'offline.md');
  assert.ok(read('help', 'articles', 'record', 'status-line.md').includes('設定の長さ（既定 30 秒。最初の1回は 20 秒。長くても 90 秒）ずつです。'), 'status-line.md');
  const readme = read('README.md');
  assert.ok(readme.includes('- 録音 → 約30秒ごと（PC の中で文字起こしする会議。クラウドは 15 秒ごと）にリアルタイム文字起こし（最初の1回は20秒で早く結果を出す）'), 'README の機能の行');
  assert.ok(readme.includes('PC の中で文字起こしする会議は今までどおり設定の長さ（既定 30 秒）です。'), 'README の区切りの行');
  assert.ok(readme.includes('NaTsu の長い区切りの文字起こしでは'), 'README の kotoba の行');
  assert.ok(read('src', 'main.js').includes("const KOTOBA_NOTE = '文字起こしのモデルが kotoba-whisper です。長い区切りの文字起こしでは文の抜け落ちが多いため、'"), 'KOTOBA_NOTE');
  for (const [f, t] of [['README.md', readme], ['help/articles/trouble/transcription-stops.md', stops], ['src/main.js', read('src', 'main.js')]]) {
    assert.ok(!/既定 ?75 ?秒|約75秒ごと|75 秒ずつの文字起こし/.test(t), `${f} に 75 秒の既定の字が残っている`);
  }
});

// ---------------------------------------------------------------- PF-3（決めたこと 6）
const DAY = 24 * 3600 * 1000;
const MODEL = { name: 'ggml-large-v3-turbo-q5_0.bin', size: 574041195 };
const NOW = 1_800_000_000_000;
test('PF-3 前の版の覚え: 印（エンジンの組・スレッドの数・優先度の版 2）が無い・違う「遅い」の覚えは会議の始めに使わない。印が同じなら今どおり使う。前の覚えの rtf は印が違えば混ぜない', T, () => {
  const STAMP = L.paceStamp({ set: 'manual', threads: 4 });
  assert.deepStrictEqual(STAMP, { set: 'manual', threads: 4, prio: 2 });
  for (const x of [{}, { set: '', threads: 4 }, { set: 'manual', threads: 0 }, { set: 'manual', threads: '4' }, { set: 5, threads: 4 }]) assert.strictEqual(L.paceStamp(x), null, JSON.stringify(x));
  const saved = (stamp) => ({ schema: 1, model: MODEL, rtf: 1.6, slow: true, at: NOW - DAY, from: 'live', ...(stamp === undefined ? {} : { stamp }) });
  const start = (sv) => L.paceStep(undefined, { kind: 'start', saved: sv, model: MODEL, stamp: STAMP, now: NOW });
  // 0.18.0 までの覚え（印が無い）・スレッドの数が違う・組が違う・優先度の版が違う・形の違う印は、無いのと同じ
  for (const st of [undefined, null, { set: 'manual', threads: 8, prio: 2 }, { set: 'whisper-1.9.5-vk', threads: 4, prio: 2 }, { set: 'manual', threads: 4, prio: 1 }, { set: 'manual', threads: 4 }, 'manual']) {
    const r = start(saved(st));
    assert.ok(r.slow === false && r.why === '', JSON.stringify(st));
  }
  const same = start(saved({ set: 'manual', threads: 4, prio: 2 }));
  assert.ok(same.slow === true && same.why === 'saved');
  // 会議に印が無い（モデルが分からない形と同じ）なら使わない
  assert.strictEqual(L.paceStep(undefined, { kind: 'start', saved: saved(STAMP), model: MODEL, stamp: null, now: NOW }).slow, false);
  assert.ok(L.sameStamp(STAMP, { set: 'manual', threads: 4, prio: 2 }) && !L.sameStamp(STAMP, null) && !L.sameStamp(null, null));
  // 書く覚えには印を書く。印の違う前の覚えの rtf は混ぜない（印が同じなら今どおり混ぜる）
  const st = { slow: false, why: '', run: 0, rtf: 0.5, samples: 3 };
  const w = L.paceSaved(st, { schema: 1, model: MODEL, rtf: 3, slow: false, at: NOW - DAY, from: 'live' }, { model: MODEL, stamp: STAMP, now: NOW, from: 'live' });
  assert.deepStrictEqual(w, { schema: 1, model: MODEL, stamp: STAMP, rtf: 0.5, slow: false, at: NOW, from: 'live' });
  const mixed = L.paceSaved(st, { schema: 1, model: MODEL, stamp: STAMP, rtf: 1.5, slow: false, at: NOW - DAY, from: 'live' }, { model: MODEL, stamp: STAMP, now: NOW, from: 'live' });
  assert.strictEqual(mixed.rtf, 1);
  // 印が分からない会議は書かない
  assert.strictEqual(L.paceSaved(st, null, { model: MODEL, stamp: null, now: NOW, from: 'live' }), null);
});

test('PF-3 覚える条件: 「遅い」と覚えるのは、その会議で速さの数が 3 つ以上あり、理由が two・big のときだけ。時間切れ1回・待ちだけ・数の少ない会議の「遅い」は、その会議の中だけ（覚えは遅くない）', T, () => {
  const STAMP = L.paceStamp({ set: 'manual', threads: 4 });
  const save = (st) => L.paceSaved(st, null, { model: MODEL, stamp: STAMP, now: NOW, from: 'live' });
  const run = (evs) => evs.reduce((st, ev) => L.paceStep(st, ev).st, L.paceStep(undefined, { kind: 'start', saved: null, model: MODEL, stamp: STAMP, now: NOW }).st);
  const S = (procMs) => ({ kind: 'sample', audioMs: 30000, procMs });
  // 時間切れ1回（速さの数なし）: その会議は遅いが、覚えない（書かない）
  const late = run([{ kind: 'late' }]);
  assert.ok(late.slow && late.why === 'late');
  assert.strictEqual(save(late), null);
  // 速さの数がある会議の時間切れ・待ち: 覚えは遅くない（rtf だけ）
  const late1 = run([S(24000), { kind: 'late' }]);
  assert.deepStrictEqual([late1.slow, save(late1).slow, save(late1).rtf], [true, false, 0.8]);
  const backlog = run([S(24000), S(24000), S(24000), { kind: 'backlog', audioMs: 300000 }]);
  assert.deepStrictEqual([backlog.slow, backlog.why, save(backlog).slow], [true, 'backlog', false]);
  // two・big でも速さの数が 3 つに満たなければ覚えない
  const two2 = run([S(36000), S(36000)]);
  assert.deepStrictEqual([two2.slow, two2.why, two2.samples, save(two2).slow], [true, 'two', 2, false]);
  const big1 = run([S(60000)]);
  assert.deepStrictEqual([big1.slow, big1.why, save(big1).slow], [true, 'big', false]);
  // 3 つ以上で two・big は覚える
  const two3 = run([S(24000), S(36000), S(36000)]);
  assert.deepStrictEqual([two3.slow, two3.why, two3.samples, save(two3).slow], [true, 'two', 3, true]);
  const big3 = run([S(24000), S(24000), S(60000)]);
  assert.deepStrictEqual([big3.why, save(big3).slow], ['big', true]);
  // 遅くない会議は今どおり遅くないと書く
  assert.strictEqual(save(run([S(15000), S(15000), S(15000)])).slow, false);
});

// ---------------------------------------------------------------- PF-4（決めたこと 7・8）
test('PF-4 会議の後の待ち時間: 会議の後の頼み（after）は、覚えの rtf が空なら 3 とみる（90 秒の区間で 600 秒・30 秒の区間で 240 秒）。覚えの rtf があればそれ。会議中は今どおり 1', T, () => {
  assert.strictEqual(L.localTimeoutMs({ audioMs: 90000, after: true }), 600000);
  assert.strictEqual(L.localTimeoutMs({ audioMs: 30000, after: true }), 240000);
  assert.strictEqual(L.localTimeoutMs({ audioMs: 120000, after: true }), 780000);
  assert.strictEqual(L.localTimeoutMs({ audioMs: 120000, rtf: 1.7, after: true }), 468000);
  assert.strictEqual(L.localTimeoutMs({ audioMs: 120000, rtf: 0.5, after: true }), 300000);   // rtf は 1 より小さくしない（今どおり）
  assert.strictEqual(L.localTimeoutMs({ audioMs: 600000, after: true }), 1800000);   // 30 分まで
  assert.strictEqual(L.localTimeoutMs({ audioMs: 90000 }), 240000);
  assert.strictEqual(L.localTimeoutMs({ audioMs: 120000 }), 300000);
  assert.strictEqual(L.localTimeoutMs({ audioMs: 120000, after: false }), 300000);
});

test('PF-4 ほかのプロセス: tasklist の答え（CSV）から、その番号のプロセスの名前だけを読む。記録の名前と同じ（大文字小文字は問わない）ときだけ止める', T, () => {
  const line = (name, pid) => `"${name}","${pid}","Console","1","123,456 K"\r\n`;
  assert.strictEqual(L.tasklistImageOf(line('whisper-server.exe', 4321), 4321), 'whisper-server.exe');
  assert.strictEqual(L.tasklistImageOf(line('whisper-server.exe', 4321), 432), null);
  assert.strictEqual(L.tasklistImageOf('INFO: No tasks are running which match the specified criteria.\r\n', 4321), null);
  for (const x of ['', null, undefined, 42, '"a","b"', 'whisper-server.exe 4321']) assert.strictEqual(L.tasklistImageOf(x, 4321), null, String(x));
  assert.strictEqual(L.tasklistImageOf(`${line('chrome.exe', 1)}${line('Whisper-Server.EXE', 4321)}`, 4321), 'Whisper-Server.EXE');
  const rec = { schema: 1, pid: 4321, exe: 'whisper-server.exe' };
  assert.strictEqual(L.orphanMatches(rec, 'whisper-server.exe'), true);
  assert.strictEqual(L.orphanMatches(rec, 'WHISPER-SERVER.EXE'), true);
  // 番号がほかのアプリに再び使われている（F259）・分からない・記録の形が悪い → 止めない
  for (const [r, img] of [[rec, 'chrome.exe'], [rec, null], [rec, ''], [null, 'whisper-server.exe'], [{ pid: 4321 }, 'whisper-server.exe'], [{ pid: 'x', exe: 'whisper-server.exe' }, 'whisper-server.exe'], [{ pid: 0, exe: 'whisper-server.exe' }, 'whisper-server.exe']]) {
    assert.strictEqual(L.orphanMatches(r, img), false, JSON.stringify([r, img]));
  }
});

// ---------------------------------------------------------------- PF-5（決めたこと 9）
test('PF-5 ヘルプ: trouble/slow-pc は「3 回まで試して」が時間内に終わらない区間にも当たり、その区間は後ろへ回すと書く。PC 全体が重いときの手（スレッド数を下げる）がある。覚えと録音を始めたときの形が 0.18.1 のコードと同じ', T, () => {
  const t = read('help', 'articles', 'trouble', 'slow-pc.md');
  const sec = (id) => { const i = t.indexOf(`{#${id}}`); assert.ok(i > 0, `節 #${id} が無い`); const j = t.indexOf('\n## ', i); return t.slice(i, j < 0 ? t.length : j); };
  const kept = sec('kept');
  assert.ok(kept.includes('PC の文字起こしが何度も失敗する区間（時間内に終わらなかった区間も）は、3 回まで試して、その後は自動ではやり直さずに音声を残します。'), kept);
  assert.ok(kept.includes('時間内に終わらなかった区間は、待ち行列の後ろへ回し、ほかの区間を先に文字起こしします。'), kept);
  const heavy = sec('heavy');
  for (const w of ['会議のアプリや画面の操作より後に回し', '優先度を「通常より低い」', '既定で 4 まで', '「スレッド数」', '［設定］の「ローカル AI」の「詳細設定」', '遅くなります']) assert.ok(heavy.includes(w), `『PC 全体が重いとき』に「${w}」が無い`);
  assert.ok(/^## PC 全体が重いとき \{#heavy\}$/m.test(t), '見出し');
  const what = sec('what');
  assert.ok(what.includes('PC で 3 区間以上文字起こしした会議で、区間の長さより長くかかった区間が 2 つ続いた・1 つで 1.5 倍を越えたときだけ'), what);
  assert.ok(!what.includes('判断は使っている文字起こしのモデルごとに 14 日覚え'), '前の覚えの形が残っている');
  const after = sec('after');
  assert.ok(after.includes('録音を始めたときに文字起こししていた区間は、録音が終わってからもう一度文字起こしします。'), after);
  assert.ok(/^updated: 2026-11-2[5-9]$/m.test(t), 'updated を直していない');
  // 画面に無い言葉の［…］を足さない（設定の場所は「…」で書く）
  assert.ok(!/［詳細設定］|［スレッド数］|［ローカル AI］/.test(t), '［…］に画面のボタンでない言葉');
});

// ---------------------------------------------------------------- PF-6（決めたこと 10・AQ181-10〜AQ181-12 の (a)）
// 議事録の上の行（lib.routeLabel）で、PC の中で文字起こしした区間を「オフライン」と呼ぶ。保存の形（route.stt.local）は変えない
test('PF-6 経路の行: PC の中だけの会議は「🖥 文字起こし: オフライン」、クラウドと混ざった会議は「…12・オフライン 2」。クラウドだけは今どおり。「PC」の字は出さない', T, () => {
  assert.deepStrictEqual(L.routeLabel({ stt: { cloud: 0, local: 3 } }, ''), ['🖥 文字起こし: オフライン']);
  assert.deepStrictEqual(L.routeLabel({ stt: { cloud: 12, local: 2, provider: 'openai' } }, 'OpenAI'), ['☁ 文字起こし: クラウド（OpenAI）12・オフライン 2']);
  assert.deepStrictEqual(L.routeLabel({ stt: { cloud: 5, local: 0, provider: 'openai' } }, 'OpenAI'), ['☁ 文字起こし: クラウド（OpenAI）5']);
  for (const r of [{ stt: { cloud: 0, local: 1 } }, { stt: { cloud: 1, local: 1 } }, { stt: { cloud: 0, local: 2 }, summary: { by: 'local' } }]) {
    for (const l of L.routeLabel(r, 'OpenAI')) assert.ok(!/PC/.test(l), `「PC」が残っている: ${l}`);
  }
});

test('PF-6 要約の行: 0.9.x で PC の中で作った要約（by local）は「🖥 要約: オフライン」。ほかの要約の行は今どおり', T, () => {
  assert.deepStrictEqual(L.routeLabel({ stt: { cloud: 0, local: 2 }, summary: { by: 'local' } }, ''), ['🖥 文字起こし: オフライン', '🖥 要約: オフライン']);
  assert.deepStrictEqual(L.routeLabel({ summary: { by: 'local' } }, ''), ['🖥 要約: オフライン']);
  assert.deepStrictEqual(L.routeLabel({ summary: { by: 'claude-code' } }, ''), ['✨ 要約: Claude Code']);
  assert.deepStrictEqual(L.routeLabel({ summary: { by: 'claude' } }, ''), ['🤖 要約: Claude（本人）']);
});

test('PF-6 字: ヘルプ（record/status-line・summary/how-summaries）と README の例の字が新しい名前。録音中の「文字起こし中（この PC）」・ローカル AI の設定の字は変えない', T, () => {
  const ex = '「☁ 文字起こし: クラウド（OpenAI）12・オフライン 2」「✨ 要約: Claude Code」のように出ます';
  const old = '（0.9.x で PC の中で作った要約は「🖥 要約: オフライン」と出ます）';
  const status = read('help', 'articles', 'record', 'status-line.md');
  const how = read('help', 'articles', 'summary', 'how-summaries.md');
  const readme = read('README.md');
  assert.ok(status.includes(ex) && status.includes(old), 'record/status-line.md');
  assert.ok(how.includes('「✨ 要約: Claude Code」のように出ます') && how.includes(old), 'summary/how-summaries.md');
  assert.ok(readme.includes(ex) && readme.includes(old), 'README.md');
  for (const [f, t] of [['record/status-line.md', status], ['summary/how-summaries.md', how]]) assert.ok(/^updated: 2026-11-2[6-9]$/m.test(t), `${f}: updated を直していない`);
  for (const [f, t] of [['record/status-line.md', status], ['summary/how-summaries.md', how], ['README.md', readme]]) {
    assert.ok(!/文字起こし: PC|・PC \d|要約: PC/.test(t), `${f} に前の名前が残っている`);
  }
  // 変えない所（AQ181-11 の (a)）
  const app = read('src', 'renderer', 'app.html');
  assert.ok(app.includes("const head = `文字起こし中（${s.route === 'cloud' ? 'クラウド' : 'この PC'}）`;"), '録音中の状態の行を変えた');
  assert.ok(app.includes('ローカル AI'), '設定のローカル AI の字');
});
