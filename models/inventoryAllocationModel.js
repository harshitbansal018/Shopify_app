// Virtual selling limits, split by destination and source variant.
//
// `allocated_quantity` is the size of the destination's selling limit. Sales
// are deliberately not written back into this row: remaining stock is derived
// from the current, non-cancelled destination order lines. That makes Shopify
// webhook retries and order edits idempotent by construction.
const { query, pool } = require("../config/db");
const { parseJson, toJsonColumn } = require("./helpers");

function hydrate(row) {
  if (!row) return null;

  const allocated = Number(row.allocated_quantity || 0);
  const sold = Number(row.sold_quantity || 0);

  return {
    ...row,
    allocated_quantity: allocated,
    sold_quantity: sold,
    remaining_quantity: Math.max(allocated - sold, 0),
    location_allocations: parseJson(row.location_allocations, []) || [],
    resume_quantity:
      row.resume_quantity === null || row.resume_quantity === undefined
        ? null
        : Number(row.resume_quantity),
  };
}

const WITH_SALES = `
  SELECT ia.*,
         COALESCE((
           SELECT SUM(li.quantity)
             FROM order_line_items li
             JOIN orders o ON o.id = li.order_id
             JOIN mapping_variant_products mvp ON mvp.id = li.mapped_variant_id
             JOIN product_mappings pm ON pm.id = mvp.product_mapping_id
            WHERE pm.connection_id = ia.connection_id
              AND mvp.source_variant_mapping_id = ia.source_variant_mapping_id
              AND (o.cancelled_at IS NULL OR o.inventory_restock = 0)
         ), 0) AS sold_quantity
    FROM inventory_allocations ia
`;

async function listForConnectionProduct(connectionId, sourceProductId) {
  const rows = await query(
    `${WITH_SALES}
      JOIN source_variant_mappings svm
        ON svm.id = ia.source_variant_mapping_id
     WHERE ia.connection_id = ? AND svm.source_product_id = ?
     ORDER BY svm.position, svm.id`,
    [connectionId, sourceProductId]
  );

  return rows.map(hydrate);
}

async function listForProduct(sourceProductId) {
  const rows = await query(
    `${WITH_SALES}
      JOIN source_variant_mappings svm
        ON svm.id = ia.source_variant_mapping_id
     WHERE svm.source_product_id = ?
     ORDER BY ia.connection_id, svm.position, svm.id`,
    [sourceProductId]
  );

  return rows.map(hydrate);
}

async function mapAllocatedForProducts(sourceProductIds) {
  const ids = [...new Set((sourceProductIds || []).map(Number).filter(Boolean))];
  const grouped = new Map();
  if (!ids.length) return grouped;

  const rows = await query(
    `SELECT svm.source_product_id,
            COALESCE(SUM(ia.allocated_quantity), 0) AS total_allocated
       FROM inventory_allocations ia
       JOIN source_variant_mappings svm ON svm.id = ia.source_variant_mapping_id
      WHERE svm.source_product_id IN (?)
      GROUP BY svm.source_product_id`,
    [ids]
  );

  rows.forEach((row) => {
    grouped.set(Number(row.source_product_id), Number(row.total_allocated || 0));
  });

  return grouped;
}

async function listForConnection(connectionId) {
  const rows = await query(
    `${WITH_SALES}
     WHERE ia.connection_id = ?
     ORDER BY ia.source_variant_mapping_id`,
    [connectionId]
  );

  return rows.map(hydrate);
}

async function remainingMap(connectionId, sourceProductId) {
  const rows = await listForConnectionProduct(connectionId, sourceProductId);
  return new Map(
    rows.map((row) => [Number(row.source_variant_mapping_id), row.remaining_quantity])
  );
}

/** Divide physical availability across destination limits in stable id order.
 * This never changes a saved limit: replenishment makes it available again.
 */
async function sellableMap(connectionId, sourceProductId) {
  const [variants, rows] = await Promise.all([
    query("SELECT id, inventory_quantity FROM source_variant_mappings WHERE source_product_id = ?", [sourceProductId]),
    listForProduct(sourceProductId),
  ]);
  const result = new Map();
  for (const variant of variants) {
    const levels = await query("SELECT location_id, available FROM source_inventory_levels WHERE source_variant_id = ?", [variant.id]);
    const capacity = new Map();
    for (const level of levels) {
      const pending = await require("../services/sourceInventory").pendingUnits(pool, variant.id, level.location_id);
      capacity.set(level.location_id, Math.max(Number(level.available) - pending, 0));
    }
    const pools = rows.filter((row) => Number(row.source_variant_mapping_id) === Number(variant.id))
      .sort((a, b) => Number(a.id) - Number(b.id));
    result.set(Number(variant.id), 0);
    if (pools.some((row) => Number(row.legacy_reserved))) continue;
    for (const row of pools) {
      const location = row.source_location_id || (levels.length === 1 ? levels[0].location_id : null);
      const available = capacity.get(location) || 0;
      const quantity = row.resume_quantity == null ? Math.min(row.remaining_quantity, available) : 0;
      capacity.set(location, available - quantity);
      if (Number(row.connection_id) === Number(connectionId)) result.set(Number(variant.id), quantity);
    }
  }
  return result;
}

