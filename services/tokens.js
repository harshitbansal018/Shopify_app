// services/tokens.js
//
// Shopify no longer issues non-expiring offline access tokens. Every install
// now yields an access token good for ~1 hour plus a refresh token good for
// ~90 days, and the refresh token is ROTATED on each use -- the new one must
// be stored or the shop is locked out.
//
// Everything that talks to the Admin API goes through getAccessToken(), which
// refreshes transparently when the stored token is close to expiry.
const axios = require("axios");

const storeModel = require("../models/storeModel");
const { normalizeShopDomain } = require("../utils/shop");

// Refresh this far ahead of expiry so an in-flight request cannot age out.
const REFRESH_SKEW_MS = 90 * 1000;

/** Raised when the shop must go through OAuth again. */
class ReauthRequiredError extends Error {
  constructor(shop, cause) {
    super(`${shop} must reinstall the app: ${cause}`);
    this.name = "ReauthRequiredError";
    this.shop = shop;
    this.statusCode = 401;
  }
}

// One in-flight refresh per shop, so concurrent requests do not race and
// invalidate each other's rotated refresh token.
const inFlight = new Map();

function expiresAt(seconds) {
  if (!Number.isFinite(Number(seconds))) return null;
  return new Date(Date.now() + Number(seconds) * 1000);
}

function isFresh(shopRecord) {
  if (!shopRecord.access_token) return false;

  // A token stored before the expiring-token migration has no expiry recorded.
  // Treat it as stale so it gets refreshed (or forces a reinstall) rather than
  // being sent to an API that will reject it.
  if (!shopRecord.access_token_expires_at) return false;

  const expiry = new Date(shopRecord.access_token_expires_at).getTime();
  return Number.isFinite(expiry) && expiry - REFRESH_SKEW_MS > Date.now();
}

/**
 * POST the token endpoint. Used for both the initial code exchange and for
 * refreshes -- Shopify returns the same shape either way.
 */
async function requestToken(shop, params) {
  const response = await axios.post(
    `https://${shop}/admin/oauth/access_token`,
    {
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      ...params,
    },
    { timeout: 15000 }
  );

  const data = response.data || {};

  if (!data.access_token) {
    throw new Error("Shopify did not return an access token");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    accessTokenExpiresAt: expiresAt(data.expires_in),
    refreshTokenExpiresAt: expiresAt(data.refresh_token_expires_in),
    scope: data.scope || null,
  };
}

/**
 * Exchange an OAuth authorization code for an expiring offline access token.
 * `expiring: "1"` is required -- without it Shopify rejects the request with
 * "Non-expiring access tokens are no longer accepted for the Admin API".
 */
async function exchangeCodeForToken(shop, code) {
  return requestToken(shop, { code, expiring: "1" });
}

async function refreshAccessToken(shop, shopRecord) {
  if (!shopRecord.refresh_token) {
    throw new ReauthRequiredError(shop, "no refresh token stored");
  }

  if (
    shopRecord.refresh_token_expires_at &&
    new Date(shopRecord.refresh_token_expires_at).getTime() <= Date.now()
  ) {
    throw new ReauthRequiredError(shop, "refresh token has expired");
  }

  let tokens;

  try {
    tokens = await requestToken(shop, {
      grant_type: "refresh_token",
      refresh_token: shopRecord.refresh_token,
    });
  } catch (err) {
    const status = err.response?.status;

    // 400/401 means the refresh token is spent or revoked -- reinstall needed.
    if (status === 400 || status === 401) {
      await storeModel.clearTokens(shop).catch(() => {});
      throw new ReauthRequiredError(shop, `token endpoint returned ${status}`);
    }

    // Anything else (5xx, network) is transient: keep the stored tokens so a
    // retry can still succeed.
    throw err;
  }

  await storeModel.updateTokens(shop, tokens);
  console.log(`Refreshed access token for ${shop}`);

  return tokens.accessToken;
}

/**
 * Returns a currently-valid access token for `shop`, refreshing if needed.
 * Throws ReauthRequiredError when only a reinstall can fix it.
 */
async function getAccessToken(shop) {
  const shopDomain = normalizeShopDomain(shop);

  if (!shopDomain) {
    throw new Error("Refusing to fetch a token for an invalid shop domain");
  }

  const shopRecord = await storeModel.findByDomain(shopDomain);

  if (!shopRecord) {
    throw new ReauthRequiredError(shopDomain, "shop is not installed");
  }

  if (isFresh(shopRecord)) {
    return shopRecord.access_token;
  }

  // Collapse concurrent refreshes for the same shop into one request.
  if (inFlight.has(shopDomain)) {
    return inFlight.get(shopDomain);
  }

  const pending = refreshAccessToken(shopDomain, shopRecord).finally(() => {
    inFlight.delete(shopDomain);
  });

  inFlight.set(shopDomain, pending);

  return pending;
}

module.exports = {
  getAccessToken,
  exchangeCodeForToken,
  refreshAccessToken,
  ReauthRequiredError,
};
