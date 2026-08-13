/* =====================================================================
   Search, filter and sort for attraction category pages (e.g. /corn-mazes/,
   /hayrides/). Same pattern as state-filter.js, but the fixed dimension is
   the attraction itself, so the dropdown filters by state instead.
   ===================================================================== */
(function () {
  'use strict';

  var list = document.getElementById('cat-pillar-list');
  var qInput = document.getElementById('cat-filter-q');
  var stateSelect = document.getElementById('cat-filter-state');
  var sortSelect = document.getElementById('cat-filter-sort');
  var resetBtn = document.getElementById('cat-filter-reset');
  var countEl = document.getElementById('cat-filter-count');
  var emptyEl = document.getElementById('cat-filter-empty');
  var emptyResetBtn = document.getElementById('cat-filter-empty-reset');
  if (!list || !qInput || !stateSelect || !sortSelect) return;

  var items = Array.prototype.slice.call(list.querySelectorAll('.pillar-entry'));

  // See the matching comment in state-filter.js: ad slots spliced into the
  // list aren't .pillar-entry elements, so re-sorting would otherwise drag
  // them all to the top after the first interaction. Restore each ad's
  // original "after the Nth entry" position on every re-sort.
  var adAnchors = Array.prototype.slice.call(list.querySelectorAll('.pillar-ad')).map(function (adEl) {
    var precedingCount = 0;
    var node = adEl.previousSibling;
    while (node) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('pillar-entry')) precedingCount++;
      node = node.previousSibling;
    }
    return { el: adEl, precedingCount: precedingCount };
  });

  function apply() {
    var q = qInput.value.trim().toLowerCase();
    var state = stateSelect.value;
    var sortKey = sortSelect.value;

    var visible = 0;
    items.forEach(function (el) {
      var name = el.getAttribute('data-name') || '';
      var city = el.getAttribute('data-city') || '';
      var stateVal = el.getAttribute('data-state') || '';
      var matchesQuery = !q || name.indexOf(q) !== -1 || city.indexOf(q) !== -1;
      var matchesState = !state || stateVal === state;
      var show = matchesQuery && matchesState;
      el.hidden = !show;
      if (show) visible++;
    });

    var sorted = items.slice().sort(function (a, b) {
      if (sortKey === 'name') {
        return (a.getAttribute('data-name') || '').localeCompare(b.getAttribute('data-name') || '');
      }
      if (sortKey === 'reviews') {
        return Number(b.getAttribute('data-reviews')) - Number(a.getAttribute('data-reviews'));
      }
      if (sortKey === 'distance') {
        var da = a.getAttribute('data-distance');
        var db = b.getAttribute('data-distance');
        if (da == null && db == null) return Number(b.getAttribute('data-rating')) - Number(a.getAttribute('data-rating'));
        if (da == null) return 1;
        if (db == null) return -1;
        return Number(da) - Number(db);
      }
      return Number(b.getAttribute('data-rating')) - Number(a.getAttribute('data-rating'));
    });
    sorted.forEach(function (el) { list.appendChild(el); });
    adAnchors.forEach(function (anchor) { list.insertBefore(anchor.el, sorted[anchor.precedingCount] || null); });

    if (countEl) countEl.textContent = visible.toLocaleString('en-US') + ' listing' + (visible === 1 ? '' : 's');
    if (emptyEl) emptyEl.hidden = visible !== 0;
    list.hidden = visible === 0;
  }

  var timer = null;
  qInput.addEventListener('input', function () {
    window.clearTimeout(timer);
    timer = window.setTimeout(apply, 120);
  });
  stateSelect.addEventListener('change', apply);
  sortSelect.addEventListener('change', function () {
    if (sortSelect.value === 'distance' && !list.querySelector('.pillar-entry[data-distance]')) {
      var geoBtn = document.querySelector('[data-geo-trigger]');
      if (geoBtn) geoBtn.click();
    }
    apply();
  });
  document.addEventListener('pillar:distances-ready', apply);

  function reset() {
    qInput.value = '';
    stateSelect.value = '';
    sortSelect.value = 'rating';
    apply();
  }
  if (resetBtn) resetBtn.addEventListener('click', reset);
  if (emptyResetBtn) emptyResetBtn.addEventListener('click', reset);
})();
