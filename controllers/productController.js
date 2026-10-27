// controllers/productController.js
//
// The Products screen, which shows a different thing depending on the role:
//
//   SOURCE       the catalogue table, plus "Add products" to pull more in from
//                Shopify, plus which of them are allowed out to destinations
//   DESTINATION  read-only: what has arrived, and which source store sent it
//
// Two separate selections happen at the source, and they are not the same
// thing:
//
//   1. "Add products"  -> copies products from Shopify into source_products.
//                         Being in the table means the app KNOWS about it.
//   2. "Allow"         -> creates product_mappings rows (pending).
//                         Being allowed means it MAY be pushed.
//
// Keeping them apart is what lets a merchant stage a catalogue without
// anything leaving the store until they say so.
const sourceProductModel = require("../models/sourceProductModel");
const sourceVariantModel = require("../models/sourceVariantModel");
const mappingVariantProductModel = require("../models/mappingVariantProductModel");
const productMappingModel = require("../models/productMappingModel");
const connectionModel = require("../models/connectionModel");
const sourceConnectionSettingsModel = require("../models/sourceConnectionSettingsModel");
const shippingPolicyModel = require("../models/shippingPolicyModel");
const syncSettingsModel = require("../models/syncSettingsModel");
const inventoryAllocationModel = require("../models/inventoryAllocationModel");
const inventoryAllocation = require("../services/inventoryAllocation");
const productSync = require("../services/productSync");
const { renderStoreType } = require("./storeController");
const { paginate } = require("./pagination");

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

exports.getProducts = async (req, res) => {
  try {
    if (!req.store.store_type) return renderStoreType(req, res);

    const isSource = req.store.store_type === "source";

    // What the merchant typed in the search box. Trimmed and capped, and empty
    // means no search at all -- "" must not narrow anything.
    const search = typeof req.query.q === "string"
      ? req.query.q.trim().slice(0, 100)
      : "";

    if (!isSource) {
      // A destination opens on its established catalogue. Unsynced remains
      // available explicitly when the merchant wants to review new offers.
      const tab = req.query.tab === "unsynced" ? "unsynced" : "synced";

      // The store filter: one supplier, or all of them. The id comes from a
      // browser, so it is only ever matched against THIS store's own
      // connections -- a guessed number simply is not in the list, and falls
      // back to "all" rather than to an error or to someone else's products.
      const connections = await connectionModel.listForDestination(req.storeId);
      const requested = typeof req.query.store === "string" ? Number(req.query.store) : NaN;
      const storeFilter = connections.find((c) => c.id === requested) || null;
      const connectionId = storeFilter ? storeFilter.id : null;

      // Counted before anything is read: the tab labels have to name a total
      // the merchant is not looking at, and the pager needs one for the tab
      // they are. Both counts respect the search and the store filter, or the
      // tabs would advertise rows those have hidden.
      const counts = await sourceProductModel.countsSyncedIntoStore(req.storeId, {
        search,
        connectionId,
      });

      const pager = paginate(req, counts[tab], {
        path: "/products",
        // The search and the store filter travel with the page number too.
        // Without them, Next would silently drop the merchant back into the
        // full, unfiltered list.
        params: { tab, q: search, store: connectionId || "" },
      });

      const offered = await sourceProductModel.listSyncedIntoStore(req.storeId, {
        tab,
        search,
        connectionId,
        limit: pager.limit,
        offset: pager.offset,
      });

      // One batched query for the whole page, not one per product -- and now
      // for fifteen rows rather than the whole catalogue.
      const mappingIds = offered.map((product) => product.mapping_id);
      const [variants, allocations] = await Promise.all([
        mappingVariantProductModel.mapForMappings(mappingIds),
        inventoryAllocationModel.mapForMappings(mappingIds),
      ]);

      const withVariants = (product) => {
        const reserved = allocations.get(product.mapping_id) || [];
        const byVariant = new Map(reserved.map((allocation) => [
          Number(allocation.source_variant_mapping_id), allocation,
        ]));
        const productVariants = (variants.get(product.mapping_id) || [])
          .map((variant) => {
            const allocation = byVariant.get(Number(variant.source_variant_mapping_id));
            return allocation
              ? { ...variant, inventory_quantity: allocation.remaining_quantity }
              : variant;
          });

        return {
          ...product,
          // Once allocation is configured, this destination's pool is the
          // only honest stock number -- never the source store's remainder.
          inventory: reserved.length
            ? reserved.reduce((sum, allocation) =>
                sum + allocation.remaining_quantity, 0)
            : product.inventory,
          variants: productVariants,
        };
      };

      return res.render("destination/products", {
        shop: req.shop,
        apiKey: process.env.SHOPIFY_API_KEY,
        store: req.store,
        tab,
        counts,
        pager,
        search,
        storeFilter: connectionId,
        products: offered.map(withVariants),
        connections,
      });
    }

    // ONE list with a filter over it, rather than two tabs. Two tabs made the
    // catalogue look like two catalogues, and hid from the merchant how much
    // of it is actually out there.
    //
    // Defaults to everything: the screen's job is to show the catalogue, and
    // narrowing it is the merchant's choice to make.
    const FILTERS = ["all", "shared", "unshared"];
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : "all";

    // Every count, not just the visible one: the filter has to say how many it
    // would show before the merchant picks it.
    // While a search is running these count what MATCHES: "Shared (48)" beside
    // three visible rows would read as a broken filter.
    const connections = await connectionModel.listForSource(req.storeId);

    // Scope the aggregate status to one destination when requested. The id
    // is accepted only if it belongs to this source; a guessed connection id
    // simply falls back to All stores.
    const requestedStore = typeof req.query.store === "string"
      ? Number(req.query.store)
      : NaN;
    const selectedConnection = connections.find(
      (connection) => connection.id === requestedStore
    ) || null;
    const storeFilter = selectedConnection ? selectedConnection.id : null;

    const counts = await sourceProductModel.countsWithMappingStatus(req.storeId, {
      search,
      connectionId: storeFilter,
    });

    const pager = paginate(req, counts[filter], {
      path: "/products",
      // The filter and the search travel with the page number, or Next would
      // drop the merchant back into the full catalogue.
      params: {
        filter: filter === "all" ? "" : filter,
        q: search,
        store: storeFilter || "",
      },
    });

    const products = await sourceProductModel.listWithMappingStatus(req.storeId, {
      filter,
      search,
      connectionId: storeFilter,
      limit: pager.limit,
      offset: pager.offset,
    });

    const variants = await sourceVariantModel.mapForProducts(
      products.map((product) => product.id)
    );

    // effective, not allowed: before a product is shared there is no mapping,
    // and what counts is the choice made in the picker when it was added.
    const withVariants = (product) => {
      const all = variants.get(product.id) || [];
      const picked = product.effective_variant_ids; // null = every variant

      return {
        ...product,
        variants: picked
          ? all.filter((variant) => picked.indexOf(variant.id) !== -1)
          : all,
      };
    };

    res.render("source/products", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      filter,
      counts,
      pager,
      search,
      storeFilter,
      products: products.map(withVariants),

      connections,
      // Nothing can be allowed until there is somewhere to send it.
      activeConnections: connections.filter((c) => c.status === "active"),
    });

  } catch (err) {
    console.error("Products screen failed:", err.message);
    res.status(500).send("Error loading products");
  }
};

