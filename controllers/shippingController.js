const connectionModel = require("../models/connectionModel");
const productMappingModel = require("../models/productMappingModel");
const shippingPolicyModel = require("../models/shippingPolicyModel");
const sourceConnectionSettingsModel = require("../models/sourceConnectionSettingsModel");
const shippingSync = require("../services/shippingSync");

function sourceOnly(req, res) {
  if (req.store.store_type !== "source") {
    res.status(403).send("Shipping policies are managed by the source store.");
    return false;
  }
  return true;
}

function pickConnection(connections, requested) {
  if (!connections.length) return null;
  const id = typeof requested === "string" ? Number(requested) : NaN;
  return connections.find((connection) => connection.id === id) || connections[0];
}

exports.pickConnection = pickConnection;

exports.getShipping = async (req, res) => {
  if (!sourceOnly(req, res)) return;

  try {
    const connections = await connectionModel.listForSource(req.storeId);
    const current = pickConnection(connections, req.query.connection);
    const [policy, sourceSettings] = current
      ? await Promise.all([
          shippingPolicyModel.forConnection(current.id, {
            currency: current.destination.currency,
          }),
          sourceConnectionSettingsModel.forConnection(current.id),
        ])
      : [null, null];

    res.render("source/shipping", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      connections,
      current,
      policy,
      sourceSettings,
    });
  } catch (error) {
    console.error("Shipping settings screen failed:", error.message);
    res.status(500).send("Error loading shipping settings");
  }
};

exports.postShipping = async (req, res) => {
  if (!sourceOnly(req, res)) return;

  const connectionId = Number(req.body.connection_id);

  try {
    const mine = await connectionModel.listForSource(req.storeId);
    const connection = mine.find((item) => item.id === connectionId);

    if (!connection) return res.status(404).json({ error: "Connection not found." });
    if (connection.status !== "active") {
      return res.status(409).json({
        error: "This destination connection must be active before shipping can change.",
      });
    }

    const sourceSettings = await sourceConnectionSettingsModel.save(
      connection.id,
      req.body.source_settings || {}
    );
    const policy = await shippingPolicyModel.save(connection.id, req.body.policy || {}, {
      // Checkout rates must be in the destination store's currency. Phase 1
      // deliberately does not invent an exchange rate.
      currency: connection.destination.currency,
    });

    try {
      const applied = await shippingSync.applyPolicy(connection, policy);
      // Re-push accepted products so their shipping/tax classification and
      // policy stay reconciled even if an older link row was incomplete.
      const queued = await productMappingModel.requeueForConnection(connection.id);
      return res.json({ ok: true, policy, sourceSettings, applied, queued });
    } catch (error) {
      const permissionHelp = /access denied|required access|permission|scope/i.test(
        error.message || ""
      )
        ? " Reauthorize the destination store if shipping access was added recently."
        : "";
      return res.status(502).json({
        error:
          `The policy was saved, but Shopify could not apply its delivery profile: ` +
          `${error.message}.${permissionHelp}`,
      });
    }
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    console.error("Saving shipping settings failed:", error.message);
    return res.status(500).json({ error: "Could not save shipping settings." });
  }
};
