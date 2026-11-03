/* Project board: drag a card to another column; assign a team member. Falls back to a "Move to" select on touch. */
(function () {
  'use strict';
  var board = document.getElementById('board');
  if (!board) return;
  var csrf = (document.querySelector('meta[name=csrf-token]') || {}).content || '';
  var dragged = null;

  function toast(msg, bad) {
    var t = document.createElement('div');
    t.className = 'toast' + (bad ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }
  function post(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { if (!r.ok) throw new Error('failed'); return r.json(); });
  }
  function url(key, card) { return board.dataset[key].replace('{id}', card.dataset.id); }
  function setOverall(p) {
    [].forEach.call(document.querySelectorAll('[data-overall-bar]'), function (b) { b.style.width = p + '%'; b.parentNode.classList.toggle('done', p >= 100); });
    [].forEach.call(document.querySelectorAll('[data-overall-pct]'), function (n) { n.textContent = p + '%'; });
  }
  function refresh() {
    [].forEach.call(board.querySelectorAll('.col'), function (col) {
      var body = col.querySelector('.col-body');
      var n = body.querySelectorAll('.bcard').length;
      col.querySelector('header .n').textContent = n;
      var empty = body.querySelector('.col-empty');
      if (!n && !empty) { empty = document.createElement('div'); empty.className = 'col-empty'; empty.textContent = 'Nothing here'; body.appendChild(empty); }
      if (n && empty) empty.remove();
    });
  }
  function move(card, col, from) {
    var body = col.querySelector('.col-body');
    var label = col.querySelector('header b').textContent;
    body.appendChild(card);
    var sel = card.querySelector('.move-select'); if (sel) sel.value = col.dataset.col;
    var bar = card.querySelector('.progress'), pct = card.querySelector('.pct');
    if (board.dataset.kind === 'project' && col.dataset.col === 'done') {
      if (bar) { bar.classList.add('done'); bar.firstElementChild.style.width = '100%'; }
      if (pct) pct.textContent = '100%';
    }
    refresh();
    post(url('moveUrl', card), { column: col.dataset.col })
      .then(function (r) { toast('Moved to ' + label); if (r.progress != null) setOverall(r.progress); })
      .catch(function () { from.querySelector('.col-body').appendChild(card); refresh(); toast('Couldn’t move that project', true); });
  }

  board.addEventListener('dragstart', function (e) {
    var card = e.target.closest && e.target.closest('.bcard'); if (!card) return;
    dragged = card; card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.dataset.id);
  });
  board.addEventListener('dragend', function () {
    if (dragged) dragged.classList.remove('dragging');
    dragged = null;
    [].forEach.call(board.querySelectorAll('.col.over'), function (c) { c.classList.remove('over'); });
  });
  board.addEventListener('dragover', function (e) {
    var col = e.target.closest('.col'); if (!col || !dragged) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    [].forEach.call(board.querySelectorAll('.col.over'), function (c) { if (c !== col) c.classList.remove('over'); });
    col.classList.add('over');
  });
  board.addEventListener('drop', function (e) {
    var col = e.target.closest('.col'); if (!col || !dragged) return;
    e.preventDefault(); col.classList.remove('over');
    var from = dragged.closest('.col');
    if (from !== col) move(dragged, col, from);
  });

  board.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.classList.contains('assign-input')) { e.preventDefault(); e.target.blur(); }
  });
  board.addEventListener('change', function (e) {
    var card = e.target.closest('.bcard'); if (!card) return;
    if (e.target.classList.contains('move-select')) {
      var col = board.querySelector('.col[data-col="' + e.target.value + '"]'), from = card.closest('.col');
      if (col && col !== from) move(card, col, from);
    } else if (e.target.classList.contains('assign-input')) {
      var input = e.target, av = card.querySelector('.avatar'), prev = av.textContent;
      post(url('assignUrl', card), { name: input.value })
        .then(function (r) {
          input.value = r.name || '';
          av.textContent = r.name ? r.name.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase() : '?';
          av.classList.toggle('unset', !r.name);
          toast(r.name ? 'Assigned to ' + r.name : 'Unassigned');
        })
        .catch(function () { av.textContent = prev; toast('Couldn’t save that name', true); });
    }
  });
})();
