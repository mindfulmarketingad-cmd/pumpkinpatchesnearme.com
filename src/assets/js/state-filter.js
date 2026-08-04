/* =====================================================================
   Search, filter and sort for the full state directory list. Operates
   entirely on the server-rendered .pillar-entry elements already in the
   page (data-name/data-city/data-features/data-rating/data-reviews) — no
   fetch, and every listing is still in the initial HTML for crawlers
   regardless of what this script does.
   ===================================================================== */
(function () {
  'use strict';

  var list = document.getElementById('state-pillar-list');
  var qInput = document.getElementById('state-filter-q');
  var featureSelect = document.getElementById('state-filter-feature');
  var sortSelect = document.getElementById('state-filter-sort');
  var resetBtn = document.getElementById('state-filter-reset');
  var countEl = document.getElementById('state-filter-count');
  var emptyEl = document.getElementById('state-filter-empty');
  var emptyResetBtn = document.getElementById('state-filter-empty-reset');
  if (!list || !qInput || !featureSelect || !sortSelect) return;

  var items = Array.prototype.slice.call(list.querySelectorAll('.pillar-entry'));

  function apply() {
    var q = qInput.value.trim().toLowerCase();
    var feature = featureSelect.value;
    var sortKey = sortSelect.value;

    var visible = 0;
    items.forEach(function (el) {
      var name = el.getAttribute('data-name') || '';
      var city = el.getAttribute('data-city') || '';
      var features = el.getAttribute('data-features') || '';
      var matchesQuery = !q || name.indexOf(q) !== -1 || city.indexOf(q) !== -1;
      var matchesFeature = !feature || features.split('|').indexOf(feature) !== -1;
      var show = matchesQuery && matchesFeature;
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
      return Number(b.getAttribute('data-rating')) - Number(a.getAttribute('data-rating'));
    });
    sorted.forEach(function (el) { list.appendChild(el); });

    if (countEl) countEl.textContent = visible.toLocaleString('en-US') + ' pumpkin patch' + (visible === 1 ? '' : 'es');
    if (emptyEl) emptyEl.hidden = visible !== 0;
    list.hidden = visible === 0;
  }

  var timer = null;
  qInput.addEventListener('input', function () {
    window.clearTimeout(timer);
    timer = window.setTimeout(apply, 120);
  });
  featureSelect.addEventListener('change', apply);
  sortSelect.addEventListener('change', apply);

  function reset() {
    qInput.value = '';
    featureSelect.value = '';
    sortSelect.value = 'rating';
    apply();
  }
  if (resetBtn) resetBtn.addEventListener('click', reset);
  if (emptyResetBtn) emptyResetBtn.addEventListener('click', reset);
})();
