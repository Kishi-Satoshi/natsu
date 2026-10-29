/*
 * stage140.lib.test.js — 0.14.0「編集の動き その2」の純粋な部品（計画 docs/plans/2026-10-26-140.md の Task EB-1）
 * 文字の飾り（src/richText.js: 付け外す・色・リンクの照らし・打って変える記法・自分の span の木から読み戻す・［コピー］の Markdown）と、
 * 元に戻す（src/db/ops.js の invertOps・opsMatch、src/undoBook.js のページごとの列）。
 * Task EK-1: 貼り付けの変換（src/pasteConvert.js: Word・Web・Teams の HTML、Markdown、素の文字 → 行と飾り。危ないものは落とし、色は落とし、2,000 行・1MB まで）。
 * 種の HTML は test/fixtures/paste/ にある（自分で書いた Word・Edge・Teams・Google ドキュメントの形。実在の人名・社名は使わない）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/richText.js');
const U = require('../src/undoBook.js');
const O = require('../src/db/ops.js');
const V = require('../src/db/validate.js');
const E = require('../src/blockEdit.js');
const PC = require('../src/pasteConvert.js');
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

test('EB-4 直し・M2（R114）: richMarkdown は隣の区切りに続く同じ飾りを1つの記号で包み、飾りのある行の記号を逃がし、コードは中の ` より長い ` で囲む。飾りの無い文は逃がさない', () => {
  const L = ['link', 'https://example.com/'];
  assert.strictEqual(R.richMarkdown([run('ab', 'b'), run('cd', 'b', 'i')]), '**ab*cd***', '同じ太字を2つの記号で包んだ（**ab*****cd***）');
  assert.strictEqual(R.richMarkdown([run('ab', 'i'), run('cd', 'b', 'i'), run('ef', 'i')]), '*ab**cd**ef*');
  // 交わる飾り（太字は ab〜cd・斜体は cd〜ef）は包みの記号が4つ並ぶので、間に幅の無い空白（U+200B）を入れる。3つまでは入れない
  assert.strictEqual(R.richMarkdown([run('ab', 'b'), run('cd', 'b', 'i'), run('ef', 'i')]), '**ab*cd***\u200b*ef*');
  assert.strictEqual(R.richMarkdown([run('太字', 'b'), run('斜体', 'i')]), '**太字***斜体*');
  assert.strictEqual(R.richMarkdown([run('資料', L), run('と表', 'b', L)]), '[資料**と表**](https://example.com/)');
  assert.strictEqual(R.richMarkdown([run('a]b[c', L)]), '[a\\]b\\[c](https://example.com/)');
  assert.strictEqual(R.richMarkdown([run('x', 'b'), run(' 2*3_4~5 \\ `')]), '**x** 2\\*3\\_4\\~5 \\\\ \\`');
  assert.strictEqual(R.richMarkdown([run('*大事*', 'b')]), '**\\*大事\\***');
  assert.strictEqual(R.richMarkdown([run('a`b', 'code')]), '``a`b``');
  assert.strictEqual(R.richMarkdown([run('`x', 'code')]), '`` `x ``');
  assert.strictEqual(R.richMarkdown([run('a``b', 'code'), run('c', 'b')]), '```a``b```**c**');
  assert.strictEqual(R.richMarkdown([run('*そのまま* と `記号` [x](y)')]), '*そのまま* と `記号` [x](y)', '飾りの無い文を逃がした');
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

// ---------------------------------------------------------------- EB-4（決めたこと 17・18・22・R13）: 行の近道と［コピー］の Markdown
const K4 = (o) => E.keyAction({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false, key: '', code: '', ...o });
test('EB-4・F101: keyAction の飾りの近道は ev.code で見る（JIS・key が違っても同じ）。Ctrl+B・I・U・Ctrl+Shift+S・Ctrl+E と、Ctrl+K・Ctrl+Shift+H（EB-5 の口）。変換中・Alt つき・Shift の違う組は null', () => {
  assert.strictEqual(K4({ ctrlKey: true, code: 'KeyB', key: 'b' }), 'mark:b');
  assert.strictEqual(K4({ ctrlKey: true, code: 'KeyI', key: 'i' }), 'mark:i');
  assert.strictEqual(K4({ ctrlKey: true, code: 'KeyU', key: 'u' }), 'mark:u');
  assert.strictEqual(K4({ ctrlKey: true, shiftKey: true, code: 'KeyS', key: 'S' }), 'mark:s');
  assert.strictEqual(K4({ ctrlKey: true, code: 'KeyE', key: 'e' }), 'mark:code');
  assert.strictEqual(K4({ ctrlKey: true, code: 'KeyK', key: 'k' }), 'link');
  assert.strictEqual(K4({ ctrlKey: true, shiftKey: true, code: 'KeyH', key: 'H' }), 'colorAgain');
  // key でなく code で見る（日本語入力のまま・配列の違い）
  assert.strictEqual(K4({ ctrlKey: true, code: 'KeyB', key: 'こ' }), 'mark:b');
  assert.strictEqual(K4({ ctrlKey: true, code: 'KeyI', key: '' }), 'mark:i');
  for (const o of [{ ctrlKey: true, code: 'KeyB', key: 'b', isComposing: true }, { ctrlKey: true, code: 'KeyB', key: 'b', keyCode: 229 },
    { ctrlKey: true, shiftKey: true, code: 'KeyB', key: 'B' }, { ctrlKey: true, code: 'KeyS', key: 's' }, { ctrlKey: true, code: 'KeyH', key: 'h' },
    { ctrlKey: true, shiftKey: true, code: 'KeyE', key: 'E' }, { ctrlKey: true, altKey: true, code: 'KeyB', key: 'b' }, { code: 'KeyB', key: 'b' },
    { ctrlKey: true, metaKey: true, code: 'KeyB', key: 'b' }, { ctrlKey: true, code: 'KeyZ', key: 'z' }, { ctrlKey: true, code: 'KeyY', key: 'y' }]) {
    assert.strictEqual(K4(o), null, JSON.stringify(o));
  }
});
test('EB-4・R13（決めたこと 22）: blocksMarkdown は rich の行を richMarkdown で写す（太字・リンク・子の字下げ・見出しは下げない）。飾りの無い行は今と1文字も同じ', () => {
  const link = ['link', 'https://example.com/a'];
  const blocks = [
    { id: 'h', type: 'heading', level: 2, text: '大事な見出し', rich: [run('大事', 'b'), run('な見出し')] },
    { id: 'b', type: 'bullet', text: '資料を見る', rich: [run('資料', link), run('を見る')], children: [
      { id: 'c', type: 'todo', text: '下線と赤', checked: false, rich: [run('下線', 'u'), run('と'), run('赤', ['color', 'red'])] },
      { id: 'd', type: 'paragraph', text: 'コード x と消し', rich: [run('コード '), run('x', 'code'), run(' と'), run('消し', 's')] },
    ] },
    { id: 'p', type: 'paragraph', text: '一行目\n二行目', rich: [run('一行目', 'i'), run('\n二行目')] },
  ];
  assert.strictEqual(E.blocksMarkdown(blocks), [
    '\n## **大事**な見出し',
    '- [資料](https://example.com/a)を見る',
    '  - [ ] 下線と赤',
    '  コード `x` と~~消し~~',
    '*一行目*',
    '  二行目',
  ].join('\n'));
  // 飾りの無い行（rich が無い・null・飾りの無い区切りだけ）は今の blocksMarkdown と1文字も同じ
  const plain = (bs) => bs.map(({ rich, children, ...b }) => ({ ...b, ...(children ? { children: plain(children) } : {}) }));   // eslint-disable-line no-unused-vars
  const noKids = plain(blocks).map((b) => ({ ...b, children: undefined }));
  assert.strictEqual(E.blocksMarkdown(noKids.map((b) => ({ ...b, rich: [run(b.text)] }))), E.blocksMarkdown(noKids));
  assert.strictEqual(E.blocksMarkdown(noKids.map((b) => ({ ...b, rich: null }))), E.blocksMarkdown(noKids));
  assert.strictEqual(E.blocksMarkdown(plain(blocks)), '\n## 大事な見出し\n- 資料を見る\n  - [ ] 下線と赤\n  コード x と消し\n一行目\n  二行目');
});

test('EB-5 直し（R117）: richMarkdown は Markdown の記号を書く飾り（太字・斜体・取り消し・コード・リンク）のある行だけ記号を逃がす。下線だけ・色だけの行は飾りの無い行と1字も同じ', () => {
  const t = 'a*b_c~d[e]f\\g`h';
  for (const rich of [[run(t, 'u')], [run(t, ['color', 'red'])], [run(t, ['bg', 'yellow'])], [run('a*b', 'u'), run('_c', ['color', 'blue']), run('~d')]]) {
    assert.strictEqual(R.richMarkdown(rich), rich.map((x) => x.t).join(''), `記号を逃がした: ${JSON.stringify(rich)}`);
  }
  // 記号を書く飾りが1つでもあれば今どおり逃がす（下線の区切りの記号も）
  assert.strictEqual(R.richMarkdown([run('a*b', 'u'), run('x', 'b')]), 'a\\*b**x**');
  assert.strictEqual(R.richMarkdown([run('a_b', ['color', 'red']), run('x', 'code')]), 'a\\_b`x`');
  assert.strictEqual(R.richMarkdown([run('a~b', 'u'), run('x', ['link', 'https://example.com/'])]), 'a\\~b[x](https://example.com/)');
});

// ---------------------------------------------------------------- 貼り付けの変換（Task EK-1。決めたこと 23・24・34・R15〜R17・R66・F102）
const pasteFx = (name) => require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'paste', name), 'utf8');
const rowText = (b) => (Array.isArray(b.rich) ? b.rich : []).map((r) => r.t).join('');
// 行の形を短く書く（'bullet:文'・見出しは 'heading2:文'・ToDo は 'todo[x]:文'。子があれば [行, [子…]]）
function brief(blocks) {
  return blocks.map((b) => {
    const head = `${b.type}${b.type === 'heading' ? b.level : ''}${b.type === 'todo' ? (b.checked ? '[x]' : '[ ]') : ''}:${rowText(b)}`;
    return Array.isArray(b.children) && b.children.length ? [head, brief(b.children)] : head;
  });
}
const briefOf = (r) => { assert.ok(r && Array.isArray(r.blocks), `変換の答えが行の並びでない: ${JSON.stringify(r).slice(0, 200)}`); return brief(r.blocks); };
// どの行の飾りも決まった飾り（太字・斜体・下線・取り消し・コード・開けるリンク）だけか
function marksOk(blocks) {
  for (const b of blocks) {
    for (const r of b.rich) {
      for (const mk of r.m) {
        if (typeof mk === 'string') assert.ok(R.MARKS.includes(mk), `知らない飾り ${mk}`);
        else assert.ok(Array.isArray(mk) && mk[0] === 'link' && R.linkOk(mk[1]), `色か開けないリンク ${JSON.stringify(mk)}`);
      }
    }
    if (b.children) marksOk(b.children);
  }
}

test('EK-1: HTML の表（h1〜h6 → 段 1〜3・ul／ol → 箇条書きと番号（‡131 入れ子は子）・チェックの印 → ToDo・blockquote・hr・p・br・table の行 → 「セル / セル」・太字・斜体・下線・取り消し・コード・リンク）', () => {
  assert.deepStrictEqual(PC.fromHtml('<h2>題</h2>'), { blocks: [{ type: 'heading', level: 2, rich: [run('題')] }], inline: false });
  assert.deepStrictEqual(briefOf(PC.fromHtml('<h1>一</h1><h2>二</h2><h3>三</h3><h4>四</h4><h5>五</h5><H6>六</H6>')),
    ['heading1:一', 'heading2:二', 'heading3:三', 'heading3:四', 'heading3:五', 'heading3:六']);
  assert.deepStrictEqual(briefOf(PC.fromHtml('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul><ol><li>d</li><li>e<ol><li>f</li></ol></li></ol>')),
    [['bullet:a', ['bullet:b']], 'bullet:c', 'numbered:d', ['numbered:e', ['numbered:f']]]);
  // 閉じる印の無い li（HTML の省略）も1つずつの項目
  assert.deepStrictEqual(briefOf(PC.fromHtml('<ul><li>一<li>二</ul>')), ['bullet:一', 'bullet:二']);
  const todo = PC.fromHtml('<ul><li><input type="checkbox" checked>済み</li><li><input type=checkbox>まだ</li><li>[x] 書いた印</li></ul>');
  assert.deepStrictEqual(briefOf(todo), ['todo[x]:済み', 'todo[ ]:まだ', 'todo[x]:書いた印']);
  assert.deepStrictEqual(todo.blocks[1], { type: 'todo', checked: false, rich: [run('まだ')] });
  assert.deepStrictEqual(briefOf(PC.fromHtml('<blockquote><p>引用</p></blockquote><hr><p>一行目<br>二行目</p><div>区画</div>')),
    ['quote:引用', 'divider:', 'paragraph:一行目', 'paragraph:二行目', 'paragraph:区画']);
  assert.deepStrictEqual(PC.fromHtml('<hr>').blocks, [{ type: 'divider', rich: [] }]);
  // 表は1行ずつ「セル / セル」の箇条書き（空のセルは詰める・セルの中の飾りは残る）
  const table = PC.fromHtml('<table><thead><tr><th>名前</th><th>値</th></tr></thead><tbody><tr><td>a</td><td> </td><td><p><b>c</b></p></td></tr><tr><td></td></tr></tbody></table>');
  assert.deepStrictEqual(briefOf(table), ['bullet:名前 / 値', 'bullet:a / c']);
  assert.deepStrictEqual(table.blocks[1].rich, [run('a / '), run('c', 'b')]);
  // 文中の飾り
  const marks = PC.fromHtml('<p><b>B</b><strong>S</strong><span style="font-weight:700">W</span><i>I</i><em>E</em><u>U</u><s>X</s><del>D</del><strike>K</strike><code>C</code><a href="https://example.com/a">L</a></p>');
  assert.deepStrictEqual(marks, { blocks: [{ type: 'paragraph', rich: [run('BSW', 'b'), run('IE', 'i'), run('U', 'u'), run('XDK', 's'), run('C', 'code'), run('L', ['link', 'https://example.com/a'])] }], inline: true });
  // 重なった飾りは決まった順・空白はつぶす（行の頭と終わりは除く）
  assert.deepStrictEqual(PC.fromHtml('<p>  a \n  <i><b>x</b></i>   b  </p>').blocks[0].rich, [run('a '), run('x', 'b', 'i'), run(' b')]);
  // 実体参照を文字に戻す（&nbsp; は空白）
  assert.deepStrictEqual(briefOf(PC.fromHtml('<p>A&amp;B &lt;x&gt; &#x1F600;&#26085;&nbsp;終</p>')), ['paragraph:A&B <x> 😀日 終']);
});

test('EK-1: 種の HTML（Word・Edge・Teams・Google ドキュメントの形）を行と飾りにする', () => {
  const word = PC.fromHtml(pasteFx('word.html'));
  assert.deepStrictEqual(briefOf(word), [
    'heading1:議題の整理', 'paragraph:太字の文と色の文', ['bullet:一つ目の項目', ['bullet:子の項目']], 'bullet:二つ目の項目',
    'numbered:番号の一つ目', 'numbered:番号の二つ目', 'paragraph:議事録の住所と危ない住所', 'bullet:項目 / 担当', 'bullet:資料 / 来週',
  ]);
  assert.deepStrictEqual(word.blocks[1].rich, [run('太字の文', 'b'), run('と色の文')]);
  assert.deepStrictEqual(word.blocks[3].rich, [run('二つ目', 'i'), run('の項目')]);
  assert.deepStrictEqual(word.blocks[6].rich, [run('議事録の住所', ['link', 'https://example.com/minutes']), run('と危ない住所')]);
  assert.deepStrictEqual(word.blocks[7].rich, [run('項目', 'b'), run(' / 担当')]);
  marksOk(word.blocks);
  const edge = PC.fromHtml(pasteFx('edge.html'));
  assert.deepStrictEqual(briefOf(edge), [
    'heading2:ページの見出し', 'paragraph:本文には強い語と斜めの語とコードがあり、資料へ続く。', ['bullet:上の項目', ['bullet:下の項目']],
    'todo[x]:済んだ作業', 'todo[ ]:まだの作業', 'quote:引用の文', 'divider:', 'paragraph:終わり', 'paragraph:次の行',
  ]);
  assert.deepStrictEqual(edge.blocks[1].rich, [run('本文には'), run('強い語', 'b'), run('と'), run('斜めの語', 'i'), run('と'), run('コード', 'code'), run('があり、'), run('資料', ['link', 'https://example.com/docs?a=1&b=2']), run('へ続く。')]);
  marksOk(edge.blocks);
  const teams = PC.fromHtml(pasteFx('teams.html'));
  assert.deepStrictEqual(briefOf(teams), [
    'paragraph:今日の確認です。', 'paragraph:担当の人 さん、次の点をお願いします。', 'numbered:見積もりを金曜までに', ['numbered:日程の候補', ['numbered:午前']], 'paragraph:以上です。',
  ]);
  assert.deepStrictEqual(teams.blocks[2].rich, [run('見積もりを'), run('金曜まで', 'b'), run('に')]);
  const docs = PC.fromHtml(pasteFx('gdocs.html'));
  // 全体を包む <b style="font-weight:normal"> は太字にしない。font-weight:700 の span は太字
  assert.deepStrictEqual(briefOf(docs), [
    'paragraph:ふつうの文と太い文と斜めの文', ['bullet:一段目', ['bullet:二段目']], 'todo[x]:確認した', 'todo[ ]:まだ見ていない', 'paragraph:消した文下線の文表の住所',
  ]);
  assert.deepStrictEqual(docs.blocks[0].rich, [run('ふつうの文と'), run('太い文', 'b'), run('と斜めの文', 'i')]);
  assert.deepStrictEqual(docs.blocks[4].rich, [run('消した文', 's'), run('下線の文', 'u'), run('表の住所', ['link', 'https://example.com/sheet'])]);
  marksOk(docs.blocks);
  // どの種でも、隠れた所（枠の外・Word の設定・画像の題・スクリプト）の文字は入らない
  for (const r of [word, edge, teams, docs]) assert.ok(!JSON.stringify(r).includes('秘'), JSON.stringify(r).slice(0, 300));
  // Windows のクリップボードの頭（Version:… StartHTML:…）は文字にしない
  const cf = `Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000000199\r\nStartFragment:0000000141\r\nEndFragment:0000000163\r\n<html><body>\r\n<!--StartFragment--><p>中身</p><!--EndFragment-->\r\n</body></html>`;
  assert.deepStrictEqual(briefOf(PC.fromHtml(cf)), ['paragraph:中身']);
});

test('EK-1・F102: 落とすもの（script・style・iframe・template・コメント・<!--[if gte mso 9]>…<![endif]-->・<o:p>・javascript:／data: のリンク・on… の属性）。どれも行に文字が出ない（リンクの文字は残る）', { timeout: 5000 }, () => {
  const html = [
    '<p>見える一</p>',
    '<script>alert("秘1")</script><SCRIPT type="module">秘2</SCRIPT><script/>秘3</script>',
    '<style>p{color:red} /* 秘4 */</style><iframe srcdoc="&lt;p&gt;秘5">秘6</iframe><template><p>秘7</p></template>',
    '<noscript>秘8</noscript><object data="x.swf">秘9</object><svg onload="alert(1)"><text>秘10</text></svg><textarea>秘11</textarea>',
    '<!-- 秘12 --><!--[if gte mso 9]><xml><w:Doc>秘13</w:Doc></xml><![endif]--><![CDATA[秘14]]><?xml version="1.0"?>',
    '<!--[if gte mso 9]><p>秘25 Word だけに見せる段落</p><![endif]--><!--[if !mso]><span>秘26</span><![endif]-->',
    '<p>見える二<o:p>秘15</o:p></p>',
    '<p onclick="alert(\'秘16\')" onmouseover="steal()">見える三<img src="x" onerror="alert(\'秘17\')" alt="秘18"></p>',
    '<p><a href="javascript:alert(\'秘19\')">文字一</a><a href=" JaVaScRiPt:alert(1)">文字二</a><a href="data:text/html;base64,PHNjcmlwdD4=">文字三</a>',
    '<a href="vbscript:msgbox(1)">文字四</a><a href="https://example.com/&#x202E;gpj.exe">文字五</a><a href="file:///etc/passwd">文字六</a><a href="  https://example.com/ok  ">文字七</a></p>',
    '<div style="display:none">秘20</div><p hidden>秘21</p><span style="mso-hide:all">秘22</span>',
    '<p>見える四</p><!-- 秘23 閉じないコメント <p>秘24</p>',
  ].join('\n');
  const r = PC.fromHtml(html);
  // （文字三と文字四の間の空白は、入力の行の改行）
  assert.deepStrictEqual(briefOf(r), ['paragraph:見える一', 'paragraph:見える二', 'paragraph:見える三', 'paragraph:文字一文字二文字三 文字四文字五文字六文字七', 'paragraph:見える四']);
  // リンクは開けるものだけ（前後の空白は除いてから照らす）
  assert.deepStrictEqual(r.blocks[3].rich, [run('文字一文字二文字三 文字四文字五文字六'), run('文字七', ['link', 'https://example.com/ok'])]);
  const json = JSON.stringify(r);
  for (const w of ['秘', 'alert', 'javascript', 'JaVaScRiPt', 'data:', 'vbscript', 'file:', 'steal', 'onclick', 'color']) assert.ok(!json.includes(w), `${w} が行に入った: ${json}`);
  // Markdown のリンクも同じ（文字だけ残る）
  const md = PC.pasteBlocks({ text: '[危ない](javascript:alert(1)) と [よい](https://example.com/m) と [データ](data:text/html,x)' });
  assert.deepStrictEqual(md.blocks[0].rich, [run('危ない と '), run('よい', ['link', 'https://example.com/m']), run(' と データ')]);
  assert.ok(!JSON.stringify(md).includes('javascript') && !JSON.stringify(md).includes('data:'));
  // 文字として書かれた <script>（&lt;script&gt;）はただの文字（データ）として残る
  assert.deepStrictEqual(briefOf(PC.fromHtml('<p>&lt;script&gt;x&lt;/script&gt;</p>')), ['paragraph:<script>x</script>']);
  // 画像だけ・中身の無い HTML は行が無い（素の文字があれば素の文字で）
  assert.deepStrictEqual(PC.pasteBlocks({ html: '<img src="x.png">', text: '' }), { blocks: [], inline: false });
  assert.deepStrictEqual(briefOf(PC.pasteBlocks({ html: '<meta charset="utf-8"><img src="x.png">', text: '絵の文' })), ['paragraph:絵の文']);
});

