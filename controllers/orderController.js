// controllers/orderController.js
//
// The Orders screen, from both ends of a connection.
//
// A DESTINATION sees its own sales and, beside each one, what the source store
// has done about it -- with what the shopper paid next to what the source is
// owed. Those two numbers differ by the markup in Settings, and showing them
// together is the only place that gap is visible.
//
// A SOURCE sees the sales it has been asked to supply, at its own prices, and
// WORKS them here: marking each shipped with its tracking, or saying it cannot
// supply it at all. Nothing is written to the source's own Shopify admin, so
// this screen is the only place that job exists -- but what it decides does
// reach the BUYER's store, which is where the shopper is waiting.
const orderMappingModel = require("../models/orderMappingModel");
const orderLineItemModel = require("../models/orderLineItemModel");
const orderSync = require("../services/orderSync");
const { renderStoreType } = require("./storeController");

/** Money for display. The DB gives DECIMAL back as a string. */
function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

exports.getOrders = async (req, res) => {
  try {
    if (!req.store.store_type) return renderStoreType(req, res);

    const isSource = req.store.store_type === "source";

    const rows = isSource
      ? await orderMappingModel.listForSource(req.storeId)
      : await orderMappingModel.listForDestination(req.storeId);

    const counts = await orderMappingModel.statusCounts(req.storeId, {
      side: isSource ? "source" : "destination",
    });

    // Tabs mirror Products: one for what still needs doing, one for what is
    // done. Cancelled sits with the finished ones -- it is settled, even if it
    // did not end well.
    const requested = req.query.tab === "done" ? "done" : req.query.tab;
    const open = rows.filter(
      (row) => row.source_fulfillment_status === "unfulfilled"
    );
    const done = rows.filter(
      (row) => row.source_fulfillment_status !== "unfulfilled"
    );

    // Land on whichever tab has something to act on.
    const tab = requested || (open.length ? "open" : "done");

    // Each role has its own screen under views/<role>/.
    res.render(`${req.store.store_type}/orders`, {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      tab,
      counts: { open: open.length, done: done.length },
      orders: (tab === "done" ? done : open).map((row) => ({
        ...row,
        destination_total: toNumber(row.destination_total),
        source_total: toNumber(row.source_total),
      })),
      statusCounts: counts,
    });
  } catch (err) {
    console.error("Orders screen failed:", err.message);
    res.status(500).send("Error loading orders");
  }
};

/** One order: the lines, with the source price beside the price paid. */
exports.getOrder = async (req, res) => {
  try {
    if (!req.store.store_type) return renderStoreType(req, res);

    const mapping = await orderMappingModel.findById(Number(req.params.id));

    // Scoped to THIS store, whichever end it is: a guessed id must not read
    // someone else's sales.
    const mine =
      mapping &&
      (mapping.source_store_id === req.storeId ||
        mapping.destination_store_id === req.storeId);

    if (!mine) return res.status(404).send("Order not found");

    const lines = (
      await orderLineItemModel.sourceLinesForOrder(mapping.destination_order_id)
    ).filter((line) => line.connection_id === mapping.connection_id);

    res.render(`${req.store.store_type}/orderDetail`, {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      order: {
        ...mapping,
        destination_total: toNumber(mapping.destination_total),
        source_total: toNumber(mapping.source_total),
      },
      lines: lines.map((line) => ({
        ...line,
        source_price: toNumber(line.source_price),
        destination_price: toNumber(line.destination_price),
      })),
    });
  } catch (err) {
    console.error("Order detail failed:", err.message);
    res.status(500).send("Error loading order");
  }
};


/* ------------------------------------------------------------------ */
/* Source actions                                                      */
/* ------------------------------------------------------------------ */

/**
 * The sale this source is being asked to supply, or null.
 *
 * The id came from a browser, so it is proved to belong to THIS store before
 * anything is written: a guessed number must not let one merchant mark another
 * merchant's sale shipped.
 */
async function mineAsSource(req) {
  if (req.store.store_type !== "source") return null;

  const mapping = await orderMappingModel.findById(Number(req.params.id));

  if (!mapping || mapping.source_store_id !== req.storeId) return null;

  return mapping;
}

