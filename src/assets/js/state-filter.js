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
  var citySelect = document.getElementById('state-filter-city');
  var stateSelect = document.getElementById('state-filter-state');
  var featureSelect = document.getElementById('state-filter-feature');
  var sortSelect = document.getElementById('state-filter-sort');
  var resetBtn = document.getElementById('state-filter-reset');
  var countEl = document.getElementById('state-filter-count');
  var emptyEl = document.getElementById('state-filter-empty');
  var emptyResetBtn = document.getElementById('state-filter-empty-reset');
  if (!list || !qInput || !featureSelect || !sortSelect) return;

  var items = Array.prototype.slice.call(list.querySelectorAll('.pillar-entry'));

  // Ad slots spliced into the list (see pillarEntriesWithAds() in
  // build.mjs) aren't .pillar-entry elements, so the sort below never
  // moves them — left alone, appendChild()-ing every real entry to the
  // end would drag every ad to the top of the list after the first
  // filter/sort interaction. Record each ad's original "after the Nth
  // entry" position once, then restore it after every re-sort.
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
    var city = citySelect ? citySelect.value : '';
    var state = stateSelect ? stateSelect.value : '';
    var feature = featureSelect.value;
    var sortKey = sortSelect.value;

    var visible = 0;
    items.forEach(function (el) {
      var name = el.getAttribute('data-name') || '';
      var cityVal = el.getAttribute('data-city') || '';
      var stateVal = el.getAttribute('data-state') || '';
      var features = el.getAttribute('data-features') || '';
      var matchesQuery = !q || name.indexOf(q) !== -1 || cityVal.indexOf(q) !== -1 || stateVal.indexOf(q) !== -1;
      var matchesCity = !city || cityVal === city;
      var matchesState = !state || stateVal === state;
      var matchesFeature = !feature || features.split('|').indexOf(feature) !== -1;
      var show = matchesQuery && matchesCity && matchesState && matchesFeature;
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
        // Entries without a distance yet (location not shared) sort last rather
        // than to the top as "0 miles away".
        if (da == null && db == null) return Number(b.getAttribute('data-rating')) - Number(a.getAttribute('data-rating'));
        if (da == null) return 1;
        if (db == null) return -1;
        return Number(da) - Number(db);
      }
      return Number(b.getAttribute('data-rating')) - Number(a.getAttribute('data-rating'));
    });
    sorted.forEach(function (el) { list.appendChild(el); });
    adAnchors.forEach(function (anchor) { list.insertBefore(anchor.el, sorted[anchor.precedingCount] || null); });

    if (countEl) countEl.textContent = visible.toLocaleString('en-US') + ' pumpkin patch' + (visible === 1 ? '' : 'es');
    if (emptyEl) emptyEl.hidden = visible !== 0;
    list.hidden = visible === 0;
  }

  var timer = null;
  qInput.addEventListener('input', function () {
    window.clearTimeout(timer);
    timer = window.setTimeout(apply, 120);
  });
  if (citySelect) citySelect.addEventListener('change', apply);
  if (stateSelect) stateSelect.addEventListener('change', apply);
  featureSelect.addEventListener('change', apply);
  sortSelect.addEventListener('change', function () {
    // Picking "Nearest to me" is itself the user gesture that justifies
    // requesting location — trigger the same flow the visible button uses
    // if distances haven't been computed yet.
    if (sortSelect.value === 'distance' && !list.querySelector('.pillar-entry[data-distance]')) {
      var geoBtn = document.querySelector('[data-geo-trigger]');
      if (geoBtn) geoBtn.click();
    }
    apply();
  });
  document.addEventListener('pillar:distances-ready', apply);

  function reset() {
    qInput.value = '';
    if (citySelect) citySelect.value = '';
    if (stateSelect) stateSelect.value = '';
    featureSelect.value = '';
    sortSelect.value = 'rating';
    apply();
  }
  if (resetBtn) resetBtn.addEventListener('click', reset);
  if (emptyResetBtn) emptyResetBtn.addEventListener('click', reset);
})();
