// models/orderMappingModel.js
//
// `order_mappings` -- one row per source store per destination sale.
//
// The product side of this app has product_mappings; this is the same idea for
// orders. A shopper buys in the destination store, and every source store that
// supplied something on that order needs an order of its own, priced at ITS
// own prices rather than the marked-up ones the shopper paid.
//
// A destination order with lines from two sources therefore has two rows here,
// each pushed and each failing independently.
const { query, pool } = require("../config/db");
const { toShopifyId } = require("./helpers");

const SYNC_STATUSES = ["pending", "synced", "failed", "skipped"];

/**
 * Everything the push and the Orders screen need, in one query.
 *
 * The joins are what make a row self-describing: without them a caller would
 * have the ids but not the shop domain to call, nor the order name to show.
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
 * Claim this sale for a source store, or return the row already claiming it.
 *
 * INSERT IGNORE against uniq_order_mapping is the whole point: Shopify retries
 * orders/create, and a second delivery must not place a second order at the
 * source. Totals and line count are refreshed on a repeat delivery because
 * orders/updated can legitimately change them -- but sync_status is NOT, or a
 * pushed order would go back into the queue and be placed twice.
 */
async function claim(connectionId, destinationOrderId, details = {}) {
  await pool.query(
    `INSERT INTO order_mappings
       (connection_id, destination_order_id, destination_total, source_total,
        currency, line_count)
     VALUES (?, ?, ?, ?, ?, ?)
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
  return rows[0] || null;
}

async function findById(id) {
  const rows = await query(`${SELECT_WITH_ORDER} WHERE om.id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

/**
 * What the background push should place next, oldest first.
 *
 * 'failed' is included: a source store that was briefly unreachable should
 * recover on its own. `maxAttempts` is what stops a permanently broken order
 * -- a deleted variant, say -- from being retried forever.
 */
async function listPending(connectionId, { limit = 50, maxAttempts = 5 } = {}) {
  return query(
    `${SELECT_WITH_ORDER}
      WHERE om.connection_id = ?
        AND om.sync_status IN ('pending', 'failed')
        AND om.attempts < ?
      ORDER BY om.id
      LIMIT ?`,
    [connectionId, Number(maxAttempts), Number(limit)]
  );
}

/** Every source order raised from one destination store, newest first. */
async function listForDestination(destinationStoreId, { limit = 100 } = {}) {
  return query(
    `${SELECT_WITH_ORDER}
      WHERE c.destination_store_id = ?
      ORDER BY om.id DESC
      LIMIT ?`,
    [destinationStoreId, Number(limit)]
  );
}

/** Every order this source store has been asked to fulfil, newest first. */
async function listForSource(sourceStoreId, { limit = 100 } = {}) {
  return query(
    `${SELECT_WITH_ORDER}
      WHERE c.source_store_id = ?
      ORDER BY om.id DESC
      LIMIT ?`,
    [sourceStoreId, Number(limit)]
  );
}

/** Counts per sync_status for one side of a connection, for the screen tabs. */
async function statusCounts(storeId, { side = "destination" } = {}) {
  const column =
    side === "source" ? "c.source_store_id" : "c.destination_store_id";

  const rows = await query(
    `SELECT om.sync_status, COUNT(*) AS total
       FROM order_mappings om
       JOIN store_connections c ON c.id = om.connection_id
      WHERE ${column} = ?
      GROUP BY om.sync_status`,
    [storeId]
  );

  const counts = { pending: 0, synced: 0, failed: 0, skipped: 0 };
  rows.forEach((row) => {
    counts[row.sync_status] = Number(row.total);
  });
  return counts;
}

async function markSynced(id, { sourceShopifyOrderId, sourceOrderName }) {
  const [result] = await pool.query(
    `UPDATE order_mappings
        SET sync_status = 'synced',
            source_shopify_order_id = ?,
            source_order_name = ?,
            error_message = NULL,
            last_synced_at = NOW()
      WHERE id = ?`,
    [
      toShopifyId(sourceShopifyOrderId),
      sourceOrderName ? String(sourceOrderName).slice(0, 50) : null,
      id,
    ]
  );
  return result.affectedRows;
}

/**
 * Record a failure and count the attempt.
 *
 * attempts is incremented HERE rather than before the call, so a crash between
 * the two cannot burn a retry the source never actually received.
 */
async function markFailed(id, reason) {
  const [result] = await pool.query(
    `UPDATE order_mappings
        SET sync_status = 'failed',
            attempts = attempts + 1,
            error_message = ?
      WHERE id = ?`,
    [reason ? String(reason).slice(0, 512) : null, id]
  );
  return result.affectedRows;
}

/**
 * Nothing on this order belongs to this source any more, or the connection is
 * paused. Skipped is a resting state, not a failure: it is not retried.
 */
async function markSkipped(id, reason) {
  const [result] = await pool.query(
    `UPDATE order_mappings
        SET sync_status = 'skipped', error_message = ?
      WHERE id = ?`,
    [reason ? String(reason).slice(0, 512) : null, id]
  );
  return result.affectedRows;
}

/** Put a failed order back in the queue, and give it its attempts back. */
async function requeue(id) {
  const [result] = await pool.query(
    `UPDATE order_mappings
        SET sync_status = 'pending', attempts = 0, error_message = NULL
      WHERE id = ? AND sync_status <> 'synced'`,
    [id]
  );
  return result.affectedRows;
}

module.exports = {
  SYNC_STATUSES,
  claim,
  findByPair,
  findById,
  listPending,
  listForDestination,
  listForSource,
  statusCounts,
  markSynced,
  markFailed,
  markSkipped,
  requeue,
};
