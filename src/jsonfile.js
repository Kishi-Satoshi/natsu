/*
 * jsonfile.js — DB の外の JSON（設定・履歴・下書き・控えなど）を読み書きする部品（第1a回 JS1〜JS3・RF20・RF22・RF23・P14）
 *
 * Electron を読まない。fs は呼ぶたびに opts.fs か require('fs') から引く（試しで差し替えるため）。
 *
 * 読んだ結果は次の4つのどれか。決して投げない（起動の途中で投げると、単一起動の鍵を
 * 持ったまま窓が出ない）。
 *   { state: 'missing' }                 ファイルが無い（ENOENT・ENOTDIR）
 *   { state: 'ok', value }               読めた
 *   { state: 'broken', reason }          壊れている（'encoding' | 'json' | 'shape' | 'too-large'）
 *   { state: 'unreadable', code }        読めない（ほかのプログラムが掴んだまま・フォルダ・そのほか）
 * 「壊れている」と「読めない」を分けるのが要。一瞬読めなかっただけのファイルを既定で
 * 上書きしないよう、呼び手は「読めない」間は書かない（RF22）。
 *
 * 出典:
 *  - 今の src/store.js の readJson と src/main.js の loadJson（無いと壊れているを分け、
 *    壊れていたら名前を変えて退ける。退けた名前の形は store.js と同じ）。
 *  - Node の TextDecoder（fatal: true で、正しくないバイト列は置き換えずに投げる。
 *    'utf-16le'・'utf-16be' を持つ）。
 *  - PowerShell 5.1 の文字コードの資料（Out-File・Set-Content の既定は UTF-16LE や ANSI、
 *    -Encoding UTF8 は BOM 付き）。メモ帳や PowerShell で保存し直した設定を読むため、
 *    BOM 付き UTF-8・BOM 付き UTF-16LE／BE を読み、BOM の無いものは UTF-8 として読む。
 *    CP932（ANSI）の日本語は UTF-8 として正しくないので、化けさせずに「壊れている」にする。
 *
 * 書くのは writeJsonFile（JS3）。同じフォルダの一時ファイル <名前>.<pid>-<乱数>.tmp を 'wx' で開き、
 * 全部書いて fsync して閉じてから名前を変える。電源が切れても古いか新しいかのどちらかが残る。
 * 掴まれて名前を変えられなければ RENAME_WAITS の順に待ってやり直し、だめなら一時ファイルを消して
 * 元を残したまま投げる（直接上書きには決して落とさない。呼び手が扱う）。読み取り専用の印の
 * ファイルには書かず、e.readOnly = true を付けて投げる（P14）。
 *  - Node の fs（openSync の 'wx' は有れば EEXIST、fsyncSync、Windows の chmod は書き込みの印だけが効く）。
 *  - 今の src/main.js の saveJson と src/store.js の writeJson（一時ファイルに書いて名前を変える形）。
 *
 * 退けた控えの整理は pruneBroken（JS2。作り直せるファイルだけ新しい3つまで）、写しで退けるのは
 * quarantine の copy（JS6。同じ中身の控えがあれば写さない）、強制終了の後の一時ファイルの片付けは
 * cleanTemps（JS4。JSON の一時ファイルだけ）。続けて変わるもののまとめ書きは makeBatchWriter（JS7）、
 * シャットダウンなどの合図で全部を書き出すのは flushAll（JS8。同期・投げない）。
 *
 * JSON のエラーの文は結果にも記録にも写さない（ファイルの中身を引用するため。口述した文や
 * 設定の値が記録に残ってしまう）。結果に入れるのは理由の符号だけ。
 */
'use strict';

const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
const READ_WAITS = [50, 100, 150, 200, 250, 250];   // 合わせて 1000ms。試すのは 1 + 6 回
const RENAME_WAITS = [20, 40, 60, 80, 100, 200];    // 合わせて 500ms（Task 1-2 の書く部品でも使う）
const SMALL_MAX = 256 * 1024;                        // 設定と画面の覚え書きの大きさの上限（JS1）

const fsOf = (o) => (o && o.fs) || require('fs');
// 既定の sleep は呼ぶたびに module.exports.sleepSync を引く（mainrun の場面が待ちを縮めるために差し替える）
const defaultSleep = (ms) => module.exports.sleepSync(ms);

let sab = null;
function sleepSync(ms) {
  const n = Math.max(0, Math.min(Number(ms) || 0, 1000));
  if (!n) return;
  try {
    if (!sab) sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, n);
    return;
  } catch (_) { /* Atomics.wait が使えない所では短い空回り */ }
  const end = Date.now() + n;
  while (Date.now() < end) { /* 待つ */ }
}

