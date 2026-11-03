require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { query, pool } = require("../config/db");
const { runMigrations } = require("../config/migrate");
const stores = require("../models/storeModel");
const connections = require("../models/connectionModel");
const products = require("../models/sourceProductModel");
const variants = require("../models/sourceVariantModel");
const productMappings = require("../models/productMappingModel");
const variantMappings = require("../models/mappingVariantProductModel");
const orderMappings = require("../models/orderMappingModel");
const orderLines = require("../models/orderLineItemModel");
const shipments = require("../models/orderShipmentModel");
const plans = require("../models/planModel");
const policy = require("../models/shippingPolicyModel");
const settings = require("../models/sourceConnectionSettingsModel");
const inbox = require("../models/webhookInboxModel");
const worker = require("../services/webhookInbox");
const sync = require("../services/orderSync");
const shopify = require("../services/shopify");
const billing = require("../services/billing");
const notifications = require("../services/notifications");
const hooks = require("../controllers/webhookController");
const planController = require("../controllers/planController");
const prefix = `reliability-${Date.now().toString(36)}`;
let source, destination, connection, productMapping, sourceVariant;

before(async () => {
  await runMigrations();
  const group = require("crypto").randomUUID();
  source = await stores.upsertStore({ shop_domain: `${prefix}-source.myshopify.com`, access_token: "fake", store_group_id: group });
  destination = await stores.upsertStore({ shop_domain: `${prefix}-destination.myshopify.com`, access_token: "fake", store_group_id: group });
  await stores.chooseStoreType(source.id, "source");
  await stores.chooseStoreType(destination.id, "destination");
  connection = await connections.createConnection({ sourceStoreId: source.id, destinationStoreId: destination.id });
  const product = await products.upsert(source.id, {
    id: 888111, title: "Regression product", variants: [{ id: 888112, title: "Default", price: "10.00" }],
  });
  sourceVariant = (await variants.listForProduct(product.id))[0];
  productMapping = await productMappings.ensure({ connectionId: connection.id, sourceProductId: product.id, sourceShopifyProductId: 888111 });
  await variantMappings.upsertMany(productMapping.id, [{ sourceVariantMappingId: sourceVariant.id, sourceShopifyVariantId: 888112, destinationVariantId: 888113 }]);
});

after(async () => {
  await query("DELETE FROM stores WHERE shop_domain LIKE ?", [`${prefix}-%`]);
  await query("DELETE FROM plans WHERE name LIKE ?", [`${prefix}%`]);
  await query("DELETE FROM webhook_inbox WHERE shop_domain LIKE ?", [`${prefix}%`]);
  await pool.end();
});

function res() {
  return { code: 200, body: null, status(code) { this.code = code; return this; },
    send(body) { this.body = body; return this; }, json(body) { this.body = body; return this; } };
}

test("supplier prices, shipping and tax survive catalogue changes, quantity edits and new lines", async (t) => {
  let rate = 10;
  let shipping = 2;
  t.mock.method(policy, "forConnection", async () => ({ mode: "included", flat_rate: shipping }));
  t.mock.method(settings, "forConnection", async () => ({ sync_taxes: true, tax_rate_percent: rate }));
  t.mock.method(notifications, "orderCreated", async () => ({ queued: 0 }));
  const payload = { id: 888120, currency: "USD", line_items: [{ id: 888121, variant_id: 888113, quantity: 2, price: "20.00" }] };
  const order = await sync.cacheOrder(destination.id, payload);
  await sync.queueForSources(destination.id, order);
  const initial = await orderMappings.findByPair(connection.id, order.id);
  assert.equal(Number(initial.source_total), 26);
  await query("UPDATE source_variant_mappings SET price = 40 WHERE id = ?", [sourceVariant.id]);
  rate = 30; shipping = 7;
  await sync.queueForSources(destination.id, order);
  assert.equal(Number((await orderMappings.findByPair(connection.id, order.id)).source_total), 26);
  assert.equal(Number((await orderLines.sourceLinesForOrder(order.id))[0].source_price), 10);
  payload.line_items[0].quantity = 3;
  await sync.cacheOrder(destination.id, payload);
  await sync.queueForSources(destination.id, order);
  assert.equal(Number((await orderMappings.findByPair(connection.id, order.id)).source_total), 39);
  payload.line_items.push({ id: 888122, variant_id: 888113, quantity: 1, price: "80.00" });
  await sync.cacheOrder(destination.id, payload);
  await sync.queueForSources(destination.id, order);
  const edited = await orderMappings.findByPair(connection.id, order.id);
  assert.equal(Number(edited.source_products_total), 70);
  assert.equal(Number(edited.source_total), 85);
  // Legacy records retain their saved total while acquiring the first snapshot.
  await query("UPDATE order_mappings SET supplier_terms_snapshot = NULL WHERE id = ?", [edited.id]);
  await query("UPDATE source_variant_mappings SET price = 80 WHERE id = ?", [sourceVariant.id]);
  await sync.queueForSources(destination.id, order);
  assert.equal(Number((await orderMappings.findByPair(connection.id, order.id)).source_total), 85);
});

