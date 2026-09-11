const planModel = require("../models/planModel");
const dummyShopModel = require("../models/dummyShopModel");
const storeModel = require("../models/storeModel");
const billing = require("../services/billing");
const planLimits = require("../services/planLimits");
const { renderStoreType } = require("./storeController");

function destinationOnly(req, res) {
  if (req.store.store_type !== "destination") {
    res.status(403).send("Plans are available to destination stores only.");
    return false;
  }
  return true;
}

exports.getPlans = async (req, res) => {
  try {
    if (!req.store.store_type) return renderStoreType(req, res);
    if (!destinationOnly(req, res)) return;

    const [plans, snapshot, billingTest] = await Promise.all([
      planModel.listActive(),
      planLimits.snapshot(req.store),
      dummyShopModel.isDummyShop(req.shop),
    ]);

    const currentId = snapshot.plan ? snapshot.plan.id : null;
    const currentPrice = snapshot.plan ? snapshot.plan.price : 0;

    res.render("destination/plans", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      // Shaped here so the view only lays out: every card line comes from the
      // plan's columns, and whether a button upgrades or downgrades is decided
      // once, not in the template.
      plans: plans.map((plan) => {
        const price = Number(plan.price) || 0;

        return {
          id: plan.id,
          name: plan.name,
          price,
          popular: Boolean(plan.is_popular),
          lines: planModel.featureLines(plan),
          current: plan.id === currentId,
          direction:
            plan.id === currentId
              ? "current"
              : price > currentPrice
                ? "upgrade"
                : price < currentPrice
                  ? "downgrade"
                  : "switch",
        };
      }),
      // As planStatus, so the banner middleware reuses this rather than
      // counting everything a second time.
      planStatus: snapshot,
      billingResult: ["success", "pending", "failed"].includes(req.query.billing)
        ? req.query.billing
        : null,
      billingTest,
    });
  } catch (err) {
    console.error("Plans screen failed:", err.message);
    res.status(500).send("Error loading plans");
  }
};

/** Positive integer ids from a browser-supplied list; anything else dropped. */
function idList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(Number))].filter(
    (id) => Number.isInteger(id) && id > 0
  );
}

/**
 * Move to a plan.
 *
 * A plan the store does not fit in -- more products, or more active source
 * stores, than it allows -- answers 409 with the lists to choose from, until
 * the merchant sends back which products to unsync and which stores to pause.
 * Those are applied FIRST, then the plan changes: a downgrade never leaves the
 * store over its new limits, and nothing goes without the merchant picking it.
 *
 * Orders and emails need no choice: a new plan starts a new billing month, so
 * both begin again from zero.
 */
exports.postSelectPlan = async (req, res) => {
  if (!destinationOnly(req, res)) return;

  const planId = Number(req.body.plan_id);
  if (!Number.isInteger(planId) || planId < 1) {
    return res.status(400).json({ error: "Choose a valid plan." });
  }

  try {
    const plan = await planModel.findById(planId);
    if (!plan || !plan.is_active) {
      return res.status(404).json({ error: "That plan is no longer available." });
    }

    const fit = await planLimits.fitCheck(req.store, plan);

    if (!fit.fits) {
      const unsync = idList(req.body.unsync_mapping_ids);
      const pause = idList(req.body.pause_connection_ids);

      if (!unsync.length && !pause.length) {
        return res.status(409).json({
          error: planLimits.fitMessage(fit, plan),
          downgrade: await planLimits.downgradeOptions(req.store, fit, plan),
        });
      }

      const made = await planLimits.applyDowngrade(req.store, plan, { unsync, pause });

      if (!made.ok) {
        return res.status(409).json({
          error: made.error,
          downgrade: await planLimits.downgradeOptions(
            req.store,
            await planLimits.fitCheck(req.store, plan),
            plan
          ),
        });
      }

      console.log(
        `${req.shop} made room for ${plan.name}: ` +
          `${made.unsynced} product(s) unsynced, ${made.paused} store(s) paused`
      );
    }

    if (Number(plan.price) === 0) {
      const paidCharge = await planModel.currentPaidChargeForStore(req.storeId);
      if (paidCharge) await billing.cancelSubscription(req.store, paidCharge);
      await planModel.selectForStore(req.storeId, planId);
      return res.json({ ok: true, active: true });
    }

    const test = await dummyShopModel.isDummyShop(req.shop);
    const purchase = await billing.createSubscription(req.store, plan, { test });
    await planModel.startPaidPurchase(req.storeId, plan.id, purchase.chargeId);

    return res.json({
      ok: true,
      active: false,
      confirmation_url: purchase.confirmationUrl,
    });
  } catch (err) {
    console.error("Plan selection failed:", err.message);
    return res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Could not update your plan.",
    });
  }
};

/** Shopify returns here after the merchant accepts or declines the charge.
 * This route is deliberately outside session auth: the return navigation does
 * not contain an App Bridge token. The signed, expiring billing token pins the
 * callback to the exact destination store and plan. */
exports.confirmPlan = async (req, res) => {
  const claim = billing.verifyReturnToken(req.query.billing_token);

  if (!claim) {
    return res.status(400).send("Invalid or expired billing confirmation.");
  }

  try {
    const store = await storeModel.findById(claim.storeId);
    if (!store || !store.is_active || store.store_type !== "destination") {
      return res.status(404).send("Destination store not found.");
    }

    // Shopify currently appends charge_id to the return URL. The local
    // pending row is the fallback and also lets this survive callback changes.
    const chargeId =
      billing.numericId(req.query.charge_id) ||
      await planModel.pendingChargeForStorePlan(store.id, claim.planId);

    if (!chargeId) {
      return res.status(400).send("Billing purchase was not found.");
    }

    const status = await billing.subscriptionStatus(store, chargeId);
    const approved = status === "ACTIVE";

    if (approved || ["DECLINED", "EXPIRED", "CANCELLED"].includes(status)) {
      const found = await planModel.finishPaidPurchase(
        store.id,
        claim.planId,
        chargeId,
        approved
      );
      if (!found) return res.status(400).send("Billing purchase was not found.");
    }

    const result = approved ? "success" : status === "PENDING" ? "pending" : "failed";
    const appPath = `https://${store.shop_domain}/admin/apps/${encodeURIComponent(
      process.env.SHOPIFY_API_KEY
    )}/plans?billing=${result}`;

    return res.redirect(appPath);
  } catch (err) {
    console.error("Billing confirmation failed:", err.message);
    return res.status(500).send("Could not confirm the Shopify subscription.");
  }
};
