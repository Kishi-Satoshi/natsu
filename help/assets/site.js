/* site.js — ヘルプセンターの小さな動き（H-3）: 狭い画面の［目次］の開け閉めだけ。
 * 外へ通信しない・HTML の文字を差し込まない。JS が動かないときは、目次は本文の下に出たまま。 */
'use strict';
(function () {
  document.documentElement.classList.add('js');
  var btn = document.querySelector('.toc-btn');
  var toc = document.getElementById('hc-toc');
  if (!btn || !toc) return;
  btn.hidden = false;
  btn.addEventListener('click', function () {
    var open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    toc.classList.toggle('open', open);
  });
})();
