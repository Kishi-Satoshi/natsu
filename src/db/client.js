/*
 * client.js — main の客: 議事録の DB のプロセス（utilityProcess・NaTsu DB）を起こし、頼み、面倒を見る（第2a1回 ST2・ST7・RF10）
 *
 * Electron を読まない。fork（utilityProcess.fork の形）と Channel（MessageChannelMain の形）を引数で受けるので、
 * テストは偽の utilityProcess（test/helpers/fake-utility.js）の中で本物の server.js を動かす。
 *
 * makeDbClient({ fork, Channel, serverPath, init, log, timers = { setTimeout, clearTimeout }, now = Date.now, onEvent })
 *   → { start(), call(cmd, args, { tx, timeoutMs }) → Promise<result>, send(cmd, args) → undefined, rendererPort() → MessagePortMain | null,
 *       state() → 'starting' | 'migrating' | 'ready' | 'read-only' | 'down', onReady(fn), migrate(go), close({ timeoutMs }) → Promise }
 *   start: fork(serverPath, [], { serviceName: 'NaTsu DB' }) で子を起こし、{ type: 'init', dataDir, labels, network } と、
 *     自分用の口（役 main）を { type: 'port', role: 'main' } で渡す。
 *   call: 用意の前（starting・migrating）と起こし直しの間の頼みは待ち行列に入れ、時間切れは数えない。用意ができたら届いた順に送る。
 *     送った後の時間切れは読む命令 15 秒・書く命令 30 秒（retry で失敗）。書く命令の tx は呼び手が渡さなければ
 *     'm:' + cmd + ':' + 時刻 + 乱数 を作る（呼ぶたびに別）。失敗は Error（message は符号そのもの）に .code と .retry。
 *     客が自分で作る符号は 'db-down'（諦めた・閉じた。retry: false）と 'retry'（時間切れ。retry: true）。
 *   send: 返事を待たない書き込み（meeting.begin・meeting.segment）。失敗は中で受け止め、その会議（args.pageId。無ければ命令の名前）で
 *     1回だけ記録する（記録に ID は書かない）。未処理の reject を残さない。投げない。
 *   子が終わったら（44 では kill() でも番号 0 なので、止めたかは自分の印で見る）onEvent({ type: 'lost', code }) を出し、
 *     RESTART_MS の後に起こし直す。返事の無かった頼み（send のものも、読む命令も）を、送った順のまま同じ tx で送り直す
 *     （DB は (役, tx) で1回だけ効かせ、済んでいれば今の値を返す）。
 *   10 分に 5 回落ちたら諦める（'down'。記録「DB: 諦めた（10分に5回）」・onEvent({ type: 'down', why: 'crash' })）。
 *     子の ready が state 'failed' のときも 'down'（onEvent({ type: 'down', why: 'failed' })。子は生きたまま unavailable を返すので残す）。
 *     'down' になったら、待たせていた頼みも全部すぐ db-down で返す（締めを永遠に待たせない）。
 *   rendererPort: 画面用の口（役 app）を作って子に渡し、もう一方を返す。子が居ない（起こし直しの間・諦めた・閉じた）ときは null
 *     （起こし直したら onReady で配り直す）。
 *   onReady(fn): ready（state ok・newer）になるたびに fn(ready の知らせ) を呼ぶ。外す関数を返す。
 *   migrate(go): { type: 'migrate', go } を子へ。go が true なら覚えておき、移行の途中で子が落ちて起こし直した子がもう一度
 *     migrate-plan を送ってきたら、聞き直さずに go を送る（onEvent に auto: true を付けて知らせる）。
 *   close({ timeoutMs = 3000 }): 止めた印を立て、{ type: 'close' } を送って closed（か終わり）を待ち、kill() してその終わりを待つ。
 *     待ちはどれも timeoutMs まで。後の頼みは db-down。
 *   onEvent に渡すもの: { type: 'lost', code } / { type: 'down', why: 'crash' | 'failed' } / { type: 'migrate-plan', counts, auto }
 *     / { type: 'progress', done, total } / { type: 'changed', pageIds, actor }（DB が全部の口に流す知らせ。自分の口に来たもの）
 *   子の { type: 'log', line } は log(line) に渡す（engine.log へ）。
 */
'use strict';

const crypto = require('node:crypto');
const commands = require('./commands');

const RESTART_MS = Object.freeze([500, 1000, 2000, 4000, 8000]);
const GIVE_UP_WINDOW_MS = 10 * 60 * 1000;
const GIVE_UP_COUNT = 5;
const READ_TIMEOUT_MS = 15000;
const WRITE_TIMEOUT_MS = 30000;
const CLOSE_TIMEOUT_MS = 3000;
// core の命令の表の外で DB のプロセスが持つもののうち、書くもの（時間切れを書く命令の長さにする。tx は見ない）
const OWN_WRITES = new Set(['snapshot.take', 'db.reimport']);

