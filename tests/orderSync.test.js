/* A destination sale, and the job it makes for the source store.
 *
 * Run against the real database, not fixtures: the whole feature is four
 * tables joined together, and a join that compiles in JavaScript proves
 * nothing about whether MariaDB will run it.
 *
 * Two things matter most. The price: a source is owed its OWN price, never the
 * marked-up one the shopper paid, and getting that backwards would silently
 * overcharge every supplier. And the boundary: the source works the sale HERE,
 * so nothing may be written to its Shopify admin -- the one exception being
 * cancelling the buyer's real order when the goods will never ship.
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
const customerModel = require(path.join(SERVER, "models/customerModel"));
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
    // The shopper, exactly as the webhook sends them. Only the id reaches the
    // orders row; the rest has to be cached separately or the source store
    // cannot be told who to ship to.
    email: "steve@example.com",
    phone: "555-0100",
    customer: {
      id: 7001,
      first_name: "Steve",
      last_name: "Shopper",
      email: "steve@example.com",
    },
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    // Shaped exactly as Shopify sends it: snake_case, and the full country
    // and province names sitting NEXT TO the codes. Only the codes are valid
    // in MailingAddressInput, which is the trap this fixture exists to catch.
    shipping_address: {
      first_name: "Steve",
      last_name: "Shopper",
      address1: "1 Test Street",
      city: "Mohali",
      province: "Punjab",
      province_code: "PB",
      country: "United States",
      country_code: "US",
      zip: "10001",
      phone: "555-0100",
    },
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
      check("it starts unfulfilled",
        queued.source_fulfillment_status === "unfulfilled");
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
      check("a redelivered webhook does not record it twice",
        Number(rows[0].total) === 1,
        "the source would see the same sale two or three times");
    }

    /* ---------------- the source works it, here ---------------- */

    console.log("\nThe source fulfils it");
    {
      await orderMappingModel.markFulfilled(queued.id, [
        { number: "TRACK-1", company: "DHL", url: "https://dhl.test/1" },
        { number: "TRACK-2", company: "DHL" },
        { number: "", company: "Ignored" }, // no number, so no parcel
      ]);

      const shipped = await orderMappingModel.findById(queued.id);

      check("the row says fulfilled",
        shipped.source_fulfillment_status === "fulfilled");
      check("every parcel is kept",
        shipped.source_tracking.length === 2,
        `${shipped.source_tracking.length} -- one order can ship in several boxes`);
      check("a parcel with no number is dropped",
        shipped.source_tracking.every((p) => p.number),
        "a blank tracking row is worse than none");
      check("the carrier and link come with it",
        shipped.source_tracking[0].company === "DHL" &&
          shipped.source_tracking[0].url === "https://dhl.test/1");
      check("and when it was marked",
        Boolean(shipped.source_status_at));

      check("the destination sees the same row",
        (await orderMappingModel.listForDestination(destination.id))
          .find((row) => row.id === queued.id)
          .source_fulfillment_status === "fulfilled",
        "one record, read from both ends -- that IS the status sync");

      // The tabs group on this, so both ends must agree on the counts.
      check("it counts as done for both stores",
        (await orderMappingModel.statusCounts(source.id, { side: "source" }))
          .fulfilled === 1 &&
          (await orderMappingModel.statusCounts(destination.id)).fulfilled === 1);

      await orderMappingModel.markUnfulfilled(queued.id);

      const reopened = await orderMappingModel.findById(queued.id);

      check("undoing puts it back", reopened.source_fulfillment_status === "unfulfilled");
      check("and clears the tracking",
        reopened.source_tracking.length === 0,
        "stale tracking on an unshipped order would mislead the shopper");
    }

    /* ---------------- and the buyer's real order follows ---------------- */

    console.log("\nFulfilling the buyer's Shopify order");
    {
      const { fulfilmentLinesFor, trackingInput } = orderSync;

      await orderMappingModel.markFulfilled(queued.id, [
        { number: "TRACK-1", company: "DHL", url: "https://dhl.test/1" },
      ]);

      const armed = await orderMappingModel.findById(queued.id);

      check("marking it shipped queues the buyer's store",
        armed.fulfil_status === "pending",
        "saying it shipped and telling the shopper are one decision");
      check("and the round picks it up",
        (await orderMappingModel.listPendingFulfilments())
          .some((row) => row.id === queued.id));

      /* ---- only this source's lines ---- */
      // Shopify fulfils FULFILMENT orders, not orders, so our line ids have to
      // be translated first. wanted maps the buyer's line id -> quantity.
      const wanted = new Map([["950001", 2], ["950002", 1]]);

      const groups = fulfilmentLinesFor(
        [
          {
            id: "gid://shopify/FulfillmentOrder/1",
            status: "OPEN",
            lineItems: {
              nodes: [
                {
                  id: "gid://shopify/FulfillmentOrderLineItem/11",
                  remainingQuantity: 2,
                  lineItem: { id: "gid://shopify/LineItem/950001" },
                },
                {
                  // Another supplier's line, or the destination's own.
                  id: "gid://shopify/FulfillmentOrderLineItem/12",
                  remainingQuantity: 1,
                  lineItem: { id: "gid://shopify/LineItem/950003" },
                },
                {
                  // Ours, but already shipped.
                  id: "gid://shopify/FulfillmentOrderLineItem/13",
                  remainingQuantity: 0,
                  lineItem: { id: "gid://shopify/LineItem/950002" },
                },
              ],
            },
          },
          {
            // Closed: asking to fulfil it fails the whole mutation.
            id: "gid://shopify/FulfillmentOrder/2",
            status: "CLOSED",
            lineItems: {
              nodes: [
                {
                  id: "gid://shopify/FulfillmentOrderLineItem/21",
                  remainingQuantity: 1,
                  lineItem: { id: "gid://shopify/LineItem/950001" },
                },
              ],
            },
          },
        ],
        wanted
      );

      check("only the open fulfilment order is used",
        groups.length === 1 &&
          groups[0].fulfillmentOrderId === "gid://shopify/FulfillmentOrder/1",
        "a closed one cannot be fulfilled and fails the whole request");
      check("and only this source's lines within it",
        groups[0].fulfillmentOrderLineItems.length === 1 &&
          groups[0].fulfillmentOrderLineItems[0].id ===
            "gid://shopify/FulfillmentOrderLineItem/11",
        "fulfilling everything would tell the shopper their whole order shipped");
      check("with the quantity that is actually left",
        groups[0].fulfillmentOrderLineItems[0].quantity === 2);

      check("a line with nothing left is skipped",
        !JSON.stringify(groups).includes("FulfillmentOrderLineItem/13"),
        "it would create a second fulfillment for goods that already went");

      check("an order with nothing of ours open yields no groups",
        fulfilmentLinesFor([], wanted).length === 0);

      /* ---- tracking ---- */
      const tracking = trackingInput([
        { number: "T-1", company: "DHL", url: "https://dhl.test/1" },
        { number: "T-2", company: null, url: null },
      ]);

      check("every parcel's number is sent",
        tracking.numbers.length === 2,
        "the singular field would keep only the first");
      check("urls only where there is one",
        tracking.urls.length === 1);
      check("and one carrier for the fulfillment",
        tracking.company === "DHL",
        "Shopify takes a single company, whatever we hold");
      check("no tracking at all sends none",
        trackingInput([]) === null &&
          trackingInput([{ number: "" }]) === null,
        "an empty trackingInfo is worse than omitting it");

      /* ---- the queue's own rules ---- */
      await orderMappingModel.markFulfilSent(queued.id, "970055");

      const sent = await orderMappingModel.findById(queued.id);

      check("sending it records the fulfillment",
        sent.fulfil_status === "fulfilled" &&
          String(sent.destination_fulfillment_id) === "970055",
        "undo needs that id to cancel the right one");
      check("and it leaves the queue",
        (await orderMappingModel.listPendingFulfilments())
          .every((row) => row.id !== queued.id));

      // Re-marking a sale that Shopify already knows about must not make a
      // second fulfillment for the same goods.
      await orderMappingModel.markFulfilled(queued.id, []);

      check("re-marking it does not queue a second fulfillment",
        (await orderMappingModel.findById(queued.id)).fulfil_status === "fulfilled");

      await orderMappingModel.markFulfilFailed(queued.id, "Already fulfilled");

      const failed = await orderMappingModel.findById(queued.id);

      check("a failure is recorded with its reason",
        failed.fulfil_status === "failed" &&
          failed.fulfil_error === "Already fulfilled");
      check("and the attempt is counted", failed.fulfil_attempts === 1);
      check("it is retried",
        (await orderMappingModel.listPendingFulfilments())
          .some((row) => row.id === queued.id));
      check("but not forever",
        (await orderMappingModel.listPendingFulfilments({ maxAttempts: 1 }))
          .every((row) => row.id !== queued.id));

      /* ---- undoing ---- */
      await orderMappingModel.markUnfulfilled(queued.id);

      const undone = await orderMappingModel.findById(queued.id);

      check("undoing takes it out of the queue",
        undone.fulfil_status === "none" && undone.fulfil_attempts === 0);
      check("but keeps the fulfillment id",
        String(undone.destination_fulfillment_id) === "970055",
        "it is the only handle on the fulfillment that has to be cancelled");

      await orderMappingModel.clearDestinationFulfilment(queued.id);

      check("which is forgotten once it is cancelled",
        (await orderMappingModel.findById(queued.id))
          .destination_fulfillment_id === null);

      // A sale the source has since reopened must not be fulfilled by a round
      // that was already in flight.
      await orderMappingModel.markFulfilled(queued.id, []);
      await orderMappingModel.markUnfulfilled(queued.id);

      check("a reopened sale is never sent",
        (await orderMappingModel.listPendingFulfilments())
          .every((row) => row.id !== queued.id));
    }

    console.log("\nThe source cannot supply it");
    {
      await orderMappingModel.markCancelledBySource(queued.id, "out of stock");

      const cancelled = await orderMappingModel.findById(queued.id);

      check("the row says cancelled",
        cancelled.source_fulfillment_status === "cancelled");
      check("with the reason and the time",
        cancelled.source_cancel_reason === "out of stock" &&
          Boolean(cancelled.source_cancelled_at));

      check("fulfilling a cancelled order is refused",
        (await orderMappingModel.markFulfilled(queued.id, [])) === 0 &&
          (await orderMappingModel.findById(queued.id))
            .source_fulfillment_status === "cancelled",
        "the buyer has already been refunded for it");

      /* ---- the buyer's real order ---- */
      check("the buyer's order is queued for cancellation",
        (await orderMappingModel.queueCancellation(queued.id)) === 1);
      check("but only once",
        (await orderMappingModel.queueCancellation(queued.id)) === 0,
        "orderCancel is irreversible; asking twice risks a second refund");

      check("the round picks it up",
        (await orderMappingModel.listPendingCancellations())
          .some((row) => row.id === queued.id));

      await orderMappingModel.markCancelFailed(queued.id, "Order already closed");

      const failed = await orderMappingModel.findById(queued.id);

      check("a failure is recorded with its reason",
        failed.cancel_status === "failed" &&
          failed.cancel_error === "Order already closed");
      check("and the attempt is counted", failed.cancel_attempts === 1);
      check("it is retried",
        (await orderMappingModel.listPendingCancellations())
          .some((row) => row.id === queued.id),
        "a store that was briefly unreachable should recover on its own");
      check("but not forever",
        (await orderMappingModel.listPendingCancellations({ maxAttempts: 1 }))
          .every((row) => row.id !== queued.id));

      await orderMappingModel.markCancelSent(queued.id);

      const done = await orderMappingModel.findById(queued.id);

      check("sending it clears the error", done.cancel_status === "cancelled" &&
        done.cancel_error === null);
      check("and it leaves the queue",
        (await orderMappingModel.listPendingCancellations())
          .every((row) => row.id !== queued.id));
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
