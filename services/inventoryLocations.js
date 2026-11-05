const { randomUUID } = require("crypto");
const { pool, query } = require("../config/db");
const shopify = require("./shopify");
const { parseJson } = require("../models/helpers");

function locationId(value) {
  if (value == null || value === "") return null;
  const match = String(value).match(/^(?:gid:\/\/shopify\/Location\/)?(\d+)$/);
  if (!match) throw Object.assign(new Error("Select a valid source inventory location."), { statusCode: 400 });
  return `gid://shopify/Location/${match[1]}`;
}

async function sourceLocations(shop) {
  const locations = [];
  let after = null;
  do {
    const data = await shopify.forShop(shop, {
      query: `query SourceInventoryLocations($after: String) {
        locations(first: 100, after: $after) {
          nodes { id name isActive } pageInfo { hasNextPage endCursor }
        }
      }`, variables: { after },
    });
    locations.push(...(data.locations?.nodes || []));
    after = data.locations?.pageInfo?.hasNextPage ? data.locations.pageInfo.endCursor : null;
  } while (after);
  return locations;
}

async function cacheItem(db, variantId, item) {
  if (!item) throw new Error("Source inventory item could not be read.");
  if (item.inventoryLevels?.pageInfo?.hasNextPage) throw new Error("Source inventory has too many locations to read safely.");
  const levels = item.inventoryLevels?.nodes || [];
  if (levels.length) {
    const availableAt = require("./inventoryAllocation").availableAt;
    await db.query(`INSERT INTO source_inventory_levels (source_variant_id, location_id, available)
      VALUES ? ON DUPLICATE KEY UPDATE available = VALUES(available), updated_at = CURRENT_TIMESTAMP`,
    [levels.map((level) => [variantId, level.location.id, availableAt(level)])]);
    await db.query("DELETE FROM source_inventory_levels WHERE source_variant_id = ? AND location_id NOT IN (?)",
      [variantId, levels.map((level) => level.location.id)]);
    await db.query("UPDATE source_variant_mappings SET inventory_quantity = ? WHERE id = ?",
      [levels.reduce((sum, level) => sum + availableAt(level), 0), variantId]);
  } else {
    await db.query("DELETE FROM source_inventory_levels WHERE source_variant_id = ?", [variantId]);
    await db.query("UPDATE source_variant_mappings SET inventory_quantity = 0 WHERE id = ?", [variantId]);
  }
}

async function refreshSource(shop, variants) {
  const items = await require("./inventoryAllocation").inventoryItems(shop, variants);
  for (const variant of variants) {
    if (variant.shopify_inventory_item_id) await cacheItem(pool, variant.id, items.get(String(variant.shopify_inventory_item_id)));
  }
  return items;
}

async function defaultDestination(shop, mappingId = null) {
  const saved = mappingId ? await query("SELECT destination_inventory_location_id FROM product_mappings WHERE id = ?", [mappingId]) : [];
  if (saved[0]?.destination_inventory_location_id) return saved[0].destination_inventory_location_id;
  // Omitting the id asks Shopify for its primary location, not the first list entry.
  let data;
  try {
    data = await shopify.forShop(shop, { query: "query DefaultInventoryLocation { location { id isActive fulfillsOnlineOrders } }" });
  } catch (error) {
    if (/read_locations|access denied/i.test(error.message)) {
      throw new Error("Reconnect the destination store to grant location access, then sync again.");
    }
    throw error;
  }
  const id = data.location?.id;
  if (!id) throw new Error("The destination's default inventory location could not be found.");
  if (data.location.isActive === false || data.location.fulfillsOnlineOrders === false) {
    throw new Error("The destination default location must be active and enabled to fulfill online orders.");
  }
  if (mappingId) {
    await query(`UPDATE product_mappings SET destination_inventory_location_id = COALESCE(destination_inventory_location_id, ?) WHERE id = ?`, [id, mappingId]);
    return (await query("SELECT destination_inventory_location_id FROM product_mappings WHERE id = ?", [mappingId]))[0].destination_inventory_location_id;
  }
  return id;
}

async function destinationPlan(shop, mappingId, { zeroOnly = false } = {}) {
  const links = await require("../models/mappingVariantProductModel").listForMapping(mappingId);
  const target = await defaultDestination(shop, mappingId);
  const data = links.length ? await shopify.forShop(shop, {
    query: `query ManagedDestinationInventory($ids: [ID!]!) {
      nodes(ids: $ids) { ... on InventoryItem { id inventoryLevels(first: 250) {
        nodes { location { id } } pageInfo { hasNextPage }
      } } }
    }`,
    variables: { ids: links.filter((link) => link.destination_inventory_item_id)
      .map((link) => `gid://shopify/InventoryItem/${link.destination_inventory_item_id}`) },
  }) : { nodes: [] };
  const items = new Map((data.nodes || []).filter(Boolean).map((item) => [String(item.id).split("/").pop(), item]));
  const result = [];
  for (const link of links) {
    const item = items.get(String(link.destination_inventory_item_id));
    if (!item) throw new Error("The destination inventory item could not be identified.");
    if (item.inventoryLevels?.pageInfo?.hasNextPage) throw new Error("The destination has too many inventory locations to reconcile safely.");
    const existing = (item.inventoryLevels?.nodes || []).map((level) => level.location.id);
    const recorded = parseJson(link.managed_inventory_locations, null);
    // Before location tracking, this app always wrote the first inventory level.
    // Adopt only that legacy level; do not erase other manually managed stock.
    const managed = [...new Set([...(recorded || existing.slice(0, 1)), target])];
    await query("UPDATE mapping_variant_products SET managed_inventory_locations = ? WHERE id = ?",
      [JSON.stringify(managed), link.id]);
    if (!zeroOnly && !existing.includes(target)) {
      const activated = await shopify.forShop(shop, {
        query: `mutation ActivateManagedInventory($item: ID!, $location: ID!, $key: String!) {
          inventoryActivate(inventoryItemId: $item, locationId: $location) @idempotent(key: $key) {
            inventoryLevel { id } userErrors { field message }
          }
        }`, variables: { item: item.id, location: target, key: randomUUID() },
      });
      const errors = activated.inventoryActivate?.userErrors || [];
      if (errors.length || !activated.inventoryActivate?.inventoryLevel) {
        throw new Error(errors.map((error) => error.message).join("; ") || "The destination default location could not be activated.");
      }
      existing.push(target);
    }
    result.push({ link, target, locations: managed.filter((id) => existing.includes(id)) });
  }
  return result;
}

module.exports = { locationId, sourceLocations, cacheItem, refreshSource, defaultDestination, destinationPlan };
