/* =====================================================================
   Collapses each listicle entry's long write-up by default, showing just
   the business info (name, rating, address, tags) users actually scan
   first. The full write-up stays in the server-rendered HTML the whole
   time — this only toggles a `hidden` attribute — so it's still there for
   search engines and for anyone with JS disabled (nothing to un-hide in
   that case; the CSS fallback below keeps it visible).
   ===================================================================== */
(function () {
  'use strict';

  document.addEventListener('click', function (event) {
    var btn = event.target.closest('.listicle-toggle');
    if (!btn) return;
    var more = btn.nextElementSibling;
    if (!more || !more.classList.contains('listicle-more')) return;
    var expanded = btn.getAttribute('aria-expanded') === 'true';
    more.hidden = expanded;
    btn.setAttribute('aria-expanded', String(!expanded));
    btn.textContent = '';
    btn.appendChild(document.createTextNode(expanded ? 'Read full write-up' : 'Show less'));
    var icon = document.createElement('span');
    icon.className = 'listicle-toggle-icon';
    icon.setAttribute('aria-hidden', 'true');
    btn.appendChild(icon);
  });
})();
