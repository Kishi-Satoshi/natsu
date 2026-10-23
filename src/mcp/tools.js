'use strict';
// MCP の6つの道具（0.10.0 Task T-1〜T-7。計画 docs/plans/2026-10-20-100.md の「受け渡す名前と形」と「道具」の表）。
// S-2 の間は道具の表が空（TOOLS = []）。道具の誤りの文（「画面と答えの文」の E）はサーバーの入口も使う。

// 道具の誤りの文（E）。isError: true の答えの本文
const ERROR_TEXT = Object.freeze({
  'no-db': 'NaTsu の議事録が見つかりません。NaTsu を一度起動してから、もう一度試してください。',
  locked: 'NaTsu が議事録の手入れ（控えからの戻しなど）をしています。少し待ってから、もう一度試してください。',
  'stale-lock': '議事録を今の形で読めません。NaTsu を一度起動してから、もう一度試してください。',
  old: '議事録を今の形で読めません。NaTsu を一度起動してから、もう一度試してください。',
  newer: 'NaTsu が新しくなっています。Claude を起動し直すと読めます。',
  busy: '議事録を今は開けませんでした。少し待ってから、もう一度試してください。',
  open: '議事録を今は開けませんでした。少し待ってから、もう一度試してください。',
  read: '議事録を今は開けませんでした。少し待ってから、もう一度試してください。',
});

const TOOLS = Object.freeze([]);

// callTool(name, args, ctx) → { text, isError, code?, count? }。知らない名前は投げる（rpc が -32602 にする前に表で断る）
function callTool(name) {
  throw new Error(`知らない道具: ${String(name).slice(0, 40)}`);
}

module.exports = { TOOLS, callTool, ERROR_TEXT };
