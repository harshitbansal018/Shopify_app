function normalizeNavbarLink(link) {
  const value = String(link || "").trim();

  if (!value) {
    return "";
  }

  if (value.startsWith("/")) {
    return value.replace(/^\/+/, "").replace(/-/g, " ");
  }

  return value;
}

function convertSettingsToBlocks(settings) {
  const blocks = [];
  const grouped = {};

  (settings || []).forEach((setting) => {
    if (!grouped[setting.group_key]) {
      grouped[setting.group_key] = [];
    }
    grouped[setting.group_key].push(setting);
  });


  if (grouped.hero) {
    const hero = { type: "hero" };

    grouped.hero.forEach((item) => {
      hero[item.setting_key] = item.value;
    });

    blocks.push(hero);
  }

  if (grouped.card) {
    grouped.card.forEach((item) => {
      try {
        const card = JSON.parse(item.value);
        blocks.push({
          type: "card",
          title: card.title || "",
          desc: card.desc || "",
        });
      } catch {
        blocks.push({
          type: "card",
          title: item.setting_key || "",
          desc: item.value || "",
        });
      }
    });
  }

  if (grouped.grid) {
    grouped.grid.forEach((item) => {
      try {
        const grid = JSON.parse(item.value);
        blocks.push({
          type: "grid",
          gridId: grid.gridId || `grid-${item.id}`,
          heading: grid.heading || "",
          subheading: grid.subheading || "",
          columns: grid.columns || 3,
          items: Array.isArray(grid.items) ? grid.items : [],
        });
      } catch {
        blocks.push({
          type: "grid",
          heading: item.setting_key || "",
          subheading: "",
          columns: 3,
          items: [],
        });
      }
    });
  }

  if (grouped.richtext) {
    grouped.richtext.forEach((item) => {
      try {
        const richtext = JSON.parse(item.value);
        blocks.push({
          type: "richtext",
          heading: richtext.heading || "",
          content: richtext.content || "",
        });
      } catch {
        blocks.push({
          type: "richtext",
          heading: item.setting_key || "",
          content: item.value || "",
        });
      }
    });
  }

  if (grouped.footer) {
    const footer = { type: "footer" };

    grouped.footer.forEach((item) => {
      footer[item.setting_key] = item.value;
    });

    blocks.push(footer);
  }

  return blocks;
}

function convertBlocksToSettings(blocks) {
  const settings = [];

  (blocks || []).forEach((block) => {

    if (block.type === "hero") {
      ["title", "subtitle", "image"].forEach((key) => {
        if (block[key]) {
          settings.push({
            group: "hero",
            key,
            value: block[key],
          });
        }
      });
    }

    if (block.type === "card") {
      settings.push({
        group: "card",
        key: block.title || "card",
        value: JSON.stringify({
          type: "card",
          title: block.title || "",
          desc: block.desc || "",
        }),
      });
    }

    if (block.type === "grid") {
      settings.push({
        group: "grid",
        key: block.heading || "grid",
        value: JSON.stringify({
          type: "grid",
          gridId: block.gridId || `grid-${Date.now()}`,
          heading: block.heading || "",
          subheading: block.subheading || "",
          columns: block.columns || 3,
          items: Array.isArray(block.items) ? block.items : [],
        }),
      });
    }

    if (block.type === "richtext") {
      settings.push({
        group: "richtext",
        key: block.heading || "richtext",
        value: JSON.stringify({
          type: "richtext",
          heading: block.heading || "",
          content: block.content || "",
        }),
      });
    }

    if (block.type === "footer" && block.text) {
      settings.push({
        group: "footer",
        key: "text",
        value: block.text,
      });
    }
  });

  return settings;
}

module.exports = {
  convertSettingsToBlocks,
  convertBlocksToSettings,
};
