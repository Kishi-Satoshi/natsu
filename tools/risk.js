#!/usr/bin/env node
'use strict';
// 変更の危険度ゲート。コミット前／リリース前に、変更を「前の版」と突き合わせて
// 危険な変更を機械的に止め、実機確認が要る変更には手順を強制する。
//
//   node tools/risk.js                      … HEAD と作業ツリーを比べる
//   node tools/risk.js --base A --head B     … 任意の2版を比べる（過去の検証用）
//   node tools/risk.js --checklist out.md    … 実機確認チェックリストを書き出す
//   node tools/risk.js --base-tag ...        … 直近のタグを基準にする（リリース時）
//
// 設計の柱は「新しく壊れたものだけを見る」こと。前の版で既に違反しているものは
// 報告しない。これで、既存の動的生成や設計上の例外に対する誤検知が構造的に出ない。

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const H = require('./lib/htmltree');
const St = require('./lib/style');
const MINES = require('./lib/mines');
const MOVES = require('./lib/moves');

const ROOT = path.resolve(__dirname, '..');
// git の stderr は画面に流さず、受け取っておく。基準の版に無いファイルを読むと fatal の行が出て、
// BLOCK 0 でもリリースのゲートの記録では失敗に見える（失敗したときは、例外の文に stderr が入る）
const git = (a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
// rev: null=作業ツリー / 'INDEX'=コミット予定の内容 / それ以外=git の版
const at = (rev, f) => {
  try {
    if (rev === null) return fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (rev === 'INDEX') return git(['show', `:${f}`]);
    return git(['show', `${rev}:${f}`]);
  } catch { return null; }
};

let F = [];
const add = (level, rule, file, msg, how) => F.push({ level, rule, file, msg, how });

// ---------- HTML: 木の健全さ / 要素の消失 / 枠からの離脱 / 参照の破れ ----------
const idsOf = (root) => new Map(H.elements(root).filter((n) => n.attrs.id).map((n) => [n.attrs.id, n]));
// script が静的に名指ししている id
function refIds(html) {
  const s = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const out = new Set();
  for (const m of s.matchAll(/\$\(\s*'([^']+)'\s*\)|getElementById\(\s*'([^']+)'\s*\)|querySelector\(\s*'#([\w-]+)'\s*\)/g)) out.add(m[1] || m[2] || m[3]);
  return out;
}
// 「枠」＝身元のある祖先（id か class を持つ要素）。無名の <div> は枠と見なさない。
// 枠から出たかどうかだけを見るので、兄弟の入れ替えや、包み直し（祖先が増える）では鳴らない。
const framesOf = (n) => H.ancestors(n).filter((a) => a.attrs.id || H.cls(a).length);
function lostFrames(bn, hn) {
  const ha = H.ancestors(hn);
  const out = [];
  for (const a of framesOf(bn)) {
    const same = ha.some((x) => a.attrs.id
      ? x.attrs.id === a.attrs.id
      : (x.tag === a.tag && H.cls(a).some((c) => H.cls(x).includes(c))));
    if (!same) out.push(H.label(a));
  }
  return out;
}

/** HTML の指摘（木の破損・要素の消失・枠からの離脱／意図した移動・参照の破れ）を集めて返す（checkHtml を外から呼べる形にしたもの。analyze もこれを呼ぶ） */
function htmlFindings(file, before, after) {
  const keep = F;
  F = [];
  try { checkHtml(file, before, after); return F; } finally { F = keep; }
}

function checkHtml(file, before, after) {
  const b = before == null ? null : H.parse(before, file);
  const a = H.parse(after, file);
  const bErr = b ? b.errors.length : 0;
  if (a.errors.length > bErr) {
    for (const e of a.errors.slice(0, 8)) add('BLOCK', 'HTML-木の破損', file, `${e.kind === 'unclosed' ? '閉じ忘れ' : '相手のいない閉じタグ'} <${e.tag}> ${file}:${e.line}`, 'tools/hedit.js check で確認し、木として正しい形に直す');
    return;
  }
  if (!b) return;
  const bi = idsOf(b), ai = idsOf(a);
  const bref = refIds(before), aref = refIds(after);

  // (1) 要素の消失（v0.10.3 / v0.10.4 の型）
  for (const [id, n] of bi) {
    if (ai.has(id)) continue;
    const used = aref.has(id);
    add(used ? 'BLOCK' : 'WARN', 'HTML-要素の消失', file,
      `id="${id}"（${H.label(n)}、元 ${file}:${n.line}）が消えた${used ? '。画面のスクリプトはまだこの id を参照している → 初期化が例外で止まり、以降の結線が全て死ぬ' : ''}`,
      used ? '消すなら参照側も同時に消す。並べ替えの巻き添えなら tools/hedit.js order をやり直す' : '意図的なら、参照側も消えていることを確かめる');
  }
  // (2) 枠からの離脱（v0.10.2 の型）。祖先が「増えた」のは包み直しなので見ない。
  const groups = new Map();
  for (const [id, n] of bi) {
    const m = ai.get(id); if (!m) continue;
    const lost = lostFrames(n, m);
    if (!lost.length) continue;
    const key = lost.join(' / ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id, n, m });
  }
  for (const [lost, xs] of groups) {
    const s0 = xs[0];
    // 台帳（tools/lib/moves.js）にちょうど当たる組だけ、意図した移動として WARN にする（ファイル・失った枠の並び・id が全部台帳の中）
    const ok = MOVES.find((m) => m.file === file && m.lost.join(' / ') === lost && xs.every((x) => m.ids.includes(x.id)));
    if (ok) {
      add('WARN', '意図した移動', file,
        `${lost} の外へ出た要素が ${xs.length} 件（${xs.map((x) => '#' + x.id).join(', ')}）。台帳 tools/lib/moves.js の理由: ${ok.why}\n      元: ${H.chain(s0.n)}\n      後: ${H.chain(s0.m)}`,
        'WARN の id が台帳の id だけであることを目で確かめる。ほかの id が出たら commit しない');
      continue;
    }
    add('BLOCK', 'HTML-枠からの離脱', file,
      `${lost} の外へ出た要素が ${xs.length} 件（${xs.slice(0, 6).map((x) => '#' + x.id).join(', ')}${xs.length > 6 ? ' ほか' : ''}）\n      例 id="${s0.id}" ${file}:${s0.m.line}\n      元: ${H.chain(s0.n)}\n      後: ${H.chain(s0.m)}`,
      '文字位置で切り貼りすると閉じタグが道連れになる。tools/hedit.js move / order を使う');
  }
  // (3) 参照の破れ（前の版では解決していた参照だけを見る＝動的生成の誤検知が出ない）
  for (const id of aref) {
    if (ai.has(id) || !bi.has(id) || !bref.has(id)) continue;
    add('BLOCK', 'HTML-参照の破れ', file, `スクリプトが参照する id="${id}" が HTML から無くなった`, '要素を戻すか、参照側を消す');
  }
}

// ---------- main.js: 透過ウィンドウの地雷 ----------
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ');
function windows(mainSrc) {
  const src = stripJs(mainSrc);
  const out = [];
  for (const m of src.matchAll(/new BrowserWindow\(\s*\{/g)) {
    let i = m.index + m[0].length - 1, d = 0, j = i;
    for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break; } }
    const body = src.slice(i + 1, j);
    const opts = {};
    let depth = 0, key = null, buf = '', k = 0;
    for (let p = 0; p < body.length; p++) {
      const c = body[p];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
      if (!depth && c === ':' && key === null) { key = buf.trim(); buf = ''; continue; }
      if (!depth && c === ',') { if (key) opts[key] = buf.trim(); key = null; buf = ''; continue; }
      buf += c;
    }
    if (key) opts[key] = buf.trim();
    // webPreferences の中も同じ平面に載せる（backgroundThrottling はここに入る）
    const wp = opts.webPreferences;
    if (wp && wp.includes('{')) {
      const inner = wp.slice(wp.indexOf('{') + 1, wp.lastIndexOf('}'));
      let d2 = 0, k2 = null, b2 = '';
      const flush = () => { if (k2) opts[k2.trim()] = b2.trim(); k2 = null; b2 = ''; };
      for (let p2 = 0; p2 < inner.length; p2++) {
        const c = inner[p2];
        if (c === '{' || c === '(' || c === '[') d2++;
        else if (c === '}' || c === ')' || c === ']') d2--;
        if (!d2 && c === ':' && k2 === null) { k2 = b2; b2 = ''; continue; }
        if (!d2 && c === ',') { flush(); continue; }
        b2 += c;
      }
      flush();
    }
    // この窓が読み込む HTML
    const after = src.slice(j, j + 2000);
    const lf = /loadFile\([^)]*'([\w.]+\.html)'/.exec(after);
    out.push({ opts, html: lf ? lf[1] : null, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}
function mineHits(win, htmlSrc) {
  const hits = [];
  if (String(win.opts.transparent).trim() !== 'true') return hits;
  for (const r of MINES.windowOpts) {
    const v = win.opts[r.key];
    if (r.key === 'transparent') continue;
    if (v === undefined) { if (r.key === 'hasShadow') hits.push({ what: `hasShadow が未指定`, why: r.why, seen: r.seen }); continue; }
    if (r.bad(String(v))) hits.push({ what: `${r.key}: ${v}`, why: r.why, seen: r.seen });
  }
  if (htmlSrc) {
    for (const rule of St.rules(St.styleOf(htmlSrc))) {
      if (rule.at) continue; // @keyframes 等は窓の矩形に落ちない
      for (const r of MINES.css) {
        const v = rule.decls[r.prop];
        if (v !== undefined && r.bad(v)) hits.push({ what: `${rule.sel} { ${r.prop}: ${v} }`, why: r.why, seen: r.seen });
      }
    }
  }
  return hits;
}

// ---------- 地とインクの向き ----------
function inkFindings(htmlSrc) {
  if (!htmlSrc) return [];
  const rules = St.rules(St.styleOf(htmlSrc));
  const pill = rules.find((r) => r.sel === '.pill');
  if (!pill || !pill.decls.background) return [];
  const g = St.colorsIn(pill.decls.background)[0];
  if (!g) return [];
  const gl = St.lum(g);
  const dark = gl < 0.18;
  const out = [];
  const test = (label, c) => {
    const l = St.lum(St.over(c, g));
    if (dark ? l <= gl + 0.02 : l >= gl - 0.02) out.push(`${label}（地の輝度 ${gl.toFixed(3)} に対し ${l.toFixed(3)}。${dark ? '暗い地に暗いインク' : '明るい地に明るいインク'}）`);
  };
  const js = [...htmlSrc.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  for (const m of stripJs(js).matchAll(/(fillStyle|strokeStyle)\s*=\s*([^;\n]+)/g))
    for (const c of St.colorsIn(m[2])) test(`${m[1]} = ${m[2].trim().slice(0, 60)}`, c);
  for (const r of rules) {
    if (r.at) continue;
    for (const p of ['color', 'border-top-color']) {
      const v = r.decls[p]; if (!v) continue;
      for (const c of St.colorsIn(v)) test(`${r.sel} { ${p}: ${v} }`, c);
    }
  }
  return out;
}

// ---------- 配布物（.ps1） ----------
function checkPs1(rev) {
  const files = git(['ls-files']).split('\n').filter((f) => f.endsWith('.ps1'));
  for (const f of files) {
    let buf;
    try {
      buf = rev === null ? fs.readFileSync(path.join(ROOT, f))
        : execFileSync('git', ['show', rev === 'INDEX' ? `:${f}` : `${rev}:${f}`], { cwd: ROOT, maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { continue; } // 基準の版に無い .ps1（後で足したもの）は読めないので見ない。git の fatal の行は画面に出さない
    if (!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf))
      add('BLOCK', '配布-ps1', f, 'BOM が無い。PowerShell 5.1 が Shift-JIS と誤読して構文エラーになる', 'tools/write-ps1.js を通して書き出す');
  }
  // 生成器を通さずに .ps1 を書いているコードが無いこと
  for (const f of git(['ls-files']).split('\n').filter((x) => /\.(js|cjs|mjs)$/.test(x) && !x.startsWith('tools/write-ps1'))) {
    const s = at(rev, f) || '';
    if (/writeFileSync\([^)]*\.ps1/.test(stripJs(s)))
      add('BLOCK', '配布-ps1', f, '.ps1 を直接書き出している', 'tools/write-ps1.js の writePs1() を使う（BOM+CRLF を必ず付ける）');
  }
}

// ---------- 復旧の導線 ----------
function checkRecovery(mainSrc) {
  if (!mainSrc) return;
  const s = stripJs(mainSrc);
  for (const r of MINES.recovery)
    if (!r.mainPattern.test(s))
      add('BLOCK', '復旧の導線', 'src/main.js', `「${r.name}」への入口が main 側（トレイ／アプリメニュー）に無い。画面が1か所で倒れると復旧できなくなる`, 'Menu/Tray のテンプレートに、レンダラーを経由しない項目を足す');
}

// ---------- main 側の外向きの通信（グローバルの fetch。RF2） ----------
// Node の fetch は Windows のプロキシ・PAC・証明書のストアを使わない。会社のプロキシと
// SSL の検査の下では、外への通信は Electron の net（net.request／net.fetch）でしか通らない。
// 今ある 127.0.0.1 のエンジンへの呼び出しは fetch のままでよいので、第1引数の文字で数え、
// 前の版より増えた第1引数だけを報告する（同じ行の他の所を直しても鳴らない）。
const fetchTarget = (f) => /^src\/.*\.js$/.test(f) && !f.startsWith('src/renderer/');
// 呼び出しの括弧の中から、第1引数の文字を取る（括弧・文字列・` の入れ子を数え、外側の , か ) まで）
function firstArg(src, open) {
  let depth = 0, q = null, i = open + 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (!depth) break; depth--; }
    else if (c === ',' && !depth) break;
  }
  return src.slice(open + 1, i).replace(/\s+/g, ' ').trim();
}
// 127.0.0.1 のエンジンへの呼び出し（文字列の頭が http://127.0.0.1 で、その後が「:ポート（数字か ${…}。
// 足し算で作るなら空）」と道・? ・# か文字列の終わり）。:80@10.0.0.2 のような userinfo の @ は
// 本当のホストが別なので数える。足し算の後ろの文字（'…:' + port + '@…'）も見えないので、
// 第1引数のどこかに @ があれば許さない
const LOOPBACK_ARG = /^(['"`])http:\/\/127\.0\.0\.1(?::(?:\d+|\$\{[^}]*\})?)?(?=[/?#]|\1)/;
function fetchArgs(src) {
  const out = new Map();
  if (src == null) return out;
  const s = stripJs(src);
  // net.fetch・x.fetch は数えない。globalThis.fetch・global.fetch はグローバルの fetch なので数える
  for (const m of s.matchAll(/(?<![.\w$])(?:(?:globalThis|global)\s*\.\s*)?fetch\s*\(/g)) {
    const arg = firstArg(s, m.index + m[0].length - 1);
    if (LOOPBACK_ARG.test(arg) && !arg.includes('@')) continue;
    out.set(arg, (out.get(arg) || 0) + 1);
  }
  return out;
}
/** 前の版より数が増えた、外向きになりうるグローバルの fetch の第1引数（1つの第1引数ごとに1件） */
function fetchFindings(file, before, after) {
  if (!fetchTarget(file) || after == null) return [];
  const b = fetchArgs(before), a = fetchArgs(after);
  return [...a].filter(([arg, n]) => n > (b.get(arg) || 0)).map(([arg]) => arg);
}

// ---------- src の JSON の直書き（G8・JS5） ----------
// JSON のファイルは src/jsonfile.js の writeJsonFile だけで書く（一時ファイル・fsync・名前の変更の
// やり直し・読み取り専用の扱いを通すため）。1行の中に writeFileSync／writeFile の呼び出しと
// JSON.stringify( の両方がある行を数え、前の版より増えた行だけを報告する。WAV（spoolSegment）は
// JSON.stringify が無いので、記録の追記（appendFileSync）は writeFile でないので数えない。
const jsonWriteTarget = (f) => /^src\/.*\.js$/.test(f) && !f.startsWith('src/renderer/') && f !== 'src/jsonfile.js';
/** 注釈を落とした文字の、JSON を直接書く行（空白をつぶした文字 → 数） */
function jsonWriteLines(src) {
  const out = new Map();
  if (src == null) return out;
  for (const raw of stripJs(src).split('\n')) {
    if (!/(?<![\w$])(?:writeFileSync|writeFile)\s*\(/.test(raw) || !/JSON\.stringify\(/.test(raw)) continue;
    const line = raw.replace(/\s+/g, ' ').trim();
    out.set(line, (out.get(line) || 0) + 1);
  }
  return out;
}
/** 前の版より数が増えた、JSON を直接書く行（1つの行ごとに1件） */
function jsonWriteFindings(file, before, after) {
  if (!jsonWriteTarget(file) || after == null) return [];
  const b = jsonWriteLines(before), a = jsonWriteLines(after);
  return [...a].filter(([line, n]) => n > (b.get(line) || 0)).map(([line]) => line);
}

// ---------- 外への送り方と Claude Code の呼び方（第1c回 OL8・G8） ----------
// Claude Code は利用者が入れてログインした claude をそのまま呼ぶ（--bare は OAuth のログインを読まない・
// ~/.claude/.credentials.json は読まない）。鍵は safeStorage の非同期の形だけで暗号にする（同期の形は
// Linux で平文の入れ物に落ちうる）。claude の子のプロセスは src/claude-cli.js だけが起こす（課金の変数を外した環境・
// shell なし・決まった引数を通すため）。src の足した行（注釈を落とした文字）を数え、前の版より増えた行だけを報告する。
// main.js の外への fetch( は「main の外向き通信」（fetchFindings）と loopbackOnlyFetch が受け持つ。
const onlineTarget = (f) => /^src\/.*\.js$/.test(f) && !f.startsWith('src/renderer/');
const ONLINE_RULES = [
  { re: /(?<![\w-])--bare(?![\w-])/, why: '--bare は OAuth のログインを読まない（各自の Claude のプランでなく API キーを求める）' },
  { re: /\.credentials\.json/, why: 'Claude Code の資格情報のファイルを NaTsu から触らない' },
  { re: /(?<![\w$])(?:encrypt|decrypt)String\s*\(/, why: 'safeStorage の同期の形（encryptString／decryptString）は使わない。非同期の形（…Async）だけ' },
  { re: /(?<![\w$])(?:spawn|spawnSync|execFile|execFileSync)\s*\(.*claude|claude.*(?<![\w$])(?:spawn|spawnSync|execFile|execFileSync)\s*\(/i,
    why: 'claude の子のプロセスは src/claude-cli.js だけが起こす（課金の変数を外した環境・shell なし・決まった引数）', only: (f) => f !== 'src/claude-cli.js' },
];
/** 注釈を落とした文字の、決まりに触れる行（空白をつぶした文字 → { n, why }） */
function onlineLines(file, src) {
  const out = new Map();
  if (src == null) return out;
  for (const raw of stripJs(src).split('\n')) {
    const hit = ONLINE_RULES.find((r) => (!r.only || r.only(file)) && r.re.test(raw));
    if (!hit) continue;
    const line = raw.replace(/\s+/g, ' ').trim();
    const cur = out.get(line);
    out.set(line, { n: (cur ? cur.n : 0) + 1, why: hit.why });
  }
  return out;
}
/** 前の版より数が増えた、決まりに触れる行（1つの行ごとに1件。'行 — 理由' の文字） */
function onlineFindings(file, before, after) {
  if (!onlineTarget(file) || after == null) return [];
  const b = onlineLines(file, before), a = onlineLines(file, after);
  return [...a].filter(([line, x]) => x.n > ((b.get(line) || {}).n || 0)).map(([line, x]) => `${line} — ${x.why}`);
}

// ---------- 中継と直の送り先（第1d回 RL12・RF38・F6） ----------
// 文字起こしと確認コードは中継（relay/）を通し、PC から OpenAI・Groq・Resend へ直に送らない。鍵の見かけの文字は
// PC のコードにも中継にも出し方にも置かない（会社の鍵は Worker の秘密の欄だけ。D14）。中継は Web の標準の部品だけで書き、
// 記録は relay/log.mjs の logEvent（決まった欄だけ）を通す（RL1・RL7。test/relay-health.test.js の字面の照らしと同じ決まり）。
// 秘密の欄（ALLOWED_EMAIL_DOMAINS・MAIL_FROM）は利用者が Cloudflare の画面で入れ、中継と出し方は名前を読むだけ（会社のドメインを混ぜない）。
// 第1d回 G-3（作り替え。D18・F23）: チームの名前（<チーム>.cloudflareaccess.com）は Cloudflare の設定と Worker の秘密の欄（TEAM_DOMAIN）に
// だけ置き、src・中継・出し方には書かない（注釈の中も）。Access の秘密の欄（TEAM_DOMAIN・POLICY_AUD・CF_ACCESS_CLIENT_ID・
// CF_ACCESS_CLIENT_SECRET）は名前を読むだけ（ワークフローが同じ名前の GitHub の秘密を渡す行 `NAME: ${{ secrets.NAME }}` だけは通す）。
// 前の版より増えた行だけを報告する（ほかの決まりと同じ形）。
// ヘルプセンター H-5（G8・D18）: ヘルプの出し方（help-deploy と共通の部品 cf-api）も中継の出し方と同じ決まりを当てる。
// ヘルプの記事と資産（help/ の文字のファイル。書体と作った出力 help/dist は見ない）は公開のリポジトリにあるので、
// チームのドメインの字面・AUD のタグの見かけ（64 字の16進）・個人の Windows のパス・鍵の見かけを足すと止める。
const RELAY_DEPLOY = new Set(['tools/relay-deploy.js', '.github/workflows/relay-deploy.yml',
  'tools/help-deploy.js', 'tools/lib/cf-api.js', '.github/workflows/help-deploy.yml']);
const inSrc = (f) => f.startsWith('src/');
const inRelay = (f) => f.startsWith('relay/');
const inHelp = (f) => f.startsWith('help/') && !f.startsWith('help/dist/') && /\.(?:md|json|css|js|svg|txt)$/.test(f);
const relayTarget = (f) => inSrc(f) || inRelay(f) || RELAY_DEPLOY.has(f) || inHelp(f);
const HELP_PUBLIC = 'ヘルプの記事と資産は公開のリポジトリにある。チームの名前・AUD のタグ・個人の Windows のパスを書かない（<チームの名前> のように書く。D18）';
const WEB_ONLY = '中継は Web の標準の部品だけで書く（node: も require も Buffer も Workers では動かない。RL1）';
const RELAY_RULES = [
  { on: (f) => inSrc(f) && !f.startsWith('src/renderer/'), re: /api\.(?:openai|groq|resend)\.com/i,
    why: '文字起こしと確認コードは中継を通す。PC から直に送らない（RF38）' },
  // 注釈の中の鍵も漏れなので、この決まりだけは注釈を落とす前の行で見る。今の OpenAI の鍵は sk-proj-… なので - と _ も数える
  { raw: true, on: relayTarget, re: /(?<![\w-])(?:sk-|re_)[A-Za-z0-9_-]{20,}/,
    why: '鍵の見かけの文字。鍵は PC にもリポジトリにも置かない（会社の鍵は Worker の秘密の欄だけ。D14）' },
  { on: (f) => inRelay(f) && f !== 'relay/log.mjs', re: /\bconsole\./,
    why: '中継の記録は relay/log.mjs の logEvent だけで書く（決まった欄だけ。RL7）' },
  { on: inRelay, re: /from\s+['"]node:|import\s*\(\s*['"]node:|\brequire\s*\(/, why: WEB_ONLY },
  { on: inRelay, re: /\bBuffer\b/, why: WEB_ONLY },
  // 書く形: 欄の名前（引用符や角かっこの中でも）に : か = で値を置く・読めなかったときの既定の文字（|| と ?? の後の空でない文字）
  { on: (f) => inRelay(f) || RELAY_DEPLOY.has(f), re: /(?<![\w$])['"]?(?:ALLOWED_EMAIL_DOMAINS|MAIL_FROM)['"]?\s*\]?\s*(?:(?::|=(?![=>]))\s*\S|(?:\|\||\?\?)\s*(['"`])(?!\1))/,
    why: '秘密の欄（ALLOWED_EMAIL_DOMAINS・MAIL_FROM）は利用者が Cloudflare の画面で入れる。中継と出し方は名前を読むだけ（会社のドメインを混ぜない）' },
  // チームのドメインの字面（* や . で始まる照らし・<チーム>. の説明・文字の組や ? の後に \. を続けた照らしは当たらない）。正規表現に
  // \. で書いた名前（natsu-test\.cloudflareaccess\.com）は当たる。文字をつないで作った名前は字面では見えない（このゲートの限り。点検で見る）。
  // 注釈の中の名前も漏れなので、注釈を落とす前の行で見る
  { raw: true, on: relayTarget, re: /(?<![\w-])[a-z0-9-]+\\?\.cloudflareaccess\\?\.com/i,
    why: 'チームの名前（<チーム>.cloudflareaccess.com）は Cloudflare の設定と Worker の秘密の欄（TEAM_DOMAIN）にだけ置く（D18）' },
  // Access の秘密の欄に値を書く形（上の決まりと同じ形）。ワークフローが同じ名前の GitHub の秘密を渡す行（CF_ACCESS_CLIENT_* だけ）は通す
  { on: (f) => relayTarget(f) && !inHelp(f), re: /(?<![\w$])['"]?(TEAM_DOMAIN|POLICY_AUD|CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET)['"]?\s*\]?\s*(?:(?::|=(?![=>]))\s*\S|(?:\|\||\?\?)\s*(['"`])(?!\2))/,
    but: /^\s*(CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET):\s*\$\{\{\s*secrets\.\1\s*\}\}\s*$/,
    why: 'Access の秘密の欄（TEAM_DOMAIN・POLICY_AUD・CF_ACCESS_CLIENT_ID・CF_ACCESS_CLIENT_SECRET）は Cloudflare の画面と GitHub の環境 relay で入れる。名前を読むだけ（F23）' },
  // ヘルプの記事と資産だけ: AUD のタグの見かけ（ちょうど 64 字の16進）と個人の Windows のパス（<…> や %…% の置き換えの形は通す）
  { raw: true, on: inHelp, re: /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i, why: `64 字の16進（AUD のタグの見かけ）。${HELP_PUBLIC}` },
  { raw: true, on: inHelp, re: /\b[A-Za-z]:\\{1,2}Users\\{1,2}(?![<%＜])[^\\\s"'`<>]+/i, why: `個人の Windows のパス。${HELP_PUBLIC}` },
];
// 注釈を落とした文字（JS は stripJs、YAML は # から後ろ。ほかはそのまま）。JS の } のすぐ後ろの // は注釈と見ない
// （逆引用符の `${scheme}//api.openai.com` の宛先を落とさないため。} の直後に空白なしで注釈を書いた行は、増えた行なら鳴りうる）
const relayStrip = (file, src) => /\.m?js$/.test(file) ? stripJs(src.replace(/\}\/\//g, '}\u0001\u0001')).replace(/\u0001\u0001/g, '//')
  : /\.ya?ml$/.test(file) ? src.replace(/(^|\s)#[^\n]*/g, '$1') : src;
/** 決まりに触れる行（'決まりの番号\t空白をつぶした文字' → { n, why }） */
function relayLines(file, src) {
  const out = new Map();
  if (src == null || src.includes('\0')) return out;
  const texts = { raw: src.split('\n'), stripped: relayStrip(file, src).split('\n') };
  RELAY_RULES.forEach((r, i) => {
    if (!r.on(file)) return;
    for (const raw of r.raw ? texts.raw : texts.stripped) {
      if (!r.re.test(raw) || (r.but && r.but.test(raw))) continue;
      const key = `${i}\t${raw.replace(/\s+/g, ' ').trim()}`;
      const cur = out.get(key);
      out.set(key, { n: (cur ? cur.n : 0) + 1, why: r.why });
    }
  });
  return out;
}
/** 前の版より数が増えた、決まりに触れる行（1つの行と決まりごとに1件。'行 — 理由' の文字） */
function relayFindings(file, before, after) {
  if (!relayTarget(file) || after == null) return [];
  const b = relayLines(file, before), a = relayLines(file, after);
  return [...a].filter(([k, x]) => x.n > ((b.get(k) || {}).n || 0)).map(([k, x]) => `${k.slice(k.indexOf('\t') + 1)} — ${x.why}`);
}

// ---------- 画面の HTML に入れる文字（0.14.0 EB-6・SEC2・F102・決めたこと 32・R68） ----------
// 他人の文字（貼った HTML・設定の文字・リンク）を innerHTML に入れない。innerHTML・outerHTML（= と +=）・insertAdjacentHTML の
// 2つ目の引数に入るのは、決まった文字（'…'・"…"・`…`）と数（数の字・${名前} の名前1つ）を + と ?: でつないだものだけ
// （?: の条件は入らないので何でもよい）。${…} の中は名前1つで、その名前のファイルの中の宣言と代入が全部数（数の字・Number()・
// parseInt()・parseFloat()・Math.…()・….length と、それを + - * / % || ?: でつないだもの）で、引数・取り出し・繰り返しの名前でも
// ないものだけ。式・関数の呼び出し・設定の文字は通さない（R68）。字は JS の字句で読む（注釈と文字の中の字は口にしない）。
// EB-6 直し（R121）: ||=・&&=・??= も口。HTML を要素にするほかの口（setHTMLUnsafe・setHTML・DOMParser・parseHTMLUnsafe・
// createContextualFragment・document.write・srcdoc）と、口の名前を隠す書き方（物の鍵の innerHTML:・文字の 'innerHTML'・
// 'inner' + 'HTML' のつなぎ・insertAdjacentHTML を呼ばずに取り出す）は、入れる値に関わらず外れ。….length は数と見なさない
// （物の length は何でも入る。数にするときは Number(….length)）。
const SINK_KW = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
const SINK_PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.',
  '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const ID_START = /[\p{L}_$]/u;
// 文字の中の \ の逃がし（i は \ の所）→ { v: 戻した字, end }。\u・\u{…}・\x を字に戻す（'\u0069nnerHTML' で口の名前を隠させない: EK-1 直し R125）
const ESC_ONE = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
function escAt(src, i) {
  const d = src[i + 1];
  if (d === undefined) return { v: '', end: i + 1 };
  if (d === '\n') return { v: '', end: i + 2 };
  if (d === '\r') return { v: '', end: src[i + 2] === '\n' ? i + 3 : i + 2 };
  let m;
  if (d === 'u' && (m = /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(i + 2, i + 10))) && parseInt(m[1], 16) <= 0x10ffff) return { v: String.fromCodePoint(parseInt(m[1], 16)), end: i + 2 + m[0].length };
  if (d === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) return { v: String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)), end: i + 6 };
  if (d === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) return { v: String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)), end: i + 4 };
  return { v: Object.hasOwn(ESC_ONE, d) && !(d === '0' && /[0-9]/.test(src[i + 2] || '')) ? ESC_ONE[d] : d, end: i + 2 };
}
const unesc = (raw) => { let v = ''; for (let i = 0; i < raw.length;) { if (raw[i] === '\\') { const e = escAt(raw, i); v += e.v; i = e.end; } else v += raw[i++]; } return v; };
const ID_PART = /[\p{L}\p{N}_$‌‍]/u;
/** JS の字句（{ t: 'id'|'num'|'str'|'tpl'|'re'|'p', v, line, at, end }。`…` は quasis と exprs（中の字句の並び）を持つ） */
function lexJs(src, start = 0, line = 1, inTpl = false) {
  const toks = [];
  const opens = [];   // 開いた ( [ { の字句の位置（閉じの字句の open に入れる）
  let i = start, depth = 0;
  // / が正規表現の頭か（割り算でないか）。if (…)・while (…)・for (…)・with (…) の後と、文の塊の } の後は正規表現（EB-6 直し: R121 (5)）
  const regexOk = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.t === 'id') return SINK_KW.has(p.v);
    if (p.t !== 'p') return false;
    if (p.v === ')') return p.open > 0 && isId(toks[p.open - 1], 'if', 'while', 'for', 'with');
    if (p.v === '}') {
      if (!(p.open >= 0)) return true;
      const b = toks[p.open - 1];
      return !b || (b.t === 'p' && [')', ';', '{', '}', '=>'].includes(b.v)) || isId(b, 'else', 'do', 'try', 'finally');
    }
    return !['++', '--', ']'].includes(p.v);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2), end = e < 0 ? src.length : e + 2;
      for (let j = i; j < end; j++) if (src[j] === '\n') line++;
      i = end; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1, v = '';
      const l0 = line;
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') { if (src[j + 1] === '\n') line++; const e = escAt(src, j); v += e.v; j = e.end; } else v += src[j++];
      }
      // 閉じない文字（改行で終わる）は改行を残す（次の行の番号がずれない: R121 (5)）
      const closed = src[j] === c;
      toks.push({ t: 'str', v, line: l0, at: i, end: closed ? j + 1 : j }); i = closed ? j + 1 : j; continue;
    }
    if (c === '`') {
      const tok = { t: 'tpl', quasis: [], exprs: [], line, at: i };
      let j = i + 1, q = '';
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') { if (src[j + 1] === '\n') line++; q += src.slice(j, j + 2); j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          tok.quasis.push(q); q = '';
          const r = lexJs(src, j + 2, line, true);
          tok.exprs.push(r.toks); line = r.line; j = r.end; continue;
        }
        if (src[j] === '\n') line++;
        q += src[j++];
      }
      tok.quasis.push(q); tok.end = j + 1; toks.push(tok); i = j + 1; continue;
    }
    if (c === '/' && regexOk()) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break;
        j++;
      }
      if (src[j] === '/') { j++; while (j < src.length && ID_PART.test(src[j])) j++; }   // 閉じない正規表現は改行を残す
      toks.push({ t: 're', v: src.slice(i, j), line, at: i, end: j }); i = j; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < src.length && /[\w.]/.test(src[j])) j++;
      toks.push({ t: 'num', v: src.slice(i, j), line, at: i, end: j }); i = j; continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), line, at: i, end: j }); i = j; continue;
    }
    if (inTpl && c === '{') depth++;
    if (inTpl && c === '}') { if (depth === 0) return { toks, end: i + 1, line }; depth--; }
    const p = SINK_PUNCT.find((s) => src.startsWith(s, i)) || c;
    const tok = { t: 'p', v: p, line, at: i, end: i + p.length };
    if (p === '(' || p === '[' || p === '{') opens.push(toks.length);
    else if (p === ')' || p === ']' || p === '}') tok.open = opens.length ? opens.pop() : -1;
    toks.push(tok); i += p.length;
  }
  return { toks, end: i, line };
}
const isP = (tk, ...vs) => !!tk && tk.t === 'p' && vs.includes(tk.v);
const isId = (tk, ...vs) => !!tk && tk.t === 'id' && (!vs.length || vs.includes(tk.v));
/** 括弧の組（open[k] = 閉じの位置・close[k] = 開きの位置・up[k] = いちばん内の開きの位置） */
function groupsOf(ts) {
  const open = new Map(), close = new Map(), up = new Array(ts.length).fill(-1), st = [];
  ts.forEach((tk, k) => {
    up[k] = st.length ? st[st.length - 1] : -1;
    if (isP(tk, '(', '[', '{')) st.push(k);
    else if (isP(tk, ')', ']', '}') && st.length) { const o = st.pop(); open.set(o, k); close.set(k, o); up[k] = st.length ? st[st.length - 1] : -1; }
  });
  return { open, close, up };
}
/** a から、深さ 0 の ; か ,（stopComma のとき）か、外の閉じ括弧の手前まで */
function exprEnd(ts, a, stopComma = true) {
  let d = 0, j = a;
  for (; j < ts.length; j++) {
    const tk = ts[j];
    if (isP(tk, '(', '[', '{')) d++;
    else if (isP(tk, ')', ']', '}')) { if (d === 0) break; d--; }
    else if (d === 0 && (isP(tk, ';') || (stopComma && isP(tk, ',')))) break;
  }
  return j;
}
/** [a, b) を深さ 0 の ? : で分ける（無ければ null） */
function splitTernary(ts, a, b) {
  let d = 0, q = -1, n = 0;
  for (let j = a; j < b; j++) {
    const tk = ts[j];
    if (isP(tk, '(', '[', '{')) d++;
    else if (isP(tk, ')', ']', '}')) d--;
    else if (d !== 0) continue;
    else if (isP(tk, '?')) { if (q < 0) q = j; else n++; }
    else if (isP(tk, ':') && q >= 0) { if (n === 0) return { q, c: j }; n--; }
  }
  return q < 0 ? null : { q, c: -1 };
}
/** [a, b) を深さ 0 の ops で分けた区切り（[x, y) の並び）。頭の単項の + - は区切りにしない */
function splitOps(ts, a, b, ops) {
  const out = [];
  let d = 0, x = a;
  for (let j = a; j < b; j++) {
    const tk = ts[j];
    if (isP(tk, '(', '[', '{')) d++;
    else if (isP(tk, ')', ']', '}')) d--;
    else if (d === 0 && j > x && isP(tk, ...ops)) { out.push([x, j]); x = j + 1; }
  }
  out.push([x, b]);
  return out;
}
/** [a, b) が数の式か（数の名前の宣言と代入の右） */
function numericExpr(ts, a, b, g) {
  if (a >= b) return false;
  const t3 = splitTernary(ts, a, b);
  if (t3) return t3.c > 0 && numericExpr(ts, t3.q + 1, t3.c, g) && numericExpr(ts, t3.c + 1, b, g);
  return splitOps(ts, a, b, ['+', '-', '*', '/', '%', '**', '||']).every(([x, y]) => {
    if (x >= y) return false;
    if (isP(ts[x], '-', '+') && y - x >= 2) return numericExpr(ts, x + 1, y, g);
    if (y - x === 1) return ts[x].t === 'num';
    if (isP(ts[x], '(') && g.open.get(x) === y - 1) return numericExpr(ts, x + 1, y - 1, g);
    const call = (k) => isP(ts[k], '(') && g.open.get(k) === y - 1;
    if (isId(ts[x], 'Number', 'parseInt', 'parseFloat') && call(x + 1)) return true;
    return isId(ts[x], 'Math') && isP(ts[x + 1], '.') && isId(ts[x + 2]) && call(x + 3);
  });
}
const NOT_CALL = new Set(['if', 'for', 'while', 'switch', 'with', 'catch', 'function', 'return', 'typeof', 'await', 'in', 'of', 'new', 'else', 'do', 'case', 'void', 'delete', 'throw']);
const WRITE_OPS = ['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??='];
const GLOBALS = ['window', 'globalThis', 'self', 'top', 'parent', 'frames'];   // 名前を宣言せずに書き換えられる物
/** 名前 name の、ファイルの中の宣言と代入が全部数か（lists は全部の字句の並び） */
function numericName(name, lists) {
  let decl = 0;
  for (const { ts, g } of lists) {
    for (let k = 0; k < ts.length; k++) {
      // window['name'] = …（宣言の外の書き込み: R121 (2)）
      if (ts[k].t === 'str' && ts[k].v === name && isP(ts[k - 1], '[') && isId(ts[k - 2], ...GLOBALS) && isP(ts[k + 1], ']') && isP(ts[k + 2], ...WRITE_OPS)) return false;
      if (!isId(ts[k], name)) continue;
      const prev = ts[k - 1], next = ts[k + 1];
      if (isP(prev, '.', '?.')) {
        if (isId(ts[k - 2], ...GLOBALS) && isP(next, ...WRITE_OPS)) return false;   // window.name = …
        continue;   // 欄の名前
      }
      if (isId(next, 'of', 'in')) return false;   // for (name of …)・for (name in …)（宣言の無い形も）
      if (isP(next, ':') && isP(prev, '{', ',') && isP(ts[g.up[k]], '{')) continue;   // 物の鍵
      if (isP(next, '=>') || isId(prev, 'function', 'class')) return false;
      if (isId(prev, 'const', 'let', 'var')) { decl++; if (isId(next, 'of', 'in')) return false; }
      // 取り出し（{ name } = …・[name] = …・const { name }）と引数（function (name)・(name) =>・catch (name)・m(name) {）
      let o = g.up[k];
      while (o >= 0 && isP(ts[o], '{', '[')) {
        const c = g.open.get(o);
        if ((c !== undefined && isP(ts[c + 1], '=', 'of', 'in')) || (c !== undefined && isId(ts[c + 1], 'of', 'in')) || isId(ts[o - 1], 'const', 'let', 'var')) return false;
        o = g.up[o];
      }
      if (o >= 0 && isP(ts[o], '(')) {
        const c = g.open.get(o), before = ts[o - 1];
        if (c !== undefined && isP(ts[c + 1], '=>', ...WRITE_OPS)) return false;   // (name) => …・(name) = …
        if (isId(before, 'function', 'catch') || (isId(before) && isId(ts[o - 2], 'function'))) return false;
        if (isId(before) && !NOT_CALL.has(before.v) && c !== undefined && isP(ts[c + 1], '{')) return false;
      }
      if (isP(next, '=', '+=', '&&=', '||=', '??=')) {
        const e = exprEnd(ts, k + 2);
        if (!numericExpr(ts, k + 2, e, g)) return false;
      }
    }
  }
  return decl > 0;
}
/** [a, b) が決まった文字か数か（違えば理由の文字） */
function sinkValue(ts, a, b, g, lists) {
  if (a >= b) return '空の値';
  const t3 = splitTernary(ts, a, b);
  if (t3) return t3.c < 0 ? '読めない ?:' : (sinkValue(ts, t3.q + 1, t3.c, g, lists) || sinkValue(ts, t3.c + 1, b, g, lists));
  for (const [x, y] of splitOps(ts, a, b, ['+'])) {
    if (x >= y) return '読めない +';
    if (isP(ts[x], '(') && g.open.get(x) === y - 1) { const w = sinkValue(ts, x + 1, y - 1, g, lists); if (w) return w; continue; }
    if (y - x !== 1) return '決まった文字でない式';
    const tk = ts[x];
    if (tk.t === 'str' || tk.t === 'num') continue;
    if (tk.t !== 'tpl') return '決まった文字でない名前';
    for (const ex of tk.exprs) {
      if (ex.length !== 1 || ex[0].t !== 'id') return '${…} の中が名前1つでない';
      if (!numericName(ex[0].v, lists)) return `\${${ex[0].v}} が数の名前でない`;
    }
  }
  return null;
}
// HTML を要素にするほかの口（入れる値に関わらず外れ: R121 (1)）と、口の名前の文字・切れ端
const BANNED_IDS = new Set(['setHTMLUnsafe', 'setHTML', 'parseHTMLUnsafe', 'DOMParser', 'createContextualFragment', 'srcdoc']);
const SINK_NAMES = new Set(['innerHTML', 'outerHTML', 'insertAdjacentHTML']);
const NAME_PIECE = /^(?:inner|outer|HTML|insertAdjacent|Adjacent)$/;
const SINK_IN_TEXT = /innerHTML|outerHTML|insertAdjacentHTML|srcdoc|setHTML/;
const DOC_NAMES = ['document', 'ownerDocument', 'contentDocument'];
const litText = (tk) => (tk.t === 'str' ? tk.v : tk.t === 'tpl' ? unesc(tk.quasis.join('')) : null);
// EK-1 直し（R125）: 口の名前の切れ端（名前の半分の長さからの頭か終わり。2つに分けたどちらかは必ずその長さになる）と、execCommand の
// insertHTML（大文字と小文字は同じ。execCommand の命令は決まった文字1つだけなので、切れ端はつなげない）
const PIECE_OF = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'setHTMLUnsafe', 'parseHTMLUnsafe', 'createContextualFragment'];
const INSERT_HTML = /inserthtml/i;
const isPiece = (lit) => /^[A-Za-z]+$/.test(lit) && PIECE_OF.some((w) => lit !== w && lit.length >= Math.ceil(w.length / 2) && (w.startsWith(lit) || w.endsWith(lit)));
/** ts[k] が外れの書き方なら { sink, why }。前の字句が同じ外れの続き（つなぎの2つ目から）なら null */
function banned(ts, k, g) {
  const tk = ts[k], prev = ts[k - 1], next = ts[k + 1];
  if (tk.t === 'id' && BANNED_IDS.has(tk.v)) return { sink: tk.v, why: `${tk.v} は HTML を要素にする口` };
  // EK-1 直し（R125）: 名前の \u の逃がし（el.\u0069nnerHTML）・文字を動かす口（eval・Function・文字の setTimeout）・document の別の名前・execCommand の insertHTML
  if (isP(tk, '\\')) return { sink: '\\u', why: '名前の \\u の逃がし（口の名前を隠せる）' };
  const prop = isP(prev, '.', '?.');
  if (tk.t === 'id' && !prop && tk.v === 'eval') return { sink: 'eval', why: 'eval は文字をスクリプトとして動かす' };
  if (tk.t === 'id' && !prop && tk.v === 'Function' && (isP(next, '(') || isId(prev, 'new'))) return { sink: 'Function', why: 'Function は文字をスクリプトとして動かす' };
  if (tk.t === 'id' && (tk.v === 'setTimeout' || tk.v === 'setInterval') && isP(next, '(') && ts[k + 2] && (ts[k + 2].t === 'str' || ts[k + 2].t === 'tpl')) return { sink: tk.v, why: `${tk.v} の文字はスクリプトとして動く` };
  if (tk.t === 'id' && DOC_NAMES.includes(tk.v) && !isP(next, '.', '?.', '[')) return { sink: tk.v, why: `${tk.v} を別の名前に渡す（.write を照らせない）` };
  if (tk.t === 'id' && tk.v === 'execCommand') {
    const a = ts[k + 2];
    if (!isP(next, '(') || !a || a.t !== 'str' || INSERT_HTML.test(a.v) || !isP(ts[k + 3], ',', ')')) return { sink: 'execCommand', why: "execCommand は決まった文字の命令だけ（'insertHTML' は HTML を要素にする口）" };
  }
  if (tk.t === 'id' && (tk.v === 'write' || tk.v === 'writeln') && isP(prev, '.', '?.') && isId(ts[k - 2], ...DOC_NAMES)) return { sink: 'document.write', why: 'document.write は HTML を要素にする口' };
  if (tk.t === 'id' && SINK_NAMES.has(tk.v) && isP(next, ':') && isP(prev, '{', ',') && isP(ts[g.up[k]], '{')) return { sink: tk.v, why: `物の鍵の ${tk.v}（Object.assign などで HTML の口に入る）` };
  if (tk.t === 'id' && tk.v === 'insertAdjacentHTML' && isP(prev, '.', '?.') && !isP(next, '(')) return { sink: tk.v, why: 'insertAdjacentHTML を呼ばずに取り出す（call・apply・別の名前で呼ぶと、入れる値を照らせない）' };
  const lit = litText(tk);
  if (lit === null) return null;
  if (tk.t === 'str' && (lit === 'write' || lit === 'writeln') && isP(prev, '[') && isId(ts[k - 2], ...DOC_NAMES)) return { sink: 'document.write', why: "document['write'] は HTML を要素にする口" };
  // EK-1 直し（R125）: 物の鍵の [文字]（{ ['innerHTML']: x }）
  if (SINK_NAMES.has(lit) && isP(prev, '[') && isP(next, ']') && isP(ts[k + 2], ':') && isP(ts[k - 2], '{', ',') && isP(ts[g.up[k - 1]], '{')) return { sink: lit, why: `物の鍵の [${lit}]（Object.assign などで HTML の口に入る）` };
  // ['innerHTML'] = … と ['innerHTML'](…) の形は口として照らす（htmlSinks）。['insertAdjacentHTML'] を呼ばずに取り出すのは外れ
  if (tk.t === 'str' && SINK_NAMES.has(lit) && isP(prev, '[') && isP(next, ']')) {
    if (lit !== 'insertAdjacentHTML' || isP(ts[k + 2], '(')) return null;
    return { sink: lit, why: 'insertAdjacentHTML を呼ばずに取り出す（call・apply・別の名前で呼ぶと、入れる値を照らせない）' };
  }
  if ((tk.t === 'str' || !tk.exprs.length) && (SINK_NAMES.has(lit) || BANNED_IDS.has(lit) || NAME_PIECE.test(lit))) return { sink: lit, why: `口の名前の文字 '${lit}'（Reflect.set・el[名前] などで HTML の口に入る）` };
  if ((tk.t === 'str' || !tk.exprs.length) && (INSERT_HTML.test(lit) || isPiece(lit))) return { sink: lit, why: `口の名前の文字か切れ端 '${lit}'（つないで HTML の口の名前になる）` };
  if (tk.t === 'tpl' && tk.exprs.length && (SINK_IN_TEXT.test(lit) || INSERT_HTML.test(lit))) return { sink: lit, why: '`…${…}…` で口の名前を組む' };
  // 'inner' + 'HTML' のつなぎ（つなぎの頭の字句で1回）
  if (isP(prev, '+') && ts[k - 2] && litText(ts[k - 2]) !== null) return null;
  let joined = lit, j = k;
  while (isP(ts[j + 1], '+') && ts[j + 2] && litText(ts[j + 2]) !== null) { joined += litText(ts[j + 2]); j += 2; }
  if (j > k && (SINK_IN_TEXT.test(joined) || INSERT_HTML.test(joined))) return { sink: joined, why: `文字のつなぎで口の名前を組む（${joined}）` };
  if (j > k && /^write(?:ln)?$/.test(joined) && isP(prev, '[') && isId(ts[k - 2], ...DOC_NAMES)) return { sink: 'document.write', why: `文字のつなぎで document.write を組む（${joined}）` };
  return null;
}
/** ファイルの全部の HTML の口（all）と、決まった文字か数でないもの（bad）。どれも { line, sink, text, why } */
function htmlSinks(src, file = '') {
  const parts = [];
  if (src == null) return { all: [], bad: [] };
  if (/\.html?$/.test(file)) {
    for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      const at = m.index + m[0].indexOf('>') + 1;
      parts.push({ code: m[1], line: src.slice(0, at).split('\n').length });
    }
  } else parts.push({ code: src, line: 1 });
  const lists = [];
  const addList = (ts, part) => { lists.push({ ts, g: groupsOf(ts), part }); for (const tk of ts) if (tk.t === 'tpl') for (const ex of tk.exprs) addList(ex, part); };
  for (const part of parts) addList(lexJs(part.code).toks, part);
  const all = [], bad = [];
  for (const { ts, g, part } of lists) {
    for (let k = 0; k < ts.length; k++) {
      let sink = null, a = -1, b = -1;
      const prop = isP(ts[k], '.') && isId(ts[k + 1]) ? ts[k + 1].v
        : isP(ts[k], '[') && ts[k + 1] && ts[k + 1].t === 'str' && isP(ts[k + 2], ']') ? ts[k + 1].v : null;
      const after = isP(ts[k], '.') ? k + 2 : k + 3;
      if ((prop === 'innerHTML' || prop === 'outerHTML') && isP(ts[after], '=', '+=', '||=', '&&=', '??=')) {
        sink = prop; a = after + 1; b = exprEnd(ts, a);
      } else if (prop === 'insertAdjacentHTML' && isP(ts[after], '(')) {
        sink = prop;
        const c = g.open.get(after);
        const args = splitOps(ts, after + 1, c === undefined ? ts.length : c, [',']);
        if (args.length >= 2) [a, b] = args[1]; else a = b = after + 1;
      }
      const ban = banned(ts, k, g);
      if (ban) {
        const h0 = part.code.lastIndexOf('\n', ts[k].at) + 1, e0 = part.code.indexOf('\n', ts[k].at);
        bad.push({ line: part.line + ts[k].line - 1, sink: ban.sink, text: part.code.slice(h0, e0 < 0 ? part.code.length : e0).replace(/\s+/g, ' ').trim(), why: ban.why });
        continue;
      }
      if (!sink) continue;
      const head = part.code.lastIndexOf('\n', ts[k].at) + 1;
      const last = ts[Math.max(a, b - 1)] || ts[k + 1];
      const text = part.code.slice(head, last.end).replace(/\s+/g, ' ').trim();
      const x = { line: part.line + ts[k].line - 1, sink, text };
      all.push(x);
      const why = sinkValue(ts, a, b, g, lists);
      if (why) bad.push({ ...x, why });
    }
  }
  return { all, bad };
}
const sinkTarget = (f) => /^src\/.*\.(?:html?|m?js)$/.test(f);
/** 前の版より数が増えた、決まった文字か数でない HTML の口（同じ字の行ごとに1件。'ファイル:今の行の番号の全部 行 — 理由（前 n → 今 m）' の文字）。
 *  数は同じ字の口ごとに比べる（どれかの口が増えれば、外れの数の全部も増える）。どの行が新しいかは字だけでは分からないので、今の全部の行の番号を出す */
