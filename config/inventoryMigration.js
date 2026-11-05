const { pool } = require("./db");
const { parseJson } = require("../models/helpers");

// Database-only cutover. Shopify changes are durable jobs, processed after boot.
async function migrateInventory() {
  for (const [table, column, type] of [
    ["inventory_allocations", "source_location_id", "VARCHAR(80) DEFAULT NULL"],
    ["product_mappings", "destination_inventory_location_id", "VARCHAR(80) DEFAULT NULL"],
    ["mapping_variant_products", "managed_inventory_locations", "JSON DEFAULT NULL"],
  ]) {
    const [existing] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
    if (!existing.length) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS source_inventory_levels (
    source_variant_id INT NOT NULL,
    location_id VARCHAR(80) NOT NULL,
    available INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (source_variant_id, location_id),
    CONSTRAINT fk_source_level_variant FOREIGN KEY (source_variant_id)
      REFERENCES source_variant_mappings(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [columns] = await pool.query("SHOW COLUMNS FROM orders LIKE 'inventory_updated_at'");
  if (!columns.length) await pool.query("ALTER TABLE orders ADD COLUMN inventory_updated_at BIGINT DEFAULT NULL");
  const [restockColumns] = await pool.query("SHOW COLUMNS FROM orders LIKE 'inventory_restock'");
  if (!restockColumns.length) await pool.query("ALTER TABLE orders ADD COLUMN inventory_restock TINYINT(1) NOT NULL DEFAULT 0");
  await pool.query(`CREATE TABLE IF NOT EXISTS source_inventory_ledger (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    source_variant_id INT NOT NULL,
    source_store_id INT NOT NULL,
    inventory_item_id VARCHAR(64) NOT NULL,
    source_location_id VARCHAR(80) DEFAULT NULL,
    destination_variants JSON DEFAULT NULL,
    applied_quantity INT NOT NULL DEFAULT 0,
    baseline_quantity INT NOT NULL DEFAULT 0,
    locations JSON NOT NULL,
    pending_operation JSON DEFAULT NULL,
    error VARCHAR(512) DEFAULT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_source_inventory_order (order_id, source_variant_id),
    KEY idx_source_inventory_store (source_store_id),
    CONSTRAINT fk_inventory_ledger_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    CONSTRAINT fk_inventory_ledger_store FOREIGN KEY (source_store_id) REFERENCES stores(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [sourceLocationColumns] = await pool.query("SHOW COLUMNS FROM source_inventory_ledger LIKE 'source_location_id'");
  if (!sourceLocationColumns.length) await pool.query("ALTER TABLE source_inventory_ledger ADD COLUMN source_location_id VARCHAR(80) DEFAULT NULL");
  const [variantColumns] = await pool.query("SHOW COLUMNS FROM source_inventory_ledger LIKE 'destination_variants'");
  if (!variantColumns.length) await pool.query("ALTER TABLE source_inventory_ledger ADD COLUMN destination_variants JSON DEFAULT NULL");
  await pool.query(`CREATE TABLE IF NOT EXISTS inventory_cutover (
    id INT PRIMARY KEY, completed_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS inventory_pool_queue (
    source_product_id INT PRIMARY KEY, error VARCHAR(512) DEFAULT NULL, revision BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_inventory_pool_product FOREIGN KEY (source_product_id)
      REFERENCES source_products(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [queueColumns] = await pool.query("SHOW COLUMNS FROM inventory_pool_queue LIKE 'revision'");
  if (!queueColumns.length) await pool.query("ALTER TABLE inventory_pool_queue ADD COLUMN revision BIGINT NOT NULL DEFAULT 0");
  await pool.query(`INSERT IGNORE INTO inventory_pool_queue (source_product_id)
    SELECT DISTINCT svm.source_product_id FROM inventory_allocations ia
    JOIN source_variant_mappings svm ON svm.id = ia.source_variant_mapping_id`);
  const db = await pool.getConnection();
  try {
    const [lock] = await db.query("SELECT GET_LOCK('inventory-v2-cutover', 30) AS acquired");
    if (!Number(lock[0]?.acquired)) throw new Error("Inventory migration is already running");
    await db.beginTransaction();
    const [done] = await db.query("SELECT id FROM inventory_cutover WHERE id = 1");
    if (done.length) {
      // The first cutover seeded old test orders with a zero baseline because
      // they were excluded then. Preserve that historical stock boundary when
      // enabling tests; newer pending test orders still reconcile normally.
      await db.query(`UPDATE source_inventory_ledger l
        JOIN orders o ON o.id = l.order_id
        JOIN inventory_cutover cutover ON cutover.id = 1
        SET l.baseline_quantity = COALESCE((SELECT SUM(li.quantity)
          FROM order_line_items li WHERE li.order_id = o.id AND
            JSON_CONTAINS(l.destination_variants, JSON_QUOTE(JSON_UNQUOTE(JSON_EXTRACT(li.line_data, '$.variant_id'))))), 0)
        WHERE o.test = 1 AND o.created_at < cutover.completed_at
          AND l.applied_quantity = 0 AND l.baseline_quantity = 0
          AND l.pending_operation IS NULL`);
      await db.commit();
      return;
    }
    const [allocations] = await db.query(`SELECT * FROM inventory_allocations WHERE legacy_reserved = 1 ORDER BY id`);
    const pools = new Map(allocations.map((row) => [
      `${row.connection_id}:${row.source_variant_mapping_id}`,
      { row, locations: parseJson(row.location_allocations, []) || [] },
    ]));
    const [lines] = await db.query(`SELECT o.id AS order_id, o.cancelled_at, o.test,
      c.source_store_id, pm.connection_id, svm.id AS source_variant_id,
      svm.shopify_inventory_item_id AS inventory_item_id, SUM(li.quantity) AS quantity,
      GROUP_CONCAT(DISTINCT mvp.destination_variant_id) AS destination_variants
      FROM order_line_items li JOIN orders o ON o.id = li.order_id
      JOIN mapping_variant_products mvp ON mvp.id = li.mapped_variant_id
      JOIN product_mappings pm ON pm.id = mvp.product_mapping_id
      JOIN store_connections c ON c.id = pm.connection_id
      JOIN source_variant_mappings svm ON svm.id = mvp.source_variant_mapping_id
      WHERE svm.shopify_inventory_item_id IS NOT NULL
      GROUP BY o.id, o.cancelled_at, o.test, c.source_store_id, pm.connection_id,
        svm.id, svm.shopify_inventory_item_id ORDER BY o.id`);
    for (const line of lines) {
      const quantity = line.cancelled_at ? 0 : Number(line.quantity);
      const pool = pools.get(`${line.connection_id}:${line.source_variant_id}`);
      const locations = [];
      let needed = pool ? quantity : 0;
      // Old reservations already paid for these sales. Preserve their exact
      // locations so a later cancellation can restore only the units sold.
      for (const location of pool?.locations || []) {
        const take = Math.min(Number(location.quantity), needed);
        if (take > 0) locations.push({ locationId: location.locationId, quantity: take });
        location.quantity -= take;
        needed -= take;
      }
      if (needed) throw new Error("Legacy inventory reservation is incomplete; reconcile source stock before upgrading");
      await db.query(`INSERT INTO source_inventory_ledger
        (order_id, source_variant_id, source_store_id, inventory_item_id,
          applied_quantity, baseline_quantity, locations, destination_variants) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [line.order_id, line.source_variant_id, line.source_store_id, line.inventory_item_id,
        pool ? quantity : 0, pool ? 0 : quantity, JSON.stringify(locations), JSON.stringify(String(line.destination_variants).split(","))]);
    }
    // Only the unsold part of an old reservation is restored at cutover.
    for (const { row, locations } of pools.values()) {
      await db.query("UPDATE inventory_allocations SET location_allocations = ? WHERE id = ?",
        [JSON.stringify(locations.filter((location) => location.quantity > 0)), row.id]);
    }
    await db.query("INSERT INTO inventory_cutover VALUES (1, UTC_TIMESTAMP())");
    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    await db.query("SELECT RELEASE_LOCK('inventory-v2-cutover')");
    db.release();
  }
}

module.exports = { migrateInventory };
