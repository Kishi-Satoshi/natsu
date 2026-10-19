/*
 * json-backend.js — 今の JSON の保存（src/store.js）を、議事録の DB の命令の名前で呼ぶ薄い層（第2a1回 ST1）
 *
 * main は議事録の読み書きを await db.call(cmd, args) の形で頼む（M-1）。この層はその頼みを、今の main の IPC の
 * 受け口と同じ store の呼び方に置き換えるだけで、答えの形も今の IPC と同じにする（page.get と segment.update は
 * 経路の行 routeText を添える）。DB に替えた後も消さず、「今の保存の答え」として DB の命令と比べるテストの相手に使う。
 *
 *   - page.put は store.savePage。rev は見ない（今の JSON に rev は無い）。DB が作る欄（rev・routeText）は捨てて書き、
 *     無いページは作らずに null を返す（要約の途中で消したページを戻さない）
 *   - meeting.finalize は store.createPage（pageId は無視して store が ID を作る: 今の動き）。meeting.recover も
 *     createPage して { page, already: false }。page に summaryError があれば同じ1回の中で入れて保存し直す（今の復旧と同じ）
 *   - meeting.begin・meeting.segment・meeting.discard・meeting.settle と send は何もしない（今の JSON の保存に録音中の写しは無い）
 *   - 失敗は Promise の reject。知らない命令は Error('unknown-cmd')（.code・.retry つき）。store が投げた誤りはそのまま返す
 *     （main は今どおり e.message と e.code を記録に使う）
 * Electron も DB も読まない。外へ通信しない。
 */
'use strict';

const { refreshCitations } = require('../cite');
const { parseDue } = require('../actions');
const { routeLabel } = require('../mainlib');

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// DB の側で作る欄。ページを書くときはファイルに残さない
const DB_MADE = ['rev', 'routeText'];

function fail(code) {
  const e = new Error(code);
  e.code = code;
  e.retry = false;
  return e;
}

// store.createPage が受け取る欄（ほかの欄は今の createPage と同じく捨てる）
function createArgs(page, segments) {
  const p = isObj(page) ? page : {};
  return {
    title: p.title, date: p.date, durationSec: p.durationSec, memo: p.memo, blocks: p.blocks,
    segments: Array.isArray(segments) ? segments : [], createdAt: p.createdAt, recovered: p.recovered,
    route: p.route, pauses: p.pauses,
  };
}

