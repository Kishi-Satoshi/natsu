#!/usr/bin/env node
'use strict';
// help-shots.js — ヘルプセンターの画面の写真を撮る（H-11・R7。実装計画 docs/plans/2026-10-20-help.md）
//
//   HELP_SHOTS_PLAYWRIGHT=<playwright のフォルダ> HELP_SHOTS_CHROMIUM=<chromium の実行ファイル> node tools/help-shots.js [--shots <写真のフォルダ>]
//
// 作業環境に入っている Playwright と Chromium を使う（リポジトリの依存ではない。場所は環境変数で受け、無ければ使い方を出して 1）。
// help/ から作り直したサイト（help/dist）を 127.0.0.1 で、門と同じ見出し（relay/help-gate.mjs の helpHeaders。CSP も同じ）を付けて出し、
// ホーム・全体像（start/overview）・はじめかた（start/getting-started）・分類（record）・記事（record/pc-only）・移動の知らせ（start/tester-guide）・リリースノートを、幅 1280・390 で撮る。
// 配色は明るい版だけ（help-light HL-3。ヘルプは Windows の配色に合わせないので、暗い配色で撮っても明るい版と同じ）。
//   - CSP に断られたものが1つでもあれば NG。ページの JS の誤りも NG。横のはみ出し（scrollWidth > clientWidth）も NG。
//   - 写真は既定で help/dist/_shots/（git に入らない）。
//   - 全部が OK のときだけ、撮った CSS の指紋を help/shots.json に書く（CSS を変えたら撮り直す: test/help-build.test.js の R7）。
// 写真は CI の基準にしない（R7）。撮ったら自分の目で全部を見てから help/shots.json を commit する。

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PAGES = ['/', '/start/overview/', '/start/getting-started/', '/record/', '/record/pc-only/', '/start/tester-guide/', '/release-notes/'];   // help-overview HO-6: 全体像の記事（写真と図の多いページ）も撮る。HO-7: はじめかた（start/getting-started）も撮る（start/tester-guide は移動の知らせ）
const SCHEMES = ['light'];
const WIDTHS = [1280, 390];
const HEIGHT = 900;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
};

const USAGE = [
  '使い方: HELP_SHOTS_PLAYWRIGHT=<playwright のフォルダ> HELP_SHOTS_CHROMIUM=<chromium の実行ファイル> node tools/help-shots.js [--shots <写真のフォルダ>]',
  '  HELP_SHOTS_PLAYWRIGHT … 作業環境に入っている Playwright（require できるフォルダ。リポジトリの依存にはしない）',
  '  HELP_SHOTS_CHROMIUM   … 作業環境に入っている Chromium の実行ファイル（playwright install はしない）',
].join('\n');

/** help/assets/*.css の指紋（ファイルごとの SHA-256 を base64url で。改行は LF にそろえる。64 字の16進はゲートが AUD の見かけとして止めるので使わない） */
function cssFingerprint(root = ROOT) {
  const dir = path.join(root, 'help', 'assets');
  const out = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.css')).sort()) {
    out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n?/g, '\n')).digest('base64url');
  }
  return out;
}

/** 写真の名前（/record/pc-only/ → record-pc-only） */
const shotName = (p) => (p === '/' ? 'home' : p.replace(/^\/|\/$/g, '').replace(/\//g, '-'));

/** dist を 127.0.0.1 で出す。見出しは門と同じ（helpHeaders）。無い道は 404.html を 404 で */
function serve(dist, helpHeaders) {
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch (_) { pathname = '/__bad__'; }
    let file = path.join(dist, pathname.endsWith('/') ? pathname + 'index.html' : pathname);
    let status = 200;
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      file = path.join(dist, '404.html');
      status = 404;
    }
    const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', ...helpHeaders(pathname, status) };
    res.writeHead(status, headers);
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const pw = env.HELP_SHOTS_PLAYWRIGHT;
  const chromium = env.HELP_SHOTS_CHROMIUM;
  if (!pw || !chromium) {
    process.stderr.write(USAGE + '\n');
    return 1;
  }
  const at = argv.indexOf('--shots');
  const shotsDir = at >= 0 && argv[at + 1] ? path.resolve(argv[at + 1]) : path.join(ROOT, 'help', 'dist', '_shots');
  const dist = path.join(ROOT, 'help', 'dist');
  require('./help-build').build({ root: ROOT, out: dist });
  fs.mkdirSync(shotsDir, { recursive: true });

  const { helpHeaders } = await import(pathToFileURL(path.join(ROOT, 'relay', 'help-gate.mjs')).href);
  const { chromium: launcher } = require(pw);
  const server = await serve(dist, helpHeaders);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launcher.launch({ executablePath: chromium });
  const ng = [];
  try {
    for (const p of PAGES) {
      for (const scheme of SCHEMES) {
        for (const width of WIDTHS) {
          const name = `${shotName(p)}-${scheme}-${width}.png`;
          const ctx = await browser.newContext({ viewport: { width, height: HEIGHT }, colorScheme: scheme, deviceScaleFactor: 1 });
          const page = await ctx.newPage();
          const bad = [];
          page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) bad.push(`CSP: ${m.text().slice(0, 200)}`); });
          page.on('pageerror', (e) => bad.push(`JS: ${String(e && e.message).slice(0, 200)}`));
          page.on('requestfailed', (r) => bad.push(`読めない: ${r.url().replace(base, '')}`));
          await page.addInitScript(() => {
            window.__cspBad = [];
            document.addEventListener('securitypolicyviolation', (e) => window.__cspBad.push(`${e.violatedDirective} ${e.blockedURI}`));
          });
          const res = await page.goto(base + p, { waitUntil: 'networkidle' });
          if (!res || res.status() !== 200) bad.push(`HTTP ${res ? res.status() : '返事なし'}`);
          await page.evaluate(() => document.fonts.ready);
          const csp = await page.evaluate(() => window.__cspBad);
          for (const c of csp) bad.push(`CSP: ${c}`);
          const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (over > 0) bad.push(`横のはみ出し ${over}px`);
          // 1枚の写真に全体を写すため、窓の高さをページの高さに合わせる（広い画面の左の目次は窓の高さで切って中で送るので、
          // 窓が 900px のままだと写真では下の分類が切れて見える。本物の画面では目次の中を送って読める）
          for (let k = 0; k < 3; k++) {
            const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, (document.getElementById('hc-toc') || { scrollHeight: 0 }).scrollHeight + 120));
            if (h <= page.viewportSize().height) break;
            await page.setViewportSize({ width, height: h });
          }
          await page.screenshot({ path: path.join(shotsDir, name), fullPage: true });
          await ctx.close();
          process.stdout.write(`${bad.length ? 'NG' : 'OK'} ${name}${bad.length ? ` — ${bad.join(' / ')}` : ''}\n`);
          if (bad.length) ng.push(name);
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (ng.length) {
    process.stderr.write(`NG が ${ng.length} 枚あります。help/shots.json は書きません\n`);
    return 1;
  }
  const shots = { css: cssFingerprint(ROOT), pages: PAGES, schemes: SCHEMES, widths: WIDTHS };
  fs.writeFileSync(path.join(ROOT, 'help', 'shots.json'), JSON.stringify(shots, null, 2) + '\n');
  process.stdout.write(`撮りました: ${PAGES.length * SCHEMES.length * WIDTHS.length} 枚（${shotsDir}）。全部を自分の目で見てから help/shots.json を commit してください\n`);
  return 0;
}

if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`失敗: ${e && e.message}\n`); process.exitCode = 1; });
module.exports = { cssFingerprint, shotName, PAGES, SCHEMES, WIDTHS };
