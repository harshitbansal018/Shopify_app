const fs = require("fs");
const path = require("path");
const shopifyRequest = require("../services/shopify");
const { getShop } = require("../models/shopModel");
const { createPage } = require("../models/pageModel");
const { createMultipleSettings } = require("../models/pagesettingModel");
const { convertBlocksToSettings } = require("../utils/blockUtils");

const API_VERSION = "2025-01";

const commonPageCss = fs.readFileSync(
  path.join(__dirname, "..", "public", "css", "generated-page.css"),
  "utf8",
);

/* 🔥 GENERATE HTML */
function generateHTML(blocks) {
  if (!Array.isArray(blocks)) return "";

  let heroHtml = "";
  let cardsHtml = "";
  let gridsHtml = "";
  let richTextHtml = "";
  let footerHtml = "";

  blocks.forEach((block) => {
    /* ✅ FIX: ONLY FIRST HERO USED */
    if (block.type === "hero" && !heroHtml) {
      heroHtml = `
  <section class="custom-page-builder__hero">

    ${
      block.image
        ? `<img class="custom-page-builder__hero-image" src="${block.image}" />`
        : ""
    }

    <div class="custom-page-builder__hero-content">
      <h1 class="custom-page-builder__hero-title">${block.title || ""}</h1>
      <p class="custom-page-builder__hero-subtitle">${block.subtitle || ""}</p>
    </div>

  </section>
`;
    }

    if (block.type === "card") {
      cardsHtml += `
        <article class="custom-page-builder__card">
          <h3 class="custom-page-builder__card-title">${block.title || ""}</h3>
          <p class="custom-page-builder__card-desc">${block.desc || ""}</p>
        </article>
      `;
    }

    if (block.type === "grid") {
      const columns = Math.min(Math.max(Number(block.columns) || 3, 1), 6);
      const items = Array.isArray(block.items) ? block.items : [];
      const itemsHtml = items
        .map((item) => `
          <article class="custom-page-builder__grid-item">
            ${
              item.image
                ? `<img class="custom-page-builder__grid-image" src="${item.image}" />`
                : ""
            }
            <div class="custom-page-builder__grid-content">
              <h3 class="custom-page-builder__grid-title">${item.title || ""}</h3>
              <p class="custom-page-builder__grid-desc">${item.desc || ""}</p>
            </div>
          </article>
        `)
        .join("");

      gridsHtml += `
        <section class="custom-page-builder__grid-section">
          <div class="custom-page-builder__grid-header">
            <h2 class="custom-page-builder__grid-heading">${block.heading || ""}</h2>
            <p class="custom-page-builder__grid-subheading">${block.subheading || ""}</p>
          </div>
          <div class="custom-page-builder__grid" style="--grid-columns: ${columns}; grid-template-columns: repeat(${columns}, minmax(0, 1fr));">
            ${itemsHtml}
          </div>
        </section>
      `;
    }

    if (block.type === "richtext") {
      richTextHtml += `
        <section class="custom-page-builder__richtext">
          ${
            block.heading
              ? `<h2 class="custom-page-builder__richtext-heading">${block.heading}</h2>`
              : ""
          }
          <div class="custom-page-builder__richtext-content">
            ${block.content || ""}
          </div>
        </section>
      `;
    }

    if (block.type === "footer" && !footerHtml) {
      footerHtml = `
        <footer class="custom-page-builder__footer">
          ${block.text || ""}
        </footer>
      `;
    }
  });

  const cardsSection = cardsHtml
    ? `<section class="custom-page-builder__cards">${cardsHtml}</section>`
    : "";

  return `
    <style>${commonPageCss}</style>
    <div class="custom-page-builder">
      ${heroHtml}
      ${cardsSection}
      ${gridsHtml}
      ${richTextHtml}
      ${footerHtml}
    </div>
  `;
}

/* 🔥 CREATE PAGE */
async function createShopifyPage(shop, title, blocks) {
  try {
    const shopData = await getShop(shop);
    if (!shopData) throw new Error("Shop not found");

    const accessToken = shopData.access_token;

    let parsedBlocks = [];

    try {
      parsedBlocks = JSON.parse(blocks || "[]");
    } catch {
      parsedBlocks = [];
    }

    /* ✅ REMOVE DUPLICATE HERO BLOCKS */
    parsedBlocks = parsedBlocks.filter(
      (block, index, self) =>
        block.type !== "hero" ||
        index === self.findIndex((b) => b.type === "hero"),
    );

    const bodyHtml = generateHTML(parsedBlocks);

    const query = {
      query: `
        mutation pageCreate($input: PageCreateInput!) {
          pageCreate(page: $input) {
            page {
              id
              title
              handle
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      variables: {
        input: {
          title,
          body: bodyHtml,
          isPublished: true,
          templateSuffix: "custom",
        },
      },
    };

    const data = await shopifyRequest(shop, accessToken, API_VERSION, query);

    const result = data.pageCreate;

    if (!result || result.userErrors?.length) {
      throw new Error(result.userErrors?.[0]?.message || "Shopify error");
    }

    const page = result.page;

    const pageId = await createPage(
      page.title,
      bodyHtml,
      page.id,
      shop,
      page.handle,
    );

    const settings = convertBlocksToSettings(parsedBlocks);

    if (settings.length > 0) {
      await createMultipleSettings(pageId, settings);
    }

    return page;
  } catch (error) {
    console.error("createShopifyPage Error:", error.message);
    throw error;
  }
}

/* 🔥 UPDATE PAGE */
async function updateShopifyPage(shop, shopifyPageId, title, blocks) {
  const shopData = await getShop(shop);

  if (!shopData) {
    throw new Error("Shop not found");
  }

  const accessToken = shopData.access_token;

  /* ✅ ALSO CLEAN DUPLICATE HERO HERE */
  blocks = blocks.filter(
    (block, index, self) =>
      block.type !== "hero" ||
      index === self.findIndex((b) => b.type === "hero"),
  );

  const bodyHtml = generateHTML(blocks);

  const query = {
    query: `
      mutation pageUpdate($id: ID!, $page: PageUpdateInput!) {
        pageUpdate(id: $id, page: $page) {
          page {
            id
            title
            handle
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    variables: {
      id: shopifyPageId,
      page: {
        title,
        body: bodyHtml,
        templateSuffix: "custom",
      },
    },
  };

  const data = await shopifyRequest(shop, accessToken, API_VERSION, query);

  const result = data.pageUpdate;

  if (!result || result.userErrors?.length) {
    throw new Error(
      result?.userErrors?.[0]?.message || "Shopify update failed",
    );
  }

  return {
    page: result.page,
    bodyHtml,
  };
}

module.exports = {
  createShopifyPage,
  generateHTML,
  updateShopifyPage,
};
