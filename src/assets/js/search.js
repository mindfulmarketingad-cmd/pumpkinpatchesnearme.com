/* Client-side search over farms, states, towns, attractions and guides. */
(function () {
  'use strict';

  var input = document.getElementById('site-search-input');
  var status = document.getElementById('site-search-status');
  var results = document.getElementById('site-search-results');
  if (!input || !results) return;

  var MAX_RESULTS = 40;
  var index = [];

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function render(items, query) {
    if (!query) {
      status.textContent = 'Start typing to search ' + index.filter((i) => i.type.indexOf('Farm') === 0).length.toLocaleString('en-US') + ' pumpkin patches, towns, states and guides.';
      results.innerHTML = '';
      return;
    }
    if (!items.length) {
      status.textContent = 'No matches for "' + query + '"';
      results.innerHTML = '<div class="empty-state"><h3>Nothing found</h3><p>Try a farm name, a town, or a state. You can also <a href="/">browse the map</a> or <a href="/find/">browse by state</a>.</p></div>';
      return;
    }
    status.textContent = items.length + ' result' + (items.length === 1 ? '' : 's') + (items.length >= MAX_RESULTS ? ' (showing the first ' + MAX_RESULTS + ')' : '');
    results.innerHTML = items
      .slice(0, MAX_RESULTS)
      .map(function (item) {
        return '<div class="search-result">' +
          '<span class="search-kind">' + esc(item.type) + '</span>' +
          '<h3><a href="' + esc(item.url) + '">' + esc(item.name) + '</a></h3>' +
          '<p>' + esc(item.place) + '</p>' +
          '</div>';
      })
      .join('');
  }

  function search(query) {
    var q = query.trim().toLowerCase();
    if (!q) return render([], '');
    var scored = [];
    for (var i = 0; i < index.length; i++) {
      var item = index[i];
      var haystack = (item.name + ' ' + item.place).toLowerCase();
      var idx = haystack.indexOf(q);
      if (idx === -1) continue;
      // Prefer matches at the start of the name, then shorter names.
      var score = (item.name.toLowerCase().indexOf(q) === 0 ? 0 : 10) + idx + item.name.length * 0.01;
      scored.push({ item: item, score: score });
    }
    scored.sort(function (a, b) { return a.score - b.score; });
    render(scored.map(function (s) { return s.item; }), query.trim());
  }

  var params = new URLSearchParams(window.location.search);
  var initial = params.get('q') || '';

  fetch('/data/search-index.json')
    .then(function (res) { return res.json(); })
    .then(function (json) {
      index = json;
      if (initial) { input.value = initial; search(initial); }
      else render([], '');
    })
    .catch(function () {
      status.textContent = 'Search could not be loaded. Try browsing by state instead.';
    });

  var timer = null;
  input.addEventListener('input', function () {
    window.clearTimeout(timer);
    timer = window.setTimeout(function () { search(input.value); }, 120);
  });
})();
