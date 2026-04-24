// controllers/webhookController.js

const db = require("../config/db");

exports.appUninstalled = (req, res) => {
  const shop = req.headers["x-shopify-shop-domain"];

  console.log("❌ App uninstalled for:", shop);

  // 🔥 STEP 1: Get shop ID
  const getShopQuery = `SELECT id FROM shops WHERE shop_name = ?`;

  db.query(getShopQuery, [shop], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Error fetching shop");
    }

    if (result.length === 0) {
      console.log("⚠️ Shop not found");
      return res.status(200).send("Shop not found");
    }

    const shopId = result[0].id;

    // 🔥 STEP 2: Delete membership
    const deleteMembershipQuery = `
      DELETE FROM memberships 
      WHERE shop_id = ?
    `;

    db.query(deleteMembershipQuery, [shopId], (err) => {
      if (err) {
        console.error(err);
        return res.status(500).send("Error deleting membership");
      }

      console.log("🗑 Membership deleted");

      // 🔥 STEP 3: Update shop status
      const updateShopQuery = `
        UPDATE shops 
        SET status = 0 
        WHERE id = ?
      `;

      db.query(updateShopQuery, [shopId], (err) => {
        if (err) {
          console.error(err);
          return res.status(500).send("Error updating shop");
        }

        console.log("✅ Shop status set to inactive");

        res.status(200).send("Webhook handled successfully");
      });
    });
  });
};