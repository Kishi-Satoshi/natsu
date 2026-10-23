/* search.js — ヘルプセンターの検索（H-4）
 *
 * PC の中（ブラウザの中）だけで探す。最初に打ったときに /search-index.json を1回だけ読み、
 * NFKC と小文字にそろえた部分一致で、題名 > 見出し・説明 > 本文の順に並べる。外へは通信しない。
 * 結果の文字は textContent で入れる（HTML の文字を差し込まない）。JS が動かないときは箱を出さない（hidden のまま）。
 * help-dads HD-5（HD6）: 結果を出すたびに、箱の中の見えない role="status" に件数の文を入れる（決まった文だけ。閉じたら空。
 * 同じ文なら書き直さない: 読み上げが積もらない）。上限の 8 件は全体の数と偽らず「上から 8 件を表示しています」と言う。
 */
'use strict';
var HelpSearch = (function () {
  var MAX = 8;

  function fold(s) {
    return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** 上から 8 件まで [{ u, t, c }]。q を空白で分けた語が全部どこかにある記事だけ。点: 題名 3・見出し 2・説明 2・本文 1（語ごとの最大を足す） */
  function rank(items, q) {
    var f = fold(q);
    if (!f) return [];
    var words = f.split(' ');
    var hits = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var t = fold(it.t);
      var d = fold(it.d);
      var x = fold(it.x);
      var h = (it.h || []).map(fold);
      var score = 0;
      var all = true;
      for (var k = 0; k < words.length; k++) {
        var w = words[k];
        var s = 0;
        if (t.indexOf(w) >= 0) s = 3;
        else if (d.indexOf(w) >= 0 || h.some(function (x2) { return x2.indexOf(w) >= 0; })) s = 2;
        else if (x.indexOf(w) >= 0) s = 1;
        if (!s) { all = false; break; }
        score += s;
      }
      if (all) hits.push({ i: i, score: score });
    }
    hits.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    return hits.slice(0, MAX).map(function (r) { var it = items[r.i]; return { u: it.u, t: it.t, c: it.c }; });
  }

  /** ページの検索の箱（.search）を全部つなぐ。opts: { read() → 索引の答え（fetch の Response の形）, go(url) } */
  function wire(doc, opts) {
    var load = null;
    function index() {
      if (!load) {
        load = opts.read()
          .then(function (r) { if (!r.ok) throw new Error('index'); return r.json(); })
          .then(function (j) { return (j && j.v === 1 && Array.isArray(j.items)) ? j.items : []; })
          .catch(function (e) { load = null; throw e; });
      }
      return load;
    }
    var boxes = doc.querySelectorAll('.search');
    var all = [];
    for (var b = 0; b < boxes.length; b++) {
      var box = boxes[b];
      var input = box.querySelector('input');
      var list = box.querySelector('[role="listbox"]');
      if (!input || !list) continue;
      all.push(one(box, input, list));
    }
    doc.addEventListener('click', function (e) {
      for (var k = 0; k < all.length; k++) {
        if (!(e.target && e.target.closest && e.target.closest('.search') === all[k].box)) all[k].close();
      }
    });

    function one(box, input, list) {
      var results = [];
      var active = -1;
      var status = box.querySelector('[role="status"]');
      // 狭い画面では置き換えの文を短くする（上の帯の箱の data-short。文字の設定を大きくしたときも rem の幅で当たる: 再審査の指摘 4）
      var short = input.getAttribute('data-short');
      var mq = short && opts.media ? opts.media('(max-width: 29.9375rem)') : null;
      if (mq) {
        var long = input.getAttribute('placeholder');
        var fit = function () { input.setAttribute('placeholder', mq.matches ? short : long); };
        fit();
        if (mq.addEventListener) mq.addEventListener('change', fit);
      }
      function say(text) {
        if (status && status.textContent !== text) status.textContent = text;
      }
      function close() {
        say('');
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        active = -1;
      }
      function mark() {
        var opts2 = list.querySelectorAll('[role="option"]');
        for (var k = 0; k < opts2.length; k++) opts2[k].setAttribute('aria-selected', k === active ? 'true' : 'false');
        if (active >= 0) input.setAttribute('aria-activedescendant', opts2[active].id);
        else input.removeAttribute('aria-activedescendant');
      }
      function show(items, note) {
        list.textContent = '';
        results = items;
        active = -1;
        if (!items.length) {
          var none = doc.createElement('li');
          none.setAttribute('role', 'option');
          none.setAttribute('aria-disabled', 'true');
          none.className = 'none';
          none.textContent = note || '見つかりませんでした';
          list.appendChild(none);
        }
        for (var k = 0; k < items.length; k++) {
          // 選択肢はリンクそのもの（a[role="option"]）。li は role="none"（選択肢の中にリンクを入れ子にしない: WCAG 4.1.2）
          var li = doc.createElement('li');
          li.setAttribute('role', 'none');
          var a = doc.createElement('a');
          a.id = input.id + '-opt-' + k;
          a.setAttribute('role', 'option');
          a.setAttribute('aria-selected', 'false');
          a.setAttribute('href', items[k].u);
          a.setAttribute('tabindex', '-1');
          var t = doc.createElement('span');
          t.className = 'rt';
          t.textContent = items[k].t;
          var c = doc.createElement('span');
          c.className = 'rc';
          c.textContent = items[k].c;
          a.appendChild(t);
          a.appendChild(c);
          li.appendChild(a);
          list.appendChild(li);
        }
        say(note || (!items.length ? '見つかりませんでした' : items.length >= MAX ? '上から ' + MAX + ' 件を表示しています' : items.length + ' 件見つかりました'));
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        input.removeAttribute('aria-activedescendant');
      }
      function update() {
        var q = input.value;
        if (!fold(q)) { close(); results = []; return; }
        index().then(function (items) {
          if (input.value !== q) return;   // 読んでいる間に打ち直した
          show(rank(items, q));
        }, function () {
          if (input.value === q) show([], '検索を読み込めませんでした。開き直してください');
        });
      }
      input.addEventListener('input', update);
      input.addEventListener('keydown', function (e) {
        var open = list.hidden === false;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (!open || !results.length) return;
          e.preventDefault();
          var n = results.length;
          active = e.key === 'ArrowDown' ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1);
          mark();
        } else if (e.key === 'Enter') {
          if (!open || !results.length) return;
          e.preventDefault();
          opts.go(results[active >= 0 ? active : 0].u);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (open) close();
          else input.value = '';
        }
      });
      close();
      box.hidden = false;
      return { box: box, close: close };
    }
  }

  return { fold: fold, rank: rank, wire: wire };
})();

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  HelpSearch.wire(document, {
    read: function () { return fetch('/search-index.json'); },
    go: function (u) { window.location.assign(u); },
    media: function (q) { return window.matchMedia ? window.matchMedia(q) : null; },
  });
}
if (typeof module === 'object') module.exports = HelpSearch;
