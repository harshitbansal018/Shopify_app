// controllers/webhookController.js
//
// Every handler here runs behind middleware/verifyWebhook, so the request is
// proven to come from Shopify before any of this executes. Handlers reply 200
// first and do their bookkeeping afterwards -- Shopify retries on anything
// that is slow or non-200.
const storeModel = require("../models/storeModel");
const orderModel = require("../models/orderModel");
const customerModel = require("../models/customerModel");
const connectionModel = require("../models/connectionModel");
const productMappingModel = require("../models/productMappingModel");
const productSync = require("../services/productSync");
const inventoryAllocation = require("../services/inventoryAllocation");
const planLimits = require("../services/planLimits");
const orderSync = require("../services/orderSync");
const { normalizeShopDomain } = require("../utils/shop");

/**
 * Safely undo a manual activation that could not be completed.
 *
 * Draft first, then zero the destination, then release the source reservation.
 * If any remote write fails the mapping remains accepted/failed, which is
 * deliberately safer than making the same units available in both stores.
 */
async function rollbackManualActivations(store, mappings, connectionById) {
  let rolledBack = 0;
  let failed = 0;

  for (const mapping of mappings) {
    const connection = connectionById.get(Number(mapping.connection_id));
    if (!connection) continue;

    try {
      if (mapping.destination_shopify_product_id) {
        await productSync.setDestinationProductStatus(
          connection.destination.shop_domain,
          mapping.destination_shopify_product_id,
          "DRAFT",
          { mappingId: mapping.id }
        );
        await inventoryAllocation.zeroDestinationInventory(
          connection,
          mapping,
          mapping.source_product_id
        );
      }
      await inventoryAllocation.releaseConnectionProduct(
        connection.source,
        connection.id,
        mapping.source_product_id
      );
      await productMappingModel.declineForDestination(store.id, [mapping.id]);
      rolledBack += 1;
    } catch (error) {
      failed += 1;
      await productMappingModel.markFailed(mapping.id, error.message);
    }
  }

  return { rolledBack, failed };
}

/** A genuine destination-admin Draft runs the same safe inventory return. */
async function applyManualDestinationDraft(store, mappingIds) {
  const connections = await connectionModel.listForDestination(store.id);
  const connectionById = new Map(
    connections.map((connection) => [Number(connection.id), connection])
  );
  const mappings = await productMappingModel.listForDestinationByIds(
    store.id,
    mappingIds
  );
  let returned = 0;
  let declined = 0;
  let failed = 0;

  for (const mapping of mappings) {
    if (mapping.accepted_at === null) continue;
    const connection = connectionById.get(Number(mapping.connection_id));
    if (!connection) continue;

    try {
      if (mapping.destination_shopify_product_id) {
        await inventoryAllocation.zeroDestinationInventory(
          connection,
          mapping,
          mapping.source_product_id
        );
      }
      returned += await inventoryAllocation.releaseConnectionProduct(
        connection.source,
        connection.id,
        mapping.source_product_id
      );
      declined += await productMappingModel.declineForDestination(
        store.id,
        [mapping.id]
      );
    } catch (error) {
      failed += 1;
      await productMappingModel.markFailed(mapping.id, error.message);
    }
  }

  return { declined, returned, failed };
}