/* ------------------------------------------------------------------ */
/* Source actions                                                      */
/* ------------------------------------------------------------------ */

function sourceOnly(req, res) {
  if (req.store.store_type !== "source") {
    res.status(403).json({ error: "Only a source store manages products." });
    return false;
  }
  return true;
}

/**
 * Record which variants the picker came back with, for each product.
 *
 * Shopify's ids are translated into OUR row ids -- what every screen and the
 * push work with -- and the result is copied onto any existing mappings so an
 * already-shared product starts sending the new selection.
 *
 * A pick with no variants listed, or one covering all of them, means "every
 * variant": setSelectedVariants stores that as NULL so a variant added at the
 * source later still flows.
 */
async function recordSelections(storeId, picks, { existingIds = new Set() } = {}) {
  let narrowed = 0;
  let shared = 0;
  let unshared = 0;
  let added = 0;
  let alreadyAdded = 0;
  let updated = 0;

  for (const pick of picks) {
    const cached = await sourceProductModel.findByShopifyId(storeId, pick.id);

    if (!cached) continue;

    // Use the same definition as the source Products filters: a product is
    // shared when at least one destination mapping exists for it.
    const mappings = await productMappingModel.listForSourceProduct(cached.id);
    if (mappings.length) shared += 1;
    else unshared += 1;

    const rows = await sourceVariantModel.listForProduct(cached.id);
    const wanted = new Set((pick.variant_ids || []).map(String));

    const ours = wanted.size
      ? rows
          .filter((row) => wanted.has(String(row.shopify_variant_id)))
          .map((row) => row.id)
      : rows.map((row) => row.id);

    // Nothing matched -- the picker sent variant ids from another product, or
    // they have since been deleted. Leave the product's selection alone rather
    // than silently emptying it.
    if (!ours.length) continue;

    const saved = await sourceProductModel.setSelectedVariants(
      cached.id,
      ours,
      rows.length
    );

    if (saved.selected_variant_ids) narrowed += 1;

    if (!existingIds.has(String(pick.id))) {
      added += 1;
    } else if (
      JSON.stringify(cached.selected_variant_ids || null) !==
      JSON.stringify(saved.selected_variant_ids || null)
    ) {
      updated += 1;
    } else {
      alreadyAdded += 1;
    }

    // Carry it onto the mappings, or a shared product would keep sending the
    // variants it was sharing before.
    await productMappingModel.setAllowedVariantsForProduct(
      cached.id,
      saved.selected_variant_ids
    );
  }

  return { narrowed, shared, unshared, added, alreadyAdded, updated };
}

