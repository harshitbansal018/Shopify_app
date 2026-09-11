/* Notification emails, end to end against the real database.
 *
 * The destination decides every email on a connection -- including the two
 * that land in the SOURCE's inbox -- so the switches are what this guards
 * hardest: an email that goes out when it is switched off, or to the wrong
 * store, is the bug a merchant notices.
 *
 * The source's money email is the SETTLEMENT: sent when the destination
 * records a payment, built only from the source's own prices. Nothing about
 * money goes to the source on fulfilment.
 *
 * Nothing here reaches a real mail server or Shopify. The mailer's transport
 * and shopify.forShop are swapped for fakes.
 */
require("dotenv").config({ quiet: true });

const path = require("path");

const SERVER = path.join(__dirname, "..");

const { pool, query } = require(path.join(SERVER, "config/db"));
const { runMigrations } = require(path.join(SERVER, "config/migrate"));
const storeModel = require(path.join(SERVER, "models/storeModel"));
const connectionModel = require(path.join(SERVER, "models/connectionModel"));
const orderModel = require(path.join(SERVER, "models/orderModel"));
const orderMappingModel = require(path.join(SERVER, "models/orderMappingModel"));
const payoutModel = require(path.join(SERVER, "models/payoutModel"));
const notificationSettingsModel = require(
  path.join(SERVER, "models/notificationSettingsModel")
);
const emailOutboxModel = require(path.join(SERVER, "models/emailOutboxModel"));
const shopify = require(path.join(SERVER, "services/shopify"));
const mailer = require(path.join(SERVER, "services/mailer"));
const templates = require(path.join(SERVER, "services/emailTemplates"));
const notifications = require(path.join(SERVER, "services/notifications"));
const storeController = require(path.join(SERVER, "controllers/storeController"));

const RUN = `nt${Date.now().toString(36)}`;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

async function cleanup() {
  await query("DELETE FROM stores WHERE shop_domain LIKE ?", [`${RUN}-%`]);
}

/** The emails queued on a connection, newest first. */
const outbox = (connectionId) =>
  emailOutboxModel.listForConnection(connectionId, { limit: 200 });

