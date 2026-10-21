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

router.post(
  "/inventory-items/update",
  rawBody,
  verifyWebhook,
  webhookController.inventoryItemUpdate
);

router.post(
  "/inventory-levels/update",
  rawBody,
  verifyWebhook,
  webhookController.inventoryLevelUpdate
);

router.post(
  "/inventory-levels/connect",
  rawBody,
  verifyWebhook,
  webhookController.inventoryLevelConnect
);

router.post(
  "/inventory-levels/disconnect",
  rawBody,
  verifyWebhook,
  webhookController.inventoryLevelDisconnect
);

router.post(
  "/collections/update",
  rawBody,
  verifyWebhook,
  webhookController.collectionsUpdate
);

// Shopify Product Events are configured in shopify.app.toml rather than via
// webhookSubscriptionCreate. They use Shopify-* headers without the X prefix.
router.post(
  "/events/product",
  rawBody,
  verifyWebhook,
  webhookController.productEvent
);

/* Sales. Both cache the order; only orders/create queues it for the source. */
router.post(
  "/orders/create",
  rawBody,
  verifyWebhook,
  webhookController.ordersCreate
);

router.post(
  "/orders/updated",
  rawBody,
  verifyWebhook,
  webhookController.ordersUpdated
);

/* Mandatory privacy webhooks, configured in the Partner Dashboard. */
router.post("/customers/data_request",rawBody,verifyWebhook,webhookController.customersDataRequest);
router.post("/customers/redact",rawBody,verifyWebhook,webhookController.customersRedact);
router.post("/shop/redact",rawBody,verifyWebhook,webhookController.shopRedact);

module.exports = router;
