-- Removes the tables from the earlier page-builder and form-builder versions
-- of this app, leaving only `shops`.
--
-- DESTRUCTIVE. This deletes stored pages, forms and form responses
-- permanently. Run it only once you are sure none of that data is needed:
--
--   mysql -u root shopify_app_db < sql/drop-legacy-tables.sql
--
-- It is deliberately NOT run by config/migrate.js -- a migration should never
-- silently drop a table.

USE shopify_app_db;

-- Children first: these carry foreign keys into the tables below them.
DROP TABLE IF EXISTS form_submissions;
DROP TABLE IF EXISTS form_fields;
DROP TABLE IF EXISTS forms;

DROP TABLE IF EXISTS page_settings;
DROP TABLE IF EXISTS pages;

DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS dummy_shop;

SHOW TABLES;
