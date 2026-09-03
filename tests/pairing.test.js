/* Store pairing: the check that decides which stores can see each other.
 *
 * Runs against the real database. Everything is namespaced by run id and
 * deleted at the end.
 */
require("dotenv").config({ quiet: true });

const path = require("path");

const SERVER = path.join(__dirname, "..");

const { pool, query } = require(path.join(SERVER, "config/db"));
const { runMigrations } = require(path.join(SERVER, "config/migrate"));
const storeModel = require(path.join(SERVER, "models/storeModel"));
const connectionModel = require(path.join(SERVER, "models/connectionModel"));
const pairing = require(path.join(SERVER, "services/pairing"));

const RUN = `p${Date.now().toString(36)}`;
const domain = (name) => `${RUN}-${name}.myshopify.com`;

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

async function expectRejection(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

async function cleanup() {
  await query("DELETE FROM stores WHERE shop_domain LIKE ?", [`${RUN}-%`]);
}

async function makeStore(name) {
  return storeModel.upsertStore({
    shop_domain: domain(name),
    store_name: name,
    access_token: `shpat_${name}`,
  });
}

(async () => {
  await runMigrations();
  await cleanup();

  console.log("\nEvery install starts isolated");
  let mine1 = await makeStore("warehouse");
  let mine2 = await makeStore("retail");
  const stranger = await makeStore("stranger");
  {
    check("a new store gets a group id", Boolean(mine1.store_group_id));
    check("two installs are NOT in the same group",
      mine1.store_group_id !== mine2.store_group_id);

    const members = await pairing.listGroupMembers(mine1.id);
    check("a fresh store's group contains only itself",
      members.length === 1 && members[0].id === mine1.id,
      String(members.length));

    const options = await connectionModel.listSourceOptionsFor(mine2.id);
    check("before pairing, the picker offers nothing",
      options.filter((o) => o.shop_domain.startsWith(RUN)).length === 0,
      JSON.stringify(options.map((o) => o.shop_domain)));
  }

  console.log("\nPairing code");
  {
    const issued = await pairing.issueCode(mine2.id);
    check("code is issued", /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(issued.code), issued.code);
    check("code has an expiry", issued.expiresAt > new Date());
    check("code avoids ambiguous characters", !/[O01IL]/.test(issued.code), issued.code);

    const wrong = await expectRejection(() => pairing.redeemCode(mine1.id, "AAAA-AAAA"));
    check("an unknown code is refused", wrong && wrong.name === "PairingError");
    check("the refusal does not reveal whether a code exists",
      wrong && /not valid or has already been used/.test(wrong.message), wrong && wrong.message);

    const self = await expectRejection(() => pairing.redeemCode(mine2.id, issued.code));
    check("a store cannot redeem its own code",
      self && /OTHER store/.test(self.message), self && self.message);

    // Typed sloppily: lower case, spaces, no dash.
    const result = await pairing.redeemCode(mine1.id, `  ${issued.code.replace("-", "").toLowerCase()} `);
    check("redeeming is forgiving about formatting", result.alreadyLinked === false);

    mine1 = await storeModel.findById(mine1.id);
    mine2 = await storeModel.findById(mine2.id);
    check("both stores now share a group",
      mine1.store_group_id === mine2.store_group_id,
      `${mine1.store_group_id} vs ${mine2.store_group_id}`);

    const reuse = await expectRejection(() => pairing.redeemCode(stranger.id, issued.code));
    check("a code is single use", reuse && reuse.name === "PairingError", reuse && reuse.message);
  }

  console.log("\nThe leak is closed");
  {
    const options = await connectionModel.listSourceOptionsFor(mine2.id);
    const domains = options.map((o) => o.shop_domain);

    check("the paired store is now visible", domains.includes(domain("warehouse")));
    check("the stranger's store is NOT visible", !domains.includes(domain("stranger")),
      JSON.stringify(domains));

    // Defence in depth: even a hand-crafted request must be refused.
    const forged = await expectRejection(() =>
      connectionModel.createConnection({
        sourceStoreId: stranger.id,
        destinationStoreId: mine2.id,
      })
    );
    check("connecting an unpaired store is refused",
      forged && forged.name === "NotPairedError", forged && forged.name);
    check("the refusal explains what to do",
      forged && /pairing code/.test(forged.message), forged && forged.message);

    const allowed = await connectionModel.createConnection({
      sourceStoreId: mine1.id,
      destinationStoreId: mine2.id,
    });
    check("connecting a paired store works", Boolean(allowed && allowed.id));
  }

  console.log("\nGroups merge transitively");
  {
    const third = await makeStore("outlet");
    const issued = await pairing.issueCode(mine1.id);
    await pairing.redeemCode(third.id, issued.code);

    const members = await pairing.listGroupMembers(third.id);
    const names = members.map((m) => m.store_name).sort();
    check("pairing with one store joins the whole group",
      names.join(",") === "outlet,retail,warehouse", names.join(","));

    // Pairing again when already linked is a no-op, not an error.
    const again = await pairing.issueCode(mine2.id);
    const repeat = await pairing.redeemCode(third.id, again.code);
    check("re-pairing an already-linked store is harmless",
      repeat.alreadyLinked === true);
  }

  console.log("\nLeaving a group");
  {
    const loose = await makeStore("loose");
    const issued = await pairing.issueCode(mine1.id);
    await pairing.redeemCode(loose.id, issued.code);

    const before = (await storeModel.findById(loose.id)).store_group_id;
    await pairing.leaveGroup(loose.id);
    const after = (await storeModel.findById(loose.id)).store_group_id;

    check("leaving gives the store a fresh group", before !== after);
    check("it can no longer see the others",
      (await pairing.listGroupMembers(loose.id)).length === 1);

    const stuck = await expectRejection(() => pairing.leaveGroup(mine1.id));
    check("a connected store cannot leave its group",
      stuck && stuck.statusCode === 409, stuck && stuck.message);
  }

  console.log("\nReinstall keeps the pairing");
  {
    const groupBefore = (await storeModel.findById(mine1.id)).store_group_id;

    await storeModel.upsertStore({
      shop_domain: domain("warehouse"),
      store_name: "warehouse",
      access_token: "shpat_reinstalled",
    });

    const groupAfter = (await storeModel.findById(mine1.id)).store_group_id;
    check("a reinstall does not eject the store from its group",
      groupBefore === groupAfter, `${groupBefore} -> ${groupAfter}`);
  }

  console.log("\nCodes are role-specific");
  {
    // Only a SOURCE hands a code out, and only a DESTINATION may redeem it.
    // The check lives inside redeemCode's transaction, so a code aimed at the
    // wrong kind of store must be left UNSPENT and no groups merged.
    const src = await makeStore("rolesrc");
    const dest = await makeStore("roledest");
    const other = await makeStore("roleother");

    await storeModel.chooseStoreType(src.id, "source");
    await storeModel.chooseStoreType(dest.id, "destination");
    await storeModel.chooseStoreType(other.id, "destination");

    // A destination store's code offered to another destination: refused.
    const { code: destCode } = await pairing.issueCode(dest.id);

    const wrongWay = await expectRejection(() =>
      pairing.redeemCode(other.id, destCode, { expectIssuerType: "source" })
    );
    check("a destination store's code is refused",
      wrongWay && wrongWay.name === "PairingError", wrongWay && wrongWay.name);
    check("the refusal says what kind of code is wanted",
      wrongWay && /source/.test(wrongWay.message), wrongWay && wrongWay.message);

    const stillGrouped = await storeModel.findById(other.id);
    check("the rejected redeem did NOT merge the groups",
      stillGrouped.store_group_id !== (await storeModel.findById(dest.id)).store_group_id);

    const unspent = await query(
      "SELECT pairing_code FROM stores WHERE id = ?", [dest.id]
    );
    check("the rejected code is NOT spent",
      unspent[0].pairing_code !== null, String(unspent[0].pairing_code));

    // The right way round: a SOURCE's code, redeemed by a DESTINATION.
    const { code: sourceCode } = await pairing.issueCode(src.id);

    const ok = await pairing.redeemCode(dest.id, sourceCode, {
      expectIssuerType: "source",
    });
    check("a source's code is accepted by a destination",
      ok && ok.linkedWith.id === src.id);
    check("redeemCode reports the issuer's type",
      ok.linkedWith.store_type === "source", ok.linkedWith.store_type);

    // And the connection that follows goes live with nothing to approve.
    const connection = await connectionModel.createConnection({
      sourceStoreId: src.id,
      destinationStoreId: dest.id,
    });
    check("the connection is active immediately",
      connection.status === "active", connection.status);
  }

  await cleanup();
  await pool.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch(async (err) => {
  console.error("\nTest run crashed:", err.stack || err.message);
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
