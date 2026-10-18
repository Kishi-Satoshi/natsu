/*
 * electron-version.js — 動いている Electron が package.json の devDependencies.electron と同じ版かを見る（第0c回 EL8）
 *
 * CI（electron-smoke の小さなアプリ、electron-net の net-smoke.js）が、古い本体や取り違えた本体を動かして
 * 緑になっていないことを確かめる。版はきっちり固定している（x.y.z。Task 12）ので、そうでなければそれも知らせる。
 * Electron は読まない（テストが require する）。
 */
'use strict';

/**
 * @param {{ electron?: string }} versions  process.versions
 * @param {{ devDependencies?: { electron?: string } }} pkg  リポジトリの package.json
 * @returns {string} 問題が無ければ ''、あれば理由の文
 */
function versionIssue(versions, pkg) {
  const want = String((pkg && pkg.devDependencies && pkg.devDependencies.electron) || '');
  if (!/^\d+\.\d+\.\d+$/.test(want)) return `package.json の devDependencies.electron が x.y.z ではありません（${want || '無し'}）`;
  const got = (versions && versions.electron) || '';
  if (got !== want) return `動いている Electron は ${got || '不明'}、package.json は ${want}`;
  return '';
}

/**
 * versionIssue の答えで止めるかを決める。問題があれば「NG 版: …」を出し、出力を流し切ってから 1 で終える
 * （Windows の CI で理由の行が消えて、ただの 1 にならないため）。boot() は true なら先へ進まない。
 * @param {{ exit: (code: number) => void }} app
 * @param {string} issue  versionIssue の答え
 * @returns {boolean} 止めたら true
 */
function versionGate(app, issue, { log = (l) => console.log(l), flush = (cb) => process.stdout.write('', cb) } = {}) {
  if (!issue) return false;
  log(`NG 版: ${issue}`);
  flush(() => app.exit(1));
  return true;
}

module.exports = { versionIssue, versionGate };
