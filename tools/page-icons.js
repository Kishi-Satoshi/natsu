#!/usr/bin/env node
'use strict';
// ページのアイコンの絵の表を、元の SVG から1回だけ書く道具（0.17.0 IG-1。計画 docs/plans/2026-11-13-170.md の決めたこと 6・8）。
//
//   node tools/page-icons.js   … src/pageIcons.js の名前の表（ICON_LIST）にある絵だけを、assets/page-icons/ の元の SVG から読み、
//                                 src/pageIconPaths.js と、src/renderer/app.html の写し（COPY_START と COPY_END の間）を書く
//
// 読めるのは、デジタル庁の「イラストレーション・アイコン素材」と Material Symbols の決まった形だけ:
//   - 要素は <svg>・<path>・切り抜きの <g clip-path>・<defs>・<clipPath>・<rect> だけ。属性も決まった物だけ
//   - 切り抜きは絵の全面（viewBox と同じ大きさ）の四角だけ（外しても絵が変わらない）。外して、表に残さない（id が同じ画面で重ならない）
//   - 色の指定（#rrggbb）は捨てる（画面で currentColor にする）。fill-rule="evenodd" は残す（穴が埋まらない）
//   - viewBox の無い絵は、width="24" height="24" の座標（0 0 24 24）として持つ
//   - path の d は、数と命令の字だけ。1字も変えない（丸めない）
// それ以外（script・use・image・style・foreignObject・href・on…・transform・知らない属性・文字）は、黙って飛ばすと絵や守りが変わるので投げる。
// 1つでも読めなければ、どのファイルも書かない（全部を先にメモリに作ってから書く）。npm の依存は使わない。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const VERSION = 1;
const SVG_NS = 'http://www.w3.org/2000/svg';
const COPY_START = '  // ---- pageIconPaths の写し';
const COPY_END = '  // ---- pageIconPaths の写しはここまで';

// 要素ごとに読める属性
const ATTRS = {
  svg: new Set(['xmlns', 'width', 'height', 'viewBox', 'fill']),
  g: new Set(['clip-path']),
  path: new Set(['d', 'fill', 'fill-rule', 'clip-rule']),
  defs: new Set([]),
  clipPath: new Set(['id']),
  rect: new Set(['width', 'height', 'fill']),
};
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const D_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/;
const NUM4_RE = /^-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? \d+(?:\.\d+)? \d+(?:\.\d+)?$/;

// 元の絵のファイル（リポジトリの根からの相対）
function fileOf(entry) {
  if (entry.src === 'dg') return `assets/page-icons/dg/${entry.id}_line.svg`;
  if (entry.src === 'ms') return `assets/page-icons/ms/${entry.id}_wght300_24px.svg`;
  throw new Error(`${entry.id}: 知らない出どころ（${entry.src}）`);
}

function attrsOf(src, tag, where) {
  const out = {};
  const rest = src.replace(/([\w:-]+)\s*=\s*"([^"]*)"/g, (_, k, v) => {
    if (!ATTRS[tag].has(k)) throw new Error(`${where}: <${tag}> の属性 ${k} は読めない`);
    if (Object.hasOwn(out, k)) throw new Error(`${where}: <${tag}> の属性 ${k} が2つ`);
    out[k] = v;
    return ' ';
  });
  if (rest.replace(/\/\s*$/, '').trim()) throw new Error(`${where}: <${tag}> の属性を読めない（${rest.trim()}）`);
  return out;
}

