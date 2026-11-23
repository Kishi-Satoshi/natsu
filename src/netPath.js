'use strict';
/*
 * netPath.js — フォルダがネットワークの場所か（純粋。読み書きしない）
 *
 * isNetworkPath(p) → \\server\share（と \\?\UNC\…）の形なら真（設計書 P9。\\?\C:\ と \\.\ は手元の場所）。
 * main（DB のフォルダの WAL をやめる・DB のプロセスの init の network）と、0.18.0 CT-4 の MCP のプロセス（ネットワークの場所なら書く道具は扉を探さずに
 * network で答える: 計画 docs/plans/2026-11-18-180.md の決めたこと 5・AQ36 (a)）が同じ1か所を読む（MCP のプロセスは控えの部品 snapshot.js を読まない）。
 */

function isNetworkPath(p) {
  const s = String(p || '');
  if (/^[\\/]{2}[?.][\\/]/.test(s)) return /^[\\/]{2}\?[\\/]UNC[\\/]/i.test(s);   // \\?\C:\… と \\.\… は手元、\\?\UNC\… は UNC
  return /^\\\\[^\\/]/.test(s);
}

module.exports = { isNetworkPath };
