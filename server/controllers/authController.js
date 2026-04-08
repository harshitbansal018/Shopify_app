// controllers/authController.js
const axios = require("axios");
const crypto = require("crypto");
const { saveShop } = require("../models/shopModel");



// ================= INSTALL =================
exports.installApp = (req, res) => {
  const { shop } = req.query;

  if (!shop) return res.send("Missing shop");

  const redirectUri = `${process.env.HOST}/api/auth/callback`;

  // 🔐 Generate state for security
  const state = crypto.randomBytes(16).toString("hex");

  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=read_products&redirect_uri=${redirectUri}&state=${state}`;

  console.log("🔁 Redirecting to:", installUrl);

  res.redirect(installUrl);
};

// ================= CALLBACK =================
exports.callback = async (req, res) => {
  const { shop, hmac, code } = req.query;

  console.log("📥 Received Query:", req.query);

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
      }
    );

    const accessToken = tokenRes.data.access_token;
    console.log("🔑 Access Token:", accessToken);

    // 🔔 Register Webhook (app/uninstalled)
    try {
      await axios.post(
        `https://${shop}/admin/api/2026-01/webhooks.json`,
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
      `https://${shop}/admin/api/2024-01/shop.json`,
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
    await saveShop({
      shop_name: shop,
      access_token: accessToken,

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

      status: 1, // ✅ Active on install
    });

    console.log("✅ Data saved successfully");

    res.send("Backend setup done ✅");

  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
    res.status(500).send(err.response?.data || "Error occurred");
  }
};