test('EK-1: Word の箇条書き（MsoListParagraph と mso-list の段落・頭の「・」「1.」の印 → 箇条書きと番号。印の文字は消える）', () => {
  const li = (style, body) => `<p class=MsoListParagraph style='${style}'>${body}<o:p></o:p></p>`;
  const html = [
    li('mso-list:l0 level1 lfo1', "<![if !supportLists]><span style='mso-list:Ignore'>・<span>&nbsp;&nbsp;</span></span><![endif]>中黒の項目"),
    li('mso-list:l1 level1 lfo2', "<![if !supportLists]><span style='mso-list:Ignore'>１．<span>&nbsp;</span></span><![endif]>全角の番号"),
    li('mso-list:l1 level1 lfo2', '<!--[if !supportLists]--><span>(2)<span>&nbsp;</span></span><!--[endif]-->括弧の番号'),
    li('mso-list:l2 level1 lfo3', "<![if !supportLists]><span style='mso-list:Ignore'>☐<span>&nbsp;</span></span><![endif]>四角の印"),
    li('', '・印を文字で書いた項目'),
    "<p class=MsoNormal style='mso-list:l3 level1 lfo4'>1. 番号を文字で書いた項目</p>",
    "<p class=MsoNormal>・ふつうの段落の中黒</p>",
    "<p class=MsoListParagraph style='mso-list:l3 level1 lfo4'>12.5% の数は番号にしない</p>",
  ].join('\n');
  assert.deepStrictEqual(briefOf(PC.fromHtml(html)), [
    'bullet:中黒の項目', 'numbered:全角の番号', 'numbered:括弧の番号', 'todo[ ]:四角の印', 'bullet:印を文字で書いた項目', 'numbered:番号を文字で書いた項目',
    'paragraph:・ふつうの段落の中黒', 'bullet:12.5% の数は番号にしない',
  ]);
  // 段（level2）は前の項目の子
  assert.deepStrictEqual(briefOf(PC.fromHtml(li('mso-list:l0 level1 lfo1', '親') + li('mso-list:l0 level2 lfo1', '子') + li('mso-list:l0 level3 lfo1', '孫') + li('mso-list:l0 level1 lfo1', '次'))),
    [['bullet:親', [['bullet:子', ['bullet:孫']]]], 'bullet:次']);
});

