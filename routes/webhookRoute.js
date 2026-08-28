const express = require("express");
const router = express.Router();

const { verifyWebhook } = require("../middleware/verifyWebhook");
const webhookController = require("../controllers/webhookController");

// Raw body is required to compute the HMAC; it must not be JSON-parsed first.
const rawBody = express.raw({ type: "*/*", limit: "2mb" });

router.post(
  "/app/uninstalled",
  rawBody,
  verifyWebhook,
  webhookController.appUninstalled
);

/* Product changes at a source store. */
router.post(
  "/products/update",
  rawBody,
  verifyWebhook,
  webhookController.productsUpdate
);

router.post(
  "/products/delete",
  rawBody,
  verifyWebhook,
  webhookController.productsDelete
);

/* Mandatory privacy webhooks, configured in the Partner Dashboard. */
router.post(
  "/customers/data_request",
  rawBody,
  verifyWebhook,
  webhookController.customersDataRequest
);

router.post(
  "/customers/redact",
  rawBody,
  verifyWebhook,
  webhookController.customersRedact
);

router.post(
  "/shop/redact",
  rawBody,
  verifyWebhook,
  webhookController.shopRedact
);

module.exports = router;
