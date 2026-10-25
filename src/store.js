/*
 * store.js — NaTsu のストレージ層
 *
 * ページとブロックの木で持ち、ネイティブ依存なしで実装する。
 *   index.json            一覧用の軽量インデックス（起動時にこれだけ読む）
 *   pages/<id>.json       ページ本体（プロパティ + ブロック配列）
 *   transcripts/<id>.json 文字起こしセグメント（重いので分離）
 *
 * 要約ブロックは cites: [segmentId] で文字起こしの該当発言を参照する。
 * これが「要約の根拠をワンクリックで確認できる」機能の土台になる。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { isCitable, searchFold } = require('./cite');
// ページの決まり（一覧のまとめ・出典の数・短い行の印・一時停止の印・アクションの行・検索の抜き出し）は純粋な関数として
// src/pagerules.js にある（第2a1回 D-1。議事録の DB も同じものを使う）
const { summarize, citeStatOf, markShortBlocks, cleanPauses, actionRow, byDue, snippetOf } = require('./pagerules');
// 読み書きは部品（第1a回 JS1〜JS5）。いつも J.loadJsonFile(…)・J.writeJsonFile(…) と呼ぶ（テストが差し替えて見るため）
const J = require('./jsonfile');

let ROOT = '';
let index = { version: 2, pages: [] };

// ---------------------------------------------------------------- 基盤
function dirs() {
  return {
    root: ROOT,
    pages: path.join(ROOT, 'pages'),
    transcripts: path.join(ROOT, 'transcripts'),
    indexFile: path.join(ROOT, 'index.json'),
    draftFile: path.join(ROOT, 'draft.json'),
  };
}

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isIndex = (v) => isObj(v) && Array.isArray(v.pages);

// 壊れたファイルを退けたことを main に伝える受け手（P16。main が知らせと記録を決める）。
// 伝えるのはファイルの名前（パスの最後）と理由の符号だけで、中身は伝えない。
let reporter = null;
function setReporter(fn) { reporter = typeof fn === 'function' ? fn : null; }
function report(kind, file, r) {
  const ev = { kind, file: path.basename(file), movedTo: path.basename(r.movedTo), reason: r.reason };
  console.error(`store: 壊れたファイルを退けた（${ev.kind} ${ev.file} → ${ev.movedTo}、${ev.reason}）`);
  if (!reporter) return;
  try { reporter(ev); } catch (_) { /* 知らせの失敗では止めない */ }
}

// 読む。「無い」「読めない」は null、「壊れている」は退けて（中身は変えない）伝えてから null。
// 退けておかないと、次の保存で壊れたファイルが上書きされ、人手でも戻せなくなる。
function readJson(kind, file, opts) {
  const r = J.loadJsonFile(file, opts);
  if (r.state === 'ok') return r.value;
  if (r.state === 'broken') report(kind, file, r);
  else if (r.state === 'unreadable') console.error(`store: 読めない（${kind} ${path.basename(file)}、${r.code}）`);
  return null;
}

// 一時ファイルに全部書いて名前を変える（部品の writeJsonFile）。失敗は投げる（今と同じ）
function writeJson(file, data, opts) {
  J.writeJsonFile(file, data, opts);
}

function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ローカルの暦日 YYYY-MM-DD。toISOString() は UTC なので、日本では朝 9 時前に
// 始めた会議が前日の日付で保存され、一覧の並びと日付の表示が食い違う。
function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// データフォルダ <userData>/data を開く。保存先は userData/data だけ（保存先を変える設定は無い）
function init(userDataPath) {
  ROOT = path.join(userDataPath, 'data');
  const d = dirs();
  fs.mkdirSync(d.pages, { recursive: true });
  fs.mkdirSync(d.transcripts, { recursive: true });
  // 索引はページから作り直せるので、退けた控えは新しい3つまで（JS2）
  index = readJson('index', d.indexFile, { shape: isIndex, keep: 3 }) || { version: 2, pages: [] };
  if (reconcile()) writeIndex();
  return ROOT;
}

// 下書きだけを扱う初め方（第2a1回。議事録は DB が持つので、元の JSON に触れない）。
// ROOT を決めて data を作るだけ: pages/・transcripts/ を作らず、index.json を読まない（退けも書き直しもしない）
function initDrafts(userDataPath) {
  ROOT = path.join(userDataPath, 'data');
  fs.mkdirSync(ROOT, { recursive: true });
  return ROOT;
}

