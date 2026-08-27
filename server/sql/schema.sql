-- Schema for Product Sync.
--
-- Generated from the live database. config/migrate.js applies the same shape
-- on every boot, so this file is a reference and a fast path for a fresh
-- install rather than the source of truth.
--
--   mysql -u root -p < sql/schema.sql
--
-- Tables are listed in dependency order: a foreign key needs its target table
-- to exist already, so `stores` comes first.
--
-- Rules the DDL encodes, which the app relies on:
--   * a store is EITHER a source or a destination (store_type), never both.
--   * stores sharing store_group_id are controlled by the same operator and
--     are the only ones allowed to connect. pairing_code is how a store joins.
--   * store_connections references stores twice; chk_conn_distinct forbids a
--     store being connected to itself.
--   * the two variant tables describe opposite ends of a sync:
--       source_variant_mappings   what exists at the SOURCE
--       mapping_variant_products  what has been synced to a DESTINATION
--   * order_line_items.mapped_variant_id points at mapping_variant_products,
--     so a sale can be traced back to the SOURCE variant it came from. It is
--     ON DELETE SET NULL: removing a mapping must never delete a sale.
--     shopify_product_id stays a plain column for the same reason.
--   * customer identity is NOT copied onto orders. Name, email and phone live
--     in `customers`; orders reference them by customer_shopify_id.
--   * orders keeps no raw Shopify payload and no Shopify-side timestamps.
--     created_at is when THIS APP first saw the order, not when it was placed.
--   * customers/redact clears the customer link and both addresses on orders,
--     and deletes customer rows outright. NOTE: with no redaction marker on
--     orders, a later re-fetch will write the person back.
--   * every child cascades on delete.
--
-- Not present yet: sync_jobs, sync_logs and webhook_events. Background sync and
-- webhook-driven auto-sync need them; add them back before building those.

CREATE DATABASE IF NOT EXISTS shopify_app_db
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE shopify_app_db;

