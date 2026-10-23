/* mcp-listed.test.js — 0.10.0 Task T-5（F1・F19・RF78。D57。計画 docs/plans/2026-10-20-100.md）: どの道具のどの引数でも、ゴミ箱のページと
 * 録音中の写しの文字が出ず、箇所の検索の並びにも効かない。オフラインモードの会議と印の分からない会議は、ほかの会議と同じに出る */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sqlite = require('node:sqlite');
const tools = require('../src/mcp/tools');
const { titleAt } = require('./helpers/titles');
const { mcpDb } = require('./helpers/mcpdb');

const T = { timeout: 10000 };
const NOW = () => new Date('2026-10-21T03:00:00.000Z');
const SECRET = 'ひみつの合言葉𠮷';
const OFFLINE = 'オフラインの目印';
// 目印の2文字以上の切れ端（サロゲートの対は1文字として数える）
const pieces = (w) => {
  const cs = [...w];
  const out = new Set();
  for (let i = 0; i < cs.length; i++) for (let j = i + 2; j <= cs.length; j++) out.add(cs.slice(i, j).join(''));
  return [...out];
};

// 種: ふつうの会議2つ・オフラインモードの会議・印の分からない会議（どちらも OFFLINE の目印）・ゴミ箱の会議と録音中の写し（SECRET の目印を全部の欄に）
function seed() {
  const m = mcpDb({ only: ['plain1', 'plain2'] });
  const fin = (id, page, segs) => m.call('main', 'meeting.finalize', { pageId: id, page: { durationSec: 60, ...page }, segments: segs });
  fin('pl9', { title: titleAt('2026-10-19T02:00:00.000Z'), date: '2026-10-19', createdAt: '2026-10-19T02:00:00.000Z', memo: `${OFFLINE}のメモ`,
    blocks: [{ id: 'pl9h', type: 'heading', text: '決めたこと', level: 2 }, { id: 'pl9b', type: 'bullet', text: `${OFFLINE}の要点` }],
    route: { stt: { cloud: 0, local: 1 }, localOnly: true, summary: { by: 'local' } } }, [{ id: 's1', atMs: 0, durationMs: 15000, text: `${OFFLINE}の発言` }]);
  m.call('main', 'meeting.begin', { pageId: 'pu9', startedAt: Date.parse('2026-10-19T03:00:00.000Z'), localOnly: false });
  m.call('main', 'meeting.segment', { pageId: 'pu9', seg: { id: 's1', atMs: 0, durationMs: 15000, text: `${OFFLINE}の片付けた発言` } });
  m.call('main', 'meeting.settle', { keep: [] });
  const secretPage = (title) => ({ title, memo: `${SECRET}のメモ`, blocks: [
    { id: 'h1', type: 'heading', text: `${SECRET}の見出し`, level: 2 },
    { id: 'b1', type: 'bullet', text: `${SECRET}の要点`, cites: ['s1'] },
    { id: 't1', type: 'todo', text: `${SECRET}の ToDo`, checked: false, assignee: SECRET, due: '2026-10-30' },
  ] });
  const secretSegs = [{ id: 's1', atMs: 0, durationMs: 15000, text: `${SECRET}の発言` }, { id: 's2', atMs: 15000, durationMs: 15000, text: `二つ目の${SECRET}` }];
  // ゴミ箱の会議（ブロックの ID はページの ID を頭に付ける: 表全体で重ならない）
  const tp = secretPage(`${SECRET}の会議`);   // 利用者が付け直した題名（D77。題名の語に頼るため: 題名の目印が出ないことを見る）
  tp.blocks = tp.blocks.map((b) => ({ ...b, id: `pt9${b.id}` }));
  fin('pt9', { ...tp, date: '2026-10-19', createdAt: '2026-10-19T04:00:00.000Z' }, secretSegs);
  m.call('app', 'page.delete', { id: 'pt9' });
  // 録音中の写し（題名・メモ・ブロックは録音中のページで書いたもの）
  m.call('main', 'meeting.begin', { pageId: 'pv9', startedAt: Date.parse('2026-10-19T05:00:00.000Z'), localOnly: false });
  for (const s of secretSegs) m.call('main', 'meeting.segment', { pageId: 'pv9', seg: s });
  // 利用者が付け直した題名（D77。題名の語に頼るため: 題名の目印が出ないことを見る）
  m.call('app', 'page.setTitle', { id: 'pv9', title: `${SECRET}の録音中` });
  m.call('app', 'page.setMemo', { id: 'pv9', memo: `${SECRET}の録音中のメモ` });
  m.close();
  return m;
}

