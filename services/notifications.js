// services/notifications.js
//
// Notification emails: deciding which to send when something happens, and
// sending them afterwards.
//
//   orderCreated()     a destination sale included a source's products
//   orderFulfilled()   the source marked an order shipped
//   orderCancelled()   the source said it cannot supply an order
//   paymentRecorded()  the destination recorded paying the source
//
// Each one reads the connection's switches (set by the DESTINATION, for both
// stores -- see models/notificationSettingsModel.js), checks the destination's
// plan still has emails left this billing month (services/planLimits.js),
// writes the emails into email_outbox, and returns. Nothing is sent inline:
// the background round below does that, so a slow mail server can never hold
// up the order.
//
// Past the plan's email limit an email is recorded as skipped, with the
// reason, and the destination is emailed ONCE per billing month that its
// emails have stopped -- the one message that goes out past the limit.
//
// None of them ever throws. They are called straight after an order or a
// payment has been changed, and that change has to stand whatever happens to
// the email.
const shopify = require("./shopify");
const mailer = require("./mailer");
const templates = require("./emailTemplates");
const planLimits = require("./planLimits");
const storeModel = require("../models/storeModel");
const connectionModel = require("../models/connectionModel");
const orderMappingModel = require("../models/orderMappingModel");
const payoutModel = require("../models/payoutModel");
const notificationSettingsModel = require("../models/notificationSettingsModel");
const emailOutboxModel = require("../models/emailOutboxModel");

/** Tries before an email is given up on and marked failed. */
const MAX_ATTEMPTS = 5;

const OUTBOX_INTERVAL_MS = Number(process.env.EMAIL_OUTBOX_INTERVAL_MS || 30_000);

let outboxTimer = null;
let outboxRunning = false;

/**
 * Run an event hook without letting it throw.
 *
 * A failure here means an email was not queued -- worth a log line, never
 * worth turning "order marked shipped" into a 500 after it already happened.
 */
async function quietly(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`Notification email not queued (${label}):`, err.message);
    return { queued: 0, error: err.message };
  }
}

/**
 * Tell the destination, once per billing month, that its emails have stopped.
 *
 * Keyed on the store and the start of the billing month, so however many
 * emails are held back after the limit, this goes exactly once -- and again
 * next month if it happens again. Its kind, plan_notice, is not counted
 * against the plan: it is the app talking about the plan.
 */
async function noticeEmailsPaused(connectionId, destinationStoreId, allowance) {
  const email = templates.emailsPaused({
    planName: allowance.planName,
    used: allowance.used,
    limit: allowance.limit,
    resumesOn: allowance.period.end,
  });

  await emailOutboxModel.enqueue({
    connectionId,
    recipientStoreId: destinationStoreId,
    kind: "plan_notice",
    dedupeKey: `plan_notice:emails:${destinationStoreId}:${allowance.period.start.getTime()}`,
    ...email,
  });
}

/**
 * Queue one email, if the destination's plan has any left this month.
 *
 * Past the limit it is written anyway, as skipped with the reason -- so "why
 * did I not get an email" has an answer -- and the destination is told once.
 */
async function gatedEnqueue({
  connectionId,
  destinationStoreId,
  recipientStoreId,
  kind,
  dedupeKey,
  email,
}) {
  const allowance = await planLimits.emailAllowance(destinationStoreId);

  if (!allowance.ok) {
    await emailOutboxModel.enqueue({
      connectionId,
      recipientStoreId,
      kind,
      dedupeKey,
      ...email,
      status: "skipped",
      error:
        `Plan email limit reached: ${allowance.used} of ${allowance.limit} ` +
        `used this billing month.`,
    });

    await noticeEmailsPaused(connectionId, destinationStoreId, allowance);
    return false;
  }

  return emailOutboxModel.enqueue({
    connectionId,
    recipientStoreId,
    kind,
    dedupeKey,
    ...email,
  });
}

/** An order-event email: the mapping says which destination's plan pays. */
function queue(mapping, recipientStoreId, kind, dedupeKey, email) {
  return gatedEnqueue({
    connectionId: mapping.connection_id,
    destinationStoreId: mapping.destination_store_id,
    recipientStoreId,
    kind,
    dedupeKey,
    email,
  });
}

/**
 * When the source marked the order: what makes two fulfilments of the same
 * order two different emails, while a double click on one stays one email.
 */
