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
    // 設定の画面の文: 入れ方を示し、議事録の［要約を生成］へは誘わない（要約の失敗の文をそのまま出さない）
    assert.match(c.message, /^Claude Code が見つかりません。PowerShell で `irm https:\/\/claude\.ai\/install\.ps1 \| iex` を実行して入れ/);
    assert.ok(!/要約を生成|要約を作れませんでした/.test(c.message), `設定の画面に要約の失敗の文が出る: ${c.message}`);
    assert.match(c.message, /「Claude Code の場所」に入れたファイルが見つからないときは、場所を空にすると自動で探します。$/);
  }
  assert.strictEqual(o.spawns.length, 0, '子のプロセスを起こした');
  // ［この会議は PC の中だけ］: 会議の外では何もしない。false（送る側に戻す）は受け取らない
  assert.deepStrictEqual(o.localOnlyTrue, { ok: false, localOnly: false });
  assert.deepStrictEqual(o.localOnlyFalse, { ok: false, localOnly: false });
  // 鍵の文字は、返事・設定・記録のどこにも無い（記録は送り先の名前と符号だけ）
  const blob = JSON.stringify([o.status0, o.status1, o.statusCustom, o.statusCleared, o.badId, o.badKey, o.set, o.setCustom, o.testOk, o.testAuth, o.testNoKey,
    o.settingsText, o.engineLog, o.notices]);
  assert.ok(!blob.includes(KEY) && !blob.includes('gsk_wrong'), '鍵の文字が返事・設定・記録・知らせのどこかにある');
  assert.ok(o.engineLog.some((l) => l.includes('groq の鍵を保存しました')) && o.engineLog.some((l) => l.includes('custom の鍵の確かめ → auth')));
});

test('RF28: ［この会議は PC の中だけ］の IPC は片道。会議中に true の後で false が来ても PC の中だけのまま（下書きにも残る）。会議の外は { ok:false, localOnly:false }', { timeout: 30000 }, async () => {
  const o = await run(['text', '--json-scene=local-only-ipc']);
  // 会議の外: どちらの値でも何もせず、計画の表の形 { ok, localOnly } で返す
  assert.deepStrictEqual(o.idleTrue, { ok: false, localOnly: false });
  assert.deepStrictEqual(o.idleFalse, { ok: false, localOnly: false });
  assert.strictEqual(o.start.ok, true, `会議を始められない: ${JSON.stringify(o.start)}`);
  assert.strictEqual(o.draftAtStart, false);
  // 押す前の false は何も変えない（送る側のまま。下書きも false のまま）
  assert.deepStrictEqual(o.falseBefore, { ok: false, localOnly: false });
  assert.strictEqual(o.draftAfterFalseBefore, false);
  assert.deepStrictEqual(o.on, { ok: true, localOnly: true });
  assert.strictEqual(o.draftAfterOn, true);
  // 押した後の false（押し間違い・古い画面）は断り、PC の中だけのまま。下書き（落ちた後の送り直し）も true のまま
  assert.deepStrictEqual(o.off, { ok: false, localOnly: true });
  assert.deepStrictEqual(o.offAgain, { ok: false, localOnly: true });
  assert.strictEqual(o.draftAfterOff, true);
  assert.ok(o.engineLog.some((l) => l.includes('この会議は PC の中だけ: on')));
  assert.ok(!o.engineLog.some((l) => l.includes('この会議は PC の中だけ: off')), '会議の印が送る側に戻った');
  assert.deepStrictEqual(o.discard, { ok: true });
});
