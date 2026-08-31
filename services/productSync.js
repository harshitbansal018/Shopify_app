// services/productSync.js
//
// The two directions of the product flow:
//
//   importProducts()   copy chosen products into source_products (the table)
//   pushPending()      write allowed products onto every connected destination
//
// Nothing here talks to Shopify directly -- everything goes through
// services/shopify.js, which owns retries and token refresh.
const shopify = require("./shopify");
const sourceProductModel = require("../models/sourceProductModel");
const sourceVariantModel = require("../models/sourceVariantModel");
const productMappingModel = require("../models/productMappingModel");
const mappingVariantProductModel = require("../models/mappingVariantProductModel");
const connectionModel = require("../models/connectionModel");

/* ------------------------------------------------------------------ */
/* Reading the source catalogue                                        */
/* ------------------------------------------------------------------ */

/** Shopify gids are "gid://shopify/Product/123"; our columns hold the number. */
function numericId(gid) {
  const match = String(gid || "").match(/(\d+)\s*$/);
  return match ? match[1] : null;
}

/**
 * Flatten one GraphQL product into the shape the models expect, which is the
 * REST-ish shape (`id`, `product_type`, `variants[]`, `option1..3`).
 */
function flatten(node) {
  const options = (node.options || []).map((option) => ({
    name: option.name,
    position: option.position,
    values: (option.optionValues || []).map((value) => value.name),
  }));

  const variants = (node.variants?.nodes || []).map((variant, index) => ({
    id: numericId(variant.id),
    title: variant.title,
    sku: variant.sku,
    price: variant.price,
    compare_at_price: variant.compareAtPrice,
    position: variant.position ?? index + 1,
    inventory_quantity: variant.inventoryQuantity,
    inventory_item_id: numericId(variant.inventoryItem?.id),
    selectedOptions: variant.selectedOptions || [],
  }));

  // Only MediaImage nodes carry an image; a video or 3D model comes back as
  // an empty object from the inline fragment and is dropped here.
  const images = (node.media?.nodes || [])
    .filter((media) => media && media.image && media.image.url)
    .map((media) => ({ url: media.image.url, alt: media.alt || null }));

  const featured = node.featuredMedia?.preview?.image?.url || null;

  return {
    id: numericId(node.id),
    title: node.title,
    handle: node.handle,
    vendor: node.vendor,
    product_type: node.productType,
    status: node.status,
    descriptionHtml: node.descriptionHtml,
    tags: node.tags,
    updated_at: node.updatedAt,
    total_inventory: node.totalInventory,
    // The thumbnail for our own tables.
    image: featured || (images[0] ? images[0].url : null),
    // Everything, for copying onto the destination.
    images,
    options,
    variants,
  };
}

/**
 * Copy the chosen products into source_products, so they appear in the table.
 *
 * Fetched by id rather than trusting what the browser posted back: the client
 * sends ids, and everything else comes from Shopify.
 */
const PRODUCTS_BY_ID_QUERY = `
  query ProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id title handle vendor productType status descriptionHtml tags
        updatedAt totalInventory
        featuredMedia { preview { image { url } } }
        media(first: 10) {
          nodes {
            ... on MediaImage {
              alt
              image { url }
            }
          }
        }
        options { name position optionValues { name } }
        variants(first: 100) {
          nodes {
            id title sku price compareAtPrice position
            inventoryQuantity
            inventoryItem { id }
            selectedOptions { name value }
          }
        }
      }
    }
  }
`;

