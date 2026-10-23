// mcp-probe のテストの偽の壊れたサーバー（0.10.0 E-1）: 本物のサーバーを動かすが、起動の時に標準出力へ JSON-RPC でない文字を1行混ぜる
'use strict';
process.stdout.write('ようこそ（標準出力に混ざった文字）\n');
require('../../../src/mcp/server.js').main();
