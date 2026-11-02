'use strict';
// メモの行の純粋な部品（0.14.0 Task MB-1。計画 docs/plans/2026-10-26-140.md の決めたこと 59〜61・63・R41・R42・R69・BQ23 (a)・BQ28 (a)・BQ29 (a)・F106）。
// メモはページの1つの値 memoDoc（行の並び。各行は要約の行と同じ欄 { id, type, level?, toggle?, text, rich?, checked?, icon?, color?, citeState, children? }。
// 行の ID は m で始まる。担当・期限・出典・印の欄は持たない）。読む所（Claude・MCP・検索・書き出し）は今の素の文字 memo を読み続け、
// memo は memoPlain(memoDoc) で作り直す（Claude に渡る文を変えない）。どの行も人の行の印 citeState: 'manual' を持つ（AI の見出しの決まりを
// メモに漏らさない: R69）。直し方 memoEdit は要約の命令（src/db/commands.js の block.*・blocks.*）と同じ名前・同じ意味で、新しい memoDoc を作る
// （DB の命令を倍にしない: R42。同じかは test/stage140.lib.test.js が一時の DB と照らす）。命令の表は持ち物で引く（どの物にも生えている名前で
// 関数を呼ばない）。引数と飾りの照らし・上限は DB と同じ部品（src/db/validate.js）を使う。何も書かない・何も読みに行かない。
const blockEdit = require('./blockEdit');
const BT = require('./blockTree');
const RT = require('./richText');
const V = require('./db/validate');

const HEAD = '■ ';                                // 0.11.0 の雛形の見出しの頭（memoPreset と同じ）
const MEMO_ID_RE = /^m[A-Za-z0-9_-]{0,63}$/;      // 行の ID（validate の ID の形で、頭が m）
// 行が持てる欄（ほかは断る。出典・担当・期限・印（cites・assignee・due・aiHeading・mark・citeSkip）と開け閉め open（R44）も入らない）
const ROW_KEYS = Object.freeze(['id', 'type', 'level', 'toggle', 'text', 'rich', 'checked', 'icon', 'color', 'citeState', 'children']);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function fail(code, why) { const e = new Error(why); e.code = code; return e; }
const bad = (why) => fail('bad-args', why);
const clone = (v) => structuredClone(v);
const utf8Len = (s) => new TextEncoder().encode(s).length;

// ---------------------------------------------------------------- 今のメモの文 → 行（決めたこと 63・BQ23 (a)）
// 1行1行をテキストの行に。頭が「■ 」の行だけを見出し3に（記法として読まない）。空の行は空のテキストの行。改行は \n にそろえ、終わりの改行は捨てる。
// 2,000 行（LIMITS.blocks）を越える文は、2,000 行目に残りの行を改行のまま入れる（往復で1文字も変わらない: R147）
function memoFromText(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const lines = s.split('\n');
  if (lines.length > V.LIMITS.blocks) lines.splice(V.LIMITS.blocks - 1, lines.length, lines.slice(V.LIMITS.blocks - 1).join('\n'));
  return lines.map((line, i) => lineRow(line, `m${(i + 1).toString(36)}`));
}
function lineRow(line, id) {
  if (line.startsWith(HEAD)) return { id, type: 'heading', level: 3, text: line.slice(HEAD.length), citeState: 'manual' };
  return { id, type: 'paragraph', text: line, citeState: 'manual' };
}

