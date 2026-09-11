// models/emailOutboxModel.js
//
// `email_outbox` -- every notification email, from the moment its event
// happens to the moment it is sent (or given up on).
//
// Written by services/notifications.js when something happens, and drained by
// its background round. Nothing here talks to a mail server.
const { query, pool } = require("../config/db");

/**
 * A claim older than this belongs to a process that died mid-send. Long enough
 * that a slow SMTP handshake is not mistaken for a crash, short enough that a
 * real crash does not leave someone waiting all day for their email.
 */
const STALE_CLAIM_MINUTES = 10;

/**
 * Queue one email.
 *
 * INSERT IGNORE against the unique dedupe_key: a redelivered webhook or a
 * double click produces the same key, and the second insert quietly does
 * nothing. Returns whether THIS call is the one that queued it.
 */
async function enqueue({
  connectionId,
  recipientStoreId,
  kind,
  dedupeKey,
  subject,
  html,
  text,
  // 'skipped' records an email that was decided against at the moment it
  // happened -- the plan's allowance ran out -- so "why did I not get an
  // email" still has an answer.
  status = "pending",
  error = null,
}) {
  const [result] = await pool.query(
    `INSERT IGNORE INTO email_outbox
       (connection_id, recipient_store_id, kind, dedupe_key, subject, html,
        text_body, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      connectionId,
      recipientStoreId,
      String(kind).slice(0, 40),
      String(dedupeKey).slice(0, 191),
      String(subject).slice(0, 255),
      html,
      text,
      status === "skipped" ? "skipped" : "pending",
      error ? String(error).slice(0, 500) : null,
    ]
  );

  return result.affectedRows > 0;
}

/**
 * The next emails to try: pending ones under the attempt limit, plus any whose
 * claim has gone stale.
 */
async function listPending({ limit = 20, maxAttempts = 5 } = {}) {
  return query(
    `SELECT * FROM email_outbox
      WHERE attempts < ?
        AND (status = 'pending'
             OR (status = 'sending'
                 AND claimed_at < NOW() - INTERVAL ${STALE_CLAIM_MINUTES} MINUTE))
      ORDER BY id
      LIMIT ?`,
    [Number(maxAttempts), Number(limit)]
  );
}

/**
 * Take one row for this process. True only for the process that got it.
 *
 * The WHERE re-checks the state the row was listed in, so when two processes
 * list the same row, exactly one UPDATE matches and the other sends nothing.
 */
async function claim(id) {
  const [result] = await pool.query(
    `UPDATE email_outbox
        SET status = 'sending', claimed_at = NOW()
      WHERE id = ?
        AND (status = 'pending'
             OR (status = 'sending'
                 AND claimed_at < NOW() - INTERVAL ${STALE_CLAIM_MINUTES} MINUTE))`,
    [id]
  );

  return result.affectedRows === 1;
}

async function markSent(id, toEmail) {
  await query(
    `UPDATE email_outbox
        SET status = 'sent', to_email = ?, sent_at = NOW(), error = NULL,
            attempts = attempts + 1
      WHERE id = ?`,
    [toEmail, id]
  );
}

/**
 * Will not be sent, and retrying would not change that -- there is no mail
 * server configured, or the store has no address. Recorded rather than
 * deleted, so "why did I not get an email" has an answer.
 */
async function markSkipped(id, reason, toEmail = null) {
  await query(
    `UPDATE email_outbox
        SET status = 'skipped', error = ?, to_email = ?
      WHERE id = ?`,
    [String(reason || "").slice(0, 500), toEmail, id]
  );
}

/**
 * Tried and failed. Back to pending for another round, until the attempts run
 * out -- then 'failed', and it stops.
 */
async function markFailed(id, message, { maxAttempts = 5 } = {}) {
  // status BEFORE attempts, and the order matters. MariaDB applies a single
  // UPDATE's assignments left to right, each seeing the ones before it -- so
  // with attempts incremented first, `attempts + 1` here would be the OLD
  // count plus two, and every email would be given up one try early.
  await query(
    `UPDATE email_outbox
        SET status = IF(attempts + 1 >= ?, 'failed', 'pending'),
            attempts = attempts + 1,
            claimed_at = NULL,
            error = ?
      WHERE id = ?`,
    [Number(maxAttempts), String(message || "").slice(0, 500), id]
  );
}

async function findById(id) {
  const rows = await query("SELECT * FROM email_outbox WHERE id = ? LIMIT 1", [id]);
  return rows[0] || null;
}

/** Everything queued for one connection, newest first. */
async function listForConnection(connectionId, { limit = 50 } = {}) {
  return query(
    `SELECT * FROM email_outbox
      WHERE connection_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [connectionId, Number(limit)]
  );
}

module.exports = {
  STALE_CLAIM_MINUTES,
  enqueue,
  listPending,
  claim,
  markSent,
  markSkipped,
  markFailed,
  findById,
  listForConnection,
};
