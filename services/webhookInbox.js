const inbox = require("../models/webhookInboxModel");
const { normalizeShopDomain } = require("../utils/shop");
let running = false;
let timer = null;

function receive(handler) {
  return async (req, res) => {
    const shop = normalizeShopDomain(req.webhookShop);
    if (!shop) return res.status(400).send("Invalid shop domain");
    try {
      await inbox.enqueue({
        handler, shop, payload: req.webhookPayload, topic: req.webhookTopic,
        deliveryId: req.get("X-Shopify-Webhook-Id") || req.get("Shopify-Webhook-Id") || req.get("Shopify-Event-Id"),
      });
      return res.status(200).send("OK");
    } catch (error) {
      console.error("Webhook could not be saved:", error.message);
      return res.status(503).send("Please retry delivery");
    }
  };
}

async function run({ limit = 25 } = {}) {
  if (running) return { skipped: true };
  running = true;
  const totals = { completed: 0, failed: 0 };
  try {
    const handlers = require("../controllers/webhookController");
    for (const row of await inbox.listPending(limit)) {
      if (!(await inbox.claim(row.id))) continue;
      try {
        if (typeof handlers[row.handler] !== "function") throw new Error("Unknown webhook handler");
        const res = { status() { return this; }, send() { return this; } };
        await handlers[row.handler]({
          webhookShop: row.shop_domain, webhookTopic: row.topic,
          webhookPayload: row.payload, webhookQueued: true,
        }, res);
        await inbox.complete(row.id);
        totals.completed++;
      } catch (error) {
        await inbox.retry(row.id, error, Number(row.attempts) + 1);
        totals.failed++;
      }
    }
  } finally { running = false; }
  return totals;
}

function start() {
  if (timer) return timer;
  const tick = () => run().catch((error) => console.error("Webhook inbox round failed:", error.message));
  timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return timer;
}

function stop() { if (timer) clearInterval(timer); timer = null; }
module.exports = { receive, run, start, stop };
