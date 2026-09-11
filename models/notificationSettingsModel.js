// models/notificationSettingsModel.js
//
// `notification_settings` -- which emails one connection sends, and to whom.
//
// Decided entirely by the DESTINATION store, including the two emails that go
// to the source: that is the product decision, and the settings screen exists
// only on the destination side. One row per connection, so each supplier
// relationship has its own switches -- a destination working with two sources
// decides for each separately, and only ever about its OWN orders.
//
// Every switch defaults to ON. A connection nobody has configured should still
// tell the source it has an order to ship.
const { query, pool } = require("../config/db");

/**
 * Every email, in the order the settings screen lists them.
 *
 * `to` is who RECEIVES it, which the screen shows beside each switch: the
 * destination is deciding on the source's behalf for two of these, and it
 * should never be unclear which inbox a tick affects.
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
  });

  return settings;
}

/** What a connection with no row behaves like: every email on. */
function defaults(connectionId = null) {
  const settings = { id: null, connection_id: connectionId };

  KEYS.forEach((key) => {
    settings[key] = true;
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
 * Only an explicit `false` turns an email off. A key missing from the payload
 * stays ON, so an email added to the list later is sent to everyone rather
 * than silently switched off for every connection saved before it existed.
 */
async function save(connectionId, input = {}) {
  const columns = KEYS.map(column);
  const values = KEYS.map((key) => (input[key] === false ? 0 : 1));

  await pool.query(
    `INSERT INTO notification_settings (connection_id, ${columns.join(", ")})
     VALUES (?, ${columns.map(() => "?").join(", ")})
     ON DUPLICATE KEY UPDATE
       ${columns.map((name) => `${name} = VALUES(${name})`).join(",\n       ")}`,
    [connectionId, ...values]
  );

  return forConnection(connectionId);
}

module.exports = { EMAILS, KEYS, defaults, forConnection, save };
