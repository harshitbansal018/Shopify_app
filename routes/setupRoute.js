const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const { getSetup, postSkip } = require("../controllers/setupController");

// Where a store lands the moment it has picked a side, and the app's home
// until setup is finished or skipped. Not behind the onboarding redirect
// itself, or opening it would bounce forever.
router.get("/setup", requireSession, getSetup);
router.post("/setup/skip", requireSession, postSkip);

module.exports = router;