test("webhook acknowledgement follows a durable write; an unavailable DB returns 503", async (t) => {
  const req = { webhookShop: destination.shop_domain, webhookPayload: { id: 1 }, webhookTopic: "orders/create", get: () => "delivery-one" };
  let saved = false;
  const save = t.mock.method(inbox, "enqueue", async () => { saved = true; });
  const response = res();
  response.send = function () { assert.equal(saved, true); return this; };
  await worker.receive("ordersCreate")(req, response);
  assert.equal(response.code, 200);
  save.mock.mockImplementation(async () => { throw new Error("DB unavailable"); });
  const failed = res();
  await worker.receive("ordersCreate")(req, failed);
  assert.equal(failed.code, 503);
});

test("supplier cancellation and its request are atomic, and standing shipments block cancellation", async (t) => {
  t.mock.method(notifications, "orderCreated", async () => ({ queued: 0 }));
  const first = await sync.cacheOrder(destination.id, { id: 888130, currency: "USD", line_items: [{ id: 888131, variant_id: 888113, quantity: 1, price: "100.00" }] });
  await sync.queueForSources(destination.id, first);
  const sale = await orderMappings.findByPair(connection.id, first.id);
  assert.equal(await orderMappings.cancelAndQueue(sale.id, "unavailable"), 1);
  const cancelled = await orderMappings.findById(sale.id);
  assert.equal(cancelled.source_fulfillment_status, "cancelled");
  assert.equal(cancelled.cancel_status, "pending");
  await assert.rejects(orderMappings.cancelAndQueue(sale.id, "again"), { statusCode: 409 });
  const second = await sync.cacheOrder(destination.id, { id: 888140, currency: "USD", line_items: [{ id: 888141, variant_id: 888113, quantity: 1, price: "100.00" }] });
  await sync.queueForSources(destination.id, second);
  const shippedSale = await orderMappings.findByPair(connection.id, second.id);
  await sync.recordShipment(shippedSale.id, {});
  await assert.rejects(orderMappings.cancelAndQueue(shippedSale.id, "too late"), { statusCode: 409 });
  assert.equal((await orderMappings.findById(shippedSale.id)).cancel_status, "none");
});

