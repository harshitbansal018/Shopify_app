// models/productMappingModel.js
//
// The link between one source product and its copy on one destination store.
// The same source product has a separate mapping per connection, which is why
// the unique key is (connection_id, source_shopify_product_id).
const { query, pool } = require("../config/db");
const { parseJson, toShopifyId, toDate } = require("./helpers");

const SYNC_STATUSES = ["pending", "synced", "failed", "skipped", "deleted"];

function hydrate(row) {
  if (!row) return null;

  const mapping = { ...row };

  // Present when the row came from a join with source_products.
  if ("product_data" in row) {
    mapping.product_data = parseJson(row.product_data, null);
  }

  // NULL stays NULL on purpose: it means "every variant", which an empty
  // array would quietly turn into "no variants at all".
  mapping.allowed_variant_ids =
    row.allowed_variant_ids === null || row.allowed_variant_ids === undefined
      ? null
      : parseJson(row.allowed_variant_ids, null);

  return mapping;
}

/**
 * Normalise a variant selection into what the column stores.
 *
 * null  -> every variant, now and in future
 * [...] -> exactly these source_variant_mappings ids
 */
function toAllowedVariants(ids) {
  if (ids === null || ids === undefined) return null;

  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);

  return list.length ? JSON.stringify(list) : null;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** The hot path during a sync: one indexed lookup, no join. */
async function findBySourceProductId(connectionId, sourceShopifyProductId) {
  const rows = await query(
    `SELECT * FROM product_mappings
      WHERE connection_id = ? AND source_shopify_product_id = ?
      LIMIT 1`,
    [connectionId, toShopifyId(sourceShopifyProductId)]
  );
  return hydrate(rows[0]);
}

async function findById(id) {
  const rows = await query("SELECT * FROM product_mappings WHERE id = ? LIMIT 1", [
    id,
  ]);
  return hydrate(rows[0]);
}

/**
 * The mappings that produced a given product IN a destination store.
 *
 * Scoped by store because a destination product id is only unique within its
 * own shop -- two different destinations can both hold product #700.
 */
async function findByDestinationProductId(destinationStoreId, destinationProductId) {
  const rows = await query(
    `SELECT m.* FROM product_mappings m
       JOIN store_connections c ON c.id = m.connection_id
      WHERE c.destination_store_id = ?
        AND m.destination_shopify_product_id = ?`,
    [destinationStoreId, toShopifyId(destinationProductId)]
  );
  return rows.map(hydrate);
}

/**
 * The destination's own merchant deleted the product we created there.
 *
 * Treated as a withdrawal, not as damage to repair: the link to a product that
 * no longer exists is cleared and the offer goes back to "waiting for you".
 * Re-creating it on the next sync would keep overruling a deliberate deletion.
 */
async function markGoneFromDestination(id) {
  await query(
    `UPDATE product_mappings
        SET destination_shopify_product_id = NULL,
            accepted_at = NULL,
            sync_status = IF(sync_status = 'deleted', 'deleted', 'skipped'),
            last_synced_at = NULL
      WHERE id = ?`,
    [id]
  );

  return findById(id);
}

/** Every connection that already carries this source product. */
async function listForSourceProduct(sourceProductId) {
  const rows = await query(
    "SELECT * FROM product_mappings WHERE source_product_id = ?",
    [sourceProductId]
  );
  return rows.map(hydrate);
}

/**
 * The connection detail table: mappings joined to the cached source product so
 * a title can be shown without a second query.
 */
async function listForConnection(
  connectionId,
  { limit = 50, offset = 0, status = null, acceptedOnly = false } = {}
) {
  const params = [connectionId];
  let where = "";

  if (status && SYNC_STATUSES.includes(status)) {
    where += " AND m.sync_status = ?";
    params.push(status);
  }

  // The push uses this: a product the destination has not accepted must never
  // be written to their store, however the source has marked it.
  if (acceptedOnly) where += " AND m.accepted_at IS NOT NULL";

  params.push(Number(limit), Number(offset));

  const rows = await query(
    `SELECT m.*,
            sp.title, sp.handle, sp.vendor, sp.product_type, sp.status AS source_status
       FROM product_mappings m
       JOIN source_products sp ON sp.id = m.source_product_id
      WHERE m.connection_id = ?${where}
      ORDER BY m.id DESC
      LIMIT ? OFFSET ?`,
    params
  );
  return rows.map(hydrate);
}

/**
 * The destination agreeing to receive these products.
 *
 * Scoped by destination store rather than by mapping id alone: the ids come
 * from a browser, and one store must not be able to accept products into
 * another store by guessing numbers.
 *
 * Already-accepted rows keep their original timestamp, so re-ticking a product
 * does not rewrite when it was first agreed to.
 */
