/* The parts of the product sync that decide correctness, tested without a
 * network: retry classification, backoff, price markup, the ProductSetInput
 * that gets written to a destination, and how a variant is matched back.
 *
 * The variant matching is the one worth guarding hardest -- getting it wrong
 * re-points a variant at the wrong row and silently corrupts a merchant's
 * catalogue rather than failing loudly.
 */
require("dotenv").config({ quiet: true });

const path = require("path");
const fs = require("fs");

const SERVER = path.join(__dirname, "..");

const shopify = require(path.join(SERVER, "services/shopify"));
const productSync = require(path.join(SERVER, "services/productSync"));
const { TOPICS } = require(path.join(SERVER, "services/webhooks"));

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

console.log("\nRetry classification");
{
  const { isRetryable, isThrottledBody } = shopify;

  check("429 is retried", isRetryable({ response: { status: 429 } }));
  check("500 is retried", isRetryable({ response: { status: 500 } }));
  check("503 is retried", isRetryable({ response: { status: 503 } }));
  check("a network error with no response is retried", isRetryable({}));
  check("an explicit throttle flag is retried", isRetryable({ throttled: true }));

  // These are bad requests. Retrying them just burns the rate limit.
  check("400 is NOT retried", !isRetryable({ response: { status: 400 } }));
  check("401 is NOT retried", !isRetryable({ response: { status: 401 } }));
  check("404 is NOT retried", !isRetryable({ response: { status: 404 } }));
  check("422 is NOT retried", !isRetryable({ response: { status: 422 } }));

  // GraphQL throttling arrives as HTTP 200 with an error in the body. Missing
  // this would return "no data" as though it had succeeded.
  check(
    "a THROTTLED body is detected",
    isThrottledBody({ errors: [{ extensions: { code: "THROTTLED" } }] })
  );
  check(
    "a throttle worded in the message is detected",
    isThrottledBody({ errors: [{ message: "Throttled: query cost exceeded" }] })
  );
  check("a normal error body is not a throttle",
    !isThrottledBody({ errors: [{ message: "Field does not exist" }] }));
  check("a clean body is not a throttle", !isThrottledBody({ data: {} }));
}

console.log("\nChange subscriptions");
{
  const topics = new Set(TOPICS.map(({ topic }) => topic));

  for (const topic of [
    "INVENTORY_LEVELS_CONNECT",
    "INVENTORY_LEVELS_DISCONNECT",
    "COLLECTIONS_UPDATE",
  ]) {
    check(`${topic} is registered`, topics.has(topic));
  }

  const appConfig = fs.readFileSync(
    path.join(SERVER, "shopify.app.toml"),
    "utf8"
  );

  check(
    "Product Events include nested product and variant changes",
    /topic\s*=\s*["']Product["'][\s\S]*triggers\s*=\s*\[["']product\.\*["']\]/.test(
      appConfig
    )
  );
  check(
    "Product Events deliver to the implemented endpoint",
    /uri\s*=\s*["']\/webhooks\/events\/product["']/.test(appConfig)
  );
}

console.log("\nBackoff");
{
  const { backoffMs } = shopify;

  // Retry-After is authoritative when Shopify sends it.
  const honoured = backoffMs(0, { response: { headers: { "retry-after": "2" } } });
  check("Retry-After is honoured", honoured === 2000, String(honoured));

  const capped = backoffMs(0, { response: { headers: { "retry-after": "600" } } });
  check("an absurd Retry-After is capped", capped <= 16000, String(capped));

  // Full jitter: the value is random, but bounded by the exponential ceiling.
  const ceilings = [500, 1000, 2000, 4000];

  let withinBounds = true;
  let everDiffered = false;
  let previous = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (let i = 0; i < 40; i += 1) {
      const wait = backoffMs(attempt, {});
      if (wait < 0 || wait > ceilings[attempt]) withinBounds = false;
      if (previous !== null && wait !== previous) everDiffered = true;
      previous = wait;
    }
  }

  check("backoff stays inside the exponential ceiling", withinBounds);
  check(
    "backoff is jittered, not fixed",
    everDiffered,
    "identical delays would make every failed call retry in lockstep"
  );
  check("backoff never exceeds the cap", backoffMs(20, {}) <= 16000);
}

console.log("\nPrice markup");
{
  const { withMarkup } = productSync;

  check("no markup leaves the price alone", withMarkup("10.00", 0) === 10);
  check("15% is applied", withMarkup("10.00", 15) === 11.5);
  check("a negative markup cannot discount", withMarkup("10.00", -10) === 10);
  check("rounding stays at 2dp", withMarkup("9.99", 7) === 10.69,
    String(withMarkup("9.99", 7)));
  check("a missing price stays null", withMarkup(null, 15) === null);
  check("a non-numeric price stays null", withMarkup("free", 15) === null);
}

