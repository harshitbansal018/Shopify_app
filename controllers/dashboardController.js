// controllers/dashboardController.js
//
// The only screen this base ships. requireSession has already run, so
// req.shop / req.storeId / req.store are trusted.
const { renderStoreType } = require("./storeController");

exports.getDashboard = async (req, res) => {
  try {
    // A store with no type cannot do anything useful yet -- every feature
    // depends on knowing whether products flow out of it or into it. Render
    // the one-time picker in place rather than redirecting: a redirect would
    // drop the id_token off the URL and bounce the merchant through OAuth.
    if (!req.store.store_type) {
      return renderStoreType(req, res);
    }

    res.render("dashboard", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
    });
  } catch (err) {
    console.error("Dashboard load failed:", err.message);
    res.status(500).send("Error loading dashboard");
  }
};
