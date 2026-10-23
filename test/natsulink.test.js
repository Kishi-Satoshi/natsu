/* natsulink.test.js — 0.10.0 Task LN-1（D72・D78・決めたこと 142・153・154。計画 docs/plans/2026-10-20-100.md）: 議事録のリンクの形と照らし（純粋） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/natsulink');

const T = { timeout: 5000 };
const O = 'https://natsu-help.natsu-code.workers.dev';
const ANCHORS = ['', 't:s12-s18', 't:s1-s1', 'b:b3_x-Y', 'm:0', 'm:12'];

test('D78・決めたこと 154: 住所の頭は LINK_ORIGIN の1か所。読むときに受ける頭は LINK_ORIGINS（今の頭を含む・凍っている）', T, () => {
  assert.strictEqual(L.LINK_ORIGIN, O);
  assert.ok(L.LINK_ORIGINS.includes(L.LINK_ORIGIN));
  assert.ok(Object.isFrozen(L.LINK_ORIGINS));
  for (const o of L.LINK_ORIGINS) assert.match(o, /^https:\/\/[a-z0-9.-]+$/);
});

test('D72・決めたこと 142: natsuLink と parseNatsuLink は行って戻る（会議・t・b・m）', T, () => {
  for (const a of ANCHORS) {
    const s = L.natsuLink('pm1', a);
    assert.strictEqual(s, a ? `natsu://page/pm1#${a}` : 'natsu://page/pm1');
    assert.deepStrictEqual(L.parseNatsuLink(s), { id: 'pm1', anchor: a }, s);
  }
  // 作れない形は ''
  for (const [id, a] of [['p m', ''], ['a'.repeat(65), ''], ['pm1', 't:s3-'], ['pm1', 'x:1'], ['pm1', 'm:a'], [null, ''], ['pm1', 'b:a/b']]) assert.strictEqual(L.natsuLink(id, a), '', `${id} ${a}`);
});

test('D72: parseNatsuLink は前の形 #<ブロック ID>（設計書の B10）を受けて読み捨てる・末尾の / を1つ許す・前後の空白を除く', T, () => {
  assert.deepStrictEqual(L.parseNatsuLink('natsu://page/pm1#b3'), { id: 'pm1', anchor: '' });
  assert.deepStrictEqual(L.parseNatsuLink('natsu://page/pm1/'), { id: 'pm1', anchor: '' });
  assert.deepStrictEqual(L.parseNatsuLink('natsu://page/pm1#t:s3-s5/'), { id: 'pm1', anchor: 't:s3-s5' });
  assert.deepStrictEqual(L.parseNatsuLink('  natsu://page/pm1#m:2 \n'), { id: 'pm1', anchor: 'm:2' });
});

test('D72: parseNatsuLink が null（大文字・natsu:page/・ほかの道・? ・% ・空白・引用符・\\・制御の文字・301 文字・65 文字の ID・壊れた印・# が2つ・// の2つ目・文字でない）', T, () => {
  for (const s of ['NATSU://page/pm1', 'natsu:page/pm1', 'natsu://other/pm1', 'natsu://page/pm1?x=1', 'natsu://page/pm%201', 'natsu://page/p m1', 'natsu://page/pm1"',
    "natsu://page/pm1'", 'natsu://page/pm1\\', 'natsu://page/pm1\u0000', 'natsu://page/pm1\u007f', `natsu://page/pm1#${'b'.repeat(288)}`, `natsu://page/${'a'.repeat(65)}`,
    'natsu://page/pm1#t:s3-', 'natsu://page/pm1#t:s3', 'natsu://page/pm1#a#b', 'natsu://page/pm1//', 'natsu://page/', 'natsu://page/../x', 'natsu://page/pm1#javascript:x',
    '', ' ', null, undefined, 5, {}, ['natsu://page/pm1']]) {
    assert.strictEqual(L.parseNatsuLink(s), null, JSON.stringify(s));
  }
});

test('D78・決めたこと 153: openUrl と parseOpenUrl は行って戻る（#p=<ID> と、あれば &a=<印>）。LINK_ORIGINS のどれでも読める', T, () => {
  for (const a of ANCHORS) {
    const s = L.openUrl('pm1', a);
    assert.strictEqual(s, a ? `${O}/open#p=pm1&a=${a}` : `${O}/open#p=pm1`);
    assert.deepStrictEqual(L.parseOpenUrl(s), { id: 'pm1', anchor: a }, s);
  }
  for (const o of L.LINK_ORIGINS) assert.deepStrictEqual(L.parseOpenUrl(`${o}/open#p=pz9`), { id: 'pz9', anchor: '' });
  assert.strictEqual(L.openUrl('p m', ''), '');
  assert.strictEqual(L.openUrl('pm1', 'x:1'), '');
  // 後の共有のため、知らない鍵は飛ばして読む（今の鍵の順は決まり）・末尾の / を1つ・前後の空白
  assert.deepStrictEqual(L.parseOpenUrl(`${O}/open#p=pm1&x=1&a=t:s1-s2`), { id: 'pm1', anchor: 't:s1-s2' });
  assert.deepStrictEqual(L.parseOpenUrl(`${O}/open#p=pm1&w=team1`), { id: 'pm1', anchor: '' });
  assert.deepStrictEqual(L.parseOpenUrl(`  ${O}/open#p=pm1/ `), { id: 'pm1', anchor: '' });
});

test('D78: parseOpenUrl が null（http・ほかの住所・似た住所・道が /open でない・? の形・鍵の順が違う・同じ鍵が2つ・壊れた印・空の p・301 文字・文字でない）', T, () => {
  for (const s of ['http://natsu-help.natsu-code.workers.dev/open#p=pm1', 'https://natsu-help.evil.workers.dev/open#p=pm1', `${O}.evil.com/open#p=pm1`,
    'https://natsu-help.natsu-code.workers.dev.evil.com/open#p=pm1', `${O}/open/x#p=pm1`, `${O}/opens#p=pm1`, `${O}/open?p=pm1`, `${O}/open#a=t:s1-s2&p=pm1`,
    `${O}/open#p=pm1&a=t:s1-s2&a=m:1`, `${O}/open#p=pm1&p=pm2`, `${O}/open#p=pm1&a=t:s3-`, `${O}/open#p=pm1&a=javascript:x`, `${O}/open#p=../x`, `${O}/open#p=`,
    `${O}/open#p=${'a'.repeat(65)}`, `${O}/open#p=pm1&x=${'y'.repeat(260)}`, `${O}/open#p=pm1 x`, `${O}/open#p=pm1&a=t:s1-s2"`, `${O}/open`, `${O}/open#`,
    `${O.toUpperCase()}/open#p=pm1`, `${O}/OPEN#p=pm1`, `${O}/open#p=pm1&=1`, `${O}/open#p=pm1&X=1`, '', null, 5, {}]) {
    assert.strictEqual(L.parseOpenUrl(s), null, JSON.stringify(s));
  }
});

test('D72・D78: parseAnyLink は ID だけでなく natsu:// と https の住所のどちらも読む（MCP の meetingRef と、画面に貼ったときの main の照らしが使う）', T, () => {
  assert.deepStrictEqual(L.parseAnyLink(`natsu://page/pm1#t:s1-s2`), { id: 'pm1', anchor: 't:s1-s2' });
  assert.deepStrictEqual(L.parseAnyLink(`${O}/open#p=pm1&a=m:3`), { id: 'pm1', anchor: 'm:3' });
  for (const s of ['pm1', '', 'natsu:page/pm1', `${O}/open?p=pm1`]) assert.strictEqual(L.parseAnyLink(s), null, s);
});
