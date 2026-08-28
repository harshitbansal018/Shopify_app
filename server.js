require("dotenv").config();

const express = require("express");
const path = require("path");

const { assertConnection } = require("./config/db");
const { runMigrations } = require("./config/migrate");
const { frameAncestors } = require("./middleware/security");
const { serializeForScript } = require("./utils/html");

const authRoutes = require("./routes/authRoute");
const storeRoutes = require("./routes/storeRoute");
const productRoutes = require("./routes/productRoute");
const dashboardRoutes = require("./routes/dashboardRoute");
const webhookRoutes = require("./routes/webhookRoute");

const REQUIRED_ENV = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "HOST",
  "TOKEN_ENCRYPTION_KEY",
];

const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missingEnv.length) {
  console.error(
    `Missing required environment variables: ${missingEnv.join(", ")}`
  );
  process.exit(1);
}

const app = express();

// Behind a tunnel/proxy, trust the forwarded protocol so req.protocol is https.
app.set("trust proxy", 1);

/* ---------------- WEBHOOKS ----------------
   Mounted before the JSON body parser: HMAC verification needs the raw body. */
app.use("/webhooks", webhookRoutes);

/* ---------------- PARSERS ---------------- */
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

/* ---------------- VIEW ENGINE ---------------- */
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// <%- json(value) %> embeds data in a <script> block without letting a stray
// </script> in the data break out of it.
app.locals.json = serializeForScript;

/* ---------------- SECURITY HEADERS ----------------
   Required for the app to render inside the Shopify admin iframe. */
app.use(frameAncestors);

/* ---------------- STATIC ---------------- */
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- ROUTES ----------------
   Add feature routes here, e.g.:
     app.use("/widgets", require("./routes/widgetRoute"));
   Mount them ABOVE dashboardRoutes, which owns "/". */
app.use("/api/auth", authRoutes);
app.use("/products", productRoutes);
app.use("/", storeRoutes);
app.use("/", dashboardRoutes);

/* ---------------- ERROR HANDLING ---------------- */
app.use((req, res) => {
  res.status(404).send("Not found");
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  const status = err.statusCode || 500;

  // Never leak an internal message or stack trace to a merchant's browser.
  const message = status < 500 ? err.message : "Something went wrong";

  console.error("Unhandled error:", err.stack || err.message);

  if (String(req.headers.accept || "").includes("text/html")) {
    return res.status(status).send(message);
  }

  return res.status(status).json({ error: message });
});

/* ---------------- START ---------------- */
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await assertConnection();
    await runMigrations();
  } catch (err) {
    console.error("Startup failed:", err.message);
    process.exit(1);
  }

  // Pushes queued changes to destinations that have already accepted them.
  // Started after the database is confirmed, so a failed boot does not leave a
  // timer running against a pool that never connected.
  require("./services/productSync").startAutoSync();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();
