/* =====================================================================
   Shared enhancement for .pillar-entry lists (full state directories, the
   "Must See" pillar post): fills in each entry's hours for today from the
   embedded data-hours JSON — no location needed — and, once a visitor
   shares their location via any [data-geo-trigger] button, computes and
   shows distance per entry.
   ===================================================================== */
(function () {
  'use strict';

  // data-hours is a Monday-first array (matches the server's DAYS order);
  // Date#getDay() is Sunday-first, so this maps one to the other.
  function mondayFirstIndex(date) {
    return (date.getDay() + 6) % 7;
  }

  var DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  function fillTodaysHours() {
    var idx = mondayFirstIndex(new Date());
    var label = DAY_LABELS[idx];
    var entries = document.querySelectorAll('.pillar-entry[data-hours]');
    Array.prototype.forEach.call(entries, function (el) {
      var target = el.querySelector('.pillar-hours-today');
      if (!target) return;
      var hours;
      try { hours = JSON.parse(el.getAttribute('data-hours')); } catch (e) { hours = null; }
      var todayHours = hours && hours[idx];
      if (!todayHours) {
        target.textContent = '';
        return;
      }
      if (/closed/i.test(todayHours)) {
        target.textContent = 'Closed today (' + label + ')';
        target.classList.add('is-closed');
      } else {
        target.textContent = 'Open today (' + label + '): ' + todayHours;
        target.classList.add('is-open');
      }
    });
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

  function showDistances(origin) {
    var entries = document.querySelectorAll('.pillar-entry[data-lat][data-lng]');
    Array.prototype.forEach.call(entries, function (el) {
      var lat = parseFloat(el.getAttribute('data-lat'));
      var lng = parseFloat(el.getAttribute('data-lng'));
      var badge = el.querySelector('.pillar-distance');
      if (!badge || !isFinite(lat) || !isFinite(lng)) return;
      var miles = distanceMiles(origin.lat, origin.lng, lat, lng);
      el.setAttribute('data-distance', String(miles));
      badge.hidden = false;
      badge.textContent = miles.toFixed(1) + ' mi away';
    });
    document.dispatchEvent(new CustomEvent('pillar:distances-ready', { detail: origin }));
  }

  function requestLocation(triggerEl) {
    if (!navigator.geolocation) return;
    var original = triggerEl ? triggerEl.textContent : '';
    if (triggerEl) { triggerEl.textContent = 'Finding your location…'; triggerEl.disabled = true; }
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        showDistances({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        if (triggerEl) { triggerEl.textContent = 'Showing distance from your location'; }
      },
      function () {
        if (triggerEl) { triggerEl.textContent = original; triggerEl.disabled = false; }
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  document.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-geo-trigger]');
    if (trigger) requestLocation(trigger);
  });

  if (document.querySelector('.pillar-entry')) fillTodaysHours();
})();
