/*
 * electron-smoke/main.js — 本物の Electron で、第2a1回の DB が頼る仕組みと、第0c回で直したところを動かす小さなアプリ（第0c回 EL8）
 *
 * 走らせ方（Electron の main として。窓は見せない）:
 *   node_modules/electron/dist/electron.exe tools/electron-smoke
 * 次の 19 を確かめる（CHECKS）。
 *   1〜4. utilityProcess と MessageChannelMain の口で、sandbox の隠れた窓（preload）と往復する。子を落として起こし直す。
 *         子の中で node:sqlite を開く。kill() の終わりの番号を見る
 *   5・6. mainlib の copyPrivate・deliverText を本物の clipboard で動かす（44 では Promise を返す。C1）
 *   7.    画面の取り込みを断る（loopback.chooseDisplayMedia の null）と、main は投げない（C7）
 *   8〜12. 第1a回 SEC1: 別の session（natsu-sec-smoke）に本物の security.install を付け、守りの確かめ用のページ
 *         （sec-app.html を本体、sec-overlay.html を録音バーの代わりに）で、sandbox・ヘッダーの CSP・マイクと画面の取り込みの
 *         許可・移動と新しい窓の禁止を見る（securityChecks。判定は純粋な securityResults）。偽のマイク
 *         （--use-fake-device-for-media-stream）を使う。1〜7 の受け口（defaultSession）は変えない
 *   13・14. 第1c回 OL2・OL3（偽物の fake-net.js が本物と同じかの毎回の確かめ。onlineChecks。判定は純粋な onlineResults）:
 *         13 は 127.0.0.1 の偽の送り先（test/helpers/fake-stt.js をここで開く）へ、本物の net.request で
 *         stt-cloud.postForm（buildMultipart で組んだ OpenAI と同じ形の multipart）を送り、文字が返り、送り先が受けた multipart の欄が
 *         A-2 のテストと同じ（第1d回 A-4: PC から OpenAI へ直に送る口を消したので、残した postForm で同じ要求を組む: smokeTranscribe）。
 *         302・307 を返す宛先は redirect: 'error' で失敗になり、転送の先へ要求が届かない。
 *         14 は本物の safeStorage の非同期の形（isAsyncEncryptionAvailable・encryptStringAsync・decryptStringAsync）で
 *         同じ文字に戻り、secrets.js（makeSecrets）で一時フォルダの secrets.json にしまって読み返せ、ファイルに鍵の文字が無い。
 *         さらに decryptStringAsync が shouldReEncrypt: true を返したとき、secrets.get が暗号にし直して書き、読み戻せる
 *         （しまえる PC だけ。Linux の basic_text では求めない）。
 *         Linux の basic_text（鍵の入れ物が無い CI）は「使えない」で OK（secrets.js が保存を断り、ファイルを作らないこと）
 *   15.   第2a1回 ST5・ST7（dbChecks。判定は純粋な dbResults）: 一時フォルダで本物の src/db/server.js を utilityProcess
 *         （serviceName 'NaTsu DB'）で起こし、main の口で meeting.finalize を1つ書く。sandbox の隠れた窓に本物の src/preload.js を
 *         付け、koeApp.pageGet が routeText 付きのページを返す。ページの window の上に MessagePort が無い。子を kill() して
 *         （終わりの番号 0）、起こし直した子が用意の前のうちに pageGet と pageSetTitle を頼み、その子も落とす → pageGet は retry で
 *         返る。もう一度起こし直すと、A の締めを同じ tx で送り直しても「済み」で返る（2回は効かない）。口を配り直すと
 *         pageSetTitle が済み、oplog にその書き込みの行（役 app・tx 'a:…'）が1つだけある。
 *   16.   第1d回 A-10（RL9・F19・F21。accessChecks。判定は純粋な accessResults）: メモリの partition（natsu-access-smoke。persist: なし）に
 *         cookies.set で置いた cookie を、本物の net.request が stt-cloud.postForm（session・redirect: 'manual'）で 127.0.0.1 の口へ
 *         Cookie の見出しとして付けるか（16a）。lax・strict（secure なし）の2つが届き、X-Requested-With が付き、302 で 'redirect' が起きて
 *         ついて行かず（postForm は 'server' で終わる）、その後に来た出来事（abort・error・close・何も来ない）を記録し、userData の下に
 *         Partitions のフォルダを作らない。Secure・SameSite=None の cookie を http://127.0.0.1 に置けたか（secureLoopback）と届いたかは観測。
 *         置けなければ Windows では 16b: PowerShell の New-SelfSignedCertificate（CN=127.0.0.1・CurrentUser\My）と Export-PfxCertificate で作った
 *         一時の証明書で 127.0.0.1 に https の口を開き、その partition にだけ setCertificateVerifyProc でその証明書の指紋だけを通して、
 *         Secure・SameSite=None・HttpOnly の cookie が届くかを見る。終わったら証明書を店とファイルの両方から消す（鍵はリポジトリに置かない）。
 *         16c（第1d回 A-11・F25。accessGuardCheck）: 8〜12 で付けた本物の security.install（1つだけ）に、ログインの窓の守り（isLoginContents は
 *         partition natsu-access-smoke の webContents・loginGuard の行き先は試しの 127.0.0.1 のその口）を渡したまま、その partition の sandbox の窓で
 *         許したホストへのフォームの送り（POST）が通って did-navigate が来ること、許していない行き先（別の口）への will-navigate と
 *         will-redirect（許した口の 302 の先）が止まること、window.open が断られることを見る。既定の session の窓のフォームの送りは今のまま止まる
 *   17.   0.9.0 O-2（RP4・F11。panelCheck。判定は純粋な panelResults）: 本物の録音バーと同じ作りの窓（transparent・frame: false・
 *         resizable: false・focusable: false・hasShadow: false）に setBounds で 252×56 → 56×252 → 436×56 を当て、getBounds() の幅と高さが
 *         ちょうど同じ整数で返るか。CI では拡大率 1 の全部の起動と、--only=17 --scale=1.25（17 だけを拡大率 1.25 で。force-device-scale-factor
 *         を ready の前に当てる）の2回目の起動の両方で見る。resizable: false の窓で大きさが替わらない・拡大率で1点ずれる振る舞いはここで赤になる
 *   18.   0.10.0 LN-3（D72・決めたこと 144。protocolCheck。判定は純粋な protocolResults）: 本物の app.setAsDefaultProtocolClient('natsu', execPath, ['--'])
 *         の後に、Windows の reg query で HKCU\Software\Classes\natsu\shell\open\command の既定の値を読み、ちょうど "<exe>" -- "%1" の形かを見る
 *         （-- の後ろは Chromium と Electron の引数として読まれない）。確かめた後に removeAsDefaultProtocolClient で外す（CI の使い捨ての機械だけ。
 *         利用者の登録には触らない）。Windows のほかは確かめない（OK）
 *   19.   0.11.1 LG-7（RF-LG1。iconCheck。判定は純粋な iconResults、数え方は iconDiff）: 本物の Chromium が assets/icon.svg（新しいロゴ。3次ベジェ）を
 *         256px の画面の外の窓（offscreen・白い地）に描いた画像と、tools/icon-render.js が書き出した assets/icon.png を白い地に置いた色を比べ、
 *         違う画素（どれかの色が 32 より違う）が 1% 未満か。道具の折れ線（制御点の順・分け数）が Chromium の描く形と食い違えば赤になる
 * 結果は 1 行ずつ OK／NG で出す。19 件（--only=17 なら 17 だけ）そろって全部 OK なら終了コード 0、そうでなければ 1（exitCodeOf）。
 * どこかで止まっても、90 秒の見張りで 1 で終わる。
 *
 * Electron を読むのは、Electron の main として動いたときだけ（下の boot。tools/net-smoke.js と同じ形）。
 * テスト（test/electron-smoke.test.js）がこのファイルを require するので、頭で読むと 44 の包みが本体を落としにいく（C6）。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const lib = require('../../src/mainlib');
const { chooseDisplayMedia } = require('../../src/loopback');
const security = require('../../src/security');
const sttCloud = require('../../src/stt-cloud');
const { makeSecrets } = require('../../src/secrets');
const J = require('../../src/jsonfile');
const { startFakeStt } = require('../../test/helpers/fake-stt');
const { execFile } = require('child_process');
const { versionIssue, versionGate } = require('../electron-version');

const CHECKS = [
  [1, 'utilityProcess と MessageChannelMain の口で、sandbox の隠れた窓（preload）と往復する'],
  [2, '子が落ちたら（終了コード 3）起こし直して、もう一度往復する'],
  [3, '子（utilityProcess）の中で node:sqlite が開ける'],
  [4, 'utilityProcess の kill() の終わりの番号は 0（第2a1回の「落ちたのか止めたのかは印で区別する」の前提）'],
  [5, 'clipboard を mainlib.copyPrivate で書いて読み返せる（44 では Promise）'],
  [6, 'mainlib.deliverText の貼り付けの後、元の「abc」に戻る（[object Promise] にならない）'],
  [7, '画面の取り込みを断る（loopback.chooseDisplayMedia の null）と、main は投げず、画面の getDisplayMedia は失敗で返る'],
  [8, 'sandbox: true の窓の preload で process.sandboxed が真'],
  [9, 'CSP（main がヘッダーで付ける）: ハッシュで許したインラインの script は動き、後から差し込んだ script は止まる'],
  [10, '許可: 本体の窓でマイク（音だけ）は許され、マイクの名前が出る。カメラと画面の取り込みは断る'],
  [11, '許可: 録音バーの窓の画面の取り込み（44 では media・mediaTypes が空）は、受け口まで届く'],
  [12, '移動と新しい窓: location の書き換え・リンク・window.open で、窓は元のページのまま、新しい窓は開かない'],
  [13, 'net.request の POST: 127.0.0.1 の偽の送り先へ postForm で multipart を送り、文字が返る。302・307 の転送は失敗になり、先へ届かない'],
  [14, 'safeStorage の非同期: 暗号にして同じ文字に戻り、secrets.js でしまって読み返せる（Linux の basic_text は「使えない」で OK）'],
  [15, '本物の src/db/server.js（utilityProcess・NaTsu DB）に main の口で締めを書き、本物の src/preload.js（sandbox の窓）の koeApp.pageGet が routeText 付きで返す。'
    + '口は window に出ない。子を落とすと読みは失敗で返り、書き込みは起こし直した後に1回だけ効く'],
  [16, 'Access の cookie: メモリの partition に cookies.set で置いた cookie を、本物の net.request が postForm（session・useSessionCookies）で 127.0.0.1 へ付け、'
    + 'X-Requested-With が付き、redirect: manual の 302 についていかない。Partitions のフォルダを作らない（Secure は観測。置けなければ Windows で https の 16b）。'
    + 'ログインの窓の守り（16c）: security.install を付けたまま、ログインの partition の窓だけ許した行き先へのフォームの送りが通り、ほかは止まる'],
  [17, '録音バーの窓（透過・枠なし・resizable: false・focusable: false・影なし）に setBounds で当てた横・縦・伸ばした横の大きさが、getBounds にちょうど同じ整数で返る'],
  [18, 'natsu:// の登録（0.10.0 LN-3）: setAsDefaultProtocolClient(natsu, execPath, [--]) の後、Windows の HKCU\\Software\\Classes\\natsu\\shell\\open\\command がちょうど "<exe>" -- "%1"。確かめた後に外す'],
  [19, 'ロゴの形（0.11.1 LG-7・RF-LG1）: Chromium が assets/icon.svg を 256px で描いた画像と、tools/icon-render.js の assets/icon.png（白い地に置いた色）の違う画素が 1% 未満'],
];
// 17 で当てる大きさ（横の記録中・縦の記録中・文を伸ばした横。どれも panelBounds の答えの形）
const PANEL_SIZES = [[252, 56], [56, 252], [436, 56]];
// 起動の引数から、確かめる番号（--only=17 なら 17 だけ）と、頼む拡大率（--scale=1.25。無ければ 0 = 頼まない）
function checksFor(argv) {
  const only = (Array.isArray(argv) ? argv : []).find((a) => /^--only=\d+$/.test(a));
  if (!only) return CHECKS;
  const n = Number(only.slice(7));
  return CHECKS.filter(([k]) => k === n);
}
function scaleFor(argv) {
  const a = (Array.isArray(argv) ? argv : []).find((x) => /^--scale=\d+(\.\d+)?$/.test(x));
  return a ? Number(a.slice(8)) : 0;
}

// 13 の送るもの。欄は test/stt-cloud.test.js の OL2 と同じ（鍵は試し用の決まった文字。本物の鍵ではない）
const SMOKE_STT = Object.freeze({
  key: 'gsk_smoke_0123456789',
  text: '本日の議題は進捗の確認です。',
  fields: Object.freeze({ model: 'whisper-large-v3', language: 'ja', prompt: 'お疲れさまです。見積 検収', response_format: 'json', temperature: '0' }),
});
const REDIRECTS = [302, 307];
const SET_CODES = new Set(['ok', 'unavailable', 'bad-key', 'bad-id', 'write']);
// 転送を断ったときの失敗として受け付ける符号（stt-cloud.js の通信の失敗。timeout は「断った」の証にならないので外す）
const REFUSED_CODES = new Set(['offline', 'cert', 'proxy', 'net']);

const PKG = path.join(__dirname, '..', '..', 'package.json');
// 15 は本物を使う（写しや偽物ではない）
const ROOT = path.join(__dirname, '..', '..');
const DB_SERVER = path.join(ROOT, 'src', 'db', 'server.js');
const PRELOAD_REAL = path.join(ROOT, 'src', 'preload.js');
// 15 の見本（人の名前は使わない）。送り先の表示の名前は main が init で渡すもの（routeText を DB のプロセスが添える）
const SMOKE_DB = Object.freeze({
  pageId: 'psmoke2a1',
  title: require('../../src/mainlib').meetingTitleAt('2026-10-18T01:00:00.000Z', 540),   // 0.10.0 SH-2（D77）: 本物と同じ日付の形
  newTitle: '直した',   // 利用者が付け直した題名（D77。題名の語に頼るため）
  labels: Object.freeze({ openai: 'OpenAI' }),
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 16c（第1d回 A-11）: 8〜12 の security.install に渡すログインの窓の守り。行き先の判断は 16c の間だけ試しの口を許す（ほかのときは何も許さない）
let smokeLoginAllow = () => false;
let smokeLoginSes = null;
const smokeLoginBlocked = [];
const smokeIsLogin = (wc) => smokeLoginSes !== null && Boolean(wc) && wc.session === smokeLoginSes;
const smokeLoginGuard = {
  allow: (url) => smokeLoginAllow(url),
  blocked: (url, d) => { smokeLoginBlocked.push({ url, kind: d && d.kind, isMainFrame: d && d.isMainFrame }); },
};
const msgOf = (e) => (e && e.message) || String(e);

/** promise を ms で打ち切る（止まったまま見張りの 90 秒を待たない） */
function within(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} が ${ms}ms で返らない`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

/** CHECKS の全部がそろって全部 OK のときだけ 0 */
function exitCodeOf(results, checks = CHECKS) {
  return Array.isArray(results) && results.length === checks.length
    && checks.every(([n]) => results.some((r) => r && r.n === n && r.ok === true)) ? 0 : 1;
}

/**
 * 5 と 6。clipboard（本物か偽物）を mainlib の copyPrivate・deliverText に渡す。常駐 PowerShell は居ない（paster は null）
 * ので、copyPrivate は clipboard で書く（'electron'）。時計は縮める。
 * @returns {Promise<Array<{ n: number, ok: boolean, note: string }>>}
 */
async function clipboardChecks(clip) {
  const d = {
    clip,
    paster: () => null,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    autoPaste: true,
    fg: Promise.resolve(''),
    simulatePaste: async () => 'ok',
    notice: () => {},
    later: (fn) => setTimeout(fn, 10),
  };
  const out = [];
  try {
    const t = 'NaTsu の試し';
    const by = await lib.copyPrivate(t, d);
    const back = await lib.readClip(clip);
    out.push({ n: 5, ok: by === 'electron' && back === t, note: `copyPrivate は ${by}、読み返しは ${JSON.stringify(back)}` });
  } catch (e) { out.push({ n: 5, ok: false, note: `投げた: ${msgOf(e)}` }); }
  try {
    await lib.copyPrivate('abc', d);
    const r = await lib.deliverText('口述の試し', d);
    await wait(100);
    const back = await lib.readClip(clip);
    out.push({ n: 6, ok: back === 'abc', note: `deliverText は ${r}、100ms 後のクリップボードは ${JSON.stringify(back)}` });
  } catch (e) { out.push({ n: 6, ok: false, note: `投げた: ${msgOf(e)}` }); }
  return out;
}

/**
 * 8〜12 の判定（純粋）。securityChecks が本物の Electron で集めた観測を渡す。
 * @param {{ sandboxed: boolean, inlineRan: boolean, injectedRan: boolean, violations: number, gumAudio: string, audioLabels: number,
 *   gumVideo: string, gdmApp: string, gdmOverlay: string, handlerCalls: number, urlAfter: string, opened: boolean }} o
 *   gum…・gdm… は成功なら 'ok'、失敗なら DOMException の名前（NotAllowedError・AbortError など）
 * @returns {Array<{ n: number, ok: boolean, note: string }>}
 */
function securityResults(o) {
  const x = o || {};
  const j = (v) => JSON.stringify(v);
  return [
    { n: 8, ok: x.sandboxed === true, note: `process.sandboxed は ${j(x.sandboxed)}` },
    { n: 9, ok: x.inlineRan === true && x.injectedRan !== true && x.violations >= 1,
      note: `インラインの script は ${x.inlineRan === true ? '動いた' : '動かない'}、差し込んだ script は ${x.injectedRan === true ? '動いた' : '止まった'}、CSP の違反は ${j(x.violations)} 件` },
    { n: 10, ok: x.gumAudio === 'ok' && x.audioLabels >= 1 && x.gumVideo === 'NotAllowedError' && x.gdmApp === 'NotAllowedError',
      note: `マイクは ${j(x.gumAudio)}（名前の出た音の機器 ${j(x.audioLabels)} 個）、カメラは ${j(x.gumVideo)}、本体の窓の画面の取り込みは ${j(x.gdmApp)}` },
    { n: 11, ok: x.gdmOverlay === 'AbortError' && x.handlerCalls === 1,
      note: `録音バーの窓の画面の取り込みは ${j(x.gdmOverlay)}、受け口が呼ばれたのは ${j(x.handlerCalls)} 回（本体の窓の分は来ないので 1）` },
    { n: 12, ok: x.urlAfter === 'sec-app.html' && x.opened === false,
      note: `移動を試した後のページは ${j(x.urlAfter)}、新しい窓は ${x.opened === false ? '開かない' : `開いた（${j(x.opened)}）`}` },
  ];
}

/**
 * 13・14 の判定（純粋）。onlineChecks が本物の Electron で集めた観測を渡す。
 * @param {{ text: string, sttRequests: Array<object>,
 *   redirects: Array<{ status: number, reached: boolean, cloud: boolean, code: string, targetHits: number }>,
 *   platform: string, asyncAvailable: boolean, backend: string, roundTrip: boolean, setCode: string, getBack: boolean, plainInFile: boolean,
 *   reEncryptBack: boolean, error13?: string, error14?: string }} o
 *   sttRequests は偽の送り先が受けた要求（fake-stt.js の requests）。redirects は 302・307 ごとに、転送の元に届いたか（reached）・
 *   失敗が CloudSttError か（cloud）・smokeTranscribe（postForm）の失敗の符号（code。失敗しなければ ''）・転送の先が受けた要求の数（targetHits）。
 *   reEncryptBack は、decryptStringAsync が shouldReEncrypt: true を返したときに secrets.get が鍵を返し、
 *   暗号にし直した文字を secrets.json に書き（鍵の文字は無い）、別の係で読み戻せたか（しまえる PC だけで求める）
 * @returns {Array<{ n: number, ok: boolean, note: string }>}
 */
function onlineResults(o) {
  const x = o || {};
  const j = (v) => JSON.stringify(v);
  const reqs = Array.isArray(x.sttRequests) ? x.sttRequests : [];
  const r = reqs[0] || {};
  const reqOk = reqs.length === 1 && r.method === 'POST' && r.path === '/openai/v1/audio/transcriptions' && r.authOk === true && r.wavOk === true
    && r.fileName === 'segment.wav' && r.fileType === 'audio/wav' && isDeepStrictEqual(r.fields, { ...SMOKE_STT.fields });
  const textOk = x.text === `${SMOKE_STT.text}区間1`;
  const reds = Array.isArray(x.redirects) ? x.redirects : [];
  const redOf = (st) => reds.find((d) => d && d.status === st);
  const redOk = REDIRECTS.every((st) => {
    const d = redOf(st);
    return Boolean(d) && d.reached === true && d.cloud === true && REFUSED_CODES.has(d.code) && d.targetHits === 0;
  });
  const redNote = REDIRECTS.map((st) => {
    const d = redOf(st);
    if (!d) return `${st} は結果が無い`;
    return `${st} は${d.reached === true ? '' : '元に届かず、'}${d.code ? `失敗（${j(d.code)}）` : '失敗にならない'}、先が受けたのは ${j(d.targetHits)} 件`;
  }).join('・');
  const fieldNames = r.fields && typeof r.fields === 'object' ? Object.keys(r.fields).join(',') : '-';
  const n13 = `返った文は ${j(x.text)}、送り先が受けた要求は ${reqs.length} 件（${j(r.method)} ${j(r.path)}、鍵の見出し ${r.authOk === true ? 'OK' : 'NG'}、`
    + `WAV ${r.wavOk === true ? 'OK' : 'NG'}、file ${j(r.fileName)} ${j(r.fileType)}、欄 ${fieldNames}${reqs.length && !isDeepStrictEqual(r.fields, { ...SMOKE_STT.fields }) ? '（値か並びが違う）' : ''}）、`
    + `転送は ${redNote}${x.error13 ? `、止まった: ${x.error13}` : ''}`;

  const linuxOff = x.platform === 'linux' && (x.asyncAvailable !== true || x.backend === 'basic_text' || x.backend === 'unknown');
  const setCode = SET_CODES.has(x.setCode) ? x.setCode : (x.setCode === undefined ? '無し' : 'その他');
  const base = `isAsyncEncryptionAvailable は ${j(x.asyncAvailable)}、入れ物は ${j(x.backend || '-')}（${j(x.platform)}）`;
  const tail = `secrets.js の保存は ${setCode}、ファイルに鍵の文字は ${x.plainInFile === false ? '無い' : (x.plainInFile === true ? 'ある' : '確かめられない')}`
    + `${x.error14 ? `、止まった: ${x.error14}` : ''}`;
  let ok14; let n14;
  if (linuxOff) {
    ok14 = x.setCode === 'unavailable' && x.plainInFile === false;
    n14 = `Linux で使えない（${base}）。${tail}`;
  } else {
    ok14 = x.asyncAvailable === true && x.roundTrip === true && x.setCode === 'ok' && x.getBack === true && x.plainInFile === false
      && x.reEncryptBack === true;
    n14 = `${base}、暗号にして ${x.roundTrip === true ? '同じ文字に戻った' : '戻らない'}、${tail}、別の係で読み返して ${x.getBack === true ? '同じ' : '違う'}`
      + `、暗号にし直した後に読み戻して ${x.reEncryptBack === true ? '同じ' : (x.reEncryptBack === false ? '違う' : '確かめられない')}`;
  }
  return [
    { n: 13, ok: reqOk && textOk && redOk, note: n13 },
    { n: 14, ok: ok14, note: n14 },
  ];
}

/**
 * 15 の判定（純粋）。dbChecks が本物の Electron で集めた観測を渡す。
 * @param {{ got: { title: string, routeText: string[] } | null, portOnWindow: boolean, rejectedWhileDown: boolean, titleAfter: string,
 *   oplogRows: number, killCode: number, resendOk: boolean, closeEvent?: boolean, error?: string }} o
 *   got は koeApp.pageGet の答えの page。portOnWindow はページの window（と koeApp・koeOverlay の中）に MessagePort か
 *   関数でないもの・natsuDb があったか。rejectedWhileDown は、用意の前の子に頼んだ pageGet が、子を落とした後に retry で返ったか。
 *   titleAfter は起こし直した後に済んだ pageSetTitle の答えの題名。oplogRows は役 app・tx 'a:…' の page.setTitle の行の数。
 *   killCode は用意のできた子を kill() した終わりの番号。resendOk は、A で済んだ締めを C の main の口に同じ tx でもう一度送ったとき
 *   ok で返ったか（同じ (役, tx) は1回だけ効き、2回目は「済み」。もう一度効かせると UNIQUE(role, tx) で internal になる）。closeEvent（参考）は db:lost の前に口の 'close' で読みが返ったか。
 *   error はどこかで止まったときの文（あれば NG）
 * @returns {Array<{ n: number, ok: boolean, note: string }>}
 */
function dbResults(o) {
  const x = o || {};
  const j = (v) => JSON.stringify(v);
  const got = x.got && typeof x.got === 'object' ? x.got : null;
  const gotOk = Boolean(got) && got.title === SMOKE_DB.title && Array.isArray(got.routeText);
  const ok = !x.error && gotOk && x.portOnWindow === false && x.rejectedWhileDown === true && x.titleAfter === SMOKE_DB.newTitle
    && x.oplogRows === 1 && x.killCode === 0 && x.resendOk === true;
  const note = `pageGet の題名は ${j(got ? got.title : null)}・routeText は ${j(got ? got.routeText : null)}、`
    + `window に口は ${x.portOnWindow === false ? '無い' : `ある（${j(x.portOnWindow)}）`}、kill() の番号は ${j(x.killCode)}、`
    + `落ちた間の読みは ${x.rejectedWhileDown === true ? `retry で返った（${x.closeEvent === true ? "口の 'close' で" : 'db:lost で'}）` : '返らない'}、`
    + `起こし直した後の題名は ${j(x.titleAfter)}、oplog の行は ${j(x.oplogRows)}、`
    + `同じ tx の締めの送り直しは ${x.resendOk === true ? '済みで返った' : `済みで返らない（${j(x.resendOk)}）`}${x.error ? `、止まった: ${x.error}` : ''}`;
  return [{ n: 15, ok, note }];
}

/**
 * 16 の判定（純粋）。accessChecks が本物の Electron で集めた観測を渡す。
 * @param {{ platform: string, laxStrictSent: boolean, xrw: boolean, secureLoopback: boolean, secureSent: boolean, redirectEvent: boolean,
 *   redirectCode: string, targetHits: number, afterRedirect: string, partitionsDir: boolean, https?: { ran: boolean, sent?: boolean, error?: string },
 *   error?: string }} o
 *   laxStrictSent は口が受けた Cookie の見出しに lax・strict の2つの cookie があったか。xrw は X-Requested-With: XMLHttpRequest があったか。
 *   secureLoopback は Secure・SameSite=None の cookie を http://127.0.0.1 に cookies.set で置けたか、secureSent はそれが届いたか（どちらも観測）。
 *   redirectEvent は 302 で 'redirect' が起きたか、redirectCode は postForm の失敗の符号（行き先が 127.0.0.1 なので 'server'）、
 *   targetHits は転送の先が受けた要求の数、afterRedirect は 'redirect' の後に来た出来事（観測）。partitionsDir は userData の下に
 *   Partitions があるか。https は 16b（Secure を置けない Windows だけ動かす）の結果。guard は 16c（第1d回 A-11）の窓の守りの観測
 *   { formPosted, navBlocked, redirectBlocked, openDenied, defaultBlocked }（どれも真で OK）
 * @returns {Array<{ n: number, ok: boolean, note: string }>}
 */
function accessResults(o) {
  const x = o || {};
  const j = (v) => JSON.stringify(v);
  const h = x.https && typeof x.https === 'object' ? x.https : null;
  const secureOk = x.secureLoopback === true || x.platform !== 'win32' || Boolean(h && h.ran === true && h.sent === true);
  const gd = x.guard && typeof x.guard === 'object' ? x.guard : {};
  const GUARD = ['formPosted', 'navBlocked', 'redirectBlocked', 'openDenied', 'defaultBlocked'];
  const guardOk = !gd.error && GUARD.every((k) => gd[k] === true);
  const ok = !x.error && x.laxStrictSent === true && x.xrw === true && x.redirectEvent === true && x.redirectCode === 'server'
    && x.targetHits === 0 && x.partitionsDir === false && secureOk && guardOk && Object.keys(x).length > 0;
  const guardNote = `、16c（窓の守り）は ${GUARD.map((k) => `${k} ${gd[k] === true ? 'はい' : j(gd[k])}`).join('・')}${gd.blocked ? `（止めた ${j(gd.blocked)}）` : ''}${gd.error ? `・止まった ${j(gd.error)}` : ''}`;
  const https = h ? `、16b（https）は ${h.ran === true ? `動いて Secure の cookie が ${h.sent === true ? '届いた' : '届かない'}` : `動かない（${j(h.error || '?')}）`}` : '';
  const note = `lax・strict の cookie は ${x.laxStrictSent === true ? '届いた' : '届かない'}、X-Requested-With は ${x.xrw === true ? 'ある' : '無い'}、`
    + `Secure の cookie を http://127.0.0.1 に ${x.secureLoopback === true ? `置けて${x.secureSent === true ? '届いた' : '届かない'}` : '置けない'}（観測）${https}、`
    + `302 で redirect は ${x.redirectEvent === true ? '起きた' : '起きない'}（postForm は ${j(x.redirectCode)}・転送の先が受けたのは ${j(x.targetHits)} 件・`
    + `後に来たのは ${j(x.afterRedirect || 'none')}）、Partitions のフォルダは ${x.partitionsDir === false ? '無い' : `ある（${j(x.partitionsDir)}）`}`
    + `${guardNote}${x.error ? `、止まった: ${x.error}` : ''}`;
  return [{ n: 16, ok, note }];
}

