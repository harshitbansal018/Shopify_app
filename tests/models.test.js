/* Integration tests for the 6 tables and their models.
 *
 * These run against the REAL database, because the things worth checking here
 * are the things a stub cannot have: cascade rules, unique constraints, the
 * self-referencing double join, and pairing.
 *
 * Everything is created under a `test-<runId>` shop domain prefix and deleted
 * at the end, so a failed run leaves nothing behind that a later run trips on.
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
const sourceVariantModel = require(path.join(SERVER, "models/sourceVariantModel"));
const mappingVariantProductModel = require(
  path.join(SERVER, "models/mappingVariantProductModel")
);
const pairing = require(path.join(SERVER, "services/pairing"));

/** Stores must be paired by their operator before they can be connected. */
async function pair(storeA, storeB) {
  const { code } = await pairing.issueCode(storeA.id);
  await pairing.redeemCode(storeB.id, code);
}

// Distinct per run so a leftover row from a crashed run cannot collide.
const RUN = `t${Date.now().toString(36)}`;
const SRC_DOMAIN = `${RUN}-src.myshopify.com`;
const DST_DOMAIN = `${RUN}-dst.myshopify.com`;

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
  // Deleting the stores cascades to everything else.
  await query("DELETE FROM stores WHERE shop_domain LIKE ?", [`${RUN}-%`]);
}