function htmlSinkFindings(file, before, after) {
  if (!sinkTarget(file) || after == null) return [];
  const count = (src) => {
    const m = new Map();
    for (const x of htmlSinks(src, file).bad) {
      const cur = m.get(x.text) || { n: 0, why: x.why, lines: [] };
      cur.n++; cur.lines.push(x.line); m.set(x.text, cur);
    }
    return m;
  };
  const b = count(before), a = count(after);
  return [...a].filter(([t, x]) => x.n > ((b.get(t) || {}).n || 0))
    .map(([t, x]) => `${file}:${x.lines.join(',')} ${t} — ${x.why}（前 ${(b.get(t) || {}).n || 0} → 今 ${x.n}）`);
}

function analyze(base, head) {
  F = [];
  const changed = new Set(
    (head === null ? git(['diff', '--name-only', base])
      : head === 'INDEX' ? git(['diff', '--name-only', '--cached', base])
      : git(['diff', '--name-only', base, head]))
      .split('\n').filter(Boolean));
  const htmls = ['src/renderer/app.html', 'src/renderer/overlay.html'];

  for (const f of htmls) {
    const a = at(head, f); if (a == null) continue;
    F.push(...htmlFindings(f, at(base, f), a));
  }
  // 透過ウィンドウの地雷（新しく踏んだものだけ）
  const mainA = at(head, 'src/main.js'), mainB = at(base, 'src/main.js');
  const snap = (m, get) => {
    if (!m) return new Map();
    const out = new Map();
    for (const w of windows(m)) {
      if (String(w.opts.transparent).trim() !== 'true') continue;
      const html = w.html ? get('src/renderer/' + w.html) : null;
      for (const h of mineHits(w, html)) out.set(h.what, h);
    }
    return out;
  };
  // 透過そのものを外した／窓が透過でなくなった（v0.9.11 と同じ症状を別の踏み方で出す）
  const byHtml = (m) => new Map((m ? windows(m) : []).filter((w) => w.html).map((w) => [w.html, w]));
  const wb = byHtml(mainB), wa = byHtml(mainA);
  for (const [html, w] of wb) {
    if (String(w.opts.transparent).trim() !== 'true') continue;
    const n = wa.get(html);
    if (!n) continue;
    if (String(n.opts.transparent).trim() !== 'true')
      add('BLOCK', '透過ウィンドウの地雷', 'src/main.js', `${html} の窓から transparent:true が外れた（今は ${n.opts.transparent}）\n      理由: 透過をやめると、ピルの角の外に地色の矩形が出る（v0.9.11 と同じ症状）`, '透過は録音バーの前提。外すなら overlay.html の角丸と影も同時に作り直す');
  }
  const hb = snap(mainB, (f) => at(base, f)), ha = snap(mainA, (f) => at(head, f));
  for (const [k, h] of ha) if (!hb.has(k)) add('BLOCK', '透過ウィンドウの地雷', 'src/main.js + overlay.html', `${k}\n      理由: ${h.why}（${h.seen}）`, 'tools/lib/mines.js の台帳にある。撤去する');
  // 地とインクの向き（新しく壊れたものだけ）
  const ib = new Set(inkFindings(at(base, 'src/renderer/overlay.html')));
  for (const x of inkFindings(at(head, 'src/renderer/overlay.html')))
    if (!ib.has(x)) add('BLOCK', '地とインクの向き', 'src/renderer/overlay.html', x, '地の色を変えたら、その面に載る色を全て見直す');
  checkPs1(head);
  checkRecovery(mainA);
  // main 側の外向きのグローバル fetch（新しく足したものだけ）
  for (const f of [...changed].filter(fetchTarget)) {
    for (const arg of fetchFindings(f, at(base, f), at(head, f)))
      add('BLOCK', 'main の外向き通信', f, `グローバルの fetch を足した: ${arg}\n      理由: Node の fetch は Windows のプロキシ・PAC・証明書を使わない（RF2）`, 'Electron の net（net.request／net.fetch）を使う。127.0.0.1 のエンジンへの呼び出しだけは fetch でよい');
  }
  // src の JSON の直書き（新しく足した行だけ。G8・JS5）
  for (const f of [...changed].filter(jsonWriteTarget)) {
    for (const line of jsonWriteFindings(f, at(base, f), at(head, f)))
      add('BLOCK', 'JSON の直書き', f, `src で JSON を直接書く行を足した: ${line}\n      理由: 一時ファイル・fsync・名前の変更のやり直し・読み取り専用の扱いを通らない（JS5）`, 'src/jsonfile.js の writeJsonFile を使う');
  }

  // 外への送り方と Claude Code の呼び方（新しく足した行だけ。第1c回 OL8）
  for (const f of [...changed].filter(onlineTarget)) {
    for (const line of onlineFindings(f, at(base, f), at(head, f)))
      add('BLOCK', '外への送り方と Claude Code の呼び方', f, `決まりに触れる行を足した: ${line}`, 'src/claude-cli.js の部品（findClaude・claudeAuthStatus・claudeSummarize）と src/secrets.js（safeStorage の非同期の形）を使う');
  }

  // 中継と直の送り先（新しく足した行だけ。第1d回 RL12・RF38）
  for (const f of [...changed].filter(relayTarget)) {
    for (const line of relayFindings(f, at(base, f), at(head, f)))
      add('BLOCK', '中継と直の送り先', f, `決まりに触れる行を足した: ${line}`, '文字起こしと確認コードは src/relay.js（中継）を通す・鍵は Worker の秘密の欄だけ・中継の記録は relay/log.mjs・秘密の欄は Cloudflare の画面で入れる・チームの名前と Access の秘密の値はリポジトリに書かない');
  }

  // 画面の HTML に他人の文字（新しく足した口だけ。0.14.0 EB-6・SEC2）
  for (const f of [...changed].filter(sinkTarget)) {
    for (const line of htmlSinkFindings(f, at(base, f), at(head, f)))
      add('BLOCK', '画面の HTML に他人の文字', f, `innerHTML・outerHTML・insertAdjacentHTML に決まった文字か数でないものを入れる行を足した: ${line}\n      理由: 貼った文字・設定の文字・リンクが要素になり、スクリプトが走る（SEC2）`, 'textContent と createElement で組む（入れてよいのは決まった文字と、数と決まった名前1つの ${…} だけ）');
  }

  // 実機確認が要る変更の判定
  const needs = [];
  if ([...changed].some((f) => f.includes('overlay.html'))) needs.push('録音バーの透過（ピルの外に矩形が出ていないか）と、暗い地の上で波形・文字が読めるか');
  if (mainA !== mainB && /new BrowserWindow/.test(mainA || '')) needs.push('ウィンドウの生成条件を変えた。透過・影・常に手前の挙動を実機で見る');
  if ([...changed].some((f) => f.includes('app.html'))) needs.push('設定画面の全カードが見え、値が読み込まれ、自動保存が効くか');
  if ([...changed].some((f) => f.endsWith('.ps1'))) needs.push('PowerShell 5.1（Windows 標準）で .ps1 が構文エラーにならないか');
  if ([...changed].some((f) => /updater|main\.js/.test(f))) needs.push('トレイの「更新を確認」が、設定画面を開かずに動くか');

  return { findings: F.slice(), needs, changed };
}

