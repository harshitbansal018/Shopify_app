const express = require("express");
const router = express.Router();
const { getDashboard } = require("../controllers/dashboardController");

// ✅ ROOT ROUTE (IMPORTANT FIX)
router.get("/", (req, res) => {
  const shop = req.query.shop;
  const host = req.query.host;

  // If no shop → prevent crash
  if (!shop || !host) {
    return res.send("Missing shop or host ❌");
  }

  // ✅ Redirect to dashboard WITH query
  res.redirect(`/dashboard?shop=${shop}&host=${host}`);
});

// ✅ Dashboard route
router.get("/dashboard", getDashboard);

module.exports = router;