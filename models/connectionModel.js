// models/connectionModel.js
//
// `store_connections` is self-referencing: it points at `stores` twice, once
// as the source and once as the destination. Every read therefore joins
// `stores` under two aliases (`src` and `dst`) and prefixes the selected
// columns, because both sides carry identically-named columns.
const { query, pool, withTransaction } = require("../config/db");
const storeModel = require("./storeModel");
const { parseJson, toJsonColumn } = require("./helpers");

const DEFAULT_SETTINGS = {
  price_markup_percent: 0,
  sync_images: true,
  sync_inventory: true,
  // What to do on the destination when a product disappears from the source.
  delete_behaviour: "draft", // delete | draft | ignore
  product_filter: null, // { vendor?, product_type?, status?, tag? }
};

const DELETE_BEHAVIOURS = new Set(["delete", "draft", "ignore"]);

/**
 * Fold user input onto the defaults, so a partial settings object from the UI
 * can never leave a sync step reading `undefined`.
 */
function normalizeSettings(input) {
  const raw = parseJson(input, {}) || {};

  const markup = Number(raw.price_markup_percent);

  return {
    price_markup_percent: Number.isFinite(markup)
      ? Math.max(Math.min(markup, 1000), -100)
      : 0,
    sync_images: raw.sync_images !== false,
    sync_inventory: raw.sync_inventory !== false,
    delete_behaviour: DELETE_BEHAVIOURS.has(raw.delete_behaviour)
      ? raw.delete_behaviour
      : DEFAULT_SETTINGS.delete_behaviour,
    product_filter:
      raw.product_filter && typeof raw.product_filter === "object"
        ? raw.product_filter
        : null,
  };
}

// Both stores are selected with prefixed aliases so neither side's columns
// shadow the other's.
const SELECT_WITH_STORES = `
  SELECT c.*,
         src.shop_domain AS source_shop_domain,
         src.store_name  AS source_store_name,
         src.is_active   AS source_is_active,
         src.currency    AS source_currency,
         dst.shop_domain AS destination_shop_domain,
         dst.store_name  AS destination_store_name,
         dst.is_active   AS destination_is_active,
         dst.currency    AS destination_currency
    FROM store_connections c
    JOIN stores src ON src.id = c.source_store_id
    JOIN stores dst ON dst.id = c.destination_store_id
`;

