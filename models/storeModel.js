// models/storeModel.js
//
// The `stores` table. One row per installed Shopify store, acting EITHER as a
// sync source or as a destination -- never both. store_type is NULL until the
// role is decided, either explicitly or by the first connection that uses it.
//
// Access and refresh tokens are ENCRYPTED at this boundary: callers pass and
// receive plaintext, and nothing outside this file sees the ciphertext.
const crypto = require("crypto");

const { query, pool } = require("../config/db");
const { encrypt, decrypt } = require("../utils/crypto");
const { toDate } = require("./helpers");

const DEFAULT_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

/**
 * Decrypt the token columns on the way out. A token that fails to decrypt
 * (key rotated, row tampered with) surfaces as null so the caller treats the
 * store as needing a reinstall rather than sending garbage to Shopify.
 */
function hydrate(row) {
  if (!row) return null;

  const store = { ...row };

  for (const column of ["access_token", "refresh_token"]) {
    try {
      store[column] = decrypt(row[column]);
    } catch (err) {
      console.warn(
        `Could not decrypt ${column} for ${row.shop_domain}: ${err.message}`
      );
      store[column] = null;
    }
  }

  store.is_active = Boolean(row.is_active);
  return store;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

async function findByDomain(shopDomain) {
  const rows = await query(
    "SELECT * FROM stores WHERE shop_domain = ? LIMIT 1",
    [String(shopDomain || "").trim().toLowerCase()]
  );
  return hydrate(rows[0]);
}

async function findById(id) {
  const rows = await query("SELECT * FROM stores WHERE id = ? LIMIT 1", [id]);
  return hydrate(rows[0]);
}

/**
 * Stores that may act in a given role.
 *
 * A store is EITHER a source or a destination, never both. A store whose
 * store_type is NULL has not been assigned yet, so it is still eligible for
 * either role -- picking it for a connection is what decides.
 */
async function listByRole(role) {
  if (role !== "source" && role !== "destination") {
    return (await query(
      "SELECT * FROM stores WHERE is_active = 1 ORDER BY store_name, shop_domain"
    )).map(hydrate);
  }

  const rows = await query(
    `SELECT * FROM stores
      WHERE is_active = 1
        AND (store_type = ? OR store_type IS NULL)
      ORDER BY store_type IS NULL, store_name, shop_domain`,
    [role]
  );
  return rows.map(hydrate);
}

/** Stores that have not been given a role yet. */
async function listUnassigned() {
  const rows = await query(
    `SELECT * FROM stores
      WHERE is_active = 1 AND store_type IS NULL
      ORDER BY store_name, shop_domain`
  );
  return rows.map(hydrate);
}

async function listAll() {
  const rows = await query(
    "SELECT * FROM stores ORDER BY is_active DESC, store_name, shop_domain"
  );
  return rows.map(hydrate);
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

const UPSERT_SQL = `
  INSERT INTO stores (
    shop_domain, store_name,
    access_token, access_token_expires_at,
    refresh_token, refresh_token_expires_at,
    api_version, store_type, currency,
    is_active, installed_at, uninstalled_at, store_group_id
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?)
  ON DUPLICATE KEY UPDATE
    store_name = VALUES(store_name),
    access_token = VALUES(access_token),
    access_token_expires_at = VALUES(access_token_expires_at),
    refresh_token = VALUES(refresh_token),
    refresh_token_expires_at = VALUES(refresh_token_expires_at),
    api_version = VALUES(api_version),
    currency = VALUES(currency),
    is_active = 1,
    -- A reinstall clears the uninstall marker but keeps the original
    -- installed_at, so "customer since" stays truthful.
    uninstalled_at = NULL
`;

/**
 * Create or refresh a store row at install time.
 *
 * A new store starts with NO role: the app cannot know whether the merchant
 * means it to send or receive products. `store_type` is also never overwritten
 * on reinstall -- that choice is app configuration, not something OAuth resets.
 */
async function upsertStore(data) {
  await query(UPSERT_SQL, [
    String(data.shop_domain).trim().toLowerCase(),
    data.store_name || null,
    encrypt(data.access_token),
    toDate(data.access_token_expires_at),
    encrypt(data.refresh_token),
    toDate(data.refresh_token_expires_at),
    data.api_version || DEFAULT_API_VERSION,
    data.store_type || null,
    data.currency || null,
    toDate(data.installed_at) || new Date(),
    // A new store starts alone in its own group. Pairing is the only way in.
    data.store_group_id || crypto.randomUUID(),
  ]);

  return findByDomain(data.shop_domain);
}

/** Persist a rotated token pair after a refresh. */
async function updateTokens(shopDomain, tokens) {
  await query(
    `UPDATE stores
        SET access_token = ?,
            access_token_expires_at = ?,
            refresh_token = ?,
            refresh_token_expires_at = ?
      WHERE shop_domain = ?`,
    [
      encrypt(tokens.accessToken),
      toDate(tokens.accessTokenExpiresAt),
      encrypt(tokens.refreshToken),
      toDate(tokens.refreshTokenExpiresAt),
      shopDomain,
    ]
  );
}

/** Drop a dead token pair. The store row stays for its history. */
async function clearTokens(shopDomain) {
  await query(
    `UPDATE stores
        SET access_token = NULL,
            access_token_expires_at = NULL,
            refresh_token = NULL,
            refresh_token_expires_at = NULL
      WHERE shop_domain = ?`,
    [shopDomain]
  );
}

/**
 * app/uninstalled: deactivate and stamp the time, clear the revoked tokens,
 * and leave connections and mappings in place so a reinstall resumes rather
 * than starting over.
 */
async function markUninstalled(shopDomain) {
  await query(
    `UPDATE stores
        SET is_active = 0,
            uninstalled_at = NOW(),
            access_token = NULL,
            access_token_expires_at = NULL,
            refresh_token = NULL,
            refresh_token_expires_at = NULL
      WHERE shop_domain = ?`,
    [shopDomain]
  );
}

/** Raised when a role change contradicts how the store is already connected. */
class RoleConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "RoleConflictError";
    this.statusCode = 409;
  }
}

