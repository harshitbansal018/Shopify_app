/* Functional test for the security-critical paths.
 * Stubs config/db so no MySQL server is needed. */
const path = require("path");
const crypto = require("crypto");
const Module = require("module");

const SERVER = path.join(__dirname, "..");

process.env.SHOPIFY_API_KEY = "test_api_key";
process.env.SHOPIFY_API_SECRET = "test_api_secret";
process.env.HOST = "https://example.com";
// storeModel encrypts tokens at rest, so the stub needs a key too.
process.env.TOKEN_ENCRYPTION_KEY = "0".repeat(64);

/* ---------- stub the DB ---------- */
const { encrypt } = require(path.join(SERVER, "utils/crypto"));

const dbPath = require.resolve(path.join(SERVER, "config/db.js"));
const state = { shopStatus: 1, queries: [] };

const fakeDb = {
  pool: { query: async () => [[], []] },
  async query(sql, params) {
    state.queries.push([sql.replace(/\s+/g, " ").trim().slice(0, 60), params]);

    if (/FROM stores WHERE shop_domain/.test(sql)) {
      if (params[0] !== "good-shop.myshopify.com") return [];
      return [
        {
          id: 7,
          shop_domain: "good-shop.myshopify.com",
          // Stored encrypted, exactly as the real column would be.
          access_token: encrypt("shpat_token"),
          access_token_expires_at: new Date(Date.now() + 3600_000),
          is_active: state.shopStatus,
          store_type: "both",
          api_version: "2025-01",
        },
      ];
    }
    return [];
  },
  async withTransaction(fn) {
    return fn({ query: async () => [[], []] });
  },
  async assertConnection() {},
};

require.cache[dbPath] = new Module(dbPath, null);
require.cache[dbPath].filename = dbPath;
require.cache[dbPath].loaded = true;
require.cache[dbPath].exports = fakeDb;

/* ---------- build an app that mirrors server.js ---------- */
const express = require("express");
const { requireSession } = require(path.join(SERVER, "middleware/auth"));
const webhookRoutes = require(path.join(SERVER, "routes/webhookRoute"));
const authController = require(path.join(SERVER, "controllers/authController"));
const { serializeForScript } = require(path.join(SERVER, "utils/html"));

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(SERVER, "views"));
app.locals.json = serializeForScript;

app.use("/webhooks", webhookRoutes);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/api/auth/install", authController.installApp);
app.get("/api/auth/callback", authController.callback);
app.get("/protected", requireSession, (req, res) =>
  res.json({ shop: req.shop, storeId: req.storeId })
);

