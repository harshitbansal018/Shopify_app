// controllers/authController.js
const axios = require("axios");
const crypto = require("crypto");

const { upsertStore } = require("../models/storeModel");
const { registerWebhooks } = require("../services/webhooks");
const { exchangeCodeForToken } = require("../services/tokens");
const { normalizeShopDomain, coerceShopDomain } = require("../utils/shop");
const { topLevelRedirectPage } = require("../utils/html");
const { parseCookies, setCookie, clearCookie } = require("../utils/cookies");

const STATE_COOKIE = "shopify_oauth_state";
const STATE_TTL_SECONDS = 600;
// Read the source catalogue, write it to the destination, and keep stock in
// step. Changing this forces every merchant to reinstall, so add a scope only
// when the feature that needs it is actually being built.
const SCOPES =
  process.env.SHOPIFY_SCOPES ||
  "read_products,write_products,read_inventory,write_inventory";
const REST_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

function appHost() {
  return String(process.env.HOST || "").trim().replace(/\/+$/, "");
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");

  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ===================== INSTALL ===================== */

exports.installApp = async (req, res) => {
  const host = appHost();

  if (!host || !process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
    console.error("HOST / SHOPIFY_API_KEY / SHOPIFY_API_SECRET must be configured");
    return res.status(500).send("App is not configured");
  }

  // Shopify appends ?shop= to every App Store install and every embedded
  // load, so it is normally already here and the merchant types nothing.
  // Reaching this route without it means someone opened the app directly,
  // with nothing to say which of the installed stores they mean -- so ask.
  const typed = req.query.shop;
  const shop = coerceShopDomain(typed);

  if (!shop) {
    const attempted = typeof typed === "string" && typed.trim() !== "";

    return res.status(attempted ? 400 : 200).render("install", {
      error: attempted
        ? "That does not look like a Shopify store address."
        : null,
      value: attempted ? typed : "",
    });
  }

  // CSRF nonce: sent to Shopify as `state` and stored in a cookie so the
  // callback can prove the response belongs to a flow we started.
  const state = crypto.randomBytes(32).toString("hex");

  setCookie(res, STATE_COOKIE, `${state}:${shop}`, {
    maxAge: STATE_TTL_SECONDS,
    sameSite: "Lax",
    secure: host.startsWith("https://"),
  });

  const redirectUri = `${host}/api/auth/callback`;

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(process.env.SHOPIFY_API_KEY)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${encodeURIComponent(state)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  // Always escape the frame before starting OAuth. Shopify's login lives on
  // accounts.shopify.com, which refuses to be framed, so an in-frame redirect
  // dead-ends at "accounts.shopify.com refused to connect". When the app is
  // not framed, window.top is window, so this is correct there too.
  return res
    .type("html")
    .send(topLevelRedirectPage(installUrl, { title: "Connecting to Shopify" }));
};

/* ===================== CALLBACK ===================== */

exports.callback = async (req, res) => {
  const shop = normalizeShopDomain(req.query.shop);
  const { hmac, code, state } = req.query;

  if (!shop || !code) {
    return res.status(400).send("Missing required parameters");
  }

  try {
    /* --- 1. state (CSRF) --- */
    const cookies = parseCookies(req);
    const storedState = cookies[STATE_COOKIE];
    clearCookie(res, STATE_COOKIE);

    if (!storedState || !state) {
      return res.status(403).send("OAuth state missing");
    }

    const [expectedState, expectedShop] = storedState.split(":");

    if (
      !expectedState ||
      !timingSafeEqualString(expectedState, state) ||
      expectedShop !== shop
    ) {
      console.warn("OAuth state validation failed for", shop);
      return res.status(403).send("OAuth state validation failed");
    }

    /* --- 2. HMAC --- */
    const params = { ...req.query };
    delete params.hmac;
    delete params.signature;

    const message = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join("&");

    const generatedHash = crypto
      .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
      .update(message)
      .digest("hex");

    if (typeof hmac !== "string" || !timingSafeEqualString(generatedHash, hmac)) {
      console.warn("HMAC validation failed for", shop);
      return res.status(400).send("HMAC validation failed");
    }

    /* --- 3. code -> expiring offline access token ---
       Shopify rejects non-expiring tokens, so this asks for the expiring
       variant and keeps the refresh token for later renewals. */
    const tokens = await exchangeCodeForToken(shop, code);
    const accessToken = tokens.accessToken;

    /* --- 4. shop details --- */
    const shopRes = await axios.get(
      `https://${shop}/admin/api/${REST_API_VERSION}/shop.json`,
      {
        headers: { "X-Shopify-Access-Token": accessToken },
        timeout: 15000,
      }
    );

    const data = shopRes.data.shop;

    // Tokens are encrypted inside storeModel; they are never written in the
    // clear. store_type is not passed here on purpose -- a reinstall must not
    // reset the merchant's source/destination choice.
    const store = await upsertStore({
      shop_domain: shop,
      store_name: data.name,
      currency: data.currency,
      api_version: REST_API_VERSION,
      access_token: accessToken,
      access_token_expires_at: tokens.accessTokenExpiresAt,
      refresh_token: tokens.refreshToken,
      refresh_token_expires_at: tokens.refreshTokenExpiresAt,
      installed_at: new Date(),
    });

    /* --- 5. webhooks --- */
    await registerWebhooks(shop, accessToken);

    console.log(`App installed for ${shop} (store id ${store.id})`);

    /* --- 6. back into the embedded admin --- */
    return res.redirect(
      `https://${shop}/admin/apps/${encodeURIComponent(
        process.env.SHOPIFY_API_KEY
      )}`
    );
  } catch (err) {
    console.error("OAuth callback failed:", err.response?.data || err.message);
    return res.status(500).send("Installation failed. Please try again.");
  }
};

/* ===================== EXPORTS ===================== */

exports.STATE_COOKIE = STATE_COOKIE;
