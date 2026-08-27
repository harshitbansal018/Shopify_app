// middleware/security.js
const { normalizeShopDomain } = require("../utils/shop");

/**
 * Shopify requires an embedded app to allow framing by the merchant's admin
 * only. Without this header the app cannot render inside the admin iframe.
 */
function frameAncestors(req, res, next) {
  const shop =
    normalizeShopDomain(req.query.shop) ||
    normalizeShopDomain(res.locals && res.locals.shop);

  const ancestors = shop
    ? `frame-ancestors https://${shop} https://admin.shopify.com`
    : "frame-ancestors https://*.myshopify.com https://admin.shopify.com";

  res.setHeader("Content-Security-Policy", ancestors);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
  next();
}

module.exports = { frameAncestors };
