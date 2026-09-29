// services/collectionSync.js
//
// The collections a product sits in, copied across with it.
//
// A supplier keeps its catalogue in groups -- "Massage Oils", "Best Sellers".
// Without this the products arrive in the buyer's store loose, and the buyer
// rebuilds those groups by hand. With it the group is created on the way in
// and the product lands inside it.
//
// Three rules shape everything here:
//
//   1. RULES ARE NEVER COPIED, only membership. A source smart collection may
//      say "price under 500"; the same rule on the destination is a different
//      question, because the buyer's margin has already changed every price.
//      Copied literally it would produce an empty collection. So the source is
//      asked WHICH PRODUCTS are in the collection, and a plain collection is
//      made from the answer.
//
//   2. WHAT THE BUYER ALREADY HAD IS THEIRS. A destination that already has a
//      collection of that handle keeps it, and the mapping row records that we
//      did not create it. Nothing of theirs is renamed or removed, and a
//      product they filed in their own collection stays in it -- see
//      collectionsForProduct, which merges rather than replaces.
//
//   3. NOTHING IS DELETED. A collection emptied by an unsync stays. The buyer
//      may have it in their navigation, and a menu pointing at a collection
//      that no longer exists is a broken storefront.
//
// Off unless the destination switches it on in Settings, and only offered
// there on a plan that includes it (services/planLimits.collectionsAllowed).
const shopify = require("./shopify");
const collectionMappingModel = require("../models/collectionMappingModel");

/** Shopify gids are "gid://shopify/Collection/123"; our columns hold the number. */
function numericId(gid) {
  const match = String(gid || "").match(/(\d+)\s*$/);
  return match ? match[1] : null;
}

const collectionGid = (id) => `gid://shopify/Collection/${id}`;

/*
 * Found by handle rather than title: a handle is unique per store and is what
 * a merchant's URLs are built from, so matching on it is what makes "they
 * already have this collection" mean the same thing on both sides.
 *
 * Not collectionByHandle, which is deprecated -- a search of one is the shape
 * that survives an API version bump.
 */
const FIND_COLLECTION_QUERY = `
  query FindCollection($query: String!) {
    collections(first: 1, query: $query) {
      nodes { id title handle }
    }
  }
`;

/*
 * `input: CollectionInput!`, not the newer `collection: CollectionCreateInput!`.
 *
 * This app talks to 2025-01 (services/shopify.js), where CollectionCreateInput
 * does not exist yet -- asking for it fails validation with "isn't a defined
 * input type" before the mutation is even attempted. The newer argument is
 * only worth moving to alongside an API version bump.
 */
const CREATE_COLLECTION_MUTATION = `
  mutation CreateCollection($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id title handle }
      userErrors { field message }
    }
  }
`;

/* What the destination product is in NOW, so the buyer's own filing survives
 * a push. productSet's `collections` REPLACES the list, and sending only ours
 * would quietly take a product out of the collections they put it in. */
const PRODUCT_COLLECTIONS_QUERY = `
  query ProductCollections($id: ID!) {
    product(id: $id) {
      collections(first: 100) { nodes { id } }
    }
  }
`;

/** A collection with that handle on `shop`, or null. */
async function findByHandle(shop, handle) {
  if (!handle) return null;

  // Quoted: a handle can hold characters the search parser would otherwise
  // read as syntax.
  const data = await shopify.forShop(shop, {
    query: FIND_COLLECTION_QUERY,
    variables: { query: `handle:'${String(handle).replace(/'/g, "")}'` },
  });

  const node = data.collections?.nodes?.[0];

  // The search is a fuzzy one, so an exact handle is confirmed rather than
  // assumed -- "oils" must not match "massage-oils" and merge two groups.
  return node && node.handle === handle ? node : null;
}

