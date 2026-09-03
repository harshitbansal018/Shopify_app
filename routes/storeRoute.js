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
} = require("../controllers/storeController");

// Every route here is behind a verified session token, so req.storeId is the
// only store this request may touch.
router.use(requireSession);

// Chosen once at install, then read-only. There is no route that changes it.
router.get("/store-type", getStoreType);
router.post("/store-type", postStoreType);
router.get("/stores", getStores);
router.post("/stores/code", postPairingCode); // destination: show a code
router.post("/stores/connect", postConnect); // source: enter a code

module.exports = router;
