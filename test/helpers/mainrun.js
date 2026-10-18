'use strict';
// main.js を偽の Electron の上で実際に動かし、記録 → 区間 → 文字起こし → 議事録の保存までを通す。
// 1 回の実行で 1 つの場面だけを試す（main.js はモジュールの中に状態を持つので、場面ごとに
// 別のプロセスにする）。結果は最後の行に JSON で出す。使い方:
//   node test/helpers/mainrun.js <FAKE_MODE> [--test] [--test-during] [--silent] [--vad] [--segs=N]
//     FAKE_MODE     … fake-whisper.js の答え方（text / empty / prompt-empty / mixed / err200 / probe500 など）
//     --test        … 記録の前に設定の［起動テスト］（app:test）を呼ぶ
//     --test-during … 最初の区間を送った直後（文字起こしの最中）に［起動テスト］を呼ぶ
//     --silent      … 区間の音声を無音にする（既定は 220Hz の音）
//     --vad         … VAD のモデル（偽物）をモデルの隣に置く（エンジンが --vad 付きで起動する）
//     --segs=N      … 送る区間の数（既定 2。1 つ目は 3 秒、2 つ目からは 2 秒）
//     --kotoba      … 偽のモデルの名前を kotoba-whisper のものにする（認識ヒントを渡さない場面）
//     --port=N      … 文字起こしエンジンのポート（並べて走らせるとき、呼ぶ側が重ならないように決めて渡す）
//     --discard-during … 最初の区間を送った直後に議事録を破棄する（返事を待つ間の破棄）
//     --after-dict  … 記録の後で辞書を保存し、認識ヒントの状態を聞き直す
//     --sum         … 要約エンジン（helpers/fake-llama.js）も置く。要約は文字起こしに無い担当・期限を混ぜて返す
//     --sum-port=N  … 要約エンジンのポート（--port と同じく、呼ぶ側が重ならないように渡す）
//     --set-type-during=T … 要約の途中で会議タイプを T に手で選び直す（要約は 1.5 秒かかる）
//     --text=…      … 偽の文字起こしエンジンが返す文（既定は「本日の議題は進捗の確認です。区間N」）
//     --managed     … 詳細設定を空にし、取り込んだ組で文字起こしする（第0b回 設計 B）。engine-small の小さな組を本物の
//                     installZip・recordInstalled で %LOCALAPPDATA%（一時フォルダ）の natsu\engine に置き、main からは
//                     engineRoot（取り込める PC か）と MANIFEST だけを差し替える。取り込んだ exe の代わりに偽の whisper を起動する
//     --managed-tamper … --managed と同じ組の whisper.dll を、大きさを変えずに書き換える（照らしで合わず、起動しない。RF3）
//     --recover     … 前回落ちた会議の下書き（文字起こし待ちの区間 1 つと、その音声）を置いて起動し、復旧の文字起こしを待って終える
//                     （記録はしない。--managed と組み合わせると、照らし終えた後に復旧が動くかを見る）
//     --no-vc-runtime … --managed と組み合わせる。Visual C++ ランタイムが無い PC にする（RF4）。whenReady の後で System32 を
//                     空のフォルダに向け、Windows の外では process.platform を win32 と読ませる（main.js の engineRuntimeIssue は
//                     Windows でだけ DLL を読む）。記録はせず、engine:status・起動テスト・記録の開始の答えを見る。
//                     その後で System32 に 14.51 の DLL を置き（担当がランタイムを入れた）、起動し直さずに起動テストをもう一度押す
//     --verify-throws … --managed と組み合わせる。照らし（verifyCandidates）が例外を投げる。記録はしない
//     --repair      … --managed-tamper と組み合わせる。installed.json を同意済みにし、engine-small の偽のサーバーを開いたままにして、
//                     起動のときの照らしで壊れていた組を main が取り直し（fake-net の net.request で）、照らし直してから使うのを見る（Task 14）
//     --sum-tamper  … --managed と組み合わせる。要約の組も置き、その llama.dll を大きさを変えずに書き換える（要約の組は壊れている）
//     --no-engine=fetchable|unsupported … 詳細設定の文字起こしを空にし、何も取り込んでいない PC にする。fetchable は取り込める PC、
//                     unsupported は取り込めない PC（engineRoot だけを差し替える）。記録はしない
//     --fetch       … 何も取り込んでいない取り込める PC で、設定の［エンジンを取り込む］（engine:fetch-start）を押す（第0b回 Task 14）。
//                     engine-small の小さな組を 127.0.0.1 の偽のサーバーから、Electron の net.request の偽物（fake-net）で取り込み、
//                     組がそろうたびに main が照らして切り替えるのを見る（文字起こしのモデルだけ、大きさの床 50MB を超える本物の中身）。
//                     main からは engineRoot・MANIFEST と、係の http の許し（requireHttps: false）・空きの測り方だけを差し替える
//     --crash       … --managed と組み合わせる。照らし終えた組で起動した文字起こしエンジンが、ウイルス対策に DLL を消されて
//                     0xC0000135（3221225781）で落ちる（Linux のプロセスはこの番号で終われないので、最初の起動だけ 'exit' を
//                     その番号で出す偽の子にし、その前に whisper.dll を消す）。同意済みで偽のサーバーを開いたままにし、
//                     main が照らし直して使うのをやめ、取り直してから使い直すのを見る（第0b回 Task 14・RF3）
//     --crash-ok    … --crash と同じ落ち方だが、ファイルはそのまま（照らし直して合う: ランタイムの案内のまま、組は使い続ける）
//     --slow-load   … 画面の読み込みを、起動のときの照らしが済むまで終えない（読み込み中に送った知らせは画面に届かない。
//                     main は読み終えてから送る: noticeMainWin）
//     --json-scene=名前 … 第1a回の保存の守りの場面（helpers/json-scenes.js）。readyResolve() の直後に分かれ、場面が済んだら出力して終える。
//                     - 場面の files（userData からの相対パス → 中身。関数なら { base, userData } を受け取る。
//                       base = { localServerExe, localModelPath, localPort, sumPort }）を、ふだんの settings.json の代わりに置く。
//                       prepare(userData) があれば置いた後に呼ぶ。env があれば main.js を読む前に process.env に入れる。
//                     - engine が無い場面は --no-engine=unsupported と同じ（取り込めない PC。エンジンは起こさない: 手のパスがあっても
//                       偽の子を返すだけ）。engine が真なら、手で設定した偽の whisper を本当に起こし、起動を待つ。
//                     - 部品の待ち（jsonfile の sleepSync）を何もしない関数にする（読み直しの約1秒・名前の変更のやり直しの約0.5秒を、
//                       場面ごとに待たない。待ちの長さは jsonfile.test.js が見る）。
//                     - faults（helpers/faulty-fs.js の rules）があれば、src/ の中のファイルが読む fs にだけ faultyFs(faults) を渡す。
//                     - setTimeout に渡された retrySettingsRead・retryHistoryRead・retryDraftRecovery は走らせずに timers[名前] に入れる。
//                     - 画面の読み込みは --slow-load と同じで、窓が2つ（録音バー・本体）できた後に読み終える（起動の知らせは
//                       did-finish-load で送られる）。
//                     - act(ctx) を呼ぶ。ctx = { handlers, listeners, app, wins, power, timers, clearedTimers, shortcuts, store, jsonfile, electron, userData,
//                       read(rel), waitFor(cond, ms), sleep, toneWav(sec), out, launches, launchPlan }。app・窓・power（powerMonitor）は on／once で受け口を覚え、
//                       emit(ev, …) で呼べる。窓は setPosition の値を getPosition で返し、作ったときに app の browser-window-created を
//                       出す。wins は作った順（createOverlay が先、createMainWindow が後）。read(rel) は無ければ null、あればバイト。
//                     - 出力（最後の行の JSON）: scene・notices（app:notice の文）・files（userData の下のファイルの相対パス。区切りは /。
//                       engine.log と segbuf の WAV も含む）・settingsText・historyText（無ければ null）・engineLog（時刻を落とした行）・
//                       spawns・themeSource・windows（作った窓の数）と、act が out に入れたもの（同じ名前なら act のもの）。
//                     - 第1b回 Task A-2: 場面の local（%LOCALAPPDATA%＝一時フォルダからの相対パス → 中身）を main.js を読む前に置き、
//                       displays（無ければ 1920×1080 が1つ）を偽の screen が返す。ctx に mainWin（本体の窓 = wins[1]）・
//                       readLocal(rel)・localAppData を足す。本体の窓は act が normal（getNormalBounds の値）・bounds（getBounds の値）・
//                       minimized を入れられ、webContents は on／once／emit で受け口を呼べる。出力に windowOpts（本体の窓を作ったときの
//                       x・y・width・height・minWidth・minHeight・backgroundColor）・maximizeCalls・zooms（setZoomFactor の値の順）・
//                       winStateText（<LOCALAPPDATA>/natsu/window-state.json の中身。無ければ null）・localFiles（区切りは /）を足す。
//                     - 第1b回 Task A-3: 録音バーの窓（wins[0]）の executeJavaScript は、main.js の PAUSE_ENSURE_ON・PAUSE_ENSURE_OFF と
//                       同じ文だけを受けて偽の録音バーで本物と同じに動く（場面の overlayPause: 'lost-once'・'late'）。ctx に releasePause()、
//                       出力に overlayJs（流された文の 'on'／'off' の順）・overlayPaused（偽の録音バーの状態）・balloons を足す。
//     --stt=<mode>  … 第1c回 A-4: オンラインの文字起こし。127.0.0.1 の偽の送り先（helpers/fake-stt.js）を mode の答え方で開き、
//                     secrets.json に偽の鍵（偽の safeStorage の暗号）を置き、設定を cloudTranscribe: 'on'・sttProvider: 'custom'・
//                     sttBaseUrl: 偽の送り先・sttModel: 'whisper-large-v3' にする。mode が cert のときは、偽の送り先への要求に
//                     net::ERR_CERT_AUTHORITY_INVALID を返す（makeFakeRequest の before。fake-stt の答え方は text）
//     --consent=ask|off … cloudTranscribe をその値にする（--stt と組む）
//     --no-key      … secrets.json を置かない
//     --key-unreadable … 偽の safeStorage の decryptStringAsync が投げる（鍵のファイルはあるが復号できない）
//     --offline     … net.isOnline() が false
//     --local-only  … 記録を始めた後、最初の区間の前に［この会議は PC の中だけ］を押す（画面と同じ IPC の meeting:set-local-only。
//                     out.localOnly にその返事、out.statusLocalOnly に押した後の meeting:status の localOnly と cloud）。
//                     --recover と組むと、置く下書きに localOnly: true を書く
//     （議事録の場面では、記録を始めた直後の meeting:status の cloud をいつも out.statusCloud に入れる）
//     --dictate     … 議事録の代わりに音声入力を1回（ホットキー → audio:done）。out.history に履歴
//     --no-whisper  … 設定の whisper の実行ファイルを無いファイルにする
//     --claude=<mode> … 第1c回 B-3: オンラインの要約。設定の claudeExe を偽の claude（helpers/fake-claude.js）に向け、FAKE_CLAUDE_MODE に
//                     mode を、FAKE_CLAUDE_LOG に記録のファイルを置く（spawn は偽の whisper と同じく node で台本を起こす）。
//                     mode が missing か、--claude が無ければ claudeExe を無いファイルに向ける（Claude Code が入っていない PC。PATH を探さない）。--stt と組むと、Anthropic へ
//                     届くかの確かめが偽の送り先に届いてオンラインになる（--stt が無ければ、確かめは fake-net の守りで死んで手元になる）
//     --claude-auth=<method> … 偽の claude の auth status が返す authMethod（FAKE_CLAUDE_AUTH。既定 claude.ai）
//   main を読む前に、いつも process.env に ANTHROPIC_API_KEY と CLAUDE_CODE_OAUTH_TOKEN を置く（課金の変数が子に渡らないことを見る。RF25）。
//   出力に足すもの: claude（偽の claude の記録。無ければ []）・pages[].route・pages[].blocks（型と cites の数だけ）・pages[].citeStat
//   偽の Electron の net.request は、https://api.anthropic.com/ を偽の送り先の /anthropic へ書き換える（--stt と --claude を両方
//   付けたときだけ。--claude の無い場面は、要約の経路の確かめが fake-net の守りで死んで今どおり手元の llama になる。ほかの外の宛先は
//   書き換えず fake-net が死ぬ: 試験が外へ出たら赤）。Tray の displayBalloon は out.balloons に残す。
//   --stt のときの出力に足すもの: stt（偽の送り先の要求の一覧）・pages[].route・balloons・secretsRaw（secrets.json の中身）・
//   recoveryKept（segbuf の下に recovery.json と WAV が残っているか）・decrypts（偽の safeStorage で鍵を復号した回数）。--recover と組むと、復旧が済むか止まるのを待って同じ形で出す
// 画面へ送った知らせと進み具合は、送った順に out.seq へ残す。進み具合が初めて「使える」（whisperReady・sumReady）と
// 言ったときの engine:status を out.atReady に、壊れた知らせを送ったときの engine:status を out.atBroken に残す
// （画面はその知らせでエンジンの状態を聞き直すので、そのとき main の答えがもう新しいこと: 第0b回 Task 14・15）
// 本物のエンジンで試すときは NATSU_E2E_EXE・NATSU_E2E_MODEL・NATSU_E2E_WAVS（; 区切り）を渡す。
// 終わるときは、起動したエンジンを止め、一時フォルダを消す（npm test のたびに残さない）。

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const FAKE = path.join(__dirname, 'fake-whisper.js');
const mode = process.argv[2] || 'text';
const flags = process.argv.slice(3);
const runTest = flags.includes('--test');
const testDuring = flags.includes('--test-during');
const silent = flags.includes('--silent');
const withVad = flags.includes('--vad');
const kotoba = flags.includes('--kotoba');
const fixedPort = Number((flags.find((f) => f.startsWith('--port=')) || '--port=0').slice(7)) || 0;
const discardDuring = flags.includes('--discard-during');
const afterDict = flags.includes('--after-dict');
const withSum = flags.includes('--sum');
const fixedSumPort = Number((flags.find((f) => f.startsWith('--sum-port=')) || '--sum-port=0').slice(11)) || 0;
const setTypeDuring = (flags.find((f) => f.startsWith('--set-type-during=')) || '').slice(18);
const fakeText = (flags.find((f) => f.startsWith('--text=')) || '').slice(7);
const FAKE_SUM = path.join(__dirname, 'fake-llama.js');
const segCount = Number((flags.find((f) => f.startsWith('--segs=')) || '--segs=2').slice(7)) || 2;
const managedMode = flags.includes('--managed') ? 'ok' : (flags.includes('--managed-tamper') ? 'tamper' : '');
const recoverMode = flags.includes('--recover');
const noVcRuntime = flags.includes('--no-vc-runtime');
const verifyThrows = flags.includes('--verify-throws');
const sumTamper = flags.includes('--sum-tamper');
const noEngine = (flags.find((f) => f.startsWith('--no-engine=')) || '').slice(12);
const fetchMode = flags.includes('--fetch');
const repairMode = flags.includes('--repair');
const crashMode = flags.includes('--crash') ? 'broken' : (flags.includes('--crash-ok') ? 'ok' : '');
const slowLoad = flags.includes('--slow-load');
// 第1c回 A-4: オンラインの文字起こしの場面
const sttMode = (flags.find((f) => f.startsWith('--stt=')) || '').slice(6);
const consentFlag = (flags.find((f) => f.startsWith('--consent=')) || '').slice(10);
const noKey = flags.includes('--no-key');
const keyUnreadable = flags.includes('--key-unreadable');
const offline = flags.includes('--offline');
const localOnlyFlag = flags.includes('--local-only');
const dictate = flags.includes('--dictate');
const noWhisper = flags.includes('--no-whisper');
// 第1c回 B-3: オンラインの要約の場面（偽の claude）
const claudeMode = (flags.find((f) => f.startsWith('--claude=')) || '').slice(9);
const claudeAuth = (flags.find((f) => f.startsWith('--claude-auth=')) || '').slice(14);
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const STT_KEY = 'gsk_test_0123456789';   // stage1c.main.test.js の KEY と同じ（どこにも漏れていないかを試験が探す）
const sceneName = (flags.find((f) => f.startsWith('--json-scene=')) || '').slice(13);
const scene = sceneName ? require('./json-scenes')[sceneName] : null;
if (sceneName && (!scene || typeof scene !== 'object')) { process.stderr.write(`mainrun: 場面 ${sceneName} が json-scenes.js に無い\n`); process.exit(1); }
const SCENE_TIMERS = new Set(['retrySettingsRead', 'retryHistoryRead', 'retryDraftRecovery']);
const serveSet = repairMode || Boolean(crashMode);   // engine-small の偽のサーバーを開いたままにし、同意済みにする
const REAL_PLATFORM = process.platform;
// --no-vc-runtime が main の中だけ空のフォルダに向ける環境の変数の、元の値。エンジン（子のプロセス）には元の値を渡す
// （本物のエンジンは本物の Windows の中で動く。Windows の node は SystemRoot が違うと Winsock を始められず code 134 で落ちる）
const REAL_WINENV = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
const childEnv = (env) => {
  const out = { ...(env || process.env) };
  for (const [k, v] of Object.entries(REAL_WINENV)) {
    for (const key of Object.keys(out)) if (key.toLowerCase() === k.toLowerCase()) delete out[key];   // Windows は大文字と小文字を区別しない
    if (v !== undefined) out[k] = v;
  }
  return out;
};
// 偽の claude は process.execPath で起こす。claude-cli は子の環境から ELECTRON_RUN_AS_NODE を外す（本物の claude に
// 渡さないため）ので、Electron の Node でテストを回すとき（ci.yml の electron-smoke）は戻す。戻さないと electron.exe が
// 偽の claude を Electron のアプリとして起こし、Windows では標準入力が届かない（D2 の stdinHasTranscript が false になる）
const fakeClaudeEnv = (env) => (process.versions.electron ? { ...childEnv(env), ELECTRON_RUN_AS_NODE: '1' } : childEnv(env));

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 場面が「終わった」と言える条件を待つ上限。条件が揃えばすぐ進むので、通る場面は速いまま。上限は、負荷のある遅い機械
// （Windows の CI で、他の場面・他のテストのファイルと CPU を取り合う）でも届く長さにする。固定の短い上限（4 秒）では、
// 51MB の偽のモデルの取り込みと照らしが間に合わず、場面が途中の写しを返していた（文字起こしの組までしか取れていない）
const WAIT_MS = Number(process.env.NATSU_E2E_WAIT_MS || 60000);
const waitFor = async (cond, ms = WAIT_MS) => {
  const until = Date.now() + ms;
  while (Date.now() < until && !cond()) await sleep(20);
  return cond();
};
// on／once で受け口を覚え、emit(ev, …) で呼べる小さな受け手（偽の app・窓・powerMonitor）
function makeEmitter(target = {}) {
  const ls = {};
  const add = (ev, cb, once) => { (ls[ev] || (ls[ev] = [])).push({ cb, once }); return target; };
  target.on = (ev, cb) => add(ev, cb, false);
  target.once = (ev, cb) => add(ev, cb, true);
  target.removeListener = (ev, cb) => { ls[ev] = (ls[ev] || []).filter((x) => x.cb !== cb); return target; };
  target.off = target.removeListener;
  target.emit = (ev, ...a) => {
    const l = ls[ev] || [];
    ls[ev] = l.filter((x) => !x.once);
    for (const x of l) x.cb(...a);
    return l.length > 0;
  };
  target.listenerCount = (ev) => (ls[ev] || []).length;
  return target;
}

