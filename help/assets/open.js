/* open.js — NaTsu ヘルプセンターの /open のページ（0.10.0 LN-5。D78・決めたこと 155・156）。
 * Claude の答えの出典のリンク（ヘルプのサイトの /open#p=<ID>&a=<印>）を押すと開くページ。# の後ろだけを読み（ブラウザーはサーバーへ送らない）、
 * src/natsulink.js の parseOpenUrl と同じ照らし（test/stage100.open.test.js が同じ表を当てる）を通ったときだけ natsu://page/<ID>#<印> で NaTsu を開く。
 * 外へ通信しない・HTML の文字を差し込まない（文字は textContent だけ）。会議の中身を持たない。 */
'use strict';
(function () {
  var MAX = 300;
  var ID = /^[A-Za-z0-9_-]{1,64}$/;
  var ANCHOR = /^(?:t:s\d{1,6}-s\d{1,6}|b:[A-Za-z0-9_-]{1,64}|m:\d{1,4})$/;
  var KEY = /^[a-z]{1,16}$/;
  var VALUE = /^[A-Za-z0-9_:.-]{0,64}$/;
  var LOST = 'ログインの後は、Claude のリンクをもう一度押してください。';
  var BAD = 'このリンクは開けません（形が違います）';
  var DONE = 'NaTsu で開きました。このタブは閉じてかまいません。';

  // # の後ろ（# を除いた文字）→ { id, anchor } か null
  function parseFrag(frag) {
    var t = String(frag).trim();
    if (!t || t.length > MAX) return null;
    if (t.charAt(t.length - 1) === '/') t = t.slice(0, -1);
    var pairs = t.split('&');
    var first = pairs[0];
    if (first.indexOf('p=') !== 0 || !ID.test(first.slice(2))) return null;
    var anchor = null;
    for (var i = 1; i < pairs.length; i++) {
      var at = pairs[i].indexOf('=');
      if (at < 0) return null;
      var k = pairs[i].slice(0, at);
      var v = pairs[i].slice(at + 1);
      if (!KEY.test(k) || k === 'p') return null;
      if (k === 'a') {
        if (anchor !== null || !ANCHOR.test(v)) return null;
        anchor = v;
      } else if (!VALUE.test(v)) return null;
    }
    return { id: first.slice(2), anchor: anchor || '' };
  }

  var msg = document.getElementById('hc-open-msg');
  var go = document.getElementById('hc-open-go');
  if (!msg || !go) return;
  var raw = String(location.hash || '').replace(/^#/, '');
  if (!raw) { msg.textContent = LOST; return; }   // ログインの画面を通ると # の後ろが落ちることがある（R23）
  var p = parseFrag(raw);
  if (!p) { msg.textContent = BAD; return; }
  var link = 'natsu://page/' + p.id + (p.anchor ? '#' + p.anchor : '');
  go.setAttribute('href', link);
  go.hidden = false;   // ブラウザーが押されずに開いた natsu:// を止めたときは、押して開ける
  msg.textContent = DONE;
  location.href = link;
})();
