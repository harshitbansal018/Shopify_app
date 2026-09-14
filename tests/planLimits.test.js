/* Plan limits, end to end against the real database.
 *
 * What is guarded here:
 *   - the cards and the enforced limits come from the same columns
 *   - the billing month is counted from the plan's activation
 *   - products and source stores are refused past the limit, all or nothing,
 *     and two requests at once cannot both take the last slot
 *   - orders are never refused, only warned about
 *   - emails stop at the limit, and the destination is told exactly once
 *   - a downgrade waits until the merchant has chosen enough to unsync and
 *     pause, then applies exactly what they chose -- and deletes nothing
 *
 * The store is moved onto a private, inactive test plan with tiny limits, so
 * the limits can be hit with a handful of rows. It never appears on any card.
 */
require("dotenv").config({ quiet: true });

const path = require("path");

const SERVER = path.join(__dirname, "..");

const { pool, query } = require(path.join(SERVER, "config/db"));
const { runMigrations } = require(path.join(SERVER, "config/migrate"));
const storeModel = require(path.join(SERVER, "models/storeModel"));
const connectionModel = require(path.join(SERVER, "models/connectionModel"));
const sourceProductModel = require(path.join(SERVER, "models/sourceProductModel"));
const productMappingModel = require(path.join(SERVER, "models/productMappingModel"));
const orderModel = require(path.join(SERVER, "models/orderModel"));
const orderMappingModel = require(path.join(SERVER, "models/orderMappingModel"));
const planModel = require(path.join(SERVER, "models/planModel"));
const usageModel = require(path.join(SERVER, "models/planUsageModel"));
const emailOutboxModel = require(path.join(SERVER, "models/emailOutboxModel"));
const planLimits = require(path.join(SERVER, "services/planLimits"));
const notifications = require(path.join(SERVER, "services/notifications"));
const productController = require(path.join(SERVER, "controllers/productController"));
const storeController = require(path.join(SERVER, "controllers/storeController"));
const planController = require(path.join(SERVER, "controllers/planController"));
const planStatus = require(path.join(SERVER, "middleware/planStatus"));

const RUN = `pl${Date.now().toString(36)}`;
const TEST_PLAN = `Test plan ${RUN}`;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cleanup() {
  const ids = (
    await query("SELECT id FROM stores WHERE shop_domain LIKE ?", [`${RUN}-%`])
  ).map((row) => row.id);

  if (ids.length) {
    await query("DELETE FROM membership_payments WHERE user_id IN (?)", [ids]);
    await query("DELETE FROM user_memberships WHERE user_id IN (?)", [ids]);
    await query("DELETE FROM stores WHERE id IN (?)", [ids]);
  }

  await query("DELETE FROM plans WHERE name = ?", [TEST_PLAN]);
}

let productNumber = 0;

/** A product the source has offered, waiting on the destination's Unsynced tab. */
async function offer(source, connection) {
  productNumber += 1;

  const product = await sourceProductModel.upsert(source.id, {
    id: 8000 + productNumber,
    title: `Limit Product ${productNumber}`,
    status: "active",
    variants: [{ id: 80000 + productNumber, sku: `LP-${productNumber}`, price: "5.00" }],
  });

  return productMappingModel.ensure({
    connectionId: connection.id,
    sourceProductId: product.id,
    sourceShopifyProductId: product.shopify_product_id,
  });
}

let orderNumber = 0;

/** A destination sale routed to a supplier. */
async function sale(destination, connection, { test = false } = {}) {
  orderNumber += 1;

  const payload = {
    id: 9000 + orderNumber,
    order_number: 4000 + orderNumber,
    name: `#${4000 + orderNumber}`,
    currency: "USD",
    subtotal_price: "10.00",
    total_price: "10.00",
    financial_status: "paid",
    fulfillment_status: null,
    test,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    line_items: [],
  };

  await orderModel.upsert(destination.id, payload);
  const order = await orderModel.findByShopifyId(destination.id, payload.id);

  // Set directly as well, so the test does not depend on how the cache maps it.
  if (test) await query("UPDATE orders SET test = 1 WHERE id = ?", [order.id]);

  const mapping = await orderMappingModel.claim(connection.id, order.id, {
    sourceTotal: 8,
    destinationTotal: 10,
    currency: "USD",
    lineCount: 1,
  });

  return { order, mapping };
}

