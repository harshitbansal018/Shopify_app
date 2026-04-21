// controllers/authController.js
const axios = require("axios");
const crypto = require("crypto");
const { saveShop, getShop } = require("../models/shopModel");
const membershipModel = require("../models/membershipModel");
// ================= INSTALL =================
exports.installApp = async (req, res) => {
  const { shop } = req.query;

  if (!shop) return res.send("Missing shop");

  try {
    const existingShop = await getShop(shop);
    if (existingShop && existingShop.status === 1) {
      console.log("✅ Shop already installed during install flow, redirecting to dashboard");
      return res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <script>
              window.top.location.href = "/?shop=${shop}&host=${existingShop.host}";
            </script>
          </head>
          <body></body>
        </html>
      `);
    }
  } catch (dbErr) {
    console.error("⚠️ Error checking existing shop during install:", dbErr.message);
  }

  const redirectUri = `${process.env.HOST}/api/auth/callback`;

  // 🔐 Generate state for security
  const state = crypto.randomBytes(16).toString("hex");

 const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=read_products,write_content,read_content,write_online_store_pages&grant_options[]=offline_access&redirect_uri=${redirectUri}`;

// console.log("🟡 INSTALL URL:", installUrl);
// console.log("🟡 SHOP:", shop);
// console.log("🟡 SCOPES SENT: read_products,write_content,read_content,write_online_store_pages");

  res.redirect(installUrl);
};

// ================= CALLBACK =================

exports.callback = async (req, res) => {
  const { shop, hmac, code,host } = req.query;
if (!shop || !code) {
  return res.status(400).send("Missing required parameters");
}
//   console.log("📥 Received Query:", req.query);
// console.log("📥 CALLBACK HIT");
// console.log("📥 SHOP:", shop);
// console.log("📥 CODE:", code);
  try {
    // 🔐 HMAC Verification
    const map = { ...req.query };
    delete map["hmac"];
    delete map["signature"];

    const message = Object.keys(map)
      .sort()
      .map((key) => `${key}=${map[key]}`)
      .join("&");

    const generatedHash = crypto
      .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
      .update(message)
      .digest("hex");

    if (generatedHash !== hmac) {
      console.log("❌ HMAC Validation Failed");
      return res.status(400).send("HMAC failed ❌");
    }

    console.log("✅ HMAC Verified");

    // 🔁 Exchange code → access token
    const tokenRes = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
        expiring: 1,
      }
    );

    const accessToken = tokenRes.data.access_token;
  console.log("🔑 TOKEN GENERATED:", accessToken);
console.log("🔑 TOKEN LENGTH:", accessToken.length);

    // 🔔 Register Webhook (app/uninstalled)
    try {
      await axios.post(
        `https://${shop}/admin/api/2025-01/webhooks.json`,
        {
          webhook: {
            topic: "app/uninstalled",
            address: `${process.env.HOST}/webhooks/app/uninstalled`,
            format: "json",
          },
        },
        {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
        }
      );

      console.log("🔔 Webhook registered successfully");
    } catch (webhookErr) {
      console.log("⚠️ Webhook may already exist or failed");
    }

    // 🧠 Fetch shop details
    const shopRes = await axios.get(
      `https://${shop}/admin/api/2025-01/shop.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
        },
      }
    );

    const data = shopRes.data.shop;
    console.log("🏪 Shop Data:", data);

    // 📅 Convert dates for MySQL
    const createdAt = new Date(data.created_at);
    const updatedAt = new Date(data.updated_at);
   // 💾 Save shop data (single table)
const shopId = await saveShop({
  shop_name: shop,
  access_token: accessToken,
  host: host,
  shopify_id: data.id,
  name: data.name,
  email: data.email,
  domain: data.domain,

  country: data.country,
  country_code: data.country_code,
  country_name: data.country_name,

  currency: data.currency,
  money_format: data.money_format,

  timezone: data.timezone,
  iana_timezone: data.iana_timezone,

  shop_owner: data.shop_owner,

  address1: data.address1,
  address2: data.address2,
  city: data.city,
  zip: data.zip,
  phone: data.phone,

  created_at: createdAt,
  updated_at: updatedAt,

  status: 1,
});

console.log("✅ Shop saved with ID:", shopId);

// 🔥 SAFE FREE PLAN LOGIC
const existingPlan = await membershipModel.getActiveMembership(shopId);

if (!existingPlan) {
  await membershipModel.assignFreePlan(shopId, 1);
  console.log("✅ Free plan assigned");
} else {
  console.log("ℹ️ Plan already exists");
}

    console.log("✅ Data saved successfully");

    // 🚀 Redirect to dashboard
    res.send(`
  <!DOCTYPE html>
  <html>
    <head>
      <script>
        window.top.location.href = "/?shop=${shop}&host=${host}";
      </script>
    </head>
    <body></body>
  </html>
`);

  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
    res.status(500).send(err.response?.data || "Error occurred");
  }
};