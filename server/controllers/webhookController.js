// controllers/webhookController.js
const db = require("../config/db");


exports.appUninstalled = (req, res) => {
  const shop = req.headers["x-shopify-shop-domain"];

  console.log("❌ App uninstalled for:", shop);

  const query = `UPDATE shops SET status = 0 WHERE shop_name = ?`;

  db.query(query, [shop], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Error updating status");
    }

    console.log("✅ Status updated to 0");
    res.status(200).send("Webhook received");
  });
};