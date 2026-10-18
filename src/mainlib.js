/*
 * mainlib.js — main.js から切り出した判断（Electron に依存しない部分）
 *
 * main.js は Electron を require するので、テストから直接は読み込めない。
 * 実機で踏んだ不具合の「判断」だけをここに置き、test/main.test.js で実行して
 * 固定する。main.js がこれらを本当に呼んでいるかは repo.test.js で見る。
 */
'use strict';

const path = require('path');

// ---------------------------------------------------------------- 要約の書き戻し
// 要約は数分かかる。その間に利用者がページを削除していることがある。
// 入口で読んだ page をそのまま保存すると、削除した議事録が復活する
// （「消したはずの議事録が戻ってくる」）。必ずいまディスクにある
// ページを読み直し、無ければ何も書かずに null を返す。
// apply(page) は、生成物だけを最新のページに載せる（タイトルやメモは
// 要約中に編集されているかもしれないので、古いコピーで上書きしない）。
function saveIfExists(store, pageId, apply) {
  const saved = store.getPage(pageId);
  if (!saved) return null;
  apply(saved);
  return store.savePage(saved);
}

// ---------------------------------------------------------------- 会議の長さ
// endAt は停止時刻（stoppedAt）。以降の文字起こし待ちを混ぜると 4分の会議が
// 12分になる。一時停止したまま停止した場合、pausedAt から endAt までを
// 一時停止として引く（Date.now() で引くと待ち時間の分だけ短く、負にもなる）。
function meetingDurationSec(m, endAt) {
  const end = endAt || Date.now();
  const pausedTotal = (m.pausedMs || 0) + (m.paused ? Math.max(0, end - m.pausedAt) : 0);
  return Math.max(0, Math.round((end - m.startedAt - pausedTotal) / 1000));
}

// ---------------------------------------------------------------- 初期プロンプトの尻尾
// 次の区間の初期プロンプトには直前の発言の末尾を渡す。失敗区間の text は
// 「（この区間の認識に失敗: …）」というエラー文なので、渡すと次の区間が
// エラー文を「文例」として真似る。直近の成功区間から取り、最大2件だけ遡る
// （それ以上前の発言は文脈として古い）。
// 文字起こし待ち（pending。本文がまだ無い）は飛ばす（#8/#42）。飛ばさないと、末尾に
// 待ちが並んでいるあいだ毎回空になり、直前の発言の文脈が途切れる。
function promptTail(segments) {
  const done = (segments || []).filter((s) => s && !s.pending);
  const n = done.length;
  for (let i = n - 1; i >= Math.max(0, n - 2); i--) {
    const s = done[i];
    if (!s.failed) return String(s.text || '').slice(-100);
  }
  return '';
}

// ---------------------------------------------------------------- ホットキー
// entries: [{ label, accel, handler }]。register(accel, handler) は成功で true。
// 片方が他アプリと衝突していても、もう片方は使えるままにする（以前は
// 片方の失敗で両方を解除し、音声入力まで効かなくなっていた）。
// accel が空なら「未設定」で、失敗には数えない。
function registerHotkeys(entries, register) {
  const failed = [];
  for (const e of entries) {
    if (!e.accel) continue;
    let ok = false;
    try { ok = Boolean(register(e.accel, e.handler)); } catch (_) { ok = false; }
    if (!ok) failed.push(e.label);
  }
  return { ok: failed.length === 0, failed };
}

// failed: registerHotkeys の failed。accelOf: { 音声入力: 'Control+…', 議事録: 'Alt+M' }
// 保存時の warning（その場の一回の失敗「登録できませんでした」）に使う。
// いまの登録状態（「登録できていません」）は hotkeyStatus が組む。
function hotkeyFailureMessage(failed, accelOf) {
  if (!failed.length) return '';
  return `${failed.map((l) => `${l}のホットキー ${accelOf[l]} `).join('と')}は他のアプリが使用中のため登録できませんでした`;
}

// 側（画面に出す名前）と設定のキー名の対応
const HOTKEY_SIDES = [['音声入力', 'hotkey'], ['議事録', 'meetingHotkey']];
const HOTKEY_KEY_OF = { 音声入力: 'hotkey', 議事録: 'meetingHotkey' };
const accelOf = (keys) => ({ 音声入力: keys.hotkey, 議事録: keys.meetingHotkey });

// 「設定（利用者が選んだキー）」と「実際に登録しているキー」の関係を、画面と
// トレイに出す形にする。設定と登録を分けて持つのは、起動時に既定へ退避しても
// 設定を書き換えないため（設定を書き換えると settings:get が既定を返して設定
// 画面に既定が出、次の無関係な保存でディスクにも漏れて利用者のキーが黙って消える）。
//   wanted: 設定のキー { hotkey, meetingHotkey }
//   active: 登録を試みたキー（退避で既定になっている側がある）
//   failed: registerHotkeys(active…) の failed ＝ いま登録できていない側
// 戻り値:
//   active: トレイに出すキー。登録できていない側は利用者のキーを名乗る
//           （既定のキーを出すと、そのキーが効くように見える）
//   state : hotkey:state で画面に返す { ok, failed, fallback, message }
//           failed   … いま登録できていない側（退避後の結果）
//           fallback … { 側: { wanted: 利用者のキー, using: 既定のキー } } 退避中の側
//           ok       … 利用者の設定どおりに全部登録できているときだけ true
//                      （退避中も false。利用者の選んだキーは効いていない）
//           message  … 画面に出す一文
//   note  : トレイの注記「（音声入力: 既定の … を使用中・Alt+M は登録できず）」
function hotkeyStatus(wanted, active, failed) {
  const act = { ...active };
  const fallback = {};
  for (const [label, key] of HOTKEY_SIDES) {
    if (failed.includes(label)) { act[key] = wanted[key]; continue; }
    if (act[key] !== wanted[key]) fallback[label] = { wanted: wanted[key], using: act[key] };
  }
  const parts = [];
  const notes = [];
  for (const [label] of HOTKEY_SIDES) {
    const f = fallback[label];
    if (!f) continue;
    parts.push(`${label}のホットキー ${f.wanted} は他のアプリが使用中のため、代わりに既定の ${f.using} を使っています`);
    notes.push(`${label}: 既定の ${f.using} を使用中`);
  }
  if (failed.length) {
    const keys = failed.map((l) => wanted[HOTKEY_KEY_OF[l]]);
    parts.push(`${failed.map((l, i) => `${l}のホットキー ${keys[i]} `).join('と')}は他のアプリが使用中のため登録できていません`);
    notes.push(`${keys.join('・')} は登録できず`);
  }
  return {
    active: act,
    state: { ok: parts.length === 0, failed: [...failed], fallback, message: parts.join('。') },
    note: notes.length ? `（${notes.join('・')}）` : '',
  };
}

// 起動時: 登録できなかった側だけ既定に落として一度だけ再試行する。
// cfg（利用者の設定）は読むだけで書き換えない。有効なキーは戻り値の active で返す
// ので、呼び出し側は settings ではなく別の変数（activeHotkeys）に持つ。
// apply(hk, mhk) は registerHotkeys の戻り値を返す（解除して両方を登録し直す）。
function resolveStartupHotkeys(cfg, defaults, apply) {
  const wanted = { hotkey: cfg.hotkey, meetingHotkey: cfg.meetingHotkey };
  const first = apply(wanted.hotkey, wanted.meetingHotkey);
  if (first.ok) return hotkeyStatus(wanted, wanted, []);

  // 設定がもともと既定なら、同じキーをもう一度試しても同じなので落とさない
  const active = { ...wanted };
  const retried = [];
  for (const l of first.failed) {
    const k = HOTKEY_KEY_OF[l];
    if (defaults[k] && defaults[k] !== wanted[k]) { active[k] = defaults[k]; retried.push(l); }
  }
  const second = retried.length ? apply(active.hotkey, active.meetingHotkey) : first;

  // failed は「いま登録できていない側」＝ 既定でも駄目だった側。既定で登録できた側は
  // fallback に載る。以前は最初の失敗をそのまま failed にしていたので、既定で動いている
  // キーの下に「登録できていません」が出ていた。
  const r = hotkeyStatus(wanted, active, second.failed);
  const alsoDefault = retried.filter((l) => second.failed.includes(l)).map((l) => defaults[HOTKEY_KEY_OF[l]]);
  if (alsoDefault.length) r.state.message += `（既定の ${alsoDefault.join('・')} も登録できませんでした）`;
  return r;
}