/** 結果を n の順に 1 行ずつ出し、出力を流し切ってから、exitCodeOf の値で Electron を終える */
function finish(app, results, { log = (l) => console.log(l), flush = (cb) => process.stdout.write('', cb), checks = CHECKS } = {}) {
  const list = Array.isArray(results) ? results : [];
  for (const [n, title] of checks) {
    const r = list.find((x) => x && x.n === n);
    log(r ? `${r.ok ? 'OK' : 'NG'} ${n} ${title} — ${r.note}` : `NG ${n} ${title} — 結果が無い`);
  }
  const code = exitCodeOf(list, checks);
  const bad = checks.filter(([n]) => !list.some((r) => r && r.n === n && r.ok === true)).length;
  log(code === 0 ? `結果: ${checks.length} 件とも OK` : `結果: NG ${bad} 件`);
  flush(() => { if (code === 0) app.exit(0); else app.exit(1); });
}

// ---------------------------------------------------------------- Electron の main として動いたとき

/** 1〜4: 子（utilityProcess）と sandbox の隠れた窓を口でつなぐ */
async function processChecks(win, { utilityProcess, MessageChannelMain }) {
  const out = [];
  const note = {};
  // 口（webContents.postMessage）と executeJavaScript は別の道で届くので、着く順は決まっていない。
  // 窓が新しい口を受け取った（preload の gen が進んだ）のを見てから往復する
  const genOf = () => within(win.webContents.executeJavaScript('window.smoke.gen()'), 10000, '口の数');
  const start = async () => {
    const before = await genOf();
    const child = utilityProcess.fork(path.join(__dirname, 'child.js'), [], { serviceName: 'NaTsu Smoke' });
    const exited = new Promise((r) => child.once('exit', r));
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage('hello', [port1]);
    win.webContents.postMessage('port', null, [port2]);
    for (const end = Date.now() + 10000; (await genOf()) === before;) {
      if (Date.now() > end) { try { child.kill(); } catch (_) { /* もう居ない */ } throw new Error('新しい口が 10000ms で窓に届かない'); }
      await wait(20);
    }
    return { child, exited };
  };
  const ask = (x) => within(win.webContents.executeJavaScript(`window.smoke.call(${JSON.stringify(x)})`), 10000, `往復（${x}）`);
  let cur = null;
  try {
    // 1・3
    cur = await start();
    const a = await ask('a');
    out.push({ n: 1, ok: Boolean(a && a.echo === 'a'), note: `返事は ${JSON.stringify(a)}` });
    const v = String((a && a.sqlite) || '');
    out.push({ n: 3, ok: /^3\.\d+\.\d+$/.test(v), note: `子の SQLite は ${v}` });
    // 2: 子を落として（終了コード 3）、起こし直して往復する
    const { child } = cur;
    child.postMessage('crash', [new MessageChannelMain().port1]);
    const code = await within(cur.exited, 10000, '子の終わり');
    note.crash = `落ちたときの番号は ${code}`;
    cur = await start();
    const b = await ask('b');
    out.push({ n: 2, ok: code === 3 && Boolean(b && b.echo === 'b'), note: `${note.crash}、起こし直した後の返事は ${JSON.stringify(b)}` });
    // 4: kill() の終わりの番号
    const last = cur;
    cur = null;
    last.child.kill();
    const killed = await within(last.exited, 10000, 'kill() の後の終わり');
    out.push({ n: 4, ok: killed === 0, note: `kill() の終わりの番号は ${killed}` });
  } catch (e) {
    for (const n of [1, 3, 2, 4]) if (!out.some((r) => r.n === n)) out.push({ n, ok: false, note: `止まった: ${msgOf(e)}` });
    if (cur) { try { cur.child.kill(); } catch (_) { /* もう居ない */ } }
  }
  return out;
}

