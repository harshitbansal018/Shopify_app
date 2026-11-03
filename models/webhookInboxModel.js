const crypto = require("crypto");
const { pool, query } = require("../config/db");
const { parseJson } = require("./helpers");

async function enqueue({ deliveryId, handler, shop, topic, payload }) {
  const key = crypto.createHash("sha256").update(JSON.stringify([shop, handler, deliveryId || crypto.randomUUID()])).digest("hex");
  await pool.query(
    `INSERT INTO webhook_inbox (dedupe_key, handler, shop_domain, topic, payload)
     VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
    [key, handler, shop, topic || null, JSON.stringify(payload)]
  );
}

async function listPending(limit = 25) {
  const rows = await query(
    `SELECT w.* FROM webhook_inbox w
      WHERE ((w.status = 'pending' AND w.available_at <= NOW())
         OR (w.status = 'processing' AND w.claimed_at < NOW() - INTERVAL 15 MINUTE))
        AND NOT EXISTS (SELECT 1 FROM webhook_inbox earlier
          WHERE earlier.shop_domain = w.shop_domain AND earlier.id < w.id AND earlier.status <> 'completed')
      ORDER BY id LIMIT ?`, [Number(limit)]
  );
  return rows.map((row) => ({ ...row, payload: parseJson(row.payload, {}) }));
}

async function claim(id) {
  const [result] = await pool.query(
    `UPDATE webhook_inbox SET status = 'processing', claimed_at = NOW(), attempts = attempts + 1
      WHERE id = ? AND ((status = 'pending' AND available_at <= NOW())
        OR (status = 'processing' AND claimed_at < NOW() - INTERVAL 15 MINUTE))`, [id]
  );
  return result.affectedRows === 1;
}

async function complete(id) {
  // Keep the delivery key for dedupe, but remove personal data after processing.
  await query("UPDATE webhook_inbox SET status = 'completed', payload = NULL, error = NULL, claimed_at = NULL WHERE id = ?", [id]);
}

async function retry(id, error, attempts) {
  const seconds = Math.min(3600, 5 * 2 ** Math.min(Number(attempts), 10));
  await query(
    "UPDATE webhook_inbox SET status = 'pending', claimed_at = NULL, error = ?, available_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?",
    [String(error.message || error).slice(0, 512), seconds, id]
  );
}

module.exports = { enqueue, listPending, claim, complete, retry };
