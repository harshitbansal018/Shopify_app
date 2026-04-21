const db = require("../config/db");

// ✅ Create membership
function createMembership(shopId, planId, amount, chargeId) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO memberships 
      (shop_id, plan_id, status, payment_status, amount, shopify_charge_id)
      VALUES (?, ?, 'active', 'paid', ?, ?)
    `;

    db.query(sql, [shopId, planId, amount, chargeId], (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

// ✅ Deactivate old plans
function deactivateOldPlans(shopId) {
  return new Promise((resolve, reject) => {
    db.query(
      "UPDATE memberships SET status = 'inactive' WHERE shop_id = ?",
      [shopId],
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
  });
}

// ✅ Get active plan
function getActiveMembership(shopId) {
  return new Promise((resolve, reject) => {
    db.query(
      "SELECT * FROM memberships WHERE shop_id = ? AND status = 'active'",
      [shopId],
      (err, results) => {
        if (err) return reject(err);
        resolve(results[0]);
      }
    );
  });
}
// ✅ Assign FREE plan
function assignFreePlan(shopId, planId) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO memberships 
      (shop_id, plan_id, status, payment_status, amount)
      VALUES (?, ?, 'active', 'paid', 0)
    `;

    db.query(sql, [shopId, planId], (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}
const deleteMembershipsByShopId = (shopId) => {
  return new Promise((resolve, reject) => {
    db.query(
        "DELETE FROM memberships WHERE shop_id = ?",
        [shopId],
        (err, result) => {
          if (err) return reject(err);
            resolve(result);
        }
    );
  });
}
module.exports = {
  createMembership,
  deactivateOldPlans,
  getActiveMembership,
  assignFreePlan,
  deleteMembershipsByShopId,
};