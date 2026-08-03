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

  // The contact form has no backend; it composes an email the visitor sends.
  var form = document.getElementById('contact-form');
  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var get = function (name) {
        var field = form.elements[name];
        return field ? String(field.value || '').trim() : '';
      };
      var subject = get('topic') ? '[' + get('topic') + '] ' + get('subject') : get('subject');
      var body =
        'Name: ' + get('name') + '\n' +
        'Email: ' + get('email') + '\n' +
        (get('listing') ? 'Listing or farm: ' + get('listing') + '\n' : '') +
        '\n' + get('message') + '\n';
      window.location.href =
        'mailto:' + form.getAttribute('data-email') +
        '?subject=' + encodeURIComponent(subject || 'Website enquiry') +
        '&body=' + encodeURIComponent(body);
      var note = document.getElementById('contact-note');
      if (note) note.hidden = false;
    });
  }
})();
