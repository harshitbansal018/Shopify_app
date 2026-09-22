// landing/policy.js
//
// The privacy policy, as data: one section per heading, paragraphs and lists
// in plain text. The template (views/policy.ejs) lays it out; nothing in here
// is HTML, so the wording can be changed without opening a template.
//
// Every statement below describes what the code actually does. Check the
// place named beside it before changing the words -- a policy that promises
// less than the app collects is the one that gets an app delisted.
//
//   stores, customers, orders   config/migrate.js (the tables)
//   what is deleted, and when   controllers/webhookController.js (the three
//                               compliance webhooks) and storeModel.markUninstalled
//   emails                      services/notifications.js, services/mailer.js
//   billing                     services/billing.js, models/planModel.js

const { COMPANY, PRODUCT } = require("./content");

/** Shown at the top; update it whenever a section below changes. */
const UPDATED = "21 September 2026";

const SECTIONS = [
  {
    id: "who",
    title: "Who we are",
    paragraphs: [
      `${PRODUCT.name} is a Shopify app made by ${COMPANY.name}. It connects a ` +
        `supplier's Shopify store (the source) to a seller's Shopify store (the ` +
        `destination) so that products, orders and payments can flow between them.`,
      `This policy explains what information the app collects from the stores ` +
        `that install it, why, how long it is kept, and how to have it removed. ` +
        `It applies to every store that installs ${PRODUCT.name}, in either role.`,
      `Questions about it go to ${COMPANY.email}.`,
    ],
  },
  {
    id: "collect",
    title: "What we collect",
    paragraphs: [
      "The app only reads what it needs to do its job, using the permissions " +
        "you approve when you install it. It stores the following.",
    ],
    list: [
      "About your store: its .myshopify.com address, its name, its currency, " +
        "and the email address on the Shopify account, which we use to send " +
        "the notification emails described below. We also hold the access " +
        "token Shopify issues so the app can act on your store; it is stored " +
        "encrypted and is deleted the moment you uninstall.",
      "Products: for a source store, the products you choose to share -- " +
        "titles, descriptions, images, variants, SKUs, barcodes, prices, cost " +
        "and stock levels. For a destination store, the products created there " +
        "from a source, so the app can keep them in step.",
      "Orders: for a destination store, orders that include a synced product " +
        "-- the order number, the line items, the amounts, and the shipping " +
        "address. This is what lets the supplier know what to send and where.",
      "Customers: for those orders only, the shopper's name, email address, " +
        "phone number and addresses, as Shopify sends them with the order.",
      "Payments between the two stores that a destination records in the app, " +
        "and the plan a destination has chosen.",
      "Notification emails the app has sent or queued, so that a store can " +
        "see what was sent and when.",
    ],
  },
  {
    id: "use",
    title: "How we use it",
    paragraphs: [
      "For one purpose: running the connection between the two stores you " +
        "have linked. In practice that means copying products from the source " +
        "to the destination, routing each destination sale to the supplier who " +
        "fulfils it, passing the supplier's shipping and tracking details back " +
        "to the destination's order, working out what one store owes the " +
        "other, and sending the notification emails each store has switched on.",
      "We do not sell this information, use it for advertising, build profiles " +
        "from it, or use it for anything other than the service described here.",
    ],
  },
  {
    id: "share",
    title: "Who sees it",
    paragraphs: [
      "The two stores on a connection see each other's data only as far as " +
        "the job requires, and no further.",
    ],
    list: [
      "A source store sees the orders it has been asked to supply: the order " +
        "number, the items, the quantities, its own prices, and the shipping " +
        "address. It does not see what the shopper paid or the destination's " +
        "margin.",
      "A destination store sees the products a source has offered it, the " +
        "supplier's price for each order, and the tracking the supplier adds.",
      "Notification emails are sent through a transactional email provider on " +
        "our behalf. They contain order numbers, store names, amounts and " +
        "tracking numbers. They never contain a shopper's name, address or " +
        "contact details.",
      "Shopify receives what the app writes to your store through its API -- " +
        "products, fulfilments and cancellations -- and handles all billing. We " +
        "never see your payment card details.",
      "We do not share your data with anyone else, except where the law " +
        "requires it.",
    ],
  },
  {
    id: "keep",
    title: "How long we keep it",
    list: [
      "While the app is installed, for as long as it is needed to run the " +
        "connection.",
      "When you uninstall, your store's access token is deleted immediately, " +
        "so the app can no longer reach your store. Your other data is kept for " +
        "48 hours in case you reinstall, after which Shopify sends us a " +
        "shop/redact request and we delete everything held about your store: " +
        "its connections, products, orders, customers, payments and emails.",
      "When a shopper asks a store to delete their data and the store passes " +
        "that on through Shopify (customers/redact), we delete the shopper's " +
        "profile and remove their name and contact details from any order we " +
        "hold. The order itself is kept, anonymised, because it is part of " +
        "the two stores' financial record.",
      "When a shopper asks a store for a copy of their data (customers/" +
        "data_request), we provide what we hold about them to that store.",
    ],
  },
  {
    id: "security",
    title: "How we protect it",
    list: [
      "Shopify access tokens are encrypted at rest with a key held outside " +
        "the database.",
      "Every request to the app is authenticated with a Shopify session token " +
        "and tied to exactly one store. One store cannot read another's data " +
        "through the app.",
      "Data is stored in a database that is not reachable from the internet, " +
        "and all traffic to and from the app uses HTTPS.",
      "Webhooks from Shopify are verified with the HMAC signature Shopify " +
        "attaches to each one before anything is acted on.",
    ],
  },
  {
    id: "rights",
    title: "Your rights",
    paragraphs: [
      "You can uninstall the app at any time from your Shopify admin, which " +
        "starts the deletion described above. You can ask us what we hold " +
        "about your store, ask for it to be corrected, or ask for it to be " +
        `deleted sooner than the 48-hour window, by emailing ${COMPANY.email}.`,
      "Shoppers should contact the store they bought from; Shopify's data " +
        "request and redaction tools pass those requests to us automatically.",
      "Depending on where you are, you may have further rights under data " +
        "protection law such as the GDPR or the CCPA. We honour those " +
        "regardless of where you are.",
    ],
  },
  {
    id: "changes",
    title: "Changes to this policy",
    paragraphs: [
      "If we change what we collect or how we use it, we will update this " +
        "page and the date at the top. A change that reduces your privacy " +
        "will be announced in the app before it takes effect.",
    ],
  },
  {
    id: "contact",
    title: "Contact",
    paragraphs: [
      `${COMPANY.name} -- ${COMPANY.email}`,
    ],
  },
];

module.exports = { UPDATED, SECTIONS };