console.log("\nIncluded supplier pricing");
{
  check("shipping and tax are included before destination margin",
    productSync.withIncludedCharges(100, {
      included_shipping_amount: 10,
      included_tax_rate: 18,
      price_markup_percent: 20,
    }) === 153.6);
  check("disabled source charges leave the normal margin formula",
    productSync.withIncludedCharges(100, {
      included_shipping_amount: 0,
      included_tax_rate: null,
      price_markup_percent: 20,
    }) === 120);
}

console.log("\nProductSetInput");
{
  const product = {
    title: "Blue Shirt",
    handle: "blue-shirt",
    vendor: "Acme",
    product_type: "Shirts",
    status: "active",
    product_data: {
      descriptionHtml: "<p>Soft</p>",
      tags: ["summer"],
      seo: {
        title: "Blue shirts for summer",
        description: "Shop soft blue shirts.",
      },
      options: [
        { name: "Size", position: 1, values: ["S", "M"] },
        { name: "Colour", position: 2, values: ["Blue"] },
      ],
    },
  };

  const variants = [
    { shopify_variant_id: "101", sku: "SHIRT-S", price: "20.00", compare_at_price: null, taxable: true, tax_code: "PC040101", requires_shipping: false, inventory_tracked: false, inventory_quantity: 4, weight_value: 0.25, weight_unit: "kg", metafields: [{ namespace: "custom", key: "swatch", type: "color", value: "#0000ff" }], option1: "S", option2: "Blue" },
    { shopify_variant_id: "102", sku: "SHIRT-M", price: "22.00", compare_at_price: "30.00", requires_shipping: true, inventory_tracked: true, inventory_quantity: 7, weight_value: 12, weight_unit: "OUNCES", metafields: [], option1: "M", option2: "Blue" },
  ];

  const input = productSync.buildProductInput(product, variants, {
    price_markup_percent: 10,
  }, null);

  check("title is copied", input.title === "Blue Shirt");
  check("status is upper-cased for GraphQL", input.status === "ACTIVE", input.status);
  check("both options are sent", input.productOptions.length === 2);
  check(
    "option values are objects, as ProductSetInput wants",
    input.productOptions[0].values[0].name === "S"
  );
  check("both variants are sent", input.variants.length === 2);
  check("markup is applied to the variant price", input.variants[0].price === 22);
  check(
    "markup is applied to compareAtPrice too",
    input.variants[1].compareAtPrice === 33,
    String(input.variants[1].compareAtPrice)
  );
  check(
    "a removed compareAtPrice is sent as null so the destination clears it",
    input.variants[0].compareAtPrice === null
  );
  check(
    "requires shipping false is sent instead of being mistaken for missing",
    input.variants[0].inventoryItem.requiresShipping === false
  );
  check(
    "requires shipping true is sent",
    input.variants[1].inventoryItem.requiresShipping === true
  );
  check("tax classification is sent",
    input.variants[0].taxable === true && input.variants[0].taxCode === "PC040101");
  check("inventory tracking false is sent",
    input.variants[0].inventoryItem.tracked === false);
  check("inventory tracking true is sent",
    input.variants[1].inventoryItem.tracked === true);
  check("variant weight and REST units are sent in GraphQL form",
    input.variants[0].inventoryItem.measurement.weight.value === 0.25 &&
      input.variants[0].inventoryItem.measurement.weight.unit === "KILOGRAMS");
  check("variant metafields are sent",
    input.variants[0].metafields[0].key === "swatch");
  check("removed variant metafields clear the destination",
    Array.isArray(input.variants[1].metafields) &&
      input.variants[1].metafields.length === 0);

  const shippingOff = productSync.buildProductInput(
    product,
    variants,
    { variant_requires_shipping: false },
    "777"
  );
  check(
    "the shipping sync setting leaves the destination value alone when off",
    shippingOff.variants[0].inventoryItem.requiresShipping === undefined
  );
  check(
    "option values are paired to their option NAME",
    input.variants[0].optionValues[0].optionName === "Size" &&
      input.variants[0].optionValues[0].name === "S"
  );

  check("the SEO title is copied", input.seo.title === "Blue shirts for summer");
  check("the SEO description is copied",
    input.seo.description === "Shop soft blue shirts.");
  check("the search listing URL handle is copied", input.handle === "blue-shirt");

  // Creating vs updating is decided by the presence of an id.
  check("creating sends no id", input.id === undefined);

  const update = productSync.buildProductInput(product, variants, {}, "777");
  check("updating sends the destination gid",
    update.id === "gid://shopify/Product/777", update.id);

  const inventoryVariants = variants.map((variant) => ({
    ...variant,
    inventory_tracked: true,
  }));
  const locationAwareUpdate = productSync.buildProductInput(
    product,
    inventoryVariants,
    {},
    "777",
    {
      locationId: "gid://shopify/Location/default",
      inventoryLocationIds: new Map([
        ["101", "gid://shopify/Location/one"],
        ["102", "gid://shopify/Location/two"],
      ]),
    }
  );
  check("existing variants use their own stocked inventory locations",
    locationAwareUpdate.variants[0].inventoryQuantities[0].locationId ===
      "gid://shopify/Location/one" &&
    locationAwareUpdate.variants[1].inventoryQuantities[0].locationId ===
      "gid://shopify/Location/two");

  const missingLevelUpdate = productSync.buildProductInput(
    product,
    inventoryVariants,
    {},
    "777",
    { locationId: "gid://shopify/Location/default", inventoryLocationIds: new Map() }
  );
  check("an unstocked existing item skips quantity without failing other fields",
    missingLevelUpdate.variants.every((variant) => variant.inventoryQuantities === undefined) &&
      missingLevelUpdate.variants[0].price === 20);

  const createWithStock = productSync.buildProductInput(
    product,
    inventoryVariants,
    {},
    null,
    { locationId: "gid://shopify/Location/default" }
  );
  check("new variants still start at the destination default location",
    createWithStock.variants[0].inventoryQuantities[0].locationId ===
      "gid://shopify/Location/default");

  const allocatedStock = productSync.buildProductInput(
    product,
    inventoryVariants.map((variant, index) => ({ ...variant, id: index + 1 })),
    {},
    null,
    {
      locationId: "gid://shopify/Location/default",
      allocatedInventory: new Map([[1, 25], [2, 0]]),
    }
  );
  check("a destination receives its reserved quantity instead of source stock",
    allocatedStock.variants[0].inventoryQuantities[0].quantity === 25);
  check("a fully sold allocation syncs as zero, not as missing",
    allocatedStock.variants[1].inventoryQuantities[0].quantity === 0);

  // A product with no options must not send an empty array.
  const plain = productSync.buildProductInput(
    { title: "Sticker", status: "active", product_data: {} },
    [{ sku: "STK", price: "1.00" }],
    {},
    null
  );
  check("a product with no options omits productOptions",
    plain.productOptions === undefined);

  const cleared = productSync.buildProductInput(
    {
      title: "Cleared fields",
      vendor: null,
      product_type: null,
      status: "active",
      product_data: { category: null },
    },
    [{ sku: null, barcode: null, price: "5.00", compare_at_price: null }],
    {},
    "777"
  );
  check("clearing vendor and product type reaches the destination",
    cleared.vendor === "" && cleared.productType === "");
  check("clearing category reaches the destination",
    cleared.category === null);
  check("clearing SKU and barcode reaches the destination",
    cleared.variants[0].sku === null && cleared.variants[0].barcode === null);
}

