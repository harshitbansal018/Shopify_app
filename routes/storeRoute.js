// Both store-level screens share one router, mounted at "/".
const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const {
  getStoreType,
  postStoreType,
  getStores,
  getStoreConnectionStatus,
  postPairingCode,
  postConnect,
  postDeleteStore,
  postResumeStore,
  getSettings,
  postSettings,
  postNotifications,
} = require("../controllers/storeController");
const { getShipping, postShipping } = require("../controllers/shippingController");

// Every route here is behind a verified session token, so req.storeId is the
// only store this request may touch.
router.use(requireSession);

// Chosen once at install, then read-only. There is no route that changes it.
router.get("/store-type", getStoreType);
router.post("/store-type", postStoreType);
// Both roles have one Settings destination in the nav. A destination controls
// incoming product fields; a source controls the checkout shipping policy for
// products it sends. Each underlying handler still checks its own role.
router.get("/settings", (req, res) =>
  req.store.store_type === "source" ? getShipping(req, res) : getSettings(req, res)
);
router.post("/settings", (req, res) =>
  req.store.store_type === "source" ? postShipping(req, res) : postSettings(req, res)
);
// One connection's email switches. Separate from /settings because saving
// them must not re-queue every product the way a sync change does.
router.post("/settings/notifications", postNotifications);
// Backward compatibility for old bookmarks and already-rendered clients.
// New UI lives under /settings; the POST remains valid during deployments.
router.get("/shipping", (req, res) => {
  const connection = typeof req.query.connection === "string"
    ? `?connection=${encodeURIComponent(req.query.connection)}`
    : "";
  return res.redirect(`/settings${connection}`);
});
router.post("/shipping", postShipping);

router.get("/stores", getStores);
router.get("/stores/status", getStoreConnectionStatus);
router.post("/stores/code", postPairingCode); // destination: show a code
router.post("/stores/connect", postConnect); // source: enter a code

// Destination-only, and the destructive one: it deletes the supplier's
// products out of this store's Shopify catalogue before dropping the link.
// Parameterised, so it stays below the fixed paths above it.
router.post("/stores/:id/delete", postDeleteStore);
// Destination-only: bring back a store a downgrade paused, within the plan.
router.post("/stores/:id/resume", postResumeStore);

module.exports = router;
