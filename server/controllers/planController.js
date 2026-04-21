const planModel = require("../models/planModel");
const shopModel = require("../models/shopModel");
const membershipModel = require("../models/membershipModel");
const dummyShopModel = require("../models/dummyShopModel");
const axios = require("axios");

// ✅ Show Plans Page
async function getPlansPage(req, res) {
  try {
    const shopDomain = req.query.shop;

    if (!shopDomain) {
      return res.send("Shop not found");
    }

    const shop = await shopModel.getShopByDomain(shopDomain);

    if (!shop) {
      return res.send("Shop not found in DB");
    }

    const plans = await planModel.getAllPlans();
    const currentPlan = await membershipModel.getActiveMembership(shop.id);

    res.render("plans", {
      plans,
      currentPlan,
      shop: shopDomain
    });

  } catch (err) {
    console.error(err);
    res.send("Error loading plans");
  }
}

// ✅ Create Shopify Charge (REAL BILLING READY)
async function buyPlan(req, res) {
  try {
    const planId = req.params.id;
    const shopDomain = req.query.shop;

    const shop = await shopModel.getShopByDomain(shopDomain);
    const isTest=await dummyShopModel.isDummyShop(shopDomain);
    const plan = await planModel.getPlanById(planId);

    if (!plan) {
      return res.json({ error: "Plan not found" });
    }

    // 🔥 Shopify charge create
    const response = await axios.post(
      `https://${shop.domain}/admin/api/2024-01/recurring_application_charges.json`,
      {
        recurring_application_charge: {
          name: plan.title,
          price: plan.price,
     return_url: `${process.env.HOST}/plans/confirm?shop=${shopDomain}&planId=${planId}`,
          test: isTest ? true : false
        }
      },
      {
        headers: {
          "X-Shopify-Access-Token": shop.access_token,
          "Content-Type": "application/json"
        }
      }
    );

    const charge = response.data.recurring_application_charge;

    res.json({
      confirmation_url: charge.confirmation_url
    });

  } catch (err) {
    console.error("Billing Error:", err.response?.data || err);
    res.json({ error: "Billing failed" });
  }
}

module.exports = {
  getPlansPage,
  buyPlan
};