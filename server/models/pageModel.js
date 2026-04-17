const db = require("../config/db");

// ✅ CREATE PAGE (UPDATED 🔥)
function createPage(title, content, shopifyId, shop, handle, blocks) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO pages 
      (title, content, shopify_id, shop_domain, handle)
      VALUES (?, ?, ?, ?, ?)
    `;

    db.query(
      sql,
      [title, content, shopifyId, shop, handle],
      (err, result) => {
        if (err) {
          console.error("Database Insert Error:", err);
          return reject(err);
        }
          resolve(result.insertId);
      }
    );
  });
}

// ✅ GET ALL PAGES
function getAllPages(shop) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT * 
      FROM pages 
      WHERE shop_domain = ?
      ORDER BY id DESC
    `;

    db.query(sql, [shop], (err, results) => {
      if (err) {
        console.error("Database Fetch Error:", err);
        return reject(err);
      }
      resolve(results);
    });
  });
}

// ✅ GET PAGE BY SHOPIFY ID (IMPORTANT 🔥)
function getPageByShopifyId(shopifyId) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT * 
      FROM pages 
      WHERE shopify_id = ?
    `;

    db.query(sql, [shopifyId], (err, results) => {
      if (err) {
        console.error("Database Fetch Error:", err);
        return reject(err);
      }
      resolve(results[0]);
    });
  });
}

function getPageById(id) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT *
      FROM pages
      WHERE id = ?
    `;

    db.query(sql, [id], (err, results) => {
      if (err) {
        console.error("Database Fetch Error:", err);
        return reject(err);
      }
      resolve(results[0]);
    });
  });
}

function updatePageContent(id, content) {
  return new Promise((resolve, reject) => {
    const sql = `
      UPDATE pages
      SET content = ?
      WHERE id = ?
    `;

    db.query(sql, [content, id], (err, result) => {
      if (err) {
        console.error("Database Update Error:", err);
        return reject(err);
      }
      resolve(result);
    });
  });
}
function deletePage(id) {
  return new Promise((resolve, reject) => {
    const sql = `
      DELETE FROM pages
      WHERE id = ?
    `;

    db.query(sql, [id], (err, result) => {
      if (err) {
        console.error("Database Delete Error:", err);
        return reject(err);
      }
      resolve(result);
    });
  });
}

module.exports = {
  createPage,
  getAllPages,
  getPageByShopifyId,
  getPageById,
  updatePageContent,
  deletePage,
};
