const { getPageById, updatePageContent } = require("../models/pageModel");
const {
  getPageSettings,
  deleteSettingsByPage,
  createMultipleSettings,
  deleteSettingsByGroup,
  deleteSingleSetting
} = require("../models/pagesettingModel");

const {
  convertSettingsToBlocks,
  convertBlocksToSettings,
} = require("../utils/blockUtils");

const { updateShopifyPage } = require("../services/pageService");

function getPublicBaseUrl(req) {
  const envHost = String(process.env.HOST || "").trim().replace(/\/+$/, "");

  if (envHost) {
    return envHost;
  }

  return `${req.protocol}://${req.get("host")}`;
}

/* =========================
   🔥 SHOW EDITOR
========================= */
const showEditPage = async (req, res) => {
  const pageId = req.params.id;

  try {
    const page = await getPageById(pageId);

    if (!page) {
      return res.status(404).send("Page not found");
    }

    const settings = await getPageSettings(page.id);
    const blocks = convertSettingsToBlocks(settings);

    res.render("pageEditor", {
      page,
      blocks,
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading editor");
  }
};

/* =========================
   🔥 UPDATE FULL PAGE
========================= */
const updatePage = async (req, res) => {
  const pageId = req.params.id;
  let blocks = req.body.blocks;

  if (typeof blocks === "string") {
    try {
      blocks = JSON.parse(blocks);
    } catch {
      blocks = [];
    }
  }

  if (!Array.isArray(blocks)) {
    blocks = [];
  }

  try {
    const page = await getPageById(pageId);

    if (!page) {
      return res.status(404).json({ error: "Page not found" });
    }

    const cleanedBlocks = blocks.map((block) => ({
      ...block,
      type: String(block.type || "").trim(),
    }));

    if (req.file) {
      const imageUrl = `${getPublicBaseUrl(req)}/uploads/${req.file.filename}`;
      const uploadMarker = "__UPLOAD_PENDING__";
      let imageAssigned = false;

      for (const block of cleanedBlocks) {
        if (block.type === "hero" && block.image === uploadMarker && !imageAssigned) {
          block.image = imageUrl;
          imageAssigned = true;
        }
      }
    }

    const settings = convertBlocksToSettings(cleanedBlocks);

    const { bodyHtml } = await updateShopifyPage(
      page.shop_domain,
      page.shopify_id,
      page.title,
      cleanedBlocks
    );

    await updatePageContent(page.id, bodyHtml);

    await deleteSettingsByPage(page.id);

    if (settings.length > 0) {
      await createMultipleSettings(page.id, settings);
    }

    res.json({ success: true, message: "Page updated successfully" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to update page" });
  }
};

/* =========================
   🔥 ADD BLOCK (REDIRECT BASED)
========================= */
const addBlock = async (req, res) => {
  const pageId = req.params.id;

  try {
    const block = JSON.parse(req.query.block || "{}");

    let settings = [];

    if (block.type === "hero") {
      settings.push(
        { group: "hero", key: "title", value: block.title || "" },
        { group: "hero", key: "subtitle", value: block.subtitle || "" },
        { group: "hero", key: "image", value: block.image || "" }
      );
    }

    if (block.type === "card") {
      settings.push({
        group: "card",
        key: "card",
        value: JSON.stringify(block)
      });
    }

    if (block.type === "footer") {
      settings.push({
        group: "footer",
        key: "text",
        value: block.text || ""
      });
    }

    if (settings.length > 0) {
      await createMultipleSettings(pageId, settings);
    }

    res.redirect(`/pages/editor/${pageId}`);

  } catch (err) {
    console.error("ADD BLOCK ERROR:", err);
    res.status(500).send("Error adding block");
  }
};

/* =========================
   🔥 DELETE BLOCK
========================= */
const deleteBlock = async (req, res) => {
  const pageId = req.params.id;
  const { group, value } = req.query;

  try {

    if (group === "card") {
      await deleteSingleSetting(pageId, "card", value);
    } else {
      await deleteSettingsByGroup(pageId, group);
    }

    res.redirect(`/pages/editor/${pageId}`);

  } catch (err) {
    console.error("DELETE BLOCK ERROR:", err);
    res.status(500).send("Error deleting block");
  }
};

/* =========================
   🔥 SINGLE BLOCK EDIT
========================= */
const showSingleBlockEdit = async (req, res) => {
  const pageId = req.params.id;
  const index = Number.parseInt(req.params.index, 10);

  try {
    const page = await getPageById(pageId);

    if (!page) {
      return res.status(404).send("Page not found");
    }

    const settings = await getPageSettings(page.id);
    const blocks = convertSettingsToBlocks(settings);
    const block = blocks[index];

    if (!block) {
      return res.status(404).send("Block not found");
    }

    res.render("blockEdit", {
      page,
      pageId,
      block,
      index,
      blocks,
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading block editor");
  }
};

module.exports = {
  showEditPage,
  updatePage,
  showSingleBlockEdit,
  addBlock,        // ✅ NEW
  deleteBlock      // ✅ NEW
};
