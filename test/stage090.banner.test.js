/*
 * stage090.banner.test.js — 0.9.0 の帯の言葉（計画 docs/plans/2026-10-20-090.md の Task B-1・B-2。設計書 D26・BN1〜BN3）
 * B-1: PC で文字起こしに切り替えたと言う帯と知らせに「精度が落ちます」を足し、中継につながらない帯（B8）を利用者の文
 *      「NaTsu のサーバーにつながりません。…」にする（文だけ。符号・ボタン・並び・知らせの出し方は変えない）。
 * 文は main の STT_BANNER・STT_NOTICE・WIN_NOTIFY（画面は文を作らない）。ここでは src/main.js の字面からその3つの表を読み、
 * 関数を偽の詳しさ（{ホスト} は host を入れた形）で呼んで、計画の「帯の言葉」の表の 0.9.0 の文とちょうど同じかを見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const HOST = 'relay.example.test';
const T = { timeout: 5000 };

// main.js の `const NAME = {` から、行頭の `};` まで（1行の表はその行の `};` まで）を1つの式として読む
// （関数の表はそのまま関数になる。外の名前は使わない）
function tableOf(name) {
  const at = MAIN.indexOf(`\nconst ${name} = {`);
  assert.ok(at >= 0, `main.js に ${name} が無い`);
  const from = MAIN.indexOf('{', at);
  const eol = MAIN.indexOf('\n', from);
  const to = MAIN.slice(from, eol).trimEnd().endsWith('};') ? MAIN.lastIndexOf('};', eol) : MAIN.indexOf('\n};\n', from) + 1;
  return vm.runInNewContext(`(${MAIN.slice(from, to + 1)})`, {});
}
const textOf = (v) => (v && typeof v === 'object' ? v.text : v);
const NOTICE = tableOf('STT_NOTICE');
const BANNER = tableOf('STT_BANNER');
const WIN = tableOf('WIN_NOTIFY');
const notice = (code) => textOf(NOTICE[code]({ host: HOST }, 30));
const banner = (code) => BANNER[code]({ n: 2, sec: 90 }, { host: HOST });

// 計画の「帯の言葉（0.9.0）」の表の 0.9.0 の文（PC で文字起こしに切り替えたと言う文の全部。利用者の問い Q4 の既定）
const B_090 = {
  login: 'ログインが切れたため、この PC で文字起こしを続けていますが、精度が落ちます。［ログインし直す］を押して、もう一度ログインしてください。',
  'relay-off': '文字起こしの中継が今は使えないため、この PC で文字起こしを続けていますが、精度が落ちます。続くときは管理者に知らせてください。',
  'daily-cap': '今日のクラウドの文字起こしの上限に達したため、今日の残りはこの PC で文字起こしします。精度が落ちます。録音はそのまま続けてください。',
  'relay-blocked': `文字起こしの中継につながりません（会社の通信の検査で止められている可能性があります）。この PC で文字起こしを続けていますが、精度が落ちます。続くときは情報システムに ${HOST} への通信の許可を頼んでください。`,
  'relay-down': 'NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。',
  'relay-busy': '文字起こしの中継が混み合っているため、この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。',
};
const L_090 = {
  'signed-out': 'ログインしていないため、この PC で文字起こししています（精度が落ちます）。設定の「アカウント」でログインしてください。',
  login: 'ログインが切れたため、この PC で文字起こししています（精度が落ちます）。設定の「アカウント」でもう一度ログインしてください。',
  unreachable: 'NaTsu のサーバーにつながらないため、この PC で文字起こしを続けますが、精度が落ちます。録音はそのまま続けてください。',
  cert: `文字起こしの中継につながりません（会社の通信の検査で証明書が差し替えられている可能性があります）。この PC で文字起こしを続けますが、精度が落ちます。続くときは情報システムに ${HOST} への通信の許可を頼んでください。`,
  'daily-cap': '今日のクラウドの文字起こしの上限に達したため、今日の残りはこの PC で文字起こしします。精度が落ちます。録音はそのまま続けてください。',
  'relay-off': '文字起こしの中継が今は使えません。この PC で文字起こしを続けますが、精度が落ちます。続くときは管理者に知らせてください。',
  denied: 'このメールアドレスでは文字起こしの中継を使えないため、この PC で文字起こしを続けますが、精度が落ちます。管理者に知らせてください。',
  server: '文字起こしの中継が混み合っているか、止まっているため、この区間はこの PC で文字起こししました（精度が落ちます）。録音はそのまま続けてください。',
};
const WN3_090 = 'ログインが切れたため、この PC で文字起こししています（精度が落ちます）。録音中のページを開いてください。';
// PC で文字起こしを続けていないので精度の言葉を足さない文（BN3）。1d2 の B11〜B14（kept-*）・K1〜K4・P1 は A レーンが足す符号で、
// 下の「ほかの符号には『精度』が無い」で見る（表にある符号のうち、上の表の外の全部）
const B_PLAIN = ['engine-down', 'stall', 'seg-failed', 'wait'];
const L_PLAIN = ['cloud', 'wait', 'rate'];
const WN_PLAIN = ['engine-down', 'stall', 'seg-failed'];

test('BN1: STT_BANNER・STT_NOTICE・WIN_NOTIFY の B3・B5〜B9・L2〜L8・L11・WN3 は『帯の言葉』の表の 0.9.0 の文とちょうど同じ（{ホスト} は host を入れた形で）', T, () => {
  for (const [code, want] of Object.entries(B_090)) assert.strictEqual(banner(code), want, `帯 ${code}`);
  for (const [code, want] of Object.entries(L_090)) assert.strictEqual(notice(code), want, `知らせ ${code}`);
  assert.strictEqual(WIN.login, WN3_090, 'Windows の知らせ login（WN3）');
  // 文だけを直す: L3 のボタン（account）は今のまま
  assert.strictEqual(NOTICE.login().action, 'account');
});

test('BN1: B8 は利用者の文『NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。』', T, () => {
  assert.strictEqual(banner('relay-down'), 'NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。');
  // 同じ場面の知らせ（L4）も同じ名前（「NaTsu のサーバー」）で言う
  assert.ok(notice('unreachable').startsWith('NaTsu のサーバーにつながらない'), notice('unreachable'));
});

test('BN3: PC で文字起こしに切り替えたと言う文（上の全部）に『精度が落ちます』があり、『PC の中で文字起こし』の言い方が残っていない。1d2 の B11〜B14・K1〜K4・P1・D1〜D6・S1〜S3\' と L1・L9・L10・B1・B2・B4・B10 には『精度』が無い。どの文にも『未設定』が無い', T, () => {
  const switched = [...Object.keys(B_090).map(banner), ...Object.keys(L_090).map(notice), WIN.login];
  for (const t of switched) {
    assert.ok(t.includes('精度が落ちます'), `精度の言葉が無い: ${t}`);
    assert.ok(!t.includes('PC の中で文字起こし'), `前の言い方が残っている: ${t}`);
    assert.ok(t.includes('この PC で'), `言い方が「この PC で」にそろっていない: ${t}`);
  }
  for (const c of B_PLAIN) assert.ok(BANNER[c] && !banner(c).includes('精度'), `帯 ${c}`);
  for (const c of L_PLAIN) assert.ok(NOTICE[c] && !notice(c).includes('精度'), `知らせ ${c}`);
  for (const c of WN_PLAIN) assert.ok(WIN[c] && !WIN[c].includes('精度'), `Windows の知らせ ${c}`);
  // 表の外の符号（1d2 の B11〜B14・K1〜K4・P1 と、これから足す符号）にも『精度』を足さない。PC で文字起こしを続けると言う帯（B15 net-offline）だけは足す
  const ACCURATE = new Set([...Object.keys(B_090), 'net-offline']);
  for (const c of Object.keys(BANNER)) if (!ACCURATE.has(c)) assert.ok(!banner(c).includes('精度'), `帯 ${c} に精度の言葉`);
  for (const c of Object.keys(NOTICE)) if (!(c in L_090)) assert.ok(!notice(c).includes('精度'), `知らせ ${c} に精度の言葉`);
  for (const c of Object.keys(WIN)) if (c !== 'login') assert.ok(!WIN[c].includes('精度'), `Windows の知らせ ${c} に精度の言葉`);
  // 帯と知らせの表の外の文（1d2 の D1〜D6・S1〜S3'・区間の文など）にも足していない: main.js の『精度が落ちます』は上の表の文の中だけ
  const PHRASE = '精度が落ちます';
  const inTables = [...Object.keys(BANNER).map(banner), ...Object.keys(NOTICE).map(notice), ...Object.values(WIN)]
    .reduce((n, t) => n + t.split(PHRASE).length - 1, 0);
  // 注釈（// の後と /* */ の中の * の行）は数えない（後で注釈にこの言葉を書いても赤にしない）
  const code = MAIN.split('\n').map((l) => (/^\s*\*/.test(l) ? '' : l.replace(/(^|\s)\/\/.*$/, ''))).join('\n');
  assert.strictEqual(code.split(PHRASE).length - 1, inTables, 'main.js の帯と知らせの表の外の文に「精度が落ちます」がある');
  for (const t of [...Object.keys(BANNER).map(banner), ...Object.keys(NOTICE).map(notice), ...Object.values(WIN)]) assert.ok(!t.includes('未設定'), `「未設定」がある: ${t}`);
});

