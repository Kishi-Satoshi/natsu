/*
 * stage110.memo.main.test.js — 0.11.0（計画 docs/plans/2026-10-22-110.md）の場面: main を偽の Electron の上で本当に動かす（helpers/mainrun.js）。
 * M-2: 要約の書式は種類から決まる型の見出しと締めで、Claude Code に渡す文（偽の claude の標準入力の見出し）に入る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const pCalls = (o) => o.claude.filter((l) => l.kind === 'p');

test('0.11.0 M-2（MT4・D42）: 商談の語の会議の要約は、Claude Code に商談の確認（BANTC）の見出し → 締めの4つ → 次に気をつけること の書式を渡す', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--sum', '--claude=ok', '--segs=2', '--text=商談 提案 見積 価格 契約 再販 の件です']);
  const calls = pCalls(o);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(o.pages[0].meetingType, 'sales');
  assert.deepStrictEqual(calls[0].stdinHeads, ['## 課題・要望（N）', '## 時期（T）', '## 決め方・決裁者（A）', '## 予算（B）', '## 競合・比較先（C）',
    '## 決定事項', '## 持ち越し', '## ToDo（誰が・何を・いつまでに）', '## 抜け・重なりチェック', '## 次に気をつけること']);
  assert.strictEqual(calls[0].stdinHasTranscript, true);
});

test('0.11.0 M-3（MT4・D39・F10）: 要約の保存で、根拠の無い見出しは本文に無く未確認の1行にまとまり、チェックは 3 件、印の行に出典が無く、engine.log には数だけ', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--sum', '--claude=ok', '--segs=2', '--text=商談 提案 見積 価格 契約 再販 の件です。来月から使いたい。決裁の流れを聞く', '--sum-md=bantc-mixed']);
  const p = o.pages[0];
  const heads = p.sumBlocks.filter((b) => b.type === 'heading').map((b) => b.text);
  assert.deepStrictEqual(heads, ['課題・要望（N）', '時期（T）', '競合・比較先（C）', '決定事項', 'ToDo（誰が・何を・いつまでに）', '抜け・重なりチェック', '次に気をつけること']);
  const marked = p.sumBlocks.filter((b) => b.mark);
  assert.deepStrictEqual(marked.map((b) => [b.mark, b.text]), [
    ['memo', '見込み: 来月から使いたい（メモより）'],
    ['check', '未確認: 決め方・決裁者（A）、予算（B）'], ['check', '次の会議で決裁の流れを聞く'], ['check', '予算の枠を聞く'], ['check', '導入の時期を確かめる'],
    ['advice', '冒頭で会議の目的を言うと、論点がそろう'], ['advice', '決めることを先に挙げる'],
  ]);
  for (const b of marked) { assert.strictEqual(b.cites, 0, b.text); assert.strictEqual(b.citeState, 'manual', b.text); }
  assert.strictEqual(p.sumBlocks.find((b) => b.mark === 'check').unconfirmed, true);
  const line = o.engineLog.find((l) => /抜け・重なりチェック/.test(l));
  assert.strictEqual(line, '要約: 抜け・重なりチェック 1 件を捨てた・未確認にまとめた見出し 2 個', JSON.stringify(o.engineLog.filter((l) => /要約/.test(l))));
  assert.ok(!o.engineLog.some((l) => /決裁|予算の枠|メモより/.test(l)), '記録に要約の文が出た');
});

// ---------------------------------------------------------------- M-4（MT3・F14・F27・P13。決めたこと 10〜12）
const M = require('../src/memoTypes');
const BANTC_HEADS = ['## 課題・要望（N）', '## 時期（T）', '## 決め方・決裁者（A）', '## 予算（B）', '## 競合・比較先（C）'];

test('0.11.0 M-4（D50・F27）: 録音中のページで商談を選んだ会議は、締めのページの種類が商談（手で選んだ）で、要約の書式が BANTC。メモが空なら BANTC の雛形が入り、経過に種類の項目が積まれる', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--sum', '--claude=ok', '--segs=2', '--set-type-live=sales']);
  assert.deepStrictEqual(o.setTypeLive.map((x) => [x.ok, x.inserted, x.meetingType]), [[true, true, 'sales']]);
  assert.strictEqual(o.liveStatusType, 'sales');
  const p = o.pages[0];
  assert.deepStrictEqual([p.meetingType, p.typeAuto], ['sales', false]);
  assert.strictEqual(p.memo, M.memoPreset('bantc'));
  assert.ok(p.stateLog.some((x) => x.s === 'type' && x.by === 'live-page'), JSON.stringify(p.stateLog));
  assert.ok(!p.stateLog.some((x) => x.s === 'type' && x.by === 'auto'), '手で選んだのに自動の判定の項目を積んだ');
  assert.deepStrictEqual(pCalls(o)[0].stdinHeads.slice(0, 5), BANTC_HEADS);
  assert.ok(o.engineLog.includes('議事録: 種類を選んだ（録音中のページ）'));
});

test('0.11.0 M-4・F14: 録音中のメモに人の文があれば、種類を選んでもメモは1文字も変わらない。商談を選んでから自動に戻すと、要約のときに判定する（選んでいない会議と同じ）', { timeout: sceneTimeout(30000) }, async () => {
  const a = await run(['text', '--sum', '--claude=ok', '--segs=2', '--live-memo=予算の相談をする', '--set-type-live=sales']);
  assert.deepStrictEqual(a.setTypeLive.map((x) => [x.inserted, x.memo]), [[false, '予算の相談をする']]);
  assert.strictEqual(a.pages[0].memo, '予算の相談をする');
  const b = await run(['text', '--sum', '--claude=ok', '--segs=2', '--set-type-live=sales,auto']);
  assert.strictEqual(b.liveStatusType, null);
  assert.deepStrictEqual([b.pages[0].meetingType, b.pages[0].typeAuto], [b.pages[0].autoType, true]);
  assert.notDeepStrictEqual(pCalls(b)[0].stdinHeads.slice(0, 5), BANTC_HEADS);
  assert.ok(b.pages[0].stateLog.some((x) => x.s === 'type' && x.by === 'auto'), '自動の判定の項目が無い');
  assert.strictEqual(b.pages[0].stateLog.filter((x) => x.s === 'type' && x.by === 'live-page').length, 1, '続けて選んだ項目が1件にまとまっていない');
});

test('0.11.0 M-4・F27: 録音中に商談を選んでから main ごと落ちても、下書きから戻したページの種類は商談（手で選んだ）', { timeout: sceneTimeout(60000) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-種類𠮷-'));
  try {
    const crashed = await new Promise((resolve) => {
      execScene(process.execPath, [RUN, 'text', '--segs=3', '--set-type-live=sales', '--kill-main-during', `--keep-user-data=${dir}`], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 30000 },
        (err) => resolve(err));
    });
    assert.ok(crashed && crashed.code !== 0, '場面の前提: main ごと落ちていない');
    const o = await run(['text', '--recover', `--keep-user-data=${dir}`]);
    const p = o.pages[0];
    assert.deepStrictEqual([p.meetingType, p.typeAuto, p.recovered], ['sales', false, true]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- M-5（P14 (a)。決めたこと 13）
test('0.11.0 M-5: 同じ曜日・時刻に2回 1on1 を手で選んだ後、種類を選ばず手がかりの語も無い会議は、要約のときに 1on1 の型（GROW）で作り、印 autoSlot を付ける。題名か文字起こしで決まる会議には使わない', { timeout: sceneTimeout(120000) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-枠𠮷-'));
  try {
    // 前の版の保存の形（data/pages/*.json）で、1週前と2週前の同じ時刻に手で 1on1 を選んだ会議を置く（起動のたびの取り込みで DB に入る）
    const { titleAt } = require('./helpers/titles');
    fs.mkdirSync(path.join(dir, 'data', 'pages'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data', 'transcripts'), { recursive: true });
    for (const w of [1, 2]) {
      const at = new Date(Date.now() - w * 7 * 86400000).toISOString();
      const id = `pslot${w}`;
      fs.writeFileSync(path.join(dir, 'data', 'pages', `${id}.json`), JSON.stringify({ id, title: titleAt(at), date: at.slice(0, 10), durationSec: 60, memo: '', blocks: [],
        createdAt: at, updatedAt: at, recovered: false, summaryError: '', meetingType: 'oneonone', typeAuto: false }));
      fs.writeFileSync(path.join(dir, 'data', 'transcripts', `${id}.json`), JSON.stringify({ id, segments: [] }));
    }
    const o = await run(['text', '--sum', '--claude=ok', '--segs=2', `--keep-user-data=${dir}`]);
    const p = o.pages.find((x) => x.typeAuto !== false);
    assert.ok(p, JSON.stringify(o.pages.map((x) => [x.meetingType, x.typeAuto])));
    assert.deepStrictEqual([p.meetingType, p.autoType, p.autoSlot], ['oneonone', 'oneonone', true]);
    assert.deepStrictEqual(pCalls(o)[0].stdinHeads.slice(0, 3), ['## テーマ・目標（G）', '## 現状と困りごと（R）', '## 選択肢・上司の助言（O）']);
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-枠𠮷-'));
    try {
      fs.cpSync(path.join(dir, 'data', 'pages'), path.join(dir2, 'data', 'pages'), { recursive: true });
      fs.cpSync(path.join(dir, 'data', 'transcripts'), path.join(dir2, 'data', 'transcripts'), { recursive: true });
      for (const f of fs.readdirSync(path.join(dir2, 'data', 'pages'))) if (!/^pslot/.test(f)) fs.rmSync(path.join(dir2, 'data', 'pages', f));
      const s = await run(['text', '--sum', '--claude=ok', '--segs=2', '--text=商談 提案 見積 価格 契約 再販 の件です', `--keep-user-data=${dir2}`]);
      const q = s.pages.find((x) => x.typeAuto !== false);
      assert.deepStrictEqual([q.meetingType, Boolean(q.autoSlot)], ['sales', false], '文字起こしで決まったのに前の会議の種類で上書きした');
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- Q-3（QM2〜QM6・QM8・F11〜F13。決めたこと 32〜34・39）
const Q = require('../src/quality');
const LONG = '見積の作成は済みました。結合テストは今週で完了します。遅れの原因は仕様の変更です。来週に人を足す案があります。冒頭で決めることを言いました。予算の話を2回やり直しました。人を足すと確かめました。人の手配は山田さんが来週金曜までにします。'.repeat(2);
const scoreRun = (extra) => run(['text', '--sum', '--claude=ok', '--segs=2', `--text=${LONG}`, ...extra]);
const QN1 = 'この要約には打ち合わせの質の点を付けていません（AI の答えの形を読み取れなかったため）。要約はそのまま使えます。［要約を再生成］でもう一度付けられます。';
const QN2 = '文字起こしが短いため、打ち合わせの質の点は付けていません。';
const noScoreLines = (p) => !p.sumBlocks.some((b) => /打ち合わせの質|目的と結論: |抜け・重なり: |決定事項: \d/.test(b.text));

test('0.11.0 Q-3（QM3・F11）: 朝会の会議の要約に点が付く。total は軸の和、軸 1〜3 は答えのまま、軸 4・5 は数えた値、理由に出典、ブロックに採点の行が無い。画面の読む page.get と要約の直後の page:updated に qualityView、DB の行には書かない', { timeout: sceneTimeout(30000) }, async () => {
  const o = await scoreRun(['--set-type-live=standup', '--sum-md=report-score']);
  const p = o.pages[0];
  const q = p.quality;
  assert.ok(q, JSON.stringify(p.summaryError));
  assert.deepStrictEqual(q.axes.map((a) => a.key), ['purpose', 'mece', 'decisions', 'todos', 'fill']);
  assert.deepStrictEqual(q.axes.slice(0, 3).map((a) => [a.score, a.reason]), [[4, '冒頭で決めることを言いました'], [3, '予算の話を2回やり直しました'], [5, '人を足すと確かめました']]);
  assert.strictEqual(q.axes[3].score, 5, 'ToDo 1 件に担当と期限がある');
  assert.strictEqual(q.total, q.axes.reduce((s, a) => s + a.score, 0));
  assert.ok(q.axes[0].cites.length > 0, '理由に出典が無い');
  assert.deepStrictEqual([q.axes[3].cites, q.axes[4].cites], [[], []]);
  assert.ok(noScoreLines(p), JSON.stringify(p.sumBlocks.map((b) => b.text)));
  assert.ok(p.sumBlocks.some((b) => b.type === 'heading' && b.text === '次に気をつけること'));
  assert.deepStrictEqual(pCalls(o)[0].stdinHeads.slice(-1), ['## 打ち合わせの質（採点）']);
  assert.deepStrictEqual(p.viewQuality, Q.qualityView(q));
  assert.deepStrictEqual(o.updatedQualityView, Q.qualityView(q), '要約の直後の page:updated に qualityView が無い');
  assert.strictEqual(p.rawHasQualityView, false, 'DB の行に qualityView を書いた');
  assert.ok(o.engineLog.includes(`打ち合わせの質: 付けた ${q.total}/25`), o.engineLog.filter((l) => /打ち合わせ/.test(l)).join('\n'));
  assert.ok(!o.engineLog.some((l) => /冒頭で決めること|予算の話/.test(l)), '記録に理由の文が出た');
});

test('0.11.0 Q-3（F11・F13・RF72）: AI が合計 25 と書いても total は軸の和。崩れた点・途中で切れた・採点の節が2つの答えは、要約を保存して点を付けず、注 QN1', { timeout: sceneTimeout(60000) }, async () => {
  const s = await scoreRun(['--set-type-live=standup', '--sum-md=report-score-sum25']);
  assert.strictEqual(s.pages[0].quality.total, s.pages[0].quality.axes.reduce((x, a) => x + a.score, 0));
  assert.notStrictEqual(s.pages[0].quality.total, 25);
  for (const md of ['report-score-broken', 'report-score-cut', 'report-score-twice']) {
    const o = await scoreRun(['--set-type-live=standup', `--sum-md=${md}`]);
    const p = o.pages[0];
    assert.strictEqual(p.quality, undefined, md);
    assert.ok(p.sumBlocks.length > 5, `${md}: 要約が保存されていない`);
    assert.ok(String(p.summaryError).includes(QN1), `${md}: ${p.summaryError}`);
    assert.ok(noScoreLines(p), `${md}: 採点の行が本文に残った`);
  }
});

test('0.11.0 Q-3（P11・F12・RF71）: 1on1 にも既定（all）で点が付く。「1on1 と採用面接・事前面談を除いて付ける」（on）なら付けず、頼まなかった採点の節は捨て、書式に採点の節を入れず、次に気をつけることは出す。off なら朝会にも付けない', { timeout: sceneTimeout(60000) }, async () => {
  const a = await scoreRun(['--set-type-live=oneonone', '--sum-md=grow-score']);
  assert.ok(a.pages[0].quality, '既定（all）の 1on1 に点が無い');
  const b = await scoreRun(['--set-type-live=oneonone', '--sum-md=grow-score', '--quality=on']);
  const p = b.pages[0];
  assert.strictEqual(p.quality, undefined);
  assert.ok(noScoreLines(p), JSON.stringify(p.sumBlocks.map((x) => x.text)));
  assert.ok(!pCalls(b)[0].stdinHeads.includes('## 打ち合わせの質（採点）'), '頼まないのに採点の節を書式に入れた');
  assert.ok(p.sumBlocks.some((x) => x.type === 'heading' && x.text === '次に気をつけること'), '点を付けない会議に助言が無い');
  assert.ok(!String(p.summaryError || '').includes('打ち合わせの質'), '除いた種類で注を書いた');
  const c = await scoreRun(['--set-type-live=standup', '--sum-md=report-score', '--quality=off']);
  assert.strictEqual(c.pages[0].quality, undefined);
});

test('0.11.0 Q-3（QM5）: 文字起こしが 400 文字未満の会議は点を付けず、注 QN2', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--sum', '--claude=ok', '--segs=1', '--set-type-live=standup', '--sum-md=report-score']);
  assert.strictEqual(o.pages[0].quality, undefined);
  assert.ok(String(o.pages[0].summaryError).includes(QN2), o.pages[0].summaryError);
  assert.ok(!pCalls(o)[0].stdinHeads.includes('## 打ち合わせの質（採点）'));
});

test('0.11.0 Q-3（QM8・D59・D62）: オフラインモードの会議も、要約待ちだった会議も、Claude Code の要約と一緒に点が付く', { timeout: sceneTimeout(60000) }, async () => {
  const a = await scoreRun(['--relay=text', '--local-only', '--set-type-live=standup', '--sum-md=report-score']);
  assert.ok(a.pages[0].quality, 'オフラインモードの会議に点が無い');
  const b = await scoreRun(['--set-type-live=standup', '--sum-md=report-score', '--summary-offline', '--summary-online-after=100']);
  assert.strictEqual(b.pages[0].quality, undefined, '要約待ちの間に点が付いた');
  assert.ok(b.summaryBack[0].pages[0].quality, 'つながった後の要約に点が無い');
});

test('0.11.0 Q-3（決めたこと 33）: 点を付けた後に「付けない」にして［要約を再生成］すると、前の点が消える', { timeout: sceneTimeout(30000) }, async () => {
  const o = await scoreRun(['--set-type-live=standup', '--sum-md=report-score', '--resum-quality=off']);
  assert.ok(o.qualityBefore, '前提: 初めの要約に点がある');
  assert.strictEqual(o.pages[0].quality, undefined, '前の点が残った');
});
