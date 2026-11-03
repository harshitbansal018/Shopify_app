// tests/customNotifications.test.js
require("dotenv").config({ quiet: true });
const { query, pool } = require("../config/db");
const { runMigrations } = require("../config/migrate");
const storeModel = require("../models/storeModel");
const connectionModel = require("../models/connectionModel");
const notificationSettingsModel = require("../models/notificationSettingsModel");
const notifications = require("../services/notifications");
const shippingController = require("../controllers/shippingController");
const storeController = require("../controllers/storeController");

function fakeRes() {
  const res = {
    code: 200,
    body: null,
    status(c) {
      res.code = c;
      return res;
    },
    json(b) {
      res.body = b;
      return res;
    },
    send(b) {
      res.body = b;
      return res;
    },
  };
  return res;
}

let passed = 0;
let failed = 0;

function check(label, condition, extra = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${extra ? ` -> ${extra}` : ""}`);
  }
}

async function run() {
  console.log("\nCustom notification email & horizontal toggle tests");
  await runMigrations();

  const testSuffix = Date.now().toString(36);
  const sourceDomain = `test-source-${testSuffix}.myshopify.com`;
  const destDomain = `test-dest-${testSuffix}.myshopify.com`;
  const groupId = require("crypto").randomUUID();

  // 1. Setup stores
  const source = await storeModel.upsertStore({
    shop_domain: sourceDomain,
    store_name: "Test Source",
    access_token: "fake-token",
    currency: "USD",
    store_group_id: groupId,
  });
  await storeModel.chooseStoreType(source.id, "source");

  const destination = await storeModel.upsertStore({
    shop_domain: destDomain,
    store_name: "Test Destination",
    access_token: "fake-token",
    currency: "USD",
    store_group_id: groupId,
  });
  await storeModel.chooseStoreType(destination.id, "destination");

  await storeModel.setEmail(source.id, "owner-source@test.com");
  await storeModel.setEmail(destination.id, "owner-dest@test.com");

  // 2. Connect stores
  const connection = await connectionModel.createConnection({
    sourceStoreId: source.id,
    destinationStoreId: destination.id,
    status: "active",
    settings: {},
  });
  const connectionId = connection.id;

  try {
    // Test A: Source saves with custom email on order_created, empty email on payout_source
    {
      const res = fakeRes();
      await shippingController.postSourceNotifications(
        {
          store: { store_type: "source" },
          storeId: source.id,
          body: {
            connection_id: connectionId,
            notifications: {
              order_created: true,
              payout_source: true,
            },
            emails_to: {
              email_to_order_created: "warehouse@orders.com",
              email_to_payout_source: "", // empty -> fallback to owner
            },
          },
        },
        res
      );

      check("Source postSourceNotifications succeeds (200)", res.code === 200, String(res.code));
      check("email_to_order_created saved", res.body.notifications.email_to_order_created === "warehouse@orders.com");
      check("email_to_payout_source is null when empty", res.body.notifications.email_to_payout_source === null);
    }

    // Test B: Destination saves order_updates unchecked (off) and payout_destination checked with custom email
    {
      const res = fakeRes();
      await storeController.postNotifications(
        {
          store: { store_type: "destination" },
          storeId: destination.id,
          body: {
            connection_id: connectionId,
            notifications: {
              order_updates: false, // unchecked -> no email
              payout_destination: true, // checked with custom email
            },
            emails_to: {
              email_to_order_updates: null,
              email_to_payout_destination: "finance@destshop.com",
            },
          },
        },
        res
      );

      check("Destination postNotifications succeeds (200)", res.code === 200, String(res.code));
      check("order_updates is false (no email goes)", res.body.notifications.order_updates === false);
      check("payout_destination is true", res.body.notifications.payout_destination === true);
      check("email_to_payout_destination saved", res.body.notifications.email_to_payout_destination === "finance@destshop.com");

      // Verify Source settings were not affected
      check("Source order_created still true", res.body.notifications.order_created === true);
      check("Source email_to_order_created still warehouse@orders.com", res.body.notifications.email_to_order_created === "warehouse@orders.com");
    }

    // Each endpoint must enforce recipient ownership even for modified requests.
    for (const [role, controller, storeId, foreignKey, ownKey] of [
      ["source", shippingController.postSourceNotifications, source.id, "order_updates", "order_created"],
      ["destination", storeController.postNotifications, destination.id, "order_created", "order_updates"],
    ]) {
      const before = await notificationSettingsModel.forConnection(connectionId);
      const res = fakeRes();
      await controller({
        store: { store_type: role }, storeId,
        body: {
          connection_id: connectionId,
          notifications: { [foreignKey]: !before[foreignKey] },
          emails_to: { [`email_to_${foreignKey}`]: "outsider@example.com" },
        },
      }, res);
      const after = await notificationSettingsModel.forConnection(connectionId);
      check(`${role} cannot change the other store's switch`, res.code === 200 && after[foreignKey] === before[foreignKey]);
      check(`${role} cannot redirect the other store's email`, after[`email_to_${foreignKey}`] === before[`email_to_${foreignKey}`]);

      for (const invalid of ["invalid email", "a@example.com,b@example.com", "x".repeat(250) + "@example.com", 123]) {
        const invalidRes = fakeRes();
        await controller({
          store: { store_type: role }, storeId,
          body: {
            connection_id: connectionId,
            notifications: { [ownKey]: !before[ownKey] },
            emails_to: { [`email_to_${ownKey}`]: invalid },
            notification_email: "must-not-save@example.com",
          },
        }, invalidRes);
        const unchanged = await notificationSettingsModel.forConnection(connectionId);
        check(`${role} rejects invalid address ${JSON.stringify(invalid).slice(0, 40)}`, invalidRes.code === 400);
        check("invalid email does not update the switch", unchanged[ownKey] === before[ownKey]);
        check("invalid email does not update the default inbox", !(await storeModel.findById(storeId)).notification_email);
      }

      const emptyRes = fakeRes();
      await controller({ store: { store_type: role }, storeId, body: { connection_id: connectionId } }, emptyRes);
      check(`${role} empty request preserves every saved setting`,
        JSON.stringify(await notificationSettingsModel.forConnection(connectionId)) === JSON.stringify(before));
    }

    // Independent simultaneous saves must not restore a stale copy of the other side.
    await Promise.all([
      notificationSettingsModel.save(connectionId, { order_created: false }, {}, { recipientRole: "source" }),
      notificationSettingsModel.save(connectionId, { payout_destination: false }, {}, { recipientRole: "destination" }),
    ]);
    const concurrent = await notificationSettingsModel.forConnection(connectionId);
    check("simultaneous saves preserve both stores' changes", !concurrent.order_created && !concurrent.payout_destination);
    await notificationSettingsModel.save(connectionId, { order_created: true, payout_destination: true });

    // Test C: orderCreated queues email to the custom address
    {
      const fakeSale = {
        id: 99999,
        connection_id: connectionId,
        source_store_id: source.id,
        destination_store_id: destination.id,
        destination_order_name: "#1001",
        currency: "USD",
        source_total: 50,
      };

      const result = await notifications.orderCreated(fakeSale);
      check("orderCreated queued", result.queued === 1);

      const [outboxRows] = await pool.query(
        "SELECT * FROM email_outbox WHERE connection_id = ? AND kind = 'order_created' ORDER BY id DESC LIMIT 1",
        [connectionId]
      );
      check("Queued to custom email warehouse@orders.com", outboxRows[0].to_email === "warehouse@orders.com", outboxRows[0]?.to_email);
    }

    // Test D: When uncheck order_created, no email is queued
    {
      await notificationSettingsModel.save(connectionId, { order_created: false });
      const fakeSale2 = {
        id: 99998,
        connection_id: connectionId,
        source_store_id: source.id,
        destination_store_id: destination.id,
        destination_order_name: "#1002",
        currency: "USD",
        source_total: 50,
      };
      const result = await notifications.orderCreated(fakeSale2);
      check("Unchecked order_created queues nothing (off: true)", result.queued === 0 && result.off === true);
    }

  } finally {
    // Cleanup
    await connectionModel.deleteConnection(connectionId);
    await query("DELETE FROM stores WHERE id IN (?, ?)", [source.id, destination.id]);
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