/** 7: 断るときの null を本物の受け口に渡す */
async function displayMediaCheck(win, session) {
  let given;
  let threw = '受け口が呼ばれていない';
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    const s = chooseDisplayMedia({ platform: process.platform, frame: req.frame, enabled: false, url: '' });
    try { cb(s); threw = ''; } catch (e) { threw = e.message; }
    given = s;
  });
  try {
    const res = await within(win.webContents.executeJavaScript(
      "navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(() => 'resolved', (e) => 'rejected ' + e.name)", true), 10000, 'getDisplayMedia');
    const ok = given === null && threw === '' && /^rejected/.test(String(res));
    return { n: 7, ok, note: `渡したのは ${JSON.stringify(given)}、main の例外は ${threw ? JSON.stringify(threw) : '無し'}、画面は ${res}` };
  } catch (e) {
    return { n: 7, ok: false, note: `止まった: ${msgOf(e)}（渡したのは ${JSON.stringify(given)}、main の例外は ${JSON.stringify(threw)}）` };
  }
}

function boot() {
  const { app, BrowserWindow, utilityProcess, MessageChannelMain, clipboard, session, net, safeStorage } = require('electron');
  // 8〜12 の偽のマイク（whenReady の前に付ける）
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  // 17 だけを拡大率を替えて回す起動（--only=17 --scale=1.25。拡大率のスイッチは ready の前に当てる）
  const checks = checksFor(process.argv);
  const scale = scaleFor(process.argv);
  if (scale) app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
  // 見張り: どこかで止まっても、ジョブの 30 分を待たずに赤にする
  setTimeout(() => { console.log('NG 時間切れ'); app.exit(1); }, 90000);
  // 拾われない例外で Electron の窓（エラーの箱）を出すと、そこで止まる。行に出して終わる
  const die = (what) => (e) => { console.log(`NG ${what}: ${(e && e.stack) || e}`); app.exit(1); };
  process.on('uncaughtException', die('拾われない例外'));
  process.on('unhandledRejection', die('拾われない失敗'));
  // 記録は一時フォルダに（日本語と 𠮷 の名前。利用者のプロファイルを汚さない）
  try {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-smoke-土台𠮷-'));
    app.setPath('userData', data);
    app.setPath('sessionData', data);
  } catch (e) { console.log(`参考: userData を一時フォルダにできなかった（${e.message}）`); }
  app.disableHardwareAcceleration();
  // 窓を閉じても終わらない（終わるのは finish か見張り）
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    console.log(`Electron ${process.versions.electron}（Chromium ${process.versions.chrome}、Node ${process.versions.node}、${process.platform}）`);
    if (versionGate(app, versionIssue(process.versions, JSON.parse(fs.readFileSync(PKG, 'utf8'))))) return;
    if (checks.length === 1 && checks[0][0] === 17) {
      finish(app, await panelCheck({ BrowserWindow, screen: require('electron').screen, want: scale || 1 }), { checks });   // panelCheck は結果の配列を返す
      return;
    }
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await win.loadFile(path.join(__dirname, 'page.html'));
    const results = [];
    results.push(...await processChecks(win, { utilityProcess, MessageChannelMain }));
    results.push(...await clipboardChecks(clipboard));
    results.push(await displayMediaCheck(win, session));
    win.destroy();
    results.push(...await dbChecks({ BrowserWindow, utilityProcess, MessageChannelMain }));
    results.push(...await securityChecks({ app, BrowserWindow, session }));
    results.push(...await onlineChecks({ app, net, safeStorage }));
    results.push(...await accessChecks({ app, net, session, BrowserWindow }));
    results.push(...await panelCheck({ BrowserWindow, screen: require('electron').screen, want: scale || 1 }));
    results.push(...await protocolCheck({ app }));
    results.push(...await iconCheck({ BrowserWindow }));
    finish(app, results);
  }, die('起動の失敗'));
}

