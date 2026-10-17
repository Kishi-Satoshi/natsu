/*
 * engine-install.js — 取り込んだエンジンとモデルの置き場所・記録・使える組・状態（第0b回 R7）
 *
 * その1（Task 11）: ファイルを見るだけで決める部分。起動のときに使うので、通信もフォルダ作りもしない。
 *  - engineRoot         取り込み先 %LOCALAPPDATA%\natsu\engine（Roaming の %APPDATA% には置かない。
 *                       数 GB のモデルがプロファイルの同期で運ばれるため）。Windows の x64 だけ
 *  - layout             置き場所の並び（エンジンは版の名前のフォルダ、モデルは models の下）
 *  - readInstalled      installed.json を読む。読めない・schema が 1 でない → 空の記録（ファイルは消さない）
 *  - writeInstalled     installed.json を一時ファイルに書いてから名前を変える
 *  - planInstall        項目ごとに ready・changed・update・missing と、.download の .part の大きさ
 *  - managedCandidates  使える組の候補。今のピンの組がそろっていなければ、active に記録した前の組（RF13）
 *  - freeBytesOf        置き場所の空き（まだ無ければ、いちばん近い有る親のフォルダで測る）
 *  - statusOf           画面へ渡す写し
 *
 * その2（Task 12a）: zip の展開・記録・照らし。
 *  - sha256File         ファイルの SHA-256（流して読む。main を止めない）
 *  - installZip         zip からピンの files だけを <dir>.tmp に出し、大きさと SHA-256 を照らしてから <dir> に名前を変える。
 *                       1つでも違えば .tmp を消して hash（何も置かない）。<dir> が既にあれば、中を照らして同じなら使う
 *  - recordInstalled    installed.json の items[ピンの SHA-256] に、置いたものの記録を書く
 *  - verifyCandidates   使う前に、候補の exe と DLL を SHA-256 で、モデルと VAD を大きさと更新時刻で照らす（RF3）
 *
 * installed.json の形:
 *   { schema: 1, consent, userPaused,
 *     items: { [sha256]: { id, role, place, size, mtimeMs, files?: [{ name, size, mtimeMs, sha256 }] } },
 *     active: { whisper: [sha256, …] | null, sum: [sha256, …] | null } }
 *  - キーは id ではなくピンの SHA-256（ピンを上げた後も前の版の記録を残す。RF13）。
 *  - place は root からの `/` 区切りの相対パス。files は zip の中で使うファイルだけ（name は strip を外した名前）。
 *  - active は今使っている組（Task 14 が切り替えのときに書く）。
 *
 * 決まり:
 *  - Electron のモジュールは読み込まない。通信もしない（取り込むのは engine-fetch.js の fetchFile）。
 *  - 候補はまだ使わない。main は exe と DLL を SHA-256 で照らし終えてから使う（RF3。Task 12a・13）。
 *  - 画面に出す置き場所は %LOCALAPPDATA%\natsu\engine\… の形にして、利用者名を出さない。
 *    本当のパスは［担当に渡す内容を写す］の中身（report）にだけ入れる。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { hostOf } = require('./engine-manifest');
const { askIt, fetchErrorMessage } = require('./engine-fetch');
const { listZip, readEntry } = require('./zipread');

const GROUPS = ['whisper', 'sum'];
const SHOWN_ROOT = '%LOCALAPPDATA%\\natsu\\engine';
const APP_VERSION = (() => { try { return String(require('../package.json').version || ''); } catch (_) { return ''; } })();

const isObj = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o);
// ウイルス対策や索引の係が掴んでいるときの名前の変更の失敗（待って試し直す）
const RENAME_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** `/` 区切りの相対パスを分ける。空・`.`・`..`・絶対・ドライブ・`\` を含むものは null（root の外を指させない）。 */
function relParts(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes(':')) return null;
  const parts = rel.split('/');
  return parts.every((s) => s && s !== '.' && s !== '..') ? parts : null;
}