console.log("\nSource tax sync gate");
{
  const destinationAllowsTaxes = {
    category: true,
    variant_taxable: true,
    variant_price: true,
  };
  const off = productSync.withSourceFeatureGates(
    destinationAllowsTaxes,
    { sync_taxes: false }
  );
  const on = productSync.withSourceFeatureGates(
    destinationAllowsTaxes,
    { sync_taxes: true }
  );
  const destinationBlocksCategory = productSync.withSourceFeatureGates(
    { ...destinationAllowsTaxes, category: false },
    { sync_taxes: true }
  );

  check("source tax sync off blocks category and taxable fields",
    off.category === false && off.variant_taxable === false);
  check("source tax sync on preserves destination tax permissions",
    on.category === true && on.variant_taxable === true);
  check("the source switch cannot override a destination tax-field block",
    destinationBlocksCategory.category === false);
  check("tax gating does not affect unrelated product settings",
    off.variant_price === true);
}

console.log("\nMetafields");
{
  const { splitMetafields } = productSync;

  /* The SEO pair is the whole reason a product synced once and then failed on
   * every re-sync: Shopify keeps title_tag/description_tag itself, so sending
   * them back as metafields collides with what is already there. */
  const seoOnly = splitMetafields([
    { namespace: "global", key: "title_tag", type: "single_line_text_field", value: "Buy Shirts" },
    { namespace: "global", key: "description_tag", type: "single_line_text_field", value: "Soft shirts" },
  ]);

  check("the SEO pair is taken out of metafields",
    seoOnly.metafields.length === 0,
    "leaving them in is what produced 'Key must be unique within this namespace'");
  check("title_tag becomes seo.title", seoOnly.seo.title === "Buy Shirts");
  check("description_tag becomes seo.description",
    seoOnly.seo.description === "Soft shirts");

  // Everything else is a normal metafield and must still go across.
  const mixed = splitMetafields([
    { namespace: "global", key: "title_tag", value: "Buy Shirts" },
    { namespace: "custom", key: "care", type: "single_line_text_field", value: "Machine wash" },
  ]);

  check("ordinary metafields are kept",
    mixed.metafields.length === 1 && mixed.metafields[0].key === "care");
  check("and the SEO one is still split off", mixed.seo.title === "Buy Shirts");

  const withDefinition = splitMetafields([{
    namespace: "custom",
    key: "care",
    type: "multi_line_text_field",
    value: "Wash",
    definition: { name: "Care instructions" },
  }]);
  check("cached definition metadata is not sent to ProductSet",
    withDefinition.metafields[0].definition === undefined);

  const none = splitMetafields([
    { namespace: "custom", key: "care", value: "Machine wash" },
  ]);
  check("no SEO metafields means no seo field",
    none.seo === null,
    "sending seo: {} would blank the destination's own SEO");

  // A metafield is identified by namespace+key. Two entries sharing a pair are
  // refused, and productSet refuses the ENTIRE product with them.
  const duplicated = splitMetafields([
    { namespace: "custom", key: "care", value: "first" },
    { namespace: "custom", key: "care", value: "second" },
    { namespace: "other", key: "care", value: "different namespace" },
  ]);

  check("a duplicated namespace+key is dropped",
    duplicated.metafields.length === 2, String(duplicated.metafields.length));
  check("the first one wins", duplicated.metafields[0].value === "first");
  check("the same key in another namespace is not a duplicate",
    duplicated.metafields[1].namespace === "other");

  check("a malformed metafield is skipped, not thrown on",
    splitMetafields([null, {}, { namespace: "custom" }]).metafields.length === 0);
  check("no metafields at all is fine",
    splitMetafields(undefined).metafields.length === 0);

  /* And the same product pushed twice must build the same input both times --
   * that is the bug, stated as a test. */
  const product = {
    title: "Blue Shirt",
    status: "active",
    product_data: {
      metafields: [
        { namespace: "global", key: "title_tag", value: "Buy Shirts" },
        { namespace: "global", key: "description_tag", value: "Soft shirts" },
      ],
    },
  };
  const variants = [{ sku: "SH", price: "20.00" }];

  const created = productSync.buildProductInput(product, variants, {}, null);
  const repushed = productSync.buildProductInput(product, variants, {}, "777");

  check("a re-push sends no reserved metafields",
    created.metafields.length === 0 && repushed.metafields.length === 0,
    "this is the push that used to be rejected");
  check("the SEO values travel on input.seo instead",
    repushed.seo.title === "Buy Shirts" &&
      repushed.seo.description === "Soft shirts");

  const off = productSync.buildProductInput(
    product,
    variants,
    { metafields: false },
    "777"
  );
  check("switching metafields off also switches off SEO",
    off.seo === undefined && off.handle === undefined &&
      off.metafields === undefined);

  const canonical = productSync.buildProductInput(
    {
      title: "Canonical SEO",
      handle: "canonical-seo",
      status: "active",
      product_data: {
        seo: { title: "Direct title", description: "Direct description" },
        metafields: [
          { namespace: "global", key: "title_tag", value: "Legacy title" },
        ],
      },
    },
    variants,
    {},
    "777"
  );
  check("the dedicated SEO object wins over reserved metafields",
    canonical.seo.title === "Direct title" &&
      canonical.seo.description === "Direct description");
  check("SEO syncing also carries the product handle",
    canonical.handle === "canonical-seo");
}

