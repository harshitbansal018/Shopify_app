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

const SERVER = path.join(__dirname, "..");

const shopify = require(path.join(SERVER, "services/shopify"));
const productSync = require(path.join(SERVER, "services/productSync"));

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
  check("a negative markup discounts", withMarkup("10.00", -10) === 9);
  check("rounding stays at 2dp", withMarkup("9.99", 7) === 10.69,
    String(withMarkup("9.99", 7)));
  check("a missing price stays null", withMarkup(null, 15) === null);
  check("a non-numeric price stays null", withMarkup("free", 15) === null);
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
      options: [
        { name: "Size", position: 1, values: ["S", "M"] },
        { name: "Colour", position: 2, values: ["Blue"] },
      ],
    },
  };

  const variants = [
    { sku: "SHIRT-S", price: "20.00", compare_at_price: null, option1: "S", option2: "Blue" },
    { sku: "SHIRT-M", price: "22.00", compare_at_price: "30.00", option1: "M", option2: "Blue" },
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
    "a variant with no compareAtPrice omits it",
    input.variants[0].compareAtPrice === undefined
  );
  check(
    "option values are paired to their option NAME",
    input.variants[0].optionValues[0].optionName === "Size" &&
      input.variants[0].optionValues[0].name === "S"
  );

  // The handle must NOT be copied: it is unique per store, and "blue-shirt"
  // very likely already exists on the destination.
  check(
    "the handle is NOT copied",
    input.handle === undefined,
    "a handle collision would fail the whole product"
  );

  // Creating vs updating is decided by the presence of an id.
  check("creating sends no id", input.id === undefined);

  const update = productSync.buildProductInput(product, variants, {}, "777");
  check("updating sends the destination gid",
    update.id === "gid://shopify/Product/777", update.id);

  // A product with no options must not send an empty array.
  const plain = productSync.buildProductInput(
    { title: "Sticker", status: "active", product_data: {} },
    [{ sku: "STK", price: "1.00" }],
    {},
    null
  );
  check("a product with no options omits productOptions",
    plain.productOptions === undefined);
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
    { title: "X", status: "active", product_data: {} },
    [{ id: 1, price: "1.00" }],
    {},
    null
  );

  check("a product with no images omits files",
    noImages.files === undefined,
    "an empty files array would delete the destination's images");
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
    productType: "Tees",
    updatedAt: "2026-08-27T10:00:00Z",
    options: [{ name: "Size", position: 1, optionValues: [{ name: "S" }] }],
    variants: {
      nodes: [
        {
          id: "gid://shopify/ProductVariant/9",
          sku: "A",
          price: "5.00",
          inventoryItem: { id: "gid://shopify/InventoryItem/77" },
          selectedOptions: [{ name: "Size", value: "S" }],
        },
      ],
    },
  });

  check("GraphQL productType maps to product_type", flat.product_type === "Tees");
  check("nested gids are flattened", flat.variants[0].id === "9");
  check("the inventory item id is kept",
    flat.variants[0].inventory_item_id === "77");
  check("option values are flattened", flat.options[0].values[0] === "S");
  check("a variant with no position gets one", flat.variants[0].position === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
