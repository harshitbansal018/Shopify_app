const axios = require("axios");

async function shopifyRequest(shop, accessToken, apiVersion, queryData) {
  try {
    const response = await axios({
      method: "POST",
      url: `https://${shop}/admin/api/${apiVersion}/graphql.json`,
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      data: queryData,
    });

    console.log("🔵 FULL AXIOS RESPONSE:", response.data);

    // ❗ HANDLE ERRORS
    if (response.data.errors) {
      console.error("❌ GraphQL Errors:", response.data.errors);
      console.log("🔥 TOKEN USED:", accessToken);
      throw new Error(response.data.errors[0].message);
    }

    // 🔥 IMPORTANT RETURN
    return response.data.data;

  } catch (error) {
    console.error("❌ Shopify API Error:", error.response?.data || error.message);
    throw error;
  }
}

module.exports = shopifyRequest;