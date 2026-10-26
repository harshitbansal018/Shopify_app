// services/shippingSync.js
//
// Phase-one checkout shipping: the source defines one flat/included policy
// per destination connection. We materialise it as an app-owned delivery
// profile in the destination and associate only that source's variants. That
// association is what keeps the destination's general shipping rate off them.
const shopify = require("./shopify");
const crypto = require("crypto");
const shippingPolicyModel = require("../models/shippingPolicyModel");
const mappingVariantProductModel = require("../models/mappingVariantProductModel");

const SHIPPING_API_VERSION = process.env.SHOPIFY_SHIPPING_API_VERSION || "2026-10";

const CREATE_PROFILE = `
  mutation CreateProductSyncDeliveryProfile($profile: DeliveryProfileInput!) {
    deliveryProfileCreate(profile: $profile) {
      profile { id name }
      userErrors { field message }
    }
  }
`;

const UPDATE_PROFILE = `
  mutation AssignProductSyncVariants($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile { id name }
      userErrors { field message }
    }
  }
`;

const DELETE_PROFILE = `
  mutation DeleteProductSyncDeliveryProfile($id: ID!) {
    deliveryProfileRemove(id: $id) {
      job { id done }
      userErrors { field message }
    }
  }
`;

const LOCATION_QUERY = `
  query ProductSyncShippingLocation {
    locationsAvailableForDeliveryProfilesConnection(first: 250) {
      nodes { id }
    }
  }
`;

function gid(kind, id) {
  if (!id) return null;
  return String(id).startsWith("gid://") ? String(id) : `gid://shopify/${kind}/${id}`;
}

function errorsOf(payload) {
  return (payload?.userErrors || []).map((error) => error.message).filter(Boolean);
}

function profileInput(connection, policy, locationIds, variantIds) {
  // Source shipping is now included in the synced product price. The profile
  // exists only to keep the destination's general rates off these variants.
  const amount = 0;
  const sourceName = connection.source.store_name || connection.source.shop_domain;
  // applyPolicy creates the replacement before removing the live profile so
  // checkout never loses its rate. Shopify requires profile names to be
  // unique even during that overlap, hence this short internal revision.
  const revision = `${connection.id || "link"}-${crypto.randomBytes(4).toString("hex")}`;
  const prefix = "Product Sync — ";
  const suffix = ` [${revision}]`;
  const profileName = `${prefix}${String(sourceName).slice(
    0,
    255 - prefix.length - suffix.length
  )}${suffix}`;

  return {
    name: profileName,
    variantsToAssociate: (variantIds || []).map((id) => gid("ProductVariant", id)),
    locationGroupsToCreate: [{
      // A destination can stock products at any of its fulfillment locations.
      // Limiting this profile to the first location can leave its products with
      // no rate at checkout when their inventory lives at another location.
      locationsToAdd: (locationIds || []).map((id) => gid("Location", id)),
      zonesToCreate: [{
        name: `${sourceName} delivery`.slice(0, 255),
        // Shopify requires countries that have regions (for example India,
        // Canada and the US) to include at least one province. The policy is
        // country-wide, so let Shopify expand the country's current province
        // list instead of hard-coding state codes that can drift over time.
        countries: policy.country_codes.map((code) => ({
          code,
          includeAllProvinces: true,
        })),
        methodDefinitionsToCreate: [{
          name: policy.service_name,
          rateDefinition: {
            price: { amount, currencyCode: policy.currency },
          },
        }],
      }],
    }],
  };
}

async function request(connection, body) {
  return shopify.forShop(connection.destination.shop_domain, body, {
    apiVersion: SHIPPING_API_VERSION,
  });
}

async function destinationLocations(connection) {
  const data = await request(connection, { query: LOCATION_QUERY });
  const locations = data.locationsAvailableForDeliveryProfilesConnection?.nodes || [];
  if (!locations.length) throw new Error("Destination store has no active shipping location.");
  return locations.map((location) => location.id).filter(Boolean);
}

