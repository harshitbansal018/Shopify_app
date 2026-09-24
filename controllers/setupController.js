// controllers/setupController.js
//
// The screen a store lands on after it picks its side, and the app's home
// until it is finished.
//
// Nothing about a step's progress is stored. Every step is decided from the
// store's own data each time the screen is drawn, because a saved tick and
// the real thing come apart the moment a merchant undoes something -- deletes
// the products they added, removes the supplier they connected. A screen that
// says "done" about something no longer true is worse than no screen.
//
// The one thing written down is stores.onboarded_at, and it answers a
// different question: should the app still OPEN here. Finishing sets it, and
// so does Skip.
//
// Steps come in three shapes:
//
//   ready     the merchant can do it now. It carries the button.
//   waiting   the merchant has done their part and the other store has not.
//             Never shown as done -- see `pairing` below for why that matters.
//   locked    an earlier step has to happen first. No button, and it says
//             which step it is waiting on rather than just greying out.
const storeModel = require("../models/storeModel");
const connectionModel = require("../models/connectionModel");
const sourceProductModel = require("../models/sourceProductModel");
const productMappingModel = require("../models/productMappingModel");
const { query } = require("../config/db");
const { renderStoreType } = require("./storeController");
const { CODE_TTL_MINUTES } = require("../services/pairing");

/**
 * What each role has to do, in the order it is shown.
 *
 * `blockedBy` names the step above that has to be done first. It drives the
 * locked state, so adding a step cannot leave the chain inconsistent.
 */
const STEPS = {
  source: [
    {
      key: "products",
      icon: "box",
      title: "Add your products",
      // First on purpose: it is the only step that depends on nobody else, so
      // a supplier always has something to get on with while a buyer is found.
      body:
        "Pick the products you want to supply from your own catalogue. They " +
        "are staged here only -- nothing is offered to anyone until you share " +
        "it.",
      action: { label: "Go to Products", href: "/products" },
    },
    {
      key: "connect",
      icon: "key",
      // Named for the outcome, not the button. "Generate a code" would tick
      // itself the moment a code was made, and a code is single-use and dies
      // after CODE_TTL_MINUTES -- so it would go on claiming success long
      // after the code stopped working.
      title: "Connect with destination store",
      body:
        "Generate a pairing code and give it to whoever runs the buying " +
        "store. They enter it on their own Stores screen.",
      action: { label: "Go to Stores", href: "/stores" },
    },
    {
      key: "share",
      icon: "share",
      title: "Share products with them",
      body:
        "Tick the products you want that store to sell and press Allow " +
        "selected. Nothing reaches their catalogue until they accept it.",
      action: { label: "Go to Products", href: "/products" },
      blockedBy: "connect",
    },
  ],

  destination: [
    {
      key: "connect",
      icon: "link",
      title: "Connect with source store",
      body:
        "Ask your supplier to open this app, go to Stores, and press " +
        "Generate a code. Then enter that code on your Stores screen.",
      action: { label: "Go to Stores", href: "/stores" },
    },
    {
      key: "settings",
      icon: "sliders",
      title: "Choose what gets copied",
      body:
        "Set your margin and tick the fields you want kept in step with your " +
        "supplier. A margin of 40 sells a product costing 100 at 140.",
      action: { label: "Go to Settings", href: "/settings" },
      blockedBy: "connect",
    },
    {
      key: "accept",
      icon: "check",
      title: "Accept the products you want",
      body:
        "Products opens on the Unsynced tab, which is whatever your suppliers " +
        "have offered. Tick the ones you want and press Sync selected.",
      action: { label: "Go to Products", href: "/products" },
      blockedBy: "connect",
    },
  ],
};

/**
 * The live pairing code, when one is in play and has not expired.
 *
 * Only ever used to DRAW the waiting box -- the code and its countdown. It
 * decides nothing: the step it belongs to is done when a connection exists,
 * and pairing clears this column the moment a code is used, so reading
 * success from it would get the answer exactly backwards.
 */
async function pairing(storeId) {
  const rows = await query(
    "SELECT pairing_code, pairing_code_expires_at FROM stores WHERE id = ? LIMIT 1",
    [storeId]
  );

  const row = rows[0];
  if (!row || !row.pairing_code) return null;

  const expiresAt = row.pairing_code_expires_at
    ? new Date(row.pairing_code_expires_at)
    : null;

  return {
    code: row.pairing_code,
    expiresAt,
    // An expired code is still worth showing, as the reason nothing has
    // happened. The screen says so and offers a fresh one.
    expired: Boolean(expiresAt && expiresAt.getTime() <= Date.now()),
    ttlMinutes: CODE_TTL_MINUTES,
  };
}

/** Which steps a source store has actually done. */
async function sourceProgress(storeId) {
  const [counts, connections] = await Promise.all([
    sourceProductModel.countsWithMappingStatus(storeId),
    connectionModel.listForSource(storeId),
  ]);

  return {
    products: counts.all > 0,
    connect: connections.length > 0,
    share: counts.shared > 0,
    detail: {
      products: counts.all
        ? `${counts.all} product${counts.all === 1 ? "" : "s"} in your catalogue.`
        : null,
      connect: connections.length
        ? `Connected to ${connections
            .map((c) => c.destination.store_name || c.destination.shop_domain)
            .join(", ")}.`
        : null,
      share: counts.shared
        ? `${counts.shared} product${counts.shared === 1 ? "" : "s"} shared.`
        : null,
    },
  };
}

