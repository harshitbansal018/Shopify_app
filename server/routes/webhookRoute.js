// routes/webhookRoutes.js
const express = require("express");
const router = express.Router();
const webhookController = require("../controllers/webhookController");

router.post("/app/uninstalled", webhookController.appUninstalled);

module.exports = router;