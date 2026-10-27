// Move a source store's sellable inventory into destination-specific pools.
// Shopify owns the physical source quantity; this service owns only how much
// of that quantity has been reserved for each destination.
const shopify = require("./shopify");
const { randomUUID } = require("crypto");
const allocationModel = require("../models/inventoryAllocationModel");
const sourceVariantModel = require("../models/sourceVariantModel");
const mappingVariantProductModel = require("../models/mappingVariantProductModel");

const INVENTORY_LEVELS_QUERY = `
  query AllocationInventoryLevels($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        tracked
        inventoryLevels(first: 250) {
          nodes {
            location { id name isActive }
            quantities(names: ["available"]) { name quantity }
          }
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
      userErrors { field message }
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

async function adjustShopify(shop, changes) {
  if (!changes.length) return;
  if (changes.length > 250) {
    const error = new Error(
      "This allocation spans too many Shopify inventory locations. Split it into smaller changes."
    );
    error.statusCode = 400;
    throw error;
  }

  const operationId = randomUUID();

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
    throw error;
  }
  if (!result?.inventoryAdjustmentGroup) {
    const error = new Error("Shopify did not confirm the source inventory adjustment.");
    error.statusCode = 502;
    throw error;
  }
}

async function setForProduct({ store, connection, product, targets }) {
  const variants = await sourceVariantModel.listForProduct(product.id);
  const byId = new Map(variants.map((variant) => [Number(variant.id), variant]));
  const cleanTargets = [...new Map((targets || []).map((target) => [
    Number(target.variant_id),
    Number(target.quantity),
  ])).entries()]
    .filter(([variantId]) => byId.has(variantId))
    .map(([variantId, quantity]) => ({ variantId, quantity }));

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
    const live = await inventoryItems(store.shop_domain, variants.filter((variant) =>
      variantIds.includes(Number(variant.id))
    ));
    const shopifyChanges = [];
    const saved = [];

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
      let locations = before.location_allocations || [];

      if (delta > 0) {
        if (!variant.shopify_inventory_item_id || variant.inventory_tracked === 0) {
          const error = new Error(
            `${variant.title || variant.sku || "This variant"} does not have tracked Shopify inventory.`
          );
          error.statusCode = 409;
          throw error;
        }
        const item = live.get(String(variant.shopify_inventory_item_id));
        const additions = planIncrease(item?.inventoryLevels?.nodes || [], delta);
        locations = mergeLocations(locations, additions);
        additions.forEach((entry) => shopifyChanges.push({
          inventoryItemId: variant.shopify_inventory_item_id,
          locationId: entry.locationId,
          delta: -entry.quantity,
          changeFromQuantity: entry.changeFromQuantity,
        }));
      } else if (delta < 0) {
        const release = planDecrease(locations, -delta);
        locations = release.kept;
        release.returned.forEach((entry) => shopifyChanges.push({
          inventoryItemId: variant.shopify_inventory_item_id,
          locationId: entry.locationId,
          delta: entry.quantity,
          changeFromQuantity: availableAt(
            (live.get(String(variant.shopify_inventory_item_id))
              ?.inventoryLevels?.nodes || [])
              .find((level) => level?.location?.id === entry.locationId) || {}
          ),
        }));
      }

      saved.push({
        sourceVariantId: target.variantId,
        quantity: target.quantity,
        locations,
      });
    }

    // The remote adjustment happens while the source-wide lock is held. A
    // Shopify error rolls the local transaction back, so no reservation is
    // advertised unless the physical source stock actually moved.
    await adjustShopify(store.shop_domain, shopifyChanges);
    await allocationModel.upsertMany(db, connection.id, saved);

    for (const item of saved) {
      const variant = byId.get(item.sourceVariantId);
      const stock = (live.get(String(variant.shopify_inventory_item_id))
        ?.inventoryLevels?.nodes || []).reduce((sum, level) => sum + availableAt(level), 0);
      const prior = current.get(item.sourceVariantId)?.allocated_quantity || 0;
      const nextStock = stock - (item.quantity - Number(prior));
      await db.query(
        "UPDATE source_variant_mappings SET inventory_quantity = ? WHERE id = ?",
        [nextStock, item.sourceVariantId]
      );
    }

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
 * A decrease must reach the destination before its units become sellable at
 * the source again; waiting for a manual sync would create an oversell window.
 */
async function syncDestination(connection, mapping, sourceProductId) {
  if (!mapping.accepted_at || !mapping.destination_shopify_product_id) {
    return { synced: false };
  }

  // Required lazily to keep the normal product-sync import graph one-way.
  const productSync = require("./productSync");
  const [remainingByVariant, links, locations] = await Promise.all([
    allocationModel.remainingMap(connection.id, sourceProductId),
    mappingVariantProductModel.listForMapping(mapping.id),
    productSync.destinationInventoryLocations(
      connection.destination.shop_domain,
      mapping.id
    ),
  ]);
  const quantities = [];

  for (const link of links) {
    const sourceVariantId = Number(link.source_variant_mapping_id);
    if (!remainingByVariant.has(sourceVariantId)) continue;

    const locationId = locations.get(String(link.source_shopify_variant_id));
    if (!link.destination_inventory_item_id || !locationId) {
      const error = new Error(
        "The destination variant has no active inventory location. " +
        "Stock was not returned to the source."
      );
      error.statusCode = 409;
      throw error;
    }

    quantities.push({
      inventoryItemId:
        `gid://shopify/InventoryItem/${link.destination_inventory_item_id}`,
      locationId,
      quantity: remainingByVariant.get(sourceVariantId),
      // Allocation is this app's source of truth at the destination. Explicit
      // null is the forward-compatible way to opt out of Shopify's CAS check.
      changeFromQuantity: null,
    });
  }

  if (!quantities.length) return { synced: false };

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
    const error = new Error("Shopify did not confirm the destination inventory update.");
    error.statusCode = 502;
    throw error;
  }

  return { synced: true, variants: quantities.length };
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
    await setForProduct({ store, connection, product, targets });
  }
}

async function releaseConnection(store, connectionId) {
  const rows = await allocationModel.listForConnection(connectionId);
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
  releaseConnection,
  releaseProduct,
};
