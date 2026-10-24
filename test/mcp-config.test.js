/* mcp-config.test.js — 0.10.0 Task C-1（MR8・F2・RF61。計画 docs/plans/2026-10-20-100.md）: Claude デスクトップの設定に NaTsu の1項目を合わせる部品（純粋） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const C = require('../src/mcp-config');

const T = { timeout: 5000 };
const ENTRY = C.serverEntry({ exe: 'C:\\Users\\u\\AppData\\Local\\Programs\\NaTsu\\NaTsu.exe', script: 'C:\\Users\\u\\AppData\\Local\\Programs\\NaTsu\\resources\\app\\src\\mcp\\server.js', dbDir: 'C:\\Users\\u\\AppData\\Roaming\\natsu\\data' });
const OTHERS = () => ({
  globalShortcut: 'Ctrl+Space',
  mcpServers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\docs'] },
    memory: { command: 'node', args: ['mem.js'], env: { K: 'v' } },
  },
  theme: 'dark',
});

test('MR8: serverEntry は command・args・env（ELECTRON_RUN_AS_NODE・NATSU_MCP・NATSU_DATA_DIR）', T, () => {
  assert.deepStrictEqual(ENTRY, {
    command: 'C:\\Users\\u\\AppData\\Local\\Programs\\NaTsu\\NaTsu.exe',
    args: ['C:\\Users\\u\\AppData\\Local\\Programs\\NaTsu\\resources\\app\\src\\mcp\\server.js'],
    env: { ELECTRON_RUN_AS_NODE: '1', NATSU_MCP: '1', NATSU_DATA_DIR: 'C:\\Users\\u\\AppData\\Roaming\\natsu\\data' },
  });
  assert.strictEqual(C.ENTRY_NAME, 'natsu');
  assert.strictEqual(C.MARK, 'NATSU_MCP');
});

test('F2・RF61: mergeEntry は、ほかの鍵（好みの設定）・mcpServers のほかの項目・鍵の並びをそのままにし、natsu だけを足す。受けた物を書き換えない', T, () => {
  const cfg = OTHERS();
  const before = JSON.stringify(cfg);
  const r = C.mergeEntry(cfg, ENTRY);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(JSON.stringify(cfg), before, '受けた物を書き換えた');
  assert.deepStrictEqual(Object.keys(r.config), ['globalShortcut', 'mcpServers', 'theme']);
  assert.deepStrictEqual(Object.keys(r.config.mcpServers), ['filesystem', 'memory', 'natsu']);
  assert.deepStrictEqual(r.config.mcpServers.filesystem, cfg.mcpServers.filesystem);
  assert.deepStrictEqual(r.config.mcpServers.memory, cfg.mcpServers.memory);
  assert.deepStrictEqual(r.config.mcpServers.natsu, ENTRY);
  assert.strictEqual(r.config.theme, 'dark');
  // mcpServers が無い設定には鍵を足す
  const bare = C.mergeEntry({ theme: 'light' }, ENTRY);
  assert.deepStrictEqual(bare.config, { theme: 'light', mcpServers: { natsu: ENTRY } });
});

test('F2: 同じ中身なら changed が偽。印のある古い natsu は替える（stale）・並びはそのまま。印の無い natsu は other で config を変えない', T, () => {
  const same = C.mergeEntry(C.mergeEntry(OTHERS(), ENTRY).config, ENTRY);
  assert.deepStrictEqual([same.ok, same.changed], [true, false]);
  const old = OTHERS();
  old.mcpServers = { natsu: { ...ENTRY, command: 'D:\\old\\NaTsu.exe' }, ...old.mcpServers };
  const r = C.mergeEntry(old, ENTRY);
  assert.deepStrictEqual([r.ok, r.changed], [true, true]);
  assert.deepStrictEqual(Object.keys(r.config.mcpServers), ['natsu', 'filesystem', 'memory']);
  assert.strictEqual(r.config.mcpServers.natsu.command, ENTRY.command);
  const taken = OTHERS();
  taken.mcpServers.natsu = { command: 'other.exe', args: [] };
  const t = C.mergeEntry(taken, ENTRY);
  assert.deepStrictEqual(t, { ok: false, code: 'other' });
  assert.strictEqual(taken.mcpServers.natsu.command, 'other.exe');
});

test('F2: 根が配列・文字・null、mcpServers が配列や文字 → shape', T, () => {
  for (const bad of [[], 'x', null, 3, { mcpServers: [] }, { mcpServers: 'x' }, { mcpServers: null }]) {
    assert.deepStrictEqual(C.mergeEntry(bad, ENTRY), { ok: false, code: 'shape' }, JSON.stringify(bad));
    assert.strictEqual(C.entryState(bad, ENTRY), 'shape', JSON.stringify(bad));
    assert.deepStrictEqual(C.removeEntry(bad), { ok: false, code: 'shape' }, JSON.stringify(bad));
  }
});

test('removeEntry は印のある natsu だけを消し、mcpServers の鍵は残す・印の無い natsu は消さない・受けた物を書き換えない', T, () => {
  const cfg = C.mergeEntry(OTHERS(), ENTRY).config;
  const before = JSON.stringify(cfg);
  const r = C.removeEntry(cfg);
  assert.deepStrictEqual([r.ok, r.changed], [true, true]);
  assert.strictEqual(JSON.stringify(cfg), before);
  assert.deepStrictEqual(Object.keys(r.config.mcpServers), ['filesystem', 'memory']);
  const only = C.removeEntry({ mcpServers: { natsu: ENTRY } });
  assert.deepStrictEqual(only.config, { mcpServers: {} });
  assert.deepStrictEqual(C.removeEntry({ theme: 'x' }), { ok: true, config: { theme: 'x' }, changed: false });
  const taken = { mcpServers: { natsu: { command: 'other.exe' } } };
  assert.deepStrictEqual(C.removeEntry(taken), { ok: false, code: 'other' });
});

test('entryState の表（none・same・stale（command・args・NATSU_DATA_DIR のどれが違っても）・other・shape）', T, () => {
  assert.strictEqual(C.entryState({}, ENTRY), 'none');
  assert.strictEqual(C.entryState({ mcpServers: {} }, ENTRY), 'none');
  assert.strictEqual(C.entryState({ mcpServers: { natsu: ENTRY } }, ENTRY), 'same');
  for (const change of [{ command: 'x.exe' }, { args: ['y.js'] }, { env: { ...ENTRY.env, NATSU_DATA_DIR: 'D:\\data' } }]) {
    assert.strictEqual(C.entryState({ mcpServers: { natsu: { ...ENTRY, ...change } } }, ENTRY), 'stale', JSON.stringify(change));
  }
  assert.strictEqual(C.entryState({ mcpServers: { natsu: { command: 'x' } } }, ENTRY), 'other');
  assert.strictEqual(C.entryState({ mcpServers: { natsu: { ...ENTRY, env: { NATSU_MCP: '0' } } } }, ENTRY), 'other');
  assert.strictEqual(C.entryState({ mcpServers: { natsu: 'x' } }, ENTRY), 'other');
});

// 0.10.1 CD-1 で意図して変えた（Ruling R2）: Packages の子も名前の小文字の順に並べる（決めたこと 7）ので、Anthropic.Claude_x9 が Claude_abc123 の前
test('configFiles: Claude のフォルダがあれば1つ目・Packages の下の Claude_ と Anthropic.Claude_ で LocalCache\\Roaming\\Claude があればそれも・どれも無ければ空', T, () => {
  const appData = path.join('/u', 'Roaming');
  const localAppData = path.join('/u', 'Local');
  const pk = path.join(localAppData, 'Packages');
  const have = new Set([path.join(appData, 'Claude'), path.join(pk, 'Claude_abc123', 'LocalCache', 'Roaming', 'Claude'), path.join(pk, 'Anthropic.Claude_x9', 'LocalCache', 'Roaming', 'Claude')]);
  const fsx = { exists: (p) => have.has(p), readdir: (d) => (d === pk ? ['Microsoft.Foo_1', 'Claude_abc123', 'Anthropic.Claude_x9', 'Claude_nofolder', 'NotClaude_1'] : []) };
  assert.deepStrictEqual(C.configFiles({ appData, localAppData, ...fsx }), [
    path.join(appData, 'Claude', 'claude_desktop_config.json'),
    path.join(pk, 'Anthropic.Claude_x9', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    path.join(pk, 'Claude_abc123', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'),
  ]);
  assert.deepStrictEqual(C.configFiles({ appData, localAppData, exists: () => false, readdir: () => { throw new Error('ENOENT'); } }), []);
  assert.deepStrictEqual(C.configFiles({ appData: '', localAppData: '', exists: () => true, readdir: () => ['Claude_1'] }), []);
});

test('backupName の形（時刻の : と . を - に）と、NaTsu の控えは新しい3つ', T, () => {
  assert.strictEqual(C.backupName('C:\\x\\claude_desktop_config.json', new Date('2026-10-23T01:02:03.456Z')), 'C:\\x\\claude_desktop_config.json.natsu-2026-10-23T01-02-03-456Z.bak');
  assert.strictEqual(C.BACKUP_KEEP, 3);
  assert.ok(C.isNatsuBackup('claude_desktop_config.json', 'claude_desktop_config.json.natsu-2026-10-23T01-02-03-456Z.bak'));
  assert.ok(!C.isNatsuBackup('claude_desktop_config.json', 'claude_desktop_config.json.bak'));
  assert.ok(!C.isNatsuBackup('claude_desktop_config.json', 'other.json.natsu-2026-10-23T01-02-03-456Z.bak'));
});

test('D75・決めたこと 149: claudeRunningOf の表（tasklist の答え → 動いている・動いていない・分からない）', T, () => {
  assert.strictEqual(C.claudeRunningOf('"claude.exe","1234","Console","1","123,456 K"\r\n'), true);
  assert.strictEqual(C.claudeRunningOf('"Claude.exe","1234","Console","1","1 K"\r\n"claude.exe","99","Console","1","1 K"'), true);
  assert.strictEqual(C.claudeRunningOf('INFO: No tasks are running which match the specified criteria.\r\n'), false);
  assert.strictEqual(C.claudeRunningOf('情報: 指定された条件に一致するタスクは実行されていません。\r\n'), false);
  assert.strictEqual(C.claudeRunningOf('"claude-helper.exe","1","Console","1","1 K"'), false);
  for (const v of ['', '   ', null, undefined, 3]) assert.strictEqual(C.claudeRunningOf(v), null, String(v));
});

// ---------------------------------------------------------------- 0.10.1 Task CD-1（計画 docs/plans/2026-10-23-101.md の決めたこと 1・6・7・12）
// 新しい Store 版の場所（%LOCALAPPDATA%\Claude-Data\claude_<符号>）も探す。偽の木: have はあるフォルダの集合、dirs は readdir の答え、files はファイル（フォルダでない）
const tree = ({ have = [], dirs = {}, files = [] }) => {
  const H = new Set(have);
  const F = new Set(files);
  return {
    exists: (p) => H.has(p) || F.has(p),
    isDir: (p) => H.has(p),
    readdir: (d) => { if (!Object.hasOwn(dirs, d)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return dirs[d].slice(); },
  };
};
const RO = path.join('/u', 'Roaming');
const LO = path.join('/u', 'Local');
const PK = path.join(LO, 'Packages');
const CD = path.join(LO, 'Claude-Data');
const msixDir = (n) => path.join(PK, n, 'LocalCache', 'Roaming', 'Claude');
const cfgIn = (dir) => path.join(dir, 'claude_desktop_config.json');
const kinds = (r) => r.map((p) => p.kind);

test('0.10.1 CD-1: configPlaces — 前の場所だけ・Claude-Data だけ（README.txt は場所にしない）・両方（持ち主の PC）', T, () => {
  const only = tree({ have: [msixDir('Claude_pzs8sxrjxfjjc')], dirs: { [PK]: ['Claude_pzs8sxrjxfjjc'] } });
  assert.deepStrictEqual(C.configPlaces({ appData: RO, localAppData: LO, ...only }), [{ file: cfgIn(msixDir('Claude_pzs8sxrjxfjjc')), kind: 'packages' }]);
  const data = tree({ have: [path.join(CD, 'claude_pzs8sxrjxfjjc')], files: [path.join(CD, 'README.txt')], dirs: { [CD]: ['README.txt', 'claude_pzs8sxrjxfjjc'] } });
  assert.deepStrictEqual(C.configPlaces({ appData: RO, localAppData: LO, ...data }), [{ file: cfgIn(path.join(CD, 'claude_pzs8sxrjxfjjc')), kind: 'data' }]);
  const both = tree({ have: [path.join(CD, 'claude_pzs8sxrjxfjjc'), msixDir('Claude_pzs8sxrjxfjjc')], dirs: { [CD]: ['claude_pzs8sxrjxfjjc'], [PK]: ['Claude_pzs8sxrjxfjjc'] } });
  assert.deepStrictEqual(C.configPlaces({ appData: RO, localAppData: LO, ...both }), [
    { file: cfgIn(path.join(CD, 'claude_pzs8sxrjxfjjc')), kind: 'data' },
    { file: cfgIn(msixDir('Claude_pzs8sxrjxfjjc')), kind: 'packages' },
  ]);
});

test('0.10.1 CD-1: configPlaces — Claude-Data に2つは名前の小文字の順・Roaming と Claude-Data は roaming → data', T, () => {
  const two = tree({ have: [path.join(CD, 'claude_zz9test0000aa'), path.join(CD, 'claude_pzs8sxrjxfjjc')], dirs: { [CD]: ['claude_zz9test0000aa', 'claude_pzs8sxrjxfjjc'] } });
  assert.deepStrictEqual(C.configPlaces({ appData: RO, localAppData: LO, ...two }).map((p) => p.file), [
    cfgIn(path.join(CD, 'claude_pzs8sxrjxfjjc')), cfgIn(path.join(CD, 'claude_zz9test0000aa')),
  ]);
  const rd = tree({ have: [path.join(RO, 'Claude'), path.join(CD, 'claude_pzs8sxrjxfjjc')], dirs: { [CD]: ['claude_pzs8sxrjxfjjc'] } });
  const r = C.configPlaces({ appData: RO, localAppData: LO, ...rd });
  assert.deepStrictEqual(kinds(r), ['roaming', 'data']);
  assert.strictEqual(r[0].file, cfgIn(path.join(RO, 'Claude')));
});

test('0.10.1 CD-1: configPlaces — 大文字の混ざった名前も見つけ、書く先は readdir の名前のまま（Packages も小文字で見つける）', T, () => {
  const mixed = tree({
    have: [path.join(CD, 'Claude_Pzs8sxrjxfjjc'), path.join(CD, 'CLAUDE_X1'), msixDir('claude_abc')],
    dirs: { [CD]: ['Claude_Pzs8sxrjxfjjc', 'CLAUDE_X1'], [PK]: ['claude_abc'] },
  });
  assert.deepStrictEqual(C.configPlaces({ appData: RO, localAppData: LO, ...mixed }), [
    { file: cfgIn(path.join(CD, 'Claude_Pzs8sxrjxfjjc')), kind: 'data' },
    { file: cfgIn(path.join(CD, 'CLAUDE_X1')), kind: 'data' },
    { file: cfgIn(msixDir('claude_abc')), kind: 'packages' },
  ]);
});

test('0.10.1 CD-1: configPlaces — 名前の形と種類（コピー・空の符号・拡張子・Claude・notclaude・ファイルは場所にしない。anthropic.claude_ は見つける）', T, () => {
  const names = ['claude_pzs8sxrjxfjjc - コピー', 'claude_', 'claude_x.old', 'Claude', 'anthropic.claude_9', 'notclaude_1', 'claude_file1', 'README.txt'];
  const t = tree({
    have: ['claude_pzs8sxrjxfjjc - コピー', 'claude_', 'claude_x.old', 'Claude', 'anthropic.claude_9', 'notclaude_1'].map((n) => path.join(CD, n)),
    files: ['claude_file1', 'README.txt'].map((n) => path.join(CD, n)),
    dirs: { [CD]: names },
  });
  assert.deepStrictEqual(C.configPlaces({ appData: RO, localAppData: LO, ...t }), [{ file: cfgIn(path.join(CD, 'anthropic.claude_9')), kind: 'data' }]);
});

test('0.10.1 CD-1: configPlaces — Claude-Data の readdir が投げる・名前が文字でない・localAppData が空でも投げず、その種類は空。isDir を渡さなければ exists', T, () => {
  const t = tree({ have: [msixDir('Claude_1')], dirs: { [PK]: ['Claude_1', 3, null] } });
  assert.deepStrictEqual(kinds(C.configPlaces({ appData: RO, localAppData: LO, ...t })), ['packages']);
  const odd = tree({ have: [path.join(CD, 'claude_a1')], dirs: { [CD]: [7, 'claude_a1'] } });
  assert.deepStrictEqual(kinds(C.configPlaces({ appData: RO, localAppData: LO, ...odd })), ['data']);
  assert.deepStrictEqual(C.configPlaces({ appData: '', localAppData: '', exists: () => true, isDir: () => true, readdir: () => ['claude_1'] }), []);
  const noIsDir = tree({ have: [path.join(CD, 'claude_a1')], dirs: { [CD]: ['claude_a1'] } });
  assert.deepStrictEqual(kinds(C.configPlaces({ appData: RO, localAppData: LO, exists: noIsDir.exists, readdir: noIsDir.readdir })), ['data']);
});

test('0.10.1 CD-1: placeCounts の表・configFiles は configPlaces の file の並びと同じ・DATA_ROOT', T, () => {
  assert.deepStrictEqual(C.placeCounts([]), { roaming: 0, data: 0, packages: 0 });
  assert.deepStrictEqual(C.placeCounts([{ kind: 'roaming' }, { kind: 'data' }, { kind: 'data' }, { kind: 'packages' }]), { roaming: 1, data: 2, packages: 1 });
  const both = tree({ have: [path.join(RO, 'Claude'), path.join(CD, 'claude_pzs8sxrjxfjjc'), msixDir('Claude_pzs8sxrjxfjjc')], dirs: { [CD]: ['claude_pzs8sxrjxfjjc'], [PK]: ['Claude_pzs8sxrjxfjjc'] } });
  const opts = { appData: RO, localAppData: LO, ...both };
  assert.deepStrictEqual(C.configFiles(opts), C.configPlaces(opts).map((p) => p.file));
  assert.strictEqual(C.DATA_ROOT, 'Claude-Data');
});
