/* What the destination earned, and what it still owes its suppliers.
 *
 * Run against the real database. The whole feature is one aggregate over
 * order_mappings minus another over payouts, and an aggregate that compiles in
 * JavaScript proves nothing about whether MariaDB will group it the same way.
 *
 * The rule under test throughout: a supplier is paid for what it SHIPPED. A
 * sale it has not picked yet is not a debt, and one it cancelled was refunded
 * to the shopper and earned nobody anything.
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

const RUN = `po${Date.now().toString(36)}`;

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

/** One cached sale, and the mapping that says which supplier it came from. */
async function sale(destinationStoreId, connectionId, shopifyId, paid, cost) {
  await orderModel.upsert(destinationStoreId, {
    id: shopifyId,
    name: `#${shopifyId}`,
    currency: "USD",
    total_price: String(paid),
    financial_status: "paid",
    test: false,
    created_at: "2026-09-01T10:00:00Z",
  });

  const order = await orderModel.findByShopifyId(destinationStoreId, shopifyId);

  return orderMappingModel.claim(connectionId, order.id, {
    destinationTotal: paid,
    sourceTotal: cost,
    currency: "USD",
    lineCount: 1,
  });
}

(async () => {
  try {
    await runMigrations();
    await cleanup();

    const source = await storeModel.upsertStore({
      shop_domain: `${RUN}-source.myshopify.com`,
      access_token: "shpat_source",
      store_name: "Warehouse",
      currency: "USD",
    });
    await storeModel.chooseStoreType(source.id, "source");

    const destination = await storeModel.upsertStore({
      shop_domain: `${RUN}-dest.myshopify.com`,
      access_token: "shpat_dest",
      store_name: "Front Shop",
      currency: "USD",
    });
    await storeModel.chooseStoreType(destination.id, "destination");

    await query("UPDATE stores SET store_group_id = ? WHERE id IN (?, ?)", [
      `${RUN}-group`,
      source.id,
      destination.id,
    ]);

    const connection = await connectionModel.createConnection({
      sourceStoreId: source.id,
      destinationStoreId: destination.id,
    });

    /* ---------------- a connection with nothing sold ---------------- */

    console.log("\nA supplier with no sales");
    {
      const rows = await payoutModel.summaryForDestination(destination.id);

      check("is still listed",
        rows.length === 1 &&
          rows[0].connection_id === connection.id,
        "leaving it out would read as a broken connection");
      check("with zeros rather than nulls",
        rows[0].revenue === 0 && rows[0].cost === 0 &&
          rows[0].profit === 0 && rows[0].outstanding === 0,
        "a null reaches the page as NaN");
      check("and no NaN in the derived figures",
        Number.isFinite(rows[0].profit) && Number.isFinite(rows[0].outstanding));
    }

    /* ---------------- only shipped sales are owed ---------------- */

    console.log("\nWhat counts towards the bill");
    {
      // Paid 125.00, cost 100.00 -> 25.00 profit. Shipped, so it is owed.
      const shipped = await sale(destination.id, connection.id, 910001, 125, 100);
      await orderMappingModel.markFulfilled(shipped.id, []);

      // Not picked yet: real money coming, but not a debt today.
      await sale(destination.id, connection.id, 910002, 60, 50);

      // Cancelled: the shopper was refunded, so it earned nothing.
      const dead = await sale(destination.id, connection.id, 910003, 200, 150);
      await orderMappingModel.markCancelledBySource(dead.id, "out of stock");

      const [row] = await payoutModel.summaryForDestination(destination.id);

      check("only the fulfilled sale is counted",
        row.fulfilled_orders === 1 && row.revenue === 125 && row.cost === 100);
      check("profit is revenue minus cost", row.profit === 25);
      check("an unshipped sale is shown separately, not billed",
        row.open_orders === 1 && row.upcoming_cost === 50,
        "a supplier is paid for what it shipped");
      check("and a cancelled one is counted but not billed",
        row.cancelled_orders === 1 && row.revenue === 125,
        "the shopper was refunded, so it earned nobody anything");
      check("the whole cost is outstanding before anything is paid",
        row.outstanding === 100);
    }

    /* ---------------- paying it ---------------- */

    console.log("\nRecording payments");
    {
      const first = await payoutModel.record(connection.id, {
        amount: 40,
        currency: "USD",
        reference: "BANK-1",
        paidAt: "2026-09-02",
      });

      let [row] = await payoutModel.summaryForDestination(destination.id);

      check("a payment reduces what is owed",
        row.paid === 40 && row.outstanding === 60);
      check("and is counted", row.payments === 1);
      check("but never touches the profit",
        row.profit === 25,
        "paying a supplier is settling a debt, not losing a margin");

      await payoutModel.record(connection.id, { amount: 60, currency: "USD" });

      [row] = await payoutModel.summaryForDestination(destination.id);

      check("paying the rest settles it", row.outstanding === 0);

      await payoutModel.record(connection.id, { amount: 25, currency: "USD" });

      [row] = await payoutModel.summaryForDestination(destination.id);

      check("overpaying shows as credit, not zero",
        row.outstanding === -25,
        "hiding it behind a floor would lose real money");

      /* ---- what a payment may not be ---- */
      let refused = false;
      try {
        await payoutModel.record(connection.id, { amount: 0 });
      } catch (err) {
        refused = /greater than zero/.test(err.message);
      }
      check("a zero payment is refused", refused);

      refused = false;
      try {
        await payoutModel.record(connection.id, { amount: -10 });
      } catch (err) {
        refused = true;
      }
      check("and so is a negative one",
        refused,
        "that would be a refund, which this does not model");

      /* ---- undoing one ---- */
      const payments = await payoutModel.listForConnection(connection.id);

      check("payments come back newest first",
        payments.length === 3 && Number(payments[0].amount) === 25,
        "the one just recorded is the one most likely to be wrong");
      check("with the reference kept",
        payments.some((p) => p.reference === "BANK-1"));

      await payoutModel.remove(first);

      [row] = await payoutModel.summaryForDestination(destination.id);

      check("deleting a payment puts it back on the bill",
        row.paid === 85 && row.outstanding === 15);
    }

    /* ---------------- the same money, from the source's end ---------------- */

    console.log("\nThe supplier's own view");
    {
      const [buyer] = await payoutModel.summaryForSource(source.id);
      const [dest] = await payoutModel.summaryForDestination(destination.id);

      check("the supplier sees its buyer", buyer.connection_id === connection.id);
      check("what it earned is what the buyer is charged",
        buyer.earned === dest.cost,
        "two screens disagreeing about one number is the whole risk here");
      check("received matches what the buyer recorded paying",
        buyer.received === dest.paid);
      check("and so does the balance", buyer.outstanding === dest.outstanding);
      check("with the same order counts",
        buyer.fulfilled_orders === dest.fulfilled_orders &&
          buyer.open_orders === dest.open_orders);
      check("and the same work still to come",
        buyer.upcoming === dest.upcoming_cost);

      // The retail price, and therefore the buyer's margin, is not the
      // supplier's business -- so it is not in the row at all.
      check("the supplier is told nothing about the retail price",
        buyer.revenue === undefined && buyer.profit === undefined,
        "a field that exists gets rendered by somebody eventually");
    }

    /* ---------------- one merchant's money is their own ---------------- */

    console.log("\nScoping");
    {
      const other = await storeModel.upsertStore({
        shop_domain: `${RUN}-other.myshopify.com`,
        access_token: "shpat_other",
        store_name: "Someone Else",
        currency: "USD",
      });
      await storeModel.chooseStoreType(other.id, "destination");

      check("another destination sees none of it",
        (await payoutModel.summaryForDestination(other.id)).length === 0,
        "the summary must be scoped by the store, not just filtered on screen");
      check("and neither does another source",
        (await payoutModel.summaryForSource(other.id)).length === 0);

      const payment = await payoutModel.findById(
        (await payoutModel.listForConnection(connection.id))[0].id
      );

      check("a payment carries the store that owns it",
        payment.destination_store_id === destination.id,
        "the delete handler proves ownership from this, not from the URL");
    }

    /* ---------------- the sale goes away ---------------- */

    console.log("\nCascades");
    {
      const before = await query(
        "SELECT COUNT(*) AS n FROM payouts WHERE connection_id = ?",
        [connection.id]
      );
      check("payments exist before the store is deleted",
        Number(before[0].n) > 0);

      await storeModel.deleteStore(`${RUN}-dest.myshopify.com`);

      const after = await query(
        "SELECT COUNT(*) AS n FROM payouts WHERE connection_id = ?",
        [connection.id]
      );
      check("removing a store takes its payment records",
        Number(after[0].n) === 0);
    }
  } catch (err) {
    check("suite ran", false, err.message);
    console.error(err);
  } finally {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    await pool.end();
    process.exitCode = failed ? 1 : 0;
  }
})();
