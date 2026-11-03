/* Billing: print button on saved documents, and the builder's live preview. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-print]')) window.print();
  });

  var form = document.getElementById('builder');
  var paper = document.getElementById('paper');
  if (!form || !paper) return;

  var inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
  var money = function (paise) { return inr.format(paise / 100); };
  var el = function (key) { return $('[data-b="' + key + '"]', paper); };
  var show = function (key, on) { var n = $('[data-b-show="' + key + '"]', paper); if (n) n.hidden = !on; };
  var val = function (name) { var f = form.elements[name]; return f ? f.value : ''; };

  var TYPES = {
    quotation: { title: 'QUOTATION', to: 'Bill to', due: 'Valid until', total: 'Total', foot: 'This quotation is valid until the date shown. Thank you for considering us.' },
    invoice: { title: 'INVOICE', to: 'Bill to', due: 'Due', total: 'Total', foot: 'Thank you for your business.' },
    receipt: { title: 'RECEIPT', to: 'Received from', due: '', total: 'Amount received', foot: 'Thank you — payment received with thanks.' },
  };

  function niceDate(v) {
    if (!v) return '';
    var d = new Date(v + 'T00:00:00');
    return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  var ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  var TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function two(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''); }
  function three(n) { var h = Math.floor(n / 100), r = n % 100; return (h ? ONES[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? two(r) : ''); }
  function words(paise) {
    var total = Math.round(paise), rupees = Math.floor(total / 100), ps = total % 100;
    if (!rupees && !ps) return 'Rupees Zero Only';
    var parts = [], cr = Math.floor(rupees / 1e7); rupees %= 1e7;
    var lk = Math.floor(rupees / 1e5); rupees %= 1e5;
    var th = Math.floor(rupees / 1e3); rupees %= 1e3;
    if (cr) parts.push((cr >= 100 ? three(cr) : two(cr)) + ' Crore');
    if (lk) parts.push(two(lk) + ' Lakh');
    if (th) parts.push(two(th) + ' Thousand');
    if (rupees) parts.push(three(rupees));
    var out = parts.length ? 'Rupees ' + parts.join(' ') : 'Rupees Zero';
    if (ps) out += ' and ' + two(ps) + ' Paise';
    return out + ' Only';
  }

  function row(tag, cells, cls) {
    var tr = document.createElement('tr'); if (cls) tr.className = cls;
    cells.forEach(function (c) { var td = document.createElement(tag); td.textContent = c[0]; if (c[1]) td.className = c[1]; tr.appendChild(td); });
    return tr;
  }

  function update() {
    var type = ($('input[name=type]:checked', form) || {}).value || 'invoice';
    var T = TYPES[type];

    // Items and totals (all in paise, rounded the same way the server does).
    var lines = [], subtotal = 0;
    $$('.item-row', form).forEach(function (r) {
      var d = r.children[0].value.trim(), q = Math.max(0, parseFloat(r.children[1].value) || 0), rate = Math.max(0, Math.round((parseFloat(r.children[2].value) || 0) * 100));
      var amt = Math.round(q * rate);
      r.children[3].textContent = money(amt);
      if (d && q > 0) { lines.push([d, q, rate, amt]); subtotal += amt; }
    });
    var disc = Math.min(Math.max(0, Math.round((parseFloat(val('discount')) || 0) * 100)), subtotal);
    var taxable = subtotal - disc, gst = Number(val('gst_rate')) || 0, igst = form.elements.igst.checked;
    var cgst = !gst || igst ? 0 : Math.round(taxable * gst / 200), ig = gst && igst ? Math.round(taxable * gst / 100) : 0;
    var total = taxable + cgst * 2 + ig;

    var tbody = el('items'); tbody.textContent = '';
    lines.forEach(function (l, i) { tbody.appendChild(row('td', [[String(i + 1)], [l[0]], [String(l[1]), 'num'], [money(l[2]), 'num'], [money(l[3]), 'num']])); });
    if (!lines.length) tbody.appendChild(row('td', [[''], ['Your items will appear here'], [''], [''], ['']], 'ghost'));

    var box = el('totals'); box.textContent = '';
    var add = function (label, value, cls) {
      var d = document.createElement('div'); if (cls) d.className = cls;
      var s = document.createElement('span'); s.textContent = label; var b = document.createElement('b'); b.textContent = value;
      d.appendChild(s); d.appendChild(b); box.appendChild(d);
    };
    add('Subtotal', money(subtotal));
    if (disc) add('Discount', '− ' + money(disc));
    if (cgst) { add('CGST (' + gst / 2 + '%)', money(cgst)); add('SGST (' + gst / 2 + '%)', money(cgst)); }
    if (ig) add('IGST (' + gst + '%)', money(ig));
    add(T.total, money(total), 'grand');
    el('words').textContent = words(total);

    // Header, client and labels.
    paper.dataset.type = type;
    el('title').textContent = T.title; el('to_label').textContent = T.to; el('foot').textContent = T.foot;
    el('issue_date').textContent = niceDate(val('issue_date'));
    el('due_label').textContent = T.due; el('due_date').textContent = niceDate(val('due_date'));
    show('due', type !== 'receipt' && !!val('due_date'));
    el('bill_name').textContent = val('bill_name').trim() || 'Client name';
    el('bill_address').textContent = val('bill_address');
    el('bill_contact').textContent = [val('bill_email'), val('bill_phone')].filter(Boolean).join(' · ');
    el('bill_gstin').textContent = val('bill_gstin').toUpperCase(); show('gstin', !!val('bill_gstin').trim());
    el('notes').textContent = val('notes'); show('notes', !!val('notes').trim());

    // Receipt-only and invoice-only bits.
    show('receipt', type === 'receipt');
    el('pay_method').textContent = val('pay_method') || '—'; el('pay_ref').textContent = val('pay_ref'); show('ref', !!val('pay_ref').trim());
    var payto = $('[data-b-show="payto"]', paper); if (payto) payto.hidden = type === 'receipt' || payto.dataset.has !== '1';

    // Form side: fields that only matter for some types.
    $('#receipt-fields').hidden = type !== 'receipt';
    $('#due-field').hidden = type === 'receipt';
    $('#due-label').textContent = type === 'quotation' ? 'Valid until' : 'Due date';
    $('#igst-row').hidden = !gst;
  }

  var pick = $('[data-client-pick]', form);
  if (pick) pick.addEventListener('change', function () {
    var o = pick.selectedOptions[0];
    if (!o || !o.value) return;
    var set = function (name, v) { if (form.elements[name]) form.elements[name].value = v || ''; };
    set('bill_name', o.dataset.name); set('bill_email', o.dataset.email); set('bill_phone', o.dataset.phone);
    set('bill_gstin', o.dataset.gstin); set('bill_address', o.dataset.address);
    form.elements.igst.checked = o.dataset.igst === '1';
    update();
  });

  var list = $('#items');
  $('#add-item').addEventListener('click', function () {
    var first = $('.item-row', list), c = first.cloneNode(true);
    $$('input', c).forEach(function (i, n) { i.value = n === 1 ? '1' : ''; });
    list.appendChild(c); update(); c.children[0].focus();
  });
  list.addEventListener('click', function (e) {
    var b = e.target.closest('[data-remove-item]'); if (!b) return;
    var r = b.closest('.item-row');
    if ($$('.item-row', list).length > 1) r.remove(); else $$('input', r).forEach(function (i, n) { i.value = n === 1 ? '1' : ''; });
    update();
  });
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
})();