function decodeJsonBytes(buf) {
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    let enc = 'utf-8';
    let start = 0;
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { start = 3; }
    else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) { enc = 'utf-16le'; start = 2; }
    else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { enc = 'utf-16be'; start = 2; }
    // ignoreBOM: true で、落とした BOM の後にもう一つあっても黙って消さない（そのまま文字に残し、JSON の誤りになる）
    const text = new TextDecoder(enc, { fatal: true, ignoreBOM: true }).decode(b.subarray(start));
    return { ok: true, text };
  } catch (_) {
    return { ok: false };
  }
}

function readJsonFile(file, opts = {}) {
  const fs = fsOf(opts);
  const sleep = opts.sleep || defaultSleep;
  const waits = opts.waits || READ_WAITS;
  const maxBytes = opts.maxBytes == null ? Infinity : opts.maxBytes;
  const shape = opts.shape || (() => true);
  let buf;
  for (let i = 0; ; i++) {
    try {
      buf = fs.readFileSync(file);
      break;
    } catch (e) {
      const code = (e && e.code) || 'UNKNOWN';
      if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing' };
      if (BUSY.has(code) && i < waits.length) {
        try { sleep(waits[i]); } catch (_) { /* 待ちの失敗では止めない */ }
        continue;
      }
      return { state: 'unreadable', code };
    }
  }
  if (buf.length > maxBytes) return { state: 'broken', reason: 'too-large' };
  const d = decodeJsonBytes(buf);
  if (!d.ok) return { state: 'broken', reason: 'encoding' };
  let value;
  try { value = JSON.parse(d.text); } catch (_) { return { state: 'broken', reason: 'json' }; }
  let good = false;
  try { good = Boolean(shape(value)); } catch (_) { good = false; }
  if (!good) return { state: 'broken', reason: 'shape' };
  return { state: 'ok', value };
}

// 退けた名前。store.js と同じ形（ISO の時刻の ':' '.' を '-' に。Windows は ':' を許さない）。重なれば -2, -3 …
function brokenName(file, date = new Date(), exists = (p) => require('fs').existsSync(p)) {
  const base = `${file}.broken-${date.toISOString().replace(/[:.]/g, '-')}`;
  if (!exists(base)) return base;
  for (let n = 2; ; n++) {
    const p = `${base}-${n}`;
    if (!exists(p)) return p;
  }
}

// 同じフォルダにある、file と同じバイトの `${basename}.broken-*` のパス。無い・調べられなければ null
function sameBrokenCopy(file, fs) {
  const path = require('path');
  let bytes;
  let names;
  try {
    bytes = fs.readFileSync(file);
    names = fs.readdirSync(path.dirname(file));
  } catch (_) { return null; }
  const prefix = `${path.basename(file)}.broken-`;
  for (const n of names.filter((x) => x.startsWith(prefix)).sort()) {
    const p = path.join(path.dirname(file), n);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size === bytes.length && fs.readFileSync(p).equals(bytes)) return p;
    } catch (_) { /* 読めない控えは比べない */ }
  }
  return null;
}

// 壊れたファイルを写さずに名前を変えて脇へ退ける。中身は1バイトも変えない。
// copy が真なら名前を変えずに写す（JS6: 読めたファイルの一部を直したときの控え）。同じバイトの控えが
// もうあれば写さず { ok: true, to: そのパス, reused: true }（起動のたびに控えを重ねない）。
// 掴まれていれば waits の順に待ってやり直す。だめなら { ok: false, code }（投げない）。
function quarantine(file, opts = {}) {
  const fs = fsOf(opts);
  const now = opts.now || (() => new Date());
  const sleep = opts.sleep || defaultSleep;
  const waits = opts.waits || RENAME_WAITS;
  const copy = Boolean(opts.copy);
  if (copy) {
    const same = sameBrokenCopy(file, fs);
    if (same) return { ok: true, to: same, reused: true };
  }
  let to;
  try {
    to = brokenName(file, now(), (p) => fs.existsSync(p));
  } catch (e) {
    return { ok: false, code: (e && e.code) || 'UNKNOWN' };
  }
  for (let i = 0; ; i++) {
    try {
      // 写すときは COPYFILE_EXCL で、ほかの控えを決して上書きしない
      if (copy) fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL);
      else fs.renameSync(file, to);
      return { ok: true, to };
    } catch (e) {
      const code = (e && e.code) || 'UNKNOWN';
      if (BUSY.has(code) && i < waits.length) {
        try { sleep(waits[i]); } catch (_) { /* 待ちの失敗では止めない */ }
        continue;
      }
      return { ok: false, code };
    }
  }
}

