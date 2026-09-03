// Both store-level screens share one router, mounted at "/".
const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const {
  getStoreType,
  postStoreType,
  getStores,
  postPairingCode,
  postConnect,
  getSettings,
  postSettings,
} = require("../controllers/storeController");

// Every route here is behind a verified session token, so req.storeId is the
// only store this request may touch.
router.use(requireSession);

// Chosen once at install, then read-only. There is no route that changes it.
router.get("/store-type", getStoreType);
router.post("/store-type", postStoreType);
// Destination-only: everything on this screen is about what THIS store
// accepts, which a source has no say in. The handlers re-check the role.
router.get("/settings", getSettings);
router.post("/settings", postSettings);

router.get("/stores", getStores);
router.post("/stores/code", postPairingCode); // destination: show a code
router.post("/stores/connect", postConnect); // source: enter a code

module.exports = router;