console.log("\nVariant selection");
{
  const { selectVariants } = productSync;

  const all = [{ id: 1 }, { id: 2 }, { id: 3 }];

  // null and [] mean opposite things and must never be conflated.
  check("null means every variant", selectVariants(all, null).length === 3);
  check("undefined means every variant", selectVariants(all, undefined).length === 3);
  check("an explicit list narrows", selectVariants(all, [2]).length === 1);
  check("the right one is kept", selectVariants(all, [2])[0].id === 2);
  check("an empty list selects nothing",
    selectVariants(all, []).length === 0,
    "an empty selection must not silently mean 'all'");
  check("ids that no longer exist are dropped",
    selectVariants(all, [2, 99]).length === 1);
  check("string ids from a form still match",
    selectVariants(all, ["3"]).length === 1);
}

console.log("\nOptions follow the selected variants");
{
  // productSet DELETES anything omitted, so sending one variant must also send
  // only the option values that variant actually uses -- an option value with
  // no variant behind it is rejected.
  const product = {
    title: "Blue Shirt",
    status: "active",
    product_data: {
      options: [
        { name: "Size", position: 1, values: ["S", "M", "L"] },
        { name: "Colour", position: 2, values: ["Blue", "Red"] },
      ],
      images: [{ url: "https://cdn.example/a.jpg", alt: "Front" }],
    },
  };

  const onlyOne = productSync.buildProductInput(
    product,
    [{ id: 2, sku: "SH-M-BLUE", price: "22.00", option1: "M", option2: "Blue" }],
    {},
    null
  );

  check("one variant is sent", onlyOne.variants.length === 1);
  check("Size carries only the used value",
    onlyOne.productOptions[0].values.length === 1 &&
      onlyOne.productOptions[0].values[0].name === "M",
    JSON.stringify(onlyOne.productOptions[0].values));
  check("Colour carries only the used value",
    onlyOne.productOptions[1].values.length === 1 &&
      onlyOne.productOptions[1].values[0].name === "Blue");

  // An option every remaining variant leaves blank has nothing to describe.
  const noColour = productSync.buildProductInput(
    product,
    [{ id: 1, price: "20.00", option1: "S", option2: null }],
    {},
    null
  );

  check("an option with no values left is dropped",
    noColour.productOptions.length === 1 &&
      noColour.productOptions[0].name === "Size");
  check("positions stay contiguous after a drop",
    noColour.productOptions[0].position === 1);

  // Images.
  check("images are copied by URL",
    onlyOne.files.length === 1 &&
      onlyOne.files[0].originalSource === "https://cdn.example/a.jpg");
  check("image content type is set", onlyOne.files[0].contentType === "IMAGE");
  check("image alt text survives", onlyOne.files[0].alt === "Front");

  const noImages = productSync.buildProductInput(
    { title: "X", status: "active", product_data: { images: [] } },
    [{ id: 1, price: "1.00" }],
    {},
    null
  );

  check("removing every source image clears destination images",
    Array.isArray(noImages.files) && noImages.files.length === 0);

  const imagesOff = productSync.buildProductInput(
    { title: "X", status: "active", product_data: { images: [] } },
    [{ id: 1, price: "1.00" }],
    { images: false },
    "777"
  );
  check("turning image sync off leaves destination images alone",
    imagesOff.files === undefined);
}

