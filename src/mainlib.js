/*
 * mainlib.js — main.js から切り出した判断（Electron に依存しない部分）
 *
 * main.js は Electron を require するので、テストから直接は読み込めない。
 * 実機で踏んだ不具合の「判断」だけをここに置き、test/main.test.js で実行して
 * 固定する。main.js がこれらを本当に呼んでいるかは repo.test.js で見る。
 */
'use strict';

const path = require('path');
const natsulink = require('./natsulink');
// 議事録の経過の表と積み方（0.10.0 K-1。DB のプロセスと MCP も同じ部品を読む）
const SL = require('./statelog');
const memoTypes = require('./memoTypes');
const mtype = require('./meetingType');

// ---------------------------------------------------------------- 要約の書き戻し
// 要約は数分かかる。その間に利用者がページを削除していることがある。
// 入口で読んだ page をそのまま保存すると、削除した議事録が復活する
// （「消したはずの議事録が戻ってくる」）。必ずいま保存されているページを
// 読み直し、無ければ何も書かずに null を返す。
// apply(page) は、生成物だけを最新のページに載せる（タイトルやメモは
// 要約中に編集されているかもしれないので、古いコピーで上書きしない）。
// 第2a1回 M-1（ST1・F6・F12）: 議事録の保存は db.call(cmd, args)（非同期）を通る。page.get → apply → page.put { page, baseRev }。
// 画面の書き込みは main を通らないので「読む → 書く」の間に割り込まれうる。版（rev）が違えば保存の側が conflict を投げるので、
// 読み直して同じ当て方をもう一度する（SAVE_TRIES 回まで）。それでもぶつかれば conflict を投げる（null は呼び手が
// 「ページが消された」と読んで要約を黙って捨てるので返さない）。「ページが無い」は page.get か page.put が null と答えたときだけ。
// ほかの失敗（db-down・retry・unavailable など）も飲み込まずに投げる
const SAVE_TRIES = 5;
async function saveIfExists(db, pageId, apply) {
  let last = null;
  for (let i = 0; i < SAVE_TRIES; i++) {
    const got = await db.call('page.get', { id: pageId });
    if (!got || !got.page) return null;
    const saved = got.page;
    apply(saved);
    try {
      return await db.call('page.put', { page: saved, baseRev: saved.rev });
    } catch (e) {
      if (!e || e.code !== 'conflict') throw e;
      last = e;
    }
  }
  throw last;
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
// どれかが数でない・時間が 0 以下なら ''（何も残さない）。要約の速さ（llama）は 0.10.0 LS-3（D59）で外した（ほかの kind は ''）
function speedLine(kind, t) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!t || typeof t !== 'object') return '';
  if (kind === 'whisper') {
    const { audioMs, procMs } = t;
    if (!num(audioMs) || !num(procMs) || audioMs <= 0 || procMs < 0) return '';
    return `文字起こしの速さ: 音声 ${Math.round(audioMs / 1000)} 秒・処理 ${Math.round(procMs / 1000)} 秒（${(procMs / audioMs).toFixed(2)} 倍）`;
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
// 画面の3つの［選ぶ］ボタンのキー（ENGINE_SETTING_KEYS とは別に持つ）。画面からはパスを受け取らず、
// このキーの名前だけを受け取る。
const PICK_KEYS = ['localServerExe', 'localModelPath', 'vadModelPath'];   // 0.10.0 LS-3（D59）で要約の2つを外した
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
  language: '言語', localThreads: '文字起こしのスレッド数',
  useVad: 'VAD', suppressNst: '非発話トークンの抑制',
  localServerExe: '文字起こしエンジンの実行ファイル', localModelPath: '文字起こしのモデル', vadModelPath: 'VAD のモデル',
  localPort: '文字起こしのポート', segmentSec: '区間の長さ',
};   // 0.10.0 LS-3（D59）で要約のエンジンの5つを外した
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

// ---------------------------------------------------------------- 更新の再起動を断る理由（第1d回 A-9。RL16・RF41）
// 録音中（会議 meeting・音声入力の録音 recording と文字起こし processing）は 'recording'、議事録の保存の間（録音を止めて残りの区間を
// 文字起こし中 meeting-finalizing・締めの返事を待つページの数 finalizing・待ちの区間 pendingSegs）は 'finalizing'、要約中は 'summary'、
// どれでもなければ ''。録音中を先に言う（要約中でも録音が切れるほうが重い）。待って自動で再起動はしない（断って文を出す: K12）
function restartBlock({ state, finalizing, pendingSegs, summarizing } = {}) {
  if (['recording', 'processing', 'meeting'].includes(state)) return 'recording';
  if (state === 'meeting-finalizing' || Number(finalizing) > 0 || Number(pendingSegs) > 0) return 'finalizing';
  if (summarizing) return 'summary';
  return '';
}

// ---------------------------------------------------------------- 終了の確認（#52）
// recording: 議事録を記録中、summarizing: 要約を作成中、finalizing: 締めの返事（議事録の DB）を待つ会議がある（録音の状態は待機に戻っている。
// 第2a1回 M-4 の残りを 0.7.0 の前に直した）。どれでもなければ null。
// 要約は数分かかり、途中で終了すると結果は残らない。記録中と同じく一度は確認を挟む。締めの途中で終えても議事録は下書きから次の起動で
// 戻るが、要約は作られない
function closeConfirm(recording, summarizing, finalizing = false) {
  if (!recording && !summarizing && !finalizing) return null;
  const sumLine = '要約を作成中です。終了すると要約は失われます';
  if (recording) {
    let detail = '終了すると録音が止まります。ここまでの文字起こしは、次回起動時に復旧できます。';
    if (summarizing) detail += `\n${sumLine}。`;
    return { message: '議事録を記録中です', detail };
  }
  if (finalizing) {
    let detail = '今終了しても議事録は失われず、次に起動したときに残っています。ただし、この会議の要約は作られません（後から「要約を生成」で作れます）。';
    if (summarizing) detail += `\n${sumLine}。`;
    return { message: '議事録を保存しています', detail };
  }
  return { message: sumLine, detail: '「要約を生成」で後から作り直せます。' };
}