// ---------------------------------------------------------------- 行 → 素の文字（決めたこと 60）
// 1行1行を改行でつなぐ。見出しは段を問わず「■ 」（トグル見出しも）・箇条書きとトグルは「- 」・番号は親ごとの並びの数・ToDo は「- [ ] 」「- [x] 」・
// 引用は「> 」・区切り線は「---」・コールアウトは絵文字と空白・‡131 子は段ごとに2つの空白。飾りは文字だけ（リンクの住所は出さない）。
// 終わりの改行は1つ（中身が無ければ空・付けると 10 万字を越えるなら付けない: R162）。memoPlain(memoFromText(t)) は改行をそろえ終わりの改行を1つにした t と同じ
function memoPlain(doc) {
  const list = Array.isArray(doc) ? doc : [];
  const nums = BT.numberLabelsTree(list);
  const lines = [];
  const go = (rows, depth) => {
    for (const b of Array.isArray(rows) ? rows : []) {
      if (!isObj(b)) continue;
      const pad = '  '.repeat(depth);
      lines.push(pad + plainLine(b, nums).replace(/\n/g, `\n${pad}`));
      go(b.children, depth + 1);
    }
  };
  go(list, 0);
  const s = lines.join('\n').replace(/\n+$/, '');
  // 終わりの改行は、付けると 10 万字（LIMITS.text）を越えるときは付けない（MB-1 直し・R162: 10 万字ちょうどの今のメモを行にしても直せ、memo は今の上限の内）
  return s && s.length < V.LIMITS.text ? `${s}\n` : s;
}
function plainLine(b, nums) {
  const t = Array.isArray(b.rich) ? RT.plainOf(b.rich) : String(b.text ?? '');
  if (b.type === 'heading') return `■ ${t}`;
  if (b.type === 'bullet' || b.type === 'toggle') return `- ${t}`;
  if (b.type === 'numbered') return `${nums.get(b.id) || '1.'} ${t}`;
  if (b.type === 'todo') return `- [${b.checked === true ? 'x' : ' '}] ${t}`;
  if (b.type === 'quote') return `> ${t}`;
  if (b.type === 'divider') return '---';
  if (b.type === 'callout') return `${b.icon || blockEdit.CALLOUT_ICON} ${t}`;
  return t;
}

// ---------------------------------------------------------------- 照らし（決めたこと 59・R69）
// → 整えた新しい doc（渡した doc は変えない）か投げる（形は bad-args・大きさは too-big）。2,000 行（子孫も数える）・1MB（JSON の UTF-8）・
// memoPlain が 10 万字まで。型は画面の型の表・段は見出しだけ・飾りは DB と同じ照らし（色は1つ・開けるリンクだけ）。文は飾りから作り直す。
// citeState が無ければ 'manual' を付け、ほかの値と出典・印の欄は断る
function validateMemoDoc(doc) {
  if (!Array.isArray(doc)) throw bad('memoDoc');
  const st = { n: 0, ids: new Set() };
  const out = doc.map((b) => checkRow(b, st));
  if (utf8Len(JSON.stringify(out)) > V.LIMITS.bytes) throw fail('too-big', 'memoDoc bytes');
  if (memoPlain(out).length > V.LIMITS.text) throw fail('too-big', 'memo text');
  return out;
}
function checkRow(b, st) {
  if (!isObj(b)) throw bad('row');
  if (++st.n > V.LIMITS.blocks) throw fail('too-big', 'rows');
  for (const k of Object.keys(b)) if (!ROW_KEYS.includes(k)) throw bad('row key');
  if (typeof b.id !== 'string' || !MEMO_ID_RE.test(b.id) || st.ids.has(b.id)) throw bad('row id');
  st.ids.add(b.id);
  if (!blockEdit.TYPE_KEYS.includes(b.type)) throw bad('row type');
  const out = { id: b.id, type: b.type };
  if (b.level !== undefined) {
    if (b.type !== 'heading' || ![1, 2, 3].includes(b.level)) throw bad('row level');
    out.level = b.level;
  }
  if (b.toggle !== undefined) {
    if (b.type !== 'heading' || b.toggle !== true) throw bad('row toggle');
    out.toggle = true;
  }
  let text = b.text === undefined ? '' : b.text;
  if (typeof text !== 'string' || text.length > V.LIMITS.text) throw bad('row text');
  let rich = null;
  if (b.rich !== undefined && b.rich !== null) {
    text = V.richText(b.rich);   // DB と同じ照らし（知らない飾り・2つの色・開けないリンク・コードの中のリンクは投げる）
    rich = RT.normalizeRich(b.rich);
  }
  if (b.type === 'divider' && text !== '') throw bad('row divider');
  out.text = text;
  if (rich) out.rich = rich;
  // 型を変えても残る欄（DB の block.turnInto と同じく、ToDo のチェックとコールアウトの絵文字は見えなくなるだけ）
  if (b.checked !== undefined) { if (typeof b.checked !== 'boolean') throw bad('row checked'); out.checked = b.checked; }
  if (b.icon !== undefined) { if (b.icon !== blockEdit.CALLOUT_ICON) throw bad('row icon'); out.icon = b.icon; }
  if (b.color !== undefined) {
    if (typeof b.color !== 'string' || !RT.COLORS.includes(b.color.replace(/_bg$/, ''))) throw bad('row color');
    out.color = b.color;
  }
  if (b.citeState !== undefined && b.citeState !== 'manual') throw bad('row citeState');
  out.citeState = 'manual';
  if (b.children !== undefined) {
    if (!Array.isArray(b.children)) throw bad('row children');
    const kids = b.children.map((c) => checkRow(c, st));
    if (kids.length && !BT.kidsCan(out)) throw bad('row children');
    if (kids.length) out.children = kids;
  }
  return out;
}

