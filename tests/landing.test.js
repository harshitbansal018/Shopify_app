require("dotenv").config({ quiet: true });

const path = require("path");
const ejs = require("ejs");

const SERVER = path.join(__dirname, "..");
const LANDING = path.join(SERVER, "landing");

const content = require(path.join(LANDING, "content"));
const { toCard, featuresOf, periodOf } = require(path.join(LANDING, "pricing"));

let passed = 0;
let failed = 0;

/**
 * Copy as it appears in the HTML.
 *
 * EJS escapes what `<%= %>` prints, so an apostrophe in "supplier's price"
 * reaches the page as `&#39;`. Comparing raw copy against the rendered page
 * would fail on exactly the strings that read most naturally.
 */
function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#39;");
}

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

/** A plan row, as the database hands it over. */
function planRow(over = {}) {
  return {
    id: 1,
    name: "Pro",
    price: 25,
    is_popular: 1,
    is_active: 1,
    days: 30,
    max_limit: 1000,
    plan_content: JSON.stringify(["Everything in Basic", "Priority support"]),
    ...over,
  };
}

console.log("\nPricing comes from the plans table");
{
  const pro = toCard(planRow());

  check("the name is the plan's name", pro.name === "Pro");
  check("a price becomes a dollar amount", pro.priceLabel === "$25", pro.priceLabel);
  check("30 days reads as a month", pro.period === "month", pro.period);
  check("is_popular decides which card is lifted", pro.popular === true);
  check("max_limit comes through for the headline", pro.limit === 1000);
  // The limit lines are written from the columns, then plan_content's extras
  // -- the same function the in-app Plans screen uses.
  check("the product limit line comes from max_limit",
    pro.features[0] === "Up to 1,000 synced products", pro.features[0]);
  check("then the extras from plan_content",
    pro.features[1] === "Everything in Basic" && pro.features.length === 3,
    JSON.stringify(pro.features));

  const unlimited = toCard(planRow({
    max_limit: null, max_orders: null, max_emails: 500, max_sources: 1,
    plan_content: "[]",
  }));
  check("an empty limit column reads Unlimited",
    unlimited.features.includes("Unlimited synced products") &&
      unlimited.features.includes("Unlimited orders"),
    JSON.stringify(unlimited.features));
  check("and a set one reads as a number",
    unlimited.features.includes("Up to 500 emails / month") &&
      unlimited.features.includes("1 source store"));

  // Free is a word, and a free plan has no billing period beside it.
  const free = toCard(planRow({ name: "Free", price: 0, is_popular: 0, days: 30 }));

  check("a zero price reads as Free", free.priceLabel === "Free", free.priceLabel);
  check("and carries no billing period", free.period === null,
    "'Free / month' is nonsense");
  check("its button invites rather than sells",
    free.cta === "Start free", free.cta);

  check("a yearly plan says year",
    periodOf({ days: 365 }) === "year");
  check("an odd period is shown as the days it really is",
    periodOf({ days: 90 }) === "90 days", periodOf({ days: 90 }));
  check("no period at all is left off", periodOf({ days: null }) === null);

  // A plan whose features cannot be read is still a plan with a name and a
  // price. Taking the page down over it would be the wrong trade.
  const broken = featuresOf({ id: 9, plan_content: "{not json" });

  check("unreadable plan_content does not throw",
    Array.isArray(broken) && broken.length === 0);
  check("neither does a null one",
    featuresOf({ plan_content: null }).length === 0);
  check("nor a JSON value that is not a list",
    featuresOf({ plan_content: '{"a":1}' }).length === 0);

  // Prices live in ONE place. A number typed into the copy would be the thing
  // that drifts from the database the first time someone edits a plan.
  const copy = JSON.stringify(content);

  check("no price is hard-coded in the page copy",
    !/\$\s?\d/.test(copy),
    "the page would quote one number while Shopify charged another");
}

/* The rest awaits, and this file is CommonJS -- so it runs inside an async
 * IIFE rather than at the top level. */
