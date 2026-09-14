
const COMPANY = {
  name: "Stellen Infotech",
  site: "https://stelleninfotech.com",
  email: "support@stelleninfotech.com",
  tagline: "Shopify apps built for merchants who sell across more than one store.",
};

const PRODUCT = {
  name: "SyncHub",
  // One sentence, used as the browser title's suffix and the meta description.
  summary:
    "Sync products between two Shopify stores, sell them at your own price, " +
    "and route every order back to the supplier automatically.",
};

/**
 * The first screen. One promise, one sentence of detail, one thing to do.
 *
 * `proof` is the strip under the buttons: small, concrete, checkable claims --
 * not testimonials we do not have.
 */
const HERO = {
  eyebrow: "SyncHub by " + COMPANY.name,
  title: "Sell your supplier's catalogue as if it were your own.",
  subtitle:
    "SyncHub connects a supplier's Shopify store to yours. Their products " +
    "appear in your catalogue at your price, and every sale you make routes " +
    "straight back to them at theirs — with fulfilment, tracking and payouts " +
    "kept in step.",
  primaryCta: "Install on Shopify",
  secondaryCta: "See how it works",
  proof: [
    "No code or theme changes",
    "Free plan, no card required",
    "Your store is never written to without your approval",
  ],

  /*
   * The picture beside the headline.
   *
   * Drawn from this data rather than being a screenshot: a screenshot goes
   * stale the day the UI changes, needs re-exporting at two resolutions, and
   * is unreadable on a phone. This stays sharp, weighs nothing, and says the
   * one thing the whole app is about -- the same products, two prices.
   *
   * `cost` is the supplier's price and `markup` the buyer's margin. The retail
   * price is CALCULATED from them in the template, so the two numbers on
   * screen can never contradict the percentage printed between them.
   */
  preview: {
    markup: 40,
    source: { label: "Source store", domain: "warehouse.myshopify.com" },
    destination: { label: "Your store", domain: "urban-threads.myshopify.com" },
    rows: [
      { title: "Merino Wool Beanie", meta: "3 variants", cost: 12, tone: "a" },
      { title: "Canvas Weekender Bag", meta: "2 variants", cost: 45, tone: "b" },
      { title: "Leather Card Holder", meta: "5 variants", cost: 18, tone: "c" },
    ],
  },
};


const ROLES = {
  title: "Two stores, one catalogue",
  intro:
    "Every store picks a side when it installs, and keeps it. That is what " +
    "makes the direction of every product, order and payment unambiguous.",
  cards: [
    {
      icon: "box",
      label: "Source store",
      role: "The supplier",
      body:
        "Owns the catalogue and the stock. Chooses which products — and which " +
        "variants of them — go out to which stores, then packs and ships " +
        "whatever sells.",
      points: [
        "Stage products without sending them anywhere",
        "Share a product with one buyer, or all of them",
        "Work every incoming order from one screen",
      ],
    },
    {
      icon: "share",
      label: "Destination store",
      role: "The seller",
      body:
        "Receives the supplier's products, sets the margin, and sells to its " +
        "own customers. Nothing reaches its Shopify catalogue until it says so.",
      points: [
        "Approve each product before it is created",
        "Add your margin once; it applies to everything",
        "See profit and what you still owe, per supplier",
      ],
    },
  ],
};

/**
 * What the app actually does. Every one of these is a real screen or a real
 * behaviour -- nothing aspirational, because a landing page that promises what
 * the app does not do is the fastest way to an uninstall.
 */
const FEATURES = {
  title: "Everything the handover needs",
  intro:
    "Not just a product copier. The whole path from a supplier's catalogue to " +
    "a shopper's parcel, and the money that follows it.",
  items: [
    {
      icon: "sliders",
      title: "Choose the product, or just some of its variants",
      body:
        "Share a whole product, or only the sizes and colours you want a " +
        "particular store to sell. Variants left out are never created there.",
    },
    {
      icon: "tag",
      title: "Your margin, applied automatically",
      body:
        "Set a percentage per supplier. Every price and compare-at price " +
        "arrives marked up, and stays marked up when the supplier changes theirs.",
    },
    {
      icon: "check",
      title: "Nothing is written to your store without approval",
      body:
        "A shared product waits on your Products screen until you accept it. " +
        "Decline it and it is simply never created.",
    },
    {
      icon: "link",
      title: "Field-level sync control",
      body:
        "Decide which fields follow the supplier — title, description, images, " +
        "tags, status, metafields, stock, cost. Switch one off and your own " +
        "value is kept, not blanked.",
    },
    {
      icon: "truck",
      title: "Orders route back at the supplier's price",
      body:
        "A sale in your store becomes a job in theirs, listing their price, " +
        "not the one your shopper paid. They mark it shipped with tracking, and " +
        "it lands on your Shopify order.",
    },
    {
      icon: "wallet",
      title: "Payouts both sides can agree on",
      body:
        "Revenue, cost, profit and what is still owed — worked out from " +
        "fulfilled orders only, and never from a running balance that can drift.",
    },
    {
      icon: "download",
      title: "Published to your storefront",
      body:
        "A synced product is put on the Online Store channel, so it is live " +
        "rather than sitting invisible in the catalogue.",
    },
    {
      icon: "key",
      title: "Connected by a pairing code",
      body:
        "The supplier generates a short-lived code and the buyer enters it. " +
        "No shared logins, and no store can connect to yours uninvited.",
    },
  ],
};

