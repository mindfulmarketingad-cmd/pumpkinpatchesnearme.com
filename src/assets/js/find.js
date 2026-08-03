/* =====================================================================
   /find/ search tool: free-text search (name, city, state, county, ZIP),
   filter by attraction / state / rating, sort by distance, rating, reviews
   or name. No map — a simple, fast results list with images.
   ===================================================================== */
(function () {
  'use strict';

  var els = {
    tool: document.getElementById('find-tool'),
    form: document.getElementById('find-form'),
    query: document.getElementById('find-query'),
    geo: document.getElementById('find-geo-btn'),
    filterFeature: document.getElementById('find-filter-feature'),
    filterState: document.getElementById('find-filter-state'),
    filterRating: document.getElementById('find-filter-rating'),
    sort: document.getElementById('find-sort'),
    reset: document.getElementById('find-reset-btn'),
    count: document.getElementById('find-results-count'),
    scope: document.getElementById('find-results-scope'),
    results: document.getElementById('find-results'),
    moreBtn: document.getElementById('find-more-btn'),
  };

  if (!els.tool || !els.results) return;

  var PAGE_SIZE = 24;
  var PLACEHOLDER_IMAGE = '/assets/img/patch-placeholder.svg';

  var state = {
    all: [],
    filtered: [],
    shown: 0,
    origin: null, // { lat, lng, label }
  };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function distanceMiles(lat1, lng1, lat2, lng2) {
    var R = 3958.8;
    var toRad = function (d) { return (d * Math.PI) / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function starString(rating) {
    var full = Math.round(rating);
    return new Array(full + 1).join('★') + new Array(Math.max(0, 5 - full) + 1).join('☆');
  }

  function imgHtml(item) {
    var src = item.photo || PLACEHOLDER_IMAGE;
    return '<img class="listing-card-img" src="' + esc(src) + '" alt="' + esc(item.name) + '" loading="lazy" decoding="async" onerror="this.onerror=null;this.src=\'' + PLACEHOLDER_IMAGE + '\';">';
  }

  function cardHtml(item) {
    var place = [item.city, item.stateCode].filter(Boolean).join(', ');
    var tags = (item.features || []).slice(0, 3);
    return '<article class="listing-card' + (item.featured ? ' is-featured' : '') + '">' +
      (item.featured ? '<p class="featured-flag">Featured farm</p>' : '') +
      '<a class="listing-card-media" href="' + esc(item.url) + '" tabindex="-1" aria-hidden="true">' + imgHtml(item) + '</a>' +
      '<div class="listing-card-body">' +
        '<h3><a href="' + esc(item.url) + '">' + esc(item.name) + '</a></h3>' +
        '<div class="listing-meta">' +
          (item.rating ? '<span class="rating"><span class="stars" aria-hidden="true">' + starString(item.rating) + '</span> ' + item.rating.toFixed(1) + '</span>' : '') +
          (item.reviews ? '<span>' + item.reviews.toLocaleString('en-US') + ' reviews</span>' : '') +
          (place ? '<span>' + esc(place) + '</span>' : '') +
        '</div>' +
        (item.street ? '<p class="listing-address">' + esc(item.street) + (item.postalCode ? ', ' + esc(item.postalCode) : '') + '</p>' : '') +
        (item._distance != null ? '<p><span class="listing-distance">' + item._distance.toFixed(1) + ' mi away</span></p>' : '') +
        (tags.length ? '<div class="tag-row">' + tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>' : '') +
        '<div class="card-actions">' +
          '<a class="btn btn-primary btn-sm" href="' + esc(item.url) + '">View details</a>' +
          '<a class="btn btn-outline btn-sm" href="https://www.google.com/maps/dir/?api=1&destination=' + item.lat + ',' + item.lng + '" target="_blank" rel="noopener nofollow">Directions</a>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  /* ------------------------------------------------------------- search */

  function matchesQuery(item, q) {
    if (!q) return true;
    var haystack = [item.name, item.city, item.county, item.state, item.stateCode, item.postalCode]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.indexOf(q) !== -1;
  }

  function findZipInData(zip) {
    var exact = state.all.filter(function (i) { return i.postalCode === zip; });
    if (exact.length) return { lat: exact[0].lat, lng: exact[0].lng, label: zip };
    var prefix = zip.slice(0, 3);
    var near = state.all.filter(function (i) { return i.postalCode && i.postalCode.slice(0, 3) === prefix; });
    if (near.length) return { lat: near[0].lat, lng: near[0].lng, label: zip };
    return null;
  }

  function lookupZip(zip) {
    var local = findZipInData(zip);
    if (local) return Promise.resolve(local);
    return fetch('https://api.zippopotam.us/us/' + zip)
      .then(function (res) {
        if (!res.ok) throw new Error('ZIP not found');
        return res.json();
      })
      .then(function (json) {
        var place = json.places && json.places[0];
        if (!place) throw new Error('ZIP not found');
        return {
          lat: parseFloat(place.latitude),
          lng: parseFloat(place.longitude),
          label: zip + (place['place name'] ? ' (' + place['place name'] + ', ' + place['state abbreviation'] + ')' : ''),
        };
      });
  }

  function applyFilters() {
    var rawQuery = (els.query.value || '').trim();
    var q = rawQuery.toLowerCase();
    var feature = els.filterFeature.value;
    var stateCode = els.filterState.value;
    var minRating = parseFloat(els.filterRating.value) || 0;
    var sortBy = els.sort.value;

    var items = state.all.filter(function (item) {
      if (stateCode && item.stateCode !== stateCode) return false;
      if (minRating && !(item.rating >= minRating)) return false;
      if (feature && (item.features || []).indexOf(feature) === -1) return false;
      if (q && !matchesQuery(item, q)) return false;
      return true;
    });

    items.forEach(function (item) {
      item._distance = state.origin
        ? distanceMiles(state.origin.lat, state.origin.lng, item.lat, item.lng)
        : null;
    });

    items.sort(function (a, b) {
      if (sortBy === 'distance' && state.origin) return a._distance - b._distance;
      if (sortBy === 'rating') return (b.rating || 0) - (a.rating || 0) || (b.reviews || 0) - (a.reviews || 0);
      if (sortBy === 'reviews') return (b.reviews || 0) - (a.reviews || 0);
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      // "Best match": distance if we have an origin, otherwise most-reviewed first.
      if (state.origin) return a._distance - b._distance;
      return (b.reviews || 0) - (a.reviews || 0);
    });

    state.filtered = items;
    state.shown = 0;
    renderResults(true);
  }

  function renderResults(reset) {
    var items = state.filtered;
    els.count.innerHTML = '<b>' + items.length.toLocaleString('en-US') + '</b> pumpkin patch' + (items.length === 1 ? '' : 'es');
    els.scope.textContent = state.origin ? 'nearest to ' + state.origin.label : 'across the United States';

    if (!items.length) {
      els.results.innerHTML = '<div class="empty-state" style="grid-column:1/-1">' +
        '<h3>No patches match those filters</h3>' +
        '<p>Try a different search term, clear a filter, or search a different ZIP code.</p>' +
        '<button class="btn btn-primary" type="button" id="find-empty-reset">Reset search</button>' +
        '</div>';
      els.moreBtn.hidden = true;
      var btn = document.getElementById('find-empty-reset');
      if (btn) btn.addEventListener('click', resetAll);
      return;
    }

    if (reset) els.results.innerHTML = '';
    var nextEnd = Math.min(state.shown + PAGE_SIZE, items.length);
    var html = '';
    for (var i = state.shown; i < nextEnd; i++) html += cardHtml(items[i]);
    els.results.insertAdjacentHTML('beforeend', html);
    state.shown = nextEnd;
    els.moreBtn.hidden = state.shown >= items.length;
  }

  function resetAll() {
    els.query.value = '';
    els.filterFeature.value = '';
    els.filterState.value = '';
    els.filterRating.value = '';
    els.sort.value = 'best';
    state.origin = null;
    applyFilters();
  }

  function runSearch(event) {
    if (event) event.preventDefault();
    var raw = (els.query.value || '').trim();
    if (/^\d{5}$/.test(raw)) {
      els.scope.textContent = 'Searching ' + raw + '…';
      lookupZip(raw)
        .then(function (origin) {
          state.origin = origin;
          if (els.sort.value === 'best') els.sort.value = 'distance';
          applyFilters();
        })
        .catch(function () {
          els.scope.textContent = 'We could not find ZIP ' + raw + '. Showing text matches instead.';
          applyFilters();
        });
      return;
    }
    state.origin = null;
    applyFilters();
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      els.scope.textContent = 'Location is not available in this browser';
      return;
    }
    els.scope.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'your location' };
        els.query.value = '';
        els.sort.value = 'distance';
        applyFilters();
      },
      function () {
        els.scope.textContent = 'Location permission denied — try searching a ZIP code instead';
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  /* ---------------------------------------------------------------- init */

  function populateFilters() {
    var statesSeen = {};
    var features = {};
    state.all.forEach(function (item) {
      if (item.stateCode && item.state) statesSeen[item.stateCode] = item.state;
      (item.features || []).forEach(function (f) { features[f] = (features[f] || 0) + 1; });
    });

    Object.keys(statesSeen).sort(function (a, b) { return statesSeen[a].localeCompare(statesSeen[b]); })
      .forEach(function (code) {
        var opt = document.createElement('option');
        opt.value = code;
        opt.textContent = statesSeen[code];
        els.filterState.appendChild(opt);
      });

    Object.keys(features).sort().forEach(function (f) {
      var opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      els.filterFeature.appendChild(opt);
    });
  }

  function bindEvents() {
    els.form.addEventListener('submit', runSearch);
    els.geo.addEventListener('click', useMyLocation);
    els.filterFeature.addEventListener('change', applyFilters);
    els.filterState.addEventListener('change', applyFilters);
    els.filterRating.addEventListener('change', applyFilters);
    els.sort.addEventListener('change', function () {
      // Picking distance-based sort with no origin yet is a no-op until a
      // ZIP or location is supplied, so nudge the visitor rather than fail silently.
      if (els.sort.value === 'distance' && !state.origin) {
        els.scope.textContent = 'Enter a ZIP code or use your location to sort by distance';
      }
      applyFilters();
    });
    els.reset.addEventListener('click', resetAll);
    els.moreBtn.addEventListener('click', function () { renderResults(false); });
  }

  fetch('/data/listings.json')
    .then(function (res) { return res.json(); })
    .then(function (payload) {
      state.all = (payload.listings || []).filter(function (i) {
        return typeof i.lat === 'number' && typeof i.lng === 'number';
      });
      populateFilters();
      bindEvents();

      var params = new URLSearchParams(window.location.search);
      var q = params.get('q');
      var zip = params.get('zip');
      if (zip && /^\d{5}$/.test(zip.trim())) {
        els.query.value = zip.trim();
        runSearch();
      } else if (q) {
        els.query.value = q;
        applyFilters();
      } else {
        applyFilters();
      }
    })
    .catch(function () {
      els.results.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><h3>Listings could not be loaded</h3>' +
        '<p>Refresh the page to try again, or <a href="/">browse the map</a>.</p></div>';
    });
})();
