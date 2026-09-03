const { query } = require("../config/db");
const { normalizeShopDomain } = require("../utils/shop");

/** Only active rows in dummy_shops are allowed to create Shopify test charges. */
async function isDummyShop(shopName) {
  const shop = normalizeShopDomain(shopName);
  if (!shop) return false;

  const rows = await query(
    `SELECT id FROM dummy_shops
      WHERE shop_name = ? AND status = 1
      LIMIT 1`,
    [shop]
  );

  return Boolean(rows[0]);
}

module.exports = { isDummyShop };
