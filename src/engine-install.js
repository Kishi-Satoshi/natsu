/*
 * engine-install.js — 取り込んだエンジンとモデルの置き場所・記録・使える組・状態（第0b回 R7）
 *
 * その1（Task 11）: ファイルを見るだけで決める部分。起動のときに使うので、通信もフォルダ作りもしない。
 *  - engineRoot         取り込み先 %LOCALAPPDATA%\natsu\engine（Roaming の %APPDATA% には置かない。
 *                       数 GB のモデルがプロファイルの同期で運ばれるため）。Windows の x64 だけ
 *  - layout             置き場所の並び（エンジンは版の名前のフォルダ、モデルは models の下）
 *  - readInstalled      installed.json を部品で読む。壊れていれば退けて（控えは新しい3つまで）空の記録。
 *                       読めない → 空の記録に印 unreadable。schema が 1 でない → 空の記録（ファイルは退けない）
 *  - writeInstalled     installed.json を部品で書く（一時ファイル → fsync → 名前の変更）。読めない間は書かない（RF22）
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
 * その3（Task 12b）: 取り込みの係。
 *  - makeRunner         5 つの項目を MANIFEST の順に取り、組がそろったら知らせる。start はすぐ返り、取り込みは裏で進む。
 *                       記録中（hold）は止めて待ち、待てば直る失敗（回線が切れた等）はあきらめずに待って続け（RF14）、
 *                       消された項目は同じ起動の中で1回だけ取り直す（2回目は defender で止める。RF3）。
 *                       起動のときの自動の開始は、大きな取り込み直しを始めない（押されるまで待つ。RF13）。
 *                       組がそろうたびに THIRD-PARTY-NOTICES.txt を書き直す（writeNotices。書けなくても止めない）
 *  - setActive          installed.json の active[group] に、今のピンのその組の SHA-256 の並びを書く（main が切り替えたとき）
 *
 * その4（Task 12c）: 古い版の片付けと、ライセンスの写し。
 *  - cleanupOld         切り替えた後で、記録にあって今のピンにも active にも無いもの（前の版のフォルダとモデル）だけを消す。
 *                       canDelete が偽（エンジンが動いている・起動の途中・忙しい）なら消さない。inUse のパスと、
 *                       今のピン・残す記録・installed.json などと重なる置き場所は消さない。記録に無いものには触らない（RF8）
 *  - writeNotices       THIRD-PARTY-NOTICES.txt に、各項目の名前・版・URL・ライセンスと著作権の行。Apache-2.0 の項目があれば
 *                       最後に src/licenses/Apache-2.0.txt の全文を1回だけ。Qwen2.5-3B のときだけ Qwen の一文
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
const { hostOf, ALT_MODELS } = require('./engine-manifest');
const { askIt, fetchErrorMessage, isTransient, fetchFile: fetchFileDefault } = require('./engine-fetch');
const { listZip, readEntry } = require('./zipread');
const J = require('./jsonfile');

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

/**
 * installed.json を読む（第1a回 JS5・JS2）。部品で読む（BOM 付き・UTF-16 も読む）。
 *  - 無い → 空の記録
 *  - 壊れている → 退けて（作り直せる記録なので、退けた控えは新しい3つまで）空の記録
 *  - 読めない（ほかのプログラムが掴んだまま）→ 空の記録に、列挙されない印 unreadable: true（writeInstalled は書かない）
 *  - schema が 1 でない → 空の記録。ファイルは退けない（新しい版の記録かもしれない。次に書くときに置き換わる）
 */
function readInstalled(file) {
  const r = J.loadJsonFile(file, { shape: isObj, keep: 3 });
  if (r.state === 'unreadable') return Object.defineProperty(emptyInstalled(), 'unreadable', { value: true });
  if (r.state !== 'ok') return emptyInstalled();
  const o = r.value;
  if (o.schema !== 1) return emptyInstalled();
  const items = {};
  if (isObj(o.items)) for (const [k, v] of Object.entries(o.items)) if (isObj(v)) items[k] = v;
  const act = isObj(o.active) ? o.active : {};
  const shas = (a) => (Array.isArray(a) && a.length && a.every((s) => typeof s === 'string') ? a.slice() : null);
  return { ...o, schema: 1, consent: o.consent === true, userPaused: o.userPaused === true, items,
    active: { whisper: shas(act.whisper), sum: shas(act.sum) } };
}

// THIRD-PARTY-NOTICES.txt の名前の変更を試し直す前の待ち（合わせて 0.3 秒まで。同期なので main を長く止めない）。
// installed.json は部品（jsonfile の RENAME_WAITS）で書く
const INSTALLED_RENAME_WAITS = [20, 40, 80, 160];
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* 待てなければすぐ試す */ }
};

/**
 * installed.json を書く。部品で一時ファイルに書いて fsync してから名前を変える（途中で切れても前の記録が残る）。
 * 名前の変更が EPERM・EBUSY・EACCES なら少し待って試し直す（ウイルス対策が installed.json を開いているとき）。
 * 読めない（掴まれている）間は書かない: 読めなかった記録の代わりの空の記録で、同意や使っている組を上書きしないため（RF22）。
 * readInstalled が「読めない」で返した記録（印 unreadable）も、書くときには読めるようになっていても書かない。
 * 呼び手はどれも、書き手が投げても受け止める。
 */