async function removeProfile(connection, profileId) {
  if (!profileId) return;
  const data = await request(connection, {
    query: DELETE_PROFILE,
    variables: { id: gid("DeliveryProfile", profileId) },
  });
  const errors = errorsOf(data.deliveryProfileRemove);
  if (errors.length) throw new Error(errors.join("; "));
}

/**
 * Replace the whole app-owned profile atomically from the app's point of view:
 * create the new profile with every known variant first, then remove the old
 * one. Shopify moves associated variants to the new profile during creation,
 * so they never fall through to general shipping between the two calls.
 */
async function applyPolicy(connection, policy = null) {
  const wanted = policy || await shippingPolicyModel.forConnection(connection.id, {
    currency: connection.destination.currency,
  });
  const oldProfileId = wanted.shopify_profile_id;

  try {
    if (wanted.mode === "disabled") {
      await removeProfile(connection, oldProfileId);
      await shippingPolicyModel.markSynced(connection.id, null);
      return { enabled: false, profileId: null };
    }

    const [locationIds, variantIds] = await Promise.all([
      destinationLocations(connection),
      mappingVariantProductModel.destinationVariantIdsForConnection(connection.id),
    ]);
    const data = await request(connection, {
      query: CREATE_PROFILE,
      variables: { profile: profileInput(connection, wanted, locationIds, variantIds) },
    });
    const result = data.deliveryProfileCreate;
    const errors = errorsOf(result);
    if (errors.length || !result?.profile?.id) {
      throw new Error(errors.join("; ") || "Shopify did not create the delivery profile.");
    }

    const newProfileId = result.profile.id;
    await shippingPolicyModel.markSynced(connection.id, newProfileId);

    if (oldProfileId && gid("DeliveryProfile", oldProfileId) !== newProfileId) {
      try {
        await removeProfile(connection, oldProfileId);
      } catch (error) {
        // The new profile is already live. Keep the save successful and leave
        // a useful warning; a later reconciliation can remove the empty old one.
        console.warn(`Could not remove old shipping profile ${oldProfileId}: ${error.message}`);
      }
    }
    return { enabled: true, profileId: newProfileId, variants: variantIds.length };
  } catch (error) {
    await shippingPolicyModel.markFailed(connection.id, error.message);
    throw error;
  }
}

/** Assign variants from one freshly pushed product to the existing profile. */
async function assignProduct(connection, destinationVariants) {
  const policy = await shippingPolicyModel.forConnection(connection.id, {
    currency: connection.destination.currency,
  });
  if (policy.mode === "disabled") return { enabled: false };

  const ids = (destinationVariants || []).map((variant) => variant.id).filter(Boolean);
  if (!ids.length) throw new Error("The destination product returned no variants for shipping.");

  if (!policy.shopify_profile_id) return applyPolicy(connection, policy);

  try {
    // Shopify may treat variantsToAssociate as the profile's full assignment.
    // Always send every synced variant on the connection so updating one
    // product never drops shipping protection from previously synced products.
    const allIds = await mappingVariantProductModel.destinationVariantIdsForConnection(
      connection.id
    );
    const data = await request(connection, {
      query: UPDATE_PROFILE,
      variables: {
        id: gid("DeliveryProfile", policy.shopify_profile_id),
        profile: { variantsToAssociate: allIds.map((id) => gid("ProductVariant", id)) },
      },
    });
    const errors = errorsOf(data.deliveryProfileUpdate);
    if (errors.length) throw new Error(errors.join("; "));
    return { enabled: true, profileId: policy.shopify_profile_id, variants: allIds.length };
  } catch (error) {
    await shippingPolicyModel.markFailed(connection.id, error.message);
    throw error;
  }
}

async function removeConnectionProfile(connection) {
  const policy = await shippingPolicyModel.forConnection(connection.id, {
    currency: connection.destination.currency,
  });
  if (!policy.shopify_profile_id) return false;
  await removeProfile(connection, policy.shopify_profile_id);
  await shippingPolicyModel.markSynced(connection.id, null);
  return true;
}

module.exports = {
  SHIPPING_API_VERSION,
  LOCATION_QUERY,
  gid,
  profileInput,
  applyPolicy,
  assignProduct,
  removeConnectionProfile,
};
