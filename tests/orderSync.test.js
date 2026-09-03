/* Forwarding a destination sale to the source store that supplied it.
 *
 * Run against the real database, not fixtures: the whole feature is four
 * tables joined together, and a join that compiles in JavaScript proves
 * nothing about whether MariaDB will run it.
 *
 * The behaviour that matters most is the price. A source store must be
 * charged its OWN price, never the marked-up one the shopper paid -- getting
 * that backwards would silently overcharge every supplier.
 */
require("dotenv").config({ quiet: true });

const path = require("path");

const SERVER = path.join(__dirname, "..");

const { pool, query } = require(path.join(SERVER, "config/db"));
const { runMigrations } = require(path.join(SERVER, "config/migrate"));
const storeModel = require(path.join(SERVER, "models/storeModel"));
const connectionModel = require(path.join(SERVER, "models/connectionModel"));
const sourceProductModel = require(path.join(SERVER, "models/sourceProductModel"));
const sourceVariantModel = require(path.join(SERVER, "models/sourceVariantModel"));
const productMappingModel = require(path.join(SERVER, "models/productMappingModel"));
const mappingVariantProductModel = require(
  path.join(SERVER, "models/mappingVariantProductModel")
);
const orderModel = require(path.join(SERVER, "models/orderModel"));
const orderLineItemModel = require(path.join(SERVER, "models/orderLineItemModel"));
const orderMappingModel = require(path.join(SERVER, "models/orderMappingModel"));
const orderSync = require(path.join(SERVER, "services/orderSync"));

const RUN = `os${Date.now().toString(36)}`;

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

/* The source sells the shirt for 10.00 and the cap for 4.00. The destination
   was pushed those at a 25% markup, so the shopper pays 12.50 and 5.00. */
const SOURCE_SHIRT_PRICE = 10;
const SOURCE_CAP_PRICE = 4;
const PAID_SHIRT_PRICE = 12.5;
const PAID_CAP_PRICE = 5;

/** A body shaped like the real orders/create webhook payload. */
function shopifyOrder(overrides = {}) {
  return {
    id: 900001,
    order_number: 2001,
    name: "#2001",
    currency: "USD",
    subtotal_price: "30.00",
    total_price: "30.00",
    financial_status: "paid",
    fulfillment_status: null,
    test: false,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    line_items: [],
    ...overrides,
  };
}