/** zip の項目の名前から strip を外した名前（置き場所のフォルダの中の名前）。 */
function stripped(item, name) {
  const s = item.strip || '';
  return s && name.startsWith(s) ? name.slice(s.length) : name;
}

// ---------------------------------------------------------------- 置き場所

/**
 * 取り込み先。Windows の x64 だけ supported。LOCALAPPDATA、無ければ USERPROFILE\AppData\Local。
 * 取り込めない PC では root は null（layout のパスもすべて null になる）。
 */
function engineRoot(env = {}, platform = process.platform, arch = process.arch) {
  const e = env || {};
  if (platform !== 'win32' || arch !== 'x64') {
    return { supported: false, root: null, reason: 'エンジンの取り込みは、Windows の 64 ビット版（x64）だけで使えます' };
  }
  const abs = (p) => (typeof p === 'string' && path.win32.isAbsolute(p) ? p : '');
  const base = abs(e.LOCALAPPDATA) || (abs(e.USERPROFILE) ? path.win32.join(e.USERPROFILE, 'AppData', 'Local') : '');
  if (!base) return { supported: false, root: null, reason: '取り込み先のフォルダ（%LOCALAPPDATA%）が分かりません' };
  return { supported: true, root: path.win32.join(base, 'natsu', 'engine'), reason: '' };
}

/**
 * 置き場所の並び。p は path（テストでは path.win32）。root が無ければパスはすべて null。
 * → { whisper: { dir, exe, model, vad }, sum: { dir, exe, model }, installed, notices, download }
 */
function layout(root, manifest, p = path) {
  const at = (rel) => { const parts = root ? relParts(rel) : null; return parts ? p.join(root, ...parts) : null; };
  const out = {};
  for (const g of GROUPS) {
    const its = manifest.items.filter((i) => i.group === g);
    const eng = its.find((i) => i.kind === 'zip');
    const model = its.find((i) => i.role === 'model');
    const vad = its.find((i) => i.role === 'vad');
    const dir = eng ? at(eng.dir) : null;
    const exe = dir && relParts(eng.exe) ? p.join(dir, ...relParts(eng.exe)) : null;
    out[g] = { dir, exe, model: model ? at(model.dest) : null };
    if (vad) out[g].vad = at(vad.dest);
  }
  out.installed = root ? p.join(root, 'installed.json') : null;
  out.notices = root ? p.join(root, 'THIRD-PARTY-NOTICES.txt') : null;
  out.download = root ? p.join(root, '.download') : null;
  return out;
}

// ---------------------------------------------------------------- installed.json

const emptyInstalled = () => ({ schema: 1, consent: false, userPaused: false, items: {}, active: { whisper: null, sum: null } });

/** installed.json を読む。読めない・schema が 1 でない → 空の記録。ファイルは消さない（次に書くときに置き換わる）。 */
function readInstalled(file) {
  let o;
  try { o = JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^﻿/, '')); } catch (_) { return emptyInstalled(); }
  if (!isObj(o) || o.schema !== 1) return emptyInstalled();
  const items = {};
  if (isObj(o.items)) for (const [k, v] of Object.entries(o.items)) if (isObj(v)) items[k] = v;
  const act = isObj(o.active) ? o.active : {};
  const shas = (a) => (Array.isArray(a) && a.length && a.every((s) => typeof s === 'string') ? a.slice() : null);
  return { ...o, schema: 1, consent: o.consent === true, userPaused: o.userPaused === true, items,
    active: { whisper: shas(act.whisper), sum: shas(act.sum) } };
}

// installed.json の名前の変更を試し直す前の待ち（合わせて 0.3 秒まで。同期なので main を長く止めない）
const INSTALLED_RENAME_WAITS = [20, 40, 80, 160];
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* 待てなければすぐ試す */ }
};

/**
 * installed.json を書く。一時ファイルに書いて確定してから名前を変える（途中で切れても前の記録が残る）。
 * 名前の変更が EPERM・EBUSY・EACCES なら少し待って試し直す（ウイルス対策が installed.json を開いているとき）。
 */