async function importProducts(shop, storeId, shopifyProductIds) {
  const ids = [...new Set((shopifyProductIds || []).map(String).filter(Boolean))];

  if (!ids.length) return { imported: 0, requeued: 0, products: [] };

  const imported = [];
  let requeued = 0;

  // Chunked: a single nodes() call with hundreds of ids exceeds the query cost.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).map((id) => `gid://shopify/Product/${id}`);

    const data = await shopify.forShop(shop, {
      query: PRODUCTS_BY_ID_QUERY,
      variables: { ids: chunk },
    });

    // A deleted product comes back as null rather than an error.
    const found = (data.nodes || []).filter(Boolean).map(flatten);

    // What Shopify said last time, BEFORE the upsert overwrites it. The
    // picker reopens pre-ticked, so confirming it re-imports every staged
    // product -- without this, adding one product would re-push the lot.
    const seenBefore = new Map();

    for (const product of found) {
      const cached = await sourceProductModel.findByShopifyId(storeId, product.id);
      seenBefore.set(
        String(product.id),
        cached && cached.shopify_updated_at
          ? new Date(cached.shopify_updated_at).getTime()
          : null
      );
    }

    await sourceProductModel.upsertMany(storeId, found);

    for (const product of found) {
      const cached = await sourceProductModel.findByShopifyId(storeId, product.id);

      if (!cached) continue;

      const was = seenBefore.get(String(product.id));
      const now = cached.shopify_updated_at
        ? new Date(cached.shopify_updated_at).getTime()
        : null;

      // Unchanged since the last import: the destination already has this.
      // (A change to what WE cache rather than to the product itself is not
      // caught here -- that needs a deliberate re-push.)
      if (was !== null && was === now) continue;

      requeued += await productMappingModel.requeueForSourceProduct(cached.id);
    }

    imported.push(...found);
  }

  return { imported: imported.length, requeued, products: imported };
}

/* ------------------------------------------------------------------ */
/* Reacting to a change at the source                                  */
/* ------------------------------------------------------------------ */

/**
 * Map a products/update WEBHOOK payload onto the same shape flatten() builds.
 *
 * Webhooks arrive in the REST shape (`product_type`, `variants[].option1`,
 * `images[].src`) while the GraphQL reads use camelCase and nested nodes. Both
 * end up here so the rest of the app only ever sees one shape.
 */
function fromWebhook(payload) {
  const images = (payload.images || [])
    .filter((image) => image && image.src)
    .map((image) => ({ url: image.src, alt: image.alt || null }));

  return {
    id: String(payload.id),
    title: payload.title,
    handle: payload.handle,
    vendor: payload.vendor,
    product_type: payload.product_type,
    status: payload.status,
    descriptionHtml: payload.body_html || "",
    tags:
      typeof payload.tags === "string"
        ? payload.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
        : payload.tags,
    updated_at: payload.updated_at,
    image: payload.image?.src || (images[0] ? images[0].url : null),
    images,
    options: (payload.options || []).map((option) => ({
      name: option.name,
      position: option.position,
      values: option.values || [],
    })),
    variants: (payload.variants || []).map((variant, index) => ({
      id: String(variant.id),
      title: variant.title,
      sku: variant.sku,
      price: variant.price,
      compare_at_price: variant.compare_at_price,
      position: variant.position ?? index + 1,
      inventory_quantity: variant.inventory_quantity,
      inventory_item_id: variant.inventory_item_id
        ? String(variant.inventory_item_id)
        : null,
      option1: variant.option1,
      option2: variant.option2,
      option3: variant.option3,
    })),
  };
}

/**
 * A product changed at the source. Refresh the cache and queue the push.
 *
 * Deliberately makes NO Shopify call: the webhook payload already carries the
 * whole product, and calling out from inside a webhook is what turns a slow
 * API into Shopify retrying and eventually unsubscribing the topic.
 *
 * Returns null when this store does not cache the product, which is the normal
 * case -- a source store fires this for every product it has, not only the ones
 * shared through the app.
 */
async function applySourceUpdate(storeId, payload) {
  const product = fromWebhook(payload);

  const known = await sourceProductModel.findByShopifyId(storeId, product.id);

  // Not staged in the app: nothing to update and nothing to push.
  if (!known) return null;

  await sourceProductModel.upsert(storeId, product);

  const requeued = await productMappingModel.requeueForSourceProduct(known.id);

  return { sourceProductId: known.id, requeued };
}

/**
 * The DESTINATION's own catalogue changed. Bring our record of it into line.
 *
 * A merchant can delete a variant, or the whole product, straight from their
 * Shopify admin. Nothing tells the app -- the destination screen reads
 * mapping_variant_products, so it would go on listing variants that are not
 * there any more until the next push happened to notice.
 *
 * Makes NO Shopify call and queues NO push: it only reconciles what we hold
 * against what the payload says. That is also what keeps it from looping --
 * our own push makes this same webhook fire straight back at us.
 */