function makeJsonBackend(store, { labels = {} } = {}) {
  // 画面に渡すページ（第1c回 OL6）: 経路の行を routeText に添えた写し。送り先の名前は、そのページを文字起こしした送り先のもの
  const forView = (page) => {
    if (!isObj(page)) return page;
    const id = page.route && page.route.stt ? page.route.stt.provider : '';
    const label = typeof id === 'string' && isObj(labels) && Object.hasOwn(labels, id) && typeof labels[id] === 'string' ? labels[id] : '';
    return { ...page, routeText: routeLabel(page.route, label) };
  };

  const create = (page, segments) => {
    const p = store.createPage(createArgs(page, segments));
    if (isObj(page) && typeof page.summaryError === 'string' && page.summaryError) {
      p.summaryError = page.summaryError;
      store.savePage(p);
    }
    return p;
  };

  const COMMANDS = Object.freeze(Object.assign(Object.create(null), {
    // ---- 読む
    'pages.list': ({ q } = {}) => store.searchIndex(q || ''),
    'pages.searchFull': ({ q, limit } = {}) => store.searchFullText(q || '', limit === undefined ? 60 : limit),
    'pages.actionView': ({ q, assignee } = {}) => store.actionView({ q, assignee }),
    'page.get': ({ id } = {}) => {
      const page = store.getPage(id);
      if (!page) return null;
      return { page: forView(page), segments: store.getTranscript(id) };
    },
    // ---- 画面の書き込み（今の main の IPC の受け口と同じ）
    'page.setTitle': ({ id, title } = {}) => store.setTitle(id, title),
    'page.setMemo': ({ id, memo } = {}) => {
      const p = store.getPage(id); if (!p) return null;
      p.memo = String(memo || ''); return store.savePage(p);
    },
    'page.setType': ({ id, type } = {}) => {
      const p = store.getPage(id); if (!p) return null;
      p.meetingType = type; p.typeAuto = false;   // 手動指定は以後の自動推定より優先
      return store.savePage(p);
    },
    'page.delete': ({ id } = {}) => store.deletePage(id),
    'block.update': ({ pageId, blockId, patch } = {}) => store.updateBlock(pageId, blockId, patch),
    'block.insert': ({ pageId, afterBlockId, type } = {}) => store.insertBlock(pageId, afterBlockId, type),
    'block.remove': ({ pageId, blockId } = {}) => store.removeBlock(pageId, blockId),
    'block.move': ({ pageId, blockId, toIndex } = {}) => store.moveBlock(pageId, blockId, toIndex),
    'block.setAction': ({ pageId, blockId, assignee, dueRaw } = {}) => {
      const p = store.getPage(pageId); if (!p) return null;
      const b = p.blocks.find((x) => x.id === blockId); if (!b) return null;
      if (typeof assignee === 'string') b.assignee = assignee.trim();
      if (typeof dueRaw === 'string') {
        b.dueRaw = dueRaw.trim();
        const r = parseDue(b.dueRaw, new Date(p.createdAt));
        b.due = r.date; b.dueApprox = r.approx;
      }
      return store.savePage(p);
    },
    // 文字起こしの1区間を直す。recite（既定）なら、その区間を根拠にしていた要点と根拠なしの要点だけ出典を引き直して
    // ページを保存する（今の segment:update の受け口）。recite: false は区間だけを直す（今の復旧の文字起こしの道）
    'segment.update': ({ pageId, segId, patch, recite = true } = {}) => {
      const segments = store.updateSegment(pageId, segId, patch || {});
      if (!segments) return null;
      const page = store.getPage(pageId);
      if (!page) return null;
      if (recite !== false) {
        if (page.blocks.length) page.citeStat = refreshCitations(page.blocks, segments.filter((s) => !s.failed), segId);
        store.savePage(page);
      }
      return { page: forView(page), segments };
    },
    // ---- main だけ
    'page.put': ({ page } = {}) => {
      if (!isObj(page) || typeof page.id !== 'string' || !store.getPage(page.id)) return null;
      const p = { ...page };
      for (const k of DB_MADE) delete p[k];
      return store.savePage(p);
    },
    'meeting.begin': () => null,
    'meeting.segment': () => null,
    'meeting.finalize': ({ page, segments } = {}) => create(page, segments),
    'meeting.recover': ({ page, segments } = {}) => ({ page: create(page, segments), already: false }),
    'meeting.discard': () => null,
    'meeting.settle': () => ({ settled: 0 }),
    // 復旧の文字起こしの失敗の文を残す（updateSegment は failed を外すので直接書く。今の transcribeRecoveredItems と同じ）
    'segment.fail': ({ pageId, segId, text } = {}) => {
      const segs = store.getTranscript(pageId);
      const s = segs.find((x) => x.id === segId);
      if (!s) return null;
      s.text = String(text || ''); s.failed = true;
      store.saveTranscript(pageId, segs);
      return segs;
    },
    // 無音だった区間を消す（今の removeTranscriptSegment）
    'segment.remove': ({ pageId, segId } = {}) => {
      const segs = store.getTranscript(pageId).filter((s) => s.id !== segId);
      store.saveTranscript(pageId, segs);
      return segs;
    },
    // JSON の保存には控えも取り込みも無い
    'snapshot.take': () => null,
    'db.status': () => ({ state: 'ready', backend: 'json' }),
    'db.reimport': () => null,
  }));

  return {
    // 3つ目の引数 opts（tx・timeoutMs）は受けても見ない（JSON の保存は同じプロセスの中で1回だけ行うので、送り直しが無い）
    async call(cmd, args) {
      if (typeof cmd !== 'string' || !Object.hasOwn(COMMANDS, cmd)) throw fail('unknown-cmd');
      return COMMANDS[cmd](isObj(args) ? args : {});
    },
    send() { return undefined; },
    state() { return 'ready'; },
  };
}

module.exports = { makeJsonBackend };
