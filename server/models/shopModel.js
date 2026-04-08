const db = require("../config/db");

const saveShop = (shopData) => {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT INTO shops (
        shop_name, access_token, shopify_id, name, email, domain,
        country, country_code, country_name,
        currency, money_format,
        timezone, iana_timezone,
        shop_owner,
        address1, address2, city, zip, phone,
        created_at, updated_at,status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        access_token = VALUES(access_token),
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

module.exports = { saveShop };