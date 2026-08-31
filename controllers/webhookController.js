// controllers/webhookController.js
//
// Every handler here runs behind middleware/verifyWebhook, so the request is
// proven to come from Shopify before any of this executes. Handlers reply 200
// first and do their bookkeeping afterwards -- Shopify retries on anything
// that is slow or non-200.
const storeModel = require("../models/storeModel");
const orderModel = require("../models/orderModel");
const customerModel = require("../models/customerModel");
const productSync = require("../services/productSync");
const { normalizeShopDomain } = require("../utils/shop");

/* ===================== app/uninstalled ===================== */

exports.appUninstalled = async (req, res) => {
  const shop = normalizeShopDomain(req.webhookShop);

  // Acknowledge first; Shopify does not care about our bookkeeping.
  res.status(200).send("OK");

  if (!shop) {
    console.warn("Uninstall webhook had no usable shop domain");
    return;
  }

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) {
      console.log("Uninstall webhook for unknown shop:", shop);
      return;
    }

    // Deactivates, stamps uninstalled_at and drops the revoked tokens.
    // Connections and mappings are deliberately kept so a reinstall resumes.
    await storeModel.markUninstalled(shop);

    console.log("App uninstalled for", shop);
  } catch (err) {
    console.error("Uninstall webhook processing failed:", err.message);
  }
};

/* ===================== products/update ===================== */

/**
 * A product changed at a source store.
 *
 * Nothing here calls Shopify. The payload already carries the whole product,
 * and an outbound call from inside a webhook is what makes Shopify time the
 * request out, retry it, and eventually unsubscribe the topic altogether.
 * Refreshing the cache and queueing is all that happens; the push itself is
 * the background job's problem.
 */
exports.productsUpdate = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};

  if (!shop || !payload.id) return;

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) return;

    // A DESTINATION firing this is usually our own push echoing back, but it
    // is also how a merchant deleting a variant in their own admin reaches us.
    // Reconciling is safe: it makes no Shopify call and queues no push, so it
    // cannot loop.
    if (store.store_type === "destination") {
      const echo = await productSync.applyDestinationUpdate(store.id, payload);

      if (echo && echo.dropped) {
        console.log(
          `products/update ${shop} #${payload.id}: ` +
            `${echo.dropped} variant(s) no longer in the destination store`
        );
      }
      return;
    }

    if (store.store_type !== "source") return;

    const result = await productSync.applySourceUpdate(store.id, payload);

    if (!result) return; // not a product this app stages

    console.log(
      `products/update ${shop} #${payload.id}: ` +
        `${result.requeued} mapping(s) queued`
    );
  } catch (err) {
    console.error("products/update processing failed:", err.message);
  }
};

/* ===================== products/delete ===================== */

exports.productsDelete = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};

  if (!shop || !payload.id) return;

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) return;

    // The destination's own merchant deleted a product we created there. The
    // offer goes back to "waiting for you" rather than being pushed again --
    // re-creating it would be the app overruling a deliberate deletion.
    if (store.store_type === "destination") {
      const gone = await productSync.applyDestinationDelete(store.id, payload.id);

      if (gone) {
        console.log(
          `products/delete ${shop} #${payload.id}: ` +
            `${gone.mappings} offer(s) returned to waiting`
        );
      }
      return;
    }

    if (store.store_type !== "source") return;

    // The mapping rows are marked, never deleted: they record what this
    // product became on each destination, which a hard delete would lose.
    const result = await productSync.applySourceDelete(store.id, payload.id);

    if (!result) return;

    console.log(
      `products/delete ${shop} #${payload.id}: ` +
        `${result.marked} mapping(s) marked deleted`
    );
  } catch (err) {
    console.error("products/delete processing failed:", err.message);
  }
};

/* ===================== mandatory privacy webhooks ===================== */
/*
 * Shopify requires all three endpoints to exist and to return 200, and checks
 * them during app review.
 *
 * The orders and customers tables hold personal data -- name, email, phone and
 * addresses -- so the two customer topics are real obligations here, not stubs.
 */

/**
 * A customer has asked what this app holds about them.
 *
 * Shopify gives 30 days to supply it, and expects the APP to hand it to the
 * merchant, who passes it on. This assembles the record; delivering it is a
 * channel decision (email, download) that is not built yet -- until it is, the
 * data is written to the log so a request can still be answered by hand.
 */
exports.customersDataRequest = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};
  const customerId = payload.customer && payload.customer.id;

  if (!shop || !customerId) return;

  try {
    const store = await storeModel.findByDomain(shop);
    if (!store) return;

    const email = payload.customer.email || null;

    const [profile, orders] = await Promise.all([
      customerModel.dataForCustomer(store.id, customerId, email),
      orderModel.dataForCustomer(store.id, customerId),
    ]);

    console.log(
      `customers/data_request for ${shop}: customer ${customerId} has ` +
        `${orders.length} order(s) on record`,
      JSON.stringify({
        customer_id: customerId,
        profile,
        orders: orders.map((o) => ({
          order: o.name,
          placed_at: o.shopify_created_at,
          total: o.total_price,
          currency: o.currency,
          billing_address: o.billing_address,
          shipping_address: o.shipping_address,
          line_items: o.line_items.map((l) => ({
            title: l.title,
            quantity: l.quantity,
            price: l.price,
          })),
        })),
      })
    );
  } catch (err) {
    console.error("customers/data_request failed:", err.message);
  }
};

/**
 * A customer has asked to be erased.
 *
 * Handled differently in the two tables, on purpose:
 *   orders     anonymised in place -- a merchant must retain sales records, so
 *              the money, dates and line items stay and the person goes
 *   customers  deleted outright -- strip the personal fields and nothing of
 *              value is left behind
 */
exports.customersRedact = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};
  const customerId = payload.customer && payload.customer.id;

  if (!shop || !customerId) return;

  try {
    const store = await storeModel.findByDomain(shop);
    if (!store) return;

    const email = payload.customer.email || null;

    // Orders are anonymised in place -- the sale must survive the person.
    // The customer row itself is deleted; nothing in it is worth keeping.
    const [redactedOrders, deletedCustomers] = await Promise.all([
      orderModel.redactCustomer(store.id, customerId),
      customerModel.redactCustomer(store.id, customerId, email),
    ]);

    console.log(
      `customers/redact for ${shop}: customer ${customerId} -- ` +
        `${redactedOrders} order(s) anonymised, ${deletedCustomers} customer row(s) deleted`
    );
  } catch (err) {
    console.error("customers/redact failed:", err.message);
  }
};

exports.shopRedact = async (req, res) => {
  const shop = normalizeShopDomain(req.webhookShop);

  res.status(200).send("OK");

  if (!shop) return;

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) return;

    // Every dependent table is ON DELETE CASCADE, so this also clears the
    // connections, cached products and variants, mappings, orders and customers.
    await storeModel.deleteStore(shop);

    console.log("shop/redact completed for", shop);
  } catch (err) {
    console.error("shop/redact processing failed:", err.message);
  }
};
