/*
 * stage1c.ipc.test.js — 第1c回 Task C-2: 設定のカード「オンライン」の IPC（cloud:*・claude:*・meeting:set-local-only）を、
 * 偽の Electron の上で main.js を本当に動かして呼ぶ（helpers/mainrun.js の --json-scene=cloud-ipc）。
 * 外へはつながない（鍵の確かめは 127.0.0.1 の偽の送り先。fake-net は外の宛先で死ぬ）。本物の claude は探さない・起こさない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const KEY = 'gsk_test_0123456789';
const run = (args) => new Promise((resolve, reject) => {
  execFile(process.execPath, [RUN, ...args], { maxBuffer: 1 << 24, timeout: 20000 }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});

test('RF30・OL3・OL5・OL7: 設定のカード「オンライン」の IPC。鍵は画面へ返らず、記録・設定・secrets.json に鍵の文字が無い', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=cloud-ipc']);
  // 状態: 鍵の代わりに「しまってあるか」だけ。設定を開いただけでは外へ通信しない（online は net.isOnline() だけ）
  assert.deepStrictEqual(o.status0, { ok: true, consent: 'on', provider: { id: 'groq', label: 'Groq（無料枠）', host: 'api.groq.com' },
    hasKey: false, canStore: true, online: { up: true, why: 'ok' } });
  assert.strictEqual(o.badId.code, 'bad-id');
  assert.strictEqual(o.badKey.code, 'bad-key');
  assert.ok(typeof o.badKey.message === 'string' && o.badKey.message.length > 5, '断ったときの文が無い');
  assert.deepStrictEqual(o.set, { ok: true });
  assert.strictEqual(o.status1.hasKey, true);
  assert.ok(o.secretsAfterSet.includes('"groq"') && !o.secretsAfterSet.includes(KEY), 'secrets.json に鍵が平文で入った');
  // 鍵の確かめ: URL が無い・鍵が無い・正しい鍵（前後の空白は落とす）・違う鍵
  assert.strictEqual(o.testNoBase.code, 'bad-base');
  assert.strictEqual(o.saved.ok, true);
  assert.strictEqual(o.testNoKey.code, 'no-key');
  assert.deepStrictEqual(o.setCustom, { ok: true });
  assert.deepStrictEqual(o.testOk, { ok: true });
  assert.deepStrictEqual(o.setWrong, { ok: true });
  assert.strictEqual(o.testAuth.code, 'auth');
  assert.match(o.testAuth.message, /^そのほか: 鍵が正しくないか、使えなくなっています。$/);
  assert.deepStrictEqual(o.seen, [{ method: 'GET', url: '/v1/models', auth: true }, { method: 'GET', url: '/v1/models', auth: false }]);
  assert.strictEqual(o.statusCustom.provider.id, 'custom');
  assert.strictEqual(o.statusCustom.provider.host, '127.0.0.1');
  assert.strictEqual(o.statusCustom.hasKey, true);
  assert.deepStrictEqual(o.clear, { ok: true });
  assert.strictEqual(o.statusCleared.hasKey, false);
  // Claude Code: 場所が無いファイルなら子を起こさず、入れ方の文（S1）を返す。-p は呼ばない
  for (const c of [o.claude, o.claudeTest]) {
    assert.deepStrictEqual({ ...c, message: '' }, { ok: true, found: false, cmdOnly: false, method: '', message: '' });
    assert.match(c.message, /^Claude Code が見つからないため/);
  }
  assert.strictEqual(o.spawns.length, 0, '子のプロセスを起こした');
  // ［この会議は PC の中だけ］: 会議の外では何もしない。false（送る側に戻す）は受け取らない
  assert.deepStrictEqual(o.localOnlyTrue, { ok: false });
  assert.deepStrictEqual(o.localOnlyFalse, { ok: false, localOnly: false });
  // 鍵の文字は、返事・設定・記録のどこにも無い（記録は送り先の名前と符号だけ）
  const blob = JSON.stringify([o.status0, o.status1, o.statusCustom, o.statusCleared, o.badId, o.badKey, o.set, o.setCustom, o.testOk, o.testAuth, o.testNoKey,
    o.settingsText, o.engineLog, o.notices]);
  assert.ok(!blob.includes(KEY) && !blob.includes('gsk_wrong'), '鍵の文字が返事・設定・記録・知らせのどこかにある');
  assert.ok(o.engineLog.some((l) => l.includes('groq の鍵を保存しました')) && o.engineLog.some((l) => l.includes('custom の鍵の確かめ → auth')));
});
