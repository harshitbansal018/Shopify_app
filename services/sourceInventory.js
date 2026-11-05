const { randomUUID } = require("crypto");
const { pool, query } = require("../config/db");
const { parseJson } = require("../models/helpers");
const allocation = require("./inventoryAllocation");

async function withSourceLock(sourceStoreId, fn) {
  const db = await pool.getConnection();
  const name = `inventory-allocation:${sourceStoreId}`;
  try {
    const [rows] = await db.query("SELECT GET_LOCK(?, 10) AS acquired", [name]);
    if (!Number(rows[0]?.acquired)) throw new Error("Source inventory is busy. Please retry.");
    return await fn(db);
  } finally {
    try { await db.query("SELECT RELEASE_LOCK(?)", [name]); } finally { db.release(); }
  }
}

// A persisted request is immutable across timeouts, crashes and webhook retries.
// Never replay an uncertain mutation after Shopify's deduplication window.
async function sendOperation(shop, operation) {
  if (Date.now() - operation.createdAt > 23 * 60 * 60 * 1000) {
    throw new Error("Inventory adjustment needs manual review: its confirmation window expired.");
  }
  await allocation.adjustShopify(shop, operation.changes, operation.key);
}

async function convertLocked(db, sourceStoreId, shop) {
  const [rows] = await db.query(`SELECT ia.*, svm.shopify_inventory_item_id
    FROM inventory_allocations ia
    JOIN source_variant_mappings svm ON svm.id = ia.source_variant_mapping_id
    JOIN source_products sp ON sp.id = svm.source_product_id
    WHERE sp.store_id = ? AND ia.legacy_reserved = 1 ORDER BY ia.id`, [sourceStoreId]);
  for (const row of rows) {
    let operation = parseJson(row.legacy_operation, null);
    if (!operation) {
      operation = {
        key: randomUUID(), createdAt: Date.now(),
        changes: (parseJson(row.location_allocations, []) || []).map((location) => ({
          inventoryItemId: row.shopify_inventory_item_id,
          locationId: location.locationId, delta: Number(location.quantity),
          changeFromQuantity: null,
        })),
      };
      await db.query("UPDATE inventory_allocations SET legacy_operation = ? WHERE id = ?",
        [JSON.stringify(operation), row.id]);
    }
    if (operation.changes.length) {
      try { await sendOperation(shop, operation); }
      catch (error) {
        if (error.definitive) await db.query("UPDATE inventory_allocations SET legacy_operation = NULL WHERE id = ?", [row.id]);
        throw error;
      }
    }
    await refreshCachedStock(db, shop, row.source_variant_mapping_id, row.shopify_inventory_item_id);
    await db.query(`UPDATE inventory_allocations SET legacy_reserved = 0,
      legacy_operation = NULL, location_allocations = JSON_ARRAY() WHERE id = ?`, [row.id]);
    await db.query(`INSERT INTO inventory_pool_queue (source_product_id)
      SELECT source_product_id FROM source_variant_mappings WHERE id = ?
      ON DUPLICATE KEY UPDATE revision = revision + 1`, [row.source_variant_mapping_id]);
  }
}

async function convertLegacySource(sourceStoreId) {
  const rows = await query(`SELECT s.shop_domain FROM stores s WHERE s.id = ?
    AND EXISTS (SELECT 1 FROM inventory_allocations ia
      JOIN source_variant_mappings svm ON svm.id = ia.source_variant_mapping_id
      JOIN source_products sp ON sp.id = svm.source_product_id
      WHERE sp.store_id = s.id AND ia.legacy_reserved = 1)`, [sourceStoreId]);
  if (!rows.length) return;
  await withSourceLock(sourceStoreId, (db) => convertLocked(db, sourceStoreId, rows[0].shop_domain));
}

async function refreshCachedStock(db, shop, variantId, inventoryItemId) {
  const items = await allocation.inventoryItems(shop, [{ shopify_inventory_item_id: inventoryItemId }]);
  const item = items.get(String(inventoryItemId));
  await require("./inventoryLocations").cacheItem(db, variantId, item);
}

