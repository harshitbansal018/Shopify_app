const path = require("path");
const ejs = require("ejs");

const SERVER = path.join(__dirname, "..");
const policyModel = require(path.join(SERVER, "models/shippingPolicyModel"));
const sourceSettingsModel = require(path.join(SERVER, "models/sourceConnectionSettingsModel"));
const shippingSync = require(path.join(SERVER, "services/shippingSync"));
const orderSync = require(path.join(SERVER, "services/orderSync"));
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

console.log("\nOrder shipping accounting");
{
  check("included shipping is recorded once per shippable unit",
    orderSync.shippingChargeForPolicy(
      { mode: "flat", flat_rate: 80 },
      [{ requires_shipping: 1 }, { requires_shipping: 1 }]
    ) === 160);
  check("included-price mode records the supplier amount, not a checkout charge",
    orderSync.shippingChargeForPolicy(
      { mode: "included", flat_rate: 80 },
      [{ requires_shipping: 1 }]
    ) === 80);
  check("digital-only orders do not earn a shipping charge",
    orderSync.shippingChargeForPolicy(
      { mode: "flat", flat_rate: 80 },
      [{ requires_shipping: 0 }]
    ) === 0);
  check("enabled supplier tax is calculated on the supplier product subtotal",
    orderSync.supplierTaxForSettings(
      { sync_taxes: true, tax_rate_percent: 18 }, 100
    ) === 18);
  check("supplier tax remains off when its checkbox is off",
    orderSync.supplierTaxForSettings(
      { sync_taxes: false, tax_rate_percent: 18 }, 100
    ) === null);
  check("a valid zero percent rate is retained as zero tax",
    orderSync.supplierTaxForSettings(
      { sync_taxes: true, tax_rate_percent: 0 }, 100
    ) === 0);
}

console.log("\nSupplier tax settings");
{
  const hydrated = sourceSettingsModel.hydrate({
    connection_id: 7,
    sync_taxes: 1,
    tax_rate_percent: "18.2500",
  });
  check("stored supplier tax percentage is hydrated as a number",
    hydrated.sync_taxes === true && hydrated.tax_rate_percent === 18.25);
  check("supplier tax defaults off with no percentage",
    sourceSettingsModel.defaults(7).sync_taxes === false &&
      sourceSettingsModel.defaults(7).tax_rate_percent === null);
}

function rejects(fn, pattern) {
  try { fn(); return false; } catch (error) { return pattern.test(error.message); }
}

console.log("\nShipping policy validation");
{
  const flat = policyModel.normalize({
    mode: "flat",
    service_name: " Supplier standard ",
    flat_rate: "80.129",
    country_codes: "in, US, in",
    delivery_min_days: "4",
    delivery_max_days: "6",
  }, { currency: "inr" });

  check("flat price is money-rounded", flat.flat_rate === 80.13);
  check("destination currency wins", flat.currency === "INR");
  check("country codes are normalized and deduplicated",
    JSON.stringify(flat.country_codes) === '["IN","US"]');
  check("delivery estimate is normalized",
    flat.delivery_min_days === 4 && flat.delivery_max_days === 6);
  check("included shipping retains the per-unit amount for product pricing",
    policyModel.normalize({ mode: "included", country_codes: "IN", flat_rate: 99 }).flat_rate === 99);
  check("an active policy needs a country",
    rejects(() => policyModel.normalize({ mode: "flat", flat_rate: 10 }), /country/i));
  check("invalid country codes are refused",
    rejects(() => policyModel.normalize({ mode: "flat", flat_rate: 10, country_codes: "IND" }), /two-letter/i));
  check("negative rates are refused",
    rejects(() => policyModel.normalize({ mode: "flat", flat_rate: -1, country_codes: "IN" }), /0 or greater/i));
  check("an inverted delivery range is refused",
    rejects(() => policyModel.normalize({ mode: "included", flat_rate: 0, country_codes: "IN", delivery_min_days: 8, delivery_max_days: 4 }), /minimum/i));
}