// 1つの SVG の文字を読み → { vb, p: [[d] | [d, 1]] }
function parseIconSvg(text, where = 'svg') {
  const src = String(text);
  const tags = [];
  let last = 0;
  for (const m of src.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g)) {
    if (src.slice(last, m.index).trim()) throw new Error(`${where}: 要素の外に文字がある（${src.slice(last, m.index).trim().slice(0, 20)}）`);
    last = m.index + m[0].length;
    const tag = m[2];
    if (!Object.hasOwn(ATTRS, tag)) throw new Error(`${where}: <${tag}> は読めない`);
    tags.push({ close: m[1] === '/', tag, attrs: m[1] ? {} : attrsOf(m[3], tag, where), self: m[4] === '/' });
  }
  if (src.slice(last).trim()) throw new Error(`${where}: 要素の外に文字がある`);
  if (/<[!?]/.test(src)) throw new Error(`${where}: 宣言や注釈は読めない`);
  // 入れ子を照らす: svg > (g[clip-path] > path+ | path+) と defs > clipPath > rect
  const stack = [];
  let svg = null;
  const paths = [];
  const clips = new Set();
  const used = new Set();
  let clipId = null;
  for (const t of tags) {
    if (t.close) {
      const top = stack.pop();
      if (!top || top.tag !== t.tag) throw new Error(`${where}: </${t.tag}> の相手が無い`);
      if (t.tag === 'clipPath') clipId = null;
      continue;
    }
    const parent = stack.length ? stack[stack.length - 1].tag : null;
    const allowed = { svg: [null], g: ['svg'], path: ['svg', 'g'], defs: ['svg'], clipPath: ['defs'], rect: ['clipPath'] }[t.tag];
    if (!allowed.includes(parent)) throw new Error(`${where}: <${t.tag}> は <${parent || '（根）'}> の中に置けない`);
    if (t.tag === 'svg') {
      if (svg) throw new Error(`${where}: <svg> が2つ`);
      svg = t.attrs;
      if (svg.xmlns !== SVG_NS) throw new Error(`${where}: xmlns が違う`);
      if (svg.fill !== undefined && svg.fill !== 'none') throw new Error(`${where}: <svg> の fill は none だけ`);
    } else if (t.tag === 'g') {
      const m = /^url\(#([\w-]+)\)$/.exec(t.attrs['clip-path'] || '');
      if (!m) throw new Error(`${where}: <g> は切り抜きだけ`);
      used.add(m[1]);
    } else if (t.tag === 'path') {
      const a = t.attrs;
      if (typeof a.d !== 'string' || !a.d.trim() || !D_RE.test(a.d)) throw new Error(`${where}: d を読めない`);
      if (a.fill !== undefined && !COLOR_RE.test(a.fill)) throw new Error(`${where}: path の色は #rrggbb だけ（${a.fill}）`);
      for (const k of ['fill-rule', 'clip-rule']) if (a[k] !== undefined && a[k] !== 'evenodd' && a[k] !== 'nonzero') throw new Error(`${where}: ${k} が読めない（${a[k]}）`);
      paths.push(a['fill-rule'] === 'evenodd' ? [a.d, 1] : [a.d]);
    } else if (t.tag === 'clipPath') {
      if (!t.attrs.id) throw new Error(`${where}: clipPath に id が無い`);
      clipId = t.attrs.id;
    } else if (t.tag === 'rect') {
      const a = t.attrs;
      if (a.fill !== undefined && a.fill !== 'white' && !COLOR_RE.test(a.fill)) throw new Error(`${where}: rect の色を読めない`);
      clips.add(`${clipId}\u0000${a.width}\u0000${a.height}`);
    }
    if (!t.self) stack.push(t);
  }
  if (stack.length) throw new Error(`${where}: <${stack[stack.length - 1].tag}> が閉じていない`);
  if (!svg) throw new Error(`${where}: <svg> が無い`);
  if (!paths.length) throw new Error(`${where}: path が無い`);
  let vb = svg.viewBox;
  if (vb === undefined) {
    if (svg.width !== '24' || svg.height !== '24') throw new Error(`${where}: viewBox が無く、24 の大きさでもない`);
    vb = '0 0 24 24';
  }
  if (!NUM4_RE.test(vb)) throw new Error(`${where}: viewBox を読めない（${vb}）`);
  // 切り抜きは絵の全面の四角だけ（外しても絵が変わらない）
  const [, , w, h] = vb.split(' ');
  for (const id of used) if (!clips.has(`${id}\u0000${w}\u0000${h}`)) throw new Error(`${where}: 切り抜き ${id} が絵の全面でない`);
  return { vb, p: paths };
}

