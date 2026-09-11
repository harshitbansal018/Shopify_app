
const planModel = require("../models/planModel");

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
    // The limits first, written from the plan's columns, then its extras --
    // the same lines the in-app Plans screen shows, from the same function.
    features: planModel.featureLines(plan),
    // The headline limit, which is what most people actually compare on.
    limit: Number(plan.max_limit) || null,
    cta: price > 0 ? `Choose ${plan.name}` : "Start free",
  };
}


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
