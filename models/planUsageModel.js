// models/planUsageModel.js
//
// What a destination store is USING of its plan, counted from the tables that
// already record it. Nothing is stored twice: a separate running counter would
// be a second answer to "how many products do I have", and it would be the one
// that drifts.
//
//   products  accepted into the store (the Synced tab), across every
//             supplier -- active or paused, because a paused supplier's
//             products are still sitting in the store
//   sources   suppliers whose connection is ACTIVE
//   orders    distinct sales routed to a supplier in the billing month; test
//             orders do not count
//   emails    notification emails queued or sent in the billing month. Ones
//             skipped or failed never reached anyone, and plan notices are the
//             app talking about the plan, not the merchant's email use.
//
// Plus the writes that must be checked against a limit in the SAME transaction
// that makes them: accepting products, resuming a store, and a downgrade's
// choices. Each locks the destination's own stores row first, so two tabs --
// or two app processes -- cannot both see "24 of 25" and both add one.
const { query, withTransaction } = require("../config/db");

const PRODUCTS_SQL = `
  SELECT COUNT(*) AS total
    FROM product_mappings m
    JOIN store_connections c ON c.id = m.connection_id
   WHERE c.destination_store_id = ?
     AND m.accepted_at IS NOT NULL
     AND m.sync_status <> 'deleted'`;

const SOURCES_SQL = `
  SELECT COUNT(*) AS total
    FROM store_connections
   WHERE destination_store_id = ? AND status = 'active'`;

const ORDERS_SQL = `
  SELECT COUNT(DISTINCT om.destination_order_id) AS total
    FROM order_mappings om
    JOIN store_connections c ON c.id = om.connection_id
    JOIN orders o            ON o.id = om.destination_order_id
   WHERE c.destination_store_id = ?
     AND o.test = 0
     AND om.created_at >= ? AND om.created_at < ?`;

const EMAILS_SQL = `
  SELECT COUNT(*) AS total
    FROM email_outbox e
    JOIN store_connections c ON c.id = e.connection_id
   WHERE c.destination_store_id = ?
     AND e.kind <> 'plan_notice'
     AND e.status IN ('pending', 'sending', 'sent')
     AND e.created_at >= ? AND e.created_at < ?`;

const total = (rows) => Number((rows[0] && rows[0].total) || 0);

/** Serialise every limited write for one store behind its own row. */
const LOCK_STORE = "SELECT id FROM stores WHERE id = ? FOR UPDATE";

async function countProducts(destinationStoreId) {
  return total(await query(PRODUCTS_SQL, [destinationStoreId]));
}

async function countSources(destinationStoreId) {
  return total(await query(SOURCES_SQL, [destinationStoreId]));
}

async function countOrders(destinationStoreId, start, end) {
  return total(await query(ORDERS_SQL, [destinationStoreId, start, end]));
}

async function countEmails(destinationStoreId, start, end) {
  return total(await query(EMAILS_SQL, [destinationStoreId, start, end]));
}

/** All four at once, for one billing month. */
async function usage(destinationStoreId, period) {
  const [products, sources, orders, emails] = await Promise.all([
    countProducts(destinationStoreId),
    countSources(destinationStoreId),
    countOrders(destinationStoreId, period.start, period.end),
    countEmails(destinationStoreId, period.start, period.end),
  ]);

  return { products, orders, emails, sources };
}

const idList = (ids) =>
  [...new Set((ids || []).map(Number))].filter((id) => Number.isInteger(id) && id > 0);

/**
 * Accept offered products into the store -- all of them, or none.
 *
 * Refused outright when they would take the store past `limit` (null =
 * unlimited). Accepting some and silently dropping the rest would leave the
 * merchant guessing which ones made it.
 *
 * Only rows that are really this store's, and really waiting, count towards
 * the request: an id from someone else's store, or one already accepted,
 * neither takes a slot nor is touched.
 */
async function acceptWithinLimit(destinationStoreId, mappingIds, limit) {
  const ids = idList(mappingIds);

  if (!ids.length) return { accepted: 0, adding: 0, used: null, limit };

  return withTransaction(async (conn) => {
    await conn.query(LOCK_STORE, [destinationStoreId]);

    const [countRows] = await conn.query(PRODUCTS_SQL, [destinationStoreId]);
    const used = total(countRows);

    const [waiting] = await conn.query(
      `SELECT m.id
         FROM product_mappings m
         JOIN store_connections c ON c.id = m.connection_id
        WHERE m.id IN (?)
          AND c.destination_store_id = ?
          AND m.accepted_at IS NULL
          AND m.sync_status <> 'deleted'`,
      [ids, destinationStoreId]
    );

    const adding = waiting.length;

    if (limit !== null && used + adding > limit) {
      return {
        accepted: 0,
        refused: true,
        adding,
        used,
        limit,
        remaining: Math.max(0, limit - used),
      };
    }

    if (!adding) return { accepted: 0, adding: 0, used, limit };

    const [result] = await conn.query(
      `UPDATE product_mappings
          SET accepted_at = NOW(), sync_status = 'pending'
        WHERE id IN (?)`,
      [waiting.map((row) => row.id)]
    );

    return { accepted: result.affectedRows, adding, used: used + result.affectedRows, limit };
  });
}

/**
 * Resume one paused source store, if the plan has room for another active one.
 *
 * Only a PAUSED connection resumes: a disconnected one went through Delete,
 * and bringing it back is a new pairing, not a switch.
 */
