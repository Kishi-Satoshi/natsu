/*
 * meetingType.test.js — 会議タイプの判定とテンプレート
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mtype = require('../src/meetingType');

test('タイトルから会議タイプを判定する', () => {
  const cases = [
    ['週次定例', 'standup'],
    ['朝会', 'standup'],
    ['開発チーム 進捗確認', 'standup'],
    ['10月度 部会', 'review'],
    ['事業本部 月次報告会', 'review'],
    ['1on1', 'oneonone'],
    ['キャリア面談', 'oneonone'],
    ['協業の商談', 'sales'],
    ['再販契約の打ち合わせ', 'sales'],
    ['中途採用 一次面接', 'interview'],
    ['入社前の顔合わせ', 'interview'],
    ['新機能のブレスト', 'brainstorm'],
    ['方針のディスカッション', 'brainstorm'],
  ];
  for (const [title, want] of cases) {
    assert.strictEqual(mtype.detectType(title, ''), want, `「${title}」の判定`);
  }
});

// 0.11.0 P-12（P12・R5）で意図して変えた: 一般・その他（general）を外し、決まらないときは ''
test('手がかりが無ければ決まらない（\'\'。誤った型を当てない）', () => {
  for (const title of ['打ち合わせ', 'ミーティング', '', '10/05 の記録', null, undefined]) {
    assert.strictEqual(mtype.detectType(title, ''), '', `「${title}」`);
  }
});

test('本文だけの弱い一致では型を決めない', () => {
  // 本文一致は1点。閾値に届かないので決まらない（0.11.0 P-12 で意図して変えた: general → ''）
  assert.strictEqual(mtype.detectType('打ち合わせ', '本日は商談の件で伺いました'), '');
});

test('より具体的な語で当たった型を採る', () => {
  // 「採用面談」は interview の『採用面談』と oneonone の『面談』の両方に当たる
  assert.strictEqual(mtype.detectType('採用面談', ''), 'interview');
  // 「面談」単体、「キャリア面談」は 1on1 のまま
  assert.strictEqual(mtype.detectType('面談', ''), 'oneonone');
  assert.strictEqual(mtype.detectType('キャリア面談', ''), 'oneonone');
});

test('本文に一般語が並んだだけでは型を決めない', () => {
  // 「提案」「価格」「紹介」はどの会議にも出る語。これで商談と判定してはいけない
  assert.strictEqual(
    mtype.detectType('2026/10/5 10:00 の議事録', '自己紹介します。提案の価格について説明します'),
    '');   // 0.11.0 P-12 で意図して変えた: general → ''
});

test('本文の手がかりが十分に多ければ型を決める', () => {
  assert.strictEqual(
    mtype.detectType('2026/10/5 10:00 の議事録', '商談 提案 見積 価格 契約 再販 協業'),
    'sales');
});

test('タイトル一致は本文一致より優先される', () => {
  // タイトルに「面接」（interview）、本文に「定例」（standup）
  assert.strictEqual(mtype.detectType('一次面接', '定例 定例 定例'), 'interview');
});

// 0.11.0 M-2（D42・P3）で意図して変えた: 種類ごとの書式（getFormat）を外した。要約の書式は memoTypes.buildTemplate（種類から決まる型の見出しと締め）
test('0.11.0 M-2: getFormat と format は無い。どの種類の書式も締めの4つの見出し（持ち越しを含む）と ToDo のチェックボックスの形を持ち、見出しは markdownToBlocks で見出しになる', () => {
  const { buildTemplate } = require('../src/memoTypes');
  const { markdownToBlocks } = require('../src/minutes');
  assert.strictEqual(mtype.getFormat, undefined);
  for (const key of mtype.ORDER) {
    assert.strictEqual(mtype.TYPES[key].format, undefined, key);
    const f = buildTemplate({ meetingType: key });
    for (const h of ['## 決定事項', '## 持ち越し', '## ToDo（誰が・何を・いつまでに）', '## 抜け・重なりチェック']) assert.ok(f.includes(h), `${key} に ${h} が無い`);
    assert.ok(f.includes('- [ ]'), `${key} にアクション節が無い（チェックボックス化の起点）`);
    const headings = f.split('\n').filter((l) => /^#{2,3} /.test(l));
    const blocks = markdownToBlocks(headings.join('\n'));
    assert.ok(blocks.length === headings.length && blocks.every((b) => b.type === 'heading'), key);
  }
  assert.strictEqual(typeof mtype.ACTION_RULE, 'string');
});

// 0.11.0 P-12（P12・R5）で意図して変えた: 一般・その他（general）を外し、決まらないときは ''
test('0.11.0 P-12: getLabel は選べる鍵ならその名前、ほか（決まらない・前の版の general・知らない値）は「自動」', () => {
  for (const k of mtype.SELECTABLE) assert.strictEqual(mtype.getLabel(k), mtype.TYPES[k].label, k);
  for (const v of ['', 'general', 'nonexistent', '__proto__', 'constructor', null, undefined, 3]) assert.strictEqual(mtype.getLabel(v), '自動', String(v));
});

test('0.11.0 P-12（P12・R5）: TYPES と ORDER に general が無い。ORDER は SELECTABLE と同じ鍵。決まらなかったときの灰色の文', () => {
  assert.strictEqual(Object.hasOwn(mtype.TYPES, 'general'), false);
  assert.ok(!mtype.ORDER.includes('general'));
  assert.deepStrictEqual([...mtype.ORDER], [...mtype.SELECTABLE]);
  assert.ok(mtype.listTypes().every((t) => t.key !== 'general' && t.label !== '一般・その他'));
  assert.strictEqual(mtype.AUTO_UNDECIDED_TEXT, '自動判定: 決まらなかったので会議の要点の型でまとめました');
});

test('listTypes が UI 用に全タイプを返す', () => {
  const list = mtype.listTypes();
  assert.strictEqual(list.length, mtype.ORDER.length);
  for (const t of list) {
    assert.ok(t.key && t.label && typeof t.hint === 'string');
  }
});

test('キーワードに重複が無い（重複すると同じ語で二重加点される）', () => {
  for (const key of mtype.ORDER) {
    const kws = mtype.TYPES[key].keywords;
    assert.strictEqual(new Set(kws).size, kws.length,
      `${key} のキーワードが重複: ${kws.filter((k, i) => kws.indexOf(k) !== i)}`);
  }
});

// ---------------------------------------------------------------- アジェンダ雛形
// 0.11.0 M-1 で意図して変えた: アジェンダの雛形は前のページの手を付けていないメモを見分けるためだけに残すので、新しいプレゼン形式には作らない
// 0.11.0 P-12 で意図して変えた: 一般・その他は無い
test('プレゼン形式のほかの全タイプにアジェンダの雛形がある', () => {
  for (const t of mtype.listTypes()) {
    if (t.key === 'present') {
      assert.strictEqual(t.agenda, '', 'プレゼン形式には雛形を作らない');
      continue;
    }
    assert.ok(t.agenda && t.agenda.includes('・'), `${t.key} に雛形が無い`);
  }
});

test('getAgenda は未知のタイプで空を返す', () => {
  assert.strictEqual(mtype.getAgenda('nope'), '');
  assert.strictEqual(mtype.getAgenda(''), '');
  assert.ok(mtype.getAgenda('standup').length > 0);
});

// ---------------------------------------------------------------- 0.11.0 M-1（D43・D44・D45・P4・F25。計画 docs/plans/2026-10-22-110.md の「会議の種類の表」）
test('0.11.0 M-1・F25: 名前の付け直しは label だけ（key は前と同じ）。プレゼン形式を足した', () => {
  const want = { standup: '朝会・内部定例会', review: '部会・報告会', brainstorm: 'ブレスト・意見交換', oneonone: '1on1',
    interview: '採用面接・事前面談', sales: '商談', present: 'プレゼン形式' };
  for (const [k, v] of Object.entries(want)) assert.strictEqual(mtype.TYPES[k].label, v, k);
  for (const k of ['standup', 'review', 'oneonone', 'sales', 'interview', 'brainstorm']) assert.ok(mtype.ORDER.includes(k), `${k} の key が消えた`);
  assert.ok(mtype.ORDER.includes('present'));
  assert.strictEqual(mtype.TYPES.standup.hint, '朝会・週次の定例など、各担当の報告が中心の社内の会議');
  assert.strictEqual(mtype.TYPES.oneonone.hint, 'メンバーとの個別面談、キャリアの相談など');
  assert.strictEqual(mtype.TYPES.interview.hint, '候補者の採用面接と、社内の人との事前面談（案件や異動の前）');
  assert.strictEqual(mtype.TYPES.sales.hint, '顧客・パートナーとの商談（協業の検討も）');
  assert.strictEqual(mtype.TYPES.present.hint, '提案や説明会など、発表と質疑が中心の会議');
});

// 0.11.0 V-5（持ち主の画面の確かめ）で意図して変えた: プルダウンの群（GROUPS）は無い。並びは SELECTABLE の1か所
test('0.11.0 M-1・V-5（D43）: 選べる種類はこの並び（1か所）。プルダウンの群（GROUPS）は無い', () => {
  assert.deepStrictEqual([...mtype.SELECTABLE], ['standup', 'review', 'brainstorm', 'oneonone', 'interview', 'sales', 'present']);
  assert.strictEqual(mtype.GROUPS, undefined);
});

test('0.11.0 M-1（P4）: プレゼン形式の語と「事前面談」で当てる', () => {
  for (const t of ['提案発表会', '新製品のプレゼン', '社外向け説明会', 'デモ', '展示会 登壇']) assert.strictEqual(mtype.detectType(t, ''), 'present', t);
  assert.strictEqual(mtype.detectType('事前面談', ''), 'interview');
  assert.strictEqual(mtype.detectType('案件の事前面談', ''), 'interview');
  assert.deepStrictEqual(mtype.TYPES.present.keywords, ['プレゼン', '発表', '説明会', 'デモ', '登壇', '提案発表']);
  assert.ok(mtype.TYPES.interview.keywords.includes('事前面談'));
});

test('0.11.0 M-1（P12）: normalizeType と isSelectable は選べる鍵だけを通す（前の版の general・空・知らない値は ""）', () => {
  for (const k of mtype.SELECTABLE) { assert.strictEqual(mtype.normalizeType(k), k); assert.strictEqual(mtype.isSelectable(k), true); }
  for (const v of ['general', '', 'nope', '__proto__', 'constructor', null, undefined, 3, {}]) {
    assert.strictEqual(mtype.normalizeType(v), '', String(v));
    assert.strictEqual(mtype.isSelectable(v), false, String(v));
  }
});

// ---------------------------------------------------------------- 0.11.0 M-5（P14 (a)。計画の決めたこと 13）: 題名と文字起こしで決まらないときだけ、前の同じ曜日・時刻の会議の種類
test('0.11.0 M-5: slotType の表（過去 5 週・同じ曜日・開始 ±15 分・2回以上・どれも人が選んだ同じ種類のときだけ。ばらばらなら使わない）', () => {
  const at = (d, h, m) => new Date(2026, 9, d, h, m).toISOString();   // 2026-10-?? の PC の時計の時刻
  const now = at(27, 10, 0);   // 火曜 10:00
  const row = (d, h, m, t = 'oneonone') => ({ createdAt: at(d, h, m), meetingType: t });
  assert.strictEqual(mtype.slotType([row(20, 10, 5), row(13, 9, 50)], now), 'oneonone');
  assert.strictEqual(mtype.slotType([row(20, 10, 15), row(13, 9, 45)], now), 'oneonone', '±15 分ちょうどは入る');
  assert.strictEqual(mtype.slotType([row(20, 10, 0)], now), '', '1回だけ');
  assert.strictEqual(mtype.slotType([row(20, 10, 16), row(13, 10, 0)], now), '', '16 分ずれた会議は数えない（残り1回）');
  assert.strictEqual(mtype.slotType([row(21, 10, 0), row(22, 10, 0)], now), '', '別の曜日');
  assert.strictEqual(mtype.slotType([row(20, 10, 0), row(13, 10, 0, 'sales')], now), '', 'ばらばら');
  assert.strictEqual(mtype.slotType([row(20, 10, 0), row(13, 10, 0), row(6, 10, 0, 'sales')], now), '', '1回でも違えば使わない');
  assert.strictEqual(mtype.slotType([row(20, 10, 0), { createdAt: at(20 - 35, 10, 0), meetingType: 'oneonone' }], now), '', '5 週より前は数えない');
  assert.strictEqual(mtype.slotType([row(20, 10, 0, 'general'), row(13, 10, 0, 'general')], now), '', '選べない種類は使わない');
  assert.strictEqual(mtype.slotType([row(27, 10, 0), row(20, 10, 0)], at(20, 10, 1)), '', 'これより後の会議は数えない');
  assert.strictEqual(mtype.slotType('x', now), '');
  assert.strictEqual(mtype.slotType([row(20, 10, 0), row(13, 10, 0)], 'きのう'), '');
});