/**
 * 15: 本物の src/db/server.js（utilityProcess）と、sandbox の隠れた窓に付けた本物の src/preload.js で観測を集める（判定は dbResults）。
 * 置き場所は boot() の後（版を見る前の所に new BrowserWindow( を書かない）。どこかで止まっても観測を残して判定に回す（見張りの 90 秒を待たない）。
 * 口（webContents.postMessage）と executeJavaScript は別の道で届くので、口を渡したら本物の preload の受け口の 'pages:updated'
 * （webContents.send。口と同じ道で、渡した順に届く）で印を送り、ページがその印を見てから頼む。
 *   A: 用意のできた子。main の口で締め → pageGet → window に口が無いか → kill()（番号）→ main と同じく db:lost
 *   B: 起こし直した子。init を送らない（用意の前。頼みは子の中で待つ）。口を配って pageGet と pageSetTitle を頼み、kill() → 読みは retry
 *   C: もう一度起こし直した子（落ちた後なので、子の中の worker で確かめてから用意）。A の締めを同じ tx で main の口から送り直すと
 *      「済み」で返る（もう一度は効かない）。口を配り直すと pageSetTitle が同じ tx で済む
 * 最後に C を閉じ（close → closed）、natsu.db を素の読み取り専用の接続で開いて oplog を数える。一時フォルダは消す。
 */
