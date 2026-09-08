// controllers/helpController.js
//
// Help & Support: how to set the app up, and the five questions each kind of
// merchant actually asks.
//
// The content lives here rather than in the templates so the two roles cannot
// quietly drift apart, and so a test can prove both still have their full set.
// It is static -- nothing here touches the database or Shopify.
//
// Everything below describes what the app REALLY does today. A help page that
// promises behaviour the code does not have is worse than no help page, so
// each answer names the screen or the rule it comes from.
const { renderStoreType } = require("./storeController");

/* ------------------------------------------------------------------ */
/* Installation                                                        */
/* ------------------------------------------------------------------ */

const INSTALL_STEPS = {
  source: [
    {
      title: "Add the app from the Shopify App Store",
      detail:
        "Search for Product Sync, press Add app, and approve the permissions " +
        "Shopify lists. It needs to read your products and variants so it can " +
        "copy them, and to read your orders so it can show you what you have " +
        "been asked to supply. Nothing in your store changes at this point. " +
        "The store you supply has to add the app separately -- installing it " +
        "here does not reach them.",
    },
    {
      title: "Choose Source, once",
      detail:
        "The first time the app opens it asks whether this store is a Source " +
        "or a Destination. Pick Source: this is the store that owns the " +
        "catalogue and ships the goods. The choice is permanent and no screen " +
        "changes it, so if you pick wrong you have to uninstall and start " +
        "again.",
    },
    {
      title: "Generate a pairing code on Stores",
      detail:
        "Open Stores and press Generate a code. Give that code to whoever " +
        "runs the destination store. It lasts a few minutes and can be used " +
        "once. Handing the code over IS your consent, so only give it to " +
        "someone you mean to supply.",
    },
    {
      title: "Stage your products",
      detail:
        "On Products press Add products and pick them from your catalogue. " +
        "They land on the Unshared tab, where nothing has been offered to " +
        "anyone yet. Open a product to see its variants and narrow the list " +
        "if you only want some of them sold.",
    },
    {
      title: "Share what you want them to sell",
      detail:
        "Tick the products on the Unshared tab and press Allow selected. They " +
        "move to Shared and are offered to your connected destination stores. " +
        "Nothing reaches their store until they accept it.",
    },
    {
      title: "Work the orders here",
      detail:
        "When they sell one of your products it appears on Orders with the " +
        "shipping address and your own price. Mark it fulfilled and add a " +
        "tracking number when it ships. Payouts then shows what you have " +
        "earned and what each buyer still owes you.",
    },
  ],

  destination: [
    {
      title: "Add the app from the Shopify App Store",
      detail:
        "Search for Product Sync, press Add app, and approve the permissions " +
        "Shopify lists. This store is asked for the most access, because the " +
        "app writes products into it, sets their stock, publishes them to your " +
        "Online Store, and fulfils or cancels the orders your shoppers place. " +
        "Nothing happens until you accept a product. Your supplier has to add " +
        "the app on their own store separately.",
    },
    {
      title: "Choose Destination, once",
      detail:
        "The first time the app opens it asks whether this store is a Source " +
        "or a Destination. Pick Destination: this is the store that receives " +
        "products and sells them. The choice is permanent and no screen " +
        "changes it, so if you pick wrong you have to uninstall and start " +
        "again.",
    },
    {
      title: "Connect a supplier on Stores",
      detail:
        "Ask the source store for its pairing code and enter it on Stores. " +
        "The connection goes live straight away, and their products start " +
        "appearing for you to accept.",
    },
    {
      title: "Set what you want copied",
      detail:
        "On Settings, tick the fields you want kept in step with the supplier " +
        "and set your price margin. A margin of 10 lists a product costing " +
        "100 at 110. Anything you untick is left alone in your store, not " +
        "blanked.",
    },
    {
      title: "Accept the products you want",
      detail:
        "Products opens on the Unsynced tab, which is what your suppliers " +
        "have offered. Tick the ones you want and press Sync selected. " +
        "Nothing is written into your store until you do. They are created, " +
        "priced with your margin, and published to your Online Store.",
    },
    {
      title: "Watch the orders and settle up",
      detail:
        "When a shopper buys a supplied product, Orders shows what the " +
        "supplier has done about it and their tracking number. Payouts shows " +
        "your profit per supplier and what you still owe them, and is where " +
        "you record the transfers you have made.",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* FAQ                                                                 */
/* ------------------------------------------------------------------ */

const FAQ = {
  source: [
    {
      question: "Can I change this store from Source to Destination later?",
      answer:
        "No. The role is chosen once, the first time the app opens, and no " +
        "screen changes it. Everything the app records hangs off that choice, " +
        "so changing it would leave products and orders pointing the wrong " +
        "way. To switch, uninstall the app and install it again.",
    },
    {
      question: "Do these orders appear in my own Shopify admin?",
      answer:
        "No, and that is deliberate. Nothing is written into your store: no " +
        "order is created, your stock is not moved, and your own Orders list " +
        "is untouched. The job lives on the Orders screen in this app, which " +
        "is where you mark it shipped and add the tracking number.",
    },
    {
      question: "What price am I paid?",
      answer:
        "Your own price, exactly as it is in your catalogue. The destination " +
        "store adds its markup on top when it lists the product, and that " +
        "margin is theirs -- it never comes out of what you are owed. Payouts " +
        "shows the figure per buyer, counting only orders you have marked " +
        "fulfilled.",
    },
    {
      question: "What happens if I press Cannot supply?",
      answer:
        "The shopper's order in the destination store is cancelled and " +
        "refunded, and Shopify emails them about it. It is the one action " +
        "here that reaches another store, and it cannot be undone -- so use " +
        "it only when the goods genuinely will never ship.",
    },
    {
      question: "I deleted a product. Why does the buyer still have it?",
      answer:
        "Deleting a product here stops it syncing and marks it deleted on " +
        "your Products list, but the copy already in the buyer's store is " +
        "left alone. It is their store and their listing, and pulling a " +
        "product they may be actively selling is their decision to make.",
    },
  ],

  destination: [
    {
      question: "Can I change this store from Destination to Source later?",
      answer:
        "No. The role is chosen once, the first time the app opens, and no " +
        "screen changes it. Everything the app records hangs off that choice, " +
        "so changing it would leave products and orders pointing the wrong " +
        "way. To switch, uninstall the app and install it again.",
    },
    {
      question: "A product synced, but it is not on my online store. Why?",
      answer:
        "Three things stop a synced product showing. It may be a draft -- the " +
        "app copies the supplier's status, so a draft at their end is a draft " +
        "at yours. It may have no stock, which many themes hide. Or it was " +
        "created before automatic publishing existed, in which case open it " +
        "in your Shopify admin and publish it to the Online Store by hand. " +
        "Anything synced from now on is published for you.",
    },
    {
      question: "What does the price margin in Settings do?",
      answer:
        "It is added on top of the supplier's price when the product is " +
        "written into your store. A margin of 25 turns a product costing 100 " +
        "into one listed at 125. You keep the difference; the supplier is " +
        "still owed their own 100, which is the figure Payouts shows.",
    },
    {
      question: "If I untick a field in Settings, does it wipe my value?",
      answer:
        "No. An unticked field is simply not sent on the next sync, so " +
        "whatever is in your store stays exactly as it is. Untick Description, " +
        "write your own, and it will not be overwritten. Tick it again and the " +
        "supplier's version comes through on the next update.",
    },
    {
      question: "What happens when my supplier ships an order?",
      answer:
        "They mark it fulfilled in the app and add a tracking number. Your " +
        "real Shopify order is then fulfilled to match, with the same " +
        "tracking, and Shopify emails your shopper the shipping confirmation. " +
        "You do not have to do anything, and Orders shows where each one has " +
        "got to.",
    },
  ],
};

exports.getHelp = async (req, res) => {
  try {
    if (!req.store.store_type) return renderStoreType(req, res);

    const role = req.store.store_type;

    // FAQ first: someone opening Help usually has a question, not a fresh
    // install. The steps are one click away for the times it is the other way.
    const tab = req.query.tab === "install" ? "install" : "faq";

    // Each role has its own screen under views/<role>/.
    res.render(`${role}/help`, {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      tab,
      steps: INSTALL_STEPS[role],
      faq: FAQ[role],
    });
  } catch (err) {
    console.error("Help screen failed:", err.message);
    res.status(500).send("Error loading help");
  }
};

// Exported so a test can prove both roles keep their full set, and that no
// step or answer is left empty.
exports.INSTALL_STEPS = INSTALL_STEPS;
exports.FAQ = FAQ;
