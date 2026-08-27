// services/shopify.js
const axios = require("axios");
const { normalizeShopDomain } = require("../utils/shop");

const DEFAULT_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

/**
 * Single entry point for Shopify Admin GraphQL calls.
 * Never logs the access token.
 */
async function shopifyRequest(shop, accessToken, apiVersion, queryData) {
  const shopDomain = normalizeShopDomain(shop);

  if (!shopDomain) {
    throw new Error("Refusing to call Shopify with an invalid shop domain");
  }

  if (!accessToken) {
    throw new Error(`No access token stored for ${shopDomain}`);
  }

  const version = apiVersion || DEFAULT_API_VERSION;

  try {
    const response = await axios({
      method: "POST",
      url: `https://${shopDomain}/admin/api/${version}/graphql.json`,
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      data: queryData,
      timeout: Number(process.env.SHOPIFY_TIMEOUT_MS || 15000),
    });

    if (response.data.errors) {
      const message = response.data.errors[0]?.message || "Shopify GraphQL error";
      console.error("Shopify GraphQL errors:", JSON.stringify(response.data.errors));
      throw new Error(message);
    }

    return response.data.data;
  } catch (error) {
    if (error.response) {
      console.error(
        `Shopify API error (${error.response.status}) for ${shopDomain}:`,
        typeof error.response.data === "string"
          ? error.response.data.slice(0, 500)
          : JSON.stringify(error.response.data).slice(0, 500)
      );
    } else {
      console.error(`Shopify API error for ${shopDomain}:`, error.message);
    }
    throw error;
  }
}

module.exports = shopifyRequest;
module.exports.DEFAULT_API_VERSION = DEFAULT_API_VERSION;