async function dbChecks({ BrowserWindow, utilityProcess, MessageChannelMain }) {
  const o = {};
  const kids = [];
  const ports = [];
  let win = null;
  let tmp = '';
  const until = async (fn, ms, what) => {
    for (const end = Date.now() + ms; ; await wait(20)) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`${what} が ${ms}ms で来ない`);
    }
  };
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-smoke-db-議事録𠮷-'));
    const dataDir = path.join(tmp, 'data');
    const fork = () => {
      const child = utilityProcess.fork(DB_SERVER, [], { serviceName: 'NaTsu DB' });
      // kill() はプロセスが出来る（'spawn'）前は何もせず false を返す（Windows は起こすのが遅い。CI run 39240983508 で B が終わらなかった）
      const k = { child, msgs: [], exited: new Promise((r) => child.once('exit', r)), spawned: new Promise((r) => child.once('spawn', r)) };
      child.on('message', (m) => k.msgs.push(m));
      kids.push(k);
      return k;
    };
    const msgOfType = (k, type) => k.msgs.find((m) => m && m.type === type);
    const start = async (k) => {
      k.child.postMessage({ type: 'init', dataDir, labels: { ...SMOKE_DB.labels }, network: false });
      const r = await until(() => msgOfType(k, 'ready'), 20000, '子の ready');
      if (r.state !== 'ok') throw new Error(`子の ready が ${JSON.stringify(r.state)}`);
    };
    // main の口（役 main）。頼み { id, cmd, args, tx? } → 返事 { id, ok, result | code }
    const mainPort = (k) => {
      const { port1, port2 } = new MessageChannelMain();
      ports.push(port2);
      k.child.postMessage({ type: 'port', role: 'main' }, [port1]);
      const waiting = new Map();
      let seq = 0;
      port2.on('message', (e) => { const m = e && e.data; if (m && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
      port2.start();
      return (cmd, args, tx) => within(new Promise((r) => { seq += 1; waiting.set(seq, r); port2.postMessage(tx ? { id: seq, cmd, args, tx } : { id: seq, cmd, args }); }), 10000, cmd);
    };
    const js = (code) => within(win.webContents.executeJavaScript(code), 10000, 'ページの式');
    let mark = 0;
    const sync = async () => {
      mark += 1;
      const n = mark;
      win.webContents.send('pages:updated', { mark: n });
      await until(() => js('window.__p2mark').then((v) => v === n), 10000, '画面の印');
    };
    const givePort = async (k) => {
      const { port1, port2 } = new MessageChannelMain();
      k.child.postMessage({ type: 'port', role: 'app' }, [port1]);
      win.webContents.postMessage('db:port', null, [port2]);
      await sync();
    };
    const id = JSON.stringify(SMOKE_DB.pageId);

    // A: 用意のできた子に、main の口で締めを1つ書く
    const a = fork();
    const askA = mainPort(a);
    await start(a);
    const finTx = `meeting:${Date.now()}`;
    const finArgs = {
      pageId: SMOKE_DB.pageId,
      page: { title: SMOKE_DB.title, blocks: [], route: { stt: { cloud: 1, local: 0, provider: 'openai' }, localOnly: false } },
      segments: [{ id: 's1', atMs: 0, durationMs: 1000, text: '本日の議題は進捗の確認です。' }],
    };
    const fin = await askA('meeting.finalize', finArgs, finTx);
    if (!fin.ok) throw new Error(`締めが ${fin.code}`);
    win = new BrowserWindow({
      show: false,
      webPreferences: { preload: PRELOAD_REAL, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await within(win.loadFile(path.join(__dirname, 'page.html')), 10000, 'page.html の読み込み');
    await js('window.__p2 = {}; koeApp.onPagesUpdated((p) => { window.__p2mark = p && p.mark; }); 1');
    await givePort(a);
    const r = await js(`koeApp.pageGet(${id})`);
    o.got = r && r.page ? r.page : null;
    // ページの window の上に口が無い（koeApp・koeOverlay は関数だけ。natsuDb は第2a2回まで出さない）
    o.portOnWindow = await js(`(() => {
      const isPort = (v) => { try { return v instanceof MessagePort; } catch (_) { return false; } };
      for (const k of Object.getOwnPropertyNames(window)) { let v; try { v = window[k]; } catch (_) { continue; } if (isPort(v)) return true; }
      for (const api of [window.koeApp, window.koeOverlay]) for (const k of Object.keys(api || {})) if (typeof api[k] !== 'function' || isPort(api[k])) return true;
      return 'natsuDb' in window;
    })()`);
    await within(a.spawned, 10000, '子 A の spawn');
    o.killAOk = a.child.kill();
    if (!o.killAOk) throw new Error('子 A の kill() が false（落とせない）');
    o.killCode = await within(a.exited, 10000, 'kill() の後の終わり');
    win.webContents.send('db:lost', {});
    await sync();

    // B: 起こし直した子が用意の前のうちに頼む（頼みは子の中で待つ）。その子も落とす
    const b = fork();
    await givePort(b);
    await js(`koeApp.pageGet(${id}).then(() => { window.__p2.rd = 'resolved'; }, (e) => { window.__p2.rd = 'rejected ' + (e && e.message); });
      koeApp.pageSetTitle(${id}, ${JSON.stringify(SMOKE_DB.newTitle)}).then((p) => { window.__p2.wr = { title: p && p.title }; }, (e) => { window.__p2.wr = { error: (e && e.message) || '?' }; });
      1`);
    await within(b.spawned, 10000, '用意の前の子の spawn');
    o.killBOk = b.child.kill();
    if (!o.killBOk) throw new Error('用意の前の子の kill() が false（落とせない）');
    await within(b.exited, 10000, '用意の前の子の終わり');
    // sandbox の preload の口にも 'close' が来て、読む頼みが返る（来なければ、main と同じく db:lost で返る）
    let rd = await until(() => js('window.__p2.rd'), 5000, "口の 'close'").catch(() => '');
    o.closeEvent = Boolean(rd);
    win.webContents.send('db:lost', {});
    await sync();
    if (!rd) rd = await until(() => js('window.__p2.rd'), 5000, '落ちた間の読みの答え');
    o.rejectedWhileDown = rd === 'rejected retry';
    if (await js('window.__p2.wr !== undefined')) throw new Error('口が無い間に書き込みが返った');

    // C: もう一度起こし直して口を配り直す → 待たせた書き込みが同じ tx で済む
    const c = fork();
    const askC = mainPort(c);
    await start(c);
    // 済んだ締めを同じ (役 main, tx) でもう一度送る → 「済み」で返り、もう一度は効かない（効かせると UNIQUE(role, tx) で internal）
    const again = await askC('meeting.finalize', finArgs, finTx);
    o.resendOk = again.ok === true;
    await givePort(c);
    const wr = await until(() => js('window.__p2.wr'), 10000, '書き込みの答え');
    o.titleAfter = wr.error ? `失敗（${wr.error}）` : wr.title;
    c.child.postMessage({ type: 'close' });
    await until(() => msgOfType(c, 'closed'), 10000, '子の closed');
    c.child.kill();
    await within(c.exited, 10000, '閉じた子の終わり');
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(path.join(dataDir, 'natsu.db'), { readOnly: true });
    try {
      o.oplogRows = d.prepare('select count(*) n from oplog where role = ? and action = ? and tx like ?').get('app', 'page.setTitle', 'a:%').n;
    } finally { d.close(); }
  } catch (e) {
    o.error = msgOf(e);
  } finally {
    for (const k of kids) { try { k.child.kill(); } catch (_) { /* もう居ない */ } }
    for (const p of ports) { try { p.close(); } catch (_) { /* もう閉じた */ } }
    if (win) { try { win.destroy(); } catch (_) { /* もう無い */ } }
    await Promise.all(kids.map((k) => within(k.exited, 5000, '子の終わり').catch(() => {})));
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 消せなくても判定は出す */ } }
  }
  return dbResults(o);
}

/**
 * 8〜12: 別の session（natsu-sec-smoke）に本物の security.install を付け、守りの確かめ用の2つのページで観測を集める。
 * boot() の中で 1〜7 が済んでから呼ぶ（install は app の web-contents-created に移動の禁止を付けるので、1〜7 の窓より後に）。
 * 置き場所は boot() の後（ファイルの中で、版を見る前の所に new BrowserWindow( を書かない）。
 * 判定は securityResults。どこかで止まっても、8〜12 を NG にして返す（見張りの 90 秒を待たない）。
 */
async function securityChecks({ app, BrowserWindow, session }) {
  const PAGES = { app: path.join(__dirname, 'sec-app.html'), overlay: path.join(__dirname, 'sec-overlay.html') };
  const o = { handlerCalls: 0, opened: false };
  const wins = [];
  const onCreated = () => { o.opened = true; };
  try {
    const ses = session.fromPartition('natsu-sec-smoke');
    smokeLoginSes = session.fromPartition('natsu-access-smoke');   // 16c のログインの partition（install は1つだけ: 2つ付けるとログインの窓も全体の止めに当たる）
    security.install({ app, session: ses, pages: PAGES, log: (l) => console.log(`参考: ${l}`), isLoginContents: smokeIsLogin, loginGuard: smokeLoginGuard });
    ses.setDisplayMediaRequestHandler((req, cb) => { o.handlerCalls += 1; cb(null); });
    const open = async (file) => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses },
      });
      wins.push(w);
      await within(w.loadFile(file), 10000, `${path.basename(file)} の読み込み`);
      return w;
    };
    const appWin = await open(PAGES.app);
    const ovWin = await open(PAGES.overlay);
    app.on('browser-window-created', onCreated);
    // 1つの観測が止まっても（移動が止まらずにページが替わったなど）ほかの観測は続け、止まった観測は文字で残す（判定では NG）
    const run = (w, js, what, gesture = false) => within(w.webContents.executeJavaScript(js, gesture), 10000, what)
      .catch((e) => `止まった（${what}）: ${msgOf(e)}`);
    const nameOf = (p) => `${p}.then((s) => { if (s && s.getTracks) s.getTracks().forEach((t) => t.stop()); return 'ok'; }, (e) => (e && e.name) || String(e))`;

    // 8
    o.sandboxed = await run(appWin, 'window.smoke.sandboxed()', 'process.sandboxed');
    // 9: インラインは読み込みで動いたはず。後から script を差し込み、違反の合図を待つ
    o.inlineRan = await run(appWin, 'window.inlineRan === true', 'インラインの script');
    await run(appWin, "(() => { const s = document.createElement('script'); s.textContent = 'window.injectedRan = true;'; document.head.appendChild(s); return 1; })()", '差し込み');
    await wait(300);
    o.injectedRan = await run(appWin, 'window.injectedRan === true', '差し込んだ script');
    o.violations = await run(appWin, 'window.violations', 'CSP の違反の数');
    // 10
    o.gumAudio = await run(appWin, nameOf('navigator.mediaDevices.getUserMedia({ audio: true })'), 'マイク');
    o.audioLabels = await run(appWin, "navigator.mediaDevices.enumerateDevices().then((l) => l.filter((d) => /^audio/.test(d.kind) && d.label).length)", '機器の名前');
    o.gumVideo = await run(appWin, nameOf('navigator.mediaDevices.getUserMedia({ video: true })'), 'カメラ');
    o.gdmApp = await run(appWin, nameOf('navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })'), '本体の窓の画面の取り込み', true);
    // 11
    o.gdmOverlay = await run(ovWin, nameOf('navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })'), '録音バーの窓の画面の取り込み', true);
    // 12: location の書き換え・リンク・window.open
    await run(appWin, "(() => { location.href = 'https://example.invalid/'; return 1; })()", 'location の書き換え');
    await wait(300);
    await run(appWin, "(() => { document.getElementById('out').click(); return 1; })()", 'リンク', true);
    await wait(300);
    const w = await run(appWin, "window.open('https://example.invalid/') === null", 'window.open', true);
    await wait(300);
    if (w !== true) o.opened = w === false ? true : String(w);   // null でない窓が返った → 開いた。止まった → 確かめられない（NG）
    let after = '';
    try { after = path.basename(decodeURIComponent(new URL(appWin.webContents.getURL()).pathname)); } catch (_) { after = ''; }
    o.urlAfter = after;
    return securityResults(o);
  } catch (e) {
    return [8, 9, 10, 11, 12].map((n) => ({ n, ok: false, note: `止まった: ${msgOf(e)}（ここまでの観測 ${JSON.stringify(o)}）` }));
  } finally {
    app.removeListener('browser-window-created', onCreated);
    for (const w of wins) { try { w.destroy(); } catch (_) { /* もう無い */ } }
  }
}