function calls() {
  const out = [];
  const q = [SECRET, 'ひみ', 'ひみつ', '合言葉', '会議', '発言', '要点', OFFLINE];
  const ranges = [{}, { from: '2026-10-19', to: '2026-10-19' }, { dates: ['2026-10-19'] }, { meeting_types: ['general'] }];
  for (const r of ranges) {
    out.push(['list_meetings', r], ['list_meetings', { ...r, limit: 1, offset: 1 }]);
    for (const query of q) {
      out.push(['search_passages', { query, ...r }], ['search_passages', { query, ...r, include_transcript: false }], ['search_passages', { query, ...r, per_meeting: 10, limit: 20 }]);
    }
  }
  for (const query of q) out.push(['search_passages', { query, meeting_ids: ['pt9', 'pv9', 'pm1'] }], ['search_passages', { query, meeting_ids: ['pt9'] }]);
  for (const id of ['pt9', 'pv9', 'pm1', 'pl9', 'pu9']) {
    out.push(['get_meeting', { id }], ['get_meeting', { id, include_transcript: true }], ['get_meeting', { id: `natsu://page/${id}` }], ['get_meeting', { id, transcript_from: 's2' }]);
  }
  out.push(['get_meetings', { ids: ['pt9', 'pv9', 'pm1'] }], ['get_meetings', { ids: ['pt9', 'pv9', 'pm1'], include_transcript: true }],
    ['get_meetings', { dates: ['2026-10-19'] }], ['get_meetings', { dates: ['2026-10-19'], include_transcript: true }], ['get_meetings', { from: '2026-10-18', to: '2026-10-20' }],
    ['get_meetings', { dates: ['2026-10-19'], cursor: 'pt9' }], ['get_meetings', { dates: ['2026-10-19'], cursor: 'pl9' }]);
  for (const anchor of ['pt9#t:s1-s2', 'pv9#t:s1-s2', 'pt9#b:pt9h1', 'pt9#m:1', 'pv9#m:1', 'pm1#t:s1-s3']) out.push(['expand_passage', { anchor }], ['expand_passage', { anchor, around: 600 }]);
  for (const r of [{}, { assignee: SECRET }, { from: '2026-10-19', to: '2026-10-19' }, { limit: 1, offset: 1 }]) out.push(['list_action_items', r]);
  return out;
}

test('F1・D57: 6つの道具のどの答えにも、ゴミ箱のページと録音中の写しの目印が無い（ID を直に渡しても・偽の印でも not-found）', T, () => {
  const m = seed();
  try {
    const bits = pieces(SECRET);
    let n = 0;
    for (const [name, args] of calls()) {
      const r = tools.callTool(name, args, { sqlite, dataDir: m.dataDir, now: NOW });
      // Claude が渡した語（問いの写し）は答えに出てよいので、その文字を外してから見る
      let text = r.text;
      if (args.query) text = text.split(`「${args.query}」`).join('「」');
      for (const b of bits) assert.ok(!text.includes(b), `${name} ${JSON.stringify(args)}: 「${b}」が出た\n${r.text.slice(0, 400)}`);
      n++;
    }
    assert.ok(n > 120);
    const call = (name, args) => tools.callTool(name, args, { sqlite, dataDir: m.dataDir, now: NOW });
    for (const id of ['pt9', 'pv9']) assert.strictEqual(call('get_meeting', { id }).code, 'not-found');
    for (const anchor of ['pt9#t:s1-s2', 'pv9#t:s1-s1', 'pt9#b:pt9h1', 'pt9#m:1']) assert.strictEqual(call('expand_passage', { anchor }).code, 'not-found');
    assert.strictEqual(call('get_meetings', { ids: ['pt9', 'pv9'] }).code, 'not-found');
  } finally { m.done(); }
});

