// landing/index.js
//
// The public marketing site. Everything it needs lives in this folder:
//
//   content.js        every word on the page
//   pricing.js        the plans table, shaped into cards
//   views/            the templates
//   public/           the stylesheet
//
// server.js mounts this ONE router and nothing else changes. Nothing in here
// reaches into the app's own views, routes or stylesheet, and nothing in the
// app reaches in here -- so the marketing page can be redesigned without any
// risk to the merchant-facing screens, and the other way round.
const express = require("express");
const path = require("path");

const content = require("./content");
const { pricingCards } = require("./pricing");

const router = express.Router();

const VIEWS = path.join(__dirname, "views");

/**
 * Is this Shopify opening the embedded app, or a person visiting the website?
 *
 * The app's front door and the marketing site are the same URL, because that
 * is the URL merchants are given and the one on the App Store listing. They
 * are told apart by what Shopify puts on the query string: the admin ALWAYS
 * appends shop and host when it opens an embedded app, and App Bridge adds
 * id_token on top. A browser typing the address in has none of them.
 *
 * Getting this wrong in the safe direction matters: an unrecognised request
 * falls through to the app, which knows how to ask for a session. Showing a
 * merchant the marketing page instead of their dashboard would be the bad
 * failure, so anything that smells of Shopify is handed straight on.
 */
function isShopifyRequest(req) {
  return Boolean(
    req.query.shop ||
      req.query.host ||
      req.query.id_token ||
      req.query.embedded ||
      req.query.hmac ||
      req.query["shopify-reload"]
  );
}

/**
 * The stylesheet, served from this folder rather than the app's /public.
 *
 * Its own URL prefix, so it cannot collide with an app asset.
 *
 * setHeaders rather than express.static's own `maxAge`: this router is mounted
 * with the app's routes, which is AFTER the `noStore` middleware has already
 * stamped Cache-Control on the response, and maxAge would be silently
 * overwritten by it. no-store is right for a per-merchant dashboard and pure
 * waste for a marketing stylesheet that only changes on a deploy -- so this
 * sets the header last, and wins.
 */
router.use(
  "/landing-assets",
  express.static(path.join(__dirname, "public"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=3600");
    },
  })
);

/** Build the whole page's data in one place, so both routes below agree. */
async function renderLanding(req, res) {
  res.render(path.join(VIEWS, "landing"), {
    ...content,
    plans: await pricingCards(),
    // Absolute, because the install has to happen at the TOP level and the
    // page may well be open inside something else.
    host: String(process.env.HOST || "").trim().replace(/\/+$/, ""),
    year: new Date().getFullYear(),
  });
}

/**
 * `/` for a visitor; the app for Shopify.
 *
 * next() rather than a redirect when Shopify is asking: the request carries on
 * to storeRoutes and dashboardRoutes exactly as it did before this folder
 * existed, so mounting the landing page cannot change the embedded app's entry
 * path at all.
 */
router.get("/", async (req, res, next) => {
  if (isShopifyRequest(req)) return next();

  try {
    await renderLanding(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * The same page, unconditionally.
 *
 * Worth having as its own address: it is what you send someone to preview a
 * change, and it is reachable from inside the admin, where "/" would always
 * be carrying Shopify's parameters and would never show the site.
 */
router.get("/home", async (req, res, next) => {
  try {
    await renderLanding(req, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