// 版（VS_FIXEDFILEINFO）だけを持つ DLL の偽物（main.js の vcRuntimeVersions が読む印 0xFEEF04BD と、その後の版）
function peWithVersion(a, b, c, d) {
  const x = Buffer.alloc(4096);
  x.writeUInt32LE(0xFEEF04BD, 1000); x.writeUInt32LE(0x00010000, 1004);
  x.writeUInt32LE(((a << 16) | b) >>> 0, 1008); x.writeUInt32LE(((c << 16) | d) >>> 0, 1012);
  return x;
}

// 220Hz の正弦波の WAV（16kHz・モノラル・16bit。amp=0 で無音）。区間になるには 4000 バイト以上が要る
function toneWav(sec, amp = 8000) {
  const n = 16000 * sec;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * 220 * i / 16000)), 44 + i * 2);
  return b;
}

// 何を聞かれても、それらしい値か自分自身を返す（使わない Electron の API を丸ごと受け流す）
function anyProxy() {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, k) {
      if (k === 'then') return undefined;
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'isDestroyed' || k === 'isVisible') return () => false;
      return anyProxy();
    },
    apply() { return anyProxy(); },
    construct() { return anyProxy(); },
  });
}
const withFallback = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : anyProxy()) });

// 終わり方: 起動したエンジンを止め、一時フォルダを消す。process.exit の前に必ず通る
const kids = [];
let tmp = '';
process.on('exit', () => {
  for (const k of kids) { try { k.kill(); } catch (_) { /* noop */ } }
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* 消せなくても結果は出す */ } }
});

