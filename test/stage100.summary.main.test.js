/*
 * stage100.summary.main.test.js — 0.10.0 Task LS-2（D59・D63・D69・決めたこと 103〜105・111。計画 docs/plans/2026-10-20-100.md）:
 * 要約はいつも Claude Code（オフラインモードの会議も）。届かないときは要約待ち（summaryWait）にし、つながったら見回りで自動で1回作る。
 * 要約の欄の鍵は DB の命令も見る（locked）。手元の llama の要約の道は無い。
 * 前半は DB の命令（本物の core と commands を一時の DB で）、後半は main を偽の Electron の上で本当に動かす（helpers/mainrun.js）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { tmpDb, samplePage } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const NOW = () => new Date('2026-10-23T01:02:03.000Z');
let n = 0;
const call = (db, cmd, args, role = 'app') => core.call(db, { role, cmd, args, tx: `${role[0]}:ls2-${String(++n).padStart(6, '0')}` }, { now: NOW, labels: {} });
const WAIT = '要約待ち（つながったら作ります）';

// 要約の欄を直す命令（block.update・block.insert・block.remove・block.move・block.setAction）を1つずつ試す → [ok, code] の並び
function tryEdits(db, pageId, blockId) {
  const cmds = [
    ['block.update', { pageId, blockId, patch: { text: '画面で直した行の文' } }],
    ['block.insert', { pageId, afterBlockId: blockId || '', type: 'bullet' }],
    ['block.move', { pageId, blockId, toIndex: 0 }],
    ['block.setAction', { pageId, blockId, assignee: '担当Z', dueRaw: '' }],
    ['block.remove', { pageId, blockId }],
    // 0.13.0 ED-2（計画 docs/plans/2026-10-24-130.md の決めたこと 12）で意図して足した: 要約の編集の新しい命令も鍵で断る
    ['block.split', { pageId, blockId, text: '分ける文', at: 1 }],
    ['block.merge', { pageId, blockId, text: 'つなぐ文' }],
    ['block.turnInto', { pageId, blockId, type: 'numbered' }],
    ['block.duplicate', { pageId, blockId }],
    ['block.move', { pageId, blockId, afterId: '' }],
  ];
  return cmds.map(([cmd, args]) => { const r = call(db, cmd, args); return [cmd, r.ok ? 'ok' : r.code]; });
}
const allLocked = (rows) => rows.every(([, c]) => c === 'locked');

function seedPage(t, id, patch, segs) {
  const { page, segments } = samplePage(id);
  t.seed({ ...page, ...patch }, segs === undefined ? segments : segs);
}

test('D63・D69・O8: 要約待ち・まだ要約を作っていない・文字起こしが空のページは、DB の要約の欄の命令が locked で断る。メモと題名は直せる', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    seedPage(t, 'pw1', { summaryWait: true, summaryError: WAIT });                              // 3 要約待ち（要約があっても）
    seedPage(t, 'pn1', { blocks: [], route: { stt: { cloud: 1, local: 0, provider: 'openai' } } });   // 7 まだ作っていない
    seedPage(t, 'pe1', { blocks: [], route: {} }, [{ id: 's1', atMs: 0, durationMs: 1000, text: '（認識に失敗）', failed: true }]);   // 6 空
    for (const id of ['pw1', 'pn1', 'pe1']) {
      const rows = tryEdits(db, id, id === 'pw1' ? 'b2' : 'bx1');
      assert.ok(allLocked(rows), `${id}: ${JSON.stringify(rows)}`);
      assert.strictEqual(call(db, 'page.setMemo', { id, memo: 'メモは書ける' }).ok, true, `${id} のメモを直せない`);
      // 利用者が付け直した題名（D77）
      assert.strictEqual(call(db, 'page.setTitle', { id, title: '直した題名' }).ok, true);
    }
    // 断った命令は何も変えていない
    assert.strictEqual(call(db, 'page.get', { id: 'pw1' }).result.page.blocks.length, 6);
  } finally { t.done(); }
});

test('D63・O8: 録音中の写しのページは要約の欄の命令が locked', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    assert.strictEqual(call(db, 'meeting.begin', { pageId: 'pl1', startedAt: Date.parse('2026-10-23T01:00:00.000Z') }, 'main').ok, true);
    assert.ok(allLocked(tryEdits(db, 'pl1', 'bx1')), '録音中のページの要約の欄を直せた');
    // 録音中の写しに理由の文がある形（表の 5 より 1 が先）でも鍵のまま
    const p = call(db, 'page.get', { id: 'pl1' }, 'main').result.page;
    assert.strictEqual(call(db, 'page.put', { page: { ...p, summaryError: '前の理由の文' }, baseRev: p.rev }, 'main').ok, true);
    assert.strictEqual(call(db, 'page.get', { id: 'pl1' }, 'main').result.page.meeting.phase, 'recording', '場面の前提: 写しのまま');
    assert.ok(allLocked(tryEdits(db, 'pl1', 'bx1')), '理由の文のある録音中のページの要約の欄を直せた');
  } finally { t.done(); }
});

test('決めたこと 111 の 4・5: 要約ができたページ・Claude Code が断ったページは直せる。要約ができた後にブロックを全部消しても直せる。要約の保存（page.put）は鍵を見ない', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    seedPage(t, 'pm1', {});
    seedPage(t, 'pr1', { blocks: [], summaryError: 'Claude Code のログインが切れています。設定の［Claude Code にログイン］を押してください。' });
    seedPage(t, 'pw2', { blocks: [], summaryWait: true, summaryError: WAIT });
    for (const id of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']) assert.strictEqual(call(db, 'block.remove', { pageId: 'pm1', blockId: id }).ok, true, id);
    assert.strictEqual(call(db, 'page.get', { id: 'pm1' }).result.page.blocks.length, 0);
    const ins = call(db, 'block.insert', { pageId: 'pm1', afterBlockId: '', type: 'bullet' });
    assert.strictEqual(ins.ok, true, `要約ができた後にブロックを全部消すと鍵がまたかかった: ${ins.code}`);
    assert.strictEqual(call(db, 'block.insert', { pageId: 'pr1', afterBlockId: '', type: 'bullet' }).ok, true, 'Claude Code が断ったページの鍵が外れていない');
    // 要約待ちのページへ、つながった後の要約を保存する（main の saveIfExists と同じ page.put）。保存の命令は鍵を見ない
    const p = call(db, 'page.get', { id: 'pw2' }, 'main').result.page;
    const put = call(db, 'page.put', { page: { ...p, summaryWait: false, summaryError: '', blocks: [{ id: 'bz1', type: 'bullet', text: '自動で作った要約の行', cites: [] }],
      route: { ...(p.route || {}), summary: { by: 'claude-code', at: NOW().toISOString() } } }, baseRev: p.rev }, 'main');
    assert.strictEqual(put.ok, true, `要約の保存が鍵で断られた: ${put.code}`);
    assert.strictEqual(call(db, 'block.update', { pageId: 'pw2', blockId: 'bz1', patch: { text: '直した' } }).ok, true, '要約ができたのに直せない');
  } finally { t.done(); }
});

// ---------------------------------------------------------------- main（偽の Electron の上）
const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const llamaSpawned = (o) => o.spawns.some((s) => /fake-llama\.js$/.test(s.cmd));
const pCalls = (o) => o.claude.filter((l) => l.kind === 'p');
const textOf = (x) => (typeof x === 'string' ? x : (x && typeof x.text === 'string' ? x.text : ''));
// どの場面でも、手元の llama を起こさず、要約のエンジンの記録が無い
function noLocalSummary(o) {
  assert.strictEqual(llamaSpawned(o), false, '手元の llama を起こした');
  assert.ok(!o.engineLog.some((l) => /要約エンジン|要約のエンジン/.test(l)), o.engineLog.filter((l) => /要約/.test(l)).join('\n'));
}

test('D59: オフラインモードの会議の要約も Claude Code で作る（偽の claude が呼ばれ、手元の llama は起こされない）', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--relay=text', '--local-only', '--sum', '--claude=ok', '--segs=2']);
  assert.strictEqual(pCalls(o).length, 1, 'オフラインモードの会議で Claude Code を呼ばなかった');
  assert.strictEqual(o.pages[0].route.localOnly, true);
  assert.strictEqual(o.pages[0].route.summary.by, 'claude-code');
  assert.ok(o.pages[0].blocks.length > 0);
  noLocalSummary(o);
});

test('D59・決めたこと 103: Claude Code に届かない会議は要約を作らずに要約待ち（summaryWait と「要約待ち（つながったら作ります）」）。知らせも出す', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--relay=text', '--sum', '--claude=ok', '--segs=2', '--summary-offline']);
  assert.strictEqual(pCalls(o).length, 0);
  assert.strictEqual(o.pages[0].summaryWait, true, JSON.stringify(o.pages[0]));
  assert.strictEqual(o.pages[0].summaryError, WAIT);
  assert.strictEqual(o.pages[0].blocks.length, 0);
  assert.ok(o.notices.some((x) => textOf(x) === WAIT), JSON.stringify(o.notices));
  noLocalSummary(o);
});

test('決めたこと 104: 届くようになると見回りで自動で偽の claude が1回呼ばれ、要約が保存され、印が消える。2回目の見回りでは呼ばない', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--relay=text', '--claude=ok', '--segs=2', '--summary-offline', '--summary-online-after=100']);
  const [a, b] = o.summaryBack;
  assert.strictEqual(a.pCalls, 1, 'つながった後の見回りで要約しなかった');
  assert.ok(a.pages[0].blocks.length > 0);
  assert.strictEqual(a.pages[0].summaryWait, false);
  // 0.11.0 Q-3 で意図して変えた: 短い文字起こしの要約には QN2 の注が付く（決めたこと 32）
  assert.strictEqual(a.pages[0].summaryError, '文字起こしが短いため、打ち合わせの質の点は付けていません。');
  assert.strictEqual(a.pages[0].route.summary.by, 'claude-code');
  assert.strictEqual(b.pCalls, 1, '2回目の見回りでまた呼んだ');
  noLocalSummary(o);
});

test('決めたこと 105: つながった後に偽の claude がログイン切れで断ると、印を消して平易な理由（［要約を生成］の案内）を出す', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--relay=text', '--claude=expired401', '--segs=1', '--summary-offline', '--summary-online-after=100']);
  const [a, b] = o.summaryBack;
  assert.strictEqual(a.pCalls, 1);
  assert.strictEqual(a.pages[0].summaryWait, false, '断られたのに要約待ちのまま');
  assert.strictEqual(a.pages[0].summaryError, 'Claude Code のログインが切れています。設定の［Claude Code にログイン］を押してください。');
  assert.strictEqual(b.pCalls, 1, '断られたページを見回りでまた試した');
  noLocalSummary(o);
});

test('決めたこと 105: 上限で断られたときも印を消して理由を出す', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--relay=text', '--claude=limit', '--segs=1', '--summary-offline', '--summary-online-after=100']);
  const [a] = o.summaryBack;
  assert.strictEqual(a.pCalls, 1);
  assert.strictEqual(a.pages[0].summaryWait, false);
  assert.match(a.pages[0].summaryError, /Claude の利用の上限に達しました/);
  noLocalSummary(o);
});

test('決めたこと 104: つながり直し1回につき1回だけ（混み合いで作れなかったページは待ちのまま、次の見回りでは呼ばず、次のつながり直しで呼ぶ）', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--relay=text', '--claude=overloaded', '--segs=1', '--summary-offline', '--summary-online-after=100', '--summary-reconnect']);
  const [a, b, c] = o.summaryBack;
  assert.strictEqual(a.pCalls, 1);
  assert.strictEqual(a.pages[0].summaryWait, true, '混み合い（待てば直る）なのに要約待ちを外した');
  assert.strictEqual(a.pages[0].summaryError, WAIT);
  assert.strictEqual(b.pCalls, 1, '同じつながりの2回目の見回りでまた呼んだ');
  assert.strictEqual(c.pCalls, 2, '次のつながり直しで呼ばなかった');
  noLocalSummary(o);
});

test('D59: 要約の場面の Claude Code が無い PC（--claude なし）も手元の llama で作らない（要約待ちか理由）', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--sum', '--segs=2']);
  assert.deepStrictEqual(o.claude, []);
  assert.strictEqual(o.pages[0].blocks.length, 0);
  assert.ok(o.pages[0].summaryError, '要約の欄に何も書いていない');
  noLocalSummary(o);
});
