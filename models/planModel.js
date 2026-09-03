// Subscription plans are owned by a destination store.  The imported schemas
// call that owner `user_id`; in this app it is the installed store's id.
const { query, withTransaction } = require("../config/db");

async function listActive() {
  return query(
    `SELECT * FROM plans
      WHERE is_active = 1
      ORDER BY price ASC, id ASC`
  );
}

async function findById(planId) {
  const rows = await query("SELECT * FROM plans WHERE id = ? LIMIT 1", [planId]);
  return rows[0] || null;
}

async function currentForStore(storeId) {
  const rows = await query(
    `SELECT m.*, p.name AS plan_name, p.price AS plan_price
       FROM user_memberships m
       JOIN plans p ON p.id = m.membership_id
      WHERE m.user_id = ? AND m.status = 1
      ORDER BY m.updated_at DESC, m.id DESC
      LIMIT 1`,
    [storeId]
  );
  return rows[0] || null;
}

async function currentPaidChargeForStore(storeId) {
  const rows = await query(
    `SELECT pay.charge_id
       FROM user_memberships member
       JOIN plans plan ON plan.id = member.membership_id
       JOIN membership_payments pay ON pay.membership_id = member.id
      WHERE member.user_id = ? AND member.status = 1
        AND plan.price > 0 AND pay.status = 2 AND pay.charge_id IS NOT NULL
      ORDER BY pay.id DESC
      LIMIT 1`,
    [storeId]
  );
  return rows[0] && rows[0].charge_id ? String(rows[0].charge_id) : null;
}

/** Record a dummy successful subscription selection. Real billing can replace
 * the payment insert later without changing the page or membership history. */
async function selectForStore(storeId, planId) {
  return withTransaction(async (connection) => {
    const [plans] = await connection.query(
      "SELECT id FROM plans WHERE id = ? AND is_active = 1 FOR UPDATE",
      [planId]
    );

    if (!plans[0]) {
      const error = new Error("That plan is no longer available.");
      error.statusCode = 404;
      throw error;
    }

    await connection.query(
      "UPDATE user_memberships SET status = 0 WHERE user_id = ? AND status = 1",
      [storeId]
    );

    const [membership] = await connection.query(
      `INSERT INTO user_memberships (user_id, membership_id, status, created_at, updated_at)
       VALUES (?, ?, 1, NOW(), NOW())`,
      [storeId, planId]
    );

    await connection.query(
      `INSERT INTO membership_payments
        (membership_id, user_id, api_client_id, charge_id, date_add, date_update, status)
       VALUES (?, ?, NULL, NULL, NOW(), NOW(), 2)`,
      [membership.insertId, storeId]
    );

    return membership.insertId;
  });
}

async function startPaidPurchase(storeId, planId, chargeId) {
  return withTransaction(async (connection) => {
    const [membership] = await connection.query(
      `INSERT INTO user_memberships (user_id, membership_id, status, created_at, updated_at)
       VALUES (?, ?, 0, NOW(), NOW())`,
      [storeId, planId]
    );

    await connection.query(
      `INSERT INTO membership_payments
        (membership_id, user_id, api_client_id, charge_id, date_add, date_update, status)
       VALUES (?, ?, NULL, ?, NOW(), NOW(), 1)`,
      [membership.insertId, storeId, chargeId]
    );

    return membership.insertId;
  });
}

async function pendingChargeForStorePlan(storeId, planId) {
  const rows = await query(
    `SELECT pay.charge_id
       FROM membership_payments pay
       JOIN user_memberships member ON member.id = pay.membership_id
      WHERE pay.user_id = ? AND member.membership_id = ? AND pay.status = 1
      ORDER BY pay.id DESC
      LIMIT 1`,
    [storeId, planId]
  );
  return rows[0] && rows[0].charge_id ? String(rows[0].charge_id) : null;
}

async function finishPaidPurchase(storeId, planId, chargeId, approved) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `SELECT pay.id AS payment_id, pay.membership_id, member.membership_id AS plan_id
         FROM membership_payments pay
         JOIN user_memberships member ON member.id = pay.membership_id
        WHERE pay.user_id = ? AND pay.charge_id = ?
        ORDER BY pay.id DESC
        LIMIT 1 FOR UPDATE`,
      [storeId, chargeId]
    );

    const purchase = rows[0];
    if (!purchase || Number(purchase.plan_id) !== Number(planId)) return false;

    if (approved) {
      await connection.query(
        "UPDATE user_memberships SET status = 0, updated_at = NOW() WHERE user_id = ? AND status = 1",
        [storeId]
      );
      await connection.query(
        "UPDATE user_memberships SET status = 1, updated_at = NOW() WHERE id = ?",
        [purchase.membership_id]
      );
    }

    await connection.query(
      "UPDATE membership_payments SET status = ?, date_update = NOW() WHERE id = ?",
      [approved ? 2 : 0, purchase.payment_id]
    );

    return true;
  });
}

module.exports = {
  listActive,
  findById,
  currentForStore,
  currentPaidChargeForStore,
  selectForStore,
  startPaidPurchase,
  pendingChargeForStorePlan,
  finishPaidPurchase,
};
