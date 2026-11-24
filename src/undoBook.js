'use strict';
// 元に戻す・やり直すの列（0.14.0 Task EB-1。計画 docs/plans/2026-10-26-140.md の決めたこと 1〜13・BQ1 (a)・BQ22 (a)）。純粋（何も読まない）。
// 列は窓のメモリにだけ置き（NaTsu を終える・画面を読み直すと消える）、鍵はページと欄（'note' は要約・'memo' はメモ・0.16.0 の 'db' はデータベースの表）の組。
// 歩み（entry）は { steps: [DB の命令の tx], literal? }。1歩 = 画面の1つの動作で送った命令の tx（stepGroup でまとめた分）。
// literal は窓のメモリだけの戻し（録音中と録音の前のメモの { before, after }）。どの関数も book を変えずに新しい book を返す。
// 画面（app.html）は使う関数を写す（0.13.0 の blockEdit と同じ形）。

// 戻せる命令（要約の欄とメモの欄の操作。見た目だけの開け閉め block.setOpen・block.setOpenAll は入れない: P6）
const UNDO_CMDS = new Set([
  'block.update', 'block.insert', 'block.remove', 'block.move', 'block.setAction', 'block.split', 'block.merge', 'block.turnInto', 'block.duplicate',
  'block.indent', 'block.paste', 'blocks.remove', 'blocks.move', 'blocks.duplicate', 'blocks.turnInto', 'blocks.setColor', 'page.setMemoDoc', 'edit.revert',
  // 0.16.0 DS-3（計画 docs/plans/2026-11-04-160.md の決めたこと 47）: データベースの表の操作（列の鍵は bookKey(<データベースの ID>, 'db')）。
  // ビューの設定（view.*）と［完全に消す］（col.purge）は見た目の設定・戻せない操作なので入れない
  'row.add', 'row.setCell', 'rows.setCell', 'rows.paste', 'row.move', 'rows.trash',
  'col.add', 'col.rename', 'col.setType', 'col.move', 'col.remove', 'col.restore', 'col.setOpts', 'col.setFmt',
  // 0.16.0 DR-1（決めたこと 47）: リレーションの行を足す・外す・サブアイテムを入れる・外す
  'rel.link', 'rel.unlink', 'db.setSub',
  // 0.16.0 DL-1（決めたこと 40・R105）: リンクドビューの行を置く（本文の歩み）・データベースの題名（データベースの歩み）
  'block.insertDbView', 'db.setTitle',
  // 0.17.0 PD-1（計画 docs/plans/2026-11-13-170.md の決めたこと 33）: 空の白紙のページをデータベースにする（データベースの歩み。Ctrl+Z で白紙のページへ）
  'page.toDb',
  // 0.17.0 TK-2（決めたこと 63）: ［タスクにする］（要約の欄・本文の歩み。Ctrl+Z で行と ToDo の印が一緒に戻る）
  'todo.toTask',
  // 0.17.0 RT-1（決めたこと 70）: 行のテンプレート（データベースの歩み）
  'tpl.add', 'tpl.dup', 'tpl.remove', 'tpl.setDefault', 'row.fromTpl',
  // 0.18.0 XE-1（計画 docs/plans/2026-11-18-180.md の決めたこと 57）: 印を1つ戻す・進める（その tx は保存の歩みに足し、印が始めの次まで来たら歩みごと edit.revert で戻す）
  'edit.textStep',
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
// 戻した（dir 'undo'）・やり直した（dir 'redo'）歩みを反対の列へ積む。revertStep は edit.revert の tx か { literal }。
// 0.18.0 XE-1: 戻した歩み from が印を持っていれば、反対の歩みも同じ印を持つ（戻した後は始め at 0・やり直した後は始めの次 at 1）
function bookDone(book, key, dir, revertStep, from) {
  const made = typeof revertStep === 'string' ? entryOf([revertStep]) : entryOf([], revertStep && revertStep.literal);
  if (!made) return book;
  const entry = from && Array.isArray(from.marks) ? { ...made, marks: from.marks, row: from.row, at: dir === 'undo' ? 0 : 1 } : made;
  const s = slotOf(book, key);
  const to = dir === 'undo' ? 'redo' : 'undo';
  return { ...book, [key]: { ...s, [to]: capped([...s[to], entry]) } };
}
// 0.18.0 XE-1（決めたこと 57）: 保存の歩み（一番上。steps が [step] の歩みか、step が無ければ窓のメモリの歩み）に、その行（row）の印の並びを持たせる。
// 印が3つ以上のときだけ（2つなら今どおりの1歩）。今の印の番号 at は終わり
function bookMark(book, key, marks, step, row) {
  if (!Array.isArray(marks) || marks.length < 3) return book;
  const s = slotOf(book, key);
  const top = s.undo[s.undo.length - 1];
  if (!top || top.marks || top.fwd) return book;
  if (step ? !(top.steps.length === 1 && top.steps[0] === step && !top.literal) : (top.steps.length || !top.literal)) return book;
  return { ...book, [key]: { ...s, undo: [...s.undo.slice(0, -1), { ...top, marks, row, at: marks.length - 1 }] } };
}
// 0.18.0 XE-1: 印を1つ動かした（edit.textStep か窓のメモリ）。entry は動かした後の歩み（edit.textStep の tx は steps に足してある）。
// 戻した（dir 'undo'。歩みは取り出してある）ら戻す列の上に戻し、やり直しの列に進みの印 { steps: [], fwd: true } を積む。
// やり直した（dir 'redo'。進みの印は取り出してある）ら戻す列の一番上の歩みを替える
function bookStepped(book, key, dir, entry) {
  const s = slotOf(book, key);
  if (dir === 'undo') return { ...book, [key]: { undo: capped([...s.undo, entry]), redo: capped([...s.redo, { steps: [], fwd: true }]) } };
  if (!s.undo.length) return book;
  return { ...book, [key]: { ...s, undo: [...s.undo.slice(0, -1), entry] } };
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

module.exports = { UNDO_CMDS, UNDO_MAX, TYPE_PAUSE_MS, bookKey, bookPush, bookTakeUndo, bookTakeRedo, bookDone, bookMark, bookStepped, bookDrop };
