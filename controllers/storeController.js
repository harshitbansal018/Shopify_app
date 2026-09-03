// controllers/storeController.js
//
// Both store-level screens, because they are two halves of one flow:
//
//   /store-type  chosen ONCE, on first open after install. Permanent.
//   /stores      where that choice leads. What it shows depends on the role:
//                a SOURCE shows a pairing code, a DESTINATION types one in.
//
// The direction matters: the source owns the catalogue, so it hands out the
// code, and the destination -- the store that wants the products -- redeems it.
//
// Everything here reuses the existing models -- storeModel for the role,
// services/pairing for the code, connectionModel for the link itself.
const storeModel = require("../models/storeModel");
const connectionModel = require("../models/connectionModel");
const syncSettingsModel = require("../models/syncSettingsModel");
const productMappingModel = require("../models/productMappingModel");
const pairing = require("../services/pairing");

/**
 * What each toggle is called on screen.
 *
 * Kept beside the model's field list so a field added there without a label
 * shows its raw name rather than an empty checkbox.
 */
const FIELD_LABELS = {
  title: "Source title",
  description: "Description",
  images: "Images",
  category: "Category",
  status: "Status",
  product_type: "Product type",
  vendor: "Vendor",
  tags: "Tags",
  metafields: "Product metafields",
  inventory: "Inventory",
  variants: "Variants",
  variant_sku: "SKU",
  variant_barcode: "Barcode",
  variant_price: "Price / Compare-at price",
  variant_cost: "Cost per item",
  variant_taxable: "Charge tax on variant",
  variant_continue_selling: "Continue selling when out of stock",
};

/**
 * Human copy for each role, kept beside the values storeModel accepts so the
 * two cannot drift apart.
 */
const ROLE_COPY = {
  source: {
    title: "Source",
    summary: "This store owns the catalogue.",
    detail:
      "Products are read from here and pushed out to the destination stores " +
      "you connect. This store shows a pairing code, which a destination " +
      "store enters to connect.",
  },
  destination: {
    title: "Destination",
    summary: "This store receives products.",
    detail:
      "Products here come from a source store. You will enter the source " +
      "store's pairing code to connect to it.",
  },
};

const ROLES = storeModel.ROLES.map((value) => ({ value, ...ROLE_COPY[value] }));

// Exported so a test can prove every toggle the model knows about has a label.
exports.FIELD_LABELS = FIELD_LABELS;

/* ------------------------------------------------------------------ */
/* /store-type -- the one-time choice                                  */
/* ------------------------------------------------------------------ */

/**
 * Render the picker.
 *
 * Exported because the other screens call it directly for a store with no role
 * yet. Rendering in place rather than redirecting is deliberate: a redirect
 * would drop the id_token off the URL and bounce the merchant into OAuth.
 */
function renderStoreType(req, res) {
  res.render("storeType", {
    shop: req.shop,
    apiKey: process.env.SHOPIFY_API_KEY,
    store: req.store,
    roles: ROLES,
    
    chosen: req.store.store_type || null,
    copy: req.store.store_type ? ROLE_COPY[req.store.store_type] : null,
  });
}

exports.renderStoreType = renderStoreType;

exports.getStoreType = (req, res) => {
  try {
    renderStoreType(req, res);
  } catch (err) {
    console.error("Store type screen failed:", err.message);
    res.status(500).send("Error loading the store type screen");
  }
};

/**
 * Save the choice. Answers JSON: the view posts with appFetch() so the session
 * token travels with the request, then navigates to /stores on success.
 */
exports.postStoreType = async (req, res) => {
  const storeType = String(req.body.store_type || "").trim();

  if (!storeModel.ROLES.includes(storeType)) {
    return res.status(400).json({ error: "Choose either Source or Destination." });
  }

  try {
    const store = await storeModel.chooseStoreType(req.storeId, storeType);

    console.log(`${req.shop} is a ${store.store_type} store`);

    return res.json({ ok: true, store_type: store.store_type });
  } catch (err) {
    if (err.name === "RoleConflictError") {
      return res.status(err.statusCode || 409).json({ error: err.message });
    }

    console.error("Saving store type failed:", err.message);
    return res.status(500).json({ error: "Could not save the store type." });
  }
};

/* ------------------------------------------------------------------ */
/* /stores -- pairing and connections                                  */
/* ------------------------------------------------------------------ */

/** A stored code is only usable until it expires; past that, offer a new one. */
function liveCode(store) {
  if (!store.pairing_code) return null;

  const expiresAt = store.pairing_code_expires_at
    ? new Date(store.pairing_code_expires_at)
    : null;

  if (expiresAt && expiresAt.getTime() <= Date.now()) return null;

  return { code: pairing.formatCode(store.pairing_code), expiresAt };
}

exports.getStores = async (req, res) => {
  try {
    // No role yet: there is nothing to show here until that is decided.
    if (!req.store.store_type) return renderStoreType(req, res);

    const isSource = req.store.store_type === "source";

    const connections = isSource
      ? await connectionModel.listForSource(req.storeId)
      : await connectionModel.listForDestination(req.storeId);

    // Each role has its own screen under views/<role>/.
    res.render(`${req.store.store_type}/stores`, {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      connections,
      // Only a source hands a code out; a destination redeems one.
      pairingCode: isSource ? liveCode(req.store) : null,
      codeTtlMinutes: pairing.CODE_TTL_MINUTES,
    });
  } catch (err) {
    console.error("Stores screen failed:", err.message);
    res.status(500).send("Error loading stores");
  }
};

