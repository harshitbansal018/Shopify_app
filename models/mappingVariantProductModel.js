// models/mappingVariantProductModel.js
//
// `mapping_variant_products` -- variants that have ALREADY been synced to a
// destination store.
//
// The pair of variant tables, and which side each describes:
//   source_variant_mappings    what exists at the SOURCE store
//   mapping_variant_products   what exists at the DESTINATION, and which
//                              source variant it came from
//
// One row per connection per variant, with the source Shopify id denormalised
// so a sync can look a variant up without a join. The stored id pair is why
// variants are never matched by title or position -- rename "Small" to "S" at
// either end and the two ids still point at each other.
const { query, pool } = require("../config/db");
const { toShopifyId } = require("./helpers");

const UPSERT_SQL = `
  INSERT INTO mapping_variant_products
    (product_mapping_id, source_variant_mapping_id, source_shopify_variant_id,
     destination_variant_id, destination_inventory_item_id, sku, last_synced_at)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    source_variant_mapping_id = VALUES(source_variant_mapping_id),
    -- COALESCE, not VALUES(): an update that does not know the destination id
    -- must not erase the one already recorded.
    destination_variant_id =
      COALESCE(VALUES(destination_variant_id), destination_variant_id),
    destination_inventory_item_id =
      COALESCE(VALUES(destination_inventory_item_id), destination_inventory_item_id),
    sku = VALUES(sku),
    last_synced_at = VALUES(last_synced_at)
`;

/**
 * Record the variant pairs returned by a create or update on the destination.
 *
 * Each pair needs `sourceVariantMappingId` (our row in source_variant_mappings)
 * and `sourceShopifyVariantId` (the id Shopify uses).
 */
async function upsertMany(productMappingId, pairs, { markSynced = true } = {}) {
  const syncedAt = markSynced ? new Date() : null;

  const rows = (pairs || [])
    .filter((pair) => pair && pair.sourceVariantMappingId && pair.sourceShopifyVariantId)
    .map((pair) => [
      productMappingId,
      pair.sourceVariantMappingId,
      toShopifyId(pair.sourceShopifyVariantId),
      toShopifyId(pair.destinationVariantId),
      toShopifyId(pair.destinationInventoryItemId),
      pair.sku ? String(pair.sku).slice(0, 255) : null,
      syncedAt,
    ]);

  if (!rows.length) return 0;

  await pool.query(UPSERT_SQL, [rows]);
  return rows.length;
}

/**
 * Synced variants for a whole page of mappings at once, grouped by mapping id,
 * joined to the source variant so the destination table can show what each row
 * originally was. One query per screen rather than one per product.
 */
async function mapForMappings(productMappingIds) {
  const ids = [...new Set((productMappingIds || []).map(Number).filter(Boolean))];
  const grouped = new Map();

  if (!ids.length) return grouped;

  const rows = await query(
    `SELECT mvp.*,
            svm.title AS source_title,
            svm.price AS source_price,
            svm.option1, svm.option2, svm.option3,
            svm.inventory_quantity
       FROM mapping_variant_products mvp
       LEFT JOIN source_variant_mappings svm
              ON svm.id = mvp.source_variant_mapping_id
      WHERE mvp.product_mapping_id IN (?)
      ORDER BY mvp.product_mapping_id, svm.position, mvp.id`,
    [ids]
  );

  rows.forEach((row) => {
    if (!grouped.has(row.product_mapping_id)) grouped.set(row.product_mapping_id, []);
    grouped.get(row.product_mapping_id).push(row);
  });

  return grouped;
}

async function listForMapping(productMappingId) {
  return query(
    `SELECT * FROM mapping_variant_products
      WHERE product_mapping_id = ?
      ORDER BY id`,
    [productMappingId]
  );
}

/**
 * The link rows joined to their cached source variants -- everything needed to
 * build an update payload in one query.
 */
async function listWithSourceVariants(productMappingId) {
  return query(
    `SELECT mvp.*,
            sv.sku AS source_sku, sv.title AS source_title,
            sv.price AS source_price, sv.compare_at_price AS source_compare_at_price,
            sv.option1, sv.option2, sv.option3,
            sv.inventory_quantity AS source_inventory_quantity,
            sv.position AS source_position
       FROM mapping_variant_products mvp
       JOIN source_variant_mappings sv
         ON sv.id = mvp.source_variant_mapping_id
      WHERE mvp.product_mapping_id = ?
      ORDER BY sv.position, mvp.id`,
    [productMappingId]
  );
}

async function findBySourceVariant(productMappingId, sourceShopifyVariantId) {
  const rows = await query(
    `SELECT * FROM mapping_variant_products
      WHERE product_mapping_id = ? AND source_shopify_variant_id = ?
      LIMIT 1`,
    [productMappingId, toShopifyId(sourceShopifyVariantId)]
  );
  return rows[0] || null;
}

/** Source Shopify variant id -> link row, for O(1) lookup during a sync. */
async function mapBySourceVariant(productMappingId) {
  const rows = await listForMapping(productMappingId);
  const index = new Map();
  rows.forEach((row) => index.set(String(row.source_shopify_variant_id), row));
  return index;
}

/** Link rows whose source variant has gone; their pairs are meaningless now. */
async function removeMissing(productMappingId, keepSourceShopifyVariantIds) {
  const keep = (keepSourceShopifyVariantIds || []).map(toShopifyId).filter(Boolean);

  if (!keep.length) {
    const [all] = await pool.query(
      "DELETE FROM mapping_variant_products WHERE product_mapping_id = ?",
      [productMappingId]
    );
    return all.affectedRows;
  }

  const [result] = await pool.query(
    `DELETE FROM mapping_variant_products
      WHERE product_mapping_id = ? AND source_shopify_variant_id NOT IN (?)`,
    [productMappingId, keep]
  );
  return result.affectedRows;
}

async function countForMapping(productMappingId) {
  const rows = await query(
    "SELECT COUNT(*) AS total FROM mapping_variant_products WHERE product_mapping_id = ?",
    [productMappingId]
  );
  return Number(rows[0] ? rows[0].total : 0);
}

/** Variants that exist at the source but have never reached the destination. */
async function listUnsynced(productMappingId) {
  return query(
    `SELECT * FROM mapping_variant_products
      WHERE product_mapping_id = ? AND destination_variant_id IS NULL
      ORDER BY id`,
    [productMappingId]
  );
}

module.exports = {
  upsertMany,
  listForMapping,
  mapForMappings,
  listWithSourceVariants,
  findBySourceVariant,
  mapBySourceVariant,
  removeMissing,
  countForMapping,
  listUnsynced,
};
