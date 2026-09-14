// services/planLimits.js
//
// Everything about what a destination store's plan allows, in one place.
//
//   products  HARD. Accepting products past the limit is refused.
//   sources   HARD. Connecting or resuming a source store past the limit is
//             refused.
//   orders    SOFT. Never refused: the sale has already happened and the
//             shopper has paid, so it always goes to the supplier. From 80%
//             the merchant is warned, and past 100% the warning stays until
//             the next billing month or an upgrade.
//   emails    HARD for notification emails. Past the limit they are not sent,
//             and the destination is emailed ONCE that they have stopped.
//
// "Month" is the store's own billing month: 30-day cycles from the day its
// current plan was activated, because Shopify bills EVERY_30_DAYS (see
// services/billing.js). A store that has never chosen a plan is on Free,
// counted from the day it installed. Changing plan starts a new billing month.
//
// Limits come from the plan's columns (planModel.limitsOf); null = unlimited.
//
// Nothing is ever removed automatically. A downgrade makes the merchant choose
// what to unsync and pause BEFORE the plan changes, and a store that is already
// over its limit -- on the day limits start being enforced, say -- keeps
// everything it has and simply cannot add more until it is back under.
const planModel = require("../models/planModel");
const storeModel = require("../models/storeModel");
const usageModel = require("../models/planUsageModel");

/** Shopify bills every 30 days, so that is a billing month here too. */
const PERIOD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Warn from here: early enough to act before anything stops. */
const WARN_AT = 0.8;

const KEYS = ["products", "orders", "emails", "sources"];

const NO_LIMITS = { products: null, orders: null, emails: null, sources: null };

const fmt = (value) => Number(value).toLocaleString("en-US");

const sourceStores = (n) => (n === 1 ? "1 source store" : `${fmt(n)} source stores`);