test('D57: オフラインモードの会議と印の分からない会議は、一覧・箇所・get_meeting・get_meetings・list_action_items に、ふつうの会議と同じ形で出る', T, () => {
  const m = seed();
  try {
    const call = (name, args) => tools.callTool(name, args, { sqlite, dataDir: m.dataDir, now: NOW });
    const list = call('list_meetings', {}).text;
    for (const id of ['pl9', 'pu9', 'pm1', 'pm2']) assert.match(list, new RegExp(`ID ${id}$`, 'm'));
    const pass = call('search_passages', { query: OFFLINE, limit: 20 }).text;
    assert.match(pass, /印: pl9#/);
    assert.match(pass, /印: pu9#/);
    assert.match(call('get_meeting', { id: 'pl9', include_transcript: true }).text, new RegExp(`${OFFLINE}の発言`));
    assert.match(call('get_meeting', { id: 'pu9', include_transcript: true }).text, new RegExp(`${OFFLINE}の片付けた発言`));
    assert.match(call('get_meetings', { dates: ['2026-10-19'] }).text, /- ID: pl9[\s\S]*- ID: pu9/);
    assert.strictEqual(call('get_meetings', { ids: ['pl9', 'pu9'] }).isError, false);
  } finally { m.done(); }
});

// ゴミ箱の会議の中身だけを違えた2つの DB（作るのは見える会議の後: 候補の SQL の新しい行の順でいちばん前に来る）
function twinDb(trashText) {
  const m = mcpDb({ only: ['rag'] });
  const fin = (id, page, segs) => m.call('main', 'meeting.finalize', { pageId: id, page: { durationSec: 60, ...page }, segments: segs });
  // 2語の重みが同じになる見える会議（新しい方が先に並ぶ）
  fin('pq1', { title: titleAt('2026-09-20T01:00:00.000Z'), date: '2026-09-20', createdAt: '2026-09-20T01:00:00.000Z', memo: '', blocks: [] }, [{ id: 's1', atMs: 0, durationMs: 15000, text: 'くじら座の観測' }]);
  fin('pq2', { title: titleAt('2026-09-19T01:00:00.000Z'), date: '2026-09-19', createdAt: '2026-09-19T01:00:00.000Z', memo: '', blocks: [] }, [{ id: 's1', atMs: 0, durationMs: 15000, text: 'いるか座の観測' }]);
  fin('pt8', { title: trashText.title, date:   // 利用者が付け直した題名（D77。題名の語に頼るため: 題名の語の重みを見る）
    '2026-09-25', createdAt: '2026-09-25T01:00:00.000Z', memo: trashText.memo, blocks: [] },
    Array.from({ length: 50 }, (_, k) => ({ id: `s${k + 1}`, atMs: k * 15000, durationMs: 15000, text: trashText.seg })));
  m.call('app', 'page.delete', { id: 'pt8' });
  m.close();
  return m;
}

test('RF78・F19: ゴミ箱のページの中身を違えた2つの DB で search_passages の答えが1バイトも同じ（candMax 3・pageCand 2 でも）。meeting_ids にゴミ箱の ID を入れても答えは渡さなかったときと同じ', T, () => {
  // 利用者が付け直した題名（D77。題名の語に頼るため: 題名の語の重みを見る）
  const a = twinDb({ title: 'くじら座の会議', memo: 'くじら座の会議のメモ', seg: 'くじら座の会議の話' });
  // 利用者が付け直した題名（D77。題名の語に頼るため）
  const b = twinDb({ title: 'ぜんぜん無関係', memo: 'どこにも無い', seg: 'まったく別の語' });
  try {
    const qs = ['くじら座 いるか座', '会議', '見積', 'くじら座', '値引き 契約', '会議の話'];
    for (const query of qs) {
      for (const extra of [{}, { candMax: 3 }, { pageCand: 2 }, { candMax: 3, pageCand: 2 }]) {
        for (const args of [{ query }, { query, limit: 20, per_meeting: 10 }, { query, include_transcript: false }]) {
          const ra = tools.callTool('search_passages', args, { sqlite, dataDir: a.dataDir, now: NOW, ...extra });
          const rb = tools.callTool('search_passages', args, { sqlite, dataDir: b.dataDir, now: NOW, ...extra });
          assert.strictEqual(ra.text, rb.text, `${JSON.stringify(args)} ${JSON.stringify(extra)}`);
        }
      }
      const plain = tools.callTool('search_passages', { query, meeting_ids: ['pq1', 'pq2', 'pr01'] }, { sqlite, dataDir: a.dataDir, now: NOW });
      const withTrash = tools.callTool('search_passages', { query, meeting_ids: ['pq1', 'pt8', 'pq2', 'pr01'] }, { sqlite, dataDir: a.dataDir, now: NOW });
      assert.strictEqual(withTrash.text, plain.text, query);
    }
  } finally { a.done(); b.done(); }
});
