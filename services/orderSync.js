// services/orderSync.js
//
// A sale in a destination store becomes an order in the source store that
// supplied the goods -- at the SOURCE's own prices, never the marked-up ones
// the shopper paid.
//
// The two halves, and why they are separate:
//
//   queueForSources()  runs from the orders/create webhook. It reads our own
//                      tables only. A webhook must never call Shopify: an
//                      outbound call from inside one is what makes Shopify
//                      time the request out, retry it, and eventually
//                      unsubscribe the topic.
//
//   pushPending()      runs from the background loop and does the calling.
//
// Everything in between is order_mappings, which is the queue.
const shopifyRequest = require("./shopify");
const connectionModel = require("../models/connectionModel");
const orderModel = require("../models/orderModel");
const orderLineItemModel = require("../models/orderLineItemModel");
const orderMappingModel = require("../models/orderMappingModel");

const ORDER_SYNC_INTERVAL_MS = Number(
  process.env.ORDER_SYNC_INTERVAL_MS || 60000
);

let orderSyncTimer = null;
let orderSyncRunning = false;

/*
 * The source order carries a note and a tag saying where it came from. Both
 * are for the merchant standing in the source admin: without them the order
 * looks like it appeared from nowhere, and there is no way to tell an order
 * this app placed from one a human did.
 */
const SOURCE_ORDER_TAG = "product-sync";

const ORDER_CREATE_MUTATION = `
  mutation CreateSourceOrder(
    $order: OrderCreateOrderInput!
    $options: OrderCreateOptionsInput
  ) {
    orderCreate(order: $order, options: $options) {
      order {
        id
        name
        totalPriceSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

/** "gid://shopify/ProductVariant/123" for a raw id, passed through if already a gid. */
function variantGid(id) {
  const value = String(id);
  return value.startsWith("gid://") ? value : `gid://shopify/ProductVariant/${value}`;
}

/** Shopify returns gids; our columns hold the numeric id. */
function numericId(gid) {
  if (gid === null || gid === undefined) return null;
  const match = String(gid).match(/(\d+)\s*$/);
  return match ? match[1] : null;
}

/** Money as a fixed-2 string, or null. Never Number() on its own: Number(null) is 0. */
function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : null;
}

/**
 * Split one destination order into the source orders it implies.
 *
 * A basket can hold products from two source stores, so this groups by
 * connection and gives each source only its own lines. Lines the destination
 * sells itself have no mapping and are simply absent -- sourceLinesForOrder
 * has already dropped them.
 *
 * Nothing here talks to Shopify. It only writes the queue.
 */
async function queueForSources(destinationStoreId, order) {
  const lines = await orderLineItemModel.sourceLinesForOrder(order.id);

  if (!lines.length) return { connections: 0, lines: 0 };

  // A test order is a merchant trying the checkout out. Placing a real order
  // at the source for one would put real stock on a real invoice.
  if (order.test) {
    console.log(`Order ${order.name || order.id} is a test order; not forwarded`);
    return { connections: 0, lines: 0, skipped: "test" };
  }

  const byConnection = new Map();

  lines.forEach((line) => {
    if (!byConnection.has(line.connection_id)) {
      byConnection.set(line.connection_id, []);
    }
    byConnection.get(line.connection_id).push(line);
  });

  let queued = 0;

  for (const [connectionId, group] of byConnection) {
    // Totals for the row, so the screen can show what the shopper paid beside
    // what the source is owed without re-reading every line.
    const sourceTotal = group.reduce(
      (sum, line) => sum + (money(line.source_price) || 0) * line.quantity,
      0
    );
    const destinationTotal = group.reduce(
      (sum, line) => sum + (money(line.destination_price) || 0) * line.quantity,
      0
    );

    await orderMappingModel.claim(connectionId, order.id, {
      sourceTotal: money(sourceTotal),
      destinationTotal: money(destinationTotal),
      currency: order.currency || null,
      lineCount: group.length,
    });

    queued += 1;
  }

  return { connections: queued, lines: lines.length };
}

/**
 * Build the orderCreate input for one source store.
 *
 * priceSet is the whole point of this function. Without it Shopify would price
 * each line at whatever the variant currently costs IN THE SOURCE STORE, which
 * happens to be right today -- but it would also silently follow a later price
 * change, so the order would stop matching what was actually agreed. Sending
 * the price explicitly pins it.
 *
 * The marked-up price the shopper paid is never sent. That margin is the
 * destination's, not the source's.
 */
function buildOrderInput(mapping, lines, currency) {
  const lineItems = lines.map((line) => {
    const price = money(line.source_price);

    const item = {
      variantId: variantGid(line.source_shopify_variant_id),
      quantity: Number(line.quantity) || 1,
      requiresShipping: line.requires_shipping !== 0,
    };

    // A variant with no cached price is sent without one, so Shopify falls
    // back to the live price rather than the order being created as free.
    if (price !== null) {
      item.priceSet = { shopMoney: { amount: price.toFixed(2), currencyCode: currency } };
    }

    return item;
  });

  const reference =
    mapping.destination_order_name ||
    `#${mapping.destination_order_number || mapping.destination_shopify_order_id}`;

  return {
    order: {
      currency,
      lineItems,
      tags: [SOURCE_ORDER_TAG],
      // The destination store and its order number, so a human in the source
      // admin can trace this back to the sale that caused it.
      note:
        `Product Sync: ${reference} at ` +
        `${mapping.destination_store_name || mapping.destination_shop_domain}. ` +
        `Priced at this store's own prices, without the destination's margin.`,
    },
    options: {
      // The destination store already decremented its own stock when the
      // shopper checked out. Whether the source's stock should move too is the
      // source merchant's call, and DECREMENT_OBEYING_POLICY is the same rule
      // Shopify applies to an order placed by hand.
      inventoryBehaviour: "DECREMENT_OBEYING_POLICY",
      // No shopper email is attached to this order, and the source's customer
      // is the destination store rather than a person. A receipt would go
      // nowhere useful.
      sendReceipt: false,
    },
  };
}