function hydrate(row) {
  if (!row) return null;

  return {
    ...row,
    settings: normalizeSettings(row.settings),
    source: {
      id: row.source_store_id,
      shop_domain: row.source_shop_domain,
      store_name: row.source_store_name,
      is_active: Boolean(row.source_is_active),
      currency: row.source_currency,
    },
    destination: {
      id: row.destination_store_id,
      shop_domain: row.destination_shop_domain,
      store_name: row.destination_store_name,
      is_active: Boolean(row.destination_is_active),
      currency: row.destination_currency,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

async function findById(id) {
  const rows = await query(`${SELECT_WITH_STORES} WHERE c.id = ? LIMIT 1`, [id]);
  return hydrate(rows[0]);
}

async function listAll() {
  const rows = await query(`${SELECT_WITH_STORES} ORDER BY c.id DESC`);
  return rows.map(hydrate);
}

/** Every connection a store takes part in, on either side. */
async function listForStore(storeId) {
  const rows = await query(
    `${SELECT_WITH_STORES}
      WHERE c.source_store_id = ? OR c.destination_store_id = ?
      ORDER BY c.id DESC`,
    [storeId, storeId]
  );
  return rows.map(hydrate);
}

/**
 * The webhook worker's lookup: which live auto-sync connections should react
 * to a change in this source store.
 */
async function listAutoSyncForSource(sourceStoreId) {
  const rows = await query(
    `${SELECT_WITH_STORES}
      WHERE c.source_store_id = ?
        AND c.status = 'active'
        AND c.sync_mode = 'auto'
        AND dst.is_active = 1
      ORDER BY c.id`,
    [sourceStoreId]
  );
  return rows.map(hydrate);
}

/** Connections feeding into one destination store. */
async function listForDestination(destinationStoreId) {
  const rows = await query(
    `${SELECT_WITH_STORES}
      WHERE c.destination_store_id = ?
      ORDER BY c.id DESC`,
    [destinationStoreId]
  );
  return rows.map(hydrate);
}

/** Connections leaving one source store. */
async function listForSource(sourceStoreId) {
  const rows = await query(
    `${SELECT_WITH_STORES}
      WHERE c.source_store_id = ?
      ORDER BY c.id DESC`,
    [sourceStoreId]
  );
  return rows.map(hydrate);
}

/**
 * Everything the "pick your sources" screen needs for one destination store:
 * every store that could feed it, each already marked with whether it is
 * connected and how.
 *
 * The LEFT JOIN is what makes one query enough -- connected and not-yet-
 * connected candidates come back together, so the screen never has to diff two
 * lists. Unconnected stores sort first, since those are the ones to act on.
 *
 * Token columns are deliberately not selected: they are encrypted, and this
 * list has no use for them.
 */
async function listSourceOptionsFor(destinationStoreId) {
  const rows = await query(
    `SELECT s.id, s.shop_domain, s.store_name, s.store_type,
            s.currency, s.is_active,
            c.id AS connection_id, c.status, c.sync_mode, c.last_synced_at,
            (SELECT COUNT(*) FROM product_mappings pm
              WHERE pm.connection_id = c.id AND pm.sync_status = 'synced')
              AS synced_products
       FROM stores s
       LEFT JOIN store_connections c
         ON c.source_store_id = s.id
        AND c.destination_store_id = ?
      -- Only stores paired into the same group. Without this the picker
      -- would list every store that ever installed the app, including other
      -- merchants' stores.
      JOIN stores me
        ON me.id = ?
       AND me.store_group_id = s.store_group_id
      WHERE s.id <> ?
        AND s.is_active = 1
        -- A store already fixed as a destination can never be a source.
        AND (s.store_type = 'source' OR s.store_type IS NULL)
      ORDER BY (c.id IS NOT NULL), s.store_name, s.shop_domain`,
    [destinationStoreId, destinationStoreId, destinationStoreId]
  );

  return rows.map((row) => ({
    id: row.id,
    shop_domain: row.shop_domain,
    store_name: row.store_name,
    store_type: row.store_type,
    currency: row.currency,
    is_active: Boolean(row.is_active),
    // NULL store_type means this store has not been committed to a role yet;
    // connecting it here is what makes it a source.
    role_is_pending: row.store_type === null,
    connected: row.connection_id !== null,
    connection: row.connection_id
      ? {
          id: row.connection_id,
          status: row.status,
          sync_mode: row.sync_mode,
          last_synced_at: row.last_synced_at,
          synced_products: Number(row.synced_products || 0),
        }
      : null,
  }));
}

/**
 * Connect several source stores to one destination in a single action.
 *
 * Each store is attempted independently: one store failing its role check must
 * not silently drop the others. Returns what succeeded and what did not, so the
 * screen can report per-store rather than with one blanket error.
 */
async function connectSources(
  destinationStoreId,
  sourceStoreIds,
  { syncMode = "manual", settings = {} } = {}
) {
  const connected = [];
  const rejected = [];

  for (const sourceStoreId of sourceStoreIds || []) {
    try {
      connected.push(
        await createConnection({
          sourceStoreId,
          destinationStoreId,
          syncMode,
          settings,
        })
      );
    } catch (err) {
      rejected.push({
        sourceStoreId,
        reason: err.message,
        code: err.name,
      });
    }
  }

  return { connected, rejected };
}

async function findPair(sourceStoreId, destinationStoreId) {
  const rows = await query(
    `${SELECT_WITH_STORES}
      WHERE c.source_store_id = ? AND c.destination_store_id = ?
      LIMIT 1`,
    [sourceStoreId, destinationStoreId]
  );
  return hydrate(rows[0]);
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

class DuplicateConnectionError extends Error {
  constructor() {
    super("These two stores are already connected");
    this.name = "DuplicateConnectionError";
    this.statusCode = 409;
  }
}

/** Raised when two stores have not been paired by their operator. */
class NotPairedError extends Error {
  constructor() {
    super(
      "These stores are not linked. Open the app on each store and pair them " +
        "with a pairing code before connecting them."
    );
    this.name = "NotPairedError";
    this.statusCode = 403;
  }
}

class InvalidConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidConnectionError";
    this.statusCode = 400;
  }
}

/**
 * Create a connection, claiming a role for each store as it goes.
 *
 * A store is either a source or a destination, never both, so this is also
 * where an unassigned store gets its role. Role assignment and the insert share
 * one transaction: if the insert fails, the stores must not be left carrying
 * roles from a connection that does not exist.
 *
 * The duplicate check is the UNIQUE index rather than a prior SELECT -- two
 * simultaneous submits would both pass a check-then-insert.
 */
async function createConnection({
  sourceStoreId,
  destinationStoreId,
  syncMode = "manual",
  settings = {},
}) {
  if (Number(sourceStoreId) === Number(destinationStoreId)) {
    throw new InvalidConnectionError(
      "A store cannot sync to itself. Pick a different destination."
    );
  }

  const insertId = await withTransaction(async (connection) => {
    // Lock the lower id first: two merchants wiring A->B and B->A at the same
    // moment would otherwise take the two row locks in opposite orders and
    // deadlock.
    const [first, second] =
      Number(sourceStoreId) < Number(destinationStoreId)
        ? [
            { id: sourceStoreId, role: "source" },
            { id: destinationStoreId, role: "destination" },
          ]
        : [
            { id: destinationStoreId, role: "destination" },
            { id: sourceStoreId, role: "source" },
          ];

    // Defence in depth: the picker only offers same-group stores, but a
    // hand-crafted request must not be able to connect a stranger's store.
    const [groups] = await connection.query(
      `SELECT a.store_group_id AS a_group, b.store_group_id AS b_group
         FROM stores a, stores b WHERE a.id = ? AND b.id = ?`,
      [sourceStoreId, destinationStoreId]
    );

    if (
      !groups.length ||
      groups[0].a_group === null ||
      groups[0].a_group !== groups[0].b_group
    ) {
      throw new NotPairedError();
    }

    await storeModel.assignRole(first.id, first.role, { connection });
    await storeModel.assignRole(second.id, second.role, { connection });

    try {
      const [result] = await connection.query(
        `INSERT INTO store_connections
           (source_store_id, destination_store_id, status, sync_mode, settings)
         VALUES (?, ?, 'active', ?, ?)`,
        [
          sourceStoreId,
          destinationStoreId,
          syncMode === "auto" ? "auto" : "manual",
          toJsonColumn(normalizeSettings(settings)),
        ]
      );

      return result.insertId;
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") throw new DuplicateConnectionError();
      if (err.code === "ER_CONSTRAINT_FAILED" || err.errno === 4025) {
        throw new InvalidConnectionError("A store cannot sync to itself.");
      }
      throw err;
    }
  });

  return findById(insertId);
}

async function updateSettings(id, settings) {
  await query("UPDATE store_connections SET settings = ? WHERE id = ?", [
    toJsonColumn(normalizeSettings(settings)),
    id,
  ]);
  return findById(id);
}

async function setStatus(id, status) {
  if (!["active", "paused", "disconnected"].includes(status)) {
    throw new InvalidConnectionError(`Unknown connection status: ${status}`);
  }

  await query("UPDATE store_connections SET status = ? WHERE id = ?", [status, id]);
  return findById(id);
}

async function setSyncMode(id, syncMode) {
  await query("UPDATE store_connections SET sync_mode = ? WHERE id = ?", [
    syncMode === "auto" ? "auto" : "manual",
    id,
  ]);
  return findById(id);
}

async function touchLastSynced(id, when = new Date()) {
  await query("UPDATE store_connections SET last_synced_at = ? WHERE id = ?", [
    when,
    id,
  ]);
}

async function deleteConnection(id) {
  const [result] = await pool.query("DELETE FROM store_connections WHERE id = ?", [
    id,
  ]);
  return result.affectedRows > 0;
}

module.exports = {
  RoleConflictError: storeModel.RoleConflictError,
  DEFAULT_SETTINGS,
  normalizeSettings,
  findById,
  listAll,
  listForStore,
  listForDestination,
  listForSource,
  listSourceOptionsFor,
  listAutoSyncForSource,
  connectSources,
  findPair,
  createConnection,
  updateSettings,
  setStatus,
  setSyncMode,
  touchLastSynced,
  deleteConnection,
  DuplicateConnectionError,
  InvalidConnectionError,
  NotPairedError,
};
