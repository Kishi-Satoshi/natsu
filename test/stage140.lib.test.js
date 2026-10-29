/*
 * stage140.lib.test.js — 0.14.0「編集の動き その2」の純粋な部品（計画 docs/plans/2026-10-26-140.md の Task EB-1）
 * 文字の飾り（src/richText.js: 付け外す・色・リンクの照らし・打って変える記法・自分の span の木から読み戻す・［コピー］の Markdown）と、
 * 元に戻す（src/db/ops.js の invertOps・opsMatch、src/undoBook.js のページごとの列）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/richText.js');
const U = require('../src/undoBook.js');
const O = require('../src/db/ops.js');
const V = require('../src/db/validate.js');
const E = require('../src/blockEdit.js');
const natsulink = require('../src/natsulink.js');
const { tmpDb } = require('./helpers/dbtmp');
const { titleAt } = require('./helpers/titles');

const run = (t, ...m) => ({ t, m });

// ---------------------------------------------------------------- 飾りを付け外す（決めたこと 14・18。F101）
test('EB-1・F101: toggleMark の表（一部だけ太字なら全部太字・全部太字なら外す・書記素の境に寄せる・空の範囲は何もしない）と normalizeRich', () => {
  const r = [run('あい'), run('うえ', 'b'), run('お')];
  // 一部だけ太字の所を選んで Ctrl+B → 全部太字
  assert.deepStrictEqual(R.toggleMark(r, 1, 4, 'b'), [run('あ'), run('いうえ', 'b'), run('お')]);
  // 全部太字なら外す
  assert.deepStrictEqual(R.toggleMark(r, 2, 4, 'b'), [run('あいうえお')]);
  assert.deepStrictEqual(R.toggleMark(r, 3, 4, 'b'), [run('あい'), run('う', 'b'), run('えお')]);
  // ほかの飾りは残す（順は決まった順）
  assert.deepStrictEqual(R.toggleMark([run('ab', 'i')], 0, 2, 'b'), [run('ab', 'b', 'i')]);
  // 「𠮷」（サロゲートの対）と絵文字の途中の位置は書記素の境に寄せる（途中なら次の境へ）
  assert.deepStrictEqual(R.toggleMark([run('𠮷野家')], 1, 3, 'b'), [run('𠮷'), run('野', 'b'), run('家')]);
  assert.deepStrictEqual(R.toggleMark([run('a👍🏽b')], 0, 2, 'i'), [run('a👍🏽', 'i'), run('b')]);
  // 空の範囲は何もしない（逆さの範囲も同じ範囲として扱う）
  assert.deepStrictEqual(R.toggleMark(r, 2, 2, 'b'), r);
  assert.deepStrictEqual(R.toggleMark([run('𠮷')], 1, 1, 'b'), [run('𠮷')]);
  assert.deepStrictEqual(R.toggleMark(r, 4, 1, 'b'), R.toggleMark(r, 1, 4, 'b'));
  // コードを付けると、その所のリンクは外れる（code と link は同じ区切りに持てない）
  assert.deepStrictEqual(R.toggleMark([run('ab', ['link', 'https://example.com/'])], 0, 2, 'code'), [run('ab', 'code')]);
  assert.throws(() => R.toggleMark(r, 0, 1, 'color'));
  // normalizeRich: 空の区切りを落とす・飾りの順・同じ飾りの重なりを1つ・隣の同じ飾りは1つ・飾りが無ければ null
  assert.deepStrictEqual(R.normalizeRich([run('a', 'i', 'b'), run(''), run('b', 'b', 'i', 'b'), run('c')]), [run('ab', 'b', 'i'), run('c')]);
  assert.deepStrictEqual(R.normalizeRich([run('a', ['link', 'https://x.example/']), run('b', ['link', 'https://x.example/'])]), [run('ab', ['link', 'https://x.example/'])]);
  assert.strictEqual(R.normalizeRich([run('a'), run('b')]), null);
  assert.strictEqual(R.normalizeRich([]), null);
  assert.strictEqual(R.normalizeRich(null), null);
  assert.strictEqual(R.normalizeRich(R.toggleMark([run('ab', 'b')], 0, 2, 'b')), null, '飾りを全部外したら null');
  // richOf・plainOf（validate.richText と同じ答え）
  assert.deepStrictEqual(R.richOf({ text: '素の文' }), [run('素の文')]);
  assert.deepStrictEqual(R.richOf({ text: '', rich: null }), []);
  assert.deepStrictEqual(R.richOf({ text: 'x', rich: [{ t: 'a' }, { t: 'b', m: ['b'] }] }), [run('a'), run('b', 'b')]);
  const sample = [run('一', 'b'), { t: '二' }, run('三', ['color', 'red'])];
  assert.strictEqual(R.plainOf(sample), V.richText(sample));
  assert.deepStrictEqual([...R.MARKS], ['b', 'i', 'u', 's', 'code']);
  assert.deepStrictEqual([...R.COLORS], ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']);
});

test('EB-1: setColor・setLink・insertRich・sliceRich・marksAt の表（コードとリンクの終わりでは引き継がない・code と link は同じ区切りに持てない）', () => {
  // setColor（色の名前は COLORS だけ・種類は color か bg）
  assert.deepStrictEqual(R.setColor([run('abc')], 1, 2, 'color', 'red'), [run('a'), run('b', ['color', 'red']), run('c')]);
  assert.deepStrictEqual(R.setColor([run('abc')], 0, 3, 'bg', 'yellow'), [run('abc', ['bg', 'yellow'])]);
  assert.throws(() => R.setColor([run('abc')], 0, 1, 'color', 'teal'));
  assert.throws(() => R.setColor([run('abc')], 0, 1, 'font', 'red'));
  // setLink（linkOk でなければ投げる・null で外す・コードの所にリンクを付けるとコードは外れる）
  assert.deepStrictEqual(R.setLink([run('abc')], 0, 2, 'https://example.com/'), [run('ab', ['link', 'https://example.com/']), run('c')]);
  assert.deepStrictEqual(R.setLink([run('ab', ['link', 'https://example.com/']), run('c')], 0, 3, 'mailto:someone'), [run('abc', ['link', 'mailto:someone'])]);
  assert.deepStrictEqual(R.setLink([run('ab', 'b', ['link', 'https://example.com/'])], 0, 2, null), [run('ab', 'b')]);
  assert.deepStrictEqual(R.setLink([run('ab', 'code')], 0, 2, 'https://example.com/'), [run('ab', ['link', 'https://example.com/'])]);
  assert.throws(() => R.setLink([run('abc')], 0, 2, 'javascript:alert(1)'));
  // insertRich（rich はそのまま・素の文字はその所の飾りを引き継ぐ）・sliceRich
  assert.deepStrictEqual(R.insertRich([run('ab', 'b'), run('cd')], 2, [run('X', 'i')]), [run('ab', 'b'), run('X', 'i'), run('cd')]);
  assert.deepStrictEqual(R.insertRich([run('ab', 'b'), run('cd')], 1, 'X'), [run('aXb', 'b'), run('cd')]);
  assert.deepStrictEqual(R.insertRich([run('𠮷')], 1, 'X'), [run('𠮷X')], '書記素の途中に入れた');
  assert.deepStrictEqual(R.sliceRich([run('ab', 'b'), run('cd'), run('ef', 'i')], 1, 5), [run('b', 'b'), run('cd'), run('e', 'i')]);
  assert.deepStrictEqual(R.sliceRich([run('ab', 'b')], 1, 1), []);
  // marksAt: 前の文字の飾りを引き継ぐ。コードとリンクの終わり（と頭）では引き継がない。中では引き継ぐ
  const r = [run('ab', 'b'), run('cd', 'code'), run('ef', ['link', 'https://example.com/']), run('g')];
  assert.deepStrictEqual(R.marksAt(r, 1), ['b']);
  assert.deepStrictEqual(R.marksAt(r, 2), ['b'], '太字の終わりでは引き継ぐ');
  assert.deepStrictEqual(R.marksAt(r, 3), ['code'], 'コードの中');
  assert.deepStrictEqual(R.marksAt(r, 4), [], 'コードの終わりで引き継いだ');
  assert.deepStrictEqual(R.marksAt(r, 5), [['link', 'https://example.com/']], 'リンクの中');
  assert.deepStrictEqual(R.marksAt(r, 6), [], 'リンクの終わりで引き継いだ');
  assert.deepStrictEqual(R.marksAt([run('ab', 'code')], 2), [], '行の終わりのコード');
  assert.deepStrictEqual(R.marksAt([run('ab', 'code')], 0), [], 'コードの頭');
  assert.deepStrictEqual(R.marksAt([run('ab', 'b')], 0), ['b']);
  assert.deepStrictEqual(R.marksAt([], 0), []);
});

test('EB-1・BQ3: setColor は置き換える（1つの区切りに色は1つ・「既定」で全部外れる）', () => {
  // 赤い字の所に黄の背景 → その所は黄の背景だけ（赤い字は外れる）
  assert.deepStrictEqual(R.setColor([run('abc', ['color', 'red'])], 0, 3, 'bg', 'yellow'), [run('abc', ['bg', 'yellow'])]);
  assert.deepStrictEqual(R.setColor([run('abc', 'b', ['color', 'red'])], 1, 2, 'bg', 'yellow'),
    [run('a', 'b', ['color', 'red']), run('b', 'b', ['bg', 'yellow']), run('c', 'b', ['color', 'red'])]);
  // 一部だけ赤い字の範囲に青い字 → 範囲の全部が青い字だけ
  assert.deepStrictEqual(R.setColor([run('a'), run('b', ['color', 'red']), run('c', ['bg', 'gray'])], 0, 3, 'color', 'blue'), [run('abc', ['color', 'blue'])]);
  // 「既定」（null）で色が全部外れる（文字の色も背景の色も。ほかの飾りは残す）
  assert.deepStrictEqual(R.setColor([run('ab', 'i', ['color', 'red']), run('cd', ['bg', 'yellow'])], 0, 4, 'color', null), [run('ab', 'i'), run('cd')]);
  assert.deepStrictEqual(R.setColor([run('ab', ['bg', 'yellow'])], 0, 2, 'bg', null), [run('ab')]);
  // どの区切りにも color と bg が同時に無い（いろいろな順で塗り重ねても）
  let x = [run('いろはにほへと')];
  const steps = [[0, 4, 'color', 'red'], [2, 6, 'bg', 'yellow'], [1, 3, 'color', 'green'], [0, 7, 'bg', 'pink'], [3, 5, 'color', 'blue'], [5, 7, 'bg', 'gray']];
  for (const [s, e, kind, name] of steps) {
    x = R.setColor(x, s, e, kind, name);
    for (const seg of x) {
      const kinds = seg.m.filter((mk) => Array.isArray(mk) && (mk[0] === 'color' || mk[0] === 'bg'));
      assert.ok(kinds.length <= 1, `1つの区切りに色が2つ: ${JSON.stringify(seg)}`);
    }
  }
  assert.strictEqual(R.plainOf(x), 'いろはにほへと');
});

// ---------------------------------------------------------------- 画面の欄の子から読み戻す（決めたこと 17。F101）
test('EB-1・F101: richFromNodes の表（自分の span の木 → 同じ rich・知らない要素は文字だけ・br は改行）', () => {
  const r = [run('素'), run('太', 'b', 'u'), run('赤', ['color', 'red']), run('背', ['bg', 'yellow']), run('コ', 'code'), run('リ', 's', ['link', 'https://example.com/a?b=1'])];
  const tree = R.richTree(r);
  assert.deepStrictEqual(R.richFromNodes(tree), r);
  assert.deepStrictEqual(R.richFromNodes({ tag: 'div', attrs: {}, kids: tree }), r, '欄の箱ごと渡しても同じ');
  assert.deepStrictEqual(R.richTree([run('素の文')]), [{ text: '素の文' }]);
  // 知らない要素（b・font・img）→ 文字だけ（飾りにしない）
  assert.deepStrictEqual(R.richFromNodes([{ tag: 'B', attrs: {}, kids: [{ text: '太' }] }, { tag: 'font', attrs: { color: 'red' }, kids: [{ text: '字' }] }, { tag: 'img', attrs: { src: 'x' }, kids: [] }]), [run('太字')]);
  assert.deepStrictEqual(R.richFromNodes([{ tag: 'i', attrs: {}, kids: [{ text: 'a' }] }, { tag: 'code', attrs: {}, kids: [{ text: 'b' }] }]), [run('ab')]);
  // 自分の span の中の知らない要素は、外の span の飾りだけ
  assert.deepStrictEqual(R.richFromNodes([{ tag: 'span', attrs: { 'data-m': 'b' }, kids: [{ tag: 'u', attrs: {}, kids: [{ text: 'x' }] }] }]), [run('x', 'b')]);
  // br → 改行
  assert.deepStrictEqual(R.richFromNodes([{ text: '一' }, { tag: 'BR', attrs: {}, kids: [] }, { text: '二' }]), [run('一\n二')]);
  // span の印の値も照らす（知らない飾り・色・開けないリンクは捨てる。印の無い span は文字だけ）
  assert.deepStrictEqual(R.richFromNodes([{ tag: 'span', attrs: { 'data-m': 'b x onclick', 'data-color': 'teal', 'data-link': 'javascript:alert(1)' }, kids: [{ text: 'a' }] }]), [run('a', 'b')]);
  assert.deepStrictEqual(R.richFromNodes([{ tag: 'span', attrs: {}, kids: [{ text: 'a' }] }, { tag: 'span', attrs: { style: 'font-weight:700' }, kids: [{ text: 'b' }] }]), [run('ab')]);
  // 入れ子の span は内側の色・リンクが勝つ（1つの区切りに色は1つ・code と link は同じ区切りに持てない）
  assert.deepStrictEqual(R.richFromNodes([{ tag: 'span', attrs: { 'data-color': 'red', 'data-m': 'code' }, kids: [{ tag: 'span', attrs: { 'data-bg': 'gray', 'data-link': 'https://example.com/' }, kids: [{ text: 'a' }] }] }]),
    [run('a', ['bg', 'gray'], ['link', 'https://example.com/'])]);
  assert.deepStrictEqual(R.richFromNodes([]), []);
});

// ---------------------------------------------------------------- 打って変える記法（決めたこと 18・R10）
test('EB-1: inlineShortcut の表（閉じた半角の記号だけ・全角と閉じていないものと語の途中は null）', () => {
  assert.deepStrictEqual(R.inlineShortcut('**大事**'), { mark: 'b', open: 0, close: 4, size: 2 });
  assert.deepStrictEqual(R.inlineShortcut('これは**大事**'), { mark: 'b', open: 3, close: 7, size: 2 });
  assert.deepStrictEqual(R.inlineShortcut('*a*'), { mark: 'i', open: 0, close: 2, size: 1 });
  assert.deepStrictEqual(R.inlineShortcut('値は `x`'), { mark: 'code', open: 3, close: 5, size: 1 });
  assert.deepStrictEqual(R.inlineShortcut('~y~'), { mark: 's', open: 0, close: 2, size: 1 });
  assert.deepStrictEqual(R.inlineShortcut('`a*b*`'), { mark: 'code', open: 0, close: 5, size: 1 });
  for (const s of ['**大事', '大事**', '**大事*', '*大事**', '**', '****', '* a*', '*a *', '＊＊大事＊＊', '＊a＊', '1*2*', '1*2*3', 'a**b**', '*一\n二*', '~~y~~', '~y~~', '', null]) {
    assert.strictEqual(R.inlineShortcut(s), null, JSON.stringify(s));
  }
});

// ---------------------------------------------------------------- リンクの照らし（決めたこと 15・20・33。SEC2・R73）
const LINK_TABLE = [
  ['https://example.com/a?b=1#c', true], ['http://example.com/', true], ['HTTPS://EXAMPLE.COM/', true], ['mailto:someone', true],
  ['natsu://page/p1', true], ['natsu://page/p1#b:b1', true], [natsulink.natsuLink('p1', 't:s1-s2'), true], [natsulink.openUrl('p1', 'b:b2'), true],
  ['javascript:alert(1)', false], ['JavaScript:alert(1)', false], ['JaVaScRiPt:alert(1)', false], [' https://example.com/', false], ['https://example.com/ ', false],
  ['\u3000https://example.com/', false], ['\u0001https://example.com/', false], ['https://exa\u0000mple.com/', false], ['https://example.com/\n', false],
  ['https://example.com/\u007f', false], ['https://example.com/\u0085', false], ['file:///C:/x', false], ['data:text/html,x', false], ['vbscript:x', false],
  // 0.14.0 EB-1 直し（R91）: 途中の空白・向きを変える見えない文字・頭だけは偽
  ['https://exa mple.com/', false], ['https://example.com/a\tb', false], ['https://example.com/\u200e', false], ['https://example.com/\u200f', false],
  ['https://\u202eexample.com/', false], ['https://example.com/\u2066x', false], ['https://example.com/\u2069', false], ['https://', false], ['HTTP://', false],
  ['mailto:', false], ['natsu://page/', false],
  ['natsu://settings', false], ['natsu:page/p1', false], ['//example.com/', false], ['', false], [`https://example.com/${'a'.repeat(2049 - 20)}`, false],
  [`https://example.com/${'a'.repeat(2048 - 20)}`, true],
];
test('EB-1・SEC2: linkOk の表（http(s)・mailto・NaTsu のリンクだけ。大文字の JavaScript: ・前後の空白・制御文字・file: ・data: ・vbscript: ・2049 字は偽）', () => {
  assert.strictEqual(LINK_TABLE[LINK_TABLE.length - 1][0].length, 2048);
  assert.strictEqual(LINK_TABLE[LINK_TABLE.length - 2][0].length, 2049);
  for (const [url, ok] of LINK_TABLE) assert.strictEqual(R.linkOk(url), ok, JSON.stringify(url));
  for (const v of [null, undefined, 1, {}, ['https://example.com/']]) assert.strictEqual(R.linkOk(v), false);
});
test('EB-1・R73（第4版）: linkOk と validate.richText のリンクの照らしが、同じ表で同じ答え（natsu:// の頭・大文字の JavaScript: ・前の空白・制御文字）', () => {
  const dbOk = (url) => { try { V.richText([{ t: 'x', m: [['link', url]] }]); return true; } catch (e) { assert.strictEqual(e.code, 'bad-args'); return false; } };
  for (const [url, ok] of LINK_TABLE) {
    assert.strictEqual(dbOk(url), ok, `DB: ${JSON.stringify(url)}`);
    assert.strictEqual(R.linkOk(url), dbOk(url), JSON.stringify(url));
  }
});

// ---------------------------------------------------------------- ［コピー］の Markdown（決めたこと 22・R13）
test('EB-1: richMarkdown の表（太字・斜体・取り消し・コード・リンク。下線と色は文字だけ。飾りの無い rich は文字そのまま）', () => {
  assert.strictEqual(R.richMarkdown([run('これは'), run('大事', 'b'), run('な'), run('話', 'i')]), 'これは**大事**な*話*');
  assert.strictEqual(R.richMarkdown([run('消し', 's'), run('x', 'code')]), '~~消し~~`x`');
  assert.strictEqual(R.richMarkdown([run('資料', ['link', 'https://example.com/'])]), '[資料](https://example.com/)');
  assert.strictEqual(R.richMarkdown([run('太い資料', 'b', ['link', 'https://example.com/'])]), '[**太い資料**](https://example.com/)');
  assert.strictEqual(R.richMarkdown([run('下線', 'u'), run('赤', ['color', 'red']), run('黄', ['bg', 'yellow'])]), '下線赤黄');
  assert.strictEqual(R.richMarkdown([run('素の文')]), '素の文');
  assert.strictEqual(R.richMarkdown(null), '');
  // 飾りの無い行は、blocksMarkdown の今の4つの型（段の無い見出し・ToDo・箇条書き・テキスト）と1文字も同じ
  const blocks = [{ id: 'h', type: 'heading', text: '見出し' }, { id: 't', type: 'todo', text: 'やる', checked: true }, { id: 'b', type: 'bullet', text: '箇条 *そのまま*' }, { id: 'p', type: 'paragraph', text: '文\n二行目', rich: null }];
  const viaRich = blocks.map((b) => ({ ...b, text: R.richMarkdown(R.richOf(b)) }));
  assert.strictEqual(E.blocksMarkdown(viaRich), E.blocksMarkdown(blocks));
});

// ---------------------------------------------------------------- 操作を後ろへ当てる形（決めたこと 2〜5。F100）
const P = 'pu1';
function rowsNow(db) {
  return db.prepare('select id, type, page_id, parent_id, ord, text, rich, attrs, fold, created_at, updated_at, trashed_at from blocks order by id').all().map((r) => ({ ...r }));
}
function pageOf(blocks, extra = {}) {
  return { id: P, title: titleAt('2026-10-29T00:00:00.000Z'), memo: 'メモ', createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z', ...extra, blocks };
}
const ordsOf = (db) => Object.fromEntries(db.prepare("select id, ord from blocks where page_id = ? and type != 'page'").all(P).map((r) => [r.id, r.ord]));
const viaLog = (ops) => JSON.parse(JSON.stringify(ops));   // oplog に入れて読み直した形

test('EB-1・F100: invertOps・opsMatch の表（add・trash・move・set・text・retype を前へ当てて後ろの形を当てると元の表と同じ。ページの行の trash・restore・purge・seg は投げる。‡131 親の変わる move と子ごとの trash）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const a = pageOf([
      { id: 'b1', type: 'bullet', text: '一' },
      { id: 'b2', type: 'toggle', text: '二', open: false, children: [{ id: 'b21', type: 'bullet', text: '二の子', cites: ['s1'] }, { id: 'b22', type: 'todo', text: '二の子その二', checked: false }] },
      { id: 'b3', type: 'paragraph', text: '三', rich: [{ t: '三', m: ['b'] }] },
      { id: 'b4', type: 'bullet', text: '四', children: [{ id: 'b41', type: 'bullet', text: '四の子' }] },
    ]);
    O.applyOps(db, O.diffPage(null, a));
    const before = rowsNow(db);
    // 文・型・欄・rich を変え、行を足し、親の変わる move（b22 を最上位へ・b1 を b3 の子へ）、子ごと消す（b4 と b41）
    const b = pageOf([
      { id: 'b2', type: 'toggle', text: '二', open: false, children: [{ id: 'b21', type: 'todo', text: '二の子を直した', cites: ['s1'], assignee: '担当' }] },
      { id: 'b22', type: 'todo', text: '二の子その二', checked: true },
      { id: 'b3', type: 'paragraph', text: '三と', rich: [{ t: '三', m: ['b'] }, { t: 'と' }], children: [{ id: 'b1', type: 'bullet', text: '一' }] },
      { id: 'b5', type: 'heading', text: '足した見出し', citeState: 'manual' },
    ], { memo: '直したメモ', updatedAt: '2026-10-29T01:00:00.000Z', summaryEdited: true, citeStat: { n: 1 } });
    const ops = viaLog(O.diffPage(a, b, { ords: ordsOf(db) }));
    const kinds = new Set(ops.map((o) => o.op));
    for (const k of ['add', 'trash', 'move', 'set', 'text', 'retype']) assert.ok(kinds.has(k), `見本に ${k} が無い`);
    assert.ok(ops.some((o) => o.op === 'move' && typeof o.parent === 'string' && typeof o.oldParent === 'string'), '見本に親の変わる move が無い');
    assert.deepStrictEqual(ops.filter((o) => o.op === 'trash').map((o) => o.id).sort(), ['b4', 'b41'], '子ごとの trash が無い');
    O.applyOps(db, ops, 'forward');
    const after = rowsNow(db);
    assert.notDeepStrictEqual(after, before);
    assert.strictEqual(O.opsMatch(db, ops), true, '当てたばかりの操作が今の表と合わない');
    // 後ろの形を前へ当てると元の表と同じ（ページの行の欄も全部戻す形）
    const inv = O.invertOps(ops);
    assert.ok(Array.isArray(inv) && inv.length === ops.length);
    O.applyOps(db, viaLog(inv), 'forward');
    assert.deepStrictEqual(rowsNow(db), before, '後ろの形を当てても元の表に戻らない');
    assert.strictEqual(O.opsMatch(db, ops), false, '戻した後も「後の値」が今と同じと言う');
    assert.strictEqual(O.opsMatch(db, inv), true);
    // 後ろの形の後ろの形はやり直し（前と同じ表）
    O.applyOps(db, viaLog(O.invertOps(inv)), 'forward');
    assert.deepStrictEqual(rowsNow(db).map((r) => ({ ...r, fold: undefined })), after.map((r) => ({ ...r, fold: undefined })));
    // 後から変わっていたら合わない（文・並び・型・消した行が戻っている）
    O.applyOps(db, [{ op: 'text', id: 'b5', value: 'ほかで直した', old: '足した見出し' }]);
    assert.strictEqual(O.opsMatch(db, ops), false, 'ほかで直した文に気づかない');
    O.applyOps(db, [{ op: 'text', id: 'b5', value: '足した見出し', old: 'ほかで直した' }]);
    assert.strictEqual(O.opsMatch(db, ops), true);
    const ord5 = db.prepare("select ord from blocks where id = 'b5'").get().ord;
    O.applyOps(db, [{ op: 'move', id: 'b5', ord: 'zz', old: ord5 }]);
    assert.strictEqual(O.opsMatch(db, ops), false, 'ほかで動かした並びに気づかない');
    O.applyOps(db, [{ op: 'move', id: 'b5', ord: ord5, old: 'zz' }]);
    O.applyOps(db, [{ op: 'retype', id: 'b21', value: 'bullet', old: 'todo' }]);
    assert.strictEqual(O.opsMatch(db, ops), false, 'ほかで変えた型に気づかない');
    O.applyOps(db, [{ op: 'retype', id: 'b21', value: 'todo', old: 'bullet' }]);
    O.applyOps(db, [{ op: 'set', id: 'b21', key: 'assignee', value: 'ほかの担当', old: '担当' }]);
    assert.strictEqual(O.opsMatch(db, ops), false, 'ほかで変えた欄に気づかない');
    O.applyOps(db, [{ op: 'set', id: 'b21', key: 'assignee', value: '担当', old: 'ほかの担当' }]);
    O.applyOps(db, [{ op: 'set', id: 'b5', key: 'checked', value: true }]);
    assert.strictEqual(O.opsMatch(db, ops), false, '足した行にほかで足した欄に気づかない');
    O.applyOps(db, [{ op: 'set', id: 'b5', key: 'checked', old: true }]);
    assert.strictEqual(O.opsMatch(db, ops), true);
    // ページの行の trash・restore・purge・seg、ページの行の add は後ろの形を作れない（投げる）
    for (const bad of [
      { op: 'trash', id: P, at: '2026-10-29T02:00:00.000Z', old: null }, { op: 'restore', id: P, at: null, old: '2026-10-29T02:00:00.000Z' },
      { op: 'purge', id: P }, { op: 'seg', id: 's1', page: P, n: 0, value: { id: 's1', text: 'x' }, old: null, oldN: null },
      { op: 'add', id: 'p9', row: O.pageRow({ id: 'p9', title: titleAt('2026-10-29T03:00:00.000Z') }) }, { op: 'nope', id: 'b1' }, { id: 'b1' },
    ]) {
      assert.throws(() => O.invertOps([...ops, bad]), JSON.stringify(bad));
      assert.throws(() => O.opsMatch(db, [bad]), JSON.stringify(bad));
    }
    assert.throws(() => O.invertOps(null));
  } finally { t.done(); }
});

test('EB-1・G1・R60（第4版）: opsMatch は open（VIEW_KEYS。add の行の中の open も）・citeSkip・ページの行の summaryEdited・updatedAt・citeStat を比べない。invertOps はページの行の set を memo・memoDoc のほかは外す（summaryEdited の set が後ろの列に無い）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const a = pageOf([{ id: 'b1', type: 'bullet', text: '一' }]);
    O.applyOps(db, O.diffPage(null, a));
    // 歩み: トグルを閉じた形で足す・b1 の文を直す・メモを直す（ページの行の印と時刻も変わる）
    const b = pageOf([{ id: 'b1', type: 'bullet', text: '一を直した' }, { id: 'b2', type: 'toggle', text: '足したトグル', open: false }],
      { memo: '直したメモ', memoDoc: [{ id: 'm1', type: 'paragraph', text: '直したメモ' }], updatedAt: '2026-10-29T01:00:00.000Z', summaryEdited: true, citeStat: { n: 0 } });
    const ops = viaLog(O.diffPage(a, b, { ords: ordsOf(db) }));
    O.applyOps(db, ops, 'forward');
    assert.strictEqual(O.opsMatch(db, ops), true);
    // 後の命令が見た目だけの欄・短い行の印・ページの印と時刻と出典の数を変えても、合う
    O.applyOps(db, [{ op: 'set', id: 'b2', key: 'open', value: true, old: false }]);
    assert.strictEqual(O.opsMatch(db, ops), true, '足した行を開いただけで合わない（G1）');
    O.applyOps(db, [{ op: 'set', id: 'b1', key: 'open', value: false }]);
    O.applyOps(db, [{ op: 'set', id: 'b1', key: 'citeSkip', value: true }, { op: 'set', id: 'b2', key: 'citeSkip', value: true }]);
    assert.strictEqual(O.opsMatch(db, ops), true, '短い行の印で合わない');
    O.applyOps(db, [
      { op: 'set', id: P, key: 'summaryEdited', value: undefined, old: true }, { op: 'set', id: P, key: 'citeStat', value: { n: 9 }, old: { n: 0 } },
      { op: 'set', id: P, key: 'updatedAt', value: '2026-10-29T09:00:00.000Z', old: '2026-10-29T01:00:00.000Z' },
    ]);
    assert.strictEqual(O.opsMatch(db, ops), true, 'ページの印・時刻・出典の数で合わない');
    // メモ（memo・memoDoc）は比べる
    O.applyOps(db, [{ op: 'set', id: P, key: 'memo', value: 'ほかで直したメモ', old: '直したメモ' }]);
    assert.strictEqual(O.opsMatch(db, ops), false, 'ほかで直したメモに気づかない');
    O.applyOps(db, [{ op: 'set', id: P, key: 'memo', value: '直したメモ', old: 'ほかで直したメモ' }]);
    assert.strictEqual(O.opsMatch(db, ops), true);
    // invertOps({ pageId }) はページの行の set を memo・memoDoc だけ残す（ブロックの行の set は全部）
    const pageSets = ops.filter((o) => o.op === 'set' && o.id === P).map((o) => o.key).sort();
    assert.deepStrictEqual(pageSets, ['citeStat', 'memo', 'memoDoc', 'summaryEdited', 'updatedAt'], '見本のページの行の set');
    const inv = O.invertOps(ops, { pageId: P });
    assert.deepStrictEqual(inv.filter((o) => o.op === 'set' && o.id === P).map((o) => o.key).sort(), ['memo', 'memoDoc']);
    assert.ok(!inv.some((o) => o.key === 'summaryEdited'), 'summaryEdited の set が後ろの列にある');
    assert.strictEqual(inv.length, ops.length - 3);
    O.applyOps(db, viaLog(inv), 'forward');
    const pg = db.prepare('select attrs, updated_at from blocks where id = ?').get(P);
    const attrs = JSON.parse(pg.attrs);
    assert.strictEqual(attrs.memo, 'メモ');
    assert.strictEqual(attrs.memoDoc, undefined);
    assert.strictEqual(pg.updated_at, '2026-10-29T09:00:00.000Z', '時刻を前の値に戻した');
    assert.deepStrictEqual(attrs.citeStat, { n: 9 }, '出典の数を前の値に戻した');
    assert.ok(!db.prepare("select 1 from blocks where id = 'b2'").get(), '足した行が残った');
    assert.strictEqual(db.prepare("select text from blocks where id = 'b1'").get().text, '一');
  } finally { t.done(); }
});

// ---------------------------------------------------------------- ページごとの元に戻すの列（決めたこと 7・BQ1 (a)・BQ22 (a)）
test('EB-1: undoBook の表（ページごと・欄ごと・100 歩まで・新しい歩みでやり直しが空・bookDrop・UNDO_CMDS に block.setOpen が無い）', () => {
  assert.strictEqual(U.UNDO_MAX, 100);
  assert.strictEqual(U.TYPE_PAUSE_MS, 2000);
  for (const c of ['block.update', 'block.insert', 'block.remove', 'block.move', 'block.setAction', 'block.split', 'block.merge', 'block.turnInto', 'block.duplicate', 'block.indent',
    'block.paste', 'blocks.remove', 'blocks.move', 'blocks.duplicate', 'blocks.turnInto', 'blocks.setColor', 'page.setMemoDoc', 'edit.revert']) assert.ok(U.UNDO_CMDS.has(c), c);
  for (const c of ['block.setOpen', 'block.setOpenAll', 'page.setTitle', 'page.setMemo', 'page.setType', 'page.get', 'segment.update', 'page.put']) assert.ok(!U.UNDO_CMDS.has(c), c);
  const k1 = U.bookKey('p1', 'note');
  const k2 = U.bookKey('p2', 'note');
  const m1 = U.bookKey('p1', 'memo');
  assert.notStrictEqual(k1, m1);
  let book = {};
  book = U.bookPush(book, k1, ['a:tx1']);
  book = U.bookPush(book, k1, ['a:tx2', 'a:tx3']);
  book = U.bookPush(book, k2, ['a:tx9']);
  book = U.bookPush(book, m1, [], { literal: { before: 'x', after: 'y' } });
  assert.strictEqual(U.bookPush(book, k1, []), book, '空の歩みを積んだ');
  // ページごと・欄ごと（p2 と p1 のメモの列は p1 の要約の列と別）
  let r = U.bookTakeUndo(book, k1);
  assert.deepStrictEqual(r.entry, { steps: ['a:tx2', 'a:tx3'] });
  book = U.bookDone(r.book, k1, 'undo', 'a:rv1');
  assert.deepStrictEqual(U.bookTakeUndo(book, k2).entry, { steps: ['a:tx9'] });
  assert.deepStrictEqual(U.bookTakeUndo(book, m1).entry, { steps: [], literal: { before: 'x', after: 'y' } });
  // やり直しは戻した歩み（edit.revert の tx）。やり直した歩みは元に戻すの列へ（やり直しの列は残る）
  r = U.bookTakeRedo(book, k1);
  assert.deepStrictEqual(r.entry, { steps: ['a:rv1'] });
  book = U.bookDone(r.book, k1, 'redo', 'a:rv2');
  assert.deepStrictEqual(U.bookTakeUndo(book, k1).entry, { steps: ['a:rv2'] });
  assert.strictEqual(U.bookTakeRedo(book, k1).entry, null);
  // 新しい歩みが入るとそのページのやり直しは空（ほかのページのやり直しは残る）
  r = U.bookTakeUndo(book, k1); book = U.bookDone(r.book, k1, 'undo', 'a:rv3');
  r = U.bookTakeUndo(book, k2); book = U.bookDone(r.book, k2, 'undo', 'a:rv4');
  assert.deepStrictEqual(U.bookTakeRedo(book, k1).entry, { steps: ['a:rv3'] });
  book = U.bookPush(book, k1, ['a:tx5']);
  assert.strictEqual(U.bookTakeRedo(book, k1).entry, null, '新しい歩みでやり直しが空にならない');
  assert.deepStrictEqual(U.bookTakeRedo(book, k2).entry, { steps: ['a:rv4'] });
  // 窓のメモリの memo の戻しは literal の向きを入れ替えて反対の列へ
  r = U.bookTakeUndo(book, m1);
  book = U.bookDone(r.book, m1, 'undo', { literal: { before: 'y', after: 'x' } });
  assert.deepStrictEqual(U.bookTakeRedo(book, m1).entry, { steps: [], literal: { before: 'y', after: 'x' } });
  // 100 歩まで（古いものから捨てる）
  let big = {};
  for (let i = 1; i <= 105; i++) big = U.bookPush(big, k1, [`a:tx${i}`]);
  const seen = [];
  for (let e = U.bookTakeUndo(big, k1); e.entry; e = U.bookTakeUndo(e.book, k1)) seen.push(e.entry.steps[0]);
  assert.strictEqual(seen.length, 100);
  assert.strictEqual(seen[0], 'a:tx105');
  assert.strictEqual(seen[99], 'a:tx6');
  // bookDrop: 鍵1つ（再生成は要約の列だけ）・ページの ID で全部の欄（stale）
  let d = U.bookDrop(book, k1);
  assert.strictEqual(U.bookTakeUndo(d, k1).entry, null);
  assert.ok(U.bookTakeRedo(d, m1).entry, '要約の列を空にしてメモの列も消えた');
  d = U.bookDrop(book, 'p1');
  assert.strictEqual(U.bookTakeUndo(d, k1).entry, null);
  assert.strictEqual(U.bookTakeRedo(d, m1).entry, null);
  assert.ok(U.bookTakeRedo(d, k2).entry, 'ほかのページの列まで消えた');
  // 元の book は変えない（純粋）
  assert.deepStrictEqual(U.bookTakeUndo(book, k1).entry, { steps: ['a:tx5'] });
  assert.strictEqual(U.bookTakeUndo({}, k1).entry, null);
});

// ---------------------------------------------------------------- 0.14.0 EB-1 直し（2026-10-29 の点検。R90〜R95）
test('EB-1 直し・I1: richText・blockEdit・grapheme は互いに循環して読まない（書記素の境は src/grapheme.js の1か所）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  assert.ok(!/require\(/.test(src('grapheme.js')), 'grapheme.js が何かを読む');
  assert.ok(!/require\('\.\/blockEdit'\)/.test(src('richText.js')), 'richText が blockEdit を読む（blockEdit が richText を読むと循環する）');
  assert.ok(/require\('\.\/grapheme'\)/.test(src('richText.js')) && /require\('\.\/grapheme'\)/.test(src('blockEdit.js')));
  const { spawnSync } = require('node:child_process');
  for (const order of [['blockEdit', 'richText'], ['richText', 'blockEdit'], ['db/validate', 'richText']]) {
    const code = `${order.map((m) => `require('./src/${m}')`).join(';')};const R=require('./src/richText');process.stdout.write(JSON.stringify(R.toggleMark([{t:'𠮷野',m:[]}],1,3,'b')))`;
    const r = spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    assert.strictEqual(r.stdout, '[{"t":"𠮷","m":[]},{"t":"野","m":["b"]}]', `${order.join(' → ')}: ${r.stderr}`);
  }
  assert.strictEqual(E.safeOffset, require('../src/grapheme.js').safeOffset);
});

test('EB-1 直し・I2: invertOps はブロックの行の citeSkip と見た目だけの欄 open の set を戻さない（ページの行の memo は戻す）', () => {
  const ops = [
    { op: 'text', id: 'b1', value: '直した', old: '前' },
    { op: 'set', id: 'b1', key: 'citeSkip', value: true },
    { op: 'set', id: 'b3', key: 'citeSkip', value: undefined, old: true },
    { op: 'set', id: 'b2', key: 'open', value: false, old: true },
    { op: 'set', id: 'b2', key: 'assignee', value: '担当', old: '' },
    { op: 'set', id: P, key: 'memo', value: '後', old: '前' },
  ];
  for (const pageId of [P, undefined]) {
    const inv = O.invertOps(ops, { pageId });
    assert.deepStrictEqual(inv.filter((o) => o.op === 'set').map((o) => `${o.id}:${o.key}`), [`${P}:memo`, 'b2:assignee'], String(pageId));
    assert.deepStrictEqual(inv[inv.length - 1], { op: 'text', id: 'b1', value: '前', old: '直した' });
  }
});

test('EB-1 直し・I3: opsMatch は、消した行が戻っている・直した行が後から消えた・親の変わる move の親・同じ行に足してから直した欄・ページの createdAt を見る', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    O.applyOps(db, O.diffPage(null, pageOf([{ id: 'b1', type: 'bullet', text: '一' }, { id: 'b2', type: 'bullet', text: '二' }, { id: 'p', type: 'toggle', text: '親' }])));
    const row = (id) => ({ ...db.prepare('select id, type, page_id, parent_id, ord, text, rich, attrs, created_at, updated_at, trashed_at, rev from blocks where id = ?').get(id) });
    // (a) 消した行が後から戻った（同じ ID の行がある）→ 合わない（当てると ID が重なる）
    const b2 = row('b2'); b2.attrs = JSON.parse(b2.attrs);
    const del = [{ op: 'trash', id: 'b2', old: b2 }];
    O.applyOps(db, del);
    assert.strictEqual(O.opsMatch(db, del), true);
    O.applyOps(db, [{ op: 'add', id: 'b2', row: b2 }]);
    assert.strictEqual(O.opsMatch(db, del), false, '消した行が戻っているのに合う');
    // (b) 直した行が後から消えた → 合わない
    const fix = [{ op: 'text', id: 'b2', value: '二を直した', old: '二' }];
    O.applyOps(db, fix);
    assert.strictEqual(O.opsMatch(db, fix), true);
    O.applyOps(db, del.map((o) => ({ ...o, old: { ...b2, text: '二を直した' } })));
    assert.strictEqual(O.opsMatch(db, fix), false, '後から消えた行に合う');
    // (c) 親の変わる move: 鍵が同じでも親が違えば合わない
    const ord1 = row('b1').ord;
    const into = [{ op: 'move', id: 'b1', ord: 'm', old: ord1, parent: 'p', oldParent: P }];
    O.applyOps(db, into);
    assert.strictEqual(O.opsMatch(db, into), true);
    db.prepare("update blocks set parent_id = ? where id = 'b1'").run(P);
    assert.strictEqual(O.opsMatch(db, into), false, '親が戻っているのに合う');
    // (d) 同じ歩みで足してから欄を直した行は、足した行の欄に直しを重ねて比べる
    const nb = O.blockRow({ id: 'b9', type: 'todo', text: '足した', cites: [] }, P, 'w');
    const addFix = [{ op: 'add', id: 'b9', row: nb }, { op: 'set', id: 'b9', key: 'assignee', value: '担当' }, { op: 'set', id: 'b9', key: 'cites', value: undefined, old: [] }];
    O.applyOps(db, addFix);
    assert.strictEqual(O.opsMatch(db, addFix), true, '足してから直した行に合わない');
    O.applyOps(db, [{ op: 'set', id: 'b9', key: 'assignee', value: 'ほか', old: '担当' }]);
    assert.strictEqual(O.opsMatch(db, addFix), false);
    // (e) ページの行の createdAt（列）は比べる
    const created = [{ op: 'set', id: P, key: 'createdAt', value: '2026-10-29T05:00:00.000Z', old: '2026-10-29T00:00:00.000Z' }];
    O.applyOps(db, created);
    assert.strictEqual(O.opsMatch(db, created), true);
    O.applyOps(db, [{ op: 'set', id: P, key: 'createdAt', value: '2026-10-29T06:00:00.000Z', old: '2026-10-29T05:00:00.000Z' }]);
    assert.strictEqual(O.opsMatch(db, created), false, 'ほかで変わった作った時刻に合う');
  } finally { t.done(); }
});

test('EB-1 直し・I5: richMarkdown は区切りの頭と終わりの空白を記号の外に出し、リンクの住所の括弧・空白を %xx にする。飾りの無い文は1文字も同じ', () => {
  assert.strictEqual(R.richMarkdown([run('a ', 'b'), run('b')]), '**a** b');
  assert.strictEqual(R.richMarkdown([run(' 大事 ', 'i', 's'), run('な話')]), ' *~~大事~~* な話');
  assert.strictEqual(R.richMarkdown([run('  ', 'b'), run('x')]), '  x', '空白だけの区切りに記号を付けた');
  assert.strictEqual(R.richMarkdown([run('資料', ['link', 'https://example.com/a_(b)'])]), '[資料](https://example.com/a_%28b%29)');
  for (const t of [' 前の空白 ', '*そのまま* と `記号`', '　全角の空白　']) assert.strictEqual(R.richMarkdown([run(t)]), t);
});

test('EB-1 直し・M1: normalizeRich は DB の照らしと同じ形にそろえる（開けないリンク・2つ目の色・コードのある区切りのリンクを落とす）', () => {
  assert.deepStrictEqual(R.normalizeRich([run('a', ['link', 'javascript:alert(1)'], 'b')]), [run('a', 'b')]);
  assert.deepStrictEqual(R.normalizeRich([run('a', ['bg', 'yellow'], ['color', 'red'])]), [run('a', ['color', 'red'])]);
  assert.deepStrictEqual(R.normalizeRich([run('a', ['color', 'red'], ['color', 'blue'])]), [run('a', ['color', 'blue'])]);
  assert.deepStrictEqual(R.normalizeRich([run('a', 'code', ['link', 'https://example.com/'])]), [run('a', 'code')]);
  for (const r of [[run('a', ['link', 'javascript:x'], 'b')], [run('a', ['bg', 'yellow'], ['color', 'red'])], [run('a', 'code', ['link', 'https://example.com/'])]]) {
    assert.doesNotThrow(() => V.richText(R.normalizeRich(r)), JSON.stringify(r));
  }
});

test('EB-1 直し・M3・M6: marksAt は前の書記素の頭の字の飾りを読む。spanMarks は文字の色と背景の色が両方あっても1つ。bookDrop の p1 は p10 を消さない。bookDone も 100 歩まで', () => {
  assert.deepStrictEqual(R.marksAt([run('か', 'b'), run('゙')], 2), ['b'], '結合文字だけの区切りの飾りを読んだ');
  assert.deepStrictEqual(R.richFromNodes({ tag: 'span', attrs: { 'data-color': 'red', 'data-bg': 'yellow' }, kids: [{ text: 'x' }] }), [run('x', ['color', 'red'])]);
  const kp1 = U.bookKey('p1', 'note'); const kp10 = U.bookKey('p10', 'note');
  let book = U.bookPush(U.bookPush({}, kp1, ['a:tx1']), kp10, ['a:tx2']);
  book = U.bookDrop(book, 'p1');
  assert.strictEqual(U.bookTakeUndo(book, kp1).entry, null);
  assert.deepStrictEqual(U.bookTakeUndo(book, kp10).entry, { steps: ['a:tx2'] }, 'p1 で p10 の列も消えた');
  let done = {};
  for (let i = 1; i <= 105; i++) done = U.bookDone(done, kp1, 'undo', `a:rv${i}`);
  let n = 0;
  for (let e = U.bookTakeRedo(done, kp1); e.entry; e = U.bookTakeRedo(e.book, kp1)) n++;
  assert.strictEqual(n, 100, 'bookDone が 100 歩を越えて積んだ');
});