// 退けた控えの整理（JS2）。作り直せるファイル（index.json・installed.json など）だけに使う。
// 消すのは `${basename}.broken-YYYY-MM-DDTHH-MM-SS-mmmZ(-n)?` の形だけで、新しい keep 個を残す。
// 今の形（ミリ秒の数）の .broken- と、ほかのファイルの控えは決して消さない。→ 消したパスの配列（投げない）
const BROKEN_STAMP = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)(?:-(\d+))?$/;
function pruneBroken(file, opts = {}) {
  const fs = fsOf(opts);
  const path = require('path');
  const k = Number(opts.keep == null ? 3 : opts.keep);
  const keep = Number.isFinite(k) ? Math.max(0, Math.floor(k)) : 3;
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.broken-`;
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const found = [];
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const m = BROKEN_STAMP.exec(n.slice(prefix.length));
    if (m) found.push({ n, stamp: m[1], seq: m[2] ? Number(m[2]) : 1 });
  }
  // 古い順（時刻の文字の順、同じ時刻なら -2・-3 … の数の順。-10 が -2 より前にならないように）
  found.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.seq - b.seq));
  const removed = [];
  for (const x of found.slice(0, Math.max(0, found.length - keep))) {
    const p = path.join(dir, x.n);
    try { fs.unlinkSync(p); removed.push(p); } catch (_) { /* 消せなければ次の機会に */ }
  }
  return removed;
}

// 読んで、壊れていれば退ける。退けられなければ「読めない」にする（壊れたファイルにも書かせない。RF22）。
function loadJsonFile(file, opts = {}) {
  const r = readJsonFile(file, opts);
  if (r.state !== 'broken') return r;
  const q = quarantine(file, { fs: opts.fs, now: opts.now, sleep: opts.sleep });
  if (q.ok) {
    // keep を渡したときだけ（作り直せるファイル）。設定・履歴・議事録の控えは消さない
    if (opts.keep != null) pruneBroken(file, { fs: opts.fs, keep: opts.keep });
    return { state: 'broken', reason: r.reason, movedTo: q.to };
  }
  return { state: 'unreadable', code: 'QUARANTINE_FAILED' };
}

// ---------------------------------------------------------------- 書く（JS3・RF20・P14）
const FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM']);
const TMP_TRIES = 4;   // 最初の1回と、名前がぶつかったとき（EEXIST）に名前を替えて3回まで

// stat して書き込みの印（0o200）が無ければ真。無いファイル・stat できないファイルは偽
function isReadOnly(file, fs = require('fs')) {
  try { return (fs.statSync(file).mode & 0o200) === 0; } catch (_) { return false; }
}

const readOnlyError = () => Object.assign(new Error('読み取り専用'), { code: 'EPERM', readOnly: true });
const tmpNameOf = (file) => `${file}.${process.pid}-${Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0')}.tmp`;

// → { written: true, text } | { written: false, text }（prevText と同じ中身なら書かない）。だめなら投げる（e.code はもとの符号）
function writeJsonFile(file, value, opts = {}) {
  const fs = fsOf(opts);
  const sleep = opts.sleep || defaultSleep;
  const waits = opts.waits || RENAME_WAITS;
  const doFsync = opts.fsync !== false;
  const dirFsync = opts.dirFsync == null ? process.platform === 'linux' : Boolean(opts.dirFsync);
  const onFsyncUnsupported = typeof opts.onFsyncUnsupported === 'function' ? opts.onFsyncUnsupported : () => {};
  const path = require('path');

  const text = JSON.stringify(value, null, 2);
  if (opts.prevText === text) return { written: false, text };
  // Windows では読み取り専用のファイルへの名前の変更が失敗し、Linux では通ってしまうので、両方で先に見る
  if (isReadOnly(file, fs)) throw readOnlyError();

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let tmp = null;
  let fd = null;
  try {
    for (let i = 0; ; i++) {
      const name = tmpNameOf(file);
      try {
        fd = fs.openSync(name, 'wx');
        tmp = name;
        break;
      } catch (e) {
        if (e && e.code === 'EEXIST' && i + 1 < TMP_TRIES) continue;
        throw e;
      }
    }
    fs.writeFileSync(fd, text, 'utf8');   // 1回の writeSync は途中までしか書かないことがあるため
    if (doFsync) {
      try { fs.fsyncSync(fd); } catch (e) {
        const code = (e && e.code) || 'UNKNOWN';
        if (!FSYNC_UNSUPPORTED.has(code)) throw e;
        try { onFsyncUnsupported(code); } catch (_) { /* 知らせの失敗では止めない */ }
      }
    }
    const closing = fd;
    fd = null;
    fs.closeSync(closing);
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        tmp = null;
        break;
      } catch (e) {
        const code = (e && e.code) || 'UNKNOWN';
        if (BUSY.has(code) && i < waits.length) {
          try { sleep(waits[i]); } catch (_) { /* 待ちの失敗では止めない */ }
          continue;
        }
        if (code === 'EPERM' && e && typeof e === 'object' && isReadOnly(file, fs)) e.readOnly = true;
        throw e;
      }
    }
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* 閉じられなくても消しに進む */ } }
    if (tmp != null) { try { fs.unlinkSync(tmp); } catch (_) { /* 消せなければ次の起動の cleanTemps に任せる */ } }
    throw e;
  }
  if (dirFsync) {
    // 名前の変更をフォルダにも書き付ける（Linux）。Windows ではフォルダを開けないので失敗は飲む
    let dfd = null;
    try { dfd = fs.openSync(dir, 'r'); fs.fsyncSync(dfd); } catch (_) { /* 飲む */ }
    if (dfd != null) { try { fs.closeSync(dfd); } catch (_) { /* 飲む */ } }
  }
  return { written: true, text };
}

