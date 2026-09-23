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
const { withTransaction } = require("../config/db");
const shopifyRequest = require("./shopify");
const orderModel = require("../models/orderModel");
const orderLineItemModel = require("../models/orderLineItemModel");
const orderMappingModel = require("../models/orderMappingModel");
const orderShipmentModel = require("../models/orderShipmentModel");
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

    const mapping = await orderMappingModel.claim(connectionId, order.id, {
      sourceTotal: money(sourceTotal),
      destinationTotal: money(destinationTotal),
      currency: order.currency || null,
      lineCount: group.length,
    });

    // Tell the source it has an order to ship, if this destination has that
    // email on. Queued, never thrown, and keyed on the mapping -- so a
    // redelivered webhook does not email the source twice.
    await require("./notifications").orderCreated(mapping);

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
 * Tell the buyer's store that one shipment has gone out.
 *
 * This is what makes the source's "Mark fulfilled" real: the destination's own
 * Shopify order is fulfilled with the same tracking, so the shopper sees it in
 * their account and Shopify emails them the shipping confirmation.
 *
 * One SHIPMENT, not one sale: a sale shipped in two parcels is two
 * fulfillments over there, each with its own tracking, which is what happened.
 * Only the lines and quantities this shipment carried are fulfilled. Never
 * throws: a fulfilment that cannot be sent must not stop the rest of the queue.
 */
async function fulfilOne(shipment) {
  try {
    // The destination's own line ids for what this shipment carried, and how
    // many of each. The shipment holds OUR line ids; the ids Shopify knows are
    // on order_line_items.
    const lines = await orderLineItemModel.destinationLinesForConnection(
      shipment.destination_order_id,
      shipment.connection_id
    );

    const carried = new Map(
      shipment.lines.map((line) => [Number(line.line_id), Number(line.quantity)])
    );

    const wanted = new Map();
    lines.forEach((line) => {
      const quantity = carried.get(Number(line.line_id));
      if (quantity > 0) wanted.set(String(line.shopify_line_item_id), quantity);
    });

    if (!wanted.size) {
      // Nothing of this shipment is on the buyer's order any more. Not a
      // failure to retry: nothing will change on its own.
      await orderShipmentModel.markSent(shipment.id, null);
      return { ok: true, nothingToFulfil: true };
    }

    const read = await shopifyRequest.forShop(shipment.destination_shop_domain, {
      query: FULFILLMENT_ORDERS_QUERY,
      variables: {
        id: `gid://shopify/Order/${shipment.destination_shopify_order_id}`,
      },
    });

    const groups = fulfilmentLinesFor(
      read.order?.fulfillmentOrders?.nodes || [],
      wanted
    );

    if (!groups.length) {
      // Already shipped by the destination itself, or the order was cancelled.
      // Not a failure to retry: nothing will change on its own.
      await orderShipmentModel.markSent(shipment.id, null);
      return { ok: true, alreadyFulfilled: true };
    }

    const fulfillment = { lineItemsByFulfillmentOrder: groups, notifyCustomer: true };
    const tracking = trackingInput(shipment.tracking);

    if (tracking) fulfillment.trackingInfo = tracking;

    const data = await shopifyRequest.forShop(shipment.destination_shop_domain, {
      query: FULFILLMENT_CREATE_MUTATION,
      variables: { fulfillment },
    });

    const result = data.fulfillmentCreate || {};
    const userErrors = result.userErrors || [];

    if (userErrors.length) {
      const reason = userErrors.map((e) => e.message).join("; ");
      await orderShipmentModel.markFailed(shipment.id, reason);
      return { ok: false, reason };
    }

    await orderShipmentModel.markSent(
      shipment.id,
      numericId(result.fulfillment?.id)
    );

    return { ok: true, fulfillmentId: numericId(result.fulfillment?.id) };
  } catch (err) {
    await orderShipmentModel.markFailed(shipment.id, err.message);
    return { ok: false, reason: err.message };
  }
}
/** Send every queued fulfilment. */
async function pushFulfilments({ limit = 50 } = {}) {
  const pending = await orderShipmentModel.listPending({ limit });
  const totals = { fulfilled: 0, failed: 0 };

  for (const shipment of pending) {
    const result = await fulfilOne(shipment);

    if (result.ok) totals.fulfilled += 1;
    else totals.failed += 1;
  }

  return totals;
}