/**
 * Place one queued order at its source store.
 *
 * Returns { ok } or { ok: false, reason }. Never throws for a bad order: a
 * single broken line must not stop the rest of the queue.
 */
async function pushOne(mapping) {
  const lines = (
    await orderLineItemModel.sourceLinesForOrder(mapping.destination_order_id)
  ).filter((line) => line.connection_id === mapping.connection_id);

  if (!lines.length) {
    // Every product on this order has been unshared or deleted since the sale.
    // There is nothing left to order, and retrying will not change that.
    await orderMappingModel.markSkipped(
      mapping.id,
      "No synced products from this source are left on the order"
    );
    return { ok: false, reason: "nothing to order" };
  }

  const currency = mapping.currency || "USD";
  const variables = buildOrderInput(mapping, lines, currency);

  try {
    const data = await shopifyRequest.forShop(mapping.source_shop_domain, {
      query: ORDER_CREATE_MUTATION,
      variables,
    });

    const result = data.orderCreate || {};
    const userErrors = result.userErrors || [];

    if (userErrors.length) {
      const reason = userErrors
        .map((error) => `${(error.field || []).join(".")}: ${error.message}`)
        .join("; ");

      await orderMappingModel.markFailed(mapping.id, reason);
      return { ok: false, reason };
    }

    if (!result.order) {
      await orderMappingModel.markFailed(mapping.id, "Shopify returned no order");
      return { ok: false, reason: "no order returned" };
    }

    await orderMappingModel.markSynced(mapping.id, {
      sourceShopifyOrderId: numericId(result.order.id),
      sourceOrderName: result.order.name,
    });

    return { ok: true, name: result.order.name };
  } catch (err) {
    // A dead token needs a reinstall and will keep failing until then, but the
    // attempt counter is what eventually stops it rather than a special case.
    await orderMappingModel.markFailed(mapping.id, err.message);
    return { ok: false, reason: err.message };
  }
}

/** Place everything queued on one connection. */
async function pushPending(connectionId, { limit = 50 } = {}) {
  const pending = await orderMappingModel.listPending(connectionId, { limit });
  const totals = { placed: 0, failed: 0 };

  for (const mapping of pending) {
    // The connection was paused or disconnected after the sale. Do not place
    // orders into a store the merchant has stopped trading with.
    if (mapping.connection_status !== "active") {
      await orderMappingModel.markSkipped(
        mapping.id,
        `Connection is ${mapping.connection_status}`
      );
      continue;
    }

    const result = await pushOne(mapping);

    if (result.ok) totals.placed += 1;
    else if (result.reason !== "nothing to order") totals.failed += 1;
  }

  return totals;
}

/** One round over every active connection. */
async function runOrderSync() {
  // A slow round must not overlap the next tick: two rounds pushing the same
  // queued order would place it twice at the source.
  if (orderSyncRunning) return { skipped: true };

  orderSyncRunning = true;

  const totals = { placed: 0, failed: 0, connections: 0 };

  try {
    for (const connection of await connectionModel.listAutoSync()) {
      totals.connections += 1;

      try {
        const result = await pushPending(connection.id);
        totals.placed += result.placed;
        totals.failed += result.failed;
      } catch (err) {
        // One broken connection must not stop every other merchant's orders.
        console.warn(
          `Order sync failed for connection ${connection.id}:`,
          err.message
        );
      }
    }
  } finally {
    orderSyncRunning = false;
  }

  if (totals.placed || totals.failed) {
    console.log(
      `Order sync: ${totals.placed} placed, ${totals.failed} failed ` +
        `across ${totals.connections} connection(s)`
    );
  }

  return totals;
}

/** Start the background push. Safe to call twice; the second call is a no-op. */
function startOrderSync() {
  if (orderSyncTimer) return orderSyncTimer;

  orderSyncTimer = setInterval(() => {
    runOrderSync().catch((err) =>
      console.error("Order sync round crashed:", err.message)
    );
  }, ORDER_SYNC_INTERVAL_MS);

  // Do not hold the process open just for this.
  if (orderSyncTimer.unref) orderSyncTimer.unref();

  console.log(
    `Order sync running every ${Math.round(ORDER_SYNC_INTERVAL_MS / 1000)}s`
  );

  return orderSyncTimer;
}

function stopOrderSync() {
  if (!orderSyncTimer) return;
  clearInterval(orderSyncTimer);
  orderSyncTimer = null;
}

/**
 * Cache an order from a webhook payload, lines and all.
 *
 * Shared by orders/create and orders/updated: the difference between them is
 * what the caller does next, not how the order is stored.
 */
async function cacheOrder(storeId, payload) {
  await orderModel.upsert(storeId, payload);

  const order = await orderModel.findByShopifyId(storeId, payload.id);

  if (!order) return null;

  await orderLineItemModel.syncForOrder(order.id, payload.line_items || []);

  return order;
}

module.exports = {
  cacheOrder,
  queueForSources,
  buildOrderInput,
  pushOne,
  pushPending,
  runOrderSync,
  startOrderSync,
  stopOrderSync,
  variantGid,
  numericId,
  SOURCE_ORDER_TAG,
};
