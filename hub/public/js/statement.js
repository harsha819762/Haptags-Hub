/* Bank statement upload: sends the chosen CSV straight to the server, then reloads to show the result. */
(function () {
  'use strict';
  var csrf = (document.querySelector('meta[name=csrf-token]') || {}).content || '';
  var MAX = 5 * 1024 * 1024;

  function toast(msg, bad) {
    var t = document.createElement('div');
    t.className = 'toast' + (bad ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, bad ? 6000 : 2500);
  }

  function send(file) {
    if (file.size > MAX) { toast('That file is over 5 MB.', true); return; }
    var acct = document.querySelector('[data-account]');
    toast('Reading ' + file.name + '…');
    fetch('/team/finance/import', {
      method: 'POST', credentials: 'same-origin',
      headers: {
        'Content-Type': 'text/csv', 'X-CSRF-Token': csrf, Accept: 'application/json',
        'X-File-Name': encodeURIComponent(file.name), 'X-Account': encodeURIComponent((acct && acct.value) || 'Main account'),
      },
      body: file,
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { toast(res.j.error || 'Could not read that file.', true); return; }
        toast(res.j.message);
        setTimeout(function () { location.href = '/team/finance?period=all'; }, 900);
      })
      .catch(function () { toast('Upload failed. Try again.', true); });
  }

  document.addEventListener('change', function (e) {
    var inp = e.target.closest('[data-statement]');
    if (inp && inp.files[0]) send(inp.files[0]);
  });
  ['dragover', 'dragleave', 'drop'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var zone = e.target.closest && e.target.closest('[data-statement-drop]');
      if (!zone) return;
      e.preventDefault();
      zone.classList.toggle('over', type === 'dragover');
      if (type === 'drop' && e.dataTransfer.files[0]) send(e.dataTransfer.files[0]);
    });
  });
})();
