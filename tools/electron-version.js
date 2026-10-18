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

module.exports = { versionIssue };
