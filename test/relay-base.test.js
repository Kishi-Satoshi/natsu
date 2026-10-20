/*
 * relay-base.test.js — 第1d回 A-10（RL9）: 中継の住所（src/relay.js の RELAY_BASE）が本物の workers.dev の住所で、
 * 仮の値（'-unset-'）のまま版を上げると赤になる守り。版の照らしは、'-unset-' に戻して版を上げると赤になることを手で見た。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RELAY_BASE } = require('../src/relay');
const { version } = require('../package.json');

test('RL9: RELAY_BASE は https の natsu-relay の workers.dev で、package.json の版が 0.7.0 でないのに -unset- が残っていたら赤', () => {
  const u = new URL(RELAY_BASE);
  assert.strictEqual(u.protocol + '//' + u.host, RELAY_BASE);   // 道・ポート・終わりの / が無い
  assert.match(u.hostname, /^natsu-relay\.[a-z0-9-]+\.workers\.dev$/);
  // どのラベルも - で始まらず - で終わらない（DNS で引ける名前。仮の値 -unset- はここで赤）
  for (const label of u.hostname.split('.')) assert.match(label, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, `RELAY_BASE のラベル ${label} が DNS の名前でない`);
  if (version !== '0.7.0') assert.ok(!RELAY_BASE.includes('-unset-'), `版 ${version} なのに RELAY_BASE が仮の値のまま`);
});