/** "12 Oct 2026" -- the date a merchant reads, not an ISO string. */
function formatDate(date) {
  const value = new Date(date);

  return Number.isNaN(value.getTime())
    ? "your next billing date"
    : value.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The billing month `now` falls in: a 30-day window counted from `anchor`.
 *
 * Works for any number of elapsed cycles, and for an anchor slightly in the
 * future (a clock a second ahead) -- floor() of a small negative number is -1,
 * which gives the window that contains now.
 */
function billingPeriod(anchor, now = new Date()) {
  const length = PERIOD_DAYS * DAY_MS;
  const nowMs = new Date(now).getTime();
  const origin = new Date(anchor).getTime();
  const base = Number.isFinite(origin) ? origin : nowMs;
  const cycles = Math.floor((nowMs - base) / length);
  const start = new Date(base + cycles * length);

  return { start, end: new Date(start.getTime() + length) };
}

/**
 * The plan a store is on, and where its billing month starts.
 *
 * No active membership means Free, counted from install. created_at before
 * installed_at: it is written by the database's own clock, the same clock
 * every order and email it is compared with was stamped by.
 *
 * No free plan in the database at all means no limits -- a misconfigured
 * catalogue must not lock merchants out.
 */
async function effectivePlan(store) {
  const membership = await planModel.activeMembership(store.id);

  if (membership) {
    return {
      plan: membership,
      anchor: membership.activated_at || membership.membership_created_at,
      chosen: true,
    };
  }

  const free = await planModel.findFree();

  if (!free) {
    console.warn("No active free plan: a store with no plan is treated as unlimited");
  }

  return { plan: free, anchor: store.created_at || store.installed_at, chosen: false };
}

/** ok -> near (80%) -> full (at the limit) -> over (past it, e.g. after a downgrade). */
function stateOf(used, limit) {
  if (limit === null) return "ok";
  if (used > limit) return "over";
  if (used >= limit) return "full";
  if (used >= limit * WARN_AT) return "near";
  return "ok";
}

/**
 * Everything a screen needs to know about a store's plan, in one read.
 *
 * `now` defaults to the DATABASE's clock (see planUsageModel.dbNow); pass one
 * only in tests.
 */
async function snapshot(store, { now = null } = {}) {
  const { plan, anchor, chosen } = await effectivePlan(store);
  const period = billingPeriod(anchor, now || (await usageModel.dbNow()));
  const limits = plan ? planModel.limitsOf(plan) : { ...NO_LIMITS };
  const usage = await usageModel.usage(store.id, period);

  const state = {};
  KEYS.forEach((key) => {
    state[key] = stateOf(usage[key], limits[key]);
  });

  return {
    plan: plan ? { id: plan.id, name: plan.name, price: Number(plan.price) || 0 } : null,
    chosen,
    period,
    limits,
    usage,
    state,
  };
}

/**
 * The warnings a destination sees at the top of every screen. Empty when all
 * is well, so the banner simply does not render.
 *
 * `error` stops something the merchant is trying to do; `warn` is information
 * they should act on. Orders never reach `error` -- they are never stopped.
 */
function bannerItems(snap) {
  if (!snap || !snap.plan) return [];

  const { usage, limits, state, plan } = snap;
  const resets = formatDate(snap.period.end);
  const items = [];

  if (state.products === "over") {
    items.push({
      key: "products",
      level: "error",
      text:
        `You have ${fmt(usage.products)} products in your store, but the ` +
        `${plan.name} plan allows ${fmt(limits.products)}. You can't add more ` +
        `until you unsync ${fmt(usage.products - limits.products)} or upgrade.`,
    });
  }

  if (state.sources === "over") {
    items.push({
      key: "sources",
      level: "error",
      text:
        `${sourceStores(usage.sources)} ${usage.sources === 1 ? "is" : "are"} active, ` +
        `but the ${plan.name} plan allows ${fmt(limits.sources)}. You can't add ` +
        `another until one is paused or removed, or you upgrade.`,
    });
  }

  if (state.emails === "full" || state.emails === "over") {
    items.push({
      key: "emails",
      level: "error",
      text:
        `Notification emails are paused: all ${fmt(limits.emails)} for this ` +
        `billing month have been used. They start again on ${resets}, or ` +
        `upgrade to send them now.`,
    });
  } else if (state.emails === "near") {
    items.push({
      key: "emails",
      level: "warn",
      text:
        `You've used ${fmt(usage.emails)} of ${fmt(limits.emails)} notification ` +
        `emails this billing month. They reset on ${resets}.`,
    });
  }

  if (state.orders === "full" || state.orders === "over") {
    items.push({
      key: "orders",
      level: "warn",
      text:
        `${fmt(usage.orders)} orders this billing month; the ${plan.name} plan ` +
        `includes ${fmt(limits.orders)}. Orders still go to your source stores ` +
        `-- upgrade to stay within your plan. The count resets on ${resets}.`,
    });
  } else if (state.orders === "near") {
    items.push({
      key: "orders",
      level: "warn",
      text:
        `You've had ${fmt(usage.orders)} of the ${fmt(limits.orders)} orders your ` +
        `plan includes this billing month. The count resets on ${resets}.`,
    });
  }

  return items;
}

/* ------------------------------------------------------------------ */
/* The hard limits, where they are enforced                            */
/* ------------------------------------------------------------------ */

/**
 * Accept products into the store, within the plan's product limit.
 *
 * Returns the model's result plus a `message` the merchant can act on when it
 * was refused.
 */
async function acceptProducts(store, mappingIds) {
  const { plan } = await effectivePlan(store);
  const limit = plan ? planModel.limitsOf(plan).products : null;

  const result = await usageModel.acceptWithinLimit(store.id, mappingIds, limit);

  if (result.refused) {
    result.message = result.remaining
      ? `Your ${plan.name} plan allows ${fmt(limit)} products and ` +
        `${fmt(result.used)} are already in your store, so you can add ` +
        `${fmt(result.remaining)} more -- you picked ${fmt(result.adding)}. ` +
        `Unsync some products or upgrade your plan.`
      : `Your ${plan.name} plan allows ${fmt(limit)} products, and your store ` +
        `already has ${fmt(result.used)}. Unsync some products or upgrade your ` +
        `plan to add more.`;
  }

  return result;
}

/** Is there room for one more active source store? Checked before a code is spent. */
async function sourceRoom(store) {
  const { plan } = await effectivePlan(store);
  const limit = plan ? planModel.limitsOf(plan).sources : null;

  if (limit === null) return { ok: true, limit: null };

  const used = await usageModel.countSources(store.id);

  if (used < limit) return { ok: true, used, limit };

  return {
    ok: false,
    used,
    limit,
    message:
      `Your ${plan.name} plan allows ${sourceStores(limit)}, and you already ` +
      `have ${fmt(used)} active. Upgrade your plan, or pause or remove a store first.`,
  };
}

/** Resume a paused source store, if the plan has room for it. */
async function resumeSource(store, connectionId) {
  const { plan } = await effectivePlan(store);
  const limit = plan ? planModel.limitsOf(plan).sources : null;

  const result = await usageModel.resumeWithinLimit(store.id, connectionId, limit);

  if (result.refused) {
    result.message =
      `Your ${plan.name} plan allows ${sourceStores(limit)} active at a time. ` +
      `Pause or remove another store first, or upgrade your plan.`;
  }

  return result;
}

/**
 * May another notification email go out on this destination's plan?
 *
 * Counted per destination store -- its plan pays for every email on its
 * connections, including the ones that go to its source stores.
 */
async function emailAllowance(destinationStoreId, { now = null } = {}) {
  const store = await storeModel.findById(destinationStoreId);

  if (!store) return { ok: true, limit: null };

  const { plan, anchor } = await effectivePlan(store);
  const limit = plan ? planModel.limitsOf(plan).emails : null;

  if (limit === null) return { ok: true, limit: null };

  const period = billingPeriod(anchor, now || (await usageModel.dbNow()));
  const used = await usageModel.countEmails(store.id, period.start, period.end);

  return { ok: used < limit, used, limit, period, planName: plan.name };
}

/* ------------------------------------------------------------------ */
/* Changing plan                                                       */
/* ------------------------------------------------------------------ */

/**
 * Would the store fit in `targetPlan` as it is now?
 *
 * Only products and source stores can stop a change. Orders and emails are
 * monthly, and a new plan starts a new billing month, so they begin again from
 * zero the moment it is active.
 */
async function fitCheck(store, targetPlan) {
  const current = await snapshot(store);
  const target = planModel.limitsOf(targetPlan);

  const excess = (key) =>
    target[key] === null ? 0 : Math.max(0, current.usage[key] - target[key]);

  const products = {
    used: current.usage.products,
    limit: target.products,
    excess: excess("products"),
  };

  const sources = {
    used: current.usage.sources,
    limit: target.sources,
    excess: excess("sources"),
  };

  return { fits: !products.excess && !sources.excess, products, sources };
}

/** The one-line reason a plan change is waiting on the merchant. */
function fitMessage(fit, plan) {
  const parts = [];

  if (fit.products.excess) {
    parts.push(`${fmt(fit.products.limit)} products (you have ${fmt(fit.products.used)})`);
  }

  if (fit.sources.excess) {
    parts.push(`${sourceStores(fit.sources.limit)} (you have ${fmt(fit.sources.used)} active)`);
  }

  const what = [
    fit.products.excess ? "which products to unsync" : null,
    fit.sources.excess ? "which stores to pause" : null,
  ].filter(Boolean).join(" and ");

  return `The ${plan.name} plan allows ${parts.join(" and ")}. Choose ${what} before switching.`;
}

/**
 * What the downgrade screen offers to choose from. Lists are only fetched for
 * the limit that is actually exceeded.
 */
async function downgradeOptions(store, fit, targetPlan) {
  const [products, sources] = await Promise.all([
    fit.products.excess ? usageModel.listAcceptedForDestination(store.id) : [],
    fit.sources.excess ? usageModel.listActiveConnections(store.id) : [],
  ]);

  return {
    plan: { id: targetPlan.id, name: targetPlan.name },
    products: {
      ...fit.products,
      items: products.map((row) => ({
        id: row.mapping_id,
        title: row.title,
        source: row.source_store_name || row.source_shop_domain,
        image: row.image_url || null,
      })),
    },
    sources: {
      ...fit.sources,
      items: sources.map((row) => ({
        id: row.id,
        name: row.store_name || row.shop_domain,
        products: Number(row.products) || 0,
      })),
    },
  };
}

/**
 * Apply what the merchant chose to make room for `targetPlan`.
 *
 * All or nothing: the model re-counts inside a lock and refuses choices that
 * would not be enough, with `error` saying how many more are needed.
 */
async function applyDowngrade(store, targetPlan, { unsync = [], pause = [] }) {
  const limits = planModel.limitsOf(targetPlan);

  const result = await usageModel.applyDowngradeChoices(store.id, {
    unsync,
    pause,
    productLimit: limits.products,
    sourceLimit: limits.sources,
  });

  if (!result.ok) {
    const missing = [];

    const moreProducts = result.needProducts - result.chosenProducts;
    const moreSources = result.needSources - result.chosenSources;

    if (moreProducts > 0) {
      missing.push(`${fmt(moreProducts)} more product${moreProducts === 1 ? "" : "s"} to unsync`);
    }

    if (moreSources > 0) {
      missing.push(`${fmt(moreSources)} more store${moreSources === 1 ? "" : "s"} to pause`);
    }

    result.error = `Choose ${missing.join(" and ")} to fit the ${targetPlan.name} plan.`;
  }

  return result;
}

module.exports = {
  PERIOD_DAYS,
  WARN_AT,
  billingPeriod,
  effectivePlan,
  stateOf,
  snapshot,
  bannerItems,
  formatDate,
  acceptProducts,
  sourceRoom,
  resumeSource,
  emailAllowance,
  fitCheck,
  fitMessage,
  downgradeOptions,
  applyDowngrade,
};
