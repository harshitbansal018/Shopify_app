// services/emailTemplates.js
//
// What each notification email says. One function per email, each returning
// { subject, html, text }.
//
// Plain HTML with inline styles and a single table: that is what survives
// Outlook, Gmail and every phone mail app. No images, no web fonts, no CSS
// classes -- a mail client strips most of it, and what it keeps it renders
// differently everywhere.
//
// The text version is not an afterthought. Some clients show only it, and a
// spam filter reads the lack of one as a warning sign.
//
// Every value from the database goes through escapeHtml. A store name or an
// order name is text a merchant typed, and it is being put into HTML.
const { escapeHtml } = require("../utils/html");

const BRAND = "#0b5368";

function money(amount, currency) {
  const value = Number(amount);
  const shown = Number.isFinite(value) ? value.toFixed(2) : "0.00";
  return currency ? `${currency} ${shown}` : shown;
}

/** A store's human name, falling back to its domain. */
const nameOf = (name, domain) => name || domain || "the other store";

const sourceName = (m) => nameOf(m.source_store_name, m.source_shop_domain);
const destinationName = (m) =>
  nameOf(m.destination_store_name, m.destination_shop_domain);
const orderName = (m) =>
  m.destination_order_name || `#${m.destination_shopify_order_id || m.id}`;

/**
 * Only real web links become links. A tracking URL is stored as the source
 * typed it, and a `javascript:` URL in an email would be an attack on whoever
 * opened it.
 */
function safeUrl(url) {
  return /^https?:\/\//i.test(String(url || "")) ? String(url) : null;
}

/** The shared frame every email sits in. `blocks` are pre-escaped HTML. */
function layout({ heading, blocks }) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f8f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#12191f;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f8f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e7ea;border-radius:12px;">
        <tr><td style="padding:18px 24px;border-bottom:1px solid #e2e7ea;font-weight:700;font-size:15px;color:${BRAND};">SyncHub</td></tr>
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 14px;font-size:19px;line-height:1.35;">${heading}</h1>
          ${blocks.join("\n")}
        </td></tr>
        <tr><td style="padding:14px 24px;border-top:1px solid #e2e7ea;font-size:12px;color:#6f7c86;">
          Sent by SyncHub on behalf of the stores connected to each other.
          Which of these emails are sent is chosen in the destination store's Settings.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const para = (html) =>
  `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#48555f;">${html}</p>`;

/** Label / value rows, for the facts of an order. */
function facts(rows) {
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 0;font-size:13px;color:#6f7c86;width:45%;">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;font-size:13px;font-weight:600;text-align:right;">${escapeHtml(value)}</td></tr>`
    )
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 16px;border-top:1px solid #eef1f3;border-bottom:1px solid #eef1f3;">${body}</table>`;
}

const textFacts = (rows) => rows.map(([label, value]) => `${label}: ${value}`).join("\n");

/* ------------------------------------------------------------------ */
/* To the SOURCE: there is an order to ship                            */
/* ------------------------------------------------------------------ */

/**
 * Deliberately no shipping address and no shopper name. The source sees both
 * in the app, behind a login; an email is forwarded, archived and read on
 * shared screens, and personal data does not belong in it.
 */
function orderCreated(m) {
  const rows = [
    ["Order", orderName(m)],
    ["From", destinationName(m)],
    ["Items", String(m.line_count || 0)],
    ["You are owed", money(m.source_total, m.currency)],
  ];

  return {
    subject: `New order to fulfil: ${orderName(m)} from ${destinationName(m)}`,
    html: layout({
      heading: `New order to fulfil`,
      blocks: [
        para(
          `${escapeHtml(destinationName(m))} has sold your products. ` +
            `Open SyncHub to see the shipping address and mark it shipped.`
        ),
        facts(rows),
      ],
    }),
    text:
      `New order to fulfil\n\n` +
      `${destinationName(m)} has sold your products. Open SyncHub to see the ` +
      `shipping address and mark it shipped.\n\n${textFacts(rows)}\n`,
  };
}

