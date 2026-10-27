/*
 * repo.test.js — 公開と配布に関わる決まりごとを機械で守る
 *
 *  - 公開リポジトリに個人名・個人パス・社内固有名を出さない
 *  - .ps1 は BOM付きUTF-8 + CRLF（BOMが無いと PS5.1 が Shift-JIS と誤読して壊れる）
 *  - preload / main / renderer の IPC が食い違わない（過去に不整合を出した箇所）
 *
 * 目視の再確認は忘れるが、テストは忘れない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) { return null; }
}

// .db は第2a1回 G-2 の固定の DB（test/fixtures/db/v1.db）。SQLite は文字を UTF-8 のまま持つので、文字として読んで同じ決まりで調べる（画像のように外さない）
// .css はヘルプセンターの見た目（help/assets/。H-1 で意図して足した: 追跡する文字のファイルは、どれも公開前の確認で読む）
const TEXT_EXT = new Set(['.js', '.mjs', '.txt', '.html', '.json', '.md', '.ps1', '.bat', '.yml', '.svg', '.css', '.gitignore', '.db', '']);
// 文字として調べないファイル（画像）。追跡するファイルの拡張子は、TEXT_EXT かここのどちらかに必ず入れる（下のテスト）
const BINARY_EXT = new Set(['.png', '.ico', '.woff2']);

test('追跡しているファイルの拡張子は、どれも「文字として調べる」か「画像として外す」かに分けてある（調べ漏れを作らない）', () => {
  const files = trackedFiles();
  if (!files) return;
  const loose = [...new Set(files.map((f) => path.extname(f)).filter((e) => !TEXT_EXT.has(e) && !BINARY_EXT.has(e)))].sort();
  assert.deepStrictEqual(loose, [], `公開前の確認で読まれない拡張子: ${loose.join(' ')}（TEXT_EXT か BINARY_EXT に足す）`);
});

// ---------------------------------------------------------------- 公開前の確認
test('個人名・個人パス・社内固有名がコードに残っていない', () => {
  const files = trackedFiles();
  if (!files) return; // git が無い環境ではスキップ
  const forbidden = [
    { re: /C:\\Users\\[A-Za-z0-9._-]+/i, what: '個人のWindowsパス' },
    { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, what: 'メールアドレス' },
    // 社内の個人アカウント名。GitHub のアカウント名（updater の REPO）は
    // 公開リポジトリでは元から公開情報なので対象外。
    { re: /\bkishis\b/i, what: '社内アカウント名' },
    { re: /techvan/i, what: '社名' },
  ];
  const hits = [];
  const SELF = 'test/repo.test.js'; // 禁止語そのものを持つので自分自身は対象外
  for (const f of files) {
    if (f === SELF) continue;
    if (!TEXT_EXT.has(path.extname(f))) continue;
    const text = read(f);
    text.split('\n').forEach((line, i) => {
      for (const { re, what } of forbidden) {
        if (re.test(line)) hits.push(`${f}:${i + 1} (${what}) ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepStrictEqual(hits, [], `公開できない情報が含まれている:\n${hits.join('\n')}`);
});

test('秘匿情報らしき文字列が含まれていない', () => {
  const files = trackedFiles();
  if (!files) return;
  const re = /(gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  const hits = [];
  for (const f of files) {
    if (!TEXT_EXT.has(path.extname(f))) continue;
    if (re.test(read(f))) hits.push(f);
  }
  assert.deepStrictEqual(hits, []);
});

test('.gitignore が持ち出してはいけないものを除外している', () => {
  const gi = read('.gitignore');
  for (const p of ['node_modules', 'local-engine', 'release', 'dist', 'src.backup-', '*.log']) {
    assert.ok(gi.includes(p), `.gitignore に ${p} が無い`);
  }
});

test('モデル・音声・ログなどの生成物が追跡されていない', () => {
  const files = trackedFiles();
  if (!files) return;
  const bad = files.filter((f) => /\.(gguf|bin|wav|mp3|log|exe)$/i.test(f)
    || f.startsWith('local-engine/') || f.startsWith('release/') || f.startsWith('node_modules/'));
  assert.deepStrictEqual(bad, []);
});

// ---------------------------------------------------------------- PowerShell
test('.ps1 は BOM付きUTF-8 + CRLF（PS5.1 が Shift-JIS と誤読しないため）', () => {
  const files = (trackedFiles() || fs.readdirSync(ROOT)).filter((f) => f.endsWith('.ps1'));
  assert.ok(files.length > 0, '.ps1 が見つからない');
  for (const f of files) {
    const raw = fs.readFileSync(path.join(ROOT, f));
    assert.ok(raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF, `${f}: BOMが無い`);
    const body = raw.subarray(3).toString('binary');
    const lf = (body.match(/\n/g) || []).length;
    const crlf = (body.match(/\r\n/g) || []).length;
    assert.strictEqual(crlf, lf, `${f}: CRLFでない行がある（LF ${lf} 行中 CRLF ${crlf} 行）`);
  }
});

test('.ps1 が PS5.1 で構文エラーになる書き方を使っていない', () => {
  const files = (trackedFiles() || fs.readdirSync(ROOT)).filter((f) => f.endsWith('.ps1'));
  for (const f of files) {
    const text = read(f);
    // コメント行を除いて判定する
    const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.ok(!/\bswitch\s*[({]/.test(code), `${f}: switch は PS5.1 で使わない`);
    assert.ok(!/\[ValidateSet\]/.test(code), `${f}: [ValidateSet] は PS5.1 で使わない`);
    assert.ok(!/utf8BOM/i.test(code), `${f}: -Encoding utf8BOM は PS5.1 に無い`);
  }
});

test('make-release.ps1 が updater の探すファイル名でzipを作る', () => {
  const rel = read('make-release.ps1');
  const upd = read('src/updater.js');
  const pattern = upd.match(/ASSET_PATTERN\s*=\s*\/\^([^/]+)\$\/i/);
  assert.ok(pattern, 'ASSET_PATTERN が読み取れない');
  const m = rel.match(/"(natsu-src-)"\s*\+\s*\$Version\s*\+\s*"(\.zip)"/);
  assert.ok(m, 'make-release.ps1 のzip名が読み取れない');
  const produced = `${m[1]}0.8.0${m[2]}`;
  assert.match(produced, new RegExp(`^${pattern[1]}$`, 'i'),
    `make-release.ps1 が作る ${produced} を updater が拾えない`);
  // 添付漏れ時のエラー文が実際のファイル名を案内しているか
  assert.ok(upd.includes('natsu-src-*.zip'),
    'updater のエラー文が実際のファイル名と違う（利用者が探せなくなる）');
});

// ---------------------------------------------------------------- IPC の整合
const preload = read('src/preload.js');
const main = read('src/main.js');
const appHtml = read('src/renderer/app.html');
const overlayHtml = read('src/renderer/overlay.html');

const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]);
// ソースを正規表現で検査するテストはコメントに一致して素通りしやすい。
// 「テストが通っているのに実装が無い」を防ぐため、コメントを落としてから見る。
const code = (t) => String(t).replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('preload の invoke に対応する ipcMain.handle が main.js にある', () => {
  const handled = new Set(all(/ipcMain\.handle\('([^']+)'/g, main));
  const missing = all(/ipcRenderer\.invoke\('([^']+)'/g, preload).filter((c) => !handled.has(c));
  assert.deepStrictEqual([...new Set(missing)], [],
    'preload が invoke するのに main.js に handle が無いチャンネル');
});

test('preload の send に対応する ipcMain.on が main.js にある', () => {
  const on = new Set(all(/ipcMain\.on\('([^']+)'/g, main));
  const missing = all(/ipcRenderer\.send\('([^']+)'/g, preload).filter((c) => !on.has(c));
  assert.deepStrictEqual([...new Set(missing)], [],
    'preload が send するのに main.js に受け口が無いチャンネル');
});

test('invoke と send を取り違えていない', () => {
  const handled = new Set(all(/ipcMain\.handle\('([^']+)'/g, main));
  const on = new Set(all(/ipcMain\.on\('([^']+)'/g, main));
  const invoked = new Set(all(/ipcRenderer\.invoke\('([^']+)'/g, preload));
  const sent = new Set(all(/ipcRenderer\.send\('([^']+)'/g, preload));
  for (const c of invoked) assert.ok(!on.has(c) || handled.has(c), `${c}: invoke なのに ipcMain.on で受けている`);
  for (const c of sent) assert.ok(!handled.has(c) || on.has(c), `${c}: send なのに ipcMain.handle で受けている`);
});

// 第2a1回 M-2b: DB の口（db:port。webContents.postMessage で口を渡す）と、DB の子が落ちた知らせ（db:lost）の受け口は、P-1 が preload に足す
// （P-1 は M-2b の後に載せる。repo.test.js はレーン M のファイルなので、P-1 の後の M-3 でこの2つを外す）
const PENDING_P1_EVENTS = new Set(['db:port', 'db:lost']);
test('main.js から送るイベントを preload が購読できる', () => {
  const listened = new Set(all(/ipcRenderer\.on\('([^']+)'/g, preload));
  const sends = [
    ...all(/sendToMainWin\('([^']+)'/g, main),
    ...all(/sendToOverlay\('([^']+)'/g, main),
    ...all(/webContents\.send\('([^']+)'/g, main),
    ...all(/webContents\.postMessage\('([^']+)'/g, main),
  ].filter((c) => !c.includes('${') && !PENDING_P1_EVENTS.has(c));
  const missing = [...new Set(sends)].filter((c) => !listened.has(c));
  assert.deepStrictEqual(missing, [],
    'main.js が送るのに preload が受け口を公開していないイベント');
});

test('画面が呼ぶ API がすべて preload に公開されている', () => {
  const block = (name) => {
    const i = preload.indexOf(`exposeInMainWorld('${name}'`);
    assert.ok(i >= 0, `${name} が preload に無い`);
    const rest = preload.slice(i);
    const end = rest.indexOf('\n});');
    return rest.slice(0, end > 0 ? end : rest.length);
  };
  const names = (src) => new Set(all(/^\s{2}([A-Za-z][\w$]*):/gm, src));

  const koeApp = names(block('koeApp'));
  const koeOverlay = names(block('koeOverlay'));
  assert.ok(koeApp.size > 10 && koeOverlay.size > 5, 'preload の解析に失敗');

  const used = (html, re) => [...new Set(all(re, html))];
  const missingApp = used(appHtml, /window\.koeApp\.(\w+)/g).filter((n) => !koeApp.has(n));
  assert.deepStrictEqual(missingApp, [], 'app.html が使うのに preload に無い koeApp の API');

  const missingOverlay = used(overlayHtml, /koeOverlay\.(\w+)/g).filter((n) => !koeOverlay.has(n));
  assert.deepStrictEqual(missingOverlay, [], 'overlay.html が使うのに preload に無い koeOverlay の API');
});

test('外部URLを開くのはコード内で組み立てたものだけ', () => {
  // 画面から渡された文字列を openExternal に流すと、表示中の内容次第で
  // 任意のページを開けてしまう。許すのは次の2つだけ。
  //   - REPO 定数から組み立てたリリースページ
  //   - Windows のサウンド設定（固定のURI）
  //   - （0.9.2 I-1 で意図して足した）HELP_URL の定数と、決まった記事の一覧で照らした道（lib.helpPath。一覧に無ければ ''）
  const ALLOWED = [
    /^`https:\/\/github\.com\/\$\{updater\.REPO\}/,
    /^'ms-settings:[a-z]+'$/,
    /^`\$\{HELP_URL\}\$\{lib\.helpPath\(article$/,
  ];
  const calls = [...main.matchAll(/shell\.openExternal\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length > 0, 'openExternal の呼び出しが見つからない');
  for (const c of calls) {
    assert.ok(ALLOWED.some((re) => re.test(c)),
      `画面から受け取ったURLを開いていないか: ${c}`);
  }
});

test('録音されるスピーカーは表示だけで、選ばせない', () => {
  // ループバックの取得元は Windows の既定の再生デバイス固定で、
  // アプリから指定する手段が無い。選べる風のUIを出す方が誤解を生む。
  assert.ok(appHtml.includes('id="spkNow"'), 'スピーカーの表示が無い');
  assert.match(appHtml, /id="spkNow"[^>]*readonly/, '編集できてしまう');
  assert.ok(!/<select id="spkSelect"/.test(appHtml), '選択式になっている');
  assert.ok(appHtml.includes('openSoundSettings()'), 'Windows設定への導線が無い');
});

test('更新の告知が設定タブの外にも出る', () => {
  // トーストだけだと数秒で消え、見逃すと更新に気づけない
  assert.ok(appHtml.includes('id="updBadge"'), '常駐する告知の要素が無い');
  assert.ok(appHtml.includes('function renderUpdateBadge'), '告知を組み立てる関数が無い');
  const from = appHtml.indexOf('function showUpdate(r)');
  assert.ok(from >= 0, 'showUpdate が無い');
  const body = appHtml.slice(from, appHtml.indexOf('\n  }', from) + 4);
  assert.ok(body.includes('renderUpdateBadge(r)'), '更新を検出したのに告知を出していない');
});

test('公開したのに画面から呼ばれない API がない', () => {
  // 使われないまま残っていると「機能があるはず」と誤解する。
  // 録音中のメモ入力は、API はあるのに画面から呼んでいなかったため
  // 長く使えないままになっていた。
  const block = (name) => {
    const i = preload.indexOf(`exposeInMainWorld('${name}'`);
    const rest = preload.slice(i);
    const end = rest.indexOf('\n});');
    return rest.slice(0, end > 0 ? end : rest.length);
  };
  // main 側が先に足し、画面がまだ使っていない API（先に足すときだけ入れ、画面が使い始めたら空に戻す）
  // 第0b回 Task 13・14 で入れた取り込みの5つは、画面の取り込みの欄（Task 15）が呼び始めたので外した
  // 第1c回 Task C-2 で足した meetingSetLocalOnly は、会議中の［この会議は PC の中だけ］（Task C-3）が呼び始めたので外した
  // 第1b回 Task A-2 で足した uiState・uiSave（画面の覚え書き）は、画面のサイドバー（Task B-2）が呼び始めたので外した
  // 第1b回 Task A-3 で足した meetingSetPaused（ページの［一時停止］）は、録音中のページ（Task B-5）が呼び始めたので外した
  // 第1d回 Task A-2 で足したログインの4つ（accountStatus・accountStart・accountVerify・accountLogout）は、設定のカード「アカウント」（Task A-4）が
  // 呼び始めたので外して空に戻した
  // 第1d回 Task A-6 で足した meetingRetry（帯の［もう一度］）は、録音中のページの帯（Task A-7）が呼び始めたので外して空に戻した
  // 第1d回 Task A-11 で足した accountLogin（Cloudflare Access のログインの窓）は、設定のカード「アカウント」（Task A-12）が呼び始めたので外して空に戻した
  // 0.9.0 O-2 で足した koeOverlay.reportSize・onForm（録音バーの窓の大きさと形）は、録音バーの画面（O-3）が呼び始めたので外して空に戻した
  // 0.13.0 ED-2（計画 docs/plans/2026-10-24-130.md）で足した要約の編集の4つ（blockSplit・blockMerge・blockTurnInto・blockDuplicate）は、
  // 画面の行の編集（ED-4・ED-6）が呼び始めたら外す。blockSplit・blockMerge・blockTurnInto は ED-4 が、blockDuplicate は ED-6 が呼び始めたので外して空に戻した
  const PENDING_APP = new Set([]);
  for (const [ns, html] of [['koeApp', appHtml], ['koeOverlay', overlayHtml]]) {
    const names = all(/^\s{2}([A-Za-z][\w$]*):/gm, block(ns));
    const used = new Set(all(new RegExp(`${ns}\\.(\\w+)`, 'g'), html));
    const dead = names.filter((n) => !used.has(n) && !PENDING_APP.has(n));
    assert.deepStrictEqual(dead, [], `${ns} に呼ばれていない API がある`);
    // 画面が呼び始めた名前は PENDING_APP から外す（残すと、後で呼ばれなくなっても気づけない）
    const stale = names.filter((n) => used.has(n) && PENDING_APP.has(n));
    assert.deepStrictEqual(stale, [], `${ns} の画面が呼び始めたのに PENDING_APP に残っている`);
  }
});

test('preload に公開したまま main.js 側が無い API がない', () => {
  const handled = new Set([
    ...all(/ipcMain\.handle\('([^']+)'/g, main),
    ...all(/ipcMain\.on\('([^']+)'/g, main),
  ]);
  const unreachable = [...new Set([
    ...all(/ipcRenderer\.invoke\('([^']+)'/g, preload),
    ...all(/ipcRenderer\.send\('([^']+)'/g, preload),
  ])].filter((c) => !handled.has(c));
  assert.deepStrictEqual(unreachable, []);
});

// ---------------------------------------------------------------- その他
test('パッケージ版でもアプリ内更新ができる設定になっている', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.build.asar, false,
    'asar 同梱だと src/ が書庫の中に入り、ファイル単位で差し替えられなくなる');
});

test('更新の可否はビルド種別ではなく「差し替えられるか」で判断する', () => {
  assert.ok(main.includes('function updateTarget'), 'updateTarget が無い');
  assert.ok(/\\.asar\$/.test(main), 'asar 同梱を検出していない');
  assert.ok(!/applyable:\s*!app\.isPackaged/.test(main),
    'インストーラー版というだけで更新を拒否している');
});

test('トレイのアイコンが nativeImage の読める形式で置かれている', () => {
  // Electron の nativeImage は PNG / JPEG（Windows は ICO も）だけ。
  // SVG を渡すと空の画像になり、タスクトレイが透明になる。
  for (const f of ['src/assets/tray.ico', 'src/assets/tray-rec.ico',
    'src/assets/tray.png', 'src/assets/tray-rec.png']) {
    const b = fs.readFileSync(path.join(ROOT, f));
    const isPng = b[0] === 0x89 && b.toString('binary', 1, 4) === 'PNG';
    const isIco = b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0;
    assert.ok(isPng || isIco, `${f} が PNG でも ICO でもない`);
  }
  assert.ok(!/image\/svg\+xml/.test(main), 'SVG から nativeImage を作っている（透明になる）');
});

test('トレイのアイコンは src 配下にある（アプリ内更新で一緒に入れ替わるように）', () => {
  const files = trackedFiles();
  if (!files) return;
  for (const f of ['src/assets/tray.ico', 'src/assets/tray-rec.ico']) {
    assert.ok(files.includes(f), `${f} が追跡されていない`);
  }
});

// 意図: 設定と履歴は一時ファイル経由で書く（直接書くと、書き込み中に落ちたときに壊れた JSON が残り、次回起動で
// 既定値に戻って設定が消える）。一時ファイル・fsync・名前の変更は jsonfile.test.js が実行して固定する（第1a回 Task 2-2）
test('設定と履歴の保存が一時ファイル経由で行われる（JS3 の部品を通す）', () => {
  assert.ok(!main.includes('function saveJson') && !main.includes('function loadJson'), '古い読み書きが残っている');
  for (const f of ['function writeSettingsFile', 'function writeHistoryFile']) {
    const i = main.indexOf(f);
    assert.ok(i >= 0, f);
    assert.ok(main.slice(i, main.indexOf('\n}', i)).includes('J.writeJsonFile('), `${f} が部品を通していない`);
  }
});

test('READMEのデータ保存先が実際の保存先と一致する', () => {
  // Electron の app.getName() と同じ解決順（setName は使っていない）
  const pkg = JSON.parse(read('package.json'));
  const name = pkg.productName || pkg.name;
  const readme = read('README.md');
  assert.ok(readme.includes(`%APPDATA%\\${name}`),
    `README が %APPDATA%\\${name} を案内していない`);
  assert.ok(!/%APPDATA%\\koetype/.test(readme),
    '実在しない保存先（koetype）が README に残っている');
});

test('package.json のバージョンが semver 形式', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(pkg.name, 'natsu');
});

test('配布物に必要なファイルが build.files に含まれている', () => {
  const pkg = JSON.parse(read('package.json'));
  const files = pkg.build.files.join(' ');
  assert.ok(files.includes('src/**/*'), 'src が配布対象に無い');
  assert.ok(files.includes('package.json'), 'package.json が配布対象に無い');
});