(async () => {
  await runMigrations();
  await cleanup();

  let source;
  let destination;
  let connection;
  let sourceProduct;
  let mapping;

  console.log("\nstores");
  {
    source = await storeModel.upsertStore({
      shop_domain: SRC_DOMAIN,
      store_name: "Test Source",
      currency: "USD",
      access_token: "shpat_source_token",
      refresh_token: "shprt_source_refresh",
      access_token_expires_at: new Date(Date.now() + 3600_000),
      refresh_token_expires_at: new Date(Date.now() + 7776000_000),
    });

    destination = await storeModel.upsertStore({
      shop_domain: DST_DOMAIN,
      store_name: "Test Destination",
      currency: "GBP",
      access_token: "shpat_dest_token",
    });

    check("upsert creates a store", Boolean(source && source.id));
    check("token round-trips through encryption",
      source.access_token === "shpat_source_token", source.access_token);
    check("refresh token round-trips",
      source.refresh_token === "shprt_source_refresh");

    // The point of encryption: the column must NOT hold the plaintext.
    const raw = await query("SELECT access_token FROM stores WHERE id = ?", [source.id]);
    check("token is NOT stored in plain text",
      !String(raw[0].access_token).includes("shpat_source_token"),
      String(raw[0].access_token).slice(0, 40));
    check("stored value is versioned ciphertext",
      String(raw[0].access_token).startsWith("v1."));

    check("a new store has NO role yet", source.store_type === null,
      String(source.store_type));

    const eitherWay = await storeModel.listByRole("source");
    check("an unassigned store is offered for either role",
      eitherWay.some((s) => s.shop_domain === SRC_DOMAIN));

    await storeModel.chooseStoreType(source.id, "source");
    await storeModel.chooseStoreType(destination.id, "destination");

    const sources = await storeModel.listByRole("source");
    check("listByRole finds a source store",
      sources.some((s) => s.shop_domain === SRC_DOMAIN));
    check("listByRole excludes a destination store",
      !sources.some((s) => s.shop_domain === DST_DOMAIN));

    const destinations = await storeModel.listByRole("destination");
    check("listByRole excludes a source store from destinations",
      !destinations.some((s) => s.shop_domain === SRC_DOMAIN));

    // The type is chosen ONCE at install and is final -- not "final once it is
    // connected", final immediately. This store has no connections at all.
    {
      const fresh = await storeModel.upsertStore({
        shop_domain: `${RUN}-fresh.myshopify.com`,
        store_name: "Never Connected",
        access_token: "shpat_fresh",
      });

      check("a fresh store starts with no type", fresh.store_type === null);

      await storeModel.chooseStoreType(fresh.id, "source");

      const flip = await expectRejection(() =>
        storeModel.chooseStoreType(fresh.id, "destination")
      );
      check("an UNCONNECTED store still cannot change its type",
        flip && flip.name === "RoleConflictError", flip && flip.name);
      check("the refusal says the choice is permanent",
        flip && /cannot be changed/.test(flip.message), flip && flip.message);

      const again = await expectRejection(() =>
        storeModel.chooseStoreType(fresh.id, "source")
      );
      check("even re-choosing the SAME type is refused",
        again && again.name === "RoleConflictError", again && again.name);

      const cleared = await expectRejection(() =>
        storeModel.chooseStoreType(fresh.id, null)
      );
      check("a type cannot be cleared back to null",
        cleared && cleared.name === "RoleConflictError", cleared && cleared.name);

      check("the type survived every rejected write",
        (await storeModel.findById(fresh.id)).store_type === "source");
    }

    // A reinstall must not reset the merchant's role choice.
    await storeModel.upsertStore({
      shop_domain: SRC_DOMAIN,
      store_name: "Test Source Renamed",
      access_token: "shpat_new",
    });
    const reinstalled = await storeModel.findByDomain(SRC_DOMAIN);
    check("reinstall keeps store_type", reinstalled.store_type === "source",
      reinstalled.store_type);
    check("reinstall refreshes the token", reinstalled.access_token === "shpat_new");
    check("reinstall reactivates", reinstalled.is_active === true);

    await storeModel.markUninstalled(SRC_DOMAIN);
    const uninstalled = await storeModel.findByDomain(SRC_DOMAIN);
    check("uninstall deactivates", uninstalled.is_active === false);
    check("uninstall stamps the time", Boolean(uninstalled.uninstalled_at));
    check("uninstall clears the token", uninstalled.access_token === null);

    // Put it back for the rest of the run.
    await storeModel.upsertStore({
      shop_domain: SRC_DOMAIN,
      store_name: "Test Source",
      access_token: "shpat_source_token",
    });
    source = await storeModel.findByDomain(SRC_DOMAIN);
    check("reinstall clears uninstalled_at", source.uninstalled_at === null);
  }

  console.log("\nstore_connections (self-referencing join)");
  {
    // Stores can only be connected once their operator has paired them.
    await pair(source, destination);

    connection = await connectionModel.createConnection({
      sourceStoreId: source.id,
      destinationStoreId: destination.id,
      syncMode: "auto",
      settings: { price_markup_percent: 15, delete_behaviour: "draft" },
    });

    check("creates a connection", Boolean(connection && connection.id));
    check("joins the source store",
      connection.source.shop_domain === SRC_DOMAIN, connection.source.shop_domain);
    check("joins the destination store",
      connection.destination.shop_domain === DST_DOMAIN);
    check("keeps the two sides distinct",
      connection.source.id !== connection.destination.id);
    check("settings survive as an object",
      connection.settings.price_markup_percent === 15);
    check("settings are defaulted where absent",
      connection.settings.sync_images === true &&
        connection.settings.sync_inventory === true);

    const dup = await expectRejection(() =>
      connectionModel.createConnection({
        sourceStoreId: source.id,
        destinationStoreId: destination.id,
      })
    );
    check("duplicate pair rejected",
      dup && dup.name === "DuplicateConnectionError", dup && dup.name);

    const self = await expectRejection(() =>
      connectionModel.createConnection({
        sourceStoreId: source.id,
        destinationStoreId: source.id,
      })
    );
    check("self-connection rejected",
      self && self.name === "InvalidConnectionError", self && self.name);

    // A store is EITHER a source or a destination -- never both.
    const reversed = await expectRejection(() =>
      connectionModel.createConnection({
        sourceStoreId: destination.id,
        destinationStoreId: source.id,
      })
    );
    check("a destination store cannot be used as a source",
      reversed && reversed.name === "RoleConflictError",
      reversed && `${reversed.name}: ${reversed.message}`);

    const flip = await expectRejection(() =>
      storeModel.chooseStoreType(source.id, "destination")
    );
    check("cannot flip a connected source into a destination",
      flip && flip.name === "RoleConflictError", flip && flip.name);

    check("the role survived the rejected change",
      (await storeModel.findById(source.id)).store_type === "source");

    // Which variants may go out. NULL and [] mean opposite things: NULL is
    // "every variant, including ones added later", [] would be "none".
    {
      const product = await sourceProductModel.upsert(source.id, {
        id: 5550,
        title: "Variant Selection Shirt",
        status: "active",
        variants: [
          { id: 90001, sku: "VS-S", price: "10.00", option1: "S" },
          { id: 90002, sku: "VS-M", price: "11.00", option1: "M" },
        ],
      });

      const variants = await sourceVariantModel.listForProduct(product.id);

      const everything = await productMappingModel.ensure({
        connectionId: connection.id,
        sourceProductId: product.id,
        sourceShopifyProductId: product.shopify_product_id,
      });

      check("allowing a whole product stores NULL, not a list",
        everything.allowed_variant_ids === null,
        JSON.stringify(everything.allowed_variant_ids));

      const narrowed = await productMappingModel.setAllowedVariants(
        everything.id,
        [variants[1].id]
      );

      check("a narrowed selection round-trips as an array",
        Array.isArray(narrowed.allowed_variant_ids) &&
          narrowed.allowed_variant_ids.length === 1,
        JSON.stringify(narrowed.allowed_variant_ids));
      check("it holds the variant that was picked",
        narrowed.allowed_variant_ids[0] === variants[1].id);

      // Changing the selection must re-queue: a 'synced' row would otherwise
      // keep the old variants on the destination forever.
      await productMappingModel.markSynced(narrowed.id, {
        destinationProductId: 777,
        sourceUpdatedAt: null,
      });
      const requeued = await productMappingModel.setAllowedVariants(
        narrowed.id,
        [variants[0].id]
      );
      check("changing the selection re-queues the product",
        requeued.sync_status === "pending", requeued.sync_status);

      const widened = await productMappingModel.setAllowedVariants(narrowed.id, null);
      check("widening back to all clears the list",
        widened.allowed_variant_ids === null);

      // Emptying the list is not a way to say "none" -- there is no such state,
      // and storing [] would push a product with no variants.
      const emptied = await productMappingModel.setAllowedVariants(narrowed.id, []);
      check("an empty selection is stored as NULL, never as []",
        emptied.allowed_variant_ids === null,
        JSON.stringify(emptied.allowed_variant_ids));

      // Re-importing a product means the destination now holds older data than
      // we do, so anything already pushed must be queued again.
      await productMappingModel.markSynced(narrowed.id, {
        destinationProductId: 778,
        sourceUpdatedAt: null,
      });

      const moved = await productMappingModel.requeueForSourceProduct(product.id);
      check("re-importing queues the product for another push", moved === 1,
        String(moved));
      check("and the status really changed",
        (await productMappingModel.findById(narrowed.id)).sync_status === "pending");

      // The destination has to agree before anything is written to its store.
      {
        const offered = await productMappingModel.findById(narrowed.id);

        check("a freshly offered product is not accepted",
          offered.accepted_at === null, String(offered.accepted_at));

        const notYet = await productMappingModel.listForConnection(connection.id, {
          status: "pending",
          acceptedOnly: true,
        });
        check("an unaccepted product is invisible to the push",
          !notYet.some((m) => m.id === narrowed.id),
          "it would have been written to a store that never asked for it");

        // Another store's id must not be acceptable from here.
        const stolen = await productMappingModel.acceptForDestination(
          source.id, // the SOURCE store, which is not the destination
          [narrowed.id]
        );
        check("a store cannot accept products into someone else's shop",
          stolen === 0, String(stolen));

        const accepted = await productMappingModel.acceptForDestination(
          destination.id,
          [narrowed.id]
        );
        check("the real destination can accept", accepted === 1, String(accepted));

        const now = await productMappingModel.findById(narrowed.id);
        check("acceptance is stamped", Boolean(now.accepted_at));
        check("and it is queued for the push", now.sync_status === "pending");

        const visible = await productMappingModel.listForConnection(connection.id, {
          status: "pending",
          acceptedOnly: true,
        });
        check("an accepted product IS visible to the push",
          visible.some((m) => m.id === narrowed.id));

        // Accepting twice must not move the timestamp.
        const stamp = now.accepted_at;
        await productMappingModel.acceptForDestination(destination.id, [narrowed.id]);
        check("re-accepting keeps the original timestamp",
          String((await productMappingModel.findById(narrowed.id)).accepted_at) ===
            String(stamp));

        // Declining stops future updates without deleting anything.
        await productMappingModel.declineForDestination(destination.id, [narrowed.id]);
        const declined = await productMappingModel.findById(narrowed.id);
        check("declining clears the acceptance", declined.accepted_at === null);
        check("declining marks it skipped", declined.sync_status === "skipped");
        check("declining keeps the destination product id",
          declined.destination_shopify_product_id !== null,
          "the merchant's existing product was forgotten");

        // Put it back so the checks below still have an accepted row.
        await productMappingModel.acceptForDestination(destination.id, [narrowed.id]);
      }

      // A product deleted at the source must never be resurrected -- not by a
      // re-import, and not by the destination accepting it again. Left until
      // last because 'deleted' is a one-way door.
      {
        await productMappingModel.markDeleted(narrowed.id);

        await productMappingModel.requeueForSourceProduct(product.id);
        check("re-importing does not resurrect a deleted mapping",
          (await productMappingModel.findById(narrowed.id)).sync_status === "deleted");

        await productMappingModel.declineForDestination(destination.id, [narrowed.id]);
        await productMappingModel.acceptForDestination(destination.id, [narrowed.id]);
        check("accepting does not resurrect a deleted mapping",
          (await productMappingModel.findById(narrowed.id)).sync_status === "deleted");
      }

      // Remove it again: later sections count this store's products and would
      // otherwise trip over one this block invented. The delete cascades to
      // the mapping and the variants.
      await sourceProductModel.deleteByShopifyId(source.id, 5550);
    }

    const auto = await connectionModel.listAutoSyncForSource(source.id);
    check("auto-sync lookup finds it", auto.length === 1, String(auto.length));

    await connectionModel.setStatus(connection.id, "paused");
    const paused = await connectionModel.listAutoSyncForSource(source.id);
    check("paused connection drops out of the auto-sync lookup",
      paused.length === 0, String(paused.length));
    await connectionModel.setStatus(connection.id, "active");

    const both = await connectionModel.listForStore(destination.id);
    check("listForStore matches on the destination side too", both.length === 1);

    // Clamping: a nonsense markup must not reach the sync step.
    const clamped = await connectionModel.updateSettings(connection.id, {
      price_markup_percent: 99999,
      delete_behaviour: "nonsense",
    });
    check("markup is clamped", clamped.settings.price_markup_percent === 1000,
      String(clamped.settings.price_markup_percent));
    check("unknown delete_behaviour falls back",
      clamped.settings.delete_behaviour === "draft",
      clamped.settings.delete_behaviour);
  }

  console.log("\ndestination-first source picker");
  {
    // A third store, still unassigned, so it can be offered as a source.
    const spare = await storeModel.upsertStore({
      shop_domain: `${RUN}-spare.myshopify.com`,
      store_name: "Test Spare",
      access_token: "shpat_spare",
    });

    await pair(destination, spare);

    const options = await connectionModel.listSourceOptionsFor(destination.id);
    const byDomain = Object.fromEntries(options.map((o) => [o.shop_domain, o]));

    check("lists the already-connected source",
      byDomain[SRC_DOMAIN] && byDomain[SRC_DOMAIN].connected === true);
    check("shows how that source is connected",
      byDomain[SRC_DOMAIN].connection.sync_mode === "auto",
      JSON.stringify(byDomain[SRC_DOMAIN].connection));

    check("offers an unassigned store as a candidate",
      byDomain[`${RUN}-spare.myshopify.com`] &&
        byDomain[`${RUN}-spare.myshopify.com`].connected === false);
    check("flags that picking it would set its role",
      byDomain[`${RUN}-spare.myshopify.com`].role_is_pending === true);

    check("never offers the destination to itself",
      !byDomain[DST_DOMAIN], "the destination appeared in its own source list");

    check("unconnected candidates sort first",
      options[0].connected === false,
      options.map((o) => `${o.shop_domain}:${o.connected}`).join(", "));

    // Connect several at once; one of them is invalid.
    const result = await connectionModel.connectSources(
      destination.id,
      [spare.id, source.id],
      { syncMode: "manual" }
    );

    check("connects the new source", result.connected.length === 1,
      String(result.connected.length));
    check("reports the duplicate rather than aborting",
      result.rejected.length === 1 &&
        result.rejected[0].code === "DuplicateConnectionError",
      JSON.stringify(result.rejected));

    check("connecting assigned the pending role",
      (await storeModel.findById(spare.id)).store_type === "source");

    const feeding = await connectionModel.listForDestination(destination.id);
    check("destination now has two sources", feeding.length === 2,
      String(feeding.length));

    const leaving = await connectionModel.listForSource(source.id);
    check("source lists its outgoing connection", leaving.length === 1);

    // Tidy up so the cascade assertions later still count what they expect.
    await storeModel.deleteStore(`${RUN}-spare.myshopify.com`);
  }

  console.log("\nsource_products");
  {
    const written = await sourceProductModel.upsertMany(source.id, [
      {
        id: 700001,
        title: "Test Widget",
        handle: "test-widget",
        vendor: "Acme",
        status: "active",
        updated_at: "2026-01-01T00:00:00Z",
        variants: [{ id: 900001, sku: "W-1" }],
      },
      { id: 700002, title: "Second Widget", updated_at: "2026-01-02T00:00:00Z" },
    ]);

    check("bulk upsert writes both", written === 2, String(written));

    sourceProduct = await sourceProductModel.findByShopifyId(source.id, 700001);
    check("finds by shopify id", Boolean(sourceProduct));
    check("full payload survives as an object",
      sourceProduct.product_data.variants[0].sku === "W-1");
    check("GID form resolves to the same row",
      Boolean(await sourceProductModel.findByShopifyId(
        source.id, "gid://shopify/Product/700001")));

    // Re-upsert must update, not duplicate.
    await sourceProductModel.upsertMany(source.id, [
      { id: 700001, title: "Renamed Widget", updated_at: "2026-02-01T00:00:00Z" },
    ]);
    const renamed = await sourceProductModel.findByShopifyId(source.id, 700001);
    check("re-upsert updates in place", renamed.title === "Renamed Widget");
    check("no duplicate row created",
      (await sourceProductModel.countForStore(source.id)) === 2);

    const missing = await sourceProductModel.findMissingSince(source.id, [700001]);
    check("detects products deleted at source",
      missing.length === 1 && missing[0] === "700002", JSON.stringify(missing));
  }

  console.log("\nproduct_mappings + variant_mappings");
  {
    mapping = await productMappingModel.ensure({
      connectionId: connection.id,
      sourceProductId: sourceProduct.id,
      sourceShopifyProductId: 700001,
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });

    check("creates a mapping", Boolean(mapping && mapping.id));
    check("starts pending", mapping.sync_status === "pending");

    // Calling ensure twice must not create a second row.
    const again = await productMappingModel.ensure({
      connectionId: connection.id,
      sourceProductId: sourceProduct.id,
      sourceShopifyProductId: 700001,
    });
    check("ensure is idempotent", again.id === mapping.id);

    // The source variants were cached alongside the product itself.
    const sourceVariants = await sourceVariantModel.listForProduct(sourceProduct.id);
    check("caching a product also cached its variants",
      sourceVariants.length === 1, String(sourceVariants.length));
    check("variant fields were extracted from the payload",
      sourceVariants[0].sku === "W-1", sourceVariants[0].sku);

    // Add a second variant at the source and re-cache.
    await sourceProductModel.upsert(source.id, {
      id: 700001,
      title: "Renamed Widget",
      updated_at: "2026-02-01T00:00:00Z",
      variants: [
        { id: 900001, sku: "W-1", title: "Small", price: "20.00", option1: "Small",
          inventory_item_id: 990001, position: 1 },
        { id: 900002, sku: "W-2", title: "Large", price: "22.50", option1: "Large",
          position: 2 },
      ],
    });

    const cachedVariants = await sourceVariantModel.mapByShopifyId(sourceProduct.id);
    check("re-caching picks up the new variant", cachedVariants.size === 2,
      String(cachedVariants.size));
    check("price is stored as a number",
      Number(cachedVariants.get("900002").price) === 22.5,
      String(cachedVariants.get("900002").price));
    check("option values are stored",
      cachedVariants.get("900001").option1 === "Small");
    check("source inventory item id is kept",
      String(cachedVariants.get("900001").shopify_inventory_item_id) === "990001");

    // Now the LINK table: source variant <-> destination variant.
    await mappingVariantProductModel.upsertMany(mapping.id, [
      {
        sourceVariantMappingId: cachedVariants.get("900001").id,
        sourceShopifyVariantId: 900001,
        destinationVariantId: 950001,
        destinationInventoryItemId: 960001,
        sku: "W-1",
      },
      {
        sourceVariantMappingId: cachedVariants.get("900002").id,
        sourceShopifyVariantId: 900002,
        destinationVariantId: 950002,
        sku: "W-2",
      },
    ]);

    const index = await mappingVariantProductModel.mapBySourceVariant(mapping.id);
    check("variant pairs stored", index.size === 2, String(index.size));
    check("source variant resolves to its destination id",
      String(index.get("900001").destination_variant_id) === "950001");
    check("inventory item id stored",
      String(index.get("900001").destination_inventory_item_id) === "960001");

    // An update that does not know the destination id must not erase it.
    await mappingVariantProductModel.upsertMany(mapping.id, [
      {
        sourceVariantMappingId: cachedVariants.get("900001").id,
        sourceShopifyVariantId: 900001,
        sku: "W-1-NEW",
      },
    ]);
    const after = await mappingVariantProductModel.findBySourceVariant(mapping.id, 900001);
    check("re-upsert keeps the destination variant id",
      String(after.destination_variant_id) === "950001",
      String(after.destination_variant_id));
    check("re-upsert keeps the inventory item id",
      String(after.destination_inventory_item_id) === "960001");
    check("re-upsert updates the sku", after.sku === "W-1-NEW");

    // The join that a sync uses to build an update payload.
    const joined = await mappingVariantProductModel.listWithSourceVariants(mapping.id);
    check("link rows join their source variant",
      joined.length === 2 && joined[0].source_title === "Small",
      JSON.stringify(joined.map((j) => j.source_title)));
    check("the join carries the source price",
      Number(joined[0].source_price) === 20);

    const removed = await mappingVariantProductModel.removeMissing(mapping.id, [900001]);
    check("removes links whose source variant is gone", removed === 1, String(removed));

    // Deleting a source variant cascades the link row away with it.
    await sourceVariantModel.removeMissing(sourceProduct.id, []);
    check("removing a source variant cascades its link",
      (await mappingVariantProductModel.countForMapping(mapping.id)) === 0);

    // Restore one pair so the cascade section later has something to count.
    await sourceProductModel.upsert(source.id, {
      id: 700001,
      title: "Renamed Widget",
      updated_at: "2026-02-01T00:00:00Z",
      variants: [{ id: 900001, sku: "W-1", option1: "Small" }],
    });
    const restored = await sourceVariantModel.findByShopifyId(sourceProduct.id, 900001);
    await mappingVariantProductModel.upsertMany(mapping.id, [
      {
        sourceVariantMappingId: restored.id,
        sourceShopifyVariantId: 900001,
        destinationVariantId: 950001,
        sku: "W-1",
      },
    ]);

    await productMappingModel.markSynced(mapping.id, {
      destinationProductId: 800001,
      sourceUpdatedAt: "2026-02-01T00:00:00Z",
    });
    mapping = await productMappingModel.findById(mapping.id);
    check("markSynced records the destination id",
      String(mapping.destination_shopify_product_id) === "800001");
    check("markSynced sets last_synced_at", Boolean(mapping.last_synced_at));

    await productMappingModel.markFailed(mapping.id, "Shopify said no");
    mapping = await productMappingModel.findById(mapping.id);
    check("markFailed stores the reason",
      mapping.sync_status === "failed" && mapping.error_message === "Shopify said no");

    await productMappingModel.markSynced(mapping.id, { destinationProductId: null });
    mapping = await productMappingModel.findById(mapping.id);
    check("a later success clears the error", mapping.error_message === null);
    check("destination id is not lost by a null update",
      String(mapping.destination_shopify_product_id) === "800001");

    const listed = await productMappingModel.listForConnection(connection.id);
    check("list joins the product title",
      listed[0].title === "Renamed Widget", listed[0].title);

    const breakdown = await productMappingModel.statusBreakdown(connection.id);
    check("status breakdown counts", breakdown.synced === 1, JSON.stringify(breakdown));
  }

  console.log("\ncascade on uninstall-and-purge");
  {
    const COUNTS = `
      SELECT
        (SELECT COUNT(*) FROM store_connections WHERE source_store_id = ?) AS conns,
        (SELECT COUNT(*) FROM source_products  WHERE store_id = ?)         AS products,
        (SELECT COUNT(*) FROM product_mappings WHERE connection_id = ?)    AS mappings,
        (SELECT COUNT(*) FROM source_variant_mappings WHERE source_product_id = ?)  AS src_variants,
        (SELECT COUNT(*) FROM mapping_variant_products WHERE product_mapping_id = ?) AS link_variants
    `;
    const params = [source.id, source.id, connection.id, sourceProduct.id, mapping.id];

    const before = (await query(COUNTS, params))[0];
    check("rows exist before the delete",
      Number(before.conns) > 0 &&
        Number(before.products) > 0 &&
        Number(before.mappings) > 0 &&
        Number(before.src_variants) > 0 &&
        Number(before.link_variants) > 0,
      JSON.stringify(before));

    await storeModel.deleteStore(SRC_DOMAIN);

    const after = (await query(COUNTS, params))[0];
    check("connections cascade", Number(after.conns) === 0);
    check("source products cascade", Number(after.products) === 0);
    check("product mappings cascade", Number(after.mappings) === 0);
    check("source variants cascade", Number(after.src_variants) === 0);
    check("variant links cascade", Number(after.link_variants) === 0);
  }

  /* The two screen queries, run for real.
   *
   * The view tests hand these shapes in as fixtures, so a broken SELECT still
   * renders perfectly there and only fails in a merchant's browser. That is
   * exactly how a `CAST(... AS JSON)` -- valid in MySQL, rejected by MariaDB --
   * reached a running app. These run the SQL. */
  console.log("\nProducts screen queries");
  {
    const store = await storeModel.upsertStore({
      shop_domain: `${RUN}-screens.myshopify.com`,
      store_name: "Screens Source",
      access_token: "shpat_screens",
    });

    const other = await storeModel.upsertStore({
      shop_domain: `${RUN}-screensdst.myshopify.com`,
      store_name: "Screens Destination",
      access_token: "shpat_screensdst",
    });

    await pair(store, other);

    const link = await connectionModel.createConnection({
      sourceStoreId: store.id,
      destinationStoreId: other.id,
    });

    const cached = await sourceProductModel.upsert(store.id, {
      id: 6100,
      title: "Screen Test Shirt",
      status: "active",
      variants: [
        { id: 61001, sku: "ST-S", price: "9.00", option1: "S" },
        { id: 61002, sku: "ST-M", price: "9.50", option1: "M" },
        { id: 61003, sku: "ST-L", price: "9.90", option1: "L" },
      ],
    });

    const variants = await sourceVariantModel.listForProduct(cached.id);

    // Offer only two of the three variants.
    const offered = await productMappingModel.ensure({
      connectionId: link.id,
      sourceProductId: cached.id,
      sourceShopifyProductId: cached.shopify_product_id,
      allowedVariantIds: [variants[0].id, variants[2].id],
    });

    const sourceRows = await sourceProductModel.listWithMappingStatus(store.id);
    const row = sourceRows.find((r) => r.id === cached.id);

    check("the source query runs", Boolean(row));
    check("it counts the product as shared", row.allowed === 1, String(row.allowed));
    check("it reports the destination has not accepted",
      row.awaiting === 1, String(row.awaiting));
    check("an unaccepted product is not counted as pending",
      row.pending === 0, String(row.pending));
    check("it returns the variant selection",
      Array.isArray(row.allowed_variant_ids) && row.allowed_variant_ids.length === 2,
      JSON.stringify(row.allowed_variant_ids));

    const destinationRows = await sourceProductModel.listSyncedIntoStore(other.id);
    const incoming = destinationRows.find((r) => r.mapping_id === offered.id);

    check("the destination query runs", Boolean(incoming));
    check("it names the source store",
      incoming.source_shop_domain === `${RUN}-screens.myshopify.com`);
    check("it marks the product as awaiting a decision", incoming.awaiting === true);
    check("it counts only the OFFERED variants",
      incoming.offered_variant_count === 2,
      `${incoming.offered_variant_count} -- the JSON_CONTAINS filter is wrong`);

    // With no narrowing, every variant is on offer.
    await productMappingModel.setAllowedVariants(offered.id, null);
    const widened = (await sourceProductModel.listSyncedIntoStore(other.id))
      .find((r) => r.mapping_id === offered.id);

    check("a product with no narrowing offers all its variants",
      widened.offered_variant_count === 3,
      String(widened.offered_variant_count));

    await productMappingModel.acceptForDestination(other.id, [offered.id]);
    const accepted = (await sourceProductModel.listSyncedIntoStore(other.id))
      .find((r) => r.mapping_id === offered.id);

    check("once accepted it stops awaiting", accepted.awaiting === false);

    /* A change at the source, arriving as a webhook. */
    const productSync = require(path.join(SERVER, "services/productSync"));

    await productMappingModel.markSynced(offered.id, {
      destinationProductId: 8800,
      sourceUpdatedAt: null,
    });

    const changed = await productSync.applySourceUpdate(store.id, {
      id: 6100,
      title: "Screen Test Shirt RENAMED",
      status: "active",
      updated_at: "2026-08-28T09:00:00Z",
      images: [{ src: "https://cdn.example/new.jpg", alt: "New" }],
      options: [{ name: "Size", position: 1, values: ["S", "M", "L"] }],
      variants: [
        { id: 61001, sku: "ST-S", price: "12.00", option1: "S" },
        { id: 61002, sku: "ST-M", price: "12.50", option1: "M" },
        { id: 61003, sku: "ST-L", price: "12.90", option1: "L" },
      ],
    });

    check("a source change is applied", Boolean(changed));
    check("it queues the product for another push",
      changed.requeued === 1, String(changed.requeued));
    check("the mapping really went back to pending",
      (await productMappingModel.findById(offered.id)).sync_status === "pending");

    const refreshed = await sourceProductModel.findById(cached.id);
    check("the cached title is updated",
      refreshed.title === "Screen Test Shirt RENAMED", refreshed.title);
    check("the new price reached the variant cache",
      Number((await sourceVariantModel.listForProduct(cached.id))[0].price) === 12,
      "a price change would never reach the destination");
    check("the new image is cached",
      refreshed.product_data.images[0].url === "https://cdn.example/new.jpg");

    // A product this store does not stage must be ignored, not invented.
    const unknown = await productSync.applySourceUpdate(store.id, {
      id: 999999,
      title: "Never Imported",
      variants: [],
    });
    check("an unstaged product is ignored", unknown === null);
    check("and is not silently added to the table",
      (await sourceProductModel.findByShopifyId(store.id, 999999)) === null);

    // Deleted at the source: the mapping is marked, never dropped.
    const removed = await productSync.applySourceDelete(store.id, 6100);
    check("deletion marks the mappings", removed.marked === 1, String(removed.marked));

    const afterDelete = await productMappingModel.findById(offered.id);
    check("the mapping row survives", Boolean(afterDelete));
    check("it is marked deleted", afterDelete.sync_status === "deleted");
    check("and it still remembers the destination product",
      String(afterDelete.destination_shopify_product_id) === "8800",
      "the link to what was created there was lost");
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
