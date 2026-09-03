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
const productSync = require("../services/productSync");
const { renderStoreType } = require("./storeController");

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

exports.getProducts = async (req, res) => {
  try {
    if (!req.store.store_type) return renderStoreType(req, res);

    const isSource = req.store.store_type === "source";

    if (!isSource) {
      const offered = await sourceProductModel.listSyncedIntoStore(req.storeId);

      const synced = offered.filter((product) => !product.awaiting);
      const unsynced = offered.filter((product) => product.awaiting);

      // Land on whichever tab has something to do. A merchant opening this
      // screen almost always came because something is waiting.
      const requested = req.query.tab === "synced" ? "synced" : req.query.tab;
      const tab = requested || (unsynced.length ? "unsynced" : "synced");

      // One batched query for the whole page, not one per product.
      const variants = await mappingVariantProductModel.mapForMappings(
        offered.map((product) => product.mapping_id)
      );

      const withVariants = (product) => ({
        ...product,
        variants: variants.get(product.mapping_id) || [],
      });

      return res.render("destination/products", {
        shop: req.shop,
        apiKey: process.env.SHOPIFY_API_KEY,
        store: req.store,
        tab,
        counts: { synced: synced.length, unsynced: unsynced.length },
        products: (tab === "synced" ? synced : unsynced).map(withVariants),
        connections: await connectionModel.listForDestination(req.storeId),
      });
    }

    const [products, connections] = await Promise.all([
      sourceProductModel.listWithMappingStatus(req.storeId),
      connectionModel.listForSource(req.storeId),
    ]);

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

    const shared = products.filter((product) => product.allowed > 0);
    const unshared = products.filter((product) => !product.allowed);

    // Land on whichever tab has something to do.
    const requested = req.query.tab === "shared" ? "shared" : req.query.tab;
    const tab = requested || (unshared.length ? "unshared" : "shared");

    res.render("source/products", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      tab,
      counts: { shared: shared.length, unshared: unshared.length },
      products: (tab === "shared" ? shared : unshared).map(withVariants),

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
async function recordSelections(storeId, picks) {
  let narrowed = 0;

  for (const pick of picks) {
    const cached = await sourceProductModel.findByShopifyId(storeId, pick.id);

    if (!cached) continue;

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

    // Carry it onto the mappings, or a shared product would keep sending the
    // variants it was sharing before.
    await productMappingModel.setAllowedVariantsForProduct(
      cached.id,
      saved.selected_variant_ids
    );
  }

  return { narrowed };
}

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
  const picks = Array.isArray(req.body.products) ? req.body.products : [];

  if (!picks.length) {
    return res.status(400).json({ error: "Pick at least one product." });
  }

  try {
    const result = await productSync.importProducts(
      req.shop,
      req.storeId,
      picks.map((pick) => pick.id)
    );

    const selection = await recordSelections(req.storeId, picks);

    console.log(
      `${req.shop} imported ${result.imported} product(s), ` +
        `${selection.narrowed} narrowed, ` +
        `${result.requeued} mapping(s) queued for another push`
    );

    return res.json({
      ok: true,
      imported: result.imported,
      narrowed: selection.narrowed,
      requeued: result.requeued,
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

      const variants = await mappingVariantProductModel.mapForMappings([
        offered.mapping_id,
      ]);

      return res.render("destination/productDetail", {
        shop: req.shop,
        apiKey: process.env.SHOPIFY_API_KEY,
        store: req.store,
        product: offered,
        shared: variants.get(offered.mapping_id) || [],
        totalVariants: offered.offered_variant_count,
        isShared: !offered.awaiting,
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

    // Cascades to the mappings, the cached variants and the variant links.
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
 * Allow (or stop allowing) products on every active connection.
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
    const connections = (await connectionModel.listForSource(req.storeId)).filter(
      (connection) => connection.status === "active"
    );

    if (!connections.length) {
      return res.status(409).json({
        error:
          "No destination store is connected yet. Connect one from Stores first.",
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
 * Refresh products this store has already accepted.
 *
 * Adds nothing new: a product the source has since changed goes back to
 * 'pending', and this is what carries that change across. Anything still
 * awaiting a decision is untouched.
 */
exports.postSync = async (req, res) => {
  if (!destinationOnly(req, res)) return;

  try {
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
    // product into someone else's shop.
    const accepted = await productMappingModel.acceptForDestination(
      req.storeId,
      ids
    );

    if (!accepted) {
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