// 保存時: 変えた側だけ新しいキーで登録し直す。変えていない側は「いま動いているキー」
// （active。起動時に既定へ退避していればその既定）のまま。利用者のキーを再登録すると、
// 退避した理由の衝突がまだあれば再び失敗して、動いていた既定まで失う。
//   prev  : いまの設定（利用者のキー）、active: いま登録しているキー、next: 保存する設定
// 新しいキーが登録できなかった側は、設定を prev に、登録を active に戻す。
// 戻り値の applied は「設定として残ったキー」。画面はこれを欄に戻す（失敗したキーが
// 欄に残ると、以後の無関係な保存のたびに再失敗して警告が出続ける）。
// 両方とも変えていなければ null（登録し直さず、状態も触らない）。
function saveHotkeys(prev, active, next, apply) {
  const changed = HOTKEY_SIDES.filter(([, k]) => next[k] !== prev[k]).map(([l]) => l);
  if (!changed.length) return null;
  const want = { ...active };
  for (const l of changed) want[HOTKEY_KEY_OF[l]] = next[HOTKEY_KEY_OF[l]];
  let r = apply(want.hotkey, want.meetingHotkey);

  const applied = { hotkey: next.hotkey, meetingHotkey: next.meetingHotkey };
  const rejected = changed.filter((l) => r.failed.includes(l));
  let warning = '';
  if (rejected.length) {
    warning = hotkeyFailureMessage(rejected, accelOf(next));
    for (const l of rejected) {
      const k = HOTKEY_KEY_OF[l];
      applied[k] = prev[k];
      want[k] = active[k];
    }
    r = apply(want.hotkey, want.meetingHotkey);
  }
  return { applied, warning, ...hotkeyStatus(applied, want, r.failed) };
}

// ---------------------------------------------------------------- 要約の排他
// 同じ id の要約は同時に一つだけ。走行中に「要約を生成」を連打されると、同じ
// 文字起こしに対して要約が二重に走り、後から終わった方が前の結果（とその間の
// 編集）を上書きしていた。走行中なら同じ Promise を返し、終わったら（失敗でも）外す。
// run(id) は Promise を返す。onChange(件数) は走っている数が変わるたびに呼ばれる
// （要約中はアプリを「忙しい」として扱うため。#52）。戻り値の runner.running() は
// 走っている id の一覧（終了時に「中断された」と書く先）。
function makeSummaryRunner(run, onChange) {
  const running = new Map();
  const notify = () => { if (onChange) { try { onChange(running.size); } catch (_) { /* noop */ } } };
  const runner = (id) => {
    if (running.has(id)) return running.get(id);
    let p;
    try { p = Promise.resolve(run(id)); } catch (e) { p = Promise.reject(e); }
    p = p.finally(() => { running.delete(id); notify(); });
    running.set(id, p);
    notify();
    return p;
  };
  runner.running = () => [...running.keys()];
  return runner;
}

// ---------------------------------------------------------------- overlay:tick の見張り
// main のタイマーから5秒ごとに呼ぶ。戻り値は判断（'send' | 'skip' | 'stop'）。
// 見張りを消す（stop）のは議事録が無くなったときだけ。一時停止は送信を飛ばす（skip）
// だけにする。一時停止で消すと、再開しても誰も起こし直さず、以後の区切りが画面の
// 間引かれるタイマー任せに戻る（1区間が9分になる元の不具合が再発する）。
function tickStep({ state, meeting }, send, stop) {
  if (state !== 'meeting' || !meeting) { stop(); return 'stop'; }
  if (meeting.paused) return 'skip';
  send();
  return 'send';
}

// ---------------------------------------------------------------- クリップボード（Windows）
// 常駐 PowerShell に流す 1 行スクリプト。標準入力の 1 行が 1 命令。
//   paste          … Ctrl+V を送る（従来どおり）
//   copy <base64>  … クリップボードを「除外書式付き」で置き直す（#27）
// 置き直すのは、Windows のクリップボード履歴（Win+V）とクラウド同期（他の PC への
// 同期）から外すため。会議の発言や議事録が履歴に残り他の PC へ同期されるのは、
// オフラインで完結するという前提を裏口から破る。
//   ExcludeClipboardContentFromMonitorProcessing … 監視するアプリ全般に「見るな」
//   CanIncludeInClipboardHistory / CanUploadToCloudClipboard … DWORD 0 で「入れない・上げない」
// 値は 4 バイトの MemoryStream で渡す。byte[] を直接 SetData すると .NET の
// シリアライズ形式（ヘッダ付き）で包まれ、Windows が DWORD として読めない。
// 本文は base64 で 1 行に載せる（改行や引用符を含んでも命令の境界が壊れない）。
// PS5.1 で動く書き方にする（switch / [ValidateSet] は使わない）。失敗しても
// Electron が先に書いた本文は残る（try で包み、除外だけが効かない状態に留める）。
//   fg             … 前面ウィンドウの HWND を 10 進で 1 行出す（取れなければ 0）（#54）
//   paste <hwnd>   … 今の前面が <hwnd> と同じなら Ctrl+V を送って ok、違えば何もせず mismatch
//                    （録音を始めたときの窓と違う所へ口述を流し込まない）。SendWait が投げたら fail
// 応答（ok / mismatch / fail / HWND）は標準出力に 1 行ずつ。main は命令を送った順に受け取る。
// P/Invoke は user32 の GetForegroundWindow 1 つだけ。C# の文字列に要る二重引用符は
// [char]34 で作る（-Command の引数に二重引用符があると Node の引数の引用で壊れる）。
function pasterScript() {
  return "$ErrorActionPreference='SilentlyContinue';"
    + 'Add-Type -AssemblyName System.Windows.Forms;'
    + '$q=[char]34;'
    + " Add-Type -TypeDefinition ('using System; using System.Runtime.InteropServices; public class KoeFg { [DllImport('+$q+'user32.dll'+$q+')] public static extern IntPtr GetForegroundWindow(); }');"
    + 'while($true){ $l=[Console]::In.ReadLine(); if($null -eq $l){break};'
    + " if($l -eq 'fg'){ try { [Console]::Out.WriteLine([string][long][KoeFg]::GetForegroundWindow()) } catch { [Console]::Out.WriteLine('0') } }"
    + " elseif($l -eq 'paste'){ try { [System.Windows.Forms.SendKeys]::SendWait('^v'); [Console]::Out.WriteLine('ok') } catch { [Console]::Out.WriteLine('fail') } }"
    + " elseif($l.StartsWith('paste ')){ $h='0'; try { $h=[string][long][KoeFg]::GetForegroundWindow() } catch { $h='0' };"
    + " if($h -eq $l.Substring(6)){ try { [System.Windows.Forms.SendKeys]::SendWait('^v'); [Console]::Out.WriteLine('ok') } catch { [Console]::Out.WriteLine('fail') } }"
    + " else { [Console]::Out.WriteLine('mismatch') } }"
    + " elseif($l.StartsWith('copy ')){ try {"
    + ' $t=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l.Substring(5)));'
    + ' $d=New-Object System.Windows.Forms.DataObject; $d.SetText($t);'
    + ' $z={ [System.IO.MemoryStream]::new([byte[]](0,0,0,0)) };'
    + " $d.SetData('ExcludeClipboardContentFromMonitorProcessing',(& $z));"
    + " $d.SetData('CanIncludeInClipboardHistory',(& $z));"
    + " $d.SetData('CanUploadToCloudClipboard',(& $z));"
    + ' [System.Windows.Forms.Clipboard]::SetDataObject($d, $true) } catch {} } }';
}

// 常駐 PowerShell の標準出力の 1 行を読む。HWND（10 進）は { kind:'hwnd', value }（0 は「控えられ
// なかった」= ''）、ok / mismatch / fail は { kind }、それ以外（エラー文など）は null
function parsePasterLine(line) {
  if (typeof line !== 'string') return null;
  const t = line.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return { kind: 'hwnd', value: t === '0' ? '' : t };
  if (t === 'ok' || t === 'mismatch' || t === 'fail') return { kind: t };
  return null;
}

// 自動貼り付けのあとに元のクリップボードを戻すか。戻すのは短い1行の文字列だけ。
// 複数行・長文は、書式付きのコピー（Word・ブラウザ）の文字部分であることが多く、文字だけで
// 戻すと元より劣るものに置き換わる。貼り付けた本文と同じなら戻す意味が無い
const RESTORE_MAX_CHARS = 200;
function restoreAfterPaste(prev, text) {
  // 文字列でない元（44 の clipboard が返す Promise・読めなかった null）は戻さない（[object Promise] を置かない最後の守り）
  if (typeof prev !== 'string') return false;
  const p = String(prev ?? '');
  if (!p || p === String(text ?? '')) return false;
  if (/[\r\n]/.test(p)) return false;
  return p.length <= RESTORE_MAX_CHARS;
}

// 常駐 PowerShell へ流す「置き直し」命令（改行なし。呼び出し側が '\n' を足す）
function copyCommand(text) {
  return `copy ${Buffer.from(String(text ?? ''), 'utf8').toString('base64')}`;
}

