// models/helpers.js
// Shared row-shaping helpers. MariaDB stores JSON as LONGTEXT, so mysql2 hands
// those columns back as strings -- every model parses them at its boundary so
// callers only ever see real objects.

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Shopify ids arrive as numbers or numeric strings; store them consistently. */
function toShopifyId(value) {
  if (value === null || value === undefined || value === "") return null;

  const text = String(value);

  // Accept a GID (gid://shopify/Product/123) as well as a bare id.
  const match = text.match(/(\d+)\s*$/);
  return match ? match[1] : null;
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = { parseJson, toJsonColumn, toShopifyId, toDate };
