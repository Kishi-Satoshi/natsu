/*
 * steps.js — 時間のかかるテストの「どの段で止まったか」を残す台（0.7.0 の前。CI run 39243734668 の Windows の electron-smoke で、
 * db-snapshot の RF11 と db-server の ST10 が何も言わずに 'test timed out after 10000ms' で落ちた）
 *
 * withSteps(budgetMs, fn, extra) → fn({ step, log }) の答え（extra() は越えたときに足す文。snapshot.js の activeSteps() など）
 *   step(name) … 段を始めた印（始めからの ms を覚える）
 *   log(line)  … 製品の記録の行（snapshot.js の段ごとの時間など）を覚える。S.take・S.recover の log にそのまま渡せる
 *   予算を越えたら「予算 <ms>ms を越えた。最後に始めた段: <段>」と、段ごとの時刻（A@12ms → B@340ms）と記録の行を言って落ちる。
 *   node:test の timeout は予算より長くする（node:test の時間切れは段を言わない）。越えた後も fn は裏で続き、自分の後片付けをする
 */
'use strict';

function withSteps(budgetMs, fn, extra = () => '') {
  const t0 = Date.now();
  const steps = [];
  const logs = [];
  const step = (name) => { steps.push([String(name), Date.now() - t0]); };
  const log = (line) => { logs.push(`${Date.now() - t0}ms ${line}`); };
  const report = () => `段: ${steps.map(([n, t]) => `${n}@${t}ms`).join(' → ') || 'なし'}\n記録:\n${logs.join('\n') || '（無し）'}`;
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const last = steps.length ? steps[steps.length - 1][0] : 'なし';
      reject(new Error(`予算 ${budgetMs}ms を越えた。最後に始めた段: ${last}\n${report()}${extra()}`));
    }, budgetMs);
  });
  return Promise.race([Promise.resolve().then(() => fn({ step, log })), deadline]).finally(() => clearTimeout(timer));
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

module.exports = { withSteps, sum };
