// services/shopify.js
const axios = require("axios");
const { normalizeShopDomain } = require("../utils/shop");
const { getAccessToken, refreshAccessToken } = require("./tokens");
const storeModel = require("../models/storeModel");

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

/**
 * The call you almost always want.
 *
 * Resolves the shop's CURRENT access token before every request, which is what
 * makes expiring tokens a non-issue: services/tokens.js refreshes ~90s ahead of
 * expiry and rotates the refresh token, so callers never see a 401 from a token
 * simply ageing out.
 *
 * Use shopifyRequest directly ONLY when a token is already in hand and the
 * store row does not exist yet -- i.e. during the OAuth callback.
 *
 * Throws ReauthRequiredError when nothing but a reinstall can fix it.
 */
async function shopifyRequestForShop(shop, queryData, options = {}) {
  const { apiVersion } = options;
  const accessToken = await getAccessToken(shop);

  try {
    return await shopifyRequest(shop, accessToken, apiVersion, queryData);
  } catch (error) {
    // A token can still be rejected inside the refresh skew: revoked, scopes
    // changed, or the clock drifted. Force one refresh and retry exactly once,
    // so a genuine 401 surfaces rather than looping.
    if (error.response?.status !== 401) throw error;

    console.warn(`401 from Shopify for ${shop}; forcing a token refresh`);

    const store = await storeModel.findByDomain(shop);

    if (!store) throw error;

    const refreshed = await refreshAccessToken(shop, store);

    return shopifyRequest(shop, refreshed, apiVersion, queryData);
  }
}

module.exports = shopifyRequest;
module.exports.forShop = shopifyRequestForShop;
module.exports.DEFAULT_API_VERSION = DEFAULT_API_VERSION;
