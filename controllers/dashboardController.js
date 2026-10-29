// controllers/dashboardController.js
//
// The landing screen. Each role gets the same useful overview shape, with the
// labels reversed to match the direction products and orders move.
const sourceProductModel = require("../models/sourceProductModel");
const connectionModel = require("../models/connectionModel");
const productMappingModel = require("../models/productMappingModel");
const orderLineItemModel = require("../models/orderLineItemModel");
const payoutModel = require("../models/payoutModel");
const dashboardModel = require("../models/dashboardModel");
const { renderStoreType } = require("./storeController");
const setupController = require("./setupController");

/** Adds one numeric field across rows, to the cent. */
function sumOf(rows, field) {
  return Number(
    rows.reduce((total, row) => total + (Number(row[field]) || 0), 0).toFixed(2)
  );
}

/** Products sent out, destinations receiving them, and orders coming back. */
async function sourceStats(storeId) {
  const [counts, connections, topSellers, buyers, sales, activity] = await Promise.all([
    // Counted in SQL. This used to read 5,000 whole product rows to produce
    // three numbers, and a store past that cap saw a total that was simply
    // wrong with nothing on the screen to say so.
    sourceProductModel.countsWithMappingStatus(storeId),
    connectionModel.listForSource(storeId),
    orderLineItemModel.topSellingSourceProducts(storeId, { limit: 5 }),
    payoutModel.summaryForSource(storeId),
    dashboardModel.salesSeries(storeId, "source"),
    dashboardModel.recentActivity(storeId, "source"),
  ]);

  const byDestination = await Promise.all(
    connections.map(async (connection) => {
      const status = await productMappingModel.statusBreakdown(connection.id);

      return {
        domain: connection.destination.shop_domain,
        name:
          connection.destination.store_name || connection.destination.shop_domain,
        status: connection.status,
        active:
          connection.status === "active" && connection.destination.is_active,
        synced: status.synced,
        unsynced: status.pending + status.failed + status.skipped + status.deleted,
      };
    })
  );

  return {
    cards: {
      staged: counts.all,
      shared: counts.shared,
      unshared: counts.unshared,
      stores: connections.filter(
        (connection) =>
          connection.status === "active" && connection.destination.is_active
      ).length,
    },
    byDestination: byDestination.sort(
      (a, b) =>
        b.synced + b.unsynced - (a.synced + a.unsynced) ||
        a.name.localeCompare(b.name)
    ),
    topSellers,
    // What is owed, and the work waiting, across every buyer.
    money: {
      outstanding: sumOf(buyers, "outstanding"),
      openOrders: sumOf(buyers, "open_orders"),
      payers: buyers.filter((buyer) => buyer.outstanding > 0).length,
      currency: (buyers[0] && buyers[0].currency) || null,
    },
    sales,
    activity,
  };
}

/** Everything the destination dashboard shows, from one read of the mappings. */
async function destinationStats(storeId) {
  // Both counted in SQL. This used to read 500 whole product rows and tally
  // them here, so a store past 500 got a chart and two cards that were quietly
  // wrong -- and paid for the full product payload to produce two numbers.
  const [counts, bySourceCounts, connections, topSellers, suppliers, sales, activity] = await Promise.all([
    sourceProductModel.countsSyncedIntoStore(storeId),
    sourceProductModel.countsSyncedBySource(storeId),
    connectionModel.listForDestination(storeId),
    orderLineItemModel.topSellingProducts(storeId, { limit: 5 }),
    payoutModel.summaryForDestination(storeId),
    dashboardModel.salesSeries(storeId, "destination"),
    dashboardModel.recentActivity(storeId, "destination"),
  ]);

  // Seeded from the CONNECTIONS, not from the products: a store that is
  // connected but has offered nothing yet still belongs on the list. Building
  // it from the products alone would leave the card saying "3 stores" beside a
  // list of one.
  const bySource = new Map();

  connections.forEach((connection) => {
    bySource.set(connection.source.shop_domain, {
      domain: connection.source.shop_domain,
      name: connection.source.store_name || connection.source.shop_domain,
      status: connection.status,
      active: connection.status === "active" && connection.source.is_active,
      synced: 0,
      unsynced: 0,
    });
  });

  bySourceCounts.forEach((row) => {
    const domain = row.source_shop_domain;

    // A product can outlive its connection; keep it counted rather than
    // silently dropping it off the chart.
    if (!bySource.has(domain)) {
      bySource.set(domain, {
        domain,
        name: row.source_store_name || domain,
        status: "disconnected",
        active: false,
        synced: 0,
        unsynced: 0,
      });
    }

    const entry = bySource.get(domain);
    entry.synced += row.synced;
    entry.unsynced += row.unsynced;
  });

  return {
    cards: {
      synced: counts.synced,
      unsynced: counts.unsynced,
      stores: connections.filter((c) => c.status === "active").length,
    },
    // Biggest first: a bar chart sorted by size is readable, one in insertion
    // order is not. Ties fall back to the name so the order does not shuffle
    // between page loads.
    bySource: [...bySource.values()].sort(
      (a, b) =>
        b.synced + b.unsynced - (a.synced + a.unsynced) ||
        a.name.localeCompare(b.name)
    ),
    topSellers,
    money: {
      outstanding: sumOf(suppliers, "outstanding"),
      openOrders: sumOf(suppliers, "open_orders"),
      currency: (suppliers[0] && suppliers[0].currency) || null,
    },
    sales,
    activity,
  };
}

exports.getDashboard = async (req, res) => {
  try {
    // A store with no type cannot do anything useful yet -- every feature
    // depends on knowing whether products flow out of it or into it. Render
    // the one-time picker in place rather than redirecting: a redirect would
    // drop the id_token off the URL and bounce the merchant through OAuth.
    if (!req.store.store_type) {
      return renderStoreType(req, res);
    }

    // Straight from picking a side to the setup screen, and back here only
    // once it is finished or skipped. Rendered in place for the same reason
    // as the picker above: a redirect drops the token off the URL.
    if (!req.store.onboarded_at) {
      return setupController.getSetup(req, res);
    }

    // Read every time rather than remembered, so a store that skipped setup
    // and later finished it stops being nagged without pressing anything --
    // and one that undoes a step is told again. A handful of counted rows,
    // next to nothing beside the figures below.
    const setup = await setupController.statusFor(req.store);

    // Each role has its own screen under views/<role>/.
    res.render(`${req.store.store_type}/dashboard`, {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      setup: setup.complete ? null : setup,
      stats:
        req.store.store_type === "destination"
          ? await destinationStats(req.storeId)
          : await sourceStats(req.storeId),
      billingResult: ["success", "pending", "failed"].includes(req.query.billing)
        ? req.query.billing
        : null,
    });
  } catch (err) {
    console.error("Dashboard load failed:", err.message);
    res.status(500).send("Error loading dashboard");
  }
};
