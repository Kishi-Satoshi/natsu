/*
 * stage1d.status.test.js — 第1d回 Task A-6（RL14・D17・F14・F15・RF39）: main が会議ごとに持つ文字起こしの状態（meetingStatus().stt）を、
 * 偽の Electron の上で main.js を本当に動かして確かめる（helpers/mainrun.js の --relay・--relay-seq・--retry-after・--relogin-after）。
 * 中継は本物の relay/ のコードを 127.0.0.1 で包んだもの（helpers/relay-local.js）。
 * out.sttSeen は本体の窓へ送った meeting:update の stt の、前と違ったものだけの並び。out.sttAt は帯の符号 → その符号が初めて帯になった
 * ときの区間（wav はそのとき segbuf にその区間の WAV があるか）。帯の文は計画「画面と知らせの文」の B1〜B10 のまま（画面は文を作らない）。
 * A-8（RL15・D17・F15）: 録音中のページが見えないときの Windows の知らせ（out.notifications。本文は WN1〜WN4 のまま）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');
const { RELAY_BASE } = require('../src/relay');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const HOST = new URL(RELAY_BASE).host;
// NATSU_TEST_ONLINE_MEMO_SCALE: 届くかの覚えを縮め、区間ごとに中継の答えを替えても次の区間で気づくようにする（stage1d.seg と同じ）
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001' }, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      const o = JSON.parse(stdout.trim().split('\n').pop());
      seen.push(o);
      resolve(o);
    });
});
const seen = [];   // F9: 全部の場面の出力を最後に合わせて見る
const T = { timeout: sceneTimeout(20000) };
const B = {
  'engine-down': 'PC の中の文字起こしエンジンが動いていません（音声は残してあります）。［エンジンを確かめる］を押してください。',
  login: 'ログインが切れたため、この PC で文字起こしを続けていますが、精度が落ちます。［ログインし直す］を押して、もう一度ログインしてください。',
  'relay-off': '文字起こしの中継が今は使えないため、この PC で文字起こしを続けていますが、精度が落ちます。続くときは管理者に知らせてください。',
  'daily-cap': '今日のクラウドの文字起こしの上限に達したため、今日の残りはこの PC で文字起こしします。精度が落ちます。録音はそのまま続けてください。',
  'relay-blocked': `文字起こしの中継につながりません（会社の通信の検査で止められている可能性があります）。この PC で文字起こしを続けていますが、精度が落ちます。続くときは情報システムに ${HOST} への通信の許可を頼んでください。`,
  'relay-down': 'NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。',
  'relay-busy': '文字起こしの中継が混み合っているため、この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。',
};
const LOCAL_TEXT = '手元で起こした文です';
const STALL_SEG = '（音はありましたが、文字になりませんでした）';
// 帯の符号の移り変わり（続けて同じ符号は1つにまとめる。帯が無いのは null）
const codes = (o) => o.sttSeen.map((s) => (s && s.problem ? s.problem.code : null)).filter((c, i, a) => i === 0 || a[i - 1] !== c);
const problemOf = (o, code) => o.sttSeen.map((s) => s && s.problem).find((p) => p && p.code === code);
const last = (o) => o.sttSeen[o.sttSeen.length - 1];
const texts = (segs) => segs.length > 0 && segs.every((s) => !s.failed && s.text.startsWith('本日の議題は進捗の確認です'));
const bandLines = (o, code) => o.engineLog.filter((l) => l === `文字起こしの状態: 帯 ${code}`);
const STT_POST = '/v1/audio/transcriptions';
// userData の下に残った区間の控えの WAV（data/segbuf/<会議>/<番号>.wav）
const segWavs = (o) => o.files.filter((f) => /segbuf\/.*\.wav$/i.test(f));
const emptyLine = (o, id) => o.engineLog.some((l) => l.startsWith(`区間 ${id}（`) && l.endsWith('文字起こしが空のため除きました'));

test('D17: クラウドで文字になると stt.route は cloud・lastTextAt が入り・segSec は 15・帯は無い', T, async () => {
  const o = await run(['text', '--relay=text', '--segs=3']);
  assert.ok(o.sttSeen.length >= 2, JSON.stringify(o.sttSeen));
  assert.deepStrictEqual(o.sttSeen[0], { route: 'cloud', lastTextAt: null, segSec: 15, problem: null }, 'まだ文字が無いときは見込みの経路（ログインしてオンラインならクラウド）');
  const l = last(o);
  assert.strictEqual(l.route, 'cloud');
  assert.ok(Number.isInteger(l.lastTextAt) && l.lastTextAt > 1e12, JSON.stringify(l));
  assert.strictEqual(l.segSec, 15);
  assert.ok(o.sttSeen.every((s) => s.problem === null), JSON.stringify(o.sttSeen));
  assert.deepStrictEqual(Object.keys(l).sort(), ['lastTextAt', 'problem', 'route', 'segSec'], '画面へ渡す stt に決めた欄のほかが入った');
});

test('B8 → 戻る: 中継に届かなくなると帯 relay-down（文は表の B8 のまま・action \'\'）で PC で続き、クラウドで文字になると帯が消える', T, async () => {
  // 手元の whisper の文を中継の文と違えておく（どちらも「…区間N」の通し番号で、偶然同じ文になると直前と同じ文として除かれる）
  const o = await run(['text', '--relay-seq=cnnc', '--segs=4', `--text=${LOCAL_TEXT}`]);
  assert.deepStrictEqual(codes(o), [null, 'relay-down', null], JSON.stringify(o.sttSeen));
  assert.deepStrictEqual(problemOf(o, 'relay-down'), { code: 'relay-down', text: B['relay-down'], action: '' });
  assert.strictEqual(last(o).route, 'cloud');
  const segs = o.pages[0].segments;
  assert.deepStrictEqual(segs.map((x) => (x.failed ? 'failed' : x.text.replace(/区間\d+$/, ''))), ['本日の議題は進捗の確認です。', LOCAL_TEXT, LOCAL_TEXT, '本日の議題は進捗の確認です。'], JSON.stringify(segs));
  assert.strictEqual(bandLines(o, 'relay-down').length, 1, o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('文字起こしの状態: 帯を消した relay-down'), o.engineLog.join('\n'));
});

test('B7: cert は relay-blocked で、文に中継のホストの名前が入る（URL の道・札は入らない）', T, async () => {
  const o = await run(['text', '--relay=text', '--relay-cert', '--segs=2']);
  assert.deepStrictEqual(codes(o), [null, 'relay-blocked'], JSON.stringify(o.sttSeen));
  const p = problemOf(o, 'relay-blocked');
  assert.deepStrictEqual(p, { code: 'relay-blocked', text: B['relay-blocked'], action: '' });
  assert.ok(p.text.includes(HOST) && !/https?:|\/health|\/v1\/|nt1_/.test(p.text), p.text);
  assert.strictEqual(last(o).route, 'local');
  assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
});

// 第1d回 A-11 で意図して変えた: ログインし直すのは account:verify でなく account:login（Access のログインの窓）。'l' は偽の Access の取り消し
test('B3: 401 は login（action \'account\'）。account:login が通ると、区間を待たずに帯が消える', T, async () => {
  const o = await run(['text', '--relay-seq=cl', '--segs=3', '--relogin-after=2']);
  assert.deepStrictEqual(problemOf(o, 'login'), { code: 'login', text: B.login, action: 'account' });
  assert.strictEqual(o.relogin.login.ok, true, JSON.stringify(o.relogin));
  assert.strictEqual(o.reloginStt.problem, null, `ログインし直した直後に帯が残った: ${JSON.stringify(o.reloginStt)}`);
  // 帯を消したことを、区間を待たずに画面へ送る（login → null の移り変わりが、3 区間目の文字より前）
  const at = o.sttSeen.findIndex((s, i) => i > 0 && s.problem === null && o.sttSeen[i - 1].problem && o.sttSeen[i - 1].problem.code === 'login');
  assert.ok(at > 0 && o.sttSeen[at].lastTextAt === o.sttSeen[at - 1].lastTextAt, JSON.stringify(o.sttSeen));
  assert.deepStrictEqual(codes(o), [null, 'login', null], JSON.stringify(o.sttSeen));
  assert.ok(o.engineLog.includes('文字起こしの状態: 帯を消した login'), o.engineLog.join('\n'));
  assert.strictEqual(last(o).route, 'cloud', '3 区間目は新しい cookie でクラウド');
});

test('B6・B5: daily-cap（user）は daily-cap、quota は relay-off（どちらも action \'\'）', T, async () => {
  const [d, q] = await Promise.all([run(['text', '--relay=daily-cap', '--segs=3']), run(['text', '--relay=quota', '--segs=2'])]);
  assert.deepStrictEqual(codes(d), [null, 'daily-cap'], JSON.stringify(d.sttSeen));
  assert.deepStrictEqual(problemOf(d, 'daily-cap'), { code: 'daily-cap', text: B['daily-cap'], action: '' });
  assert.deepStrictEqual(codes(q), [null, 'relay-off'], JSON.stringify(q.sttSeen));
  assert.deepStrictEqual(problemOf(q, 'relay-off'), { code: 'relay-off', text: B['relay-off'], action: '' });
  for (const o of [d, q]) assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
});

test('B9 → 戻る: 1 区間だけ 502 なら relay-busy、次のクラウドの文字で消える', T, async () => {
  const o = await run(['text', '--relay-seq=c5c']);
  assert.deepStrictEqual(codes(o), [null, 'relay-busy', null], JSON.stringify(o.sttSeen));
  assert.deepStrictEqual(problemOf(o, 'relay-busy'), { code: 'relay-busy', text: B['relay-busy'], action: '' });
  assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
});

test('B10: 短い 429 の待ちの間は wait（sec つき）、送り直しで文字になったら消える', T, async () => {
  const o = await run(['text', '--relay=429', '--segs=2']);
  const p = problemOf(o, 'wait');
  assert.deepStrictEqual(p, { code: 'wait', text: 'OpenAI が混み合っているため、1 秒待ってから送り直しています。録音はそのまま続けてください。', action: '', sec: 1 });
  assert.deepStrictEqual(codes(o), [null, 'wait', null], JSON.stringify(o.sttSeen));
  assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
});

test('B1: 中継が止まっていて手元のエンジンも失敗すると engine-down（action \'engine\'）。区間は失敗として WAV が残る', T, async () => {
  // 計画は --relay-down --no-whisper。whisper の実行ファイルが無いと会議を始めない（startMeeting の whisperProblem）ので、
  // 手元のエンジンが 200 のまま誤りを返す err200 で「手元で文字起こしする区間で、エンジンが失敗した」を作る
  const o = await run(['err200', '--relay=text', '--relay-down', '--segs=2']);
  assert.deepStrictEqual(problemOf(o, 'engine-down'), { code: 'engine-down', text: B['engine-down'], action: 'engine' });
  assert.deepStrictEqual(codes(o), [null, 'engine-down'], JSON.stringify(o.sttSeen));
  const at = o.sttAt['engine-down'].filter((s) => !s.text || s.failed);   // まだ待ちの区間（本文が空）は除く
  assert.ok(at.some((s) => s.failed) && at.filter((s) => s.failed).every((s) => s.wav), JSON.stringify(o.sttAt));
});

test('B4 と［もう一度］: 長い 429 で2区間が失敗（seg-failed・n 2・action \'retry\'）。meeting:retry で2区間とも文字になり、帯が消え、WAV が消える。返事の前の2回目は n 0', T, async () => {
  const o = await run(['text', '--relay-seq=LLcc', '--retry-after=2']);
  const failed = o.sttSeen.map((s) => s.problem).filter((p) => p && p.code === 'seg-failed');
  assert.deepStrictEqual(failed[0] && failed[0].n, 1, '1 区間目の後は n 1');
  assert.deepStrictEqual(failed.find((p) => p.n === 2), { code: 'seg-failed', text: '2 区間の文字起こしに失敗しました（音声は残してあります）。［もう一度］を押してください。', action: 'retry', n: 2 });
  assert.ok(o.sttAt['seg-failed'].filter((s) => s.failed && s.wav).length >= 1, JSON.stringify(o.sttAt));
  assert.deepStrictEqual(o.retry, [{ ok: true, n: 2 }, { ok: true, n: 0 }]);
  assert.strictEqual(o.retried.stt.problem, null, JSON.stringify(o.retried));
  assert.deepStrictEqual(o.retried.segments.map((s) => [s.id, s.failed, s.wav]), [['s1', false, false], ['s2', false, false]], JSON.stringify(o.retried));
  assert.ok(texts(o.retried.segments), JSON.stringify(o.retried.segments));
  assert.deepStrictEqual(codes(o), [null, 'seg-failed', null], JSON.stringify(o.sttSeen));
  assert.ok(o.engineLog.includes('文字起こしの状態: もう一度 2 区間'), o.engineLog.join('\n'));
  assert.ok(texts(o.pages[0].segments) && o.pages[0].segments.length === 4, JSON.stringify(o.pages[0].segments));
});

test('B2（オフライン）: 音のある区間が手元の whisper で2つ続けて空なら stall。2区間は失敗（『音はありましたが、文字になりませんでした』）として WAV と一緒にページへ戻る', T, async () => {
  const o = await run(['empty', '--offline', '--segs=3']);
  const p = problemOf(o, 'stall');
  assert.deepStrictEqual(p, { code: 'stall', text: '文字起こしが止まっているかもしれません（音はあるのに、約 5 秒文字が出ていません）。［もう一度］で、その区間を送り直してください。', action: 'retry', sec: 5 });
  assert.deepStrictEqual(o.sttAt.stall.filter((s) => s.failed).map((s) => [s.id, s.text, s.wav]), [['s1', STALL_SEG, true], ['s2', STALL_SEG, true]], JSON.stringify(o.sttAt));
  assert.ok(o.engineLog.includes('文字起こしの状態: 止まっているかもしれない（音のある空の区間 2）'), o.engineLog.join('\n'));
  assert.ok(o.sttSeen.every((s) => s.route === 'local'), JSON.stringify(o.sttSeen));
  // 3 区間目は止まりの後の1つ目の音のある空で、控えたまま会議が終わる。締めでその WAV を消す（ページに無い音声を残さない）。
  // 止まりで戻した s1・s2 の WAV は会議の後の送り直しに載る（ここでは見ない）
  assert.ok(emptyLine(o, 's3'), o.engineLog.join('\n'));
  assert.deepStrictEqual(segWavs(o).filter((f) => /\/3\.wav$/.test(f)), [], `締めた後も控えた 3 区間目の WAV が残った: ${segWavs(o)}`);
});

test('B2（クラウド）: 15 秒の会議では3区間続けて空で stall（2区間では立たない）', T, async () => {
  const [a, b] = await Promise.all([run(['text', '--relay-seq=eeec', '--segs=4']), run(['text', '--relay-seq=eecc', '--segs=4'])]);
  // 4 区間目の文字で止まりの帯は消え、止まりで残した3区間（音声つき）の帯 seg-failed が残る（［もう一度］か会議の後の送り直しまで）
  assert.deepStrictEqual(codes(a), [null, 'stall', 'seg-failed'], JSON.stringify(a.sttSeen));
  assert.strictEqual(last(a).problem.n, 3, JSON.stringify(last(a)));
  const kept = a.sttAt.stall.filter((s) => s.failed);
  assert.deepStrictEqual(kept.map((s) => [s.id, s.text, s.wav]), [['s1', STALL_SEG, true], ['s2', STALL_SEG, true], ['s3', STALL_SEG, true]], JSON.stringify(a.sttAt));
  assert.deepStrictEqual(codes(b), [null], `2区間の空で止まりにした: ${JSON.stringify(b.sttSeen)}`);
});

test('D17: 無音の空の区間は止まりに数えない', T, async () => {
  const o = await run(['empty', '--offline', '--silent', '--segs=4']);
  assert.deepStrictEqual(codes(o), [null], JSON.stringify(o.sttSeen));
});

test('D17: 文字になった区間で数えが戻り、控えた WAV は消える', T, async () => {
  // 15 秒の会議の止まりは3区間。空・空・文字・空・空なら、数えが戻らないと4区間目で3に達して止まりになる（A-6 の点検で ecec から直した）
  const o = await run(['text', '--relay-seq=eecee', '--segs=5']);
  assert.ok(['s1', 's2', 's4', 's5'].every((id) => emptyLine(o, id)), o.engineLog.join('\n'));
  assert.deepStrictEqual(codes(o), [null], JSON.stringify(o.sttSeen));
  assert.deepStrictEqual(segWavs(o), [], '控えた WAV が残った');
});

test('D17: 会議を破棄すると、止まりの見張りで控えた WAV も消す（破棄は利用者の意思）', T, async () => {
  // オフラインは 75 秒の側で止まりは2区間。1区間目の音のある空は控えたまま、そこで破棄する
  const o = await run(['empty', '--offline', '--discard-during', '--discard-settled']);
  assert.strictEqual(o.settledBeforeDiscard, true);
  assert.ok(emptyLine(o, 's1'), o.engineLog.join('\n'));
  assert.deepStrictEqual(o.discard, { ok: true });
  assert.deepStrictEqual(segWavs(o), [], `破棄した会議の WAV が残った: ${segWavs(o)}`);
});

test('RF28: PC の中だけの会議の［もう一度］も PC の中で起こす（中継へ音声を送らない）。失敗のままなら区間と WAV は残る', T, async () => {
  const o = await run(['err200', '--relay-seq=cc', '--local-only', '--retry-after=1']);
  assert.deepStrictEqual(o.localOnly && o.localOnly.ok, true, JSON.stringify(o.localOnly));
  assert.deepStrictEqual(o.retry, [{ ok: true, n: 1 }, { ok: true, n: 0 }]);
  assert.strictEqual(o.relayCalls.filter((p) => p === STT_POST).length, 0, `PC の中だけの会議の音声を中継へ送った: ${o.relayCalls}`);
  assert.ok(o.engineLog.includes('文字起こしの経路: 区間 s1（もう一度） → local（理由: local-only）'), o.engineLog.join('\n'));
  assert.deepStrictEqual(o.retried.segments.map((s) => [s.id, s.failed, s.wav]), [['s1', true, true]], JSON.stringify(o.retried));
});

test('［もう一度］の直後に会議を止めても、締めは並べ直した区間の返事を待つ（待ちの数に入る）', T, async () => {
  // 1区間目は長い 429 で失敗。最後の区間を送った直後に［もう一度］: 並べ直した区間は最後の区間の後ろ。待ちに数えないと、
  // 最後の区間で締めてしまい、並べ直した区間は会議の後の送り直し（復旧 s1）に回る
  const o = await run(['text', '--relay-seq=Lc', '--retry-at-stop']);
  assert.deepStrictEqual(o.retryAtStop, { ok: true, n: 1 });
  assert.ok(!o.engineLog.some((l) => l.startsWith('文字起こしの経路: 復旧 s1')), `締めが［もう一度］を待たなかった: ${o.engineLog.join('\n')}`);
  assert.ok(o.engineLog.some((l) => l.startsWith('文字起こしの経路: 区間 s1（もう一度） → cloud')), o.engineLog.join('\n'));
  assert.ok(texts(o.pages[0].segments) && o.pages[0].segments.length === 2, JSON.stringify(o.pages[0].segments));
});

test('F15: 同じ問題が区間ごとに続いても帯は1つで、記録の『帯 relay-down』は1行', T, async () => {
  const o = await run(['text', '--relay=text', '--relay-down', '--segs=5']);
  assert.deepStrictEqual(codes(o), [null, 'relay-down'], JSON.stringify(o.sttSeen));
  assert.strictEqual(bandLines(o, 'relay-down').length, 1, o.engineLog.join('\n'));
  assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
});

// 0.13.2 LN-3（持ち主の答え LA2。RL14 を改めた）で意図して変えた: ログインしていない会議は帯 no-login だけを出す（中継の帯は今どおり出さない）。
// オフライン・PC の中だけの会議は今どおり帯を出さない
test('RF28: オフライン・PC の中だけの会議では帯を出さない。ログインしていない会議は帯 no-login だけ（route は local）', T, async () => {
  const outs = await Promise.all([['--offline'], ['--signed-out'], ['--local-only']].map((f) => run(['text', '--relay=text', ...f, '--segs=2'])));
  for (const [i, o] of outs.entries()) {
    if (i === 1) assert.ok(o.sttSeen.every((s) => s.problem === null || s.problem.code === 'no-login') && o.sttSeen.some((s) => s.problem && s.problem.code === 'no-login'), JSON.stringify(o.sttSeen));
    else assert.ok(o.sttSeen.every((s) => s.problem === null), JSON.stringify(o.sttSeen));
    assert.strictEqual(last(o).route, 'local', JSON.stringify(o.sttSeen));
    assert.ok(texts(o.pages[0].segments), JSON.stringify(o.pages[0].segments));
  }
  // オフライン・ログインしていない会議は、まだ文字が無いときから見込みが「この PC」
  assert.strictEqual(outs[0].sttSeen[0].route, 'local');
  assert.strictEqual(outs[1].sttSeen[0].route, 'local');
});

// ---------------------------------------------------------------- A-8（RL15・D17・F15）: 録音中のページが見えないときの Windows の知らせ
// out.notifications は偽の Notification の show() の { title, body }。--main-hidden は本体の窓が隠れている（isVisible が false）、
// --live-not-shown は画面が「録音中のページを開いていない」と知らせた（mainrun は既定で、会議を始めた後に画面と同じ meeting:live-shown true を送る）、
// --no-notify は Notification.isSupported() が false、--click-notify は出した知らせを押す（out.mainWinCalls・out.showLive）。
// 計画の外で足した: --main-minimized（最小化した窓）・--reload-main（画面の読み込み直し）。A-8 の点検で足した: --main-unfocused
// （窓は見えているが前にない）・--notify-throws（偽の Notification の show() が投げる）
const WN = {
  'engine-down': 'PC の中の文字起こしエンジンが動いていません。録音中のページを開いてください。',
  stall: '文字起こしが止まっているかもしれません。録音中のページを開いてください。',
  login: 'ログインが切れたため、この PC で文字起こししています（精度が落ちます）。録音中のページを開いてください。',
  'seg-failed': '文字起こしに失敗した区間があります（音声は残してあります）。録音中のページを開いてください。',
};
const winLines = (o, code) => o.engineLog.filter((l) => l === `文字起こしの状態: Windows の知らせ ${code}`);

test('D17: 窓が隠れているとき、エンジンが止まると Windows の知らせ WN1 が1回だけ（4 区間とも失敗でも）。本文は表のとおりで、文字起こしの文・ホスト・メールが無い', T, async () => {
  // 計画は --relay-down --no-whisper。whisper の実行ファイルが無いと会議を始めない（A-6 の B1 と同じ）ので、手元のエンジンが 200 のまま誤りを返す err200
  const o = await run(['err200', '--relay=text', '--relay-down', '--main-hidden', '--segs=4']);
  assert.deepStrictEqual(o.notifications, [{ title: 'NaTsu', body: WN['engine-down'] }], JSON.stringify(o.notifications));
  // 帯は engine-down の後に seg-failed も立つが、前の知らせから 5 分の間は出さない
  assert.ok(o.engineLog.includes('文字起こしの状態: 帯 seg-failed'), o.engineLog.join('\n'));
  assert.strictEqual(winLines(o, 'engine-down').length, 1, o.engineLog.join('\n'));
  assert.deepStrictEqual(o.engineLog.filter((l) => l.includes('Windows の知らせ')), ['文字起こしの状態: Windows の知らせ engine-down'], o.engineLog.join('\n'));
  assert.strictEqual(o.showLive, 0, '押していないのに録音中のページを開いた');
  assert.deepStrictEqual(o.mainWinCalls, [], '押していないのに窓を前に出した');
});

test('D17: 知らせを押すと窓が前に出て、画面に meeting:show-live が送られる', T, async () => {
  const o = await run(['err200', '--relay=text', '--relay-down', '--main-hidden', '--click-notify', '--segs=2']);
  assert.strictEqual(o.notifications.length, 1, JSON.stringify(o.notifications));
  assert.ok(o.mainWinCalls.includes('show') && o.mainWinCalls.includes('focus'), JSON.stringify(o.mainWinCalls));
  assert.strictEqual(o.showLive, 1);
});

test('D17: 窓が前にあり録音中のページを開いているときは出さない。窓は前でも画面が『録音中のページではない』と知らせていれば出す', T, async () => {
  const [shown, notShown, minimized, unfocused] = await Promise.all([
    run(['err200', '--relay=text', '--relay-down', '--segs=2']),
    run(['err200', '--relay=text', '--relay-down', '--live-not-shown', '--segs=2']),
    run(['err200', '--relay=text', '--relay-down', '--main-minimized', '--segs=2']),
    run(['err200', '--relay=text', '--relay-down', '--main-unfocused', '--segs=2']),
  ]);
  assert.deepStrictEqual(shown.notifications, [], '録音中のページが見えているのに Windows の知らせを出した');
  assert.ok(shown.engineLog.includes('文字起こしの状態: 帯 engine-down'), shown.engineLog.join('\n'));
  assert.ok(!shown.engineLog.some((l) => l.includes('Windows の知らせ')), shown.engineLog.join('\n'));
  assert.deepStrictEqual(notShown.notifications, [{ title: 'NaTsu', body: WN['engine-down'] }]);
  assert.deepStrictEqual(minimized.notifications, [{ title: 'NaTsu', body: WN['engine-down'] }], '最小化した窓を見えているとした');
  // ほかのアプリで作業している（窓は見えていて最小化もしていないが、前にない）: いちばんよくある場面（A-8 の点検で足した）
  assert.deepStrictEqual(unfocused.notifications, [{ title: 'NaTsu', body: WN['engine-down'] }], '前にない窓を見えているとした');
  // 画面を読み込み直すと、まだ録音中のページを開いていない扱いに戻る（開けば画面が知らせ直す）
  const reloaded = await run(['err200', '--relay=text', '--relay-down', '--reload-main', '--segs=2']);
  assert.deepStrictEqual(reloaded.notifications, [{ title: 'NaTsu', body: WN['engine-down'] }], '読み込み直す前の「録音中のページを開いている」を使い続けた');
});

test('D17: relay-down・daily-cap・relay-busy・wait は Windows の知らせにしない', T, async () => {
  const outs = await Promise.all([
    ['text', '--relay=text', '--relay-down', '--segs=3'],
    ['text', '--relay=daily-cap'],
    ['text', '--relay-seq=c5c'],
    ['text', '--relay=429'],
  ].map((a) => run([...a, '--main-hidden'])));
  for (const o of outs) {
    assert.ok(o.sttSeen.some((s) => s.problem), `帯が立たない場面になった: ${JSON.stringify(o.sttSeen)}`);
    assert.deepStrictEqual(o.notifications, [], JSON.stringify(o.sttSeen));
    assert.ok(!o.engineLog.some((l) => l.includes('Windows の知らせ')), o.engineLog.join('\n'));
  }
});

test('D17: 止まり・ログイン切れ・残した失敗の本文も表のとおり（WN2〜WN4）', T, async () => {
  const [stall, login, failed] = await Promise.all([
    run(['empty', '--offline', '--main-hidden', '--segs=3']),
    run(['text', '--relay-seq=cl', '--main-hidden', '--segs=2']),
    run(['text', '--relay-seq=LLcc', '--main-hidden']),
  ]);
  assert.deepStrictEqual(stall.notifications, [{ title: 'NaTsu', body: WN.stall }], '止まりの後の seg-failed は 5 分の間は出さない');
  assert.deepStrictEqual(login.notifications, [{ title: 'NaTsu', body: WN.login }]);
  assert.deepStrictEqual(failed.notifications, [{ title: 'NaTsu', body: WN['seg-failed'] }], '残した区間の数が増えても出すのは1回');
  assert.strictEqual(winLines(failed, 'seg-failed').length, 1, failed.engineLog.join('\n'));
});

test('D17: Windows の知らせが投げても区間は落ちない（4 区間ともページに残り、記録は『出せない』の1行）', T, async () => {
  // A-8 の点検で足した: setSttProblem は区間の流れの中で呼ばれるので、知らせの失敗が外へ出ると区間が1つ消える
  const o = await run(['err200', '--relay=text', '--relay-down', '--main-hidden', '--notify-throws', '--segs=4']);
  assert.deepStrictEqual(o.notifications, []);
  assert.strictEqual(o.pages[0].segments.length, 4, `知らせの失敗で区間が落ちた: ${JSON.stringify(o.pages[0].segments)}`);
  assert.deepStrictEqual(o.engineLog.filter((l) => l.includes('Windows の知らせ')), ['文字起こしの状態: Windows の知らせを出せない engine-down'], o.engineLog.join('\n'));
});

test('D17: Notification.isSupported() が false なら出さず、記録に符号だけ', T, async () => {
  const o = await run(['err200', '--relay=text', '--relay-down', '--main-hidden', '--no-notify', '--segs=2']);
  assert.deepStrictEqual(o.notifications, []);
  assert.deepStrictEqual(o.engineLog.filter((l) => l.includes('Windows の知らせ')), ['文字起こしの状態: Windows の知らせを出せない engine-down'], o.engineLog.join('\n'));
});

test('F9: stt・帯の文・engine.log に、文字起こしの文・札・メール・URL の道が無い', T, () => {
  assert.ok(seen.length >= 15, `場面の数 ${seen.length}`);
  for (const o of seen) {
    assert.ok(Array.isArray(o.sttSeen) && o.sttSeen.length > 0, '場面の出力に stt が無い');
    const s = JSON.stringify([o.sttSeen, o.sttAt && Object.values(o.sttAt).map((a) => a.map((x) => x.failed ? x.text : '')), o.reloginStt, o.retried && o.retried.stt]);
    assert.ok(!/本日の議題|手元で起こした|nt1_|@|https?:|\/health|\/v1\/|\/auth\//.test(s), s);
    const log = o.engineLog.join('\n');
    assert.ok(!/本日の議題|手元で起こした|nt1_|@|\/health|\/v1\/|\/auth\//.test(log), log);
    // A-8: Windows の知らせの本文は決まった文だけ（文字起こしの文・ホスト・メール・札が入らない）
    assert.ok(Array.isArray(o.notifications), '場面の出力に notifications が無い');
    for (const n of o.notifications) assert.ok(n.title === 'NaTsu' && Object.values(WN).includes(n.body), JSON.stringify(n));
  }
});