async function applyDestinationUpdate(storeId, payload) {
  const mappings = await productMappingModel.findByDestinationProductId(
    storeId,
    payload.id
  );

  if (!mappings.length) return null; // not a product this app created

  const alive = new Set(
    (payload.variants || []).map((variant) => String(variant.id)).filter(Boolean)
  );

  let dropped = 0;

  for (const mapping of mappings) {
    const links = await mappingVariantProductModel.listForMapping(mapping.id);

    for (const link of links) {
      // No destination id recorded means the push never linked it; leave it.
      if (!link.destination_variant_id) continue;
      if (alive.has(String(link.destination_variant_id))) continue;

      await mappingVariantProductModel.removeByDestinationVariant(
        mapping.id,
        link.destination_variant_id
      );
      dropped += 1;
    }
  }

  return { mappings: mappings.length, dropped };
}

/**
 * The destination's merchant deleted the whole product we created there.
 *
 * The offer goes back to "waiting for you" rather than being pushed again:
 * re-creating a product someone just deleted would be the app overruling them.
 */
async function applyDestinationDelete(storeId, destinationProductId) {
  const mappings = await productMappingModel.findByDestinationProductId(
    storeId,
    destinationProductId
  );

  if (!mappings.length) return null;

  for (const mapping of mappings) {
    // The links describe variants of a product that is gone.
    await mappingVariantProductModel.removeMissing(mapping.id, []);
    await productMappingModel.markGoneFromDestination(mapping.id);
  }

  return { mappings: mappings.length };
}

/**
 * A product was deleted at the source.
 *
 * The mapping row is KEPT and marked deleted -- it records what the product
 * became on each destination, which a hard delete would lose. What to do with
 * the destination's copy is the connection's delete_behaviour, and is not
 * acted on here.
 */
async function applySourceDelete(storeId, shopifyProductId) {
  const known = await sourceProductModel.findByShopifyId(storeId, shopifyProductId);

  if (!known) return null;

  const mappings = await productMappingModel.listForSourceProduct(known.id);

  for (const mapping of mappings) {
    await productMappingModel.markDeleted(mapping.id);
  }

  return { sourceProductId: known.id, marked: mappings.length };
}

/* ------------------------------------------------------------------ */
/* Writing to a destination                                            */
/* ------------------------------------------------------------------ */

