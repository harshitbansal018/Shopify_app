const shopModel = require("../models/shopModel");
const membershipModel = require("../models/membershipModel");
const axios = require("axios");

// ✅ Confirm Plan
async function confirmPlan(req, res) {
  try {
    const { shop, charge_id, planId } = req.query;

    console.log("SHOP FROM URL:", shop);
    console.log("CHARGE ID:", charge_id);

    const shopData = await shopModel.getShopByDomain(shop);

    if (!shopData) {
      return res.send("Shop not found");
    }

    if (!charge_id) {
      return res.send("Invalid charge ID");
    }

    // 🔥 Verify charge with Shopify
    const response = await axios.get(
      `https://${shop}/admin/api/2024-01/recurring_application_charges/${charge_id}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": shopData.access_token
        }
      }
    );

    const charge = response.data.recurring_application_charge;

    if (charge.status !== "active") {
      return res.send("Payment not approved");
    }

    // 🔥 Deactivate old plans
    await membershipModel.deactivateOldPlans(shopData.id);

    // 🔥 Save new membership
    await membershipModel.createMembership(
      shopData.id,
      planId,
      charge.price,
      charge.id   // ✅ store charge_id
    );

    res.redirect(`/plans?shop=${shop}`);

  } catch (err) {
    console.error("Confirm Error:", err.response?.data || err);
    res.send("Error confirming plan");
  }
}

module.exports = {
  confirmPlan
};