// 0.9.0 G-3 で意図して変えた: 利用者が CI の帯の3枚（B8 の新しい文）を見て OK と言ったので基準にし、取り直し待ちを空に戻した。
// 帯の3枚は取り直し待ちでなく、新しい文で撮った基準の PNG と比べる
test('BN1・G-3: 撮る画面の帯（BANNER_STT）の文は main の B8 と同じ。帯の3枚（live-banner-light・live-banner-dark・live-banner-zoom200-dark）は新しい文の基準と比べる（取り直し待ちではない）', T, () => {
  const SH = require('../tools/shots/screens');
  for (const n of ['live-banner-light', 'live-banner-dark', 'live-banner-zoom200-dark']) {
    const s = SH.SCREENS.find((x) => x.name === n);
    assert.ok(s, `${n} が撮る画面に無い`);
    assert.strictEqual(s.answers['koeApp.meetingStatus'].stt.problem.text, banner('relay-down'), n);
    assert.ok(!SH.RETAKE.has(n), `${n} が取り直し待ちに残っている`);
    assert.ok(fs.existsSync(path.join(__dirname, 'shots', 'win32', `${n}.png`)), `${n} の基準が無い`);
  }
});

// ---------------------------------------------------------------- B-2（BN2・F14）: 会議の途中でネットワークから外れたら帯を出し、戻ったら消す
// 見張りは main の自前の 1 秒の間隔（watchOffline。今の overlay:tick は 5 秒で拾い間違える）。続いた時間で出し消しする
// （5 秒続けて切れたら出す・10 秒続けてつながったら消す。行き来では点滅しない: 帯は role="alert" で、出し直すたびに読み上げる）
const LIB = require('../src/mainlib');
const B15 = 'ネットワークにつながっていません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。';

