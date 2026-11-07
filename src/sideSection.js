'use strict';
// サイドバーのセクション（「プライベート」）とライブラリの純粋な部品（0.15.1 Task PS-1。計画 docs/plans/2026-11-04-151.md の
// 決めたこと 23・24・30・34・35・38・D124・D125）。DB も Electron も読まない。画面（app.html）は写しを持つ（PS-2 から。src/pageTree.js の写しと同じ形）。
//   SECTION_DEFAULT・SORTS・SHOW_STEPS … 見出しの畳み（open）・並べ替え（sort: manual・edited）・表示の数（show: 0 はすべて・5〜20）の既定と決まった値
//   normSections(raw)       … 窓の覚え書きの sections を項目ごとに照らす（壊れた項目だけ既定に戻す・後の版のセクションは読まずに残す）
//   sectionRows(tree, open, { sort, show }) … サイドバーの木の見えている行（並べ替えと表示の数を当てる）と、出していないいちばん上の行の数
//   relTime(iso, now)・stampText(iso) … 最終更新日時の相対の言い方と、年/月/日 時:分
//   libraryRows(tree, opts) … ライブラリの表の行（列で並べ替え・語で絞る・開け閉め）
//   oneLineTitle(s)         … 名前を1行に（改行・タブを空白に・前後の空白を落とす）
// tree は src/pageTree.js の pageTree(rows) の答え（roots・kids・parent・byId）。行の updatedAt は一覧の行のもの（DB の読みを足さない: 決めたこと 39）。

const SECTION_DEFAULT = Object.freeze({ open: true, sort: 'manual', show: 0 });
const SORTS = Object.freeze(['manual', 'edited']);
const SHOW_STEPS = Object.freeze([0, 5, 10, 15, 20]);
// 後の版のセクション（第17回のお気に入り・共有など）: 形の正しい名前で、中身が真偽・有限の数・40 字までの文字だけの 10 項目までの組なら、読まずに残す
const SECTION_NAME_RE = /^[a-z]{1,20}$/;
const SECTIONS_MAX = 10;
const ITEMS_MAX = 10;
const TEXT_MAX = 40;

const isObj = (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

// プライベートの3つの項目を1つずつ照らす（壊れた項目だけ既定に戻す: 持ち主の試作の state-store.js の「項目ごとの検証器」の考え）
function normPrivate(p) {
  const src = isObj(p) ? p : {};
  return {
    open: typeof src.open === 'boolean' ? src.open : SECTION_DEFAULT.open,
    sort: SORTS.includes(src.sort) ? src.sort : SECTION_DEFAULT.sort,
    show: SHOW_STEPS.includes(src.show) ? src.show : SECTION_DEFAULT.show,
  };
}
function laterOk(v) {
  if (!isObj(v)) return false;
  const ks = Object.keys(v);
  if (ks.length > ITEMS_MAX) return false;
  return ks.every((k) => {
    const x = v[k];
    return typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.length <= TEXT_MAX);
  });
}
const samePrivate = (a, b) => isObj(b) && Object.keys(b).length === 3 && a.open === b.open && a.sort === b.sort && a.show === b.show;

// raw → { sections, repaired }。private は無ければ既定（直したことにしない）。セクションは private を入れて 10 まで（11 個目から落とす）
function normSections(raw) {
  const src = isObj(raw) ? raw : {};
  const sections = { private: normPrivate(src.private) };
  let repaired = raw !== undefined && !isObj(raw);
  if (Object.hasOwn(src, 'private') && !samePrivate(sections.private, src.private)) repaired = true;
  let n = 1;
  for (const k of Object.keys(src)) {
    if (k === 'private') continue;
    if (n >= SECTIONS_MAX || !SECTION_NAME_RE.test(k) || !laterOk(src[k])) { repaired = true; continue; }
    sections[k] = { ...src[k] };
    n += 1;
  }
  return { sections, repaired };
}

const kidsIn = (tree, id) => (tree && tree.kids && tree.kids.has(id) ? tree.kids.get(id) : []);
const rowOf = (tree, id) => (tree && tree.byId && tree.byId.has(id) ? tree.byId.get(id) : null);
// ページの最終更新（題名・本文・要約・メモを書いた時）。読めなければいちばん古い扱い
function editedAt(tree, id) {
  const r = rowOf(tree, id);
  const t = r && typeof r.updatedAt === 'string' ? Date.parse(r.updatedAt) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}
// 兄弟の中だけで並べ替える（木の形は変えない）。同じなら元の（手動の）並び
function orderBy(ids, cmp) {
  return ids.map((id, i) => ({ id, i })).sort((a, b) => cmp(a.id, b.id) || a.i - b.i).map((x) => x.id);
}

// 見えている行 → { rows: [{ id, depth, hasKids, open }], hidden }（0.15.0 の pageTree.visibleRows と同じ形の行）。
// sort: 'edited' はどの段も兄弟を最終更新の新しい順に。show はいちばん上の段の数だけ（開いた子は数えずに親の下に出す）
function sectionRows(tree, open, opts = {}) {
  const isOpen = (id) => Boolean(open && typeof open.has === 'function' && open.has(id));
  const edited = opts && opts.sort === 'edited';
  const order = (ids) => (edited ? orderBy(ids, (a, b) => editedAt(tree, b) - editedAt(tree, a)) : ids);
  const limit = opts && SHOW_STEPS.includes(opts.show) ? opts.show : 0;
  const roots = order(tree && Array.isArray(tree.roots) ? tree.roots : []);
  const shown = limit ? roots.slice(0, limit) : roots;
  const out = [];
  const seen = new Set();
  const stack = [...shown].reverse().map((id) => ({ id, depth: 0 }));
  while (stack.length) {
    const { id, depth } = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const ks = kidsIn(tree, id);
    const hasKids = ks.length > 0;
    const opened = hasKids && isOpen(id);
    out.push({ id, depth, hasKids, open: opened });
    if (!opened) continue;
    const kids = order(ks);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i], depth: depth + 1 });
  }
  return { rows: out, hidden: roots.length - shown.length };
}

