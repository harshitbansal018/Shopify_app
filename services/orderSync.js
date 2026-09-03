// services/orderSync.js
//
// A sale in a destination store becomes a job for the source store that
// supplied the goods -- priced at the SOURCE's own prices, never the marked-up
// ones the shopper paid.
//
// The job lives in this app, not in the source's Shopify admin. Nothing is
// written to that store: no order, no stock movement, no picking paperwork it
// did not ask for. The source works the sale on its Orders screen here.
//
// What the source decides DOES reach the buyer's store, because that is where
// the shopper is waiting:
//
//   marked fulfilled     the destination's real order is fulfilled with the
//                        same tracking, so Shopify emails the shopper and they
//                        can follow the parcel.
//
//   cannot supply        the destination's real order is cancelled and the
//                        shopper refunded. Leaving them charged for something
//                        nobody will send is worse than writing to a store we
//                        do not own.
//
// Both go through a queue rather than being sent inline, for the usual reason:
// a webhook or a screen must not wait on Shopify.
//
// Everything in between is order_mappings, which is the shared record.
const shopifyRequest = require("./shopify");
const orderModel = require("../models/orderModel");
const orderLineItemModel = require("../models/orderLineItemModel");
const orderMappingModel = require("../models/orderMappingModel");
const customerModel = require("../models/customerModel");

const ORDER_SYNC_INTERVAL_MS = Number(
  process.env.ORDER_SYNC_INTERVAL_MS || 60000
);

let orderSyncTimer = null;
let orderSyncRunning = false;

/** Shopify returns gids; our columns hold the numeric id. */
function numericId(gid) {
  if (gid === null || gid === undefined) return null;
  const match = String(gid).match(/(\d+)\s*$/);
  return match ? match[1] : null;
}

/** Money as a number to two places, or null. Never Number() alone: Number(null) is 0. */
function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : null;
}

/**
 * Split one destination order into the jobs it implies for each source.
 *
 * A basket can hold products from two source stores, so this groups by
 * connection and gives each source only its own lines. Lines the destination
 * sells itself have no mapping and are simply absent -- sourceLinesForOrder
 * has already dropped them.
 *
 * Nothing here talks to Shopify. It runs from the orders/create webhook, and a
 * webhook that calls out is what makes Shopify time the request out, retry it,
 * and eventually unsubscribe the topic.
 *
 * A test order is recorded like any other. Nothing is placed in anybody's
 * store any more, so a test checkout can no longer cause real work anywhere --
 * which is what the guard here used to be protecting against.
 */
