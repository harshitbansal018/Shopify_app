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
