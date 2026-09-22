/* =====================================================================
   Search, filter and sort for an /experiences/[state]/ grid. Works on the
   server-rendered .experience-card elements already in the page
   (data-kinds/data-name/data-place/data-rating/data-reviews) — no fetch,
   so every experience stays in the initial HTML for crawlers no matter
   what this script does.
   ===================================================================== */
(function () {
  'use strict';

  var grid = document.getElementById('experience-grid');
  var qInput = document.getElementById('experience-filter-q');
  var kindSelect = document.getElementById('experience-filter-kind');
  var placeSelect = document.getElementById('experience-filter-place');
  var sortSelect = document.getElementById('experience-filter-sort');
  var resetBtn = document.getElementById('experience-filter-reset');
  var countEl = document.getElementById('experience-filter-count');
  var emptyEl = document.getElementById('experience-filter-empty');
  var emptyResetBtn = document.getElementById('experience-filter-empty-reset');
  if (!grid || !qInput || !sortSelect) return;

  var cards = Array.prototype.slice.call(grid.querySelectorAll('.experience-card'));

  function apply() {
    var q = qInput.value.trim().toLowerCase();
    var kind = kindSelect ? kindSelect.value : '';
    var place = placeSelect ? placeSelect.value : '';
    var sortKey = sortSelect.value;

    var visible = 0;
    cards.forEach(function (el) {
      var name = el.getAttribute('data-name') || '';
      var placeVal = el.getAttribute('data-place') || '';
      var kinds = (el.getAttribute('data-kinds') || '').split(' ');
      var show = (!q || name.indexOf(q) !== -1 || placeVal.indexOf(q) !== -1) &&
        (!kind || kinds.indexOf(kind) !== -1) &&
        (!place || placeVal === place);
      el.hidden = !show;
      if (show) visible++;
    });

    cards.slice().sort(function (a, b) {
      if (sortKey === 'name') {
        return (a.getAttribute('data-name') || '').localeCompare(b.getAttribute('data-name') || '');
      }
      if (sortKey === 'reviews') {
        return Number(b.getAttribute('data-reviews')) - Number(a.getAttribute('data-reviews'));
      }
      return Number(b.getAttribute('data-rating')) - Number(a.getAttribute('data-rating'));
    }).forEach(function (el) { grid.appendChild(el); });

    if (countEl) countEl.textContent = visible.toLocaleString('en-US') + ' experience' + (visible === 1 ? '' : 's');
    if (emptyEl) emptyEl.hidden = visible !== 0;
    grid.hidden = visible === 0;
  }

  var timer = null;
  qInput.addEventListener('input', function () {
    window.clearTimeout(timer);
    timer = window.setTimeout(apply, 120);
  });
  if (kindSelect) kindSelect.addEventListener('change', apply);
  if (placeSelect) placeSelect.addEventListener('change', apply);
  sortSelect.addEventListener('change', apply);

  function reset() {
    qInput.value = '';
    if (kindSelect) kindSelect.value = '';
    if (placeSelect) placeSelect.value = '';
    sortSelect.value = 'rating';
    apply();
  }
  if (resetBtn) resetBtn.addEventListener('click', reset);
  if (emptyResetBtn) emptyResetBtn.addEventListener('click', reset);
})();
