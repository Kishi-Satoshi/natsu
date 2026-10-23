/*
 * mcp-entry.js — テストだけの MCP のサーバーの入口（0.10.0 S-2。決めたこと 33: src/ に環境変数のテストだけの道を置かない）
 *   src/mcp/server.js の main({ tools, call }) に偽の道具を渡す。道具:
 *     say  … console.log・console.info・console.error・console.dir・process.emitWarning を呼んでから答える（標準出力の守りを見る）
 *     cwd  … サーバーの作業フォルダを答える（作業フォルダをアプリの外へ移したかを見る）
 *     boom … 目印の文字と一時フォルダの名前を含む Error で投げる（記録と答えに例外の文が出ないかを見る）
 *     big  … 200KB の答え（標準入力を閉じた直後でも、答えを出し切ってから終わるかを見る）
 *     echo … 引数の text をそのまま答える（塊の境の 𠮷 を見る）
 */
'use strict';

const os = require('node:os');
const server = require('../../src/mcp/server');

const schema = { type: 'object', properties: {}, additionalProperties: true };
const tools = ['say', 'cwd', 'boom', 'big', 'echo'].map((name) => ({ name, title: name, description: `テストの道具 ${name}`, inputSchema: schema }));

function call(name, args) {
  if (name === 'say') {
    console.log('console.log の文');
    console.info('console.info の文');
    console.error('console.error の文');
    console.dir({ dir: 'console.dir の文' });
    process.emitWarning('emitWarning の文');
    return { text: 'say の答え', count: 1 };
  }
  if (name === 'cwd') return { text: process.cwd() };
  if (name === 'boom') throw new Error(`ひみつの合言葉𠮷 ${os.tmpdir()}/natsu-議事録/natsu.db`);
  if (name === 'big') return { text: '大'.repeat(200 * 1024) };
  if (name === 'echo') return { text: String(args.text) };
  throw new Error('知らない道具');
}

server.main({ tools, call });
