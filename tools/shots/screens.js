/*
 * shots/screens.js — 画面を撮って比べる道具（第1a回 G2・PERF）の決め方。純粋（Electron を読まない。test/shots.test.js が試す）
 *
 * 撮るのは tools/shots/main.js（Electron の main）。ここには、撮る画面の並び・偽の橋の名前と見本の答え・
 * 同じ画面を2回撮ったときの揺れの判定・基準との比べ・CSP の違反の行の見分け・開く速さの判定・終了コードを置く。
 *
 * 画面は今日の日付で文字を変える（relTime の「N時間前」・dueInfo の「N日超過」・音声入力の「今日の入力」）。
 * 撮るときは時計を FIXED_NOW に止め、時間帯を TIME_ZONE にし、アニメーションを FREEZE_CSS で止める。
 * 見本の日付は、どれも止めた時計より前の決まった日にする（基準を取った次の日に CI が赤にならない）。
 */
'use strict';

const path = require('path');
const mtype = require('../../src/meetingType');

const SIZE = { width: 1120, height: 780 };         // 本体の窓の既定（main.js の createMainWindow）
const OVERLAY_SIZE = { width: 316, height: 72 };   // 録音バー（main.js の createOverlay）

// 録音バーは onStart（録音を始める。マイクを開く）を受けるまでピルを見せない（.pill に visible が付かない）。
// 録音は始めずに見た目だけを撮るので、onPhase の後にピルを見せる（overlay.html は変えない）
const SHOW_PILL = "document.querySelector('.pill').classList.add('visible')";
const SCREENS = [
  { name: 'notes-empty-light', page: 'app', theme: 'light', act: "document.getElementById('tabBtnNotes').click()" },
  { name: 'notes-page-light', page: 'app', theme: 'light', act: "document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click()" },
  { name: 'notes-page-dark', page: 'app', theme: 'dark', act: "document.getElementById('tabBtnNotes').click(); document.querySelector('#plist .pitem').click()" },
  { name: 'dictation-light', page: 'app', theme: 'light', act: "document.getElementById('tabBtnDictation').click()" },
  { name: 'settings-light', page: 'app', theme: 'light', act: "document.getElementById('tabBtnSettings').click()" },
  { name: 'settings-dark', page: 'app', theme: 'dark', act: "document.getElementById('tabBtnSettings').click()" },
  { name: 'overlay-processing', page: 'overlay', theme: 'light', event: ['onPhase', { phase: 'processing', message: '文字起こし中…' }], act: SHOW_PILL },
];
const PERF = [{ name: 'open-2000-blocks', budgetMs: 500 }];   // 3回開いた中央値で見る
const FIXED_NOW = Date.UTC(2026, 9, 18, 0, 0, 0);   // 撮るときの時計（2026-10-18 09:00 日本時間）。見本の日付はこれより前の決まった日
const TIME_ZONE = 'Asia/Tokyo';
const TOLERANCE = 2;   // 色の差（0〜255）がこれ以下の画素は同じとみなす。CI の機械の CPU ごとの描き方の1段の差を拾わないため（揺れの確かめ judgePair は 0 で見る）
const FREEZE_CSS = '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}';

/**
 * preload.js の exposeInMainWorld から、橋の名前ごとの関数の名前を取る（test/helpers/simrun.js の preloadApis と同じ読み方。
 * テストが同じ結果になることを見る）。偽の橋（tools/shots/preload.js）はこの名前で作るので、本物の preload に足した関数も撮る画面に届く。
 * @returns {{ [bridge: string]: string[] }}
 */
function apiNamesOf(preloadSrc) {
  const src = String(preloadSrc || '');
  const out = {};
  const re = /exposeInMainWorld\(\s*'([^']+)'\s*,\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    let depth = 1;
    while (i < src.length && depth > 0) { const c = src[i]; if (c === '{') depth++; else if (c === '}') depth--; i++; }
    const body = src.slice(re.lastIndex, i - 1);
    const names = [];
    let d = 0;
    for (const line of body.split('\n')) {
      const t = line.trim();
      const k = d === 0 && /^([A-Za-z_$][\w$]*)\s*:/.exec(t);
      if (k) names.push(k[1]);
      for (const c of line) { if ('{(['.includes(c)) d++; else if ('})]'.includes(c)) d--; }
      d = Math.max(0, d);
    }
    out[m[1]] = names;
  }
  return out;
}

