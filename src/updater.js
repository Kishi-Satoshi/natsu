/*
 * updater.js — GitHub Releases から更新を取得して適用する
 *
 * 方針:
 *  - 配布するのは src/ だけを固めた軽量zip（約150KB）。
 *    インストーラー丸ごと（80MB超）だと、大容量ダウンロードを切断する
 *    ネットワーク環境で更新のたびに失敗しかねないため。
 *  - 適用前に必ず現行の src/ をバックアップする。
 *    展開途中で落ちるとアプリが起動しなくなるので、戻せる状態を残す。
 *  - zip の package.json の engines.electron を、src/ を差し替える前に確かめる（#34）。
 *    exe（Electron 本体）は更新 zip では入れ替わらない。新しい src/ が今の Electron で
 *    動かなければ、当てた瞬間に起動しなくなり、復旧口（更新画面）ごと消える。
 *  - オフライン運用が前提なので、繋がらない時は静かに諦める。
 *  - 入れ直しが要る版は、確かめた時点（check()）で見分ける（第0c回 EL4）。
 *    リリースに添えた natsu-update.json の electron（engines.electron の写し）を今の Electron と比べ、
 *    満たさなければ reinstall: true を返す。文とボタンは updateNotice の 1 か所で決める。
 *    apply() の engines.electron の門は、natsu-update.json を知らない古い版のための最後の守りとして残す。
 *  - テスト用の取得先（環境変数 NATSU_UPDATE_FEED）は知らせを作るだけで、apply() は当てない。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const J = require('./jsonfile');

// 更新の配布元。変えるときは get-installer.ps1 の $repo も同じにする（identity.test.js が突き合わせる）。
const REPO = 'Kishi-Satoshi/natsu';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
// release.yml がリリースに添える、入れ直しが要るかを見分けるための小さな JSON（tools/update-info.js が作る）
const INFO_ASSET = 'natsu-update.json';
// 実機の確かめ用の取得先。手元の natsu-update.json のパスか owner/repo（下書きのリリースは API から見えないため）
const FEED_ENV = 'NATSU_UPDATE_FEED';
// 入れ直しの文。設定の画面・起動時の知らせ・トレイが同じ文を出す。版の詳しいこと（Electron の語）は update.log にだけ残す
const REINSTALL_MESSAGE = 'この版はアプリの土台を入れ替えるため、インストーラーで入れ直してください。議事録・設定・エンジンはそのまま残ります。';
const TEST_FEED_APPLY_ERROR = 'テスト用の取得先（NATSU_UPDATE_FEED）を使っている間は、更新を当てません。環境変数を消してから起動し直してください';
const TEST_FEED_NOTICE = 'テスト用の取得先（NATSU_UPDATE_FEED）を使っているため、この画面からは更新しません。';
const FEED_BAD_ERROR = 'テスト用の取得先（NATSU_UPDATE_FEED）の形が読めません。natsu-update.json のパスか、owner/repo の形にしてください';
const FEED_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ASSET_PATTERN = /^natsu-src-.*\.zip$/i;
// リリースのタグは natsu-v<x.y.z> だけ。旧名のころの v<x.y.z> が latest に残っていても取り違えない
const TAG_PATTERN = /^natsu-v(\d+\.\d+\.\d+)$/;

/*
 * 通信は Electron の net 経由で行う。
 *
 * Node のグローバル fetch は、Windowsのプロキシ設定も証明書ストアも見ない。
 * 社内プロキシ（特にSSL検査あり）の環境では、それだけで
 * 「ネットワークに接続できません」になる。
 * Electron の net は Chromium のネットワークスタックを使うため、
 * システムのプロキシ設定・PAC・資格情報・証明書ストアがそのまま効く。
 *
 * Electron の main でないとき（テスト・ELECTRON_RUN_AS_NODE）は electron を読まず、Node の fetch を使う。
 */
/*
 * 通信の口を選ぶ。Electron の main（process.type === 'browser'）のときだけ electron を読んで net.fetch を使う。
 * Electron の外（npm test・ELECTRON_RUN_AS_NODE）では electron を読まない。Electron 44 の npm の包みは、Node から
 * require('electron') されると本体を落としにいく（index.js の downloadElectron。第0c回 C6）。
 */
