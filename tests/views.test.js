/* Renders every view with exactly the locals its controller passes.
 *
 * Compiling a template only catches syntax errors -- a variable the controller
 * stopped passing fails at RENDER time and reaches the merchant as a 500.
 * Add a case here for every screen you add.
 */
const path = require("path");
const ejs = require("ejs");

const SERVER = path.join(__dirname, "..");
const VIEWS = path.join(SERVER, "views");

process.env.SHOPIFY_API_KEY = "test_api_key";
process.env.SHOPIFY_API_SECRET = "test_api_secret";
process.env.HOST = "https://app.example.com";

const { serializeForScript } = require(path.join(SERVER, "utils/html"));

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

/** Render a view the way Express does: same locals, same `json` helper. */
function render(view, locals) {
  return ejs.renderFile(path.join(VIEWS, `${view}.ejs`), {
    json: serializeForScript,
    ...locals,
  });
}

async function expectRenders(name, view, locals, mustContain = []) {
  try {
    const html = await render(view, locals);
    const missing = mustContain.filter((needle) => !html.includes(needle));

    if (missing.length) {
      check(name, false, `missing: ${missing.join(", ")}`);
      return;
    }

    check(name, html.length > 0);
  } catch (err) {
    check(name, false, err.message.split("\n").pop().trim());
  }
}

const BASE = { shop: "demo.myshopify.com", apiKey: "test_api_key" };

const STORE_ROW = {
  id: 1,
  shop_domain: "demo.myshopify.com",
  store_name: "Demo Store",
  store_type: "source",
  currency: "USD",
  api_version: "2025-01",
  is_active: true,
};

