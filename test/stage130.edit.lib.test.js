/*
 * stage130.edit.lib.test.js — 0.13.0 第1部「編集の動き その1」の純粋な部品（計画 docs/plans/2026-10-24-130.md の Task ED-1）
 * 型の表・書記素の境で分ける・行頭の記法・/ の絞り込みと「最近使ったもの」・Enter と Backspace の決まり・番号・近道・Markdown・行だけの描き直し。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../src/blockEdit.js');

const PLAN = fs.readFileSync(path.join(__dirname, '..', 'docs', 'plans', '2026-10-24-130.md'), 'utf8');

// ---------------------------------------------------------------- 型の表
test('ED-1: BLOCK_TYPES はこの計画の型の表と1行ずつ同じ（名前・当たる語・記法・近道・子・出典・版）', () => {
  const at = PLAN.indexOf('## ブロックの型の表');
  const table = PLAN.slice(at, PLAN.indexOf('\n## ', at + 5));
  const rows = table.split('\n').filter((l) => /^\| `/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  assert.strictEqual(rows.length, 12, '計画の表が読めない');
  assert.strictEqual(E.BLOCK_TYPES.length, rows.length);
  rows.forEach(([keyCol, label, words, md, code, kids, cite, since], i) => {
    const r = E.BLOCK_TYPES[i];
    const key = /^`([a-z]+)`/.exec(keyCol)[1];
    const lv = /`level` (\d)/.exec(keyCol);
    assert.strictEqual(r.key, key, `${i}: key`);
    assert.strictEqual(r.level, lv ? Number(lv[1]) : undefined, `${i}: level`);
    assert.strictEqual(r.toggle, keyCol.includes('`toggle: true`') ? true : undefined, `${i}: toggle`);
    assert.strictEqual(r.label, label, `${i}: label`);
    assert.deepStrictEqual([...r.words], words.split('・'), `${i}: words`);
    assert.deepStrictEqual([...r.md], md === '—' ? [] : [...md.matchAll(/`([^`]+)`/g)].map((m) => m[1]), `${i}: md`);
    const d = /Ctrl\+Shift\+(\d)/.exec(code);
    assert.strictEqual(r.code, d ? `Digit${d[1]}` : undefined, `${i}: code`);
    assert.strictEqual(r.kids, kids === '持てる', `${i}: kids`);
    assert.strictEqual(r.cite, cite === '付く', `${i}: cite`);
    assert.strictEqual(r.since, since.startsWith('今ある') ? 'now' : since, `${i}: since`);
  });
  // 0.13.0 の / メニューの鍵（トグルとトグル見出しは 0.13.1）
  assert.deepStrictEqual([...E.MENU_KEYS], ['text', 'h1', 'h2', 'h3', 'todo', 'bullet', 'numbered', 'quote', 'divider', 'callout']);
  assert.deepStrictEqual([...E.TYPE_KEYS], ['paragraph', 'heading', 'todo', 'bullet', 'numbered', 'quote', 'divider', 'callout']);
});

test('ED-1・F51: typeOf は段の無い見出しを段 2、知らない型をテキストの見た目にする。isTyped はテキストでない型だけ', () => {
  assert.strictEqual(E.typeOf({ type: 'heading', text: 'a' }).id, 'h2');
  assert.strictEqual(E.typeOf({ type: 'heading', level: 1 }).id, 'h1');
  assert.strictEqual(E.typeOf({ type: 'heading', level: 3 }).id, 'h3');
  assert.strictEqual(E.typeOf({ type: 'heading', level: 7 }).id, 'h2');
  assert.strictEqual(E.typeOf({ type: 'video', text: 'x' }).id, 'text');
  assert.strictEqual(E.typeOf({ type: 'toggle' }).id, 'text', '0.13.0 ではトグルはテキストの見た目');
  assert.strictEqual(E.typeOf(null).id, 'text');
  for (const [t, v] of [['paragraph', false], ['video', false], ['bullet', true], ['todo', true], ['numbered', true], ['quote', true], ['divider', true], ['callout', true], ['heading', true]]) assert.strictEqual(E.isTyped({ type: t }), v, t);
});

// ---------------------------------------------------------------- 書記素の境（F40）
test('ED-1・F40: safeOffset と splitText の表。splitRich・joinRich は区切りの飾りを保つ', () => {
  assert.strictEqual(E.safeOffset('𠮷野家', 1), 2);
  const fam = '👨‍👩‍👧';
  for (let i = 1; i < fam.length; i++) assert.strictEqual(E.safeOffset(`a${fam}b`, 1 + i), 1 + fam.length, `家族の絵文字の途中 ${i}`);
  assert.strictEqual(E.safeOffset('がき', 1), 2, '結合文字の途中');
  assert.strictEqual(E.safeOffset('abc', 0), 0);
  assert.strictEqual(E.safeOffset('abc', 3), 3);
  assert.strictEqual(E.safeOffset('abc', -2), 0);
  assert.strictEqual(E.safeOffset('abc', 9), 3);
  assert.strictEqual(E.safeOffset('abc', 1.7), 1);
  for (const [t, a] of [['𠮷野家の会議', 1], ['ab', 1], ['', 0], [`前${fam}後`, 2]]) {
    const [x, y] = E.splitText(t, a);
    assert.strictEqual(x + y, t);
  }
  assert.deepStrictEqual(E.splitText('𠮷野家', 1), ['𠮷', '野家']);
  const rich = [{ t: 'ab' }, { t: 'cd', m: ['b'] }, { t: 'ef' }];
  assert.deepStrictEqual(E.splitRich(rich, 3), [[{ t: 'ab' }, { t: 'c', m: ['b'] }], [{ t: 'd', m: ['b'] }, { t: 'ef' }]]);
  assert.deepStrictEqual(E.splitRich(rich, 0), [[], rich]);
  assert.deepStrictEqual(E.joinRich([{ t: 'ab' }, { t: 'c', m: ['b'] }], [{ t: 'd', m: ['b'] }, { t: 'ef' }]), rich);
  assert.deepStrictEqual(E.joinRich([], []), []);
});

// ---------------------------------------------------------------- 行頭の記法（F43）
test('ED-1・F43: shortcutFor の表（行頭だけ・1.5倍や空白なしは当たらない・EQ9 の全角・EQ10 の > は 0.13.0 では何もしない）', () => {
  const T = (before, full) => E.shortcutFor(before, full === undefined ? {} : { full });
  for (const s of ['- ', '* ', '+ ']) assert.deepStrictEqual(T(s), { type: 'bullet', strip: 2 }, s);
  assert.deepStrictEqual(T('[] '), { type: 'todo', strip: 3 });
  assert.deepStrictEqual(T('1. '), { type: 'numbered', strip: 3 });
  assert.deepStrictEqual(T('# '), { type: 'heading', level: 1, strip: 2 });
  assert.deepStrictEqual(T('## '), { type: 'heading', level: 2, strip: 3 });
  assert.deepStrictEqual(T('### '), { type: 'heading', level: 3, strip: 4 });
  assert.deepStrictEqual(T('" '), { type: 'quote', strip: 2 });
  assert.deepStrictEqual(T('---', '---'), { type: 'divider', strip: 3 });
  assert.strictEqual(T('---', '---あと'), null, '区切り線は空の行だけ（EQ13）');
  assert.strictEqual(T('> '), null, '> は 0.13.1 のトグル（EQ10）');
  for (const s of ['あ- ', '1.5倍', '1.', '#見出し', '[]', '-', '--', '#### ', '2. ', 'a. ', '- あ', '']) assert.strictEqual(T(s), null, JSON.stringify(s));
  // EQ9 (a): 全角の記号と全角の空白でも変える。「ー」と「・」では変えない
  assert.deepStrictEqual(T('－　'), { type: 'bullet', strip: 2 });
  assert.deepStrictEqual(T('－ '), { type: 'bullet', strip: 2 });
  assert.deepStrictEqual(T('＃　'), { type: 'heading', level: 1, strip: 2 });
  assert.deepStrictEqual(T('＃＃　'), { type: 'heading', level: 2, strip: 3 });
  assert.deepStrictEqual(T('［］　'), { type: 'todo', strip: 3 });
  assert.deepStrictEqual(T('１．　'), { type: 'numbered', strip: 3 });
  assert.deepStrictEqual(T('”　'), { type: 'quote', strip: 2 });
  assert.deepStrictEqual(T('- 　'.slice(0, 1) + '　'), { type: 'bullet', strip: 2 });
  assert.deepStrictEqual(T('－－－', '－－－'), { type: 'divider', strip: 3 });
  for (const s of ['ー　', '・　', 'ー ', '・ ', '＞　']) assert.strictEqual(T(s), null, s);
});

// ---------------------------------------------------------------- / メニュー（EQ7・EQ8）
test('ED-1: slashQuery・slashFilter の表（半角の / だけ・日本語の名前で絞る・当たりなしで3文字なら閉じる・最近使ったものが頭）', () => {
  assert.deepStrictEqual(E.slashQuery('/'), { open: true, query: '' });
  assert.deepStrictEqual(E.slashQuery('/みだし'), { open: true, query: 'みだし' });
  assert.deepStrictEqual(E.slashQuery('予算 /todo'), { open: true, query: 'todo' });
  assert.deepStrictEqual(E.slashQuery('予算　/h2'), { open: true, query: 'h2' });
  for (const s of ['a/b', 'a/', '／', '／みだし', '・', '・みだし', '/a b', '', '予算']) assert.strictEqual(E.slashQuery(s).open, false, s);
  const ids = (q, r) => { const x = E.slashFilter(q, r); return x === null ? null : x.map((i) => i.id); };
  assert.deepStrictEqual(ids('みだし'), ['h1', 'h2', 'h3']);
  assert.deepStrictEqual(ids('todo'), ['todo']);
  assert.deepStrictEqual(ids('TODO'), ['todo']);
  assert.deepStrictEqual(ids('h2'), ['h2']);
  assert.deepStrictEqual(ids('見出し'), ['h1', 'h2', 'h3']);
  assert.deepStrictEqual(ids('だし'), ['h1', 'h2', 'h3'], '途中からでも当たる');
  assert.strictEqual(ids('とぐる'), null, '0.13.0 ではトグルは出さない（当たりなしの3文字で閉じる）');
  assert.deepStrictEqual(ids('zz'), [], '当たりなし（2文字はまだ開いている）');
  assert.strictEqual(ids('zzz'), null, '当たりなしで3文字なら閉じる');
  assert.deepStrictEqual(ids(''), [...E.MENU_KEYS]);
  assert.deepStrictEqual(E.slashFilter('', []).map((i) => i.group), E.MENU_KEYS.map(() => 'types'));
  const all = E.slashFilter('', ['h2', 'todo']);
  assert.deepStrictEqual(all.map((i) => `${i.group}:${i.id}`), ['recent:h2', 'recent:todo', ...E.MENU_KEYS.map((k) => `types:${k}`)]);
  assert.deepStrictEqual(ids('み', ['h3']), ['h3', 'h1', 'h2'], '語を打った後は当たったうちの最近使ったものを先に');
  assert.deepStrictEqual(E.slashFilter('み', ['h3']).map((i) => i.group), ['', '', ''], '語を打った後は見出しを出さない');
  assert.deepStrictEqual(ids('', ['x', 1]), [...E.MENU_KEYS], '壊れた最近使ったものでも開く');
});

test('ED-1・F52: recentAdd・recentCheck の表（新しい順・3つまで・同じ鍵は1つ・鍵の表のものだけ）', () => {
  assert.deepStrictEqual(E.recentAdd([], 'h2'), ['h2']);
  assert.deepStrictEqual(E.recentAdd(['h2', 'todo', 'bullet'], 'quote'), ['quote', 'h2', 'todo']);
  assert.deepStrictEqual(E.recentAdd(['h2', 'todo'], 'todo'), ['todo', 'h2']);
  assert.deepStrictEqual(E.recentAdd(['h2'], 'toggle'), ['h2'], '0.13.0 の鍵でない');
  assert.deepStrictEqual(E.recentAdd('x', 'h1'), ['h1']);
  const input = ['h2', 'todo'];
  E.recentAdd(input, 'h1');
  assert.deepStrictEqual(input, ['h2', 'todo'], '受けた物を変えた');
  for (const [v, want] of [[undefined, []], [null, []], ['h2', []], [{ 0: 'h2' }, []], [['x'], []], [[1], []], [['h2', 'h2'], ['h2']],
    [['h1', 'h2', 'h3', 'todo', 'bullet'], ['h1', 'h2', 'h3']], [['__proto__', 'h1'], ['h1']], [['予算の相談（山田さん）を来週までに', 'todo'], ['todo']],
    [['toggle', 'th1', 'quote'], ['quote']]]) assert.deepStrictEqual(E.recentCheck(v), want, JSON.stringify(v));
});

// ---------------------------------------------------------------- Enter と Backspace（EQ5 (a)・EQ6 (a)）
test('ED-1: nextTypeOnEnter・backspaceAtStart の表', () => {
  const N = (b, empty) => E.nextTypeOnEnter(b, { empty });
  assert.deepStrictEqual(N({ type: 'heading', level: 1 }), { type: 'bullet' });
  assert.deepStrictEqual(N({ type: 'heading' }), { type: 'bullet' });
  for (const t of ['bullet', 'todo', 'numbered']) {
    assert.deepStrictEqual(N({ type: t }), { type: t }, t);
    assert.strictEqual(N({ type: t }, true), 'revert', `空の ${t}`);
  }
  for (const t of ['paragraph', 'quote', 'callout', 'divider', 'video']) assert.deepStrictEqual(N({ type: t }), { type: 'paragraph' }, t);
  assert.deepStrictEqual(N({ type: 'paragraph' }, true), { type: 'paragraph' }, '空のテキストは今どおり分ける');
  const B = (b, depth) => E.backspaceAtStart(b, { depth });
  for (const t of ['heading', 'bullet', 'todo', 'numbered', 'quote', 'callout', 'divider']) assert.strictEqual(B({ type: t }), 'revert', t);
  for (const t of ['paragraph', 'video']) assert.strictEqual(B({ type: t }), 'merge', t);
  assert.strictEqual(B({ type: 'bullet' }, 1), 'outdent');
});

// ---------------------------------------------------------------- 番号（F50）
test('ED-1・F50: numberLabels の表', () => {
  const nb = (id) => ({ id, type: 'numbered', text: id });
  const lab = (bs) => [...E.numberLabels(bs).entries()];
  assert.deepStrictEqual(lab([nb('a'), nb('b'), nb('c')]), [['a', '1.'], ['b', '2.'], ['c', '3.']]);
  assert.deepStrictEqual(lab([nb('a'), { id: 'x', type: 'bullet' }, nb('b')]), [['a', '1.'], ['b', '1.']]);
  assert.deepStrictEqual(lab([nb('a'), { id: 'x', type: 'paragraph', text: '' }, nb('b'), nb('c')]), [['a', '1.'], ['b', '1.'], ['c', '2.']]);
  assert.deepStrictEqual(lab([{ id: 'h', type: 'heading' }, nb('a')]), [['a', '1.']]);
  assert.deepStrictEqual(lab(undefined), []);
});

// ---------------------------------------------------------------- 近道（F45）
test('ED-1・F45: keyAction の表（数字は ev.code・変換中は null・今の近道と 0.14.0 に入る近道を取らない）', () => {
  const K = (o) => E.keyAction({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false, key: '', code: '', ...o });
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'Digit1', key: '!' }), 'turn:h1');
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'Digit2', key: '"' }), 'turn:h2');
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'Digit3', key: '#' }), 'turn:h3');
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'Digit4', key: '$' }), 'turn:todo');
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'Digit5', key: '%' }), 'turn:bullet');
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'Digit6', key: '&' }), 'turn:numbered');
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'Digit0', key: '' }), 'turn:text', 'EQ12');
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'Digit7', key: "'" }), null, 'トグルは 0.13.1');
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'Digit8' }), null);
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'Digit9' }), null);
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'Digit1', key: '!', isComposing: true }), null);
  assert.strictEqual(K({ ctrlKey: true, code: 'KeyD', key: 'd', keyCode: 229 }), null);
  assert.strictEqual(K({ ctrlKey: true, code: 'KeyD', key: 'd' }), 'duplicate');
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'ArrowUp', key: 'ArrowUp' }), 'moveUp');
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'ArrowDown', key: 'ArrowDown' }), 'moveDown');
  assert.strictEqual(K({ ctrlKey: true, code: 'Enter', key: 'Enter' }), 'ctrlEnter');
  assert.strictEqual(K({ ctrlKey: true, code: 'Slash', key: '/' }), 'menu');
  for (const o of [{ ctrlKey: true, shiftKey: true, code: 'KeyP', key: 'P' }, { ctrlKey: true, shiftKey: true, code: 'KeyL', key: 'L' }, { ctrlKey: true, code: 'KeyP', key: 'p' },
    { ctrlKey: true, code: 'KeyW', key: 'w' }, { ctrlKey: true, shiftKey: true, code: 'KeyN', key: 'N' }, { ctrlKey: true, altKey: true, code: 'KeyV', key: 'v' },
    { ctrlKey: true, altKey: true, shiftKey: true, code: 'Digit1', key: '!' }, { shiftKey: true, code: 'Digit1', key: '!' }, { code: 'KeyD', key: 'd' }, { ctrlKey: true, code: 'Digit1', key: '1' }]) {
    assert.strictEqual(K(o), null, JSON.stringify(o));
  }
  assert.strictEqual(E.keyAction(null), null);
});

// ---------------------------------------------------------------- ［コピー］の Markdown（決めたこと 22）
test('ED-1: blocksMarkdown の表（段 1〜3・段の無い見出しは ##・番号は数えた値・引用・区切り線・コールアウト・行の中の改行・ToDo のチェック・知らない型は文だけ）', () => {
  const bs = [
    { id: 'h1', type: 'heading', level: 1, text: '大見出し' }, { id: 'h2', type: 'heading', text: '決定事項' }, { id: 'h3', type: 'heading', level: 3, text: '小見出し' },
    { id: 'n1', type: 'numbered', text: '一つ目' }, { id: 'n2', type: 'numbered', text: '二つ目' }, { id: 'q', type: 'quote', text: '引いた文' },
    { id: 'd', type: 'divider', text: '' }, { id: 'c', type: 'callout', text: '覚えておくこと' }, { id: 't1', type: 'todo', text: '済んだ', checked: true },
    { id: 't2', type: 'todo', text: 'まだ' }, { id: 'b', type: 'bullet', text: '一行目\n二行目' }, { id: 'v', type: 'video', text: '動画の文' }, { id: 'p', type: 'paragraph', text: '本文' },
  ];
  assert.strictEqual(E.blocksMarkdown(bs), [
    '\n# 大見出し', '\n## 決定事項', '\n### 小見出し', '1. 一つ目', '2. 二つ目', '> 引いた文', '---', '> 💡 覚えておくこと', '- [x] 済んだ', '- [ ] まだ',
    '- 一行目\n  二行目', '動画の文', '本文'].join('\n'));
  // 今の4つの型だけの並びは、0.11.0 の［コピー］の式（app.html の要約の枝）と1文字も同じ
  const old = (blocks) => blocks.map((b) => b.type === 'heading' ? `\n## ${b.text}` : b.type === 'todo' ? `- [${b.checked ? 'x' : ' '}] ${b.text}` : b.type === 'bullet' ? `- ${b.text}` : b.text).join('\n');
  const four = [{ id: 'a', type: 'heading', text: '決定事項' }, { id: 'b', type: 'bullet', text: '金曜に締める', cites: ['s1'] }, { id: 'c', type: 'todo', text: '見積を出す', checked: false, assignee: '山田' },
    { id: 'd', type: 'todo', text: '済んだ', checked: true }, { id: 'e', type: 'paragraph', text: '本文の段落' }, { id: 'f', type: 'heading', text: '持ち越し' }];
  assert.strictEqual(E.blocksMarkdown(four), old(four));
  assert.strictEqual(E.blocksMarkdown([]), '');
  assert.strictEqual(E.blocksMarkdown(undefined), '');
});

// ---------------------------------------------------------------- 行だけの描き直し（F47）
test('ED-1・F47: patchPlan の表（分割 → 足す1つと直す1つ・結合 → 消す1つと直す1つ・動かす → 動かす1つ・同じ → 空）', () => {
  const b = (id, text, type = 'bullet') => ({ id, type, text });
  const before = [b('a', 'あ'), b('b', 'いう'), b('c', 'え')];
  const split = [b('a', 'あ'), b('b', 'い'), b('n', 'う'), b('c', 'え')];
  assert.deepStrictEqual(E.patchPlan(before, split), [{ op: 'update', id: 'b' }, { op: 'add', id: 'n', at: 2 }]);
  const merged = [b('a', 'あいう'), b('c', 'え')];
  assert.deepStrictEqual(E.patchPlan(before, merged), [{ op: 'remove', id: 'b' }, { op: 'update', id: 'a' }]);
  const moved = [b('b', 'いう'), b('a', 'あ'), b('c', 'え')];
  assert.strictEqual(E.patchPlan(before, moved).length, 1);
  assert.strictEqual(E.patchPlan(before, moved)[0].op, 'move');
  const movedDown = [b('a', 'あ'), b('c', 'え'), b('b', 'いう')];
  assert.deepStrictEqual(E.patchPlan(before, movedDown).map((o) => o.op), ['move']);
  assert.deepStrictEqual(E.patchPlan(before, before.map((x) => ({ ...x }))), []);
  assert.deepStrictEqual(E.patchPlan([], []), []);
  assert.deepStrictEqual(E.patchPlan(undefined, [b('a', 'あ')]), [{ op: 'add', id: 'a', at: 0 }]);
});