(async () => {
  try {
    await runMigrations();
    await cleanup();

    const destination = await storeModel.upsertStore({
      shop_domain: `${RUN}-dest.myshopify.com`,
      access_token: "shpat_dest_token",
      store_name: "Front Shop",
    });
    await storeModel.chooseStoreType(destination.id, "destination");

    const source = await storeModel.upsertStore({
      shop_domain: `${RUN}-src.myshopify.com`,
      access_token: "shpat_src_token",
      store_name: "Warehouse",
    });
    await storeModel.chooseStoreType(source.id, "source");

    const second = await storeModel.upsertStore({
      shop_domain: `${RUN}-src2.myshopify.com`,
      access_token: "shpat_src2_token",
      store_name: "Second Supplier",
    });
    await storeModel.chooseStoreType(second.id, "source");

    // Pairing has its own suite; here the stores are simply grouped.
    await query("UPDATE stores SET store_group_id = ? WHERE id IN (?, ?, ?)", [
      `${RUN}-group`,
      destination.id,
      source.id,
      second.id,
    ]);

    const link = await connectionModel.createConnection({
      sourceStoreId: source.id,
      destinationStoreId: destination.id,
    });

    // The session hands controllers the store row as it is now.
    const dest = () => storeModel.findById(destination.id);

    /* ---------------- the cards and the columns ---------------- */

    console.log("\nCard lines are written from the limit columns");
    {
      const lines = planModel.featureLines({
        max_limit: 1000,
        max_orders: null,
        max_emails: 5000,
        max_sources: 1,
        plan_content: JSON.stringify(["Priority support"]),
      });

      check("products", lines[0] === "Up to 1,000 synced products", lines[0]);
      check("an empty column reads Unlimited", lines[1] === "Unlimited orders", lines[1]);
      check("emails", lines[2] === "Up to 5,000 emails / month", lines[2]);
      check("one source store reads naturally", lines[3] === "1 source store", lines[3]);
      check("then the extras", lines[4] === "Priority support" && lines.length === 5);
      check("a column the row does not have adds no line",
        planModel.featureLines({ plan_content: '["Only this"]' }).length === 1);

      const seeded = await query("SELECT * FROM plans WHERE is_active = 1");
      const free = await planModel.findFree();

      check("there is a free plan for stores that never chose one", Boolean(free));
      check("the free plan has limits",
        Object.values(planModel.limitsOf(free)).every((value) => Number.isFinite(value)),
        JSON.stringify(planModel.limitsOf(free)));
      check("no plan uses 9999 to mean unlimited",
        seeded.every((plan) =>
          Object.values(planModel.limitsOf(plan)).every((value) => value !== 9999)),
        "9999 is a real limit; unlimited is empty");
      check("the limits are not typed into the card text",
        seeded.every((plan) => !planModel.extraLines(plan).some((line) =>
          /synced products|orders \/|emails \/|source store/i.test(line))),
        "the card would say one number and the app enforce another");
    }

    /* ---------------- the billing month ---------------- */

    console.log("\nThe billing month");
    {
      const DAY = 24 * 60 * 60 * 1000;
      const anchor = new Date("2026-01-01T00:00:00Z");

      const first = planLimits.billingPeriod(anchor, new Date("2026-01-15T00:00:00Z"));
      check("the first month starts on the activation day",
        first.start.getTime() === anchor.getTime());
      check("and lasts 30 days, like Shopify's billing",
        first.end.getTime() - first.start.getTime() === 30 * DAY);

      const later = planLimits.billingPeriod(anchor, new Date("2026-02-05T00:00:00Z"));
      check("the next one starts 30 days later",
        later.start.getTime() === anchor.getTime() + 30 * DAY, later.start.toISOString());

      const boundary = planLimits.billingPeriod(anchor, new Date(anchor.getTime() + 30 * DAY));
      check("the boundary belongs to the new month",
        boundary.start.getTime() === anchor.getTime() + 30 * DAY);

      const now = new Date("2026-03-01T00:00:00Z");
      const skewed = planLimits.billingPeriod(new Date(now.getTime() + 1000), now);
      check("an anchor a second in the future still contains now",
        skewed.start <= now && now < skewed.end);

      check("unlimited is never a warning", planLimits.stateOf(5000, null) === "ok");
      check("under 80% is fine", planLimits.stateOf(7, 10) === "ok");
      check("80% is a warning", planLimits.stateOf(8, 10) === "near");
      check("at the limit is full", planLimits.stateOf(10, 10) === "full");
      check("past it is over", planLimits.stateOf(11, 10) === "over");
    }

    /* ---------------- no plan chosen ---------------- */

    console.log("\nA store with no plan is on Free");
    {
      const snap = await planLimits.snapshot(await dest());

      check("it is on the free plan", snap.plan && snap.plan.price === 0, snap.plan && snap.plan.name);
      check("and knows it never chose one", snap.chosen === false);
      check("with the free plan's limits",
        snap.limits.products === planModel.limitsOf(await planModel.findFree()).products);
      check("and its usage counted",
        snap.usage.sources === 1 && snap.usage.products === 0, JSON.stringify(snap.usage));
    }

    /* ---------------- onto a small test plan ---------------- */

    await query(
      `INSERT INTO plans
        (name, price, is_popular, is_active, created_at, updated_at, days, status,
         plan_for, plan_content, max_limit, max_orders, max_emails, max_sources)
       VALUES (?, 1, 0, 0, NOW(), NOW(), 30, 1, 1, '[]', 3, 5, 3, 2)`,
      [TEST_PLAN]
    );

    const [testPlan] = await query("SELECT * FROM plans WHERE name = ?", [TEST_PLAN]);

    await query(
      `INSERT INTO user_memberships (user_id, membership_id, status, created_at, updated_at)
       VALUES (?, ?, 1, NOW(), NOW())`,
      [destination.id, testPlan.id]
    );

    const setLimit = (column, value) =>
      query(`UPDATE plans SET ${column} = ? WHERE name = ?`, [value, TEST_PLAN]);

    /* ---------------- products: hard, all or nothing ---------------- */

    console.log("\nProducts: a hard limit, all or nothing");
    const offered = [];
    {
      for (let i = 0; i < 5; i += 1) offered.push(await offer(source, link));

      const store = await dest();

      const tooMany = await planLimits.acceptProducts(store, offered.map((m) => m.id));
      check("five into a plan of three is refused",
        tooMany.refused === true && tooMany.accepted === 0);
      check("and says how much room there is",
        tooMany.remaining === 3 && /add 3 more/.test(tooMany.message) &&
          /you picked 5/.test(tooMany.message),
        tooMany.message);
      check("none of them went in",
        (await usageModel.countProducts(destination.id)) === 0,
        "a partial accept leaves the merchant guessing which made it");

      const three = await planLimits.acceptProducts(store, offered.slice(0, 3).map((m) => m.id));
      check("three fit", three.accepted === 3, JSON.stringify(three));

      const fourth = await planLimits.acceptProducts(store, [offered[3].id]);
      check("the fourth is refused", fourth.refused === true && fourth.remaining === 0);
      check("and the message says the store is full",
        /already has 3/.test(fourth.message), fourth.message);

      const again = await planLimits.acceptProducts(store, [offered[0].id]);
      check("an already-accepted product takes no second slot",
        !again.refused && again.accepted === 0);

      // Through the real handler: the merchant sees the reason.
      const res = fakeRes();
      await productController.postAccept(
        { store, storeId: store.id, shop: store.shop_domain, body: { mapping_ids: [offered[3].id] } },
        res
      );
      check("the Sync button gets a 409 with the reason",
        res.code === 409 && /plan allows 3 products/.test(res.body.error),
        `${res.code} ${res.body && res.body.error}`);

      // Two requests for the last slot at the same moment.
      await productMappingModel.declineForDestination(destination.id, [offered[0].id]);

      const [a, b] = await Promise.all([
        planLimits.acceptProducts(store, [offered[3].id]),
        planLimits.acceptProducts(store, [offered[4].id]),
      ]);

      check("two tabs cannot both take the last slot",
        a.accepted + b.accepted === 1 && Boolean(a.refused || b.refused),
        JSON.stringify([a.accepted, b.accepted]));
      check("so the store ends exactly at its limit",
        (await usageModel.countProducts(destination.id)) === 3);
    }

    /* ---------------- source stores: hard ---------------- */

    console.log("\nSource stores: a hard limit");
    let link2;
    {
      const store = await dest();

      check("one active store fits a plan of two", (await planLimits.sourceRoom(store)).ok === true);

      link2 = await connectionModel.createConnection({
        sourceStoreId: second.id,
        destinationStoreId: destination.id,
      });

      const full = await planLimits.sourceRoom(store);
      check("a third is refused",
        full.ok === false && /allows 2 source stores/.test(full.message), full.message);

      const connect = fakeRes();
      await storeController.postConnect(
        { store, storeId: store.id, shop: store.shop_domain, body: { code: "ABCD-2345" } },
        connect
      );
      check("Add store says why -- before the code is spent",
        connect.code === 409 && /allows 2 source stores/.test(connect.body.error),
        `${connect.code} ${JSON.stringify(connect.body)}`);

      await query("UPDATE store_connections SET status = 'paused' WHERE id = ?", [link2.id]);
      check("a paused store frees the slot", (await planLimits.sourceRoom(store)).ok === true);

      await setLimit("max_sources", 1);

      const refused = await planLimits.resumeSource(store, link2.id);
      check("resuming past the limit is refused",
        refused.refused === true && /1 source store active at a time/.test(refused.message),
        refused.message);

      const resumeRes = fakeRes();
      await storeController.postResumeStore(
        { store, storeId: store.id, params: { id: String(link2.id) }, body: {} },
        resumeRes
      );
      check("and the Resume button gets a 409", resumeRes.code === 409);

      await setLimit("max_sources", 2);

      const resumed = await planLimits.resumeSource(store, link2.id);
      check("with room, it resumes", resumed.resumed === 1, JSON.stringify(resumed));
      check("and is active again", (await connectionModel.findById(link2.id)).status === "active");

      const unknown = fakeRes();
      await storeController.postResumeStore(
        { store, storeId: store.id, params: { id: "99999999" }, body: {} },
        unknown
      );
      check("another store's connection is not found", unknown.code === 404);
    }

    /* ---------------- orders: soft ---------------- */

    console.log("\nOrders: warned about, never refused");
    const sales = [];
    {
      for (let i = 0; i < 4; i += 1) sales.push(await sale(destination, link));

      await sale(destination, link, { test: true });

      // One sale that reached two suppliers is still one order.
      await orderMappingModel.claim(link2.id, sales[0].order.id, {
        sourceTotal: 1,
        destinationTotal: 2,
        currency: "USD",
        lineCount: 1,
      });

      let snap = await planLimits.snapshot(await dest());
      check("four real orders count as four",
        snap.usage.orders === 4,
        `${snap.usage.orders} -- test orders and a second supplier must not add to it`);
      check("80% of the plan is a warning", snap.state.orders === "near");
      check("which the banner shows",
        planLimits.bannerItems(snap).some((item) => item.key === "orders" && item.level === "warn"));

      sales.push(await sale(destination, link));
      sales.push(await sale(destination, link));

      snap = await planLimits.snapshot(await dest());
      check("past the limit the sale still reaches the supplier",
        snap.usage.orders === 6 && Boolean(sales[5].mapping && sales[5].mapping.id),
        String(snap.usage.orders));

      const orderItem = planLimits.bannerItems(snap).find((item) => item.key === "orders");
      check("and it is still only a warning",
        orderItem && orderItem.level === "warn" &&
          /still go to your source stores/.test(orderItem.text),
        orderItem && orderItem.text);
    }

    /* ---------------- emails: hard, told once ---------------- */

    console.log("\nEmails: stopped at the limit, and the destination told once");
    {
      const results = [];
      for (let i = 0; i < 5; i += 1) results.push(await notifications.orderCreated(sales[i].mapping));

      check("the plan's three go out",
        results.slice(0, 3).every((result) => result.queued === 1), JSON.stringify(results));
      check("the fourth and fifth do not",
        results[3].queued === 0 && results[4].queued === 0);

      const rows = await emailOutboxModel.listForConnection(link.id, { limit: 100 });
      const held = rows.filter((row) => row.kind === "order_created" && row.status === "skipped");

      check("they are recorded as skipped, with the reason",
        held.length === 2 &&
          held.every((row) => /Plan email limit reached: 3 of 3/.test(row.error || "")),
        JSON.stringify(held.map((row) => row.error)));

      const notices = rows.filter((row) => row.kind === "plan_notice");
      check("the destination is told -- once", notices.length === 1, String(notices.length));
      check("in its own inbox",
        notices[0] && notices[0].recipient_store_id === destination.id);
      check("saying its emails are paused",
        notices[0] && /paused/.test(notices[0].subject), notices[0] && notices[0].subject);

      const snap = await planLimits.snapshot(await dest());
      check("the notice does not count against the plan",
        snap.usage.emails === 3, String(snap.usage.emails));

      const emailItem = planLimits.bannerItems(snap).find((item) => item.key === "emails");
      check("and the banner says emails are paused",
        emailItem && emailItem.level === "error" && /paused/.test(emailItem.text));
    }

    /* ---------------- the banner middleware ---------------- */

    console.log("\nThe banner reaches every destination screen");
    {
      let rendered = null;
      const res = { render(view, locals) { rendered = { view, locals }; } };

      planStatus({ store: await dest() }, res, () => {});
      res.render("destination/dashboard", { title: "x" });

      for (let i = 0; i < 100 && !rendered; i += 1) await sleep(20);

      check("a destination screen is given the plan status",
        rendered && rendered.locals.planStatus &&
          rendered.locals.planStatus.plan.name === TEST_PLAN);
      check("and the banner items",
        rendered && Array.isArray(rendered.locals.planBanner) &&
          rendered.locals.planBanner.length > 0);
      check("without losing its own locals", rendered && rendered.locals.title === "x");

      let sourceRendered = null;
      const sourceRes = { render(view, locals) { sourceRendered = { view, locals }; } };

      planStatus({ store: await storeModel.findById(source.id) }, sourceRes, () => {});
      sourceRes.render("source/dashboard", { title: "y" });

      check("a source store's screen is left alone",
        sourceRendered && !("planStatus" in sourceRendered.locals));

      let reused = null;
      const reuseRes = { render(view, locals) { reused = locals; } };

      planStatus({ store: await dest() }, reuseRes, () => {});
      reuseRes.render("destination/plans", {
        planStatus: { plan: { name: "Given" }, period: { end: new Date() }, usage: {}, limits: {}, state: {} },
      });

      check("a screen that already counted is not counted again",
        reused && reused.planStatus.plan.name === "Given" && Array.isArray(reused.planBanner));
    }

    /* ---------------- downgrading ---------------- */

    console.log("\nDowngrading");
    {
      const free = await planModel.findFree();
      const freeLimits = planModel.limitsOf(free);

      // More products than Free allows, and two active source stores to its one.
      await setLimit("max_limit", freeLimits.products + 10);

      const want = freeLimits.products + 2;
      let guard = 0;

      while ((await usageModel.countProducts(destination.id)) < want && guard < 50) {
        guard += 1;
        const mapping = await offer(source, link);
        await planLimits.acceptProducts(await dest(), [mapping.id]);
      }

      const store = await dest();

      const first = fakeRes();
      await planController.postSelectPlan(
        { store, storeId: store.id, shop: store.shop_domain, body: { plan_id: free.id } },
        first
      );

      check("a downgrade the store does not fit is held back",
        first.code === 409, `${first.code} ${JSON.stringify(first.body).slice(0, 200)}`);

      const options = first.body.downgrade;

      check("it says how many products must go",
        options.products.excess === 2, JSON.stringify(options.products.excess));
      check("and offers every product in the store to choose from",
        options.products.items.length === want, String(options.products.items.length));
      check("and how many stores must pause",
        options.sources.excess === 1 && options.sources.items.length === 2);
      check("the reason is spelled out",
        new RegExp(`allows ${freeLimits.products} products \\(you have ${want}\\)`).test(first.body.error),
        first.body.error);
      check("nothing has changed yet",
        (await usageModel.countProducts(destination.id)) === want &&
          (await usageModel.countSources(destination.id)) === 2);

      const short = fakeRes();
      await planController.postSelectPlan(
        {
          store,
          storeId: store.id,
          shop: store.shop_domain,
          body: { plan_id: free.id, unsync_mapping_ids: [options.products.items[0].id] },
        },
        short
      );
      check("too few choices are refused",
        short.code === 409 &&
          /Choose 1 more product to unsync and 1 more store to pause/.test(short.body.error),
        short.body.error);
      check("and apply nothing at all",
        (await usageModel.countProducts(destination.id)) === want);

      const foreign = fakeRes();
      await planController.postSelectPlan(
        {
          store,
          storeId: store.id,
          shop: store.shop_domain,
          body: {
            plan_id: free.id,
            unsync_mapping_ids: [99999998, 99999999],
            pause_connection_ids: [99999999],
          },
        },
        foreign
      );
      check("ids from somewhere else count for nothing",
        foreign.code === 409 && (await usageModel.countProducts(destination.id)) === want);

      // So the new billing month starts strictly after this test's orders and
      // emails -- NOW() only has whole seconds.
      await sleep(1100);

      const chosen = options.products.items.slice(0, 2).map((item) => item.id);
      const toPause = options.sources.items.find((item) => item.id === link2.id);

      const done = fakeRes();
      await planController.postSelectPlan(
        {
          store,
          storeId: store.id,
          shop: store.shop_domain,
          body: { plan_id: free.id, unsync_mapping_ids: chosen, pause_connection_ids: [toPause.id] },
        },
        done
      );

      check("with enough chosen, the plan changes",
        done.code === 200 && done.body.ok && done.body.active,
        `${done.code} ${JSON.stringify(done.body)}`);

      const after = await planLimits.snapshot(await dest());

      check("the store is on the free plan now",
        after.plan.id === free.id && after.chosen === true);
      check("exactly the chosen products were unsynced",
        after.usage.products === freeLimits.products, String(after.usage.products));

      const unsynced = await query(
        "SELECT accepted_at, sync_status FROM product_mappings WHERE id IN (?)",
        [chosen]
      );
      check("they are unsynced, not deleted",
        unsynced.length === 2 &&
          unsynced.every((row) => row.accepted_at === null && row.sync_status === "skipped"));
      check("the chosen store is paused, not removed",
        (await connectionModel.findById(toPause.id)).status === "paused");
      check("the store fits its new plan",
        after.state.products !== "over" && after.state.sources !== "over",
        JSON.stringify(after.state));
      check("a new plan starts a new billing month",
        after.usage.orders === 0 && after.usage.emails === 0, JSON.stringify(after.usage));
      check("so the banner has nothing to say",
        planLimits.bannerItems(after).length === 0,
        JSON.stringify(planLimits.bannerItems(after)));

      const upgrade = await planLimits.fitCheck(await dest(), {
        max_limit: null,
        max_sources: null,
      });
      check("an upgrade always fits", upgrade.fits === true);
    }

    await cleanup();
  } catch (err) {
    console.error("\nTest run crashed:", err.stack || err.message);
    failed += 1;
  } finally {
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
