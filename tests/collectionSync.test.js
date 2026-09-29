/* Collections following the products that live in them.
 *
 * Shopify is stubbed -- there is no dev store in a test run -- but the
 * database is real, because the whole point of collection_mappings is that a
 * collection is looked up and created ONCE however many products arrive in
 * it, and a Map in a fixture would prove nothing about that.
 *
 * Three behaviours matter more than the rest, and each has a case here:
 *
 *   a collection the destination ALREADY HAD is joined, not duplicated, and
 *   is never afterwards treated as ours;
 *
 *   a product the destination filed in its OWN collection stays in it, even
 *   though productSet replaces the whole membership list;
 *
 *   the plan gate is read at push time, so a store that downgrades stops
 *   creating collections without anybody clearing its ticked switch.
 */
require("dotenv").config({ quiet: true });

const path = require("path");

const SERVER = path.join(__dirname, "..");

const { pool, query } = require(path.join(SERVER, "config/db"));
const { runMigrations } = require(path.join(SERVER, "config/migrate"));
const storeModel = require(path.join(SERVER, "models/storeModel"));
const connectionModel = require(path.join(SERVER, "models/connectionModel"));
const syncSettingsModel = require(path.join(SERVER, "models/syncSettingsModel"));
const collectionMappingModel = require(path.join(SERVER, "models/collectionMappingModel"));
const planModel = require(path.join(SERVER, "models/planModel"));
const planLimits = require(path.join(SERVER, "services/planLimits"));
const collectionSync = require(path.join(SERVER, "services/collectionSync"));
const shopify = require(path.join(SERVER, "services/shopify"));

const RUN = `cs${Date.now().toString(36)}`;

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

/* A stand-in destination store. `existing` are collections it already has;
   `calls` records everything asked of it. */
