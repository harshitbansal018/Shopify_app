// models/customerModel.js
//
// `customers` -- a minimal cache of a store's customers.
//
// PERSONAL DATA. Everything in this table except the ids is information about
// a real person, which is why redactForCustomer() deletes the row outright
// rather than blanking it: unlike an order, a customer record carries no sales
// history that has to survive.
const { query, pool } = require("../config/db");
const { parseJson, toJsonColumn, toShopifyId, toDate } = require("./helpers");

function hydrate(row) {
  if (!row) return null;
  return { ...row, addresses: parseJson(row.addresses, null) };
}

/**
 * Map a raw Shopify customer onto our columns.
 *
 * `default_address` is folded into the addresses array rather than given its
 * own column -- Shopify repeats it there, and one list is easier to reason
 * about than a list plus a special case.
 */
function fromShopify(storeId, customer) {
  const addresses = Array.isArray(customer.addresses)
    ? customer.addresses
    : customer.default_address
      ? [customer.default_address]
      : null;

  return {
    store_id: storeId,
    shopify_customer_id: toShopifyId(customer.id),
    first_name: customer.first_name ? String(customer.first_name).slice(0, 255) : null,
    last_name: customer.last_name ? String(customer.last_name).slice(0, 255) : null,
    email: customer.email ? String(customer.email).slice(0, 255) : null,
    phone: customer.phone ? String(customer.phone).slice(0, 64) : null,
    addresses,
    shopify_created_at: toDate(customer.created_at || customer.createdAt),
    shopify_updated_at: toDate(customer.updated_at || customer.updatedAt),
  };
}

const UPSERT_SQL = `
  INSERT INTO customers
    (store_id, shopify_customer_id, first_name, last_name, email, phone,
     addresses, shopify_created_at, shopify_updated_at, last_fetched_at)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    first_name = VALUES(first_name),
    last_name = VALUES(last_name),
    email = VALUES(email),
    phone = VALUES(phone),
    addresses = VALUES(addresses),
    shopify_updated_at = VALUES(shopify_updated_at),
    last_fetched_at = VALUES(last_fetched_at)
`;

function toRow(record, fetchedAt) {
  return [
    record.store_id,
    record.shopify_customer_id,
    record.first_name,
    record.last_name,
    record.email,
    record.phone,
    toJsonColumn(record.addresses),
    record.shopify_created_at,
    record.shopify_updated_at,
    fetchedAt,
  ];
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

async function upsert(storeId, customer) {
  await pool.query(UPSERT_SQL, [
    [toRow(fromShopify(storeId, customer), new Date())],
  ]);
  return findByShopifyId(storeId, customer.id);
}

async function upsertMany(storeId, customers, { chunkSize = 100 } = {}) {
  const list = (customers || []).filter((c) => c && c.id !== undefined);

  if (!list.length) return 0;

  const fetchedAt = new Date();

  for (let i = 0; i < list.length; i += chunkSize) {
    const rows = list
      .slice(i, i + chunkSize)
      .map((customer) => toRow(fromShopify(storeId, customer), fetchedAt));

    await pool.query(UPSERT_SQL, [rows]);
  }

  return list.length;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

async function findByShopifyId(storeId, shopifyCustomerId) {
  const rows = await query(
    `SELECT * FROM customers
      WHERE store_id = ? AND shopify_customer_id = ?
      LIMIT 1`,
    [storeId, toShopifyId(shopifyCustomerId)]
  );
  return hydrate(rows[0]);
}

async function findById(id) {
  const rows = await query("SELECT * FROM customers WHERE id = ? LIMIT 1", [id]);
  return hydrate(rows[0]);
}

async function findByEmail(storeId, email) {
  const rows = await query(
    "SELECT * FROM customers WHERE store_id = ? AND email = ? LIMIT 1",
    [storeId, email]
  );
  return hydrate(rows[0]);
}

async function listForStore(storeId, { limit = 50, offset = 0, search = null } = {}) {
  const params = [storeId];
  let where = "";

  if (search) {
    // Enough for an admin lookup box; not a full-text search.
    where =
      " AND (email LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR phone LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  params.push(Number(limit), Number(offset));

  const rows = await query(
    `SELECT * FROM customers
      WHERE store_id = ?${where}
      ORDER BY id DESC
      LIMIT ? OFFSET ?`,
    params
  );
  return rows.map(hydrate);
}

async function countForStore(storeId) {
  const rows = await query(
    "SELECT COUNT(*) AS total FROM customers WHERE store_id = ?",
    [storeId]
  );
  return Number(rows[0] ? rows[0].total : 0);
}

/* ------------------------------------------------------------------ */
/* Privacy                                                             */
/* ------------------------------------------------------------------ */

/** customers/data_request: everything this table holds about one person. */
async function dataForCustomer(storeId, shopifyCustomerId, email = null) {
  const params = [storeId, toShopifyId(shopifyCustomerId)];
  let match = "shopify_customer_id = ?";

  if (email) {
    match = "(shopify_customer_id = ? OR email = ?)";
    params.push(email);
  }

  const rows = await query(
    `SELECT * FROM customers WHERE store_id = ? AND ${match}`,
    params
  );
  return rows.map(hydrate);
}

/**
 * customers/redact: remove the person entirely.
 *
 * A hard delete, unlike orders. There is nothing here worth keeping once the
 * personal fields are gone -- an anonymised customer row would be an id and
 * four nulls.
 */
async function redactCustomer(storeId, shopifyCustomerId, email = null) {
  const [result] = await pool.query(
    `DELETE FROM customers
      WHERE store_id = ? AND (shopify_customer_id = ?${email ? " OR email = ?" : ""})`,
    email
      ? [storeId, toShopifyId(shopifyCustomerId), email]
      : [storeId, toShopifyId(shopifyCustomerId)]
  );
  return result.affectedRows;
}

async function deleteForStore(storeId) {
  await query("DELETE FROM customers WHERE store_id = ?", [storeId]);
}

module.exports = {
  fromShopify,
  upsert,
  upsertMany,
  findByShopifyId,
  findById,
  findByEmail,
  listForStore,
  countForStore,
  dataForCustomer,
  redactCustomer,
  deleteForStore,
};
