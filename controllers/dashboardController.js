// controllers/dashboardController.js
//
// The landing screen. A DESTINATION gets the numbers that matter to it -- what
// has arrived, what is still waiting, and who it is receiving from. A SOURCE
// keeps the plain store summary, because its own work is on Products.
const sourceProductModel = require("../models/sourceProductModel");
const connectionModel = require("../models/connectionModel");
const { renderStoreType } = require("./storeController");

/**
 * Placeholder rows for the top-sellers table.
 *
 * Sales are not synced yet -- the orders tables exist but nothing fills them.
 * The table ships with obviously-fake numbers rather than an empty box so the
 * shape is agreed now, and swapping in orderLineItemModel.unitsSoldByVariant()
 * later is a one-line change in this file.
 */
const SAMPLE_TOP_SELLERS = [
  { title: "Sample product A", source: "—", units: 128, revenue: 4480 },
  { title: "Sample product B", source: "—", units: 96, revenue: 3264 },
  { title: "Sample product C", source: "—", units: 74, revenue: 2146 },
  { title: "Sample product D", source: "—", units: 41, revenue: 1189 },
  { title: "Sample product E", source: "—", units: 17, revenue: 493 },
];

/** Everything the destination dashboard shows, from one read of the mappings. */
async function destinationStats(storeId) {
  const [offered, connections] = await Promise.all([
    sourceProductModel.listSyncedIntoStore(storeId, { limit: 500 }),
    connectionModel.listForDestination(storeId),
  ]);

  const synced = offered.filter((product) => !product.awaiting);
  const unsynced = offered.filter((product) => product.awaiting);

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

  offered.forEach((product) => {
    const domain = product.source_shop_domain;

    // A product can outlive its connection; keep it counted rather than
    // silently dropping it off the chart.
    if (!bySource.has(domain)) {
      bySource.set(domain, {
        domain,
        name: product.source_store_name || domain,
        status: "disconnected",
        active: false,
        synced: 0,
        unsynced: 0,
      });
    }

    bySource.get(domain)[product.awaiting ? "unsynced" : "synced"] += 1;
  });

  return {
    cards: {
      synced: synced.length,
      unsynced: unsynced.length,
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
    topSellers: SAMPLE_TOP_SELLERS,
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

    const isDestination = req.store.store_type === "destination";

    // Each role has its own screen under views/<role>/.
    res.render(`${req.store.store_type}/dashboard`, {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      stats: isDestination ? await destinationStats(req.storeId) : null,
    });
  } catch (err) {
    console.error("Dashboard load failed:", err.message);
    res.status(500).send("Error loading dashboard");
  }
};

exports.SAMPLE_TOP_SELLERS = SAMPLE_TOP_SELLERS;
