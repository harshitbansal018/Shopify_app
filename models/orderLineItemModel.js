// models/orderLineItemModel.js
//
// `order_line_items` -- what was actually bought on an order.
//
// shopify_product_id is a plain column, not a foreign key: the product may
// have been deleted from the catalogue since the order was placed, and a real
// FK would either refuse the insert or take sales history down with it.
//
// mapped_variant_id IS a foreign key, onto mapping_variant_products(id). The
// Shopify payload only carries a raw variant id, so resolveMappedVariants()
// below translates that into our mapping row before the line is written.
const { query, pool } = require("../config/db");
const { parseJson, toJsonColumn, toShopifyId } = require("./helpers");

function hydrate(row) {
  if (!row) return null;
  return { ...row, line_data: parseJson(row.line_data, null) };
}

/** Shopify sends money as strings ("10.00"); store it as a number or null. */
function toMoney(value) {
  if (value === null || value === undefined || value === "") return null;

  const amount = Number(
    typeof value === "object" ? value.amount ?? value.shop_money?.amount : value
  );

  return Number.isFinite(amount) ? amount : null;
}

function fromShopify(orderId, line, mappedVariantId = null) {
  return [
    orderId,
    toShopifyId(line.id),
    toShopifyId(line.product_id),
    mappedVariantId,
    line.sku ? String(line.sku).slice(0, 255) : null,
    line.title ? String(line.title).slice(0, 512) : null,
    line.variant_title ? String(line.variant_title).slice(0, 255) : null,
    line.vendor ? String(line.vendor).slice(0, 255) : null,
    Number(line.quantity) || 0,
    toMoney(line.price ?? line.price_set),
    toMoney(line.total_discount ?? line.total_discount_set),
    line.fulfillment_status || null,
    line.requires_shipping === false ? 0 : 1,
    toJsonColumn(line),
  ];
}

const UPSERT_SQL = `
  INSERT INTO order_line_items
    (order_id, shopify_line_item_id, shopify_product_id, mapped_variant_id,
     sku, title, variant_title, vendor, quantity, price, total_discount,
     fulfillment_status, requires_shipping, line_data)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    shopify_product_id = VALUES(shopify_product_id),
    mapped_variant_id = VALUES(mapped_variant_id),
    sku = VALUES(sku),
    title = VALUES(title),
    variant_title = VALUES(variant_title),
    vendor = VALUES(vendor),
    quantity = VALUES(quantity),
    price = VALUES(price),
    total_discount = VALUES(total_discount),
    fulfillment_status = VALUES(fulfillment_status),
    requires_shipping = VALUES(requires_shipping),
    line_data = VALUES(line_data)
`;

/**
 * Shopify variant id -> our mapping_variant_products row id.
 *
 * One query for the whole order rather than one per line. A variant that was
 * never synced by this app simply has no entry, and its line stores NULL.
 */
async function resolveMappedVariants(shopifyVariantIds) {
  const ids = [...new Set((shopifyVariantIds || []).map(toShopifyId).filter(Boolean))];
  const index = new Map();

  if (!ids.length) return index;

  const rows = await query(
    `SELECT id, destination_variant_id
       FROM mapping_variant_products
      WHERE destination_variant_id IN (?)`,
    [ids]
  );

  rows.forEach((row) => index.set(String(row.destination_variant_id), row.id));
  return index;
}

/**
 * Replace an order's lines with what Shopify now reports.
 *
 * Upsert then prune: a line that has not changed keeps its row, so anything
 * referencing it stays valid.
 */
async function syncForOrder(orderId, lineItems) {
  const list = (lineItems || []).filter((l) => l && l.id !== undefined);

  if (!list.length) {
    await pool.query("DELETE FROM order_line_items WHERE order_id = ?", [orderId]);
    return 0;
  }

  const mapped = await resolveMappedVariants(list.map((l) => l.variant_id));

  await pool.query(UPSERT_SQL, [
    list.map((line) =>
      fromShopify(orderId, line, mapped.get(String(toShopifyId(line.variant_id))) || null)
    ),
  ]);

  await pool.query(
    `DELETE FROM order_line_items
      WHERE order_id = ? AND shopify_line_item_id NOT IN (?)`,
    [orderId, list.map((l) => toShopifyId(l.id))]
  );

  return list.length;
}

async function listForOrder(orderId) {
  const rows = await query(
    "SELECT * FROM order_line_items WHERE order_id = ? ORDER BY id",
    [orderId]
  );
  return rows.map(hydrate);
}

async function countForOrder(orderId) {
  const rows = await query(
    "SELECT COUNT(*) AS total FROM order_line_items WHERE order_id = ?",
    [orderId]
  );
  return Number(rows[0] ? rows[0].total : 0);
}

/**
 * The lines of a destination order that came from a synced product, each
 * resolved all the way back to the SOURCE variant that supplied it.
 *
 * This is what lets a sale be re-placed at the source: the source's own
 * variant id to order, and the source's own price to order it at. The price
 * the shopper paid is returned alongside it, but only so the two can be shown
 * next to each other -- it is the marked-up figure and must never be the one
 * sent to the source.
 *
 * Every JOIN is an INNER join on purpose. A line with no mapped_variant_id was
 * a product the destination sells itself, and a line whose source variant has
 * since been deleted can no longer be ordered. Neither belongs to any source,
 * so both drop out here rather than being returned for the caller to filter.
 */
