/*
 * server.js — 議事録の DB のプロセス（utilityProcess・NaTsu DB）の口のつなぎ（第2a1回 ST2・ST5・ST7・T4b）
 *
 * Electron を読まない。process.parentPort（Electron の形: on('message', ({ data, ports }) …)・postMessage）とのつなぎだけで、
 * 中身は core（命令の台）・migrate（移行と取り込み）・snapshot（控えと戻し）に任せる。テストは startServer({ parentPort }) に偽物を渡す。
 *
 * startServer({ parentPort, sqlite, now, runCheck, env, fs, waits })
 *   main → 子（parentPort）: { type: 'init', dataDir, labels, network } / { type: 'port', role: 'app' | 'main' } ＋ ports[0]
 *                             / { type: 'migrate', go: true } / { type: 'close' }
 *   子 → main: { type: 'ready', state: 'ok' | 'newer' | 'failed', version, journal, selfTest, pid } / { type: 'migrate-plan', counts }
 *              / { type: 'progress', done, total } / { type: 'log', line } / { type: 'closed' }
 *   口の上: 頼み { id, cmd, args, tx? } → 返事 { id, ok: true, result } | { id, ok: false, code, retry }。
 *           書けたら全部の口に { event: 'changed', pageIds, actor, what? }（what は Claude の命令 mcp.* の道具の印: 0.18.0 CS-2）。
 *   main → 子: 0.18.0 CS-2 の { type: 'making', ids }（main が要約を作っている間のページ。覚えるだけで書かない。mcp.writeSummary が locked で断る）。
 *   口ごとの役は main が port の知らせで付ける（頼みの中で役を名乗っても変わらない: 役は core.call に口の役だけを渡す）。
 *   0.18.0 CW-2（計画 docs/plans/2026-11-18-180.md の決めたこと 1〜5・F230・F231）: ready の state が ok のときだけ、Claude の書き込みの口（door.js。
 *   名前付きパイプと合い言葉・扉の紙 natsu.door）を開き、握手した口を役 mcp で役の表に入れる（main は口を作らず、頼みを中継しない）。
 *   起動の頭で前の起動の扉の紙（と一時ファイル natsu.door.<番号>.tmp: 点検 1）を消し、close で口を閉じて紙を消す。door（startServer の引数。テストだけ）は
 *   startDoor の platform・rand・limits。点検 1・AQ36 (a): init の network が真（DB のフォルダがネットワークの場所）なら口を開かず紙も書かない。
 *   口は用意の前（移行の窓の答え待ち・移行中）でも受け、頼みは用意ができるまで届いた順に待たせる。口が close したら役の表から外す。
 *   頼みの形が違う（物でない・id が数でない・cmd が文字でない・args が物でない）・JSON にできない・JSON で 1MB を超えるものは bad-args。
 *
 * init の順:
 *   1. 記録「DB: 起動（番号 <pid>）」。前の起動の残りの natsu.db.lock を消す（書き手はこのプロセスだけなので、残っているのは落ちた跡）。
 *   2. natsu.db が無いとき（0 バイトのときも）: data/backup/ に控えがあるか natsu.db.broken-* があれば、移し直さずに snapshot.recover（一度移した後に
 *      natsu.db が無くなった。JSON から移し直すと移行の後の会議が見えなくなる: F8。0 バイトのものは recover が broken-* へ退ける）。
 *      戻せなければ state failed。
 *      控えも退けたものも無く pages/ に JSON があれば migrate-plan（migrate.plan の数）を送って migrate を待つ。どちらも無ければ空の DB を作る。
 *   3. migrate は withLock の中で migrate.migrate（progress を送る）。合わなければ state failed（natsu.db は作られない。元の JSON はそのまま）。
 *   4. core.open。開けず、素の接続で開き直して classifyOpenError が corrupt（SQLITE_CORRUPT・NOTADB）なら recover、ほかは state failed で
 *      ファイルに触れない（F12）。開けたら（state ok のとき）meta.cleanShutdown を '0' にし、前の値が '0'（落ちた）なら runCheck
 *      （既定は check-worker の worker）で確かめ、checkResult が corrupt のときだけ接続を閉じて recover（unavailable は記録だけして進む）。
 *      meta.jsonMigration があって移行の控えが無ければ（移した直後・落ちた後）、頼みを1つも受ける前にここで snapshot.take（migration）。
 *      開けた後のこの meta の読み書きで SQLITE_CORRUPT・NOTADB が出たら（頁が壊れている）、この起動でまだ戻していなければ
 *      接続を閉じて recover（why 'open'）し、開き直して1度だけやり直す。ほかの誤りは state failed。
 *   4b. 0.18.0 CW-1（計画 docs/plans/2026-11-18-180.md の決めたこと 9・F232）: core.open は upgrade: false で開く。版が低い（state old）なら、
 *      withLock の中で確かめ済みの控え（upgrade）を1つ取り、取れたときだけ core.upgradeTo で版を上げる。取れなければ上げずに state failed
 *      （「DB: 版を上げる前の控えが取れない（<符号>）」。次の起動でやり直す）。順は 開く → 控え → 版を上げる → 取り込みと 0.17.0 の見回り。
 *   5. migrate.reimport を回し（skippedSig を meta.reimportSkipped と比べて、違えば書き直す）、ready を送ってから待たせた頼みを流す。
 *   state newer（新しい版の NaTsu の DB）は読み取り専用なので、meta も取り込みも書かない。
 *   state failed の間は、子は生きたまま全部の頼みに { ok: false, code: 'unavailable', retry: false } を返す。
 * close: 控えを取っている途中ならその終わりを待ち、meta.cleanShutdown を '1' にしてから wal_checkpoint(TRUNCATE)、閉じて closed を送る
 *   （書いた後にチェックポイントするので、-wal は空で残る）。その後の頼みは unavailable。
 *
 * main だけの命令（core の命令の表の外。DB のプロセスが持つもの）:
 *   db.status({}) → { state, version, journal, selfTest, pid, lastSnapshot: { at, kind } | null,
 *                     startup: { migrated: counts | null, restored: { from, why: 'missing'|'open'|'check' } | null, reimport } }
 *     startup はこの起動で起きたこと（知らせ D2・D5・D3・D6 の材料）。reimport は migrate.reimport の答えから skippedSig を除き、
 *     skippedChanged（飛ばしたファイルの組が前の起動と違う。前が無ければ真。ただし移した起動ではいつも偽: D3 は移行の数で出す）を
 *     足したもの | null（回せなかった）。
 *   db.reimport({}) → 同じ形の取り込みの答え（今もう一度回す）
 *   snapshot.take({ kind: 'daily' | 'migration' | 'upgrade' }) → { ok, check, removed, pruned }
 *     控えを取り（1つずつ）、取れたら回して（rotate）、残る毎日・毎週の控えより前の oplog を消す（pruneOplog。purge の行は残す）。
 *     meta.lastSnapshot に { at, kind } を書く。
 * 記録（log）に書くのは件数・符号・版だけ（本文・題名・ID・パスは書かない）。
 * 試しの環境変数（mainrun の場面だけが使う）: NATSU_TEST_MIGRATE_DELAY_MS（移行のファイル1つごとに止まる ms。移行の間の録音の場面）、
 *   NATSU_TEST_MIGRATE_VERIFY_FAIL=1（移行の確かめを合わなかったことにする。D4 の場面）。
 */
