/* site.js — ヘルプセンターの小さな動き（H-3）: 狭い画面の［目次］の開け閉めと目次の並び（Tab の順を見た目に合わせる）と、横に送れる表の領域とコードの塊にだけ tabindex を付けること（再審査の指摘 5・6回目の指摘）。
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
  // 本文のコードの塊（main pre）も同じ: 横に送れるときだけキーボードで止まり、名前を持つ（6回目の指摘・WCAG 2.1.1）。
  // pre は名前を持てない役なので、表の領域と同じく role="region" を付ける。2つ以上あれば名前に番号（領域の名前を重ねない）
  var pres = document.querySelectorAll('main pre');
  function fitPres() {
    for (var i = 0; i < pres.length; i++) {
      var p = pres[i];
      if (p.scrollWidth > p.clientWidth) {
        p.setAttribute('tabindex', '0');
        p.setAttribute('role', 'region');
        p.setAttribute('aria-label', pres.length > 1 ? 'コード ' + (i + 1) : 'コード');
      } else {
        p.removeAttribute('tabindex');
        p.removeAttribute('role');
        p.removeAttribute('aria-label');
      }
    }
  }
  if (pres.length) {
    fitPres();
    window.addEventListener('resize', fitPres);
  }
  var btn = document.querySelector('.toc-btn');
  var toc = document.getElementById('hc-toc');
  if (!btn || !toc) return;
  btn.hidden = false;
  // 狭い画面では目次が［目次］のすぐ下に開く（CSS の order）。Tab の並びも見た目と同じにするため、狭い間だけ目次を DOM で
  // ［目次］の直後へ移し、広くなれば元の場所（本文の後ろ）へ戻す（3回目の審査の指摘 1・WCAG 2.4.3。1280px の Tab の順は Q12 のまま）
  var mq = window.matchMedia ? window.matchMedia('(max-width: 639px)') : null;
  if (mq && btn.parentNode === toc.parentNode) {
    var box = toc.parentNode;
    var home = toc.nextSibling;
    var place = function () {
      // 動かすとブラウザーは中のフォーカスを外すので、目次の中にあったら動かした後に戻す（4回目の審査の指摘 2）
      var had = document.activeElement;
      var n = had;
      while (n && n !== toc) n = n.parentNode;
      if (n !== toc) had = null;
      if (mq.matches) box.insertBefore(toc, btn.nextSibling);
      else box.insertBefore(toc, home);
      if (had && had.focus) had.focus({ preventScroll: true });
    };
    place();
    if (mq.addEventListener) mq.addEventListener('change', place);
  }
  btn.addEventListener('click', function () {
    var open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    toc.classList.toggle('open', open);
  });
})();