test("webhook inbox deduplicates, recovers claims, retries failures and clears completed payloads", async (t) => {
  const job = { deliveryId: "persisted-event", handler: "ordersCreate", shop: destination.shop_domain, payload: { id: 888120 } };
  await inbox.enqueue(job);
  await inbox.enqueue(job);
  const rows = await query("SELECT * FROM webhook_inbox WHERE shop_domain = ?", [destination.shop_domain]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal((await Promise.all([inbox.claim(row.id), inbox.claim(row.id)])).filter(Boolean).length, 1);
  await query("UPDATE webhook_inbox SET claimed_at = NOW() - INTERVAL 16 MINUTE WHERE id = ?", [row.id]);
  assert.equal(await inbox.claim(row.id), true);
  await query("UPDATE webhook_inbox SET status = 'pending', available_at = NOW() WHERE id = ?", [row.id]);
  const cache = t.mock.method(sync, "cacheOrder", async () => { throw new Error("temporary outage"); });
  assert.deepEqual(await worker.run(), { completed: 0, failed: 1 });
  const retry = (await query("SELECT * FROM webhook_inbox WHERE id = ?", [row.id]))[0];
  assert.equal(retry.status, "pending");
  assert.match(retry.error, /temporary outage/);
  assert.ok(retry.payload);
  await inbox.enqueue({ ...job, deliveryId: "later-event" });
  assert.equal((await inbox.listPending()).filter((item) => item.shop_domain === destination.shop_domain).length, 0);
  cache.mock.mockImplementation(async () => null);
  await query("UPDATE webhook_inbox SET available_at = NOW() WHERE id = ?", [row.id]);
  assert.deepEqual(await worker.run(), { completed: 1, failed: 0 });
  const done = (await query("SELECT * FROM webhook_inbox WHERE id = ?", [row.id]))[0];
  assert.equal(done.status, "completed");
  assert.equal(done.payload, null);
  assert.deepEqual(await worker.run(), { completed: 1, failed: 0 });
  assert.deepEqual(await worker.run(), { completed: 0, failed: 0 });
});

function cancellation(t, extra = {}) {
  t.mock.method(orderLines, "destinationLinesForConnection", async () => [{ shopify_line_item_id: "1" }]);
  t.mock.method(shipments, "listForMapping", async () => []);
  t.mock.method(orderMappings, "markCancelReview", async () => {});
  t.mock.method(orderMappings, "markCancelProcessing", async () => {});
  t.mock.method(orderMappings, "markCancelSent", async () => {});
  t.mock.method(orderMappings, "markCancelFailed", async () => {});
  return { id: 1, connection_id: 1, destination_order_id: 1, destination_shopify_order_id: "123", destination_shop_domain: destination.shop_domain, cancel_status: "pending", ...extra };
}

test("mixed supplier, own-store items and partially shipped orders never trigger full cancellation", async (t) => {
  const mapping = cancellation(t);
  const call = t.mock.method(shopify, "forShop", async (_shop, request) => {
    assert.match(request.query, /query CancellationOrder/);
    return { order: { cancelledAt: null, lineItems: { nodes: [{ id: "gid://shopify/LineItem/1", currentQuantity: 1 }, { id: "gid://shopify/LineItem/2", currentQuantity: 1 }], pageInfo: { hasNextPage: false } } } };
  });
  assert.equal((await sync.cancelOne(mapping)).review, true);
  assert.equal(orderMappings.markCancelReview.mock.calls.length, 1);
  assert.equal(call.mock.calls.length, 1);
});

test("accepted cancellation remains pending, polling never resubmits, and only confirmed cancellation completes", async (t) => {
  const mapping = cancellation(t);
  let cancelledAt = null;
  let mutations = 0;
  t.mock.method(shopify, "forShop", async (_shop, request) => {
    if (request.query.includes("mutation CancelDestinationOrder")) {
      mutations++;
      return { orderCancel: { job: { id: "job-1", done: false }, orderCancelUserErrors: [] } };
    }
    return { order: { cancelledAt, lineItems: { nodes: [{ id: "gid://shopify/LineItem/1", currentQuantity: 1 }], pageInfo: { hasNextPage: false } } } };
  });
  assert.equal((await sync.cancelOne(mapping)).pending, true);
  assert.equal(orderMappings.markCancelSent.mock.calls.length, 0);
  assert.equal(orderMappings.markCancelProcessing.mock.calls.length, 2);
  assert.deepEqual(orderMappings.markCancelProcessing.mock.calls[0].arguments, [1, null]);
  mapping.cancel_status = "processing";
  mapping.cancel_requested_at = new Date();
  assert.equal((await sync.cancelOne(mapping)).pending, true);
  assert.equal(mutations, 1);
  cancelledAt = new Date().toISOString();
  assert.equal((await sync.cancelOne(mapping)).ok, true);
  assert.equal(orderMappings.markCancelSent.mock.calls.length, 1);
  assert.equal(mutations, 1);
});

test("a lost cancellation response retains processing state instead of queuing a second mutation", async (t) => {
  const mapping = cancellation(t);
  t.mock.method(shopify, "forShop", async (_shop, request) => {
    if (request.query.includes("mutation CancelDestinationOrder")) throw new Error("response lost");
    return { order: { cancelledAt: null, lineItems: { nodes: [{ id: "gid://shopify/LineItem/1", currentQuantity: 1 }], pageInfo: { hasNextPage: false } } } };
  });
  assert.equal((await sync.cancelOne(mapping)).pending, true);
  assert.deepEqual(orderMappings.markCancelProcessing.mock.calls[0].arguments, [1, null]);
  assert.equal(orderMappings.markCancelFailed.mock.calls.length, 0);
});

test("paid downgrade changes nothing on failure or decline; approval applies choices and plan together exactly once", async (t) => {
  const [insert] = await pool.query("INSERT INTO plans (name, price, is_active, max_limit, max_sources) VALUES (?, 10, 1, 0, 0)", [`${prefix}-paid`]);
  const free = await plans.findFree();
  await plans.selectForStore(destination.id, free.id);
  await query("UPDATE product_mappings SET accepted_at = NOW(), sync_status = 'synced' WHERE id = ?", [productMapping.id]);
  const create = t.mock.method(billing, "createSubscription", async () => { throw new Error("billing unavailable"); });
  const req = { store: await stores.findById(destination.id), storeId: destination.id, shop: destination.shop_domain,
    body: { plan_id: insert.insertId, unsync_mapping_ids: [productMapping.id], pause_connection_ids: [connection.id] } };
  const failed = res();
  await planController.postSelectPlan(req, failed);
  assert.equal(failed.code, 500);
  assert.equal((await connections.findById(connection.id)).status, "active");
  assert.ok((await productMappings.findById(productMapping.id)).accepted_at);
  await plans.startPaidPurchase(destination.id, insert.insertId, 222001, { unsync: [productMapping.id], pause: [connection.id] });
  assert.equal(await plans.finishPaidPurchase(destination.id, insert.insertId, 222001, false), true);
  assert.equal((await connections.findById(connection.id)).status, "active");
  create.mock.mockImplementation(async () => ({ chargeId: "222002", confirmationUrl: "https://example.com/approve" }));
  const pending = res();
  await planController.postSelectPlan(req, pending);
  assert.equal(pending.code, 200);
  assert.equal((await connections.findById(connection.id)).status, "active");
  assert.equal((await plans.currentForStore(destination.id)).membership_id, free.id);
  assert.equal(await plans.finishPaidPurchase(destination.id, insert.insertId, 222002, true), true);
  assert.equal((await connections.findById(connection.id)).status, "paused");
  assert.equal((await productMappings.findById(productMapping.id)).accepted_at, null);
  const active = await plans.currentForStore(destination.id);
  assert.equal(active.membership_id, insert.insertId);
  assert.equal(await plans.finishPaidPurchase(destination.id, insert.insertId, 222002, true), true);
  assert.equal((await plans.currentForStore(destination.id)).id, active.id);
});

test("active stores with test- prefixes or fresh tokens without refresh tokens are reconciled", async (t) => {
  t.mock.method(stores, "listAll", async () => [
    { is_active: 1, access_token: "fake", refresh_token: "fake", shop_domain: "test-boutique.myshopify.com" },
    { is_active: 1, access_token: "fake", shop_domain: "fresh-token.myshopify.com" },
    { is_active: 0, access_token: "fake", shop_domain: "inactive.myshopify.com" },
  ]);
  const requested = new Set();
  t.mock.method(shopify, "forShop", async (shop) => { requested.add(shop); return { webhookSubscriptionCreate: { userErrors: [] } }; });
  await require("../services/webhooks").reconcileWebhooks();
  assert.deepEqual([...requested].sort(), ["fresh-token.myshopify.com", "test-boutique.myshopify.com"]);
});