test('main.js が require するローカルモジュールが実在する', () => {
  for (const f of ['src/main.js', 'src/minutes.js', 'src/store.js', 'src/cite.js',
    'src/actions.js', 'src/meetingType.js', 'src/updater.js', 'src/preload.js']) {
    for (const rel of all(/require\('(\.[^']+)'\)/g, read(f))) {
      const p = path.join(ROOT, path.dirname(f), rel.endsWith('.js') ? rel : `${rel}.js`);
      assert.ok(fs.existsSync(p), `${f}: ${rel} が見つからない`);
    }
  }
});

test('HTML 内のスクリプトが構文的に正しい', () => {
  for (const [name, html] of [['app.html', appHtml], ['overlay.html', overlayHtml]]) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, `${name}: script が見つからない`);
    for (const s of scripts) {
      assert.doesNotThrow(() => new Function(s), `${name} の script に構文エラー`);
    }
  }
});

// ---------------------------------------------------------------- v0.9.6 の機能の結線
test('会議の所要時間は開始から停止までで計る', () => {
  // 文字起こし待ちを混ぜると、4分の会議が12分と記録される
  assert.match(main, /meeting\.stoppedAt = Date\.now\(\)/);
  assert.match(main, /m\.stoppedAt \|\| Date\.now\(\)/);
  // 0.13.0 CLK-3（2026-10-27 の持ち主の答え）で意図して変えた: 一時停止の間は知らせが届いた時刻（mtPausedAt）で止める。停止の時刻を先に見るのは今のまま
  assert.ok(appHtml.includes('(mtStoppedAt || mtPausedAt || Date.now()) - mtStartedAt'));
});

// 0.11.0 P-12（P12・R5）で意図して変えた: 一般・その他は無い。判定材料が無ければ決まらない（''。画面は「自動」と決まらなかった文）
test('判定材料が無いときの会議の種類は決まらない（\'\'。定例の型に合わせて担当・期限を作らせない: 0.1.2）', () => {
  // 0.11.0 M-5 で意図して変えた: 自動の答えは detectType の答えか、決まらないときの前の同じ曜日・時刻の会議の種類（page.autoType）
  assert.match(main, /page\.meetingType = page\.autoType;/);
  assert.ok(!/autoType === 'general' \? 'standup'/.test(main), '判定材料が無いときに定例へ寄せている');
  assert.ok(!appHtml.includes("curPage.meetingType || 'general'"));
  assert.ok(appHtml.includes("sel.add(new Option('自動（文字起こしから判定）', ''));"));
  assert.ok(appHtml.includes(`const AUTO_UNDECIDED_TEXT = '${require('../src/meetingType').AUTO_UNDECIDED_TEXT}';`), '画面の決まらなかった文が meetingType と違う');
});

test('Markdown保存は IPC ごと撤去済み', () => {
  assert.ok(!appHtml.includes('Markdown保存'));
  assert.ok(!main.includes("'page:export'"));
  assert.ok(!preload.includes('pageExport'));
});

test('閉じるボタンは既定でアプリを終了する（設定でトレイ常駐に戻せる）', () => {
  // 既定は settings.js の defaultSettings（第1a回 Task 2-2 で main の DEFAULT_SETTINGS から移した。意図は同じ: 既定はトレイに残さない）
  assert.match(main, /const DEFAULT_SETTINGS = defaultSettings\(os\.cpus\(\)\.length\);/);
  assert.strictEqual(require('../src/settings').defaultSettings(8).stayInTray, false);
  assert.match(main, /if \(settings\.stayInTray\) \{ e\.preventDefault\(\); mainWin\.hide\(\); return; \}/);
  assert.ok(appHtml.includes("stayInTray: $('stayInTray').checked"));
});

