'use strict';

// Database triggers that refuse to delete GST documents, their lines (once finalised) and
// payments, and to change a document's number. Created by migration 008; migration 010 lifts
// them for its one-off fresh start and puts them straight back.

const NAMES = ['gst_documents_no_delete', 'gst_documents_number_lock', 'gst_lines_lock', 'gst_payments_no_delete'];

const MYSQL = [
  `CREATE TRIGGER gst_documents_no_delete BEFORE DELETE ON gst_documents FOR EACH ROW
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'GST documents are never deleted'`,
  `CREATE TRIGGER gst_documents_number_lock BEFORE UPDATE ON gst_documents FOR EACH ROW
   BEGIN
     IF OLD.number IS NOT NULL AND NOT (NEW.number <=> OLD.number) THEN
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A GST document number cannot be changed';
     END IF;
   END`,
  `CREATE TRIGGER gst_lines_lock BEFORE DELETE ON gst_document_lines FOR EACH ROW
   BEGIN
     IF (SELECT status FROM gst_documents WHERE id = OLD.document_id) <> 'draft' THEN
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Lines of a finalised GST document cannot be removed';
     END IF;
   END`,
  `CREATE TRIGGER gst_payments_no_delete BEFORE DELETE ON gst_payments FOR EACH ROW
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'GST payments are never deleted; reverse them instead'`,
];

const SQLITE = [
  `CREATE TRIGGER gst_documents_no_delete BEFORE DELETE ON gst_documents
   BEGIN SELECT RAISE(ABORT, 'GST documents are never deleted'); END`,
  `CREATE TRIGGER gst_documents_number_lock BEFORE UPDATE OF number ON gst_documents
   WHEN OLD.number IS NOT NULL AND NEW.number IS NOT OLD.number
   BEGIN SELECT RAISE(ABORT, 'A GST document number cannot be changed'); END`,
  `CREATE TRIGGER gst_lines_lock BEFORE DELETE ON gst_document_lines
   WHEN (SELECT status FROM gst_documents WHERE id = OLD.document_id) <> 'draft'
   BEGIN SELECT RAISE(ABORT, 'Lines of a finalised GST document cannot be removed'); END`,
  `CREATE TRIGGER gst_payments_no_delete BEFORE DELETE ON gst_payments
   BEGIN SELECT RAISE(ABORT, 'GST payments are never deleted; reverse them instead'); END`,
];

const isMysql = (knex) => knex.client.config.client === 'mysql2';

/** (Re)creates the triggers. Hosts that refuse triggers get a warning; the app never deletes anyway. */
async function createTriggers(knex) {
  const sqls = isMysql(knex) ? MYSQL : SQLITE;
  for (let i = 0; i < NAMES.length; i += 1) {
    try {
      await knex.raw(`DROP TRIGGER IF EXISTS ${NAMES[i]}`);
      await knex.raw(sqls[i]);
    } catch (err) {
      // Some MySQL hosts need SUPER to create triggers when binary logging is on.
      console.warn(`[migrate] GST safety trigger ${NAMES[i]} not created (${err.message}). The app still never deletes GST records.`);
    }
  }
}

async function dropTriggers(knex) {
  for (const name of NAMES) await knex.raw(`DROP TRIGGER IF EXISTS ${name}`);
}

module.exports = { createTriggers, dropTriggers, NAMES };
