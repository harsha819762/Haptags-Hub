/* File uploads for projects and tasks: pick a file or drop one on a drop zone. Falls back to nothing without JS. */
(function () {
  'use strict';
  var csrf = (document.querySelector('meta[name=csrf-token]') || {}).content || '';
  var MAX = 8 * 1024 * 1024;

  function toast(msg, bad) {
    var t = document.createElement('div');
    t.className = 'toast' + (bad ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  function send(url, file) {
    if (file.size > MAX) { toast('That file is over 8 MB.', true); return; }
    toast('Uploading ' + file.name + '…');
    fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-CSRF-Token': csrf },
      body: file,
    }).then(function (r) { if (!r.ok) throw new Error('failed'); location.reload(); })
      .catch(function () { toast('Upload failed. Try again.', true); });
  }

  document.addEventListener('change', function (e) {
    var inp = e.target.closest('[data-upload]');
    if (inp && inp.files[0]) send(inp.getAttribute('data-upload'), inp.files[0]);
  });

  ['dragover', 'dragleave', 'drop'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var zone = e.target.closest && e.target.closest('[data-drop-upload]');
      if (!zone) return;
      e.preventDefault();
      zone.classList.toggle('over', type === 'dragover');
      if (type === 'drop' && e.dataTransfer.files[0]) send(zone.getAttribute('data-drop-upload'), e.dataTransfer.files[0]);
    });
  });
})();