'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./core');
const C = require('./commands');
const M = require('./migrate');
const S = require('./snapshot');
const V = require('./validate');
const Door = require('./door');

const DB_NAME = 'natsu.db';
const ROLES = ['app', 'main'];
const SNAPSHOT_KINDS = ['daily', 'migration', 'upgrade'];
const MAX_DELAY_MS = 60000;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const codeOf = (e) => (e && typeof e.code === 'string' && e.code) || 'unknown';
const noSelfTest = () => ({ sqlite: '', trigram: false });

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startServer({ parentPort, sqlite, now = () => new Date(), runCheck = S.workerCheck, env = process.env, fs = nodeFs, waits, door: doorOpts = {} } = {}) {
  let phase = 'idle';   // idle → starting → migrate-wait → migrating → ready | failed → closed
  let dataDir = null;
  let labels = {};
  let network = false;
  let db = null;
  let opened = null;    // core.open の答え（db を除く）
  let lastSelfTest = noSelfTest();
  const ports = new Map();   // 口 → 役
  const pending = [];        // 用意の前に届いた頼み [口, 頼み]
  const startup = { migrated: null, restored: null, reimport: null, minutes: null };
  let life = Promise.resolve();   // init・migrate・close を1つずつ
  let snapChain = Promise.resolve();   // 控えを1つずつ
  let door = null;   // 0.18.0 CW-2: Claude の書き込みの口（ready の ok の後だけ）
  let making = new Set();   // 0.18.0 CS-2（決めたこと 17）: main が要約を作っている間のページ（{ type: 'making', ids }。覚えるだけで書かない）

  const post = (m) => { try { parentPort.postMessage(m); } catch (_) { /* main が居ない */ } };
  const log = (line) => post({ type: 'log', line });
  const enqueue = (fn) => { life = life.then(fn).catch((e) => { log(`DB: 思わぬ失敗（${codeOf(e)}）`); if (phase !== 'closed') fail('internal'); }); };
  const dbFile = () => path.join(dataDir, DB_NAME);
  // ふつうのファイルなら大きさ、無い・見えなければ null、フォルダなどほかのものは -1（Windows ではフォルダの大きさが 0 なので、0 と分ける）
  const sizeOf = (p) => { try { const st = fs.lstatSync(p); return st.isFile() ? st.size : -1; } catch (_) { return null; } };
  const waitOpt = waits ? { waits } : {};

  // ---------------------------------------------------------------- meta
  const getMeta = (key) => {
    const r = db.prepare('select value from meta where key = ?').get(key);
    return r ? r.value : undefined;
  };
  const setMeta = (key, value) => {
    db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
  };

  function closeDb() {
    if (db) { try { db.close(); } catch (_) { /* 閉じ済み */ } }
    db = null;
  }

  // ---------------------------------------------------------------- 返事・知らせ
  function reply(port, id, out) {
    try { port.postMessage({ id, ...out }); } catch (_) { /* 口が閉じた */ }
  }
  function broadcast(evt) {
    for (const p of ports.keys()) { try { p.postMessage(evt); } catch (_) { /* 閉じた口 */ } }
  }
  const failOut = (code, retry = false) => ({ ok: false, code, retry });

  function fail(code) {
    closeDb();
    phase = 'failed';
    log(`DB: 使えない（${code}）`);
    post({ type: 'ready', state: 'failed', version: null, journal: null, selfTest: lastSelfTest, pid: process.pid });
    drain();
  }

  function drain() {
    for (const [port, data] of pending.splice(0)) onRequest(port, data);
  }

  // ---------------------------------------------------------------- 頼み
  function onRequest(port, data) {
    if (phase === 'failed' || phase === 'closed') { reply(port, idOf(data), failOut('unavailable')); return; }
    if (phase !== 'ready') { pending.push([port, data]); return; }
    if (!ports.has(port)) return;   // 待っている間に閉じた口
    const role = ports.get(port);
    const id = idOf(data);
    if (id === null || typeof data.cmd !== 'string' || !isObj(data.args) || (data.tx !== undefined && typeof data.tx !== 'string')) {
      reply(port, id, failOut('bad-args'));
      return;
    }
    let size;
    try { size = Buffer.byteLength(JSON.stringify(data), 'utf8'); } catch (_) { size = Infinity; }
    if (!(size <= V.LIMITS.bytes)) { reply(port, id, failOut('bad-args')); return; }

    if (Object.hasOwn(OWN, data.cmd)) {
      if (role !== 'main') { reply(port, id, failOut('forbidden')); return; }
      Promise.resolve().then(() => OWN[data.cmd](data.args))
        .then((out) => reply(port, id, out), () => reply(port, id, failOut('internal')));
      return;
    }
    const r = core.call(db, { role, cmd: data.cmd, args: data.args, tx: data.tx }, { now, labels, log, making });
    if (!r.ok) { reply(port, id, failOut(r.code, r.retry === true)); return; }
    // 0.14.0 EB-2（決めたこと 6・R59・R75）: 何か変えた命令（と、その送り直し）の答えだけに changed（画面の元に戻すの1歩）
    reply(port, id, r.changed || r.dupChanged ? { ok: true, result: r.result, changed: true } : { ok: true, result: r.result });
    if (r.changed) broadcast({ event: 'changed', pageIds: r.changed.pageIds, actor: r.changed.actor, ...(r.changed.what ? { what: r.changed.what } : {}) });   // 0.18.0 CS-2: Claude の命令は what
    if (r.changed && SWEEP_AFTER.includes(`${role} ${data.cmd}`)) sweepMinutes();   // 0.17.0 MG-2（決めたこと 48）: 締め・復旧の後の見回り
  }
  // 0.17.0 点検 2（rv59 軽い 2・R47）: 画面の page.restore（ゴミ箱から最上位に戻した議事録）の後も見回る
  const SWEEP_AFTER = Object.freeze(['main meeting.finalize', 'main meeting.recover', 'app page.restore']);

  const idOf = (data) => (isObj(data) && typeof data.id === 'number' && Number.isFinite(data.id) ? data.id : null);

  // main だけの命令（DB のプロセスが持つもの）
  const OWN = Object.freeze(Object.assign(Object.create(null), {
    'db.status': async (args) => {
      if (Object.keys(args).length) return failOut('bad-args');
      let last = null;
      try { const v = getMeta('lastSnapshot'); last = v === undefined ? null : JSON.parse(v); } catch (_) { last = null; }
      return { ok: true, result: { ...stateOf(), lastSnapshot: last, startup: { ...startup } } };
    },
    'db.reimport': async (args) => {
      if (Object.keys(args).length) return failOut('bad-args');
      if (opened.state !== 'ok') return failOut('read-only');
      const r = runReimport();
      return r ? { ok: true, result: r } : failOut('internal');
    },
    'snapshot.take': async (args) => {
      if (Object.keys(args).length !== 1 || !SNAPSHOT_KINDS.includes(args.kind)) return failOut('bad-args');
      return { ok: true, result: await takeSnapshot(args.kind) };
    },
  }));

  const stateOf = () => ({ state: opened.state, version: opened.version, journal: opened.journal, selfTest: opened.selfTest, pid: process.pid });

  // ---------------------------------------------------------------- 控え・取り込み
  function takeSnapshot(kind) {
    const p = snapChain.then(async () => {
      if (!db) return { ok: false, check: 'io', removed: 0, pruned: 0 };
      const r = await S.take({ sqlite, db, dataDir, kind, now, runCheck, fs, log });
      let removed = 0;
      let pruned = 0;
      if (r.ok && db) {
        try { setMeta('lastSnapshot', JSON.stringify({ at: now().toISOString(), kind })); } catch (e) { log(`DB: 控えの時刻を書けない（${codeOf(e)}）`); }
        try { removed = S.rotate({ dataDir, fs, log }).length; } catch (e) { log(`DB: 控えを回せない（${codeOf(e)}）`); }
        try { pruned = S.pruneOplog({ db, before: S.oldestKeptAt({ dataDir, fs }) }); } catch (e) { log(`DB: 操作の列を消せない（${codeOf(e)}）`); }
      }
      return { ok: r.ok, check: r.check, removed, pruned };
    });
    snapChain = p.catch(() => {});
    return p;
  }

  function runReimport() {
    try {
      const r = M.reimport({ db, dataDir, fs, now });
      const sig = JSON.stringify(r.skippedSig);
      const differs = getMeta('reimportSkipped') !== sig;
      if (differs) setMeta('reimportSkipped', sig);
      // 移した起動では、飛ばしたものの知らせ D3 は移行の数（startup.migrated）で出すので、直後の取り込みでは偽（2回出さない）
      const skippedChanged = differs && startup.migrated === null;
      log(`DB: 取り込み 新しい ${r.added}・置き換え ${r.replaced}・別に足した ${r.copied}`);
      const { skippedSig: _sig, ...rest } = r;
      return { ...rest, skippedChanged };
    } catch (e) {
      log(`DB: 取り込みができない（${codeOf(e)}）`);
      return null;
    }
  }

  // 0.17.0 MG-2（計画 docs/plans/2026-11-13-170.md の決めたこと 47・48・F193）: 取り込みの後に、議事録を「議事録」データベースへ。
  // 初めて（meta の minutes.gathered が無い）は、移す議事録があれば確かめ済みの控え（upgrade）を取ってから minutes.gather（first）。控えが取れなければ
  // 移さず（meta も書かない）、次の起動でやり直す。2回目からは控えを取らずに、移す議事録があるときだけ見回り（minutes.gather）。初めてでも移す物が無く
  // 「議事録」がもうある（締めが作った）ときは、命令を送らずに meta の minutes.gathered（数 0）だけを書く（空の oplog の行を積まない）。記録には数だけ（題名は書かない）
  // → { first, moved, skipped, created, db } | { failed: true }（db.status の startup.minutes。最初の起動の知らせの材料: MG-4）
  async function gatherMinutes() {
    try {
      const first = getMeta('minutes.gathered') === undefined;
      const st = C.minutesState(db);
      if (!st.pending && (!first || (st.hasDb && st.hasTasks))) {   // 0.17.0 TK-1: 最初の起動で「タスク管理」が無ければ作る
        if (first) setMeta('minutes.gathered', JSON.stringify({ n: 0, at: now().toISOString() }));
        return { first, moved: 0, skipped: 0, created: false, db: null };
      }
      if (first && st.pending) {
        const snap = await takeSnapshot('upgrade');
        if (!snap.ok) { log(`DB: 議事録をまとめる前の控えを取れない（${snap.check}）。次の起動でやり直す`); return { failed: true }; }
      }
      const r = core.call(db, { role: 'main', cmd: 'minutes.gather', args: first ? { first: true } : {}, tx: `m:minutes-${crypto.randomUUID()}` }, { now, labels, log });
      if (!r.ok) { log(`DB: 議事録をまとめられない（${r.code}）`); return { failed: true }; }
      const g = r.result;
      if (first || g.moved || g.skipped) log(`DB: 議事録 移した ${g.moved}・残した ${g.skipped}${g.created ? '・データベースを作った' : ''}`);
      return { first, ...g };
    } catch (e) {
      log(`DB: 議事録をまとめられない（${codeOf(e)}）`);
      return { failed: true };
    }
  }

  // 0.17.0 MG-2（決めたこと 48）: 締め・復旧の後の見回り。最初の移し替えが済んでいて（meta の minutes.gathered がある）、最上位に締めた議事録が残って
  // いれば（0.16.0 に戻して録音した会議など）、締めとは別の命令（minutes.gather。1つのトランザクション・actor system）で「議事録」に入れて全部の口に知らせる。
  // 最初の移し替えの前（控えが取れずに待っている間）は動かさない（確かめ済みの控えの前に今までの議事録を動かさない: 決めたこと 47）
  function sweepMinutes() {
    try {
      if (getMeta('minutes.gathered') === undefined || !C.minutesState(db).pending) return;
      const g = core.call(db, { role: 'main', cmd: 'minutes.gather', args: {}, tx: `m:minutes-${crypto.randomUUID()}` }, { now, labels, log });
      if (!g.ok) { log(`DB: 議事録を見回れない（${g.code}）`); return; }
      log(`DB: 議事録 移した ${g.result.moved}・残した ${g.result.skipped}${g.result.created ? '・データベースを作った' : ''}`);
      if (g.changed) broadcast({ event: 'changed', pageIds: g.changed.pageIds, actor: g.changed.actor });
    } catch (e) {
      log(`DB: 議事録を見回れない（${codeOf(e)}）`);
    }
  }

  async function recover(why) {
    closeDb();
    const r = await S.recover({ sqlite, dataDir, now, runCheck, fs, log, reimport: false, ...waitOpt });
    if (!r.ok) { fail(r.code); return false; }
    startup.restored = { from: r.from, why };
    return true;
  }

  // 開けなかった理由を、素の読み取り専用の接続で開き直して分ける（壊れていると分かったときだけ corrupt: F8・F12）
  function classify(file) {
    let c = null;
    try {
      c = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 1000 });
      c.prepare('select count(*) n from sqlite_master').get();
      return 'unavailable';
    } catch (e) {
      return S.classifyOpenError(e);
    } finally {
      if (c) { try { c.close(); } catch (_) { /* 閉じ済み */ } }
    }
  }

  function tryOpen() {
    const o = core.open({ sqlite, file: dbFile(), network, upgrade: false });   // 0.18.0 CW-1: 版は控えを取ってから上げる（upgradeOld）
    if (o.selfTest) lastSelfTest = o.selfTest;
    if (o.db) {
      log(`DB: SQLite ${o.selfTest.sqlite}・trigram ${o.selfTest.trigram ? 'OK' : 'NG'}・表の形 v${o.version}・${o.journal}`);
    } else if (o.code === 'selftest') {
      log(`DB: SQLite ${o.selfTest.sqlite}・trigram NG（使えない）`);
    }
    return o;
  }

  // 書ける接続か（版の低い old も、版を上げる前に meta と控えを読み書きする）
  const writable = (state) => state === 'ok' || state === 'old';

  // 開けた（o.db がある）DB を使い始める。戻せずに終えた（fail 済み）なら false。SQLite の誤りは投げる
  async function useOpened(o, restored) {
    db = o.db;
    opened = { state: o.state, version: o.version, journal: o.journal, selfTest: o.selfTest };
    if (writable(o.state)) {
      const prev = getMeta('cleanShutdown');
      setMeta('cleanShutdown', '0');
      if (prev === '0' && !restored) {
        // きれいに閉じなかった（落ちた・シャットダウン・強制終了）: 確かめが最後まで走って壊れていたときだけ戻す（ST7・F8）
        const r = S.checkResult(await runCheck({ file: dbFile() }));
        if (r === 'corrupt') {
          if (!(await recover('check'))) return false;
          o = tryOpen();
          if (!o.db) { fail(o.code || 'open'); return false; }
          db = o.db;
          opened = { state: o.state, version: o.version, journal: o.journal, selfTest: o.selfTest };
          if (writable(o.state)) setMeta('cleanShutdown', '0');
        } else if (r === 'unavailable') {
          log('DB: 落ちた後の確かめを走らせられない。開いたまま進む');
        } else {
          log('DB: 落ちた後の確かめ ok');
        }
      }
    }
    if (writable(opened.state)) {
      // 移した直後の中身だけを持つ控え（頼みを1つも受ける前。移した直後に落ちていたら、次の起動のここで取る）
      if (getMeta('jsonMigration') !== undefined && !S.listBackups({ dataDir, fs }).some((b) => b.kind === 'migration')) {
        await takeSnapshot('migration');
      }
    }
    return true;
  }

  async function openAndServe() {
    let o = tryOpen();
    if (!o.db) {
      if (o.code !== 'open' || classify(dbFile()) !== 'corrupt') { fail(o.code || 'open'); return; }
      if (!(await recover('open'))) return;
      o = tryOpen();
      if (!o.db) { fail(o.code || 'open'); return; }
    }
    try {
      if (!(await useOpened(o, startup.restored !== null))) return;
    } catch (e) {
      // 開けた後に meta などを読み書きして壊れていると分かった（頁が壊れている）。この起動でまだ戻していなければ1度だけ戻す（F8）
      if (startup.restored !== null || S.classifyOpenError(e) !== 'corrupt') throw e;
      log(`DB: 開いた後に壊れていると分かった（${codeOf(e)}）`);
      if (!(await recover('open'))) return;
      o = tryOpen();
      if (!o.db) { fail(o.code || 'open'); return; }
      if (!(await useOpened(o, true))) return;
    }
    if (opened.state === 'old' && !(await upgradeOld())) return;   // 0.18.0 CW-1（F232）: 開く → 控え → 版を上げる → 取り込みと見回り
    if (opened.state === 'ok') startup.reimport = runReimport();
    if (opened.state === 'ok') startup.minutes = await gatherMinutes();
    phase = 'ready';
    post({ type: 'ready', ...stateOf() });
    drain();
    if (opened.state === 'ok') openDoor();   // 0.18.0 CW-2（決めたこと 2・F230）: 書けない DB（newer・failed）に頼ませない
  }

  // 0.18.0 CW-2: 握手した口は役 mcp（頼みの中で名乗っても変わらない）。頼みは今の口と同じ受け口
  function openDoor() {
    // 点検 1・AQ36 (a)「共有のときは口を開かない」: DB のフォルダがネットワークの場所なら口を開かず紙も書かない（パスは記録に書かない）
    if (network) { log('DB: 書き込みの口を開かない（ネットワークの場所）'); return; }
    door = Door.startDoor({
      ...doorOpts, dataDir, fs, log,
      onOpen: (port) => ports.set(port, 'mcp'),
      onClose: (port) => ports.delete(port),
      onRequest: (port, data) => onRequest(port, data),
    });
  }

  // 0.18.0 CW-1（決めたこと 9・F232）: 版の低い DB は、確かめ済みの控え（upgrade）を取ってから版を上げる（natsu.db.lock の中で。MCP の読み手は待つ）。
  // 控えが取れなければ上げずに state failed（次の起動でやり直す）。上げられたら state ok・今の版
  async function upgradeOld() {
    let r;
    try {
      r = await S.withLock(dataDir, async () => {
        const snap = await takeSnapshot('upgrade');
        if (!snap.ok) return { ok: false, code: snap.check, snap: true };
        return core.upgradeTo(db);
      }, { fs, log });
    } catch (e) {
      r = { ok: false, code: codeOf(e), snap: true };   // 点検 1（CR51）: natsu.db.lock を書けない（控えを取る前に止まった）も「控えが取れない」。版は 1 のまま
    }
    if (!r.ok) {
      log(r.snap ? `DB: 版を上げる前の控えが取れない（${r.code}）` : `DB: 版を上げられない（${r.code}）`);
      fail(r.snap ? 'upgrade-backup' : r.code);
      return false;
    }
    opened = { ...opened, state: 'ok', version: r.version };
    log(`DB: 表の形を v${r.version} に上げた`);
    return true;
  }

  async function init(msg) {
    if (phase !== 'idle') return;
    phase = 'starting';
    dataDir = String(msg.dataDir || '');
    labels = isObj(msg.labels) ? msg.labels : {};
    network = msg.network === true;
    log(`DB: 起動（番号 ${process.pid}）`);
    if (!dataDir) { fail('init'); return; }
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) { /* 無ければ開くときに分かる */ }
    try { fs.unlinkSync(path.join(dataDir, S.LOCK_NAME)); } catch (e) {
      if (!e || e.code !== 'ENOENT') log(`DB: 前の lock を消せない（${codeOf(e)}）`);
    }
    // 0.18.0 CW-2（決めたこと 2・F230）: 前の起動の扉の紙（残っているのは落ちた跡。書く道具を、もういない口へつながせない）
    try { fs.unlinkSync(path.join(dataDir, Door.DOOR_NAME)); } catch (e) {
      if (!e || e.code !== 'ENOENT') log(`DB: 前の扉の紙を消せない（${codeOf(e)}）`);
    }
    // 点検 1（CR49）: 前の起動の扉の紙の一時ファイル（合い言葉を持つ。書く途中で落ちた跡）も消す
    let doorTmps = [];
    try { doorTmps = fs.readdirSync(dataDir).filter((x) => Door.TMP_RE.test(x)); } catch (_) { doorTmps = []; }
    for (const x of doorTmps) {
      try { fs.unlinkSync(path.join(dataDir, x)); } catch (e) { if (!e || e.code !== 'ENOENT') log(`DB: 前の扉の紙を消せない（${codeOf(e)}）`); }
    }
    const size = sizeOf(dbFile());
    if (size === null || size === 0) {
      let names = [];
      try { names = fs.readdirSync(dataDir); } catch (_) { names = []; }
      const once = S.listBackups({ dataDir, fs }).length > 0 || names.some((n) => n.startsWith(`${DB_NAME}.broken-`));
      if (once) {
        // 一度移した後に natsu.db が無くなった: 移し直さずに控えから戻す（F8）。0 バイトの natsu.db も無いのと同じ
        // （空の DB として使うと移した後の会議が見えず、空の控えが良い控えを回して消す）。recover が natsu.db.broken-* へ退ける（消さない）
        if (!(await recover('missing'))) return;
      } else if (size === null && hasJson()) {
        const counts = M.plan(dataDir, { fs });
        phase = 'migrate-wait';
        post({ type: 'migrate-plan', counts });
        return;
      }
    }
    await openAndServe();
  }

  function hasJson() {
    try { return fs.readdirSync(path.join(dataDir, 'pages')).some((n) => n.endsWith('.json')); } catch (_) { return false; }
  }

  async function runMigrate(msg) {
    if (phase !== 'migrate-wait') return;
    if (!msg || msg.go !== true) { log('DB: 移さずに待つ'); return; }
    phase = 'migrating';
    const delay = Number(env && env.NATSU_TEST_MIGRATE_DELAY_MS);
    const verifyFail = Boolean(env) && env.NATSU_TEST_MIGRATE_VERIFY_FAIL === '1';
    const onProgress = (done, total) => {
      post({ type: 'progress', done, total });
      if (Number.isInteger(delay) && delay > 0) sleepSync(Math.min(delay, MAX_DELAY_MS));
    };
    let r;
    try {
      r = S.withLock(dataDir, () => M.migrate({ sqlite, dataDir, onProgress, fs, now, verifyHook: verifyFail ? () => false : undefined }), { fs, log });
    } catch (e) {
      r = { ok: false, code: codeOf(e) };
    }
    if (!r.ok) { fail(`migrate-${r.code}`); return; }
    const c = r.counts;
    startup.migrated = { ...c };
    log(`DB: 移行 ページ ${c.pages}・発言 ${c.segments}・飛ばした ${c.broken + c.unreadable + c.badId + c.badShape}（${(r.ms / 1000).toFixed(1)}秒）`);
    await openAndServe();
  }

  async function close() {
    if (door) { const d = door; door = null; await d.close(); }   // 0.18.0 CW-2: 先に口を閉じて紙を消す（閉じる間に Claude の頼みを受けない）
    await snapChain;
    if (db && opened && opened.state === 'ok') {
      try { setMeta('cleanShutdown', '1'); } catch (e) { log(`DB: 閉じる印を書けない（${codeOf(e)}）`); }
      try { db.exec('pragma wal_checkpoint(TRUNCATE)'); } catch (e) { log(`DB: チェックポイントを飛ばした（${codeOf(e)}）`); }
    }
    closeDb();
    phase = 'closed';
    drain();
    post({ type: 'closed' });
  }

  function addPort(role, port) {
    if (!ROLES.includes(role) || !port || typeof port.on !== 'function') { log('DB: 役か口の無い port の知らせ'); return; }
    ports.set(port, role);
    port.on('message', (e) => onRequest(port, e ? e.data : undefined));
    port.on('close', () => ports.delete(port));
    if (typeof port.start === 'function') port.start();
  }

  parentPort.on('message', (e) => {
    const data = e ? e.data : undefined;
    if (!isObj(data)) return;
    if (data.type === 'init') enqueue(() => init(data));
    else if (data.type === 'port') addPort(data.role, Array.isArray(e.ports) ? e.ports[0] : undefined);
    else if (data.type === 'migrate') enqueue(() => runMigrate(data));
    else if (data.type === 'close') enqueue(() => close());
    else if (data.type === 'making') making = new Set(Array.isArray(data.ids) ? data.ids.filter((x) => typeof x === 'string') : []);   // 0.18.0 CS-2: 待たせずに覚える
  });
}

module.exports = { startServer };

// utilityProcess（Electron の子）として起こされたときだけ動く
if (process.parentPort) startServer({ parentPort: process.parentPort, sqlite: require('node:sqlite') });