async function sourceLinesForOrder(orderId) {
  return query(
    `SELECT li.id AS line_id,
            li.quantity,
            li.price AS destination_price,
            li.title,
            li.variant_title,
            li.sku AS destination_sku,
            li.requires_shipping,
            pm.connection_id,
            svm.shopify_variant_id AS source_shopify_variant_id,
            svm.price  AS source_price,
            svm.sku    AS source_sku,
            svm.title  AS source_variant_title,
            sp.title   AS source_product_title
       FROM order_line_items li
       JOIN mapping_variant_products mvp ON mvp.id  = li.mapped_variant_id
       JOIN product_mappings pm          ON pm.id  = mvp.product_mapping_id
       JOIN source_variant_mappings svm  ON svm.id = mvp.source_variant_mapping_id
       JOIN source_products sp           ON sp.id  = svm.source_product_id
      WHERE li.order_id = ?
      ORDER BY li.id`,
    [orderId]
  );
}

/**
 * The DESTINATION's own line ids for one source's share of an order.
 *
 * The mirror of sourceLinesForOrder: that one answers "what does the source
 * ship", this one answers "which of the buyer's lines does that cover". It is
 * what lets the buyer's Shopify order be fulfilled for this supplier's lines
 * and nobody else's -- fulfilling the whole order because one supplier shipped
 * would tell the shopper everything is on its way when most of it is not.
 */
async function destinationLinesForConnection(orderId, connectionId) {
  return query(
    `SELECT li.id AS line_id,
            li.shopify_line_item_id,
            li.quantity,
            li.sku,
            li.title
       FROM order_line_items li
       JOIN mapping_variant_products mvp ON mvp.id = li.mapped_variant_id
       JOIN product_mappings pm          ON pm.id = mvp.product_mapping_id
      WHERE li.order_id = ? AND pm.connection_id = ?
      ORDER BY li.id`,
    [orderId, connectionId]
  );
}

/**
 * Units sold per variant, resolved back through the mapping to the source
 * variant it came from -- which is what "how much of MY product sold" means
 * when the same product is synced to several stores.
 */
async function unitsSoldByVariant(storeId, { since = null } = {}) {
  const params = [storeId];
  let sinceClause = "";

  if (since) {
    // o.created_at is when this app saw the order, not when it was placed.
    sinceClause = " AND o.created_at >= ?";
    params.push(since);
  }

  return query(
    `SELECT li.mapped_variant_id, li.sku,
            mvp.source_shopify_variant_id,
            mvp.destination_variant_id,
            SUM(li.quantity) AS units,
            SUM(li.quantity * li.price) AS revenue
       FROM order_line_items li
       JOIN orders o ON o.id = li.order_id
       LEFT JOIN mapping_variant_products mvp ON mvp.id = li.mapped_variant_id
      WHERE o.store_id = ?
        AND o.test = 0
        AND o.cancelled_at IS NULL${sinceClause}
      GROUP BY li.mapped_variant_id, li.sku,
               mvp.source_shopify_variant_id, mvp.destination_variant_id
      ORDER BY units DESC`,
    params
  );
}

/** Highest-selling synced products for one destination store.
 * Revenue is what the destination customer paid, less line discounts. */
async function topSellingProducts(storeId, { limit = 5 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 50));

  const rows = await query(
    `SELECT sp.id AS source_product_id,
            MAX(COALESCE(sp.title, li.title, 'Deleted product')) AS title,
            MAX(COALESCE(source_store.store_name, source_store.shop_domain)) AS source,
            MAX(o.currency) AS currency,
            SUM(li.quantity) AS units,
            SUM((li.quantity * li.price) - COALESCE(li.total_discount, 0)) AS revenue
       FROM order_line_items li
       JOIN orders o ON o.id = li.order_id
       JOIN mapping_variant_products mvp ON mvp.id = li.mapped_variant_id
       JOIN product_mappings pm ON pm.id = mvp.product_mapping_id
       JOIN source_products sp ON sp.id = pm.source_product_id
       JOIN store_connections connection ON connection.id = pm.connection_id
       JOIN stores source_store ON source_store.id = connection.source_store_id
      WHERE o.store_id = ?
        AND o.test = 0
        AND o.cancelled_at IS NULL
      GROUP BY sp.id
      ORDER BY units DESC, revenue DESC, title ASC
      LIMIT ?`,
    [storeId, safeLimit]
  );

  return rows.map((row) => ({
    ...row,
    units: Number(row.units || 0),
    revenue: Number(row.revenue || 0),
  }));
}

module.exports = {
  resolveMappedVariants,
  syncForOrder,
  listForOrder,
  countForOrder,
  sourceLinesForOrder,
  destinationLinesForConnection,
  unitsSoldByVariant,
  topSellingProducts,
  toMoney,
};
