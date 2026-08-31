/* =====================================================================
   Homepage search: ZIP/geolocation search, filters and sort over the full
   directory, feeding the results carousel and the "near me" carousels
   below a single static hero photo (no interactive map on this page —
   state/city/category pages have their own separate List/Map toggle).
   ===================================================================== */
(function () {
  'use strict';

  var els = {
    list: document.getElementById('results-list'),
    overflowNote: document.getElementById('results-overflow-note'),
    count: document.getElementById('results-count'),
    scope: document.getElementById('results-scope'),
    form: document.getElementById('zip-form'),
    zip: document.getElementById('zip-input'),
    geo: document.getElementById('geo-btn'),
    filterFeature: document.getElementById('filter-feature'),
    filterState: document.getElementById('filter-state'),
    filterRating: document.getElementById('filter-rating'),
    sort: document.getElementById('sort-select'),
    reset: document.getElementById('reset-btn'),
  };

  if (!els.list || !els.form) return;

  var MAX_CARDS = 60;
  var state = {
    all: [],
    filtered: [],
    origin: null,       // { lat, lng, label }
  };

  /* ------------------------------------------------------------- helpers */

  var PLACEHOLDER_IMAGE = '/assets/img/patch-placeholder.svg';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Google's photo CDN takes the pixel size straight in the URL
  // (=w800-h500-k-no) — request only what the rendered element needs
  // instead of downloading the full-size source for a small card or popup.
  function resizedPhotoUrl(url, width, height) {
    if (!url || url.indexOf('googleusercontent.com') === -1) return url;
    return url.replace(/=w\d+-h\d+[^&]*$/, '=w' + width + '-h' + height + '-k-no');
  }

  function imgHtml(item, className, width, height) {
    var src = item.photo ? resizedPhotoUrl(item.photo, width, height) : PLACEHOLDER_IMAGE;
    return '<img class="' + className + '" src="' + esc(src) + '" alt="' + esc(item.name) + '" width="' + width + '" height="' + height + '" loading="lazy" decoding="async" onerror="this.onerror=null;this.src=\'' + PLACEHOLDER_IMAGE + '\';">';
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

  /* --------------------------------------------------------- hours parsing */
  // "Open Now" has to be computed live in the browser — build time and view
  // time are different moments, so there's no way to bake "open right now"
  // into the server-rendered page. Source strings look like "10AM-6PM",
  // "12-6PM" (start infers the end's AM/PM), "3:30-6:30PM", multi-segment
  // ("7-10AM / 5-7PM"), "Open 24 hours" or "Closed" — verified against all
  // 227 distinct hour strings actually in the data before shipping this.
  function parseTimeToken(token, fallbackMeridiem) {
    var m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(token.trim());
    if (!m) return null;
    var hour = parseInt(m[1], 10) % 12;
    var min = m[2] ? parseInt(m[2], 10) : 0;
    var meridiem = (m[3] || fallbackMeridiem || '').toUpperCase();
    if (meridiem === 'PM') hour += 12;
    return hour * 60 + min;
  }

  function parseHoursRange(range) {
    var parts = range.split('-');
    if (parts.length !== 2) return null;
    var endMatch = /(AM|PM)/i.exec(parts[1]);
    var endMeridiem = endMatch ? endMatch[1].toUpperCase() : null;
    var start = parseTimeToken(parts[0], endMeridiem);
    var end = parseTimeToken(parts[1], endMeridiem);
    if (start == null || end == null) return null;
    if (end < start) end += 24 * 60; // overnight range, e.g. "12-9AM" spanning midnight
    return [start, end];
  }

  var HOURS_DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  // Compared against the visitor's own device clock, not the farm's time
  // zone — an approximation (same one the listing detail page's "Open
  // today" badge already makes), fine for the vast majority of same-region
  // browsing this carousel is built for.
  function isOpenNow(hours) {
    if (!hours) return false;
    var now = new Date();
    var text = hours[HOURS_DAY_KEYS[now.getDay()]];
    if (!text || /closed/i.test(text)) return false;
    if (/24\s*hours/i.test(text)) return true;
    var nowMinutes = now.getHours() * 60 + now.getMinutes();
    return text.split('/').some(function (range) {
      var r = parseHoursRange(range);
      if (!r) return false;
      if (r[1] > 24 * 60) return nowMinutes >= r[0] || nowMinutes <= (r[1] - 24 * 60);
      return nowMinutes >= r[0] && nowMinutes <= r[1];
    });
  }

  /* ------------------------------------------------------------ rendering */

  function cardHtml(item) {
    var place = [item.city, item.stateCode].filter(Boolean).join(', ');
    var tags = (item.features || []).slice(0, 3);
    return '<article class="listing-card" data-slug="' + esc(item.slug) + '">' +
      '<a class="listing-card-media" href="' + esc(item.url) + '" tabindex="-1" aria-hidden="true">' + imgHtml(item, 'listing-card-img', 480, 300) + '</a>' +
      '<div class="listing-card-body">' +
        '<h3><a href="' + esc(item.url) + '">' + esc(item.name) + '</a></h3>' +
        '<div class="listing-meta">' +
          (item.rating ? '<span class="rating"><span class="stars" aria-hidden="true">' + starString(item.rating) + '</span> ' + item.rating.toFixed(1) + '</span>' : '') +
          (item.reviews ? '<span>' + item.reviews.toLocaleString('en-US') + ' reviews</span>' : '') +
          (place ? '<span>' + esc(place) + '</span>' : '') +
          (item.sample ? '<span class="tag">Sample data</span>' : '') +
        '</div>' +
        (item.street ? '<p class="listing-address">' + esc(item.street) + (item.postalCode ? ', ' + esc(item.postalCode) : '') + '</p>' : '') +
        (item._distance != null ? '<p><span class="listing-distance">' + item._distance.toFixed(1) + ' mi away</span></p>' : '') +
        (tags.length ? '<div class="tag-row">' + tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>' : '') +
        '<div class="card-actions">' +
          '<a class="btn btn-primary btn-sm" href="' + esc(item.url) + '">View details</a>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function renderList() {
    var items = state.filtered;
    els.count.innerHTML = '<b>' + items.length.toLocaleString('en-US') + '</b> pumpkin patch' + (items.length === 1 ? '' : 'es');
    els.scope.textContent = state.origin
      ? 'nearest to ' + state.origin.label
      : 'across the United States';

    if (!items.length) {
      els.list.innerHTML = '<div class="empty-state">' +
        '<h3>No patches match those filters</h3>' +
        '<p>Try widening your search — clear a filter or search a different ZIP code.</p>' +
        '<button class="btn btn-primary" type="button" id="empty-reset">Reset search</button>' +
        '</div>';
      var btn = document.getElementById('empty-reset');
      if (btn) btn.addEventListener('click', resetAll);
      return;
    }

    var shown = items.slice(0, MAX_CARDS);
    els.list.innerHTML = shown.map(cardHtml).join('');
    // Kept outside the carousel track (its own paragraph below the row)
    // rather than appended inline, so it doesn't become an odd-shaped flex
    // item in the horizontally scrolling carousel.
    if (els.overflowNote) {
      if (items.length > shown.length) {
        els.overflowNote.hidden = false;
        els.overflowNote.textContent = 'Showing the closest ' + shown.length + ' of ' + items.length.toLocaleString('en-US') +
          ' results. Search a ZIP code to narrow it down.';
      } else {
        els.overflowNote.hidden = true;
      }
    }
  }

  /* ------------------------------------------------------------ filtering */

  function applyFilters() {
    var feature = els.filterFeature.value;
    var stateCode = els.filterState.value;
    var minRating = parseFloat(els.filterRating.value) || 0;
    var sortBy = els.sort.value;

    var items = state.all.filter(function (item) {
      if (stateCode && item.stateCode !== stateCode) return false;
      if (minRating && !(item.rating >= minRating)) return false;
      if (feature && (item.features || []).indexOf(feature) === -1) return false;
      return true;
    });

    items.forEach(function (item) {
      item._distance = state.origin
        ? distanceMiles(state.origin.lat, state.origin.lng, item.lat, item.lng)
        : null;
    });

    items.sort(function (a, b) {
      if (sortBy === 'rating') return (b.rating || 0) - (a.rating || 0) || (b.reviews || 0) - (a.reviews || 0);
      if (sortBy === 'reviews') return (b.reviews || 0) - (a.reviews || 0);
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      // Default: distance when we have an origin, otherwise most-reviewed first.
      if (state.origin) return a._distance - b._distance;
      return (b.reviews || 0) - (a.reviews || 0);
    });

    state.filtered = items;
    renderList();
  }

  function resetAll() {
    els.filterFeature.value = '';
    els.filterState.value = '';
    els.filterRating.value = '';
    els.sort.value = 'distance';
    els.zip.value = '';
    state.origin = null;
    applyFilters();
    renderNearbyCarousels();
  }

  /* ---------------------------------------------------- "near me" carousels */
  // One homepage carousel per real attraction category, plus Farms and
  // Pumpkin Patches (no feature separates those two — same underlying
  // dataset as the /farms/ and /pumpkin-patches/ pages, just framed two
  // ways). Every one is server-rendered with the top-rated listings
  // nationwide by default (real content on first load, no JS required).
  // Once a visitor's location is known — auto-locate on load, ZIP search
  // or "Use my location" — every one switches to a real distance-sorted
  // set for that location instead, nearest first, and reverts to the
  // default set on reset. Keys and hrefs must match the section ids and
  // links build.mjs renders for {{NEARBY_CAROUSELS}} — see
  // homepageNearbySections there.
  var NEARBY_SECTIONS = [
    { key: 'nearby-corn-mazes', feature: 'Corn maze', label: 'Corn Mazes', href: '/corn-mazes/' },
    { key: 'nearby-u-pick-pumpkin-patches', feature: 'U-pick pumpkins', label: 'U-Pick Pumpkin Patches', href: '/u-pick-pumpkin-patches/' },
    { key: 'nearby-hayrides', feature: 'Hayrides', label: 'Hayrides', href: '/hayrides/' },
    { key: 'nearby-haunted-attractions', feature: 'Haunted attraction', label: 'Haunted Attractions', href: '/haunted-attractions/' },
    { key: 'nearby-petting-zoos', feature: 'Petting zoo', label: 'Petting Zoos and Farm Animals', href: '/petting-zoos/' },
    { key: 'nearby-apple-picking', feature: 'Apple picking', label: 'Apple Picking', href: '/apple-picking/' },
    { key: 'nearby-sunflower-fields', feature: 'Sunflower field', label: 'Sunflower Fields', href: '/sunflower-fields/' },
    { key: 'nearby-fall-festivals', feature: 'Fall festival', label: 'Fall Festivals', href: '/fall-festivals/' },
    { key: 'nearby-farms', feature: null, label: 'Farms', href: '/farms/' },
    { key: 'nearby-pumpkin-patches', feature: null, label: 'Pumpkin Patches', href: '/pumpkin-patches/' },
  ];
  var nearbyDefaultHtml = {};

  function renderNearbySection(section) {
    var track = document.getElementById(section.key);
    var heading = document.getElementById(section.key + '-heading');
    var sub = document.getElementById(section.key + '-sub');
    if (!track) return;

    if (!state.origin) {
      if (nearbyDefaultHtml[section.key] != null) track.innerHTML = nearbyDefaultHtml[section.key];
      if (heading) heading.textContent = section.label + ' Near Me';
      if (sub) sub.textContent = 'Top-rated ' + section.label.toLowerCase() + ' in our directory right now.';
      return;
    }

    var pool = section.feature
      ? state.all.filter(function (item) { return (item.features || []).indexOf(section.feature) !== -1; })
      : state.all;
    var nearby = pool
      .map(function (item) {
        return { item: item, dist: distanceMiles(state.origin.lat, state.origin.lng, item.lat, item.lng) };
      })
      .sort(function (a, b) { return a.dist - b.dist; })
      .slice(0, 16);

    var locationLabel = state.origin.label === 'your location' ? 'you' : state.origin.label;

    if (!nearby.length) {
      track.innerHTML = '<p class="carousel-empty">No ' + esc(section.label.toLowerCase()) + ' tracked near ' + esc(locationLabel) +
        ' yet &mdash; <a href="' + section.href + '">browse all ' + esc(section.label.toLowerCase()) + '</a>.</p>';
      if (heading) heading.textContent = section.label + ' Near Me';
      if (sub) sub.textContent = 'None found close to ' + locationLabel + ' yet.';
      return;
    }

    track.innerHTML = nearby.map(function (x) { x.item._distance = x.dist; return cardHtml(x.item); }).join('');
    if (heading) heading.textContent = section.label + ' Near ' + (locationLabel === 'you' ? 'You' : locationLabel);
    if (sub) sub.textContent = 'The ' + nearby.length + ' closest to ' + locationLabel + ', nearest first.';
  }

  // "Top Rated" behaves like the category carousels once location is known,
  // except it re-ranks by rating within a nearby pool instead of pure
  // distance — "the best options within driving distance," not just
  // "whichever happens to be closest."
  function renderTopRatedSection() {
    var track = document.getElementById('nearby-top-rated');
    var heading = document.getElementById('nearby-top-rated-heading');
    var sub = document.getElementById('nearby-top-rated-sub');
    if (!track) return;

    if (!state.origin) {
      if (nearbyDefaultHtml['nearby-top-rated'] != null) track.innerHTML = nearbyDefaultHtml['nearby-top-rated'];
      if (heading) heading.textContent = 'Top Rated';
      if (sub) sub.textContent = 'The strongest review profiles in our directory right now.';
      return;
    }

    var locationLabel = state.origin.label === 'your location' ? 'you' : state.origin.label;
    var nearby = state.all
      .map(function (item) {
        return { item: item, dist: distanceMiles(state.origin.lat, state.origin.lng, item.lat, item.lng) };
      })
      .sort(function (a, b) { return a.dist - b.dist; })
      .slice(0, 40)
      .sort(function (a, b) {
        return (b.item.rating || 0) * Math.log10((b.item.reviews || 1) + 1) - (a.item.rating || 0) * Math.log10((a.item.reviews || 1) + 1);
      })
      .slice(0, 12);

    if (!nearby.length) {
      track.innerHTML = '<p class="carousel-empty">Nothing tracked near ' + esc(locationLabel) + ' yet &mdash; <a href="/pumpkin-patches/">browse all pumpkin patches</a>.</p>';
      if (heading) heading.textContent = 'Top Rated';
      if (sub) sub.textContent = 'None found close to ' + locationLabel + ' yet.';
      return;
    }

    track.innerHTML = nearby.map(function (x) { x.item._distance = x.dist; return cardHtml(x.item); }).join('');
    if (heading) heading.textContent = 'Top Rated';
    if (sub) sub.textContent = 'The strongest review profiles within driving distance of ' + locationLabel + '.';
  }

  // "Open Now" has no default HTML to revert to (see the build.mjs
  // comment) — it always computes fresh from state.all + the current
  // moment, ranked by distance once location is known, by rating before
  // that.
  function renderOpenNowSection() {
    var track = document.getElementById('nearby-open-now');
    var heading = document.getElementById('nearby-open-now-heading');
    var sub = document.getElementById('nearby-open-now-sub');
    if (!track) return;

    var openItems = state.all.filter(function (item) { return isOpenNow(item.hours); });
    var locationLabel = state.origin ? (state.origin.label === 'your location' ? 'you' : state.origin.label) : null;

    var ranked;
    if (state.origin) {
      ranked = openItems
        .map(function (item) { return { item: item, dist: distanceMiles(state.origin.lat, state.origin.lng, item.lat, item.lng) }; })
        .sort(function (a, b) { return a.dist - b.dist; });
    } else {
      ranked = openItems
        .map(function (item) { return { item: item, dist: null }; })
        .sort(function (a, b) {
          return (b.item.rating || 0) * Math.log10((b.item.reviews || 1) + 1) - (a.item.rating || 0) * Math.log10((a.item.reviews || 1) + 1);
        });
    }
    var nearby = ranked.slice(0, 16);

    if (!nearby.length) {
      track.innerHTML = '<p class="carousel-empty">Nothing in our directory shows open hours right now' +
        (locationLabel ? ' near ' + esc(locationLabel) : '') +
        ' &mdash; <a href="/pumpkin-patches/">browse all pumpkin patches</a> and call ahead.</p>';
    } else {
      track.innerHTML = nearby.map(function (x) {
        if (x.dist != null) { x.item._distance = x.dist; } else { delete x.item._distance; }
        return cardHtml(x.item);
      }).join('');
    }
    if (heading) heading.textContent = 'Open Now';
    if (sub) {
      sub.textContent = locationLabel
        ? 'Farms near ' + locationLabel + ' showing open hours right now.'
        : 'Farms showing open hours right now, based on your device clock.';
    }
  }

  function renderNearbyCarousels() {
    NEARBY_SECTIONS.forEach(renderNearbySection);
    renderTopRatedSection();
    renderOpenNowSection();
  }

  function bindCarouselArrows() {
    document.addEventListener('click', function (event) {
      var btn = event.target.closest('.carousel-arrow');
      if (!btn) return;
      var track = document.getElementById(btn.getAttribute('data-target'));
      if (!track) return;
      var amount = Math.round(track.clientWidth * 0.85);
      track.scrollBy({ left: btn.getAttribute('data-dir') === 'prev' ? -amount : amount, behavior: 'smooth' });
    });
  }

  /* --------------------------------------------------------- ZIP lookup */

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

  function searchZip(event) {
    if (event) event.preventDefault();
    var zip = (els.zip.value || '').trim();
    if (!/^\d{5}$/.test(zip)) {
      els.scope.textContent = 'Enter a 5-digit US ZIP code';
      return;
    }
    els.scope.textContent = 'Searching ' + zip + '…';
    lookupZip(zip)
      .then(function (origin) {
        state.origin = origin;
        els.sort.value = 'distance';
        applyFilters();
        renderNearbyCarousels();
      })
      .catch(function () {
        els.scope.textContent = 'We could not find ZIP ' + zip + '. Try another ZIP code.';
      });
  }

  // Shared by the manual "Use my location" button and the silent auto-locate
  // on page load: sets the origin and re-sorts/re-renders the list and
  // carousels (nearest first).
  function applyOrigin(pos, label) {
    state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: label };
    els.sort.value = 'distance';
    applyFilters();
    renderNearbyCarousels();
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      els.scope.textContent = 'Location is not available in this browser';
      return;
    }
    els.scope.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        els.zip.value = '';
        applyOrigin(pos, 'your location');
      },
      function () {
        els.scope.textContent = 'Location permission denied — search by ZIP code instead';
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  // Auto-locate on page load: same request as clicking "Use my location,"
  // just fired automatically so a first-time visitor sees the #1 nearest
  // patch first without an extra click. Silent on denial/unavailability —
  // the nationwide default view already showing (rendered before this
  // resolves) is exactly the right fallback, so there's nothing to say and
  // nothing to undo.
  function autoLocate() {
    if (!navigator.geolocation) return;
    els.scope.textContent = 'Finding pumpkin patches near you…';
    navigator.geolocation.getCurrentPosition(
      function (pos) { applyOrigin(pos, 'your location'); },
      function () { els.scope.textContent = 'across the United States'; },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  /* ---------------------------------------------------------------- init */

  function populateFilters() {
    var states = {};
    var features = {};
    state.all.forEach(function (item) {
      if (item.stateCode && item.state) states[item.stateCode] = item.state;
      (item.features || []).forEach(function (f) { features[f] = (features[f] || 0) + 1; });
    });

    Object.keys(states).sort(function (a, b) { return states[a].localeCompare(states[b]); })
      .forEach(function (code) {
        var opt = document.createElement('option');
        opt.value = code;
        opt.textContent = states[code];
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
    els.form.addEventListener('submit', searchZip);
    els.geo.addEventListener('click', useMyLocation);
    els.filterFeature.addEventListener('change', applyFilters);
    els.filterState.addEventListener('change', applyFilters);
    els.filterRating.addEventListener('change', applyFilters);
    els.sort.addEventListener('change', applyFilters);
    els.reset.addEventListener('click', resetAll);
  }

  /* --------------------------------------------------- location banner -- */
  // A passive "pumpkin patches near you" suggestion — never a forced
  // redirect, and never a cold geolocation prompt. It only ever appears for
  // a visitor whose browser already has geolocation permission granted
  // from an earlier visit (e.g. they used "Use my location" before), which
  // the Permissions API lets us check without triggering a new prompt.
  var LOCATION_BANNER_MAX_MILES = 75;
  var LOCATION_BANNER_DISMISS_KEY = 'ppnm-location-banner-dismissed';

  function slugify(value) {
    return String(value == null ? '' : value)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90);
  }

  function maybeShowLocationBanner() {
    var banner = document.getElementById('location-banner');
    if (!banner) return;
    if (window.sessionStorage && window.sessionStorage.getItem(LOCATION_BANNER_DISMISS_KEY)) return;
    if (!navigator.permissions || !navigator.permissions.query) return;

    navigator.permissions.query({ name: 'geolocation' }).then(function (status) {
      if (status.state !== 'granted') return;
      navigator.geolocation.getCurrentPosition(function (pos) {
        var nearest = null;
        var nearestDist = Infinity;
        state.all.forEach(function (item) {
          if (!item.city || !item.state) return;
          var d = distanceMiles(pos.coords.latitude, pos.coords.longitude, item.lat, item.lng);
          if (d < nearestDist) { nearestDist = d; nearest = item; }
        });
        if (!nearest || nearestDist > LOCATION_BANNER_MAX_MILES) return;

        var url = '/' + slugify(nearest.state) + '/' + slugify(nearest.city) + '/';
        var label = nearest.city + ', ' + (nearest.stateCode || nearest.state);
        document.getElementById('location-banner-text').textContent = 'Pumpkin patches near ' + label;
        var link = document.getElementById('location-banner-link');
        link.href = url;
        link.textContent = 'See patches in ' + nearest.city;
        banner.hidden = false;
      }, function () { /* permission was granted but the lookup itself failed — say nothing */ }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 });
    }).catch(function () {});
  }

  var locationBannerClose = document.getElementById('location-banner-close');
  if (locationBannerClose) {
    locationBannerClose.addEventListener('click', function () {
      document.getElementById('location-banner').hidden = true;
      if (window.sessionStorage) window.sessionStorage.setItem(LOCATION_BANNER_DISMISS_KEY, '1');
    });
  }

  fetch('/data/listings.json')
    .then(function (res) { return res.json(); })
    .then(function (payload) {
      state.all = (payload.listings || []).filter(function (i) {
        return typeof i.lat === 'number' && typeof i.lng === 'number';
      });
      NEARBY_SECTIONS.concat([{ key: 'nearby-top-rated' }]).forEach(function (section) {
        var trackEl = document.getElementById(section.key);
        if (trackEl) nearbyDefaultHtml[section.key] = trackEl.innerHTML;
      });
      populateFilters();
      bindEvents();
      bindCarouselArrows();
      maybeShowLocationBanner();
      // Unlike every other carousel, "Open Now" has no valid server-rendered
      // default to fall back on (open/closed is only true at this exact
      // moment) — compute it immediately so it doesn't sit on "Checking…"
      // for visitors who deny location or whose geolocation never resolves.
      renderOpenNowSection();

      // Deep link: /?zip=90210 runs the search on load. That's an explicit,
      // shareable location — it wins over auto-locating the visitor's own
      // position, so auto-locate only fires when there's no zip param.
      var params = new URLSearchParams(window.location.search);
      var zipParam = params.get('zip');
      if (zipParam && /^\d{5}$/.test(zipParam.trim())) {
        els.zip.value = zipParam.trim();
        applyFilters();
        searchZip();
      } else {
        applyFilters();
        autoLocate();
      }
    })
    .catch(function () {
      els.list.innerHTML = '<div class="empty-state"><h3>Listings could not be loaded</h3>' +
        '<p>Refresh the page to try again, or <a href="/states/">browse pumpkin patches by state</a>.</p></div>';
    });
})();
