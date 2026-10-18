/*
 * update-info.test.js — 入れ直しが要る版を、確かめた時点で見分ける（第0c回 EL4・C2）
 * release.yml がリリースに natsu-update.json を添え、check() がそれを今の Electron と比べる。
 * 文とボタンは updater.updateNotice の 1 か所で決め、設定の画面・起動時の知らせ・トレイが同じものを出す。
 * テスト用の取得先（NATSU_UPDATE_FEED）は知らせを作るだけで、apply() は何も落とさずに断る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const updater = require('../src/updater');
const { buildUpdateInfo } = require('../tools/update-info');
const { packerAvailable, packRelease } = require('./helpers/pack');

const CAN_PACK = packerAvailable();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-入れ直し𠮷-'));
// updater.js の写し（API_LATEST だけ差し替えたもの）が読む部品を、写しの隣に置く（第1a回 JS5 で updater が jsonfile を読む）
fs.copyFileSync(path.join(ROOT, 'src', 'jsonfile.js'), path.join(work, 'jsonfile.js'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ZIP = Buffer.from('natsu-src のつもりの中身');
const INFO44 = buildUpdateInfo({ pkg: { version: '0.4.0', engines: { electron: '>=44.9.0' } }, zipName: 'natsu-src-0.4.0.zip', zipBytes: ZIP });

test('update-info: package.json と zip から natsu-update.json を作り、updater がそのまま読める', () => {
  assert.deepStrictEqual(INFO44, { schema: 1, version: '0.4.0', electron: '>=44.9.0', zip: 'natsu-src-0.4.0.zip', sha256: sha(ZIP), size: ZIP.length });
  assert.deepStrictEqual(updater.parseUpdateInfo(JSON.stringify(INFO44), { version: '0.4.0', zipName: 'natsu-src-0.4.0.zip' }),
    { version: '0.4.0', electron: '>=44.9.0', zip: 'natsu-src-0.4.0.zip', sha256: sha(ZIP), size: ZIP.length });
  assert.throws(() => buildUpdateInfo({ pkg: { version: '0.4.0' }, zipName: 'z.zip', zipBytes: ZIP }), /engines\.electron/);
  assert.throws(() => buildUpdateInfo({ pkg: { version: '0.4', engines: { electron: '>=44.9.0' } }, zipName: 'z.zip', zipBytes: ZIP }), /version/);
  assert.throws(() => buildUpdateInfo({ pkg: { version: '0.4.0', engines: { electron: '>=44.9.0' } }, zipName: 'z.zip', zipBytes: Buffer.alloc(0) }), /空/);
});

test('update-info: コマンドとして zip のパスを渡すと、今の package.json の版と engines.electron で JSON を出す', () => {
  const zip = path.join(work, 'x.zip');
  fs.writeFileSync(zip, ZIP);
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'update-info.js'), zip], { cwd: ROOT, encoding: 'utf8' });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const o = JSON.parse(out);
  assert.strictEqual(o.version, pkg.version);
  assert.strictEqual(o.electron, pkg.engines.electron);
  assert.strictEqual(o.zip, 'x.zip');
  assert.strictEqual(o.sha256, sha(ZIP));
  assert.ok(out.endsWith('\n'));
  assert.match(fs.readFileSync(path.join(ROOT, 'tools', 'update-info.js'), 'utf8'), /if \(require\.main === module\)/, 'require されただけでコマンドとして走る');
});

test('parseUpdateInfo: 形の違い・版の違い・zip の名前の違いを断る（入れ直しの判断を当て推量にしない）', () => {
  const ok = JSON.stringify(INFO44);
  for (const [bad, re] of [['{', /読めません/], [JSON.stringify({ ...INFO44, schema: 2 }), /schema/], [JSON.stringify({ ...INFO44, electron: '>=44' }), /electron/],
    [JSON.stringify({ ...INFO44, sha256: 'x' }), /SHA-256/], [JSON.stringify({ ...INFO44, size: 0 }), /大きさ/], [JSON.stringify({ ...INFO44, version: '0.4' }), /版/]]) {
    assert.throws(() => updater.parseUpdateInfo(bad), re, bad);
  }
  assert.throws(() => updater.parseUpdateInfo(ok, { version: '0.5.0' }), /合いません/);
  assert.throws(() => updater.parseUpdateInfo(ok, { zipName: 'natsu-src-0.5.0.zip' }), /合いません/);
  assert.strictEqual(updater.parseUpdateInfo('\uFEFF' + ok).version, '0.4.0', 'BOM 付きで読めない');
});

test('needsReinstall: 今の Electron が範囲を満たさないときだけ真。情報が無い・版が取れないときは偽（apply の門に任せる）', () => {
  const info = { electron: '>=44.9.0' };
  assert.strictEqual(updater.needsReinstall(info, '31.7.7'), true);
  assert.strictEqual(updater.needsReinstall(info, '44.9.0'), false);
  assert.strictEqual(updater.needsReinstall(info, '44.10.0'), false);
  assert.strictEqual(updater.needsReinstall(null, '31.7.7'), false);
  assert.strictEqual(updater.needsReinstall(info, undefined), false);
});

test('updateNotice: 3 か所で出す文とボタンを 1 か所で決める。入れ直しの文に「Electron」の語を出さない', () => {
  const N = updater.updateNotice;
  const R = updater.REINSTALL_MESSAGE;
  assert.strictEqual(R, 'この版はアプリの土台を入れ替えるため、インストーラーで入れ直してください。議事録・設定・エンジンはそのまま残ります。');
  assert.ok(!/Electron/.test(R));
  assert.deepStrictEqual(N({ ok: true, update: false }), { action: 'latest', message: '', button: '' });
  assert.deepStrictEqual(N({ ok: false, error: 'x' }), { action: 'latest', message: '', button: '' });
  assert.deepStrictEqual(N({ ok: true, update: true }, { ok: true }), { action: 'apply', message: '', button: '更新して再起動' });
  assert.deepStrictEqual(N({ ok: true, update: true, reinstall: true }, { ok: true }), { action: 'download', message: R, button: 'ダウンロード' });
  assert.strictEqual(N({ ok: true, update: true, reinstall: true }, { ok: false, error: '書き込めない' }).message, R);
  assert.deepStrictEqual(N({ ok: true, update: true }, { ok: false, error: '書き込めない' }), { action: 'download', message: '書き込めない', button: 'ダウンロード' });
  const t = N({ ok: true, update: true, test: true }, { ok: true });
  assert.strictEqual(t.action, 'download');
  assert.match(t.message, /テスト用の取得先/);
  assert.strictEqual(N({ ok: true, update: true, test: true, reinstall: true }, { ok: true }).message, R, 'テスト用の取得先でも入れ直しの文を見せる（実機の確かめのため）');
});

test('readFeed: 空なら決まった取得先。手元のファイル・owner/repo はテスト用。それ以外は読めないとして止める', () => {
  const f = path.join(work, 'natsu-update.json');
  fs.writeFileSync(f, JSON.stringify(INFO44));
  assert.deepStrictEqual(updater.readFeed({}), { kind: 'default', api: `https://api.github.com/repos/${updater.REPO}/releases/latest`, test: false });
  assert.deepStrictEqual(updater.readFeed({ NATSU_UPDATE_FEED: f }), { kind: 'file', file: f, test: true });
  assert.deepStrictEqual(updater.readFeed({ NATSU_UPDATE_FEED: 'test-owner/natsu-feed' }),
    { kind: 'repo', api: 'https://api.github.com/repos/test-owner/natsu-feed/releases/latest', test: true });
  const bad = updater.readFeed({ NATSU_UPDATE_FEED: 'https://example.invalid/x' });
  assert.strictEqual(bad.kind, 'bad');
  assert.match(bad.error, /NATSU_UPDATE_FEED/);
});

test('check(): リリースの natsu-update.json を読み、今の Electron で入れ直しが要るかを返す', async (t) => {
  let port = 0;
  const info = (o) => JSON.stringify({ ...INFO44, ...o });
  const server = http.createServer((req, res) => {
    const zipA = { name: 'natsu-src-0.4.0.zip', browser_download_url: `http://127.0.0.1:${port}/z.zip`, size: ZIP.length };
    const infoA = (p) => ({ name: 'natsu-update.json', browser_download_url: `http://127.0.0.1:${port}${p}`, size: 120 });
    const rel = (assets) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ tag_name: 'natsu-v0.4.0', body: '本文', assets })); };
    if (req.url === '/with-info') return rel([zipA, infoA('/info.json')]);
    if (req.url === '/no-info') return rel([zipA]);
    if (req.url === '/bad-info') return rel([zipA, infoA('/info-bad.json')]);
    if (req.url === '/gone-info') return rel([zipA, infoA('/info-gone.json')]);
    if (req.url === '/info.json') { res.writeHead(200); return res.end(info({})); }
    if (req.url === '/info-bad.json') { res.writeHead(200); return res.end(info({ version: '0.3.9' })); }
    res.writeHead(404); return res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  t.after(() => server.close());
  // API_LATEST だけ差し替えた写しを読む（updater.test.js と同じやり方）
  const stub = (route) => {
    const f = path.join(work, `updater-${route.slice(1)}.js`);
    fs.writeFileSync(f, fs.readFileSync(path.join(ROOT, 'src', 'updater.js'), 'utf8')
      .replace(/const API_LATEST = [^\n]+/, `const API_LATEST = 'http://127.0.0.1:${port}${route}';`));
    delete require.cache[require.resolve(f)];
    return require(f);
  };
  const env = {};
  const on31 = await stub('/with-info').check('0.3.0', work, { electronVersion: '31.7.7', env });
  assert.strictEqual(on31.ok, true, on31.error);
  assert.strictEqual(on31.update, true);
  assert.strictEqual(on31.reinstall, true);
  assert.strictEqual(on31.requires, '>=44.9.0');
  assert.strictEqual(on31.sha256, sha(ZIP));
  assert.strictEqual(on31.test, false);
  assert.strictEqual((await stub('/with-info').check('0.3.0', work, { electronVersion: '44.9.0', env })).reinstall, false);
  const same = await stub('/with-info').check('0.4.0', work, { electronVersion: '31.7.7', env });
  assert.strictEqual(same.update, false);
  assert.strictEqual(same.reinstall, false, '新しくない版で入れ直しを促している');
  const old = await stub('/no-info').check('0.3.0', work, { electronVersion: '31.7.7', env });
  assert.strictEqual(old.ok, true, old.error);
  assert.strictEqual(old.reinstall, false, 'natsu-update.json の無い古いリリースで入れ直しを促している（apply の門に任せる）');
  const bad = await stub('/bad-info').check('0.3.0', work, { electronVersion: '31.7.7', env });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /natsu-update\.json/);
  assert.ok(!bad.offline);
  const gone = await stub('/gone-info').check('0.3.0', work, { electronVersion: '31.7.7', env });
  assert.strictEqual(gone.ok, false);
  assert.match(gone.error, /natsu-update\.json を取得できません/);
  assert.match(gone.error, /［更新を確認］からやり直してください$/, '利用者がすることを1つで終えていない');
});

test('check(): テスト用の取得先（手元の natsu-update.json）では、知らせを作るだけで zip の URL を持たない', async () => {
  const f = path.join(work, 'feed-natsu-update.json');
  fs.writeFileSync(f, JSON.stringify(INFO44));
  const r = await updater.check('0.3.0', work, { electronVersion: '31.7.7', env: { NATSU_UPDATE_FEED: f } });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.update, true);
  assert.strictEqual(r.reinstall, true);
  assert.strictEqual(r.test, true);
  assert.strictEqual(r.url, '');
  assert.strictEqual(updater.updateNotice(r, { ok: true }).message, updater.REINSTALL_MESSAGE);
  const same = await updater.check('0.4.0', work, { electronVersion: '31.7.7', env: { NATSU_UPDATE_FEED: f } });
  assert.strictEqual(same.update, false);
  assert.strictEqual(same.reinstall, false, '新しくない版で入れ直しを促している');
  const b = await updater.check('0.3.0', work, { electronVersion: '31.7.7', env: { NATSU_UPDATE_FEED: 'これは読めない' } });
  assert.strictEqual(b.ok, false);
  assert.match(b.error, /NATSU_UPDATE_FEED/);
});

test('apply(): テスト用の取得先があるあいだは、何も落とさず当てない', async (t) => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits += 1; res.writeHead(500); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const appRoot = path.join(work, 'app-feed');
  fs.mkdirSync(path.join(appRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'src', 'main.js'), '// 旧版');
  const r = await updater.apply(`http://127.0.0.1:${server.address().port}/z.zip`, appRoot, work, () => {},
    { electronVersion: '31.7.7', env: { NATSU_UPDATE_FEED: 'test-owner/natsu-feed' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /テスト用の取得先/);
  assert.strictEqual(hits, 0, '取得先がテスト用なのに zip を落とした');
  assert.strictEqual(fs.readFileSync(path.join(appRoot, 'src', 'main.js'), 'utf8'), '// 旧版');
});

test('apply(): natsu-update.json の SHA-256 と違う zip は当てない', { skip: !CAN_PACK && 'zip コマンドが無い' }, async (t) => {
  const zip = fs.readFileSync(packRelease(ROOT, work, '0.9.0'));
  const server = http.createServer((req, res) => { res.writeHead(200); res.end(zip); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/z.zip`;
  const mk = (n) => {
    const a = path.join(work, n);
    fs.mkdirSync(path.join(a, 'src'), { recursive: true });
    fs.writeFileSync(path.join(a, 'src', 'main.js'), '// 旧版');
    fs.writeFileSync(path.join(a, 'package.json'), JSON.stringify({ name: 'natsu', version: '0.3.0' }));
    return a;
  };
  const a1 = mk('app-sha-ng');
  const r1 = await updater.apply(url, a1, work, () => {}, { electronVersion: '44.9.0', env: {}, sha256: '0'.repeat(64) });
  assert.strictEqual(r1.ok, false);
  assert.match(r1.error, /SHA-256/);
  assert.strictEqual(fs.readFileSync(path.join(a1, 'src', 'main.js'), 'utf8'), '// 旧版');
  const r2 = await updater.apply(url, mk('app-sha-ok'), work, () => {}, { electronVersion: '44.9.0', env: {}, sha256: sha(zip) });
  assert.strictEqual(r2.ok, true, r2.error);
});
