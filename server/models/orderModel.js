// models/orderModel.js
//
// `orders` -- orders placed in a store, reduced to the columns worth querying.
//
// Customer identity is NOT copied here -- name, email and phone live in the
// customers table, joined on customer_shopify_id.
//
// The two addresses still count as PERSONAL DATA, because a Shopify address
// carries a name and a phone number. redactCustomer() below is what satisfies
// the customers/redact webhook.
//
// The raw Shopify payload is no longer stored, so anything not given a column
// here is simply not kept.
const { query, pool } = require("../config/db");
const { parseJson, toJsonColumn, toShopifyId, toDate } = require("./helpers");
const orderLineItemModel = require("./orderLineItemModel");

const { toMoney } = orderLineItemModel;

function hydrate(row) {
  if (!row) return null;

  return {
    ...row,
    billing_address: parseJson(row.billing_address, null),
    shipping_address: parseJson(row.shipping_address, null),
    test: Boolean(row.test),
  };
}

/* ------------------------------------------------------------------ */
/* Mapping from Shopify                                                */
/* ------------------------------------------------------------------ */

/**
 * Shopify reports totals both as a bare string and inside a *_set object with
 * shop and presentment money. Prefer the shop money, fall back to the string.
 */
function shopMoney(order, plainKey, setKey) {
  const set = order[setKey];

  if (set && set.shop_money && set.shop_money.amount !== undefined) {
    return toMoney(set.shop_money.amount);
  }

  return toMoney(order[plainKey]);
}

function fromShopify(storeId, order) {
  const customer = order.customer || {};
  const shipping = order.shipping_address || null;

  return {
    store_id: storeId,
    shopify_order_id: toShopifyId(order.id),
    order_number: Number.isFinite(Number(order.order_number))
      ? Number(order.order_number)
      : null,
    name: order.name ? String(order.name).slice(0, 50) : null,

    currency: order.currency || null,
    subtotal_price: shopMoney(order, "subtotal_price", "subtotal_price_set"),
    total_tax: shopMoney(order, "total_tax", "total_tax_set"),
    total_discounts: shopMoney(order, "total_discounts", "total_discounts_set"),
    total_shipping: order.total_shipping_price_set
      ? toMoney(order.total_shipping_price_set.shop_money?.amount)
      : toMoney(order.total_shipping_price),
    total_price: shopMoney(order, "total_price", "total_price_set"),

    financial_status: order.financial_status || null,
    fulfillment_status: order.fulfillment_status || null,
    cancelled_at: toDate(order.cancelled_at),
    cancel_reason: order.cancel_reason || null,
    closed_at: toDate(order.closed_at),
    test: order.test ? 1 : 0,

    customer_shopify_id: toShopifyId(customer.id),
    billing_address: order.billing_address || null,
    shipping_address: shipping,
    shipping_country_code: shipping?.country_code
      ? String(shipping.country_code).slice(0, 2)
      : null,

  };
}

const UPSERT_SQL = `
  INSERT INTO orders
    (store_id, shopify_order_id, order_number, name,
     currency, subtotal_price, total_tax,
     total_discounts, total_shipping, total_price,
     financial_status, fulfillment_status, cancelled_at, cancel_reason,
     closed_at, test,
     customer_shopify_id,
     billing_address, shipping_address, shipping_country_code)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    order_number = VALUES(order_number),
    name = VALUES(name),
    currency = VALUES(currency),
    subtotal_price = VALUES(subtotal_price),
    total_tax = VALUES(total_tax),
    total_discounts = VALUES(total_discounts),
    total_shipping = VALUES(total_shipping),
    total_price = VALUES(total_price),
    financial_status = VALUES(financial_status),
    fulfillment_status = VALUES(fulfillment_status),
    cancelled_at = VALUES(cancelled_at),
    cancel_reason = VALUES(cancel_reason),
    closed_at = VALUES(closed_at),
    test = VALUES(test),
    customer_shopify_id = VALUES(customer_shopify_id),
    billing_address = VALUES(billing_address),
    shipping_address = VALUES(shipping_address),
    shipping_country_code = VALUES(shipping_country_code)
`;