/**
 * 13 の送り: OpenAI と同じ形の multipart（file・model・language・prompt・response_format・temperature）を buildMultipart で組み、
 * postForm で1回送って返事の text を返す（第1d回 A-4 で消した、PC から直に送る口の1回の送りと同じ要求）。2xx でなければ
 * CloudSttError('server')。通信の失敗（転送を断ったときの net など）は postForm の CloudSttError のまま投げる
 */
async function smokeTranscribe(wav, { request, base, key, language, prompt, timeoutMs }) {
  const fields = [['model', SMOKE_STT.fields.model], ['language', language], ['prompt', prompt], ['response_format', 'json'], ['temperature', '0']];
  const boundary = crypto.randomBytes(16).toString('hex');
  const body = sttCloud.buildMultipart(fields, { name: 'file', filename: 'segment.wav', type: 'audio/wav', data: wav }, boundary);
  const res = await sttCloud.postForm({ request, url: `${base}/audio/transcriptions`, body, timeoutMs,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: `Bearer ${key}` } });
  if (res.status < 200 || res.status > 299) throw new sttCloud.CloudSttError('server', { status: res.status });
  const j = JSON.parse(res.body.toString('utf8'));
  return j && typeof j.text === 'string' ? j.text : '';
}

/**
 * 13・14: 本物の net.request と safeStorage で観測を集める（判定は onlineResults）。どこかで止まっても観測を残して判定に回す。
 * 送り先は 127.0.0.1 の偽物だけ（外へはつながない）。鍵の文字は記録に書かない。
 */
async function onlineChecks({ app, net, safeStorage }) {
  const o = { sttRequests: [], redirects: [] };
  const request = (opts) => net.request(opts);
  const closers = [];
  // 13
  try {
    const f = await startFakeStt({ key: SMOKE_STT.key, text: SMOKE_STT.text });
    closers.push(() => f.close());
    o.text = await within(smokeTranscribe(lib.silentWav(0.5), { request, base: f.base, key: SMOKE_STT.key,
      language: SMOKE_STT.fields.language, prompt: SMOKE_STT.fields.prompt, timeoutMs: 15000 }), 20000, 'smokeTranscribe');
    o.sttRequests = f.requests.slice();
    // 302・307 を返す宛先（転送の先は別の偽の送り先。届けば targetHits が増える）
    const g = await startFakeStt({ key: SMOKE_STT.key });
    closers.push(() => g.close());
    const reached = {};
    const hop = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const st = Number((/^\/r(\d{3})\//.exec(req.url) || [])[1]) || 302;
        reached[st] = (reached[st] || 0) + 1;
        res.writeHead(st, { location: `${g.base}/audio/transcriptions`, 'content-type': 'text/plain' });
        res.end('moved');
      });
    });
    await new Promise((resolve, reject) => { hop.once('error', reject); hop.listen(0, '127.0.0.1', resolve); });
    closers.push(() => new Promise((r) => { hop.close(() => r()); hop.closeAllConnections(); }));
    for (const st of REDIRECTS) {
      const before = g.requests.length;
      const base = `http://127.0.0.1:${hop.address().port}/r${st}`;
      let code = '';
      let cloud = false;
      try {
        await within(smokeTranscribe(lib.silentWav(0.5), { request, base, key: SMOKE_STT.key, language: 'ja', prompt: SMOKE_STT.fields.prompt,
          timeoutMs: 15000 }), 20000, `転送 ${st}`);
      } catch (e) {
        cloud = e instanceof sttCloud.CloudSttError;
        code = cloud ? e.code : `投げた（${msgOf(e)}）`;
      }
      await wait(200);
      o.redirects.push({ status: st, reached: (reached[st] || 0) >= 1, cloud, code, targetHits: g.requests.length - before });
    }
  } catch (e) {
    o.error13 = msgOf(e);
  }
  // 14
  o.platform = process.platform;
  try {
    o.asyncAvailable = await within(Promise.resolve(safeStorage.isAsyncEncryptionAvailable()), 10000, 'isAsyncEncryptionAvailable');
    o.backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : '';
    try {
      const plain = `NaTsu の鍵の試し 𠮷 ${SMOKE_STT.key}`;
      const enc = await within(safeStorage.encryptStringAsync(plain), 10000, 'encryptStringAsync');
      const back = await within(safeStorage.decryptStringAsync(enc), 10000, 'decryptStringAsync');
      o.roundTrip = Boolean(back && back.result === plain) && !Buffer.from(enc).toString('latin1').includes(SMOKE_STT.key);
    } catch (e) {
      o.roundTrip = false;
      o.error14 = `暗号の往復: ${msgOf(e)}`;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-smoke-secrets-'));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'secrets.json');
    const r = await within(makeSecrets({ file, safeStorage, J }).set('relay', SMOKE_STT.key), 10000, 'secrets.set');
    o.setCode = r.ok ? 'ok' : r.code;
    // しまったものを、別の係（ファイルから読み直す）で読み返す
    o.getBack = (await within(makeSecrets({ file, safeStorage, J }).get('relay'), 10000, 'secrets.get')) === SMOKE_STT.key;
    o.plainInFile = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').includes(SMOKE_STT.key) : false;
    if (o.setCode === 'ok') o.reEncryptBack = await reEncryptCheck({ file, safeStorage });
  } catch (e) {
    o.error14 = msgOf(e);
  }
  for (const c of closers.reverse()) { try { await within(Promise.resolve(c()), 5000, '送り先を閉じる'); } catch (_) { /* 閉じられなくても判定は出す */ } }
  return onlineResults(o);
}

/**
 * 14 の続き（しまえる PC だけ）: 本物の decryptStringAsync の返りに、最初の1回だけ shouldReEncrypt: true を足す包みで
 * secrets.get を呼ぶ。鍵が返り、包みの encryptStringAsync が作った新しい暗号の文字がそのまま secrets.json に書かれ
 * （鍵の文字は無い）、包まない別の係で読み戻せれば true。鍵の文字は記録に出さない。
 */
async function reEncryptCheck({ file, safeStorage }) {
  const storedOf = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).keys.relay || ''; } catch (_) { return ''; }
  };
  const before = storedOf();
  let decrypts = 0;
  const fresh = [];
  const wrapped = {
    isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend(),
    encryptStringAsync: async (s) => { const b = await safeStorage.encryptStringAsync(s); fresh.push(Buffer.from(b).toString('base64')); return b; },
    decryptStringAsync: async (b) => {
      const real = await safeStorage.decryptStringAsync(b);
      decrypts += 1;
      return decrypts === 1 ? { ...real, shouldReEncrypt: true } : real;
    },
  };
  // 書いた回数も数える（同じ文字から同じ暗号ができる入れ物でも、書き直したことを見分ける）
  let writes = 0;
  const countedJ = { ...J, writeJsonFile: (...a) => { const r = J.writeJsonFile(...a); writes += 1; return r; } };
  const got = await within(makeSecrets({ file, safeStorage: wrapped, J: countedJ }).get('relay'), 10000, 'secrets.get（暗号にし直す）');
  const after = storedOf();
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const back = await within(makeSecrets({ file, safeStorage, J }).get('relay'), 10000, 'secrets.get（読み戻す）');
  return got === SMOKE_STT.key && decrypts === 1 && fresh.length === 1 && writes === 1 && before !== '' && after === fresh[0]
    && !text.includes(SMOKE_STT.key) && back === SMOKE_STT.key;
}

/**
 * 16: 本物の net.request と、メモリの partition（natsu-access-smoke）の cookie で観測を集める（判定は accessResults）。
 * 送り先は 127.0.0.1 の口だけ（外へはつながない）。どこかで止まっても観測を残して判定に回す（見張りの 90 秒を待たない）。
 */
