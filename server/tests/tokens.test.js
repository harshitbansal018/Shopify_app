/* Tests for expiring offline access tokens: initial exchange, automatic
 * refresh, rotation, concurrency and the reinstall path.
 * Stubs axios and config/db so nothing external is touched. */
const path = require("path");
const Module = require("module");

const SERVER = path.join(__dirname, "..");

process.env.SHOPIFY_API_KEY = "test_api_key";
process.env.SHOPIFY_API_SECRET = "test_api_secret";
process.env.HOST = "https://example.com";

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const mod = new Module(resolved, null);
  mod.filename = resolved;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[resolved] = mod;
  return exports;
}

/* ---------- fake shops table ---------- */
const shops = new Map();

function seedShop(overrides = {}) {
  const record = {
    id: 1,
    shop_name: "good-shop.myshopify.com",
    access_token: "shpat_old",
    access_token_expires_at: new Date(Date.now() + 3600_000),
    refresh_token: "shprt_old",
    refresh_token_expires_at: new Date(Date.now() + 7776000_000),
    status: 1,
    ...overrides,
  };
  shops.set(record.shop_name, record);
  return record;
}

stub(path.join(SERVER, "config/db.js"), {
  pool: { query: async () => [[], []] },
  query: async () => [],
  withTransaction: async (fn) => fn({ query: async () => [[], []] }),
  assertConnection: async () => {},
});

stub(path.join(SERVER, "models/storeModel.js"), {
  async findByDomain(shop) {
    return shops.get(shop) || null;
  },
  async updateTokens(shop, tokens) {
    const record = shops.get(shop);
    if (!record) return;
    record.access_token = tokens.accessToken;
    record.access_token_expires_at = tokens.accessTokenExpiresAt;
    record.refresh_token = tokens.refreshToken;
    record.refresh_token_expires_at = tokens.refreshTokenExpiresAt;
  },
  async clearTokens(shop) {
    const record = shops.get(shop);
    if (!record) return;
    record.access_token = null;
    record.refresh_token = null;
    record.access_token_expires_at = null;
    record.refresh_token_expires_at = null;
  },
});

/* ---------- fake Shopify token endpoint ---------- */
const calls = [];
let nextResponse = null;
let nextError = null;
let issued = 0;

stub("axios", {
  async post(url, body) {
    calls.push({ url, body });

    if (nextError) {
      const err = nextError;
      nextError = null;
      throw err;
    }

    if (nextResponse) {
      const res = nextResponse;
      nextResponse = null;
      return res;
    }

    issued += 1;
    return {
      data: {
        access_token: `shpat_new_${issued}`,
        scope: "write_content",
        expires_in: 3600,
        refresh_token: `shprt_new_${issued}`,
        refresh_token_expires_in: 7776000,
      },
    };
  },
});

const {
  getAccessToken,
  exchangeCodeForToken,
  ReauthRequiredError,
} = require(path.join(SERVER, "services/tokens"));

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

function reset() {
  shops.clear();
  calls.length = 0;
  nextResponse = null;
  nextError = null;
}

