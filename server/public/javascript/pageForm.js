/* MODAL */
function toggleForm() {
  const modal = document.getElementById("formContainer");

  if (!modal) {
    return;
  }

  modal.style.display = modal.style.display === "flex" ? "none" : "flex";
}

/* BLOCK STORAGE */
let blocks = window.initialBlocks || [];
let richTextEditor = null;
let editingIndex;

function ensureHeroIds() {
  blocks = blocks.map((block) => {
    if (block.type !== "hero") {
      return block;
    }

    const images = Array.isArray(block.images)
      ? block.images.filter(Boolean)
      : block.image
        ? [block.image]
        : [];

    return {
      ...block,
      heroId: block.heroId || `hero${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
      images,
    };
  });
}

function ensureGridIds() {
  blocks = blocks.map((block) => {
    if (block.type !== "grid") {
      return block;
    }

    return {
      ...block,
      gridId: block.gridId || `grid${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
      items: Array.isArray(block.items) ? block.items : [],
    };
  });
}

function destroyRichTextEditor() {
  if (!richTextEditor) {
    return;
  }

  richTextEditor.destroy().catch((error) => console.error(error));
  richTextEditor = null;
}

function initRichTextEditor(selector, initialValue = "") {
  if (!window.ClassicEditor) {
    return;
  }

  const element = document.querySelector(selector);

  if (!element) {
    return;
  }

  ClassicEditor.create(element)
    .then((editor) => {
      richTextEditor = editor;

      if (initialValue) {
        editor.setData(initialValue);
      }
    })
    .catch((error) => console.error(error));
}

function getEditingBlock() {
  return editingIndex !== undefined ? blocks[editingIndex] : null;
}

function resetEditorState() {
  editingIndex = undefined;
}

function showBlockInputs() {
  destroyRichTextEditor();

  const blockType = document.getElementById("blockType");
  const blockInputs = document.getElementById("blockInputs");

  if (!blockType || !blockInputs) {
    return;
  }

  const type = blockType.value;
  const block = getEditingBlock();
  const isEditingSameType = block && block.type === type;

  if (!type) {
    blockInputs.innerHTML = "";
    return;
  }

  if (type === "hero") {
    const existingImages = isEditingSameType && Array.isArray(block.images)
      ? block.images.filter(Boolean)
      : [];

    blockInputs.innerHTML = `
      <input id="heroTitle" placeholder="Hero Title" value="${isEditingSameType ? escapeHtml(block.title || "") : ""}">
      <input id="heroSubtitle" placeholder="Hero Subtitle" value="${isEditingSameType ? escapeHtml(block.subtitle || "") : ""}">
      <input type="file" id="heroImages" multiple accept="image/*">
      <div id="heroExistingImages" class="existing-images-note">
        ${existingImages.length ? `<small>${existingImages.length} existing image${existingImages.length === 1 ? "" : "s"} will be kept unless you choose new files.</small>` : ""}
      </div>
      <div id="heroMultiPreview" style="display:flex;flex-wrap:wrap;"></div>
      <button class="add-block-btn" type="button" onclick="saveHero()">${isEditingSameType ? "Update Block" : "Save"}</button>
    `;

    renderHeroImagePreview(existingImages);
    return;
  }

  if (type === "card") {
    blockInputs.innerHTML = `
      <input id="cardTitle" placeholder="Card Title" value="${isEditingSameType ? escapeHtml(block.title || "") : ""}">
      <input id="cardDesc" placeholder="Description" value="${isEditingSameType ? escapeHtml(block.desc || "") : ""}">
      <button class="add-block-btn" type="button" onclick="saveCard()">${isEditingSameType ? "Update Block" : "Save"}</button>
    `;
    return;
  }

  if (type === "grid") {
    const itemCount = isEditingSameType && Array.isArray(block.items) && block.items.length
      ? block.items.length
      : 3;

    blockInputs.innerHTML = `
      <input id="gridHeading" placeholder="Grid Heading" value="${isEditingSameType ? escapeHtml(block.heading || "") : ""}">
      <input id="gridSubheading" placeholder="Grid Subheading" value="${isEditingSameType ? escapeHtml(block.subheading || "") : ""}">
      <input id="gridColumns" type="number" min="1" max="6" value="${isEditingSameType ? Number(block.columns || 3) : 3}" placeholder="Columns">
      <input id="gridCount" type="number" min="1" max="12" value="${itemCount}" placeholder="Number of grid items">
      <button class="add-block-btn" type="button" onclick="renderGridInputs()">Create Grid Items</button>
      <div id="gridItems"></div>
      <button class="add-block-btn" type="button" onclick="saveGrid()">${isEditingSameType ? "Update Grid" : "Save "}</button>
    `;

    renderGridInputs(isEditingSameType ? block.items : []);
    return;
  }

  if (type === "richtext") {
    blockInputs.innerHTML = `
      <input id="richTextHeading" placeholder="Rich Text Heading" value="${isEditingSameType ? escapeHtml(block.heading || "") : ""}">
      <textarea id="richTextContent" rows="8"></textarea>
      <button class="add-block-btn" type="button" onclick="saveRichText()">${isEditingSameType ? "Update Rich Text" : "Save Rich Text"}</button>
    `;

    initRichTextEditor("#richTextContent", isEditingSameType ? block.content || "" : "");
    return;
  }

  if (type === "footer") {
    blockInputs.innerHTML = `
      <input id="footerText" placeholder="Footer Text" value="${isEditingSameType ? escapeHtml(block.text || "") : ""}">
      <button class="add-block-btn" type="button" onclick="saveFooter()">${isEditingSameType ? "Update Footer" : "Save"}</button>
    `;
  }
}

function renderHeroImagePreview(existingImages = []) {
  const preview = document.getElementById("heroMultiPreview");

  if (!preview) {
    return;
  }

  preview.innerHTML = existingImages.map((src) => `
    <img src="${src}" alt="Hero image" style="width:80px;margin:5px;border-radius:8px;object-fit:cover;">
  `).join("");
}

function renderSelectedHeroImages(files) {
  const preview = document.getElementById("heroMultiPreview");

  if (!preview) {
    return;
  }

  preview.innerHTML = "";

  Array.from(files).forEach((file) => {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.style.width = "80px";
    img.style.margin = "5px";
    img.style.borderRadius = "8px";
    img.style.objectFit = "cover";
    preview.appendChild(img);
  });
}

function saveOrUpdateBlock(newBlock) {
  if (editingIndex !== undefined) {
    blocks[editingIndex] = newBlock;
  } else {
    blocks.push(newBlock);
  }

  resetEditorState();
  updateBlocks();
}

function clearOldFileInputs(prefix) {
  const pageForm = document.getElementById("pageForm");

  if (!pageForm) {
    return;
  }

  pageForm.querySelectorAll(`input[type="file"][name^="${prefix}"]`).forEach((input) => {
    input.remove();
  });
}

function saveHero() {
  const imageInput = document.getElementById("heroImages");
  const titleInput = document.getElementById("heroTitle");
  const subtitleInput = document.getElementById("heroSubtitle");
  const pageForm = document.getElementById("pageForm");
  const currentBlock = getEditingBlock();
  const heroId = currentBlock?.heroId || `hero${Date.now()}`;
  const files = Array.from(imageInput?.files || []);

  if (pageForm) {
    clearOldFileInputs(`heroImage_${heroId}`);
  }

  if (imageInput && pageForm && files.length) {
    imageInput.name = `heroImage_${heroId}`;
    imageInput.setAttribute("form", "pageForm");
    imageInput.style.display = "none";
    pageForm.appendChild(imageInput);
  }

  const newBlock = {
    type: "hero",
    heroId,
    title: titleInput ? titleInput.value : "",
    subtitle: subtitleInput ? subtitleInput.value : "",
    images: files.length ? files.map(() => "") : Array.isArray(currentBlock?.images) ? currentBlock.images : [],
  };

  saveOrUpdateBlock(newBlock);
}

function saveCard() {
  const titleInput = document.getElementById("cardTitle");
  const descInput = document.getElementById("cardDesc");

  const newBlock = {
    type: "card",
    title: titleInput ? titleInput.value : "",
    desc: descInput ? descInput.value : "",
  };

  saveOrUpdateBlock(newBlock);
}

function saveFooter() {
  const footerText = document.getElementById("footerText");

  const newBlock = {
    type: "footer",
    text: footerText ? footerText.value : "",
  };

  saveOrUpdateBlock(newBlock);
}

function saveRichText() {
  const richTextHeading = document.getElementById("richTextHeading");
  const richTextContent = document.getElementById("richTextContent");

  const newBlock = {
    type: "richtext",
    heading: richTextHeading ? richTextHeading.value : "",
    content: richTextEditor ? richTextEditor.getData() : richTextContent ? richTextContent.value : "",
  };

  saveOrUpdateBlock(newBlock);
}

function renderGridInputs(existingItems = []) {
  const gridCount = document.getElementById("gridCount");
  const gridItems = document.getElementById("gridItems");

  if (!gridCount || !gridItems) {
    return;
  }

  const count = Math.max(1, Math.min(Number(gridCount.value || 1), 12));

  gridItems.innerHTML = Array.from({ length: count }, (_, i) => {
    const item = existingItems[i] || {};
    const hasImage = Boolean(item.image);

    return `
      <div class="grid-form-item">
        <h4>Grid Item ${i + 1}</h4>
        <input id="gridItemTitle${i}" placeholder="Item Title" value="${escapeHtml(item.title || "")}">
        <input id="gridItemDesc${i}" placeholder="Item Description" value="${escapeHtml(item.desc || "")}">
        <input id="gridItemImage${i}" type="file" accept="image/*">
        ${hasImage ? `<small>Existing image will be kept unless you select a new one.</small>` : ""}
      </div>
    `;
  }).join("");
}

function saveGrid() {
  const gridCount = document.getElementById("gridCount");
  const gridHeading = document.getElementById("gridHeading");
  const gridSubheading = document.getElementById("gridSubheading");
  const gridColumns = document.getElementById("gridColumns");
  const pageForm = document.getElementById("pageForm");
  const currentBlock = getEditingBlock();
  const count = Math.max(1, Math.min(Number(gridCount?.value || 1), 12));
  const gridId = currentBlock?.gridId || `grid${Date.now()}`;
  const items = [];

  clearOldFileInputs(`gridImage_${gridId}_`);

  for (let i = 0; i < count; i++) {
    const imageInput = document.getElementById(`gridItemImage${i}`);
    const existingItem = Array.isArray(currentBlock?.items) ? currentBlock.items[i] : null;

    if (imageInput && pageForm && imageInput.files && imageInput.files.length) {
      imageInput.name = `gridImage_${gridId}_${i}`;
      imageInput.setAttribute("form", "pageForm");
      imageInput.style.display = "none";
      pageForm.appendChild(imageInput);
    }

    items.push({
      title: document.getElementById(`gridItemTitle${i}`)?.value || "",
      desc: document.getElementById(`gridItemDesc${i}`)?.value || "",
      image: imageInput?.files?.length ? "" : existingItem?.image || "",
    });
  }

  const newBlock = {
    type: "grid",
    gridId,
    heading: gridHeading ? gridHeading.value : "",
    subheading: gridSubheading ? gridSubheading.value : "",
    columns: Number(gridColumns?.value || 3),
    items,
  };

  saveOrUpdateBlock(newBlock);
}

function updateBlocks() {
  const blocksData = document.getElementById("blocksData");
  const blocksPreview = document.getElementById("blocksPreview");

  if (blocksData) {
    blocksData.value = JSON.stringify(blocks);
  }

  if (blocksPreview) {
    blocksPreview.innerHTML = blocks.map((block, i) => `
      <div class="block-item">
        ${block.type} -> ${block.title || block.text || block.heading || ""}
        <button type="button" onclick="editBlock(${i})">Edit</button>
        <button type="button" onclick="removeBlock(event, ${i})">Remove</button>
      </div>
    `).join("");
  }

  renderPreview();
}

function removeBlock(event, index) {
  event.stopPropagation();

  blocks.splice(index, 1);

  if (editingIndex === index) {
    resetEditorState();
    const blockInputs = document.getElementById("blockInputs");

    if (blockInputs) {
      blockInputs.innerHTML = "";
    }
  } else if (editingIndex !== undefined && index < editingIndex) {
    editingIndex -= 1;
  }

  updateBlocks();
}

function renderPreview() {
  const previewBox = document.getElementById("previewBox");

  if (!previewBox) {
    return;
  }

  previewBox.innerHTML = blocks.map((block) => {
    if (block.type === "hero") {
      const imageCount = Array.isArray(block.images) ? block.images.length : 0;

      return `
        <div class="hero block">
          <h1>${block.title || ""}</h1>
          <p>${block.subtitle || ""}</p>
          <small>${imageCount} slide${imageCount === 1 ? "" : "s"}</small>
        </div>
      `;
    }

    if (block.type === "card") {
      return `
        <div class="card block">
          <h3>${block.title || ""}</h3>
          <p>${block.desc || ""}</p>
        </div>
      `;
    }

    if (block.type === "footer") {
      return `<footer>${block.text || ""}</footer>`;
    }

    if (block.type === "grid") {
      return `
        <div class="grid-preview block">
          <h2>${block.heading || ""}</h2>
          <p>${block.subheading || ""}</p>
          <div class="grid-preview-items" style="grid-template-columns: repeat(${Number(block.columns) || 3}, minmax(0, 1fr));">
            ${(block.items || []).map((item) => `
              <div class="grid-preview-card">
                <strong>${item.title || ""}</strong>
                <p>${item.desc || ""}</p>
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }

    if (block.type === "richtext") {
      return `
        <div class="richtext-preview block">
          <h2>${block.heading || ""}</h2>
          <div>${block.content || ""}</div>
        </div>
      `;
    }

    return "";
  }).join("");
}
function toggleSection(id) {
  const section = document.getElementById(id);

  if (!section) {
    return;
  }

  section.classList.toggle("open");
}

function editBlock(index) {
  const block = blocks[index];
  const blockType = document.getElementById("blockType");

  if (!block || !blockType) {
    return;
  }

  editingIndex = index;
  blockType.value = block.type;
  showBlockInputs();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

document.addEventListener("DOMContentLoaded", () => {
  const pageForm = document.getElementById("pageForm");

  ensureHeroIds();
  ensureGridIds();
  updateBlocks();

  document.addEventListener("change", (event) => {
    if (event.target.id === "heroImages") {
      renderSelectedHeroImages(event.target.files || []);
    }
  });

  if (pageForm) {
    pageForm.addEventListener("submit", () => {
      ensureHeroIds();
      ensureGridIds();

      const blocksData = document.getElementById("blocksData");
      const hiddenTitle = document.getElementById("hiddenTitle");
      const pageTitle = document.getElementById("pageTitle");

      if (blocksData) {
        blocksData.value = JSON.stringify(blocks);
      }

      if (hiddenTitle && pageTitle) {
        hiddenTitle.value = pageTitle.value;
      }
    });
  }
});

window.toggleForm = toggleForm;
window.showBlockInputs = showBlockInputs;
window.saveHero = saveHero;
window.saveCard = saveCard;
window.saveGrid = saveGrid;
window.saveRichText = saveRichText;
window.saveFooter = saveFooter;
window.renderGridInputs = renderGridInputs;
window.removeBlock = removeBlock;
window.editBlock = editBlock;
window.toggleSection = toggleSection;