/**
 * Cancel one fulfillment in the buyer's store.
 *
 * What puts that part of the order back to unfulfilled over there, so the
 * shopper is not left with a shipping notice for a parcel that is not coming.
 * Returns rather than throws: the caller decides what an unwilling Shopify
 * means for the sale.
 */
async function cancelDestinationFulfilment(mapping, fulfillmentId) {
  if (!fulfillmentId) return { ok: true, nothingToDo: true };

  try {
    const data = await shopifyRequest.forShop(mapping.destination_shop_domain, {
      query: FULFILLMENT_CANCEL_MUTATION,
      variables: { id: `gid://shopify/Fulfillment/${fulfillmentId}` },
    });

    const userErrors = data.fulfillmentCancel?.userErrors || [];

    if (userErrors.length) {
      return { ok: false, reason: userErrors.map((e) => e.message).join("; ") };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/* ------------------------------------------------------------------ */
/* What the source ships                                               */
/* ------------------------------------------------------------------ */

/**
 * The sale's lines with how many of each have shipped and how many are left.
 *
 * What both the detail screen and the shipping request work from, so the
 * numbers the merchant sees are the numbers the request is checked against.
 */
async function lineProgress(mapping, { connection = null } = {}) {
  const [lines, shipped] = await Promise.all([
    // What was ordered cannot change while it is being shipped, so this one
    // is left on the pool even inside a transaction.
    orderLineItemModel.destinationLinesForConnection(
      mapping.destination_order_id,
      mapping.connection_id
    ),
    orderShipmentModel.shippedByLine(mapping.id, { connection }),
  ]);

  return lines.map((line) => {
    const done = shipped.get(Number(line.line_id)) || 0;
    return {
      line_id: Number(line.line_id),
      quantity: Number(line.quantity),
      shipped: Math.min(done, Number(line.quantity)),
      remaining: Math.max(0, Number(line.quantity) - done),
    };
  });
}

/**
 * Record that some or all of a sale has shipped.
 *
 * `lines` is [{ line_id, quantity }] -- what is going out NOW. Left out, it
 * means everything still unshipped. Anything over what is left on a line is
 * refused outright rather than trimmed: a merchant who typed 5 when 3 were
 * left has made a mistake worth telling them about, not quietly fixing.
 *
 * The sale's status is then set from the totals -- partial while anything is
 * still to go, fulfilled once nothing is -- and the shipment is queued for
 * the buyer's store. Returns the shipment, or null if nothing was shippable.
 */
async function recordShipment(mappingId, { lines = null, tracking = [] } = {}) {
  /*
   * One sale at a time.
   *
   * Shipping is read-then-write: how many are left, then the row saying what
   * went. Two requests for the same sale -- two tabs, or a retry landing on
   * top of a request that had not finished -- both read "2 left" and both
   * ship 2, and a sale for two is recorded as four shipped.
   *
   * The lock makes the second wait for the first, so by the time it reads,
   * the answer is 0 and it refuses on its own. Everything inside is database
   * work: the buyer's store is told later, by the background round, so no
   * Shopify call is ever made while this is held.
   *
   * A throw in here -- including the ordinary "only 2 left" refusals below --
   * rolls the whole thing back, so a half-written shipment cannot survive.
   */
  return withTransaction(async (conn) => {
    await orderMappingModel.lockForShipping(conn, mappingId);

    return recordShipmentLocked(conn, mappingId, { lines, tracking });
  });
}

/** The body of recordShipment, with this sale's row already held. */
async function recordShipmentLocked(conn, mappingId, { lines, tracking }) {
  const mapping = await orderMappingModel.findById(mappingId, { connection: conn });

  if (!mapping || mapping.source_fulfillment_status === "cancelled") return null;

  const progress = await lineProgress(mapping, { connection: conn });
  const remainingById = new Map(progress.map((line) => [line.line_id, line.remaining]));

  let shipping;

  if (lines === null) {
    shipping = progress
      .filter((line) => line.remaining > 0)
      .map((line) => ({ line_id: line.line_id, quantity: line.remaining }));
  } else {
    shipping = [];

    for (const line of lines || []) {
      const id = Number(line.line_id);
      const quantity = Number(line.quantity);

      if (!remainingById.has(id)) {
        throw invalid(`Line ${id} is not on this sale.`);
      }
      if (!Number.isInteger(quantity) || quantity < 0) {
        throw invalid("Quantities must be whole numbers.");
      }
      if (quantity > remainingById.get(id)) {
        throw invalid(
          `Only ${remainingById.get(id)} left to ship on one of the lines; ` +
            `you entered ${quantity}.`
        );
      }
      if (quantity > 0) shipping.push({ line_id: id, quantity });
    }
  }

  // A sale with no lines left at all -- every product on it since unsynced,
  // or a webhook that took them away -- can still be closed out. There is
  // nothing to ship, and nothing to fulfil in the buyer's store, but the
  // merchant needs a way to get it off the To fulfil list.
  const closingOut = lines === null && progress.length === 0;

  if (!shipping.length && !closingOut) {
    throw invalid("Nothing to ship: enter a quantity on at least one line.");
  }

  const shipment = await orderShipmentModel.create(
    mapping.id,
    { lines: shipping, tracking },
    { connection: conn }
  );

  const totalRemaining = progress.reduce((sum, line) => sum + line.remaining, 0);
  const nowShipping = shipping.reduce((sum, line) => sum + line.quantity, 0);

  await orderMappingModel.setSourceStatus(
    mapping.id,
    nowShipping >= totalRemaining ? "fulfilled" : "partial",
    { connection: conn }
  );

  return shipment;
}

/** A bad request, with the status a handler should answer with. */
function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/**
 * Undo every shipment on a sale: back to unfulfilled.
 *
 * Each fulfillment already created in the buyer's store is cancelled FIRST,
 * and the whole thing stops at the first one that will not cancel -- saying
 * the sale is unfulfilled here while the buyer's order still says shipped
 * would be the worse of the two lies.
 *
 * Called from the request rather than the queue: the merchant pressed Undo and
 * is waiting to be told whether it worked.
 */
async function reopen(mapping) {
  /*
   * Undoing is read-then-write too, but unlike recordShipment the middle of
   * it is a call to the buyer's Shopify store, which can take seconds. A
   * database lock is not held across that -- one slow reply would hold a
   * pooled connection and make every competing request wait out the lock
   * timeout. So the lock is taken twice, briefly, and the second time checks
   * that the ground has not moved.
   */
  const shipments = await withTransaction(async (conn) => {
    await orderMappingModel.lockForShipping(conn, mapping.id);
    return orderShipmentModel.listForMapping(mapping.id, { connection: conn });
  });

  for (const shipment of shipments) {
    if (shipment.push_status === "cancelled") continue;

    if (shipment.destination_fulfillment_id) {
      const undone = await cancelDestinationFulfilment(
        mapping,
        shipment.destination_fulfillment_id
      );

      if (!undone.ok) return undone;
    }

    await orderShipmentModel.markCancelled(shipment.id);
  }

  return withTransaction(async (conn) => {
    await orderMappingModel.lockForShipping(conn, mapping.id);

    // A shipment recorded while the cancellations were in flight is one this
    // round never cancelled. Calling the sale unfulfilled now would hide a
    // parcel that really is on its way, so say so instead.
    const stillShipped = await orderShipmentModel.shippedByLine(mapping.id, {
      connection: conn,
    });
    const outstanding = [...stillShipped.values()].reduce((sum, n) => sum + n, 0);

    if (outstanding > 0) {
      return {
        ok: false,
        conflict: true,
        reason:
          "Something else on this order shipped while it was being undone. " +
          "Reload the order and try again.",
      };
    }

    await orderMappingModel.markUnfulfilled(mapping.id, { connection: conn });
    return { ok: true, undone: shipments.length };
  });
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
  lineProgress,
  recordShipment,
  reopen,
  fulfilmentLinesFor,
  trackingInput,
  cancelOne,
  pushCancellations,
  runOrderSync,
  startOrderSync,
  stopOrderSync,
};
