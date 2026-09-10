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

/**
 * A merchant's search box turned into a LIKE pattern.
 *
 * The wildcards are ESCAPED. Without this, typing "50%" would match every
 * product in the store and typing "_" would match every single-character
 * title -- a search box that silently ignores what you typed is worse than no
 * search box, because the results look real.
 *
 * Backslash is MariaDB's default LIKE escape character, so it needs no ESCAPE
 * clause -- but it has to be escaped first, or a stray one would swallow the
 * character after it.
 *
 * Returns null for nothing worth searching, which every caller reads as "no
 * filter" rather than as "match the empty string".
 */
function likePattern(value, { maxLength = 100 } = {}) {
  if (value === null || value === undefined) return null;

  const text = String(value).trim().slice(0, maxLength);

  if (!text) return null;

  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");

  return `%${escaped}%`;
}

module.exports = { parseJson, toJsonColumn, toShopifyId, toDate, likePattern };