// ---------------------------------------------------------------- 見本の答え（偽の橋が返す）
// 人の名前は、テストの見本（test/fixtures.js）と同じ代表的な置き名だけを使う。パスは置き場所の形だけ（利用者名を出さない）
const ENGINE_DIR = 'C:\\NaTsu\\engine';
const SEGMENTS = [
  { id: 's1', atMs: 0, text: 'それでは週次の定例を始めます。まず進み具合から順にお願いします。' },
  { id: 's2', atMs: 75000, text: '受注の画面の直しは、結合の試験が今週で終わりました。残りの不具合は2件です。' },
  { id: 's3', atMs: 150000, text: '在庫の取り込みが遅いので、山田さんに実行計画を見てもらえますか。期限は10月14日でお願いします。' },
  { id: 's4', atMs: 225000, text: '分かりました。索引が効いているかを確かめます。' },
  { id: 's5', atMs: 300000, text: '求人票の見直しは、佐藤さんが今月末までに案を出します。' },
  { id: 's6', atMs: 375000, text: '出す日は11月15日で決まりです。以上で終わります。' },
];
const PAGE = {
  id: 'p1', title: '週次定例（見本）', date: '2026-10-16', durationSec: 1820,
  memo: '議題: 進み具合 / 在庫の取り込み / 採用',
  meetingType: 'standup', typeAuto: true, autoType: 'standup',
  createdAt: '2026-10-16T01:00:00.000Z', updatedAt: '2026-10-16T01:40:00.000Z',
  recovered: false, summaryError: '',
  blocks: [
    { id: 'b1', type: 'heading', text: '概要' },
    { id: 'b2', type: 'bullet', text: '結合の試験が終わり、残りの不具合は2件になった。', cites: ['s2'] },
    { id: 'b3', type: 'heading', text: '決まったこと' },
    { id: 'b4', type: 'bullet', text: '出す日を11月15日に決めた。', cites: ['s6'] },
    { id: 'b5', type: 'heading', text: 'アクションアイテム' },
    { id: 'b6', type: 'todo', text: '在庫の取り込みの実行計画を確かめる', checked: false, assignee: '山田', due: '2026-10-14', dueRaw: '10月14日', cites: ['s3', 's4'] },
    { id: 'b7', type: 'todo', text: '求人票の見直しの案を出す', checked: false, assignee: '佐藤', due: '', dueRaw: '今月末', cites: ['s5'] },
    { id: 'b8', type: 'todo', text: '残りの不具合2件を直す', checked: true, cites: [] },
    { id: 'b9', type: 'bullet', text: '次回は会議室を替える。', citeState: 'manual', cites: [] },
  ],
  citeStat: { linked: 5, total: 6 },
  actionStat: { total: 3, withAssignee: 2, withDue: 1 },
};
const LIST = [
  { id: 'p1', title: PAGE.title, date: '2026-10-16', durationSec: 1820, createdAt: PAGE.createdAt, updatedAt: PAGE.updatedAt, meetingType: 'standup', hasSummary: true },
  { id: 'p2', title: '設計の打ち合わせ（見本）', date: '2026-10-09', durationSec: 2710, createdAt: '2026-10-09T05:00:00.000Z', updatedAt: '2026-10-09T05:50:00.000Z', meetingType: 'general', hasSummary: true },
  { id: 'p3', title: '1on1（見本）', date: '2026-10-01', durationSec: 905, createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:20:00.000Z', meetingType: 'general', hasSummary: false },
];
const HISTORY = [
  // 止めた時計（10/18 09:00 日本時間）の 30 分前。「今日の入力」と「30分前」が出る
  { id: 'h1', text: '明日の打ち合わせは10時からに変更になりました。資料は前日までに共有します。', createdAt: '2026-10-17T23:30:00.000Z', durationSec: 9, chars: 38, procMs: 1400 },
  { id: 'h2', text: '見積もりの件、承知しました。来週の水曜までにお送りします。', createdAt: '2026-10-16T06:12:00.000Z', durationSec: 7, chars: 29, procMs: 1100 },
  { id: 'h3', text: '会議室の予約をお願いします。', createdAt: '2026-10-01T02:05:00.000Z', durationSec: 3, chars: 13, procMs: 800 },
];

/**
 * 偽の橋の答え: { '<橋>.<関数>': 値 }。値は main の受け口が返す形（main.js の ipcMain.handle）。
 * ここに無い関数は main が { ok: true } を返す（test/helpers/simrun.js と同じ）。日付は 2026-10-01 などの決まった過去の日。
 */
function fixtures() {
  return JSON.parse(JSON.stringify({
    'koeApp.getSettings': {
      localServerExe: `${ENGINE_DIR}\\whisper\\whisper-server.exe`, localModelPath: `${ENGINE_DIR}\\models\\ggml-model.bin`,
      localThreads: 4, localPort: 8990, vadModelPath: '', useVad: true, suppressNst: true,
      sumServerExe: `${ENGINE_DIR}\\llama\\llama-server.exe`, sumModelPath: `${ENGINE_DIR}\\models\\summary.gguf`,
      sumThreads: 4, sumPort: 8991, sumCtx: 16384, sumGpuLayers: 0, engineIdleMin: 10, autoSummarize: true,
      hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M', segmentSec: 75, pillPos: 'bottom', micId: '',
      language: 'ja', autoPaste: true, removeFillers: true, soundFeedback: true, autoLaunch: false,
      dictionary: ['議事録', '結合試験'], useBuiltinTerms: true, stayInTray: false, theme: 'system', useSystemAudio: false,
    },
    'koeApp.vadStatus': { path: `${ENGINE_DIR}\\models\\ggml-silero-vad.bin`, auto: true },
    'koeApp.engineStatus': { ok: true, whisper: '', sum: '' },
    'koeApp.engineFetchStatus': null,   // 取り込みの欄は出さない（取り込みの状態で画面が変わらないように）
    'koeApp.hotkeyState': { ok: true, failed: [], fallback: {}, message: '' },
    'koeApp.promptInfo': { ok: true, kept: 2, total: 2, over: false },
    'koeApp.meetingTypes': mtype.listTypes(),
    'koeApp.appVersion': { version: '0.4.0', repo: '' },   // 版を上げても画面が変わらないように決まった値
    'koeApp.getHistory': HISTORY,
    'koeApp.meetingStatus': { active: false, paused: false, startedAt: null, segments: [] },
    'koeApp.pagesSearch': LIST,
    'koeApp.pagesSearchFull': { hits: [], total: 0, truncated: false },
    'koeApp.pageGet': { page: PAGE, segments: SEGMENTS },
  }));
}

/**
 * page:get の答えの形（main.js の ipcMain.handle('page:get')）の { page, segments }。2,000 ブロック（見出し・箇条書き・ToDo を順に）と
 * 1万行の発言。PERF の計りのときだけ pageGet の答えにする。
 */
function bigPage() {
  const segments = [];
  for (let i = 0; i < 10000; i++) {
    segments.push({ id: `s${i + 1}`, atMs: i * 7000, text: `${i + 1} 行目の発言です。進み具合と次の手を確かめ、決まったことを順に読み上げます。` });
  }
  const blocks = [];
  for (let i = 0; i < 2000; i++) {
    const n = i + 1;
    const kind = i % 3;
    if (kind === 0) blocks.push({ id: `b${n}`, type: 'heading', text: `見出し ${n}` });
    else if (kind === 1) blocks.push({ id: `b${n}`, type: 'bullet', text: `${n} 番目の要点。文字起こしの発言に出典を付けています。`, cites: [`s${(i * 5) % 10000 + 1}`] });
    else blocks.push({ id: `b${n}`, type: 'todo', text: `${n} 番目のやること`, checked: i % 2 === 0, assignee: i % 4 === 0 ? '山田' : '', due: i % 4 === 0 ? '2026-10-14' : '', dueRaw: '', cites: [] });
  }
  const page = {
    id: 'big', title: '2,000 ブロックの見本', date: '2026-10-01', durationSec: 70000, memo: '',
    meetingType: 'general', typeAuto: true, autoType: 'general',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', recovered: false, summaryError: '',
    blocks,
  };
  return { page, segments };
}

/** PERF の計りで一覧に出す1行（押すと bigPage を開く） */
function bigListEntry() {
  const { page } = bigPage();
  return { id: page.id, title: page.title, date: page.date, durationSec: page.durationSec, createdAt: page.createdAt, updatedAt: page.updatedAt, meetingType: 'general', hasSummary: true };
}

// ---------------------------------------------------------------- 判定（純粋）

/** 同じ画面を2回撮った RGBA → { ok, note }。1画素でも違えば揺れ（'flaky'）。差を許さない */
function judgePair(a, b, png) {
  const d = png.diffImages(a, b, { tolerance: 0 });
  if (d.same) return { ok: true, note: `2回とも同じ（${a.width}x${a.height}）` };
  return { ok: false, note: d.sizeMismatch ? 'flaky: 2回の大きさが違う' : `flaky: ${d.count} 画素が違う` };
}

/**
 * 撮った画面を基準と比べる。shots: { name: { width, height, data } } → [{ name, status, count? }]（shots の並び）。
 * 'diff'・'size' なら outDir に <name>.before.png（基準）・<name>.after.png（今）・<name>.diff.png、'missing' なら <name>.after.png。
 * 基準を読めない（壊れた PNG）ときも 'missing' にして今の画像を書く（黙って同じにしない）。
 */
function compareAll({ baseDir, outDir, shots, png, fs, tolerance = TOLERANCE }) {
  const out = [];
  const write = (file, buf) => { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, file), buf); };
  for (const [name, shot] of Object.entries(shots || {})) {
    const file = path.join(baseDir, `${name}.png`);
    let baseBuf = null;
    let base = null;
    let note = '';
    try {
      baseBuf = fs.readFileSync(file);
      base = png.decodePng(baseBuf);
    } catch (e) {
      note = e && e.code === 'ENOENT' ? '基準が無い' : `基準を読めない（${(e && (e.code || e.message)) || e}）`;
    }
    if (!base) {
      write(`${name}.after.png`, png.encodePng(shot));
      out.push({ name, status: 'missing', note });
      continue;
    }
    const d = png.diffImages(base, shot, { tolerance });
    if (d.same) { out.push({ name, status: 'same' }); continue; }
    write(`${name}.before.png`, baseBuf);
    write(`${name}.after.png`, png.encodePng(shot));
    write(`${name}.diff.png`, png.encodePng(d.image));
    out.push({ name, status: d.sizeMismatch ? 'size' : 'diff', count: d.count, box: d.box });
  }
  return out;
}