const PRODUCT_SET_MUTATION = `
  mutation SyncProduct($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product {
        id
        variants(first: 100) {
          nodes {
            id
            sku
            title
            inventoryItem { id }
            selectedOptions { name value }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

/** Apply the connection's markup. Stored as a percent, so 15 means +15%. */
function withMarkup(price, markupPercent) {
  // Checked before Number(), because Number(null) and Number("") are both 0 --
  // which would push a priceless variant to the destination as free.
  if (price === null || price === undefined || price === "") return null;

  const base = Number(price);

  if (!Number.isFinite(base)) return null;

  const markup = Number(markupPercent) || 0;
  return Number((base * (1 + markup / 100)).toFixed(2));
}

/**
 * Narrow a product's variants to the ones the merchant allowed.
 *
 * `allowedIds` is null for "every variant", which is NOT the same as an empty
 * array. An id that no longer exists at the source is simply absent, and if
 * that leaves nothing the caller must treat it as an error rather than pushing
 * a product with no variants at all.
 */
function selectVariants(variants, allowedIds) {
  if (allowedIds === null || allowedIds === undefined) return variants;

  const allowed = new Set(allowedIds.map(Number));
  return variants.filter((variant) => allowed.has(Number(variant.id)));
}

/**
 * Build the ProductSetInput for one cached source product.
 *
 * productOptions and variants use create/update/DELETE semantics -- anything
 * omitted is REMOVED on the destination. That is what makes a narrowed
 * selection work: send one variant and the destination product has exactly
 * one. It is also why the options are rebuilt from the variants actually being
 * sent rather than copied wholesale -- an option value with no variant behind
 * it would be rejected.
 */
function buildProductInput(product, variants, settings, destinationProductId) {
  const data = product.product_data || {};
  const sourceOptions = data.options || [];

  const input = {
    title: product.title,
    descriptionHtml: data.descriptionHtml || "",
    vendor: product.vendor || undefined,
    productType: product.product_type || undefined,
    tags: Array.isArray(data.tags) ? data.tags : undefined,
    status: (product.status || "ACTIVE").toUpperCase(),
    variants: variants.map((variant) => ({
      sku: variant.sku || undefined,
      price: withMarkup(variant.price, settings.price_markup_percent),
      compareAtPrice: variant.compare_at_price
        ? withMarkup(variant.compare_at_price, settings.price_markup_percent)
        : undefined,
      optionValues: [variant.option1, variant.option2, variant.option3]
        .map((value, index) => {
          const option = sourceOptions[index];
          if (!option || !value) return null;
          return { optionName: option.name, name: value };
        })
        .filter(Boolean),
    })),
  };

  // Rebuilt from the variants being sent, in source order, dropping any option
  // left with no values (a colour option is meaningless when only one colour
  // is going across).
  const productOptions = sourceOptions
    .map((option, index) => {
      const column = ["option1", "option2", "option3"][index];
      const used = [
        ...new Set(variants.map((variant) => variant[column]).filter(Boolean)),
      ];

      if (!used.length) return null;

      return {
        name: option.name,
        position: option.position || index + 1,
        values: used.map((value) => ({ name: value })),
      };
    })
    .filter(Boolean)
    // Positions must stay contiguous once a middle option has been dropped.
    .map((option, index) => ({ ...option, position: index + 1 }));

  // Only send options when the product actually has them; a default variant
  // product has none, and an empty array would be rejected.
  if (productOptions.length) input.productOptions = productOptions;

  // Images are copied by URL -- Shopify downloads them onto the destination,
  // so nothing has to be uploaded from here.
  const images = Array.isArray(data.images) ? data.images : [];

  if (images.length) {
    input.files = images.map((image) => ({
      originalSource: image.url,
      contentType: "IMAGE",
      alt: image.alt || undefined,
    }));
  }

  // The handle is NOT copied: it must be unique per store, and a collision
  // fails the whole mutation. Shopify derives one from the title instead.

  if (destinationProductId) {
    input.id = `gid://shopify/Product/${destinationProductId}`;
  }

  return input;
}

/**
 * Push ONE mapping to its destination.
 *
 * Variants are matched back by their option values, never by title or
 * position: a rename at either end must not re-point a variant at the wrong
 * row, which is what mapping_variant_products exists to prevent.
 */
async function pushOne(connection, mapping) {
  const product = await sourceProductModel.findById(mapping.source_product_id);

  if (!product) {
    await productMappingModel.markFailed(mapping.id, "Source product is no longer cached");
    return { ok: false, error: "Source product is no longer cached" };
  }

  const all = await sourceVariantModel.listForProduct(product.id);
  const variants = selectVariants(all, mapping.allowed_variant_ids);

  if (!variants.length) {
    // Either the product genuinely has no variants, or every allowed one has
    // since been deleted at the source. Pushing now would strip the
    // destination product down to nothing, so refuse and say why.
    const message = all.length
      ? "None of the allowed variants exist at the source any more"
      : "This product has no variants to sync";

    await productMappingModel.markFailed(mapping.id, message);
    return { ok: false, error: message };
  }

  const input = buildProductInput(
    product,
    variants,
    connection.settings,
    mapping.destination_shopify_product_id
  );

  const data = await shopify.forShop(connection.destination.shop_domain, {
    query: PRODUCT_SET_MUTATION,
    variables: { input, synchronous: true },
  });

  const result = data.productSet;
  const userErrors = result?.userErrors || [];

  if (userErrors.length) {
    const message = userErrors
      .map((e) => `${(e.field || []).join(".")}: ${e.message}`)
      .join("; ");

    await productMappingModel.markFailed(mapping.id, message);
    return { ok: false, error: message };
  }

  const destinationProduct = result.product;
  const destinationId = numericId(destinationProduct.id);

  await productMappingModel.markSynced(mapping.id, {
    destinationProductId: destinationId,
    sourceUpdatedAt: product.shopify_updated_at,
  });

  await linkVariants(mapping.id, variants, destinationProduct.variants?.nodes || []);

  return { ok: true, destinationProductId: destinationId };
}

