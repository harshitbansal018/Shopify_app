// landing/pricing.js
//
// The pricing section's data, read from the SAME `plans` table the in-app
// Plans screen and the Shopify charge are built from.
//
// That shared source is the whole point. A landing page with its prices typed
// into the HTML drifts the first time someone edits a plan in the database,
// and the merchant finds out by being charged a different number to the one
// they were quoted. Change a price in `plans` and this page follows on the
// next load, with no deploy.
const planModel = require("../models/planModel");

/**
 * `plan_content` is a JSON array of feature lines, stored as text.
 *
 * Bad JSON must not take the page down: a plan whose features cannot be read
 * is still a plan with a name and a price worth showing, so it renders with an
 * empty list rather than a 500.
 */
function featuresOf(plan) {
  try {
    const parsed = JSON.parse(plan.plan_content || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    console.warn(`Plan ${plan.id} has unreadable plan_content; showing no features`);
    return [];
  }
}

/** "30" -> "month". Anything unusual is shown as the day count it really is. */
function periodOf(plan) {
  const days = Number(plan.days);

  if (days === 30 || days === 31) return "month";
  if (days === 365 || days === 366) return "year";
  if (days === 7) return "week";
  if (!Number.isFinite(days) || days <= 0) return null;

  return `${days} days`;
}

/**
 * Every active plan, shaped for the page.
 *
 * Ordered by price by the model, so the cheapest is first and the cards read
 * left to right as they get bigger.
 */
function toCard(plan) {
  const price = Number(plan.price) || 0;

  return {
    id: plan.id,
    name: plan.name,
    price,
    // Free is a word, not "$0" -- and a free plan has no billing period to
    // put beside it either.
    priceLabel: price > 0 ? `$${price.toFixed(0)}` : "Free",
    period: price > 0 ? periodOf(plan) : null,
    popular: Boolean(plan.is_popular),
    features: featuresOf(plan),
    // The headline limit, which is what most people actually compare on.
    limit: Number(plan.max_limit) || null,
    cta: price > 0 ? `Choose ${plan.name}` : "Start free",
  };
}

/**
 * Read the plans, or return nothing at all.
 *
 * A marketing page that 500s because the database hiccuped is worse than one
 * with its pricing section missing: the rest of the page still explains the
 * app and still leads to the install. So a failure here is logged and swallowed,
 * and the template hides the section when the list comes back empty.
 */
async function pricingCards() {
  try {
    const plans = await planModel.listActive();
    return plans.map(toCard);
  } catch (err) {
    console.error("Landing page could not read plans:", err.message);
    return [];
  }
}

module.exports = { pricingCards, toCard, featuresOf, periodOf };