/**
 * console-message の行が CSP の違反か（Chromium の「Refused to … because it violates the following Content Security Policy directive」）。
 * Electron 自身の警告（Insecure Content-Security-Policy）は違反ではない。level は版で数か文字かが違うので見ない
 */
function cspViolation(level, message) {
  const m = String(message || '');
  return /Content Security Policy/.test(m) && /Refused to|violates/.test(m);
}

/** 並べて真ん中の値（偶数個なら真ん中の2つの平均）。空なら NaN */
function median(list) {
  const s = (Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** [{ name, ms }]（ms は median 済み）→ [{ name, ms, budgetMs, ok }]。目安の無い名前・数でない ms は NG */
function judgePerf(results) {
  return (Array.isArray(results) ? results : []).map((r) => {
    const p = PERF.find((x) => x.name === (r && r.name));
    const ms = Number(r && r.ms);
    return { name: r && r.name, ms, budgetMs: p ? p.budgetMs : null, ok: Boolean(p) && Number.isFinite(ms) && ms <= p.budgetMs };
  });
}

/**
 * 終了コード。比べるとき（compare がある）は全部 'same'、撮るだけのときは shots が1枚以上で、
 * 揺れ・CSP の違反・速さの NG・撮れなかった画面（errors）が無いときだけ 0
 */
function exitCodeOf({ shots, compare, flaky = [], csp = [], perf = [], errors = [] } = {}) {
  const bad = flaky.length > 0 || csp.length > 0 || errors.length > 0 || perf.some((p) => !p || p.ok !== true);
  if (bad) return 1;
  if (compare !== undefined) return Array.isArray(compare) && compare.length > 0 && compare.every((c) => c && c.status === 'same') ? 0 : 1;
  const n = Array.isArray(shots) ? shots.length : shots && typeof shots === 'object' ? Object.keys(shots).length : 0;
  return n > 0 ? 0 : 1;
}

module.exports = {
  SIZE, OVERLAY_SIZE, SCREENS, PERF, FIXED_NOW, TIME_ZONE, TOLERANCE, FREEZE_CSS,
  apiNamesOf, fixtures, bigPage, bigListEntry, judgePair, compareAll, cspViolation, median, judgePerf, exitCodeOf,
};
