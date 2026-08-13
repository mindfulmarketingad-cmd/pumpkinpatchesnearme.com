/* Single-location map used on listing detail pages, with a satellite toggle. */
(function () {
  'use strict';

  var el = document.getElementById('detail-map');
  if (!el || typeof L === 'undefined') return;

  var lat = parseFloat(el.getAttribute('data-lat'));
  var lng = parseFloat(el.getAttribute('data-lng'));
  if (!isFinite(lat) || !isFinite(lng)) return;

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
})();
