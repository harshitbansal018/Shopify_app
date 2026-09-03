// models/orderMappingModel.js
//
// `order_mappings` -- one row per source store per destination sale.
//
// A shopper buys in the destination store; every source store that supplied
// something on that order gets a row here, holding only its own lines and its
// own money. A basket spanning two suppliers therefore makes two rows.
//
// The row is the whole record of the job. Nothing is written to the source's
// Shopify admin, so this table -- not that store -- is where the sale lives
// and where its fulfilment state is kept.
//
// Two states, and they behave differently on purpose:
//
//   source_fulfillment_status   set by the SOURCE on its Orders screen, and
//                               read by the destination. Bookkeeping only.
//
//   cancel_*                    a QUEUE. Cancelling is the one thing that
//                               reaches the destination's real Shopify order,
//                               because a shopper must not stay charged for
//                               goods nobody will send.
const { query, pool } = require("../config/db");
const { parseJson } = require("./helpers");

/** What the source has done with the sale. Drives the tabs on both screens. */
const FULFILMENT_STATES = ["unfulfilled", "fulfilled", "cancelled"];

/** JSON columns come back from MariaDB as strings. */
function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    source_tracking: parseJson(row.source_tracking, []) || [],
    shipping_address: parseJson(row.shipping_address, null),
  };
}

/**
 * Everything a screen needs, in one query.
 *
 * The joins are what make a row self-describing: without them a caller would
 * have the ids but not the shop names to show, nor the address to ship to.
 */
const SELECT_WITH_ORDER = `
  SELECT om.*,
         o.shopify_order_id AS destination_shopify_order_id,
         o.name             AS destination_order_name,
         o.order_number     AS destination_order_number,
         o.financial_status,
         o.fulfillment_status,
         o.cancelled_at,
         o.test,
         o.created_at       AS placed_at,
         o.customer_shopify_id,
         -- Where the goods actually go. The source is the one that ships, so
         -- without this its job cannot be done.
         o.shipping_address,
         c.source_store_id,
         c.destination_store_id,
         c.status           AS connection_status,
         src.shop_domain    AS source_shop_domain,
         src.store_name     AS source_store_name,
         dst.shop_domain    AS destination_shop_domain,
         dst.store_name     AS destination_store_name
    FROM order_mappings om
    JOIN orders o            ON o.id  = om.destination_order_id
    JOIN store_connections c ON c.id  = om.connection_id
    JOIN stores src          ON src.id = c.source_store_id
    JOIN stores dst          ON dst.id = c.destination_store_id
`;

/**
 * Record this sale for a source store, or refresh the row already recording it.
 *
 * INSERT ... ON DUPLICATE KEY against uniq_order_mapping is the whole point:
 * Shopify retries orders/create, and a redelivery must not make a second job.
 * Totals and line count ARE refreshed, because orders/updated can legitimately
 * change them -- but source_fulfillment_status is not, or a sale the source
 * has already shipped would go back to looking outstanding.
 */
async function claim(connectionId, destinationOrderId, details = {}) {
  await pool.query(
    `INSERT INTO order_mappings
       (connection_id, destination_order_id, destination_total, source_total,
        currency, line_count, source_fulfillment_status)
     VALUES (?, ?, ?, ?, ?, ?, 'unfulfilled')
     ON DUPLICATE KEY UPDATE
       destination_total = VALUES(destination_total),
       source_total      = VALUES(source_total),
       currency          = VALUES(currency),
       line_count        = VALUES(line_count)`,
    [
      connectionId,
      destinationOrderId,
      details.destinationTotal ?? null,
      details.sourceTotal ?? null,
      details.currency || null,
      Number(details.lineCount) || 0,
    ]
  );

  return findByPair(connectionId, destinationOrderId);
}

async function findByPair(connectionId, destinationOrderId) {
  const rows = await query(
    `${SELECT_WITH_ORDER}
      WHERE om.connection_id = ? AND om.destination_order_id = ?
      LIMIT 1`,
    [connectionId, destinationOrderId]
  );
  return hydrate(rows[0]);
}

async function findById(id) {
  const rows = await query(`${SELECT_WITH_ORDER} WHERE om.id = ? LIMIT 1`, [id]);
  return hydrate(rows[0]);
}

