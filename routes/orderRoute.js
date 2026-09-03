const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const {
  getOrders,
  getOrder,
  postFulfil,
  postUnfulfil,
  postCancel,
} = require("../controllers/orderController");

// Every route here is behind a verified session token, so req.storeId is the
// only store this request may read.
router.use(requireSession);

router.get("/", getOrders);

// Parameterised routes LAST, for the same reason as in productRoute.js: "/:id"
// would otherwise swallow any fixed path added above it.
router.get("/:id", getOrder);

// Source-only. Each handler re-checks the role and that the sale belongs to
// this store: a route being unreachable in the UI is not the same as it being
// unreachable.
router.post("/:id/fulfil", postFulfil); // shipped, with tracking
router.post("/:id/unfulfil", postUnfulfil); // shipped by mistake
router.post("/:id/cancel", postCancel); // cannot supply -- refunds the shopper

module.exports = router;
