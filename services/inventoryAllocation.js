// Destination selling limits never move physical source inventory.
// Source stock changes only when a destination order consumes it.
const shopify = require("./shopify");
const { randomUUID } = require("crypto");
const allocationModel = require("../models/inventoryAllocationModel");
const sourceVariantModel = require("../models/sourceVariantModel");
const inventoryLocations = require("./inventoryLocations");

const INVENTORY_LEVELS_QUERY = `
  query AllocationInventoryLevels($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        tracked
        inventoryLevels(first: 250) {
          nodes {
            # Additional location metadata needs the separate read_locations
            # scope. Allocation only needs the id from read_inventory.
            location { id }
            quantities(names: ["available"]) { name quantity }
          }
          pageInfo { hasNextPage }
        }
      }
    }
  }
`;

const ADJUST_INVENTORY_MUTATION = `
  mutation AdjustAllocatedInventory(
    $input: InventoryAdjustQuantitiesInput!
    $idempotencyKey: String!
  ) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { field message code }
    }
  }
`;

const SET_DESTINATION_INVENTORY_MUTATION = `
  mutation SetAllocatedInventory(
    $input: InventorySetQuantitiesInput!
    $idempotencyKey: String!
  ) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { field message }
    }
  }
`;

function availableAt(level) {
  const quantity = (level.quantities || []).find((item) => item.name === "available");
  return Number(quantity?.quantity || 0);
}

function planIncrease(levels, quantity) {
  let needed = Number(quantity);
  const changes = [];

  for (const level of levels || []) {
    if (needed <= 0) break;
    if (!level?.location?.id || level.location.isActive === false) continue;

    const available = Math.max(availableAt(level), 0);
    const take = Math.min(available, needed);
    if (!take) continue;

    changes.push({
      locationId: level.location.id,
      quantity: take,
      changeFromQuantity: available,
    });
    needed -= take;
  }

  if (needed > 0) {
    const error = new Error(
      `Only ${Number(quantity) - needed} unit(s) are currently available at the source.`
    );
    error.statusCode = 409;
    throw error;
  }

  return changes;
}

function planDecrease(locationAllocations, quantity) {
  let returning = Number(quantity);
  const kept = [];
  const returned = [];

  // Last reserved, first returned. This keeps older location assignments
  // stable and always restores stock to the same location it came from.
  for (const allocation of [...(locationAllocations || [])].reverse()) {
    const held = Math.max(Number(allocation.quantity || 0), 0);
    const giveBack = Math.min(held, returning);
    const stillHeld = held - giveBack;

    if (giveBack) returned.push({ locationId: allocation.locationId, quantity: giveBack });
    if (stillHeld) kept.unshift({ locationId: allocation.locationId, quantity: stillHeld });
    returning -= giveBack;
  }

  if (returning > 0) {
    const error = new Error("The saved source-location reservation is incomplete.");
    error.statusCode = 409;
    throw error;
  }

  return { kept, returned };
}

function mergeLocations(existing, additions) {
  const totals = new Map();
  [...(existing || []), ...(additions || [])].forEach((entry) => {
    if (!entry.locationId) return;
    totals.set(
      entry.locationId,
      Number(totals.get(entry.locationId) || 0) + Number(entry.quantity || 0)
    );
  });
  return [...totals].filter(([, quantity]) => quantity > 0)
    .map(([locationId, quantity]) => ({ locationId, quantity }));
}

function remaining(allocated, sold) {
  return Math.max(Number(allocated || 0) - Number(sold || 0), 0);
}

async function inventoryItems(shop, variants) {
  const ids = variants
    .filter((variant) => variant.shopify_inventory_item_id)
    .map((variant) => `gid://shopify/InventoryItem/${variant.shopify_inventory_item_id}`);

  if (!ids.length) return new Map();

  const data = await shopify.forShop(shop, {
    query: INVENTORY_LEVELS_QUERY,
    variables: { ids },
  });

  const byId = new Map();
  (data.nodes || []).filter(Boolean).forEach((item) => {
    const id = String(item.id).match(/(\d+)$/)?.[1];
    if (id) byId.set(id, item);
  });
  return byId;
}