const ROLES = ["source", "destination"];

/**
 * How many connections use this store in each role. A store that already
 * sends products cannot be turned into one that receives them.
 */
async function connectionRoleCounts(storeId) {
  const rows = await query(
    `SELECT
       (SELECT COUNT(*) FROM store_connections
         WHERE source_store_id = ? AND status <> 'disconnected') AS as_source,
       (SELECT COUNT(*) FROM store_connections
         WHERE destination_store_id = ? AND status <> 'disconnected') AS as_destination`,
    [storeId, storeId]
  );

  return {
    asSource: Number(rows[0].as_source),
    asDestination: Number(rows[0].as_destination),
  };
}

/**
 * Choose a store's role. ONCE, and never again.
 *
 * The merchant picks this the first time they open the app after installing,
 * and it is permanent from then on. Everything downstream is derived from it --
 * which direction products move, which store shows a pairing code and which
 * one types it in, which webhooks matter -- so flipping it later would strand
 * every product already synced under the old answer.
 *
 * There is deliberately NO function that changes an existing role: making this
 * the only writer means no screen, route or future feature can quietly undo the
 * choice.
 *
 * The guard lives in the UPDATE's own WHERE clause rather than in a SELECT
 * first: two simultaneous submits would both pass a check-then-write, and the
 * second would overwrite the first.
 */
async function chooseStoreType(id, storeType) {
  if (!ROLES.includes(storeType)) {
    throw new RoleConflictError(
      `store_type must be "source" or "destination" -- got "${storeType}"`
    );
  }

  const [result] = await pool.query(
    "UPDATE stores SET store_type = ? WHERE id = ? AND store_type IS NULL",
    [storeType, id]
  );

  if (result.affectedRows === 0) {
    const existing = await findById(id);

    if (!existing) throw new RoleConflictError("Store not found");

    throw new RoleConflictError(
      `This store is already set up as a ${existing.store_type} store. ` +
        "A store's type is chosen once, when the app is installed, and cannot " +
        "be changed afterwards."
    );
  }

  return findById(id);
}

/**
 * Claim a role for a store while building a connection.
 *
 * Unassigned stores take the role; a store already in that role passes; a
 * store in the opposite role is rejected. Takes an optional transaction so the
 * role change and the connection insert commit together.
 */
async function assignRole(storeId, role, { connection = null } = {}) {
  if (!ROLES.includes(role)) {
    throw new RoleConflictError(`Unknown role: ${role}`);
  }

  const runner = connection || null;

  const rows = runner
    ? (await runner.query("SELECT * FROM stores WHERE id = ? FOR UPDATE", [storeId]))[0]
    : await query("SELECT * FROM stores WHERE id = ? LIMIT 1", [storeId]);

  const store = rows[0];

  if (!store) {
    throw new RoleConflictError("Store not found");
  }

  if (store.store_type === role) return hydrate(store);

  if (store.store_type && store.store_type !== role) {
    const label = store.store_name || store.shop_domain;
    throw new RoleConflictError(
      `"${label}" is set up as a ${store.store_type} store, so it cannot be used ` +
        `as the ${role}. A store is either a source or a destination, not both.`
    );
  }

  // Unassigned: this connection decides the role.
  if (runner) {
    await runner.query("UPDATE stores SET store_type = ? WHERE id = ?", [role, storeId]);
  } else {
    await query("UPDATE stores SET store_type = ? WHERE id = ?", [role, storeId]);
  }

  return { ...hydrate(store), store_type: role };
}

/** shop/redact: cascades to every table that references this store. */
async function deleteStore(shopDomain) {
  const [result] = await pool.query("DELETE FROM stores WHERE shop_domain = ?", [
    shopDomain,
  ]);
  return result.affectedRows > 0;
}

module.exports = {
  ROLES,
  findByDomain,
  findById,
  listByRole,
  listUnassigned,
  connectionRoleCounts,
  assignRole,
  RoleConflictError,
  listAll,
  upsertStore,
  updateTokens,
  clearTokens,
  markUninstalled,
  chooseStoreType,
  deleteStore,
};
