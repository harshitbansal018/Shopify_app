// controllers/dashboardController.js
//
// The landing screen. Each role gets the same useful overview shape, with the
// labels reversed to match the direction products and orders move.
const sourceProductModel = require("../models/sourceProductModel");
const connectionModel = require("../models/connectionModel");
const productMappingModel = require("../models/productMappingModel");
const orderLineItemModel = require("../models/orderLineItemModel");
const { renderStoreType } = require("./storeController");

/** Products sent out, destinations receiving them, and orders coming back. */
async function sourceStats(storeId) {
  const [products, connections, topSellers] = await Promise.all([
    // The largest seeded plan currently allows 1,000 products; keep the
    // dashboard comfortably above that so its totals do not stop at one page.
    sourceProductModel.listWithMappingStatus(storeId, { limit: 5000 }),
    connectionModel.listForSource(storeId),
    orderLineItemModel.topSellingSourceProducts(storeId, { limit: 5 }),
  ]);

  const shared = products.filter((product) => product.allowed > 0);
  const unshared = products.filter((product) => !product.allowed);

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
      staged: products.length,
      shared: shared.length,
      unshared: unshared.length,
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
  };
}

/** Everything the destination dashboard shows, from one read of the mappings. */
async function destinationStats(storeId) {
  const [offered, connections, topSellers] = await Promise.all([
    sourceProductModel.listSyncedIntoStore(storeId, { limit: 500 }),
    connectionModel.listForDestination(storeId),
    orderLineItemModel.topSellingProducts(storeId, { limit: 5 }),
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
    topSellers,
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

    // Each role has its own screen under views/<role>/.
    res.render(`${req.store.store_type}/dashboard`, {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      stats:
        req.store.store_type === "destination"
          ? await destinationStats(req.storeId)
          : await sourceStats(req.storeId),
    });
  } catch (err) {
    console.error("Dashboard load failed:", err.message);
    res.status(500).send("Error loading dashboard");
  }
};
