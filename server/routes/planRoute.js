const express = require("express");
const router = express.Router();

const planController = require("../controllers/planController");
const membershipController = require("../controllers/membershipController");

// Plans
router.get("/plans", planController.getPlansPage);
router.post("/plans/buy/:id", planController.buyPlan);

// Membership
router.get("/plans/confirm", membershipController.confirmPlan);

module.exports = router;