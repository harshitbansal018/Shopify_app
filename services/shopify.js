// services/shopify.js
const axios = require("axios");
const { normalizeShopDomain } = require("../utils/shop");
const { getAccessToken, refreshAccessToken } = require("./tokens");
const storeModel = require("../models/storeModel");

const DEFAULT_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

const MAX_ATTEMPTS = Number(process.env.SHOPIFY_MAX_ATTEMPTS || 5);
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 16000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shopify throttles two different ways, and both have to be caught:
 *
 *   - REST-style: HTTP 429, usually with a Retry-After header.
 *   - GraphQL: HTTP 200 with a THROTTLED error in the body, because the query
 *     cost exceeded the leaky bucket. Treating that as success would silently
 *     return no data.
 */
function isThrottledBody(body) {
  const errors = body && body.errors;
  if (!Array.isArray(errors)) return false;

  return errors.some(
    (error) =>
      error?.extensions?.code === "THROTTLED" ||
      /throttle/i.test(error?.message || "")
  );
}

/** Retry only what a retry can actually fix. */
function isRetryable(error) {
  if (error.throttled) return true;

  const status = error.response?.status;

  if (status === 429) return true;
  // 5xx is Shopify having a bad moment, not a bad request.
  if (status >= 500 && status < 600) return true;
  // No response at all: timeout, DNS, connection reset.
  if (!error.response && !error.status) return true;

  return false;
}

/**
 * How long to wait before attempt N.
 *
 * Retry-After is authoritative when Shopify sends it. Otherwise exponential
 * backoff with FULL JITTER: without the jitter, fifty products failing at the
 * same moment would all retry at the same moment and throttle again together.
 */
function backoffMs(attempt, error) {
  const retryAfter = Number(error.response?.headers?.["retry-after"]);

  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  }

  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(Math.random() * ceiling);
}

/**
 * Single entry point for Shopify Admin GraphQL calls.
 * Never logs the access token.
 *
 * Retries throttling and transient failures with exponential backoff. A
 * GraphQL userError is NOT retried -- that is a bad request, and sending it
 * again five times just wastes the rate limit.
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
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
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

      if (isThrottledBody(response.data)) {
        const throttled = new Error("Shopify throttled this query");
        throttled.throttled = true;
        throw throttled;
      }

      if (response.data.errors) {
        const message =
          response.data.errors[0]?.message || "Shopify GraphQL error";
        console.error(
          "Shopify GraphQL errors:",
          JSON.stringify(response.data.errors)
        );
        throw new Error(message);
      }

      return response.data.data;
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === MAX_ATTEMPTS - 1) break;

      const wait = backoffMs(attempt, error);

      console.warn(
        `Shopify ${error.throttled ? "throttled" : error.response?.status || "network error"} ` +
          `for ${shopDomain}; retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`
      );

      await sleep(wait);
    }
  }

  if (lastError.response) {
    console.error(
      `Shopify API error (${lastError.response.status}) for ${shopDomain}:`,
      typeof lastError.response.data === "string"
        ? lastError.response.data.slice(0, 500)
        : JSON.stringify(lastError.response.data).slice(0, 500)
    );
  } else {
    console.error(`Shopify API error for ${shopDomain}:`, lastError.message);
  }

  throw lastError;
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
// Exported for the retry tests.
module.exports.isRetryable = isRetryable;
module.exports.isThrottledBody = isThrottledBody;
module.exports.backoffMs = backoffMs;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
