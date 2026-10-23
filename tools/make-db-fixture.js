// 出した表の形の版ごとの固定の DB を作る道具（第2a1回 G-2。RF11）。
//
//   node tools/make-db-fixture.js [出力のパス]   … 既定は test/fixtures/db/v<SCHEMA_VERSION>.db。在れば作らずに投げる（上書きしない）
//   makeFixture({ file }) → { file, version }      … test/db-fixture.test.js が2回作って行を比べる
//
// 決め方:
//  - 版を出した後は、その版の固定の DB を作り直さない（test/fixtures/db/v1.db は 0.7.0 の形のまま残し、後の版がいつまでも開けることを
//    test/db-fixture.test.js で見る）。表の形を変える回は、この道具で v2.db を足す（v1.db はそのまま）。
//  - 中身は合成の見本だけ（test/fixtures.js の発言。見本の人の名前は「担当A」「担当B」に置き換え、s9 は外す: 「結合テスト」を言う発言を
//    1つにして、素の接続の全文検索の数を決めるため）。
//  - 命令は本物の core.call（main の meeting.finalize・meeting.begin・meeting.segment・meeting.discard、画面の page.setType・
//    page.setMemo・block.setAction・page.delete）で書く。時刻・ID・tx は全部決まった値（2回走らせても同じ行。バイトは SQLite の都合で
//    違ってよい）。ブロックの ID を乱数で作る block.insert は使わない。
//  - 一時のファイルに作り、WAL を畳んで閉じてから（-wal・-shm が残れば止める）出力の名前に変える。
//  - 出来た DB の頭は WAL のまま（アプリと同じ）。読むだけで開いても隣に -shm・-wal ができるので、テストは必ず一時のフォルダに写してから
//    開く（test/db-fixture.test.js の copyFixture）。test/fixtures/db/ の中のファイルをそのまま開かない。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');
const core = require('../src/db/core');
const { STANDUP_SEGMENTS } = require('../test/fixtures');
// 0.10.0 SH-2（D77）: 会議の題名は本物と同じ日付の形（作った時刻の日本の時刻）。v1.db はこの形で作り直した（版の印と表の形は同じ）
const titleOf = (iso) => require('../src/mainlib').meetingTitleAt(iso, 540);

const SIDECARS = ['-wal', '-shm', '-journal'];
const NAMES = [['山田', '担当A'], ['佐藤', '担当B']];
const SPEAKERS = { s1: '話者1', s2: '話者2', s3: '話者2', s4: '話者1', s5: '話者2', s6: '話者3', s7: '話者1', s8: '話者3', s10: '話者1' };

function anon(text) {
  let out = text;
  for (const [from, to] of NAMES) out = out.split(from).join(to);
  return out;
}

function standupSegments() {
  const segs = STANDUP_SEGMENTS.filter((s) => s.id !== 's9').map((s) => ({ id: s.id, atMs: s.atMs, durationMs: 75000, text: anon(s.text), speaker: SPEAKERS[s.id] }));
  segs.push({ id: 's11', atMs: 750000, durationMs: 30000, text: '（この区間の認識に失敗: 見本）', failed: true });
  return segs;
}