/** The install, told honestly: four steps, both roles, in order. */
const STEPS = {
  title: "Live in four steps",
  intro:
    "Both stores install the same app. Which screens you see depends on the " +
    "side you picked.",
  items: [
    {
      icon: "download",
      title: "Install on both stores",
      body:
        "The supplier and the seller each add SyncHub to their own Shopify " +
        "admin. Nothing is shared until they are connected.",
    },
    {
      icon: "tag",
      title: "Pick a side",
      body:
        "Source if you own the catalogue, Destination if you are selling " +
        "someone else's. Chosen once, on first open.",
    },
    {
      icon: "key",
      title: "Pair the stores",
      body:
        "The source generates a pairing code. The destination enters it, and " +
        "the connection goes live straight away.",
    },
    {
      icon: "share",
      title: "Share and approve",
      body:
        "The source shares products; the destination approves them and they " +
        "are created, priced and published. Orders start flowing back on the " +
        "first sale.",
    },
  ],
};

/**
 * Landing-page FAQ -- deliberately NOT the in-app FAQ.
 *
 * The `faqs` table answers "how do I do this now that I have installed it".
 * These answer "should I install it at all", which is a different audience
 * asking different questions. Keeping them apart stops each set being watered
 * down to serve both.
 */
const FAQ = {
  title: "Questions before you install",
  items: [
    {
      q: "Do both stores need the app?",
      a:
        "Yes. The supplier installs it to share products and work the orders, " +
        "and the seller installs it to receive them. Each store keeps its own " +
        "admin, its own customers and its own billing.",
    },
    {
      q: "Will it change products I already have?",
      a:
        "No. SyncHub only ever creates and updates the products it brought in " +
        "itself. Anything already in your catalogue is left exactly as it is.",
    },
    {
      q: "Can the supplier see my customers or my prices?",
      a:
        "No. The supplier sees the shipping address it needs to post the " +
        "parcel and the price it is owed. What your shopper paid, and " +
        "therefore your margin, is never shown to them.",
    },
    {
      q: "What happens if I disconnect a supplier?",
      a:
        "You choose. Removing a store from your Stores screen deletes the " +
        "products it put in your catalogue, and the confirmation tells you " +
        "exactly how many before you agree to it.",
    },
    {
      q: "Does it work with variants and inventory?",
      a:
        "Yes. Variants carry their SKU, barcode, price, cost and stock, and " +
        "stock stays in step as the supplier sells or restocks.",
    },
    {
      q: "Is there a free plan?",
      a:
        "There is. Start on Free, sync a handful of products, and move up only " +
        "when the catalogue outgrows it. No card is needed to begin.",
    },
  ],
};

/** The last thing on the page, for anyone who scrolled past the first button. */
const CLOSING = {
  title: "Put your supplier's catalogue to work",
  body:
    "Install SyncHub on your store and connect your first supplier in a few " +
    "minutes. The Free plan is enough to see the whole flow end to end.",
  cta: "Install on Shopify",
};

const FOOTER = {
  columns: [
    {
      title: "Product",
      links: [
        { label: "How it works", href: "#how-it-works" },
        { label: "Features", href: "#features" },
        { label: "Pricing", href: "#pricing" },
        { label: "FAQ", href: "#faq" },
      ],
    },
    {
      title: "Get started",
      links: [
        { label: "Install on Shopify", href: "/api/auth/install" },
        { label: "Already installed? Open the app", href: "/api/auth/install" },
      ],
    },
  ],
  // Kept small and honest: link to pages that exist.
  legal: "All trademarks are the property of their respective owners. " +
    "Shopify is a trademark of Shopify Inc.",
};

module.exports = { COMPANY, PRODUCT, HERO, ROLES, FEATURES, STEPS, FAQ, CLOSING, FOOTER };