test('EK-1: 色を落とす（BQ5 (a)。color・background・font-size・font-family は残らない）', () => {
  const r = PC.fromHtml('<p><span style="color:#ff0000;background:yellow;font-size:20pt;font-family:\'游ゴシック\'">色の文</span><font color="red" size="7" face="serif">古い色</font><span style="background-color:#00ff00;color:blue">地の色</span><mark>印</mark></p>');
  assert.deepStrictEqual(r, { blocks: [{ type: 'paragraph', rich: [run('色の文古い色地の色印')] }], inline: true });
  const all = [r, PC.fromHtml(pasteFx('word.html')), PC.fromHtml(pasteFx('gdocs.html')), PC.fromHtml(pasteFx('edge.html')), PC.fromHtml(pasteFx('teams.html'))];
  for (const x of all) marksOk(x.blocks);
  const json = JSON.stringify(all);
  for (const w of ['"color"', '"bg"', 'ff0000', 'yellow', '20pt', 'serif', 'Arial', '游', 'rgb(']) assert.ok(!json.includes(w), `${w} が残った`);
  // 色つきの太字は太字だけ
  assert.deepStrictEqual(PC.fromHtml('<b style="color:red">赤い太字</b>').blocks[0].rich, [run('赤い太字', 'b')]);
});