// 最終更新日時の言い方（決めたこと 34）。1分より前は「たった今」、1時間より前は「n 分前」、1日より前は「n 時間前」、7日より前は「n 日前」、
// 5週より前は「n 週間前」、それより前は「2026/09/30」（その PC の暦）。未来の日時は「たった今」。読めない値は ''
const pad2 = (n) => String(n).padStart(2, '0');
function ymd(t) {
  const d = new Date(t);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}
function relTime(iso, now) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  const n = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return '';
  const s = Math.floor((n - t) / 1000);
  if (s < 60) return 'たった今';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 時間前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 日前`;
  if (d < 35) return `${Math.floor(d / 7)} 週間前`;
  return ymd(t);
}
// 年/月/日 時:分（行のメニューの「最終更新」・ライブラリの日時の title）。読めない値は ''
function stampText(iso) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${ymd(t)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 探す語と題名を寄せる（全角と半角: NFKC・英字の大小・カタカナをひらがなに・空白を除く。画面のアイコンの選びの fold と同じ寄せ方）
function kanaFold(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/\s+/g, '');
}
// 題名の五十音（決めたこと 34）
const COLLATOR = new Intl.Collator('ja');

// ライブラリの表の行 → [{ id, depth, hasKids, open, place? }]。
// opts: col（'' は手動の並び・'title' はページ名・'edited' は最終更新日時）・dir（'asc'・'desc'）・q（探す語）・open（開いている ID の Set）・
// titleOf(id)（一覧と同じ名前）・fold（寄せ方。既定 kanaFold）。並べ替えは兄弟の中だけ（木の形は変えない）。語があれば木を崩し、題名に語を含む
// ページだけを並べて place（場所: 祖先の名前を「 / 」でつなぐ。最上位は ''）を付ける
function libraryRows(tree, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const titleOf = typeof o.titleOf === 'function' ? o.titleOf : () => '';
  const fold = typeof o.fold === 'function' ? o.fold : kanaFold;
  const sign = o.dir === 'desc' ? -1 : 1;
  let cmp = null;
  if (o.col === 'title') {
    const key = new Map();
    const t = (id) => { if (!key.has(id)) key.set(id, String(titleOf(id) ?? '')); return key.get(id); };
    cmp = (a, b) => sign * COLLATOR.compare(t(a), t(b));
  } else if (o.col === 'edited') {
    cmp = (a, b) => sign * (editedAt(tree, a) - editedAt(tree, b));
  }
  const order = (ids) => (cmp ? orderBy(ids, cmp) : ids);
  const roots = order(tree && Array.isArray(tree.roots) ? tree.roots : []);
  const q = fold(o.q);
  const out = [];
  const seen = new Set();
  if (q) {
    // 語で絞る: 木を手動の並びで歩いて当たる行を集め、並べ替えの列があればその順に（木を崩す）
    const hits = [];
    const stack = [...roots].reverse();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      if (fold(titleOf(id)).includes(q)) hits.push(id);
      const ks = order(kidsIn(tree, id));
      for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]);
    }
    for (const id of cmp ? orderBy(hits, cmp) : hits) {
      out.push({ id, depth: 0, hasKids: kidsIn(tree, id).length > 0, open: false, place: placeOf(tree, titleOf, id) });
    }
    return out;
  }
  const isOpen = (id) => Boolean(o.open && typeof o.open.has === 'function' && o.open.has(id));
  const stack = [...roots].reverse().map((id) => ({ id, depth: 0 }));
  while (stack.length) {
    const { id, depth } = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const ks = kidsIn(tree, id);
    const hasKids = ks.length > 0;
    const opened = hasKids && isOpen(id);
    out.push({ id, depth, hasKids, open: opened });
    if (!opened) continue;
    const kids = order(ks);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i], depth: depth + 1 });
  }
  return out;
}
// 祖先の名前を根から「 / 」でつなぐ（5 段より深ければ頭を「…」に。pageTree.placeText と同じ形。輪でも止まる）
function placeOf(tree, titleOf, id, max = 5) {
  const ids = [];
  const seen = new Set([id]);
  const parent = tree && tree.parent;
  for (let cur = parent && parent.get(id) != null ? parent.get(id) : null; cur !== null && !seen.has(cur); cur = parent.get(cur) ?? null) {
    seen.add(cur);
    ids.push(cur);
  }
  ids.reverse();
  if (!ids.length) return '';
  const shown = ids.length > max ? ids.slice(ids.length - max) : ids;
  const parts = shown.map((x) => String(titleOf(x) ?? ''));
  return (ids.length > max ? ['…', ...parts] : parts).join(' / ');
}

// 名前を1行に（決めたこと 30）: 改行・タブ（と続いたもの）を1つの空白にし、前後の空白を落とす
function oneLineTitle(s) {
  return String(s ?? '').replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ').trim();
}

module.exports = {
  SECTION_DEFAULT, SORTS, SHOW_STEPS, normSections, sectionRows, relTime, stampText, kanaFold, libraryRows, oneLineTitle,
};