// ---------------------------------------------------------------- クリップボード（#27・第0c回 EL1）
// クリップボードへ書く唯一の入口（#27）。Windows では常駐 PowerShell に頼んで、クリップボード
// 履歴（Win+V）とクラウド同期から除外する書式を付けて置く（書式は pasterScript）。
// 置けたことをクリップボードを読み返して確かめ、置けていなければ（PowerShell が居ない・
// まだ起動中・失敗）Electron の clipboard で書く（履歴には入るが、何も残らないよりはよい）。
// 先に Electron で書くと、その最初の書き込みが履歴とクラウド同期に採られる。除外の印は
// 後から置き直しても、採られた分は消えない。'paste' と同じ標準入力に順に流すので、
// 置き直しが貼り付けより後になることはない。
// Electron 44 では main でも clipboard.readText()／writeText() が Promise を返す（31 では文字列と
// undefined）。だから読み書きは全部待つ（文字列を待っても害は無い）。Electron は読まず、外から
// d = { clip, paster(), sleep(ms) }（deliverText はさらに autoPaste・fg・simulatePaste・notice・later）をもらう。
const COPY_SETTLE_MS = 150;
// 貼り付け先がクリップボードを読む前に戻すと古い方が貼られる。SendWait は処理完了まで
// 待つが、読み取りが遅いアプリ（ブラウザの入力欄・Teams）は 500ms では間に合わなかった
const RESTORE_DELAY_MS = 2000;
// クリップボードの文字を読む。文字列でない・投げた・Promise が断られた、は null
async function readClip(clip) {
  try {
    const v = await clip.readText();
    return typeof v === 'string' ? v : null;
  } catch (_) { return null; }
}
// 改行の形（CRLF / LF）の違いは置けた・置けていないの判断に使わない
function clipEquals(a, b) {
  return typeof a === 'string' && a.replace(/\r\n/g, '\n') === String(b).replace(/\r\n/g, '\n');
}
// 戻り値は 'private'（常駐 PowerShell が除外の印付きで置けた）か 'electron'（Electron で書いた）。
// d.paster() は呼ぶたびに今の口 { writable(), write(line) } か null を返す（2 秒後の戻しで死んだ口を使わない）
async function copyPrivate(text, d) {
  const t = String(text ?? '');
  const p = d.paster();
  if (p && p.writable()) {
    try {
      p.write(`${copyCommand(t)}\n`);
      await d.sleep(COPY_SETTLE_MS);
      if (clipEquals(await readClip(d.clip), t)) return 'private';
    } catch (_) { /* 下で Electron が書く */ }
  }
  await d.clip.writeText(t);
  return 'electron';
}
// 自動貼り付けのあとは元のクリップボードを戻す（短い文字列だったときだけ・できる範囲で。
// 判断は restoreAfterPaste）。音声入力は「いま書いている場所へ入れる」道具なので、
// 貼り付けた本文がクリップボードに残り続けると、直前にコピーしていたものが失われる。
// d.fg は録音を始めたときの前面の窓の HWND の Promise。文字起こしの間に通知や Teams が
// 前へ出ていると、そこへ口述が流れ込むので、違えば貼らずクリップボードに残す（#54）
async function deliverText(text, d) {
  let prev = '';
  if (d.autoPaste) prev = (await readClip(d.clip)) ?? '';
  await copyPrivate(text, d);
  if (!d.autoPaste) return undefined;
  await d.sleep(50);
  // 貼り付け先は録音を始めたときの前面ウィンドウ（#54）。違えば貼らずクリップボードに残す
  const hwnd = await d.fg;
  const result = await d.simulatePaste(hwnd);
  if (result === 'mismatch') { d.notice('貼り付け先が変わったため、クリップボードに残しました（Ctrl+V で貼り付けられます）'); return result; }
  if (result === 'fail') { d.notice('自動貼り付けに失敗しました。クリップボードに残しています'); return result; }
  if (restoreAfterPaste(prev, text)) d.later(() => { copyPrivate(prev, d).catch(() => {}); }, RESTORE_DELAY_MS);
  return result;
}

// ---------------------------------------------------------------- エンジンのファイル検査（#32）
// statFn(path) は fs.statSync 相当（無ければ投げる）。戻り値:
//   'missing'     … 無い／読めない
//   'placeholder' … 大きさはあるが割り当てブロックが 0。OneDrive の「ファイル オンデマンド」
//                   のように、一覧には見えるが実体がこの PC に無い（存在確認は通ってしまう）
//   'truncated'   … minBytes 未満。ダウンロードが途中で切れた・0 バイト
//   'ok'
// blocks が取れない環境（undefined）では実体の有無を判定しない。誤って「実体が無い」と
// 断じると、正常な環境でエンジンが使えなくなり、その方が害が大きい。
function engineFileIssue(file, minBytes, statFn) {
  let st;
  try { st = statFn(file); } catch (_) { return 'missing'; }
  if (!st) return 'missing';
  const size = Number(st.size) || 0;
  // 空のファイルはどんな床でも壊れている（ダウンロードが始まる前に落ちた等）
  if (size === 0) return 'truncated';
  if (st.blocks === 0) return 'placeholder';
  if (size < minBytes) return 'truncated';
  return 'ok';
}

// 検査結果を、原因を名指しする一文にする。kind: 'exe' | 'model'、size は truncated のときの大きさ、
// file はそのファイルのパス、script は実行し直すスクリプト名。
//
// パスを必ず添える: 設定欄には2つ以上のパスが並んでいて、どれの話か分からないと利用者は動けない。
// ただし **パスは必ず文末に置く**。文の途中に置くと、後ろに続く文と地続きに読まれる。実機で
// 「…llama-server.exe。setup-*.ps1」をひと続きのコマンドと読み、PowerShell に貼り付けた人がいた。
// 「今のパス: 」の札を付けて最後に置けば、命令ではなく情報として読める。
// スクリプトは名指しする: `setup-*.ps1` は実在するファイル名ではなく、どれを実行するか分からない。
// 「再実行してください」だけでも足りない。スクリプトは自分の置き場所の下の local-engine\… に
// 作るので、設定欄が指している壊れたファイルは再実行しても変わらない。貼り直すまで言う。
function engineIssueMessage(issue, kind, size, file, script) {
  const entity = kind === 'exe' ? '実行ファイル' : 'モデル';
  const name = kind === 'exe' ? '実行ファイル' : 'モデルファイル';
  const at = file ? `。今のパス: ${file}` : '';
  const ps = script || 'setup-*.ps1';
  if (issue === 'placeholder') return `${entity}の実体がこの PC にありません（OneDrive などのプレースホルダの可能性）${at}`;
  if (issue === 'truncated') {
    const mb = (Number(size) || 0) / 1048576;
    return `${name}が壊れています（${mb >= 10 ? Math.round(mb) : mb.toFixed(1)}MB）。`
      + `${ps} を実行し直し、表示されたパスをこの欄に貼り直してください${at}`;
  }
  if (issue === 'missing') return `${name}が見つかりません${at}`;
  return '';
}

// パスの比較用の形。Windows 向けなので、区切り文字（\ と /）・大文字小文字・末尾の区切りの違いを無視する
const normPath = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// エンジンがアプリのインストール先（%LOCALAPPDATA%\Programs\NaTsu）の中に置かれていないか。
// インストーラは更新のたびに旧版を消してから入れ直すので、そこへ置いたエンジンは更新のたびに
// 消えうる（実機で llama-server.exe が 0 バイトになった）。appDir が分からないときは黙る。
function engineInAppDir(enginePath, appDir) {
  const p = normPath(enginePath);
  const d = normPath(appDir);
  if (!p || !d) return false;
  return p.startsWith(`${d}/`);
}
// 上に当てはまるエンジンが1つでもあれば、移動を促す一文。無ければ ''
function engineDirWarning(paths, appDir) {
  const hit = (paths || []).some((p) => engineInAppDir(p, appDir));
  if (!hit) return '';
  return 'エンジンがアプリのインストール先に置かれています。更新のたびに消えることがあります。'
    + '%LOCALAPPDATA%\\natsu-engine など別の場所へ移し、設定のパスを貼り直してください';
}

// ---------------------------------------------------------------- エンジンの起動の形（RF1・RF11）
// whisper-server は引数を ANSI（日本語の Windows では CP932）で受け、モデルのパスを UTF-8 として
// 読み直す（whisper.cpp v1.9.5 server.cpp → codecvt_utf8 の from_bytes）。CP932 の日本語は UTF-8 と
// して正しくないので、開けないのではなく例外で落ちる。VAD のモデルは最初の文字起こしで初めて読むので、
// /health は通り、文字起こしのたびに失敗する。そこでエンジンを cwd = exe のフォルダで起動し、
// 英数字以外を含むパスは、そこからの相対パス（..\models\… の英数字だけ）にして渡す。利用者名の部分は
// 引数に出ない。英数字だけのパスは今までどおりそのまま渡す（今動いている PC の挙動を変えない）。
// cwd を exe のフォルダにするのは両方のエンジン（RF11: ggml は cwd の ggml-*.dll も探して読む）。
// llama-server は引数を CommandLineToArgvW で読み直すので、相対にできなくてもそのまま渡す。
// p はテストで path.win32 を渡す（Linux でも Windows のパスの形で確かめる）。main は既定の path。
const ASCII = /^[\x20-\x7E]*$/;
const isAscii = (s) => ASCII.test(String(s ?? ''));
const ENGINE_PATH_FLAGS = {
  whisper: { '-m': '文字起こしのモデル', '--vad-model': 'VAD のモデル' },
  llama: { '-m': '要約のモデル' },
};
function engineSpawnPlan(exe, args, { whisper = false, p = path } = {}) {
  const cwd = p.dirname(exe);
  const flags = ENGINE_PATH_FLAGS[whisper ? 'whisper' : 'llama'];
  const out = [...(args || [])];
  let problem = '';
  for (let i = 0; i + 1 < out.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(flags, out[i])) continue;
    const at = i + 1;
    i = at;   // 値は旗として読まない
    let value = String(out[at] ?? '');
    // 手で打った相対のパスは、アプリの今のフォルダから絶対にする。engineCheck（fs.statSync）が見たのはそのファイルで、
    // cwd を exe のフォルダにしたまま渡すと、エンジンは別の場所を探す（cwd を変える前と同じファイルを開かせる）
    if (value && !p.isAbsolute(value)) out[at] = value = p.resolve(value);
    if (isAscii(value)) continue;
    const rel = p.relative(cwd, value);
    if (rel && isAscii(rel)) { out[at] = rel; continue; }
    // 相対にしても英数字以外が残る（別のドライブ・ファイル名が日本語）。whisper は落ちるので起動しない。
    // パスは文末に置く（engineIssueMessage と同じ。後ろの文と地続きに読ませない）
    if (whisper && !problem) {
      problem = `${flags[out[at - 1]]}の置き場所に日本語などの字が入っていると、文字起こしエンジンが読めません。`
        + `英数字だけの名前のフォルダに置き直して、詳細設定のパスを貼り直してください。今のパス: ${value}`;
    }
  }
  return { cwd, args: out, problem };
}