/** Which source Products filter best represents what the picker just added. */
function filterForImportedSelection({ shared = 0, unshared = 0 } = {}) {
  if (shared > 0 && unshared > 0) return "all";
  if (shared > 0) return "shared";
  if (unshared > 0) return "unshared";
  return "all";
}

exports.filterForImportedSelection = filterForImportedSelection;

/** A short popup that distinguishes new products from existing selections. */
function noticeForImportedSelection({
  added = 0,
  alreadyAdded = 0,
  updated = 0,
} = {}) {
  if (added > 0 && updated === 0 && alreadyAdded === 0) {
    return added === 1
      ? "Product added."
      : `${added} products added.`;
  }

  if (alreadyAdded > 0 && added === 0 && updated === 0) {
    return alreadyAdded === 1
      ? "This product is already added."
      : `${alreadyAdded} products are already added.`;
  }

  if (updated > 0 && added === 0 && alreadyAdded === 0) {
    return updated === 1
      ? "Product already added. Variant selection updated."
      : `${updated} already-added products had their variant selections updated.`;
  }

  const parts = [];

  if (added > 0) {
    parts.push(added === 1 ? "1 product added." : `${added} products added.`);
  }

  if (updated > 0) {
    parts.push(
      updated === 1
        ? "1 already-added product's variant selection updated."
        : `${updated} already-added products' variant selections updated.`
    );
  }

  if (alreadyAdded > 0) {
    parts.push(
      alreadyAdded === 1
        ? "1 product was already added."
        : `${alreadyAdded} products were already added.`
    );
  }

  return parts.join(" ") || "No products were added.";
}

exports.noticeForImportedSelection = noticeForImportedSelection;

/**
 * Copy the picked products into source_products.
 *
 * The browser posts only ids -- taken from App Bridge's resource picker -- and
 * everything else is re-fetched from Shopify here. Trusting the picker's own
 * payload would let a crafted request write any title and price it liked.
 */
exports.postImport = async (req, res) => {
  if (!sourceOnly(req, res)) return;

  // [{ id, variant_ids: [...] }] -- the picker reopens pre-ticked with the
  // current choice, so whatever comes back IS the new choice. Products the
  // merchant did not touch are simply absent and keep what they had.
  const rawPicks = Array.isArray(req.body.products) ? req.body.products : [];
  // The Shopify picker returns one entry per product, but the endpoint is
  // public to any authenticated client. De-duplicate a crafted payload too,
  // otherwise one product could inflate the popup counts.
  const picks = [...new Map(
    rawPicks
      .filter(
        (pick) =>
          pick && pick.id !== undefined && pick.id !== null && String(pick.id)
      )
      .map((pick) => [String(pick.id), pick])
  ).values()];

  if (!picks.length) {
    return res.status(400).json({ error: "Pick at least one product." });
  }

  try {
    // Snapshot membership before the upsert. source_products deliberately
    // updates an existing row in place, so checking afterwards cannot tell a
    // genuinely new pick from a product the merchant selected again.
    const existingIds = new Set();
    const uniquePickIds = [...new Set(picks.map((pick) => String(pick.id)))];

    for (const id of uniquePickIds) {
      if (await sourceProductModel.findByShopifyId(req.storeId, id)) {
        existingIds.add(id);
      }
    }

    const result = await productSync.importProducts(
      req.shop,
      req.storeId,
      picks.map((pick) => pick.id)
    );

    // A deleted Shopify id can come back as null. Classify only products that
    // were actually returned and imported, not a stale id from the request.
    const importedIds = new Set(
      (result.products || []).map((product) => String(product.id))
    );
    const selection = await recordSelections(
      req.storeId,
      picks.filter((pick) => importedIds.has(String(pick.id))),
      { existingIds }
    );
    const filter = filterForImportedSelection(selection);
    const message = noticeForImportedSelection(selection);

    console.log(
      `${req.shop} imported ${result.imported} product(s), ` +
        `${selection.narrowed} narrowed, ` +
        `${result.requeued} mapping(s) queued for another push`
    );

    return res.json({
      ok: true,
      imported: result.imported,
      added: selection.added,
      alreadyAdded: selection.alreadyAdded,
      updated: selection.updated,
      narrowed: selection.narrowed,
      requeued: result.requeued,
      filter,
      message,
    });
  } catch (err) {
    return res.status(err.statusCode || 502).json({
      error: reauthAware(err, "Could not import those products."),
    });
  }
};