/* ---------- helpers ---------- */
function makeToken(overrides = {}, secret = process.env.SHOPIFY_API_SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: "https://good-shop.myshopify.com/admin",
    dest: "https://good-shop.myshopify.com",
    aud: process.env.SHOPIFY_API_KEY,
    sub: "1",
    exp: now + 60,
    nbf: now - 10,
    iat: now,
    jti: "1",
    sid: "abc",
    ...overrides,
  };

  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");

  const body = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log("\nWebhook HMAC verification");
  {
    const body = JSON.stringify({ id: 1 });

    let res = await fetch(`${base}/webhooks/app/uninstalled`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Shop-Domain": "good-shop.myshopify.com",
      },
      body,
    });
    check("no HMAC header -> 401", res.status === 401, `got ${res.status}`);

    res = await fetch(`${base}/webhooks/app/uninstalled`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Hmac-Sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "X-Shopify-Shop-Domain": "good-shop.myshopify.com",
      },
      body,
    });
    check("forged HMAC -> 401", res.status === 401, `got ${res.status}`);

    const good = crypto
      .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
      .update(Buffer.from(body, "utf8"))
      .digest("base64");

    state.queries.length = 0;
    res = await fetch(`${base}/webhooks/app/uninstalled`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Hmac-Sha256": good,
        "X-Shopify-Shop-Domain": "good-shop.myshopify.com",
      },
      body,
    });
    check("valid HMAC -> 200", res.status === 200, `got ${res.status}`);

    await new Promise((r) => setTimeout(r, 60));
    const sawStatusUpdate = state.queries.some(([sql]) =>
      /UPDATE stores SET is_active = 0/.test(sql)
    );
    check("valid HMAC deactivates the store", sawStatusUpdate,
      JSON.stringify(state.queries.map((q) => q[0])));

    res = await fetch(`${base}/webhooks/shop/redact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    check("GDPR shop/redact requires HMAC", res.status === 401, `got ${res.status}`);
  }

  console.log("\nSession token authentication");
  {
    let res = await fetch(`${base}/protected`, {
      headers: { Accept: "application/json" },
    });
    check("no token -> 401", res.status === 401, `got ${res.status}`);
    check(
      "no token -> reauthorize header",
      res.headers.get("x-shopify-api-request-failure-reauthorize") === "1"
    );

    res = await fetch(`${base}/protected`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${makeToken({}, "wrong_secret")}`,
      },
    });
    check("token signed with wrong secret -> 401", res.status === 401, `got ${res.status}`);

    res = await fetch(`${base}/protected`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${makeToken({ exp: Math.floor(Date.now() / 1000) - 120 })}`,
      },
    });
    check("expired token -> 401", res.status === 401, `got ${res.status}`);

    res = await fetch(`${base}/protected`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${makeToken({ aud: "someone_elses_app" })}`,
      },
    });
    check("wrong audience -> 401", res.status === 401, `got ${res.status}`);

    const alg = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
      "utf8"
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ dest: "https://good-shop.myshopify.com" }),
      "utf8"
    ).toString("base64url");
    res = await fetch(`${base}/protected`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${alg}.${payload}.`,
      },
    });
    check("alg=none -> 401", res.status === 401, `got ${res.status}`);

    res = await fetch(`${base}/protected`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${makeToken()}`,
      },
    });
    const body = await res.json();
    check("valid token -> 200", res.status === 200, `got ${res.status}`);
    check("shop resolved from token", body.shop === "good-shop.myshopify.com", JSON.stringify(body));

    // Tenant pinning: the query string must not override the token.
    res = await fetch(`${base}/protected?shop=victim.myshopify.com`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${makeToken()}`,
      },
    });
    const pinned = await res.json();
    check(
      "?shop= cannot override the token's shop",
      pinned.shop === "good-shop.myshopify.com",
      JSON.stringify(pinned)
    );

    // Token for a shop that is not installed.
    res = await fetch(`${base}/protected`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${makeToken({
          dest: "https://unknown-shop.myshopify.com",
          iss: "https://unknown-shop.myshopify.com/admin",
        })}`,
      },
    });
    check("token for uninstalled shop -> 401", res.status === 401, `got ${res.status}`);
  }

  console.log("\nUnauthenticated page loads never redirect inside the frame");
  {
    // First load with a shop: an App Bridge bounce page that fetches a token.
    let res = await fetch(`${base}/protected?shop=good-shop.myshopify.com`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    let html = await res.text();

    check("first load serves the token bounce", res.status === 401, `got ${res.status}`);
    check("bounce loads App Bridge", html.includes("app-bridge.js"));
    check("bounce asks for a session token", html.includes("shopify.idToken()"));
    check(
      "bounce fallback uses an ABSOLUTE install URL",
      html.includes("https://example.com/api/auth/install"),
      "a relative URL would resolve against admin.shopify.com"
    );

    // Second load (the bounce already failed): OAuth, but at the top level.
    res = await fetch(
      `${base}/protected?shop=good-shop.myshopify.com&shopify-reload=1`,
      { headers: { Accept: "text/html" }, redirect: "manual" }
    );
    html = await res.text();

    check(
      "after a failed bounce it does NOT 302",
      res.headers.get("location") === null,
      `location: ${res.headers.get("location")}`
    );
    check(
      "it escapes the frame instead",
      html.includes("window.top.location.href"),
      html.slice(0, 120)
    );
    check(
      "pointing at this app's install URL",
      html.includes("https://example.com/api/auth/install")
    );
  }

  console.log("\nOAuth install");
  {
    let res = await fetch(`${base}/api/auth/install?shop=evil.com`, {
      redirect: "manual",
    });
    check("non-myshopify shop -> 400 (no open redirect)", res.status === 400, `got ${res.status}`);

    res = await fetch(
      `${base}/api/auth/install?shop=attacker.com%2f..%2fgood-shop.myshopify.com`,
      { redirect: "manual" }
    );
    check("traversal-ish shop -> 400", res.status === 400, `got ${res.status}`);

    res = await fetch(`${base}/api/auth/install?shop=good-shop.myshopify.com`, {
      redirect: "manual",
      headers: { Accept: "text/html" },
    });
    const html = await res.text();
    const setCookie = res.headers.get("set-cookie") || "";

    check("valid shop -> 200 HTML", res.status === 200, `got ${res.status}`);
    check(
      "does NOT 302 (would load OAuth inside the admin iframe)",
      res.headers.get("location") === null
    );
    check(
      "escapes the frame via window.top",
      html.includes("window.top.location.href"),
      html.slice(0, 120)
    );
    check(
      "targets the shop's own admin",
      html.includes("https://good-shop.myshopify.com/admin/oauth/authorize"),
      html.slice(0, 200)
    );
    check("state is present in the URL", /state=[a-f0-9]{64}/.test(html));
    check("state cookie set HttpOnly", /shopify_oauth_state=.*HttpOnly/.test(setCookie), setCookie);
    check(
      "offers a noscript escape too",
      html.includes('target="_top"')
    );

    // Callback with no state cookie must be rejected.
    res = await fetch(
      `${base}/api/auth/callback?shop=good-shop.myshopify.com&code=abc&state=deadbeef&hmac=00`,
      { redirect: "manual" }
    );
    check("callback without state cookie -> 403", res.status === 403, `got ${res.status}`);
  }

  // Drop keep-alive sockets and let libuv finish closing them before the
  // process exits. Calling process.exit() mid-close aborts on Windows with
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", which turns a
  // passing run into exit code 127.
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 150));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
