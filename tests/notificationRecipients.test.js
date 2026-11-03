const assert = require("node:assert/strict");
const { test } = require("node:test");
const notifications = require("../services/notifications");
const settingsModel = require("../models/notificationSettingsModel");
const mappingModel = require("../models/orderMappingModel");
const shipmentModel = require("../models/orderShipmentModel");
const payoutModel = require("../models/payoutModel");
const planLimits = require("../services/planLimits");
const outbox = require("../models/emailOutboxModel");
const shopify = require("../services/shopify");
const stores = require("../models/storeModel");
const connections = require("../models/connectionModel");
const shippingController = require("../controllers/shippingController");
const storeController = require("../controllers/storeController");

function fulfilment(t, overrides = {}, status = "fulfilled") {
  const rows = [];
  const seen = new Set();
  t.mock.method(settingsModel, "forConnection", async () => ({
    ...settingsModel.defaults(1),
    ...overrides,
  }));
  t.mock.method(mappingModel, "findById", async () => ({
    id: 10, connection_id: 1, destination_store_id: 2,
    source_fulfillment_status: status, source_total: 25, currency: "USD",
  }));
  t.mock.method(shipmentModel, "listForMapping", async () => [{
    id: 20, tracking: [{ number: "TRACK-123" }],
  }]);
  t.mock.method(payoutModel, "summaryForDestination", async () => []);
  t.mock.method(planLimits, "emailAllowance", async () => ({ ok: true }));
  t.mock.method(outbox, "enqueue", async (row) => {
    if (seen.has(row.dedupeKey)) return false;
    seen.add(row.dedupeKey);
    rows.push(row);
    return true;
  });
  return rows;
}

test("payout-only delivery ignores a saved address for disabled order updates", async (t) => {
  const rows = fulfilment(t, {
    order_updates: false,
    email_to_order_updates: "operations@example.com",
    email_to_payout_destination: "finance@example.com",
  });
  assert.deepEqual(await notifications.orderFulfilled(10), { queued: 1 });
  assert.equal(rows[0].toEmail, "finance@example.com");
  assert.equal(rows[0].kind, "payout_destination");
  assert.match(rows[0].subject, /^You owe USD 25\.00/);
  assert.doesNotMatch(rows[0].text, /TRACK-123/);
});

test("different inboxes receive separate content and redelivery queues nothing", async (t) => {
  const rows = fulfilment(t, {
    email_to_order_updates: "operations@example.com",
    email_to_payout_destination: "finance@example.com",
  });
  assert.deepEqual(await notifications.orderFulfilled(10), { queued: 2 });
  assert.deepEqual(rows.map((row) => row.toEmail), ["operations@example.com", "finance@example.com"]);
  assert.match(rows[0].text, /TRACK-123/);
  assert.doesNotMatch(rows[0].text, /USD 25\.00/);
  assert.match(rows[1].text, /USD 25\.00/);
  assert.doesNotMatch(rows[1].text, /TRACK-123/);
  assert.deepEqual(await notifications.orderFulfilled(10), { queued: 0 });
  assert.equal(rows.length, 2);
});

for (const [label, emails] of [
  ["default inbox", {}],
  ["same custom inbox", {
    email_to_order_updates: "team@example.com",
    email_to_payout_destination: "team@example.com",
  }],
]) {
  test(`${label} receives one combined shipment and payout email`, async (t) => {
    const rows = fulfilment(t, emails);
    assert.deepEqual(await notifications.orderFulfilled(10), { queued: 1 });
    assert.match(rows[0].text, /TRACK-123/);
    assert.match(rows[0].text, /USD 25\.00/);
  });
}

test("blank payout override uses the default inbox, not the disabled update address", async (t) => {
  const rows = fulfilment(t, { order_updates: false, email_to_order_updates: "operations@example.com" });
  await notifications.orderFulfilled(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toEmail, null);
});

test("partial fulfilment sends tracking only to the order-update inbox", async (t) => {
  const rows = fulfilment(t, {
    email_to_order_updates: "operations@example.com",
    email_to_payout_destination: "finance@example.com",
  }, "partial");
  await notifications.orderFulfilled(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toEmail, "operations@example.com");
  assert.doesNotMatch(rows[0].text, /USD 25\.00/);
});

test("disabling both destination notifications queues nothing", async (t) => {
  const rows = fulfilment(t, { order_updates: false, payout_destination: false });
  assert.deepEqual(await notifications.orderFulfilled(10), { queued: 0, off: true });
  assert.equal(rows.length, 0);
});

test("a plan allowing only one email still limits separate recipients", async (t) => {
  const rows = fulfilment(t, {
    email_to_order_updates: "operations@example.com",
    email_to_payout_destination: "finance@example.com",
  });
  t.mock.method(planLimits, "emailAllowance", async () => rows.length === 0
    ? { ok: true }
    : { ok: false, used: 1, limit: 1, planName: "Test", period: { start: new Date(), end: new Date() } });
  assert.deepEqual(await notifications.orderFulfilled(10), { queued: 1 });
  assert.equal(rows[0].status, undefined);
  assert.equal(rows[1].status, "skipped");
  assert.equal(rows[1].toEmail, "finance@example.com");
  assert.equal(rows[2].kind, "plan_notice");
});

for (const role of ["source", "destination"]) {
  test(`${role} settings fetch and cache the missing owner email from Shopify`, async (t) => {
    t.mock.method(shopify, "forShop", async () => ({ shop: { email: "owner@example.com" } }));
    const setEmail = t.mock.method(stores, "setEmail", async () => {});
    t.mock.method(connections, role === "source" ? "listForSource" : "listForDestination", async () => []);
    t.mock.method(planLimits, "collectionsAllowed", async () => ({ ok: true }));
    t.mock.method(planLimits, "firstPlanWithCollections", async () => null);
    const req = {
      store: { id: 1, store_type: role, shop_domain: "test.myshopify.com", access_token: "fake" },
      storeId: 1, query: {},
    };
    let rendered = false;
    const res = {
      render() { rendered = true; },
      status(code) { assert.fail(`Unexpected response ${code}`); },
    };
    await (role === "source" ? shippingController.getShipping : storeController.getSettings)(req, res);
    assert.equal(rendered, true);
    assert.equal(req.store.email, "owner@example.com");
    assert.deepEqual(setEmail.mock.calls[0].arguments, [1, "owner@example.com"]);
  });
}
