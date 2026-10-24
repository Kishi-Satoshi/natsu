/* db-commands.test.js — 第2a1回 ST4・ST6・ST11・F6: 行 ⇄ ページと画面の命令 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpDb, jsonTwin, samplePage } = require('./helpers/dbtmp');   // jsonTwin: 一時フォルダの store.js と json-backend。seed は同じ JSON をそのまま書く
const core = require('../src/db/core');
const { titleAt } = require('./helpers/titles');

const NOW = () => new Date('2026-10-19T01:02:03.000Z');
let n = 0;
const call = (db, cmd, args, role = 'app') => core.call(db, { role, cmd, args, tx: `${role[0]}:t-${String(++n).padStart(6, '0')}` }, { now: NOW, labels: { groq: 'Groq（無料枠）' } });
// updatedAt・rev・id の作り方の違いと、DB だけが付ける空の children（2a1 は子のない木）だけを落として比べる
// 0.11.0 M-4 で意図して足した: 経過の項目（{ s, by, at }）の時刻も落とす（json-backend は時計を受けず、今の時刻で積む）
const plain = (v) => JSON.parse(JSON.stringify(v, function (k, x) {
  if (['updatedAt', 'rev', 'blockId'].includes(k) || (k === 'children' && Array.isArray(x) && x.length === 0)) return undefined;
  if (k === 'at' && this && typeof this.s === 'string' && typeof this.by === 'string') return undefined;
  return x;
}));

test('ST4: 画面の 14 の命令は json-backend（今の保存）と同じ答え', { timeout: 5000 }, async () => {
  const t = tmpDb(); const j = jsonTwin();
  try {
    const { db } = t.open();
    // 見出し・箇条書き（出典あり・短い行）・ToDo（担当・期限）・経路・一時停止の印・知らない欄 extraField。page の中に segments は入れない
    const { page, segments } = samplePage('pa1');
    t.seed(page, segments);           // putPageRows で入れる（会議の印 meeting を足さない。比べを同じ JSON から始める）
    await j.seed(page, segments);
    const steps = [
      // 利用者が付け直した題名（D77。題名の語に頼るため）
      ['page.get', { id: 'pa1' }], ['page.setTitle', { id: 'pa1', title: '直した題' }], ['page.setMemo', { id: 'pa1', memo: 'メモ' }],
      ['page.setType', { id: 'pa1', type: 'oneonone' }], ['block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '書き換えた要点の文' } }],
      ['block.update', { pageId: 'pa1', blockId: 'b4', patch: { checked: true } }], ['block.move', { pageId: 'pa1', blockId: 'b1', toIndex: 2 }],
      ['block.setAction', { pageId: 'pa1', blockId: 'b4', assignee: ' 担当B ', dueRaw: '来週の金曜' }], ['block.remove', { pageId: 'pa1', blockId: 'b3' }],
      ['segment.update', { pageId: 'pa1', segId: 's1', patch: { text: '直した発言' } }], ['pages.actionView', {}], ['page.get', { id: 'nope' }],
    ];
    for (const [cmd, args] of steps) {
      const r = call(db, cmd, args);
      assert.strictEqual(r.ok, true, `${cmd} ${r.code}`);
      assert.deepStrictEqual(plain(r.result), plain(await j.call(cmd, args)), cmd);
    }
    const ins = call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'b2', type: 'bullet' });
    assert.deepStrictEqual(ins.result.page.blocks.map((b) => b.type), (await j.call('page.get', { id: 'pa1' })).page.blocks.map((b) => b.type).toSpliced(1, 0, 'bullet'));
    // 点検で足した確かめ: 足した行は afterBlockId のすぐ後（型の並びだけでは、前に足しても同じに見える）
    const ids = ins.result.page.blocks.map((b) => b.id);
    assert.strictEqual(ids.indexOf(ins.result.blockId), ids.indexOf('b2') + 1, '足した行が afterBlockId のすぐ後でない（Enter で上に行が増える）');
    assert.strictEqual(call(db, 'page.get', { id: 'pa1' }).result.page.routeText[0], '☁ 文字起こし: クラウド（Groq（無料枠））3');
  } finally { t.done(); j.done(); }
});

test('F6: page.put は baseRev が今の rev と違えば conflict（画面の直しを古い写しで上書きしない）。ブロックだけの直しでも rev が上がる。rev と routeText は保存しない', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    t.seed(samplePage('pa1').page, []);
    const p = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
    assert.ok(Number.isInteger(p.rev) && Array.isArray(p.routeText));
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    call(db, 'page.setTitle', { id: 'pa1', title: '画面で直した' });
    const r = call(db, 'page.put', { page: { ...p, summaryError: '要約の文' }, baseRev: p.rev }, 'main');
    assert.deepStrictEqual([r.ok, r.code, r.retry], [false, 'conflict', true]);
    assert.strictEqual(call(db, 'page.get', { id: 'pa1' }).result.page.title, '画面で直した');
    const p2 = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
    call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '画面で直した行' } });
    assert.strictEqual(call(db, 'page.put', { page: { ...p2, summaryError: 'x' }, baseRev: p2.rev }, 'main').code, 'conflict', 'ブロックの直しで rev が上がらない（要約が行の直しを消す）');
    const p3 = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
    assert.strictEqual(call(db, 'page.put', { page: { ...p3, summaryError: 'y' }, baseRev: p3.rev }, 'main').ok, true);
    // 点検で足した確かめ: ページの行（updatedAt・citeStat）が変わらないブロックだけの直しでも rev が上がる
    // （同じミリ秒の2つの書き込み。時刻を止めて、出典の数の変わらない checked だけを直す）
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    call(db, 'page.setTitle', { id: 'pa1', title: '時刻をそろえる' });
    const p4 = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
    assert.strictEqual(p4.updatedAt, NOW().toISOString());
    assert.strictEqual(call(db, 'block.update', { pageId: 'pa1', blockId: 'b4', patch: { checked: true } }).ok, true);
    assert.strictEqual(call(db, 'page.put', { page: { ...p4, summaryError: 'z' }, baseRev: p4.rev }, 'main').code, 'conflict', 'ページの行が変わらない直しで rev が上がらない（要約が ToDo の印を消す）');
    assert.strictEqual(call(db, 'page.get', { id: 'pa1' }).result.page.blocks.find((b) => b.id === 'b4').checked, true);
    const attrs = JSON.parse(db.prepare("select attrs from blocks where id='pa1'").get().attrs);
    assert.ok(!('rev' in attrs) && !('routeText' in attrs), 'DB が作る欄を attrs に保存した');
    assert.strictEqual(call(db, 'page.put', { page: { ...p, id: 'gone' }, baseRev: 1 }, 'main').result, null, '無いページを作った（要約中に消したページが戻る）');
  } finally { t.done(); }
});

// 点検で足した確かめ: 要約の途中でゴミ箱に入れたページへは書き戻さない（null を返し、main は保存できなかったと分かる）
test('F6: page.put はゴミ箱のページに書かず null', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    t.seed(samplePage('pa1').page, []);
    const p = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
    assert.strictEqual(call(db, 'page.delete', { id: 'pa1' }).ok, true);
    const rev = db.prepare("select rev from blocks where id='pa1'").get().rev;
    const r = call(db, 'page.put', { page: { ...p, summaryError: '要約の文' }, baseRev: rev }, 'main');
    assert.deepStrictEqual([r.ok, r.result], [true, null], 'ゴミ箱のページに書き戻した');
    assert.strictEqual(JSON.parse(db.prepare("select attrs from blocks where id='pa1'").get().attrs).summaryError, '');
  } finally { t.done(); }
});

// 点検で足した確かめ: recite: false（復旧の文字起こしの道）は区間だけを直す。失敗の印を外し、rev は上がり、ブロックと出典の数は触らない
test('ST6: segment.update の recite: false は発言だけを直す（ブロックと citeStat はそのまま）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const { page, segments } = samplePage('pa1');
    t.seed(page, segments);
    const before = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
    const r = call(db, 'segment.update', { pageId: 'pa1', segId: 's1', patch: { text: '復旧で起こし直した発言' }, recite: false }, 'main');
    assert.strictEqual(r.ok, true, r.code);
    assert.ok(r.result && Array.isArray(r.result.segments), '区間を直さずに null を返した');
    const s1 = r.result.segments.find((s) => s.id === 's1');
    assert.deepStrictEqual([s1.text, 'failed' in s1], ['復旧で起こし直した発言', false], '直した区間が書かれていない');
    const got = call(db, 'page.get', { id: 'pa1' }, 'main').result;
    assert.strictEqual(got.segments.find((s) => s.id === 's1').text, '復旧で起こし直した発言');
    assert.strictEqual(got.page.rev, before.rev + 1, '発言の直しで rev が上がらない');
    assert.deepStrictEqual(got.page.blocks, before.blocks, 'recite: false なのにブロックを直した');
    assert.deepStrictEqual(got.page.citeStat, before.citeStat, 'recite: false なのに出典の数を作り直した');
  } finally { t.done(); }
});

test('Q2: page.delete はゴミ箱へ（一覧と検索から消え、行は残り、oplog は trash）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    t.seed(samplePage('pa1').page, []);
    assert.deepStrictEqual(call(db, 'page.delete', { id: 'pa1' }).result, []);
    assert.strictEqual(call(db, 'page.get', { id: 'pa1' }).result, null);
    assert.ok(db.prepare("select trashed_at from blocks where id='pa1'").get().trashed_at);
    assert.strictEqual(JSON.parse(db.prepare("select ops from oplog where action='page.delete'").get().ops)[0].op, 'trash');
  } finally { t.done(); }
});

test('ST11: よく使う問い合わせに表全体の走査が無い（EXPLAIN QUERY PLAN）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    for (const [name, sql] of Object.entries(require('../src/db/commands').HOT_QUERIES)) {
      const plan = db.prepare(`explain query plan ${sql}`).all(...new Array((sql.match(/\?/g) || []).length).fill('x')).map((r) => r.detail).join(' / ');
      assert.ok(!/\bSCAN (blocks|segments|oplog)\b/.test(plan), `${name}: ${plan}`);
    }
  } finally { t.done(); }
});

// 計画の表に足した確かめ: 読むときは決まった名前（列の値）を attrs の後に置く。attrs に古い id・title・type・text・rev が
// 紛れていても（素の SQL で書いた行・後の版の行）、列の値が勝つ（変異 db-view-order: attrs を最後に広げると赤）
test('ST3: 読む形は attrs を先に広げ、id・title・rev・ブロックの type・text は列の値', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    db.exec(`insert into blocks(id, type, page_id, ord, text, attrs, rev) values
      ('pv1', 'page', 'pv1', 'i', '列の題', '{"id":"px","title":"古い題","rev":99,"memo":"メモ"}', 3),
      ('bv1', 'bullet', 'pv1', 'a0', '列の文', '{"id":"bx","type":"todo","text":"古い文","children":[1]}', 1)`);
    const p = call(db, 'page.get', { id: 'pv1' }).result.page;
    assert.deepStrictEqual([p.id, p.title, p.rev, p.memo], ['pv1', '列の題', 3, 'メモ']);
    assert.deepStrictEqual([p.blocks[0].id, p.blocks[0].type, p.blocks[0].text, p.blocks[0].children], ['bv1', 'bullet', '列の文', []]);
  } finally { t.done(); }
});

// 0.10.0 Task R-2（MR3・MR6。計画 docs/plans/2026-10-20-100.md）: 一覧から外す行（listedRows）を MCP の読み手が外から渡せる形にする。画面の答えは変えない
const C = require('../src/db/commands');
function r2Seed(t, db) {
  // ふつう2つ（ToDo あり）・ゴミ箱1つ・録音中の写し1つ
  for (const id of ['pa1', 'pa2', 'pa3']) {
    const p = samplePage(id).page;
    t.seed({ ...p, id, createdAt: `2026-10-1${id.slice(-1)}T00:00:00.000Z`, blocks: p.blocks.map((b) => ({ ...b, id: `${id}${b.id}` })) }, []);
  }
  call(db, 'page.delete', { id: 'pa3' });
  assert.strictEqual(call(db, 'meeting.begin', { pageId: 'pl1', startedAt: Date.parse('2026-10-19T00:00:00.000Z'), localOnly: false }, 'main').ok, true);
}

test('R-2: listedRows の行は id・key・attrs（読んだ物）を持ち、ゴミ箱と録音中の写しを含まない', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    r2Seed(t, db);
    const rows = C.listedRows(db);
    assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['pa1', 'pa2']);
    for (const r of rows) {
      assert.strictEqual(typeof r.key, 'string');
      assert.ok(r.attrs && typeof r.attrs === 'object' && !Array.isArray(r.attrs), `${r.id}: attrs が物でない`);
      assert.deepStrictEqual(r.attrs.route, samplePage(r.id).page.route, `${r.id}: attrs に経路が無い`);
    }
  } finally { t.done(); }
});

test('R-2: actionView に行の一部を渡すと、その行のページだけが答えに出る（渡さなければ今の pages.actionView と同じ答え）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    r2Seed(t, db);
    const all = C.actionView(db, {});
    assert.deepStrictEqual(all, call(db, 'pages.actionView', {}).result);
    assert.deepStrictEqual([...new Set(all.actions.map((a) => a.pageId))].sort(), ['pa1', 'pa2']);
    const only = C.actionView(db, {}, C.listedRows(db).filter((r) => r.id === 'pa2'));
    assert.ok(only.actions.length > 0);
    assert.deepStrictEqual([...new Set(only.actions.map((a) => a.pageId))], ['pa2']);
    assert.deepStrictEqual(C.actionView(db, {}, []).actions, []);
  } finally { t.done(); }
});

test('R-2: entryOf は pages.list の1行と同じ', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    r2Seed(t, db);
    const list = call(db, 'pages.list', {}).result;
    const mine = C.listedRows(db).map((r) => C.entryOf(db, r));
    assert.deepStrictEqual(mine, list);
  } finally { t.done(); }
});

// 0.11.0 M-3（MT4・F10。計画 docs/plans/2026-10-22-110.md の決めたこと 23・24）: 印のある行を人が直したら印を外す・一覧の最初の要点は印の無い行から
test('0.11.0 M-3: 印のある行の文を block.update で直すと mark と unconfirmed が消え、citeState は manual のまま（手書き）。チェックだけ・文を変えない直しでは消えない。json-backend も同じ', { timeout: 5000 }, async () => {
  const t = tmpDb(); const j = jsonTwin();
  try {
    const { db } = t.open();
    const { page, segments } = samplePage('pm1');
    page.blocks = [
      { id: 'b1', type: 'heading', text: '抜け・重なりチェック' },
      { id: 'b2', type: 'bullet', text: '未確認: 予算（B）', cites: [], mark: 'check', unconfirmed: true, citeState: 'manual' },
      { id: 'b3', type: 'bullet', text: '次の会議で決裁の流れを聞く', cites: [], mark: 'check', citeState: 'manual' },
      { id: 'b4', type: 'heading', text: '論点ごとの要点' },
      { id: 'b5', type: 'bullet', text: '予算は据え置きにした', cites: ['s2'] },
    ];
    t.seed(page, segments); await j.seed(page, segments);
    for (const [cmd, args] of [['block.update', { pageId: 'pm1', blockId: 'b2', patch: { text: '未確認: 予算（B）と時期（T）' } }],
      ['block.update', { pageId: 'pm1', blockId: 'b3', patch: { text: '次の会議で決裁の流れを聞く' } }]]) {
      const r = call(db, cmd, args);
      assert.strictEqual(r.ok, true, r.code);
      assert.deepStrictEqual(plain(r.result), plain(await j.call(cmd, args)), cmd);
    }
    const bs = call(db, 'page.get', { id: 'pm1' }).result.page.blocks;
    const b2 = bs.find((b) => b.id === 'b2'); const b3 = bs.find((b) => b.id === 'b3');
    assert.deepStrictEqual([b2.mark, b2.unconfirmed, b2.citeState], [undefined, undefined, 'manual']);
    assert.deepStrictEqual([b3.mark, b3.citeState], ['check', 'manual'], '文を変えない直しで印が消えた');
    // 一覧の最初の要点は印の無い箇条書き（b3 は印あり・b2 は印が消えたので b2）
    const row = call(db, 'pages.list', {}).result.find((x) => x.id === 'pm1');
    assert.strictEqual(row.preview, '未確認: 予算（B）と時期（T）');
  } finally { t.done(); j.done(); }
});

test('0.11.0 M-3: 一覧の最初の要点（preview）は印の無い最初の箇条書き。印の無い今のページは今と同じ', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const a = samplePage('pv1');
    a.page.blocks = [{ id: 'v1', type: 'heading', text: '抜け・重なりチェック' }, { id: 'v2', type: 'bullet', text: '未確認: 目的', cites: [], mark: 'check', unconfirmed: true, citeState: 'manual' },
      { id: 'v3', type: 'bullet', text: '冒頭で目的を言う', cites: [], mark: 'advice', citeState: 'manual' }, { id: 'v4', type: 'bullet', text: '予算は据え置きにした', cites: [] }];
    t.seed(a.page, a.segments);
    const b = samplePage('pv2'); t.seed(b.page, b.segments);
    const rows = call(db, 'pages.list', {}).result;
    assert.strictEqual(rows.find((x) => x.id === 'pv1').preview, '予算は据え置きにした');
    assert.strictEqual(rows.find((x) => x.id === 'pv2').preview, '来月の予算案の作成を担当Aが進める');
  } finally { t.done(); }
});

// 0.11.0 M-4（MT3・F14・F27・F28・P13・P16。決めたこと 8・12。持ち主の試作の「命令ごとの照らし」「1つの命令＝1つのトランザクション」）
test('0.11.0 M-4: page.setType は選べる種類の鍵と auto だけを通す（知らない名前・前の版の general・数・道の形は bad-args）', { timeout: 5000 }, async () => {
  const t = tmpDb(); const j = jsonTwin();
  try {
    const { db } = t.open();
    const { page, segments } = samplePage('pt1');
    t.seed(page, segments); await j.seed(page, segments);
    for (const type of ['nope', 'general', '../x', 3, '', 'Sales']) {
      const r = call(db, 'page.setType', { id: 'pt1', type });
      assert.deepStrictEqual([r.ok, r.code], [false, 'bad-args'], String(type));
    }
    for (const type of ['standup', 'review', 'brainstorm', 'oneonone', 'interview', 'sales', 'present']) {
      const r = call(db, 'page.setType', { id: 'pt1', type });
      assert.strictEqual(r.ok, true, type);
      assert.deepStrictEqual([r.result.meetingType, r.result.typeAuto], [type, false], type);
      assert.deepStrictEqual(plain(r.result), plain(await j.call('page.setType', { id: 'pt1', type })), type);
    }
    const a = call(db, 'page.setType', { id: 'pt1', type: 'auto' });
    assert.deepStrictEqual([a.ok, a.result.typeAuto, a.result.meetingType], [true, true, 'present'], '自動に戻すと次の要約で判定し直す（種類は今のまま）');
    assert.deepStrictEqual(plain(a.result), plain(await j.call('page.setType', { id: 'pt1', type: 'auto' })));
  } finally { t.done(); j.done(); }
});

test('0.11.0 M-4・F14: page.setType の preset は、DB にある今のメモが手を付けていない（空・型の雛形・アジェンダの雛形）ときだけ新しい型の雛形に替え、人の文は1文字も変えない。同じ tx で経過に type/page を1件（続けて選んだら置き換え）', { timeout: 5000 }, async () => {
  const M = require('../src/memoTypes');
  const mtype = require('../src/meetingType');
  const t = tmpDb(); const j = jsonTwin();
  try {
    const { db } = t.open();
    const cases = [['pp1', ''], ['pp2', M.memoPreset('points')], ['pp3', mtype.getAgenda('standup')], ['pp4', '予算の相談をする'], ['pp5', `${M.memoPreset('grow')}あ`]];
    for (const [id, memo] of cases) { const { page, segments } = samplePage(id); page.blocks = page.blocks.map((b) => ({ ...b, id: `${id}${b.id}` })); page.memo = memo; page.stateLog = [{ s: 'start', by: 'button', at: '2026-10-19T00:00:00.000Z' }]; t.seed(page, segments); await j.seed(page, segments); }
    for (const [id, memo] of cases) {
      const r = call(db, 'page.setType', { id, type: 'sales', preset: true });
      assert.strictEqual(r.ok, true, id);
      const want = M.isUntouchedMemo(memo, mtype.listTypes().map((x) => x.agenda)) ? M.memoPreset('bantc') : memo;
      assert.strictEqual(r.result.memo, want, id);
      assert.deepStrictEqual(r.result.stateLog.map((x) => `${x.s}/${x.by}`), ['start/button', 'type/page'], id);
      assert.deepStrictEqual(plain(r.result), plain(await j.call('page.setType', { id, type: 'sales', preset: true })), id);
    }
    assert.strictEqual(call(db, 'page.get', { id: 'pp4' }).result.page.memo, '予算の相談をする');
    // 続けて選び直しても種類の項目は1件。preset が無ければメモは替えない。auto ではメモを替えない
    const r2 = call(db, 'page.setType', { id: 'pp1', type: 'oneonone' });
    assert.strictEqual(r2.result.memo, M.memoPreset('bantc'));
    assert.deepStrictEqual(r2.result.stateLog.map((x) => `${x.s}/${x.by}`), ['start/button', 'type/page']);
    const r3 = call(db, 'page.setType', { id: 'pp1', type: 'auto', preset: true });
    assert.strictEqual(r3.result.memo, M.memoPreset('bantc'));
  } finally { t.done(); j.done(); }
});

test('0.11.0 M-4・F27: 締めと復旧のページは、録音中に選んだ種類（選べる鍵だけ）を typeAuto 偽で写す。知らない値と無い値は写さない', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const fin = (pageId, extra) => call(db, 'meeting.finalize', { pageId, segments: [], page: { title: titleAt('2026-10-19T00:00:00.000Z'), memo: '', blocks: [], createdAt: '2026-10-19T00:00:00.000Z', meeting: { phase: 'done' }, ...extra } }, 'main');
    let r = fin('pf1', { meetingType: 'sales', typeAuto: false });
    assert.deepStrictEqual([r.result.meetingType, r.result.typeAuto], ['sales', false]);
    r = fin('pf2', { meetingType: 'general', typeAuto: false });
    assert.deepStrictEqual([r.result.meetingType, r.result.typeAuto], [undefined, undefined]);
    r = fin('pf3', {});
    assert.deepStrictEqual([r.result.meetingType, r.result.typeAuto], [undefined, undefined]);
    const rec = call(db, 'meeting.recover', { pageId: 'pf4', segments: [], page: { title: titleAt('2026-10-19T00:00:00.000Z'), memo: '', blocks: [], createdAt: '2026-10-19T00:00:00.000Z', recovered: true, meetingType: 'present', typeAuto: false } }, 'main');
    assert.deepStrictEqual([rec.result.page.meetingType, rec.result.page.typeAuto], ['present', false]);
  } finally { t.done(); }
});