// いま使っているデータフォルダの絶対パス（「データ保存先を開く」用）
const root = () => ROOT;

// 索引と pages/ の食い違いを直す。真実は常に pages/ 側（索引は一覧用の写しに過ぎない）。
//   (a) 索引に無い page.json → summarize して復帰。索引が壊れて空になった場合の
//       「全議事録が消えたまま」もこれで直る（全ページが (a) になる＝再構築）。
//   (b) 索引にあって page.json が無い行 → 幽霊行なので除く。
//   (c) 古い世代の索引には searchText が無く、検索が本文に当たらない → 作り直す。
//       v0.11.0 より前の索引には memoText が無く（メモは searchText の末尾に連結され、
//       4000 字で切られていた）、メモと長い要約の後半に検索が当たらない → 同じく作り直す。
// 起動のたびに全ページを読むのは避けたいので、(a)(c) に該当する行だけ読む。
// 変更があったときだけ true を返し、呼び出し側が索引を書く。
function reconcile() {
  let onDisk;
  try {
    onDisk = new Set(fs.readdirSync(dirs().pages)
      .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)));
  } catch (e) {
    console.error('store: pages/ を読めない', e.message);
    return false;
  }
  let changed = false;
  const seen = new Set();
  const kept = [];
  for (let i = 0; i < index.pages.length; i++) {
    const entry = index.pages[i];
    if (!entry || typeof entry.id !== 'string' || !onDisk.has(entry.id) || seen.has(entry.id)) {
      changed = true;
      continue;
    }
    seen.add(entry.id);
    if (typeof index.pages[i].searchText === 'string'
      && typeof index.pages[i].memoText === 'string') { kept.push(entry); continue; }
    const page = getPage(entry.id);
    if (page) { kept.push(summarize(page)); changed = true; } else kept.push(entry);
  }
  for (const id of onDisk) {
    if (seen.has(id)) continue;
    const page = getPage(id);
    if (!page || page.id !== id) continue;   // 壊れた page.json は getPage が退避済み
    kept.push(summarize(page));
    changed = true;
  }
  if (!changed) return false;
  index.pages = kept;
  index.pages.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return true;
}

// ---------------------------------------------------------------- インデックス
// 一覧の1行は pagerules.summarize（検索用の本文 searchText・メモ memoText の上限もそこ）
function reindexPage(page) {
  const entry = summarize(page);
  const i = index.pages.findIndex((p) => p.id === page.id);
  if (i >= 0) index.pages[i] = entry;
  else index.pages.unshift(entry);
  index.pages.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  writeIndex();
}

// 索引は fsync を省く（JS5）。5,000 ページで数十 MB になり、書くたびに main が止まる。ページから作り直せる
function writeIndex() {
  writeJson(dirs().indexFile, index, { fsync: false });
}

const listPages = () => index.pages;

// ---------------------------------------------------------------- ページ
const pageFile = (id) => path.join(dirs().pages, `${id}.json`);
const transcriptFile = (id) => path.join(dirs().transcripts, `${id}.json`);

function getPage(id) {
  const page = readJson('page', pageFile(id), { shape: isObj });
  if (!page) return null;
  if (!Array.isArray(page.blocks)) page.blocks = [];
  markShortBlocks(page.blocks);
  return page;
}

function getTranscript(id) {
  const t = readJson('transcript', transcriptFile(id), { shape: isObj });
  return t && Array.isArray(t.segments) ? t.segments : [];
}

function savePage(page) {
  page.updatedAt = new Date().toISOString();
  page.citeStat = { ...(page.citeStat || {}), ...citeStatOf(page.blocks || []) };
  writeJson(pageFile(page.id), page);
  reindexPage(page);
  return page;
}

function saveTranscript(id, segments) {
  writeJson(transcriptFile(id), { id, segments });
}

