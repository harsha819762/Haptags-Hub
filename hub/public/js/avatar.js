/* Profile photo upload: sends the chosen image straight to the server, then reloads. */
(function () {
  'use strict';
  var csrf = (document.querySelector('meta[name=csrf-token]') || {}).content || '';
  document.addEventListener('change', function (e) {
    var input = e.target.closest('[data-avatar]');
    var file = input && input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { alert('Please choose an image under 2 MB.'); return; }
    fetch('/portal/account/avatar', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type, 'X-CSRF-Token': csrf }, body: file })
      .then(function (r) { if (!r.ok) throw new Error('failed'); location.reload(); })
      .catch(function () { alert('That image could not be uploaded. Use a PNG, JPG, GIF or WebP under 2 MB.'); });
  });
})();
