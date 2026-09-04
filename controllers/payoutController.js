// controllers/payoutController.js
//
// The money side of the arrangement, from both ends.
//
// A destination sells a supplier's product at its own price and owes the
// supplier the source price. The two screens ask different questions of the
// same rows:
//
//   DESTINATION  what did I take, what did it cost me, what is my profit, and
//                what have I still to transfer. It can record payments,
//                because it is the end that pays.
//
//   SOURCE       what have I earned, what has arrived, what am I still owed.
//                Read-only: what the shopper paid is the destination's retail
//                price and its margin is not this store's business, and a
//                supplier marking its own invoice settled would be a much
//                less trustworthy thing than the payer recording it.
const payoutModel = require("../models/payoutModel");
const orderMappingModel = require("../models/orderMappingModel");
const connectionModel = require("../models/connectionModel");
const { renderStoreType } = require("./storeController");

function destinationOnly(req, res) {
  if (req.store.store_type !== "destination") {
    res.status(403).json({
      error: "Only the destination store settles up with its suppliers.",
    });
    return false;
  }
  return true;
}

/** Money for display. The DB gives DECIMAL back as a string. */
function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

/** A source store's end of it: earned, received, still owed. */
async function renderSourcePayouts(req, res) {
  const buyers = await payoutModel.summaryForSource(req.storeId);

  const totals = buyers.reduce(
    (sum, buyer) => ({
      earned: sum.earned + buyer.earned,
      received: sum.received + buyer.received,
      outstanding: sum.outstanding + buyer.outstanding,
      upcoming: sum.upcoming + buyer.upcoming,
    }),
    { earned: 0, received: 0, outstanding: 0, upcoming: 0 }
  );

  return res.render("source/payouts", {
    shop: req.shop,
    apiKey: process.env.SHOPIFY_API_KEY,
    store: req.store,
    buyers,
    totals: {
      // Rounded once, at the end: adding rounded rows and rounding again is
      // how a total ends up a penny off the numbers above it.
      earned: Number(totals.earned.toFixed(2)),
      received: Number(totals.received.toFixed(2)),
      outstanding: Number(totals.outstanding.toFixed(2)),
      upcoming: Number(totals.upcoming.toFixed(2)),
    },
    currency:
      buyers.find((buyer) => buyer.currency)?.currency ||
      req.store.currency ||
      "",
  });
}

exports.getPayouts = async (req, res) => {
  try {
    if (!req.store.store_type) return renderStoreType(req, res);

    // Both roles have payouts, and they are different screens.
    if (req.store.store_type === "source") {
      return await renderSourcePayouts(req, res);
    }

    const suppliers = await payoutModel.summaryForDestination(req.storeId);

    // Totals across every supplier, so the cards do not make the merchant add
    // the rows up themselves.
    const totals = suppliers.reduce(
      (sum, supplier) => ({
        revenue: sum.revenue + supplier.revenue,
        cost: sum.cost + supplier.cost,
        profit: sum.profit + supplier.profit,
        paid: sum.paid + supplier.paid,
        outstanding: sum.outstanding + supplier.outstanding,
        upcoming: sum.upcoming + supplier.upcoming_cost,
      }),
      { revenue: 0, cost: 0, profit: 0, paid: 0, outstanding: 0, upcoming: 0 }
    );

    // One currency across a merchant's suppliers in practice; the first one
    // that has a figure is the honest label for the cards.
    const currency =
      suppliers.find((supplier) => supplier.currency)?.currency ||
      req.store.currency ||
      "";

    res.render("destination/payouts", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      suppliers,
      totals: {
        ...totals,
        // Rounded once, at the end: adding rounded rows and rounding again is
        // how a total ends up a penny off the numbers above it.
        revenue: Number(totals.revenue.toFixed(2)),
        cost: Number(totals.cost.toFixed(2)),
        profit: Number(totals.profit.toFixed(2)),
        paid: Number(totals.paid.toFixed(2)),
        outstanding: Number(totals.outstanding.toFixed(2)),
        upcoming: Number(totals.upcoming.toFixed(2)),
      },
      currency,
    });
  } catch (err) {
    console.error("Payouts screen failed:", err.message);
    res.status(500).send("Error loading payouts");
  }
};

/**
 * One supplier: the payments already made, and the sales behind the balance.
 *
 * The orders are listed because "you owe 459.00" is not something a merchant
 * can act on or dispute without seeing which sales it came from.
 */
