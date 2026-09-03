const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const {
  getProducts,
  getProduct,
  postImport,
  postAllow,
  postResetVariants,
  postRemoveVariant,
  postDeleteProduct,
  postSync,
  postAccept,
  postDecline,
} = require("../controllers/productController");

// Every route here is behind a verified session token, so req.storeId is the
// only store this request may touch.
router.use(requireSession);

router.get("/", getProducts);

// Source-only. Each handler re-checks the role: a route being unreachable in
// the UI is not the same as it being unreachable.
//
// There is no "list available products" route: App Bridge's resource picker
// reads the catalogue in the browser, so the only thing that reaches the
// server is the ids the merchant chose.
router.post("/import", postImport); // picked -> source_products
router.post("/allow", postAllow); // table -> offered to destinations
router.post("/reset-variants", postResetVariants); // undo a narrowed selection

// Destination-only. The source decides WHAT may be shared; the destination
// decides WHEN its own store is written to. There is deliberately no route a
// source can call to push.
router.post("/accept", postAccept); // tick + pull in
router.post("/sync", postSync); // refresh what is already accepted
router.post("/decline", postDecline); // stop receiving

// Parameterised routes LAST: "/:id" would otherwise swallow "/sync" and every
// other fixed path above it.
router.get("/:id", getProduct); // one product's shared variants
router.post("/:id/variants/remove", postRemoveVariant); // drop one variant
router.post("/:id/delete", postDeleteProduct); // here AND on the destinations

module.exports = router;
