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

// main.js の `const NAME = {` から、行頭の `};` までを1つの式として読む（関数の表はそのまま関数になる。外の名前は使わない）
function tableOf(name) {
  const at = MAIN.indexOf(`\nconst ${name} = {\n`);
  assert.ok(at >= 0, `main.js に ${name} が無い`);
  const from = MAIN.indexOf('{', at);
  const to = MAIN.indexOf('\n};\n', from);
  return vm.runInNewContext(`(${MAIN.slice(from, to + 2)})`, {});
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
  assert.strictEqual(MAIN.split(PHRASE).length - 1, inTables, 'main.js の帯と知らせの表の外の文に「精度が落ちます」がある');
  for (const t of [...Object.keys(BANNER).map(banner), ...Object.keys(NOTICE).map(notice), ...Object.values(WIN)]) assert.ok(!t.includes('未設定'), `「未設定」がある: ${t}`);
});

test('BN1: 撮る画面の帯（BANNER_STT）の文は main の B8 と同じ。帯の3枚（live-banner-light・live-banner-dark・live-banner-zoom200-dark）は取り直し待ち', T, () => {
  const SH = require('../tools/shots/screens');
  for (const n of ['live-banner-light', 'live-banner-dark', 'live-banner-zoom200-dark']) {
    const s = SH.SCREENS.find((x) => x.name === n);
    assert.ok(s, `${n} が撮る画面に無い`);
    assert.strictEqual(s.answers['koeApp.meetingStatus'].stt.problem.text, banner('relay-down'), n);
    assert.ok(SH.RETAKE.has(n), `${n} が取り直し待ちに無い（帯の文が変わる）`);
  }
});