function fakeShopify({ existing = [], productCollections = [] } = {}) {
  const calls = { searches: 0, creates: 0, publishes: 0, productReads: 0 };
  let nextId = 900;

  const collections = existing.map((c) => ({
    id: `gid://shopify/Collection/${c.id}`,
    title: c.title,
    handle: c.handle,
  }));

  shopify.forShop = async (shop, body) => {
    const q = body.query;

    if (q.includes("query FindCollection")) {
      calls.searches += 1;
      const handle = (body.variables.query.match(/handle:'([^']*)'/) || [])[1];
      const found = collections.find((c) => c.handle === handle);
      return { collections: { nodes: found ? [found] : [] } };
    }

    if (q.includes("mutation CreateCollection")) {
      calls.creates += 1;

      /* The shape Shopify actually accepts on 2025-01, asserted rather than
       * assumed. An earlier version of this file sent the newer
       * `collection: CollectionCreateInput!`, which that API rejects outright
       * -- and a stub that read whatever it was handed passed regardless,
       * while no collection was created against a real store. */
      if (!/\$input:\s*CollectionInput!/.test(q) || !/collectionCreate\(input:/.test(q)) {
        throw new Error("collectionCreate must take input: CollectionInput! on 2025-01");
      }
      if (!body.variables.input) {
        throw new Error("collectionCreate variables must be keyed on `input`");
      }
      const made = {
        id: `gid://shopify/Collection/${++nextId}`,
        title: body.variables.input.title,
        handle: body.variables.input.handle,
      };
      collections.push(made);
      return { collectionCreate: { collection: made, userErrors: [] } };
    }

    if (q.includes("publishablePublish")) {
      calls.publishes += 1;
      return { publishablePublish: { userErrors: [] } };
    }

    if (q.includes("publications(first")) {
      return {
        publications: {
          nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store" }],
        },
      };
    }

    if (q.includes("query ProductCollections")) {
      calls.productReads += 1;
      return {
        product: {
          collections: { nodes: productCollections.map((id) => ({ id })) },
        },
      };
    }

    throw new Error(`Unexpected query: ${q.slice(0, 60)}`);
  };

  return calls;
}

(async () => {
  const realForShop = shopify.forShop;

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

    await query("UPDATE stores SET store_group_id = ? WHERE id IN (?, ?)", [
      `${RUN}-group`,
      source.id,
      destination.id,
    ]);

    const connection = await connectionModel.createConnection({
      sourceStoreId: source.id,
      destinationStoreId: destination.id,
    });
    const link = await connectionModel.findById(connection.id);

    const OILS = { id: "500", title: "Massage Oils", handle: "massage-oils" };
    const BEST = { id: "501", title: "Best Sellers", handle: "best-sellers" };

    /* ---------------- the first product in a collection ---------------- */

    console.log("A collection the destination has never seen");
    {
      const calls = fakeShopify();
      const placed = await collectionSync.ensureCollections(link, [OILS]);

      check("it is created over there", calls.creates === 1);
      check("and put on the storefront",
        calls.publishes === 1,
        "a collection created through the API belongs to no sales channel");
      check("the product gets its destination id",
        placed.get("500") === "gid://shopify/Collection/901");

      const row = await collectionMappingModel.findBySource(connection.id, "500");
      check("and it is remembered as ours", row && row.created_by_app === true);
    }

    console.log("\nThe next fifty products in the same collection");
    {
      const calls = fakeShopify();
      const placed = await collectionSync.ensureCollections(link, [OILS]);

      check("nothing is searched for or created again",
        calls.searches === 0 && calls.creates === 0,
        `${calls.searches} searches, ${calls.creates} creates`);
      check("the same collection is used",
        placed.get("500") === "gid://shopify/Collection/901",
        "fifty products in one collection would be fifty needless calls");
    }

    /* ---------------- one the destination already had ---------------- */

    console.log("\nA collection the destination already keeps");
    {
      const calls = fakeShopify({
        existing: [{ id: "777", title: "Best Sellers", handle: "best-sellers" }],
      });

      const placed = await collectionSync.ensureCollections(link, [BEST]);

      check("theirs is joined, not duplicated", calls.creates === 0);
      check("and it is the one the product goes into",
        placed.get("501") === "gid://shopify/Collection/777");

      const row = await collectionMappingModel.findBySource(connection.id, "501");
      check("recorded as THEIRS, not ours",
        row && row.created_by_app === false,
        "that flag is the whole basis for what the app may rename or remove");

      const owned = await collectionMappingModel.listOwned(connection.id);
      check("so it is left out of what the app owns",
        owned.length === 1 && owned[0].handle === "massage-oils");
    }

    console.log("\nA near-match is not a match");
    {
      fakeShopify({ existing: [{ id: "888", title: "Oils", handle: "oils" }] });

      const placed = await collectionSync.ensureCollections(link, [
        { id: "502", title: "Body Oils", handle: "body-oils" },
      ]);

      check("a different handle gets its own collection",
        placed.get("502") !== "gid://shopify/Collection/888",
        "a fuzzy search must not merge two groups");
    }

    /* ---------------- the buyer's own filing ---------------- */

    console.log("\nWhat the buyer filed this product in themselves");
    {
      // Ours is 901 (Massage Oils). 4242 is a collection of their own.
      fakeShopify({
        productCollections: [
          "gid://shopify/Collection/901",
          "gid://shopify/Collection/4242",
        ],
      });

      const list = await collectionSync.collectionsForProduct(link, [OILS], 5555);

      check("their collection survives the push",
        list.includes("gid://shopify/Collection/4242"),
        "productSet REPLACES membership, so sending only ours would unfile it");
      check("and ours is in the list too",
        list.includes("gid://shopify/Collection/901"));
      check("with nothing repeated",
        new Set(list).size === list.length);
    }

    console.log("\nA product that does not exist over there yet");
    {
      const calls = fakeShopify();
      const list = await collectionSync.collectionsForProduct(link, [OILS], null);

      check("nothing is read back", calls.productReads === 0,
        "a product being created has no filing to preserve");
      check("and it goes straight into ours",
        list.length === 1 && list[0] === "gid://shopify/Collection/901");
    }

    console.log("\nWhen the destination cannot be read");
    {
      shopify.forShop = async (shop, body) => {
        if (body.query.includes("query ProductCollections")) {
          throw new Error("throttled");
        }
        return { collections: { nodes: [] } };
      };

      const list = await collectionSync.collectionsForProduct(link, [OILS], 5555);

      check("the field is left off entirely rather than guessed",
        list === null,
        "sending our list alone would wipe collections we could not see");
    }

    /* ---------------- keeping the source's collections ---------------- */

    console.log("\nA source edit that says nothing about collections");
    {
      const sourceProductModel = require(path.join(SERVER, "models/sourceProductModel"));
      const productSync = require(path.join(SERVER, "services/productSync"));

      await sourceProductModel.upsert(source.id, {
        id: 700900,
        title: "Mattress",
        status: "active",
        collections: [{ id: "500", title: "Mattresses", handle: "mattresses" }],
        variants: [{ id: 710900, title: "Default", sku: "M-1", price: "100.00" }],
      });

      const before = await sourceProductModel.findByShopifyId(source.id, "700900");
      check("the collection is cached with the product",
        (before.product_data.collections || []).length === 1);

      // A products/update webhook: Shopify does not put collection membership
      // in the payload at all.
      await productSync.applySourceUpdate(source.id, {
        id: 700900,
        title: "Mattress (firm)",
        status: "active",
        variants: [{ id: 710900, title: "Default", sku: "M-1", price: "110.00" }],
        options: [],
        images: [],
      });

      const after = await sourceProductModel.findByShopifyId(source.id, "700900");

      check("the title change lands", after.title === "Mattress (firm)");
      check("and the collections survive it",
        (after.product_data.collections || []).length === 1 &&
          after.product_data.collections[0].handle === "mattresses",
        "absent from a webhook means unchanged, not gone -- the push would file it nowhere");
    }

    /* ---------------- the plan gate ---------------- */

    console.log("\nThe plan decides whether the switch may be used");
    {
      const free = await planModel.findFree();
      const paid = (await planModel.listActive()).find(
        (plan) => planModel.allowsCollections(plan)
      );

      check("the free plan does not include it",
        free && !planModel.allowsCollections(free));
      check("a paid one does", Boolean(paid));

      const onFree = await planLimits.collectionsAllowed({ ...destination, id: destination.id });
      check("a store that never chose a plan is refused",
        onFree.ok === false,
        "no membership means Free");
      check("and is told which plan would open it",
        /plan/.test(await planLimits.firstPlanWithCollections()));
    }

    /* ---------------- the switch itself ---------------- */

    console.log("\nThe Settings switch");
    {
      const fresh = await syncSettingsModel.forConnection(connection.id);
      check("starts off, unlike every other field",
        fresh.collections === false,
        "the others copy a value; this one creates collections in a live store");

      await syncSettingsModel.save(connection.id, { price_markup_percent: 10 });
      const afterSave = await syncSettingsModel.forConnection(connection.id);
      check("and a save that does not mention it leaves it off",
        afterSave.collections === false,
        "a missing key must never read as permission");

      await syncSettingsModel.save(connection.id, {
        price_markup_percent: 10,
        collections: true,
      });
      check("only an explicit true switches it on",
        (await syncSettingsModel.forConnection(connection.id)).collections === true);
    }
  } catch (err) {
    check("suite ran", false, err.message);
    console.error(err);
  } finally {
    shopify.forShop = realForShop;
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    await pool.end();
    process.exitCode = failed ? 1 : 0;
  }
})();