test('EK-1: Markdown の表（#〜####・- ・* ・1. ・- [ ]・- [x]・> （引用）・---・囲みのコード（文字の行）・**b**・[t](u)）', () => {
  const text = [
    '# 一', '## 二', '### 三', '#### 四', '- 箇条', '* 星', '+ 足し', '1. 番号', '2) 括弧の番号', '- [ ] まだ', '- [x] 済み', '> 引用', '---',
    '```js', 'const a = 1;', '', '# 見出しでない', '- 箇条でない', '```',
    '**太い**と[住所](https://example.com/m)と*斜め*と`コード`と~~消し~~と__下線でなく太い__',
  ].join('\n');
  const r = PC.pasteBlocks({ text });
  assert.deepStrictEqual(briefOf(r), [
    'heading1:一', 'heading2:二', 'heading3:三', 'heading3:四', 'bullet:箇条', 'bullet:星', 'bullet:足し', 'numbered:番号', 'numbered:括弧の番号',
    'todo[ ]:まだ', 'todo[x]:済み', 'quote:引用', 'divider:', 'paragraph:const a = 1;', 'paragraph:# 見出しでない', 'paragraph:- 箇条でない',
    'paragraph:太いと住所と斜めとコードと消しと下線でなく太い',
  ]);
  assert.deepStrictEqual(r.blocks[16].rich, [run('太い', 'b'), run('と'), run('住所', ['link', 'https://example.com/m']), run('と'), run('斜め', 'i'), run('と'), run('コード', 'code'), run('と'), run('消し', 's'), run('と'), run('下線でなく太い', 'b')]);
  assert.deepStrictEqual(r.blocks[0], { type: 'heading', level: 1, rich: [run('一')] });
  // 閉じていない記号・語の途中の * ・逃がした記号は文字のまま
  assert.deepStrictEqual(PC.pasteBlocks({ text: '- 1*2*3 と **閉じない と \\*逃がした\\* と snake_case_name' }).blocks[0].rich, [run('1*2*3 と **閉じない と *逃がした* と snake_case_name')]);
  // 表は1行ずつ「セル / セル」の箇条書き（区切りの行は捨てる）
  assert.deepStrictEqual(briefOf(PC.pasteBlocks({ text: '| 項目 | 値 |\n|---|:-:|\n| **a** | b |' })), ['bullet:項目 / 値', 'bullet:a / b']);
  // 文中の飾りだけの1行は行の中に入れる（inline）。印の無い文は Markdown として読まない
  assert.deepStrictEqual(PC.pasteBlocks({ text: '**重要** な点' }), { blocks: [{ type: 'paragraph', rich: [run('重要', 'b'), run(' な点')] }], inline: true });
  assert.deepStrictEqual(PC.pasteBlocks({ text: '- 一つ' }).inline, false);
  assert.deepStrictEqual(PC.fromMarkdown('# 題\n本文'), { blocks: [{ type: 'heading', level: 1, rich: [run('題')] }, { type: 'paragraph', rich: [run('本文')] }], inline: false });
});

