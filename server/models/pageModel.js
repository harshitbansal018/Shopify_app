const db = require("../config/db");

// ✅ CREATE PAGE (UPDATED 🔥)
function createPage(title, content, shopifyId, shop, handle, blocks) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO pages 
      (title, content, shopify_id, shop_domain, handle,status)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    db.query(
      sql,
      [title, content, shopifyId, shop, handle, "active"],
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
function togglePageStatus(id) {
  return new Promise((resolve, reject) => {
    const sql = `
      UPDATE pages
      SET status = CASE 
        WHEN status = 'active' THEN 'inactive'
        ELSE 'active'
      END
      WHERE id = ?
    `;

    db.query(sql, [id], (err, result) => {
      if (err) {
        console.error("Status Toggle Error:", err);
        return reject(err);
      }

      // Get updated status
      db.query(
        "SELECT status FROM pages WHERE id = ?",
        [id],
        (err2, res2) => {
          if (err2) return reject(err2);
          resolve(res2[0]);
        }
      );
    });
  });
}

// ✅ Get dashboard stats
function getPageStats(shopDomain) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT 
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) AS inactive
      FROM pages
      WHERE shop_domain = ?
    `;

    db.query(sql, [shopDomain], (err, result) => {
      if (err) return reject(err);
      resolve(result[0]);
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
  togglePageStatus,
  getPageStats
};