/** Key a variant by its option values, which survive renames of the variant. */
function optionKey(values) {
  return values
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value).trim().toLowerCase())
    .join(" / ");
}

async function linkVariants(productMappingId, sourceVariants, destinationVariants) {
  const bySku = new Map();
  const byOptions = new Map();

  destinationVariants.forEach((variant) => {
    if (variant.sku) bySku.set(String(variant.sku).trim().toLowerCase(), variant);

    const key = optionKey((variant.selectedOptions || []).map((o) => o.value));
    if (key) byOptions.set(key, variant);
  });

  // A variant the merchant stopped sharing was DELETED on the destination by
  // productSet, so its link row describes something that no longer exists.
  // Dropping it here is what keeps the destination's Products screen honest --
  // it reads these rows, not Shopify.
  const removed = await mappingVariantProductModel.removeMissing(
    productMappingId,
    sourceVariants.map((variant) => variant.shopify_variant_id)
  );

  if (removed) {
    console.log(`Dropped ${removed} stale variant link(s) on mapping ${productMappingId}`);
  }

  const pairs = [];

  for (const source of sourceVariants) {
    // SKU first when there is one -- it is the merchant's own identifier and
    // survives an option being renamed on either side.
    const match =
      (source.sku && bySku.get(String(source.sku).trim().toLowerCase())) ||
      byOptions.get(optionKey([source.option1, source.option2, source.option3])) ||
      // A product with no options has exactly one variant on both sides.
      (destinationVariants.length === 1 && sourceVariants.length === 1
        ? destinationVariants[0]
        : null);

    if (!match) continue;

    pairs.push({
      sourceVariantMappingId: source.id,
      sourceShopifyVariantId: source.shopify_variant_id,
      destinationVariantId: numericId(match.id),
      destinationInventoryItemId: numericId(match.inventoryItem?.id),
      sku: source.sku,
    });
  }

  // One statement rather than one per variant: a 50-variant product would
  // otherwise cost 50 round trips to the database.
  return mappingVariantProductModel.upsertMany(productMappingId, pairs);
}

/**
 * Push every pending mapping on one connection.
 *
 * One product failing does not stop the rest: each is marked failed with its
 * own message, so the screen can show exactly which ones need attention.
 */
async function pushPending(connectionId, { limit = 100 } = {}) {
  const connection = await connectionModel.findById(connectionId);

  if (!connection) throw new Error("Connection not found");

  if (connection.status !== "active") {
    return { synced: 0, failed: 0, skipped: 0, reason: `connection is ${connection.status}` };
  }

  // acceptedOnly is the whole safeguard: the source offering a product is not
  // permission to write it: the destination's own operator has to have ticked
  // it first.
  const pending = await productMappingModel.listForConnection(connectionId, {
    status: "pending",
    acceptedOnly: true,
    limit,
  });

  let synced = 0;
  let failed = 0;

  for (const mapping of pending) {
    try {
      const result = await pushOne(connection, mapping);
      result.ok ? (synced += 1) : (failed += 1);
    } catch (err) {
      // A thrown error is a transport failure, not a rejected product; record
      // it the same way so the merchant sees which product to retry.
      await productMappingModel.markFailed(mapping.id, err.message);
      failed += 1;
    }
  }

  if (synced) await connectionModel.touchLastSynced(connectionId);

  return { synced, failed, total: pending.length };
}

/* ------------------------------------------------------------------ */
/* Removing a product from the destinations                            */
/* ------------------------------------------------------------------ */