function writeInstalled(file, obj) {
  if ((obj && obj.unreadable === true) || J.readJsonFile(file).state === 'unreadable') {
    throw Object.assign(new Error('installed.json を読めないので書かない'), { code: 'EBUSY' });
  }
  J.writeJsonFile(file, { ...obj, schema: 1 });
}

/** 一時ファイル（<file>.<pid>.tmp）に書いて確定し、名前を変える（THIRD-PARTY-NOTICES.txt。JSON ではない）。 */
function writeFileAtomicSync(file, data) {
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

// ---------------------------------------------------------------- その3: 取り込みの係（Task 12b）

const SHA_FILE = /^([0-9a-f]{64})\.(part|json|zip)$/i;   // .download の中の、ピンの SHA-256 の名前のファイル
const WAIT_TICK_MS = 1000;                                // 待ちは 1 秒ずつ（一時停止・［今すぐ試す］・回線の戻りをすぐ拾う）
const SPEED_WINDOW_MS = 10000;                            // 速さは直近 10 秒で測る
const PAUSED = 'paused';
const placeOf = (it) => (it.kind === 'zip' ? it.dir : it.dest);
const namesIn = async (d) => { try { return await fs.promises.readdir(d); } catch (_) { return []; } };
const exists = async (p) => { try { await fs.promises.lstat(p); return true; } catch (_) { return false; } };

/** 本当のパスを、画面に出す形（%LOCALAPPDATA%\natsu\engine\…。利用者名を出さない）にする。root の外は名前だけ。 */
function shownPathOf(root, file) {
  const rel = root && file ? path.relative(root, String(file)) : '';
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file ? path.basename(String(file)) : '';
  return `${SHOWN_ROOT}\\${rel.split(/[\\/]+/).join('\\')}`;
}

/**
 * installed.json の active[group] に、今のピンのその組の SHA-256 の並びを書く → 書いた active。
 * main が取り込んだ組へ切り替えたときに呼ぶ（Task 14）。前の組は、ここで書き替わるまで使い続けられる（RF13）。
 */
function setActive(home, manifest, group) {
  if (!GROUPS.includes(group)) throw new TypeError(`setActive: 組の名前が違います（${group}）`);
  const root = home && home.root;
  if (!root) throw installError('hash', '記録する先が分からない');
  const file = path.join(root, 'installed.json');
  const inst = readInstalled(file);
  const shas = manifest.items.filter((i) => i.group === group).map((i) => i.sha256);
  inst.active = { ...inst.active, [group]: shas.length ? shas : null };
  writeInstalled(file, inst);
  return inst.active;
}

/**
 * 取り込みの係 → { start(opts), done(), pause(why), status(), running(), downloading() }。
 *  running() は仕事があるか（回線を待っている・記録中で止めている間も真）。downloading() は実際に取っている間（state が running）だけ真
 *  （main の省電力の抑止が見る。第0b回 Q14）。
 *  deps: { home, manifest, request, fetchFile, fetchOpts, statfs, sleep, now, log, onProgress, onGroupReady, onState,
 *          hold, isManual, isOnline, waitMs, holdPollMs, progressMs, autoUpdateMaxBytes, userAgent }
 *    request は net.request と同じ形（本番は (o) => electronNet.request(o)。この係は Electron を読み込まない）。
 *    fetchOpts は fetchFile にそのまま足す（テストは requireHttps: false と短い時計）。
 *    sleep は待ち（試し直し・待っている間・記録中の見張り）。省けば本物の時計。
 *  status() は statusOf の写しに、今の項目のバイト数 done: { [id]: bytes } を足したもの
 *  （main が statusOf の runner にそのまま渡せる形。state は running・waiting・held・paused・error を係が決め、
 *   止まっているときは statusOf が ready・update・partial・missing を決める）。
 *  onState(status) は状態が変わるたびに、onProgress(status) は progressMs に1回まで（now() で測る）。
 *  状態が変わったときは onProgress にも必ず渡す（画面は進み具合の知らせだけを聞くので、held・waiting・paused・error を
 *  すぐ出せるように。仕事の始めと終わりも状態の変わり目なので、最初と最後は必ず渡る）。
 */
function makeRunner(deps = {}) {
  const {
    home, manifest, request, fetchFile = fetchFileDefault, fetchOpts = {}, statfs = fs.promises.statfs, sleep = sleepDefault,
    now = Date.now, log = () => {}, onProgress = () => {}, onGroupReady = () => {}, onState = () => {},
    hold = () => false, isManual = () => false, isOnline = () => true,
    waitMs = 60000, holdPollMs = 5000, progressMs = 250, autoUpdateMaxBytes = 100e6, userAgent,
  } = deps;
  const root = (home && home.supported && home.root) || null;
  const installedFile = root ? path.join(root, 'installed.json') : null;
  const dlDir = root ? path.join(root, '.download') : null;
  const repaired = new Set();                 // この起動の中で取り直して置き終えた項目（同じ項目は2回直さない。RF3）
  const repairing = new Set();                // 取り直しを始めたが、まだ置き終えていない項目（待ち・記録中・一時停止・locked の後は続きとして取る）
  let job = null;                             // 今の仕事（動いていなければ null）
  let snap = { state: null, error: null };    // 係の状態。null は止まっている（済んだ・何もしていない）
  let lastFree = null;                        // 最後に測った空き
  let lastEmit = -Infinity;

  const say = (line) => { try { log(`取り込み: ${line}`); } catch (_) { /* 記録の失敗では止めない */ } };
  const call = (fn, ...a) => { try { fn(...a); } catch (e) { say(`知らせの受け手で失敗しました（${e && e.message}）`); } };
  const man = (g) => { try { return Boolean(isManual(g)); } catch (_) { return false; } };
  const holding = () => { try { return Boolean(hold()); } catch (_) { return false; } };
  const readInst = () => readInstalled(installedFile);
  const planNow = (inst = readInst()) => new Map(planInstall(manifest, inst, fs.statSync, root).map((p) => [p.id, p]));

  function status() {
    const inst = readInst();
    const all = Boolean(job && job.want.all);   // 手の組も取っている間は、その組も数える（進み具合を出すため）
    const runner = { state: snap.state, current: job ? job.current : null, done: job ? { ...job.done } : {},
      bytesPerSec: job ? job.bytesPerSec : null, error: snap.error };
    const s = statusOf({ home, manifest, plan: planInstall(manifest, inst, fs.statSync, root),
      candidates: managedCandidates(home, manifest, inst, fs.statSync), runner,
      manual: { whisper: !all && man('whisper'), sum: !all && man('sum') }, freeBytes: lastFree, installed: inst });
    return { ...s, done: runner.done };
  }

  function emit(force) {
    const t = now();
    if (!force && t - lastEmit < progressMs) return;
    lastEmit = t;
    call(onProgress, status());
  }

  function setState(state, error = null) {
    const code = (e) => (e ? e.code : null);
    const changed = snap.state !== state || code(snap.error) !== code(error);
    snap = { state, error };
    if (job && state !== 'running') { job.bytesPerSec = null; job.samples = []; }
    if (!changed) return;
    const s = status();
    call(onState, s);
    lastEmit = now();
    call(onProgress, s);
  }

  function writeFlags(patch) {
    // Object.assign で、読めなかったときの印（列挙されない unreadable）を残したまま渡す
    try { writeInstalled(installedFile, Object.assign(readInst(), patch)); } catch (e) {
      say(`installed.json に書けませんでした（${e && (e.code || e.message)}）`);
    }
  }

  function newJob(want) {
    const j = { want, dirty: false, pauseWhy: null, retryNow: false, current: null, done: {}, ctrl: null,
      bytesPerSec: null, samples: [], got: 0, wakers: new Set(), promise: null };
    j.wake = () => { const ws = [...j.wakers]; j.wakers.clear(); for (const w of ws) w(); };
    // 待つ。一時停止・［今すぐ試す］で起こされたらすぐ戻る。sleep が投げたら投げる
    j.nap = (ms) => new Promise((resolve, reject) => {
      const wake = () => { j.wakers.delete(wake); resolve(); };
      j.wakers.add(wake);
      Promise.resolve().then(() => sleep(ms)).then(wake, (e) => { j.wakers.delete(wake); reject(e); });
    });
    return j;
  }

  /**
   * start({ all, repair, user, auto }) → すぐに今の写し（取り込みは裏で進む）。
   *  user: ボタンから（押したことが同意）。consent: true・userPaused: false を書く。大きな取り込み直しも取る。
   *  auto: 起動のとき。consent が偽か userPaused が真なら何もしない。大きな取り込み直しは取らない（RF13）。
   *  repair: 起動時の照らしで壊れていた項目の id。照らし直して違えば、同じ起動の中で1回だけ取り直す（RF3）。
   *  動いていれば新しく始めず、頼みを今の仕事に足す（2回押しても二重にならない）。待っていれば、すぐ試す。
   */
  function start(o = {}) {
    const { all = false, repair = [], user = false, auto = false } = o || {};
    if (!root) return status();
    if (user) writeFlags({ consent: true, userPaused: false });
    const inst = readInst();
    const known = new Set(manifest.items.map((i) => i.id));
    const want = { all: Boolean(all), normal: Boolean(user) || (inst.consent && !inst.userPaused), big: Boolean(user),
      repair: new Set((Array.isArray(repair) ? repair : []).filter((id) => known.has(id))) };
    if (!want.normal && !want.repair.size) {
      say(`${auto ? '起動のときの' : ''}自動の開始はしません（${inst.userPaused ? '一時停止中' : 'まだ同意がありません'}）`);
      return status();
    }
    if (job) {
      const j = job;
      j.want.all = j.want.all || want.all; j.want.normal = j.want.normal || want.normal; j.want.big = j.want.big || want.big;
      for (const id of want.repair) j.want.repair.add(id);
      if (user) j.pauseWhy = null;   // 止めている途中に押された: 止めるのをやめて続ける
      j.dirty = true; j.retryNow = true; j.wake();
      return status();
    }
    job = newJob(want);
    say(`始めます（${user ? 'ボタンから' : auto ? '起動のとき' : '取り直し'}${want.all ? '・手の組も' : ''}${want.repair.size ? `・取り直し ${[...want.repair].join('・')}` : ''}）`);
    job.promise = run(job).catch((e) => say(`係が止まりました（${e && e.message}）`));
    setState('running');
    return status();
  }

  /** pause(why) … 今の要求を止める（.part は確定して残る）。'user' は userPaused を書く（次の起動で自動で続けない）。'quit' は書かない。 */
  function pause(why = 'user') {
    if (!root) return status();
    if (why === 'user') writeFlags({ userPaused: true });
    if (job) {
      job.pauseWhy = why || 'user';
      if (job.ctrl) job.ctrl.abort();
      job.wake();
    }
    return status();
  }

  const done = () => (job ? job.promise : Promise.resolve());
  const running = () => Boolean(job);
  // 実際に取っている（state が running）。待っている（waiting）・止めて待つ（held）・止めた後（paused）は偽（Q14）
  const downloading = () => Boolean(job) && snap.state === 'running';

  async function run(j) {
    await null;   // start() を先に返す
    let end = null;
    try {
      await cleanupLeftovers();
      for (;;) {
        j.dirty = false;
        end = await pass(j);
        if (end === PAUSED && !j.pauseWhy) continue;   // 止める前に、また押された
        if (!end && j.dirty) continue;                 // 動いている間に頼みが足された
        break;
      }
    } catch (e) {
      end = { error: errorInfo(e) };
    }
    // ここから先は await しない（start() と競らない）
    if (job === j) job = null;
    if (end && end.error) {
      const err = { ...end.error, message: end.error.message || fetchErrorMessage(end.error.code, end.error.extra || {}) };
      say(`止めました（${err.code}）`);
      setState('error', err);
    } else if (end === PAUSED) {
      say(`一時停止しました（${j.pauseWhy}）`);
      setState('paused');
    } else setState(null);
  }

  /** 始める前に、残った *.tmp と、今のピンに無い SHA-256 の .part・.json・.zip を消す。 */
  async function cleanupLeftovers() {
    const pins = new Set(manifest.items.map((i) => String(i.sha256).toLowerCase()));
    const gone = async (p) => {
      try { await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); say(`残りを消しました（${shownPathOf(root, p)}）`); } catch (e) {
        say(`残りを消せませんでした（${shownPathOf(root, p)}・${e && e.code}）`);
      }
    };
    for (const name of await namesIn(root)) if (/\.tmp$/i.test(name)) await gone(path.join(root, name));
    for (const name of await namesIn(dlDir)) {
      const m = SHA_FILE.exec(name);
      if (/\.tmp$/i.test(name) || (m && !pins.has(m[1].toLowerCase()))) await gone(path.join(dlDir, name));
    }
  }

  /**
   * 空きが足りなければ、足りない GB（小数1桁に切り上げ）。足りるか測れなければ 0。
   * 要る = 残りの大きさの合計 + zip の展開後の大きさ + max(1GB, 残りの 5%)。statfs が投げたら記録して 0。
   */
  async function spaceShort(items, plan) {
    if (!items.length) return 0;
    const rem = items.reduce((a, it) => a + Math.max(0, it.size - ((plan.get(it.id) || {}).held || 0)), 0);
    const unz = items.reduce((a, it) => a + (it.kind === 'zip' ? it.files.reduce((b, f) => b + f.size, 0) : 0), 0);
    const need = rem + unz + Math.max(1e9, rem * 0.05);
    const free = await freeBytesOf(root, async (p) => {
      try { return await statfs(p); } catch (e) { say(`空きを測れませんでした（${e && (e.code || e.message)}）。測らずに続けます`); throw e; }
    });
    lastFree = free;
    if (free == null || free >= need) return 0;
    return Math.ceil((need - free) / 1e8) / 10;
  }

  const inGroupOf = (j) => (it) => j.want.all || !man(it.group);
  const needsBytes = (plan) => (it) => ['missing', 'update'].includes((plan.get(it.id) || {}).state);

  /** 1回の見回り → null（済んだ）| PAUSED | { error }。 */
  async function pass(j) {
    const plan = planNow();
    const inGroup = inGroupOf(j);
    const updLeft = manifest.items.filter((it) => inGroup(it) && plan.get(it.id).state === 'update')
      .reduce((a, it) => a + Math.max(0, it.size - plan.get(it.id).held), 0);
    const skipUpdates = !j.want.big && updLeft > autoUpdateMaxBytes;
    if (skipUpdates) say(`新しい版（約 ${Math.round(updLeft / 1e6)}MB）は、押されるまで取りません`);
    const picked = new Set(manifest.items.filter((it) => {
      if (!inGroup(it)) return false;
      if (j.want.repair.has(it.id)) return true;
      const st = plan.get(it.id).state;
      if (!j.want.normal || st === 'ready') return false;
      return !(st === 'update' && skipUpdates);
    }).map((it) => it.id));
    if (!picked.size) return null;
    const short = await spaceShort(manifest.items.filter((it) => picked.has(it.id) && needsBytes(plan)(it)), plan);
    if (short) return { error: { code: 'space', extra: { needGB: short } } };
    const lastIdx = {};
    manifest.items.forEach((it, i) => { lastIdx[it.group] = i; });
    const acted = new Set();
    for (let i = 0; i < manifest.items.length; i++) {
      const it = manifest.items[i];
      if (picked.has(it.id)) {
        const r = await doItem(j, it);
        if (r) return r;
        acted.add(it.group);
      }
      // 1つの組の項目が全部済んだら知らせる（whisper の組は llama より先なので、文字起こしが先に使える）
      if (lastIdx[it.group] === i && acted.has(it.group)) {
        const p = planNow();
        if (manifest.items.filter((x) => x.group === it.group).every((x) => p.get(x.id).state === 'ready')) {
          say(`${it.group} の組がそろいました`);
          try { writeNotices(home, manifest); } catch (e) {
            say(`ライセンスの写し（THIRD-PARTY-NOTICES.txt）を書けませんでした（${e && (e.code || e.message)}）`);
          }
          call(onGroupReady, it.group);
        }
      }
      if (j.pauseWhy) return PAUSED;
    }
    return null;
  }

  /** 1つの項目。記録中は待ち、待てば直る失敗は待って続ける → null（済んだ）| PAUSED | { error }。 */
  async function doItem(j, it) {
    for (;;) {
      if (j.pauseWhy) return PAUSED;
      if (holding()) {
        say('記録中なので止めて待ちます');
        setState('held');
        while (holding() && !j.pauseWhy) await j.nap(holdPollMs);
        if (j.pauseWhy) return PAUSED;
      }
      j.current = it.id;
      setState('running');
      try {
        await placeItem(j, it);
        delete j.done[it.id];
        j.want.repair.delete(it.id);
        return null;
      } catch (e) {
        if (e && e.code === 'cancelled') {
          if (j.pauseWhy) return PAUSED;
          continue;   // 記録が始まった（held で待つ）か、止めるのをやめた
        }
        const err = errorInfo(e);
        if (isTransient(err.code)) { await waitOnline(j, err); continue; }
        if (err.code === 'space') {
          const p = planNow();
          const gb = await spaceShort(manifest.items.filter((x) => inGroupOf(j)(x) && needsBytes(p)(x)), p);
          const fromFile = Number.isFinite(e && e.needBytes) && e.needBytes > 0 ? Math.ceil(e.needBytes / 1e8) / 10 : 0;
          if (gb || fromFile) err.extra = { needGB: gb || fromFile };
        }
        say(`${it.label}: ${err.code}${e && e.message ? `（${e.message}）` : ''}`);
        return { error: err };
      }
    }
  }

  /** 待てば直る失敗: waitMs の間（1 秒ずつ）待つか、切れていた回線が戻るか、［今すぐ試す］まで待つ（RF14）。 */
  async function waitOnline(j, err) {
    say(`つながるのを待っています（${err.code}）`);
    j.retryNow = false;   // 知らせ（onState）の中で押された［今すぐ試す］を消さないよう、知らせる前に
    setState('waiting', { code: err.code, message: fetchErrorMessage('waiting') });
    let offline = false;
    for (let t = 0; t < waitMs; t += WAIT_TICK_MS) {
      await j.nap(Math.min(WAIT_TICK_MS, waitMs - t));
      if (j.pauseWhy || j.retryNow) break;
      let on = true;
      try { on = Boolean(isOnline()); } catch (_) { on = true; }
      if (!on) offline = true;
      else if (offline) break;   // 切れていた回線が戻った
    }
    j.retryNow = false;
  }

  /** code 付きの失敗を、写しの error の形 { code, extra } にする。 */
  function errorInfo(e) {
    let code = e && typeof e.code === 'string' && e.code ? e.code : 'unknown';
    if (code === 'ENOSPC') code = 'space';
    else if (RENAME_BUSY.has(code)) code = 'locked';   // installed.json や置き場所を、ほかのプログラムが掴んでいる
    const extra = {};
    if (code === 'defender' && e.file) extra.file = e.file;
    return { code, extra };
  }

  /**
   * 使っている組（active）の置き場所に、違う SHA-256 のものを置こうとしているか（ピンの作り間違い）。
   * Windows は大文字と小文字を区別しないので、小文字で比べる。
   */
  function placeTaken(inst, it) {
    const place = String(placeOf(it)).toLowerCase();
    return GROUPS.some((g) => (inst.active[g] || []).some((s) => !sameSha(s, it.sha256) && isObj(inst.items[s])
      && String(inst.items[s].place).toLowerCase() === place));
  }

  /**
   * 置いたはずの項目が消えたか変わっていた。同じ起動の中で、取り直して置き終えた後の2回目なら、取らずに defender で止める（RF3）。
   * 数えるのは置き終えたとき（repairDone）。取り直しの途中で待った・記録が始まった・一時停止した・フォルダをどけられなかった
   * （locked）ときは、続きとして取り直す（取り込みを繰り返してはいないので、defender にしない）。
   */
  function broken(it, file) {
    const shown = shownPathOf(root, file);
    if (repaired.has(it.id)) throw installError('defender', `${it.id} がまた消えたか変わった`, { file: shown });
    if (repairing.has(it.id)) return;
    repairing.add(it.id);
    say(`${it.label} のファイルが消えたか変わっています。1回だけ取り直します（${shown}）`);
  }

  /** 取り直して置き終えた（この起動の中では、もう取り直さない）。 */
  function repairDone(it) {
    if (repairing.delete(it.id)) repaired.add(it.id);
  }

  /** 項目を照らし・取り・置き・記録する。 */
  async function placeItem(j, it) {
    const inst = readInst();
    const p = planNow(inst).get(it.id);
    const forced = j.want.repair.has(it.id);
    if (p.state === 'ready' && !forced) return;
    if (placeTaken(inst, it)) throw installError('place-in-use', `${placeOf(it)} は使っている組の置き場所`);
    const recheck = forced || p.state === 'changed';
    if (it.kind === 'zip') await placeZip(j, it, recheck);
    else await placeFile(j, it, recheck);
  }

  async function placeFile(j, it, recheck) {
    const parts = relParts(it.dest);
    if (!parts) throw installError('hash', `${it.id} の置き場所が読めない`);
    const dest = path.join(root, ...parts);
    if (recheck) {
      // 先に取らずに照らし直す（触られただけなら、記録を書き直すだけ）
      let ok = false;
      try {
        const st = await fs.promises.stat(dest);
        ok = st.isFile() && st.size === it.size && sameSha(await sha256File(dest), it.sha256);
      } catch (_) { ok = false; }
      if (ok) { recordInstalled(home, it); say(`${it.label} は中身が同じでした（記録を書き直しました）`); return; }
      broken(it, dest);
      await unlinkQuiet(dest);   // 違う中身は使えない（取り込みの手0で、もう一度読まない）
    }
    const r = await fetchItem(j, it, dest);
    if (r && r.reused) say(`${it.label} は置き場所にもう正しいものがありました`);
    recordInstalled(home, it);
    repairDone(it);
  }

  async function placeZip(j, it, recheck) {
    const dirParts = relParts(it.dir);
    if (!dirParts) throw installError('hash', `${it.id} の置き場所が読めない`);
    const dir = path.join(root, ...dirParts);
    const exe = relParts(it.exe) ? path.join(dir, ...relParts(it.exe)) : dir;
    const zipPath = path.join(dlDir, `${String(it.sha256).toLowerCase()}.zip`);
    if (await exists(dir)) {
      // 置く先のフォルダが既にある: 取らずに照らす（同じなら記録を書き直すだけ）
      try {
        const r = await installZip(it, zipPath, root, { sleep });
        recordInstalled(home, it, r);
        say(`${it.label} は中身が同じでした（記録を書き直しました）`);
        return;
      } catch (e) {
        if (!e || e.code !== 'hash') throw e;
        broken(it, e.file || exe);
        await moveAside(dir);
      }
    } else if (recheck) {
      broken(it, exe);
    }
    await fetchItem(j, it, zipPath);
    const r = await installZip(it, zipPath, root, { sleep });
    recordInstalled(home, it, r);
    repairDone(it);
  }

  /**
   * 壊れた版のフォルダを <dir>.old-….tmp に名前を変えてから消す（中で動いているファイルがあれば、名前の変更が
   * 断られて locked で止まり、何も消さない）。消し残りは次の取り込みの始めに消す（*.tmp）。
   */
  async function moveAside(dir) {
    const aside = `${dir}.old-${crypto.randomBytes(4).toString('hex')}.tmp`;
    await renameWithWait(fs.promises.rename, dir, aside, sleep);
    await rmTreeQuiet(aside);
  }

  /** fetchFile で1つ取る。記録が始まったら（hold）今の要求を止める。進み具合と速さを写しに入れる。 */
  async function fetchItem(j, it, dest) {
    const ctrl = new AbortController();
    j.ctrl = ctrl;
    const stopIfHeld = () => { if (holding()) ctrl.abort(); };
    const watch = setInterval(stopIfHeld, holdPollMs);   // バイトが来ない間も、記録の始まりを拾う
    if (typeof watch.unref === 'function') watch.unref();
    if (j.pauseWhy) ctrl.abort();
    let prev = null;
    try {
      return await fetchFile(it, {
        sleep, now, log, userAgent, progressMs: 0, ...fetchOpts, dir: dlDir, dest, request, signal: ctrl.signal,
        onProgress: (pr) => {
          const d = Number(pr && pr.done) || 0;
          j.done[it.id] = d;
          if (prev != null) j.got += Math.max(0, d - prev);
          prev = d;
          const t = now();
          j.samples.push([t, j.got]);
          while (j.samples.length > 2 && t - j.samples[0][0] > SPEED_WINDOW_MS) j.samples.shift();
          const span = t - j.samples[0][0];
          if (span >= 1000) j.bytesPerSec = Math.round(((j.got - j.samples[0][1]) * 1000) / span);
          stopIfHeld();
          emit(false);
        },
      });
    } finally {
      clearInterval(watch);
      if (j.ctrl === ctrl) j.ctrl = null;
    }
  }

  return { start, done, pause, status, running, downloading };
}

