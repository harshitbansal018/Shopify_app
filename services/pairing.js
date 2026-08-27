// services/pairing.js
//
// Proves that two installed stores are controlled by the same person.
//
// Without this, "which stores can I sync from?" has no honest answer: every
// store that installed the app is in one table, and nothing distinguishes your
// second store from a stranger's. Pairing supplies that missing fact.
//
// How it works:
//   1. Store A shows a short code, visible only inside A's Shopify admin.
//   2. The operator opens the app on store B and types the code in.
//   3. Only someone with admin access to BOTH stores can do that, so the two
//      are merged into one group and can see each other from then on.
//
// Groups are transitive by design: pairing C with B, where B is already
// grouped with A, puts all three together. That matches how people actually
// run several stores.
const crypto = require("crypto");

const { query, pool, withTransaction } = require("../config/db");

// No 0/O/1/I/L -- a merchant reads this off one screen and types it into
// another, and those are the characters they get wrong.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_TTL_MINUTES = Number(process.env.PAIRING_CODE_TTL_MINUTES || 15);

class PairingError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "PairingError";
    this.statusCode = statusCode;
  }
}

/** Formatted as XXXX-XXXX so it is readable when spoken or retyped. */
function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";

  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }

  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeCode(input) {
  return String(input || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

function formatCode(normalized) {
  return normalized.length === CODE_LENGTH
    ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
    : normalized;
}

/**
 * Issue (or reissue) a pairing code for a store.
 *
 * Calling this again replaces the previous code, so a merchant who thinks a
 * code leaked can simply generate a new one.
 */
async function issueCode(storeId) {
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

  // The column is UNIQUE; on the astronomically unlikely collision, try again.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode();

    try {
      await query(
        `UPDATE stores
            SET pairing_code = ?, pairing_code_expires_at = ?
          WHERE id = ?`,
        [normalizeCode(code), expiresAt, storeId]
      );

      return { code, expiresAt };
    } catch (err) {
      if (err.code !== "ER_DUP_ENTRY") throw err;
    }
  }

  throw new PairingError("Could not generate a pairing code. Try again.", 500);
}

async function clearCode(storeId) {
  await query(
    `UPDATE stores
        SET pairing_code = NULL, pairing_code_expires_at = NULL
      WHERE id = ?`,
    [storeId]
  );
}

/**
 * Redeem a code from `redeemingStoreId`, merging the two groups.
 *
 * The whole thing runs in one transaction: a half-applied merge would leave
 * some stores able to see each other and others not.
 */
async function redeemCode(redeemingStoreId, rawCode, { expectIssuerType = null } = {}) {
  const code = normalizeCode(rawCode);

  if (code.length !== CODE_LENGTH) {
    throw new PairingError("That code does not look right. Check and try again.");
  }

  return withTransaction(async (connection) => {
    const [issuerRows] = await connection.query(
      `SELECT id, shop_domain, store_name, store_type, store_group_id,
              pairing_code_expires_at
         FROM stores
        WHERE pairing_code = ? AND is_active = 1
        FOR UPDATE`,
      [code]
    );

    const issuer = issuerRows[0];

    // Deliberately the same message for "no such code" and "expired": a wrong
    // guess should not reveal that a code exists.
    if (!issuer) {
      throw new PairingError("That code is not valid or has already been used.");
    }

    if (
      issuer.pairing_code_expires_at &&
      new Date(issuer.pairing_code_expires_at).getTime() < Date.now()
    ) {
      throw new PairingError("That code has expired. Generate a new one.");
    }

    if (Number(issuer.id) === Number(redeemingStoreId)) {
      throw new PairingError(
        "That code belongs to this store. Open the app on the OTHER store and enter it there."
      );
    }

    // Codes are role-specific: a destination shows one, a source types it in.
    // Throwing here rolls the transaction back, so a code aimed at the wrong
    // kind of store is not spent and no groups are merged.
    if (expectIssuerType && issuer.store_type !== expectIssuerType) {
      throw new PairingError(
        `That code belongs to a ${issuer.store_type || "store with no type yet"}. ` +
          `Only a ${expectIssuerType} store's code can be used here.`
      );
    }

    const [redeemerRows] = await connection.query(
      "SELECT id, shop_domain, store_name, store_group_id FROM stores WHERE id = ? FOR UPDATE",
      [redeemingStoreId]
    );

    const redeemer = redeemerRows[0];

    if (!redeemer) throw new PairingError("Store not found", 404);

    if (redeemer.store_group_id === issuer.store_group_id) {
      // Already linked; burn the code and report it plainly.
      await connection.query(
        "UPDATE stores SET pairing_code = NULL, pairing_code_expires_at = NULL WHERE id = ?",
        [issuer.id]
      );

      return {
        alreadyLinked: true,
        groupId: issuer.store_group_id,
        linkedWith: issuer,
      };
    }

    // Merge: every store in the redeemer's group joins the issuer's group, so
    // a third store paired earlier is not left behind.
    const [merged] = await connection.query(
      "UPDATE stores SET store_group_id = ? WHERE store_group_id = ?",
      [issuer.store_group_id, redeemer.store_group_id]
    );

    // A code is single-use.
    await connection.query(
      "UPDATE stores SET pairing_code = NULL, pairing_code_expires_at = NULL WHERE id = ?",
      [issuer.id]
    );

    return {
      alreadyLinked: false,
      groupId: issuer.store_group_id,
      linkedWith: issuer,
      storesMoved: merged.affectedRows,
    };
  });
}

/** Every store the given store is allowed to see, including itself. */
async function listGroupMembers(storeId) {
  return query(
    `SELECT s.id, s.shop_domain, s.store_name, s.store_type,
            s.currency, s.is_active, s.store_group_id
       FROM stores s
       JOIN stores me ON me.store_group_id = s.store_group_id
      WHERE me.id = ?
      ORDER BY s.store_name, s.shop_domain`,
    [storeId]
  );
}

/**
 * Detach a store from its group, giving it a fresh one of its own.
 * Refused while it still takes part in a connection.
 */
async function leaveGroup(storeId) {
  const rows = await query(
    `SELECT COUNT(*) AS total FROM store_connections
      WHERE source_store_id = ? OR destination_store_id = ?`,
    [storeId, storeId]
  );

  if (Number(rows[0].total) > 0) {
    throw new PairingError(
      "This store is still part of a connection. Disconnect it first.",
      409
    );
  }

  await query("UPDATE stores SET store_group_id = ? WHERE id = ?", [
    crypto.randomUUID(),
    storeId,
  ]);
}

/** True when both stores sit in the same group. */
async function sameGroup(storeIdA, storeIdB) {
  const rows = await query(
    `SELECT a.store_group_id AS a_group, b.store_group_id AS b_group
       FROM stores a, stores b
      WHERE a.id = ? AND b.id = ?`,
    [storeIdA, storeIdB]
  );

  if (!rows.length) return false;

  return (
    rows[0].a_group !== null && rows[0].a_group === rows[0].b_group
  );
}

module.exports = {
  issueCode,
  clearCode,
  redeemCode,
  listGroupMembers,
  leaveGroup,
  sameGroup,
  generateCode,
  normalizeCode,
  formatCode,
  PairingError,
  CODE_TTL_MINUTES,
};
