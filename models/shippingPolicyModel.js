// models/shippingPolicyModel.js
//
// One source-defined checkout shipping policy per source -> destination
// connection. Shopify profile ids are stored beside the desired policy so a
// later save can replace the app-owned profile without guessing which profile
// belongs to this connection.
const { query, pool } = require("../config/db");
const { parseJson, toJsonColumn } = require("./helpers");

const MODES = ["disabled", "included", "flat"];

function countryCodes(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
  return [...new Set(raw.map((code) => String(code).trim().toUpperCase()).filter(Boolean))];
}

function normalize(input = {}, { currency = null } = {}) {
  const mode = MODES.includes(input.mode) ? input.mode : "disabled";
  const flatRate = Number(input.flat_rate);
  const minDays = Number(input.delivery_min_days);
  const maxDays = Number(input.delivery_max_days);
  const countries = countryCodes(input.country_codes);

  if (mode !== "disabled" && !countries.length) {
    const error = new Error("Add at least one two-letter delivery country code.");
    error.statusCode = 400;
    throw error;
  }
  if (countries.some((code) => !/^[A-Z]{2}$/.test(code))) {
    const error = new Error("Delivery countries must use two-letter codes, for example IN, US.");
    error.statusCode = 400;
    throw error;
  }
  if (mode !== "disabled" && (!Number.isFinite(flatRate) || flatRate < 0)) {
    const error = new Error("Included shipping amount must be 0 or greater.");
    error.statusCode = 400;
    throw error;
  }
  if ((minDays && minDays < 1) || (maxDays && maxDays < 1) ||
      (minDays && maxDays && minDays > maxDays)) {
    const error = new Error("Delivery days must be positive, with minimum not above maximum.");
    error.statusCode = 400;
    throw error;
  }

  return {
    mode,
    service_name: String(input.service_name || "Standard delivery").trim().slice(0, 100) ||
      "Standard delivery",
    // In the included-price flow this is the per-unit supplier shipping cost.
    // Shopify receives a free checkout rate; the amount is baked into price.
    flat_rate: mode !== "disabled" ? Number(flatRate.toFixed(2)) : 0,
    currency: String(currency || input.currency || "USD").trim().toUpperCase().slice(0, 3),
    country_codes: countries,
    delivery_min_days: minDays ? Math.trunc(minDays) : null,
    delivery_max_days: maxDays ? Math.trunc(maxDays) : null,
  };
}

function hydrate(row, fallbackCurrency = null) {
  if (!row) return {
    id: null,
    connection_id: null,
    ...normalize({}, { currency: fallbackCurrency }),
    shopify_profile_id: null,
    sync_status: "inactive",
    sync_error: null,
  };

  return {
    ...row,
    flat_rate: Number(row.flat_rate || 0),
    country_codes: parseJson(row.country_codes, []) || [],
    delivery_min_days: row.delivery_min_days === null ? null : Number(row.delivery_min_days),
    delivery_max_days: row.delivery_max_days === null ? null : Number(row.delivery_max_days),
  };
}

async function forConnection(connectionId, { currency = null } = {}) {
  const rows = await query(
    "SELECT * FROM shipping_policies WHERE connection_id = ? LIMIT 1",
    [connectionId]
  );
  const policy = hydrate(rows[0], currency);
  policy.connection_id = Number(connectionId);
  return policy;
}

async function save(connectionId, input, { currency = null } = {}) {
  const policy = normalize(input, { currency });
  await pool.query(
    `INSERT INTO shipping_policies
       (connection_id, mode, service_name, flat_rate, currency, country_codes,
        delivery_min_days, delivery_max_days, sync_status, sync_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
     ON DUPLICATE KEY UPDATE
       mode = VALUES(mode), service_name = VALUES(service_name),
       flat_rate = VALUES(flat_rate), currency = VALUES(currency),
       country_codes = VALUES(country_codes),
       delivery_min_days = VALUES(delivery_min_days),
       delivery_max_days = VALUES(delivery_max_days),
       sync_status = 'pending', sync_error = NULL`,
    [
      connectionId, policy.mode, policy.service_name, policy.flat_rate,
      policy.currency, toJsonColumn(policy.country_codes),
      policy.delivery_min_days, policy.delivery_max_days,
    ]
  );
  return forConnection(connectionId, { currency });
}

async function markSynced(connectionId, profileId) {
  await query(
    `UPDATE shipping_policies
        SET shopify_profile_id = ?, sync_status = ?, sync_error = NULL,
            last_synced_at = NOW()
      WHERE connection_id = ?`,
    [profileId || null, profileId ? "synced" : "inactive", connectionId]
  );
}

async function markFailed(connectionId, message) {
  await query(
    `UPDATE shipping_policies
        SET sync_status = 'failed', sync_error = ?
      WHERE connection_id = ?`,
    [String(message || "Shipping profile sync failed").slice(0, 512), connectionId]
  );
}

module.exports = {
  MODES,
  countryCodes,
  normalize,
  hydrate,
  forConnection,
  save,
  markSynced,
  markFailed,
};
