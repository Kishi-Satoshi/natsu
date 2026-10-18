/*
 * sqlite-probe.js — 配る Electron で node:sqlite・FTS5 trigram・backup() が使えるかを確かめる（第0c回 EL8・C5。RF13）
 *
 * 議事録の DB（第2a1回）は node:sqlite・FTS5 の trigram・backup() に頼る。Electron の版によっては、これが
 * 抜けている（35.0.0 の FTS5 抜け、37.2.0 の読み込めない版）。CI（ci.yml の electron-smoke）とリリース
 * （release.yml の installer）で、node_modules の Electron と electron-builder が詰めた NaTsu.exe の両方に
 * 走らせ、どれかが無ければ止める。exe を Node として起動できること（RunAsNode。第15回の MCP が頼る）も同時に分かる。
 *
 * 走らせ方:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/sqlite-probe.js
 *   ELECTRON_RUN_AS_NODE=1 dist/win-unpacked/NaTsu.exe tools/sqlite-probe.js
 * 頭に「Electron <版>／Node <版>／<platform>」の1行、続けて次の 4 つを 1 行ずつ OK／NG で出す。
 *   1. node:sqlite が読め、select sqlite_version() が返る
 *   2. 一時フォルダ（日本語と 𠮷 の名前）のファイルに表を作り、書いて読める
 *   3. FTS5 の trigram の表に「予算案の作成について会議する」を入れ、"予算案" で 1 件見つかる
 *   4. backup() の写しを開いて、2 と同じ行が読める
 * 4 つとも OK なら終了コード 0、そうでなければ 1（exitCodeOf）。頼る段が NG なら、その段は確かめずに NG にする
 * （2・3・4 は 1 に、4 は 2 に頼る。3 と 4 は互いに頼らない）。例外では止まらない。
 *
 * 確かめの本体（probe）は、読み込み（load）と一時フォルダの置き場所（tmp）を引数でもらう。
 * テスト（test/sqlite-probe.test.js）は、足りない Electron を偽物で作って NG になることを見る。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const COUNT = 4;
const SKIPPED = '（前の段が NG のため確かめていない）';
const ROW = '議事録の一行目 𠮷';
const TEXT = '予算案の作成について会議する';

const msgOf = (e) => (e && e.message) || String(e);

/** 開いた接続を閉じる（Windows でファイルを掴んだままにしない）。閉じるときの失敗は結果に混ぜない */
function closeAll(dbs) {
  for (const db of dbs.splice(0)) { try { db.close(); } catch (_) { /* 既に閉じている */ } }
}

/**
 * 4 つの確かめを順に行う。
 * @returns {Promise<Array<{ n: number, ok: boolean, line: string }>>}
 */
async function probe({ load = (m) => require(m), tmp = os.tmpdir() } = {}) {
  const out = [];
  const ok = (n, what) => out.push({ n, ok: true, line: `OK ${n} ${what}` });
  const ng = (n, what) => out.push({ n, ok: false, line: `NG ${n} ${what}` });
  const passed = (n) => out.some((x) => x.n === n && x.ok);
  const open = [];
  let sqlite = null;
  let dir = null;
  let file = '';

  try {
    // 1. 読み込みと SQLite の版
    try {
      sqlite = load('node:sqlite');
      const db = new sqlite.DatabaseSync(':memory:');
      open.push(db);
      const v = db.prepare('select sqlite_version() as v').get().v;
      ok(1, `node:sqlite を読めた（SQLite ${v}）`);
    } catch (e) {
      ng(1, `node:sqlite を読めない: ${msgOf(e)}`);
    } finally { closeAll(open); }

    // 2. ファイルの表に書いて読む
    if (!passed(1)) ng(2, `ファイルの表 ${SKIPPED}`);
    else {
      try {
        dir = fs.mkdtempSync(path.join(tmp, 'natsu-sqlite-確かめ𠮷-'));
        file = path.join(dir, '議事録.db');
        const db = new sqlite.DatabaseSync(file);
        open.push(db);
        db.exec('create table t(id integer primary key, x text)');
        db.prepare('insert into t(x) values (?)').run(ROW);
        const got = db.prepare('select x from t where id = 1').get();
        if (!got || got.x !== ROW) throw new Error(`読み返した行が違う: ${JSON.stringify(got)}`);
        ok(2, 'ファイルの表に書いて読めた');
      } catch (e) {
        ng(2, `ファイルの表に書いて読めない: ${msgOf(e)}`);
      } finally { closeAll(open); }
    }

    // 3. FTS5 の trigram（表は db.exec で作る）
    if (!passed(1)) ng(3, `FTS5 trigram ${SKIPPED}`);
    else {
      try {
        const db = new sqlite.DatabaseSync(':memory:');
        open.push(db);
        db.exec("create virtual table f using fts5(x, tokenize='trigram')");
        db.prepare('insert into f(x) values (?)').run(TEXT);
        const c = db.prepare(`select count(*) as c from f where f match '"予算案"'`).get().c;
        if (Number(c) !== 1) throw new Error(`"予算案" で ${c} 件（1 件のはず）`);
        ok(3, 'FTS5 trigram で "予算案" が 1 件見つかった');
      } catch (e) {
        ng(3, `FTS5 trigram が使えない: ${msgOf(e)}`);
      } finally { closeAll(open); }
    }

    // 4. backup() の写し（1 と 2 に頼る。3 には頼らない）
    if (!passed(1) || !passed(2)) ng(4, `backup() ${SKIPPED}`);
    else {
      try {
        if (typeof sqlite.backup !== 'function') throw new Error('backup() が無い');
        const copy = path.join(dir, '写し.db');
        const src = new sqlite.DatabaseSync(file);
        open.push(src);
        await sqlite.backup(src, copy);
        const dst = new sqlite.DatabaseSync(copy);
        open.push(dst);
        const got = dst.prepare('select x from t where id = 1').get();
        if (!got || got.x !== ROW) throw new Error(`写しの行が違う: ${JSON.stringify(got)}`);
        ok(4, 'backup() の写しから同じ行が読めた');
      } catch (e) {
        ng(4, `backup() が使えない: ${msgOf(e)}`);
      } finally { closeAll(open); }
    }
  } finally {
    closeAll(open);
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 消せなくても結果は変えない */ } }
  }
  return out;
}

/** 4 件そろって全部 OK なら 0、そうでなければ 1 */
function exitCodeOf(results) {
  return Array.isArray(results) && results.length === COUNT && results.every((x) => x && x.ok === true) ? 0 : 1;
}

if (require.main === module) {
  const v = process.versions;
  console.log(`Electron ${v.electron || 'なし'}／Node ${v.node}／${process.platform}`);
  probe().then((r) => {
    for (const x of r) console.log(x.line);
    process.exitCode = exitCodeOf(r);
  }, (e) => {
    console.log(`NG 0 確かめが途中で止まった: ${msgOf(e)}`);
    process.exitCode = 1;
  });
}

module.exports = { probe, exitCodeOf };
