/*
 * stage093.rename.test.js — 0.9.3 Task M-0（計画 docs/plans/2026-10-22-093.md の持ち主の答え D54・決めたこと 23〜26）
 * 「PC の中だけ」の会議を「オフラインモード」、設定の項目「オフライン」を「ローカル AI」と呼ぶ。利用者に見える文だけを変え、
 * 内部のキー（localOnly・meeting:set-local-only・項目のキー offline・記事の名前 record/pc-only・settings/offline）は変えない。
 * 「PC の中だけ」の言葉は、オフラインモードの意味を説明する所（「…PC の中だけで処理し、外へ送らない」）にだけ残してよい。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('./helpers/simdom');
const S = require('./helpers/simcss');
const { parseFrontMatter } = require('../tools/lib/help-md');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const T = { timeout: 5000 };
// 注（/* */・// の行の終わり・<!-- -->）と、engine.log へ書く行（利用者に見せる文でなく、前の版の記録と比べられるように変えない）を除く
const stripJs = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1').split('\n').filter((l) => !/engineLog\(/.test(l)).join('\n');
const stripHtml = (src) => stripJs(src.replace(/<!--[\s\S]*?-->/g, ' '));
const helpFiles = () => {
  const out = [];
  const dir = path.join(ROOT, 'help', 'articles');
  for (const c of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, c))) out.push(`help/articles/${c}/${f}`);
  return out;
};
// 利用者が読む文の集まり（ファイル → 中身）
const shown = () => {
  const m = new Map();
  m.set('src/renderer/app.html', stripHtml(read('src/renderer/app.html')));
  for (const f of ['src/main.js', 'src/mainlib.js']) m.set(f, stripJs(read(f)));
  for (const f of [...helpFiles(), 'help/site.json', 'README.md', 'INSTALL.md']) m.set(f, read(f));
  return m;
};
// 古い名前（D54）。「PC の中だけ」そのものは説明の文に残してよいので、名前として使っている形だけを並べる。前の名前を知らせる行（「0.9.2 までは…と呼んで」）は除く
const OLD = ['［この会議は PC の中だけ］', 'この会議は PC の中だけ', 'PC の中だけにし', 'PC の中だけの会議', 'PC の中だけのため', 'PC の中だけで始める',
  'PC の中だけのページ', '設定の「オフライン」', '［設定］→［オフライン］', '［オフライン］', '「オフライン」', 'オフラインの準備', 'オフラインでも使う', '[オフライン](', 'title: オフライン'];

test('D54: 利用者に見える文（app.html・main.js と mainlib.js の文字・ヘルプの記事・site.json・README・INSTALL）に古い名前（［この会議は PC の中だけ］・設定の「オフライン」・［オフラインの準備］・［オフラインでも使う…］）が無い', T, () => {
  const bad = [];
  for (const [f, text] of shown()) {
    text.split('\n').forEach((line, i) => { if (/0\.9\.2 までは.*と呼んで/.test(line)) return; for (const w of OLD) if (line.includes(w)) bad.push(`${f}:${i + 1} 「${w}」: ${line.trim().slice(0, 120)}`); });
  }
  assert.deepStrictEqual(bad, []);
});

