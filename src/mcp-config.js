'use strict';
// Claude デスクトップの設定ファイル（claude_desktop_config.json）に NaTsu の MCP のサーバーの1項目を合わせる部品
// （0.10.0 Task C-1。計画 docs/plans/2026-10-20-100.md の「受け渡す名前と形」。純粋: ファイルに触れない。main だけが使う）。
//  - 登録の名前は natsu、印は env の NATSU_MCP: '1'（同じ名前で印の無い登録は他人のものとして奪わない: 決めたこと 16）。
//  - 受けた物は書き換えず、写してから変える。ほかの鍵（好みの設定）・mcpServers のほかの項目・鍵の並びはそのまま（RF61）。
//  - 場所は main が決める（画面はパスを渡さない: 方針 7）。Microsoft Store 版の場所（%LOCALAPPDATA%\Packages\Claude_*）も探す（決めたこと 19）。
const path = require('node:path');

const ENTRY_NAME = 'natsu';
const MARK = 'NATSU_MCP';
const BACKUP_KEEP = 3;
const CONFIG_NAME = 'claude_desktop_config.json';
// Microsoft Store 版の前の場所の名前の頭（小文字にした名前に当てる。0.10.1 CD-1 で大文字と小文字を区別しなくした）
const MSIX_PREFIXES = ['claude_', 'anthropic.claude_'];
// 新しい Store 版の場所（%LOCALAPPDATA%\Claude-Data\claude_<符号>。0.10.1 CD-1。計画 docs/plans/2026-10-23-101.md の決めたこと 1）
const DATA_ROOT = 'Claude-Data';
const DATA_NAME = /^(anthropic\.)?claude_[a-z0-9]+$/;   // 小文字にした名前に当てる

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// 登録する1項目（決めたこと 17: Claude デスクトップの子では %APPDATA% が展開されないことがあるので、DB のフォルダを渡す）
// （引数の名前は dbDir: main に外した設定キー dataDir の名残を置かない。test/stage3.main の確かめ）
function serverEntry({ exe, script, dbDir }) {
  return { command: exe, args: [script], env: { ELECTRON_RUN_AS_NODE: '1', [MARK]: '1', NATSU_DATA_DIR: dbDir } };
}

const marked = (e) => isObj(e) && isObj(e.env) && e.env[MARK] === '1';

// 'none'・'same'・'stale'（印があって command・args・NATSU_DATA_DIR のどれかが違う）・'other'（同じ名前で印が無い）・'shape'
function entryState(config, entry) {
  if (!isObj(config)) return 'shape';
  if (config.mcpServers !== undefined && !isObj(config.mcpServers)) return 'shape';
  const servers = config.mcpServers || {};
  if (!Object.hasOwn(servers, ENTRY_NAME)) return 'none';
  const e = servers[ENTRY_NAME];
  if (!marked(e)) return 'other';
  const same = e.command === entry.command
    && JSON.stringify(e.args) === JSON.stringify(entry.args)
    && e.env.NATSU_DATA_DIR === entry.env.NATSU_DATA_DIR;
  return same ? 'same' : 'stale';
}

// → { ok: true, config, changed } か { ok: false, code: 'other' | 'shape' }。新しい natsu は mcpServers の最後、古い natsu はその場所で替える
function mergeEntry(config, entry) {
  const st = entryState(config, entry);
  if (st === 'shape' || st === 'other') return { ok: false, code: st };
  const out = clone(config);
  if (st === 'same') return { ok: true, config: out, changed: false };
  const servers = isObj(out.mcpServers) ? out.mcpServers : {};
  servers[ENTRY_NAME] = clone(entry);   // 鍵がもうあれば並びはそのまま、無ければ最後
  out.mcpServers = servers;
  return { ok: true, config: out, changed: true };
}

// → { ok: true, config, changed } か { ok: false, code }。印のある natsu だけを消す（mcpServers が空になっても鍵は残す）
function removeEntry(config) {
  if (!isObj(config) || (config.mcpServers !== undefined && !isObj(config.mcpServers))) return { ok: false, code: 'shape' };
  const out = clone(config);
  if (!isObj(out.mcpServers) || !Object.hasOwn(out.mcpServers, ENTRY_NAME)) return { ok: true, config: out, changed: false };
  if (!marked(out.mcpServers[ENTRY_NAME])) return { ok: false, code: 'other' };
  delete out.mcpServers[ENTRY_NAME];
  return { ok: true, config: out, changed: true };
}

