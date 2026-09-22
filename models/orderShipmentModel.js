// models/orderShipmentModel.js
//
// `order_shipments` -- each time the source marks part (or all) of a sale as
// shipped. See the table comment in config/migrate.js.
//
// One shipment = one fulfillment on the buyer's real Shopify order, so each
// row carries its own push state and its own tracking. A sale shipped in two
// parcels a week apart is two rows, two fulfillments, two shipping emails to
// the shopper -- which is what actually happened.
const { query, pool } = require("../config/db");
const { parseJson } = require("./helpers");

/** JSON columns come back from MariaDB as strings. */
function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    // The column is shipped_lines (LINES is reserved in MariaDB); the app
    // calls it lines.
    lines: parseJson(row.shipped_lines, []) || [],
    tracking: parseJson(row.tracking, []) || [],
  };
}

/** Tracking as it is stored: only parcels with a number, trimmed to size. */
function cleanTracking(tracking) {
  return (tracking || [])
    .filter((parcel) => parcel && parcel.number)
    .map((parcel) => ({
      number: String(parcel.number).slice(0, 128),
      company: parcel.company ? String(parcel.company).slice(0, 128) : null,
      url: parcel.url ? String(parcel.url).slice(0, 512) : null,
    }));
}

/**
 * Record a shipment. `lines` is [{ line_id, quantity }], already checked by
 * the caller against what is left to ship.
 *
 * Queued for the buyer's store in the same row: saying it shipped and telling
 * the buyer are one decision, and splitting them would leave a gap where the
 * source thinks it is done and the shopper has heard nothing.
 */
async function create(mappingId, { lines, tracking = [] }) {
  const parcels = cleanTracking(tracking);

  const [result] = await pool.query(
    `INSERT INTO order_shipments (order_mapping_id, shipped_lines, tracking)
     VALUES (?, ?, ?)`,
    [
      mappingId,
      JSON.stringify(
        lines.map((line) => ({
          line_id: Number(line.line_id),
          quantity: Number(line.quantity),
        }))
      ),
      parcels.length ? JSON.stringify(parcels) : null,
    ]
  );

  return findById(result.insertId);
}

async function findById(id) {
  const rows = await query("SELECT * FROM order_shipments WHERE id = ? LIMIT 1", [id]);
  return hydrate(rows[0]);
}

/** Every shipment on a sale, oldest first -- cancelled ones included, as history. */
async function listForMapping(mappingId) {
  const rows = await query(
    "SELECT * FROM order_shipments WHERE order_mapping_id = ? ORDER BY id",
    [mappingId]
  );
  return rows.map(hydrate);
}

/**
 * How many of each line have shipped so far: Map(line_id -> quantity), over
 * every shipment that still stands. A cancelled shipment shipped nothing.
 */
async function shippedByLine(mappingId) {
  const shipments = await listForMapping(mappingId);
  const shipped = new Map();

  shipments
    .filter((shipment) => shipment.push_status !== "cancelled")
    .forEach((shipment) => {
      shipment.lines.forEach((line) => {
        const id = Number(line.line_id);
        shipped.set(id, (shipped.get(id) || 0) + Number(line.quantity));
      });
    });

  return shipped;
}

/**
 * Shipments still to send to the buyer's store, oldest first, with the sale
 * they belong to -- the push needs the buyer's shop and order.
 *
 * A sale the source has since cancelled must not be fulfilled by a round that
 * was already in flight, so it is excluded here rather than trusted to the
 * caller.
 */
async function listPending({ limit = 50, maxAttempts = 5 } = {}) {
  const rows = await query(
    `SELECT s.*,
            om.connection_id,
            om.destination_order_id,
            o.shopify_order_id AS destination_shopify_order_id,
            o.name             AS destination_order_name,
            dst.shop_domain    AS destination_shop_domain,
            dst.store_name     AS destination_store_name
       FROM order_shipments s
       JOIN order_mappings om   ON om.id  = s.order_mapping_id
       JOIN orders o            ON o.id   = om.destination_order_id
       JOIN store_connections c ON c.id   = om.connection_id
       JOIN stores dst          ON dst.id = c.destination_store_id
      WHERE s.push_status IN ('pending', 'failed')
        AND s.push_attempts < ?
        AND om.source_fulfillment_status IN ('partial', 'fulfilled')
      ORDER BY s.id
      LIMIT ?`,
    [Number(maxAttempts), Number(limit)]
  );
  return rows.map(hydrate);
}

async function markSent(id, destinationFulfillmentId) {
  const [result] = await pool.query(
    `UPDATE order_shipments
        SET push_status = 'sent',
            destination_fulfillment_id = ?,
            push_error = NULL,
            sent_at = NOW()
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
async function markFailed(id, reason) {
  const [result] = await pool.query(
    `UPDATE order_shipments
        SET push_status = 'failed',
            push_attempts = push_attempts + 1,
            push_error = ?
      WHERE id = ?`,
    [reason ? String(reason).slice(0, 512) : null, id]
  );
  return result.affectedRows;
}

/**
 * The source undid it. The row stays as history; the fulfillment id is
 * cleared because the caller has just cancelled it in the buyer's store.
 */
async function markCancelled(id) {
  const [result] = await pool.query(
    `UPDATE order_shipments
        SET push_status = 'cancelled',
            destination_fulfillment_id = NULL
      WHERE id = ?`,
    [id]
  );
  return result.affectedRows;
}

module.exports = {
  cleanTracking,
  create,
  findById,
  listForMapping,
  shippedByLine,
  listPending,
  markSent,
  markFailed,
  markCancelled,
};
