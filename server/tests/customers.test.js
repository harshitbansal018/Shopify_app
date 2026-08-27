/* The customers table: caching, lookup, and the privacy webhooks. */
require("dotenv").config({ quiet: true });

const path = require("path");
const SERVER = path.join(__dirname, "..");

const { pool, query } = require(path.join(SERVER, "config/db"));
const { runMigrations } = require(path.join(SERVER, "config/migrate"));
const storeModel = require(path.join(SERVER, "models/storeModel"));
const customerModel = require(path.join(SERVER, "models/customerModel"));
const orderModel = require(path.join(SERVER, "models/orderModel"));

const RUN = `c${Date.now().toString(36)}`;
const DOMAIN = `${RUN}-shop.myshopify.com`;

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

async function cleanup() {
  await query("DELETE FROM stores WHERE shop_domain LIKE ?", [`${RUN}-%`]);
}

function shopifyCustomer(overrides = {}) {
  return {
    id: 7001,
    first_name: "Steve",
    last_name: "Shopper",
    email: "steve@example.com",
    phone: "555-555-SHIP",
    created_at: "2026-01-10T09:00:00Z",
    updated_at: "2026-08-20T10:00:00Z",
    default_address: {
      address1: "123 Shipping Street",
      city: "Shippington",
      country_code: "US",
    },
    addresses: [
      { id: 1, address1: "123 Shipping Street", city: "Shippington", country_code: "US" },
      { id: 2, address1: "9 Second Place", city: "Elsewhere", country_code: "US" },
    ],
    ...overrides,
  };
}

(async () => {
  await runMigrations();
  await cleanup();

  const store = await storeModel.upsertStore({
    shop_domain: DOMAIN,
    store_name: "Customer Test Shop",
    access_token: "shpat_x",
  });

  console.log("\nCaching a customer");
  {
    const saved = await customerModel.upsert(store.id, shopifyCustomer());

    check("customer stored", Boolean(saved && saved.id));
    check("name kept", saved.first_name === "Steve" && saved.last_name === "Shopper");
    check("email kept", saved.email === "steve@example.com");
    check("phone kept", saved.phone === "555-555-SHIP");
    check("addresses survive as an array",
      Array.isArray(saved.addresses) && saved.addresses.length === 2,
      JSON.stringify(saved.addresses));
    check("shopify timestamps kept", Boolean(saved.shopify_created_at));
    check("fetch time recorded", Boolean(saved.last_fetched_at));
  }

  console.log("\nRe-fetching");
  {
    await customerModel.upsert(
      store.id,
      shopifyCustomer({ phone: "555-000-NEW", updated_at: "2026-08-25T10:00:00Z" })
    );

    const again = await customerModel.findByShopifyId(store.id, 7001);
    check("updates in place", again.phone === "555-000-NEW");
    check("no duplicate row", (await customerModel.countForStore(store.id)) === 1);
  }

  console.log("\nA customer with only a default address");
  {
    await customerModel.upsert(store.id, {
      id: 7002,
      email: "solo@example.com",
      default_address: { address1: "1 Only Road", city: "Solo" },
    });

    const solo = await customerModel.findByShopifyId(store.id, 7002);
    check("default address becomes a one-item list",
      Array.isArray(solo.addresses) && solo.addresses.length === 1,
      JSON.stringify(solo.addresses));
  }

  console.log("\nLookup");
  {
    check("by email", Boolean(await customerModel.findByEmail(store.id, "steve@example.com")));
    check("search by partial name",
      (await customerModel.listForStore(store.id, { search: "Shop" })).length === 1);
    check("search by partial email",
      (await customerModel.listForStore(store.id, { search: "solo@" })).length === 1);
  }

  console.log("\ncustomers/data_request");
  {
    const found = await customerModel.dataForCustomer(store.id, 7001);
    check("returns the profile", found.length === 1 && found[0].email === "steve@example.com");
  }

  console.log("\ncustomers/redact");
  {
    // An order for the same person, to prove the two are treated differently.
    await orderModel.upsert(store.id, {
      id: 5001,
      name: "#1001",
      total_price: "50.00",
      currency: "USD",
      created_at: "2026-08-20T10:00:00Z",
      email: "steve@example.com",
      customer: { id: 7001, first_name: "Steve", email: "steve@example.com" },
      line_items: [{ id: 9001, title: "Beanie", quantity: 1, price: "50.00" }],
    });

    const deleted = await customerModel.redactCustomer(store.id, 7001);
    const orderRedacted = await orderModel.redactCustomer(store.id, 7001);

    check("customer row is deleted", deleted === 1, String(deleted));
    check("customer is gone",
      (await customerModel.findByShopifyId(store.id, 7001)) === null);

    const order = await orderModel.findByShopifyId(store.id, 5001);
    check("the order survives", Boolean(order) && order.name === "#1001");
    check("the money survives", Number(order.total_price) === 50);
    // Identity is not stored on an order, so anonymising means dropping the
    // customer link and the addresses.
    check("but the order is anonymised",
      order.customer_shopify_id === null && order.shipping_address === null,
      `customer=${order.customer_shopify_id} address=${JSON.stringify(order.shipping_address)}`);
    check("orders and customers are treated differently",
      orderRedacted === 1 && deleted === 1);

    check("the other customer is untouched",
      Boolean(await customerModel.findByShopifyId(store.id, 7002)));
  }

  console.log("\nUninstall cascade");
  {
    check("customers exist before delete",
      (await customerModel.countForStore(store.id)) > 0);

    await storeModel.deleteStore(DOMAIN);

    const left = await query("SELECT COUNT(*) AS n FROM customers WHERE store_id = ?", [
      store.id,
    ]);
    check("customers cascade", Number(left[0].n) === 0);
  }

  await cleanup();
  await pool.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch(async (err) => {
  console.error("\nTest run crashed:", err.stack || err.message);
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
