/* Portal extras: light/dark/auto theme and keyboard shortcuts for search. */
(function () {
  'use strict';
  var root = document.documentElement;

  // Theme: Light, Dark or Auto (follows the device). The top-bar button flips between light and dark.
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function pref() { return root.getAttribute('data-theme-pref') || 'system'; }
  function apply(p) {
    var dark = p === 'dark' || (p !== 'light' && media && media.matches);
    root.setAttribute('data-theme-pref', p);
    if (dark) root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', dark ? '#0b1220' : '#02213d');
    Array.prototype.forEach.call(document.querySelectorAll('[data-theme-set]'), function (b) {
      var on = b.getAttribute('data-theme-set') === p;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function save(p) {
    try { localStorage.setItem('hub-theme', p); } catch (err) { /* ignore */ }
    apply(p);
  }
  document.addEventListener('click', function (e) {
    var set = e.target.closest('[data-theme-set]');
    if (set) return save(set.getAttribute('data-theme-set'));
    if (e.target.closest('[data-theme-toggle]')) save(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  if (media && media.addEventListener) media.addEventListener('change', function () { if (pref() === 'system') apply('system'); });
  apply(pref());

  // <select data-autosubmit> saves as soon as it changes.
  document.addEventListener('change', function (e) {
    var sel = e.target.closest('select[data-autosubmit]');
    if (sel && sel.form) sel.form.submit();
  });

  // Ctrl/Cmd + K, or "/" when not typing, jumps to search.
  document.addEventListener('keydown', function (e) {
    var typing = /^(input|textarea|select)$/i.test((e.target.tagName || '')) || e.target.isContentEditable;
    var combo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';
    if (!combo && !(e.key === '/' && !typing)) return;
    var box = document.querySelector('[data-search]');
    if (box && box.offsetParent !== null) { e.preventDefault(); box.focus(); box.select(); }
    else if (combo) { e.preventDefault(); location.href = '/portal/search'; }
  });
})();
