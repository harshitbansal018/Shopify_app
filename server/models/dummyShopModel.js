const db = require("../config/db");

// ✅ check if shop is dummy
function isDummyShop(shopName) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT * FROM dummy_shop 
      WHERE shop_name = ? AND status = 1
    `;

    db.query(sql, [shopName], (err, results) => {
      if (err) return reject(err);

      resolve(results.length > 0); // true or false
    });
  });
}

module.exports = {
  isDummyShop
};