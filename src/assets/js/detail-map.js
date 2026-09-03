/* Single-location map used on listing detail pages, with a satellite toggle. */
(function () {
  'use strict';

  var el = document.getElementById('detail-map');
  if (!el) return;

  var lat = parseFloat(el.getAttribute('data-lat'));
  var lng = parseFloat(el.getAttribute('data-lng'));
  if (!isFinite(lat) || !isFinite(lng)) return;

  /* ---------------------------------------------------------- lazy Leaflet */
  // The map sits well below the fold on a 1,000+ word listing page, so its
  // ~159KB of JS+CSS is fetched as it approaches the viewport rather than on
  // page load. Readers who never scroll that far never pay for it.
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
      script.onerror = function () { leafletPromise = null; reject(new Error('Leaflet failed to load')); };
      document.head.appendChild(script);
    });
    return leafletPromise;
  }

  function initMap() {
  var map = L.map(el, {
    center: [lat, lng],
    zoom: 13,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
  });

  var street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  var satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }
  );

  L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: '<div class="patch-marker sprout"></div>',
      iconSize: [26, 26],
      iconAnchor: [13, 26],
    }),
  })
    .addTo(map)
    .bindPopup(el.getAttribute('data-name') || 'Pumpkin patch');

  L.Control.Satellite = L.Control.extend({
    onAdd: function () {
      var button = L.DomUtil.create('button', 'toggle-btn');
      button.type = 'button';
      button.textContent = 'Satellite';
      button.setAttribute('aria-pressed', 'false');
      L.DomEvent.disableClickPropagation(button);
      L.DomEvent.on(button, 'click', function () {
        var on = button.getAttribute('aria-pressed') === 'true';
        map.removeLayer(on ? satellite : street);
        map.addLayer(on ? street : satellite);
        button.setAttribute('aria-pressed', String(!on));
        button.textContent = on ? 'Satellite' : 'Street map';
      });
      return button;
    },
  });
  new L.Control.Satellite({ position: 'topright' }).addTo(map);

  // Leaflet sizes its internal tile grid from the container's dimensions
  // at the moment L.map() runs. This page's fonts load async (see
  // base.html) and swap in after first paint, which can reflow the aside
  // column's width after the map has already measured it — leaving
  // Leaflet's tiles sized for a stale width and overflowing the page.
  // invalidateSize() re-measures and corrects it without a full reinit.
  window.setTimeout(function () { map.invalidateSize(); }, 250);
  }

  var started = false;
  function start() {
    if (started) return;
    started = true;
    loadLeaflet().then(initMap).catch(function () {
      // Leave the container empty rather than half-initialised; the address
      // and the Google Maps directions link above it still work.
    });
  }

  // rootMargin gives the fetch a head start so the map is usually ready by
  // the time it scrolls into view. Without IntersectionObserver, just load.
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) {
        observer.disconnect();
        start();
      }
    }, { rootMargin: '400px' });
    observer.observe(el);
  } else {
    start();
  }
})();
