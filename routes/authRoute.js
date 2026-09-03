// routes/authRoutes.js
const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

router.get("/install", authController.installApp);
router.get("/callback", authController.callback);

module.exports = router;