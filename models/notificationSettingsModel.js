// models/notificationSettingsModel.js
//
// `notification_settings` -- which emails one connection sends, and to whom.
//
// Each store controls the emails it receives. One row per connection, so
// each supplier relationship has its own switches and recipient addresses.
//
// Every switch defaults to ON. A connection nobody has configured should still
// tell the source it has an order to ship.
const { query, pool } = require("../config/db");

/**
 * Every email, in the order the settings screen lists them.
 *
 * `to` identifies the recipient and the role allowed to edit that setting.
 */
const EMAILS = [
  {
    key: "order_created",
    to: "source",
    label: "Order created",
    hint:
      "Emails the source store when one of your sales includes its products, " +
      "so it knows there is an order to ship.",
  },
  {
    key: "order_updates",
    to: "destination",
    label: "Order updates",
    hint:
      "Emails you when the source ships an order, with its tracking, or " +
      "cancels one.",
  },
  {
    key: "payout_destination",
    to: "destination",
    label: "Payout on fulfilment",
    hint:
      "Emails you what you now owe the source each time one of your orders " +
      "is fulfilled, with your running balance.",
  },
  {
    // Key kept from when this went out on every fulfilment: it is the column
    // name, and renaming it would reset every saved choice.
    key: "payout_source",
    to: "source",
    label: "Payment settlement",
    hint:
      "Emails the source store each time you record a payment to it: the " +
      "amount, your reference, and what is still owed. Only its own product " +
      "prices are used; your margin is never shown.",
  },
];

const KEYS = EMAILS.map((email) => email.key);

const column = (key) => `email_${key}`;

/** MySQL hands booleans back as 0/1; the rest of the app wants true/false. */
function hydrate(row) {
  if (!row) return null;

  const settings = { id: row.id, connection_id: row.connection_id };

  KEYS.forEach((key) => {
    settings[key] = Boolean(row[column(key)]);
    settings[`email_to_${key}`] = row[`email_to_${key}`] || null;
  });

  return settings;
}

/** What a connection with no row behaves like: every email on. */
function defaults(connectionId = null) {
  const settings = { id: null, connection_id: connectionId };

  KEYS.forEach((key) => {
    settings[key] = true;
    settings[`email_to_${key}`] = null;
  });

  return settings;
}

/**
 * The switches an event should obey.
 *
 * Never null: a connection with no row still sends its emails, and "all on"
 * is the only safe reading of "not configured".
 */
async function forConnection(connectionId) {
  const rows = await query(
    "SELECT * FROM notification_settings WHERE connection_id = ? LIMIT 1",
    [connectionId]
  );

  return hydrate(rows[0]) || defaults(connectionId);
}

/**
 * Save one connection's switches.
 *
 * Reject invalid recipients before any settings are written. Empty addresses
 * clear an override and restore delivery to the store's default inbox.
 */
function normalizeEmail(value) {
  if (value === null || value === "") return null;
  if (typeof value === "string") {
    const email = value.trim();
    if (!email) return null;
    if (email.length <= 254 && /^[^\s@<>,;:"\\]+@[^\s@<>,;:"\\]+\.[^\s@<>,;:"\\]+$/.test(email)) {
      return email;
    }
  }
  const error = new Error("Enter a valid email address (maximum 254 characters).");
  error.statusCode = 400;
  throw error;
}

/**
 * Update only the supplied columns, so simultaneous saves from the two stores
 * cannot overwrite each other's settings. HTTP callers must provide their role.
 * Unscoped internal callers may still reset all switches with an empty input.
 */
async function save(connectionId, input = {}, emailsTo = {}, { recipientRole = null } = {}) {
  const allCols = [];
  const allVals = [];
  const reset = !recipientRole && Object.keys(input).length === 0 && Object.keys(emailsTo).length === 0;

  EMAILS.filter((email) => !recipientRole || email.to === recipientRole).forEach(({ key }) => {
    if (reset || Object.hasOwn(input, key)) {
      allCols.push(column(key));
      allVals.push(input[key] === false || input[key] === 0 || input[key] === "0" ? 0 : 1);
    }
    const fieldKey = `email_to_${key}`;
    if (Object.hasOwn(emailsTo, fieldKey) || Object.hasOwn(input, fieldKey)) {
      allCols.push(fieldKey);
      allVals.push(normalizeEmail(Object.hasOwn(emailsTo, fieldKey) ? emailsTo[fieldKey] : input[fieldKey]));
    }
  });

  if (!allCols.length) return forConnection(connectionId);

  await pool.query(
    `INSERT INTO notification_settings (connection_id, ${allCols.join(", ")})
     VALUES (?, ${allCols.map(() => "?").join(", ")})
     ON DUPLICATE KEY UPDATE
       ${allCols.map((name) => `${name} = VALUES(${name})`).join(",\n       ")}`,
    [connectionId, ...allVals]
  );

  return forConnection(connectionId);
}

module.exports = { EMAILS, KEYS, defaults, forConnection, save, normalizeEmail };
