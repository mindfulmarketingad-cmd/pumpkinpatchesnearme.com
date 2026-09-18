/* Site-wide behaviour: mobile navigation and the contact form's mailto handoff. */
(function () {
  'use strict';

  /* ------------------------------------------------------- promo bar */
  // Dismissal persists across pages (localStorage, not session) so closing
  // it once actually sticks. The head script applies .promo-off before
  // first paint; this only has to handle the click itself.
  var promoBanner = document.getElementById('promo-banner');
  var promoTrack = document.getElementById('promo-banner-track');
  var promoTimer = null;

  // Rotation only exists when there is more than one offer to rotate; a
  // single slide just sits there.
  if (promoTrack) {
    var slides = promoTrack.querySelectorAll('.promo-banner-link');
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (slides.length > 1 && !reduceMotion) {
      var current = 0;

      var showSlide = function (next) {
        slides[current].classList.remove('is-active');
        current = (next + slides.length) % slides.length;
        slides[current].classList.add('is-active');
      };
      var startRotation = function () {
        if (promoTimer) return;  // don't stack intervals on repeated enter/leave
        promoTimer = window.setInterval(function () { showSlide(current + 1); }, 7000);
      };
      var stopRotation = function () {
        window.clearInterval(promoTimer);
        promoTimer = null;
      };

      startRotation();

      // WCAG 2.2.2 — auto-updating content has to be pausable. Hovering or
      // tabbing into the bar holds the current offer still so it can be
      // read and clicked instead of swapping out mid-reach.
      promoBanner.addEventListener('mouseenter', stopRotation);
      promoBanner.addEventListener('mouseleave', startRotation);
      promoBanner.addEventListener('focusin', stopRotation);
      promoBanner.addEventListener('focusout', startRotation);
      // No point cycling offers in a tab nobody is looking at.
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopRotation(); else startRotation();
      });
    }
  }

  var promoClose = document.getElementById('promo-banner-close');
  if (promoClose) {
    promoClose.addEventListener('click', function () {
      if (promoTimer) { window.clearInterval(promoTimer); promoTimer = null; }
      document.documentElement.classList.add('promo-off');
      try { localStorage.setItem('ppnm-promo-dismissed', '1'); } catch (e) {}
    });
  }

  /* ----------------------------------------------------- promo modal */
  // Held back on purpose. Google treats an interstitial that covers the
  // content on mobile entry as a ranking negative, and search is where this
  // site's traffic comes from — so it waits until the visitor has actually
  // been reading, and shows at most once per visitor, ever.
  var PROMO_MODAL_KEY = 'ppnm-promo-modal-seen';
  var PROMO_MODAL_DELAY = 15000;
  var modal = document.getElementById('promo-modal');

  if (modal) {
    var lastFocused = null;

    var alreadySeen = function () {
      try { return !!localStorage.getItem(PROMO_MODAL_KEY); } catch (e) { return true; }
    };
    var markSeen = function () {
      try { localStorage.setItem(PROMO_MODAL_KEY, '1'); } catch (e) {}
    };

    var closeModal = function () {
      modal.hidden = true;
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onModalKeydown);
      if (lastFocused && lastFocused.focus) lastFocused.focus();
    };

    function onModalKeydown(event) {
      if (event.key === 'Escape') { closeModal(); return; }
      if (event.key !== 'Tab') return;
      // Keep tabbing inside the dialog while it is open.
      var focusable = modal.querySelectorAll('a[href], button');
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    var openModal = function () {
      if (alreadySeen()) return;
      markSeen();
      lastFocused = document.activeElement;
      modal.hidden = false;
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', onModalKeydown);
      var cta = document.getElementById('promo-modal-cta');
      if (cta) cta.focus();
    };

    Array.prototype.forEach.call(modal.querySelectorAll('[data-promo-close]'), function (el) {
      el.addEventListener('click', closeModal);
    });
    // Clicking through to the offer counts as done with it.
    var modalCta = document.getElementById('promo-modal-cta');
    if (modalCta) modalCta.addEventListener('click', closeModal);

    if (!alreadySeen()) window.setTimeout(openModal, PROMO_MODAL_DELAY);
  }

  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('main-nav');

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.getAttribute('data-open') === 'true';
      nav.setAttribute('data-open', String(!open));
      toggle.setAttribute('aria-expanded', String(!open));
    });

    document.addEventListener('click', function (event) {
      if (window.innerWidth > 900) return;
      if (nav.contains(event.target) || toggle.contains(event.target)) return;
      nav.setAttribute('data-open', 'false');
      toggle.setAttribute('aria-expanded', 'false');
    });
  }

  // The header search is a native <details> disclosure, so it works even if
  // this script fails to load — this just adds the click-outside-to-close
  // behaviour <details> doesn't give you for free, plus autofocus on open.
  var searchDetails = document.querySelector('.header-search-details');
  var searchInput = document.getElementById('header-search-input');
  if (searchDetails) {
    searchDetails.addEventListener('toggle', function () {
      if (searchDetails.open && searchInput) searchInput.focus();
    });
    document.addEventListener('click', function (event) {
      if (!searchDetails.open) return;
      if (searchDetails.contains(event.target)) return;
      searchDetails.open = false;
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && searchDetails.open) {
        searchDetails.open = false;
      }
    });
  }

  // Neither form has a backend; each composes an email the visitor sends.
  var contactForm = document.getElementById('contact-form');
  if (contactForm) {
    contactForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var get = function (name) {
        var field = contactForm.elements[name];
        return field ? String(field.value || '').trim() : '';
      };
      var subject = get('topic') ? '[' + get('topic') + '] ' + get('subject') : get('subject');
      var body =
        'Name: ' + get('name') + '\n' +
        'Email: ' + get('email') + '\n' +
        (get('listing') ? 'Listing or farm: ' + get('listing') + '\n' : '') +
        '\n' + get('message') + '\n';
      window.location.href =
        'mailto:' + contactForm.getAttribute('data-email') +
        '?subject=' + encodeURIComponent(subject || 'Website enquiry') +
        '&body=' + encodeURIComponent(body);
      var note = document.getElementById('contact-note');
      if (note) note.hidden = false;
    });
  }

  var listingForm = document.getElementById('listing-form');
  if (listingForm) {
    listingForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var get = function (name) {
        var field = listingForm.elements[name];
        return field ? String(field.value || '').trim() : '';
      };
      var features = Array.prototype.slice
        .call(listingForm.querySelectorAll('input[name="features"]:checked'))
        .map(function (el) { return el.value; })
        .join(', ');
      var body =
        'Status: ' + get('status') + '\n' +
        'Farm name: ' + get('farm_name') + '\n' +
        'Address: ' + get('address') + '\n' +
        'Phone: ' + get('phone') + '\n' +
        'Website: ' + get('website') + '\n' +
        'Season / hours: ' + get('season') + '\n' +
        'Admission: ' + get('admission') + '\n' +
        'Features: ' + (features || '(none selected)') + '\n' +
        'Notes: ' + get('notes') + '\n' +
        '\nSubmitted by: ' + get('your_name') + ' (' + get('your_email') + ')\n';
      window.location.href =
        'mailto:' + listingForm.getAttribute('data-email') +
        '?subject=' + encodeURIComponent('New listing: ' + (get('farm_name') || 'Untitled farm')) +
        '&body=' + encodeURIComponent(body);
      var note = document.getElementById('listing-note');
      if (note) note.hidden = false;
    });
  }
})();
