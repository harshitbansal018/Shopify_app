// controllers/orderController.js
//
// The Orders screen, from both ends of a connection.
//
// A DESTINATION sees its own sales and, beside each one, the order raised at
// the source store that supplied the goods -- with what the shopper paid next
// to what the source is owed. Those two numbers differ by the markup in
// Settings, and showing them together is the only place that gap is visible.
//
// A SOURCE sees the orders it has been given: one per sale in a destination
// store, priced at this store's own prices.
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

    // Tabs mirror Products: one for what has gone through, one for what has
    // not. 'skipped' sits with the outstanding ones because it is still a sale
    // the source never received, and the merchant may want to know why.
    const requested = req.query.tab === "placed" ? "placed" : req.query.tab;
    const placed = rows.filter((row) => row.sync_status === "synced");
    const waiting = rows.filter((row) => row.sync_status !== "synced");
    const tab = requested || (waiting.length ? "waiting" : "placed");

    // Each role has its own screen under views/<role>/.
    res.render(`${req.store.store_type}/orders`, {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      tab,
      counts: { placed: placed.length, waiting: waiting.length },
      orders: (tab === "placed" ? placed : waiting).map((row) => ({
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

/**
 * Try a failed order again, now.
 *
 * Destination-only: the destination's sale is what raised this order, so it is
 * the end that owns the retry. Unlike the webhook path this may call Shopify,
 * because it is a request the merchant made and waited for.
 */
exports.postRetry = async (req, res) => {
  if (req.store.store_type !== "destination") {
    return res.status(403).json({ error: "Only the destination store retries an order." });
  }

  try {
    const mapping = await orderMappingModel.findById(Number(req.params.id));

    if (!mapping || mapping.destination_store_id !== req.storeId) {
      return res.status(404).json({ error: "Order not found." });
    }

    if (mapping.sync_status === "synced") {
      return res.status(409).json({
        error: `Already placed at the source as ${mapping.source_order_name}.`,
      });
    }

    // Clears the attempt count, or an order that has already burnt its retries
    // would be picked up and dropped again straight away.
    await orderMappingModel.requeue(mapping.id);

    const fresh = await orderMappingModel.findById(mapping.id);
    const result = await orderSync.pushOne(fresh);

    if (!result.ok) return res.status(502).json({ error: result.reason });

    return res.json({ ok: true, name: result.name });
  } catch (err) {
    console.error("Order retry failed:", err.message);
    return res.status(500).json({ error: "Could not place that order." });
  }
};