(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-e2e-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const engDir = path.join(tmp, 'engine');
  fs.mkdirSync(engDir);
  // 偽の文字起こしの送り先（--stt）。終わるときに閉じなくても、process.exit で消える
  const fakeStt = sttMode ? await require('./fake-stt').startFakeStt({ mode: sttMode === 'cert' ? 'text' : sttMode, key: STT_KEY }) : null;
  const fakeEnc = (s) => Buffer.from(`ENC1:${Buffer.from(s, 'utf8').toString('hex')}`);
  if (fakeStt && !noKey) {
    fs.writeFileSync(path.join(userData, 'secrets.json'), JSON.stringify({ schema: 1, keys: { custom: fakeEnc(STT_KEY).toString('base64') } }));
  }
  // 偽のモデル。中身は見られず、大きさの床（50MB）だけを超えればよい。残りは疎にして場所を取らない。
  // 先頭だけは実際に書く（全部が疎だと blocks が 0 になり、OneDrive のプレースホルダと見なされる）
  let model = process.env.NATSU_E2E_MODEL;
  if (!model) {
    model = path.join(engDir, kotoba ? 'ggml-kotoba-whisper-v2.0-q5_0.bin' : 'ggml-fake.bin');
    const fd = fs.openSync(model, 'w');
    fs.writeSync(fd, Buffer.alloc(8192, 1));
    fs.ftruncateSync(fd, 51 * 1024 * 1024);
    fs.closeSync(fd);
  }
  if (withVad) fs.writeFileSync(path.join(path.dirname(model), 'ggml-silero-v6.2.0.bin'), Buffer.alloc(1024, 1));
  const exe = process.env.NATSU_E2E_EXE || FAKE;
  // 偽の claude（--claude）。記録は1行ずつの JSON
  const claudeLog = path.join(tmp, 'claude.log');
  // --claude が無い場面（と missing）は無いファイルに向ける。PATH の上の本物の claude を探さないため（計画の決まり）。
  // 経路が誤って Claude Code へ行っても、時間切れで待たずに「見つからない」ですぐ赤になる
  const claudeExe = claudeMode && claudeMode !== 'missing' ? FAKE_CLAUDE : path.join(tmp, 'no-such-claude.exe');
  if (claudeMode) {
    process.env.FAKE_CLAUDE_MODE = claudeMode;
    process.env.FAKE_CLAUDE_LOG = claudeLog;
    process.env.FAKE_CLAUDE_EXPECT = fakeText || '本日の議題は進捗の確認です';
    // 手元の1回の要約と同じ指示文（mainlib.buildClaudeInput。F9）を標準入力で受けたか
    process.env.FAKE_CLAUDE_EXPECT_ASK = '上記から、次の構成のMarkdown議事録を作成してください。';
    if (claudeAuth) process.env.FAKE_CLAUDE_AUTH = claudeAuth;
  }
  // 課金の変数（子に渡らないことを偽の claude の記録の envKeys で見る。大小の混ざった名前は claude-cli.test.js が見る）
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'o';
  const flog = path.join(tmp, 'fake.log');
  fs.writeFileSync(flog, '');
  process.env.FAKE_MODE = mode;
  process.env.FAKE_LOG = flog;
  const localPort = fixedPort || await freePort();
  const sumPort = fixedSumPort || await freePort();
  if (fakeText) process.env.FAKE_TEXT = fakeText;
  // 偽の要約モデル。大きさの床（300MB）だけを超えればよい（残りは疎）
  let sumModel = '';
  if (withSum) {
    sumModel = path.join(engDir, 'fake-sum.gguf');
    const fd = fs.openSync(sumModel, 'w');
    fs.writeSync(fd, Buffer.alloc(8192, 1));
    fs.ftruncateSync(fd, 301 * 1024 * 1024);
    fs.closeSync(fd);
    if (setTypeDuring) process.env.FAKE_SUM_DELAY = '1500';
  }
  // 取り込んだ組（--managed）。置き場所は main と同じ LOCALAPPDATA の下（日本語と 𠮷 の名前。RF1）
  const localAppData = path.join(tmp, 'LocalAppData-取込𠮷');
  let managedExe = '';
  let managedRoot = '';
  let managedMods = null;
  let fetchSet = null;   // 開いたままの engine-small の偽のサーバー（--fetch・--repair）
  let verifyCalls = 0;   // 取り込んだ組の照らし（verifyCandidates）の回数
  if (managedMode) {
    const I = require(path.join(ROOT, 'src', 'engine-install.js'));
    const realManifest = require(path.join(ROOT, 'src', 'engine-manifest.js'));
    const { smallSet } = require('./engine-small');
    const set = await smallSet();
    if (serveSet) fetchSet = set;   // 取り直しを見る: 偽のサーバーは終わるまで開いておく
    else await set.close();   // 通信はしない（中身だけ使う）
    // 文字起こしのモデルは大きさの床（50MB）を超える疎のファイル（モデルは大きさと更新時刻で照らすので中身は見ない）。
    // VAD は本物の名前にして、モデルの隣の自動の発見（resolveVadModel）が取り込んだ models の中で効くかを見る
    const items = set.manifest.items.map((it) => {
      if (it.id === 'whisper-model') return { ...it, size: 51 * 1024 * 1024 };
      if (it.id === 'whisper-vad') return { ...it, dest: 'models/ggml-silero-v6.2.0.bin' };
      return it;
    });
    managedRoot = path.join(localAppData, 'natsu', 'engine');
    const home = { supported: true, root: managedRoot, reason: '' };
    // 要約の組は取り込んでいない（--sum-tamper のときだけ置く）
    for (const it of items.filter((i) => i.group === 'whisper' || (sumTamper && i.group === 'sum'))) {
      if (it.kind === 'zip') {
        const zip = path.join(tmp, `${it.id}.zip`);
        fs.writeFileSync(zip, set.bodies[it.id]);
        I.recordInstalled(home, it, await I.installZip(it, zip, managedRoot));
        continue;
      }
      const out = path.join(managedRoot, ...it.dest.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      if (it.id === 'whisper-model') {
        const fd = fs.openSync(out, 'w');
        fs.writeSync(fd, Buffer.alloc(8192, 1));
        fs.ftruncateSync(fd, it.size);
        fs.closeSync(fd);
      } else {
        fs.writeFileSync(out, set.bodies[it.id]);
      }
      I.recordInstalled(home, it, { file: out });
    }
    managedExe = path.join(managedRoot, 'whisper-1.0.0', 'whisper-server.exe');
    const tamper = (dir, name) => {
      const dll = path.join(managedRoot, dir, name);
      fs.writeFileSync(dll, Buffer.alloc(fs.statSync(dll).size, 7));   // 大きさは同じ・中身だけ違う
      // 記録の更新時刻も今のファイルに合わせる（大きさと更新時刻では見分けられない。SHA-256 の照らしだけが見つける）
      const instFile = path.join(managedRoot, 'installed.json');
      const inst = I.readInstalled(instFile);
      for (const rec of Object.values(inst.items)) {
        for (const f of rec.files || []) if (f.name === name) f.mtimeMs = fs.statSync(dll).mtimeMs;
      }
      I.writeInstalled(instFile, inst);
    };
    if (managedMode === 'tamper') tamper('whisper-1.0.0', 'whisper.dll');
    if (serveSet) {
      // 利用者は前に［エンジンを取り込む］を押している（同意済み）
      const instFile = path.join(managedRoot, 'installed.json');
      I.writeInstalled(instFile, { ...I.readInstalled(instFile), consent: true });
    }
    if (sumTamper) tamper('llama-b1', 'llama.dll');
    managedMods = {
      install: { ...I, engineRoot: () => home,
        verifyCandidates: verifyThrows ? async () => { verifyCalls += 1; throw new Error('照らしの試験の失敗𠮷'); }
          : async (...a) => { verifyCalls += 1; return I.verifyCandidates(...a); },
        ...(serveSet ? { makeRunner: (deps) => I.makeRunner({ ...deps, fetchOpts: { requireHttps: false }, statfs: async () => ({ bavail: 1e6, bsize: 1e6 }) }) } : {}) },
      manifest: { ...realManifest, MANIFEST: Object.freeze({ schema: 1, items }) },
    };
  }
  // 何も取り込んでいない PC（取り込める・取り込めない）。置き場所だけを決め、フォルダは作らない
  if (noEngine || (scene && !scene.engine)) {
    const I = require(path.join(ROOT, 'src', 'engine-install.js'));
    const home = noEngine === 'fetchable' ? { supported: true, root: path.join(localAppData, 'natsu', 'engine'), reason: '' }
      : I.engineRoot({}, 'linux', 'x64');
    managedMods = { install: { ...I, engineRoot: () => home }, manifest: require(path.join(ROOT, 'src', 'engine-manifest.js')) };
  }
  // 取り込みを押す PC（--fetch）。置き場所だけを決め、フォルダは作らない（作るのは main の取り込みの係）。
  // 偽のサーバーは終わるまで開いておく
  let fetchManifest = null;
  if (fetchMode) {
    const I = require(path.join(ROOT, 'src', 'engine-install.js'));
    const realManifest = require(path.join(ROOT, 'src', 'engine-manifest.js'));
    const { smallSet } = require('./engine-small');
    fetchSet = await smallSet();
    // 文字起こしのモデルは大きさの床（50MB）を超える中身にする（取り込んだ後の engineCheck を通り、エンジンが起動する）
    const big = Buffer.alloc(51 * 1024 * 1024, 1);
    fetchSet.bodies['whisper-model'] = big;
    const items = fetchSet.manifest.items.map((it) => (it.id === 'whisper-model'
      ? { ...it, size: big.length, sha256: require('crypto').createHash('sha256').update(big).digest('hex') } : it));
    fetchManifest = Object.freeze({ schema: 1, items });
    managedRoot = path.join(localAppData, 'natsu', 'engine');
    managedExe = path.join(managedRoot, 'whisper-1.0.0', 'whisper-server.exe');
    const home = { supported: true, root: managedRoot, reason: '' };
    managedMods = {
      install: { ...I, engineRoot: () => home,
        makeRunner: (deps) => I.makeRunner({ ...deps, fetchOpts: { requireHttps: false }, statfs: async () => ({ bavail: 1e6, bsize: 1e6 }) }) },
      manifest: { ...realManifest, MANIFEST: fetchManifest },
    };
  }
  // 前回落ちた会議の下書き（main は起動のときに復旧ページを作り、残った音声を文字起こしし直す）
  if (recoverMode) {
    const startedAt = Date.now() - 600000;
    const wav = path.join(userData, 'data', 'segbuf', String(startedAt), '0001.wav');
    fs.mkdirSync(path.dirname(wav), { recursive: true });
    fs.writeFileSync(wav, toneWav(3));
    fs.writeFileSync(path.join(userData, 'data', 'draft.json'), JSON.stringify({ startedAt, memo: '', offsetMs: 3000, savedAt: startedAt + 3000,
      segments: [{ id: 's1', atMs: 0, durationMs: 3000, pending: true, wav, text: '' }], ...(localOnlyFlag ? { localOnly: true } : {}) }));
  }
  if (scene) {
    // 場面のファイルを、ふだんの settings.json の代わりに置く
    const base = { localServerExe: exe, localModelPath: model, localPort, sumPort };
    for (const [rel, body] of Object.entries(scene.files || {})) {
      const file = path.join(userData, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof body === 'function' ? body({ base, userData }) : body);
    }
    // 第1b回 Task A-2: %LOCALAPPDATA%（一時フォルダ）に置くもの（画面の覚え書きなど）
    for (const [rel, body] of Object.entries(scene.local || {})) {
      const file = path.join(localAppData, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    if (typeof scene.prepare === 'function') scene.prepare(userData);
    for (const [k, v] of Object.entries(scene.env || {})) process.env[k] = String(v);
  } else {
    fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
      ...(managedMode || noEngine || fetchMode ? {} : { localServerExe: exe, localModelPath: model }), localPort, sumPort, autoLaunch: false,
      ...(withSum ? { sumServerExe: FAKE_SUM, sumModelPath: sumModel } : {}),
      ...(fakeStt ? { cloudTranscribe: consentFlag || 'on', sttProvider: 'custom', sttBaseUrl: fakeStt.base, sttModel: 'whisper-large-v3' } : {}),
      ...(noWhisper ? { localServerExe: path.join(tmp, 'no-such-whisper-server.exe') } : {}),
      claudeExe,
    }));
  }

  const handlers = {}, listeners = {}, sent = [];
  const shortcuts = {};   // globalShortcut.register の受け口（キー → 関数）。場面がホットキーを押す
  // 画面へ送った知らせと進み具合の順。進み具合が初めて組を「使える」と言ったとき・壊れた知らせを送ったときの engine:status
  const seq = [];
  const atReady = {};
  let atBroken = null;
  const watch = (ch, p) => {
    if (ch === 'app:notice') {
      seq.push({ notice: p });
      if (atBroken === null && /ファイルが消えたか変わっていました/.test(p) && handlers['engine:status']) atBroken = handlers['engine:status']().whisper;
    }
    if (ch === 'engine:fetch-progress' && p && typeof p === 'object') {
      seq.push({ state: p.state, w: Boolean(p.whisperReady), s: Boolean(p.sumReady), checking: p.checking });
      for (const [g, k] of [['whisper', 'whisperReady'], ['sum', 'sumReady']]) {
        if (p[k] && !(g in atReady) && handlers['engine:status']) atReady[g] = handlers['engine:status']()[g];
      }
    }
  };
  // 知らせ re を送った後に、組 key（w = whisperReady・s = sumReady）を「使える」と言う進み具合の写しが届いたか。main は
  // 切り替えて知らせた後で、空きの測り（非同期）を挟んでからこの写しを送るので、知らせだけを見て終えると写しを取り逃がす
  const switchedAfter = (re, key) => {
    const at = seq.findIndex((x) => x.notice && re.test(x.notice));
    return at >= 0 && seq.slice(at + 1).some((x) => !x.notice && x[key]);
  };
  // 画面の読み込み（--slow-load のときだけ、finishLoad まで読み込み中）。読み込み中に送ったものは画面に届かない（lost）
  let loading = slowLoad || Boolean(scene);
  const loadWaiters = [];
  const lost = [];
  const finishLoad = () => { loading = false; for (const cb of loadWaiters.splice(0)) cb(); };
  const wins = [];   // 作った窓の順（createOverlay が先、createMainWindow が後）
  const appEvents = makeEmitter();
  const zooms = [];   // setZoomFactor の値の順（第1b回 Task A-2）
  // 第1b回 Task A-3: 録音バー（wins[0]）の［一時停止］の真似。main.js の2つの定数（PAUSE_ENSURE_ON・PAUSE_ENSURE_OFF）と同じ文だけを受け、
  // 本物の録音バーと同じく文が見る印のとおりに押す（'on' は止まっていなければ止める、'off' は止まっていれば再開する。同じなら何もしない）。
  // 状態が変わったときだけ、次の番で overlay:pause を返す。場面の overlayPause が 'lost-once' なら最初の1回は何もしない（眠る前に
  // 届かなかった）。'late' なら最初の1回は偽の録音バーの状態だけ変え、返事は場面が ctx.releasePause() を呼ぶまで出さない。
  // ほかの文（window.__koeStart など）は今どおり断る（main は IPC へ落ちる）
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const constOf = (name) => { const mm = mainSrc.match(new RegExp(`const ${name} = (".*");`)); return mm ? JSON.parse(mm[1]) : null; };
  const PAUSE_ON = constOf('PAUSE_ENSURE_ON');
  const PAUSE_OFF = constOf('PAUSE_ENSURE_OFF');
  const overlayMode = (scene && scene.overlayPause) || '';
  const overlayJs = [];
  let overlayPaused = false;
  let overlayCalls = 0;
  let heldPause = null;
  const replyPause = (paused) => setImmediate(() => { if (listeners['overlay:pause']) listeners['overlay:pause'](null, { paused }); });
  const releasePause = () => { if (heldPause) { const p = heldPause; heldPause = null; replyPause(p.paused); } };
  const overlayExec = (win, code) => {
    if (win !== wins[0] || typeof code !== 'string' || (code !== PAUSE_ON && code !== PAUSE_OFF)) return Promise.reject(new Error('no renderer'));
    overlayJs.push(code === PAUSE_ON ? 'on' : 'off');
    overlayCalls += 1;
    if (overlayCalls === 1 && overlayMode === 'lost-once') return Promise.resolve();
    // 文が見る印のとおりに押す（文が印を見ないで押すだけなら、本物と同じく押すたびに切り替わる: 変異 mp-suspend-ensure を赤にする）
    const press = /!p\.classList\.contains\('paused'\)\)/.test(code) ? !overlayPaused
      : (/p\.classList\.contains\('paused'\)\)/.test(code) ? overlayPaused : true);
    if (press) {
      overlayPaused = !overlayPaused;
      if (overlayCalls === 1 && overlayMode === 'late') heldPause = { paused: overlayPaused };
      else replyPause(overlayPaused);
    }
    return Promise.resolve();
  };
  let maximizeCalls = 0;
  class Win {
    constructor(opts) {
      makeEmitter(this);
      this.opts = opts || {};
      this.pos = [0, 0];
      this.normal = null;      // 場面が入れる getNormalBounds の値（無ければ作ったときの値）
      this.bounds = null;      // 場面が入れる getBounds の値（無ければ今までの固定の値）
      this.maximized = false;
      this.minimized = false;
      this.zoom = 1;
      // 受け口つきの webContents（on／once／emit）。読み込み中の once('did-finish-load') は今までどおり読み終えたときに呼ぶ
      const wc = makeEmitter({
        send: (ch, p) => { if (loading) { lost.push([ch, p]); return; } sent.push([ch, p]); watch(ch, p); },
        isLoading: () => loading,
        setWindowOpenHandler() {}, executeJavaScript: (code) => overlayExec(this, code),
        setZoomFactor: (z) => { zooms.push(z); this.zoom = z; },
        getZoomFactor: () => this.zoom,
      });
      const emitterOnce = wc.once;
      wc.once = (ev, cb) => { if (ev === 'did-finish-load' && loading) { loadWaiters.push(cb); return wc; } return emitterOnce(ev, cb); };
      this.webContents = withFallback(wc);
    }
    isDestroyed() { return false; }
    isVisible() { return true; }
    isMinimized() { return this.minimized; }
    isMaximized() { return this.maximized; }
    maximize() { maximizeCalls += 1; this.maximized = true; }
    getSize() { return [316, 72]; }
    setPosition(x, y) { this.pos = [x, y]; }
    getPosition() { return this.pos.slice(); }
    getBounds() { return this.bounds ? { ...this.bounds } : { x: 0, y: 0, width: 316, height: 72 }; }
    getNormalBounds() {
      if (this.normal) return { ...this.normal };
      const o = this.opts;
      return { x: Number.isFinite(o.x) ? o.x : 0, y: Number.isFinite(o.y) ? o.y : 0, width: o.width || 800, height: o.height || 600 };
    }
  }
  for (const m of ['setAlwaysOnTop', 'setVisibleOnAllWorkspaces', 'loadFile', 'show', 'showInactive',
    'hide', 'focus', 'setBounds', 'setIgnoreMouseEvents', 'setSkipTaskbar', 'restore', 'close',
    'destroy', 'setMenuBarVisibility', 'removeMenu', 'moveTop', 'setBackgroundColor', 'setTitle', 'setIcon']) {
    Win.prototype[m] = function () {};
  }
  // 作った窓を順に覚え、app の browser-window-created を出す（main が窓ごとに受け口を付ける所を確かめる）
  class TrackedWin extends Win {
    constructor(...a) {
      super(...a);
      wins.push(this);
      appEvents.emit('browser-window-created', {}, this);
    }
  }
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  // 省電力の抑止（取り込み中は眠らせない: 第0b回 Task 14）と、［取り込み先を開く］の記録
  const power = [];
  let powerId = 0;
  const opened = [];
  const powerMonitor = withFallback(makeEmitter());
  // トレイ（第1c回 A-4: displayBalloon の文を残す。ほかの呼び出しは今までどおり受け流す）
  const balloons = [];
  class FakeTray {
    constructor() { return withFallback(makeEmitter({ displayBalloon: (o) => { balloons.push(String((o && o.content) || '')); } })); }
  }
  // 偽の safeStorage（secrets.test.js の偽物と同じ形。暗号の代わりに印を付けた hex）。復号の回数は out.decrypts に残す
  // （同意が ask・［PC の中だけ］では鍵を復号しない。Linux・macOS では復号でキーリングの確かめが出ることがある）
  let decrypts = 0;
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (str) => fakeEnc(str),
    decryptStringAsync: async (b) => {
      decrypts += 1;
      if (keyUnreadable) throw Object.assign(new Error('safeStorage: 一時的に使えない（試験）'), { code: 'ERR_TEST_UNAVAILABLE' });
      return { result: Buffer.from(String(b).slice(5), 'hex').toString('utf8'), shouldReEncrypt: false };
    },
  };
  // 外の宛先の書き換え: Anthropic へ届くかの確かめだけを偽の送り先へ（ほかは書き換えず、127.0.0.1 でなければ fake-net が死ぬ）。
  // 偽の claude を置く場面（--claude）だけ。--stt だけの場面（第1c回 A-4）で書き換えると、要約が Claude Code の道へ行き、
  // PATH の上の claude を探してしまう（起こすのは mainrun の spawn が止めるが、返事の来ない子を待って場面が時間切れになる）
  const rewrite = (u) => (fakeStt && claudeMode && String(u).startsWith('https://api.anthropic.com/') ? fakeStt.url('/anthropic') : u);
  // --stt=cert: 偽の送り先への要求は、証明書が差し替えられたときの失敗で死ぬ（会社の通信の検査。RF26）
  const before = sttMode === 'cert' ? (_n, o) => (o && String(o.url).startsWith(fakeStt.base) ? { error: 'net::ERR_CERT_AUTHORITY_INVALID' } : null) : null;
  // 偽の screen（第1b回 Task A-2）。並びは場面の displays（既定は 1920×1080 が1つ。作業領域は下のタスクバーを除いた 1920×1040）
  const displays = (scene && scene.displays) || [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  const inRect = (p, r) => p && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
  const screen = {
    getAllDisplays: () => displays.map((d) => JSON.parse(JSON.stringify(d))),
    getPrimaryDisplay: () => JSON.parse(JSON.stringify(displays[0])),
    getDisplayNearestPoint: (p) => JSON.parse(JSON.stringify(displays.find((d) => inRect(p, d.bounds)) || displays[0])),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  };
  const electron = withFallback({
    screen,
    app: withFallback(Object.assign(appEvents, {
      getPath: () => userData, whenReady: () => ready, requestSingleInstanceLock: () => true,
      getVersion: () => require(path.join(ROOT, 'package.json')).version, isPackaged: false, quit() {},
      setLoginItemSettings() {}, getLoginItemSettings: () => ({}), setAppUserModelId() {}, getName: () => 'natsu',
    })),
    BrowserWindow: TrackedWin,
    powerMonitor,
    ipcMain: { handle: (ch, f) => { handlers[ch] = f; }, on: (ch, f) => { listeners[ch] = f; }, removeHandler() {} },
    globalShortcut: { register: (acc, cb) => { shortcuts[acc] = cb; return true; }, unregister() {}, unregisterAll() {}, isRegistered: () => false },
    nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on() {} },
    // 取り込みの通信は Electron の net.request（第0b回 RF2）。テストでは同じ振る舞いの偽物（127.0.0.1 の偽のサーバーへ）
    net: { request: require('./fake-net').makeFakeRequest({ before, rewrite }), isOnline: () => !offline },
    Tray: FakeTray,
    safeStorage,
    powerSaveBlocker: { start: (type) => { powerId += 1; power.push(['start', type, powerId]); return powerId; }, stop: (id) => { power.push(['stop', id]); }, isStarted: () => false },
    shell: withFallback({ openPath: (p) => { opened.push(p); return Promise.resolve(''); } }),
  });
  // エンジンの spawn だけを本物にする（.js なら node で起動）。それ以外（貼り付け用の PowerShell など）は起動しない
  const realSpawn = cp.spawn;
  const spawns = [];   // エンジンの起動（実行ファイル・引数・作業フォルダ）
  // 第1b回の続き Lane F-c・F-d: scene.claude の場面で main が起こす powershell.exe -EncodedCommand（見える窓を開く隠した PowerShell）は本当には起こさず、
  // launches に { cmd, args, exe（環境の NATSU_CLAUDE_EXE）, shell, windowsHide, ansiKeys（課金の変数の名前） } で覚え、
  // launchPlan の先頭の終わりの番号（無ければ 0）で 20ms 後に閉じる偽の子を返す（act が launchPlan に積む）
  const launches = [];
  const launchPlan = [];
  let crashed = false;  // --crash・--crash-ok: 最初の起動だけ 0xC0000135 で落とした
  const childProcess = {
    ...cp,
    spawn(cmd, args, opts) {
      if (scene && scene.claude && cmd === FAKE_CLAUDE) {
        // 偽の claude を使う場面（scene.claude。設定の［Claude Code を確かめる］）: 偽の claude を node で起こす
        const k = realSpawn(process.execPath, [FAKE_CLAUDE, ...args], { ...opts, env: fakeClaudeEnv(opts && opts.env) });
        kids.push(k);
        return k;
      }
      // 窓を開く PowerShell だけ（-EncodedCommand）。Windows で起動のときに起こす貼り付けの常駐 PowerShell（-Command）は今までどおり下の偽の子
      if (scene && scene.claude && /(^|[\\/])powershell\.exe$/i.test(String(cmd)) && Array.isArray(args) && args.includes('-EncodedCommand')) {
        const env = (opts && opts.env) || {};
        launches.push({ cmd, args, exe: env.NATSU_CLAUDE_EXE || '', shell: opts && opts.shell, windowsHide: opts && opts.windowsHide,
          billingKeys: Object.keys(env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_)/i.test(k)) });
        const EventEmitter = require('events');
        const p = new EventEmitter();
        p.pid = 4242; p.stdin = { on: () => {}, end: () => {} }; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
        const code = launchPlan.length ? launchPlan.shift() : 0;
        setTimeout(() => p.emit('close', code), 20);
        return p;
      }
      if (scene && scene.claude && cmd === path.join(userData, 'bin', 'claude.exe')) {
        // 見える窓の場面の claude.exe（中身は空のファイル。findClaude と窓の組み立てが claude.exe を求める）: 偽の claude を node で起こす
        const k = realSpawn(process.execPath, [FAKE_CLAUDE, ...args], { ...opts, env: fakeClaudeEnv(opts && opts.env) });
        kids.push(k);
        return k;
      }
      if (scene && scene.claude && cmd === path.join(userData, 'claude-noexec.exe')) {
        // 場所のファイルはあるが起こせない（実行できない中身）。本当に起こそうとして 'error' を受ける
        const k = realSpawn(cmd, args, opts);
        kids.push(k);
        return k;
      }
      if (scene && !scene.engine) {
        // エンジンを持たない場面: 手のパスが設定にあっても起こさない（偽の子を返す）
        const EventEmitter = require('events');
        const p = new EventEmitter();
        p.stdin = null; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
        return p;
      }
      if (crashMode && !crashed && managedExe && cmd === managedExe) {
        // 照らし終えた後で、ウイルス対策が DLL を消した（--crash）。起動した exe は DLL が見つからず 0xC0000135 で落ちる
        crashed = true;
        spawns.push({ cmd, args, cwd: (opts && opts.cwd) || '', crash: true });
        if (crashMode === 'broken') fs.rmSync(path.join(managedRoot, 'whisper-1.0.0', 'whisper.dll'));
        const EventEmitter = require('events');
        const p = new EventEmitter();
        p.stdin = null; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
        setTimeout(() => p.emit('exit', 3221225781, null), 30);
        return p;
      }
      if (claudeMode && cmd === FAKE_CLAUDE) {
        // 偽の claude を node で起こす（env は main が課金の変数を外したもの。Windows の SystemRoot だけ元に戻す）
        const k = realSpawn(process.execPath, [FAKE_CLAUDE, ...args], { ...opts, env: fakeClaudeEnv(opts && opts.env) });
        kids.push(k);
        return k;
      }
      if (cmd === exe || (withSum && cmd === FAKE_SUM) || (managedExe && cmd === managedExe)) {
        spawns.push({ cmd, args, cwd: (opts && opts.cwd) || '' });
        // 取り込んだ exe（中身は試験のバイト列）の代わりに、偽の whisper を node で起動する
        const js = managedExe && cmd === managedExe ? FAKE : cmd;
        const o = { ...opts, env: childEnv(opts && opts.env) };
        const k = /\.js$/i.test(js) ? realSpawn(process.execPath, [js, ...args], o) : realSpawn(js, args, o);
        kids.push(k);
        return k;
      }
      const EventEmitter = require('events');
      const p = new EventEmitter();
      p.stdin = null; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
      return p;
    },
    execFile(_cmd, _args, _opts, cb) { const done = typeof _opts === 'function' ? _opts : cb; if (done) setImmediate(() => done(new Error('not in test'))); return anyProxy(); },
  };
  const orig = Module._load;
  const MAIN = path.join(ROOT, 'src', 'main.js');
  const SRC = path.join(ROOT, 'src') + path.sep;
  // 場面の faults: src/ の中のファイル（main・store・jsonfile など）が読む fs にだけ効く
  const sceneFs = scene && scene.faults ? require('./faulty-fs').faultyFs(scene.faults) : null;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electron;
    if (req === 'child_process') return childProcess;
    if (sceneFs && (req === 'fs' || req === 'node:fs') && rest[0] && typeof rest[0].filename === 'string' && rest[0].filename.startsWith(SRC)) return sceneFs;
    if (managedMods && rest[0] && rest[0].filename === MAIN) {
      if (req === './engine-install') return managedMods.install;
      if (req === './engine-manifest') return managedMods.manifest;
    }
    return orig.call(this, req, ...rest);
  };

  // 取り込んだエンジンの置き場所（%LOCALAPPDATA%\natsu\engine）は main.js を読んだときに決まるので、その前に一時フォルダへ向ける。
  // Windows の CI で本当のプロファイルの natsu\engine を見ない（フォルダは作らない。main も作らない）。
  // この場面の settings.json は手のパスを持つので、文字起こしは手の設定の道を通る
  process.env.LOCALAPPDATA = localAppData;
  // 60 秒ごとの見回り（releaseIdleEngines）を拾い、待たずに呼べるようにする（本物の setInterval にも渡す）
  const ticks = [];
  const realSetInterval = global.setInterval;
  global.setInterval = function (fn, ms, ...a) { if (fn && fn.name === 'releaseIdleEngines') ticks.push(fn); return realSetInterval.call(this, fn, ms, ...a); };
  const jsonfile = require(path.join(ROOT, 'src', 'jsonfile.js'));
  const timers = {};
  const clearedTimers = {};   // 場面の時計のうち clearTimeout で止められた数（名前ごと）。待っている数 = timers[名前].length - clearedTimers[名前]
  if (scene) {
    // 部品の待ちを縮める（読み直しの約1秒・名前の変更のやり直しの約0.5秒を待たない）
    jsonfile.sleepSync = () => {};
    // 読み直しなどの時計は走らせずに覚える（場面が自分で呼ぶ）
    const realSetTimeout = global.setTimeout;
    global.setTimeout = function (fn, ms, ...a) {
      if (fn && SCENE_TIMERS.has(fn.name)) {
        (timers[fn.name] || (timers[fn.name] = [])).push(fn);
        return { unref() { return this; }, ref() { return this; }, hasRef: () => false, sceneTimer: fn.name, cleared: false };
      }
      return realSetTimeout.call(this, fn, ms, ...a);
    };
    const realClearTimeout = global.clearTimeout;
    global.clearTimeout = function (h) {
      if (h && h.sceneTimer) {
        if (!h.cleared) { h.cleared = true; clearedTimers[h.sceneTimer] = (clearedTimers[h.sceneTimer] || 0) + 1; }
        return undefined;
      }
      return realClearTimeout.call(this, h);
    };
  }
  require(path.join(ROOT, 'src', 'main.js'));
  const store = require(path.join(ROOT, 'src', 'store.js'));
  readyResolve();
  const out = { mode };
  const readUser = (rel) => { try { return fs.readFileSync(path.join(userData, ...rel.split('/'))); } catch (_) { return null; } };
  const engineLogLines = () => {
    const t = readUser('engine.log');
    return t ? t.toString('utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
  };
  if (scene) {
    // 窓が2つ（録音バー・本体）できるのを待ってから、画面の読み込みを終える（起動の知らせは did-finish-load で送られる）
    if (!await waitFor(() => wins.length >= 2, 15000)) throw new Error(`場面 ${sceneName}: 窓ができない（whenReady の途中で止まった）`);
    finishLoad();
    if (scene.engine) await waitFor(() => spawns.length > 0, 15000);
    const actOut = {};
    const readLocal = (rel) => { try { return fs.readFileSync(path.join(localAppData, ...rel.split('/'))); } catch (_) { return null; } };
    if (typeof scene.act === 'function') {
      await scene.act({ handlers, listeners, app: electron.app, wins, mainWin: wins[1], power: powerMonitor, timers, clearedTimers, shortcuts, store, jsonfile, electron, userData,
        localAppData, read: readUser, readLocal, waitFor, sleep, toneWav, releasePause, out: actOut, launches, launchPlan });
    }
    const files = [];
    const walk = (dir, rel) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else files.push(r);
      }
    };
    walk(userData, '');
    const localFiles = [];
    {
      const walkLocal = (dir, rel) => {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of ents) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walkLocal(path.join(dir, e.name), r);
          else localFiles.push(r);
        }
      };
      walkLocal(localAppData, '');
    }
    const text = (rel) => { const b = readUser(rel); return b ? b.toString('utf8') : null; };
    const mainOpts = (wins[1] && wins[1].opts) || {};
    const winStateBuf = readLocal('natsu/window-state.json');
    const result = {
      scene: sceneName,
      notices: sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p),
      files: files.sort(),
      settingsText: text('settings.json'),
      historyText: text('history.json'),
      engineLog: engineLogLines(),
      spawns: spawns.slice(),
      themeSource: electron.nativeTheme.themeSource,
      windows: wins.length,
      windowOpts: Object.fromEntries(['x', 'y', 'width', 'height', 'minWidth', 'minHeight', 'backgroundColor'].map((k) => [k, mainOpts[k]])),
      maximizeCalls,
      zooms: zooms.slice(),
      winStateText: winStateBuf ? winStateBuf.toString('utf8') : null,
      localFiles: localFiles.sort(),
      overlayJs: overlayJs.slice(),
      overlayPaused,
      balloons: balloons.slice(),
      ...actOut,
    };
    process.stdout.write(`\n${JSON.stringify(result)}\n`);
    process.exit(0);
  }
  if (fetchMode) {
    await waitFor(() => handlers['engine:fetch-start']);
    out.managedRoot = managedRoot;
    out.manifestShas = { whisper: fetchManifest.items.filter((i) => i.group === 'whisper').map((i) => i.sha256),
      sum: fetchManifest.items.filter((i) => i.group === 'sum').map((i) => i.sha256) };
    // 起動のときの照らし（何も取り込んでいないので候補は無い）が済み、画面へ今の写しを送るのを待ってから押す
    await waitFor(() => sent.some(([ch]) => ch === 'engine:fetch-progress'));
    out.statusBefore = handlers['engine:status']();
    out.fetchStart = await handlers['engine:fetch-start']({}, {});
    // 取り込みの途中で記録を始めようとする（文字起こしの組はまだ。未設定の文に「取り込み中」）
    out.startDuring = await handlers['meeting:toggle']();
    // 2 つの組がそろって切り替わり、係が止まって（省電力の抑止を外して）、文字起こしエンジンが起動し、切り替えた後の写し
    //（最後の組を「使える」と言う進み具合）が届くのを待つ。要約を手で設定しているとき（--sum）は、文字起こしの組だけを取る
    //（最後の組は文字起こし）
    const lastNotice = withSum ? /^文字起こしが使えるようになりました。/ : /^要約のエンジンが使えるようになりました。/;
    await waitFor(() => switchedAfter(lastNotice, withSum ? 'w' : 's') && power.some(([k]) => k === 'stop') && spawns.length);
    await sleep(100);
    out.seq = seq;
    out.atReady = atReady;
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
    out.progress = sent.filter(([ch]) => ch === 'engine:fetch-progress').map(([, p]) => p && p.state);
    out.lastProgress = sent.filter(([ch]) => ch === 'engine:fetch-progress').map(([, p]) => p).pop() || null;
    out.power = power.slice();
    out.spawns = spawns.slice();
    out.engineStatus = handlers['engine:status']();
    out.engineFetchStatus = await handlers['engine:fetch-status']();
    out.installed = JSON.parse(fs.readFileSync(path.join(managedRoot, 'installed.json'), 'utf8'));
    out.hits = fetchSet.hits().map((h) => h.id);
    out.pause = await handlers['engine:fetch-pause']();
    out.openDir = await handlers['engine:open-dir']();
    out.opened = opened.slice();
    out.savedSettings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    const elog = path.join(userData, 'engine.log');
    out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
    await fetchSet.close();
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  if (managedMode) {
    // 照らしは本物のファイルの読み（イベントループを回す）。マイクロタスクだけを待つ今は、まだ照らし終えていない
    for (let i = 0; i < 100 && !handlers['engine:status']; i++) await null;
    out.statusChecking = handlers['engine:status']();
    out.spawnsBeforeVerify = spawns.length;
    out.managedRoot = managedRoot;
    if (noVcRuntime) {
      // whenReady（トレイ・貼り付け・窓）は今の OS のまま済んだ。照らし終える前に、ランタイムの無い Windows にする
      const winDir = path.join(tmp, 'Windows-空𠮷');
      fs.mkdirSync(winDir);   // System32 は作らない（DLL は exe のフォルダにも System32 にも無い）
      process.env.SystemRoot = winDir;
      process.env.windir = winDir;
      if (process.platform !== 'win32') Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    }
    // 起動のときの照らしの途中に、60 秒ごとの見回り（releaseIdleEngines）が来る。照らしの結果を待ち、二重に照らさない（Task 14）
    out.ticksDuringCheck = ticks.length;
    for (const t of ticks) t();
    // 照らし終えるのを待つ
    await waitFor(() => !/確かめています/.test(handlers['engine:status']().whisper));
    // --slow-load: 画面の読み込みはここで終わる（読み込み中に送った分は lost。main が読み終えるのを待って送る分は、ここで届く）
    out.lostWhileLoading = lost.map(([ch, p]) => (ch === 'app:notice' ? p : ch));
    finishLoad();
  }
  if (crashMode) {
    // 文字起こしエンジンが 0xC0000135 で落ちた後（--crash・--crash-ok）
    const elogFile = path.join(userData, 'engine.log');
    const elog = () => (fs.existsSync(elogFile) ? fs.readFileSync(elogFile, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : []);
    const noticed = (re) => sent.some(([ch, p]) => ch === 'app:notice' && re.test(p));
    if (crashMode === 'broken') {
      // 照らし直して使うのをやめ、取り直し、照らし直してから使い直す（要約の組も、同意済みなので続けて取る）。切り替えた後の写しまで待つ
      await waitFor(() => noticed(/^文字起こしが使えるようになりました。/) && switchedAfter(/^要約のエンジンが使えるようになりました。/, 's') && spawns.length >= 2);
      await sleep(100);
    } else {
      // 照らし直して合う: 組は使い続け、［起動テスト］で起動し直せる
      await waitFor(() => elog().some((l) => l.includes('落ちた後に取り込んだファイルを照らし直しました')));
      await sleep(100);
      out.engineStatusAfterCrash = handlers['engine:status']();
      out.fetchStatusAfterCrash = await handlers['engine:fetch-status']();
      out.testAfterCrash = await handlers['app:test']();
    }
    out.seq = seq;
    out.atBroken = atBroken;
    out.atReady = atReady;
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
    out.hits = fetchSet.hits().map((h) => h.id);
    out.spawns = spawns.slice();
    out.verifyCalls = verifyCalls;
    out.engineStatus = handlers['engine:status']();
    out.engineFetchStatus = await handlers['engine:fetch-status']();
    out.engineLog = elog();
    await fetchSet.close();
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  await waitFor(() => handlers['meeting:toggle']);
  // 第1c回 A-4 の出力（--stt のとき）。segbuf の下に recovery.json と WAV が残っているか
  const segbufLeft = () => {
    const root = path.join(userData, 'data', 'segbuf');
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch (_) { return { queue: false, wav: false }; }
    let queue = false; let wav = false;
    for (const d of dirs) {
      let names = [];
      try { names = fs.readdirSync(path.join(root, d)); } catch (_) { continue; }
      if (names.includes('recovery.json')) queue = true;
      if (names.some((n) => /\.wav$/i.test(n))) wav = true;
    }
    return { queue, wav };
  };
  const claudeLines = () => {
    const t = fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog) : null;
    return t ? t.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const elogLines = () => { const t = readUser('engine.log'); return t ? t.toString('utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : []; };
  // 画面に渡る経路の行（page:get の返事の routeText）と、最後の page:updated で送った routeText（第1c回 C-3）
  const pageRouteText = (id) => { const r = handlers['page:get'] ? handlers['page:get']({}, id) : null; return r && r.page ? r.page.routeText : null; };
  const lastUpdatedRouteText = () => {
    const u = sent.filter(([ch]) => ch === 'page:updated').pop();
    return u && u[1] && u[1].page ? u[1].page.routeText : null;
  };
  const sttOut = () => {
    if (!fakeStt) return;
    out.stt = fakeStt.requests.slice();
    out.balloons = balloons.slice();
    out.decrypts = decrypts;
    const sec = readUser('secrets.json');
    out.secretsRaw = sec ? sec.toString('utf8') : null;
    const left = segbufLeft();
    out.recoveryKept = left.queue && left.wav;
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
    out.engineLog = elogLines();
    out.spawns = spawns.slice();
    out.savedSettings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    out.pages = store.listPages().map((p) => {
      const page = store.getPage(p.id);
      return {
        summaryError: page.summaryError, route: page.route, routeText: pageRouteText(p.id),
        segments: store.getTranscript(p.id).map((x) => ({ text: x.text, failed: Boolean(x.failed) })),
      };
    });
  };
  // 送り直し（復旧の待ち行列）が済むか、残して止まるまで待つ（--stt のとき）
  const recoverySettled = () => elogLines().some((l) => /復旧の文字起こしを(保留|止めました)/.test(l)) || !segbufLeft().queue;
  if (recoverMode && fakeStt) {
    const recovered = () => { const p = store.listPages()[0]; return p ? store.getTranscript(p.id) : []; };
    // 済んだ（成功した区間がある・待ち行列が片付いた）か、残して止まった（保留・止めました）まで
    await waitFor(() => store.listPages().length > 0 && (recovered().some((x) => !x.failed) || recoverySettled()));
    await sleep(100);
    sttOut();
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  if (dictate) {
    // 音声入力を1回: ホットキー → 録音 → 音声が届く → 文字起こし → 履歴
    const hk = (await handlers['settings:get']()).hotkey;
    if (!shortcuts[hk]) throw new Error(`音声入力のホットキー ${hk} が登録されていない`);
    shortcuts[hk]();
    listeners['audio:done']({}, { buffer: new Uint8Array(toneWav(3)), durationMs: 3000 });
    await waitFor(() => (handlers['history:get']() || []).length > 0, 15000);
    await sleep(100);
    out.history = handlers['history:get']();
    sttOut();
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  if (recoverMode) {
    // 復旧の文字起こしが済むのを待つ
    const recovered = () => { const p = store.listPages()[0]; return p ? store.getTranscript(p.id) : []; };
    await waitFor(() => recovered().some((x) => !x.failed));
    out.recovered = recovered().map((x) => ({ text: x.text, failed: Boolean(x.failed) }));
    out.spawns = spawns;
    const elog = path.join(userData, 'engine.log');
    out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  if (repairMode) {
    // 壊れていた組の取り直しと、照らし直した後の切り替え（要約の組も続けて取る）と、切り替えた後の写しを待つ
    await waitFor(() => switchedAfter(/^要約のエンジンが使えるようになりました。/, 's') && spawns.length);
    await sleep(100);
    out.seq = seq;
    out.atReady = atReady;
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
    out.hits = fetchSet.hits().map((h) => h.id);
    out.spawns = spawns.slice();
    out.engineStatus = handlers['engine:status']();
    out.engineFetchStatus = await handlers['engine:fetch-status']();
    const elog = path.join(userData, 'engine.log');
    out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
    await fetchSet.close();
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  if (managedMode === 'tamper' || noVcRuntime || verifyThrows || noEngine) {
    // 使えない組は使わない。記録も始めない（区間を送らずに終える）
    await sleep(300);
    out.engineStatus = handlers['engine:status']();
    out.engineFetchStatus = await handlers['engine:fetch-status']();
    out.start = await handlers['meeting:toggle']();
    out.test = await handlers['app:test']();
    out.spawns = spawns.slice();
    if (managedMode === 'tamper') {
      // 60 秒ごとの見回りを 2 回呼ぶ。壊れた組は、取り直されるか触られるまで照らし直さない（Task 14）
      out.noticesBeforeTicks = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
      out.verifyCallsBeforeTicks = verifyCalls;
      out.ticks = ticks.length;
      for (let k = 0; k < 2; k++) { for (const t of ticks) t(); await sleep(150); }
      out.verifyCallsAfterTicks = verifyCalls;
      out.noticesAfterTicks = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
      out.spawnsAfterTicks = spawns.slice();
    }
    if (noVcRuntime) {
      // 情報システムの担当がランタイムを入れた（System32 に 14.51 の DLL を置く）。NaTsu を起動し直さずに［起動テスト］を押す
      const s32 = path.join(process.env.SystemRoot, 'System32');
      fs.mkdirSync(s32);
      for (const d of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll']) fs.writeFileSync(path.join(s32, d), peWithVersion(14, 51, 36247, 0));
      out.engineStatusBeforeRetest = handlers['engine:status']();
      out.testAfterInstall = await handlers['app:test']();
      out.engineStatusAfterInstall = handlers['engine:status']();
      out.spawnsAfterInstall = spawns.slice();
    }
    // 終わりの片付け（一時フォルダを消す）は今の OS のままで行う
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true });
    const elog = path.join(userData, 'engine.log');
    out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  if (runTest) out.test = await handlers['app:test']();

  const wavs = process.env.NATSU_E2E_WAVS
    ? process.env.NATSU_E2E_WAVS.split(';').map((f) => ({ buf: fs.readFileSync(f), ms: Math.round((fs.statSync(f).size - 44) / 32) }))
    : Array.from({ length: segCount }, (_, i) => ({ buf: toneWav(i ? 2 : 3, silent ? 0 : 8000), ms: i ? 2000 : 3000 }));
  out.start = await handlers['meeting:toggle']();
  out.statusCloud = handlers['meeting:status']().cloud;   // C-3: 会議の状態の「クラウドで処理する設定か」（同意が on のときだけ true）
  if (localOnlyFlag) {
    out.localOnly = await handlers['meeting:set-local-only']({}, true);
    const st = handlers['meeting:status']();
    out.statusLocalOnly = { localOnly: st.localOnly, cloud: st.cloud };
    // 下書き（draft.json）にも印が書かれたか（落ちて復旧した会議の送り直しも手元にするため）
    try { out.draftLocalOnly = JSON.parse(readUser('data/draft.json').toString('utf8')).localOnly; } catch (_) { out.draftLocalOnly = null; }
  }
  for (let i = 0; i < wavs.length; i++) {
    const last = i === wavs.length - 1;
    if (last) out.stop = await handlers['meeting:toggle']();
    listeners['audio:segment']({}, { buffer: new Uint8Array(wavs[i].buf), durationMs: wavs[i].ms, final: last });
    await sleep(50);
    if (i === 0 && testDuring) out.testDuring = await handlers['app:test']();
    if (i === 0 && discardDuring) { await sleep(300); out.discard = await handlers['meeting:discard'](); break; }
  }
  if (discardDuring) await sleep(3000);   // 破棄の後にやり直しが送られないことを、返事が来るまで待って確かめる
  const deadline = Date.now() + (discardDuring ? 0 : Number(process.env.NATSU_E2E_WAIT_MS || 60000));
  while (Date.now() < deadline && !store.listPages().length) await sleep(50);
  // 要約の途中で会議タイプを手で選び直す（画面の［要約タイプ］と同じ IPC）
  if (setTypeDuring && store.listPages().length) {
    await sleep(300);
    out.setType = await handlers['page:setType']({}, { id: store.listPages()[0].id, type: setTypeDuring });
  }
  // 要約まで済むのを待つ: 要約のブロックができるか、要約欄に理由が書かれるまで
  // （新しいページは summaryError を空で持っているので、空かどうかでは決められない）
  while (Date.now() < deadline) {
    const p = store.listPages()[0];
    const page = p && store.getPage(p.id);
    if (page && ((page.blocks && page.blocks.length) || page.summaryError)) break;
    await sleep(50);
  }
  await sleep(200);
  const pages = store.listPages().map((p) => {
    const page = store.getPage(p.id);
    return {
      summaryError: page.summaryError,
      segments: store.getTranscript(p.id).map((s) => ({ text: s.text, failed: Boolean(s.failed) })),
      meetingType: page.meetingType, typeAuto: page.typeAuto, actionStat: page.actionStat,
      route: page.route, routeText: pageRouteText(p.id), citeStat: page.citeStat || null,
      blocks: (page.blocks || []).map((b) => ({ type: b.type, cites: Array.isArray(b.cites) ? b.cites.length : 0 })),
      todos: (page.blocks || []).filter((b) => b.type === 'todo').map((b) => ({ text: b.text, assignee: b.assignee || '', due: b.due || '', dueRaw: b.dueRaw || '' })),
    };
  });
  out.pages = pages;
  out.updatedRouteText = lastUpdatedRouteText();
  // 文字起こしの行を直したときの返事（segment:update）も経路の行を持つか（画面はその返事で curPage を差し替える）。
  // 要約まで済んだ --claude=ok の場面だけ、1つ目の行を同じ文で直す（失敗の印を外すので、ほかの場面では触らない）
  if (claudeMode === 'ok' && store.listPages().length) {
    const pid = store.listPages()[0].id;
    const sg = store.getTranscript(pid)[0];
    const r = sg ? handlers['segment:update']({}, { pageId: pid, segId: sg.id, patch: { text: sg.text } }) : null;
    out.segUpdateRouteText = r && r.page ? r.page.routeText : null;
  }
  out.claude = claudeLines();
  out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
  const elog = path.join(userData, 'engine.log');
  out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
  out.requests = fs.readFileSync(flog, 'utf8').split('\n').filter((l) => l.startsWith('inference'));
  out.spawnArgs = (fs.readFileSync(flog, 'utf8').split('\n').find((l) => l.startsWith('spawn ')) || '').slice(6);
  out.promptInfo = await handlers['prompt:info']();
  out.engineStatus = await handlers['engine:status']();
  out.engineFetchStatus = handlers['engine:fetch-status'] ? await handlers['engine:fetch-status']() : null;   // 第0b回 Task 13
  out.spawns = spawns;
  out.seq = seq;
  out.atReady = atReady;
  out.savedSettings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  if (afterDict) {
    out.saved = await handlers['settings:save']({}, { dictionary: ['検収'] });
    out.promptInfoAfterDict = await handlers['prompt:info']();
  }
  if (fakeStt) {
    // 会議の後の送り直し（失敗した区間の待ち行列）が済むか、残して止まるまで待ってから写す
    await waitFor(recoverySettled, 15000);
    await sleep(100);
    const pagesBefore = out.pages;
    sttOut();
    // 今までの欄（要約・会議タイプなど）も残す
    out.pages = out.pages.map((p, i) => ({ ...(pagesBefore[i] || {}), ...p }));
  }
  process.stdout.write(`\n${JSON.stringify(out)}\n`);
  process.exit(0);
})().catch((e) => { process.stderr.write(`mainrun: ${e.stack || e}\n`); process.exit(1); });
