// controllers/storeController.js
//
// Both store-level screens, because they are two halves of one flow:
//
//   /store-type  chosen ONCE, on first open after install. Permanent.
//   /stores      where that choice leads. What it shows depends on the role:
//                a destination shows a pairing code, a source types one in.
//
// Everything here reuses the existing models -- storeModel for the role,
// services/pairing for the code, connectionModel for the link itself.
const storeModel = require("../models/storeModel");
const connectionModel = require("../models/connectionModel");
const pairing = require("../services/pairing");

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
      "you connect. You will enter a destination's pairing code to connect one.",
  },
  destination: {
    title: "Destination",
    summary: "This store receives products.",
    detail:
      "Products here come from a source store. This store shows a pairing " +
      "code, and the source store enters it to connect.",
  },
};

const ROLES = storeModel.ROLES.map((value) => ({ value, ...ROLE_COPY[value] }));

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
    // Already chosen means this screen is now read-only -- the choice is final.
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

    const isDestination = req.store.store_type === "destination";

    const connections = isDestination
      ? await connectionModel.listForDestination(req.storeId)
      : await connectionModel.listForSource(req.storeId);

    res.render("stores", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      isDestination,
      connections,
      // Only a destination hands a code out.
      pairingCode: isDestination ? liveCode(req.store) : null,
      codeTtlMinutes: pairing.CODE_TTL_MINUTES,
    });
  } catch (err) {
    console.error("Stores screen failed:", err.message);
    res.status(500).send("Error loading stores");
  }
};

/** Destination only: mint a fresh pairing code, replacing any previous one. */
exports.postPairingCode = async (req, res) => {
  if (req.store.store_type !== "destination") {
    return res.status(403).json({
      error: "Only a destination store hands out a pairing code.",
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
 * Source only: take a destination's code and connect the two stores.
 *
 * One action, two steps. redeemCode proves the same operator controls both
 * stores and merges them into a group; createConnection then wires the sync.
 * A valid code IS the consent -- the destination chose to hand it over -- so
 * the connection goes live immediately with nothing to approve.
 *
 * The two steps commit separately on purpose. Pairing is a durable fact about
 * who owns what, and is worth keeping even if the connection insert then fails
 * -- the merchant can retry the connection without redeeming a second code.
 */
exports.postConnect = async (req, res) => {
  if (req.store.store_type !== "source") {
    return res.status(403).json({
      error: "Only a source store connects using a code.",
    });
  }

  const code = String(req.body.code || "").trim();

  if (!code) {
    return res.status(400).json({ error: "Enter the destination's code." });
  }

  let destination;

  try {
    // expectIssuerType is checked inside the transaction, so a code from the
    // wrong kind of store rolls back rather than half-pairing.
    const result = await pairing.redeemCode(req.storeId, code, {
      expectIssuerType: "destination",
    });

    destination = result.linkedWith;
  } catch (err) {
    if (err.name === "PairingError") {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    console.error("Redeeming a pairing code failed:", err.message);
    return res.status(500).json({ error: "Could not use that code." });
  }

  try {
    const connection = await connectionModel.createConnection({
      sourceStoreId: req.storeId,
      destinationStoreId: destination.id,
    });

    console.log(
      `${req.shop} now syncs to ${connection.destination.shop_domain}`
    );

    return res.json({
      ok: true,
      connection: {
        id: connection.id,
        destination: connection.destination.shop_domain,
      },
    });
  } catch (err) {
    if (err.name === "DuplicateConnectionError") {
      // The code was spent pairing stores that were already connected. Say so
      // plainly rather than reporting a failure the merchant cannot act on.
      return res.status(409).json({
        error: `This store is already connected to ${destination.shop_domain}.`,
      });
    }

    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }

    console.error("Creating the connection failed:", err.message);
    return res.status(500).json({ error: "Could not connect those stores." });
  }
};
