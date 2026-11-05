require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("crypto");
const { query, pool } = require("../config/db");
const { runMigrations } = require("../config/migrate");
const stores = require("../models/storeModel");
const connections = require("../models/connectionModel");
const products = require("../models/sourceProductModel");
const mappings = require("../models/productMappingModel");
const sync = require("../services/productSync");
const shopify = require("../services/shopify");

test("first Online Store publication survives inventory/publishing failures without republishing later updates", async (t) => {
  const prefix = `publication-${Date.now().toString(36)}`;
  try {
    await runMigrations();
    const group = randomUUID();
    const source = await stores.upsertStore({ shop_domain: `${prefix}-source.myshopify.com`, access_token: "fake", store_group_id: group });
    const destination = await stores.upsertStore({ shop_domain: `${prefix}-dest.myshopify.com`, access_token: "fake", store_group_id: group });
    await stores.chooseStoreType(source.id, "source");
    await stores.chooseStoreType(destination.id, "destination");
    const link = await connections.createConnection({ sourceStoreId: source.id, destinationStoreId: destination.id });
    const connection = await connections.findById(link.id);
    const product = await products.upsert(source.id, { id: 987300, title: "Publication retry", status: "active",
      variants: [{ id: 987301, title: "Default", price: "10.00" }] });
    const mapping = await mappings.ensure({ connectionId: link.id, sourceProductId: product.id, sourceShopifyProductId: 987300 });
    await query("UPDATE product_mappings SET accepted_at = NOW() WHERE id = ?", [mapping.id]);
    t.mock.method(require("../models/syncSettingsModel"), "forConnection", async () => ({
      inventory: true, variants: false, collections: false, metafields: false,
    }));
    t.mock.method(require("../models/sourceConnectionSettingsModel"), "forConnection", async () => ({}));
    t.mock.method(require("../models/shippingPolicyModel"), "forConnection", async () => ({ mode: "disabled" }));
    t.mock.method(require("../services/inventoryLocations"), "defaultDestination", async () => "gid://shopify/Location/987302");
    t.mock.method(require("../services/shippingSync"), "assignProduct", async () => ({}));
    let inventoryFails = true;
    t.mock.method(require("../services/inventoryAllocation"), "syncDestination", async () => {
      if (inventoryFails) throw new Error("Temporary inventory failure");
      return { synced: true };
    });
    let publicationFails = true;
    let published = false;
    let creates = 0;
    let updates = 0;
    let publishes = 0;
    t.mock.method(shopify, "forShop", async (shop, request) => {
      assert.equal(shop, destination.shop_domain);
      if (request.query.includes("productSet(")) {
        if (request.variables.input.id) updates++; else creates++;
        return { productSet: { product: { id: "gid://shopify/Product/987303", variants: { nodes: [] } }, userErrors: [] } };
      }
      if (request.query.includes("publications(first")) return { publications: { nodes: [{ id: "gid://shopify/Publication/987304", name: "Online Store" }] } };
      if (request.query.includes("publishablePublish")) {
        publishes++;
        assert.equal(request.variables.id, "gid://shopify/Product/987303");
        if (publicationFails) return { publishablePublish: { userErrors: [{ message: "Temporary publishing failure" }] } };
        published = true;
        return { publishablePublish: { userErrors: [] } };
      }
      throw new Error("Unexpected Shopify request");
    });

    await assert.rejects(sync.pushOne(connection, await mappings.findById(mapping.id)), /Temporary inventory failure/);
    const retained = await mappings.findById(mapping.id);
    assert.equal(String(retained.destination_shopify_product_id), "987303");
    assert.equal(Number(retained.online_store_publish_pending), 1);
    assert.equal(publishes, 0);
    inventoryFails = false;
    await assert.rejects(sync.pushOne(connection, retained), /Online Store publication pending/);
    assert.equal(Number((await mappings.findById(mapping.id)).online_store_publish_pending), 1);
    publicationFails = false;
    assert.equal((await sync.pushOne(connection, await mappings.findById(mapping.id))).ok, true);
    assert.equal(published, true);
    assert.equal(Number((await mappings.findById(mapping.id)).online_store_publish_pending), 0);
    assert.equal(creates, 1, "a retry must update the retained product instead of creating another");
    assert.equal(updates, 2);
    assert.equal(publishes, 2);

    published = false; // The destination deliberately removes its listing later.
    assert.equal((await sync.pushOne(connection, await mappings.findById(mapping.id))).ok, true);
    assert.equal(publishes, 2);
    assert.equal(published, false, "ordinary updates must respect deliberate unpublishing");
  } finally {
    await query("DELETE FROM stores WHERE shop_domain LIKE ?", [`${prefix}-%`]);
    await pool.end();
  }
});
