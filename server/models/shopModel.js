const db = require("../config/db");

const saveShop = (shopData) => {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT INTO shops (
        shop_name, access_token,host, shopify_id, name, email, domain,
        country, country_code, country_name,
        currency, money_format,
        timezone, iana_timezone,
        shop_owner,
        address1, address2, city, zip, phone,
        created_at, updated_at,status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        access_token = VALUES(access_token),
        host = VALUES(host),

        email = VALUES(email),
        currency = VALUES(currency),
        updated_at = VALUES(updated_at),
        status = VALUES(status)
    `;

    db.query(
      query,
      [
        shopData.shop_name,
        shopData.access_token,
        shopData.host,
        shopData.shopify_id,
        shopData.name,
        shopData.email,
        shopData.domain,

        shopData.country,
        shopData.country_code,
        shopData.country_name,

        shopData.currency,
        shopData.money_format,

        shopData.timezone,
        shopData.iana_timezone,

        shopData.shop_owner,

        shopData.address1,
        shopData.address2,
        shopData.city,
        shopData.zip,
        shopData.phone,

        shopData.created_at,
        shopData.updated_at,
        shopData.status,

      ],
      (err) => {
        if (err) return reject(err);

        db.query(
          "SELECT id FROM shops WHERE shop_name = ?",
          [shopData.shop_name],
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows[0].id);
          }
        );
      }
    );
  });
};
const getShop = (shop) => {
  return new Promise((resolve, reject) => {

    const sql = `
      SELECT * FROM shops 
      WHERE TRIM(LOWER(shop_name)) = TRIM(LOWER(?)) 
      LIMIT 1
    `;

    db.query(sql, [shop], (err, results) => {
      if (err) return reject(err);

      if (results.length === 0) {
        console.log("❌ Shop not found in DB:", shop);
        return resolve(null);
      }

      console.log("✅ Shop found:", results[0].shop_name);
      resolve(results[0]);
    });

  });
};
// ✅ Get shop by domain
function getShopByDomain(shopDomain) {
  return new Promise((resolve, reject) => {
    const sql = "SELECT * FROM shops WHERE domain = ?";

    db.query(sql, [shopDomain], (err, results) => {
      if (err) {
        console.error("Shop Fetch Error:", err);
        return reject(err);
      }
      resolve(results[0]);
    });
  });
}
module.exports = {
  saveShop,
  getShop,
  getShopByDomain
};