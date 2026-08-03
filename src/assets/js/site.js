/* Site-wide behaviour: mobile navigation and the contact form's mailto handoff. */
(function () {
  'use strict';

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
