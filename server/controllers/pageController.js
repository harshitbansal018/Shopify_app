const { createShopifyPage } = require("../services/pageService");
const { 
  getAllPages, 
  getPageById, 
  deletePage 
} = require("../models/pageModel");
const {getShop}= require("../models/shopModel");
const { getPageSettings } = require("../models/pagesettingModel");
const shopifyRequest = require("../services/shopify");
const { saveShop } = require("../models/shopModel");

/* 🔥 BASE URL */
function getPublicBaseUrl(req) {
  const envHost = String(process.env.HOST || "").trim().replace(/\/+$/, "");
  if (envHost) return envHost;
  return `${req.protocol}://${req.get("host")}`;
}

/* ===================================================== */
/* 👉 SHOW PAGE */
/* ===================================================== */
const showCreatePage = async (req, res) => {
  const shop = req.query.shop;

  if (!shop) return res.send("Shop is required");

  try {
    const pages = await getAllPages(shop);

    res.render("Page", {
      shop,
      pages,
      message: null,
    });

  } catch (err) {
    console.error(err);

    res.render("Page", {
      shop,
      pages: [],
      message: "Error loading pages",
    });
  }
};

/* ===================================================== */
/* 👉 CREATE PAGE */
/* ===================================================== */
const handleCreatePage = async (req, res) => {
  const shop = req.query.shop;
  const { title, blocks } = req.body;

  if (!shop) return res.send("Shop is required");

  try {
    let parsedBlocks = [];

    try {
      parsedBlocks = JSON.parse(blocks || "[]");
    } catch {
      parsedBlocks = [];
    }

    /* 🔥 IMAGE HANDLING */
    if (req.file) {
      const imageUrl = `${getPublicBaseUrl(req)}/uploads/${req.file.filename}`;

      let heroAssigned = false;

      parsedBlocks = parsedBlocks.map(block => {
        if (block.type === "hero" && !heroAssigned) {
          heroAssigned = true;
          return { ...block, image: imageUrl };
        }
        return block;
      });
    }

    /* 🔥 REMOVE DUPLICATE HERO */
    parsedBlocks = parsedBlocks.filter(
      (block, index, self) =>
        block.type !== "hero" ||
        index === self.findIndex(b => b.type === "hero")
    );

    /* 🔥 CREATE SHOPIFY PAGE */
    await createShopifyPage(shop, title, JSON.stringify(parsedBlocks));

    return res.redirect(`/pages/create?shop=${shop}`);

  } catch (err) {
    console.error(err);

    const pages = await getAllPages(shop).catch(() => []);

    res.render("Page", {
      shop,
      pages,
      message: "❌ Error: " + err.message,
    });
  }
};

/* ===================================================== */
/* 👉 CONVERT SETTINGS */
/* ===================================================== */
function convertSettingsToBlocks(settings) {
  const blocks = [];
  const grouped = {};

  settings.forEach(s => {
    if (!grouped[s.group_key]) grouped[s.group_key] = [];
    grouped[s.group_key].push(s);
  });

  for (const group in grouped) {
    const items = grouped[group];

    if (group === "hero") {
      const hero = { type: "hero" };
      items.forEach(i => hero[i.setting_key] = i.value);
      blocks.push(hero);
    }

    if (group === "footer") {
      const footer = { type: "footer" };
      items.forEach(i => footer[i.setting_key] = i.value);
      blocks.push(footer);
    }

    if (group === "card") {
      items.forEach(i => {
        try {
          const card = JSON.parse(i.value);
          blocks.push({ ...card, type: "card" });
        } catch {
          blocks.push({ type: "card", value: i.value });
        }
      });
    }
  }

  return blocks;
}

/* ===================================================== */
/* 👉 GET SINGLE PAGE */
/* ===================================================== */
const getSinglePage = async (req, res) => {
  const pageId = req.params.id;

  try {
    const page = await getPageById(pageId);
    if (!page) return res.status(404).json({ error: "Page not found" });

    const settings = await getPageSettings(page.id);
    const blocks = convertSettingsToBlocks(settings);

    res.json({
      title: page.title,
      body: page.content,
      handle: page.handle,
      blocks,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

/* ===================================================== */
/* 👉 DELETE PAGE (FINAL 🔥) */
/* ===================================================== */
const handleDeletePage = async (req, res) => {
  const pageId = req.params.id;

  try {
    const page = await getPageById(pageId);

    if (!page) {
      return res.status(404).json({ error: "Page not found" });
    }

    console.log("🧾 Deleting page from DB:", page);

    /* ===================================================== */
    /* 🔥 SHOPIFY DELETE (WITH FULL DEBUG) */
    /* ===================================================== */
    if (page.shopify_id) {
  try {
    /* 🔥 GET SHOP DATA FROM DB */
    const shopData = await getShop(page.shop_domain);

    if (!shopData || !shopData.access_token) {
      console.warn("❌ No access token found for shop:", page.shop_domain);
    } else {
      const mutation = `
        mutation deletePage($id: ID!) {
          pageDelete(id: $id) {
            deletedPageId
            userErrors {
              field
              message
            }
          }
        }
      `;

      const variables = {
        id: page.shopify_id
      };

      console.log("🔍 USING TOKEN FROM DB ✅");

      const data = await shopifyRequest(
        page.shop_domain,
        shopData.access_token, // ✅ FIXED
        "2025-01",
        { query: mutation, variables }
      );

      console.log("✅ Shopify delete response:", data);

      if (data?.pageDelete?.userErrors?.length) {
        console.warn("⚠️ Shopify userErrors:", data.pageDelete.userErrors);
      }
    }

  } catch (err) {
    console.error("❌ Shopify delete failed:", err.message);
  }
}
    /* ===================================================== */
    /* 🔥 DB DELETE */
    /* ===================================================== */
    await deletePage(pageId);

    console.log("✅ Page deleted from DB");

    res.json({ success: true });

  } catch (err) {
    console.error("❌ DELETE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};
/* ===================================================== */
module.exports = {
  showCreatePage,
  handleCreatePage,
  getSinglePage,
  handleDeletePage,
};