test('EK-1: 素の文字（3行 → 3つのテキストの行・空の行は詰める・1行で印が無い → inline）', () => {
  const r = PC.pasteBlocks({ text: '一\n\n二\r\n   \n三\n' });
  assert.deepStrictEqual(r, { blocks: [{ type: 'paragraph', rich: [run('一')] }, { type: 'paragraph', rich: [run('二')] }, { type: 'paragraph', rich: [run('三')] }], inline: false });
  assert.deepStrictEqual(PC.pasteBlocks({ text: 'ひとこと' }), { blocks: [{ type: 'paragraph', rich: [run('ひとこと')] }], inline: true });
  assert.deepStrictEqual(PC.pasteBlocks({ html: '', text: 'ひとこと' }), PC.fromPlain('ひとこと'));
  // 素の文字の部品は印を読まない（Markdown かどうかは pasteBlocks が決める）
  assert.deepStrictEqual(briefOf(PC.fromPlain('# 見出し\n- 箇条\n  字下げ\ta')), ['paragraph:# 見出し', 'paragraph:- 箇条', 'paragraph:  字下げ\ta']);
  // 制御の文字は落とす
  assert.deepStrictEqual(briefOf(PC.fromPlain('a\u0000b\u0007c')), ['paragraph:abc']);
  assert.deepStrictEqual(PC.pasteBlocks({ text: '' }), { blocks: [], inline: false });
  assert.deepStrictEqual(PC.pasteBlocks({}), { blocks: [], inline: false });
});

