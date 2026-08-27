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

    // Destination: shows a code, never an input to type one into.
    const withCode = await render("stores", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
      isDestination: true,
      connections: [CONNECTION],
      pairingCode: { code: "ABCD-2345", expiresAt: new Date("2026-01-01T10:30:00Z") },
      codeTtlMinutes: 15,
    });

    check("destination shows its code", withCode.includes("ABCD-2345"));
    check(
      "destination has no code input",
      !withCode.includes('id="connect-code"'),
      "a destination could redeem a code, which the server refuses"
    );
    check("destination lists the source store", withCode.includes("src.myshopify.com"));
    check("destination shows the expiry", withCode.includes("10:30"));

    // No code yet: the box is hidden rather than showing an empty slot.
    const noCode = await render("stores", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "destination" },
      isDestination: true,
      connections: [],
      pairingCode: null,
      codeTtlMinutes: 15,
    });

    check(
      "destination without a code hides the code box",
      /<div class="code" id="code-box" hidden>/.test(noCode)
    );
    check("destination offers to generate one", noCode.includes("Generate a code"));
    check("empty list is explained", noCode.includes("No source store is connected"));

    // Source: types a code in, never shows one.
    const sourceHtml = await render("stores", {
      ...BASE,
      store: { ...STORE_ROW, store_type: "source" },
      isDestination: false,
      connections: [CONNECTION],
      pairingCode: null,
      codeTtlMinutes: 15,
    });

    check("source has a code input", sourceHtml.includes('id="connect-code"'));
    check(
      "source is not offered a code to hand out",
      !sourceHtml.includes('id="code-box"'),
      "both stores would be showing codes"
    );
    check(
      "source lists the destination store",
      sourceHtml.includes("dst.myshopify.com")
    );
    check(
      "a store with no name falls back to its domain",
      !sourceHtml.includes(">null<"),
      "a missing store_name printed as null"
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