/**
 * One product's own page: the variants that are actually being shared.
 *
 * The table lists products; this lists what goes out for one of them, and is
 * where a variant is dropped from the offer.
 */
exports.getProduct = async (req, res) => {
  try {
    if (!req.store.store_type) return renderStoreType(req, res);

    // The two roles key this page differently, because they hold different
    // things: a source owns the product row, a destination only ever sees it
    // through the mapping that offered it.
    if (req.store.store_type === "destination") {
      const offered = await sourceProductModel.findOfferedByMapping(
        req.storeId,
        req.params.id
      );

      if (!offered) return res.status(404).send("Product not found");

      const [mappedVariants, sourceSettings, shippingPolicy, allocations] = await Promise.all([
        mappingVariantProductModel.mapForMappings([offered.mapping_id]),
        sourceConnectionSettingsModel.forConnection(offered.connection_id),
        shippingPolicyModel.forConnection(offered.connection_id, {
          currency: offered.destination_currency || null,
        }),
        inventoryAllocationModel.listForConnectionProduct(
          offered.connection_id,
          offered.source_product_id
        ),
      ]);

      const allocationByVariant = new Map(allocations.map((allocation) => [
        Number(allocation.source_variant_mapping_id), allocation,
      ]));
      let shared = mappedVariants.get(offered.mapping_id) || [];

      // Before acceptance there are no destination variant-link rows yet.
      // Still show the offer and its reserved quantities from the source rows.
      if (!shared.length) {
        const sourceVariants = await sourceVariantModel.listForProduct(
          offered.source_product_id
        );
        shared = productSync.selectVariants(
          sourceVariants,
          offered.allowed_variant_ids
        ).map((variant) => ({
          source_variant_mapping_id: variant.id,
          source_title: variant.title,
          source_price: variant.price,
          sku: variant.sku,
          option1: variant.option1,
          option2: variant.option2,
          option3: variant.option3,
          inventory_quantity: variant.inventory_quantity,
        }));
      }

      shared = shared.map((variant) => {
        const allocation = allocationByVariant.get(
          Number(variant.source_variant_mapping_id)
        );
        return allocation
          ? {
              ...variant,
              inventory_quantity: allocation.remaining_quantity,
              allocated_quantity: allocation.allocated_quantity,
              sold_quantity: allocation.sold_quantity,
            }
          : variant;
      });

      return res.render("destination/productDetail", {
        shop: req.shop,
        apiKey: process.env.SHOPIFY_API_KEY,
        store: req.store,
        product: offered,
        shared,
        totalVariants: offered.offered_variant_count,
        isShared: !offered.awaiting,
        sourceSettings,
        shippingPolicy,
      });
    }

    const product = await sourceProductModel.findById(req.params.id);

    // Same check, same reason, as every other handler here: the id came from
    // a URL, so it proves nothing until the row says it belongs to this store.
    if (!product || product.store_id !== req.storeId) {
      return res.status(404).send("Product not found");
    }

    const variants = await sourceVariantModel.listForProduct(product.id);
    const mappings = await productMappingModel.listForSourceProduct(product.id);

    // Once the product is shared the mapping is authoritative -- every
    // connection carries the same selection, so any live one describes it.
    // Before that, the picker's choice is what there is. Both use null for
    // "every variant".
    const live = mappings.find((mapping) => mapping.sync_status !== "deleted");
    const picked = live ? live.allowed_variant_ids : product.selected_variant_ids;

    // Keep paused connections visible here as disabled allocation targets.
    // Hiding the column entirely makes an existing share look as though the
    // inventory feature disappeared; the write endpoint still requires active.
    const productConnections = await connectionModel.listForSource(req.storeId);
    const mappingByConnection = new Map(mappings.map((mapping) => [
      Number(mapping.connection_id), mapping,
    ]));
    const allocationDestinations = [];

    for (const connection of productConnections) {
      const mapping = mappingByConnection.get(Number(connection.id));
      if (!mapping || mapping.sync_status === "deleted") continue;

      const [allocations, syncSettings] = await Promise.all([
        inventoryAllocationModel.listForConnectionProduct(
          connection.id,
          product.id
        ),
        syncSettingsModel.forConnection(connection.id),
      ]);
      const byVariant = new Map(allocations.map((allocation) => [
        Number(allocation.source_variant_mapping_id), allocation,
      ]));

      allocationDestinations.push({
        connection,
        mapping,
        allocations: byVariant,
        inventoryEnabled:
          connection.status === "active" && syncSettings.inventory !== false,
      });
    }

    res.render("source/productDetail", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      product,
      shared: picked
        ? variants.filter((variant) => picked.indexOf(variant.id) !== -1)
        : variants,
      totalVariants: variants.length,
      isShared: mappings.length > 0,
      allocationDestinations,
    });
  } catch (err) {
    console.error("Product page failed:", err.message);
    res.status(500).send("Error loading product");
  }
};