// ---------------------------------------------------------------- Visual C++ ランタイム（RF4）
// どちらのエンジンの zip にも Visual C++ ランタイムは入っていない（whisper は msvcp140・vcruntime140・
// vcruntime140_1・vcomp140 を、llama は前の3つを使う）。無いと「code 3221225781」とだけ出て止まる。
// whisper b5454 は MSVC 14.51 で作られ、14.40 未満では落ちる（MSVC STL 17.10 の constexpr mutex の変更。
// 公開の報告による）。DLL の版は、依存も PowerShell も使わずに PE の VS_FIXEDFILEINFO から読む。

// VS_FIXEDFILEINFO の印 0xFEEF04BD を探し、その後の dwFileVersionMS・dwFileVersionLS を読む。
// 印の次の dwStrucVersion は 1.x（0x0001xxxx）。たまたま同じ4バイトがコードにあっても、ここで外す。
// 読めなければ ''。
const VS_FIXEDFILEINFO_SIG = Buffer.from([0xBD, 0x04, 0xEF, 0xFE]);
function peFileVersion(buf) {
  if (!Buffer.isBuffer(buf)) return '';
  for (let i = buf.indexOf(VS_FIXEDFILEINFO_SIG); i >= 0 && i + 16 <= buf.length; i = buf.indexOf(VS_FIXEDFILEINFO_SIG, i + 1)) {
    if (buf.readUInt32LE(i + 4) >>> 16 !== 1) continue;
    const ms = buf.readUInt32LE(i + 8);
    const ls = buf.readUInt32LE(i + 12);
    return `${ms >>> 16}.${ms & 0xFFFF}.${ls >>> 16}.${ls & 0xFFFF}`;
  }
  return '';
}

const VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll'];
// 4つの DLL の版。exe のフォルダを先に、無ければ System32 を読む（Windows が DLL を探す順と同じ。
// 手で入れたエンジンが自分の DLL を持っていれば、そちらが使われる）。exe のフォルダにあれば、版が
// 読めなくても System32 には行かない（Windows もそちらを読むので、System32 の版では判断しない）。
// read(file) は Buffer か null（無い・読めない）。本番は「先頭の 4MB だけ読む」関数。
// p はテストで path.win32 を渡す（Linux でも Windows のパスの形で確かめる）。
function vcRuntimeVersions(exeDir, sysDir, read, p = path) {
  const out = {};
  for (const dll of VC_RUNTIME_DLLS) {
    let buf = exeDir ? read(p.join(exeDir, dll)) : null;
    if (!buf) buf = sysDir ? read(p.join(sysDir, dll)) : null;
    out[dll] = buf ? peFileVersion(buf) : '';
  }
  return out;
}

// 版の文字列を数の並びにして比べる（'14.44.35211.0' < '14.51.36247.0'）
const versionParts = (v) => String(v).split('.').map((n) => Number(n) || 0);
function compareVersion(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
const VC_RUNTIME_MIN = '14.40';    // これ未満は落ちる（起動しない理由）
const VC_RUNTIME_BUILT = '14.51';  // whisper b5454 を作った版。14.40〜14.50 は記録だけ
const VC_RUNTIME_URL = 'https://aka.ms/vc14/vc_redist.x64.exe';
// versions（vcRuntimeVersions の戻り）から、起動してよいかの判断の材料を作る。
//   level: 'missing'（1つでも無い）| 'old'（いちばん古い版が 14.40 未満）| 'warn'（14.40〜14.50。記録だけ）| 'ok'（14.51 以上）
//   min: 見たファイルのいちばん古い版（無いものがあれば ''）、message: missing・old のときの案内（ほかは ''）
//   versions: 見たファイルとその版（ログ用）
// whisper のときは vcomp140.dll も見る（whisper の ggml-base.dll と ggml-cpu-*.dll が使う）。
function vcRuntimeIssue(versions, { whisper = false } = {}) {
  const names = whisper ? VC_RUNTIME_DLLS : VC_RUNTIME_DLLS.filter((d) => d !== 'vcomp140.dll');
  const seen = {};
  for (const d of names) seen[d] = String((versions || {})[d] || '');
  const vals = Object.values(seen);
  const min = vals.some((v) => !v) ? '' : vals.reduce((a, b) => (compareVersion(a, b) <= 0 ? a : b));
  let level = 'ok';
  if (!min) level = 'missing';
  else if (compareVersion(min, VC_RUNTIME_MIN) < 0) level = 'old';
  else if (compareVersion(min, VC_RUNTIME_BUILT) < 0) level = 'warn';
  const message = level === 'missing' || level === 'old'
    ? 'エンジンに必要な部品（Microsoft Visual C++ ランタイム）が、この PC に入っていないか古いため、起動できません'
      + `（今の版: ${min || 'なし'}、${VC_RUNTIME_MIN} 以上が必要）。情報システムの担当に ${VC_RUNTIME_URL} のインストールを頼んでください（管理者の権限が要ります）。`
    : '';
  return { level, min, message, versions: seen };
}

// 起動を止めるかどうか。止めるのは取り込んだ組（managed: true）の missing・old だけ（Task 13 の managedIssue）。
// 手で設定した組は、無くても古くても記録だけ（手で入れたエンジンは今動いている。止めない）。
function runtimeGate(issue, { managed = false } = {}) {
  const level = issue && issue.level;
  if (level === 'missing' || level === 'old') return managed ? 'block' : 'warn';
  if (level === 'warn') return 'warn';
  return 'ok';
}

// ---------------------------------------------------------------- エンジンが落ちた・起動できないときの案内（RF3・RF4）
// Windows の終了コード（NTSTATUS）を、利用者が何をすればよいかの文にする。当てはまらなければ ''。
// Node は 3221225781 のように符号なしで渡すが、負の形（-1073741515）でも同じに読む。
// ms は起動からの時間。0xC0000005（アクセス違反）は、起動の直後（10 秒以内）だけランタイムの古さを疑う。
const STATUS_DLL_NOT_FOUND = 0xC0000135;        // 3221225781
const STATUS_ENTRYPOINT_NOT_FOUND = 0xC0000139; // 3221225785
const STATUS_ACCESS_VIOLATION = 0xC0000005;     // 3221225477
const STATUS_ILLEGAL_INSTRUCTION = 0xC000001D;  // 3221225501
const STATUS_STACK_BUFFER_OVERRUN = 0xC0000409; // 3221226505
function engineExitHint(code, ms) {
  if (typeof code !== 'number' || !Number.isFinite(code)) return '';
  const c = code >>> 0;
  if (c === STATUS_DLL_NOT_FOUND) return '必要な部品（Microsoft Visual C++ ランタイム）か、エンジンのファイルが見つからないため起動できませんでした。';
  if (c === STATUS_ENTRYPOINT_NOT_FOUND || (c === STATUS_ACCESS_VIOLATION && Number(ms) <= 10000)) return 'Microsoft Visual C++ ランタイムが古い可能性があります。';
  if (c === STATUS_ILLEGAL_INSTRUCTION) return 'この PC の CPU では、このエンジンを動かせません。';
  if (c === STATUS_STACK_BUFFER_OVERRUN) return 'エンジンが異常終了しました。';
  return '';
}
// spawn の失敗（e.code）を案内の文にする。当てはまらなければ ''。Windows の元のエラー番号は libuv の
// 対応表で消えるので、実行を止められたときは EPERM・EACCES・UNKNOWN のどれかで来る。
// することを1つ書いてから、パスを文末に置く（engineIssueMessage と同じ。後ろの文と地続きに読ませない）。
// 「次のファイル」は文末のパスを指す。パスが無いときは「エンジンのファイル」と書く。
function spawnErrorHint(errCode, file) {
  const at = file ? `今のパス: ${file}` : '';
  const which = file ? '次のファイル' : 'エンジンのファイル';
  if (errCode === 'EPERM' || errCode === 'EACCES' || errCode === 'UNKNOWN') {
    return 'Windows のセキュリティ（Defender など）か会社の制限が、エンジンの起動を止めた可能性があります。'
      + `情報システムの担当に、${which}の許可を頼んでください。${at}`;
  }
  if (errCode === 'ENOENT') {
    return 'エンジンのファイルが消えています。ウイルス対策が消した可能性があります。'
      + `［Windows セキュリティ］→［ウイルスと脅威の防止］→［保護の履歴］から${which}を復元するか、情報システムの担当に頼んでください。${at}`;
  }
  return '';
}

// ---------------------------------------------------------------- 速さの記録（第0b回 Task 16）
// 利用者の「文字起こしと要約に時間がかかる」に対して、まず実際の速さを engine.log に1行で残す。
//   whisper: t = { audioMs, procMs }（区間の音声の長さと、文字起こしにかかった時間）
//   llama:   t = llama-server の応答の timings（prompt_n・prompt_ms・predicted_n・predicted_ms）
// どれかが数でない（古い llama-server で timings が無いなど）・時間が 0 以下なら ''（何も残さない）。
// トークン/秒は 100 以上なら整数、それ未満は小数1桁（141 トークン/秒・13.3 トークン/秒）。
function speedLine(kind, t) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const sec = (ms) => (ms / 1000).toFixed(1);
  const rate = (n, ms) => { const r = n / (ms / 1000); return r >= 100 ? String(Math.round(r)) : r.toFixed(1); };
  if (!t || typeof t !== 'object') return '';
  if (kind === 'whisper') {
    const { audioMs, procMs } = t;
    if (!num(audioMs) || !num(procMs) || audioMs <= 0 || procMs < 0) return '';
    return `文字起こしの速さ: 音声 ${Math.round(audioMs / 1000)} 秒・処理 ${Math.round(procMs / 1000)} 秒（${(procMs / audioMs).toFixed(2)} 倍）`;
  }
  if (kind === 'llama') {
    const { prompt_n: pn, prompt_ms: pm, predicted_n: gn, predicted_ms: gm } = t;
    if (![pn, pm, gn, gm].every(num) || pn < 0 || gn < 0 || pm <= 0 || gm <= 0) return '';
    return `要約の速さ: 読み ${pn} トークン ${sec(pm)} 秒（${rate(pn, pm)} トークン/秒）`
      + `・書き ${gn} トークン ${sec(gm)} 秒（${rate(gn, gm)} トークン/秒）`;
  }
  return '';
}

