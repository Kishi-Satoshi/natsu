/* site.js — ヘルプセンターの小さな動き（H-3）: 狭い画面の［目次］の開け閉めと、横に送れる表の領域にだけ tabindex を付けること（再審査の指摘 5）。
 * 外へ通信しない・HTML の文字を差し込まない。JS が動かないときは、目次は本文の下に出たまま。 */
'use strict';
(function () {
  document.documentElement.classList.add('js');
  // 表の領域（help-md の .table）は、横に送れるときだけキーボードで止まる（送れない表に Tab を止めない）。窓の大きさが変われば付け直す
  var tables = document.querySelectorAll('.table');
  function fitTables() {
    for (var i = 0; i < tables.length; i++) {
      if (tables[i].scrollWidth > tables[i].clientWidth) tables[i].setAttribute('tabindex', '0');
      else tables[i].removeAttribute('tabindex');
    }
  }
  if (tables.length) {
    fitTables();
    window.addEventListener('resize', fitTables);
  }
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
