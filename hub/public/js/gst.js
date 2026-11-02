/* GST Invoices — progressive enhancement; the server re-checks everything on save. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var csrf = function () { var m = $('meta[name=csrf-token]'); return m ? m.content : ''; };

  // Dashboard: a financial year and a custom date range are alternatives; picking one clears the other.
  var fySel = $('[data-period-fy]');
  if (fySel) {
    fySel.addEventListener('change', function () { $$('[data-period-date]').forEach(function (d) { d.value = ''; }); fySel.form.submit(); });
    $$('[data-period-date]').forEach(function (d) { d.addEventListener('change', function () { fySel.value = ''; }); });
  }

  // ---- GSTIN check (same rules as src/lib/gst/gstin.js) ----
  var CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function gstinCheck(g) {
    var sum = 0;
    for (var i = 0; i < 14; i += 1) {
      var p = CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1);
      sum += Math.floor(p / 36) + (p % 36);
    }
    return CHARS[(36 - (sum % 36)) % 36];
  }

  // ---- Client form ----
  var clientForm = $('[data-client-form]');
  if (clientForm) {
    var stateSel = $('[data-state]', clientForm);
    var gstinIn = $('[data-gstin]', clientForm);
    var panIn = $('[data-pan]', clientForm);
    var status = $('[data-gstin-status]', clientForm);
    var syncType = function () {
      var t = ($('[data-client-type]:checked', clientForm) || {}).value || 'b2b';
      $$('[data-type-show]', clientForm).forEach(function (el) { el.hidden = el.getAttribute('data-type-show').split(' ').indexOf(t) < 0; });
      if (stateSel) stateSel.disabled = t === 'b2b' && gstinIn && gstinIn.value.length === 15;
    };
    var checkGstin = function () {
      var v = gstinIn.value.toUpperCase().replace(/\s+/g, '');
      if (gstinIn.value !== v) gstinIn.value = v;
      stateSel.disabled = false;
      if (!v) { status.textContent = ''; return; }
      if (v.length < 15) { status.textContent = (15 - v.length) + ' more character' + (v.length === 14 ? '' : 's') + '…'; status.className = 'hint'; return; }
      var opt = $('option[value="' + v.slice(0, 2) + '"]', stateSel);
      if (!/^[0-9A-Z]{15}$/.test(v) || !opt) { status.textContent = 'Not a valid GSTIN: it starts with a 2-digit state code.'; status.className = 'error'; return; }
      if (gstinCheck(v) !== v[14]) { status.textContent = 'Check digit doesn’t match. Look for a typo.'; status.className = 'error'; return; }
      stateSel.value = v.slice(0, 2);
      stateSel.disabled = true;
      if (panIn && !panIn.value && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v.slice(2, 12))) panIn.value = v.slice(2, 12);
      status.textContent = '✓ Valid · ' + opt.textContent.replace(/^\d+ · /, '') + ' (' + v.slice(0, 2) + ')';
      status.className = 'hint ok';
    };
    $$('[data-client-type]', clientForm).forEach(function (r) { r.addEventListener('change', syncType); });
    if (gstinIn) { gstinIn.addEventListener('input', checkGstin); checkGstin(); }
    // A disabled select isn't submitted: re-enable it just before sending.
    clientForm.addEventListener('submit', function () { if (stateSel) stateSel.disabled = false; });
    syncType();
  }

  // ---- Document editor: live totals, mirroring src/lib/gst/tax.js ----
  var editor = $('[data-gst-editor]');
  if (editor) {
    var data = JSON.parse(($('#gst-editor-data') || {}).textContent || '{}');
    var tbody = $('#gst-lines tbody', editor);
    var tpl = $('#gst-line-template');
    var kind = editor.getAttribute('data-kind');
    var clientId = $('[data-client-id]', editor);
    var clientSearch = $('[data-client-search]', editor);
    var posSel = $('[data-pos-select]', editor);
    var curSel = $('[data-currency]', editor);
    var fxIn = $('[data-fx]', editor);
    var supplyBox = $('[data-supply]', editor);
    var num = function (v) { var n = parseFloat(String(v || '').replace(/[₹$€£,\s]/g, '')); return isFinite(n) ? n : 0; };
    var minor = function (v) { return Math.round(num(v) * 100); };
    var fmts = {};
    var fmt = function (m, cur) {
      cur = cur || 'INR';
      if (!fmts[cur]) fmts[cur] = new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2 });
      return fmts[cur].format(m / 100);
    };

    var state = function () {
      if (data.original) return { supply: data.original.supply, currency: data.original.currency, fx: data.original.fx, pos: data.original.pos };
      var c = clientId && data.clients[clientId.value];
      var pos = posSel && posSel.value ? posSel.value : c ? (c.type === 'export' ? '96' : c.state) : '';
      if (c && c.type === 'export') pos = '96';
      var supply = !c && !pos ? null : (c && c.type === 'export') || pos === '96' ? 'export' : pos === data.home ? 'intra' : 'inter';
      var currency = supply === 'export' && curSel ? curSel.value : 'INR';
      return { supply: supply, currency: currency, fx: currency === 'INR' ? 1 : num(fxIn && fxIn.value), pos: pos, client: c };
    };

    var discountOf = function (raw, gross) {
      var s = String(raw || '').replace(/[,\s₹$€£]/g, '');
      if (!s) return 0;
      if (/%$/.test(s)) return Math.round(gross * Math.min(100, Math.max(0, num(s.slice(0, -1)))) / 100);
      return Math.max(0, minor(s));
    };

    var recalc = function () {
      var st = state();
      var t = { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      $$('tr[data-line]', tbody).forEach(function (tr) {
        var q = Math.round(Math.max(0, num($('[name=line_qty]', tr).value)) * 1000) / 1000;
        var rate = Math.max(0, minor($('[name=line_rate]', tr).value));
        var gross = Math.round(q * rate);
        var disc = Math.min(gross, discountOf($('[name=line_discount]', tr).value, gross));
        var taxable = gross - disc;
        var gst = st.supply === 'export' ? 0 : num($('[name=line_gst_rate]', tr).value);
        var cg = st.supply === 'intra' ? Math.round(taxable * gst / 200) : 0;
        var ig = st.supply === 'inter' ? Math.round(taxable * gst / 100) : 0;
        t.taxable += taxable; t.cgst += cg; t.sgst += cg; t.igst += ig;
        $('[data-line-taxable]', tr).textContent = rate ? fmt(taxable, st.currency) : '—';
        $('[data-line-tax]', tr).textContent = rate && st.supply ? fmt(cg * 2 + ig, st.currency) : '—';
        $('[name=line_gst_rate]', tr).disabled = st.supply === 'export';
      });
      var before = t.taxable + t.cgst + t.sgst + t.igst;
      var round = st.currency === 'INR' ? Math.round(before / 100) * 100 - before : 0;
      var total = before + round;
      var set = function (k, v, show) {
        var el = $('[data-t=' + k + ']', editor); if (el) el.textContent = v;
        var row = $('[data-t-row=' + k + ']', editor); if (row && show !== undefined) row.hidden = !show;
      };
      set('taxable', fmt(t.taxable, st.currency));
      set('cgst', fmt(t.cgst, st.currency), st.supply === 'intra');
      set('sgst', fmt(t.sgst, st.currency), st.supply === 'intra');
      set('igst', fmt(t.igst, st.currency), st.supply !== 'intra');
      set('round', (round < 0 ? '−' : '') + fmt(Math.abs(round), st.currency), st.currency === 'INR');
      set('total', fmt(total, st.currency));
      set('inr', st.fx ? fmt(Math.round(total * st.fx), 'INR') : '—', st.currency !== 'INR');
      $$('[data-cur-label]', editor).forEach(function (el) { el.textContent = st.currency; });
      var note = $('[data-fx-note]', editor); if (note) note.hidden = st.currency === 'INR';
      $$('[data-export-only]', editor).forEach(function (el) { el.hidden = st.supply !== 'export'; });
      $$('[data-fx-only]', editor).forEach(function (el) { el.hidden = st.currency === 'INR'; });
      if (supplyBox) {
        var label = { intra: 'Intra-state supply: CGST + SGST at half the rate each', inter: 'Inter-state supply: IGST at the full rate', export: 'Export of services: 0% IGST under LUT' }[st.supply];
        supplyBox.textContent = label ? label + (st.pos ? ' · place of supply ' + st.pos : '') : 'Choose a client to see how GST applies.';
        supplyBox.className = 'gst-supply ' + (st.supply || '');
      }
    };

    var fillFromItem = function (tr) {
      var it = data.items[$('[data-line-item]', tr).value];
      if (!it) return;
      $('[name=line_description]', tr).value = it.description || it.name;
      $('[name=line_sac]', tr).value = it.sac || '';
      $('[name=line_unit]', tr).value = it.unit || '';
      if (it.rate) $('[name=line_rate]', tr).value = (it.rate / 100).toFixed(2).replace(/\.00$/, '');
      $('[name=line_gst_rate]', tr).value = String(it.gst);
      autosize($('[name=line_description]', tr));
    };
    var autosize = function (ta) { if (!ta) return; ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight + 2) + 'px'; };

    editor.addEventListener('input', function (e) { if (e.target.matches('[data-autosize]')) autosize(e.target); recalc(); });
    editor.addEventListener('change', function (e) {
      if (e.target.matches('[data-line-item]')) fillFromItem(e.target.closest('tr'));
      recalc();
    });

    // Client picker: type to search the Hub's clients; the pick sets place of supply and currency.
    var picker = $('[data-client-picker]', editor);
    if (picker && clientSearch) {
      var results = $('#client-results', picker);
      var card = $('[data-client-card]', picker);
      var ids = Object.keys(data.clients).sort(function (a, b) { return data.clients[a].name.localeCompare(data.clients[b].name); });
      var matches = [];
      var active = -1;
      clientSearch.removeAttribute('list'); // the datalist is only for browsers without JavaScript
      var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
      var describe = function (c) {
        if (c.type === 'export') return 'Export · ' + c.country;
        return (c.type === 'b2b' ? 'B2B · GSTIN ' + c.gstin : 'B2C · unregistered') + (c.stateName ? ' · ' + c.stateName + ' (' + c.state + ')' : '');
      };
      var renderCard = function () {
        var c = data.clients[clientId.value];
        card.textContent = '';
        card.hidden = !c;
        if (!c) return;
        card.appendChild(el('b', '', c.name));
        card.appendChild(el('span', '', describe(c)));
        var contact = [c.contact, c.email].filter(Boolean).join(' · ');
        if (contact) card.appendChild(el('span', 'muted', contact));
        if (c.issues && c.issues.length) {
          var warn = el('span', 'gst-picker-warn', 'Needs fixing before a tax invoice: ' + c.issues.join(', ') + '. ');
          var fix = el('a', '', 'Edit client');
          fix.href = '/invoices/clients/' + clientId.value + '/edit';
          fix.target = '_blank';
          warn.appendChild(fix);
          card.appendChild(warn);
        }
      };
      var close = function () { results.hidden = true; clientSearch.setAttribute('aria-expanded', 'false'); active = -1; };
      var highlight = function () {
        $$('li', results).forEach(function (li, i) { li.classList.toggle('active', i === active); if (i === active) li.scrollIntoView({ block: 'nearest' }); });
        if (active >= 0) clientSearch.setAttribute('aria-activedescendant', 'client-opt-' + active); else clientSearch.removeAttribute('aria-activedescendant');
      };
      var choose = function (id) {
        var c = data.clients[id];
        clientId.value = id;
        clientSearch.value = c.name;
        close();
        if (posSel) posSel.value = c.type === 'export' ? '96' : c.state || '';
        if (curSel && c.type === 'export' && curSel.value === 'INR') curSel.value = 'USD';
        if (curSel && c.type !== 'export') curSel.value = 'INR';
        renderCard();
        recalc();
      };
      var search = function () {
        var q = clientSearch.value.trim().toLowerCase();
        matches = ids.filter(function (id) {
          var c = data.clients[id];
          return !q || [c.name, c.gstin, c.city, c.contact, c.email].some(function (v) { return v && String(v).toLowerCase().indexOf(q) >= 0; });
        }).slice(0, 8);
        results.textContent = '';
        matches.forEach(function (id, i) {
          var c = data.clients[id];
          var li = el('li');
          li.id = 'client-opt-' + i;
          li.setAttribute('role', 'option');
          li.appendChild(el('b', '', c.name));
          li.appendChild(el('span', '', describe(c) + (c.city ? ' · ' + c.city : '')));
          li.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(id); });
          results.appendChild(li);
        });
        if (!matches.length) {
          var none = el('li', 'empty', q ? 'No Hub client matches “' + clientSearch.value.trim() + '”. ' : 'No clients yet. ');
          var add = el('a', '', 'Add a client');
          add.href = '/invoices/clients/new';
          none.appendChild(add);
          results.appendChild(none);
        }
        results.hidden = false;
        clientSearch.setAttribute('aria-expanded', 'true');
      };
      clientSearch.addEventListener('input', function () {
        var c = data.clients[clientId.value];
        if (c && clientSearch.value !== c.name) { clientId.value = ''; renderCard(); recalc(); }
        search();
      });
      clientSearch.addEventListener('focus', function () { if (!clientId.value) search(); });
      clientSearch.addEventListener('blur', function () { setTimeout(close, 150); });
      clientSearch.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' && results.hidden) { e.preventDefault(); search(); return; }
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && matches.length) {
          e.preventDefault();
          active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
          highlight();
        } else if (e.key === 'Enter' && !results.hidden) {
          e.preventDefault();
          if (matches.length) choose(matches[Math.max(0, active)]);
        } else if (e.key === 'Escape') {
          close();
        }
      });
      renderCard();
    }
    editor.addEventListener('click', function (e) {
      if (e.target.closest('[data-add-line]')) {
        e.preventDefault();
        var row = tpl.content.firstElementChild.cloneNode(true);
        tbody.appendChild(row);
        $('[data-line-item]', row).focus();
        recalc();
      }
      var rm = e.target.closest('[data-remove-line]');
      if (rm) {
        e.preventDefault();
        if ($$('tr[data-line]', tbody).length > 1) rm.closest('tr').remove();
        else $$('input, textarea', rm.closest('tr')).forEach(function (i) { i.value = i.name === 'line_qty' ? '1' : ''; });
        recalc();
      }
    });

    // Payment terms set the due date (it can still be changed by hand).
    var termsSel = $('[data-terms-select]', editor);
    var issueIn = $('[data-issue-date]', editor);
    var dueIn = $('[data-due-date]', editor);
    var syncDue = function () {
      var days = data.terms && data.terms[termsSel.value];
      if (days === undefined || days === null || !issueIn.value) return;
      var d = new Date(issueIn.value + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + Number(days));
      dueIn.value = d.toISOString().slice(0, 10);
    };
    if (termsSel && issueIn && dueIn) { termsSel.addEventListener('change', syncDue); issueIn.addEventListener('change', syncDue); }

    // A new note: picking the invoice reloads the form with that invoice's lines.
    var origSel = $('[data-note-original]', editor);
    if (origSel && !origSel.disabled) {
      origSel.addEventListener('change', function () {
        if (origSel.value) location.href = '/invoices/docs/new?kind=' + encodeURIComponent(kind) + '&original=' + encodeURIComponent(origSel.value);
      });
    }

    // Finalising re-enables disabled GST selects so their values are sent (exports send 0% anyway).
    editor.addEventListener('submit', function () { $$('[name=line_gst_rate]', editor).forEach(function (s) { s.disabled = false; }); });

    $$('[data-autosize]', editor).forEach(autosize);
    recalc();
  }

  // ---- Payment form: TDS presets ----
  $$('[data-payment-form]').forEach(function (form) {
    var taxable = Number(form.getAttribute('data-taxable')) || 0;
    var balance = Number(form.getAttribute('data-balance')) || 0;
    var preset = $('[data-tds-preset]', form);
    var tds = $('[data-tds-amount]', form);
    var amount = $('[data-pay-amount]', form);
    if (!preset || !tds || !amount) return;
    var show = function (m) { return (m / 100).toFixed(2).replace(/\.00$/, ''); };
    preset.addEventListener('change', function () {
      var opt = preset.selectedOptions[0];
      var rate = opt ? Number(opt.getAttribute('data-rate')) : 0;
      var t = rate ? Math.round(taxable * rate / 100) : 0;
      tds.value = t ? show(t) : '';
      amount.value = show(Math.max(0, balance - t));
    });
  });

  // ---- Logo / signature upload: the image goes as the raw body ----
  $$('[data-image-upload]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var file = $('[data-file]', form).files[0];
      var err = form.parentNode.querySelector('[data-upload-error]');
      err.textContent = '';
      if (!file) { err.textContent = 'Choose an image first.'; return; }
      if (!/^image\/(png|jpeg)$/.test(file.type)) { err.textContent = 'Use a PNG or JPEG image.'; return; }
      if (file.size > 2 * 1024 * 1024) { err.textContent = 'That image is over 2 MB.'; return; }
      var btn = $('button', form);
      btn.disabled = true;
      fetch(form.getAttribute('data-image-upload'), {
        method: 'POST', credentials: 'same-origin', body: file,
        headers: { 'content-type': file.type, accept: 'application/json', 'x-csrf-token': csrf(), 'x-file-name': encodeURIComponent(file.name) },
      }).then(function (r) { return r.json(); })
        .then(function (j) { if (!j.ok) throw new Error(j.message || 'Upload failed'); location.reload(); })
        .catch(function (x) { err.textContent = x.message; btn.disabled = false; });
    });
  });
})();
