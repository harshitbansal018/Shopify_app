// models/dashboardModel.js
//
// The two things the dashboard shows that no other screen needs: recent sales
// day by day, and a short feed of what just happened. Everything else on the
// dashboard comes from the models that own it (products, payouts, orders).
//
// "side" is the store's role. A source sees the sales of its own goods in
// every destination; a destination sees the sales in its own store.
const { query } = require("../config/db");

/** The connection column that ties a row to this store, by role. */
function ownColumn(side) {
  return side === "destination" ? "c.destination_store_id" : "c.source_store_id";
}

/** The store at the OTHER end of a connection, by role. */
function otherJoin(side) {
  return side === "destination"
    ? "JOIN stores other ON other.id = c.source_store_id"
    : "JOIN stores other ON other.id = c.destination_store_id";
}

/**
 * The last 30 days, one entry per day (empty days included, so a chart has no
 * gaps), plus the 30 days before for a trend.
 *
 * Cancelled sales are left out: they were refunded and earned nobody anything.
 * `amount` is what this store is owed (source) or took (destination);
 * `cost` is what the destination owes for the same sales.
 */
async function salesSeries(storeId, side) {
  const own = ownColumn(side);

  const [days, previous] = await Promise.all([
    query(
      `SELECT DATE_FORMAT(om.created_at, '%Y-%m-%d')  AS day,
              COUNT(*)                                AS orders,
              COALESCE(SUM(om.source_total), 0)       AS source_total,
              COALESCE(SUM(om.destination_total), 0)  AS destination_total
         FROM order_mappings om
         JOIN store_connections c ON c.id = om.connection_id
        WHERE ${own} = ?
          AND om.created_at >= CURDATE() - INTERVAL 29 DAY
          AND om.source_fulfillment_status <> 'cancelled'
        GROUP BY DATE_FORMAT(om.created_at, '%Y-%m-%d')`,
      [storeId]
    ),
    query(
      `SELECT COUNT(*)                                AS orders,
              COALESCE(SUM(om.source_total), 0)       AS source_total,
              COALESCE(SUM(om.destination_total), 0)  AS destination_total
         FROM order_mappings om
         JOIN store_connections c ON c.id = om.connection_id
        WHERE ${own} = ?
          AND om.created_at >= CURDATE() - INTERVAL 59 DAY
          AND om.created_at <  CURDATE() - INTERVAL 29 DAY
          AND om.source_fulfillment_status <> 'cancelled'`,
      [storeId]
    ),
  ]);

  // Keyed by plain "YYYY-MM-DD" text on both sides. Going through
  // toISOString() would shift every day back by one east of UTC.
  const byDay = new Map(days.map((row) => [String(row.day), row]));
  const ymd = (date) =>
    date.getFullYear() + "-" +
    String(date.getMonth() + 1).padStart(2, "0") + "-" +
    String(date.getDate()).padStart(2, "0");

  const series = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const key = ymd(date);
    const row = byDay.get(key);

    series.push({
      day: key,
      orders: row ? Number(row.orders) : 0,
      source_total: row ? Number(row.source_total) : 0,
      destination_total: row ? Number(row.destination_total) : 0,
    });
  }

  const sum = (field) => series.reduce((total, day) => total + day[field], 0);
  const prev = previous[0] || {};

  return {
    series,
    current: {
      orders: sum("orders"),
      source_total: Number(sum("source_total").toFixed(2)),
      destination_total: Number(sum("destination_total").toFixed(2)),
    },
    previous: {
      orders: Number(prev.orders || 0),
      source_total: Number(prev.source_total || 0),
      destination_total: Number(prev.destination_total || 0),
    },
  };
}

/**
 * The newest few things that happened: sales arriving, sales cancelled,
 * payments recorded and products accepted. Read as four small queries and
 * merged here -- simpler to keep right than one UNION across four shapes.
 */
async function recentActivity(storeId, side, { limit = 6 } = {}) {
  const own = ownColumn(side);
  const other = otherJoin(side);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 6, 20));

  const [orders, cancelled, payments, accepted] = await Promise.all([
    query(
      `SELECT om.created_at AS at, o.name AS ref, om.line_count AS line_count,
              COALESCE(other.store_name, other.shop_domain) AS store
         FROM order_mappings om
         JOIN store_connections c ON c.id = om.connection_id
         JOIN orders o ON o.id = om.destination_order_id
         ${other}
        WHERE ${own} = ?
        ORDER BY om.created_at DESC
        LIMIT ?`,
      [storeId, safeLimit]
    ),
    query(
      `SELECT om.source_cancelled_at AS at, o.name AS ref,
              COALESCE(other.store_name, other.shop_domain) AS store
         FROM order_mappings om
         JOIN store_connections c ON c.id = om.connection_id
         JOIN orders o ON o.id = om.destination_order_id
         ${other}
        WHERE ${own} = ?
          AND om.source_cancelled_at IS NOT NULL
        ORDER BY om.source_cancelled_at DESC
        LIMIT ?`,
      [storeId, safeLimit]
    ),
    query(
      `SELECT p.paid_at AS at, p.amount, p.currency,
              COALESCE(other.store_name, other.shop_domain) AS store
         FROM payouts p
         JOIN store_connections c ON c.id = p.connection_id
         ${other}
        WHERE ${own} = ?
        ORDER BY p.paid_at DESC
        LIMIT ?`,
      [storeId, safeLimit]
    ),
    query(
      `SELECT DATE_FORMAT(pm.accepted_at, '%Y-%m-%d %H:00:00') AS at,
              COUNT(*) AS products,
              COALESCE(other.store_name, other.shop_domain) AS store
         FROM product_mappings pm
         JOIN store_connections c ON c.id = pm.connection_id
         ${other}
        WHERE ${own} = ?
          AND pm.accepted_at IS NOT NULL
        GROUP BY DATE_FORMAT(pm.accepted_at, '%Y-%m-%d %H:00:00'), store
        ORDER BY at DESC
        LIMIT ?`,
      [storeId, safeLimit]
    ),
  ]);

  const items = [
    ...orders.map((row) => ({
      kind: "order", at: row.at, ref: row.ref, store: row.store,
      lines: Number(row.line_count || 0),
    })),
    ...cancelled.map((row) => ({
      kind: "cancelled", at: row.at, ref: row.ref, store: row.store,
    })),
    ...payments.map((row) => ({
      kind: "payment", at: row.at, store: row.store,
      amount: Number(row.amount || 0), currency: row.currency,
    })),
    // Grouped by the hour: accepting 40 products is one event, not 40.
    ...accepted.map((row) => ({
      kind: "accepted", at: row.at, store: row.store,
      products: Number(row.products || 0),
    })),
  ];

  return items
    .filter((item) => item.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, safeLimit);
}

module.exports = { salesSeries, recentActivity };