// route: 文字起こし・要約の経路（第1c回 OL6。{ stt: { cloud, local, provider }, localOnly }）。普通のオブジェクトのときだけ残す
// 止めていた時間の印（第1b回 N4c）は pagerules.cleanPauses で形の正しいものだけを残す
function createPage({ title, date, durationSec, memo, blocks, segments, createdAt, recovered, route, pauses }) {
  const id = newId('p');
  const now = new Date().toISOString();
  const page = {
    id,
    title: title || '',
    date: date || localDate(new Date()),
    durationSec: durationSec || 0,
    memo: memo || '',
    blocks: blocks || [],
    createdAt: createdAt || now,
    updatedAt: now,
    recovered: Boolean(recovered),
    summaryError: '',
  };
  if (route && typeof route === 'object' && !Array.isArray(route)) page.route = route;
  if (Array.isArray(pauses)) page.pauses = cleanPauses(pauses);
  writeJson(pageFile(id), page);
  saveTranscript(id, segments || []);
  reindexPage(page);
  return page;
}

// 索引から外して書く → transcript → page の順。途中で落ちても、索引に「本体の無い行」
// （開くと空になる幽霊行）は残らない。逆に page.json が残れば次回起動の reconcile が
// 索引へ戻す（真実はファイル側）ので、消し損ねが黙って失われることもない。
function deletePage(id) {
  index.pages = index.pages.filter((p) => p.id !== id);
  writeIndex();
  for (const f of [transcriptFile(id), pageFile(id)]) {
    try { fs.unlinkSync(f); } catch (_) { /* noop */ }
  }
  return index.pages;
}

// ---------------------------------------------------------------- ブロック編集
function updateBlock(pageId, blockId, patch) {
  const page = getPage(pageId);
  if (!page) return null;
  const b = page.blocks.find((x) => x.id === blockId);
  if (!b) return null;
  if (typeof patch.text === 'string' && patch.text !== b.text) {
    // 人が書き換えた要点は、出典がまだ元の文に対応しているか分からない。
    // cites は残す（根拠を辿れる方が有用）が、被覆率の分子からは外す（stale）。
    // 人が足した行（manual）はもともと出典の対象外なので、そのまま。
    if (b.citeState !== 'manual') b.citeState = 'stale';
    // 書き換えで長さが変わりうる。短くなれば対象外、長くなれば対象に戻す
    if (isCitable(patch.text)) delete b.citeSkip; else b.citeSkip = true;
    // 0.11.0 M-3: 人が直した印の行は印を外す（DB の block.update と同じ）
    delete b.mark; delete b.unconfirmed;
    b.text = patch.text;
  }
  if (typeof patch.checked === 'boolean') b.checked = patch.checked;
  if (typeof patch.type === 'string') b.type = patch.type;
  return savePage(page);
}

// 文字起こし1区間の本文を直す。id と atMs は変えない（出典チップと時刻表示が id で引くため）。
// ページ本体（page.json）と出典は触らない。出典の引き直しとページ保存は main 側が1回だけ行う。
function updateSegment(pageId, segId, patch) {
  const segments = getTranscript(pageId);
  const s = segments.find((x) => x.id === segId);
  if (!s) return null;
  if (typeof patch.text === 'string') {
    s.text = patch.text;
    delete s.failed;   // 「認識に失敗」の行を人が書き直したら、要約の材料に戻す
  }
  saveTranscript(pageId, segments);
  return segments;
}

function insertBlock(pageId, afterBlockId, type) {
  const page = getPage(pageId);
  if (!page) return null;
  // 人が足した行。LLM の要約ではないので出典の対象外（被覆率の分母に入れない）
  const block = { id: newId('b'), type: type || 'bullet', text: '', cites: [], citeState: 'manual' };
  const i = page.blocks.findIndex((x) => x.id === afterBlockId);
  if (i >= 0) page.blocks.splice(i + 1, 0, block);
  else page.blocks.push(block);
  savePage(page);
  return { page, blockId: block.id };
}

// ブロックの並べ替え。toIndex は「動かす行を抜いたあとの」挿入位置。
// 画面側もドラッグ中の行を除いた並びで位置を数えるので、そのまま挿せる。
function moveBlock(pageId, blockId, toIndex) {
  const page = getPage(pageId);
  if (!page) return null;
  const from = page.blocks.findIndex((x) => x.id === blockId);
  if (from < 0) return null;
  const [b] = page.blocks.splice(from, 1);
  const to = Math.max(0, Math.min(Math.trunc(Number(toIndex) || 0), page.blocks.length));
  page.blocks.splice(to, 0, b);
  savePage(page);
  return page;
}