test('EK-1・F102: 2,001 行・1MB を越える → { tooBig: true }（一部だけを返さない）', { timeout: 10000 }, () => {
  assert.strictEqual(PC.PASTE_ROWS, V.LIMITS.blocks);
  assert.strictEqual(PC.PASTE_BYTES, V.LIMITS.bytes);
  const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');
  assert.strictEqual(PC.pasteBlocks({ text: lines(2000, (i) => `行${i}`) }).blocks.length, 2000);
  assert.deepStrictEqual(PC.pasteBlocks({ text: lines(2001, (i) => `行${i}`) }), { tooBig: true });
  assert.deepStrictEqual(PC.pasteBlocks({ text: lines(2001, (i) => `- 項目${i}`) }), { tooBig: true });
  assert.strictEqual(PC.fromHtml(lines(2000, (i) => `<p>段${i}</p>`)).blocks.length, 2000);
  assert.deepStrictEqual(PC.fromHtml(lines(2001, (i) => `<p>段${i}</p>`)), { tooBig: true });
  assert.deepStrictEqual(PC.pasteBlocks({ html: `<table>${lines(2001, (i) => `<tr><td>${i}</td></tr>`)}</table>`, text: 'x' }), { tooBig: true });
  // 1MB（UTF-8 の大きさ）を越える: 3 バイトの字 30,000 × 12 行
  assert.deepStrictEqual(PC.pasteBlocks({ text: lines(12, () => 'あ'.repeat(30000)) }), { tooBig: true });
  assert.deepStrictEqual(PC.fromHtml(lines(12, () => `<p>${'あ'.repeat(30000)}</p>`)), { tooBig: true });
  assert.strictEqual(PC.pasteBlocks({ text: lines(10, () => 'a'.repeat(50000)) }).blocks.length, 10);
  // 1行の文字は 10 万字まで
  assert.strictEqual(PC.fromPlain('a'.repeat(100000)).blocks.length, 1);
  assert.deepStrictEqual(PC.fromPlain('a'.repeat(100001)), { tooBig: true });
  // Word の飾りで大きい HTML でも、文が小さければ通る（3MB の style）。読む HTML は 16MB まで
  const fat = `style="${'mso-bidi-font-family:x;'.repeat(15000)}"`;
  assert.deepStrictEqual(briefOf(PC.fromHtml(lines(10, (i) => `<p ${fat}>段${i}</p>`))).length, 10);
  assert.deepStrictEqual(PC.fromHtml(`<p>${'x'.repeat(16 * 1024 * 1024)}</p>`), { tooBig: true });
  // 深い入れ子・閉じない属性・崩れた印でも止まらない
  assert.deepStrictEqual(briefOf(PC.fromHtml(`${'<div>'.repeat(50000)}深い文${'</div>'.repeat(50000)}`)), ['paragraph:深い文']);
  assert.deepStrictEqual(briefOf(PC.fromHtml('<p>前</p><a href="https://example.com/' + 'x'.repeat(200000))), ['paragraph:前']);
  assert.deepStrictEqual(briefOf(PC.fromHtml(`<p>${'<'.repeat(99999)}終</p>`)), [`paragraph:${'<'.repeat(99999)}終`]);
  assert.strictEqual(PC.pasteBlocks({ text: '*a '.repeat(33000) }).blocks.length, 1);
  assert.strictEqual(PC.pasteBlocks({ text: '['.repeat(50000) + ']('.repeat(20000) }).blocks.length, 1);
});

