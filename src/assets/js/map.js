/* =====================================================================
   Homepage search map: Leaflet with individual (unclustered) pumpkin pins,
   ZIP search, filters, sort, list/map toggle and satellite basemap toggle.
   Zoom is restricted to the +/- controls — no scroll-wheel, double-click or
   pinch zoom — so the page scrolls normally over the map.
   ===================================================================== */
(function () {
  'use strict';

  var els = {
    app: document.getElementById('search-app'),
    map: document.getElementById('map'),
    list: document.getElementById('results-list'),
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
    satellite: document.getElementById('satellite-toggle'),
    viewList: document.getElementById('view-list'),
    viewMap: document.getElementById('view-map'),
  };

  if (!els.map || typeof L === 'undefined') return;

  var MAX_CARDS = 60;
  var state = {
    all: [],
    filtered: [],
    origin: null,       // { lat, lng, label }
    activeSlug: null,
    markers: {},
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

  /* ---------------------------------------------------------------- map */

  var map = L.map('map', {
    center: [39.5, -98.35],
    zoom: 4,
    minZoom: 3,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
    zoomControl: true,
  });

  var streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  var satelliteLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 19,
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    }
  );

  // Plain layer group — every listing gets its own pumpkin pin, never a
  // clustered number bubble, even zoomed out to the whole country.
  var markerLayer = L.layerGroup().addTo(map);

  var originMarker = null;

  // Markers sprout up from their anchor point when they first appear, with a
  // small stagger so a page full of pins doesn't pop in as one flat flash.
  // The stagger is capped so it stays quick even with thousands of markers.
  var sproutCounter = 0;
  function markerIcon(active) {
    var delay = Math.min(sproutCounter++ % 40, 40) * 12;
    return L.divIcon({
      className: '',
      html: '<div class="patch-marker sprout' + (active ? ' is-active' : '') + '" style="animation-delay:' + delay + 'ms"></div>',
      iconSize: [26, 26],
      iconAnchor: [13, 26],
      popupAnchor: [0, -24],
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
          '<button class="btn btn-outline btn-sm" type="button" data-focus="' + esc(item.slug) + '">Show on map</button>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function popupHtml(item) {
    var place = [item.city, item.stateCode].filter(Boolean).join(', ');
    return '<div class="map-popup">' +
      imgHtml(item, 'map-popup-img', 240, 120) +
      '<h4>' + esc(item.name) + '</h4>' +
      '<p>' + (item.rating ? '<span class="stars">' + starString(item.rating) + '</span> ' + item.rating.toFixed(1) + ' &middot; ' : '') + esc(place) + '</p>' +
      '<a class="btn btn-primary btn-sm" href="' + esc(item.url) + '">View details</a>' +
    '</div>';
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
    var html = shown.map(cardHtml).join('');
    if (items.length > shown.length) {
      html += '<p style="text-align:center;color:var(--muted);font-size:0.9rem">' +
        'Showing the closest ' + shown.length + ' of ' + items.length.toLocaleString('en-US') +
        ' results. Zoom the map or search a ZIP code to narrow it down.</p>';
    }
    els.list.innerHTML = html;
  }

  function renderMarkers() {
    markerLayer.clearLayers();
    state.markers = {};
    var bounds = [];

    state.filtered.forEach(function (item) {
      var marker = L.marker([item.lat, item.lng], {
        icon: markerIcon(false),
        title: item.name,
      });
      marker.bindPopup(popupHtml(item));
      marker.on('click', function () { setActive(item.slug, false); });
      state.markers[item.slug] = marker;
      markerLayer.addLayer(marker);
      bounds.push([item.lat, item.lng]);
    });

    if (state.origin) {
      if (originMarker) map.removeLayer(originMarker);
      originMarker = L.circleMarker([state.origin.lat, state.origin.lng], {
        radius: 8,
        color: '#c74a0f',
        weight: 3,
        fillColor: '#fff',
        fillOpacity: 1,
      }).addTo(map).bindPopup('Searching from ' + esc(state.origin.label));
      // Frame the origin plus the ten nearest results (the list is distance-sorted).
      bounds = [[state.origin.lat, state.origin.lng]].concat(bounds.slice(0, 10));
    }

    // Only reframe when the visitor has narrowed things down. Fitting every
    // listing on first load would zoom out past Alaska and Hawaii.
    var narrowed = state.origin || els.filterState.value || els.filterFeature.value || els.filterRating.value;
    if (bounds.length && narrowed) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.15), { maxZoom: state.origin ? 11 : 10 });
    }
  }

  function setActive(slug, pan) {
    state.activeSlug = slug;
    Array.prototype.forEach.call(els.list.querySelectorAll('.listing-card'), function (card) {
      card.classList.toggle('is-active', card.getAttribute('data-slug') === slug);
      if (card.getAttribute('data-slug') === slug) {
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
    var marker = state.markers[slug];
    if (marker) {
      if (pan) {
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 12));
        marker.openPopup();
      }
      if (els.app.getAttribute('data-view') === 'list' && window.innerWidth <= 900) {
        setView('map');
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
    renderMarkers();
  }

  function resetAll() {
    els.filterFeature.value = '';
    els.filterState.value = '';
    els.filterRating.value = '';
    els.sort.value = 'distance';
    els.zip.value = '';
    state.origin = null;
    if (originMarker) { map.removeLayer(originMarker); originMarker = null; }
    applyFilters();
    renderNearbyCarousels();
    map.setView([39.5, -98.35], 4);
  }

  /* ---------------------------------------------------- "near me" carousels */
  // Four homepage carousels (Corn Mazes, Hayrides, Farms, Pumpkin Patches),
  // each server-rendered with the top-rated listings nationwide by default
  // (real content on first load, no JS required). Once a visitor's location
  // is known — auto-locate on load, ZIP search or "Use my location" — every
  // one switches to a real distance-sorted set for that location instead,
  // nearest first, and reverts to the default set on reset. Farms and
  // Pumpkin Patches cover the same underlying data (no feature separates
  // them, same as the /farms/ and /pumpkin-patches/ pages) — different
  // framing of one real dataset, not two different result sets.
  var NEARBY_SECTIONS = [
    { key: 'nearby-corn-mazes', feature: 'Corn maze', label: 'Corn Mazes', href: '/corn-mazes/' },
    { key: 'nearby-hayrides', feature: 'Hayrides', label: 'Hayrides', href: '/hayrides/' },
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

  function renderNearbyCarousels() {
    NEARBY_SECTIONS.forEach(renderNearbySection);
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
  // on page load: sets the origin, re-sorts/re-renders the list (nearest
  // first), and re-frames the map on it (renderMarkers already fitBounds
  // to the origin plus its ten nearest results whenever state.origin is set).
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
  // just fired automatically so a first-time visitor sees the map zoomed to
  // their area and the #1 nearest patch first without an extra click. Silent
  // on denial/unavailability — the nationwide default view already showing
  // (rendered before this resolves) is exactly the right fallback, so
  // there's nothing to say and nothing to undo.
  function autoLocate() {
    if (!navigator.geolocation) return;
    els.scope.textContent = 'Finding pumpkin patches near you…';
    navigator.geolocation.getCurrentPosition(
      function (pos) { applyOrigin(pos, 'your location'); },
      function () { els.scope.textContent = 'across the United States'; },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  /* ------------------------------------------------------------- toggles */

  function setView(view) {
    els.app.setAttribute('data-view', view);
    els.viewList.setAttribute('aria-pressed', String(view === 'list'));
    els.viewMap.setAttribute('aria-pressed', String(view === 'map'));
    if (view === 'map') window.setTimeout(function () { map.invalidateSize(); }, 60);
  }

  function toggleSatellite() {
    var on = els.satellite.getAttribute('aria-pressed') === 'true';
    if (on) {
      map.removeLayer(satelliteLayer);
      map.addLayer(streetLayer);
      els.satellite.setAttribute('aria-pressed', 'false');
      els.satellite.textContent = 'Satellite';
    } else {
      map.removeLayer(streetLayer);
      map.addLayer(satelliteLayer);
      els.satellite.setAttribute('aria-pressed', 'true');
      els.satellite.textContent = 'Street map';
    }
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
    els.satellite.addEventListener('click', toggleSatellite);
    els.viewList.addEventListener('click', function () { setView('list'); });
    els.viewMap.addEventListener('click', function () { setView('map'); });

    els.list.addEventListener('click', function (event) {
      var trigger = event.target.closest('[data-focus]');
      if (trigger) {
        setActive(trigger.getAttribute('data-focus'), true);
        return;
      }
      var card = event.target.closest('.listing-card');
      if (card && !event.target.closest('a')) setActive(card.getAttribute('data-slug'), true);
    });
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
      NEARBY_SECTIONS.forEach(function (section) {
        var trackEl = document.getElementById(section.key);
        if (trackEl) nearbyDefaultHtml[section.key] = trackEl.innerHTML;
      });
      populateFilters();
      bindEvents();
      bindCarouselArrows();
      maybeShowLocationBanner();

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