function removeBlock(pageId, blockId) {
  const page = getPage(pageId);
  if (!page) return null;
  page.blocks = page.blocks.filter((x) => x.id !== blockId);
  return savePage(page);
}

function setTitle(pageId, title) {
  const page = getPage(pageId);
  if (!page) return null;
  page.title = title;
  return savePage(page);
}

// ---------------------------------------------------------------- 検索
// 検索は畳み込んだ文字列どうしで当てる（#53）。文字起こしは「では、予算案の、作成を」の
// ように読点が挟まり、要約は「ＡＩ」と「AI」が混ざるので、原文どうしの includes では
// 言ったはずの語が見つからない。畳み込みは cite.searchFold（normalize とは別物）。

// 畳んだ文字の抜き出し（foldWithMap・snippetOf）は pagerules にある

// 一覧（タイトル・要約本文・メモ）の絞り込みは同期・即時。
// タイトル → 要約本文（searchText）→ メモ（memoText）の順に当て、抜粋は当たった方の
// 原文から切る。打鍵のたびに全ページを走るので、まず丸ごと畳んで当たりだけ見る。
function searchIndex(query) {
  const q = searchFold(query);
  if (!q) return index.pages;
  const out = [];
  for (const p of index.pages) {
    if (searchFold(p.title).includes(q)) { out.push(p); continue; }
    const text = p.searchText || p.preview || '';
    if (searchFold(text).includes(q)) { out.push({ ...p, snippet: snippetOf(text, q) }); continue; }
    const memo = p.memoText || '';
    if (searchFold(memo).includes(q)) out.push({ ...p, snippet: snippetOf(memo, q) });
  }
  return out;
}

// 全文検索は文字起こしファイルを走査する（件数が増えると重いので呼び出し側で明示実行）
// 文字起こし（トランスクリプト）だけを対象に検索する。
// 要約は編集や言い換えを経ているので、「言ったかどうか」を探す用途では
// 原文の方が信頼できる。要約やタイトルは通常の検索（searchIndex）が受け持つ。
// 抜粋は当たった区間の原文そのもの（畳んだ文字列は見せない）。
//
// 戻り値は { hits, total, truncated }（#43）。以前は limit 件たまった時点で走査を
// 止め、打ち切ったことが戻り値にも画面にも出なかった（「全件見た」と誤解させる）。
// 全ページを走査して当たったページ数を total に数え、hits は先頭 limit 件（索引の
// 並び＝新しい順）、truncated は「見せていない当たりがある」印。
const FULL_TEXT_LIMIT = 60;
function searchFullText(query, limit) {
  const q = searchFold(query);
  if (!q) return { hits: [], total: 0, truncated: false };
  const max = Number(limit) > 0 ? Math.trunc(Number(limit)) : FULL_TEXT_LIMIT;
  const hit = (s) => s.text && searchFold(s.text).includes(q);
  const hits = [];
  let total = 0;
  for (const entry of index.pages) {
    const segments = getTranscript(entry.id);
    // hits が埋まったあとは数えるだけ（当たりが1つあれば足りる）
    if (hits.length >= max) { if (segments.some(hit)) total++; continue; }
    const inSegments = segments.filter(hit);
    if (inSegments.length === 0) continue;
    total++;
    hits.push({
      ...entry,
      segmentHits: inSegments.length,
      snippet: inSegments[0].text,
    });
  }
  return { hits, total, truncated: total > hits.length };
}

// ---------------------------------------------------------------- 未完了アクション
// アクションの行（actionRow）と期限の並び（byDue）は pagerules にある