function writeInstalled(file, obj) {
  const data = `${JSON.stringify({ ...obj, schema: 1 }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(part, 'w');
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (let n = 0; ; n++) {
      try { fs.renameSync(part, file); break; } catch (e) {
        if (!e || !RENAME_BUSY.has(e.code) || n >= INSTALLED_RENAME_WAITS.length) throw e;
        sleepSync(INSTALLED_RENAME_WAITS[n]);
      }
    }
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch (_) { /* 残っても次に上書きする */ }
    throw e;
  }
}

// ---------------------------------------------------------------- 済んだもの

function statMatches(statFn, file, size, mtimeMs) {
  try {
    const st = statFn(file);
    return Boolean(st) && (typeof st.isFile !== 'function' || st.isFile()) && st.size === size && st.mtimeMs === mtimeMs;
  } catch (_) { return false; }
}

/**
 * 記録の置き場所が、記録の大きさと更新時刻のとおりか（zip はファイルごと）。
 * pin を渡すと、ピンと記録が食い違っていないこと（zip はピンの files が全部、同じ大きさと SHA-256 で記録にある）も見る。
 */
function recordMatches(rec, root, statFn, pin = null) {
  const parts = root && isObj(rec) ? relParts(rec.place) : null;
  if (!parts) return false;
  const at = path.join(root, ...parts);
  if (Array.isArray(rec.files)) {
    if (pin && pin.kind !== 'zip') return false;
    if (!rec.files.length) return false;
    for (const f of rec.files) {
      const fp = isObj(f) ? relParts(f.name) : null;
      if (!fp || !statMatches(statFn, path.join(at, ...fp), f.size, f.mtimeMs)) return false;
    }
    if (pin) {
      const byName = new Map(rec.files.map((f) => [f.name, f]));
      return pin.files.every((pf) => {
        const f = byName.get(stripped(pin, pf.name));
        return Boolean(f) && f.size === pf.size && String(f.sha256).toLowerCase() === String(pf.sha256).toLowerCase();
      });
    }
    return true;
  }
  if (pin && (pin.kind === 'zip' || rec.size !== pin.size)) return false;
  return statMatches(statFn, at, rec.size, rec.mtimeMs);
}

/**
 * 項目ごとに、どこまで済んでいるか。statFn は fs.statSync の形（無いファイルは投げる）。
 * → [{ id, group, state: 'ready' | 'changed' | 'update' | 'missing', held }]
 *  - ready:   ピンの SHA-256 の記録があり、置き場所の大きさと更新時刻が記録と合う（zip はファイルごと）
 *  - changed: ピンの SHA-256 の記録はあるが、大きさか更新時刻が違う・無い（取り直す前に、まず照らし直す）
 *  - update:  ピンの SHA-256 の記録は無いが、同じ id の前の記録がある（更新でピンが変わった）
 *  - missing: 同じ id の記録が1つも無い
 *  held は .download\<sha256>.part の大きさ（無ければ 0）。
 */
function planInstall(manifest, installed, statFn = fs.statSync, root = null) {
  const items = (installed && isObj(installed.items)) ? installed.items : {};
  const recs = Object.values(items);
  return manifest.items.map((it) => {
    const rec = items[it.sha256];
    let state;
    if (isObj(rec)) state = recordMatches(rec, root, statFn, it) ? 'ready' : 'changed';
    else state = recs.some((r) => isObj(r) && r.id === it.id) ? 'update' : 'missing';
    let held = 0;
    if (root) {
      try { held = Number(statFn(path.join(root, '.download', `${String(it.sha256).toLowerCase()}.part`)).size) || 0; } catch (_) { held = 0; }
    }
    return { id: it.id, group: it.group, state, held };
  });
}

// ---------------------------------------------------------------- 使える組

/** 記録の並びから候補を作る。エンジン（files のある記録）とモデルがそろわなければ null。 */
function candidateOf(root, manifest, shas, recs, current) {
  const eng = recs.find((r) => Array.isArray(r.files));
  const model = recs.find((r) => r.role === 'model');
  const vad = recs.find((r) => r.role === 'vad');
  if (!eng || !model) return null;
  // exe の名前はピンの同じ id の項目から。ピンから消えたか、新しいピンで exe の名前が変わって記録に無ければ、
  // 記録の中の唯一の .exe（前の組を使い続ける。RF13）。どちらも無ければ組にしない
  const pin = manifest.items.find((i) => i.id === eng.id && i.kind === 'zip');
  const exes = eng.files.filter((f) => /\.exe$/i.test(f.name));
  const exeName = pin && eng.files.some((f) => f.name === pin.exe) ? pin.exe : (exes.length === 1 ? exes[0].name : null);
  if (!exeName) return null;
  const at = (...rel) => path.join(root, ...rel.flatMap((r) => relParts(r)));
  const dir = at(eng.place);
  const c = { current, shas: shas.slice(), dir, exe: path.join(dir, ...relParts(exeName)), model: at(model.place) };
  if (vad) c.vad = at(vad.place);
  c.checkFiles = eng.files.filter((f) => /\.(exe|dll)$/i.test(f.name))
    .map((f) => ({ file: path.join(dir, ...relParts(f.name)), size: f.size, sha256: f.sha256 }));
  c.models = [model, vad].filter(Boolean).map((r) => ({ file: at(r.place), size: r.size, mtimeMs: r.mtimeMs }));
  return c;
}

/**
 * 使える組の候補（まだ照らしていない）。通信もフォルダ作りもしない。
 *  - 組の項目が全部 ready なら、今のピンの組（current: true）。
 *  - そうでなく、installed.active[group] の SHA-256 が全部記録にあり、置き場所が記録と合えば、前の組（current: false）。
 *  - どちらでもなければ null。
 * Cand = { current, shas, dir, exe, model, vad?, checkFiles: [{ file, size, sha256 }], models: [{ file, size, mtimeMs }] }
 *   checkFiles は exe と DLL（SHA-256 で照らす）、models はモデルと VAD（大きさと更新時刻で照らす）。
 */
function managedCandidates(home, manifest, installed, statFn = fs.statSync) {
  const out = { whisper: null, sum: null };
  if (!home || !home.supported || !home.root) return out;
  const root = home.root;
  const items = (installed && isObj(installed.items)) ? installed.items : {};
  for (const g of GROUPS) {
    const pins = manifest.items.filter((i) => i.group === g);
    if (pins.length && pins.every((it) => recordMatches(items[it.sha256], root, statFn, it))) {
      out[g] = candidateOf(root, manifest, pins.map((i) => i.sha256), pins.map((i) => items[i.sha256]), true);
    }
    if (out[g]) continue;
    const act = installed && installed.active && installed.active[g];
    if (Array.isArray(act) && act.length && act.every((s) => recordMatches(items[s], root, statFn))) {
      out[g] = candidateOf(root, manifest, act, act.map((s) => items[s]), false);
    }
  }
  return out;
}

// ---------------------------------------------------------------- その2: zip の展開・記録・照らし（Task 12a）

/** code 付きの失敗（code は engine-fetch の fetchErrorMessage の文に合わせる: hash・locked）。 */
const installError = (code, message, extra) => Object.assign(new Error(`取り込み: ${message}`), { code }, extra);
const RENAME_TRIES = 10;   // 名前の変更の試し（RENAME_BUSY のとき。待ちは 300ms から伸ばす）
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
const sameSha = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const rmTreeQuiet = (p) => fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});
const unlinkQuiet = (p) => fs.promises.unlink(p).catch(() => {});   // zip は1つのファイル（渡された先を丸ごと消さない）

/** ファイルの SHA-256（小文字の 16 進）。流して読むので、数十 MB でも main を止めない。 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}

/** zip の項目の、置き場所のフォルダの中の名前の部品（strip を外す）。外を指す名前は hash で断る。 */
function placeParts(item, name) {
  const parts = relParts(stripped(item, name));
  if (!parts) throw installError('hash', `置けない名前 ${JSON.stringify(name)}`, { file: name });
  return parts;
}

/**
 * dir の中の、ピンの files を大きさと SHA-256 で照らす。
 * 全部合えば [{ name, size, mtimeMs, sha256 }]（ピンの順。name は strip を外した名前）、1つでも違えば hash で投げる。
 */
async function checkPlaced(item, dir, hash) {
  const out = [];
  for (const f of item.files) {
    const file = path.join(dir, ...placeParts(item, f.name));
    let st = null;
    try { st = await fs.promises.stat(file); } catch (_) { st = null; }
    const got = st && st.isFile() && st.size === f.size ? await hash(file) : null;
    if (!got || !sameSha(got, f.sha256)) throw installError('hash', `${f.name} がピンと合わない`, { file });
    out.push({ name: stripped(item, f.name), size: st.size, mtimeMs: st.mtimeMs, sha256: String(got).toLowerCase() });
  }
  return out;
}

/** 名前の変更。EPERM・EBUSY・EACCES は 300ms から伸ばしながら 10 回まで試し、だめなら locked。 */
async function renameWithWait(rename, from, to, sleep) {
  for (let n = 1; ; n++) {
    try { await rename(from, to); return; } catch (e) {
      if (!e || !RENAME_BUSY.has(e.code)) throw e;
      if (n >= RENAME_TRIES) throw installError('locked', `${path.basename(to)} に名前を変えられない（${e.code}）`, { cause: e, file: to });
      await sleep(Math.min(300 * 2 ** (n - 1), 3000));
    }
  }
}

/** 中身を書いて確定する（名前を変えた後に電源が切れても、空のファイルを置かない）。 */
async function writeSynced(file, data) {
  const fh = await fs.promises.open(file, 'w');
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
}

/**
 * zip からピンの files だけを置く → { dir, files: [{ name, size, mtimeMs, sha256 }] }。
 *  1. <dir> が既にあれば（前に落ちた・記録が消えた）、中を照らす。全部同じならそれを使う（zip は消す。zip が無くてもよいので、
 *     記録の changed を取り直さずに照らし直すのにも使える）。
 *     違えば hash（動いているかもしれないフォルダを入れ替えない。版のフォルダはピンごとに違う名前なので、ふつうは起きない）。
 *  2. 無ければ、files の名前だけを <dir>.tmp に出し（strip を外す）、1つずつ大きさと SHA-256 を照らし、
 *     <dir>.tmp を <dir> に名前を変え（EPERM・EBUSY・EACCES は待って 10 回まで。だめなら locked）、zip を消す。
 *  失敗したら .tmp を消して投げる（何も置かない）。zip は残す（次は取り直さずに出し直せる）。
 *  記録は書かない（書くのは呼ぶ側の recordInstalled）。
 *  opts の sleep（待ち）と hash（照らし）はテストで差し替える。
 */
async function installZip(item, zipFile, root, { rename = fs.promises.rename, sleep = sleepDefault, hash = sha256File } = {}) {
  const dirParts = item && item.kind === 'zip' && root ? relParts(item.dir) : null;
  if (!dirParts || !Array.isArray(item.files) || !item.files.length) throw installError('hash', 'zip の項目のピンが読めない');
  const dir = path.join(root, ...dirParts);
  const tmpDir = `${dir}.tmp`;
  let have = false;
  try { await fs.promises.lstat(dir); have = true; } catch (_) { have = false; }
  try {
    if (have) {
      const files = await checkPlaced(item, dir, hash);
      await unlinkQuiet(zipFile);
      return { dir, files };
    }
    await rmTreeQuiet(tmpDir);   // 前に落ちたときの残り
    const buf = await fs.promises.readFile(zipFile);
    const entries = new Map(listZip(buf).map((e) => [e.name, e]));
    for (const f of item.files) {
      const parts = placeParts(item, f.name);
      const ent = entries.get(f.name);
      if (!ent) throw installError('hash', `zip に ${f.name} が無い`, { file: f.name });
      const out = path.join(tmpDir, ...parts);
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      await writeSynced(out, await readEntry(buf, ent));
    }
    const files = await checkPlaced(item, tmpDir, hash);
    await renameWithWait(rename, tmpDir, dir, sleep);
    await unlinkQuiet(zipFile);
    return { dir, files };
  } catch (e) {
    await rmTreeQuiet(tmpDir);
    throw e;
  }
}

/**
 * installed.json の items[item.sha256] に記録を書く（一時ファイル → 名前の変更）→ 書いた記録。
 *  - zip:      { id, role: 'engine', place: dir, size: zip の大きさ, mtimeMs: 0, files: info.files }（info は installZip の結果）
 *  - ファイル: { id, role, place: dest, size, mtimeMs }（置き場所を見て書く。大きさがピンと違えば hash で書かない）
 */
function recordInstalled(home, item, info = {}) {
  const root = home && home.root;
  if (!root || !item || !item.sha256) throw installError('hash', '記録する先か項目が分からない');
  let rec;
  if (item.kind === 'zip') {
    const files = info && Array.isArray(info.files) ? info.files : null;
    if (!relParts(item.dir) || !files || !files.length) throw installError('hash', `${item.id} の展開の結果が無い`);
    rec = { id: item.id, role: item.role || 'engine', place: item.dir, size: item.size, mtimeMs: 0,
      files: files.map((f) => ({ name: f.name, size: f.size, mtimeMs: f.mtimeMs, sha256: f.sha256 })) };
  } else {
    const parts = relParts(item.dest);
    if (!parts) throw installError('hash', `${item.id} の置き場所が読めない`);
    const file = path.join(root, ...parts);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size !== item.size) throw installError('hash', `${item.id} の大きさがピンと違う`, { file });
    rec = { id: item.id, role: item.role, place: item.dest, size: st.size, mtimeMs: st.mtimeMs };
  }
  const file = path.join(root, 'installed.json');
  const inst = readInstalled(file);
  inst.items[item.sha256] = rec;
  writeInstalled(file, inst);
  return rec;
}

/** 照らした結果。合えば null、無ければ 'missing'、違えば（読めないときも）'changed'。 */
async function fileIssue(file, same) {
  let st;
  try { st = await fs.promises.stat(file); } catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'missing' : 'changed'; }
  if (!st.isFile()) return 'missing';
  try { return (await same(st)) ? null : 'changed'; } catch (e) { return e && e.code === 'ENOENT' ? 'missing' : 'changed'; }
}

/**
 * 使う前の照らし（RF3）→ { whisper: Cand | null, sum: Cand | null, bad: [{ group, file, why: 'missing' | 'changed' }] }。
 *  - checkFiles（exe と DLL）は大きさと SHA-256 で照らす。大きさと更新時刻が同じでも、中身の違う DLL は見つける。
 *  - models（モデルと VAD）は大きさと更新時刻で照らす（数 GB を毎回読まない。取り込んだときに SHA-256 を照らし済み）。
 *  1つでも違えば、その組は null（使わない）で、違ったファイルを全部 bad に足す。候補の無い組は null のまま。
 *  順に読む（同時に読んで記録中の書き込みと競らない）。
 */
async function verifyCandidates(cands, { hash = sha256File } = {}) {
  const out = { whisper: null, sum: null, bad: [] };
  for (const g of GROUPS) {
    const c = cands && cands[g];
    if (!c) continue;
    const checks = Array.isArray(c.checkFiles) ? c.checkFiles : [];
    const bad = [];
    if (!checks.length) bad.push({ group: g, file: c.exe || c.dir || '', why: 'missing' });
    for (const f of checks) {
      const why = await fileIssue(f.file, async (st) => st.size === f.size && sameSha(await hash(f.file), f.sha256));
      if (why) bad.push({ group: g, file: f.file, why });
    }
    for (const m of Array.isArray(c.models) ? c.models : []) {
      const why = await fileIssue(m.file, async (st) => st.size === m.size && st.mtimeMs === m.mtimeMs);
      if (why) bad.push({ group: g, file: m.file, why });
    }
    out[g] = bad.length ? null : c;
    out.bad.push(...bad);
  }
  return out;
}

// ---------------------------------------------------------------- 空き

/** 置き場所の空き（bavail * bsize）。まだ無ければ、いちばん近い有る親のフォルダで測る。失敗は null。 */
async function freeBytesOf(root, statfs = fs.promises.statfs) {
  if (!root || typeof statfs !== 'function') return null;
  try {
    let d = path.resolve(root);
    for (;;) {
      try { await fs.promises.stat(d); break; } catch (_) {
        const up = path.dirname(d);
        if (up === d) break;
        d = up;
      }
    }
    const s = await statfs(d);
    const n = Number(s && s.bavail) * Number(s && s.bsize);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------- 画面へ渡す写し

// 取り込みの係（Task 12b）の写しのうち、そのまま画面の state にするもの
const RUNNER_STATES = new Set(['running', 'waiting', 'held', 'paused', 'error']);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function shownPlace(it) {
  const rel = it.kind === 'zip' ? it.dir : it.dest;
  return `${SHOWN_ROOT}\\${String(rel || '').split('/').join('\\')}`;
}

function fileNameOf(it) {
  if (it.kind !== 'zip' && it.dest) return String(it.dest).split('/').pop();
  try { return decodeURIComponent(new URL(it.url).pathname.split('/').pop()) || it.id; } catch (_) { return it.id; }
}

function osVersionDefault() {
  try { return [typeof os.version === 'function' ? os.version() : '', os.release()].filter(Boolean).join(' '); } catch (_) { return ''; }
}

/**
 * 画面へ渡す写し。通信もフォルダ作りもしない。
 *  runner は取り込みの係（Task 12b）の写し:
 *    { state: 'running' | 'waiting' | 'held' | 'paused' | 'error' | …, current: id | null,
 *      done: { [id]: 今の項目で持っているバイト数 }, bytesPerSec, etaSec, error: { code, message?, extra? } | null }
 *  manual は { whisper, sum }（詳細設定で手のパスを入れている組。取り込みの対象に数えない）。
 *  runtime は Visual C++ ランタイムの写し { level, message } | null（Task 10）。
 *  appVersion・osVersion は［担当に渡す内容を写す］に入れる版（省けばこの NaTsu と、この PC の Windows）。
 */
function statusOf({ home, manifest, plan = null, candidates = null, runner = null, manual = null, freeBytes = null, runtime = null,
  installed = null, appVersion = APP_VERSION, osVersion = osVersionDefault() } = {}) {
  const supported = Boolean(home && home.supported);
  const root = (home && home.root) || null;
  const inst = installed || emptyInstalled();
  const cands = candidates || { whisper: null, sum: null };
  const man = manual || { whisper: false, sum: false };
  const r = isObj(runner) ? runner : null;
  const steps = plan || planInstall(manifest, inst, fs.statSync, root);
  const stepOf = new Map(steps.map((p) => [p.id, p]));
  const live = r && isObj(r.done) ? r.done : {};

  const items = manifest.items.map((it) => {
    const p = stepOf.get(it.id) || { state: 'missing', held: 0 };
    // changed は残りに数える。照らし直して合えば取らずに済むが（Task 12b）、合わなければ全部取り直すので、少なく見せない
    const have = num(live[it.id]) != null ? live[it.id] : (Number(p.held) || 0);
    const done = p.state === 'ready' ? it.size : Math.max(0, Math.min(it.size, have));
    return { id: it.id, group: it.group, label: it.label, version: it.version, file: fileNameOf(it), url: it.url, host: hostOf(it.url),
      sha256: it.sha256, size: it.size, done, state: p.state, license: it.license, place: shownPlace(it) };
  });
  const targets = items.filter((i) => !man[i.group]);
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const totalBytes = sum(targets, (i) => i.size);
  const doneBytes = sum(targets, (i) => i.done);
  const needBytes = totalBytes - doneBytes;
  const whisperBytes = sum(items.filter((i) => i.group === 'whisper'), (i) => i.size);
  const updateBytes = sum(targets.filter((i) => i.state === 'update'), (i) => i.size - i.done);

  const using = {};
  for (const g of GROUPS) using[g] = cands[g] ? (cands[g].current ? 'current' : 'previous') : null;

  let error = null;
  if (r && isObj(r.error) && r.error.code) {
    error = { code: r.error.code, message: r.error.message || fetchErrorMessage(r.error.code, r.error.extra || {}) };
  }
  let state;
  if (!supported) state = 'unsupported';
  else if (r && RUNNER_STATES.has(r.state)) state = r.state;
  else if (error) state = 'error';
  else if (targets.every((i) => i.state === 'ready')) state = 'ready';
  else if (targets.some((i) => i.state === 'update' && cands[i.group] && !cands[i.group].current)) state = 'update';
  else if (targets.every((i) => i.state === 'missing') && doneBytes === 0) state = 'missing';
  else state = 'partial';

  const bytesPerSec = r ? num(r.bytesPerSec) : null;
  const etaSec = r ? (num(r.etaSec) != null ? r.etaSec : (bytesPerSec > 0 ? Math.ceil(needBytes / bytesPerSec) : null)) : null;

  // ［担当に渡す内容を写す］の中身。本当のパスはここにだけ入れる（画面の表には出さない）
  const L = root ? layout(root, manifest) : null;
  const realPath = (it) => {
    if (!root) return '';
    const parts = relParts(it.kind === 'zip' ? it.dir : it.dest);
    return parts ? path.join(root, ...parts) : '';
  };
  const lines = [
    'NaTsu のエンジンの取り込み（情報システムの担当の方へ）',
    `NaTsu の版: ${appVersion || '不明'}`,
    `Windows の版: ${osVersion || '不明'}`,
    `置き場所: ${root || '（この PC では取り込めません）'}`,
    `状態: ${state}`,
  ];
  if (error) lines.push(`失敗のコード: ${error.code}`, `失敗の文: ${error.message}`);
  if (runtime && runtime.message) lines.push(`Visual C++ ランタイム: ${runtime.message}`);
  if (L) lines.push(`記録: ${L.installed}`);
  for (const it of manifest.items) {
    const s = items.find((i) => i.id === it.id);
    lines.push(`- ${it.label}（${it.version}）: ${s.state}${man[it.group] ? '（詳細設定で手のパスを使用中）' : ''}`,
      `  パス: ${realPath(it) || '（なし）'}`, `  取得元: ${it.url}`, `  SHA-256: ${it.sha256}`, `  大きさ: ${it.size} バイト`);
  }

  return {
    ok: true, supported, root,
    mode: { whisper: man.whisper ? 'manual' : 'managed', sum: man.sum ? 'manual' : 'managed' },
    using, state, items,
    totalBytes, doneBytes, needBytes, whisperBytes, updateBytes, freeBytes: num(freeBytes),
    current: (r && r.current) || null, bytesPerSec, etaSec,
    error, askIt: Boolean(error && askIt(error.code)), report: lines.join('\n'),
    runtime: runtime && isObj(runtime) ? { level: runtime.level, message: runtime.message } : null,
    whisperReady: Boolean(cands.whisper), sumReady: Boolean(cands.sum),
    consent: inst.consent === true, userPaused: inst.userPaused === true,
  };
}

module.exports = { engineRoot, layout, readInstalled, writeInstalled, planInstall, managedCandidates, freeBytesOf, statusOf,
  sha256File, installZip, recordInstalled, verifyCandidates };