const PRODUCT_DELETE_MUTATION = `
  mutation DeleteProduct($input: ProductDeleteInput!, $synchronous: Boolean!) {
    productDelete(input: $input, synchronous: $synchronous) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

/**
 * Delete this product from every destination it was pushed to.
 *
 * This is the destructive one: it removes a product from a store this app does
 * not own, and Shopify's own docs call it permanent -- variants, media and
 * inventory go with it. Only products THIS app created are touched: a mapping
 * with no destination_shopify_product_id was never pushed, so there is nothing
 * of ours there to remove.
 *
 * Returns per-destination results rather than throwing, so a caller can refuse
 * to forget the mapping when a delete did not actually happen.
 */
async function deleteFromDestinations(sourceProductId) {
  const mappings = await productMappingModel.listForSourceProduct(sourceProductId);
  const results = { deleted: 0, failed: 0, skipped: 0, errors: [] };

  for (const mapping of mappings) {
    if (!mapping.destination_shopify_product_id) {
      results.skipped += 1; // never pushed
      continue;
    }

    const connection = await connectionModel.findById(mapping.connection_id);

    if (!connection || !connection.destination.is_active) {
      // The shop uninstalled the app; we have no token to delete with.
      results.skipped += 1;
      continue;
    }

    try {
      const data = await shopify.forShop(connection.destination.shop_domain, {
        query: PRODUCT_DELETE_MUTATION,
        variables: {
          input: {
            id: `gid://shopify/Product/${mapping.destination_shopify_product_id}`,
          },
          synchronous: true,
        },
      });

      const errors = data.productDelete?.userErrors || [];

      // Already gone counts as done: the goal was for it not to be there.
      const alreadyGone = errors.some((error) =>
        /not found|does not exist/i.test(error.message || "")
      );

      if (errors.length && !alreadyGone) {
        results.failed += 1;
        results.errors.push(
          `${connection.destination.shop_domain}: ${errors[0].message}`
        );
        continue;
      }

      results.deleted += 1;
    } catch (err) {
      results.failed += 1;
      results.errors.push(`${connection.destination.shop_domain}: ${err.message}`);
    }
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Automatic pushes                                                    */
/* ------------------------------------------------------------------ */

const AUTO_SYNC_INTERVAL_MS = Number(
  process.env.AUTO_SYNC_INTERVAL_MS || 60_000
);

let autoSyncTimer = null;
let autoSyncRunning = false;

/**
 * Push everything queued on every auto connection, once.
 *
 * Only touches mappings the destination has ALREADY accepted -- pushPending
 * enforces that. An update to a product someone agreed to receive needs no
 * second agreement; a product they have never seen still waits for them.
 */
async function runAutoSync() {
  // A slow round must not overlap the next tick and push the same product
  // twice concurrently.
  if (autoSyncRunning) return { skipped: true };

  autoSyncRunning = true;

  const totals = { synced: 0, failed: 0, connections: 0 };

  try {
    for (const connection of await connectionModel.listAutoSync()) {
      totals.connections += 1;

      try {
        const result = await pushPending(connection.id);
        totals.synced += result.synced;
        totals.failed += result.failed;
      } catch (err) {
        // One broken connection -- a revoked token, a shop that vanished --
        // must not stop every other merchant's sync.
        console.warn(
          `Auto-sync failed for connection ${connection.id}:`,
          err.message
        );
      }
    }
  } finally {
    autoSyncRunning = false;
  }

  if (totals.synced || totals.failed) {
    console.log(
      `Auto-sync: ${totals.synced} synced, ${totals.failed} failed ` +
        `across ${totals.connections} connection(s)`
    );
  }

  return totals;
}

/** Start the background push. Safe to call twice; the second call is a no-op. */
function startAutoSync() {
  if (autoSyncTimer) return autoSyncTimer;

  autoSyncTimer = setInterval(() => {
    runAutoSync().catch((err) =>
      console.error("Auto-sync round crashed:", err.message)
    );
  }, AUTO_SYNC_INTERVAL_MS);

  // Do not hold the process open just for this: a shutdown should not have to
  // wait out the interval.
  if (autoSyncTimer.unref) autoSyncTimer.unref();

  console.log(
    `Auto-sync running every ${Math.round(AUTO_SYNC_INTERVAL_MS / 1000)}s`
  );

  return autoSyncTimer;
}

function stopAutoSync() {
  if (!autoSyncTimer) return;
  clearInterval(autoSyncTimer);
  autoSyncTimer = null;
}

module.exports = {
  importProducts,
  fromWebhook,
  applySourceUpdate,
  applySourceDelete,
  applyDestinationUpdate,
  applyDestinationDelete,
  deleteFromDestinations,
  runAutoSync,
  startAutoSync,
  stopAutoSync,
  pushPending,
  pushOne,
  buildProductInput,
  selectVariants,
  withMarkup,
  optionKey,
  numericId,
  flatten,
};