// ---------------------------------------------------------------- ポートの衝突（#28/#31）
// 塞がっているポートで起動すると、エンジンはモデルを読み終えてから bind に失敗して落ちる。
// それまで「起動中」に見えるので、起動前に見て、塞がっていればこの文で止める。
function portInUseError(port) {
  return `ポート ${port} は他のプロセスが使用中です。設定でポートを変えるか、そのプロセスを終了してください`;
}

// ---------------------------------------------------------------- ファイルの選択で開く場所（第0c回 EL3）
// Electron 43 から defaultPath が無いと「ダウンロード」で開き、OS が前のフォルダを覚えなくなる。
// 画面の5つの［選ぶ］ボタンのキー（ENGINE_SETTING_KEYS とは別に持つ）。画面からはパスを受け取らず、
// このキーの名前だけを受け取る。
const PICK_KEYS = ['localServerExe', 'localModelPath', 'vadModelPath', 'sumServerExe', 'sumModelPath'];
// 今のファイルのフォルダ → この起動で前に選んだフォルダ → エンジンの置き場所の順に、あるものを返す。
// どれも無ければ undefined（Electron の既定に任せる）。知らないキーでは設定の値を読まない。
// 相対パスやファイル名だけの値は、dirname が '.'（作業フォルダ＝入れた場所）になるので候補にしない。
function pickDefaultPath(key, settings, { lastDir = '', engineRoot = '', isDir = () => false, p = path } = {}) {
  const cands = [];
  if (PICK_KEYS.includes(key)) {
    const cur = settings && typeof settings[key] === 'string' ? settings[key] : '';
    if (cur) cands.push(p.dirname(cur));
  }
  cands.push(lastDir, engineRoot);
  for (const d of cands) if (typeof d === 'string' && d && p.isAbsolute(d) && isDir(d)) return d;
  return undefined;
}

// ---------------------------------------------------------------- 記録中のエンジン設定（#57）
// これらを変えるとエンジンの再起動（engineSignature）や区間の切り方が変わる。記録中に
// 再起動すると、文字起こし中の区間が失われる。記録中は前の値に留め、他の設定は保存する。
const ENGINE_SETTING_LABELS = {
  language: '言語', localThreads: '文字起こしのスレッド数', sumThreads: '要約のスレッド数',
  useVad: 'VAD', suppressNst: '非発話トークンの抑制',
  localServerExe: '文字起こしエンジンの実行ファイル', localModelPath: '文字起こしのモデル', vadModelPath: 'VAD のモデル',
  sumServerExe: '要約エンジンの実行ファイル', sumModelPath: '要約のモデル',
  localPort: '文字起こしのポート', sumPort: '要約のポート', segmentSec: '区間の長さ',
  sumCtx: '要約の文脈長',
};
const ENGINE_SETTING_KEYS = Object.keys(ENGINE_SETTING_LABELS);
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

//   prev: いまの設定、next: 保存しようとする設定（正規化済み）、recording: 議事録を記録中か
// 戻り値 { settings: 保存する設定, kept: 留めたキー, warning: 画面に出す一文（無ければ ''） }
// 入力は書き換えない。
function guardEngineSettings(prev, next, recording) {
  if (!recording) return { settings: next, kept: [], warning: '' };
  const settings = { ...next };
  const kept = [];
  for (const k of ENGINE_SETTING_KEYS) {
    if (sameValue(prev[k], next[k])) continue;
    settings[k] = prev[k];
    kept.push(k);
  }
  const warning = kept.length
    ? `記録中のため、エンジンに関わる設定（${kept.map((k) => ENGINE_SETTING_LABELS[k]).join('・')}）は変更できません。記録を終えてから変更してください`
    : '';
  return { settings, kept, warning };
}

// 画面が送った値（sent）と保存された値（saved）が違うキーだけを返す。画面はこれを欄に
// 戻す（ホットキーの登録失敗・記録中に留めたエンジン設定・正規化で丸められた値）。
// 欄に古い値が残ると、以後の無関係な保存のたびに同じ失敗と警告を繰り返す。
function keptDifferent(sent, saved) {
  const out = {};
  if (!sent || typeof sent !== 'object') return out;
  for (const k of Object.keys(sent)) {
    // 設定に無いキーは返さない（constructor などで Object の持ち物を拾うと、IPC が写せずに invoke が失敗する）
    if (!Object.prototype.hasOwnProperty.call(saved, k)) continue;
    if (!sameValue(sent[k], saved[k])) out[k] = saved[k];
  }
  return out;
}

// ---------------------------------------------------------------- 終了の確認（#52）
// recording: 議事録を記録中、summarizing: 要約を作成中。どちらでもなければ null。
// 要約は数分かかり、途中で終了すると結果は残らない。記録中と同じく一度は確認を挟む。
function closeConfirm(recording, summarizing) {
  if (!recording && !summarizing) return null;
  const sumLine = '要約を作成中です。終了すると要約は失われます';
  if (recording) {
    let detail = '終了すると録音が止まります。ここまでの文字起こしは、次回起動時に復旧できます。';
    if (summarizing) detail += `\n${sumLine}。`;
    return { message: '議事録を記録中です', detail };
  }
  return { message: sumLine, detail: '「要約を生成」で後から作り直せます。' };
}

// ---------------------------------------------------------------- 分割要約の打ち切り（#16）
// extract(text) は { text, truncated } を返す（要点の抽出）。長さの上限で切れたら、その塊を
// 半分に割って両方をやり直す（一度だけ）。切れたままだと中盤の議題が黙って欠ける。
// 半分でも切れたら本文は残して truncated を立てる（呼び出し側が注記し、パートを名指しする）。
async function extractNotes(extract, text) {
  const first = await extract(text);
  if (!first.truncated) return { text: first.text, truncated: false, retried: false };
  const half = Math.ceil(text.length / 2);
  const a = await extract(text.slice(0, half));
  const b = await extract(text.slice(half));
  return { text: `${a.text}\n${b.text}`, truncated: Boolean(a.truncated || b.truncated), retried: true };
}

// ---------------------------------------------------------------- 要約の文脈長（#41）
// 推定トークン数。UTF-8 のバイト数 ÷ 2.5 の切り上げ。多くの日本語対応モデルのトークナイザでは
// 日本語 1 文字（3 バイト）が 1〜2 トークン、英数字は 4 文字（4 バイト）で 1 トークン程度で、
// どちらも 1 トークン ≒ 2.5〜4 バイト。2.5 で割るのは実際より多めに見積もるためで、外すなら
// 「収まると思ったら溢れた」側には外さない（溢れると llama-server がプロンプトを黙って切る）。
function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 2.5);
}

// 要点メモ（分割要約の各パート）を、前から順に「推定トークンの合計が予算に収まる束」に分ける。
// 統合プロンプトが文脈長に収まらないとき、各束をもう一段要約してから統合する（2 段）。
// 順序は時系列のまま。1 件で予算を超える要点メモは単独の束（それ以上は割らない。もう一段の
// 要約で NOTE_MAX_TOKENS 以下に縮む）。束の間の区切り（空行）は数えない（束あたり数トークンで、
// 呼び出し側の余白の内）。estimate は省けば estimateTokens。入力は書き換えない。
function foldNotes(notes, budgetTokens, estimate) {
  const list = (Array.isArray(notes) ? notes : []).map((n) => String(n ?? ''));
  const est = typeof estimate === 'function' ? estimate : estimateTokens;
  const budget = Number(budgetTokens) > 0 ? Number(budgetTokens) : 1;
  const out = [];
  let cur = [];
  let used = 0;
  for (const n of list) {
    const t = est(n);
    if (cur.length && used + t > budget) { out.push(cur); cur = []; used = 0; }
    cur.push(n);
    used += t;
  }
  if (cur.length) out.push(cur);
  return out;
}

