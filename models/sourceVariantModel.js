// models/sourceVariantModel.js
//
// `source_variant_mappings` -- the variants of a cached source product.
//
// This is to source_products what source_products is to the source store: a
// local copy of what exists upstream. Keeping variants as rows rather than
// only inside the product_data JSON means they can be looked up by SKU and
// compared field by field to decide whether a sync actually needs to write
// anything.
const { query, pool } = require("../config/db");
const { toShopifyId } = require("./helpers");

/**
 * Map a raw Shopify variant onto our columns.
 * Accepts REST (`option1`, `inventory_item_id`) and GraphQL-ish shapes.
 */
function fromShopify(sourceProductId, variant, index = 0) {
  const options = Array.isArray(variant.selectedOptions)
    ? variant.selectedOptions.map((o) => o.value)
    : [variant.option1, variant.option2, variant.option3];

  const price =
    variant.price && typeof variant.price === "object"
      ? variant.price.amount
      : variant.price;

  return {
    source_product_id: sourceProductId,
    shopify_variant_id: toShopifyId(variant.id),
    shopify_inventory_item_id: toShopifyId(
      variant.inventory_item_id || variant.inventoryItem?.id
    ),
    sku: variant.sku ? String(variant.sku).slice(0, 255) : null,
    title: variant.title ? String(variant.title).slice(0, 255) : null,
    price: price === undefined || price === null ? null : Number(price),
    compare_at_price:
      variant.compare_at_price === undefined || variant.compare_at_price === null
        ? null
        : Number(variant.compare_at_price),
    option1: options[0] ? String(options[0]).slice(0, 255) : null,
    option2: options[1] ? String(options[1]).slice(0, 255) : null,
    option3: options[2] ? String(options[2]).slice(0, 255) : null,
    inventory_quantity:
      variant.inventory_quantity === undefined
        ? null
        : Number(variant.inventory_quantity),
    position: Number.isFinite(Number(variant.position))
      ? Number(variant.position)
      : index + 1,
  };
}

const UPSERT_SQL = `
  INSERT INTO source_variant_mappings
    (source_product_id, shopify_variant_id, shopify_inventory_item_id,
     sku, title, price, compare_at_price,
     option1, option2, option3, inventory_quantity, position)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    shopify_inventory_item_id = VALUES(shopify_inventory_item_id),
    sku = VALUES(sku),
    title = VALUES(title),
    price = VALUES(price),
    compare_at_price = VALUES(compare_at_price),
    option1 = VALUES(option1),
    option2 = VALUES(option2),
    option3 = VALUES(option3),
    inventory_quantity = VALUES(inventory_quantity),
    position = VALUES(position)
`;

function toRow(record) {
  return [
    record.source_product_id,
    record.shopify_variant_id,
    record.shopify_inventory_item_id,
    record.sku,
    record.title,
    record.price,
    record.compare_at_price,
    record.option1,
    record.option2,
    record.option3,
    record.inventory_quantity,
    record.position,
  ];
}

/**
 * Replace a product's cached variants with what the source now reports.
 *
 * Upsert then prune, rather than delete-then-insert: an unchanged variant keeps
 * its row id, which mapping_variant_products points at.
 */
async function syncForProduct(sourceProductId, variants) {
  const list = (variants || []).filter((v) => v && v.id !== undefined);

  if (!list.length) {
    await removeMissing(sourceProductId, []);
    return { written: 0, removed: 0 };
  }

  const rows = list.map((variant, index) =>
    toRow(fromShopify(sourceProductId, variant, index))
  );

  await pool.query(UPSERT_SQL, [rows]);

  const removed = await removeMissing(
    sourceProductId,
    list.map((v) => v.id)
  );

  return { written: rows.length, removed };
}

async function listForProduct(sourceProductId) {
  return query(
    `SELECT * FROM source_variant_mappings
      WHERE source_product_id = ?
      ORDER BY position, id`,
    [sourceProductId]
  );
}

/**
 * Variants for a whole page of products at once, grouped by product id.
 *
 * The Products table renders every product's variants underneath it, so the
 * alternative is one query per row -- a hundred products would be a hundred
 * round trips to render one screen.
 */
async function mapForProducts(sourceProductIds) {
  const ids = [...new Set((sourceProductIds || []).map(Number).filter(Boolean))];
  const grouped = new Map();

  if (!ids.length) return grouped;

  const rows = await query(
    `SELECT * FROM source_variant_mappings
      WHERE source_product_id IN (?)
      ORDER BY source_product_id, position, id`,
    [ids]
  );

  rows.forEach((row) => {
    if (!grouped.has(row.source_product_id)) grouped.set(row.source_product_id, []);
    grouped.get(row.source_product_id).push(row);
  });

  return grouped;
}

async function findByShopifyId(sourceProductId, shopifyVariantId) {
  const rows = await query(
    `SELECT * FROM source_variant_mappings
      WHERE source_product_id = ? AND shopify_variant_id = ?
      LIMIT 1`,
    [sourceProductId, toShopifyId(shopifyVariantId)]
  );
  return rows[0] || null;
}

async function findById(id) {
  const rows = await query(
    "SELECT * FROM source_variant_mappings WHERE id = ? LIMIT 1",
    [id]
  );
  return rows[0] || null;
}

/** Shopify variant id -> row, for O(1) lookup while building a sync payload. */
async function mapByShopifyId(sourceProductId) {
  const rows = await listForProduct(sourceProductId);
  const index = new Map();
  rows.forEach((row) => index.set(String(row.shopify_variant_id), row));
  return index;
}

/** Variants no longer present at the source. */
async function removeMissing(sourceProductId, keepShopifyVariantIds) {
  const keep = (keepShopifyVariantIds || []).map(toShopifyId).filter(Boolean);

  if (!keep.length) {
    const [all] = await pool.query(
      "DELETE FROM source_variant_mappings WHERE source_product_id = ?",
      [sourceProductId]
    );
    return all.affectedRows;
  }

  const [result] = await pool.query(
    `DELETE FROM source_variant_mappings
      WHERE source_product_id = ? AND shopify_variant_id NOT IN (?)`,
    [sourceProductId, keep]
  );
  return result.affectedRows;
}

async function countForProduct(sourceProductId) {
  const rows = await query(
    "SELECT COUNT(*) AS total FROM source_variant_mappings WHERE source_product_id = ?",
    [sourceProductId]
  );
  return Number(rows[0] ? rows[0].total : 0);
}

module.exports = {
  fromShopify,
  syncForProduct,
  listForProduct,
  mapForProducts,
  findByShopifyId,
  findById,
  mapByShopifyId,
  removeMissing,
  countForProduct,
};