test('EK-1・R66（第4版）: Markdown の字下げした - ・1. （2つ・4つの空白・タブ）と HTML の入れ子の ul／ol → 子の行。見出し・区切り線の下に来た子 → その行の後ろの兄弟に上げる。子孫を数えて 2,001 行 → { tooBig: true }', { timeout: 10000 }, () => {
  const want = [['bullet:a', [['bullet:b', ['bullet:c']]]], 'bullet:d'];
  assert.deepStrictEqual(briefOf(PC.pasteBlocks({ text: '- a\n  - b\n    - c\n- d' })), want);
  assert.deepStrictEqual(briefOf(PC.pasteBlocks({ text: '- a\n    - b\n        - c\n- d' })), want);
  assert.deepStrictEqual(briefOf(PC.pasteBlocks({ text: '- a\n\t- b\n\t\t- c\n- d' })), want);
  assert.deepStrictEqual(briefOf(PC.pasteBlocks({ text: '1. 一\n   1. 一の一\n   2. 一の二\n2. 二\n  - [x] 二の済み' })),
    [['numbered:一', ['numbered:一の一', 'numbered:一の二']], ['numbered:二', ['todo[x]:二の済み']]]);
  // 段を飛ばした字下げは1段下まで・浅く戻ると戻った段
  assert.deepStrictEqual(briefOf(PC.pasteBlocks({ text: '- a\n      - b\n  - c\n- d' })), [['bullet:a', ['bullet:b', 'bullet:c']], 'bullet:d']);
  // 文の下の字下げした箇条は、その文の子（テキストは子を持てる）
  assert.deepStrictEqual(briefOf(PC.pasteBlocks({ text: '説明\n  - a' })), [['paragraph:説明', ['bullet:a']]]);
  // 見出し・区切り線の下の子は後ろの兄弟に上がる（子の子はそのまま）
  assert.deepStrictEqual(briefOf(PC.pasteBlocks({ text: '# 見出し\n  - 子\n    - 孫\n---\n  - 線の下' })), ['heading1:見出し', ['bullet:子', ['bullet:孫']], 'divider:', 'bullet:線の下']);
  assert.deepStrictEqual(briefOf(PC.fromHtml("<h2>題</h2><p class=MsoListParagraph style='mso-list:l0 level2 lfo1'>二段目から</p>")), ['heading2:題', 'bullet:二段目から']);
  // HTML の入れ子（li の中の ul・ul の中に直に ul）
  assert.deepStrictEqual(briefOf(PC.fromHtml('<ul><li>a</li><ul><li>b</li><ol><li>c</li></ol></ul><li>d<p>続きの段落</p></li></ul>')),
    [['bullet:a', [['bullet:b', ['numbered:c']]]], ['bullet:d', ['paragraph:続きの段落']]]);
  // 子孫も数える: 親1つ＋子 1,999 は 2,000 行で通り、子 2,000 で越える
  const kids = (n) => '- 親\n' + Array.from({ length: n }, (_, i) => `  - 子${i}`).join('\n');
  const ok = PC.pasteBlocks({ text: kids(1999) });
  assert.strictEqual(ok.blocks.length, 1);
  assert.strictEqual(ok.blocks[0].children.length, 1999);
  assert.deepStrictEqual(PC.pasteBlocks({ text: kids(2000) }), { tooBig: true });
  const htmlKids = (n) => `<ul><li>親<ul>${'<li>子</li>'.repeat(n)}</ul></li></ul>`;
  assert.strictEqual(PC.fromHtml(htmlKids(1999)).blocks[0].children.length, 1999);
  assert.deepStrictEqual(PC.fromHtml(htmlKids(2000)), { tooBig: true });
});