(async () => {

console.log("\nTelling a visitor from the Shopify admin");
{
  // The router's own test: load it and drive its "/" handler with fake
  // requests. next() being called is what hands the request to the app.
  const router = require(path.join(LANDING, "index"));

  // The layer that handles GET "/" -- the conditional one.
  const layer = router.stack.find(
    (entry) => entry.route && entry.route.path === "/"
  );

  check("the router owns GET /", Boolean(layer));

  const handler = layer.route.stack[0].handle;

  async function decide(query) {
    let handedOn = false;
    let rendered = false;

    const req = { query };
    const res = {
      render() {
        rendered = true;
      },
    };

    await handler(req, res, () => {
      handedOn = true;
    });

    return { handedOn, rendered };
  }

  // A person typing the address in. Nothing on the query string.
  check("a bare visit renders the site",
    (await decide({})).rendered === true);

  /* Everything Shopify puts on the URL when it opens an embedded app. Each
   * one alone has to be enough: getting this wrong shows a merchant a
   * marketing page instead of their dashboard. */
  for (const key of ["shop", "host", "id_token", "embedded", "hmac"]) {
    const outcome = await decide({ [key]: "x" });

    check(`?${key} is handed to the app`,
      outcome.handedOn === true && outcome.rendered === false,
      "the merchant would land on the marketing page");
  }

  // The auth middleware's own retry marker. It means a session bounce is in
  // progress, which is the app's business and not the site's.
  check("?shopify-reload is handed to the app",
    (await decide({ "shopify-reload": "1" })).handedOn === true);

  // /home is the preview address and must never defer, or it could not be
  // opened from inside the admin where Shopify's parameters are always set.
  const home = router.stack.find(
    (entry) => entry.route && entry.route.path === "/home"
  );

  check("/home exists as its own address", Boolean(home));
}

console.log("\nThe page itself");
{
  const plans = [
    planRow({ id: 1, name: "Free", price: 0, is_popular: 0, max_limit: 25,
      plan_content: JSON.stringify(["Up to 25 synced products"]) }),
    planRow({ id: 3, name: "Pro", price: 25, is_popular: 1 }),
  ].map(toCard);

  const html = await ejs.renderFile(
    path.join(LANDING, "views/landing.ejs"),
    { ...content, plans, host: "https://app.example.com", year: 2026 }
  );

  check("it renders", html.length > 5000, String(html.length));

  /* ---- the company and the product ---- */
  check("it is branded as the company's app",
    html.includes("Stellen Infotech") && html.includes("SyncHub"));
  check("the title names the app and says what it does",
    /<title>[^<]*SyncHub[^<]*<\/title>/.test(html) &&
      html.includes(esc(content.PRODUCT.summary.split(".")[0])),
    (html.match(/<title>[\s\S]*?<\/title>/) || [])[0]);
  check("and there is a description for search and link previews",
    html.includes('name="description"') && html.includes('property="og:title"'));

  /* ---- the one thing the page is for ---- */
  check("the install form posts to the app's real install route",
    html.includes('action="/api/auth/install"'),
    "a second install path would be a second thing to keep correct");
  check("it asks for the store address",
    html.includes('name="shop"') && html.includes("mystore.myshopify.com"));
  check("every call to action leads back to it",
    (html.match(/href="#install"/g) || []).length >= 2);

  /* ---- pricing, from the data ---- */
  check("both plans are on the page",
    html.includes(">Free<") && html.includes("Pro"));
  check("the paid price is rendered",
    html.includes("$25") && html.includes("/ month"));
  check("the popular plan is badged",
    html.includes("Most popular"));
  check("the features come from plan_content",
    html.includes("Priority support"));
  // The seeded plans all lead their plan_content with the product limit, so a
  // separate limit line printed the same sentence twice on every card.
  check("and the limit is not also printed on its own line",
    !html.includes('class="plan__limit"'),
    "every card said 'Up to N synced products' twice");

  // The section disappears rather than taking the page with it.
  const noPlans = await ejs.renderFile(
    path.join(LANDING, "views/landing.ejs"),
    { ...content, plans: [], host: "", year: 2026 }
  );

  check("with no plans the page still renders",
    noPlans.length > 3000 && noPlans.includes("/api/auth/install"),
    "a database hiccup must not cost the whole page");
  check("and the pricing section is simply absent",
    !noPlans.includes('id="pricing"'));

  /* ---- the hero: pitch left, picture right ---- */
  check("the hero is split into copy and artwork",
    html.includes('class="hero__copy"') && html.includes('class="hero__art"'),
    "centred, the eye travels back to the middle for every line");
  check("the copy comes first in the markup",
    html.indexOf('hero__copy') < html.indexOf('hero__art'),
    "the headline and the form must not be pushed below the fold on a phone");
  check("the install form is inside the copy column",
    html.indexOf('hero__copy') < html.indexOf('id="install"') &&
      html.indexOf('id="install"') < html.indexOf('hero__art'));
  check("the artwork is hidden from screen readers",
    /class="hero__art"[^>]*aria-hidden="true"/.test(html),
    "every claim it makes is already in the copy beside it");

  // The two prices and the percentage between them come from ONE number, so
  // they cannot end up contradicting each other on screen.
  const preview = content.HERO.preview;
  const first = preview.rows[0];
  const marked = (first.cost * (1 + preview.markup / 100)).toFixed(2);

  check("the supplier's price is shown",
    html.includes(`$${first.cost.toFixed(2)}`), `$${first.cost.toFixed(2)}`);
  check("and the retail price is CALCULATED from the markup, not typed",
    html.includes(`$${marked}`),
    `${first.cost} at +${preview.markup}% is ${marked}`);
  check("the markup is named on the picture",
    html.includes(`+${preview.markup}%`));
  check("every product appears in both stores",
    preview.rows.every(
      (row) => (html.match(new RegExp(esc(row.title), "g")) || []).length === 2
    ),
    "the point of the picture is the same catalogue at two prices");

  /* ---- self-contained ---- */
  check("nothing is loaded from a CDN",
    !/https?:\/\/(?!app\.example\.com|stelleninfotech)/.test(
      html.replace(/https?:\/\/www\.w3\.org/g, "")
    ),
    "it has to load behind a proxy and tell no third party who visited");
  check("it uses its own stylesheet, not the admin's",
    html.includes("/landing-assets/landing.css") && !html.includes("/css/app.css"),
    "one file serving both is how a marketing change moves a dashboard button");

  /* ---- works without scripts ---- */
  check("there is no JavaScript at all",
    !html.includes("<script"),
    "the accordion is <details>, the nav is anchors, the install is a form");
  check("the FAQ is a native accordion",
    (html.match(/<details/g) || []).length === content.FAQ.items.length);
  check("and every answer is in the markup, so Ctrl+F finds it",
    content.FAQ.items.every((item) => html.includes(esc(item.a.slice(0, 40)))));

  /* ---- the sections the nav promises ---- */
  ["how-it-works", "features", "pricing", "faq"].forEach((id) => {
    check(`the nav's ${id} link has somewhere to land`,
      html.includes(`href="#${id}"`) && html.includes(`id="${id}"`),
      "an anchor to nothing scrolls the page to the top");
  });

  /* ---- accessibility basics ---- */
  check("there is a skip link", html.includes('class="skip"'));
  check("exactly one h1", (html.match(/<h1/g) || []).length === 1);
  check("the logo is decorative, not narrated twice",
    /<img class="nav__logo"[^>]*alt=""/.test(html),
    "the app name is already beside it as text");

  /* ---- the copy is complete ---- */
  check("every feature card made it",
    content.FEATURES.items.every((item) => html.includes(esc(item.title))),
    content.FEATURES.items.filter((item) => !html.includes(esc(item.title)))
      .map((item) => item.title).join(" | "));
  check("so did every step, in order",
    content.STEPS.items.every((step) => html.includes(esc(step.title))) &&
      html.indexOf(esc(content.STEPS.items[0].title)) <
        html.indexOf(esc(content.STEPS.items[3].title)));
  check("and both roles are explained",
    html.includes("Source store") && html.includes("Destination store"));
}

/* Nothing here queries the database, but requiring the router pulls in
 * pricing.js -> planModel -> config/db, which opens a pool. Left open it holds
 * the event loop and the run never exits. */
await require(path.join(SERVER, "config/db")).pool.end();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

})().catch((err) => {
  console.error("\nTest run crashed:", err.stack || err.message);
  process.exitCode = 1;
});