// 分割要約の打ち切り（#16 の extractNotes）と文脈長の見積もり（#41 の estimateTokens・foldNotes）は、0.10.0 LS-3（D59）で外した（手元の llama の要約が無い）

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
// 第1d2回 M-2: 音声を残した区間の印 kept も外す（会議と下書きの中だけに持つ。ページ・画面・DB には出さない）
function publicSegments(segments) {
  return (segments || []).map(({ wav, kept, ...s }) => s);
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
    const { wav, pending, kept, ...s } = raw;   // kept（第1d2回 M-2）はページに入れない（publicSegments を通らないので、ここで外す）
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
// 0.9.4 S-1（決めたこと 14）で意図して直した: 背圧で伸ばすのは PC の側だけで、上限は LOCAL_SEGMENT_MS_CAP（90 秒。持ち主の答え Q3）。300 秒の区間は
// PC で 300 秒を越えて undici の時間切れに当たり、会議の後のやり直しでも同じ長さで失敗した（持ち主の engine.log 10-21・10-22）。
// SEGMENT_MS_CAP（300 秒）は録音バー（overlay.html の SEG_MAX_MS。変えない）の丸めの写しとして liveSegmentMs だけが使う
const SEGMENT_MS_CAP = 300000;
const LOCAL_SEGMENT_MS_CAP = 90000;
function nextSegmentMs(pending, currentMs, baseMs, delta) {
  const base = Math.min(LOCAL_SEGMENT_MS_CAP, Math.max(1000, Number(baseMs) || 75000));
  const cur = Number(currentMs) > 0 ? Math.min(LOCAL_SEGMENT_MS_CAP, Number(currentMs)) : base;
  if (pending <= 1) return base;
  if (pending > 3 && delta > 0) return Math.min(LOCAL_SEGMENT_MS_CAP, cur * 2);
  return cur;
}

// ---------------------------------------------------------------- 区切りの長さ: オンライン 15 秒・オフライン 75 秒（第1d回 A-5・D16・RF40）
// 中継で文字起こしする会議は区切りを 15 秒にして止まりに早く気づけるようにする。手元の whisper・オフライン・［この会議は PC の中だけ］は
// 設定の長さ（既定 75 秒。15 秒より短いと言葉の途中で切れることが増えて精度が落ちる）。
// 録音バー（overlay.html。変えない）は、始めの segmentSec を丸めずに使い、途中の overlay:segment-ms は SEG_MIN_MS（20 秒）〜
// SEG_MAX_MS（300 秒）に丸めて次の区間から使う。だから 15 秒になるのは始めに 15 を渡した会議だけで、途中で短い側へ戻すときは 20 秒
// （設計書 D16 の「正直な限界」）。main は録音バーが今使っている値と同じ値を持つ（丸める前の値を持つと、同じ長さを何度も送る）。
// 区切りは区間ごとに今の経路で決め、同じ側が SEG_SWITCH_AFTER 区間続いてから替える（1 区間の失敗で長さを揺らさない）。
// ログイン切れ・上限・会社の鍵の誤り・PC の中だけは、続けて手元になると分かっているのですぐ長い側
const ONLINE_SEGMENT_SEC = 15;        // 中継で文字起こしする会議の区切り
const OVERLAY_SEG_MIN_MS = 20000;     // 録音バー（overlay.html の SEG_MIN_MS。変えない）が途中の値を丸める下限の写し
const SEG_SWITCH_AFTER = 2;           // 同じ側が続けてこの数になったら替える（行ったり来たりしない）
const STICKY_LOCAL = ['local-only', 'signed-out', 'login', 'daily-cap', 'quota', 'upstream-auth'];   // この理由の手元はすぐ長い側

/**
 * 会議の始めの区切り → 'short' | 'long'。short は「印なし・ログインしている・hold が ''・net.isOnline() が true・
 * 覚えている /health の答え（peekUp: true | false | null）が false でない」ときだけ。中継へ届くかは聞かない
 * （録音の始まりを待たせない。外れたら区間の後で替わる）
 */
function startSegmentMode({ localOnly, signedIn, hold, netOnline, peekUp } = {}) {
  return !localOnly && cloudLikely({ signedIn, hold, netOnline, peekUp }) ? 'short' : 'long';
}

// ---------------------------------------------------------------- オフラインの準備を任意にする（第1d2回 M-1・D21・OF1）
// 要約の欄の文（第1d2回 M-3。計画「画面と知らせの文」の S1〜S3'）。local・offline は準備を選んでいない PC で手元の LLM が無いとき
// （PC の中だけの会議・Claude Code に届かない）。wait・waitLocal は締めたときに文字起こし待ちの区間がある会議（済んだら自動で要約する）
// 0.10.0 LS-1（D59・決めたこと 103・110）: 要約は Claude Code だけ。届かなければ要約待ち（summaryWait と下の一文）。
const SUMMARY_WAIT_TEXT = '要約待ち（つながったら作ります）';
// 要約の欄の文（第1d2回 M-3 の S1〜S3'）。0.10.0 で「要約も PC の中」「ローカル AI の準備」を書かない形に直した（決めたこと 110）。
// local と offline は要約待ちの一文（LS-2 で local の使い手を外す）。文字起こし待ちの wait はそのまま
const KEPT_SUMMARY_TEXT = {
  local: SUMMARY_WAIT_TEXT,
  offline: SUMMARY_WAIT_TEXT,
  wait: '文字起こし待ちの音声があります。文字起こしが済むと、自動で要約を作ります。',
  waitLocal: 'この会議はオフラインモードです。文字起こし待ちの音声があります。文字起こしが済んでつながると、自動で要約を作ります。',
};
// 要約待ちのページを1つ選ぶ（決めたこと 104。D63 で「直した要約」の見分けは無くした）: summaryWait が真で tried に無いページの、
// 作った時刻の古い順の先頭の ID か null。ゴミ箱のページは呼び手が渡さない。受けた物を変えない
function summaryRetryPick(pages, { tried } = {}) {
  if (!Array.isArray(pages)) return null;
  const skip = tried instanceof Set ? tried : new Set();
  const cands = pages.filter((p) => p && typeof p === 'object' && p.summaryWait === true && typeof p.id === 'string' && !skip.has(p.id));
  if (!cands.length) return null;
  const at = (p) => { const t = Date.parse(p.createdAt); return Number.isFinite(t) ? t : Infinity; };
  return cands.slice().sort((a, b) => at(a) - at(b))[0].id;
}
// 要約の欄の鍵（D63・D69・決めたこと 111）。上から順に見て、最初に当たった行の符号（鍵なしは ''）。
// 画面の写しは app.html の summaryLockView（repo が同じ表を両方に当てる）。DB のプロセスは making を知らないので live と making を渡さない
const SUMMARY_LOCK_TEXT = Object.freeze({
  live: '録音中は要約を直せません。書きたいことはメモに書いてください。',
  making: '要約を作っています。',
  wait: `${SUMMARY_WAIT_TEXT}。要約ができるまでは直せません。書きたいことはメモに書いてください。`,
  empty: '文字起こしが無いので、要約は作れません。書きたいことはメモに書いてください。',
  none: '［要約を生成］で要約を作ると、直せるようになります。書きたいことはメモに書いてください。',
});
function summaryLock(page, { live = false, making = false, segments = [] } = {}) {
  const p = page && typeof page === 'object' && !Array.isArray(page) ? page : {};
  if (live) return 'live';
  if (making) return 'making';
  if (p.summaryWait === true) return 'wait';
  // 要約ができた印は route.summary（成功したときだけ main が { by, at } を書く。at の無い古い形も by で読む）
  const sum = p.route && typeof p.route === 'object' && p.route.summary && typeof p.route.summary === 'object' ? p.route.summary : null;
  const made = Boolean(sum && (sum.at || sum.by));
  if (made || (Array.isArray(p.blocks) && p.blocks.length > 0)) return '';
  if (typeof p.summaryError === 'string' && p.summaryError) return '';
  const said = Array.isArray(segments) && segments.some((x) => x && !x.failed && typeof x.text === 'string' && x.text.trim());
  return said ? 'none' : 'empty';
}
const LOGIN_WHYS = ['signed-out', 'login'];   // ログインしていない・切れた
// 準備を選んでいない PC で音声を残している帯の符号（第1d2回 M-2。B14・B13・B12・B11）。Windows の知らせにはしない（WIN_NOTIFY_CODES は変えない）
const KEPT_CODES = ['kept-local', 'kept-login', 'kept-relay', 'kept-wait'];
// つながれば戻る理由（オフライン・届かない・会社の通信の検査）
const KEPT_WAIT_WHYS = ['offline', 'unreachable', 'net', 'timeout', 'cert', 'proxy', 'key-unreadable'];
// 中継が音声を見て断った（待っても同じ答え）。残さない（決めたこと 12）
const KEPT_REFUSED_WHYS = ['bad-request', 'too-large'];
/**
 * 音声を残した区間の帯の符号。localOnly なら理由に関わらず kept-local、ログインしていない・切れたは kept-login、つながれば戻る理由は
 * kept-wait、中継が断ったものは ''（残さない）、ほか（上限・止めたメール・中継の誤り・知らない中継の符号）は kept-relay
 */
function keptCodeFor({ localOnly, why } = {}) {
  if (localOnly) return 'kept-local';
  if (LOGIN_WHYS.includes(why)) return 'kept-login';
  if (KEPT_WAIT_WHYS.includes(why)) return 'kept-wait';
  if (KEPT_REFUSED_WHYS.includes(why)) return '';
  return 'kept-relay';
}
/**
 * クラウド（中継）で文字起こしできそうか。ログインしている・hold が ''・net.isOnline() が true・覚えている /health の答え
 * （peekUp: true | false | null）が false でない。通信しない（startSegmentMode の short と同じ材料・同じ答え）
 */
function cloudLikely({ signedIn, hold, netOnline, peekUp } = {}) {
  return signedIn === true && !hold && netOnline === true && peekUp !== false;
}
/**
 * オフラインの準備を「選んだ」か: 手のパスがある・取り込んだ組の候補がある・取り込みのボタンを押した（installed.json の consent）・
 * 取り込み中のどれか1つ。選んだ人はエンジンの誤りの扱い（帯 B1・「未設定」の案内・始めないこと）を 0.8.0 のまま残す（RF49）
 */
function offlineChosen({ manual, managedCand, consent, fetching } = {}) {
  return Boolean(manual) || Boolean(managedCand) || Boolean(consent) || Boolean(fetching);
}
// 選んでいない PC で音声入力を始めない文（計画「画面と知らせの文」の D1〜D3。「未設定」の語を使わない: 画面が設定へ連れて行く）
const DICTATION_REFUSE_TEXT = {
  offline: 'インターネットにつながっていないため、音声入力を始めませんでした。オンラインに戻ってから、もう一度お試しください。つながっていなくても使うには、設定の「ローカル AI」で準備します。',
  login: 'ログインしていないため、音声入力を始めませんでした。設定の「アカウント」でログインしてください。',
  relay: '文字起こしの中継が今は使えないため、音声入力を始めませんでした。少し待ってから、もう一度お試しください。',
};
/**
 * 会議の始め方。localUsable（手元が使える）・chosen（準備を選んだ）・cloud（cloudLikely）・problem（whisperProblem の文）・
 * why（cloud を偽にした理由: signed-out・login・offline・hold の理由・relay-down）→ { ok: true, keep } | { ok: false, error }。
 * keep: '' は今どおり、'login' はログインするまで音声を残す、'wait' はつながるまで音声を残す（選んでいない PC だけ）
 */
function startPlan({ localUsable, chosen, cloud, problem, why } = {}) {
  if (localUsable || cloud) return { ok: true, keep: '' };
  if (chosen) return { ok: false, error: problem };
  return { ok: true, keep: LOGIN_WHYS.includes(why) ? 'login' : 'wait' };
}
/** 音声入力の始め方（材料は startPlan と同じ）→ { ok: true } | { ok: false, error, action? }（action: 'signin' は［ログイン］） */
function dictationPlan({ localUsable, chosen, cloud, problem, why } = {}) {
  if (localUsable || cloud) return { ok: true };
  if (chosen) return { ok: false, error: problem };
  if (LOGIN_WHYS.includes(why)) return { ok: false, error: DICTATION_REFUSE_TEXT.login, action: 'signin' };
  if (why === 'offline') return { ok: false, error: DICTATION_REFUSE_TEXT.offline };
  return { ok: false, error: DICTATION_REFUSE_TEXT.relay };
}

// 0.9.4 S-1（決めたこと 30）: 中継の一時の失敗（5xx・通信の切れ・時間切れ・届かない・読めない答え・中継の間を空けている）で PC に落ちた区間は、
// 区切りの側の数えに入れない（その区間だけ PC でやり直し、次の区間はまた中継へ送る。長い側へ替えるとクラウドの区間まで 75 秒になる）。
// オフライン・ログインしていない・上限・PC の中だけ・遅い PC（slow）は今どおり数える
const RELAY_TRANSIENT = Object.freeze(['server', 'net', 'timeout', 'unreachable', 'bad-reply', 'relay-hold']);
/** 区間の後の区切り。st = { mode, localRun, cloudRun }、route は 'cloud' | 'local'、why は手元にした理由 → 新しい st */
function segmentModeNext(st, { route, why } = {}) {
  const cur = st && typeof st === 'object' ? st : {};
  const mode = cur.mode === 'short' ? 'short' : 'long';
  const localRun = Number.isInteger(cur.localRun) ? cur.localRun : 0;
  const cloudRun = Number.isInteger(cur.cloudRun) ? cur.cloudRun : 0;
  if (route !== 'cloud' && RELAY_TRANSIENT.includes(why)) return { mode, localRun, cloudRun };
  if (route === 'cloud') {
    const n = cloudRun + 1;
    return { mode: n >= SEG_SWITCH_AFTER ? 'short' : mode, localRun: 0, cloudRun: n };
  }
  const n = localRun + 1;
  return { mode: STICKY_LOCAL.includes(why) || why === 'slow' || n >= SEG_SWITCH_AFTER ? 'long' : mode, localRun: n, cloudRun: 0 };
}

/** 区切りの基準（ミリ秒）。short は設定に関わらず 15 秒、long は設定の長さ（無ければ 75 秒。0.9.4 S-1: 90 秒まで） */
function segmentBaseMs(mode, settingsSec) {
  return mode === 'short' ? ONLINE_SEGMENT_SEC * 1000 : Math.min(LOCAL_SEGMENT_MS_CAP, (Number(settingsSec) || 75) * 1000);
}

/** 途中で録音バーへ送る値（録音バーが丸めるのと同じ 20〜300 秒） */
function liveSegmentMs(ms) {
  return Math.min(SEGMENT_MS_CAP, Math.max(OVERLAY_SEG_MIN_MS, Math.round(ms)));
}

/**
 * 次の区切り（背圧と経路の両方）。長い側へは待ちが残っていてもすぐ替える（nextSegmentMs は待ちが 2〜3 なら今の値のまま）。
 * 答えが今の値と同じなら今の値（始めの 15 秒のまま。丸めない）、ほかは録音バーと同じ丸めの値
 */
// 0.9.4 S-1（決めたこと 29）: mode が 'short'（クラウドの側）なら待ちの数を見ず基準（15 秒。途中で戻すときは録音バーの下限の 20 秒）のまま。
// 背圧で伸ばすのは long（PC の側）だけで、90 秒まで
function nextLiveSegmentMs(pending, currentMs, baseMs, delta, mode) {
  const raw = mode === 'short' ? baseMs : Math.max(nextSegmentMs(pending, currentMs, baseMs, delta), Math.min(LOCAL_SEGMENT_MS_CAP, baseMs));
  return raw === currentMs ? currentMs : liveSegmentMs(raw);
}

// ---------------------------------------------------------------- 文字起こしの状態（第1d回 D17・RL14。A-6）
// 止まりの見張り: 音のある区間（STALL_MIN_DBFS より大きい）が続けて空なら、約 STALL_SPAN_MS で「止まっているかもしれない」にする。
// 区間の数は区切りで割って切り上げ、2 以上（15 秒・20 秒なら 3、30 秒より長ければ 2）。無音の空は数えず、戻しもしない
const STALL_SPAN_MS = 45000;
// 話し声はふつう -40 dBFS より大きい。ヒントなしのやり直しの RETRY_MIN_DBFS（-50）より厳しくする（小さな雑音の空で止まりにしない）
const STALL_MIN_DBFS = -40;
/** 止まりとみなす、音のある空の区間の数 */
function stallAfter(segMs) {
  const ms = Number(segMs) > 0 ? Number(segMs) : 75000;
  return Math.max(2, Math.ceil(STALL_SPAN_MS / ms));
}
/** 区間の後の数え: 文字あり → 0、音のある空 → run + 1、音の無い空 → run のまま */
function stallStep(run, { text, levelDbfs } = {}) {
  const n = Number.isInteger(run) && run > 0 ? run : 0;
  if (text) return 0;
  return Number(levelDbfs) > STALL_MIN_DBFS ? n + 1 : n;
}
// 帯（録音中のページの頭。計画「画面と知らせの文」の B1〜B10）の符号。同時に1つだけで、前ほど先に出す
// 第1d2回 M-2: 準備を選んでいない PC で音声を残している帯（kept の4つ。B11〜B14）は、ログインの後・残した失敗の前
// 0.9.0 B-2: net-offline（B15。ネットワークから外れた・この PC で続けている）は seg-failed の後・中継の帯の前
// 0.9.4 S-1（決めたこと 18）: PC の文字起こしが間に合わない・遅い PC で音声を残している帯 kept-late を engine-down の後・kept-local の前に
const PROBLEM_ORDER = ['engine-down', 'kept-late', 'stall', 'login', 'kept-local', 'kept-login', 'kept-relay', 'kept-wait', 'seg-failed', 'net-offline',
  'relay-off', 'daily-cap', 'relay-blocked', 'relay-down', 'relay-busy', 'wait'];
/** problems: Map<符号, 詳しさ（{ n } や { sec }）> → 一番前の { code, ...詳しさ } か null（表に無い符号は見ない） */
function sttProblemOf(problems) {
  if (!(problems instanceof Map)) return null;
  for (const code of PROBLEM_ORDER) {
    if (problems.has(code)) {
      const d = problems.get(code);
      return { code, ...(d && typeof d === 'object' ? d : {}) };
    }
  }
  return null;
}
// 手元に落ちた理由（経路の why・中継の失敗の符号）→ 帯の符号。表に無い中継の失敗（server・bad-reply・too-large・bad-request・
// 知らない符号）はその区間を PC でやり直したので relay-busy。オフライン・ログインしていない・PC の中だけ・ok は帯にしない（RF28）
const PROBLEM_FOR_WHY = {
  unreachable: 'relay-down', net: 'relay-down', timeout: 'relay-down',
  cert: 'relay-blocked', proxy: 'relay-blocked',
  login: 'login', quota: 'relay-off', 'upstream-auth': 'relay-off',
  denied: 'relay-off',   // 第1d回 A-11: 止めたメール・会社のドメインでない（L11）
  offline: '', 'signed-out': '', 'local-only': '', ok: '', 'key-unreadable': '',   // key-unreadable（第1d回 A-11・F26）も帯にしない（記録だけ）
};
/** → 帯の符号か ''。daily-cap は scope で分ける（1人の上限は daily-cap、全体の上限は relay-off） */
function problemForRoute({ route, why, scope } = {}) {
  if (route !== 'local') return '';
  if (why === 'daily-cap') return scope === 'all' ? 'relay-off' : 'daily-cap';
  return Object.hasOwn(PROBLEM_FOR_WHY, why) ? PROBLEM_FOR_WHY[why] : 'relay-busy';
}

// 0.9.0 B-2（BN2・D26・決めたこと 34）: 会議の途中でネットワークから外れたときの帯（B15 net-offline）の出し消し。main の 1 秒の見張り
// （watchOffline）が呼ぶ。切れているのが OFFLINE_SHOW_MS 続いたら 'show'、出ている間につながっているのが OFFLINE_CLEAR_MS 続いたら 'clear'
// （行き来では点滅しない。帯は role="alert" で出し直すたびに読み上げる）。eligible が偽なら、出ていれば 'clear'（出さない）。
// shown は呼び手が帯の今の様子から渡す（見張りの中に「出ている」を持たない: ほかの道で消えたら、切れたままなら出し直す）。
// st = { offSince, onSince }（今の様子が続いている始まりの時刻）。時計が戻ったら（now が始まりより前）戻った所から数え直す（投げない）
const OFFLINE_SHOW_MS = 5000;
const OFFLINE_CLEAR_MS = 10000;
/** (st, { online, now, eligible, shown }) → { st, act: 'show' | 'clear' | '' } */
function offlineBannerStep(st, { online, now, eligible, shown } = {}) {
  const t = Number.isFinite(now) ? now : 0;
  const prev = st && typeof st === 'object' ? st : {};
  const since = (v) => (Number.isFinite(v) && v <= t ? v : t);
  const next = online ? { offSince: null, onSince: since(prev.onSince) } : { offSince: since(prev.offSince), onSince: null };
  if (!eligible) return { st: next, act: shown ? 'clear' : '' };
  if (!online && !shown && t - next.offSince >= OFFLINE_SHOW_MS) return { st: next, act: 'show' };
  if (online && shown && t - next.onSince >= OFFLINE_CLEAR_MS) return { st: next, act: 'clear' };
  return { st: next, act: '' };
}

// Windows の知らせ（第1d回 D17・RL15。A-8）: 録音中のページが見えていないとき、文字起こしが止まる・行動が要る帯だけを出す
// （B5〜B10 は PC の中で文字起こしが続いていて、帯と左下の知らせで足りる）。同じ符号は会議ごとに1回、違う符号でも前の知らせから 5 分は出さない
const WIN_NOTIFY_CODES = ['engine-down', 'stall', 'login', 'seg-failed'];
const WIN_NOTIFY_GAP_MS = 5 * 60 * 1000;
/** st = { sent: string[], lastAt: number }（会議ごと）→ { ok, st }。出したときだけ st に覚える（前の st は書き換えない） */
function notifyGate(st, code, now) {
  const sent = st && Array.isArray(st.sent) ? st.sent.filter((c) => typeof c === 'string') : [];
  const lastAt = st && Number.isFinite(st.lastAt) ? st.lastAt : 0;
  const cur = { sent, lastAt };
  if (!WIN_NOTIFY_CODES.includes(code) || sent.includes(code)) return { ok: false, st: cur };
  if (sent.length && now - lastAt < WIN_NOTIFY_GAP_MS) return { ok: false, st: cur };
  return { ok: true, st: { sent: [...sent, code], lastAt: now } };
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

// ---------------------------------------------------------------- 後回し（#42。0.9.4 S-3 で打ち切りから替えた）
// 文字起こし待ちの区間を全部「文字起こし待ち」（音声を残す: kept）にする（meeting:skipPending ［文字起こしを後回しにして要約］）。
// 0.9.4 S-3（決めたこと 4）: 前は「（文字起こしを打ち切り）」の失敗にして WAV を消していた（その区間の発言は二度と戻らない）。今は失敗の印と kept を付け、
// WAV を残す（締めが待ち行列に載せ、会議の後に文字起こしする）。音声の無い待ちの区間（控えられなかった）だけ今の「打ち切り」の失敗の行。
// pending を外す（id/atMs はそのまま）。戻り値は { count: 後回しにした数, kept: 音声を残した数 }。配列の要素は書き換える。
const SKIP_KEPT_TEXT = '（文字起こし待ち: 音声は残してあります）';
function skipPendingSegments(segments) {
  let count = 0;
  let kept = 0;
  for (const s of (segments || [])) {
    if (!s || !s.pending) continue;
    count++;
    delete s.pending;
    s.failed = true;
    if (s.wav) {
      kept++;
      s.text = SKIP_KEPT_TEXT;
      s.kept = true;
    } else {
      delete s.wav;
      s.text = '（文字起こしを打ち切り）';
    }
  }
  return { count, kept };
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

// ---------------------------------------------------------------- 話し声の無い区間（0.9.1 Q-1。計画 docs/plans/2026-10-21-091.md の決めたこと 1〜4・8・11）
// 無音の判定は一番大きい 0.5 秒の窓（0.25 秒ずつずらす）の RMS で見る。区間全体の RMS（wavLevelDbfs）では、15 秒の区間の中の短い小さな
// 発言が 10 dB 以上薄まって無音に見える。しきい値 -55 dBFS は、録音バーの無音の警告（RMS 約 -44.6 dBFS: overlay.html の SILENT_LEVEL）より
// 10 dB 小さく、話し声（ふつう -40 dBFS より大きい: STALL_MIN_DBFS）より 15 dB 小さい
const QUIET_WIN_MS = 500;
const QUIET_HOP_MS = 250;
const SILENT_DBFS = -55;
// 音声入力で、認識ヒントの言葉だけの答えを作り話として除くのは、録った音がこれより小さいときだけ（話し声の大きさ）
const SPEECH_DBFS = STALL_MIN_DBFS;
/** 16bit PCM の WAV の { rate, body, n }（data の頭と標本の数）か null（読めない・中身が無い） */
function pcmOf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let bits = 16;
  let rate = 16000;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) { rate = buf.readUInt32LE(body + 4) || 16000; bits = buf.readUInt16LE(body + 14); }
    if (id === 'data') {
      if (bits !== 16) return null;
      const n = ((Math.min(buf.length, body + size) - body) / 2) | 0;
      return n > 0 ? { rate, body, n } : null;
    }
    off = body + size + (size & 1);
  }
  return null;
}
/** 一番大きい 0.5 秒の窓の RMS（dBFS。デジタルの 0 は -Infinity）。窓より短い音声は全体で1つの窓。16bit PCM の WAV として読めなければ null */
function wavLoudestDbfs(buf) {
  const p = pcmOf(buf);
  if (!p) return null;
  const hop = Math.max(1, Math.round((p.rate * QUIET_HOP_MS) / 1000));
  const per = Math.max(1, Math.round(QUIET_WIN_MS / QUIET_HOP_MS));   // 窓は hop の per 個分（0.5 秒 = 0.25 秒 × 2）
  // hop ごとの2乗の和（区間の長さの配列を作らない: 300 秒の区間でも hop の数だけ）
  const blocks = new Float64Array(Math.ceil(p.n / hop));
  for (let i = 0; i < p.n; i++) { const v = buf.readInt16LE(p.body + i * 2); blocks[(i / hop) | 0] += v * v; }
  const w = Math.min(per, blocks.length);   // 窓の中の hop の数（音声が窓より短ければ全体で1つの窓）
  let best = 0;
  for (let k = 0; k + w <= blocks.length; k++) {
    let sum = 0;
    let len = 0;
    for (let j = k; j < k + w; j++) { sum += blocks[j]; len += Math.min(hop, p.n - j * hop); }
    best = Math.max(best, sum / len);
  }
  const rms = Math.sqrt(best) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

// 認識ヒントの作り話（決めたこと 2・3）。畳み方は検索と同じ（cite.js の searchFold・app.html の fold: NFKC・句読点と記号と空白を外す・小文字）
const HINT_TAIL_MIN = 4;
const hintFold = (s) => String(s || '').normalize('NFKC')
  .replace(/[、。「」『』（）()［］[\]【】・,.!?！？"'`~\-—…:：;；*_/\s]/g, '').toLowerCase();
const hintPieces = (s) => String(s || '').normalize('NFKC').split(/[、。，．,.!?！？\s]+/).map(hintFold).filter(Boolean);
/**
 * 答えが認識ヒントの材料だけでできているか。hint = { sample（文例）, terms（業務の言葉と辞書の語）, tail（直前の発言の尻尾） }。
 * 答えを句読点と空白で切った各片が、ヒントの単位（文例の文・言葉。畳んで2字以上）だけでつながる（区切りが無くても）か、4字以上で尻尾の一部なら材料。
 * 全部の片が材料なら真。音声入力（opts.dictation）は録った音の一番大きい窓（opts.loudDbfs）が SPEECH_DBFS より小さいときだけ真
 */
function hintEcho(text, hint, opts = {}) {
  const pieces = hintPieces(text);
  if (!pieces.length) return false;
  const h = hint && typeof hint === 'object' ? hint : {};
  const units = new Set([...hintPieces(h.sample), ...(Array.isArray(h.terms) ? h.terms : []).map(hintFold)].filter((u) => u.length >= 2));
  const tail = hintFold(h.tail);
  if (!units.size && !tail) return false;
  const lens = [...new Set([...units].map((u) => u.length))];
  const joins = (p) => {
    const ok = new Array(p.length + 1).fill(false);
    ok[0] = true;
    for (let i = 0; i < p.length; i++) {
      if (!ok[i]) continue;
      for (const n of lens) if (i + n <= p.length && units.has(p.slice(i, i + n))) ok[i + n] = true;
    }
    return ok[p.length];
  };
  const made = (p) => joins(p) || (p.length >= HINT_TAIL_MIN && tail.includes(p));
  if (!pieces.every(made)) return false;
  if (opts && opts.dictation) return Number.isFinite(opts.loudDbfs) && opts.loudDbfs < SPEECH_DBFS;
  return true;
}

// 話し声が無いときに聞いて止める（決めたこと 7〜9）。時計は会議の時計（区間の長さの和。一時停止の時間を含まない）
const QUIET_GRACE_MS = 5 * 60000;
/**
 * st = { sinceMs（話し声の無い長さの始め）, untilMs（最後に分けた区間の終わり）, askedAt（聞いた時か null）, askMin（聞いたときの分） }
 * ev = { kind: 'speech' | 'quiet' | 'keep-going', endMs }、cfg = { on, askMin } → { st, act: '' | 'ask' | 'withdraw' | 'stop' }。
 * 話し声の無い長さが askMin 分で ask、聞いた時から QUIET_GRACE_MS で stop（stop は条件が続く間は毎回返す。止めるかは呼び手が決める）
 */
function quietStep(st, ev, cfg) {
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const s0 = st && typeof st === 'object' ? st : {};
  const next = { sinceMs: num(s0.sinceMs, 0), untilMs: num(s0.untilMs, 0), askedAt: Number.isFinite(s0.askedAt) ? s0.askedAt : null, askMin: num(s0.askMin, 0) };
  const e = ev && typeof ev === 'object' ? ev : {};
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const end = num(e.endMs, next.untilMs);
  const askMin = Number(c.askMin) > 0 ? Number(c.askMin) : 10;
  const withdraw = () => { next.askedAt = null; return { st: next, act: 'withdraw' }; };
  next.untilMs = Math.max(next.untilMs, end);
  if (e.kind === 'speech') {
    next.sinceMs = next.untilMs;
    return next.askedAt !== null ? withdraw() : { st: next, act: '' };
  }
  if (e.kind === 'keep-going') {
    next.sinceMs = Math.max(next.untilMs, end);
    return next.askedAt !== null ? withdraw() : { st: next, act: '' };
  }
  if (!c.on) return next.askedAt !== null ? withdraw() : { st: next, act: '' };
  if (next.askedAt === null) {
    if (next.untilMs - next.sinceMs < askMin * 60000) return { st: next, act: '' };
    next.askedAt = next.untilMs;
    next.askMin = askMin;
    return { st: next, act: 'ask' };
  }
  return { st: next, act: next.untilMs - next.askedAt >= QUIET_GRACE_MS ? 'stop' : '' };
}
/** 区間の終わり（atMs + durationMs）の一番遅い値。無ければ null（所要時間を切らない） */
function quietTrimEnd(segments) {
  let best = null;
  for (const s of (Array.isArray(segments) ? segments : [])) {
    if (!s || !Number.isFinite(s.atMs)) continue;
    const end = s.atMs + (Number.isFinite(s.durationMs) ? s.durationMs : 0);
    if (best === null || end > best) best = end;
  }
  return best;
}
/** 時刻の書き方（画面の fmtClock と同じ。m:ss か h:mm:ss） */
function clockText(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}

// 0.11.0 V-1（決めたこと 2・6）: 画面の種類の欄の表（IPC meta:types）。並びは meetingType の1か所（V-5 で群は外した）、各種類にメモの型の鍵 memo
function typesForView() {
  return {
    types: mtype.listTypes().map((t) => ({ ...t, memo: memoTypes.memoTypeOf(t.key) })),
    selectable: [...mtype.SELECTABLE],
  };
}

// 要約を保存するときの会議タイプ。saved: いまディスクにあるページ、used: 要約を始めたときのページ
// （meetingType は要約に使った種類）。要約の途中で利用者が種類を手で選んでいたら（saved.typeAuto === false）、
// その選択を残す。changed: 残した種類が要約に使った種類と違う（作り直しを勧める）。
// 0.11.0 P-12（R4・P19 (a)）: 選べない種類（前の版で手で選んだ一般・その他）は手で選んだ印があっても残さない（判定し直した種類で保存する）
function mergeSummaryType(saved, used) {
  if (saved && saved.typeAuto === false && mtype.isSelectable(saved.meetingType)) {
    return { meetingType: saved.meetingType, typeAuto: false, changed: saved.meetingType !== used.meetingType };
  }
  return { meetingType: used.meetingType, typeAuto: used.typeAuto, changed: false };
}

// Claude Code（claude -p）の標準入力に渡す文（第1c回 OL5・F9）。手元の LLM の1回で要約する頼みの文（main.js の
// generateMinutes）と1文字も違わない形にする（片方だけ直すと、要約タイプの見出しが道によって変わる）。
// memoText は呼ぶ側が trim し MEMO_MAX で切ったもの、template は doRunSummary が memoTypes.buildTemplate で1回作った文字（dropTemplateEcho に渡すのと同じ文字）。
// 同じことは stage1c.lib.test.js が main.js の文字から確かめる
// 0.11.0 M-2（決めたこと 16。持ち主の試作の「メモ・文字起こし・要約の3つの入れ物」）: メモと文字起こしの行の頭の「【」の前に全角の空白を入れる
// （memoTypes.fenceLines）。議事録の文に「【会議の文字起こし】」や構成の指示を書かれても、頼みの文の境を偽れない
function buildClaudeInput({ memoText, plain, template }) {
  const memo = memoTypes.fenceLines(memoText);
  const memoBlock = memo ? `【会議メモ・アジェンダ（要約のヒント）】\n${memo}\n\n` : '';
  return `${memoBlock}【会議の文字起こし】\n${memoTypes.fenceLines(plain)}\n\n上記から、次の構成のMarkdown議事録を作成してください。見出しはこの通りに使い、本文だけを出力してください。\n\n${template}`;
}

// ページのプロパティの行に出す経路（第1c回 OL6）。route はページの route（main の maybeFinalizeMeeting・doRunSummary が書く）、
// providerLabel はその文字起こしの送り先の表示の名前。画面は mainlib を読めないので、main が page:get の返事に添える。
// 文字起こしは区間の数（クラウドと PC）、要約は1回ごとの経路。形の違う欄は出さない（古いページ・壊れたページは []）
function routeLabel(route, providerLabel) {
  const out = [];
  if (!route || typeof route !== 'object') return out;
  const n = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
  const stt = route.stt;
  if (stt && typeof stt === 'object') {
    const cloud = n(stt.cloud), local = n(stt.local);
    if (cloud) out.push(`☁ 文字起こし: クラウド（${String(providerLabel || stt.provider || '')}）${cloud}${local ? `・PC ${local}` : ''}`);
    else if (local) out.push('🖥 文字起こし: PC');
  }
  const by = route.summary && typeof route.summary === 'object' ? route.summary.by : '';
  if (by === 'claude-code') out.push('✨ 要約: Claude Code');
  else if (by === 'local') out.push('🖥 要約: PC（オフライン）');
  return out;
}

// 担当・期限の裏付けに使うメモ。要約タイプを選んだときに入るアジェンダの雛形（types[].agenda）の行は除く。
// 雛形は利用者の発言でもメモでもなく、「次回までのアクション」などが作り話の期限を通してしまう
function memoEvidence(memo, types) {
  const preset = new Set((types || []).flatMap((t) => String(t.agenda || '').split('\n').map((l) => l.trim()).filter(Boolean)));
  return String(memo || '').split('\n').filter((l) => !preset.has(l.trim())).join('\n');
}

// ---------------------------------------------------------------- 取り込んだエンジンの切り替え（第0b回 Task 14）
// main は取り込みの係（engine-install.makeRunner）が組をそろえるたびに、候補（engine-install.managedCandidates の
// { whisper }。Cand は { current, shas, dir, exe, model, vad?, … }）を照らしてから切り替える。ここはその判断だけ。
// 0.10.0 LS-3（D59）で要約の組（sum）を外した
const MANAGED_GROUPS = ['whisper'];
const shasKey = (c) => (c && Array.isArray(c.shas) ? c.shas.map((s) => String(s).toLowerCase()).join(',') : '');
const sameSha256 = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// 2 つの組の並びが、SHA-256 の並びで同じか（ファイルを読まない安い比べ）。組が無いどうしは同じ。groups で見る組を絞れる
function sameShas(a, b, groups = MANAGED_GROUPS) {
  return groups.every((g) => shasKey(a && a[g]) === shasKey(b && b[g]));
}

// 照らしの結果（engine-install.verifyCandidates の { whisper, bad }）に、前の組を使い続ける組を足す（RF13）
// → { whisper, bad, kept: [組の名前] }。新しい候補（cands[g]）が照らしで合わず、照らし済みの前の組（prev[g]）が
// 別の並びなら、前の組を使い続ける（新しい組は取り直す）。同じ並びの組（触られた・取り直した組）・前の組が無い組・
// 候補が無くなった組は、照らしの結果のまま（合わなければ null。RF3）
function keepPrevious(cands, prev, checked) {
  const out = { whisper: null, bad: (checked && Array.isArray(checked.bad)) ? checked.bad : [], kept: [] };
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
// ログインの IPC の文（第1d回 A-2。A-11 で AR4〜AR7 を足し、A-12 で前の自前のログイン（確認コード）の文 R2〜R10・R17 を消した。
// 計画 docs/plans/2026-10-19-1d.md「作り替え」の「画面と知らせの文」の AR4〜AR7・R12〜R16）。
// code: ログインの窓の符号・通信の符号・main の符号（store・logout）。o.host は中継（か Cloudflare のログイン）のホスト。
// 知らない符号（中継の形でない答え server・約束の形でない答え bad-reply・not-ready・前の確認コードの符号など）は R15（管理者へ）。符号の文字は文に入れない
const ACCOUNT_TEXT = {
  logout: () => 'ログアウトしました。これからは PC の中で文字起こしします。',
  offline: () => '文字起こしの中継につながりませんでした。インターネットにつながっているかを確かめてください。',
  cert: (o) => `文字起こしの中継につながりません（会社の通信の検査で止められている可能性があります）。続くときは情報システムに ${o.host} への通信の許可を頼んでください。`,
  'not-ready': () => '文字起こしの中継の準備ができていません。管理者に知らせてください。',
  store: () => 'この PC ではログインの情報をしまえません（暗号にする仕組みが使えません）。管理者に知らせてください。',
  // 第1d回 A-11（Cloudflare Access のログインの窓。計画「作り替え」の「画面と知らせの文」の AR4〜AR7）
  'login-ok': () => 'ログインしました。インターネットにつながっているときは、クラウドで文字起こしします。',
  cancel: () => 'ログインの窓を閉じたため、ログインしていません。もう一度［ログイン］を押してください。',
  login: () => 'ログインを確かめられませんでした。もう一度［ログイン］を押してください。',
  denied: () => 'このメールアドレスでは文字起こしの中継を使えません。管理者に知らせてください。',
};
const ACCOUNT_ALIAS = { net: 'offline', timeout: 'offline', proxy: 'cert', 'no-cookie': 'login' };
function accountMessage(code, o = {}) {
  const c = Object.hasOwn(ACCOUNT_ALIAS, code) ? ACCOUNT_ALIAS[code] : code;
  return (Object.hasOwn(ACCOUNT_TEXT, c) ? ACCOUNT_TEXT[c] : ACCOUNT_TEXT['not-ready'])(o || {});
}

const LOG_PATH_RE = /(^|[\s'"`(（「])(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\s'"`\\/]+[\\/])+([^\s'"`\\/]*)/g;
function logReason(e) {
  if (e && typeof e.code === 'string' && e.code) return e.code;
  const msg = (e && typeof e === 'object') ? e.message : e;
  if (!msg) return '不明なエラー';
  return String(msg).replace(LOG_PATH_RE, '$1…$2');
}

// ---------------------------------------------------------------- 録音バーの置き場所（0.9.0 O-1・設計書 D25・RP1〜RP3）
// 8つの置き場所（settings.js の PILL_SLOTS と同じ並び。同じ距離のときはこの順で前）。左右の中央だけ縦の形
const PANEL_SLOTS = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];
// ピルの端と画面の作業領域の端の間（0.8.0 の録音バーと同じ 12px）
const PANEL_EDGE = 12;
// 形ごとのピルの初めの大きさ（CSS の px。録音バーの画面がまだ大きさを送っていないときと、置き場所の中心を決めるとき）
const PANEL_FIRST = { h: { w: 240, h: 40 }, v: { w: 40, h: 240 } };
// → 'v'（middle-left・middle-right）か 'h'
function slotForm(slot) { return slot === 'middle-left' || slot === 'middle-right' ? 'v' : 'h'; }
// 置き場所に size（{ w, h }）のピルを、作業領域の端から edge の所に置いた四角の左上（DIP。丸めない）
function slotOrigin(slot, size, wa, edge) {
  const x = slot.endsWith('left') ? wa.x + edge : slot.endsWith('right') ? wa.x + wa.width - edge - size.w : wa.x + (wa.width - size.w) / 2;
  const y = slot.startsWith('top') ? wa.y + edge : slot.startsWith('bottom') ? wa.y + wa.height - edge - size.h : wa.y + (wa.height - size.h) / 2;
  return { x, y };
}
// 点（ドラッグを離した窓の中心・前の版の位置）に一番近い置き場所の名前。距離は、作業領域の各置き場所にその形の初めの大きさ
// （PANEL_FIRST）のピルを置いた中心との距離。同じ距離なら PANEL_SLOTS の順で前（RP2・F12）
function nearestSlot(pt, workArea) {
  let best = PANEL_SLOTS[0];
  let bestD = Infinity;
  for (const slot of PANEL_SLOTS) {
    const size = PANEL_FIRST[slotForm(slot)];
    const o = slotOrigin(slot, size, workArea, PANEL_EDGE);
    const d = (o.x + size.w / 2 - pt.x) ** 2 + (o.y + size.h / 2 - pt.y) ** 2;
    if (d < bestD) { best = slot; bestD = d; }
  }
  return best;
}
// ---------------------------------------------------------------- 録音バーの窓の大きさ（0.9.0 O-2・設計書 D25・RP3・RP4・F11）
// ピルの周りの余白（拡大率 125% などで DIP を画面の点に丸めたときの1点のずれと、縦の形の × を飲み込む）と、窓の最大
const PANEL_PAD = 8;
const PANEL_MAX = { width: 560, height: 360 };
// ドラッグの止まり（最後の move から）。moved の来ない Linux だけがこれで吸い付く（snapsOnQuiet）
const PANEL_QUIET_MS = 300;
// → 録音バーの窓の { x, y, width, height }（どれも整数の DIP）。size はピルの大きさ（CSS の px。録音バーの画面が測って送る）で、
// 有限の正の数でなければ形の初めの大きさ（PANEL_FIRST）。窓はピルの大きさを切り上げて周りに PANEL_PAD を足した大きさ（PANEL_MAX まで）。
// ピルは窓の真ん中に描かれるので、窓の端を作業領域の端から PANEL_EDGE − PANEL_PAD の所に置くと、ピルの端は PANEL_EDGE の所に来る
// （右の置き場所は右の端、下の置き場所は下の端を保つ。真ん中は真ん中）。窓は作業領域の中に収める。窓の大きさを決めるのはここだけ
function panelBounds({ slot, size, workArea }) {
  const okSize = size && Number.isFinite(size.w) && Number.isFinite(size.h) && size.w > 0 && size.h > 0;
  const s = okSize ? size : PANEL_FIRST[slotForm(slot)];
  const width = Math.min(PANEL_MAX.width, Math.ceil(s.w) + 2 * PANEL_PAD);
  const height = Math.min(PANEL_MAX.height, Math.ceil(s.h) + 2 * PANEL_PAD);
  const o = slotOrigin(slot, { w: width, h: height }, workArea, PANEL_EDGE - PANEL_PAD);
  const x = Math.max(workArea.x, Math.min(Math.round(o.x), workArea.x + workArea.width - width));
  const y = Math.max(workArea.y, Math.min(Math.round(o.y), workArea.y + workArea.height - height));
  return { x, y, width, height };
}
// ドラッグの止まり（PANEL_QUIET_MS）で吸い付く OS か。Windows・macOS は OS のドラッグの終わりに moved が来るのでそれを待つ
// （Windows で止まりを使うと、ドラッグの途中で手を止めただけで吸い付いて OS のドラッグと取り合う: F18）
function snapsOnQuiet(platform) { return platform === 'linux'; }
// ---------------------------------------------------------------- 録音バーのボタンの名前のキー（0.9.0 O-3・設計書 D25・RP7）
// Electron のキーの書き方（Control+Shift+Space）を画面の書き方（Ctrl+Shift+Space）に直す。渡すのは実際に登録しているキー（activeHotkeys）。
// 文字でない・空なら ''（名前にキーを付けない）
function keyLabel(accel) {
  if (typeof accel !== 'string' || !accel.trim()) return '';
  const MAP = { control: 'Ctrl', ctrl: 'Ctrl', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl', super: 'Win', meta: 'Win' };
  return accel.split('+').map((k) => MAP[k.trim().toLowerCase()] || k.trim()).join('+');
}

// ---------------------------------------------------------------- ヘルプセンターの記事（0.9.2 I-1。ヘルプの計画の H-12）
// 画面は記事の名前（help/site.json の「<分類>/<記事>」）だけを渡し、main がこの一覧で照らして道を作る（住所は main.js の HELP_URL だけ）。
// 一覧は help/site.json の分類の articles と同じ並び（test/help-app.test.js が照らす。記事を足したらここも直す）。
// 一覧にちょうどある文字だけ「<記事>/」を返し、ほか（文字でない・空・住所・../・#・前後の空白・大文字）は ''（ヘルプのホーム）
const HELP_ARTICLES = Object.freeze([
  'start/what-natsu-does', 'start/install-update', 'start/login', 'start/claude-code', 'start/claude-mcp', 'start/tester-guide',
  'record/start-stop', 'record/pause', 'record/pc-only', 'record/status-line', 'record/meeting-detect',
  'summary/how-summaries', 'summary/summary-types', 'summary/meeting-quality', 'summary/citations',
  'dictation/dictation',
  'find/search', 'find/delete-and-backups',
  'settings/appearance', 'settings/account', 'settings/offline', 'settings/hotkeys',
  'trouble/banners', 'trouble/login-trouble', 'trouble/transcription-stops', 'trouble/slow-pc', 'trouble/claude-summary-fails',
  'admin/stop-person', 'admin/seats', 'admin/relay-limits',
]);
function helpPath(article) {
  return typeof article === 'string' && HELP_ARTICLES.includes(article) ? `${article}/` : '';
}

// ---------------------------------------------------------------- 会議の検出（0.9.3 M-1。計画 docs/plans/2026-10-22-093.md の決めたこと 1〜6・8）
// 見るのは Windows の「マイクを使っているアプリ」の記録（Capability Access Manager。［設定］→［プライバシーとセキュリティ］→［マイク］の
// 「最近のアクティビティ」と同じ記録）だけ。音は聞かない・窓の題名を読まない・何も外へ送らない。
// 会議のアプリの一覧（凍らせる）。exe は実行ファイルの名前（パスの最後）の小文字、pkg はストアのアプリのパッケージファミリー名、
// proc は古い値を除くときに見るプロセスの名前（.exe を外した形）。持ち主の実機の記録（2026-10-22。新しい Teams はパッケージ・Zoom は
// 「Zoom Meetings」と出るが記録のキーはパスの最後が Zoom.exe）に合わせた。会議のアプリでないもの（ほかのメモ取りの道具）と NaTsu 自身は入れない
const MEET_APPS = Object.freeze([
  { id: 'teams', label: 'Teams', exe: ['ms-teams.exe', 'teams.exe'], pkg: ['MSTeams_8wekyb3d8bbwe'], proc: ['ms-teams', 'teams'] },
  { id: 'zoom', label: 'Zoom', exe: ['zoom.exe'], pkg: [], proc: ['zoom'] },
  { id: 'webex', label: 'Webex', exe: ['webex.exe', 'ciscocollabhost.exe', 'atmgr.exe'], pkg: [], proc: ['webex', 'ciscocollabhost', 'atmgr'] },
  { id: 'slack', label: 'Slack', exe: ['slack.exe'], pkg: [], proc: ['slack'] },
  { id: 'chrome', label: 'Chrome（ブラウザ）', exe: ['chrome.exe'], pkg: [], proc: ['chrome'] },
  { id: 'edge', label: 'Edge（ブラウザ）', exe: ['msedge.exe'], pkg: [], proc: ['msedge'] },
  { id: 'firefox', label: 'Firefox（ブラウザ）', exe: ['firefox.exe'], pkg: [], proc: ['firefox'] },
].map((a) => Object.freeze({ ...a, exe: Object.freeze(a.exe), pkg: Object.freeze(a.pkg), proc: Object.freeze(a.proc) })));
const MEET_BY_ID = new Map(MEET_APPS.map((a) => [a.id, a]));
const MIC_ROOT = 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
const psq = (v) => `'${String(v).replace(/'/g, "''")}'`;
/**
 * 見張りの常駐の PowerShell（-NoProfile -NonInteractive で起こす）の中身。everyMs ごとに HKCU の root の下（パッケージのキーと NonPackaged の下の
 * キー）を .NET の Registry で読み、LastUsedTimeStop が 0 で LastUsedTimeStart が 0 でない（どちらも QWORD）ものを「今使っている」とする。
 * 一覧に当たるものだけを、self（NaTsu の実行ファイルのパス。キーの名前の形 \ → # にして小文字で比べる）を除き、proc のプロセスが今あるものだけ残す。
 * 前と変わったときだけ「mic <id>:<start>,…」（無ければ「mic -」）を1行書く。読めない・例外は「err read」「err proc」。パス・一覧に無い名前・
 * 題名は書かない。parent（NaTsu の main の pid）が居なくなったら自分で終わる。timing なら読みごとに「t <ミリ秒>」（Windows の CI のテストだけ）
 */
function micWatchScript({ root = MIC_ROOT, self = '', apps = MEET_APPS, everyMs = 2000, parent = 0, timing = false } = {}) {
  const selfKey = String(self || '').replace(/\\/g, '#').toLowerCase();
  const exeMap = apps.flatMap((a) => a.exe.map((e) => `${psq(e)} = ${psq(a.id)}`)).join('; ');
  const pkgMap = apps.flatMap((a) => a.pkg.map((k) => `${psq(k.toLowerCase())} = ${psq(a.id)}`)).join('; ');
  const procMap = apps.map((a) => `${psq(a.id)} = @(${a.proc.map(psq).join(', ')})`).join('; ');
  const order = apps.map((a) => psq(a.id)).join(', ');
  const every = Math.max(200, Math.floor(Number(everyMs)) || 2000);
  const ppid = Math.max(0, Math.floor(Number(parent)) || 0);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$root = ${psq(root)}`,
    `$self = ${psq(selfKey)}`,
    `$exeMap = @{ ${exeMap} }`,
    `$pkgMap = @{ ${pkgMap} }`,
    `$procMap = @{ ${procMap} }`,
    `$order = @(${order})`,
    // 0.9.4 D-1: 読むたびに書く（前と同じ行も書く）。判断（nudgeStep）は同じ使いを2回読んでから出すので、変わったときだけ書くと会議のアプリだけが
    // マイクを使い続けるときに2回目が来ず、パネルが出なかった（持ち主の engine.log で確かめた）
    'function Say($t) { [Console]::Out.WriteLine($t); [Console]::Out.Flush() }',
    'function Get-Use($k) {',
    '  try {',
    "    if ($k.GetValueKind('LastUsedTimeStart') -ne [Microsoft.Win32.RegistryValueKind]::QWord) { return $null }",
    "    if ($k.GetValueKind('LastUsedTimeStop') -ne [Microsoft.Win32.RegistryValueKind]::QWord) { return $null }",
    "    $a = [int64]$k.GetValue('LastUsedTimeStart'); $b = [int64]$k.GetValue('LastUsedTimeStop')",
    '    if ($b -eq 0 -and $a -ne 0) { return $a }',
    '  } catch { }',
    '  return $null',
    '}',
    'function Add-Use($found, $id, $k) { $u = Get-Use $k; if ($u -ne $null) { if (-not $found.ContainsKey($id) -or $found[$id] -lt $u) { $found[$id] = $u } } }',
    'while ($true) {',
    ...(ppid ? [`  try { [void][System.Diagnostics.Process]::GetProcessById(${ppid}) } catch { exit 0 }`] : []),
    ...(timing ? ['  $sw = [System.Diagnostics.Stopwatch]::StartNew()'] : []),
    '  $found = @{}',
    '  $bad = $false',
    '  try {',
    '    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($root)',
    '    if ($k -ne $null) {',
    '      foreach ($n in $k.GetSubKeyNames()) {',
    "        if ($n -eq 'NonPackaged') {",
    '          $np = $k.OpenSubKey($n)',
    '          if ($np -eq $null) { continue }',
    '          foreach ($m in $np.GetSubKeyNames()) {',
    '            $low = $m.ToLowerInvariant()',
    '            if ($low -eq $self) { continue }',
    "            $leaf = $low.Substring($low.LastIndexOf('#') + 1)",
    '            if (-not $exeMap.ContainsKey($leaf)) { continue }',
    '            $sk = $np.OpenSubKey($m)',
    '            if ($sk -eq $null) { continue }',
    '            Add-Use $found $exeMap[$leaf] $sk',
    '            $sk.Close()',
    '          }',
    '          $np.Close()',
    '        } else {',
    '          $low = $n.ToLowerInvariant()',
    '          if (-not $pkgMap.ContainsKey($low)) { continue }',
    '          $sk = $k.OpenSubKey($n)',
    '          if ($sk -eq $null) { continue }',
    '          Add-Use $found $pkgMap[$low] $sk',
    '          $sk.Close()',
    '        }',
    '      }',
    '      $k.Close()',
    '    }',
    "  } catch { $bad = $true; Say 'err read' }",
    '  if (-not $bad) {',
    '    try {',
    '      $items = @()',
    '      foreach ($id in $order) {',
    '        if (-not $found.ContainsKey($id)) { continue }',
    '        $alive = $false',
    '        foreach ($p in $procMap[$id]) { if ([System.Diagnostics.Process]::GetProcessesByName($p).Length -gt 0) { $alive = $true; break } }',
    "        if ($alive) { $items += ($id + ':' + $found[$id]) }",
    '      }',
    "      if ($items.Count -gt 0) { Say ('mic ' + ($items -join ',')) } else { Say 'mic -' }",
    "    } catch { Say 'err proc' }",
    '  }',
    ...(timing ? ["  [Console]::Out.WriteLine('t ' + $sw.ElapsedMilliseconds); [Console]::Out.Flush()"] : []),
    `  Start-Sleep -Milliseconds ${every}`,
    '}',
  ].join('\n');
}
// 見張りの1行を読む。一覧に無い id・数でない（0・負・小数・21 けた以上）start は落とす。同じ id は先のものだけ。形の悪い行・長すぎる行は null。
// start は FILETIME（1.3e17 ほどで Number の安全な整数を越える）なので、数字の文字のまま持つ（比べるのは同じかどうかだけ）
const MIC_LINE_MAX = 4096;
function parseMicLine(line) {
  if (typeof line !== 'string' || line.length > MIC_LINE_MAX) return null;
  const t = line.trim();
  const e = /^err (read|proc)$/.exec(t);
  if (e) return { kind: 'err', code: e[1] };
  if (t === 'mic -') return { kind: 'mic', items: [] };
  const m = /^mic (\S+)$/.exec(t);
  if (!m) return null;
  const items = [];
  for (const part of m[1].split(',')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const id = part.slice(0, i);
    const start = part.slice(i + 1);
    if (!MEET_BY_ID.has(id) || !/^[1-9]\d{0,19}$/.test(start) || items.some((x) => x.id === id)) continue;
    items.push({ id, start });
  }
  return { kind: 'mic', items };
}
// 出す・引っ込める・2度出さないの判断（決めたこと 5・6）。時刻は出来事の now だけを使う。
//  - 出すのは: idle・設定がオンでそのアプリを出さないにしていない・同じ (id, start) が2回続けて見えた・その (id, start) で出したことが無い・
//    同じアプリの前の使い（出した・閉じたもの）が終わってから NUDGE_REJOIN_MS たった・今パネルが出ていない。同時なら一覧の順の先
//  - 議事録の録音中（busy の meeting）に見えた使いは「録った会議」として、もう出さない。音声入力・作成中（busy の meeting でない）に始まった使いは
//    覚えておき、idle に戻ったときにまだ使っていれば1回だけ出す
//  - 引っ込めるのは: そのアプリがマイクを離した・出してから NUDGE_SHOW_MS（カーソルが乗っている間は数えず、離れてから NUDGE_HOVER_GRACE_MS）・
//    閉じた・録音が始まった・設定を切った／そのアプリを出さないにした
const NUDGE_SHOW_MS = 30000;
const NUDGE_HOVER_GRACE_MS = 5000;
const NUDGE_REJOIN_MS = 60000;
function nudgeInit({ on = true, mute = [] } = {}) {
  return { on: on !== false, mute: Array.isArray(mute) ? [...mute] : [], idle: true, meeting: false, active: {}, seen: {}, done: [], lastEnd: {}, shown: null };
}
function nudgeStep(st0, ev) {
  const st = JSON.parse(JSON.stringify(st0 || nudgeInit()));
  const out = { st, show: null, hide: false };
  if (!ev || typeof ev !== 'object') return out;
  const now = Number.isFinite(ev.now) ? ev.now : 0;
  const key = (id, start) => `${id}:${start}`;
  const done = (k) => st.done.includes(k);
  const markDone = (k) => { if (!done(k)) st.done.push(k); };
  const hideNow = () => { if (st.shown) { st.shown = null; out.hide = true; } };
  // 0.9.4 D-1: つなぎ直し（60 秒の間の新しい使い）で出さなかった使い（診断の符号 rejoin。前の版の st には無い）
  const markRejoin = (k) => { if (!Array.isArray(st.rejoin)) st.rejoin = []; if (!st.rejoin.includes(k)) st.rejoin.push(k); if (st.rejoin.length > 50) st.rejoin.shift(); };
  const pick = () => {
    if (!st.idle || !st.on || st.shown) return;
    for (const a of MEET_APPS) {
      const start = st.active[a.id];
      if (start === undefined || st.mute.includes(a.id)) continue;
      const k = key(a.id, start);
      if ((st.seen[k] || 0) < 2 || done(k)) continue;
      markDone(k);
      st.shown = { id: a.id, start, at: now, hover: false, leftAt: null };
      out.show = { id: a.id, label: a.label };
      return;
    }
  };
  if (ev.type === 'sample') {
    const items = Array.isArray(ev.items) ? ev.items.filter((x) => x && MEET_BY_ID.has(x.id) && typeof x.start === 'string') : [];
    const next = {};
    for (const x of items) if (!(x.id in next)) next[x.id] = x.start;
    for (const [id, start] of Object.entries(st.active)) {
      if (next[id] === start) continue;
      const k = key(id, start);
      if (done(k)) st.lastEnd[id] = now;   // 出した・閉じた使いが終わった（つなぎ直しを数える始まり）
      delete st.seen[k];
      if (st.shown && st.shown.id === id && st.shown.start === start) hideNow();
    }
    for (const [id, start] of Object.entries(next)) {
      const k = key(id, start);
      const fresh = st.active[id] !== start;
      st.seen[k] = fresh ? 1 : (st.seen[k] || 0) + 1;
      if (fresh && st.lastEnd[id] !== undefined && now - st.lastEnd[id] < NUDGE_REJOIN_MS) { markDone(k); markRejoin(k); }
      if (st.meeting) markDone(k);
    }
    st.active = next;
    pick();
  } else if (ev.type === 'busy') {
    st.idle = !ev.busy;
    st.meeting = Boolean(ev.busy && ev.meeting);
    if (ev.busy) {
      hideNow();
      if (st.meeting) for (const [id, start] of Object.entries(st.active)) markDone(key(id, start));
    } else pick();
  } else if (ev.type === 'setting') {
    st.on = ev.on !== false;
    st.mute = Array.isArray(ev.mute) ? ev.mute.filter((x) => MEET_BY_ID.has(x)) : [];
    if (st.shown && (!st.on || st.mute.includes(st.shown.id))) hideNow();
  } else if (ev.type === 'closed') {
    hideNow();
  } else if (ev.type === 'hover') {
    if (st.shown) {
      if (ev.on) { st.shown.hover = true; st.shown.leftAt = null; } else if (st.shown.hover) { st.shown.hover = false; st.shown.leftAt = now; }
    }
  } else if (ev.type === 'tick') {
    if (st.shown && !st.shown.hover) {
      const until = Math.max(st.shown.at + NUDGE_SHOW_MS, st.shown.leftAt === null ? 0 : st.shown.leftAt + NUDGE_HOVER_GRACE_MS);
      if (now >= until) hideNow();
    }
  }
  out.why = out.show ? '' : nudgeWhy(st);
  return out;
}
// 0.9.4 D-1（診断の記録）: マイクを使っている一覧のアプリがあるのにパネルを出していない理由の符号。出している・使っているアプリが無いときは ''。
// off（設定が切れている）・busy（録音中）・mute（通知を出さないアプリ）・rejoin（60 秒のつなぎ直し）・done（出した・閉じた使い）・wait（まだ1回しか読んでいない）
function nudgeWhy(st) {
  const ids = MEET_APPS.map((a) => a.id).filter((id) => st.active && st.active[id] !== undefined);
  if (!ids.length || st.shown) return '';
  if (!st.on) return 'off';
  if (!st.idle) return 'busy';
  let why = '';
  for (const id of ids) {
    const k = `${id}:${st.active[id]}`;
    if (st.mute.includes(id)) { why = why || 'mute'; continue; }
    if (st.done.includes(k)) { why = why || (Array.isArray(st.rejoin) && st.rejoin.includes(k) ? 'rejoin' : 'done'); continue; }
    if ((st.seen[k] || 0) < 2) return 'wait';
  }
  return why;
}
// パネルの置き場所（決めたこと 8）。size はパネルの画面が測ったカードの大きさ（CSS の px。有限の正の数でなければ NUDGE_FIRST）。窓はカードの周りに
// NUDGE_PAD の余白（明るいパネルの影の輪: K9）を足した大きさで、カードの右と上の端が作業領域の右と上の端から NUDGE_EDGE の所に来る。
// 幅と高さは作業領域 − 2 ×（NUDGE_EDGE − NUDGE_PAD）まで
const NUDGE_EDGE = 12;
const NUDGE_PAD = 8;
const NUDGE_FIRST = { w: 560, h: 60 };
function nudgeBounds({ size, workArea }) {
  const ok = size && typeof size.w === 'number' && typeof size.h === 'number' && Number.isFinite(size.w) && Number.isFinite(size.h) && size.w > 0 && size.h > 0;
  const s = ok ? size : NUDGE_FIRST;
  const gap = NUDGE_EDGE - NUDGE_PAD;
  const width = Math.min(Math.ceil(s.w) + 2 * NUDGE_PAD, workArea.width - 2 * gap);
  const height = Math.min(Math.ceil(s.h) + 2 * NUDGE_PAD, workArea.height - 2 * gap);
  return { x: workArea.x + workArea.width - gap - width, y: workArea.y + gap, width, height };
}
// 0.9.4 W-1（持ち主の答え「5本がそれぞれ揺れる」）: 録音バーと録音中のページの5本の高さ（px）。無音（0.02 以下・数でない）は同じ 4px の点が5つ。
// 声は重み（左右対称: 左に寄らない）× 1本ずつ違う速さと位相の揺れ（0.35〜1 倍）で 4〜16px。tMs が数でない（null）は揺らさない止めた形（動きを減らす設定）。
// overlay.html と app.html は main のファイルを読めないので同じ式を写す（test/stage094.wave が同じ値になることを見る）
const LEVEL_BAR_W = [0.75, 0.9, 1, 0.9, 0.75];
const LEVEL_BAR_SPEED = [7.1, 9.3, 5.7, 8.4, 6.6];
const LEVEL_BAR_PHASE = [0.3, 1.9, 0.8, 2.6, 1.4];
function levelBars(level, tMs) {
  if (!(typeof level === 'number' && level > 0.02)) return [4, 4, 4, 4, 4];
  return LEVEL_BAR_W.map((w, i) => {
    const g = typeof tMs === 'number' && Number.isFinite(tMs) ? 0.35 + 0.65 * Math.abs(Math.sin(LEVEL_BAR_PHASE[i] + (LEVEL_BAR_SPEED[i] * tMs) / 1000)) : 1;
    return Math.round(4 + 12 * Math.min(1, level * 1.6 * w * g));
  });
}
// 録音バーが答えた音の大きさの照らし（決めたこと 14）。数は 0〜1 に収めて小数 2 けた、warn は決まった3つのほかは ''（画面は文を作らない）
const LEVEL_ASK_MS = 100;
const LEVEL_WARNS = Object.freeze(['', '音が入っていません', 'マイクの音が入っていません']);
function levelMsg(p) {
  const o = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 100) / 100 : 0);
  return { mic: num(o.mic), sys: num(o.sys), warn: typeof o.warn === 'string' && LEVEL_WARNS.includes(o.warn) ? o.warn : '' };
}

// ---------------------------------------------------------------- 0.9.4 S-1（計画 docs/plans/2026-10-22-094.md の決めたこと 1・7〜10・16・31）
// PC（手元の whisper）の失敗の種類。late = 自前の時間切れ（localhttp の印 late・TimeoutError・AbortError）と、古い道の undici の時間切れ
// （UND_ERR_HEADERS_TIMEOUT・UND_ERR_BODY_TIMEOUT）。down = エンジンに届かない・切れた（ECONNREFUSED・ECONNRESET・EPIPE・UND_ERR_SOCKET・
// engineMissing）。error = エンジンが答えた誤り（HTTP の誤り・{"error"}・読めない答え）と物でないもの
const LATE_CODES = ['LOCAL_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'];
const DOWN_CODES = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'];
/** → 'late' | 'down' | 'error' */
function localFailKind(e) {
  if (!e || typeof e !== 'object') return 'error';
  const code = (e.cause && typeof e.cause === 'object' && e.cause.code) || e.code || '';
  if (e.late === true || e.name === 'TimeoutError' || e.name === 'AbortError' || LATE_CODES.includes(code)) return 'late';
  if (e.engineMissing === true || DOWN_CODES.includes(code)) return 'down';
  return 'error';
}
// 遅い PC の判断のしきい値（問い Q1・Q2 の既定）。over: 1.0 を越える区間が2つ続く・big: 1つでも 1.5 を越える・backlogMs: PC の待ちの音声の合計・
// exit: 測った数（bench）がこれ以下なら遅いを外す・ttlMs: 覚えの期限（14 日）・alpha: rtf の移動平均の重み
const PACE = Object.freeze({ over: 1.0, big: 1.5, backlogMs: 240000, exit: 0.6, ttlMs: 14 * 24 * 3600 * 1000, alpha: 0.5 });
const PACE_WINDOW_MS = 30000;   // whisper は 30 秒の窓で処理する（15 秒の区間も 30 秒分の計算をする）
/** 速さ = 処理 ÷ max(音声, 30 秒)（小数2桁）。数でない・音声が 0 以下・処理が負なら null */
function effRtf(t) {
  if (!t || typeof t !== 'object') return null;
  const { audioMs, procMs } = t;
  if (typeof audioMs !== 'number' || typeof procMs !== 'number' || !Number.isFinite(audioMs) || !Number.isFinite(procMs) || audioMs <= 0 || procMs < 0) return null;
  return Math.round((procMs / Math.max(audioMs, PACE_WINDOW_MS)) * 100) / 100;
}
const sameModel = (a, b) => Boolean(a && b && typeof a.name === 'string' && a.name && a.name === b.name && Number.isFinite(a.size) && a.size === b.size);
const paceInit = () => ({ slow: false, why: '', run: 0, rtf: null, samples: 0 });
/**
 * 会議ごとの遅い PC の判断（純粋。時刻は ev.now だけ）。ev: { kind: 'sample', audioMs, procMs } | { kind: 'late' } | { kind: 'backlog', audioMs } |
 * { kind: 'start', saved, model, now } → { st, slow, why }。一度遅いになったら会議の中は戻らない（start で数え直す）
 */
function paceStep(st, ev) {
  const cur = st && typeof st === 'object' ? { ...paceInit(), ...st } : paceInit();
  const out = (x) => ({ st: x, slow: x.slow, why: x.why });
  if (!ev || typeof ev !== 'object') return out(cur);
  if (ev.kind === 'start') {
    const n = paceInit();
    const sv = ev.saved;
    if (sv && typeof sv === 'object' && sv.slow === true && sameModel(sv.model, ev.model) && Number.isFinite(sv.at) && Number.isFinite(ev.now)
      && ev.now - sv.at <= PACE.ttlMs) {
      n.slow = true; n.why = 'saved';
    }
    return out(n);
  }
  const slowNow = (why) => (cur.slow ? cur : { ...cur, slow: true, why });
  if (ev.kind === 'late') return out(slowNow('late'));
  if (ev.kind === 'backlog') return out(Number(ev.audioMs) > PACE.backlogMs ? slowNow('backlog') : cur);
  if (ev.kind !== 'sample') return out(cur);
  const r = effRtf(ev);
  if (r === null) return out(cur);
  const next = { ...cur, samples: cur.samples + 1, rtf: cur.rtf === null ? r : Math.round((cur.rtf + PACE.alpha * (r - cur.rtf)) * 100) / 100 };
  next.run = r > PACE.over ? cur.run + 1 : 0;
  if (cur.slow) return out(next);
  if (r > PACE.big) return out({ ...next, slow: true, why: 'big' });
  if (next.run >= 2) return out({ ...next, slow: true, why: 'two' });
  return out(next);
}
/**
 * 覚え（<userData>/data/local-pace.json）の中身。st は paceStep の st（live）か { rtf }（bench）。prev は前の覚え（別のモデルなら無いのと同じ）。
 * → { schema: 1, model: { name, size }, rtf, slow, at, from } | null（書かない: モデルが分からない・会議で PC に送っていない・始めから覚えで遅かった）
 */
function paceSaved(st, prev, { model, now, from } = {}) {
  if (!model || typeof model.name !== 'string' || !model.name || !Number.isFinite(model.size)) return null;
  const p = prev && typeof prev === 'object' && sameModel(prev.model, model) ? prev : null;
  const s = st && typeof st === 'object' ? st : {};
  const r = typeof s.rtf === 'number' && Number.isFinite(s.rtf) ? s.rtf : null;
  const mix = (x) => (p && typeof p.rtf === 'number' && Number.isFinite(p.rtf) ? Math.round((p.rtf + PACE.alpha * (x - p.rtf)) * 100) / 100 : x);
  const base = { schema: 1, model: { name: model.name, size: model.size } };
  if (from === 'bench') {
    if (r === null) return null;
    const slow = r > PACE.over ? true : r <= PACE.exit ? false : Boolean(p && p.slow);
    return { ...base, rtf: p && typeof p.rtf === 'number' && Number.isFinite(p.rtf) ? p.rtf : r, slow, at: now, from: 'bench' };
  }
  if (s.why === 'saved') return null;
  if (!s.slow && r === null) return null;
  return { ...base, rtf: r === null ? (p && Number.isFinite(p.rtf) ? p.rtf : null) : mix(r), slow: Boolean(s.slow), at: now, from: 'live' };
}
/** PC への要求の待ち時間 = min(30 分, max(240 秒, max(音声, 30 秒) × max(rtf, 1) × 2 + 60 秒))（rtf が無ければ 1） */
function localTimeoutMs({ audioMs, rtf } = {}) {
  const a = Math.max(Number.isFinite(audioMs) ? audioMs : 0, PACE_WINDOW_MS);
  const k = Math.max(Number.isFinite(rtf) ? rtf : 1, 1);
  return Math.min(1800000, Math.max(240000, Math.round(a * k * 2 + 60000)));
}
/** 会議の後に PC で文字起こしする目安（分）= 音声 × max(rtf, 1) を分に切り上げ */
function afterEtaMin({ audioMs, rtf } = {}) {
  const a = Math.max(0, Number.isFinite(audioMs) ? audioMs : 0);
  const k = Math.max(Number.isFinite(rtf) ? rtf : 1, 1);
  return Math.ceil(Math.round(a * k) / 60000);
}
// 中継の 5xx（server）が続いたら間を空ける（問い Q8 の既定）。2回続いたら 60 秒、その後も続けば 120・300・600 秒（上限）。
// クラウドで文字になった（code: 'ok'）ら 0 に戻す。server でない符号は数えない（続きも切らない）
const RELAY_HOLD_LADDER_MS = Object.freeze([60000, 120000, 300000, 600000]);
/** (st, { code, now }) → { st: { run, at }, holdMs } */
function relayHoldStep(st, { code, now } = {}) {
  const run = st && Number.isInteger(st.run) && st.run > 0 ? st.run : 0;
  if (code === 'ok') return { st: { run: 0, at: now }, holdMs: 0 };
  if (code !== 'server') return { st: { run, at: st && st.at }, holdMs: 0 };
  const n = run + 1;
  return { st: { run: n, at: now }, holdMs: n >= 2 ? RELAY_HOLD_LADDER_MS[Math.min(n - 2, RELAY_HOLD_LADDER_MS.length - 1)] : 0 };
}

// ---------------------------------------------------------------- 議事録の題名（0.10.0 SH-1・D71・決めたこと 140）
// 新しい議事録の題名「2026/10/16 10:00 の議事録」（月と日は 0 を付けない・時と分は 2 けた）。形はここの1か所で決め、main の fallbackTitle と
// 撮る道具の見本とテストの作り物が使う。offsetMin（分）を渡すとその時差の時刻（撮る道具は日本の時刻 540）、渡さなければ PC の時計の時刻。読めなければ ''
function meetingTitleAt(date, offsetMin) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const fixed = Number.isFinite(offsetMin);
  const t = fixed ? new Date(d.getTime() + offsetMin * 60000) : d;
  const [y, mo, day, h, mi] = fixed
    ? [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes()]
    : [t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes()];
  return `${y}/${mo}/${day} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')} の議事録`;
}

// ---------------------------------------------------------------- natsu:// の登録（0.10.0 LN-3・D72・決めたこと 144・設計書 L5）
// 起動のたびに、パックした NaTsu（NSIS で入れたもの）だけが、今の場所の exe で natsu:// を利用者ごとに登録する（HKCU。入れ直して場所が
// 変わったときに直す）。登録のコマンドは「"<exe>" -- "%1"」（-- の後ろは Chromium と Electron の引数として読まれない。リンクに -- で始まる
// 引数を混ぜて起動の引数を差し込む手口を止める）。開発の起動（パックしていない）は登録しない。→ { register, args }
const PROTOCOL = 'natsu';
const PROTOCOL_ARGS = Object.freeze(['--']);
function protocolPlan({ packaged, execPath, isDefault } = {}) {
  const register = packaged === true && typeof execPath === 'string' && execPath.length > 0 && isDefault !== true;
  return { register, args: [...PROTOCOL_ARGS] };
}

// ---------------------------------------------------------------- リンクで起こされたとき（0.10.0 LN-4・D72・決めたこと 145・146）
// 起動の引数の -- より後ろの、最初の natsu: で始まる引数だけを読む（ほかの引数は見ない。-- より前のリンクは Chromium の引数に混ぜられうる）。
// → { id, anchor }（読めた）・'bad'（natsu: の引数はあるが読めない）・null（リンクが無い）
function linkFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  const at = argv.indexOf('--');
  if (at < 0) return null;
  const s = argv.slice(at + 1).find((a) => typeof a === 'string' && /^natsu:/i.test(a.trim()));
  if (s === undefined) return null;
  return natsulink.parseNatsuLink(s) || 'bad';
}
// 2 秒に 5 回まで（越えたリンクは捨てる）。times は受けた時刻の並び（変えない）→ { ok, times }
const LINK_RATE_MS = 2000;
const LINK_RATE_MAX = 5;
function linkRate(times, now) {
  const recent = (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(t) && now - t < LINK_RATE_MS && t <= now);
  if (recent.length >= LINK_RATE_MAX) return { ok: false, times: recent };
  return { ok: true, times: [...recent, now] };
}

// ---------------------------------------------------------------- 2つの流れの文字起こし（0.12.0 SP-1。計画 docs/plans/2026-10-22-120.md の決めたこと 121〜141・146・147。D66）
// 相手の声を取り込む議事録では、録音バーがマイクと相手の声を別々に録り、main は流れごとに声の切れ目で区間を切らせ、無音を中継へ送らない。
// ここは Electron に頼らない判断だけ（区間の受けと鎖は main.js）。タイムラインと札は src/mcp/timeline.js（ここから出し直す）
const timeline = require('./mcp/timeline');
const VOICE_LEVEL = 0.02;      // 声あり・なしの境（録音バーの SILENT_LEVEL と同じ。repo が字面で照らす）
const FRAME_MAX_MS = 250;      // 1つの答えで数える長さの上限（答えが遅れても、まとめて数えない）
const PAUSE_CUT_MS = 700;      // 切れ目: 声の無い時間
const LONG_PAUSE_MS = 1500;    // 長い切れ目: 区間が短くても切る
const MIN_SEG_MS = 2000;       // 切れ目で切るときの区間の長さの下限
const IDLE_CUT_MS = 3000;      // 声の無いままの区間を切る長さ（捨てる: 決めたこと 125）
const PRE_ROLL_MS = 300;       // 最初の声の前に残す長さ
const BLEED_SHARE = 0.6;       // 回り込みとみなす文字の3つ組の割合（S9 (a)）
const BLEED_NEAR_MS = 3000;    // 回り込みを見る時刻の窓（前後）
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const unit = (v) => fin(v) && v >= 0 && v <= 1;
const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * 録音バーの level-ask の答えの照らし（決めたこと 134・135）→ { mic, sys, vMic, vSys, segMic, segSys, sysOk } か null（投げない）。
 * 数でない・0〜1 でない・区間の番号が -1 以上の整数でない・sysOk が真偽でない → null（その答えは数えない）
 */
function checkLevel(p) {
  if (!isPlain(p)) return null;
  const { mic, sys, vMic, vSys, segMic, segSys, sysOk } = p;
  if (![mic, sys, vMic, vSys].every(unit)) return null;
  if (![segMic, segSys].every((n) => Number.isSafeInteger(n) && n >= -1)) return null;
  if (typeof sysOk !== 'boolean') return null;
  return { mic, sys, vMic, vSys, segMic, segSys, sysOk };
}

/**
 * audio:segment の4つ目 { src, seg, t0, last } の照らし（決めたこと 135・147）→ 写しか null（null は「4つ目が無い」として今の1本の道）。
 * src は 'mic'・'loopback'・''（取り込みが切れた後のマイク）のどれか・seg は 0 以上の整数・last は真偽。t0 が数でない・負なら t0 だけ null
 * （その流れの長さの積みに倒す: segAtOf）。その会議で一度も相手の声を取り込めていなければ（sysEver が偽）mic・loopback を '' にする
 */
function checkSegMeta(meta, { sysEver } = {}) {
  if (!isPlain(meta)) return null;
  const { src, seg, t0, last } = meta;
  if (src !== 'mic' && src !== 'loopback' && src !== '') return null;
  if (!Number.isSafeInteger(seg) || seg < 0) return null;
  if (typeof last !== 'boolean') return null;
  return { src: sysEver === true ? src : '', seg, t0: fin(t0) && t0 >= 0 ? t0 : null, last };
}

/** 流れごと・区間ごとの声の数え（決めたこと 123）。voicedMs: 声のあった長さ・firstVoiceMs: 最初の声の位置（-1 は無い）・silentRunMs: 今の声の無い長さ・elapsedMs: 数えた長さ */
function vadStart() {
  return { voicedMs: 0, firstVoiceMs: -1, silentRunMs: 0, elapsedMs: 0 };
}
/**
 * 1つの答え（{ voiced, dtMs }。dtMs は 0〜FRAME_MAX_MS に丸める）→ { st, cut }。cut は '' | 'pause' | 'idle'（受けた物を書き換えない）:
 * pause は声のあった区間で、声の無い時間が LONG_PAUSE_MS 以上か、PAUSE_CUT_MS 以上で区間が MIN_SEG_MS 以上。idle は声の無いまま IDLE_CUT_MS
 */
function vadStep(st, ev) {
  const s0 = isPlain(st) ? st : {};
  const num = (v, d) => (fin(v) ? v : d);
  const next = { voicedMs: num(s0.voicedMs, 0), firstVoiceMs: num(s0.firstVoiceMs, -1), silentRunMs: num(s0.silentRunMs, 0), elapsedMs: num(s0.elapsedMs, 0) };
  const e = isPlain(ev) ? ev : {};
  const dt = fin(e.dtMs) ? Math.min(FRAME_MAX_MS, Math.max(0, e.dtMs)) : 0;
  if (e.voiced === true) {
    if (next.firstVoiceMs < 0 && dt > 0) next.firstVoiceMs = next.elapsedMs;
    next.voicedMs += dt;
    next.silentRunMs = 0;
  } else {
    next.silentRunMs += dt;
  }
  next.elapsedMs += dt;
  let cut = '';
  if (next.voicedMs > 0) {
    if (next.silentRunMs >= LONG_PAUSE_MS || (next.silentRunMs >= PAUSE_CUT_MS && next.elapsedMs >= MIN_SEG_MS)) cut = 'pause';
  } else if (next.elapsedMs >= IDLE_CUT_MS) {
    cut = 'idle';
  }
  return { st: next, cut };
}
function vadSummary(st) {
  const s = isPlain(st) ? st : {};
  return { voicedMs: fin(s.voicedMs) ? s.voicedMs : 0, firstVoiceMs: fin(s.firstVoiceMs) ? s.firstVoiceMs : -1 };
}

/** 頭の ms を除いた 16bit PCM の WAV（頭の 44 バイトを書き直す）。読めない WAV・ms が 0 以下か長さ以上はそのまま返す（決めたこと 125 (b)） */
function wavFrom(buffer, ms) {
  const p = pcmOf(buffer);
  if (!p || !fin(ms) || ms <= 0) return buffer;
  const cut = Math.round((p.rate * ms) / 1000);
  if (cut >= p.n) return buffer;
  const n = p.n - cut;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(p.rate, 24); b.writeUInt32LE(p.rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  buffer.copy(b, 44, p.body + cut * 2, p.body + p.n * 2);
  return b;
}

/**
 * 区間の始まりの時刻（決めたこと 124）: 録音バーの t0（「録っている時間」の時計）が数で、0 以上・その流れの前の区間の終わり −1 秒以上・
 * 会議の録った時間＋5 秒以下なら t0。違えばその流れの長さの積み（offsetMs）
 */
function segAtOf({ t0, prevEndMs, offsetMs, activeMs } = {}) {
  const fallback = fin(offsetMs) ? offsetMs : 0;
  if (!fin(t0) || t0 < 0) return fallback;
  if (fin(prevEndMs) && t0 < prevEndMs - 1000) return fallback;
  if (fin(activeMs) && t0 > activeMs + 5000) return fallback;
  return t0;
}
/** 2つの流れの会議の時計（決めたこと 140）: どちらかの流れの区間の終わりの一番遅い値（和でない）。streams = { mic: { endMs }, loopback: { endMs } } */
function clockOf(streams) {
  let best = 0;
  for (const s of Object.values(isPlain(streams) ? streams : {})) if (isPlain(s) && fin(s.endMs) && s.endMs > best) best = s.endMs;
  return best;
}

/**
 * PC の whisper の文（verbose_json の segments: [{ start, end, text }]。秒）→ parts（[{ ms, at }]）か null（決めたこと 128・S5 (a)）。
 * 文ごとに区間の文と同じ直し（clean）をかけ、区間の文（text。直した後）の中を前から順に探して位置を決める（直して空になった文は行にしない）。
 * 時刻が無い・最後の end と区間の長さが 2 秒より大きくずれる・見つからない文がある・数が 2〜PARTS_MAX の外・ms か at が増えない → null
 */
function partsOf(sentences, { text, durationMs, clean } = {}) {
  if (!Array.isArray(sentences) || sentences.length < 2 || typeof text !== 'string') return null;
  const fix = typeof clean === 'function' ? clean : (t) => String(t || '').trim();
  if (!sentences.every((s) => isPlain(s) && fin(s.start) && fin(s.end) && s.start >= 0 && s.end >= s.start)) return null;
  const lastEnd = sentences[sentences.length - 1].end * 1000;
  // 点検の直し I1（決めたこと 128 の改め。持ち主 2026-10-25「最後が無音でも文の時刻を使う（おすすめ）」）: 倒すのは最後の文が音声より 2 秒より長くはみ出すときだけ。
  // 最後の文が音声の終わりより前に終わる（最後が無音の区間。VAD が飛ばした・黙っていた）ときは、文の時刻を使う
  if (!fin(durationMs) || lastEnd > durationMs + 2000) return null;
  const parts = [];
  let cursor = 0;
  for (const s of sentences) {
    const c = String(fix(String(s.text || '')) || '').trim();
    if (!c) continue;
    const idx = text.indexOf(c, cursor);
    if (idx < 0) return null;
    const p = parts.length ? { ms: Math.round(s.start * 1000), at: idx } : { ms: 0, at: 0 };
    const prev = parts[parts.length - 1];
    if (prev && (p.ms <= prev.ms || p.at <= prev.at)) return null;
    parts.push(p);
    cursor = idx + c.length;
  }
  if (parts.length < 2 || parts.length > timeline.PARTS_MAX) return null;
  return timeline.checkParts(parts, text, durationMs);
}

/**
 * 回り込みの割合（決めたこと 129）: マイクの行の文（畳んだ形）の文字の3つ組のうち、相手の行のどれかの文に含まれるものの割合（0〜1）。
 * 畳んだ文が3字より短い・空・相手の行が無い → 0（短い相づちは自分の声として残す）
 */
function bleedOf(micText, loopTexts) {
  const grams = (s) => { const out = []; for (let i = 0; i + 3 <= s.length; i++) out.push(s.slice(i, i + 3)); return out; };
  const mic = hintFold(micText);
  if (mic.length < 3 || !Array.isArray(loopTexts)) return 0;
  const have = new Set();
  for (const t of loopTexts) for (const g of grams(hintFold(t))) have.add(g);
  if (!have.size) return 0;
  const g = grams(mic);
  return g.filter((x) => have.has(x)).length / g.length;
}

/**
 * 無音で止める見張りの合わせ（決めたこと 133）: 流れごとの区間の出来事 { src, kind: 'speech' | 'quiet' | 'end', endMs } → { st, feed }。
 * feed は quietStep に渡す出来事の並び。話し声はすぐ渡し（どちらの流れでも止めない側へ）、無音は「終わっていない流れの済んだ区間の終わりの小さい方」
 * （決まった時間）が最後の話し声より後のときだけ、そこまでを渡す。end はその流れが終わった（相手の声の取り込みが切れた）印で、以後は残りの流れだけで見る
 */
function quietUnion(st, ev) {
  const s0 = isPlain(st) ? st : {};
  const ends = { mic: 0, loopback: 0, ...(isPlain(s0.ends) ? s0.ends : {}) };
  const ended = { ...(isPlain(s0.ended) ? s0.ended : {}) };
  const next = { ends, ended, speech: fin(s0.speech) ? s0.speech : 0, fedSpeech: fin(s0.fedSpeech) ? s0.fedSpeech : 0, fed: fin(s0.fed) ? s0.fed : 0 };
  const e = isPlain(ev) ? ev : {};
  if (e.src !== 'mic' && e.src !== 'loopback') return { st: next, feed: [] };
  const end = fin(e.endMs) ? e.endMs : 0;
  next.ends[e.src] = Math.max(next.ends[e.src], end);
  if (e.kind === 'speech') next.speech = Math.max(next.speech, end);
  if (e.kind === 'end') next.ended[e.src] = true;
  const live = ['mic', 'loopback'].filter((k) => !next.ended[k]);
  const decided = live.length ? Math.min(...live.map((k) => next.ends[k])) : Math.max(next.ends.mic, next.ends.loopback);
  const feed = [];
  if (next.speech > next.fedSpeech) { feed.push({ kind: 'speech', endMs: next.speech }); next.fedSpeech = next.speech; }
  if (decided > next.fed && decided > next.speech) { feed.push({ kind: 'quiet', endMs: decided }); next.fed = decided; }
  return { st: next, feed };
}

/**
 * 2つの流れの会議の止まりの見張り（決めたこと 141）: { spanMs, n }（音のある空の区間の長さの和と数）。文のある区間 → 0 に戻る・
 * 音のある空 → 足す・音の無い空 → そのまま。和が STALL_SPAN_MS 以上で区間が 2 つ以上なら stall（区間の数では決めない）
 */
function stallStepMs(st, { text, levelDbfs, durationMs } = {}) {
  const s0 = isPlain(st) ? st : {};
  const cur = { spanMs: fin(s0.spanMs) && s0.spanMs > 0 ? s0.spanMs : 0, n: Number.isSafeInteger(s0.n) && s0.n > 0 ? s0.n : 0 };
  if (text) return { st: { spanMs: 0, n: 0 }, stall: false };
  if (!(Number(levelDbfs) > STALL_MIN_DBFS)) return { st: cur, stall: false };
  const next = { spanMs: cur.spanMs + (fin(durationMs) && durationMs > 0 ? durationMs : 0), n: cur.n + 1 };
  return { st: next, stall: next.spanMs >= STALL_SPAN_MS && next.n >= 2 };
}

module.exports = {
  PROTOCOL, protocolPlan, linkFromArgv, linkRate,
  STATE_NAMES: SL.STATE_NAMES, BY_NAMES: SL.BY_NAMES, stateLogAdd: SL.stateLogAdd, cleanStateLog: SL.cleanStateLog, stateLogLine: SL.stateLogLine,
  meetingTitleAt,
  saveIfExists, meetingDurationSec, promptTail,
  registerHotkeys, hotkeyFailureMessage, hotkeyStatus, resolveStartupHotkeys, saveHotkeys,
  makeSummaryRunner, tickStep,
  pasterScript, copyCommand, restoreAfterPaste, parsePasterLine,
  COPY_SETTLE_MS, RESTORE_DELAY_MS, readClip, clipEquals, copyPrivate, deliverText,
  engineFileIssue, engineIssueMessage, engineInAppDir, engineDirWarning, portInUseError,
  isAscii, engineSpawnPlan,
  peFileVersion, vcRuntimeVersions, vcRuntimeIssue, runtimeGate, engineExitHint, spawnErrorHint, speedLine,
  ENGINE_SETTING_KEYS, guardEngineSettings, keptDifferent, closeConfirm, restartBlock, logReason,
  PICK_KEYS, pickDefaultPath,
  truncationMessage, buildPromptParts,
  publicSegments, settledSegments, pendingDurationMs, recoverSegments, staleSegbufDirs,
  nextSegmentMs, EtaTracker, skipPendingSegments, SKIP_KEPT_TEXT,
  ONLINE_SEGMENT_SEC, OVERLAY_SEG_MIN_MS, SEG_SWITCH_AFTER, STICKY_LOCAL, startSegmentMode, segmentModeNext, segmentBaseMs, liveSegmentMs, nextLiveSegmentMs,
  cloudLikely, offlineChosen, DICTATION_REFUSE_TEXT, startPlan, dictationPlan, KEPT_CODES, keptCodeFor, KEPT_SUMMARY_TEXT,
  SUMMARY_WAIT_TEXT, summaryRetryPick, SUMMARY_LOCK_TEXT, summaryLock,
  STALL_SPAN_MS, STALL_MIN_DBFS, stallAfter, stallStep, PROBLEM_ORDER, sttProblemOf, problemForRoute,
  WIN_NOTIFY_CODES, WIN_NOTIFY_GAP_MS, notifyGate,
  OFFLINE_SHOW_MS, OFFLINE_CLEAR_MS, offlineBannerStep,
  idleEnginesToStop, silentWav, wavLevelDbfs, mergeSummaryType, typesForView, memoEvidence, buildClaudeInput, routeLabel,
  isLoopbackUrl, loopbackOnlyFetch,
  sameShas, keepPrevious, candStamp, repairIdsOf, pathUsedBy, fetchMinutesLeft,
  recordDictation, mergeHistory, chooseDraftName,
  accountMessage,
  // 0.9.0 レーン O（録音バー）
  PANEL_EDGE, PANEL_FIRST, slotForm, slotOrigin, nearestSlot, PANEL_PAD, PANEL_MAX, PANEL_QUIET_MS, panelBounds, snapsOnQuiet, keyLabel,
  // 0.9.1 Q-1（話し声の無い区間）
  QUIET_WIN_MS, QUIET_HOP_MS, SILENT_DBFS, SPEECH_DBFS, wavLoudestDbfs, HINT_TAIL_MIN, hintFold, hintEcho, QUIET_GRACE_MS, quietStep, quietTrimEnd, clockText,
  // 0.9.2 I-1（ヘルプセンターの記事）
  HELP_ARTICLES, helpPath,
  // 0.9.3 M-1（会議の検出と音の波）
  MEET_APPS, MIC_ROOT, micWatchScript, parseMicLine, NUDGE_SHOW_MS, NUDGE_HOVER_GRACE_MS, NUDGE_REJOIN_MS, nudgeInit, nudgeStep,
  NUDGE_EDGE, NUDGE_PAD, NUDGE_FIRST, nudgeBounds, LEVEL_ASK_MS, LEVEL_WARNS, levelMsg,
  LEVEL_BAR_W, LEVEL_BAR_SPEED, LEVEL_BAR_PHASE, levelBars,
  // 0.9.4 S-1（文字起こしの安定化）
  localFailKind, effRtf, PACE, paceStep, paceSaved, localTimeoutMs, LOCAL_SEGMENT_MS_CAP, afterEtaMin, RELAY_TRANSIENT, RELAY_HOLD_LADDER_MS, relayHoldStep,
  // 0.12.0 SP-1（2つの流れの文字起こし。timeline.js の表と部品を出し直す）
  VOICE_LEVEL, FRAME_MAX_MS, PAUSE_CUT_MS, LONG_PAUSE_MS, MIN_SEG_MS, IDLE_CUT_MS, PRE_ROLL_MS, BLEED_SHARE, BLEED_NEAR_MS,
  checkLevel, checkSegMeta, vadStart, vadStep, vadSummary, wavFrom, segAtOf, clockOf, partsOf, bleedOf, quietUnion, stallStepMs,
  SOURCE_LABELS: timeline.SOURCE_LABELS, SPEAKER_LABELS: timeline.SPEAKER_LABELS, srcLabel: timeline.srcLabel, checkParts: timeline.checkParts,
  timelineOf: timeline.timelineOf, labeledLine: timeline.labeledLine,
};