/** Stop sharing one variant. The others carry on. */
exports.postRemoveVariant = async (req, res) => {
  if (!sourceOnly(req, res)) return;

  try {
    const product = await sourceProductModel.findById(req.params.id);

    if (!product || product.store_id !== req.storeId) {
      return res.status(404).json({ error: "Product not found." });
    }

    const variants = await sourceVariantModel.listForProduct(product.id);
    const variantId = Number(req.body.variant_id);

    if (!variants.some((variant) => Number(variant.id) === variantId)) {
      return res.status(400).json({ error: "That variant is not on this product." });
    }

    const every = variants.map((variant) => variant.id);

    // Two places hold a selection and both have to lose the variant: the
    // mapping is what the push reads, the product's own choice is what an
    // UNSHARED product shows -- and what Allow would later copy back over.
    const current = product.selected_variant_ids || every;
    const remaining = current.filter((id) => Number(id) !== variantId);

    if (!remaining.length) {
      return res.status(409).json({
        error: "This is the only variant being shared. Delete the product instead.",
      });
    }

    const reserved = (await inventoryAllocationModel.listForProduct(product.id))
      .filter((allocation) =>
        Number(allocation.source_variant_mapping_id) === variantId
      )
      .reduce((sum, allocation) => sum + allocation.remaining_quantity, 0);
    if (reserved > 0) {
      return res.status(409).json({
        error:
          `Return the ${reserved} unsold reserved unit(s) before removing this variant.`,
      });
    }

    const changed = await productMappingModel.removeAllowedVariant(
      product.id,
      variantId,
      every
    );

    await sourceProductModel.setSelectedVariants(product.id, remaining, every.length);

    return res.json({ ok: true, changed });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }

    console.error("Removing a variant failed:", err.message);
    return res.status(500).json({ error: "Could not remove that variant." });
  }
};

/**
 * Delete a product from this app AND from every destination it reached.
 *
 * The destination delete happens FIRST and the local rows are only dropped if
 * it worked. Doing it the other way round would lose the id of the product on
 * the destination, leaving one behind that nothing can ever find again.
 */
exports.postDeleteProduct = async (req, res) => {
  if (!sourceOnly(req, res)) return;

  try {
    const product = await sourceProductModel.findById(req.params.id);

    if (!product || product.store_id !== req.storeId) {
      return res.status(404).json({ error: "Product not found." });
    }

    const result = await productSync.deleteFromDestinations(product.id);

    if (result.failed) {
      // Keep everything: the merchant can retry, and the mapping still knows
      // which product to remove.
      return res.status(502).json({
        error:
          `Deleted from ${result.deleted} store(s), but ${result.failed} failed. ` +
          `Nothing was removed here so you can try again. ${result.errors[0] || ""}`,
      });
    }

    // Return every unsold reserved unit before the allocation rows cascade.
    await inventoryAllocation.releaseProduct(req.store, product.id);

    // Cascades to the mappings, allocations, cached variants and variant links.
    await sourceProductModel.deleteByShopifyId(
      req.storeId,
      product.shopify_product_id
    );

    console.log(
      `${req.shop} deleted "${product.title}" ` +
        `(${result.deleted} destination store(s), ${result.skipped} never pushed)`
    );

    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(err.statusCode || 502).json({
      error: reauthAware(err, "Could not delete that product."),
    });
  }
};