/* ------------------------------------------------------------------ */
/* To the DESTINATION: shipped, and/or what is now owed                */
/* ------------------------------------------------------------------ */

/**
 * One email for one fulfilment, even when both switches are on.
 *
 * "Shipped" and "you now owe" happen at the same moment. Two emails for one
 * click would teach a merchant to ignore both, so the owed section rides along
 * in the shipped email -- and only when shipped updates are OFF does the payout
 * go out on its own.
 */
function orderFulfilled(m, { shipped = true, owed = null } = {}) {
  const blocks = [];
  let text = "";

  if (shipped) {
    blocks.push(
      para(`${escapeHtml(sourceName(m))} has shipped ${escapeHtml(orderName(m))}.`)
    );
    text += `${sourceName(m)} has shipped ${orderName(m)}.\n\n`;

    const parcels = Array.isArray(m.source_tracking) ? m.source_tracking : [];

    if (parcels.length) {
      const items = parcels
        .map((parcel) => {
          const label = [parcel.company, parcel.number].filter(Boolean).join(" ");
          const url = safeUrl(parcel.url);
          return url
            ? `<li style="margin:0 0 4px;"><a href="${escapeHtml(url)}" style="color:${BRAND};">${escapeHtml(label)}</a></li>`
            : `<li style="margin:0 0 4px;">${escapeHtml(label)}</li>`;
        })
        .join("");

      blocks.push(
        `<p style="margin:0 0 6px;font-size:13px;font-weight:600;">Tracking</p>` +
          `<ul style="margin:0 0 16px;padding-left:18px;font-size:13px;color:#48555f;">${items}</ul>`
      );

      text +=
        "Tracking:\n" +
        parcels
          .map((p) => `  - ${[p.company, p.number].filter(Boolean).join(" ")}${safeUrl(p.url) ? ` (${p.url})` : ""}`)
          .join("\n") +
        "\n\n";
    } else {
      blocks.push(para("No tracking number was added for this shipment."));
      text += "No tracking number was added for this shipment.\n\n";
    }
  }

  if (owed) {
    const rows = [["For this order", money(owed.amount, owed.currency)]];

    if (owed.outstanding !== null && owed.outstanding !== undefined) {
      rows.push([`Total owed to ${sourceName(m)}`, money(owed.outstanding, owed.currency)]);
    }

    blocks.push(
      para(
        shipped
          ? `This order now counts towards what you owe ${escapeHtml(sourceName(m))}.`
          : `${escapeHtml(orderName(m))} has been fulfilled by ${escapeHtml(sourceName(m))}, ` +
              `so it now counts towards what you owe them.`
      ),
      facts(rows)
    );

    text += `${textFacts(rows)}\n`;
  }

  return {
    subject: shipped
      ? `${orderName(m)} shipped by ${sourceName(m)}`
      : `You owe ${money(owed && owed.amount, owed && owed.currency)} to ${sourceName(m)} for ${orderName(m)}`,
    html: layout({
      heading: shipped ? `${escapeHtml(orderName(m))} has shipped` : "Payout due",
      blocks,
    }),
    text,
  };
}

/** To the DESTINATION: the source cannot supply it. */
function orderCancelled(m) {
  const reason = m.source_cancel_reason || m.cancel_reason || null;
  const rows = [
    ["Order", orderName(m)],
    ["Cancelled by", sourceName(m)],
  ];
  if (reason) rows.push(["Reason", reason]);

  return {
    subject: `${orderName(m)} cancelled by ${sourceName(m)}`,
    html: layout({
      heading: `${escapeHtml(orderName(m))} was cancelled`,
      blocks: [
        para(
          `${escapeHtml(sourceName(m))} cannot supply this order. SyncHub cancels ` +
            `it in your store and refunds the shopper, so nobody is charged for ` +
            `goods that are not coming.`
        ),
        facts(rows),
      ],
    }),
    text:
      `${orderName(m)} was cancelled\n\n` +
      `${sourceName(m)} cannot supply this order. SyncHub cancels it in your ` +
      `store and refunds the shopper.\n\n${textFacts(rows)}\n`,
  };
}