function stampOf(mapping) {
  const time = new Date(mapping.source_status_at).getTime();
  return Number.isFinite(time) ? time : Date.now();
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

/**
 * A destination sale included this source's products.
 *
 * Takes the mapping row itself, because the caller has just created it. The
 * dedupe key is the mapping, so a redelivered orders/create webhook -- which
 * Shopify does routinely -- does not email the source a second time.
 */
function orderCreated(mapping) {
  return quietly("order created", async () => {
    if (!mapping) return { queued: 0 };

    const settings = await notificationSettingsModel.forConnection(mapping.connection_id);
    if (!settings.order_created) return { queued: 0, off: true };

    const queued = await queue(
      mapping,
      mapping.source_store_id,
      "order_created",
      `order_created:${mapping.id}`,
      templates.orderCreated(mapping)
    );

    return { queued: queued ? 1 : 0 };
  });
}

/**
 * The source shipped an order. One email, to the destination: shipped, and/or
 * what it now owes -- combined into ONE email when both are on.
 *
 * Nothing goes to the source here. Its money email is the settlement, sent
 * when the destination actually records paying it (paymentRecorded below).
 *
 * Read back from the database rather than taken from the caller, so the
 * tracking in the email is the tracking that was actually saved.
 */
function orderFulfilled(mappingId) {
  return quietly("order fulfilled", async () => {
    const mapping = await orderMappingModel.findById(mappingId);

    if (!mapping || mapping.source_fulfillment_status !== "fulfilled") {
      return { queued: 0 };
    }

    const settings = await notificationSettingsModel.forConnection(mapping.connection_id);

    if (!settings.order_updates && !settings.payout_destination) {
      return { queued: 0, off: true };
    }

    let owed = null;

    if (settings.payout_destination) {
      const suppliers = await payoutModel.summaryForDestination(
        mapping.destination_store_id
      );
      const supplier = suppliers.find(
        (row) => row.connection_id === mapping.connection_id
      );

      owed = {
        amount: mapping.source_total,
        currency: mapping.currency || (supplier && supplier.currency) || null,
        outstanding: supplier ? supplier.outstanding : null,
      };
    }

    const queued = await queue(
      mapping,
      mapping.destination_store_id,
      settings.order_updates ? "order_shipped" : "payout_destination",
      `order_fulfilled:${mapping.id}:${stampOf(mapping)}`,
      templates.orderFulfilled(mapping, {
        shipped: settings.order_updates,
        owed,
      })
    );

    return { queued: queued ? 1 : 0 };
  });
}

/** The source cannot supply an order; the destination is told. */
function orderCancelled(mappingId) {
  return quietly("order cancelled", async () => {
    const mapping = await orderMappingModel.findById(mappingId);

    if (!mapping || mapping.source_fulfillment_status !== "cancelled") {
      return { queued: 0 };
    }

    const settings = await notificationSettingsModel.forConnection(mapping.connection_id);
    if (!settings.order_updates) return { queued: 0, off: true };

    const queued = await queue(
      mapping,
      mapping.destination_store_id,
      "order_cancelled",
      `order_cancelled:${mapping.id}`,
      templates.orderCancelled(mapping)
    );

    return { queued: queued ? 1 : 0 };
  });
}

/**
 * The destination recorded paying the source: the settlement email.
 *
 * Every figure in it is the SOURCE's -- its fulfilled orders at its own
 * prices, and what has been recorded against them -- read from the same
 * summary the source's Payouts screen shows, so the email and the screen can
 * never disagree. The destination's retail price, and so its margin, is never
 * in it.
 *
 * Keyed on the payment, so each payment is emailed exactly once.
 */
function paymentRecorded(paymentId) {
  return quietly("payment recorded", async () => {
    const payment = await payoutModel.findById(paymentId);
    if (!payment) return { queued: 0 };

    const settings = await notificationSettingsModel.forConnection(payment.connection_id);
    if (!settings.payout_source) return { queued: 0, off: true };

    const connection = await connectionModel.findById(payment.connection_id);
    if (!connection) return { queued: 0 };

    // Read AFTER the payment was written, so "still owed" already has it
    // taken off.
    const buyers = await payoutModel.summaryForSource(connection.source.id);
    const buyer = buyers.find((row) => row.connection_id === connection.id);

    const queued = await gatedEnqueue({
      connectionId: connection.id,
      destinationStoreId: connection.destination.id,
      recipientStoreId: connection.source.id,
      kind: "payment_settled",
      dedupeKey: `payment_settled:${payment.id}`,
      email: templates.paymentSettled({
        destinationName:
          connection.destination.store_name || connection.destination.shop_domain,
        amount: payment.amount,
        currency: payment.currency || (buyer && buyer.currency) || null,
        reference: payment.reference,
        note: payment.note,
        paidAt: payment.paid_at,
        received: buyer ? buyer.received : null,
        outstanding: buyer ? buyer.outstanding : null,
      }),
    });

    return { queued: queued ? 1 : 0 };
  });
}

/* ------------------------------------------------------------------ */
/* Where an email goes                                                 */
/* ------------------------------------------------------------------ */

const SHOP_EMAIL_QUERY = `query ShopEmail { shop { email } }`;

/**
 * A store's email address: the saved one, or Shopify's, saved for next time.
 *
 * Looked up here rather than at install, so stores installed before
 * notifications existed have one too. Returns `{ email }` or `{ email: null,
 * reason }` for the cases retrying would not fix; throws for the ones it might
 * (Shopify unreachable), so the caller retries those.
 */
async function addressFor(storeId) {
  const store = await storeModel.findById(storeId);

  if (!store) return { email: null, reason: "The store no longer exists." };
  if (store.email) return { email: store.email };

  if (!store.is_active || !store.access_token) {
    return {
      email: null,
      reason: "The store has uninstalled SyncHub, so its address cannot be looked up.",
    };
  }

  const data = await shopify.forShop(store.shop_domain, { query: SHOP_EMAIL_QUERY });
  const email = String((data && data.shop && data.shop.email) || "").trim();

  if (!email) {
    return { email: null, reason: "Shopify has no email address for this store." };
  }

  await storeModel.setEmail(store.id, email);
  return { email };
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

/**
 * Send one queued email. Returns what happened: sent, skipped, failed, or
 * taken (another process claimed it first).
 */
async function sendOne(row) {
  if (!(await emailOutboxModel.claim(row.id))) return "taken";

  try {
    const { email, reason } = await addressFor(row.recipient_store_id);

    if (!email) {
      await emailOutboxModel.markSkipped(row.id, reason);
      return "skipped";
    }

    const result = await mailer.send({
      to: email,
      subject: row.subject,
      html: row.html,
      text: row.text_body,
    });

    if (result.skipped) {
      // In development, with no mail server, this line is the only way to see
      // that the email would have gone out, and to whom.
      console.log(`Email not sent (${result.reason}) -> ${email}: ${row.subject}`);
      await emailOutboxModel.markSkipped(row.id, result.reason, email);
      return "skipped";
    }

    await emailOutboxModel.markSent(row.id, email);
    return "sent";
  } catch (err) {
    await emailOutboxModel.markFailed(row.id, err.message, {
      maxAttempts: MAX_ATTEMPTS,
    });
    return "failed";
  }
}

/** One background round: everything waiting, oldest first. */
async function runOutbox({ limit = 20 } = {}) {
  // A slow round must not overlap the next tick and send the same email twice
  // from the same process. (The claim covers two processes.)
  if (outboxRunning) return { skipped: true };

  outboxRunning = true;

  const totals = { sent: 0, skipped: 0, failed: 0 };

  try {
    const rows = await emailOutboxModel.listPending({
      limit,
      maxAttempts: MAX_ATTEMPTS,
    });

    for (const row of rows) {
      const outcome = await sendOne(row);
      if (outcome in totals) totals[outcome] += 1;
    }
  } finally {
    outboxRunning = false;
  }

  if (totals.sent || totals.failed) {
    console.log(
      `Email outbox: ${totals.sent} sent, ${totals.skipped} skipped, ${totals.failed} failed`
    );
  }

  return totals;
}

/** Start the background round. Safe to call twice; the second is a no-op. */
function startOutbox() {
  if (outboxTimer) return outboxTimer;

  outboxTimer = setInterval(() => {
    runOutbox().catch((err) => console.error("Email outbox round crashed:", err.message));
  }, OUTBOX_INTERVAL_MS);

  // Do not hold the process open just for this.
  if (outboxTimer.unref) outboxTimer.unref();

  console.log(
    `Email outbox running every ${Math.round(OUTBOX_INTERVAL_MS / 1000)}s` +
      (mailer.isConfigured() ? "" : " (no SMTP configured: emails are logged, not sent)")
  );

  return outboxTimer;
}

function stopOutbox() {
  if (!outboxTimer) return;
  clearInterval(outboxTimer);
  outboxTimer = null;
}

module.exports = {
  MAX_ATTEMPTS,
  orderCreated,
  orderFulfilled,
  orderCancelled,
  paymentRecorded,
  addressFor,
  sendOne,
  runOutbox,
  startOutbox,
  stopOutbox,
};