// Existing ledger rows are retained when order lines disappear or product
// mappings are removed. Their recorded location split is still needed to undo
// a sale without touching any other source's stock.
async function desiredRows(db, sourceStoreId) {
  const [rows] = await db.query(`SELECT l.*,
    CASE WHEN o.cancelled_at IS NOT NULL THEN IF(o.inventory_restock = 1, 0,
        COALESCE(JSON_EXTRACT(l.pending_operation, '$.quantity'), l.applied_quantity))
      WHEN l.destination_variants IS NULL THEN l.applied_quantity
      ELSE GREATEST(COALESCE(SUM(li.quantity), 0) - l.baseline_quantity, 0) END AS desired_quantity
    FROM source_inventory_ledger l JOIN orders o ON o.id = l.order_id
    LEFT JOIN order_line_items li ON li.order_id = l.order_id AND
      JSON_CONTAINS(l.destination_variants, JSON_QUOTE(JSON_UNQUOTE(JSON_EXTRACT(li.line_data, '$.variant_id'))))
    WHERE l.source_store_id = ? GROUP BY l.id, o.cancelled_at, o.inventory_restock
    ORDER BY l.id`, [sourceStoreId]);
  return rows;
}

async function pendingUnits(db, variantId, locationId = null) {
  const [rows] = await db.query(`SELECT COALESCE(SUM(GREATEST(w.desired_quantity - w.applied_quantity, 0)), 0) AS units
    FROM (
      SELECT l.id, l.applied_quantity,
        CASE WHEN o.cancelled_at IS NOT NULL THEN IF(o.inventory_restock = 1, 0,
            COALESCE(JSON_EXTRACT(l.pending_operation, '$.quantity'), l.applied_quantity))
          WHEN l.destination_variants IS NULL THEN l.applied_quantity
          ELSE GREATEST(COALESCE(SUM(li.quantity), 0) - l.baseline_quantity, 0) END AS desired_quantity
      FROM source_inventory_ledger l JOIN orders o ON o.id = l.order_id
      LEFT JOIN order_line_items li ON li.order_id = l.order_id AND
        JSON_CONTAINS(l.destination_variants, JSON_QUOTE(JSON_UNQUOTE(JSON_EXTRACT(li.line_data, '$.variant_id'))))
      WHERE l.source_variant_id = ? ${locationId ? "AND (l.source_location_id = ? OR l.source_location_id IS NULL)" : ""}
      GROUP BY l.id, o.cancelled_at, o.inventory_restock
    ) w`, locationId ? [variantId, locationId] : [variantId]);
  return Number(rows[0]?.units || 0);
}

function planOrderChange(row, item) {
  const delta = Number(row.desired_quantity) - Number(row.applied_quantity);
  const locations = parseJson(row.locations, []) || [];
  const allLevels = item?.inventoryLevels?.nodes || [];
  const levels = row.source_location_id
    ? allLevels.filter((level) => level.location.id === row.source_location_id)
    : allLevels;
  if (delta > 0) {
    if (!item?.tracked) throw new Error("Enable Track quantity at the source before processing this order.");
    if (!row.source_location_id && levels.length !== 1) {
      throw new Error("Select a source inventory location for this variant before processing the order.");
    }
    const additions = allocation.planIncrease(levels, delta);
    return {
      locations: allocation.mergeLocations(locations, additions),
      changes: additions.map((location) => ({
        inventoryItemId: row.inventory_item_id, locationId: location.locationId,
        delta: -location.quantity, changeFromQuantity: location.changeFromQuantity,
      })),
    };
  }
  const release = allocation.planDecrease(locations, -delta);
  return {
    locations: release.kept,
    changes: release.returned.map((location) => ({
      inventoryItemId: row.inventory_item_id, locationId: location.locationId,
      delta: location.quantity, changeFromQuantity: null,
    })),
  };
}