async function adjustShopify(shop, changes, operationId = randomUUID()) {
  if (!changes.length) return;
  if (changes.length > 250) {
    const error = new Error(
      "This allocation spans too many Shopify inventory locations. Split it into smaller changes."
    );
    error.statusCode = 400;
    throw error;
  }

  const data = await shopify.forShop(shop, {
    query: ADJUST_INVENTORY_MUTATION,
    variables: {
      input: {
        reason: "correction",
        name: "available",
        referenceDocumentUri:
          `gid://product-sync/InventoryAllocation/${operationId}`,
        changes: changes.map((change) => ({
          inventoryItemId: `gid://shopify/InventoryItem/${change.inventoryItemId}`,
          locationId: change.locationId,
          delta: change.delta,
          changeFromQuantity: change.changeFromQuantity,
        })),
      },
      idempotencyKey: operationId,
    },
  });

  const result = data.inventoryAdjustQuantities;
  const errors = result?.userErrors || [];
  if (errors.length) {
    const error = new Error(errors.map((item) => item.message).join("; "));
    error.statusCode = 422;
    // An in-progress/reused-key error does not prove the first request failed.
    // Its durable key must be retained, or a retry could adjust stock twice.
    error.definitive = errors.every((item) => item.code && !String(item.code).startsWith("IDEMPOTENCY_"));
    throw error;
  }
  if (!result?.inventoryAdjustmentGroup) {
    const error = new Error("Shopify did not confirm the source inventory adjustment.");
    error.statusCode = 502;
    throw error;
  }
}