CREATE TABLE IF NOT EXISTS `stores` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `shop_domain` varchar(255) NOT NULL,
  `store_name` varchar(255) DEFAULT NULL,
  `access_token` text DEFAULT NULL,
  `access_token_expires_at` datetime DEFAULT NULL,
  `refresh_token` text DEFAULT NULL,
  `refresh_token_expires_at` datetime DEFAULT NULL,
  `api_version` varchar(16) NOT NULL DEFAULT '2025-01',
  `store_type` enum('source','destination') DEFAULT NULL,
  `currency` varchar(8) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `installed_at` datetime DEFAULT NULL,
  `uninstalled_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `store_group_id` char(36) DEFAULT NULL,
  `pairing_code_expires_at` datetime DEFAULT NULL,
  `pairing_code` varchar(16) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_shop_domain` (`shop_domain`),
  UNIQUE KEY `uniq_pairing_code` (`pairing_code`),
  KEY `idx_stores_type_active` (`store_type`,`is_active`),
  KEY `idx_stores_group` (`store_group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `store_connections` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `source_store_id` int(11) NOT NULL,
  `destination_store_id` int(11) NOT NULL,
  `status` enum('active','paused','disconnected') NOT NULL DEFAULT 'active',
  `sync_mode` enum('manual','auto') NOT NULL DEFAULT 'manual',
  `settings` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`settings`)),
  `last_synced_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_connection_pair` (`source_store_id`,`destination_store_id`),
  KEY `idx_conn_source` (`source_store_id`,`status`,`sync_mode`),
  KEY `idx_conn_destination` (`destination_store_id`),
  CONSTRAINT `fk_conn_destination` FOREIGN KEY (`destination_store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_conn_source` FOREIGN KEY (`source_store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_conn_distinct` CHECK (`source_store_id` <> `destination_store_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `source_products` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `store_id` int(11) NOT NULL,
  `shopify_product_id` bigint(20) unsigned NOT NULL,
  `title` varchar(512) DEFAULT NULL,
  `handle` varchar(255) DEFAULT NULL,
  `vendor` varchar(255) DEFAULT NULL,
  `product_type` varchar(255) DEFAULT NULL,
  `status` varchar(32) DEFAULT NULL,
  `product_data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`product_data`)),
  `shopify_updated_at` datetime DEFAULT NULL,
  `last_fetched_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_store_product` (`store_id`,`shopify_product_id`),
  KEY `idx_source_products_updated` (`store_id`,`shopify_updated_at`),
  CONSTRAINT `fk_source_product_store` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `product_mappings` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `connection_id` int(11) NOT NULL,
  `source_product_id` int(11) NOT NULL,
  `source_shopify_product_id` bigint(20) unsigned NOT NULL,
  `destination_shopify_product_id` bigint(20) unsigned DEFAULT NULL,
  `sync_status` enum('pending','synced','failed','skipped','deleted') NOT NULL DEFAULT 'pending',
  `source_updated_at` datetime DEFAULT NULL,
  `last_synced_at` datetime DEFAULT NULL,
  `error_message` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_mapping` (`connection_id`,`source_shopify_product_id`),
  KEY `idx_mapping_source_product` (`source_product_id`),
  KEY `idx_mapping_status` (`connection_id`,`sync_status`),
  KEY `idx_mapping_destination` (`destination_shopify_product_id`),
  CONSTRAINT `fk_mapping_connection` FOREIGN KEY (`connection_id`) REFERENCES `store_connections` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mapping_source_product` FOREIGN KEY (`source_product_id`) REFERENCES `source_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `source_variant_mappings` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `source_product_id` int(11) NOT NULL,
  `shopify_variant_id` bigint(20) unsigned NOT NULL,
  `shopify_inventory_item_id` bigint(20) unsigned DEFAULT NULL,
  `sku` varchar(255) DEFAULT NULL,
  `title` varchar(255) DEFAULT NULL,
  `price` decimal(12,2) DEFAULT NULL,
  `compare_at_price` decimal(12,2) DEFAULT NULL,
  `option1` varchar(255) DEFAULT NULL,
  `option2` varchar(255) DEFAULT NULL,
  `option3` varchar(255) DEFAULT NULL,
  `inventory_quantity` int(11) DEFAULT NULL,
  `position` int(11) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_source_variant` (`source_product_id`,`shopify_variant_id`),
  KEY `idx_source_variant_sku` (`sku`),
  CONSTRAINT `fk_source_variant_product` FOREIGN KEY (`source_product_id`) REFERENCES `source_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `mapping_variant_products` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `product_mapping_id` int(11) NOT NULL,
  `source_variant_mapping_id` int(11) NOT NULL,
  `source_shopify_variant_id` bigint(20) unsigned NOT NULL,
  `destination_variant_id` bigint(20) unsigned DEFAULT NULL,
  `destination_inventory_item_id` bigint(20) unsigned DEFAULT NULL,
  `sku` varchar(255) DEFAULT NULL,
  `last_synced_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_mapping_variant` (`product_mapping_id`,`source_shopify_variant_id`),
  KEY `idx_mvp_source_variant` (`source_variant_mapping_id`),
  KEY `idx_mvp_destination` (`destination_variant_id`),
  KEY `idx_mvp_inventory_item` (`destination_inventory_item_id`),
  CONSTRAINT `fk_mvp_product_mapping` FOREIGN KEY (`product_mapping_id`) REFERENCES `product_mappings` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mvp_source_variant` FOREIGN KEY (`source_variant_mapping_id`) REFERENCES `source_variant_mappings` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `orders` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `store_id` int(11) NOT NULL,
  `shopify_order_id` bigint(20) unsigned NOT NULL,
  `order_number` int(11) DEFAULT NULL,
  `name` varchar(50) DEFAULT NULL,
  `currency` varchar(3) DEFAULT NULL,
  `subtotal_price` decimal(12,2) DEFAULT NULL,
  `total_tax` decimal(12,2) DEFAULT NULL,
  `total_discounts` decimal(12,2) DEFAULT NULL,
  `total_shipping` decimal(12,2) DEFAULT NULL,
  `total_price` decimal(12,2) DEFAULT NULL,
  `financial_status` varchar(32) DEFAULT NULL,
  `fulfillment_status` varchar(32) DEFAULT NULL,
  `cancelled_at` datetime DEFAULT NULL,
  `cancel_reason` varchar(64) DEFAULT NULL,
  `closed_at` datetime DEFAULT NULL,
  `test` tinyint(1) NOT NULL DEFAULT 0,
  `customer_shopify_id` bigint(20) unsigned DEFAULT NULL,
  `billing_address` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`billing_address`)),
  `shipping_address` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`shipping_address`)),
  `shipping_country_code` varchar(2) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_store_order` (`store_id`,`shopify_order_id`),
  KEY `idx_orders_financial` (`store_id`,`financial_status`),
  KEY `idx_orders_fulfillment` (`store_id`,`fulfillment_status`),
  KEY `idx_orders_customer` (`customer_shopify_id`),
  KEY `idx_orders_placed` (`store_id`,`created_at`),
  CONSTRAINT `fk_order_store` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `order_line_items` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `order_id` int(11) NOT NULL,
  `shopify_line_item_id` bigint(20) unsigned NOT NULL,
  `shopify_product_id` bigint(20) unsigned DEFAULT NULL,
  `sku` varchar(255) DEFAULT NULL,
  `title` varchar(512) DEFAULT NULL,
  `variant_title` varchar(255) DEFAULT NULL,
  `vendor` varchar(255) DEFAULT NULL,
  `quantity` int(11) NOT NULL DEFAULT 0,
  `price` decimal(12,2) DEFAULT NULL,
  `total_discount` decimal(12,2) DEFAULT NULL,
  `fulfillment_status` varchar(32) DEFAULT NULL,
  `requires_shipping` tinyint(1) NOT NULL DEFAULT 1,
  `line_data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`line_data`)),
  `mapped_variant_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_order_line` (`order_id`,`shopify_line_item_id`),
  KEY `idx_line_product` (`shopify_product_id`),
  KEY `idx_line_sku` (`sku`),
  KEY `idx_line_variant` (`mapped_variant_id`),
  CONSTRAINT `fk_line_mapped_variant` FOREIGN KEY (`mapped_variant_id`) REFERENCES `mapping_variant_products` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_line_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `customers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `store_id` int(11) NOT NULL,
  `shopify_customer_id` bigint(20) unsigned NOT NULL,
  `first_name` varchar(255) DEFAULT NULL,
  `last_name` varchar(255) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `phone` varchar(64) DEFAULT NULL,
  `addresses` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`addresses`)),
  `shopify_created_at` datetime DEFAULT NULL,
  `shopify_updated_at` datetime DEFAULT NULL,
  `last_fetched_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_store_customer` (`store_id`,`shopify_customer_id`),
  KEY `idx_customers_email` (`store_id`,`email`),
  KEY `idx_customers_shopify_id` (`shopify_customer_id`),
  CONSTRAINT `fk_customer_store` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
