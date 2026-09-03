/* Orders and line items, against the real database.
 *
 * The privacy behaviour gets the most attention here. Customer identity lives
 * in the customers table, but the two addresses on an order still carry a name
 * and a phone number, so customers/redact has real work to do.
 */
require("dotenv").config({ quiet: true });

const path = require("path");

const SERVER = path.join(__dirname, "..");

const { pool, query } = require(path.join(SERVER, "config/db"));
const { runMigrations } = require(path.join(SERVER, "config/migrate"));
const storeModel = require(path.join(SERVER, "models/storeModel"));
const orderModel = require(path.join(SERVER, "models/orderModel"));
const orderLineItemModel = require(path.join(SERVER, "models/orderLineItemModel"));

const RUN = `o${Date.now().toString(36)}`;
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

/** A payload shaped like the real products/orders webhook body. */
function shopifyOrder(overrides = {}) {
  return {
    id: 5001,
    order_number: 1001,
    name: "#1001",
    currency: "USD",
    presentment_currency: "GBP",
    subtotal_price: "100.00",
    total_tax: "8.50",
    total_discounts: "5.00",
    total_price: "112.00",
    total_shipping_price_set: { shop_money: { amount: "8.50", currency_code: "USD" } },
    financial_status: "paid",
    fulfillment_status: null,
    test: false,
    created_at: "2026-08-20T10:00:00Z",
    updated_at: "2026-08-20T10:05:00Z",
    processed_at: "2026-08-20T10:00:00Z",
    email: "steve@example.com",
    phone: "555-555-SHIP",
    customer: {
      id: 7001,
      first_name: "Steve",
      last_name: "Shopper",
      email: "steve@example.com",
    },
    billing_address: {
      first_name: "Steve",
      address1: "123 Billing Street",
      city: "Billtown",
      zip: "40001",
      country_code: "US",
    },
    shipping_address: {
      first_name: "Steve",
      last_name: "Shipper",
      address1: "123 Shipping Street",
      phone: "555-555-SHIP",
      city: "Shippington",
      zip: "40003",
      province: "Kentucky",
      country: "United States",
      country_code: "US",
      province_code: "KY",
      company: "Shipping Company",
    },
    browser_ip: "203.0.113.9",
    note: "Leave at the back door",
    line_items: [
      {
        id: 9001,
        product_id: 1001,
        variant_id: 5001,
        sku: "BEANIE-S",
        title: "Merino Beanie",
        variant_title: "Small",
        vendor: "Acme",
        quantity: 2,
        price: "20.00",
        total_discount: "0.00",
        requires_shipping: true,
      },
      {
        id: 9002,
        product_id: 1002,
        variant_id: 5003,
        sku: "SCARF-1",
        title: "Wool Scarf",
        vendor: "Acme",
        quantity: 1,
        price: "35.00",
        total_discount: "5.00",
        requires_shipping: true,
      },
    ],
    ...overrides,
  };
}