function toRow(record) {
  return [
    record.store_id,
    record.shopify_order_id,
    record.order_number,
    record.name,
    record.currency,
    record.subtotal_price,
    record.total_tax,
    record.total_discounts,
    record.total_shipping,
    record.total_price,
    record.financial_status,
    record.fulfillment_status,
    record.cancelled_at,
    record.cancel_reason,
    record.closed_at,
    record.test,
    record.customer_shopify_id,
    toJsonColumn(record.billing_address),
    toJsonColumn(record.shipping_address),
    record.shipping_country_code,
  ];
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/** Cache one order and its line items. */
async function upsert(storeId, order) {
  await pool.query(UPSERT_SQL, [[toRow(fromShopify(storeId, order))]]);

  const saved = await findByShopifyId(storeId, order.id);

  if (saved && Array.isArray(order.line_items)) {
    await orderLineItemModel.syncForOrder(saved.id, order.line_items);
  }

  return saved;
}

async function upsertMany(storeId, orders, { chunkSize = 50 } = {}) {
  const list = (orders || []).filter((o) => o && o.id !== undefined);

  if (!list.length) return 0;

  for (let i = 0; i < list.length; i += chunkSize) {
    const rows = list
      .slice(i, i + chunkSize)
      .map((order) => toRow(fromShopify(storeId, order)));

    await pool.query(UPSERT_SQL, [rows]);
  }

  // Line items live in their own table; keep them in step with what was just
  // written or a report would read a stale basket.
  for (const order of list) {
    if (!Array.isArray(order.line_items)) continue;

    const saved = await findByShopifyId(storeId, order.id);
    if (saved) await orderLineItemModel.syncForOrder(saved.id, order.line_items);
  }

  return list.length;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

async function findByShopifyId(storeId, shopifyOrderId) {
  const rows = await query(
    "SELECT * FROM orders WHERE store_id = ? AND shopify_order_id = ? LIMIT 1",
    [storeId, toShopifyId(shopifyOrderId)]
  );
  return hydrate(rows[0]);
}

async function findById(id) {
  const rows = await query("SELECT * FROM orders WHERE id = ? LIMIT 1", [id]);
  return hydrate(rows[0]);
}

/** One order with its lines, for the order detail screen. */
async function findWithLines(storeId, shopifyOrderId) {
  const order = await findByShopifyId(storeId, shopifyOrderId);
  if (!order) return null;

  return { ...order, line_items: await orderLineItemModel.listForOrder(order.id) };
}

async function listForStore(
  storeId,
  { limit = 50, offset = 0, financialStatus = null, includeTest = false } = {}
) {
  const params = [storeId];
  let where = "";

  if (financialStatus) {
    where += " AND financial_status = ?";
    params.push(financialStatus);
  }

  if (!includeTest) where += " AND test = 0";

  params.push(Number(limit), Number(offset));

  const rows = await query(
    `SELECT * FROM orders
      WHERE store_id = ?${where}
      ORDER BY id DESC
      LIMIT ? OFFSET ?`,
    params
  );
  return rows.map(hydrate);
}

async function countForStore(storeId, { includeTest = false } = {}) {
  const rows = await query(
    `SELECT COUNT(*) AS total FROM orders
      WHERE store_id = ?${includeTest ? "" : " AND test = 0"}`,
    [storeId]
  );
  return Number(rows[0] ? rows[0].total : 0);
}

/** Headline numbers for a store. Test and cancelled orders are excluded. */
async function totalsForStore(storeId, { since = null } = {}) {
  const params = [storeId];
  let sinceClause = "";

  if (since) {
    // created_at is when this app first saw the order, not when it was placed
    // -- the Shopify timestamp is no longer stored.
    sinceClause = " AND created_at >= ?";
    params.push(since);
  }

  const rows = await query(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(total_price), 0) AS revenue,
            COALESCE(SUM(total_tax), 0) AS tax,
            COALESCE(SUM(total_shipping), 0) AS shipping
       FROM orders
      WHERE store_id = ?
        AND test = 0
        AND cancelled_at IS NULL${sinceClause}`,
    params
  );

  const row = rows[0] || {};

  return {
    orders: Number(row.orders || 0),
    revenue: Number(row.revenue || 0),
    tax: Number(row.tax || 0),
    shipping: Number(row.shipping || 0),
  };
}

/* ------------------------------------------------------------------ */
/* Privacy                                                             */
/* ------------------------------------------------------------------ */

/**
 * customers/data_request: every order this customer placed.
 *
 * Includes the line items, because "what did I buy" is the substance of the
 * request. The merchant delivers it; this just assembles it.
 *
 * Matching is by customer id alone. Orders no longer carry an email of their
 * own -- that lives in the customers table -- so an order placed with no
 * customer attached cannot be traced back to a person here.
 */
async function dataForCustomer(storeId, customerShopifyId) {
  const rows = await query(
    "SELECT * FROM orders WHERE store_id = ? AND customer_shopify_id = ? ORDER BY id",
    [storeId, toShopifyId(customerShopifyId)]
  );

  const orders = [];

  for (const row of rows.map(hydrate)) {
    orders.push({
      ...row,
      line_items: await orderLineItemModel.listForOrder(row.id),
    });
  }

  return orders;
}

/**
 * customers/redact: erase the personal data but KEEP the order.
 *
 * Deleting the row outright would destroy the merchant's sales record, which
 * they are separately required to retain. Clearing the customer link and both
 * addresses leaves the money and the line items intact while removing the
 * person -- a Shopify address carries a name and a phone number, so leaving
 * the addresses would defeat the erasure.
 *
 * CAVEAT: the `redacted_at` marker was removed from this table, so nothing
 * records that an order was erased. If a later sync re-fetches this order,
 * the upsert will write the customer id and addresses straight back. Until a
 * marker exists, erasure only holds for orders that are never re-fetched.
 */
async function redactCustomer(storeId, customerShopifyId) {
  const [result] = await pool.query(
    `UPDATE orders
        SET customer_shopify_id = NULL,
            billing_address = NULL,
            shipping_address = NULL
      WHERE store_id = ? AND customer_shopify_id = ?`,
    [storeId, toShopifyId(customerShopifyId)]
  );

  return result.affectedRows;
}

async function deleteForStore(storeId) {
  await query("DELETE FROM orders WHERE store_id = ?", [storeId]);
}

module.exports = {
  fromShopify,
  upsert,
  upsertMany,
  findByShopifyId,
  findById,
  findWithLines,
  listForStore,
  countForStore,
  totalsForStore,
  dataForCustomer,
  redactCustomer,
  deleteForStore,
};
