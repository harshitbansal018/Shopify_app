const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const {
  getPayouts,
  getSupplier,
  postPayment,
  deletePayment,
} = require("../controllers/payoutController");

// Every route here is behind a verified session token, so req.storeId is the
// only store this request may read.
router.use(requireSession);

router.get("/", getPayouts);

// Parameterised routes LAST, for the same reason as in productRoute.js: "/:id"
// would otherwise swallow any fixed path added above it.
router.get("/:id", getSupplier);

// Destination-only. Each handler re-checks the role and that the connection
// belongs to this store: a route being unreachable in the UI is not the same
// as it being unreachable.
router.post("/:id/payments", postPayment);
router.post("/:id/payments/:paymentId/delete", deletePayment);

module.exports = router;