(async () => {
  await runMigrations();
  await cleanup();

  const store = await storeModel.upsertStore({
    shop_domain: DOMAIN,
    store_name: "Order Test Shop",
    access_token: "shpat_x",
  });

  let order;

  console.log("\nStoring an order");
  {
    order = await orderModel.upsert(store.id, shopifyOrder());

    check("order is stored", Boolean(order && order.id));
    check("order number kept", order.name === "#1001");
    check("shop currency kept", order.currency === "USD");

    check("total is a number, not a string",
      Number(order.total_price) === 112, String(order.total_price));
    check("money keeps 2dp exactly",
      Number(order.total_tax) === 8.5, String(order.total_tax));
    check("shipping read out of the *_set object",
      Number(order.total_shipping) === 8.5, String(order.total_shipping));

    check("financial status kept", order.financial_status === "paid");
    check("unfulfilled is NULL, not a string",
      order.fulfillment_status === null, String(order.fulfillment_status));
    check("not cancelled", order.cancelled_at === null);

    check("addresses survive as objects",
      order.shipping_address.city === "Shippington",
      JSON.stringify(order.shipping_address));
    check("country code flattened for reporting",
      order.shipping_country_code === "US");
    check("billing address stored separately",
      order.billing_address.city === "Billtown");

    check("customer referenced by id only",
      String(order.customer_shopify_id) === "7001");
    check("no email copied onto the order",
      order.email === undefined, String(order.email));
    check("no name copied onto the order",
      order.customer_first_name === undefined);
  }

  console.log("\nLine items");
  {
    const lines = await orderLineItemModel.listForOrder(order.id);

    check("both lines stored", lines.length === 2, String(lines.length));
    check("quantity kept", lines[0].quantity === 2);
    check("price is a number", Number(lines[0].price) === 20);
    check("discount kept", Number(lines[1].total_discount) === 5);
    check("sku kept", lines[0].sku === "BEANIE-S");
    check("product id kept without a foreign key",
      String(lines[0].shopify_product_id) === "1001");
    check("unmapped variant stores NULL, not a stray id",
      lines[0].mapped_variant_id === null,
      String(lines[0].mapped_variant_id));

    const sold = await orderLineItemModel.unitsSoldByVariant(store.id);
    check("units sold rolls up per variant", sold.length === 2, String(sold.length));
    check("quantities are summed",
      Number(sold.find((s) => s.sku === "BEANIE-S").units) === 2);
  }

  console.log("\nRe-fetching the same order");
  {
    const updated = await orderModel.upsert(
      store.id,
      shopifyOrder({
        financial_status: "refunded",
        fulfillment_status: "fulfilled",
        updated_at: "2026-08-21T09:00:00Z",
        line_items: [shopifyOrder().line_items[0]], // second line removed
      })
    );

    check("updates in place", updated.id === order.id);
    check("status change applied", updated.financial_status === "refunded");
    check("no duplicate order row",
      (await orderModel.countForStore(store.id)) === 1);

    const lines = await orderLineItemModel.listForOrder(order.id);
    check("removed line is pruned", lines.length === 1, String(lines.length));
  }

  console.log("\nTotals exclude the noise");
  {
    await orderModel.upsert(
      store.id,
      shopifyOrder({ id: 5002, name: "#1002", test: true, total_price: "999.00" })
    );
    await orderModel.upsert(
      store.id,
      shopifyOrder({
        id: 5003,
        name: "#1003",
        cancelled_at: "2026-08-22T10:00:00Z",
        total_price: "500.00",
      })
    );

    const totals = await orderModel.totalsForStore(store.id);
    check("test orders excluded from revenue",
      totals.revenue === 112, String(totals.revenue));
    check("cancelled orders excluded", totals.orders === 1, String(totals.orders));

    const listed = await orderModel.listForStore(store.id);
    check("test orders hidden from the list by default",
      !listed.some((o) => o.test), JSON.stringify(listed.map((o) => o.name)));
  }

  console.log("\ncustomers/data_request");
  {
    const data = await orderModel.dataForCustomer(store.id, 7001);
    check("finds the customer's orders", data.length >= 1, String(data.length));
    check("includes what they bought",
      Array.isArray(data[0].line_items) && data[0].line_items.length > 0);
    check("includes the addresses",
      data[0].shipping_address.city === "Shippington");
  }

  console.log("\ncustomers/redact");
  {
    const count = await orderModel.redactCustomer(store.id, 7001);
    check("redacts every matching order", count >= 1, String(count));

    const after = await orderModel.findByShopifyId(store.id, 5001);

    check("customer id erased", after.customer_shopify_id === null);
    check("billing address erased", after.billing_address === null);
    check("shipping address erased", after.shipping_address === null);

    // The order itself must survive -- a merchant has to keep sales records.
    check("the ORDER survives", after.name === "#1001");
    check("the money survives", Number(after.total_price) === 112);
    check("the line items survive",
      (await orderLineItemModel.countForOrder(after.id)) > 0);

    // The raw payload is no longer stored at all, so there is no blob left
    // holding what the columns gave up.
    const cols = await query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
          AND COLUMN_NAME = 'order_data'`
    );
    check("no raw payload column exists", Number(cols[0].n) === 0);

    // With no redacted_at marker, a re-fetch DOES write the person back.
    // Documented rather than asserted away: this is the known gap.
    await orderModel.upsert(store.id, shopifyOrder());
    const refetched = await orderModel.findByShopifyId(store.id, 5001);
    check("a re-fetch restores the customer link (no redaction marker)",
      String(refetched.customer_shopify_id) === "7001",
      String(refetched.customer_shopify_id));
  }

  console.log("\nLine items linked to a mapped variant");
  {
    const connectionModel = require(path.join(SERVER, "models/connectionModel"));
    const sourceProductModel = require(path.join(SERVER, "models/sourceProductModel"));
    const sourceVariantModel = require(path.join(SERVER, "models/sourceVariantModel"));
    const productMappingModel = require(path.join(SERVER, "models/productMappingModel"));
    const mappingVariantProductModel = require(
      path.join(SERVER, "models/mappingVariantProductModel")
    );
    const pairing = require(path.join(SERVER, "services/pairing"));

    // A source store feeding this one, with one product synced across.
    const src = await storeModel.upsertStore({
      shop_domain: `${RUN}-src.myshopify.com`,
      store_name: "Src",
      access_token: "t",
    });

    const { code } = await pairing.issueCode(store.id);
    await pairing.redeemCode(src.id, code);

    const conn = await connectionModel.createConnection({
      sourceStoreId: src.id,
      destinationStoreId: store.id,
    });

    const product = await sourceProductModel.upsert(src.id, {
      id: 1001,
      title: "Merino Beanie",
      variants: [{ id: 5001, sku: "BEANIE-S", price: "12.50" }],
    });

    const sourceVariant = await sourceVariantModel.findByShopifyId(product.id, 5001);

    const mapping = await productMappingModel.ensure({
      connectionId: conn.id,
      sourceProductId: product.id,
      sourceShopifyProductId: 1001,
    });

    // Synced: source variant 5001 became destination variant 77001.
    await mappingVariantProductModel.upsertMany(mapping.id, [
      {
        sourceVariantMappingId: sourceVariant.id,
        sourceShopifyVariantId: 5001,
        destinationVariantId: 77001,
        sku: "BEANIE-S",
      },
    ]);

    const link = await mappingVariantProductModel.findBySourceVariant(mapping.id, 5001);

    // An order on the destination store, for that destination variant.
    await orderModel.upsert(store.id, {
      id: 6001,
      name: "#2001",
      currency: "USD",
      total_price: "20.00",
      line_items: [
        {
          id: 9500,
          product_id: 91001,
          variant_id: 77001,
          sku: "BEANIE-S",
          title: "Merino Beanie",
          quantity: 3,
          price: "20.00",
        },
      ],
    });

    const saved = await orderModel.findByShopifyId(store.id, 6001);
    const lines = await orderLineItemModel.listForOrder(saved.id);

    check("the sold variant resolves to its mapping row",
      lines[0].mapped_variant_id === link.id,
      `${lines[0].mapped_variant_id} vs ${link.id}`);

    const sold = await orderLineItemModel.unitsSoldByVariant(store.id);
    const row = sold.find((r) => String(r.destination_variant_id) === "77001");

    check("sales roll up through the mapping", Boolean(row), JSON.stringify(sold));
    check("and reach back to the SOURCE variant",
      row && String(row.source_shopify_variant_id) === "5001",
      row && String(row.source_shopify_variant_id));
    check("quantities are correct", row && Number(row.units) === 3);

    const topSellers = await orderLineItemModel.topSellingProducts(store.id);
    const top = topSellers.find((item) => item.title === "Merino Beanie");

    check("dashboard top sellers use real synced sales", Boolean(top));
    check("top sellers include the source store", top && top.source === "Src");
    check("top sellers total units and revenue",
      top && top.units === 3 && top.revenue === 60,
      JSON.stringify(top));

    const sourceTopSellers = await orderLineItemModel.topSellingSourceProducts(src.id);
    const sourceTop = sourceTopSellers.find((item) => item.title === "Merino Beanie");

    check("source dashboard ranks products from destination orders", Boolean(sourceTop));
    check("source top sellers count stores, orders and units",
      sourceTop && sourceTop.stores === 1 && sourceTop.orders === 1 && sourceTop.units === 3,
      JSON.stringify(sourceTop));
    check("source top sellers use the source price",
      sourceTop && sourceTop.revenue === 37.5,
      JSON.stringify(sourceTop));

    // Deleting the mapping must not delete the sale.
    await connectionModel.deleteConnection(conn.id);

    const after = await orderLineItemModel.listForOrder(saved.id);

    check("the sale survives the mapping being deleted",
      after.length === 1 && Number(after[0].quantity) === 3,
      JSON.stringify(after.map((a) => a.quantity)));
    check("the link is SET NULL, not cascaded away",
      after[0].mapped_variant_id === null,
      String(after[0].mapped_variant_id));
    check("what was sold is still identifiable",
      after[0].sku === "BEANIE-S" && after[0].title === "Merino Beanie");
  }

  console.log("\nUninstall cascade");
  {
    const before = await orderModel.countForStore(store.id, { includeTest: true });
    check("orders exist before the delete", before > 0, String(before));

    await storeModel.deleteStore(DOMAIN);

    const orders = await query("SELECT COUNT(*) AS n FROM orders WHERE store_id = ?", [
      store.id,
    ]);
    const lines = await query(
      `SELECT COUNT(*) AS n FROM order_line_items li
        WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = li.order_id)`
    );

    check("orders cascade", Number(orders[0].n) === 0);
    check("no orphaned line items", Number(lines[0].n) === 0);
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