console.log("\nShopify delivery profile input");
{
  const connection = {
    source: { store_name: "Supplier A", shop_domain: "supplier.myshopify.com" },
  };
  const base = {
    service_name: "Standard",
    flat_rate: 80,
    currency: "INR",
    country_codes: ["IN", "US"],
  };
  const flat = shippingSync.profileInput(
    connection, { ...base, mode: "flat" },
    ["gid://shopify/Location/1", "gid://shopify/Location/2"], ["10", "11"]
  );
  const included = shippingSync.profileInput(
    connection, { ...base, mode: "included" },
    ["gid://shopify/Location/1"], ["10"]
  );
  const method = flat.locationGroupsToCreate[0].zonesToCreate[0].methodDefinitionsToCreate[0];

  check("profile is named for its source", flat.name.includes("Supplier A"));
  check("replacement profiles get unique names",
    flat.name !== included.name && /\[link-[0-9a-f]{8}\]$/.test(flat.name));
  check("destination variants are assigned to the profile",
    flat.variantsToAssociate[1] === "gid://shopify/ProductVariant/11");
  check("every destination fulfillment location is assigned",
    flat.locationGroupsToCreate[0].locationsToAdd.join(",") ===
      "gid://shopify/Location/1,gid://shopify/Location/2");
  check("active source shipping always exposes a free checkout rate",
    method.rateDefinition.price.amount === 0 && method.rateDefinition.price.currencyCode === "INR");
  check("included mode sends free checkout shipping",
    included.locationGroupsToCreate[0].zonesToCreate[0]
      .methodDefinitionsToCreate[0].rateDefinition.price.amount === 0);
  check("only configured countries enter the zone",
    flat.locationGroupsToCreate[0].zonesToCreate[0].countries.map((item) => item.code).join(",") === "IN,US");
  check("country-wide zones include every Shopify province",
    flat.locationGroupsToCreate[0].zonesToCreate[0].countries
      .every((item) => item.includeAllProvinces === true));
  check("location lookup uses the delivery-profile-specific query",
    shippingSync.LOCATION_QUERY.includes("locationsAvailableForDeliveryProfilesConnection"));
  check("location lookup requests only the id",
    !shippingSync.LOCATION_QUERY.includes("name"));
}

console.log("\nSource shipping screen");
(async () => {
  try {
    const store = { id: 1, store_type: "source", store_name: "Supplier" };
    const connection = {
      id: 7,
      status: "active",
      destination: { store_name: "Retail", shop_domain: "retail.myshopify.com", currency: "INR" },
    };
    const html = await ejs.renderFile(path.join(SERVER, "views/source/shipping.ejs"), {
      json: serializeForScript,
      shopifyAdminUrl,
      shop: "supplier.myshopify.com",
      apiKey: "test",
      store,
      connections: [connection],
      current: connection,
      policy: {
        mode: "flat", service_name: "Standard", flat_rate: 80,
        country_codes: ["IN"], delivery_min_days: 4, delivery_max_days: 6,
        sync_status: "synced", sync_error: null,
      },
      sourceSettings: { sync_taxes: true, tax_rate_percent: 18 },
    });
    check("screen explains included shipping", html.includes("added per product unit"));
    check("screen uses destination currency", html.includes("Shipping amount per product (INR)"));
    check("shipping lives under Settings", html.includes("<h1>Settings</h1>") &&
      html.includes('action="/settings"') && html.includes('window.appFetch("/settings"'));
    check("a checkbox controls whether source shipping is active",
      /name="shipping_enabled"[^>]*checked/.test(html) &&
        html.includes('enabled.checked ? "included" : "disabled"'));
    check("source navigation exposes Settings, not a separate Shipping page",
      html.includes('href="/settings"') && !html.includes('href="/shipping"'));
    check("included tax has its own source-controlled checkbox",
      /<input[^>]*name="sync_taxes"[^>]*checked/.test(html) &&
        html.includes("Include source tax in product price") &&
        html.includes("prevent a second checkout tax") &&
        html.includes("syncTaxes.checked"));
    check("tax-off copy gives control back to the destination",
      html.includes("destination can configure tax in Shopify itself"));
    check("tax checkbox reveals a required supplier percentage input",
      /name="tax_rate_percent"[\s\S]{0,300}value="18"/.test(html) &&
        html.includes("showTaxRate") && html.includes("between 0 and 100"));

    const disabledHtml = await ejs.renderFile(path.join(SERVER, "views/source/shipping.ejs"), {
      json: serializeForScript,
      shopifyAdminUrl,
      shop: "supplier.myshopify.com",
      apiKey: "test",
      store,
      connections: [connection],
      current: connection,
      policy: {
        mode: "disabled", service_name: "Standard", flat_rate: 0,
        country_codes: [], delivery_min_days: null, delivery_max_days: null,
        sync_status: "inactive", sync_error: null,
      },
      sourceSettings: { sync_taxes: false, tax_rate_percent: null },
    });
    check("disabled shipping renders with the feature checkbox off",
      !/<input[^>]*name="shipping_enabled"[^>]*checked/.test(disabledHtml));
    check("tax sync defaults off until the source opts in",
      !/<input[^>]*name="sync_taxes"[^>]*checked/.test(disabledHtml));
  } catch (error) {
    check("shipping screen renders", false, error.message);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