/** Source only: mint a fresh pairing code, replacing any previous one. */
exports.postPairingCode = async (req, res) => {
  if (req.store.store_type !== "source") {
    return res.status(403).json({
      error: "Only a source store hands out a pairing code.",
    });
  }

  try {
    const { code, expiresAt } = await pairing.issueCode(req.storeId);
    return res.json({ ok: true, code, expiresAt });
  } catch (err) {
    if (err.name === "PairingError") {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    console.error("Issuing a pairing code failed:", err.message);
    return res.status(500).json({ error: "Could not generate a code." });
  }
};

/**
 * Destination only: take a SOURCE store's code and connect the two.
 *
 * One action, two steps. redeemCode proves the same operator controls both
 * stores and merges them into a group; createConnection then wires the sync.
 * A valid code IS the consent -- the source chose to hand it over -- so the
 * connection goes live immediately with nothing to approve.
 *
 * The two steps commit separately on purpose. Pairing is a durable fact about
 * who owns what, and is worth keeping even if the connection insert then fails
 * -- the merchant can retry the connection without redeeming a second code.
 */
exports.postConnect = async (req, res) => {
  if (req.store.store_type !== "destination") {
    return res.status(403).json({
      error: "Only a destination store connects using a code.",
    });
  }

  const code = String(req.body.code || "").trim();

  if (!code) {
    return res.status(400).json({ error: "Enter the source store's code." });
  }

  let source;

  try {
    // expectIssuerType is checked inside the transaction, so a code from the
    // wrong kind of store rolls back rather than half-pairing.
    const result = await pairing.redeemCode(req.storeId, code, {
      expectIssuerType: "source",
    });

    source = result.linkedWith;
  } catch (err) {
    if (err.name === "PairingError") {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    console.error("Redeeming a pairing code failed:", err.message);
    return res.status(500).json({ error: "Could not use that code." });
  }

  try {
    // This store is the DESTINATION; the code's owner is the source.
    const connection = await connectionModel.createConnection({
      sourceStoreId: source.id,
      destinationStoreId: req.storeId,
    });

    console.log(`${req.shop} now receives from ${connection.source.shop_domain}`);

    return res.json({
      ok: true,
      connection: {
        id: connection.id,
        source: connection.source.shop_domain,
      },
    });
  } catch (err) {
    if (err.name === "DuplicateConnectionError") {
      // The code was spent pairing stores that were already connected. Say so
      // plainly rather than reporting a failure the merchant cannot act on.
      return res.status(409).json({
        error: `This store is already connected to ${source.shop_domain}.`,
      });
    }

    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }

    console.error("Creating the connection failed:", err.message);
    return res.status(500).json({ error: "Could not connect those stores." });
  }
  
};
function destinationOnly(req, res) {
  if (req.store.store_type !== "destination") {
    res.status(403).send("Settings are for a destination store.");
    return false;
  }
  return true;
}

exports.getSettings = async (req, res) => {
  try {
    if (!req.store.store_type) return renderStoreType(req, res);
    if (!destinationOnly(req, res)) return;

    const connections = await connectionModel.listForDestination(req.storeId);

    // One batched read, and every connection gets settings whether or not it
    // has a row yet -- an unconfigured connection behaves as "sync everything".
    const settings = await syncSettingsModel.mapForConnections(
      connections.map((connection) => connection.id)
    );

    res.render("destination/settings", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      connections: connections.map((connection) => ({
        ...connection,
        sync: settings.get(connection.id),
      })),
      productFields: syncSettingsModel.PRODUCT_FIELDS,
      variantFields: syncSettingsModel.VARIANT_FIELDS,
      labels: FIELD_LABELS,
    });
  } catch (err) {
    console.error("Settings screen failed:", err.message);
    res.status(500).send("Error loading settings");
  }
};

/**
 * Save one connection's settings, then queue its products.
 *
 * Settings only take effect on the next push, so without the re-queue a
 * merchant would turn something off and see nothing happen until the source
 * next changed the product.
 */
exports.postSettings = async (req, res) => {
  const connectionId = Number(req.body.connection_id);

  if (!destinationOnly(req, res)) return;

  try {
    // The id came from a browser. Prove it belongs to THIS store before
    // writing anything: otherwise a guessed number reconfigures someone else's
    // connection.
    const mine = await connectionModel.listForDestination(req.storeId);

    if (!mine.some((connection) => connection.id === connectionId)) {
      return res.status(404).json({ error: "Connection not found." });
    }

    const saved = await syncSettingsModel.save(connectionId, req.body.settings || {});
    const queued = await productMappingModel.requeueForConnection(connectionId);

    console.log(
      `${req.shop} updated sync settings for connection ${connectionId}; ` +
        `${queued} product(s) queued`
    );

    return res.json({ ok: true, settings: saved, queued });
  } catch (err) {
    console.error("Saving sync settings failed:", err.message);
    return res.status(500).json({ error: "Could not save those settings." });
  }
};