// アクションタブの1画面分を1回の走査で作る（#45）。
// 以前は1打鍵ごとに openActions()（全 todo 持ちページを読む）と assigneeList()
// （その中でもう一度 openActions()）の IPC 2本を呼び、500 ページで同期ディスク読み
// 1000 回になっていた。ここでは
//   - 索引の openActionCount が 0 のページ（完了だけ・todo 無し）は読まない
//   - 行（actions）・担当者の一覧（people）・件数（total）を1度に返す
// people の count と total は q / assignee で絞る前の未完了件数（絞ってもチップの
// 数字が変わらない）。q は searchFold で畳んで本文・議事録名・担当に当て、assignee は
// 完全一致（チップで選ぶ名前なので部分一致は要らない）。
function actionView({ q, assignee } = {}) {
  const fq = searchFold(q);
  const who = String(assignee || '');
  const counts = new Map();
  const actions = [];
  let total = 0;
  for (const entry of index.pages) {
    if (!entry.openActionCount) continue;
    const page = getPage(entry.id);
    if (!page) continue;
    for (const b of page.blocks) {
      if (b.type !== 'todo' || b.checked || !b.text) continue;
      const row = actionRow(page, b);
      total++;
      if (row.assignee) counts.set(row.assignee, (counts.get(row.assignee) || 0) + 1);
      if (who && row.assignee !== who) continue;
      if (fq && ![row.text, row.pageTitle, row.assignee].some((s) => searchFold(s).includes(fq))) continue;
      actions.push(row);
    }
  }
  actions.sort(byDue);
  const people = [...counts.entries()].map(([name, count]) => ({ name, count }))
    .sort((x, y) => y.count - x.count);
  return { actions, people, total };
}

// 全ページ横断の未完了アクションアイテム（actionView の行だけ）
function openActions() {
  return actionView().actions;
}

// 未完了アクションに登場する担当者の一覧（絞り込み用。actionView の people だけ）
function assigneeList() {
  return actionView().people;
}

// ---------------------------------------------------------------- 進行中ドラフト（JS9）
// 下書きの名前は3つの形だけ: 今の会議の draft.json、脇へ寄せた draft.pending-<時刻>.json、
// 会議ごとの draft-<開始時刻>.json。名前はこの形のものしか受け取らない（data の外を指させない）。
const DRAFT_RE = /^draft(?:\.json|\.pending-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json|-\d+\.json)$/;
function draftPath(name) {
  if (typeof name !== 'string' || !DRAFT_RE.test(name)) throw new Error('store: 下書きの名前ではない');
  return path.join(dirs().root, name);
}

// → 今ある下書きの名前（名前の順）。退けた控え・一時ファイルは数えない。フォルダを読めなければ []
function draftFiles() {
  let names;
  try { names = fs.readdirSync(dirs().root); } catch (_) { return []; }
  return names.filter((n) => DRAFT_RE.test(n)).sort();
}

// → J.loadJsonFile の結果。読めないときは消さず名前も変えない（呼び手が後で読み直す）。壊れていれば退けて伝える
function readDraftFile(name) {
  const file = draftPath(name);
  const r = J.loadJsonFile(file, { shape: isObj });
  if (r.state === 'broken') report('draft', file, r);
  return r;
}

// fsync は main が決める（既定は今と同じ、fsync なし）
function writeDraft(d, name = 'draft.json', opts = {}) {
  writeJson(draftPath(name), d, { fsync: opts.fsync === true });
}

function clearDraft(name = 'draft.json') {
  try { fs.unlinkSync(draftPath(name)); } catch (_) { /* noop */ }
}

// draft.json を draft.pending-<時刻>.json へ名前を変えて脇へ寄せる。→ { ok: true, name } | { ok: false }
// 同じ名前があれば 1 ミリ秒ずつずらす（ほかの下書きを決して上書きしない）
function parkDraft() {
  try {
    const from = dirs().draftFile;
    let t = Date.now();
    let name;
    for (;;) {
      name = `draft.pending-${new Date(t).toISOString().replace(/[:.]/g, '-')}.json`;
      if (!fs.existsSync(path.join(dirs().root, name))) break;
      t += 1;
    }
    fs.renameSync(from, path.join(dirs().root, name));
    return { ok: true, name };
  } catch (_) {
    return { ok: false };
  }
}

module.exports = {
  init, initDrafts, root, newId,
  listPages, getPage, getTranscript, savePage, saveTranscript,
  createPage, deletePage,
  updateBlock, updateSegment, insertBlock, removeBlock, moveBlock, setTitle,
  searchIndex, searchFullText, actionView, openActions, assigneeList,
  writeDraft, clearDraft,
  setReporter, draftFiles, readDraftFile, parkDraft,
};