async function queueForSources(destinationStoreId, order) {
  const lines = await orderLineItemModel.sourceLinesForOrder(order.id);

  if (!lines.length) return { connections: 0, lines: 0 };

  const byConnection = new Map();

  lines.forEach((line) => {
    if (!byConnection.has(line.connection_id)) {
      byConnection.set(line.connection_id, []);
    }
    byConnection.get(line.connection_id).push(line);
  });

  let queued = 0;

  for (const [connectionId, group] of byConnection) {
    // Totals for the row, so a screen can show what the shopper paid beside
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

/*
 * Shopify does not fulfil an order directly: it fulfils FULFILMENT ORDERS,
 * which are the order's lines grouped by who is expected to ship them. So the
 * line ids we hold have to be translated into fulfilment-order line ids first,
 * and that is what this query is for.
 *
 * remainingQuantity is the number that still needs shipping. Asking for more
 * than that is rejected, and asking for a line already shipped would create a
 * second fulfillment for goods that have gone once.
 */
const FULFILLMENT_ORDERS_QUERY = `
  query FulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          lineItems(first: 100) {
            nodes {
              id
              remainingQuantity
              lineItem { id }
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfilDestinationOrder($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

const FULFILLMENT_CANCEL_MUTATION = `
  mutation UnfulfilDestinationOrder($id: ID!) {
    fulfillmentCancel(id: $id) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

/**
 * Which fulfilment-order lines cover THIS source's part of the sale.
 *
 * A basket can hold products from two suppliers and some of the destination's
 * own; fulfilling all of it because one supplier shipped its share would tell
 * the shopper their whole order is on its way when most of it is not. So the
 * destination's line ids are matched one by one, and only ours are sent.
 *
 * Lines with nothing left to ship are skipped, which is also what makes a
 * retry safe after a partial success.
 */
function fulfilmentLinesFor(fulfillmentOrders, wanted) {
  const groups = [];

  (fulfillmentOrders || []).forEach((fulfillmentOrder) => {
    // CLOSED and CANCELLED fulfilment orders cannot be fulfilled, and asking
    // fails the whole mutation rather than just that group.
    if (fulfillmentOrder.status !== "OPEN" && fulfillmentOrder.status !== "IN_PROGRESS") {
      return;
    }

    const lines = (fulfillmentOrder.lineItems?.nodes || [])
      .filter((node) => {
        const orderLineId = numericId(node.lineItem?.id);
        return orderLineId && wanted.has(orderLineId) && node.remainingQuantity > 0;
      })
      .map((node) => ({
        id: node.id,
        // Never more than is left, however many the sale was for: a partial
        // shipment already gone would make the rest of the request invalid.
        quantity: Math.min(node.remainingQuantity, wanted.get(numericId(node.lineItem.id))),
      }));

    if (lines.length) {
      groups.push({
        fulfillmentOrderId: fulfillmentOrder.id,
        fulfillmentOrderLineItems: lines,
      });
    }
  });

  return groups;
}

/** Every parcel's number, url and carrier, in the shape the input wants. */
function trackingInput(parcels) {
  const list = (parcels || []).filter((parcel) => parcel && parcel.number);

  if (!list.length) return null;

  return {
    // numbers/urls rather than number/url: one order can ship in several
    // parcels, and the singular fields would keep only the first.
    numbers: list.map((parcel) => String(parcel.number)),
    urls: list.map((parcel) => parcel.url).filter(Boolean),
    // Shopify takes ONE carrier for the whole fulfillment. In practice a
    // merchant ships an order with one carrier, so the first is right; if it
    // is ever wrong it is cosmetic, and the numbers are still correct.
    company: list.find((parcel) => parcel.company)?.company || null,
  };
}

/**
 * Tell the buyer's store that the goods have shipped.
 *
 * This is what makes the source's "Mark fulfilled" real: the destination's own
 * Shopify order is fulfilled with the same tracking, so the shopper sees it in
 * their account and Shopify emails them the shipping confirmation.
 *
 * Only this source's lines are fulfilled. Never throws: a fulfilment that
 * cannot be sent must not stop the rest of the queue.
 */
async function fulfilOne(mapping) {
  try {
    // The destination's own line ids for this source's share, and how many of
    // each. sourceLinesForOrder gives us our rows; the ids Shopify knows are
    // on order_line_items.
    const lines = await orderLineItemModel.destinationLinesForConnection(
      mapping.destination_order_id,
      mapping.connection_id
    );

    if (!lines.length) {
      await orderMappingModel.markFulfilFailed(
        mapping.id,
        "None of this order's lines belong to this source any more"
      );
      return { ok: false, reason: "nothing to fulfil" };
    }

    const wanted = new Map(
      lines.map((line) => [String(line.shopify_line_item_id), line.quantity])
    );

    const read = await shopifyRequest.forShop(mapping.destination_shop_domain, {
      query: FULFILLMENT_ORDERS_QUERY,
      variables: {
        id: `gid://shopify/Order/${mapping.destination_shopify_order_id}`,
      },
    });

    const groups = fulfilmentLinesFor(
      read.order?.fulfillmentOrders?.nodes || [],
      wanted
    );

    if (!groups.length) {
      // Already shipped by the destination itself, or the order was cancelled.
      // Not a failure to retry: nothing will change on its own.
      await orderMappingModel.markFulfilSent(mapping.id, null);
      return { ok: true, alreadyFulfilled: true };
    }

    const fulfillment = { lineItemsByFulfillmentOrder: groups, notifyCustomer: true };
    const tracking = trackingInput(mapping.source_tracking);

    if (tracking) fulfillment.trackingInfo = tracking;

    const data = await shopifyRequest.forShop(mapping.destination_shop_domain, {
      query: FULFILLMENT_CREATE_MUTATION,
      variables: { fulfillment },
    });

    const result = data.fulfillmentCreate || {};
    const userErrors = result.userErrors || [];

    if (userErrors.length) {
      const reason = userErrors.map((e) => e.message).join("; ");
      await orderMappingModel.markFulfilFailed(mapping.id, reason);
      return { ok: false, reason };
    }

    await orderMappingModel.markFulfilSent(
      mapping.id,
      numericId(result.fulfillment?.id)
    );

    return { ok: true, fulfillmentId: numericId(result.fulfillment?.id) };
  } catch (err) {
    await orderMappingModel.markFulfilFailed(mapping.id, err.message);
    return { ok: false, reason: err.message };
  }
}

/** Send every queued fulfilment. */
async function pushFulfilments({ limit = 50 } = {}) {
  const pending = await orderMappingModel.listPendingFulfilments({ limit });
  const totals = { fulfilled: 0, failed: 0 };

  for (const mapping of pending) {
    const result = await fulfilOne(mapping);

    if (result.ok) totals.fulfilled += 1;
    else totals.failed += 1;
  }

  return totals;
}

/**
 * Undo a fulfilment that has already reached the buyer's store.
 *
 * Cancelling the Shopify fulfillment is what puts the order back to
 * unfulfilled there, so the shopper is not left with a shipping notice for a
 * parcel that is not coming.
 *
 * Called from the request rather than the queue: the merchant pressed Undo and
 * is waiting to be told whether it worked.
 */
async function cancelDestinationFulfilment(mapping) {
  if (!mapping.destination_fulfillment_id) return { ok: true, nothingToDo: true };

  try {
    const data = await shopifyRequest.forShop(mapping.destination_shop_domain, {
      query: FULFILLMENT_CANCEL_MUTATION,
      variables: {
        id: `gid://shopify/Fulfillment/${mapping.destination_fulfillment_id}`,
      },
    });

    const userErrors = data.fulfillmentCancel?.userErrors || [];

    if (userErrors.length) {
      return { ok: false, reason: userErrors.map((e) => e.message).join("; ") };
    }

    await orderMappingModel.clearDestinationFulfilment(mapping.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

const ORDER_CANCEL_MUTATION = `
  mutation CancelDestinationOrder(
    $orderId: ID!
    $reason: OrderCancelReason!
    $restock: Boolean!
    $refundMethod: OrderCancelRefundMethodInput
    $staffNote: String
    $notifyCustomer: Boolean
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      restock: $restock
      refundMethod: $refundMethod
      staffNote: $staffNote
      notifyCustomer: $notifyCustomer
    ) {
      job { id done }
      orderCancelUserErrors { field message code }
    }
  }
`;

/**
 * Cancel the destination's own order because the source says it cannot ship.
 *
 * The only place this app writes into a store it does not own, and it is
 * deliberate: leaving a shopper charged for goods nobody will send is worse
 * than the write.
 *
 * Shopify runs this as a background job, so a clean return means "accepted",
 * not "done". The destination's own orders/updated webhook is what confirms
 * it happened, which is also what keeps the two in step.
 *
 * Irreversible, so it is guarded twice: queueCancellation only fires on
 * 'none', and the attempt counter stops a loop.
 */
async function cancelOne(mapping) {
  try {
    const data = await shopifyRequest.forShop(mapping.destination_shop_domain, {
      query: ORDER_CANCEL_MUTATION,
      variables: {
        orderId: `gid://shopify/Order/${mapping.destination_shopify_order_id}`,
        // OTHER, not CUSTOMER: the shopper did not cancel this, the supplier
        // did, and recording it as the customer's doing would be a lie in the
        // destination's own reporting.
        reason: "OTHER",
        // The destination's stock went down when the shopper checked out, so
        // it has to come back or the store is short by one forever.
        restock: true,
        refundMethod: { originalPaymentMethodsRefund: true },
        staffNote: `Cannot be supplied by ${
          mapping.source_store_name || mapping.source_shop_domain
        }`,
        // The shopper is losing an order they paid for; they have to be told.
        notifyCustomer: true,
      },
    });

    const result = data.orderCancel || {};
    const userErrors = result.orderCancelUserErrors || [];

    if (userErrors.length) {
      const reason = userErrors.map((e) => e.message).join("; ");
      await orderMappingModel.markCancelFailed(mapping.id, reason);
      return { ok: false, reason };
    }

    await orderMappingModel.markCancelSent(mapping.id);
    return { ok: true };
  } catch (err) {
    await orderMappingModel.markCancelFailed(mapping.id, err.message);
    return { ok: false, reason: err.message };
  }
}

/** Send every queued cancellation. */
async function pushCancellations({ limit = 50 } = {}) {
  const pending = await orderMappingModel.listPendingCancellations({ limit });
  const totals = { cancelled: 0, failed: 0 };

  for (const mapping of pending) {
    const result = await cancelOne(mapping);

    if (result.ok) totals.cancelled += 1;
    else totals.failed += 1;
  }

  return totals;
}

/**
 * One background round: everything the source has decided, sent to the buyer's
 * store. Marking a sale shipped fulfils their real order; saying it cannot be
 * supplied cancels and refunds it.
 */
async function runOrderSync() {
  // A slow round must not overlap the next tick and send the same fulfilment
  // or cancellation twice.
  if (orderSyncRunning) return { skipped: true };

  orderSyncRunning = true;

  const totals = { fulfilled: 0, cancelled: 0, failed: 0 };

  try {
    // Fulfilments first: they are the common case, and a stuck cancellation
    // must not hold up telling shoppers their parcels are on the way.
    const shipped = await pushFulfilments();
    totals.fulfilled += shipped.fulfilled;
    totals.failed += shipped.failed;
  } catch (err) {
    console.warn("Fulfilment round failed:", err.message);
  }

  try {
    const cancelled = await pushCancellations();
    totals.cancelled += cancelled.cancelled;
    totals.failed += cancelled.failed;
  } catch (err) {
    console.warn("Cancellation round failed:", err.message);
  } finally {
    orderSyncRunning = false;
  }

  if (totals.fulfilled || totals.cancelled || totals.failed) {
    console.log(
      `Order sync: ${totals.fulfilled} fulfilled, ` +
        `${totals.cancelled} cancelled, ${totals.failed} failed`
    );
  }

  return totals;
}

/** Start the background round. Safe to call twice; the second call is a no-op. */
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

  // The order row keeps only customer_shopify_id; the identity behind it lives
  // in `customers`. Storing it is what lets the source store be shown who to
  // ship to, and it is also what makes customers/data_request and
  // customers/redact mean anything for a shopper who only ever ordered.
  if (payload.customer && payload.customer.id) {
    await customerModel.upsert(storeId, {
      ...payload.customer,
      // The webhook puts the contact details at the top level as well, and on
      // a guest checkout that is the only place they appear.
      email: payload.customer.email || payload.email || null,
      phone: payload.customer.phone || payload.phone || null,
    });
  }

  return order;
}

module.exports = {
  cacheOrder,
  queueForSources,
  fulfilOne,
  pushFulfilments,
  cancelDestinationFulfilment,
  fulfilmentLinesFor,
  trackingInput,
  cancelOne,
  pushCancellations,
  runOrderSync,
  startOrderSync,
  stopOrderSync,
};
