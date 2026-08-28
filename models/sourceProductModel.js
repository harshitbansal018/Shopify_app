// models/sourceProductModel.js
//
// A local cache of every product fetched from a source store. Holding the full
// Shopify payload means a re-sync, or a second connection fanning out from the
// same source, needs no extra API call.
const { query, pool } = require("../config/db");
const { parseJson, toJsonColumn, toShopifyId, toDate } = require("./helpers");
const sourceVariantModel = require("./sourceVariantModel");

function hydrate(row) {
  if (!row) return null;
  return { ...row, product_data: parseJson(row.product_data, null) };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

async function findByShopifyId(storeId, shopifyProductId) {
  const rows = await query(
    `SELECT * FROM source_products
      WHERE store_id = ? AND shopify_product_id = ?
      LIMIT 1`,
    [storeId, toShopifyId(shopifyProductId)]
  );
  return hydrate(rows[0]);
}

async function findById(id) {
  const rows = await query("SELECT * FROM source_products WHERE id = ? LIMIT 1", [
    id,
  ]);
  return hydrate(rows[0]);
}

async function listForStore(storeId, { limit = 250, offset = 0 } = {}) {
  const rows = await query(
    `SELECT * FROM source_products
      WHERE store_id = ?
      ORDER BY id
      LIMIT ? OFFSET ?`,
    [storeId, Number(limit), Number(offset)]
  );
  return rows.map(hydrate);
}

/**
 * The source store's Products table: every cached product, with how many
 * connections it is allowed on and what happened on the last push.
 *
 * The aggregate is a LEFT JOIN rather than a per-row query, so a hundred
 * products still cost one statement. A product with no mappings comes back
 * with allowed = 0, which is what "not shared yet" means on screen.
 */
async function listWithMappingStatus(storeId, { limit = 100, offset = 0 } = {}) {
  const rows = await query(
    `SELECT sp.id, sp.shopify_product_id, sp.title, sp.handle, sp.vendor,
            sp.product_type, sp.status, sp.shopify_updated_at, sp.last_fetched_at,
            JSON_UNQUOTE(JSON_EXTRACT(sp.product_data, '$.image')) AS image_url,
            COUNT(pm.id) AS allowed,
            SUM(pm.sync_status = 'synced')  AS synced,
            SUM(pm.sync_status = 'failed')  AS failed,
            -- Offered but not yet accepted by the destination. Counted apart
            -- from 'pending' so the source can see it is waiting on them
            -- rather than on itself.
            SUM(pm.accepted_at IS NULL AND pm.sync_status <> 'deleted') AS awaiting,
            SUM(pm.sync_status = 'pending' AND pm.accepted_at IS NOT NULL) AS pending,
            MAX(pm.error_message)           AS error_message,
            -- Every connection carries the same selection, so any one of them
            -- describes it. CAST because MAX() cannot aggregate a JSON column.
            MAX(CAST(pm.allowed_variant_ids AS CHAR)) AS allowed_variant_ids,
            (SELECT COUNT(*) FROM source_variant_mappings svm
              WHERE svm.source_product_id = sp.id) AS variant_count
       FROM source_products sp
       LEFT JOIN product_mappings pm ON pm.source_product_id = sp.id
      WHERE sp.store_id = ?
      GROUP BY sp.id
      ORDER BY sp.title, sp.id
      LIMIT ? OFFSET ?`,
    [storeId, Number(limit), Number(offset)]
  );

  return rows.map((row) => ({
    ...row,
    allowed: Number(row.allowed || 0),
    synced: Number(row.synced || 0),
    pending: Number(row.pending || 0),
    awaiting: Number(row.awaiting || 0),
    failed: Number(row.failed || 0),
    variant_count: Number(row.variant_count || 0),
    // null means "every variant" -- kept distinct from an empty list.
    allowed_variant_ids: parseJson(row.allowed_variant_ids, null),
  }));
}

/**
 * The destination store's Products table: what has been synced INTO this
 * store, and which source store each product came from.
 */
async function listSyncedIntoStore(destinationStoreId, { limit = 100, offset = 0 } = {}) {
  const rows = await query(
    `SELECT pm.id AS mapping_id,
            pm.destination_shopify_product_id,
            pm.sync_status,
            pm.accepted_at,
            pm.last_synced_at,
            pm.error_message,
            -- How many variants the source is offering, which is not the same
            -- as how many have been synced across.
            --
            -- CAST AS CHAR, not AS JSON: MariaDB has no JSON cast, and the
            -- string "5" is already valid JSON for the number 5, which is what
            -- JSON_CONTAINS wants for its second argument.
            (SELECT COUNT(*) FROM source_variant_mappings svm
              WHERE svm.source_product_id = sp.id
                AND (pm.allowed_variant_ids IS NULL
                     OR JSON_CONTAINS(pm.allowed_variant_ids, CAST(svm.id AS CHAR))))
              AS offered_variant_count,
            sp.title, sp.handle, sp.vendor, sp.product_type,
            JSON_UNQUOTE(JSON_EXTRACT(sp.product_data, '$.image')) AS image_url,
            src.shop_domain AS source_shop_domain,
            src.store_name  AS source_store_name,
            (SELECT COUNT(*) FROM mapping_variant_products mvp
              WHERE mvp.product_mapping_id = pm.id) AS variant_count
       FROM product_mappings pm
       JOIN store_connections c ON c.id = pm.connection_id
       JOIN stores src         ON src.id = c.source_store_id
       JOIN source_products sp ON sp.id = pm.source_product_id
      WHERE c.destination_store_id = ?
      ORDER BY pm.last_synced_at IS NULL, pm.last_synced_at DESC, pm.id DESC
      LIMIT ? OFFSET ?`,
    [destinationStoreId, Number(limit), Number(offset)]
  );

  return rows.map((row) => ({
    ...row,
    variant_count: Number(row.variant_count || 0),
    offered_variant_count: Number(row.offered_variant_count || 0),
    // The destination has not agreed to this one yet.
    awaiting: row.accepted_at === null,
  }));
}

async function countForStore(storeId) {
  const rows = await query(
    "SELECT COUNT(*) AS total FROM source_products WHERE store_id = ?",
    [storeId]
  );
  return Number(rows[0] ? rows[0].total : 0);
}

/**
 * Iterate a store's cached products in id order without holding them all in
 * memory -- a source store can have tens of thousands.
 */
async function* iterateForStore(storeId, batchSize = 200) {
  let lastId = 0;

  for (;;) {
    const rows = await query(
      `SELECT * FROM source_products
        WHERE store_id = ? AND id > ?
        ORDER BY id
        LIMIT ?`,
      [storeId, lastId, Number(batchSize)]
    );

    if (!rows.length) return;

    for (const row of rows) yield hydrate(row);

    lastId = rows[rows.length - 1].id;
  }
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Map a raw Shopify product payload onto our columns.
 * Accepts both REST (`id`, `updated_at`) and GraphQL (`gid://`, `updatedAt`).
 */
function fromShopify(storeId, product) {
  return {
    store_id: storeId,
    shopify_product_id: toShopifyId(product.id),
    title: product.title ? String(product.title).slice(0, 512) : null,
    handle: product.handle || null,
    vendor: product.vendor || null,
    product_type: product.product_type || product.productType || null,
    status: (product.status || "").toString().toLowerCase() || null,
    product_data: product,
    shopify_updated_at: toDate(product.updated_at || product.updatedAt),
  };
}

const UPSERT_SQL = `
  INSERT INTO source_products
    (store_id, shopify_product_id, title, handle, vendor, product_type,
     status, product_data, shopify_updated_at, last_fetched_at)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    title = VALUES(title),
    handle = VALUES(handle),
    vendor = VALUES(vendor),
    product_type = VALUES(product_type),
    status = VALUES(status),
    product_data = VALUES(product_data),
    shopify_updated_at = VALUES(shopify_updated_at),
    last_fetched_at = VALUES(last_fetched_at)
`;

function toRow(record, fetchedAt) {
  return [
    record.store_id,
    record.shopify_product_id,
    record.title,
    record.handle,
    record.vendor,
    record.product_type,
    record.status,
    toJsonColumn(record.product_data),
    record.shopify_updated_at,
    fetchedAt,
  ];
}

/**
 * Cache one product AND its variants. Variants live in their own table now, so
 * caching a product without them would leave the two out of step.
 */
async function upsert(storeId, product) {
  const fetchedAt = new Date();
  await pool.query(UPSERT_SQL, [[toRow(fromShopify(storeId, product), fetchedAt)]]);

  const cached = await findByShopifyId(storeId, product.id);

  if (cached && Array.isArray(product.variants)) {
    await sourceVariantModel.syncForProduct(cached.id, product.variants);
  }

  return cached;
}

/**
 * Bulk upsert one page of products. Returns how many rows were written.
 * Chunked because a single statement with thousands of rows can exceed
 * max_allowed_packet.
 */
async function upsertMany(storeId, products, { chunkSize = 100 } = {}) {
  const list = (products || []).filter((p) => p && p.id !== undefined);

  if (!list.length) return 0;

  const fetchedAt = new Date();
  let written = 0;

  for (let i = 0; i < list.length; i += chunkSize) {
    const rows = list
      .slice(i, i + chunkSize)
      .map((product) => toRow(fromShopify(storeId, product), fetchedAt));

    await pool.query(UPSERT_SQL, [rows]);
    written += rows.length;
  }

  // Variants are a second table now; keep them in step with the products just
  // written, or a sync would read a stale variant list.
  for (const product of list) {
    if (!Array.isArray(product.variants)) continue;

    const cached = await findByShopifyId(storeId, product.id);
    if (cached) await sourceVariantModel.syncForProduct(cached.id, product.variants);
  }

  return written;
}

async function deleteByShopifyId(storeId, shopifyProductId) {
  const [result] = await pool.query(
    "DELETE FROM source_products WHERE store_id = ? AND shopify_product_id = ?",
    [storeId, toShopifyId(shopifyProductId)]
  );
  return result.affectedRows > 0;
}

/**
 * Shopify ids present in the cache but absent from `keepIds` -- i.e. products
 * deleted at the source since the last full fetch.
 */
async function findMissingSince(storeId, keepIds) {
  if (!keepIds || !keepIds.length) {
    const rows = await query(
      "SELECT shopify_product_id FROM source_products WHERE store_id = ?",
      [storeId]
    );
    return rows.map((row) => String(row.shopify_product_id));
  }

  const rows = await query(
    `SELECT shopify_product_id FROM source_products
      WHERE store_id = ? AND shopify_product_id NOT IN (?)`,
    [storeId, keepIds.map(toShopifyId)]
  );
  return rows.map((row) => String(row.shopify_product_id));
}

module.exports = {
  fromShopify,
  findByShopifyId,
  findById,
  listForStore,
  listWithMappingStatus,
  listSyncedIntoStore,
  countForStore,
  iterateForStore,
  upsert,
  upsertMany,
  deleteByShopifyId,
  findMissingSince,
};