/** Enough of an Express response for a handler to answer into. */
function fakeRes() {
  return {
    code: 200,
    body: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

let saleNumber = 0;

/**
 * A destination sale that included this source's products, as the job it
 * makes. The shopper pays 25% more than the source is owed, so a test can tell
 * the two prices apart.
 */
async function newSale(destination, connection, { sourceTotal = 20 } = {}) {
  saleNumber += 1;

  const payload = {
    id: 5000 + saleNumber,
    order_number: 3000 + saleNumber,
    name: `#${3000 + saleNumber}`,
    currency: "USD",
    subtotal_price: "25.00",
    total_price: "25.00",
    financial_status: "paid",
    fulfillment_status: null,
    test: false,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    line_items: [],
  };

  await orderModel.upsert(destination.id, payload);
  const order = await orderModel.findByShopifyId(destination.id, payload.id);

  return orderMappingModel.claim(connection.id, order.id, {
    sourceTotal,
    destinationTotal: sourceTotal * 1.25,
    currency: "USD",
    lineCount: 2,
  });
}

(async () => {
  try {
    await runMigrations();
    await cleanup();

    const source = await storeModel.upsertStore({
      shop_domain: `${RUN}-source.myshopify.com`,
      access_token: "shpat_source_token",
      store_name: "Warehouse",
      currency: "USD",
    });
    await storeModel.chooseStoreType(source.id, "source");

    const destination = await storeModel.upsertStore({
      shop_domain: `${RUN}-dest.myshopify.com`,
      access_token: "shpat_dest_token",
      store_name: "Front Shop",
      currency: "USD",
    });
    await storeModel.chooseStoreType(destination.id, "destination");

    // Pairing has its own suite; here the two stores are simply grouped.
    await query("UPDATE stores SET store_group_id = ? WHERE id IN (?, ?)", [
      `${RUN}-group`,
      source.id,
      destination.id,
    ]);

    const connection = await connectionModel.createConnection({
      sourceStoreId: source.id,
      destinationStoreId: destination.id,
    });

    await storeModel.setEmail(source.id, "owner@warehouse.test");
    await storeModel.setEmail(destination.id, "owner@frontshop.test");

    /* ---------------- the switches ---------------- */

    console.log("\nSwitches, set by the destination");
    {
      const fresh = await notificationSettingsModel.forConnection(connection.id);

      check("an unconfigured connection has every email on",
        notificationSettingsModel.KEYS.every((key) => fresh[key] === true),
        JSON.stringify(fresh));

      const saved = await notificationSettingsModel.save(connection.id, {
        order_created: false,
      });

      check("an explicit false turns one off", saved.order_created === false);
      check("a key left out stays on",
        saved.order_updates && saved.payout_destination && saved.payout_source,
        "an email added later would otherwise be off for every older connection");

      await notificationSettingsModel.save(connection.id, {});

      const rows = await query(
        "SELECT COUNT(*) AS total FROM notification_settings WHERE connection_id = ?",
        [connection.id]
      );
      check("saving twice keeps ONE row", Number(rows[0].total) === 1);

      const settlement = notificationSettingsModel.EMAILS.find(
        (email) => email.key === "payout_source");
      check("the source's money switch is the settlement",
        settlement.to === "source" && /settlement/i.test(settlement.label),
        settlement.label);
    }

    /* ---------------- order created -> source ---------------- */

    console.log("\nOrder created: to the source");
    const saleA = await newSale(destination, connection, { sourceTotal: 20 });
    {
      const first = await notifications.orderCreated(saleA);
      check("one email is queued", first.queued === 1, JSON.stringify(first));

      const again = await notifications.orderCreated(saleA);
      check("a redelivered webhook queues nothing more", again.queued === 0,
        "Shopify redelivers orders/create routinely");

      const rows = (await outbox(connection.id)).filter((row) => row.kind === "order_created");

      check("exactly one row", rows.length === 1, String(rows.length));
      check("it goes to the SOURCE", rows[0].recipient_store_id === source.id);
      check("it names the order and the seller",
        rows[0].subject.includes(saleA.destination_order_name) &&
          rows[0].subject.includes("Front Shop"),
        rows[0].subject);
      check("and says what the source is owed", rows[0].text_body.includes("USD 20.00"));

      await notificationSettingsModel.save(connection.id, { order_created: false });
      const off = await notifications.orderCreated(
        await newSale(destination, connection)
      );
      check("switched off by the destination, nothing is queued",
        off.queued === 0 && off.off === true);
      await notificationSettingsModel.save(connection.id, {});
    }

    /* ---------------- fulfilled -> destination only ---------------- */

    console.log("\nFulfilled: to the destination only");
    {
      await orderMappingModel.markFulfilled(saleA.id, [
        { number: "TRK-1", company: "DHL", url: "https://dhl.test/1" },
      ]);

      const result = await notifications.orderFulfilled(saleA.id);
      check("one email is queued", result.queued === 1, JSON.stringify(result));

      const rows = await outbox(connection.id);
      const toDestination = rows.find((row) =>
        row.dedupe_key.startsWith(`order_fulfilled:${saleA.id}:`));

      check("the destination gets ONE email for shipped and owed together",
        toDestination &&
          toDestination.kind === "order_shipped" &&
          toDestination.recipient_store_id === destination.id,
        "two emails for one click teaches a merchant to ignore both");
      check("with the tracking, as a link",
        toDestination.html.includes("TRK-1") &&
          toDestination.html.includes('href="https://dhl.test/1"'));
      check("and what it now owes", toDestination.text_body.includes("USD 20.00"));

      check("the source gets no money email on fulfilment",
        !rows.some((row) =>
          row.recipient_store_id === source.id && row.kind !== "order_created"),
        "its money email is the settlement, sent when a payment is recorded");

      const repeat = await notifications.orderFulfilled(saleA.id);
      check("a double click queues nothing more", repeat.queued === 0);

      // Shipped updates off, the destination's payout on: it still goes, alone.
      await notificationSettingsModel.save(connection.id, { order_updates: false });

      const saleB = await newSale(destination, connection, { sourceTotal: 8 });
      await orderMappingModel.markFulfilled(saleB.id, []);

      const payoutOnly = await notifications.orderFulfilled(saleB.id);
      const bRows = (await outbox(connection.id)).filter((row) =>
        row.dedupe_key.includes(`:${saleB.id}:`));

      check("with shipped updates off, the payout still goes on its own",
        payoutOnly.queued === 1 &&
          bRows.length === 1 &&
          bRows[0].kind === "payout_destination",
        JSON.stringify(bRows.map((row) => row.kind)));
      check("and its subject says it is about money",
        bRows[0].subject.startsWith("You owe USD 8.00"), bRows[0].subject);

      await notificationSettingsModel.save(connection.id, {
        order_updates: false,
        payout_destination: false,
      });

      const saleC = await newSale(destination, connection);
      await orderMappingModel.markFulfilled(saleC.id, []);
      check("with both destination emails off, nothing is queued",
        (await notifications.orderFulfilled(saleC.id)).queued === 0);

      await notificationSettingsModel.save(connection.id, {});

      const notShipped = await newSale(destination, connection);
      check("an order that is not fulfilled queues nothing",
        (await notifications.orderFulfilled(notShipped.id)).queued === 0);
    }

    /* ---------------- cancelled -> destination ---------------- */

    console.log("\nCancelled: to the destination");
    {
      const saleD = await newSale(destination, connection);
      await orderMappingModel.markCancelledBySource(saleD.id, "Out of stock");

      const result = await notifications.orderCancelled(saleD.id);
      const rows = (await outbox(connection.id)).filter(
        (row) => row.dedupe_key === `order_cancelled:${saleD.id}`
      );

      check("one email, to the destination",
        result.queued === 1 && rows.length === 1 &&
          rows[0].recipient_store_id === destination.id);
      check("with the source's reason", rows[0].text_body.includes("Out of stock"));

      await notificationSettingsModel.save(connection.id, { order_updates: false });

      const saleE = await newSale(destination, connection);
      await orderMappingModel.markCancelledBySource(saleE.id, null);
      check("with order updates off, nothing is queued",
        (await notifications.orderCancelled(saleE.id)).queued === 0);

      await notificationSettingsModel.save(connection.id, {});
    }

    /* ---------------- payment recorded -> source (settlement) ---------------- */

    console.log("\nPayment recorded: the settlement, to the source");
    {
      // Fulfilled so far, at the SOURCE's prices: 20 + 8 + 20. The shopper
      // paid 25% more on each; none of that is the source's.
      const before = (await payoutModel.summaryForSource(source.id))
        .find((row) => row.connection_id === connection.id);

      check("the source has earned its own prices, not the shopper's",
        before.earned === 48, String(before.earned));

      const firstId = await payoutModel.record(connection.id, {
        amount: 30,
        currency: "USD",
        reference: "BANK-101",
        note: "Part payment for August",
      });

      const first = await notifications.paymentRecorded(firstId);
      check("recording a payment emails the source", first.queued === 1,
        JSON.stringify(first));

      const row = (await outbox(connection.id)).find(
        (email) => email.dedupe_key === `payment_settled:${firstId}`);

      check("it goes to the SOURCE", row && row.recipient_store_id === source.id);
      check("naming who paid and how much",
        row.subject.includes("Front Shop") && row.subject.includes("USD 30.00"),
        row.subject);
      check("with their reference and their note",
        row.text_body.includes("BANK-101") &&
          row.text_body.includes("Part payment for August"));
      check("and what is still owed, after this payment",
        row.text_body.includes("Still owed to you: USD 18.00"),
        "48 earned at the source's prices, less 30 recorded");
      check("it is not called settled while money is still owed",
        !/settled in full/i.test(row.subject));
      check("it says a payment was RECORDED, not that money arrived",
        /does not move money/.test(row.text_body),
        "an email is not proof the transfer landed");
      check("it never talks about the destination's margin",
        !/margin|retail|shopper paid/i.test(row.text_body));

      check("the same payment is never emailed twice",
        (await notifications.paymentRecorded(firstId)).queued === 0);

      // The payment that clears the balance.
      const lastId = await payoutModel.record(connection.id, {
        amount: 18,
        currency: "USD",
        reference: "BANK-102",
      });
      await notifications.paymentRecorded(lastId);

      const settled = (await outbox(connection.id)).find(
        (email) => email.dedupe_key === `payment_settled:${lastId}`);

      check("the payment that clears the balance says so",
        /settled in full/i.test(settled.subject) &&
          settled.text_body.includes("now settled"),
        settled.subject);

      // Switched off by the destination.
      await notificationSettingsModel.save(connection.id, { payout_source: false });

      const quietId = await payoutModel.record(connection.id, { amount: 5, currency: "USD" });
      const quiet = await notifications.paymentRecorded(quietId);
      check("switched off by the destination, nothing is queued",
        quiet.queued === 0 && quiet.off === true);

      await notificationSettingsModel.save(connection.id, {});

      // 55 recorded against 48 earned: credit, not a debt.
      const aheadId = await payoutModel.record(connection.id, { amount: 2, currency: "USD" });
      await notifications.paymentRecorded(aheadId);

      const ahead = (await outbox(connection.id)).find(
        (email) => email.dedupe_key === `payment_settled:${aheadId}`);

      check("paying ahead is shown as credit, not as money owed",
        ahead.text_body.includes("Paid ahead: USD 7.00") &&
          !ahead.text_body.includes("Still owed to you"),
        ahead.text_body);

      check("a payment that does not exist queues nothing",
        (await notifications.paymentRecorded(99999999)).queued === 0);
    }

    /* ---------------- what goes into an email ---------------- */

    console.log("\nWhat goes into an email");
    {
      const hostile = {
        id: 1,
        destination_order_name: "#1<script>alert(1)</script>",
        source_store_name: "Evil <img src=x onerror=alert(1)>",
        destination_store_name: "Front Shop",
        source_total: "5.00",
        currency: "USD",
        line_count: 1,
        shipping_address: { first_name: "Steve", address1: "1 Secret Lane" },
        source_tracking: [{ number: "X1", company: "Post", url: "javascript:alert(1)" }],
      };

      const created = templates.orderCreated(hostile);
      check("an order name is escaped, not run",
        !created.html.includes("<script>") && created.html.includes("&lt;script&gt;"));
      check("the shopper's address is never put in an email",
        !created.html.includes("Secret Lane") && !created.html.includes("Steve"),
        "the source sees it in the app, behind a login; email gets forwarded");

      const shipped = templates.orderFulfilled(hostile, { shipped: true, owed: null });
      check("a store name is escaped", !shipped.html.includes("<img"));
      check("a javascript: tracking link is not turned into a link",
        !shipped.html.includes("javascript:") && !shipped.text.includes("javascript:"));
      check("but its tracking number is still shown", shipped.html.includes("X1"));

      const paid = templates.paymentSettled({
        destinationName: "Front <b>Shop</b>",
        amount: "10.00",
        currency: "USD",
        reference: "<script>x</script>",
        note: "Thanks <3",
        paidAt: "2026-09-10T00:00:00Z",
        received: 10,
        outstanding: 0,
      });
      check("a settlement email escapes what the payer typed",
        !paid.html.includes("<script>") && !paid.html.includes("<b>Shop</b>"));

      check("every email has a plain-text version too",
        [created, shipped, paid].every((email) => email.text && email.text.length > 20));
    }

    /* ---------------- finding a store's address ---------------- */

    console.log("\nFinding a store's address");
    {
      await storeModel.setEmail(destination.id, null);

      const realForShop = shopify.forShop;
      let asked = 0;

      shopify.forShop = async () => {
        asked += 1;
        return { shop: { email: "found@frontshop.test" } };
      };

      const found = await notifications.addressFor(destination.id);
      check("a missing address is fetched from Shopify",
        found.email === "found@frontshop.test");
      check("and saved", (await storeModel.findById(destination.id)).email ===
        "found@frontshop.test");

      await notifications.addressFor(destination.id);
      check("so Shopify is asked only once", asked === 1, String(asked));

      shopify.forShop = realForShop;

      await query("UPDATE stores SET email = NULL, is_active = 0 WHERE id = ?", [source.id]);
      const gone = await notifications.addressFor(source.id);
      check("an uninstalled store is skipped, not retried forever",
        gone.email === null && /uninstalled/.test(gone.reason), gone.reason);

      await query("UPDATE stores SET is_active = 1 WHERE id = ?", [source.id]);
      await storeModel.setEmail(source.id, "owner@warehouse.test");
    }

    /* ---------------- sending ---------------- */

    console.log("\nSending");
    {
      const pending = (await outbox(connection.id))
        .filter((row) => row.status === "pending")
        .reverse(); // oldest first, as the round sends them

      check("everything queued so far is waiting", pending.length >= 3,
        String(pending.length));

      // No mail server: skipped and recorded -- not failed, not retried forever.
      mailer.setTransportForTests(null);

      const first = pending[0];
      check("with no mail server it is skipped",
        (await notifications.sendOne(first)) === "skipped");

      const skipped = await emailOutboxModel.findById(first.id);
      check("and the reason is kept", skipped.status === "skipped" &&
        /SMTP/.test(skipped.error || ""), skipped.error);
      check("with the address it would have gone to",
        skipped.to_email === "owner@warehouse.test" ||
          skipped.to_email === "found@frontshop.test",
        skipped.to_email);
      check("a skipped email is not picked up again",
        !(await emailOutboxModel.listPending({ limit: 1000 })).some(
          (row) => row.id === first.id));

      // A working server.
      const delivered = [];
      mailer.setTransportForTests({
        sendMail: async (message) => {
          delivered.push(message);
          return { messageId: "<m1@test>" };
        },
      });

      const second = pending[1];
      check("with a mail server it is sent",
        (await notifications.sendOne(second)) === "sent");

      const sent = await emailOutboxModel.findById(second.id);
      check("marked sent, with when and to whom",
        sent.status === "sent" && Boolean(sent.sent_at) && Boolean(sent.to_email));
      check("the queued subject is what reached the server",
        delivered.length === 1 && delivered[0].subject === second.subject);
      check("from the configured sender",
        delivered[0].from === (process.env.MAIL_FROM || mailer.DEFAULT_FROM));
      check("and it cannot be sent twice",
        (await notifications.sendOne(second)) === "taken" && delivered.length === 1,
        "a second process picking the same row must send nothing");

      // A refusal: retried, then given up on.
      mailer.setTransportForTests({
        sendMail: async () => {
          throw new Error("550 mailbox unavailable");
        },
      });

      const third = pending[2];
      check("a refused send is a failure",
        (await notifications.sendOne(third)) === "failed");

      let row = await emailOutboxModel.findById(third.id);
      check("which goes back in the queue",
        row.status === "pending" && row.attempts === 1 && /550/.test(row.error || ""),
        `${row.status} / ${row.attempts} / ${row.error}`);

      for (let attempt = 1; attempt < notifications.MAX_ATTEMPTS; attempt += 1) {
        await notifications.sendOne(await emailOutboxModel.findById(third.id));
      }

      row = await emailOutboxModel.findById(third.id);
      check("until the attempts run out, then it stops",
        row.status === "failed" && row.attempts === notifications.MAX_ATTEMPTS,
        `${row.status} after ${row.attempts}`);

      mailer.setTransportForTests(undefined);
    }

    /* ---------------- only the destination, only its own ---------------- */

    console.log("\nWho may change the switches");
    {
      const foreign = fakeRes();
      await storeController.postNotifications(
        {
          store: { store_type: "destination" },
          storeId: destination.id,
          body: { connection_id: connection.id + 999999, notifications: {} },
        },
        foreign
      );
      check("another store's connection is refused", foreign.code === 404,
        String(foreign.code));

      const fromSource = fakeRes();
      await storeController.postNotifications(
        {
          store: { store_type: "source" },
          storeId: source.id,
          body: { connection_id: connection.id, notifications: {} },
        },
        fromSource
      );
      check("the source store cannot change them", fromSource.code === 403,
        "the destination decides every email, the source's included");

      const own = fakeRes();
      await storeController.postNotifications(
        {
          store: { store_type: "destination" },
          storeId: destination.id,
          body: {
            connection_id: String(connection.id),
            notifications: { payout_source: false },
          },
        },
        own
      );
      check("the destination can",
        own.code === 200 && own.body.notifications.payout_source === false,
        JSON.stringify(own.body));
    }

    /* ---------------- removing the connection ---------------- */

    console.log("\nRemoving the connection");
    {
      await connectionModel.deleteConnection(connection.id);

      const left = await query(
        `SELECT (SELECT COUNT(*) FROM notification_settings WHERE connection_id = ?) AS settings,
                (SELECT COUNT(*) FROM email_outbox WHERE connection_id = ?) AS queued`,
        [connection.id, connection.id]
      );

      check("its switches go with it", Number(left[0].settings) === 0);
      check("and so does its queue", Number(left[0].queued) === 0,
        "emails about a supplier the destination has removed must not go out");
    }

    await cleanup();
  } catch (err) {
    console.error("\nTest run crashed:", err.stack || err.message);
    failed += 1;
  } finally {
    mailer.setTransportForTests(undefined);
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