async function acceptForDestination(destinationStoreId, mappingIds) {
  const ids = [...new Set((mappingIds || []).map(Number))].filter(
    (id) => Number.isInteger(id) && id > 0
  );

  if (!ids.length) return 0;

  const [result] = await pool.query(
    `UPDATE product_mappings m
       JOIN store_connections c ON c.id = m.connection_id
        SET m.accepted_at = NOW(),
            m.sync_status = IF(m.sync_status = 'deleted', 'deleted', 'pending')
      WHERE m.id IN (?)
        AND c.destination_store_id = ?
        AND m.accepted_at IS NULL`,
    [ids, destinationStoreId]
  );

  return result.affectedRows;
}

/** The destination changing its mind. The product stops receiving updates. */
async function declineForDestination(destinationStoreId, mappingIds) {
  const ids = [...new Set((mappingIds || []).map(Number))].filter(
    (id) => Number.isInteger(id) && id > 0
  );

  if (!ids.length) return 0;

  const [result] = await pool.query(
    `UPDATE product_mappings m
       JOIN store_connections c ON c.id = m.connection_id
        SET m.accepted_at = NULL,
            -- 'deleted' is a one-way door: the product is gone at the source,
            -- and letting decline downgrade it to 'skipped' would let a later
            -- accept turn it back into 'pending' and resurrect it.
            m.sync_status = IF(m.sync_status = 'deleted', 'deleted', 'skipped')
      WHERE m.id IN (?) AND c.destination_store_id = ?`,
    [ids, destinationStoreId]
  );

  return result.affectedRows;
}

async function countForConnection(connectionId, status = null) {
  const params = [connectionId];
  let statusClause = "";

  if (status && SYNC_STATUSES.includes(status)) {
    statusClause = " AND sync_status = ?";
    params.push(status);
  }

  const rows = await query(
    `SELECT COUNT(*) AS total FROM product_mappings
      WHERE connection_id = ?${statusClause}`,
    params
  );
  return Number(rows[0] ? rows[0].total : 0);
}