// ---------------------------------------------------------------- 直し方（決めたこと 61・R42。要約の命令と同じ名前・同じ意味）
// 新しい行の ID（doc の中で重ならない。m に 36 進の数。今の一番大きな数の次から）。next（呼び手が窓のメモリに持つ高い水の印: MB-1 直し・R161）が
// あれば、それより小さな数は使わない（同じ窓で消した行の ID を使い回さない）。→ { nid（新しい ID を1つ）, next（次に使ってよい一番小さな数） }
const NEXT_MAX = 36 ** 8;   // ID の数の上限（m に 36 進の 8 字まで）
function idMaker(doc, floor = 1) {
  const used = new Set(BT.flattenBlocks(doc).map((b) => b.id));
  let n = floor - 1;
  for (const id of used) { const m = /^m([0-9a-z]{1,8})$/.exec(id); if (m) n = Math.max(n, parseInt(m[1], 36)); }
  return {
    nid: () => {
      let id;
      do {
        if (n + 1 >= NEXT_MAX) throw fail('too-big', 'ids');   // MB-2 直し（R168）: 36 進の 8 字を越える ID と、上限を越える next を作らない
        n += 1; id = `m${n.toString(36)}`;
      } while (used.has(id));
      used.add(id);
      return id;
    },
    next: () => n + 1,
  };
}
function putRich(b, rich) {
  const r = RT.normalizeRich(rich);
  if (r) b.rich = r; else delete b.rich;
}
// 分ける位置: 文の長さの中で、サロゲートの対の間でない（DB の splitAtOk と同じ）
function splitAtOk(text, at) {
  if (!(at <= text.length)) return false;
  const hi = text.charCodeAt(at - 1), lo = text.charCodeAt(at);
  return !(at > 0 && at < text.length && hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff);
}
// 選んだ行（ids）→ ほかの選んだ行の子孫を除いた行（DB の pickRoots と同じ）
function pickRoots(doc, ids) {
  if (!ids.length) throw bad('ids');
  const at = new Map(BT.walk(doc).map((w) => [w.b.id, w]));
  const want = new Set(ids);
  const roots = [];
  for (const id of want) {
    const w = at.get(id);
    if (!w) throw bad('ids');
    let up = w.parentId;
    while (up !== null && !want.has(up)) up = at.get(up).parentId;
    if (up === null) roots.push(w.b);
  }
  return roots;
}
function takeOut(doc, rows) {
  for (const b of rows) { const w = BT.locate(doc, b.id); w.list.splice(w.index, 1); }
}
// 型を変える1行（DB の turnBlock と同じ。メモの行はどれも人の行なので、AI の見出しの印 aiHeading は付けない: R69）。同じ型なら false
function turnRow(l, a) {
  const b = l.b;
  const level = a.type === 'heading' ? (a.level || 2) : 0;
  const toggle = a.type === 'heading' && a.toggle === true;
  if (b.type === a.type && (a.type !== 'heading' || (blockEdit.headingLevel(b) === level && (b.toggle === true) === toggle))) return false;
  const out = BT.turnMovesKids(b, { type: a.type, level, toggle });
  b.type = a.type;
  if (level) b.level = level; else delete b.level;
  if (toggle) b.toggle = true; else delete b.toggle;
  if (a.type === 'callout' && !b.icon) b.icon = blockEdit.CALLOUT_ICON;
  if (a.type === 'todo' && typeof b.checked !== 'boolean') b.checked = false;
  if (out) BT.kidsOut(l.list, l.index);
  return true;
}
// 貼る行（validate の pasteBlocks の写し）→ メモの行（新しい ID・人の行）。子を持てない型の下の子は後ろの兄弟に上げる（R66）
function pasteRows(rows, nid) {
  const out = [];
  for (const r of rows) {
    const b = { id: nid(), type: r.type, text: RT.plainOf(r.rich), citeState: 'manual' };
    if (r.type === 'heading' && r.level) b.level = r.level;
    if (r.type === 'todo') b.checked = r.checked === true;
    if (r.type === 'callout') b.icon = blockEdit.CALLOUT_ICON;
    putRich(b, r.rich);
    const kids = pasteRows(r.children || [], nid);
    out.push(b);
    if (!kids.length) continue;
    if (BT.kidsCan(b)) b.children = kids; else out.push(...kids);
  }
  return out;
}
const lastOf = (rows) => { const f = BT.flattenBlocks(rows); return f[f.length - 1].id; };
// 貼り付け（DB の pasteInto と同じ: 文のある行の頭は上に足す BQ30 (a)・子の見えている行は文の途中でも最初の子 BQ31・後ろの文の行の型は Enter と同じ BQ32・
// 空のテキストの行は最初に貼った行がその行になる R18）→ 最後に貼った行の ID か null
function pasteInto(d, a, nid) {
  const l = BT.locate(d, a.blockId);
  if (!l) return null;
  const b = l.b;
  const text = RT.plainOf(a.rich);
  if (!splitAtOk(text, a.at)) throw bad('at');
  if (a.inside === true && (!BT.kidsCan(b) || (a.at === 0 && text !== ''))) throw bad('inside');
  const rows = pasteRows(a.blocks, nid);
  if (a.at === 0 && text !== '') {
    putRich(b, a.rich);
    b.text = text;
    if (a.afterId === a.blockId) throw bad('afterId');
    const s = a.afterId === undefined ? { list: l.list, index: l.index } : BT.spotOf(d, a.afterId, a.afterId === '' && l.parent ? l.parent.id : undefined);
    if (!s || s.list !== l.list) throw bad('afterId');
    s.list.splice(s.index, 0, ...rows);
    return lastOf(rows);
  }
  if (b.type === 'paragraph' && text === '' && !(Array.isArray(b.children) && b.children.length)) {
    const [first, ...more] = rows;
    b.type = first.type;
    if (first.level) b.level = first.level; else delete b.level;
    delete b.toggle;
    if (first.type === 'todo') b.checked = first.checked;
    if (first.type === 'callout' && !b.icon) b.icon = blockEdit.CALLOUT_ICON;
    putRich(b, first.rich || [{ t: first.text }]);
    b.text = first.text;
    if (first.children) b.children = first.children;
    l.list.splice(l.index + 1, 0, ...more);
    return lastOf([b, ...more]);
  }
  const [r1, r2] = blockEdit.splitRich(a.rich, a.at);
  putRich(b, r1);
  b.text = text.slice(0, a.at);
  const after = [...rows];
  const tailText = text.slice(a.at);
  if (tailText !== '') {
    const nt = blockEdit.nextTypeOnEnter(b, { open: a.inside === true });
    const nb = { id: nid(), type: nt.type, text: tailText, citeState: 'manual' };
    if (nt.level) nb.level = nt.level;
    if (nt.toggle === true) nb.toggle = true;
    if (nt.type === 'todo') nb.checked = false;
    putRich(nb, r2);
    after.push(nb);
  }
  if (a.inside === true) { if (!Array.isArray(b.children)) b.children = []; b.children.splice(0, 0, ...after); }
  else l.list.splice(l.index + 1, 0, ...after);
  return lastOf(rows);
}