test('D54: 録音中のページのボタン #meetingLocalOnly は［オフラインモード］、設定の左の列 #setNavOffline と項目の名前は「ローカル AI」、帯と知らせの行動 offline は［ローカル AI の準備］、取り込みのボタンは［ローカル AI を使う（数 GB を取り込む）］', T, () => {
  const html = read('src/renderer/app.html');
  assert.ok(html.includes('<button class="ghost" id="meetingLocalOnly" type="button" hidden>オフラインモード</button>'), 'ボタンの文が［オフラインモード］でない');
  const doc = parseHTML(html).root;
  const nav = doc.querySelector('#setNavOffline');
  assert.strictEqual(nav.textContent.trim(), 'ローカル AI');
  assert.strictEqual(nav.getAttribute('data-sec'), 'offline');
  assert.ok(html.includes("{ sec: 'offline', name: 'ローカル AI' }"), '項目の名前（SETTINGS_SECS）が「ローカル AI」でない');
  assert.ok(/<h2 hidden>ローカル AI<\/h2>/.test(html), '隠した見出しが「ローカル AI」でない');
  assert.ok(html.includes("offline: 'ローカル AI の準備' }"), '帯の行動 offline の名前（STT_ACT_LABEL）が［ローカル AI の準備］でない');
  assert.ok(html.includes("offline: { label: 'ローカル AI の準備', run: () => showEngineSettings() }"), '知らせの行動 offline の名前が［ローカル AI の準備］でない');
  assert.ok(html.includes("btn = 'ローカル AI を使う（数 GB を取り込む）';"), '取り込みのボタンが［ローカル AI を使う（数 GB を取り込む）］でない');
  assert.ok(html.includes("box.dataset.row = offer ? 'ローカル AI を使う' :"), '検索の行の名前が「ローカル AI を使う」でない');
  assert.ok(html.includes("toast('オフラインモードにできませんでした（会議が終わっているか、記録していません）')"), 'できなかったときのトーストが古い');
  assert.ok(html.includes("'オフラインモードです。この会議の音声は外へ送らず、PC の中で文字起こししています'"), '押した後の行が古い');
  assert.ok(html.includes("'オフラインモードです。音声だけを残しています（外には送りません）。ローカル AI の準備が済むと文字起こしします。'"), '準備の無い PC の行が古い');
  const main = read('src/main.js');
  assert.ok(main.includes("1on1・面談など外に出したくない会議は、議事録の画面の［オフラインモード］を押してください。'"), '会議の始めの知らせ（M1）が古い');
  assert.ok(main.includes("'kept-local': () => 'この会議はオフラインモードです。"), '帯 kept-local が古い');
  assert.ok(main.includes('const LOCAL_SETUP_NOTICE = \'この会議をオフラインモードにしました。PC の中で文字起こしするには、設定の「ローカル AI」の準備'), 'LOCAL_SETUP_NOTICE が古い');
});

test('D54: 内部のキーと名前は変えない（localOnly・meeting:set-local-only・項目のキー offline・id・記事の名前・engine.log の行）', T, () => {
  const html = read('src/renderer/app.html');
  for (const s of ['id="setNavOffline"', 'data-sec="offline"', 'id="meetingLocalOnly"', 'id="meetingLocalOnlyNote"', 'st.localOnly', 'meetingSetLocalOnly(true)']) assert.ok(html.includes(s), s);
  const main = read('src/main.js');
  for (const s of ["ipcMain.handle('meeting:set-local-only'", 'localOnly: Boolean(meeting.localOnly)', 'engineLog(`文字起こしの経路: この会議は PC の中だけ: ${meeting.localOnly ? \'on\' : \'off\'}`);']) assert.ok(main.includes(s), s);
  assert.ok(read('src/preload.js').includes("meetingSetLocalOnly: (on) => ipcRenderer.invoke('meeting:set-local-only', on)"), 'preload の口の名前が変わった');
  for (const f of ['help/articles/record/pc-only.md', 'help/articles/settings/offline.md']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  const site = read('help/site.json');
  assert.ok(site.includes('"pc-only"') && site.includes('"offline"'), '記事の名前が変わった');
});

test('D54: 記事 settings/offline の題名は「ローカル AI」、record/pc-only の題名は「外に出したくない会議（［オフラインモード］）」。どちらも2つは違うと書き、互いにリンクする', T, () => {
  const off = read('help/articles/settings/offline.md');
  const pc = read('help/articles/record/pc-only.md');
  assert.strictEqual(parseFrontMatter(off, { file: 'offline.md' }).meta.title, 'ローカル AI');
  assert.strictEqual(parseFrontMatter(pc, { file: 'pc-only.md' }).meta.title, '外に出したくない会議（［オフラインモード］）');
  for (const [name, text, link] of [['settings/offline', off, '(record/pc-only.md)'], ['record/pc-only', pc, '(settings/offline.md)']]) {
    const body = text.slice(text.indexOf('\n---', 3) + 4);
    assert.ok(body.includes('**ローカル AI**は、PC の上で動く文字起こしと要約の準備'), `${name}: ローカル AIの説明が無い`);
    assert.ok(body.includes('**オフラインモード**は、1つの会議を外へ送らない印'), `${name}: オフラインモードの説明が無い`);
    assert.ok(body.includes('違うものです'), `${name}: 違うと書いていない`);
    assert.ok(body.includes(link), `${name}: もう1つの記事へのリンクが無い`);
  }
});

test('決めたこと 26: 設定の左の列は 196px（「ローカル AI」が折り返さない名前の行に収まる）', T, () => {
  const doc = parseHTML(read('src/renderer/app.html')).root;
  const rules = S.parse(doc.querySelectorAll('style').map((s) => s._raw).join('\n'));
  assert.strictEqual(S.declsFor(rules, '.setnav').width, '196px');
  assert.strictEqual(S.declsFor(rules, '.setnav-item')['white-space'], 'nowrap');
});