async function resumeWithinLimit(destinationStoreId, connectionId, limit) {
  return withTransaction(async (conn) => {
    await conn.query(LOCK_STORE, [destinationStoreId]);

    const [rows] = await conn.query(
      "SELECT id, status FROM store_connections WHERE id = ? AND destination_store_id = ?",
      [connectionId, destinationStoreId]
    );

    const connection = rows[0];

    if (!connection || !["paused", "active"].includes(connection.status)) {
      return { notFound: true };
    }

    if (connection.status === "active") return { resumed: 0, already: true };

    const [countRows] = await conn.query(SOURCES_SQL, [destinationStoreId]);
    const used = total(countRows);

    if (limit !== null && used >= limit) return { refused: true, used, limit };

    await conn.query("UPDATE store_connections SET status = 'active' WHERE id = ?", [
      connectionId,
    ]);

    return { resumed: 1, used: used + 1, limit };
  });
}

/**
 * Apply a downgrade's choices, or nothing at all.
 *
 * `productLimit` / `sourceLimit` are the TARGET plan's. How much has to go is
 * worked out again inside the lock, from the usage as it is at this moment --
 * not from whatever the screen showed when it was opened. Then the choices are
 * checked against it, and only applied if they are enough.
 *
 * Unsync is exactly what the Synced tab's Unsync does: the product stays in
 * the Shopify store as it is and simply stops receiving updates. Pause stops a
 * supplier syncing; its products stay too, and its orders still route.
 */
async function applyDowngradeChoices(
  destinationStoreId,
  { unsync = [], pause = [], productLimit = null, sourceLimit = null }
) {
  const unsyncIds = idList(unsync);
  const pauseIds = idList(pause);

  return withTransaction(async (conn) => {
    await conn.query(LOCK_STORE, [destinationStoreId]);

    const [productRows] = await conn.query(PRODUCTS_SQL, [destinationStoreId]);
    const [sourceRows] = await conn.query(SOURCES_SQL, [destinationStoreId]);

    const needProducts =
      productLimit === null ? 0 : Math.max(0, total(productRows) - productLimit);
    const needSources =
      sourceLimit === null ? 0 : Math.max(0, total(sourceRows) - sourceLimit);

    // Only what is really eligible counts towards the choice: an id that is
    // not this store's, or is already unsynced or paused, frees nothing.
    const [products] = unsyncIds.length
      ? await conn.query(
          `SELECT m.id
             FROM product_mappings m
             JOIN store_connections c ON c.id = m.connection_id
            WHERE m.id IN (?)
              AND c.destination_store_id = ?
              AND m.accepted_at IS NOT NULL
              AND m.sync_status <> 'deleted'`,
          [unsyncIds, destinationStoreId]
        )
      : [[]];

    const [sources] = pauseIds.length
      ? await conn.query(
          `SELECT id FROM store_connections
            WHERE id IN (?) AND destination_store_id = ? AND status = 'active'`,
          [pauseIds, destinationStoreId]
        )
      : [[]];

    if (products.length < needProducts || sources.length < needSources) {
      return {
        ok: false,
        needProducts,
        needSources,
        chosenProducts: products.length,
        chosenSources: sources.length,
      };
    }

    if (sources.length) {
      await conn.query("UPDATE store_connections SET status = 'paused' WHERE id IN (?)", [
        sources.map((row) => row.id),
      ]);
    }

    if (products.length) {
      await conn.query(
        `UPDATE product_mappings
            SET accepted_at = NULL, sync_status = 'skipped'
          WHERE id IN (?)`,
        [products.map((row) => row.id)]
      );
    }

    return {
      ok: true,
      unsynced: products.length,
      paused: sources.length,
      needProducts,
      needSources,
    };
  });
}

/** The products a downgrade can unsync: everything accepted into the store. */
async function listAcceptedForDestination(destinationStoreId) {
  return query(
    `SELECT m.id AS mapping_id,
            m.connection_id,
            sp.title,
            JSON_UNQUOTE(JSON_EXTRACT(sp.product_data, '$.image')) AS image_url,
            src.store_name  AS source_store_name,
            src.shop_domain AS source_shop_domain
       FROM product_mappings m
       JOIN store_connections c ON c.id = m.connection_id
       JOIN stores src          ON src.id = c.source_store_id
       JOIN source_products sp  ON sp.id = m.source_product_id
      WHERE c.destination_store_id = ?
        AND m.accepted_at IS NOT NULL
        AND m.sync_status <> 'deleted'
      ORDER BY src.store_name, src.shop_domain, sp.title, m.id`,
    [destinationStoreId]
  );
}

/** The source stores a downgrade can pause, with how many products each has here. */
async function listActiveConnections(destinationStoreId) {
  return query(
    `SELECT c.id,
            src.store_name,
            src.shop_domain,
            (SELECT COUNT(*) FROM product_mappings m
              WHERE m.connection_id = c.id
                AND m.accepted_at IS NOT NULL
                AND m.sync_status <> 'deleted') AS products
       FROM store_connections c
       JOIN stores src ON src.id = c.source_store_id
      WHERE c.destination_store_id = ? AND c.status = 'active'
      ORDER BY src.store_name, src.shop_domain`,
    [destinationStoreId]
  );
}

/**
 * The database's own clock.
 *
 * Billing months are measured against timestamps the database wrote -- NOW()
 * when a plan is activated, CURRENT_TIMESTAMP on every order and email -- so
 * "now" has to come from the same clock. A MySQL session running in local time
 * would otherwise put every boundary hours out, and a brand new plan would
 * spend its first hours counting against the old one.
 */
async function dbNow() {
  const rows = await query("SELECT NOW() AS now");
  return rows[0] && rows[0].now ? new Date(rows[0].now) : new Date();
}

module.exports = {
  dbNow,
  countProducts,
  countSources,
  countOrders,
  countEmails,
  usage,
  acceptWithinLimit,
  resumeWithinLimit,
  applyDowngradeChoices,
  listAcceptedForDestination,
  listActiveConnections,
};