(async () => {
  try {
    await runMigrations();
    await cleanup();

    /* ---------------- the two stores and their connection ---------------- */

    const source = await storeModel.upsertStore({
      shop_domain: `${RUN}-source.myshopify.com`,
      access_token: "shpat_source_token",
      store_name: "Warehouse",
      currency: "USD",
    });
    await storeModel.chooseStoreType(source.id, "source");

    const destination = await storeModel.upsertStore({
      shop_domain: `${RUN}-dest.myshopify.com`,
      access_token: "shpat_dest_token",
      store_name: "Front Shop",
      currency: "USD",
    });
    await storeModel.chooseStoreType(destination.id, "destination");

    // Two stores may only be connected once they have been paired. That is
    // services/pairing.js's job; here the group is set directly, because this
    // suite is about orders and pairing has its own.
    await query("UPDATE stores SET store_group_id = ? WHERE id IN (?, ?)", [
      `${RUN}-group`,
      source.id,
      destination.id,
    ]);

    const connection = await connectionModel.createConnection({
      sourceStoreId: source.id,
      destinationStoreId: destination.id,
    });

    /* ---------------- a product, shared and pushed ---------------- */

    const product = await sourceProductModel.upsert(source.id, {
      id: 800001,
      title: "Blue Shirt",
      vendor: "Acme",
      status: "active",
      variants: [
        { id: 810001, title: "S", sku: "SH-S", price: String(SOURCE_SHIRT_PRICE.toFixed(2)) },
        { id: 810002, title: "M", sku: "SH-M", price: String(SOURCE_CAP_PRICE.toFixed(2)) },
      ],
    });

    const mapping = await productMappingModel.ensure({
      connectionId: connection.id,
      sourceProductId: product.id,
      sourceShopifyProductId: 800001,
    });

    const sourceVariants = await sourceVariantModel.listForProduct(product.id);
    const shirt = sourceVariants.find((v) => v.sku === "SH-S");
    const cap = sourceVariants.find((v) => v.sku === "SH-M");

    // What the push recorded: each source variant paired with the variant it
    // became in the destination store.
    await mappingVariantProductModel.upsertMany(mapping.id, [
      {
        sourceVariantMappingId: shirt.id,
        sourceShopifyVariantId: 810001,
        destinationVariantId: 910001,
        sku: "SH-S",
      },
      {
        sourceVariantMappingId: cap.id,
        sourceShopifyVariantId: 810002,
        destinationVariantId: 910002,
        sku: "SH-M",
      },
    ]);

    /* ---------------- the sale ---------------- */

    console.log("\nCaching a destination sale");
    {
      const order = await orderSync.cacheOrder(
        destination.id,
        shopifyOrder({
          line_items: [
            {
              id: 950001,
              product_id: 990001,
              variant_id: 910001, // the destination variant
              quantity: 2,
              price: String(PAID_SHIRT_PRICE.toFixed(2)),
              title: "Blue Shirt",
              variant_title: "S",
              sku: "SH-S",
            },
            {
              id: 950002,
              product_id: 990001,
              variant_id: 910002,
              quantity: 1,
              price: String(PAID_CAP_PRICE.toFixed(2)),
              title: "Blue Shirt",
              variant_title: "M",
              sku: "SH-M",
            },
            {
              // The destination's own product: nothing to do with any source.
              id: 950003,
              product_id: 990002,
              variant_id: 920003,
              quantity: 1,
              price: "9.99",
              title: "Own Product",
              sku: "OWN-1",
            },
          ],
        })
      );

      check("the order is cached", Boolean(order) && order.name === "#2001");

      const lines = await orderLineItemModel.listForOrder(order.id);
      check("every line is stored", lines.length === 3);

      const synced = await orderLineItemModel.sourceLinesForOrder(order.id);

      check("only the synced lines resolve to a source",
        synced.length === 2,
        `${synced.length} -- the destination's own product must not be forwarded`);
      check("each carries the SOURCE variant id, not the destination one",
        synced.every((line) =>
          [810001, 810002].includes(Number(line.source_shopify_variant_id))),
        "ordering the destination's own variant id at the source would 404");
      check("and the SOURCE price, not the price paid",
        Number(synced[0].source_price) === SOURCE_SHIRT_PRICE &&
          Number(synced[0].destination_price) === PAID_SHIRT_PRICE,
        "the margin belongs to the destination, not the supplier");
    }

    /* ---------------- queueing it for the source ---------------- */

    console.log("\nQueueing it for the source store");
    let queued;
    {
      const order = await orderModel.findByShopifyId(destination.id, 900001);
      const result = await orderSync.queueForSources(destination.id, order);

      check("one source store is owed an order", result.connections === 1);

      queued = await orderMappingModel.findByPair(connection.id, order.id);

      check("a mapping row exists", Boolean(queued));
      check("it starts pending", queued.sync_status === "pending");
      check("with only this source's lines counted",
        queued.line_count === 2,
        "the destination's own product is not this source's problem");

      // 2 x 10.00 + 1 x 4.00 = 24.00 owed; 2 x 12.50 + 1 x 5.00 = 30.00 paid.
      check("the source is owed its own prices",
        Number(queued.source_total) === 24,
        `${queued.source_total}`);
      check("and the shopper's total is recorded beside it",
        Number(queued.destination_total) === 30,
        `${queued.destination_total}`);

      // Shopify retries orders/create. A second delivery must not place a
      // second order at the source.
      await orderSync.queueForSources(destination.id, order);

      const rows = await query(
        "SELECT COUNT(*) AS total FROM order_mappings WHERE destination_order_id = ?",
        [order.id]
      );
      check("a redelivered webhook does not queue it twice",
        Number(rows[0].total) === 1,
        "the source would be sent the same order two or three times");
    }

    /* ---------------- the payload sent to the source ---------------- */

    console.log("\nThe order placed at the source");
    {
      const lines = (
        await orderLineItemModel.sourceLinesForOrder(queued.destination_order_id)
      ).filter((line) => line.connection_id === connection.id);

      const built = orderSync.buildOrderInput(queued, lines, "USD");
      const items = built.order.lineItems;

      check("one line per synced item", items.length === 2);
      check("variants are sent as gids",
        items.every((item) => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(item.variantId)));
      check("pointing at the source's variants",
        items[0].variantId === "gid://shopify/ProductVariant/810001");

      check("the price sent is the source's own",
        items[0].priceSet.shopMoney.amount === "10.00",
        `${items[0].priceSet.shopMoney.amount} -- 12.50 would be the marked-up price`);
      check("quantities carry over", items[0].quantity === 2);
      check("the currency is set once and on every line",
        built.order.currency === "USD" &&
          items.every((item) => item.priceSet.shopMoney.currencyCode === "USD"));

      check("the order is tagged so a human can spot it",
        built.order.tags.includes(orderSync.SOURCE_ORDER_TAG));
      check("and the note names the sale it came from",
        built.order.note.includes("#2001") && built.order.note.includes("Front Shop"),
        "an order from nowhere is unexplainable in the source admin");
      check("no receipt is emailed", built.options.sendReceipt === false);

      // A variant with no cached price must not be ordered as free.
      const priceless = orderSync.buildOrderInput(
        queued,
        [{ ...lines[0], source_price: null }],
        "USD"
      );
      check("a variant with no cached price is sent without one",
        priceless.order.lineItems[0].priceSet === undefined,
        "Number(null) is 0, and that would order it free");
    }

    /* ---------------- statuses ---------------- */

    console.log("\nThe queue");
    {
      const pending = await orderMappingModel.listPending(connection.id);
      check("it is picked up by the push", pending.length === 1);
      check("with the source's domain to call",
        pending[0].source_shop_domain === `${RUN}-source.myshopify.com`);

      await orderMappingModel.markFailed(queued.id, "Variant is out of stock");

      const afterFail = await orderMappingModel.findById(queued.id);
      check("a failure is recorded", afterFail.sync_status === "failed");
      check("with its reason", afterFail.error_message === "Variant is out of stock");
      check("and the attempt is counted", afterFail.attempts === 1);

      check("a failed order is retried",
        (await orderMappingModel.listPending(connection.id)).length === 1,
        "a store that was briefly unreachable should recover on its own");
      check("but not forever",
        (await orderMappingModel.listPending(connection.id, { maxAttempts: 1 })).length === 0,
        "a permanently broken order would be retried every minute");

      await orderMappingModel.markSynced(queued.id, {
        sourceShopifyOrderId: "gid://shopify/Order/970001",
        sourceOrderName: "#5005",
      });

      const done = await orderMappingModel.findById(queued.id);
      check("placing it records the source order", done.sync_status === "synced");
      check("by name and id",
        done.source_order_name === "#5005" &&
          String(done.source_shopify_order_id) === "970001");
      check("the error is cleared", done.error_message === null);
      check("and it leaves the queue",
        (await orderMappingModel.listPending(connection.id)).length === 0);

      const counts = await orderMappingModel.statusCounts(destination.id);
      check("the screen's counts add up", counts.synced === 1 && counts.pending === 0);

      check("both ends can see it",
        (await orderMappingModel.listForSource(source.id)).length === 1 &&
          (await orderMappingModel.listForDestination(destination.id)).length === 1);

      // Re-queueing a synced order would place it at the source a second time.
      await orderMappingModel.requeue(queued.id);
      check("a placed order cannot be re-queued",
        (await orderMappingModel.findById(queued.id)).sync_status === "synced",
        "the source would receive the same order twice");
    }

    /* ---------------- what must NOT be forwarded ---------------- */

    console.log("\nWhat is not forwarded");
    {
      const test = await orderSync.cacheOrder(
        destination.id,
        shopifyOrder({
          id: 900002,
          name: "#2002",
          test: true,
          line_items: [
            {
              id: 950004, product_id: 990001, variant_id: 910001,
              quantity: 1, price: "12.50", title: "Blue Shirt", sku: "SH-S",
            },
          ],
        })
      );

      const result = await orderSync.queueForSources(destination.id, test);

      check("a test order is not forwarded",
        result.connections === 0 && result.skipped === "test",
        "a real order at the source for a checkout someone was trying out");

      const ownOnly = await orderSync.cacheOrder(
        destination.id,
        shopifyOrder({
          id: 900003,
          name: "#2003",
          line_items: [
            {
              id: 950005, product_id: 990002, variant_id: 920003,
              quantity: 1, price: "9.99", title: "Own Product", sku: "OWN-1",
            },
          ],
        })
      );

      check("an order of the destination's own products queues nothing",
        (await orderSync.queueForSources(destination.id, ownOnly)).connections === 0);
    }

    /* ---------------- the sale goes away ---------------- */

    console.log("\nDeleting the sale");
    {
      const order = await orderModel.findByShopifyId(destination.id, 900001);

      await query("DELETE FROM orders WHERE id = ?", [order.id]);

      const rows = await query(
        "SELECT COUNT(*) AS total FROM order_mappings WHERE destination_order_id = ?",
        [order.id]
      );
      check("its mapping goes with it",
        Number(rows[0].total) === 0,
        "a row describing a sale that no longer exists means nothing");
    }

    console.log("\nUninstall cascade");
    {
      await storeModel.deleteStore(`${RUN}-dest.myshopify.com`);

      const rows = await query(
        `SELECT COUNT(*) AS total FROM order_mappings WHERE connection_id = ?`,
        [connection.id]
      );
      check("removing a store takes its order mappings",
        Number(rows[0].total) === 0);
    }
  } catch (err) {
    check("suite ran", false, err.message);
    console.error(err);
  } finally {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    await pool.end();
    process.exitCode = failed ? 1 : 0;
  }
})();
