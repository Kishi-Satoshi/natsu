'use strict';
// 中継（relay/）は Cloudflare Workers で動く。Workers の fetch は redirect に 'follow' と 'manual' しか受けず、
// 'error' を渡すと要求を作る時点で TypeError を投げる（https://developers.cloudflare.com/workers/runtime-apis/request/ ）。
// Node の fetch は 'error' を受けるので、ほかのテストでは見つからない（0.8.0 の出し直しで、Access の鍵を取りに行けず /health が 503 certs になった）。
// 'follow' は会社の鍵を転送先へ運ぶので使わない。だから relay/ の redirect はどれも 'manual' で、3xx は失敗として扱う。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RELAY = path.join(__dirname, '..', 'relay');

test('Workers: relay/ の fetch の redirect はどれも manual（error は Workers で TypeError、follow は鍵を運ぶ）', () => {
  let seen = 0;
  for (const f of fs.readdirSync(RELAY).filter((n) => n.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(RELAY, f), 'utf8');
    for (const line of src.split('\n')) {
      if (/^\s*\/\//.test(line)) continue;   // 注釈の行は見ない
      const m = line.match(/redirect\s*:\s*(['"`])([^'"`]*)\1/);
      if (!m) continue;
      seen++;
      assert.strictEqual(m[2], 'manual', `${f}: redirect: '${m[2]}' は Workers で使えないか鍵を運ぶ`);
    }
  }
  assert.ok(seen >= 2, 'access.mjs（鍵）と stt.mjs（OpenAI）の2か所の fetch が見つかること');
});

// ヘルプセンター H-9: 門の Worker（relay/help-gate.mjs）も Workers で動く。門と、それが import でたどるファイルの組を見る
// （出し方の help-deploy が上げるのもこの組）。どれも redirect は manual だけで、Node だけの部品（node:・require・Buffer・process）を使わない。
function importClosure(entry) {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = fs.readFileSync(path.join(RELAY, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/\bfrom\s+['"]\.\/([^'"]+)['"]|\bimport\s*\(\s*['"]\.\/([^'"]+)['"]/g)) walk(m[1] || m[2]);
  };
  walk(entry);
  return [...seen].sort();
}

test('Workers: ヘルプの門（help-gate.mjs）と、それが読む relay/ のファイルは redirect が manual だけで、Node だけの部品を使わない', () => {
  const files = importClosure('help-gate.mjs');
  assert.deepStrictEqual(files, ['access.mjs', 'config.mjs', 'help-gate.mjs', 'http.mjs', 'log.mjs']);
  for (const f of files) {
    const code = fs.readFileSync(path.join(RELAY, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    for (const m of code.matchAll(/redirect\s*:\s*(['"`])([^'"`]*)\1/g)) assert.strictEqual(m[2], 'manual', `${f}: redirect: '${m[2]}'`);
    assert.ok(!/['"]node:|\brequire\s*\(|\bBuffer\b|\bprocess\./.test(code), `${f} が Node だけの部品を使う`);
  }
  // 門は ASSETS の答えを写してから見出しを付ける（Workers の ASSETS の答えの見出しは書き換えられない）
  const gate = fs.readFileSync(path.join(RELAY, 'help-gate.mjs'), 'utf8');
  assert.match(gate, /new Response\(/, '答えを写していない');
});