console.log("\nFlattening media");
{
  const flat = productSync.flatten({
    id: "gid://shopify/Product/1",
    title: "T",
    featuredMedia: { preview: { image: { url: "https://cdn.example/hero.jpg" } } },
    media: {
      nodes: [
        { alt: "Front", image: { url: "https://cdn.example/a.jpg" } },
        { alt: null, image: { url: "https://cdn.example/b.jpg" } },
        // A video has no `image`; it must not become a broken entry.
        {},
      ],
    },
    variants: { nodes: [] },
  });

  check("the featured image becomes the thumbnail",
    flat.image === "https://cdn.example/hero.jpg");
  check("all images are collected", flat.images.length === 2);
  check("non-image media is dropped",
    !flat.images.some((image) => !image.url));
  check("alt text is carried", flat.images[0].alt === "Front");

  // No featuredMedia: fall back to the first real image rather than nothing.
  const noFeatured = productSync.flatten({
    id: "gid://shopify/Product/2",
    title: "T",
    media: { nodes: [{ image: { url: "https://cdn.example/only.jpg" } }] },
    variants: { nodes: [] },
  });

  check("the thumbnail falls back to the first image",
    noFeatured.image === "https://cdn.example/only.jpg");

  const noMedia = productSync.flatten({
    id: "gid://shopify/Product/3",
    title: "T",
    variants: { nodes: [] },
  });

  check("a product with no media has no thumbnail", noMedia.image === null);
  check("a product with no media has an empty image list",
    Array.isArray(noMedia.images) && noMedia.images.length === 0);
}

