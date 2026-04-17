const express = require("express");
const router = express.Router();

const upload = require("../middleware/upload"); // ✅ ADD THIS

const {
  showCreatePage,
  handleCreatePage,
  getSinglePage,
  handleDeletePage,
} = require("../controllers/pageController");

// 👉 SHOW UI
router.get("/create", showCreatePage);

// 👉 CREATE PAGE (FIXED)
router.post(
  "/create",
  upload.single("heroImage"), // 🔥 THIS FIXES YOUR ISSUE
  handleCreatePage
);

// 👉 GET SINGLE PAGE
router.get("/:id", getSinglePage);
router.delete("/delete/:id", handleDeletePage);

module.exports = router;