/** One buyer, from the source's end: what has arrived and what it was for. */
async function renderSourceBuyer(req, res, connectionId) {
  // The id came from a browser. Prove it belongs to THIS store before reading
  // anything: a guessed number must not show someone else's money.
  const mine = await connectionModel.listForSource(req.storeId);
  const connection = mine.find((row) => row.id === connectionId);

  if (!connection) return res.status(404).send("Store not found");

  const buyers = await payoutModel.summaryForSource(req.storeId);
  const buyer = buyers.find((row) => row.connection_id === connectionId);

  const [payments, orders] = await Promise.all([
    payoutModel.listForConnection(connectionId),
    orderMappingModel.listForSource(req.storeId, { limit: 200 }),
  ]);

  return res.render("source/payoutDetail", {
    shop: req.shop,
    apiKey: process.env.SHOPIFY_API_KEY,
    store: req.store,
    connection,
    buyer,
    payments: payments.map((payment) => ({
      ...payment,
      amount: toNumber(payment.amount),
    })),
    orders: orders
      .filter((order) => order.connection_id === connectionId)
      .map((order) => ({ ...order, source_total: toNumber(order.source_total) })),
    currency: buyer?.currency || req.store.currency || "",
  });
}

exports.getSupplier = async (req, res) => {
  try {
    if (!req.store.store_type) return renderStoreType(req, res);

    const connectionId = Number(req.params.id);

    if (req.store.store_type === "source") {
      return await renderSourceBuyer(req, res, connectionId);
    }

    // The id came from a browser. Prove it belongs to THIS store before
    // reading anything: a guessed number must not show someone else's money.
    const mine = await connectionModel.listForDestination(req.storeId);
    const connection = mine.find((row) => row.id === connectionId);

    if (!connection) return res.status(404).send("Supplier not found");

    const suppliers = await payoutModel.summaryForDestination(req.storeId);
    const supplier = suppliers.find((row) => row.connection_id === connectionId);

    const [payments, orders] = await Promise.all([
      payoutModel.listForConnection(connectionId),
      orderMappingModel.listForDestination(req.storeId, { limit: 200 }),
    ]);

    res.render("destination/payoutDetail", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      connection,
      supplier,
      payments: payments.map((payment) => ({
        ...payment,
        amount: toNumber(payment.amount),
      })),
      orders: orders
        .filter((order) => order.connection_id === connectionId)
        .map((order) => ({
          ...order,
          destination_total: toNumber(order.destination_total),
          source_total: toNumber(order.source_total),
        })),
      currency: supplier?.currency || req.store.currency || "",
    });
  } catch (err) {
    console.error("Payout detail failed:", err.message);
    res.status(500).send("Error loading that supplier");
  }
};

/** Record a transfer the merchant has made to a supplier. */
exports.postPayment = async (req, res) => {
  if (!destinationOnly(req, res)) return;

  const connectionId = Number(req.params.id);

  try {
    const mine = await connectionModel.listForDestination(req.storeId);
    const connection = mine.find((row) => row.id === connectionId);

    if (!connection) {
      return res.status(404).json({ error: "Supplier not found." });
    }

    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: "Enter the amount you paid.",
      });
    }

    const id = await payoutModel.record(connectionId, {
      amount,
      currency: req.body.currency || req.store.currency,
      reference: req.body.reference,
      note: req.body.note,
      paidAt: req.body.paid_at,
    });

    console.log(
      `${req.shop} recorded a payment of ${amount} to ` +
        `${connection.source.shop_domain}`
    );

    return res.json({ ok: true, id });
  } catch (err) {
    console.error("Recording a payment failed:", err.message);
    return res.status(500).json({ error: "Could not record that payment." });
  }
};

/** Delete a payment recorded by mistake. */
exports.deletePayment = async (req, res) => {
  if (!destinationOnly(req, res)) return;

  try {
    const payment = await payoutModel.findById(Number(req.params.paymentId));

    // Ownership is proved from the payment's own connection rather than from
    // the URL, so a guessed id cannot delete another merchant's record.
    if (!payment || payment.destination_store_id !== req.storeId) {
      return res.status(404).json({ error: "Payment not found." });
    }

    await payoutModel.remove(payment.id);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Deleting a payment failed:", err.message);
    return res.status(500).json({ error: "Could not delete that payment." });
  }
};
