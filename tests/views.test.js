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
      variant_count: 3,
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

    // Variants are listed under each product, not merely counted.
    check(
      "variants are rendered, not just counted",
      (sourceHtml.match(/class="variants__row"/g) || []).length === 8,
      "4 products x 2 variants"
    );
    check("a variant SKU is shown", sourceHtml.includes("SH-S"));
    check("a variant price is shown", sourceHtml.includes("20.00"));
    check("variant stock is shown", sourceHtml.includes("4 in stock"));
    check(
      "a variant missing price or stock falls back to a dash",
      !sourceHtml.includes("null in stock") && !sourceHtml.includes(">null<"),
      "a missing value printed as null"
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
        products: [{ ...SOURCE_ROW, image_url: null }],
        connections: [CONN],
        activeConnections: [CONN],
      })).includes("media__thumb--empty")
    );

    // Variant-level selection.
    check(
      "every variant is selectable",
      (sourceHtml.match(/class="variant-check"/g) || []).length === 8
    );
    check(
      "a variant checkbox knows which product it belongs to",
      sourceHtml.includes('data-product="11"') && sourceHtml.includes('value="101"')
    );
    check(
      "with allowed_variant_ids null, every variant is ticked",
      (sourceHtml.match(/class="variant-check"[^>]*checked/g) || []).length === 8,
      "a product not yet narrowed should default to all variants"
    );

    // A narrowed product ticks only what was chosen.
    const narrowed = await render("products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      isSource: true,
      products: [{ ...SOURCE_ROW, allowed: 1, pending: 1, allowed_variant_ids: [101] }],
      connections: [CONN],
      activeConnections: [CONN],
    });

    const narrowedChecks = narrowed.match(/<input[^>]*class="variant-check"[^>]*>/g) || [];

    check(
      "a narrowed product ticks only the chosen variant",
      narrowedChecks.length === 2 &&
        /\bchecked\b/.test(narrowedChecks[0]) &&
        !/\bchecked\b/.test(narrowedChecks[1]),
      narrowedChecks.join(" | ")
    );

    // No destination connected: the merchant must be told why nothing can go out.
    const noDestination = await render("products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      isSource: true,
      products: [SOURCE_ROW],
      connections: [],
      activeConnections: [],
    });

    check(
      "source with no destination is warned",
      noDestination.includes("No destination store is connected")
    );

    // Destination, with one product offered and awaiting a decision and one
    // already accepted.
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
      image_url: "https://cdn.shopify.com/s/files/red-cap.jpg",
      source_shop_domain: "src.myshopify.com",
      source_store_name: "Warehouse",
      variant_count: 0,
      offered_variant_count: 3,
      variants: [],
    };

    const destinationHtml = await render("products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
      isSource: false,
      awaiting: [OFFERED],
      products: [
        {
          mapping_id: 5,
          destination_shopify_product_id: "700",
          sync_status: "synced",
          last_synced_at: new Date("2026-08-27T09:15:00Z"),
          error_message: null,
          title: "Blue Shirt",
          vendor: "Acme",
          source_shop_domain: "src.myshopify.com",
          source_store_name: "Warehouse",
          variant_count: 2,
          variants: [
            {
              option1: "S", option2: null, option3: null,
              sku: "SH-S", source_title: "S", destination_variant_id: "5001",
            },
            {
              // Pushed, but this variant never came back linked.
              option1: "M", option2: null, option3: null,
              sku: null, source_title: "M", destination_variant_id: null,
            },
          ],
        },
      ],
      connections: [CONN],
    });

    check(
      "destination names the source store",
      destinationHtml.includes("Warehouse") &&
        destinationHtml.includes("src.myshopify.com")
    );
    check("destination shows the sync time", destinationHtml.includes("2026-08-27 09:15"));
    check(
      "destination lists the synced variants",
      (destinationHtml.match(/class="variants__row"/g) || []).length === 2
    );
    check(
      "a linked variant says so",
      destinationHtml.includes("linked")
    );
    check(
      "an unlinked variant is distinguishable",
      destinationHtml.includes("not linked"),
      "a variant that never came back would look synced"
    );
    check(
      "destination cannot add products",
      !destinationHtml.includes('id="add-button"') &&
        !destinationHtml.includes("resourcePicker"),
      "a destination was offered controls the server refuses"
    );
    check(
      "destination has no source-side controls",
      !destinationHtml.includes('id="allow-button"') &&
        !destinationHtml.includes('id="add-button"')
    );
    check(
      "destination has its own sync button",
      destinationHtml.includes('id="sync-button"'),
      "accepted products could never receive an update"
    );

    // The destination's own decision.
    check(
      "offered products are listed separately",
      destinationHtml.includes("Waiting for you (1)") &&
        destinationHtml.includes("Red Cap")
    );
    check(
      "each offered product is selectable",
      (destinationHtml.match(/class="awaiting-check"/g) || []).length === 1
    );
    check(
      "the checkbox carries the mapping id, not the product id",
      /class="awaiting-check"[^>]*value="6"/.test(destinationHtml)
    );
    check(
      "destination gets its own Sync now",
      destinationHtml.includes('id="accept-button"')
    );
    check("destination can decline", destinationHtml.includes('id="decline-button"'));
    check(
      "how many variants are on offer is shown",
      destinationHtml.includes("3 variants")
    );
    check(
      "an accepted product is not offered again",
      !/class="awaiting-check"[^>]*value="5"/.test(destinationHtml),
      "the already-synced mapping appeared in the waiting list"
    );
    check(
      "the accepted list is headed separately",
      destinationHtml.includes("In your store (1)")
    );

    // Nothing offered: no controls at all, just the list.
    const nothingOffered = await render("products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
      isSource: false,
      awaiting: [],
      products: [],
      connections: [CONN],
    });

    check(
      "with nothing offered there is no accept button",
      !nothingOffered.includes('id="accept-button"')
    );

    // The normal first-run state: an offer arrives before anything has been
    // accepted. The empty screen must not swallow it.
    const firstOffer = await render("products", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
      isSource: false,
      awaiting: [OFFERED],
      products: [],
      connections: [CONN],
    });

    check(
      "a first offer is shown even with nothing accepted yet",
      firstOffer.includes("Waiting for you (1)") &&
        firstOffer.includes('id="accept-button"'),
      "the empty state hid the only thing there was to act on"
    );
    check(
      "and the empty state is not shown alongside it",
      !firstOffer.includes("Nothing synced yet")
    );
    check(
      "and the empty store is explained",
      nothingOffered.includes("Nothing synced yet") ||
        nothingOffered.includes("Nothing accepted yet")
    );
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
