'use strict';

// GST Invoices now bills the Hub's own clients. Hub clients gain a PAN, and any client that was
// added only inside GST Invoices joins the Hub's list (matched to an existing Hub client by
// GSTIN or name first, so nobody is duplicated). Plain column only: see 006 on SQLite.

exports.up = async function up(knex) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (!(await knex.schema.hasColumn('clients', 'pan'))) {
    await knex.schema.alterTable('clients', (t) => { t.string('pan', 10); });
  }
  const orphans = await knex('gst_clients as g').leftJoin('clients as c', 'c.id', 'g.hub_client_id').whereNull('c.id').select('g.*');
  for (const g of orphans) {
    let match = g.gstin ? await knex('clients').where({ segment: 'business', gstin: g.gstin }).first() : null;
    if (!match) match = await knex('clients').where({ segment: 'business' }).whereRaw('lower(name) = ?', [String(g.name).toLowerCase()]).first();
    let id = match && match.id;
    if (!id) {
      [id] = await knex('clients').insert({
        name: g.name, contact_name: g.contact_person, email: g.email, phone: g.phone, gstin: g.gstin, address: g.address, city: g.city,
        state: g.client_type === 'export' ? null : g.state_name, pincode: g.pincode, country: g.country || 'India', notes: g.notes, pan: g.pan,
        status: g.is_active ? 'active' : 'inactive', segment: 'business', created_at: g.created_at || now, updated_at: now,
      });
      if (typeof id === 'object') id = id.id;
    }
    await knex('gst_clients').where({ id: g.id }).update({ hub_client_id: id, updated_at: now });
  }
};

// The PAN column stays: dropping a column can rebuild the clients table on SQLite (see 006).
exports.down = async function down() {};
