'use strict';
// node:sqlite の上の偽の D1（第1d回 W-1）。中継（relay/*.mjs）が使う D1 の口の一部だけを真似る。
//   makeFakeD1() → { prepare(sql) → stmt, batch(stmts) → Promise<D1Result[]>, exec(sql) → Promise<{ count }>, close() }
//   stmt.bind(...v) → 新しい stmt（元は変えない）
//   stmt.first(col?) → 最初の行（col があればその欄の値）か null。col の欄が無ければ投げる（本物と同じ）
//   stmt.run()       → { success: true, meta: { changes, last_row_id }, results: [...] }（書く文の results は []）
//   stmt.all()       → { success: true, meta, results }
//   batch([stmt…])   → 1つのトランザクション（BEGIN … COMMIT。どれかが投げれば ROLLBACK して投げる）。答えは文ごとの D1Result
// 本物の D1 と同じく、first・run・all・batch はどれも1回の往復の間（setImmediate）を置いてから流す。
// こうしないと、同時の要求が文の間で入れ替わらず、「読んでから数える」取り違えをテストで見つけられない。
// batch の中は間を挟まない（本物の batch も1つのトランザクション）。
// 文の誤り（SQL の書き間違い）は、本物と同じく prepare では投げず、流したときに投げる。
// exec は表の形を流すための台だけ（本物の D1 の exec は1行に1文で、中継のコードは使わない）。
// 値: undefined は投げる（本物の D1 の D1_TYPE_ERROR）、真偽は 1／0 にする（本物の D1 と同じ）。
// 行はふつうのオブジェクトで返す（node:sqlite の null の原型のままだと deepStrictEqual で比べにくい）。

const { DatabaseSync } = require('node:sqlite');

const tick = () => new Promise(setImmediate);

function toParam(v) {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: undefined は渡せない');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function makeFakeD1() {
  const db = new DatabaseSync(':memory:');
  let open = true;

  // 1つの文をその場で流す（間を置かない）。読む文は行を、書く文は変えた行の数を返す
  function runNow(sql, params) {
    const st = db.prepare(sql);
    if (st.columns().length > 0) {
      const results = st.all(...params).map((r) => ({ ...r }));
      return { success: true, meta: { changes: 0, last_row_id: 0, rows_read: results.length }, results };
    }
    const r = st.run(...params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, results: [] };
  }

  function stmt(sql, params) {
    return {
      bind(...v) { return stmt(sql, v.map(toParam)); },
      async first(col) {
        await tick();
        const row = runNow(sql, params).results[0];
        if (!row) return null;
        if (col === undefined) return row;
        if (!Object.prototype.hasOwnProperty.call(row, col)) throw new Error(`D1_COLUMN_NOTFOUND: ${col}`);
        return row[col];
      },
      async run() { await tick(); return runNow(sql, params); },
      async all() { await tick(); return runNow(sql, params); },
      _parts() { return { sql, params }; },
    };
  }

  return {
    prepare(sql) { return stmt(String(sql), []); },
    async batch(stmts) {
      await tick();
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => { const { sql, params } = s._parts(); return runNow(sql, params); });
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql) {
      await tick();
      db.exec(String(sql));
      return { count: String(sql).split(';').filter((s) => s.trim()).length };
    },
    close() { if (open) { open = false; db.close(); } },   // 2回呼んでもよい
  };
}

module.exports = { makeFakeD1 };