// 設定ファイルの場所の配列 [{ file, kind }]（kind は 'roaming' | 'data' | 'packages'。0.10.1 CD-1）。readdir・exists・isDir はテストで偽物
// （main は fs.readdirSync・fs.existsSync・statSync().isDirectory()）。並びは Roaming → Claude-Data → Packages（どれも名前の小文字の順: 決めたこと 7）。
// 名前は小文字にしてから照らし（Windows は大文字と小文字を区別しない: 決めたこと 6）、書く先には readdir が返した名前をそのまま使う
const byLower = (a, b) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};
const namesIn = (dir, readdir) => {
  let names = [];
  try { names = readdir(dir); } catch (_) { names = []; }
  if (!Array.isArray(names)) return [];
  return names.filter((n) => typeof n === 'string').sort(byLower);
};
function configPlaces({ appData, localAppData, readdir, exists, isDir = exists }) {
  const out = [];
  if (appData && exists(path.join(appData, 'Claude'))) out.push({ file: path.join(appData, 'Claude', CONFIG_NAME), kind: 'roaming' });
  if (localAppData) {
    const dr = path.join(localAppData, DATA_ROOT);
    for (const n of namesIn(dr, readdir)) {
      if (!DATA_NAME.test(n.toLowerCase())) continue;
      if (isDir(path.join(dr, n))) out.push({ file: path.join(dr, n, CONFIG_NAME), kind: 'data' });
    }
    const pk = path.join(localAppData, 'Packages');
    for (const n of namesIn(pk, readdir)) {
      if (!MSIX_PREFIXES.some((p) => n.toLowerCase().startsWith(p))) continue;
      const dir = path.join(pk, n, 'LocalCache', 'Roaming', 'Claude');
      if (exists(dir)) out.push({ file: path.join(dir, CONFIG_NAME), kind: 'packages' });
    }
  }
  return out;
}
// 0.10.0 の口（場所のファイルの配列）
function configFiles(opts) {
  return configPlaces(opts).map((p) => p.file);
}
// 場所の種類の数（記録の1行のため。パスは持たない: 決めたこと 13）
function placeCounts(places) {
  const c = { roaming: 0, data: 0, packages: 0 };
  for (const p of places || []) if (p && Object.hasOwn(c, p.kind)) c[p.kind] += 1;
  return c;
}

// 控えの名前（同じフォルダに写す: 決めたこと 18）。時刻の : と . は - に
function backupName(file, now) {
  return `${file}.natsu-${now.toISOString().replace(/[:.]/g, '-')}.bak`;
}
// NaTsu の控えか（消すのは NaTsu の控えだけ。新しい BACKUP_KEEP 個を残す）
function isNatsuBackup(base, name) {
  return typeof name === 'string' && name.startsWith(`${base}.natsu-`) && /\.natsu-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/.test(name);
}

// 起動のときに黙って書き直すか（0.10.1 CD-4。D83・D86・計画の決めたこと 4）。states はファイルごとの状態、marked は前に登録した印があるか
//  → 'rewrite'（main が tasklist を見て、動いていなければ書く）| 'notice-stale' | 'notice-gone' | 'none'（何もしない）
const AUTO_OK = new Set(['same', 'none', 'stale']);
function autoPlan({ states, marked }) {
  const st = Array.isArray(states) ? states : [];
  if (!st.length) return 'none';
  if (!marked) return st.includes('stale') && st.every((s) => AUTO_OK.has(s)) ? 'notice-stale' : 'none';
  if (!st.some((s) => s === 'none' || s === 'stale')) return 'none';
  if (st.every((s) => AUTO_OK.has(s))) return 'rewrite';
  return st.includes('stale') ? 'notice-stale' : 'notice-gone';
}

// Claude デスクトップが動いているか分からないときの「続けて2回目」（0.10.1 CD-3。D85・Ruling R1）。
// pending は1回目（RN2 で断った押し）の { action: 'register' | 'unregister', at }。同じボタンを 60 秒以内（ちょうども含む）にもう一度押したら書く。
// 違うボタン・60 秒を越えた・時計が戻った・形の違う pending は、今の押しを新しい1回目にして断る。→ { write, pending }（書いたら pending は null）
const UNKNOWN_CONFIRM_MS = 60 * 1000;
function unknownStep({ pending, action, now }) {
  const ok = isObj(pending) && pending.action === action && Number.isFinite(pending.at);
  if (ok && now >= pending.at && now - pending.at <= UNKNOWN_CONFIRM_MS) return { write: true, pending: null };
  return { write: false, pending: { action, at: now } };
}

// tasklist.exe に渡す決まった引数（決めたこと 149。claude.exe の名前だけを見る）
const TASKLIST_ARGS = Object.freeze(['/FI', 'IMAGENAME eq claude.exe', '/NH', '/FO', 'CSV']);
// tasklist の答え → Claude デスクトップ（claude.exe）が動いているか: true・false・null（分からない）（決めたこと 149）
function claudeRunningOf(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  return /(^|\n)\s*"?claude\.exe"?\s*,/i.test(stdout);
}

module.exports = {
  ENTRY_NAME, MARK, BACKUP_KEEP, CONFIG_NAME, DATA_ROOT, TASKLIST_ARGS, serverEntry, entryState, mergeEntry, removeEntry,
  configPlaces, configFiles, placeCounts, backupName, isNatsuBackup, claudeRunningOf, UNKNOWN_CONFIRM_MS, unknownStep, autoPlan,
};
