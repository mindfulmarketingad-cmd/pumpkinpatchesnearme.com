/* =====================================================================
   List/Map toggle for state and city listicle pages. Scoped to exactly the
   farms on that page (embedded inline as JSON, no fetch), with a satellite
   toggle. Leaflet only initialises once a visitor actually opens the map.
   ===================================================================== */
(function () {
  'use strict';

  var mapEl = document.getElementById('page-map');
  var dataEl = document.getElementById('page-map-data');
  var toggleList = document.getElementById('page-view-list');
  var toggleMap = document.getElementById('page-view-map');
  var listView = document.getElementById('page-list-view');
  var mapView = document.getElementById('page-map-view');

  if (!mapEl || !dataEl || !toggleList || !toggleMap || !listView || !mapView) return;

  /* ---------------------------------------------------------- lazy Leaflet */
  // Leaflet is ~159KB of JS+CSS and most visitors to a state or city page
  // never open the map, so it is fetched on first use rather than shipped
  // with every page. Hovering the Map button starts the fetch early, which
  // usually means it has landed by the time the click registers.
  var LEAFLET_CSS = '/assets/vendor/leaflet/leaflet.css';
  var LEAFLET_JS = '/assets/vendor/leaflet/leaflet.js';
  var leafletPromise = null;

  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletPromise) return leafletPromise;

    leafletPromise = new Promise(function (resolve, reject) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);

      var script = document.createElement('script');
      script.src = LEAFLET_JS;
      script.async = true;
      script.onload = function () { resolve(); };
      script.onerror = function () {
        // Let a later click retry rather than latching the failure forever.
        leafletPromise = null;
        reject(new Error('Leaflet failed to load'));
      };
      document.head.appendChild(script);
    });
    return leafletPromise;
  }

  // Small lists are inlined in the page; big ones (the national hubs) live in
  // their own JSON file and are fetched with Leaflet on first open.
  var items = [];
  var itemsUrl = dataEl.getAttribute('data-src');
  if (!itemsUrl) {
    try {
      items = JSON.parse(dataEl.textContent) || [];
    } catch (e) {
      items = [];
    }
  }

  var itemsPromise = null;
  function loadItems() {
    if (!itemsUrl || items.length) return Promise.resolve();
    // Cache the in-flight request: hovering then clicking the Map button
    // would otherwise fetch the same file twice.
    if (itemsPromise) return itemsPromise;
    itemsPromise = fetch(itemsUrl)
      .then(function (res) { return res.json(); })
      .then(function (json) { items = json || []; })
      .catch(function (err) { itemsPromise = null; throw err; });
    return itemsPromise;
  }

  var map = null;
  var streetLayer = null;
  var satelliteLayer = null;

  var PLACEHOLDER_IMAGE = '/assets/img/patch-placeholder.svg';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function starString(rating) {
    var full = Math.round(rating);
    return new Array(full + 1).join('★') + new Array(Math.max(0, 5 - full) + 1).join('☆');
  }

  function resizedPhotoUrl(url, width, height) {
    if (!url || url.indexOf('googleusercontent.com') === -1) return url;
    return url.replace(/=w\d+-h\d+[^&]*$/, '=w' + width + '-h' + height + '-k-no');
  }

  function imgHtml(item) {
    var src = item.photo ? resizedPhotoUrl(item.photo, 240, 120) : PLACEHOLDER_IMAGE;
    return '<img class="map-popup-img" src="' + esc(src) + '" alt="' + esc(item.name) + '" width="240" height="120" loading="lazy" decoding="async" onerror="this.onerror=null;this.src=\'' + PLACEHOLDER_IMAGE + '\';">';
  }

  function popupHtml(item) {
    var place = [item.city, item.stateCode].filter(Boolean).join(', ');
    return '<div class="map-popup">' +
      imgHtml(item) +
      '<h4>' + esc(item.name) + '</h4>' +
      '<p>' + (item.rating ? '<span class="stars">' + starString(item.rating) + '</span> ' + item.rating.toFixed(1) + (item.reviews ? ' &middot; ' + item.reviews.toLocaleString('en-US') + ' reviews' : '') + ' &middot; ' : '') + esc(place) + '</p>' +
      '<a class="btn btn-primary btn-sm" href="' + esc(item.url) + '">View details</a>' +
    '</div>';
  }

  function initMap() {
    if (map) return;

    map = L.map(mapEl, {
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
      zoomControl: true,
    });

    streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    satelliteLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }
    );

    var bounds = [];
    items.forEach(function (item, index) {
      var delay = Math.min(index, 40) * 12;
      var marker = L.marker([item.lat, item.lng], {
        icon: L.divIcon({
          className: '',
          html: '<div class="patch-marker sprout" style="animation-delay:' + delay + 'ms"></div>',
          iconSize: [26, 26],
          iconAnchor: [13, 26],
          popupAnchor: [0, -24],
        }),
        title: item.name,
      }).addTo(map);
      marker.bindPopup(popupHtml(item));
      bounds.push([item.lat, item.lng]);
    });

    if (bounds.length === 1) map.setView(bounds[0], 13);
    else if (bounds.length) map.fitBounds(L.latLngBounds(bounds).pad(0.2), { maxZoom: 13 });
    else map.setView([39.5, -98.35], 4);

    var satBtn = document.getElementById('page-map-satellite');
    if (satBtn) {
      satBtn.addEventListener('click', function () {
        var on = satBtn.getAttribute('aria-pressed') === 'true';
        map.removeLayer(on ? satelliteLayer : streetLayer);
        map.addLayer(on ? streetLayer : satelliteLayer);
        satBtn.setAttribute('aria-pressed', String(!on));
        satBtn.textContent = on ? 'Satellite' : 'Street map';
      });
    }
  }

  function showList() {
    listView.hidden = false;
    mapView.hidden = true;
    toggleList.setAttribute('aria-pressed', 'true');
    toggleMap.setAttribute('aria-pressed', 'false');
  }

  function showMap() {
    listView.hidden = true;
    mapView.hidden = false;
    toggleList.setAttribute('aria-pressed', 'false');
    toggleMap.setAttribute('aria-pressed', 'true');

    Promise.all([loadLeaflet(), loadItems()]).then(function () {
      initMap();
      window.setTimeout(function () {
        if (map) map.invalidateSize();
      }, 60);
    }).catch(function () {
      // Nothing to show without Leaflet — go back to the list, which is the
      // same farms in the same order, rather than leaving an empty panel.
      showList();
      toggleMap.textContent = 'Map unavailable';
      window.setTimeout(function () { toggleMap.textContent = 'Map'; }, 4000);
    });
  }

  toggleList.addEventListener('click', showList);
  toggleMap.addEventListener('click', showMap);
  // Warm the fetch on intent, so the click itself feels instant.
  toggleMap.addEventListener('pointerenter', function () {
    loadLeaflet().catch(function () {});
    loadItems().catch(function () {});
  }, { once: true });

  // Deep link: /nebraska/?view=map opens straight to the map.
  if (/[?&]view=map\b/.test(window.location.search)) showMap();
})();
