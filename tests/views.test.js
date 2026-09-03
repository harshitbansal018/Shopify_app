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
const { shopifyAdminUrl } = require(path.join(SERVER, "utils/shop"));

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
    shopifyAdminUrl,
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
    const topSellers = [{
      title: "Magnetic Filter Rod",
      source: "Warehouse",
      units: 3,
      revenue: 120,
      currency: "USD",
      destination_shopify_product_id: 9001,
    }];

    // SOURCE: the plain store summary. Its own work is on Products.
    await expectRenders(
      "source sees the store summary",
      "source/dashboard",
      { ...BASE, store: STORE_ROW, stats: null },
      ["Demo Store", "demo.myshopify.com", "Dashboard"]
    );

    // A freshly installed shop can be missing most of these.
    await expectRenders(
      "renders with sparse store details",
      "source/dashboard",
      {
        ...BASE,
        store: {
          id: 1,
          shop_domain: "demo.myshopify.com",
          store_name: null,
          store_type: "source",
          currency: null,
          api_version: "2025-01",
        },
        stats: null,
      },
      ["—"] // falls back to an em-dash rather than printing "null"
    );

    const destination = (stats) =>
      render("destination/dashboard", {
        ...BASE,
        store: { ...STORE_ROW, store_type: "destination" },
        stats,
      });

    const busy = await destination({
      cards: { synced: 8, unsynced: 2, stores: 2 },
      bySource: [
        { name: "Warehouse", synced: 6, unsynced: 1 },
        { name: "Outlet", synced: 2, unsynced: 1 },
      ],
      topSellers,
    });

    check("all three cards are shown",
      (busy.match(/class="card"/g) || []).length === 3);
    check("the numbers land in them",
      busy.includes(">8<") && busy.includes(">2<"));
    check("waiting products are flagged",
      busy.includes("card__value--warn") && busy.includes("/products?tab=unsynced"),
      "the merchant should be told where to act");

    // Pie: one arc per non-zero slice, and the arcs must add up to the circle.
    const arcs = busy.match(/stroke-dasharray="([\d.]+) ([\d.]+)"/g) || [];

    check("the pie draws one arc per slice", arcs.length === 2);

    const circumference = 2 * Math.PI * 60;
    const drawn = arcs
      .map((arc) => Number(arc.match(/"([\d.]+) /)[1]))
      .reduce((sum, length) => sum + length, 0);

    check("the arcs add up to the whole circle",
      Math.abs(drawn - circumference) < 0.5,
      `${drawn.toFixed(2)} vs ${circumference.toFixed(2)}`);

    check("the pie shows the total in the middle", busy.includes("10<"));
    check("percentages are shown", busy.includes("80%") && busy.includes("20%"));

    // Bars are scaled against the BIGGEST store, so the largest fills the row.
    check("the biggest source fills its bar",
      busy.includes('width: 85.7%'),
      "6 of a 7-product peak");
    check("every source gets a row",
      (busy.match(/class="bars__row"/g) || []).length === 2);
    check("sources are named", busy.includes("Warehouse") && busy.includes("Outlet"));

    // A store that is connected but has offered nothing must still be listed,
    // or the "Stores connected" card and this list would disagree.
    const idle = await destination({
      cards: { synced: 0, unsynced: 0, stores: 2 },
      bySource: [
        {
          domain: "a.myshopify.com", name: "Warehouse",
          status: "active", active: true, synced: 0, unsynced: 0,
        },
        {
          domain: "b.myshopify.com", name: "Paused Shop",
          status: "paused", active: false, synced: 0, unsynced: 0,
        },
      ],
      topSellers: [],
    });

    check("a connected store with no products is still listed",
      (idle.match(/class="bars__row"/g) || []).length === 2,
      "the card would say 2 stores beside an empty list");
    check("and says so instead of showing a blank",
      (idle.match(/none yet/g) || []).length === 2);
    check("each row shows the shop domain",
      idle.includes("a.myshopify.com") && idle.includes("b.myshopify.com"),
      "two stores can share a display name");
    check("a connection that is not active is flagged",
      idle.includes("pill--paused") && idle.includes(">paused<"));
    check("an active one is not",
      (idle.match(/class="bars__status"/g) || []).length === 1,
      "only the paused store should carry a badge");
    check("the panel links to Stores",
      idle.includes("Manage") && idle.includes("/stores"));

    check("the top sellers table uses real records",
      busy.includes("Top selling products") &&
        busy.includes("Magnetic Filter Rod") && busy.includes("USD 120.00"));
    check("top-selling product names open Shopify",
      busy.includes("https://demo.myshopify.com/admin/products/9001"));
    check("the dashboard contains no sample sales",
      !busy.includes("Sample data") && !busy.includes("Sample product"));

    // Nothing offered yet: no divide-by-zero, no empty chart frame.
    const empty = await destination({
      cards: { synced: 0, unsynced: 0, stores: 0 },
      bySource: [],
      topSellers: [],
    });

    check("an empty store still renders the cards",
      (empty.match(/class="card"/g) || []).length === 3);
    check("but draws no pie", !empty.includes("stroke-dasharray"));
    check("and explains both charts",
      empty.includes("Nothing has been offered") &&
        empty.includes("No source store is connected"));
    check("and shows an empty top-sellers state",
      empty.includes("No records found") && empty.includes("Nothing has sold yet"));
    check("no NaN anywhere",
      !empty.includes("NaN"),
      "dividing by a zero total");
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
    const withCode = await render("source/stores", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
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
    const noCode = await render("source/stores", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
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
    const destinationHtml = await render("destination/stores", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
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

    /* ---- both roles list their connections in a table ---- */

    check(
      "each side lists its stores in a table",
      withCode.includes("<table") && destinationHtml.includes("<table")
    );
    check(
      "with a row per connection",
      destinationHtml.includes("dst.myshopify.com") === false &&
        /<td class="muted">src\.myshopify\.com<\/td>/.test(destinationHtml),
      "a destination must see the SOURCE it receives from, and only that"
    );
    check(
      "and the connection's state beside it",
      destinationHtml.includes('pill--active') &&
        destinationHtml.includes(">manual<")
    );

    const noConnections = await render("destination/stores", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
      connections: [],
      pairingCode: null,
      codeTtlMinutes: 15,
    });

    check(
      "an empty list keeps the columns",
      noConnections.includes("<table") &&
        noConnections.includes("No records found") &&
        noConnections.includes('colspan="4"')
    );

    /* ---- the destination adds a store through a popup ---- */

    check(
      "there is a button to add a store",
      destinationHtml.includes('id="add-store-button"')
    );
    check(
      "the code form lives in a dialog, not on the page",
      /<dialog[\s\S]*id="connect-code"[\s\S]*<\/dialog>/.test(destinationHtml),
      "the form would sit open on every visit"
    );
    check(
      "which starts closed",
      !/<dialog[^>]*\sopen[\s>]/.test(destinationHtml),
      "an open dialog would cover the screen on load"
    );
    check(
      "and the button that submits it says what it does",
      /id="connect-button"[\s\S]{0,40}Add store/.test(destinationHtml)
    );
    check(
      "a source is offered no such button",
      !withCode.includes('id="add-store-button"'),
      "a source cannot redeem a code -- the server refuses it"
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
    const emptySource = await render("source/products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      tab: "unshared",
      counts: { shared: 0, unshared: 1 },
      products: [],
      connections: [CONN],
      activeConnections: [CONN],
    });

    check("source empty state explains Add products",
      emptySource.includes("Add products"));
    // An empty table keeps its columns and says so in a row of its own. A
    // table that disappears reads as a screen that failed to load.
    check("source empty state keeps the columns",
      emptySource.includes("<table") && emptySource.includes("No records found"),
      "the table vanished instead of saying it is empty");

    // Source with products in three different states at once.
    const sourceHtml = await render("source/products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
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
    check("source product names open Shopify",
      sourceHtml.includes("https://demo.myshopify.com/admin/products/900"));
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
      render("source/products", {
        ...BASE,
        store: { ...STORE_ROW, store_type: "source" },
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
      (await render("source/products", {
        ...BASE,
        store: { ...STORE_ROW, store_type: "source" },
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
    const narrowedOnly = await render("source/products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
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
    const noDestination = await render("source/products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
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
      render("destination/products", {
        ...BASE,
        store: { ...STORE_ROW, store_type: "destination" },
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
    check("the product's own state moved next to its name",
      /table__title[\s\S]{0,220}ACTIVE/.test(unsynced),
      "Status now means the sync, so ACTIVE/DRAFT cannot live there too");
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
    check("the sync status is shown",
      /status-toggle[\s\S]{0,260}>\s*synced\s*</.test(synced));
    check("stock is shown", synced.includes("12 in stock"));

    /* ---- the status pill is the switch ---- */
    check("an unsynced status syncs on click",
      /class="[^"]*status-toggle"[^>]*data-mapping="6"[^>]*data-action="sync"/.test(unsynced),
      "one product is one decision; ticking then hunting for a button is two");
    check("a synced status unsyncs on click",
      /class="[^"]*status-toggle"[^>]*data-mapping="5"[^>]*data-action="unsync"/.test(synced));
    check("unsyncing posts to decline, which clears accepted_at",
      synced.includes('"/products/decline"') &&
        synced.includes('"/products/accept"'),
      "that is what moves the row back to the Unsynced tab");
    check("and it says where the row went",
      synced.includes('"/products?tab=" + (unsync ? "unsynced" : "synced")'));

    // A product that is gone at the source cannot be synced back, so the pill
    // there stays a label.
    const gone = await destination("synced", [
      { ...ACCEPTED, sync_status: "deleted" },
    ]);

    // The class, not the word: the page script names it too, so a bare
    // includes() would find it whether or not a row rendered one.
    check("a deleted product has no switch",
      !/class="[^"]*status-toggle"/.test(gone) && gone.includes(">deleted<"),
      "there is nothing at the source left to send");

    /* ---- View, on both tabs ---- */
    check("every row has a View button",
      (unsynced.match(/class="btn btn--small view-product"/g) || []).length === 1 &&
        (synced.match(/class="btn btn--small view-product"/g) || []).length === 1);
    check("View opens the MAPPING, not a source product id",
      /view-product"[\s\S]{0,60}data-product="6"/.test(unsynced) &&
        /view-product"[\s\S]{0,60}data-product="5"/.test(synced),
      "a destination only knows a product through its mapping");
    check("synced destination product names open Shopify",
      synced.includes("https://demo.myshopify.com/admin/products/700"));

    /* ---- Destination never gets source controls ---- */
    check("no source-side controls anywhere",
      !unsynced.includes('id="allow-button"') &&
        !unsynced.includes('id="add-button"') &&
        !unsynced.includes("resourcePicker"));
    check("but it does get its own Sync now",
      unsynced.includes('id="sync-button"'),
      "accepted products could never receive an update");

    /* ---- Empty tabs still show the tabs ---- */
    const emptyUnsynced = await render("destination/products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
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
    check("in a row of an otherwise complete table",
      emptyUnsynced.includes("<table") &&
        emptyUnsynced.includes("No records found") &&
        emptyUnsynced.includes('colspan="8"'),
      "the columns must survive, and the row must span all of them");
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

    const html = await render("source/productDetail", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
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
    const lastOne = await render("source/productDetail", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
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
    const notShared = await render("source/productDetail", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      product: PRODUCT,
      shared: [],
      totalVariants: 4,
      isShared: false,
    });

    // Matched on a fragment that sits on one source line -- the sentence wraps.
    check("an unshared product says what to do",
      notShared.includes("offered to a destination store yet") &&
        notShared.includes("Allow selected"));
    check("and its variant table keeps the columns",
      notShared.includes("<table") && notShared.includes("No records found"));

    // The DESTINATION sees the same page, read-only: it cannot change what it
    // was sent, so it gets no controls rather than dead ones.
    const destinationDetail = await render("destination/productDetail", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
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
    const offeredDetail = await render("destination/productDetail", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
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

  console.log("\nSync settings");
  {
    const syncSettingsModel = require(path.join(SERVER, "models/syncSettingsModel"));
    const controller = require(path.join(SERVER, "controllers/storeController"));

    const CONN = {
      id: 9,
      status: "active",
      source: { id: 1, shop_domain: "src.myshopify.com", store_name: "Warehouse" },
      destination: { id: 2, shop_domain: "dst.myshopify.com", store_name: null },
    };

    const settingsPage = (sync) =>
      render("destination/settings", {
        ...BASE,
        store: { ...STORE_ROW, store_type: "destination" },
        connections: [{ ...CONN, sync }],
        productFields: syncSettingsModel.PRODUCT_FIELDS,
        variantFields: syncSettingsModel.VARIANT_FIELDS,
        labels: controller.FIELD_LABELS,
      });

    const allOn = await settingsPage(syncSettingsModel.defaults(9));

    check("the source store is named", allOn.includes("Warehouse"));
    // No identifier picker: the destination product is created by this app,
    // so its SKUs are the ones we sent and always line up.
    check("there is no identifier picker",
      !allOn.includes('name="match_by"'),
      "a dropdown almost no merchant would ever need to touch");

    /** The checkbox tags themselves, not the words in the page script. */
    const boxes = (html) => html.match(/<input[^>]*type="checkbox"[^>]*>/g) || [];

    // Every toggle except the variants master, which the screen no longer
    // offers: Variants is a section heading, not a parent switch.
    const shown = syncSettingsModel.TOGGLES.filter((f) => f !== "variants");

    check("every toggle is rendered",
      boxes(allOn).length === shown.length,
      `${boxes(allOn).length} of ${shown.length}`);
    check("there is no variants master switch",
      !/<input[^>]*name="variants"/.test(allOn),
      "it read as a checkbox in front of a heading");
    check("defaults render as ticked",
      boxes(allOn).every((tag) => /\bchecked\b/.test(tag)),
      "a merchant who has chosen nothing wants everything synced");

    check("title cannot be turned off",
      /name="title"[^>]*disabled/.test(allOn),
      "productSet cannot create a product without one");

    check("the price margin is shown", allOn.includes('name="price_markup_percent"'));
    check("saving is explained",
      allOn.includes("queues every product on this connection"));
    check("and so is what unticking means",
      allOn.includes("your own value") && allOn.includes("not erased"),
      "a merchant would reasonably fear it deletes their data");

    // With no master switch on the screen, every save has to send it on --
    // otherwise a merchant who once turned variants off could never get them
    // back, and there would be no control to do it with.
    check("saving turns variants back on",
      allOn.includes("settings.variants = true"),
      "sync_variants would otherwise be stuck at whatever it is now");

    const priceOff = await settingsPage({
      ...syncSettingsModel.defaults(9),
      variant_price: false,
    });

    check("an unticked field renders unticked",
      /name="variant_price"[^>]*(?!checked)>/.test(priceOff) &&
        !/name="variant_price"[^>]*\bchecked\b/.test(priceOff));
    check("and the others stay ticked",
      /name="variant_sku"[^>]*\bchecked\b/.test(priceOff));

    // No connection yet: say so rather than showing an empty form.
    const noConnection = await render("destination/settings", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
      connections: [],
      productFields: syncSettingsModel.PRODUCT_FIELDS,
      variantFields: syncSettingsModel.VARIANT_FIELDS,
      labels: controller.FIELD_LABELS,
    });

    check("with no connection it points at Stores",
      noConnection.includes("No source store connected") &&
        noConnection.includes("/stores"));
    check("and renders no form", boxes(noConnection).length === 0);

    // Every toggle needs a label, or a checkbox ships with a raw column name.
    check("every toggle has a label",
      syncSettingsModel.TOGGLES.every((field) => controller.FIELD_LABELS[field]),
      syncSettingsModel.TOGGLES.filter((f) => !controller.FIELD_LABELS[f]).join(", "));
  }

  console.log("\nOrders");
  {
    const ROW = {
      id: 11,
      connection_id: 3,
      destination_order_id: 77,
      destination_shopify_order_id: "900001",
      destination_order_name: "#2001",
      destination_order_number: 2001,
      source_shopify_order_id: null,
      source_order_name: null,
      // 24.00 owed to the source, 30.00 paid by the shopper: the 25% markup.
      source_total: 24,
      destination_total: 30,
      currency: "USD",
      line_count: 2,
      sync_status: "pending",
      error_message: null,
      financial_status: "paid",
      fulfillment_status: null,
      cancelled_at: null,
      source_shop_domain: "src.myshopify.com",
      source_store_name: "Warehouse",
      destination_shop_domain: "dst.myshopify.com",
      destination_store_name: "Front Shop",
    };

    const orders = (role, tab, rows) =>
      render(`${role}/orders`, {
        ...BASE,
        store: { ...STORE_ROW, store_type: role },
        tab,
        counts: { placed: 1, waiting: 1 },
        orders: rows,
        statusCounts: { pending: 1, synced: 1, failed: 0, skipped: 0 },
      });

    const waiting = await orders("destination", "waiting", [ROW]);

    check("both tabs are shown with their counts",
      waiting.includes("Placed (1)") && waiting.includes("Waiting (1)"));
    check("the sale is named", waiting.includes("#2001"));
    check("order numbers open the destination Shopify order",
      waiting.includes("https://dst.myshopify.com/admin/orders/900001"));
    check("and so is the store that supplied it", waiting.includes("Warehouse"));

    // The two totals side by side ARE the feature: the gap is the markup.
    check("the destination sees what the shopper paid",
      waiting.includes("30.00"));
    check("beside what the source is owed",
      waiting.includes("24.00"),
      "the source price is the whole point of forwarding the order");

    check("an unplaced order says so", waiting.includes("not yet placed"));
    check("and can be placed by hand",
      /class="[^"]*retry-order"[^>]*data-order="11"/.test(waiting));
    check("every row opens", /class="[^"]*view-order"[^>]*data-order="11"/.test(waiting));

    const placed = await orders("destination", "placed", [
      {
        ...ROW,
        sync_status: "synced",
        source_order_name: "#5005",
        source_shopify_order_id: "500005",
      },
    ]);

    check("a placed order names the source order", placed.includes("#5005"));
    check("source order numbers open the source Shopify order",
      placed.includes("https://src.myshopify.com/admin/orders/500005"));
    // The class attribute, not the word: the page script names it too, so a
    // bare includes() would find it whether or not a button rendered.
    check("and offers no retry",
      !/class="[^"]*retry-order"/.test(placed),
      "placing it twice would order the same goods again");

    // A source reads its own money first, in the same column position.
    const asSource = await orders("source", "waiting", [ROW]);

    check("the source column is labelled for a source",
      asSource.includes("You are owed") && !asSource.includes("Source price"));
    check("a source cannot place the order itself",
      !/class="[^"]*retry-order"/.test(asSource),
      "the sale that raised it belongs to the destination");

    const none = await orders("destination", "placed", []);
    check("an empty screen explains itself",
      none.includes("No orders yet") && none.includes("No records found"));
    check("and keeps its columns", none.includes("<table"),
      "the table vanished instead of saying it is empty");

    // Detail: the per-line price comparison.
    const detail = await render("destination/orderDetail", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
      order: {
        ...ROW,
        sync_status: "synced",
        source_order_name: "#5005",
        source_shopify_order_id: "500005",
      },
      lines: [
        {
          line_id: 1, quantity: 2, source_price: 10, destination_price: 12.5,
          title: "Blue Shirt", source_product_title: "Blue Shirt",
          source_variant_title: "S", source_sku: "SH-S", destination_sku: "SH-S",
          source_shopify_product_id: "900",
          destination_shopify_product_id: "700",
        },
      ],
    });

    check("the detail lists the line", detail.includes("Blue Shirt"));
    check("order line product names open Shopify",
      detail.includes("https://dst.myshopify.com/admin/products/700"));
    check("with both unit prices",
      detail.includes("10.00") && detail.includes("12.50"));
    check("and the source total for the line",
      detail.includes("20.00"),
      "2 x 10.00, which is what the source invoices");
    check("it says where the margin is set",
      detail.includes("/settings"));

    const emptyDetail = await render("source/orderDetail", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      order: ROW,
      lines: [],
    });

    check("a detail with no lines left explains why",
      emptyDetail.includes("nothing left to charge for"));
    check("and keeps its columns",
      emptyDetail.includes("<table") && emptyDetail.includes("No records found"));
    check("but drops the totals row",
      !emptyDetail.includes("Totals"),
      "totalling nothing would print 0.00 as though it were a real invoice");
  }

  console.log("\nPartials");
  {
    await expectRenders("nav renders", "partials/nav", {}, [
      "s-app-nav",
      "/images/product-sync-logo-256.png",
      "Product Sync",
    ]);
    await expectRenders("head renders", "partials/head", BASE, [
      "shopify-api-key",
      "app-bridge.js",
      "/images/favicon-32.png",
      "/images/apple-touch-icon.png",
    ]);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