// 名前の表（[{ id, src }]）の絵を元の SVG から読む → { v, icons: { <名前>: { src, vb, p, sha } } }（純粋。readFile(rel) は Buffer か文字）
function buildPaths(list, readFile) {
  const icons = {};
  for (const entry of list) {
    const rel = fileOf(entry);
    const raw = readFile(rel);
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    const { vb, p } = parseIconSvg(buf.toString('utf8'), rel);
    icons[entry.id] = { src: entry.src, vb, p, sha: crypto.createHash('sha256').update(buf).digest('hex') };
  }
  return { v: VERSION, icons };
}

// 表の行（1つの絵が1行）。src/pageIconPaths.js と app.html の写しで同じ字
function tableLines(table) {
  return Object.entries(table.icons).map(([id, x]) => `${JSON.stringify(id)}: ${JSON.stringify(x)},`);
}

function renderModule(table) {
  return [
    "'use strict';",
    '// ページのアイコンの絵の表（0.17.0 IG-1）。tools/page-icons.js が assets/page-icons/ の元の SVG から書いた物で、手で直さない。',
    '// { v, icons: { <名前>: { src: 出どころ（dg: デジタル庁・ms: Material Symbols）, vb: viewBox, p: [[d, evenodd なら 1]], sha: 元のファイルの sha256 } } }',
    '// 出典と加工の内容は src/licenses/page-icons.txt。test/stage170.icons.lib.test.js が元の絵から作り直して1字も同じかを見る',
    'const freeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === \'object\') freeze(v); return Object.freeze(o); };',
    `module.exports = freeze({ v: ${table.v}, icons: Object.assign(Object.create(null), {`,
    ...tableLines(table).map((l) => `  ${l}`),
    '}) });',
    '',
  ].join('\n');
}

function renderCopy(table) {
  return [
    `${COPY_START}（0.17.0 IG-1。tools/page-icons.js が書く。手で直さない。src/pageIconPaths.js と同じ表。test/stage170.icons.lib.test.js が照らす）`,
    '  const pageIconPaths = (() => {',
    '    const freeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === \'object\') freeze(v); return Object.freeze(o); };',
    `    return freeze({ v: ${table.v}, icons: Object.assign(Object.create(null), {`,
    ...tableLines(table).map((l) => `      ${l}`),
    '    }) });',
    '  })();',
    COPY_END,
  ].join('\n');
}

// 全部を作ってから書く（1つでも読めなければ何も書かない）
function writeAll(root = ROOT) {
  const { ICON_LIST } = require(path.join(root, 'src', 'pageIcons.js'));
  const table = buildPaths(ICON_LIST, (rel) => fs.readFileSync(path.join(root, rel)));
  const htmlFile = path.join(root, 'src', 'renderer', 'app.html');
  const html = fs.readFileSync(htmlFile, 'utf8');
  const at = html.indexOf(COPY_START);
  const end = html.indexOf(COPY_END, at);
  const count = (s) => html.split(s).length - 1;   // COPY_START は COPY_END の頭でもある
  if (at < 0 || end < 0 || count(COPY_END) !== 1 || count(COPY_START) !== 2) throw new Error('app.html に写しの区切りがちょうど1組無い');
  const nextHtml = html.slice(0, at) + renderCopy(table) + html.slice(end + COPY_END.length);
  const mod = renderModule(table);
  fs.writeFileSync(path.join(root, 'src', 'pageIconPaths.js'), mod);
  if (nextHtml !== html) fs.writeFileSync(htmlFile, nextHtml);
  return { icons: Object.keys(table.icons).length, bytes: Object.values(table.icons).reduce((n, x) => n + x.p.reduce((m, q) => m + q[0].length, 0), 0) };
}

module.exports = { VERSION, COPY_START, COPY_END, fileOf, parseIconSvg, buildPaths, renderModule, renderCopy, writeAll };

if (require.main === module) {
  const r = writeAll();
  process.stdout.write(`絵 ${r.icons}・d の文字 ${r.bytes} 字を書いた\n`);
}