/** Every sale raised from one destination store, newest first. */
async function listForDestination(destinationStoreId, { limit = 100 } = {}) {
  const rows = await query(
    `${SELECT_WITH_ORDER}
      WHERE c.destination_store_id = ?
      ORDER BY om.id DESC
      LIMIT ?`,
    [destinationStoreId, Number(limit)]
  );
  return rows.map(hydrate);
}

/** Every sale this source store has been asked to supply, newest first. */
async function listForSource(sourceStoreId, { limit = 100 } = {}) {
  const rows = await query(
    `${SELECT_WITH_ORDER}
      WHERE c.source_store_id = ?
      ORDER BY om.id DESC
      LIMIT ?`,
    [sourceStoreId, Number(limit)]
  );
  return rows.map(hydrate);
}

/** Counts per fulfilment state for one side, for the screen tabs. */
async function statusCounts(storeId, { side = "destination" } = {}) {
  const column =
    side === "source" ? "c.source_store_id" : "c.destination_store_id";

  const rows = await query(
    `SELECT om.source_fulfillment_status AS state, COUNT(*) AS total
       FROM order_mappings om
       JOIN store_connections c ON c.id = om.connection_id
      WHERE ${column} = ?
      GROUP BY om.source_fulfillment_status`,
    [storeId]
  );

  const counts = { unfulfilled: 0, fulfilled: 0, cancelled: 0 };
  rows.forEach((row) => {
    if (row.state in counts) counts[row.state] = Number(row.total);
  });
  return counts;
}

/**
 * The source has shipped it.
 *
 * Tracking is a list because one order can go out in several parcels, and the
 * shopper needs every number rather than the first one.
 *
 * fulfil_status goes to 'pending' in the same statement: saying it shipped and
 * telling the buyer's store are one decision, and splitting them would leave a
 * gap where the source thinks it is done and the shopper has heard nothing.
 */
async function markFulfilled(id, tracking = []) {
  const parcels = (tracking || [])
    .filter((parcel) => parcel && parcel.number)
    .map((parcel) => ({
      number: String(parcel.number).slice(0, 128),
      company: parcel.company ? String(parcel.company).slice(0, 128) : null,
      url: parcel.url ? String(parcel.url).slice(0, 512) : null,
    }));

  const [result] = await pool.query(
    `UPDATE order_mappings
        SET source_fulfillment_status = 'fulfilled',
            source_tracking = ?,
            source_status_at = NOW(),
            -- Only re-queue what has not already reached Shopify. Re-marking a
            -- sale that is already fulfilled over there must not create a
            -- second fulfillment for the same goods.
            fulfil_status = IF(fulfil_status = 'fulfilled', 'fulfilled', 'pending'),
            fulfil_attempts = IF(fulfil_status = 'fulfilled', fulfil_attempts, 0),
            fulfil_error = NULL
      WHERE id = ? AND source_fulfillment_status <> 'cancelled'`,
    [parcels.length ? JSON.stringify(parcels) : null, id]
  );
  return result.affectedRows;
}

/**
 * Shipped by mistake, or the parcel came back.
 *
 * The queue is reset to 'none' but destination_fulfillment_id is deliberately
 * KEPT: if Shopify was already told, that id is the only handle on the
 * fulfillment to cancel, and losing it would strand the buyer's order as
 * fulfilled forever.
 */
async function markUnfulfilled(id) {
  const [result] = await pool.query(
    `UPDATE order_mappings
        SET source_fulfillment_status = 'unfulfilled',
            source_tracking = NULL,
            source_status_at = NOW(),
            fulfil_status = 'none',
            fulfil_attempts = 0,
            fulfil_error = NULL
      WHERE id = ? AND source_fulfillment_status <> 'cancelled'`,
    [id]
  );
  return result.affectedRows;
}

/** Fulfilments still to send to the buyer's store, oldest first. */
async function listPendingFulfilments({ limit = 50, maxAttempts = 5 } = {}) {
  const rows = await query(
    `${SELECT_WITH_ORDER}
      WHERE om.fulfil_status IN ('pending', 'failed')
        AND om.fulfil_attempts < ?
        -- A sale the source has since cancelled or reopened must not be
        -- fulfilled by a round that was already in flight.
        AND om.source_fulfillment_status = 'fulfilled'
      ORDER BY om.id
      LIMIT ?`,
    [Number(maxAttempts), Number(limit)]
  );
  return rows.map(hydrate);
}