/* ------------------------------------------------------------------ */
/* To the SOURCE: a payment has been recorded -- the settlement        */
/* ------------------------------------------------------------------ */

/** Anything within half a cent of zero is zero: these are rounded sums. */
const isZero = (value) => Math.abs(Number(value)) < 0.005;

function dateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * The destination has recorded paying the source.
 *
 * Built from the SOURCE's own numbers only: what its fulfilled orders earned
 * at its own prices, and what has been recorded against that. The
 * destination's retail price -- and so its margin -- never appears, the same
 * rule the source's Payouts screen follows.
 *
 * It says "recorded", not "received". SyncHub does not move money, and a
 * supplier treating an email as proof the transfer arrived is how a mistyped
 * amount turns into a dispute.
 *
 * `p` is { destinationName, amount, currency, reference, note, paidAt,
 * received, outstanding } -- received and outstanding already include this
 * payment.
 */
function paymentSettled(p) {
  const amount = money(p.amount, p.currency);
  const known = p.outstanding !== null && p.outstanding !== undefined;
  const settledInFull = known && isZero(p.outstanding);
  const paidAhead = known && !settledInFull && Number(p.outstanding) < 0;

  const rows = [["Amount paid", amount]];

  if (p.reference) rows.push(["Reference", p.reference]);

  const paidOn = p.paidAt ? dateOnly(p.paidAt) : null;
  if (paidOn) rows.push(["Paid on", paidOn]);

  if (p.received !== null && p.received !== undefined) {
    rows.push(["Total received so far", money(p.received, p.currency)]);
  }

  if (known) {
    rows.push(
      paidAhead
        ? ["Paid ahead", money(Math.abs(p.outstanding), p.currency)]
        : ["Still owed to you", money(p.outstanding, p.currency)]
    );
  }

  // The one line that answers "are we square?".
  let status = null;

  if (settledInFull) {
    status = "Everything owed for your fulfilled orders is now settled.";
  } else if (paidAhead) {
    status =
      `${p.destinationName} has paid ${money(Math.abs(p.outstanding), p.currency)} ` +
      `more than your fulfilled orders add up to so far; it counts towards the ` +
      `next ones.`;
  } else if (known) {
    status = `${money(p.outstanding, p.currency)} is still owed for fulfilled orders.`;
  }

  const disclaimer =
    "SyncHub records payments between the two stores; it does not move money. " +
    "Please check this against your bank account before treating it as received.";

  const blocks = [
    para(
      `${escapeHtml(p.destinationName)} has recorded a payment of ` +
        `<strong>${escapeHtml(amount)}</strong> to you for orders you fulfilled.`
    ),
    facts(rows),
  ];

  if (status) {
    blocks.push(
      `<p style="margin:0 0 12px;font-size:14px;font-weight:600;color:${
        settledInFull ? "#0f7b46" : "#12191f"
      };">${escapeHtml(status)}</p>`
    );
  }

  if (p.note) blocks.push(para(`Their note: &ldquo;${escapeHtml(p.note)}&rdquo;`));

  blocks.push(
    `<p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:#6f7c86;">${escapeHtml(disclaimer)}</p>`
  );

  return {
    subject:
      `${p.destinationName} recorded a payment of ${amount}` +
      (settledInFull ? " (settled in full)" : ""),
    html: layout({
      heading: settledInFull ? "Settled in full" : "Payment recorded",
      blocks,
    }),
    text:
      `${settledInFull ? "Settled in full" : "Payment recorded"}\n\n` +
      `${p.destinationName} has recorded a payment of ${amount} to you for ` +
      `orders you fulfilled.\n\n${textFacts(rows)}\n` +
      (status ? `\n${status}\n` : "") +
      (p.note ? `\nTheir note: "${p.note}"\n` : "") +
      `\n${disclaimer}\n`,
  };
}

module.exports = {
  orderCreated,
  orderFulfilled,
  orderCancelled,
  paymentSettled,
  money,
  safeUrl,
};