async function reconcileSource(sourceStoreId) {
  return withSourceLock(sourceStoreId, async (db) => {
    const [stores] = await db.query("SELECT shop_domain FROM stores WHERE id = ? AND is_active = 1", [sourceStoreId]);
    if (!stores.length) return;
    const shop = stores[0].shop_domain;
    await convertLocked(db, sourceStoreId, shop);
    const [uncached] = await db.query(`SELECT DISTINCT svm.* FROM source_variant_mappings svm
      JOIN source_products sp ON sp.id = svm.source_product_id
      JOIN inventory_allocations ia ON ia.source_variant_mapping_id = svm.id
      WHERE sp.store_id = ? AND NOT EXISTS
        (SELECT 1 FROM source_inventory_levels sl WHERE sl.source_variant_id = svm.id)`, [sourceStoreId]);
    if (uncached.length) await require("./inventoryLocations").refreshSource(shop, uncached);
    await db.query(`INSERT IGNORE INTO source_inventory_ledger
      (order_id, source_variant_id, source_store_id, inventory_item_id, locations, destination_variants, source_location_id)
      SELECT DISTINCT o.id, svm.id, c.source_store_id, svm.shopify_inventory_item_id, JSON_ARRAY(), JSON_ARRAY(CAST(mvp.destination_variant_id AS CHAR)), ia.source_location_id
      FROM order_line_items li JOIN orders o ON o.id = li.order_id
      JOIN stores dst ON dst.id = o.store_id AND dst.store_type = 'destination'
      JOIN mapping_variant_products mvp ON mvp.id = li.mapped_variant_id
      JOIN product_mappings pm ON pm.id = mvp.product_mapping_id
      JOIN store_connections c ON c.id = pm.connection_id AND c.destination_store_id = o.store_id
      JOIN source_variant_mappings svm ON svm.id = mvp.source_variant_mapping_id
      LEFT JOIN inventory_allocations ia ON ia.connection_id = c.id AND ia.source_variant_mapping_id = svm.id
      WHERE c.source_store_id = ? AND svm.shopify_inventory_item_id IS NOT NULL`, [sourceStoreId]);
    const affected = new Set();
    for (const row of await desiredRows(db, sourceStoreId)) {
      if (!row.pending_operation && Number(row.desired_quantity) === Number(row.applied_quantity)) continue;
      try {
        // First resolve an uncertain old request, then apply the latest target
        // in this same round (for example a cancellation arriving after timeout).
        for (let pass = 0; pass < 2; pass++) {
          let operation = parseJson(row.pending_operation, null);
          if (!operation) {
            const live = await allocation.inventoryItems(shop, [{ shopify_inventory_item_id: row.inventory_item_id }]);
            const item = live.get(String(row.inventory_item_id));
            if (Number(row.desired_quantity) > Number(row.applied_quantity) && !row.source_location_id) {
              const [configured] = await db.query(`SELECT ia.source_location_id FROM inventory_allocations ia
                JOIN store_connections c ON c.id = ia.connection_id JOIN orders o ON o.store_id = c.destination_store_id
                WHERE o.id = ? AND ia.source_variant_mapping_id = ?`, [row.order_id, row.source_variant_id]);
              const levels = item?.inventoryLevels?.nodes || [];
              const original = [...new Set((parseJson(row.locations, []) || []).map((entry) => entry.locationId))];
              if (original.length > 1) throw new Error("This historical order used multiple source locations. Review its stock before increasing the quantity.");
              const selected = original[0] || configured[0]?.source_location_id || (levels.length === 1 ? levels[0].location.id : null);
              if (!selected) throw new Error("Select a source inventory location for this variant before processing the order.");
              await db.query("UPDATE source_inventory_ledger SET source_location_id = ? WHERE id = ?", [selected, row.id]);
              row.source_location_id = selected;
            }
            operation = {
              ...planOrderChange(row, item),
              quantity: Number(row.desired_quantity), key: randomUUID(), createdAt: Date.now(),
            };
            await db.query("UPDATE source_inventory_ledger SET pending_operation = ?, error = NULL WHERE id = ?",
              [JSON.stringify(operation), row.id]);
          }
          try {
            await sendOperation(shop, operation);
          } catch (error) {
            // Only a confirmed rejection may be replanned with a new key.
            if (error.definitive) await db.query("UPDATE source_inventory_ledger SET pending_operation = NULL WHERE id = ?", [row.id]);
            throw error;
          }
          await refreshCachedStock(db, shop, row.source_variant_id, row.inventory_item_id);
          await db.query(`UPDATE source_inventory_ledger SET applied_quantity = ?, locations = ?,
            pending_operation = NULL, error = NULL WHERE id = ?`,
          [operation.quantity, JSON.stringify(operation.locations), row.id]);
          affected.add(Number(row.source_variant_id));
          row.applied_quantity = operation.quantity;
          row.locations = operation.locations;
          row.pending_operation = null;
          if (Number(row.desired_quantity) === operation.quantity) break;
        }
      } catch (error) {
        await db.query("UPDATE source_inventory_ledger SET error = ? WHERE id = ?", [error.message.slice(0, 512), row.id]);
        console.warn(`Source inventory order ${row.order_id}: ${error.message}`);
        affected.add(Number(row.source_variant_id));
      }
    }
    if (affected.size) {
      await db.query(`INSERT INTO inventory_pool_queue (source_product_id)
        SELECT DISTINCT source_product_id FROM source_variant_mappings WHERE id IN (?)
        ON DUPLICATE KEY UPDATE revision = revision + 1`, [[...affected]]);
      await db.query(`UPDATE product_mappings pm JOIN source_variant_mappings svm ON svm.source_product_id = pm.source_product_id
        SET pm.sync_status = 'pending' WHERE svm.id IN (?) AND pm.sync_status <> 'deleted'`, [[...affected]]);
      require("./productSync").scheduleAutoSync();
    }
  });
}