// ---------- このゲートの射程 ----------
// 「危険な変更は見つからなかった」は、ここに挙げた範囲の話でしかない。出典照合や保存の
// ロジック（src/cite.js など）はこのゲートの射程外で、そこを触ったコミットにも同じ文が
// 出て全否定に読めた（監査 #38）。射程外は npm test が守る（pre-commit もそれを走らせる）。
const HELP_SEES = 'ヘルプの公開前の確認（help/ の記事・site.json・資産に足した、チームのドメインの字面・64 字の16進・個人の Windows のパス・鍵の見かけ。ヘルプの出し方は中継の出し方と同じ決まり）';
const RELAY_SEES = '中継と直の送り先（src/ から OpenAI・Groq・Resend へ直に送る行・鍵の見かけの文字・relay/ の console と node: と Buffer・中継と出し方の中で秘密の欄に値を書く行・チームのドメインの字面・Access の秘密の欄に値を書く行）';
const SINK_SEES = '画面の HTML に入れる文字（SEC2。innerHTML・outerHTML・insertAdjacentHTML に入るのは決まった文字と数だけ・setHTMLUnsafe・DOMParser・document.write・srcdoc・execCommand の insertHTML などのほかの口と、口の名前を隠す書き方（切れ端・逃がし・別の名前）・eval・Function・文字の setTimeout は使わない）';
const SCOPE = {
  sees: [
    'HTML の木の健全さ（閉じ忘れ・相手のいない閉じタグ）',
    '要素の消失・枠からの離脱・参照の破れ',
    '透過ウィンドウの地雷（台帳 tools/lib/mines.js）',
    '地とインクの向き',
    '.ps1 の BOM と書き出し口',
    '復旧の導線が main 側にあること',
    'main プロセスの外向きの通信（グローバルの fetch）',
    'src の JSON の直書き（src/jsonfile.js のほか）',
    'Claude Code の呼び方と鍵のしまい方（--bare・.credentials.json・同期の safeStorage・claude-cli.js のほかでの claude の起動）',
    RELAY_SEES,
    HELP_SEES,
    SINK_SEES,
  ],
  blind: ['src/cite.js', 'src/store.js', 'src/minutes.js', 'src/actions.js'],
};
/** 射程の但し書き。changed（変更ファイルの集合）に射程外のファイルがあれば名指しする */
function scopeNote(changed) {
  const lines = [
    `  このゲートが見る範囲: ${SCOPE.sees.join(' / ')}`,
    `  見ていないもの: ${SCOPE.blind.join(' / ')} のロジック — これらは npm test が守る`,
  ];
  const hit = SCOPE.blind.filter((f) => changed && changed.has(f));
  if (hit.length) lines.push(`  ※ この変更には ${hit.join(' / ')} が含まれる。ここはこのゲートの射程外 — npm test を通すこと`);
  return lines.join('\n');
}