console.log("\nWebhook payload -> cache shape");
{
  // A products/update webhook is REST-shaped, while the reads are GraphQL.
  // Both have to land on ONE shape or the push builds the wrong payload.
  const mapped = productSync.fromWebhook({
    id: 900,
    title: "Webhook Shirt",
    handle: "webhook-shirt",
    vendor: "Acme",
    product_type: "Shirts",
    status: "active",
    body_html: "<p>Soft</p>",
    tags: "summer, cotton",
    updated_at: "2026-08-27T10:00:00Z",
    image: { src: "https://cdn.example/hero.jpg" },
    images: [
      { src: "https://cdn.example/a.jpg", alt: "Front" },
      { src: "https://cdn.example/b.jpg", alt: null },
      { src: null }, // never becomes a broken entry
    ],
    options: [{ name: "Size", position: 1, values: ["S", "M"] }],
    variants: [
      {
        id: 9001,
        title: "S",
        sku: "WS-S",
        price: "20.00",
        compare_at_price: null,
        position: 1,
        inventory_quantity: 4,
        inventory_item_id: 7001,
        requires_shipping: false,
        inventory_management: "shopify",
        weight: 0.5,
        weight_unit: "kg",
        option1: "S",
      },
    ],
  });

  check("ids become strings", mapped.id === "900" && mapped.variants[0].id === "9001");
  check("product_type carries over", mapped.product_type === "Shirts");
  check("body_html becomes descriptionHtml",
    mapped.descriptionHtml === "<p>Soft</p>");
  check("a comma-separated tag string becomes a list",
    Array.isArray(mapped.tags) && mapped.tags.length === 2 &&
      mapped.tags[1] === "cotton",
    JSON.stringify(mapped.tags));
  check("images[].src becomes images[].url",
    mapped.images.length === 2 &&
      mapped.images[0].url === "https://cdn.example/a.jpg",
    JSON.stringify(mapped.images));
  check("an image with no src is dropped",
    !mapped.images.some((image) => !image.url));
  check("the featured image becomes the thumbnail",
    mapped.image === "https://cdn.example/hero.jpg");
  check("option values stay a plain list",
    mapped.options[0].values[0] === "S");
  check("variant option columns survive", mapped.variants[0].option1 === "S");
  check("the inventory item id becomes a string",
    mapped.variants[0].inventory_item_id === "7001");
  check("the webhook keeps requires_shipping=false",
    mapped.variants[0].requires_shipping === false);
  check("the webhook maps inventory tracking",
    mapped.variants[0].inventory_tracked === true);
  check("the webhook maps weight and unit",
    mapped.variants[0].weight_value === 0.5 &&
      mapped.variants[0].weight_unit === "KILOGRAMS");

  // The webhook shape must build the same input the GraphQL shape does.
  const input = productSync.buildProductInput(
    { title: mapped.title, status: mapped.status, product_data: mapped },
    [{ id: 1, sku: "WS-S", price: "20.00", option1: "S" }],
    {},
    null
  );

  check("a webhook-sourced product still carries its images",
    input.files.length === 2, String(input.files && input.files.length));
  check("and still builds its options",
    input.productOptions.length === 1 &&
      input.productOptions[0].values[0].name === "S");

  // Tags already an array (some payloads) must pass straight through.
  const arrayTags = productSync.fromWebhook({ id: 1, tags: ["a", "b"] });
  check("an array of tags is left alone",
    Array.isArray(arrayTags.tags) && arrayTags.tags.length === 2);

  const noTags = productSync.fromWebhook({ id: 1 });
  check("a payload with no tags does not crash", noTags.tags === undefined);
  check("a payload with no images gives an empty list",
    Array.isArray(noTags.images) && noTags.images.length === 0);
  check("a payload with no variants gives an empty list",
    Array.isArray(noTags.variants) && noTags.variants.length === 0);
}

console.log("\nVariant matching");
{
  const { optionKey } = productSync;

  check("option values key together",
    optionKey(["S", "Blue"]) === "s / blue", optionKey(["S", "Blue"]));
  check("empty option slots are dropped",
    optionKey(["S", null, ""]) === "s", optionKey(["S", null, ""]));
  check("case and padding do not matter",
    optionKey([" s ", "BLUE"]) === optionKey(["S", "blue"]));
  check("different variants get different keys",
    optionKey(["S", "Blue"]) !== optionKey(["M", "Blue"]));
}