// summaryError に書く一文。parts: 半分にしても切れたパート番号（1 始まり）、
// finalTruncated: 最終の統合が切れたか。どちらも無ければ ''。
// パートが切れた＝中盤の議題が欠けうる、最終が切れた＝末尾の議題が欠けうる、で文を分ける。
function truncationMessage(parts, finalTruncated) {
  const ps = (Array.isArray(parts) ? parts : []).filter((n) => Number.isInteger(n) && n > 0);
  const out = [];
  if (ps.length) out.push(`要約の材料（パート ${ps.join('・')}）が長さの上限で切れました。中盤の議題が欠けていないか確認してください。`);
  if (finalTruncated) out.push('要約が長さの上限で打ち切られた可能性があります。末尾の議題が欠けていないか確認してください。');
  return out.join('');
}

// ---------------------------------------------------------------- 初期プロンプトの予算（#23）
// whisper.cpp の初期プロンプトは n_text_ctx/2（既定 224 トークン）で切られる。どちら側から
// 切られるかはビルドで変わりうるので、そもそも溢れさせない。
// 予算の単位は UTF-8 のバイト数。日本語は 1 文字 ≒ 1 トークン ≒ 3 バイト、英数字は数文字で
// 1 トークン ≒ 3〜4 バイトなので、文字数より「バイト数 ÷ 3」の方が両方の文字種でトークン数に
// 近い（文字数で数えると英数字の語が実際の 3 倍に見積もられ、辞書が不当に切られる）。
// 上限は PROMPT_MAX_CHARS × 3 バイト（日本語だけなら従来どおり 200 文字）。
// 優先順は 文例 → 辞書（先頭行から）→ 既定語彙 → 直前の発言の尻尾。予算を超えたら後ろから
// 落とす（尻尾は先頭から削る・既定語彙、辞書の順に末尾の語から外す）。文例だけは落とさない。
// 以前は辞書を無制限に渡していたが、溢れた分は黙って効かなくなっていた。切るなら切ったと
// 伝える（kept/total を prompt:info で画面へ返す）。
//   戻り値 { prompt, kept: 辞書のうち収まった語数, total: 辞書の語数, over: kept < total }
function buildPromptParts({ ja, dictionary, useBuiltinTerms, tail, limitBytes, builtinTerms, sample }) {
  const uniq = (list) => {
    const out = [];
    for (const raw of (Array.isArray(list) ? list : [])) {
      const w = String(raw ?? '').trim();
      if (w && !out.includes(w)) out.push(w);
    }
    return out;
  };
  const words = uniq(dictionary);
  // 既定語彙は日本語のときだけ。英語や自動判定で日本語の語を渡すと、その語が出力に漏れ、
  // 言語の推定も日本語へ引っぱられる。辞書と重なる語は足さない。
  const builtin = (ja && useBuiltinTerms !== false) ? uniq(builtinTerms).filter((w) => !words.includes(w)) : [];
  const head = ja ? String(sample || '') : '';
  const limit = Number(limitBytes) > 0 ? Number(limitBytes) : Infinity;
  let tailChars = Array.from(String(tail || ''));   // サロゲートペアを割らないよう文字単位
  let nWords = words.length;
  let nBuiltin = builtin.length;
  const assemble = () => {
    const parts = [];
    if (head) parts.push(head);
    const terms = words.slice(0, nWords).concat(builtin.slice(0, nBuiltin));
    if (terms.length) parts.push(`${terms.join('、')}。`);
    if (tailChars.length) parts.push(tailChars.join(''));
    return parts.join(' ');
  };
  let prompt = assemble();
  while (Buffer.byteLength(prompt, 'utf8') > limit) {
    if (tailChars.length) tailChars = tailChars.slice(1);
    else if (nBuiltin > 0) nBuiltin--;
    else if (nWords > 0) nWords--;
    else break;   // 文例だけになったらそれ以上は落とさない
    prompt = assemble();
  }
  return { prompt, kept: nWords, total: words.length, over: nWords < words.length };
}

// ---------------------------------------------------------------- 音声の退避と「文字起こし待ち」の区間（#8/#42）
// 区間は音声が届いた時点で { id, atMs, durationMs, pending: true, wav, text: '' } として
// meeting.segments と draft.json に控え、文字起こしが終わったら同じ要素を結果で置き換える。
// 以前は文字起こしが終わるまで draft に載らず、その間にアプリが落ちると音声ごと消えていた。

// 画面へ返す形。wav（ファイルのパス）は外す。画面に出す理由が無く、状態をそのまま
// ログや不具合報告に貼られるとパスが漏れる。待ちの区間は残す（進捗が見える）
function publicSegments(segments) {
  return (segments || []).map(({ wav, ...s }) => s);
}
// ページに保存する形。待ちの区間（本文が無い）は入れない。wav も外す
function settledSegments(segments) {
  return publicSegments((segments || []).filter((s) => s && !s.pending));
}
// 文字起こし待ちの区間の長さの合計（残り時間の見積もりの材料）
function pendingDurationMs(segments) {
  let sum = 0;
  for (const s of (segments || [])) if (s && s.pending) sum += Number(s.durationMs) || 0;
  return sum;
}
// draft.json の区間を復旧ページ用に直す。exists(path) は fs.existsSync 相当。
// pending は失敗扱いにして本文を「復旧中」にし、wav が残っていれば todo に載せる（起動後に
// 文字起こしして store.updateSegment で差し替える）。wav が無ければ失敗として残す。
// wav（パス）はページに載せない。入力は書き換えない。
function recoverSegments(segments, exists) {
  const out = [];
  const todo = [];
  for (const raw of (segments || [])) {
    if (!raw || typeof raw !== 'object') continue;
    const { wav, pending, ...s } = raw;
    if (pending) {
      s.failed = true;
      if (wav && exists(wav)) {
        s.text = '（復旧中: 文字起こし待ち）';
        todo.push({ id: s.id, wav, durationMs: Number(s.durationMs) || 0 });
      } else {
        s.text = '（この区間の認識に失敗: 音声が残っていません）';
      }
    } else if (s.failed && wav && exists(wav)) {
      // 認識に失敗した区間（wav は残してある）もやり直す。失敗の文は残し、成功したら差し替わる
      todo.push({ id: s.id, wav, durationMs: Number(s.durationMs) || 0 });
    }
    out.push(s);
  }
  return { segments: out, todo };
}
// 退避フォルダのうち 7 日より古いもの（復旧されずに残った孤児）。フォルダ名は開始時刻（ms）
// なのでそれで判断し、数字でなければ更新時刻で判断する。ちょうど 7 日は残す（境目で今日の
// 分を消さない）。entries: [{ name, mtimeMs }]、戻り値は消してよい name の配列。
// ---------------------------------------------------------------- 背圧: 区間の長さ（#42）
// 文字起こしが録音に追いつかないとき（待ちが 3 区間を超える）は、次の区間の長さを倍にして
// 送る回数を減らす（75→150→300 秒。上限 300 秒）。追いついたら（待ち 1 以下）設定の長さへ
// 戻す。短い区間を積み上げ続けると、待ちがどこまでも伸びて終了後の待ち時間になる。
//   pending: いまの待ち件数、currentMs: いまの区間の長さ、baseMs: 設定の長さ、
//   delta: 待ちが増えた(+1)のか減った(-1)のか。減った側では倍にしない（5→4 で倍にすると
//   一気に上限へ張り付く）。2〜3 のあいだは変えない（行ったり来たりで何度も送らない）。
const SEGMENT_MS_CAP = 300000;
function nextSegmentMs(pending, currentMs, baseMs, delta) {
  const base = Math.max(1000, Number(baseMs) || 75000);
  const cur = Number(currentMs) > 0 ? Number(currentMs) : base;
  if (pending <= 1) return base;
  if (pending > 3 && delta > 0) return Math.min(SEGMENT_MS_CAP, cur * 2);
  return cur;
}

