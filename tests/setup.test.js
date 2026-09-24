/* The setup screen's progress, walked through against the real database.
 *
 * Nothing about a step is stored, so the only thing worth testing is the
 * reading: does each step turn itself on when the merchant does the work, and
 * back off when they undo it. Fixtures would prove nothing -- the answers come
 * out of joins across five tables.
 *
 * The step that matters most is the supplier's "Connect a buyer". Pairing
 * clears stores.pairing_code the moment a code is used, and a code dies after
 * fifteen minutes, so anything reading success from that column would say
 * "done" while the code was dead and "not done" at the instant it worked.
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
const syncSettingsModel = require(path.join(SERVER, "models/syncSettingsModel"));
const setupController = require(path.join(SERVER, "controllers/setupController"));

const RUN = `su${Date.now().toString(36)}`;

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

/** The state of one step by key, for readable assertions. */
function stateOf(status, key) {
  const step = status.steps.find((s) => s.key === key);
  return step ? step.state : "missing";
}

(async () => {
  try {
    await runMigrations();
    await cleanup();

    const source = await storeModel.upsertStore({
      shop_domain: `${RUN}-source.myshopify.com`,
      access_token: "t",
      store_name: "Warehouse",
      currency: "USD",
    });
    await storeModel.chooseStoreType(source.id, "source");

    const destination = await storeModel.upsertStore({
      shop_domain: `${RUN}-dest.myshopify.com`,
      access_token: "t",
      store_name: "Urban Threads",
      currency: "USD",
    });
    await storeModel.chooseStoreType(destination.id, "destination");

    const asSource = () => setupController.statusFor({ ...source, store_type: "source" });
    const asDest = () =>
      setupController.statusFor({ ...destination, store_type: "destination" });

    /* ---------------- a brand new supplier ---------------- */

    console.log("A supplier that has just picked its side");
    {
      const status = await asSource();

      check("three steps, none of them done", status.total === 3 && status.done === 0);
      check("adding products is first, and can be done now",
        status.steps[0].key === "products" && stateOf(status, "products") === "ready",
        "it is the only step that depends on nobody else");
      check("connecting a buyer is offered too",
        stateOf(status, "connect") === "ready");
      check("but sharing is locked until someone is connected",
        stateOf(status, "share") === "locked",
        "there is nobody to share with");
      check("and setup is not complete", !status.complete);
    }

    /* ---------------- it adds products ---------------- */

    console.log("\nIt stages some products");
    const product = await sourceProductModel.upsert(source.id, {
      id: 700001,
      title: "Blue Shirt",
      status: "active",
      variants: [{ id: 710001, title: "S", sku: "B-S", price: "10.00" }],
    });
    {
      const status = await asSource();

      check("the first step ticks itself", stateOf(status, "products") === "done");
      check("and says how many", /1 product\b/.test(status.steps[0].detail || ""),
        status.steps[0].detail);
      check("1 of 3", status.done === 1);
    }

    /* ---------------- a code is generated, and dies ---------------- */

    console.log("\nIt generates a pairing code");
    {
      await query(
        "UPDATE stores SET pairing_code = ?, pairing_code_expires_at = ? WHERE id = ?",
        ["ABCD-1234", new Date(Date.now() + 10 * 60 * 1000), source.id]
      );

      const status = await asSource();
      const step = status.steps.find((s) => s.key === "connect");

      check("connecting is now waiting, NOT done",
        stateOf(status, "connect") === "waiting",
        "a code in somebody's hand is not a connection");
      check("still 1 of 3", status.done === 1,
        "generating a code is not an achievement on its own");
      check("the code is shown so it can be read out",
        step.code && step.code.code === "ABCD-1234");
      check("with the moment it dies", step.code.expiresAt instanceof Date);
      check("and it is not expired yet", step.code.expired === false);
    }

    console.log("\nThe code expires before anyone uses it");
    {
      await query(
        "UPDATE stores SET pairing_code_expires_at = ? WHERE id = ?",
        [new Date(Date.now() - 60 * 1000), source.id]
      );

      const status = await asSource();
      const step = status.steps.find((s) => s.key === "connect");

      check("the step says so instead of claiming success",
        step.code.expired === true && stateOf(status, "connect") === "ready",
        "the old screen would have sat on Done while the code was dead");
      check("and it is still not counted", status.done === 1);
    }

    /* ---------------- the buyer connects ---------------- */

    console.log("\nThe buyer enters the code");
    await query("UPDATE stores SET store_group_id = ? WHERE id IN (?, ?)", [
      `${RUN}-group`,
      source.id,
      destination.id,
    ]);
    const connection = await connectionModel.createConnection({
      sourceStoreId: source.id,
      destinationStoreId: destination.id,
    });
    // Pairing clears the code once it is used -- the exact moment the old
    // rule would have turned the tick OFF.
    await query(
      "UPDATE stores SET pairing_code = NULL, pairing_code_expires_at = NULL WHERE id = ?",
      [source.id]
    );
    {
      const status = await asSource();

      check("NOW it is done, with the code column already emptied",
        stateOf(status, "connect") === "done",
        "this is the case the column-based rule got backwards");
      check("and it names who connected",
        /Urban Threads/.test(status.steps[1].detail || ""), status.steps[1].detail);
      check("sharing unlocks", stateOf(status, "share") === "ready");
      check("2 of 3", status.done === 2);
    }

    /* ---------------- the buyer's own side ---------------- */

    console.log("\nThe buyer's side of the same moment");
    {
      const status = await asDest();

      check("connecting is done", stateOf(status, "connect") === "done");
      check("settings unlock", stateOf(status, "settings") === "ready");
      check("but accepting waits on the supplier, it is not locked",
        stateOf(status, "accept") === "waiting",
        "nothing has been offered yet, and that is not the buyer's fault");
      check("1 of 3", status.done === 1);
    }

    /* ---------------- settings ---------------- */

    console.log("\nThe buyer saves its settings");
    {
      const before = await asDest();
      check("untouched defaults do not count as a choice",
        stateOf(before, "settings") === "ready",
        "every default is also a setting somebody might mean to pick");

      await syncSettingsModel.save(connection.id, { price_markup_percent: 40 });

      const after = await asDest();
      check("saving once is what ticks it", stateOf(after, "settings") === "done");
      check("2 of 3", after.done === 2);
    }

    /* ---------------- sharing and accepting ---------------- */

    console.log("\nThe supplier shares, the buyer accepts");
    const mapping = await productMappingModel.ensure({
      connectionId: connection.id,
      sourceProductId: product.id,
      sourceShopifyProductId: 700001,
    });
    {
      const supplier = await asSource();
      check("the supplier is finished", supplier.complete && supplier.done === 3);

      const buyer = await asDest();
      check("and the buyer's last step is now its own to do",
        stateOf(buyer, "accept") === "ready",
        "something has been offered, so it is no longer waiting");
      check("still 2 of 3 until they accept", buyer.done === 2);

      await query("UPDATE product_mappings SET accepted_at = NOW() WHERE id = ?", [
        mapping.id,
      ]);

      const accepted = await asDest();
      check("accepting finishes it", accepted.complete && accepted.done === 3);
    }

    /* ---------------- undoing it ---------------- */

    console.log("\nUndoing the work takes the ticks back");
    {
      await query("DELETE FROM source_products WHERE id = ?", [product.id]);

      const status = await asSource();

      check("a supplier that deleted its products is not set up any more",
        stateOf(status, "products") === "ready" && !status.complete,
        "a stored tick would still be claiming it was done");
      check("and sharing went with it", stateOf(status, "share") !== "done");
    }

    /* ---------------- what the column is for ---------------- */

    console.log("\nonboarded_at is about the redirect, not about progress");
    {
      await storeModel.markOnboarded(source.id);
      const first = await storeModel.findById(source.id);

      check("skipping records the moment", Boolean(first.onboarded_at));

      const status = await asSource();
      check("but the steps still read as unfinished", !status.complete,
        "the banner has to keep telling the truth after a skip");

      await new Promise((resolve) => setTimeout(resolve, 1100));
      await storeModel.markOnboarded(source.id);
      const again = await storeModel.findById(source.id);

      check("and marking it twice does not move the date",
        new Date(again.onboarded_at).getTime() === new Date(first.onboarded_at).getTime(),
        "when a store got going is written once");
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
