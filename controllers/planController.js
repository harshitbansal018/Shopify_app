const planModel = require("../models/planModel");
const dummyShopModel = require("../models/dummyShopModel");
const storeModel = require("../models/storeModel");
const billing = require("../services/billing");
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

    const [plans, currentPlan, billingTest] = await Promise.all([
      planModel.listActive(),
      planModel.currentForStore(req.storeId),
      dummyShopModel.isDummyShop(req.shop),
    ]);

    res.render("destination/plans", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      plans,
      currentPlan,
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