// ---------------------------------------------------------------- 残り時間の見積もり（#42）
// 区間ごとの「処理時間 ÷ 音声の長さ」を指数移動平均（EMA）で持ち、残りの待ち（文字起こし
// 待ちの区間の長さの合計）に掛けて秒で返す。材料が無いうちは null（0 を出すと「もう終わる」
// に見える）。進行中の区間で既に経過した分は引く。成功した区間だけで学習する（失敗は時間の
// 目安にならない）。アプリの起動中は持ち越す（次の会議の最初の区間から見積もれる）。
// 比は経路（'local'・'cloud'。省けば 'local'）ごとに分けて持つ（第1c回: クラウドの速さを手元の whisper の見積もりに混ぜない）。
class EtaTracker {
  constructor(alpha) { this.alpha = alpha || 0.3; this.ratios = new Map(); }
  record(procMs, durationMs, route = 'local') {
    if (!(durationMs > 0) || !(procMs >= 0)) return;
    const r = procMs / durationMs;
    const prev = this.ratios.has(route) ? this.ratios.get(route) : null;
    this.ratios.set(route, prev === null ? r : prev + this.alpha * (r - prev));
  }
  etaSec(remainingMs, elapsedMs, route = 'local') {
    const ratio = this.ratios.has(route) ? this.ratios.get(route) : null;
    if (ratio === null) return null;
    const remain = Math.max(0, Number(remainingMs) || 0);
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    // ms で丸めてから秒に切り上げる（浮動小数の誤差で 39.0000…01 秒が 40 秒にならないように）
    return Math.max(0, Math.ceil(Math.round(ratio * remain - elapsed) / 1000));
  }
}

// ---------------------------------------------------------------- 打ち切り（#42）
// 文字起こし待ちの区間を全部「打ち切り」にする（meeting:skipPending）。失敗扱いにして本文を
// 「（文字起こしを打ち切り）」に置き、pending/wav を外す（id/atMs はそのまま）。黙って消さず
// 失敗の行として残すのは、何が欠けたかが議事録から分かるようにするため。
// 戻り値は { count: 打ち切った数, wavs: 消すべき wav のパス }。配列の要素は書き換える。
function skipPendingSegments(segments) {
  const wavs = [];
  let count = 0;
  for (const s of (segments || [])) {
    if (!s || !s.pending) continue;
    count++;
    if (s.wav) wavs.push(s.wav);
    delete s.pending; delete s.wav;
    s.text = '（文字起こしを打ち切り）';
    s.failed = true;
  }
  return { count, wavs };
}

// ---------------------------------------------------------------- 使われないエンジンの停止（#58）
// 要約エンジンは起動すると約 3GB を掴んだまま降りない。使われないまま idleMin 分たったら止め、
// 次に使うとき（ensureEngineReady）に起動し直す。engines は main.js のエンジン { proc, lastUsed,
// readyPromise }（proc: 起動中のプロセス、lastUsed: 起動時と推論のたびの時刻、readyPromise:
// 準備完了を待っている人がいる印）。戻り値は止めてよいエンジンの配列。
//   - busy（記録・文字起こし・要約・復旧のどれか）なら何も止めない
//   - idleMin が 0 以下・数でないなら止めない（0 = 止めない）
//   - 起動していない／待っている人がいる／使った時刻が無い エンジンは止めない
function idleEnginesToStop(engines, now, idleMin, busy) {
  const min = Number(idleMin);
  if (busy || !(min > 0)) return [];
  const limit = min * 60000;
  return (engines || []).filter((e) => e && e.proc && !e.readyPromise
    && Number.isFinite(e.lastUsed) && now - e.lastUsed >= limit);
}

const SEGBUF_MAX_AGE_MS = 7 * 86400000;
function staleSegbufDirs(entries, nowMs, maxAgeMs = SEGBUF_MAX_AGE_MS) {
  const out = [];
  for (const e of (entries || [])) {
    if (!e || typeof e.name !== 'string') continue;
    const byName = /^\d{10,}$/.test(e.name) ? Number(e.name) : NaN;
    const at = Number.isFinite(byName) ? byName : (Number(e.mtimeMs) || 0);
    if (nowMs - at > maxAgeMs) out.push(e.name);
  }
  return out;
}

// 無音の WAV（16kHz・モノラル・16bit）。起動テストで /inference に実際に送って、答えの形を確かめる
function silentWav(sec) {
  const n = Math.max(0, Math.round(16000 * (Number(sec) || 0)));
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  return b;
}

// WAV（16bit PCM）の音の大きさ（RMS、dBFS）。0 が最大で、無音は -Infinity。data の塊が見つからなければ -Infinity。
// 文字起こしのやり直しを、ほぼ無音の音声で省くのに使う（main.transcribeLocal）
function wavLevelDbfs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return -Infinity;
  let off = 12;
  let bits = 16;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) bits = buf.readUInt16LE(body + 14);
    if (id === 'data') {
      if (bits !== 16) return -Infinity;
      const end = Math.min(buf.length, body + size) & ~1;
      const n = (end - body) / 2;
      if (n <= 0) return -Infinity;
      let sum = 0;
      for (let i = body; i < end; i += 2) { const v = buf.readInt16LE(i); sum += v * v; }
      const rms = Math.sqrt(sum / n) / 32768;
      return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    }
    off = body + size + (size & 1);
  }
  return -Infinity;
}

// 要約を保存するときの会議タイプ。saved: いまディスクにあるページ、used: 要約を始めたときのページ
// （meetingType は要約に使った種類）。要約の途中で利用者が種類を手で選んでいたら（saved.typeAuto === false）、
// その選択を残す。changed: 残した種類が要約に使った種類と違う（作り直しを勧める）
function mergeSummaryType(saved, used) {
  if (saved && saved.typeAuto === false && saved.meetingType) {
    return { meetingType: saved.meetingType, typeAuto: false, changed: saved.meetingType !== used.meetingType };
  }
  return { meetingType: used.meetingType, typeAuto: used.typeAuto, changed: false };
}

// Claude Code（claude -p）の標準入力に渡す文（第1c回 OL5・F9）。手元の LLM の1回で要約する頼みの文（main.js の
// generateMinutes）と1文字も違わない形にする（片方だけ直すと、要約タイプの見出しが道によって変わる）。
// memoText は呼ぶ側が trim し MEMO_MAX で切ったもの、template は minutesTemplate(type)（dropTemplateEcho に渡すのと同じ文字）。
// 同じことは stage1c.lib.test.js が main.js の文字から確かめる
function buildClaudeInput({ memoText, plain, template }) {
  const memo = String(memoText || '');
  const memoBlock = memo ? `【会議メモ・アジェンダ（要約のヒント）】\n${memo}\n\n` : '';
  return `${memoBlock}【会議の文字起こし】\n${plain}\n\n上記から、次の構成のMarkdown議事録を作成してください。見出しはこの通りに使い、本文だけを出力してください。\n\n${template}`;
}

// 担当・期限の裏付けに使うメモ。要約タイプを選んだときに入るアジェンダの雛形（types[].agenda）の行は除く。
// 雛形は利用者の発言でもメモでもなく、「次回までのアクション」などが作り話の期限を通してしまう
function memoEvidence(memo, types) {
  const preset = new Set((types || []).flatMap((t) => String(t.agenda || '').split('\n').map((l) => l.trim()).filter(Boolean)));
  return String(memo || '').split('\n').filter((l) => !preset.has(l.trim())).join('\n');
}

// ---------------------------------------------------------------- 取り込んだエンジンの切り替え（第0b回 Task 14）
// main は取り込みの係（engine-install.makeRunner）が組をそろえるたびに、候補（engine-install.managedCandidates の
// { whisper, sum }。Cand は { current, shas, dir, exe, model, vad?, … }）を照らしてから切り替える。ここはその判断だけ
const MANAGED_GROUPS = ['whisper', 'sum'];
const shasKey = (c) => (c && Array.isArray(c.shas) ? c.shas.map((s) => String(s).toLowerCase()).join(',') : '');
const sameSha256 = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// 2 つの組の並びが、SHA-256 の並びで同じか（ファイルを読まない安い比べ）。組が無いどうしは同じ。groups で見る組を絞れる
function sameShas(a, b, groups = MANAGED_GROUPS) {
  return groups.every((g) => shasKey(a && a[g]) === shasKey(b && b[g]));
}

// 照らしの結果（engine-install.verifyCandidates の { whisper, sum, bad }）に、前の組を使い続ける組を足す（RF13）
// → { whisper, sum, bad, kept: [組の名前] }。新しい候補（cands[g]）が照らしで合わず、照らし済みの前の組（prev[g]）が
// 別の並びなら、前の組を使い続ける（新しい組は取り直す）。同じ並びの組（触られた・取り直した組）・前の組が無い組・
// 候補が無くなった組は、照らしの結果のまま（合わなければ null。RF3）
function keepPrevious(cands, prev, checked) {
  const out = { whisper: null, sum: null, bad: (checked && Array.isArray(checked.bad)) ? checked.bad : [], kept: [] };
  for (const g of MANAGED_GROUPS) {
    if (checked && checked[g]) out[g] = checked[g];
    else if (cands && cands[g] && prev && prev[g] && !sameShas(cands, prev, [g])) { out[g] = prev[g]; out.kept.push(g); }
  }
  return out;
}

// 1 つの候補（Cand か null）の SHA-256 の並びと、exe・DLL・モデル・VAD の大きさと更新時刻（ファイルは読まない）→ 文字列。
// 照らした後に取り直されたか触られたかを、読まずに見分ける（照らしで合わなかった組を、変わるまで照らし直さない）。
// 無いファイルも印にする。statFn は fs.statSync の形
function candStamp(c, statFn) {
  if (!c) return '-';
  const files = [...(c.checkFiles || []).map((f) => f.file), ...(c.models || []).map((m) => m.file)];
  return [shasKey(c), ...files.map((f) => {
    try { const st = statFn(f); return `${f}|${st.size}|${st.mtimeMs}`; } catch (_) { return `${f}|-`; }
  })].join('\n');
}

