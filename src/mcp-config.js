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
const MSIX_PREFIXES = ['Claude_', 'Anthropic.Claude_'];

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// 登録する1項目（決めたこと 17: Claude デスクトップの子では %APPDATA% が展開されないことがあるので、DB のフォルダを渡す）
function serverEntry({ exe, script, dataDir }) {
  return { command: exe, args: [script], env: { ELECTRON_RUN_AS_NODE: '1', [MARK]: '1', NATSU_DATA_DIR: dataDir } };
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

// 設定ファイルの場所の配列。readdir・exists はテストで偽物（main は fs.readdirSync・fs.existsSync）
function configFiles({ appData, localAppData, readdir, exists }) {
  const out = [];
  if (appData && exists(path.join(appData, 'Claude'))) out.push(path.join(appData, 'Claude', CONFIG_NAME));
  if (localAppData) {
    const pk = path.join(localAppData, 'Packages');
    let names = [];
    try { names = readdir(pk); } catch (_) { names = []; }
    for (const n of names) {
      if (typeof n !== 'string' || !MSIX_PREFIXES.some((p) => n.startsWith(p))) continue;
      const dir = path.join(pk, n, 'LocalCache', 'Roaming', 'Claude');
      if (exists(dir)) out.push(path.join(dir, CONFIG_NAME));
    }
  }
  return out;
}

// 控えの名前（同じフォルダに写す: 決めたこと 18）。時刻の : と . は - に
function backupName(file, now) {
  return `${file}.natsu-${now.toISOString().replace(/[:.]/g, '-')}.bak`;
}
// NaTsu の控えか（消すのは NaTsu の控えだけ。新しい BACKUP_KEEP 個を残す）
function isNatsuBackup(base, name) {
  return typeof name === 'string' && name.startsWith(`${base}.natsu-`) && /\.natsu-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/.test(name);
}

// tasklist の答え → Claude デスクトップ（claude.exe）が動いているか: true・false・null（分からない）（決めたこと 149）
function claudeRunningOf(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  return /(^|\n)\s*"?claude\.exe"?\s*,/i.test(stdout);
}

module.exports = { ENTRY_NAME, MARK, BACKUP_KEEP, CONFIG_NAME, serverEntry, entryState, mergeEntry, removeEntry, configFiles, backupName, isNatsuBackup, claudeRunningOf };
