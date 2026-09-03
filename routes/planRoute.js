const express = require("express");
const { requireSession } = require("../middleware/auth");
const {
  getPlans,
  postSelectPlan,
  confirmPlan,
} = require("../controllers/planController");

const router = express.Router();

// Shopify's top-level approval screen returns without an App Bridge token.
router.get("/confirm", confirmPlan);

router.use(requireSession);
router.get("/", getPlans);
router.post("/select", postSelectPlan);

module.exports = router;
