// models/syncSettingsModel.js
//
// `sync_settings` -- what one connection copies to its destination.
//
// One row per connection. Every toggle defaults to ON, because a merchant who
// has chosen nothing wants the product as it is at the source.
//
// Turning a field OFF means the push simply does not send it. productSet
// leaves an omitted field unchanged, so the destination keeps whatever it
// already has -- nothing is blanked. That is the whole point: "do not
// overwrite my own description" rather than "erase my description".
const { query, pool } = require("../config/db");

/** Every boolean column, in the order the settings screen shows them. */
const PRODUCT_FIELDS = [
  "title",
  "description",
  "images",
  "category",
  "status",
  "product_type",
  "vendor",
  "tags",
  "metafields",
];

const VARIANT_FIELDS = [
  "variant_sku",
  "variant_barcode",
  "variant_price",
  "variant_cost",
  "variant_taxable",
  "variant_continue_selling",
];

// sync_variants is the parent of VARIANT_FIELDS; inventory hangs off variants
// too but reads as a product-level idea to a merchant, so it sits on its own.
const TOGGLES = [...PRODUCT_FIELDS, "variants", ...VARIANT_FIELDS, "inventory"];

/**
 * How a source variant is matched to the destination variant it became.
 *
 * No screen offers this any more: the destination product is created by this
 * app, so its SKUs are the ones we sent and always line up. The column and
 * identityOf() in services/productSync.js stay because the day two stores do
 * NOT share SKUs, this is the only place that has to change back.
 */
const MATCH_KEYS = ["sku", "barcode", "title"];

/** Booleans come back from MySQL as 0/1; the rest of the app wants true/false. */
function hydrate(row) {
  if (!row) return null;

  const settings = {
    id: row.id,
    connection_id: row.connection_id,
    match_by: row.match_by,
    price_markup_percent: Number(row.price_markup_percent || 0),
  };

  TOGGLES.forEach((field) => {
    settings[field] = Boolean(row[`sync_${field}`]);
  });

  return settings;
}

/** What a connection with no row yet behaves like: everything on. */
function defaults(connectionId = null) {
  const settings = {
    id: null,
    connection_id: connectionId,
    match_by: "sku",
    price_markup_percent: 0,
  };

  TOGGLES.forEach((field) => {
    settings[field] = true;
  });

  return settings;
}

/**
 * The settings a push should use.
 *
 * Never returns null: a connection whose row has somehow gone still has to
 * sync, and "everything on" is the only safe reading of "not configured".
 */
async function forConnection(connectionId) {
  const rows = await query(
    "SELECT * FROM sync_settings WHERE connection_id = ? LIMIT 1",
    [connectionId]
  );

  return hydrate(rows[0]) || defaults(connectionId);
}

/** Settings for several connections at once, keyed by connection id. */
async function mapForConnections(connectionIds) {
  const ids = [...new Set((connectionIds || []).map(Number).filter(Boolean))];
  const index = new Map();

  if (!ids.length) return index;

  const rows = await query(
    "SELECT * FROM sync_settings WHERE connection_id IN (?)",
    [ids]
  );

  rows.forEach((row) => index.set(row.connection_id, hydrate(row)));

  // A connection with no row still needs settings.
  ids.forEach((id) => {
    if (!index.has(id)) index.set(id, defaults(id));
  });

  return index;
}

/**
 * Save a connection's settings.
 *
 * Written as an upsert so a connection made before this table existed gets its
 * row on first save rather than silently failing to update nothing.
 *
 * Everything is normalised here rather than trusted: the input comes from a
 * browser, and an unknown match_by or a 900% markup should not reach a column.
 */
async function save(connectionId, input = {}) {
  const markup = Number(input.price_markup_percent);

  const values = {
    match_by: MATCH_KEYS.includes(input.match_by) ? input.match_by : "sku",
    price_markup_percent: Number.isFinite(markup)
      ? Math.max(Math.min(markup, 1000), -100)
      : 0,
  };

  // Only an explicit false turns a field off. Anything missing stays ON, so a
  // field added to this list later is on for everyone rather than silently
  // skipped for every existing connection.
  TOGGLES.forEach((field) => {
    values[`sync_${field}`] = input[field] === false ? 0 : 1;
  });

  const columns = ["connection_id", ...Object.keys(values)];
  const params = [connectionId, ...Object.values(values)];

  await pool.query(
    `INSERT INTO sync_settings (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})
     ON DUPLICATE KEY UPDATE
       ${Object.keys(values).map((column) => `${column} = VALUES(${column})`).join(",\n       ")}`,
    params
  );

  return forConnection(connectionId);
}

/** Give a brand new connection its row of defaults. */
async function ensure(connectionId) {
  await pool.query(
    "INSERT IGNORE INTO sync_settings (connection_id) VALUES (?)",
    [connectionId]
  );

  return forConnection(connectionId);
}

module.exports = {
  PRODUCT_FIELDS,
  VARIANT_FIELDS,
  TOGGLES,
  MATCH_KEYS,
  defaults,
  forConnection,
  mapForConnections,
  save,
  ensure,
};