async function setForProduct({
  store,
  connection,
  product,
  targets,
  preserveResume = false,
}) {
  await require("./sourceInventory").convertLegacySource(store.id);
  const variants = await sourceVariantModel.listForProduct(product.id);
  const byId = new Map(variants.map((variant) => [Number(variant.id), variant]));
  const cleanTargets = [...new Map((targets || []).map((target) => [
    Number(target.variant_id), {
      variantId: Number(target.variant_id), quantity: Number(target.quantity),
      sourceLocationId: inventoryLocations.locationId(target.source_location_id),
    },
  ])).values()].filter((target) => byId.has(target.variantId));

  if (!cleanTargets.length || cleanTargets.some((item) =>
    !Number.isInteger(item.quantity) || item.quantity < 0)) {
    const error = new Error("Enter a whole allocation quantity of 0 or more.");
    error.statusCode = 400;
    throw error;
  }

  const db = await allocationModel.pool.getConnection();
  const lockName = `inventory-allocation:${store.id}`;

  try {
    const [lockRows] = await db.query("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
    if (!Number(lockRows[0]?.acquired)) {
      const error = new Error("Inventory is already being updated. Try again in a moment.");
      error.statusCode = 409;
      throw error;
    }

    await db.beginTransaction();
    const variantIds = cleanTargets.map((item) => item.variantId);
    const currentRows = await allocationModel.lockedForVariants(
      db,
      connection.id,
      variantIds
    );
    const current = new Map(currentRows.map((row) => [
      Number(row.source_variant_mapping_id), row,
    ]));
    const increasingIds = new Set(cleanTargets.filter((target) =>
      target.quantity > Number(current.get(target.variantId)?.allocated_quantity || 0) ||
      (target.sourceLocationId && target.sourceLocationId !== current.get(target.variantId)?.source_location_id)
    ).map((target) => target.variantId));
    const live = await inventoryItems(store.shop_domain, variants.filter((variant) =>
      increasingIds.has(Number(variant.id))
    ));
    const saved = [];
    const allPools = await allocationModel.listForProduct(product.id);

    for (const target of cleanTargets) {
      const variant = byId.get(target.variantId);
      const before = current.get(target.variantId) || {
        allocated_quantity: 0,
        sold_quantity: 0,
        location_allocations: [],
      };

      if (target.quantity < Number(before.sold_quantity || 0)) {
        const error = new Error(
          `${variant.title || variant.sku || "This variant"} has already sold ` +
          `${before.sold_quantity} reserved unit(s). Its allocation cannot be lower than that.`
        );
        error.statusCode = 409;
        throw error;
      }

      const delta = target.quantity - Number(before.allocated_quantity || 0);
      let sourceLocationId = target.sourceLocationId || before.source_location_id || null;
      const locationChanged = Boolean(target.sourceLocationId && target.sourceLocationId !== before.source_location_id);
      let locations = before.location_allocations || [];
      const item = variant.shopify_inventory_item_id
        ? live.get(String(variant.shopify_inventory_item_id))
        : null;

      if (delta > 0 || locationChanged) {
        // Shopify's live state is authoritative. This also permits an
        // immediate retry after Track quantity was enabled, without waiting
        // for the inventory webhook to refresh the local product cache.
        if (!variant.shopify_inventory_item_id || item?.tracked !== true) {
          const error = new Error(
            `${variant.title || variant.sku || "This variant"} does not track inventory ` +
            `in the source Shopify store. Enable Track quantity, set its stock, ` +
            `then try again.`
          );
          error.statusCode = 409;
          throw error;
        }
      }

      const levels = item?.inventoryLevels?.nodes || [];
      if (item) {
        await inventoryLocations.cacheItem(db, target.variantId, item);
        if (!sourceLocationId && levels.length === 1) sourceLocationId = levels[0].location.id;
        if (!sourceLocationId) throw Object.assign(new Error("Select a source inventory location for this variant."), { statusCode: 409 });
        if (!levels.some((level) => level.location.id === sourceLocationId)) {
          throw Object.assign(new Error("This variant is not stocked at the selected source location."), { statusCode: 409 });
        }
      }
      const otherRemaining = allPools.filter((row) =>
        Number(row.source_variant_mapping_id) === target.variantId &&
        Number(row.connection_id) !== Number(connection.id) && row.resume_quantity == null &&
        (!row.source_location_id || row.source_location_id === sourceLocationId)
      ).reduce((sum, row) => sum + row.remaining_quantity, 0);
      const available = Math.max(availableAt(levels.find((level) => level.location.id === sourceLocationId) || {}), 0);
      const pending = await require("./sourceInventory").pendingUnits(db, target.variantId, sourceLocationId);
      const capacity = Math.max(available - pending - otherRemaining, 0);
      if ((delta > 0 || locationChanged) && remaining(target.quantity, before.sold_quantity) > capacity) {
        const error = new Error("Only " + capacity + " unsold unit(s) can be allocated at this source location after other destinations' limits.");
        error.statusCode = 409;
        throw error;
      }

      locations = [];

      saved.push({
        sourceVariantId: target.variantId,
        quantity: target.quantity,
        sourceLocationId,
        locations,
      });

    }

    await allocationModel.upsertMany(db, connection.id, saved, { preserveResume });
    await db.query(`INSERT INTO inventory_pool_queue (source_product_id) VALUES (?)
      ON DUPLICATE KEY UPDATE revision = revision + 1`, [product.id]);

    await db.query(
      `UPDATE product_mappings SET sync_status = 'pending'
        WHERE connection_id = ? AND source_product_id = ? AND sync_status <> 'deleted'`,
      [connection.id, product.id]
    );
    await db.commit();

    return saved.map((item) => {
      const row = current.get(item.sourceVariantId);
      return {
        variant_id: item.sourceVariantId,
        allocated_quantity: item.quantity,
        source_location_id: item.sourceLocationId,
        sold_quantity: Number(row?.sold_quantity || 0),
        remaining_quantity: remaining(item.quantity, row?.sold_quantity),
      };
    });
  } catch (error) {
    try { await db.rollback(); } catch {}
    throw error;
  } finally {
    try { await db.query("SELECT RELEASE_LOCK(?)", [lockName]); } catch {}
    db.release();
  }
}

/**
 * Apply the new pool to an already-created destination product immediately.
 * The durable inventory queue retries failures independently of catalogue sync.
 */
async function syncDestination(
  connection,
  mapping,
  sourceProductId,
  { forceZero = false } = {}
) {
  if ((!mapping.accepted_at && !forceZero) || !mapping.destination_shopify_product_id) {
    return { synced: false };
  }

  const [remainingByVariant, plan] = await Promise.all([
    allocationModel.sellableMap(connection.id, sourceProductId),
    inventoryLocations.destinationPlan(connection.destination.shop_domain, mapping.id, { zeroOnly: forceZero }),
  ]);
  const quantities = [];
  for (const { link, target, locations } of plan) {
    for (const locationId of locations) quantities.push({
      inventoryItemId: 'gid://shopify/InventoryItem/' + link.destination_inventory_item_id,
      locationId,
      quantity: forceZero || locationId !== target ? 0 : (remainingByVariant.get(Number(link.source_variant_mapping_id)) || 0),
      changeFromQuantity: null,
    });
  }

  if (!quantities.length) {
    // A retained Shopify copy with no variant links cannot be zeroed safely.
    if (forceZero && remainingByVariant.size) {
      const error = new Error(
        "The destination inventory could not be identified. Its selling limit was not cleared."
      );
      error.statusCode = 409;
      throw error;
    }
    return { synced: false };
  }

  const operationId = randomUUID();
  const data = await shopify.forShop(connection.destination.shop_domain, {
    query: SET_DESTINATION_INVENTORY_MUTATION,
    variables: {
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri:
          `gid://product-sync/InventoryAllocation/${operationId}`,
        quantities,
      },
      idempotencyKey: operationId,
    },
  });
  const result = data.inventorySetQuantities;
  const errors = result?.userErrors || [];
  if (errors.length) {
    const error = new Error(errors.map((item) => item.message).join("; "));
    error.statusCode = 422;
    throw error;
  }
  if (!result?.inventoryAdjustmentGroup) {
    // Shopify can return no adjustment group when all requested values are
    // already set. Confirm every item/location by reading it back; do not
    // mistake missing payloads or a partial update for a successful no-op.
    const completePayload = result && Array.isArray(result.userErrors);
    const confirmed = completePayload && await destinationQuantitiesMatch(
      connection.destination.shop_domain, quantities
    );
    if (!confirmed) {
      const error = new Error("Shopify did not confirm the destination inventory update; the requested quantities could not be verified.");
      error.statusCode = 502;
      throw error;
    }
  }

  return { synced: true, variants: quantities.length };
}