console.log("\nGraphQL id handling");
{
  const { numericId, flatten } = productSync;

  check("a product gid becomes a number",
    numericId("gid://shopify/Product/123") === "123");
  check("a variant gid becomes a number",
    numericId("gid://shopify/ProductVariant/456") === "456");
  check("null is tolerated", numericId(null) === null);
  check("an already-numeric id passes through", numericId("789") === "789");

  const flat = flatten({
    id: "gid://shopify/Product/1",
    title: "T",
    handle: "seo-product",
    productType: "Tees",
    seo: { title: "SEO title", description: "SEO description" },
    updatedAt: "2026-08-27T10:00:00Z",
    options: [{ name: "Size", position: 1, optionValues: [{ name: "S" }] }],
    variants: {
      nodes: [
        {
          id: "gid://shopify/ProductVariant/9",
          sku: "A",
          price: "5.00",
          inventoryItem: {
            id: "gid://shopify/InventoryItem/77",
            requiresShipping: false,
            tracked: true,
            measurement: { weight: { value: 250, unit: "GRAMS" } },
          },
          metafields: {
            nodes: [
              {
                namespace: "custom",
                key: "bin",
                type: "single_line_text_field",
                value: "A1",
                definition: {
                  name: "Warehouse bin",
                  description: "Picking location",
                  validations: [{ name: "max", value: "20" }],
                },
              },
            ],
          },
          selectedOptions: [{ name: "Size", value: "S" }],
        },
      ],
    },
  });

  check("GraphQL productType maps to product_type", flat.product_type === "Tees");
  check("GraphQL SEO is flattened",
    flat.seo.title === "SEO title" && flat.seo.description === "SEO description");
  check("nested gids are flattened", flat.variants[0].id === "9");
  check("the inventory item id is kept",
    flat.variants[0].inventory_item_id === "77");
  check("GraphQL requiresShipping is flattened",
    flat.variants[0].requires_shipping === false);
  check("GraphQL inventory tracking is flattened",
    flat.variants[0].inventory_tracked === true);
  check("GraphQL weight is flattened",
    flat.variants[0].weight_value === 250 &&
      flat.variants[0].weight_unit === "GRAMS");
  check("GraphQL variant metafields are flattened",
    flat.variants[0].metafields[0].key === "bin");
  check("metafield definition metadata is cached",
    flat.variants[0].metafields[0].definition.name === "Warehouse bin" &&
      flat.variants[0].metafields[0].definition.validations[0].name === "max");
  check("option values are flattened", flat.options[0].values[0] === "S");
  check("a variant with no position gets one", flat.variants[0].position === 1);
}

/* ------------------------------------------------------------------ */
/* Publishing to the storefront                                        */
/* ------------------------------------------------------------------ */
/*
 * productSet creates a product attached to NO sales channel, so an ACTIVE
 * product with stock still does not appear in the online store. This is the
 * step that makes it visible, and its absence is why synced products were
 * invisible on the storefront.
 */
