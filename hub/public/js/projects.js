/* Projects: the "New project" dialog, and the project board (drag cards between columns, assign a teammate). */
(function () {
  'use strict';
  var csrf = (document.querySelector('meta[name=csrf-token]') || {}).content || '';

  // ---- New project dialog ----
  var dialog = document.getElementById('new-project');
  if (dialog) {
    var pick = dialog.querySelector('[data-new-client]');
    var field = dialog.querySelector('[data-new-client-field]');
    var input = field && field.querySelector('input');
    var sync = function () {
      var isNew = pick.value === 'new';
      field.hidden = !isNew;
      input.required = isNew;
      if (isNew) input.focus();
    };
    pick.addEventListener('change', sync);
    var phase = dialog.querySelector('[data-phase-input]');
    document.addEventListener('click', function (e) {
      var opener = e.target.closest && e.target.closest('[data-dialog="#new-project"]');
      if (opener && phase) phase.value = opener.getAttribute('data-phase') || 'todo';
    }, true);
    if (dialog.hasAttribute('data-open') && dialog.showModal) dialog.showModal();
  }

  // ---- Edit project dialog: reopens after a validation error (?edit=1) ----
  var projectEdit = document.getElementById('project-edit');
  if (projectEdit && projectEdit.hasAttribute('data-open') && projectEdit.showModal) projectEdit.showModal();

  // ---- Edit or delete a task (pencil on a board card) ----
  var editDialog = document.getElementById('task-edit');
  if (editDialog) {
    var form = editDialog.querySelector('[data-edit-form]');
    var del = editDialog.querySelector('[data-delete-btn]');
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.edit-task'); if (!btn) return;
      e.preventDefault();
      var id = btn.getAttribute('data-task-id');
      form.action = '/team/tasks/' + id + '/edit';
      del.setAttribute('formaction', '/team/tasks/' + id + '/delete');
      form.elements.title.value = btn.getAttribute('data-title') || '';
      form.elements.due_date.value = btn.getAttribute('data-due') || '';
      form.elements.priority.value = btn.getAttribute('data-priority') || 'normal';
      editDialog.showModal();
      form.elements.title.focus();
      form.elements.title.select();
    });
    // Deleting doesn't need a title, so skip the form's required check for that button.
    del.addEventListener('click', function () { form.elements.title.required = false; setTimeout(function () { form.elements.title.required = true; }, 0); });
  }

  // ---- Project board ----
  var board = document.getElementById('board');
  if (!board) return;
  var dragged = null;

  function toast(msg, bad) {
    var t = document.createElement('div');
    t.className = 'toast' + (bad ? ' err' : '');
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2400);
  }
  function post(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { if (!r.ok) throw new Error('failed'); return r.json(); });
  }
  function url(key, card) { return board.dataset[key].replace('{id}', card.dataset.id); }
  function initials(name) {
    return name ? name.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase() : '?';
  }
  function refresh() {
    if (board.dataset.kind === 'project') { countOnly(); return; }
    [].forEach.call(board.querySelectorAll('.col'), function (col) {
      var body = col.querySelector('.col-body');
      var n = body.querySelectorAll('.bcard').length;
      col.querySelector('header .n').textContent = n;
      var empty = body.querySelector('.col-empty');
      if (!n && !empty) { empty = document.createElement('div'); empty.className = 'col-empty'; empty.textContent = 'Nothing here'; body.appendChild(empty); }
      if (n && empty) empty.remove();
    });
    var done = board.querySelector('.col[data-col="done"] .col-body');
    var counter = document.querySelector('[data-done-count]');
    if (done && counter) counter.textContent = done.querySelectorAll('.bcard').length;
  }
  function countOnly() {
    [].forEach.call(board.querySelectorAll('.col'), function (col) {
      var body = col.querySelector('.col-body');
      var n = body.querySelectorAll('.bcard').length;
      col.querySelector('header .n').textContent = n;
      var empty = body.querySelector('.col-empty');
      if (!n && !empty) { empty = document.createElement('div'); empty.className = 'col-empty'; empty.textContent = 'Nothing here'; body.appendChild(empty); }
      if (n && empty) empty.remove();
    });
  }
  function setProgress(p) {
    [].forEach.call(document.querySelectorAll('[data-overall-bar]'), function (b) { b.style.width = p + '%'; b.parentNode.classList.toggle('done', p >= 100); });
    [].forEach.call(document.querySelectorAll('[data-overall-pct]'), function (n) { n.textContent = p + '%'; });
  }
  function move(card, col, from) {
    var label = col.querySelector('header b').textContent;
    col.querySelector('.col-body').appendChild(card);
    var sel = card.querySelector('.move-select'); if (sel) sel.value = col.dataset.col;
    refresh();
    post(url('moveUrl', card), { column: col.dataset.col })
      .then(function (r) {
        toast('Moved to ' + label);
        if (r.progress == null) return;
        if (board.dataset.kind === 'project') {
          var bar = card.querySelector('[data-card-bar]'), pct = card.querySelector('[data-card-pct]');
          if (bar) { bar.style.width = r.progress + '%'; bar.parentNode.classList.toggle('done', r.status === 'completed'); }
          if (pct) pct.textContent = r.progress + '%';
          var hold = card.querySelector('.chip-amber'); if (hold && hold.textContent === 'On hold' && r.status !== 'on_hold') hold.remove();
        } else setProgress(r.progress);
      })
      .catch(function () {
        from.querySelector('.col-body').appendChild(card);
        if (sel) sel.value = from.dataset.col;
        refresh();
        toast('Couldn’t move that ' + (board.dataset.kind === 'project' ? 'project' : 'task') + '. Please try again.', true);
      });
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

  board.addEventListener('change', function (e) {
    var card = e.target.closest('.bcard'); if (!card) return;
    if (e.target.classList.contains('move-select')) {
      var col = board.querySelector('.col[data-col="' + e.target.value + '"]'), from = card.closest('.col');
      if (col && col !== from) move(card, col, from);
    } else if (e.target.classList.contains('assign-select')) {
      var select = e.target, av = card.querySelector('.avatar'), prevText = av.textContent;
      post(url('assignUrl', card), { user_id: select.value })
        .then(function (r) {
          av.textContent = initials(r.name);
          av.classList.toggle('unset', !r.name);
          var keep = select.querySelector('option[value="keep"]'); if (keep) keep.remove();
          toast(r.name ? 'Assigned to ' + r.name : 'Unassigned');
        })
        .catch(function () { av.textContent = prevText; toast('Couldn’t save who it’s assigned to.', true); });
    }
  });
})();