function pickFetch({ type = process.type, load = require } = {}) {
  if (type === 'browser') {
    try {
      const { net } = load('electron');
      if (net && typeof net.fetch === 'function') return (u, o) => net.fetch(u, o);
    } catch (_) { /* 下の fetch */ }
  }
  return globalThis.fetch;
}
function httpFetch(url, opts) { return pickFetch()(url, opts); }

function log(userDataPath, line) {
  try {
    fs.appendFileSync(path.join(userDataPath, 'update.log'),
      `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch (_) { /* noop */ }
}

const isObj = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o);

/**
 * appRoot/package.json の version だけを替える（第1a回 JS5）。→ 替えたら true、飛ばしたら false。投げない。
 * 壊れていても読めなくても動かさず消さない（resources\app\package.json を退けると、アプリが起動も更新もできなくなる）。
 * 読むのは部品（BOM 付き UTF-8・UTF-16 も読む）、書くのも部品（一時ファイル → fsync → 名前の変更。asar:false なので、
 * 途中で落ちて中途半端な package.json が残ると、次の起動で Electron が読めない）。
 * 飛ばしたときは update.log に理由の符号だけを書く（中身は書かない）。
 */
function bumpVersion(appRoot, version, userDataPath) {
  const file = path.join(appRoot, 'package.json');
  const r = J.readJsonFile(file, { shape: isObj });
  if (r.state !== 'ok') {
    const why = r.state === 'broken' ? `broken (${r.reason})` : r.state === 'unreadable' ? `unreadable (${r.code})` : r.state;
    log(userDataPath, `package.json version update skipped: ${why}`);
    return false;
  }
  try {
    J.writeJsonFile(file, { ...r.value, version });
    return true;
  } catch (e) {
    // version の更新は必須ではないが、黙って落とすと「更新しても版が上がらない」という分かりにくい状態になるため記録は残す
    log(userDataPath, `package.json version update skipped: ${(e && e.code) || 'UNKNOWN'}`);
    return false;
  }
}

/** '1.2.3' / 'v1.2.3' / 'natsu-v1.2.3' / '1.2.3-beta.1' を数の配列にする（プレリリースは切り捨て） */
const versionParts = (v) => String(v).trim().replace(/^(natsu-)?v/, '').split('.').map((n) => parseInt(n, 10) || 0);

/** '1.2.3' 同士を比較。a が新しければ 1 */
function cmpVersion(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * version が range を満たすか（#34 互換ゲート用の小さな判定。semver は入れない）。
 * 支えるのは `>=x.y.z`、`^x.y.z`、`x.y.z`、空（= 制約なし）だけ。
 * それ以外の書き方は「満たさない」と返す。黙って通すと門が無いのと同じになるため。
 * `^` は同じメジャーの範囲（0.x はマイナーまで、0.0.x はパッチまで固定）。
 */
// satisfiesRange が読める範囲の書き方（parseUpdateInfo も同じ形だけを受け入れる）
const RANGE_PATTERN = /^(>=|\^)?\s*v?(\d+)\.(\d+)\.(\d+)$/;

function satisfiesRange(version, range) {
  const r = String(range == null ? '' : range).trim();
  if (!r) return true;
  const m = r.match(RANGE_PATTERN);
  if (!m) return false;
  const v = String(version == null ? '' : version).trim();
  if (!/^v?\d+\.\d+\.\d+/.test(v)) return false;
  const base = `${m[2]}.${m[3]}.${m[4]}`;
  const c = cmpVersion(v, base);
  if (m[1] === '>=') return c >= 0;
  if (m[1] === '^') {
    if (c < 0) return false;
    const [major, minor] = versionParts(v);
    const [bMajor, bMinor] = versionParts(base);
    if (bMajor > 0) return major === bMajor;
    if (bMinor > 0) return major === 0 && minor === bMinor;
    return c === 0;
  }
  return c === 0;
}

function isFileSync(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

/**
 * 更新の取得先を決める。空なら決まったリポジトリの releases/latest。
 * NATSU_UPDATE_FEED が手元のファイルなら natsu-update.json として読み、owner/repo ならそのリポジトリを見る。
 * どちらもテスト用（test: true）で、知らせを作るだけにする。
 */
function readFeed(env = process.env, isFile = isFileSync) {
  const v = String((env && env[FEED_ENV]) || '').trim();
  if (!v) return { kind: 'default', api: API_LATEST, test: false };
  if (isFile(v)) return { kind: 'file', file: v, test: true };
  if (FEED_REPO_PATTERN.test(v)) return { kind: 'repo', api: `https://api.github.com/repos/${v}/releases/latest`, test: true };
  return { kind: 'bad', test: true, error: FEED_BAD_ERROR };
}

/**
 * natsu-update.json を読む。形が違えば投げる（入れ直しの判断を当て推量にしない）。
 * version / zipName を渡したときは、リリースのタグ・zip の名前と合うことも確かめる。
 */
function parseUpdateInfo(text, { version, zipName } = {}) {
  let o;
  try { o = JSON.parse(String(text == null ? '' : text).replace(/^\uFEFF/, '')); } catch (_) {
    throw new Error('natsu-update.json を読めません');
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('natsu-update.json を読めません');
  if (o.schema !== 1) throw new Error('natsu-update.json の形が違います（schema）');
  if (typeof o.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(o.version)) throw new Error('natsu-update.json の版が読めません');
  const electron = typeof o.electron === 'string' ? o.electron.trim() : '';
  if (!RANGE_PATTERN.test(electron)) throw new Error('natsu-update.json の electron が読めません');
  if (typeof o.zip !== 'string' || !o.zip) throw new Error('natsu-update.json の zip の名前が読めません');
  if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) throw new Error('natsu-update.json の SHA-256 が読めません');
  if (!Number.isInteger(o.size) || o.size <= 0) throw new Error('natsu-update.json の大きさが読めません');
  if (version !== undefined && o.version !== version) {
    throw new Error(`natsu-update.json の版（${o.version}）がリリース（${version}）と合いません`);
  }
  if (zipName !== undefined && o.zip !== zipName) {
    throw new Error(`natsu-update.json の zip（${o.zip}）がリリース（${zipName}）と合いません`);
  }
  return { version: o.version, electron, zip: o.zip, sha256: o.sha256, size: o.size };
}

/** 今の Electron が natsu-update.json の範囲を満たさないときだけ真。情報が無い・版が取れないときは apply() の門に任せる */
function needsReinstall(info, electronVersion) {
  return Boolean(info && info.electron && electronVersion) && !satisfiesRange(electronVersion, info.electron);
}

/**
 * check() の結果と更新の置き場所（target）から、画面に出す文とボタンを決める（設定の画面・起動時の知らせ・トレイの 3 か所で同じもの）。
 * 入れ直しは、テスト用の取得先でも置き場所に書けなくても、先に見せる。
 * @returns {{action:'latest'|'apply'|'download', message:string, button:string}}
 */
function updateNotice(r, target = { ok: true }) {
  if (!r || !r.ok || !r.update) return { action: 'latest', message: '', button: '' };
  if (r.reinstall) return { action: 'download', message: REINSTALL_MESSAGE, button: 'ダウンロード' };
  if (r.test) return { action: 'download', message: TEST_FEED_NOTICE, button: 'ダウンロード' };
  if (target && target.ok === false) {
    return { action: 'download', message: target.error || 'この方法では更新できません。新しいインストーラーを実行してください。', button: 'ダウンロード' };
  }
  return { action: 'apply', message: '', button: '更新して再起動' };
}

/** テスト用の取得先（手元の natsu-update.json）。知らせを作るだけなので zip の URL を持たない */
function checkFile(feed, currentVersion, userDataPath, electronVersion) {
  let info;
  try {
    info = parseUpdateInfo(fs.readFileSync(feed.file, 'utf8'));
  } catch (e) {
    log(userDataPath, `check (${FEED_ENV}) failed: ${e.message}`);
    return { ok: false, error: e.message, test: true };
  }
  const newer = cmpVersion(info.version, currentVersion) > 0;
  const reinstall = newer && needsReinstall(info, electronVersion);
  log(userDataPath, `check (${FEED_ENV}=file): current=${currentVersion} latest=${info.version} newer=${newer} reinstall=${reinstall}`);
  return {
    ok: true,
    update: newer,
    version: info.version,
    notes: `テスト用の取得先（${path.basename(feed.file)}）の版です。`,
    url: '',
    size: info.size,
    publishedAt: '',
    reinstall,
    requires: info.electron,
    sha256: info.sha256,
    test: true,
  };
}

/**
 * 最新リリースを問い合わせる。
 * opts.electronVersion … 今の Electron の版（省略時は process.versions.electron）。
 * opts.env … 環境変数（省略時は process.env。NATSU_UPDATE_FEED を読む）。
 * @returns {{ok:boolean, update?:boolean, version?:string, notes?:string, url?:string, size?:number,
 *   reinstall?:boolean, requires?:string, sha256?:string, test?:boolean, error?:string}}
 */
async function check(currentVersion, userDataPath, opts = {}) {
  const o = opts || {};
  const electronVersion = Object.prototype.hasOwnProperty.call(o, 'electronVersion') ? o.electronVersion : process.versions.electron;
  const feed = readFeed(o.env || process.env);
  if (feed.kind === 'bad') {
    log(userDataPath, `check: ${feed.error}`);
    return { ok: false, error: feed.error, test: true };
  }
  if (feed.kind === 'file') return checkFile(feed, currentVersion, userDataPath, electronVersion);
  try {
    const res = await httpFetch(feed.api, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NaTsu' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return { ok: false, error: 'リリースが見つかりません（まだ公開されていない可能性があります）' };
    if (!res.ok) return { ok: false, error: `更新情報を取得できません (${res.status})` };
    const data = await res.json();
    const tag = String(data.tag_name || '');
    if (!tag) return { ok: false, error: 'リリースにバージョン情報がありません' };
    const m = tag.match(TAG_PATTERN);
    if (!m) return { ok: false, error: `リリースのタグ（${tag}）が natsu-v<版> の形ではありません` };
    const latest = m[1];

    const asset = (data.assets || []).find((a) => ASSET_PATTERN.test(a.name));
    if (!asset) return { ok: false, error: '更新ファイル（natsu-src-*.zip）がリリースに添付されていません' };

    // 入れ直しが要るかは natsu-update.json で見分ける。無い古いリリースでは reinstall: false（apply() の門に任せる）
    let info = null;
    const infoAsset = (data.assets || []).find((a) => a && a.name === INFO_ASSET);
    if (infoAsset) {
      const ir = await httpFetch(infoAsset.browser_download_url, {
        headers: { 'User-Agent': 'NaTsu' },
        signal: AbortSignal.timeout(15000),
      });
      if (!ir.ok) return { ok: false, error: `${INFO_ASSET} を取得できません (${ir.status})。時間をおいて［更新を確認］からやり直してください`, test: feed.test };
      const text = await ir.text();
      try {
        info = parseUpdateInfo(text, { version: latest, zipName: asset.name });
      } catch (e) {
        // 形が違う・合わないのはオフラインではない。理由をそのまま見せる
        log(userDataPath, `check: ${e.message}`);
        return { ok: false, error: e.message, test: feed.test };
      }
    }

    const newer = cmpVersion(latest, currentVersion) > 0;
    const reinstall = newer && needsReinstall(info, electronVersion);
    log(userDataPath, `check: current=${currentVersion} latest=${latest} newer=${newer} reinstall=${reinstall}${feed.test ? ` feed=${feed.api}` : ''}`);
    return {
      ok: true,
      update: newer,
      version: latest,
      notes: String(data.body || '').slice(0, 4000),
      url: asset.browser_download_url,
      size: asset.size || 0,
      publishedAt: data.published_at || '',
      reinstall,
      requires: info ? info.electron : '',
      sha256: info ? info.sha256 : '',
      test: feed.test,
    };
  } catch (e) {
    // 実際の失敗理由は update.log に残す。
    // 「ネットワークに接続できません」だけでは、切断なのか
    // プロキシなのか証明書なのかが切り分けられない。
    log(userDataPath, `check failed: ${e.message}`);
    const offline = /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|abort|ERR_/i.test(e.message || '');
    return {
      ok: false,
      offline,
      error: offline
        ? 'ネットワークに接続できません（データ保存先の update.log に詳細が残ります）'
        : e.message,
    };
  }
}

/** 再試行つきダウンロード。細切れでも落とし切る */
async function download(url, dest, onProgress) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await httpFetch(url, {
        headers: { 'User-Agent': 'NaTsu' },
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error('ダウンロードが不完全です');
      fs.writeFileSync(dest, buf);
      if (onProgress) onProgress(buf.length);
      return buf.length;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error('ダウンロードに失敗しました');
}

/**
 * zip を展開して src/ を差し替える。
 * PowerShell の Expand-Archive を使う（追加依存を増やさないため）。
 */
function expandZip(zipPath, destDir) {
  const { execFileSync } = require('child_process');
  // 展開ツールは軽微な警告でも非0を返すことがある（unzip の "extra bytes" 等）。
  // 終了コードで判断せず、この後の実ファイル検査で成否を決める。
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ], { windowsHide: true, timeout: 120000, stdio: 'ignore' });
    } else {
      execFileSync('unzip', ['-o', zipPath, '-d', destDir], { timeout: 120000, stdio: 'ignore' });
    }
  } catch (e) {
    if (!fs.existsSync(destDir) || fs.readdirSync(destDir).length === 0) {
      throw new Error(`更新ファイルを展開できませんでした: ${e.message.split('\n')[0]}`);
    }
  }
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

/**
 * 更新を適用する。appRoot は package.json のあるフォルダ。
 * 失敗時はバックアップから自動で復旧する。
 *
 * opts.electronVersion … 今動いている Electron の版。省略時は process.versions.electron。
 *   取れないとき（Electron の外: テスト・解析）は engines の検査をしない。
 * opts.env … 環境変数（省略時は process.env）。NATSU_UPDATE_FEED があれば何も落とさず断る。
 * opts.sha256 … natsu-update.json の SHA-256。あれば落とした zip と照らし、違えば当てない。
 */
async function apply(url, appRoot, userDataPath, onProgress, opts) {
  // テスト用の取得先のあいだは当てない（取り違えた zip を当てないための二重の守り）
  if (String(((opts && opts.env) || process.env)[FEED_ENV] || '').trim()) {
    log(userDataPath, `apply refused: ${FEED_ENV} is set`);
    return { ok: false, error: TEST_FEED_APPLY_ERROR };
  }
  // 一時フォルダの作成も try の中で行う。ここで投げると呼び出し側は
  // { ok:false } ではなく例外を受け取り、画面のボタンが押せないまま残る。
  let work = '';
  const srcDir = path.join(appRoot, 'src');
  const backup = path.join(appRoot, `src.backup-${Date.now()}`);
  const electronVersion = (opts && Object.prototype.hasOwnProperty.call(opts, 'electronVersion'))
    ? opts.electronVersion
    : process.versions.electron;
  try {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-up-'));
    const zip = path.join(work, 'update.zip');
    const ext = path.join(work, 'extracted');

    if (onProgress) onProgress('更新をダウンロードしています…');
    const bytes = await download(url, zip);
    log(userDataPath, `downloaded ${bytes} bytes`);
    if (opts && opts.sha256) {
      const got = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
      if (got !== String(opts.sha256).trim().toLowerCase()) {
        log(userDataPath, `sha256 mismatch: expected=${opts.sha256} got=${got}`);
        throw new Error('更新ファイルの SHA-256 が配った物と合いません。もう一度［更新を確認］からやり直してください');
      }
    }

    if (onProgress) onProgress('展開しています…');
    fs.mkdirSync(ext, { recursive: true });
    expandZip(zip, ext);

    // zip の中身は src/ 直下、または <任意のフォルダ>/src/ のどちらでも受け入れる
    let newSrc = path.join(ext, 'src');
    if (!fs.existsSync(newSrc)) {
      const sub = fs.readdirSync(ext).map((d) => path.join(ext, d, 'src')).find((p) => fs.existsSync(p));
      if (sub) newSrc = sub;
    }
    if (!fs.existsSync(newSrc)) throw new Error('更新ファイルに src フォルダが含まれていません');
    // 最低限の健全性確認（壊れたzipで上書きしないため）
    for (const must of ['main.js', 'preload.js', path.join('renderer', 'app.html')]) {
      if (!fs.existsSync(path.join(newSrc, must))) throw new Error(`更新ファイルが不完全です（${must} がありません）`);
    }

    // 新しい package.json を先に読む（engines の検査と、後の version 更新に使う）。
    // 読めなくても更新自体は止めない（version の更新が飛ぶだけ。従来どおり記録は残す）。
    // 部品で読む（Windows PowerShell 5.1 の Set-Content -Encoding UTF8 の BOM 付きも、UTF-16 も読む）。
    // 記録には理由の符号だけを書く（JSON のエラーの文はファイルの中身を引用するため）
    const newPkg = path.join(path.dirname(newSrc), 'package.json');
    let nxt = null;
    const np = J.readJsonFile(newPkg, { shape: isObj });
    if (np.state === 'ok') nxt = np.value;
    else if (np.state !== 'missing') log(userDataPath, `package.json in update unreadable: ${np.reason || np.code}`);

    // 互換ゲート（#34）: 新しい src/ が必要とする Electron を、差し替える前に確かめる。
    // exe は更新 zip で入れ替わらないので、合わない zip を当てると次の起動で落ち、
    // 更新画面（復旧口）ごと消える。Electron の版が取れないときは検査しない。
    const range = nxt && nxt.engines && nxt.engines.electron;
    if (electronVersion && range && !satisfiesRange(electronVersion, range)) {
      // 解釈できない範囲指定も「満たさない」として止める（安全側）。理由を残さないと
      // 「更新が来ない」だけの静かな故障になり、engines を書き換えた本人も気づけない
      log(userDataPath, `engines.electron=${String(range).trim()} を満たさないため適用しない（今: ${electronVersion}）`);
      // 画面に出す文は入れ直しの文（updateNotice と同じ）。reinstall の印で、画面のボタンを［ダウンロード］に替えられる
      const err = new Error(REINSTALL_MESSAGE);
      err.reinstall = true;
      throw err;
    }

    if (onProgress) onProgress('適用しています…');
    if (fs.existsSync(srcDir)) fs.renameSync(srcDir, backup);
    try {
      fs.cpSync(newSrc, srcDir, { recursive: true });
    } catch (e) {
      // 失敗したら元に戻す。ここでの復旧に失敗すると src/ が無いまま残り、
      // アプリが起動しなくなる。復旧処理自体も必ず最後までやり切る。
      try {
        if (fs.existsSync(srcDir)) fs.renameSync(srcDir, `${srcDir}.failed-${Date.now()}`);
      } catch (_) { rmrf(srcDir); }
      try {
        if (!fs.existsSync(srcDir) && fs.existsSync(backup)) fs.renameSync(backup, srcDir);
      } catch (e2) {
        log(userDataPath, `rollback failed: ${e2.message}`);
        throw new Error(`更新に失敗し、元に戻すこともできませんでした。${path.basename(backup)} を src にリネームしてください。`);
      }
      throw e;
    }

    // package.json の version も更新（あれば。nxt は差し替え前に読んである）。失敗は bumpVersion が記録する
    if (nxt && nxt.version) bumpVersion(appRoot, nxt.version, userDataPath);

    // 直近1つだけバックアップを残し、古いものは掃除する
    for (const d of fs.readdirSync(appRoot)) {
      if (d.startsWith('src.backup-') && path.join(appRoot, d) !== backup) rmrf(path.join(appRoot, d));
    }

    log(userDataPath, `applied. backup=${path.basename(backup)}`);
    if (work) rmrf(work);
    return { ok: true, backup: path.basename(backup) };
  } catch (e) {
    log(userDataPath, `apply failed: ${e.message}`);
    if (work) rmrf(work);
    return { ok: false, error: e.message, ...(e.reinstall ? { reinstall: true } : {}) };
  }
}

module.exports = {
  check, apply, bumpVersion, cmpVersion, satisfiesRange, pickFetch, REPO, TAG_PATTERN, ASSET_PATTERN,
  INFO_ASSET, FEED_ENV, REINSTALL_MESSAGE, readFeed, parseUpdateInfo, needsReinstall, updateNotice,
};