// 照らしで合わなかった項目の id（ピンの id。係の start({ repair }) に渡す）を、ピンの順で。groups は取り直す組。
//  bad の file が候補のモデルなら role 'model'、VAD なら role 'vad'、ほか（exe と DLL）はその組の zip の項目。
//  今のピンに無い項目（前の組だけのもの）は係が取れないので入れない。どのファイルか分からない組（照らしが例外で
//  終わった）は、その組の今のピンの項目を全部（係が照らし直して、違うものだけ取る）
function repairIdsOf(manifest, cands, bad, groups) {
  const ids = new Set();
  for (const g of groups || []) {
    const c = cands && cands[g];
    if (!c) continue;
    const pinned = manifest.items.filter((i) => i.group === g && (c.shas || []).some((s) => sameSha256(s, i.sha256)));
    const mine = (bad || []).filter((b) => b && b.group === g);
    if (!mine.length) { for (const i of pinned) ids.add(i.id); continue; }
    for (const b of mine) {
      const role = b.file === c.model ? 'model' : (c.vad && b.file === c.vad ? 'vad' : null);
      const it = pinned.find((i) => (role ? i.kind !== 'zip' && i.role === role : i.kind === 'zip'));
      if (it) ids.add(it.id);
    }
  }
  return manifest.items.filter((i) => ids.has(i.id)).map((i) => i.id);
}

// p が、使っている組（Cand の並び）のフォルダの中か、そのファイルか、それらを中に持つフォルダか（片付けで消さない。RF8）。
// Windows は大文字と小文字を区別しないので小文字で比べる（ほかの OS では、消さない側に倒れるだけ）。pathMod は path か path.win32
function pathUsedBy(p, cands, pathMod = path) {
  if (!p) return false;
  const norm = (x) => pathMod.resolve(String(x)).toLowerCase();
  const under = (a, b) => a === b || a.startsWith(b.endsWith(pathMod.sep) ? b : b + pathMod.sep);
  const t = norm(p);
  return (cands || []).some((c) => c && [c.dir, c.exe, c.model, c.vad].filter(Boolean).some((f) => {
    const u = norm(f);
    return under(t, u) || under(u, t);
  }));
}

// 取り込み中の「あと約 N 分」（未設定の文に足す）。取り込みの写し s（engine-install.statusOf の形）の、組の残りのバイトと
// 今の速さから、分（切り上げ・1 分から）。速さがまだ分からない（始めたばかり・待っている・記録中で止めている）か、
// 組の残りが 0 なら null（分は出さない）
function fetchMinutesLeft(s, group) {
  const items = s && Array.isArray(s.items) ? s.items.filter((i) => i && i.group === group) : [];
  const left = items.reduce((a, i) => a + Math.max(0, (Number(i.size) || 0) - (Number(i.done) || 0)), 0);
  const bps = Number(s && s.bytesPerSec);
  if (!left || !(bps > 0)) return null;
  return Math.max(1, Math.ceil(left / bps / 60));
}

// ---------------------------------------------------------------- main の外向きの通信（RF2）
// Node の fetch は Windows のプロキシ・PAC・証明書のストアを使わない。会社のプロキシと SSL の
// 検査の下では通らないので、外への通信は Electron の net（net.request／net.fetch）で行う。
// main のグローバル fetch は、127.0.0.1 のエンジンへの呼び出しだけに使う（main.js が起動の最初に包む）。
function isLoopbackUrl(u) {
  let p;
  try { p = new URL(u); } catch { return false; }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return false;
  return p.hostname === '127.0.0.1' || p.hostname === 'localhost' || p.hostname === '[::1]';
}
// 読めない URL（ポートが 99999 など）は、そのまま元の fetch に渡す。元の fetch が TypeError
// （Failed to parse URL …）を投げ、ensureEngineReady の「接続先（ポート設定）が不正です」が今までどおり働く
function loopbackOnlyFetch(f) {
  return async (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || String(input);
    try { new URL(u); } catch { return f(input, init); }
    if (!isLoopbackUrl(u)) throw new Error(`外への通信は Electron の net を使ってください（${u}）`);
    return f(input, init);
  };
}

// ---------------------------------------------------------------- 口述の履歴（第1a回 JS5・JS6）
// 口述した文を履歴の頭に足し、件数の上限で切り、保存 → 画面へ → 貼る（今の順のまま）。
// 履歴を保存できなくても（save が { ok: false } を返しても投げても）、口述した文字は必ず貼る
// （履歴は控えで、利用者が今欲しいのは貼り付け）。max が 0〜10000 の整数でなければ 500
// （手で書いた -1 や 1.5 で history.length に入れて RangeError にし、貼り付けまで止めない）。
// history は書き換える（main の履歴そのもの）。→ { saved: 保存できたか }
const HISTORY_MAX_DEFAULT = 500;
async function recordDictation({ history, entry, max, save, notify, deliver }) {
  history.unshift(entry);
  const limit = Number.isInteger(max) && max >= 0 && max <= 10000 ? max : HISTORY_MAX_DEFAULT;
  if (history.length > limit) history.length = limit;
  let saved = false;
  try {
    const r = save();
    saved = Boolean(r && r.ok === true);
  } catch (_) { saved = false; }
  try { notify(history); } catch (_) { /* 画面へ送れなくても貼る */ }
  await deliver(entry.text);
  return { saved };
}

// 読めなかった history.json を読み直せたとき（第1a回 Task 2-3。RF22）: 読めない間の履歴（新しい順）を先に、ファイルの履歴の
// うち同じ id の無いものを後ろに並べ、max で切る（壊れた max は recordDictation と同じく既定）。
// → { list, changed }。changed はファイルの履歴と並びが違う（書き戻すべき）とき真
function mergeHistory(memory, fromFile, max) {
  const limit = Number.isInteger(max) && max >= 0 && max <= 10000 ? max : HISTORY_MAX_DEFAULT;
  const mem = Array.isArray(memory) ? memory : [];
  const file = Array.isArray(fromFile) ? fromFile : [];
  const ids = new Set(mem.map((h) => h && h.id));
  const list = mem.concat(file.filter((h) => !ids.has(h && h.id))).slice(0, limit);
  const changed = list.length !== file.length || list.some((h, i) => h !== file[i]);
  return { list, changed };
}

// 新しい会議の下書きの名前（第1a回 JS9・F7）。draft.json が無ければ draft.json。あれば（前の起動で読めなかった古い控え）
// park() で脇へ退けてから draft.json。退けられなければ draft-<開始時刻>.json に書き、古い控えを決して上書きしない。
// park は { ok } を返す（投げても退けられなかったとみなす）
function chooseDraftName({ existing, startedAt, park }) {
  if (!Array.isArray(existing) || !existing.includes('draft.json')) return 'draft.json';
  let r = null;
  try { r = typeof park === 'function' ? park() : null; } catch (_) { r = null; }
  return r && r.ok ? 'draft.json' : `draft-${startedAt}.json`;
}

// 記録（engine.log）に書く失敗の理由（第1a回の決まり「記録にはファイルの名前（パスの最後だけ）だけ」）。
// 符号のあるエラー（fs の EACCES など）は符号だけ（fs のエラーの文はパス全体を含む）。ほかは文の中のパスを最後の部分だけにする。
// URL（http://…）は区切りの前が「:」なので変えない
const LOG_PATH_RE = /(^|[\s'"`(（「])(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\s'"`\\/]+[\\/])+([^\s'"`\\/]*)/g;
function logReason(e) {
  if (e && typeof e.code === 'string' && e.code) return e.code;
  const msg = (e && typeof e === 'object') ? e.message : e;
  if (!msg) return '不明なエラー';
  return String(msg).replace(LOG_PATH_RE, '$1…$2');
}

module.exports = {
  saveIfExists, meetingDurationSec, promptTail,
  registerHotkeys, hotkeyFailureMessage, hotkeyStatus, resolveStartupHotkeys, saveHotkeys,
  makeSummaryRunner, tickStep,
  pasterScript, copyCommand, restoreAfterPaste, parsePasterLine,
  COPY_SETTLE_MS, RESTORE_DELAY_MS, readClip, clipEquals, copyPrivate, deliverText,
  engineFileIssue, engineIssueMessage, engineInAppDir, engineDirWarning, portInUseError,
  isAscii, engineSpawnPlan,
  peFileVersion, vcRuntimeVersions, vcRuntimeIssue, runtimeGate, engineExitHint, spawnErrorHint, speedLine,
  ENGINE_SETTING_KEYS, guardEngineSettings, keptDifferent, closeConfirm, logReason,
  PICK_KEYS, pickDefaultPath,
  extractNotes, truncationMessage, buildPromptParts,
  publicSegments, settledSegments, pendingDurationMs, recoverSegments, staleSegbufDirs,
  nextSegmentMs, EtaTracker, skipPendingSegments,
  estimateTokens, foldNotes, idleEnginesToStop, silentWav, wavLevelDbfs, mergeSummaryType, memoEvidence, buildClaudeInput,
  isLoopbackUrl, loopbackOnlyFetch,
  sameShas, keepPrevious, candStamp, repairIdsOf, pathUsedBy, fetchMinutesLeft,
  recordDictation, mergeHistory, chooseDraftName,
};
