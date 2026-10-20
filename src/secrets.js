/*
 * secrets.js — クラウドの文字起こしの鍵の保管（第1c回 OL3。RF30）と、ログインの札の保管（第1d回 A-2。RL10・RF32）
 *
 *  - PROVIDER_IDS  しまえる名前。中継のログインの札 relay だけ（第1d回 A-4。0.7.0 までの groq・openai・custom の鍵は、
 *                  OpenAI へ直に送る道と鍵の IPC・画面と一緒に外した。しまえず・読めず・消せない。残った鍵は起動のときに purgeOld が消す）
 *  - OLD_IDS       0.7.0 までの鍵の名前（purgeOld が消す）
 *  - KEY_RE        鍵として受け付ける形（HTTP の見出しに入れられる文字だけ。空白・日本語は断る）
 *  - RELAY_RE      relay の値の形（第1d回 A-11: Access の cookie をまとめた文字。印字できる ASCII の 16KB まで）
 *  - makeSecrets   送り先ごとの鍵を safeStorage の非同期の形で暗号にし、<userData>/secrets.json に書く
 *
 *  - purgeOld      0.7.0 までの鍵（OLD_IDS）と、退けた控え secrets.json.broken-* を消す（K2。起動のときに main が呼ぶ。A-4 から）
 *
 * ファイルの形: { "schema": 1, "keys": { "relay": "<暗号の base64>" } }
 *
 * 資料:
 *  - Electron の safeStorage（https://github.com/electron/electron/blob/44-x-y/docs/api/safe-storage.md）。
 *    isAsyncEncryptionAvailable・encryptStringAsync・decryptStringAsync（返りは { shouldReEncrypt, result }）。
 *    Windows は DPAPI で、同じ利用者のほかのアプリからは読めてしまう（ほかの利用者からは守る）。
 *    Linux は getSelectedStorageBackend() が 'basic_text' のとき、暗号は決まった文字の鍵で行われ、
 *    実質は平文と同じになる。'unknown' は ready の前に呼んだとき。
 *
 * 決まり:
 *  - Electron のモジュールは読み込まない。safeStorage と J（src/jsonfile.js）を呼ぶ側からもらう。
 *  - 平文では決して置かない。暗号にできない PC（isAsyncEncryptionAvailable が false、Linux の basic_text
 *    と unknown）では保存を断る。鍵が settings.json・画面・記録に出ないように、ここの外へは get の返りだけで渡す。
 *  - 記録（log）にはファイルの名前と理由の符号だけを書く。鍵も暗号の文字も、ファイルの中身も書かない。
 *  - 読み書きは第1a回の部品（J.loadJsonFile・J.writeJsonFile）。壊れたファイルは退けて（消さずに）
 *    鍵が無いとして動く。読めない（unreadable）間は書かない（RF22 と同じ考え。次に触るときに読み直す）。
 *  - has は暗号の文字があるかだけを見る（復号しない）。本当に使える鍵かは get が '' でないかで見る
 *    （safeStorage の非同期の形は一時的に使えないことがあるため）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROVIDER_IDS = Object.freeze(['relay']);
const OLD_IDS = Object.freeze(['groq', 'openai', 'custom']);
const KEY_RE = /^[\x21-\x7e]{8,512}$/;   // 見出しに入れられる文字だけ（空白・日本語は断る）
// relay の値（第1d回 A-11）: ログインの窓で取った Access の cookie を src/relay.js の packCookies でまとめた文字（JSON。値の JWT は数 KB）。
// 印字できる ASCII（空白なし）の 16KB まで（packCookies の上限と同じ）。0.8.0 の前の試しの札（nt1_）もこの形に入る（起動で消す: unpackCookies の 'old'）
const RELAY_RE = /^[\x21-\x7e]{8,16384}$/;
const valueRe = (id) => (id === 'relay' ? RELAY_RE : KEY_RE);
const SCHEMA = 1;

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const knownId = (id) => typeof id === 'string' && PROVIDER_IDS.includes(id);
const isShape = (v) => isObj(v) && v.schema === SCHEMA && isObj(v.keys) && Object.values(v.keys).every((x) => typeof x === 'string');

function makeSecrets({ file, safeStorage, J, platform = process.platform, log = () => {} }) {
  const name = path.basename(file);
  const say = (line) => { try { log(line); } catch (_) { /* 記録の失敗では止めない */ } };
  let keys = null;          // 読めた鍵（送り先の名前 → base64）。null はまだ読んでいない
  let unreadable = false;   // 読めない間は書かない

  // 読めていなければ読む。読めない結果だけは覚えず、次に触るときに読み直す
  function load() {
    if (keys && !unreadable) return;
    const r = J.loadJsonFile(file, { shape: isShape, maxBytes: J.SMALL_MAX });
    const next = Object.create(null);
    if (r.state === 'ok') {
      for (const id of PROVIDER_IDS) {
        if (Object.hasOwn(r.value.keys, id) && r.value.keys[id]) next[id] = r.value.keys[id];
      }
      unreadable = false;
    } else if (r.state === 'missing') {
      unreadable = false;
    } else if (r.state === 'broken') {
      unreadable = false;
      say(`secrets: ${name} が壊れていたため退けました（${r.reason}）→ ${r.movedTo ? path.basename(r.movedTo) : '-'}`);
    } else {
      unreadable = true;
      if (!keys) say(`secrets: ${name} を読めません（${r.code || 'unreadable'}）`);
    }
    keys = unreadable ? (keys || next) : next;
  }

  // keys を next にして書く。→ true | false（失敗は記録に符号だけ）
  function save(next) {
    const value = { schema: SCHEMA, keys: {} };
    for (const id of PROVIDER_IDS) if (next[id]) value.keys[id] = next[id];
    try {
      J.writeJsonFile(file, value);
    } catch (e) {
      say(`secrets: ${name} に書けません（${(e && e.code) || 'UNKNOWN'}）`);
      return false;
    }
    keys = next;
    return true;
  }

  const copy = () => Object.assign(Object.create(null), keys);

  async function available() {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
      if (platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend();
        if (backend === 'basic_text' || backend === 'unknown') return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function has(id) {
    if (!knownId(id)) return false;
    load();
    return Boolean(keys[id]);
  }

  async function encrypt(key) {
    const buf = await safeStorage.encryptStringAsync(key);
    return Buffer.from(buf).toString('base64');
  }

  async function get(id) {
    if (!has(id)) return '';
    const stored = keys[id];
    let out;
    try {
      out = await safeStorage.decryptStringAsync(Buffer.from(stored, 'base64'));
    } catch (e) {
      say(`secrets: ${id} の鍵を復号できません（${(e && e.code) || 'decrypt-failed'}）`);
      return '';
    }
    const result = out && typeof out.result === 'string' ? out.result : '';
    if (!result) { say(`secrets: ${id} の鍵を復号できません（empty）`); return ''; }
    if (out.shouldReEncrypt) {
      try {
        const fresh = await encrypt(result);
        // 待つ間に消されたり替えられたりしていれば、そちらを残す
        if (!unreadable && keys[id] === stored) {
          const next = copy(); next[id] = fresh;
          if (save(next)) say(`secrets: ${id} の鍵を暗号にし直しました`);
        }
      } catch (e) {
        say(`secrets: ${id} の鍵を暗号にし直せません（${(e && e.code) || 'encrypt-failed'}）`);
      }
    }
    return result;
  }

  async function set(id, key) {
    if (!knownId(id)) return { ok: false, code: 'bad-id' };
    if (typeof key !== 'string' || !valueRe(id).test(key)) return { ok: false, code: 'bad-key' };
    if (!(await available())) return { ok: false, code: 'unavailable' };
    let enc;
    try {
      enc = await encrypt(key);
    } catch (e) {
      say(`secrets: ${id} の鍵を暗号にできません（${(e && e.code) || 'encrypt-failed'}）`);
      return { ok: false, code: 'unavailable' };
    }
    load();
    if (unreadable) return { ok: false, code: 'write' };
    const next = copy(); next[id] = enc;
    return save(next) ? { ok: true } : { ok: false, code: 'write' };
  }

  function remove(id) {
    if (!knownId(id)) return { ok: false, code: 'bad-id' };
    load();
    if (unreadable) return { ok: false, code: 'write' };
    if (!keys[id]) return { ok: true };
    const next = copy(); delete next[id];
    return save(next) ? { ok: true } : { ok: false, code: 'write' };
  }

  // 0.7.0 までの鍵（OLD_IDS。会社の OpenAI の鍵が入りうる）と退けた控え（前の鍵の暗号の文字が残りうる）を消す（K2・F11）。
  // load() は PROVIDER_IDS の外を読まないので、ファイルを生のまま読む。relay の札とほかの欄は残す。
  // 読めない・書けなければ何もせず（控えも残す）、次の起動でまたする。→ { removed: 消した鍵と控えの数 }（投げない）
  function purgeOld() {
    const r = J.loadJsonFile(file, { shape: isShape, maxBytes: J.SMALL_MAX });
    if (r.state !== 'ok' && r.state !== 'missing' && r.state !== 'broken') {
      say(`secrets: ${name} を読めないため、前の鍵を消せません（${r.code || 'unreadable'}）`);
      return { removed: 0 };
    }
    let removed = 0;
    if (r.state === 'ok') {
      const old = OLD_IDS.filter((id) => Object.hasOwn(r.value.keys, id));
      if (old.length) {
        const value = { schema: SCHEMA, keys: {} };
        for (const [id, v] of Object.entries(r.value.keys)) if (!OLD_IDS.includes(id)) value.keys[id] = v;
        try {
          J.writeJsonFile(file, value);
        } catch (e) {
          say(`secrets: ${name} に書けないため、前の鍵を消せません（${(e && e.code) || 'UNKNOWN'}）`);
          return { removed: 0 };
        }
        removed += old.length;
      }
    }
    const prefix = `${name}.broken-`;
    let names = [];
    try { names = fs.readdirSync(path.dirname(file)); } catch (_) { names = []; }
    for (const n of names) {
      if (!n.startsWith(prefix)) continue;
      try { fs.rmSync(path.join(path.dirname(file), n), { force: true }); removed += 1; } catch (e) {
        say(`secrets: 退けた控えを消せません（${(e && e.code) || 'UNKNOWN'}）`);
      }
    }
    keys = null;   // 次に触るときに読み直す
    unreadable = false;
    if (removed) say(`secrets: 前の鍵 ${removed} 個を消しました`);
    return { removed };
  }

  return { available, has, get, set, remove, purgeOld };
}

module.exports = { PROVIDER_IDS, OLD_IDS, KEY_RE, RELAY_RE, makeSecrets };
