'use strict';
// faulty-fs.js — 決めた操作で、決めた回数だけ失敗する fs（それ以外は本物の fs に渡す）。第1a回の JS の試しに使う。
//   rules: [{ op: 'read'|'open'|'rename'|'fsync'|'copy'|'stat', match: RegExp, code: 'EBUSY' など, times: 回数（Infinity 可） }]
//   match はパスに当てる（rename と copy は行き先、fsync は fd の数の文字）
const fs = require('node:fs');

function faultyFs(rules, base = fs) {
  const seen = new Map();
  const hit = (op, p) => {
    for (const r of rules) {
      if (r.op !== op || !r.match.test(String(p))) continue;
      const n = (seen.get(r) || 0) + 1;
      seen.set(r, n);
      if (n <= r.times) throw Object.assign(new Error(`${r.code}: ${op} を失敗させた（試し）`), { code: r.code });
    }
  };
  const wrap = {
    readFileSync: (p, ...a) => { hit('read', p); return base.readFileSync(p, ...a); },
    openSync: (p, ...a) => { hit('open', p); return base.openSync(p, ...a); },
    renameSync: (a, b) => { hit('rename', b); return base.renameSync(a, b); },
    fsyncSync: (fd) => { hit('fsync', String(fd)); return base.fsyncSync(fd); },
    copyFileSync: (a, b, ...r) => { hit('copy', b); return base.copyFileSync(a, b, ...r); },
    statSync: (p, ...a) => { hit('stat', p); return base.statSync(p, ...a); },
  };
  return new Proxy(base, { get: (t, k) => (k in wrap ? wrap[k] : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
}

module.exports = { faultyFs };