/** A genuine destination-admin Active restores stock, checks plan, then syncs. */
async function applyManualDestinationActive(store, mappingIds) {
  const connections = await connectionModel.listForDestination(store.id);
  const connectionById = new Map(
    connections.map((connection) => [Number(connection.id), connection])
  );
  const mappings = await productMappingModel.listForDestinationByIds(
    store.id,
    mappingIds
  );
  try {
    for (const mapping of mappings) {
      if (mapping.accepted_at !== null) continue;
      const connection = connectionById.get(Number(mapping.connection_id));
      if (!connection) continue;
      await inventoryAllocation.restoreConnectionProduct(
        connection.source,
        connection.id,
        mapping.source_product_id
      );
    }

    const accepted = await planLimits.acceptProducts(
      store,
      mappings.map((mapping) => mapping.id)
    );
    if (accepted.refused || !accepted.accepted) {
      await rollbackManualActivations(
        store,
        mappings,
        connectionById
      );
      return {
        synced: 0,
        failed: mappings.length,
        error: accepted.message || "This product could not be accepted.",
      };
    }

    let synced = 0;
    require("../models/dashboardModel").recordProductActivities(mappings, "synced");
    let failed = 0;
    for (const connection of connections.filter((item) => item.status === "active")) {
      const result = await productSync.pushPending(connection.id, {
        forceActiveMappingIds: mappings.map((mapping) => mapping.id),
      });
      synced += result.synced;
      failed += result.failed;
    }

    // pushPending isolates failures per product. Re-read only this webhook's
    // mappings so successful products stay active while failed ones are safely
    // returned to Draft/Unsynced.
    const refreshed = await productMappingModel.listForDestinationByIds(
      store.id,
      mappings.map((mapping) => mapping.id)
    );
    const incomplete = refreshed.filter(
      (mapping) => mapping.sync_status !== "synced"
    );
    if (incomplete.length) {
      await rollbackManualActivations(
        store,
        incomplete,
        connectionById
      );
      failed = incomplete.length;
      synced = Math.max(0, mappings.length - incomplete.length);
    }

    return { synced, failed };
  } catch (error) {
    await rollbackManualActivations(
      store,
      mappings,
      connectionById
    );
    return {
      synced: 0,
      failed: mappings.length,
      error: error.message,
    };
  }
}

/* ===================== app/uninstalled ===================== */

exports.appUninstalled = async (req, res) => {
  const shop = normalizeShopDomain(req.webhookShop);

  // Acknowledge first; Shopify does not care about our bookkeeping.
  res.status(200).send("OK");

  if (!shop) {
    console.warn("Uninstall webhook had no usable shop domain");
    return;
  }

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) {
      console.log("Uninstall webhook for unknown shop:", shop);
      return;
    }

    // Deactivates, stamps uninstalled_at and drops the revoked tokens.
    // Connections and mappings are deliberately kept so a reinstall resumes.
    await storeModel.markUninstalled(shop);

    // If source uninstalls: move destination products to Unsynced, draft copies & release reservations.
    // If destination uninstalls: move source products to Unshared & release reservations.
    if (store.store_type === "source") {
      const connections = await connectionModel.listForSource(store.id);
      for (const connection of connections) {
        try {
          const mappings = await productMappingModel.listForConnection(connection.id, {
            limit: 10000,
            acceptedOnly: true,
          });
          for (const mapping of mappings) {
            try {
              if (mapping.destination_shopify_product_id && connection.destination.is_active) {
                await productSync.setDestinationProductStatus(
                  connection.destination.shop_domain,
                  mapping.destination_shopify_product_id,
                  "DRAFT",
                  { mappingId: mapping.id }
                );
                await inventoryAllocation.zeroDestinationInventory(
                  connection,
                  mapping,
                  mapping.source_product_id
                );
              }
              await inventoryAllocation.releaseConnectionProduct(
                store,
                connection.id,
                mapping.source_product_id
              );
            } catch (pErr) {
              console.warn("Uninstall product draft/release failed:", pErr.message);
            }
          }
          if (mappings.length) {
            await productMappingModel.declineForDestination(
              connection.destination_store_id,
              mappings.map((m) => m.id)
            );
            require("../models/dashboardModel").recordProductActivities(mappings, "unsynced");
          }
        } catch (cErr) {
          console.warn("Processing uninstalled source connection failed:", cErr.message);
        }
      }
    } else if (store.store_type === "destination") {
      const connections = await connectionModel.listForDestination(store.id);
      for (const connection of connections) {
        try {
          const mappings = await productMappingModel.listForConnection(connection.id, {
            limit: 10000,
          });
          for (const mapping of mappings) {
            try {
              await inventoryAllocation.releaseConnectionProduct(
                connection.source,
                connection.id,
                mapping.source_product_id
              );
              await productMappingModel.markSourceRevoked(mapping.id);
            } catch (pErr) {
              console.warn("Uninstall unshare/release failed:", pErr.message);
            }
          }
          if (mappings.length) {
            require("../models/dashboardModel").recordProductActivities(mappings, "unsynced");
          }
        } catch (cErr) {
          console.warn("Processing uninstalled destination connection failed:", cErr.message);
        }
      }
    }

    console.log("App uninstalled for", shop);
  } catch (err) {
    console.error("Uninstall webhook processing failed:", err.message);
  }
};