// 1 秒ごとの online の並び（true/false）を順に渡し、帯の様子（shown）は答えの act で持つ（main と同じく呼び手が持つ）
function simulate(onlineBySec, { eligibleBySec = () => true, t0 = 1000000 } = {}) {
  let st = {};
  let shown = false;
  const acts = [];
  onlineBySec.forEach((online, s) => {
    const r = LIB.offlineBannerStep(st, { online, now: t0 + s * 1000, eligible: eligibleBySec(s), shown });
    st = r.st;
    if (r.act === 'show') shown = true;
    if (r.act === 'clear') shown = false;
    if (r.act) acts.push([s, r.act]);
  });
  return acts;
}
const secs = (n, fn) => Array.from({ length: n }, (_, s) => fn(s));

test('BN2: offlineBannerStep の表（切れて 4.9 秒は何もしない・5 秒で show・出ている間につながって 9.9 秒は何もしない・10 秒で clear・3 秒ずつの行き来を 60 秒続けても show は0回・8 秒ずつのくり返しは show 1回で clear 0回・eligible が偽なら出ていれば clear・時計が戻っても投げない）', T, () => {
  assert.strictEqual(LIB.OFFLINE_SHOW_MS, 5000);
  assert.strictEqual(LIB.OFFLINE_CLEAR_MS, 10000);
  const t0 = 50000;
  let r = LIB.offlineBannerStep({}, { online: false, now: t0, eligible: true, shown: false });
  assert.strictEqual(r.act, '');
  assert.strictEqual(LIB.offlineBannerStep(r.st, { online: false, now: t0 + 4900, eligible: true, shown: false }).act, '');
  r = LIB.offlineBannerStep(r.st, { online: false, now: t0 + 5000, eligible: true, shown: false });
  assert.strictEqual(r.act, 'show');
  r = LIB.offlineBannerStep(r.st, { online: true, now: t0 + 6000, eligible: true, shown: true });
  assert.strictEqual(r.act, '');
  assert.strictEqual(LIB.offlineBannerStep(r.st, { online: true, now: t0 + 15900, eligible: true, shown: true }).act, '');
  assert.strictEqual(LIB.offlineBannerStep(r.st, { online: true, now: t0 + 16000, eligible: true, shown: true }).act, 'clear');
  // 3 秒ずつの行き来（3 秒つながり・3 秒切れる）を 60 秒
  assert.deepStrictEqual(simulate(secs(60, (s) => Math.floor(s / 3) % 2 === 0)), [], '3 秒ずつの行き来で帯を出した');
  // 8 秒切れて 8 秒つながるのをくり返す: 1回出たまま（10 秒続けてつながらないので消さない）
  const flap8 = simulate(secs(80, (s) => Math.floor(s / 8) % 2 === 1));
  assert.deepStrictEqual(flap8.filter(([, a]) => a === 'show').length, 1, JSON.stringify(flap8));
  assert.deepStrictEqual(flap8.filter(([, a]) => a === 'clear').length, 0, JSON.stringify(flap8));
  // ずっとつながっていれば何もしない
  assert.deepStrictEqual(simulate(secs(30, () => true)), []);
  // eligible が偽になれば、出ていれば clear、出ていなければ ''（切れたままでも出さない）
  assert.deepStrictEqual(simulate(secs(20, () => false), { eligibleBySec: (s) => s < 10 }), [[5, 'show'], [10, 'clear']]);
  assert.deepStrictEqual(simulate(secs(20, () => false), { eligibleBySec: () => false }), []);
  assert.strictEqual(LIB.offlineBannerStep({}, { online: false, now: t0, eligible: false, shown: true }).act, 'clear');
  // 時計が戻っても（now が前より小さい）投げず、戻った所から数え直す
  let back = LIB.offlineBannerStep({}, { online: false, now: t0 + 9000, eligible: true, shown: false });
  back = LIB.offlineBannerStep(back.st, { online: false, now: t0, eligible: true, shown: false });
  assert.strictEqual(back.act, '');
  assert.strictEqual(LIB.offlineBannerStep(back.st, { online: false, now: t0 + 5000, eligible: true, shown: false }).act, 'show');
  // 壊れた st・材料でも投げない
  for (const st of [undefined, null, 'x', { offSince: 'a', onSince: NaN }]) assert.doesNotThrow(() => LIB.offlineBannerStep(st, { online: false, now: t0, eligible: true, shown: false }));
});