async function reconcileOrder(orderId) {
  const rows = await query(`SELECT DISTINCT c.source_store_id FROM order_line_items li
    JOIN mapping_variant_products mvp ON mvp.id = li.mapped_variant_id
    JOIN product_mappings pm ON pm.id = mvp.product_mapping_id
    JOIN store_connections c ON c.id = pm.connection_id WHERE li.order_id = ?
    UNION SELECT source_store_id FROM source_inventory_ledger WHERE order_id = ?`, [orderId, orderId]);
  for (const row of rows) {
    await reconcileSource(row.source_store_id);
    await flushPools(row.source_store_id);
  }
}

async function queueProduct(sourceProductId) {
  await query(`INSERT INTO inventory_pool_queue (source_product_id) VALUES (?)
    ON DUPLICATE KEY UPDATE revision = revision + 1`, [sourceProductId]);
}

async function flushPools(sourceStoreId) {
  return withSourceLock(sourceStoreId, () => flushPoolsLocked(sourceStoreId));
}

async function flushPoolsLocked(sourceStoreId) {
  const products = await query(`SELECT q.source_product_id, q.revision FROM inventory_pool_queue q
    JOIN source_products sp ON sp.id = q.source_product_id WHERE sp.store_id = ?`, [sourceStoreId]);
  const connections = require("../models/connectionModel");
  const mappings = require("../models/productMappingModel");
  for (const product of products) {
    try {
      for (const mapping of await mappings.listForSourceProduct(product.source_product_id, { includeRevoked: false })) {
        if (!mapping.accepted_at || !mapping.destination_shopify_product_id) continue;
        const connection = await connections.findById(mapping.connection_id);
        if (!connection || connection.status !== "active" || !connection.destination.is_active) continue;
        // Inventory is operational even for connections using manual catalogue sync.
        await allocation.syncDestination(connection, mapping, product.source_product_id);
      }
      await query("DELETE FROM inventory_pool_queue WHERE source_product_id = ? AND revision = ?",
        [product.source_product_id, product.revision]);
    } catch (error) {
      await query("UPDATE inventory_pool_queue SET error = ? WHERE source_product_id = ?",
        [error.message.slice(0, 512), product.source_product_id]);
      console.warn(`Destination inventory ${product.source_product_id}: ${error.message}`);
    }
  }
}

async function run() {
  const rows = await query(`SELECT DISTINCT s.id FROM stores s WHERE s.store_type = 'source' AND s.is_active = 1
    AND (EXISTS (SELECT 1 FROM store_connections c WHERE c.source_store_id = s.id)
      OR EXISTS (SELECT 1 FROM source_inventory_ledger l WHERE l.source_store_id = s.id))`);
  for (const row of rows) {
    try { await reconcileSource(row.id); await flushPools(row.id); }
    catch (error) { console.warn(`Source inventory ${row.id}: ${error.message}`); }
  }
}

module.exports = { run, reconcileOrder, reconcileSource, convertLegacySource, pendingUnits, planOrderChange, queueProduct, flushPools };
