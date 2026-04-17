exports.getDashboard = (req, res) => {
  const stats = {
    total: 25,
    active: 18,
    inactive: 7,
  };

  res.render("dashboard", {
    stats,
    apiKey: process.env.SHOPIFY_API_KEY,
  });
};