// utils/shop.js
const SHOP_DOMAIN_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Returns the normalised shop domain, or null when the value is not a
 * legitimate *.myshopify.com host. Everything that accepts a `shop` value
 * from the outside world MUST go through this.
 */
function normalizeShopDomain(value) {
  if (typeof value !== "string") return null;

  const shop = value.trim().toLowerCase();

  if (!shop || shop.length > 255) return null;
  if (!SHOP_DOMAIN_REGEX.test(shop)) return null;

  return shop;
}

/**
 * The same thing, but forgiving about what a HUMAN typed into a form.
 *
 * Shopify always sends a clean `shop` param, so this is only for the install
 * landing page, where a merchant may reasonably type any of:
 *
 *   mystore
 *   mystore.myshopify.com
 *   https://mystore.myshopify.com/admin/products
 *   admin.shopify.com/store/mystore        <- what the admin URL bar shows
 *
 * The result still goes through normalizeShopDomain, so this widens what may
 * be TYPED without widening what the app will ACCEPT.
 */
function coerceShopDomain(value) {
  if (typeof value !== "string") return null;

  let raw = value.trim().toLowerCase();

  if (!raw) return null;

  // Drop a scheme, then everything after the host.
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");

  // The modern admin URL carries the handle in the path, not the host.
  const adminMatch = raw.match(/^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/);
  if (adminMatch) return normalizeShopDomain(`${adminMatch[1]}.myshopify.com`);

  raw = raw.split("/")[0].split("?")[0].split("#")[0];
  raw = raw.replace(/:\d+$/, ""); // stray port

  // A bare handle is the most common thing a merchant types.
  if (raw && !raw.includes(".")) raw = `${raw}.myshopify.com`;

  return normalizeShopDomain(raw);
}

function isValidShopDomain(value) {
  return normalizeShopDomain(value) !== null;
}

/** Safe direct URL to a record in a specific Shopify Admin. */
function shopifyAdminUrl(shopDomain, resource, id) {
  const shop = normalizeShopDomain(shopDomain);
  const allowed = new Set(["products", "orders"]);
  const resourceName = String(resource || "").toLowerCase();
  const recordId = String(id || "").split("/").pop();

  if (!shop || !allowed.has(resourceName) || !/^\d+$/.test(recordId)) return null;
  return `https://${shop}/admin/${resourceName}/${recordId}`;
}

module.exports = {
  normalizeShopDomain,
  coerceShopDomain,
  isValidShopDomain,
  shopifyAdminUrl,
  SHOP_DOMAIN_REGEX,
};
