// config/migrate.js
//
// Idempotent schema setup, applied on every boot so a fresh checkout and an
// existing database converge on the same shape.
//
// Order matters: a table has to exist before another table can point a foreign
// key at it. Creation runs parents-first, exactly as listed below.
const { query } = require("./db");

const DUPLICATE_COLUMN = "ER_DUP_FIELDNAME";
const DUPLICATE_KEY = "ER_DUP_KEYNAME";
const MISSING_COLUMN = "ER_CANT_DROP_FIELD_OR_KEY";

async function safeAlter(label, sql) {
  try {
    await query(sql);
    console.log(`Migration applied: ${label}`);
  } catch (err) {
    if (err.code === DUPLICATE_COLUMN || err.code === DUPLICATE_KEY) {
      return; // already applied
    }
    console.error(`Migration failed (${label}):`, err.message);
    throw err;
  }
}

/** Drop something that may already be gone. */
async function safeDrop(label, sql) {
  try {
    await query(sql);
    console.log(`Migration applied: ${label}`);
  } catch (err) {
    if (err.code === MISSING_COLUMN) return; // already dropped
    console.error(`Migration failed (${label}):`, err.message);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 1. stores                                                           */
/* ------------------------------------------------------------------ */
const CREATE_STORES = `
  CREATE TABLE IF NOT EXISTS stores (
    id            INT AUTO_INCREMENT PRIMARY KEY,

    shop_domain   VARCHAR(255) NOT NULL,
    store_name    VARCHAR(255) DEFAULT NULL,

    -- AES-256-GCM ciphertext, never plaintext. See utils/crypto.js.
    access_token  TEXT DEFAULT NULL,

    -- Shopify issues EXPIRING offline tokens; without these the app cannot
    -- refresh and every store breaks an hour after install.
    access_token_expires_at  DATETIME DEFAULT NULL,
    refresh_token            TEXT DEFAULT NULL,
    refresh_token_expires_at DATETIME DEFAULT NULL,

    -- Stores sharing a group are controlled by the same operator and may be
    -- connected to each other. A store installs into a group of its own; the
    -- pairing flow is the only way to join two groups together.
    store_group_id CHAR(36) DEFAULT NULL,

    -- Short-lived code shown by one store and typed into another to prove the
    -- same person controls both.
    pairing_code             VARCHAR(16) DEFAULT NULL,
    pairing_code_expires_at  DATETIME DEFAULT NULL,

    api_version   VARCHAR(16) NOT NULL DEFAULT '2025-01',
    -- A store is EITHER a source or a destination, never both.
    -- NULL means the role has not been decided yet.
    store_type    ENUM('source','destination') DEFAULT NULL,
    currency      VARCHAR(8) DEFAULT NULL,

    is_active     TINYINT(1) NOT NULL DEFAULT 1,
    installed_at  DATETIME DEFAULT NULL,
    uninstalled_at DATETIME DEFAULT NULL,

    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_shop_domain (shop_domain),
    UNIQUE KEY uniq_pairing_code (pairing_code),
    KEY idx_stores_group (store_group_id),
    KEY idx_stores_type_active (store_type, is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* 2. store_connections  (self-referencing: stores twice)              */
/* ------------------------------------------------------------------ */
const CREATE_STORE_CONNECTIONS = `
  CREATE TABLE IF NOT EXISTS store_connections (
    id                    INT AUTO_INCREMENT PRIMARY KEY,

    source_store_id       INT NOT NULL,
    destination_store_id  INT NOT NULL,

    status     ENUM('active','paused','disconnected') NOT NULL DEFAULT 'active',
    sync_mode  ENUM('manual','auto') NOT NULL DEFAULT 'manual',

    -- { price_markup_percent, sync_images, sync_inventory,
    --   delete_behaviour: delete|draft|ignore, product_filter }
    settings   JSON NOT NULL,

    last_synced_at DATETIME DEFAULT NULL,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_connection_pair (source_store_id, destination_store_id),
    KEY idx_conn_source (source_store_id, status, sync_mode),
    KEY idx_conn_destination (destination_store_id),

    -- A store syncing to itself would loop webhooks back into their own source.
    CONSTRAINT chk_conn_distinct CHECK (source_store_id <> destination_store_id),

    CONSTRAINT fk_conn_source
      FOREIGN KEY (source_store_id) REFERENCES stores(id) ON DELETE CASCADE,
    CONSTRAINT fk_conn_destination
      FOREIGN KEY (destination_store_id) REFERENCES stores(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* 3. source_products                                                  */
/* ------------------------------------------------------------------ */
const CREATE_SOURCE_PRODUCTS = `
  CREATE TABLE IF NOT EXISTS source_products (
    id                 INT AUTO_INCREMENT PRIMARY KEY,
    store_id           INT NOT NULL,

    shopify_product_id BIGINT UNSIGNED NOT NULL,

    title        VARCHAR(512) DEFAULT NULL,
    handle       VARCHAR(255) DEFAULT NULL,
    vendor       VARCHAR(255) DEFAULT NULL,
    product_type VARCHAR(255) DEFAULT NULL,
    status       VARCHAR(32)  DEFAULT NULL,

    -- Full Shopify payload, kept so a re-sync needs no extra API call.
    product_data JSON DEFAULT NULL,

    -- Which variants the merchant ticked in the resource picker when they
    -- added this product, as an array of source_variant_mappings ids.
    -- NULL means every variant.
    --
    -- It lives here, not on product_mappings, because it is chosen BEFORE any
    -- connection exists. Allowing the product copies it onto the mapping,
    -- which is what the push actually reads.
    selected_variant_ids JSON DEFAULT NULL,

    shopify_updated_at DATETIME DEFAULT NULL,
    last_fetched_at    DATETIME DEFAULT NULL,

    UNIQUE KEY uniq_store_product (store_id, shopify_product_id),
    KEY idx_source_products_updated (store_id, shopify_updated_at),

    CONSTRAINT fk_source_product_store
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* 4. product_mappings                                                 */
/* ------------------------------------------------------------------ */
const CREATE_PRODUCT_MAPPINGS = `
  CREATE TABLE IF NOT EXISTS product_mappings (
    id                INT AUTO_INCREMENT PRIMARY KEY,

    connection_id     INT NOT NULL,
    source_product_id INT NOT NULL,

    -- Denormalised so the hot lookup (connection + shopify id) needs no join.
    source_shopify_product_id      BIGINT UNSIGNED NOT NULL,
    destination_shopify_product_id BIGINT UNSIGNED DEFAULT NULL,

    sync_status ENUM('pending','synced','failed','skipped','deleted')
                NOT NULL DEFAULT 'pending',

    -- Which variants of this product may go to the destination, as an array of
    -- source_variant_mappings ids.
    --
    -- NULL means EVERY variant, and is not the same as an empty array. A
    -- merchant who ticks the product without narrowing it wants new variants
    -- added at the source to flow too; a merchant who picked three specific
    -- variants does not.
    allowed_variant_ids JSON DEFAULT NULL,

    -- When the DESTINATION store agreed to receive this product.
    --
    -- The source allowing a product only OFFERS it; nothing is written to the
    -- destination until its own operator ticks it. NULL means "waiting for
    -- them". Once set it stays set, so later updates to an accepted product
    -- flow through without asking again -- which is the point of a sync.
    accepted_at DATETIME DEFAULT NULL,

    source_updated_at DATETIME DEFAULT NULL,
    last_synced_at    DATETIME DEFAULT NULL,
    error_message     TEXT DEFAULT NULL,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_mapping (connection_id, source_shopify_product_id),
    KEY idx_mapping_source_product (source_product_id),
    KEY idx_mapping_status (connection_id, sync_status),
    KEY idx_mapping_destination (destination_shopify_product_id),

    CONSTRAINT fk_mapping_connection
      FOREIGN KEY (connection_id) REFERENCES store_connections(id) ON DELETE CASCADE,
    CONSTRAINT fk_mapping_source_product
      FOREIGN KEY (source_product_id) REFERENCES source_products(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* 5. source_variant_mappings                                          */
/* ------------------------------------------------------------------ */
/*
 * The variants of a cached source product, one row each.
 *
 * This is to source_products what source_products is to the source store: a
 * local copy of what exists upstream. Splitting it out of the product_data
 * JSON means a variant can be looked up by SKU, compared field by field to
 * decide whether anything actually changed, and shared by every connection
 * that syncs the same source product.
 */
const CREATE_SOURCE_VARIANT_MAPPINGS = `
  CREATE TABLE IF NOT EXISTS source_variant_mappings (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    source_product_id INT NOT NULL,

    shopify_variant_id        BIGINT UNSIGNED NOT NULL,
    shopify_inventory_item_id BIGINT UNSIGNED DEFAULT NULL,

    sku              VARCHAR(255) DEFAULT NULL,
    barcode          VARCHAR(255) DEFAULT NULL,
    title            VARCHAR(255) DEFAULT NULL,
    price            DECIMAL(12,2) DEFAULT NULL,
    compare_at_price DECIMAL(12,2) DEFAULT NULL,
    -- Unit cost. DECIMAL like every other money column here.
    cost             DECIMAL(12,2) DEFAULT NULL,
    taxable          TINYINT(1) DEFAULT NULL,
    -- CONTINUE or DENY: whether the shop keeps selling at zero stock.
    inventory_policy VARCHAR(16) DEFAULT NULL,

    option1 VARCHAR(255) DEFAULT NULL,
    option2 VARCHAR(255) DEFAULT NULL,
    option3 VARCHAR(255) DEFAULT NULL,

    inventory_quantity INT DEFAULT NULL,
    position           INT DEFAULT NULL,

    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_source_variant (source_product_id, shopify_variant_id),
    KEY idx_source_variant_sku (sku),

    CONSTRAINT fk_source_variant_product
      FOREIGN KEY (source_product_id) REFERENCES source_products(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* 6. mapping_variant_products                                         */
/* ------------------------------------------------------------------ */
/*
 * Variants that have ALREADY been synced to a destination store.
 *
 * Where source_variant_mappings records what exists at the source, this records
 * what exists at the destination and which source variant it came from. One row
 * per connection per variant.
 *
 * The stored id pair is why variants are never matched by title or position:
 * rename "Small" to "S" at either end and the two ids still point at each other.
 */
const CREATE_MAPPING_VARIANT_PRODUCTS = `
  CREATE TABLE IF NOT EXISTS mapping_variant_products (
    id                 INT AUTO_INCREMENT PRIMARY KEY,

    product_mapping_id        INT NOT NULL,
    source_variant_mapping_id INT NOT NULL,

    -- Denormalised from source_variant_mappings for the per-variant lookup.
    source_shopify_variant_id BIGINT UNSIGNED NOT NULL,

    destination_variant_id        BIGINT UNSIGNED DEFAULT NULL,
    destination_inventory_item_id BIGINT UNSIGNED DEFAULT NULL,

    sku VARCHAR(255) DEFAULT NULL,

    last_synced_at DATETIME DEFAULT NULL,

    UNIQUE KEY uniq_mapping_variant (product_mapping_id, source_shopify_variant_id),
    KEY idx_mvp_source_variant (source_variant_mapping_id),
    KEY idx_mvp_destination (destination_variant_id),
    KEY idx_mvp_inventory_item (destination_inventory_item_id),

    CONSTRAINT fk_mvp_product_mapping
      FOREIGN KEY (product_mapping_id) REFERENCES product_mappings(id) ON DELETE CASCADE,
    CONSTRAINT fk_mvp_source_variant
      FOREIGN KEY (source_variant_mapping_id) REFERENCES source_variant_mappings(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/**
 * Narrow store_type from the original three-value enum down to two.
 *
 * Run in three steps because MySQL cannot shrink an ENUM while rows still hold
 * the value being removed: widen to nullable first, blank out the old value,
 * then drop it from the type. Re-running this is a no-op.
 */
async function narrowStoreType() {
  const [column] = await query("SHOW COLUMNS FROM stores LIKE 'store_type'");

  if (!column || !String(column.Type).includes("'both'")) return;

  console.log("Migration: narrowing store_type to source|destination");

  await query(
    `ALTER TABLE stores
       MODIFY store_type ENUM('source','destination','both') DEFAULT NULL`
  );

  // A store that claimed to be both has no valid role any more; the merchant
  // must choose one. NULL is that "not chosen yet" state.
  const [result] = await require("./db").pool.query(
    "UPDATE stores SET store_type = NULL WHERE store_type = 'both'"
  );

  if (result.affectedRows) {
    console.log(
      `Migration: ${result.affectedRows} store(s) reset to no role -- pick one in the app`
    );
  }

  await query(
    "ALTER TABLE stores MODIFY store_type ENUM('source','destination') DEFAULT NULL"
  );
}

/**
 * Add store grouping to a database created before it existed.
 *
 * Every store that predates this gets a group of its own, which is the safe
 * default: it can see nobody until its owner pairs it with another store.
 */
async function addStoreGrouping() {
  await safeAlter(
    "stores.store_group_id",
    "ALTER TABLE stores ADD COLUMN store_group_id CHAR(36) DEFAULT NULL"
  );
  await safeAlter(
    "stores.pairing_code",
    "ALTER TABLE stores ADD COLUMN pairing_code VARCHAR(16) DEFAULT NULL"
  );
  await safeAlter(
    "stores.pairing_code_expires_at",
    "ALTER TABLE stores ADD COLUMN pairing_code_expires_at DATETIME DEFAULT NULL"
  );
  await safeAlter(
    "stores.uniq_pairing_code",
    "ALTER TABLE stores ADD UNIQUE KEY uniq_pairing_code (pairing_code)"
  );
  await safeAlter(
    "stores.idx_stores_group",
    "ALTER TABLE stores ADD INDEX idx_stores_group (store_group_id)"
  );

  const orphans = await query(
    "SELECT id FROM stores WHERE store_group_id IS NULL"
  );

  if (!orphans.length) return;

  const { randomUUID } = require("crypto");

  for (const row of orphans) {
    await query("UPDATE stores SET store_group_id = ? WHERE id = ?", [
      randomUUID(),
      row.id,
    ]);
  }

  console.log(
    `Migration: gave ${orphans.length} existing store(s) their own group`
  );
}

/* ------------------------------------------------------------------ */
/* 7. orders                                                           */
/* ------------------------------------------------------------------ */
/*
 * Orders placed in a store, cached the same way source_products caches the
 * catalogue: a few columns worth querying, plus the full payload.
 *
 * This table holds PERSONAL DATA -- email, phone, name, two addresses. That
 * makes the customers/redact and customers/data_request webhooks real
 * obligations rather than the no-ops they were before. See
 * controllers/webhookController.js.
 */
const CREATE_ORDERS = `
  CREATE TABLE IF NOT EXISTS orders (
    id       INT AUTO_INCREMENT PRIMARY KEY,
    store_id INT NOT NULL,

    shopify_order_id BIGINT UNSIGNED NOT NULL,
    order_number     INT DEFAULT NULL,
    name             VARCHAR(50) DEFAULT NULL,

    -- Money is DECIMAL, never FLOAT: 10.00 must not become 9.999999.
    currency VARCHAR(3) DEFAULT NULL,
    subtotal_price  DECIMAL(12,2) DEFAULT NULL,
    total_tax       DECIMAL(12,2) DEFAULT NULL,
    total_discounts DECIMAL(12,2) DEFAULT NULL,
    total_shipping  DECIMAL(12,2) DEFAULT NULL,
    total_price     DECIMAL(12,2) DEFAULT NULL,

    -- Shopify tracks three states that move independently. An order can be
    -- paid, unfulfilled and cancelled all at once, so they cannot be collapsed.
    financial_status    VARCHAR(32) DEFAULT NULL,
    fulfillment_status  VARCHAR(32) DEFAULT NULL,
    cancelled_at        DATETIME DEFAULT NULL,
    cancel_reason       VARCHAR(64) DEFAULT NULL,
    closed_at           DATETIME DEFAULT NULL,

    -- Test orders must never be counted in reporting.
    test TINYINT(1) NOT NULL DEFAULT 0,

    -- Who placed it. Name, email and phone live in the customers table,
    -- joined on this id, rather than being copied onto every order.
    customer_shopify_id BIGINT UNSIGNED DEFAULT NULL,

    -- Still personal data: a Shopify address carries a name and a phone
    -- number. Erased in place by customers/redact.
    billing_address  JSON DEFAULT NULL,
    shipping_address JSON DEFAULT NULL,

    -- Flattened out of the address blob because reporting and tax need it.
    shipping_country_code VARCHAR(2) DEFAULT NULL,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_store_order (store_id, shopify_order_id),
    KEY idx_orders_placed (store_id, created_at),
    KEY idx_orders_financial (store_id, financial_status),
    KEY idx_orders_fulfillment (store_id, fulfillment_status),
    -- customers/redact arrives with a customer id and nothing else.
    KEY idx_orders_customer (customer_shopify_id),

    CONSTRAINT fk_order_store
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* 8. order_line_items                                                 */
/* ------------------------------------------------------------------ */
/*
 * What was actually bought. An order without its lines says almost nothing.
 *
 * shopify_product_id stays a plain column, NOT a foreign key: the product may
 * have been deleted since the order was placed, and a real FK would either
 * block the insert or delete sales history along with the product.
 *
 * mapped_variant_id IS a foreign key, onto mapping_variant_products(id) -- the
 * primary key, so the link is unambiguous. ON DELETE SET NULL keeps the sale
 * when the mapping goes.
 */
const CREATE_ORDER_LINE_ITEMS = `
  CREATE TABLE IF NOT EXISTS order_line_items (
    id       INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,

    shopify_line_item_id BIGINT UNSIGNED NOT NULL,
    shopify_product_id   BIGINT UNSIGNED DEFAULT NULL,

    -- The variant that was sold, as a reference to our mapping record rather
    -- than a raw Shopify id. NULL when the variant was never synced by this
    -- app -- a line can exist for a product that was created directly on the
    -- store, and sku/variant_title still say what it was.
    mapped_variant_id INT DEFAULT NULL,

    sku           VARCHAR(255) DEFAULT NULL,
    title         VARCHAR(512) DEFAULT NULL,
    variant_title VARCHAR(255) DEFAULT NULL,
    vendor        VARCHAR(255) DEFAULT NULL,

    quantity       INT NOT NULL DEFAULT 0,
    price          DECIMAL(12,2) DEFAULT NULL,
    total_discount DECIMAL(12,2) DEFAULT NULL,

    fulfillment_status VARCHAR(32) DEFAULT NULL,
    requires_shipping  TINYINT(1) NOT NULL DEFAULT 1,

    line_data JSON DEFAULT NULL,

    UNIQUE KEY uniq_order_line (order_id, shopify_line_item_id),
    KEY idx_line_product (shopify_product_id),
    KEY idx_line_variant (mapped_variant_id),
    KEY idx_line_sku (sku),

    CONSTRAINT fk_line_order
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,

    -- SET NULL, not CASCADE: removing a mapping must never delete the record
    -- of a sale that already happened.
    CONSTRAINT fk_line_mapped_variant
      FOREIGN KEY (mapped_variant_id) REFERENCES mapping_variant_products(id)
        ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* 9. customers                                                        */
/* ------------------------------------------------------------------ */
/*
 * A minimal cache of a store's customers.
 *
 * PERSONAL DATA: name, email, phone and addresses. customers/redact deletes
 * the row outright -- there is no anonymised-but-kept state here, because
 * unlike an order a customer record has no sales history that must survive.
 */
const CREATE_CUSTOMERS = `
  CREATE TABLE IF NOT EXISTS customers (
    id       INT AUTO_INCREMENT PRIMARY KEY,
    store_id INT NOT NULL,

    shopify_customer_id BIGINT UNSIGNED NOT NULL,

    first_name VARCHAR(255) DEFAULT NULL,
    last_name  VARCHAR(255) DEFAULT NULL,
    email      VARCHAR(255) DEFAULT NULL,
    phone      VARCHAR(64)  DEFAULT NULL,

    -- A customer can have several; kept as the array Shopify sends.
    addresses  JSON DEFAULT NULL,

    shopify_created_at DATETIME DEFAULT NULL,
    shopify_updated_at DATETIME DEFAULT NULL,
    last_fetched_at    DATETIME DEFAULT NULL,

    UNIQUE KEY uniq_store_customer (store_id, shopify_customer_id),
    KEY idx_customers_email (store_id, email),
    -- customers/redact arrives with a Shopify customer id and nothing else.
    KEY idx_customers_shopify_id (shopify_customer_id),

    CONSTRAINT fk_customer_store
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/**
 * Trim columns off orders that are no longer wanted.
 *
 * Customer identity moved to the customers table, joined on
 * customer_shopify_id. The raw payload copy and the Shopify-side timestamps
 * were dropped afterwards; created_at (when this app first saw the order) is
 * what remains to order by.
 *
 * The addresses stay: they are part of the order, not of the customer profile,
 * and a delivery address can differ from the one on file.
 */
async function slimOrdersCustomerColumns() {
  await safeDrop("orders.idx_orders_email", "ALTER TABLE orders DROP INDEX idx_orders_email");
  // Indexed a column that is going; rebuilt on created_at below.
  await safeDrop("orders.idx_orders_placed", "ALTER TABLE orders DROP INDEX idx_orders_placed");

  for (const column of [
    "presentment_currency",
    "email",
    "phone",
    "customer_first_name",
    "customer_last_name",
    // Second pass: the payload copy and the Shopify-side timestamps.
    "order_data",
    "shopify_created_at",
    "shopify_updated_at",
    "processed_at",
    "last_fetched_at",
    "redacted_at",
  ]) {
    await safeDrop(`orders.${column}`, `ALTER TABLE orders DROP COLUMN ${column}`);
  }

  await safeAlter(
    "orders.idx_orders_placed",
    "ALTER TABLE orders ADD INDEX idx_orders_placed (store_id, created_at)"
  );
}

/**
 * Replace the raw Shopify variant id on a line item with a reference to our
 * mapping_variant_products row.
 *
 * The old column held an id that meant nothing to this database. The new one
 * points at the record that says which source variant it came from.
 */
async function linkLineItemsToMappedVariants() {
  const rows = await query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_line_items'
        AND COLUMN_NAME = 'shopify_variant_id'`
  );

  // Nothing to migrate once the old column is gone.
  if (!rows.length || Number(rows[0].n) === 0) return;

  console.log("Migration: order_line_items.shopify_variant_id -> mapped_variant_id");

  await safeDrop(
    "order_line_items.idx_line_variant",
    "ALTER TABLE order_line_items DROP INDEX idx_line_variant"
  );
  await safeDrop(
    "order_line_items.shopify_variant_id",
    "ALTER TABLE order_line_items DROP COLUMN shopify_variant_id"
  );

  await safeAlter(
    "order_line_items.mapped_variant_id",
    "ALTER TABLE order_line_items ADD COLUMN mapped_variant_id INT DEFAULT NULL"
  );
  await safeAlter(
    "order_line_items.idx_line_variant",
    "ALTER TABLE order_line_items ADD INDEX idx_line_variant (mapped_variant_id)"
  );
  await safeAlter(
    "order_line_items.fk_line_mapped_variant",
    `ALTER TABLE order_line_items
       ADD CONSTRAINT fk_line_mapped_variant
       FOREIGN KEY (mapped_variant_id) REFERENCES mapping_variant_products(id)
       ON DELETE SET NULL`
  );
}

/**
 * Variant fields the settings screen can now switch on and off.
 *
 * These are DATA, not settings: the toggles decide whether they are pushed,
 * but they have to be cached first or there is nothing to push.
 */
async function addVariantDetailColumns() {
  for (const [column, type] of [
    ["barcode", "VARCHAR(255) DEFAULT NULL"],
    ["cost", "DECIMAL(12,2) DEFAULT NULL"],
    ["taxable", "TINYINT(1) DEFAULT NULL"],
    ["inventory_policy", "VARCHAR(16) DEFAULT NULL"],
  ]) {
    await safeAlter(
      `source_variant_mappings.${column}`,
      `ALTER TABLE source_variant_mappings ADD COLUMN ${column} ${type}`
    );
  }
}

/** The variant choice made in the resource picker at "Add products" time. */
async function addSelectedVariants() {
  await safeAlter(
    "source_products.selected_variant_ids",
    "ALTER TABLE source_products ADD COLUMN selected_variant_ids JSON DEFAULT NULL"
  );
}

/** Variant-level selection, added after product_mappings already existed. */
async function addAllowedVariants() {
  await safeAlter(
    "product_mappings.allowed_variant_ids",
    "ALTER TABLE product_mappings ADD COLUMN allowed_variant_ids JSON DEFAULT NULL"
  );
}

/* ------------------------------------------------------------------ */
/* 10. sync_settings                                                    */
/* ------------------------------------------------------------------ */
/*
 * What each connection copies across, one row per connection.
 *
 * Real columns rather than a JSON blob: these are read on every push, and a
 * column is something the database can constrain, default and index. A blob
 * would also make "which connections stopped syncing prices?" unanswerable.
 *
 * Every toggle defaults to 1. A merchant who has chosen nothing wants the
 * product as it is at the source, and a connection that predates this table
 * gets a row of defaults rather than silently syncing nothing.
 *
 * Turning one OFF means the field is simply NOT SENT. productSet leaves an
 * omitted field unchanged, so the destination keeps whatever it already has --
 * it is not blanked.
 */
const CREATE_SYNC_SETTINGS = `
  CREATE TABLE IF NOT EXISTS sync_settings (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    connection_id INT NOT NULL,

    -- Which field decides that two variants are the same one.
    match_by ENUM('sku','barcode','title') NOT NULL DEFAULT 'sku',

    -- Added to every price on the way across. DECIMAL, never FLOAT.
    price_markup_percent DECIMAL(6,2) NOT NULL DEFAULT 0.00,

    /* Product-level fields */
    -- Always sent when CREATING: productSet cannot make a product with no
    -- title. The flag only decides whether later changes to it are copied.
    sync_title        TINYINT(1) NOT NULL DEFAULT 1,
    sync_description  TINYINT(1) NOT NULL DEFAULT 1,
    sync_images       TINYINT(1) NOT NULL DEFAULT 1,
    sync_category     TINYINT(1) NOT NULL DEFAULT 1,
    sync_status       TINYINT(1) NOT NULL DEFAULT 1,
    sync_product_type TINYINT(1) NOT NULL DEFAULT 1,
    sync_vendor       TINYINT(1) NOT NULL DEFAULT 1,
    sync_tags         TINYINT(1) NOT NULL DEFAULT 1,
    sync_metafields   TINYINT(1) NOT NULL DEFAULT 1,

    /* Variant-level fields. sync_variants is the parent: off means the
       destination's own variants are left alone entirely. */
    sync_variants                 TINYINT(1) NOT NULL DEFAULT 1,
    sync_variant_sku              TINYINT(1) NOT NULL DEFAULT 1,
    sync_variant_barcode          TINYINT(1) NOT NULL DEFAULT 1,
    sync_variant_price            TINYINT(1) NOT NULL DEFAULT 1,
    sync_variant_cost             TINYINT(1) NOT NULL DEFAULT 1,
    sync_variant_taxable          TINYINT(1) NOT NULL DEFAULT 1,
    sync_variant_continue_selling TINYINT(1) NOT NULL DEFAULT 1,
    sync_inventory                TINYINT(1) NOT NULL DEFAULT 1,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- One row per connection, so an upsert can never make a second.
    UNIQUE KEY uniq_settings_connection (connection_id),

    CONSTRAINT fk_settings_connection
      FOREIGN KEY (connection_id) REFERENCES store_connections(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* 11. order_mappings                                                  */
/* ------------------------------------------------------------------ */
/*
 * A sale in a destination store, and the order it became in the source store
 * that supplied the goods.
 *
 * Keyed by CONNECTION, not by store: one basket can hold products from two
 * different source stores, and each source must get an order containing only
 * its own lines. That is why a destination order can have several rows here.
 *
 * The money is recorded on both sides because the two totals are genuinely
 * different and both are needed to reason about a sale: destination_total is
 * what the shopper paid, source_total is what the source store is owed. The
 * gap between them is the markup in sync_settings.
 *
 * Same queue shape as product_mappings -- pending/synced/failed, an attempt
 * count and the last error -- because the push has the same problem: a webhook
 * may not call Shopify, so the work has to be picked up later.
 */
const CREATE_ORDER_MAPPINGS = `
  CREATE TABLE IF NOT EXISTS order_mappings (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    connection_id INT NOT NULL,

    -- Our orders row for the DESTINATION sale, not a Shopify id: the order is
    -- already cached, and pointing at the cache keeps the two in step.
    destination_order_id INT NOT NULL,

    -- Filled in once the source store has accepted the order.
    source_shopify_order_id BIGINT UNSIGNED DEFAULT NULL,
    source_order_name       VARCHAR(50) DEFAULT NULL,

    -- What the shopper paid, and what the source is owed at its own prices.
    -- DECIMAL, never FLOAT: these are money.
    destination_total DECIMAL(12,2) DEFAULT NULL,
    source_total      DECIMAL(12,2) DEFAULT NULL,
    currency          VARCHAR(3) DEFAULT NULL,

    -- How many of the order's lines belong to THIS source. A destination order
    -- with lines from two sources has a different count on each row.
    line_count INT NOT NULL DEFAULT 0,

    sync_status ENUM('pending','synced','failed','skipped')
      NOT NULL DEFAULT 'pending',
    error_message VARCHAR(512) DEFAULT NULL,
    attempts      INT NOT NULL DEFAULT 0,
    last_synced_at DATETIME DEFAULT NULL,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- One row per source per destination order. This is what makes the webhook
    -- idempotent: Shopify retries orders/create, and the second delivery must
    -- not place a second order at the source.
    UNIQUE KEY uniq_order_mapping (connection_id, destination_order_id),
    KEY idx_order_mapping_status (sync_status),

    CONSTRAINT fk_order_mapping_connection
      FOREIGN KEY (connection_id) REFERENCES store_connections(id)
        ON DELETE CASCADE,

    -- CASCADE is right here, unlike on a product: this row describes one
    -- specific sale, so without that sale it means nothing.
    CONSTRAINT fk_order_mapping_order
      FOREIGN KEY (destination_order_id) REFERENCES orders(id)
        ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/**
 * Destination-side acceptance.
 *
 * Rows that predate this column were pushed under the old rule, where the
 * source alone decided. Backfilling them as accepted keeps those products
 * syncing instead of silently stalling until someone re-ticks them.
 */
async function addDestinationAcceptance() {
  await safeAlter(
    "product_mappings.accepted_at",
    "ALTER TABLE product_mappings ADD COLUMN accepted_at DATETIME DEFAULT NULL"
  );
  await safeAlter(
    "product_mappings.idx_mapping_accepted",
    "ALTER TABLE product_mappings ADD INDEX idx_mapping_accepted (connection_id, accepted_at)"
  );

  const [result] = await require("./db").pool.query(
    `UPDATE product_mappings
        SET accepted_at = COALESCE(last_synced_at, created_at)
      WHERE accepted_at IS NULL
        AND sync_status IN ('synced', 'failed')`
  );

  if (result.affectedRows) {
    console.log(
      `Migration: marked ${result.affectedRows} already-pushed product(s) as accepted`
    );
  }
}

async function runMigrations() {
  // Parents before children -- a foreign key needs its target to exist.
  await query(CREATE_STORES);
  await narrowStoreType();
  await addStoreGrouping();
  await query(CREATE_STORE_CONNECTIONS);
  await query(CREATE_SOURCE_PRODUCTS);
  await addSelectedVariants();
  await query(CREATE_PRODUCT_MAPPINGS);
  await addAllowedVariants();
  await addDestinationAcceptance();
  await query(CREATE_SOURCE_VARIANT_MAPPINGS);
  await addVariantDetailColumns();
  await query(CREATE_MAPPING_VARIANT_PRODUCTS);
  await query(CREATE_ORDERS);
  await slimOrdersCustomerColumns();
  await query(CREATE_ORDER_LINE_ITEMS);
  await linkLineItemsToMappedVariants();
  await query(CREATE_CUSTOMERS);
  // After store_connections: the foreign key needs its target to exist.
  await query(CREATE_SYNC_SETTINGS);
  await backfillSyncSettings();
  // After BOTH store_connections and orders -- it has a foreign key onto each.
  await query(CREATE_ORDER_MAPPINGS);
}

/**
 * Give every existing connection a row of defaults.
 *
 * Without this, a connection made before this table existed would read as
 * "nothing configured" -- and the safe reading of that is "sync everything",
 * which is exactly what a row of 1s says explicitly.
 */
async function backfillSyncSettings() {
  const [result] = await require("./db").pool.query(
    `INSERT IGNORE INTO sync_settings (connection_id)
     SELECT id FROM store_connections`
  );

  if (result.affectedRows) {
    console.log(
      `Migration: created sync settings for ${result.affectedRows} connection(s)`
    );
  }
}

module.exports = { runMigrations, safeAlter };