(async () => {
  console.log("\nInitial code exchange");
  {
    reset();
    const tokens = await exchangeCodeForToken("good-shop.myshopify.com", "auth_code");
    const body = calls[0].body;

    check("posts to the shop's token endpoint",
      calls[0].url === "https://good-shop.myshopify.com/admin/oauth/access_token",
      calls[0].url);
    check('sends expiring: "1"', body.expiring === "1", JSON.stringify(body.expiring));
    check("sends the authorization code", body.code === "auth_code");
    check("sends client credentials",
      body.client_id === "test_api_key" && body.client_secret === "test_api_secret");
    check("returns the access token", /^shpat_new_/.test(tokens.accessToken));
    check("returns the refresh token", /^shprt_new_/.test(tokens.refreshToken));
    check("computes access token expiry",
      tokens.accessTokenExpiresAt instanceof Date &&
        tokens.accessTokenExpiresAt.getTime() > Date.now());
    check("computes refresh token expiry",
      tokens.refreshTokenExpiresAt instanceof Date &&
        tokens.refreshTokenExpiresAt.getTime() > Date.now() + 7000_000_000);
  }

  console.log("\nUsing a token that is still fresh");
  {
    reset();
    seedShop();
    const token = await getAccessToken("good-shop.myshopify.com");

    check("returns the stored token", token === "shpat_old", token);
    check("makes no network call", calls.length === 0, `${calls.length} calls`);
  }

  console.log("\nRefreshing an expired token");
  {
    reset();
    seedShop({ access_token_expires_at: new Date(Date.now() - 1000) });

    const token = await getAccessToken("good-shop.myshopify.com");
    const body = calls[0].body;

    check("refreshes automatically", /^shpat_new_/.test(token), token);
    check("uses grant_type=refresh_token", body.grant_type === "refresh_token", body.grant_type);
    check("sends the stored refresh token", body.refresh_token === "shprt_old");
    check("stores the ROTATED refresh token",
      /^shprt_new_/.test(shops.get("good-shop.myshopify.com").refresh_token),
      shops.get("good-shop.myshopify.com").refresh_token);
    check("stores the new expiry",
      shops.get("good-shop.myshopify.com").access_token_expires_at.getTime() > Date.now());
  }

  console.log("\nRefresh skew");
  {
    reset();
    // Expires in 30s -- inside the 90s skew window, so it must refresh early.
    seedShop({ access_token_expires_at: new Date(Date.now() + 30_000) });
    const token = await getAccessToken("good-shop.myshopify.com");
    check("refreshes before the token actually expires", /^shpat_new_/.test(token), token);
  }

  console.log("\nLegacy rows with no recorded expiry");
  {
    reset();
    seedShop({ access_token_expires_at: null });
    const token = await getAccessToken("good-shop.myshopify.com");
    check("treated as stale and refreshed", /^shpat_new_/.test(token), token);
  }

  console.log("\nConcurrent requests");
  {
    reset();
    seedShop({ access_token_expires_at: new Date(Date.now() - 1000) });

    const results = await Promise.all([
      getAccessToken("good-shop.myshopify.com"),
      getAccessToken("good-shop.myshopify.com"),
      getAccessToken("good-shop.myshopify.com"),
    ]);

    check("collapses into a single refresh", calls.length === 1, `${calls.length} calls`);
    check("all callers get the same token",
      new Set(results).size === 1, JSON.stringify(results));
  }

  console.log("\nRefresh token rejected");
  {
    reset();
    seedShop({ access_token_expires_at: new Date(Date.now() - 1000) });
    nextError = Object.assign(new Error("Bad Request"), { response: { status: 400 } });

    let thrown = null;
    try {
      await getAccessToken("good-shop.myshopify.com");
    } catch (err) {
      thrown = err;
    }

    check("raises ReauthRequiredError", thrown instanceof ReauthRequiredError, thrown && thrown.name);
    check("clears the dead token pair",
      shops.get("good-shop.myshopify.com").access_token === null &&
        shops.get("good-shop.myshopify.com").refresh_token === null);
  }

  console.log("\nTransient failures keep the tokens");
  {
    reset();
    seedShop({ access_token_expires_at: new Date(Date.now() - 1000) });
    nextError = Object.assign(new Error("Gateway"), { response: { status: 503 } });

    let thrown = null;
    try {
      await getAccessToken("good-shop.myshopify.com");
    } catch (err) {
      thrown = err;
    }

    check("propagates the error", thrown !== null && !(thrown instanceof ReauthRequiredError));
    check("does NOT discard the refresh token",
      shops.get("good-shop.myshopify.com").refresh_token === "shprt_old");

    // A retry after the blip should now succeed.
    const token = await getAccessToken("good-shop.myshopify.com");
    check("retry succeeds", /^shpat_new_/.test(token), token);
  }

  console.log("\nExpired refresh token");
  {
    reset();
    seedShop({
      access_token_expires_at: new Date(Date.now() - 1000),
      refresh_token_expires_at: new Date(Date.now() - 1000),
    });

    let thrown = null;
    try {
      await getAccessToken("good-shop.myshopify.com");
    } catch (err) {
      thrown = err;
    }

    check("requires reinstall", thrown instanceof ReauthRequiredError, thrown && thrown.message);
    check("does not call Shopify", calls.length === 0, `${calls.length} calls`);
  }

  console.log("\nUnknown / invalid shops");
  {
    reset();
    let thrown = null;
    try {
      await getAccessToken("not-installed.myshopify.com");
    } catch (err) {
      thrown = err;
    }
    check("uninstalled shop requires reinstall", thrown instanceof ReauthRequiredError);

    thrown = null;
    try {
      await getAccessToken("evil.com");
    } catch (err) {
      thrown = err;
    }
    check("invalid domain is refused", thrown !== null && /invalid shop domain/i.test(thrown.message));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
