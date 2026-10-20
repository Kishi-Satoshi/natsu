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
