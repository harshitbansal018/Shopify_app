// middleware/verifyWebhook.js
const crypto = require("crypto");

/**
 * Verifies the Shopify webhook HMAC over the RAW request body.
 * Requires express.raw() to have populated req.body as a Buffer.
 */
function verifyWebhook(req, res, next) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  if (!hmacHeader) {
    console.warn("Webhook rejected: missing HMAC header");
    return res.status(401).send("Unauthorized");
  }

  if (!Buffer.isBuffer(req.body)) {
    console.error("Webhook rejected: raw body middleware is not mounted");
    return res.status(500).send("Server misconfiguration");
  }

  const digest = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(req.body)
    .digest("base64");

  const received = Buffer.from(hmacHeader, "utf8");
  const expected = Buffer.from(digest, "utf8");

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    console.warn("Webhook rejected: HMAC mismatch");
    return res.status(401).send("Unauthorized");
  }

  try {
    req.webhookPayload = req.body.length ? JSON.parse(req.body.toString("utf8")) : {};
  } catch {
    return res.status(400).send("Invalid JSON body");
  }

  req.webhookTopic = req.get("X-Shopify-Topic");
  req.webhookShop = req.get("X-Shopify-Shop-Domain");

  next();
}

module.exports = { verifyWebhook };
