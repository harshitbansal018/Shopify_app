const db = require("../config/db");

// ✅ Get all plans
function getAllPlans() {
  return new Promise((resolve, reject) => {
    db.query("SELECT * FROM plans ORDER BY price ASC", (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

// ✅ Get plan by ID
function getPlanById(id) {
  return new Promise((resolve, reject) => {
    db.query("SELECT * FROM plans WHERE id = ?", [id], (err, results) => {
      if (err) return reject(err);
      resolve(results[0]);
    });
  });
}

module.exports = {
  getAllPlans,
  getPlanById
};