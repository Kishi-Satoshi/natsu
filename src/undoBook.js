'use strict';
// 元に戻す・やり直すの列（0.14.0 Task EB-1。計画 docs/plans/2026-10-26-140.md の決めたこと 1〜13・BQ1 (a)・BQ22 (a)）。純粋（何も読まない）。
// 列は窓のメモリにだけ置き（NaTsu を終える・画面を読み直すと消える）、鍵はページと欄（'note' は要約・'memo' はメモ）の組。
// 歩み（entry）は { steps: [DB の命令の tx], literal? }。1歩 = 画面の1つの動作で送った命令の tx（stepGroup でまとめた分）。
// literal は窓のメモリだけの戻し（録音中と録音の前のメモの { before, after }）。どの関数も book を変えずに新しい book を返す。
// 画面（app.html）は使う関数を写す（0.13.0 の blockEdit と同じ形）。

// 戻せる命令（要約の欄とメモの欄の操作。見た目だけの開け閉め block.setOpen・block.setOpenAll は入れない: P6）
const UNDO_CMDS = new Set([
  'block.update', 'block.insert', 'block.remove', 'block.move', 'block.setAction', 'block.split', 'block.merge', 'block.turnInto', 'block.duplicate',
  'block.indent', 'block.paste', 'blocks.remove', 'blocks.move', 'blocks.duplicate', 'blocks.turnInto', 'blocks.setColor', 'page.setMemoDoc', 'edit.revert',
]);
const UNDO_MAX = 100;          // 1つの列の歩みの数（古いものから捨てる）
const TYPE_PAUSE_MS = 2000;    // 打つ手がこれだけ止まったら保存する（1回の保存が1歩。決めたこと 8）
const SEP = '\u0001';

// 列の鍵（録音中と録音の前のメモは 'live'・'ready' を pageId の所に）
function bookKey(pageId, pane) { return `${pageId}${SEP}${pane}`; }
const slotOf = (book, key) => (book && Object.hasOwn(book, key) ? book[key] : { undo: [], redo: [] });
const capped = (list) => (list.length > UNDO_MAX ? list.slice(list.length - UNDO_MAX) : list);
function entryOf(steps, literal) {
  const list = (Array.isArray(steps) ? steps : []).filter((s) => typeof s === 'string' && s);
  if (!list.length && !literal) return null;
  return literal ? { steps: list, literal } : { steps: list };
}

// 新しい歩みを積む（その鍵のやり直しは空に）。空の歩みは積まない
function bookPush(book, key, steps, { literal } = {}) {
  const entry = entryOf(steps, literal);
  if (!entry) return book;
  const s = slotOf(book, key);
  return { ...book, [key]: { undo: capped([...s.undo, entry]), redo: [] } };
}
function take(book, key, dir) {
  const s = slotOf(book, key);
  const list = s[dir];
  if (!list.length) return { entry: null, book };
  return { entry: list[list.length - 1], book: { ...book, [key]: { ...s, [dir]: list.slice(0, -1) } } };
}
// 戻す歩みを取り出す → { entry | null, book }
function bookTakeUndo(book, key) { return take(book, key, 'undo'); }
function bookTakeRedo(book, key) { return take(book, key, 'redo'); }
// 戻した（dir 'undo'）・やり直した（dir 'redo'）歩みを反対の列へ積む。revertStep は edit.revert の tx か { literal }
function bookDone(book, key, dir, revertStep) {
  const entry = typeof revertStep === 'string' ? entryOf([revertStep]) : entryOf([], revertStep && revertStep.literal);
  if (!entry) return book;
  const s = slotOf(book, key);
  const to = dir === 'undo' ? 'redo' : 'undo';
  return { ...book, [key]: { ...s, [to]: capped([...s[to], entry]) } };
}
// 列を空にする（鍵ならその欄だけ: 再生成は要約の列だけ。ページの ID ならそのページの全部の欄: stale）
function bookDrop(book, keyOrPageId) {
  const k = String(keyOrPageId);
  const out = {};
  for (const [key, v] of Object.entries(book || {})) {
    if (key === k || (!k.includes(SEP) && key.startsWith(`${k}${SEP}`))) continue;
    out[key] = v;
  }
  return out;
}

module.exports = { UNDO_CMDS, UNDO_MAX, TYPE_PAUSE_MS, bookKey, bookPush, bookTakeUndo, bookTakeRedo, bookDone, bookDrop };