/** Allocations for a destination products page, grouped in one query. */
async function mapForMappings(productMappingIds) {
  const ids = [...new Set((productMappingIds || []).map(Number).filter(Boolean))];
  const grouped = new Map();
  if (!ids.length) return grouped;

  const rows = await query(
    `SELECT pm.id AS product_mapping_id, ia.*,
            COALESCE((
              SELECT SUM(li.quantity)
                FROM order_line_items li
                JOIN orders o ON o.id = li.order_id
                JOIN mapping_variant_products sold_mvp
                  ON sold_mvp.id = li.mapped_variant_id
                JOIN product_mappings sold_pm
                  ON sold_pm.id = sold_mvp.product_mapping_id
               WHERE sold_pm.connection_id = ia.connection_id
                 AND sold_mvp.source_variant_mapping_id = ia.source_variant_mapping_id
                 AND (o.cancelled_at IS NULL OR o.inventory_restock = 0)
            ), 0) AS sold_quantity
       FROM product_mappings pm
       JOIN inventory_allocations ia ON ia.connection_id = pm.connection_id
       JOIN source_variant_mappings svm
         ON svm.id = ia.source_variant_mapping_id
        AND svm.source_product_id = pm.source_product_id
      WHERE pm.id IN (?)
      ORDER BY pm.id, svm.position, svm.id`,
    [ids]
  );

  rows.forEach((row) => {
    if (!grouped.has(row.product_mapping_id)) grouped.set(row.product_mapping_id, []);
    grouped.get(row.product_mapping_id).push(hydrate(row));
  });
  return grouped;
}

async function upsertMany(
  executor,
  connectionId,
  allocations,
  { preserveResume = false } = {}
) {
  if (!allocations.length) return 0;

  const values = allocations.map((allocation) => [
    connectionId,
    allocation.sourceVariantId,
    allocation.quantity,
    toJsonColumn(allocation.locations || []),
    0,
    allocation.sourceLocationId || null,
  ]);

  const [result] = await executor.query(
    `INSERT INTO inventory_allocations
       (connection_id, source_variant_mapping_id, allocated_quantity,
        location_allocations, legacy_reserved, source_location_id)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       ${preserveResume
         ? "resume_quantity = COALESCE(resume_quantity, allocated_quantity),"
         : "resume_quantity = NULL,"}
       source_location_id = COALESCE(VALUES(source_location_id), source_location_id),
       legacy_reserved = 0,
       allocated_quantity = VALUES(allocated_quantity),
       location_allocations = VALUES(location_allocations),
       updated_at = CURRENT_TIMESTAMP`,
    [values]
  );

  return result.affectedRows;
}

async function listToResume(connectionId, sourceProductId) {
  const rows = await query(
    `${WITH_SALES}
      JOIN source_variant_mappings svm
        ON svm.id = ia.source_variant_mapping_id
     WHERE ia.connection_id = ?
       AND svm.source_product_id = ?
       AND ia.resume_quantity IS NOT NULL
     ORDER BY svm.position, svm.id`,
    [connectionId, sourceProductId]
  );
  return rows.map(hydrate);
}

async function lockedForVariants(executor, connectionId, variantIds) {
  if (!variantIds.length) return [];

  const [rows] = await executor.query(
    `SELECT ia.*,
            COALESCE((
              SELECT SUM(li.quantity)
                FROM order_line_items li
                JOIN orders o ON o.id = li.order_id
                JOIN mapping_variant_products mvp ON mvp.id = li.mapped_variant_id
                JOIN product_mappings pm ON pm.id = mvp.product_mapping_id
               WHERE pm.connection_id = ia.connection_id
                 AND mvp.source_variant_mapping_id = ia.source_variant_mapping_id
                 AND (o.cancelled_at IS NULL OR o.inventory_restock = 0)
            ), 0) AS sold_quantity
       FROM inventory_allocations ia
      WHERE ia.connection_id = ? AND ia.source_variant_mapping_id IN (?)
      FOR UPDATE`,
    [connectionId, variantIds]
  );

  return rows.map(hydrate);
}

module.exports = {
  hydrate,
  listForConnectionProduct,
  listForProduct,
  mapAllocatedForProducts,
  listForConnection,
  remainingMap,
  sellableMap,
  mapForMappings,
  upsertMany,
  listToResume,
  lockedForVariants,
  pool,
};
