/*
 * jsonfile.js — DB の外の JSON（設定・履歴・下書き・控えなど）を読む部品（第1a回 JS1・JS2・RF22・RF23）
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

// 壊れたファイルを写さずに名前を変えて脇へ退ける。中身は1バイトも変えない。
// 掴まれていれば waits の順に待ってやり直す。だめなら { ok: false, code }（投げない）。
function quarantine(file, opts = {}) {
  const fs = fsOf(opts);
  const now = opts.now || (() => new Date());
  const sleep = opts.sleep || defaultSleep;
  const waits = opts.waits || RENAME_WAITS;
  let to;
  try {
    to = brokenName(file, now(), (p) => fs.existsSync(p));
  } catch (e) {
    return { ok: false, code: (e && e.code) || 'UNKNOWN' };
  }
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(file, to);
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

// 読んで、壊れていれば退ける。退けられなければ「読めない」にする（壊れたファイルにも書かせない。RF22）。
function loadJsonFile(file, opts = {}) {
  const r = readJsonFile(file, opts);
  if (r.state !== 'broken') return r;
  const q = quarantine(file, { fs: opts.fs, now: opts.now, sleep: opts.sleep });
  if (q.ok) return { state: 'broken', reason: r.reason, movedTo: q.to };
  return { state: 'unreadable', code: 'QUARANTINE_FAILED' };
}

module.exports = { BUSY, READ_WAITS, RENAME_WAITS, SMALL_MAX, sleepSync, decodeJsonBytes, readJsonFile, brokenName, quarantine, loadJsonFile };
