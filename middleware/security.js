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

/**
 * Never let a browser cache an app screen.
 *
 * Every screen is per-merchant and per-moment, and appNavigate() reuses the
 * same id_token for its ~1 minute lifetime -- so navigating right after an
 * action lands on the SAME URL. Without this the browser answers it from
 * cache and shows the state from BEFORE the action, which is why a manual
 * reload appeared to fix things.
 *
 * Mount it after express.static so CSS and JS still cache normally.
 */
function noStore(req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  next();
}

module.exports = { frameAncestors, noStore };
