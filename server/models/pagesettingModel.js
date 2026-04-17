const db = require("../config/db");

/* =========================
   🔥 INSERT SINGLE SETTING
========================= */
function createSetting(pageId, group, key, value) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO page_settings (page_id, group_key, setting_key, value)
      VALUES (?, ?, ?, ?)
    `;

    db.query(sql, [pageId, group, key, value], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/* =========================
   🔥 INSERT MULTIPLE SETTINGS
========================= */
function createMultipleSettings(pageId, settings) {
  return new Promise((resolve, reject) => {
    if (!settings.length) return resolve();

    const values = settings.map(s => [
      pageId,
      s.group,
      s.key,
      s.value,
    ]);

    const sql = `
      INSERT INTO page_settings (page_id, group_key, setting_key, value)
      VALUES ?
    `;

    db.query(sql, [values], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/* =========================
   🔥 GET SETTINGS BY PAGE
========================= */
function getPageSettings(pageId) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT * FROM page_settings 
      WHERE page_id = ?
      ORDER BY id ASC
    `;

    db.query(sql, [pageId], (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

/* =========================
   🔥 DELETE ALL SETTINGS (FULL PAGE)
========================= */
function deleteSettingsByPage(pageId) {
  return new Promise((resolve, reject) => {
    db.query(
      "DELETE FROM page_settings WHERE page_id=?",
      [pageId],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

/* =========================
   🔥 DELETE BY GROUP (HERO / FOOTER)
========================= */
function deleteSettingsByGroup(pageId, group) {
  return new Promise((resolve, reject) => {
    const sql = `
      DELETE FROM page_settings
      WHERE page_id = ? AND group_key = ?
    `;

    db.query(sql, [pageId, group], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/* =========================
   🔥 DELETE SINGLE BLOCK (CARD)
========================= */
function deleteSingleSetting(pageId, group, value) {
  return new Promise((resolve, reject) => {
    const sql = `
      DELETE FROM page_settings
      WHERE page_id = ? 
      AND group_key = ?
      AND value = ?
      LIMIT 1
    `;

    db.query(sql, [pageId, group, value], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

module.exports = {
  createSetting,
  createMultipleSettings,
  getPageSettings,
  deleteSettingsByPage,

  // 🔥 NEW FUNCTIONS
  deleteSettingsByGroup,
  deleteSingleSetting
};