/* MatCap shared nav — mobile hamburger toggle.
   Progressive enhancement: the CSS ships a no-JS fallback (links wrap to a
   second row). When this runs it flips the topnav into hamburger mode by
   adding `.js-nav`, then wires up open/close behaviour. Loaded on every page
   that renders the shared <nav class="topnav">. */
(function () {
  'use strict';

  var nav = document.querySelector('nav.topnav');
  if (!nav) return;
  var links = nav.querySelector('.links');
  if (!links) return;

  // Opt into hamburger styling (only affects <=820px via media query).
  nav.classList.add('js-nav');

  var btn = document.createElement('button');
  btn.className = 'nav-toggle';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Toggle menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML =
    '<svg class="icon-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>' +
    '<svg class="icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
  nav.appendChild(btn);

  function setOpen(open) {
    nav.classList.toggle('nav-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) {
      // collapse any open dropdown accordions too
      var dds = nav.querySelectorAll('.tools-dd.open, .cs-dd.open');
      for (var i = 0; i < dds.length; i++) dds[i].classList.remove('open');
    }
  }

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    setOpen(!nav.classList.contains('nav-open'));
  });

  // Close when a real navigation link (not a dropdown trigger) is tapped.
  links.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    if (a.classList.contains('tools-trigger') || a.classList.contains('cs-trigger')) return;
    setOpen(false);
  });

  // Close on Escape.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && nav.classList.contains('nav-open')) setOpen(false);
  });

  // Close when tapping outside the nav.
  document.addEventListener('click', function (e) {
    if (nav.classList.contains('nav-open') && !nav.contains(e.target)) setOpen(false);
  });
})();
