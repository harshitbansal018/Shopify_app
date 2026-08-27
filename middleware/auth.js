// middleware/auth.js
const { verifySessionToken } = require("../utils/jwt");
const { normalizeShopDomain } = require("../utils/shop");
const {
  escapeHtml,
  serializeForScript,
  topLevelRedirectPage,
} = require("../utils/html");
const { findByDomain } = require("../models/storeModel");

const REAUTHORIZE_HEADER = "X-Shopify-API-Request-Failure-Reauthorize";
const REAUTHORIZE_URL_HEADER =
  "X-Shopify-API-Request-Failure-Reauthorize-Url";

function wantsHtml(req) {
  if (req.method !== "GET") return false;
  return String(req.headers.accept || "").includes("text/html");
}

function extractSessionToken(req) {
  const authorization = req.headers.authorization || "";

  if (authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  // App Bridge appends id_token to top-level navigations inside the admin.
  if (typeof req.query.id_token === "string" && req.query.id_token) {
    return req.query.id_token;
  }

  return null;
}

/**
 * Server-rendered pages are reached by a normal navigation, which may not
 * carry a session token yet. Rather than redirecting (which loops), serve a
 * tiny App Bridge page that fetches a token and reloads once.
 */
function renderTokenBounce(req, res, shop) {
  const target = new URL(
    req.originalUrl,
    process.env.HOST || "https://localhost"
  );
  target.searchParams.delete("id_token");
  target.searchParams.set("shopify-reload", "1");

  res.status(401).type("html").send(`<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="shopify-api-key" content="${escapeHtml(
      process.env.SHOPIFY_API_KEY
    )}">
    <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  </head>
  <body>
    <script>
      (async function () {
        var target = ${serializeForScript(target.pathname + target.search)};
        try {
          var token = await window.shopify.idToken();
          var url = new URL(target, window.location.origin);
          url.searchParams.set("id_token", token);
          window.location.replace(url.toString());
        } catch (error) {
          // No token available: fall back to OAuth, which must happen at the
          // TOP level. The URL is absolute because window.top is on
          // admin.shopify.com, where a relative path would resolve wrongly.
          window.top.location.href = ${serializeForScript(installUrlFor(shop))};
        }
      })();
    </script>
  </body>
</html>`);
}

function installUrlFor(shop) {
  const host = String(process.env.HOST || "").trim().replace(/\/+$/, "");

  return shop
    ? `${host}/api/auth/install?shop=${encodeURIComponent(shop)}`
    : `${host}/api/auth/install`;
}

/**
 * Has this shop installed the app? Only an installed app can mint a session
 * token, so this decides whether an App Bridge bounce is worth attempting.
 */
async function isInstalled(shop) {
  if (!shop) return false;

  try {
    const store = await findByDomain(shop);
    return Boolean(store && store.is_active && store.access_token);
  } catch (err) {
    console.error("Install lookup failed:", err.message);
    return false;
  }
}

async function rejectUnauthenticated(req, res, shop) {
  const installUrl = installUrlFor(shop);

  if (wantsHtml(req)) {
    // The bounce loads App Bridge, which can only mint a session token for an
    // app the shop has ALREADY installed. Loading it for an app that is NOT
    // installed makes App Bridge navigate to
    // admin.shopify.com/store/<shop>/apps/<api-key> -- a page Shopify 404s,
    // because there is no installed app there to open. A shop we have never
    // seen must therefore go straight to OAuth, with no App Bridge involved.
    if (
      shop &&
      req.query["shopify-reload"] !== "1" &&
      (await isInstalled(shop))
    ) {
      return renderTokenBounce(req, res, shop);
    }

    // Either the bounce already failed, or there was nothing to bounce for.
    // Send the merchant through OAuth -- but break out of the admin iframe
    // first. A plain res.redirect() here would load Shopify's login inside
    // the frame, which it refuses.
    console.warn(
      `No usable session token for ${shop || "unknown shop"}; starting OAuth`
    );

    return res
      .status(401)
      .type("html")
      .send(topLevelRedirectPage(installUrl, { title: "Reconnecting" }));
  }

  res.setHeader(REAUTHORIZE_HEADER, "1");
  res.setHeader(REAUTHORIZE_URL_HEADER, installUrl);
  return res.status(401).json({ error: "Unauthorized" });
}

/**
 * Authenticates every embedded-app request with a Shopify session token and
 * pins the request to exactly one shop. `req.shop` is the ONLY trusted shop
 * value downstream — never `req.query.shop`.
 */
async function requireSession(req, res, next) {
  const hintedShop = normalizeShopDomain(req.query.shop);
  const token = extractSessionToken(req);

  if (!token) {
    return await rejectUnauthenticated(req, res, hintedShop);
  }

  let shop;

  try {
    ({ shop } = verifySessionToken(token, {
      apiKey: process.env.SHOPIFY_API_KEY,
      apiSecret: process.env.SHOPIFY_API_SECRET,
    }));
  } catch (err) {
    console.warn("Session token rejected:", err.message);
    return await rejectUnauthenticated(req, res, hintedShop);
  }

  try {
    const store = await findByDomain(shop);

    if (!store || !store.is_active || !store.access_token) {
      return await rejectUnauthenticated(req, res, shop);
    }

    req.shop = shop;
    req.store = store;
    req.storeId = store.id;
    res.locals.shop = shop;

    return next();
  } catch (err) {
    console.error("Session lookup failed:", err.message);
    return res.status(500).send("Authentication error");
  }
}

module.exports = { requireSession };