/** Counts per sync_status, for the connection summary. */
async function statusBreakdown(connectionId) {
  const rows = await query(
    `SELECT sync_status, COUNT(*) AS total
       FROM product_mappings
      WHERE connection_id = ?
      GROUP BY sync_status`,
    [connectionId]
  );

  const breakdown = Object.fromEntries(SYNC_STATUSES.map((s) => [s, 0]));
  rows.forEach((row) => {
    breakdown[row.sync_status] = Number(row.total);
  });
  return breakdown;
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Create the mapping, or return the existing one. Written as an upsert so two
 * concurrent syncs on the same connection cannot both insert.
 */
async function ensure({
  connectionId,
  sourceProductId,
  sourceShopifyProductId,
  sourceUpdatedAt = null,
  allowedVariantIds = null,
}) {
  await pool.query(
    `INSERT INTO product_mappings
       (connection_id, source_product_id, source_shopify_product_id,
        sync_status, source_updated_at, allowed_variant_ids)
     VALUES (?, ?, ?, 'pending', ?, ?)
     ON DUPLICATE KEY UPDATE
       source_product_id = VALUES(source_product_id),
       -- COALESCE, not VALUES(): allowing a product again from the table sends
       -- no variant selection, and that must not wipe out one made on the
       -- product's own page. Widening back to all is resetAllowedVariants...'s
       -- job, which says so explicitly.
       allowed_variant_ids =
         COALESCE(VALUES(allowed_variant_ids), allowed_variant_ids),
       -- Re-allowing a product queues it again: the selection may have
       -- changed, and a 'synced' row would otherwise never be pushed.
       sync_status = IF(sync_status = 'deleted', 'deleted', 'pending')`,
    [
      connectionId,
      sourceProductId,
      toShopifyId(sourceShopifyProductId),
      toDate(sourceUpdatedAt),
      toAllowedVariants(allowedVariantIds),
    ]
  );

  return findBySourceProductId(connectionId, sourceShopifyProductId);
}

/**
 * Queue a product for another push, on every connection that carries it.
 *
 * Called when the cached source product is refreshed: the destination now
 * holds older data than we do, and without this the merchant would have to
 * know to re-allow the product before anything moved -- which is not something
 * a screen ever tells them.
 *
 * 'deleted' is left alone: that product is gone at the source, and re-pushing
 * it would resurrect it.
 */
async function requeueForSourceProduct(sourceProductId) {
  const [result] = await pool.query(
    `UPDATE product_mappings
        SET sync_status = 'pending'
      WHERE source_product_id = ?
        AND sync_status <> 'deleted'`,
    [sourceProductId]
  );

  return result.affectedRows;
}

/**
 * Push one selection onto every live mapping of a product.
 *
 * The picker edits the product's own choice; this carries it onto the mappings,
 * which is what the push reads. Without it an already-shared product would keep
 * sending yesterday's variants.
 */
async function setAllowedVariantsForProduct(sourceProductId, ids) {
  const mappings = await listForSourceProduct(sourceProductId);
  let changed = 0;

  for (const mapping of mappings) {
    // 'deleted' is a one-way door -- the product is gone at the source.
    if (mapping.sync_status === "deleted") continue;

    await setAllowedVariants(mapping.id, ids);
    changed += 1;
  }

  return changed;
}

/**
 * Widen a product back to ALL its variants, on every connection.
 *
 * The Products table hides variants that are not shared, so once a product is
 * narrowed there is no checkbox left to tick the others back on. This is the
 * way out of that: without it, a mistaken selection could only be undone in
 * the database.
 */
async function resetAllowedVariantsForProduct(sourceProductId) {
  const [result] = await pool.query(
    `UPDATE product_mappings
        SET allowed_variant_ids = NULL,
            sync_status = IF(sync_status = 'deleted', 'deleted', 'pending')
      WHERE source_product_id = ?
        AND allowed_variant_ids IS NOT NULL`,
    [sourceProductId]
  );

  return result.affectedRows;
}

/**
 * Stop sharing ONE variant of a product, on every connection.
 *
 * A mapping with no selection means "every variant", so removing one has to
 * write out the remaining list explicitly -- there is no way to say "all
 * except this" in the column.
 *
 * Refuses to empty a product: a product with no variants cannot be pushed, and
 * productSet would strip the destination's copy down to nothing. Removing the
 * last variant is what Delete on the product itself is for.
 */
async function removeAllowedVariant(sourceProductId, variantId, allVariantIds) {
  const removing = Number(variantId);
  const every = (allVariantIds || []).map(Number);

  const mappings = await listForSourceProduct(sourceProductId);
  let changed = 0;

  for (const mapping of mappings) {
    if (mapping.sync_status === "deleted") continue;

    const current = mapping.allowed_variant_ids
      ? mapping.allowed_variant_ids.map(Number)
      : every;

    const next = current.filter((id) => id !== removing);

    if (next.length === current.length) continue; // was not shared anyway

    if (!next.length) {
      const error = new Error(
        "This is the only variant being shared. Delete the product instead."
      );
      error.statusCode = 409;
      throw error;
    }

    await setAllowedVariants(mapping.id, next);
    changed += 1;
  }

  return changed;
}

/**
 * Queue everything on one connection for another push.
 *
 * Used when the connection's sync settings change: those only take effect on
 * the next push, so without this a merchant would turn a field off and see
 * nothing happen until the source next touched the product.
 */
async function requeueForConnection(connectionId) {
  const [result] = await pool.query(
    `UPDATE product_mappings
        SET sync_status = 'pending'
      WHERE connection_id = ?
        AND sync_status = 'synced'
        AND accepted_at IS NOT NULL`,
    [connectionId]
  );

  return result.affectedRows;
}

/** Change which variants may go out, without touching anything else. */
async function setAllowedVariants(id, ids) {
  await query(
    `UPDATE product_mappings
        SET allowed_variant_ids = ?,
            sync_status = IF(sync_status = 'deleted', 'deleted', 'pending')
      WHERE id = ?`,
    [toAllowedVariants(ids), id]
  );

  return findById(id);
}

/** A successful create or update on the destination. */
async function markSynced(id, { destinationProductId, sourceUpdatedAt }) {
  await query(
    `UPDATE product_mappings
        SET destination_shopify_product_id = COALESCE(?, destination_shopify_product_id),
            sync_status = 'synced',
            source_updated_at = COALESCE(?, source_updated_at),
            last_synced_at = NOW(),
            error_message = NULL
      WHERE id = ?`,
    [toShopifyId(destinationProductId), toDate(sourceUpdatedAt), id]
  );
}

/**
 * One product failed. The message is truncated because a Shopify error body
 * can be very large and this column is read in a list view.
 */
async function markFailed(id, errorMessage) {
  await query(
    `UPDATE product_mappings
        SET sync_status = 'failed', error_message = ?
      WHERE id = ?`,
    [String(errorMessage || "Unknown error").slice(0, 2000), id]
  );
}

async function markSkipped(id) {
  await query(
    "UPDATE product_mappings SET sync_status = 'skipped' WHERE id = ?",
    [id]
  );
}

/**
 * Product removed at the source. The row is KEPT -- it records that this
 * product once existed and what it became on the destination, which a hard
 * delete would lose.
 */
async function markDeleted(id) {
  await query(
    `UPDATE product_mappings
        SET sync_status = 'deleted', last_synced_at = NOW()
      WHERE id = ?`,
    [id]
  );
}

module.exports = {
  SYNC_STATUSES,
  findBySourceProductId,
  findByDestinationProductId,
  findById,
  markGoneFromDestination,
  listForSourceProduct,
  listForConnection,
  countForConnection,
  statusBreakdown,
  toAllowedVariants,
  ensure,
  setAllowedVariants,
  setAllowedVariantsForProduct,
  removeAllowedVariant,
  resetAllowedVariantsForProduct,
  requeueForSourceProduct,
  requeueForConnection,
  acceptForDestination,
  declineForDestination,
  markSynced,
  markFailed,
  markSkipped,
  markDeleted,
};