/* ===================== products/update ===================== */

/**
 * A product changed at a source store.
 *
 * The response is sent before the canonical Shopify read begins. The webhook
 * payload can omit metafields, category, inventory-item details, and variants,
 * so using it as the source of truth would silently retain stale data.
 */
exports.productsUpdate = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};

  if (!shop || !payload.id) return;

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) return;

    // A DESTINATION firing this is usually our own push echoing back, but it
    // is also how a merchant deleting a variant in their own admin reaches us.
    // Reconciling is safe: it queues no push, so it cannot loop.
    if (store.store_type === "destination") {
      const echo = await productSync.applyDestinationUpdate(store.id, payload);

      if (echo && echo.dropped) {
        console.log(
          `products/update ${shop} #${payload.id}: ` +
            `${echo.dropped} variant(s) no longer in the destination store`
        );
      }
      if (echo?.manualDraftIds?.length) {
        const result = await applyManualDestinationDraft(
          store,
          echo.manualDraftIds
        );
        console.log(
          `Manual destination Draft ${shop} #${payload.id}: ` +
            `${result.declined} unsynced, ${result.returned} unit(s) returned, ` +
            `${result.failed} failed`
        );
      }
      if (echo?.manualActiveIds?.length) {
        const result = await applyManualDestinationActive(
          store,
          echo.manualActiveIds
        );
        console.log(
          `Manual destination Active ${shop} #${payload.id}: ` +
            `${result.synced} synced, ${result.failed} failed` +
            (result.error ? ` (${result.error})` : "")
        );
      }
      return;
    }

    if (store.store_type !== "source") return;

    const result = await productSync.applySourceUpdate(store.id, payload, { shop });

    if (!result) return; // not a product this app stages

    console.log(
      `products/update ${shop} #${payload.id}: ` +
        `${result.requeued} mapping(s) queued`
    );
    if (result.requeued) productSync.scheduleAutoSync();
  } catch (err) {
    console.error("products/update processing failed:", err.message);
  }
};

/* ===================== products/delete ===================== */

exports.productsDelete = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};

  if (!shop || !payload.id) return;

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) return;

    // The destination's own merchant deleted a product we created there. The
    // offer goes back to "waiting for you" rather than being pushed again --
    // re-creating it would be the app overruling a deliberate deletion.
    if (store.store_type === "destination") {
      const gone = await productSync.applyDestinationDelete(store.id, payload.id);

      if (gone) {
        console.log(
          `products/delete ${shop} #${payload.id}: ` +
            `${gone.mappings} offer(s) returned to waiting`
        );
      }
      return;
    }

    if (store.store_type !== "source") return;

    // The mapping rows are marked, never deleted: they record what this
    // product became on each destination, which a hard delete would lose.
    const result = await productSync.applySourceDelete(store.id, payload.id);

    if (!result) return;

    console.log(
      `products/delete ${shop} #${payload.id}: ` +
        `${result.marked} mapping(s) marked deleted`
    );
  } catch (err) {
    console.error("products/delete processing failed:", err.message);
  }
};

/* ===================== inventory updates ===================== */

/**
 * Inventory-item and inventory-level changes are not reliably represented by
 * products/update. Refresh the owning staged product so quantity, tracking,
 * cost, weight and shipping requirements move together as one snapshot.
 */
