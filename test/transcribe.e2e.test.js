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
 *   - 区間の要求が返事の前に接続ごと切れたら（UND_ERR_SOCKET など）、同じ区間を 1 回だけ送り直す。
 *     それでも切れたら失敗として区間を残し、理由は日本語で書く（"fetch failed" を見せない。CI run 39183232615）
 *   - 起動テスト（app:test）は /inference に無音を実際に送り、返事の異常を見逃さない。
 *     記録や文字起こしの最中は試さない
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execScene } = require('./helpers/scene-slots');
const net = require('node:net');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const { vcRuntimeIssue } = require('../src/mainlib');

// 場面ごとの文字起こしエンジンのポートを、先にまとめて取る。別々に空きを探すと、並べて走らせた
// 場面どうしで同じポートを掴むことがある（100 回に 1 回ほど落ちた）。
// 0.9.0 見た目の直しの CI（run 39484701958・ubuntu）で、取ってから場面がエンジンを起こすまでの間に、そのポートを別の場面の
// 外向きの接続（OS が送り元に選ぶ一時的なポート）が使い、「ポート 45481 は他のプロセスが使用中」で2つのテストが落ちた。
// listen(0) で取るポートは、その一時的なポートと同じ範囲（Linux 32768〜60999・Windows 49152〜65535）から出るので、
// 取ったポートを閉じた後に送り元として使われ得る。Linux と macOS では一時的なポートの範囲より下（20000〜32767）から、実際に listen
// できたものだけを取る。Windows は今までどおり listen(0)（範囲より下のポートでは、Windows の CI で多くの場面の最初の区間が
// ECONNABORTED になった: run 39491867266 の electron-smoke。Windows の機械はその範囲を別の仕組みが使うことがある）
const LOW_RANGE = process.platform !== 'win32';
const PORT_LO = 20000, PORT_HI = 32767;
const tryListen = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(null));
  s.listen(port, '127.0.0.1', () => resolve(s));
});
async function reservePorts(n) {
  const servers = [];
  if (!LOW_RANGE) {
    for (let i = 0; i < n; i++) { const s = await tryListen(0); if (!s) throw new Error('空きのポートを取れない'); servers.push(s); }
  }
  let port = PORT_LO + Math.floor(Math.random() * (PORT_HI - PORT_LO - 2000));   // 別のテストの走りと重ならないよう、始めを散らす
  for (let tries = 0; servers.length < n && tries < 4000; tries++, port = port >= PORT_HI ? PORT_LO : port + 1) {
    const s = await tryListen(port);
    if (s) servers.push(s);
  }
  if (servers.length < n) throw new Error(`一時的なポートの範囲の外に空きのポートが ${n} 個ない`);
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

function run(args) {
  return new Promise((resolve, reject) => {
    execScene(process.execPath, [RUN, ...args], { timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
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
  // 0.9.1 Q-2 で意図して変えた: 無音（一番大きい 0.5 秒が -55 dBFS より小さい）はエンジンへ送らなくなったので、「3 秒の無音の真ん中の 0.6 秒の小さな音」
  // （窓 約 -45 dBFS で送るが、区間全体は約 -52 dBFS で RETRY_MIN_DBFS より小さい）にした。無音を送らないことは stage091.main が見る
  silentNoVad: ['empty', '--blip', '--blip-sec=3', '--segs=1'],
  silentVad: ['empty', '--blip', '--blip-sec=3', '--vad', '--segs=1'],
  err200: ['err200', '--test'],
  dropFirst: ['drop-first', '--segs=1', '--after-retry'],
  dropAll: ['drop-all', '--segs=1', '--after-retry'],
  probe500: ['probe500', '--test'],
  probeBadJson: ['probe-badjson', '--test'],
  probeDrop: ['probe-drop', '--test'],
  busy: ['slow', '--test-during'],
  kotoba: ['prompt-empty', '--kotoba'],
  // 0.10.0 LS-2（D59）で意図して直した: 要約は Claude Code だけなので、偽の claude（偽の llama と同じ「文字起こしに無い担当・期限」を混ぜた Markdown）で作る
  sumGround: ['text', '--sum', '--claude=ok', '--text=山田さんが来週金曜までに進捗の確認をまとめます。'],
  sumType: ['text', '--sum', '--claude=slow', '--claude-delay=1500', '--set-type-during=standup'],
};
// 取り込んだエンジン・取り込みの案内の場面（第0b回 Task 13）。1 つ 0.5〜0.7 秒と軽いが、上の場面と同時に走らせると
// node のプロセスが CPU を取り合い、上の重い場面（busy は 1.5 秒の返事を 2 回待つ）が 5 秒を超える。上の場面が済んでから走らせる
const MANAGED_SCENES = {
  managed: ['text', '--managed', '--test'],
  managedTamper: ['text', '--managed-tamper', '--slow-load'],
  managedRecover: ['text', '--managed', '--recover'],
  managedNoRuntime: ['text', '--managed', '--no-vc-runtime'],
  managedVerifyThrows: ['text', '--managed', '--verify-throws'],
  // managedSumBroken（要約の組を壊した PC）は 0.10.0 LS-3（D59）で外した（要約の組を取り込まない）
  noEngineFetchable: ['text', '--no-engine=fetchable'],
  noEngineUnsupported: ['text', '--no-engine=unsupported'],
  fetch: ['text', '--fetch'],
  fetchSum: ['text', '--fetch', '--sum'],   // 0.10.0 LS-3 から --sum の要約の設定は知らないキー（取り込む組は文字起こしだけで同じ）
  repair: ['text', '--managed-tamper', '--repair'],
  managedCrash: ['text', '--managed', '--crash'],
  managedCrashOk: ['text', '--managed', '--crash-ok'],
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
// 進み具合の知らせが組を「使える」（w = whisperReady・s = sumReady）と言ったのに、main がまだ切り替えて知らせていない分
//（画面はその知らせでエンジンの状態を聞き直すので、main が使い始める前に言うと「要確認」のまま残る。第0b回 Task 14・15）
const readyBeforeNotice = (seq, key, re) => {
  const at = seq.findIndex((x) => x.notice && re.test(x.notice));
  assert.ok(at >= 0, `知らせが無い: ${re}`);
  return seq.slice(0, at).filter((x) => !x.notice && x[key]);
};
// 進み具合が初めて「使える」と言ったときの engine:status は、もう落ち着いた答え（場面の終わりの答え）と同じ。文字起こしは ''
// （0.10.0 LS-3（D59）で意図して直した: 要約のエンジンの欄 sum と、要約のエンジンの知らせ S_READY を外した）
const settled = (r) => {
  assert.strictEqual(r.engineStatus.whisper, '');
  assert.ok(!('sum' in r.engineStatus), 'engine:status に要約のエンジンの欄が残っている');
  return { whisper: r.engineStatus.whisper };
};
const W_READY = /^文字起こしが使えるようになりました。/;
const meetingReqs = (r) => r.requests.filter((l) => !/probe=true/.test(l));
const prompted = (r) => meetingReqs(r).map((l) => /prompt=true/.test(l));
// 照らしが落ちたときの手がかり（第1d回 A-14・あとの直し (c)。CI run 39335178338 の Windows で1回だけ「# fail 2」になり、どの区間が
// なぜ落ちたかが記録から分からなかった）: 失敗の文に、場面の engine.log と要求の全部をいつも添える（会議の後の送り直しの写しも）
const explain = (r) => JSON.stringify({ engineLog: r && r.engineLog, requests: r && r.requests,
  ...(r && r.afterRetry ? { afterRetry: { engineLog: r.afterRetry.engineLog, requests: r.afterRetry.requests } } : {}) });
// 場面を使うテストの中身を包む。中身には、待った場面を覚える need を渡し、どの assert が落ちても、待った場面ごとの explain を
// 失敗の文の後ろに足す（文の頭と、落ちた行の stack はそのまま）。1つずつの assert の文に書くと、足し忘れた照らしで手がかりが欠ける
const withExplain = (fn) => async () => {
  const seen = new Set();
  try {
    await fn((...ks) => { ks.forEach((k) => seen.add(k)); return need(...ks); });
  } catch (e) {
    if (e && typeof e === 'object' && seen.size) e.message += `\n${[...seen].map((k) => `${k}: ${explain(results[k])}`).join('\n')}`;
    throw e;
  }
};
// 場面を使うテストは test の代わりにこれで書く
const sceneTest = (name, fn) => test(name, withExplain(fn));

sceneTest('ヒント付きで空なら、ヒントなしでもう一度送り、区間を残す。2 回続いたら以後はヒントを渡さない（0.1.0 の「0 区間」）', async (need) => {
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

sceneTest('文字が取れたときは 1 回だけ送り、ヒントも止めない', async (need) => {
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

sceneTest('本当に空なら、engine.log に区間ごとの理由を書き、全部が空なら利用者に知らせる', async (need) => {
  await need('empty');
  const r = results.empty;
  // 第1d回 A-6（D17）で意図して変えた: 音のある区間が 75 秒の会議で2つ続けて空なら「止まっているかもしれない」とし、2区間を
  // 音声ごと失敗の区間として残す（前は区間ごと消していた）。会議の後の送り直しでも空なら消えるので、どちらの形でも文字は残らない
  assert.ok(r.pages[0].segments.every((s) => s.failed && s.text === '（音はありましたが、文字になりませんでした）'), JSON.stringify(r.pages[0].segments));
  // 0.10.0 LS-2（D69・決めたこと 111 の 6）で意図して変えた: 文字起こしが空のページは要約の欄に理由を書かない（欄の鍵のまま、頭の一言
  // 「文字起こしが無いので、要約は作れません。」が伝える）。理由と確かめ方は知らせで出す
  assert.strictEqual(r.pages[0].summaryError, '');
  // [BLANK_AUDIO] だけの返事も空として扱う（数えるのは議事録を保存するまでの2区間。A-6 から、残した2区間は会議の後にもう一度送る）
  const live = r.engineLog.slice(0, r.engineLog.indexOf('議事録を保存: 文字起こしが空の区間が 2、文字の残った区間は 0'));
  assert.strictEqual(live.filter((l) => /^文字起こし: 認識ヒント（\d+ バイト）付きでは空 → ヒントなしでも空/.test(l)).length, 2, JSON.stringify(r.engineLog));
  assert.strictEqual(r.engineLog.filter((l) => /^区間 s\d+（音声 \d+ 秒）: 文字起こしが空のため除きました$/.test(l)).length, 2, JSON.stringify(r.engineLog));
  assert.ok(r.engineLog.includes('議事録を保存: 文字起こしが空の区間が 2、文字の残った区間は 0'), JSON.stringify(r.engineLog));
  const notice = r.notices.find((n) => n.startsWith('2 区間の音声を受け取りましたが、文字起こしの結果がすべて空でした。'));
  assert.ok(notice, `利用者に知らせていない: ${JSON.stringify(r.notices)}`);
  assert.match(notice, /使用するマイク/);
  assert.match(notice, /engine\.log/);
  // 空が続いても、ヒントは止めない（ヒントのせいだと分かったわけではない）
  assert.strictEqual(r.promptInfo.off, false);
});

sceneTest('空の区間が 1 つだけでも、全部が空なら知らせる。一部だけ空なら知らせない', async (need) => {
  await need('emptyOne', 'mixed');
  assert.ok(results.emptyOne.notices.some((n) => n.startsWith('1 区間の音声を受け取りましたが、文字起こしの結果がすべて空でした。')),
    JSON.stringify(results.emptyOne.notices));
  const m = results.mixed;
  assert.strictEqual(m.pages[0].segments.length, 1, JSON.stringify(m.pages));
  assert.ok(m.engineLog.some((l) => /^区間 s1（音声 3 秒）: 文字起こしが空のため除きました$/.test(l)), JSON.stringify(m.engineLog));
  assert.ok(!m.notices.some((n) => /すべて空/.test(n)), `一部が取れたのに知らせた: ${JSON.stringify(m.notices)}`);
});

sceneTest('VAD が無く、ほぼ無音なら、ヒントなしのやり直しをしない（VAD があればやり直す）', async (need) => {
  await need('silentNoVad', 'silentVad');
  const a = results.silentNoVad;
  assert.deepStrictEqual(prompted(a), [true], JSON.stringify(a.requests));
  assert.ok(a.engineLog.some((l) => /^文字起こし: 認識ヒント付きでは空。音がほとんど無いため（-5\d dBFS）、ヒントなしでのやり直しは省きました/.test(l)), JSON.stringify(a.engineLog));
  const b = results.silentVad;
  assert.match(b.spawnArgs, /--vad/, 'VAD の偽モデルを置いたのに --vad で起動していない');
  assert.deepStrictEqual(prompted(b), [true, false], JSON.stringify(b.requests));
});

sceneTest('200 のまま {"error"} を返すエンジンは、空ではなく失敗として区間を残す', async (need) => {
  await need('err200');
  const r = results.err200;
  const segs = r.pages[0].segments;
  assert.strictEqual(segs.length, 2, `区間が黙って消えた: ${JSON.stringify(segs)}`);
  assert.ok(segs.every((s) => s.failed && /failed to read audio data/.test(s.text)), JSON.stringify(segs));
  // 失敗はヒントなしのやり直しの対象にしない（空のときだけ）
  assert.ok(!r.engineLog.some((l) => /^文字起こし:/.test(l)), JSON.stringify(r.engineLog));
});

// 区間の要求が、返事の前に接続ごと切れた（CI run 39183232615 の Windows で、err200 の 1 つ目の区間が「fetch failed」になった）。
// 失敗した区間は会議の後の送り直しでも文字起こしされるので、それが済むまで待って数える（mainrun の --after-retry）
const DROP_LOG = /^文字起こしの接続: エンジンとの接続が切れたため、同じ区間をもう一度送りました（(UND_ERR_SOCKET|ECONNRESET|EPIPE)・音声 3 秒）$/;

sceneTest('区間の要求の途中でエンジンとの接続が切れたら、同じ区間を 1 回だけ送り直して文字を残す', async (need) => {
  await need('dropFirst');
  const r = results.dropFirst;
  const a = r.afterRetry;
  assert.deepStrictEqual(r.pages[0].segments, [{ text: '本日の議題は進捗の確認です。区間2', failed: false }]);
  // 会議の後の送り直しに回さず、その場で取れた。切れた要求と同じ形（ヒント付き）でもう 1 回だけ送る
  assert.ok(!a.engineLog.some((l) => /復旧 s1/.test(l)), JSON.stringify(a.engineLog));
  assert.deepStrictEqual(a.requests.filter((l) => !/probe=true/.test(l)).map((l) => /prompt=true/.test(l)), [true, true], JSON.stringify(a.requests));
  assert.strictEqual(a.engineLog.filter((l) => DROP_LOG.test(l)).length, 1, JSON.stringify(a.engineLog));
  // ヒントなしのやり直しとは別。その記録の頭（文字起こし:）は使わない
  assert.ok(!a.engineLog.some((l) => /^文字起こし:/.test(l)), JSON.stringify(a.engineLog));
});

// あとの直し (c)（第1d回 A-14）: 手元の文字起こしの区間が失敗したら、engine.log に区間の番号と失敗の符号だけを1行書く
// （符号は英大文字と _ だけ。ほかは「なし」。文の本文・URL・ポートは書かない）。頭は「文字起こし:」「文字起こしの経路:」にしない
const LOCAL_FAIL_LOG = /^手元の文字起こしの失敗: /;

sceneTest('あとの直し (c): 手元の区間がつながらずに失敗したら、engine.log に「手元の文字起こしの失敗: s1（ECONNRESET）」の形の行（符号は英大文字と _ だけ）。文字起こしの文・ポートは無い', async (need) => {
  await need('dropAll', 'err200');
  const a = results.dropAll.afterRetry;
  const lines = a.engineLog.filter((l) => LOCAL_FAIL_LOG.test(l));
  // 会議の中の区間 s1 と、会議の後の送り直し（復旧 s1）がどちらも失敗する。区間が失敗するたびに1行ずつ（ほかの行は足さない）
  assert.strictEqual(lines.length, 2, explain(a));
  for (const l of lines) assert.match(l, /^手元の文字起こしの失敗: s1（(UND_ERR_SOCKET|ECONNRESET|EPIPE)）$/, explain(a));
  // どちらの失敗の行も、その区間の経路の行の後ろ（どの区間の失敗かが前後から読める）
  const at = (re) => a.engineLog.findIndex((l) => re.test(l));
  assert.ok(at(/^文字起こしの経路: 区間 s1 → local/) < a.engineLog.indexOf(lines[0]), explain(a));
  assert.ok(at(/^文字起こしの経路: 復旧 s1 → local/) < a.engineLog.lastIndexOf(lines[1]), explain(a));
  // 足した行で、engine.log の行を数える今の照らし（DROP_LOG・文字起こしの経路:・文字起こし:）の数は変わらない
  assert.strictEqual(a.engineLog.filter((l) => DROP_LOG.test(l)).length, 2, explain(a));
  assert.ok(!lines.some((l) => /^文字起こし(の経路)?:/.test(l)), explain(a));
  // 符号の無い失敗（200 のまま {"error"}）は「なし」。エンジンの文（failed to read audio data）は書かない
  const e = results.err200.engineLog.filter((l) => LOCAL_FAIL_LOG.test(l));
  assert.ok(['s1', 's2'].every((s) => e.includes(`手元の文字起こしの失敗: ${s}（なし）`)), explain(results.err200));
  assert.ok(e.every((l) => /^手元の文字起こしの失敗: s\d+（なし）$/.test(l)), explain(results.err200));
});

sceneTest('あとの直し (c): 区間が成功した場面には「手元の文字起こしの失敗」の行が無い（接続が1回切れて送り直しで取れた区間も）', async (need) => {
  await need('text', 'promptEmpty', 'mixed', 'dropFirst', 'kotoba');
  for (const k of ['text', 'promptEmpty', 'mixed', 'kotoba']) {
    assert.ok(!results[k].engineLog.some((l) => LOCAL_FAIL_LOG.test(l)), `${k}: ${explain(results[k])}`);
  }
  const a = results.dropFirst.afterRetry;
  assert.strictEqual(a.engineLog.filter((l) => DROP_LOG.test(l)).length, 1, explain(a));
  assert.ok(!a.engineLog.some((l) => LOCAL_FAIL_LOG.test(l)), explain(a));
});

test('あとの直し (c): 場面の照らしが落ちたら、失敗の文の後ろに、待った場面の engine.log と要求の全部が付く（文の頭はそのまま）', async () => {
  const body = withExplain(async (n) => { await n('dropFirst'); assert.strictEqual(1, 2, '照らしの文'); });
  await assert.rejects(body(), (e) => {
    assert.ok(e instanceof assert.AssertionError, String(e));
    assert.ok(e.message.startsWith('照らしの文'), e.message);
    const r = results.dropFirst;
    assert.ok(e.message.endsWith(`\ndropFirst: ${explain(r)}`), e.message);
    // explain は engine.log と要求の全部（会議の後の送り直しの写しも）
    assert.deepStrictEqual(JSON.parse(explain(r)), { engineLog: r.engineLog, requests: r.requests,
      afterRetry: { engineLog: r.afterRetry.engineLog, requests: r.afterRetry.requests } });
    assert.ok(r.engineLog.length > 0 && r.requests.length > 0, explain(r));
    return true;
  });
});

// 0.9.4 S-2・S-3（決めたこと 2・3・18）で意図して直した: 送り直しても切れた（エンジンに届かない: down）区間は「文字起こし待ち」（音声を残す）の文で、
// 会議の後の送り直しでも届かなければ音声と待ち行列を残して止める（前はどちらも「エンジンにつながりませんでした」の失敗で、送り直しの後に音声を消した）。
// 送る回数は今のまま
sceneTest('送り直しても接続が切れるなら 2 回で止め、区間は失敗として日本語の理由で残す（"fetch failed" を見せない）', async (need) => {
  await need('dropAll');
  const r = results.dropAll;
  const a = r.afterRetry;
  const kept = { text: '（文字起こし待ち: PC の文字起こしエンジンにつながらなかったので、後で文字起こしします）', failed: true };
  assert.deepStrictEqual(r.pages[0].segments, [kept]);
  // 会議の後の送り直し（復旧の道）も届かない: 区間はそのまま、音声と待ち行列を残して止める。どちらの道も 1 回 + 送り直し 1 回の 2 回ずつで、それより送らない
  assert.deepStrictEqual(a.segments, [kept]);
  assert.ok(a.engineLog.includes('復旧の文字起こしを止めました（理由: down）。残りの 1 区間の音声と待ち行列は残します'), JSON.stringify(a.engineLog));
  assert.ok(a.engineLog.some((l) => /^文字起こしの経路: 復旧 s1 → local/.test(l)), JSON.stringify(a.engineLog));
  assert.strictEqual(a.requests.filter((l) => !/probe=true/.test(l)).length, 4, JSON.stringify(a.requests));
  assert.strictEqual(a.engineLog.filter((l) => DROP_LOG.test(l)).length, 2, JSON.stringify(a.engineLog));
});

test('送り直すのは、返事の前に接続が切れたときだけ。拒まれた（エンジンが落ちている）・時間切れ・取り消し・HTTP の誤りは送り直さない', () => {
  const m = /^const droppedCode = (\(e\) => \{[\s\S]*?\n\});/m.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'));
  assert.ok(m, 'main.js に droppedCode が見つからない');
  const droppedCode = new Function(`return ${m[1]}`)();
  const failed = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
  assert.strictEqual(droppedCode(failed({ code: 'UND_ERR_SOCKET' })), 'UND_ERR_SOCKET');
  assert.strictEqual(droppedCode(failed({ code: 'ECONNRESET' })), 'ECONNRESET');
  assert.strictEqual(droppedCode(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), 'EPIPE');
  for (const e of [failed({ code: 'ECONNREFUSED' }), failed(undefined),
    Object.assign(new Error('timeout'), { name: 'TimeoutError', cause: { code: 'UND_ERR_SOCKET' } }),
    Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ECONNRESET' }),
    new Error('文字起こしエンジンエラー (500)'), null]) {
    assert.strictEqual(droppedCode(e), '', String(e && `${e.name} ${e.cause && e.cause.code}`));
  }
});

// あとの直し (c) の記録の符号の掃除（第1d回 A-14 の点検）: 場面では符号の形が崩れた失敗が起きないので、localFailCode を字面から取り出して動かす
test('あとの直し (c): 記録の符号は英大文字と _ の 2〜40 文字だけ。数の符号（DOMException の 23）・小文字・URL とポート・空白・長すぎ・無しは「なし」', () => {
  const m = /^const localFailCode = (\(e\) => \{[\s\S]*?\n\});/m.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'));
  assert.ok(m, 'main.js に localFailCode が見つからない');
  const localFailCode = new Function(`return ${m[1]}`)();
  const failed = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
  assert.strictEqual(localFailCode(failed({ code: 'ECONNREFUSED' })), 'ECONNREFUSED');
  assert.strictEqual(localFailCode({ cause: { code: 'ECONNREFUSED' } }), 'ECONNREFUSED');
  assert.strictEqual(localFailCode(Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' })), 'UND_ERR_SOCKET');
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.strictEqual(timeout.code, 23);
  for (const e of [timeout, { code: 23 }, { code: 'econnreset' }, { code: 'http://127.0.0.1:8990/x' }, { cause: { code: 'a b' } },
    { code: 'A'.repeat(41) }, { code: 'E' }, { code: '' }, failed(undefined), new Error('文字起こしエンジンエラー (500)'), null, undefined]) {
    assert.strictEqual(localFailCode(e), 'なし', JSON.stringify(e && (e.cause || e.code)));
  }
  assert.strictEqual(localFailCode({ code: 'A'.repeat(40) }), 'A'.repeat(40));
});

// あとの直し (c): 区間の番号（opts.seg）を渡すのは、議事録の区間・［もう一度］・復旧の3か所。音声入力は渡さない
// （［もう一度］と復旧の失敗の行は場面の照らしに出ないので、呼び出しの字面で見る）
test('あとの直し (c): transcribeAuto に区間の番号を渡すのは議事録の区間・［もう一度］・復旧の3か所で、音声入力は渡さない', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const body = (from) => {
    const i = src.indexOf(from);
    assert.ok(i >= 0, `${from} が無い`);
    const j = src.indexOf('\n}', i);
    return src.slice(i, j > 0 ? j : src.length);
  };
  // 本文の中の transcribeAuto( … ) の引数（かっこを数えて閉じまで）
  const callArgs = (b) => {
    const i = b.indexOf('transcribeAuto(');
    assert.ok(i >= 0, `transcribeAuto の呼び出しが無い: ${b.slice(0, 60)}`);
    let depth = 0;
    for (let k = i + 'transcribeAuto'.length; k < b.length; k++) {
      if (b[k] === '(') depth++;
      else if (b[k] === ')' && --depth === 0) return b.slice(i, k + 1);
    }
    assert.fail('transcribeAuto の呼び出しが閉じていない');
  };
  for (const [fn, seg] of [['function onMeetingSegment(', 'seg.id'], ['function retryFailedSegments(', 'seg.id'], ['async function transcribeRecoveredItems(', 'item.id']]) {
    const args = callArgs(body(fn));
    assert.ok(args.includes(`seg: ${seg} `) || args.includes(`seg: ${seg},`) || args.includes(`seg: ${seg}}`), `${fn}: ${args}`);
  }
  assert.ok(!/\bseg:/.test(callArgs(body('async function handleDictationAudio('))), '音声入力が区間の番号を渡している');
});

sceneTest('起動テストは /inference に正しい WAV の無音を実際に送り、返事の異常を見逃さない', async (need) => {
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
    probeDrop: /^文字起こしを試せませんでした: PC の文字起こしエンジンにつながりませんでした$/,   // 0.9.4 S-2 で意図して直した（決めたこと 18）
  };
  for (const [k, re] of Object.entries(cases)) {
    const t = results[k].test;
    assert.strictEqual(t.ok, false, `${k}: ${JSON.stringify(t)}`);
    assert.match(t.error, re, k);
    assert.ok(results[k].engineLog.includes(`起動テスト: ${t.error}`), `${k}: engine.log に残っていない`);
  }
});

sceneTest('記録や文字起こしの最中は、起動テストで試しの文字起こしをしない', async (need) => {
  await need('busy');
  const r = results.busy;
  assert.strictEqual(r.testDuring.ok, true, JSON.stringify(r.testDuring));
  assert.match(r.testDuring.info, /記録や文字起こしの最中のため、試しの文字起こしは省きました/);
  assert.ok(!r.requests.some((l) => /probe=true/.test(l)), JSON.stringify(r.requests));
  assert.strictEqual(r.pages[0].segments.length, 2);
});

sceneTest('モデルが kotoba-whisper なら認識ヒントを渡さず（1 回だけ送る）、設定で large-v3-turbo を勧める', async (need) => {
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

sceneTest('取り込みの状態の受け口（engine:fetch-status）は実際に動き、手の設定の側は manual。置き場所は一時フォルダの LOCALAPPDATA の下（第0b回 Task 13）', async (need) => {
  await need('text');
  const r = results.text;
  const s = r.engineFetchStatus;
  assert.ok(s && s.ok === true, JSON.stringify(s));
  // この場面の settings.json は文字起こしの手のパス（0.10.0 LS-3 で要約の組を外した）
  assert.deepStrictEqual(s.mode, { whisper: 'manual' });
  assert.deepStrictEqual([s.whisperReady, 'sumReady' in s], [false, false]);
  assert.strictEqual(r.engineStatus.whisper, '', '手の設定の文字起こしに取り込みの文を出した');
  const win64 = process.platform === 'win32' && process.arch === 'x64';
  assert.strictEqual(s.supported, win64);
  if (win64) {
    // 本当のプロファイルの natsu\engine を見ていない（mainrun が main.js を読む前に LOCALAPPDATA を替える）
    assert.match(s.root, /LocalAppData-取込𠮷\\natsu\\engine$/);
    // 0.10.0 LS-3（D59）で意図して直した: 文字起こしは手の設定なので、取り込むものは無い（ready）
    assert.strictEqual(s.state, 'ready');
  } else {
    // 取り込めない PC では今までどおり（手の設定だけ）
    assert.deepStrictEqual([s.root, s.state], [null, 'unsupported']);
  }
  assert.ok(!('sum' in r.engineStatus), 'engine:status に要約のエンジンの欄が残っている');
});

sceneTest('設計 B・RF3: 詳細設定が空なら、照らし終えた取り込んだ組で起動する。照らす前は起動せず「確かめています」。設定には書かない（第0b回 Task 13）', async (need) => {
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
  // 0.10.0 LS-3（D59）で意図して直した: 要約のエンジンの欄（sum）は無い
  assert.ok(!('sum' in r.engineStatus));
  // 0.10.0 LS-2（D59）で意図して変えた: 要約は Claude Code だけ（この場面は届かないので要約待ち。要約のエンジンの文は出さない）
  assert.strictEqual(r.pages[0].summaryError, '要約待ち（つながったら作ります）');
  // 取り込みの欄の写し
  const s = r.engineFetchStatus;
  assert.deepStrictEqual([s.supported, s.root, s.mode, s.using, s.whisperReady, 'sumReady' in s],
    [true, W, { whisper: 'managed' }, { whisper: 'current' }, true, false]);
  // RF7: 取り込んだパスを設定に書いていない
  for (const k of ['localServerExe', 'localModelPath', 'vadModelPath', 'sumServerExe', 'sumModelPath']) assert.ok(!r.savedSettings[k], `${k} を書いた: ${r.savedSettings[k]}`);
});

sceneTest('起動のときの照らしが済んだら、画面へ取り込みの欄の写しを送る（確かめ終えた・使える）。そのとき engine:status はもう「確かめています」でない（画面はそこで聞き直す。第0b回 Task 14・15）', async (need) => {
  await need('managed');
  const r = results.managed;
  // 起動のときの画面は「確かめています」を聞いて「要確認」にしている。照らしが済んだことを知らせないと、そのまま残る
  const p = r.seq.filter((x) => !x.notice);
  assert.ok(p.length >= 1, `照らしが済んでも進み具合を送らない: ${JSON.stringify(r.seq)}`);
  assert.deepStrictEqual([p[0].checking, p[0].w], [false, true], JSON.stringify(r.seq));
  assert.strictEqual(r.atReady.whisper, '');
});

sceneTest('RF3: 大きさと更新時刻が同じでも中身の違う DLL の組は使わない。起動せず、記録・起動テスト・engine.log に理由を出す（第0b回 Task 13）', async (need) => {
  await need('managedTamper');
  const r = results.managedTamper;
  assert.strictEqual(r.statusChecking.whisper, '文字起こしエンジンを確かめています（数秒で終わります）');
  const broken = /^文字起こしエンジンのファイルが消えたか変わっています。ウイルス対策が消した可能性があります（Windows セキュリティ → ウイルスと脅威の防止 → 保護の履歴）。/;
  assert.match(r.engineStatus.whisper, broken);
  assert.match(r.start.error, broken, '記録を始めた');
  assert.match(r.test.error, broken);
  assert.deepStrictEqual(r.spawns, [], '照らしで合わない組を起動した');
  assert.ok(r.engineLog.includes(`取り込んだエンジンの照らし: 合わない ${path.join(r.managedRoot, 'whisper-1.0.0', 'whisper.dll')}（changed）`), JSON.stringify(r.engineLog));
  // 取り込みの欄の写しも、照らしで合わなかった組を「使える」と見せない（画面が取り込みの欄を隠さない。統合）
  const s = r.engineFetchStatus;
  assert.deepStrictEqual([s.mode.whisper, s.using.whisper, s.whisperReady], ['managed', null, false]);
});

sceneTest('RF3: 壊れた組は、取り直されるか触られるまで、60 秒ごとの見回りで照らし直さず、同じ知らせを繰り返さない。同意が無ければ取らずに案内する（第0b回 Task 14）', async (need) => {
  await need('managedTamper');
  const r = results.managedTamper;
  const broken = '文字起こしエンジンのファイルが消えたか変わっていました。ウイルス対策が消した可能性があります（Windows セキュリティ → ウイルスと脅威の防止 → 保護の履歴）。設定タブの［PC の中の文字起こしを取り込む］から取り込み直してください。';
  // 起動のときの照らしの途中に見回りが来ても、照らしの結果を待つ（二重に照らさない・知らせを 2 回出さない）。
  // 画面の読み込みが照らしより遅くても、知らせは読み終えてから送る（読み込み中に送ると消える）
  assert.strictEqual(r.ticksDuringCheck, 1, '照らしの途中の見回りを呼べていない');
  assert.ok(!r.lostWhileLoading.includes(broken), '画面の読み込み中に知らせを送った（届かない）');
  assert.deepStrictEqual(r.noticesBeforeTicks, [broken]);
  assert.strictEqual(r.verifyCallsBeforeTicks, 1, '起動のときの照らしは 1 回');
  // 見回り（releaseIdleEngines）を 2 回: 照らし直さない・知らせない・起動しない
  assert.strictEqual(r.ticks, 1, 'releaseIdleEngines の見回りを拾えていない');
  assert.deepStrictEqual([r.verifyCallsAfterTicks, r.noticesAfterTicks, r.spawnsAfterTicks], [1, [broken], []]);
});

sceneTest('起動のときの復旧の文字起こしは、取り込んだ組を照らし終えたらもう一度試す（照らす前は「確かめています」で保留になる。第0b回 Task 13）', async (need) => {
  await need('managedRecover');
  const r = results.managedRecover;
  assert.ok(r.engineLog.includes('復旧の文字起こしを保留: 文字起こしエンジンを確かめています（数秒で終わります）'), JSON.stringify(r.engineLog));
  assert.deepStrictEqual(r.recovered, [{ text: '本日の議題は進捗の確認です。区間1', failed: false }], '照らし終えた後に復旧を試していない');
  assert.deepStrictEqual(r.spawns.map((x) => x.cmd), [path.join(r.managedRoot, 'whisper-1.0.0', 'whisper-server.exe')]);
});

sceneTest('RF4: 取り込んだ組は、Visual C++ ランタイムが無い PC では起動しない。engine:status・起動テスト・記録の開始・取り込みの欄に同じ案内（第0b回 Task 13）', async (need) => {
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

sceneTest('RF4: 担当にランタイムを入れてもらった後は、NaTsu を起動し直さなくても［起動テスト］で版を読み直し、取り込んだ組を起動する（統合）', async (need) => {
  await need('managedNoRuntime');
  const r = results.managedNoRuntime;
  const msg = vcRuntimeIssue({}, { whisper: true }).message;
  // ［起動テスト］を押すまでは、読んだ版を覚えたまま（engine:status のたびに DLL を読まない）
  assert.strictEqual(r.engineStatusBeforeRetest.whisper, msg);
  assert.deepStrictEqual([r.testAfterInstall.ok, r.testAfterInstall.error], [true, undefined], `起動し直さないと直らない: ${r.testAfterInstall.error}`);
  assert.strictEqual(r.engineStatusAfterInstall.whisper, '');
  assert.deepStrictEqual(r.spawnsAfterInstall.map((x) => x.cmd), [path.join(r.managedRoot, 'whisper-1.0.0', 'whisper-server.exe')]);
  assert.ok(r.engineLog.some((l) => /文字起こしエンジン: Visual C\+\+ ランタイム ok（.*vcomp140\.dll 14\.51\.36247\.0/.test(l)), JSON.stringify(r.engineLog));
});

sceneTest('RF3: 照らしが例外で終わっても「確かめています」のまま残さず、壊れた組として使わない（第0b回 Task 13）', async (need) => {
  await need('managedVerifyThrows');
  const r = results.managedVerifyThrows;
  assert.ok(r.engineLog.includes('取り込んだエンジンの照らしに失敗: 照らしの試験の失敗𠮷'), JSON.stringify(r.engineLog));
  const broken = /^文字起こしエンジンのファイルが消えたか変わっています。/;
  assert.match(r.engineStatus.whisper, broken);
  assert.match(r.start.error, broken);
  assert.deepStrictEqual(r.spawns, []);
  assert.deepStrictEqual([r.engineFetchStatus.using.whisper, r.engineFetchStatus.whisperReady], [null, false]);
});

// 「要約の組が壊れていたら…」は 0.10.0 LS-3（D59）で外した（要約の組を取り込まない）

// 第1d2回 M-1（D21）で意図して変えた: 何も取り込んでいない・ログインしていない PC は「準備を選んでいない」人。記録は始まり（音声を残す）、
// エンジンの誤り（「未設定」の語で設定のタブへ連れて行く文）でなくログインを案内する。engine:status の文・取り込みの欄の写し・spawns は今のまま
sceneTest('何も取り込んでいない・ログインしていない PC: 記録は始まって音声を残し、エンジンの誤りでなくログインを案内する（第1d2回 D21）', async (need) => {
  await need('noEngineFetchable', 'noEngineUnsupported');
  const f = results.noEngineFetchable;
  assert.strictEqual(f.start.ok, true, JSON.stringify(f.start));
  assert.strictEqual(f.engineStatus.whisper, '文字起こしエンジンはまだ取り込んでいません。設定タブの［PC の中の文字起こしを取り込む］を押してください');
  assert.deepStrictEqual([f.engineFetchStatus.supported, f.engineFetchStatus.state], [true, 'missing']);
  const u = results.noEngineUnsupported;
  assert.strictEqual(u.start.ok, true, JSON.stringify(u.start));
  assert.strictEqual(u.engineStatus.whisper, '文字起こしエンジンの実行ファイルまたはモデルが見つかりません');
  assert.deepStrictEqual([u.engineFetchStatus.supported, u.engineFetchStatus.state], [false, 'unsupported']);
  for (const r of [f, u]) {
    assert.deepStrictEqual(r.spawns, []);
    assert.ok(!JSON.stringify(r.notices).includes('未設定'), `「未設定」の語の知らせ（画面が設定のタブへ連れて行く）: ${JSON.stringify(r.notices)}`);
    // 第1d2回 M-2: 知らせは K2（［ログイン］のボタン付き。音声だけを残すこと・ログインすると OpenAI に送ること）
    assert.deepStrictEqual(r.notices, [{ text: 'ログインしていないため、音声だけを残します。設定の「アカウント」でログインすると、この会議の音声を OpenAI に送って文字起こしします。', action: 'signin' }]);   // 0.10.0 LS-5（D62）で意図して変えた
  }
});

sceneTest('［PC の中の文字起こしを取り込む］: net.request で取り込み、組がそろうたびに照らして切り替える。文字起こしが使えるようになったら知らせる。取り込み中は眠らせない（第0b回 Task 14。0.10.0 LS-3 で要約の組を外した）', async (need) => {
  await need('fetch');
  const r = results.fetch;
  const W = r.managedRoot;
  // 押す前: まだ取り込んでいない
  assert.strictEqual(r.statusBefore.whisper, '文字起こしエンジンはまだ取り込んでいません。設定タブの［PC の中の文字起こしを取り込む］を押してください');
  // 押すとすぐ返る（取り込みの終わりを待たない）。押したことが同意
  assert.deepStrictEqual([r.fetchStart.state, r.fetchStart.consent, r.fetchStart.userPaused], ['running', true, false]);
  // 取り込みの途中で記録を始めようとした: 「未設定」の語を残し、取り込み中であることを添える（速さはまだ分からない）
  assert.deepStrictEqual([r.startDuring.ok, r.startDuring.error], [false, '文字起こしエンジンが未設定です（取り込み中）。取り込みが済むと使えるようになります。']);
  // 3 つとも 127.0.0.1 の偽のサーバーから取った（MANIFEST の順。0.10.0 LS-3 で要約の組を外した）
  assert.deepStrictEqual([...new Set(r.hits)], ['whisper-engine', 'whisper-vad', 'whisper-model']);
  // 組がそろったら照らして切り替え、知らせる
  assert.deepStrictEqual(r.notices, ['文字起こしが使えるようになりました。'], JSON.stringify(r.engineLog));
  // 照らし終えた取り込んだ組で、文字起こしエンジンを 1 回だけ起動した（cwd = exe のフォルダ）
  assert.deepStrictEqual(r.spawns.map((x) => [x.cmd, x.cwd]), [[path.join(W, 'whisper-1.0.0', 'whisper-server.exe'), path.join(W, 'whisper-1.0.0')]]);
  assert.strictEqual(r.engineStatus.whisper, '');
  // 使っている組を installed.json の active に書いた（ピンを上げた後も、新しい組がそろうまでこの組を使い続ける: RF13）
  assert.deepStrictEqual(r.installed.active, r.manifestShas);
  assert.strictEqual(r.installed.consent, true);
  const s = r.engineFetchStatus;
  assert.deepStrictEqual([s.state, s.using, s.whisperReady], ['ready', { whisper: 'current' }, true]);
  // 進み具合が組を「使える」と言うのは、main が照らして切り替え、知らせた後だけ。そのとき engine:status はもう新しい
  //（画面はその知らせで聞き直す。係の記録だけを見て先に言うと、画面は「まだ取り込んでいません」を聞いて「要確認」のまま残る）
  assert.deepStrictEqual(readyBeforeNotice(r.seq, 'w', W_READY), [], JSON.stringify(r.seq));
  assert.deepStrictEqual(r.atReady, settled(r));
  // 進み具合の知らせ: 始めは起動のときの照らしが済んだ後の写し（まだ何も無い）、押すと running、最後は切り替えの後の写し（ready）
  assert.deepStrictEqual(r.progress.slice(0, 2), ['missing', 'running']);
  assert.strictEqual(r.progress[r.progress.length - 1], 'ready');
  assert.deepStrictEqual([r.lastProgress.using, r.lastProgress.root], [{ whisper: 'current' }, W]);
  // 取り込み中は眠らせない（省電力の抑止を始め、終わったら外す）
  const p0 = r.power.findIndex(([k]) => k === 'start');
  assert.ok(p0 >= 0 && r.power.slice(p0).some(([k, id]) => k === 'stop' && id === r.power[p0][2]), JSON.stringify(r.power));
  assert.strictEqual(r.power[r.power.length - 1][0], 'stop', JSON.stringify(r.power));
  // ボタンの一時停止は利用者の一時停止（次の起動で自動で続けない）。［取り込み先を開く］は置き場所を開く
  assert.strictEqual(r.pause.userPaused, true);
  assert.deepStrictEqual([r.openDir, r.opened], [true, [W]]);
  // RF7: 取り込んだパスを設定に書いていない
  for (const k of ['localServerExe', 'localModelPath', 'vadModelPath', 'sumServerExe', 'sumModelPath']) assert.ok(!r.savedSettings[k], `${k} を書いた: ${r.savedSettings[k]}`);
});

sceneTest('RF3: 起動のときの照らしで壊れていた組は、同意済みなら合わなかった項目だけを取り直し、照らし直してから使う（第0b回 Task 14）', async (need) => {
  await need('repair');
  const r = results.repair;
  const W = r.managedRoot;
  // 照らす前は使わない
  assert.strictEqual(r.statusChecking.whisper, '文字起こしエンジンを確かめています（数秒で終わります）');
  assert.strictEqual(r.spawnsBeforeVerify, 0);
  // 壊れていたことを知らせ、取り直す。取り直した組を照らし直してから使えるようにする（0.10.0 LS-3 で要約の組を外した）
  assert.deepStrictEqual(r.notices, [
    '文字起こしエンジンのファイルが消えたか変わっていました。ウイルス対策が消した可能性があります（Windows セキュリティ → ウイルスと脅威の防止 → 保護の履歴）。取り直しています。',
    '文字起こしが使えるようになりました。'], JSON.stringify(r.engineLog));
  // 文字起こしの組で取り直したのは、書き換えられた DLL の入った zip だけ（VAD とモデルは取らない）
  assert.deepStrictEqual([...new Set(r.hits)], ['whisper-engine']);
  assert.ok(r.engineLog.some((l) => l.startsWith('取り込み: whisper-engine のファイルが消えたか変わっています。1回だけ取り直します')), JSON.stringify(r.engineLog));
  // 取り直した組で 1 回だけ起動した
  assert.deepStrictEqual(r.spawns.map((x) => x.cmd), [path.join(W, 'whisper-1.0.0', 'whisper-server.exe')]);
  assert.strictEqual(r.engineStatus.whisper, '');
  assert.deepStrictEqual([r.engineFetchStatus.using.whisper, r.engineFetchStatus.whisperReady], ['current', true]);
  // 取り直している間、進み具合は壊れた組を「使える」と言わない（照らし直して切り替えた後だけ）
  assert.deepStrictEqual(readyBeforeNotice(r.seq, 'w', W_READY), [], JSON.stringify(r.seq));
  assert.deepStrictEqual(r.atReady, settled(r));
});

sceneTest('要約を手で設定していた PC（0.9.x の設定のキーが残る）で［PC の中の文字起こしを取り込む］: 文字起こしの組だけを取り、main が照らして切り替える前に進み具合で「使える」と言わない（第0b回 Task 14・15）', async (need) => {
  await need('fetchSum');
  const r = results.fetchSum;
  assert.deepStrictEqual([...new Set(r.hits)], ['whisper-engine', 'whisper-vad', 'whisper-model']);
  assert.deepStrictEqual(r.notices, ['文字起こしが使えるようになりました。'], JSON.stringify(r.engineLog));
  // 文字起こしの組が最後の組。係は組がそろったすぐ後に止まり、最後の写しを送る。そのときはまだ照らしている途中
  assert.deepStrictEqual(readyBeforeNotice(r.seq, 'w', W_READY), [], JSON.stringify(r.seq));
  assert.strictEqual(r.atReady.whisper, '');
  // 切り替えた後の写しが「使える」と言う（画面はこれでエンジンの状態を聞き直す）
  assert.strictEqual(r.seq.filter((x) => !x.notice).pop().w, true, JSON.stringify(r.seq));
  assert.strictEqual(r.engineStatus.whisper, '');
  const s = r.engineFetchStatus;
  assert.deepStrictEqual([s.mode, s.state, s.using.whisper, s.whisperReady], [{ whisper: 'managed' }, 'ready', 'current', true]);   // 0.10.0 LS-3 で要約の組を外した
});

sceneTest('RF3: 取り込んだ文字起こしエンジンが 0xC0000135 で落ち、照らし直して合わなければ、使うのをやめて知らせ、同意済みなら取り直してから使い直す（第0b回 Task 14）', async (need) => {
  await need('managedCrash');
  const r = results.managedCrash;
  const W = r.managedRoot;
  const exe = path.join(W, 'whisper-1.0.0', 'whisper-server.exe');
  assert.ok(r.engineLog.some((l) => l.startsWith('文字起こしエンジンが終了しました (code 3221225781)')), JSON.stringify(r.engineLog));
  assert.ok(r.engineLog.includes(`文字起こしエンジン: 落ちた後の照らし直し: 合わない ${path.join(W, 'whisper-1.0.0', 'whisper.dll')}（missing）`), JSON.stringify(r.engineLog));
  // 知らせたときには、もう使っていない（engine:status は壊れた組の文。画面はそこで聞き直す）
  assert.match(r.atBroken || '', /^文字起こしエンジンのファイルが消えたか変わっています。/);
  // 壊れた知らせは 1 回。取り直して照らし直し、切り替えて知らせる（0.10.0 LS-3 で要約の組を外した）
  assert.deepStrictEqual(r.notices, [
    '文字起こしエンジンのファイルが消えたか変わっていました。ウイルス対策が消した可能性があります（Windows セキュリティ → ウイルスと脅威の防止 → 保護の履歴）。取り直しています。',
    '文字起こしが使えるようになりました。'], JSON.stringify(r.engineLog));
  assert.ok(r.engineLog.includes('取り込んだエンジンの取り直しを頼みます: whisper-engine'), JSON.stringify(r.engineLog));
  assert.deepStrictEqual([...new Set(r.hits)], ['whisper-engine']);
  // 落ちた後の進み具合は「使えない」と言い、取り直して切り替えるまで「使える」と言わない
  const after = r.seq.slice(r.seq.findIndex((x) => x.notice && /消えたか変わっていました/.test(x.notice)));
  assert.ok(after.some((x) => !x.notice && x.w === false), JSON.stringify(r.seq));
  assert.deepStrictEqual(readyBeforeNotice(after, 'w', W_READY), [], JSON.stringify(r.seq));
  // 落ちた起動は 1 回。取り直した組で起動し直した
  assert.deepStrictEqual(r.spawns.map((x) => [x.cmd, Boolean(x.crash)]), [[exe, true], [exe, false]]);
  assert.strictEqual(r.engineStatus.whisper, '');
  assert.deepStrictEqual([r.engineFetchStatus.using.whisper, r.engineFetchStatus.whisperReady], ['current', true]);
});

sceneTest('RF3: 0xC0000135 で落ちても、照らし直して合えば組は使い続ける（知らせない・取り直さない。Visual C++ ランタイムの案内のまま。第0b回 Task 14）', async (need) => {
  await need('managedCrashOk');
  const r = results.managedCrashOk;
  const exe = path.join(r.managedRoot, 'whisper-1.0.0', 'whisper-server.exe');
  assert.ok(r.engineLog.some((l) => l.startsWith('文字起こしエンジンが終了しました (code 3221225781)')), JSON.stringify(r.engineLog));
  assert.ok(r.engineLog.includes('文字起こしエンジン: 落ちた後に取り込んだファイルを照らし直しました（合っています。Visual C++ ランタイムを確かめてください）'), JSON.stringify(r.engineLog));
  assert.deepStrictEqual(r.notices, []);
  assert.deepStrictEqual(r.hits, [], '合っているのに取り直した');
  assert.ok(!r.engineLog.some((l) => l.startsWith('取り込んだエンジンの取り直しを頼みます')), JSON.stringify(r.engineLog));
  assert.strictEqual(r.verifyCalls, 2, '起動のときと落ちた後の 2 回だけ照らす');
  assert.strictEqual(r.engineStatusAfterCrash.whisper, '');
  assert.deepStrictEqual([r.fetchStatusAfterCrash.using.whisper, r.fetchStatusAfterCrash.whisperReady], ['current', true]);
  // 組は使い続ける: ［起動テスト］で同じ取り込んだ exe を起動し直して通る
  assert.deepStrictEqual([r.testAfterCrash.ok, r.testAfterCrash.error], [true, undefined], JSON.stringify(r.testAfterCrash));
  assert.deepStrictEqual(r.spawns.map((x) => [x.cmd, Boolean(x.crash)]), [[exe, true], [exe, false]]);
});

sceneTest('雑音の 1 区間だけヒント付きで空になっても、ヒントは止めない（続けて起きたときだけ止める）', async (need) => {
  await need('noiseFirst');
  const r = results.noiseFirst;
  // 1 つ目（3 秒）はヒント付きで空 → ヒントなし。2・3 つ目はヒント付きのまま取れる
  assert.deepStrictEqual(prompted(r), [true, false, true, true], JSON.stringify(r.requests));
  assert.strictEqual(r.pages[0].segments.length, 3);
  assert.deepStrictEqual([r.promptInfo.off, r.promptInfo.offReason], [false, '']);
  assert.ok(!r.engineLog.some((l) => /認識ヒントを渡しません/.test(l)), JSON.stringify(r.engineLog));
});

sceneTest('返事を待つ間に議事録を破棄したら、ヒントなしのやり直しは送らない', async (need) => {
  await need('discard');
  const r = results.discard;
  assert.strictEqual(r.discard && r.discard.ok, true, JSON.stringify(r.discard));
  assert.deepStrictEqual(prompted(r), [true], JSON.stringify(r.requests));
  assert.ok(!r.engineLog.some((l) => /^文字起こし: 認識ヒント/.test(l)), JSON.stringify(r.engineLog));
  assert.strictEqual(r.pages.length, 0, '破棄した議事録が保存された');
});

sceneTest('ヒントを止めた後で辞書を変えたら、またヒントを渡す（設定画面の約束どおり）', async (need) => {
  await need('dict');
  const r = results.dict;
  assert.deepStrictEqual([r.promptInfo.off, r.promptInfo.offReason], [true, 'empty']);
  assert.strictEqual(r.saved && r.saved.ok, true, JSON.stringify(r.saved));
  assert.deepStrictEqual([r.promptInfoAfterDict.off, r.promptInfoAfterDict.offReason], [false, '']);
});

// ================= 要約（0.1.2）。偽の要約エンジン helpers/fake-llama.js を相手にする =================
sceneTest('要約が文字起こしに無い担当・期限を書いても、議事録には載せない（発言にある担当・期限は残す）', async (need) => {
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

sceneTest('要約の途中で会議タイプを手で選び直したら、その選択を残し、作り直しを勧める', async (need) => {
  await need('sumType', 'sumGround');
  const r = results.sumType;
  assert.strictEqual(r.setType && r.setType.meetingType, 'standup', JSON.stringify(r.setType));
  const p = r.pages[0];
  assert.strictEqual(p.todos.length > 0, true, '要約が保存されていない');
  // 0.1.1 までは、要約を始めたときの種類（自動）で上書きしていた
  assert.deepStrictEqual([p.meetingType, p.typeAuto], ['standup', false]);
  // 0.11.0 M-1（D43）で意図して変えた: 定例・進捗報告の名前を「朝会・内部定例会」に（key は standup のまま）
  // 0.11.0 M-4 で意図して変えた: どのメモの型で作ったかも書く
  // 0.11.0 Q-3 で意図して変えた: 短い文字起こしの要約には QN2 の注が付く（決めたこと 32）
  // 0.11.0 P-12（P12）で意図して変えた: 一般・その他は無い。決まらなかった会議の種類の名前は「自動」
  assert.strictEqual(p.summaryError, 'この要約は「自動」（メモの型: 会議の要点（論点整理））として作りました。途中で選んだ「朝会・内部定例会」で作り直すには［要約を再生成］を押してください。\n' + '文字起こしが短いため、打ち合わせの質の点は付けていません。');
  // 途中で何も選ばなければ、自動で決めた種類のまま（判定材料が無いので決まらない ''）で、種類の添え書きは無い
  // 0.11.0 Q-3 で意図して変えた: 短い文字起こしの要約には QN2 の注だけが付く（決めたこと 32）
  // 0.11.0 P-12（R5）で意図して変えた: 決まらない会議は 'general' でなく ''
  const q = results.sumGround.pages[0];
  assert.deepStrictEqual([q.meetingType, q.typeAuto, q.summaryError], ['', true, '文字起こしが短いため、打ち合わせの質の点は付けていません。']);
});