function sourceOnly(res) {
  return res
    .status(403)
    .json({ error: "Only the source store handles fulfilment." });
}

/**
 * The source has shipped it.
 *
 * Recorded here AND queued for the buyer's store: the destination's real
 * Shopify order is fulfilled with the same tracking on the next round, so the
 * shopper gets their shipping email and can follow the parcel.
 *
 * Queued rather than sent inline so the merchant is not left waiting on
 * Shopify, and so a throttled call is retried instead of lost.
 */
exports.postFulfil = async (req, res) => {
  if (req.store.store_type !== "source") return sourceOnly(res);

  try {
    const mapping = await mineAsSource(req);

    if (!mapping) return res.status(404).json({ error: "Order not found." });

    if (mapping.source_fulfillment_status === "cancelled") {
      return res.status(409).json({
        error: "This order was cancelled and cannot be fulfilled.",
      });
    }

    // One order can go out in several parcels, so tracking is a list. An empty
    // list is allowed: plenty of merchants ship without a trackable service,
    // and refusing would leave them unable to mark anything done.
    const parcels = Array.isArray(req.body.tracking) ? req.body.tracking : [];

    await orderMappingModel.markFulfilled(mapping.id, parcels);

    return res.json({ ok: true, tracking: parcels.length });
  } catch (err) {
    console.error("Marking an order fulfilled failed:", err.message);
    return res.status(500).json({ error: "Could not update that order." });
  }
};

/**
 * Shipped by mistake, or the parcel came back.
 *
 * If the buyer's store has already been told, that fulfillment is cancelled
 * first -- otherwise the shopper is left holding a shipping notice for a
 * parcel that is not coming, and their order stays fulfilled forever.
 *
 * Done inline, unlike fulfilling: the merchant pressed Undo and needs to know
 * whether it actually worked, and a failure here has to be visible rather than
 * retried quietly in the background.
 */
exports.postUnfulfil = async (req, res) => {
  if (req.store.store_type !== "source") return sourceOnly(res);

  try {
    const mapping = await mineAsSource(req);

    if (!mapping) return res.status(404).json({ error: "Order not found." });

    const undone = await orderSync.cancelDestinationFulfilment(mapping);

    if (!undone.ok) {
      // The row is left alone. Saying it is unfulfilled here while the buyer's
      // order still says shipped would be the worse of the two lies.
      return res.status(502).json({
        error: `Could not undo it in ${
          mapping.destination_store_name || mapping.destination_shop_domain
        } -- ${undone.reason}`,
      });
    }

    await orderMappingModel.markUnfulfilled(mapping.id);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Reopening an order failed:", err.message);
    return res.status(500).json({ error: "Could not update that order." });
  }
};

/**
 * The source cannot supply this at all.
 *
 * The one action here that reaches another store: the destination's real
 * Shopify order is cancelled and the shopper refunded. Leaving them charged
 * for goods nobody will send would be worse.
 *
 * Queued rather than called inline, so a slow or throttled Shopify does not
 * hang the request -- and so a repeat click cannot ask twice. orderCancel is
 * irreversible.
 */
exports.postCancel = async (req, res) => {
  if (req.store.store_type !== "source") return sourceOnly(res);

  try {
    const mapping = await mineAsSource(req);

    if (!mapping) return res.status(404).json({ error: "Order not found." });

    if (mapping.source_fulfillment_status === "cancelled") {
      return res.status(409).json({ error: "This order is already cancelled." });
    }

    await orderMappingModel.markCancelledBySource(
      mapping.id,
      req.body.reason || null
    );

    const queued = await orderMappingModel.queueCancellation(mapping.id);

    console.log(
      `${req.shop} cannot supply ${mapping.destination_order_name}; ` +
        (queued
          ? "the buyer's order is queued for cancellation"
          : "the buyer's order was already queued")
    );

    return res.json({ ok: true, queued: Boolean(queued) });
  } catch (err) {
    console.error("Cancelling an order failed:", err.message);
    return res.status(500).json({ error: "Could not cancel that order." });
  }
};
