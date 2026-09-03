const crypto = require("crypto");
const shopify = require("./shopify");

const CREATE_SUBSCRIPTION = `
  mutation AppSubscriptionCreate(
    $name: String!
    $returnUrl: URL!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $test: Boolean
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      lineItems: $lineItems
      test: $test
    ) {
      appSubscription { id status }
      confirmationUrl
      userErrors { field message }
    }
  }
`;

const SUBSCRIPTION_STATUS = `
  query AppSubscriptionStatus($id: ID!) {
    node(id: $id) {
      ... on AppSubscription { id name status }
    }
  }
`;

const CANCEL_SUBSCRIPTION = `
  mutation AppSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }
`;

function secret() {
  return process.env.SHOPIFY_API_SECRET || "";
}

function signPayload(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

function createReturnToken(storeId, planId) {
  const payload = Buffer.from(
    JSON.stringify({ storeId, planId, createdAt: Date.now() })
  ).toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

function verifyReturnToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return null;

  const expected = signPayload(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) return null;

  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      !Number.isInteger(value.storeId) || value.storeId < 1 ||
      !Number.isInteger(value.planId) || value.planId < 1
    ) return null;
    // Shopify subscriptions may remain pending for up to two days.
    if (!value.createdAt || Date.now() - value.createdAt > 2 * 24 * 60 * 60 * 1000) {
      return null;
    }
    return value;
  } catch (error) {
    return null;
  }
}

function numericId(gid) {
  const value = String(gid || "").split("/").pop();
  return /^\d+$/.test(value) ? value : null;
}

async function createSubscription(store, plan, { test = false } = {}) {
  const token = createReturnToken(store.id, plan.id);
  const host = String(process.env.HOST || "").replace(/\/+$/, "");
  const returnUrl = `${host}/plans/confirm?billing_token=${encodeURIComponent(token)}`;

  const data = await shopify.forShop(
    store.shop_domain,
    {
      query: CREATE_SUBSCRIPTION,
      variables: {
        name: `${plan.name} Plan`,
        returnUrl,
        test,
        lineItems: [{
          plan: {
            appRecurringPricingDetails: {
              price: { amount: Number(plan.price), currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        }],
      },
    },
    { apiVersion: store.api_version }
  );

  const result = data.appSubscriptionCreate;
  if (result.userErrors.length) {
    const error = new Error(result.userErrors.map((item) => item.message).join(" "));
    error.statusCode = 400;
    throw error;
  }

  const chargeId = numericId(result.appSubscription && result.appSubscription.id);
  if (!chargeId || !result.confirmationUrl) {
    throw new Error("Shopify did not return a subscription approval URL.");
  }

  return { chargeId, confirmationUrl: result.confirmationUrl, test };
}

async function subscriptionStatus(store, chargeId) {
  const data = await shopify.forShop(
    store.shop_domain,
    {
      query: SUBSCRIPTION_STATUS,
      variables: { id: `gid://shopify/AppSubscription/${chargeId}` },
    },
    { apiVersion: store.api_version }
  );

  return data.node ? data.node.status : null;
}

async function cancelSubscription(store, chargeId) {
  const data = await shopify.forShop(
    store.shop_domain,
    {
      query: CANCEL_SUBSCRIPTION,
      variables: { id: `gid://shopify/AppSubscription/${chargeId}` },
    },
    { apiVersion: store.api_version }
  );

  const result = data.appSubscriptionCancel;
  if (result.userErrors.length) {
    const error = new Error(result.userErrors.map((item) => item.message).join(" "));
    error.statusCode = 400;
    throw error;
  }

  return result.appSubscription;
}

module.exports = {
  createSubscription,
  subscriptionStatus,
  cancelSubscription,
  verifyReturnToken,
  numericId,
};