test('BN2: PROBLEM_ORDER の net-offline は seg-failed の後・relay-off の前。WIN_NOTIFY_CODES は 0.8.0 の4つのまま', T, () => {
  const o = LIB.PROBLEM_ORDER;
  assert.ok(o.includes('net-offline'));
  assert.strictEqual(o.indexOf('net-offline'), o.indexOf('seg-failed') + 1 + o.slice(o.indexOf('seg-failed') + 1).findIndex((c) => c === 'net-offline'));
  assert.ok(o.indexOf('seg-failed') < o.indexOf('net-offline') && o.indexOf('net-offline') < o.indexOf('relay-off'), o.join(','));
  // 中継の帯（relay-off〜relay-busy）は net-offline の後ろ（同じ会議で両方が立つことは無いが、並びは決めておく）
  for (const c of ['relay-off', 'daily-cap', 'relay-blocked', 'relay-down', 'relay-busy', 'wait']) assert.ok(o.indexOf(c) > o.indexOf('net-offline'), c);
  assert.deepStrictEqual(LIB.WIN_NOTIFY_CODES, ['engine-down', 'stall', 'login', 'seg-failed']);
  assert.deepStrictEqual(LIB.sttProblemOf(new Map([['relay-down', {}], ['net-offline', {}]])), { code: 'net-offline' });
  // 帯の文（B15）とボタン（無い）
  assert.strictEqual(banner('net-offline'), B15);
  const action = tableOf('STT_BANNER_ACTION');
  assert.ok(!('net-offline' in action), '帯 net-offline にボタンを付けた');
});

test('BN2: shown が偽で渡れば（ほかの道で消えた）、切れたのが 5 秒続いていれば次の呼び出しで show', T, () => {
  const t0 = 70000;
  let r = LIB.offlineBannerStep({}, { online: false, now: t0, eligible: true, shown: false });
  r = LIB.offlineBannerStep(r.st, { online: false, now: t0 + 5000, eligible: true, shown: false });
  assert.strictEqual(r.act, 'show');
  // 帯はほかの道で消えた（呼び手が帯の様子から shown: false を渡す）。切れたままなら次の呼び出しで出し直す
  r = LIB.offlineBannerStep(r.st, { online: false, now: t0 + 6000, eligible: true, shown: false });
  assert.strictEqual(r.act, 'show');
  // 出ている間（shown: true）は出し直さない
  assert.strictEqual(LIB.offlineBannerStep(r.st, { online: false, now: t0 + 7000, eligible: true, shown: true }).act, '');
});

