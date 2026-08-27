const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const { getDashboard } = require("../controllers/dashboardController");

// Entry point from the admin. App Bridge keeps shop/host/id_token on the URL,
// so the dashboard renders directly instead of bouncing through a redirect.
router.get("/", requireSession, getDashboard);
router.get("/dashboard", requireSession, getDashboard);

module.exports = router;
