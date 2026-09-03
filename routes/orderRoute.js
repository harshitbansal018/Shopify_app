const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const {
  getOrders,
  getOrder,
  postRetry,
} = require("../controllers/orderController");

// Every route here is behind a verified session token, so req.storeId is the
// only store this request may read.
router.use(requireSession);

router.get("/", getOrders);

// Parameterised routes LAST, for the same reason as in productRoute.js: "/:id"
// would otherwise swallow any fixed path added above it.
router.get("/:id", getOrder);
router.post("/:id/retry", postRetry); // destination-only; re-checked in the handler

module.exports = router;