const isTableWrite = (cmd) => typeof cmd === 'string' && Object.hasOwn(commands.COMMANDS, cmd) && commands.COMMANDS[cmd].write === true;
const isWrite = (cmd) => isTableWrite(cmd) || OWN_WRITES.has(cmd);

function dbError(code, retry) {
  const e = new Error(code);
  e.code = code;
  e.retry = retry;
  return e;
}

function makeDbClient({ fork, Channel, serverPath, init = {}, log = () => {}, timers = { setTimeout, clearTimeout }, now = Date.now, onEvent } = {}) {
  const T = timers || { setTimeout, clearTimeout };
  let phase = 'idle';      // idle → starting → (migrating) → ready | read-only | down
  let child = null;        // 今の子（生きている間だけ）
  let port = null;         // 自分用の口（役 main）
  let gen = 0;             // 起こした子の番号（前の子からの知らせを捨てる）
  let nextId = 0;
  const entries = new Map();   // id → 頼み（入れた順 = 送った順。起こし直したらこの順で送り直す）
  const crashes = [];          // 思わず終わった時刻
  let restartTimer = null;
  let stopping = false;        // 自分で止めた印（kill の番号は 0 なので、番号では分からない）
  let closing = null;
  let migrateGo = false;
  const readyFns = [];
  const closedWaiters = [];
  const exitWaiters = [];
  const sendLogged = new Set();

  const emit = (e) => { if (typeof onEvent === 'function') { try { onEvent(e); } catch (_) { /* 聞き手の誤りで客を止めない */ } } };
  const say = (line) => { try { log(line); } catch (_) { /* 記録できなくても続ける */ } };
  const newTx = (cmd) => `m:${cmd}:${Number(now()).toString(36)}:${crypto.randomBytes(4).toString('hex')}`;
  const canSend = () => (phase === 'ready' || phase === 'read-only') && port !== null;

  function settle(e, fn) {
    if (entries.get(e.id) !== e) return;
    entries.delete(e.id);
    if (e.timer) { T.clearTimeout(e.timer); e.timer = null; }
    fn();
  }

  function rejectAll(code, retry) {
    for (const e of [...entries.values()]) settle(e, () => e.reject(dbError(code, retry)));
  }

  function transmit(e) {
    e.sent = true;
    const req = { id: e.id, cmd: e.cmd, args: e.args };
    if (e.tx !== undefined) req.tx = e.tx;
    try { port.postMessage(req); } catch (_) { /* 口が閉じた: 子の終わりで送り直す */ }
    e.timer = T.setTimeout(() => { e.timer = null; settle(e, () => e.reject(dbError('retry', true))); }, e.timeoutMs);
  }

  function flush() {
    for (const e of entries.values()) if (!e.sent) transmit(e);
  }

  function onReply(data) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.event === 'string') {
      if (data.event === 'changed') emit({ type: 'changed', pageIds: data.pageIds, actor: data.actor });
      return;
    }
    const e = entries.get(data.id);
    if (!e || !e.sent) return;
    if (data.ok === true) settle(e, () => e.resolve(data.result));
    else settle(e, () => e.reject(dbError(typeof data.code === 'string' && data.code ? data.code : 'internal', data.retry === true)));
  }

  function giveUp(why) {
    phase = 'down';
    if (restartTimer) { T.clearTimeout(restartTimer); restartTimer = null; }
    if (why === 'crash') say(`DB: 諦めた（${GIVE_UP_WINDOW_MS / 60000}分に${GIVE_UP_COUNT}回）`);
    rejectAll('db-down', false);
    emit({ type: 'down', why });
  }

  function onChildMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'log') { if (typeof m.line === 'string') say(m.line); return; }
    if (m.type === 'closed') { for (const fn of closedWaiters.splice(0)) fn(); return; }
    if (stopping || phase === 'down') return;
    if (m.type === 'ready') {
      if (m.state === 'failed') { giveUp('failed'); return; }
      phase = m.state === 'newer' ? 'read-only' : 'ready';
      flush();
      for (const fn of readyFns.slice()) { try { fn(m); } catch (_) { /* 聞き手の誤り */ } }
    } else if (m.type === 'migrate-plan') {
      phase = 'migrating';
      const auto = migrateGo;
      emit({ type: 'migrate-plan', counts: m.counts, auto });
      if (auto && child) child.postMessage({ type: 'migrate', go: true });
    } else if (m.type === 'progress') {
      emit({ type: 'progress', done: m.done, total: m.total });
    }
  }

  function onExit(code) {
    child = null;
    if (port) { try { port.close(); } catch (_) { /* 閉じ済み */ } port = null; }
    for (const fn of exitWaiters.splice(0)) fn();
    if (stopping || phase === 'down') return;
    // 返事の無かった頼みは、起こし直した子へ同じ順・同じ tx で送り直す（時間切れは用意ができてから数え直す）
    for (const e of entries.values()) {
      e.sent = false;
      if (e.timer) { T.clearTimeout(e.timer); e.timer = null; }
    }
    const t = Number(now());
    crashes.push(t);
    while (crashes.length && crashes[0] <= t - GIVE_UP_WINDOW_MS) crashes.shift();
    emit({ type: 'lost', code });
    if (crashes.length >= GIVE_UP_COUNT) { giveUp('crash'); return; }
    const ms = RESTART_MS[Math.min(crashes.length, RESTART_MS.length) - 1];
    say(`DB: 子が終わった（${code}）。${ms}ms 後に起こし直す`);
    phase = 'starting';
    // close と giveUp はこの待ちを外すので、待ちの後では印を見直さない
    restartTimer = T.setTimeout(() => { restartTimer = null; spawn(); }, ms);
  }

  function spawn() {
    gen += 1;
    const my = gen;
    phase = 'starting';
    let c;
    try {
      c = fork(serverPath, [], { serviceName: 'NaTsu DB' });
    } catch (_) {
      onExit('spawn');
      return;
    }
    child = c;
    c.on('message', (m) => { if (my === gen) onChildMessage(m); });
    c.on('exit', (code) => { if (my === gen) onExit(code); });
    const ch = new Channel();
    port = ch.port2;
    port.on('message', (ev) => { if (my === gen) onReply(ev ? ev.data : undefined); });
    port.start();
    try {
      c.postMessage({ ...init, type: 'init' });
      c.postMessage({ type: 'port', role: 'main' }, [ch.port1]);
    } catch (_) { /* 子がもう居ない: exit で起こし直す */ }
  }

  function call(cmd, args = {}, opts = {}) {
    if (phase === 'down' || closing) return Promise.reject(dbError('db-down', false));
    const o = opts || {};
    let tx = o.tx;
    if (tx === undefined && isTableWrite(cmd)) tx = newTx(cmd);
    const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : (isWrite(cmd) ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      nextId += 1;
      const e = { id: nextId, cmd, args, tx, timeoutMs, resolve, reject, sent: false, timer: null };
      entries.set(e.id, e);
      if (canSend()) transmit(e);
    });
  }

  function noteSendFail(cmd, args, err) {
    const key = args && typeof args.pageId === 'string' ? `p:${args.pageId}` : `c:${cmd}`;
    if (sendLogged.has(key)) return;
    sendLogged.add(key);
    say(`DB: 返事を待たない書き込みが失敗（${cmd}・${(err && err.code) || 'internal'}）`);
  }

  function send(cmd, args) {
    try {
      call(cmd, args).catch((err) => noteSendFail(cmd, args, err));
    } catch (err) {
      noteSendFail(cmd, args, err);
    }
    return undefined;
  }

  function rendererPort() {
    if (!child || closing) return null;
    const ch = new Channel();
    try {
      child.postMessage({ type: 'port', role: 'app' }, [ch.port1]);
    } catch (_) {
      return null;
    }
    return ch.port2;
  }

  function waitFor(list, ms, kick) {
    return new Promise((resolve) => {
      let done = false;
      let t = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (t) T.clearTimeout(t);
        resolve();
      };
      t = T.setTimeout(finish, ms);
      list.push(finish);
      try { if (kick() === false) finish(); } catch (_) { finish(); }
    });
  }

  function close({ timeoutMs = CLOSE_TIMEOUT_MS } = {}) {
    if (closing) return closing;
    stopping = true;
    if (restartTimer) { T.clearTimeout(restartTimer); restartTimer = null; }
    closing = (async () => {
      const c = child;
      if (c) {
        // closed か子の終わりのどちらか早い方まで待つ
        await waitFor(closedWaiters, timeoutMs, () => {
          exitWaiters.push(() => { for (const fn of closedWaiters.splice(0)) fn(); });
          c.postMessage({ type: 'close' });
        });
        if (child === c) await waitFor(exitWaiters, timeoutMs, () => c.kill());
      }
      child = null;
      if (port) { try { port.close(); } catch (_) { /* 閉じ済み */ } port = null; }
      phase = 'down';
      rejectAll('db-down', false);
    })();
    return closing;
  }

  return {
    start() { if (phase === 'idle' && !closing) spawn(); },
    call,
    send,
    rendererPort,
    state: () => (phase === 'idle' ? 'starting' : phase),
    onReady(fn) {
      readyFns.push(fn);
      return () => { const i = readyFns.indexOf(fn); if (i >= 0) readyFns.splice(i, 1); };
    },
    migrate(go) {
      migrateGo = go === true;
      if (child && !stopping) { try { child.postMessage({ type: 'migrate', go: migrateGo }); } catch (_) { /* 子が居ない */ } }
    },
    close,
  };
}

module.exports = { makeDbClient, RESTART_MS };
