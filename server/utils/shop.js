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

function isValidShopDomain(value) {
  return normalizeShopDomain(value) !== null;
}

module.exports = { normalizeShopDomain, isValidShopDomain, SHOP_DOMAIN_REGEX };