(async () => {
  console.log("\nDashboard");
  {
    await expectRenders(
      "renders with a fully populated store",
      "dashboard",
      { ...BASE, store: STORE_ROW },
      ["Demo Store", "demo.myshopify.com", "Dashboard"]
    );

    // A freshly installed shop can be missing most of these.
    await expectRenders(
      "renders with sparse store details",
      "dashboard",
      {
        ...BASE,
        store: {
          id: 1,
          shop_domain: "demo.myshopify.com",
          store_name: null,
          store_type: null,
          currency: null,
          api_version: "2025-01",
        },
      },
      ["—"] // falls back to an em-dash rather than printing "null"
    );
  }

  console.log("\nStore type (chosen once)");
  {
    const controller = require(path.join(SERVER, "controllers/storeController"));
    const ROLE_COPY = {
      source: { title: "Source", summary: "s", detail: "d" },
      destination: { title: "Destination", summary: "s", detail: "d" },
    };
    const ROLES = ["source", "destination"].map((value) => ({
      value,
      ...ROLE_COPY[value],
    }));

    check(
      "controller exports the picker for other screens to render",
      typeof controller.renderStoreType === "function"
    );

    const unchosen = {
      ...BASE,
      store: { ...STORE_ROW, store_type: null },
      roles: ROLES,
      chosen: null,
      copy: null,
    };

    await expectRenders("offers both types", "storeType", unchosen, [
      'value="source"',
      'value="destination"',
      "Continue",
    ]);

    const pickHtml = await render("storeType", unchosen);

    /** The radio tags themselves -- not the ":checked" in the page script. */
    function radios(html) {
      return html.match(/<input[^>]*name="store_type"[^>]*>/g) || [];
    }

    check("renders both radios", radios(pickHtml).length === 2);
    check(
      "preselects nothing",
      radios(pickHtml).every((tag) => !/\bchecked\b/.test(tag)),
      "a type was preselected, which decides for the merchant"
    );
    check(
      "hides the nav before a type is chosen",
      !pickHtml.includes("s-app-nav"),
      "nav links lead to screens that need a type"
    );
    check(
      "warns that the choice is permanent",
      /cannot be changed/i.test(pickHtml),
      "an irreversible choice was presented as ordinary"
    );
    check(
      "asks for confirmation before saving",
      pickHtml.includes("window.confirm"),
      "one stray click would decide it permanently"
    );

    // Already chosen: read-only. No form, no radios, nothing to submit.
    const chosenHtml = await render("storeType", {
      ...BASE,
      store: STORE_ROW, // store_type: "source"
      roles: ROLES,
      chosen: "source",
      copy: ROLE_COPY.source,
    });

    check("chosen state renders no radios", radios(chosenHtml).length === 0);
    check(
      "chosen state renders no form",
      !chosenHtml.includes('id="role-form"'),
      "the choice could still be resubmitted"
    );
    check("chosen state shows the nav", chosenHtml.includes("s-app-nav"));
    check("chosen state names the type", chosenHtml.includes("Source"));
    check(
      "chosen state points onward to Stores",
      chosenHtml.includes("/stores")
    );
  }

  console.log("\nStores");
  {
    const CONNECTION = {
      id: 7,
      status: "active",
      sync_mode: "manual",
      source: { id: 1, shop_domain: "src.myshopify.com", store_name: "Src" },
      destination: { id: 2, shop_domain: "dst.myshopify.com", store_name: null },
    };

    // SOURCE: shows a code, never an input to type one into.
    const withCode = await render("stores", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      isSource: true,
      tab: "unshared",
      counts: { shared: 0, unshared: 1 },
      connections: [CONNECTION],
      pairingCode: { code: "ABCD-2345", expiresAt: new Date("2026-01-01T10:30:00Z") },
      codeTtlMinutes: 15,
    });

    check("source shows its code", withCode.includes("ABCD-2345"));
    check(
      "source has no code input",
      !withCode.includes('id="connect-code"'),
      "a source could redeem a code, which the server refuses"
    );
    check(
      "source lists the destination store",
      withCode.includes("dst.myshopify.com")
    );
    check("source shows the expiry", withCode.includes("10:30"));

    // No code yet: the box is hidden rather than showing an empty slot.
    const noCode = await render("stores", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      isSource: true,
      tab: "unshared",
      counts: { shared: 0, unshared: 1 },
      connections: [],
      pairingCode: null,
      codeTtlMinutes: 15,
    });

    check(
      "source without a code hides the code box",
      /<div class="code" id="code-box" hidden>/.test(noCode)
    );
    check("source offers to generate one", noCode.includes("Generate a code"));
    check(
      "empty list is explained",
      noCode.includes("No destination store is connected")
    );

    // DESTINATION: types a code in, never shows one.
    const destinationHtml = await render("stores", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
      isSource: false,
      connections: [CONNECTION],
      pairingCode: null,
      codeTtlMinutes: 15,
    });

    check(
      "destination has a code input",
      destinationHtml.includes('id="connect-code"')
    );
    check(
      "destination is not offered a code to hand out",
      !destinationHtml.includes('id="code-box"'),
      "both stores would be showing codes"
    );
    check(
      "destination lists the source store",
      destinationHtml.includes("src.myshopify.com")
    );
    // CONNECTION.destination has store_name: null, and the source view is what
    // renders it -- so this is where a missing name would surface.
    check(
      "a store with no name falls back to its domain",
      !withCode.includes(">null<"),
      "a missing store_name printed as null"
    );
  }

  console.log("\nProducts");
  {
    const SOURCE_ROW = {
      id: 11,
      shopify_product_id: "900",
      title: "Blue Shirt",
      vendor: "Acme",
      status: "ACTIVE",
      // Two variants and none narrowed away, so the count and the list agree.
      // The controller only ever passes the variants that are actually shared.
      variant_count: 2,
      allowed: 0,
      synced: 0,
      pending: 0,
      failed: 0,
      error_message: null,
      image_url: "https://cdn.shopify.com/s/files/blue-shirt.jpg",
      awaiting: 0,
      allowed_variant_ids: null, // null = every variant
      variants: [
        {
          id: 101,
          option1: "S", option2: null, option3: null,
          sku: "SH-S", title: "S", price: "20.00", inventory_quantity: 4,
        },
        {
          // No SKU and no stock figure: both are optional on a real variant.
          id: 102,
          option1: "M", option2: null, option3: null,
          sku: null, title: "M", price: null, inventory_quantity: null,
        },
      ],
    };

    const CONN = {
      id: 1,
      status: "active",
      sync_mode: "manual",
      source: { id: 1, shop_domain: "src.myshopify.com", store_name: "Src" },
      destination: { id: 2, shop_domain: "dst.myshopify.com", store_name: null },
    };

    // Source with nothing staged yet.
    const emptySource = await render("products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      isSource: true,
      tab: "unshared",
      counts: { shared: 0, unshared: 1 },
      products: [],
      connections: [CONN],
      activeConnections: [CONN],
    });

    check("source empty state explains Add products",
      emptySource.includes("Add products"));
    check("source empty state has no table", !emptySource.includes("<table"));

    // Source with products in three different states at once.
    const sourceHtml = await render("products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      isSource: true,
      tab: "unshared",
      counts: { shared: 0, unshared: 1 },
      products: [
        SOURCE_ROW,
        { ...SOURCE_ROW, id: 12, title: "Red Cap", allowed: 1, pending: 1 },
        { ...SOURCE_ROW, id: 13, title: "Green Bag", allowed: 1, synced: 1 },
        {
          ...SOURCE_ROW,
          id: 14,
          title: "Black Shoes",
          allowed: 1,
          failed: 1,
          error_message: "handle taken",
        },
      ],
      connections: [CONN],
      activeConnections: [CONN],
    });

    check("source lists every product", sourceHtml.includes("Black Shoes"));
    check("unshared product says so", sourceHtml.includes("Not shared"));
    check("pending is shown", sourceHtml.includes("1 pending"));
    check("synced is shown", sourceHtml.includes("1 synced"));
    check("failed is shown", sourceHtml.includes("1 failed"));
    check("the failure reason is carried", sourceHtml.includes("handle taken"));
    check("source opens the App Bridge picker",
      sourceHtml.includes("shopify.resourcePicker"),
      "the custom modal was replaced by the admin picker");
    check(
      "the picker runs in product mode",
      /type:\s*"product"/.test(sourceHtml),
      "the variant picker shows a flat list with no product titles"
    );

    // Two tabs over one table, same shape as the destination.
    const sourceTab = (tab, products) =>
      render("products", {
        ...BASE,
        store: { ...STORE_ROW, store_type: "source" },
        isSource: true,
        tab,
        counts: { shared: 1, unshared: 1 },
        products,
        connections: [CONN],
        activeConnections: [CONN],
        });

    const unsharedTab = await sourceTab("unshared", [SOURCE_ROW]);
    const sharedTab = await sourceTab("shared", [
      { ...SOURCE_ROW, id: 12, title: "Red Cap", allowed: 1, synced: 1 },
    ]);

    check("both tabs are shown with their counts",
      unsharedTab.includes("Shared (1)") && unsharedTab.includes("Unshared (1)"));
    check("the open tab is marked",
      /tabs__tab tabs__tab--on"[^>]*data-tab="unshared"/.test(unsharedTab) &&
        /tabs__tab tabs__tab--on"[^>]*data-tab="shared"/.test(sharedTab),
      "the merchant cannot tell which list they are looking at");

    check("only the Unshared tab is selectable",
      unsharedTab.includes('class="row-check"') &&
        !sharedTab.includes('class="row-check"'),
      "an already-shared product has nothing left to allow");
    check("and only it offers Allow selected",
      unsharedTab.includes('id="allow-button"') &&
        !sharedTab.includes('id="allow-button"'));

    check("View and Delete are on BOTH tabs",
      unsharedTab.includes("view-product") && sharedTab.includes("view-product") &&
        unsharedTab.includes("delete-product") && sharedTab.includes("delete-product"));

    check("allowing moves the merchant to the Shared tab",
      unsharedTab.includes('appNavigate("/products?tab=shared")'),
      "the product just moved and the merchant would not see it");

    // An empty tab still shows the tabs -- the other one may have something.
    const emptyShared = await sourceTab("shared", []);

    check("an empty tab keeps the tabs visible",
      emptyShared.includes("Shared (1)") && emptyShared.includes("Unshared (1)"));
    check("and explains itself",
      emptyShared.includes("Nothing shared yet"));
    check("with no rows there is no Allow button",
      !emptyShared.includes('id="allow-button"'));

    // The picker opens BLANK on purpose. Pre-ticking it with everything
    // already staged made it hand the whole catalogue back on every Add, and
    // the server then re-imported all of it to add one product.
    check(
      "the picker is not pre-ticked",
      !sourceHtml.includes("selectionIds"),
      "it would return every staged product and re-import the lot"
    );
    check("no hand-rolled picker markup remains",
      !sourceHtml.includes('id="picker"'));
    check(
      "source has NO sync button",
      !sourceHtml.includes('id="sync-button"'),
      "the source must not be able to push into someone else's store"
    );
    check(
      "each row is selectable",
      (sourceHtml.match(/class="row-check"/g) || []).length === 4
    );

    // Variants are counted here, not listed: the list lives on the product's
    // own page behind View.
    check(
      "the table no longer inlines variants",
      !sourceHtml.includes('class="variants__row"') &&
        !sourceHtml.includes('class="variant-check"'),
      "the variant list should have moved to the product page"
    );
    check(
      "the shared variant count is shown",
      /<td>\s*2\s*<\/td>/.test(sourceHtml),
      "2 of the product's variants are shared"
    );

    // Images.
    check(
      "the product thumbnail is rendered",
      sourceHtml.includes("blue-shirt.jpg") &&
        sourceHtml.includes('class="media__thumb"')
    );
    check(
      "a product with no image gets a placeholder, not a broken img",
      (await render("products", {
        ...BASE,
        store: { ...STORE_ROW, store_type: "source" },
        isSource: true,
      tab: "unshared",
      counts: { shared: 0, unshared: 1 },
        products: [{ ...SOURCE_ROW, image_url: null }],
        connections: [CONN],
        activeConnections: [CONN],
      })).includes("media__thumb--empty")
    );

    // Row actions.
    const buttons = (html, cls) =>
      html.match(new RegExp('<button[^>]*class="[^"]*' + cls + '[^"]*"', "g")) || [];

    check(
      "every row has a View button",
      buttons(sourceHtml, "view-product").length === 4
    );
    check(
      "every row has a Delete button",
      buttons(sourceHtml, "delete-product").length === 4
    );
    check(
      "View knows which product to open",
      /class="btn btn--small view-product"[\s\S]{0,60}data-product="11"/.test(sourceHtml)
    );
    check(
      "Delete carries what the confirm dialog needs",
      /class="btn btn--small btn--danger delete-product"[\s\S]{0,160}data-title="Blue Shirt"/.test(
        sourceHtml
      ),
      "the warning could not name the product"
    );
    check(
      "Delete carries how many stores it will hit",
      /delete-product"[\s\S]{0,200}data-synced="1"/.test(sourceHtml),
      "the warning could not say how many stores lose the product"
    );

    // A narrowed product says so without listing anything.
    const narrowedOnly = await render("products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      isSource: true,
      tab: "unshared",
      counts: { shared: 0, unshared: 1 },
      products: [
        {
          ...SOURCE_ROW,
          allowed: 1,
          pending: 1,
          variant_count: 4,
          allowed_variant_ids: [101],
          variants: [SOURCE_ROW.variants[0]], // only one is shared
        },
      ],
      connections: [CONN],
      activeConnections: [CONN],
    });

    check(
      "a narrowed product shows shared-of-total",
      narrowedOnly.includes("of 4"),
      "1 of 4 -- the merchant cannot otherwise tell some are missing"
    );

    // No destination connected: the merchant must be told why nothing can go out.
    const noDestination = await render("products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      isSource: true,
      tab: "unshared",
      counts: { shared: 0, unshared: 1 },
      products: [SOURCE_ROW],
      connections: [],
      activeConnections: [],
    });

    check(
      "source with no destination is warned",
      noDestination.includes("No destination store is connected")
    );

    // Destination: two tabs over one table. "Unsynced" is what a source has
    // offered; "Synced" is what this store accepted and now holds.
    const OFFERED = {
      mapping_id: 6,
      destination_shopify_product_id: null,
      sync_status: "pending",
      accepted_at: null,
      awaiting: true,
      last_synced_at: null,
      error_message: null,
      title: "Red Cap",
      vendor: "Acme",
      status: "active",
      image_url: "https://cdn.shopify.com/s/files/red-cap.jpg",
      source_shop_domain: "src.myshopify.com",
      source_store_name: "Warehouse",
      inventory: 0,
      variant_count: 0,
      offered_variant_count: 3,
      variants: [],
    };

    const ACCEPTED = {
      mapping_id: 5,
      destination_shopify_product_id: "700",
      sync_status: "synced",
      accepted_at: new Date("2026-08-27T09:00:00Z"),
      awaiting: false,
      last_synced_at: new Date("2026-08-27T09:15:00Z"),
      error_message: null,
      title: "Blue Shirt",
      vendor: "Acme",
      status: "active",
      image_url: "https://cdn.shopify.com/s/files/blue-shirt.jpg",
      source_shop_domain: "src.myshopify.com",
      source_store_name: "Warehouse",
      inventory: 12,
      variant_count: 2,
      offered_variant_count: 2,
      variants: [
        {
          option1: "S", option2: null, option3: null,
          sku: "SH-S", source_title: "S", destination_variant_id: "5001",
        },
      ],
    };

    const destination = (tab, products) =>
      render("products", {
        ...BASE,
        store: { ...STORE_ROW, store_type: "destination" },
        isSource: false,
        tab,
        counts: { synced: 1, unsynced: 1 },
        products,
        connections: [CONN],
      });

    /* ---- Unsynced tab ---- */
    const unsynced = await destination("unsynced", [OFFERED]);

    check("both tabs are shown with their counts",
      unsynced.includes("Synced (1)") && unsynced.includes("Unsynced (1)"));
    check("the open tab is marked",
      /tabs__tab tabs__tab--on"[^>]*data-tab="unsynced"/.test(unsynced),
      "the merchant cannot tell which list they are looking at");
    check("offered rows are selectable",
      (unsynced.match(/class="awaiting-check"/g) || []).length === 1);
    check("the checkbox carries the mapping id",
      /class="awaiting-check"[^>]*value="6"/.test(unsynced));
    check("it offers Sync selected and Decline",
      unsynced.includes('id="accept-button"') &&
        unsynced.includes('id="decline-button"'));

    check("the source store is named", unsynced.includes("Warehouse"));
    check("the variant count is shown", unsynced.includes("<td>3</td>"));
    check("zero stock is flagged",
      /class="stock--none"/.test(unsynced),
      "a product with nothing in stock would sync and sell nothing");

    /* ---- Synced tab ---- */
    const synced = await destination("synced", [ACCEPTED]);

    check("the synced tab marks itself",
      /tabs__tab tabs__tab--on"[^>]*data-tab="synced"/.test(synced));
    check("accepted rows are NOT selectable",
      !synced.includes('class="awaiting-check"'),
      "there is nothing left to accept");
    check("nor offered accept controls",
      !synced.includes('id="accept-button"'));
    check("the sync status is shown", synced.includes(">synced<"));
    check("stock is shown", synced.includes("12 in stock"));

    /* ---- View, on both tabs ---- */
    check("every row has a View button",
      (unsynced.match(/class="btn btn--small view-product"/g) || []).length === 1 &&
        (synced.match(/class="btn btn--small view-product"/g) || []).length === 1);
    check("View opens the MAPPING, not a source product id",
      /view-product"[\s\S]{0,60}data-product="6"/.test(unsynced) &&
        /view-product"[\s\S]{0,60}data-product="5"/.test(synced),
      "a destination only knows a product through its mapping");

    /* ---- Destination never gets source controls ---- */
    check("no source-side controls anywhere",
      !unsynced.includes('id="allow-button"') &&
        !unsynced.includes('id="add-button"') &&
        !unsynced.includes("resourcePicker"));
    check("but it does get its own Sync now",
      unsynced.includes('id="sync-button"'),
      "accepted products could never receive an update");

    /* ---- Empty tabs still show the tabs ---- */
    const emptyUnsynced = await render("products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
      isSource: false,
      tab: "unsynced",
      counts: { synced: 0, unsynced: 0 },
      products: [],
      connections: [CONN],
    });

    check("an empty tab still shows both tabs",
      emptyUnsynced.includes("Synced (0)") && emptyUnsynced.includes("Unsynced (0)"),
      "the other tab may still have something");
    check("and explains itself",
      emptyUnsynced.includes("Nothing is waiting for you"));
    check("with nothing to accept there is no accept button",
      !emptyUnsynced.includes('id="accept-button"'));
  }

  console.log("\nProduct detail");
  {
    const PRODUCT = { id: 11, title: "Blue Shirt", vendor: "Acme" };
    const VARIANTS = [
      { id: 101, option1: "S", option2: null, option3: null, title: "S",
        sku: "SH-S", price: "20.00", inventory_quantity: 4 },
      { id: 102, option1: "M", option2: null, option3: null, title: "M",
        sku: null, price: null, inventory_quantity: null },
    ];

    const html = await render("productDetail", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      isSource: true,
      product: PRODUCT,
      shared: VARIANTS,
      totalVariants: 4,
      isShared: true,
    });

    check("the product is named", html.includes("Blue Shirt"));
    check("it says how many of how many are shared",
      html.includes("2 of 4"));
    check("each shared variant is listed",
      (html.match(/class="btn btn--small btn--danger remove-variant"/g) || []).length === 2);
    check("a delete button knows its variant",
      /remove-variant"[\s\S]{0,60}data-variant="101"/.test(html));
    check("variant details are shown",
      html.includes("SH-S") && html.includes("20.00"));
    check("missing price and stock fall back to a dash",
      !html.includes(">null<"), "a missing value printed as null");

    // There is deliberately no Sync here: the source does not push.
    check("there is no sync button", !html.includes("Sync now"));

    check("a way back to all variants is offered",
      html.includes("Share all 4 variants"));
    check("and it says how many are held back",
      html.includes("2 variants are"));

    // The LAST shared variant cannot be removed -- that would push a product
    // with no variants and strip the destination's copy to nothing.
    const lastOne = await render("productDetail", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      isSource: true,
      product: PRODUCT,
      shared: [VARIANTS[0]],
      totalVariants: 4,
      isShared: true,
    });

    check(
      "the last shared variant cannot be deleted",
      /remove-variant"[\s\S]{0,120}\bdisabled\b/.test(lastOne),
      "removing it would leave the product with no variants at all"
    );

    // Nothing shared at all: the page explains rather than looking broken.
    const notShared = await render("productDetail", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      isSource: true,
      product: PRODUCT,
      shared: [],
      totalVariants: 4,
      isShared: false,
    });

    // Matched on a fragment that sits on one source line -- the sentence wraps.
    check("an unshared product says what to do",
      notShared.includes("offered to a destination store yet") &&
        notShared.includes("Allow selected"));

    // The DESTINATION sees the same page, read-only: it cannot change what it
    // was sent, so it gets no controls rather than dead ones.
    const destinationDetail = await render("productDetail", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
      isSource: false,
      product: {
        id: 6,
        title: "Blue Shirt",
        vendor: "Acme",
        source_shop_domain: "src.myshopify.com",
        source_store_name: "Warehouse",
      },
      shared: [
        {
          option1: "S", option2: null, option3: null,
          sku: "SH-S", source_title: "S", source_price: "20.00",
          inventory_quantity: 4,
        },
      ],
      totalVariants: 1,
      isShared: true,
    });

    check("the destination sees the variants",
      destinationDetail.includes("SH-S") && destinationDetail.includes("20.00"));
    check("the variant name comes from the source row",
      destinationDetail.includes(">\n                    S\n") ||
        destinationDetail.includes("S<"));
    check(
      "the destination gets no Delete buttons",
      !/<button[^>]*remove-variant/.test(destinationDetail),
      "it cannot change what the source sent"
    );
    check("nor a way to widen the selection",
      !destinationDetail.includes('id="reset-variants"'));
    check("and the heading is written for them",
      destinationDetail.includes("Variants in this product"));

    // Offered but not accepted: tell them what to do next.
    const offeredDetail = await render("productDetail", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
      isSource: false,
      product: {
        id: 6, title: "Red Cap", vendor: null,
        source_shop_domain: "src.myshopify.com",
        source_store_name: "Warehouse",
      },
      shared: [],
      totalVariants: 3,
      isShared: false,
    });

    check("an unaccepted offer names the source store",
      offeredDetail.includes("Warehouse") &&
        offeredDetail.includes("Sync selected"));
    // Matched on the BUTTON: the page script mentions the class too.
    check("and offers nothing to delete",
      !/<button[^>]*remove-variant/.test(notShared));
  }

  console.log("\nPartials");
  {
    await expectRenders("nav renders", "partials/nav", {}, ["s-app-nav"]);
    await expectRenders("head renders", "partials/head", BASE, [
      "shopify-api-key",
      "app-bridge.js",
    ]);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
