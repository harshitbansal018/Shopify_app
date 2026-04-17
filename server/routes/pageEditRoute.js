const express = require("express");
const router = express.Router();
const upload = require("../middleware/upload");

const {
  showEditPage,
  updatePage,
  showSingleBlockEdit,
  addBlock,        // ✅ NEW
  deleteBlock      // ✅ NEW
} = require("../controllers/pageEditController");

/* =========================
   👉 EDITOR UI
========================= */
router.get("/pages/editor/:id", showEditPage);
router.get("/pages/editor/:id/block/:index", showSingleBlockEdit);

/* =========================
   👉 BLOCK OPERATIONS (SEPARATE)
========================= */
router.get("/pages/add-block/:id", addBlock);
router.get("/pages/delete-block/:id", deleteBlock);

/* =========================
   👉 UPDATE FULL PAGE
========================= */
router.put("/pages/:id", upload.single("heroImage"), updatePage);
router.get("/pages/add-block-form/:id", (req, res) => {
  res.render("pageForm", {
    pageId: req.params.id
  });
});

module.exports = router;