// 場面（helpers/mainrun.js の --net-seq）: 偽の時計で net.isOnline() の答えを秒ごとに替え、拾った watchOffline を 1 秒ずつ偽の時刻で呼ぶ。
// 区間は --net-seg-at の秒（無ければ最初に切れた秒の 5 秒後から 5 秒ごと）に送って片付くまで待ち、最後の区間は並びの後で止めてから送る。
// out.netProblems は [秒, 帯の符号か null] の移り変わり（meeting:status の stt.problem）
const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');
const S = { timeout: sceneTimeout(20000) };   // 場面は今の場面のテストと同じ見張り（stage1d.status）
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001' }, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const shownLines = (o) => o.engineLog.filter((l) => l === '文字起こしの状態: 帯 net-offline');
const clearedLines = (o) => o.engineLog.filter((l) => l === '文字起こしの状態: 帯を消した net-offline');
const everOffline = (o) => o.netProblems.some(([, c]) => c === 'net-offline') || o.sttSeen.some((s) => s.problem && s.problem.code === 'net-offline');

test('BN2・F14: クラウドの会議でネットワークが切れると 15 秒で帯 net-offline（文は B15・ボタン無し）、手元の区間が文字になっても出たまま、50 秒で消える。Windows の知らせは 0。記録の『帯 net-offline』は出したときと消したときの2行', S, async () => {
  const o = await run(['text', '--relay=text', '--net-seq=0:on,10:off,40:on', '--segs=3', '--main-hidden']);
  assert.strictEqual(o.start.ok, true, JSON.stringify(o.start));
  assert.deepStrictEqual(o.netProblems, [[0, null], [15, 'net-offline'], [50, null]], JSON.stringify(o.netProblems));
  const p = o.sttSeen.map((s) => s.problem).find((x) => x && x.code === 'net-offline');
  assert.deepStrictEqual({ text: p.text, action: p.action }, { text: B15, action: '' });
  // 切れている間の2つの区間（15 秒・20 秒）は手元で文字になった（帯 net-offline のまま、経路は local）
  assert.ok(o.sttSeen.some((s) => s.route === 'local' && s.problem && s.problem.code === 'net-offline' && s.lastTextAt), JSON.stringify(o.sttSeen));
  assert.strictEqual(o.netSegs.length, 2);
  assert.ok(o.netSegs.every((x) => x.problem === 'net-offline'), `手元の区間で帯が消えた: ${JSON.stringify(o.netSegs)}`);
  const segs = o.pages[0].segments;
  assert.strictEqual(segs.filter((x) => !x.failed && x.text).length, 3, JSON.stringify(segs));
  assert.deepStrictEqual(o.notifications, [], 'Windows の知らせを出した');
  assert.strictEqual(shownLines(o).length, 1, JSON.stringify(o.engineLog));
  assert.strictEqual(clearedLines(o).length, 1, JSON.stringify(o.engineLog));
  // 見張りは議事録の録音の間だけ（始めに1つ・録音が終わると止める）
  assert.deepStrictEqual(o.offlineWatch, { started: 1, cleared: 1 });
});

test('F14: ネットワークが 3 秒ずつ切れたりつながったりしても、帯 net-offline は1回も出ない', S, async () => {
  const o = await run(['text', '--relay=text', '--net-seq=0:on,10:off,13:on,16:off,19:on,22:off,25:on']);
  assert.strictEqual(o.start.ok, true);
  assert.ok(!everOffline(o), JSON.stringify(o.netProblems));
  assert.deepStrictEqual(shownLines(o), []);
});

test('F14: 帯が区間のクラウドの答えで消えた後にまた切れたら、5 秒で出し直す（見張りは「出ている」を帯の様子から読む）', S, async () => {
  const o = await run(['text', '--relay=text', '--net-seq=0:on,10:off,20:on,25:off,40:on', '--net-seg-at=22', '--segs=2']);
  assert.strictEqual(o.start.ok, true);
  assert.deepStrictEqual(o.netProblems, [[0, null], [15, 'net-offline'], [22, null], [30, 'net-offline'], [50, null]], JSON.stringify(o.netProblems));
  assert.strictEqual(shownLines(o).length, 2, JSON.stringify(o.engineLog));
});

