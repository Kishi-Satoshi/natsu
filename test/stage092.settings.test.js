/*
 * stage092.settings.test.js — 0.9.2（計画 docs/plans/2026-10-21-092.md）の設定の説明と ⓘ の吹き出し（I-2・I-3）。
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。main の答えは偽物（preload.js の名前から作る）。
 * I-2: 見える説明は1行（全角 40 字ほど）・長い文は名前と見出しの横の ⓘ の吹き出し・注意は見えたまま・押したときだけ開く・Esc は設定より先・
 *      外を押すと閉じる・開くのは1つ・置き方（placeInfoPop）・検索は吹き出しの中の言葉でも当たる・下の「ヘルプで詳しく見る ↗」。
 */
'use strict';
const { titleAt } = require('./helpers/titles');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { parseHTML } = require('./helpers/simdom');
const S = require('./helpers/simcss');
const lib = require('../src/mainlib');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const html = fs.readFileSync(APP, 'utf8');
const doc = parseHTML(html).root;
const rules = S.parse(doc.querySelectorAll('style').map((s) => s._raw).join('\n'));
const decl = (sel, at = '') => S.declsFor(rules, sel, { at });
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const LIST = [{ id: 'pa1', title: titleAt('2026-10-16T01:00:00.000Z'), date: '10/16', durationSec: 1800, hasSummary: true }];
const PAGE = (id) => ({ page: { id, title: titleAt('2026-10-16T01:00:00.000Z'), createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
const UI = () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' } });
const LIVE_LINE = 'const HELP_SITE_LIVE = true;';
const open = (o = {}, h = html) => load(APP, { preloadSrc: PRELOAD, html: h, returns: { pagesSearch: () => LIST, pageGet: PAGE, uiState: UI, openHelp: () => true, ...o } });
const $ = (l, id) => l.document.getElementById(id);
const click = async (l, el) => { (typeof el === 'string' ? $(l, el) : el).dispatchEvent({ type: 'click' }); await l.drain(); };
const key = async (l, o, target) => { const ev = l.key(o, target); await l.drain(); return ev; };
const pick = async (l, sec) => { const nav = $(l, 'setNav'); nav.dispatchEvent({ type: 'click', target: nav.querySelector(`[data-sec="${sec}"]`) }); await l.drain(); };
const search = async (l, q) => { const b = $(l, 'setSearch'); b.value = q; b.dispatchEvent({ type: 'input', target: b }); await l.drain(); };
const down = async (l, target) => { $(l, 'settingsModal').dispatchEvent({ type: 'pointerdown', target }); await l.drain(); };
const infoFor = (root, popId) => root.querySelector(`.setinfo[aria-controls="${popId}"]`);
const isOpenPop = (l, popId) => { const b = infoFor(l.root, popId); const p = $(l, popId); return !p.hidden && b.getAttribute('aria-expanded') === 'true' && b.classList.contains('open'); };
const isClosedPop = (l, popId) => { const b = infoFor(l.root, popId); const p = $(l, popId); return p.hidden === true && b.getAttribute('aria-expanded') === 'false' && !b.classList.contains('open'); };
const settingsOpen = (l) => $(l, 'settingsModal').hidden === false;
const visible = (el) => { for (let n = el; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) { if (n.id === 'settingsModal') return true; if (n.hidden || n.classList.contains('set-miss')) return false; } return true; };
const shownRows = (l) => l.byId.get('tabSettings').querySelectorAll('[data-row]').filter(visible).map((r) => r.dataset.row);
const shownCards = (l) => l.byId.get('tabSettings').querySelector('.scroll').children.filter((c) => c.classList.contains('card') && visible(c)).map((c) => norm(c.querySelector('h2').textContent));
// 全角 1・半角 0.5 で数えた長さ（モックの「全角 40 字ほど」）
const width = (s) => [...s].reduce((n, c) => n + (/[\x20-\x7e]/.test(c) ? 0.5 : 1), 0);

// I-2 の吹き出し（録音・要約）と、その記事・芯の言葉（決めたこと 14・計画の「画面の文」の表）
const POPS = {
  setPopLoop: { help: 'record/start-stop', must: ['パソコンから出ている音を、マイクと一緒に録ります。', '通知音や動画の音', 'イヤホン', 'マイクだけを使います', 'Windows でだけ動きます'] },
  setPopSpk: { help: 'record/start-stop', must: ['既定の再生デバイス', 'アプリの側からは選べない', '［Windowsの設定］', '追いかけません'] },
  setPopQuiet: { help: 'record/start-stop', must: ['5 分たっても答えが無ければ、録音を止めて議事録を作ります', '録音中のページ・録音バー・Windows の知らせ', '所要時間に入れません', '一時停止の間は数えません'] },
  setPopStt: { help: 'record/pc-only', must: ['中継も OpenAI も、音声と文字を保存しません。', '文字起こしの中継', 'OpenAI（gpt-4o-transcribe）', 'つながっていないときは、いつも PC の中で文字起こしします', '1on1・面談', '［オフラインモード］'] },   // 0.9.3 M-0（D54）で意図して変えた
  setPopTerms: { help: 'settings/appearance', must: ['「不具合」「改修」「結合テスト」「今週」', '上の辞書が優先で、余った分だけ使われます'] },
  claudeHelp: { help: 'start/claude-code', must: ['irm https://claude.ai/install.ps1 | iex', 'Anthropic の公式の入れ方', 'そのまま実行します', 'Git for Windows は無くても動きます', 'NaTsu はログインの情報を読みません', '5 時間ごと・週ごと'] },
  // I-3: アカウント・オフライン（詳細設定も）・更新
  setPopLogin: { help: 'start/login', must: ['Cloudflare（中継を守る仕組み）', '英語', '［ログイン］を押すと、ログインの画面が別の窓で開きます。', '［Send login code］', '6 けたのコード', '［Sign in］', '窓は自動で閉じます',
    '迷惑メールのフォルダ', '「already been used」', '［Request new code］', '会社のメールの検査が、先にコードを使ってしまうことがあります', '文字起こしの中継に送り、OpenAI で文字起こしします',
    'ログインしていないときと、つながっていないときは、PC の中で文字起こしします。'] },
  setPopOffline: { help: 'settings/offline', must: ['準備しなくても、インターネットにつながっていてログインしていれば、会議と音声入力はそのまま使えます。', 'オフラインモードの会議', 'この PC の中で文字起こしと要約ができるようになります'] },
  setPopWThreads: { help: 'settings/offline', must: ['文字起こしに使う CPU の数', 'コア数−2', '他の作業が重くなります', 'この PC の中だけで使う通信の番号', 'ぶつかって PC の中の文字起こしが起動できないときだけ変えてください'] },
  setPopSThreads: { help: 'settings/offline', must: ['意味は文字起こしエンジンの欄と同じです（こちらは要約に使われます）。', '2つのエンジンのポートは別の番号にしてください。'] },
  setPopCtx: { help: 'settings/offline', must: ['大きいほどメモリを使い、小さいと長い会議の統合で足りなくなります。'] },
  setPopIdle: { help: 'settings/offline', must: ['記録も要約もしていない時間', 'メモリを空けます', '次に使うとき起動し直します'] },
  setPopUpdate: { help: 'start/install-update', must: ['アプリ本体（数百KB）', 'エンジンやモデル、保存済みの議事録はそのままです。', 'src.backup-*', '1世代だけ残ります'] },
};
// I-3 で書き直す項目（I-2 の時点では「見える説明は1行」の外だった。I-3 で空にした: 全部の項目を見る）
const LATER_I3 = new Set([]);

// ---------------------------------------------------------------- 形（静的）

test('I5: ⓘ はどれも button type=button・class setinfo・aria-expanded=false・aria-controls が hidden の .setpop を指し・aria-label が「…」の説明。吹き出しは1つの ⓘ にだけ指される。ⓘ と吹き出しはラベルの中に無い', T, () => {
  const infos = doc.querySelector('#tabSettings').querySelectorAll('.setinfo');
  const pops = doc.querySelector('#tabSettings').querySelectorAll('.setpop');
  assert.ok(infos.length >= Object.keys(POPS).length, `ⓘ が ${infos.length} 個しか無い`);
  for (const id of Object.keys(POPS)) assert.ok(infoFor(doc, id), `#${id} を開く ⓘ が無い`);
  const seen = new Map();
  for (const b of infos) {
    const what = b.getAttribute('aria-label');
    assert.strictEqual(b.tagName, 'button', what);
    assert.strictEqual(b.getAttribute('type'), 'button', what);
    assert.strictEqual(b.getAttribute('aria-expanded'), 'false', what);
    assert.match(what || '', /^「[^「」]+」の説明$/, 'aria-label の形');
    const svg = b.querySelector('svg');
    assert.ok(svg && svg.getAttribute('aria-hidden') === 'true', `${what}: ⓘ の印が aria-hidden の SVG でない`);
    const pid = b.getAttribute('aria-controls');
    const p = doc.querySelector(`#${pid}`);
    assert.ok(p && p.classList.contains('setpop'), `${what}: aria-controls の先（${pid}）が吹き出しでない`);
    assert.ok(p.hasAttribute('hidden'), `${pid} が初めから開いている`);
    assert.ok(!seen.has(pid), `${pid} を2つの ⓘ が指している`);
    seen.set(pid, b);
    assert.ok(!b.closest('label'), `${what}: ⓘ がラベルの中にある（押すとトグルが切り替わる・読み上げの名前に混ざる）`);
    assert.ok(!p.closest('label'), `${pid}: 吹き出しがラベルの中にある（中の文を押すとトグルが切り替わる）`);
  }
  assert.deepStrictEqual(pops.filter((p) => !seen.has(p.id)).map((p) => p.id), [], 'どの ⓘ にも指されない吹き出しがある');
  // 押したときだけ開く（カーソルを乗せて開く受け口を持たない）
  const script = doc.querySelectorAll('script').map((s) => s.textContent).join('\n');
  assert.ok(!/mouseenter|mouseover|pointerenter|pointerover/.test(script), 'カーソルを乗せると開く受け口がある');
});

test('I5: 吹き出しの下は「ヘルプで詳しく見る ↗」（data-help の記事は HELP_ARTICLES にある）と「Esc で閉じる」。吹き出しの記事は計画の表のとおり', T, () => {
  for (const p of doc.querySelector('#tabSettings').querySelectorAll('.setpop')) {
    const foot = p.querySelector('.setpop-foot');
    assert.ok(foot, `${p.id} に下の行が無い`);
    const a = foot.querySelector('.setpop-help');
    assert.ok(a && a.tagName === 'button' && a.getAttribute('type') === 'button', `${p.id}: 「ヘルプで詳しく見る ↗」がボタンでない`);
    assert.strictEqual(norm(a.textContent), 'ヘルプで詳しく見る ↗', p.id);
    assert.ok(lib.HELP_ARTICLES.includes(a.dataset.help), `${p.id}: data-help ${a.dataset.help} が記事の一覧に無い`);
    assert.ok(!/https?:|\/\//.test(a.dataset.help), `${p.id}: 住所を書いた`);
    assert.strictEqual(norm(foot.querySelector('.setpop-esc').textContent), 'Esc で閉じる', p.id);
    // 矢印（aria-hidden の飾り）と、高すぎるときに中で捲る中身（.setpop-body）。下の行は捲らない
    assert.ok(p.children[0].classList.contains('setpop-arrow') && p.children[0].getAttribute('aria-hidden') === 'true', `${p.id}: 頭に矢印が無い`);
    assert.ok(p.children[1].classList.contains('setpop-body') && p.children[2] === foot && p.children.length === 3, `${p.id}: 矢印・中身・下の行の形でない`);
  }
  for (const [id, { help }] of Object.entries(POPS)) assert.strictEqual(doc.querySelector(`#${id}`).querySelector('.setpop-help').dataset.help, help, id);
});

test('I3: 動かした文の芯が吹き出しにある（計画の「画面の文」の表）', T, () => {
  for (const [id, { must }] of Object.entries(POPS)) {
    const p = doc.querySelector(`#${id}`);
    assert.ok(p, `#${id} が無い`);
    const t = norm(p.textContent);
    for (const w of must) assert.ok(t.includes(w), `#${id} に「${w}」が無い: ${t}`);
  }
});

test('I3: 「※ 録音していることは、会議の参加者に伝えてください。」は相手の声の行に見えたまま（吹き出しの中でない）', T, () => {
  const WARN = '※ 録音していることは、会議の参加者に伝えてください。';
  const row = doc.querySelector('#useSystemAudio').closest('[data-row]');
  const w = row.querySelectorAll('.warn');
  assert.strictEqual(w.length, 1, '注意の行が1つでない');
  assert.strictEqual(norm(w[0].textContent), WARN);
  assert.ok(!w[0].closest('.setpop'), '注意が吹き出しの中にある');
  for (let n = w[0]; n && n !== row; n = n.parentNode) assert.ok(!n.hasAttribute('hidden'), '注意が隠れている');
  for (const p of doc.querySelectorAll('.setpop')) assert.ok(!p.textContent.includes('録音していること'), `${p.id}: 注意を吹き出しへ入れた`);
});

// 見える説明（.desc・.d・.lhint）。吹き出しの中・赤い注意（.ng）・保存の文・記録中の断り・注意（.warn）と、main の答えで書く状態の文は数えない
const DYN = new Set(['engineNote', 'engineFetchSummary', 'engineFetchMsg', 'accountMsg', 'onlineMsg']);
const textOf = (el) => (el.tagName === '#text' ? el.textContent : el.classList && (el.classList.contains('lp') || el.classList.contains('setinfo')) ? '' : el.childNodes.map(textOf).join(''));
const descsOf = (unit) => unit.querySelectorAll('.desc, .d, .lhint').filter((d) => !d.closest('.setpop') && !DYN.has(d.id)
  && !['ng', 'warn', 'save-msg', 'lockNote'].some((c) => d.classList.contains(c)) && !(d.parentNode && d.parentNode.closest && d.parentNode.closest('.desc, .d')));
test('I2: 見える説明は1行（行・カードの頭・詳細設定の欄ごとに1つまで、全角 40 字まで）。注意は別に1行まで（40 字まで）', T, () => {
  const sec = doc.querySelector('#tabSettings');
  const cards = sec.querySelector('.scroll').children.filter((c) => c.classList.contains('card') && !LATER_I3.has(c.dataset.sec));
  const units = [];
  for (const c of cards) {
    for (const r of c.querySelectorAll('[data-row]')) if (r.id !== 'engineAdv') units.push([`「${r.dataset.row}」`, r]);
    for (const h of c.querySelectorAll('.setlead')) units.push([`「${norm(c.querySelector('h2').textContent)}」のカードの頭`, h]);
    // カードの直の子の説明（行でも頭でもない説明）を残さない
    for (const k of c.children) if ((k.classList.contains('desc') && !k.classList.contains('save-msg') && !DYN.has(k.id)) || (k.classList.contains('field') && !k.dataset.row && !k.classList.contains('setlead') && !k.classList.contains('lockNote') && k.querySelector('.desc'))) {
      assert.fail(`「${norm(c.querySelector('h2').textContent)}」のカードに、行でも頭でもない説明がある: ${norm(k.textContent).slice(0, 40)}`);
    }
    const adv = c.querySelector('#engineAdv');
    if (adv) for (const f of adv.querySelectorAll('.field, .check')) units.push([`詳細設定の「${norm((f.querySelector('label') || f).textContent).slice(0, 20)}」`, f]);
  }
  assert.ok(units.length >= 10, `見る行が ${units.length} しか無い`);
  for (const [what, u] of units) {
    const ds = descsOf(u);
    assert.ok(ds.length <= 1, `${what} に見える説明が ${ds.length} 行: ${ds.map((d) => norm(textOf(d))).join(' / ')}`);
    for (const d of ds) { const t = norm(textOf(d)); assert.ok(width(t) <= 40, `${what} の説明が長い（${width(t)}）: ${t}`); }
    const ws = u.querySelectorAll('.warn').filter((d) => !d.closest('.setpop'));
    assert.ok(ws.length <= 1, `${what} に注意が ${ws.length} 行`);
    for (const d of ws) assert.ok(width(norm(d.textContent)) <= 40, `${what} の注意が長い: ${norm(d.textContent)}`);
  }
});

test('I5: 要約（Claude Code）の行は、ボタンを説明の下に置く（.fstack は2列にせず、ボタンの行は左寄せ）', T, () => {
  const f = doc.querySelector('#claudeTest').closest('.field');
  assert.ok(f.classList.contains('frow') && f.classList.contains('fstack'), 'Claude Code の行が .frow.fstack でない');
  assert.strictEqual(decl('#tabSettings .field.frow.fstack').display, 'block', 'ボタンが説明の右に並ぶ');
  assert.strictEqual(decl('#tabSettings .field.frow.fstack > .row')['justify-content'], 'flex-start', 'ボタンの行が左寄せでない');
  assert.ok(f.children[0].classList.contains('flead') && f.children[1].classList.contains('row'), '説明の下にボタンの行が無い');
});

test('I5・I6: 吹き出しは position: fixed（右の列の捲りに切られない）。ⓘ と「ヘルプで詳しく見る ↗」にフォーカスの輪。色と影と角丸は決まりのトークン', T, () => {
  const p = decl('.setpop');
  assert.strictEqual(p.position, 'fixed');
  assert.strictEqual(p['box-shadow'], 'var(--shadow)');
  assert.ok(Number((/(\d+)px/.exec(p['border-radius'] || '') || [])[1]) <= 6, '吹き出しの角丸が 6px より大きい');
  assert.strictEqual(decl('.setpop-body')['overflow-y'], 'auto', '高すぎる吹き出しの中を捲れない');
  assert.ok(!p['overflow-y'] && !p.overflow, '吹き出しの外の箱を捲る形にした（矢印が切れる）');
  assert.strictEqual(decl('[hidden]').display, 'none !important', '[hidden] が勝たない（閉じた吹き出しが出る）');
  for (const sel of ['.setinfo:focus-visible', '.setpop-help:focus-visible']) {
    const r = rules.find((x) => x.sel.split(',').map((s) => s.trim()).includes(sel));
    assert.ok(r && r.decls.outline && !/none/.test(r.decls.outline), `${sel} に輪が無い`);
  }
  // JS が付け外しする印（open・hit・above）の見た目がある
  for (const sel of ['.setinfo.open', '.setinfo.hit', '.setpop.above .setpop-arrow']) assert.ok(rules.some((r) => r.sel.split(',').map((s) => s.trim()).includes(sel)), `${sel} の規則が無い`);
});

// 詳細度（id・class と属性と擬似クラス・要素）。:not などの中は数えない簡単な数え方（設定の規則の形だけを見る）
const spec = (sel) => {
  const x = sel.replace(/::[\w-]+/g, ' ');
  return [(x.match(/#[\w-]+/g) || []).length, (x.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length, (x.match(/(^|[\s>+~])[a-z][\w-]*/g) || []).length];
};
const stronger = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
test('I7: 検索で外した行（.set-miss）は、行の display のどの規則よりも強い規則で消える（2列の行・ⓘ の付くトグルの行・カードの頭も）', T, () => {
  const miss = rules.filter((r) => !r.at && r.decls.display === 'none' && r.sel.split(',').some((x) => /\.set-miss\b/.test(x)));
  assert.strictEqual(miss.length, 1, '.set-miss の規則が1つでない');
  const ms = spec(miss[0].sel.split(',').find((x) => /\.set-miss\b/.test(x)).trim());
  for (const r of rules) {
    if (!r.decls.display || r.decls.display === 'none' || r === miss[0]) continue;
    for (const sel of r.sel.split(',').map((x) => x.trim())) {
      if (!/#tabSettings|\.checkrow|\.setlead|\.frow|\.check\b|\.upd-row|\.eng-row/.test(sel) || /::|\s(input|svg|span|kbd|label)\b|>\s*(input|select|\.hkbox|\.row|\.flead|\.ctext|\.check)\b/.test(sel)) continue;
      assert.ok(stronger(ms, spec(sel)), `${sel}（${r.at || '画面'}）の display: ${r.decls.display} が .set-miss に勝つ（検索で外した行が出る）`);
    }
  }
});

// ---------------------------------------------------------------- 置き方（placeInfoPop。app.html から字面で取り出して走らせる）
const placeSrc = (() => {
  const at = html.indexOf('  function placeInfoPop(');
  assert.ok(at > 0, 'app.html に placeInfoPop が無い');
  return html.slice(at, html.indexOf('\n  }\n', at) + 4);
})();
const placeInfoPop = new Function(`${placeSrc}\nreturn placeInfoPop;`)();   // eslint-disable-line no-new-func
const R = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
test('I6: placeInfoPop は ⓘ の下（10px）に置き、左は ⓘ − 12。箱の内側 8px に寄せ、下に入らなければ上、幅と高さは箱 − 16 まで、矢印は ⓘ の真ん中', T, () => {
  const box = R(50, 40, 1020, 700);   // 100%（窓 1120×780）の設定の箱
  // 真ん中の行の ⓘ: 下に出す
  let p = placeInfoPop(R(446, 335, 18, 18), box, 360, 236);
  assert.deepStrictEqual([p.left, p.top, p.width, p.below, p.fits], [434, 363, 360, true, true]);
  assert.strictEqual(p.arrow, 446 + 9 - 434 - 5, '矢印が ⓘ の真ん中でない');
  assert.strictEqual(p.maxHeight, 700 - 16);
  // 右の端の ⓘ: 箱の右の内側 8px に寄せる（矢印は吹き出しの右の端の手前で止める）
  p = placeInfoPop(R(1050, 335, 18, 18), box, 360, 200);
  assert.strictEqual(p.left, 50 + 1020 - 8 - 360);
  assert.ok(p.arrow <= 360 - 18 && p.arrow >= 8, `矢印 ${p.arrow}`);
  // 左の端より左には出さない
  p = placeInfoPop(R(40, 335, 18, 18), box, 360, 200);
  assert.strictEqual(p.left, 58);
  assert.strictEqual(p.arrow, 8, '矢印が吹き出しの左の端より左');
  // 下の端の ⓘ: 下に入らないので上に出す
  p = placeInfoPop(R(446, 680, 18, 18), box, 360, 236);
  assert.deepStrictEqual([p.top, p.below], [680 - 10 - 236, false]);
  // 拡大 200%（窓 560×390。箱は窓いっぱい）: 幅 360 のまま、右の内側に収まる。下にも上にも入らなければ広い方で、箱の内側に寄せる
  const zbox = R(0, 0, 560, 390);
  p = placeInfoPop(R(500, 180, 18, 18), zbox, 360, 300);
  assert.strictEqual(p.width, 360);
  assert.strictEqual(p.fits, false, '上にも下にも入らないのに収まったと言う（ⓘ を捲らずに覆う）');
  assert.strictEqual(placeInfoPop(R(500, 60, 18, 18), zbox, 360, 280).fits, true, '上の行の ⓘ は下に収まる');
  assert.ok(p.left >= 8 && p.left + p.width <= 552, `左右がはみ出す: ${p.left}`);
  assert.ok(p.top >= 8 && p.top + 300 <= 382, `上下がはみ出す: ${p.top}`);
  // とても狭い箱: 幅は箱 − 16
  p = placeInfoPop(R(100, 100, 18, 18), R(0, 0, 300, 600), 360, 200);
  assert.deepStrictEqual([p.width, p.left], [284, 8]);
  // 高すぎる吹き出し: 高さは箱 − 16 で、上の端 8px から
  p = placeInfoPop(R(200, 100, 18, 18), zbox, 360, 900);
  assert.deepStrictEqual([p.maxHeight, p.top], [374, 8]);
  // 箱が無い（0×0。偽 DOM の矩形）でも投げない
  assert.doesNotThrow(() => placeInfoPop(R(0, 0, 0, 0), R(0, 0, 0, 0), 360, 0));
});

// ---------------------------------------------------------------- 開け閉め（simrun）

test('I5: ⓘ を押すと吹き出しが開き（hidden が無い・aria-expanded=true・open）、もう一度押すと閉じる。ほかの ⓘ を押すと前のは閉じる（開くのはいつも1つ）', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  await pick(l, 'record');
  const loop = infoFor(l.root, 'setPopLoop'), spk = infoFor(l.root, 'setPopSpk');
  await click(l, loop);
  assert.ok(isOpenPop(l, 'setPopLoop'), '押しても開かない');
  await click(l, loop);
  assert.ok(isClosedPop(l, 'setPopLoop'), 'もう一度押しても閉じない');
  await click(l, loop);
  await click(l, spk);
  assert.ok(isOpenPop(l, 'setPopSpk'));
  assert.ok(isClosedPop(l, 'setPopLoop'), 'ほかの ⓘ を開いても前の吹き出しが開いたまま');
  assert.strictEqual(l.byId.get('tabSettings').querySelectorAll('.setpop').filter((p) => !p.hidden).length, 1, '開いている吹き出しが1つでない');
  // トグルは切り替わらない（ⓘ はラベルの外）
  assert.strictEqual($(l, 'useSystemAudio').checked, false);
  assert.deepStrictEqual(l.called('saveSettings'), [], 'ⓘ を押して設定を保存した');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('I4: 吹き出しが開いている間の Esc は吹き出しだけを閉じ（preventDefault）、フォーカスは ⓘ に戻り、設定は開いたまま。もう一度 Esc で設定を閉じる。中のリンクにフォーカスがあっても・検索の欄でも吹き出しが先', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  await pick(l, 'record');
  const b = infoFor(l.root, 'setPopLoop');
  b.focus();
  await click(l, b);
  let ev = await key(l, { key: 'Escape' }, b);
  assert.strictEqual(ev.defaultPrevented, true);
  assert.ok(isClosedPop(l, 'setPopLoop'), 'Esc で吹き出しが閉じない');
  assert.ok(settingsOpen(l), 'Esc で設定まで閉じた');
  assert.ok(l.document.activeElement === b, 'フォーカスが ⓘ に戻らない');
  // 中のリンクにフォーカスがあるとき
  await click(l, b);
  const link = $(l, 'setPopLoop').querySelector('.setpop-help');
  link.focus();
  await key(l, { key: 'Escape' }, link);
  assert.ok(isClosedPop(l, 'setPopLoop') && settingsOpen(l), '中のリンクの Esc で吹き出しが閉じない・設定が閉じた');
  assert.ok(l.document.activeElement === b, 'リンクから閉じたのにフォーカスが ⓘ に戻らない');
  // 検索の欄（文字あり）: 吹き出しが先。文字は消さない
  await search(l, 'イヤホン');
  await click(l, infoFor(l.root, 'setPopLoop'));
  const sb = $(l, 'setSearch');
  sb.focus();
  await key(l, { key: 'Escape' }, sb);
  assert.ok(isClosedPop(l, 'setPopLoop'), '検索の欄の Esc で吹き出しが閉じない');
  assert.strictEqual(sb.value, 'イヤホン', '吹き出しを閉じる Esc で検索の文字を消した');
  assert.ok(settingsOpen(l));
  await key(l, { key: 'Escape' }, sb);
  assert.strictEqual(sb.value, '', '次の Esc で検索の文字が消えない');
  ev = await key(l, { key: 'Escape' });
  assert.ok(!settingsOpen(l), '吹き出しが無いときの Esc で設定が閉じない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('I4: 外（ほかの行・暗い所）の pointerdown で閉じる。吹き出しの中とその ⓘ では閉じない。項目を替える・検索を打つ・× で閉じると閉じる', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  await pick(l, 'record');
  const b = infoFor(l.root, 'setPopStt');
  const p = $(l, 'setPopStt');
  await click(l, b);
  await down(l, p);
  await down(l, p.querySelector('li') || p.children[0]);
  await down(l, b);
  assert.ok(isOpenPop(l, 'setPopStt'), '吹き出しの中か ⓘ の pointerdown で閉じた');
  await down(l, $(l, 'micSelect'));
  assert.ok(isClosedPop(l, 'setPopStt'), 'ほかの行の pointerdown で閉じない');
  await click(l, b);
  await down(l, $(l, 'settingsModal'));
  assert.ok(isClosedPop(l, 'setPopStt'), '暗い所の pointerdown で閉じない');
  for (const [what, act] of [['項目を替える', () => pick(l, 'summary')], ['検索を打つ', () => search(l, '言語')], ['× で閉じる', () => click(l, 'setClose')]]) {
    if (!settingsOpen(l)) await click(l, 'tabBtnSettings');
    await search(l, '');
    await pick(l, 'record');
    await click(l, b);
    assert.ok(isOpenPop(l, 'setPopStt'));
    await act();
    assert.ok(isClosedPop(l, 'setPopStt'), `${what}と閉じない`);
  }
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('I5: 吹き出しの「ヘルプで詳しく見る ↗」は data-help の記事を openHelp に渡し（吹き出しは開いたまま）、HELP_SITE_LIVE が偽の写しではリンクを出さない（Esc で閉じる、は出す）', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  await pick(l, 'summary');
  await click(l, infoFor(l.root, 'claudeHelp'));
  const a = $(l, 'claudeHelp').querySelector('.setpop-help');
  assert.ok(visible(a), 'リンクが出ていない');
  await click(l, a);
  assert.deepStrictEqual(l.called('openHelp').map((c) => c.args), [['start/claude-code']], '記事の名前を渡していない');
  assert.ok(isOpenPop(l, 'claudeHelp') && settingsOpen(l), 'リンクで吹き出しか設定が閉じた');
  const off = await open({}, html.replace(LIVE_LINE, 'const HELP_SITE_LIVE = false;'));
  await off.drain();
  await click(off, 'tabBtnSettings');
  await pick(off, 'record');
  await click(off, infoFor(off.root, 'setPopLoop'));
  const p = $(off, 'setPopLoop');
  assert.strictEqual(p.querySelector('.setpop-help').hidden, true, 'サイトが出る前に「ヘルプで詳しく見る ↗」を出した');
  assert.ok(visible(p.querySelector('.setpop-esc')), '「Esc で閉じる」が出ていない');
  await click(off, p.querySelector('.setpop-help'));
  assert.deepStrictEqual(off.called('openHelp'), []);
  assert.deepStrictEqual([...l.errors, ...off.errors].map(fmt), []);
});

test('I7: 吹き出しの中にだけある言葉で検索すると、その行（カードの頭）が出て ⓘ に hit の印。名前で当たった行の ⓘ には印が無い。検索をやめると印が外れる', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  const hit = (id) => infoFor(l.root, id).classList.contains('hit');
  await search(l, 'イヤホン');
  assert.deepStrictEqual(shownRows(l), ['議事録で相手の声も録る']);
  assert.ok(hit('setPopLoop'), '吹き出しの中だけで当たったのに ⓘ に印が無い');
  assert.strictEqual($(l, 'setEmpty').hidden, true);
  await search(l, '週ごと');
  assert.deepStrictEqual(shownRows(l), ['Claude Code']);
  assert.ok(hit('claudeHelp'));
  // カードの見出しの ⓘ の吹き出し（文字起こし）: カードの見出しと頭の説明が出る
  await search(l, 'gpt-4o');
  assert.deepStrictEqual(shownCards(l), ['文字起こし']);
  const lead = $(l, 'setPopStt').closest('.card').querySelector('.setlead');
  assert.ok(lead && visible(lead), 'カードの頭の説明が出ない');
  assert.ok(visible(infoFor(l.root, 'setPopStt')) && hit('setPopStt'), '見出しの ⓘ が出ない・印が無い');
  assert.deepStrictEqual(shownRows(l), [], 'カードの吹き出しで当たったのに行まで出した');
  assert.strictEqual($(l, 'setEmpty').hidden, true, 'カードの頭で当たったのに「当てはまる設定はありません」');
  // 名前で当たった行（使用するマイク）と、吹き出しで当たった行（相手の声）
  await search(l, 'マイク');
  // 0.9.3 M-4 で意図して変えた: 「会議の検出の通知」の行も見える説明（「会議のアプリがマイクを使い始めたら…」）で当たる（吹き出しでないので印は無い）
  assert.deepStrictEqual(shownRows(l), ['会議の検出の通知', '使用するマイク', '議事録で相手の声も録る']);
  assert.ok(hit('setPopLoop'));
  assert.ok(!hit('setPopDetect'), '見える説明で当たった行の ⓘ に印を付けた');
  await search(l, 'スピーカー');
  assert.deepStrictEqual(shownRows(l), ['録音されるスピーカー']);
  assert.ok(!hit('setPopSpk'), '名前で当たった行の ⓘ に印を付けた');
  // 選ぶ欄の選択肢・ボタンの文では当たらない
  await search(l, '右下');
  assert.deepStrictEqual(shownRows(l), [], '選ぶ欄の選択肢で当たった');
  await search(l, '');
  assert.strictEqual(l.byId.get('tabSettings').querySelectorAll('.setinfo').filter((b) => b.classList.contains('hit')).length, 0, '検索をやめても印が残った');
  assert.ok(!lead.classList.contains('set-miss'));
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('I3: ログインの行は名前（と ⓘ）が左・［ログイン］が右の2列で、ログインしていなければ出る。カードの頭は1行。議事録ホットキーの「左右の Alt」は名前の下の1行に入れた', T, async () => {
  const row = doc.querySelector('#accountOut');
  assert.ok(row.classList.contains('field') && row.classList.contains('frow'), 'ログインの行が2列（.field.frow）でない');
  assert.strictEqual(row.dataset.row, 'ログイン');
  assert.ok(row.children[0].classList.contains('flead') && row.children[1].querySelector('#accountSignIn'), '左に名前、右に［ログイン］の形でない');
  assert.strictEqual(norm(row.querySelector('.fname').textContent), 'ログイン');
  assert.ok(infoFor(doc, 'setPopLogin').closest('#accountOut'), 'ログインの ⓘ が行に無い');
  const lead = doc.querySelector('#accountCard').querySelector('.setlead');
  assert.ok(lead, 'アカウントのカードの頭が無い');
  assert.strictEqual(norm(lead.textContent), 'ログインすると、つながっている間はクラウドで文字起こしします。');
  const mh = doc.querySelector('label[for="meetingHotkey"]').querySelector('.lhint');
  assert.strictEqual(norm(textOf(mh)), '開始／終了をトグル。左右の Alt は区別しません');
  const l = await open({ accountStatus: () => ({ ok: true, signedIn: false, email: '', method: 'access', until: null, canStore: true, online: { up: true, why: 'ok' } }) });
  await l.drain();
  await click(l, 'tabBtnSettings');
  await pick(l, 'account');
  assert.ok(visible($(l, 'accountSignIn')) && visible($(l, 'accountOut')), 'ログインしていないのに［ログイン］が出ない');
  await click(l, infoFor(l.root, 'setPopLogin'));
  assert.ok(isOpenPop(l, 'setPopLogin'));
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('I6: 開いた吹き出しが上にも下にも収まらないときだけ、ⓘ を右の列の上へ捲ってから置き直す（収まるときは捲らない）', T, async () => {
  for (const [what, roomy, want] of [['箱が無い大きさ（収まらない）', false, 1], ['広い箱（収まる）', true, 0]]) {
    const l = await open();
    await l.drain();
    await click(l, 'tabBtnSettings');
    await pick(l, 'record');
    if (roomy) l.document.querySelector('#settingsModal .setbox')._rect = { width: 1020, height: 700 };
    const b = infoFor(l.root, 'setPopLoop');
    b._rect = { width: 18, height: 18 };
    let n = 0;
    b.scrollIntoView = (o) => { n += 1; assert.deepStrictEqual(o, { block: 'start' }); };
    await click(l, b);
    assert.ok(isOpenPop(l, 'setPopLoop'));
    assert.strictEqual(n, want, `${what}: ⓘ を捲った回数`);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  }
});
