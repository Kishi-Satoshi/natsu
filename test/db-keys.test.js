/* db-keys.test.js — 第2a1回 ST3: 並びの鍵（純粋）と、切り出した決まりが今と同じこと */
'use strict';
const { titleAt } = require('./helpers/titles');
const test = require('node:test');
const assert = require('node:assert');
const K = require('../src/db/keys');
const R = require('../src/pagerules');

test('ST3: keyBetween は間に入る鍵を返し、文字の順が並びの順', { timeout: 5000 }, () => {
  const a = K.keyBetween(null, null);
  const b = K.keyBetween(a, null);
  const c = K.keyBetween(null, a);
  assert.ok(c < a && a < b, `${c} ${a} ${b}`);
  let lo = a, hi = b;
  for (let i = 0; i < 200; i++) { const m = K.keyBetween(lo, hi); assert.ok(lo < m && m < hi, `${lo} ${m} ${hi}`); hi = m; }
  assert.throws(() => K.keyBetween(b, a), /順/);
  assert.throws(() => K.keyBetween(a, a), /順/);
  for (const k of [a, b, c]) assert.ok(!k.endsWith('0'), `末尾 0 の鍵 ${k}（後で間に入れられなくなる）`);
});

test('ST3: evenKeys は等幅で昇順、どの2つの間にも入れられる', { timeout: 5000 }, () => {
  const ks = K.evenKeys(2000);
  assert.strictEqual(new Set(ks).size, 2000);
  assert.deepStrictEqual([...ks].sort(), ks);
  assert.ok(ks.every((k) => k.length === ks[0].length), '幅がそろわない（文字の順と数の順がずれる）');
  assert.ok(K.keyBetween(ks[10], ks[11]) > ks[10]);
});

// 計画の2つに足した確かめ: 先頭と末尾の外・下へ続けて入れる・evenKeys の端と小さい n・形の悪い鍵は断る
test('ST3: keyBetween は下へ続けて入れても末尾 0 を作らず、evenKeys のどの隣どうし・両端の外にも入れられる', { timeout: 5000 }, () => {
  let hi = K.keyBetween(null, null);
  for (let i = 0; i < 200; i++) {
    const m = K.keyBetween(null, hi);
    assert.ok(m < hi && !m.endsWith('0'), `${m} ${hi}`);
    hi = m;
  }
  let lo = K.keyBetween(null, null);
  for (let i = 0; i < 200; i++) { const m = K.keyBetween(lo, null); assert.ok(lo < m && !m.endsWith('0'), `${lo} ${m}`); lo = m; }
  for (const n of [1, 2, 35, 36, 37, 1296, 2000]) {
    const ks = K.evenKeys(n);
    assert.strictEqual(ks.length, n);
    assert.ok(ks.every((k) => !k.endsWith('0') && k.length === ks[0].length), `n=${n}`);
    for (let i = 0; i + 1 < n; i++) {
      const m = K.keyBetween(ks[i], ks[i + 1]);
      assert.ok(ks[i] < m && m < ks[i + 1], `n=${n} ${ks[i]} ${m} ${ks[i + 1]}`);
    }
    assert.ok(K.keyBetween(null, ks[0]) < ks[0]);
    assert.ok(K.keyBetween(ks[n - 1], null) > ks[n - 1]);
  }
  assert.deepStrictEqual(K.evenKeys(0), []);
  for (const bad of ['', 'A', 'a0', 'あ', 3]) assert.throws(() => K.keyBetween(bad, null), /形/, JSON.stringify(bad));
});

test('D-1: 切り出した決まりは store と同じ答え（listEntry は検索用の文字を持たない）', { timeout: 5000 }, () => {
  const page = { id: 'pa1', title: titleAt('2026-10-01T00:00:00.000Z'), date: '2026-10-01', memo: 'メモ', createdAt: '2026-10-01T00:00:00.000Z',
    blocks: [{ id: 'b1', type: 'heading', text: '要点' }, { id: 'b2', type: 'todo', text: '見積を出す', checked: false, assignee: '担当A', due: '2026-10-10' }] };
  const s = R.summarize(page);
  assert.strictEqual(s.searchText, '要点 見積を出す');
  assert.strictEqual(s.memoText, 'メモ');
  const e = R.listEntry(page);
  assert.ok(!('searchText' in e) && !('memoText' in e));
  assert.deepStrictEqual({ ...e, searchText: s.searchText, memoText: s.memoText }, s);
  assert.deepStrictEqual(R.citeStatOf([{ type: 'bullet', text: '十分に長い要点の文です', cites: ['s1'] }]), { linked: 1, total: 1 });
  assert.strictEqual(R.snippetOf('では、予算案の、作成を進めます', R.foldWithMap('予算案の作成').folded).startsWith('では、予算案の、作成'), true);
});

