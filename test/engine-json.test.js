/*
 * engine-json.test.js — 自動更新の package.json・installed.json・取り込みの記録の読み書き（第1a回 JS5・JS2）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updater = require('../src/updater');
const I = require('../src/engine-install');
const F = require('../src/engine-fetch');
const J = require('../src/jsonfile');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-取込𠮷-ej-'));
const brokenOf = (d, base) => fs.readdirSync(d).filter((n) => n.startsWith(`${base}.broken-`));

test('JS5: 自動更新は UTF-16 の package.json も読んで版を上げ、ほかの欄はそのまま、BOM なしの UTF-8 で書く', { timeout: 5000 }, () => {
  const app = tmp(); const ud = tmp();
  const pkg = { name: 'natsu', version: '0.3.0', engines: { electron: '>=44.9.0' }, main: 'src/main.js' };
  fs.writeFileSync(path.join(app, 'package.json'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(pkg), 'utf16le')]));
  assert.strictEqual(updater.bumpVersion(app, '0.4.0', ud), true);
  const text = fs.readFileSync(path.join(app, 'package.json'), 'utf8');
  assert.notStrictEqual(text.charCodeAt(0), 0xfeff);
  assert.deepStrictEqual(JSON.parse(text), { ...pkg, version: '0.4.0' });
  assert.deepStrictEqual(fs.readdirSync(app), ['package.json']);
});

test('JS5: 壊れた・読めない package.json は動かさず消さず、版の書き換えを飛ばして update.log に1行書く', { timeout: 5000 }, () => {
  const app = tmp(); const ud = tmp();
  const f = path.join(app, 'package.json');
  fs.writeFileSync(f, '{"name":"natsu","vers');
  assert.strictEqual(updater.bumpVersion(app, '0.4.0', ud), false);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"name":"natsu","vers');
  assert.deepStrictEqual(brokenOf(app, 'package.json'), [], 'package.json を退けた（アプリが起動できなくなる）');
  assert.match(fs.readFileSync(path.join(ud, 'update.log'), 'utf8'), /package\.json version update skipped: broken/);
  const orig = J.writeJsonFile;
  fs.writeFileSync(f, '{"name":"natsu","version":"0.3.0"}');
  J.writeJsonFile = () => { throw Object.assign(new Error('x'), { code: 'EBUSY' }); };
  try { assert.strictEqual(updater.bumpVersion(app, '0.4.0', ud), false); } finally { J.writeJsonFile = orig; }
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"name":"natsu","version":"0.3.0"}');
});

test('JS5: apply() は版の書き換えを bumpVersion に任せる（直書きしない）', { timeout: 5000 }, () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'updater.js'), 'utf8');
  assert.ok(src.includes('bumpVersion(appRoot, nxt.version, userDataPath)'));
  assert.ok(!/fs\.writeFileSync\([^)]*package\.json/.test(src), 'package.json を直書きしている');
});

test('JS2: 壊れた installed.json は退けて空の記録。控えは新しい3つまで。知らない schema は今どおり退けない', { timeout: 5000 }, () => {
  const d = tmp(); const f = path.join(d, 'installed.json');
  for (let i = 1; i <= 4; i += 1) fs.writeFileSync(`${f}.broken-2026-09-0${i}T00-00-00-000Z`, 'old');
  fs.writeFileSync(f, '{"schema":1,"items":');
  assert.deepStrictEqual(I.readInstalled(f).items, {});
  assert.ok(!fs.existsSync(f));
  assert.strictEqual(brokenOf(d, 'installed.json').length, 3);
  fs.writeFileSync(f, JSON.stringify({ schema: 99, items: { x: {} } }));
  assert.deepStrictEqual(I.readInstalled(f).items, {});
  assert.ok(fs.existsSync(f), '知らない schema の記録を退けた（新しい版の記録かもしれない）');
});

test('RF22: 読めない installed.json には書かない（同意や使っている組を空の記録で上書きしない）', { timeout: 5000 }, () => {
  const d = tmp(); const f = path.join(d, 'installed.json');
  I.writeInstalled(f, { ...I.readInstalled(f), consent: true });
  const before = fs.readFileSync(f);
  const orig = J.readJsonFile;
  J.readJsonFile = (p, o) => (p === f ? { state: 'unreadable', code: 'EBUSY' } : orig(p, o));
  try { assert.throws(() => I.writeInstalled(f, { consent: false, items: {} }), (e) => e.code === 'EBUSY'); } finally { J.readJsonFile = orig; }
  assert.ok(fs.readFileSync(f).equals(before));
});

test('RF22: 読めなかったときの空の記録（印 unreadable）は、書くときに読めるようになっていても書かない', { timeout: 5000 }, () => {
  const d = tmp(); const f = path.join(d, 'installed.json');
  I.writeInstalled(f, { ...I.readInstalled(f), consent: true });
  const before = fs.readFileSync(f);
  const orig = J.loadJsonFile;
  J.loadJsonFile = (p, o) => (p === f ? { state: 'unreadable', code: 'EBUSY' } : orig(p, o));
  let inst;
  try { inst = I.readInstalled(f); } finally { J.loadJsonFile = orig; }
  assert.strictEqual(inst.unreadable, true);
  assert.ok(!Object.keys(inst).includes('unreadable'), '印が列挙される（記録に書かれてしまう）');
  inst.items.x = { id: 'x' };
  assert.throws(() => I.writeInstalled(f, inst), (e) => e.code === 'EBUSY');
  assert.ok(fs.readFileSync(f).equals(before));
});

test('JS5・JS2: 取り込みの記録（.download\\<SHA-256>.json）は部品で書き、壊れていたら退けて null（控えは3つまで）', { timeout: 5000 }, () => {
  const d = tmp(); const f = path.join(d, `${'a'.repeat(64)}.json`);
  F.writeRecord(f, { url: 'https://example.invalid/x', size: 10, sha256: 'a'.repeat(64), synced: 4 });
  assert.deepStrictEqual(F.readRecord(f), { url: 'https://example.invalid/x', size: 10, sha256: 'a'.repeat(64), synced: 4 });
  for (let i = 1; i <= 4; i += 1) fs.writeFileSync(`${f}.broken-2026-09-0${i}T00-00-00-000Z`, 'old');
  fs.writeFileSync(f, '{"url":');
  assert.strictEqual(F.readRecord(f), null);
  assert.strictEqual(brokenOf(d, path.basename(f)).length, 3);
  assert.deepStrictEqual(fs.readdirSync(d).filter((n) => n.endsWith('.tmp')), []);
});
