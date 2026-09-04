// models/payoutModel.js
//
// `payouts` -- money a DESTINATION store has paid a source store.
//
// The other half of the arithmetic lives on order_mappings, which holds what
// each sale earned and what it cost. Together they answer the only two
// questions this screen exists for:
//
//   profit       what the shopper paid, minus what the supplier is owed
//   outstanding  what the supplier is owed, minus what has been paid
//
// Owed is DERIVED, never stored. A running balance kept alongside the orders
// would be a second answer to the same question, and it would be the one that
// drifts the first time a row is edited.
//
// Only FULFILLED orders count towards what is owed. A supplier is paid for
// what it shipped: a sale it has not picked yet is not a debt, and one it
// cancelled was refunded to the shopper and never earned anything.
const { query, pool } = require("../config/db");

/** Money in, money out and what is left, for one destination store. */
const SUMMARY_SQL = `
  SELECT c.id                        AS connection_id,
         src.id                      AS source_store_id,
         src.shop_domain             AS source_shop_domain,
         src.store_name              AS source_store_name,
         c.status                    AS connection_status,

         -- Shipped: the part that is actually owed.
         COALESCE(SUM(CASE WHEN om.source_fulfillment_status = 'fulfilled'
                           THEN om.destination_total END), 0) AS revenue,
         COALESCE(SUM(CASE WHEN om.source_fulfillment_status = 'fulfilled'
                           THEN om.source_total END), 0)      AS cost,
         COUNT(CASE WHEN om.source_fulfillment_status = 'fulfilled'
                    THEN 1 END)                               AS fulfilled_orders,

         -- Not owed yet, but coming. Shown separately so a merchant can see
         -- what is about to land rather than being surprised by it.
         COALESCE(SUM(CASE WHEN om.source_fulfillment_status = 'unfulfilled'
                           THEN om.source_total END), 0)      AS upcoming_cost,
         COUNT(CASE WHEN om.source_fulfillment_status = 'unfulfilled'
                    THEN 1 END)                               AS open_orders,

         -- Cancelled sales earned nothing and cost nothing; counted only so
         -- the screen can say why an order is missing from the totals.
         COUNT(CASE WHEN om.source_fulfillment_status = 'cancelled'
                    THEN 1 END)                               AS cancelled_orders,

         -- One currency per connection in practice, and the first is as good
         -- an answer as any when a store has somehow used two.
         MIN(om.currency) AS currency
    FROM store_connections c
    JOIN stores src ON src.id = c.source_store_id
    LEFT JOIN order_mappings om ON om.connection_id = c.id
   WHERE c.destination_store_id = ?
   GROUP BY c.id, src.id, src.shop_domain, src.store_name, c.status
   ORDER BY src.store_name, src.shop_domain
`;

/** Everything paid so far, per connection. */
const PAID_SQL = `
  SELECT p.connection_id,
         COALESCE(SUM(p.amount), 0) AS paid,
         COUNT(*)                   AS payments,
         MAX(p.paid_at)             AS last_paid_at
    FROM payouts p
    JOIN store_connections c ON c.id = p.connection_id
   WHERE c.destination_store_id = ?
   GROUP BY p.connection_id
`;

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * One row per source store: what it earned, what it costs, what is still owed.
 *
 * Every connection is listed, including ones that have sold nothing. A source
 * the destination is connected to but owes nothing is a real and useful answer;
 * leaving it out would make the screen look like the connection is broken.
 */
async function summaryForDestination(destinationStoreId) {
  const [rows, paidRows] = await Promise.all([
    query(SUMMARY_SQL, [destinationStoreId]),
    query(PAID_SQL, [destinationStoreId]),
  ]);

  const paidBy = new Map(
    paidRows.map((row) => [
      row.connection_id,
      {
        paid: toNumber(row.paid),
        payments: Number(row.payments),
        lastPaidAt: row.last_paid_at,
      },
    ])
  );

  return rows.map((row) => {
    const settled = paidBy.get(row.connection_id) || {
      paid: 0,
      payments: 0,
      lastPaidAt: null,
    };

    const revenue = toNumber(row.revenue);
    const cost = toNumber(row.cost);

    return {
      connection_id: row.connection_id,
      source_store_id: row.source_store_id,
      source_shop_domain: row.source_shop_domain,
      source_store_name: row.source_store_name,
      connection_status: row.connection_status,
      currency: row.currency,

      revenue,
      cost,
      profit: Number((revenue - cost).toFixed(2)),

      paid: settled.paid,
      payments: settled.payments,
      last_paid_at: settled.lastPaidAt,
      // Can go negative, and that is not an error: a merchant who paid a round
      // amount up front is in credit, and hiding it behind a zero would lose
      // real money.
      outstanding: Number((cost - settled.paid).toFixed(2)),

      fulfilled_orders: Number(row.fulfilled_orders),
      open_orders: Number(row.open_orders),
      cancelled_orders: Number(row.cancelled_orders),
      upcoming_cost: toNumber(row.upcoming_cost),
    };
  });
}

/**
 * The same money, seen from the SOURCE's end: one row per destination store.
 *
 * Deliberately narrower than the destination's view. What the shopper paid,
 * and therefore the destination's margin, is not this store's business -- so
 * revenue and profit are absent and only `earned` is returned. It is the same
 * figure the destination calls `cost`.
 */
