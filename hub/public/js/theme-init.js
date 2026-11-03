/* Applies the saved theme (light, dark or follow the device) before the page paints, so there is no flash. */
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('hub-theme') || 'system'; } catch (e) { /* storage blocked: follow the device */ }
  var dark = pref === 'dark' || (pref !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme-pref', pref);
  if (dark) root.setAttribute('data-theme', 'dark');
})();
