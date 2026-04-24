const pageModel = require("../models/pageModel");

exports.getDashboard = async (req, res) => {
  try {
    const shop = req.query.shop;

    const stats = await pageModel.getPageStats(shop);

    const totalPages = stats.total || 0;
    const activePages = stats.active || 0;
    const inactivePages = stats.inactive || 0;

    const activeRate = totalPages
      ? ((activePages / totalPages) * 100).toFixed(1)
      : 0;

    const inactiveRate = totalPages
      ? ((inactivePages / totalPages) * 100).toFixed(1)
      : 0;

    res.render("dashboard", {
      totalPages,
      activePages,
      inactivePages,
      activeRate,
      inactiveRate,
      apiKey: process.env.SHOPIFY_API_KEY,
    });

  } catch (err) {
    console.error(err);
    res.send("Error loading dashboard");
  }
};