test('D-1: json-backend は今の store を命令の名前で呼ぶ（返す形は今の IPC と同じ）', { timeout: 5000 }, async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-jb-日本語𠮷-'));
  try {
    const store = require('../src/store'); store.init(dir);
    const jb = require('../src/db/json-backend').makeJsonBackend(store);
    const p = await jb.call('meeting.finalize', { pageId: 'pignored', page: { title: titleAt('2026-10-01T00:00:00.000Z'), blocks: [] }, segments: [{ id: 's1', atMs: 0, durationMs: 1000, text: '発言' }] });
    const got = await jb.call('page.get', { id: p.id });
    assert.strictEqual(got.page.title, titleAt('2026-10-01T00:00:00.000Z'));
    assert.deepStrictEqual(got.segments.map((s) => s.text), ['発言']);
    const ins = await jb.call('block.insert', { pageId: p.id, afterBlockId: '', type: 'bullet' });
    assert.ok(ins.blockId && ins.page.blocks.length === 1);
    assert.deepStrictEqual((await jb.call('pages.list', {})).map((x) => x.id), [p.id]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 計画の1つに足した確かめ: M-1・D-3a・D-4 が頼る残りの命令（返す形・page.put の決まり・失敗の形）
test('D-1: json-backend の残りの命令（経路の行・page.put は DB が作る欄を保存せず無いページを作らない・復旧・発言の失敗と削除・知らない命令）', { timeout: 5000 }, async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-jb2-日本語𠮷-'));
  try {
    const store = require('../src/store'); store.init(dir);
    const jb = require('../src/db/json-backend').makeJsonBackend(store, { labels: { groq: 'Groq（無料枠）' } });
    assert.strictEqual(jb.state(), 'ready');
    assert.strictEqual(jb.send('meeting.begin', { pageId: 'px', startedAt: 1, localOnly: false }), undefined);
    const p = await jb.call('meeting.finalize', { pageId: 'pignored', page: { title: titleAt('2026-10-01T00:00:00.000Z'), blocks: [{ id: 'b1', type: 'bullet', text: '十分に長い要点の文です', cites: ['s1'] }], route: { stt: { cloud: 2, local: 1, provider: 'groq' }, localOnly: false } },
      segments: [{ id: 's1', atMs: 0, durationMs: 1000, text: '発言' }, { id: 's2', atMs: 1000, durationMs: 1000, text: '次の発言' }] }, { tx: 'meeting:1' });
    assert.notStrictEqual(p.id, 'pignored');
    const got = await jb.call('page.get', { id: p.id });
    assert.deepStrictEqual(got.page.routeText, ['☁ 文字起こし: クラウド（Groq（無料枠））2・PC 1']);
    assert.strictEqual(await jb.call('page.get', { id: 'nope' }), null);
    // page.put: page.get の答え（rev・routeText つき）をそのまま渡しても、その2つはファイルに残らない
    const put = await jb.call('page.put', { page: { ...got.page, rev: 7, summaryError: '要約の文' }, baseRev: 7 });
    assert.strictEqual(put.summaryError, '要約の文');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'pages', `${p.id}.json`), 'utf8'));
    assert.ok(!('rev' in onDisk) && !('routeText' in onDisk), 'DB が作る欄をページのファイルに書いた');
    assert.strictEqual(onDisk.summaryError, '要約の文');
    assert.strictEqual(await jb.call('page.put', { page: { ...got.page, id: 'pgone' }, baseRev: 1 }), null, '無いページを作った');
    assert.ok(!fs.existsSync(path.join(dir, 'data', 'pages', 'pgone.json')));
    // 書く命令は今の IPC と同じ答え
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    assert.strictEqual((await jb.call('page.setTitle', { id: p.id, title: '直した題' })).title, '直した題');
    assert.strictEqual((await jb.call('page.setMemo', { id: p.id, memo: 'メモ' })).memo, 'メモ');
    const typed = await jb.call('page.setType', { id: p.id, type: 'oneonone' });
    assert.deepStrictEqual([typed.meetingType, typed.typeAuto], ['oneonone', false]);
    const act = await jb.call('block.setAction', { pageId: p.id, blockId: 'b1', assignee: ' 担当B ', dueRaw: '未定' });
    assert.deepStrictEqual([act.blocks[0].assignee, act.blocks[0].dueRaw, act.blocks[0].due], ['担当B', '未定', '']);
    const su = await jb.call('segment.update', { pageId: p.id, segId: 's1', patch: { text: '直した発言' } });
    assert.deepStrictEqual(su.segments.map((s) => s.text), ['直した発言', '次の発言']);
    assert.ok(Array.isArray(su.page.routeText), 'segment.update の答えに経路の行が無い（画面の curPage から消える）');
    // 復旧の失敗の文・やり直しの成功（出典を引き直さない）・無音の区間の削除
    await jb.call('segment.fail', { pageId: p.id, segId: 's2', text: '（この区間の認識に失敗: x）' });
    assert.deepStrictEqual(store.getTranscript(p.id)[1], { id: 's2', atMs: 1000, durationMs: 1000, text: '（この区間の認識に失敗: x）', failed: true });
    const before = store.getPage(p.id).updatedAt;
    await jb.call('segment.update', { pageId: p.id, segId: 's2', patch: { text: 'やり直した発言' }, recite: false });
    assert.deepStrictEqual(store.getTranscript(p.id)[1], { id: 's2', atMs: 1000, durationMs: 1000, text: 'やり直した発言' });
    assert.strictEqual(store.getPage(p.id).updatedAt, before, 'recite: false なのにページを保存した（今の復旧の道と違う）');
    await jb.call('segment.remove', { pageId: p.id, segId: 's2' });
    assert.deepStrictEqual(store.getTranscript(p.id).map((s) => s.id), ['s1']);
    // 復旧: 要約の欄の文も1回で入れ、already は false（JSON の保存は同じ ID の上書きを知らない）
    const rec = await jb.call('meeting.recover', { pageId: 'pr1', page: { title: `${titleAt('2026-10-01T02:00:00.000Z')}（復旧）`, blocks: [], recovered: true, summaryError: '録音が中断されたため要約は未生成です。' }, segments: [] });
    assert.deepStrictEqual([rec.already, rec.page.recovered, rec.page.summaryError], [false, true, '録音が中断されたため要約は未生成です。']);
    // 手元の写しだけでなく、ページのファイルに要約の欄の文が書かれていること（保存し直しを消すと、復旧した議事録に要約が無い訳が消える）
    const recDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'pages', `${rec.page.id}.json`), 'utf8'));
    assert.deepStrictEqual([recDisk.recovered, recDisk.summaryError], [true, '録音が中断されたため要約は未生成です。'], '復旧の要約の欄の文がファイルに無い');
    // 会議の終わり（meeting.finalize）で要約の欄の文があるときも同じ
    const fin = await jb.call('meeting.finalize', { pageId: 'pf1', page: { title: titleAt('2026-10-01T01:00:00.000Z'), blocks: [], summaryError: '要約に失敗しました（見本）' }, segments: [] });
    assert.strictEqual(fin.summaryError, '要約に失敗しました（見本）');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'pages', `${fin.id}.json`), 'utf8')).summaryError, '要約に失敗しました（見本）', '会議の終わりの要約の欄の文がファイルに無い');
    await jb.call('page.delete', { id: fin.id });
    assert.deepStrictEqual(await jb.call('meeting.settle', { keep: [] }), { settled: 0 });
    const list = await jb.call('page.delete', { id: rec.page.id });
    assert.deepStrictEqual(list.map((x) => x.id), [p.id]);
    assert.deepStrictEqual((await jb.call('pages.searchFull', { q: '直した発言' })).hits.map((h) => h.id), [p.id]);
    assert.strictEqual((await jb.call('pages.actionView', {})).total, 0);
    await assert.rejects(jb.call('nope.cmd', {}), (e) => e.message === 'unknown-cmd' && e.code === 'unknown-cmd' && e.retry === false);
    await assert.rejects(jb.call('__proto__', {}), (e) => e.code === 'unknown-cmd');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('D-1: store.initDrafts は data を作るだけ（pages/ を作らず index.json を読まない）。下書きはそこで読み書きできる', { timeout: 5000 }, () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-drafts-日本語𠮷-'));
  try {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'index.json'), '{ 壊れた索引');
    const store = require('../src/store');
    assert.strictEqual(store.initDrafts(dir), data);
    assert.strictEqual(store.root(), data);
    assert.deepStrictEqual(fs.readdirSync(data).sort(), ['index.json'], 'pages/ を作ったか、壊れた索引を退けた（元の JSON に触れた）');
    assert.strictEqual(fs.readFileSync(path.join(data, 'index.json'), 'utf8'), '{ 壊れた索引');
    store.writeDraft({ startedAt: 1, segments: [] });
    assert.deepStrictEqual(store.draftFiles(), ['draft.json']);
    store.clearDraft();
    const fresh = path.join(dir, 'まだ無い');
    assert.strictEqual(store.initDrafts(fresh), path.join(fresh, 'data'));
    assert.deepStrictEqual(fs.readdirSync(path.join(fresh, 'data')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
