require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("crypto");
const { pool, query } = require("../config/db");
const { runMigrations } = require("../config/migrate");
const stores = require("../models/storeModel");
const connections = require("../models/connectionModel");
const products = require("../models/sourceProductModel");
const variants = require("../models/sourceVariantModel");
const mappings = require("../models/productMappingModel");
const links = require("../models/mappingVariantProductModel");
const pools = require("../models/inventoryAllocationModel");
const allocation = require("../services/inventoryAllocation");
const inventory = require("../services/sourceInventory");
const orders = require("../services/orderSync");
const shopify = require("../services/shopify");

test("virtual allocation, sales, retries, cancellation, unsync and legacy conversion", async (t) => {
  const prefix = `inventory-${Date.now().toString(36)}`;
  const group = randomUUID();
  const realRequest = shopify.forShop;
  const productSync = require("../services/productSync");
  const realSchedule = productSync.scheduleAutoSync;
  let physical = 100;
  let movements = 0;
  let loseResponse = false;
  let concurrentResponse = false;
  let secondWarehouse = false;
  let warehouseB = 30;
  let legacyDestination = false;
  let defaultConnected = true;
  let customStock = 5;
  let unrelatedStock = 7;
  let noDestinationGroup = false;
  let mismatchedReadback = false;
  let missingReadbackLevel = false;
  let missingDestinationPayload = false;
  let destinationRejected = false;
  const executed = new Map();
  try {
    await runMigrations();
    const source = await stores.upsertStore({ shop_domain: `${prefix}-source.myshopify.com`, access_token: "fake", store_group_id: group });
    const destination = await stores.upsertStore({ shop_domain: `${prefix}-dest.myshopify.com`, access_token: "fake", store_group_id: group });
    await stores.chooseStoreType(source.id, "source");
    await stores.chooseStoreType(destination.id, "destination");
    const connection = await connections.createConnection({ sourceStoreId: source.id, destinationStoreId: destination.id });
    const product = await products.upsert(source.id, { id: 978100, title: "Inventory test", variants: [
      { id: 978101, title: "Default", inventory_item_id: 978102, inventory_quantity: 100, inventory_tracked: true },
    ] });
    const variant = (await variants.listForProduct(product.id))[0];
    const mapping = await mappings.ensure({ connectionId: connection.id, sourceProductId: product.id, sourceShopifyProductId: 978100 });
    await links.upsertMany(mapping.id, [{ sourceVariantMappingId: variant.id, sourceShopifyVariantId: 978101, destinationVariantId: 978103, destinationInventoryItemId: 978105 }]);
    let destinationStock = 0;
    let cancellationConfirmed = false;
    productSync.scheduleAutoSync = () => {};
    shopify.forShop = async (shop, request) => {
      if (shop === destination.shop_domain) {
        if (request.query.includes("AllocationInventoryLevels")) return { nodes: [{
          id: "gid://shopify/InventoryItem/978105", tracked: true,
          inventoryLevels: { nodes: [
            ...(missingReadbackLevel ? [] : [{ location: { id: "gid://shopify/Location/978106" },
              quantities: [{ name: "available", quantity: destinationStock + (mismatchedReadback ? 1 : 0) }] }]),
            ...(legacyDestination ? [
              { location: { id: "gid://shopify/Location/978206" }, quantities: [{ name: "available", quantity: customStock }] },
              { location: { id: "gid://shopify/Location/978207" }, quantities: [{ name: "available", quantity: unrelatedStock }] },
            ] : []),
          ] },
        }] };
        if (request.query.includes("DefaultInventoryLocation")) return { location: { id: "gid://shopify/Location/978106" } };
        if (request.query.includes("ManagedDestinationInventory")) return { nodes: [{
          id: "gid://shopify/InventoryItem/978105",
          inventoryLevels: { nodes: [
            ...(legacyDestination ? [{ location: { id: "gid://shopify/Location/978206" } }] : []),
            ...(defaultConnected ? [{ location: { id: "gid://shopify/Location/978106" } }] : []),
            ...(legacyDestination ? [{ location: { id: "gid://shopify/Location/978207" } }] : []),
          ] },
        }] };
        if (request.query.includes("ActivateManagedInventory")) {
          assert.equal(request.variables.location, "gid://shopify/Location/978106");
          defaultConnected = true;
          return { inventoryActivate: { inventoryLevel: { id: "new-level" }, userErrors: [] } };
        }
        if (request.query.includes("SetAllocatedInventory")) {
          if (missingDestinationPayload) return { inventorySetQuantities: null };
          if (destinationRejected) return { inventorySetQuantities: {
            inventoryAdjustmentGroup: null, userErrors: [{ field: ["quantities"], message: "Inventory location is not active" }],
          } };
          for (const quantity of request.variables.input.quantities) {
            if (quantity.locationId === "gid://shopify/Location/978106") destinationStock = quantity.quantity;
            else if (quantity.locationId === "gid://shopify/Location/978206") customStock = quantity.quantity;
            else if (quantity.locationId === "gid://shopify/Location/978207") unrelatedStock = quantity.quantity;
          }
          return { inventorySetQuantities: { inventoryAdjustmentGroup: noDestinationGroup ? null : { createdAt: new Date().toISOString() }, userErrors: [] } };
        }
        if (request.query.includes("CancellationOrder")) return { order: {
          cancelledAt: cancellationConfirmed ? "2026-11-05T10:00:00Z" : null,
        } };
        throw new Error("Unexpected destination request");
      }
      assert.equal(shop, source.shop_domain, "only the fixture source is contacted");
      if (request.query.includes("AllocationInventoryLevels")) return { nodes: [{
        id: "gid://shopify/InventoryItem/978102", tracked: true,
        inventoryLevels: { nodes: [
          { location: { id: "gid://shopify/Location/978104" }, quantities: [{ name: "available", quantity: physical }] },
          ...(secondWarehouse ? [{ location: { id: "gid://shopify/Location/978204" }, quantities: [{ name: "available", quantity: warehouseB }] }] : []),
        ] },
      }] };
      if (request.query.includes("AdjustAllocatedInventory")) {
        const key = request.variables.idempotencyKey;
        if (executed.has(key) && concurrentResponse) {
          concurrentResponse = false;
          return { inventoryAdjustQuantities: { userErrors: [
            { code: "IDEMPOTENCY_CONCURRENT_REQUEST", message: "Original request is still in progress" },
          ] } };
        }
        if (!executed.has(key)) {
          for (const change of request.variables.input.changes) {
            const atB = change.locationId === "gid://shopify/Location/978204";
            if (change.changeFromQuantity != null) assert.equal(change.changeFromQuantity, atB ? warehouseB : physical);
            if (atB) warehouseB += change.delta;
            else physical += change.delta;
            movements++;
          }
          executed.set(key, true);
          if (loseResponse) { loseResponse = false; throw new Error("Simulated lost Shopify response"); }
        }
        return { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { createdAt: new Date().toISOString() }, userErrors: [] } };
      }
      throw new Error("Unexpected Shopify request");
    };
    const set = (quantity) => allocation.setForProduct({ store: source, connection, product, targets: [{ variant_id: variant.id, quantity }] });
    const payload = { id: 978110, currency: "USD", line_items: [{ id: 978111, variant_id: 978103, quantity: 5, price: "10.00" }] };

    await t.test("allocate 30 leaves source at 100", async () => {
      await set(30);
      assert.equal(physical, 100);
      assert.equal(movements, 0);
      assert.equal((await pools.sellableMap(connection.id, product.id)).get(variant.id), 30);
      await assert.rejects(set(101), /Only 100/);
    });
    await t.test("test and real orders share allocation, pending deductions, and confirmed cancellation restocking", async () => {
      const testBody = { ...payload, id: 978170, test: true,
        line_items: [{ ...payload.line_items[0], id: 978171, quantity: 2 }] };
      const realBody = { ...payload, id: 978180, test: false,
        line_items: [{ ...payload.line_items[0], id: 978181, quantity: 1 }] };
      const testOrder = await orders.cacheOrder(destination.id, testBody);
      await orders.cacheOrder(destination.id, realBody);
      loseResponse = true;
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 97);
      assert.equal(await inventory.pendingUnits(pool, variant.id), 2);
      // A duplicate webhook and retry may not take the test units twice.
      await orders.cacheOrder(destination.id, testBody);
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 97);
      assert.equal(await inventory.pendingUnits(pool, variant.id), 0);
      assert.equal((await pools.remainingMap(connection.id, product.id)).get(variant.id), 27);
      assert.equal((await pools.sellableMap(connection.id, product.id)).get(variant.id), 27);
      assert.equal((await pools.mapForMappings([mapping.id])).get(mapping.id)[0].sold_quantity, 3);
      assert.equal((await pools.lockedForVariants(pool, connection.id, [variant.id]))[0].sold_quantity, 3);

      const orderMappings = require("../models/orderMappingModel");
      await orderMappings.claim(connection.id, testOrder.id, { lineCount: 1 });
      const sale = await orderMappings.findByPair(connection.id, testOrder.id);
      await orders.cancelOne({ ...sale, cancel_status: "processing" });
      assert.equal(physical, 97, "unconfirmed test cancellation cannot restore stock");
      cancellationConfirmed = true;
      assert.equal((await orders.cancelOne(sale)).ok, true);
      assert.equal(physical, 99);
      assert.equal((await pools.remainingMap(connection.id, product.id)).get(variant.id), 29);
      await orders.cancelOne(sale);
      assert.equal(physical, 99);
      cancellationConfirmed = false;
      await orders.cacheOrder(destination.id, { ...realBody, cancelled_at: "2026-11-05T12:00:00Z", restock: true });
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 100);
      assert.equal((await pools.remainingMap(connection.id, product.id)).get(variant.id), 30);
      movements = 0;
    });
    let order;
    await t.test("a sale deducts both pools once even after a lost response", async () => {
      order = await orders.cacheOrder(destination.id, payload);
      loseResponse = true;
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 95);
      assert.equal((await pools.remainingMap(connection.id, product.id)).get(variant.id), 25);
      assert.match((await query("SELECT error FROM source_inventory_ledger WHERE order_id = ?", [order.id]))[0].error, /lost/);
      concurrentResponse = true;
      await inventory.reconcileSource(source.id);
      assert.ok((await query("SELECT pending_operation FROM source_inventory_ledger WHERE order_id = ?", [order.id]))[0].pending_operation);
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 95);
      assert.equal(movements, 1);
    });
    await t.test("order edits deduct only the additional units", async () => {
      await orders.cacheOrder(destination.id, { ...payload, line_items: [{ ...payload.line_items[0], quantity: 7 }] });
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 93);
      await orders.cacheOrder(destination.id, { ...payload, line_items: [{ ...payload.line_items[0], quantity: 5 }] });
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 95);
    });
    await t.test("unsync never adds stock and cancellation cannot reactivate it", async () => {
      await allocation.releaseConnectionProduct(source, connection.id, product.id);
      assert.equal(physical, 95);
      assert.equal((await pools.sellableMap(connection.id, product.id)).get(variant.id), 0);
      await orders.cacheOrder(destination.id, { ...payload, cancelled_at: "2026-11-05T10:00:00Z", restock: true });
      await inventory.reconcileSource(source.id);
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 100);
      assert.equal((await pools.sellableMap(connection.id, product.id)).get(variant.id), 0);
      // An old webhook cannot resurrect a cancelled order.
      await orders.cacheOrder(destination.id, payload);
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 100);
      await allocation.restoreConnectionProduct(source, connection.id, product.id);
      assert.equal(physical, 100);
      assert.equal((await pools.sellableMap(connection.id, product.id)).get(variant.id), 30);
    });
    await t.test("source depletion caps availability without losing the saved allocation", async () => {
      await query("UPDATE source_variant_mappings SET inventory_quantity = 4 WHERE id = ?", [variant.id]);
      await query("UPDATE source_inventory_levels SET available = 4 WHERE source_variant_id = ?", [variant.id]);
      assert.equal((await pools.sellableMap(connection.id, product.id)).get(variant.id), 4);
      await query("UPDATE source_variant_mappings SET inventory_quantity = 100 WHERE id = ?", [variant.id]);
      await query("UPDATE source_inventory_levels SET available = 100 WHERE source_variant_id = ?", [variant.id]);
    });
    await t.test("multiple destination limits share one physical capacity", async () => {
      const other = await stores.upsertStore({ shop_domain: `${prefix}-other.myshopify.com`, access_token: "fake", store_group_id: group });
      await stores.chooseStoreType(other.id, "destination");
      const otherConnection = await connections.createConnection({ sourceStoreId: source.id, destinationStoreId: other.id });
      await mappings.ensure({ connectionId: otherConnection.id, sourceProductId: product.id, sourceShopifyProductId: 978100 });
      await allocation.setForProduct({ store: source, connection: otherConnection, product, targets: [{ variant_id: variant.id, quantity: 20 }] });
      assert.equal(physical, 100);
      await assert.rejects(allocation.setForProduct({ store: source, connection: otherConnection, product,
        targets: [{ variant_id: variant.id, quantity: 71 }] }), /Only 70/);
      await query("UPDATE source_variant_mappings SET inventory_quantity = 40 WHERE id = ?", [variant.id]);
      await query("UPDATE source_inventory_levels SET available = 40 WHERE source_variant_id = ?", [variant.id]);
      const first = (await pools.sellableMap(connection.id, product.id)).get(variant.id);
      const second = (await pools.sellableMap(otherConnection.id, product.id)).get(variant.id);
      assert.equal(first + second, 40);
      assert.equal(first, 30);
      assert.equal(second, 10);
      await query("UPDATE source_variant_mappings SET inventory_quantity = 100 WHERE id = ?", [variant.id]);
      await query("UPDATE source_inventory_levels SET available = 100 WHERE source_variant_id = ?", [variant.id]);
      await allocation.releaseConnectionProduct(source, otherConnection.id, product.id);
    });
    await t.test("selected source warehouse alone funds orders; cancellation returns to its original warehouse after selection changes", async () => {
      secondWarehouse = true;
      const selected = (quantity, location) => allocation.setForProduct({ store: source, connection, product,
        targets: [{ variant_id: variant.id, quantity, source_location_id: location }] });
      await assert.rejects(selected(5, "gid://shopify/Location/999999"), /not stocked/);
      await assert.rejects(selected(31, "gid://shopify/Location/978204"), /Only 30/);
      await selected(5, "gid://shopify/Location/978204");
      assert.equal(physical, 100);
      assert.equal(warehouseB, 30);
      assert.equal((await pools.sellableMap(connection.id, product.id)).get(variant.id), 5);
      const body = { ...payload, id: 978190, test: true,
        line_items: [{ ...payload.line_items[0], id: 978191, quantity: 2 }] };
      const order = await orders.cacheOrder(destination.id, body);
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 100);
      assert.equal(warehouseB, 28);
      assert.equal((await pools.remainingMap(connection.id, product.id)).get(variant.id), 3);
      const [snapshot] = await query("SELECT source_location_id FROM source_inventory_ledger WHERE order_id = ?", [order.id]);
      assert.equal(snapshot.source_location_id, "gid://shopify/Location/978204");
      await selected(30, "gid://shopify/Location/978104");
      // Orders migrated from the old schema can lack the location column,
      // but their physical adjustment trace must still win over a new selection.
      await query("UPDATE source_inventory_ledger SET source_location_id = NULL WHERE order_id = ?", [order.id]);
      await orders.cacheOrder(destination.id, { ...body, line_items: [{ ...body.line_items[0], quantity: 3 }] });
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 100);
      assert.equal(warehouseB, 27);
      await orders.cacheOrder(destination.id, { ...body, cancelled_at: "2026-11-05T12:00:00Z", restock: true });
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 100);
      assert.equal(warehouseB, 30);
      // A shortage at B must never consume A's stock.
      const plan = { inventory_item_id: 978102, applied_quantity: 0, desired_quantity: 2,
        locations: [], source_location_id: "gid://shopify/Location/978204" };
      assert.throws(() => inventory.planOrderChange(plan, { tracked: true, inventoryLevels: { nodes: [
        { location: { id: "gid://shopify/Location/978104" }, quantities: [{ name: "available", quantity: 100 }] },
        { location: { id: "gid://shopify/Location/978204" }, quantities: [{ name: "available", quantity: 1 }] },
      ] } }), /Only 1/);
      secondWarehouse = false;
      await require("../services/inventoryLocations").refreshSource(source.shop_domain, [variant]);
    });
    await t.test("destination default is used instead of the first location and only app-managed duplicates are zeroed", async () => {
      legacyDestination = true;
      defaultConnected = false;
      await query("UPDATE mapping_variant_products SET managed_inventory_locations = NULL WHERE product_mapping_id = ?", [mapping.id]);
      await query("UPDATE product_mappings SET destination_inventory_location_id = NULL WHERE id = ?", [mapping.id]);
      const accepted = { ...mapping, accepted_at: new Date(), destination_shopify_product_id: 978107 };
      const fullConnection = await connections.findById(connection.id);
      await allocation.syncDestination(fullConnection, accepted, product.id);
      assert.equal(defaultConnected, true);
      assert.equal(destinationStock, 30);
      assert.equal(customStock, 0);
      assert.equal(unrelatedStock, 7);
      await allocation.zeroDestinationInventory(fullConnection, accepted, product.id);
      assert.equal(destinationStock, 0);
      assert.equal(customStock, 0);
      assert.equal(unrelatedStock, 7);
      assert.equal(physical, 100);
      legacyDestination = false;
    });
    await t.test("a null destination adjustment group succeeds only when every requested location quantity is verified", async () => {
      const accepted = { ...mapping, accepted_at: new Date(), destination_shopify_product_id: 978107 };
      const fullConnection = await connections.findById(connection.id);
      legacyDestination = true;
      noDestinationGroup = true;
      try {
        assert.equal((await allocation.syncDestination(fullConnection, accepted, product.id)).synced, true);
        assert.equal(destinationStock, 30);
        assert.equal(customStock, 0);
        mismatchedReadback = true;
        await assert.rejects(allocation.syncDestination(fullConnection, accepted, product.id), /could not be verified/);
        mismatchedReadback = false;
        missingReadbackLevel = true;
        await assert.rejects(allocation.syncDestination(fullConnection, accepted, product.id), /could not be verified/);
        missingReadbackLevel = false;
        missingDestinationPayload = true;
        await assert.rejects(allocation.syncDestination(fullConnection, accepted, product.id), /could not be verified/);
        missingDestinationPayload = false;
        destinationRejected = true;
        await assert.rejects(allocation.syncDestination(fullConnection, accepted, product.id), /location is not active/);
        destinationRejected = false;
        assert.equal((await allocation.zeroDestinationInventory(fullConnection, accepted, product.id)).synced, true);
        assert.equal(destinationStock, 0);
        assert.equal(customStock, 0);
        assert.equal(unrelatedStock, 7);
        assert.equal(physical, 100);
      } finally {
        legacyDestination = false;
        noDestinationGroup = false;
        mismatchedReadback = false;
        missingReadbackLevel = false;
        missingDestinationPayload = false;
        destinationRejected = false;
      }
    });
    await t.test("manual catalogue mode still updates destination inventory; confirmed cancellation restocks both stores", async () => {
      await query("UPDATE product_mappings SET accepted_at = NOW(), destination_shopify_product_id = ? WHERE id = ?", [978107, mapping.id]);
      await query("UPDATE store_connections SET sync_mode = 'manual' WHERE id = ?", [connection.id]);
      const order = await orders.cacheOrder(destination.id, { ...payload, id: 978120, line_items: [{ ...payload.line_items[0], id: 978121 }] });
      destinationStock = 25; // Shopify's checkout already took five.
      await inventory.reconcileOrder(order.id);
      assert.equal(physical, 95);
      assert.equal(destinationStock, 25);
      const orderMappings = require("../models/orderMappingModel");
      await orderMappings.claim(connection.id, order.id, { lineCount: 1 });
      const sale = await orderMappings.findByPair(connection.id, order.id);
      // A pending Shopify cancellation must not restock the source yet.
      await orders.cancelOne({ ...sale, cancel_status: "processing" });
      assert.equal(physical, 95);
      cancellationConfirmed = true;
      assert.equal((await orders.cancelOne(sale)).ok, true);
      assert.equal(physical, 100);
      assert.equal(destinationStock, 30);
      await orders.cancelOne(sale);
      assert.equal(physical, 100);
      await allocation.zeroDestinationInventory(await connections.findById(connection.id), await mappings.findBySourceProductId(connection.id, 978100), product.id);
      await allocation.releaseConnectionProduct(source, connection.id, product.id);
      assert.equal(destinationStock, 0);
      assert.equal(physical, 100);
      await query("UPDATE product_mappings SET accepted_at = NULL WHERE id = ?", [mapping.id]);
    });
    await t.test("stale webhooks and non-restocking cancellations cannot add physical stock", async () => {
      await allocation.restoreConnectionProduct(source, connection.id, product.id);
      const body = { ...payload, id: 978130, updated_at: "2026-11-05T11:00:00Z",
        line_items: [{ ...payload.line_items[0], id: 978131 }] };
      const order = await orders.cacheOrder(destination.id, body);
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 95);
      await orders.cacheOrder(destination.id, { ...body, updated_at: "2026-11-05T10:00:00Z",
        line_items: [{ ...body.line_items[0], quantity: 9 }] });
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 95);
      await orders.cacheOrder(destination.id, { ...body, updated_at: "2026-11-05T12:00:00Z",
        cancelled_at: "2026-11-05T12:00:00Z" });
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 95, "a cancellation without restocking cannot add physical stock");
      await orders.cacheOrder(destination.id, { ...body, updated_at: "2026-11-05T13:00:00Z",
        cancelled_at: "2026-11-05T12:00:00Z", restock: true });
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 100);
      await allocation.releaseConnectionProduct(source, connection.id, product.id);
    });
    await t.test("insufficient source stock stays nonnegative and retries after replenishment", async () => {
      physical = 2;
      await query("UPDATE source_variant_mappings SET inventory_quantity = 2 WHERE id = ?", [variant.id]);
      await query("UPDATE source_inventory_levels SET available = 2 WHERE source_variant_id = ?", [variant.id]);
      const body = { ...payload, id: 978140, line_items: [{ ...payload.line_items[0], id: 978141 }] };
      const order = await orders.cacheOrder(destination.id, body);
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 2);
      const [ledger] = await query("SELECT * FROM source_inventory_ledger WHERE order_id = ?", [order.id]);
      assert.equal(ledger.applied_quantity, 0);
      assert.match(ledger.error, /Only 2/);
      assert.equal((await pools.sellableMap(connection.id, product.id)).get(variant.id), 0);
      physical = 100;
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 95);
      await orders.cacheOrder(destination.id, { ...body, cancelled_at: "2026-11-05T12:00:00Z", restock: true });
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 100);
    });
    await t.test("cancellation resolves an uncertain deduction and restocks in the same round", async () => {
      const body = { ...payload, id: 978160, line_items: [{ ...payload.line_items[0], id: 978161 }] };
      const order = await orders.cacheOrder(destination.id, body);
      loseResponse = true;
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 95);
      await orders.cacheOrder(destination.id, { ...body, cancelled_at: "2026-11-05T12:00:00Z", restock: true });
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 100);
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 100);
    });
    await t.test("deleting mapping metadata does not restock an active sale", async () => {
      const body = { ...payload, id: 978150, line_items: [{ ...payload.line_items[0], id: 978151 }] };
      const order = await orders.cacheOrder(destination.id, body);
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 95);
      await query("DELETE FROM mapping_variant_products WHERE product_mapping_id = ?", [mapping.id]);
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 95);
      await orders.cacheOrder(destination.id, { ...body, cancelled_at: "2026-11-05T12:00:00Z", restock: true });
      await inventory.reconcileSource(source.id);
      assert.equal(physical, 100);
    });
    await t.test("legacy reservations are restored exactly once, including retries", async () => {
      physical = 70;
      await query(`UPDATE inventory_allocations SET legacy_reserved = 1,
        location_allocations = ? WHERE connection_id = ? AND source_variant_mapping_id = ?`,
      [JSON.stringify([{ locationId: "gid://shopify/Location/978104", quantity: 30 }]), connection.id, variant.id]);
      loseResponse = true;
      await assert.rejects(inventory.convertLegacySource(source.id), /lost/);
      assert.equal(physical, 100);
      await inventory.convertLegacySource(source.id);
      await inventory.convertLegacySource(source.id);
      assert.equal(physical, 100);
      await allocation.releaseConnectionProduct(source, connection.id, product.id);
      assert.equal(physical, 100, "unsync after legacy conversion cannot turn 100 into 130");
    });
  } finally {
    shopify.forShop = realRequest;
    productSync.scheduleAutoSync = realSchedule;
    await query("DELETE FROM stores WHERE shop_domain LIKE ?", [`${prefix}-%`]);
    await pool.end();
  }
});
