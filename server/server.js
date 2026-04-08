// server/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/authRoute");
const webhookRoutes = require("./routes/webhookRoute");

const app = express();

// Middleware
app.use(cors());
app.use("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());

// Routes
app.use("/api/auth", authRoutes);
app.use("/webhooks", webhookRoutes);

// Test route
app.get("/", (req, res) => {
  res.send("Shopify Backend Running 🚀");
});

// Start server
app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});