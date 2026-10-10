/* =====================================================================
   Season-reminder signup.

   The form is a real <form> with a real submit button and a mailto-free
   action of nothing: with JavaScript off it simply does not submit, and
   the markup says so rather than pretending. With JavaScript on, this
   posts one row straight to PostgREST — no SDK, same approach as
   analytics-client.js, because pulling 200KB of client library to send a
   single INSERT would cost more than the feature is worth.

   The table is insert-only for the anon key (see
   supabase/migrations/0002_email_subscribers.sql), so nothing here can
   read the list back, including to check for duplicates. A repeat
   signup comes back as a 23505 unique violation and is reported to the
   visitor as success, because from their side it is: they are on the
   list. Saying "you are already subscribed" would also confirm to anyone
   who asked whether a given address is in the database.
   ===================================================================== */
(function () {
  'use strict';

  var forms = document.querySelectorAll('[data-email-capture]');
  if (!forms.length) return;

  var config = window.__PPNM_ANALYTICS__ || {};
  var base = (config.url || '').replace(/\/$/, '');
  var key = config.anonKey || '';
  var SCHEMA = 'email';
  var TABLE = 'subscribers';

  Array.prototype.forEach.call(forms, function (form) {
    var input = form.querySelector('[data-email-input]');
    var button = form.querySelector('button[type="submit"]');
    var note = form.querySelector('[data-email-note]');
    var consent = form.querySelector('[data-email-consent]');
    var trap = form.querySelector('[data-email-trap]');
    if (!input || !button || !note) return;

    // A bot that fills every field in the DOM fills this one too. Real
    // people never see it.
    var openedAt = Date.now();

    function say(msg, kind) {
      note.textContent = msg;
      note.className = 'ec-note' + (kind ? ' ec-' + kind : '');
      note.hidden = false;
    }

    // The class goes on the wrapper, not the form: .ec.is-done is what
    // hides the fields and turns the rule green, and the form is inside it.
    var box = form.closest('.ec') || form;

    function done() {
      box.classList.add('is-done');
      input.disabled = true;
      button.disabled = true;
      say('You are on the list. We will email you once when the season opens, and that is all.', 'ok');
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (box.classList.contains('is-done') || button.disabled) return;

      var address = String(input.value || '').trim().toLowerCase();
      if (!address || address.indexOf('@') < 1 || address.indexOf('.', address.indexOf('@')) < 0) {
        say('That does not look like an email address — check it and try again.', 'bad');
        input.focus();
        return;
      }
      if (consent && !consent.checked) {
        say('Tick the box to say we can email you, and we will add you.', 'bad');
        consent.focus();
        return;
      }
      // Submitted within a second of the page producing the form: not a
      // person. Treated as success so a bot learns nothing from the reply.
      if ((trap && trap.value) || Date.now() - openedAt < 1200) {
        done();
        return;
      }
      if (!base || !key) {
        say('Signups are not switched on for this site yet. Nothing was sent.', 'bad');
        return;
      }

      button.disabled = true;
      var was = button.textContent;
      button.textContent = 'Adding…';

      fetch(base + '/rest/v1/' + TABLE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: 'Bearer ' + key,
          // PostgREST only writes outside `public` when told which schema,
          // and the project has to expose `email` for this to resolve.
          'Content-Profile': SCHEMA,
          // Nothing is read back: there is no SELECT policy to read with.
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          address: address,
          state: form.getAttribute('data-state') || null,
          source_path: location.pathname.slice(0, 300),
          consent: true,
        }),
      })
        .then(function (res) {
          // 409 is the unique index doing its job on a repeat signup.
          if (res.ok || res.status === 409) { done(); return; }
          return res.text().then(function (body) {
            throw new Error(res.status + ' ' + body.slice(0, 200));
          });
        })
        .catch(function (err) {
          button.disabled = false;
          button.textContent = was;
          say('That did not save — try again in a moment.', 'bad');
          if (window.console && console.warn) console.warn('[email-capture]', err && err.message);
        });
    });
  });
})();