/** Reserve source inventory for one destination, variant by variant. */
exports.postInventoryAllocation = async (req, res) => {
  if (!sourceOnly(req, res)) return;

  try {
    const product = await sourceProductModel.findById(req.params.id);
    if (!product || product.store_id !== req.storeId) {
      return res.status(404).json({ error: "Product not found." });
    }

    const connectionId = Number(req.body.connection_id);
    const connections = await connectionModel.listForSource(req.storeId);
    const connection = connections.find((item) =>
      Number(item.id) === connectionId && item.status === "active"
    );
    if (!connection) {
      return res.status(404).json({ error: "Destination store not found." });
    }

    const mapping = (await productMappingModel.listForSourceProduct(product.id))
      .find((item) => Number(item.connection_id) === connectionId &&
        item.sync_status !== "deleted");
    if (!mapping) {
      return res.status(409).json({
        error: "Allow this product to the destination before allocating stock.",
      });
    }

    const syncSettings = await syncSettingsModel.forConnection(connection.id);
    if (syncSettings.inventory === false) {
      return res.status(409).json({
        error:
          "Inventory sync is off for this destination. Enable it in the destination Settings first.",
      });
    }

    if (!mapping.accepted_at && mapping.destination_shopify_product_id) {
      return res.status(409).json({
        error:
          "This destination has unsynced the product but still keeps its Shopify copy. " +
          "Remove the destination connection before returning that stock.",
      });
    }

    const variants = await sourceVariantModel.listForProduct(product.id);
    const allowed = new Set(productSync.selectVariants(
      variants,
      mapping.allowed_variant_ids
    ).map((variant) => Number(variant.id)));
    const targets = Array.isArray(req.body.allocations) ? req.body.allocations : [];
    if (targets.some((target) => !allowed.has(Number(target.variant_id)))) {
      return res.status(400).json({
        error: "One or more variants are not shared with this destination.",
      });
    }

    const beforeRows = await inventoryAllocationModel.listForConnectionProduct(
      connection.id,
      product.id
    );
    const beforeByVariant = new Map(beforeRows.map((allocation) => [
      Number(allocation.source_variant_mapping_id),
      allocation.allocated_quantity,
    ]));
    const allocations = await inventoryAllocation.setForProduct({
      store: req.store,
      connection,
      product,
      targets,
    });

    let destinationSynced = false;
    try {
      const pushed = await inventoryAllocation.syncDestination(
        connection,
        mapping,
        product.id
      );
      destinationSynced = pushed.synced;
    } catch (syncError) {
      // Source stock has already moved. Restore the exact prior reservation
      // before reporting failure, so a destination that rejected the update
      // can never keep units that are also sellable at the source.
      await inventoryAllocation.setForProduct({
        store: req.store,
        connection,
        product,
        targets: targets.map((target) => ({
          variant_id: target.variant_id,
          quantity: beforeByVariant.get(Number(target.variant_id)) || 0,
        })),
      });
      throw syncError;
    }

    return res.json({
      ok: true,
      allocations,
      queued: !destinationSynced,
      destinationSynced,
    });
  } catch (err) {
    console.error("Saving inventory allocation failed:", err.message);
    return res.status(err.statusCode || 502).json({
      error: reauthAware(err, "Could not save the inventory allocation."),
    });
  }
};

/**
 * Put every variant of a product back on offer.
 *
 * The table only lists variants that are actually shared, so a narrowed
 * product has no checkbox left for the ones it left out. This is the way back:
 * clearing the selection makes all of them visible and shareable again.
 */
exports.postResetVariants = async (req, res) => {
  if (!sourceOnly(req, res)) return;

  const ids = Array.isArray(req.body.source_product_ids)
    ? req.body.source_product_ids
    : [];

  if (!ids.length) {
    return res.status(400).json({ error: "Pick at least one product." });
  }

  try {
    let reset = 0;

    for (const id of ids) {
      // Re-read rather than trusting the posted id, exactly as postAllow does:
      // this proves the product belongs to THIS store.
      const product = await sourceProductModel.findById(id);

      if (!product || product.store_id !== req.storeId) continue;

      reset += await productMappingModel.resetAllowedVariantsForProduct(product.id);

      // Clear the picker's choice too, or an unshared product would still be
      // showing only some of its variants.
      await sourceProductModel.setSelectedVariants(product.id, [], null);
    }

    console.log(`${req.shop} reset the variant selection on ${reset} mapping(s)`);

    return res.json({ ok: true, reset });
  } catch (err) {
    console.error("Resetting the variant selection failed:", err.message);
    return res.status(500).json({ error: "Could not reset that selection." });
  }
};