// [ 時刻, 役, 命令, 引数 ]。tx は役の頭文字と番号（m:fixture-001 …）
function script() {
  const p1 = 'pfixture000001'; const p2 = 'pfixture000002'; const p3 = 'pfixture000003'; const p4 = 'pfixture000004';
  const b = (p, n) => `${p}b${n}`;
  return [
    ['2026-10-15T01:15:00.000Z', 'main', 'meeting.finalize', { pageId: p1, segments: standupSegments(), page: {
      title: titleOf('2026-10-15T01:00:00.000Z'), date: '2026-10-15', durationSec: 780, memo: '', createdAt: '2026-10-15T01:00:00.000Z',
      route: { stt: { cloud: 9, local: 1, provider: 'groq' }, localOnly: false, summary: { by: 'claude-code' } },
      pauses: [{ atMs: 450000, ms: 3000, why: 'user' }],
      blocks: [
        { id: b(p1, 1), type: 'heading', text: '決定事項', level: 2 },
        { id: b(p1, 2), type: 'bullet', text: '', rich: [{ t: '結合テスト', m: ['b'] }, { t: 'は今週で完了した', m: [] }], cites: ['s2'] },
        { id: b(p1, 3), type: 'bullet', text: 'リリース日を11月15日で確定する', cites: ['s10'] },
        { id: b(p1, 4), type: 'todo', text: 'バッチ処理の実行計画を確認する', checked: false, cites: ['s4'] },
        { id: b(p1, 5), type: 'todo', text: '求人票の改訂案を作る', checked: true, assignee: '担当B', dueRaw: '今月末', due: '2026-10-31', dueApprox: true, cites: ['s7'] },
      ] } }],
    ['2026-10-15T01:20:00.000Z', 'app', 'page.setType', { id: p1, type: 'standup' }],
    ['2026-10-15T01:21:00.000Z', 'app', 'page.setMemo', { id: p1, memo: 'リリース日の確認は次回も続ける' }],
    ['2026-10-15T01:22:00.000Z', 'app', 'block.setAction', { pageId: p1, blockId: b(p1, 4), assignee: '担当A', dueRaw: '来週金曜' }],
    ['2026-10-16T01:10:00.000Z', 'main', 'meeting.finalize', { pageId: p2, page: {
      title: titleOf('2026-10-16T01:00:00.000Z'), date: '2026-10-16', durationSec: 60, memo: '', createdAt: '2026-10-16T01:00:00.000Z',
      blocks: [{ id: b(p2, 1), type: 'bullet', text: '検索が速くなった', cites: ['s1'] }] },
    segments: [
      { id: 's1', atMs: 0, durationMs: 30000, text: '今週よかったことは、検索が速くなったことです。' },
      { id: 's2', atMs: 30000, durationMs: 30000, text: '次は控えの取り方を見直したいと思います。' },
    ] }],
    ['2026-10-16T08:10:00.000Z', 'main', 'meeting.finalize', { pageId: p3, page: {
      title: titleOf('2026-10-16T08:00:00.000Z'), date: '2026-10-16', durationSec: 30, memo: '', createdAt: '2026-10-16T08:00:00.000Z',
      blocks: [{ id: b(p3, 1), type: 'bullet', text: 'ゴミ箱に入れたページの見本', cites: [] }] },
    segments: [{ id: 's1', atMs: 0, durationMs: 30000, text: 'このページはゴミ箱に入れます。' }] }],
    ['2026-10-16T09:00:00.000Z', 'app', 'page.delete', { id: p3 }],
    ['2026-10-17T01:00:00.000Z', 'main', 'meeting.begin', { pageId: p4, startedAt: Date.parse('2026-10-17T01:00:00.000Z') }],
    ['2026-10-17T01:00:30.000Z', 'main', 'meeting.segment', { pageId: p4, seg: { id: 's1', atMs: 0, durationMs: 30000, text: '取り消す見本の発言です。' } }],
    ['2026-10-17T01:01:00.000Z', 'main', 'meeting.discard', { pageId: p4 }],
  ];
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    throw e;
  }
}

function makeFixture({ file } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('make-db-fixture: 出力のパスが無い');
  if (exists(file)) throw new Error(`make-db-fixture: 在るので作らない（出した版の固定の DB は作り直さない）: ${path.basename(file)}`);
  const tmp = `${file}.making`;
  for (const s of ['', ...SIDECARS]) fs.rmSync(tmp + s, { force: true });
  const r = core.open({ sqlite, file: tmp });
  if (r.state !== 'ok') throw new Error(`make-db-fixture: 開けない（${r.code || r.state}）`);
  try {
    let n = 0;
    for (const [at, role, cmd, args] of script()) {
      n += 1;
      const tx = `${role === 'app' ? 'a' : 'm'}:fixture-${String(n).padStart(3, '0')}`;
      const out = core.call(r.db, { role, cmd, args, tx }, { now: () => new Date(at), labels: {} });
      if (!out.ok) throw new Error(`make-db-fixture: ${cmd} が ${out.code}`);
    }
    r.db.exec('pragma wal_checkpoint(TRUNCATE)');
  } finally { r.db.close(); }
  // 閉じたら -wal・-shm は無いはず。残っていたら消さずに止める（黙って畳み残しを捨てない）
  const left = SIDECARS.filter((s) => exists(tmp + s));
  if (left.length) throw new Error(`make-db-fixture: 閉じた後に ${left.join('・')} が残った`);
  fs.renameSync(tmp, file);
  return { file, version: r.version };
}

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, '..', 'test', 'fixtures', 'db', `v${core.SCHEMA_VERSION}.db`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = makeFixture({ file: out });
  console.log(`作った: ${path.relative(process.cwd(), r.file)}（表の形の版 ${r.version}）`);
}

module.exports = { makeFixture };
