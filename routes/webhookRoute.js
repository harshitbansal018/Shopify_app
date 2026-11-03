const express = require("express");
const router = express.Router();

const { verifyWebhook } = require("../middleware/verifyWebhook");
const { receive } = require("../services/webhookInbox");

// Raw body is required to compute the HMAC; it must not be JSON-parsed first.
const rawBody = express.raw({ type: "*/*", limit: "2mb" });

router.post(
  "/app/uninstalled",
  rawBody,
  verifyWebhook,
  receive("appUninstalled")
);

/* Product changes at a source store. */
router.post(
  "/products/update",
  rawBody,
  verifyWebhook,
  receive("productsUpdate")
);

router.post(
  "/products/delete",
  rawBody,
  verifyWebhook,
  receive("productsDelete")
);

router.post(
  "/inventory-items/update",
  rawBody,
  verifyWebhook,
  receive("inventoryItemUpdate")
);

router.post(
  "/inventory-levels/update",
  rawBody,
  verifyWebhook,
  receive("inventoryLevelUpdate")
);

router.post(
  "/inventory-levels/connect",
  rawBody,
  verifyWebhook,
  receive("inventoryLevelConnect")
);

router.post(
  "/inventory-levels/disconnect",
  rawBody,
  verifyWebhook,
  receive("inventoryLevelDisconnect")
);

router.post(
  "/collections/update",
  rawBody,
  verifyWebhook,
  receive("collectionsUpdate")
);

// Shopify Product Events are configured in shopify.app.toml rather than via
// webhookSubscriptionCreate. They use Shopify-* headers without the X prefix.
router.post(
  "/events/product",
  rawBody,
  verifyWebhook,
  receive("productEvent")
);

/* Sales. Both cache the order; only orders/create queues it for the source. */
router.post(
  "/orders/create",
  rawBody,
  verifyWebhook,
  receive("ordersCreate")
);

router.post(
  "/orders/updated",
  rawBody,
  verifyWebhook,
  receive("ordersUpdated")
);

/* Mandatory privacy webhooks, configured in the Partner Dashboard. */
router.post("/customers/data_request",rawBody,verifyWebhook,receive("customersDataRequest"));
router.post("/customers/redact",rawBody,verifyWebhook,receive("customersRedact"));
router.post("/shop/redact",rawBody,verifyWebhook,receive("shopRedact"));

module.exports = router;
