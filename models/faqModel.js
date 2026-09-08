// models/faqModel.js
//
// `faqs` -- the questions and answers on the Help screen.
//
// These live in the database, not in the code, for one reason: support can
// reword an answer, add a question or hide one without a deploy. Everything
// here is in service of that.
//
// Not scoped to a store. Every merchant of a given role sees the same list,
// and the role is the only thing that varies.
const { query, pool } = require("../config/db");

const ROLES = ["source", "destination"];

/**
 * The questions one kind of merchant sees, in the order they should read.
 *
 * Hidden rows are filtered out here rather than in the view, so no screen can
 * accidentally show a question that was taken down. Ordered by position, then
 * id, so two rows sharing a position still come out in a stable order rather
 * than whatever the storage engine feels like today.
 */
async function listForRole(role) {
  if (!ROLES.includes(role)) return [];

  return query(
    `SELECT id, question, answer, position
       FROM faqs
      WHERE role = ? AND is_active = 1
      ORDER BY position, id`,
    [role]
  );
}

/** Every row, hidden ones included, for whoever is editing the list. */
async function listAll(role = null) {
  if (role && !ROLES.includes(role)) return [];

  return query(
    `SELECT * FROM faqs
      ${role ? "WHERE role = ?" : ""}
      ORDER BY role, position, id`,
    role ? [role] : []
  );
}

async function findById(id) {
  const rows = await query("SELECT * FROM faqs WHERE id = ? LIMIT 1", [id]);
  return rows[0] || null;
}

/**
 * Add a question.
 *
 * Position defaults to the end of that role's list rather than to 0, so a new
 * row does not silently jump to the top of a list somebody has already put in
 * a deliberate order.
 */
async function create({ role, question, answer, position = null, isActive = true }) {
  if (!ROLES.includes(role)) {
    throw new Error(`role must be one of ${ROLES.join(", ")}`);
  }

  if (!String(question || "").trim() || !String(answer || "").trim()) {
    throw new Error("A question needs both a question and an answer.");
  }

  const at =
    position === null || position === undefined
      ? Number(
          (
            await query(
              "SELECT COALESCE(MAX(position), 0) + 10 AS next FROM faqs WHERE role = ?",
              [role]
            )
          )[0].next
        )
      : Number(position);

  const [result] = await pool.query(
    `INSERT INTO faqs (role, question, answer, position, is_active)
     VALUES (?, ?, ?, ?, ?)`,
    [
      role,
      String(question).trim().slice(0, 512),
      String(answer).trim(),
      at,
      isActive ? 1 : 0,
    ]
  );

  return findById(result.insertId);
}

/**
 * Change one.
 *
 * Only the keys actually passed are written. A caller sending just a new
 * answer must not blank the question, and a partial body must not silently
 * hide a live entry.
 */
async function update(id, changes = {}) {
  const sets = [];
  const params = [];

  if (changes.question !== undefined) {
    sets.push("question = ?");
    params.push(String(changes.question).trim().slice(0, 512));
  }

  if (changes.answer !== undefined) {
    sets.push("answer = ?");
    params.push(String(changes.answer).trim());
  }

  if (changes.position !== undefined) {
    sets.push("position = ?");
    params.push(Number(changes.position) || 0);
  }

  if (changes.isActive !== undefined) {
    sets.push("is_active = ?");
    params.push(changes.isActive ? 1 : 0);
  }

  if (!sets.length) return findById(id);

  params.push(id);

  await pool.query(`UPDATE faqs SET ${sets.join(", ")} WHERE id = ?`, params);

  return findById(id);
}

async function remove(id) {
  const [result] = await pool.query("DELETE FROM faqs WHERE id = ?", [id]);
  return result.affectedRows;
}

async function countForRole(role) {
  const rows = await query(
    "SELECT COUNT(*) AS total FROM faqs WHERE role = ? AND is_active = 1",
    [role]
  );
  return Number(rows[0] ? rows[0].total : 0);
}

module.exports = {
  ROLES,
  listForRole,
  listAll,
  findById,
  create,
  update,
  remove,
  countForRole,
};