// 命令の表（引数の型は DB の命令の表から pageId を除いたもの。run(doc, args, nid) は doc を直し、答えの行（DB の答えから page を除いた形）か null を返す）
const CMDS = Object.freeze(Object.assign(Object.create(null), {
  'block.update': { args: { blockId: 'id', patch: 'patch' },
    run: (d, a) => {
      const l = BT.locate(d, a.blockId);
      if (!l) return null;
      const b = l.b;
      const patch = a.patch;
      if (patch.rich === undefined && typeof patch.text === 'string' && Array.isArray(b.rich)) throw bad('rich');   // 飾りを黙って捨てない（決めたこと 16）
      if (typeof patch.text === 'string') b.text = patch.text;
      if (typeof patch.checked === 'boolean') b.checked = patch.checked;
      if (typeof patch.type === 'string') b.type = patch.type;
      // MB-1 直し（R163）: 見出しでなくなった行の段とトグルの印は持たない（DB の行では効かない残り）。区切り線の文・子を持てない型の子は照らしが断る
      if (b.type !== 'heading') { delete b.level; delete b.toggle; }
      if (patch.rich !== undefined) putRich(b, patch.rich);
      return null;
    } },
  'block.insert': { args: { afterBlockId: 'idOrEmpty', type: 'blockType?', level: 'level?', icon: 'icon?', parentId: 'id?', toggle: 'bool?' },
    run: (d, a, nid) => {
      const block = { id: nid(), type: a.type || 'bullet', text: '', citeState: 'manual' };
      if (block.type === 'heading' && a.level) block.level = a.level;
      if (block.type === 'heading' && a.toggle === true) block.toggle = true;
      if (block.type === 'callout') block.icon = blockEdit.CALLOUT_ICON;
      if (a.parentId !== undefined) {
        const s = BT.spotOf(d, a.afterBlockId, a.parentId);
        if (!s) throw bad('parentId');
        s.list.splice(s.index, 0, block);
      } else {
        const l = BT.locate(d, a.afterBlockId);
        if (l) l.list.splice(l.index + 1, 0, block); else d.push(block);
      }
      return { blockId: block.id };
    } },
  'block.remove': { args: { blockId: 'id' },
    run: (d, a) => {
      const l = BT.locate(d, a.blockId);
      if (l) l.list.splice(l.index, 1);
      return null;
    } },
  'block.move': { args: { blockId: 'id', toIndex: 'num?', afterId: 'idOrEmpty?', parentId: 'id?' },
    run: (d, a) => {
      const l = BT.locate(d, a.blockId);
      if (!l) return null;
      if (a.afterId !== undefined) {
        if (a.afterId === a.blockId) return null;
        if (a.afterId !== '' && !BT.locate(d, a.afterId)) throw bad('afterId');
        if ((a.afterId && BT.within(l.b, a.afterId)) || (a.parentId && BT.within(l.b, a.parentId))) throw bad('afterId');
        const [m] = l.list.splice(l.index, 1);
        const s = BT.spotOf(d, a.afterId, a.parentId);
        if (!s) throw bad('afterId');
        s.list.splice(s.index, 0, m);
        return null;
      }
      if (a.toIndex === undefined || l.parent) throw bad('toIndex');
      const [b] = d.splice(l.index, 1);
      d.splice(Math.max(0, Math.min(Math.trunc(Number(a.toIndex) || 0), d.length)), 0, b);
      return null;
    } },
  // 今の行の文を text にしてから at で分ける（文のある行の頭は上に空の行・inside は最初の子・後ろの行の型は nextTypeOnEnter）→ { blockId: 新しい行 }
  'block.split': { args: { blockId: 'id', text: 'text', at: 'offset', afterId: 'idOrEmpty?', inside: 'bool?', rich: 'richArg?' },
    run: (d, a, nid) => {
      const l = BT.locate(d, a.blockId);
      if (!l) return null;
      if (!splitAtOk(a.text, a.at)) throw bad('at');
      if (a.afterId !== undefined && a.afterId !== '' && (a.afterId === a.blockId || !BT.locate(d, a.afterId))) throw bad('afterId');
      const b = l.b;
      if (a.inside === true && !BT.kidsCan(b)) throw bad('inside');
      if (a.rich !== undefined && RT.plainOf(a.rich) !== a.text) throw bad('rich');
      if (a.rich !== undefined) putRich(b, a.rich);
      const [head, tail] = [a.text.slice(0, a.at), a.text.slice(a.at)];
      const next = blockEdit.nextTypeOnEnter(b, { open: a.inside === true });
      const nb = { id: nid(), type: next === 'revert' ? 'paragraph' : next.type, text: tail, citeState: 'manual' };
      if (next.level) nb.level = next.level;
      if (next.toggle === true) nb.toggle = true;
      if (nb.type === 'todo') nb.checked = false;
      if (a.at === 0 && a.text !== '') {
        nb.text = '';
        if (Array.isArray(b.rich) && RT.plainOf(b.rich) !== a.text) delete b.rich;
        b.text = a.text;
        const s = a.afterId === undefined ? null : BT.spotOf(d, a.afterId, a.afterId === '' && l.parent ? l.parent.id : undefined);
        if (a.afterId !== undefined && (!s || s.list !== l.list)) throw bad('afterId');
        if (a.afterId === undefined) l.list.splice(l.index, 0, nb);
        else s.list.splice(s.index, 0, nb);
        return { blockId: nb.id };
      }
      if (Array.isArray(b.rich)) {
        if (RT.plainOf(b.rich) === a.text) { const [r1, r2] = blockEdit.splitRich(b.rich, a.at); putRich(b, r1); putRich(nb, r2); } else delete b.rich;
      }
      b.text = head;
      if (a.inside === true) { if (!Array.isArray(b.children)) b.children = []; b.children.unshift(nb); }
      else l.list.splice(l.index + 1, 0, nb);
      return { blockId: nb.id };
    } },
  // 今の行の文を text にしてから、前の行（intoId か平らにした並びの前）の後ろにつなぐ。前が区切り線なら区切り線だけを消す → { blockId, at }
  'block.merge': { args: { blockId: 'id', text: 'text', intoId: 'id?', rich: 'richArg?' },
    run: (d, a) => {
      const l = BT.locate(d, a.blockId);
      if (!l) return null;
      let pl;
      if (a.intoId !== undefined) {
        if (BT.within(l.b, a.intoId)) throw bad('intoId');
        pl = BT.locate(d, a.intoId);
        if (!pl) throw bad('intoId');
      } else {
        const flat = BT.flattenBlocks(d);
        const i = flat.indexOf(l.b);
        if (i <= 0) return { blockId: a.blockId, at: 0 };
        pl = BT.locate(d, flat[i - 1].id);
      }
      const b = l.b;
      const prev = pl.b;
      if (a.rich !== undefined && RT.plainOf(a.rich) !== a.text) throw bad('rich');
      if (a.rich !== undefined) putRich(b, a.rich);
      if (prev.type === 'divider') { pl.list.splice(pl.index, 1); b.text = a.text; return { blockId: a.blockId, at: 0 }; }
      const at = String(prev.text || '').length;
      const tail = Array.isArray(b.rich) && RT.plainOf(b.rich) === a.text ? b.rich : [{ t: a.text }];
      if (Array.isArray(prev.rich) || Array.isArray(b.rich)) putRich(prev, blockEdit.joinRich(Array.isArray(prev.rich) ? prev.rich : [{ t: String(prev.text || '') }], tail));
      if (a.text) prev.text = String(prev.text || '') + a.text;
      const kids = Array.isArray(b.children) ? b.children : [];
      l.list.splice(l.index, 1);
      BT.mergeKids(BT.locate(d, prev.id), kids);
      return { blockId: prev.id, at };
    } },
  'block.turnInto': { args: { blockId: 'id', type: 'blockType', level: 'level?', toggle: 'bool?' },
    run: (d, a) => {
      const l = BT.locate(d, a.blockId);
      if (!l) return null;
      if (a.type === 'divider' && String(l.b.text || '') !== '') throw bad('divider');
      if (a.type === 'divider' && Array.isArray(l.b.children) && l.b.children.length) throw bad('divider');
      turnRow(l, a);
      return null;
    } },
  // すぐ下（afterId があればその行の後ろ・'' は頭・parentId は Alt で中へ）に子孫ごと新しい ID で写す → { blockId: 写し }
  'block.duplicate': { args: { blockId: 'id', afterId: 'idOrEmpty?', parentId: 'id?' },
    run: (d, a, nid) => {
      const l = BT.locate(d, a.blockId);
      if (!l) return null;
      const after = a.afterId === undefined ? a.blockId : a.afterId;
      if (after !== '' && !BT.locate(d, after)) throw bad('afterId');
      const copy = { ...clone(l.b), id: nid() };
      for (const x of BT.flattenBlocks(copy.children)) x.id = nid();
      const s = BT.spotOf(d, after, a.parentId);
      if (!s) throw bad('afterId');
      s.list.splice(s.index, 0, copy);
      return { blockId: copy.id };
    } },
  // ‡131 字下げ（in は前の兄弟の子の末尾へ・out は親のすぐ後ろへ。できなければ何もしない）
  'block.indent': { args: { blockId: 'id', dir: 'dir' },
    run: (d, a) => {
      const plan = BT.indentPlan(d, a.blockId, a.dir);
      if (!plan) return null;
      const l = BT.locate(d, a.blockId);
      const [m] = l.list.splice(l.index, 1);
      const s = BT.spotOf(d, plan.afterId, plan.parentId === null ? undefined : plan.parentId);
      s.list.splice(s.index, 0, m);
      return null;
    } },
  'block.paste': { args: { blockId: 'id', rich: 'richArg', at: 'offset', blocks: 'pasteBlocks', afterId: 'idOrEmpty?', inside: 'bool?' },
    run: (d, a, nid) => {
      const lastId = pasteInto(d, a, nid);
      return lastId === null ? null : { lastId };
    } },
  // 行（ブロック）の色（親の色は子孫にも付ける・外す）
  'blocks.setColor': { args: { ids: 'ids', color: 'blockColor' },
    run: (d, a) => {
      for (const top of pickRoots(d, a.ids)) {
        for (const x of BT.flattenBlocks([top])) { if (a.color) x.color = a.color; else delete x.color; }
      }
      return null;
    } },
  'blocks.remove': { args: { ids: 'ids' },
    run: (d, a) => { takeOut(d, pickRoots(d, a.ids)); return null; } },
  'blocks.move': { args: { ids: 'ids', afterId: 'idOrEmpty', parentId: 'id?' },
    run: (d, a) => {
      const roots = pickRoots(d, a.ids);
      takeOut(d, roots);
      const s = BT.spotOf(d, a.afterId, a.parentId);
      if (!s) throw bad('afterId');
      s.list.splice(s.index, 0, ...roots);
      return null;
    } },
  // 選んだ行を子孫ごと新しい ID で写す（既定は最後に選んだ行の後ろ）→ { ids: [写しの行] }
  'blocks.duplicate': { args: { ids: 'ids', afterId: 'idOrEmpty?', parentId: 'id?' },
    run: (d, a, nid) => {
      const roots = pickRoots(d, a.ids);
      const after = a.afterId === undefined ? roots[roots.length - 1].id : a.afterId;
      if (after !== '' && !BT.locate(d, after)) throw bad('afterId');
      const copies = roots.map((b) => {
        const c = clone(b);
        for (const x of BT.flattenBlocks([c])) x.id = nid();
        return c;
      });
      const s = BT.spotOf(d, after, a.parentId);
      if (!s) throw bad('afterId');
      s.list.splice(s.index, 0, ...copies);
      return { ids: copies.map((c) => c.id) };
    } },
  // 選んだ行の型を変える（区切り線へは文も子も無い行だけ。1つでもあれば全部を断る）
  'blocks.turnInto': { args: { ids: 'ids', type: 'blockType', level: 'level?', toggle: 'bool?' },
    run: (d, a) => {
      if (!a.ids.length) throw bad('ids');
      const rows = [...new Set(a.ids)].map((id) => { const l = BT.locate(d, id); if (!l) throw bad('ids'); return l.b; });
      if (a.type === 'divider' && rows.some((b) => String(b.text || '') !== '')) throw bad('divider');
      if (a.type === 'divider' && rows.some((b) => Array.isArray(b.children) && b.children.length > 0)) throw bad('divider');
      for (const b of rows) turnRow(BT.locate(d, b.id), a);
      return null;
    } },
}));
const MEMO_COMMANDS = Object.freeze(Object.keys(CMDS));

// doc に命令 cmd（要約の命令と同じ名前）を当てる → { doc: 新しい doc, focus: 答えの行（DB の答えから page を除いた形）か null, next: 次に使ってよい ID の数 }。
// opts.next は前の答えの next（窓のメモリ。消した行の ID を使い回さない: R161）。
// 渡した doc は変えない。知らない命令・引数の形の悪いもの・断る直しは bad-args、上限（2,000 行・1MB・10 万字）を越えれば too-big で投げる
function memoEdit(doc, cmd, args, { next } = {}) {
  if (typeof cmd !== 'string' || !Object.hasOwn(CMDS, cmd)) throw bad('cmd');
  if (next !== undefined && !(Number.isSafeInteger(next) && next >= 1 && next <= NEXT_MAX)) throw bad('next');
  const def = CMDS[cmd];
  const chk = V.checkArgs(def.args, args);
  if (!chk.ok) throw bad(`args ${chk.field}`);
  const d = validateMemoDoc(doc);
  const ids = idMaker(d, next);
  const focus = def.run(d, chk.args, ids.nid);
  return { doc: validateMemoDoc(d), focus, next: ids.next() };
}

module.exports = { MEMO_COMMANDS, memoFromText, memoPlain, memoEdit, validateMemoDoc };