function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
  let base = arg('--base', 'HEAD');
  // リリース時は「前のタグ」を基準にする。既定の HEAD のままだと、
  // コミット済みの変更が差分に入らず、最も効くべき瞬間に
  // 必ず「危険な変更は見つからなかった」と言ってしまう。
  if (argv.includes('--base-tag')) {
    try {
      base = require('child_process')
        .execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: ROOT }).toString().trim();
    } catch (_) {
      base = require('child_process')
        .execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ROOT }).toString().trim().split('\n')[0];
    }
  }
  const head = argv.includes('--staged') ? 'INDEX' : (argv.includes('--head') ? arg('--head') : null);
  const { findings, needs, changed } = analyze(base, head);
  const blocks = findings.filter((f) => f.level === 'BLOCK');
  const warns = findings.filter((f) => f.level === 'WARN');
  const target = head === null ? '作業ツリー' : head === 'INDEX' ? 'コミット予定の内容' : head;
  console.log(`■ 変更危険度ゲート  基準=${base}  対象=${target}  変更ファイル ${changed.size} 件\n`);
  const STANDING = new Set(['復旧の導線', '配布-ps1']);
  const show = (title, xs) => { if (!xs.length) return; console.log(`── ${title} ──\n`); for (const f of xs) console.log(`[${f.level}] ${f.rule}  ${f.file}\n   ${f.msg}\n   → ${f.how}\n`); };
  show('この変更で新たに危険になったもの', [...blocks, ...warns].filter((f) => !STANDING.has(f.rule)));
  show('常時の不変条件（この変更とは無関係に破れている）', [...blocks, ...warns].filter((f) => STANDING.has(f.rule)));
  if (!findings.length) console.log('危険な変更は見つからなかった（このゲートが見る範囲では）。\n' + scopeNote(changed) + '\n');
  else if (SCOPE.blind.some((f) => changed.has(f))) console.log(scopeNote(changed).split('\n').pop() + '\n');
  const a0 = { errTotal: findings.filter((f) => f.rule === 'HTML-木の破損').length };
  const md = ['# リリース前チェックリスト（自動生成）', '', `基準 ${base} → ${target}`, ''];
  if (needs.length) { md.push('## 実機（Windows）で見ること', ''); needs.forEach((n, i) => md.push(`- [ ] ${i + 1}. ${n}`)); }
  else md.push('実機確認が必要な変更は含まれていない。');
  const line = (name, n) => n ? `- [ ] ${name}: ${n} 件見つかった（直すまでリリースしない）` : `- [x] ${name}: 問題なし`;
  md.push('', '## 機械が確認したこと（実機で見る必要がないもの）', '',
    line('HTML の木の健全さ（閉じ忘れ・相手のいない閉じタグ）', a0.errTotal),
    line('要素の消失・枠からの離脱・参照の破れ', blocks.filter((b) => b.rule.startsWith('HTML')).length),
    line('透過ウィンドウの地雷（台帳 tools/lib/mines.js）', blocks.filter((b) => b.rule.includes('地雷')).length),
    line('地とインクの向き', blocks.filter((b) => b.rule.includes('インク')).length),
    line('.ps1 の BOM と書き出し口', blocks.filter((b) => b.rule.includes('ps1')).length),
    line('復旧の導線が main 側にあること', blocks.filter((b) => b.rule.includes('復旧')).length),
    line('main プロセスの外向きの通信（グローバルの fetch）', blocks.filter((b) => b.rule === 'main の外向き通信').length),
    line('src の JSON の直書き（src/jsonfile.js のほか）', blocks.filter((b) => b.rule === 'JSON の直書き').length),
    line('Claude Code の呼び方と鍵のしまい方（--bare・.credentials.json・同期の safeStorage・claude-cli.js のほかでの claude の起動）', blocks.filter((b) => b.rule === '外への送り方と Claude Code の呼び方').length),
    line(RELAY_SEES, blocks.filter((b) => b.rule === '中継と直の送り先' && !inHelp(b.file)).length),
    line(HELP_SEES, blocks.filter((b) => b.rule === '中継と直の送り先' && inHelp(b.file)).length),
    line(SINK_SEES, blocks.filter((b) => b.rule === '画面の HTML に他人の文字').length),
    '', `このゲートが見ていないもの: ${SCOPE.blind.join(' / ')} のロジック — npm test が守る（リリース前に必ず通す）`);
  const out = arg('--checklist');
  if (out) { fs.writeFileSync(out, md.join('\n') + '\n'); console.log('チェックリストを書き出した: ' + out); }
  else if (needs.length) console.log('― 実機で見ること ―\n' + needs.map((n, i) => `  ${i + 1}. ${n}`).join('\n') + '\n');
  console.log(`結果: BLOCK ${blocks.length} 件 / WARN ${warns.length} 件`);
  return blocks.length ? 1 : 0;
}
if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { analyze, htmlSinks, htmlSinkFindings, lexJs, checkHtml, htmlFindings, windows, mineHits, inkFindings, refIds, fetchFindings, jsonWriteFindings, onlineFindings, relayFindings, relayTarget, SCOPE, scopeNote };