async function destinationQuantitiesMatch(shop, quantities) {
  const ids = [...new Set(quantities.map((entry) => String(entry.inventoryItemId).split("/").pop()))];
  const items = new Map();
  for (let offset = 0; offset < ids.length; offset += 250) {
    const batch = await inventoryItems(shop, ids.slice(offset, offset + 250)
      .map((id) => ({ shopify_inventory_item_id: id })));
    for (const [id, item] of batch) items.set(id, item);
  }
  return quantities.every((entry) => {
    const item = items.get(String(entry.inventoryItemId).split("/").pop());
    const level = item?.inventoryLevels?.nodes?.find((node) => node.location?.id === entry.locationId);
    const available = level?.quantities?.find((quantity) => quantity.name === "available");
    return available != null && Number.isFinite(available.quantity) &&
      available.quantity === Number(entry.quantity);
  });
}

/**
 * Unsync keeps the destination product as a reusable Draft copy, but it must
 * hold no sellable stock before its virtual allocation is suspended.
 */
async function zeroDestinationInventory(connection, mapping, sourceProductId) {
  return syncDestination(connection, mapping, sourceProductId, { forceZero: true });
}

async function releaseRows(store, rows) {
  const byProduct = new Map();
  for (const row of rows) {
    const variant = await sourceVariantModel.findById(row.source_variant_mapping_id);
    if (!variant) continue;
    if (!byProduct.has(variant.source_product_id)) byProduct.set(variant.source_product_id, []);
    byProduct.get(variant.source_product_id).push({
      variant_id: variant.id,
      quantity: Number(row.sold_quantity || 0),
    });
  }

  for (const [productId, targets] of byProduct) {
    const product = { id: productId };
    const connection = { id: rows[0].connection_id };
    await setForProduct({
      store,
      connection,
      product,
      targets,
      preserveResume: true,
    });
  }
}

/** Restore the remembered selling limit; source stock stays unchanged. */
async function restoreConnectionProduct(store, connectionId, sourceProductId) {
  const rows = await allocationModel.listToResume(connectionId, sourceProductId);
  if (!rows.length) return { restored: false, quantity: 0 };

  const quantity = rows.reduce(
    (sum, row) => sum + Math.max(Number(row.resume_quantity || 0) - row.sold_quantity, 0),
    0
  );
  const allocations = await setForProduct({
    store,
    connection: { id: connectionId },
    product: { id: sourceProductId },
    targets: rows.map((row) => ({
      variant_id: row.source_variant_mapping_id,
      quantity: row.resume_quantity,
    })),
  });

  return { restored: true, quantity, allocations };
}

async function releaseConnection(store, connectionId) {
  const rows = await allocationModel.listForConnection(connectionId);
  if (rows.length) await releaseRows(store, rows);
  return rows.reduce((sum, row) => sum + row.remaining_quantity, 0);
}

async function releaseConnectionProduct(store, connectionId, sourceProductId) {
  const rows = await allocationModel.listForConnectionProduct(
    connectionId,
    sourceProductId
  );
  if (rows.length) await releaseRows(store, rows);
  return rows.reduce((sum, row) => sum + row.remaining_quantity, 0);
}

async function releaseProduct(store, sourceProductId) {
  const rows = await allocationModel.listForProduct(sourceProductId);
  const grouped = new Map();
  rows.forEach((row) => {
    if (!grouped.has(row.connection_id)) grouped.set(row.connection_id, []);
    grouped.get(row.connection_id).push(row);
  });
  for (const group of grouped.values()) await releaseRows(store, group);
  return rows.reduce((sum, row) => sum + row.remaining_quantity, 0);
}

module.exports = {
  inventoryItems,
  adjustShopify,
  INVENTORY_LEVELS_QUERY,
  ADJUST_INVENTORY_MUTATION,
  SET_DESTINATION_INVENTORY_MUTATION,
  availableAt,
  planIncrease,
  planDecrease,
  mergeLocations,
  remaining,
  setForProduct,
  syncDestination,
  zeroDestinationInventory,
  releaseConnection,
  releaseConnectionProduct,
  restoreConnectionProduct,
  releaseProduct,
};