/** Create it, and put it on the storefront. */
async function createOn(shop, { title, handle, descriptionHtml }) {
  const data = await shopify.forShop(shop, {
    query: CREATE_COLLECTION_MUTATION,
    variables: {
      input: {
        title,
        // The source's handle, so a second look finds it. Shopify makes one
        // up when it collides, which is fine: the mapping row records what
        // was actually created.
        handle: handle || undefined,
        descriptionHtml: descriptionHtml || undefined,
      },
    },
  });

  const result = data.collectionCreate;
  const userErrors = result?.userErrors || [];

  if (userErrors.length) {
    throw new Error(userErrors.map((error) => error.message).join("; "));
  }

  const created = result?.collection;
  if (!created) throw new Error("Shopify returned no collection");

  /* A collection created through the API belongs to no sales channel, so it
   * exists in the admin and is invisible on the storefront. The same step the
   * products themselves get. Lazily required: productSync requires this file.
   */
  const { publishToOnlineStore } = require("./productSync");
  await publishToOnlineStore(shop, created.id);

  return created;
}

/**
 * Make sure every one of `sourceCollections` exists on the destination.
 *
 * Returns Map(source collection id -> destination gid). The mapping table is
 * consulted first, so a collection is looked up and created ONCE however many
 * products arrive in it -- fifty products in one collection would otherwise
 * be fifty searches against the tightest rate limit in this app.
 *
 * One collection failing does not fail the others, or the product: arriving
 * in three of its four groups beats not arriving at all.
 */
async function ensureCollections(connection, sourceCollections) {
  const wanted = (sourceCollections || []).filter((item) => item && item.id);
  const placed = new Map();

  if (!wanted.length) return placed;

  const shop = connection.destination.shop_domain;
  const known = await collectionMappingModel.mapForConnection(connection.id);

  for (const collection of wanted) {
    const sourceId = String(collection.id);
    const already = known.get(sourceId);

    if (already && already.destination_shopify_collection_id) {
      placed.set(sourceId, collectionGid(already.destination_shopify_collection_id));
      continue;
    }

    try {
      // Theirs first. Joining a collection the buyer already keeps is better
      // than standing a near-duplicate next to it.
      const existing = await findByHandle(shop, collection.handle);
      const node = existing || (await createOn(shop, collection));

      await collectionMappingModel.remember(connection.id, {
        sourceCollectionId: sourceId,
        destinationCollectionId: numericId(node.id),
        title: node.title,
        handle: node.handle,
        createdByApp: !existing,
      });

      placed.set(sourceId, node.id);
    } catch (err) {
      console.warn(
        `Collection "${collection.title}" could not be placed on ${shop}:`,
        err.message
      );
    }
  }

  return placed;
}

/**
 * The full `collections` list for a productSet call.
 *
 * ours + whatever else the destination product is already in. The second half
 * is the point: productSet REPLACES membership, so pushing only our own list
 * would take the product out of every collection the buyer filed it in
 * themselves. Read only for a product that already exists over there -- a new
 * one has no filing to preserve.
 */
async function collectionsForProduct(connection, sourceCollections, destinationProductId) {
  const placed = await ensureCollections(connection, sourceCollections);
  const ours = [...placed.values()];

  if (!destinationProductId) return ours;

  const shop = connection.destination.shop_domain;

  // Everything this connection manages, by destination gid: the rest of what
  // the product is in belongs to the buyer and is kept.
  const managed = new Set(
    [...(await collectionMappingModel.mapForConnection(connection.id)).values()]
      .filter((row) => row.destination_shopify_collection_id)
      .map((row) => collectionGid(row.destination_shopify_collection_id))
  );

  let theirs = [];

  try {
    const data = await shopify.forShop(shop, {
      query: PRODUCT_COLLECTIONS_QUERY,
      variables: { id: `gid://shopify/Product/${destinationProductId}` },
    });

    theirs = (data.product?.collections?.nodes || [])
      .map((node) => node.id)
      .filter((id) => !managed.has(id));
  } catch (err) {
    /* Could not read what it is in. Sending our list alone would replace
     * theirs, so the safer failure is to send nothing at all and leave the
     * product's collections exactly as they are this round. */
    console.warn(
      `Could not read collections for product ${destinationProductId} on ${shop}:`,
      err.message
    );
    return null;
  }

  return [...new Set([...theirs, ...ours])];
}

module.exports = {
  ensureCollections,
  collectionsForProduct,
  findByHandle,
};