const SOURCE_SUMMARY_SQL = `
  SELECT c.id                        AS connection_id,
         dst.id                      AS destination_store_id,
         dst.shop_domain             AS destination_shop_domain,
         dst.store_name              AS destination_store_name,
         c.status                    AS connection_status,

         COALESCE(SUM(CASE WHEN om.source_fulfillment_status = 'fulfilled'
                           THEN om.source_total END), 0)      AS earned,
         COUNT(CASE WHEN om.source_fulfillment_status = 'fulfilled'
                    THEN 1 END)                               AS fulfilled_orders,

         COALESCE(SUM(CASE WHEN om.source_fulfillment_status = 'unfulfilled'
                           THEN om.source_total END), 0)      AS upcoming,
         COUNT(CASE WHEN om.source_fulfillment_status = 'unfulfilled'
                    THEN 1 END)                               AS open_orders,

         COUNT(CASE WHEN om.source_fulfillment_status = 'cancelled'
                    THEN 1 END)                               AS cancelled_orders,

         MIN(om.currency) AS currency
    FROM store_connections c
    JOIN stores dst ON dst.id = c.destination_store_id
    LEFT JOIN order_mappings om ON om.connection_id = c.id
   WHERE c.source_store_id = ?
   GROUP BY c.id, dst.id, dst.shop_domain, dst.store_name, c.status
   ORDER BY dst.store_name, dst.shop_domain
`;

const SOURCE_PAID_SQL = `
  SELECT p.connection_id,
         COALESCE(SUM(p.amount), 0) AS paid,
         COUNT(*)                   AS payments,
         MAX(p.paid_at)             AS last_paid_at
    FROM payouts p
    JOIN store_connections c ON c.id = p.connection_id
   WHERE c.source_store_id = ?
   GROUP BY p.connection_id
`;

/**
 * One row per destination store: what this store earned and what it is owed.
 *
 * Read-only from here. The destination records what it has paid, because it is
 * the end that pays; a supplier marking its own invoice settled would be a
 * different and much less trustworthy thing.
 */
async function summaryForSource(sourceStoreId) {
  const [rows, paidRows] = await Promise.all([
    query(SOURCE_SUMMARY_SQL, [sourceStoreId]),
    query(SOURCE_PAID_SQL, [sourceStoreId]),
  ]);

  const paidBy = new Map(
    paidRows.map((row) => [
      row.connection_id,
      {
        paid: toNumber(row.paid),
        payments: Number(row.payments),
        lastPaidAt: row.last_paid_at,
      },
    ])
  );

  return rows.map((row) => {
    const settled = paidBy.get(row.connection_id) || {
      paid: 0,
      payments: 0,
      lastPaidAt: null,
    };

    const earned = toNumber(row.earned);

    return {
      connection_id: row.connection_id,
      destination_store_id: row.destination_store_id,
      destination_shop_domain: row.destination_shop_domain,
      destination_store_name: row.destination_store_name,
      connection_status: row.connection_status,
      currency: row.currency,

      earned,
      received: settled.paid,
      payments: settled.payments,
      last_paid_at: settled.lastPaidAt,
      // Negative means they have paid ahead. Shown as such rather than floored
      // at zero, or a supplier would chase money it has already had.
      outstanding: Number((earned - settled.paid).toFixed(2)),

      fulfilled_orders: Number(row.fulfilled_orders),
      open_orders: Number(row.open_orders),
      cancelled_orders: Number(row.cancelled_orders),
      upcoming: toNumber(row.upcoming),
    };
  });
}

/** The payments made to one source store, newest first. */
async function listForConnection(connectionId, { limit = 100 } = {}) {
  return query(
    `SELECT * FROM payouts
      WHERE connection_id = ?
      ORDER BY paid_at DESC, id DESC
      LIMIT ?`,
    [connectionId, Number(limit)]
  );
}

/**
 * Record a payment.
 *
 * The amount is validated by the caller against what the merchant typed; this
 * only refuses what would corrupt the arithmetic. A zero payment is not a
 * payment, and a negative one would be a refund -- a different thing that this
 * screen does not claim to model.
 */
async function record(connectionId, { amount, currency, reference, note, paidAt }) {
  const value = Number(amount);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("A payment needs an amount greater than zero.");
  }

  const [result] = await pool.query(
    `INSERT INTO payouts (connection_id, amount, currency, reference, note, paid_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      connectionId,
      Number(value.toFixed(2)),
      currency ? String(currency).slice(0, 3) : null,
      reference ? String(reference).slice(0, 255) : null,
      note ? String(note).slice(0, 512) : null,
      // Defaulted here rather than in the column, so a merchant recording
      // Friday's transfer on Monday can say Friday.
      paidAt ? new Date(paidAt) : new Date(),
    ]
  );

  return result.insertId;
}

/** Undo a payment recorded by mistake. Scoped by the caller to this store. */
async function remove(id) {
  const [result] = await pool.query("DELETE FROM payouts WHERE id = ?", [id]);
  return result.affectedRows;
}

/** One payment, with the connection it belongs to, so ownership can be proved. */
async function findById(id) {
  const rows = await query(
    `SELECT p.*, c.destination_store_id, c.source_store_id
       FROM payouts p
       JOIN store_connections c ON c.id = p.connection_id
      WHERE p.id = ?
      LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  summaryForDestination,
  summaryForSource,
  listForConnection,
  record,
  remove,
  findById,
};