/**
 * Allow products on the active connections selected by the source.
 *
 * Allowing creates a pending mapping; nothing is sent to Shopify here. The
 * push happens in postSync, so allowing a hundred products stays instant.
 */
exports.postAllow = async (req, res) => {
  if (!sourceOnly(req, res)) return;

  // [{ source_product_id, variant_ids: [..] | null }]. A null or absent
  // variant_ids means every variant, including ones added at the source later.
  const selections = Array.isArray(req.body.selections) ? req.body.selections : [];

  if (!selections.length) {
    return res.status(400).json({ error: "Pick at least one product." });
  }

  try {
    const activeConnections = (await connectionModel.listForSource(req.storeId)).filter(
      (connection) => connection.status === "active"
    );

    if (!activeConnections.length) {
      return res.status(409).json({
        error:
          "No destination store is connected yet. Connect one from Stores first.",
        code: "DESTINATION_REQUIRED",
        redirect:
          "/stores?returnTo=" +
          encodeURIComponent("/products?filter=unshared"),
      });
    }

    // The source chooses where this particular share goes. Connection ids are
    // never trusted directly: only active connections owned by this source
    // may survive the filter. Keep the one-destination fallback for older
    // clients, where there was no choice to make.
    const requestedConnectionIds = [...new Set(
      (Array.isArray(req.body.connection_ids) ? req.body.connection_ids : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0)
    )];

    const connections = requestedConnectionIds.length
      ? activeConnections.filter((connection) =>
          requestedConnectionIds.includes(Number(connection.id))
        )
      : activeConnections.length === 1
        ? activeConnections
        : [];

    if (!connections.length) {
      return res.status(400).json({
        error: "Select at least one destination store.",
      });
    }

    if (connections.length !== requestedConnectionIds.length && requestedConnectionIds.length) {
      return res.status(400).json({
        error: "One or more selected destination stores are unavailable.",
      });
    }

    let allowed = 0;

    for (const selection of selections) {
      // Re-read rather than trusting the posted id: this proves the product
      // belongs to THIS store before it is shared anywhere.
      const product = await sourceProductModel.findById(selection.source_product_id);

      if (!product || product.store_id !== req.storeId) continue;

      // Same for the variants: only ids that really belong to this product may
      // be recorded, so a crafted request cannot reference someone else's.
      const own = new Set(
        (await sourceVariantModel.listForProduct(product.id)).map((v) => Number(v.id))
      );

      // Nothing posted means "use what was ticked in the picker", which is the
      // normal path: the table shares whole rows and the variant choice was
      // already made when the product was added.
      const requested = Array.isArray(selection.variant_ids)
        ? selection.variant_ids.map(Number).filter((id) => own.has(id))
        : product.selected_variant_ids || null;

      if (requested && !requested.length) {
        return res.status(400).json({
          error: `Pick at least one variant of "${product.title}", or the whole product.`,
        });
      }

      // Every variant chosen is stored as "all", not as a frozen list, so a
      // variant added at the source later still flows.
      const allowedVariantIds =
        requested && requested.length < own.size ? requested : null;

      for (const connection of connections) {
        await productMappingModel.ensure({
          connectionId: connection.id,
          sourceProductId: product.id,
          sourceShopifyProductId: product.shopify_product_id,
          sourceUpdatedAt: product.shopify_updated_at,
          allowedVariantIds,
        });
        allowed += 1;
      }
    }

    return res.json({
      ok: true,
      allowed,
      destinations: connections.length,
    });
  } catch (err) {
    console.error("Allowing products failed:", err.message);
    return res.status(500).json({ error: "Could not allow those products." });
  }
};

/**
 * Push what is pending AND accepted.
 *
 * Only the destination triggers this. The source's job ends at offering: it
 * decides WHAT may be shared, the destination decides WHEN its own store is
 * written to. pushPending filters on accepted_at, so even a hand-made request
 * cannot move a product the destination never ticked.
 */
