/*
 * stage100.mcp.app.test.js — 0.10.0 の設定のカード「Claude との連携（MCP）」（計画 docs/plans/2026-10-20-100.md の Task C-3。MR8・D34・D64・D75・D76）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。main の答えは偽物（preload.js の名前から作る）。
 * 0.9.2 の形（決めたこと 67）: 見出しの横の ⓘ・頭の1行と注意の1行・吹き出しに長い文・行の状態は .eng-state・押した後の文は #mcpMsg。
 */
'use strict';
const { titleAt } = require('./helpers/titles');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { parseHTML } = require('./helpers/simdom');
const lib = require('../src/mainlib');
const cli = require('../src/claude-cli');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const html = fs.readFileSync(APP, 'utf8');
const doc = parseHTML(html).root;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const LIST = [{ id: 'pa1', title: titleAt('2026-10-16T01:00:00.000Z'), date: '10/16', durationSec: 1800, hasSummary: true }];
const PAGE = (id) => ({ page: { id, title: titleAt('2026-10-16T01:00:00.000Z'), createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
const UI = () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' } });
const ST = (state, running = false) => ({ desktop: { state, files: state === 'noclaude' ? 0 : 1, running } });
const open = (o = {}) => load(APP, { preloadSrc: PRELOAD, html, returns: { pagesSearch: () => LIST, pageGet: PAGE, uiState: UI, openHelp: () => true, mcpStatus: () => ST('none'), ...o } });
const $ = (l, id) => l.document.getElementById(id);
const click = async (l, el) => { (typeof el === 'string' ? $(l, el) : el).dispatchEvent({ type: 'click' }); await l.drain(); };
const pick = async (l, sec) => { const nav = $(l, 'setNav'); nav.dispatchEvent({ type: 'click', target: nav.querySelector(`[data-sec="${sec}"]`) }); await l.drain(); };
const search = async (l, q) => { const b = $(l, 'setSearch'); b.value = q; b.dispatchEvent({ type: 'input', target: b }); await l.drain(); };
const settingsOpen = (l) => $(l, 'settingsModal').hidden === false;
const visible = (el) => { for (let n = el; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) { if (n.id === 'settingsModal') return true; if (n.hidden || n.classList.contains('set-miss')) return false; } return true; };
const shownRows = (l) => l.byId.get('tabSettings').querySelectorAll('[data-row]').filter(visible).map((r) => r.dataset.row);
const openSummary = async (o) => { const l = await open(o); await l.drain(); await click(l, 'tabBtnSettings'); await pick(l, 'summary'); return l; };

// 持ち主の答え（2026-10-23）で意図して変えた: Claude Code の登録は作らない（D64）ので、頭の1行から「Claude Code」を外す
const C0 = 'Claude デスクトップから議事録を読めるようにします。';
const C2 = '※ 読んだ議事録は Claude（Anthropic）へ送られます。';
const C3 = 'Claude デスクトップの設定に NaTsu の MCP を足します。';
const POP = ['Claude に「10/20 の議事録を読んでレポートして」のように頼めます。', 'Claude は議事録を読むだけで、書き換えません。',
  'Claude に頼むと、Claude が読んだ議事録の題名・要約・メモ・文字起こしは、Claude（Anthropic）へ送られます（オフラインモードで録った会議も同じです）。',
  '1on1・面談の議事録を扱う前に、Claude の設定のプライバシーで、会話をモデルの学習に使わない設定にしてください。',
  '登録の前と、NaTsu を入れ直す前は、Claude デスクトップを終了してください（タスクトレイのアイコンからも）。',
  '議事録を消しても、Claude が一度読んだ内容は Claude の会話に残ります。'];
const SHORT = { none: '登録していません', same: '登録済み', stale: '登録の場所が古くなっています', other: '別の「natsu」の登録があります', noclaude: 'Claude デスクトップが見つかりません',
  broken: '設定ファイルを読めません', busy: '設定ファイルを今は読めません', readonly: '設定ファイルが読み取り専用です', gone: '登録が消えています' };
const LONG = {
  stale: 'NaTsu を別の場所に入れ直したため、登録の場所が古くなっています。［登録し直す］を押してください。',
  other: 'Claude デスクトップに、NaTsu のものでない「natsu」という登録があります。Claude デスクトップの設定でその登録を消すか名前を変えてから、もう一度押してください。',
  noclaude: 'Claude デスクトップが見つかりません。Claude デスクトップを入れて一度起動してから、もう一度押してください。',
  broken: 'Claude デスクトップの設定ファイルが正しく読めないため、登録しませんでした（ファイルは変えていません）。Claude デスクトップの設定の「開発者」（Developer）の「設定を編集」（Edit Config）で、中身を確かめてください。',
  busy: 'Claude デスクトップの設定ファイルを今は読めませんでした（ほかのプログラムが使っています）。少し待ってから、もう一度押してください。',
  readonly: 'Claude デスクトップの設定ファイルが読み取り専用のため、登録しませんでした。',
  gone: 'Claude デスクトップへの登録が消えています（Claude デスクトップが設定を書き直したときなど）。［登録し直す］を押してください。',
};
const DONE = '登録しました。Claude デスクトップを起動してください（動いていたなら、タスクトレイのアイコンからも終了してから起動し直してください）。';
const OFF = '登録を外しました。Claude デスクトップを起動し直すと、NaTsu の道具が消えます。';
const RUNNING = 'Claude デスクトップが動いています。タスクトレイのアイコンからも終了してから押してください（動いたまま登録すると、Claude デスクトップを起動し直すまで読めません）。';
const SONNET = '要約のモデルは Claude の Sonnet の最新版に固定しています（選べません。新しい Sonnet が出ると自動で切り替わります）。';

// ---------------------------------------------------------------- 形（静的）

test('MR8: 項目「要約」の、要約（Claude Code）の次にカード「Claude との連携（MCP）」。見出しの ⓘ・頭の1行 C0・注意の1行 C2（吹き出しの外・隠れていない）・吹き出し #setPopMcp の文・行は1つ・最後に #mcpMsg', T, () => {
  const cards = doc.querySelector('#tabSettings').querySelector('.scroll').children.filter((c) => c.classList.contains('card'));
  const i = cards.findIndex((c) => c.id === 'mcpCard');
  assert.ok(i > 0, 'カード #mcpCard が無い');
  const card = cards[i];
  assert.strictEqual(card.dataset.sec, 'summary');
  assert.strictEqual(norm(cards[i - 1].querySelector('h2').textContent), '要約（Claude Code）', '要約（Claude Code）の次でない');
  const h2 = card.querySelector('h2');
  assert.ok(!h2.id, '見出しに id がある');
  const info = h2.querySelector('.setinfo');
  assert.ok(info && info.getAttribute('aria-controls') === 'setPopMcp' && info.getAttribute('aria-label') === '「Claude との連携（MCP）」の説明', '見出しの ⓘ が無い');
  assert.strictEqual(norm(h2.textContent), 'Claude との連携（MCP）');
  const lead = card.children.find((k) => k.classList.contains('setlead'));
  assert.ok(lead, 'カードの頭が無い');
  assert.strictEqual(norm(lead.querySelectorAll('.desc').filter((d) => !d.classList.contains('warn'))[0].textContent), C0);
  const w = lead.querySelectorAll('.warn');
  assert.strictEqual(w.length, 1);
  assert.strictEqual(norm(w[0].textContent), C2);
  for (let n = w[0]; n && n !== card; n = n.parentNode) assert.ok(!n.hasAttribute('hidden'), '注意が隠れている');
  const pop = card.children.find((k) => k.id === 'setPopMcp');
  assert.ok(pop && pop.hasAttribute('hidden') && pop.classList.contains('setpop'), '吹き出しがカードの直の子に無い');
  const t = norm(pop.textContent);
  for (const s of POP) assert.ok(t.includes(s), `吹き出しに「${s}」が無い`);
  assert.ok(lib.HELP_ARTICLES.includes(pop.querySelector('.setpop-help').dataset.help));
  const rows = card.querySelectorAll('[data-row]');
  assert.deepStrictEqual(rows.map((r) => r.dataset.row), ['Claude デスクトップから読む']);
  const row = rows[0];
  assert.ok(row.classList.contains('field') && row.classList.contains('frow') && row.classList.contains('fstack'));
  assert.strictEqual(norm(row.querySelector('.flead .desc').textContent), C3);
  const st = row.querySelector('#mcpDesktopState');
  assert.ok(st && st.classList.contains('eng-state') && st.tagName === 'span');
  for (const id of ['mcpRegister', 'mcpUnregister']) { const b = row.querySelector(`#${id}`); assert.ok(b && b.tagName === 'button' && b.getAttribute('type') === 'button', id); }
  const last = card.children[card.children.length - 1];
  assert.ok(last.id === 'mcpMsg' && last.classList.contains('desc') && last.classList.contains('save-msg'), '最後が #mcpMsg でない');
  // D64: Claude Code の行・コマンドを写すボタンは作らない
  assert.ok(!rows.some((r) => /Claude Code/.test(r.dataset.row)));
  assert.ok(!/写す|コピー/.test(card.textContent), 'コマンドを写すボタンがある');
});

test('D34: 要約（Claude Code）の吹き出しに、要約のモデルは Sonnet の最新版に固定の1行。claude-cli の CLAUDE_MODEL は sonnet（片方だけ変えると赤）', T, () => {
  assert.strictEqual(cli.CLAUDE_MODEL, 'sonnet');
  const items = doc.querySelector('#claudeHelp').querySelectorAll('li').map((li) => norm(li.textContent));
  assert.ok(items.includes(SONNET), items.join('\n'));
});

test('preload: koeApp.mcpStatus・mcpRegister・mcpUnregister は引数なしで mcp:status・mcp:register・mcp:unregister を呼ぶ（パスを渡さない）', T, () => {
  assert.match(PRELOAD, /mcpStatus: \(\) => ipcRenderer\.invoke\('mcp:status'\),/);
  assert.match(PRELOAD, /mcpRegister: \(\) => ipcRenderer\.invoke\('mcp:register'\),/);
  assert.match(PRELOAD, /mcpUnregister: \(\) => ipcRenderer\.invoke\('mcp:unregister'\),/);
});

// ---------------------------------------------------------------- 動き

test('MR8: 開くたびに状態を聞き、9つの状態の短い文・ボタンの出し分け（stale・gone は［登録し直す］・noclaude は押せない・［登録を外す］は same と stale だけ）・#mcpMsg の長い文（none・same は空）', T, async () => {
  for (const s of Object.keys(SHORT)) {
    const l = await openSummary({ mcpStatus: () => ST(s) });
    assert.ok(l.called('mcpStatus').length >= 1, `${s}: 状態を聞いていない`);
    assert.strictEqual($(l, 'mcpDesktopState').textContent, SHORT[s], s);
    assert.ok($(l, 'mcpDesktopState').classList.contains('eng-state'), s);
    const reg = $(l, 'mcpRegister');
    assert.strictEqual(reg.textContent, s === 'stale' || s === 'gone' ? '登録し直す' : 'Claude デスクトップに登録', s);
    assert.strictEqual(Boolean(reg.disabled), s === 'noclaude', `${s}: 押せるかが違う`);
    assert.strictEqual($(l, 'mcpUnregister').hidden, !(s === 'same' || s === 'stale'), `${s}: ［登録を外す］の出し分け`);
    assert.strictEqual($(l, 'mcpUnregister').textContent, '登録を外す');
    assert.strictEqual($(l, 'mcpMsg').textContent, LONG[s] || '', s);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  }
  // 状態を読めない（答えが壊れている・投げた）ときは busy と同じ
  for (const bad of [() => null, () => ({ desktop: { state: 'x' } }), () => { throw new Error('x'); }]) {
    const l = await openSummary({ mcpStatus: bad });
    assert.strictEqual($(l, 'mcpDesktopState').textContent, SHORT.busy);
  }
});

test('MR8・D75: ［Claude デスクトップに登録］で koeApp.mcpRegister が1回（引数なし）・押している間は2つのボタンを押せない・答えの文が #mcpMsg に出て状態を描き直す。動いていれば頭に知らせ。断ったら長い文', T, async () => {
  let st = ST('none');
  let release;
  const l = await openSummary({ mcpStatus: () => st, mcpRegister: () => new Promise((r) => { release = r; }) });
  await click(l, 'mcpRegister');
  assert.deepStrictEqual(l.called('mcpRegister').map((c) => c.args), [[]]);
  assert.ok($(l, 'mcpRegister').disabled && $(l, 'mcpUnregister').disabled, '押している間に押せる');
  st = ST('same');
  release({ ok: true, state: 'same', running: false });
  await l.drain();
  assert.strictEqual($(l, 'mcpMsg').textContent, DONE);
  assert.strictEqual($(l, 'mcpDesktopState').textContent, SHORT.same);
  assert.ok(!$(l, 'mcpRegister').disabled);
  assert.strictEqual($(l, 'mcpUnregister').hidden, false);
  // 動いている（開いたとき・押したとき）
  const r = await openSummary({ mcpStatus: () => ST('none', true), mcpRegister: () => ({ ok: true, state: 'same', running: true }) });
  assert.strictEqual($(r, 'mcpMsg').textContent, RUNNING);
  await click(r, 'mcpRegister');
  assert.strictEqual($(r, 'mcpMsg').textContent, `${RUNNING} ${DONE}`);
  // 断った
  for (const code of ['broken', 'other', 'readonly', 'busy', 'noclaude']) {
    const n = await openSummary({ mcpStatus: () => ST('none'), mcpRegister: () => ({ ok: false, state: code, code, running: null }) });
    await click(n, 'mcpRegister');
    assert.strictEqual($(n, 'mcpMsg').textContent, LONG[code], code);
  }
  // 外す
  const u = await openSummary({ mcpStatus: () => ST('same'), mcpUnregister: () => ({ ok: true, state: 'none' }) });
  await click(u, 'mcpUnregister');
  assert.deepStrictEqual(u.called('mcpUnregister').map((c) => c.args), [[]]);
  assert.strictEqual($(u, 'mcpMsg').textContent, OFF);
  assert.deepStrictEqual([l, r, u].flatMap((x) => x.errors).map(fmt), []);
});

test('MR8: 設定の検索で「MCP」と打つとこのカード（見出しと行）が出る。「学習」（吹き出しの中にだけある語）ではカードの頭が出て ⓘ に hit の印（行は出ない）', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  await search(l, 'MCP');
  const card = $(l, 'mcpCard');
  assert.ok(visible(card), 'カードが出ない');
  assert.ok(shownRows(l).includes('Claude デスクトップから読む'), shownRows(l).join(' / '));
  const lead = card.children.find((k) => k.classList.contains('setlead'));
  // 検索は見出しの文を見ない（0.9.2 の決まり）。頭の1行と吹き出しに「MCP」は無いので、頭は出さず、見出しと行だけ（計画の Ruling）
  assert.ok(!visible(lead), 'MCP の語の無いカードの頭が出た');
  await search(l, '学習');
  assert.ok(visible(card) && visible(lead), '吹き出しの語でカードの頭が出ない');
  assert.ok(!shownRows(l).includes('Claude デスクトップから読む'));
  assert.ok(card.querySelector('.setinfo[aria-controls="setPopMcp"]').classList.contains('hit'), 'ⓘ に hit の印が無い');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('D76: 左下の知らせの action settings-summary は［設定を開く］で、ポップアップが「要約」で開き、状態を聞き直す', T, async () => {
  const l = await open({ mcpStatus: () => ST('stale') });
  await l.drain();
  const before = l.called('mcpStatus').length;
  l.fire('onNotice', { text: 'NaTsu の置き場所が変わったため、Claude から議事録を読めなくなっています。設定の「要約」で［登録し直す］を押してください。', action: 'settings-summary' });
  await l.drain();
  const b = $(l, 'toast').querySelector('button');
  assert.ok(b, '知らせにボタンが無い');
  assert.strictEqual(b.textContent, '設定を開く');
  b.dispatchEvent({ type: 'click' }); await l.drain();
  assert.ok(settingsOpen(l), '設定が開かない');
  assert.strictEqual($(l, 'setNav').querySelector('[data-sec="summary"]').getAttribute('aria-selected'), 'true', '「要約」で開かない');
  assert.ok(l.called('mcpStatus').length > before, '状態を聞き直していない');
  assert.strictEqual($(l, 'mcpDesktopState').textContent, SHORT.stale);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});
