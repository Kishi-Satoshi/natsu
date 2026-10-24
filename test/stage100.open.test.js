/*
 * stage100.open.test.js — 0.10.0 Task LN-5（D78・決めたこと 155・156。問い R23 の (a)）: ヘルプのサイトの /open のページ。
 * 会議の中身を持たず、# の後ろ（p=<ID>・a=<印>）を照らして natsu:// で NaTsu を開く。help-build が作る形と、open.js の動き（偽の document と location）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const NL = require('../src/natsulink');
const { tmpDir } = require('./helpers/help-tmp');
const { build } = require('../tools/help-build');

const ROOT = path.join(__dirname, '..');
const T = { timeout: 10000 };
const OPEN_JS = fs.readFileSync(path.join(ROOT, 'help', 'assets', 'open.js'), 'utf8');
const OPEN_HTML = () => fs.readFileSync(path.join(ROOT, 'help', 'open', 'index.html'), 'utf8');
const LOST = 'ログインの後は、Claude のリンクをもう一度押してください。';
// help-dads 3回目の審査の指摘 7（持ち主の答え 2026-10-23）: 次に何をすればよいかも言う
const BAD = 'このリンクは開けません（形が違います）。NaTsu でもう一度［リンクを写す］を押してください。';
// help-dads 再審査の指摘 8（持ち主の答え 2026-10-23）: 開けたかが分からないうちに「開きました」と言い切らない
const DONE = 'NaTsu で開いています。開かないときは［NaTsu で開く］を押してください。';
const NOTE = 'NaTsu が入っていない PC では開けません。NaTsu を入れるには［インストールと更新］の記事を見てください。';

// open.js を偽の document と location で回す → { href（location.href に入れた物。入れなければ null）, msg, go: { hidden, href } }
function runOpen(hash) {
  const el = (id) => ({ id, hidden: id === 'hc-open-go', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; } });
  const els = { 'hc-open-msg': el('hc-open-msg'), 'hc-open-go': el('hc-open-go') };
  let href = null;
  const location = { hash, get href() { return `https://help.test/open/${hash}`; }, set href(v) { href = String(v); }, assign(v) { href = String(v); }, replace(v) { href = String(v); } };
  const sandbox = { document: { getElementById: (id) => els[id] || null, documentElement: { classList: { add() {} } } }, location, window: {} };
  sandbox.window = sandbox;
  vm.runInNewContext(OPEN_JS, sandbox, { timeout: 1000 });
  return { href, msg: els['hc-open-msg'].textContent, go: { hidden: els['hc-open-go'].hidden, href: els['hc-open-go'].getAttribute('href') } };
}

test('D78・決めたこと 155: open.js は #p=<ID>&a=<印> を照らし、location.href と［NaTsu で開く］の href に natsu://page/<ID>#<印> を入れ、「NaTsu で開いています。開かないときは［NaTsu で開く］を押してください。」（再審査の指摘 8）', T, () => {
  for (const [hash, want] of [['#p=pm1&a=t:s1-s3', 'natsu://page/pm1#t:s1-s3'], ['#p=pm1', 'natsu://page/pm1'], ['#p=pm1&a=b:b3', 'natsu://page/pm1#b:b3'],
    ['#p=pm1&w=team1&a=m:2', 'natsu://page/pm1#m:2']]) {
    const r = runOpen(hash);
    assert.strictEqual(r.href, want, hash);
    assert.deepStrictEqual(r.go, { hidden: false, href: want }, hash);
    assert.strictEqual(r.msg, DONE, hash);
  }
});

test('D78: 読めない # の後ろ（../x・javascript:・順の違い・? の形・空白・長すぎる）は location を変えず「このリンクは開けません（形が違います）。NaTsu でもう一度［リンクを写す］を押してください。」（3回目の指摘 7）。# の後ろが空（ログインで落ちた: R23）は「ログインの後は、Claude のリンクをもう一度押してください。」', T, () => {
  for (const hash of ['#p=../x', '#p=pm1&a=javascript:alert(1)', '#a=t:s1-s2&p=pm1', '#p=pm1&p=pm2', '#p=pm1 x', '#p=pm1%20', `#p=pm1&x=${'y'.repeat(300)}`, '#p=', '#x=1', '#p=pm1&a=t:s3-']) {
    const r = runOpen(hash);
    assert.strictEqual(r.href, null, hash);
    assert.strictEqual(r.go.hidden, true, hash);
    assert.strictEqual(r.msg, BAD, hash);
  }
  for (const hash of ['', '#']) {
    const r = runOpen(hash);
    assert.deepStrictEqual([r.href, r.go.hidden, r.msg], [null, true, LOST], JSON.stringify(hash));
  }
});

test('D78: open.js の照らしと natsulink.parseOpenUrl に同じ表を当てて同じ答え（住所の # の後ろ）', T, () => {
  const frags = ['p=pm1', 'p=pm1&a=t:s1-s3', 'p=pm1&a=b:x_1', 'p=pm1&a=m:0', 'p=pm1&x=1&a=t:s1-s2', 'p=pm1&w=team1', 'p=pm1/', 'p=../x', 'p=', 'a=t:s1-s2&p=pm1',
    'p=pm1&a=t:s1-s2&a=m:1', 'p=pm1&p=pm2', 'p=pm1&a=t:s3-', 'p=pm1&a=javascript:x', `p=${'a'.repeat(65)}`, 'p=pm1&=1', 'p=pm1&X=1', 'p=pm1 x', 'p=pm1"', `p=pm1&x=${'y'.repeat(260)}`];
  for (const f of frags) {
    const want = NL.parseOpenUrl(`${NL.LINK_ORIGIN}/open#${f}`);
    const r = runOpen(`#${f}`);
    assert.strictEqual(r.href, want ? NL.natsuLink(want.id, want.anchor) : null, f);
  }
});

test('D78・決めたこと 155: help/open/index.html は静かなページ（インラインの script・style= ・on…= が無く、読むのは /assets/ の書体と CSS と open.js だけ。fetch・XMLHttpRequest・img・外の住所が無い）。文がそろっている', T, () => {
  const h = OPEN_HTML();
  const scripts = [...h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.deepStrictEqual(scripts.map((m) => [m[1].trim(), m[2].trim()]), [['src="/assets/open.js" defer', '']]);
  assert.ok(!/\sstyle=|\son[a-z]+=|<img\b|<iframe\b/i.test(h));
  for (const m of h.matchAll(/\s(?:href|src)="([^"]*)"/g)) assert.ok(m[1].startsWith('/') && !m[1].startsWith('//'), m[1]);
  assert.ok(!/https?:\/\//.test(h), '外の住所がある');
  assert.match(h, /<meta name="robots" content="noindex">/);
  assert.match(h, /<h1>NaTsu で開く<\/h1>/);
  assert.match(h, /<a id="hc-open-go" class="open-go" hidden>NaTsu で開く<\/a>/);
  assert.match(h, /<p id="hc-open-msg" class="lede" role="status"><\/p>/);
  assert.ok(h.replace(/<[^>]+>/g, '').includes(NOTE), '入っていない PC の文が無い');
  for (const w of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'importScripts', 'new Image', 'innerHTML', 'eval(', 'http://', 'https://']) assert.ok(!OPEN_JS.includes(w), `open.js に ${w}`);
});

test('D78: help-build は /open/index.html を作り（help/open/index.html のまま）、検索の索引・記事の一覧・ホームと分類の一覧に入れない', T, (t) => {
  const root = tmpDir(t, 'natsu-help-open-');
  fs.cpSync(path.join(ROOT, 'help'), path.join(root, 'help'), { recursive: true, filter: (s) => !s.includes(`${path.sep}dist`) });
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(root, 'CHANGELOG.md'));   // help-relnotes RN-3: リリースノートの元
  const out = path.join(root, 'out');
  const r = build({ root, out });
  assert.ok(r.pages.includes('open/index.html'), r.pages.join(','));
  assert.strictEqual(fs.readFileSync(path.join(out, 'open', 'index.html'), 'utf8'), OPEN_HTML());
  assert.ok(fs.existsSync(path.join(out, 'assets', 'open.js')));
  assert.ok(!r.articles.some((a) => /open/.test(a.url)));
  const idx = fs.readFileSync(path.join(out, 'search-index.json'), 'utf8');
  assert.ok(!idx.includes('/open/') && !idx.includes('NaTsu で開く'), '検索の索引に /open がある');
  for (const f of ['index.html', 'start/index.html']) assert.ok(!fs.readFileSync(path.join(out, f), 'utf8').includes('/open/'), `${f} に /open へのリンク`);
});
