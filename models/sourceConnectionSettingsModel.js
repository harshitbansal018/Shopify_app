// Source-owned feature switches for one source -> destination connection.
// These are separate from sync_settings because that table belongs to the
// destination merchant. A feature runs only when both sides' relevant gates
// allow it.
const { query, pool } = require("../config/db");

function defaults(connectionId = null) {
  return {
    connection_id: connectionId,
    sync_taxes: false,
    tax_rate_percent: null,
  };
}

function hydrate(row, connectionId = null) {
  if (!row) return defaults(connectionId);
  return {
    connection_id: Number(row.connection_id),
    sync_taxes: Boolean(row.sync_taxes),
    tax_rate_percent:
      row.tax_rate_percent === null || row.tax_rate_percent === undefined
        ? null
        : Number(row.tax_rate_percent),
  };
}

async function forConnection(connectionId) {
  const rows = await query(
    "SELECT connection_id, sync_taxes, tax_rate_percent FROM source_connection_settings WHERE connection_id = ? LIMIT 1",
    [connectionId]
  );
  return hydrate(rows[0], Number(connectionId));
}

async function save(connectionId, input = {}) {
  const syncTaxes = input.sync_taxes === true ? 1 : 0;
  const rawRate = input.tax_rate_percent;
  const rateMissing = rawRate === null || rawRate === undefined || rawRate === "";
  const rate = rateMissing ? null : Number(rawRate);

  if (syncTaxes && rateMissing) {
    const error = new Error("Enter a supplier tax rate when tax sync is enabled.");
    error.statusCode = 400;
    throw error;
  }
  if (!rateMissing && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
    const error = new Error("Supplier tax rate must be between 0% and 100%.");
    error.statusCode = 400;
    throw error;
  }

  const normalizedRate = rateMissing ? null : Number(rate.toFixed(4));
  await pool.query(
    `INSERT INTO source_connection_settings
       (connection_id, sync_taxes, tax_rate_percent)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       sync_taxes = VALUES(sync_taxes),
       tax_rate_percent = VALUES(tax_rate_percent)`,
    [connectionId, syncTaxes, normalizedRate]
  );
  return forConnection(connectionId);
}

module.exports = { defaults, hydrate, forConnection, save };