// ---------------------------------------------------------------- その4: 古い版の片付けと、ライセンスの写し（Task 12c）

// 記録が何と言っても消さない置き場所（root からの相対。記録・写し・取り込み途中のフォルダ）
const SPECIAL_PLACES = ['installed.json', 'THIRD-PARTY-NOTICES.txt', '.download'];
const lowSha = (s) => String(s).toLowerCase();
// 同じ置き場所か、どちらかがもう一方の親（Windows は大文字と小文字を区別しないので、小文字で比べる）
const placesOverlap = (a, b) => {
  const x = String(a).toLowerCase(); const y = String(b).toLowerCase();
  return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
};

/**
 * 切り替えた後で、もう使わない前の版だけを消す（RF8）→ { removed: [place], kept: [place] }（place は記録の相対パス・並べ替え済み）。
 *  - 消す候補: installed.items にあって、SHA-256 が今のピンにも active のどの組にも無い記録（エンジンの版のフォルダとモデルのファイル）。
 *    同じ置き場所の記録が複数あれば、1つの候補にまとめる。
 *  - 残すもの（kept）: inUse(絶対パス) が真（エンジンのフォルダは中のファイルのパスでも聞く）、今のピンの置き場所・残す記録の
 *    置き場所・installed.json・THIRD-PARTY-NOTICES.txt・.download と重なるか、その親（壊れた記録で使っているものを消さない）、
 *    root の外を指す、canDelete() が偽。
 *  - canDelete() は消す前に毎回聞き、1度でも偽なら、その後は消さない（次の機会に回す。動いている exe・DLL・
 *    llama がメモリに写した gguf は Windows では消せない）。canDelete が無いか投げたら偽とみなす。
 *  - 消し方は fs.rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })。消せたものだけ記録から外す
 *    （installed.json を読み直して、その SHA-256 の記録だけを外す）。記録に無いもの（利用者が置いたフォルダなど）には触らない。
 */
