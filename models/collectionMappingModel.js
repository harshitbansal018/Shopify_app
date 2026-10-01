// models/collectionMappingModel.js
//
// `collection_mappings` -- which collection in the source store became which
// collection in the destination store, for one connection.
//
// Invisible to merchants: no screen reads it. It exists so the push does not
// have to ask the destination "have you got a collection called this" once
// per product, and so the app knows which collections are its own to write to
// and which the destination already had.
const { query, pool } = require("../config/db");

function hydrate(row) {
  if (!row) return null;

  return {
    ...row,
    created_by_app: Boolean(row.created_by_app),
    destination_shopify_collection_id: row.destination_shopify_collection_id
      ? String(row.destination_shopify_collection_id)
      : null,
    source_shopify_collection_id: String(row.source_shopify_collection_id),
  };
}

/** Every collection this connection has already placed, by source id. */
async function mapForConnection(connectionId) {
  const rows = await query(
    "SELECT * FROM collection_mappings WHERE connection_id = ?",
    [connectionId]
  );

  return new Map(
    rows.map((row) => [String(row.source_shopify_collection_id), hydrate(row)])
  );
}

/**
 * Record where a source collection landed.
 *
 * `createdByApp` is only ever written on the way IN. A row that says the
 * destination already owned this collection must not be turned into one that
 * says we made it, however many times the push runs -- that flag is the whole
 * basis on which the app decides what it may rename or remove.
 */
async function remember(
  connectionId,
  { sourceCollectionId, destinationCollectionId, title, handle, createdByApp }
) {
  await pool.query(
    `INSERT INTO collection_mappings
       (connection_id, source_shopify_collection_id,
        destination_shopify_collection_id, title, handle, created_by_app)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       destination_shopify_collection_id = VALUES(destination_shopify_collection_id),
       title  = VALUES(title),
       handle = VALUES(handle)`,
    [
      connectionId,
      String(sourceCollectionId),
      destinationCollectionId ? String(destinationCollectionId) : null,
      title ? String(title).slice(0, 255) : null,
      handle ? String(handle).slice(0, 255) : null,
      createdByApp ? 1 : 0,
    ]
  );

  return findBySource(connectionId, sourceCollectionId);
}

async function findBySource(connectionId, sourceCollectionId) {
  const rows = await query(
    `SELECT * FROM collection_mappings
      WHERE connection_id = ? AND source_shopify_collection_id = ? LIMIT 1`,
    [connectionId, String(sourceCollectionId)]
  );

  return hydrate(rows[0]);
}

/** Only the ones this app created: the ones it may write to. */
async function listOwned(connectionId) {
  const rows = await query(
    `SELECT * FROM collection_mappings
      WHERE connection_id = ? AND created_by_app = 1`,
    [connectionId]
  );

  return rows.map(hydrate);
}

async function countForConnection(connectionId) {
  const rows = await query(
    "SELECT COUNT(*) AS total FROM collection_mappings WHERE connection_id = ?",
    [connectionId]
  );

  return Number(rows[0].total || 0);
}

module.exports = {
  mapForConnection,
  remember,
  findBySource,
  listOwned,
  countForConnection,
};
