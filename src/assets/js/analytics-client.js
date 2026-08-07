/* =====================================================================
   First-party analytics for pumpkinpatchesnearme.com.

   This is a static site with no server/API routes, so events are written
   straight to Supabase from the browser with the anon key (see the RLS
   policies in supabase/migrations/ — the table is public-read/insert by
   design, not by accident). If window.__PPNM_ANALYTICS__.url isn't set
   (no SUPABASE_URL at build time), every function below becomes a no-op:
   the site works identically with analytics off.

   Everything here is fire-and-forget. A failed or blocked request never
   throws and never blocks navigation — trackEvent() always returns
   immediately and swallows its own errors.
   ===================================================================== */
(function () {
  'use strict';

  var config = window.__PPNM_ANALYTICS__ || {};
  var ENABLED = Boolean(config.url && config.anonKey && config.table);

  /* ---------------------------------------------------------- identity */

  function readOrCreate(storage, key) {
    try {
      var existing = storage.getItem(key);
      if (existing) return existing;
      var id = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      storage.setItem(key, id);
      return id;
    } catch (e) {
      return null; // storage disabled (private mode, etc.) — tracking still works, just unattributed
    }
  }

  var sessionId = readOrCreate(window.sessionStorage, 'ppnm_session_id');
  var visitorId = readOrCreate(window.localStorage, 'ppnm_visitor_id');

  /* --------------------------------------------------- page classifier */

  // Every top-level path that is NOT a state page — static pages, blog,
  // and the attraction category pages — kept in sync by hand with
  // src/pages/*.html and src/data/categories.json. Anything else at
  // depth 1 is treated as /{state}/, depth 2 as /{state}/{city}/, depth 3
  // as /{state}/{city}/{listing}/, matching listingPath()/cityPath() in
  // scripts/build.mjs.
  var NON_STATE_TOP_SLUGS = [
    'about', 'add-a-listing', 'authors', 'blog', 'contact', 'dashboard',
    'disclaimer', 'featured', 'partners', 'privacy', 'pumpkin-patches',
    'search', 'sitemap', 'states', 'terms',
    'corn-mazes', 'u-pick-pumpkin-patches', 'hayrides', 'haunted-attractions',
    'petting-zoos', 'apple-picking', 'sunflower-fields', 'fall-festivals',
  ];

  function classifyPath(path) {
    var segments = (path || '').split('/').filter(Boolean);
    if (!segments.length) return { type: 'home' };
    if (NON_STATE_TOP_SLUGS.indexOf(segments[0]) !== -1) return { type: 'other' };
    if (segments.length === 1) return { type: 'state', state: segments[0] };
    if (segments.length === 2) return { type: 'city', state: segments[0], city: segments[1] };
    if (segments.length === 3) return { type: 'listing', state: segments[0], city: segments[1], slug: segments[2] };
    return { type: 'other' };
  }

  // Breadcrumbs carry the human-readable city name; the URL only has the
  // slug. Reading it from the DOM avoids a slug-to-title-case guess.
  function breadcrumbCityLabel() {
    var items = document.querySelectorAll('.breadcrumbs li');
    if (items.length < 2) return null;
    // Listing pages: Home / Pumpkin Patches / State / City / Listing(current)
    // City pages:    Home / Pumpkin Patches / State / City(current)
    var info = classifyPath(window.location.pathname);
    var idx = info.type === 'listing' ? items.length - 2 : items.length - 1;
    var el = items[idx];
    return el ? el.textContent.trim() : null;
  }

  function currentListingName() {
    var h1 = document.querySelector('h1');
    return h1 ? h1.textContent.trim() : null;
  }

  function pillarEntryName(entry) {
    var link = entry.querySelector('h3 a');
    return link ? link.textContent.trim() : null;
  }

  /* ------------------------------------------------------- trackEvent */

  function trackEvent(eventType, extra) {
    if (!ENABLED) return;
    var payload = Object.assign(
      {
        event_type: eventType,
        path: window.location.pathname,
        referrer: document.referrer || null,
        session_id: sessionId,
        visitor_id: visitorId,
      },
      extra || {}
    );

    try {
      fetch(config.url.replace(/\/$/, '') + '/rest/v1/' + config.table, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: config.anonKey,
          Authorization: 'Bearer ' + config.anonKey,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {
      // fetch itself threw (e.g. disabled in this environment) — never
      // let analytics break the page.
    }
  }

  window.ppnmTrackEvent = trackEvent;

  /* --------------------------------------------------- automatic events */

  function trackPageview() {
    var info = classifyPath(window.location.pathname);
    if (info.type === 'listing') {
      trackEvent('listing_view', {
        listing_slug: info.slug,
        listing_name: currentListingName(),
        city: breadcrumbCityLabel(),
      });
    } else {
      trackEvent('pageview', {
        city: info.type === 'city' ? breadcrumbCityLabel() : null,
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', trackPageview);
  } else {
    trackPageview();
  }

  /* --------------------------------------- click instrumentation (delegated) */

  document.addEventListener('click', function (event) {
    var telLink = event.target.closest('a[href^="tel:"]');
    if (telLink) {
      var telEntry = telLink.closest('[data-name]');
      if (telEntry) {
        trackEvent('call_click', {
          listing_slug: telEntry.id || null,
          listing_name: pillarEntryName(telEntry),
          city: telEntry.getAttribute('data-city-label'),
        });
      } else {
        var telPageInfo = classifyPath(window.location.pathname);
        trackEvent('call_click', {
          listing_slug: telPageInfo.type === 'listing' ? telPageInfo.slug : null,
          listing_name: currentListingName(),
          city: breadcrumbCityLabel(),
        });
      }
      return;
    }

    var reviewsLink = event.target.closest('.pillar-reviews-link');
    if (reviewsLink) {
      var reviewsEntry = reviewsLink.closest('[data-name]');
      trackEvent('review_click', {
        listing_slug: reviewsEntry ? reviewsEntry.id || null : null,
        listing_name: reviewsEntry ? pillarEntryName(reviewsEntry) : null,
        city: reviewsEntry ? reviewsEntry.getAttribute('data-city-label') : null,
      });
      return;
    }

    var directionsLink = event.target.closest('a[href*="google.com/maps/dir"]');
    if (directionsLink) {
      var pillarEntry = directionsLink.closest('[data-name]');
      if (pillarEntry) {
        trackEvent('directions_click', {
          listing_slug: pillarEntry.id || null,
          listing_name: pillarEntryName(pillarEntry),
          city: pillarEntry.getAttribute('data-city-label'),
        });
      } else {
        // Not inside a pillar-entry card — this is the "Get directions"
        // button on a listing's own detail page.
        var pageInfo = classifyPath(window.location.pathname);
        trackEvent('directions_click', {
          listing_slug: pageInfo.type === 'listing' ? pageInfo.slug : null,
          listing_name: currentListingName(),
          city: breadcrumbCityLabel(),
        });
      }
    }
  });

  /* -------------------------------------------------- search instrumentation */

  var SEARCH_INPUT_SELECTOR = '#header-search-input, #site-search-input, #state-filter-q';
  var searchTimers = new WeakMap();

  document.addEventListener('input', function (event) {
    if (!event.target.matches || !event.target.matches(SEARCH_INPUT_SELECTOR)) return;
    var input = event.target;
    var existing = searchTimers.get(input);
    if (existing) window.clearTimeout(existing);
    searchTimers.set(
      input,
      window.setTimeout(function () {
        var q = input.value.trim();
        if (q) trackEvent('search', { query: q });
      }, 700)
    );
  });
})();