async function cleanupOld(home, manifest, installed, { inUse = () => false, canDelete } = {}) {
  const out = { removed: [], kept: [] };
  const root = home && home.supported && home.root;
  if (!root) return out;
  const items = installed && isObj(installed.items) ? installed.items : {};
  // 0.9.4 S-7（決めたこと 21）: 軽いモデル（ALT_MODELS）は取り込みの組の外にあるが、記録もファイルも消さない
  const keepShas = new Set([...manifest.items, ...ALT_MODELS].map((i) => lowSha(i.sha256)));
  for (const g of GROUPS) {
    const act = installed && isObj(installed.active) ? installed.active[g] : null;
    for (const s of Array.isArray(act) ? act : []) keepShas.add(lowSha(s));
  }
  const guarded = [...SPECIAL_PLACES, ...[...manifest.items, ...ALT_MODELS].map(placeOf).filter((p) => typeof p === 'string')];
  const byPlace = new Map();
  for (const [s, rec] of Object.entries(items)) {
    if (!isObj(rec)) continue;
    const place = typeof rec.place === 'string' ? rec.place : '';
    if (keepShas.has(lowSha(s))) { if (place) guarded.push(place); continue; }
    if (!byPlace.has(place)) byPlace.set(place, { shas: [], names: [] });
    const c = byPlace.get(place);
    c.shas.push(s);
    if (Array.isArray(rec.files)) for (const f of rec.files) if (isObj(f) && relParts(f.name)) c.names.push(f.name);
  }
  const asked = (fn, ...a) => { try { return Boolean(fn(...a)); } catch (_) { return null; } };
  let allowed = true;
  const gone = [];
  for (const place of [...byPlace.keys()].sort()) {
    const c = byPlace.get(place);
    const parts = relParts(place);
    const abs = parts ? path.join(root, ...parts) : null;
    const used = abs && [abs, ...c.names.map((n) => path.join(abs, ...relParts(n)))].some((p) => asked(inUse, p) !== false);
    if (!abs || used || guarded.some((g) => placesOverlap(place, g))) { out.kept.push(place); continue; }
    if (allowed) allowed = typeof canDelete === 'function' && asked(canDelete) === true;
    if (!allowed) { out.kept.push(place); continue; }
    try {
      await fs.promises.rm(abs, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (_) { out.kept.push(place); continue; }
    out.removed.push(place);
    gone.push(...c.shas);
  }
  if (gone.length) {
    const file = path.join(root, 'installed.json');
    const inst = readInstalled(file);
    for (const s of gone) delete inst.items[s];
    writeInstalled(file, inst);
  }
  return out;
}

// ---------------------------------------------------------------- 0.9.4 S-7（決めたこと 21）: 軽いモデル
/** 軽いモデルの置き場所（id は ALT_MODELS の alt。'medium'）。取り込めない PC・知らない id は null */
function altModelFile(home, id) {
  const root = home && home.supported && home.root;
  const it = ALT_MODELS.find((a) => a.alt === id);
  const parts = it ? relParts(it.dest) : null;
  return root && parts ? path.join(root, ...parts) : null;
}
/**
 * 軽いモデルを取り込む（今の部品: engine-fetch.fetchFile が取り、大きさと SHA-256 を照らしてから置く。違えば置かない）→ installed.json の記録。
 * opts は fetchFile へそのまま渡す（request・signal・onProgress など。試しは requireHttps: false）
 */
async function installAlt(home, alt, opts = {}) {
  const root = home && home.supported && home.root;
  const parts = alt ? relParts(alt.dest) : null;
  if (!root || !parts) throw installError('hash', '軽いモデルの置き場所が分からない');
  const fetchFile = opts.fetchFile || fetchFileDefault;
  const { fetchFile: _f, ...rest } = opts;
  await fs.promises.mkdir(path.join(root, '.download'), { recursive: true });
  await fetchFile(alt, { ...rest, dir: path.join(root, '.download'), dest: path.join(root, ...parts) });
  return recordInstalled(home, alt);
}

const APACHE_TEXT_FILE = path.join(__dirname, 'licenses', 'Apache-2.0.txt');
// 標準の MIT License の許諾の文（著作権の行は入れない。著作権の行は項目ごとの「ライセンス」の行にある）
const MIT_TEXT_FILE = path.join(__dirname, 'licenses', 'MIT.txt');
// Qwen2.5-3B の LICENSE（Qwen RESEARCH LICENSE AGREEMENT）の 4.c が、配る写しの Notice のファイルに求める一文
const QWEN_RESEARCH_NOTICE = 'Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c) Alibaba Cloud. All Rights Reserved.';
const isApache = (it) => /^Apache-2\.0/.test(String(it.license || ''));
const isMit = (it) => /^MIT/.test(String(it.license || ''));
const isQwenResearch = (it) => /qwen2\.5-3b/i.test([it.id, it.label, it.version, it.url, it.dest].join(' '))
  || /^Qwen RESEARCH/i.test(String(it.license || ''));

/**
 * THIRD-PARTY-NOTICES.txt を書き直す → 書いたファイルのパス（取り込めない PC では null）。
 *  各項目の名前・版・URL・ライセンスと著作権の行（「ライセンス」の表のとおり）。zip の中のライセンスの全文のファイル
 *  （llama の LICENSE-LLVM-OpenMP）は置き場所を1行。Qwen2.5-3B のときは Qwen の一文。
 *  ライセンスが MIT で始まる項目があれば、項目の後ろに src/licenses/MIT.txt（標準の MIT License の許諾の文）を1回だけ、書き換えずに足す
 *  （MIT の「この許諾の文を含めること」。著作権の行は項目ごと）。
 *  ライセンスが Apache-2.0 で始まる項目があれば、最後に src/licenses/Apache-2.0.txt の全文を1回だけ、書き換えずに足す
 *  （Apache-2.0 の §4(a)。Gemma 3 までの独自の条件の文は書かない）。
 *  BOM 付きの UTF-8（古いメモ帳でも日本語が読める）。一時ファイルに書いてから名前を変える。
 */
function writeNotices(home, manifest) {
  const root = home && home.root;
  if (!root) return null;
  const its = manifest.items;
  const mit = its.some(isMit) ? fs.readFileSync(MIT_TEXT_FILE, 'utf8') : '';
  const apache = its.some(isApache) ? fs.readFileSync(APACHE_TEXT_FILE, 'utf8') : '';
  const lines = [
    'NaTsu が取り込んだエンジンとモデルのライセンス（第三者のソフトウェアとモデル）',
    `置き場所: ${SHOWN_ROOT}`,
    'このファイルは、NaTsu が取り込みのたびに書き直します。',
    '',
  ];
  for (const it of its) {
    lines.push(it.label, `  版: ${it.version}`, `  取得元: ${it.url}`, `  ライセンス: ${it.license}`);
    if (it.kind === 'zip') {
      for (const f of Array.isArray(it.files) ? it.files : []) {
        const name = stripped(it, f.name);
        if (/^LICENSE/i.test(name) && relParts(it.dir) && relParts(name)) {
          lines.push(`  ライセンスの全文: ${[...relParts(it.dir), ...relParts(name)].join('\\')}（このファイルと同じフォルダの下）`);
        }
      }
    }
    if (isMit(it)) lines.push('  ライセンスの全文: このファイルの後ろの MIT License（著作権の行は上のとおり）');
    if (isApache(it)) lines.push('  ライセンスの全文: このファイルの最後の Apache License 2.0');
    if (isQwenResearch(it)) lines.push(`  ${QWEN_RESEARCH_NOTICE}`);
    lines.push('');
  }
  let text = lines.join('\n');
  const bar = '='.repeat(78);
  if (mit) {
    text += `${bar}\nMIT License の許諾の文（上の MIT の項目に共通。著作権の行は項目ごと）\n${bar}\n${mit}\n`;
  }
  if (apache) {
    text += `${'='.repeat(78)}\nApache License 2.0 の全文（https://www.apache.org/licenses/LICENSE-2.0.txt の写し）\n${'='.repeat(78)}\n${apache}`;
  }
  const file = path.join(root, 'THIRD-PARTY-NOTICES.txt');
  writeFileAtomicSync(file, `﻿${text}`);
  return file;
}

module.exports = { engineRoot, layout, readInstalled, writeInstalled, planInstall, managedCandidates, freeBytesOf, statusOf,
  sha256File, installZip, recordInstalled, verifyCandidates, makeRunner, setActive, cleanupOld, writeNotices, altModelFile, installAlt, shownPathOf };