async function refreshInventoryProduct(req, res, kind) {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};
  const inventoryItemId = payload.inventory_item_id || payload.id;

  if (!shop || !inventoryItemId) return;

  try {
    const store = await storeModel.findByDomain(shop);

    // Destination events are normally echoes of our own push. Ignoring them
    // prevents a source <-> destination inventory loop.
    if (!store || store.store_type !== "source") return;

    const result = await productSync.refreshForInventoryItem(
      store,
      inventoryItemId
    );

    if (!result) return; // inventory item is not from a staged product

    console.log(
      `${kind} ${shop} #${inventoryItemId}: ` +
        `${result.requeued} mapping(s) queued`
    );
    if (result.requeued) productSync.scheduleAutoSync();
  } catch (err) {
    console.error(`${kind} processing failed:`, err.message);
  }
}

exports.inventoryItemUpdate = (req, res) =>
  refreshInventoryProduct(req, res, "inventory_items/update");

exports.inventoryLevelUpdate = (req, res) =>
  refreshInventoryProduct(req, res, "inventory_levels/update");

exports.inventoryLevelConnect = (req, res) =>
  refreshInventoryProduct(req, res, "inventory_levels/connect");

exports.inventoryLevelDisconnect = (req, res) =>
  refreshInventoryProduct(req, res, "inventory_levels/disconnect");

/* ===================== collections/update ===================== */

exports.collectionsUpdate = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const collectionId = req.webhookPayload?.id;

  if (!shop || !collectionId) return;

  try {
    const store = await storeModel.findByDomain(shop);
    if (!store || store.store_type !== "source") return;

    const result = await productSync.refreshAllStagedProducts(store);

    console.log(
      `collections/update ${shop} #${collectionId}: ` +
        `${result.imported} product(s) refreshed, ` +
        `${result.requeued} mapping(s) queued`
    );
    if (result.requeued) productSync.scheduleAutoSync();
  } catch (err) {
    console.error("collections/update processing failed:", err.message);
  }
};

/* ===================== Shopify Product Events ===================== */

exports.productEvent = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};
  const productId =
    payload.query_variables?.productId || payload.data?.product?.id;

  if (!shop || !productId) return;

  try {
    const store = await storeModel.findByDomain(shop);
    if (!store || store.store_type !== "source") return;

    const result = await productSync.refreshSourceProduct(store, productId);
    if (!result) return;

    console.log(
      `Product Event ${shop} #${productId}: ` +
        `${result.requeued} mapping(s) queued`
    );
    if (result.requeued) productSync.scheduleAutoSync();
  } catch (err) {
    console.error("Product Event processing failed:", err.message);
  }
};

/* ===================== orders/create ===================== */

/**
 * A sale happened.
 *
 * In a DESTINATION store this is the whole point of the app's order side: the
 * shopper bought a product that belongs to a source store, so that source has
 * a job to do -- and is owed its own price for it, not the marked-up one.
 *
 * The job is recorded in order_mappings and worked from the source's Orders
 * screen here. Nothing is written to the source's Shopify admin.
 *
 * A SOURCE store firing this is its own unrelated trade. The order is cached
 * and nothing else happens.
 */
exports.ordersCreate = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};

  if (!shop || !payload.id) return;

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) return;

    const order = await orderSync.cacheOrder(store.id, payload);

    if (!order) return;

    if (store.store_type !== "destination") {
      console.log(`orders/create ${shop} ${order.name || `#${order.id}`}: cached`);
      return;
    }

    const queued = await orderSync.queueForSources(store.id, order);

    console.log(
      `orders/create ${shop} ${order.name || `#${order.id}`}: ` +
        `${queued.lines} synced line(s) for ${queued.connections} source store(s)`
    );
  } catch (err) {
    console.error("orders/create processing failed:", err.message);
  }
};

/* ===================== orders/updated ===================== */

/**
 * The order changed: paid, fulfilled, cancelled, edited.
 *
 * The cache is refreshed and the sale re-recorded, which is how an order
 * EDITED to add a synced product still reaches its source. claim() is keyed on
 * (connection, destination order), so this updates the row that exists rather
 * than making a second one -- and it never touches the fulfilment state, so a
 * sale the source has already shipped does not go back to looking outstanding.
 *
 * A destination cancelling its own sale is deliberately not passed on. The
 * source has no order to cancel, and telling it to stop is a decision for that
 * merchant rather than something to smuggle in here.
 */