async function runSync(req, res, connections) {
  if (!connections.length) {
    return res.status(409).json({ error: "No active connection to sync." });
  }

  const totals = { synced: 0, failed: 0 };

  for (const connection of connections) {
    const result = await productSync.pushPending(connection.id);
    totals.synced += result.synced;
    totals.failed += result.failed;
  }

  console.log(`${req.shop} sync: ${totals.synced} synced, ${totals.failed} failed`);

  return res.json({ ok: true, ...totals });
}

/* ------------------------------------------------------------------ */
/* Destination actions                                                 */
/* ------------------------------------------------------------------ */

function destinationOnly(req, res) {
  if (req.store.store_type !== "destination") {
    res.status(403).json({
      error: "Only a destination store pulls products in.",
    });
    return false;
  }
  return true;
}

/**
 * Refresh the products this store picked.
 *
 * Adds nothing new: the ticked rows go back to 'pending' and are pushed
 * again, which is what carries a change made at the source across. Anything
 * still awaiting a decision is untouched.
 *
 * A selection is required. The button that calls this sits beside Unsync
 * selected and is disabled until rows are ticked, so a request arriving
 * without any is a request that bypassed the screen.
 */
exports.postSync = async (req, res) => {
  if (!destinationOnly(req, res)) return;

  const ids = Array.isArray(req.body.mapping_ids) ? req.body.mapping_ids : [];

  if (!ids.length) {
    return res.status(400).json({ error: "Pick at least one product." });
  }

  try {
    const requeued = await productMappingModel.requeueForDestination(
      req.storeId,
      ids
    );

    if (!requeued) {
      return res.status(404).json({
        error: "Those products are not in your store.",
      });
    }

    return await runSync(
      req,
      res,
      (await connectionModel.listForDestination(req.storeId)).filter(
        (connection) => connection.status === "active"
      )
    );
  } catch (err) {
    return res.status(err.statusCode || 502).json({
      error: reauthAware(err, "The sync could not finish."),
    });
  }
};

/**
 * The destination accepting offered products, then pulling them in.
 *
 * Accept and push are one action on purpose: a merchant who ticks a product
 * and presses the button means "put this in my store", and leaving it queued
 * for someone else to press a second button would just look broken.
 */
exports.postAccept = async (req, res) => {
  if (!destinationOnly(req, res)) return;

  const ids = Array.isArray(req.body.mapping_ids) ? req.body.mapping_ids : [];

  if (!ids.length) {
    return res.status(400).json({ error: "Pick at least one product." });
  }

  try {
    // Scoped to this store inside the model, so a guessed id cannot push a
    // product into someone else's shop -- and held to the plan's product
    // limit in the same transaction, so two tabs cannot both take the last
    // slot. All or nothing: a partly-accepted pick leaves the merchant
    // guessing which ones made it.
    const result = await require("../services/planLimits").acceptProducts(
      req.store,
      ids
    );

    if (result.refused) {
      return res.status(409).json({
        error: result.message,
        limit: {
          used: result.used,
          limit: result.limit,
          remaining: result.remaining,
        },
      });
    }

    if (!result.accepted) {
      return res.status(409).json({
        error: "Those products are not waiting for this store.",
      });
    }

    return await runSync(
      req,
      res,
      (await connectionModel.listForDestination(req.storeId)).filter(
        (connection) => connection.status === "active"
      )
    );
  } catch (err) {
    return res.status(err.statusCode || 502).json({
      error: reauthAware(err, "Could not add those products."),
    });
  }
};

/** The destination refusing, or removing, an offered product. */
exports.postDecline = async (req, res) => {
  if (!destinationOnly(req, res)) return;

  const ids = Array.isArray(req.body.mapping_ids) ? req.body.mapping_ids : [];

  if (!ids.length) {
    return res.status(400).json({ error: "Pick at least one product." });
  }

  try {
    const declined = await productMappingModel.declineForDestination(
      req.storeId,
      ids
    );

    // The product already in the destination store is left alone: this stops
    // future updates, it does not delete what the merchant already has.
    return res.json({ ok: true, declined });
  } catch (err) {
    console.error("Declining products failed:", err.message);
    return res.status(500).json({ error: "Could not decline those products." });
  }
};

/**
 * A dead token needs a reinstall, and saying so is far more useful than
 * "something went wrong" -- the merchant cannot guess that from a 500.
 */
function reauthAware(err, fallback) {
  if (err.name === "ReauthRequiredError") {
    return "This store needs to be reconnected. Reinstall the app to continue.";
  }

  console.error(`${fallback}:`, err.message);
  return fallback;
}