console.log("\nPublishing to the online store");
{
  const { publishToOnlineStore } = productSync;

  // Everything reaches Shopify through shopify.forShop, so swapping that out
  // is enough to drive this without touching a real store.
  const realForShop = shopify.forShop;
  const calls = [];

  function fakeShopify(handler) {
    shopify.forShop = async (shop, body) => {
      calls.push({ shop, body });
      return handler(shop, body);
    };
  }

  (async () => {
    console.log("\nMetafield definitions");

    const sourceMetafields = [
      {
        namespace: "custom",
        key: "care",
        type: "multi_line_text_field",
        value: "Hand wash",
        definition: {
          name: "Care instructions",
          description: "How to care for the product",
          validations: [],
        },
      },
      // SEO has its own ProductSet field and must not become a definition.
      { namespace: "global", key: "title_tag", type: "string", value: "Buy" },
    ];
    const sourceVariants = [
      {
        metafields: [
          {
            namespace: "custom",
            key: "bin",
            type: "single_line_text_field",
            value: "A1",
          },
        ],
      },
    ];
    const wantedDefinitions = productSync.definitionsForMetafields(
      sourceMetafields,
      sourceVariants
    );

    check("product and variant definitions are collected",
      wantedDefinitions.length === 2);
    check("SEO does not become a custom definition",
      !wantedDefinitions.some((definition) => definition.namespace === "global"));
    check("source definition names are retained",
      wantedDefinitions.find((definition) => definition.key === "care").name ===
        "Care instructions");
    check("unstructured fields get a readable fallback name",
      wantedDefinitions.find((definition) => definition.key === "bin").name ===
        "Bin");

    calls.length = 0;
    fakeShopify((shop, body) => {
      if (body.query.includes("query MetafieldDefinitionsForSync")) {
        return { products: { nodes: [] }, variants: { nodes: [] } };
      }
      if (body.query.includes("CreateMetafieldDefinition")) {
        return {
          metafieldDefinitionCreate: {
            createdDefinition: body.variables.definition,
            userErrors: [],
          },
        };
      }
      throw new Error("Unexpected definition test query");
    });

    const definitionResult = await productSync.syncMetafieldDefinitions(
      "definitions.myshopify.com",
      sourceMetafields,
      sourceVariants
    );
    const creates = calls.filter((call) =>
      call.body.query.includes("CreateMetafieldDefinition")
    );

    check("missing destination definitions are created",
      definitionResult.created === 2 && creates.length === 2);
    check("new definitions are pinned",
      creates.every((call) => call.body.variables.definition.pin === true));
    check("variant definitions use PRODUCTVARIANT",
      creates.some((call) =>
        call.body.variables.definition.ownerType === "PRODUCTVARIANT" &&
        call.body.variables.definition.key === "bin"));

    calls.length = 0;
    fakeShopify((shop, body) => {
      if (body.query.includes("query MetafieldDefinitionsForSync")) {
        return {
          products: {
            nodes: [{
              namespace: "custom",
              key: "care",
              name: "Old label",
              description: null,
              type: { name: "multi_line_text_field" },
              validations: [],
            }],
          },
          variants: { nodes: [] },
        };
      }
      if (body.query.includes("UpdateMetafieldDefinition")) {
        return {
          metafieldDefinitionUpdate: {
            updatedDefinition: body.variables.definition,
            userErrors: [],
          },
        };
      }
      throw new Error("Unexpected definition update query");
    });

    const updated = await productSync.syncMetafieldDefinitions(
      "definitions.myshopify.com",
      sourceMetafields,
      []
    );

    check("compatible definition metadata is updated", updated.updated === 1);
    check("an existing definition is not recreated",
      !calls.some((call) => call.body.query.includes("CreateMetafieldDefinition")));

    /* ---- the happy path ---- */
    calls.length = 0;
    fakeShopify((shop, body) => {
      if (body.query.includes("publications(first")) {
        return {
          publications: {
            nodes: [
              { id: "gid://shopify/Publication/1", name: "Point of Sale" },
              { id: "gid://shopify/Publication/2", name: "Online Store" },
            ],
          },
        };
      }
      return { publishablePublish: { userErrors: [] } };
    });

    const ok = await publishToOnlineStore(
      "pub-a.myshopify.com",
      "gid://shopify/Product/500"
    );

    check("a new product is published", ok.published === true);

    const publish = calls.find((c) => c.body.query.includes("publishablePublish"));

    check("to the Online Store channel, not the first one listed",
      publish.body.variables.input[0].publicationId ===
        "gid://shopify/Publication/2",
      "Point of Sale is a sales channel too, and publishing there shows nothing");
    check("and it names the product",
      publish.body.variables.id === "gid://shopify/Product/500");

    /* ---- the channel id is cached per shop ---- */
    calls.length = 0;
    await publishToOnlineStore("pub-a.myshopify.com", "gid://shopify/Product/501");

    check("the channel is looked up once per shop",
      calls.filter((c) => c.body.query.includes("publications(first")).length === 0,
      "otherwise every single product push costs an extra API call");

    /* ---- a store with no storefront ---- */
    fakeShopify(() => ({
      publications: {
        nodes: [{ id: "gid://shopify/Publication/9", name: "Point of Sale" }],
      },
    }));

    const none = await publishToOnlineStore(
      "pub-b.myshopify.com",
      "gid://shopify/Product/600"
    );

    check("a POS-only store is not an error",
      none.published === false && none.reason === "no online store",
      "a store with no online storefront is a real thing");

    /* ---- a failure must not take the whole push down ---- */
    fakeShopify((shop, body) => {
      if (body.query.includes("publications(first")) {
        return {
          publications: {
            nodes: [{ id: "gid://shopify/Publication/3", name: "Online Store" }],
          },
        };
      }
      return {
        publishablePublish: {
          userErrors: [{ field: ["id"], message: "Product is not publishable" }],
        },
      };
    });

    const refused = await publishToOnlineStore(
      "pub-c.myshopify.com",
      "gid://shopify/Product/700"
    );

    check("a refusal is reported, not thrown",
      refused.published === false &&
        refused.reason === "Product is not publishable",
      "the product itself synced fine; only the storefront listing failed");

    fakeShopify(() => {
      throw new Error("403 Forbidden");
    });

    const denied = await publishToOnlineStore(
      "pub-d.myshopify.com",
      "gid://shopify/Product/800"
    );

    check("and so is a missing scope",
      denied.published === false,
      "without write_publications this is exactly what comes back");

    shopify.forShop = realForShop;

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  })();
}