/** Which steps a destination store has actually done. */
async function destinationProgress(storeId) {
  const connections = await connectionModel.listForDestination(storeId);

  if (!connections.length) {
    return {
      connect: false,
      settings: false,
      accept: false,
      detail: { connect: null, settings: null, accept: null },
    };
  }

  const ids = connections.map((connection) => connection.id);
  const placeholders = ids.map(() => "?").join(", ");

  const [savedRows, acceptedRows] = await Promise.all([
    // Stamped by syncSettingsModel.save, so this asks "has the merchant been
    // to Settings and pressed Save" -- which no stored value can answer,
    // because every default is also a choice somebody might mean to make.
    query(
      `SELECT COUNT(*) AS total FROM sync_settings
        WHERE connection_id IN (${placeholders}) AND reviewed_at IS NOT NULL`,
      ids
    ),
    query(
      `SELECT COUNT(*) AS total FROM product_mappings
        WHERE connection_id IN (${placeholders}) AND accepted_at IS NOT NULL`,
      ids
    ),
  ]);

  const saved = Number(savedRows[0].total) > 0;
  const accepted = Number(acceptedRows[0].total);

  // Offered but not yet accepted: the difference between "your turn" and
  // "still waiting on them", which the screen has to tell apart.
  const offered = (
    await Promise.all(ids.map((id) => productMappingModel.statusBreakdown(id)))
  ).reduce((sum, status) => sum + status.pending + status.synced, 0);

  return {
    connect: true,
    settings: saved,
    accept: accepted > 0,
    offered: offered > 0,
    detail: {
      connect: `Connected to ${connections
        .map((c) => c.source.store_name || c.source.shop_domain)
        .join(", ")}.`,
      settings: saved ? "Your margin and fields are set." : null,
      accept: accepted
        ? `${accepted} product${accepted === 1 ? "" : "s"} in your store.`
        : null,
    },
  };
}

/**
 * The steps, each given its state.
 *
 * `waiting` is decided per step rather than by a rule, because what it means
 * differs: a supplier waiting for a buyer to type a code has done everything
 * it can, while a buyer with nothing offered to it yet is waiting on someone
 * else entirely.
 */
function build(role, progress, code) {
  const done = new Set();

  return STEPS[role].map((step) => {
    const complete = Boolean(progress[step.key]);
    if (complete) done.add(step.key);

    let state = "ready";
    let note = null;

    if (complete) {
      state = "done";
    } else if (step.blockedBy && !done.has(step.blockedBy)) {
      state = "locked";
      // The blocking step quoted as its own heading rather than folded into
      // the sentence: a title is a title, and lower-casing one into "once you
      // have connect with destination store" reads as broken English.
      note = `Available once "${
        STEPS[role].find((other) => other.key === step.blockedBy).title
      }" is done.`;
    } else if (role === "source" && step.key === "connect") {
      // The merchant's part is done as soon as a code is in their buyer's
      // hands; the rest is out of their control.
      if (code && !code.expired) {
        state = "waiting";
        note = "Waiting for your buyer to enter it.";
      }
    } else if (role === "source" && step.key === "share") {
      state = "ready";
    } else if (role === "destination" && step.key === "accept" && !progress.offered) {
      state = "waiting";
      note = "Your supplier has not shared anything yet.";
    }

    return {
      ...step,
      state,
      note,
      detail: (progress.detail && progress.detail[step.key]) || null,
      // Only the step that carries the code shows it, and only while it is
      // still the thing being waited on. A supplier who generates a fresh
      // code for a SECOND buyer is already connected, and a code sitting
      // under a heading that says Done reads as a contradiction.
      code: role === "source" && step.key === "connect" && !complete ? code : null,
    };
  });
}

/** Progress and steps for a store, used by the screen and by the banner. */
async function statusFor(store) {
  const role = store.store_type;

  const [progress, code] = await Promise.all([
    role === "source" ? sourceProgress(store.id) : destinationProgress(store.id),
    role === "source" ? pairing(store.id) : Promise.resolve(null),
  ]);

  const steps = build(role, progress, code);
  const done = steps.filter((step) => step.state === "done").length;

  return {
    steps,
    done,
    total: steps.length,
    complete: done === steps.length,
    // Something to show in the banner without repeating the whole list.
    next: steps.find((step) => step.state === "ready" || step.state === "waiting") || null,
  };
}

exports.getSetup = async (req, res) => {
  try {
    if (!req.store.store_type) return renderStoreType(req, res);

    const status = await statusFor(req.store);

    // Finished. Nothing to come back for, so the app stops opening here --
    // set before rendering, so the "you are ready" screen is the last time
    // this is seen rather than the first of many.
    if (status.complete) await storeModel.markOnboarded(req.store.id);

    res.render("setup", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      ...status,
    });
  } catch (err) {
    console.error("Setup screen failed:", err.message);
    res.status(500).send("Error loading setup");
  }
};

/** Stop opening the app here, with steps still outstanding. */
exports.postSkip = async (req, res) => {
  try {
    await storeModel.markOnboarded(req.store.id);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Skipping setup failed:", err.message);
    return res.status(500).json({ error: "Could not skip setup." });
  }
};

exports.STEPS = STEPS;
exports.statusFor = statusFor;