// ---------------------------------------------------------------- 残った一時ファイルの片付け（JS4）
// 強制終了の後に残った JSON の一時ファイル（今の形の <名前>.json.tmp と、writeJsonFile の
// <名前>.json.<pid>-<乱数>.tmp）だけを消す。WAV の一時ファイルなどほかの .tmp は残す。
// → 消したパスの配列。フォルダが無い・読めなければ []（投げない）
const TEMP_RE = /^.+\.json(\.\d+-[0-9a-z]+)?\.tmp$/;
function cleanTemps(dir, opts = {}) {
  const fs = fsOf(opts);
  const path = require('path');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const removed = [];
  for (const e of entries) {
    if (!e.isFile() || !TEMP_RE.test(e.name)) continue;
    const p = path.join(dir, e.name);
    try { fs.unlinkSync(p); removed.push(p); } catch (_) { /* 掴まれていれば次の起動で */ }
  }
  return removed;
}

// ---------------------------------------------------------------- まとめ書き（JS7）と書き出しの合図（JS8）
// 1つのファイルに書き手を1つにし、続けて変わるもの（録音バーの位置など）は最後の値だけを delayMs 後に書く。
// write(value, { retry }) は同期で書く（投げてよい）。retry はタイマーなら false、flush・now なら true。
// タイマーの中では決して投げない（main の例外は Electron がエラーの画面にする）。失敗したら
// 「まだ書いていない」を残し、次の set・now・flush でやり直す。失敗の記録は続く間に1回だけで、
// 値は書かず、書き手の名前と理由の符号だけを書く。タイマーは unref する（終わるのを止めない）。
// 作った書き手はモジュールの中の一覧に入り、flushAll（シャットダウンなどの合図）で全部を同期で書き出す。
// 出典: Node の timers（Timeout の unref）、今の src/main.js の録音バーの位置の保存（setTimeout で間引く形）。
const writers = new Set();

function makeBatchWriter({ name, write, delayMs, timers = { setTimeout, clearTimeout }, log = () => {} }) {
  let timer = null;
  let has = false;
  let value;
  let failing = false;

  const stopTimer = () => {
    if (timer != null) { try { timers.clearTimeout(timer); } catch (_) { /* 止められなくても書き手の印で二重に書かない */ } }
    timer = null;
  };
  const fail = (e) => {
    if (failing) return;
    failing = true;
    try { log(`jsonfile: ${name} を書けなかった（${(e && e.code) || 'error'}）。次の機会にやり直す`); } catch (_) { /* 記録の失敗は飲む */ }
  };
  // 待っている値を書く。失敗は投げる（呼び手が扱う）。書けたら「まだ書いていない」を消す
  const writePending = (retry) => {
    stopTimer();
    if (!has) return;
    write(value, { retry });
    has = false;
    value = undefined;
    failing = false;
  };

  const w = {
    name,
    set(v) {
      value = v;
      has = true;
      stopTimer();
      timer = timers.setTimeout(() => {
        timer = null;
        try { writePending(false); } catch (e) { fail(e); }
      }, delayMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    now(v) {
      value = v;
      has = true;
      try { writePending(true); return { ok: true }; } catch (e) { fail(e); return { ok: false, error: e }; }
    },
    flush() {
      try { writePending(true); return true; } catch (e) { fail(e); return false; }
    },
    discard() {
      stopTimer();
      has = false;
      value = undefined;
    },
    pending() { return has; },
    dispose() {
      stopTimer();
      writers.delete(w);
    },
  };
  writers.add(w);
  return w;
}

// → [{ name, ok }]。作った全部の書き手の flush を呼ぶ。決して投げない（合図の受け口から呼ぶ）
function flushAll() {
  const out = [];
  for (const w of Array.from(writers)) {
    let ok = false;
    try { ok = w.flush() === true; } catch (_) { ok = false; }
    out.push({ name: w.name, ok });
  }
  return out;
}

module.exports = { BUSY, READ_WAITS, RENAME_WAITS, SMALL_MAX, sleepSync, decodeJsonBytes, readJsonFile, brokenName, quarantine, pruneBroken, loadJsonFile, isReadOnly, writeJsonFile, cleanTemps, makeBatchWriter, flushAll };
