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

      // Split rather than one long list: the two halves need different
      // controls, and what needs a decision belongs at the top.
      const products = offered.filter((product) => !product.awaiting);
      const awaiting = offered.filter((product) => product.awaiting);

      // One batched query for the whole page, not one per product.
      const variants = await mappingVariantProductModel.mapForMappings(
        offered.map((product) => product.mapping_id)
      );

      const withVariants = (product) => ({
        ...product,
        variants: variants.get(product.mapping_id) || [],
      });

      return res.render("products", {
        shop: req.shop,
        apiKey: process.env.SHOPIFY_API_KEY,
        store: req.store,
        isSource: false,
        products: products.map(withVariants),
        awaiting: awaiting.map(withVariants),
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

    res.render("products", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      isSource: true,
      products: products.map((product) => ({
        ...product,
        variants: variants.get(product.id) || [],
      })),
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
 * Copy the picked products into source_products.
 *
 * The browser posts only ids -- taken from App Bridge's resource picker -- and
 * everything else is re-fetched from Shopify here. Trusting the picker's own
 * payload would let a crafted request write any title and price it liked.
 */
exports.postImport = async (req, res) => {
  if (!sourceOnly(req, res)) return;

  const ids = Array.isArray(req.body.product_ids) ? req.body.product_ids : [];

  if (!ids.length) {
    return res.status(400).json({ error: "Pick at least one product." });
  }

  try {
    const result = await productSync.importProducts(req.shop, req.storeId, ids);

    console.log(
      `${req.shop} imported ${result.imported} product(s), ` +
        `${result.requeued} mapping(s) queued for another push`
    );

    return res.json({
      ok: true,
      imported: result.imported,
      requeued: result.requeued,
    });
  } catch (err) {
    return res.status(err.statusCode || 502).json({
      error: reauthAware(err, "Could not import those products."),
    });
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

      const requested = Array.isArray(selection.variant_ids)
        ? selection.variant_ids.map(Number).filter((id) => own.has(id))
        : null;

      if (requested && !requested.length) {
        return res.status(400).json({
          error: `Pick at least one variant of "${product.title}", or the whole product.`,
        });
      }

      // Every variant ticked is stored as "all", not as a frozen list, so a
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
