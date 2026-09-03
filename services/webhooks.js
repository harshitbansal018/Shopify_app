// services/webhooks.js
const shopifyRequest = require("./shopify");

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

const WEBHOOK_CREATE_MUTATION = `
  mutation webhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: $webhookSubscription
    ) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

/**
 * Topics registered at install time.
 *
 * The three mandatory privacy topics (customers/data_request,
 * customers/redact, shop/redact) are NOT registered here -- Shopify calls
 * those on the URLs configured in the Partner Dashboard. Their handlers live
 * in controllers/webhookController.js.
 *
 * Add a topic here and a matching route in routes/webhookRoute.js.
 */
const TOPICS = [
  { topic: "APP_UNINSTALLED", path: "/webhooks/app/uninstalled" },

  // How a change at the source is noticed at all. Registered on every store
  // because the role is not chosen until after install; the handler ignores
  // anything from a store that is not a source.
  //
  // That filter is also what stops a loop: writing a product to a destination
  // makes THAT store fire products/update straight back at us.
  { topic: "PRODUCTS_UPDATE", path: "/webhooks/products/update" },
  { topic: "PRODUCTS_DELETE", path: "/webhooks/products/delete" },

  // Sales. A destination order is what raises the matching order at whichever
  // source stores supplied the goods; a source order is only cached.
  //
  // Registered on every store for the same reason as the product topics: the
  // role is not known at install time. Both need read_orders, and placing the
  // order at the source needs write_orders.
  { topic: "ORDERS_CREATE", path: "/webhooks/orders/create" },
  // Keeps financial_status, fulfillment_status and the lines current. It never
  // raises a source order -- claim() is keyed on the sale, so a redelivery
  // updates the row it already has instead of placing a second order.
  { topic: "ORDERS_UPDATED", path: "/webhooks/orders/updated" },
];

async function registerWebhooks(shop, accessToken) {
  const host = String(process.env.HOST || "").trim().replace(/\/+$/, "");

  if (!host) {
    console.warn("HOST is not set; skipping webhook registration");
    return;
  }

  for (const { topic, path } of TOPICS) {
    try {
      const data = await shopifyRequest(shop, accessToken, API_VERSION, {
        query: WEBHOOK_CREATE_MUTATION,
        variables: {
          topic,
          webhookSubscription: {
            callbackUrl: `${host}${path}`,
            format: "JSON",
          },
        },
      });

      const errors = data.webhookSubscriptionCreate?.userErrors || [];
      const alreadyExists = errors.some((error) =>
        String(error.message || "").toLowerCase().includes("already")
      );

      if (errors.length && !alreadyExists) {
        console.warn(`Webhook ${topic} not registered:`, errors[0].message);
      }
    } catch (err) {
      // A failed webhook registration must not block the install.
      console.warn(`Webhook ${topic} registration failed:`, err.message);
    }
  }
}

module.exports = { registerWebhooks, TOPICS };
