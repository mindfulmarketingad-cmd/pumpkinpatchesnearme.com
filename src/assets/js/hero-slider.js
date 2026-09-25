/* =====================================================================
   Homepage hero slider.

   Both slides are server-rendered and visible to crawlers; this file only
   adds the movement and the controls. With JS off the first slide shows
   and nothing is broken.

   The rule that shapes the rest of this file: the search bar sits directly
   above this slider, and nothing here may move under someone who is using
   it. Auto-advance therefore stops for good on any real interaction — a
   click on the controls, or focus landing anywhere inside the hero — and
   pauses while the pointer is over it or the tab is in the background.
   Reduced-motion visitors get the controls and no automatic movement at
   all. Between the stop-on-interaction and the visible controls this
   satisfies WCAG 2.2.2 (pause, stop, hide).
   ===================================================================== */
(function () {
  'use strict';

  var root = document.getElementById('hero-slider');
  var track = document.getElementById('hero-slides');
  var dotsWrap = document.getElementById('hero-slider-dots');
  if (!root || !track) return;

  var slides = Array.prototype.slice.call(track.querySelectorAll('.hero-slide'));
  if (slides.length < 2) return;

  var INTERVAL = 6000;
  var index = 0;
  var timer = null;
  var stopped = false;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var arrows = Array.prototype.slice.call(root.querySelectorAll('[data-hero-dir]'));
  var dots = [];

  root.classList.add('is-enhanced');
  arrows.forEach(function (btn) { btn.hidden = false; });

  if (dotsWrap) {
    dotsWrap.hidden = false;
    slides.forEach(function (_, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'hero-slider-dot';
      b.setAttribute('aria-label', 'Show slide ' + (i + 1) + ' of ' + slides.length);
      b.addEventListener('click', function () { stop(); go(i); });
      dotsWrap.appendChild(b);
      dots.push(b);
    });
  }

  function render() {
    track.style.transform = 'translateX(' + (-100 * index) + '%)';
    slides.forEach(function (el, i) {
      var on = i === index;
      el.classList.toggle('is-active', on);
      // Keeps the off-screen slide's "Book Now" out of the tab order, so
      // tabbing doesn't jump to a control nobody can see.
      el.setAttribute('aria-hidden', on ? 'false' : 'true');
      if (on) el.removeAttribute('inert'); else el.setAttribute('inert', '');
    });
    dots.forEach(function (d, i) {
      d.classList.toggle('is-active', i === index);
      d.setAttribute('aria-current', i === index ? 'true' : 'false');
    });
  }

  function go(i) {
    index = (i + slides.length) % slides.length;
    render();
  }

  function start() {
    if (stopped || reduced || timer || document.hidden) return;
    timer = window.setInterval(function () { go(index + 1); }, INTERVAL);
  }

  function pause() {
    if (timer) { window.clearInterval(timer); timer = null; }
  }

  // Permanent for this pageview: once someone has taken the wheel, the hero
  // never moves on its own again.
  function stop() {
    stopped = true;
    pause();
  }

  arrows.forEach(function (btn) {
    btn.addEventListener('click', function () {
      stop();
      go(index + Number(btn.getAttribute('data-hero-dir')));
    });
  });

  root.addEventListener('mouseenter', pause);
  root.addEventListener('mouseleave', start);

  // Focus anywhere in the hero — including the ZIP field and the filters in
  // the bar above the slider — means someone is working; stop for good.
  var hero = root.closest('.hero-app') || root;
  hero.addEventListener('focusin', stop);

  // On a phone the arrows are hidden and the dots sit below the fold, so a
  // swipe is the only control within reach. Only a clearly horizontal drag
  // counts, otherwise this would hijack vertical scrolling past the hero.
  var touchX = null;
  var touchY = null;
  track.addEventListener('touchstart', function (e) {
    touchX = e.changedTouches[0].clientX;
    touchY = e.changedTouches[0].clientY;
  }, { passive: true });
  track.addEventListener('touchend', function (e) {
    if (touchX === null) return;
    var dx = e.changedTouches[0].clientX - touchX;
    var dy = e.changedTouches[0].clientY - touchY;
    touchX = null;
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy)) return;
    stop();
    go(index + (dx < 0 ? 1 : -1));
  }, { passive: true });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pause(); else start();
  });

  render();
  start();
})();