async function markFulfilSent(id, destinationFulfillmentId) {
  const [result] = await pool.query(
    `UPDATE order_mappings
        SET fulfil_status = 'fulfilled',
            destination_fulfillment_id = ?,
            fulfil_error = NULL
      WHERE id = ?`,
    [destinationFulfillmentId || null, id]
  );
  return result.affectedRows;
}

/**
 * Record a failure and count the attempt.
 *
 * Counted HERE rather than before the call, so a crash between the two cannot
 * burn a retry that Shopify never received.
 */
async function markFulfilFailed(id, reason) {
  const [result] = await pool.query(
    `UPDATE order_mappings
        SET fulfil_status = 'failed',
            fulfil_attempts = fulfil_attempts + 1,
            fulfil_error = ?
      WHERE id = ?`,
    [reason ? String(reason).slice(0, 512) : null, id]
  );
  return result.affectedRows;
}

/** The fulfillment in the buyer's store has been cancelled; forget its id. */
async function clearDestinationFulfilment(id) {
  const [result] = await pool.query(
    `UPDATE order_mappings
        SET destination_fulfillment_id = NULL
      WHERE id = ?`,
    [id]
  );
  return result.affectedRows;
}

/**
 * The source cannot supply this at all.
 *
 * Only the bookkeeping. Cancelling the destination's real order is queued
 * separately, so that a webhook or a screen never calls Shopify inline.
 */
async function markCancelledBySource(id, reason) {
  const [result] = await pool.query(
    `UPDATE order_mappings
        SET source_fulfillment_status = 'cancelled',
            source_cancelled_at = NOW(),
            source_cancel_reason = ?,
            source_status_at = NOW()
      WHERE id = ?`,
    [reason ? String(reason).slice(0, 64) : null, id]
  );
  return result.affectedRows;
}

/**
 * Queue the destination's own order to be cancelled.
 *
 * Guarded on 'none' so a repeat request cannot ask twice -- orderCancel is
 * irreversible, and a second attempt is at best noise and at worst a second
 * refund.
 */
async function queueCancellation(id) {
  const [result] = await pool.query(
    `UPDATE order_mappings
        SET cancel_status = 'pending'
      WHERE id = ? AND cancel_status = 'none'`,
    [id]
  );
  return result.affectedRows;
}

/** Cancellations still to send, oldest first. */
async function listPendingCancellations({ limit = 50, maxAttempts = 5 } = {}) {
  const rows = await query(
    `${SELECT_WITH_ORDER}
      WHERE om.cancel_status IN ('pending', 'failed')
        AND om.cancel_attempts < ?
      ORDER BY om.id
      LIMIT ?`,
    [Number(maxAttempts), Number(limit)]
  );
  return rows.map(hydrate);
}

async function markCancelSent(id) {
  const [result] = await pool.query(
    `UPDATE order_mappings
        SET cancel_status = 'cancelled', cancel_error = NULL
      WHERE id = ?`,
    [id]
  );
  return result.affectedRows;
}

/**
 * Record a failure and count the attempt.
 *
 * Counted HERE rather than before the call, so a crash between the two cannot
 * burn a retry that Shopify never received.
 */
async function markCancelFailed(id, reason) {
  const [result] = await pool.query(
    `UPDATE order_mappings
        SET cancel_status = 'failed',
            cancel_attempts = cancel_attempts + 1,
            cancel_error = ?
      WHERE id = ?`,
    [reason ? String(reason).slice(0, 512) : null, id]
  );
  return result.affectedRows;
}

module.exports = {
  FULFILMENT_STATES,
  claim,
  findByPair,
  findById,
  listForDestination,
  listForSource,
  statusCounts,
  markFulfilled,
  markUnfulfilled,
  listPendingFulfilments,
  markFulfilSent,
  markFulfilFailed,
  clearDestinationFulfilment,
  markCancelledBySource,
  queueCancellation,
  listPendingCancellations,
  markCancelSent,
  markCancelFailed,
};