test('F14: 準備を選んでいない PC（エンジンが無い）では net-offline は出ない（「この PC で文字起こしを続けています」が本当でない）', S, async () => {
  const o = await run(['text', '--relay=text', '--no-engine=fetchable', '--net-seq=0:on,10:off']);
  // A レーン（M-1: オフラインを任意に）を載せたので、準備を選んでいない PC でもオンラインでログインしていれば会議を始められる（統合で true に替えた）。
  // 切れている間の区間は手元で文字起こしせず音声を残すので、net-offline の代わりに帯 kept-wait（B11）が出る（場面が空で通っていないことも見る）
  assert.strictEqual(o.start.ok, true, JSON.stringify(o.start));
  assert.ok(!everOffline(o), JSON.stringify(o.netProblems));
  assert.deepStrictEqual(shownLines(o), []);
  assert.ok(o.netProblems.some(([, c]) => c === 'kept-wait'), JSON.stringify(o.netProblems));
  assert.ok(o.engineLog.includes('文字起こしの状態: 帯 kept-wait'), JSON.stringify(o.engineLog));
});

test('F14: 会議の途中で手元のエンジンが使えなくなった（モデルが消えた）ら、ネットワークが切れても net-offline は出ない', S, async () => {
  const o = await run(['text', '--relay=text', '--net-seq=0:on,10:off', '--no-whisper-after-start']);
  assert.strictEqual(o.start.ok, true, JSON.stringify(o.start));
  assert.ok(!everOffline(o), JSON.stringify(o.netProblems));
  assert.deepStrictEqual(shownLines(o), []);
  // 切れている間の区間は手元で文字にならない（エンジンの帯になる）: 見張りの外の道で帯が出ていることも見て、場面が空で通っていないことを確かめる
  assert.ok(o.netProblems.some(([, c]) => c === 'engine-down'), JSON.stringify(o.netProblems));
});

test('F14: PC の中だけの会議には net-offline を出さない', S, async () => {
  const o = await run(['text', '--relay=text', '--local-only', '--net-seq=0:on,10:off']);
  assert.strictEqual(o.start.ok, true);
  assert.strictEqual(o.localOnly.localOnly, true, JSON.stringify(o.localOnly));
  assert.ok(!everOffline(o), JSON.stringify(o.netProblems));
  assert.deepStrictEqual(shownLines(o), []);
});

test('F14: ログインしていない会議には net-offline を出さない（知らせは L2 だけ）', S, async () => {
  const o = await run(['text', '--relay=text', '--signed-out', '--net-seq=0:on,10:off']);
  assert.strictEqual(o.start.ok, true);
  assert.ok(!everOffline(o), JSON.stringify(o.netProblems));
  assert.deepStrictEqual(shownLines(o), []);
  // 文字起こしの知らせ（STT_NOTICE の文）のうち出たのは L2 だけ（ネットワークの帯の代わりに別の知らせを足していない）
  const sttTexts = new Set(Object.keys(NOTICE).map(notice));
  assert.deepStrictEqual(o.notices.map(textOf).filter((t) => sttTexts.has(t)), [L_090['signed-out']], JSON.stringify(o.notices));
});

test('BN2・決めたこと 34: 帯 net-offline が出ている間につながり直し、次の区間が中継で失敗したら、中継の帯（B8 relay-down）が net-offline と替わる（見張りの 10 秒を待たずに「NaTsu のサーバーにつながりません」）', S, async () => {
  const o = await run(['text', '--relay=text', '--net-seq=0:on,10:off,20:on', '--net-seg-at=15,22', '--relay-seq=cnc']);
  assert.strictEqual(o.start.ok, true, JSON.stringify(o.start));
  // 中継の帯を立てたら net-offline は消える（PROBLEM_ORDER で net-offline が前なので、残すと 30 秒まで中継の帯が隠れる）
  assert.deepStrictEqual(o.netProblems, [[0, null], [15, 'net-offline'], [22, 'relay-down']], JSON.stringify(o.netProblems));
  assert.strictEqual(o.netSegs[1].problem, 'relay-down', JSON.stringify(o.netSegs));
  assert.strictEqual(clearedLines(o).length, 1, JSON.stringify(o.engineLog));
});