test('記録を新しく始めたら、開いていた議事録を閉じる', () => {
  // 第1b回 Task B-5 から: 記録を始めると記録中のタブ（live）を開いて移り、そのタブを選ぶときに開いていたページを確定して閉じる
  //（ページのタブは残す。動きは stage1b.app.test.js の N4b と runtime.app.test.js の「ホットキーで記録開始しても…」が見る）
  assert.match(appHtml, /if \(started\) \{\s*if \(!hasTab\('live'\)\) openTabs\.push\(\{ key: 'live' \}\);\s*activateTab\('live'\);/);
  assert.match(appHtml, /function showLive\(\) \{\s*if \(curId \|\| curPage\) \{\s*flushEdits\(\);\s*curId = null; curPage = null; curSegs = \[\];/);
});

// 0.11.0 V-1（決めたこと 8・F14）で意図して変えた: 雛形に替えるかは、本当のメモを持つ DB が page.setType の preset で1回で決める（画面の古い写しで決めない）
test('種類を替えて見出しを入れるのは、人が書いたメモを上書きしない（DB の page.setType の preset。画面は待っているメモの保存を先に書き終える）', () => {
  assert.ok(!/const isPreset = !cur \|\| mtypes\.some/.test(appHtml), '画面の写しでメモを雛形に替えている');
  assert.ok(appHtml.includes('const r = await window.koeApp.pageSetType(pid, v, true);'));
  assert.ok(!/pageSetMemo\(curId, d2\.agenda\)/.test(appHtml));
});

// 0.11.0 V-1（決めたこと 7・当て直し 15）: 手を付けていないメモは memoTypes.isUntouchedMemo と画面の写し untouchedView で同じ表。決まらなかった文も同じ
test('0.11.0 V-1: untouchedView（app.html）と memoTypes.isUntouchedMemo に同じ表を当てて同じ答え。AUTO_UNDECIDED_TEXT も同じ', () => {
  const M = require('../src/memoTypes');
  const mt = require('../src/meetingType');
  const view = new Function(`${fnFromApp('untouchedView')}\nreturn untouchedView;`)();
  const presets = M.listMemoTypes().map((k) => k.preset);
  const legacy = mt.listTypes().map((t) => t.agenda).filter(Boolean);
  const memos = ['', '   ', '\n\n', null, undefined, ...presets, ...legacy, ...presets.map((p) => `  ${p.replace(/\n\n/g, '\n')}  \n\n`), ...presets.map((p) => `${p}予算`),
    ...legacy.map((a) => a.replace(/\n/g, '\r\n')), '予算の相談', '■ 目的', `${presets[0]}\n■ 足した見出し`, 3, '■ 課題・要望（N）\n■ 時期（T）'];
  for (const m of memos) for (const lg of [legacy, [], undefined, ['', '  ']]) {
    assert.strictEqual(view(m, presets, lg), M.isUntouchedMemo(m, lg), JSON.stringify([m, lg]));
  }
  assert.ok(appHtml.includes(`const AUTO_UNDECIDED_TEXT = '${mt.AUTO_UNDECIDED_TEXT}';`));
});

test('並べ替えはハンドルからだけ（本文のテキスト選択と衝突させない）', () => {
  assert.match(appHtml, /grip\.onmousedown = \(\) => \{ el\.draggable = true; \}/);
  // 行全体を常時 draggable にしていないこと
  assert.ok(!/el\.draggable = true;\s*$/m.test(appHtml.replace(/grip\.onmousedown.*$/m, '')));
});

// ---------------------------------------------------------------- v0.9.7 の機能の結線
test('文字起こしが切れる問題への3段の対策が入っている', () => {
  // (1) 区切りの見張りは main からの tick（main のタイマーは間引かれない）。
  //     backgroundThrottling: false は Windows で透過ウィンドウの透明を壊すので
  //     使わない（実機でピルの角の外に不透明の矩形が出た）。コメントに語が
  //     残るためコードだけを見る。
  assert.ok(!/backgroundThrottling/.test(code(main)), '透明を壊す設定が残っている');
  assert.match(main, /sendToOverlay\('overlay:tick'/);
  assert.match(main, /function startMeetingTick/);
  assert.ok(preload.includes("onTick: (cb) => ipcRenderer.on('overlay:tick'"));
  assert.ok(overlayHtml.includes('window.koeOverlay.onTick(() => cutSegmentIfOverdue(recorder))'));
  // (2) 時間切れを音声の長さに比例させる（固定240秒で9分の区間が丸ごと消えた）
  // 0.9.4 S-2（決めたこと 15・16）で意図して直した: 待ち時間は mainlib.localTimeoutMs（音声の長さと測った速さ。stage094.lib で実行）で決め、
  // PC への要求は Node の fetch（AbortSignal の時計）でなく localhttp.postInference（自前の時計だけ）で送る
  assert.match(main, /const planMs = localTimeoutMs\(\{ audioMs: Number\(durationMs\) \|\| 0, rtf: pacedRtf\(\) \}\);/);
  // やり直し（0.1.1）も含めて、計算した待ち時間の内に収める
  assert.match(main, /const deadline = Date\.now\(\) \+ waitMs;/, '計算した待ち時間が使われていない');
  assert.match(main, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\) \}\);/, '計算した待ち時間が使われていない');
  // 第1c回 Task A-4（意図して変えた）: 区間と音声入力は transcribeAuto を通り、手元の道で transcribeLocal に尻尾と長さをそのまま渡す
  // 0.9.1 Q-2（意図して変えた）: 音声入力は { dictation: true } を渡す。経路を決めて送る所は transcribeRouted（transcribeAuto は無音と作り話を見てから呼ぶ）
  assert.match(main, /transcribeAuto\(buffer, tail, durationMs[,)]/);
  assert.match(main, /transcribeAuto\(buffer, '', durationMs, \{ dictation: true \}\)/);
  assert.match(fnBody(code(main), 'async function transcribeAuto(', '\n}'), /transcribeRouted\(wav, tail, durationMs, opts, scope, what\)/, '経路を決めて送る所に尻尾と長さをそのまま渡していない');
  assert.match(fnBody(code(main), 'async function transcribeRouted(', '\n}'), /transcribeLocal\(wav, tail, durationMs, opts\)/, '手元の道に尻尾と長さをそのまま渡していない');
  // (3) 区切りの保険（音声パイプライン由来のイベントで見張る）
  assert.match(overlayHtml,
    /mode === 'meeting' && segDeadline && Date\.now\(\) >= segDeadline/, '区切りの保険が無い');
  // (4) 録音・処理中はOSに眠らせない。updateTray は全ての状態遷移で
  //     呼ばれるので、そこに結線されていることまで見る
  assert.match(main, /powerSaveBlocker\.start\('prevent-app-suspension'\)/);
  assert.match(main, /function updateTray\(\) \{\n  updatePowerBlock\(\);/);
});

test('画面の配色の設定が結線されている', () => {
  // 既定は settings.js の defaultSettings（第1a回 Task 2-2 で移した。意図は同じ: 既定は Windows の設定に追従）
  assert.match(main, /const DEFAULT_SETTINGS = defaultSettings\(os\.cpus\(\)\.length\);/);
  assert.strictEqual(require('../src/settings').defaultSettings(8).theme, 'system');
  assert.match(main, /nativeTheme\.themeSource/);
  assert.ok(appHtml.includes("theme: $('themeSel').value"));
  assert.ok(appHtml.includes('@media (prefers-color-scheme: dark)'));
});

test('コピーは開いているタブの中身を写す', () => {
  const cp = appHtml.slice(appHtml.indexOf("mk('コピー'"));
  assert.ok(cp.includes("pane === 'script'"), '文字起こしタブの分岐が無い');
  assert.ok(cp.includes("pane === 'memo'"), 'メモタブの分岐が無い');
});

test('検索は文字起こしだけを対象にする', () => {
  const st = read('src/store.js');
  const fn = st.slice(st.indexOf('function searchFullText'), st.indexOf('function openActions'));
  assert.ok(!fn.includes('inBlocks'), '要約側も検索している');
  assert.ok(fn.includes('getTranscript'));
  assert.ok(appHtml.includes('文字起こし検索'));
  assert.ok(!appHtml.includes('全文検索'));
});

test('一覧に未完了バッジを出さない（高さを一定に保つ）', () => {
  assert.ok(!appHtml.includes('`未完了 ${'), '未完了バッジが残っている');
  assert.match(appHtml, /\.pitem \.t \{[^}]*white-space: nowrap/);
});

test('設定のオン・オフはトグルで表す（議事録のチェックは四角のまま）', () => {
  assert.match(appHtml, /\.check input \{[\s\S]{0,200}?appearance: none/);
  // .blk のチェックボックス（完了の印）には appearance:none を掛けていない
  assert.ok(!/\.blk[^\n]*input[^\n]*\{[\s\S]{0,200}?appearance: none/.test(appHtml));
});

// 0.11.0 V-1（決めたこと 3。D42 の言葉）で意図して変えた: 欄の名前は「会議の種類」
test('画面の名称は「会議の種類」', () => {
  assert.ok(appHtml.includes('>会議の種類</span>'));
  assert.ok(!appHtml.includes('>要約タイプ</span>'));
  assert.ok(!appHtml.includes('>会議タイプ</span>'));
  assert.ok(appHtml.includes('aria-label="会議の種類"'));
});

test('並べ替えのつまみは6点の1文字', () => {
  assert.ok(appHtml.includes("grip.textContent = '⠿'"));
});

test('要約の文体は報告文書の常体（指示だけでなく例で見せる）', () => {
  // 0.11.0 M-2（決めたこと 14）で意図して変えた: 書き方のきまり（OUTPUT_RULE）は main.js から src/memoTypes.js へ1文字も変えずに移した
  // （役割の文 MINUTES_SYS は main.js のまま）
  const mt = fs.readFileSync(path.join(__dirname, '..', 'src', 'memoTypes.js'), 'utf8');
  assert.ok(mt.includes('「です」「ます」は使わない'));
  assert.match(main, /文体は報告文書の常体/);
  // 3Bクラスは指示より例をまねる。実機で指示だけでは効かなかった
  assert.ok(mt.includes('良い例:'), '良い例が無い');
  assert.ok(mt.includes('悪い例:'), '悪い例が無い');
});

// ---------------------------------------------------------------- レビュー指摘の修正
test('ダーク定義はすべての基底ルールより後ろにある', () => {
  // @media は詳細度に影響しない。前に置くと :root / body の上書きが
  // カスケード順で負け、地色がライトのまま文字だけ白くなって読めない。
  // 第1b回（B-1）で意図して変えた: 目印を旧い地色 #e9edf5・グラデーションから
  // 「:root の基底のトークンの規則」と「body の規則」に替えた。ダークで上書きする
  // 固定色は無くなり（トークンだけで組む）、その網羅は COLOR-03 が守る。
  const rootAt = appHtml.indexOf(':root {');
  const bodyAt = appHtml.indexOf('  body {');
  const mediaAt = appHtml.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(rootAt > 0 && bodyAt > 0 && mediaAt > bodyAt && mediaAt > rootAt, 'ダーク定義が基底より前にある');
  assert.ok(!appHtml.includes('#e9edf5') && !appHtml.includes('.blob'), '旧い地色とぼかし玉が残っている');
});

test('ウィンドウの地色がテーマに追従する', () => {
  // ライト固定だとダークで開くたび・リサイズのたびに白くまたたく
  assert.match(main, /backgroundColor: nativeTheme\.shouldUseDarkColors/);
  assert.match(main, /setBackgroundColor\(nativeTheme\.shouldUseDarkColors/);
  // 第1b回 Task A-2: 窓の地色は画面の地（N1 の #191919・#ffffff）と同じ。違うと開くたびにまたたく
  assert.ok(!main.includes("'#171a21'") && !main.includes("'#E9EDF5'"), '旧い地色が残っている');
  assert.strictEqual((main.match(/nativeTheme\.shouldUseDarkColors \? '#191919' : '#ffffff'/g) || []).length, 2);
});

test('区切りの保険は遅延中のタイマーを必ず消してから切る', () => {
  // 消さないと ID を失ったタイマーが生き残り、あとから発火して
  // 「次の」区間を途中で切る。以後ずっとずれが続く
  const guard = overlayHtml.slice(overlayHtml.indexOf("mode === 'meeting' && segDeadline"));
  const upto = guard.slice(0, guard.indexOf('rec.stop()'));
  assert.ok(upto.includes('clearTimeout(autoStopId)'), '旧タイマーを消していない');
});

test('メモのコピーは画面の入力欄の今の文字を写す', () => {
  // 保存は500ms遅れで走る。書いた直後に押すと保存前の古い値が写る
  const cp = appHtml.slice(appHtml.indexOf("mk('コピー'"));
  assert.ok(cp.includes("$('pMemo').querySelector('textarea')"));
});

test('一覧の「要約なし」はタイプ章より左にある（右端で見切れない）', () => {
  // 第1b2回 L-2: 2行の行は検索の窓の結果（renderResults）。サイドバーの1行の行は title の中で同じ順（stage1b2.look.test.js）
  // 第1b2回の直し: 窓の結果の2行目もサイドバーの title と同じ rowTitle（灰色の1つの文。並びは stage1b2.look・stage1b2.fix が見る）
  const fn = (name) => appHtml.slice(appHtml.indexOf(`function ${name}(`), appHtml.indexOf('\n  }\n', appHtml.indexOf(`function ${name}(`)));
  const rt = fn('rowTitle');
  // 0.11.0 V-1 で意図して変えた: 種類は選べる鍵のときだけ（parts.push(def.label)）
  assert.ok(rt.indexOf("parts.push('要約なし')") >= 0 && rt.indexOf("parts.push('要約なし')") < rt.indexOf('parts.push(def.label)'),
    '要約なしが右側にあり、狭い幅で見切れる');
  assert.ok(fn('renderResults').includes('rowTitle(p)'), '窓の結果の2行目が rowTitle を使っていない');
});

test('README が現行の機能名と一致している', () => {
  const readme = read('README.md');
  assert.ok(!readme.includes('会議タイプ'), '旧名「会議タイプ」が残っている');
  assert.ok(!readme.includes('全文検索'), '旧名「全文検索」が残っている');
  assert.ok(!readme.includes('Markdown書き出し'), '無くなった機能の記述が残っている');
  // 0.11.0 G で意図して変えた: 欄の名前は「会議の種類」（決めたこと 3）。一般・その他は無い（P12）
  assert.ok(readme.includes('会議の種類') && readme.includes('メモの型') && readme.includes('打ち合わせの質'));
  assert.ok(!readme.includes('要約タイプ'), '旧名「要約タイプ」が残っている');
  assert.ok(readme.includes('文字起こし検索'));
});

// ---------------------------------------------------------------- v0.9.9 の結線
test('エンジンの起動確認は /health を見る', () => {
  // 「/」だと llama-server がモデル読み込み中でも 200 を返し、
  // 準備完了と誤認して直後の推論が 503 になる（実機で発生）
  assert.match(main, /\/health`;/);
  assert.ok(!/`http:\/\/127\.0\.0\.1:\$\{enginePort\(eng\)\}\/`/.test(main), '「/」を見ている');
});

// 「要約エンジンの 503 は準備中」は 0.10.0 LS-2（D59）で外した（手元の llama の要約 llmChat が無い）
test('設定は自動保存（保存ボタンは無い）', () => {
  assert.ok(!appHtml.includes('saveBtn'), '保存ボタンが残っている');
  assert.ok(appHtml.includes("$('tabSettings').addEventListener('change'"), '自動保存の結線が無い');
});

test('スレッド数とポートに説明がある', () => {
  // 0.9.2 I-3（計画 docs/plans/2026-10-21-092.md）で意図して変えた: 見える説明は「通常は変更不要です。」の1行、意味は ⓘ の吹き出し
  assert.ok(appHtml.includes('通常は変更不要です。<button type="button" class="setinfo"'));
  assert.ok(appHtml.includes('スレッド数は文字起こしに使う CPU の数です'));
  // 0.10.0 LS-3（D59）で意図して直した: 要約のエンジンの欄（「2つのエンジンのポートは別の番号に」の吹き出し）を外した
  assert.ok(!appHtml.includes('2つのエンジンのポートは別の番号にしてください'));
});

// ---------------------------------------------------------------- 検索の本文対応
test('「すべて」の検索が要約の本文とメモに当たる', () => {
  // タイトルと最初の1行しか見ていなかったため、実機で
  // 「検索が全部壊れている」と報告された
  const st = read('src/store.js');
  assert.match(read('src/pagerules.js'), /searchText: page\.blocks\.map/);   // 一覧のまとめ summarize は第2a1回 D-1 で pagerules.js へ切り出した
  const fn = st.slice(st.indexOf('function searchIndex'), st.indexOf('function searchFullText'));
  assert.ok(fn.includes('p.searchText'), '検索が本文を見ていない');
  assert.ok(fn.includes('snippet'), '当たった箇所を見せていない');
  // 古い索引の作り直し（これが無いと既存の議事録は検索に出てこないまま）
  assert.match(st, /typeof index\.pages\[i\]\.searchText === 'string'/);
});

// ---------------------------------------------------------------- 録音バーと設定の並び
test('録音バーは一時停止と停止のボタンを持つ', () => {
  assert.ok(overlayHtml.includes('id="pauseBtn"'), '一時停止ボタンが無い');
  assert.ok(overlayHtml.includes('id="stopBtn"'), '停止ボタンが無い');
  // 0.9.0 O-3（設計書 D25）で意図して変えた: 停止は赤い丸に白い四角（いちばん強い色）、一時停止は二本線
  assert.match(overlayHtml, /\.pbtn\.stop \{[\s\S]{0,160}?background: var\(--rec\)/);
  assert.match(overlayHtml, /\.pbtn \.sq \{[\s\S]{0,160}?background: #fff/);
  assert.match(overlayHtml, /class="pause-ico"><span class="bar"><\/span><span class="bar">/);
});

test('一時停止は区間を締めてマイクを解放する', () => {
  // 持ったまま止めると再開までの分が同じ区間に混ざり、止めた意味が無くなる。
  // マイクを掴んだままだと、止めたのに録っているように見える。
  const fn = code(overlayHtml).slice(code(overlayHtml).indexOf('function pauseRec'));
  const body = fn.slice(0, fn.indexOf('async function resumeRec'));
  assert.ok(body.includes('recorder.stop()'), '区間を締めていない');
  assert.ok(body.includes('releaseStream()'), 'マイクを解放していない');
  assert.ok(body.includes('reportPause(true)'), 'main へ知らせていない');
});

test('一時停止した時間は会議の長さに含めない', () => {
  // 計算そのものは src/mainlib.js の meetingDurationSec（main.test.js で実行して検査）。
  // ここでは main.js が停止時刻を渡してそれを呼んでいることを見る。
  const lib = read('src/mainlib.js');
  assert.match(lib, /const pausedTotal = .*pausedMs/);
  assert.match(lib, /m\.startedAt - pausedTotal/);
  assert.match(main, /const endAt = m\.stoppedAt \|\| Date\.now\(\);/);
  assert.match(main, /meetingDurationSec\(m, endAt\)/, '所要時間を純関数で計算していない');
  assert.ok(appHtml.includes('- mtPausedMs'), '画面の時計が一時停止を引いていない');
});

test('一時停止中は無音警告も区間の切り出しも動かない', () => {
  const c = code(overlayHtml);
  assert.match(c, /function checkSilence\([^)]*\) \{\s*if \(stopping \|\| cancelled \|\| paused/);
  assert.match(c, /function cutSegmentIfOverdue\([^)]*\) \{\s*if \(paused\) return;/);
  // main 側の「一時停止中は合図を送らない」は mainlib.tickStep の判断（main.test.js で実行）。
  // ここでは interval が tickStep に overlay:tick を送る手を渡していることだけ見る
  assert.match(code(main), /tickStep\(\{ state, meeting \},\s*\(\) => sendToOverlay\('overlay:tick', \{\}\)/);
});

test('議事録の破棄ボタンは録音バーに出さない（誤操作で会議が消える）', () => {
  assert.match(overlayHtml, /\.pill\.meeting \.pbtn\.ng \{ display: none; \}/);
});

// 0.9.0 U-2（SP4・D24）で意図して変えた: 設定は項目ごとのカード（計画「設定の項目とカード」の表の順）。「動作」と「オンライン」の
// カードは無くなった（中の欄はホットキー・起動と終了・録音バー・マイクと相手の声・文字起こし・要約（Claude Code）へ動いた）。
// 外観（#appearanceTitle）とアカウント（#accountTitle）は id の付いた <h2> なのでここには出ない
// 0.9.0 見た目の直し（利用者に見せる前の見直し）で意図して変えた: 項目の見出しと同じ言葉のカードの見出し（「オフライン」）は hidden で出さない。
// カードの名前としては残るので、hidden の付いた <h2> もここで数える（並びと数は変えない）
test('設定カードの並びは指定通り', () => {
  // 0.9.2 I-2 で意図して変えた: 見出しの横の ⓘ（<button class="setinfo">）は名前でないので、タグを外した文で見る
  const heads = [...appHtml.matchAll(/<h2(?: hidden)?>(.+?)<\/h2>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
  assert.deepStrictEqual(heads, [
    'ホットキー',
    '起動と終了',
    '会議の検出',   // 0.9.3 M-4 で意図して変えた: 「録音」の頭に会議の検出
    '録音バー',
    'マイクと相手の声',
    '話し声が無いとき',   // 0.9.1 Q-3（D29）で意図して変えた: 話し声が無いときに自動で止める
    '文字起こし',
    'ユーザー辞書（認識ヒント）',
    '要約（Claude Code）',
    'Claude との連携（MCP）',   // 0.10.0 C-3（MR8）で意図して変えた: 要約（Claude Code）の次に Claude との連携
    '打ち合わせの質',   // 0.11.0 V-3（QM6）で意図して変えた: Claude との連携（MCP）の次に打ち合わせの質
    'ローカル AI',   // 第1d回 A-13（D19）で意図して変えた: カード「エンジン」を「オフライン」に。0.9.3 M-0（D54）で「ローカル AI」に
    'アップデート',
  ]);
});

test('録音バーは暗色地に合った色で描く', () => {
  // ピルを暗色にしたのに描画色を明るい地のままにすると、
  // 波形もスピナーも見えなくなる（実機で波形が真っ黒になった）
  // 0.9.0 O-3（設計書 D25）で意図して変えた: 波形（canvas の fillStyle）を5つの点にした。点の色は明るい（一時停止中も白の 45%）
  const c = code(overlayHtml);
  assert.match(c, /\.lv i \{[^}]*background: var\(--fg\)/, '点が暗いまま');
  assert.match(c, /\.pill\.paused \.lv i \{ background: rgba\(255, 255, 255, 0\.45\)/, '一時停止中の点が暗いまま');
  assert.ok(!/rgba\(27,\s*30,\s*37/.test(c), '明るい地向けの墨色が残っている');
});

test('録音バーに外向きの影を付けない', () => {
  // Windows の透過ウィンドウでは影がウィンドウの矩形に落ち、
  // ピルの外側にうっすら灰色の四角が見える（実機で発生）
  // コメントを落としてから見る。説明文の中の語に反応しては意味がない
  const pill = code(overlayHtml.slice(overlayHtml.indexOf('.pill {'), overlayHtml.indexOf('.pill.visible')));
  const shadows = [...pill.matchAll(/box-shadow:([^;]*);/g)].map((m) => m[1]);
  for (const sh of shadows) {
    assert.ok(!/(^|,)\s*0 /.test(sh.replace(/inset[^,]*/g, '')), `外向きの影がある: ${sh.trim()}`);
  }
  assert.ok(!pill.includes('backdrop-filter'), '透過ウィンドウで矩形が出る backdrop-filter が残っている');
  assert.match(main, /hasShadow: false/, 'ウィンドウの影が有効になっている');
});

// ---------------------------------------------------------------- HTMLの入れ子
//
// カードを並べ替えたとき、スクロール枠を閉じる </div> が最後のカードに
// くっついて移動し、残りのカードが枠の外へ出て画面から消えた（実機で発生）。
// 見出しの並びだけを見るテストでは通ってしまうので、入れ子も検査する。
function divDepthMap(html) {
  const out = [];
  let depth = 0;
  for (const line of html.split('\n')) {
    depth += (line.match(/<div\b/g) || []).length - (line.match(/<\/div>/g) || []).length;
    const h = line.match(/<h2(?: hidden)?>(.+?)<\/h2>/);   // 0.9.0 見た目の直し: 出さないカードの見出し（hidden）も数える
    if (h) out.push({ title: h[1], depth });
  }
  return { heads: out, depth };
}

test('設定の各カードが同じ深さにある（枠の外に出ていない）', () => {
  const a = appHtml.indexOf('<section id="tabSettings"');
  const sec = appHtml.slice(a, appHtml.indexOf('    </section>', a));
  const { heads, depth } = divDepthMap(sec);
  assert.strictEqual(depth, 0, '設定セクションの div が閉じ切れていない');
  assert.strictEqual(heads.length, 13);   // 0.11.0 V-3 で「打ち合わせの質」を足して 13（意図して変えた）。0.10.0 C-3 で「Claude との連携（MCP）」を足して 12（意図して変えた）。0.9.3 M-4 で「会議の検出」を足して 11（意図して変えた）。第1c回 Task C-2: カード「オンライン」を足して 5 つ。0.9.0 U-2 で項目ごとに分けて 9 つ（意図して変えた）。0.9.1 Q-3 で「話し声が無いとき」を足して 10
  for (const h of heads) {
    assert.strictEqual(h.depth, heads[0].depth, `「${h.title}」だけ深さが違う（枠の外に出ている）`);
  }
});

test('画面全体で div の開閉が合っている', () => {
  for (const [name, html] of [['app.html', appHtml], ['overlay.html', overlayHtml]]) {
    const o = (html.match(/<div\b/g) || []).length;
    const c = (html.match(/<\/div>/g) || []).length;
    assert.strictEqual(o, c, `${name} の div が ${o} 対 ${c} で合っていない`);
  }
});

// ---------------------------------------------------------------- 要素の存在
//
// 設定カードを並べ替えた際に、最後のカードより後ろにあった要素
// （データ保存先を開くボタン等）ごと切り落とし、初期化が
// null への代入で止まって設定画面が空になった（実機で発生）。
test('画面が参照する要素がすべてHTMLに存在する', () => {
  // 動的に作る要素だけを除外する。ここに足すときは、
  // 必ず「無ければ作る」側のコードがあることを確かめること。
  const DYNAMIC = new Set(['liveBar']);
  for (const [name, html] of [['app.html', appHtml], ['overlay.html', overlayHtml]]) {
    const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
    for (const u of used) {
      if (DYNAMIC.has(u)) continue;
      assert.ok(ids.has(u), `${name}: 参照している要素 #${u} が無い`);
    }
  }
});

test('設定を読み込む前に保存しない', () => {
  // 自動保存があるので、初期化に失敗して画面が空のまま何かに触れると
  // 空の値でディスク上の設定を上書きしてしまう
  assert.match(appHtml, /if \(!settingsLoaded\) \{/);
  assert.match(appHtml, /fill\(settings\);\s*\n\s*settingsLoaded = true;/);
});

test('更新の導線が画面に依存しない（トレイからも確認できる）', () => {
  // 画面の組み立てが1か所つまずくと設定タブの「更新を確認」ごと死に、
  // アプリ内更新で直すこともできなくなった（実機で発生）。
  // 復旧の手段が、壊れうるものに依存していてはいけない。
  assert.match(main, /label: '更新を確認'[^}]*click: checkUpdateFromTray/);
  assert.match(main, /async function checkUpdateFromTray\(\)/);
  const fn = main.slice(main.indexOf('async function checkUpdateFromTray'), main.indexOf('function updateTray'));
  assert.ok(fn.includes('updater.check('), '確認していない');
  assert.ok(fn.includes('updater.apply('), '適用していない');
  assert.ok(fn.includes('r.url'), 'zipのURLの受け取り方が check() の戻り値と合っていない');
  // 当てたら再起動する。再起動の前に書き出す（第1a回 JS8: relaunchAndExit）
  assert.ok(fn.includes('relaunchAndExit()'), '再起動していない');
});

// ---------------------------------------------------------------- 監査指摘の修正（main 側）
const fnBody = (src, from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `${from} が無い`);
  const j = src.indexOf(to, i + from.length);
  return src.slice(i, j > 0 ? j : src.length);
};

test('#46 要約完了時に手元の古い page で書き戻さない（削除した議事録が復活する）', () => {
  // 「store.getPage(pageId) || page」は、要約中に削除されたページを
  // 古いコピーから復活させる。無ければ破棄する（判断は mainlib.saveIfExists）。
  const fn = fnBody(code(main), 'async function doRunSummary', '\nlet hotkeyState');
  assert.ok(!/getPage\(pageId\)\s*\|\|\s*page\b/.test(fn), '「getPage(pageId) || page」のフォールバックが残っている');
  assert.ok(!/store\.savePage\(/.test(fn), '存在確認を挟まずに savePage している');
  // 第2a1回 M-1（ST1）: saveIfExists は非同期で db（今は json-backend）を通る。await して答えを見る
  assert.ok((fn.match(/await saveIfExists\(db, pageId/g) || []).length >= 4,
    '空・未設定・成功・失敗の全経路が saveIfExists を通っていない');
  assert.ok(!/saveIfExists\(store, /.test(fn), 'store を直に渡している（db.call を通らない）');
  assert.ok(fn.includes('ページが削除されました'), '削除済みのときの戻り値が無い');
  // 保存できなかった（= 削除済み）ことを全経路が見ている
  assert.ok((fn.match(/if \(!(saved|latest)\) return gone\(\);/g) || []).length >= 4, '削除済みを見ずに進む経路がある');
});

test('#10 同じページの要約は同時に一つだけ走る', () => {
  // 排他の判断は mainlib.makeSummaryRunner（実行して検査するのは main.test.js）。
  // ここは main.js がそれを通しているか（結線）だけを見る。
  // 0.10.0 LS-2 で意図して直した: 件数が変わるたびに、走っているページの ID を画面へも渡す（要約の欄の鍵の making）
  assert.match(main, /const runSummary = makeSummaryRunner\(doRunSummary(, \(\) => \{ updateTray\(\); sendToMainWin\('summary:running', runSummary\.running\(\)\); \})?\)/, '排他を mainlib.makeSummaryRunner で作っていない');
  assert.ok(!/new Map\(\)[^\n]*\n[^\n]*function runSummary/.test(code(main)) && !/const summarizing = new Map\(\)/.test(code(main)),
    '排他を main.js に手書きしている（mainlib を通していない）');
  assert.match(main, /ipcMain\.handle\('page:summarize', \(_e, id\) => runSummary\(id\)\)/);
  assert.match(main, /await runSummary\(page\.id\)/, '議事録終了後の要約が排他を通っていない');
});

test('#12 一時停止しても overlay:tick の見張りを消さない', () => {
  // 送る／飛ばす／消す の判断は mainlib.tickStep（実行して検査するのは main.test.js）。
  // ここは interval の中でそれを通しているか（結線）だけを見る。
  const fn = fnBody(code(main), 'function startMeetingTick', '\nfunction applyTheme');
  assert.ok(fn.includes('tickStep({ state, meeting }'), 'interval の中で mainlib.tickStep を通していない');
  assert.ok(fn.includes("sendToOverlay('overlay:tick', {})"), '合図を送る手を渡していない');
  const clearing = fn.split('\n').filter((l) => l.includes('clearInterval'));
  assert.ok(clearing.length > 0, '見張りを消す手を渡していない');
  for (const l of clearing) assert.ok(!l.includes('paused'), `一時停止で見張りを消している: ${l.trim()}`);
  assert.ok(!/paused/.test(fn), '判断を main.js に手書きしている（mainlib を通していない）');
});

test('#14 一時停止したまま停止したら、停止時刻で一時停止を締める', () => {
  const fn = fnBody(code(main), 'function stopMeeting()', '\nfunction discardMeeting');
  assert.ok(fn.indexOf('meeting.stoppedAt = Date.now()') < fn.indexOf('meeting.pausedMs += meeting.stoppedAt - meeting.pausedAt'));
  assert.ok(fn.includes('meeting.paused = false'));
});

test('#15 次の区間の初期プロンプトは直近の成功区間から取る', () => {
  // 0.12.0 SP-3a（計画 docs/plans/2026-10-22-120.md の決めたこと 126）で意図して直した: 2つの流れの会議は同じ流れの直前の済んだ区間から取る（1本の会議は今のまま m.segments）
  assert.match(main, /const tail = promptTail\(lane \? laneSegs\(m, lane\) : m\.segments\);/);
  assert.match(main, /transcribeAuto\(buffer, tail, durationMs[,)]/);
});

test('#26 設定の正規化は起動時と保存時の両方で通す', () => {
  assert.match(main, /require\('\.\/settings'\)/);
  // 意図: 読み込みと保存の両方が同じ決まり（settings.js の readSettings）を通る。保存は許可の一覧（pickSavable）を通す（第1a回 Task 2-2）
  const load = fnBody(code(main), 'function loadSettingsFromDisk()', '\n}');
  assert.match(load, /readSettings\(r\.value, DEFAULT_SETTINGS\)/);
  const save = fnBody(code(main), "ipcMain.handle('settings:save'", '\n  });');
  // 第1d回 A-2 で意図して変えた: ログイン中のメールアドレス（accountEmail）は画面から来た値を使わず、main の今の値を重ねる（ログインの IPC だけが書く）
  assert.match(save, /const merged = readSettings\(\{ \.\.\.settings, \.\.\.pickSavable\(next\), accountEmail: settings\.accountEmail \}, DEFAULT_SETTINGS\)\.settings/);
  assert.ok(!/Math\.max\(1024, Math\.min\(65535/.test(save), '保存時だけの手書きのクランプが残っている');
  // 正規化をすり抜けた不正なポートは、エンジンの起動待ちで TypeError になる。
  // 90秒のタイムアウトまで黙って待たず、設定の問題だと分かる文で返す。
  const ready = fnBody(code(main), 'function ensureEngineReady', '\nfunction restartEnginesIfNeeded');
  assert.ok(ready.includes('e instanceof TypeError'), 'TypeError を起動中と区別していない');
  assert.ok(ready.includes('接続先（ポート設定）が不正です'));
});

test('#35/#49 ホットキーは片方ずつ登録し、失敗を画面とトレイに伝える', () => {
  // 登録は独立（全か無かにしない）
  const apply = fnBody(code(main), 'function applyHotkeys', '\n}');
  assert.ok(apply.includes('registerHotkeys('), '独立登録の純関数を通っていない');
  assert.ok(!apply.includes('unregisterAll(); return { ok: false'), '片方の失敗で両方を解除している');
  // 保存時: 判断は mainlib.saveHotkeys。失敗した側だけ前の値に戻し、他の設定は保存する。
  // 設定として残ったキーを applied で画面に返す（画面はこれを欄に戻す。失敗したキーが
  // 欄に残ると、以後の無関係な保存のたびに再失敗して警告が出続ける）
  const save = fnBody(code(main), "ipcMain.handle('settings:save'", '\n  });');
  assert.ok(!save.includes("return { ok: false, error: `${r.which}"), '全体を失敗として返している');
  assert.ok(save.includes('saveHotkeys(settings, activeHotkeys, merged, applyHotkeys)'), 'mainlib.saveHotkeys を通していない');
  assert.ok(save.includes('merged.hotkey = hk.applied.hotkey') && save.includes('merged.meetingHotkey = hk.applied.meetingHotkey'), '戻した値を設定に反映していない');
  assert.ok(save.includes('activeHotkeys = hk.active') && save.includes('hotkeyState = hk.state') && save.includes('hotkeyNote = hk.note'),
    '実際に登録したキー・状態・トレイの注記を残していない');
  assert.match(save, /const applied = \{ hotkey: settings\.hotkey, meetingHotkey: settings\.meetingHotkey \}/, '設定として残ったキーを applied に組んでいない');
  assert.match(save, /return warning \? \{ ok: true, applied, warning \} : \{ ok: true, applied \}/, '画面が欄に戻す applied を返していない');
  // 起動時: 失敗した側だけ既定に落とす。settings（メモリもディスクも）には書かず、有効なキーは
  // activeHotkeys に持つ。settings に書くと settings:get が既定を返し、次の保存でディスクに漏れる
  assert.match(main, /let hotkeyState = \{ ok: true, failed: \[\], fallback: \{\}, message: '' \}/);
  assert.match(main, /let activeHotkeys = \{ hotkey: /, '実際に登録しているキーを持つ変数が無い');
  const boot = fnBody(code(main), 'resolveStartupHotkeys(', '\n    if (engineValid(whisperEng))');
  assert.ok(!boot.includes('persistSettings'), '起動時のホットキーの失敗で設定をディスクに書いている');
  assert.ok(!/settings\.(hotkey|meetingHotkey)\s*=/.test(boot), '起動時の退避を settings に書いている（settings:get が既定を返し、次の保存でディスクに漏れる）');
  assert.ok(boot.includes('activeHotkeys = r.active'), '実際に登録したキーを activeHotkeys に残していない');
  assert.ok(boot.includes('hotkeyState = r.state'), '起動時の結果を hotkeyState に残していない');
  // 画面から状態を引ける。settings:get は利用者の設定をそのまま返す
  assert.match(main, /ipcMain\.handle\('hotkey:state', \(\) => hotkeyState\)/);
  // 第1a回 Task 2-3 で意図して変えた: settings:get は利用者の設定をそのまま返す。読めない間に開かれたら、返す前に1回読み直す（RF22）
  assert.match(main, /ipcMain\.handle\('settings:get', \(\) => \{ if \(settingsState === 'unreadable'\) retrySettingsRead\(\); return settings; \}\)/);
  assert.ok(preload.includes("  hotkeyState: () => ipcRenderer.invoke('hotkey:state'),"));
  // トレイは実際に登録しているキーを出し、「（…: 既定の … を使用中）」「（… は登録できず）」を添える
  const tray = fnBody(code(main), 'function updateTray()', '\nfunction createTray');
  assert.ok(tray.includes('hotkeyNote'), 'トレイに登録できなかったキーの注記が無い');
  assert.ok(tray.includes('activeHotkeys.hotkey') && tray.includes('activeHotkeys.meetingHotkey'), 'トレイが実際に登録しているキーを出していない');
  assert.ok(!/settings\.(hotkey|meetingHotkey)/.test(tray), 'トレイが設定のキーを出している（退避中は効かないキーが表示される）');
});

test('#18 テンプレートの写しを落とす結線（minutes.dropTemplateEcho が無ければ素通し）', () => {
  assert.match(main, /const dropTemplateEcho = minutes\.dropTemplateEcho \|\| \(\(b\) => b\)/);
  // 0.11.0 M-2（決めたこと 14）で意図して直した: 書式は doRunSummary が memoTypes.buildTemplate で1回だけ作り（template）、
  // 写しを落とす文と Claude Code に渡す文（summarizeWithClaude の buildClaudeInput）に同じ文字列を渡す（別々に組み立てるとずれる）
  assert.match(main, /dropTemplateEcho\(dropRedundantEmpty\(markdownToBlocks\(md\)\), template\)/);
  const run = fnBody(code(main), 'async function doRunSummary', '\n}\n');
  assert.strictEqual((run.match(/buildTemplate\(/g) || []).length, 1, 'doRunSummary の中で書式を1回だけ作っていない');
  assert.strictEqual((code(main).match(/buildTemplate\(/g) || []).length, 1, 'doRunSummary のほかで書式を作っている');
  // 0.12.0 SP-4（決めたこと 143・R27）で意図して直した: Claude Code へは札を付けた文（labeled。札が1つも無い会議は plain と同じ文）を同じ書式で渡す
  assert.ok(run.includes('summarizeWithClaude(labeled, page.memo, template)'), 'Claude Code に同じ書式を渡していない');
  const sw = fnBody(code(main), 'async function summarizeWithClaude', '\n}');
  assert.ok(sw.includes('lib.buildClaudeInput({ memoText, plain, template })'), 'Claude Code に渡す文が受けた書式を使っていない');
  assert.ok(!/minutesTemplate|OUTPUT_RULE/.test(code(main)), 'main.js に前の書式の関数が残っている');
  // 0.11.0 M-3: 写しを落とした後に印を付け（markBlocks）、担当・期限の裏付けから型の雛形の行も外す（memoTypes.presetLines）
  assert.ok(run.includes('memoTypes.markBlocks(dropTemplateEcho('), '写しを落とした後に印を付けていない');
  assert.ok(run.includes('memoEvidence(page.memo, [...mtype.listTypes(), ...memoTypes.presetLines()])'), '型の雛形の行を裏付けから外していない');
});

// ---------------------------------------------------------------- 第2段（D: 小さな直し）
test('#51 議事録の日付はローカルの暦日で作る（UTC の toISOString で日付を作らない）', () => {
  // 計算は src/dates.js の localDateISO（main.test.js で実行）。ここは結線だけ見る
  const m = code(main);
  assert.ok(!m.includes('toISOString().slice(0, 10)'), 'UTC の日付が残っている');
  assert.match(m, /require\('\.\/dates'\)/, 'dates.js を読み込んでいない');
  assert.strictEqual((m.match(/date: localDateISO\(dt\)/g) || []).length, 2, '復旧と保存の両方で使っていない');
});

test('#56 マイクの代替（要求したマイクが無く既定で録っている）を main が受けて画面へ渡す', () => {
  assert.ok(preload.includes("  reportMic: (info) => ipcRenderer.send('overlay:mic', info),"), 'preload の reportMic が無い');
  const m = code(main);
  assert.match(m, /ipcMain\.on\('overlay:mic'/, 'main に受け口が無い');
  const st = fnBody(m, 'function meetingStatus()', '\n}');
  assert.ok(st.includes('micFallback'), 'meetingStatus に micFallback が無い');
  const on = fnBody(m, "ipcMain.on('overlay:mic'", '\n  });');
  assert.ok(on.includes('meeting.micFallback = !!(info && info.requested && !info.matched)'), '要求したのに合わなかった、を代替としていない');
  assert.ok(on.includes("sendToMainWin('meeting:update', meetingStatus())"), '画面へ知らせていない');
});

test('#27 クリップボードへ書くのは copyPrivate だけ（履歴・クラウド同期から除外する）', () => {
  // 除外書式そのものは mainlib.pasterScript（main.test.js）。44 では clipboard が Promise を返すので、
  // 読み書きは mainlib に移した（第0c回 EL1。実行テストは clipboard.test.js）。ここは入口が 1 つであることを見る
  const m = code(main);
  const lib = code(read('src/mainlib.js'));
  assert.ok(!/clipboard\.(readText|writeText)\(/.test(m), 'main.js が clipboard を直に読み書きしている');
  assert.strictEqual((lib.match(/\.writeText\(/g) || []).length, 1, 'mainlib で Electron に書く所が copyPrivate 以外にもある');
  const fn = fnBody(lib, 'async function copyPrivate(', '\n}');
  assert.ok(fn.includes('copyCommand('), '常駐 PowerShell に除外印付きで置かせていない');
  assert.ok(fn.includes('await d.clip.writeText('), 'PowerShell が置けなかったとき Electron で書いていない（何も残らない）');
  assert.ok(fn.indexOf('copyCommand(') < fn.indexOf('d.clip.writeText('), 'Electron の書き込みが PowerShell の置き直しより先にある（最初の書き込みが履歴に採られる）');
  assert.ok(fn.includes("if (clipEquals(await readClip(d.clip), t)) return 'private';"), '置けたことを（待って）読み返して確かめていない');
  const deliver = fnBody(lib, 'async function deliverText(', '\n}');
  assert.ok(deliver.includes('await copyPrivate(text, d)'), '自動貼り付けが置き終わるのを待たずに貼っている');
  assert.ok(deliver.includes('await readClip(d.clip)'), '貼り付け後に戻す元の中身を（待って）読んでいない');
  assert.ok(deliver.includes('restoreAfterPaste(prev, text)'), '戻すかの判断を restoreAfterPaste で行っていない');
  assert.match(lib, /const RESTORE_DELAY_MS = 2000;/, '戻すまでの間が 2 秒でない（読み取りの遅いアプリで古い方が貼られる）');
  assert.match(m, /ipcMain\.handle\('clipboard:copy', async \(_e, t\) => \{ await copyPrivate\(/, '画面のコピーが copyPrivate を（待って）通っていない');
  assert.ok(fnBody(m, 'function ensurePaster()', '\n}').includes('pasterScript()'), '常駐 PowerShell のスクリプトを mainlib から取っていない');
});

// ---------------------------------------------------------------- 第2段（B: エンジン）
test('#28/#31 起動前にポートの空きを見て、塞がっていれば spawn しない', () => {
  const m = code(main);
  assert.match(m, /require\('net'\)/, 'net を使っていない');
  const fn = fnBody(m, 'function startEngine(eng)', '\nfunction stopEngine');
  assert.ok(fn.includes('await portInUse('), 'ポートの空きを見ていない');
  assert.ok(fn.indexOf('await portInUse(') < fn.indexOf('spawn('), 'spawn の後でポートを見ている');
  assert.ok(fn.includes('eng.lastError = portInUseError(port)'), '塞がっているときの文を mainlib から取っていない');
  assert.ok(fn.includes('if (quitting) return;'), '終了中に待ち明けで起動してしまう（孤児プロセスになる）');
  // 同時に二度呼ばれても spawn は一度だけ
  assert.ok(fn.includes('if (eng.startPromise) return eng.startPromise;'), '起動中の二重呼び出しを束ねていない');
  const probe = fnBody(m, 'function portInUse(port', '\n}');
  assert.ok(probe.includes("host: '127.0.0.1'") && probe.includes('exclusive: true'), 'listen の条件が違う');
  assert.ok(probe.includes("'EADDRINUSE'"), 'EADDRINUSE 以外を使用中と誤認する');
});

test('#57(1) エンジンのハンドラは自分が起動したプロセスのときだけ状態を触る', () => {
  const fn = fnBody(code(main), 'function startEngine(eng)', '\nfunction stopEngine');
  assert.match(fn, /p = spawn\(engineExe\(eng\)/, 'spawn の戻りをローカルに持っていない');
  assert.ok((fn.match(/if \(eng\.proc !== p\) return;/g) || []).length >= 3, 'exit / error / stderr の全部で自分のプロセスか見ていない');
  // /health の応答が返るまでの間に再起動されていたら、その応答で準備完了にしない
  const ready = fnBody(code(main), 'function ensureEngineReady', '\nfunction restartEnginesIfNeeded');
  assert.ok(ready.includes('await startEngine(eng)'), '非同期になった起動を待っていない');
  const afterFetch = ready.slice(ready.indexOf('await fetch(url'));
  assert.match(afterFetch, /^[^\n]*\n\s*if \(eng\.proc !== p\) continue;/, 'fetch の直後に自分のプロセスか見ていない');
});

test('#32 エンジンの実行ファイルとモデルは存在だけでなく中身の有無と大きさを見る', () => {
  const m = code(main);
  assert.match(m, /const engineValid = \(e\) => !engineCheck\(e\)/, 'engineValid が engineCheck を通っていない');
  const chk = fnBody(m, 'function engineCheck(eng)', '\n}');
  assert.strictEqual((chk.match(/engineFileIssue\(/g) || []).length, 2, '実行ファイルとモデルの両方を見ていない');
  assert.ok(chk.includes('engineIssueMessage('), '原因を名指しする文を mainlib から取っていない');
  // 床はモデルだけ（実行ファイルの大きさでは判断しない。上流が薄いランチャにした）
  assert.match(m, /whisper: 50_000_000/); assert.ok(!/gguf: 300_000_000/.test(m), '要約のモデルの床が残っている（0.10.0 LS-3 で外した）');
  // 設定画面の「テスト」も原因を名指しする
  assert.ok(!m.includes('またはモデルファイルのパスが正しくありません'), 'テストの失敗が原因を名指ししていない');
});

test('#57(2) 記録中はエンジンに関わる設定を変えず、留めた値を applied で画面へ戻す', () => {
  const save = fnBody(code(main), "ipcMain.handle('settings:save'", '\n  });');
  // 音声入力（recording）の最中も同じ: 文字起こし中に whisper を再起動すると、その発話が失われる
  assert.ok(save.includes("guardEngineSettings(settings, merged, Boolean(meeting) || state === 'recording')"), 'mainlib.guardEngineSettings を（音声入力中も）通していない');
  assert.ok(save.includes('if (!guard.kept.length) restartEnginesIfNeeded();'), '留めたのにエンジンを再起動している');
  assert.ok(save.includes('Object.assign(applied, keptDifferent(next, settings))'), '留めた値を applied に載せていない');
  assert.ok(save.includes('guard.warning'), '警告を画面へ返していない');
});

test('#52 要約中はアプリを「忙しい」として扱う', () => {
  const m = code(main);
  assert.match(m, /const isSummarizing = \(\) => runSummary\.running\(\)\.length > 0/);
  // 0.10.0 LS-2 で意図して直した（画面へ summary:running も渡す）
  assert.match(m, /const runSummary = makeSummaryRunner\(doRunSummary, \(\) => \{ updateTray\(\); sendToMainWin\('summary:running', runSummary\.running\(\)\); \}\)/, '件数の増減でトレイ・省電力を更新していない');
  assert.ok(fnBody(m, 'function updatePowerBlock()', '\n}').includes("state !== 'idle' || isSummarizing()"), '省電力の抑止が要約中に外れる');
  const close = fnBody(m, "mainWin.on('close'", '\n  });');
  assert.ok(close.includes('closeConfirm(') && close.includes('isSummarizing()'), '閉じる確認が要約中を見ていない');
  // 0.7.0 の前の直し（第2a1回 M-4 の点検で残したこと）: 締めの返事を待つ会議も「忙しい」（閉じる確かめ・省電力。isBusy はエンジンの決まりで変えない）
  assert.ok(close.includes("closeConfirm(state === 'meeting' || state === 'meeting-finalizing', isSummarizing(), finalizingPageIds.size > 0)"), '閉じる確認が締めの返事を待つ会議を見ていない');
  assert.ok(fnBody(m, 'function updatePowerBlock()', '\n}').includes('finalizingPageIds.size > 0'), '省電力の抑止が締めの返事を待つ間に外れる');
  assert.match(m, /label: '更新を確認', enabled: state === 'idle' && !isSummarizing\(\)/, 'トレイの更新が要約中に押せる');
  assert.ok(fnBody(m, "ipcMain.handle('app:restart'", '\n  });').includes('要約を作成中です'), '再起動を拒んでいない');
  assert.ok(fnBody(m, "ipcMain.handle('update:apply'", '\n  });').includes('要約を作成中です'), '更新の適用を拒んでいない');
  assert.ok(fnBody(m, 'async function checkUpdateFromTray()', '\nfunction updateTray').includes('要約を作成中です'), 'トレイからの更新を拒んでいない');
  const bq = fnBody(m, "app.on('before-quit'", '\n  });');
  assert.ok(bq.includes('runSummary.running()') && bq.includes('要約が中断されました。「要約を生成」で作り直せます'), '終了時に中断をページへ書いていない');
  // 終了中に要約の失敗を書き戻すと、上の「中断」の文を上書きする
  assert.match(fnBody(m, 'async function doRunSummary', '\nlet hotkeyState'), /catch \(e\) \{\n\s*if \(quitting\) return/);
});

// ---------------------------------------------------------------- 第2段（C: 要約とプロンプト）
// 「#16 分割要約が切れたら半分に割ってやり直す」の結線の確かめは 0.10.0 LS-2（D59）で外した（手元の generateMinutes が無い。Claude Code は1回で要約する）

test('#23 初期プロンプトは予算（UTF-8 バイト）に収め、辞書の収まり具合を画面へ返せる', () => {
  // 予算の判断は mainlib.buildPromptParts（main.test.js で実行）。ここは結線だけ見る
  const m = code(main);
  assert.match(m, /const PROMPT_LIMIT_BYTES = PROMPT_MAX_CHARS \* 3/, '予算が文字数 × 3 バイトになっていない');
  const pp = fnBody(m, 'function promptParts(', '\n}');
  assert.ok(pp.includes('buildPromptParts({'), 'mainlib.buildPromptParts を通していない');
  for (const k of ['ja,', 'sample: PROMPT_SAMPLE', 'dictionary: settings.dictionary', 'useBuiltinTerms: settings.useBuiltinTerms',
    'builtinTerms: BUILTIN_TERMS', 'tail: extraTail', 'limitBytes: PROMPT_LIMIT_BYTES']) {
    assert.ok(pp.includes(k), `${k} を渡していない`);
  }
  assert.match(m, /function buildPrompt\(extraTail\) \{ return promptParts\(extraTail\)\.prompt; \}/);
  const info = fnBody(m, "ipcMain.handle('prompt:info'", '\n  });');
  assert.ok(info.includes("promptParts('')"), '尻尾なしで数えていない');
  assert.ok(info.includes('kept: r.kept') && info.includes('total: r.total') && info.includes('over: r.over'), '{ ok, kept, total, over } の形で返していない');
  assert.ok(preload.includes("  promptInfo: () => ipcRenderer.invoke('prompt:info'),"), 'preload の promptInfo が無い');
});

test('#4 出典は要約の材料にした配列と今の配列の両方から付ける（cite 側が無ければ従来どおり）', () => {
  assert.match(main, /const attachAcross = cite\.attachCitationsAcross \|\| \(\(b, f\) => attachCitations\(b, f\.filter\(\(s\) => !s\.failed\)\)\)/,
    'cite.attachCitationsAcross への切り替え（無ければ素通し）が無い');
  const run = fnBody(code(main), 'async function doRunSummary', '\nlet hotkeyState');
  assert.ok(run.includes('const segmentsAtStart = segments;'), '入口で読んだ配列を取っておいていない');
  assert.ok(run.includes('const stat = attachAcross(blocks, fresh, segmentsAtStart);'), '両方の配列を渡していない');
});

// ---------------------------------------------------------------- 第2段（A: 音声の退避・復旧・背圧・進捗・打ち切り）
test('#8/#42(1) 区間の音声は文字起こしの前にディスクへ退避し、draft に「待ち」として控える', () => {
  const m = code(main);
  assert.match(m, /path\.join\(app\.getPath\('userData'\), 'data', 'segbuf'\)/, '退避先が <userData>/data/segbuf ではない');
  const spool = fnBody(m, 'function spoolSegment(', '\n}');
  assert.ok(spool.includes('mkdirSync') && spool.includes('renameSync'), '一時ファイル経由で書いていない');
  const on = fnBody(m, 'function onMeetingSegment(', '\nasync function maybeFinalizeMeeting');
  assert.ok(on.includes('pending: true'), '区間を「待ち」として控えていない');
  assert.ok(on.includes('spoolSegment('), '音声を退避していない');
  assert.ok(on.indexOf('spoolSegment(') < on.indexOf('segChain = segChain.then'), '文字起こしの列に入れる前に退避していない');
  assert.ok(on.indexOf('writeDraft()') < on.indexOf('segChain = segChain.then'), '列に入れる前に draft へ書いていない');
  assert.ok((on.match(/settleSegment\(m, seg/g) || []).length >= 3, '成功・失敗・空 の全部で同じ要素を置き換えていない');
  const settle = fnBody(m, 'function settleSegment(', '\n}');
  assert.ok(settle.includes('unlinkQuiet(seg.wav)') && settle.includes('delete seg.pending') && settle.includes('delete seg.wav'),
    '置き換え時に wav を消し pending/wav を外していない');
  // 画面・保存・要約は「待ち」の区間とパスを見ない
  assert.ok(fnBody(m, 'function meetingStatus()', '\n}').includes('publicSegments(meeting.segments)'), '画面へパスが漏れる');
  assert.ok(fnBody(m, 'async function maybeFinalizeMeeting', '\nconst runSummary').includes('segments: settledSegments(m.segments)'), '保存に待ちの区間が混ざる');
  assert.match(fnBody(m, 'async function doRunSummary', '\nlet hotkeyState'), /const usable = segments\.filter\(\(s\) => !s\.failed && !s\.pending\)/);
  assert.ok(fnBody(m, 'function discardMeeting()', '\n}').includes('cleanupSegbuf(m)'), '破棄で退避した音声を消していない');
  // 復旧: 待ちの区間は draft からページに載せるとき失敗扱いにする（判断は mainlib.recoverSegments）
  assert.ok(fnBody(m, 'async function recoverDraftsNow()', '\n}').includes('recoverSegments(d.segments'), '復旧で待ちの区間を直していない');
});

test('#8/#42(2) 復旧ページの「文字起こし待ち」は起動後に文字起こしして差し替え、古い退避フォルダは消す', () => {
  const m = code(main);
  // エンジンの用意待ち（transcribeRecovered）と区間ごとの処理（transcribeRecoveredItems）に分かれている
  const fn = fnBody(m, 'async function transcribeRecovered()', '\n}') + fnBody(m, 'async function transcribeRecoveredItems(', '\n}');
  assert.ok(fn.includes('await ensureEngineReady(whisperEng)'), 'エンジンの用意を待っていない');
  // 第2a1回 M-1（ST1）: 区間だけを直す命令（出典は引き直さない）。json-backend では store.updateSegment
  assert.ok(fn.includes("db.call('segment.update', { pageId: q.pageId, segId: item.id, patch: { text }, recite: false })"), '成功した区間を segment.update で差し替えていない（failed が残る）');
  assert.ok(fn.includes('unlinkQuiet(item.wav)'), '文字起こした wav を消していない');
  assert.ok(fn.includes('（この区間の認識に失敗: '), '失敗した区間に失敗の文を残していない');
  assert.ok(fn.includes('removeDirIfEmpty(q.dir)'), '空になった退避フォルダを消していない');
  assert.ok(fn.includes("sendToMainWin('page:updated'"), '開いている復旧ページの文字起こしを描き直していない');
  const boot = fnBody(m, 'app.whenReady().then(', '\n  });');
  assert.ok(boot.includes('transcribeRecovered()'), '起動時に復旧の文字起こしを始めていない');
  assert.ok(boot.includes('cleanOrphanSegbuf('), '起動時に古い退避フォルダを掃除していない');
  assert.ok(boot.indexOf('recoverDraftIfAny()') < boot.indexOf('cleanOrphanSegbuf('), '復旧より先に掃除している（復旧中のフォルダを消しうる）');
  const clean = fnBody(m, 'function cleanOrphanSegbuf(', '\n}');
  assert.ok(clean.includes('staleSegbufDirs('), '7 日の判断を mainlib.staleSegbufDirs で行っていない');
  assert.ok(clean.includes('if (dir === keepDir) continue;'), '復旧中のフォルダを消しうる');
});

test('#42(3) 文字起こしが追いつかないときは区間を伸ばして送る回数を減らし、追いついたら戻す', () => {
  // 判断は mainlib.nextLiveSegmentMs（中で nextSegmentMs を使う。main.test.js・stage1d.lib.test.js で実行）。ここは結線だけ見る。
  // 第1d回 A-5（D16）で意図して直した: 背圧と経路の唯一の入口は applySegmentLength、始めの長さは segmentBaseMs の答え（オンラインなら 15 秒）
  const m = code(main);
  const bp = fnBody(m, 'function applySegmentLength(', '\n}');
  assert.ok(bp.includes('nextLiveSegmentMs(pendingSegs, '), '判断を mainlib.nextLiveSegmentMs で行っていない');
  assert.ok(bp.includes("sendToOverlay('overlay:segment-ms', next)"), 'オーバーレイへ区間の長さを送っていない');
  assert.ok(bp.includes('if (next === m.segmentMs) return;'), '変わっていないのに送っている');
  const on = fnBody(m, 'function onMeetingSegment(', '\nasync function maybeFinalizeMeeting');
  assert.ok(on.includes("pendingSegs++;\n  applySegmentLength(m, 1, 'backpressure');"), '増えたときに見ていない');
  assert.ok(on.includes("pendingSegs = Math.max(0, pendingSegs - 1); applySegmentLength(m, -1, 'backpressure');"), '減ったときに見ていない');
  const sm = fnBody(m, 'function startMeeting()', '\nfunction stopMeeting');
  assert.ok(sm.includes('meeting.segmentMs = segmentBaseMs('), '開始時の長さを持っていない');
  assert.ok(sm.includes('segmentSec: meeting.segmentMs / 1000,'), '録音バーへ始めの長さを渡していない');
  assert.ok(preload.includes("  onSegmentMs: (cb) => ipcRenderer.on('overlay:segment-ms', (_e, ms) => cb(ms)),"), 'preload の onSegmentMs が無い');
});

test('#42(4) 残り時間の見積もり（etaSec）と打ち切った数（skipped）を meetingStatus で返す', () => {
  // 見積もりの計算は mainlib.EtaTracker（main.test.js で実行）。ここは結線だけ見る
  const m = code(main);
  assert.match(m, /const eta = new EtaTracker\(\)/, '見積もりを mainlib.EtaTracker で行っていない');
  const st = fnBody(m, 'function meetingStatus()', '\n}');
  assert.ok(st.includes('etaSec:') && st.includes('skipped:'), 'etaSec / skipped が無い');
  const etaFn = fnBody(m, 'function etaSecOf(m)', '\n}');
  assert.ok(etaFn.includes('pendingDurationMs(m.segments)'), '残りの待ちを区間の長さから数えていない');
  assert.ok(etaFn.includes('m.inFlightSince'), '進行中の区間で経過した分を引いていない');
  assert.ok(etaFn.includes('m.etaRoute'), '見積もりに、この会議で最後に使った経路の比を使っていない（第1c回）');
  const on = fnBody(m, 'function onMeetingSegment(', '\nasync function maybeFinalizeMeeting');
  assert.ok(on.includes('eta.record(Date.now() - t0, durationMs, route)'), '成功した区間で、経路ごとに学習していない（第1c回: クラウドの速さを手元の見積もりに混ぜない）');
  assert.ok(on.includes('m.etaRoute = route'), '最後に使った経路を会議に残していない');
  assert.ok(on.indexOf('eta.record(') > on.indexOf('} catch (e) {'), '失敗した区間まで学習している');
  assert.ok(on.includes('m.inFlightSince = t0') && on.includes('m.inFlightSince = 0'), '進行中の区間の開始時刻を持って・戻していない');
});

test('#42(5) 終了後の文字起こし待ちは打ち切れる（meeting:skipPending）', () => {
  // 区間の書き換えは mainlib.skipPendingSegments（main.test.js で実行）。ここは結線だけ見る
  const m = code(main);
  const h = fnBody(m, "ipcMain.handle('meeting:skipPending'", '\n  });');
  assert.ok(h.includes('if (!meeting || !meeting.stopping) return { ok: false'), '記録中（終了前）に打ち切れてしまう');
  assert.ok(h.includes('m.gen++'), '進行中の結果を無効にしていない');
  assert.ok(h.includes('skipPendingSegments(m.segments)'), '区間の書き換えを mainlib.skipPendingSegments で行っていない');
  // 0.9.4 S-3（決めたこと 4）で意図して直した: 後回しにした区間の wav は消さない（kept にして会議の後に文字起こしする。stage094.main で場面を見る）
  assert.ok(!h.includes('unlinkQuiet('), 'wav を消している');
  assert.ok(h.includes('m.later = true;'), '後回しの会議の印が無い（要約を待たせてしまう）');
  assert.ok(h.includes('pendingSegs = 0;'), '待ち件数を 0 にしていない');
  assert.ok(h.includes('m.skipped += '), '打ち切った数を数えていない');
  assert.ok(h.includes('maybeFinalizeMeeting()'), '打ち切ったのに締めていない');
  assert.ok(h.includes('return { ok: true, skipped:'), '{ ok, skipped } の形で返していない');
  const on = fnBody(m, 'function onMeetingSegment(', '\nasync function maybeFinalizeMeeting');
  assert.ok((on.match(/m\.gen !== gen/g) || []).length >= 3, '列の中で世代を見ていない（打ち切った区間の結果が後から混ざる）');
  assert.ok(preload.includes("  meetingSkipPending: () => ipcRenderer.invoke('meeting:skipPending'),"), 'preload の meetingSkipPending が無い');
});

// ---------------------------------------------------------------- 第2段の統合レビューで見つかった取りこぼし
test('meetingStatus は stopping を返す（画面の残り区間・打ち切りの導線がこれを見る）', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const body = main.slice(main.indexOf('function meetingStatus()'), main.indexOf('function meetingStatus()') + 1500);
  assert.ok(/stopping:\s*Boolean\(meeting && meeting\.stopping\)/.test(body), 'meetingStatus に stopping が無い（画面の打ち切りボタンが一度も出ない）');
});

test('打ち切りの後に届く最後の区間を捨てない（届くまで締めず、届いた区間は打ち切りとして数える）', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.ok(main.includes('if (isFinal) m.finalSeen = true;'), '最後の区間の到着を記録していない');
  assert.ok(main.includes('if (meeting.skipAll && !meeting.finalSeen) return;'), '打ち切り後、最後の区間が届く前に締めている');
  assert.ok(main.includes("text: '（文字起こしを打ち切り）', failed: true });\n      m.skipped++;"), '打ち切り後に届いた区間を数えていない');
});

test('復旧の文字起こしは、エンジンが用意できないときに wav を消さず待ち行列を残す', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const body = main.slice(main.indexOf('async function transcribeRecovered()'), main.indexOf('async function transcribeRecoveredItems('));
  assert.ok(/if \(!ready\) \{[\s\S]*?return;/.test(body), 'エンジン未準備で return していない');
  assert.ok(!/unlink/.test(body), 'エンジン未準備の経路で wav を消している');
  assert.ok(main.includes('saveRecoveryQueue(recoveryQueue)'), '待ち行列を recovery.json に残していない');
  assert.ok(main.includes('recoveryQueue = loadSavedRecoveryQueue()'), '起動時に残した待ち行列を拾っていない');
  assert.ok(/if \(recoveryQueue\) transcribeRecovered\(\)/.test(main), '設定を直したときに復旧を再開していない');
});

test("overlay:mic は議事録が無いとき meeting:update を送らない（要約中の進捗表示を消さない）", () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const i = main.indexOf("ipcMain.on('overlay:mic'");
  const body = main.slice(i, i + 500);
  assert.ok(/if \(!meeting\) return;/.test(body), 'overlay:mic に議事録なしのガードが無い');
});

// ---------------------------------------------------------------- 第2段 レビュー2（忠実さ・実機リスク）
test('トレイの「終了」も、閉じるボタンと同じく記録中・要約中は確かめる', () => {
  const m = code(main);
  assert.ok(m.includes("items.push({ label: '終了', click: quitFromTray });"), 'トレイの終了が quitFromTray を通っていない');
  const fn = fnBody(m, 'function quitFromTray()', '\n}');
  assert.ok(fn.includes("closeConfirm(state === 'meeting' || state === 'meeting-finalizing', isSummarizing(), finalizingPageIds.size > 0)"), '終了確認の文を mainlib.closeConfirm で組んでいない（締めの返事を待つ会議も見る）');
  assert.ok(fn.includes('dialog.showMessageBoxSync('), '確認を出していない');
  assert.ok(/if \(r !== 0\) return;/.test(fn), 'キャンセルで終了を止めていない');
  assert.ok(fn.indexOf('showMessageBoxSync(') < fn.indexOf('quitting = true'), '確認より先に終了している');
});

test('認識に失敗した区間の wav は残し、議事録を締めたあと（要約の後）にもう一度文字起こしする', () => {
  const m = code(main);
  const settle = fnBody(m, 'function settleSegment(', '\n}');
  assert.ok(settle.includes('const keepWav = Boolean(patch && patch.failed && seg.wav);'), '失敗した区間の wav を残す判断が無い');
  assert.ok(settle.includes('if (!keepWav) unlinkQuiet(seg.wav);'), '失敗した区間の wav も消している');
  assert.ok(settle.includes('if (keepWav) seg.wav = wav;'), '残した wav のパスを区間に戻していない（締めのときに見つからない）');
  const fin = fnBody(m, 'async function maybeFinalizeMeeting', '\nconst runSummary');
  assert.ok(fin.includes('m.segments.filter((s) => s.failed && s.wav && fs.existsSync(s.wav))'), '失敗した区間を待ち行列に集めていない');
  assert.ok(fin.includes('saveRecoveryQueue(q)'), '待ち行列を recovery.json に残していない（途中で落ちると消える）');
  assert.ok(fin.includes('if (!recoveryQueue) recoveryQueue = q;'), '別の復旧が待っているときに上書きしている');
  assert.ok(fin.indexOf('await runSummary(page.id)') < fin.indexOf('transcribeRecovered()'), '要約より先にやり直している（要約が待たされる）');
  const rec = fnBody(m, 'async function transcribeRecovered()', '\n}');
  assert.ok(rec.includes('while (q && !seen.has(q.dir)) {') && rec.includes('q = recoveryQueue = loadSavedRecoveryQueue();'), '残りの待ち行列を順に拾っていない／同じ行列を二度拾いうる');
  assert.ok(fnBody(m, 'function cleanupSegbuf(', '\n}').includes('for (const s of m.segments) unlinkQuiet(s.wav);'), '破棄で失敗区間の wav が残る');
  const items = fnBody(m, 'async function transcribeRecoveredItems(', '\n}');
  assert.ok(items.includes('q.retry') && items.includes('やり直しました'), 'やり直しの通知文が復旧の文のまま');
  // 記録中に落ちて draft に残った失敗区間も、wav があればやり直す（mainlib.recoverSegments）
  // 第1a回 Task 2-5 で直した（意図: retry の印を残す。書くのは部品）
  const save = fnBody(m, 'function saveRecoveryQueue(q)', '\n}');
  assert.ok(save.includes('J.writeJsonFile(') && save.includes('retry: Boolean(q.retry)'), 'recovery.json に retry の印を残していない／部品を通していない');
});

// 第1a回 Task 2-5 で直した（意図: 掃除が永久に避け続けない。実行テストは stage1a.main.test.js の recovery-broken・recovery-unreadable）
test('退避フォルダの掃除は、待ち行列（recovery.json）が残っているフォルダを消さない。壊れた recovery.json は消さずに退ける', () => {
  const clean = fnBody(code(main), 'function cleanOrphanSegbuf(', '\n}');
  assert.ok(clean.includes('if (fs.existsSync(path.join(dir, RECOVERY_FILE))) continue;'), 'recovery.json 付きのフォルダを 7 日で消してしまう');
  const load = fnBody(code(main), 'function loadSavedRecoveryQueue()', '\n}');
  assert.ok(load.includes('J.loadJsonFile(') && !load.includes('unlinkSync'), 'recovery.json を消している（読めないだけでも待ち行列が失われる）');
});

test('録音側のエラーで議事録を締めるときは、会議の長さをそこで止め、利用者に伝える', () => {
  const m = code(main);
  const i = m.indexOf("ipcMain.on('audio:error'");
  const body = m.slice(i, m.indexOf("ipcMain.on('overlay:hidden-request'", i));
  assert.ok(body.includes('meeting.stoppedAt = Date.now();'), '会議の長さに文字起こし待ちが混ざる');
  assert.ok(body.includes('meeting.pausedMs += meeting.stoppedAt - meeting.pausedAt;'), '一時停止したまま切れたとき一時停止を締めていない');
  assert.ok(body.includes("sendToMainWin('app:notice'"), '利用者に伝えていない');
  assert.ok(body.indexOf('meeting.stoppedAt = Date.now();') < body.indexOf('maybeFinalizeMeeting()'), '締めた後に時刻を書いている');
});

test('区間の onstop は、次の区間の開始（rollSegment）を try の中で呼ぶ（投げても番号を埋める）', () => {
  // 外で投げると finally が走らず、この区間の番号が待ち行列で埋まらない。以後の区間も
  // 空の最後も永久に届かず、main は終了しても議事録を締められない
  const onstop = overlayHtml.slice(overlayHtml.indexOf('rec.onstop = async () => {'), overlayHtml.indexOf('autoStopId = setTimeout(() => rollSegment(rec), thisSegMs);'));
  const tryAt = onstop.indexOf('try {');
  const roll = onstop.indexOf('rollSegment(rec);');
  assert.ok(tryAt >= 0 && roll > tryAt, 'rollSegment(rec) が try の外にある');
  assert.ok(onstop.indexOf('finally {') > roll && onstop.includes('settle(null);'), 'finally で番号を埋めていない');
  // 次の区間の start() が投げても（マイクの切断）、番号を空の最後で埋めて録音を畳む
  const seg = overlayHtml.slice(overlayHtml.indexOf('function startMeetingSegment()'), overlayHtml.indexOf('function newClosing()'));
  assert.ok(/try \{\s*rec\.start\(250\);\s*\} catch \(e\) \{/.test(seg), 'rec.start(250) を try で包んでいない');
  assert.ok(seg.includes('settleSeg(seq, { wav: new Uint8Array(0), durationMs: 0, isFinal: true });'), '投げたときに番号を空の最後で埋めていない');
  assert.ok(seg.includes("errorAfterFinal = 'マイクが切断されました';"), 'エラーを最後の区間の後に回していない');
});

// ---------------------------------------------------------------- エンジンの壊れ方（実機の報告）
test('エンジンの不具合は、どのファイルかを名指しして伝える', () => {
  const m = code(main);
  const fn = fnBody(m, 'function engineCheck(eng)', '\n}');
  assert.ok(fn.includes("engineIssueMessage(exe, 'exe', fileSize(engineExe(eng)), engineExe(eng), ps)"), '実行ファイルのパスを文に渡していない');
  assert.ok(fn.includes("engineIssueMessage(model, 'model', fileSize(engineModel(eng)), engineModel(eng), ps)"), 'モデルのパスを文に渡していない');
  // 実行し直すスクリプトを名指しする（setup-*.ps1 では利用者がどれか分からない）。0.10.0 LS-3（D59）で要約のスクリプトを外した
  assert.ok(fn.includes("const ps = 'setup-local-engine.ps1';"), 'スクリプトを名指ししていない');
});

test('起動テストは、エンジンがアプリのインストール先にあれば移動を促す（更新のたびに消える）', () => {
  const m = code(main);
  assert.ok(m.includes('const appInstallDir = () => path.dirname(process.execPath);'), 'インストール先を求めていない');
  assert.ok(m.includes('engineDirWarning([engineExe(eng), engineModel(eng)], appInstallDir())'), '判断を mainlib.engineDirWarning に任せていない');
  for (const [ch, eng] of [["app:test'", 'whisperEng']]) {   // 0.10.0 LS-3 で app:test-sum を外した
    const i = m.indexOf(`ipcMain.handle('${ch}`);
    assert.ok(i > 0, `${ch} が無い`);
    const body = m.slice(i, m.indexOf('  });', i));
    assert.ok(body.includes(`const warning = engineDirNote(${eng});`), `${ch} が置き場所を見ていない`);
    // 成功でも失敗でも添える（動いていても次の更新で壊れる）。返す物を1つずつ、文の終わりまで見る
    const at = [...body.matchAll(/\bok: (?:true|false)\b/g)].map((x) => x.index);
    assert.ok(at.length >= 3, `${ch} の戻り値を数えられない（検査が空振り）`);
    for (const i of at) {
      const end = body.indexOf('};', i);
      const stmt = body.slice(i, end > 0 ? end : i + 200);
      assert.ok(/\bwarning\b/.test(stmt), `${ch} の経路「${stmt.slice(0, 50)}…」が注意を伝えていない`);
    }
  }
  // 画面は成否にかかわらず同じ行に出す
  const run = appHtml.slice(appHtml.indexOf('async function runTest('), appHtml.indexOf("$('testBtn').onclick"));
  assert.ok(run.includes('r.warning'), '画面が注意を出していない');
});

// 0.10.0 LS-5（D59）で意図して変えた: setup-summarizer.ps1 は消した
test('セットアップは、展開が不完全でないかを確かめてから zip を消す', () => {
  for (const name of ['setup-local-engine.ps1']) {
    const s = read(name);
    const i = s.indexOf('Expand-Archive');
    assert.ok(i > 0, `${name}: 展開していない`);
    const after = s.slice(i);
    const check = after.indexOf('-lt 5MB');
    assert.ok(check > 0, `${name}: 展開物の合計を見ていない（0 バイトでも「完了」と言ってしまう）`);
    const rm = after.indexOf('Remove-Item $binZip');
    assert.ok(rm > 0 && check < rm, `${name}: 確かめる前に zip を消している（再実行で取り直せない）`);
    assert.match(after.slice(check, check + 400), /ウイルス対策|除外/, `${name}: 直し方（除外設定）を案内していない`);
  }
});

test('アプリのインストール先にエンジンを置かないことが文書に書いてある', () => {
  for (const name of ['README.md', 'INSTALL.md']) {
    const s = read(name);
    const i = s.indexOf('Programs\\NaTsu');
    assert.ok(i > 0, `${name}: インストール先に触れていない`);
    assert.match(s, /インストール先[^\n]*(置かない|置かないで)|エンジン[^\n]*インストール先[^\n]*消え/,
      `${name}: インストール先にエンジンを置かない注意が無い`);
  }
});

test('エンジンの実行ファイルは大きさの床で弾かない（上流が薄いランチャにした）', () => {
  const m = code(main);
  // 床はモデルだけ。exe に床を置くと、薄いランチャの exe（正常）を「壊れている」と言ってしまう（0.10.0 LS-3 で要約のモデルの床を外した）
  assert.match(m, /const ENGINE_MIN_BYTES = \{ whisper: 50_000_000 \};/, 'exe の床が残っている');
  const fn = fnBody(m, 'function engineCheck(eng)', '\n}');
  assert.ok(fn.includes('engineFileIssue(engineExe(eng), 0, stat)'), 'exe に床を渡している');
  assert.ok(!/ENGINE_MIN_BYTES\.exe/.test(m), 'ENGINE_MIN_BYTES.exe をまだ参照している');
});

// 0.10.0 LS-5（D59）で意図して変えた: setup-summarizer.ps1 は消した
test('セットアップは展開物ぜんたいの大きさで確かめる（exe の大きさでは判定しない）', () => {
  for (const name of ['setup-local-engine.ps1']) {
    const s = read(name);
    assert.ok(!/\$server\.Length -lt 1MB/.test(s), `${name}: exe の大きさで判定している（薄いランチャを弾く）`);
    assert.match(s, /Measure-Object[^\n]*Length[^\n]*-Sum/, `${name}: 展開物の合計を数えていない`);
    assert.match(s, /-lt 5MB/, `${name}: 合計の下限を見ていない`);
    const i = s.indexOf('Measure-Object');
    assert.ok(s.indexOf('Remove-Item $binZip') > i, `${name}: 確かめる前に zip を消している`);
  }
});

test('whisper のバイナリはリリース一覧から探す（固定URLは 404 になった）', () => {
  const s = read('setup-local-engine.ps1');
  assert.ok(!/releases\/latest\/download\/whisper-bin-x64\.zip/.test(s), '固定URLの直打ちが残っている（latest では 404）');
  assert.match(s, /api\.github\.com\/repos\/ggml-org\/whisper\.cpp\/releases/, 'リリース一覧を見ていない');
  assert.match(s, /Find-WinAsset|Find-WhisperAsset/, '資産を探す関数が無い');
  assert.match(s, /v1\.8\.0/, '見つからないときの既知の版に落ちていない');
});

test('要約の担当・期限の裏付けは、文字起こしと、アジェンダの雛形を除いたメモで照らす（0.1.2）', () => {
  const run = fnBody(code(main), 'async function doRunSummary(', '\n}\n');
  // 0.11.0 M-3（決めたこと 25）で意図して変えた: 型の雛形の行（memoTypes.presetLines）も裏付けから外す
  assert.ok(run.includes('groundActionFields(blocks, `${plain}\\n${memoEvidence(page.memo, [...mtype.listTypes(), ...memoTypes.presetLines()])}`)'),
    '裏付けに雛形入りのメモをそのまま渡している');
  assert.ok(run.indexOf('enrichActionBlocks(blocks') < run.indexOf('groundActionFields(blocks'), '担当・期限を抜く前に照らしている');
  assert.ok(run.indexOf('groundActionFields(blocks') < run.indexOf('attachAcross(blocks'), '出典の照合の後に照らしている（外した担当名で照合がぶれる）');
});


// ---------------------------------------------------------------- 0.10.0 S-2（MCP のサーバーの入口: 計画 docs/plans/2026-10-20-100.md）
const mcpFiles = () => fs.readdirSync(path.join(ROOT, 'src', 'mcp')).filter((f) => f.endsWith('.js')).map((f) => `src/mcp/${f}`);

test('0.10.0 F4・RF63: MCP の入口は src/mcp/server.js にあり、src/mcp/ のどのファイルも頭のほかに require( が無い（関数の中で後から読まない: 自動更新が src を入れ替える間に新旧を混ぜない）', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'mcp', 'server.js')), 'src/mcp/server.js が無い（登録した場所は変えない約束: 決めたこと 22）');
  for (const f of mcpFiles()) {
    const lines = code(read(f)).split('\n');
    const firstFn = lines.findIndex((l) => /^(async\s+)?function\b|^class\b|^module\.exports\b/.test(l));
    lines.forEach((l, i) => {
      if (!/\brequire\(/.test(l)) return;
      assert.ok(/^const [^=]+= require\(['"][^'"]+['"]\)(\.\w+)?;\s*$/.test(l), `${f}:${i + 1}: 頭の const … = require(…) の形でない: ${l.trim()}`);
      assert.ok(firstFn < 0 || i < firstFn, `${f}:${i + 1}: 関数より後に require がある`);
    });
  }
});

test('0.10.0 EL8: package.json の build に electronFuses が無いか、runAsNode を false にしていない（MCP のサーバーは NaTsu.exe を Node として起こす）', () => {
  const pkg = JSON.parse(read('package.json'));
  const fuses = pkg.build && pkg.build.electronFuses;
  assert.ok(!fuses || fuses.runAsNode !== false, 'runAsNode を切ると Claude から MCP のサーバーを起こせない');
});

test('0.10.0 決めたこと 33: src/ に NATSU_MCP_TEST の字が無い（テストだけの道を環境変数で開けない）', () => {
  const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  for (const f of walk('src').filter((x) => /\.(js|html)$/.test(x))) assert.ok(!read(f).includes('NATSU_MCP_TEST'), f);
});

test('0.10.0 F16・RF75: src/mcp/ のどのファイルも、決めたこと 59 の部品を require しない・listen( と createServer( と fetch( の字が無い（口は標準入出力だけ）', () => {
  const banned = ['net', 'http', 'https', 'http2', 'dgram', 'tls', 'child_process', 'worker_threads', 'electron', '../secrets', '../relay', '../settings', '../store', '../jsonfile', '../updater'];
  for (const f of mcpFiles()) {
    const src = code(read(f));
    for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const name = m[1].replace(/^node:/, '');
      assert.ok(!banned.includes(name), `${f}: ${m[1]} を読む`);
    }
    for (const w of ['listen(', 'createServer(', 'fetch(']) assert.ok(!src.includes(w), `${f}: ${w} がある`);
  }
});

test('0.10.0 D76: README・INSTALL に「0.10.0 からポータブル版はありません」と、インストーラーで入れ直す案内（議事録と設定はそのまま）がある', () => {
  for (const n of ['README.md', 'INSTALL.md']) {
    const s = read(n);
    assert.ok(s.includes('0.10.0 からポータブル版はありません'), n);
    assert.ok(s.includes('NaTsu-<版>-setup.exe'), n);
    assert.ok(s.includes('議事録と設定はそのまま使えます'), n);
    assert.ok(!s.includes('NaTsu-<版>-portable.exe に置き換え') && !s.includes('portable.exe` を落とし直して'), n);
  }
});

// 0.10.0 SH-1（D71・決めたこと 140）: ページの頭（題名の所）の見た目を 0.10.0 で変えない。.phead・.picon・.ptitle・.pprops を含む CSS の規則の文と、
// #pIcon・#pTitle・#pProps の DOM の行の sha256 が 0.9.3（746ea67）の値と同じ（題名の文字が変わるので、画素で比べる守りは置かない）
test('0.10.0 D71: .phead・.picon・.ptitle・.pprops とその子の CSS の規則の文と、#pIcon・#pTitle・#pProps の DOM の写しが、0.9.3 の値（HEAD_HASH）と同じ', () => {
  const HEAD_HASH = '57fe8d58d84819e19a719e56cbbcc811753ae9a0e7d0502fd958a34a8f8a856e';
  const html = read('src/renderer/app.html');
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const rules = [...css.matchAll(/[^{}]*\{[^{}]*\}/g)].map((m) => m[0].trim()).filter((r) => /\.(phead|picon|ptitle|pprops)\b/.test(r.slice(0, r.indexOf('{'))));
  const dom = html.split('\n').filter((l) => /id="(pIcon|pTitle|pProps)"/.test(l)).map((l) => l.trim());
  assert.strictEqual(rules.length, 12);
  assert.strictEqual(dom.length, 3);
  const sha = require('node:crypto').createHash('sha256').update([...rules, ...dom].join('\n')).digest('hex');
  assert.strictEqual(sha, HEAD_HASH, 'ページの頭の CSS か DOM が変わった（D71: 0.10.0 では変えない）');
});

// 0.10.0 SH-2（D77・決めたこと 152）: テストの作り物の会議の題名も本物と同じ日付の形（test/helpers/titles.js の titleAt）。題名の語に頼るテストは
// 利用者が付け直した題名として決めた題名を残し、注を付ける。会議の題名でない題（ヘルプの記事・道具・窓と知らせの題）のファイルは外す
test('0.10.0 D77: 会議の題名を持つテストの作り物の題名は、titleAt(…) で作るか、「利用者が付け直した題名（D77…）」の注のある行だけ', () => {
  const NOT_MEETING = new Set(['help-build.test.js', 'help-deploy.test.js', 'help-md.test.js', 'help-content.test.js', 'help-app.test.js', 'mcp-rpc.test.js', 'identity.test.js', 'stage1d.status.test.js', 'repo.test.js']);
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.js') && !NOT_MEETING.has(f)).map((f) => `test/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'test', 'helpers')).filter((f) => f.endsWith('.js')).map((f) => `test/helpers/${f}`),
    'tools/perf.js', 'tools/make-db-fixture.js', 'tools/electron-smoke/main.js',
  ];
  const bad = [];
  for (const f of files) {
    const lines = read(f).split('\n');
    lines.forEach((l, i) => {
      if (!/\btitle:\s*(['"`])(?!\1)/.test(l)) return;
      if (/\b(titleAt|meetingTitleAt|titleOf)\(/.test(l) || l.includes('D77') || (i > 0 && lines[i - 1].includes('D77'))) return;
      bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 80)}`);
    });
  }
  assert.deepStrictEqual(bad, [], '日付の形でない、注の無い会議の題名');
});

// 0.10.0 L-1（D58・D78・決めたこと 100）: 画面が写すリンクの頭は、ヘルプのサイトの /open のページ（決めたこと 153 の住所）。住所は main だけが持つ
// （F15・I1）ので、画面は koeApp.linkBase（app:link-base）で聞く。LN-1 で住所の頭を src/natsulink.js の LINK_ORIGIN へ移す
test('0.10.0 L-1: app:link-base は main.js の HELP_URL の open#p=（https の住所。# の後ろの ID はサーバーへ送られない）。画面は答えの形を照らしてから使う', () => {
  assert.match(main, /ipcMain\.handle\('app:link-base', \(\) => `\$\{HELP_URL\}open#p=`\);/);
  assert.match(appHtml, /const isLinkBase = \(b\) => typeof b === 'string' && \/\^https:/);
  assert.ok(!/natsu-help/.test(appHtml), '画面に住所を書いた');
});

// 0.10.0 L-2（D70・決めたこと 101）: 一覧の選びの決まり（純粋。後のデータベースの表でも使う）を app.html から字面で取り出して当てる
const fnFromApp = (name) => {
  const plain = appHtml.indexOf(`  function ${name}(`);
  const at = plain > 0 ? plain : appHtml.indexOf(`  async function ${name}(`);
  assert.ok(at > 0, `app.html に ${name} が無い`);
  return appHtml.slice(at, appHtml.indexOf('\n  }\n', at) + 4);
};
test('0.10.0 L-2 D70: selStep の表（toggleMode・click・shift の範囲・clear・keep・受けた物を変えない）と selLines（order の並び・50 件まで）', () => {
  const { selStep, selLines } = new Function(`${fnFromApp('pageRefLine')}\n${fnFromApp('selStep')}\n${fnFromApp('selLines')}\nreturn { selStep, selLines };`)();   // eslint-disable-line no-new-func
  const order = ['a', 'b', 'c', 'd'];
  const off = { on: false, ids: [], anchor: '' };
  const on = selStep(off, { type: 'toggleMode' }, order);
  assert.deepStrictEqual(on, { on: true, ids: [], anchor: '' });
  assert.deepStrictEqual(selStep({ on: true, ids: ['a'], anchor: 'a' }, { type: 'toggleMode' }, order), { on: false, ids: [], anchor: '' });
  // on でない click は何もしない（ページを開く側）
  assert.deepStrictEqual(selStep(off, { type: 'click', id: 'a' }, order), off);
  const s1 = selStep(on, { type: 'click', id: 'c' }, order);
  assert.deepStrictEqual(s1, { on: true, ids: ['c'], anchor: 'c' });
  const s2 = selStep(s1, { type: 'click', id: 'a' }, order);
  assert.deepStrictEqual(s2.ids, ['c', 'a'], '選んだ順のまま持つ（並べるのは selLines）');
  assert.deepStrictEqual(selStep(s2, { type: 'click', id: 'c' }, order).ids, ['a']);
  // shift: anchor（a）から今の行（d）までを、今の行の向き（付ける）にそろえる。anchor は動かさない
  const s3 = selStep(s2, { type: 'click', id: 'd', shift: true }, order);
  assert.deepStrictEqual([[...s3.ids].sort(), s3.anchor], [['a', 'b', 'c', 'd'], 'a']);
  // 上向き・外す向き
  const s4 = selStep({ on: true, ids: ['a', 'b', 'c', 'd'], anchor: 'd' }, { type: 'click', id: 'b', shift: true }, order);
  assert.deepStrictEqual(s4.ids, ['a']);
  // anchor が order に無ければ今の行だけ
  assert.deepStrictEqual(selStep({ on: true, ids: [], anchor: 'zz' }, { type: 'click', id: 'c', shift: true }, order).ids, ['c']);
  // order に無い行の click は何もしない
  assert.deepStrictEqual(selStep(s1, { type: 'click', id: 'zz' }, order), s1);
  assert.deepStrictEqual(selStep(s2, { type: 'clear' }, order), { on: true, ids: [], anchor: '' });
  assert.deepStrictEqual(selStep({ on: true, ids: ['a', 'x', 'c'], anchor: 'x' }, { type: 'keep', ids: ['a', 'b', 'c'] }, order), { on: true, ids: ['a', 'c'], anchor: '' });
  // 受けた物を変えない
  const frozen = { on: true, ids: ['a'], anchor: 'a' };
  const before = JSON.stringify(frozen);
  for (const ev of [{ type: 'click', id: 'b' }, { type: 'click', id: 'd', shift: true }, { type: 'keep', ids: [] }, { type: 'clear' }, { type: 'toggleMode' }]) selStep(frozen, ev, order);
  assert.strictEqual(JSON.stringify(frozen), before);
  // selLines: order の並びで、選んだ ID だけ、50 件まで
  const pages = order.map((id, i) => ({ id, title: `t${i}`, date: '2026-10-01' }));   // 利用者が付け直した題名（D77。行の並びだけを見る）
  const base = 'https://example.invalid/open#p=';
  assert.deepStrictEqual(selLines(order, { on: true, ids: ['d', 'a'], anchor: 'a' }, pages, base), {
    lines: [`NaTsu の議事録「t0」（2026-10-01）${base}a`, `NaTsu の議事録「t3」（2026-10-01）${base}d`], truncated: false });
  const big = Array.from({ length: 51 }, (_, i) => `p${i}`);
  const r = selLines(big, { on: true, ids: [...big].reverse(), anchor: '' }, big.map((id) => ({ id, title: id, date: '2026-10-01' })), base);   // 利用者が付け直した題名（D77。数だけを見る）
  assert.deepStrictEqual([r.lines.length, r.truncated, r.lines[0].endsWith('p0'), r.lines[49].endsWith('p49')], [50, true, true, true]);
});

// 0.10.0 L-2（D74）: 一覧の枠のボタンは［リンクを写す］（前の案の［Claude に渡す］の名前にしない。写した物は Claude だけでなく、後のチームの共有でも使う）
test('0.10.0 L-2 D74: app.html の画面の文に「Claude に渡す」が無く、選んでいる間の枠のボタンは［リンクを写す］［やめる］', () => {
  assert.ok(!appHtml.includes('Claude に渡す'));
  assert.match(appHtml, /<button class="action" id="selCopy" type="button">リンクを写す<\/button>/);
  assert.match(appHtml, /<button class="ghost" id="selCancel" type="button">やめる<\/button>/);
});

// 0.10.0 LN-1（D72・決めたこと 142）: 画面の写しの照らし parseNatsuLinkView（app.html。画面は Node の部品を読めない）と src/natsulink.js の parseNatsuLink に同じ表を当てる。
// 画面は住所（https）を持たない（F15）ので、写しは natsu:// の形だけ。https の住所の照らしは main（koeApp の答え）に任せる
test('0.10.0 LN-1: parseNatsuLinkView（app.html）と natsulink.parseNatsuLink は同じ表で同じ答え', () => {
  const NL = require('../src/natsulink');
  const view = new Function(`${fnFromApp('parseNatsuLinkView')}\nreturn parseNatsuLinkView;`)();   // eslint-disable-line no-new-func
  const cases = ['natsu://page/pm1', 'natsu://page/pm1#t:s3-s5', 'natsu://page/pm1#b:b3', 'natsu://page/pm1#m:2', 'natsu://page/pm1#b3', 'natsu://page/pm1/', '  natsu://page/pm1#t:s1-s1 \n',
    'NATSU://page/pm1', 'natsu:page/pm1', 'natsu://other/pm1', 'natsu://page/pm1?x=1', 'natsu://page/pm%201', 'natsu://page/p m1', 'natsu://page/pm1"', "natsu://page/pm1'",
    'natsu://page/pm1\\', 'natsu://page/pm1\u0000', `natsu://page/pm1#${'b'.repeat(288)}`, `natsu://page/${'a'.repeat(65)}`, 'natsu://page/pm1#t:s3-', 'natsu://page/pm1#a#b',
    'natsu://page/pm1//', 'natsu://page/', 'natsu://page/pm1#javascript:x', `${NL.LINK_ORIGIN}/open#p=pm1`, 'pm1', '', null, 5];
  for (const s of cases) assert.deepStrictEqual(view(s), NL.parseNatsuLink(s), JSON.stringify(s));
});

// 0.10.0 LN-4（決めたこと 146）: リンクで起こされたときにできるのは「ページを開いて捲る」だけ。画面のリンクの受け手（openLink・showLinkSpot）と main の
// openLinkFromArgv は、書く・消す・要約・設定・登録・外へ送る口を呼ばない（字面で見る）
test('0.10.0 LN-4: リンクの受け手は読むだけの口しか持たない（画面の openLink・showLinkSpot と main の openLinkFromArgv）', () => {
  const view = `${fnFromApp('openLink')}\n${fnFromApp('showLinkSpot')}`;
  const apis = [...view.matchAll(/koeApp\.([A-Za-z]+)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(apis)], ['pageGet']);
  for (const w of ['ipcRenderer', 'copy(', 'openExternal', 'location.', 'innerHTML']) assert.ok(!view.includes(w), `画面のリンクの受け手に ${w}`);
  const at = main.indexOf('function openLinkFromArgv(');
  const fn = main.slice(at, main.indexOf('\n}\n', at));
  const sends = [...fn.matchAll(/sendToMainWin\('([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(sends)], ['page:open-link']);
  for (const w of ['db.call', 'dbCall', 'writeJsonFile', 'settingsWriter', 'shell.', 'runSummary', 'mcpRegister', 'fetch(']) assert.ok(!fn.includes(w), `main のリンクの受け手に ${w}`);
});

// 0.10.0 E-1（MR9・EL8 を広げる）: CI の electron-smoke とリリースの installer が、node_modules の Electron と詰めた NaTsu.exe で MCP の往復を通す
test('0.10.0 E-1 EL8: ci.yml と release.yml が node_modules の Electron と詰めた NaTsu.exe で tools/mcp-probe.js を走らせる', () => {
  const NODE_MOD = 'node tools/mcp-probe.js --exe node_modules/electron/dist/electron.exe --script src/mcp/server.js';
  const PACKED = 'node tools/mcp-probe.js --exe dist/win-unpacked/NaTsu.exe --script dist/win-unpacked/resources/app/src/mcp/server.js';
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const y = read(f);
    assert.ok(y.includes(NODE_MOD), `${f}: node_modules の Electron で回していない`);
    assert.ok(y.includes(PACKED), `${f}: 詰めた NaTsu.exe で回していない`);
  }
});

// 0.10.0 LS-1・LS-2（D63・D69・決めたこと 111）: 要約の欄の鍵は main・DB（mainlib.summaryLock）と画面（app.html の summaryLockView）で同じ表。
// 同じ並びのページを両方に当てて同じ答え、一言の表も同じ
test('0.10.0 LS-2: summaryLockView（app.html）と mainlib.summaryLock に同じ表を当てて同じ答え。一言の表も同じ', () => {
  const lib = require('../src/mainlib');
  const view = new Function(`${fnFromApp('summaryLockView')}\nreturn summaryLockView;`)();
  const m = /const SUMMARY_LOCK_VIEW_TEXT = (\{[\s\S]*?\n {2}\});/.exec(appHtml);
  assert.ok(m, '画面の一言の表が無い');
  assert.deepStrictEqual(new Function(`return ${m[1]};`)(), { ...lib.SUMMARY_LOCK_TEXT });
  const said = [{ id: 's1', text: 'はい' }];
  const none = [{ id: 's1', text: '', failed: true }];
  const pages = [null, {}, { summaryWait: true }, { summaryWait: true, blocks: [{ id: 'b1' }] }, { blocks: [{ id: 'b1' }] }, { blocks: [], route: { summary: { at: 'x' } } },
    { route: { summary: { by: 'claude-code' } } }, { summaryError: '断った' }, { summaryError: '' }, { route: { summary: 3 } }, { blocks: 'x' }, []];
  const opts = [{}, { live: true }, { making: true }, { live: true, making: true }];
  for (const p of pages) for (const o of opts) for (const segments of [said, none, [], undefined]) {
    const a = { ...o, segments };
    assert.strictEqual(view(p, a), lib.summaryLock(p, a), JSON.stringify([p, a]));
  }
});

// 0.10.0 LS-5（D59・決めたこと 110）: 案内から要約のローカル AI を外し、要約待ちを書く。配るものから setup-summarizer.ps1 を外す
test('0.10.0 LS-5: README・INSTALL・ヘルプの記事に要約のローカル AI（llama・Gemma・setup-summarizer・要約エンジン・5.6GB）の字が無く、要約待ちの文がある', () => {
  const arts = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else if (n.endsWith('.md')) arts.push(path.relative(ROOT, f)); } };
  walk(path.join(ROOT, 'help', 'articles'));
  const BAD = [/llama/i, /Gemma/, /setup-summarizer/, /要約エンジン/, /要約のエンジン/, /要約も PC の中/, /5\.6 ?GB/, /数 GB を取り込む/, /PC の中で文字起こしと要約/, /PC の中の文字起こしと要約/];
  for (const f of ['README.md', 'INSTALL.md', ...arts]) {
    const t = read(f);
    for (const re of BAD) assert.ok(!re.test(t), `${f} に ${re}: ${(t.match(new RegExp(`.{0,30}${re.source}.{0,30}`)) || [''])[0]}`);
  }
  for (const f of ['README.md', 'help/articles/summary/how-summaries.md', 'help/articles/record/pc-only.md']) assert.ok(read(f).includes('要約待ち（つながったら作ります）'), `${f} に要約待ちの文が無い`);
  assert.ok(!/llama/i.test(JSON.parse(read('package.json')).description), 'package.json の説明に llama');
});

test('0.10.0 LS-5: リリースの手順が setup-summarizer.ps1 を配らない。setup-summarizer.ps1 は無い', () => {
  const rel = read('.github/workflows/release.yml');
  assert.ok(!rel.includes('setup-summarizer'), 'release.yml が setup-summarizer.ps1 を配る');
  assert.ok(!fs.existsSync(path.join(ROOT, 'setup-summarizer.ps1')), 'setup-summarizer.ps1 が残っている');
  assert.ok(!read('get-installer.ps1').includes('llama'), 'get-installer.ps1 の注に llama');
});

// 0.10.0 G-1（MR9・D57・決めたこと 59）: README に「Claude から議事録を読む（MCP）」の節。INSTALL に任意の手順と、入れ直しの前に Claude を終了する1行
const mdSection = (text, head) => {
  const i = text.indexOf(`\n${head}\n`);
  if (i < 0) return '';
  const level = head.match(/^#+/)[0].length;
  const rest = text.slice(i + head.length + 2);
  const m = rest.match(new RegExp(`\\n#{1,${level}} `));
  return m ? rest.slice(0, m.index) : rest;
};
test('0.10.0 G-1: README に「Claude から議事録を読む（MCP）」の節があり、Anthropic へ送られること（オフラインモードの会議も）・学習の設定・読むだけ・ポートを開かないこと・登録の仕方と登録し直し・消しても会話に残ること・つながらないとき・Store 版を書く', () => {
  const r = read('README.md');
  const sec = mdSection(r, '### Claude から議事録を読む（MCP）');
  assert.ok(sec, 'README に「### Claude から議事録を読む（MCP）」の節が無い');
  const online = r.indexOf('\n## オンラインの文字起こしと要約\n');
  assert.ok(online > 0 && r.indexOf('\n### Claude から議事録を読む（MCP）\n') > online, 'MCP の節が「オンラインの文字起こしと要約」の下に無い');
  for (const w of ['Claude（Anthropic）へ送られます', 'オフラインモード', '学習', '読むだけ', 'ポートを開きません', '標準入出力', '［Claude デスクトップに登録］', '［登録し直す］',
    '終了', 'Claude の会話に残ります', 'mcp-server-natsu.log', 'Microsoft Store', 'start/claude-mcp']) {
    assert.ok(sec.includes(w), `README の MCP の節に「${w}」が無い`);
  }
  assert.ok(!/1on1[^\n]*送られません|送りません[^\n]*Claude/.test(sec), 'MCP の節が送らないと約束している');
});

test('0.10.0 G-1: README と INSTALL に、入れ直し・アンインストールの前に Claude デスクトップを終了する文がある。INSTALL は「Claude Code を入れる」の後に Claude から読む任意の手順', () => {
  const QUIT = '入れ直し・アンインストールの前に、Claude デスクトップを終了してください';
  assert.ok(read('README.md').includes(QUIT), 'README に Claude を終了する文が無い');
  const i = read('INSTALL.md');
  assert.ok(mdSection(i, '## 入れ直し（0.3.0 から）').includes(QUIT), 'INSTALL の入れ直しに Claude を終了する文が無い');
  const cc = i.indexOf('\n## Claude Code を入れる（オンラインの要約）\n');
  const mcp = i.indexOf('\n## （任意）Claude から議事録を読む\n');
  assert.ok(cc > 0 && mcp > cc, 'INSTALL の「Claude Code を入れる」の後に Claude から読む任意の手順が無い');
  const s = mdSection(i, '## （任意）Claude から議事録を読む');
  for (const w of ['［設定］→［要約］', '［Claude デスクトップに登録］', 'Claude（Anthropic）へ送られます', '終了']) assert.ok(s.includes(w), `INSTALL の任意の手順に「${w}」が無い`);
});

// 0.10.1 CD-5（計画 docs/plans/2026-10-23-101.md の決めたこと 14・D84・D83・D88）: README の MCP の節とヘルプの記事 start/claude-mcp に、
// Claude デスクトップが動いている間は登録を変えないこと・起動のときに登録し直すこと・Microsoft Store 版の記録の場所を書く
test('0.10.1 CD-5: README の MCP の節とヘルプの記事に、動いている間は登録を変えない・起動のときに登録し直す・Store 版の記録の場所（Claude-Data の claude_… の logs）', () => {
  const STORE_LOG = '%LOCALAPPDATA%\\Claude-Data\\claude_…\\logs\\mcp-server-natsu.log';
  const readme = mdSection(read('README.md'), '### Claude から議事録を読む（MCP）');
  const art = read('help/articles/start/claude-mcp.md');
  for (const [name, text] of [['README', readme], ['ヘルプの記事', art]]) {
    assert.ok(text.includes('動いている間は、NaTsu は登録を変えません'), `${name} に動いている間の文が無い`);
    assert.ok(/起動のときに確かめ、Claude デスクトップが終了していれば、?自動で登録し直します/.test(text), `${name} に起動のときの書き直しの文が無い`);
    assert.ok(text.includes(STORE_LOG), `${name} に Store 版の記録の場所が無い`);
    assert.ok(text.includes('%APPDATA%\\Claude\\logs\\mcp-server-natsu.log'), `${name} から今の記録の場所が消えた`);
    assert.ok(!text.includes('消えていれば左下に知らせます。［登録し直す］ を押してください'), `${name} に古い文が残っている`);
  }
});

// 0.10.1 点検の直し（Ruling R12）: ヘルプの記事の「NaTsu を別の場所に入れ直したとき」の1文を 0.10.1 のふるまい（起動のときに黙って直す・動いていれば知らせる）に合わせる
test('0.10.1 点検の直し R12: ヘルプの記事の入れ直したときの文は、Claude が終了していれば起動のときに自動で直し、動いていれば知らせる', () => {
  const art = read('help/articles/start/claude-mcp.md');
  assert.ok(!art.includes('NaTsu を別の場所に入れ直したときも、知らせが出ます。'), '0.10.0 の文が残っている');
  assert.ok(art.includes('NaTsu を別の場所に入れ直したときも同じです（Claude デスクトップが終了していれば起動のときに自動で直し、動いていれば知らせます）。'), '入れ直したときの文が無い');
});

// 0.11.0 V-2（D48・F24・F26・当て直し 15）: 画面の並びは memoTypes の VIEW_HEADS・orderForView と画面の写しで同じ表。写しの点の行も quality.qualityLines と同じ
// 0.13.0 ED-6（計画 docs/plans/2026-10-24-130.md の「意図して変えるテスト」）で意図して変えた: 落とした所は afterId で送るので savedIndexForDrop は両方から外した
// （F26 の同じ失敗は test/stage130.edit.app.test.js の ED-6・F46 の場面が見る）
test('0.11.0 V-2: orderForView・qualityLinesView（app.html）と memoTypes・quality に同じ表を当てて同じ答え。VIEW_HEADS も同じ', () => {
  const M = require('../src/memoTypes');
  const Q = require('../src/quality');
  const m = /\n {2}const VIEW_HEADS = (\{[\s\S]*?\n {2}\});/.exec(appHtml);
  assert.ok(m, '画面の VIEW_HEADS が無い');
  const heads = new Function(`return ${m[1]};`)();   // eslint-disable-line no-new-func
  assert.deepStrictEqual(heads, JSON.parse(JSON.stringify(M.VIEW_HEADS)));
  const app = new Function(`const VIEW_HEADS = ${m[1]};\n${fnFromApp('orderForView')}\n${fnFromApp('qualityLinesView')}\nreturn { orderForView, qualityLinesView };`)();   // eslint-disable-line no-new-func
  const H = (text) => ({ id: text, type: 'heading', text });
  const B = (text) => ({ id: text, type: 'bullet', text });
  const names = [...M.VIEW_HEADS.closing, M.VIEW_HEADS.check, M.VIEW_HEADS.advice, ...M.VIEW_HEADS.type, '概要', '人の見出し', '■ 目的', '**決定事項**', 'ToDo', '持ち越し（次回）', ' 予算(B) '];
  const tables = [[], [B('a')], undefined, null, 'x'];
  // 名前の並びを回して、見出しと行の色々な並びを作る
  for (let r = 0; r < names.length; r++) {
    const rot = [...names.slice(r), ...names.slice(0, r)];
    tables.push(rot.flatMap((n, i) => (i % 3 === 0 ? [H(n), B(`${n}-1`)] : i % 3 === 1 ? [H(n)] : [B(`pre-${n}`), H(n), B(`${n}-1`), B(`${n}-2`)])));
  }
  for (const t of tables) assert.deepStrictEqual(app.orderForView(t), M.orderForView(t), JSON.stringify(t));
  assert.strictEqual(M.savedIndexForDrop, undefined, 'memoTypes に savedIndexForDrop が残っている');
  assert.ok(!/\bfunction savedIndexForDrop\(/.test(appHtml), '画面に savedIndexForDrop の写しが残っている');
  const view = Q.qualityView({ v: 1, total: 15, max: 25, axes: Q.AXES.map((a) => ({ key: a.key, score: 3, reason: `${a.label}の理由`, cites: [] })), at: '' });
  assert.ok(view);
  for (const v of [view, null, undefined]) assert.deepStrictEqual(app.qualityLinesView(v), Q.qualityLines(v));
});

// 0.12.0 SP-1（計画 docs/plans/2026-10-22-120.md の「受け渡す名前と形」）: 声あり・なしの境は録音バーの無音の警告と同じ値。タイムラインと札は1か所で決める
test('0.12.0 SP-1: mainlib.VOICE_LEVEL は録音バーの SILENT_LEVEL と同じ字面。mainlib の timelineOf・札の表は src/mcp/timeline.js と同じ物', () => {
  const L = require('../src/mainlib');
  const TL = require('../src/mcp/timeline');
  const m = read('src/renderer/overlay.html').match(/const SILENT_LEVEL = ([0-9.]+);/);
  assert.ok(m, '録音バーの SILENT_LEVEL が無い');
  assert.strictEqual(L.VOICE_LEVEL, Number(m[1]));
  assert.match(read('src/mainlib.js'), new RegExp(`const VOICE_LEVEL = ${m[1].replace('.', '\\.')};`));
  assert.strictEqual(L.timelineOf, TL.timelineOf);
  assert.strictEqual(L.SOURCE_LABELS, TL.SOURCE_LABELS);
  assert.strictEqual(L.srcLabel, TL.srcLabel);
  assert.strictEqual(L.checkParts, TL.checkParts);
});

// 0.12.0 SP-4（決めたこと 85・127・139）: 画面の札の表と、画面の写しのタイムライン（timelineView・checkPartsView）は src/mcp/timeline.js と同じ
test('0.12.0 SP-4: SOURCE_NAMES（app.html）と SOURCE_LABELS が同じ。timelineView・checkPartsView と timeline.js の timelineOf・checkParts に同じ表を当てて同じ答え', () => {
  const TL = require('../src/mcp/timeline');
  const m = appHtml.match(/const SOURCE_NAMES = (\{[^}]*\});/);
  assert.ok(m, 'app.html に SOURCE_NAMES が無い');
  assert.deepStrictEqual(new Function(`return ${m[1]};`)(), { ...TL.SOURCE_LABELS });   // eslint-disable-line no-new-func
  const app = new Function(`${fnFromApp('checkPartsView')}\n${fnFromApp('timelineView')}\nreturn { checkPartsView, timelineView };`)();   // eslint-disable-line no-new-func
  const text = '一つ目の文です。二つ目の文です。三つ目です。';
  const partsCases = [
    [[{ ms: 0, at: 0 }, { ms: 20000, at: 8 }, { ms: 40000, at: 16 }], text, 60000],
    [[{ ms: 0, at: 0 }, { ms: 20000, at: 8 }], text, undefined],
    [[{ ms: 0, at: 0 }, { ms: 70000, at: 8 }], text, 60000],
    [[{ ms: 0, at: 0 }, { ms: 5000, at: 999 }], text, 60000],
    [[{ ms: 0, at: 0 }, { ms: 5000, at: 0 }], text, 60000],
    [[{ ms: 0, at: 0 }, { ms: 0, at: 8 }], text, 60000],
    [[{ ms: 1, at: 0 }, { ms: 5000, at: 8 }], text, 60000],
    [[{ ms: 0, at: 0 }, { ms: 5000, at: 8.5 }], text, 60000],
    [[{ ms: 0, at: 0 }, { ms: -5, at: 8 }], text, 60000],
    [[{ ms: 0, at: 0 }, { ms: 5000, at: 3 }], '一  　 二', 60000],
    [[{ ms: 0, at: 0 }], text, 60000], [Array.from({ length: 201 }, (_, k) => ({ ms: k, at: k })), 'x'.repeat(300), undefined],
    [null, text, 1], ['[]', text, 1], [[{ ms: 0, at: 0 }, null], text, 1], [[{ ms: 0, at: 0 }, [5, 8]], text, 1], [[{ ms: 0, at: 0 }, { ms: 5, at: 8 }], 5, 1],
  ];
  for (const [p, t, d] of partsCases) assert.deepStrictEqual(app.checkPartsView(p, t, d), TL.checkParts(p, t, d), JSON.stringify([p, t, d]).slice(0, 200));
  const segs = [
    { id: 's1', atMs: 2000, durationMs: 3000, text: '自分', src: 'mic' },
    { id: 's2', atMs: 0, durationMs: 60000, text, src: 'loopback', parts: partsCases[0][0] },
    { id: 's3', text: '時刻なし' },
    { id: 's4', atMs: 2000, durationMs: 1000, text: '同じ時刻', src: '話者A', speaker: '話者A' },
    { id: 's5', atMs: 30000, durationMs: 1000, text: '', src: 'mic', pending: true, parts: partsCases[0][0] },
    { id: 's6', atMs: 31000, durationMs: 1000, text: 'x', failed: true, kept: true, src: 'loopback', parts: partsCases[0][0] },
    { id: 's7', atMs: 50000, durationMs: 60000, text, src: 'loopback', parts: partsCases[3][0] },
    null, 'x', [1], { id: 's8', atMs: 'a', text: 5 },
  ];
  for (const list of [segs, segs.slice().reverse(), [], null, undefined, 'x', [segs[2], segs[0]]]) {
    assert.deepStrictEqual(app.timelineView(list), TL.timelineOf(list), String(JSON.stringify(list)).slice(0, 200));
  }
  // 札の title（決めたこと 139）
  assert.ok(appHtml.includes("const SOURCE_TITLES = { mic: 'マイクから録った声です（同じ部屋の人の声も入ります）', loopback: 'PC から流れた相手の声です' };"));
});
