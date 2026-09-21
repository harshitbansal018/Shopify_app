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
const FULFILMENT_STATES = ["unfulfilled", "partial", "fulfilled", "cancelled"];

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

/**
 * The WHERE that both screens share, built from the same options.
 *
 * `tab` is narrowed in SQL rather than by the caller because the screens page:
 * filtering an already-read page of fifteen leaves however many happened to
 * match, and the rest of that tab is simply never reachable.
 *
 *   open   still on the source to pick and ship, wholly or in part
 *   done   fulfilled or cancelled -- settled either way
 */
function scopeFor(column, storeId, { tab = null, connectionId = null } = {}) {
  const params = [storeId];
  let where = `WHERE ${column} = ?`;

  // A partly shipped sale is still open: there is more to send.
  if (tab === "open") where += " AND om.source_fulfillment_status IN ('unfulfilled', 'partial')";
  if (tab === "done") where += " AND om.source_fulfillment_status IN ('fulfilled', 'cancelled')";

  if (connectionId !== null && connectionId !== undefined) {
    where += " AND om.connection_id = ?";
    params.push(Number(connectionId));
  }

  return { where, params };
}

/** Every sale raised from one destination store, newest first. */
async function listForDestination(
  destinationStoreId,
  { limit = 100, offset = 0, tab = null, connectionId = null } = {}
) {
  const scope = scopeFor("c.destination_store_id", destinationStoreId, {
    tab,
    connectionId,
  });

  const rows = await query(
    `${SELECT_WITH_ORDER}
      ${scope.where}
      ORDER BY om.id DESC
      LIMIT ? OFFSET ?`,
    [...scope.params, Number(limit), Number(offset)]
  );
  return rows.map(hydrate);
}

/** Every sale this source store has been asked to supply, newest first. */
async function listForSource(
  sourceStoreId,
  { limit = 100, offset = 0, tab = null, connectionId = null } = {}
) {
  const scope = scopeFor("c.source_store_id", sourceStoreId, {
    tab,
    connectionId,
  });

  const rows = await query(
    `${SELECT_WITH_ORDER}
      ${scope.where}
      ORDER BY om.id DESC
      LIMIT ? OFFSET ?`,
    [...scope.params, Number(limit), Number(offset)]
  );
  return rows.map(hydrate);
}

/**
 * How many sales match, without reading them.
 *
 * The joins stay: `side` is a column on store_connections, so dropping them
 * would leave nothing to scope by and count every store's orders.
 */
async function countForStore(
  storeId,
  { side = "destination", tab = null, connectionId = null } = {}
) {
  const column =
    side === "source" ? "c.source_store_id" : "c.destination_store_id";

  const scope = scopeFor(column, storeId, { tab, connectionId });

  const rows = await query(
    `SELECT COUNT(*) AS total
       FROM order_mappings om
       JOIN store_connections c ON c.id = om.connection_id
      ${scope.where}`,
    scope.params
  );

  return Number(rows[0] ? rows[0].total : 0);
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

  const counts = { unfulfilled: 0, partial: 0, fulfilled: 0, cancelled: 0 };
  rows.forEach((row) => {
    if (row.state in counts) counts[row.state] = Number(row.total);
  });
  return counts;
}

/* ------------------------------------------------------------------ */
/* Shipping                                                            */
/* ------------------------------------------------------------------ */

/**
 * The sale's overall state, set from what its shipments add up to.
 *
 *   unfulfilled  nothing shipped
 *   partial      some lines or quantities shipped, some still to go
 *   fulfilled    everything shipped
 *
 * Only these three: 'cancelled' is set by markCancelledBySource and is a
 * one-way door -- a cancelled sale has been refunded, and nothing shipped
 * afterwards can change that.
 */
async function setSourceStatus(id, status) {
  if (!["unfulfilled", "partial", "fulfilled"].includes(status)) {
    throw new Error(`Not a shipping state: ${status}`);
  }

  const [result] = await pool.query(
    `UPDATE order_mappings
        SET source_fulfillment_status = ?,
            source_status_at = NOW()
      WHERE id = ? AND source_fulfillment_status <> 'cancelled'`,
    [status, id]
  );
  return result.affectedRows;
}

/**
 * The source has shipped ALL of it, in one go.
 *
 * Kept for callers that only ever ship whole sales (and for the old tests);
 * the request handler ships by line through services/orderSync.recordShipment,
 * which this delegates to.
 */
async function markFulfilled(id, tracking = []) {
  const shipped = await require("../services/orderSync").recordShipment(id, {
    tracking,
  });
  return shipped ? 1 : 0;
}

/**
 * Shipped by mistake, or the parcel came back: back to unfulfilled.
 *
 * Only the sale's own state. The shipments themselves are cancelled by the
 * caller, one by one, AFTER each fulfillment in the buyer's store has been
 * cancelled -- see services/orderSync.reopen. Doing it here would forget the
 * fulfillment ids that are the only handle on those.
 */
async function markUnfulfilled(id) {
  return setSourceStatus(id, "unfulfilled");
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
  countForStore,
  statusCounts,
  setSourceStatus,
  markFulfilled,
  markUnfulfilled,
  markCancelledBySource,
  queueCancellation,
  listPendingCancellations,
  markCancelSent,
  markCancelFailed,
};