async function accessChecks({ app, net, session, BrowserWindow }) {
  const o = { platform: process.platform, targetHits: 0 };
  const got = [];
  let server = null;
  try {
    const ses = session.fromPartition('natsu-access-smoke');
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        got.push({ url: req.url, headers: req.headers });
        if (req.url.startsWith('/r302')) { res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/target` }); res.end(); return; }
        if (req.url.startsWith('/target')) o.targetHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const expirationDate = Math.floor(Date.now() / 1000) + 3600;
    // url だけで置く = host-only。Chromium は SameSite=None を Secure なしでは置かない
    await within(ses.cookies.set({ url: base, name: 'a_lax', value: '1', httpOnly: true, secure: false, sameSite: 'lax', expirationDate }), 10000, 'cookies.set（lax）');
    await within(ses.cookies.set({ url: base, name: 'a_strict', value: '1', httpOnly: true, secure: false, sameSite: 'strict', expirationDate }), 10000, 'cookies.set（strict）');
    try {
      await within(ses.cookies.set({ url: base, name: 'a_none', value: '1', httpOnly: true, secure: true, sameSite: 'no_restriction', expirationDate }), 10000, 'cookies.set（Secure）');
      o.secureLoopback = true;
    } catch (e) {
      o.secureLoopback = false;
      o.secureSetError = msgOf(e);
    }
    const request = (opts) => net.request(opts);
    await within(sttCloud.postForm({ request, url: `${base}/ok`, method: 'GET', session: ses, redirect: 'manual', timeoutMs: 10000 }), 15000, '16a の送り');
    const h = (got.find((g) => g.url === '/ok') || {}).headers || {};
    const sent = String(h.cookie || '').split(';').map((x) => x.trim());
    o.laxStrictSent = sent.includes('a_lax=1') && sent.includes('a_strict=1');
    o.secureSent = sent.includes('a_none=1');
    o.xrw = h['x-requested-with'] === 'XMLHttpRequest';
    // 302: 'redirect' が起きて、followRedirect を呼ばなければ転送の先に要求が来ない。その後の出来事を記録する
    let after = '';
    const watching = (opts) => {
      const r = net.request(opts);
      r.on('redirect', () => { o.redirectEvent = true; });
      for (const ev of ['abort', 'error', 'close']) r.on(ev, (e) => { if (o.redirectEvent && !after) after = ev + (e && e.message ? `（${e.message}）` : ''); });
      return r;
    };
    try {
      await within(sttCloud.postForm({ request: watching, url: `${base}/r302`, method: 'GET', session: ses, redirect: 'manual', timeoutMs: 10000 }), 15000, '16a の 302');
      o.redirectCode = '失敗にならない';
    } catch (e) {
      o.redirectCode = e instanceof sttCloud.CloudSttError ? e.code : `投げた（${msgOf(e)}）`;
    }
    await wait(300);
    o.redirectEvent = o.redirectEvent === true;
    o.afterRedirect = after || 'none';
    if (!o.secureLoopback && process.platform === 'win32') o.https = await accessHttpsCheck({ ses, net });
    o.guard = await accessGuardCheck({ BrowserWindow });
    o.partitionsDir = ['userData', 'sessionData'].some((k) => fs.existsSync(path.join(app.getPath(k), 'Partitions')));
  } catch (e) {
    o.error = msgOf(e);
  } finally {
    if (server) await new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
  }
  return accessResults(o);
}

/**
 * 16c（第1d回 A-11・F25）: ログインの窓の守りの仕組み（security.install の除外と止め方）を本物の Electron で見る。行き先の判断そのもの
 * （relay.loginNavAllowed）は relay-app の単体テストが見るので、ここでは試しの行き先（127.0.0.1 の口 A）だけを許す。口 B は許さない。
 * → { formPosted, navBlocked, redirectBlocked, openDenied, defaultBlocked, blocked（止めた出来事の種類）, error? }
 */
async function accessGuardCheck({ BrowserWindow }) {
  const g = { formPosted: false, navBlocked: false, redirectBlocked: false, openDenied: false, defaultBlocked: false };
  const hits = { a: [], b: [] };
  const servers = [];
  const wins = [];
  const FORM = '<!doctype html><meta charset="utf-8"><title>16c</title><form id="f" method="post" action="/post"><input name="x" value="1"></form>';
  try {
    let baseB = '';
    const serve = (tag) => http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits[tag].push(`${req.method} ${req.url}`);
        if (tag === 'a' && req.url.startsWith('/redir')) { res.writeHead(302, { location: `${baseB}/redirected` }); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(FORM);
      });
    });
    const listen = async (srv) => { servers.push(srv); await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); }); return srv.address().port; };
    const portA = await listen(serve('a'));
    baseB = `http://127.0.0.1:${await listen(serve('b'))}`;
    const baseA = `http://127.0.0.1:${portA}`;
    smokeLoginAllow = (url) => { try { const u = new URL(String(url)); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === String(portA); } catch (_) { return false; } };
    smokeLoginBlocked.length = 0;
    const win = new BrowserWindow({ show: false, webPreferences: { partition: 'natsu-access-smoke', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    wins.push(win);
    const navs = [];
    win.webContents.on('did-navigate', (_e, url, code) => { navs.push({ url, code }); });
    await within(win.loadURL(`${baseA}/form`), 10000, '16c の読み込み');
    const run = (w, js, what) => within(w.webContents.executeJavaScript(js), 10000, what).catch((e) => `止まった（${what}）: ${msgOf(e)}`);
    // 許した口へのフォームの送り（POST）が通り、did-navigate が来る
    await run(win, "(() => { document.getElementById('f').submit(); return 1; })()", '16c のフォームの送り');
    for (let i = 0; i < 50 && !navs.some((n) => n.url === `${baseA}/post`); i++) await wait(100);
    g.formPosted = hits.a.includes('POST /post') && navs.some((n) => n.url === `${baseA}/post` && n.code === 200);
    // 許していない口への移動は止まる（口 B に要求が来ない・ページは替わらない）
    await run(win, `(() => { location.href = '${baseB}/x'; return 1; })()`, '16c の許していない移動');
    await wait(500);
    g.navBlocked = hits.b.length === 0 && smokeLoginBlocked.some((b) => b.kind === 'will-navigate' || b.kind === 'will-frame-navigate')
      && win.webContents.getURL() === `${baseA}/post`;
    // 許した口の 302 の先（口 B）への転送は止まる
    const nBlocked = smokeLoginBlocked.length;
    await run(win, `(() => { location.href = '${baseA}/redir'; return 1; })()`, '16c の転送');
    await wait(500);
    g.redirectBlocked = hits.a.includes('GET /redir') && hits.b.length === 0 && smokeLoginBlocked.slice(nBlocked).some((b) => b.kind === 'will-redirect');
    // window.open は断る
    const before = BrowserWindow.getAllWindows().length;
    const opened = await run(win, `window.open('${baseA}/form') === null`, '16c の window.open');
    await wait(300);
    g.openDenied = opened === true && BrowserWindow.getAllWindows().length === before;
    // 既定の session の窓（ログインの窓でない）のフォームの送りは、今のまま全体の守りが止める
    const dwin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    wins.push(dwin);
    await within(dwin.loadURL(`${baseA}/form?w=default`), 10000, '16c の既定の session の読み込み');
    await run(dwin, "(() => { const f = document.getElementById('f'); f.action = '/post-default'; f.submit(); return 1; })()", '16c の既定の session の送り');
    await wait(500);
    g.defaultBlocked = !hits.a.includes('POST /post-default');
    g.blocked = smokeLoginBlocked.map((b) => b.kind);
  } catch (e) {
    g.error = msgOf(e);
  } finally {
    smokeLoginAllow = () => false;
    for (const w of wins) { try { w.destroy(); } catch (_) { /* もう無い */ } }
    for (const srv of servers) await new Promise((r) => { srv.close(() => r()); srv.closeAllConnections(); });
  }
  return g;
}

// 16b の PowerShell（一時の証明書を CurrentUser\My に作り、鍵つきで pfx に書き出し、指紋と DER を返す）。値は環境変数で渡す
const MAKE_CERT_PS = [
  "$ErrorActionPreference = 'Stop'",
  "$c = New-SelfSignedCertificate -Subject 'CN=127.0.0.1' -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 "
    + "-NotAfter (Get-Date).AddDays(1) -TextExtension @('2.5.29.17={text}IPAddress=127.0.0.1')",
  '$p = ConvertTo-SecureString -String $env:NATSU_PFX_PASS -Force -AsPlainText',
  'Export-PfxCertificate -Cert $c -FilePath $env:NATSU_PFX_PATH -Password $p -CryptoAlgorithmOption TripleDES_SHA1 | Out-Null',
  "Write-Output ($c.Thumbprint + ' ' + [Convert]::ToBase64String($c.RawData))",
].join('; ');

const powershell = (command, env, ms) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { env: { ...process.env, ...env }, timeout: ms, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

/**
 * 16b（Secure を http://127.0.0.1 に置けない Windows だけ）: 一時の証明書で 127.0.0.1 に https の口を開き、その partition にだけ
 * setCertificateVerifyProc でその証明書の指紋（sha256）だけを通して、Secure・SameSite=None・HttpOnly の cookie が届くかを見る。
 * 終わったら証明書を店（Remove-Item）とファイル（一時フォルダごと）の両方から消し、確かめの口を外す。→ { ran, sent, error? }
 */
async function accessHttpsCheck({ ses, net }) {
  const out = { ran: false };
  let tmp = '';
  let thumb = '';
  let server = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-smoke-https-証明書𠮷-'));
    const pfxPath = path.join(tmp, 'smoke.pfx');
    const pass = crypto.randomBytes(16).toString('hex');
    const line = (await within(powershell(MAKE_CERT_PS, { NATSU_PFX_PASS: pass, NATSU_PFX_PATH: pfxPath }, 30000), 35000, '証明書を作る')).trim().split(/\s+/);
    thumb = /^[0-9A-F]{40}$/i.test(line[0] || '') ? line[0] : '';
    if (!thumb || !line[1]) throw new Error('証明書の指紋が返らない');
    const want = 'sha256/' + crypto.createHash('sha256').update(Buffer.from(line[1], 'base64')).digest('base64');
    const https = require('https');
    let cookie = '';
    server = https.createServer({ pfx: fs.readFileSync(pfxPath), passphrase: pass }, (req, res) => {
      req.resume();
      req.on('end', () => { cookie = String(req.headers.cookie || ''); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `https://127.0.0.1:${server.address().port}`;
    ses.setCertificateVerifyProc((req, cb) => cb(req.hostname === '127.0.0.1' && req.certificate && req.certificate.fingerprint === want ? 0 : -2));
    await within(ses.cookies.set({ url: base, name: 'a_none', value: '1', httpOnly: true, secure: true, sameSite: 'no_restriction',
      expirationDate: Math.floor(Date.now() / 1000) + 3600 }), 10000, 'cookies.set（https の Secure）');
    await within(sttCloud.postForm({ request: (opts) => net.request(opts), url: `${base}/ok`, method: 'GET', session: ses, redirect: 'manual', timeoutMs: 10000 }), 15000, '16b の送り');
    out.ran = true;
    out.sent = cookie.split(';').map((x) => x.trim()).includes('a_none=1');
  } catch (e) {
    out.error = msgOf(e);
  } finally {
    try { ses.setCertificateVerifyProc(null); } catch (_) { /* 外せなくても判定は出す */ }
    if (server) await new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
    if (thumb) {
      try { await within(powershell(`Remove-Item -Path ('Cert:\\CurrentUser\\My\\' + $env:NATSU_THUMB) -DeleteKey`, { NATSU_THUMB: thumb }, 30000), 35000, '証明書を消す'); } catch (e) {
        out.cleanup = `証明書を消せない: ${msgOf(e)}`;
      }
    }
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 消せなくても判定は出す */ } }
  }
  return out;
}

/**
 * 17: 本物の録音バーと同じ作りの窓（src/main.js の createOverlay と同じ透過・枠なし・resizable: false・focusable: false・影なし。
 * backgroundThrottling は付けない: 透過の窓の地雷）を出して、PANEL_SIZES を順に setBounds で当て、getBounds() の大きさを集める
 * （判定は panelResults）。scale は主な画面の拡大率（want は頼んだ拡大率）。投げない
 */
async function panelCheck({ BrowserWindow, screen, want }) {
  const out = { sizes: PANEL_SIZES, got: [], scale: 0, want };
  let w = null;
  try {
    out.scale = screen.getPrimaryDisplay().scaleFactor;
    w = new BrowserWindow({
      width: 256, height: 56, frame: false, transparent: true, resizable: false, movable: true,
      minimizable: false, maximizable: false, focusable: false, alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    w.showInactive();
    for (const [width, height] of PANEL_SIZES) {
      w.setBounds({ x: 100, y: 100, width, height });
      await new Promise((r) => { setTimeout(r, 50); });
      const b = w.getBounds();
      out.got.push({ width: b.width, height: b.height });
    }
  } catch (e) {
    out.error = (e && e.message) || String(e);
  } finally {
    try { if (w) w.destroy(); } catch (_) { /* 消せなくても判定は出す */ }
  }
  return panelResults(out);
}
// 17 の判定（純粋）: 当てた大きさが全部ちょうど同じ整数で返り、頼んだ拡大率で動いた（1.25 を頼んで 1 のままなら確かめになっていない）
function panelResults(o) {
  const sizes = Array.isArray(o && o.sizes) ? o.sizes : [];
  const got = Array.isArray(o && o.got) ? o.got : [];
  const same = !o.error && sizes.length > 0 && got.length === sizes.length
    && sizes.every(([w, h], i) => got[i] && got[i].width === w && got[i].height === h);
  const scaled = Math.abs(Number(o.scale) - Number(o.want)) < 1e-6;
  const seen = got.map((g) => `${g.width}×${g.height}`).join('・') || 'なし';
  const note = `拡大率 ${o.scale}（頼んだのは ${o.want}）・当てた ${sizes.map(([w, h]) => `${w}×${h}`).join('・')}・返った ${seen}${o.error ? `・失敗 ${o.error}` : ''}`;
  return [{ n: 17, ok: same && scaled, note }];
}

// 18: natsu:// の登録（Windows だけ。確かめた後に外す）
async function protocolCheck({ app }) {
  if (process.platform !== 'win32') return protocolResults({ platform: process.platform });
  const o = { platform: process.platform, exe: process.execPath, set: false, value: '', removed: false };
  try {
    o.set = app.setAsDefaultProtocolClient('natsu', process.execPath, ['--']) === true;
    const out = await new Promise((resolve) => {
      execFile('reg', ['query', 'HKCU\\Software\\Classes\\natsu\\shell\\open\\command', '/ve'], { windowsHide: true, timeout: 10000 },
        (err, stdout) => resolve(err ? '' : String(stdout || '')));
    });
    o.value = regDefaultValue(out);
  } catch (e) { o.error = msgOf(e); }
  try { app.removeAsDefaultProtocolClient('natsu', process.execPath, ['--']); o.removed = !app.isDefaultProtocolClient('natsu', process.execPath, ['--']); } catch (e) { o.error = o.error || msgOf(e); }
  return protocolResults(o);
}
// reg query の答えから既定の値（REG_SZ の後ろ）を取る。無ければ ''
function regDefaultValue(stdout) {
  const m = /REG_SZ[ \t]+(.*?)\s*$/m.exec(String(stdout || ''));
  return m ? m[1] : '';
}
// 18 の判定（純粋）
function protocolResults(o) {
  if (!o || o.platform !== 'win32') return [{ n: 18, ok: true, note: 'Windows でだけ確かめる（このOSは確かめない）' }];
  const want = `"${o.exe}" -- "%1"`;
  const ok = o.set === true && o.value === want && o.removed === true;
  return [{ n: 18, ok, note: `登録 ${o.set}・コマンド ${JSON.stringify(o.value)}（求めるのは ${JSON.stringify(want)}）・外した ${o.removed}${o.error ? `・失敗 ${o.error}` : ''}` }];
}

// 19: 本物の Chromium で assets/icon.svg を 256px に描き、assets/icon.png と比べる（判定は iconResults）。投げない
const ICON_SIZE = 256;
const ICON_TOL = 32;        // どれかの色がこれより違う画素を「違う」と数える（縁のにじみの描き方の差は拾わない）
const ICON_MAX = 0.01;      // 違う画素がこの割合より少なければ OK（RF-LG1）
const ICON_SVG = path.join(ROOT, 'assets', 'icon.svg');
const ICON_PNG = path.join(ROOT, 'assets', 'icon.png');
async function iconCheck({ BrowserWindow }) {
  const o = { width: 0, height: 0 };
  let w = null;
  try {
    const svg = fs.readFileSync(ICON_SVG).toString('base64');
    const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#ffffff;overflow:hidden}'
      + `img{display:block;width:${ICON_SIZE}px;height:${ICON_SIZE}px}</style></head><body><img src="data:image/svg+xml;base64,${svg}"></body></html>`;
    w = new BrowserWindow({
      width: ICON_SIZE, height: ICON_SIZE, useContentSize: true, show: false, frame: false, resizable: false,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    w.setContentSize(ICON_SIZE, ICON_SIZE);
    await within(w.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`), 10000, 'ロゴのページ');
    await within(w.webContents.executeJavaScript('document.images[0].decode().then(() => true)', true), 10000, 'ロゴの読み込み');
    await wait(300);
    let im;
    try { im = await within(w.webContents.capturePage(), 10000, '撮影'); } catch (_) {
      w.webContents.invalidate();
      await wait(300);
      im = await within(w.webContents.capturePage(), 10000, '撮影のやり直し');
    }
    const size = im.getSize();
    o.width = size.width; o.height = size.height;
    if (o.width === ICON_SIZE && o.height === ICON_SIZE) {
      const { decodePng } = require('../ico.js');
      o.diff = iconDiff(im.toBitmap(), decodePng(fs.readFileSync(ICON_PNG)).rgba, ICON_SIZE, ICON_SIZE);
    }
  } catch (e) {
    o.error = msgOf(e);
  } finally {
    try { if (w) w.destroy(); } catch (_) { /* 消せなくても判定は出す */ }
  }
  return iconResults(o);
}
// 19 の数え方（純粋）: icon（RGBA・乗算済みでない）を白い地に置いた色と、Chromium の画像（toBitmap の BGRA）の、どれかの色が ICON_TOL より違う画素の数
function iconDiff(bgra, rgba, width, height) {
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4, a = rgba[o + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const want = Math.round(rgba[o + c] * a + 255 * (1 - a));
      if (Math.abs(bgra[o + 2 - c] - want) > ICON_TOL) { n++; break; }
    }
  }
  return n;
}
// 19 の判定（純粋）
function iconResults(o) {
  const total = ICON_SIZE * ICON_SIZE;
  const sized = o && o.width === ICON_SIZE && o.height === ICON_SIZE;
  const ok = Boolean(o) && !o.error && sized && Number.isInteger(o.diff) && o.diff / total < ICON_MAX;
  const share = Number.isInteger(o && o.diff) ? `${o.diff} 画素（${(100 * o.diff / total).toFixed(2)}%）` : '数えられない';
  return [{ n: 19, ok, note: `撮った大きさ ${o ? o.width : 0}×${o ? o.height : 0}（求めるのは ${ICON_SIZE}×${ICON_SIZE}）・違う画素 ${share}（1% 未満で OK）${o && o.error ? `・失敗 ${o.error}` : ''}` }];
}

if (process.versions.electron && process.type === 'browser') boot();
else if (require.main === module) {
  console.error('electron-smoke は Electron の main として動かす: <electron の実行ファイル> tools/electron-smoke');
  process.exitCode = 2;
}

module.exports = { CHECKS, SMOKE_STT, SMOKE_DB, exitCodeOf, clipboardChecks, securityResults, onlineResults, dbResults, accessResults, reEncryptCheck, finish,
  PANEL_SIZES, panelResults, checksFor, scaleFor, protocolResults, regDefaultValue, iconDiff, iconResults };