exports.ordersUpdated = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};

  if (!shop || !payload.id) return;

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) return;

    const order = await orderSync.cacheOrder(store.id, payload);

    if (!order) return;

    if (store.store_type !== "destination") return;

    // An order edited to ADD a synced product still needs recording, and this
    // is the only webhook that says so. A sale already recorded keeps whatever
    // the source has since done with it -- claim() refreshes the totals but
    // never the fulfilment state.
    await orderSync.queueForSources(store.id, order);
  } catch (err) {
    console.error("orders/updated processing failed:", err.message);
  }
};

/* ===================== mandatory privacy webhooks ===================== */
/*
 * Shopify requires all three endpoints to exist and to return 200, and checks
 * them during app review.
 *
 * The orders and customers tables hold personal data -- name, email, phone and
 * addresses -- so the two customer topics are real obligations here, not stubs.
 */

/**
 * A customer has asked what this app holds about them.
 *
 * Shopify gives 30 days to supply it, and expects the APP to hand it to the
 * merchant, who passes it on. This assembles the record; delivering it is a
 * channel decision (email, download) that is not built yet -- until it is, the
 * data is written to the log so a request can still be answered by hand.
 */
exports.customersDataRequest = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};
  const customerId = payload.customer && payload.customer.id;

  if (!shop || !customerId) return;

  try {
    const store = await storeModel.findByDomain(shop);
    if (!store) return;

    const email = payload.customer.email || null;

    const [profile, orders] = await Promise.all([
      customerModel.dataForCustomer(store.id, customerId, email),
      orderModel.dataForCustomer(store.id, customerId),
    ]);

    console.log(
      `customers/data_request for ${shop}: customer ${customerId} has ` +
        `${orders.length} order(s) on record`,
      JSON.stringify({
        customer_id: customerId,
        profile,
        orders: orders.map((o) => ({
          order: o.name,
          placed_at: o.shopify_created_at,
          total: o.total_price,
          currency: o.currency,
          billing_address: o.billing_address,
          shipping_address: o.shipping_address,
          line_items: o.line_items.map((l) => ({
            title: l.title,
            quantity: l.quantity,
            price: l.price,
          })),
        })),
      })
    );
  } catch (err) {
    console.error("customers/data_request failed:", err.message);
  }
};

/**
 * A customer has asked to be erased.
 *
 * Handled differently in the two tables, on purpose:
 *   orders     anonymised in place -- a merchant must retain sales records, so
 *              the money, dates and line items stay and the person goes
 *   customers  deleted outright -- strip the personal fields and nothing of
 *              value is left behind
 */
exports.customersRedact = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};
  const customerId = payload.customer && payload.customer.id;

  if (!shop || !customerId) return;

  try {
    const store = await storeModel.findByDomain(shop);
    if (!store) return;

    const email = payload.customer.email || null;

    // Orders are anonymised in place -- the sale must survive the person.
    // The customer row itself is deleted; nothing in it is worth keeping.
    const [redactedOrders, deletedCustomers] = await Promise.all([
      orderModel.redactCustomer(store.id, customerId),
      customerModel.redactCustomer(store.id, customerId, email),
    ]);

    console.log(
      `customers/redact for ${shop}: customer ${customerId} -- ` +
        `${redactedOrders} order(s) anonymised, ${deletedCustomers} customer row(s) deleted`
    );
  } catch (err) {
    console.error("customers/redact failed:", err.message);
  }
};

exports.shopRedact = async (req, res) => {
  const shop = normalizeShopDomain(req.webhookShop);

  res.status(200).send("OK");

  if (!shop) return;

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) return;

    // Every dependent table is ON DELETE CASCADE, so this also clears the
    // connections, cached products and variants, mappings, orders and customers.
    await storeModel.deleteStore(shop);

    console.log("shop/redact completed for", shop);
  } catch (err) {
    console.error("shop/redact processing failed:", err.message);
  }
};
